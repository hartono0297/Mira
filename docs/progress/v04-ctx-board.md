# Laporan: menu klik kanan Board (v0.4)

Tanggal: 24 November 2026. Branch `claude/v04-ctx-board-7f03aa`, dari `integrasi-v04` (14b7240). Rencana: `docs/plans/v04-ctx-board.md`. Komponen dasar: `src/components/ContextMenu` (`docs/progress/v04-contextmenu.md`).

Permintaan user: "buat click kanan pada app nya ada fungsinya ... u atur aja yang terbaiknya gimana untuk modul2 lain".

## Hasil

Menu klik kanan sekarang ada di lima tempat Board. Isinya hanya aksi yang perintahnya sudah ada, dan mengikuti hak peran anggota proyek. Shift+F10 dan tombol Menu membuka menu yang sama.

| Tempat | Isi menu |
|---|---|
| Kartu task | Buka task. Pindahkan ke › (To do, Dikerjakan, Selesai, Naik/Turun satu posisi). Tugaskan ke › (saya paling atas, anggota, Tanpa penanggung jawab). Ubah prioritas ›. Atur tenggat › (Hari ini, Besok, Hapus tenggat, Tanggal lain di detail task). Mulai/Hentikan timer saya. Salin kode TES-1. Hapus task (merah, dengan konfirmasi). |
| Kolom | Task baru di kolom ini. |
| Subtask (dialog task) | Tandai selesai / belum selesai, Ganti nama, Tugaskan ke ›, Naik/Turun satu posisi, Hapus subtask. |
| Proyek (daftar kiri) | Buka board, Anggota proyek, Ubah nama proyek. |
| Task saya | Buka task, Pindahkan ke ›, Salin kode. |

Hak peran:
- Tamu dan orang tanpa hak tulis: kartu hanya Buka task dan Salin kode; kolom tanpa menu; subtask tanpa menu; Task saya tanpa Pindahkan ke.
- Hapus task hanya untuk pembuat task dan pengelola proyek. Ubah nama proyek hanya untuk pengelola.
- Aksi yang sementara tidak bisa tampil nonaktif dengan alasan, misalnya "Task sudah di kolom ini", "Belum ada tenggat", "Sudah paling atas", "Board ini sedang terbuka", dan "Tunggu perubahan sebelumnya tersimpan".

Screenshot: `docs/progress/screenshots/v04-ctx-board/`
- `01-kartu-menu-terang`
- `02-kartu-submenu-pindah-terang`
- `03-konfirmasi-hapus-terang`
- `04-kartu-menu-gelap`
- `05-subtask-menu-gelap`
- `06-proyek-menu-terang`
- `07-task-saya-submenu-terang`

## Keputusan

