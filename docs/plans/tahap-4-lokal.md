# Rencana implementasi Tahap 4 (bagian lokal): Dokumen dan edit file

Tanggal: 22 November 2026. Branch: `claude/tahap-4-dokumen-lokal-e47711` (dasar: commit 8d2023a, Tahap 1 sudah ikut sampai modul jaringan, tapi command jaringan belum disambung ke `lib.rs`).

Sumber: `design/rencana-pembangunan.html` (Tahap 4), `design/prd-mira.html` (F-DOC-01 sampai F-DOC-05, F-UI-01 sampai F-UI-04, F-CHAT-05 untuk batas 20 MB), `design/brainstorming.html` (layar Dokumen dan alur edit Word/Excel), `design/tema-c.html`.

## Tujuan

Di satu laptop, tanpa jaringan: menambah file ke pustaka dokumen, membukanya di Word atau Excel, melihat tanda "Sedang diedit", mendapat versi baru otomatis setiap kali file disimpan, melihat riwayat versi, dan memulihkan versi lama. Model data "bentrok" (dua versi berdampingan) beserta tampilannya sudah siap, diuji dengan tes unit, dan tinggal disambung ke jaringan.

Bukan lingkup: catatan/coretan PDF dan semua yang memakai pdf.js (bersama Tahap 5), jaringan, chat, board, tanda tangan, menghapus dokumen (butuh tombstone saat sinkron, dikerjakan bersama sinkronisasi).

## Keputusan

1. **Blob beralamat hash.** Isi file disimpan sekali di `<data>/blobs/<2 hex>/<64 hex>` (BLAKE3). Versi dengan isi sama memakai blob yang sama. Modul `blobs/` berdiri sendiri supaya chat (lampiran) dan Tahap 5 (PDF bertanda tangan) bisa memakainya.
2. **Graf versi, bukan daftar.** Setiap versi mencatat induknya (`document_version_parents`). Versi tanpa anak adalah "kepala". Satu kepala = normal. Dua kepala atau lebih = **bentrok**. Ini membuat bentrok muncul dengan sendirinya saat versi dari rekan masuk nanti, tanpa logika khusus di jaringan.
3. **Pulihkan = versi baru.** Memulihkan versi 1 membuat versi baru (isi versi 1) dengan induk semua kepala sekarang. Riwayat tidak pernah ditulis ulang. Kalau sedang bentrok, memulihkan juga menyelesaikan bentrok.
4. **Menyelesaikan bentrok.** Dua cara: "Pakai versi ini" (versi baru berisi versi pilihan, induk semua kepala, asal `resolved`), atau "Gabung manual" (mulai edit dari salah satu versi; simpanan pertama menjadi versi dengan induk semua kepala, jadi bentrok selesai).
5. **Nomor versi lokal.** `seq` adalah nomor tampilan per laptop (Versi 1, 2, 3...). Identitas versi yang dipakai sinkron adalah `id` (acak 16 byte hex). Setelah sinkron, nomor di dua laptop bisa berbeda kalau versi masuk dengan urutan lain; itu wajar dan dicatat untuk Tahap sinkron.
6. **Kapan versi baru dibuat.** User memutuskan "versi baru setelah file disimpan". Setiap simpanan yang isinya berubah (hash berbeda) dan sudah tenang selama 1,5 detik menjadi satu versi. PRD F-DOC-03 menyebut "disimpan dan ditutup"; tanda "Sedang diedit" baru hilang setelah file ditutup (kunci `~$` hilang), jadi alurnya tetap sesuai PRD.
7. **Salinan kerja.** File dibuka dari `<data>/working/<document_id>/<nama file>` (nama asli supaya judul jendela Word benar). Folder itu hanya berisi satu dokumen, jadi file kunci `~$...` dan file sementara Office mudah dikenali. Blob tidak pernah dibuka langsung oleh Office.
8. **Pola simpan Office.** Word: menulis `~WRLxxxx.tmp`, mengganti nama file asli, lalu mengganti nama file sementara menjadi nama asli. Excel: menulis file 8 karakter hex tanpa ekstensi, lalu rename. Keduanya membuat kunci `~$nama` (Word memotong dua huruf pertama untuk nama panjang). Pemantau hanya peduli pada path file target; semua kejadian lain diabaikan, lalu file dibaca setelah tenang (debounce). Kalau file sedang terkunci atau hilang sesaat, dicoba lagi.
9. **Selesai mengedit.** Otomatis saat kunci `~$` hilang setelah pernah terlihat (Office menutup file), atau manual lewat tombol "Selesai mengedit" (untuk aplikasi yang tidak membuat kunci). Tombol manual menolak kalau kunci masih ada, supaya simpanan berikutnya tidak hilang.
10. **Mira ditutup saat mengedit.** Saat start, setiap sesi edit diperiksa: kalau file kerja berubah, dibuat versi baru; kalau kunci masih ada, pemantauan dilanjutkan; kalau tidak, sesi diakhiri.
11. **Buka hanya baca.** Salinan versi ditulis ke `<data>/view/<version_id>/<nama>` dengan atribut read-only lalu dibuka dengan aplikasi bawaan. Juga dipakai untuk PDF dan jenis lain sampai Tahap 5.
12. **Proyek belum ada.** `project_id` dan `team_id` boleh NULL. NULL berarti pustaka umum organisasi. Layar menampilkan satu pustaka "Umum" sampai proyek dari Tahap 3 tersedia.
13. **Nama sama.** File dengan nama yang sudah ada di pustaka yang sama diberi akhiran " (2)", " (3)", dan seterusnya. Tidak ada yang tertimpa.
14. **Jenis file.** Word: docx, docm, doc, dotx, rtf. Excel: xlsx, xlsm, xls, xltx, csv. PDF: pdf. Selain itu "lainnya". Tombol edit hanya untuk Word dan Excel.
15. **Uji tanpa membuka jendela Office.** Variabel `MIRA_TEST_NO_LAUNCH=1` membuat "Edit" menyiapkan salinan kerja dan pemantau tanpa memanggil opener (seperti `MIRA_CLOCK_OFFSET_SECS` di Tahap 1). Uji ujung ke ujung lalu menyimpan file itu lewat instance Excel/Word sendiri (COM, tidak terlihat) supaya pola simpan Office yang asli teruji tanpa mengganggu Office milik user.

