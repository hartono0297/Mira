# Rencana dan kontrak: foto profil

Tanggal 24 November 2026. Branch `claude/foto-profil-e4373f`. Permintaan user: "user bisa ganti foto profile".

Dokumen ini kontrak bersama untuk semua subagent. Nama fungsi, tipe, tabel, dan perintah di sini mengikat; kalau perlu diubah, ubah di sini dulu.

## 1. Ringkasan

- Setiap orang bisa memasang foto profil (PNG, JPEG, WebP), memotongnya persegi dengan geser dan zoom (mouse dan keyboard), dan menghapusnya kembali ke inisial.
- Foto selalu diolah di Rust: orientasi EXIF diterapkan, dipotong, diperkecil ke 256x256, disimpan sebagai JPEG di bawah 100 KB. Encoder JPEG tidak menulis metadata, jadi EXIF (lokasi, kamera) hilang.
- Foto milik pemiliknya: record bertanda tangan pemilik di topik `profile`, berisi hash foto, nomor urut, dan waktu. Record terbaru per pemilik menang.
- Superadmin bisa menghapus foto yang tidak pantas: record `remove` bertanda tangan superadmin untuk satu hash. Pemilik bisa memasang foto lain.
- Disebar ke semua anggota aktif, Tamu juga (sama seperti direktori organisasi). Laptop yang dikeluarkan tidak menerima apa pun (transport hanya menyambung anggota aktif, dan `record_ids_for` serta `blob_path_for` menolak peer yang tidak aktif).
- Laptop 0.5.x tidak mengenal topik `profile`; transport mengabaikan topik yang tidak dikenal (`feature_net.rs`), jadi mereka tetap menampilkan inisial. Tidak perlu gerbang versi dan `src-tauri/src/permissions/` tidak diubah.

## 2. Rust: modul `src-tauri/src/profile/`

```
profile/mod.rs       konstanta, re-export, TOPIC_PROFILE
profile/image.rs     pengolahan gambar (agent R2)
profile/record.rs    format record, tanda tangan, validasi, status efektif (agent R1)
profile/schema.rs    migrasi PROFILE_SCHEMA (agent R1)
profile/store.rs     tabel profile_*, query (agent R1)
profile/sync.rs      ProfileSync: FeatureSync + BlobSource + antrean unduh (agent R1)
profile/runtime.rs   ProfileRuntime: registrasi hub, fetcher, token pilih foto (agent R1)
profile/commands.rs  perintah Tauri (agent R1)
profile/tests.rs     tes unit gabungan (agent R1; R2 menaruh tes di image.rs)
```

### 2.1 Konstanta (`profile/mod.rs`)

```rust
pub const TOPIC_PROFILE: &str = "profile";
pub const PHOTO_SIZE: u32 = 256;               // sisi foto akhir, piksel
pub const MAX_PHOTO_BYTES: u64 = 128 * 1024;   // batas keras foto akhir dan unduhan
pub const TARGET_PHOTO_BYTES: usize = 100 * 1024; // sasaran encoder
pub const MAX_SOURCE_BYTES: u64 = 20 * 1024 * 1024; // file yang dipilih
pub const MAX_SOURCE_SIDE: u32 = 8000;         // sisi terpanjang file sumber
pub const MAX_SOURCE_PIXELS: u64 = 40_000_000;
pub const PREVIEW_SIDE: u32 = 1024;            // sisi terpanjang pratinjau untuk pemotong
```

### 2.2 Gambar (`profile/image.rs`, agent R2)

Crate `image` 0.25 tanpa fitur bawaan, fitur `jpeg`, `png`, `webp` (sudah di Cargo.toml).

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceFormat { Png, Jpeg, WebP }

/// Dari magic bytes, bukan ekstensi. GIF, SVG, BMP, dan lainnya: None.
pub fn sniff(bytes: &[u8]) -> Option<SourceFormat>;

/// Gambar sumber yang sudah didekode, orientasi EXIF sudah diterapkan.
pub struct SourceImage { pub image: image::DynamicImage, pub format: SourceFormat }
impl SourceImage {
    pub fn width(&self) -> u32; pub fn height(&self) -> u32;
}

