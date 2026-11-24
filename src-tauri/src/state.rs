//! Process-wide state managed by Tauri.
//!
//! Initialization (open database, load or create the laptop key) can fail, for
//! example when the key is missing from the OS key store. The app
//! must still open its window and show a clear error, so a failure is kept
//! out of `Core` and initialization is retried on the next command. That also
//! makes the frontend's "Coba lagi" button meaningful.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::Connection;

use crate::db;
use crate::error::{AppError, AppResult};
use crate::identity::{self, Identity, KeyStore};
use crate::{paths, settings};

/// Everything that needs the database and the laptop key.
pub struct Core {
    pub db: Connection,
    pub identity: Identity,
}

impl Core {
    pub fn open(data_dir: &Path, keystore: &dyn KeyStore) -> AppResult<Core> {
        let db = db::open(data_dir)?;
        let identity = identity::ensure_identity(&db, keystore)?;
        Ok(Core { db, identity })
    }
}

/// Cheap to clone: clones share the same core, so the network task can hold
/// one while Tauri manages another.
#[derive(Clone)]
pub struct MiraState {
    data_dir: Arc<AppResult<PathBuf>>,
    keystore: Arc<dyn KeyStore>,
    core: Arc<Mutex<Option<Core>>>,
}

impl MiraState {
    /// Does not touch the disk; call `with_core` to initialize.
    pub fn new(data_dir: AppResult<PathBuf>, keystore: Box<dyn KeyStore>) -> Self {
        Self {
            data_dir: Arc::new(data_dir),
            keystore: Arc::from(keystore),
            core: Arc::new(Mutex::new(None)),
        }
    }

    pub fn data_dir(&self) -> AppResult<&Path> {
        self.data_dir.as_ref().as_deref().map_err(Clone::clone)
    }

    /// Runs `f` with the initialized core, initializing it first if needed.
    /// The lock is held for the whole call, so keep `f` short.
    pub fn with_core<T>(&self, f: impl FnOnce(&mut Core) -> AppResult<T>) -> AppResult<T> {
        let mut guard = self.lock()?;
        let core = self.ensure(&mut guard)?;
        f(core)
    }

    fn ensure<'a>(&self, guard: &'a mut Option<Core>) -> AppResult<&'a mut Core> {
        if guard.is_none() {
            let data_dir = self.data_dir()?;
            paths::sweep_reset_leftovers(data_dir);
            *guard = Some(Core::open(data_dir, self.keystore.as_ref())?);
        }
        guard
            .as_mut()
            .ok_or_else(|| AppError::Internal("Inisialisasi Mira tidak selesai.".into()))
    }

    /// 0.5.1 "Reset dan mulai dari awal": deletes this laptop's organization
    /// data and its key, then starts over with a new key and an empty
    /// database. Only when `allowed` accepts the current core.
    ///
    /// Under the core lock, so no command sees a half-reset laptop:
    /// 1. read the settings named in `keep` (display preferences);
    /// 2. close the database (the only connection to `mira.db`);
    /// 3. move `mira.db` and its side files into a trash folder. A failure
    ///    (another program still has the file open) moves everything back:
    ///    the laptop stays as it was;
    /// 4. delete the keystore entry of the old public key, and nothing
    ///    else. A failure moves the database back too, so a database is
    ///    never left without its key;
    /// 5. from here there is no way back: move the organization folders
    ///    ([`paths::ORG_FOLDERS`]) into the trash, or delete them in place
    ///    when a move fails; what still cannot be deleted is reported in
    ///    [`ResetOutcome::leftovers`]. Empty the trash;
    /// 6. create a new database, write the kept settings back, and make a
    ///    new key.
    pub fn reset_with(
        &self,
        allowed: impl FnOnce(&Core) -> AppResult<()>,
        keep: &[&str],
    ) -> AppResult<ResetOutcome> {
        let mut guard = self.lock()?;
        let data_dir = self.data_dir()?;
        let core = self.ensure(&mut guard)?;
        allowed(core)?;
        let mut kept = Vec::new();
        for key in keep {
            if let Some(value) = settings::get(&core.db, key)? {
                kept.push((*key, value));
            }
        }

        let Some(Core { db, identity }) = guard.take() else {
            return Err(AppError::Internal(
                "Inisialisasi Mira tidak selesai.".into(),
            ));
        };
        if let Err((db, e)) = db.close() {
            *guard = Some(Core { db, identity });
            return Err(AppError::Database(format!(
                "Database Mira belum bisa ditutup untuk reset. Tutup lalu buka lagi Mira, kemudian coba lagi. Detail: {e}"
            )));
        }
        let old_public_key = identity.public_key_hex().to_owned();
        drop(identity);

        let mut trash = paths::ResetTrash::create(data_dir).map_err(|e| {
            AppError::Storage(format!(
                "Folder data Mira tidak bisa diubah untuk reset. Detail: {e}"
            ))
        })?;
        for name in paths::DB_FILES {
            if let Err(e) = trash.take(name) {
                return Err(undo(
                    trash,
                    format!(
                        "Data organisasi lama belum bisa dihapus karena file {name} masih dipakai. Tutup program lain yang membukanya, atau tutup lalu buka lagi Mira, kemudian coba Reset lagi. Detail: {e}"
                    ),
                ));
            }
        }
        if let Err(e) = self
            .keystore
            .delete(&identity::keystore_account(&old_public_key))
        {
            return Err(undo(
                trash,
                format!(
                    "Kunci lama laptop ini di {} belum bisa dihapus, jadi reset dibatalkan dan data tidak diubah. Detail: {e}",
                    identity::STORE_NAME
                ),
            ));
        }

        let mut leftovers = Vec::new();
        for name in paths::ORG_FOLDERS {
            if trash.take(name).is_err() {
                let path = data_dir.join(name);
                let _ = std::fs::remove_dir_all(&path);
                if std::fs::symlink_metadata(&path).is_ok() {
                    eprintln!(
                        "Mira: reset tidak bisa menghapus semua isi {}",
                        path.display()
                    );
                    leftovers.push(path);
                }
            }
        }
        let trash_dir = trash.dir().to_path_buf();
        if let Err(e) = trash.empty() {
            // Swept on the next start (`paths::sweep_reset_leftovers`).
            eprintln!(
                "Mira: folder sampah reset {} belum terhapus: {e}",
                trash_dir.display()
            );
            leftovers.push(trash_dir);
        }

        let fresh = |e: AppError| {
            AppError::Database(format!(
                "Data lama sudah dihapus, tapi data baru belum bisa dibuat. Tutup lalu buka lagi Mira. Detail: {e}"
            ))
        };
        let db = db::open(data_dir).map_err(fresh)?;
        for (key, value) in &kept {
            if let Err(e) = settings::set(&db, key, value) {
                eprintln!("Mira: pengaturan {key} tidak bisa disimpan lagi setelah reset: {e}");
            }
        }
        let identity = identity::ensure_identity(&db, self.keystore.as_ref())?;
        let new_public_key = identity.public_key_hex().to_owned();
        *guard = Some(Core { db, identity });
        Ok(ResetOutcome {
            old_public_key,
            new_public_key,
            leftovers,
        })
    }

    fn lock(&self) -> AppResult<MutexGuard<'_, Option<Core>>> {
        self.core.lock().map_err(|_| {
            AppError::Internal(
                "Mira mengalami kesalahan internal sebelumnya. Tutup lalu buka lagi aplikasinya."
                    .into(),
            )
        })
    }
}

