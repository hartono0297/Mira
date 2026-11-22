---
tags: [mira, tahap, chat]
status: selesai
---

# Tahap 2: Chat dasar

## Tujuan

Channel dan chat pribadi dengan balas dan mention, status pesan, titipan tersegel untuk rekan yang offline, kirim file kecil, dan notifikasi Windows. Kriteria selesai di rencana: pesan ke rekan yang laptopnya mati sampai lewat titipan begitu laptopnya menyala, walaupun laptop pengirim sudah dimatikan.

## Yang dibuat

- Inti chat di `chat/`: semua data chat adalah record bertanda tangan di topik `chat`. Channel #umum, channel tim, channel proyek, chat pribadi, pesan, hapus pesan, tanda terima, titipan, dan tanda serah titipan.
- Pembatasan per rekan: channel tim hanya ke anggota tim, channel proyek ke anggota proyek, chat pribadi hanya ke dua orangnya.
- Status pesan: Menunggu, Dititipkan, Diterima laptopnya, Dibaca.
- Titipan: record pesan disegel untuk kunci penerima (`crypto_box`), dipegang laptop lain, dan dihapus dari semua laptop setelah penerima menerbitkan tanda serah. Kedaluwarsa setelah 30 hari.
- Lampiran di blob store. Sampai sekitar 20 MB diunduh otomatis oleh anggota percakapan, lebih besar diunduh saat diklik.
- File yang bisa menjalankan program hanya bisa disimpan, tidak dibuka. File yang dibuka diberi Mark of the Web.
- Notifikasi Windows, diatur per orang dan per percakapan.
- Layar Chat di `src/screens/chat/`. Migrasi SQLite (v7 di urutan final).

## Status

Selesai dan sudah digabung di branch `integrasi-fitur`. Saat laporan ditulis, perpindahan antar laptop dibuktikan dengan tes in-memory tiga laptop, termasuk titipan yang diteruskan laptop ketiga setelah pengirim dimatikan.

Setelah [[Transport sinkron fitur]] digabung, uji tiga instance lewat jaringan sungguhan di satu PC (`npm run test:e2e-fitur-multi`) mencakup #umum, channel tim yang tidak sampai ke tim lain, chat pribadi dengan status Dibaca, titipan saat pengirim mati, hapus pesan, dan lampiran.

Yang tercatat masih terbatas, antara lain: hak dinilai menurut peran sekarang (bukan saat pesan dibuat), tanda terima terus bertambah, belum ada kuota titipan, dan notifikasi belum dikelompokkan.

## Rujukan

- Laporan: [docs/progress/tahap-2.md](../docs/progress/tahap-2.md)
- Rencana: [docs/plans/tahap-2.md](../docs/plans/tahap-2.md)

Sebelumnya: [[Tahap 1]]. Berikutnya: [[Tahap 3]]. Kembali ke [[Beranda]].
