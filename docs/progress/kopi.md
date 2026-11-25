# Laporan Kopi: reputasi yang hanya positif

Tanggal: 25 November 2026. Branch `claude/kopi-943a96`, dari `main` a45d1b3 (v0.5.0). Rencana dan kontrak (aturan akhir): `docs/plans/kopi.md`.

Permintaan user:
- "sistem reputasi seperti kaskus"
- "jangan ada reputasi negatif, kopi aja"
- "bikin status reputasi seperti kopi tersebut rewarding, seperti selesai kerjakan task dll"
- "u atur terbaiknya gimana"

## Ringkasan

| Bagian | Hasil |
|---|---|
| Kopi dari rekan | "Beri kopi" dari menu klik kanan pesan rekan, tombol "Terima kasih ke <nama>" di task yang sudah Selesai, dan tombol di profil orang. Wajib alasan 1 sampai 120 karakter, yang terlihat oleh semua orang di kantor. |
| Kopi dari kerja | Otomatis, dihitung dari board yang sudah tersinkron: task yang ditugaskan orang lain lalu diselesaikan penanggung jawabnya, atau task yang selesai tepat waktu. Task dibuka lagi atau dihapus, Kopi-nya hilang lagi. |
| Tingkatan | Skor = 3 x kopi dari rekan + 1 x kopi dari kerja. Anak baru (0), Andalan (15), Senior (60), Legenda (180). Inggris: Newcomer, Regular, Senior, Legend. Ambang di `src-tauri/src/kopi/tier.rs` (`THRESHOLDS`), bobot di `PEER_WEIGHT` dan `WORK_WEIGHT`. |
| Profil | Dialog profil chat menampilkan tingkatan, progres ke tingkatan berikutnya, kopi dari rekan dan dari kerja terpisah, tombol Beri kopi, dan riwayat "dari siapa, untuk apa". |
| Ikon di samping nama | Ikon cangkir (`IconCoffee` Tabler) dengan 0 sampai 3 garis naik sesuai tingkatan. Di chat hanya untuk Andalan ke atas supaya tidak ramai; di Organisasi (Orang dan Pengguna) untuk semua yang punya kopi. |
| Organisasi > Kopi | Papan "Paling banyak membantu bulan ini" (10 teratas, pilih bulan), cara mendapat kopi, tabel tingkatan, dan untuk superadmin dua isian centang: "Fitur Kopi" dan "Papan bulanan". |
| Kendali superadmin | Mematikan fitur untuk seluruh kantor, mematikan papan saja, menyembunyikan atau menampilkan lagi satu pemberian dari riwayat profil. Semuanya record bertanda tangan superadmin. |
| Sinkron | Topik fitur baru `kopi` lewat kontrak `network/feature.rs`. Record bertanda tangan amplop `documents::envelope`, domain `mira-kopi-v1`. |

## Aturan (ringkas)

Kopi dari rekan:
- Paling banyak 3 per pemberi per hari lokal. Hari diambil dari waktu bertanda tangan yang memuat offset lokal pemberi, dan dicek di Rust.
- Paling banyak 4 dari satu pemberi ke satu penerima per bulan.
- Tidak ke diri sendiri. Sekali per pesan, sekali per task, sekali per orang per hari dari profil.
- Tamu boleh menerima, tidak boleh memberi.
- Pemberian bertanggal sebelum 24 November 2026, atau sebelum pemberi atau penerima bergabung, tidak dihitung.
- Pemberian yang disembunyikan tetap memakai jatah harian pemberi, supaya hasilnya stabil.

Kopi dari kerja:
- Hanya kalau yang memindahkan task ke Selesai adalah penanggung jawabnya sendiri.
- Proyeknya punya lebih dari satu orang.
- Alasan "Task dari rekan selesai": penugasnya orang lain.
- Alasan "Selesai tepat waktu": tenggat paling jauh 14 hari setelah diset, diset paling lambat 1 jam sebelum selesai, dan selesai paling lambat di hari tenggat (dihitung sampai akhir hari tenggat di zona UTC-12, supaya zona mana pun tidak dirugikan).
- Task yang dibuat dan diselesaikan sendiri dalam kurang dari 1 jam tidak dihitung.
- Paling banyak 3 per orang per hari (UTC), satu per task. Subtask diabaikan.

## Keputusan yang saya ambil sendiri

