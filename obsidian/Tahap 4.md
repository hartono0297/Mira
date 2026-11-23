---
tags: [mira, tahap, dokumen]
status: selesai
---

# Tahap 4: Dokumen dan edit file

## Tujuan

Layar Dokumen per proyek dengan status setiap file, edit di Word atau Excel dengan tanda "Sedang diedit", versi baru otomatis setelah disimpan, riwayat versi yang bisa dipulihkan, penanganan bentrok, dan file besar yang diunduh saat diklik. Kriteria selesai di rencana: file Excel yang diedit dan disimpan di satu laptop muncul sebagai versi baru di laptop rekan, dan versi lama bisa dipulihkan.

## Yang dibuat (bagian lokal)

- `blobs/`: penyimpanan isi file beralamat hash BLAKE3, dipakai juga oleh chat.
- `documents/`: jenis file, graf versi (kepala, bentrok, pulihkan, selesaikan bentrok), izin per aksi, pemantau simpan Office (`notify`), alur edit lewat salinan kerja, pemulihan saat start. Migrasi v4.
- Versi baru dibuat setiap kali isi file berubah dan sudah tenang 1,5 detik. "Sedang diedit" berakhir saat kunci `~$` Office hilang.
- Pulihkan dan selesaikan bentrok selalu membuat versi baru; riwayat tidak pernah ditulis ulang.
- Layar Dokumen di `src/screens/docs/`. File yang ditambah dari layar ini masuk Pustaka Umum.
- Uji ujung ke ujung `npm run test:e2e:docs`.

## Yang dibuat (sinkron antar laptop)

- `documents/peer_sync.rs`: record `doc`, `ver`, dan `edit`, masing-masing ditandatangani penulisnya. Penerima memeriksa tanda tangan, keanggotaan aktif, dan hak menulis di cakupan dokumen. Migrasi v8.
- Dokumen baru, versi baru, dan tanda "Sedang diedit" sampai ke laptop rekan yang berhak. File sampai 20 MB disalin otomatis; file lebih besar diunduh lewat tombol "Unduh dari rekan".
- Kalau dua laptop menyimpan versi saat offline, kedua versi disimpan dan tampil sebagai bentrok di kedua laptop, dengan nama pembuat tiap versi.
- `documents/scope.rs`: siapa boleh melihat Pustaka Umum, tim, atau proyek. Aturan proyek dan Tamu sama dengan aturan board, lihat [[Keamanan dan izin]].
- Berjalan di atas transport fitur yang asli ([[Transport sinkron fitur]]). Jembatan khusus uji sudah dihapus.

## Status

Selesai, termasuk sinkron antar laptop, dan sudah digabung. Uji `npm run test:e2e-sync` dengan tiga instance di satu PC memeriksa dokumen yang sampai ke laptop rekan dengan isi yang sama persis sampai ke byte, versi baru, tanda "Sedang diedit", bentrok offline di kedua laptop, dan file 21 MB yang diunduh saat diklik.

Layar Dokumen baru bisa menambah file ke Pustaka Umum, belum ke proyek atau tim tertentu, walaupun inti Rust sudah mendukung cakupan proyek. Office di PC uji belum berlisensi, jadi uji ujung ke ujung meniru pola simpan Word dan Excel. Belum diuji di beberapa laptop sungguhan. Menghapus dokumen belum ada.

## Rujukan

- Laporan: [docs/progress/tahap-4-lokal.md](../docs/progress/tahap-4-lokal.md), [docs/progress/sinkron-dokumen-ttd.md](../docs/progress/sinkron-dokumen-ttd.md)
- Rencana: [docs/plans/tahap-4-lokal.md](../docs/plans/tahap-4-lokal.md), [docs/plans/sinkron-dokumen-ttd.md](../docs/plans/sinkron-dokumen-ttd.md)

Sebelumnya: [[Tahap 3]]. Berikutnya: [[Tahap 5]]. Lihat juga [[Belum diuji]]. Kembali ke [[Beranda]].
