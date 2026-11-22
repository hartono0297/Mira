# Rencana implementasi Tahap 3 (bagian lokal): Board dasar

Tanggal: 22 November 2026. Branch `claude/tahap-3-board-lokal-38babd`. Sumber: `design/rencana-pembangunan.html` (Tahap 3), `design/prd-mira.html` (F-TASK-01 s.d. 06, F-UI-01 s.d. 04, tabel izin, bagian 9), `design/brainstorming.html` (mockup board dan detail task), `design/tema-c.html` (token warna dan mockup board), `docs/plans/tahap-0.md`, `docs/plans/tahap-1.md`.

## Tujuan

Di satu laptop, tanpa jaringan: membuat proyek dengan kode sendiri (misalnya `PA`), board per proyek dengan kolom To do, Dikerjakan, Selesai, task dengan kode `PA-12`, detail task (judul, deskripsi, penanggung jawab, tenggat, prioritas, label, komentar, riwayat aktivitas), pindah task antar kolom lewat drag-and-drop dan lewat keyboard, halaman "Task saya" lintas proyek, dan pengingat tenggat lewat notifikasi Windows (sehari sebelum dan di hari tenggat, menyusul saat laptop dinyalakan, bisa diatur per orang).

Data board per proyek adalah satu dokumen Automerge. Setiap perubahan lokal adalah satu change Automerge yang ditandatangani kunci laptop dan disimpan di SQLite, jadi log ini siap dikirim ke rekan saat jaringan board disambung.

Bukan lingkup: kirim dan terima lewat jaringan, chat (task dari pesan, F-TASK-03), dokumen, tanda tangan. Tanda "sudah digabung" (F-TASK-04) butuh perubahan dari laptop lain; datanya disiapkan (`merged` di kartu), tampilannya diuji dengan data tiruan.

## Keputusan desain

| Topik | Keputusan |
|---|---|
| Satu dokumen per proyek | Dokumen Automerge per proyek. Snapshot (`AutoCommit::save`) disimpan di `board_projects.doc` supaya cepat dibuka; log change bertanda tangan di `board_changes` adalah sumber kebenaran untuk sinkron. Keduanya ditulis dalam satu transaksi SQLite. |
| Actor Automerge | `ActorId` = 32 byte kunci publik laptop. Penerima bisa mencocokkan pembuat change dengan penanda tangan tanpa tabel tambahan. |
| Tanda tangan | Pesan = `"mira-board-v1\n"` + id proyek (32 hex, ASCII) + `"\n"` + bytes mentah change (`Change::raw_bytes`). Ed25519 kunci laptop, diverifikasi dengan `verify_strict`. Id change = hash Automerge (64 hex). |
| Kolom | Tetap: `todo` "To do", `doing` "Dikerjakan", `done` "Selesai". Kolom tambahan diatur admin di R3 (F-TASK-07). |
| Urutan kartu | Field `rank` (string, fractional index base-62) per task. Pindah = ubah `column` dan `rank`. Pindah bersamaan dari dua laptop: yang menang ditentukan Automerge (sama di semua laptop). |
| Nomor task | Penghitung `next_number` di dokumen. Di satu laptop selalu unik. Saat sinkron bisa muncul nomor ganda; aturan penomoran ulang dicatat sebagai titik sambung `board::sync::resolve_duplicate_numbers` (belum dipanggil). |
| Teks | Judul dan deskripsi disimpan sebagai `Text` Automerge (`update_text`), supaya edit bersamaan di deskripsi digabung per karakter. Komentar dan aktivitas adalah map/list yang hanya ditambah. |
| Prioritas dan label | PRD menaruhnya di R3 (F-TASK-07), tapi brief Tahap 3 memintanya. Dibuat versi sederhana: prioritas `none/low/medium/high`, label teks bebas (maks 10, maks 30 karakter). Label belum diatur admin. |
| Hapus task | Tandai `deleted = true` (tombstone), tidak dihapus dari dokumen, supaya edit bersamaan dari laptop lain tidak membangkitkan task setengah jadi. |
| Penanggung jawab | Lewat trait `AssigneeDirectory`. Implementasi lokal `LocalMembers`: diri sendiri ditambah anggota aktif non-tamu di tabel `members` (yang di Tahap 1 adalah hasil fold). Kalau proyek punya `team_id`, hanya anggota tim itu (ditambah diri sendiri). |
| Izin | Lewat trait `BoardPolicy`. Implementasi lokal `LocalRolePolicy` mengikuti tabel izin PRD sebisa mungkin dari data lokal: buat proyek = superadmin atau admin tim; buat, edit, pindah task, komentar = anggota aktif non-tamu; hapus task = pembuatnya, admin tim proyek itu, atau superadmin. |
| Tim | `team_id` boleh kosong. Proyek tanpa tim = proyek organisasi (sementara, sampai tim dipakai sungguhan). |
| Kode proyek | 2 sampai 6 karakter, huruf besar A-Z dan angka, diawali huruf, unik di laptop ini. Dibuat otomatis dari nama kalau tidak diisi (tampilan mengusulkan). |
| Tanggal tenggat | Tanggal saja, `YYYY-MM-DD`, tanpa jam. Hari dihitung dengan zona waktu Windows (`time` fitur `local-offset`). |
| Pengingat | Loop di inti Rust: saat start lalu setiap 15 menit. Untuk task milik saya, belum Selesai, belum dihapus: pengingat `day_before` kalau tenggat = besok, `due_day` kalau tenggat = hari ini atau sudah lewat dan `due_day` untuk tenggat itu belum dikirim (laptop mati saat itu). Catatan terkirim di `board_reminders_sent` per (task, jenis, tanggal tenggat), jadi ganti tenggat memunculkan pengingat lagi. Pengaturan per laptop di `settings`: `board.reminder.day_before` dan `board.reminder.due_day` (`on`/`off`, bawaan `on`). |
| Notifikasi | `tauri-plugin-notification` dari sisi Rust (tidak perlu izin JS). Pengiriman lewat trait `Notifier` supaya bisa dites. |
| Event | `mira://board` dipancarkan setelah setiap perubahan; tampilan memuat ulang. Cadangan polling 15 detik seperti layar Tahap 1. |

