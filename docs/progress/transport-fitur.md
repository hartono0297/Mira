# Transport sinkron fitur

Tanggal: 22 November 2026. Branch `claude/transport-fitur-736723`, dari `main` 63eb72b. Rencana: `docs/plans/transport-fitur.md`.

## Ringkasnya

Kontrak `network/feature.rs` sekarang punya transport sungguhan di atas koneksi anggota Tahap 1. Fitur (chat, board, dokumen, tanda tangan) cukup mendaftarkan `FeatureSync` dan `BlobSource` ke `FeatureHub`. Jaringan yang mengurus kapan sinkron, pemecahan frame, pemeriksaan batch, unduh blob, dan event ke UI. `feature.rs` tidak diubah sama sekali.

## Yang dibuat

| File | Isi |
|---|---|
| `network/wire.rs` | Pesan baru `FeatureHave`, `FeatureWant`, `FeatureRecords`, `BlobGet`, `BlobHeader`, `BlobRefused`. Fungsi `batch_records` untuk memecah record di bawah batas frame. Decode dua langkah (tag dulu, lalu isi) supaya frame sampah tidak membengkak di memori. |
| `network/feature_net.rs` | Sesi sinkron per (peer, topik), jadwal, `feature_loop`, `NetLink` (implementasi `FeatureLink`). |
| `network/feature_blob.rs` | Layanan blob (server) dan `fetch_blob` (peminta). |
| `network/feature_tests.rs` | 13 tes integrasi QUIC loopback dengan fitur dan sumber blob mainan. |
| `network/node.rs` | Kait: hub dan link dipasang saat mulai, `OfflineLink` saat berhenti, `feature_peer_up` saat koneksi anggota naik, dispatch `FeatureHave` dan `BlobGet`, sinkron fitur saat `refresh` dan saat op keanggotaan baru, frame pertama stream dibatasi 1 MiB, reset stream saat sesi fitur habis waktu, batas sesi op sync per peer. |
| `network/mod.rs` | `Network::start_with_features(cfg, backend, events, hub)` dan `NetEvent::FeatureChanged { topic }`. `Network::start` tetap ada (memakai hub kosong). |
| `network/tls.rs` | Jendela flow control per stream diturunkan ke 512 KiB. |
| `net_backend.rs` | `AppNet::new(hub)`, event `mira://feature` dengan payload `{ "topic": "<topik>" }`. |
| `lib.rs` | `FeatureHub` dibuat dan di-manage sebelum jaringan dimulai, lalu diberikan ke `AppNet`. |

## Cara kerjanya

**Sesi sinkron.** Pihak yang menawarkan membuka satu stream per peer dan topik. Ia mengirim `FeatureHave` berisi paling banyak 8192 id, penerima membalas `FeatureWant` berisi id yang belum ia punya, lalu pengirim mengirim recordnya dalam `FeatureRecords` (paling banyak 512 record atau sekitar 1 MiB per frame). Penerima hanya menyimpan record yang memang ia minta, menjalankan `check_incoming`, mencatat record yang dibuang dengan `log_rejection` (kode `feature_records_dropped`, satu entri per sesi), lalu memanggil `ingest` di blocking pool. Kalau `changed: true`, UI menerima `mira://feature`.

**Kapan sinkron.**
- Koneksi anggota naik: `peer_connected` untuk setiap fitur, lalu semua topik ditawarkan penuh ke peer itu.
- `notify_changed`: digabung dengan jeda 250 ms, lalu hanya id baru yang ditawarkan ke semua peer.
- Gosip: record yang diterima dari satu peer diteruskan ke peer lain, hanya id dari batch itu.
- `refresh()` dan op keanggotaan baru: semua topik ditawarkan penuh (cakupan data bisa berubah).
- Cadangan berkala tiap 60 detik. Pasangan (peer, topik) yang daftar id-nya tidak berubah sejak sinkron penuh terakhir (di bawah 5 menit) dilewati.
- Sesi yang terputus, sibuk, atau habis waktu dicoba ulang paling banyak 3 kali dengan jeda 2 detik.

**Topik tak dikenal.** Penerima menghentikan stream itu saja. Koneksi tetap hidup dan topik lain tetap tersinkron.

**Unduh blob.** Setiap unduhan memakai stream sendiri: `BlobGet`, lalu `BlobHeader { size }` dan tepat `size` byte, atau `BlobRefused { code }`. Server menanyakan `FeatureHub::blob_path_for` untuk setiap permintaan dan mengulang pemeriksaan izin setiap 4 MiB. Peminta menulis ke file sementara `<nama>.part-<acak>` di folder `dest`, menolak kalau ukuran melebihi `max_size` atau hash BLAKE3 tidak cocok, dan baru memindahkan file ke `dest` kalau semuanya cocok. Peer di `prefer` dicoba dulu, lalu peer lain yang tersambung. Jawaban `busy` dicoba ulang setelah 1 sampai 2 detik.

