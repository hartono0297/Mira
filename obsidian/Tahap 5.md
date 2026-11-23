---
tags: [mira, tahap, tanda-tangan]
status: sebagian
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

## Yang dibuat (sinkron antar laptop)

- `signing/peer_sync.rs`: record `request`, `signed`, dan `cancelled`. Penerima memeriksa setiap catatan audit, pengirim, penanda tangan, dan aturan Tamu. Keadaan permintaan dihitung ulang dari semua record sah, jadi hasilnya sama di semua laptop yang memegang record yang sama. Migrasi v8.
- Urutan berurutan ditegakkan di semua laptop. Penanda tangan mendapat notifikasi Windows "Giliran Anda menandatangani".
- PDF disimpan di blob store [[Tahap 4]]. File sampai 20 MB diunduh otomatis; file lebih besar lewat tombol unduh.
- Bukti stempel (`signing/increment.rs`): stempel ditambahkan sebagai incremental update PDF, jadi byte versi lama tetap utuh di dalam file baru. Inti Rust menolak versi yang mengubah isi selain stempel, dengan kode `version_changes_content`.
- Permintaan bisa dikaitkan ke proyek. Aturan proyek dan Tamu sama dengan aturan board, lihat [[Keamanan dan izin]].

## Status

Tanda tangan dan sinkron antar laptop selesai dan sudah digabung, di atas transport fitur yang asli. Uji `npm run test:e2e-sync` dengan tiga instance di satu PC memeriksa permintaan berurutan B lalu A, versi yang diubah diam-diam ditolak, jejak audit sah di kedua laptop, dan anggota yang tidak terlibat tidak menerima permintaan. Kriteria tiga penanda tangan di rencana diuji lewat tes Rust tiga laptop; uji ujung ke ujung memakai dua penanda tangan.

Belum dibuat: komentar, stabilo, dan kotak teks di PDF, serta kartu task tanda tangan yang pindah otomatis. Belum dicoba dengan PDF dari Word, Acrobat, atau pemindai.

Kebijakan panjang PIN masih terbuka, lihat [[Keputusan]].

## Rujukan

- Laporan: [docs/progress/tahap-5-lokal.md](../docs/progress/tahap-5-lokal.md), [docs/progress/sinkron-dokumen-ttd.md](../docs/progress/sinkron-dokumen-ttd.md)
- Rencana: [docs/plans/tahap-5-lokal.md](../docs/plans/tahap-5-lokal.md), [docs/plans/sinkron-dokumen-ttd.md](../docs/plans/sinkron-dokumen-ttd.md)

Sebelumnya: [[Tahap 4]]. Berikutnya: [[Tahap 6]]. Kembali ke [[Beranda]].
