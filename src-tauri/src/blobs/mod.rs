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
//! half-written file under a valid hash. Stored blobs carry the read-only
//! attribute so nothing edits them by accident.
//!
//! Small API:
//! - [`BlobStore::in_data_dir`] / [`BlobStore::open`]
//! - [`BlobStore::put_file`], [`BlobStore::put_bytes`], [`BlobStore::put_reader`]
//! - [`BlobStore::contains`], [`BlobStore::size`], [`BlobStore::path_of`]
//! - [`BlobStore::open_read`], [`BlobStore::read_all`], [`BlobStore::copy_to`]
//! - [`BlobStore::verify`], [`BlobStore::remove`]
//! - [`should_auto_replicate`] for the network sync policy (files up to about
//!   20 MB are copied to rekan automatically, larger ones on demand).

#[cfg(test)]
mod tests;

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// Length of a blob hash as text.
pub const HASH_HEX_LEN: usize = 64;

/// Files up to this size are copied to rekan automatically once sync exists;
/// larger files are downloaded when someone opens them (PRD F-CHAT-05).
pub const AUTO_REPLICATE_MAX_BYTES: u64 = 20 * 1024 * 1024;

/// Buffer size for every streaming copy in this module.
const COPY_BUF_BYTES: usize = 64 * 1024;

/// Folder under the store root that holds files still being written.
const TMP_DIR_NAME: &str = "tmp";

/// Temp files younger than this are left alone by `open` (they may belong to
/// another Mira process writing right now).
const TMP_LEFTOVER_AGE: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// True when a blob of `size` bytes should be pushed to rekan right away.
pub fn should_auto_replicate(size: u64) -> bool {
    size <= AUTO_REPLICATE_MAX_BYTES
}

/// BLAKE3 hash of a blob as 64 lowercase hex characters. Always valid once
/// constructed. Serializes as a plain string.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct BlobHash(String);

impl BlobHash {
    /// Accepts exactly 64 lowercase hex characters, otherwise `invalid_input`.
    pub fn parse(s: &str) -> AppResult<Self> {
        let valid = s.len() == HASH_HEX_LEN
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if valid {
            Ok(BlobHash(s.to_owned()))
        } else {
            Err(AppError::InvalidInput(
                "Kode isi file tidak valid. Kode harus terdiri dari 64 karakter angka 0 sampai 9 dan huruf kecil a sampai f."
                    .into(),
            ))
        }
    }

    /// Hash of `bytes`.
    pub fn of_bytes(bytes: &[u8]) -> Self {
        Self::from_blake3(blake3::hash(bytes))
    }

