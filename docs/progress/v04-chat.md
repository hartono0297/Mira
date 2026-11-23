# Laporan Chat v0.4: lipat sidebar, grup satu orang, chat proyek sebagai grup

Tanggal: 23 November 2026. Branch `claude/v04-chat-f21661`, dari `main` e7def11. Rencana: `docs/plans/v04-chat.md`.

## Ringkasan

Tiga permintaan, tiga perubahan. Bagian sidebar yang dilipat sekarang benar-benar tersembunyi; sebelumnya panahnya berputar tetapi barisnya tetap tampil karena satu aturan CSS. Grup bisa dibuat tanpa memilih orang lain, lalu diisi belakangan. Chat proyek sekarang tampil sebagai grup berisi anggota proyek: nama proyek tanpa `#`, jumlah dan daftar anggota, selalu di bagian Proyek, dan tidak bisa diarsipkan atau dihapus.

Tidak ada record baru dan tidak ada migrasi. Id percakapan chat proyek tidak berubah, jadi laptop v0.3 tetap bertukar pesan dengan laptop v0.4.

## Apa yang ditemukan dan diubah

### 1. Bug lipat sidebar

**Temuan.** `ConversationList.tsx` sudah memasang atribut `hidden` di badan bagian yang terlipat, dan panah sudah menunjuk ke kanan. Tetapi `src/screens/chat/chat.css` memberi `.chat-sec-body { display: flex }`, dan aturan itu menimpa `[hidden] { display: none }` bawaan browser. Di aplikasi sungguhan bagian yang dilipat tidak pernah tersembunyi. Vitest hanya memeriksa atribut `hidden` di jsdom, yang tidak menerapkan CSS, jadi bug ini lolos.

**Perubahan.**
- `chat.css`: `.chat-sec-body[hidden] { display: none; }`.
- Aturan "bagian yang berisi percakapan terbuka tidak bisa dilipat" dihapus. Semua bagian bisa dilipat, termasuk yang berisi percakapan terbuka; percakapannya tetap terbuka di panel kanan.
- Bagian terlipat dibuka otomatis hanya setelah aksi pengguna dari dialog (grup baru, pesan pribadi baru), lewat `revealId` dari `ChatScreen.adopt`. Pindah otomatis ke `#umum` (misalnya setelah percakapan terbuka hilang) tidak membuka bagian mana pun.
- State lipat disimpan per laptop di database Mira (pengaturan `chat.folded`), lewat command baru `chat_set_folded` dan field `ChatOverview.folded`. Awalnya masih `localStorage`, tetapi `chat-e2e.mjs` menunjukkan lipatan hilang setelah aplikasi dihentikan paksa: WebView2 belum sempat menulis `localStorage` ke disk. Hal yang sama bisa terjadi saat laptop mati mendadak. Nilai yang tidak dikenal dibuang inti Rust; kalau menyimpan gagal, lipatan tetap berlaku selama layar terbuka.

**Tes.** `ConversationList.test.tsx` baru, termasuk satu tes yang membaca `chat.css` dan gagal pada file lama. `ChatScreen.test.tsx` disesuaikan. Di e2e, bagian terlipat dicek dengan `getComputedStyle(...).display === "none"`, dan lipatan dicek bertahan setelah aplikasi dihentikan paksa lalu dimulai ulang (`chat-e2e.mjs`) dan setelah muat ulang (`e2e-fitur-multi.mjs`).

### 2. Grup tanpa anggota lain

**Temuan.** Model dan judge sudah menerima `group_create` dengan `members` kosong, dan fold menjadikan pembuat pemilik sekaligus anggota. Yang menolak hanya `service::create_group` (lewat `group_targets` yang dipakai bersama) dan dialog.

**Perubahan.**
- `create_group` menerima daftar kosong. `group_add` tetap butuh minimal satu orang baru; pemeriksaannya dipindah ke `group_add`.
- Dialog "Grup baru": pesan "Pilih minimal satu orang" dihapus, tombol "Buat grup" tidak dikunci lagi. Petunjuknya: "Belum ada yang dipilih. Grup bisa dibuat berisi Anda saja, lalu tambah orang belakangan. Tamu tidak bisa dimasukkan ke grup."
- Teks kejadian "Anda membuat grup ini." sudah ada sebelumnya.
- Laptop v0.3 juga menerima record grup seperti ini, karena judge-nya sama.

### 3. Chat proyek sebagai grup

