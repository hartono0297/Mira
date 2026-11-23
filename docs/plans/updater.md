# Rencana: cek pembaruan, pembaruan dari dalam aplikasi, dan "Yang baru"

Tanggal: 23 November 2026. Branch `claude/updater-8a630b` (didorong ke origin sebagai `updater`). Dasar: `main` 8fada63.

## Tujuan

1. Mira bisa mengecek versi baru di GitHub Releases repo publik `hartono0297/Mira`, mengunduhnya, memeriksa tanda tangannya, memasangnya, lalu terbuka lagi dengan versi baru. Windows (NSIS per pengguna) dan macOS (`.app` universal).
2. Setelah diperbarui, Mira menampilkan sekali dialog "Yang baru di Mira <versi>" dari catatan yang dibundel di aplikasi, jadi tetap tampil tanpa internet.
3. Alur rilis GitHub Actions menghasilkan artefak pembaruan bertanda tangan dan `latest.json`.

## Batasan dari brief

- Tidak menyentuh `permissions/`, `board/`, `chat/`, `documents/`, `signing/`, `network/`, onboarding, halaman Organisasi.
- Sidebar: hanya satu titik kecil di menu Pengaturan (dua baris di `Shell.tsx`: import dan render `<UpdateDot />`). Ini satu-satunya titik merge di area yang sedang dikerjakan pihak lain.
- `lib.rs`: hanya `pub mod updater;`, satu baris plugin, dan baris perintah.
- `Cargo.toml`: satu dependensi `tauri-plugin-updater`. `package.json`: tidak berubah (pembaruan lewat perintah Rust sendiri, bukan plugin JS). `tauri.conf.json`: satu blok `plugins.updater`.
- `tauri-plugin-process` tidak dipakai: `AppHandle::restart()` di Tauri 2 sudah cukup untuk memulai ulang.
- Sesi ini tidak membuat kunci asli dan tidak menyentuh secret GitHub (session utama yang melakukannya, lihat bagian kunci). Uji memakai kunci UJI di folder scratch, tidak pernah di-commit.

## Pilihan endpoint

Endpoint: `https://github.com/hartono0297/Mira/releases/latest/download/latest.json`.

GitHub mengarahkan `/releases/latest/...` ke rilis terbaru yang **bukan draft dan bukan prerelease**. Rilis v0.1.0 dan v0.2.0 adalah prerelease, dan keduanya belum punya updater, jadi tidak ada yang hilang. Mulai v0.3.0 workflow membuat draft rilis **biasa** (tanpa `--prerelease`). Pemeliharaan cukup satu langkah: menerbitkan draft. Selama draft belum diterbitkan, laptop di kantor belum melihat versi baru, jadi draft tetap jadi tempat aman untuk memeriksa installer.

Alternatif yang ditolak:
- Endpoint API GitHub (`api.github.com/.../releases`) butuh logika parsing sendiri dan kena batas 60 permintaan per jam per IP. Satu kantor di belakang satu IP bisa kena batas itu.
- Rilis khusus bertag tetap (misalnya `updater`) yang asetnya ditimpa tiap rilis: menambah langkah dan rawan lupa.

Kalau rilis terbaru belum punya `latest.json` (GitHub membalas 404, misalnya sekarang karena belum ada rilis non-prerelease), Mira menganggapnya "sudah versi terbaru". Itu jawaban yang benar dari sisi pengguna: memang belum ada pembaruan yang bisa dipasang.

## Kontrak Rust dan tampilan

Modul baru `src-tauri/src/updater.rs` (perintah Tauri, semua async):

| Perintah | Hasil (camelCase) | Error (`AppError.code`) |
|---|---|---|
| `update_info` | `{ currentVersion: string, configured: boolean }` | tidak ada |
| `update_check` | `{ available: false, currentVersion }` atau `{ available: true, currentVersion, version, notes: string \| null, date: string \| null }` | `update_offline`, `update_not_configured`, `update_failed` |
| `update_download` (`onEvent: Channel<{ downloaded: number, total: number \| null }>`) | `{ version }` setelah unduhan selesai dan tanda tangan cocok | `update_offline`, `update_no_pending`, `update_bad_signature`, `update_failed` |
| `update_install` | tidak kembali di Windows (aplikasi keluar, installer membuka Mira lagi). Di Mac: `.app` diganti lalu `app.restart()` | `update_no_pending`, `update_failed` |

