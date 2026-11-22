//! Penyimpanan berkas PDF berdasarkan hash BLAKE3.
//!
//! - `BlobDocumentStore`: yang dipakai aplikasi, di atas blob store Tahap 4
//!   (`<data_dir>/blobs`), dengan cadangan berkas lama `ttd-berkas`.
//! - `FolderStore`: penyimpanan lama `<root>/<2 hex pertama>/<hash>.pdf`
//!   (root `<data_dir>/ttd-berkas`), sekarang hanya dibaca sebagai cadangan.
//! - `MemoryStore`: untuk tes.

use std::collections::HashMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use rand_core::{OsRng, RngCore};

use super::err;
use super::seal::{hash_hex, is_hash_hex};
use crate::blobs::{BlobHash, BlobStore};
use crate::error::{AppError, AppResult};

/// Batas ukuran PDF yang diimpor (dibuka untuk permintaan baru): 50 MB.
pub const MAX_PDF_BYTES: usize = 50 * 1024 * 1024;

/// Batas ukuran PDF versi bertanda tangan: 100 MB. pdf-lib menyimpan ulang
/// tanpa object stream, jadi hasil stempel bisa sekitar dua kali berkas
/// asli. Ini juga batas penyimpanan (`put`) dan batas file yang diperiksa.
pub const MAX_SIGNED_PDF_BYTES: usize = 100 * 1024 * 1024;

/// Penyimpanan berkas PDF yang dialamatkan dengan hash BLAKE3 (64 hex).
///
/// Ini antarmuka sementara. Saat branch Tahap 5 digabung dengan Tahap 4,
/// implementasinya diganti blob store BLAKE3 Tahap 4; pemanggil cukup
/// bergantung pada trait ini.
///
/// `get` TIDAK memverifikasi bahwa isi berkas cocok dengan hash yang diminta.
/// Pemanggil yang memeriksa (`seal::check_bytes`), supaya berkas yang diubah
/// di luar Mira bisa dilaporkan sebagai "berubah", bukan disembunyikan
/// sebagai "tidak ada".
pub trait DocumentStore: Send + Sync {
    /// Menyimpan `bytes` dan mengembalikan hash BLAKE3-nya. Idempoten; kalau
    /// berkas dengan hash itu sudah ada tetapi isinya rusak, berkas ditulis
    /// ulang.
    fn put(&self, bytes: &[u8]) -> AppResult<String>;
    /// Isi berkas apa adanya, atau `None` kalau tidak ada. Hash yang bukan
    /// 64 hex huruf kecil adalah error.
    fn get(&self, hash: &str) -> AppResult<Option<Vec<u8>>>;
    /// Benar kalau berkas dengan hash itu ada (tanpa memeriksa isinya).
    fn contains(&self, hash: &str) -> AppResult<bool>;
    /// Ukuran berkas dalam byte, atau `None` kalau tidak ada.
    fn size(&self, hash: &str) -> AppResult<Option<u64>> {
        Ok(self.get(hash)?.map(|b| b.len() as u64))
    }
}

fn check_size(bytes: &[u8]) -> AppResult<()> {
    if bytes.len() > MAX_SIGNED_PDF_BYTES {
        return Err(err(
            "pdf_too_large",
            "Ukuran PDF melebihi batas 100 MB. Perkecil berkasnya dulu, lalu coba lagi.",
        ));
    }
    Ok(())
}

fn check_hash(hash: &str) -> AppResult<()> {
    if !is_hash_hex(hash) {
        return Err(err(
            "pdf_invalid",
            "Kode berkas PDF tidak valid. Kode berkas terdiri dari 64 karakter hex huruf kecil.",
        ));
    }
    Ok(())
}

/// Implementasi sementara di folder lokal: `<root>/<2 hex>/<hash>.pdf`.
#[derive(Debug, Clone)]
pub struct FolderStore {
    root: PathBuf,
}