| Keputusan | Alasan |
|---|---|
| Nama "Kopi", istilah Inggris "Coffee". Huruf besar hanya untuk nama fitur, judul tab, dan isian pengaturan; satuan di kalimat huruf kecil ("Beri kopi", "17 kopi"). | Sesuai brief, dan seragam setelah review tampilan. |
| Bobot rekan 3, kerja 1. Ambang 15, 60, 180. | Kopi dari rekan lebih bermakna dan lebih jarang. Dengan 3 kopi kerja per hari maksimum, Legenda tetap butuh apresiasi rekan. |
| Kopi dari kerja dihitung langsung dari board di laptop yang bisa membaca proyeknya. Untuk proyek yang tidak terbaca, laptop penerima menerbitkan **snapshot kerja** bertanda tangan (`work`). | Board hanya tersinkron ke anggota proyek, jadi tanpa record laptop di luar proyek akan menghitung angka lain. Laptop yang bisa membaca proyek selalu memakai board sendiri dan mengabaikan snapshot. Snapshot dicek ke data organisasi (proyek ada, lebih dari satu orang, penulis anggota proyek, waktu masuk akal) dan tunduk ke batas harian. |
| Record dari laptop pemberi, bukan dari penerima. Penerima tidak bisa menulis kopi rekan untuk dirinya. | Tanda tangan pemberi adalah bukti. |
| Tamu menerima kopi tapi tidak memberi. Tamu hanya menerima record pengaturan, pemberian untuk dirinya, dan sembunyikan untuk pemberian itu. | Tamu orang luar; reputasi kantor dinilai oleh anggota. Alasan pemberian ke orang lain tidak bocor ke tamu. |
| Tabel SQLite dibuat dengan `CREATE TABLE IF NOT EXISTS` saat pertama dipakai (`kopi::store::ensure_schema`), tanpa nomor migrasi. | Sesi chat-sticker dan dept-divisi juga menambah migrasi v10/v11. Tabel tanpa nomor tidak bentrok saat digabung. |
| Tidak perlu gerbang versi. | Laptop 0.5.x menghentikan topik yang tidak dikenal dengan diam (`FEATURE_STOP_UNKNOWN_TOPIC` di `network/node.rs`), tanpa error berulang. Record jenis baru dari versi yang lebih baru hanya ditolak sementara di 0.6 (`sync::from_newer_version`), supaya diterima setelah diperbarui. |
| Tidak mengubah `src-tauri/src/permissions/` dan `src-tauri/src/board/`. | Peran dibaca lewat `permissions::load_state` dan `OrgState`. Board dibaca lewat API baca yang sudah ada. |
| Perhitungan disimpan di cache (`KopiCache`) dengan kunci penanda record kopi, board, dan organisasi. Layar menggabungkan event dalam 2 detik dan hanya satu panggilan overview berjalan pada satu waktu. | Review keamanan menemukan bahwa setiap panggilan memuat semua dokumen board di dalam kunci inti. |
| Sakelar pengaturan memakai isian centang biasa, seperti pengaturan pengingat. | Konsisten dengan pola yang sudah ada. |
| Profil Organisasi: ikon di samping nama di tab Orang dan Pengguna. Tidak ada dialog profil baru di Organisasi. | Organisasi belum punya tampilan profil per orang. Riwayat lengkap ada di dialog profil chat. |

## Keamanan

Review terpisah oleh subagent (anti-akal dan keamanan). Semua temuan sudah ditangani, dengan tes unit untuk masing-masing:

| Temuan | Perbaikan |
|---|---|
| Snapshot palsu bisa "mencuri" kopi kerja orang lain (dedup per task tanpa melihat penerima). | Event dari board selalu menang; unik per (proyek, task, penerima). |
| Pemberian bisa dimundurkan tanpa batas dengan mengubah jam laptop. | Diabaikan sebelum tanggal fitur atau tanggal bergabung; batas 4 per pasangan per bulan. |
| Orang lain bisa memindahkan task ke Selesai atas nama penanggung jawab. | Hanya penanggung jawab sendiri yang mendapat kopi kerja (`done_by`). |
| Pemeriksaan anggota proyek untuk snapshot berbeda dari board, sehingga angka bisa beda antar laptop. | Satu himpunan yang sama (`work::people`) di kedua jalur. |
| Snapshot dengan waktu selesai di luar rentang yang mungkin. | Dibuang kalau setelah waktu snapshot, sebelum proyek dibuat, atau sebelum penulis masuk proyek. |
| "Tepat waktu" terlalu longgar (tenggat 2099). | Tenggat paling jauh 14 hari dan diset paling lambat 1 jam sebelum selesai. |
| Banjir record. | Saat masuk: paling banyak 6 pemberian tersimpan per penulis per hari, 200 record superadmin per hari. |
| Jam yang pernah melompat ke depan mengunci record berikutnya. | Record lama bertanggal masa depan dipensiunkan, record baru memakai waktu sekarang. |
| Record rusak diminta ulang setiap sinkron. | Diingat permanen; penolakan karena peran dicoba lagi dan dicatat sekali. |
| Urutan papan memakai nama yang bisa beda per laptop. | Urutan seri memakai kunci publik. |

