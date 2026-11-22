# Rencana implementasi Tahap 1: Jaringan dan tim

Tanggal: 22 November 2026. Sumber: `design/rencana-pembangunan.html` (Tahap 1, arsitektur, risiko), `design/prd-mira.html` Draft 1.2 (F-ID-03, F-NET-01 s.d. 06, F-ROLE-01 s.d. 05, F-ROLE-08 s.d. 12, tabel izin, alur "Menyiapkan organisasi" dan "Bergabung ke tim", bagian 9, Lampiran A), `design/brainstorming.html` (mockup undangan, "Di jaringan", status koneksi), `docs/progress/tahap-0.md` ("Belum dicek" dan "Catatan untuk Tahap 1").

## Tujuan

Beberapa laptop (atau beberapa instance di satu PC lewat `MIRA_DATA_DIR`) saling menemukan, tersambung lewat QUIC yang terenkripsi dan diautentikasi dua arah dengan kunci Ed25519 laptop, dan menyinkronkan daftar anggota, tim, dan peran. Orang baru masuk lewat kode undangan yang bisa diperiksa laptop mana pun yang online. Anggota yang dikeluarkan berhenti menerima data. Laptop yang baru online lagi menerima perubahan yang terlewat.

## Ringkasan desain

```
Tampilan React ── command dan event Tauri ── commands.rs
                                              │
                ┌─────────────────────────────┼───────────────────────────┐
                │                             │                           │
        permissions/ (log keanggotaan)   network/ (QUIC, mDNS,        platform: firewall.rs,
        ops bertanda tangan, fold,        jabat tangan, sinkron,       window_theme.rs, qr.rs,
        undangan, direktori               gabung, status)              keystore Windows
                │                             │
                └──────── net_backend.rs (adapter, sesi utama) ───────┘
                                  │
                              SQLite (migrasi v2)
```

Hanya `network/` yang bicara dengan laptop lain. `network/` tidak mengenal SQLite: ia memanggil trait `SyncBackend`, yang diimplementasikan oleh `net_backend.rs` di atas `permissions/` dan `peers/`.

## 1. Log keanggotaan bertanda tangan (`permissions/`)

### 1.1 Satu perubahan = satu "op"

Setiap perubahan keanggotaan adalah op yang ditandatangani kunci laptop pembuatnya. Bentuk di kabel dan di database:

```json
{ "payload": "<string JSON persis seperti ditandatangani>", "sig": "<128 hex>" }
```

- Pesan yang ditandatangani: bytes UTF-8 dari `"mira-op-v1\n"` diikuti `payload` apa adanya. Karena bytes `payload` disimpan dan dikirim persis, tidak perlu kanonikalisasi JSON.
- `op id` = hex BLAKE3 dari bytes `payload` (64 hex). Op bersifat content-addressed, jadi menerima op yang sama dua kali tidak berpengaruh (perlindungan replay di tingkat data).
- Verifikasi memakai `VerifyingKey::verify_strict` (ed25519-dalek), jadi tanda tangan tidak bisa dimodifikasi.
- Batas ukuran `payload`: 16 KiB.

Isi `payload` (field tak dikenal ditolak, `deny_unknown_fields`):

```json
{
  "v": 1,
  "org": "<id organisasi, 32 hex>",
  "author": "<kunci publik pembuat, 64 hex>",
  "lamport": 12,
  "at": "2026-11-22T08:15:00Z",
  "nonce": "<32 hex acak>",
  "scope": { "kind": "org" },
  "body": { "type": "team_create", "team": "<32 hex>", "name": "Tim Desain" }
}
```

- `lamport` = (lamport tertinggi yang diketahui laptop pembuat) + 1. Urutan op = `(lamport, author, id)`. Op yang dibuat setelah melihat op lain selalu berurutan sesudahnya, walaupun jam laptop berbeda.
- `at` hanya untuk tampilan dan masa berlaku undangan. Op dengan `at` lebih dari 10 menit di masa depan menurut jam penerima ditolak saat diterima (bisa diterima lagi nanti).
- `scope`: `{"kind":"org"}` atau `{"kind":"team","team":"<32 hex>"}`. Semua op direktori ber-scope org. `channel_create` ber-scope team.

### 1.2 Jenis op dan siapa yang berhak

Status dihitung ulang dari nol (fold) dengan menerapkan semua op tersimpan sesuai urutan. Op yang pembuatnya tidak berhak pada posisinya ditandai `rejected` beserta alasannya, tidak berpengaruh, tapi tetap disimpan (bisa menjadi sah kalau op yang lebih awal datang belakangan). Semua laptop dengan himpunan op yang sama menghitung status yang sama.

Titik awal fold: record genesis organisasi (Tahap 0). Pendiri = superadmin pertama dan anggota aktif.

| `body.type` | Field | Yang berhak (dan syarat) |
|---|---|---|
| `profile_set` | `name` | Diri sendiri, anggota aktif |
| `team_create` | `team`, `name` | Superadmin. Id tim belum pernah dipakai |
| `team_delete` | `team` | Superadmin. Tim ada dan belum dihapus |
| `superadmin_add` | `member` | Superadmin. Target anggota aktif, bukan Tamu, belum superadmin |
| `superadmin_remove` | `member` | Superadmin. Target superadmin, dan tersisa minimal 1 superadmin |
| `team_admin_set` | `team`, `member` | Superadmin. Tim hidup, target anggota aktif bukan Tamu. Target jadi admin tim (ditambahkan ke tim kalau belum) |
| `team_admin_unset` | `team`, `member` | Superadmin. Target admin tim itu. Target jadi anggota biasa tim |
| `team_member_add` | `team`, `member` | Superadmin, atau admin tim itu. Target anggota aktif bukan Tamu, belum di tim |
| `team_member_remove` | `team`, `member` | Superadmin; admin tim itu kalau target bukan admin; atau diri sendiri (keluar dari tim) |
| `member_remove` | `member` | Superadmin. Target aktif. Kalau target superadmin, tersisa minimal 1 superadmin. Target kehilangan semua tim, peran, dan akses |
| `invite_create` | `invite`, `team`, `role`, `projects`, `expires`, `single_use`, `tag`, `key` | Superadmin untuk tim mana pun dan peran apa pun; admin tim untuk timnya dengan peran `member` atau `guest`. `expires` > `at` dan paling lama `at` + 7 hari + 5 menit. `guest` wajib punya `projects` (1 sampai 50 id 32 hex); peran lain wajib `projects` kosong |
| `invite_revoke` | `invite` | Superadmin, pembuat undangan, atau admin tim undangan itu |
| `invite_accept` | `invite`, `member`, `name`, `invite_sig`, `member_sig` | Anggota aktif bukan Tamu (laptop yang memeriksa kode, termasuk diri sendiri kalau sudah anggota). Syarat di 1.3 |
| `channel_create` | `channel`, `team`, `name` | Scope `team` dengan tim yang sama. Superadmin atau anggota tim itu |