## 1. Struktur

```
src-tauri/src/blobs/mod.rs            blob store (API kecil, terdokumentasi)
src-tauri/src/documents/
  mod.rs        deklarasi modul
  schema.rs     SQL migrasi dokumen (satu entri di akhir MIGRATIONS)
  kinds.rs      jenis file dari ekstensi
  store.rs      dokumen, versi, kepala, pulihkan, selesaikan bentrok, baris sesi edit, tampilan
  access.rs     izin per aksi (titik sambung izin peran)
  sync.rs       titik sambung jaringan (trait keluar + fungsi apply_remote_*)
  office.rs     pola nama file Office + pelacak debounce (murni)
  watch.rs      pemantau folder salinan kerja (notify)
  session.rs    alur edit: salinan kerja, versi dari simpanan, selesai, pemulihan saat start   [gelombang 2]
  runtime.rs    state Tauri: pemantau + sink + emitter event + opener                         [gelombang 2]
  commands.rs   command Tauri dokumen                                                          [gelombang 2]
src/api/documents.ts                   pembungkus invoke + tipe
src/screens/docs/                      layar Dokumen
```

`lib.rs` hanya mendapat `pub mod blobs; pub mod documents;`, plugin dialog, satu `app.manage(...)` untuk runtime dokumen, dan baris di `generate_handler!`. Error baru di `error.rs`: `storage`, `invalid_input`, `document_editing`, `open_failed`.

## 2. Skema

Lihat `src-tauri/src/documents/schema.rs` (tabel `documents`, `document_versions`, `document_version_parents`, `document_edit_sessions`, `document_remote_editing`). Di branch ini menjadi skema v3; nomor final ditentukan saat merge dengan Tahap 3 dan 5.

## 3. Kontrak Rust antarmodul

### 3.1 `blobs` (tugas A)

Tanda tangan fungsi ada di `src-tauri/src/blobs/mod.rs` (stub). Aturan:
- `BlobHash::parse` hanya menerima 64 hex huruf kecil; selain itu `AppError::InvalidInput`.
- Tulis ke `<root>/tmp/<acak>`, hash sambil menyalin (streaming, buffer 64 KiB), `sync_all`, lalu rename ke `<root>/<2 hex>/<hash>`. Kalau tujuan sudah ada, file sementara dihapus. Rename yang gagal karena tujuan sudah ada (balapan) juga dianggap berhasil.
- File blob diberi atribut read-only setelah ditulis (Windows), supaya tidak teredit tanpa sengaja; `remove` melepas atribut dulu.
- `copy_to` menulis ke file sementara di folder tujuan lalu rename menimpa; hasilnya file biasa yang bisa ditulis.
- Error I/O menjadi `AppError::Storage` dengan pesan Indonesia yang menyebut path; blob tidak ada menjadi `AppError::NotFound`.
- `should_auto_replicate(size)` = `size <= AUTO_REPLICATE_MAX_BYTES`.