**Temuan.** Membuat proyek tidak membuat record chat apa pun. Chat proyek adalah channel bawaan `ch:<id proyek>` yang diturunkan dari `board_projects` (`audience.rs`, `Ctx::resolve`); audiensnya anggota proyek menurut `board::access`, bagiannya Proyek. Letak dan keanggotaannya sudah benar. Masalahnya, tampilannya sama persis dengan channel umum: `kind: "channel"`, nama dinormalkan menjadi `#test`, kepala menulis "Proyek test" tanpa jumlah atau daftar anggota, dan pengelola proyek bisa mengarsipkan atau menghapusnya seperti channel. Ditambah bug lipat, `# test` tampak berada di luar bagian Proyek. Itu sebabnya ia terbaca sebagai chat umum.

**Perubahan inti (`src-tauri/src/chat/`).**
- `ConversationKind::Project` (`kind: "project"`) khusus untuk chat bawaan proyek: `ConvInfo::is_project_chat` berarti `Scope::Project` dan bukan buatan `channel_create`. Channel proyek v0.2 dari `channel_create` tetap `"channel"`.
- Nama percakapan adalah nama proyek apa adanya. Bagiannya selalu Proyek; di layar, `sectionOf` juga memetakan `kind` `project` ke Proyek.
- Command baru `chat_project` mengembalikan `ProjectChatView`: anggota urut nama, `me`, `manager`, `canManage`, `former`. Hanya bisa dibaca anggota dan bekas anggota proyek.
- `canArchive` dan `canDelete` false. Service menolak arsip dan hapus; mengembalikan dari arsip tetap boleh.
- Judge menolak `channel_delete` dan `channel_archive{archived:true}` untuk chat proyek dari laptop lain. Ditemukan saat review: tanpa ini, pengelola proyek di laptop v0.3 bisa menghapusnya untuk selamanya, karena id percakapannya tetap.
- `post_blocked` punya teks sendiri untuk chat proyek yang diarsipkan.
- Notifikasi "Budi di Proyek Alfa", lewat `sync::project_label` yang tidak mengulang kata "Proyek".

**Perubahan layar (`src/screens/chat/`).**
- Kepala: ikon grup, judul tanpa `#`, tombol "Proyek · N anggota" yang membuka panel hanya-baca "Anggota proyek (N)" (`ProjectMembers.tsx`, baru) dengan chip "Pengelola proyek" dan catatan bahwa anggota diatur di Anggota proyek di Board.
- Menu kepala hanya berisi bisukan notifikasi, ditambah "Kembalikan dari arsip" untuk chat proyek yang pernah diarsipkan di v0.3.
- Kolom pesan: "Pesan untuk Proyek X". Baris di daftar: label "Chat proyek X" dengan ikon grup. Teks untuk Tamu dan keadaan kosong menyebut "chat proyek".

## Keputusan yang saya ambil sendiri

| Keputusan | Alasan |
|---|---|
| Bagian terlipat dibuka otomatis hanya setelah aksi dari dialog | Pengguna yang baru membuat grup atau pesan pribadi perlu melihatnya. Pindah otomatis ke `#umum` bukan pilihan pengguna, jadi lipatannya dihormati. |
| Aturan "bagian dengan percakapan terbuka tidak bisa dilipat" dihapus, bukan diganti penanda | Satu aturan untuk semua bagian lebih mudah dipahami. Percakapan terbuka tetap tampil di panel kanan. |
| `kind: "project"` hanya untuk chat bawaan proyek | Channel proyek v0.2 dari `channel_create` punya nama dan pembuatnya sendiri, jadi tetap channel. |
| Chat proyek tidak bisa diarsipkan atau dihapus; mengembalikan arsip lama boleh | Chat proyek hidup selama proyeknya ada. Arsip yang ditinggalkan v0.3 jangan sampai mengunci chatnya. |
| Putusan judge berbeda dengan laptop v0.3 diterima | Laptop v0.3 masih bisa menerima hapus atau arsip dari pengelola v0.3; laptop v0.4 menolaknya. Hilang selamanya lebih buruk daripada beda tampilan sementara. |
| Superadmin yang juga anggota proyek dihitung pengelola | Mengikuti aturan board (`Rights::is_project_manager`). |
| Bekas anggota proyek melihat daftar anggota sekarang | Sama dengan `group_view`. Keanggotaan proyek toh sudah ada di log organisasi. |
| Panel anggota dimuat ulang saat `memberCount` atau `former` berubah, atau saat dibuka | Pertukaran anggota dengan jumlah sama selagi panel terbuka baru terlihat setelah panel dibuka lagi. Cukup untuk panel yang jarang dibuka. |
| Lipatan disimpan di database, bukan `localStorage` | `localStorage` hilang saat aplikasi dihentikan paksa (terbukti di e2e). Database sudah dipakai untuk pengaturan notifikasi chat. |
| Dua command baru didaftarkan di `src-tauri/src/lib.rs` | Titik sambung sekecil mungkin. |
| `chat-e2e.mjs` sekarang hanya menghapus kunci Credential Manager miliknya sendiri | Supaya tidak menghapus kunci proses lain yang sedang berjalan. |