## Keputusan yang diambil sendiri

- **Hub dibuat di `lib.rs` sebelum jaringan.** Sebelumnya hub di-manage setelah tugas jaringan dijalankan, sehingga jaringan bisa mulai tanpa hub. Sekarang hub dibuat lebih awal dan diberikan ke `AppNet::new`. Fitur tetap bisa memakai `app.state::<Arc<FeatureHub>>()` seperti biasa.
- **`NetEvent::FeatureChanged { topic: &'static str }`.** Topik diambil dari `FeatureSync::topic()` milik fitur lokal, bukan dari teks kiriman peer, jadi peer tidak bisa menyuntikkan nama topik ke UI.
- **`busy` dan `unavailable` sengaja tidak membedakan "tidak ada" dan "tidak boleh".** Batas sibuk dicek sebelum izin, jadi jawaban `busy` tidak membocorkan keberadaan blob.
- **Hapus `dest` saat gagal hanya kalau isinya tidak cocok dengan hash.** Kontrak berkata "on error `dest` is removed". File lama yang sudah benar tidak dihapus, karena itu bisa menghapus hasil unduhan sah dari pemanggilan lain. Kalau `dest` sudah berisi blob yang benar, `fetch_blob` langsung mengembalikan ukurannya tanpa jaringan.
- **`dest` wajib path absolut** dan foldernya harus sudah ada. Kegagalan lokal (disk penuh, file terkunci) tidak dicoba ulang ke peer lain.
- **Batas id diminta per sesi 30.000**, bukan 100.000 seperti di rencana. Id yang diminta tapi tidak dikirim dilupakan saat potongan berikutnya datang, jadi sesi yang wajar paling banyak menunggu 8192 id. Angka 30.000 hanya pengaman.
- **Tawaran delta.** Rencana awal selalu menawarkan semua id. Review keamanan menunjukkan biayanya: dengan 30 laptop dan 50.000 pesan, satu pesan baru memicu ratusan sesi berisi beberapa MB id. Perubahan lokal dan gosip sekarang hanya menawarkan id baru, sedangkan tawaran penuh tetap dipakai saat peer tersambung, saat keanggotaan berubah, saat coba ulang, dan sebagai cadangan berkala.
- **Tanpa migrasi database dan tanpa dependensi baru.** File memakai `std::fs` di blocking pool (fitur `fs` tokio tidak ditambahkan).

## Batas sumber daya

| Batas | Nilai |
|---|---|
| Id per `FeatureHave` / `FeatureWant` | 8192 (`MAX_IDS_PER_FRAME`) |
| Record per `FeatureRecords` | 512 (`MAX_RECORDS_PER_BATCH`), sekitar 1 MiB |
| Frame pertama stream anggota | 1 MiB |
| Frame `FeatureWant` dan `FeatureHave` berikutnya | 1 MiB |
| Frame `FeatureRecords` | `MAX_FRAME / 2` + 64 KiB |
| Frame `FeatureHave` per sesi penerima | 256 |
| Id diminta per sesi | 30.000 |
| Sesi penerima per peer | 4 (dihitung dari 8 stream per koneksi) |
| `ingest` bersamaan | 4 total, 1 per peer, tunggu paling lama 10 detik |
| Sesi pengirim per (peer, topik) | 1 berjalan + 1 lanjutan, jarak minimal 2 detik |
| Coba ulang sesi tak lengkap | 3 kali |
| Event `mira://feature` | paling sering 1 per 500 ms per topik |
| Id yang diingat untuk tawaran delta | 200.000 per topik |
| Sesi op sync penerima per peer | 2 |
| Jendela flow control per stream | 512 KiB (koneksi 4 MiB) |
| Layanan blob | 8 total, 2 per peer, 10 permintaan per detik per peer |
| Unduhan blob | 4 total, 2 per peer, antre paling lama 60 detik |
| Waktu transfer blob | 60 detik + ukuran / 256 KiB per detik, maksimal 30 menit |
| Kecepatan minimum blob | 1 MiB per 30 detik |
| Macet saat baca blob | 15 detik |
| Timeout frame | baca dan tulis 10 detik, fase record 20 detik, sesi 120 detik |

## Review

Empat putaran review oleh subagent terpisah:

