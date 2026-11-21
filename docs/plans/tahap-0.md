# Rencana implementasi Tahap 0: Fondasi

Tanggal: 22 November 2026. Sumber: `design/rencana-pembangunan.html` (Tahap 0), `design/prd-mira.html` (F-ID-01 s.d. F-ID-04, F-UI-01 s.d. F-UI-04, F-ROLE-08/09, bagian 9 dan 11), `design/tema-c.html`.

## Tujuan

Aplikasi Mira bisa dipasang lewat installer NSIS, terbuka, membuat kunci laptop, menyimpan nama tampilan dan organisasi baru, langsung masuk ke kerangka utama setelah restart, dan mode Terang, Gelap, serta Ikuti Windows bekerja.

## Struktur repo

```
index.html, package.json, vite.config.ts      tampilan (Vite + React + TS)
src/
  main.tsx, App.tsx                            titik masuk, pemilih layar (memuat, error, onboarding, utama)
  api/                                         pembungkus invoke Tauri, tipe kontrak
  theme/                                       token warna, logika mode, penyimpanan pilihan
  styles/                                      CSS global, font
  screens/onboarding/                          layar pertama kali buka
  screens/shell/                               sidebar dan layout utama
  screens/{chat,board,docs,settings}/          isi tiap menu
src-tauri/
  tauri.conf.json                              jendela dibuat dari kode (create: false), CSP ketat, target NSIS
  src/lib.rs                                   setup Tauri, state, daftar command
  src/paths.rs                                 folder data (MIRA_DATA_DIR atau folder data aplikasi)
  src/db/                                      koneksi SQLite dan migrasi bernomor
  src/identity/                                kunci Ed25519, KeyStore (keyring / memori untuk tes), nama tampilan
  src/org/                                     pembuatan organisasi, anggota dan peran
  src/settings.rs                              pengaturan lokal per laptop (key-value)
  src/commands.rs                              command Tauri yang dipanggil tampilan
  src/error.rs                                 tipe error dengan kode dan pesan bahasa Indonesia
docs/plans, docs/progress                      rencana dan laporan
```

Modul Rust dipisah supaya Tahap 1 tinggal menambah `network/`, `sync/`, `permissions/` di sebelahnya tanpa mengubah yang ada.

## Kontrak tampilan dan inti Rust

Semua command mengembalikan `Result<T, AppError>`. `AppError` diserialisasi sebagai `{ "code": string, "message": string }`, `message` dalam bahasa Indonesia dan siap ditampilkan.

| Command | Argumen | Hasil |
|---|---|---|
| `get_app_state` | (tidak ada) | `AppState` |
| `save_display_name` | `{ name: string }` | `IdentityInfo` |
| `create_organization` | `{ name: string }` | `OrgInfo` |
| `get_setting` | `{ key: string }` | `string \| null` |
| `set_setting` | `{ key: string, value: string }` | `null` |

```ts
type AppState = {
  identity: IdentityInfo;          // kunci selalu dibuat saat aplikasi start
  organization: OrgInfo | null;
  dataDir: string;
};
type IdentityInfo = {
  publicKey: string;               // hex 64 karakter
  fingerprint: string;             // 4 grup x 4 karakter hex, untuk ditampilkan
  displayName: string | null;      // null sampai nama diisi
  createdAt: string;               // RFC 3339
};
type OrgInfo = {
  id: string;                      // hex 32 karakter acak
  name: string;
  role: "superadmin" | "team_admin" | "member" | "guest";
  createdAt: string;
};
```

Aturan validasi (dicek di Rust, juga di tampilan untuk pesan cepat):
- Nama tampilan: dipangkas, 1 sampai 50 karakter.
- Nama organisasi: dipangkas, 2 sampai 80 karakter.
- `create_organization` gagal dengan kode `name_required` kalau nama tampilan belum diisi, dan `org_exists` kalau organisasi sudah ada.
- Kode error lain: `invalid_name`, `keystore`, `key_mismatch`, `database`, `internal`, `invalid_setting` (kunci atau nilai pengaturan tidak valid).

Pengaturan yang dipakai Tahap 0: `theme.mode` (`light`, `dark`, `system`, bawaan `system`) dan `theme.name` (`bata`).

Alur tampilan: `get_app_state` → kalau `displayName` null tampilkan langkah nama; kalau `organization` null tampilkan pilihan organisasi; selain itu kerangka utama.

## Tugas

Kelompok A (tampilan), B (inti Rust), dan C (ikon dan installer) tidak menyentuh file yang sama, jadi dikerjakan paralel oleh tiga subagent.

### 0. Scaffold (dikerjakan sesi utama, berurutan)
- 0.1 `git init`, `.gitignore`, commit dokumen desain. Verifikasi: `git log`.
- 0.2 Scaffold `create-tauri-app` (react-ts, npm), salin ke root, set `tauri.conf.json` (nama Mira, identifier `id.mira.desktop`, jendela `create: false`, CSP ketat tanpa sumber luar, target NSIS). Verifikasi: `npm run build`, `cargo check`.
- 0.3 Rencana ini. Commit.

