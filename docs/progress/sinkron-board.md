# Laporan sinkron board antar laptop (sisa Tahap 3)

Tanggal: 22 November 2026. Branch `claude/sinkron-board-e01670`. Dasar: `main` 63eb72b. Rencana: `docs/plans/sinkron-board.md`.

## Ringkasan

Change board sekarang bisa berpindah antar laptop. Setiap change Automerge yang sudah ditandatangani dikirim sebagai satu record lewat kontrak `network/feature.rs` (`FeatureSync`, topik `board`). Laptop yang menerima memeriksa sendiri setiap change sebelum memakainya. Dua laptop yang memegang change yang sama melihat isi board yang sama.

Data proyek hanya dikirim ke orang yang boleh melihat proyek itu:
- Proyek milik tim: anggota tim itu, ditambah Tamu yang diundang ke proyek itu.
- Proyek tanpa tim: semua anggota aktif kecuali Tamu.

Tamu sekarang diundang per proyek. Undangan Tamu memilih proyek dari tim yang sama, dan Tamu hanya bisa membaca board proyek itu.

Tampilan board memuat ulang sendiri saat ada change dari laptop lain (event `mira://feature` dengan topik `board`). Ketikan yang belum disimpan tidak tertimpa. Kalau task atau proyek hilang karena change dari rekan, tampilan menjelaskan penyebabnya.

Transport jaringan yang memanggil kontrak ini belum digabung ke branch ini. Jadi sinkron sudah diuji di Rust dengan beberapa database lokal dan di aplikasi satu laptop, tapi belum antar laptop sungguhan. Semua pekerjaan di-commit lokal di branch ini. Tidak ada push, remote baru, atau merge ke `main`.

## Yang dibuat

**Inti Rust (`src-tauri/src/board/`)**
- `schema.rs`: migrasi `BOARD_SYNC_SCHEMA` (v6 di branch ini). Isinya kolom `record_id` di `board_changes`, kolom `doc_code` di `board_projects`, tabel `board_pending` untuk change yang belum bisa dipakai, dan tabel `board_rejected` untuk id record yang ditolak.
- `access.rs`: aturan siapa boleh melihat dan mengubah proyek mana. `Rights` dibaca dari tabel hasil fold Tahap 1 (`members`, `teams`, `team_members`, `guest_access`). `RightsHistory` memutar ulang log keanggotaan untuk menjawab "apakah penulis punya hak ini saat change dibuat". Di sini juga ada fungsi untuk chat dan dokumen (lihat bagian 6).
- `policy.rs`: `LocalRolePolicy` memakai aturan `access.rs`. `check_at` menilai change dari rekan menurut waktu change dibuat. `BatchPolicy` memuat riwayat hak sekali per kiriman.
- `rules.rs`: menilai setiap operasi di dalam satu change dari rekan, misalnya "boleh mengisi kolom task" atau "tidak boleh menghapus kunci task". Juga memeriksa bahwa task dan komentar baru memakai id yang terikat ke penulisnya, dan membatasi nomor task.
- `sync.rs`: sisi penyimpanan. Setiap change dari rekan mendapat satu hasil: diterapkan, sudah ada, ditahan, ditolak, menunggu change induk, atau proyek belum dikenal. Di sini juga aturan "didukung rekan" untuk change dari orang yang sudah kehilangan haknya.
- `feature.rs`: `BoardFeature`, implementasi `FeatureSync` topik `board`. Isinya menawarkan record, menerima record, menyimpan antrean pending, dan mencoba lagi change yang ditahan. `BoardSyncNotifier` adalah hook untuk change lokal: memicu pengingat tenggat lalu memberi tahu `FeatureHub`. `register` memasang semuanya ke aplikasi.
- `numbers.rs`: penomoran ulang task yang nomornya sama setelah sinkron.
- `store.rs`:
  - `derive_project_id`: id proyek dihitung dari pembuat, tim, dan nonce acak.
  - `is_syncable`: memeriksa apakah id proyek sudah terikat seperti itu.
  - `refresh_codes`: menentukan kode proyek yang tampil kalau ada kode ganda.
