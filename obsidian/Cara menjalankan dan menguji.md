---
tags: [mira, pengembangan, uji]
---

# Cara menjalankan dan menguji

## Kebutuhan

- Windows 10 atau 11, 64-bit
- Node.js 22 dan npm
- Rust stabil (MSVC) dan Build Tools Visual Studio

Langkah di catatan ini ditulis untuk PC Windows. Build dan tes macOS berjalan di GitHub Actions, lihat [[#GitHub Actions]] di bawah dan [[macOS]].

## Menjalankan

```
npm install
npx tauri dev
```

`npx tauri dev` menjalankan Vite (`npm run dev`, port 1420) lalu membuka jendela Mira.

## Tes otomatis

```
npm test                                   # Vitest, tes tampilan
cd src-tauri; cargo test                   # tes inti Rust
cd src-tauri; cargo clippy --all-targets   # lint Rust
```

Beberapa tes Rust sengaja diabaikan karena butuh keyring, firewall, atau mDNS sungguhan. Saat mesin sibuk build Rust, worker Vitest kadang gagal mulai; laporan tahap menjalankan ulang dengan `--maxWorkers=1`.

Hasil terakhir pada kode gabungan (branch `integrasi-dokumen`), di satu PC:
- `cargo test`: 861 lulus, 0 gagal, 7 diabaikan.
- `cargo clippy`: 0 peringatan.
- `tsc`: bersih.
- Vitest: 37 file, 557 tes lulus.

## Build

```
npx tauri build --no-bundle            # exe release: src-tauri/target/release/mira.exe
npx tauri build --debug --no-bundle    # exe debug: src-tauri/target/debug/mira.exe
npm run build:installer                # installer NSIS kecil
npm run build:installer-offline        # installer dengan WebView2 offline
```

Installer ada di `src-tauri/target/release/bundle/nsis/`.

## GitHub Actions

Tes otomatis berjalan di GitHub Actions pada runner macOS dan Windows. Installer macOS (`.dmg`) juga dibuat di sana. Lulus di Actions belum berarti lulus di MacBook sungguhan di jaringan kantor, lihat [[Belum diuji]].

## Skrip pasang satu baris

- Windows: [install.ps1](../install.ps1). Uji tanpa memasang dengan `$env:MIRA_INSTALL_DRY_RUN = "1"` sebelum menjalankan perintah `irm ... | iex`.
- macOS: [install.sh](../install.sh). Uji tanpa memasang dengan `curl -fsSL https://raw.githubusercontent.com/hartono0297/Mira/main/install.sh | MIRA_INSTALL_DRY_RUN=1 bash`.

`install.sh` bisa di-`source` tanpa menjalankan pemasangan, jadi fungsi pembaca daftar rilis dan pemilih file bisa diuji sendiri, juga di Git Bash. Yang sudah dan belum diuji ada di [[macOS]].

## Uji ujung ke ujung

Skrip di `scripts/` menjalankan `mira.exe` sungguhan dan mengendalikan WebView2 lewat DevTools Protocol (`playwright-core`). Setiap skrip memakai folder data sementara dan menghapus folder serta kunci uji buatannya di akhir. Screenshot masuk ke `docs/progress/screenshots/`.

| Perintah | Build | Isi |
|---|---|---|
| `npm run test:e2e` | release | Alur dasar: nama, organisasi, tema, restart |
| `npm run test:e2e-multi` | release | Empat instance: bergabung, kode ditolak, dikeluarkan, menyusul (25 pemeriksaan) |
| `npm run test:e2e-fitur-multi` | release | Tiga instance lewat jaringan sungguhan: chat, titipan, board, lampiran (20 pemeriksaan) |
| `npm run test:e2e-sync` | release | Tiga instance lewat jaringan sungguhan: dokumen dan tanda tangan (37 pemeriksaan) |
| `npm run test:e2e:docs` | debug | Dokumen: tambah, edit, versi, pulihkan |
| `npm run test:e2e-ttd` | debug | Tanda tangan PDF |
| `npm run test:e2e-chat` | debug | Chat di satu laptop |
| `node scripts/board-e2e.mjs <exe> <folder screenshot>` | debug | Board di satu laptop |
| `node scripts/board-sync-e2e.mjs <exe> <folder screenshot>` | release atau debug | Fondasi sinkron board di satu laptop |

`test:e2e-fitur-multi` menjalankan tiga laptop: A dan B di tim yang sama, C di tim lain. Isinya: pesan #umum, channel tim yang tidak sampai ke C, chat pribadi dengan status Dibaca, titipan saat B mati dan A juga mati, hapus pesan, proyek dan task yang sampai ke B tapi tidak ke C, pindah kolom, dan lampiran lewat dialog Windows. Hasil terakhir 20/20.

`test:e2e-sync` juga menjalankan tiga laptop. Isinya: dokumen yang muncul di laptop rekan dengan isi sama persis sampai ke byte, versi baru, tanda "Sedang diedit", bentrok offline yang tampil di kedua laptop, file 21 MB yang tidak disalin otomatis lalu diunduh saat diklik, permintaan tanda tangan berurutan B lalu A, versi yang diubah diam-diam ditolak, jejak audit sah di kedua laptop, anggota yang tidak terlibat tidak menerima permintaan, dan anggota yang dikeluarkan tidak menerima dokumen baru. Hasil terakhir 37/37.

Hasil terakhir semua skrip pada build release dari kode gabungan:

| Skrip | Hasil |
|---|---|
| `smoke-e2e` | 11/11 |
| `board-e2e` | 11/11 |
| `board-sync-e2e` | 23/23 |
| `chat-e2e` | 19/19 |
| `smoke-docs-e2e` | 15/15 |
| `sign-e2e` | 15/15 |
| `e2e-multi` | 25/25 |
| `e2e-fitur-multi` | 20/20 |
| `sync-e2e` | 37/37 |

## Beberapa laptop di satu PC

Setiap instance butuh folder data dan port sendiri:

```
$env:MIRA_DATA_DIR = "D:\mira-uji\laptop-a"; $env:MIRA_PORT = "47801"; & ".\src-tauri\target\release\mira.exe"
$env:MIRA_DATA_DIR = "D:\mira-uji\laptop-b"; $env:MIRA_PORT = "47802"; & ".\src-tauri\target\release\mira.exe"
$env:MIRA_DATA_DIR = "D:\mira-uji\laptop-c"; $env:MIRA_PORT = "47803"; & ".\src-tauri\target\release\mira.exe"
```

Langkah manual:
1. Di A: buat organisasi, buat tim di menu Organisasi, lalu "Undang ke tim".
2. Di B dan C: "Gabung dengan kode". Kalau penemuan otomatis gagal, isi alamat `127.0.0.1:47801`.
3. Untuk menguji alamat manual saja, tambahkan `$env:MIRA_DISABLE_MDNS = "1"`.
4. Untuk menguji undangan kedaluwarsa, jalankan ulang A dengan `$env:MIRA_CLOCK_OFFSET_SECS = "90000"`.

Variabel lain: `MIRA_EXPORT_DIR` (folder salinan PDF bertanda tangan), `MIRA_TEST_NO_LAUNCH=1` (Edit tanpa membuka Office), `MIRA_E2E_REAL_EXCEL=1` (uji dokumen dengan Excel asli).

## Mengulang dari awal

Hapus folder data dan entri `device-key-...id.mira.desktop` di Credential Manager (Panel Kontrol > Pengelola Kredensial > Kredensial Windows). Tanpa `MIRA_DATA_DIR`, folder datanya `%LOCALAPPDATA%\id.mira.desktop`.

Di Mac, folder datanya `~/Library/Application Support/id.mira.desktop` dan kuncinya ada di Keychain dengan nama layanan `id.mira.desktop`.

Lihat juga: [[Belum diuji]], [[Arsitektur]], [[macOS]]. Kembali ke [[Beranda]].
