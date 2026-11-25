# Laporan: foto profil

Tanggal 25 November 2026. Branch `claude/foto-profil-e4373f`, dari `main` a45d1b3 (v0.5.0). Rencana dan kontrak: [foto-profil.md](../plans/foto-profil.md).

Permintaan user: "user bisa ganti foto profile".

## Ringkasan

| Bagian | Hasil |
|---|---|
| Komponen `Avatar` | `src/components/Avatar.tsx`: foto kalau ada, inisial kalau belum ada atau gagal dimuat. Ukuran sm/md/lg (24/32/72 px) atau kelas lama lewat `className`, titik online opsional, dekoratif (`aria-hidden`) atau bermakna (`role="img"` dengan nama). |
| Layar | Avatar inisial diganti di 19 file: board (7), dokumen (1), chat (7), organisasi (3), Shell (1). Di chat dan org hanya elemen avatar dan baris import yang berubah. |
| Ganti foto | Pengaturan > Profil (bagian baru, paling atas di menu) dan menu profil di sidebar ("Menu profil Anda": Ganti foto, Hapus foto, Buka profil). File dipilih lewat dialog Rust, dipotong persegi dengan geser dan zoom (mouse, roda, slider, tombol, panah, Shift, +/-), disimpan 256x256 JPEG. |
| Privasi | Orientasi EXIF diterapkan lalu semua metadata dibuang (encoder hanya menulis JFIF). Foto e2e: 8.594 byte, tanpa `Exif` dan tanpa penanda GPS. |
| Sinkron | Record bertanda tangan di topik baru `profile`. Terbaru per pemilik menang. Disebar ke semua anggota aktif termasuk Tamu. Laptop yang dikeluarkan tidak menerima record maupun foto. |
| Superadmin | Daftar "Foto anggota" di Pengaturan > Profil. Penghapusan adalah record bertanda tangan superadmin untuk satu hash foto. Pemilik melihat catatan dan bisa memasang foto lain. |
| Laptop 0.5.x | Topik `profile` tidak dikenal dan diabaikan transport, jadi laptop lama tetap menampilkan inisial. Tidak perlu gerbang versi. |

## Format dan aturan

- Record JSON kanonik `{v, kind, org, owner, author, photo, size, seq, at, sig}`, tanda tangan ed25519 atas `mira/profile/v1\n` + JSON dengan `sig` kosong. Satu record hanya punya satu encoding: body yang berbeda dari hasil serialisasi ulang ditolak.
- `set` dan `clear` hanya sah kalau `author == owner`. Pemenang per pemilik: `seq` tertinggi, lalu `at`, lalu id. `seq` baru = maks yang diketahui + 1.
- `remove` hanya diterima dari superadmin aktif dan dinilai ulang saat dibaca: kalau penulisnya bukan superadmin lagi, penghapusannya tidak berlaku. Penghapusan berlaku untuk hash itu pada semua pemilik, jadi anggota lain tidak bisa menerbitkan ulang foto yang sudah dihapus.
- Tabel baru (migrasi v10, `profile/schema.rs`): `profile_records` (hanya record aktif: satu pemenang per pemilik plus `remove`), `profile_seen` (id record yang sudah kalah, supaya tidak diminta ulang), `profile_fetch` (antrean unduhan lokal).
- Foto disimpan di `BlobStore` terpisah, `<data_dir>/profile-photos`, supaya foto lama aman dihapus tanpa menyentuh blob chat atau dokumen.
- Penolakan dicatat lewat `permissions::log_rejection` dengan alasan `profile_invalid`, `profile_org`, `profile_not_member`, `profile_not_owner`, `profile_not_superadmin`.
- Unduhan: `hub.fetch_blob(hash, 128 KiB, [owner], tmp)`, jeda mulai 60 detik dan berlipat sampai 1 jam, direset saat rekan tersambung. Laptop mana pun yang memegang foto efektif boleh menyajikannya, jadi laptop yang offline bisa menyusul dari rekan lain.

## Pengolahan gambar (`profile/image.rs`)