Peran yang ditampilkan per orang (`orgRole`): `superadmin` kalau superadmin; kalau tidak, `team_admin` kalau admin di minimal satu tim hidup; kalau tidak, `guest` kalau masuk sebagai Tamu; selain itu `member`.

Channel `#umum` tidak butuh op: id-nya ditentukan dari organisasi (`blake3("mira-channel-umum-v1\n" + org_id)`, 32 hex pertama) dan dibuat oleh fold. Saat membuat tim, laptop superadmin juga membuat op `channel_create` ber-scope tim untuk channel tim (nama channel = nama tim, huruf kecil, spasi jadi `-`).

Validasi format setiap field (wajib, karena data datang dari laptop lain): id 32 hex huruf kecil, kunci 64 hex huruf kecil, tanda tangan 128 hex, `at` dan `expires` RFC 3339, nama tim 2 sampai 60 karakter dengan aturan karakter yang sama seperti nama organisasi dan sudah dipangkas (`validate(x) == x`), nama tampilan sama dengan aturan Tahap 0, `role` salah satu dari `team_admin`, `member`, `guest`, `tag` 8 karakter Crockford base32.

### 1.3 Kode undangan

- Kode: 100 bit acak, ditulis sebagai 20 karakter Crockford base32 dalam 5 kelompok: `ABCD-EFGH-JKMN-PQRS-TVWX`. Saat dimasukkan, huruf kecil, spasi, dan tanda `-` diterima; `I`/`L` dibaca `1`, `O` dibaca `0`.
- `tag` = 8 karakter pertama (40 bit), dipakai laptop lain untuk mencari undangan.
- Kunci undangan: `seed = blake3::derive_key("mira invite key v1", kode_20_karakter_ternormalisasi)`, lalu `SigningKey::from_bytes(seed)`. Kunci publiknya disimpan di `invite_create.key`. Kode sendiri tidak pernah disimpan atau dikirim: hanya ditampilkan sekali ke pembuatnya. Sisa 60 bit rahasia membuat tebakan offline dari kunci publik tidak masuk akal.
- Pesan tebusan: `"mira-invite-redeem-v1\n{org}\n{invite}\n{member}\n{name}"`. `invite_sig` = tanda tangan kunci undangan, `member_sig` = tanda tangan kunci laptop yang bergabung, keduanya atas pesan yang sama.
- Syarat `invite_accept` sah: undangan ada dan sah; belum dicabut; `at` op ≤ `expires` dan ≥ `at` undangan dikurangi 5 menit; untuk sekali pakai, belum ada `invite_accept` sah sebelumnya untuk undangan itu; pembuat undangan masih berhak membuat undangan itu pada posisi ini; tim masih hidup; kedua tanda tangan sah; `name` valid.
- Efek: orang itu jadi anggota aktif (jenis `member`, atau `guest` untuk undangan Tamu) dan masuk tim dengan peran `admin` (undangan `team_admin`) atau `member`. Tamu tidak masuk tim, tapi mendapat akses ke proyek di `projects`. Kalau sudah anggota, ia ditambahkan ke tim atau perannya dinaikkan.
- Masa berlaku di tampilan: "24 jam" (berkali-kali sampai kedaluwarsa), "7 hari" (berkali-kali), "Sekali pakai" (satu orang, berlaku paling lama 7 hari).
- Dua laptop yang terpisah jaringan bisa sama-sama menerima satu kode sekali pakai. Setelah log digabung, hanya `invite_accept` pertama dalam urutan yang sah; yang lain ditandai ditolak. Ini dicatat sebagai batasan.

### 1.4 Batasan data per tim (F-ROLE-04)

`may_receive(op, peer)` di laptop pengirim, dengan status terbaru:
- Peer bukan anggota aktif: tidak menerima apa pun (koneksi ditolak).
- Op ber-scope `org` (direktori: anggota, tim, peran, undangan): semua anggota aktif.
- Op ber-scope `team`: anggota tim itu (peran apa pun), atau pembuat op itu sendiri.

Keputusan: direktori organisasi (siapa anggota, tim apa saja, siapa di tim mana, undangan yang belum dipakai beserta kunci publiknya) dikirim ke semua anggota aktif, karena setiap laptop butuh rantai lengkap untuk memeriksa perubahan (F-ROLE-03, F-ROLE-12) dan agar laptop mana pun bisa memeriksa kode undangan. Isi tim (channel tim sekarang; chat, board, dan dokumen di tahap berikutnya) hanya dikirim ke anggota tim. Superadmin tidak otomatis menerima isi tim (F-ROLE-11) kecuali menambahkan dirinya ke tim, dan op itu tercatat di log.

### 1.5 Mengeluarkan anggota (F-ROLE-05)

Setelah `member_remove` atau tim dihapus: fold mencabut keanggotaan. Laptop lain menolak koneksi dari laptop itu (kecuali satu pesan terakhir berisi op `member_remove` supaya laptopnya tahu), menutup koneksi yang masih terbuka, tidak mengirim data lagi, dan op baru dari orang itu ditandai ditolak. Data yang sudah ada di laptopnya tidak bisa dihapus dari jauh (PRD bagian 12).

### 1.6 Perubahan yang ditolak

