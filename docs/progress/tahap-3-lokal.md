# Laporan Tahap 3 (bagian lokal): Board dasar

Tanggal: 22 November 2026. Branch `claude/tahap-3-board-lokal-38babd`. Rencana: `docs/plans/tahap-3-lokal.md`.

## Ringkasan

Board sudah bisa dipakai penuh di satu laptop, tanpa jaringan. Pengguna bisa membuat proyek dengan kode sendiri (misalnya PA), menambah task (PA-1, PA-2, dan seterusnya), mengisi detailnya, memindahkan task antar kolom dengan seret mouse atau keyboard, melihat semua task miliknya di halaman "Task saya", dan menerima pengingat tenggat lewat notifikasi Windows.

Setiap perubahan board disimpan sebagai change Automerge yang ditandatangani kunci laptop. Log ini siap dikirim ke rekan saat jaringan board disambung. Penggabungan edit dari dua laptop yang sama-sama offline sudah diuji di Rust dengan dua database lokal, tapi belum lewat jaringan sungguhan.

Semua tes lulus dan semua pekerjaan sudah di-commit lokal di branch ini. Tidak ada push, remote baru, atau merge ke `main`.

## Yang dibuat

**Inti Rust (`src-tauri/src/board/`)**
- `schema.rs`: tabel `board_projects`, `board_changes`, `board_task_index`, dan `board_reminders_sent`, sebagai satu entri migrasi baru (v3 di branch ini).
- `model.rs`: tipe data dan validasi. Isinya:
  - Nama proyek 2 sampai 80 karakter.
  - Kode proyek 2 sampai 6 huruf besar atau angka, diawali huruf, dan unik.
  - Judul task maksimal 200 karakter, deskripsi maksimal 10.000.
  - Maksimal 10 label, masing-masing maksimal 30 karakter.
  - Komentar maksimal 5.000 karakter.
  - Tanggal tenggat harus berbentuk `YYYY-MM-DD` yang valid.
- `doc.rs` dan `rank.rs`: dokumen Automerge per proyek, dengan operasi buat, ubah, pindah, hapus, dan komentar. Setiap operasi menambah satu baris riwayat aktivitas.
  - Judul dan deskripsi disimpan sebagai teks Automerge, jadi edit bersamaan digabung per karakter.
  - Urutan kartu dalam kolom memakai rank pecahan, jadi pindah satu kartu biasanya hanya menulis satu nilai.
- `sign.rs`: tanda tangan dan pemeriksaan change. Yang ditolak:
  - Tanda tangan rusak atau penanda tangan lain dari pembuat change. Pembuat change Automerge (actor) adalah kunci publik laptop.
  - Hash yang tidak cocok.
  - Change terkompresi, karena bisa dipakai untuk menghabiskan memori.
  - Ukuran di atas 256 KiB.
- `store.rs`: simpan dan muat proyek. Baris change, snapshot dokumen, dan indeks task ditulis dalam satu transaksi SQLite.
- `policy.rs` dan `assignees.rs`: izin dan daftar penanggung jawab. Keduanya dibaca dari tabel lokal `members` dan `team_members`.
- `sync.rs`: titik sambung untuk jaringan (lihat di bawah).
- `commands.rs`: 10 command Tauri sesuai kontrak. Setiap perubahan memancarkan event `mira://board`.
- `reminder.rs`: pengingat tenggat. Pengecekan berjalan sekitar 5 detik setelah aplikasi dibuka, lalu setiap 15 menit, dan langsung setelah ada perubahan di board.

**Tampilan (`src/screens/board/`, `src/api/board.ts`)**
- Menu Board punya kolom navigasi kedua: "Task saya", daftar proyek dengan jumlah task terbuka, dan tombol "Proyek baru". Kode proyek diusulkan otomatis dari nama.
- Board tiga kolom: To do, Dikerjakan, Selesai.
  - Kartu menampilkan kode, judul, inisial penanggung jawab, tenggat ("Hari ini", "Besok", "Terlambat 2 hari"), prioritas, label, dan jumlah komentar.
  - Setiap kolom punya "Tambah task" cepat.