- `doc.rs`: operasi baru `renumber_task` dan `rename_project`, jenis riwayat `renumbered`, dan id task serta komentar yang diturunkan dari penulis dan nonce (`derive_task_id`, `derive_comment_id`).
- `sign.rs`: bentuk record yang dikirim (`record_body`, `from_record_body`). Batas satu change turun ke 120 KiB supaya record tetap muat di batas transport 256 KiB.
- `assignees.rs`: daftar penanggung jawab = semua yang boleh menulis di proyek itu.
- `commands.rs`: command baru `board_update_project` untuk mengganti nama proyek.
- `reminder.rs`: pengingat hanya untuk proyek yang masih boleh dilihat laptop ini.
- `model.rs`, `view.rs`: field baru `teamName` di ringkasan proyek dan `canComment` di detail task.
- Tes: `access/tests.rs`, `rules/tests.rs`, `feature/tests.rs` (tiga laptop dengan log keanggotaan sungguhan), `feature/convergence_tests.rs` (proptest konvergensi tiga laptop, nomor ganda, hapus vs edit, urutan kedatangan, pembatasan, change palsu), `testutil.rs`.

**Tampilan (`src/screens/board/`, `src/screens/org/`, `src/api/board.ts`)**
- `api/board.ts`: `subscribeBoard` sekarang juga mendengar `mira://feature`. Hanya payload dengan `topic: "board"` yang memicu muat ulang. Ada `updateProject` dan field `teamName`, `canComment`, serta jenis riwayat `renumbered`.
- `BoardScreen.tsx`:
  - Proyek yang sedang dibuka lalu hilang dari daftar menampilkan penjelasan, misalnya karena dikeluarkan dari tim atau akses Tamu dicabut.
  - Tombol "Proyek baru" hanya tampil untuk yang boleh membuat proyek.
- `NewProjectDialog.tsx`: memilih tim saat membuat proyek. Kalau daftar tim gagal terbaca, proyek tidak dibuat, supaya tidak terlanjur terlihat oleh seluruh organisasi.
- `ProjectBoard.tsx`: penanda siapa yang melihat proyek ("Tim Desain" atau "Seluruh organisasi"), tombol ubah nama, dan catatan untuk pengguna yang hanya bisa membaca.
- `RenameProjectDialog.tsx`: ubah nama proyek. Kalau rekan mengganti nama selama dialog terbuka, dialog memberi tahu sebelum ketikan menimpanya.
- `TaskDetail.tsx`:
  - Draf judul, deskripsi, label, dan komentar tidak tertimpa saat muat ulang.
  - Kalau judul diubah di laptop lain selama mengetik, ada pemberitahuan.
  - Kalau task dihapus, proyek hilang, atau izin mengubah dicabut, draf yang belum tersimpan ditampilkan untuk disalin.
  - Penanggung jawab yang tidak bisa ditugaskan lagi tetap tampil dengan keterangan.
- `useHeld.ts`, `useFocusRescue.ts`, `MyTasks.tsx`: isian yang difokus tidak berubah di bawah kursor, dan fokus pindah ke tempat terdekat kalau kartu atau baris yang difokus hilang.
- `taskActivity.ts`: kalimat riwayat untuk nomor yang diganti.
- `org/InviteDialog.tsx`: undangan Tamu memilih proyek dari tim yang dipilih, paling banyak 50 proyek.

**Uji ujung ke ujung**
- `scripts/board-sync-e2e.mjs`: satu laptop. Membuat tim dan proyek tim, mengubah judul task dari inti Rust saat deskripsi sedang diketik, memancarkan `mira://feature` topik `board` dan `chat`, mengubah nama proyek, membuat undangan Tamu, mengambil screenshot terang dan gelap, lalu restart.

## Aturan akses

Sumber: tabel hasil fold Tahap 1. Untuk change dari rekan, lihat juga "Hak pada saat change dibuat" di bagian Keamanan.

