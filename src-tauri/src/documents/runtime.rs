//! Tauri side of the document library: builds the [`DocsEnv`] with the
//! opener plugin as launcher, the `mira://documents` event as notifier and
//! the Office watcher, and keeps it in Tauri's managed state.
//!
//! The environment is created on first use and creation is retried on the
//! next command after a failure (same idea as `MiraState`), so the runtime is
//! always manageable and a missing data folder shows up as the command's
//! error instead of stopping the app.
//!
//! Sync with rekan: [`DocumentsRuntime::new`] builds the [`DocsPeerSync`],
//! registers it with the managed `Arc<FeatureHub>` (topic `docs` and blob
//! source), uses it as the environment's outbound [`DocumentSync`], drops
//! expired waiting records and resumes small downloads at start, and repeats
//! this laptop's "Sedang diedit" marks every minute on a background thread.

use std::path::Path;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::documents::access::RoleAccessWith;
use crate::documents::peer_sync::{DocsPeerSync, HubFetcher, PeerSyncDeps};
use crate::documents::scope::{BoardGuestProjects, GuestProjects};
use crate::documents::session::{DocsDeps, DocsEnv, DocumentEvents, Launcher};
use crate::documents::sync::{DocumentSync, NoSync};
use crate::documents::watch::DEFAULT_SETTLE;
use crate::error::{AppError, AppResult};
use crate::network::feature::FeatureHub;
use crate::state::MiraState;

/// Test hook: `MIRA_TEST_NO_LAUNCH=1` makes "Edit" and "Buka" prepare the
/// working copy (and its watcher) without opening Word, Excel or any other
/// app, so the end-to-end test can save the file through its own invisible
/// Office instance without disturbing the user's Office.
pub const NO_LAUNCH_ENV: &str = "MIRA_TEST_NO_LAUNCH";

/// Event sent after every change to a document; payload `{ documentId }`.
pub const DOCUMENTS_EVENT: &str = "mira://documents";

/// How often the background thread checks whether "Sedang diedit" marks
/// need repeating (`peer_sync::EDIT_REFRESH_SECS` decides when they do).
const REFRESH_EVERY: Duration = Duration::from_secs(60);

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
    peer: Option<Arc<DocsPeerSync>>,
}

/// Managed by Tauri. Cheap to clone.
#[derive(Clone)]
pub struct DocumentsRuntime {
    inner: Arc<Inner>,
}

/// Builds the document sync and registers it with the hub. `None` (logged)
/// when the hub is not managed or the data folder is missing; the library
/// then works without sync.
fn start_peer_sync(
    app: &AppHandle,
    state: &MiraState,
    guests: &Arc<dyn GuestProjects>,
    events: &Arc<dyn DocumentEvents>,
) -> Option<Arc<DocsPeerSync>> {
    let Some(hub) = app.try_state::<Arc<FeatureHub>>() else {
        eprintln!("Mira: FeatureHub belum ada, sinkron dokumen tidak berjalan.");
        return None;
    };
    let hub: Arc<FeatureHub> = hub.inner().clone();
    let peer = DocsPeerSync::new(
        state.clone(),
        PeerSyncDeps {
            guests: guests.clone(),
            hub: hub.clone(),
            fetcher: Arc::new(HubFetcher(hub.clone())),
            events: events.clone(),
        },
    );
    match peer {
        Ok(peer) => {
            hub.register(peer.clone());
            hub.register_blob_source(peer.clone());
            spawn_background(Arc::downgrade(&peer));
            Some(peer)
        }
        Err(err) => {
            eprintln!(
                "Mira: sinkron dokumen tidak berjalan [{}]: {err}",
                err.code()
            );
            None
        }
    }
}

/// At start: resume small downloads. Then every minute: repeat this
/// laptop's "Sedang diedit" marks that are due. Stops when the sync is gone.
fn spawn_background(peer: Weak<DocsPeerSync>) {
    let spawned = std::thread::Builder::new()
        .name("mira-docs-sync".into())
        .spawn(move || {
            if let Some(p) = peer.upgrade() {
                if let Err(err) = p.expire_pending() {
                    eprintln!(
                        "Mira: catatan dokumen yang menunggu tidak bisa dibersihkan [{}]: {err}",
                        err.code()
                    );
                }
                p.resume_downloads(Vec::new());
            }
            loop {
                std::thread::sleep(REFRESH_EVERY);
                let Some(p) = peer.upgrade() else {
                    return;
                };
                if let Err(err) = p.refresh_editing() {
                    eprintln!(
                        "Mira: tanda sedang diedit tidak bisa diulang [{}]: {err}",
                        err.code()
                    );
                }
            }
        });
    if let Err(err) = spawned {
        eprintln!("Mira: sinkron dokumen di latar belakang tidak bisa dijalankan: {err}");
    }
}

impl DocumentsRuntime {
    /// The app's runtime: role and scope access, sync with rekan through the
    /// managed `Arc<FeatureHub>` (which must be managed before this), the
    /// opener plugin (or nothing with [`NO_LAUNCH_ENV`]) and Tauri events.
    pub fn new(app: &AppHandle, state: MiraState) -> Self {
        let app = app.clone();
        // Guests follow the board: the projects `board::access` lets them read.
        let guests: Arc<dyn GuestProjects> = Arc::new(BoardGuestProjects);
        let events: Arc<dyn DocumentEvents> = Arc::new(TauriEvents { app: app.clone() });
        let peer = start_peer_sync(&app, &state, &guests, &events);
        let sync: Arc<dyn DocumentSync> = match &peer {
            Some(peer) => peer.clone(),
            None => Arc::new(NoSync),
        };
        let make: Factory = Box::new(move || {
            let launcher: Arc<dyn Launcher> = if no_launch() {
                Arc::new(NoLaunch)
            } else {
                Arc::new(OpenerLauncher { app: app.clone() })
            };
            DocsEnv::new(
                state.clone(),
                DocsDeps {
                    access: Arc::new(RoleAccessWith(guests.clone())),
                    sync: sync.clone(),
                    launcher,
                    events: events.clone(),
                    settle: DEFAULT_SETTLE,
                },
            )
        });
        DocumentsRuntime {
            inner: Arc::new(Inner {
                make,
                env: Mutex::new(None),
                peer,
            }),
        }
    }

    pub fn with_factory(
        make: impl Fn() -> AppResult<Arc<DocsEnv>> + Send + Sync + 'static,
    ) -> Self {
        DocumentsRuntime {
            inner: Arc::new(Inner {
                make: Box::new(make),
                env: Mutex::new(None),
                peer: None,
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

    /// The sync with rekan, for `download_version`.
    pub fn peer_sync(&self) -> AppResult<Arc<DocsPeerSync>> {
        self.inner.peer.clone().ok_or_else(|| {
            AppError::Internal(
                "Sinkron dokumen dengan laptop rekan belum berjalan. Tutup lalu buka lagi Mira."
                    .into(),
            )
        })
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
        assert_eq!(runtime.peer_sync().err().unwrap().code(), "internal");
    }

    #[test]
    fn event_payload_is_camel_case() {
        let json = serde_json::to_value(DocumentChanged { document_id: "abc" }).unwrap();
        assert_eq!(json, serde_json::json!({ "documentId": "abc" }));
    }
}