### 3.2 `documents::office` dan `documents::watch` (tugas B)

```rust
// office.rs (murni, tanpa I/O kecuali lock_present)
pub fn is_office_temp_file(file_name: &str) -> bool;       // ~$*, ~WRL*.tmp, *.tmp, ~*.tmp, nama 8 hex tanpa ekstensi, .~lock.*#
pub fn is_lock_file_for(file_name: &str, target_name: &str) -> bool; // "~$"+nama, "~$"+nama[2..] (Word), ".~lock."+nama+"#" (LibreOffice); tanpa beda huruf besar/kecil
pub fn lock_present(working_file: &Path) -> bool;           // ada file kunci untuk target di foldernya
pub struct SettleTracker { .. }                              // debounce per document_id dengan waktu yang disuntikkan
impl SettleTracker {
    pub fn new(settle: Duration) -> Self;
    pub fn touch(&mut self, id: &str, now: Instant);         // ada kejadian untuk id
    pub fn due(&mut self, now: Instant) -> Vec<String>;      // id yang sudah tenang >= settle, sekali saja
    pub fn next_deadline(&self) -> Option<Instant>;
    pub fn forget(&mut self, id: &str);
}

// watch.rs
pub const DEFAULT_SETTLE: Duration = Duration::from_millis(1500);
pub trait WatchSink: Send + Sync + 'static {
    /// File target berubah dan sudah tenang. Dipanggil dari thread pemantau.
    fn file_settled(&self, document_id: &str);
    /// Kunci Office untuk target hilang setelah sebelumnya terlihat (file ditutup).
    fn lock_released(&self, document_id: &str);
    /// Kunci Office untuk target muncul (dipakai untuk menandai lock_seen).
    fn lock_appeared(&self, document_id: &str) {}
}
pub struct OfficeWatcher { .. }   // Send + Sync; satu thread pekerja untuk debounce
impl OfficeWatcher {
    pub fn new(sink: Arc<dyn WatchSink>, settle: Duration) -> AppResult<Self>;
    /// Memantau folder induk `working_file` (tidak rekursif). Memanggil ulang untuk id yang sama mengganti target.
    pub fn watch(&self, document_id: &str, working_file: &Path) -> AppResult<()>;
    pub fn unwatch(&self, document_id: &str);
    pub fn is_watching(&self, document_id: &str) -> bool;
}
```

Kejadian yang relevan: create/modify/rename/remove yang menyentuh path target (termasuk rename *ke* target), dan create/remove file kunci target. File sementara lain diabaikan tanpa memicu debounce. `file_settled` dipanggil sekali per rangkaian simpan (debounce), bukan per kejadian. Keadaan kunci dicek ulang setelah tenang (bukan hanya dari kejadian) supaya kejadian yang terlewat tidak membuat sesi menggantung.

Tes: unit untuk pola nama (contoh nama nyata Word/Excel/LibreOffice), `SettleTracker` dengan waktu buatan, dan tes integrasi dengan folder sementara yang meniru urutan simpan Word dan Excel (tulis file sementara, rename asli, rename sementara ke asli, buat/hapus kunci). Satu rangkaian simpan = tepat satu `file_settled`. Hapus kunci = satu `lock_released`.

### 3.3 `documents::{kinds, store, access, sync}` (tugas C)

