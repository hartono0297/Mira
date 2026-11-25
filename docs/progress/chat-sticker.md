# Laporan: reaksi, emoji, dan sticker di Chat (v0.5.1)

Tanggal: 25 November 2026. Branch `claude/chat-sticker-eac793`, dari `main` a45d1b3 (v0.5.0). Rencana dan kontrak: `docs/plans/chat-sticker.md`.

Permintaan user: "gw mau ada fitur kirim sticker, emote di chat". Tambahan dari session utama di tengah jalan: "gw mau di chat, muncul semua label yang user itu punya", dan reaksi harus bisa ke pesan siapa pun. Reputasi "Kopi" bukan bagian sesi ini; permintaan user soal Kopi ("bikin status reputasi seperti kopi tersebut rewarding, seperti selesai kerjakan task dll") yang datang ke sesi ini diteruskan ke session utama untuk brief sesi Kopi.

## Ringkasan

- **Reaksi** di pesan siapa pun: chip emoji dengan jumlah di bawah pesan, klik untuk menambah atau menghapus reaksi sendiri, arahkan atau fokus untuk melihat siapa saja. Reaksi cepat 👍 ❤️ 😂 🙏 😮 di bilah aksi pesan, "Beri reaksi lain" membuka pemilih emoji, dan menu pesan punya "Beri reaksi". Satu orang boleh beberapa emoji per pesan, satu kali per emoji. Tanpa notifikasi.
- **Pemilih emoji** di kolom pesan: cari dalam bahasa Indonesia dan Inggris ("jempol", "thumbs"), kategori, "Baru dipakai" per laptop, tab "Emote kantor", dan saran saat mengetik `:nama` (emote kantor dulu, lalu emoji). Emoji Unicode bawaan sistem; data 393 emoji ditulis sendiri (sekitar 22 KB sumber), tanpa pustaka.
- **Sticker kantor**: superadmin mengelolanya di Organisasi, tab Sticker (unggah PNG, WebP, atau GIF paling besar 512 KB, nama `:nama:`, kata kunci, paket, sembunyikan, tampilkan, hapus). Satu sticker kantor dipakai dua cara: dikirim sebagai pesan sticker (gambar 160 px tanpa gelembung) dan sebagai emote `:nama:` di teks (gambar kecil sebaris). Disebar lewat record bertanda tangan di topik chat dan blob store, tanpa internet.
- **Sticker pribadi**: "Simpan sticker" dari menu pesan, atau unggah sendiri di pemilih sticker tab "Punya saya". Sticker pribadi yang dikirim ikut tersebar sebagai lampiran pesan.
- **Admin menyembunyikan** pesan sticker lewat "Hapus pesan" yang sudah ada (pengirim, superadmin, dan admin departemen di channel departemennya; aturan lama tidak diubah).
- **Semua label** keahlian orang tampil di Chat: baris penulis pesan (termasuk pesan saya, "Anda" dengan label saya), kepala pesan pribadi, anggota grup dan proyek, dan profil. Chip turun baris. Sidebar tetap ringkas dengan "+N". Organisasi dan Board tetap maksimal 3 seperti sebelumnya.
- **Tanpa paket sticker bawaan.** Tidak ada sticker yang meniru LINE, WhatsApp, Kaskus, atau karya lain. Keadaan kosong mengajak kantor menambahkan sticker sendiri.

Screenshot (aplikasi sungguhan, data uji, dari `sticker-e2e`) di `docs/progress/screenshots/chat-sticker/`: `01-reaksi`, `02-label-semua`, `03-pemilih-emoji`, `04-pemilih-sticker`, `05-panel-sticker-kantor`, masing-masing `terang-id`, `gelap-id`, `terang-en`, `gelap-en`, ditambah 18 bukti per langkah di `langkah/`.

## Format data dan sinkron

Dua jenis record baru di topik `chat` (`model::Body`):

| Record | Isi | Aturan |
|---|---|---|
| `reaction` | `conv`, `message`, `emoji`, `on` | Per (pesan, penulis, emoji) record dengan `(at, id)` terbesar menang. Penulis anggota percakapan (`judge::may_post`), juga di channel Umum yang dikunci. Reaksi yang dibuat setelah channel diarsipkan diterima semua laptop tetapi tidak ditampilkan. |
| `sticker_set` | `sticker` (32 hex), `pack`, `name`, `keywords`, `file`, `state` (active, hidden, deleted) | Hanya superadmin pada waktu record. Per sticker record dengan `(at, id)` terbesar menang. Dua sticker aktif bernama sama: yang dibuat lebih dulu memiliki `:nama:`. |

