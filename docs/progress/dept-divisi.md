# Laporan: Departemen saya dan Divisi

Branch `claude/dept-divisi-7c07a6`, dari `main` a45d1b3 (v0.5.0). Rencana dan kontrak: `docs/plans/dept-divisi.md`.

Permintaan user: "untuk admin department, apakah sudah ada modul untuk setting2 departmentnya? seperti role dll", "gw mau ada juga user nya bisa bikin group division sendiri, nanti bisa atur divisionya sendiri, seperti IT developer divisi mobile gitu", "harusnya yang bisa bikin division itu admin per department nya masing2", dan "u atur yang terbaiknya gimana".

## Ringkasan

- **Tab "Departemen saya"** di Organisasi. Tampil untuk superadmin (bisa memilih departemen mana pun), admin departemen, dan kepala divisi. Urutannya dari atas:
  - pemilih departemen;
  - pemberitahuan gerbang versi, lengkap dengan daftar laptop yang belum diperbarui;
  - Divisi;
  - anggota departemen (nama, label, peran, divisi, status online);
  - permintaan bergabung dan kode undangan departemen itu (komponen lama dengan filter departemen);
  - proyek departemen beserta anggotanya dan tombol "Buka di Board";
  - pengaturan channel departemen;
  - riwayat admin (terlipat).
- **Admin departemen mengangkat dan melepas admin lain** di departemennya sendiri. Orangnya harus sudah orang departemen itu. Admin terakhir tidak bisa melepas dirinya; superadmin boleh. Semua tercatat di log dan tampil di riwayat.
- **Divisi** (Organisasi, Departemen, Divisi):
  - Dibuat, diganti nama, diarsipkan, dan dipulihkan oleh admin departemen di departemennya atau oleh superadmin.
  - Admin departemen menunjuk satu atau lebih kepala divisi.
  - Kepala divisi menambah dan mengeluarkan anggota divisinya, hanya orang aktif bukan Tamu dari departemen yang sama, dan mengatur chat divisinya.
  - Satu orang boleh di beberapa divisi. Pindah departemen, keluar dari departemen, atau dikeluarkan dari kantor melepas keanggotaan divisi di departemen lama.
  - Anggota biasa tidak membuat divisi, tapi tetap bisa membuat Grup chat.
- **Chat divisi otomatis** (`ch:<id divisi>`) di bagian Departemen sidebar, tepat di bawah channel departemennya. Chat ini tidak bisa diarsipkan atau dihapus sendiri, dan menjadi hanya baca kalau divisinya diarsipkan.
- **Catatan disematkan dan mode pengumuman** untuk channel utama departemen dan chat divisi. Dalam mode pengumuman, hanya pengelola yang boleh menulis: admin departemen dan superadmin, ditambah kepala divisi untuk chat divisi. Anggota lain melihat satu kalimat penjelasan sebagai ganti kolom pesan.
- **Proyek divisi**: dibuat lewat pilihan "Untuk divisi" di dialog Proyek baru oleh kepala divisi itu, admin departemennya, atau superadmin. Anggota awalnya adalah anggota divisi saat proyek dibuat ditambah pilihan dialog. Nama divisi tampil di kepala Board.
- **Nama divisi tampil di profil dan daftar orang**, misalnya "IT Department · Mobile (kepala), Web · admin departemen".
- **Pemetaan OU AD ke divisi**: baris pemetaan OU boleh menyebut divisi. Orang yang disetujui lewat AD otomatis masuk divisi dari OU terdalam yang dipetakan.
- **Tidak ada peran kustom.** Peran tetap Superadmin, Admin departemen, Kepala divisi, Anggota, dan Tamu.

## Desain teknis

