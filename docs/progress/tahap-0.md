# Laporan Tahap 0: Fondasi

Tanggal: 22 November 2026. Rencana: `docs/plans/tahap-0.md`.

## Ringkasan

Tahap 0 selesai. Installer NSIS terbentuk dan bisa dipasang. Aplikasi hasil instal terbuka, nama dan organisasi tetap tersimpan setelah restart, dan mode Terang, Gelap, serta Ikuti Windows bekerja. Semua tes lulus dan semua pekerjaan sudah di-commit lokal di branch `main`, tanpa remote dan tanpa push.

## Yang dibuat

**Proyek dan repo**
- Repo Git di `D:\GitHub\ChatCompany`. Folder `design/` dan PDF brainstorming ikut di-commit tanpa diubah.
- Proyek Tauri 2 + React 19 + TypeScript + Vite (npm). Nama aplikasi "Mira", identifier `id.mira.desktop`.
- Versi yang dikunci (lihat `package-lock.json` dan `Cargo.lock`): Tauri 2.12.7, CLI 2.12.6, React 19.3.1, Vite 8.3.8, TypeScript 6.0.3, Vitest 5.1.1, ed25519-dalek 2.2.0, keyring 3.6.3, rusqlite 0.43.0 (SQLite bawaan).

**Tampilan (`src/`)**
- Token warna per peran di `src/theme/tokens.ts`, dengan nilai persis dari `design/tema-c.html`. Satu tema adalah satu objek `{ light, dark }`, jadi tema Kertas dan Panel nanti tinggal ditambah. Layar tidak memakai kode warna langsung.
- Mode Terang, Gelap, dan Ikuti Windows. Pilihan disimpan di SQLite lewat inti Rust (per laptop, per folder data), lalu disalin ke `localStorage` hanya supaya warna benar sejak awal saat dibuka. Penyimpanan dibuat berurutan; kalau gagal, pilihan kembali ke mode terakhir yang benar-benar tersimpan.
- Font Nunito (`@fontsource`) dan ikon Tabler (`@tabler/icons-react`) dibundel lokal. CSP jendela hanya mengizinkan `'self'`, jadi aplikasi tidak bisa memuat apa pun dari internet.
- Layar pertama kali buka:
  1. Isi nama, beserta keterangan bahwa Mira tidak memakai akun dan sidik jari kunci laptop.
  2. Pilih "Buat organisasi baru" (pembuatnya jadi Superadmin) atau "Gabung dengan kode". Pilihan kedua menjelaskan dengan jujur bahwa fitur ini hadir di Tahap 1.
- Kalau aplikasi ditutup setelah nama tersimpan, saat dibuka lagi langsung ke langkah 2.
- Kerangka utama berisi sidebar dengan logo, menu Chat, Board, Dokumen, dan Pengaturan, serta nama, organisasi, dan peran pengguna. Layar Chat, Board, dan Dokumen menampilkan keadaan kosong yang menyebut tahap kapan fiturnya hadir, tanpa data karangan.
- Pengaturan:
  - "Tampilan": pilihan mode bergambar mini seperti mockup, daftar tema (Bata "Dipakai", Kertas dan Panel "Nanti"), dan catatan "hanya berlaku di laptop ini".
  - "Laptop ini": nama, sidik jari kunci, folder data, organisasi, dan peran.
- Keadaan memuat, error (berisi penyebab, langkah berikutnya, dan tombol Coba lagi), serta kosong ada di setiap layar. Fokus keyboard terlihat, setiap isian punya label, pesan error dibacakan lewat `aria-live`, dan `prefers-reduced-motion` dihormati.

**Inti Rust (`src-tauri/src/`)**
- Modul `paths`, `db` (migrasi bernomor lewat `user_version`), `identity`, `org`, `settings`, `commands`, `error`, `state`. Tahap 1 tinggal menambah `network/`, `sync/`, dan `permissions/` di sebelahnya, serta migrasi baru.
- Identitas (F-ID-01, F-ID-04):
  - Saat start, aplikasi membuat kunci Ed25519 kalau belum ada.
  - Kunci privat disimpan di Windows Credential Manager (`keyring`) dengan nama `device-key-<kunci publik>.id.mira.desktop`. Kunci publik dan nama tampilan disimpan di SQLite.
  - Kalau kunci privat hilang atau tidak cocok, aplikasi menampilkan error `key_mismatch` dan tidak diam-diam membuat identitas baru.
