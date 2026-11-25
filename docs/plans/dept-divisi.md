# Rencana dan kontrak: Departemen saya dan Divisi

Branch `claude/dept-divisi-7c07a6`, dari `main` a45d1b3 (v0.5.0). Laporan: `docs/progress/dept-divisi.md`.

Permintaan user: "untuk admin department, apakah sudah ada modul untuk setting2 departmentnya? seperti role dll", "gw mau ada juga user nya bisa bikin group division sendiri, nanti bisa atur divisionya sendiri, seperti IT developer divisi mobile gitu", "harusnya yang bisa bikin division itu admin per department nya masing2", "u atur yang terbaiknya gimana".

## 1. Ringkasan keputusan

- Struktur: Organisasi, Departemen, Divisi. Satu orang satu departemen; boleh di lebih dari satu divisi di departemennya.
- Peran tetap: Superadmin, Admin departemen, Kepala divisi, Anggota, Tamu. Tidak ada peran kustom. Label keahlian tetap untuk sebutan jabatan.
- Divisi dibuat, diganti nama, diarsipkan oleh admin departemen di departemennya, atau superadmin di departemen mana pun. Anggota biasa tidak membuat divisi (Grup chat tetap bisa).
- Admin departemen menunjuk satu atau lebih kepala divisi. Kepala divisi menambah dan mengeluarkan anggota divisinya (hanya orang aktif bukan Tamu dari departemen yang sama) dan mengatur chat divisinya.
- Admin departemen boleh mengangkat dan melepas admin departemen lain di departemennya sendiri (target harus sudah orang departemen itu). Admin terakhir tidak bisa melepas dirinya; superadmin boleh. Semua tercatat di log dan tampil sebagai riwayat di tab.
- Pindah departemen (`team_move`), keluar dari departemen (`team_member_remove`), dikeluarkan (`member_remove`): keanggotaan divisi di departemen lama lepas di fold. Dinonaktifkan (sesi lain): tampilan dan audiens chat menyaring orang tidak aktif, dan helper `leave_divisions` tersedia untuk dipanggil dari jalur nonaktif saat digabung.
- Setiap divisi punya chat grup otomatis `ch:<division id>` di bagian Departemen sidebar, di bawah channel departemennya. Tidak bisa diarsipkan atau dihapus sendiri; ikut arsip divisi (hanya baca).
- Pengaturan chat (channel departemen dan chat divisi): catatan disematkan (teks, paling panjang 500 karakter) dan mode pengumuman (hanya pengelola yang boleh menulis). Disimpan sebagai op log keanggotaan, bukan record chat, supaya tidak bentrok dengan perubahan chat sesi lain dan terlihat semua anggota departemen.
- Proyek bisa dibuat atas nama divisi: anggota bawaan = anggota divisi saat dibuat (tidak ikut berubah setelahnya), bisa ditambah orang lain seperti biasa.
- Pemetaan OU AD: baris boleh menyebut divisi (di dalam departemen baris itu). Saat admin menyetujui permintaan ber-AD, laptop admin menulis `division_member_add` untuk divisi hasil pemetaan OU terdalam, dalam transaksi yang sama.
- Gerbang versi `DIVISION_SINCE = "0.6.0"` (pola `min()` sama dengan `JOIN_AD_SINCE`): semua op baru, pengangkatan admin oleh admin departemen, proyek divisi, dan pemetaan OU dengan divisi hanya ditulis kalau semua anggota aktif (Tamu juga) melaporkan versi paling sedikit ambang itu. Tab menampilkan laptop yang belum diperbarui.

## 2. Op baru (log keanggotaan, `permissions/op.rs`)

Semua ber-scope `org`. Id divisi 32 hex acak, dicatat di `used_ids`.

| type | field | Siapa |
|---|---|---|
| `division_create` | `division`, `team`, `name` | superadmin, admin departemen `team` |
| `division_rename` | `division`, `name` | superadmin, admin departemen divisi itu |
| `division_archive` | `division`, `archived: bool` | superadmin, admin departemen divisi itu |
| `division_head_set` | `division`, `member`, `head: bool` | superadmin, admin departemen divisi itu |
| `division_member_add` | `division`, `member` | superadmin, admin departemen, kepala divisi itu |
| `division_member_remove` | `division`, `member` | superadmin, admin departemen, kepala divisi itu, orangnya sendiri |
| `chat_settings_set` | `team`, `division: Option`, `pinned: String`, `announce: bool` | team: superadmin, admin departemen. division: itu ditambah kepala divisi |