Batasan yang tersisa:
- Jam dan zona waktu laptop pemberi bisa diubah, jadi pemberi masih bisa memakai jatah hari atau bulan lain sejak tanggal fitur atau tanggal bergabung (tetap 3 per hari dan 4 per penerima per bulan).
- Anggota proyek yang tidak terbaca oleh laptop lain bisa mengklaim task yang masuk akal waktunya tapi bukan miliknya di snapshot. Laptop yang membaca proyek tidak tertipu, dan dampaknya dibatasi 3 per hari.
- Metadata terlihat semua anggota: id proyek dan task di snapshot, target task, dan fakta bahwa dua orang pernah bertukar pesan (target pesan). Isi pesan dan judul task tidak ikut.
- Pengaturan dan sembunyikan: yang terbaru menurut waktu superadmin. Jam superadmin yang salah bisa membuat perubahan lama menang.
- Orang yang keluar lalu bergabung lagi kehilangan kopi rekan dari sebelum bergabung ulang.

## Tampilan

Review tampilan terpisah menemukan 18 hal; semuanya sudah diperbaiki:
- istilah huruf besar dan kecil diseragamkan;
- pemberian yang berhasil diumumkan ke pembaca layar ("Kopi terkirim untuk Budi.");
- fokus tidak hilang saat tombol sedang sibuk (`aria-disabled`, bukan `disabled`);
- ikon di chat hanya untuk Andalan ke atas;
- entri tersembunyi memakai bingkai putus-putus dan label "Disembunyikan", tanpa coretan;
- kepala riwayat berbunyi "Ayu, lewat pesan chat";
- tombol minimal 44 px;
- papan tidak berkedip saat dimuat ulang.

Semua pasangan warna baru dicek dengan `check_contrast`, dan semuanya lulus AA di tema terang dan gelap. Tidak ada em dash dan tidak ada emoji.

## Hasil uji

| Pemeriksaan | Hasil |
|---|---|
| `cargo test` (seluruh crate) | 1301 lulus, 2 gagal, 7 diabaikan. Yang gagal adalah `documents::watch::excel_save_sequence_settles_once` dan `differently_cased_path_still_matches`, tes pemantau file berbasis waktu yang tidak disentuh sesi ini. Saat dijalankan ulang sendiri: `cargo test --lib documents::watch` 21/21 lulus. Run penuh berlangsung 48 menit di PC yang sedang menjalankan banyak build sesi lain. |
| `cargo test --lib kopi::` | 78 lulus |
| `cargo clippy --all-targets -- -D warnings` | bersih |
| `npx tsc --noEmit` | bersih |
| Vitest | Run penuh (`--pool=threads --maxWorkers=2`): 1798 lulus, 1 gagal karena timeout 5 detik (`errors.test.ts` "setiap pesan di tabel masih ada di sumber Rust" butuh 62 detik di mesin sibuk; sendiri dengan `--testTimeout`: 11/11 lulus). `App.test.tsx`, `components.en.test.tsx`, `UpdateContext.test.tsx` gagal dimuat karena `pdfjs-dist/...?url` di luar worktree (junction `node_modules`, sama seperti laporan v04-board); dengan konfigurasi sementara `server.fs.allow` (langsung dihapus): 28/28 lulus. |
| `scripts/kopi-e2e.mjs` (dua instance, build debug) | 42/42 |
| `english-e2e.mjs` | 39/39 |
| `chat-e2e.mjs`, `board-e2e.mjs`, `org-e2e.mjs` | E2E_LAMA |

