# Rencana dan kontrak: Kopi (reputasi positif)

Tanggal: 24 November 2026. Branch `claude/kopi-943a96`, dari `main` a45d1b3 (v0.5.0). Laporan: `docs/progress/kopi.md`.

Permintaan user: "sistem reputasi seperti kaskus", "jangan ada reputasi negatif, kopi aja", "bikin status reputasi seperti kopi tersebut rewarding, seperti selesai kerjakan task dll", "u atur terbaiknya gimana".

## 1. Ringkasan rancangan

- Hanya positif. Satuannya **Kopi** (Inggris: **Coffee**). Tidak ada pengurangan, tidak ada nilai negatif. Superadmin bisa menyembunyikan pemberian yang tidak pantas; itu bukan hukuman bagi penerima.
- **Kopi dari rekan**: dari menu klik kanan pesan chat ("Beri kopi"), dari task yang sudah selesai ("Terima kasih ke penanggung jawab"), dan dari profil orang. Wajib alasan 1 sampai 120 karakter. Paling banyak 3 per pemberi per hari lokal, dan paling banyak 4 (`PAIR_MONTHLY_LIMIT`) dari satu pemberi ke satu penerima per bulan kalender lokal pemberi. Tidak ke diri sendiri. Sekali per pesan, sekali per task, sekali per orang per hari dari profil. Tamu boleh menerima, tidak memberi. Pemberian dengan waktu sebelum `KOPI_EPOCH` (2026-11-24T00:00:00Z) atau sebelum pemberi atau penerima bergabung tidak dihitung.
- **Kopi dari kerja** (otomatis): task di Selesai yang dipindahkan ke Selesai oleh penanggung jawabnya sendiri (`done_by`), dan (a) ditugaskan orang lain, atau (b) selesai tepat waktu: tenggat paling jauh 14 hari (`ON_TIME_HORIZON_DAYS`) setelah tanggal tenggat diset (UTC), tenggat diset paling lambat 1 jam sebelum selesai, dan selesai sebelum pukul 12:00 UTC sehari setelah tanggal tenggat (akhir hari tenggat di UTC-12, zona paling barat, jadi pengguna zona mana pun yang selesai di hari tenggatnya tidak dianggap terlambat). Satu task paling banyak 1 Kopi. Anti-akal: proyek harus punya lebih dari satu orang; task yang dibuat sendiri lalu diselesaikan kurang dari 1 jam tidak dihitung; paling banyak 3 per orang per hari; dihitung dari keadaan board sekarang, jadi task yang dibuka lagi atau dihapus otomatis menarik Kopi-nya. Subtask diabaikan.
- **Tingkatan** dari skor = 3 x Kopi rekan + 1 x Kopi kerja: Anak baru (0), Andalan (15), Senior (60), Legenda (180). Konstanta di `kopi/tier.rs`.
- **Papan "Paling banyak membantu bulan ini"** di Organisasi: 10 skor teratas bulan itu.
- **Superadmin**: mematikan seluruh fitur, mematikan papan saja, menyembunyikan atau menampilkan lagi satu pemberian.

## 2. Keputusan teknis

