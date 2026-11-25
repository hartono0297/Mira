---
tags: [mira, rilis]
---

# Rilis

Mulai v0.3.0 setiap rilis adalah rilis biasa (bukan prerelease), supaya pembaruan dari dalam aplikasi bisa membaca `latest.json` di rilis terbaru. Alurnya: naikkan versi, push `main`, pasang tag `vX.Y.Z`, workflow Rilis membuat draft berisi installer, `.sig`, `.sha256`, dan `latest.json`, lalu draft diterbitkan.

## v0.6.0

Isinya:
- Divisi di dalam departemen. Admin departemen (atau superadmin) membuat, mengganti nama, mengarsipkan, dan memulihkan divisi, lalu menunjuk kepala divisi. Kepala divisi mengatur anggota divisinya. Setiap divisi punya chat sendiri di bagian Departemen dan bisa punya proyek divisi. Pemetaan OU AD boleh menyebut divisi.
- Tab Departemen saya di Organisasi untuk superadmin, admin departemen, dan kepala divisi: divisi, anggota, permintaan bergabung, undangan, proyek, pengaturan channel, dan riwayat admin. Admin departemen bisa mengangkat dan melepas admin lain di departemennya. Channel utama departemen dan chat divisi bisa diberi catatan disematkan dan mode pengumuman.
- Chat: reaksi emoji di pesan siapa pun, pemilih emoji dengan pencarian Indonesia dan Inggris, sticker kantor yang dikelola superadmin (juga dipakai sebagai emote `:nama:` sebaris), sticker pribadi, dan semua label keahlian orang di Chat. Tanpa paket sticker bawaan.
- Kopi, reputasi yang hanya positif: kopi dari rekan dengan alasan yang terlihat semua orang, kopi dari kerja yang dihitung dari board, tingkatan Anak baru, Andalan, Senior, Legenda, dan papan bulanan di Organisasi > Kopi.
- Foto profil di Pengaturan > Profil, disimpan JPEG 256x256 tanpa metadata dan tersebar ke semua anggota aktif termasuk Tamu. Superadmin bisa menghapus foto anggota.
- Board: timer dengan Mulai timer, Jeda, dan Lanjutkan, satu timer berjalan per orang di semua proyek, dan jeda otomatis (timer lain dimulai, task Selesai atau dihapus, Mira tertutup atau laptop tidur). Catat waktu manual disembunyikan lewat `MANUAL_TIME_LOG = false`; catatan manual lama tetap dihitung.
- Menu Kalender (Bulan, Minggu, Agenda) untuk task bertenggat, dengan ubah tenggat lewat seret, Alt+Panah, dan menu klik kanan. Sidebar bisa diringkas jadi ikon lewat tombol atau Ctrl+B.
- Bergabung: alasan data AD tidak dipakai tampil di bawah pilihan departemen, tawaran domain untuk superadmin di laptop domain, dan "Cocokkan OU ini ke departemen..." di kartu Permintaan bergabung.
- Nonaktifkan dan aktifkan lagi anggota tanpa mengeluarkannya (op `member_suspend` dan `member_reinstate`), terpisah dari keluarkan permanen (`member_remove`). Laptop yang dikeluarkan permanen mendapat "Reset dan mulai dari awal" untuk meminta bergabung lagi dengan kunci baru.

Gerbang versi: divisi, pengangkatan admin oleh admin departemen, proyek divisi, dan pemetaan OU ke divisi hanya ditulis setelah semua anggota aktif, Tamu juga, melaporkan 0.6.0 (`DIVISION_SINCE`). Nonaktifkan juga baru bisa dipakai setelah semua laptop di 0.6.0 (`SUSPEND_SINCE`). Reaksi dan sticker kantor hanya dikirim ke rekan yang melaporkan paling rendah 0.6.0 (`CHAT_STICKER_SINCE`), jadi laptop 0.5 tidak melihatnya dan pesan sticker tampil di sana sebagai `:nama:` dengan lampiran gambar. Kopi dan foto profil tidak memakai gerbang: laptop 0.5 mengabaikan topik `kopi` dan `profile`. Format data timer tidak berubah, jadi laptop 0.5 menerima segmen jeda sebagai catatan biasa.

Laptop 0.5 dan 0.6 yang berjalan berdampingan baru diperiksa lewat tes, belum dengan dua versi sungguhan. Semua uji berjalan di satu PC Windows, dan jalur LDAP sungguhan masih belum diuji. Laporan: `docs/progress/dept-divisi.md`, `docs/progress/chat-sticker.md`, `docs/progress/kopi.md`, `docs/progress/foto-profil.md`, `docs/progress/timer-jeda.md`, `docs/progress/sidebar-kalender.md`, dan `docs/progress/perbaikan-bergabung.md`.

Diperiksa pada kode gabungan (branch `integrasi-v06`) di satu PC Windows: `cargo test` 1571 lulus (7 diabaikan), clippy tanpa peringatan, tsc bersih, Vitest 2493 tes di 158 file lulus, dan 22 skrip uji ujung ke ujung pada build debug lulus dengan 891 dari 891 pemeriksaan. `smoke-docs-e2e` sempat gagal di satu pemeriksaan ("Folder salinan kerja dibersihkan") pada percobaan pertama sampai ketiga, karena tes memeriksa terlalu cepat di disk yang lambat. Pemeriksaan itu kini menunggu sampai 10 detik (commit `dad2020`) dan lulus 15/15. Semua skrip lain lulus pada percobaan pertama.

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