impl FolderStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Path berkas untuk `hash`. Hanya dipanggil setelah `check_hash`, jadi
    /// `hash` tidak bisa berisi `..` atau pemisah folder.
    fn path_for(&self, hash: &str) -> PathBuf {
        self.root.join(&hash[..2]).join(format!("{hash}.pdf"))
    }

    fn io_error(&self, action: &str, e: io::Error) -> AppError {
        AppError::Internal(format!(
            "Berkas PDF tidak bisa {action} di folder {}. Detail: {e}",
            self.root.display()
        ))
    }

    /// Tulis ke berkas sementara di folder yang sama, `sync_all`, lalu
    /// `rename` ke `path`, supaya berkas setengah jadi tidak pernah terlihat.
    fn write_atomic(&self, path: &Path, hash: &str, bytes: &[u8]) -> AppResult<()> {
        let dir = path.parent().unwrap_or(&self.root);
        fs::create_dir_all(dir).map_err(|e| self.io_error("disimpan", e))?;
        let tmp = dir.join(format!(".{hash}.{:016x}.tmp", OsRng.next_u64()));
        let result = (|| -> io::Result<()> {
            let mut file = fs::File::create_new(&tmp)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&tmp, path)
        })();
        if let Err(e) = result {
            let _ = fs::remove_file(&tmp);
            return Err(self.io_error("disimpan", e));
        }
        Ok(())
    }
}

impl DocumentStore for FolderStore {
    fn put(&self, bytes: &[u8]) -> AppResult<String> {
        check_size(bytes)?;
        let hash = hash_hex(bytes);
        let path = self.path_for(&hash);
        match fs::read(&path) {
            Ok(existing) if existing == bytes => return Ok(hash),
            // Ada tetapi isinya beda (rusak atau diubah): tulis ulang.
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(self.io_error("dibaca", e)),
        }
        self.write_atomic(&path, &hash, bytes)?;
        Ok(hash)
    }

    fn get(&self, hash: &str) -> AppResult<Option<Vec<u8>>> {
        check_hash(hash)?;
        match fs::read(self.path_for(hash)) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(self.io_error("dibaca", e)),
        }
    }

    fn contains(&self, hash: &str) -> AppResult<bool> {
        check_hash(hash)?;
        match fs::metadata(self.path_for(hash)) {
            Ok(meta) => Ok(meta.is_file()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(self.io_error("dibaca", e)),
        }
    }
}

impl FolderStore {
    /// Menghapus berkas `hash` kalau ada (dipakai saat berkas lama dipindah
    /// ke blob store).
    fn remove(&self, hash: &str) -> AppResult<()> {
        check_hash(hash)?;
        match fs::remove_file(self.path_for(hash)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(self.io_error("dihapus", e)),
        }
    }
}

/// Penyimpanan PDF tanda tangan di blob store Tahap 4 (`<data_dir>/blobs`),
/// dipakai aplikasi sejak sinkron antar laptop.
///
/// Berkas lama dari `FolderStore` (`<data_dir>/ttd-berkas`) dibaca sebagai
/// cadangan. Saat pertama dibaca dan isinya cocok dengan hash-nya, berkas itu
/// dipindah ke blob store. Berkas lama yang isinya sudah berubah dibiarkan di
/// tempatnya dan dikembalikan apa adanya, supaya pemanggil bisa melaporkannya
/// sebagai "berubah".
#[derive(Debug, Clone)]
pub struct BlobDocumentStore {
    blobs: BlobStore,
    legacy: Option<FolderStore>,
}

impl BlobDocumentStore {
    pub fn new(blobs: BlobStore, legacy: Option<FolderStore>) -> Self {
        Self { blobs, legacy }
    }

    /// Blob store `<data_dir>/blobs` dengan cadangan `<data_dir>/ttd-berkas`.
    pub fn in_data_dir(data_dir: &Path) -> AppResult<Self> {
        Ok(Self::new(
            BlobStore::in_data_dir(data_dir)?,
            Some(FolderStore::new(data_dir.join(LEGACY_FOLDER))),
        ))
    }

    pub fn blobs(&self) -> &BlobStore {
        &self.blobs
    }

    fn blob_hash(hash: &str) -> AppResult<BlobHash> {
        check_hash(hash)?;
        BlobHash::parse(hash)
    }

    /// Memindah berkas lama `hash` ke blob store kalau ada dan utuh. Hasilnya
    /// isi berkas lama (utuh atau tidak), atau `None` kalau tidak ada.
    fn migrate(&self, hash: &str) -> AppResult<Option<Vec<u8>>> {
        let Some(legacy) = &self.legacy else {
            return Ok(None);
        };
        let Some(bytes) = legacy.get(hash)? else {
            return Ok(None);
        };
        if hash_hex(&bytes) == hash {
            self.blobs.put_bytes(&bytes)?;
            legacy.remove(hash)?;
        }
        Ok(Some(bytes))
    }

