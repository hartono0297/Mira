//! Content-addressed file store (`<data_dir>/blobs`), shared by every stage
//! that keeps file contents: documents (Tahap 4), chat attachments, signed
//! PDFs (Tahap 5).
//!
//! A blob is the exact bytes of a file, named by its BLAKE3 hash as 64
//! lowercase hex characters and stored at `<root>/<first 2 hex>/<64 hex>`.
//! Blobs never change after they are written, so two versions with the same
//! content share one file and a hash received from a rekan can be checked
//! against the bytes.
//!
//! Writes go to `<root>/tmp/` first and are renamed into place after the hash
//! is known and the data is flushed, so a crash or power cut never leaves a
//! half-written file under a valid hash.
//!
//! Small API:
//! - [`BlobStore::in_data_dir`] / [`BlobStore::open`]
//! - [`BlobStore::put_file`], [`BlobStore::put_bytes`], [`BlobStore::put_reader`]
//! - [`BlobStore::contains`], [`BlobStore::size`], [`BlobStore::path_of`]
//! - [`BlobStore::open_read`], [`BlobStore::read_all`], [`BlobStore::copy_to`]
//! - [`BlobStore::verify`], [`BlobStore::remove`]
//! - [`should_auto_replicate`] for the network sync policy (files up to about
//!   20 MB are copied to rekan automatically, larger ones on demand).

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::AppResult;

/// Length of a blob hash as text.
pub const HASH_HEX_LEN: usize = 64;

/// Files up to this size are copied to rekan automatically once sync exists;
/// larger files are downloaded when someone opens them (PRD F-CHAT-05).
pub const AUTO_REPLICATE_MAX_BYTES: u64 = 20 * 1024 * 1024;

/// True when a blob of `size` bytes should be pushed to rekan right away.
pub fn should_auto_replicate(size: u64) -> bool {
    let _ = size;
    todo!("blobs: should_auto_replicate")
}

/// BLAKE3 hash of a blob as 64 lowercase hex characters. Always valid once
/// constructed. Serializes as a plain string.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct BlobHash(String);

impl BlobHash {
    /// Accepts exactly 64 lowercase hex characters, otherwise `invalid_input`.
    pub fn parse(s: &str) -> AppResult<Self> {
        let _ = s;
        todo!("blobs: BlobHash::parse")
    }

    /// Hash of `bytes`.
    pub fn of_bytes(bytes: &[u8]) -> Self {
        let _ = bytes;
        todo!("blobs: BlobHash::of_bytes")
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for BlobHash {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl TryFrom<String> for BlobHash {
    type Error = crate::error::AppError;
    fn try_from(s: String) -> Result<Self, Self::Error> {
        BlobHash::parse(&s)
    }
}

impl From<BlobHash> for String {
    fn from(h: BlobHash) -> String {
        h.0
    }
}

/// What was stored.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobInfo {
    pub hash: BlobHash,
    pub size: u64,
}

/// Handle to a blob folder. Cheap to clone; holds only the path.
#[derive(Clone, Debug)]
pub struct BlobStore {
    root: PathBuf,
}

impl BlobStore {
    /// Folder name under the data folder.
    pub const DIR_NAME: &'static str = "blobs";

    /// `<data_dir>/blobs`, created if missing.
    pub fn in_data_dir(data_dir: &Path) -> AppResult<Self> {
        Self::open(data_dir.join(Self::DIR_NAME))
    }

    /// Opens (and creates) a store at `root`. Leftover files in `root/tmp`
    /// from an earlier crash are removed.
    pub fn open(root: impl Into<PathBuf>) -> AppResult<Self> {
        let _ = root.into();
        todo!("blobs: open")
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Copies the file at `src` into the store while hashing it (one pass,
    /// streaming, so large files do not need to fit in memory). If a blob with
    /// the same hash already exists the copy is discarded. `src` is not changed.
    pub fn put_file(&self, src: &Path) -> AppResult<BlobInfo> {
        let _ = src;
        todo!("blobs: put_file")
    }

    pub fn put_bytes(&self, bytes: &[u8]) -> AppResult<BlobInfo> {
        let _ = bytes;
        todo!("blobs: put_bytes")
    }

    /// Same as `put_file` for any reader (used later when a rekan sends a file).
    pub fn put_reader(&self, reader: &mut dyn Read) -> AppResult<BlobInfo> {
        let _ = reader;
        todo!("blobs: put_reader")
    }

    pub fn contains(&self, hash: &BlobHash) -> bool {
        let _ = hash;
        todo!("blobs: contains")
    }

    /// Size in bytes, `not_found` if the blob is not on this laptop.
    pub fn size(&self, hash: &BlobHash) -> AppResult<u64> {
        let _ = hash;
        todo!("blobs: size")
    }

    /// Where the blob lives (or would live). Callers must not write there.
    pub fn path_of(&self, hash: &BlobHash) -> PathBuf {
        let _ = hash;
        todo!("blobs: path_of")
    }

    /// `not_found` if missing.
    pub fn open_read(&self, hash: &BlobHash) -> AppResult<File> {
        let _ = hash;
        todo!("blobs: open_read")
    }

    pub fn read_all(&self, hash: &BlobHash) -> AppResult<Vec<u8>> {
        let _ = hash;
        todo!("blobs: read_all")
    }

    /// Writes the blob's bytes to `dest` (a new temporary file next to `dest`,
    /// then renamed over it). Parent folders are created. The result is an
    /// ordinary writable file.
    pub fn copy_to(&self, hash: &BlobHash, dest: &Path) -> AppResult<()> {
        let _ = (hash, dest);
        todo!("blobs: copy_to")
    }

    /// Re-hashes the stored bytes. `Ok(false)` when the file is damaged,
    /// `not_found` when missing.
    pub fn verify(&self, hash: &BlobHash) -> AppResult<bool> {
        let _ = hash;
        todo!("blobs: verify")
    }

    /// Deletes a blob (for a later clean-up of old copies). `Ok(false)` if it
    /// was not there.
    pub fn remove(&self, hash: &BlobHash) -> AppResult<bool> {
        let _ = hash;
        todo!("blobs: remove")
    }
}
