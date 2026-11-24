# Rencana dan kontrak: onboarding dengan Active Directory

Permintaan user: "setiap user baru install, awalnya dia pilih domain yang terdeteksi, misalnya kalau kantor gw macf.co.id. Setelah itu otomatis cek nama di pc mereka, kalau di kantor gw uda pasti pake LDAP, jadi tinggal ambil bagian department dan nama. Tapi untuk macbook ga pake LDAP, itu tetap request manual ke superadmin."

Tingkat yang dipilih: **A**. Data AD mengisi formulir otomatis, admin tetap menyetujui dengan satu klik. Tidak ada persetujuan otomatis.

Dasar: `docs/progress/v04-onboarding.md` (alur join v0.4, `extras`, syarat versi), `docs/plans/v0.3-kontrak.md` bagian 8, `docs/progress/v04-english.md` (kamus bertipe).

## 1. Alur

1. **Langkah nama.** Mira memanggil `join_ad_profile` (paling lama 4 detik, di thread terpisah). Kalau laptop memakai akun domain, isian nama terisi `displayName` AD dan di bawahnya tertulis sumbernya. Orangnya tetap bisa mengubah nama.
2. **Langkah kantor.** Kantor yang `adDomain`-nya sama dengan domain laptop tampil paling atas dan terpilih otomatis, ditandai "Domain kantor Anda: macf.co.id". Setelah kantor dipilih, `join_ad_suggest` memberi departemen usulan. Kotak "Yang dikirim ke admin" memperlihatkan nama, departemen, akun AD (`DOMAIN\user`), lokasi OU, dan keterangan.
3. **Kirim.** `join_send_request(..., useAd: true)` menambahkan klaim `ad` ke permintaan bertanda tangan, hanya kalau kantor menerima (`acceptsAd`) dan domain laptop sama dengan domain kantor.
4. **Kartu admin.** Kartu menampilkan blok AD dan memanggil `org_join_ad_check` saat tampil. Status: "Cocok dengan AD", "Tidak cocok: ...", "Akun AD dinonaktifkan", "Akun tidak ada di AD", "AD tidak bisa dihubungi dari laptop ini", "Laptop ini tidak di domain itu". Admin tetap menekan Setujui.
5. **Jalur manual** tetap sama persis: macOS, Windows tanpa domain, akun lokal di PC domain, AD tidak terhubung, pembacaan lambat atau gagal. Data yang sempat terbaca (misalnya domain dan username tanpa DN) tetap dipakai.

Cek ulang di laptop admin membuktikan akun itu **ada dan aktif** di AD dengan nama dan departemen yang sama. Cek ini **tidak** membuktikan bahwa peminta adalah pemilik akun itu (laptop peminta bisa mengaku akun siapa pun). Kode cocok dan telepon tetap cara memastikan orangnya. Persetujuan otomatis dengan bukti login Windows (tingkat B) ditunda.

## 2. Kompatibilitas dengan laptop v0.4.0

| Data | Jalur | Aman untuk v0.4.0 karena |
|---|---|---|
| `ad` di `JoinRequestPayload` | permintaan bertanda tangan, lalu disalin ke op `join_approve` | Hanya ditulis kalau semua anggota yang menjawab `join_info` membawa `extras >= 2`. Anggota hanya mengumumkan `extras: 2` kalau semua anggota aktif kantor (termasuk Tamu) melaporkan versi paling sedikit `min(versi sendiri, JOIN_AD_SINCE)`. v0.4.0 membandingkan `extras >= 1`, jadi 2 tetap berarti "terima keterangan". |
| `ad_domain`, `ad_ou_map` di `JoinInfoWire` | jawaban `join_info` | `JoinInfoWire` diurai tanpa `deny_unknown_fields`, field baru diabaikan laptop lama. |
| op `ad_settings_set` | log keanggotaan | Hanya bisa ditulis kalau syarat versi yang sama terpenuhi (`ad_settings_allowed`). Laptop lama tidak pernah menerima op ini selama ia masih anggota aktif. |
| Peminta Mira lama ke kantor yang sudah punya op `ad_settings_set` | `org_approve_join` | Ditolak dengan pesan jelas (peminta perlu memperbarui Mira dulu), karena laptopnya akan menolak op itu dan log keanggotaannya macet. Kartu sudah memperingatkan (`requesterOutdated`). |

