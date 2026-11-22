# Mira

Aplikasi desktop Windows untuk kerja tim di satu kantor: chat, board task, dokumen, dan tanda tangan PDF. Mira bekerja langsung antar laptop di jaringan kantor, tanpa server, tanpa internet, dan tanpa login.

Status: Tahap 1 (Jaringan dan tim) selesai di uji satu PC. Lihat `docs/progress/tahap-1.md` dan `docs/progress/tahap-0.md`. Dokumen desain ada di `design/`.

## Kebutuhan

- Windows 10 atau 11, 64-bit
- Node.js 22 dan npm
- Rust stabil (MSVC) dan Build Tools Visual Studio

## Perintah

```
npm install
npm run tauri dev            # jalankan versi pengembangan
npm test                     # tes tampilan (Vitest)
cd src-tauri && cargo test   # tes inti Rust
npm run build:installer      # installer NSIS kecil (unduh WebView2 kalau belum ada)
npm run build:installer-offline  # installer NSIS dengan WebView2 offline (sekitar 290 MB)
npm run test:e2e             # uji ujung ke ujung terhadap src-tauri/target/release/mira.exe
npm run test:e2e-multi       # uji beberapa instance: bergabung, ditolak, dikeluarkan, menyusul
```

Installer ada di `src-tauri/target/release/bundle/nsis/`.

## Beberapa "laptop" di satu PC

Setel `MIRA_DATA_DIR` ke folder berbeda untuk setiap instance. Database, profil WebView2, dan judul jendela ikut terpisah:

```
$env:MIRA_DATA_DIR = "D:\mira-uji\laptop-a"; & "$env:LOCALAPPDATA\Mira\mira.exe"
```

Untuk menguji jaringan di satu PC, beri juga port berbeda (`MIRA_PORT`). `MIRA_DISABLE_MDNS=1` mematikan penemuan otomatis untuk menguji alamat manual, dan `MIRA_CLOCK_OFFSET_SECS` memajukan jam untuk menguji undangan kedaluwarsa.

Tanpa variabel itu, data disimpan di `%LOCALAPPDATA%\id.mira.desktop`. Kunci privat laptop disimpan di Windows Credential Manager dengan nama `device-key-<kunci publik>.id.mira.desktop`.

## Struktur

```
src/                tampilan React + TypeScript (tema, layar, pembungkus API)
src-tauri/src/      inti Rust (identitas, database, organisasi, pengaturan, command)
src-tauri/nsis/     teks installer bahasa Indonesia
scripts/            uji ujung ke ujung
docs/plans/         rencana per tahap
docs/progress/      laporan per tahap
```
