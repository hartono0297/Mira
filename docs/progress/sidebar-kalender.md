# Laporan: sidebar bisa diringkas dan menu Kalender

Tanggal: 24 sampai 25 November 2026. Branch `claude/sidebar-kalender-9e403d`, dari `main` a45d1b3 (v0.5.0). Rencana dan kontrak: `docs/plans/sidebar-kalender.md`.

Permintaan user:
- "side bar bisa di minimize"
- "ada menu kalender, user bisa lihat task2 per kalender gitu"
- "u atur yang terbaiknya gimana semua"

## Ringkasan

| Bagian | Hasil |
|---|---|
| Sidebar ringkas | Tombol di bawah logo atau Ctrl+B (Cmd+B di macOS). Lebar 208 px menjadi 64 px, dengan animasi 160 ms yang mati saat `prefers-reduced-motion`. Pilihan tersimpan per laptop di pengaturan inti Rust (`shell.sidebar`), dan tetap ringkas setelah aplikasi ditutup dan dibuka lagi. |
| Mode ringkas | Menu hanya ikon dengan tooltip (hover dan fokus keyboard). Nama aksesibel tetap lengkap, misalnya "Chat, 3 belum dibaca". Angka notifikasi berupa lencana kecil di pojok ikon. Panel jaringan menjadi ikon status berwarna, dan profil menjadi avatar dengan nama, kantor, dan peran di tooltip. |
| Menu Kalender | Ada di sidebar setelah Board, dengan tampilan Bulan (bawaan), Minggu, dan Agenda. Isinya task bertenggat dari proyek yang boleh dilihat pengguna, dengan aturan akses yang sama seperti Board. |
| Saringan | Task saya, Semua proyek, atau satu proyek. Task Selesai tersembunyi, bisa ditampilkan lewat kotak centang. Pilihan tampilan dan saringan tersimpan per laptop. |
| Penanda | Garis warna per proyek ditambah kode task tertulis. Task lewat tenggat diberi ikon peringatan, warna merah, dan keterangan "lewat tenggat" untuk pembaca layar. Task selesai dicoret dan diberi ikon centang. |
| Ubah tenggat | Seret task ke hari lain dengan mouse (pointer events). Dari keyboard: Alt+Panah kiri/kanan (satu hari) dan atas/bawah (satu minggu). Klik kanan atau Shift+F10 membuka menu "Pindahkan tenggat ke": Hari ini, Besok, Senin depan, Satu hari lebih awal, Satu hari lebih lambat, Hapus tenggat, Buka task. Hanya untuk yang berhak; inti Rust tetap memeriksa hak `EditTask`. |
| Detail task | Klik task membuka dialog `TaskDetail` yang sudah ada, bukan salinan. Setelah dialog ditutup, fokus kembali ke task itu. |
| Sinkron | Kalender dimuat ulang saat board berubah di laptop ini, saat data board tiba dari laptop lain, dan saat keanggotaan proyek berubah (`subscribeBoard`). |

## Yang dibuat

**Inti Rust**
- `src-tauri/src/board/calendar.rs` (baru): command `board_calendar(from, to)`.
  - Membaca indeks `board_task_index` (tenggat ada, belum dihapus, dalam rentang), lalu membuka dokumen per proyek sekali untuk membangun kartu.
  - Proyek yang gagal `Ctx::can_view` dilewati: Tamu hanya melihat proyek undangannya, anggota hanya proyek yang ia ikuti.
  - Rentang divalidasi: format tanggal, awal tidak boleh sesudah akhir, dan paling panjang 400 hari.
  - 10 tes unit.
- `board/mod.rs` dan `lib.rs`: masing-masing satu baris.
- Pengaturan sidebar memakai `get_setting`/`set_setting` yang sudah ada, jadi tidak ada command baru untuk itu.

