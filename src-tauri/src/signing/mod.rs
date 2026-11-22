//! Tahap 5: tanda tangan PDF (bagian lokal, tanpa jaringan).
//!
//! - `pin`: aturan PIN, kunci turunan PIN (Argon2id), enkripsi gambar
//!   tanda tangan (XChaCha20-Poly1305), dan batas percobaan.
//! - `vault`: tanda tangan tersimpan di SQLite (`sign_saved_signature`).
//! - `request`: model permintaan tanda tangan (urutan, status, aturan Tamu).
//! - `seal`: hash BLAKE3, catatan jejak audit yang ditandatangani kunci laptop.
//! - `store`: antarmuka `DocumentStore` untuk file PDF (implementasi sementara
//!   berbasis folder; diganti blob store Tahap 4 saat merge).
//! - `schema`: SQL migrasi tanda tangan.
//!
//! Rencana dan kontrak perintah: `docs/plans/tahap-5-lokal.md`.

pub mod pin;
pub mod request;
pub mod schema;
pub mod seal;
pub mod store;
pub mod vault;

use crate::error::AppError;

/// Error tanda tangan dengan kode stabil (lihat `AppError::Signing`).
pub(crate) fn err(code: &'static str, message: impl Into<String>) -> AppError {
    AppError::Signing {
        code,
        message: message.into(),
    }
}