Perubahan op lama (field opsional baru, `#[serde(default, skip_serializing_if = "Option::is_none")]`, jadi bentuk lama sama byte demi byte):
- `project_create.division: Option<String>`: divisi pemilik proyek. Wajib `team == division.team`. Penulis harus anggota, kepala divisi itu, admin departemennya, atau superadmin. Divisi diarsipkan ditolak.
- `OuMapping.division: Option<String>` (di `crate::ad`): divisi di departemen `team`.

Aturan fold (deterministik, `permissions/division.rs` berisi fungsi `apply_*` yang dipanggil dari `fold.rs`):
- Nama divisi: aturan nama departemen (`is_canonical_team_name`). Nama tidak harus unik.
- `division_create`: departemen terbuka (`require_open_team`), id belum dipakai.
- `division_rename`: `NoChange` kalau sama. Divisi diarsipkan boleh diganti nama.
- `division_archive`: `NoChange` kalau sama. Anggota dan kepala tetap tercatat (riwayat); divisi diarsipkan tidak menerima anggota/kepala baru dan chatnya hanya baca.
- `division_head_set head=true`: target aktif bukan Tamu dan anggota departemen divisi itu; menjadi anggota divisi sekaligus kalau belum. `AlreadyDivisionHead` kalau sudah. `head=false`: `NotDivisionHead` kalau bukan; orangnya tetap anggota divisi.
- `division_member_add`: divisi tidak diarsipkan, target aktif bukan Tamu, target di departemen divisi itu (`TargetNotInDepartment`), `AlreadyInDivision`.
- `division_member_remove`: `NotInDivision`. Kepala divisi hanya boleh mengeluarkan orang yang bukan kepala; mengeluarkan kepala hanya admin departemen atau superadmin (atau dirinya sendiri).
- `chat_settings_set`: `pinned` 0 sampai 500 karakter (baris baru boleh, karakter kendali lain tidak, tanpa spasi di awal/akhir), `NoChange` kalau sama. Departemen terhapus: `TeamNotFound`. Disimpan per `(team, division)`, terakhir menang, dengan `at` op.
- `team_admin_set` oleh admin departemen: target sudah anggota departemen itu (tidak menarik orang dari departemen lain atau tanpa departemen), `AlreadyTeamAdmin`.
- `team_admin_unset` oleh admin departemen: target admin departemen itu; kalau target dirinya sendiri dan dia admin terakhir, `LastTeamAdmin`. Melepas admin lain tidak memeriksa jumlah (yang melepas tetap admin).
- Efek op lama: `team_move` melepas orang dari semua divisi di luar departemen tujuannya; `team_member_remove` melepas dari divisi departemen itu; `member_remove` dari semua divisi; `team_delete` menandai semua divisinya `deleted` dan mengosongkan anggotanya.

Alasan penolakan baru (`Reason`, teks Indonesia di Rust, teks Inggris di `src/i18n/errors-rust.*`): `division_not_found`, `division_archived`, `already_in_division`, `not_in_division`, `already_division_head`, `not_division_head`, `target_not_in_department`, `last_team_admin`.

## 3. Aturan bersamaan (`causal.rs`)

- Hak baru `Right::DivisionHead(division, member)` dan `Right::AllDivisionHeads(division)`.
- Pencabutan baru: `division_head_set head=false` (mengambil `DivisionHead`), `division_member_remove` atas seorang kepala (mengambil `DivisionHead`), `division_archive archived=true` (mengambil `AllDivisionHeads`). `team_move` juga mengambil `DivisionHead` di divisi departemen lama; `team_member_remove` dan `member_remove` sudah tercakup lewat `Member`/aturan lama atau ditambah eksplisit.
- `rights_used`: op divisi oleh admin departemen pakai alternatif `TeamAdmin(team)`; oleh superadmin `Superadmin`; oleh kepala `DivisionHead(division)`. `team_admin_set/unset` kini `one_of(superadmin, team admin)`.
- Kasus yang dites: kepala divisi dicopot bersamaan dengan dia menambah anggota (tambahan ditolak `concurrent_with_revocation`); orang dipindah departemen bersamaan ditambah ke divisi (hasil akhirnya tidak di divisi, apa pun urutannya); dua admin departemen saling melepas (satu menang, deterministik, departemen tetap punya admin).

## 4. Data turunan (migrasi v11, `permissions/division.rs` menulis)

