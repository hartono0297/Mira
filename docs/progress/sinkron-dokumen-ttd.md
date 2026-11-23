# Laporan: sinkron dokumen dan tanda tangan antar laptop

Tanggal: 23 November 2026. Branch: `claude/sinkron-dokumen-ttd-8e6530`, dibuat dari `main` 63eb72b. Rencana: `docs/plans/sinkron-dokumen-ttd.md`.

## Ringkasan

Dokumen dan tanda tangan sekarang sampai ke laptop rekan yang berhak, lewat kontrak `network/feature.rs`.
- **Dokumen:** dokumen baru, versi baru, dan tanda "Sedang diedit" ikut tersinkron.
  - File sampai 20 MB disalin otomatis. File lebih besar diunduh lewat tombol "Unduh dari rekan".
  - Kalau dua laptop menyimpan versi saat offline, kedua versi disimpan dan ditandai bentrok.
- **Tanda tangan:** permintaan, versi bertanda tangan, dan pembatalan ikut tersinkron.
  - Urutan berurutan ditegakkan di semua laptop.
  - Versi baru harus terbukti hanya menambah stempel. Mesin mengeceknya dari byte file.

Transport sungguhan belum digabung, jadi uji antar laptop memakai dua jalur:
- tes Rust tiga laptop di memori (`network::feature::testing`);
- uji ujung ke ujung dengan dua instance aplikasi, lewat jembatan uji berbasis folder.

Hasil uji: `cargo test` 604 lulus, 0 gagal. Clippy bersih. Vitest 436 lulus. Ketiga uji ujung ke ujung lulus:
- dokumen: 15/15;
- tanda tangan: 15/15;
- dua instance: 26/26.

Semua di-commit di branch ini. Tidak ada push dan tidak ada merge ke `main`.

## Yang dibuat

**Fondasi bersama**
- `documents/envelope.rs`: amplop bertanda tangan untuk setiap record. Isinya penulis, isi JSON apa adanya, dan tanda tangan Ed25519 atas `domain\npenulis\nisi`. Domain dokumen dan tanda tangan dibedakan, jadi record satu fitur tidak bisa dipakai di fitur lain.
- `documents/scope.rs`: siapa boleh melihat dan menulis di Pustaka Umum, tim, atau proyek, untuk kunci mana pun (laptop sendiri maupun rekan).
- `documents/sync_schema.rs`: satu entri migrasi (v8).
- `documents/test_lab.rs`: tes beberapa laptop dalam satu organisasi.

**Dokumen** (`documents/peer_sync.rs`, `access.rs`, `runtime.rs`, `commands.rs`, `view.rs`)
- Record `doc`, `ver`, dan `edit`, masing-masing ditandatangani penulisnya. Penerima memeriksa tanda tangan, keanggotaan aktif, dan hak menulis di cakupan dokumen. Cakupan selalu diambil dari dokumen yang tersimpan, bukan dari pengirim.
- Versi yang datang sebelum dokumennya disimpan menunggu, lalu diterapkan begitu dokumennya datang.
- Tanda "Sedang diedit" diulang setiap 4 menit selama mengedit. Tanda yang lebih tua dari 10 menit tidak dikirim lagi.
- Pengirim hanya menawarkan record yang boleh dilihat penerima, dan menyaring ulang saat mengirim.
- File hanya disajikan ke rekan yang boleh melihat dokumennya. Hasil unduhan dicek hash-nya sebelum masuk blob store.
- Perintah baru `download_version` untuk file besar.
- Kait `scope_allows` sekarang tersambung ke `permissions::OrgState`.

**Tanda tangan** (`signing/peer_sync.rs`, `service.rs`, `store.rs`, `outbox.rs`, `commands.rs`)
- `DocumentStore` sekarang memakai blob store Tahap 4. File lama di `ttd-berkas/` dipindah saat pertama dibaca.
- Record `request`, `signed`, dan `cancelled` ditulis dalam transaksi yang sama dengan perubahan lokal. Penerima memeriksa:
  - setiap catatan audit dengan `seal::verify_event`, dengan pelaku sama dengan penulis record;
  - pengirim, penanda tangan, dan aturan Tamu.