`JOIN_AD_SINCE = "0.5.0"`. Selama build dev masih bernomor 0.4.0, ambangnya 0.4.0 (sama dengan pola `JOIN_EXTRAS_SINCE`), supaya e2e dengan build dev yang sama tetap menguji fitur ini. **Rilis berikutnya harus bernomor 0.5.0 atau lebih**; kalau 0.4.1, ambangnya 0.4.1, tetap aman.

## 3. Kontrak Rust

### 3.1 Modul baru `src-tauri/src/ad/`

```
ad/mod.rs     tipe bersama, read_local, lookup_user, machine_domain (milik R1)
ad/windows.rs implementasi Windows: GetComputerNameExW, GetUserNameExW, wldap32 (R1)
ad/fake.rs    data AD tiruan, hanya #[cfg(debug_assertions)] (R1)
ad/dn.rs      penguraian DN, escape filter LDAP, normalisasi domain (R2)
ad/dept.rs    usulan departemen dari atribut dan OU (R2)
ad/check.rs   pembandingan hasil cek ulang (R2)
```

```rust
// ad/mod.rs
pub const READ_TIMEOUT: Duration = Duration::from_secs(4);
pub const LOOKUP_TIMEOUT: Duration = Duration::from_secs(5);

/// Satu baris pemetaan OU ke departemen Mira (juga isi op ad_settings_set).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OuMapping { pub ou: String, pub team: String }

/// Akun domain yang login di laptop ini. Sebagian boleh kosong.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAd {
    pub domain: String,               // huruf kecil, "macf.co.id"
    pub user: Option<String>,         // sAMAccountName
    pub dn: Option<String>,
    pub display_name: Option<String>,
    pub department: Option<String>,   // atribut `department`
    pub complete: bool,               // false: sebagian (DC tidak terhubung, waktu habis)
}

/// Hasil pencarian akun di AD dari laptop admin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectoryUser {
    pub user: String, pub dn: String,
    pub display_name: Option<String>, pub department: Option<String>,
    pub disabled: bool,               // userAccountControl & 0x2
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LookupError { NotDomainMachine, OtherDomain { mine: String }, Unreachable, NotFound }

pub fn machine_domain() -> Option<String>;                          // cepat, tanpa jaringan
pub async fn read_local(timeout: Duration) -> Option<LocalAd>;       // None: bukan akun domain / macOS
pub async fn lookup_user(domain: &str, user: &str, timeout: Duration)
    -> Result<DirectoryUser, LookupError>;
```

Pembacaan nyata berjalan di `spawn_blocking` dan dibatasi `tokio::time::timeout`. Waktu habis di `read_local` mengembalikan data yang sudah terbaca (`complete: false`) kalau ada, kalau tidak `None`. Waktu habis di `lookup_user` menjadi `Unreachable`.

**AD tiruan (hanya build debug dan tes).** `MIRA_FAKE_AD` berisi JSON atau path ke file JSON. File dibaca ulang di setiap panggilan, supaya skrip e2e bisa mengubahnya di tengah uji. Di build release modul `fake` tidak dikompilasi dan variabel itu tidak pernah dibaca.

```json
{
  "machineDomain": "macf.co.id",
  "local": { "domain": "macf.co.id", "user": "rina", "dn": "CN=rina,OU=...,DC=macf,DC=co,DC=id",
             "displayName": "Rina Wijaya", "department": "Keuangan" },
  "localPartial": false,
  "localDelayMs": 0,
  "reachable": true,
  "users": { "rina": { "dn": "CN=rina,...", "displayName": "Rina Wijaya", "department": "Keuangan", "disabled": false } }
}
```

`local: null` berarti akun lokal (bukan domain). `machineDomain: null` berarti PC tanpa domain. `localPartial: true` membuang `dn`, `displayName`, `department` dan memberi `complete: false`. `localDelayMs` lebih besar dari waktu tunggu menguji jalur waktu habis. `reachable: false` membuat `lookup_user` menjawab `Unreachable`.

### 3.2 `ad/dn.rs`

```rust
pub struct Rdn { pub attr: String /* huruf besar */, pub value: String /* tanpa escape */ }
pub fn parse_dn(dn: &str) -> Option<Vec<Rdn>>;   // RFC 4514, termasuk \, \+ \" \\ \< \> \; \= \# dan \2C
pub fn ous(dn: &str) -> Vec<String>;             // OU dari paling dalam ke luar
pub fn domain_of(dn: &str) -> Option<String>;    // DC=macf,DC=co,DC=id -> "macf.co.id"
pub fn escape_filter_value(s: &str) -> String;   // RFC 4515: * ( ) \ NUL
pub fn normalize_domain(s: &str) -> Option<String>; // trim, huruf kecil, buang titik akhir, label 1..63 [a-z0-9-], total <= 253, minimal 2 label
pub const MAX_DN_CHARS: usize = 512;
```