## Hasil uji (apa adanya)

| Pemeriksaan | Hasil |
|---|---|
| `cargo test --lib chat::` | 134 lulus |
| `cargo test` (seluruh crate, putaran terakhir) | 1013 lulus, 1 gagal, 7 diabaikan. Yang gagal `permissions::tests::causal_tests::large_log_folds` (di luar chat): tes ini membatasi waktu fold 10 detik dan dijalankan bersamaan dengan uji tiga instance; dijalankan sendiri lulus (34 detik termasuk build). Putaran sebelumnya gagal di `documents::session::tests::recovery_saves_changes_and_ends_or_resumes_sessions` dengan pola yang sama, juga lulus sendiri. |
| `cargo clippy --all-targets` | 0 peringatan |
| `npx tsc --noEmit` | tanpa error |
| Vitest (`npx vitest run`) | 67 file, 945 dari 946 tes lulus. Gagal: `NewRequestDialog` (tanda tangan, batas waktu 5 detik di bawah beban; lulus kalau dijalankan sendiri). Dua file, `App.test.tsx` dan `UpdateContext.test.tsx`, tidak bisa dimuat ("Denied ID ... pdfjs-dist ... pdf.worker.min.mjs?url") karena `node_modules` ada di repo utama, di luar akar worktree. Commit dasar e7def11 di worktree terpisah gagal dengan cara yang sama, jadi bukan dari perubahan ini. Putaran penuh pertama di sesi ini (sebelum build aplikasi) lulus 944 dari 944. Folder chat: 154 lulus. |
| `scripts/chat-e2e.mjs` (satu instance, build debug) | 25 dari 25. Putaran pertama 19 dari 22: lipatan hilang setelah restart (alasan pindah dari `localStorage` ke database) dan pemilih baris skrip tidak menghitung baris tersembunyi (diperbaiki dengan `includeHidden`). |
| `scripts/e2e-fitur-multi.mjs` (tiga instance, build debug, `E2E_PORT_OFFSET=300`) | 53 dari 53. Putaran pertama 52 dari 53: pemeriksaan lama nomor 9 ("grup tidak pernah sampai ke C") menghitung grup apa pun di C, dan langkah 13b baru memberi C grup satu orangnya sendiri. Pemeriksaannya dipersempit ke grup itu; `chat_messages` dan baris di layar C memang kosong di kedua putaran. |

Tes Rust baru di `src-tauri/src/chat/tests/v04.rs`:
- `group_with_only_its_creator_then_people_added_later`: grup berisi pembuat saja tidak sampai ke siapa pun, kejadiannya "Anda membuat grup ini.", `group_add` kosong atau berisi diri sendiri ditolak, orang yang ditambah belakangan menerima riwayat.
- `creator_alone_can_leave_and_the_group_ends_former`: pembuat satu-satunya bisa keluar; grupnya tersisa hanya-baca.
- `project_chat_is_a_group_of_the_project_members`: `kind` Project, bagian Proyek di semua laptop, nama proyek, jumlah anggota, tanpa arsip atau hapus, `chat_project` ditolak untuk yang tidak pernah jadi anggota, anggota baru menerima riwayat, anggota yang keluar menjadi `former`.
- `project_chat_notification_names_the_project`: judul notifikasi "Budi di Proyek Alfa".
- `peers_cannot_archive_or_delete_a_project_chat_but_may_restore_an_old_archive`: hapus dan arsip dari laptop lain ditolak dan tidak tersimpan; arsip lama bisa dikembalikan; teks `post_blocked` untuk chat proyek.
- `project_label_does_not_repeat_proyek`.
- `folded_sections_are_kept_per_laptop_in_the_database`: lipatan tersimpan per laptop, nilai asing dan ganda dibuang, laptop lain tidak ikut.

`tests/scoping.rs` disesuaikan: Tamu melihat chat proyek dengan nama proyek dan `kind` Project.

Tes Vitest baru: `ConversationList.test.tsx` (lipat bagian, `revealId`, aturan CSS, chat proyek di daftar) dan `ProjectChat.test.tsx` (kepala, menu, arsip lama, keadaan kosong, panel anggota termasuk Escape, klik di luar, memuat, error, dan muat ulang). `ChatScreen`, `Composer`, `NewGroupDialog`, dan `text` ikut diperbarui.