- Op yang tanda tangan atau formatnya salah, org-nya lain, atau datang dari koneksi yang tidak sah: tidak disimpan, dicatat di tabel `rejected_changes` (maksimal 1000 baris terbaru).
- Op bertanda tangan sah tapi pembuatnya tidak berhak: disimpan dengan `status = 'rejected'` dan `reject_reason`.
- Halaman Keamanan baru dibuat di Tahap 6; Tahap 1 hanya menyediakan data dan command `get_rejected_changes` untuk uji.

## 2. Jaringan (`network/`)

### 2.1 Endpoint dan TLS

- Satu `quinn::Endpoint` UDP per instance, dipakai untuk mendengar dan menyambung. Port: `MIRA_PORT` kalau diset; kalau tidak, coba 47800 sampai 47809 (beberapa instance di satu PC). Bind `0.0.0.0`.
- Setiap laptop membuat sertifikat X.509 self-signed Ed25519 dari kunci laptopnya sendiri (`rcgen`, kunci PKCS#8 dari `ed25519-dalek`). Klien dan server sama-sama wajib mengirim sertifikat. Verifier kustom di kedua sisi menerima sertifikat Ed25519 apa pun, mengambil kunci publiknya sebagai identitas, dan membiarkan rustls memeriksa tanda tangan jabat tangan TLS 1.3 dengan kunci itu (bukti kepemilikan kunci privat). Rantai CA dan nama host tidak dipakai. TLS 1.3 saja, tanpa 0-RTT.
- ALPN: `mira/1` untuk anggota, `mira-join/1` untuk orang yang bergabung.
- Setelah jabat tangan, kedua sisi memeriksa di aplikasi: kunci peer adalah anggota aktif organisasi yang sama (`SyncBackend::peer_auth`). Kalau peer bukan anggota: koneksi ditutup dengan kode `0x10` dan dicatat ke `rejected_changes`. Kalau peer sudah dikeluarkan: kirim pesan `Removed { op }` lalu tutup dengan kode `0x11`. Kalau penyambung mengharapkan kunci tertentu (alamat yang diingat), kunci yang dibuktikan harus sama.
- Keep-alive 5 detik, idle timeout 20 detik. Itu dasar status online dan offline.
- Koneksi ganda (dua laptop saling menyambung bersamaan): yang dipertahankan adalah koneksi yang dibuka oleh kunci yang lebih kecil secara leksikografis.

### 2.2 Format pesan

Setiap pesan adalah frame: panjang `u32` big-endian lalu JSON UTF-8, maksimal 4 MiB. Satu permintaan dan jawabannya memakai satu stream dua arah. Pesan dorong memakai stream satu arah.

```rust
enum Msg {                                   // serde tag = "t", snake_case
  Hello { proto: u32, org: String, pk: String, listen_port: u16, addrs: Vec<String> },
  SyncHave { ids: Vec<String> },             // op yang boleh diterima peer menurut pengirim
  SyncWant { ids: Vec<String> },
  SyncOps { ops: Vec<WireOp> },
  Removed { op: WireOp },
  JoinHello { tag: String },
  JoinChallenge { org: String, invite: String },
  JoinProof { proof: JoinProof },
  JoinAccepted { accepted: JoinAccepted },
  JoinRejected { code: String, message: String },
}
```

### 2.3 Sinkronisasi

- Saat koneksi baru, setiap 30 detik, dan setiap kali ada op baru (lokal atau diterima), laptop menjalankan sesi sinkron dengan setiap peer yang tersambung: kirim `SyncHave` berisi id op yang boleh diterima peer itu, peer menjawab `SyncWant` untuk id yang belum ia punya, pengirim menjawab `SyncOps` (difilter ulang). Op baru dari satu peer memicu sinkron ke peer lain (gosip). Laptop yang baru online lagi otomatis mendapat semua yang terlewat.
- Penerima memverifikasi setiap op (format, org, tanda tangan) sebelum menyimpan, lalu menghitung ulang status sekali per batch.

### 2.4 Bergabung dengan kode

1. Laptop baru (belum punya organisasi) mencari laptop Mira lewat mDNS, plus alamat manual kalau diisi.
2. Ke setiap kandidat: sambung dengan ALPN `mira-join/1`, kirim `JoinHello { tag }`.
3. Laptop anggota mencari undangan dengan `tag` itu di statusnya. Kalau tidak ada atau tidak bisa dipakai: `JoinRejected` (`invite_not_found`, `invite_expired`, `invite_used`, `invite_revoked`). Kalau ada: `JoinChallenge { org, invite }`.
4. Laptop baru membuat `JoinProof { member, name, invite_sig, member_sig }` dari kode. Laptop anggota memeriksa `member` sama dengan kunci TLS, memeriksa kedua tanda tangan dan masa berlaku menurut jamnya sendiri, membuat op `invite_accept` atas namanya, lalu menjawab `JoinAccepted { org: OrgRecord, ops }` berisi record genesis dan semua op yang boleh diterima anggota baru.
5. Laptop baru memeriksa genesis (format tiap field dan tanda tangan), memastikan ada `invite_create` dengan kunci undangan yang sama dengan turunan kodenya, menyimpan, menghitung status, dan memastikan dirinya anggota aktif. Setelah itu ia tersambung sebagai anggota biasa.
- Percobaan bergabung dibatasi 10 per menit per alamat IP di laptop anggota.

### 2.5 Penemuan dan alamat

- mDNS (`mdns-sd`): layanan `_mira._udp.local.`, nama instance 16 hex pertama kunci publik, TXT `v=1`, `pk=<64 hex>`, `org=<id org atau kosong>`. Isi TXT hanya petunjuk; identitas tetap dibuktikan lewat TLS. Laptop tanpa organisasi hanya mencari, tidak mengiklankan diri. `MIRA_DISABLE_MDNS=1` mematikan mDNS untuk menguji cadangan alamat manual.
- Alamat yang diingat (F-NET-03): setiap koneksi sah menyimpan alamat peer (`peer_addresses`) beserta waktu berhasil terakhir. Alamat dari `Hello.addrs` juga disimpan. Setiap 10 detik, untuk setiap anggota aktif yang belum tersambung, laptop mencoba alamatnya mulai dari yang terakhir berhasil, dengan jeda yang makin lama per alamat (sampai 5 menit).
- Alamat manual (F-NET-02): `ip`, `ip:port`, atau tautan `mira://peer?pk=<64 hex>&addr=<ip:port>&addr=...`. Dicoba seperti alamat yang diingat. Setelah tersambung, alamat itu dikaitkan ke kunci peer.
- QR: berisi tautan `mira://peer?...` laptop ini. Ditampilkan sebagai SVG yang dibuat di Rust (`qrcode`). Laptop lain bisa menempel tautan itu, atau memindai QR dengan kamera.

### 2.6 Status koneksi (F-NET-05)

Untuk setiap koneksi, laptop mencari antarmuka lokal yang dipakai untuk mencapai alamat peer (soket UDP sementara di-`connect` ke alamat peer, lalu `local_addr`) dan mencocokkannya dengan daftar antarmuka (`if-addrs`). Antarmuka dianggap VPN kalau namanya mengandung salah satu dari `wireguard`, `wg`, `tun`, `tap`, `vpn`, `openvpn`, `anyconnect`, `forti`, `globalprotect`, `pangp`, `zerotier`, `tailscale`, `ppp`, `wan miniport`.

| `state` | Arti | Teks |
|---|---|---|
| `starting` | 5 detik pertama | "Mencari laptop rekan..." |
| `no_org` | Belum punya organisasi | (tidak ditampilkan di kerangka utama) |
| `alone` | Organisasi hanya berisi laptop ini | "Belum ada rekan di organisasi" |
| `lan` | Minimal satu peer lewat antarmuka bukan VPN (termasuk loopback) | "Tersambung lewat LAN kantor" |
| `vpn` | Semua peer lewat antarmuka VPN | "Tersambung lewat VPN" |
| `offline` | Tidak ada peer tersambung | "Tidak tersambung ke jaringan kantor" + "Kalau sedang di luar kantor, nyalakan VPN kantor." |
| `removed` | Laptop ini dikeluarkan dari organisasi | "Laptop ini sudah dikeluarkan dari organisasi" |

## 3. Kontrak antarmodul (Rust)

### 3.1 `network` (dibuat subagent A)

```rust
pub struct NetConfig {
    pub identity_secret: zeroize::Zeroizing<[u8; 32]>, // kunci laptop, untuk sertifikat TLS
    pub public_key: String,                            // 64 hex
    pub port: Option<u16>,                             // MIRA_PORT
    pub mdns_enabled: bool,                            // !MIRA_DISABLE_MDNS
}

pub struct WireOp { pub payload: String, pub sig: String }           // serde, sama dengan permissions::SignedOp
pub struct OrgRecord { pub id, name, founder_public_key, created_at, genesis_signature: String }
pub struct JoinChallenge { pub org: String, pub invite: String }
pub struct JoinProof { pub member: String, pub name: String, pub invite_sig: String, pub member_sig: String }
pub struct JoinAccepted { pub org: OrgRecord, pub ops: Vec<WireOp> }

pub enum PeerAuth { Member { display_name: String }, Removed { removal: Option<WireOp> }, Unknown }
pub struct JoinReject { pub code: String, pub message: String }      // code seperti di 2.4

pub struct IngestOutcome { pub new_ops: usize }
pub struct KnownAddress { pub public_key: Option<String>, pub address: SocketAddr, pub last_success_at: Option<String> }

pub trait SyncBackend: Send + Sync + 'static {
    fn org_id(&self) -> Option<String>;                       // None: belum bergabung atau dikeluarkan
    fn display_name(&self) -> Option<String>;
    fn peer_auth(&self, public_key: &str) -> PeerAuth;
    fn active_members(&self) -> Vec<String>;                  // kunci publik, tanpa diri sendiri
    fn op_ids_for(&self, peer: &str) -> Result<Vec<String>, String>;
    fn ops_for(&self, peer: &str, ids: &[String]) -> Result<Vec<WireOp>, String>;   // difilter ulang
    fn ingest(&self, from: &str, ops: Vec<WireOp>) -> Result<IngestOutcome, String>;
    fn join_lookup(&self, tag: &str) -> Result<JoinChallenge, JoinReject>;
    fn join_accept(&self, tls_key: &str, challenge: &JoinChallenge, proof: JoinProof) -> Result<JoinAccepted, JoinReject>;
    fn known_addresses(&self) -> Vec<KnownAddress>;           // diingat + manual
    fn remember_address(&self, public_key: &str, address: SocketAddr, source: AddressSource);
    fn manual_attempt(&self, address: SocketAddr, result: Result<String, String>); // Ok(pk) atau Err(pesan)
    fn log_rejection(&self, peer: Option<&str>, address: Option<SocketAddr>, code: &str, detail: &str);
}
pub enum AddressSource { Mdns, Hello, Incoming, Outgoing, Manual }

pub enum NetEvent { StatusChanged, OrgChanged }               // dipancarkan ke tampilan

pub struct Network;   // pegangan Clone + Send + Sync
impl Network {
    pub async fn start(cfg: NetConfig, backend: Arc<dyn SyncBackend>, events: Arc<dyn Fn(NetEvent) + Send + Sync>) -> Result<Network, String>;
    pub fn refresh(&self);                       // organisasi atau op berubah: iklan ulang mDNS, sambung, sinkron
    pub fn status(&self) -> NetStatusSnapshot;   // dipakai get_network_status
    pub async fn join(&self, tag: &str, extra: Vec<SocketAddr>,
                      prove: Box<dyn FnOnce(&JoinChallenge) -> Result<JoinProof, String> + Send>)
        -> Result<JoinAccepted, JoinReject>;     // kode: invite_not_found, invite_expired, invite_used, invite_revoked, invalid_proof, rate_limited, no_peer_found
    pub async fn shutdown(&self);
}
pub struct NetStatusSnapshot {
    pub state: NetState,                    // starting|no_org|alone|lan|vpn|offline|removed (removed diisi adapter)
    pub listen_port: Option<u16>,
    pub local_addresses: Vec<SocketAddr>,   // alamat IPv4 yang bisa dibagikan
    pub peers: Vec<PeerConn>,               // hanya yang sedang tersambung
    pub mdns_ok: bool, pub mdns_error: Option<String>,
}
pub struct PeerConn { pub public_key: String, pub address: SocketAddr, pub route: Route /* lan|vpn|local */, pub connected_at: String }
```

### 3.2 `permissions` (dibuat subagent B)

```rust
pub struct SignedOp { pub payload: String, pub sig: String }   // serde: { "payload", "sig" }
pub enum Scope { Org, Team(String) }
pub enum Body { ProfileSet{..}, TeamCreate{..}, ... }           // sesuai tabel 1.2
pub struct OrgState { .. }   // hasil fold: anggota, superadmin, tim, undangan, akses tamu, channel

pub fn verify_op(op: &SignedOp, org_id: &str, now: OffsetDateTime) -> Result<VerifiedOp, Rejection>;
pub fn fold(org: &Organization, ops: &[VerifiedOp]) -> FoldResult;   // murni, tanpa IO
pub fn load_state(conn: &Connection) -> AppResult<Option<OrgState>>;
pub fn ingest(conn: &mut Connection, from: Option<&str>, ops: Vec<SignedOp>, now) -> AppResult<IngestReport>;
pub fn author_op(conn: &mut Connection, identity: &Identity, scope: Scope, body: Body) -> AppResult<SignedOp>;
     // cek izin dulu di status sekarang; kalau ditolak: AppError::Forbidden, tidak disimpan
pub fn op_ids_for(conn, state, peer) -> AppResult<Vec<String>>;
pub fn ops_for(conn, state, peer, ids) -> AppResult<Vec<SignedOp>>;
pub fn peer_auth(state, pk) -> PeerAuthState;   // Member{name} | Removed{removal_op_id} | Unknown
// Undangan
pub fn generate_invite_code() -> String;                      // "ABCD-EFGH-JKMN-PQRS-TVWX"
pub fn normalize_code(input: &str) -> AppResult<NormalizedCode>;  // AppError::InviteInvalid
pub fn invite_signing_key(code: &NormalizedCode) -> SigningKey;
pub fn create_invite(conn, identity, team, role, projects, validity: Validity, now) -> AppResult<(InviteView, String /*kode*/)>;
pub fn join_lookup(conn, tag, now) -> Result<(String /*org*/, String /*invite*/), JoinRejectCode>;
pub fn join_accept(conn, identity, tls_key, invite, proof, now) -> Result<SignedOp, JoinRejectCode>;
pub fn build_join_proof(code: &NormalizedCode, org: &str, invite: &str, identity: &Identity) -> JoinProof;
pub fn install_joined_org(conn, identity, org: Organization, ops: Vec<SignedOp>, code: &NormalizedCode, now) -> AppResult<OrgInfo>;
pub fn redeem_as_member(conn, identity, code, now) -> AppResult<..>; // anggota yang sudah ada memakai kode untuk tim lain
// Direktori untuk tampilan
pub fn directory(conn, identity, now) -> AppResult<Directory>;     // bentuk JSON di 4
pub fn rejected_changes(conn, limit) -> AppResult<Vec<RejectedChange>>;
pub fn log_rejection(conn, ..);
```

`org::verify_genesis` diperketat: setiap field diperiksa formatnya (id 32 hex huruf kecil, nama lolos `validate_org_name` dan sudah dipangkas, kunci 64 hex, `created_at` RFC 3339, tanda tangan 128 hex) sebelum tanda tangan diperiksa.

Kode error baru di `AppError`: `forbidden`, `not_found`, `invite_invalid`, `invite_not_found`, `invite_expired`, `invite_used`, `invite_revoked`, `no_peer_found`, `peer_unreachable`, `already_in_org`, `removed`, `last_superadmin`, `invalid_address`, `network`.

### 3.3 `peers` (dibuat subagent B)

Fungsi database untuk alamat: `remember(conn, pk, addr, source, now)`, `known(conn) -> Vec<KnownAddress>`, `add_manual(conn, input) -> ManualAddress` (menerima `ip`, `ip:port`, `mira://`), `remove_manual`, `manual_attempt(conn, addr, result, now)`, `last_seen(conn, pk, now)`, `peer_rows(conn)`.

### 3.4 Platform (dibuat subagent D)

- `firewall.rs`: `status(program: &Path) -> FirewallStatus` membaca aturan lewat PowerShell `Get-NetFirewallApplicationFilter` dan `Get-NetConnectionProfile` (hanya baca, jendela tersembunyi, output JSON). `request_rule(program)` menjalankan `Start-Process powershell -Verb RunAs` untuk `New-NetFirewallRule` (UDP masuk, program Mira, profil Domain, Private, Public); Windows menampilkan UAC dan pengguna yang memutuskan. `admin_command(program) -> String` berisi perintah untuk admin IT.
- `window_theme.rs`: warna latar jendela dari pengaturan `theme.mode` (dan registry `AppsUseLightTheme` untuk Ikuti Windows), dipakai saat membuat jendela supaya tidak ada kedip putih.
- `qr.rs`: `share_link(pk, addrs) -> String`, `parse_share_link(s)`, `qr_svg(text) -> String`.
- `identity/keystore.rs`: periksa mode persist kredensial. Kunci laptop disimpan dengan `CRED_PERSIST_LOCAL_MACHINE` (tidak ikut roaming) lewat Credential Manager API langsung; entri lama "enterprise" ditulis ulang saat dibaca. Nama target tetap sama dengan Tahap 0.

## 4. Kontrak tampilan dan inti Rust (command Tauri)

Semua command mengembalikan `Result<T, AppError>`, error tetap `{ code, message }`.

| Command | Argumen | Hasil |
|---|---|---|
| `get_app_state` | | `AppState` (ditambah `membership`) |
| `get_directory` | | `Directory` |
| `create_team` | `{ name }` | `TeamView` |
| `delete_team` | `{ teamId }` | `null` |
| `add_team_member` | `{ teamId, publicKey }` | `null` |
| `remove_team_member` | `{ teamId, publicKey }` | `null` |
| `set_team_admin` | `{ teamId, publicKey, admin: boolean }` | `null` |
| `add_superadmin` / `remove_superadmin` | `{ publicKey }` | `null` |
| `remove_member` | `{ publicKey }` | `null` |
| `create_invite` | `{ teamId, role, validity: "24h" \| "7d" \| "once", projectIds: string[] }` | `{ code: string, invite: InviteView }` |
| `revoke_invite` | `{ inviteId }` | `null` |
| `join_with_code` | `{ code, address: string \| null }` | `OrgInfo` (bisa beberapa detik) |
| `redeem_invite` | `{ code }` | `null` (anggota yang sudah ada, untuk tim lain) |
| `get_network_status` | | `NetworkStatus` |
| `add_manual_address` | `{ address }` | `ManualAddress` |
| `remove_manual_address` | `{ address }` | `null` |
| `get_firewall_status` | | `FirewallStatus` |
| `request_firewall_rule` | | `{ started: boolean }` |
| `get_rejected_changes` | | `RejectedChange[]` (untuk uji; halaman Keamanan di Tahap 6) |

Event Tauri (tanpa isi berarti, tampilan cukup memuat ulang): `mira://network` (status atau daftar peer berubah), `mira://directory` (op baru diterapkan).

```ts
type Membership = "none" | "active" | "removed";
type AppState = { identity: IdentityInfo; organization: OrgInfo | null; membership: Membership; dataDir: string };

type TeamRole = "admin" | "member";
type Directory = {
  org: OrgInfo;
  me: { publicKey: string; isSuperadmin: boolean };
  superadminCount: number;
  can: { createTeam: boolean; manageSuperadmins: boolean; removeMembers: boolean; manageTeamIds: string[] };
  members: MemberView[];          // aktif dulu, lalu yang dikeluarkan
  teams: TeamView[];              // tim hidup
  invites: InviteView[];          // yang boleh dikelola laptop ini
  channels: ChannelView[];        // yang boleh dilihat laptop ini
};
type MemberView = {
  publicKey: string; fingerprint: string; displayName: string;
  orgRole: Role; isSuperadmin: boolean; status: "active" | "removed";
  joinedAt: string; teams: { teamId: string; role: TeamRole }[];
};
type TeamView = { id: string; name: string; createdAt: string; members: { publicKey: string; role: TeamRole }[] };
type InviteRole = "team_admin" | "member" | "guest";
type InviteView = {
  id: string; teamId: string; teamName: string; role: InviteRole; projectIds: string[];
  validity: "24h" | "7d" | "once"; expiresAt: string; createdBy: string; createdAt: string;
  status: "active" | "used" | "expired" | "revoked"; usedBy: string[];
};
type ChannelView = { id: string; name: string; teamId: string | null };

type NetState = "starting" | "no_org" | "alone" | "lan" | "vpn" | "offline" | "removed";
type NetworkStatus = {
  state: NetState;
  listenPort: number | null;
  localAddresses: string[];       // "192.168.1.10:47800"
  shareLink: string;              // "mira://peer?pk=...&addr=..."
  qrSvg: string;                  // <svg>...</svg>, aman dimasukkan sebagai gambar
  mdns: { ok: boolean; error: string | null };
  peers: PeerView[];              // semua anggota aktif selain diri sendiri
  manualAddresses: ManualAddress[];
};
type PeerView = {
  publicKey: string; displayName: string; fingerprint: string; orgRole: Role;
  online: boolean; route: "lan" | "vpn" | "local" | null; address: string | null; lastSeenAt: string | null;
};
type ManualAddress = { address: string; addedAt: string; lastTriedAt: string | null; lastError: string | null; publicKey: string | null };

type FirewallStatus = {
  supported: boolean;                                   // false di luar Windows
  rule: "allowed" | "blocked" | "missing" | "unknown";
  profiles: { name: string; category: "public" | "private" | "domain"; interfaceAlias: string }[];
  programPath: string;
  adminCommand: string;                                 // untuk diteruskan ke admin IT
  detail: string | null;
};
type RejectedChange = { at: string; peer: string | null; address: string | null; code: string; detail: string };
```

## 5. Tampilan (dibuat subagent C)

Teks bahasa Indonesia, tanpa em dash, kontras WCAG AA terang dan gelap (`check_contrast`), fokus keyboard terlihat, keadaan kosong, memuat, dan error di setiap layar. Skill antislop wajib dimuat.

- Onboarding:
  - "Gabung dengan kode" sungguhan: isian kode (format bebas spasi dan huruf kecil), isian opsional "Alamat laptop rekan" (atau tempel tautan `mira://`), keadaan mencari, error per kode.
  - Langkah "Izinkan Mira di jaringan" (F-ID-03) setelah membuat atau sebelum bergabung: status aturan firewall, kategori jaringan (Public atau Private), tombol "Izinkan lewat Windows Firewall" yang jujur menyebut butuh izin administrator, perintah untuk admin IT yang bisa disalin, dan "Lewati, atur nanti".
- Sidebar: status koneksi (F-NET-05) dan daftar "Di jaringan" (F-NET-06): online dulu, lalu offline dengan "terakhir terlihat".
- Menu baru "Organisasi":
  - Peringatan kalau superadmin baru satu.
  - Daftar tim, buat tim (superadmin), detail tim: anggota dan perannya, tambah anggota yang sudah ada, angkat atau lepas admin tim (superadmin), keluarkan dari tim.
  - Dialog undangan seperti mockup: peran (Anggota, Admin tim, Tamu), masa berlaku (24 jam, 7 hari, Sekali pakai). Tamu dinonaktifkan dengan penjelasan karena proyek baru ada di Tahap 3. Kode tampil sekali dengan tombol salin.
  - Daftar undangan beserta status dan tombol cabut.
  - Daftar anggota organisasi, angkat superadmin, keluarkan dari organisasi (dengan konfirmasi).
  - "Punya kode undangan untuk tim lain?" untuk anggota yang sudah ada.
- Pengaturan > "Jaringan": status, alamat laptop ini, QR dan tautan, alamat manual (tambah, hapus, hasil percobaan), mDNS aktif atau error, dan panduan firewall yang sama.
- Layar "Laptop ini sudah dikeluarkan dari organisasi" kalau `membership = "removed"`.

## 6. Skema SQLite v2

```sql
CREATE TABLE org_ops (
    id            TEXT PRIMARY KEY CHECK (length(id) = 64),
    org_id        TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    author        TEXT NOT NULL CHECK (length(author) = 64),
    lamport       INTEGER NOT NULL CHECK (lamport > 0),
    kind          TEXT NOT NULL,
    scope_team    TEXT,                        -- NULL = scope org
    payload       TEXT NOT NULL,
    sig           TEXT NOT NULL CHECK (length(sig) = 128),
    received_at   TEXT NOT NULL,
    received_from TEXT,                        -- NULL = dibuat di laptop ini
    status        TEXT NOT NULL CHECK (status IN ('applied', 'rejected')),
    reject_reason TEXT
) STRICT;
CREATE INDEX org_ops_order ON org_ops (lamport, author, id);

ALTER TABLE members ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed'));
ALTER TABLE members ADD COLUMN is_superadmin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE members ADD COLUMN kind TEXT NOT NULL DEFAULT 'member' CHECK (kind IN ('member', 'guest'));
ALTER TABLE members ADD COLUMN removed_at TEXT;

CREATE TABLE teams (id TEXT PRIMARY KEY CHECK (length(id) = 32), name TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE team_members (team_id TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE, public_key TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin', 'member')), added_at TEXT NOT NULL, PRIMARY KEY (team_id, public_key)) STRICT;
CREATE TABLE invites (id TEXT PRIMARY KEY CHECK (length(id) = 32), team_id TEXT NOT NULL, role TEXT NOT NULL, projects TEXT NOT NULL, expires_at TEXT NOT NULL, single_use INTEGER NOT NULL, tag TEXT NOT NULL, invite_key TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, used_by TEXT NOT NULL DEFAULT '[]') STRICT;
CREATE INDEX invites_tag ON invites (tag);
CREATE TABLE guest_access (public_key TEXT NOT NULL, team_id TEXT NOT NULL, project_id TEXT NOT NULL, PRIMARY KEY (public_key, team_id, project_id)) STRICT;
CREATE TABLE channels (id TEXT PRIMARY KEY CHECK (length(id) = 32), team_id TEXT, name TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
CREATE TABLE peer_addresses (public_key TEXT NOT NULL, address TEXT NOT NULL, source TEXT NOT NULL, last_success_at TEXT, last_seen_at TEXT NOT NULL, PRIMARY KEY (public_key, address)) STRICT;
CREATE TABLE manual_addresses (address TEXT PRIMARY KEY, added_at TEXT NOT NULL, last_tried_at TEXT, last_error TEXT, public_key TEXT) STRICT;
CREATE TABLE peer_seen (public_key TEXT PRIMARY KEY, last_seen_at TEXT NOT NULL) STRICT;
CREATE TABLE rejected_changes (id INTEGER PRIMARY KEY, at TEXT NOT NULL, peer TEXT, address TEXT, code TEXT NOT NULL, detail TEXT NOT NULL) STRICT;
```

Tabel `members`, `teams`, `team_members`, `invites`, `guest_access`, dan `channels` adalah hasil fold dan ditulis ulang dalam satu transaksi setiap kali status dihitung. Sumber kebenarannya `organizations` + `org_ops`. Organisasi dari Tahap 0 tetap jalan: saat start, laptop pendiri yang belum punya op `profile_set` membuatnya supaya nama pendiri ikut tersinkron.

## 7. Tugas dan pembagian

Kelompok A, B, C, dan D tidak menyentuh file yang sama, jadi dikerjakan paralel oleh empat subagent. Dependensi Cargo sudah ditambahkan sesi utama (quinn, rustls, rcgen, mdns-sd, tokio, if-addrs, qrcode, blake3, data-encoding, x509-parser, windows-sys, winreg, fitur `pkcs8` ed25519-dalek). `lib.rs` dan `commands.rs` hanya diubah sesi utama.

### A. Jaringan (subagent A). File: `src-tauri/src/network/**`
- A.1 `tls.rs`: sertifikat Ed25519 dari kunci laptop, verifier klien dan server kustom, konfigurasi quinn (TLS 1.3, ALPN, keep-alive, idle timeout). Tes: dua endpoint loopback saling membuktikan kunci; kunci peer terbaca benar; peer yang mengaku kunci lain gagal.
- A.2 `wire.rs`: frame dan `Msg`. Tes: bolak-balik, frame terlalu besar ditolak, JSON rusak ditolak.
- A.3 `node.rs`: registry koneksi, aturan koneksi ganda, `peer_auth` setelah jabat tangan, penolakan dan `Removed`, sesi sinkron, gosip. Tes dengan `MemoryBackend`: anggota tersambung dan sinkron op; bukan anggota ditolak dan dicatat; yang dikeluarkan menerima `Removed` lalu diputus; penyambung yang mengharapkan kunci lain menolak.
- A.4 `join.rs`: klien dan server bergabung, batas 10 percobaan per menit per IP. Tes: kode benar, tag tidak dikenal, bukti dengan kunci lain dari kunci TLS ditolak.
- A.5 `discovery.rs`: mDNS iklan dan cari, dial loop alamat diingat dan manual dengan backoff.
- A.6 `route.rs`: klasifikasi LAN, VPN, loopback. Tes untuk pola nama antarmuka.
- A.7 `mod.rs`: `Network` sesuai kontrak 3.1.

### B. Izin dan undangan (subagent B, TDD). File: `src-tauri/src/permissions/**`, `src-tauri/src/peers/**`, `src-tauri/src/org/**`, `src-tauri/src/db/**`, `src-tauri/src/error.rs`
- B.1 Migrasi v2 (bagian 6). Tes: v1 ke v2 tanpa kehilangan data Tahap 0.
- B.2 Validasi ketat `verify_genesis` dan record dari laptop lain. Tes: setiap field yang salah format ditolak.
- B.3 Op: bentuk, tanda tangan, verifikasi, id, batas ukuran. Tes: tanda tangan rusak, org lain, field tak dikenal, `at` di masa depan.
- B.4 Fold dan izin sesuai tabel 1.2. Tes: setiap baris tabel (yang berhak dan tidak), urutan lamport, perubahan tanpa izin ditolak, op terlambat yang membuat op lain sah, minimal satu superadmin, anggota yang dikeluarkan.
- B.5 Undangan: kode, kunci turunan, lookup, accept, kedaluwarsa, sekali pakai, dicabut, pembuat yang sudah tidak berhak, tim dihapus, bukti dengan kunci lain. Tes untuk semuanya.
- B.6 Filter per tim (`op_ids_for`, `ops_for`). Tes: op tim B tidak dikirim ke anggota yang hanya di tim A; superadmin tidak menerima isi tim yang tidak ia ikuti; yang dikeluarkan tidak menerima apa pun.
- B.7 `ingest`, `author_op`, `install_joined_org`, `redeem_as_member`, `directory`, log penolakan. Tes: dua database lokal saling bertukar op dan mencapai status yang sama, termasuk laptop yang tertinggal.
- B.8 `peers`: alamat diingat dan manual, parser alamat dan `mira://`. Tes.

### C. Tampilan (subagent C). File: `src/**`
- C.1 Tipe dan pembungkus API sesuai bagian 4, tiruan (mock) untuk tes.
- C.2 sampai C.6 sesuai bagian 5. Tes Vitest untuk layar dan komponen kunci. Verifikasi: `npm test`, `npm run build`, `check_contrast` untuk warna baru.

### D. Platform dan bawaan Tahap 0 (subagent D). File: `src-tauri/src/firewall.rs`, `src-tauri/src/window_theme.rs`, `src-tauri/src/qr.rs`, `src-tauri/src/identity/keystore.rs`
- D.1 sampai D.4 sesuai 3.4, dengan tes unit untuk parser JSON firewall, perintah admin, warna latar, tautan dan QR. Tes keyring sungguhan tetap `#[ignore]`.

### E. Integrasi (sesi utama)
- E.1 `net_backend.rs` (adapter `SyncBackend`), `commands.rs`, `lib.rs` (start jaringan, event, warna latar jendela, `MIRA_PORT`, `MIRA_DISABLE_MDNS`, `MIRA_CLOCK_OFFSET_SECS` untuk menguji undangan kedaluwarsa).
- E.2 Tes integrasi Rust: tiga node dalam satu proses lewat loopback memakai backend sungguhan (gabung, ditolak, kedaluwarsa, dikeluarkan, tertinggal lalu menyusul).
- E.3 Review keamanan oleh subagent terpisah (autentikasi dua arah, replay, data bocor ke laptop yang tidak berhak), dan review tampilan. Perbaiki temuan.
- E.4 `scripts/e2e-multi.mjs`: tiga instance build release di satu PC (folder data dan port debug berbeda): saling menemukan dan tampil di "Di jaringan", B dan C bergabung dengan peran benar, kode salah, terpakai, dan kedaluwarsa ditolak, anggota yang dikeluarkan berhenti menerima data, instance yang dimatikan lalu dinyalakan menyusul. Membersihkan folder data dan kunci uji di akhir.
- E.5 `cargo test`, `cargo clippy`, `cargo fmt --check`, `npm test`, `npm run build:installer`, laporan `docs/progress/tahap-1.md`, commit.

## Verifikasi tiap kelompok

| Kelompok | Verifikasi |
|---|---|
| A | `cargo test network::` lulus, termasuk koneksi QUIC sungguhan di loopback |
| B | `cargo test permissions:: peers:: org:: db::` lulus |
| C | `npm test` dan `npm run build` lulus, kontras dicek |
| D | `cargo test firewall:: window_theme:: qr:: identity::` lulus |
| E | Semua tes, tes integrasi tiga node, uji multi-instance, installer terbentuk |

## Perubahan setelah review keamanan

Ditambahkan saat implementasi; kode adalah acuan akhirnya (`src-tauri/src/permissions/`).

- `payload.deps`: id op "kepala" yang sudah dilihat pembuat (maksimal 32, urut, unik, 64 hex). Hanya op ber-scope org yang seluruh masa lalunya tersimpan. Op dengan dep yang lamport-nya ≥ lamport op itu ditolak (`bad_deps`).
- Pencabutan hak mengalahkan op yang dimundurkan: op yang diurutkan sebelum pencabutan R, memakai hak yang dicabut R, dan tidak ada di masa lalu R, ditolak (`concurrent_with_revocation`). Pencabutan: `member_remove`, `superadmin_remove`, `team_admin_unset`, `team_member_remove` (kalau target admin), `team_delete`, `invite_revoke`. Dua pencabutan yang saling membatalkan dimenangkan superadmin yang lebih senior (pendiri, lalu urutan pengangkatan).
- `invite_accept` wajib punya `invite_create`-nya di masa lalu (`bad_deps`). Satu orang hanya bisa memakai satu undangan sekali, supaya bukti lama tidak bisa diputar ulang untuk mengembalikan peran.
- `invite_create.key_sig`: tanda tangan kunci undangan atas `"mira-invite-key-v1\n{org}\n{founder}\n{author}\n{invite}\n{team}\n{role}\n{projects}\n{expires}\n{0|1}\n{tag}"`. Kunci undangan tidak bisa disalin ke undangan atau organisasi lain. Laptop yang bergabung mewajibkan dirinya tercatat di `used_by` undangan dengan kunci dari kodenya.
- Op yang lamport-nya melompat lebih dari 1.000.000 di atas lamport tertinggi yang diketahui ditolak saat diterima (`lamport_jump`). Waktu di luar 1970 sampai 9000 ditolak.
- Jaringan: QUIC Retry untuk alamat yang belum terbukti, maksimal 16 koneksi tertunda dan 2 sesi gabung per IP, jendela aliran 1 MiB per stream dan 4 MiB per koneksi, datagram mati, maksimal 4 alamat mDNS per kunci.
- Laptop yang dikeluarkan tidak bisa bergabung lagi dengan kode undangan (`member_removed`).

## Di luar Tahap 1

- Halaman Keamanan (Tahap 6). Data dan command `get_rejected_changes` sudah ada.
- Kunci cadangan superadmin di flashdisk (Tahap 7).
- Proyek dan undangan Tamu yang bisa dipakai (Tahap 3). Model data sudah mendukung `projects` di undangan dan `guest_access`.
- Chat di channel (Tahap 2). Channel `#umum` dan channel tim sudah ada datanya.