**Tampilan**
- `src/screens/shell/`:
  - `useSidebar.ts`: status, penyimpanan, Ctrl+B, dan jendela sempit.
  - `SidebarToggle.tsx`, `NavTooltip.tsx`, `NetworkDot.tsx`.
  - Perubahan di `Shell.tsx` (21 baris) dan `shell.css`.
- `src/screens/calendar/` (baru):
  - Logika tanggal murni: `calendarModel.ts`.
  - Tampilan: `MonthView`, `WeekView`, `AgendaView`, `CalChip`, `DayMore` (daftar "+N lagi").
  - Layar: `CalendarScreen`, `useCalendarData`, `useDueDrag`, `DueMenu`.
  - CSS: `calendar.css` dan `calendar-views.css`.
- `src/api/calendar.ts` (baru).
- Kamus: `src/i18n/shell.*` ditambah, plus `calendar.*` dan `calendar-view.*` (baru), Indonesia dan Inggris.
- Uji ujung ke ujung: `scripts/sidebar-kalender-e2e.mjs` (baru, `npm run test:e2e-sidebar-kalender`).

## Keputusan yang saya ambil sendiri

| Keputusan | Alasan |
|---|---|
| Pilihan sidebar memakai kunci pengaturan `shell.sidebar` lewat command yang sudah ada. | Sama dengan pola tema dan bahasa: tersimpan di inti Rust per laptop, dan localStorage hanya untuk frame pertama. Tidak perlu command baru. |
| Ctrl+B tidak bekerja saat dialog, menu klik kanan, atau seret tenggat sedang aktif. | Mencegah tata letak bergeser di bawah dialog atau pointer. Ctrl+B belum dipakai di aplikasi; tidak ada teks kaya di chat. |
| Pintasan dicocokkan dari huruf yang diketik dulu, baru posisi tombol. | Di Dvorak, posisi tombol B mengetik "x". Kalau posisi yang dipakai, Ctrl+X (potong) malah meringkas sidebar. |
| Tombol ringkas memakai label yang berganti ("Ringkas menu"/"Lebarkan menu") tanpa `aria-expanded`. | Kalau keduanya dipakai, pembaca layar mengucapkan keadaan dua kali. Label yang berganti juga cocok dengan tooltip. |
| Status jaringan dalam mode ringkas berupa ikon status yang sama dengan panel lebar, bukan titik polos. | Titik polos menyampaikan keadaan hanya lewat warna. Klik membuka Organisasi, atau membaca ulang status kalau status tidak terbaca. |
| Jendela di bawah 900 px otomatis ringkas. | `tauri.conf.json` membatasi lebar minimal 900 px, jadi ini hanya terjadi saat WebView diperbesar (zoom). Membuka sidebar di keadaan itu bersifat sementara dan tertutup lagi setelah memilih menu atau menekan Esc. |
| Tooltip hover muncul setelah 300 ms. Saat pindah antar ikon, tooltip langsung berganti. Fokus keyboard menampilkannya tanpa jeda. | Menghindari kedip tooltip saat mouse lewat. |
| Saringan bawaan Semua proyek, task Selesai tersembunyi, tampilan bawaan Bulan. | Pengguna baru langsung melihat semua tenggat yang relevan. |
| Agenda memuat grup "Lewat tenggat" berisi task belum selesai dengan tenggat sebelum bulan yang tampil, hanya saat bulan itu memuat hari ini. | Task yang lewat tenggat di bulan ini sudah tampil di harinya sendiri, jadi tidak muncul dua kali. |
| Jumlah task per sel bulan menyesuaikan tinggi baris (1 sampai 6), sisanya "+N lagi". | Bulan dengan 6 baris tetap muat di layar 1366x768 tanpa kepala halaman ikut tergulir. |
| Di bawah sekitar 700 px lebar area kalender, sel bulan menampilkan tombol jumlah, bukan chip. Kolom tampilan Minggu ditumpuk menjadi daftar per hari. | Chip tidak terbaca di kolom selebar sekitar 45 px. |
| Seret dan pindah tenggat ditampilkan lebih dulu (optimistis). Kalau gagal, tanggal dikembalikan dan pesan error tampil dengan tombol Tutup pesan. | Pemindahan cepat beruntun aman: hanya langkah terakhir per task yang boleh mengembalikan tanggal. |
| Pindah tenggat ke luar periode yang tampil ikut memindahkan periode, dan fokus tetap di task itu. | Fokus keyboard tidak hilang ke halaman. |
| "Senin depan" selalu Senin berikutnya, juga saat hari ini Senin. | Sama dengan "Senin depan" di pilihan tenggat detail task. |
| Warna proyek: 8 warna untuk terang dan gelap, dibagi menurut urutan kode proyek. | Semua warna minimal 4.8:1 terhadap latar chip (terang) dan 6.5:1 (gelap). Dicek dengan `check_contrast`. |
| "Hari ini" dihitung ulang tepat tengah malam. | Aplikasi yang terbuka melewati tengah malam tetap menandai hari dan tenggat lewat dengan benar. |

