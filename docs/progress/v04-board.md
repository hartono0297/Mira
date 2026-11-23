# Laporan Board v0.4: subtask, pelacakan waktu, dialog task baru

Tanggal: 24 November 2026. Branch `claude/v04-board-85c86b`, dari `main` e7def11. Rencana dan kontrak: `docs/plans/v04-board.md`. Mockup: `design/v04-detail-task.html`.

Permintaan user:
- "board, setiap task, bisa tambahin sub task kecil"
- "setiap task di board, ada tracking berapa lama dikerjakannya dll"
- "ubah ui ux tampilan task, bikin lebih minimalist dan modern, tapi mudah dibaca user"

## Ringkasan

| Bagian | Hasil |
|---|---|
| Subtask | Daftar centang di dalam task. Bisa tambah, centang, ubah judul, hapus, urutkan ulang (seret pointer atau Alt+Panah), dan diberi penanggung jawab dari anggota proyek. Kartu board menampilkan "2/5". Tersinkron antar laptop, aman saat konflik. |
| Durasi per status | Dihitung dari riwayat perpindahan yang sudah ada: lama di To do, Dikerjakan, Selesai, dan cycle time (dibuat sampai selesai). |
| Timer per orang | Mulai dan Hentikan, dengan catatan opsional. Juga "Catat waktu manual" (misalnya "1j 30m"). Total per orang dan per task, tersinkron. Kartu menampilkan total waktu dan titik hijau kalau ada timer berjalan. |
| Dialog detail task | Ditulis ulang sesuai mockup arah A: satu kolom, judul besar yang bisa diedit langsung, properti sebagai baris "label: nilai", lalu Subtask, Deskripsi, Waktu, dan tab Komentar/Aktivitas. Hapus task pindah ke menu Lainnya dengan konfirmasi. Tenggat tidak lagi memakai isian tanggal format Amerika. |
| Kompatibilitas v0.3 | Laptop v0.3 menolak subtask dan catatan waktu di task lama. Setelah diperbarui ke v0.4, catatan penolakan dikosongkan sekali supaya laptop itu menyusul. Disarankan semua laptop diperbarui bersamaan. |

## Pilihan mockup

Dua arah dibuat di `design/v04-detail-task.html`, masing-masing terang dan gelap, dan bisa dicoba dengan keyboard:
- **A, satu kolom ala dokumen** (dipilih). Properti di atas dalam grid dua kolom, timer di kepala dialog.
- **B, dua kolom** dengan panel properti dan waktu di kanan.

Alasan memilih A:
- Satu jalur baca. Label properti punya ruang 136 px, jadi nama dan tanggal tidak cepat terpotong.
- Urutan Tab sama dengan urutan tampilan. Status hanya 4 kali Tab dari kontrol pertama. Di B, Tab melewati seluruh kolom kiri (termasuk komentar) sebelum sampai ke Status.
- Di layar 1366x768, A menampilkan subtask, deskripsi, Status, dan timer tanpa gulir. B lebih padat, tapi satu-satunya bagian Waktu yang dipakai setiap hari adalah timer, dan di A timer selalu terlihat di kepala dialog.
- Garis lebih sedikit. Dialog lama punya sekitar 13 kotak dan garis, A tinggal 3 garis pemisah.
- B butuh tata letak kedua untuk jendela di bawah 760 px.

## Yang dibuat

**Inti Rust (`src-tauri/src/board/`)**
- `doc.rs`: map `subtasks` dan `time` di setiap task (bentuknya di `docs/plans/v04-board.md` bagian 1). Operasinya: tambah, ubah, urutkan, dan hapus subtask; mulai dan hentikan timer; catat waktu manual; hapus catatan sendiri. Id subtask dan catatan terikat ke pembuatnya (`derive_subtask_id`, `derive_time_id`). Ada 5 jenis riwayat baru: `subtask_added`, `subtask_done`, `subtask_reopened`, `subtask_deleted`, `time_logged`.
- `timing.rs` (baru): durasi per status, cycle time, total per orang, dan deteksi jam yang tidak cocok.
- `rules.rs`: penilaian change rekan untuk subtask dan catatan waktu, lalu diperketat setelah review keamanan (lihat bagian Keamanan).
- `rank.rs`: batas panjang rank 64 karakter, tanpa rekursi, dan sebar ulang hanya tetangga yang perlu.
- `model.rs`, `view.rs`: field baru di kartu dan detail. Validasi judul subtask, catatan waktu, dan menit.
- `commands.rs`: 8 command baru (`board_add_subtask`, `board_update_subtask`, `board_move_subtask`, `board_delete_subtask`, `board_start_timer`, `board_stop_timer`, `board_log_time`, `board_delete_time_entry`). Semuanya butuh hak ubah task. Hapus catatan waktu hanya untuk catatan sendiri.
- `feature.rs`: `reset_rejected_once` mengosongkan `board_rejected` sekali (penanda `board.rules_version = 2` di `settings`).
- `sync.rs`: memakai pemeriksaan bentuk per task yang disentuh.