    /// Path berkas `hash` di blob store (berkas lama dipindah dulu), atau
    /// `None` kalau tidak ada di laptop ini.
    pub fn path_for(&self, hash: &str) -> AppResult<Option<PathBuf>> {
        let h = Self::blob_hash(hash)?;
        if !self.blobs.contains(&h) {
            self.migrate(hash)?;
        }
        Ok(self.blobs.contains(&h).then(|| self.blobs.path_of(&h)))
    }
}

/// Subfolder `data_dir` milik `FolderStore` lama.
pub const LEGACY_FOLDER: &str = "ttd-berkas";

impl DocumentStore for BlobDocumentStore {
    fn put(&self, bytes: &[u8]) -> AppResult<String> {
        check_size(bytes)?;
        let hash = hash_hex(bytes);
        let h = BlobHash::parse(&hash)?;
        if self.blobs.contains(&h) {
            match self.blobs.read_all(&h) {
                Ok(existing) if existing == bytes => return Ok(hash),
                // Rusak atau diubah (panjang sama pun): hapus lalu tulis ulang.
                _ => {
                    self.blobs.remove(&h)?;
                }
            }
        }
        let info = self.blobs.put_bytes(bytes)?;
        Ok(info.hash.as_str().to_owned())
    }

    fn get(&self, hash: &str) -> AppResult<Option<Vec<u8>>> {
        let h = Self::blob_hash(hash)?;
        if self.blobs.contains(&h) {
            return self.blobs.read_all(&h).map(Some);
        }
        self.migrate(hash)
    }

    fn contains(&self, hash: &str) -> AppResult<bool> {
        let h = Self::blob_hash(hash)?;
        if self.blobs.contains(&h) {
            return Ok(true);
        }
        match &self.legacy {
            Some(legacy) => legacy.contains(hash),
            None => Ok(false),
        }
    }

    fn size(&self, hash: &str) -> AppResult<Option<u64>> {
        let h = Self::blob_hash(hash)?;
        if self.blobs.contains(&h) {
            return self.blobs.size(&h).map(Some);
        }
        Ok(self.get(hash)?.map(|b| b.len() as u64))
    }
}

/// Penyimpanan di memori untuk tes, termasuk tes service.
#[derive(Debug, Default)]
pub struct MemoryStore {
    files: Mutex<HashMap<String, Vec<u8>>>,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }

    fn files(&self) -> MutexGuard<'_, HashMap<String, Vec<u8>>> {
        self.files.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Mengganti isi berkas `hash` tanpa mengubah hash-nya, untuk
    /// mensimulasikan berkas yang diubah di luar Mira.
    pub fn tamper(&self, hash: &str, bytes: &[u8]) {
        self.files().insert(hash.to_owned(), bytes.to_vec());
    }

    /// Menghapus berkas `hash`, untuk mensimulasikan berkas yang hilang.
    pub fn remove(&self, hash: &str) {
        self.files().remove(hash);
    }
}

impl DocumentStore for MemoryStore {
    fn put(&self, bytes: &[u8]) -> AppResult<String> {
        check_size(bytes)?;
        let hash = hash_hex(bytes);
        let mut files = self.files();
        if files.get(&hash).map(Vec::as_slice) != Some(bytes) {
            files.insert(hash.clone(), bytes.to_vec());
        }
        Ok(hash)
    }

    fn get(&self, hash: &str) -> AppResult<Option<Vec<u8>>> {
        check_hash(hash)?;
        Ok(self.files().get(hash).cloned())
    }

    fn contains(&self, hash: &str) -> AppResult<bool> {
        check_hash(hash)?;
        Ok(self.files().contains_key(hash))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::signing::seal::{Integrity, check_bytes};

    const PDF: &[u8] = b"%PDF-1.7\n1 0 obj <<>> endobj\n%%EOF\n";

    fn folder() -> (tempfile::TempDir, FolderStore) {
        let tmp = tempfile::tempdir().unwrap();
        let store = FolderStore::new(tmp.path().join("ttd-berkas"));
        (tmp, store)
    }

    fn evil_hashes() -> Vec<String> {
        vec![
            String::new(),
            "../..".into(),
            format!("../../{}", "a".repeat(58)),
            format!("..\\..\\{}", "a".repeat(58)),
            format!("{}/{}", "a".repeat(31), "a".repeat(32)),
            "A".repeat(64),
            "a".repeat(63),
            "a".repeat(65),
        ]
    }

    #[test]
    fn folder_put_get_contains() {
        let (_tmp, store) = folder();
        let hash = store.put(PDF).unwrap();
        assert_eq!(hash, hash_hex(PDF));
        let path = store.root().join(&hash[..2]).join(format!("{hash}.pdf"));
        assert_eq!(fs::read(&path).unwrap(), PDF);
        assert!(store.contains(&hash).unwrap());
        assert_eq!(store.get(&hash).unwrap().as_deref(), Some(PDF));

        let absent = hash_hex(b"lain");
        assert!(!store.contains(&absent).unwrap());
        assert_eq!(store.get(&absent).unwrap(), None);
    }

    #[test]
    fn folder_put_is_idempotent_and_leaves_no_temp_files() {
        let (_tmp, store) = folder();
        let first = store.put(PDF).unwrap();
        let second = store.put(PDF).unwrap();
        assert_eq!(first, second);
        let dir = store.root().join(&first[..2]);
        let names: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, vec![format!("{first}.pdf")]);
    }