## Review

Satu subagent reviewer terpisah untuk tampilan dan aksesibilitas menemukan 3 high, 9 medium, dan 13 low, ditambah dua catatan teks. Semua high dan medium sudah diperbaiki, begitu juga sebagian besar yang low:
- **High:**
  - Tampilan Minggu tidak pernah menumpuk di layar sempit (container query menarget elemennya sendiri).
  - Fokus hilang setelah Alt+Panah ke luar periode.
  - Fokus hilang setelah Hapus tenggat.
- **Medium:**
  - "Memuat task..." dibacakan di setiap sinkron.
  - DayMore kehilangan pembukanya.
  - Fokus kembali ke chip yang salah dari DayMore.
  - Ctrl+B menghilangkan fokus di panel jaringan.
  - Tooltip terpotong di bawah jendela.
  - Baris bulan melebihi 1366x768.
  - Teks chip meluber ke sel sebelah.
  - Bulan dan Minggu tanpa keterangan kosong.
  - Sidebar sementara di jendela sempit tidak menutup.

E2E kemudian menemukan satu bug yang tidak tertangkap jsdom. Daftar "+N lagi" memanggil `focus()` saat panel masih `visibility: hidden`, sehingga WebView menolaknya: fokus tertinggal di tombol dan Esc tidak menutup daftar. Sekarang fokus dipindah setelah posisinya terpasang (`ad57d3a`).

## Hasil uji

| Pemeriksaan | Hasil |
|---|---|
| `cargo test` (seluruh crate) | 1234 lulus, 1 gagal, 7 diabaikan (tes keyring, firewall, mDNS sungguhan, sama seperti sebelumnya). Yang gagal adalah `documents::watch::tests::excel_save_sequence_settles_once`, tes waktu pemantau berkas di luar board, saat mesin sangat sibuk (tujuh sesi membangun bersamaan). Dijalankan ulang sendiri: `documents::watch` 21/21 lulus. |
| `cargo test board::calendar` | 10/10 |
| `cargo clippy --all-targets -- -D warnings` | tanpa peringatan |
| `npx tsc --noEmit` | tanpa error |
| `npx vitest run` | 1955 lulus. 1927 tes di 123 berkas lulus di run penuh. Tiga berkas (`App.test.tsx`, `components.en.test.tsx`, `UpdateContext.test.tsx`) gagal dimuat karena junction `node_modules` (catatan lingkungan di bawah), lalu lulus dengan konfigurasi sementara: 28 tes. |
| Tes baru Kalender | 153 tes di 5 berkas: `calendarModel` 62, tampilan 39, layar 40 + 2, `useCalendarData` 10. Ditambah `src/api/calendar.test.ts` 6. |
| Tes baru sidebar | `src/screens/shell` 80 tes di 6 berkas: `useSidebar` 25, `Shell` 18, `NetworkDot` 10, dan lainnya. |
| `sidebar-kalender-e2e.mjs` (build debug) | 54/54 (run ke-8, termasuk fase Tamu dua instance pada percobaan pertama) |
| `smoke-e2e.mjs` | 12/12 |
| `board-e2e.mjs` | 43/43 setelah dua pembacaan diubah menjadi menunggu sampai 5 detik (lihat di bawah). Sebelumnya 42/43 dan 41/43: kartu atau komentar terakhir tiba lebih lambat dari jeda tetap 250 sampai 600 ms saat PC sibuk. |
| `english-e2e.mjs` | 38/38 |
| `contextmenu-e2e.mjs` | 27/27 |