| Keputusan | Alasan |
|---|---|
| Sub-menu dibuat di `src/screens/board/useBoardMenu.tsx`, komponen bersama tidak diubah | Komponen bersama hanya punya daftar datar dan bukan milik sesi ini (Chat sedang memakainya bersamaan). Hook membungkus `useContextMenu`. Item `submenu(...)` bertanda ›. Memilihnya mengganti isi menu di posisi yang sama (memakai `MenuPopup` bersama), dengan Kembali di atas. Panah kanan membuka, panah kiri kembali, Esc menutup semua. Fokus awal di pilihan pertama sesudah Kembali (pola APG). Setelah kembali, fokus di item asal. Sub-menu yang lebih besar dijepit ke tepi, tidak dibalik. |
| Kartu membawa `canDelete`, `canEdit`, `myTimerRunning` dari inti Rust | Kartu sebelumnya tidak tahu hak hapus atau timer saya. `canDelete` dan `canEdit` dipindah dari `TaskDetail` ke `TaskCard`, sehingga JSON detail tetap sama karena `serde(flatten)`. Di `board()` dan `my_tasks()` dihitung murah sekali per proyek: `canWrite && (pembuat == saya \|\| pengelola)`, setara `can_delete_task`. Tes Rust memastikan kartu sama dengan `policy.allows(DeleteTask/EditTask)` untuk 16 kasus penonton. Inti tetap menolak lewat policy. |
| Klik kanan di judul subtask tetap memberi menu teks | Aturan komponen bersama: kolom teks punya menu Potong/Salin/Tempel. Menu subtask terbuka dari kotak centang, pegangan, avatar, ikon hapus, atau ruang kosong baris. Petunjuk subtask menyebut Shift+F10 di kotak centang. |
| Hapus subtask tanpa konfirmasi | Sama dengan tombol tempat sampah yang sudah ada di baris. |
| Hapus task dengan konfirmasi | Teksnya sama dengan dialog di detail task. Waktu tercatat ikut disebut (tanpa angka, karena jumlah catatan tidak ada di kartu), dan kalimat "Mira belum punya cara mengembalikannya." tetap paling akhir. |
| "Mulai timer saya" mengumumkan timer lain yang dihentikan | Inti menghentikan timer saya yang lain di proyek yang sama. Menu mengumumkan "Timer Anda di TES-1 berjalan. Timer di TES-2 dihentikan." |
| "Hentikan timer saya" tanpa catatan | Jalan pintas. Catatan tetap bisa ditulis lewat tombol Hentikan di detail task. |
| Tenggat: hanya Hari ini, Besok, Hapus tenggat, lalu Tanggal lain membuka detail task | Pemilih tanggal ada di detail task. Membuat pemilih kedua di menu menambah alur baru. |
| Tanpa "Buka chat proyek" | Pindah ke Chat lewat `Shell` dan `ChatScreen`, keduanya di luar milik sesi ini. |
| Kolom hanya "Task baru di kolom ini" | Pengelolaan kolom belum ada, jadi tidak ditambahkan. |
| Kartu tanpa tombol "..." baru | Kartu sudah punya tombol Pindahkan, dan semua aksi lain ada di detail task. Satu-satunya aksi yang hanya ada di menu adalah Salin kode, dan bisa dijangkau dengan Shift+F10. |
| Klik kanan membatalkan seret yang tertunda | Tombol kiri ditahan belum lewat ambang 5 px, lalu klik kanan: seret dibatalkan, jadi tidak ada seret yang mulai di belakang menu. Selama seret berjalan, menu tidak dibuka. Ctrl+klik (klik kanan di macOS) tidak memulai seret, tapi hanya di macOS. Di Windows Ctrl+seret tetap jalan. |
| Permintaan Anggota/Ubah nama dari daftar proyek berlaku sekali | BoardScreen menghapus permintaan begitu board proyeknya tidak tampil lagi, sehingga board yang dipasang ulang tidak membuka panel sendiri. |

## Verifikasi

| Uji | Hasil |
|---|---|
| `npx tsc --noEmit -p .` | bersih |
| `npx vitest run src/screens/board` | 19 file, 476 tes lulus |
| Tes baru | `BoardContextMenu.test.tsx` 42, `SubtaskMenu.test.tsx` 31, `useBoardMenu.test.tsx` 40, `ProjectMenu.test.tsx` 10, `MyTasksMenu.test.tsx` 8 |
| `npx vitest run` (seluruh repo) | 1386 lulus, 2 gagal, 2 file gagal dimuat; semuanya di luar Board, lihat di bawah |
| `cargo test` | 1098 lulus, 7 diabaikan (sudah begitu sebelumnya) |
| `cargo clippy --all-targets -- -D warnings` | bersih |
| `scripts/board-e2e.mjs` (klik kanan sungguhan, `button: "right"`) | 43/43 lulus (23 langkah lama termasuk seret mouse, 20 baru) |
| `scripts/board-sync-e2e.mjs` | 26/26 lulus |

Tes keyboard mencakup:
- Shift+F10, tombol Menu, panah atas/bawah, Home/End.
- Panah kanan/kiri dan Kembali di sub-menu.
- Enter/Spasi, Esc, dan Tab.
- Fokus kembali ke judul kartu atau elemen asal, termasuk setelah hapus.
- Esc di dalam dialog modal hanya menutup menu.
- Item nonaktif beserta alasannya.

Kegagalan Vitest di luar Board sudah ada di base. Diuji di worktree sementara dari 14b7240 dengan hasil yang sama:
- `App.test.tsx` dan `UpdateContext.test.tsx` gagal dimuat. Penyebabnya Vite menolak `pdfjs-dist/build/pdf.worker.min.mjs?url` lewat junction `node_modules` di worktree.
- `DepartmentsPanel.test.tsx` gagal satu tes.
- `NewRequestDialog.test.tsx` sesekali gagal saat mesin sibuk, dan lulus 11/11 kalau dijalankan sendiri.

Yang diperiksa `board-e2e` di aplikasi sungguhan (WebView2, build debug):
- **Kolom:** klik kanan judul To do membuka menu tepat di kursor. "Task baru di To do" membuka isian yang langsung terfokus.
- **Pindahkan:**
  - Menu kartu muncul di kursor, dan detail task tidak ikut terbuka.
  - Sub-menu "Pindahkan PA-6 ke" muncul di tempat yang sama, dengan kolom sekarang nonaktif.
  - Memilih Dikerjakan memindah kartu, baik di layar maupun di inti.