/// Dekode file pilihan pengguna. Menolak (AppError::InvalidInput, pesan di 2.8):
/// > MAX_SOURCE_BYTES, format bukan PNG/JPEG/WebP, WebP beranimasi, sisi > MAX_SOURCE_SIDE,
/// piksel > MAX_SOURCE_PIXELS, sisi < 16, data rusak. Pakai image::Limits sebelum dekode penuh.
pub fn load_source(bytes: &[u8]) -> AppResult<SourceImage>;

/// Pratinjau JPEG untuk layar pemotong: sisi terpanjang <= PREVIEW_SIDE, tanpa metadata.
pub fn preview_jpeg(src: &SourceImage) -> AppResult<Vec<u8>>;

/// Kotak potong dalam piksel gambar sumber (setelah orientasi).
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Crop { pub x: u32, pub y: u32, pub size: u32 }

/// Potong, perkecil (Lanczos3) ke PHOTO_SIZE, ratakan alfa di atas putih, encode JPEG.
/// Kualitas mulai 88, turun bertahap sampai <= TARGET_PHOTO_BYTES (paling rendah 50).
/// Kotak dijepit ke dalam gambar; size < 16 atau di luar gambar: InvalidInput.
pub fn crop_to_photo(src: &SourceImage, crop: Crop) -> AppResult<Vec<u8>>;

/// Foto yang diterima dari rekan atau dibaca dari penyimpanan: JPEG (magic FF D8 FF),
/// <= MAX_PHOTO_BYTES, terdekode dengan Limits, tepat PHOTO_SIZE x PHOTO_SIZE.
pub fn is_valid_photo(bytes: &[u8]) -> bool;
```

Tes (TDD, di `image.rs`): sniff untuk keenam format (PNG, JPEG, WebP, GIF, SVG, sampah); JPEG dengan segmen APP1 `Exif` (sisipkan manual setelah SOI, berisi orientasi 6) dan string GPS palsu: hasil `crop_to_photo` tidak mengandung `Exif`, `GPS`, atau string palsu itu, dan orientasi 6 memutar gambar (cek lebar/tinggi `SourceImage`); hasil 256x256, < 100 KB untuk gambar derau acak 2000x1500; PNG beralfa jadi; dimensi terlalu besar ditolak sebelum alokasi besar (header PNG palsu 9000x9000); WebP beranimasi ditolak; `is_valid_photo` menolak PNG, JPEG 300x300, dan > 128 KiB.

### 2.3 Record (`profile/record.rs`, agent R1)

Body record adalah JSON kanonik dari struct ini (urutan field tetap, `deny_unknown_fields`, `photo`/`size` ditulis sebagai `null` kalau kosong):

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileRecord {
    pub v: u32,             // 1
    pub kind: RecordKind,   // "set" | "clear" | "remove"
    pub org: String,        // id organisasi, 32 hex
    pub owner: String,      // pemilik foto, 64 hex
    pub author: String,     // penanda tangan, 64 hex; == owner untuk set/clear
    pub photo: Option<String>, // hash BLAKE3 64 hex; Some untuk set dan remove, None untuk clear
    pub size: Option<u64>,  // Some(1..=MAX_PHOTO_BYTES) untuk set, None lainnya
    pub seq: u64,           // set/clear: >= 1, naik per pemilik; remove: 0
    pub at: String,         // RFC 3339 (permissions::format::format_time)
    pub sig: String,        // ed25519 128 hex atas signing_bytes()
}
```