**Perubahan di `board-e2e.mjs`.** Dua pembacaan yang tadinya memakai jeda tetap sekarang menunggu sampai 5 detik: "Empat task dibuat di To do" dan "Detail task menyimpan ...". Pengecekannya tidak berubah. Branch ini tidak mengubah kode board selain `calendar.rs` baru, dan setiap pemeriksaan yang sempat gagal juga lulus di run lain.

**Isi `sidebar-kalender-e2e`:**
- **Sidebar:** ringkas lewat tombol (sekitar 64 px, nama menu tetap lengkap, pengaturan tersimpan), tooltip lewat hover dan fokus, Ctrl+B dua arah, tetap ringkas setelah restart.
- **Data:** dua proyek dan task bertenggat kemarin, hari ini, besok, satu hari dengan 8 task, satu task selesai, dan satu dari bulan lalu, semuanya diisi lewat UI Board.
- **Bulan:** task ada di sel yang benar, tanda lewat tenggat, "+N lagi" membuka daftar lengkap, dan Esc menutupnya.
- **Minggu, Agenda, navigasi:** tampilan Minggu dan Agenda (grup Lewat tenggat), serta tombol sebelumnya, berikutnya, dan Hari ini.
- **Saringan:** Task saya, per proyek, dan Tampilkan yang selesai.
- **Detail task:** klik task membuka detail, dan fokus kembali ke task setelah ditutup.
- **Ubah tenggat:**
  - Seret dengan mouse sungguhan, tetap benar setelah halaman dimuat ulang.
  - Alt+Panah kanan.
  - Klik kanan, lalu Besok.
- **Tema dan bahasa:** tema gelap, lalu bahasa Inggris.
- **Tamu (dua instance):** B bergabung sebagai Tamu yang diundang ke satu proyek saja. B hanya melihat task proyek itu, tidak bisa menyeret, dan Alt+Panah mengumumkan "Anda tidak berhak mengubah tenggat task ini." tanpa memanggil `board_update_task`.

## Screenshot

`docs/progress/screenshots/sidebar-kalender/`:
- **Sidebar:** `01-sidebar-lebar-terang`, `02-sidebar-ringkas-terang`, `03-sidebar-ringkas-tooltip-terang`, `04-sidebar-ringkas-setelah-restart-terang`, `20-sidebar-ringkas-kalender-gelap`, `25-sidebar-ringkas-inggris-gelap`.
- **Kalender terang:** `06` (bulan), `07` (daftar +N lagi), `08` (minggu), `09` (agenda), `10` (Task saya), `11` (tampilkan selesai), `12` (detail task), `13` (target seret), `14` (menu tenggat).
- **Kalender gelap:** `15` sampai `19`.
- **Bahasa Inggris:** `21` sampai `24`.
- **Tamu:** `26-tamu-kalender-bulan-terang`, `27-tamu-menu-tanpa-hak-terang`, `28-tamu-kalender-agenda-gelap`.

## Belum dicek atau masih kurang

- Belum diuji di macOS: Cmd+B dan seret di WKWebView.
- Belum diuji antar laptop sungguhan. Uji Tamu memakai dua instance di satu PC.
- Seret di tampilan Agenda bisa dipakai, tapi daftar harinya hanya hari yang punya task, jadi target seretnya terbatas. Pemindahan jauh lebih mudah lewat Bulan atau menu.
- Kalender tidak menampilkan task tanpa tenggat. Keterangan kosong menyarankan memberi tenggat lewat Board.
- Kalender belum punya angka di sidebar (misalnya tenggat hari ini). Angka itu sudah ada di Board.