| Hak | Proyek milik tim T | Proyek tanpa tim |
|---|---|---|
| Lihat (menerima change) | Anggota aktif tim T dengan peran apa pun, atau Tamu dengan akses ke proyek ini dari undangan tim T | Semua anggota aktif kecuali Tamu |
| Tulis (buat task, edit, pindah, komentar) | Yang boleh lihat, kecuali Tamu | Semua anggota aktif kecuali Tamu |
| Hapus task | Yang boleh tulis, dan dia pembuat task, admin tim T, atau superadmin yang anggota T | Yang boleh tulis, dan dia pembuat task atau superadmin |
| Atur proyek (ganti nama) | Yang boleh tulis, dan dia admin tim T, superadmin yang anggota T, atau pembuat proyek | Yang boleh tulis, dan dia pembuat proyek atau superadmin |
| Buat proyek | Admin tim T, atau superadmin yang anggota T | Superadmin, atau admin tim mana pun |

Aturan tambahan:
- Tamu hanya bisa membaca. Tamu tidak bisa mengubah task dan tidak bisa berkomentar.
- Akses Tamu hanya berlaku kalau tim di undangan sama dengan tim proyek. Undangan ke proyek tim lain tidak memberi akses apa pun, dan dialog undangan menolaknya sejak awal.
- Superadmin tidak otomatis melihat proyek tim (F-ROLE-11). Ia harus masuk tim itu dulu, dan langkah itu tercatat di log keanggotaan.
- Anggota biasa yang diundang sebagai Tamu ke proyek tim lain menjadi peserta proyek itu dan boleh menulis (F-ROLE-10). Ia tidak menjadi anggota tim itu.
- Tim pemilik proyek tidak bisa diubah lewat change dari rekan, karena memindah proyek ke tim lain berarti mengubah siapa yang menerima datanya.

## Aturan konflik

Konflik terjadi kalau dua orang mengubah hal yang sama saat laptop mereka belum tersambung. Setelah tersambung, setiap laptop memakai aturan yang sama, jadi hasilnya sama di semua laptop.

**Nomor task ganda.** Sari dan Budi sama-sama offline dan sama-sama membuat task PA-12. Setelah sinkron:
- Task yang dibuat lebih dulu tetap memegang PA-12. Kalau waktunya sama persis, urutan id task yang menentukan.
- Task yang lain diberi nomor baru, yaitu nomor terbesar di proyek ditambah satu.
- Yang memberi nomor baru hanya satu laptop: laptop pembuat task itu. Kalau pembuatnya sudah tidak boleh menulis di proyek itu, yang memberi nomor adalah laptop dengan kunci publik terkecil di antara yang boleh menulis.
- Penomoran ulang adalah change biasa yang ditandatangani. Riwayat task mencatatnya, misalnya "Budi mengganti nomor task ini dari PA-12 karena nomornya sama dengan task lain". Jadi pesan atau catatan lama yang menyebut PA-12 masih bisa dijelaskan.
- Kalau dua laptop tetap menomori task yang sama bersamaan, Automerge memilih satu nilai yang sama di semua laptop. Kalau nomor baru bentrok lagi, aturan yang sama dijalankan lagi.

**Kode proyek ganda.** Dua proyek berbeda bisa sama-sama berkode PA, misalnya dibuat dua admin tim yang berbeda saat offline. Di laptop yang memegang keduanya:
- Proyek yang dibuat lebih dulu tampil sebagai PA.
- Proyek lainnya tampil sebagai PA2, lalu PA3, dan seterusnya (angka pertama yang belum dipakai).
- Kode di dokumen proyek tidak diubah. Laptop yang hanya memegang salah satu proyek tetap melihat PA.
- Laptop yang memegang proyek yang sama menampilkan kode yang sama, karena urutannya hanya bergantung pada proyek yang ada.

**Hapus vs edit.** Hapus task hanya memberi tanda "terhapus". Task tetap ada di dokumen. Kalau Sari menghapus task sementara Budi mengeditnya, edit Budi tetap tergabung, tapi task tidak muncul lagi. Change yang mencoba menghidupkan lagi task yang sudah terhapus ditolak. Di layar Budi, dialog detail memberi tahu bahwa task dihapus di laptop lain dan menampilkan ketikannya yang belum tersimpan supaya bisa disalin.

**Ganti nama bersamaan.** Kalau dua orang mengganti nama proyek yang sama pada waktu yang sama, Automerge memilih satu nama dengan aturan yang sama di setiap laptop. Nama lainnya tidak tampil. Kode proyek tidak ikut berubah saat nama diganti. Dialog ubah nama tidak mengirim apa pun kalau pengguna belum mengetik, supaya nama lama tidak menimpa nama baru dari rekan.