### A. Tampilan (subagent A) — file: `src/**`, `index.html`, `package.json` (hanya dependensi frontend dan skrip test), `vite.config.ts`, `vitest` config
- A.1 Dependensi: `@fontsource/nunito` (400, 600, 700), `@tabler/icons-react`, `vitest`, `@testing-library/react`, `jsdom`. Semua dibundel lokal, tidak ada CDN. Verifikasi: `npm run build`, cek `dist/` tidak berisi URL `http` ke luar.
- A.2 Token warna tema Bata (terang dan gelap) sebagai CSS variables per peran di `src/theme/`, nilai persis dari `design/tema-c.html`. Tema = satu objek nilai token, siap ditambah tema lain. Verifikasi: cek kontras pasangan teks dengan `check_contrast`.
- A.3 Logika mode (TDD): `resolveTheme(mode, systemDark)`, validasi nilai tersimpan, pemantau `prefers-color-scheme`. Pilihan disimpan lewat `set_setting` dan disalin ke `localStorage` hanya untuk mencegah kedip saat start. Verifikasi: `npm test`.
- A.4 Pembungkus API `src/api/` dengan tipe kontrak di atas dan penanganan `AppError`.
- A.5 Layar akar: memuat, error (dengan langkah berikutnya dan tombol Coba lagi), onboarding, utama.
- A.6 Onboarding: langkah nama, lalu pilihan "Buat organisasi baru" (form nama organisasi, peran superadmin dijelaskan) atau "Gabung dengan kode" (keterangan jujur: hadir di Tahap 1, tombol kembali). Keadaan menyimpan dan error per form.
- A.7 Kerangka utama: sidebar (logo, nama Mira, menu Chat, Board, Dokumen, Pengaturan, nama pengguna dan organisasi), tampilan kosong yang jujur untuk Chat, Board, Dokumen.
- A.8 Pengaturan > Tampilan: pilihan mode dengan thumbnail seperti mockup, daftar tema (Bata dipakai, Kertas dan Panel "Nanti"), keterangan "hanya di laptop ini". Plus Pengaturan > Laptop ini: nama, sidik jari kunci, folder data (hanya baca).
- A.9 Aksesibilitas: fokus keyboard terlihat, navigasi keyboard, label form, `aria-live` untuk pesan error. Verifikasi: tes Vitest untuk komponen kunci, `npm run build`.

### B. Inti Rust (subagent B) — file: `src-tauri/src/**`, `src-tauri/Cargo.toml`, `src-tauri/capabilities/**`
- B.1 Dependensi: `ed25519-dalek` (fitur `rand_core`), `rand`, `keyring` v3 (fitur `windows-native`), `rusqlite` (fitur `bundled`), `thiserror`, `hex`, `time` atau `chrono`, `tempfile` (dev). Verifikasi: `cargo check`.
- B.2 `paths.rs`: folder data dari `MIRA_DATA_DIR` kalau ada, kalau tidak folder data aplikasi Tauri. Tes: env dipakai saat diset.
- B.3 `db/`: buka SQLite, `PRAGMA journal_mode=WAL`, `foreign_keys=ON`, migrasi bernomor lewat `user_version`. Tabel: `identity`, `organizations`, `members`, `settings`. Tes: migrasi idempoten.
- B.4 `identity/` (TDD): `KeyStore` trait, `KeyringStore` (service `id.mira.desktop`, akun `device-key-<publicKey hex>`), `MemoryKeyStore` untuk tes. `ensure_identity` membuat kunci kalau belum ada, memeriksa kunci privat di keystore cocok dengan kunci publik di DB (kalau tidak, error `key_mismatch`). `save_display_name`. Tes: kunci dibuat sekali, dipakai ulang setelah buka ulang, tanda tangan bisa diverifikasi, nama tervalidasi.
- B.5 `org/` (TDD): `create_organization` membuat id acak, record organisasi dengan tanda tangan genesis Ed25519 oleh pendiri (persiapan rantai kepercayaan F-ROLE-12), dan baris `members` dengan peran `superadmin`. Tes: pembuat jadi superadmin, tanda tangan genesis valid, tidak bisa membuat dua kali, butuh nama tampilan.
- B.6 `settings.rs` dan `commands.rs`: command sesuai kontrak, state `Mutex<Connection>`. Jendela dibuat di `setup` dari config; kalau `MIRA_DATA_DIR` diset, data WebView2 juga dipisah ke `<MIRA_DATA_DIR>/webview` dan judul jendela diberi akhiran nama folder supaya beberapa instance bisa dibedakan.
- B.7 Plugin `tauri-plugin-single-instance` tidak dipakai (beberapa instance dibutuhkan untuk tes). Verifikasi: `cargo test`, `cargo clippy`.

### C. Ikon dan installer (subagent C) — file: `src-tauri/icons/**`, kunci `bundle` di `tauri.conf.json`
- C.1 Konversi `design/logo-sementara.svg` ke PNG 1024 px (tanpa mengubah folder `design/`), jalankan `npx tauri icon`. Verifikasi: `icon.ico` berisi logo M.
- C.2 Konfigurasi NSIS: `installMode` per pengguna, bahasa installer, nama penerbit, `shortDescription`. Verifikasi: `tauri.conf.json` lolos skema.

### D. Integrasi dan review (sesi utama)
- D.1 Gabungkan, jalankan `npm test`, `cargo test`, `npm run build`.
- D.2 Subagent reviewer terpisah memeriksa kebenaran dan kesesuaian PRD. Perbaiki temuan.
- D.3 `npm run tauri build`, pasang atau jalankan exe hasil build dengan `MIRA_DATA_DIR` sementara, uji: layar pertama, simpan nama, buat organisasi, restart masuk ke kerangka utama, ganti mode tema. Screenshot.
- D.4 Laporan `docs/progress/tahap-0.md`, commit.

## Di luar Tahap 0
F-ID-03 (panduan Windows Firewall) baru berguna setelah ada jaringan, jadi dikerjakan di Tahap 1. Bergabung dengan kode, tim, dan jaringan juga Tahap 1.