- Cara memindah task:
  - Seret dan lepas, dengan penanda posisi.
  - Tombol "Pindahkan PA-3" di setiap kartu, berisi menu ke kolom lain atau naik dan turun satu posisi.
  - Pintasan Alt+Panah pada kartu yang sedang difokus.
  - Setiap pemindahan diumumkan ke pembaca layar, dan fokus tetap di kartu yang dipindah.
- Dialog detail task:
  - Bisa mengubah judul, deskripsi, status, penanggung jawab, tenggat, prioritas, dan label.
  - Ada komentar dan riwayat aktivitas dalam kalimat biasa, misalnya "Anda memindahkan task ke Dikerjakan".
  - Hapus task memakai konfirmasi. Tanda "sudah digabung" sudah disiapkan.
- Halaman "Task saya":
  - Task dikelompokkan jadi Terlambat, Hari ini, Besok, 7 hari ke depan, Nanti, dan Tanpa tenggat. Task yang sudah selesai ada di grup "Selesai" yang bisa dibuka.
  - Di sampingnya ada pengaturan pengingat: "Sehari sebelum tenggat" dan "Di hari tenggat", berlaku per laptop.
- Setiap layar punya keadaan memuat, kosong, dan error yang menjelaskan penyebab dan langkah berikutnya.

**Uji ujung ke ujung**
- `scripts/board-e2e.mjs` menjalankan aplikasi hasil build dengan folder data baru dan mengendalikannya lewat DevTools Protocol. Skrip memakai alur yang sama dengan `smoke-e2e.mjs`, melewati panduan firewall tanpa mengubah pengaturan Windows, lalu menghapus folder data dan kunci uji buatannya sendiri.

## Keputusan yang saya ambil sendiri

| Keputusan | Alasan |
|---|---|
| Actor Automerge = 32 byte kunci publik laptop. | Penerima bisa langsung mencocokkan pembuat change dengan penanda tangan. |
| Snapshot dokumen disimpan di samping log change, ditulis dalam satu transaksi. | Board cepat dibuka tanpa memutar ulang semua change. Log tetap jadi sumber kebenaran untuk sinkron. |
| Tabel `board_task_index` sebagai turunan dokumen. | "Task saya" dan pengingat tidak perlu membuka semua dokumen proyek. |
| Kolom tetap: To do, Dikerjakan, Selesai. | Sesuai F-TASK-01. Kolom tambahan diatur admin di R3. |
| Prioritas (Tanpa, Rendah, Sedang, Tinggi) dan label teks bebas sudah ada. | Brief Tahap 3 memintanya, walaupun PRD menaruhnya di R3. Label belum diatur admin. |
| Hapus task = ditandai terhapus, tidak dibuang dari dokumen. | Edit dari laptop lain yang datang belakangan tidak memunculkan task setengah jadi. |
| Nomor task dari penghitung di dokumen. | Di satu laptop selalu unik. Nomor ganda setelah sinkron dicatat sebagai titik sambung. |
| Penanggung jawab = diri sendiri ditambah anggota aktif non-Tamu dari tabel `members`. Kalau proyek punya tim, hanya anggota tim itu. | Tabel `members` sudah diisi Tahap 1 di branch ini, jadi daftar ini otomatis ikut terisi saat ada anggota. Di laptop baru, isinya hanya diri sendiri. |
| Izin lokal mengikuti tabel izin PRD, dibaca dari peran di tabel lokal. | Membuat proyek: Superadmin atau Admin tim. Membuat, mengedit, memindah task, dan berkomentar: anggota aktif non-Tamu. Menghapus task: pembuatnya, Admin tim proyek itu, atau Superadmin. |
| Tenggat berupa tanggal saja, dihitung dengan zona waktu Windows. | Cukup untuk pengingat "sehari sebelum" dan "di hari tenggat". |
| Pengingat yang terlewat karena laptop mati dikirim kalau tenggatnya paling lama 3 hari lalu. Lebih dari 3 pengingat sekaligus digabung jadi satu notifikasi. | Supaya laptop yang lama mati tidak langsung dibanjiri notifikasi. |
| Pengingat untuk tenggat yang diubah dikirim lagi. | Catatan "sudah dikirim" disimpan per task, jenis pengingat, dan tanggal tenggat. |
| Pengaturan pengingat memakai `get_setting` dan `set_setting` yang sudah ada (`board.reminder.day_before`, `board.reminder.due_day`). | Tidak perlu command baru dan tidak menyentuh layar Pengaturan Tahap 0. |
| `ReminderTrigger` dipakai sebagai `BoardSyncHook`. | Tenggat baru untuk hari ini langsung dicek tanpa menunggu 15 menit. |
| Satu varian error baru: `InvalidInput` (`invalid_input`). | Error validasi board tidak cocok dengan kode yang sudah ada. |
| Isian di dialog detail tersimpan saat fokus pindah atau Enter, bukan di setiap tombol panah. | Di WebView2, panah pada select yang tertutup memicu perubahan di setiap langkah, sehingga bisa memindah task dua kali. |

