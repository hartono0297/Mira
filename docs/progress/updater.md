# Laporan: cek pembaruan dan "Yang baru"

Tanggal: 23 November 2026. Branch lokal `claude/updater-8a630b`, didorong ke origin sebagai `updater`. Rencana: [docs/plans/updater.md](../plans/updater.md).

## Yang dibuat

**Di aplikasi**
- Pengaturan punya bagian baru, "Tentang dan pembaruan". Isinya versi yang terpasang, tombol "Cek pembaruan", status, tombol "Perbarui sekarang" dengan persen unduhan, lalu "Mulai ulang Mira".
- Mira mengecek pembaruan sendiri saat dibuka, paling sering sekali dalam 20 jam. Cek otomatis bisa dimatikan per laptop. Kalau ada versi baru, menu Pengaturan diberi titik kecil, tanpa jendela yang menyela. Kalau cek otomatis gagal, Mira diam saja.
- Kalau laptop tidak tersambung internet, Mira menulis "Tidak bisa menghubungi GitHub. Coba lagi saat laptop tersambung ke internet." dengan teks biasa, tanpa kotak error merah.
- Dialog "Yang baru di Mira <versi>" tampil sekali setelah Mira diperbarui. Laptop yang baru memasang Mira tidak melihatnya, dan dialog bisa dibuka lagi dari Pengaturan ("Lihat yang baru"). Catatannya ada di `src/whats-new/<versi>.md` dan ikut dibundel, jadi tetap tampil tanpa internet.
- Sebelum memasang, Mira menutup jaringan dengan rapi (pamit mDNS, koneksi QUIC ditutup). Di Windows installer NSIS per pengguna jalan diam-diam (`installMode: quiet`), lalu membuka Mira lagi. Di Mac `.app` diganti, lalu Mira memulai ulang dirinya. Folder data dan kunci laptop tidak disentuh.

**Di Rust** (`src-tauri/src/updater.rs`): perintah `update_info`, `update_check`, `update_download` (progres lewat Channel), dan `update_install`, memakai `tauri-plugin-updater` 2.14.1. `tauri-plugin-process` tidak dipakai, karena `AppHandle::restart()` sudah cukup. Error dipetakan ke kode `update_offline`, `update_not_configured`, `update_no_pending`, `update_bad_signature`, dan `update_failed`. Tipe errornya ada di modul sendiri, jadi `error.rs` tidak berubah. `MIRA_UPDATER_ENDPOINT` hanya ada di build debug.

**Di alur rilis** (`release.yml`, `scripts/release/`)
- `tauri build` berjalan tanpa kunci. Installer Windows dan `Mira_<v>_universal.app.tar.gz` ditandatangani sesudahnya, di langkah terpisah yang hanya menjalankan `tauri signer sign --app-version <v>`.
- Setiap `.sig` diperiksa terhadap public key di `tauri.conf.json` oleh `verify-updater-sig.mjs`, yang hanya memakai `node:crypto`.
- `latest.json` dibuat dari catatan `src/whats-new/<v>.md`. Catatan yang sama jadi teks draft rilis.
- Draft rilis dibuat sebagai rilis biasa, bukan prerelease.
- Nama installer pertama tidak berubah (`Mira_<v>_x64-setup.exe`, `Mira_<v>_universal.dmg`), jadi `install.ps1` dan `install.sh` tetap jalan.
- Build dari cabang biasa memakai kunci sekali pakai yang dibuat di runner. Kunci asli hanya dipakai untuk tag `v*` atau publish manual dari `main`.

**Perubahan di berkas bersama** (titik merge)
- `src/screens/shell/Shell.tsx`: 2 baris, yaitu import dan `{id === "settings" && <UpdateDot />}`.
- `src/App.tsx`: `<UpdateProvider>` dan `<WhatsNewDialog />` di sekitar `<Shell>`, plus `<MarkWhatsNewSeen />` di cabang onboarding. Onboarding sendiri tidak diubah.
- `src/screens/settings/SettingsScreen.tsx`: bagian `about`.
- `src-tauri/src/lib.rs`: `pub mod updater;`, satu baris plugin, satu `app.manage`, dan 4 perintah.
- `Cargo.toml`: satu dependensi. `package.json`: tidak berubah. `tauri.conf.json`: satu blok `plugins.updater`.

