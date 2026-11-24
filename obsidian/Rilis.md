---
tags: [mira, rilis]
---

# Rilis

Mulai v0.3.0 setiap rilis adalah rilis biasa (bukan prerelease), supaya pembaruan dari dalam aplikasi bisa membaca `latest.json` di rilis terbaru. Alurnya: naikkan versi, push `main`, pasang tag `vX.Y.Z`, workflow Rilis membuat draft berisi installer, `.sig`, `.sha256`, dan `latest.json`, lalu draft diterbitkan.

## v0.5.0

Isinya:
- Bergabung lewat akun Windows kantor: di PC dengan akun domain, Mira memilih kantor yang domain AD-nya sama dan mengisi nama serta departemen dari Active Directory (atribut `department`, atau OU yang dicocokkan superadmin). Laptop admin mengecek ulang ke AD (akun ada, aktif, cocok), lalu admin tetap menekan Setujui. Mac dan PC tanpa domain memakai alur manual.
- Satu domain, satu kantor: kantor kedua untuk domain yang sama ditolak, kantor Mira 0.1 dan 0.2 tetap terlihat saat memasang dengan langkah pembaruan, dan anggota diberi tahu kalau ada laptop dari kantor Mira lain di jaringan.
- Detail task: nilai yang bisa diubah diberi bingkai seperti kolom isian, yang hanya dibaca tampil sebagai teks biasa.

Organisasi kantor di-reset pada 24 November 2026 dan dibuat ulang di versi ini, karena laptop 0.3.0 sempat membuat kantor kedua tanpa melihat kantor 0.1.0. Bergabung lewat data AD aktif setelah semua laptop memakai 0.5.0. Jalur LDAP sungguhan belum diuji di PC domain kantor; semua uji memakai AD tiruan. Laporan: `docs/progress/onboarding-ad.md` dan `docs/progress/task-detail-bingkai.md`.

Diperiksa pada kode gabungan (branch `integrasi-v05`) di satu PC Windows: `cargo test` 1225 lulus (7 diabaikan), clippy tanpa peringatan, tsc bersih, Vitest 1746 tes di 118 file lulus, dan 15 skrip uji ujung ke ujung pada build debug lulus dengan 627 dari 627 pemeriksaan, termasuk `ad-e2e` 97/97, semuanya pada percobaan pertama.

## v0.4.0

Isinya:
- Bahasa Inggris di seluruh aplikasi. Dipilih di Pengaturan > Bahasa atau di layar pertama onboarding, berlaku langsung, tersimpan per laptop. Isi tulisan rekan dan teks di PDF bertanda tangan tidak diterjemahkan.
- Board: subtask, pelacakan waktu (durasi per kolom, cycle time, timer per orang, catatan manual), dan dialog detail task satu kolom.
- Menu klik kanan di Chat, Board, Dokumen, Tanda tangan, dan Organisasi. Menu bawaan WebView dimatikan; kolom teks mendapat Potong, Salin, Tempel.
- Bergabung: nama, pilih kantor, pilih departemen, keterangan untuk admin. Admin melihat nama akun login laptop peminta. Membuat kantor baru dipindah ke bagian "Untuk admin IT".
- Chat: lipat sidebar diperbaiki dan tersimpan, grup bisa dibuat sendirian, chat proyek tampil sebagai grup anggota proyek.

Laptop 0.3 menolak subtask dan catatan waktu di task. Perbarui semua laptop bersamaan; setelah diperbarui, laptop itu menyusul sendiri. Laporan per bagian ada di `docs/progress/v04-*.md`.

Diperiksa pada kode gabungan (branch `integrasi-v04`) di satu PC Windows: `cargo test` 1109 lulus (7 diabaikan), clippy tanpa peringatan, tsc bersih, Vitest 1632 tes di 113 file lulus, dan 14 skrip uji ujung ke ujung pada build debug lulus dengan 435 dari 435 pemeriksaan, semuanya pada percobaan pertama.

## v0.3.0

Departemen, bergabung dengan persetujuan dan kode cocok, anggota proyek, chat lima bagian dengan grup, label keahlian, angka notifikasi, daftar pengguna untuk superadmin, cek pembaruan dari dalam aplikasi dengan dialog Yang baru, serta perbaikan seret kartu board dan tanda tangan PDF yang salah ditolak. Laptop 0.1.0 atau 0.2.0 perlu menjalankan perintah pasang sekali lagi; setelah itu pembaruan bisa dari dalam Mira.

## v0.2.0

Menambah dukungan macOS (11 atau lebih baru, Apple Silicon dan Intel). Isinya:

- kunci laptop di Keychain macOS;
- panduan firewall macOS;
- pemantau simpan Word dan Excel untuk Office di Mac;
- izin Jaringan lokal.

Installer `Mira_0.2.0_x64-setup.exe` (Windows) dan `Mira_0.2.0_universal.dmg` (Mac) dibangun GitHub Actions, masing-masing dengan file `.sha256`. Pasang di Mac dengan `curl -fsSL https://raw.githubusercontent.com/hartono0297/Mira/main/install.sh | bash`. Belum diuji di MacBook sungguhan, lihat [[macOS]].

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
