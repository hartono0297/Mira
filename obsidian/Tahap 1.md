---
tags: [mira, tahap, jaringan]
status: selesai
---

# Tahap 1: Jaringan dan tim

## Tujuan

Laptop saling menemukan, tersambung lewat koneksi terenkripsi yang hanya menerima anggota, dan menyinkronkan anggota, tim, dan peran. Orang baru masuk lewat kode undangan. Kriteria selesai di rencana: tiga laptop di kantor saling melihat di daftar "Di jaringan", satu laptop lewat VPN ikut tersambung, dan laptop tanpa kode undangan ditolak.

## Yang dibuat

- Log keanggotaan bertanda tangan di `permissions/`: 14 jenis op, fold status organisasi, rantai kepercayaan, kode undangan. Migrasi SQLite v2.
- Jaringan di `network/`: QUIC dengan sertifikat Ed25519 di kedua sisi, pemeriksaan keanggotaan setelah jabat tangan, ALPN terpisah untuk bergabung, sinkron op, mDNS, alamat yang diingat, alamat manual, status LAN atau VPN.
- Panduan Windows Firewall di onboarding dan di Pengaturan > Jaringan, termasuk perintah untuk admin IT.
- QR code dan tautan `mira://peer` untuk alamat laptop.
- Tampilan: gabung dengan kode, daftar "Di jaringan", menu Organisasi (tim, anggota, peran, undangan), Pengaturan > Jaringan, layar penuh saat laptop dikeluarkan.
- Uji `scripts/e2e-multi.mjs` dengan empat instance, dan tes integrasi tiga node di `net_backend_tests.rs`.

Rincian protokol ada di [[Arsitektur]] dan [[Keamanan dan izin]].

## Status

Selesai di uji satu PC. Empat instance saling menemukan, bergabung dengan peran yang benar, kode salah atau kedaluwarsa ditolak, anggota yang dikeluarkan berhenti menerima data, dan instance yang mati menyusul setelah menyala. Uji multi-instance 25/25.

Kriteria rencana yang melibatkan tiga laptop sungguhan dan satu lewat VPN belum terpenuhi. Lihat [[Belum diuji]].

## Rujukan

- Laporan: [docs/progress/tahap-1.md](../docs/progress/tahap-1.md)
- Rencana: [docs/plans/tahap-1.md](../docs/plans/tahap-1.md)

Sebelumnya: [[Tahap 0]]. Berikutnya: [[Tahap 2]]. Kembali ke [[Beranda]].
