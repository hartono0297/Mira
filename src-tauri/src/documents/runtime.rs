//! Tauri side of the document library: builds the [`DocsEnv`] with the
//! opener plugin as launcher, the `mira://documents` event as notifier and
//! the Office watcher, and keeps it in Tauri's managed state.
//!
//! The environment is created on first use and creation is retried on the
//! next command after a failure (same idea as `MiraState`), so the runtime is
//! always manageable and a missing data folder shows up as the command's
//! error instead of stopping the app.

use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;

use crate::documents::access::RoleAccess;
use crate::documents::session::{DocsDeps, DocsEnv, DocumentEvents, Launcher};
use crate::documents::sync::NoSync;
use crate::documents::watch::DEFAULT_SETTLE;
use crate::error::{AppError, AppResult};
use crate::state::MiraState;

/// Test hook: `MIRA_TEST_NO_LAUNCH=1` makes "Edit" and "Buka" prepare the
/// working copy (and its watcher) without opening Word, Excel or any other
/// app, so the end-to-end test can save the file through its own invisible
/// Office instance without disturbing the user's Office.
pub const NO_LAUNCH_ENV: &str = "MIRA_TEST_NO_LAUNCH";

/// Event sent after every change to a document; payload `{ documentId }`.
pub const DOCUMENTS_EVENT: &str = "mira://documents";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentChanged<'a> {
    document_id: &'a str,
}

/// Opens files with the app Windows associates with them.
struct OpenerLauncher {
    app: AppHandle,
}

impl Launcher for OpenerLauncher {
    fn open(&self, path: &Path) -> AppResult<()> {
        self.app
            .opener()
            .open_path(path.to_string_lossy(), None::<&str>)
            .map_err(|err| AppError::OpenFailed(err.to_string()))
    }
}

/// [`NO_LAUNCH_ENV`]: opens nothing.
struct NoLaunch;

impl Launcher for NoLaunch {
    fn open(&self, path: &Path) -> AppResult<()> {
        eprintln!(
            "Mira: {NO_LAUNCH_ENV} aktif, {} tidak dibuka.",
            path.display()
        );
        Ok(())
    }
}

struct TauriEvents {
    app: AppHandle,
}

impl DocumentEvents for TauriEvents {
    fn changed(&self, document_id: &str) {
        if let Err(err) = self
            .app
            .emit(DOCUMENTS_EVENT, DocumentChanged { document_id })
        {
            eprintln!("Mira: event {DOCUMENTS_EVENT} tidak terkirim: {err}");
        }
    }
}

fn no_launch() -> bool {
    std::env::var(NO_LAUNCH_ENV).is_ok_and(|v| v.trim() == "1")
}

type Factory = Box<dyn Fn() -> AppResult<Arc<DocsEnv>> + Send + Sync>;

struct Inner {
    make: Factory,
    env: Mutex<Option<Arc<DocsEnv>>>,
}

/// Managed by Tauri. Cheap to clone.
#[derive(Clone)]
pub struct DocumentsRuntime {
    inner: Arc<Inner>,
}

impl DocumentsRuntime {
    /// The app's runtime: role-based access, no network sync yet, the opener
    /// plugin (or nothing with [`NO_LAUNCH_ENV`]) and Tauri events.
    pub fn new(app: &AppHandle, state: MiraState) -> Self {
        let app = app.clone();
        Self::with_factory(move || {
            let launcher: Arc<dyn Launcher> = if no_launch() {
                Arc::new(NoLaunch)
            } else {
                Arc::new(OpenerLauncher { app: app.clone() })
            };
            DocsEnv::new(
                state.clone(),
                DocsDeps {
                    access: Arc::new(RoleAccess),
                    sync: Arc::new(NoSync),
                    launcher,
                    events: Arc::new(TauriEvents { app: app.clone() }),
                    settle: DEFAULT_SETTLE,
                },
            )
        })
    }

    pub fn with_factory(
        make: impl Fn() -> AppResult<Arc<DocsEnv>> + Send + Sync + 'static,
    ) -> Self {
        DocumentsRuntime {
            inner: Arc::new(Inner {
                make: Box::new(make),
                env: Mutex::new(None),
            }),
        }
    }

    /// The environment, created now if needed.
    pub fn env(&self) -> AppResult<Arc<DocsEnv>> {
        let mut guard = self.inner.env.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(env) = guard.as_ref() {
            return Ok(Arc::clone(env));
        }
        let env = (self.inner.make)()?;
        *guard = Some(Arc::clone(&env));
        Ok(env)
    }

    /// Recovers edit sessions from before the last close on a background
    /// thread, so hashing working copies does not delay the window.
    pub fn spawn_recovery(&self) {
        let runtime = self.clone();
        let spawned = std::thread::Builder::new()
            .name("mira-docs-recover".into())
            .spawn(move || {
                if let Err(err) = runtime.env().and_then(|env| env.recover_sessions()) {
                    eprintln!(
                        "Mira: sesi edit dokumen tidak bisa dipulihkan [{}]: {err}",
                        err.code()
                    );
                }
            });
        if let Err(err) = spawned {
            eprintln!("Mira: pemulihan sesi edit dokumen tidak bisa dijalankan: {err}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_error_is_returned_and_retried() {
        let calls = Arc::new(Mutex::new(0));
        let counter = Arc::clone(&calls);
        let runtime = DocumentsRuntime::with_factory(move || {
            *counter.lock().unwrap() += 1;
            Err(AppError::Internal("tidak ada folder".into()))
        });
        let err = runtime.env().err().expect("init error");
        assert_eq!(err.to_string(), "tidak ada folder");
        assert!(runtime.env().is_err());
        assert_eq!(*calls.lock().unwrap(), 2);
    }

    #[test]
    fn event_payload_is_camel_case() {
        let json = serde_json::to_value(DocumentChanged { document_id: "abc" }).unwrap();
        assert_eq!(json, serde_json::json!({ "documentId": "abc" }));
    }
}