## Hasil uji

Semua angka di bawah dari menjalankan ulang di sesi ini setelah perbaikan terakhir.

- `cargo test` (seluruh crate): `test result: ok. 254 passed; 0 failed; 6 ignored`. Yang di-ignore adalah tes keyring dan firewall sungguhan milik Tahap 0 dan 1. `cargo clippy --all-targets`: tanpa peringatan.
  - Tes board mencakup: validasi setiap batas, tanda tangan rusak, actor lain, change terkompresi, dan change yang merusak bentuk dokumen. Juga dua change berbeda dengan nomor urut yang sama, serta izin per peran.
  - Skenario selesai Tahap 3: dua laptop mengubah task yang sama saat offline. A mengubah judul dan memindah ke Dikerjakan, B mengubah deskripsi, berkomentar, dan mengisi tenggat. Setelah bertukar change, keduanya melihat hasil yang sama dan tidak ada data hilang. Ditambah proptest dengan urutan operasi acak di kedua laptop.
  - Pengingat: besok, hari ini, terlewat saat laptop mati, sudah dikirim, tenggat berubah, task selesai atau dihapus, pengaturan mati, dan ringkasan kalau lebih dari 3.
- Vitest: `Test Files 13 passed (13)`, `Tests 158 passed (158)`. `npx tsc --noEmit`: tanpa error. Di tengah pekerjaan, satu agen sempat melihat vitest gagal karena waktu habis saat mesin sedang sibuk. Run terakhir di sesi ini lulus semua.
- Uji ujung ke ujung (`node scripts/board-e2e.mjs src-tauri/target/debug/mira.exe <folder screenshot> <folder data>`, build `npx tauri build --debug --no-bundle`): 10 dari 10 pemeriksaan lulus:
  - Board kosong tampil, kode PA diusulkan, dan proyek dibuat.
  - Empat task dibuat lewat "Tambah task".
  - Alt+Panah kanan memindah ke Dikerjakan, dan menu Pindahkan memindah ke Selesai.
  - Seret mouse sungguhan memindah ke Dikerjakan.
  - Detail task menyimpan deskripsi, penanggung jawab, tenggat, prioritas, label, dan komentar.
  - "Task saya" hanya berisi task milik saya.
  - Setelah restart, proyek, task, dan posisi kolom tetap.
- Review oleh dua subagent terpisah (inti Rust dan tampilan). Semua temuan high dan medium sudah diperbaiki, kecuali satu keputusan yang sengaja ditunda (anggota yang dikeluarkan, lihat titik sambung).

Screenshot di `docs/progress/screenshots/`:
- Mode terang: `t3-01-board-kosong-terang.png`, `t3-02-proyek-baru-terang.png`, `t3-03-board-terang.png`, `t3-04-detail-task-terang.png`, `t3-05-task-saya-terang.png`.
- Mode gelap: `t3-06-board-gelap.png`, `t3-07-detail-task-gelap.png`, `t3-08-task-saya-gelap.png`.