- Organisasi (F-ID-02, F-ROLE-08/09):
  - Pembuatan organisasi menghasilkan id acak dan record yang ditandatangani kunci pendiri (tanda tangan genesis, persiapan rantai kepercayaan F-ROLE-12). Pembuatnya tercatat di tabel `members` sebagai `superadmin`.
  - Format bytes yang ditandatangani tercatat di `org/mod.rs`.
- Skema SQLite v1: `identity`, `organizations`, `members`, `settings` (tabel STRICT). Memakai `journal_mode=WAL` dan `synchronous=FULL`.
- Validasi nama:
  - Nama tampilan 1 sampai 50 karakter, nama organisasi 2 sampai 80 karakter.
  - Karakter kontrol dan karakter tak terlihat ditolak (zero-width, bidi override, BOM), supaya nama tidak bisa tampil kosong atau meniru nama orang lain.
- `MIRA_DATA_DIR` memisahkan database, profil WebView2, dan judul jendela per instance, misalnya "Mira (laptop-a)". Dengan begitu beberapa "laptop" bisa jalan di satu PC untuk Tahap 1.

**Ikon dan installer**
- Ikon dibuat dari `design/logo-sementara.svg` lewat `npx tauri icon`.
- Installer NSIS per pengguna, dengan teks installer berbahasa Indonesia (`src-tauri/nsis/Indonesian.nsh`).
- Varian installer offline tersedia lewat `src-tauri/tauri.offline.conf.json`.

**Pengujian**
- `scripts/smoke-e2e.mjs`: uji ujung ke ujung terhadap aplikasi hasil build. Skrip menjalankan `mira.exe` dengan folder data sementara dan mengendalikan WebView2 lewat DevTools Protocol (`playwright-core`, hanya alat uji, tidak ikut dibundel). Di akhir, skrip menghapus folder data dan kunci uji yang dibuatnya sendiri dari Credential Manager.

## Keputusan yang saya ambil sendiri