```sql
CREATE TABLE divisions (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, name TEXT NOT NULL,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE division_members (division_id TEXT NOT NULL, public_key TEXT NOT NULL,
  head INTEGER NOT NULL DEFAULT 0, added_at TEXT NOT NULL, added_by TEXT NOT NULL,
  PRIMARY KEY (division_id, public_key));
CREATE TABLE chat_settings (team_id TEXT NOT NULL, division_id TEXT NOT NULL DEFAULT '',
  pinned TEXT NOT NULL DEFAULT '', announce INTEGER NOT NULL DEFAULT 0, set_at TEXT NOT NULL,
  set_by TEXT NOT NULL, PRIMARY KEY (team_id, division_id));
ALTER TABLE projects ADD COLUMN division_id TEXT;
```

`store::write_derived` memanggil `division::write_derived_divisions(conn, state)` (satu baris). Nomor migrasi bisa bentrok dengan sesi lain; session utama menomori ulang saat menggabung.

## 5. Command Tauri (`src-tauri/src/division_commands.rs`, TypeScript `src/api/division.ts`)

Semua mutasi memakai pola `mutate` (`net_backend::after_change`). Nama argumen camelCase di sisi TS.

- `dept_overview(teamId: string | null) -> DeptOverview | null` (null kalau tidak berhak). `teamId` null: departemen sendiri, atau departemen pertama yang boleh dikelola.
- `division_create(teamId, name) -> string` (id)
- `division_rename(divisionId, name)`, `division_archive(divisionId, archived)`
- `division_set_head(divisionId, publicKey, head)`
- `division_add_member(divisionId, publicKey)`, `division_remove_member(divisionId, publicKey)`
- `dept_set_admin(teamId, publicKey, admin)`
- `chat_settings_set(teamId, divisionId | null, pinned, announce)`
- `conversation_settings(conv) -> ConversationSettings | null`: untuk banner di chat.
- `my_divisions() -> DivisionRef[]`: divisi orang ini (untuk dialog Proyek baru), plus divisi yang ia kelola.

```ts
type DivisionRole = "head" | "member";
type DivisionRef = { id: string; name: string; teamId: string; teamName: string; archived: boolean };
type DeptMember = {
  publicKey: string; displayName: string; fingerprint: string;
  isSuperadmin: boolean; isAdmin: boolean; isMe: boolean; online: boolean;
  labels: { id: string; name: string }[];
  divisions: { id: string; name: string; role: DivisionRole }[];
  appVersion: string | null;
};
type DivisionView = {
  id: string; name: string; archived: boolean; createdAt: string;
  members: { publicKey: string; displayName: string; role: DivisionRole }[];
  canManage: boolean;      // admin departemen atau superadmin: ganti nama, arsip, kepala
  canEditMembers: boolean; // canManage atau kepala divisi ini
  conv: string;            // "ch:<id>"
  settings: ChatSettingsView;
};
type DeptProject = { id: string; name: string; divisionId: string | null; divisionName: string | null;
  members: { publicKey: string; displayName: string }[] };
type ChatSettingsView = { pinned: string; announce: boolean; setAt: string | null; setByName: string | null };
type AdminEvent = { at: string; byName: string; targetName: string; admin: boolean; status: "applied" | "rejected" };
type DeptOverview = {
  teamId: string; teamName: string; archived: boolean;
  choices: { id: string; name: string }[]; // departemen yang boleh dipilih (superadmin: semua yang hidup)
  me: { publicKey: string; isSuperadmin: boolean; isAdmin: boolean; headOf: string[] };
  canManageDept: boolean;  // superadmin atau admin departemen ini
  members: DeptMember[];
  divisions: DivisionView[];
  projects: DeptProject[];
  channel: { conv: string; name: string; settings: ChatSettingsView };
  adminHistory: AdminEvent[]; // terbaru dulu, paling banyak 50
  gate: { open: boolean; since: string; blockers: { publicKey: string; name: string; appVersion: string | null }[] };
};
type ConversationSettings = { pinned: string; announce: boolean; canWrite: boolean; canEdit: boolean;
  teamId: string; divisionId: string | null };
```

`PersonView` (query.rs) mendapat `divisions: { id, name }[]` (divisi aktif yang tidak diarsipkan), dipakai profil dan daftar orang: "IT Department · Mobile, Web".

## 6. Chat divisi

