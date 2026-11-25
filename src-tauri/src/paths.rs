//! Where Mira keeps its local data.
//!
//! `MIRA_DATA_DIR` overrides the default so several instances can run side by
//! side on one laptop (needed to test LAN features in Tahap 1). Without it the
//! Tauri local app data folder is used:
//! - Windows: `%LOCALAPPDATA%\id.mira.desktop` (local, not roaming: a roaming
//!   profile must never carry one laptop's identity or a live SQLite file to
//!   another laptop);
//! - macOS: `~/Library/Application Support/id.mira.desktop` (Tauri maps both
//!   the local and the roaming data folder there; it is not synced by iCloud
//!   Drive, and Time Machine backs it up like any other file in the home
//!   folder).
//!
//! The key itself never lives in this folder (see `identity::keystore`).

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

pub const DATA_DIR_ENV: &str = "MIRA_DATA_DIR";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataDir {
    pub path: PathBuf,
    /// True when the folder came from `MIRA_DATA_DIR`.
    pub from_env: bool,
}

impl DataDir {
    /// Last path component, used to tell instances apart in the window title.
    pub fn folder_name(&self) -> String {
        self.path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| self.path.display().to_string())
    }
}

/// Picks the data folder from an env value (empty counts as unset) or the
/// fallback, makes it absolute and creates it.
pub fn choose_data_dir(
    env_value: Option<OsString>,
    fallback: impl FnOnce() -> AppResult<PathBuf>,
) -> AppResult<DataDir> {
    let (path, from_env) = match env_value.filter(|v| !v.is_empty()) {
        Some(v) => (PathBuf::from(v), true),
        None => (fallback()?, false),
    };
    let path = std::path::absolute(&path).map_err(|e| folder_error(&path, e))?;
    std::fs::create_dir_all(&path).map_err(|e| folder_error(&path, e))?;
    Ok(DataDir { path, from_env })
}

pub fn resolve_data_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> AppResult<DataDir> {
    use tauri::Manager;
    choose_data_dir(std::env::var_os(DATA_DIR_ENV), || {
        app.path().app_local_data_dir().map_err(|e| {
            AppError::Internal(format!(
                "Folder data aplikasi di laptop ini tidak ditemukan. Detail: {e}"
            ))
        })
    })
}

/// The SQLite database and its side files. A reset moves these first: they
/// are the point of no return (0.5.1, `reset_removed_laptop`).
pub const DB_FILES: &[&str] = &[
    crate::db::DB_FILE_NAME,
    "mira.db-wal",
    "mira.db-shm",
    "mira.db-journal",
];

/// Folders Mira writes in the data folder for the organization. A reset
/// deletes only these (and [`DB_FILES`]); anything else in the folder is left
/// alone. `webview` (WebView2 data with `MIRA_DATA_DIR`) is not listed: the
/// open window uses it and it holds no organization data.
pub const ORG_FOLDERS: &[&str] = &[
    crate::blobs::BlobStore::DIR_NAME,
    crate::chat::files::OPEN_DIR,
    // chat/runtime.rs `tmp_path`.
    "chat-tmp",
    crate::documents::peer_sync::INCOMING_DIR,
    crate::documents::session::WORKING_DIR,
    crate::documents::session::VIEW_DIR,
    crate::signing::store::LEGACY_FOLDER,
    crate::signing::peer_sync::DOWNLOAD_FOLDER,
    // Not `ekspor` (signing/commands.rs `export_dir` fallback): signed PDFs
    // the person exported are their own files, kept like Downloads.
];

/// Name prefix of the folder a reset moves old data into before deleting it.
pub const RESET_TRASH_PREFIX: &str = ".mira-reset-";
/// File a reset writes into its trash folder right before deleting the old
/// key: from then on the old data is not wanted back.
pub const RESET_COMMITTED: &str = "reset-committed";

/// Old data moved aside by a reset. Renames within the data folder, so each
/// move is atomic and can be undone until the trash is emptied.
#[derive(Debug)]
pub struct ResetTrash {
    data_dir: PathBuf,
    dir: PathBuf,
    /// `(original, in trash)`, in the order moved.
    moved: Vec<(PathBuf, PathBuf)>,
}

