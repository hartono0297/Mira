# Mira

Mira adalah aplikasi desktop Windows untuk kerja tim di satu kantor berisi sekitar 10 sampai 30 orang. Di dalamnya ada chat, board task per proyek, dokumen Word dan Excel yang diedit di Microsoft Office dengan riwayat versi, dan tanda tangan PDF visual. Mira bekerja langsung antar laptop di jaringan kantor, tanpa server, tanpa internet, dan tanpa login.

Dibangun dengan Tauri 2, React 19, TypeScript, dan Vite. Data, jaringan, dan keamanan ditangani inti Rust.

Catatan proyek yang lebih lengkap ada di vault Obsidian: [`obsidian/Beranda.md`](obsidian/Beranda.md). Dokumen desain ada di [`design/`](design/), terutama [`prd-mira.html`](design/prd-mira.html) dan [`rencana-pembangunan.html`](design/rencana-pembangunan.html).

## Fitur yang sudah ada

### Chat

- Channel #umum, channel tim, channel proyek, dan chat pribadi.
- Balas, mention, lampiran, hapus pesan (menyisakan "Pesan dihapus"), arsip dan hapus channel.
- Status pesan: Menunggu, Dititipkan, Diterima laptopnya, Dibaca.
- Titipan untuk rekan yang laptopnya mati: pesan disegel untuk penerima dan dipegang laptop lain yang online. Laptop perantara tidak bisa membaca isinya.
- Lampiran sampai sekitar 20 MB diunduh otomatis oleh anggota percakapan. File yang lebih besar diunduh saat diklik.
- Notifikasi Windows, diatur per orang dan per percakapan.

### Board

- Satu board per proyek dengan kolom To do, Dikerjakan, Selesai, dan kode task seperti PA-12.
- Task berisi judul, deskripsi, penanggung jawab, tenggat, prioritas, label, komentar, dan riwayat aktivitas.
- Task dipindah dengan seret mouse, menu Pindahkan, atau Alt+Panah.
- Halaman "Task saya" dan pengingat tenggat lewat notifikasi Windows.
- Perubahan dari beberapa laptop digabung dengan Automerge. Data proyek hanya dikirim ke anggota tim pemilik proyek dan Tamu yang diundang ke proyek itu.

### Dokumen

- Tambah file, Edit di Word atau Excel, tanda "Sedang diedit", versi baru setiap kali file disimpan, riwayat versi, dan pulihkan.
- Dokumen, versi baru, dan tanda "Sedang diedit" sampai ke laptop rekan yang berhak melihatnya.
- File sampai 20 MB disalin otomatis ke laptop rekan. File yang lebih besar diunduh lewat tombol "Unduh dari rekan".
- Kalau dua laptop menyimpan versi saat offline, kedua versi disimpan berdampingan dan tampil sebagai bentrok di kedua laptop.
- Layar Dokumen baru bisa menambah file ke Pustaka Umum, belum ke proyek atau tim tertentu.

### Tanda tangan PDF

- Tanda tangan digambar atau diimpor, disimpan terenkripsi, dan hanya bisa dipakai dengan PIN 6 sampai 12 angka.
- Kotak tanda tangan ditempatkan dengan mouse atau keyboard. Penanda tangan terakhir menambahkan halaman catatan.
- Hasilnya dikunci. Kalau satu karakter berubah, Mira langsung memberi peringatan.
- Permintaan tanda tangan berurutan atau bebas. Tamu boleh menandatangani, tapi tidak bisa meminta tanda tangan.
- Permintaan, versi bertanda tangan, dan pembatalan sampai ke laptop rekan yang terlibat. Urutan penanda tangan dijaga di semua laptop, dan penanda tangan mendapat notifikasi saat gilirannya tiba.
- Stempel setiap penanda tangan ditambahkan sebagai incremental update PDF. Versi yang mengubah isi selain stempel ditolak di semua laptop (`version_changes_content`).

### Organisasi dan jaringan

- Satu organisasi untuk seluruh kantor, dibagi per tim, dengan peran Superadmin, Admin tim, Anggota, dan Tamu.
- Bergabung lewat kode undangan yang berlaku 24 jam, 7 hari, atau sekali pakai.
- Rekan ditemukan lewat mDNS, alamat manual, QR, atau alamat terakhir yang diingat.
- Status koneksi (LAN, VPN, atau tidak tersambung) dan panduan Windows Firewall.

### Tampilan

Tema Bata dengan mode Terang, Gelap, dan Ikuti Windows. Seluruh antarmuka berbahasa Indonesia.

## Prinsip: hanya LAN