- `signing_bytes()` = `b"mira/profile/v1\n"` + JSON kanonik record dengan `sig` = `""`.
- `ProfileRecord::sign_new(identity, kind, org, owner, photo, size, seq, at)`; `to_body()`; `parse(body) -> AppResult<ProfileRecord>` menolak kalau `to_body()` hasil parse tidak sama persis dengan body (satu record, satu encoding), atau tanda tangan, panjang hex, `v`, aturan kind/photo/size/seq di atas tidak cocok.
- Validasi terhadap organisasi saat ingest (`check_against(dir)`): `org` sama dengan organisasi laptop ini; `owner` tercatat di tabel `members` (status apa pun); untuk `set`/`clear` `author == owner`; untuk `remove` `author` adalah superadmin aktif dan `author != owner` boleh.
- Status efektif per pemilik (`effective(records, dir)`, fungsi murni yang dites):
  - record pemilik terbaru = maks `(seq, at, id)` di antara `set`/`clear` dengan `author == owner`;
  - foto tampil kalau record terbaru `set`, hash-nya tidak ada di record `remove` untuk pemilik itu yang penulisnya *saat ini* superadmin aktif, dan blob ada lokal serta lolos `is_valid_photo`;
  - `removed_by_admin = true` kalau record terbaru `set` tapi hash-nya dihapus superadmin.
- `seq` baru = maks seq pemilik yang diketahui laptop ini + 1.

### 2.4 Tabel (`profile/schema.rs`, migrasi berikutnya, v10)

```sql
CREATE TABLE profile_records (
    id          TEXT PRIMARY KEY CHECK (length(id) = 64),
    owner       TEXT NOT NULL CHECK (length(owner) = 64),
    author      TEXT NOT NULL CHECK (length(author) = 64),
    kind        TEXT NOT NULL CHECK (kind IN ('set', 'clear', 'remove')),
    photo       TEXT CHECK (photo IS NULL OR length(photo) = 64),
    size        INTEGER,
    seq         INTEGER NOT NULL CHECK (seq >= 0),
    at          TEXT NOT NULL,
    body        TEXT NOT NULL,
    received_at TEXT NOT NULL
) STRICT;
CREATE INDEX profile_records_owner ON profile_records (owner, kind);

CREATE TABLE profile_fetch (
    hash        TEXT PRIMARY KEY CHECK (length(hash) = 64),
    owner       TEXT NOT NULL,
    size        INTEGER NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    next_try_at TEXT,
    bad         INTEGER NOT NULL DEFAULT 0  -- 1: bytes tidak lolos is_valid_photo, jangan coba lagi
) STRICT;
```

Ditambahkan di `db/migrations.rs` sebagai satu baris `crate::profile::schema::PROFILE_SCHEMA` setelah `V9_ORG_V03`. Sesi lain mungkin juga menambah migrasi v10; session utama yang mengurutkan saat menggabung.

Foto disimpan di `BlobStore::open(<data_dir>/profile-photos)`, terpisah dari blob chat dan dokumen supaya foto lama aman dihapus. Foto yang tidak lagi jadi foto efektif siapa pun (dan bukan foto `set` terbaru milik laptop ini) dihapus setelah ingest atau ganti foto.

### 2.5 Sinkron (`profile/sync.rs`)

`ProfileSync` mengimplementasi `FeatureSync` (topik `profile`) dan `BlobSource`:

- `record_ids_for(peer)`: kosong kalau peer bukan anggota aktif; selain itu id record pemilik terbaru setiap pemilik, plus record `remove` dari superadmin aktif. Record lama yang sudah kalah tetap di tabel (supaya `unknown_ids` tidak meminta ulang) tapi tidak ditawarkan.
- `unknown_ids`: id yang tidak ada di `profile_records`.
- `records_for(peer, ids)`: saring ulang dengan aturan yang sama.
- `ingest`: `parse` + `check_against`, simpan, abaikan duplikat. Record ditolak dicatat lewat log yang sama dengan chat/board (lihat `log_rejection` di network). Kalau foto efektif berubah: `changed = true`, antrekan unduhan hash yang belum ada.
- `peer_connected`: reset jeda antrean dan bangunkan fetcher.
- `blob_path_for(peer, hash)`: peer anggota aktif, bukan diri sendiri, hash adalah foto efektif seseorang (tidak dihapus superadmin), dan ada lokal. Laptop mana pun yang memegangnya boleh menyajikan, jadi B yang offline bisa menyusul dari C.
- Fetcher seperti `chat/runtime.rs`: `hub.fetch_blob(hash, MAX_PHOTO_BYTES, vec![owner], tmp)` ke `<data_dir>/profile-tmp/`, lalu `is_valid_photo`; gagal validasi: `bad = 1`. Jeda naik per percobaan, interval dasar 60 detik.
- Setelah perubahan lokal: `hub.notify_changed("profile")` dan event `mira://feature` `{ topic: "profile" }`.