**Pesan sticker bukan record baru.** Pesan sticker adalah `message` biasa dengan teks `:nama:` dan tepat satu gambar `<nama>.sticker.<png|webp|gif>`. Laptop baru menampilkannya sebagai sticker setelah gambarnya lolos pemeriksaan; laptop lama menampilkan `:nama:` dan gambarnya sebagai lampiran biasa.

Migrasi: v10 `chat_reactions` (`chat/reaction_schema.rs`), v11 `chat_office_stickers`, `chat_my_stickers`, `chat_sticker_checks` (`chat/sticker_schema.rs`). Emoji "Baru dipakai" di tabel `settings` (`chat.emoji_recent`), per laptop.

Perintah Tauri baru (11): `chat_react`, `chat_emoji_used`, `chat_stickers`, `chat_sticker_image`, `chat_sticker_pick`, `chat_my_sticker_add`, `chat_my_sticker_save`, `chat_my_sticker_remove`, `chat_office_sticker_add`, `chat_office_sticker_update`, `chat_send_sticker`. Data layar baru: `MessageView.reactions`, `MessageView.sticker`, `ConversationView.canReact`.

## Kompatibilitas dengan 0.5.0

- `reaction` dan `sticker_set` hanya ditawarkan ke rekan yang melaporkan versi Mira paling rendah `CHAT_STICKER_SINCE` = 0.5.1 (`chat/compat.rs`, versi dari profil laptop di `members.app_version`, aturan `min` seperti `JOIN_AD_SINCE`). Laptop 0.5.0 tidak pernah menerima jenis record yang tidak dikenalnya, jadi tidak ada penolakan berulang di log. Ditinjau reviewer keamanan: `records_for`, titipan, dan relay lewat laptop ketiga semuanya lewat gerbang yang sama.
- Di laptop 0.5.0: reaksi tidak terlihat, katalog sticker kantor tidak ada, pesan sticker tampil sebagai `:nama:` plus gambar lampiran, emote `:nama:` di teks tampil sebagai teks.
- **Rilis yang membawa fitur ini harus bernomor 0.5.1 atau lebih.** Build rilis dengan versi di bawah 0.5.1 sengaja gagal dikompilasi (`const` assert di `compat.rs`), karena dengan aturan `min` gerbangnya akan terbuka untuk laptop 0.5.0 yang sudah terbit. Build debug dan tes tidak terpengaruh.

## Keamanan file sticker

- Jenis ditentukan dari byte file (`chat/sticker_file.rs`, parser header sendiri tanpa dependensi baru): PNG dan APNG, GIF87a/89a, WebP (VP8, VP8L, VP8X). SVG, JPEG, dan lainnya ditolak, jadi SVG dari pengguna tidak pernah dirender.
- Batas: 512 KB per file, sisi 1 sampai 1024 px, paling banyak 120 frame, dan lebar x tinggi x frame paling banyak 32 juta piksel. Setiap frame GIF, APNG (`fcTL`), dan WebP (`ANMF`) harus di dalam kanvas.
- Diperiksa saat unggah, saat simpan dari pesan, dan setiap kali gambar diberikan ke WebView (`chat_sticker_image`), yang mengirim URL `data:` dengan mime hasil pemeriksaan. CSP tetap `'self'`. Ukuran tampil dibatasi CSS.
- Path unggahan hanya dari dialog milik Mira, sama dengan lampiran. Jalan uji `MIRA_E2E_PICK` hanya ada di build debug.
- Blob sticker kantor dilayani ke anggota aktif mana pun hanya kalau blob itu tidak dipegang untuk percakapan lain; lampiran pesan pribadi atau grup yang hash-nya sama tidak pernah ikut terbuka. Blob yang sudah ada sebelumnya (dokumen, tanda tangan) tidak bisa dipakai sebagai sticker.
- Cache gambar di layar dibatasi (LRU, 24 juta karakter).

## Keputusan yang saya ambil sendiri