Isi `kopi-e2e` (A = Ayu superadmin, B = Budi anggota):
1. A beri kopi ke B dari menu klik kanan pesan. B melihatnya di profil, lengkap dengan alasan dan nama A. Menu di pesan yang sama menjadi "Sudah diberi kopi".
2. A menugaskan task ke B, dan B memindahkannya ke Selesai. Kopi kerja B = 1 (alasan `assigned`) di kedua laptop.
3. Task dibuka lagi: kopi kerja kembali 0 di kedua laptop.
4. Batas harian: pemberian ke diri sendiri dan pemberian kedua untuk pesan yang sama ditolak. Pemberian ke-4 hari itu ditolak.
5. A mematikan fitur lewat Organisasi > Kopi. Di B menu hilang dan pemberian ditolak. Setelah dinyalakan lagi, B bisa memberi.
6. Tampilan Inggris: "Coffee", "Level", "Newcomer".

Screenshot di `docs/progress/screenshots/kopi/`:
- Profil: `kopi-profil-terang.png`, `kopi-profil-gelap.png`, `kopi-profil-en.png`.
- Panel Organisasi: `kopi-panel-terang.png`, `kopi-panel-gelap.png`, `kopi-panel-en.png`, `kopi-panel-konfirmasi-terang.png`, `kopi-panel-mati-terang.png`.
- Dialog dan task: `kopi-dialog-beri-terang.png`, `kopi-task-terima-kasih-terang.png`.

Catatan lingkungan e2e:
- Build debug di PC ini butuh sekitar 20 detik sebelum WebView2 meninggalkan `about:blank`, dan Playwright kadang memegang target kosong yang lama. `kopi-e2e.mjs` menunggu halaman aplikasi di `/json/list`, lalu menyambung ulang kalau perlu.
- `chat-e2e.mjs` tidak memakai `E2E_PORT_OFFSET` (CDP tetap 9342), jadi bisa bentrok dengan instance sesi lain.
- Semua data uji ada di `D:\mira-tmp\kopi` dan dihapus setelah selesai.

## Untuk penggabung

**File di luar folder Kopi (perubahan kecil):**
- `src-tauri/src/lib.rs`: `pub mod kopi;`, dua baris registrasi (`kopi::sync::register`, `kopi::runtime::start`) sebelum chat, dan 6 command `kopi_*` setelah `chat_set_folded`. Akhir baris CRLF dipertahankan.
- `src-tauri/src/network/feature.rs`: konstanta `TOPIC_KOPI` dan tes topik.
- `src/screens/chat/MessageItem.tsx` (6 baris): item menu dan ikon di samping nama.
- `src/screens/chat/ProfileDialog.tsx` (2 baris): bagian Kopi.
- `src/screens/board/TaskDetail.tsx` (2 baris): tombol terima kasih.
- `src/screens/org/OrgScreen.tsx` (5 baris): tab Kopi.
- `src/screens/org/PeoplePanel.tsx` dan `UsersPanel.tsx`: ikon di samping nama.
- `src/screens/org/OrgScreen.test.tsx` dan `src/i18n/noIndonesian.test.tsx`: tab Kopi di daftar tab yang diharapkan.
- `src/i18n/errors-rust.id.ts` dan `.en.ts`: pesan error Kopi.
- `package.json`: skrip `test:e2e-kopi`.

**Tanpa migrasi bernomor.** Tabel `kopi_records`, `kopi_seen`, dan `kopi_published` dibuat sendiri.

**Kemungkinan bentrok:**
- `MessageItem.tsx` dengan sesi chat-sticker.
- `OrgScreen.tsx`, `PeoplePanel.tsx`, dan `UsersPanel.tsx` dengan sesi dept-divisi, perbaikan bergabung, dan foto profil.
- Daftar command di `lib.rs` dengan sesi chat-sticker.

**File baru:**
- Rust: `src-tauri/src/kopi/` (types, record, store, rules, work, tier, sync, runtime, view, commands, `commands/tests.rs`).
- Frontend: `src/api/kopi.ts`, `src/components/Kopi*.tsx`, `useKopi.ts`, `kopiText.ts`, `kopi.css`, `src/screens/org/KopiBoardPanel.tsx`, `kopi-board.css`, `src/screens/chat/kopiMenu.tsx`, `src/screens/board/TaskKopiThanks.tsx`, `task-kopi.css`, `src/i18n/kopi*.ts`.
- Uji: `scripts/kopi-e2e.mjs`.

## Belum dicek atau masih kurang

- Belum diuji antar laptop sungguhan dan belum di macOS. Uji dua instance berjalan di satu PC.
- Laptop 0.5.x berdampingan dengan 0.6 hanya diperiksa dari kode transport, belum dengan dua versi yang benar-benar berjalan.
- Dialog beri kopi dan tombol task hanya di-screenshot dalam tema terang.
- Notifikasi Windows saat menerima kopi belum dibuat. Kopi tampil di profil dan papan.