## Keamanan

**Pemeriksaan per operasi (`rules.rs`).** Change dari rekan tidak dinilai dari hasil gabungannya, tapi dari setiap operasi di dalamnya. Cara ini memberi hasil yang sama di semua laptop, apa pun urutan change datang. Yang boleh, antara lain: membuat task baru, mengisi kolom task, mengedit judul dan deskripsi, menambah komentar dan riwayat atas nama penulis sendiri, dan mengganti nama atau kode proyek kalau punya hak atur. Yang ditolak permanen, antara lain: menghapus kunci task atau komentar, mengganti seluruh daftar task atau data proyek, mengubah pembuat task, mengedit komentar orang lain atau riwayat lama, dan memindah proyek ke tim lain. Task dan komentar baru wajib memakai id yang diturunkan dari penulisnya dan nonce, jadi orang lain tidak bisa membuat task dengan id task orang lain. Nomor task yang ditulis change rekan dibatasi supaya tidak bisa diracuni dengan angka raksasa. Satu change paling banyak 50.000 operasi.

**Id proyek terikat ke pembuat dan tim.** Id proyek baru adalah 32 karakter pertama hash BLAKE3 dari pembuat, tim, dan nonce acak (`store::derive_project_id`). Orang lain tidak bisa mengaku sebagai pembuat proyek itu atau memindahkannya ke tim lain dengan change pertama palsu. Proyek yang dibuat sebelum versi ini belum punya id terikat, jadi tidak ditawarkan ke laptop lain (`store::is_syncable`).

**Hak pada saat change dibuat.** Change dari rekan diterima kalau penulisnya punya hak itu sekarang. Kalau penulisnya sudah kehilangan hak (keluar tim, turun dari admin, atau dikeluarkan dari organisasi), change tetap diterima kalau dua syarat terpenuhi:
- Penulis masih punya hak itu saat change dibuat. Waktu kehilangan hak diambil dari op keanggotaan yang mencabutnya.
- Change itu didukung rekan: ada change lain dari orang yang masih berhak, yang dibangun di atas change itu. Artinya rekan yang berhak sudah melihatnya. Pendukung harus orang lain, bukan penulisnya sendiri.

Contoh: Budi menulis di proyek Desain hari Senin, Selasa dipindah ke tim lain, Rabu Sari masuk Desain. Change Budi yang sudah dikomentari rekan tetap sampai ke Sari, jadi board Sari tidak beku. Sebaliknya, kalau Budi memundurkan jam laptopnya dan mengirim change baru, tidak ada rekan yang membangun di atasnya, jadi change itu ditahan.

**Change ditahan vs ditolak.** Op keanggotaan dan change board datang lewat aliran yang berbeda. Change dari anggota baru bisa tiba sebelum op yang memasukkannya ke tim. Karena itu:

| Keadaan | Yang terjadi |
|---|---|
| Tanda tangan, format, hash, atau bentuk dokumen rusak | Ditolak permanen. Id record disimpan di `board_rejected` dan dicatat di `rejected_changes`. |
| Penulis saat ini Tamu | Tidak disimpan dan tidak dicatat. Rekan akan menawarkannya lagi; kalau Tamu itu ternyata baru dijadikan anggota, change diterima setelah op-nya tiba. |
| Penulis anggota, tapi belum punya hak (atau belum didukung rekan) menurut keanggotaan yang diketahui laptop ini | Ditahan di `board_pending` (alasan `rights`), dicatat sekali. Dicoba lagi saat log keanggotaan berubah atau saat change baru untuk proyek itu datang. |
| Penulis belum pernah terlihat sebagai anggota | Tidak disimpan. Rekan akan menawarkannya lagi dan change diperiksa ulang. |
| Change induk belum ada | Ditunggu di `board_pending` (alasan `deps`), hanya kalau penulisnya pernah jadi anggota. |
| Proyek belum dikenal | Ditunggu di `board_pending` (alasan `project`), hanya kalau penulisnya pernah jadi anggota. |