Pemeriksaan e2e baru di `e2e-fitur-multi.mjs`:
- 13a, chat proyek sebagai grup di tiga instance: kepala dan jumlah anggota, C ditambahkan ke proyek lalu menerima riwayat, B dikeluarkan lalu menjadi bekas anggota.
- 13b, grup satu orang.
- 13c, lipat sidebar, termasuk setelah muat ulang.

Screenshot aplikasi sungguhan (data uji, mode terang) di `docs/progress/screenshots/v04-chat/`:
- `v04-01-grup-terlipat.png` (dari `chat-e2e.mjs`, disalin ke folder ini)
- `v04-02-kepala-chat-proyek-a.png`
- `v04-03-sidebar-proyek-terlipat-b.png`
- `v04-04-chat-proyek-c-setelah-ditambah.png`

## Review terpisah

Satu subagen meninjau perubahan tanpa mengubah apa pun. Semua temuan sudah ditindaklanjuti.

| # | Temuan | Tindak lanjut |
|---|---|---|
| 1 (sedang) | Judge menerima arsip dan hapus chat proyek dari laptop lain | Diperbaiki di judge. Tes `peers_cannot_archive_or_delete_a_project_chat_but_may_restore_an_old_archive`. |
| 2 (rendah-sedang) | Chat proyek yang diarsipkan menampilkan teks channel | Diperbaiki di `post_blocked`. |
| 3 (rendah) | Notifikasi "Proyek Proyek X" untuk proyek yang namanya sudah diawali "Proyek" | Diperbaiki dengan `project_label`, ditambah tes. |
| 4 (rendah) | Pindah otomatis ke `#umum` membuka bagian yang terlipat | Diperbaiki dengan `revealId`. |
| 5 (rendah) | Catatan untuk Tamu masih menyebut "channel proyek" | Diperbaiki. |
| 6 (info) | `chat_project` untuk orang yang tidak pernah jadi anggota belum dites | Tes ditambahkan. |
| 7 (info) | `group_create` kosong di laptop lain | Tidak ada masalah: judge dan fold sudah menerimanya. |
| 8 (info) | Pemeriksaan e2e lemah | Diperketat: jumlah baris dicek sebelum visibilitas, pesan dicek tersimpan, langkah dinomori 13a, 13b, 13c. |

## Titik sambung dan catatan merge

- `src-tauri/src/lib.rs`: dua baris baru, `chat::commands::chat_project` dan `chat::commands::chat_set_folded`, setelah `chat_group_rename`.
- Kontrak baru di `src/api/chat.ts`: `kind: "project"`, `ProjectChatMember`, `ProjectChatView`, `projectChat(conv)` untuk `chat_project`, `ChatOverview.folded`, dan `setFolded(sections)` untuk `chat_set_folded`.
- Lipatan lama di `localStorage` (`mira.chat.folded`, v0.3) tidak dipindahkan; setelah pembaruan semua bagian mulai terbuka sekali.
- Untuk build aplikasi di worktree, `node_modules\pdfjs-dist` dibuat sementara sebagai junction ke salinan repo utama lalu dihapus lagi (junction itu membuat Vitest menolak path di luar worktree).
- Tidak ada migrasi. Di luar `src-tauri/src/chat/`, `lib.rs`, `src/api/chat.ts`, `src/screens/chat/`, dan dua skrip e2e, tidak ada file yang diubah; `board/`, `permissions/`, dan `documents/` tetap.
- `chat-e2e.mjs` sekarang hanya menghapus kunci Credential Manager miliknya sendiri. `e2e-fitur-multi.mjs` menyimpan screenshot v0.4 di argumen kelimanya (bawaan `docs/progress/screenshots/v04-chat`).

## Belum dicek atau masih terbatas

- **Campuran laptop v0.3 dan v0.4**: laptop v0.3 masih bisa menerima hapus atau arsip chat proyek dari pengelola yang memakai v0.3. Laptop v0.4 menolaknya, jadi untuk sementara keduanya bisa berbeda sampai semua laptop diperbarui. Belum diuji dengan instance v0.3 sungguhan.
- **Panel anggota proyek** tidak dimuat ulang kalau anggota bertukar dengan jumlah tetap selagi panel terbuka; terlihat setelah panel dibuka lagi.
- **Bekas anggota proyek** melihat daftar anggota sekarang, bukan daftar saat ia keluar.
- **Lipat sidebar** dicek dengan `getComputedStyle` di e2e dan screenshot, bukan di semua lebar jendela.
- **Lipatan dari v0.3** di `localStorage` tidak dibawa ke database.

## Commit

Satu commit di branch `claude/v04-chat-f21661`, tanpa push dan tanpa merge ke `main`. Lihat `git log e7def11..HEAD`.
