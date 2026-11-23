---
tags: [mira, rilis]
---

# Rilis

## v0.1.0

Rilis pertama Mira. Ini build internal untuk uji coba, belum untuk dipakai seluruh kantor.

Isinya:
- Chat, board per proyek, dokumen Word dan Excel dengan riwayat versi, dan tanda tangan PDF, semuanya tersinkron antar laptop di jaringan kantor.
- Sinkron dokumen dan tanda tangan berjalan di atas transport fitur yang asli ([[Transport sinkron fitur]]).
- Perbaikan keamanan dari review penggabungan, lihat [[Keamanan dan izin]].

Rilis ini hanya untuk Windows. Installer macOS dibuat GitHub Actions dan ikut terbit mulai rilis berikutnya, lihat [[macOS]].

Installer: `Mira_0.1.0_x64-setup.exe` (NSIS, 7,86 MB), terbit sebagai GitHub Release `v0.1.0` di halaman Releases repositori `Mira`. Repositori ini publik dan dulu bernama ChatCompany; folder lokalnya masih bernama ChatCompany. Cara memasang: jalankan `irm https://raw.githubusercontent.com/hartono0297/Mira/main/install.ps1 | iex` di PowerShell, atau lihat bagian "Memasang" di [README](../README.md#memasang).

Diperiksa pada kode gabungan di satu PC: tes Rust, clippy, tsc, Vitest, dan semua uji ujung ke ujung lulus. Angkanya ada di [[Cara menjalankan dan menguji]].

Yang perlu diketahui sebelum memasang:
- Installer belum punya sertifikat penandatanganan kode, jadi Windows SmartScreen bisa memberi peringatan.
- Belum diuji di beberapa laptop sungguhan, lewat VPN, atau dengan Microsoft Office berlisensi. Lihat [[Belum diuji]].
- Layar Dokumen baru bisa menambah file ke Pustaka Umum.
- Logo, nama penerbit installer, dan kebijakan PIN masih sementara. Lihat [[Keputusan]].

Kembali ke [[Beranda]].