    fn from_blake3(hash: blake3::Hash) -> Self {
        BlobHash(hash.to_hex().to_string())
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
    ///
    /// Temp files of puts still running in this process are skipped, so
    /// opening a second handle to the same folder while another one writes is
    /// safe.
    pub fn open(root: impl Into<PathBuf>) -> AppResult<Self> {
        let store = BlobStore { root: root.into() };
        let tmp = store.tmp_dir();
        fs::create_dir_all(&tmp).map_err(|e| storage_err("tidak bisa dibuat", &tmp, &e))?;
        store.clean_tmp()?;
        Ok(store)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Copies the file at `src` into the store while hashing it (one pass,
    /// streaming, so large files do not need to fit in memory). If a blob with
    /// the same hash already exists the copy is discarded. `src` is not changed.
    pub fn put_file(&self, src: &Path) -> AppResult<BlobInfo> {
        let mut file = File::open(src).map_err(|e| storage_err("tidak bisa dibuka", src, &e))?;
        self.put_stream(&mut file, Some(src))
    }

    pub fn put_bytes(&self, bytes: &[u8]) -> AppResult<BlobInfo> {
        let mut reader = bytes;
        self.put_stream(&mut reader, None)
    }

    /// Same as `put_file` for any reader (used later when a rekan sends a file).
    pub fn put_reader(&self, reader: &mut dyn Read) -> AppResult<BlobInfo> {
        self.put_stream(reader, None)
    }

    pub fn contains(&self, hash: &BlobHash) -> bool {
        self.path_of(hash).is_file()
    }

    /// Size in bytes, `not_found` if the blob is not on this laptop.
    pub fn size(&self, hash: &BlobHash) -> AppResult<u64> {
        let path = self.path_of(hash);
        match fs::metadata(&path) {
            Ok(meta) if meta.is_file() => Ok(meta.len()),
            Ok(_) => Err(blob_not_found()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Err(blob_not_found()),
            Err(e) => Err(storage_err("tidak bisa dibaca", &path, &e)),
        }
    }

    /// Where the blob lives (or would live). Callers must not write there.
    pub fn path_of(&self, hash: &BlobHash) -> PathBuf {
        let hex = hash.as_str();
        self.root.join(&hex[..2]).join(hex)
    }

    /// `not_found` if missing.
    pub fn open_read(&self, hash: &BlobHash) -> AppResult<File> {
        let path = self.path_of(hash);
        match File::open(&path) {
            Ok(file) => Ok(file),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Err(blob_not_found()),
            Err(e) => Err(storage_err("tidak bisa dibuka", &path, &e)),
        }
    }

    pub fn read_all(&self, hash: &BlobHash) -> AppResult<Vec<u8>> {
        let path = self.path_of(hash);
        let mut file = self.open_read(hash)?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|e| storage_err("tidak bisa dibaca", &path, &e))?;
        Ok(bytes)
    }

    /// Writes the blob's bytes to `dest` (a new temporary file next to `dest`,
    /// then renamed over it). Parent folders are created. The result is an
    /// ordinary writable file.
    pub fn copy_to(&self, hash: &BlobHash, dest: &Path) -> AppResult<()> {
        let src_path = self.path_of(hash);
        let mut src = self.open_read(hash)?;

        let parent = match dest.parent() {
            Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
            _ => PathBuf::from("."),
        };
        fs::create_dir_all(&parent).map_err(|e| storage_err("tidak bisa dibuat", &parent, &e))?;

        let temp_path = parent.join(format!(".mira-{}.tmp", random_hex()));
        let mut temp = TempFile::create(temp_path.clone(), false)?;
        copy_stream(&mut src, &src_path, temp.file(), &temp_path, |_| {})?;
        temp.finish()?;

        // Windows refuses to rename over a read-only file (for example an
        // earlier read-only view copy), so clear the attribute first.
        if let Ok(meta) = fs::symlink_metadata(dest)
            && meta.is_file()
            && meta.permissions().readonly()
        {
            set_writable(dest)?;
        }
        fs::rename(&temp.path, dest).map_err(|e| storage_err("tidak bisa ditulis", dest, &e))?;
        temp.persisted = true;
        Ok(())
    }

    /// Re-hashes the stored bytes. `Ok(false)` when the file is damaged,
    /// `not_found` when missing.
    pub fn verify(&self, hash: &BlobHash) -> AppResult<bool> {
        let path = self.path_of(hash);
        let mut file = self.open_read(hash)?;
        let mut hasher = blake3::Hasher::new();
        copy_stream(&mut file, &path, &mut io::sink(), &path, |chunk| {
            hasher.update(chunk);
        })?;
        Ok(BlobHash::from_blake3(hasher.finalize()) == *hash)
    }

    /// Deletes a blob (for a later clean-up of old copies). `Ok(false)` if it
    /// was not there.
    pub fn remove(&self, hash: &BlobHash) -> AppResult<bool> {
        let path = self.path_of(hash);
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_file() => {}
            Ok(_) => return Ok(false),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(storage_err("tidak bisa dibaca", &path, &e)),
        }
        match set_writable(&path).and_then(|()| {
            fs::remove_file(&path).map_err(|e| storage_err("tidak bisa dihapus", &path, &e))
        }) {
            Ok(()) => Ok(true),
            // Someone else removed it in the meantime.
            Err(_) if !path.exists() => Ok(false),
            Err(e) => Err(e),
        }
    }

    fn tmp_dir(&self) -> PathBuf {
        self.root.join(TMP_DIR_NAME)
    }

    /// Removes files in `tmp/` that no running put in this process owns.
    fn clean_tmp(&self) -> AppResult<()> {
        let tmp = self.tmp_dir();
        // Held during the whole scan: a put registers its name before creating
        // the file, so any unregistered file seen here is a leftover.
        let active = active_temps().lock().unwrap_or_else(|p| p.into_inner());
        let entries = fs::read_dir(&tmp).map_err(|e| storage_err("tidak bisa dibaca", &tmp, &e))?;
        for entry in entries {
            let entry = entry.map_err(|e| storage_err("tidak bisa dibaca", &tmp, &e))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if active.contains(&name) {
                continue;
            }
            // A second Mira window on the same data folder has its own running
            // puts; only files untouched for a while count as leftovers.
            let fresh = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age < TMP_LEFTOVER_AGE);
            if fresh {
                continue;
            }
            let path = entry.path();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            let result = if is_dir {
                fs::remove_dir_all(&path)
            } else {
                let _ = set_writable(&path);
                fs::remove_file(&path)
            };
            match result {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(storage_err("tidak bisa dihapus", &path, &e)),
            }
        }
        Ok(())
    }

    /// Streams `reader` into `tmp/`, hashing on the way, then moves the file
    /// to its final name. `src` names the source in error messages.
    fn put_stream(&self, reader: &mut dyn Read, src: Option<&Path>) -> AppResult<BlobInfo> {
        let tmp_dir = self.tmp_dir();
        fs::create_dir_all(&tmp_dir).map_err(|e| storage_err("tidak bisa dibuat", &tmp_dir, &e))?;
        let temp_path = tmp_dir.join(random_hex());
        let mut temp = TempFile::create(temp_path.clone(), true)?;

        let mut hasher = blake3::Hasher::new();
        let size = match src {
            Some(src) => copy_stream(reader, src, temp.file(), &temp_path, |chunk| {
                hasher.update(chunk);
            })?,
            None => copy_stream_unnamed(reader, temp.file(), &temp_path, |chunk| {
                hasher.update(chunk);
            })?,
        };
        temp.finish()?;
        let info = BlobInfo {
            hash: BlobHash::from_blake3(hasher.finalize()),
            size,
        };
        let dest = self.path_of(&info.hash);

        match fs::metadata(&dest) {
            // Same content already stored: the temp file is dropped.
            Ok(meta) if meta.is_file() && meta.len() == size => return Ok(info),
            // A damaged copy under this name (wrong length): replace it.
            Ok(meta) if meta.is_file() => set_writable(&dest)?,
            _ => {}
        }

        let dir = dest.parent().expect("blob path has a parent");
        fs::create_dir_all(dir).map_err(|e| storage_err("tidak bisa dibuat", dir, &e))?;
        set_readonly(&temp.path)?;
        match fs::rename(&temp.path, &dest) {
            Ok(()) => {
                temp.persisted = true;
                Ok(info)
            }
            // Another put of the same content won the race. Only accept the
            // existing file if it has the right length; otherwise a damaged
            // blob that could not be replaced would be reported as stored.
            Err(_) if fs::metadata(&dest).is_ok_and(|m| m.is_file() && m.len() == size) => {
                Ok(info)
            }
            Err(e) => Err(storage_err("tidak bisa disimpan", &dest, &e)),
        }
    }
}

/// Indonesian `storage` error naming the path and the OS detail.
fn storage_err(what: &str, path: &Path, err: &io::Error) -> AppError {
    AppError::Storage(format!(
        "File atau folder {} {what}. Periksa ruang disk dan izin akses. Detail: {err}",
        path.display()
    ))
}

fn blob_not_found() -> AppError {
    AppError::NotFound(
        "Isi file ini tidak ada di laptop ini. Mungkin file belum disalin dari laptop rekan."
            .into(),
    )
}

/// 32 random hex characters for temp file names.
fn random_hex() -> String {
    let mut bytes = [0u8; 16];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut bytes);
    hex::encode(bytes)
}