### 3.3 `ad/dept.rs`

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeptSource { Attribute, AttributeMap, OuMap, OuName }

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeptSuggestion {
    pub team_id: Option<String>,
    pub source: Option<DeptSource>,
    /// Label AD yang ditampilkan: atribut `department`, atau OU paling dalam kalau atribut kosong.
    pub ad_department: Option<String>,
    /// team_id ditemukan.
    pub in_mira: bool,
}

/// departments: (id, nama) departemen Mira yang terbuka.
pub fn suggest(department: Option<&str>, dn: Option<&str>,
               departments: &[(String, String)], map: &[OuMapping]) -> DeptSuggestion;
pub fn same_text(a: &str, b: &str) -> bool;  // NFC, huruf kecil, spasi diringkas, trim
```

Urutan: (1) atribut `department` sama dengan nama departemen Mira; (2) atribut sama dengan kunci di pemetaan; (3) untuk tiap OU dari paling dalam ke luar: kunci pemetaan, lalu nama departemen Mira. Pemetaan ke departemen yang tidak ada atau diarsipkan diabaikan. Tidak pernah membuat departemen.

### 3.4 `ad/check.rs`

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AdCheckStatus { Match, Mismatch, Disabled, NotFound, Unreachable, OtherDomain, NotDomainMachine }

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdCheckMismatch { pub field: AdField /* "name" | "department" */, pub requested: String, pub directory: String }

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdCheck {
    pub status: AdCheckStatus,
    pub mismatches: Vec<AdCheckMismatch>,
    pub directory_name: Option<String>,
    pub directory_department: Option<String>,
    /// Departemen hasil AD ada di Mira (false: "belum ada di Mira").
    pub department_in_mira: bool,
    pub checked_at: String,          // RFC 3339
}

pub fn compare(requested_name: &str, requested_team: &str, requested_team_name: &str,
               entry: &DirectoryUser, departments: &[(String, String)], map: &[OuMapping],
               checked_at: String) -> AdCheck;
pub fn from_error(err: &LookupError, checked_at: String) -> AdCheck;
```

Nama: `same_text(requested_name, display_name)` kalau `display_name` ada. Departemen: `suggest(entry.department, entry.dn)`; kalau `team_id` ada dan beda dengan `requested_team`, itu tidak cocok; kalau tidak ditemukan di Mira, bukan tidak cocok, tapi `department_in_mira: false`. `disabled` menang atas status lain (ketidakcocokan tetap diisi).

### 3.5 Izin dan protokol (agen P)

- `permissions/join.rs`: `JoinAdClaim { domain: String, user: String, dn: Option<String>, name: Option<String>, department: Option<String> }` (`deny_unknown_fields`, opsional tidak boleh `null`, `skip_serializing_if`). `JoinRequestPayload.ad: Option<JoinAdClaim>` setelah `account`, sebelum `at`. `JoinExtras.ad: Option<JoinAdClaim>`. Validasi: domain `normalize_domain(d) == Some(d)`; user 1..=64 karakter, tanpa `"/\[]:;|=,+*?<>@` dan karakter terlarang join; dn <= `MAX_DN_CHARS`, `parse_dn` berhasil, `domain_of(dn) == domain`, tanpa karakter terlarang; name dan department seperti `is_short_text(.., 64)`. `JOIN_AD_SINCE = "0.5.0"`, `join_ad_allowed(state)`, `ad_blockers(state) -> Vec<(member, name, Option<app_version>)>`.
- `network/mod.rs`: `JOIN_INFO_EXTRAS_AD: u32 = 2`; `JoinInfoWire.ad_domain: Option<String>` dan `ad_ou_map: Vec<OuMapping>` (`default`, dilewati kalau kosong).
- `permissions/op.rs`, `fold.rs`, `causal.rs`, `org_actions.rs`: `Body::AdSettingsSet { domain: String, ou_map: Vec<OuMapping> }`, jenis `ad_settings_set`, hanya superadmin. `domain` kosong berarti tidak ada. Paling banyak 100 baris, OU 1..=64 karakter, OU unik tanpa beda huruf besar, team 32 hex dan ada di state. Fold menulis `OrgState.ad: AdSettings { domain: Option<String>, ou_map: Vec<OuMapping> }` (yang terakhir menang). `set_ad_settings(conn, identity, domain, ou_map)` menolak kalau bukan superadmin atau `ad_settings_allowed` belum terpenuhi.
- `approve_join`: kalau `state.ad` pernah diisi op dan versi peminta di bawah ambang, tolak dengan `InvalidInput` berpesan jelas.
- `permissions/join_store.rs`: `JoinInfo` membawa `ad_domain`, `ad_ou_map`, `accepts_ad`; `receive_join_request` dan penyimpanan record terusan menolak `ad` kalau `join_ad_allowed` belum terpenuhi. `JoinRequestView.ad: Option<JoinAdView>` dan `JoinRequestView.requester_outdated: bool`. `OutgoingJoinRequest.ad: Option<JoinAdClaim>`.
- `net_backend.rs`: `join_info` mengisi `extras` 2/1/0 dan field AD.