- Format dikenali dari magic bytes: PNG, JPEG, WebP. GIF, SVG, BMP, dan lainnya ditolak. WebP beranimasi ditolak.
- Batas sebelum dekode: file 20 MB, sisi 16 sampai 8000 piksel, 24 juta piksel, alokasi 256 MiB. Header PNG palsu 9000x9000 ditolak tanpa alokasi besar. JPEG terpotong ditolak (harus ada marker EOI).
- Potong, ratakan alfa di atas putih, perkecil Lanczos3 ke 256x256, JPEG kualitas 88 turun bertahap sampai di bawah 100 KB.
- Foto dari rekan harus JPEG polos 256x256 sampai 128 KiB: hanya SOI, APP0 JFIF tanpa thumbnail, DQT, SOF0/SOF2, DHT, DRI, SOS, EOI. APP1 sampai APP15, COM, dan data setelah EOI ditolak, jadi kanal foto tidak bisa membawa metadata atau file lain.

## Perintah Tauri

`profile_photos`, `profile_photo_data`, `profile_my_photo`, `profile_pick_photo`, `profile_set_photo`, `profile_clear_photo`, `profile_admin_remove_photo`. Path file tidak pernah datang dari webview: `profile_pick_photo` membuka dialog Rust dan mengembalikan token (satu token terakhir, 10 menit, byte asli di memori). Kait uji `MIRA_E2E_PICK_PHOTO` hanya ada di build debug.

## Keputusan

- **Foto selalu JPEG.** Encoder WebP di crate `image` hanya lossless (lebih besar). JPEG 256x256 rata-rata di bawah 20 KB.
- **Pengolahan di Rust**, bukan di tampilan: webview tidak pernah membaca file asli, dan metadata dibuang di satu tempat yang dites.
- **Bagian Profil paling atas di menu Pengaturan, tetapi Pengaturan tetap terbuka di Tampilan**, karena e2e lama memilih tema tepat setelah membuka Pengaturan.
- **Pengaturan > Profil untuk penghapusan oleh superadmin**, bukan menu di layar Organisasi, supaya file `src/screens/org/` yang sedang diubah sesi lain tetap hanya berisi penggantian avatar.
- **Tanpa perubahan di `src-tauri/src/permissions/` dan `network/`.** Topik `TOPIC_PROFILE` didefinisikan di `profile/mod.rs`.
- **Pemotong**: perbesaran 1 berarti sisi potong sama dengan sisi pendek gambar (foto selalu memenuhi bingkai), maksimum 4x atau sampai sisi potong 64 piksel sumber. Panah menggeser foto searah panah, seperti menyeret. Posisi dan perbesaran diumumkan ke pembaca layar setelah 400 ms.
- **Foto gagal dimuat** kembali ke inisial; menu profil menentukan ada tidaknya "Hapus foto" dari peta hash, bukan dari data gambar.

## Review

- **Tampilan** (subagent terpisah): 3 harus diperbaiki (fokus hilang setelah hapus foto sendiri, setelah hapus foto anggota, dan tombol `disabled` saat dialog file terbuka) dan 8 saran (cincin masker di tema gelap, petunjuk +/-, langkah slider 5, pengumuman pembaca layar, judul konfirmasi kosong saat menutup, menu Shell memakai hash, istilah Inggris, akhir baris CRLF). Semua dikerjakan, dengan tes.
- **Keamanan** (subagent terpisah): 3 harus diperbaiki, semua dikerjakan dengan tes:
  1. foto rekan yang membuat decoder panic bisa membuat crash berulang (release memakai `panic = "abort"`): baris antrean sekarang ditandai buruk dan di-commit sebelum dekode;
  2. banjir record membuat setiap operasi memindai seluruh tabel di bawah kunci inti: record yang kalah dipangkas jadi id saja, query memakai indeks, GC hanya hash yang berubah, satu record per pemilik per batch;
  3. foto rekan bisa membawa metadata atau muatan lain: whitelist struktur JPEG.
  Saran yang juga dikerjakan: sapu file sementara dan foto yatim saat mulai, penghapusan per hash untuk semua pemilik, token kedaluwarsa dilepas, batas `seq` dengan pesan jelas, batas piksel diturunkan.

## Tes