- Keadaan permintaan dihitung ulang dari semua record sah ("fold"). Hasilnya sama di semua laptop yang memegang record dan file yang sama. Rantai jejak audit tetap sah di setiap laptop.
- Permintaan bisa punya proyek (`team_id`, `project_id`). Tamu hanya bisa jadi penanda tangan di proyek yang diizinkan untuknya, dan tidak bisa meminta tanda tangan.
- File sampai 20 MB diunduh otomatis. File lebih besar lewat perintah `sign_download_file`.
- Notifikasi Windows "Giliran Anda menandatangani" muncul sekali per permintaan dan versi.

**Bukti stempel** (`signing/increment.rs`, `src/screens/sign/stamp.ts`): dijelaskan di bagian keputusan.

**Tampilan**
- **Dokumen:** status "sedang disalin", tombol "Unduh dari rekan" untuk file besar, dan kotak bentrok yang menyebut nama pembuat tiap versi ("Versi 3 dari Budi Uji").
- **Tanda tangan:**
  - bagian "Menunggu tanda tangan Anda" dengan "Diminta oleh ...";
  - tombol unduh file;
  - daftar versi yang ditolak, dengan alasan dalam kalimat biasa;
  - pilihan proyek di permintaan baru.
- Kedua layar memuat ulang saat event `mira://feature` datang.

**Alat uji**
- `src-tauri/src/feature_bridge.rs`: jembatan uji antar instance. Hanya aktif dengan `MIRA_TEST_BRIDGE_DIR`; tanpa itu semua perintahnya ditolak.
- `scripts/sync-e2e.mjs` (`npm run test:e2e-sync`).
- `scripts/make-sign-fixtures.mjs` dan 17 file PDF uji di `src-tauri/tests/fixtures/sign/`.

## Keputusan

| Keputusan | Alasan |
|---|---|
| **Bukti stempel = incremental update PDF.** Frontend tidak lagi menyimpan ulang seluruh file. Byte versi lama dibiarkan persis, lalu objek baru dan objek yang berubah ditambahkan di belakang dengan xref `/Prev`. Inti Rust menolak versi baru kecuali versi lama adalah awalan byte yang persis, dan isi tambahannya lolos aturan di bawah. | Awalan byte saja tidak cukup, karena incremental update bisa mendefinisikan ulang objek apa pun. Jadi kedua versi diurai dengan lopdf dan setiap objek yang berubah harus masuk daftar yang diizinkan. Versi lama tetap utuh di dalam file baru, jadi selalu bisa dibandingkan. |
| **Yang boleh berubah:** kamus halaman (hanya `/Contents` dengan isi lama utuh, dan `/Resources` yang hanya bertambah), simpul `/Pages` (hanya menambah halaman di akhir), dan kamus Info. Katalog tidak boleh berubah. Aksi aktif (`/JS`, `/AA`, `/OpenAction`, `/Launch`, dan sejenisnya) ditolak di mana pun. | Diukur dari apa yang benar-benar disentuh pdf-lib saat menstempel. |
| **Aturan isi stempel di halaman lama:** hanya operator gambar dan teks. Gambar harus PNG dengan transparansi, rata-rata keburaman paling banyak 50%, dan tanpa piksel putih yang buram. Semua tanda (gambar dan keterangan) harus masuk satu kotak, paling luas 15% halaman. Keterangan paling banyak 120 huruf dan 12 pt, hanya Helvetica atau Courier. | Ditemukan review keamanan: aturan awal masih membiarkan gambar putih kecil menutupi "Rp 10.000.000" lalu menimpanya dengan angka lain. Tanda tangan asli adalah goresan gelap di atas latar transparan, jadi aturan ini tidak menolaknya. |
| **Halaman tambahan hanya dari penanda tangan terakhir** (halaman catatan), dan isinya hanya teks dan garis tipis. | Mencegah penanda tangan di tengah menyisipkan "adendum" palsu. |
| **Kotak tanda tangan yang terlalu besar dikecilkan di sekitar titik tengahnya** sebelum distempel (lebih dari 12% halaman). | Supaya stempel yang sah selalu lolos aturan 15%. Akibatnya stempel bisa lebih kecil dari kotak yang digeser di layar. |
| **Id dokumen, versi, dan permintaan diturunkan dari kunci penulis:** BLAKE3(awalan, kunci penulis, salt acak), dan salt ikut dalam record. | Ditemukan review keamanan: tanpa ini, rekan bisa lebih dulu memakai id milik orang lain, sehingga isi di tiap laptop berbeda selamanya. |
| **Larangan memakai ulang file.** Versi atau permintaan yang menunjuk file yang sudah dipakai di cakupan lain, yang tidak bisa dilihat penulisnya, ditolak. | Mencegah file tim bocor ke Pustaka Umum hanya dengan menyebut sidik filenya. |
| **Batas antrean:** dokumen paling banyak 1000 record tertunda per penulis; tanda tangan 200 per penulis dan 5 record ditolak per penanda tangan per permintaan. Record tertunda yang lebih tua dari 7 hari dibuang. Record tertunda dari Tamu tidak disimpan. | Mencegah disk dan CPU dipenuhi record sampah. |
| **Mode bebas, dua tanda tangan bersamaan saat offline:** pemenangnya yang waktunya paling awal, lalu kunci terkecil. Yang kalah ditandai ditolak ("ditandatangani bersamaan") dan penanda tangannya tetap menunggu giliran. | Hasilnya sama di semua laptop tanpa koordinasi. |
| **Batal vs selesai:** pembatalan berlaku hanya kalau permintaan belum punya catatan selesai yang sah. | Keputusan yang sama di semua laptop. |
| **Anggota yang dikeluarkan:** record-nya ditolak, termasuk yang dibuat sebelum dikeluarkan. | Waktu di record bisa dipalsukan. Ini mengorbankan sedikit konvergensi demi keamanan. |
| **Pemeriksaan PDF berjalan di luar kunci inti** saat menerima record dan setelah unduhan. Hasilnya disimpan di `sign_proof_checks`. Ada batas total dekompresi dan jumlah objek. | PDF besar tidak membekukan aplikasi. PDF yang sengaja dirusak tidak bisa menghabiskan memori. |
| **Tamu di Pustaka Umum tidak melihat apa pun.** | Sesuai aturan cakupan di rencana. Tes lama yang menganggap sebaliknya sudah diperbaiki. |
| **PIN tetap 6 sampai 12 angka.** | Belum diputuskan user. |