```rust
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct JoinAdView {
    pub domain: String, pub user: String, pub dn: Option<String>,
    pub name: Option<String>, pub department: Option<String>,
    pub ous: Vec<String>,                 // dari dn, paling dalam dulu
    pub suggested_team_id: Option<String>,
    pub department_in_mira: bool,
}
```

### 3.6 Command Tauri baru atau berubah

| Command | Argumen | Hasil | Pemilik |
|---|---|---|---|
| `join_ad_profile` | | `LocalAd \| null` (disimpan di `JoinClient` setelah dibaca sekali) | Q |
| `join_ad_suggest` | `officeKey` | `DeptSuggestion \| null` (null kalau tidak ada AD lokal atau domain beda) | Q |
| `join_send_request` | `+ useAd: boolean` | seperti sebelumnya | Q |
| `create_organization` | `name, adDomain?: string \| null` | seperti sebelumnya; tulis `ad_settings_set` kalau domain diisi | Q |
| `machine_ad_domain` | | `string \| null` | Q |
| `org_ad_settings` | | `AdSettingsView` | A |
| `org_set_ad_settings` | `domain: string, ouMap: OuMapping[]` | `null` | A |
| `org_join_ad_check` | `requestId, refresh: boolean` | `AdCheck` (disimpan 2 menit per permintaan) | A |

`FoundOffice` bertambah `adDomain: string | null`, `acceptsAd: boolean`.

```rust
#[serde(rename_all = "camelCase")]
pub struct AdSettingsView {
    pub domain: Option<String>, pub ou_map: Vec<OuMapping>,
    pub can_edit: bool,                    // superadmin
    pub allowed: bool,                     // syarat versi terpenuhi
    pub outdated: Vec<OutdatedLaptop>,     // { name, appVersion: Option }
    pub machine_domain: Option<String>,
}
```

## 4. Kontrak TypeScript

Lihat `src/api/join.ts`, `src/api/org.ts`, `src/api/index.ts` (tipe sudah ditulis di kerangka). Teks baru masuk kamus: onboarding di `src/i18n/onboarding.{id,en}.ts`, kartu admin di `org-requests.{id,en}.ts`, pengaturan AD di `org-departments.{id,en}.ts`, pesan galat Rust di `errors-rust.{id,en}.ts`.

## 5. Pembagian kerja

| Agen | Fase | File |
|---|---|---|
| R1 pembaca AD | 1 | `ad/mod.rs` (isi fungsi), `ad/windows.rs`, `ad/fake.rs`, `Cargo.toml` |
| R2 logika murni | 1 | `ad/dn.rs`, `ad/dept.rs`, `ad/check.rs` |
| P protokol | 1 | `permissions/*` (kecuali tes lain), `network/mod.rs`, `network/join.rs`, `net_backend.rs`, `errors-rust.*.ts` |
| U1 onboarding | 1 | `src/screens/onboarding/*`, `src/i18n/onboarding.*.ts` |
| U2 org | 1 | `src/screens/org/JoinRequestsPanel*`, `DepartmentsPanel*`, `AdSettings*`, css org, `src/test/orgFixtures.ts`, `src/i18n/org-requests.*.ts`, `src/i18n/org-departments.*.ts` |
| E e2e | 1 menulis, 3 menjalankan | `scripts/ad-e2e.mjs`, `scripts/e2e-onboarding.mjs` |
| Q peminta | 2 | `join_commands.rs`, `commands.rs`, `org/mod.rs` |
| A admin | 2 | `org_commands.rs`, `lib.rs` |