**Batas pending.** `board_pending` paling banyak 20.000 baris dan 64 MiB total. Per laptop pengirim paling banyak 5.000 baris dan 8 MiB. Baris `deps` dan `project` dibuang setelah 30 hari, baris `rights` setelah 90 hari. Satu panggilan penerapan paling banyak 1.000 change atau 16 MiB; sisanya menunggu giliran berikutnya. Satu jawaban `records_for` paling banyak 8 MiB.

**Penawaran.** Laptop hanya menawarkan change proyek yang boleh dilihat rekan saat ini, dan memeriksa lagi setiap id yang diminta rekan. Change yang masih pending atau ditolak tidak pernah diteruskan.

**Dua putaran review keamanan** oleh subagent terpisah, plus satu review tampilan.
- Putaran 1 (setelah fondasi):
  - Hapus task lewat penghapusan key, ganti map task, pindah tim, hidupkan task terhapus: sekarang dinilai per operasi (`rules.rs`), tidak bergantung urutan datang.
  - Komentar dan riwayat atas nama orang lain: ditolak.
  - Pembajakan id proyek lewat change pertama palsu: id proyek diikat ke pembuat dan tim.
  - Backdating oleh anggota yang turun hak: lihat "Hak pada saat change dibuat".
  - Ledakan operasi, batas ukuran record, banjir tabel pending: batas 50.000 operasi, change 120 KiB, kuota pending.
  - Tampilan: 13 temuan, antara lain ubah nama tidak menimpa rekan, izin dicabut saat mengetik, proyek tanpa tim tidak dibuat diam-diam, teks Tamu, dan fokus.
- Putaran 2 (setelah sinkron digabung):
  - Change tanpa dependensi selain change pertama pilihan impor lolos tanpa penilaian: diperbaiki.
  - Bentrok id task dan komentar memecah board: id sekarang terikat ke penulis.
  - Riwayat sah dari orang yang pindah tim tertahan selamanya: aturan "didukung rekan".
  - Plafon nomor task bisa diracuni: nomor dibatasi.
  - Kuota pending dalam byte per pengirim, umur baris `rights`, batas jawaban 8 MiB, cache id proyek terikat.
- Tes konvergensi menemukan tiga bug lagi yang sudah diperbaiki:
  - Change dari Tamu yang baru dijadikan anggota sempat ditolak permanen.
  - Change pendukung dari pengirim lain sempat tidak dinilai bersama change yang ditahan.
  - Kalau dua laptop mengedit task yang sama di detik yang sama, Automerge menulis edit berikutnya sebagai "hapus nilai yang kalah konflik". Aturan sempat menolaknya, sehingga laptop lain tertahan. Sekarang hapus seperti itu diterima selama minimal satu nilai tetap ada.

## Fungsi akses proyek untuk chat dan dokumen

Semua di `src-tauri/src/board/access.rs`. Ketiganya membaca tabel lokal, jadi cukup diberi koneksi SQLite. Hasilnya `AppResult`.

- `projects_accessible_by(conn, peer) -> Vec<ProjectAccess>`. Isi `ProjectAccess`: `project_id`, `team_id` (`None` untuk proyek tanpa tim), dan `can_write` (`false` untuk Tamu).
- `may_access_project(conn, peer, project_id) -> bool`. Hasilnya `false` untuk proyek yang tidak dikenal laptop ini.
- `check_guest_projects(conn, team_id, project_ids)`. Dipakai sebelum membuat undangan Tamu: setiap proyek harus ada di laptop ini dan milik tim itu.

`peer` adalah kunci publik 64 hex, sama dengan `peer` di `FeatureSync`.

Cara pakai untuk channel proyek di chat:
- Di `record_ids_for(peer)` dan `records_for(peer, ids)`, tawarkan pesan channel proyek hanya kalau `may_access_project(conn, peer, project_id)` bernilai `true`. Untuk banyak proyek sekaligus, ambil `projects_accessible_by` sekali lalu saring dengan himpunan id-nya.
- Saat menerima pesan, periksa juga penulisnya dengan `may_access_project`. Tamu boleh bicara di channel proyek yang diizinkan (F-CHAT-06), jadi `can_write` tidak dipakai untuk menyaring pesan chat.
- Daftar channel proyek di layar chat: proyek dari `projects_accessible_by(conn, saya)`.