/// What [`MiraState::reset_with`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResetOutcome {
    pub old_public_key: String,
    pub new_public_key: String,
    /// Organization paths that could not be deleted (a file still open in
    /// another program). Harmless to the new identity; logged.
    pub leftovers: Vec<PathBuf>,
}

/// Moves the database back after a failed reset and builds the error. When
/// even that fails, the error says where the old data is.
fn undo(trash: paths::ResetTrash, message: String) -> AppError {
    let dir = trash.dir().to_path_buf();
    match trash.restore() {
        Ok(()) => AppError::Storage(message),
        Err(e) => AppError::Storage(format!(
            "{message} Data lama juga belum bisa dikembalikan; salinannya ada di {}. Detail: {e}",
            dir.display()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::{MemoryKeyStore, keystore_account};

    /// Keystore that forwards to a shared `MemoryKeyStore`, so a test can
    /// remove the key behind the state's back.
    struct Shared(std::sync::Arc<MemoryKeyStore>);

    impl KeyStore for Shared {
        fn get(&self, a: &str) -> AppResult<Option<identity::SecretKey>> {
            self.0.get(a)
        }
        fn set(&self, a: &str, s: &[u8; 32]) -> AppResult<()> {
            self.0.set(a, s)
        }
        fn delete(&self, a: &str) -> AppResult<()> {
            self.0.delete(a)
        }
    }

    #[test]
    fn failure_is_reported_and_retried() {
        let tmp = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(MemoryKeyStore::new());
        let pk = {
            let state = MiraState::new(
                Ok(tmp.path().to_path_buf()),
                Box::new(Shared(store.clone())),
            );
            state
                .with_core(|c| Ok(c.identity.public_key_hex().to_owned()))
                .unwrap()
        };
        let account = keystore_account(&pk);
        let secret = store.get(&account).unwrap().unwrap();
        store.delete(&account).unwrap();

        let state = MiraState::new(
            Ok(tmp.path().to_path_buf()),
            Box::new(Shared(store.clone())),
        );
        let err = state.with_core(|_| Ok(())).unwrap_err();
        assert_eq!(err.code(), "key_mismatch");

        store.set(&account, &secret).unwrap();
        let again = state
            .with_core(|c| Ok(c.identity.public_key_hex().to_owned()))
            .unwrap();
        assert_eq!(again, pk);
    }

    #[test]
    fn data_dir_error_is_returned() {
        let state = MiraState::new(
            Err(AppError::Internal("tidak ada folder".into())),
            Box::new(MemoryKeyStore::new()),
        );
        let err = state.with_core(|_| Ok(())).unwrap_err();
        assert_eq!(err.to_string(), "tidak ada folder");
    }
}