## Catatan lingkungan

- **Junction `node_modules`.** Worktree memakai junction `node_modules` ke `D:\GitHub\ChatCompany\node_modules`. Lepas dengan `cmd /c rmdir node_modules`, jangan `Remove-Item -Recurse`. Lewat junction, Vite menolak `pdfjs-dist/...?url`, sehingga tiga berkas tes gagal dimuat di run penuh. Dengan konfigurasi sementara `server.fs.allow` (langsung dihapus setelah dipakai) ketiganya lulus.
- **Folder sementara dan port.** Semua build dan uji memakai `TMP`/`TEMP` di `D:\mira-tmp\sidebar-kalender`, `CARGO_BUILD_JOBS=2`, dan `E2E_PORT_OFFSET=1900`. Data uji e2e dihapus oleh skripnya.
- **Kredensial uji.** Run e2e awal sempat meninggalkan empat kunci laptop uji di Windows Credential Manager, karena aplikasi gagal terbuka sebelum skrip memperbaikinya. Keempatnya dicocokkan lewat waktu tulis dengan peluncuran milik skrip ini, lalu dihapus. Hanya nama kunci yang dibaca (`cmdkey /list`), tidak pernah isinya. Kunci milik sesi lain dan data Mira user di `%LOCALAPPDATA%\Mira` tidak disentuh.

- **Skrip e2e lama menghapus kunci uji milik orang lain.** Sepuluh skrip menghapus semua kunci `device-key-*` baru di akhir run, bukan hanya miliknya sendiri: board-e2e, board-sync, chat, contextmenu, e2e-multi, org, sign, smoke-docs, smoke, dan sync. Salinan org-e2e di sesi perbaikan-bergabung sempat menghapus kunci laptop A milik uji ini di tengah run, sehingga A gagal dibuka ulang dengan `key_mismatch`. Skrip baru di sesi ini hanya menghapus kuncinya sendiri. Saran: pindahkan skrip lama ke pola `ourKeys` seperti `join-e2e.mjs`.

## Untuk penggabung

- **File bersama yang disentuh:**
  - `src/screens/shell/Shell.tsx`: 21 baris. Import, `Section` `"calendar"`, NAV setelah board, `useSidebar(section)`, kelas `side-collapsed`, `id="main-sidebar"`, `SidebarToggle`, label dibungkus `span.side-label`, `compact` di `NetworkPanel`, `NavTooltip`, dan render `CalendarScreen`. Markup avatar tidak diubah; sesi foto profil boleh mengganti isi `.avatar`. Mode ringkas menyembunyikan `.side-me-text` lewat CSS, dan tooltip profil dibangun dari teks itu.
  - `src/screens/shell/NetworkPanel.tsx`: prop `compact`; peta ikon status pindah ke `NetworkDot.tsx`.
  - `src/i18n/noIndonesian.test.tsx`: indeks menu bergeser karena Kalender disisipkan di posisi 2.
  - `src-tauri/src/lib.rs`: satu baris `board::calendar::board_calendar,` setelah `board_my_tasks`.
  - `src-tauri/src/board/mod.rs`: `pub mod calendar;`.
  - `package.json`: skrip `test:e2e-sidebar-kalender`.
- **Kalau sesi lain menambah menu sidebar,** urutan NAV di `Shell.tsx` dan indeks di `noIndonesian.test.tsx` perlu disesuaikan.
- **Sesi timer atau dept-divisi yang mengubah bentuk `TaskCard`:** `board_calendar` memakai `Ctx::card`, jadi otomatis ikut. Hak kartu disalin dari `CardRights` di `view.rs`; kalau aturan hak kartu berubah, `calendar.rs` ikut diubah.
- **Tidak ada migrasi baru.** Kunci pengaturan baru: `shell.sidebar`, `calendar.view`, `calendar.filter`.