| Keputusan | Alasan |
|---|---|
| Topik fitur baru `kopi`, record bertanda tangan amplop `documents::envelope` dengan domain `mira-kopi-v1`. | Pola yang sama dengan dokumen dan tanda tangan. Domain sendiri mencegah record fitur lain diputar ulang sebagai Kopi. |
| Kopi dari kerja dihitung langsung dari board di laptop yang bisa membaca proyeknya. Untuk proyek yang tidak terbaca (board disebar hanya ke anggota proyek), laptop penerima menerbitkan **snapshot kerja** bertanda tangan (`work`). | Board tidak tersinkron ke semua laptop, jadi tanpa record laptop di luar proyek akan menghitung angka berbeda. Snapshot hanya dipakai untuk proyek yang tidak terbaca; laptop yang bisa membaca proyek selalu memakai board sendiri dan mengabaikan snapshot. Isi snapshot dicek ke `OrgState`: proyek ada, proyek >= 2 orang dan penulis salah satunya (himpunan yang sama dengan board, `work::people`), `done` tidak lebih dari `FUTURE_SKEW_SECS` setelah `at` snapshot, tidak sebelum `created_at` proyek, dan tidak sebelum penulis ditambahkan ke proyek (`added_at`, kalau anggota eksplisit). |
| `cap_work`: event Board selalu menang atas klaim untuk task yang sama; unik per `(project, task, penerima)`; batas harian per penerima. | Klaim palsu atas task orang lain tidak bisa "mencuri" Kopi orang itu; paling banyak memberi penulisnya sendiri Kopi dalam batas hariannya. Keterbatasan: anggota proyek tak terbaca tetap bisa mengklaim task yang masuk akal secara waktu tetapi bukan miliknya (tidak bisa dicek tanpa board), dibatasi 3 per hari. |
| Kopi kerja hanya kalau aktor perpindahan terakhir ke Selesai == penanggung jawab (`WorkTask::done_by`). | Orang lain yang memindahkan task ke Selesai tidak memberi Kopi ke siapa pun. |
| Batas harian pemberi dihitung dari `at` bertanda tangan yang memuat offset lokal pemberi. Hari = tanggal pada `at`. | Sesuai permintaan "hari lokal, dicek di Rust dari waktu bertanda tangan". Record lebih dari 10 menit di masa depan ditolak saat masuk (diminta lagi nanti). |
| Anti-backdate: give dengan `at` < max(`KOPI_EPOCH`, `joined_at` pemberi, `joined_at` penerima) diabaikan. Batas per pasangan `PAIR_MONTHLY_LIMIT = 4` per (pemberi, penerima, bulan lokal pada `at`). | Urutan cek di fold setelah urut `(at, id)`: kunci target, batas pasangan bulanan, batas harian. Give yang gagal cek apa pun tidak memakai apa pun (kunci, jatah pasangan, jatah harian), jadi urutan cek tidak mengubah hasil. Sisa keterbatasan: pemberi yang mengubah jam masih bisa memakai jatah hari atau bulan lain antara `KOPI_EPOCH`/tanggal bergabung dan sekarang (paling banyak 3 per hari dan 4 per penerima per bulan); `joined_at` adalah waktu bergabung terakhir, jadi orang yang keluar lalu bergabung lagi kehilangan Kopi rekan sebelum bergabung ulang. |
| Batas banjir saat ingest (bukan permanen, diminta lagi pada sinkron berikutnya, dicatat sekali per id): give ditolak kalau (penulis, hari lokal) sudah punya `GIVE_STORED_DAILY_MAX` (= 2 x 3) give tersimpan; `hide`+`settings` per superadmin per hari UTC maksimal `ADMIN_STORED_DAILY_MAX` (200). | Mencegah satu laptop membanjiri semua laptop dengan record yang toh diabaikan fold. |
| Record yang gagal `record::open` dengan id yang cocok dengan isinya diingat permanen di `kopi_seen`. Penolakan karena peran boleh dicoba lagi (peran bisa berubah), dicatat sekali per id. Isi yang tidak cocok dengan id-nya tidak diingat. | Isi yang cocok dengan id tidak akan pernah sah, jadi tidak perlu diminta ulang. Isi palsu dengan id orang lain tidak boleh memblokir record asli. Pengecualian: record yang `t` atau `target.kind`-nya tidak dikenal versi ini (`sync::from_newer_version`) hanya ditolak untuk sementara, supaya diterima setelah laptop diperbarui. |
| Jam yang pernah melompat ke depan: record sendiri (`work`, `hide`, `settings`) dengan `at` > sekarang + `FUTURE_SKEW_SECS` dipindah ke `kopi_seen` dan record baru memakai waktu sekarang, bukan "terakhir + 1 detik". | Kalau tidak, semua perubahan berikutnya akan bertanggal masa depan dan ditolak laptop lain sampai waktunya tiba. |
| Batas harian kerja memakai tanggal UTC dari waktu selesai. | Waktu board ditulis UTC tanpa offset lokal. Sama di semua laptop. |
| Pemberian tersembunyi tetap memakai jatah harian pemberi. | Deterministik dan stabil: menyembunyikan tidak membuat pemberian lain hari itu tiba-tiba terhitung. |
| Pengaturan dan sembunyikan: yang terbaru menurut `(at, id record)` dari superadmin saat ini. | Sederhana. Keterbatasan: jam laptop superadmin yang salah bisa membuat perubahan lama menang. |
| Tabel SQLite dibuat dengan `CREATE TABLE IF NOT EXISTS` saat pertama dipakai (`kopi::store::ensure_schema`), bukan migrasi bernomor. | Beberapa sesi paralel mungkin menambah migrasi; tabel sendiri tanpa nomor tidak bentrok saat digabung. |
| Laptop 0.5.x: topik yang tidak dikenal dihentikan diam-diam oleh transport (`FEATURE_STOP_UNKNOWN_TOPIC`), jadi tidak rusak. Tidak perlu gerbang versi. | Diverifikasi di `network/node.rs`. |
| Tidak mengubah `src-tauri/src/permissions/`. Peran dibaca lewat `permissions::load_state` / `OrgState` (`member`, `is_superadmin`, `is_project_member`, `projects`). | Dua sesi lain sedang mengubah `permissions/`. |
| Ikon: `IconCoffee` dari `@tabler/icons-react` (paket ikon yang sudah dipakai). | Tanpa emoji. |