- `configured` false kalau `plugins.updater.pubkey` kosong atau placeholder (`BELUM-DIISI...`). Ini jaring pengaman; konfigurasi yang di-commit sudah memakai public key asli. `update_check` lalu langsung mengembalikan `update_not_configured` tanpa menghubungi internet.
- `update_offline`: galat koneksi, DNS, atau timeout dari reqwest (pesan: "Tidak bisa menghubungi GitHub. Coba lagi saat laptop tersambung ke internet.").
- 404 di semua endpoint dianggap `{ available: false }`.
- Timeout cek 20 detik. Unduhan tanpa batas waktu total, tapi dengan timeout sambung.
- Sebelum memasang: `AppNet::shutdown()` (pamit mDNS, tutup koneksi QUIC) dipanggil, juga lewat `on_before_exit` di Windows karena `std::process::exit(0)` melewati `RunEvent::Exit`.
- `MIRA_UPDATER_ENDPOINT` mengganti endpoint **hanya di build debug** (`cfg(debug_assertions)`). Build rilis mengabaikannya.
- Windows: `plugins.updater.windows.installMode = "quiet"` (installer per pengguna tidak butuh admin, jalan tanpa jendela). Installer membuka Mira lagi (`restart_after_install` bawaan true).
- Data pengguna (`%LOCALAPPDATA%\id.mira.desktop`, `~/Library/Application Support/id.mira.desktop`, kunci di Credential Manager atau Keychain) tidak disentuh: installer NSIS mode update hanya mengganti berkas program, dan di Mac hanya bundel `.app` yang diganti.

Pengaturan per laptop (tabel `settings` lewat `get_setting` dan `set_setting` yang sudah ada):

| Kunci | Nilai |
|---|---|
| `update.auto_check` | `on` (bawaan) atau `off` |
| `update.last_check` | waktu cek otomatis terakhir, ISO 8601 |
| `whats_new.seen` | versi terakhir yang "Yang baru"-nya sudah dilihat |

## Tampilan

- `src/api/updater.ts`: pembungkus perintah di atas.
- `src/updates/`: reducer status murni (`idle`, `checking`, `upToDate`, `available`, `downloading` dengan persen, `ready`, `installing`, `error` dengan jenis `offline`, `notConfigured`, `failed`) dan `UpdateProvider` (konteks). Cek otomatis saat Shell dibuka: kalau `update.auto_check` tidak `off` dan cek terakhir lebih dari 20 jam lalu. Cek otomatis diam saat gagal.
- `UpdateDot`: titik kecil di menu Pengaturan saat ada versi baru (teks tersembunyi untuk pembaca layar: "ada pembaruan").
- Pengaturan > "Tentang dan pembaruan" (`AboutSection`): versi sekarang, tombol "Cek pembaruan", status, "Perbarui sekarang", "Mulai ulang Mira", kotak centang "Cek pembaruan otomatis saat Mira dibuka", tombol "Lihat yang baru".
- Pesan offline tenang, bukan `ErrorAlert` merah.
- "Yang baru": catatan di `src/whats-new/<versi>.md` (Markdown sederhana: paragraf dan daftar `- `), dimuat dengan `import.meta.glob(..., { query: "?raw", eager: true })`. Dialog tampil sekali bila `whats_new.seen` lebih lama dari versi sekarang dan catatan untuk versi itu ada. Saat onboarding (instal baru), `whats_new.seen` langsung diisi versi sekarang supaya instal baru tidak disambut dialog. Laptop yang naik dari v0.2.x belum punya `whats_new.seen` tapi sudah punya organisasi, jadi dialog tampil.

## Alur rilis

- `src-tauri/tauri.updater.conf.json`: `{ "bundle": { "createUpdaterArtifacts": true } }`, dipakai workflow lewat `--config`. Build lokal biasa (`npm run build:installer`) tetap jalan tanpa kunci.
- Windows: artefak pembaruan adalah installer itu sendiri (`Mira_<v>_x64-setup.exe`, nama tidak berubah untuk `install.ps1`) plus `.sig`.
- Mac: `Mira.app.tar.gz` diunggah sebagai `Mira_<v>_universal.app.tar.gz` plus `.sig`. `darwin-aarch64` dan `darwin-x86_64` di `latest.json` menunjuk berkas yang sama (bundel universal).
- `scripts/release/make-latest-json.mjs`: membuat `latest.json` (versi, catatan dari `src/whats-new/<v>.md`, `pub_date`, URL `https://github.com/hartono0297/Mira/releases/download/v<v>/<aset>`, signature isi `.sig`).
- `scripts/release/verify-updater-sig.mjs`: memeriksa `.sig` terhadap public key (format minisign: Ed25519 atas BLAKE2b-512, plus tanda tangan komentar tepercaya), memakai `node:crypto` saja.
- Push tag: secret `TAURI_SIGNING_PRIVATE_KEY` wajib ada, pubkey di `tauri.conf.json` bukan placeholder, `src/whats-new/<v>.md` wajib ada, dan setiap `.sig` harus cocok dengan pubkey di `tauri.conf.json`. Kalau salah satu gagal, rilis berhenti.
- Push cabang biasa (uji): kunci sekali pakai dibuat di runner, artefak dibangun dan diperiksa dengan kunci itu, tidak ada rilis.
- Draft rilis dibuat tanpa `--prerelease`, catatan rilis dari berkas yang sama.

