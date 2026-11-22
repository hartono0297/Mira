---
tags: [mira, tahap, tanda-tangan]
status: lokal-selesai
---

# Tahap 5: Tanda tangan PDF

## Tujuan

Penampil PDF dengan komentar, stabilo, dan kotak teks, tanda tangan dengan PIN, permintaan tanda tangan berurutan, file dikunci setelah ditandatangani dengan halaman catatan, dan kartu task tanda tangan yang pindah ke Selesai otomatis. Kriteria selesai di rencana: kontrak ditandatangani berurutan oleh tiga orang, dan mengubah satu karakter di file hasilnya langsung memunculkan peringatan.

## Yang dibuat (bagian lokal)

- Tanda tangan digambar (mouse, pena, layar sentuh) atau diimpor dari foto, disimpan terenkripsi, dan hanya bisa dipakai dengan PIN 6 sampai 12 angka. Salah PIN berulang membuat kunci makin lama.
- Hapus tanda tangan tanpa PIN ("Lupa PIN?") memberi masa tunggu 24 jam sebelum tanda tangan baru bisa dipakai.
- Penampil PDF (pdf.js) yang bisa dipakai ulang di `src/components/pdf/`, dengan kotak penempatan yang bisa digeser dengan keyboard.
- Stempel ditulis dengan pdf-lib: gambar tanda tangan, nama, dan waktu. Penanda tangan terakhir menambahkan halaman catatan.
- Setiap versi di-hash BLAKE3 dan setiap kejadian dicatat di jejak audit bertanda tangan. "Periksa file PDF" memberi empat hasil: asli, versi tengah, berubah, atau tidak dikenal.
- Permintaan tanda tangan berurutan atau bebas. Tamu boleh menandatangani, tidak bisa meminta.
- Menu "Tanda tangan" di sidebar, layar di `src/screens/sign/`. Migrasi v5.

## Status

Bagian lokal selesai dan sudah digabung. Pengiriman permintaan dan file ke laptop rekan sedang dikerjakan di branch lain; di branch ini outbox masih `LocalOnlyOutbox` dan PDF masih disimpan di `FolderStore`, belum di blob store. Kriteria tiga penanda tangan belum terpenuhi karena butuh jaringan. Deteksi perubahan satu karakter sudah teruji di satu laptop.

Belum dibuat: komentar, stabilo, dan kotak teks di PDF, serta kartu task tanda tangan yang pindah otomatis. Inti Rust belum bisa membuktikan bahwa versi baru sama dengan versi sebelumnya ditambah stempel.

Kebijakan panjang PIN masih terbuka, lihat [[Keputusan]].

## Rujukan

- Laporan: [docs/progress/tahap-5-lokal.md](../docs/progress/tahap-5-lokal.md)
- Rencana: [docs/plans/tahap-5-lokal.md](../docs/plans/tahap-5-lokal.md)

Sebelumnya: [[Tahap 4]]. Berikutnya: [[Tahap 6]]. Kembali ke [[Beranda]].