| Keputusan | Alasan |
|---|---|
| Installer utama memakai `downloadBootstrapper` untuk WebView2 (installer 2,3 MB). Varian offline tersedia (`npm run build:installer-offline`, sekitar 286 MB). | Windows 11 dan Windows 10 yang terbarui sudah punya WebView2, jadi installer kecil cukup. Laptop tanpa WebView2 dan tanpa internet bisa memakai varian offline. Ukuran 286 MB terlalu berat sebagai bawaan. |
| Installer per pengguna (`currentUser`), terpasang di `%LOCALAPPDATA%\Mira`. | Karyawan sering tidak punya hak admin. |
| Teks installer bahasa Indonesia lewat file `.nsh` sendiri. | Tauri belum punya terjemahan Indonesia untuk teks installer khasnya. Beberapa tombol bawaan NSIS (Next, Install) tetap mengikuti terjemahan NSIS. |
| Data di `%LOCALAPPDATA%`, bukan `%APPDATA%` (roaming). | Ditemukan saat review. Di kantor dengan profil roaming, data roaming bisa membawa identitas satu laptop ke laptop lain dan merusak file SQLite yang sedang dipakai. |
| `synchronous=FULL` di SQLite. | Ditemukan saat review. Mati listrik tidak boleh menghilangkan identitas atau organisasi yang sudah tersimpan (PRD bagian 9). |
| Kunci privat tetap di memori selama aplikasi berjalan (dihapus dari memori saat ditutup). | Tahap 1 akan menandatangani setiap perubahan, dan membaca Credential Manager setiap kali menandatangani akan lambat. |
| Zustand dan Radix UI belum dipakai. | Di Tahap 0, React context dan radio native sudah cukup dan aksesibel. Keduanya bisa ditambah saat ada dialog, menu, dan state dari jaringan. |
| Token warna tambahan yang tidak ada di tema-c: `danger` (#A3221B terang, #FF9A8F gelap), `danger-soft`, `danger-border`, `hover`. | Dibutuhkan untuk pesan error dan hover. Semua pasangan lolos WCAG AA (dicek dengan `check_contrast`). |
| Uji ujung ke ujung memakai DevTools Protocol, bukan WebdriverIO + tauri-driver seperti di PRD. | Lebih cepat disiapkan dan bisa menguji emulasi tema sistem. Masih bisa diganti nanti. |
| F-ID-03 (panduan Windows Firewall) ditunda ke Tahap 1. | Panduan ini baru berarti setelah ada koneksi jaringan. |
| Penerbit installer diisi "Mira" dan copyright "Hak cipta (c) 2026 Mira". | Isian sementara. |

## Hasil verifikasi (apa adanya)

| Pemeriksaan | Hasil |
|---|---|
| `cargo test` (di `src-tauri`) | 33 lulus, 1 diabaikan |
| `cargo test -- --ignored` (keyring sungguhan) | Lulus: set, get, dan delete di Windows Credential Manager. Dijalankan oleh subagen Rust. |
| `cargo clippy --all-targets`, `cargo fmt --check` | Bersih |
| `npm test` (Vitest) | 29 lulus di 5 file. Dijalankan 5 kali berturut-turut setelah tes yang sempat tidak stabil diperbaiki. |
| `npm run build:installer` | Lulus: `Mira_0.1.0_x64-setup.exe`, 2,26 MB |
| `npm run build:installer-offline` | Lulus satu kali (286 MB), sebelum perbaikan terakhir. Belum dibuild ulang setelahnya. |
| Pasang installer secara senyap (`/S`) | Lulus, terpasang di `%LOCALAPPDATA%\Mira` |
| Uji ujung ke ujung terhadap aplikasi hasil instal | 11 dari 11 pemeriksaan lulus (rincian di bawah) |
| Jalankan tanpa `MIRA_DATA_DIR` | Judul jendela "Mira", data di `%LOCALAPPDATA%\id.mira.desktop`, satu kunci di Credential Manager |
| Copot installer (`uninstall.exe /S`) | Lulus, folder aplikasi terhapus |

Pemeriksaan di uji ujung ke ujung:
1. Layar pertama menampilkan isian nama.
2. Judul jendela memuat nama folder data.
3. Nama kosong ditolak dengan pesan.
4. Nama tersimpan, lalu lanjut ke pilihan organisasi.
5. "Gabung dengan kode" menampilkan keterangan.
6. Organisasi dibuat, lalu aplikasi masuk ke kerangka utama sebagai Superadmin.
7. Setelah restart, aplikasi langsung masuk ke kerangka utama dengan nama dan organisasi tetap.
8. Mode Gelap diterapkan.
9. Mode Terang diterapkan.
10. Ikuti Windows mengikuti emulasi sistem: gelap, lalu terang.
11. Mode Gelap tetap setelah restart.

Screenshot dari aplikasi hasil instal ada di `docs/progress/screenshots/`, berisi 11 gambar: layar pertama, pilihan organisasi, gabung dengan kode, buat organisasi, kerangka Chat, Board dan Dokumen kosong, Pengaturan gelap dan terang, Laptop ini, serta Chat gelap setelah restart. Nama "Rina Uji" dan "Kantor Uji" di gambar adalah data uji.

Review dilakukan oleh dua subagen terpisah, satu untuk inti Rust dan satu untuk tampilan. Temuan yang sudah diperbaiki:
- Folder data roaming
- `synchronous=NORMAL`
- Karakter tak terlihat di nama
- Profil WebView2 yang salah saat folder dari `MIRA_DATA_DIR` gagal dibuat
- Kode error `invalid_setting` yang belum ada di kontrak
- Penyimpanan mode tema yang bisa tumpang tindih
- Wilayah `aria-live` yang tersembunyi
- Tes Vitest yang tidak stabil

**Belum dicek atau masih terbatas:**
- "Ikuti Windows" diuji dengan emulasi `prefers-color-scheme` lewat DevTools. Saya tidak mengganti tema Windows sungguhan karena itu mengubah pengaturan sistem Anda. Silakan coba sendiri: Pengaturan Windows > Personalisasi > Warna.
- Navigasi keyboard dan fokus dicek oleh subagen tampilan di Vite dengan jembatan Tauri tiruan, bukan di aplikasi hasil build.
- Saat dibuka dalam mode Gelap, jendela bisa sempat putih sekejap sebelum tampilan dimuat, karena warna latar jendela belum diatur dari Rust.
- Installer belum ditandatangani, jadi Windows SmartScreen akan memperingatkan saat installer dijalankan.
- Kalau aplikasi mati tepat di antara penyimpanan kunci ke Credential Manager dan penulisan ke database, satu entri kunci yatim tertinggal di Credential Manager. Entri itu tidak berbahaya, tapi belum ada pembersihan otomatis.
- `verify_genesis` belum memeriksa format setiap field. Ini wajib ditambah sebelum Tahap 1 menerima record organisasi dari laptop lain.
- Crate `keyring` menyimpan kredensial dengan mode persist "enterprise", sehingga entrinya bisa ikut roaming. Saat ini tidak berbahaya karena database tetap lokal, tapi perlu dicek ulang di Tahap 1.
- Plugin `opener` bawaan template masih terpasang walau belum dipakai. PRD menyebutnya untuk membuka file Word dan Excel di Tahap 4.

## Lokasi installer

`D:\GitHub\ChatCompany\src-tauri\target\release\bundle\nsis\Mira_0.1.0_x64-setup.exe` (2,26 MB, tidak di-commit karena ada di folder build). Aplikasi hasil uji sudah saya copot lagi, dan data serta kunci uji sudah dihapus dari PC ini.

## Cara menjalankan dan menguji

```
npm install
npm run tauri dev                    # versi pengembangan
npm test                             # tes tampilan
cd src-tauri; cargo test             # tes inti Rust
npm run build:installer              # installer kecil
npm run build:installer-offline      # installer dengan WebView2 offline
npm run test:e2e                     # uji ujung ke ujung terhadap build release
```

Untuk mencoba beberapa "laptop" sekaligus, jalankan setiap instance dengan folder data berbeda:

```
$env:MIRA_DATA_DIR = "D:\mira-uji\laptop-a"; & "$env:LOCALAPPDATA\Mira\mira.exe"
```

Untuk mengulang dari awal, hapus folder data dan entri `device-key-...id.mira.desktop` di Credential Manager (Panel Kontrol > Pengelola Kredensial > Kredensial Windows).

## Commit

Branch `main`, tanpa remote:
1. Tambah dokumen desain dan `.gitignore`
2. Scaffold Tauri 2 + React + TypeScript dan rencana Tahap 0
3. Inti Rust (identitas, keyring, SQLite, organisasi), ikon, dan konfigurasi NSIS
4. Perbaikan hasil review inti Rust
5. Tampilan (tema, onboarding, kerangka layar, Pengaturan)
6. Perbaikan review tampilan, installer berbahasa Indonesia, varian offline, dan uji ujung ke ujung
7. README dan laporan ini

## Yang perlu Anda putuskan

1. **Installer bawaan: kecil (2,3 MB, butuh internet hanya kalau WebView2 belum ada) atau offline (sekitar 286 MB)?** Saya memilih yang kecil sebagai bawaan. Kalau ada laptop kantor Windows 10 lama yang tidak pernah update dan tidak punya internet, pakai varian offline.
2. **Nama penerbit dan copyright di installer.** Saat ini masih isian sementara "Mira".
3. **Alat uji ujung ke ujung.** Saya memakai DevTools Protocol, sedangkan PRD menyebut WebdriverIO + tauri-driver. Usul saya: tetap pakai DevTools Protocol kecuali ada alasan khusus.
4. Logo final dan sertifikat penandatanganan installer tetap dari daftar sebelumnya, dan belum mendesak.

## Catatan untuk Tahap 1

- Tambah migrasi v2 untuk tabel tim, keanggotaan tim, undangan, dan alamat rekan. Peran di `members` saat ini masih tingkat organisasi.
- Validasi format setiap field sebelum menerima record dari laptop lain.
- Atur warna latar jendela dari Rust sesuai mode tema, supaya tidak ada kedip putih.
- F-ID-03 panduan Windows Firewall. Dengan installer per pengguna, aturan firewall mungkin butuh izin admin sekali.
