//! Titik sambung jaringan untuk tanda tangan PDF.
//!
//! `service.rs` memanggil `SignOutbox` setelah perubahan lokal tersimpan
//! (permintaan dibuat, satu versi ditandatangani, permintaan dibatalkan).
//! Bagian lokal Tahap 5 memakai `LocalOnlyOutbox`, yang tidak mengirim apa
//! pun. Setelah jaringan Tahap 1 digabung, implementasi jaringan menggantikan
//! `LocalOnlyOutbox` di `signing::commands`.
//!
//! Yang harus dilakukan implementasi jaringan:
//!
//! - **Antre dulu, kirim kemudian.** Metode di sini dipanggil di dalam alur
//!   perintah, jadi jangan menunggu jaringan. Simpan pesan ke antrean di
//!   SQLite lalu kirim di latar belakang, dengan percobaan ulang kalau laptop
//!   tujuan sedang mati. Kembalikan `Err` hanya kalau antrean lokal pun tidak
//!   bisa ditulis; perubahan lokal sudah tersimpan saat metode ini dipanggil.
//! - **`request_created`:** kirim data permintaan (judul, urutan penanda
//!   tangan, mode) beserta file versi `original_hash` dan catatan jejak audit
//!   `created` yang bertanda tangan. Mode berurutan: hanya ke penanda tangan
//!   pertama; mode bebas: ke semua penanda tangan.
//! - **`version_signed`:** kirim file versi `file_hash` dan catatan `signed`
//!   (dan `completed` kalau sudah selesai) ke penanda tangan berikutnya (mode
//!   berurutan) dan ke pengirim permintaan, supaya semua memegang versi
//!   terbaru. Setelah selesai, versi final dikirim ke semua yang terlibat.
//! - **`request_cancelled`:** beri tahu semua penanda tangan yang belum dan
//!   yang sudah, lewat catatan `cancelled` yang bertanda tangan.
//!
//! Di sisi penerima (bukan tugas trait ini, tetapi wajib ada):
//!
//! - Verifikasi setiap catatan jejak audit dengan `seal::verify_event`
//!   memakai kunci publik pelaku, dan pastikan pelaku memang anggota aktif
//!   organisasi menurut log keanggotaan.
//! - Hitung hash BLAKE3 file yang diterima dan cocokkan dengan `hash_after`
//!   catatan; tolak kalau beda. `hash_before` harus sama dengan versi terakhir
//!   yang dikenal penerima.
//! - Periksa urutan dan hak dengan `request::SignRequest::can_sign` untuk
//!   pelaku, dan `request::validate_new` untuk pengirim permintaan (Tamu tidak
//!   boleh meminta tanda tangan; Tamu boleh menandatangani kalau tercantum).
//!   Setelah dokumen punya proyek (Tahap 4), Tamu hanya menerima dokumen dari
//!   proyek yang diizinkan untuknya.

use super::request::SignRequest;
use crate::error::AppResult;

/// Tujuan pesan tanda tangan ke laptop lain. Lihat dokumentasi modul.
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

/// Bagian lokal Tahap 5: tidak mengirim apa pun.
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