### 2.6 Perintah Tauri (`profile/commands.rs`)

Semua mengembalikan `AppResult`. Nama JSON camelCase.

```rust
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct PhotoEntry { pub owner: String, pub hash: String }

#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct MyPhoto { pub hash: Option<String>, pub removedByAdmin: bool /* removed_by_admin */ }

#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct PickedPhoto {
    pub token: String,     // 32 hex, berlaku 10 menit, satu pakai, di memori ProfileRuntime
    pub preview: String,   // base64 JPEG pratinjau
    pub width: u32,        // ukuran gambar sumber setelah orientasi (piksel Crop)
    pub height: u32,
    pub previewWidth: u32, pub previewHeight: u32,
}

profile_photos() -> Vec<PhotoEntry>                 // foto efektif yang ada lokal
profile_photo_data(hash: String) -> String          // base64 JPEG; hanya hash foto efektif, cek is_valid_photo
profile_my_photo() -> MyPhoto
profile_pick_photo() -> Option<PickedPhoto>         // dialog file Rust, filter png/jpg/jpeg/webp; None kalau batal
profile_set_photo(token: String, crop: Crop) -> PhotoEntry
profile_clear_photo() -> ()
profile_admin_remove_photo(owner: String) -> ()     // hanya superadmin aktif, owner != diri sendiri
```

Dialog memakai pola `chat_pick_files` (judul dialog lewat `ui_lang`: tambahkan `photo_dialog_title(lang)` di `ui_lang.rs`, "Pilih foto profil" / "Choose profile photo"). Path tidak pernah datang dari webview.

Kait uji e2e: hanya di build debug (`#[cfg(debug_assertions)]`), kalau env `MIRA_E2E_PICK_PHOTO` berisi path file, `profile_pick_photo` memakai file itu tanpa membuka dialog Windows (dialog native tidak bisa diotomasi). Build release tidak punya kait ini.

Token: `ProfileRuntime` hanya menyimpan satu token terakhir (byte asli file, bukan gambar terdekode, supaya memori kecil); `profile_set_photo` mendekode ulang.

### 2.7 Registrasi (`lib.rs`)

`pub mod profile;`, `let profile = profile::runtime::ProfileRuntime::install(app.handle()); app.manage(profile);` setelah chat, dan tujuh perintah di `generate_handler!`.

### 2.8 Pesan error Rust (bahasa Indonesia, persis)

- `PHOTO_TOO_BIG`: "Foto terlalu besar. Pilih file sampai 20 MB."
- `PHOTO_FORMAT`: "Format foto tidak didukung. Pilih file PNG, JPEG, atau WebP."
- `PHOTO_ANIMATED`: "Foto bergerak tidak didukung. Pilih gambar diam."
- `PHOTO_DIMENSIONS`: "Ukuran gambar tidak didukung. Sisi gambar harus antara 16 dan 8000 piksel."
- `PHOTO_BROKEN`: "File foto rusak atau tidak bisa dibaca."
- `PHOTO_CROP`: "Bagian foto yang dipilih tidak valid. Atur ulang potongan foto."
- `PHOTO_TOKEN`: "Foto yang dipilih sudah kedaluwarsa. Pilih foto lagi."
- `PHOTO_NOT_ADMIN`: "Hanya superadmin yang bisa menghapus foto profil orang lain."
- `PHOTO_NOT_MEMBER`: "Orang ini bukan anggota organisasi."
- `PHOTO_NO_ORG`: "Foto profil baru bisa dipakai setelah laptop ini membuat atau bergabung dengan organisasi."
- `PHOTO_NOT_FOUND`: "Foto tidak ditemukan."