```rust
// kinds.rs
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)] #[serde(rename_all = "lowercase")]
pub enum DocumentKind { Word, Excel, Pdf, Other }
impl DocumentKind { pub fn from_file_name(name: &str) -> Self; pub fn as_str(self) -> &'static str; pub fn parse(s: &str) -> Option<Self>; pub fn editable(self) -> bool; }

// store.rs (semua fungsi menerima &Connection atau &mut Connection; waktu RFC 3339 dari pemanggil)
pub struct DocScope { pub team_id: Option<String>, pub project_id: Option<String> }
pub enum VersionOrigin { Added, Edited, Restored, Resolved }   // serde lowercase
pub struct DocumentRecord { id, team_id, project_id, name, kind, created_by, created_at }
pub struct VersionRecord { id, document_id, seq: i64, blob: BlobInfo, author, created_at, origin, restored_from: Option<String>, received_at: Option<String>, parent_ids: Vec<String> }
pub struct EditSession { document_id, editor, parent_ids: Vec<String>, working_path: PathBuf, started_at, last_hash: BlobHash, last_saved_at: Option<String>, lock_seen: bool }

pub fn new_id() -> String;                                     // 16 byte acak, hex
pub fn sanitize_file_name(raw: &str) -> AppResult<String>;     // buang path, tolak kosong/terlarang Windows
pub fn unique_name(conn, scope: &DocScope, wanted: &str) -> AppResult<String>;  // "x (2).docx"
pub fn create_document(conn: &mut Connection, scope: &DocScope, name: &str, blob: &BlobInfo, author: &str, now: &str) -> AppResult<(DocumentRecord, VersionRecord)>;
pub fn add_version(conn: &mut Connection, document_id: &str, parent_ids: &[String], blob: &BlobInfo, author: &str, origin: VersionOrigin, restored_from: Option<&str>, now: &str) -> AppResult<VersionRecord>;
pub fn get_document(conn, id) -> AppResult<DocumentRecord>;   // not_found
pub fn list_documents(conn, project_id: Option<&str>) -> AppResult<Vec<DocumentRecord>>;
pub fn versions(conn, document_id) -> AppResult<Vec<VersionRecord>>;   // terbaru dulu (seq turun)
pub fn get_version(conn, version_id) -> AppResult<VersionRecord>;
pub fn heads(conn, document_id) -> AppResult<Vec<VersionRecord>>;      // seq turun; >1 = bentrok
pub fn current(conn, document_id) -> AppResult<VersionRecord>;         // kepala dengan seq tertinggi
pub fn restore_version(conn: &mut Connection, document_id, version_id, author, now) -> AppResult<VersionRecord>;  // tolak (document_editing) kalau ada sesi edit lokal
pub fn resolve_conflict(conn: &mut Connection, document_id, keep_version_id, author, now) -> AppResult<VersionRecord>; // keep harus kepala; invalid_input kalau tidak bentrok
// Sesi edit
pub fn edit_session(conn, document_id) -> AppResult<Option<EditSession>>;
pub fn edit_sessions(conn) -> AppResult<Vec<EditSession>>;
pub fn insert_edit_session(conn, s: &EditSession) -> AppResult<()>;     // document_editing kalau sudah ada
pub fn record_saved_version(conn: &mut Connection, document_id, blob: &BlobInfo, author, now) -> AppResult<Option<VersionRecord>>;
      // dalam satu transaksi: kalau blob.hash == last_hash -> None; selain itu add_version(parents = sesi.parent_ids,
      // origin = Resolved kalau parents > 1 selain itu Edited), lalu sesi.parent_ids = [versi baru], last_hash, last_saved_at.
pub fn set_lock_seen(conn, document_id) -> AppResult<()>;
pub fn delete_edit_session(conn, document_id) -> AppResult<()>;
// Tampilan (untuk command), lihat bagian 4
pub fn summary(conn, blobs: &BlobStore, me: &Identity, access: &dyn DocumentAccess, document_id, now: &str) -> AppResult<DocumentSummary>;
pub fn detail(...) -> AppResult<DocumentDetail>;
pub fn summaries(conn, blobs, me, access, project_id: Option<&str>, now) -> AppResult<Vec<DocumentSummary>>;  // urut nama
```

Nama orang (`PersonRef`) dari tabel `members` (status apa pun) berdasarkan kunci publik; kalau tidak ada, "Rekan " + 4 grup sidik jari pertama. `isMe` kalau kunci = identitas laptop ini.

```rust
// access.rs: titik sambung izin peran
pub enum DocAction { View, Add, Edit, Restore, Resolve, Export }
pub fn role_allows(role: Role, action: DocAction) -> bool;  // Tamu: View dan Export saja. Anggota, Admin tim, Superadmin: semua.
pub trait DocumentAccess: Send + Sync {
    fn check(&self, conn: &Connection, me: &Identity, scope: &DocScope, action: DocAction) -> AppResult<()>;  // forbidden + pesan Indonesia
}
pub struct RoleAccess;  // peran laptop ini dari org::get_organization; laptop dikeluarkan = forbidden.
                        // TODO sambung: batas tim (team_id) dan proyek tamu (guest_access) dari permissions::OrgState.
```

