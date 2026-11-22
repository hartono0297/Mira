//! Titik sambung jaringan untuk tanda tangan PDF.
//!
//! Record sinkron (`signing::peer_sync`) ditulis `service.rs` di transaksi
//! yang sama dengan perubahan lokal, jadi record dan perubahan selalu
//! tersimpan bersama. Setelah transaksi selesai, `service.rs` memanggil
//! `SignOutbox` supaya jaringan menawarkan record baru ke laptop rekan.
//!
//! Penting: `SignContext` berjalan di dalam `MiraState::with_core` (kunci
//! `Mutex` yang tidak reentrant), jadi implementasi trait ini TIDAK boleh
//! mengambil kunci itu. `HubOutbox` hanya memanggil
//! `FeatureHub::notify_changed`, yang murah dan tidak menyentuh database.
//!
//! Yang dikirim, ke siapa, dan apa yang diperiksa penerima: lihat
//! `signing::peer_sync` dan `docs/plans/sinkron-dokumen-ttd.md` bagian 5.

use std::sync::Arc;

use super::request::SignRequest;
use crate::error::AppResult;
use crate::network::feature::{FeatureHub, TOPIC_SIGN};

/// Pemberitahuan perubahan lokal. Lihat dokumentasi modul.
pub trait SignOutbox: Send + Sync {
    /// Permintaan baru tersimpan (status berjalan, belum ada tanda tangan).
    fn request_created(&self, request: &SignRequest) -> AppResult<()>;
    /// `signer` (kunci publik) baru saja menandatangani; `file_hash` adalah
    /// versi barunya (sama dengan `request.current_hash`). Kalau
    /// `request.status` sudah selesai, ini versi final.
    fn version_signed(&self, request: &SignRequest, signer: &str, file_hash: &str)
    -> AppResult<()>;
    /// Pengirim membatalkan permintaan.
    fn request_cancelled(&self, request: &SignRequest) -> AppResult<()>;
}

/// Tidak mengirim apa pun (tes, atau sebelum hub tersedia).
#[derive(Debug, Default, Clone, Copy)]
pub struct LocalOnlyOutbox;

impl SignOutbox for LocalOnlyOutbox {
    fn request_created(&self, _request: &SignRequest) -> AppResult<()> {
        Ok(())
    }

    fn version_signed(
        &self,
        _request: &SignRequest,
        _signer: &str,
        _file_hash: &str,
    ) -> AppResult<()> {
        Ok(())
    }

    fn request_cancelled(&self, _request: &SignRequest) -> AppResult<()> {
        Ok(())
    }
}

/// Memberi tahu jaringan lewat `FeatureHub::notify_changed("sign")`.
#[derive(Clone)]
pub struct HubOutbox {
    hub: Arc<FeatureHub>,
}

impl HubOutbox {
    pub fn new(hub: Arc<FeatureHub>) -> Self {
        Self { hub }
    }

    fn changed(&self) -> AppResult<()> {
        self.hub.notify_changed(TOPIC_SIGN);
        Ok(())
    }
}

impl SignOutbox for HubOutbox {
    fn request_created(&self, _request: &SignRequest) -> AppResult<()> {
        self.changed()
    }

    fn version_signed(
        &self,
        _request: &SignRequest,
        _signer: &str,
        _file_hash: &str,
    ) -> AppResult<()> {
        self.changed()
    }

    fn request_cancelled(&self, _request: &SignRequest) -> AppResult<()> {
        self.changed()
    }
}