    #[test]
    fn folder_get_returns_tampered_bytes_and_put_repairs() {
        let (_tmp, store) = folder();
        let hash = store.put(PDF).unwrap();
        let path = store.root().join(&hash[..2]).join(format!("{hash}.pdf"));
        fs::write(&path, b"%PDF-1.7 diubah").unwrap();

        // get tidak menyembunyikan perubahan.
        let got = store.get(&hash).unwrap();
        assert_eq!(got.as_deref(), Some(&b"%PDF-1.7 diubah"[..]));
        assert_eq!(check_bytes(&hash, got.as_deref()), Integrity::Changed);

        assert_eq!(store.put(PDF).unwrap(), hash);
        assert_eq!(fs::read(&path).unwrap(), PDF);
        assert_eq!(
            check_bytes(&hash, store.get(&hash).unwrap().as_deref()),
            Integrity::Intact
        );

        fs::remove_file(&path).unwrap();
        assert_eq!(
            check_bytes(&hash, store.get(&hash).unwrap().as_deref()),
            Integrity::Missing
        );
    }

    #[test]
    fn folder_rejects_malicious_hashes() {
        let (tmp, store) = folder();
        fs::write(tmp.path().join("rahasia.pdf"), b"jangan dibaca").unwrap();
        for bad in evil_hashes() {
            assert_eq!(store.get(&bad).unwrap_err().code(), "pdf_invalid", "{bad}");
            assert_eq!(
                store.contains(&bad).unwrap_err().code(),
                "pdf_invalid",
                "{bad}"
            );
        }
        assert!(!store.root().exists(), "tidak ada folder yang dibuat");
    }

    #[test]
    fn folder_io_error_mentions_folder() {
        let tmp = tempfile::tempdir().unwrap();
        // Root berupa berkas biasa, jadi folder di bawahnya tidak bisa dibuat.
        let root = tmp.path().join("bukan-folder");
        fs::write(&root, b"x").unwrap();
        let store = FolderStore::new(root.clone());
        let e = store.put(PDF).unwrap_err();
        assert_eq!(e.code(), "internal");
        assert!(e.to_string().contains(&root.display().to_string()), "{e}");
    }

    #[test]
    fn put_rejects_too_large() {
        let big = vec![0u8; MAX_SIGNED_PDF_BYTES + 1];
        let (_tmp, folder) = folder();
        assert_eq!(folder.put(&big).unwrap_err().code(), "pdf_too_large");
        assert_eq!(
            MemoryStore::new().put(&big).unwrap_err().code(),
            "pdf_too_large"
        );
    }

    #[test]
    fn memory_store_round_trip_tamper_and_repair() {
        let store = MemoryStore::new();
        let hash = store.put(PDF).unwrap();
        assert_eq!(hash, hash_hex(PDF));
        assert!(store.contains(&hash).unwrap());
        assert_eq!(store.put(PDF).unwrap(), hash);

        store.tamper(&hash, b"%PDF-1.7 diubah");
        let got = store.get(&hash).unwrap();
        assert_eq!(got.as_deref(), Some(&b"%PDF-1.7 diubah"[..]));
        assert_eq!(check_bytes(&hash, got.as_deref()), Integrity::Changed);

        store.put(PDF).unwrap();
        assert_eq!(store.get(&hash).unwrap().as_deref(), Some(PDF));

        store.remove(&hash);
        assert!(!store.contains(&hash).unwrap());
        assert_eq!(store.get(&hash).unwrap(), None);

        for bad in evil_hashes() {
            assert_eq!(store.get(&bad).unwrap_err().code(), "pdf_invalid");
            assert_eq!(store.contains(&bad).unwrap_err().code(), "pdf_invalid");
        }
    }