Cara pakai untuk file proyek di dokumen: tawarkan dan kirim file proyek hanya ke `peer` yang lolos `may_access_project`. Untuk unggahan atau perubahan file, `can_write` bisa dipakai kalau Tamu tidak boleh mengubah file proyek. Aturan Tamu untuk dokumen belum diputuskan di sini.

Fungsi ini menjawab hak saat ini. Kalau chat atau dokumen perlu menerima pesan lama dari orang yang sudah dikeluarkan, pola `RightsHistory` di `policy.rs` bisa dipakai.

## Keputusan yang saya ambil sendiri

| Keputusan | Alasan |
|---|---|
| `permissions/` tidak diubah. | Log keanggotaan Tahap 1 sudah punya undangan Tamu dengan daftar proyek (`InviteCreate { role: guest, projects }`, tabel `guest_access`). Yang ditambahkan hanya pemeriksaan bahwa proyeknya milik tim di undangan (`team_commands.rs`). |
| Proyek tanpa tim terlihat oleh semua anggota aktif kecuali Tamu. | Proyek tanpa tim berarti proyek organisasi. Tamu hanya melihat proyek yang ia diundang. |
| Tamu hanya membaca board, tidak berkomentar. | Tabel izin PRD memberi Tamu "lihat board dan komentar" di proyek yang diizinkan, tanpa hak menulis. Diskusi Tamu lewat channel proyek di chat (F-CHAT-06). Kalau nanti Tamu perlu berkomentar di task, cukup ubah satu aturan di `policy.rs`; tampilan sudah memakai `canComment`. |
| Laptop yang dikeluarkan tidak melihat board lagi. | Semua aksi board mensyaratkan anggota aktif (`AppError::Removed`). Data yang sudah ada di laptop itu tetap tersimpan di disk, tapi tidak ditampilkan dan tidak menerima change baru. |
| Proyek yang dibuat sebelum versi ini tidak disinkronkan. | Id-nya belum terikat ke pembuat dan tim, jadi laptop lain tidak bisa membedakan change pertamanya dari change palsu. Proyek itu tetap bisa dipakai di laptop pembuatnya. |
| Kode proyek ganda hanya diselesaikan di tampilan lokal (PA2, PA3). | Kode di dokumen tidak berubah, jadi tidak perlu change baru dan laptop yang hanya memegang satu proyek tetap melihat PA. |
| Nomor task ganda diselesaikan dengan change bertanda tangan. | Nomor task dipakai di pesan dan catatan, jadi semua laptop harus sepakat dan riwayatnya harus jelas. |
| Change dari orang yang sudah kehilangan hak diterima kalau dibuat sebelum haknya dicabut dan didukung rekan yang masih berhak. | Riwayat sah tetap sampai ke anggota baru, tapi orang yang memundurkan jam laptopnya tidak bisa menulis sendirian. |
| Change dari penulis yang belum dikenal tidak disimpan, tapi juga tidak ditolak permanen. | Op keanggotaan bisa datang belakangan. Menyimpan change dari orang asing membuka celah memenuhi disk. |
| Record board = satu change dengan body JSON dalam urutan field tetap. | Semua laptop menyusun body yang sama dari change yang sama, jadi id record sama di mana-mana dan tidak dikirim dua kali. |
| Draf di tampilan tidak pernah tertimpa muat ulang. | Ketikan pengguna lebih berharga dari tampilan terbaru. Pengguna diberi tahu kalau rekan mengubah isian yang sama. |

## Hasil uji

| Pemeriksaan | Hasil |
|---|---|
| `cargo test` (seluruh crate) | 611 lulus, 0 gagal, 7 diabaikan (tes keyring, firewall, dan mDNS sungguhan milik Tahap 0 dan 1). Tes board: 159. |
| `cargo clippy --all-targets` | tanpa peringatan |
| Vitest | 32 file, 424 tes lulus |
| `tsc --noEmit` | tanpa error |
| Uji ujung ke ujung sinkron board satu laptop (`board-sync-e2e.mjs`) | 23/23 |
| Uji ujung ke ujung board (`board-e2e.mjs`) | 11/11 |
| Uji empat instance (`e2e-multi.mjs`, sama dengan `npm run test:e2e-multi` dengan exe build ini) | 25/25 |