1. Review keamanan rancangan sebelum implementasi selesai. Temuannya (memori pengirim saat `records_for`, satu sesi penerima per topik, cek ulang izin, transfer lambat, frame 4 MiB yang membengkak, banjir event) dimasukkan ke implementasi.
2. Review kode `feature_net.rs`: sesi sibuk yang hilang sampai tik berikutnya, batas 32 frame yang membuat topik besar tidak pernah tuntas, slot sesi tanpa penjaga. Semua diperbaiki.
3. Review kode `feature_blob.rs`: `busy` dianggap gagal permanen, kegagalan lokal dicoba ke semua peer, `dest` tidak dihapus di beberapa jalur error, kunci per `dest`. Semua diperbaiki.
4. Review keamanan akhir pada kode gabungan: tidak ada bug berat (tidak ada panic, overflow, atau kebocoran data ke anggota yang dikeluarkan). Risiko sisa yang diperbaiki: tawaran delta, decode dua langkah, jendela stream 512 KiB, batas frame per sesi, alamat log diambil di awal sesi, reset saat sesi habis waktu, kecepatan minimum blob.

## Hasil uji

Semua dijalankan di satu PC Windows pada commit gabungan terakhir.

| Pemeriksaan | Hasil |
|---|---|
| `cargo test` | 616 lulus, 0 gagal, 7 diabaikan (di `main` sebelumnya 534) |
| `cargo test --lib network`, diulang dua kali lagi saat build release berjalan | 136 lulus, 0 gagal, 1 diabaikan, kedua kali |
| Tes integrasi `network::feature_tests` | 13/13 lulus |
| `cargo clippy --all-targets` | tanpa peringatan |
| Vitest | 30 file, 378 tes lulus |
| Build release (`npx tauri build --no-bundle`) | berhasil |
| `npm run test:e2e-multi` (`scripts/e2e-multi.mjs` terhadap build release) | 25/25 lulus |

Tes integrasi tiga node yang dibuat (QUIC loopback, fitur mainan `toy`, sumber blob mainan):

1. Tiga laptop sampai ke gabungan record yang sama, event `FeatureChanged` muncul, `peer_connected` dipanggil untuk setiap rekan.
2. Record baru lewat `notify_changed` sampai ke rekan dalam kurang dari 10 detik.
3. Record yang disembunyikan dari satu rekan tidak pernah ditawarkan, dikirim, atau diterima rekan itu.
4. Record palsu (id tidak cocok) dan record terlalu besar dibuang penerima dan dicatat sebagai `feature_records_dropped`.
5. Record yang ditolak fitur tidak disimpan dan tidak menghentikan sinkron berikutnya.
6. Topik yang tidak dikenal penerima diabaikan, koneksi tetap sama, topik lain tetap tersinkron.
7. Blob berhasil diunduh, ukuran, isi, dan hash cocok.
8. Blob yang tidak diizinkan ditolak, `dest` tidak ada.
9. Blob dengan hash salah ditolak, tanpa `dest` dan tanpa file `.part-` tersisa.
10. Blob melebihi `max_size` ditolak; dengan batas yang cukup berhasil di koneksi yang sama.
11. Peer di `prefer` yang menolak diganti peer lain.
12. Peer yang dikeluarkan tidak menerima record maupun blob lagi.
13. Hub tanpa jaringan (sebelum mulai dan sesudah berhenti) tidak punya rekan dan unduhan gagal.

Catatan uji: Vitest sempat menunjukkan error "Timeout waiting for worker to respond" saat beberapa build cargo berjalan bersamaan. Dijalankan ulang saat mesin sepi, semua lulus tanpa error. Tidak ada kode frontend yang diubah.

## Catatan merge

- **Kontrak tidak berubah.** `feature.rs` sama persis dengan di `main`. Sesi chat, board, dan dokumen bisa digabung tanpa menyesuaikan kode mereka.
- **`lib.rs`:** blok `app.manage(Arc::new(FeatureHub::default()))` setelah `app.manage(state)` dihapus, diganti tiga baris sebelum `AppNet` (hub dibuat, di-manage, diberikan ke `AppNet::new`). Kalau sesi lain menambah `register` tepat di sekitar baris lama, ambil kedua sisi dan pastikan hub hanya di-manage sekali. Mendaftarkan fitur setelah jaringan berjalan tetap aman, karena hub dibaca setiap kali dipakai.
- **`net_backend.rs`:** `AppNet` punya field baru `features`; `AppNet::default()` tetap ada.
- **`NetEvent`** punya varian baru `FeatureChanged`. Pencocokan `match` yang lengkap di luar `network/` perlu ditambah (di `main` hanya `net_backend.rs`, sudah diubah).
- **Tanpa migrasi.** Tidak ada entri baru di `MIGRATIONS`.
- **Untuk fitur:** `dest` di `fetch_blob` harus path absolut. File `*.part-*` bisa tertinggal di folder `dest` kalau aplikasi mati di tengah unduhan; fitur pemilik folder bisa membersihkannya saat mulai.
- **Untuk UI:** dengarkan `mira://feature` dan baca `topic` dari payload.
- Sisa yang belum: uji di beberapa laptop sungguhan dan lewat VPN, dan fitur sungguhan yang memakai transport ini (dikerjakan sesi lain).
