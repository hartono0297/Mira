# Rencana: transport sinkron fitur

Tanggal: 22 November 2026. Branch `claude/transport-fitur-736723`, dari `main` 63eb72b.

## Tujuan

Kontrak `src-tauri/src/network/feature.rs` (FeatureSync, BlobSource, FeatureHub) mendapat transport sungguhan di atas koneksi anggota Tahap 1. Fitur (chat, board, dokumen, tanda tangan) cukup mendaftar ke `FeatureHub`; jaringan mengurus kapan sinkron, pemecahan frame, pemeriksaan batch, unduh blob, dan event ke UI.

## Arsitektur

File baru di `src-tauri/src/network/`:

| File | Isi | Pemilik |
|---|---|---|
| `wire.rs` (tambahan) | `Msg::FeatureHave/FeatureWant/FeatureRecords/BlobGet/BlobHeader/BlobRefused`, `wire::batch_records` | kerangka (selesai) |
| `node.rs` (tambahan) | kait: `Inner.features`, `Inner.blobs`, `set_link` saat mulai, `OfflineLink` saat berhenti, `feature_peer_up` di `establish`, dispatch `FeatureHave`/`BlobGet` di `handle_stream`, `feature_sync_all` di `refresh` dan `on_new_ops`, helper `peer_conn` dan `is_member` | kerangka (selesai) |
| `mod.rs` (tambahan) | `Network::start_with_features`, `NetEvent::FeatureChanged { topic }` | kerangka (selesai) |
| `feature_net.rs` | sesi sinkron, jadwal (gabung jeda, berkala), `NetLink` | tugas A |
| `feature_blob.rs` | layanan dan unduhan blob | tugas B |
| `feature_tests.rs` | tes integrasi tiga node | tugas C |

Di luar `network/`: `net_backend.rs` (`AppNet::new(hub)`, event `mira://feature` dengan `{ "topic": ... }`) dan `lib.rs` (hub dibuat dan di-manage sebelum jaringan dimulai). Tanpa migrasi database. `feature.rs` tidak diubah.

Tanda tangan yang sudah tetap (jangan diubah oleh tugas A, B, C):

```rust
// feature_net.rs
pub(crate) struct FeatureNet { pub(crate) hub: Arc<FeatureHub>, /* bebas */ }
impl FeatureNet { pub(crate) fn new(hub: Arc<FeatureHub>) -> Self }
pub(crate) struct NetLink;  // impl FeatureLink, sudah jadi
impl Inner {
    pub(crate) fn feature_notify(self: &Arc<Self>, topic: &str);
    pub(crate) fn feature_peer_up(self: &Arc<Self>, pk: &str);
    pub(crate) fn feature_sync_all(self: &Arc<Self>, except: Option<&str>);
    pub(crate) async fn respond_feature(self: &Arc<Self>, pk: &str, topic: String,
        first_ids: Vec<String>, send: &mut SendStream, recv: &mut RecvStream);
}
pub(crate) async fn feature_loop(weak: Weak<Inner>);

// feature_blob.rs
pub(crate) struct BlobState { /* bebas */ }
impl BlobState { pub(crate) fn new() -> Self }
impl Inner {
    pub(crate) async fn serve_blob(self: &Arc<Self>, pk: &str, hash: String,
        send: &mut SendStream, recv: &mut RecvStream);
    pub(crate) async fn fetch_blob(self: Arc<Self>, hash: String, max_size: u64,
        prefer: Vec<String>, dest: PathBuf) -> Result<u64, String>;  // future harus Send
}
```

## Protokol sesi fitur

Satu stream dua arah per (peer, topik), dibuka oleh pihak yang menawarkan (pola `sync_once`/`respond_sync` Tahap 1):

