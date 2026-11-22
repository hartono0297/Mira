//! Process-wide state managed by Tauri.
//!
//! Initialization (open database, load or create the laptop key) can fail, for
//! example when the key is missing from Windows Credential Manager. The app
//! must still open its window and show a clear error, so a failure is kept
//! out of `Core` and initialization is retried on the next command. That also
//! makes the frontend's "Coba lagi" button meaningful.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::Connection;

use crate::db;
use crate::error::{AppError, AppResult};
use crate::identity::{self, Identity, KeyStore};

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
        if guard.is_none() {
            let core = Core::open(self.data_dir()?, self.keystore.as_ref())?;
            *guard = Some(core);
        }
        let core = guard
            .as_mut()
            .ok_or_else(|| AppError::Internal("Inisialisasi Mira tidak selesai.".into()))?;
        f(core)
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