**Tampilan (`src/screens/board/`, `src/api/board.ts`)**
- `TaskDetail.tsx` ditulis ulang, ditambah komponen baru:
  - `PropertyRow`, `TaskPopover` (menu dan pilihan kecil dengan fokus berputar), `DuePicker`, `LabelPicker`, `TaskMoreMenu`, `DetailTabs`, `dueText`;
  - `Subtasks` dengan `useListDrag` (seret pointer, gulir otomatis di tepi, Alt+Panah);
  - `TimeSection` dan `TimerMini`;
  - `timeFormat` dan `useNow`.
- Teks baru dikumpulkan di `teks.ts`, yang mengekspor ulang `teksDialog.ts`, `teksSubtask.ts`, dan `teksWaktu.ts`.
- `BoardCard.tsx`: ikon centang dengan "2/5", ikon jam dengan total waktu ("3j 20m"), dan titik hijau statis kalau ada timer berjalan. Pembaca layar mendengar "1 dari 3 subtask selesai, waktu tercatat 3 jam 20 menit, timer berjalan".
- `taskActivity.ts`: kalimat untuk riwayat baru, misalnya "Anda menyelesaikan subtask ..." dan "Anda mencatat 1 jam 30 menit".

**Uji ujung ke ujung**
- `scripts/board-v04-multi-e2e.mjs` (baru, `npm run test:e2e-board-v04`): dua instance A dan B yang bergabung ke kantor yang sama.
- `board-e2e.mjs` dan `board-sync-e2e.mjs` disesuaikan ke dialog baru. Penanggung jawab, prioritas, tenggat, label, subtask, timer, dan hapus task sekarang diisi lewat UI.

## Perilaku yang tetap dari dialog lama

Draf judul, deskripsi, label, dan komentar tidak tertimpa saat muat ulang. Ada pemberitahuan kalau rekan mengubah judul atau deskripsi. Kalau task dihapus, proyek hilang, atau izin dicabut, draf ditampilkan untuk disalin. Penanggung jawab yang bukan anggota proyek lagi tetap tampil dengan keterangan. Tamu hanya membaca. Semua dibuktikan tes `TaskDetail.test.tsx`, dan `board-sync-e2e` menguji draf deskripsi saat judul diubah dari inti.

Urutan Escape: pertama memulihkan isian yang sedang diubah (judul, deskripsi, judul subtask), lalu menutup menu atau kotak kecil, lalu menutup dialog. Menutup dialog saat masih ada ketikan yang belum terkirim (subtask baru, catatan waktu, komentar) menampilkan peringatan.

## Pelacakan waktu dan jam laptop

- **Durasi per status** dihitung dari riwayat `created` dan `moved`, diurutkan menurut waktu. Waktu di riwayat ditulis dengan jam laptop yang membuat perubahan. Kalau jam laptop Budi 10 menit lebih cepat, perpindahan yang ia lakukan tercatat 10 menit lebih lambat, jadi durasi bisa bergeser sebesar selisih itu. Kalau ada waktu yang lebih dari 5 menit di masa depan, atau urutan riwayat tidak cocok dengan urutan waktu, bagian Waktu menampilkan: "Jam di beberapa laptop tampaknya tidak sama, jadi durasi per status bisa meleset. Timer dan catatan manual tidak terpengaruh, karena mulai dan berhentinya dicatat di laptop yang sama."
- **Timer** tidak terpengaruh selisih jam antar laptop. Mulai dan berhenti ditulis oleh laptop yang sama, karena satu orang = satu kunci laptop. Kalau jam laptop itu mundur saat timer berjalan, catatannya berakhir di waktu mulai (0 detik), supaya rekan tidak menolaknya.
- Timer yang sedang berjalan dihitung dengan jam laptop yang melihat, dengan batas bawah 0.
- Durasi status bisa dipalsukan oleh rekan yang menulis riwayat dengan waktu palsu atas namanya sendiri. Ini dicatat sebagai batasan, karena isi riwayat tidak bisa diperiksa terhadap jam yang sebenarnya.

