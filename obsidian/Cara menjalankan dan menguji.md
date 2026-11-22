---
tags: [mira, pengembangan, uji]
---

# Cara menjalankan dan menguji

## Kebutuhan

- Windows 10 atau 11, 64-bit
- Node.js 22 dan npm
- Rust stabil (MSVC) dan Build Tools Visual Studio

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

Hasil terakhir pada kode gabungan di branch `integrasi-fitur`: 781 tes Rust dan 499 tes tampilan lulus, clippy bersih.

## Build

```
npx tauri build --no-bundle            # exe release: src-tauri/target/release/mira.exe
npx tauri build --debug --no-bundle    # exe debug: src-tauri/target/debug/mira.exe
npm run build:installer                # installer NSIS kecil
npm run build:installer-offline        # installer dengan WebView2 offline
```

Installer ada di `src-tauri/target/release/bundle/nsis/`.

## Uji ujung ke ujung

Skrip di `scripts/` menjalankan `mira.exe` sungguhan dan mengendalikan WebView2 lewat DevTools Protocol (`playwright-core`). Setiap skrip memakai folder data sementara dan menghapus folder serta kunci uji buatannya di akhir. Screenshot masuk ke `docs/progress/screenshots/`.

| Perintah | Build | Isi |
|---|---|---|
| `npm run test:e2e` | release | Alur dasar: nama, organisasi, tema, restart |
| `npm run test:e2e-multi` | release | Empat instance: bergabung, kode ditolak, dikeluarkan, menyusul (25 pemeriksaan) |
| `npm run test:e2e-fitur-multi` | release | Tiga instance lewat jaringan sungguhan: chat, titipan, board, lampiran (20 pemeriksaan) |
| `npm run test:e2e:docs` | debug | Dokumen: tambah, edit, versi, pulihkan |
| `npm run test:e2e-ttd` | debug | Tanda tangan PDF |
| `npm run test:e2e-chat` | debug | Chat di satu laptop |
| `node scripts/board-e2e.mjs <exe> <folder screenshot>` | debug | Board di satu laptop |
| `node scripts/board-sync-e2e.mjs <exe> <folder screenshot>` | release atau debug | Fondasi sinkron board di satu laptop |

`test:e2e-fitur-multi` menjalankan tiga laptop: A dan B di tim yang sama, C di tim lain. Isinya: pesan #umum, channel tim yang tidak sampai ke C, chat pribadi dengan status Dibaca, titipan saat B mati dan A juga mati, hapus pesan, proyek dan task yang sampai ke B tapi tidak ke C, pindah kolom, dan lampiran lewat dialog Windows. Hasil terakhir 20/20.

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

Lihat juga: [[Belum diuji]], [[Arsitektur]]. Kembali ke [[Beranda]].