## Skema SQLite (satu entri migrasi baru, nomor final ditentukan saat merge)

File `src-tauri/src/board/schema.rs`, konstanta `BOARD_SCHEMA`, ditambahkan sebagai satu entri di akhir `MIGRATIONS`. Di branch ini nomornya v3 (setelah v2 Tahap 1).

```sql
CREATE TABLE board_projects (
    id         TEXT PRIMARY KEY CHECK (length(id) = 32),
    code       TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    team_id    TEXT,
    created_by TEXT NOT NULL CHECK (length(created_by) = 64),
    created_at TEXT NOT NULL,
    doc        BLOB NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE board_changes (
    hash          TEXT PRIMARY KEY CHECK (length(hash) = 64),
    project_id    TEXT NOT NULL REFERENCES board_projects (id) ON DELETE CASCADE,
    author        TEXT NOT NULL CHECK (length(author) = 64),
    seq           INTEGER NOT NULL,
    bytes         BLOB NOT NULL,
    sig           TEXT NOT NULL CHECK (length(sig) = 128),
    created_at    TEXT NOT NULL,
    received_at   TEXT NOT NULL,
    received_from TEXT
) STRICT;
CREATE INDEX board_changes_project ON board_changes (project_id, author, seq);

CREATE TABLE board_task_index (
    project_id TEXT NOT NULL REFERENCES board_projects (id) ON DELETE CASCADE,
    task_id    TEXT NOT NULL,
    code       TEXT NOT NULL,
    title      TEXT NOT NULL,
    column_id  TEXT NOT NULL,
    assignee   TEXT,
    due        TEXT,
    deleted    INTEGER NOT NULL,
    PRIMARY KEY (project_id, task_id)
) STRICT;
CREATE INDEX board_task_index_assignee ON board_task_index (assignee, deleted);

CREATE TABLE board_reminders_sent (
    project_id TEXT NOT NULL,
    task_id    TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('day_before', 'due_day')),
    due        TEXT NOT NULL,
    sent_at    TEXT NOT NULL,
    PRIMARY KEY (project_id, task_id, kind, due)
) STRICT;
```

`board_task_index` adalah turunan dokumen (ditulis ulang untuk satu proyek setiap kali dokumennya berubah), dipakai "Task saya" dan pengingat supaya tidak perlu membuka semua dokumen.

## Bentuk dokumen Automerge

```
ROOT
  v: 1 (int)
  project: { id, code, name, team_id (str atau null) }
  next_number: int
  tasks: Map<task_id (32 hex)> {
    number: int, title: Text, description: Text,
    column: "todo"|"doing"|"done", rank: str,
    assignee: str (64 hex) atau null, due: "YYYY-MM-DD" atau null,
    priority: "none"|"low"|"medium"|"high", labels: List<str>,
    created_by: str, created_at: str, updated_at: str, deleted: bool,
    comments: Map<comment_id> { author, at, body },
    activity: List<{ at, actor, kind, detail }>
  }
```