## 3. Kontrak Rust (`src-tauri/src/kopi/`)

`types.rs` sudah ditulis dan menjadi kontrak (payload, `Target::key`, `WorkTask`, `WorkEvent`, `GiveEntry`, `KopiState`, `Settings`, `Tier`, konstanta). Pembagian file:

### 3.1 `record.rs` (agen A1)
- `pub fn seal(identity: &Identity, payload: &Payload) -> Result<FeatureRecord, String>` lewat `envelope::seal(identity, DOMAIN, payload)`.
- `pub fn open(record: &FeatureRecord) -> Result<StoredRecord, String>`: `envelope::open` lalu `validate_shape`.
- `pub fn validate_shape(author: &str, p: &Payload) -> Result<(), String>`: pemeriksaan tanpa konteks: hex 64 untuk kunci, `to != author` untuk give, alasan setelah trim 1..=`REASON_MAX` karakter tanpa karakter kontrol, `at` RFC 3339, nonce 16 hex, id target tidak kosong, maksimal `TARGET_ID_MAX`, project/task id hex atau sesuai format board (cek `board`), `day` `YYYY-MM-DD` sama dengan tanggal pada `at` untuk target profil, `items` paling banyak `WORK_SNAPSHOT_MAX`, `record` di hide hex 64.
- `pub fn local_day(at: &str) -> Option<String>`: tanggal pada offset yang tertulis di `at`.

### 3.2 `store.rs` (agen A1)
- `pub fn ensure_schema(conn: &Connection) -> AppResult<()>` membuat:
  - `kopi_records (id TEXT PRIMARY KEY, author TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL, received_at TEXT NOT NULL, received_from TEXT) STRICT`
  - `kopi_seen (id TEXT PRIMARY KEY) STRICT` untuk snapshot kerja lama yang dibuang (supaya tidak diminta lagi).
  - `kopi_published (author TEXT PRIMARY KEY, items_hash TEXT NOT NULL) STRICT` untuk runtime.
- `pub fn insert(conn, rec: &FeatureRecord, opened: &StoredRecord, from: Option<&str>) -> AppResult<bool>`; snapshot `work` yang lebih lama dari yang tersimpan untuk penulis yang sama hanya dicatat di `kopi_seen`; yang lebih baru menggantikan (yang lama dipindah ke `kopi_seen`).
- `pub fn load_all(conn) -> AppResult<Vec<StoredRecord>>`, `pub fn ids(conn)`, `pub fn bodies(conn, ids)`, `pub fn known(conn, id) -> bool`.
- `pub fn seal_and_store(core: &mut Core, payload: &Payload) -> AppResult<FeatureRecord>`.

