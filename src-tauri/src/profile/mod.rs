//! Profile photos (docs/plans/foto-profil.md): signed records in topic
//! `profile`, image processing, sync and Tauri commands.

pub mod commands;
pub mod image;
pub mod record;
pub mod runtime;
pub mod schema;
pub mod store;
pub mod sync;

#[cfg(test)]
mod tests;

pub use commands::{MyPhoto, PhotoEntry, PickedPhoto};
pub use record::{ProfileRecord, RecordKind};
pub use runtime::ProfileRuntime;
pub use sync::ProfileSync;

/// Feature topic for profile records.
pub const TOPIC_PROFILE: &str = "profile";
/// Side of the final photo, in pixels.
pub const PHOTO_SIZE: u32 = 256;
/// Hard limit for a final photo, also the download limit.
pub const MAX_PHOTO_BYTES: u64 = 128 * 1024;
/// Size the encoder aims for.
pub const TARGET_PHOTO_BYTES: usize = 100 * 1024;
/// Largest file the person may pick.
pub const MAX_SOURCE_BYTES: u64 = 20 * 1024 * 1024;
/// Longest side of a picked image.
pub const MAX_SOURCE_SIDE: u32 = 8000;
/// Most pixels in a picked image.
pub const MAX_SOURCE_PIXELS: u64 = 40_000_000;
/// Longest side of the preview shown in the crop dialog.
pub const PREVIEW_SIDE: u32 = 1024;

pub const PHOTO_TOO_BIG: &str = "Foto terlalu besar. Pilih file sampai 20 MB.";
pub const PHOTO_FORMAT: &str = "Format foto tidak didukung. Pilih file PNG, JPEG, atau WebP.";
pub const PHOTO_ANIMATED: &str = "Foto bergerak tidak didukung. Pilih gambar diam.";
pub const PHOTO_DIMENSIONS: &str =
    "Ukuran gambar tidak didukung. Sisi gambar harus antara 16 dan 8000 piksel.";
pub const PHOTO_BROKEN: &str = "File foto rusak atau tidak bisa dibaca.";
pub const PHOTO_CROP: &str = "Bagian foto yang dipilih tidak valid. Atur ulang potongan foto.";
pub const PHOTO_TOKEN: &str = "Foto yang dipilih sudah kedaluwarsa. Pilih foto lagi.";
pub const PHOTO_NOT_ADMIN: &str = "Hanya superadmin yang bisa menghapus foto profil orang lain.";
pub const PHOTO_NOT_MEMBER: &str = "Orang ini bukan anggota organisasi.";
pub const PHOTO_NO_ORG: &str = "Foto profil baru bisa dipakai setelah laptop ini membuat atau bergabung dengan organisasi.";
pub const PHOTO_NOT_FOUND: &str = "Foto tidak ditemukan.";