| Keputusan | Alasan |
|---|---|
| Pesan sticker tetap record `message` biasa, bukan jenis baru | Laptop 0.5.0 tetap menerima pesannya dan menampilkan pengganti yang wajar (`:nama:` dan gambar). Field baru di `message` akan ditolak laptop lama (`deny_unknown_fields`). |
| Satu sticker kantor = sticker dan emote | Satu tempat kelola. `:nama:` di teks memakai sticker kantor yang aktif. Sticker pribadi tidak jadi emote, karena orang lain tidak punya katalognya. |
| Data emoji ditulis sendiri, tanpa pustaka | Butuh kata kunci Indonesia dan ukuran kecil. Tidak ada pustaka emoji yang dipasang, jadi tidak ada lisensi atau ukuran bundel tambahan yang perlu dicek. Hanya emoji Unicode 13 atau lebih lama supaya tampil di Windows 10 dan 11. |
| Tanpa paket sticker bawaan | Menghindari karya berhak cipta dan menghindari sticker yang tidak dipilih kantor sendiri. |
| Reaksi boleh di channel Umum yang dikunci | Pengumuman wajar diberi 👍 walau hanya superadmin yang bisa menulis. |
| Reaksi setelah arsip diterima lalu disembunyikan, bukan ditolak | Saran review keamanan: putusan judge tidak boleh bergantung pada record arsip yang kebetulan sudah ada, supaya semua laptop sama dan log penolakan tidak terisi terus. |
| Emoji reaksi harus satu emoji (tata bahasa basis, pengubah warna kulit, ZWJ, bendera, keycap) | Mencegah teks bebas dan karakter tak terlihat sebagai reaksi. Semua 393 emoji di pemilih lolos (tes Rust membaca `emojiData.ts`). |
| Mantan superadmin yang memundurkan `at` pada `sticker_set` tetap diterima | Pola yang sama dengan `channel_lock`, supaya semua laptop memberi putusan yang sama. Risikonya ditulis di komentar `stickers::judge`. Gambar tetap harus lolos pemeriksaan, dan katalog tidak pernah melayani file percakapan. |
| "+N" label yang bisa difokus hanya di Chat | Di Organisasi dan Board "+N" tetap seperti dulu (statis dengan tooltip), supaya tidak menambah tab stop per baris di daftar dan kotak centang. |
| Balas dan Hapus di bilah aksi pesan jadi tombol ikon | Bilah aksi bertambah lima reaksi cepat. Supaya tidak menutupi label penulis, Balas dan Hapus jadi ikon dengan `aria-label` dan `title` yang sama. |
| Emoji "Baru dipakai", bukan "Sering dipakai" | Isinya 24 emoji terakhir, jadi namanya mengikuti isinya. |
| Panel sticker kantor di tab baru Organisasi | Brief meminta file baru karena sesi lain sedang mengubah Organisasi. `OrgScreen.tsx` hanya mendapat pendaftaran tab (import, satu nilai di tipe `Part`, satu baris tab, satu baris render). |
| Admin departemen boleh menyembunyikan pesan sticker di channel departemennya | Mengikuti aturan hapus pesan yang sudah ada (`judge::message_delete`, `ctx.is_admin`), tanpa perubahan. |

## Hasil uji (apa adanya)