- **Tugaskan:** "Rina Uji (Anda)" ada paling atas dan terfokus. Setelah dipilih, avatar tampil dan data inti berubah.
- **Salin kode:** papan klip sungguhan berisi persis "PA-6", lalu fokus kembali ke judul kartu.
- **Hapus:**
  - Batal tidak mengubah apa pun.
  - Konfirmasi "Hapus PA-7" menghapus kartu, dan `board_get_task` gagal.
- **Keyboard:**
  - Shift+F10 membuka menu dengan item terfokus.
  - Panah kanan membuka sub-menu, dan panah kiri kembali ke "Pindahkan ke".
  - Esc mengembalikan fokus ke judul kartu.
- **Seret:**
  - Menekan tombol kanan lalu menggerakkan mouse tidak memunculkan bayangan seret, dan kartu tidak pindah.
  - Seret tombol kiri antar kolom tetap berhasil, begitu juga semua langkah seret lama.
- **Proyek:** "Anggota proyek" membuka panel.
- **Task saya:** Pindahkan ke > Selesai memindah task di inti.
- **Subtask:**
  - Menu dirender di dalam dialog, dan Esc hanya menutup menu.
  - "Tandai belum selesai" mengubah data inti.
- Mode terang dan gelap.

Build uji: `npx tauri build --debug --no-bundle`, lalu `E2E_PORT_OFFSET=640` untuk kedua skrip, supaya tidak bentrok dengan sesi lain.

## Review terpisah

Dua reviewer terpisah, satu untuk aksesibilitas dan tampilan, satu untuk kebenaran dan keamanan. Tidak ada temuan keamanan atau bug logika di Rust. Kesetaraan `canDelete` dengan policy sudah diperiksa untuk semua peran.

Semua bug diperbaiki, masing-masing dengan tes regresi:
1. Dua menu sekaligus: Shift+F10 atau klik kanan di dropdown Pindahkan, atau di popover penanggung jawab subtask, membuka menu baris di atasnya. Sekarang diabaikan, dan dropdown Pindahkan menutup saat fokus keluar.
2. Seret yang tertunda di kartu dan subtask tetap mulai setelah menu terbuka. Sekarang dibatalkan. Menu juga tidak terbuka selama seret subtask berjalan.
3. Ctrl+klik di pegangan subtask (macOS) membuka menu sekaligus memulai seret.
4. Task saya menampilkan Pindahkan ke untuk orang tanpa hak tulis. Sekarang memakai `canEdit` dari kartu.
5. Permintaan Anggota/Ubah nama bisa terputar ulang saat proyek hilang lalu muncul lagi.
6. "Mulai timer saya" diam-diam menghentikan timer lain. Sekarang diumumkan.
7. Hapus dari menu saat pindahan kartu yang sama masih berjalan memunculkan galat "belum dipindah" palsu.

Saran yang diambil:
- Pemisah di menu kartu.
- Penanggung jawab lama yang bukan anggota lagi tampil nonaktif.
- "Hapus tenggat" nonaktif dengan alasan.
- Urutan kalimat konfirmasi hapus.
- Teks salin gagal tanpa "Ctrl+C".
- Label subtask "Naik/Turun satu posisi" seperti kartu.
- Esc setelah "Ganti nama" hanya keluar dari judul.
- "Buka board" nonaktif untuk board yang sedang terbuka.
- Sub-menu mendukung `confirm` dan tidak membuang galat.

## Batasan dan tindak lanjut

- Saat sub-menu dibuka, fokus berpindah dua kali: ke elemen asal dulu, baru ke sub-menu. Pembaca layar bisa sempat membacakan judul kartu. Menghindarinya butuh perubahan di komponen bersama (`useContextMenu` selalu mengembalikan fokus sebelum aksi). Belum diuji dengan NVDA.
- Kalau rekan memindah kartu ke kolom lain selagi menu kartu atau konfirmasi hapusnya terbuka, kartu dipasang ulang dan menu atau dialog hilang. Tidak ada data yang berubah. Kasusnya jarang.
- Kalau baris tanpa elemen yang bisa difokus berada di dalam dialog, komponen bersama merender menu utama di luar dialog. Board tidak punya baris seperti itu.
- Tempel/Salin di macOS belum diuji di Mac, sama seperti tahap dasar.
- Teks baru ada di `src/screens/board/teksMenu.ts` untuk sesi bahasa Inggris.