Uji ujung ke ujung dijalankan terhadap build release commit `28e200a` (`npx tauri build --no-bundle`, target terpisah di folder scratch), satu per satu di satu PC, dengan `MIRA_DATA_DIR` dan port CDP sendiri. Folder data uji dihapus oleh skripnya. Proptest konvergensi tiga laptop lulus 5 kali berturut-turut setelah perbaikan terakhir.

Screenshot uji empat instance dengan build ini ada di `docs/progress/screenshots/tahap-1-sinkron-board/`; screenshot Tahap 1 yang lama tidak diubah.

Screenshot di `docs/progress/screenshots/sinkron-board/`:
- Mode terang: `sb-01-tim-desain-terang.png` sampai `sb-09-detail-task-terang.png`, antara lain proyek baru dengan tim, draf yang tetap ada setelah sinkron, ubah nama proyek, dan undangan Tamu dengan pilihan proyek.
- Mode gelap: `sb-10-board-gelap.png`, `sb-11-detail-task-gelap.png`, `sb-12-undangan-tamu-gelap.png`, `sb-13-setelah-restart-gelap.png`.

## Belum dicek atau masih kurang

- Transport jaringan belum digabung ke branch ini. Sinkron sudah diuji di Rust (beberapa database lokal, tiga laptop dengan log keanggotaan sungguhan, proptest) dan di aplikasi satu laptop dengan event tiruan. Belum diuji antar laptop sungguhan atau lewat VPN.
- Tanda "sudah digabung" di kartu (F-TASK-04) masih selalu `false`. Sinkron sudah ada, tapi nilai tanda ini belum diisi.
- "Tambah task" cepat di kolom membuat task tanpa penanggung jawab. Penanggung jawab diisi lewat dialog detail.
- Proyek yang dibuat sebelum versi ini tetap hanya ada di laptop pembuatnya. Belum ada cara memindahkannya ke id yang terikat.
- Data board di laptop yang dikeluarkan tidak dihapus dari disk, hanya tidak ditampilkan.
- Change yang ditolak tercatat di `rejected_changes`, tapi belum ada layar untuk admin melihatnya.

## Catatan merge

- **Migrasi.** Satu entri di akhir `MIGRATIONS` di `src-tauri/src/db/migrations.rs`: `crate::board::schema::BOARD_SYNC_SCHEMA`. Nomornya v6 di branch ini. Brief menyebut v7, jadi nomor final ditentukan saat merge, sesuai entri lain yang masuk lebih dulu. SQL-nya hanya bergantung pada tabel board v3.
- **`lib.rs`.** Hanya baris registrasi:
  - Hook board dibungkus `board::feature::BoardSyncNotifier::new(...)` di sekitar pengingat.
  - `board::feature::register(app.handle())` sesudah `FeatureHub` di-manage.
  - `board::commands::board_update_project` di `generate_handler!`.
- **`team_commands.rs`.** Satu pemeriksaan di `create_invite`: untuk undangan Tamu, `board::access::check_guest_projects` memastikan proyeknya milik tim di undangan.
- **`documents/schema.rs`.** Tes migrasi dokumen ikut v6: `latest_version()` sekarang 6, dan tes membatalkan tabel v6 dulu sebelum menjalankan ulang migrasi. Kalau nomor migrasi berubah saat merge, tes ini ikut disesuaikan.
- **Kontrak `network/feature.rs`.** Tidak diubah. `network/node.rs` dan `network/wire.rs` juga tidak.
- **Kebutuhan untuk transport.**
  - Setelah `ingest` mengembalikan `changed: true`, transport memancarkan `mira://feature` dengan payload `{ topic }`. UI board sudah mendengarnya dan hanya bereaksi pada `topic: "board"`.
  - Semua method `BoardFeature` sinkron dan membuka SQLite, jadi transport perlu memanggil `ingest` (dan method lain) di thread blocking, sesuai catatan di kontrak.
  - `peer_connected` dipakai untuk mencoba lagi change yang ditahan. Transport cukup memanggilnya saat rekan tersambung.
  - Tidak ada kebutuhan tambahan lain yang saya temukan.
- **Di luar repo.** Folder `D:\GitHub\ChatCompany` tidak disentuh.