## Keputusan yang saya ambil sendiri

| Keputusan | Alasan |
|---|---|
| Penanggung jawab subtask dibuat sekarang, tidak ditunda. | Cukup ringan: satu kolom string atau null, dicek ke anggota proyek seperti penanggung jawab task. |
| Judul subtask berupa string (yang terakhir menang), bukan teks Automerge. | Judul pendek. Penggabungan per karakter tidak sebanding dengan aturan sinkron tambahan. |
| Hapus subtask tanpa konfirmasi, diumumkan ke pembaca layar. | Kecil dan cepat diulang. Hapus task tetap pakai konfirmasi. |
| Satu timer per orang per task. Mulai timer menghentikan timer saya yang lain di proyek yang sama, dalam change yang sama. | Mencegah lupa mematikan timer di task lain. Lintas proyek tidak dihentikan, karena butuh change di beberapa dokumen. |
| Timer yang berhenti otomatis tetap menulis riwayat `time_logged` di task-nya. | Supaya riwayat task itu lengkap. |
| Catatan waktu tidak bisa diubah, hanya dihapus lalu dicatat ulang. | Lebih sederhana dan aman. Mengubah catatan butuh command dan aturan sinkron tambahan. |
| Ganti judul subtask, ganti penanggung jawab subtask, timer, dan hapus catatan tidak menulis riwayat dan tidak mengubah `updated_at` task. | Riwayat tetap terbaca. Yang dicatat hanya tambah, selesai, buka lagi, dan hapus subtask. |
| Batas lokal 100 subtask hidup dan 2000 catatan hidup per task. Rekan dibatasi 500 dan 5000, termasuk yang terhapus. Laptop ini juga berhenti menambah di batas rekan. | Batas rekan mencegah banjir data. Batas lokal yang sama memastikan change jujur tidak pernah ditolak rekan. |
| Durasi pendek ditulis "45m", "3j 20m", "2hr 5j" (hr = hari). | "2h" bisa terbaca 2 jam. |
| Tenggat memakai pilihan sendiri (Hari ini, Besok, Jumat ini, Senin depan, isian hh/bb/tttt), bukan isian tanggal bawaan. | Isian bawaan WebView2 memakai format Amerika (mm/dd/yyyy). |
| Menu dan pilihan kecil dibuat sendiri (`TaskPopover.tsx`), bukan Radix Popover. | Repo hanya punya `@radix-ui/react-dialog`, dan `package.json` tidak diubah. |
| Titik timer statis, tanpa denyut. | Animasi tanpa henti mengganggu dan melanggar checklist antislop. Titik sudah cukup menandai keadaan nyata. |
| Kontrak teks: `teks.ts` jadi titik masuk, isinya terpisah per area. | Tiga agen menulis teks bersamaan tanpa mengedit file yang sama. Penerjemah cukup membuka satu folder. |

## Keamanan

Dua putaran review oleh subagent terpisah: satu untuk tampilan dan aksesibilitas, satu untuk keamanan inti.

**Review keamanan** menemukan celah yang sebagian sudah ada sejak v0.3, lalu semuanya ditutup di commit `88392fe`:

| Celah | Perbaikan |
|---|---|
| `pred` di op Put/Make tidak diperiksa, jadi satu op bisa membuang nilai di kunci lain objek yang sama. Contoh: menghapus semua subtask dan catatan waktu task orang lain, juga komentar dan riwayat (sejak v0.3). | `pred` harus nilai di kunci yang sama pada dependensi change, atau op lebih awal di change itu. Kunci yang wajib baru harus tanpa `pred`. |
| Pemalsuan pemilik catatan waktu atau pembuat subtask lewat dua nilai di kunci yang sama dalam satu change. | Objek baru hanya boleh satu nilai per kunci. Pemeriksaan pemilik membaca semua nilai. |
| Change bisa menyentuh objek yang tidak ada di dependensinya, sehingga laptop berbeda menilai berbeda dan dokumen bercabang. | Objek dan elemen teks yang disentuh harus terlihat pada dependensi change. Semua cek "sudah ada" memakai dependensi. |
| Rank sangat panjang dari rekan membuat aplikasi crash (rekursi, sejak v0.3). | Batas 64 karakter, `midpoint` iteratif, rank rusak di dokumen lama dipulihkan sendiri. |
| `check_shape` memeriksa seluruh dokumen, jadi dua change sah bisa ditolak berbeda menurut urutan datang, dan laptop yang naik dari v0.3 bisa membeku. | Hanya task yang disentuh change yang diperiksa ketat. Pembacaan memilih nilai valid dari konflik dan melewati entri rusak. |
| Subtask atau catatan milik sendiri yang dihapus bisa dihidupkan lagi lewat salinan konflik. | Id dianggap terhapus kalau salinan mana pun terhapus. |
| Jumlah dan isi dari rekan tanpa batas. | Batas 500 subtask dan 5000 catatan per task. Validasi panjang teks, waktu RFC 3339, `end` tidak kembali null, `done_by` hanya penulis, dan daftar putih kunci. |