## Pilihan endpoint

Endpointnya `https://github.com/hartono0297/Mira/releases/latest/download/latest.json`. GitHub mengarahkan `/releases/latest/` ke rilis terbaru yang bukan draft dan bukan prerelease. Karena itu mulai v0.3.0 workflow membuat draft rilis biasa. Laptop kantor baru melihat versi baru setelah draft diterbitkan, jadi draft tetap jadi tempat memeriksa installer.

v0.1.0 dan v0.2.0 adalah prerelease dan belum punya updater, jadi tidak ada yang hilang. Selama rilis terbaru belum punya `latest.json`, GitHub membalas 404 dan Mira menampilkan "Mira sudah versi terbaru". Itu benar, karena memang belum ada pembaruan yang bisa dipasang.

Endpoint API GitHub tidak dipakai karena batasnya 60 permintaan per jam per IP, dan satu kantor biasanya keluar lewat satu IP.

## Kunci tanda tangan

Session utama sudah membuat kunci asli atas persetujuan user.
- Public key-nya (id minisign `571B5067CE93CF89`) ada di `plugins.updater.pubkey`.
- Kunci privat dan kata sandinya tersimpan sebagai secret `TAURI_SIGNING_PRIVATE_KEY` dan `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Cadangannya ada di `%USERPROFILE%\.mira-updater\` di laptop pemilik.

Sesi ini tidak menyentuh secret dan tidak meng-commit kunci apa pun. Uji lokal memakai kunci UJI di folder scratch lewat `--config` terpisah. Langkah membuat ulang kunci ada di rencana, bagian "Kunci tanda tangan updater".

`requireSignedVersion: true` aktif. Jadi `latest.json` yang dipalsukan tidak bisa menempelkan nomor versi baru ke paket lama yang tanda tangannya sah.

## Hasil uji

- `cargo test`: 889 lulus, 7 diabaikan, termasuk 12 tes baru di `updater`. `cargo clippy --all-targets -- -D warnings`: 0 peringatan.
- `npx vitest run --pool=threads`: 43 berkas, 624 tes lulus. `npx tsc --noEmit`: bersih.
- `node --test "scripts/release/*.test.mjs"`: 18 tes lulus. Salah satunya memeriksa tanda tangan asli buatan `tauri signer`.
- CI di branch `updater`: hijau di Windows dan macOS (run 45120624634, commit 5c48547). Workflow Rilis untuk commit yang sama juga hijau (run 45120624567). Kedua build menandatangani artefak pembaruan dengan kunci sekali pakai dan lolos pemeriksaan tanda tangan beserta versinya. Di Mac, `.app.tar.gz` dibongkar ulang dan lolos `codesign --verify` dan `lipo`. Job draft rilis dilewati, sesuai harapan untuk build cabang.

**Uji ujung ke ujung di Windows** (laptop ini, 21 dari 21 pemeriksaan lulus). Versi lama 0.2.90 dan versi baru 0.3.0 dibangun sebagai build debug dengan kunci UJI. Nama produk dan identifier-nya dibuat terpisah (`MiraUjiPembaruan`), supaya Mira asli tidak tersentuh. `latest.json` disajikan dari server lokal lewat `MIRA_UPDATER_ENDPOINT`.
- Installer lama terpasang diam-diam per pengguna. Pengaturan menampilkan "Mira 0.2.90".
- Cek menemukan 0.3.0 beserta catatannya, dan titik muncul di menu Pengaturan (dibaca "Pengaturan, ada pembaruan").
- Unduhan 12,4 MB naik dari 0 sampai 100 persen, lalu "siap dipasang".
- Setelah "Mulai ulang Mira", Mira lama tertutup dalam 4,2 detik. Installer membuka Mira baru sendiri 11,8 detik setelah klik.
- Dialog "Yang baru di Mira 0.3.0" tampil sekali. Pengaturan menampilkan 0.3.0, nama dan organisasi masih ada. Setelah dibuka ulang, dialog tidak tampil lagi, dan cek berikutnya menjawab "Mira sudah versi terbaru."
- Tanpa koneksi, pesan offline tampil tenang tanpa `role="alert"`.
- Dua `latest.json` yang dirusak (tanda tangan milik berkas lain) berakhir dengan "Berkas pembaruan tidak cocok dengan tanda tangan Mira, jadi tidak dipasang." Tidak ada yang terpasang.
- Pembersihan: produk uji di-uninstall, folder dan entri registry-nya hilang, entri Credential Manager buatan uji dihapus.

Screenshot: [screenshots/updater/](screenshots/updater/).

## Review keamanan

Reviewer tidak menemukan jalan untuk memasang paket yang tidak bertanda tangan, salah tanda tangan, atau versi lebih lama. Plugin memeriksa tanda tangan saat unduh dan lagi saat pasang. Temuan di workflow sudah diperbaiki:
- Token workflow sekarang baca saja, dan `contents: write` hanya ada di job `release`. Checkout tidak menyimpan kredensial.
- Kunci asli tidak lagi ada di lingkungan `tauri build`, hanya di langkah `tauri signer sign`.
- Publish manual hanya dari `main`, dan aset rilis yang sudah terbit tidak pernah ditimpa.
- `verify-updater-sig.mjs` menolak kolom `version` ganda.

## Belum diuji

- **Pembaruan di Mac sungguhan belum diuji.** CI macOS membangun `.app.tar.gz`, menandatanganinya dengan kunci sekali pakai, memeriksa tanda tangannya, membongkarnya seperti updater, dan menjalankan `codesign --verify`. Penggantian `.app` dan restart di MacBook asli belum pernah dicoba. Hal yang perlu dicek di Mac: Mira terpasang di `/Applications` oleh user biasa, pembaruan tidak memicu peringatan Gatekeeper baru (bundel ad-hoc, tanpa notarisasi), dan izin Jaringan lokal tetap berlaku setelah `.app` diganti.
- Rilis sungguhan dengan kunci asli belum pernah jalan. Rilis v0.3.0 nanti adalah uji pertamanya.
- Unduhan lewat GitHub sungguhan (redirect ke `objects.githubusercontent.com`) belum diuji. Uji lokal memakai server http di 127.0.0.1.
- Uji ujung ke ujung memakai build debug, karena hanya build debug yang membaca `MIRA_UPDATER_ENDPOINT`. Installer rilis memakai kode updater yang sama.

## Untuk session utama

1. Naikkan versi ke 0.3.0 di `tauri.conf.json`, `Cargo.toml`, dan `package.json` saat rilis. Sesi ini tidak mengubah versi.
2. Rapikan `src/whats-new/0.3.0.md`, terutama bagian "Sedang dikerjakan": pindahkan fitur v0.3 yang sudah selesai ke "Baru". Berkas yang sama jadi isi dialog, catatan `latest.json`, dan teks draft rilis. Format yang didukung hanya paragraf, `## ` judul, dan daftar `- `.
3. Setelah draft v0.3.0 jadi, periksa asetnya: installer `.exe` dan `.sig`-nya, `.dmg`, `.app.tar.gz` dan `.sig`-nya, berkas `.sha256`, dan `latest.json`. Lalu terbitkan sebagai rilis biasa, bukan prerelease.
4. Saran keamanan yang belum dikerjakan, karena butuh pengaturan repo:
   - Pindahkan kedua secret ke GitHub Environment (misalnya `rilis`) yang hanya untuk tag `v*` dan butuh persetujuan, lalu tambahkan `environment: rilis` ke job build.
   - Pin `dtolnay/rust-toolchain` dan `Swatinem/rust-cache` ke SHA commit.
5. Risiko kecil yang dibiarkan: unduhan pembaruan tidak punya batas ukuran (plugin menampung seluruh berkas di memori sebelum memeriksa tanda tangan). Ini baru jadi masalah kalau GitHub atau TLS sudah dibobol.
