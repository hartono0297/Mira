# Rencana: perbaikan bergabung (0.5.1)

Dua masalah dari pemakaian v0.5.0: (A) data AD tidak dipakai tanpa penjelasan, (B) laptop yang dikeluarkan terjebak di layar dengan "Periksa lagi" yang tidak berbuat apa-apa. Laporan: `docs/progress/perbaikan-bergabung.md`.

## Keputusan

1. **Nonaktifkan vs keluarkan permanen.** Op baru `member_suspend` dan `member_reinstate`. Op `member_remove` tetap berarti keluar permanen, dan kini juga berlaku untuk orang yang sedang nonaktif.
2. **Siapa boleh.** Superadmin boleh menonaktifkan, mengaktifkan lagi, dan mengeluarkan permanen siapa pun (superadmin terakhir tidak bisa dinonaktifkan atau dikeluarkan). **Admin departemen boleh menonaktifkan dan mengaktifkan lagi anggota biasa departemennya sendiri** (bukan admin, bukan superadmin, bukan Tamu), mengikuti aturan lama `team_member_remove` v0.2 (admin boleh mengeluarkan anggota non-admin dari departemennya). Keluar permanen tetap hanya superadmin.
3. **Yang terjadi saat nonaktif.** Orang itu keluar dari departemen, proyek, label, dan akses Tamu, dan kehilangan status superadmin, persis seperti `member_remove`, tapi fold menyimpan **cuplikan** (departemen dan perannya, superadmin, proyek, label, akses Tamu). `member_reinstate` mengembalikan cuplikan itu sejauh masih berlaku (departemen terbuka, proyek ada, label ada, tim akses Tamu hidup). Jadi semua pemeriksaan izin yang ada (yang memakai `is_active` dan keanggotaan departemen/proyek) otomatis menolak orang nonaktif.
4. **Bersamaan.** `member_suspend` adalah pencabutan (mengambil `Right::Member(target)`), sama dengan `member_remove`. `member_reinstate` bergantung pada `Right::Member(target)`, jadi reinstate yang bersamaan dengan suspend lain atau `member_remove` orang yang sama ditolak (pencabutan menang).
5. **Gerbang versi.** `SUSPEND_SINCE = "0.5.1"`, ambang `min(versi sendiri, SUSPEND_SINCE)` seperti `JOIN_AD_SINCE`. `member_suspend` hanya ditulis kalau semua anggota aktif (Tamu juga) melaporkan versi itu; layar menampilkan laptop yang menghalangi. `member_reinstate` tidak digerbang (kalau sempat nonaktif, gerbang sudah terbuka; menahan reinstate malah membuat orang terjebak).
6. **Sinkron untuk laptop nonaktif.** Laptop nonaktif tetap boleh tersambung untuk **sinkron log keanggotaan saja**: hanya op ber-scope org. Tidak ada stream fitur, blob, permintaan bergabung, atau op tim. Laptop nonaktif sendiri juga tidak membuka atau melayani sinkron fitur.
7. **Reset laptop yang dikeluarkan permanen.** Command `reset_removed_laptop` hanya jalan kalau keanggotaan laptop ini `removed`. Jaringan dihentikan, kunci laptop ini di Credential Manager/Keychain dihapus (hanya entri `device-key-<pk laptop ini>`), seluruh isi folder data organisasi dihapus kecuali preferensi tampilan (bahasa, tema), lalu Mira membuat kunci baru dan kembali ke onboarding tanpa restart.
8. **"Laptop ini pernah dikeluarkan pada ..."** Bukti bertanda tangan kunci lama **tidak** dibuat: butuh field baru di permintaan bergabung, dan laptop 0.5.0 mengurai permintaan dengan `deny_unknown_fields`, jadi perlu gerbang versi lagi. Sebagai gantinya kartu admin memberi petunjuk kalau akun AD atau nama laptop peminta sama dengan anggota yang dikeluarkan atau nonaktif. Petunjuk, bukan bukti.
9. **Alasan AD di onboarding** dihitung di frontend dari data yang sudah ada (`adDomain`, `acceptsAd`) plus satu field baru `ad_outdated` di `join_info`.
10. Versi aplikasi **tidak** dinaikkan di branch ini; session utama menaikkan ke 0.5.1 saat rilis. Selama build dev masih 0.5.0, ambang `min()` membuat laptop 0.5.0 rilis dianggap cukup baru (catatan yang sama dengan onboarding-ad).