impl ResetTrash {
    /// Creates an empty `<data_dir>/.mira-reset-<random>` folder.
    pub fn create(data_dir: &Path) -> std::io::Result<ResetTrash> {
        use rand_core::{OsRng, RngCore};
        let mut bytes = [0u8; 8];
        OsRng.fill_bytes(&mut bytes);
        let dir = data_dir.join(format!("{RESET_TRASH_PREFIX}{}", hex::encode(bytes)));
        std::fs::create_dir(&dir)?;
        Ok(ResetTrash {
            data_dir: data_dir.to_path_buf(),
            dir,
            moved: Vec::new(),
        })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Moves `<data_dir>/<name>` into the trash. `Ok(false)` when it does
    /// not exist. `name` must be one plain component.
    pub fn take(&mut self, name: &str) -> std::io::Result<bool> {
        let mut parts = Path::new(name).components();
        let plain = matches!(
            (parts.next(), parts.next()),
            (Some(std::path::Component::Normal(_)), None)
        ) && !name.contains(['/', '\\']);
        if !plain {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("nama tidak valid: {name}"),
            ));
        }
        let from = self.data_dir.join(name);
        match std::fs::symlink_metadata(&from) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(e),
        }
        let to = self.dir.join(name);
        std::fs::rename(&from, &to)?;
        self.moved.push((from, to));
        Ok(true)
    }

    /// Marks the reset as past the point of no return ([`RESET_COMMITTED`]):
    /// a sweep after a crash then deletes this trash instead of moving the
    /// database back.
    pub fn commit(&self) -> std::io::Result<()> {
        std::fs::write(self.dir.join(RESET_COMMITTED), b"")
    }

    /// Moves everything back, newest first, and removes the trash folder.
    /// On failure returns the error; what could not be moved back stays in
    /// the trash folder (without the commit mark, so the next start moves
    /// it back).
    pub fn restore(mut self) -> std::io::Result<()> {
        match std::fs::remove_file(self.dir.join(RESET_COMMITTED)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        while let Some((from, to)) = self.moved.pop() {
            if let Err(e) = std::fs::rename(&to, &from) {
                self.moved.push((from, to));
                return Err(e);
            }
        }
        std::fs::remove_dir(&self.dir)
    }

    /// Deletes the trash folder and everything moved into it.
    pub fn empty(self) -> std::io::Result<()> {
        std::fs::remove_dir_all(&self.dir)
    }
}

