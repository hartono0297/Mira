# Laporan: timer pakai jeda, catat manual dimatikan

Tanggal 25 November 2026. Branch `claude/timer-jeda-a7b57b`, dari `main` a45d1b3 (v0.5.0). Rencana di [timer-jeda.md](../plans/timer-jeda.md). Target rilis v0.6.0.

Permintaan user: "log time manually sepertinya tidak perlu, di disabled dlu ja", "tombol start timer, harusnya bukan stop timer, tapi pause ga sih?", lalu "u atur yang terbaiknya gimana semua".

## Hasilnya

| Tempat | Sebelum | Sekarang |
|---|---|---|
| Kepala dialog task | Mulai timer, lalu Hentikan timer dengan kotak catatan | Satu tombol yang berganti: **Mulai timer**, **Jeda** (langsung, tanpa kotak), **Lanjutkan**. Saat berjalan, jam menunjukkan total saya di task ini. Saat dijeda tampil "Dijeda 1j 20m". |
| Bagian Waktu, Per orang | Tag "berjalan" | Tag "berjalan" atau "dijeda" (dua batang abu, bentuk sama dengan ikon Jeda). Tidak ada tag dijeda di task yang sudah Selesai. |
| Menu klik kanan kartu | Mulai timer saya / Hentikan timer saya | Mulai timer saya / Jeda timer saya / Lanjutkan timer saya |
| Catat waktu manual | Tombol dan form di bagian Waktu | Disembunyikan lewat `MANUAL_TIME_LOG = false` di `src/screens/board/timeFeatures.ts`. Catatan manual lama tetap tampil (tag "manual"), tetap dihitung, dan tetap bisa dihapus pemiliknya. Command `board_log_time` tetap ada. |
| Jeda otomatis | Hanya di proyek yang sama saat mulai timer lain | Lintas proyek, saat task masuk Selesai atau dihapus (oleh saya atau rekan), dan saat Mira tertutup atau laptop tidur. Setiap jeda otomatis tampil sebagai pemberitahuan di atas board. |

Teks Inggris: Start timer, Pause, Resume, Paused, Your total, "Pause my timer" / "Resume my timer" di menu kartu.

## Keputusan

