---
tags: [mira, indeks]
---

# Beranda

Mira adalah aplikasi desktop Windows untuk kerja tim di satu kantor berisi sekitar 10 sampai 30 orang: chat, board task per proyek, dokumen Word dan Excel dengan riwayat versi, dan tanda tangan PDF visual. Semua laptop tersambung langsung di jaringan kantor, tanpa server, relay, cloud, akun, atau login. Dari luar kantor, laptop memakai VPN kantor.

Stack: Tauri 2, React 19, TypeScript, Vite, dan inti Rust.

## Peta catatan

Gambaran teknis
- [[Arsitektur]]: lapisan aplikasi, migrasi SQLite, blob store, jaringan, log keanggotaan, kontrak sinkron fitur.
- [[Keamanan dan izin]]: kunci, record bertanda tangan, rantai kepercayaan, peran, pembatasan data.
- [[Transport sinkron fitur]]: cara record fitur dan file berpindah antar laptop.

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
| [[Tahap 4]] | Bagian lokal selesai. Sinkron sedang dikerjakan di branch lain. |
| [[Tahap 5]] | Bagian lokal selesai. Sinkron sedang dikerjakan di branch lain. |
| [[Tahap 6]] | Belum dikerjakan sebagai tahap |
| [[Tahap 7]] | Belum dikerjakan |

Pemeriksaan akhir pada kode gabungan di branch `integrasi-fitur`: 781 tes Rust dan 499 tes tampilan lulus, clippy bersih, dan uji tiga instance lewat jaringan sungguhan lulus 20/20. Semua di satu PC, lihat [[Belum diuji]].

## Sumber di repo

- [README](../README.md)
- PRD: [design/prd-mira.html](../design/prd-mira.html)
- Rencana pembangunan: [design/rencana-pembangunan.html](../design/rencana-pembangunan.html)
- Rencana per tahap: [docs/plans/](../docs/plans/)
- Laporan per tahap: [docs/progress/](../docs/progress/)