Batasan yang tersisa dan dicatat di `rules.rs`:
- Riwayat palsu atas nama sendiri bisa menggeser durasi status.
- Rekan bisa memenuhi batas lokal 100 subtask hidup.
- Selama versi masih campur, laptop v0.3 bisa menulis nilai yang sekarang ditolak (misalnya rank panjang).

**Review tampilan** menemukan 22 hal. Semua yang high dan medium sudah diperbaiki:
- Escape di subtask sempat menutup seluruh dialog.
- Latar gelap konfirmasi hapus sempat ada di bawah dialog.
- Region pengumuman sempat tersembunyi saat kosong.
- Fokus hilang setelah simpan deskripsi.
- Ketikan saat simpan sempat terhapus.
- `.td-check` didefinisikan ganda.
- Titik timer di kartu berdenyut dan berbeda dari dialog.
- Popover kolom kanan menimbulkan gulir mendatar.
- Dua jenis menu yang berbeda.
- Seret subtask tanpa gulir otomatis.

Hal low yang juga dikerjakan: teks dipindah ke `teks*.ts`, kelas ganda digabung ke `task.css`, pasangan tombol "Mulai timer"/"Hentikan timer", dan landmark ganda.

## Kompatibilitas dengan v0.3

- Laptop v0.3 menolak permanen change yang menambah subtask atau catatan waktu ke task lama. Change berikutnya dari orang yang sama di proyek itu tertahan menunggu induknya. Task baru dari v0.4 tetap diterima v0.3, tapi subtask dan timernya tidak tampil di sana.
- Saat v0.4 pertama kali jalan, `board_rejected` dikosongkan sekali. Rekan lalu menawarkan ulang record yang dulu ditolak, aturan baru menilainya, dan change yang tertahan ikut masuk.
- Ini diuji di `feature/convergence_tests.rs`: record yang ditolak aturan lama diminta lagi setelah pembaruan.
- Saran untuk kantor: perbarui semua laptop ke v0.4 bersamaan lewat pembaruan dalam aplikasi.

## Hasil uji

Semua angka dari run terakhir di sesi ini, pada commit `88392fe` ditambah tes jam mundur.

| Pemeriksaan | Hasil |
|---|---|
| `cargo test` (seluruh crate) | 1069 lulus, 0 gagal, 7 diabaikan (tes keyring, firewall, mDNS sungguhan, sama seperti sebelumnya) |
| `cargo clippy --all-targets -- -D warnings` | tanpa peringatan |
| `npx tsc --noEmit` | tanpa error |
| Vitest | 70 berkas, 1126 tes lulus (lihat catatan lingkungan di bawah) |
| `board-e2e.mjs` (build debug) | 23/23 |
| `board-sync-e2e.mjs` | 26/26 |
| `board-v04-multi-e2e.mjs` (dua instance) | 29/29 |

**Isi `board-v04-multi-e2e`:**
- A membuat 3 subtask, mencentang 1, mengurutkan, dan memberi B satu subtask. B melihat urutan, centang, dan penanggung jawab yang sama, dan kartu di B menampilkan "1/3".
- B mencentang dan menambah subtask, lalu A melihat 2/4.
- Timer A terlihat berjalan di kartu B. A menghentikannya, B mencatat 30 menit manual, dan total per orang serta total task sama di kedua sisi.
- Task dipindah ke Selesai: `cycleSecs` sama di A dan B.
- B mencoba menghapus catatan waktu A dan ditolak.
- Konflik offline: B mengubah judul subtask X saat A mati, A menghapus X saat B mati. Setelah keduanya menyala, daftar subtask sama, X tetap terhapus, dan subtask tambahan dari kedua sisi ada.