| Pemeriksaan | Hasil |
|---|---|
| `cargo test` (seluruh crate, setelah semua perbaikan) | 1325 lulus, 1 gagal, 7 diabaikan. Yang gagal `documents::watch::tests::two_documents_stay_separate` (pengawas file Office, di luar chat, tidak diubah sesi ini): tes waktu yang dijalankan saat mesin sibuk. Dijalankan sendiri tiga kali, lulus tiga kali. Putaran penuh sebelum perbaikan review keamanan: 1310 lulus, 0 gagal. |
| Tes chat baru | `chat::sticker_file` 61, `chat::tests::reactions` 18, `chat::tests::stickers` 14, `chat::stickers` 5, `chat::compat` 3. Termasuk reaksi bersamaan dengan urutan datang berbeda (hasil sama di semua laptop), gerbang versi untuk rekan 0.5.0 dan tanpa versi, validasi file dengan 16.000 mutasi acak, frame raksasa di GIF kecil, dan lampiran DM yang tidak ikut terbuka lewat katalog. |
| `cargo clippy --all-targets -- -D warnings` | bersih |
| `npx tsc --noEmit -p .` | bersih |
| `npx vitest run` | 1875 dari 1875 tes lulus di 123 file. Tiga file (`App.test.tsx`, `components.en.test.tsx`, `UpdateContext.test.tsx`) tidak bisa dimuat di worktree ("Denied ID ... pdfjs-dist ... pdf.worker.min.mjs?url", `node_modules` ada di repo utama, sama seperti laporan sebelumnya). Dengan konfigurasi sementara yang mengizinkan folder repo utama, ketiganya lulus 28 dari 28. |
| `scripts/sticker-e2e.mjs` (baru, tiga instance, build debug) | 45 dari 45 pada percobaan pertama, semua lewat UI: reaksi tampil di laptop lain dan dihapus lagi, semua label di baris penulis dan kepala pesan pribadi, reaksi ke pesan orang lain lewat menu, sticker kantor dibuat superadmin lalu dikirim anggota lain, saran `:kop` dan emote sebaris, simpan sticker ke koleksi lalu kirim sticker pribadi lewat pesan pribadi, laptop C dimatikan lalu menyusul reaksi, sticker kantor baru, dan pesan sticker, superadmin menyembunyikan pesan sticker, pemilih emoji dengan keyboard, screenshot. |
| `scripts/chat-e2e.mjs` | 39 dari 39 (percobaan ketiga). Percobaan pertama 17 dari 18: menu klik kanan pesan sudah tertutup sebelum "Balas" diklik; tidak terulang. Dugaan: `MenuPopup` menutup menu saat daftar pesan masih bergulir sendiri (sudah dicatat sebagai batasan di laporan v04-ctx-chat). Percobaan kedua terganggu e2e sesi lain yang berjalan bersamaan. |
| `scripts/e2e-fitur-multi.mjs` | 53 dari 53 |
| `scripts/english-e2e.mjs` | 39 dari 39 |
| `scripts/contextmenu-e2e.mjs` | 27 dari 27 |

Keempat skrip lama tidak diubah. Screenshot skrip lama diarahkan ke folder sementara, jadi screenshot lama di repo tidak tertimpa.

Kontras: semua pasangan warna baru dicek dengan `check_contrast` oleh subagent tampilan, terang dan gelap, dan lolos (teks paling rendah 5,0 terang; cincin fokus di atas sorotan 4,47 terang dan 5,88 gelap; garis non-teks paling rendah 3,05). Tidak ada warna mentah baru; semua dari token tema.

## Review terpisah

**Tampilan dan aksesibilitas** (subagent, hanya membaca): 1 temuan tinggi, 7 sedang, 9 rendah atau info. Semua yang tinggi dan sedang diperbaiki:
- nama kelas CSS pemilih sticker dan panel Organisasi bentrok di satu bundel (dipisah `cmp-stk-*` dan `org-stk-*`);
- fokus hilang saat chip reaksi terakhir dilepas;
- emoji "Baru dipakai" berubah urutan selagi pemilih terbuka sehingga fokus hilang (dibekukan dan key stabil);
- klik ganda cepat pada reaksi (status menyimpan per emoji, `aria-busy`);
- Esc pada "+N" di dalam dialog ikut menutup dialog;
- wilayah live yang disembunyikan saat kosong sehingga error tidak dibacakan.

Yang rendah juga diperbaiki: katalog basi setelah berpindah layar, klik di luar pemilih reaksi menarik fokus, pemilih sticker tetap terbuka setelah Tab keluar, bilah aksi terlalu lebar, kotak "+N" terpotong area gulir, sticker gagal tampil sebagai kotak kosong, istilah reaksi tidak seragam, "Anda" dibacakan dua kali, petunjuk kata kunci tidak cocok.

**Keamanan file dan sinkron** (subagent, hanya membaca): 2 temuan tinggi, 3 sedang, 4 rendah. Ditindaklanjuti:

| # | Temuan | Tindak lanjut |
|---|---|---|
| 1 (tinggi) | GIF kanvas 1x1 dengan frame 65535x65535 di bawah 512 KB bisa membuat WebView mengalokasikan gigabyte | Frame GIF, APNG, dan WebP harus di dalam kanvas; batas total 32 juta piksel. Tes ditambah. |
| 5 (tinggi, rilis) | Dengan aturan `min`, build rilis 0.5.0 membuka gerbang ke laptop 0.5.0 | Build rilis di bawah 0.5.1 ditolak saat kompilasi. |
| 2 (sedang) | Penanda katalog sticker kantor bisa menempel ke lampiran DM yang hash-nya sama, lalu dilayani ke semua anggota | Diperbaiki di tiga lapis (antre, mendarat, layani). Dua tes untuk kedua urutan datang. |
| 4 (sedang) | Judge reaksi bergantung pada arsip yang kebetulan ada | Diterima lalu disembunyikan saat tampil. |
| 3 (sedang) | Mantan superadmin memundurkan `at` | Dipertahankan demi putusan yang sama di semua laptop; dicatat (lihat keputusan). |
| 6 (rendah) | Emoji reaksi menerima teks bebas dan karakter tak terlihat | Tata bahasa emoji yang ketat. |
| 7 (rendah) | Blob tanda tangan atau dokumen dengan hash sama bisa dikirim sebagai sticker | Blob yang sudah ada sebelumnya tidak bisa dipakai sebagai sticker. |
| 8 (rendah) | Cache gambar di layar tanpa batas | LRU 24 juta karakter. |
| 10 (info) | Gambar yang tidak pernah ada diantre ulang setiap katalog dibuka | Paling sering sekali per jam per hash. |
| 9 (rendah) | `size` palsu bisa membuat unduhan hash yang sama gagal | Tidak diubah: kelas masalah yang sama sudah ada lewat pesan biasa. |

## Titik sambung dan catatan merge

- Migrasi v10 dan v11 di akhir `db/migrations.rs`. Kalau sesi lain sudah menambah migrasi di `main`, urutannya diatur saat merge (belum ada yang dirilis).
- `chat/audience.rs`: `MemberInfo.app_version`. `chat/judge.rs`, `store/mod.rs`: beberapa fungsi jadi `pub(crate)` dan dua cabang dispatch baru. `chat/read.rs`, `service.rs`: field baru di view.
- `lib.rs`: 11 perintah baru setelah `chat_set_folded`.
- `src/screens/org/OrgScreen.tsx`: hanya pendaftaran tab Sticker. `src/components/NameWithLabels.tsx`: prop baru `all`, `wrap`, `moreFocusable`, ekspor `LabelChips`; bawaan tidak berubah.
- `src-tauri/src/permissions/` tidak diubah.
- Akhir baris: file yang sudah ada di `main` memakai akhir baris yang sama seperti di `main`; `git diff main` sama dengan `git diff main --ignore-cr-at-eol`. File baru LF.
- **Versi rilis berikutnya harus 0.5.1 atau lebih** (lihat Kompatibilitas).

## Belum dicek atau masih terbatas

- **Laptop 0.5.0 sungguhan** belum diuji bersama laptop baru. Perilakunya dicek lewat tes (rekan dengan versi lama atau tanpa versi tidak ditawari record baru; pesan sticker adalah `message` biasa tanpa field baru).
- **Reaksi di pesan pribadi** tersinkron saat kedua orang online (record percakapan pribadi hanya untuk kedua orang itu); tidak lewat titipan seperti pesan.
- **Render GIF dan WebP animasi di WebView2** dengan file yang sengaja dibuat aneh hanya dicek lewat parser dan tes, tidak dengan fuzzing di WebView.
- **Screenshot `05-panel-sticker-kantor`** menampilkan pemberitahuan "Ada 4 laptop di jaringan ini yang tergabung di kantor Mira lain": itu laptop uji dari sesi lain yang sedang menjalankan e2e di PC yang sama, bukan bagian fitur ini.
- **Mac** belum diuji.
- **`contextmenu-e2e.mjs`** (skrip lama) menghapus semua kunci `device-key-*` yang muncul selama ia berjalan, termasuk milik e2e sesi lain yang berjalan bersamaan. Session utama sudah diberi tahu; usul perbaikan terpisah: pola `ownKeys` seperti `e2e-fitur-multi.mjs`.

## Commit

Lihat `git log main..HEAD` di branch `claude/chat-sticker-eac793`. Tidak ada push dan tidak ada merge ke `main`.