```rust
// sync.rs: titik sambung jaringan
pub trait DocumentSync: Send + Sync {
    fn document_added(&self, doc: &DocumentRecord, first: &VersionRecord) {}
    fn version_added(&self, doc: &DocumentRecord, version: &VersionRecord) {}
    fn editing_changed(&self, document_id: &str, editor: &str, editing: bool, at: &str) {}
}
pub struct NoSync;  // Tahap 4 lokal
pub enum BlobFetch { Auto, OnDemand }
pub fn blob_fetch_policy(size: u64) -> BlobFetch;            // memakai blobs::should_auto_replicate
pub struct RemoteDocument { id, team_id, project_id, name, kind, created_by, created_at }
pub struct RemoteVersion  { id, document_id, parent_ids, blob_hash, size, author, created_at, origin, restored_from }
pub struct ApplyOutcome { pub inserted: bool, pub conflict: bool }
pub fn apply_remote_document(conn: &mut Connection, d: &RemoteDocument, now: &str) -> AppResult<bool>;   // idempoten; nama bentrok diberi akhiran lokal
pub fn apply_remote_version(conn: &mut Connection, v: &RemoteVersion, now: &str) -> AppResult<ApplyOutcome>; // idempoten; seq lokal berikutnya; received_at = now;
     // kalau ada sesi edit lokal, sesi tidak diubah, jadi simpanan berikutnya menjadi kepala kedua (bentrok).
pub fn set_remote_editing(conn, document_id, editor, since: Option<&str>, now) -> AppResult<()>;  // None = hapus tanda
pub const REMOTE_EDITING_STALE_SECS: i64 = 600;              // tanda tanpa pembaruan > 10 menit diabaikan di tampilan
```

Tes unit (wajib): dokumen baru = versi 1 tanpa induk; tambah versi linear; nama ganda; pulihkan membuat versi baru berisi blob lama dan induk = kepala; pulihkan ditolak saat sesi edit; bentrok dari `apply_remote_version` saat sesi edit lalu `record_saved_version` (dua kepala), `summary.conflict == true`; `resolve_conflict` mengembalikan ke satu kepala; gabung manual (sesi dengan dua induk) menyelesaikan bentrok; `record_saved_version` dengan hash sama tidak membuat versi; idempoten `apply_remote_*`; tanda edit rekan kedaluwarsa; izin tamu; migrasi dari v2 mempertahankan data.

## 4. Kontrak tampilan dan inti Rust

Command (argumen camelCase, error `{ code, message }`):

| Command | Argumen | Hasil |
|---|---|---|
| `list_documents` | `{ projectId: string \| null }` | `DocumentSummary[]` (urut nama) |
| `get_document` | `{ documentId }` | `DocumentDetail` |
| `add_documents` | `{ paths: string[], projectId: string \| null }` | `DocumentSummary[]` (yang baru) |
| `start_edit` | `{ documentId, fromVersionId: string \| null }` | `DocumentSummary` (membuka Office) |
| `finish_edit` | `{ documentId }` | `DocumentSummary` |
| `open_read_only` | `{ documentId, versionId: string \| null }` | `null` (null = versi sekarang) |
| `restore_version` | `{ documentId, versionId }` | `DocumentSummary` |
| `resolve_conflict` | `{ documentId, keepVersionId }` | `DocumentSummary` |
| `export_version` | `{ documentId, versionId: string \| null, destination: string }` | `null` (Simpan salinan) |

Event: `mira://documents` (isi `{ documentId }`), dikirim setelah versi baru, sesi edit mulai/selesai, pulihkan, selesaikan bentrok, tambah file. Tampilan cukup memuat ulang.

```ts
type DocumentKind = "word" | "excel" | "pdf" | "other";
type VersionOrigin = "added" | "edited" | "restored" | "resolved";
type PersonRef = { publicKey: string; displayName: string; isMe: boolean };
type DocumentVersion = {
  id: string;
  number: number;               // seq lokal
  size: number;
  blobHash: string;
  author: PersonRef;
  createdAt: string;
  origin: VersionOrigin;
  restoredFromNumber: number | null;
  parentIds: string[];
  isHead: boolean;
  received: boolean;            // datang dari rekan
  available: boolean;           // isinya ada di laptop ini
};
type EditingInfo = { editor: PersonRef; since: string; local: boolean; lastSavedAt: string | null };
type DocumentSummary = {
  id: string;
  name: string;
  kind: DocumentKind;
  projectId: string | null;
  teamId: string | null;
  createdAt: string;
  createdBy: PersonRef;
  current: DocumentVersion;     // kepala dengan nomor tertinggi
  versionCount: number;
  conflict: boolean;            // lebih dari satu kepala
  conflictVersions: DocumentVersion[]; // kepala-kepala saat bentrok (nomor turun), kosong kalau tidak
  editing: EditingInfo[];       // sesi lokal dulu, lalu tanda rekan yang masih segar
  can: { edit: boolean; restore: boolean; resolve: boolean; export: boolean };
};
type DocumentDetail = DocumentSummary & { versions: DocumentVersion[] }; // nomor turun
```