Jenis aktivitas (`kind`): `created`, `title`, `description`, `moved`, `assignee`, `due`, `priority`, `labels`, `deleted`, `commented`. `detail` berisi teks pendek untuk tampilan (misalnya nama kolom tujuan).

## Kontrak command Tauri (camelCase, error `{ code, message }`)

| Command | Argumen | Hasil |
|---|---|---|
| `board_list_projects` | | `ProjectSummary[]` |
| `board_create_project` | `name`, `code`, `teamId: string \| null` | `ProjectSummary` |
| `board_get_board` | `projectId` | `BoardView` |
| `board_create_task` | `projectId`, `input: NewTask` | `TaskDetail` |
| `board_get_task` | `projectId`, `taskId` | `TaskDetail` |
| `board_update_task` | `projectId`, `taskId`, `patch: TaskPatch` | `TaskDetail` |
| `board_move_task` | `projectId`, `taskId`, `columnId`, `index` (posisi di kolom tujuan setelah pindah, 0 = paling atas) | `BoardView` |
| `board_delete_task` | `projectId`, `taskId` | `null` |
| `board_add_comment` | `projectId`, `taskId`, `body` | `TaskDetail` |
| `board_my_tasks` | | `MyTask[]` |

Pengaturan pengingat memakai command yang sudah ada `get_setting` / `set_setting`.

Tipe (TypeScript, sama dengan serde di Rust):

```ts
type ColumnId = "todo" | "doing" | "done";
type Priority = "none" | "low" | "medium" | "high";
type Person = { publicKey: string; name: string };
type ProjectSummary = { id: string; code: string; name: string; teamId: string | null; openCount: number; taskCount: number; canManage: boolean };
type TaskCard = { id: string; code: string; title: string; columnId: ColumnId; assignee: Person | null; due: string | null; priority: Priority; labels: string[]; commentCount: number; merged: boolean };
type Column = { id: ColumnId; name: string; tasks: TaskCard[] };
type BoardView = { project: ProjectSummary; columns: Column[]; assignees: Person[]; me: string; canCreate: boolean };
type Comment = { id: string; author: Person; at: string; body: string };
type Activity = { at: string; actor: Person; kind: string; detail: string };
type TaskDetail = TaskCard & { projectId: string; description: string; createdBy: Person; createdAt: string; updatedAt: string; comments: Comment[]; activity: Activity[]; canEdit: boolean; canDelete: boolean };
type NewTask = { title: string; columnId?: ColumnId; description?: string; assignee?: string | null; due?: string | null; priority?: Priority; labels?: string[] };
type TaskPatch = { title?: string; description?: string; assignee?: string | null; due?: string | null; priority?: Priority; labels?: string[] };
type MyTask = { projectId: string; projectCode: string; projectName: string; task: TaskCard };
```

Di `TaskPatch`, field yang tidak ada = tidak diubah; `assignee: null` / `due: null` = dikosongkan (Rust: `Option<Option<String>>` dengan `#[serde(default, deserialize_with = ...)]`).

Kode error baru: `invalid_input` (`AppError::InvalidInput`). Yang lain memakai yang sudah ada: `not_found`, `forbidden`, `removed`.

## Titik sambung (untuk jaringan dan izin peran)

Semua di `src-tauri/src/board/`, didokumentasikan di laporan:

- `sign.rs`: `SignedChange { project_id, hash, author, seq, bytes, sig }`, `sign_change`, `verify_change` (cek tanda tangan, actor = penanda tangan, hash cocok, ukuran maksimal).
- `sync.rs`:
  - `trait BoardSyncHook { fn on_local_change(&self, project_id: &str, change: &SignedChange); }`. Implementasi sekarang `NoopSync`. Nanti: kirim ke rekan yang boleh menerima (tim proyek).
  - `fn changes_since(conn, project_id, have_heads: &[String]) -> AppResult<Vec<SignedChange>>` untuk menjawab permintaan rekan.
  - `fn apply_remote_changes(conn, policy, project_id, from_peer, changes) -> AppResult<ApplyReport>`: verifikasi tanda tangan dan izin, simpan, gabung ke dokumen, tulis ulang indeks. Sudah dites dengan dua database lokal.
  - `fn resolve_duplicate_numbers(...)`: belum diisi; aturan penomoran ulang untuk nomor task ganda setelah sinkron.