| Keputusan | Alasan |
|---|---|
| **Format data tidak berubah.** Jeda = mengisi `end` segmen yang berjalan (`board_stop_timer`), Lanjutkan = segmen baru (`board_start_timer`). Tidak ada objek "sesi" baru. | Change-nya sama persis dengan v0.4/v0.5, jadi `rules.rs` tidak disentuh dan laptop 0.5 menerima semuanya. Laptop 0.5 melihat segmen-segmen itu sebagai catatan biasa dengan total yang sama. |
| "Dijeda" = orang itu punya segmen timer (bukan manual, tidak dihapus) yang sudah berhenti dan tidak ada yang berjalan. | Diturunkan dari data yang sudah tersinkron; tidak perlu field baru di dokumen. Kartu membawa `myTimerPaused` untuk menu klik kanan. |
| Jeda langsung, tanpa kotak catatan. | Jeda harus satu klik. Catatan per segmen yang sudah ada tetap tampil di riwayat. |
| Satu timer berjalan per orang di semua proyek. Di proyek yang sama ditutup dalam change yang sama (seperti v0.4); di proyek lain dengan satu change per proyek. | Proyek adalah dokumen terpisah. Kalau penutupan di proyek lain gagal (misalnya hak dicabut), mulai timer tetap berhasil dan penjaga timer mencoba lagi. |
| Task dipindah ke Selesai atau dihapus oleh saya: segmen saya ditutup dalam change yang sama. Oleh rekan: penjaga timer di laptop saya menutupnya dalam 1 menit. | Aturan sinkron hanya mengizinkan pemilik mengisi `end` catatannya, jadi laptop pemilik yang menjeda. |
| Timer yang sengaja dimulai di task yang sudah Selesai tidak dijeda. | Penjaga hanya menjeda kalau perpindahan terakhir ke Selesai terjadi setelah segmen dimulai. Perbandingan ini memakai jam laptop yang memindah, jadi selisih jam antar laptop bisa menggesernya (dicatat di `timer_guard.rs`). |
| Menulis `end` di task yang sudah dihapus diterima. | `rules.rs` untuk catatan waktu hanya memeriksa pemilik, bukan status hapus task. Dibuktikan tes `automatic_pauses_are_accepted`. |
| **Mira ditutup saat timer berjalan:** penjaga timer menulis `board.timer.last_alive` tiap 60 detik. Kalau saat dibuka lagi (atau saat laptop bangun) selisihnya lebih dari 10 menit, segmen yang berjalan ditutup pada waktu terakhir aktif, dengan pemberitahuan "dijeda pada 17.32, saat Mira terakhir aktif". | Perilaku lama: segmen tetap terbuka dan terus menghitung sampai dibuka lagi, termasuk semalaman. Karena catat manual dimatikan dan catatan tidak bisa disunting, satu-satunya cara memperbaikinya adalah menghapus seluruh segmen. Jeda pada waktu terakhir aktif menjaga jam kerja yang benar. Jam mundur tidak memicu jeda. `MIRA_TIMER_IDLE_GAP_SECS` bisa mengganti 10 menit untuk uji. |
| Ada dua timer saya berjalan (misalnya dari laptop 0.5): penjaga menyisakan yang paling baru dimulai. | Menjaga aturan satu timer per orang walau data lama tidak memenuhinya. |
| Pemberitahuan jeda otomatis disimpan di antrean memori (paling banyak 50) dan diambil UI lewat `board_take_timer_notices` setelah event `mira://board`. Layar board menampilkan paling banyak 5, terbaru di atas, masing-masing bisa ditutup, dan "Tutup semua" kalau ada dua atau lebih. | Antrean memori cukup: pemberitahuan hanya berarti saat aplikasi berjalan. Dipasang di BoardScreen supaya juga tampil di Task saya. |
| Pengumuman pembaca layar: daftar pemberitahuan bukan wilayah live; satu wilayah sr-only membacakan hanya yang baru. Di dalam dialog task (yang menyembunyikan isi di luarnya dari pembaca layar) `TimerMini` membacakan pemberitahuan yang sama lewat store bersama. | Hasil review tampilan. |
| Jam di kepala dialog menunjukkan total saya, bukan hanya segmen yang berjalan. | Dengan jeda, total itulah yang berarti. Pembaca layar mendapat "berjalan sejak 14.05. Sebelumnya tercatat 1 jam 10 menit." |
| Riwayat `time_logged` tetap ditulis setiap kali segmen ditutup. | Sama dengan v0.4; tidak mengubah perilaku laptop 0.5. |

## Cara kerjanya

**Inti Rust** (`src-tauri/src/board/`)
- `doc.rs`: `start_timer` mengembalikan `StartedTimer` dengan daftar segmen yang dijeda; `move_task` ke Selesai dan `delete_task` menutup segmen saya dalam change yang sama dan mengembalikan `Vec<PausedTimer>`; `pause_entry` untuk penjaga timer. Teks galat jeda ganda: "Timer Anda di task ini sudah dijeda. Total terbaru tampil setelah task ini dimuat ulang."
- `model.rs`, `view.rs`: `TaskCard.myTimerPaused`, `TimerNotice`, `TimerPauseReason`.
- `commands.rs`: antrean `TimerNotices` di `BoardRuntime`, `start_timer_with_notices` (jeda di proyek lain), `move_task_with_notices`, `delete_task_with_notices`, command `board_take_timer_notices`.
- `timer_guard.rs` (baru): `run_once` (idle, Selesai/hapus, satu timer per orang, tulis `last_alive`) dan `spawn` (3 detik setelah mulai, lalu tiap 60 detik). Dipasang di `lib.rs`.

