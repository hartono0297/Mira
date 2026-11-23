# Rencana: sinkron dokumen dan tanda tangan antar laptop

Tanggal: 22 November 2026. Branch: `claude/sinkron-dokumen-ttd-8e6530`, dari `main` 63eb72b.
Melanjutkan Tahap 4 (`docs/progress/tahap-4-lokal.md`) dan Tahap 5 (`docs/progress/tahap-5-lokal.md`) di atas kontrak `src-tauri/src/network/feature.rs`.

## 1. Tujuan

- Dokumen (`TOPIC_DOCS`): dokumen baru, versi baru, dan tanda "Sedang diedit" sampai ke rekan yang berhak. File sampai 20 MB disalin otomatis, file lebih besar diunduh saat diklik. Bentrok offline: kedua versi disimpan dan ditandai bentrok (model Tahap 4).
- Tanda tangan (`TOPIC_SIGN`): permintaan, versi bertanda tangan, dan pembatalan sampai ke penanda tangan dan pengirim. Urutan berurutan ditegakkan di semua laptop. Versi baru harus terbukti hanya menambah stempel.
- Batas tim dan proyek berlaku di laptop pengirim (yang ditawarkan) dan penerima (yang diterima).

## 2. Batasan

- Tidak mengubah `network/feature.rs`, `network/node.rs`, `network/wire.rs`, `permissions/` (hanya membaca), `design/`.
- Satu entri migrasi di akhir `MIGRATIONS`: `documents::sync_schema::SYNC_SCHEMA` (v8).
- `lib.rs`: hanya baris registrasi.
- Sampai transport digabung, `FeatureHub` memakai `OfflineLink`. Uji antar laptop memakai `network::feature::testing` dan `documents::test_lab::Lab`.

## 3. Fondasi bersama (sudah dibuat sebelum kerja paralel)

| File | Isi |
|---|---|
| `documents/envelope.rs` | Amplop bertanda tangan `{"a","p","s"}`. Pesan yang ditandatangani: `<domain>\n<author>\n<payload>`. Domain `mira-docs-v1` dan `mira-sign-sync-v1`. `seal`, `open` (cek id, bentuk, kunci, tanda tangan). |
| `documents/scope.rs` | Aturan lihat dan tulis per kunci (`may_view`, `may_write`) memakai aturan board: `board_team` (tim proyek di `board_projects`, hanya proyek yang `board::store::is_syncable`) dan `BoardGuestProjects` (trait `GuestProjects`, lewat `board::access::may_access_project`). `chat_allows`: file yang dimasukkan chat hanya untuk anggota percakapannya. |
| `documents/sync_schema.rs` | Migrasi: `docs_sync_records`, `sign_sync_records`, `sign_proof_checks`, `sign_notified`, kolom `team_id` dan `project_id` di `sign_requests`. |
| `documents/test_lab.rs` | Hanya tes: beberapa laptop (folder data, kunci, `MiraState`) dalam satu organisasi, tambah Tamu, anggota tim lain, keluarkan anggota, sinkron log keanggotaan. |

### Batas tim dan proyek (`scope.rs`)

- Hanya anggota aktif. Anggota yang dikeluarkan tidak menerima dan tidak diterima apa pun.
- Pustaka Umum (tanpa tim dan proyek): semua anggota aktif bukan Tamu.
- Cakupan tim: anggota tim itu (peran apa pun). Superadmin hanya kalau ikut tim itu (F-ROLE-11), sama dengan `board::access`.
- Cakupan proyek: proyeknya harus ada di board laptop ini, bisa disinkron (`is_syncable`), dan timnya sama persis dengan tim cakupan. Proyek tim yang disebut tanpa timnya ditolak. Dokumen proyek yang ditambah di laptop ini mengambil tim dari board; proyek yang tidak dikenal ditolak (`not_found`).
- Proyek tanpa tim: semua anggota aktif bukan Tamu.
- Tamu: hanya proyek yang boleh dibacanya di board (`BoardGuestProjects`): tim undangan harus tim proyek, dan proyek tanpa tim tidak punya Tamu. Tamu tidak pernah menulis dokumen.

## 4. Dokumen (`documents/peer_sync.rs`)

Record (amplop domain `mira-docs-v1`, payload JSON dengan field `t`):
- `doc`: `RemoteDocument`, ditandatangani pembuat (`created_by` = penulis amplop).
- `ver`: `RemoteVersion`, ditandatangani penulis versi (`author` = penulis amplop).
- `edit`: `{documentId, editor, editing, since, at}`, ditandatangani editor. Disimpan hanya yang terbaru per (dokumen, editor). Ditawarkan hanya selama segar (10 menit, `REMOTE_EDITING_STALE_SECS`). Saat mengedit, tanda diulang setiap 4 menit.

