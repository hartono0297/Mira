---
tags: [mira, indeks]
---

# Beranda

Mira adalah aplikasi desktop untuk kerja tim di satu kantor berisi sekitar 10 sampai 30 orang: chat, board task per proyek, dokumen Word dan Excel dengan riwayat versi, dan tanda tangan PDF visual. Semua laptop tersambung langsung di jaringan kantor, tanpa server, relay, cloud, akun, atau login. Dari luar kantor, laptop memakai VPN kantor.

Platform: Windows 10/11 64-bit dan macOS 11 atau yang lebih baru (Apple Silicon dan Intel). Kantor memakai MacBook dan laptop Windows. Hal yang khusus Mac ada di [[macOS]].

Stack: Tauri 2, React 19, TypeScript, Vite, dan inti Rust.

## Peta catatan

Gambaran teknis
- [[Arsitektur]]: lapisan aplikasi, migrasi SQLite, blob store, jaringan, log keanggotaan, kontrak sinkron fitur.
- [[Keamanan dan izin]]: kunci, record bertanda tangan, rantai kepercayaan, peran, pembatasan data.
- [[Transport sinkron fitur]]: cara record fitur dan file berpindah antar laptop, untuk chat, board, dokumen, dan tanda tangan.

Tahapan
- [[Tahap 0]]: fondasi
- [[Tahap 1]]: jaringan dan tim
- [[Tahap 2]]: chat dasar
- [[Tahap 3]]: board dasar dan sinkron board
- [[Tahap 4]]: dokumen dan edit file
- [[Tahap 5]]: tanda tangan PDF
- [[Tahap 6]]: fitur lengkap
- [[Tahap 7]]: uji coba kantor

Kerja sehari-hari
- [[Rilis]]: v0.5.0 (bergabung lewat Active Directory, satu domain satu kantor), v0.4.0 (bahasa Inggris, subtask, pelacakan waktu, menu klik kanan), v0.3.0 (departemen, bergabung dengan persetujuan, pembaruan dari dalam aplikasi), v0.2.0 (macOS), v0.1.0 (build internal pertama, Windows)
- [[macOS]]: yang berbeda di Mac, build lewat GitHub Actions, cara memasang, yang belum diuji
- [[Cara menjalankan dan menguji]]
- [[Belum diuji]]
- [[Keputusan]]: keputusan desain dan yang masih terbuka

## Status singkat

| Tahap | Status |
|---|---|
| [[Tahap 0]] | Selesai |
| [[Tahap 1]] | Selesai |
| [[Tahap 2]] | Selesai |
| [[Tahap 3]] | Selesai, termasuk sinkron antar laptop dan Tamu per proyek |
| [[Tahap 4]] | Selesai, termasuk sinkron antar laptop. Layar Dokumen baru bisa menambah file ke Pustaka Umum. |
| [[Tahap 5]] | Tanda tangan dan sinkron antar laptop selesai. Komentar, stabilo, dan kotak teks di PDF belum dibuat. |
| [[Tahap 6]] | Belum dimulai |
| [[Tahap 7]] | Belum dimulai |

Pemeriksaan akhir pada kode gabungan (branch `integrasi-dokumen`): `cargo test` 861 lulus, 0 gagal, 7 diabaikan; clippy tanpa peringatan; tsc bersih; Vitest 557 tes di 37 file lulus. Semua uji ujung ke ujung pada build release lulus, termasuk chat dan board tiga instance (20/20) serta dokumen dan tanda tangan tiga instance (37/37). Semua di satu PC, lihat [[Belum diuji]]. Rincian per skrip ada di [[Cara menjalankan dan menguji]].

Rilis terbaru, `v0.5.0`, berisi installer Windows dan macOS serta pembaruan dari dalam aplikasi. Rilis pertama, `v0.1.0`, hanya untuk Windows. Lihat [[Rilis]]. macOS baru diuji lewat tes otomatis di GitHub Actions, belum di MacBook sungguhan; lihat [[macOS]].

## Sumber di repo

- [README](../README.md)
- PRD: [design/prd-mira.html](../design/prd-mira.html)
- Rencana pembangunan: [design/rencana-pembangunan.html](../design/rencana-pembangunan.html)
- Rencana per tahap: [docs/plans/](../docs/plans/)
- Laporan per tahap: [docs/progress/](../docs/progress/)
