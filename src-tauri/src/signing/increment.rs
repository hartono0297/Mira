//! Bukti stempel: versi bertanda tangan baru harus berupa incremental update
//! dari versi sebelumnya yang hanya menambah stempel (dan paling banyak satu
//! halaman catatan di akhir). Lihat `docs/plans/sinkron-dokumen-ttd.md`
//! bagian "Bukti stempel".
//!
//! STUB sementara (fondasi): hanya memeriksa awalan byte. Diganti tugas C.

/// Hasil pemeriksaan yang lolos.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncrementInfo {
    /// Halaman baru di akhir (0 atau 1).
    pub added_pages: usize,
}

/// Alasan penolakan. `code`: `version_not_prefix`, `version_changes_content`,
/// atau `pdf_invalid`. `message` dalam bahasa Indonesia, untuk layar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncrementError {
    pub code: &'static str,
    pub message: String,
}

/// Memeriksa bahwa `new` = `old` + incremental update yang hanya menambah
/// stempel. Murni (tanpa IO); pemanggil menyimpan hasilnya.
pub fn check_increment(old: &[u8], new: &[u8]) -> Result<IncrementInfo, IncrementError> {
    if new.len() <= old.len() || !new.starts_with(old) {
        return Err(IncrementError {
            code: "version_not_prefix",
            message: "Versi baru tidak dibangun di atas versi sebelumnya.".into(),
        });
    }
    Ok(IncrementInfo { added_pages: 0 })
}

/// Pembuat PDF untuk tes (dipakai juga oleh tes sinkron tanda tangan).
#[cfg(test)]
pub mod testing {
    /// PDF kecil yang sah dengan `pages` halaman berisi teks.
    pub fn sample_pdf(pages: usize) -> Vec<u8> {
        format!("%PDF-1.7\n% stub {pages} halaman\n%%EOF\n").into_bytes()
    }

    /// Incremental update sah: stempel di halaman 1 dan `doc_tag` di Info.
    pub fn stamp(old: &[u8], doc_tag: &str) -> Vec<u8> {
        let mut out = old.to_vec();
        out.extend_from_slice(format!("\n% stempel {doc_tag}\n%%EOF\n").as_bytes());
        out
    }

    /// Seperti `stamp`, ditambah satu halaman catatan di akhir.
    pub fn stamp_with_audit_page(old: &[u8], doc_tag: &str) -> Vec<u8> {
        let mut out = stamp(old, doc_tag);
        out.extend_from_slice(b"% halaman catatan\n%%EOF\n");
        out
    }

    /// Incremental update yang juga mengganti isi halaman lama: harus ditolak.
    pub fn tamper(old: &[u8], doc_tag: &str) -> Vec<u8> {
        let mut out = old.to_vec();
        if let Some(b) = out.get_mut(10) {
            *b ^= 1;
        }
        out.extend_from_slice(format!("\n% ubah isi {doc_tag}\n%%EOF\n").as_bytes());
        out
    }
}