    fn blob_store() -> (tempfile::TempDir, BlobDocumentStore) {
        let tmp = tempfile::tempdir().unwrap();
        let store = BlobDocumentStore::in_data_dir(tmp.path()).unwrap();
        (tmp, store)
    }

    #[test]
    fn blob_store_put_get_contains_size() {
        let (_tmp, store) = blob_store();
        let hash = store.put(PDF).unwrap();
        assert_eq!(hash, hash_hex(PDF));
        assert_eq!(store.put(PDF).unwrap(), hash, "idempoten");
        assert!(store.contains(&hash).unwrap());
        assert_eq!(store.get(&hash).unwrap().as_deref(), Some(PDF));
        assert_eq!(store.size(&hash).unwrap(), Some(PDF.len() as u64));
        let path = store.path_for(&hash).unwrap().unwrap();
        assert_eq!(fs::read(&path).unwrap(), PDF);

        let absent = hash_hex(b"lain");
        assert!(!store.contains(&absent).unwrap());
        assert_eq!(store.get(&absent).unwrap(), None);
        assert_eq!(store.size(&absent).unwrap(), None);
        assert_eq!(store.path_for(&absent).unwrap(), None);
    }

    #[test]
    fn blob_store_get_does_not_verify_and_put_repairs_same_length() {
        let (_tmp, store) = blob_store();
        let hash = store.put(PDF).unwrap();
        let path = store.path_for(&hash).unwrap().unwrap();
        let mut damaged = PDF.to_vec();
        damaged[3] ^= 1;
        let mut perms = fs::metadata(&path).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        fs::set_permissions(&path, perms).unwrap();
        fs::write(&path, &damaged).unwrap();

        let got = store.get(&hash).unwrap();
        assert_eq!(check_bytes(&hash, got.as_deref()), Integrity::Changed);
        assert_eq!(store.put(PDF).unwrap(), hash);
        assert_eq!(store.get(&hash).unwrap().as_deref(), Some(PDF));
    }

    #[test]
    fn blob_store_moves_legacy_files_on_first_read() {
        let tmp = tempfile::tempdir().unwrap();
        let legacy = FolderStore::new(tmp.path().join(LEGACY_FOLDER));
        let hash = legacy.put(PDF).unwrap();
        let broken = legacy.put(b"%PDF-1.7 lama").unwrap();
        let broken_path = legacy.path_for(&broken);
        fs::write(&broken_path, b"%PDF-1.7 diubah").unwrap();

        let store = BlobDocumentStore::in_data_dir(tmp.path()).unwrap();
        assert!(store.contains(&hash).unwrap());
        assert_eq!(store.get(&hash).unwrap().as_deref(), Some(PDF));
        assert!(!legacy.contains(&hash).unwrap(), "dipindah");
        assert!(store.blobs().contains(&BlobHash::parse(&hash).unwrap()));
        assert_eq!(store.get(&hash).unwrap().as_deref(), Some(PDF));

        // Berkas lama yang berubah dikembalikan apa adanya dan tidak dipindah.
        let got = store.get(&broken).unwrap();
        assert_eq!(check_bytes(&broken, got.as_deref()), Integrity::Changed);
        assert!(broken_path.exists());
        assert_eq!(store.path_for(&broken).unwrap(), None);
    }

    #[test]
    fn blob_store_rejects_malicious_hashes_and_large_files() {
        let (_tmp, store) = blob_store();
        for bad in evil_hashes() {
            assert_eq!(store.get(&bad).unwrap_err().code(), "pdf_invalid", "{bad}");
            assert_eq!(store.contains(&bad).unwrap_err().code(), "pdf_invalid");
            assert_eq!(store.path_for(&bad).unwrap_err().code(), "pdf_invalid");
        }
        let big = vec![0u8; MAX_SIGNED_PDF_BYTES + 1];
        assert_eq!(store.put(&big).unwrap_err().code(), "pdf_too_large");
    }

    #[test]
    fn stores_are_usable_as_trait_objects() {
        let (_tmp, folder) = folder();
        let stores: Vec<Box<dyn DocumentStore>> =
            vec![Box::new(folder), Box::new(MemoryStore::new())];
        for store in stores {
            let hash = store.put(PDF).unwrap();
            assert_eq!(store.get(&hash).unwrap().as_deref(), Some(PDF));
        }
    }
}