fn is_missing(path: &Path) -> bool {
    matches!(
        std::fs::symlink_metadata(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound
    )
}

/// Cleans what an interrupted reset may have left. Best effort; nothing
/// else is touched.
/// - A SQLite `-wal`/`-shm` without its `mira.db` is deleted (a stale WAL
///   must never be replayed into another database).
/// - A trash folder holding `mira.db` while `<data_dir>/mira.db` is missing
///   and without [`RESET_COMMITTED`] (the reset stopped before the old key
///   was deleted, or its undo failed) is moved back, never deleted.
/// - Every other trash folder is deleted.
pub fn sweep_reset_leftovers(data_dir: &Path) {
    let db = data_dir.join(crate::db::DB_FILE_NAME);
    if is_missing(&db) {
        for side in ["mira.db-wal", "mira.db-shm", "mira.db-journal"] {
            let _ = std::fs::remove_file(data_dir.join(side));
        }
    }
    let Ok(entries) = std::fs::read_dir(data_dir) else {
        return;
    };
    let mut trash: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_str()
                .is_some_and(|n| n.starts_with(RESET_TRASH_PREFIX))
                && e.file_type().is_ok_and(|t| t.is_dir())
        })
        .map(|e| e.path())
        .collect();
    trash.sort();
    for dir in trash {
        let unfinished = !dir.join(RESET_COMMITTED).exists()
            && dir.join(crate::db::DB_FILE_NAME).is_file()
            && is_missing(&db);
        if unfinished {
            for name in DB_FILES.iter().chain(ORG_FOLDERS) {
                let (from, to) = (dir.join(name), data_dir.join(name));
                if !is_missing(&from) && is_missing(&to) && std::fs::rename(&from, &to).is_err() {
                    eprintln!("Mira: {} belum bisa dikembalikan", from.display());
                }
            }
            // Removed only when everything went back.
            let _ = std::fs::remove_dir(&dir);
        } else {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}

fn folder_error(path: &Path, err: std::io::Error) -> AppError {
    AppError::Internal(format!(
        "Folder data Mira di {} tidak bisa dibuat atau dibuka. Detail: {err}",
        path.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_value_wins_and_folder_is_created() {
        let tmp = tempfile::tempdir().unwrap();
        let wanted = tmp.path().join("instance-a");
        let dir = choose_data_dir(Some(wanted.clone().into_os_string()), || {
            panic!("fallback must not be used")
        })
        .unwrap();
        assert_eq!(dir.path, wanted);
        assert!(dir.from_env);
        assert!(wanted.is_dir());
        assert_eq!(dir.folder_name(), "instance-a");
    }

    #[test]
    fn falls_back_when_env_missing_or_empty() {
        let tmp = tempfile::tempdir().unwrap();
        for env in [None, Some(OsString::new())] {
            let fallback = tmp.path().join("app-data");
            let dir = choose_data_dir(env, || Ok(fallback.clone())).unwrap();
            assert_eq!(dir.path, fallback);
            assert!(!dir.from_env);
            assert!(fallback.is_dir());
        }
    }

    #[test]
    fn reset_trash_moves_restores_and_empties() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("mira.db"), b"db").unwrap();
        std::fs::create_dir_all(dir.join("blobs").join("ab")).unwrap();
        std::fs::write(dir.join("blobs").join("ab").join("x"), b"blob").unwrap();
        std::fs::write(dir.join("milik-orang-lain.txt"), b"jangan").unwrap();

        let mut trash = ResetTrash::create(dir).unwrap();
        assert!(trash.take("mira.db").unwrap());
        assert!(trash.take("blobs").unwrap());
        assert!(
            !trash.take("chat-files").unwrap(),
            "missing is not an error"
        );
        for bad in ["", "..", "a/b", "a\\b", "../x"] {
            assert!(trash.take(bad).is_err(), "{bad:?}");
        }
        assert!(!dir.join("mira.db").exists());
        assert!(trash.dir().join("blobs").join("ab").join("x").exists());
        trash.restore().unwrap();
        assert_eq!(std::fs::read(dir.join("mira.db")).unwrap(), b"db");
        assert!(dir.join("blobs").join("ab").join("x").exists());

        let mut trash = ResetTrash::create(dir).unwrap();
        trash.take("mira.db").unwrap();
        trash.take("blobs").unwrap();
        let trash_dir = trash.dir().to_path_buf();
        trash.empty().unwrap();
        assert!(!trash_dir.exists());
        assert!(!dir.join("mira.db").exists() && !dir.join("blobs").exists());
        assert!(dir.join("milik-orang-lain.txt").exists());
    }

    #[test]
    fn sweep_removes_trash_and_orphan_wal_only() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let trash = dir.join(format!("{RESET_TRASH_PREFIX}0011223344556677"));
        std::fs::create_dir_all(trash.join("blobs")).unwrap();
        std::fs::write(trash.join("mira.db"), b"lama").unwrap();
        // Past the point of no return: deleted even though mira.db is gone.
        std::fs::write(trash.join(RESET_COMMITTED), b"").unwrap();
        std::fs::write(dir.join("mira.db-wal"), b"wal").unwrap();
        std::fs::write(dir.join("mira.db-shm"), b"shm").unwrap();
        std::fs::write(dir.join(".mira-reset-file"), b"bukan folder").unwrap();
        std::fs::create_dir(dir.join("lain")).unwrap();

        sweep_reset_leftovers(dir);
        assert!(!trash.exists());
        assert!(!dir.join("mira.db-wal").exists());
        assert!(!dir.join("mira.db-shm").exists());
        assert!(dir.join(".mira-reset-file").exists(), "files are not trash");
        assert!(dir.join("lain").exists());

        // With the database present its WAL is live and stays.
        std::fs::write(dir.join("mira.db"), b"db").unwrap();
        std::fs::write(dir.join("mira.db-wal"), b"wal").unwrap();
        sweep_reset_leftovers(dir);
        assert!(dir.join("mira.db-wal").exists());
    }

    #[test]
    fn sweep_moves_back_an_unfinished_reset_instead_of_deleting_it() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        // A reset stopped before deleting the key (or its undo failed):
        // the database is only in the trash.
        let mut trash = ResetTrash::create(dir).unwrap();
        std::fs::write(dir.join("mira.db"), b"lama").unwrap();
        std::fs::write(dir.join("mira.db-wal"), b"wal lama").unwrap();
        std::fs::create_dir_all(dir.join("blobs").join("ab")).unwrap();
        std::fs::write(dir.join("blobs").join("ab").join("x"), b"blob").unwrap();
        trash.take("mira.db").unwrap();
        trash.take("mira.db-wal").unwrap();
        trash.take("blobs").unwrap();
        let trash_dir = trash.dir().to_path_buf();
        drop(trash);
        // A stray WAL next to the missing database is not the trash's.
        std::fs::write(dir.join("mira.db-shm"), b"asing").unwrap();

        sweep_reset_leftovers(dir);
        assert_eq!(std::fs::read(dir.join("mira.db")).unwrap(), b"lama");
        assert_eq!(std::fs::read(dir.join("mira.db-wal")).unwrap(), b"wal lama");
        assert!(!dir.join("mira.db-shm").exists());
        assert!(dir.join("blobs").join("ab").join("x").exists());
        assert!(!trash_dir.exists());

        // Committed, or with a database in place: deleted as before.
        let mut trash = ResetTrash::create(dir).unwrap();
        trash.take("blobs").unwrap();
        std::fs::write(trash.dir().join("mira.db"), b"lebih lama").unwrap();
        let trash_dir = trash.dir().to_path_buf();
        sweep_reset_leftovers(dir);
        assert!(!trash_dir.exists(), "mira.db is in place");
        assert_eq!(std::fs::read(dir.join("mira.db")).unwrap(), b"lama");

        // The commit mark goes away when a reset is undone.
        let mut trash = ResetTrash::create(dir).unwrap();
        trash.take("mira.db").unwrap();
        trash.commit().unwrap();
        trash.restore().unwrap();
        assert!(dir.join("mira.db").exists());
    }

    #[test]
    fn fallback_error_is_returned() {
        let err = choose_data_dir(None, || Err(AppError::Internal("x".into()))).unwrap_err();
        assert_eq!(err.code(), "internal");
    }
}