## Kontrak Rust

### Op (`permissions/op.rs`)

```rust
Body::MemberSuspend { member: String }    // kind "member_suspend", scope org, member key64
Body::MemberReinstate { member: String }  // kind "member_reinstate", scope org, member key64
```

### Fold (`permissions/fold.rs`)

- `MemberStatus::Suspended`, `as_str() == "suspended"`. `is_active` tetap hanya `Active`.
- `MemberState` tambah `suspended_at: Option<String>`, `suspended_by: Option<String>`, `suspension_op: Option<String>`, `snapshot: Option<SuspendSnapshot>`.
- `pub struct SuspendSnapshot { department: Option<(String, TeamRole)>, superadmin: bool, projects: Vec<String>, labels: Vec<String>, guest_access: Vec<GuestAccess> }`.
- `member_suspend`: target harus `Active` (kalau tidak `TargetNotActive`); superadmin terakhir `LastSuperadmin`; izin: superadmin, atau admin departemen target kalau target anggota biasa non-Tamu non-superadmin di departemen itu (kalau tidak `NotAuthorized`). Buat cuplikan, lalu lepaskan seperti `member_remove`, status `Suspended`.
- `member_reinstate`: target harus `Suspended` (kalau tidak `Reason::TargetNotSuspended`, kode `target_not_suspended`, pesan "Orang itu tidak sedang dinonaktifkan."). Izin: superadmin, atau admin departemen dari cuplikan kalau cuplikan berperan `Member` dan bukan superadmin. Status `Active`, kembalikan cuplikan, hapus field nonaktif.
- `member_remove`: target `Active` **atau** `Suspended`; untuk `Suspended` status jadi `Removed`, cuplikan dibuang.

### Kausal (`permissions/causal.rs`)

- `is_revocation`: tambah `MemberSuspend`.
- `rights_used`: `MemberSuspend` = `one_of(sa, by_admin, dept target)`; `MemberReinstate` = `all += Right::Member(target)`, `any = one_of(sa, by_admin, dept cuplikan)`.
- `rights_taken`: `MemberSuspend { member }` = `[Right::Member(member)]`.

### Store dan gerbang

- `Membership::Suspended` (`membership()` mengembalikannya untuk status `Suspended`).
- `PeerAuthState::Suspended { display_name: String }`; `peer_auth` mengembalikannya.
- `may_receive(state, peer, scope_team, author)`: peer `Suspended` hanya menerima `scope_team == None`. `op_ids_for`/`ops_for` mengikuti.
- `permissions::join`: `SUSPEND_SINCE`, `suspend_threshold()`, `suspend_allowed(&OrgState)`, `suspend_blockers(&OrgState) -> Vec<AdBlocker>` (tipe yang sama, anggota aktif di bawah ambang).
- Aksi: `suspend_member(conn, identity, pk, now)`, `reinstate_member(...)`; `remove_member` yang ada menerima target nonaktif. `suspend_member` menolak dengan `AppError::Invalid` kalau gerbang tertutup: "Ada laptop yang belum diperbarui ke Mira 0.5.1: <nama, ...>. Perbarui dulu, lalu coba lagi."

### Command (didaftarkan di `lib.rs`)

| Command | Argumen | Hasil |
|---|---|---|
| `org_suspend_member` | `publicKey` | `null` |
| `org_reinstate_member` | `publicKey` | `null` |
| `org_remove_member` | `publicKey` | `null` (keluar permanen; aktif atau nonaktif) |
| `org_suspend_gate` | | `{ allowed: bool, outdated: [{ name, appVersion }] }` |
| `check_membership` | | `{ membership, checkedAt, peersReached }` (sinkron op dengan semua laptop yang tersambung, tunggu paling lama 4 detik) |
| `reset_removed_laptop` | | `AppState` baru (sama dengan `get_app_state`) |