### 3.3 `rules.rs` (agen A2) - murni, tanpa SQLite
- `pub fn fold(records: &[StoredRecord], org: &OrgState, local_work: &[WorkEvent], readable_projects: &HashSet<String>) -> KopiState`
  1. Settings: record `Settings` dari penulis yang `org.is_superadmin` saat ini; terbaru `(at UTC, id)` menang. Default nyala.
  2. Give sah kalau: penulis ada di `org.members` dengan `kind == Member` dan (aktif, atau `at` sebelum `removed_at`); `to` ada di `org.members` (anggota atau tamu); `to != from`; `at` >= max(`KOPI_EPOCH`, `joined_at` pemberi, `joined_at` penerima). Urut `(at UTC, id)`. Lalu berurutan: per `(from, target.key(to))` hanya yang pertama; per `(from, to, bulan lokal)` paling banyak `PAIR_MONTHLY_LIMIT`; per `(from, hari lokal)` paling banyak `GIVE_DAILY_LIMIT`. Give yang gagal tidak memakai kunci maupun jatah. Yang lolos masuk `gives`.
  3. Hide: per id record, terbaru `(at, id)` dari superadmin saat ini menentukan `hidden`.
  4. Kerja: `local_work` (sumber Board) untuk proyek di `readable_projects`; ditambah item snapshot terbaru per penulis untuk proyek yang TIDAK ada di `readable_projects`, hanya kalau proyek ada di `org.projects`, `work::people(org, p)` berisi >= 2 orang termasuk penulis, dan `done` dalam rentang waktu yang mungkin (lihat bagian 2). Lalu `cap_work`.
  5. Fitur mati tidak mengubah fold; tampilan dan command yang menyaring.
- `pub fn cap_work(events: Vec<WorkEvent>) -> Vec<WorkEvent>`: klaim untuk task yang punya event Board dibuang; unik per `(project, task, recipient)`; urut `(done_at, project, task, recipient)`, paling banyak `WORK_DAILY_LIMIT` per `(recipient, tanggal UTC)`.
- `pub fn given_pair_month(state, from, to, month) -> usize` (dipakai `kopi_give` untuk menolak dengan pesan yang jelas).
- `pub fn totals(state: &KopiState, pk: &str) -> (u32 peer, u32 work)`; peer tidak menghitung yang hidden.
- `pub fn month_totals(state, month: "YYYY-MM") -> Vec<(pk, peer, work)>`: give memakai bulan pada `at` (lokal pemberi), kerja memakai bulan UTC `done_at`.
- `pub fn given_on(state, from, day) -> usize`, `pub fn given_keys(state, from) -> Vec<String>`.

### 3.4 `tier.rs` (agen A2)
- `pub const PEER_WEIGHT: u32 = 3; pub const WORK_WEIGHT: u32 = 1;`
- `pub const THRESHOLDS: [(Tier, u32); 4] = [(AnakBaru,0),(Andalan,15),(Senior,60),(Legenda,180)];`
- `score(peer, work)`, `of(score) -> Tier`, `next(score) -> Option<(Tier, u32)>`.

### 3.5 `work.rs` (agen A3)
- `pub fn project_people(org: &OrgState, project: &str) -> usize`: orang yang boleh bekerja di proyek, sama dengan aturan akses board (anggota eksplisit proyek; pelajari `board/access.rs`), tanpa menghitung tamu dua kali.
- `pub fn tasks_from_boards(conn: &Connection, org: &OrgState) -> AppResult<(Vec<WorkTask>, HashSet<String>)>`: semua task dari semua proyek board yang dipegang laptop ini (membaca dokumen lewat API board yang sudah ada; jangan ubah file `board/` kecuali menambah fungsi baca kecil yang benar-benar perlu, catat di laporan), plus himpunan id proyek yang terbaca.
- `pub(crate) fn people(org, project) -> BTreeSet<String>`: himpunan di balik `project_people`, juga dipakai `rules::fold` untuk snapshot.
- `WorkTask::done_by`: aktor entri terakhir yang memasukkan task ke Selesai.
- `pub fn qualify(tasks: &[WorkTask]) -> Vec<WorkEvent>` (belum dibatasi harian): syarat di bagian 1. Wajib `done_by == assignee`. Alasan: `Assigned` kalau `assigned_by != assignee`; selain itu `OnTime` kalau `due` ada, `due` <= tanggal UTC `due_set_at` + `ON_TIME_HORIZON_DAYS`, `done_at - due_set_at >= QUICK_SELF_TASK_SECS`, dan `done_at` < (`due` + 1 hari) 12:00Z. Aturan 1 jam sejak dibuat berlaku kalau `created_by == assignee`.
- `pub fn own_items(events: &[WorkEvent], me: &str) -> Vec<WorkItem>` (sumber Board saja, terbaru `WORK_SNAPSHOT_MAX`).

