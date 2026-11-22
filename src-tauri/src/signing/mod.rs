//! Tahap 5: tanda tangan PDF (bagian lokal, tanpa jaringan).
//!
//! - `pin`: aturan PIN, kunci turunan PIN (Argon2id), enkripsi gambar
//!   tanda tangan (XChaCha20-Poly1305), dan batas percobaan.
//! - `vault`: tanda tangan tersimpan di SQLite (`sign_saved_signature`).
//! - `request`: model permintaan tanda tangan (urutan, status, aturan Tamu).
//! - `seal`: hash BLAKE3, catatan jejak audit yang ditandatangani kunci laptop.
//! - `store`: antarmuka `DocumentStore` untuk file PDF; aplikasi memakai
//!   `BlobDocumentStore` (blob store Tahap 4, berkas lama `ttd-berkas` dibaca
//!   sebagai cadangan lalu dipindah).
//! - `session`: token unlock sekali pakai berumur 5 menit (di memori).
//! - `outbox`: pemberitahuan perubahan lokal ke jaringan (`HubOutbox`).
//! - `repo`: baca tulis tabel `sign_*` dan baris `members` yang dibutuhkan.
//! - `service`: alur lengkap (`SignContext`), bisa dites tanpa Tauri.
//! - `commands`: perintah Tauri tipis, termasuk IPC mentah untuk byte PDF.
//! - `schema`: SQL migrasi tanda tangan.
//! - `increment`: bukti bahwa versi baru hanya menambah stempel.
//! - `peer_sync`: sinkron permintaan dan versi dengan laptop rekan
//!   (`FeatureSync` dan `BlobSource` untuk `TOPIC_SIGN`, fold keadaan
//!   permintaan, unduhan file, notifikasi giliran).
//!
//! Rencana dan kontrak perintah: `docs/plans/tahap-5-lokal.md` dan
//! `docs/plans/sinkron-dokumen-ttd.md` (bagian 5 dan 6).
//!
//! Kode error tanda tangan (`AppError::Signing`): `pin_invalid`, `pin_wrong`,
//! `pin_locked`, `pin_mismatch` (frontend saja), `signature_missing`,
//! `signature_exists`, `signature_cooling` (tanda tangan dibuat dalam 24 jam
//! setelah tanda tangan lama dihapus tanpa PIN, lihat `vault`),
//! `image_invalid`, `pdf_invalid`, `pdf_too_large`, `request_invalid`,
//! `guest_cannot_request`, `not_a_signer`, `not_your_turn`, `already_signed`,
//! `request_closed`, `not_requester`, `session_expired`, `version_conflict`,
//! `tag_missing`, `export_failed`, `version_not_prefix` dan
//! `version_changes_content` (bukti stempel, `increment`), `not_available`
//! (file tidak bisa diunduh dari rekan). Error lama yang dipakai ulang:
//! `not_found`, `removed`, `database`, `internal`, `storage`.

pub mod commands;
pub mod increment;
pub mod outbox;
pub mod peer_sync;
pub mod pin;
pub mod repo;
pub mod request;
pub mod schema;
pub mod seal;
pub mod service;
pub mod session;
pub mod store;
pub mod vault;

#[cfg(test)]
mod sync_tests;
#[cfg(test)]
mod tests;

use crate::error::AppError;

/// Error tanda tangan dengan kode stabil (lihat `AppError::Signing`).
pub(crate) fn err(code: &'static str, message: impl Into<String>) -> AppError {
    AppError::Signing {
        code,
        message: message.into(),
    }
}