| Bagian | Isi |
|---|---|
| Op baru di log keanggotaan | `division_create`, `division_rename`, `division_archive`, `division_head_set`, `division_member_add`, `division_member_remove`, `chat_settings_set`. Field opsional `project_create.division` dan `OuMapping.division`; bentuk lama sama byte demi byte (dites). |
| Aturan izin | `permissions/division.rs` (fungsi `apply_*` yang dipanggil satu baris dari `fold.rs`), `team_admin_set/unset` kini juga untuk admin departemen dengan aturan senioritas. |
| Aturan bersamaan | `causal.rs`: hak `DivisionHead` dan `AllDivisionHeads`; pencabutan: lepas kepala, keluarkan kepala, arsip divisi, `team_move`, `team_member_remove`. |
| Data turunan | Migrasi v11 (v10 dipakai foto profil): `divisions`, `division_members`, `chat_settings`, `projects.division_id`. |
| Command | `src-tauri/src/division_commands.rs`: `dept_overview`, `my_divisions`, `conversation_settings`, `division_create/rename/archive/set_head/add_member/remove_member`, `dept_set_admin`, `chat_settings_set`. `board_create_project` menerima `divisionId`. |
| Chat | `chat/division.rs`: audiens divisi, pengelola, penolakan arsip/hapus, `announce_only` di judge, `canPost` dan alasannya, field `kind: "division"`, `divisionId`, `teamId`. |
| Gerbang versi | `DIVISION_SINCE = "0.6.0"` dengan pola `min()` seperti `JOIN_AD_SINCE`. Semua op baru, pengangkatan admin oleh admin departemen (juga lewat command lama), proyek divisi, dan pemetaan OU dengan divisi hanya ditulis kalau semua anggota aktif, Tamu juga, melaporkan versi itu. |
| Uji versi lama | `MIRA_TEST_APP_VERSION` (hanya build debug) membuat laptop melaporkan versi lebih lama. |

## Keputusan yang saya ambil sendiri