## Kunci tanda tangan updater (untuk session utama)

Status 23 November 2026: kunci asli **sudah dibuat** oleh session utama atas persetujuan user. Public key-nya (id minisign `571B5067CE93CF89`) sudah ada di `plugins.updater.pubkey` di `src-tauri/tauri.conf.json`. Kunci privat dan kata sandinya tersimpan sebagai secret GitHub `TAURI_SIGNING_PRIVATE_KEY` dan `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` di repo `hartono0297/Mira`. Cadangannya ada di folder `%USERPROFILE%\.mira-updater\` di laptop pemilik, bukan di repo. Uji lokal memakai kunci UJI lewat konfigurasi `--config` terpisah, bukan dengan mengganti pubkey asli.

Langkah di bawah dipakai kalau kunci perlu dibuat ulang (misalnya hilang atau bocor). Ingat: mengganti kunci berarti semua laptop harus memasang ulang Mira secara manual sekali.

1. Buat pasangan kunci di laptop pemelihara (bukan di repo), dengan kata sandi:

   ```powershell
   npx tauri signer generate -w "$env:USERPROFILE\.mira-updater\mira-updater.key"
   ```

   Hasilnya dua berkas: `mira-updater.key` (kunci privat, terenkripsi kata sandi) dan `mira-updater.key.pub` (public key).
2. Simpan kunci di `%USERPROFILE%\.mira-updater\` di laptop pemilik, dan cadangkan kunci privat serta kata sandinya di tempat kedua yang terpisah (misalnya pengelola kata sandi kantor atau flashdisk terenkripsi di laci terkunci). Kalau kunci ini hilang, laptop yang sudah terpasang **tidak bisa** menerima pembaruan otomatis lagi, dan semua orang harus memasang ulang secara manual.
3. Set secret di GitHub (Settings > Secrets and variables > Actions, repo `hartono0297/Mira`):
   - `TAURI_SIGNING_PRIVATE_KEY`: isi berkas `mira-updater.key` (teks satu baris base64).
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: kata sandinya.

   Atau lewat `gh`:

   ```powershell
   Get-Content "$env:USERPROFILE\.mira-updater\mira-updater.key" -Raw | gh secret set TAURI_SIGNING_PRIVATE_KEY --repo hartono0297/Mira
   gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo hartono0297/Mira
   ```
4. Ganti nilai `plugins.updater.pubkey` di `src-tauri/tauri.conf.json` dengan isi `mira-updater.key.pub` (satu baris base64, bukan path), commit, lalu rilis seperti biasa dengan tag `v0.3.0`.
5. Setelah draft rilis jadi, periksa asetnya: `Mira_0.3.0_x64-setup.exe`, `.sig`-nya, `Mira_0.3.0_universal.dmg`, `Mira_0.3.0_universal.app.tar.gz`, `.sig`-nya, berkas `.sha256`, dan `latest.json`. Terbitkan draft (bukan sebagai prerelease).

Jangan pernah meng-commit kunci privat. Jangan mengganti kunci setelah rilis pertama yang memakai updater, kecuali semua laptop siap dipasang ulang manual.

## Tugas

1. Rust: `updater.rs`, plugin, perintah, klasifikasi error, endpoint debug, tes unit. `cargo test`, `cargo clippy --all-targets` 0 peringatan.
2. Rilis: overlay konfigurasi, dua skrip Node dan tesnya, `release.yml`.
3. Tampilan: api, reducer, provider, `AboutSection`, `UpdateDot`, dialog Yang baru, catatan 0.3.0, tes Vitest untuk setiap status.
4. Uji ujung ke ujung lokal di Windows dengan kunci uji, produk uji terpisah (`productName` dan `identifier` lain supaya Mira asli di laptop ini tidak tersentuh), server lokal, dan `MIRA_DATA_DIR` di scratch.
5. Review keamanan tanda tangan dan endpoint.
6. CI di branch `updater`, laporan `docs/progress/updater.md`.