## Hasil uji (apa adanya)

| Pemeriksaan | Hasil |
|---|---|
| `cargo test` | 604 lulus, 0 gagal, 7 diabaikan (tes lama yang butuh firewall, keyring, jaringan sungguhan) |
| `cargo clippy --all-targets -- -D warnings` | bersih |
| `npx vitest run --maxWorkers=2` | 31 file, 436 tes lulus |
| `npx tsc --noEmit` | tanpa error |
| `npm run test:e2e:docs` (satu laptop) | 15/15 |
| `npm run test:e2e-ttd` (satu laptop) | 15/15 |
| `npm run test:e2e-sync` (dua instance, baru) | 26/26 |

Tes Rust tiga laptop mencakup:
- **Konvergensi:** versi dari rekan, bentrok offline, dan versi yang datang sebelum dokumennya.
- **File:** blob besar tidak disalin otomatis tetapi bisa diunduh; file tidak disajikan ke yang tidak berhak.
- **Batas akses:** Tamu, anggota tim lain, anggota yang dikeluarkan, dan penerusan lewat laptop ketiga.
- **Record palsu:** record palsu, penulis palsu, dan id yang diserobot.
- **Tanda tangan:**
  - permintaan berurutan A lalu B lalu C, dengan C yang mencoba lebih dulu ditolak;
  - tanda tangan bersamaan di mode bebas;
  - versi yang mengubah isi selain stempel ditolak di semua laptop;
  - catatan audit palsu ditolak;
  - pembatalan, dan pembatalan setelah selesai yang diabaikan;
  - notifikasi giliran.
- **Pemeriksa stempel:** 32 tes. Di antaranya rantai stempel dari pdf-lib asli (file klasik, object stream, resource warisan), lalu penolakan:
  - gambar putih yang menutup total;
  - teks yang diubah dan MediaBox yang diubah;
  - stempel yang menyebar ke dua sudut;
  - halaman tambahan bergambar;
  - xref raksasa.