**Tampilan** (`src/screens/board/`)
- `TimerMini.tsx`: satu tombol yang stabil (fokus tidak hilang kalau keadaan berubah dari luar), bobot visual sama di ketiga keadaan, "Total Anda" saat task Selesai atau saat hanya ada catatan manual lama.
- `TimeSection.tsx`, `time.css`, `timeFormat.ts` (`personTimer`, `myTimer`), `timeFeatures.ts`.
- `cardMenu.tsx`, `ProjectBoard.tsx` (aksi timer), `TimerNotices.tsx`, `timerNoticeStore.ts`, `timer-notices.css`, satu baris di `BoardScreen.tsx`.
- Kamus: `board-time.*` (Jeda, Lanjutkan, Dijeda, pemberitahuan), `board-menu.*`, `board-dialog.*` ("Timer belum diubah"), `errors-rust.*`.

## Uji

Build `npx tauri build --debug --no-bundle`, Windows 11, `E2E_PORT_OFFSET=2100`, TMP/TEMP di D:, skrip dijalankan satu per satu. Tujuh sesi membangun bersamaan di PC yang sama, jadi beberapa putaran gagal karena beban mesin (lihat catatan di bawah).

| Uji | Hasil |
|---|---|
| `cargo clippy --all-targets -- -D warnings` | Bersih |
| `cargo test --no-fail-fast` penuh | 1240 lulus, 1 gagal (`documents::watch::two_documents_stay_separate`), 7 diabaikan. Tes pemantau berkas ini bergantung waktu; kode documents tidak diubah. `cargo test --lib documents::watch -- --test-threads=1`: 21/21 lulus. |
| Tes baru Rust | 16 tes: jeda, lanjutkan, dan akumulasi; satu timer per orang; jeda saat Selesai dan saat hapus; `myTimerPaused`; penjaga timer (gap idle 15 menit menjeda di waktu terakhir aktif, gap pendek tidak, jam mundur tidak, Selesai oleh rekan, timer yang dimulai di task Selesai tidak dijeda, task dihapus rekan, dua timer disisakan satu); `automatic_pauses_are_accepted` di aturan sinkron |
| `npx tsc --noEmit` | Lolos |
| `npx vitest run` | 113 file, semua lulus. Dijalankan dengan `--maxWorkers=2`, karena dengan worker bawaan banyak worker gagal mulai saat mesin sibuk. Tiga suite (`App`, `UpdateContext`, `components.en`) hanya bisa dimuat dengan konfigurasi sementara yang mengizinkan Vite membaca `node_modules` repo utama: worktree ini tidak punya `node_modules` sendiri, dan Vite menolak `pdf.worker.min.mjs?url` dari luar root. Hasilnya 28/28 lulus. |
| `board-e2e` | 46/46. Baru: Mulai timer, Jeda (tampil Dijeda dan Lanjutkan), Lanjutkan, Jeda lagi menghasilkan dua segmen; tidak ada tombol Catat waktu manual; memulai timer di proyek lain menjeda timer di proyek pertama dan pemberitahuannya tampil; memindah task ke Selesai menjeda timernya dan pemberitahuannya tampil |
| `board-v04-multi-e2e` | 38/38. Baru: A menjeda, melanjutkan, menjeda lagi; B melihat dua segmen A yang berhenti dengan total yang sama (6 detik), dan layar B menampilkan Ayu dengan tag dijeda; kartu A `myTimerPaused`; B menjalankan timer, A memindah task ke Selesai, penjaga timer di B menjeda timer B dalam 32 detik dan A melihat hasil yang sama; pemberitahuan tampil di layar B; dialog task di Selesai menampilkan "Total Anda" tanpa tag dijeda dan tanpa tombol catat manual |
| `english-e2e` | 38/38 |

Screenshot di [screenshots/timer-jeda/](screenshots/timer-jeda/): `01-dijeda-terang-id`, `02-berjalan-terang-id`, `03-dijeda-gelap-id`, `04-dijeda-terang-en`, `05-dijeda-gelap-en`, `06-pemberitahuan-terang-id`, `07-menu-kartu-terang-id`.