## 5. Tampilan (tugas D)

`src/screens/docs/DocsScreen.tsx` (export sama) dan komponen di folder itu; `src/api/documents.ts`. Shell tidak diubah.

- Kepala halaman: judul "Dokumen", keterangan pustaka "Umum" (belum ada proyek), tombol utama "Tambah file" (dialog pilih banyak file lewat `@tauri-apps/plugin-dialog`).
- Daftar file: ikon per jenis (Tabler `file-word`, `file-spreadsheet`, `file-type-pdf`, `file`), nama, baris status:
  - biasa: "Versi 3 · Diubah Anda 10.15" (waktu relatif dari `format.ts`)
  - diedit di laptop ini: "Sedang Anda edit di Word sejak 10.15", ikon kunci
  - diedit rekan: "Sedang diedit Rekan C sejak 10.15"
  - bentrok: "Bentrok: versi 4 dan 5 tersimpan berdampingan", warna peringatan dari token
- Tombol di baris: "Edit di Word" / "Edit di Excel" (jenis lain: "Buka"), saat diedit lokal: "Buka lagi" dan "Selesai mengedit"; saat diedit rekan: "Buka hanya baca".
- Panel detail file terpilih: riwayat versi (nomor, inisial penulis, asal: "Ditambahkan", "Disimpan dari Word", "Dipulihkan dari versi 1", "Bentrok diselesaikan", penulis dan waktu), tombol per versi: "Buka" (hanya baca), "Simpan salinan", "Pulihkan" (bukan untuk versi sekarang; konfirmasi dulu).
- Bentrok: kotak penjelasan singkat di panel detail, dua kepala berdampingan dengan "Pakai versi ini" dan "Gabung manual" (Word/Excel).
- Keadaan kosong: penjelasan singkat + "Tambah file". Error lewat `ErrorAlert` yang sudah ada. Muat ulang saat event `mira://documents` dan saat jendela kembali fokus.
- Token warna dari tema, tanpa warna langsung; fokus terlihat; target klik cukup besar; semua teks bahasa Indonesia tanpa em dash. Wajib memuat skill antislop (`antislop`, `antislop-ui`, `antislop-human`, `antislop-copywriting`) dan cek kontras dengan `check_contrast`.
- Tes Vitest dengan API tiruan: daftar dan status, bentrok, pulihkan dengan konfirmasi, tambah file, error.

## 6. Tugas dan pembagian file

Gelombang 1 (paralel, satu worktree, file tidak bersinggungan):

| Tugas | File milik | Isi |
|---|---|---|
| A. Blob store | `src-tauri/src/blobs/**` | implementasi + tes (termasuk proptest bila perlu) |
| B. Pemantau Office | `documents/office.rs`, `documents/watch.rs` | pola nama, debounce, notify, tes integrasi pola simpan |
| C. Model dokumen | `documents/{mod,kinds,store,access,sync,schema}.rs` | model, graf versi, bentrok, izin, titik sambung, tes |
| D. Tampilan | `src/screens/docs/**`, `src/api/documents.ts` | layar Dokumen + Vitest |

Gelombang 2: E. `documents/{session,runtime,commands}.rs`, `lib.rs`, `capabilities/default.json` (`dialog:allow-open`, `dialog:allow-save`), tes integrasi alur edit (salinan kerja, simpan, versi, selesai, pemulihan saat start).

Gelombang 3: review Rust dan review tampilan (paralel), perbaikan, uji ujung ke ujung (`scripts/smoke-docs-e2e.mjs`, Excel/Word lewat COM), screenshot terang dan gelap, laporan.

## 7. Selesai berarti

`cargo test` dan Vitest lulus; alur tambah file, buka, simpan, versi baru, pulihkan berjalan di satu laptop dengan screenshot terang dan gelap di `docs/progress/screenshots/`; laporan `docs/progress/tahap-4-lokal.md`; semua di-commit di branch ini.