- Tidak ada server, relay, cloud, akun, atau login. Identitas adalah kunci Ed25519 unik setiap laptop ditambah nama tampilan.
- Laptop tersambung langsung satu sama lain lewat QUIC terenkripsi. Hanya anggota aktif organisasi yang diterima.
- Dari luar kantor, laptop tersambung lewat VPN kantor.
- Setiap laptop hanya menerima data yang boleh ia lihat.
- Huruf, ikon, dan semua aset dibundel. Aplikasi tidak memuat apa pun dari internet saat berjalan.

## Status per tahap

| Tahap | Isi | Status | Laporan |
|---|---|---|---|
| 0 | Fondasi | Selesai | [tahap-0.md](docs/progress/tahap-0.md) |
| 1 | Jaringan dan tim | Selesai | [tahap-1.md](docs/progress/tahap-1.md) |
| 2 | Chat dasar | Selesai | [tahap-2.md](docs/progress/tahap-2.md) |
| 3 | Board dasar | Selesai, termasuk sinkron antar laptop dan Tamu per proyek | [tahap-3-lokal.md](docs/progress/tahap-3-lokal.md), [sinkron-board.md](docs/progress/sinkron-board.md) |
| 4 | Dokumen dan edit file | Selesai, termasuk sinkron antar laptop. Layar Dokumen baru bisa menambah file ke Pustaka Umum. | [tahap-4-lokal.md](docs/progress/tahap-4-lokal.md), [sinkron-dokumen-ttd.md](docs/progress/sinkron-dokumen-ttd.md) |
| 5 | Tanda tangan PDF | Tanda tangan dan sinkron antar laptop selesai. Komentar, stabilo, dan kotak teks di PDF belum dibuat. | [tahap-5-lokal.md](docs/progress/tahap-5-lokal.md), [sinkron-dokumen-ttd.md](docs/progress/sinkron-dokumen-ttd.md) |
| 6 | Fitur lengkap | Belum dimulai. Prioritas dan label board sudah ada sejak Tahap 3. | |
| 7 | Uji coba kantor | Belum dimulai | |

Pekerjaan lintas tahap:
- Transport sinkron fitur (chat, board, dokumen, tanda tangan di atas koneksi Tahap 1): selesai. Laporan: [transport-fitur.md](docs/progress/transport-fitur.md).
- Sinkron dokumen dan tanda tangan antar laptop: selesai dan sudah digabung, berjalan di atas transport fitur yang asli. Jembatan khusus uji sudah dihapus. Laporan: [sinkron-dokumen-ttd.md](docs/progress/sinkron-dokumen-ttd.md).
- Penggabungan bagian lokal Tahap 3, 4, dan 5: [integrasi-tahap-3-4-5.md](docs/progress/integrasi-tahap-3-4-5.md). Penggabungan sinkron dokumen dan tanda tangan: [integrasi-dokumen.md](docs/progress/integrasi-dokumen.md).
- Rencana setiap tahap ada di [`docs/plans/`](docs/plans/).

