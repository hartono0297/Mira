---
tags: [mira, tahap, board]
status: selesai
---

# Tahap 3: Board dasar

## Tujuan

Board per proyek dengan kolom To do, Dikerjakan, Selesai, kode task, task lengkap, edit bersamaan saat offline yang digabung otomatis, "Task saya", dan pengingat tenggat. Kriteria selesai di rencana: dua orang mengubah task yang sama saat salah satunya offline, dan setelah tersambung keduanya melihat hasil gabungan yang sama tanpa data hilang.

## Yang dibuat

Bagian lokal:
- Inti `board/`: dokumen Automerge per proyek, change ditandatangani kunci laptop, snapshot dan indeks task dalam satu transaksi SQLite. Migrasi v3.
- Judul dan deskripsi sebagai teks Automerge, urutan kartu memakai rank pecahan, hapus task berupa tanda "terhapus".
- Pengingat tenggat lewat notifikasi Windows: sehari sebelum dan di hari tenggat, diatur per laptop.
- Layar board, dialog detail task, dan halaman "Task saya". Task dipindah dengan seret mouse, menu Pindahkan, atau Alt+Panah.

Sinkron board:
- Setiap change dikirim sebagai satu record di topik `board`. Penerima menilai setiap operasi di dalam change (`rules.rs`), jadi hasilnya sama apa pun urutan datangnya.
- Aturan akses per proyek di `access.rs`. Tamu diundang per proyek dan hanya bisa membaca.
- Id proyek, task, dan komentar diikat ke pembuatnya, supaya tidak bisa dibajak.
- Change dari orang yang sudah kehilangan hak diterima kalau dibuat sebelum haknya dicabut dan didukung rekan yang masih berhak.
- Nomor task ganda diberi nomor baru lewat change bertanda tangan. Kode proyek ganda tampil sebagai PA2, PA3 di laptop yang memegang keduanya.
- Change yang belum bisa dinilai ditahan di `board_pending`, yang rusak ditolak permanen. Migrasi v6.
- Tampilan memuat ulang saat ada change dari rekan tanpa menimpa ketikan yang belum disimpan.

## Status

Selesai, termasuk sinkron antar laptop dan Tamu per proyek, dan sudah digabung di branch `integrasi-fitur`. Konvergensi tiga laptop diuji dengan proptest. Uji tiga instance lewat jaringan sungguhan di satu PC mencakup proyek dan task yang sampai ke anggota tim, tim lain yang tidak melihat proyek itu, dan pindah kolom yang terlihat di laptop lain.

Belum ada: tanda "sudah digabung" di kartu (nilainya selalu `false`), task dari pesan chat, dan layar admin untuk change yang ditolak. Proyek yang dibuat sebelum id terikat tidak disinkronkan.

## Rujukan

- Laporan bagian lokal: [docs/progress/tahap-3-lokal.md](../docs/progress/tahap-3-lokal.md)
- Laporan sinkron board: [docs/progress/sinkron-board.md](../docs/progress/sinkron-board.md)
- Rencana: [docs/plans/tahap-3-lokal.md](../docs/plans/tahap-3-lokal.md), [docs/plans/sinkron-board.md](../docs/plans/sinkron-board.md)
- Penggabungan: [docs/progress/integrasi-tahap-3-4-5.md](../docs/progress/integrasi-tahap-3-4-5.md)

Sebelumnya: [[Tahap 2]]. Berikutnya: [[Tahap 4]]. Kembali ke [[Beranda]].