/// Names of temp files in a store's `tmp/` that a put in this process is
/// still writing. Keyed by file name only (random, so unique across stores).
fn active_temps() -> &'static Mutex<HashSet<String>> {
    static ACTIVE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashSet::new()))
}

fn set_readonly(path: &Path) -> AppResult<()> {
    let mut perms = fs::metadata(path)
        .map_err(|e| storage_err("tidak bisa dibaca", path, &e))?
        .permissions();
    perms.set_readonly(true);
    fs::set_permissions(path, perms).map_err(|e| storage_err("tidak bisa diubah", path, &e))
}

/// Clears the read-only attribute. On Unix only the owner write bit is added,
/// unlike `set_readonly(false)` which would make the file writable for all.
fn set_writable(path: &Path) -> AppResult<()> {
    let mut perms = fs::metadata(path)
        .map_err(|e| storage_err("tidak bisa dibaca", path, &e))?
        .permissions();
    if !perms.readonly() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        perms.set_mode(perms.mode() | 0o200);
    }
    #[cfg(not(unix))]
    #[allow(clippy::permissions_set_readonly_false)]
    perms.set_readonly(false);
    fs::set_permissions(path, perms).map_err(|e| storage_err("tidak bisa diubah", path, &e))
}

/// Copies `reader` to `writer` with a 64 KiB buffer, calling `on_chunk` for
/// every chunk. Returns the number of bytes copied.
fn copy_stream(
    reader: &mut dyn Read,
    src: &Path,
    writer: &mut dyn Write,
    dest: &Path,
    on_chunk: impl FnMut(&[u8]),
) -> AppResult<u64> {
    copy_inner(reader, writer, on_chunk).map_err(|e| match e {
        CopyError::Read(e) => storage_err("tidak bisa dibaca", src, &e),
        CopyError::Write(e) => storage_err("tidak bisa ditulis", dest, &e),
    })
}

