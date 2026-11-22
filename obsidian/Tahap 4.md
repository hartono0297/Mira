---
tags: [mira, tahap, dokumen]
status: lokal-selesai
---

# Tahap 4: Dokumen dan edit file

## Tujuan

Layar Dokumen per proyek dengan status setiap file, edit di Word atau Excel dengan tanda "Sedang diedit", versi baru otomatis setelah disimpan, riwayat versi yang bisa dipulihkan, penanganan bentrok, dan file besar yang diunduh saat diklik. Kriteria selesai di rencana: file Excel yang diedit dan disimpan di satu laptop muncul sebagai versi baru di laptop rekan, dan versi lama bisa dipulihkan.

## Yang dibuat (bagian lokal)

- `blobs/`: penyimpanan isi file beralamat hash BLAKE3, dipakai juga oleh chat.
- `documents/`: jenis file, graf versi (kepala, bentrok, pulihkan, selesaikan bentrok), izin per aksi, pemantau simpan Office (`notify`), alur edit lewat salinan kerja, pemulihan saat start. Migrasi v4.
- Versi baru dibuat setiap kali isi file berubah dan sudah tenang 1,5 detik. "Sedang diedit" berakhir saat kunci `~$` Office hilang.
- Pulihkan dan selesaikan bentrok selalu membuat versi baru; riwayat tidak pernah ditulis ulang.
- Layar Dokumen di `src/screens/docs/`. Semua file masuk pustaka "Umum" karena dokumen belum dikaitkan ke proyek.
- Uji ujung ke ujung `npm run test:e2e:docs`.

## Status

Bagian lokal selesai dan sudah digabung. Sinkron dokumen antar laptop sedang dikerjakan di branch lain dan belum bekerja di branch ini (`NoSync`). Kriteria selesai rencana belum terpenuhi.

Office di PC uji belum berlisensi, jadi uji ujung ke ujung meniru pola simpan Word dan Excel. Bentrok belum bisa dibuat lewat aplikasi di satu laptop; diuji lewat tes unit. Menghapus dokumen belum ada.

## Rujukan

- Laporan: [docs/progress/tahap-4-lokal.md](../docs/progress/tahap-4-lokal.md)
- Rencana: [docs/plans/tahap-4-lokal.md](../docs/plans/tahap-4-lokal.md)

Sebelumnya: [[Tahap 3]]. Berikutnya: [[Tahap 5]]. Lihat juga [[Belum diuji]]. Kembali ke [[Beranda]].