1. **Pengaturan chat disimpan sebagai op log keanggotaan, bukan record chat.** Dengan begitu sesi chat-sticker tidak bentrok, semua anggota departemen melihat pengaturan yang sama, dan aturan izinnya ikut fold.
2. **Catatan disematkan adalah teks yang ditulis pengelola** (paling banyak 500 karakter dan 20 baris), bukan penanda pada pesan tertentu. Menyematkan pesan butuh menu pesan, yang sedang diubah sesi chat-sticker. Ini bisa ditambah nanti.
3. **Mode pengumuman hanya menolak pesan yang `at`-nya sama atau setelah pengaturan dibuat.** Pesan yang dibuat sebelumnya tetap diterima di semua laptop, jadi laptop tidak berbeda pendapat.
4. **Mode pengumuman hanya berlaku di channel utama departemen** (channel paling awal). Channel lain di departemen itu tidak terpengaruh.
5. **Senioritas admin departemen.** Admin departemen hanya boleh melepas admin yang diangkat setelah dirinya, atau melepas dirinya sendiri. Ini menutup celah yang ditemukan reviewer: tanpa aturan ini, admin yang sudah dilepas bisa membalikkannya dengan op bertanggal mundur, karena dua admin yang saling melepas dipilih menurut urutan yang ditentukan penulis op.
6. **Proyek divisi hanya dibuat kepala divisi itu, admin departemennya, dan superadmin.** Anggota biasa tidak, sama dengan proyek departemen sekarang. Anggota proyek tidak mengikuti perubahan anggota divisi setelah proyek dibuat.
7. **Divisi yang diarsipkan** menyimpan anggota dan kepala sebagai riwayat. Chatnya hanya baca, dan tidak bisa menerima anggota, kepala, atau pengaturan chat baru, tapi masih bisa diganti nama dan dipulihkan. Kepala divisi tidak bisa mengeluarkan orang dari divisi yang diarsipkan. Departemen yang diarsipkan juga menolak perubahan anggota, kepala, dan pengaturan chat divisinya.
8. **Id divisi hanya dicek terhadap id tingkat organisasi** (divisi, departemen, label, #umum), bukan id channel dari op departemen. `channel_create` dengan id divisi ditolak, dan chat selalu membaca `ch:<id>` sebagai divisi. Dengan begitu laptop di dalam dan di luar departemen sampai pada keadaan yang sama.
9. **Divisi hasil AD** ditambahkan oleh laptop admin yang menyetujui, dalam transaksi yang sama, hanya kalau gerbang versi terbuka dan divisinya hidup dan tidak diarsipkan. Kegagalan menambah divisi tidak membatalkan persetujuan.
10. **Urutan tab** berbeda dari kontrak bagian 8: Divisi ditaruh di atas Anggota dan riwayat admin dilipat, atas saran reviewer tampilan, karena daftar anggota bisa 30 orang lebih.
11. **Navigasi "Buka chat" dan "Buka di Board"** lewat `Shell.tsx`: chat dibuka dengan percakapan yang dipilih, Board dengan proyek yang dipilih lewat kunci pilihan yang sudah ada.
12. **Admin terakhir tidak ditawari "Lepas admin" untuk dirinya.** E2e menunjukkan penolakan Rust (`last_team_admin`) sampai ke layar dengan kode `forbidden`, sehingga judulnya "Anda tidak punya izin". Daripada menambah kode error baru di `error.rs` dan `api/types.ts` (file bersama), tombolnya nonaktif dengan penjelasan "Jadikan orang lain admin dulu", seperti superadmin terakhir di daftar pengguna. Superadmin tetap bisa melepas admin terakhir. Kalau penolakan tetap terjadi (balapan dengan laptop lain), pesan Rust tetap tampil di kotak error.

## Review

| Review | Temuan utama | Tindak lanjut |
|---|---|---|
| Keamanan izin | (tinggi) admin yang dilepas bisa membalikkan pelepasan dengan op bertanggal mundur; (sedang) id divisi berbagi `used_ids` dengan id channel dari op departemen; command lama `set_team_admin` melewati gerbang versi; (rendah) kepala masih bisa mengeluarkan anggota divisi yang diarsipkan, `chat_settings` tidak ikut terhapus bersama departemen, beberapa karakter tak terlihat lolos di catatan, op divisi di departemen yang diarsipkan | Semua diperbaiki dengan tes. Yang dicatat sebagai batasan ada di bawah. |
| Tampilan dan teks | Fokus hilang setelah ganti nama, arsip, simpan, dan keluarkan; editor catatan di chat mengabaikan gerbang versi; batas 20 baris tidak terlihat; dua editor catatan berperilaku beda; keluar dari divisi tanpa konfirmasi; tombol nonaktif tanpa penjelasan; nama aksesibel tidak diawali label yang terlihat; peran tercampur dengan daftar divisi; urutan tab | Diperbaiki, kecuali konfirmasi lepas admin yang masih melapor lewat area umpan balik halaman, dan tiga status memuat yang muncul bersamaan saat tab pertama dibuka. |
| Putaran e2e | Judul error admin terakhir menyesatkan ("Anda tidak punya izin"); tombol bergaris yang nonaktif selama gerbang versi tertutup nyaris sama dengan yang aktif; kelas akar `.md` bentrok dengan catatan rilis di `updates.css` (jarak dan ukuran huruf saling menimpa) | Tombol admin terakhir nonaktif dengan penjelasan (keputusan 12); tombol nonaktif di tab memakai garis tipis dan teks `text-sec`; kelas akar diganti `.md-panel`. Nama proyek untuk bukan anggota dicatat sebagai batasan. |

## Hasil verifikasi

Semua di Windows 11, build debug.

- `cargo test --lib`: 1265 lulus, 2 gagal, 7 diabaikan. Keduanya tes `documents::watch` yang memakai jendela waktu 300 ms dan tidak tersentuh perubahan ini (`git diff` untuk `src/documents` hanya penambahan `division: None`). Tes yang gagal berganti-ganti antarputaran saat tujuh sesi membangun bersamaan, dan `documents::watch` lulus 21/21 saat dijalankan sendirian. Tes permissions lulus 196/196 setelah perubahan Rust terakhir.
- Tes baru: `permissions/tests/division_tests.rs` (26), `division_wiring_tests.rs`, `chat/tests/division.rs` (9), tes sinkron board untuk proyek divisi, dan tes parse `MIRA_TEST_APP_VERSION`. Kasus bersamaan yang dites:
  - kepala divisi dicopot bersamaan dengan dia menambah anggota;
  - orang dipindah departemen bersamaan dengan ditambah ke divisi, dalam kedua urutan;
  - dua admin departemen saling melepas;
  - admin junior yang sudah dilepas memalsukan pelepasan bertanggal mundur;
  - divisi diarsipkan bersamaan dengan penambahan anggota;
  - id divisi dibandingkan dengan id channel, dalam kedua urutan.
- `cargo clippy --all-targets -- -D warnings`: bersih.
- `npx tsc --noEmit`: bersih.
- `npx vitest run`: 123 berkas, 1838 tes lulus (putaran terakhir, setelah perbaikan hasil e2e). Tiga berkas (`App.test`, `components.en.test`, `UpdateContext.test`) hanya bisa dimuat dengan `server.fs.allow` ke folder repo induk, karena `node_modules` worktree ini kosong dan Vite menolak impor `pdfjs-dist?url` dari luar root. Putaran terakhir memakai config sementara itu (dihapus lagi), jadi ketiganya ikut lulus.
- E2e, masing-masing dijalankan sendirian dengan `E2E_PORT_OFFSET=1500` dan data di `D:\mira-tmp`:

  | Skrip | Hasil |
  |---|---|
  | `division-e2e` (baru, 6 laptop, termasuk laptop yang melaporkan versi lama) | 78/78 dengan `E2E_SHOTS=1`, pada build terakhir |
  | `org-e2e` | 33/33 |
  | `join-e2e` | 43/43 |
  | `ad-e2e` | 97/97 |
  | `chat-e2e` | 39/39 |
  | `board-e2e` | 43/43 |
  | `english-e2e` | 39/39 |
  | `e2e-multi` | 25/25 |

  Tujuh skrip regresi dijalankan pada build commit 8668aa7. Perubahan sesudahnya hanya di tab Departemen saya (tombol admin terakhir, gaya tombol nonaktif, nama kelas akar), dan dicek ulang dengan `division-e2e`, `tsc`, dan vitest. Perbaikan selama putaran e2e hanya di skrip:
  - `division-e2e`: menunggu halaman Mira sampai 120 detik, karena di PC yang sibuk jendela bisa tertahan di `about:blank` hampir 30 detik. Semua proses yang dijalankan dihentikan di akhir, juga yang gagal tersambung. Proyek dicari lewat id, dan riwayat admin ditunggu sampai tampil.
  - `ad-e2e`: pola tab `/^Departemen/` juga cocok dengan "Departemen saya", jadi diganti `/^Departemen$/`.
- **Gangguan antarsesi:** `chat-e2e`, `join-e2e`, dan `e2e-multi` memakai port tetap dan mengabaikan `E2E_PORT_OFFSET`. Putaran pertama `chat-e2e` sesi ini bertabrakan dengan `chat-e2e` sesi chat-sticker. Proses sesi ini dihentikan, lalu skrip diulang setelah port bebas. Putaran sesi chat-sticker yang berjalan saat itu mungkin ikut gagal.
- Screenshot: `docs/progress/screenshots/dept-divisi/`, 22 berkas. dd01 sampai dd20 terdiri dari empat set berurutan: terang ID, gelap ID, terang EN, dan gelap EN. Setiap set berisi tab Departemen saya, kartu divisi, chat divisi dengan catatan, mode pengumuman, dan proyek baru untuk divisi. dd21 menunjukkan gerbang versi tertutup, dd22 chat divisi yang diarsipkan.

## Batasan

- **Aturan baru juga berlaku mundur pada log lama.** Op `team_admin_set/unset` buatan admin departemen yang dulu ditolak laptop v0.5 akan diterima setelah laptop itu memakai 0.6. Selama kantor masih campuran, kedua versi bisa berbeda pendapat tentang op seperti itu. Gerbang versi mencegah aplikasi menulisnya, jadi hanya klien yang dimodifikasi yang bisa memicunya.
- **Kepala divisi yang diangkat bersamaan dengan dipindah departemen** masih bisa membuat op divisi yang terurut sebelum pemindahan. Pola ini sama dengan `team_admin_set` dan `team_move` di v0.5.
- **Admin terakhir masih bisa keluar lewat `team_member_remove`.** Aturan ini sudah ada sejak v0.2 dan tidak ditawarkan di tampilan.
- **`team_create` dan `label_create`** masih memeriksa id terhadap id channel dari op departemen. Kemungkinan pembedaan keadaannya sama dengan yang sudah ditutup untuk divisi, tapi itu op superadmin yang sudah lama dan tidak diubah di sini.
- **Gerbang versi di build dev.** Selama versi masih 0.5.0, build dari branch ini menganggap laptop v0.5.0 rilis cukup baru, karena ambangnya `min(0.5.0, 0.6.0)`. Rilis yang membawa fitur ini harus bernomor 0.6.0 atau lebih.
- **Jalur kode undangan tidak memeriksa versi**, sama seperti AD. Laptop lama yang masuk lewat kode undangan setelah ada divisi tidak bisa membaca op divisi. Tab menampilkan laptop itu di daftar yang belum diperbarui.
- **Anggota proyek divisi tidak mengikuti perubahan anggota divisi** setelah proyek dibuat.
- **Nama proyek di tab Departemen saya** dibaca dari `board_projects`, yang hanya ada di laptop anggota proyek. Admin departemen yang bukan anggota proyek melihat "Proyek" sebagai namanya. Op `project_create` di log bersama tidak membawa nama; menambahkannya butuh field op baru dan bisa dikerjakan terpisah.
- **Admin departemen melihat tombol "Lepas admin" untuk admin yang lebih senior.** Rust menolaknya (aturan senioritas) dan pesan error tampil. Tampilan belum tahu urutan pengangkatan, karena `dept_overview` tidak mengirim `appointed`.
- **Nonaktif permanen** (sesi perbaikan bergabung): tampilan dan audiens chat sudah menyaring orang yang tidak aktif. Saat digabung, jalur nonaktif sebaiknya memanggil `OrgState::leave_divisions(pk, None)` supaya keanggotaan divisinya juga lepas di fold.

## Catatan penggabungan

- **File bersama yang diubah kecil:**
  - `permissions/fold.rs`: field baru, `Reason` baru, lengan apply satu baris, dan aturan admin departemen di `TeamAdminSet/Unset`.
  - `permissions/op.rs`, `causal.rs`, `store.rs` (satu baris), `org_actions.rs` (hook AD tiga baris, `register_own_project_in` dengan divisi), `query.rs` (`PersonView.divisions`), `actions.rs` (`set_team_admin` didelegasikan).
  - `db/migrations.rs`: V11 (dinomori ulang saat digabung dengan foto profil v10).
  - `lib.rs`: registrasi 11 command.
  - Chat: `audience.rs`, `judge.rs`, `read.rs`, `view.rs`, `service.rs`, `sync.rs`.
  - Frontend: `ConversationList.tsx`, `Conversation.tsx`, `conversationMenu.tsx`, `ChatScreen.tsx`, `ProfileDialog.tsx`, `UsersPanel.tsx`, `OrgScreen.tsx`, `JoinRequestsPanel.tsx`, `InvitesPanel.tsx`, `Shell.tsx`, `api/chat.ts`, `api/org.ts`, `api/board.ts`.
- **Variabel lingkungan khusus build debug:** `MIRA_TEST_APP_VERSION`.
- **Folder `node_modules/pdfjs-dist`** di worktree ini berisi salinan empat folder data pdf.js (sekitar 3,6 MB), karena plugin pdf.js di `vite.config.ts` membacanya dari `node_modules` worktree. Folder itu tidak di-commit dan sudah dihapus setelah e2e. Untuk membangun lagi dari worktree ini, salin lagi atau jalankan `npm install` di worktree.
- **Untuk rilis:** naikkan versi ke 0.6.0. Catatan "Yang baru" sebaiknya menyebut bahwa divisi baru bisa dibuat setelah semua laptop kantor diperbarui.