Penerima (`ingest`):
1. `envelope::open`; penulis harus anggota aktif dan berhak menulis di cakupan dokumen (`may_write`). Untuk `ver` dan `edit`, cakupan diambil dari dokumen yang sudah tersimpan (bukan dari pengirim).
2. `doc` diterapkan lewat `apply_remote_document`; `ver` lewat `apply_remote_version`. Versi yang dokumennya belum ada disimpan `pending` lalu diterapkan saat dokumennya datang.
3. Ditolak: dicatat lewat `permissions::log_rejection` (kode `docs_*`), tidak disimpan, tidak diteruskan.

Pengirim (`record_ids_for`, `records_for`): hanya record dokumen yang boleh dilihat peer (`may_view`), disaring ulang di `records_for`.

Keluar (`DocumentSync`): setiap perubahan lokal membuat record bertanda tangan di `docs_sync_records` lalu `FeatureHub::notify_changed("docs")`. Dokumen dan versi lokal dari sebelum sinkron dibuatkan record saat pertama dibutuhkan (hanya yang ditulis laptop ini).

File (`BlobSource`): `blob_path_for(peer, hash)` hanya kalau ada versi dengan hash itu di dokumen yang boleh dilihat peer dan file-nya ada. File yang dimasukkan chat (`chat_blobs.preexisting = 0`) tidak pernah dikirim atau diterima lewat versi dari penulis yang tidak ikut percakapannya.

Unduhan: setelah `ingest`, versi dari rekan berukuran sampai 20 MB yang file-nya belum ada langsung diunduh (`FeatureHub::fetch_blob` ke file sementara, lalu `BlobStore::put_file`, lalu hash dicek sama dengan `blob_hash`). Diulang saat rekan tersambung (`peer_connected`). File lebih besar: perintah `download_version`.

Izin lokal: `access::scope_allows` disambung ke `scope::may_view` / `may_write` dengan `OrgState` dari `permissions::load_state`.

## 5. Tanda tangan (`signing/peer_sync.rs`, `signing/increment.rs`)

### Penyimpanan

`DocumentStore` diimplementasikan di atas `BlobStore` Tahap 4 (`signing/store.rs`, `BlobDocumentStore`). File lama di `ttd-berkas/` dibaca sebagai cadangan lalu dipindah ke blob store saat pertama dibaca.

### Record (domain `mira-sign-sync-v1`)

- `request`: definisi permintaan (id, judul, mode, pengirim, cakupan tim/proyek, hash dan ukuran versi asli, waktu, daftar penanda tangan berurutan) + catatan audit `created` beserta tanda tangannya. Penulis amplop = pengirim.
- `signed`: id permintaan, catatan audit `signed` (+ `completed` kalau terakhir) beserta tanda tangannya, hash dan ukuran versi baru. Penulis amplop = penanda tangan.
- `cancelled`: catatan audit `cancelled`. Penulis amplop = pengirim.

### Penerima

- Setiap catatan audit diperiksa dengan `seal::verify_event`, dan pelakunya harus sama dengan penulis amplop dan id permintaannya cocok.
- `request`: pengirim anggota aktif bukan Tamu (`validate_new`), setiap penanda tangan anggota aktif, jenis (Anggota/Tamu) diambil dari log keanggotaan, Tamu hanya kalau permintaan punya proyek yang diizinkan untuknya.
- Keadaan permintaan dihitung ulang (fold) dari semua record sah: mulai dari versi asli, setiap langkah memilih record `signed` yang `hash_before` = versi sekarang, penanda tangannya boleh menandatangani (`can_sign`, jadi urutan berurutan ditegakkan), file baru lolos bukti stempel. Kalau ada dua kandidat (mode bebas, ditandatangani bersamaan saat offline), pemenangnya yang waktunya paling awal lalu kunci terkecil; yang kalah ditandai `rejected` dengan alasan "ditandatangani bersamaan" dan penanda tangannya tetap menunggu giliran. Hasil fold sama di semua laptop yang memegang record dan file yang sama.
- Langkah yang file-nya belum ada berhenti di `pending` sampai file diunduh.
- File yang sudah dipakai di laptop ini (`check_reuse`): versi asli permintaan baru hanya diterima kalau pengirimnya sudah boleh memegang file itu (versi dokumen yang boleh dilihatnya, permintaan lain yang melibatkannya, atau percakapan chat yang diikutinya). Jadi dua pengirim yang tidak saling terkait tidak bisa memakai PDF yang sama persis di laptop yang memegang keduanya. File chat hanya untuk anggota percakapannya.
- `cancelled` berlaku kalau permintaan belum punya catatan `completed` yang sah.
- Notifikasi Windows "Giliran Anda menandatangani" sekali per (permintaan, versi), saat giliran laptop ini tiba dan file-nya sudah ada.

### Bukti stempel (incremental update)

