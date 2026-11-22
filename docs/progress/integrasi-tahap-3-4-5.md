# Penggabungan Tahap 3, 4, dan 5 ke main

Tanggal: 22 November 2026. Disetujui user di chat ("Ya, gabungkan").

Bagian lokal Tahap 3 (board), Tahap 4 (dokumen) dan Tahap 5 (tanda tangan PDF) dikerjakan paralel di branch sendiri, lalu digabung ke `main` setelah Tahap 1 selesai. Penggabungan dilakukan di branch `integrasi-tahap-3-4-5`, diuji, lalu `main` dimajukan (fast-forward).

## Branch yang digabung

| Tahap | Branch | Laporan |
|---|---|---|
| 3 Board (lokal) | `claude/tahap-3-board-lokal-38babd` | `docs/progress/tahap-3-lokal.md` |
| 4 Dokumen (lokal) | `claude/tahap-4-dokumen-lokal-e47711` | `docs/progress/tahap-4-lokal.md` |
| 5 Tanda tangan PDF (lokal) | `claude/tahap-5-ttd-lokal-5fbb29` | `docs/progress/tahap-5-lokal.md` |

## Konflik dan cara penyelesaiannya

- `src-tauri/src/db/migrations.rs`: urutan final v1 fondasi, v2 log keanggotaan (Tahap 1), v3 board, v4 dokumen, v5 tanda tangan.
- `src-tauri/src/lib.rs`: semua modul, plugin (opener, notification, dialog), runtime board, dokumen dan tanda tangan, dan perintah dari keempat tahap digabung. Hook penutupan jaringan Tahap 1 tetap ada. 56 perintah, masing-masing terdaftar sekali.
- `src-tauri/src/error.rs`: gabungan varian error. `InvalidInput` ada di Tahap 3 dan 4 dengan kode yang sama, jadi disimpan satu.
- `Cargo.toml`, `package.json`, `Cargo.lock`, `package-lock.json`: gabungan dependensi, `proptest` disimpan satu, lockfile dibuat ulang.
- `src/screens/shell/Shell.tsx`: menu Tanda tangan dari Tahap 5 ditambahkan ke menu yang sudah ada.
- Tes `documents::schema` sebelumnya menganggap migrasi dokumen selalu paling akhir. Sekarang tes itu mengikuti urutan v3, v4, v5.
- `scripts/smoke-e2e.mjs` (Tahap 0) belum mengikuti alur onboarding Tahap 1, yaitu panduan firewall dan layar kode undangan. Uji ini juga gagal di `main` sebelum penggabungan. Skripnya sudah diperbarui.

Satu subagent reviewer memeriksa sambungan antar tahap (urutan `setup`, perintah, migrasi, API Tahap 1 yang dipakai branch lain, CSP, capability). Dua temuannya (tes migrasi dan `Cargo.lock`) sudah diperbaiki.

## Hasil uji setelah digabung

| Pemeriksaan | Hasil |
|---|---|
| `cargo test` | 527 lulus, 0 gagal, 7 diabaikan |
| `cargo clippy --all-targets` | tanpa peringatan |
| Vitest | 30 file, 378 tes lulus |
| `tsc --noEmit` | tanpa error |
| Uji ujung ke ujung alur dasar (`smoke-e2e.mjs`) | 11/11 |
| Uji ujung ke ujung board (`board-e2e.mjs`) | 10/10 |
| Uji ujung ke ujung dokumen (`smoke-docs-e2e.mjs`) | 15/15 |
| Uji ujung ke ujung tanda tangan (`sign-e2e.mjs`) | 15/15 |
| Uji empat instance (`e2e-multi.mjs`) | 25/25 |
| Installer NSIS | `Mira_0.1.0_x64-setup.exe`, 6,94 MB |

Semua uji ujung ke ujung dijalankan terhadap build release gabungan di satu PC.

## Yang belum

- Board, dokumen, dan tanda tangan masih lokal. Sinkronisasi ke rekan lewat jaringan Tahap 1 belum disambung. Titik sambungnya tercatat di laporan masing-masing tahap.
- Tahap 5 masih memakai penyimpanan PDF sementara (`DocumentStore`), belum blob store Tahap 4.
- Belum diuji di beberapa laptop sungguhan, lewat VPN, atau dengan Office berlisensi.