### 3.6 `sync.rs` (agen A1)
- `pub struct KopiSync` dengan `MiraState`; `impl FeatureSync` topik `TOPIC_KOPI` (`"kopi"`, ditambahkan sebagai satu baris konstanta di `network/feature.rs`).
- `record_ids_for(peer)`: anggota aktif (bukan tamu) menerima semua id. Tamu aktif menerima record `settings` dan `give` dengan `to == peer`, serta `hide` untuk give itu. Selain itu kosong. `records_for` menyaring ulang.
- `ingest`: id yang sudah dikenal dilewati; `record::open` gagal dengan id cocok -> `kopi_seen` (permanen); lalu cek konteks saat masuk: give dari bukan anggota (`kind != Member`), settings/hide dari bukan superadmin, work dari bukan orang kantor ditolak sementara; `at` lebih dari `FUTURE_SKEW_SECS` di masa depan tidak disimpan (tidak dihitung ditolak); batas banjir `GIVE_STORED_DAILY_MAX` dan `ADMIN_STORED_DAILY_MAX` ditolak sementara. Penolakan dicatat sekali per id. `changed = true` kalau ada yang tersimpan.
- `pub fn register(app: &AppHandle)` dipanggil di `lib.rs`; juga `app.manage(KopiCache::default())`.

### 3.7 `runtime.rs` (agen A1)
- Tugas latar: saat mulai dan setiap 60 detik; hanya menghitung ulang kalau kunci board (`store::board_marker`) atau log keanggotaan (`store::org_marker`) berubah sejak putaran sebelumnya. Hitung `work::own_items` laptop ini; kalau hash isinya beda dari `kopi_published`, terbitkan `Payload::Work` baru dan `hub.notify_changed("kopi")`, emit `mira://feature {topic:"kopi"}`.

### 3.7a Cache command (`commands::KopiCache`)
- Satu `Snapshot` (OrgState + record + fold + task board) disimpan dengan kunci `commands::cache_key`: kunci publik laptop, `store::records_marker` (jumlah dan max rowid `kopi_records`, jumlah `kopi_seen`), `store::board_marker` (jumlah dan max rowid `board_changes`, jumlah, max rowid dan max `updated_at` `board_projects`), `store::org_marker` (jumlah, max rowid, jumlah `applied` `org_ops`, id organisasi). Kunci dihitung di dalam kunci core, jadi data dan kunci selalu sepasang. Pesan chat untuk target dicek langsung, tidak lewat cache.

### 3.8 `view.rs` dan `commands.rs` (agen A4, setelah A1 sampai A3)
Bentuk JSON persis `src/api/kopi.ts`. Command:
- `kopi_overview(offset_minutes: i32) -> KopiOverview`
- `kopi_profile(public_key: String) -> KopiProfile` (entri hidden hanya untuk superadmin)
- `kopi_give(input: KopiGiveInput, offset_minutes: i32) -> ()`: tolak kalau fitur mati, saya tamu atau bukan anggota aktif, ke diri sendiri, penerima tidak dikenal, alasan tidak valid, target sudah pernah, jatah hari ini habis; untuk target task: task ada di board yang saya baca, di Selesai, penanggung jawabnya `to`; untuk target pesan: pesan ada di chat laptop ini dan penulisnya `to`. Simpan, `notify_changed`, emit.
- `kopi_hide(record_id, hidden)`: hanya superadmin.
- `kopi_set_settings(enabled, board)`: hanya superadmin.
- `kopi_board(month: String, offset_minutes: i32) -> KopiBoard`
Error memakai `AppError` yang ada (`Forbidden`, `NotFound`, `InvalidSetting`) dengan pesan Indonesia; pesan baru juga didaftarkan di `src/i18n/errors-rust.*.ts` kalau pola itu dipakai.

## 4. Kontrak frontend

`src/api/kopi.ts` sudah ditulis. Komponen (agen F1, file baru di `src/components/`):
- `useKopi.ts`: `useKopi(): { overview: KopiOverview | null; badgeOf(pk: string): KopiBadge | null; reload(): Promise<void> }`. Satu cache bersama untuk seluruh aplikasi, muat ulang saat `subscribeFeature("kopi")` dan `subscribeFeature("board")`, polling 60 detik.
- `KopiMark.tsx`: `<KopiMark publicKey={string} />` ikon kecil `IconCoffee` di samping nama; tidak tampil kalau fitur mati atau orang itu belum punya Kopi. Nama aksesibel: tingkatan dan jumlah.
- `KopiGiveDialog.tsx`: `<KopiGiveDialog open onClose to={KopiPerson} target={KopiTarget} context?={string} onGiven?={() => void} />` dengan isian alasan (hitung karakter, maksimal `reasonMax`), sisa jatah hari ini, catatan "Alasan terlihat oleh semua orang di kantor".
- `KopiProfileSection.tsx`: `<KopiProfileSection person={KopiPerson} />` jumlah Kopi rekan dan kerja terpisah, tingkatan, jarak ke tingkatan berikutnya, tombol "Beri kopi" (target profil, tidak untuk diri sendiri), riwayat "dari siapa, untuk apa" (entri kerja: judul task atau "Task di proyek lain"), tombol sembunyikan/tampilkan untuk superadmin.
- `kopi.css` untuk gaya, pakai token warna yang sudah ada.
- Teks: `src/i18n/kopi.ts`, `kopi.id.ts`, `kopi.en.ts`.