- `cargo test --lib profile`: 58 lulus (record, sinkron tiga laptop di memori, hapus oleh superadmin dan superadmin yang turun pangkat, hanya pemilik yang bisa memasang, encoding lain dan tanda tangan salah ditolak, laptop dikeluarkan tidak menerima apa pun, Tamu menerima, `blob_path_for`, tombstone, crash decoder, gambar: sniff, EXIF orientasi 6 dan penanda GPS hilang, ukuran, alfa, dimensi besar, WebP beranimasi, JPEG terpotong, whitelist, fuzz ringan).
- `cargo clippy --all-targets -- -D warnings`: bersih.
- `npx tsc --noEmit`: bersih.
- E2E baru `scripts/profile-e2e.mjs` (dua instance, `E2E_PORT_OFFSET`): 44/44 lulus. A memasang foto lewat pemotong; B melihat foto A di chat, board, dan Organisasi dalam 11 sampai 16 detik; foto di B tanpa Exif/GPS dan di bawah 100 KB; A menghapus foto dan B kembali ke inisial dalam 1 detik; B dimatikan, A memasang foto baru, B dinyalakan dan menyusul dalam 23 detik.
- E2E lama, satu per satu: `chat-e2e` 39/39, `org-e2e` 33/33, `english-e2e` 39/39 (cek "lima bagian" Pengaturan diubah jadi enam), `board-e2e` 43/43 (putaran pertama 42/43 karena jeda tetap 250 ms, lulus setelah skrip menunggu kartu terakhir).

## Verifikasi akhir

Di commit terakhir branch ini, satu per satu, dengan `TMP`/`TEMP` di D: dan `CARGO_BUILD_JOBS=2`:

- `cargo test`: 1271 lulus, 7 diabaikan (tes lama yang memang ditandai `ignore`).
- `cargo clippy --all-targets -- -D warnings`: bersih.
- `npx tsc --noEmit`: bersih.
- `npx vitest run --pool=threads --maxWorkers=2`: 124 file, 1826 tes lulus. Dengan pool bawaan, PC yang sedang dipakai banyak sesi kadang gagal memulai worker (timeout); itu bukan kegagalan tes.
- E2E: `profile-e2e` 44/44, `chat-e2e` 39/39, `board-e2e` 43/43, `org-e2e` 33/33, `english-e2e` 39/39.

## Screenshot

`docs/progress/screenshots/foto-profil/`: Pengaturan > Profil tanpa dan dengan foto, pemotong, konfirmasi hapus, pemotong dari menu sidebar, foto A di chat/board/Organisasi laptop B, B setelah foto dihapus dan setelah foto baru. Profil dan pemotong ada dalam tema terang dan gelap, bahasa Indonesia dan Inggris (`fp-10-*`, `fp-11-*`).

## Catatan untuk penggabungan

- Migrasi `PROFILE_SCHEMA` ditambahkan sebagai v10 setelah `V9_ORG_V03`. Kalau sesi lain juga menambah v10, urutkan saat menggabung; migrasi ini belum pernah dirilis.
- `src/i18n/errors-rust.id.ts`/`.en.ts`: grup `profile` ditambahkan di akhir.
- `scripts/english-e2e.mjs` menghitung enam bagian Pengaturan. `scripts/board-e2e.mjs` sekarang menunggu kartu terakhir sebelum cek "Empat task dibuat di To do" (sebelumnya jeda tetap 250 ms, gagal di PC yang sibuk).
- Saran di luar lingkup: `board-e2e`, `org-e2e`, dan `chat-e2e` masih menghapus semua kredensial `device-key-*` baru, termasuk milik sesi lain yang sedang berjalan; samakan dengan pola `ourKeys` di `join-e2e.mjs`. Port `chat-e2e` belum ikut `E2E_PORT_OFFSET`. Untuk sesi ini skrip itu dijalankan dari salinan sementara yang sudah ditambal.

## Batasan

- Peminta bergabung belum punya foto (record hanya diterima dari anggota), jadi di daftar permintaan bergabung tetap inisial.
- Foto lama yang sudah kalah tidak bisa dikembalikan; hanya foto terbaru yang disimpan.
- Laptop yang database-nya direset tetapi kuncinya sama mulai lagi dari `seq` 1; foto barunya kalah dari record lamanya sampai sinkron selesai, lalu foto berikutnya menang.