/// `copy_stream` for a source without a path (bytes in memory, a rekan).
fn copy_stream_unnamed(
    reader: &mut dyn Read,
    writer: &mut dyn Write,
    dest: &Path,
    on_chunk: impl FnMut(&[u8]),
) -> AppResult<u64> {
    copy_inner(reader, writer, on_chunk).map_err(|e| match e {
        CopyError::Read(e) => AppError::Storage(format!(
            "Isi file tidak bisa dibaca sampai selesai. Detail: {e}"
        )),
        CopyError::Write(e) => storage_err("tidak bisa ditulis", dest, &e),
    })
}

enum CopyError {
    Read(io::Error),
    Write(io::Error),
}

fn copy_inner(
    reader: &mut dyn Read,
    writer: &mut dyn Write,
    mut on_chunk: impl FnMut(&[u8]),
) -> Result<u64, CopyError> {
    let mut buf = vec![0u8; COPY_BUF_BYTES];
    let mut total = 0u64;
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) => return Ok(total),
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(CopyError::Read(e)),
        };
        on_chunk(&buf[..n]);
        writer.write_all(&buf[..n]).map_err(CopyError::Write)?;
        total += n as u64;
    }
}

/// A temp file that is deleted on drop unless `persisted` is set (after it
/// was renamed into place). With `register`, its name is listed in
/// [`active_temps`] for its lifetime so `BlobStore::open` leaves it alone.
struct TempFile {
    path: PathBuf,
    file: Option<File>,
    registered: Option<String>,
    persisted: bool,
}

impl TempFile {
    fn create(path: PathBuf, register: bool) -> AppResult<Self> {
        let registered = if register {
            let name = path
                .file_name()
                .expect("temp path has a file name")
                .to_string_lossy()
                .into_owned();
            active_temps()
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(name.clone());
            Some(name)
        } else {
            None
        };
        // From here on, drop unregisters the name even if creation fails.
        let mut temp = TempFile {
            path,
            file: None,
            registered,
            persisted: false,
        };
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp.path)
            .map_err(|e| storage_err("tidak bisa dibuat", &temp.path, &e))?;
        temp.file = Some(file);
        Ok(temp)
    }

    fn file(&mut self) -> &mut File {
        self.file.as_mut().expect("temp file is open until finish")
    }

    /// Flushes the data to disk and closes the handle (Windows cannot rename
    /// a file that is still open without delete sharing).
    fn finish(&mut self) -> AppResult<()> {
        if let Some(file) = self.file.take() {
            file.sync_all()
                .map_err(|e| storage_err("tidak bisa ditulis", &self.path, &e))?;
        }
        Ok(())
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        self.file.take();
        if !self.persisted {
            let _ = set_writable(&self.path);
            let _ = fs::remove_file(&self.path);
        }
        if let Some(name) = self.registered.take() {
            active_temps()
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&name);
        }
    }
}