- `policy.rs`: `trait BoardPolicy { fn check(&self, conn, actor: &str, action: &BoardAction) -> AppResult<()>; }`, `LocalRolePolicy`. Tahap 1 bisa menggantinya dengan pemeriksaan dari hasil fold (`permissions::OrgState`), termasuk Tamu per proyek.
- `assignees.rs`: `trait AssigneeDirectory { fn assignable(&self, conn, project) -> AppResult<Vec<Person>>; fn name_of(&self, conn, pk) -> String; }`, `LocalMembers`.
- `reminder.rs`: `trait Notifier`, `trait ReminderSource`, `fn due_reminders(...)` (murni), loop.

## Tugas dan pembagian

File tidak tumpang tindih, jadi dikerjakan paralel oleh empat subagent. Sesi utama menyiapkan kerangka dulu: dependensi Cargo (`automerge 0.12`, `tauri-plugin-notification 2`, fitur `local-offset` di `time`, `proptest` untuk tes), `board/schema.rs`, entri migrasi, kerangka `board/mod.rs`, `src/api/board.ts`, dan `src/screens/board/format.ts`.

### R1. Inti board (subagent, TDD). File: `src-tauri/src/board/**` kecuali `reminder.rs`; satu varian di `error.rs`; baris `generate_handler!` di `lib.rs`
- R1.1 `model.rs`: tipe serde, validasi (nama, kode proyek, judul, deskripsi, label, komentar, tanggal). Tes setiap batas.
- R1.2 `doc.rs`: buat dokumen proyek, baca task/kartu/detail dari dokumen, mutasi (buat, ubah, pindah dengan rank, hapus, komentar) yang menambah aktivitas. Tes unit.
- R1.3 `sign.rs`: tanda tangan dan verifikasi. Tes: tanda tangan rusak, actor lain, hash tidak cocok.
- R1.4 `store.rs`: simpan proyek, change, snapshot, indeks dalam satu transaksi; muat dokumen; daftar proyek; Task saya. Tes: buka ulang database, change tersimpan dan terverifikasi, snapshot = hasil replay semua change.
- R1.5 `policy.rs`, `assignees.rs`. Tes untuk peran.
- R1.6 `sync.rs`. Tes: dua laptop (dua database, dua kunci) mengubah task yang sama secara offline (judul di satu, deskripsi dan kolom di yang lain), bertukar change, hasil sama tanpa data hilang. Proptest: urutan operasi acak di dua sisi, setelah bertukar change dokumen sama. Change dengan tanda tangan salah atau dari yang tidak berhak ditolak dan dicatat.
- R1.7 `commands.rs`: command Tauri sesuai kontrak, fungsi biasa yang bisa dites tanpa runtime Tauri, memancarkan `mira://board`. Tes alur dan bentuk JSON.

### R2. Pengingat tenggat (subagent, TDD). File: `src-tauri/src/board/reminder.rs`
- Logika murni `due_reminders`, penyimpanan `board_reminders_sent`, pengaturan per orang, `Notifier` dan `ReminderSource`, loop tokio. Tes: besok, hari ini, sudah lewat saat laptop mati, sudah dikirim, tenggat berubah, task selesai atau dihapus, pengaturan mati.

### U1. Layar board (subagent, muat skill antislop). File: `src/screens/board/BoardScreen.tsx`, `ProjectBoard.tsx`, `NewProjectDialog.tsx`, `board.css`, tes
- Sub-navigasi Board: "Task saya" dan daftar proyek, tombol "Proyek baru". Board tiga kolom, kartu sesuai mockup, tambah task cepat per kolom, drag-and-drop HTML5, alternatif keyboard (tombol "Pindahkan" per kartu dengan pilihan kolom dan posisi, pengumuman `aria-live`), keadaan kosong, memuat, error.

### U2. Detail task dan Task saya (subagent, muat skill antislop). File: `src/screens/board/TaskDetail.tsx`, `MyTasks.tsx`, `ReminderSettings.tsx`, `task.css`, tes
- Detail task sebagai dialog: edit judul, deskripsi, status, penanggung jawab, tenggat, prioritas, label, komentar, riwayat aktivitas, hapus dengan konfirmasi, tanda "sudah digabung".
- Task saya: dikelompokkan Terlambat, Hari ini, Besok, Minggu ini, Nanti, Tanpa tenggat; pengaturan pengingat.

### Integrasi (sesi utama)
- `lib.rs`: plugin notifikasi, loop pengingat, `BoardSyncHook`.
- Review Rust dan review tampilan oleh subagent terpisah, perbaiki temuan.
- `cargo test`, `npm test`, `npm run build`, jalankan aplikasi dengan `MIRA_DATA_DIR` di folder scratch, screenshot terang dan gelap.