### View

- `UserView` (`org_users`): `status: "active" | "suspended" | "removed"`, tambah `suspendedAt: string | null`, `suspendedByName: string | null`, `canSuspend: bool`, `canReinstate: bool`, `canRemove: bool` (untuk laptop yang melihat).
- `MemberView.status` dan `PersonView`/`MemberView` di direktori: tambah `"suspended"`.
- `AppState.membership`: `"none" | "active" | "suspended" | "removed"`.
- `NetState`: tambah `"suspended"`.
- `JoinRequestView`: tambah `previouslyRemoved: { name: string; status: "suspended" | "removed"; at: string; match: "ad_account" | "laptop" } | null`.

### join_info

- `JoinInfo` (permissions/join_store.rs): `ad_outdated: Option<u32>`, jumlah anggota aktif di bawah ambang AD. Laptop 0.5.1 selalu mengisi `Some(n)`.
- `JoinInfoWire` (network/mod.rs): `#[serde(default, skip_serializing_if = "Option::is_none")] ad_outdated: Option<u32>`. Laptop lama mengabaikannya; laptop baru membaca `None` dari laptop lama.
- `FoundOffice` (TS): `adOutdated: number | null`, maksimum dari laptop yang menjawab; `null` kalau tidak ada yang melaporkan.

## Kontrak jaringan (`network/`, `net_backend.rs`)

- `PeerAuth::Suspended { display_name }`. Koneksi dari laptop nonaktif diterima tapi **tidak didaftarkan** di peta peer biasa: tidak muncul di `connected_peers()`, tidak memicu `feature_peer_up`, tidak menerima push fitur. Koneksi itu hanya melayani sesi `SyncHave` dengan `op_ids_for` (op org saja), menolak stream lain dengan kode `NOT_MEMBER`, dan ditutup setelah sesi atau diam 60 detik.
- Saat anggota yang tersambung menjadi nonaktif (`recheck_peers`), laptop rekan mengirim op `member_suspend` lewat push `Removed { op }` yang sudah ada (penerima hanya meng-ingest op), lalu menutup dengan kode baru `SUSPENDED`.
- Laptop yang keanggotaannya sendiri `Suspended`: tetap menjalankan jaringan, terus mencoba tersambung ke rekan (penutupan `SUSPENDED` tidak menghentikan percobaan), hanya meminta dan melayani sinkron op, tidak membuka atau menerima stream fitur, dan tidak menyimpan data fitur yang datang. `get_network_status` melaporkan `suspended`.
- Begitu op `member_reinstate` masuk dan keanggotaan kembali `Active`, jaringan dan fitur berjalan normal tanpa restart (`after_change`/event `mira://directory` seperti biasa).

## Kontrak frontend