Fase 2 mulai setelah P, R1, R2 selesai. E2e dijalankan satu per satu di fase 3.

## 6. Tambahan lingkup: satu domain, satu kantor

Dari session utama (user setuju: "kalau 1 domain harusnya 1 organisasi yang sama"). Temuan: laptop user tanpa sengaja membuat organisasi kedua karena laptop Mira 0.1.0/0.2.0 mengumumkan TXT `org` tanpa `on` dan `j`, lalu pencarian hanya bertanya ke petunjuk dengan `j`, sehingga onboarding menulis "Kantor belum ditemukan" dan pilihan kantor baru terbuka.

1. **Kantor versi lama tetap terlihat.** `JoinSearch.legacyOffices`: petunjuk mDNS dengan `org` tapi tanpa `j` (dan bukan org yang sudah terverifikasi lewat `join_info`), dikelompokkan per org id, dengan nama dari TXT `on` kalau ada. Layar onboarding menampilkannya sebagai kantor yang ditemukan tapi belum bisa menerima permintaan, dengan langkah: minta superadmin atau rekan memperbarui Mira, atau pakai kode undangan.
2. **Cegah kantor kedua.** Kalau kantor Mira apa pun terlihat (`orgSeen`, termasuk versi lama), pilihan kantor baru di "Untuk admin IT" dan `--siapkan-kantor` (yang kini mencari dulu beberapa detik) menampilkan peringatan yang menyebut kantor yang ada, menyarankan bergabung, dan meminta konfirmasi ketik ulang. Kalau domain AD laptop sama dengan `adDomain` kantor yang terlihat, pilihan kantor baru disembunyikan dan orang diarahkan ke kantor itu; `create_organization` juga menolak di Rust kalau `JoinClient` mengenal kantor terverifikasi dengan domain AD sama dengan domain mesin.
3. **Peringatan kantor lain.** Anggota yang tergabung mengumumkan TXT `ad=<domain>` kalau kantornya punya domain AD (kunci baru, laptop lama mengabaikannya). `org_other_offices` menghitung laptop yang mengumumkan org id lain (dan yang domain AD-nya sama). Halaman Organisasi menampilkan pemberitahuan ringan "Ada N laptop di jaringan ini yang tergabung di kantor Mira lain". Hanya petunjuk, tanpa sinkron.
4. Tes unit dan skenario e2e untuk ketiganya.

| Bagian | Pemilik |
|---|---|
| `legacyOffices` di `search`, penolakan `create_organization` | Q |
| TXT `ad`, `org_other_offices` | A (`network/discovery.rs`, `org_commands.rs`) |
| Tampilan onboarding (kantor lama, peringatan kantor baru, `--siapkan-kantor` mencari dulu) | U1 |
| Pemberitahuan di Organisasi | U2 (`OrgScreen.tsx` atau panel baru) |

### 6.1 Tambahan: kantor otomatis dari domain

User bertanya kenapa organisasi tidak otomatis saja dari domain. Keputusan session utama: satu domain satu kantor, tapi pembuatan kantor tetap sekali oleh admin IT (pembuatnya menjadi superadmin, dan tanpa server dua laptop bisa membuat kantor bersamaan).

1. PC Windows dengan akun domain yang melihat **tepat satu** kantor dengan domain AD sama: kantor itu langsung dipakai tanpa langkah memilih kantor, tetap tampil di ringkasan "Kantor: MCF (macf.co.id)" dengan tombol Ubah. Langkah pilih kantor hanya untuk Mac, PC tanpa domain, atau kalau ada lebih dari satu kandidat.
2. Kantor baru di "Untuk admin IT": nama bawaan diisi domain AD (misalnya `macf.co.id`, bisa diubah) dan domain AD kantor terisi otomatis.
3. Lebih dari satu kantor dengan domain AD sama: yang genesis-nya paling awal (`FoundOffice.createdAt`, dari genesis bertanda tangan) disebut "kantor utama" dan terpilih bawaan. Superadmin kantor yang lebih baru mendapat peringatan di Organisasi (`OtherOfficesView.olderSameDomain`, A menanyakan `join_info` ke laptop yang mengumumkan org lain dengan TXT `ad` sama lalu memverifikasi genesis-nya), dengan penjelasan bahwa data tidak bisa digabung otomatis.

Pemilik: `createdAt` di `FoundOffice` (Q), `olderSameDomain` (A), tampilan onboarding (U1), peringatan Organisasi (U2).
