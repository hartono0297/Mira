# Penggabungan transport, chat, dan sinkron board ke main

Tanggal: 23 November 2026. Disetujui user di chat ("gabungkan lalu hapus kalau memang uda selesai").

Sebelum sesi paralel dimulai, kontrak bersama `src-tauri/src/network/feature.rs` ditambahkan ke `main` (commit 63eb72b), supaya transport, chat, dan sinkron board tidak mengedit file jaringan yang sama. Ketiganya lalu dikerjakan paralel dan digabung di branch `integrasi-fitur`, diuji, lalu `main` dimajukan.

## Branch yang digabung

| Bagian | Branch | Laporan |
|---|---|---|
| Transport sinkron fitur | `claude/transport-fitur-736723` | `docs/progress/transport-fitur.md` |
| Sinkron board | `claude/sinkron-board-e01670` | `docs/progress/sinkron-board.md` |
| Tahap 2 chat | `claude/tahap-2-chat-f36a9d` | `docs/progress/tahap-2.md` |

## Konflik dan cara penyelesaiannya

- `src-tauri/src/lib.rs`:
  - Transport membuat satu `FeatureHub` sebelum `AppNet::new`. Branch board menambahkan `manage(FeatureHub)` kedua; baris itu dibuang, dan hanya `board::feature::register` yang dipertahankan.
  - Runtime chat dan 16 perintah chat ditambahkan.
  - Total ada 73 perintah, masing-masing terdaftar sekali.
- `src-tauri/src/db/migrations.rs`: urutan final v1 fondasi, v2 log keanggotaan, v3 board, v4 dokumen, v5 tanda tangan, v6 sinkron board, v7 chat. Laporan chat dan sinkron board masing-masing menyebut migrasinya v6; yang benar adalah urutan di atas.
- `src-tauri/src/documents/schema.rs`: tes migrasi dokumen sebelumnya membuang tabel migrasi sesudahnya satu per satu dan rusak setiap ada migrasi baru. Sekarang tes itu memakai helper baru `db::open_at_version`, yang membuat database lama di v3 lalu membukanya dengan `db::open`.

## Perbaikan setelah review

Satu subagent reviewer memeriksa sambungan antar bagian. Temuan yang diperbaiki (commit 6a26660):

1. Chat masih memakai aturan sementara untuk anggota channel proyek. Akibatnya, Tamu dari undangan tim lain dan Tamu di proyek tanpa tim bisa masuk channel proyek, padahal board menolaknya. Sekarang chat memakai aturan akses board (`board::access`).
2. Superadmin di luar tim bisa mengelola channel proyek tim itu. Sekarang aturannya sama dengan board: hanya admin tim atau superadmin yang ada di tim.
3. Chat membuat channel untuk proyek yang tidak pernah disinkron board. Sekarang proyek seperti itu tidak punya channel.
4. Dua komentar kode yang sudah tidak sesuai diperbaiki.

Tiga tes baru membuktikan ketiga aturan pertama.

Dua skrip uji lama (`smoke-e2e.mjs`, `smoke-docs-e2e.mjs`) gagal karena chat menambah tombol "Pengaturan notifikasi chat", sehingga pencarian tombol "Pengaturan" menemukan dua tombol. Pencariannya sekarang persis.

## Hasil uji setelah digabung

| Pemeriksaan | Hasil |
|---|---|
| `cargo test` | 781 lulus, 0 gagal, 7 diabaikan |
| `cargo clippy --all-targets` | tanpa peringatan |
| Vitest | 36 file, 499 tes lulus |
| `tsc --noEmit` | tanpa error |
| Uji tiga instance chat dan board lewat transport sungguhan (`e2e-fitur-multi.mjs`, baru) | 20/20 |
| Uji empat instance keanggotaan (`e2e-multi.mjs`) | 25/25 |
| Uji alur dasar (`smoke-e2e.mjs`) | 11/11 |
| Uji board satu laptop (`board-e2e.mjs`) | 11/11 |
| Uji sinkron board (`board-sync-e2e.mjs`) | 23/23 |
| Uji chat satu laptop (`chat-e2e.mjs`) | 19/19 |
| Uji dokumen (`smoke-docs-e2e.mjs`) | 15/15 |
| Uji tanda tangan (`sign-e2e.mjs`) | 15/15 |

Semua uji ujung ke ujung dijalankan terhadap build release gabungan di satu PC.

Isi uji tiga instance yang baru:
- Pesan #umum sampai ke semua laptop.
- Pesan channel tim tidak pernah sampai ke tim lain.
- Chat pribadi berstatus Diterima laptopnya, lalu Dibaca.
- Titipan: B dimatikan, A mengirim, lalu A dimatikan sebelum B menyala. B tetap menerima pesan itu lewat C.
- Hapus pesan menjadi "Pesan dihapus" di laptop rekan.
- Lampiran tersalin utuh.
- Task board muncul di board dan "Task saya" rekan, pindah kolom terlihat di laptop lain, dan proyek tidak terlihat oleh tim lain.

## Yang belum

- Sinkron dokumen dan tanda tangan masih dikerjakan di branch `claude/sinkron-dokumen-ttd-8e6530`.
- Belum diuji di beberapa laptop sungguhan, lewat VPN, atau dengan Office berlisensi.
- Log keanggotaan masih menerima undangan Tamu yang menyebut proyek tim lain. Board dan chat mengabaikan izin seperti itu, jadi tidak ada data yang bocor, tapi pemeriksaannya sebaiknya juga ditambahkan di log keanggotaan.
