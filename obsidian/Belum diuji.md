---
tags: [mira, uji, risiko]
---

# Belum diuji

Semua uji sejauh ini berjalan di satu PC Windows. Daftar ini mengumpulkan yang belum teruji dan yang belum dibuat, dari laporan setiap tahap.

## Lingkungan yang belum dicoba

- Beberapa laptop sungguhan: lalu lintas antar laptop dan firewall di jaringan kantor belum teruji. Rencana meminta minimal tiga laptop di kantor. ([[Tahap 1]])
- VPN: belum ada sambungan lewat VPN kantor. Deteksi VPN memakai nama adaptor Windows, jadi adaptor seperti Cisco AnyConnect atau Fortinet bisa tampil sebagai LAN. ([[Tahap 1]])
- Microsoft Office berlisensi: Office di PC uji belum berlisensi dan menahan otomatisasi dengan dialog product key. Uji dokumen meniru pola simpan Word dan Excel. Dengan Office berlisensi, jalankan uji dengan `MIRA_E2E_REAL_EXCEL=1`. ([[Tahap 4]])
- Jaringan kantor: jawaban tim jaringan soal mDNS, isolasi Wi-Fi, VLAN, dan VPN belum ada. ([[Keputusan]])

## Bagian yang belum dijalankan sungguhan

- Tombol "Izinkan lewat Windows Firewall" (UAC) belum pernah diklik, karena mengubah pengaturan sistem. Yang dicek hanya sintaks perintah dan bagian baca-saja.
- "Ikuti Windows" diuji dengan emulasi `prefers-color-scheme`, bukan dengan mengganti tema Windows.
- Notifikasi Windows tidak dilihat langsung di layar. Plugin notifikasi di Windows selalu melaporkan berhasil.
- Layar HiDPI (skala 150%), pena sungguhan, dan PDF dari Word atau Acrobat sungguhan belum dicoba di aplikasi.
- Bentrok dokumen belum bisa dibuat lewat aplikasi; diuji lewat tes unit.
- Uji multi-instance menjalankan exe dari `target/release`, bukan aplikasi hasil instal.

## Fitur yang belum dibuat

- Sinkron dokumen dan tanda tangan antar laptop. Sedang dikerjakan di branch lain; jangan dianggap bekerja.
- Task dari pesan chat (F-TASK-03).
- Tanda "sudah digabung" di kartu task (F-TASK-04); nilainya selalu `false`.
- Kartu task tanda tangan pindah ke Selesai otomatis (F-SIGN-06).
- Komentar, stabilo, dan kotak teks di PDF (F-DOC-06).
- Halaman Keamanan untuk perubahan yang ditolak (F-ROLE-07).
- Kunci cadangan superadmin di flashdisk (F-ROLE-06).
- Pemindaian QR dengan webcam. QR hanya ditampilkan, plus tautan `mira://` yang bisa disalin.
- Menghapus dokumen.

## Batas yang sudah diketahui

- Masa berlaku undangan, masa tunggu PIN, dan kunci PIN memakai jam laptop.
- Hak di chat dinilai menurut peran sekarang, bukan saat pesan dibuat.
- Tanda terima chat terus bertambah dan belum dipadatkan. Belum ada kuota titipan atau unduhan.
- Data board di laptop yang dikeluarkan tidak dihapus dari disk, hanya tidak ditampilkan.
- `JoinAccepted` harus muat dalam 4 MiB, yang membatasi organisasi yang sangat besar.

Lihat juga: [[Cara menjalankan dan menguji]], [[Keamanan dan izin]]. Kembali ke [[Beranda]].