1. Pemrakarsa: periksa `is_member(peer)`, ambil `record_ids_for(peer)` di blocking pool. Kosong: selesai tanpa membuka stream.
2. Untuk setiap potongan `MAX_IDS_PER_FRAME` id: kirim `FeatureHave { topic, ids }`, baca `FeatureWant { topic, ids }`. Want disaring ke id yang ditawarkan di potongan itu, diurutkan, tanpa duplikat. Lalu `records_for(peer, want)` di blocking pool, disaring lagi ke want (record ganda dibuang), dikirim sebagai `FeatureRecords` lewat `wire::batch_records(records, MAX_RECORDS_PER_BATCH, 1 MiB)`.
3. Pemrakarsa menutup sisi kirim, lalu menunggu responder selesai (baca sampai `None` dengan `READ_TIMEOUT`).
4. Responder: frame pertama sudah dibaca di `handle_stream`. Topik tidak dikenal (`hub.feature(topic)` kosong) atau bukan `is_topic`: `recv.stop`, selesai. Koneksi tidak diputus. Pemrakarsa yang mendapat stream berhenti atau `None` mengakhiri sesi tanpa error yang dicatat.
5. Responder untuk setiap `FeatureHave`: lebih dari `MAX_IDS_PER_FRAME` id atau topik beda: akhiri sesi. Id yang bukan `is_hex64` dibuang. `unknown_ids` di blocking pool, disaring ke yang ditawarkan dan belum diminta. Total yang diminta per sesi maksimal 100.000 (lebih: akhiri sesi). Balas `FeatureWant`.
6. Responder untuk setiap `FeatureRecords`: topik beda: akhiri. Simpan hanya record yang id-nya ada di daftar diminta (dihapus dari daftar saat diterima). Lalu `check_incoming`; jumlah yang dibuang di kedua langkah dicatat dengan `Inner::log_rejection(Some(pk), Some(remote), "feature_records_dropped", ...)`. Sisa record masuk `ingest` di blocking pool dengan semafor global (4 sekaligus). `changed: true`: `emit(NetEvent::FeatureChanged { topic: feature.topic() })`. `accepted > 0`: jadwalkan topik itu ke semua peer lain (gosip, kecuali pengirim). Error dari `ingest`: akhiri sesi.
7. Pesan lain: akhiri sesi.

## Kapan sinkron

- Koneksi anggota naik (`feature_peer_up`): `peer_connected(pk)` untuk setiap fitur di blocking pool, lalu jadwalkan semua topik ke peer itu.
- `notify_changed(topic)`: topik dimasukkan ke himpunan tertunda (hanya topik `is_topic` yang terdaftar), `feature_loop` menunggu 250 ms setelah panggilan pertama, lalu menjadwalkan topik-topik itu ke semua peer tersambung.
- Berkala tiap 60 detik: semua topik ke semua peer (cadangan).
- `refresh()` dan op keanggotaan baru: semua topik ke semua peer (cakupan data bisa berubah).
- Penjadwalan per (peer, topik): satu sesi berjalan; permintaan selama sesi berjalan digabung menjadi satu sesi lanjutan (pola `schedule_sync`). Setiap sesi dibatasi `SYNC_SESSION_TIMEOUT` (120 detik).

## Unduh blob

- Server (`serve_blob`): hash bukan `is_hex64`: `BlobRefused { code: "unavailable" }`. Semafor global 8 layanan dan maksimal 2 per peer; penuh: `BlobRefused { code: "busy" }`. `is_member(pk)` dan `hub.blob_path_for(pk, hash)` di blocking pool untuk setiap permintaan; `None`: `unavailable` (sengaja sama dengan tidak ada). Buka file, `BlobHeader { size }`, lalu tepat `size` byte, potongan 64 KiB, setiap tulis dibatasi `WRITE_TIMEOUT`, seluruh transfer maksimal 30 menit. File berubah ukuran di tengah jalan: reset stream.
- Peminta (`fetch_blob`): hash bukan `is_hex64`: error. Semafor global 4 unduhan sekaligus (menunggu giliran maksimal 60 detik). Kandidat: `prefer` yang tersambung, lalu peer tersambung lain, tanpa duplikat dan tanpa diri sendiri. Untuk setiap kandidat: `open_bi` dengan `READ_TIMEOUT`, `BlobGet`, baca header (frame maksimal 1 KiB, `READ_TIMEOUT`). `BlobRefused` atau `size > max_size`: kandidat berikutnya. Byte mentah ditulis ke file sementara `<dest>.part-<acak>` di folder yang sama lewat penulis di blocking pool (kanal berbatas), hash BLAKE3 dihitung sambil jalan, setiap baca dibatasi 15 detik, seluruh transfer 30 menit. Byte kurang dari `size`, hash beda, atau error: hapus file sementara, kandidat berikutnya. Berhasil: ganti nama ke `dest`, kembalikan `size`. Semua kandidat gagal: hapus `dest` kalau ada, error berbahasa Indonesia dengan alasan terakhir.
- Tanpa dependensi baru dan tanpa fitur tokio `fs`: berkas lewat `std::fs` di `spawn_blocking`. Angka acak dari `rand_core::OsRng`.

