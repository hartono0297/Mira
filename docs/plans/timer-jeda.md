# Rencana: timer pakai jeda (v0.6)

Permintaan user: "log time manually sepertinya tidak perlu, di disabled dlu ja", "tombol start timer, harusnya bukan stop timer, tapi pause ga sih?", lalu "u atur yang terbaiknya gimana semua".

## Model data: tidak berubah

Catatan waktu tetap seperti v0.4 (`docs/plans/v04-board.md`): satu catatan = satu segmen `start`/`end` milik satu orang. Tidak ada "sesi" baru di dokumen.

- **Mulai timer** = membuka segmen pertama (`board_start_timer`).
- **Jeda** = menutup segmen yang berjalan (`board_stop_timer`, tanpa catatan).
- **Lanjutkan** = membuka segmen baru (`board_start_timer`).
- **Dijeda** = orang itu punya paling tidak satu segmen timer (`manual: false`, tidak dihapus) di task itu dan tidak ada yang berjalan. Total orang itu = jumlah semua segmennya ditambah segmen yang berjalan, jadi waktu terus terakumulasi.

Karena bentuk change sama persis dengan v0.4/v0.5 (`end` diisi oleh pemilik), `rules.rs` tidak diubah dan laptop 0.5 menerima semuanya. Laptop 0.5 menampilkan segmen-segmen itu sebagai catatan biasa, dengan total yang sama.

## Aturan jeda otomatis

| Kejadian | Perilaku | Di mana |
|---|---|---|
| Saya memulai timer di task lain, di proyek mana pun | Segmen saya yang berjalan di task lain ditutup. Di proyek yang sama dalam change yang sama (seperti v0.4); di proyek lain dengan change terpisah per proyek. | `doc.rs` `start_timer`, `commands.rs` `start_timer` |
| Saya memindah task ke Selesai | Segmen saya di task itu ditutup dalam change yang sama | `doc.rs` `move_task` |
| Saya menghapus task | Segmen saya ditutup dalam change yang sama, sebelum task ditandai terhapus | `doc.rs` `delete_task` |
| Rekan memindah task ke Selesai atau menghapusnya | Penjaga timer di laptop saya menutup segmen saya dalam 1 menit | `timer_guard.rs` |
| Mira tertutup, crash, atau laptop tidur | Penjaga timer menulis "terakhir aktif" tiap 60 detik. Kalau saat berjalan atau saat dibuka lagi selisihnya lebih dari 10 menit, segmen saya yang berjalan ditutup pada waktu terakhir aktif | `timer_guard.rs` |
| Ada dua timer saya berjalan (misalnya dari laptop 0.5 lama) | Penjaga timer menyisakan yang paling baru dimulai | `timer_guard.rs` |

Setiap jeda otomatis masuk antrean pemberitahuan di memori (`TimerNotice`), diambil UI lewat `board_take_timer_notices` setelah event `mira://board`. Rekan hanya bisa menutup segmen miliknya sendiri (aturan sinkron), jadi jeda karena task Selesai atau dihapus oleh rekan dilakukan oleh laptop pemilik timer.

Alasan memilih jeda di waktu terakhir aktif saat Mira tertutup: catat manual dimatikan dan catatan tidak bisa disunting, jadi timer yang terus berjalan semalaman hanya bisa diperbaiki dengan menghapus seluruh segmen. Menjeda di waktu terakhir aktif menjaga waktu kerja yang benar.

## Catat waktu manual: dimatikan lewat konstanta

`src/screens/board/timeFeatures.ts`: `MANUAL_TIME_LOG = false`. Tombol dan form "Catat waktu manual" tidak dirender. Command `board_log_time` tetap ada. Catatan manual lama tetap tampil dengan tag "manual", tetap dihitung, dan tetap bisa dihapus pemiliknya.

## Tampilan

- Kepala dialog (`TimerMini.tsx`): belum pernah = "Mulai timer"; berjalan = titik, jam total saya di task ini, tombol "Jeda" (langsung, tanpa kotak catatan); dijeda = "Dijeda" dengan total saya, tombol "Lanjutkan".
- Bagian Waktu (`TimeSection.tsx`): Per orang menampilkan tag "berjalan" atau "dijeda" dan total orang itu.
- Menu klik kanan kartu: "Mulai timer saya", "Jeda timer saya", atau "Lanjutkan timer saya" (`myTimerPaused` di kartu).
- Pemberitahuan jeda otomatis (`TimerNotices.tsx`) di layar board, `role="status"`, bisa ditutup.

## Pembagian kerja

| Bagian | File | Pelaksana |
|---|---|---|
| Inti Rust | `src-tauri/src/board/{doc,commands,model,view,timer_guard}.rs`, tes Rust, `lib.rs` (pendaftaran) | subagent A |
| Dialog task | `TimerMini.tsx`, `TimeSection.tsx`, `time.css`, `timeFormat.ts`, `timeFeatures.ts`, tes terkait | subagent B |
| Kartu dan pemberitahuan | `cardMenu.tsx`, `ProjectBoard.tsx` (aksi timer), `TimerNotices.tsx`, `board-menu.*.ts`, pemasangan di layar board, tes terkait | subagent C |
| Kontrak | `src/api/board.ts`, `src/i18n/board-time.*.ts`, `teksWaktu.ts` | session ini, sebelum subagent mulai |
| E2E dan screenshot | `scripts/board-e2e.mjs`, `scripts/board-v04-multi-e2e.mjs`, `english-e2e` | setelah A, B, C |
| Review tampilan | subagent terpisah | setelah B, C |