- `src/api/types.ts`, `src/api/org.ts`, `src/api/join.ts`, `src/api/index.ts`: tipe dan fungsi di atas (`orgApi.suspendMember`, `reinstateMember`, `removeMember`, `suspendGate`; `api.checkMembership`, `api.resetRemovedLaptop`).
- `App.tsx`: `membership === "suspended"` menampilkan `SuspendedScreen`; `"removed"` menampilkan `RemovedScreen`.
- `SuspendedScreen`: judul "Akun Anda di <kantor> sedang dinonaktifkan", "Hubungi IT atau superadmin kantor. Mereka bisa mengaktifkan Anda lagi.", sidik jari laptop, tombol "Periksa lagi" dengan hasil terlihat ("Dicek 14.20: masih nonaktif"), cek otomatis tiap 20 detik, dan begitu `active` kembali ke Shell tanpa restart.
- `RemovedScreen`: penjelasan, tombol "Reset dan mulai dari awal", dialog konfirmasi (data organisasi lama di laptop ini dihapus, laptop mendapat kunci baru, kembali ke layar awal untuk meminta bergabung lagi).
- Organisasi > Pengguna: status Nonaktif jelas, aksi "Nonaktifkan", "Aktifkan lagi", "Keluarkan permanen" sesuai `canSuspend/canReinstate/canRemove`; pilihan Nonaktifkan atau Keluarkan permanen di dialog Ubah/Keluarkan; gerbang versi tampil.
- Onboarding langkah 2: satu baris alasan kalau data AD terbaca tapi tidak dipakai. Urutan: (1) AD tidak terbaca: diam; (2) `acceptsAd` false: "Ada laptop di kantor ini yang belum diperbarui ke Mira 0.5..."; (3) `adDomain` null: "Kantor ini belum mengatur domain AD..."; (4) domain beda: "Domain kantor (x) berbeda dengan domain akun Anda (y)..."; (5) departemen AD tidak cocok: "Departemen Anda di AD (X) belum dicocokkan oleh admin...".
- Organisasi (superadmin, laptop domain, kantor tanpa domain AD, gerbang terbuka): tawaran "Pakai macf.co.id sebagai domain AD kantor ini?" satu klik.
- Kartu Permintaan bergabung (superadmin): "Cocokkan OU ini ke departemen..." menambah baris pemetaan OU lewat `orgApi.setAdSettings` lalu memuat ulang kartu. Petunjuk `previouslyRemoved`.

## Pembagian kerja (file tidak boleh tumpang tindih)

| Bagian | File |
|---|---|
| R1 izin | `src-tauri/src/permissions/**`, `org_commands.rs`, `team_commands.rs`, `src/i18n/errors-rust.*` |
| R2 jaringan | `src-tauri/src/network/**`, `net_backend.rs`, `net_backend_tests.rs`, `network_commands.rs`, `join_commands.rs`, `join_sync.rs` |
| R3 reset | `src-tauri/src/identity/**`, `reset_commands.rs`, `state.rs`, `paths.rs` |
| F1 layar status | `src/App.tsx`, `src/screens/RemovedScreen.tsx`, `src/screens/SuspendedScreen.tsx`, `src/screens/status.css`, `src/screens/StatusScreens*.tsx`, `src/i18n/status.*` |
| F2 Pengguna | `src/screens/org/UsersPanel*`, `users.css`, `src/i18n/org-users.*` |
| F3 onboarding | `src/screens/onboarding/**`, `src/i18n/onboarding.*` |
| F4 AD admin | `src/screens/org/JoinRequestsPanel*`, `AdSettings*`, `OrgScreen*`, `requests.css`, `ad-settings.css`, `src/i18n/org-ad.*`, `org-requests.*`, `org.*` |
| Kerangka (session) | `src/api/**`, `lib.rs`, tipe dasar |
| E2E | `scripts/suspend-e2e.mjs`, `scripts/ad-reason-e2e.mjs` |

## Tes wajib

- Fold: suspend/reinstate/remove-dari-nonaktif, izin superadmin dan admin departemen, superadmin terakhir, cuplikan dikembalikan sebagian kalau departemen diarsipkan atau proyek hilang, op lama `member_remove` tetap permanen.
- Bersamaan: suspend vs reinstate, reinstate vs `member_remove`, dua superadmin saling menonaktifkan, op orang nonaktif yang bersamaan dengan suspend ditolak, shortcut sama dengan fold penuh.
- `may_receive`/`op_ids_for`: peer nonaktif hanya op org; peer dikeluarkan tidak menerima apa pun.
- Jaringan: laptop nonaktif tersambung, menerima op org, tidak menerima op tim, chat, board, dokumen, tanda tangan, blob; aktif lagi lalu fitur jalan.
- Reset: hanya untuk `removed`, kunci lama terhapus dari keystore uji, folder data bersih, preferensi tampilan tetap, kunci baru.
- E2E: `suspend-e2e.mjs` (nonaktifkan, layar nonaktif, Periksa lagi, aktifkan lagi tanpa restart, keluarkan permanen, reset, bergabung lagi), `ad-reason-e2e.mjs` (alasan AD dengan `MIRA_FAKE_AD`, tawaran domain, cocokkan OU).