- `chat::audience::Directory` memuat `divisions` dari tabel turunan. `Scope::Division(id)`. `resolve`: id yang ada di `divisions` (tidak terhapus) menjadi percakapan grup otomatis, nama = nama divisi, `scope_name` = nama departemen, `archived` = divisi diarsipkan.
- Audiens: anggota divisi yang aktif, bukan Tamu, dan masih di departemen divisi itu. Pengelola (`is_admin`): kepala divisi, admin departemennya, superadmin.
- Tidak bisa diarsipkan/dihapus lewat `channel_archive`/`channel_delete` (seperti chat proyek v0.4).
- Mode pengumuman: pesan dengan `at` >= `set_at` pengaturan pada percakapan yang `announce` ditolak (`chat_announce_only`) kecuali dari pengelola. Pesan yang dibuat sebelum mode aktif tetap diterima di semua laptop.
- Sidebar: bagian Departemen, item divisi tampil tepat di bawah channel departemennya (ikon grup, nama divisi). Banner catatan disematkan di atas percakapan; komposer diganti teks "Hanya pengelola yang bisa menulis di sini" kalau `canWrite` false.

## 7. Proyek divisi

- `create_project` board menerima `divisionId` opsional. Tim proyek = departemen divisi. Anggota awal = anggota divisi aktif + pilihan dialog.
- Dialog Proyek baru: pilihan "Untuk divisi" (divisi dari `my_divisions`), mengisi anggota otomatis. Kartu proyek dan Departemen saya menampilkan nama divisi.

## 8. Tab "Departemen saya" (Organisasi)

Tampil untuk superadmin, admin departemen, dan kepala divisi. Isi, dari atas:
1. Pemilih departemen (superadmin atau admin beberapa departemen).
2. Pemberitahuan gerbang versi kalau tertutup: daftar laptop yang belum diperbarui.
3. Anggota departemen: nama, label, peran, divisi, status online; aksi angkat/lepas admin (pengelola).
4. Divisi: daftar berbingkai, tiap divisi berisi kepala dan anggota; buat, ganti nama, arsipkan/pulihkan, tunjuk kepala, tambah/keluarkan anggota (kepala hanya di divisinya). Tombol "Buka chat".
5. Permintaan bergabung dan kode undangan departemen ini: memakai `JoinRequestsPanel` dan `InvitesPanel` yang ada dengan filter departemen (prop baru `teamId`), tanpa menggandakan logika.
6. Proyek departemen: nama, divisi, anggota, tautan "Buka di Board".
7. Pengaturan channel departemen (dan chat tiap divisi di kartu divisi): catatan disematkan, mode pengumuman.
8. Riwayat admin departemen.

Gaya kolom berbingkai v0.5.0 (`org.css`), fokus terlihat, tanpa em dash, teks Indonesia dan Inggris di `src/i18n/org-division.{id,en}.ts`.

## 9. Pembagian kerja (file milik tiap tugas)

| Tugas | File |
|---|---|
| Inti izin | `permissions/op.rs`, `fold.rs`, `causal.rs`, `division.rs` (baru), `mod.rs`, `store.rs` (1 baris), `db/migrations.rs`, `permissions/tests/division_tests.rs` (baru) |
| Command | `division_commands.rs` (baru), `lib.rs`, `permissions/query.rs` (field divisi), `device.rs` (`MIRA_TEST_APP_VERSION` debug) |
| Chat | `chat/audience.rs`, `chat/judge.rs`, `chat/view.rs`, `chat/service.rs` bila perlu, tes chat baru |
| Board | `board/commands.rs`, `board/store.rs`, `board/view.rs`, `permissions/org_actions.rs` (`register_own_project_in`) |
| AD | `ad/mod.rs` (`OuMapping`), `ad/dept.rs`, hook persetujuan di `org_actions.rs` (1 baris) |
| UI tab | `src/screens/org/MyDepartment*.tsx`, `OrgScreen.tsx` (tab), `src/api/division.ts`, `src/i18n/org-division.*` |
| UI lain | `src/screens/chat/` (bagian divisi, banner), `src/screens/board/NewProjectDialog.tsx`, profil/daftar orang, `AdSettings.tsx` |

## 10. Selesai berarti

`cargo test`, `cargo clippy --all-targets -- -D warnings`, `npx tsc --noEmit`, `npx vitest run` lulus; e2e baru `scripts/division-e2e.mjs`; `org-e2e`, `join-e2e`, `ad-e2e`, `chat-e2e`, `board-e2e`, `english-e2e`, `e2e-multi` lulus satu per satu; screenshot di `docs/progress/screenshots/dept-divisi/`; laporan `docs/progress/dept-divisi.md`.