Perbaikan kecil di skrip e2e karena beban mesin dan uji yang jalan bersamaan:
- `board-e2e`: menunggu proses WebView2 lepas dari folder data sebelum membuka ulang (sebelumnya instance kedua gagal dengan "The requested resource is in use"). Dua pemeriksaan yang goyah (empat task dibuat, detail task tersimpan) sekarang menunggu sampai 5 detik.
- `board-v04-multi-e2e`: perbaikan yang sama, ditambah tunggu `__TAURI_INTERNALS__` 60 detik (dari 20) dan percobaan ulang membuka instance.
- `english-e2e`: tunggu 60 detik dan hapus folder data dengan percobaan ulang.
- Semua: folder data dihapus dengan percobaan ulang karena kunci WebView2 yang tersisa.

## Review tampilan

Reviewer terpisah (subagent, hanya membaca) menemukan lima hal wajib dan sembilan saran. Semua yang wajib dan tujuh saran sudah diperbaiki:
- Wilayah live pemberitahuan membacakan ulang semua pemberitahuan: sekarang hanya yang baru.
- Menutup pemberitahuan terakhir membuat fokus hilang: sekarang kembali ke elemen sebelumnya atau ke judul board.
- Tombol timer yang berganti elemen membuat fokus hilang saat penjaga timer menjeda dari luar: sekarang satu tombol.
- Pemberitahuan tidak terdengar di dalam dialog task: sekarang lewat store bersama.
- Teks galat masih "sudah berhenti": sekarang "sudah dijeda".
- Saran yang diterima: pengumuman ganda di menu kartu dihapus, teks pembaca layar jam berjalan menyebut total sebelumnya, "Total Anda" di task Selesai dan saat hanya ada catatan manual, bantuan tombol Mulai jadi kondisional, "last active" di teks Inggris, bobot tombol sama, judul galat "Timer belum diubah", dan tombol "Tutup semua".
- Tidak diambil: memotong judul panjang dan menampilkan jam di setiap pemberitahuan. Judul dibungkus aman (`overflow-wrap: anywhere`), dan pemberitahuan idle sudah menyebut jamnya.

Kontras (check_contrast, terang / gelap): teks sekunder di latar dialog 6,11 / 8,46; teks di kotak pemberitahuan 15,38 / 13,45; ikon jeda 5,86 / 7,61; garis kotak 3,05 / 3,76; cincin fokus 5,2 / 6,45. Semua lolos AA.

## Batasan dan catatan untuk session utama

- Perbandingan "dipindah ke Selesai setelah segmen dimulai" memakai jam laptop rekan yang memindah.
- Jeda karena idle memakai jam laptop sendiri; kalau Mira dimatikan paksa, waktu sampai 60 detik terakhir bisa hilang dari segmen itu.
- Pemberitahuan hanya di memori; kalau Mira ditutup sebelum layar board dibuka, pemberitahuan dari putaran itu hilang (jedanya tetap tercatat).
- File bersama yang disentuh sesi ini (perkiraan bentrok saat digabung): `TaskDetail.test.tsx` (satu baris judul galat), `BoardScreen.tsx` (satu import dan satu baris), `ProjectBoard.tsx` (aksi timer di `cardActions`), `lib.rs` (pembuatan `BoardRuntime`, spawn penjaga, satu command), `TimeSection.tsx` (sesi foto profil juga menyentuh Avatar di sini; Avatar tidak diubah).
- `scripts/board-e2e.mjs` sekarang hanya menghapus kunci laptop ujinya sendiri dari Credential Manager (sebelumnya menghapus semua kredensial baru, termasuk milik uji sesi lain yang jalan bersamaan), menunggu proses WebView2 lepas dari folder data sebelum membuka ulang, dan memberi waktu tunggu pada dua pemeriksaan yang goyah saat mesin sibuk.
