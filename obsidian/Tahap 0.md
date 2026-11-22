---
tags: [mira, tahap]
status: selesai
---

# Tahap 0: Fondasi

## Tujuan

Proyek Tauri dengan React dan TypeScript, tema Bata terang dan gelap, kunci laptop, layar pertama kali buka, dan installer Windows. Kriteria selesai di rencana: installer bisa dipasang, aplikasi terbuka, nama tersimpan, dan mode terang serta gelap bekerja.

## Yang dibuat

- Proyek Tauri 2 + React 19 + TypeScript + Vite. Nama aplikasi "Mira", identifier `id.mira.desktop`.
- Token warna di `src/theme/tokens.ts` dari `design/tema-c.html`. Mode Terang, Gelap, dan Ikuti Windows, disimpan per laptop.
- Font Nunito dan ikon Tabler dibundel lokal.
- Layar pertama: isi nama, lalu buat organisasi baru (pembuatnya jadi Superadmin) atau gabung dengan kode.
- Kerangka utama dengan sidebar, serta Pengaturan "Tampilan" dan "Laptop ini".
- Inti Rust: modul `paths`, `db`, `identity`, `org`, `settings`, `commands`, `error`, `state`. Skema SQLite v1.
- Kunci Ed25519 di Windows Credential Manager. Record genesis organisasi ditandatangani pendiri.
- `MIRA_DATA_DIR` untuk menjalankan beberapa instance di satu PC.
- Installer NSIS per pengguna dengan teks bahasa Indonesia, plus varian offline.
- Uji ujung ke ujung `scripts/smoke-e2e.mjs` lewat DevTools Protocol.

## Status

Selesai. Installer terpasang, data tetap setelah restart, dan ketiga mode tema bekerja. Saat itu: 33 tes Rust, 29 tes Vitest, uji ujung ke ujung 11/11.

Keputusan dari tahap ini ada di [[Keputusan]].

## Rujukan

- Laporan: [docs/progress/tahap-0.md](../docs/progress/tahap-0.md)
- Rencana: [docs/plans/tahap-0.md](../docs/plans/tahap-0.md)

Berikutnya: [[Tahap 1]]. Kembali ke [[Beranda]].