**Belum dicek atau masih kurang**
- Notifikasi Windows tidak saya lihat langsung di layar. Selama uji ujung ke ujung, ada task bertenggat hari ini dan besok, dan aplikasi tidak menulis error pengingat. Di Windows, plugin notifikasi selalu melaporkan berhasil, jadi kalau notifikasi gagal tampil, pengingatnya tetap tercatat terkirim dan tidak dicoba lagi.
- Isian tanggal di dialog detail tampil dengan format Amerika (11/23/2026), mengikuti bahasa WebView2. Di bawahnya tertulis "Besok" atau tanggal Indonesia, jadi tetap terbaca. Perbaikan yang rapi: pemilih tanggal sendiri, atau mengatur bahasa WebView2.
- Panel jaringan di sidebar menampilkan "Status jaringan belum terbaca ... get_network_status not found". Ini bukan dari board: base branch ini (`8d2023a`) belum mendaftarkan command jaringan Tahap 1 di `lib.rs`. `main` sekarang sudah mendaftarkannya, jadi pesan ini hilang setelah branch ini digabung dengan `main`.
- Tanda "sudah digabung" di kartu (F-TASK-04) baru dites dengan data tiruan. Nilainya selalu `false` sampai sinkron board ada.
- Task dari pesan chat (F-TASK-03) belum ada karena chat (Tahap 2) belum ada.
- "Task saya" membuka dokumen setiap proyek yang punya task milik saya pada setiap muat ulang (polling 15 detik). Tidak terasa untuk ukuran kantor 10 sampai 30 orang, tapi bisa dioptimalkan dari `board_task_index`.

## Titik sambung untuk jaringan dan izin peran

Semua di `src-tauri/src/board/`:

| Titik sambung | Isi sekarang | Yang perlu dilakukan nanti |
|---|---|---|
| `sync::BoardSyncHook::on_local_change(project_id, &SignedChange)` | Dipanggil setelah setiap perubahan lokal yang sudah tersimpan. Di `lib.rs` diisi `ReminderTrigger`. | Ganti dengan hook gabungan: kirim ke rekan yang boleh menerima (anggota tim proyek, Tamu proyek itu) dan tetap memicu pengingat. |
| `sync::heads`, `sync::changes_since(conn, project_id, have_heads)` | Sudah jalan dan dites. | Dipakai untuk menjawab permintaan sinkron dari rekan. |
| `sync::apply_remote_changes(conn, policy, project_id, from_peer, changes) -> ApplyReport` | Sudah jalan dan dites. Urutannya: periksa tanda tangan, periksa izin pembuat sebelum membuka isi change, gabungkan satu per satu. Change yang gagal digabung atau merusak bentuk dokumen ditolak dan dokumen dikembalikan. Change yang ditolak dicatat di `rejected_changes`. Satu panggilan paling banyak 1000 change atau 16 MiB; sisanya dihitung di `deferred`. | Setelah change dari rekan diterapkan, panggil juga pemancar `mira://board` dan `ReminderTrigger::check_now()`. Keduanya belum dipanggil dari jalur ini. |
| `sync::import_project(...)` | Membuat proyek dari laptop lain dari change pertamanya. Penanda tangannya harus boleh membuat proyek. | Kode proyek yang bentrok dengan proyek lokal sekarang ditolak (`invalid_input`). Perlu aturan penggantian kode. |
| `sync::duplicate_numbers` dan `sync::resolve_duplicate_numbers` | Pendeteksi sudah ada. Fungsi penomoran ulang masih kosong, aturannya ditulis di komentar. | Isi dan panggil setelah sinkron. |
| Anggota yang dikeluarkan (komentar modul `sync.rs`) | Change dari anggota yang sudah dikeluarkan selalu ditolak, termasuk change yang ia buat sebelum dikeluarkan tapi baru sampai sesudahnya. | Keputusan terbuka untuk tahap jaringan. Kalau tetap ditolak, change lain yang bergantung padanya tertahan di `missing_deps`, dan dua laptop bisa berbeda isi. |
| `policy::BoardPolicy::check(conn, actor, &BoardAction)`, implementasi `LocalRolePolicy` | Peran dibaca dari tabel lokal hasil fold Tahap 1. | Ganti atau perluas dengan pemeriksaan dari `permissions::OrgState`, termasuk Tamu per proyek (`guest_access`). Change dari rekan sekarang hanya dicek "anggota aktif non-Tamu"; aturan hapus yang lebih ketat belum berlaku untuk change dari rekan. |
| `assignees::AssigneeDirectory`, implementasi `LocalMembers` | Diri sendiri ditambah anggota aktif dari tabel lokal. | Saring per tim dan proyek dari hasil fold, termasuk Tamu kalau perlu. |
| `reminder::Notifier`, `reminder::ReminderSource` | `TauriNotifier` dan `SqlReminderSource`. | Tidak perlu diubah untuk jaringan. Cukup dipicu ulang setelah change dari rekan. |