Konstanta ini di `profile/mod.rs` sebagai `pub const`. Terjemahan Inggrisnya masuk `src/i18n/errors-rust.id.ts`/`.en.ts` sebagai grup `profile` di akhir.

## 3. Frontend

### 3.1 API (`src/api/profile.ts`)

```ts
export type PhotoEntry = { owner: string; hash: string };
export type MyPhoto = { hash: string | null; removedByAdmin: boolean };
export type Crop = { x: number; y: number; size: number };
export type PickedPhoto = { token: string; preview: string; width: number; height: number; previewWidth: number; previewHeight: number };
export function profilePhotos(): Promise<PhotoEntry[]>;
export function profilePhotoData(hash: string): Promise<string>; // base64
export function profileMyPhoto(): Promise<MyPhoto>;
export function profilePickPhoto(): Promise<PickedPhoto | null>;
export function profileSetPhoto(token: string, crop: Crop): Promise<PhotoEntry>;
export function profileClearPhoto(): Promise<void>;
export function profileAdminRemovePhoto(owner: string): Promise<void>;
```

### 3.2 Penyimpan foto (`src/components/profilePhotos.ts`)

Store tingkat modul dengan `useSyncExternalStore`: peta `owner -> hash` dari `profilePhotos()`, dimuat sekali saat dipakai pertama, dimuat ulang saat event `mira://feature` dengan `topic === "profile"` dan setelah perubahan lokal (`refreshProfilePhotos()`). Data URL per hash di-cache (`data:image/jpeg;base64,...`), dimuat malas saat avatar tampil. Di luar Tauri (tes, vite biasa) peta kosong, tanpa error.

```ts
export function usePhotoUrl(publicKey: string | null | undefined): string | null;
export function refreshProfilePhotos(): Promise<void>;
```

### 3.3 Komponen `Avatar` (`src/components/Avatar.tsx`)

```tsx
type AvatarProps = {
  name: string;                       // untuk inisial dan teks alternatif
  publicKey?: string | null;          // tanpa kunci: selalu inisial
  size?: "sm" | "md" | "lg";          // 24, 32, 72 px; abaikan kalau className lama yang menentukan ukuran
  className?: string;                 // kelas lama (misalnya "conv-avatar", "avatar tc-av") tetap dipakai
  decorative?: boolean;               // bawaan true: aria-hidden, nama sudah tertulis di dekatnya
  online?: boolean;                   // titik online opsional
  onlineLabel?: string;               // teks pembaca layar untuk titik online
  title?: string;
  onContextMenu?: React.MouseEventHandler<HTMLElement>;
};
```

- Elemen akar `<span>` dengan `className` (bawaan `"avatar avatar-md"`) supaya penggantian di layar lama tidak mengubah ukuran.
- Ada foto: `<img src=dataUrl alt=...>` memenuhi lingkaran (`object-fit: cover`, `border-radius: inherit`). `onError`: kembali ke inisial.
- `decorative` true: akar `aria-hidden="true"`, `alt=""`. False: akar `role="img"` dengan `aria-label={name}`.
- Inisial dari `initials()` (tidak diubah).

Penggantian di layar: hanya mengganti elemen avatar dengan `<Avatar .../>` dan import-nya. Kelas lama diteruskan lewat `className`. Kalau layar tidak punya kunci publik orangnya, kirim tanpa `publicKey` dan catat di laporan agent.

### 3.4 Mengganti foto

