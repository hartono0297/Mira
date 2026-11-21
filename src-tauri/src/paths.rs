//! Where Mira keeps its local data.
//!
//! `MIRA_DATA_DIR` overrides the default so several instances can run side by
//! side on one laptop (needed to test LAN features in Tahap 1). Without it the
//! Tauri local app data folder is used (`%LOCALAPPDATA%\id.mira.desktop` on
//! Windows). Local, not roaming: a roaming profile must never carry one
//! laptop's identity or a live SQLite file to another laptop.

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
                "Folder data aplikasi Windows tidak ditemukan. Detail: {e}"
            ))
        })
    })
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
    fn fallback_error_is_returned() {
        let err = choose_data_dir(None, || Err(AppError::Internal("x".into()))).unwrap_err();
        assert_eq!(err.code(), "internal");
    }
}