## Catatan merge

- **Migrasi.** `src-tauri/src/db/migrations.rs` mendapat satu entri baru di akhir `MIGRATIONS`: `crate::board::schema::BOARD_SCHEMA`. Di branch ini nomornya v3, karena v2 dipakai Tahap 1. Kalau Tahap 4 atau 5 juga menambah entri, urutannya cukup disusun ulang saat merge. SQL board tidak bergantung pada tabel Tahap 4 atau 5, jadi nomornya boleh di mana saja setelah v2.
- **`lib.rs`.**
  - `pub mod board;`
  - `.plugin(tauri_plugin_notification::init())`
  - Di `setup`: `board::reminder::spawn(...)` lalu `app.manage(board::commands::BoardRuntime { hook })`.
  - 10 baris `board::commands::board_*` di `generate_handler!`.
- **`error.rs`.** Satu varian di akhir enum, `InvalidInput` (`invalid_input`), dan satu baris di tes kode error. Kalau tahap lain menambah varian dengan nama yang sama, pakai salah satunya saja.
- **`Cargo.toml` dan `Cargo.lock`.**
  - `automerge = "0.12.0"` dan `tauri-plugin-notification = "2"`.
  - Fitur `local-offset` dan `macros` di `time`.
  - `proptest` di dev-dependencies.
- **Tampilan.**
  - `src/screens/board/BoardScreen.tsx` (placeholder Tahap 0) diganti, dengan nama ekspor yang sama.
  - Semua file baru ada di `src/screens/board/` dan `src/api/board.ts`. Shell, sidebar, `api/index.ts`, `global.css`, dan komponen bersama tidak diubah.
  - Event board memakai fungsi langganannya sendiri (`subscribeBoard`), jadi tipe `MiraEvent` di `api/index.ts` tidak disentuh.
- **Base branch dan uji merge.** Branch ini bercabang dari `8d2023a`. Saat laporan ini ditulis, `main` sudah 7 commit lebih maju (sampai `f9a93fd`, integrasi Tahap 1 lengkap). Saya mencoba merge tanpa mengubah apa pun (`git merge-tree --write-tree HEAD main`). Hasilnya: hanya dua file yang bentrok, dan di keduanya kedua sisi sama-sama menambah baris, jadi penyelesaiannya adalah mengambil keduanya:
  - `src-tauri/src/db/migrations.rs`: `main` masih `[V1_FOUNDATION, V2_MEMBERSHIP_LOG]`, branch ini menambah `crate::board::schema::BOARD_SCHEMA`. Akhir baris file ini sudah saya samakan ke LF seperti di `main`, supaya bentroknya hanya baris ini.
  - `src-tauri/src/lib.rs`: di `setup`, blok pengingat dari branch ini dan blok `AppNet` dari `main` dipakai dua-duanya. Di `generate_handler!`, 10 command board ditambah command tim dan jaringan dari `main`.
  - File lain, termasuk `error.rs`, `Cargo.toml`, dan semua file board, tergabung otomatis. Saya tidak menjalankan tes pada hasil gabungan itu, karena keputusan merge ada di user.
- **Setelah merge.** Hook sinkron jaringan (`AppNet` di `main`) dan `BoardRuntime` di branch ini belum saling kenal. Sambungannya dikerjakan di bagian jaringan Tahap 3, lewat titik sambung di atas.
- **Di luar repo.** Folder `D:\GitHub\ChatCompany` tidak disentuh. Folder data uji dibuat di folder scratch sesi dan sudah dihapus. Proses aplikasi yang dijalankan uji sudah dihentikan.