Titik masuk (agen F3, perubahan sekecil mungkin di file bersama):
- Chat: item menu klik kanan pesan rekan "Beri kopi" (`menuText.ts`, `conversationMenu.tsx` atau tempat menu pesan dibangun), dinonaktifkan dengan keterangan kalau sudah diberi atau jatah habis; tidak tampil di pesan sendiri, untuk Tamu, atau kalau fitur mati.
- Chat: `ProfileDialog.tsx` menampilkan `KopiProfileSection`.
- Board: `TaskDetail.tsx` tombol "Terima kasih ke <nama>" saat task di Selesai, penanggung jawab ada dan bukan saya.
- Ikon `KopiMark` di samping nama pengirim pesan chat kalau masuk akal dengan satu baris.

Organisasi (agen F2, file baru `src/screens/org/KopiBoardPanel.tsx`, `kopi-board.css`, `src/i18n/kopi-board*.ts`; satu sampai beberapa baris di `OrgScreen.tsx`):
- Panel "Kopi": papan "Paling banyak membantu bulan ini" (pilih bulan sebelumnya/berikutnya), penjelasan cara mendapat Kopi dan tingkatan, dan untuk superadmin dua sakelar: "Fitur Kopi" dan "Papan bulanan".
- `KopiProfileSection` dipakai juga di Organisasi kalau ada tampilan profil orang (cek `PeoplePanel`/`UsersPanel`), dengan perubahan minimal.

## 5. Pembagian kerja paralel

| Agen | File milik |
|---|---|
| A1 inti record, store, sync, runtime | `kopi/record.rs`, `kopi/store.rs`, `kopi/sync.rs`, `kopi/runtime.rs`, satu baris `network/feature.rs`, registrasi di `lib.rs` |
| A2 aturan dan tingkatan | `kopi/rules.rs`, `kopi/tier.rs` |
| A3 kerja dari board | `kopi/work.rs` |
| A4 view dan command (setelah A1 sampai A3) | `kopi/view.rs`, `kopi/commands.rs`, daftar command di `lib.rs` |
| F1 komponen dan teks | `src/components/Kopi*`, `src/components/useKopi.ts`, `src/components/kopi.css`, `src/i18n/kopi*.ts` (bukan `kopi-board*`) |
| F2 panel Organisasi | `src/screens/org/KopiBoardPanel*`, `src/screens/org/kopi-board.css`, `src/i18n/kopi-board*.ts`, `OrgScreen.tsx` |
| F3 titik masuk chat dan board | `src/screens/chat/*`, `src/screens/board/TaskDetail.tsx` |
| E e2e | `scripts/kopi-e2e.mjs`, satu skrip di `package.json` |

## 6. Uji

- Unit Rust: batas harian, tidak ke diri sendiri, sekali per pesan/task/profil-hari, tamu tidak memberi, kerja (ditugaskan orang lain, tepat tenggat, tenggat diset setelah selesai, buat-selesai sendiri < 1 jam, proyek satu orang, dibuka lagi, dihapus, batas harian), snapshot hanya untuk proyek tak terbaca, tingkatan, sembunyikan oleh superadmin (dan bukan superadmin ditolak), fitur dimatikan, tiga laptop konvergen lewat `network::feature::testing`.
- Vitest: komponen dan titik masuk.
- E2E `scripts/kopi-e2e.mjs` dua sampai tiga instance: A beri Kopi ke B dari pesan; B melihat di profil; task selesai memberi Kopi kerja; task dibuka lagi menarik Kopi; batas harian; superadmin mematikan fitur.