**Catatan lingkungan Vitest.**
- Worktree ini tidak punya `node_modules` sendiri, dan `npm run build` gagal tanpanya (plugin pdfjs mencari `node_modules/pdfjs-dist/cmaps` di dalam worktree). Selama build dan uji, saya memasang junction `node_modules` ke `D:\GitHub\ChatCompany\node_modules` tanpa menyalin isinya. Setelah selesai, junction dilepas dengan `rmdir` supaya penghapusan worktree tidak ikut menghapus isi `node_modules` induk. Kalau build lagi di worktree ini, pasang ulang: `New-Item -ItemType Junction -Path node_modules -Target D:\GitHub\ChatCompany\node_modules`, lalu lepas dengan `cmd /c rmdir node_modules` (jangan `Remove-Item -Recurse`).
- Dengan junction itu, `src/App.test.tsx` dan `src/updates/UpdateContext.test.tsx` tetap gagal dimuat di run penuh: Vite menolak `pdfjs-dist/.../pdf.worker.min.mjs?url`, karena path aslinya di luar worktree.
- Dengan konfigurasi sementara yang mengizinkan folder itu (`server.fs.allow`, langsung dihapus setelah dipakai), kedua berkas lulus (24 tes). Jadi 1102 + 24 = 1126 tes.
- Di checkout utama, `node_modules` ada di dalam root, jadi masalah ini tidak muncul.

**Catatan uji ujung ke ujung.**
- Run pertama `board-sync-e2e` gagal di langkah restart: kunci laptop uji sudah hilang dari Windows Credential Manager.
- Penyebab yang paling mungkin: skrip uji sesi lain yang berjalan bersamaan membersihkan kunci uji yang dibuat setelah skripnya mulai.
- Run ulang di build terakhir lulus 26/26. Semua uji memakai `E2E_PORT_OFFSET` 700 sampai 820 dan folder data di scratchpad sesi, yang sudah dihapus.

## Screenshot

`docs/progress/screenshots/v04-board/`:
- Dialog baru: `v04-dialog-terang.png`, `v04-dialog-gelap.png`.
- Dua instance: `v04-02-detail-task-{a,b}-{terang,gelap}.png` (data dari laptop lain), `v04-01-board-kartu-b.png` (kartu "1/3" di B), `v04-03-setelah-konflik-{a,b}-terang.png`.
- Kartu dengan progres dan waktu: `t3-12-kartu-subtask-terang.png`.
- Board, seret, Task saya (terang dan gelap): `t3-01` sampai `t3-11`.
- `sinkron/`: alur sinkron satu laptop dengan dialog baru (`sb-04`, `sb-09`, `sb-11` untuk detail task).

## Belum dicek atau masih kurang

- Belum diuji di macOS. Seret subtask memakai pointer event seperti seret kartu, jadi seharusnya jalan di WKWebView, tapi belum dicoba.
- Seret subtask dengan kursor Windows sungguhan belum diuji; yang diuji tes jsdom dan Alt+Panah.
- Uji dua instance berjalan di satu PC. Belum diuji antar laptop sungguhan.
- Timer lintas proyek tidak saling menghentikan.
- Menu penanggung jawab subtask selalu terbuka ke bawah, jadi bisa terpotong di bagian bawah area dialog yang menggulir.
- `docs/progress/sinkron-board.md` bagian Keamanan belum diperbarui. Aturan terbaru ada di kepala `src-tauri/src/board/rules.rs` dan di laporan ini.

## Untuk penggabung

- **File di luar `board/`:**
  - `src-tauri/src/lib.rs`: 8 baris registrasi command setelah `board_add_comment`.
  - `package.json`: satu skrip `test:e2e-board-v04`.
  - `src/screens/shell/navCounts.test.ts` dan `useNavCounts.test.tsx`: fixture `TaskCard` mendapat field baru.
- **Tidak ada migrasi baru.** Penanda `board.rules_version` memakai tabel `settings` yang sudah ada.
- **`docs/plans/v04-board.md`:** bagian 2 berisi aturan awal. Aturan final yang lebih ketat ada di `rules.rs`.
- **Akhir baris:** berkas Rust board memakai LF seperti di index, `lib.rs` tetap CRLF.
- **Menu klik kanan untuk board** (sesi berikutnya):
  - Aksi dialog bisa dipakai ulang lewat `boardApi` dan komponen `TaskMoreMenu`/`TaskPopover`.
  - Nama aksesibel tombol: "Lainnya", "Hapus task", "Mulai timer", "Hentikan timer", "Tambah subtask".
- **Bahasa Inggris:** teks baru board ada di `src/screens/board/teks*.ts`. Teks lama board masih di `format.ts` dan komponennya. Pesan error inti ada di `model.rs`, `doc.rs`, dan `commands.rs`.