Pemeriksaan akhir pada kode gabungan (branch `integrasi-dokumen`), semuanya di satu PC:
- `cargo test`: 861 lulus, 0 gagal, 7 diabaikan. `cargo clippy` tanpa peringatan. `tsc` bersih.
- Vitest: 557 tes di 37 file lulus.
- Uji ujung ke ujung pada build release, semuanya lulus: `smoke-e2e` 11/11, `board-e2e` 11/11, `board-sync-e2e` 23/23, `chat-e2e` 19/19, `smoke-docs-e2e` 15/15, `sign-e2e` 15/15, `e2e-multi` 25/25, `e2e-fitur-multi` 20/20 (chat dan board, tiga instance), dan `sync-e2e` 37/37 (dokumen dan tanda tangan, tiga instance).
- `sync-e2e` memeriksa: dokumen muncul di laptop rekan dengan isi yang sama persis sampai ke byte, versi baru, tanda "Sedang diedit", bentrok offline yang tampil di kedua laptop, file 21 MB yang tidak disalin otomatis lalu diunduh saat diklik, permintaan tanda tangan berurutan B lalu A, versi yang diubah diam-diam ditolak, jejak audit sah di kedua laptop, anggota yang tidak terlibat tidak menerima permintaan, dan anggota yang dikeluarkan tidak menerima dokumen baru.
- Lihat [Belum diuji](#belum-diuji).

## Rilis

`v0.1.0` adalah rilis pertama Mira: build internal untuk uji coba, belum untuk dipakai seluruh kantor. Isinya semua yang ada di [Fitur yang sudah ada](#fitur-yang-sudah-ada), termasuk sinkron dokumen dan tanda tangan antar laptop. Installer `Mira_0.1.0_x64-setup.exe` (NSIS, 7,86 MB) ada di [halaman Releases](../../releases) repositori `Mira` di GitHub. Repositori ini privat dan dulu bernama ChatCompany; folder lokalnya masih bernama ChatCompany.

## Memasang

1. Unduh `Mira_0.1.0_x64-setup.exe` (installer NSIS, 7,86 MB) dari rilis `v0.1.0` di [halaman Releases](../../releases). Repositorinya privat, jadi butuh akses ke repositori.
2. Jalankan installer. Installer terpasang per pengguna di `%LOCALAPPDATA%\Mira`, jadi tidak butuh hak admin.
3. Kalau WebView2 belum ada, installer mengunduhnya. Untuk laptop tanpa WebView2 dan tanpa internet, buat varian offline dengan `npm run build:installer-offline` (sekitar 286 MB).
4. Installer belum ditandatangani dengan sertifikat penandatanganan kode, jadi Windows SmartScreen bisa memberi peringatan saat memasang.
5. Saat pertama dibuka: isi nama, pilih "Buat organisasi baru" atau "Gabung dengan kode", lalu ikuti panduan firewall.

Data disimpan di `%LOCALAPPDATA%\id.mira.desktop`. Kunci privat laptop ada di Windows Credential Manager dengan nama `device-key-<kunci publik>.id.mira.desktop`.

## Pengembangan

Kebutuhan:
- Windows 10 atau 11, 64-bit
- Node.js 22 dan npm
- Rust stabil (MSVC) dan Build Tools Visual Studio

Menjalankan versi pengembangan:

```
npm install
npx tauri dev
```

Tes:

```
npm test                                   # tes tampilan (Vitest)
cd src-tauri; cargo test                   # tes inti Rust
cd src-tauri; cargo clippy --all-targets   # lint Rust
```

Build:

```
npx tauri build --no-bundle            # exe release, dipakai uji release
npx tauri build --debug --no-bundle    # exe debug, dipakai uji debug
npm run build:installer                # installer NSIS kecil
npm run build:installer-offline        # installer NSIS dengan WebView2 offline
```

Installer hasil build ada di `src-tauri/target/release/bundle/nsis/`.

### Uji ujung ke ujung

Skrip menjalankan `mira.exe` sungguhan dan mengendalikannya lewat DevTools Protocol (`playwright-core`). Setiap skrip memakai folder data sementara, lalu menghapus folder itu dan kunci uji yang dibuatnya di Credential Manager.

| Perintah | Build | Isi |
|---|---|---|
| `npm run test:e2e` | release | Alur dasar: isi nama, buat organisasi, tema, restart |
| `npm run test:e2e-multi` | release | Empat instance: bergabung, kode ditolak, dikeluarkan, menyusul |
| `npm run test:e2e-fitur-multi` | release | Tiga instance lewat jaringan sungguhan: chat, titipan, board, lampiran |
| `npm run test:e2e-sync` | release | Tiga instance lewat jaringan sungguhan: dokumen, file besar, bentrok, tanda tangan berurutan, batas akses |
| `npm run test:e2e:docs` | debug | Dokumen: tambah, edit, versi, pulihkan, restart |
| `npm run test:e2e-ttd` | debug | Tanda tangan: gambar, tempatkan, PIN, kunci, deteksi perubahan |
| `npm run test:e2e-chat` | debug | Chat di satu laptop |

Dua skrip board belum punya perintah npm: `node scripts/board-e2e.mjs <mira.exe> <folder screenshot>` dan `node scripts/board-sync-e2e.mjs <mira.exe> <folder screenshot>`.

### Beberapa "laptop" di satu PC

Beri setiap instance folder data dan port sendiri. Database, profil WebView2, dan judul jendela ikut terpisah.

```
$env:MIRA_DATA_DIR = "D:\mira-uji\laptop-a"; $env:MIRA_PORT = "47801"; & ".\src-tauri\target\release\mira.exe"
$env:MIRA_DATA_DIR = "D:\mira-uji\laptop-b"; $env:MIRA_PORT = "47802"; & ".\src-tauri\target\release\mira.exe"
```

| Variabel | Gunanya |
|---|---|
| `MIRA_DATA_DIR` | Folder data instance ini |
| `MIRA_PORT` | Port QUIC. Tanpa variabel ini Mira memakai UDP 47800 sampai 47809. |
| `MIRA_DISABLE_MDNS=1` | Mematikan penemuan otomatis untuk menguji alamat manual |
| `MIRA_CLOCK_OFFSET_SECS` | Memajukan jam untuk menguji undangan kedaluwarsa |
| `MIRA_EXPORT_DIR` | Folder salinan PDF bertanda tangan (bawaan: Unduhan) |
| `MIRA_TEST_NO_LAUNCH=1` | "Edit" menyiapkan salinan kerja tanpa membuka Office |
| `MIRA_E2E_REAL_EXCEL=1` | Uji dokumen memakai Excel asli (butuh Office berlisensi) |

Untuk mengulang dari awal, hapus folder data dan entri `device-key-...id.mira.desktop` di Credential Manager.

## Struktur proyek

```
src/                 tampilan React + TypeScript
  screens/           layar: board, chat, docs, onboarding, org, settings, shell, sign
  components/        komponen bersama, termasuk penampil PDF
  api/               pembungkus command Tauri
  theme/             token warna tema Bata
src-tauri/src/       inti Rust
src-tauri/nsis/      teks installer bahasa Indonesia
scripts/             uji ujung ke ujung
test-files/          file uji dokumen
docs/plans/          rencana per tahap
docs/progress/       laporan per tahap dan screenshot
design/              PRD, rencana pembangunan, mockup (hanya dibaca)
obsidian/            vault catatan proyek
```

Modul Rust di `src-tauri/src/`:

| Modul | Isi |
|---|---|
| `identity/` | Kunci Ed25519 laptop dan penyimpanannya di Credential Manager |
| `org/` | Record genesis organisasi yang ditandatangani pendiri |
| `permissions/` | Log keanggotaan bertanda tangan, perhitungan status organisasi, undangan |
| `peers/` | Alamat rekan: diingat, diisi manual, terakhir terlihat |
| `network/` | QUIC, mDNS, jabat tangan, bergabung, sinkron op, transport sinkron fitur dan unduh blob |
| `db/` | Koneksi SQLite dan migrasi bernomor v1 sampai v8 |
| `blobs/` | Penyimpanan isi file beralamat hash BLAKE3 |
| `chat/` | Channel, pesan, tanda terima, titipan tersegel, lampiran, notifikasi |
| `board/` | Dokumen Automerge per proyek, aturan akses, sinkron, pengingat tenggat |
| `documents/` | Pustaka dokumen, graf versi, pemantau simpan Office, cakupan akses, sinkron antar laptop (`peer_sync.rs`) |
| `signing/` | Tanda tangan PDF: PIN, permintaan, jejak audit, deteksi perubahan, bukti stempel, sinkron antar laptop (`peer_sync.rs`) |
| `commands.rs`, `team_commands.rs`, `network_commands.rs` | Command Tauri untuk tampilan |
| `net_backend.rs` | Adapter antara jaringan dan database |
| `firewall.rs` | Pemeriksaan dan aturan Windows Firewall |
| `qr.rs` | Tautan `mira://peer` dan QR code alamat laptop |
| `window_theme.rs` | Warna latar jendela saat dibuka, supaya mode Gelap tidak berkedip putih |
| `settings.rs`, `paths.rs`, `clock.rs`, `state.rs`, `error.rs` | Pengaturan, lokasi data, jam, state aplikasi, kode error |

## Belum diuji

- Semua uji berjalan di satu PC, termasuk uji sinkron dokumen dan tanda tangan tiga instance. Mira belum diuji di beberapa laptop sungguhan di jaringan kantor.
- Belum diuji lewat VPN. Deteksi VPN memakai nama adaptor Windows, jadi adaptor VPN tertentu bisa tampil sebagai LAN.
- Belum diuji dengan Microsoft Office berlisensi. Uji dokumen meniru pola simpan Word dan Excel.
- Tombol "Izinkan lewat Windows Firewall" (UAC) belum pernah dijalankan.
- Installer belum punya sertifikat penandatanganan kode, jadi Windows SmartScreen bisa memberi peringatan saat memasang.

Yang belum dibuat:
- Menambah file ke proyek atau tim tertentu dari layar Dokumen. Inti Rust sudah mendukung cakupan proyek, tapi layar Dokumen baru bisa menambah ke Pustaka Umum.
- Task dari pesan chat, tanda "sudah digabung" di kartu task, kartu task tanda tangan yang pindah ke Selesai otomatis.
- Komentar, stabilo, dan kotak teks di PDF.
- Halaman Keamanan untuk perubahan yang ditolak.
- Tahap 6 (fitur lengkap) dan Tahap 7 (uji coba kantor) belum dimulai.

## Keputusan yang masih terbuka

- Logo final. Saat ini masih logo sementara dari `design/logo-sementara.svg`.
- Sertifikat penandatanganan kode untuk installer.
- Kebijakan PIN tanda tangan: tetap 6 sampai 12 angka, minimal 8 angka, atau Windows Hello.
- Nama penerbit di installer. Saat ini masih isian sementara "Mira".
- Jawaban tim jaringan kantor soal mDNS, aturan firewall, dan pertanyaan lain di Lampiran A PRD.
- Visibilitas repositori. Saat ini privat.