- `src/screens/settings/ProfileSection.tsx`: bagian Profil baru, paling atas di Pengaturan. Avatar besar, nama, tombol "Ganti foto", "Hapus foto" (dengan konfirmasi), catatan kalau foto dihapus superadmin. Untuk superadmin: daftar "Foto anggota" (orang lain yang punya foto) dengan tombol "Hapus foto" per orang dan konfirmasi.
- `src/components/profile/PhotoCropDialog.tsx`: dialog potong. Pratinjau di bingkai persegi dengan masker lingkaran, geser dengan seret mouse dan tombol panah (Shift: langkah besar), zoom dengan slider (`<input type="range">`), roda mouse, dan tombol `+`/`-`. Simpan memanggil `profileSetPhoto(token, crop)` dengan kotak dalam piksel sumber.
- Antarmuka pemotong untuk dipakai Pengaturan dan Shell (dibuat F2b):

  ```tsx
  // src/components/profile/PhotoCropDialog.tsx
  export function PhotoCropDialog(props: { picked: PickedPhoto; onCancel: () => void; onSaved: (entry: PhotoEntry) => void }): JSX.Element;
  // src/components/profile/useChangePhoto.tsx
  // start(): buka dialog file Rust; kalau dipilih, tampilkan PhotoCropDialog; setelah simpan panggil refreshProfilePhotos() lalu onDone.
  export function useChangePhoto(onDone?: () => void): { start: () => void; busy: boolean; error: AppError | null; element: ReactNode };
  ```
  Error dari pilih file (format, ukuran) ditampilkan pemanggil lewat `error` (pakai `ErrorAlert` yang ada).
- `src/screens/shell/Shell.tsx`: blok `side-me` jadi tombol yang membuka menu kecil: "Ganti foto", "Hapus foto" (kalau ada), "Buka profil" (ke Pengaturan > Profil).
- Teks baru di `src/i18n/profile.id.ts`/`.en.ts` (+ `profile.ts` dengan `defineText`).

### 3.5 Label yang dipakai e2e (bahasa Indonesia, nama aksesibel persis)

- Pengaturan: tombol navigasi bagian "Profil"; judul bagian "Profil".
- Tombol "Ganti foto", "Hapus foto"; dialog konfirmasi hapus dengan tombol "Hapus foto".
- Dialog pemotong: judul "Atur foto profil"; slider "Perbesar"; tombol "Simpan foto" dan "Batal". Area foto yang bisa digeser: `role="group"` dengan nama "Posisi foto", fokus keyboard, panah menggeser.
- Shell: tombol `side-me` dengan nama "Menu profil Anda"; item menu "Ganti foto", "Hapus foto", "Buka profil".
- Superadmin: daftar berjudul "Foto anggota"; tombol per orang "Hapus foto <nama>".
- Avatar yang menampilkan foto berisi `<img class="avatar-img">`; tanpa foto tidak ada `img`. Akar avatar diberi `data-avatar-key="<kunci publik>"` kalau kunci diketahui.

## 4. Pembagian kerja (file tidak boleh tumpang tindih)

| Agent | File |
|---|---|
| R1 record dan sinkron | `profile/{record,schema,store,sync,runtime,commands,tests}.rs`, `profile/mod.rs` (hanya baris modul dan re-export miliknya), `lib.rs`, `db/migrations.rs`, `ui_lang.rs` |
| R2 gambar | `profile/image.rs`, `Cargo.toml` |
| F1 Avatar | `src/components/Avatar.tsx`, `src/components/avatar.css`, `src/components/profilePhotos.ts`, `src/api/profile.ts`, tes keduanya |
| F2 Profil, Shell, error | `src/screens/settings/*`, `src/screens/shell/*`, `src/i18n/profile.*`, `src/i18n/errors-rust.*`, `src/i18n/settings*`, `src/i18n/shell*` |
| F2b Pemotong | `src/components/profile/*` (`PhotoCropDialog.tsx`, `photoCrop.ts` hitungan murni, tes, css), `src/i18n/profile-crop.*` |
| F3 layar board, dokumen | `src/screens/board/*`, `src/screens/docs/DocumentDetail.tsx` |
| F4 layar chat | `src/screens/chat/*` (avatar saja) |
| F5 layar org | `src/screens/org/*` (avatar saja) |
| E e2e | `scripts/profile-e2e.mjs` |

## 5. Selesai berarti

`cargo test`, `cargo clippy --all-targets -- -D warnings`, `npx tsc --noEmit`, `npx vitest run` lulus; e2e baru dua instance; `chat-e2e`, `board-e2e`, `org-e2e`, `english-e2e` lulus satu per satu; screenshot di `docs/progress/screenshots/foto-profil/`; laporan `docs/progress/foto-profil.md`.
