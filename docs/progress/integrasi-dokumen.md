# Penggabungan sinkron dokumen dan tanda tangan ke main

Tanggal: 23 November 2026. Ini bagian terakhir dari permintaan user: semua pekerjaan paralel digabung, lalu README dan vault diperbarui, push, dan rilis.

## Yang digabung

| Bagian | Branch | Laporan |
|---|---|---|
| Sinkron dokumen dan tanda tangan antar laptop | `claude/sinkron-dokumen-ttd-8e6530` | `docs/progress/sinkron-dokumen-ttd.md` |

Branch ini dibuat dari `main` 63eb72b, yaitu sebelum transport, chat, dan sinkron board digabung. Karena itu ada beberapa hal yang harus disambung ulang saat digabung.

## Konflik dan cara penyelesaiannya

- `src-tauri/src/lib.rs`: dipakai satu `FeatureHub` milik `main`. `signing::peer_sync::register`, `documents::commands::download_version`, dan `signing::commands::sign_download_file` ditambahkan. Total ada 75 perintah, masing-masing terdaftar sekali.
- **Jembatan uji dibuang.** Jembatan uji sementara di branch itu (`feature_bridge.rs`, `MIRA_TEST_BRIDGE_DIR`, dan empat perintah `debug_*`) dihapus, karena transport asli sudah ada.
- `src-tauri/src/db/migrations.rs`: `documents::sync_schema::SYNC_SCHEMA` menjadi v8. Urutan final:

  | Versi | Isi |
  |---|---|
  | v1 | fondasi |
  | v2 | log keanggotaan |
  | v3 | board |
  | v4 | dokumen |
  | v5 | tanda tangan |
  | v6 | sinkron board |
  | v7 | chat |
  | v8 | sinkron dokumen dan tanda tangan |

- `Cargo.toml`: `lopdf` ditambahkan untuk bukti stempel. `Cargo.lock` dirapikan setelah penggabungan otomatis.
- `scripts/sync-e2e.mjs` ditulis ulang. Sebelumnya skrip ini memakai jembatan uji; sekarang memakai tiga instance yang tersambung lewat transport asli.

## Perbaikan setelah review

Reviewer menemukan celah yang muncul karena bagian ini ditulis sebelum chat dan sinkron board ada. Semuanya diperbaiki di commit 470be63, dengan 8 tes baru:

1. **Lampiran chat bisa bocor.** Seseorang yang tahu sidik (hash) file lampiran chat bisa mengambil file itu lewat permintaan tanda tangan buatan atau lewat versi dokumen. Sekarang file milik chat hanya boleh dipakai ulang oleh orang yang ada di percakapan chat itu. Alur "kirim PDF lewat chat, lalu minta tanda tangan" tetap jalan.
2. **PDF asli dipakai ulang.** PDF asli yang dipakai ulang di permintaan lain sekarang hanya diterima kalau pengirimnya memang boleh memegang file itu. Aturan ini juga dicek saat file disajikan ke rekan.
3. **Aturan akses dokumen dan tanda tangan.** Dokumen dan tanda tangan sekarang memakai aturan akses proyek dan Tamu milik board (`BoardGuestProjects`), menggantikan aturan sementara. Dokumen proyek mengambil tim dari proyek board, dan proyek yang tidak dikenal ditolak.
4. **Superadmin.** Superadmin hanya bisa melihat dokumen tim kalau ia ada di tim itu (F-ROLE-11).
5. **Pratinjau tanda tangan.** CSP sekarang mengizinkan gambar `blob:`, sehingga pratinjau di dialog "Buat tanda tangan" tampil. Sebelumnya pratinjau itu diblokir.

## Hasil verifikasi akhir

Dijalankan terhadap commit 1608965 dan build release final, di satu PC.

| Pemeriksaan | Hasil |
|---|---|
| `cargo test` | 861 lulus, 0 gagal, 7 diabaikan |
| `cargo clippy --all-targets` | 0 peringatan |
| `tsc --noEmit` | bersih |
| Vitest | 37 file, 557 tes lulus |
| `smoke-e2e.mjs` | 11/11 |
| `board-e2e.mjs` | 11/11 |
| `board-sync-e2e.mjs` | 23/23 |
| `chat-e2e.mjs` | 19/19 |
| `smoke-docs-e2e.mjs` | 15/15 |
| `sign-e2e.mjs` | 15/15 |
| `e2e-multi.mjs` (4 instance, keanggotaan) | 25/25 |
| `e2e-fitur-multi.mjs` (3 instance, chat dan board) | 20/20 |
| `sync-e2e.mjs` (3 instance, dokumen dan tanda tangan) | 37/37 |
| Installer NSIS | `Mira_0.1.0_x64-setup.exe`, 7,86 MB |

## Yang belum

- Belum diuji di beberapa laptop sungguhan, lewat VPN, atau dengan Microsoft Office berlisensi.
- Layar Dokumen baru bisa menambah file ke Pustaka Umum, belum ke proyek atau tim tertentu. Sisi Rust sudah mendukung cakupan proyek.
- Installer belum ditandatangani sertifikat kode, jadi Windows SmartScreen bisa memberi peringatan saat instalasi.
- Log keanggotaan masih menerima undangan Tamu yang menyebut proyek tim lain. Board, chat, dokumen, dan tanda tangan mengabaikan izin seperti itu, tapi pemeriksaannya sebaiknya juga ditambahkan di log keanggotaan.
- Tahap 6 (fitur lengkap) dan Tahap 7 (uji coba kantor) belum dimulai.