Uji dua instance (`scripts/sync-e2e.mjs`, Ayu dan Budi di satu PC):
- **Keanggotaan:** lewat jaringan Tahap 1 yang asli.
- **Record dan file fitur:** lewat jembatan uji.
- **Yang dicek:**
  - dokumen dan isinya sampai ke B;
  - bentrok offline tampil di kedua layar dengan nama rekan;
  - file 21 MB tidak disalin otomatis dan bisa diunduh lewat tombol;
  - permintaan berurutan B lalu A, ditandatangani lewat layar asli dengan PIN;
  - kedua laptop selesai dengan kunci sah dan sidik file akhir yang sama;
  - tidak ada record yang ditolak.

Screenshot ada di `docs/progress/screenshots/sinkron/`:

| File | Isi |
|---|---|
| `sinkron-02-bentrok-dari-rekan-a.png` | Bentrok sungguhan dari rekan |
| `sinkron-03` | Bentrok yang sama, di laptop B |
| `sinkron-10` | Bentrok, mode gelap |
| `sinkron-04` dan `05` | File besar, sebelum dan sesudah diunduh |
| `sinkron-06` | Menunggu tanda tangan |
| `sinkron-08` dan `09` | Selesai di kedua laptop |

Screenshot Tahap 4 dan 5 (`12-*` sampai `18-*` dan `t5-*`) dibuat ulang dari build ini. Nama dan isi di gambar adalah data uji.

Masalah yang ditemukan dan diperbaiki selama kerja:
- **Deadlock di `InFlight::begin`.** `then_some` membuat lalu membuang penanda unduhan sambil memegang mutex yang dikunci lagi oleh `Drop`-nya. Satu tes macet berjam-jam sebelum ketahuan. Sekarang semua tes dijalankan dengan batas waktu.
- **Review keamanan:** 6 temuan, semuanya diperbaiki atau dibatasi (lihat Keputusan).
- **Review tampilan:**
  - alasan penolakan sekarang memakai kode, sehingga orang dan kalimatnya benar;
  - tombol tanda tangan ditahan saat versi rekan belum sampai;
  - status "sedang disalin" sekarang jujur;
  - ukuran unduhan sesuai dengan yang benar-benar diambil;
  - unduhan tidak lagi mengunci tombol lain.

## Belum dicek atau masih terbatas

- **Belum diuji lewat transport sungguhan dan di beberapa laptop fisik.** Uji dua instance memakai jembatan folder.
- **Sisa risiko bukti stempel:**
  - di dalam kotak stempelnya sendiri, penanda tangan masih bisa menulis teks sampai 12 pt (juga putih) atau menaruh bidang abu-abu yang terlihat;
  - penanda tangan terakhir bisa menambah halaman teks yang meniru halaman kontrak;
  - PDF yang harus "diperbaiki" lopdf tidak bisa ditandatangani (ditolak sebelum PIN);
  - belum dicoba dengan PDF dari Word, Acrobat, atau pemindai.
- **Stempel yang bertumpuk.** Screenshot `sinkron-08` menunjukkan dua stempel di posisi yang sama (skrip uji memilih posisi yang sama), sehingga keterangan nama bertumpuk. Saran: layar memperingatkan kalau kotak baru menimpa stempel lama.
- **Record format lama (dokumen dari sebelum sinkron, tanpa salt)** masih bisa "diserobot" kalau sampai lebih dulu di laptop yang belum mengenal id-nya. Data seperti itu hanya ada di folder uji.
- **Batas 5 record ditolak per penanda tangan** bisa membuat laptop berbeda pendapat, tetapi hanya untuk penanda tangan yang sengaja atau buggy mengirim banyak versi salah.
- **File versi yang ditolak tidak dibagikan,** jadi di laptop lain langkah itu tetap "menunggu file". Klien jujur tidak menghasilkan versi seperti ini.
- **PIN 6 angka** tetap bisa ditebak kalau kunci laptop dan `mira.db` sama-sama dicuri (catatan Tahap 5).
- **Office** belum berlisensi di laptop ini, jadi simpan Excel dan Word memakai pola file seperti Tahap 4. HiDPI 150% belum dicoba.