- Frontend menyimpan stempel dan halaman catatan sebagai incremental update: byte versi lama tidak diubah sedikit pun, objek baru dan objek yang berubah ditambahkan di belakang dengan xref dan trailer `/Prev`.
- Inti Rust (`increment::check_increment(old, new)`) menolak versi baru kecuali:
  1. `old` adalah awalan byte yang persis dari `new`;
  2. setelah kedua versi diurai (lopdf), objek yang berubah hanya: kamus halaman (hanya `/Contents` dengan isi lama utuh di tengah dan `/Resources` yang hanya bertambah), simpul `/Pages` (hanya menambah halaman di akhir), dan kamus Info;
  3. stream baru di halaman lama hanya berisi operator gambar dan teks (tanpa menggambar bidang yang bisa menutupi isi), gambar yang dipakai adalah gambar baru dan luasnya dibatasi;
  4. halaman baru hanya di akhir dan hanya dari penanda tangan terakhir (halaman catatan, isinya teks dan garis tipis);
  5. tidak ada aksi aktif (`/JS`, `/JavaScript`, `/AA`, `/OpenAction`, `/Launch`).
- Diperketat setelah review keamanan (lihat laporan `docs/progress/sinkron-dokumen-ttd.md`): gambar stempel harus sebagian besar transparan tanpa piksel putih buram, semua tanda satu versi di satu halaman masuk satu kotak paling luas 15% halaman, keterangan paling banyak 120 huruf dan 12 pt, batas total dekompresi dan jumlah objek.
- Dipakai di `service::complete` (laptop sendiri) dan saat menerima `signed` (laptop rekan). Hasil disimpan di `sign_proof_checks`.

## 6. Kontrak perintah dan tampilan (untuk UI)

Dokumen:
- `DocumentVersion.available` (sudah ada) dan `received`. Tambahan: `DocumentVersion.downloading: boolean`, `DocumentVersion.autoDownload: boolean` (sampai 20 MB).
- Perintah baru `download_version { documentId, versionId } -> DocumentSummary`. Error `not_available` (tidak ada laptop rekan tersambung yang punya file) dengan pesan Indonesia.
- Event `mira://feature` `{ topic: "docs" }` dan `mira://documents` `{ documentId }` memuat ulang daftar.

Tanda tangan:
- `RequestSummary` tambahan: `fromPeer: boolean`, `requestedByName: string`, `fileAvailable: boolean`, `fileSize: number`, `pending: boolean` (ada langkah yang menunggu file).
- `RequestDetail` tambahan: `fileAvailable`, `fileSize`, `scope: { teamId: string | null, projectId: string | null }`, `rejected: { signerName: string, at: string, reason: string }[]`.
- `sign_list_candidates { projectId?: string, teamId?: string }`: Tamu hanya muncul kalau proyeknya diizinkan.
- `sign_create_request` tambahan opsional `teamId`, `projectId`.
- Perintah baru `sign_download_file { requestId } -> RequestDetail`.
- Event `mira://feature` `{ topic: "sign" }` memuat ulang.
- Kode error baru: `version_not_prefix`, `version_changes_content` (dari bukti stempel), `not_available`.

## 7. Tugas dan pembagian (paralel, tiap subagent di worktree sendiri)

| Tugas | File milik | Selesai berarti |
|---|---|---|
| A. Sinkron dokumen | `documents/peer_sync.rs`, `access.rs`, `runtime.rs`, `commands.rs`, `view.rs`, `store.rs` (seperlunya) | Tes tiga laptop: versi dari rekan, bentrok, blob besar tidak otomatis, Tamu, anggota dikeluarkan, tanda edit kedaluwarsa, catatan palsu ditolak |
| B. Sinkron tanda tangan | `signing/peer_sync.rs`, `service.rs`, `outbox.rs`, `store.rs`, `repo.rs`, `request.rs`, `commands.rs`, `tests.rs` | Tes tiga laptop: A lalu B lalu C berurutan, giliran ditegakkan, catatan audit palsu ditolak, versi yang mengubah isi ditolak, batal, Tamu, blob store |
| C. Bukti stempel | `signing/increment.rs`, `Cargo.toml` (lopdf), `src/screens/sign/stamp.ts` (+ tes), fixture | PDF hasil stempel lolos, PDF yang mengubah isi ditolak, uji pdf.js tetap membaca hasil |
| D. Tampilan | `src/api/*`, `src/screens/docs/*`, `src/screens/sign/*` kecuali `stamp.ts` | Tombol unduh, daftar menunggu tanda tangan, pilihan proyek, versi ditolak, Vitest |
| E. Integrasi (saya) | `lib.rs`, gabung cabang, uji ujung ke ujung, screenshot bentrok | Semua uji lulus |
| F. Review | baca saja | Temuan keamanan dan tampilan diperbaiki |

TDD: tes dulu untuk setiap aturan izin dan penolakan, lalu implementasi. Tidak ada commit di worktree subagen sebelum tes lulus; saya menggabungkan.