## Batas sumber daya

| Batas | Nilai | Alasan |
|---|---|---|
| Id per `FeatureHave`/`FeatureWant` | 8192 (`MAX_IDS_PER_FRAME`) | kontrak; sekitar 550 KB JSON |
| Record per `FeatureRecords` | 512 (`MAX_RECORDS_PER_BATCH`) | kontrak |
| Byte per `FeatureRecords` | sekitar 1 MiB, maksimal `MAX_FRAME` | sama dengan `SyncOps` |
| Id diminta per sesi | 100.000 | memori responder terbatas |
| `ingest` bersamaan (global) | 4 | CPU dan kunci database |
| Sesi per (peer, topik) | 1 + 1 lanjutan | pola Tahap 1 |
| Stream per koneksi | 8 (`MAX_BIDI_STREAMS`) | sudah ada |
| Layanan blob | 8 global, 2 per peer | satu peer tidak menghabiskan disk I/O |
| Unduhan blob | 4 bersamaan | |
| Timeout | baca/tulis frame 10 detik, sesi 120 detik, baca blob 15 detik, transfer blob 30 menit | pola Tahap 1 |

## Tugas (TDD)

- **A, `feature_net.rs`**: implementasi sesi, jadwal, dan `feature_loop` sesuai bagian di atas, dengan tes unit untuk logika murni (misalnya himpunan tertunda, penyaringan want).
- **B, `feature_blob.rs`**: implementasi layanan dan unduhan blob, dengan tes unit untuk penulis file sementara dan pemeriksaan hash.
- **C, `feature_tests.rs`**: tes integrasi QUIC loopback tiga node dengan fitur mainan dan sumber blob mainan: konvergensi tiga arah, cakupan per peer, record palsu dibuang dan dicatat, topik tak dikenal diabaikan tanpa memutus koneksi, event `FeatureChanged`, blob berhasil, blob ditolak, hash salah ditolak dan `dest` tidak ada, melebihi `max_size` ditolak, `prefer` yang menolak diganti peer lain, peer yang dikeluarkan tidak menerima record atau blob lagi.
- **D, review keamanan jaringan** setelah A, B, C digabung, oleh subagent terpisah.
- **E, verifikasi**: `cargo test`, `cargo clippy --all-targets`, Vitest, build release, `npm run test:e2e-multi` 25/25, laporan `docs/progress/transport-fitur.md`.

A, B, dan C dikerjakan paralel di worktree terpisah dari commit kerangka, lalu digabung ke branch ini (file tidak tumpang tindih).

## Aturan kerja

- Jangan menjalankan `cargo fmt` untuk seluruh crate (mengubah file lain). Pakai `rustfmt --edition 2024 <file>` hanya untuk file sendiri. Akhir baris LF (kecuali `lib.rs` yang CRLF).
- Jangan mengubah `feature.rs` maupun tanda tangan kerangka di atas.

## Perubahan setelah review

Implementasi akhir menyimpang dari rencana di beberapa angka dan menambah tawaran delta (hanya id baru untuk perubahan lokal dan gosip), batas 30.000 id diminta per sesi, decode frame dua langkah, jendela stream 512 KiB, dan batas sesi op sync per peer. Rinciannya di `docs/progress/transport-fitur.md`.