## Titik sambung

| Titik | Di mana | Saat merge |
|---|---|---|
| Proyek yang boleh dibuka Tamu | trait `GuestProjects` di `documents/scope.rs`, implementasi `BoardGuestProjects` lewat `board::access::may_access_project` | sudah digabung: `InviteGuestProjects` dihapus, cakupan proyek dicek dengan tim proyek di board |
| Transport fitur | `FeatureHub::set_link`; dokumen dan tanda tangan mendaftar `FeatureSync` dan `BlobSource` saat start | transport cukup memanggil `set_link`; event `mira://feature` `{topic}` sudah didengar tampilan |
| Jembatan uji | `feature_bridge.rs`, dipasang di `lib.rs` hanya kalau `MIRA_TEST_BRIDGE_DIR` diisi | sudah: jembatan dihapus saat merge, `sync-e2e.mjs` memakai transport asli |
| F-SIGN-06 (kartu task pindah ke Selesai) | catatan `completed` di `service::complete` dan di fold | butuh board |

Kekurangan kontrak `feature.rs` (tidak diubah, hanya dicatat):
- Tidak ada kait "rekan terputus" dan tidak ada cara membatalkan `fetch_blob`. Unduhan otomatis dicoba lagi saat `peer_connected` atau saat record baru datang.
- Transport hanya memancarkan `mira://feature` setelah `ingest`. Selesainya unduhan dipancarkan sendiri oleh fitur (`mira://documents` dan `mira://feature` `{topic:"sign"}`).

## Catatan merge

- **Basis.** Branch ini dibuat dari 63eb72b. Selama kerja, `main` sudah maju (sekitar 60 commit dari sesi lain), jadi merge perlu menyelesaikan konflik di bawah.
- **Migrasi.** Satu entri `crate::documents::sync_schema::SYNC_SCHEMA` di akhir `MIGRATIONS` (v8 setelah merge). Isinya:
  - tabel `docs_sync_records`, `sign_sync_records`, `sign_proof_checks`, `sign_notified`;
  - kolom `team_id` dan `project_id` di `sign_requests`.
  - Tes `documents::schema` mengecek `latest_version() == 6` dan membuang tabel sinkron; sesuaikan nomornya. Hapus folder data uji lama sebelum mencoba.
- **`lib.rs`:**
  - `pub mod feature_bridge;` (dihapus saat merge);
  - hub dibuat lalu, kalau ada variabel jembatan, `set_link` jembatan, baru `app.manage(hub)`;
  - `signing::peer_sync::register(app.handle());` setelah `SignSessions`;
  - perintah `documents::commands::download_version` dan `signing::commands::sign_download_file`. Jembatan uji `feature_bridge` (dengan empat perintah `debug_*`) dihapus saat merge; sinkron memakai transport asli.
  - `DocumentsRuntime::new` mendaftar ke hub sendiri, jadi hub harus di-`manage` sebelum runtime dokumen (sudah begitu).
- **`Cargo.toml`:** `lopdf = "=0.47.0"` tanpa fitur bawaan.
- **`package.json`:** skrip `test:e2e-sync` dan `fixtures:sign`.
- **Tidak disentuh:** `network/feature.rs`, `network/node.rs`, `network/wire.rs`, `permissions/`, `design/`, `error.rs`. Kode error baru lewat `AppError::Signing { code }`: `version_not_prefix`, `version_changes_content`, `not_available`.
- **Perubahan perilaku:** `list_candidates()` tanpa proyek tidak lagi menampilkan Tamu. `sign-e2e.mjs` sekarang mencari file final di `blobs/`, bukan `ttd-berkas/`.

## Cara menjalankan

```
npm install
npm test                                  # Vitest
cd src-tauri; cargo test                  # inti Rust
npx tauri build --debug --no-bundle       # build untuk uji ujung ke ujung
npm run test:e2e:docs                     # dokumen, satu laptop
npm run test:e2e-ttd                      # tanda tangan, satu laptop
npm run test:e2e-sync                     # dua instance: bentrok, file besar, tanda tangan berurutan
```
