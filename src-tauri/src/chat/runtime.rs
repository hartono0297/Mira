//! Tauri side of chat: the hooks (`FeatureHub` notifications, the
//! `mira://feature` event, Windows notifications, waking the downloader),
//! registration with the [`FeatureHub`], and the background task that
//! downloads attachments from colleagues.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

use super::audience::BoardTeamAudience;
use super::fetch::FetchJob;
use super::hooks::{ChatHooks, MessageNotification};
use super::sync::ChatSync;
use crate::error::{AppError, AppResult};
use crate::network::feature::{FeatureHub, TOPIC_CHAT};
use crate::state::MiraState;

/// Event sent when chat data changed; same name and payload as the event the
/// transport sends after `ingest`.
pub const FEATURE_EVENT: &str = "mira://feature";

/// The downloader looks at its queue at least this often, so a colleague who
/// came online without a `peer_connected` call is still used.
const FETCH_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Clone, Serialize)]
struct FeatureChanged<'a> {
    topic: &'a str,
}

struct TauriChatHooks {
    app: AppHandle,
    hub: Weak<FeatureHub>,
    wake: Arc<Notify>,
}

impl ChatHooks for TauriChatHooks {
    fn notify_changed(&self) {
        if let Some(hub) = self.hub.upgrade() {
            hub.notify_changed(TOPIC_CHAT);
        }
    }

    fn ui_changed(&self) {
        let _ = self
            .app
            .emit(FEATURE_EVENT, FeatureChanged { topic: TOPIC_CHAT });
    }

    fn connected_peers(&self) -> Vec<String> {
        self.hub
            .upgrade()
            .map(|hub| hub.connected_peers())
            .unwrap_or_default()
    }

    fn notify_message(&self, n: &MessageNotification) {
        // Mira in front: the message is already on screen or one click away.
        let focused = self
            .app
            .get_webview_window("main")
            .and_then(|w| w.is_focused().ok())
            .unwrap_or(false);
        if focused {
            return;
        }
        use tauri_plugin_notification::NotificationExt;
        if let Err(err) = self
            .app
            .notification()
            .builder()
            .title(&n.title)
            .body(&n.body)
            .show()
        {
            eprintln!("Mira: notifikasi chat gagal: {err}");
        }
    }

    fn wake_fetcher(&self) {
        self.wake.notify_one();
    }
}

/// Managed Tauri state for the chat commands.
#[derive(Clone)]
pub struct ChatRuntime {
    /// `Err` when the data folder could not be prepared; every command then
    /// returns that error (the window still opens, like `MiraState`).
    chat: Result<Arc<ChatSync>, AppError>,
    pub hub: Arc<FeatureHub>,
    wake: Arc<Notify>,
    /// Files the person picked in Mira's own file dialog. `chat_send` only
    /// attaches paths from this set, so a script in the webview cannot make
    /// Mira read arbitrary files.
    picked: Arc<Mutex<HashSet<PathBuf>>>,
}

impl ChatRuntime {
    /// Builds the chat feature, registers it with the hub (managed earlier in
    /// `setup`) and starts the downloader. Needs `MiraState` and
    /// `Arc<FeatureHub>` in managed state.
    pub fn install(app: &AppHandle) -> ChatRuntime {
        let state = app.state::<MiraState>().inner().clone();
        let hub = app.state::<Arc<FeatureHub>>().inner().clone();
        let wake = Arc::new(Notify::new());
        let hooks = Arc::new(TauriChatHooks {
            app: app.clone(),
            hub: Arc::downgrade(&hub),
            wake: wake.clone(),
        });
        let chat = ChatSync::new(state, Arc::new(BoardTeamAudience), hooks).map(Arc::new);
        match &chat {
            Ok(chat) => {
                hub.register(chat.clone());
                hub.register_blob_source(chat.clone());
            }
            Err(err) => eprintln!("Mira: chat belum bisa dipakai [{}]: {err}", err.code()),
        }
        let runtime = ChatRuntime {
            chat,
            hub,
            wake,
            picked: Arc::new(Mutex::new(HashSet::new())),
        };
        if runtime.chat.is_ok() {
            runtime.spawn_fetcher();
        }
        runtime
    }

    pub fn chat(&self) -> AppResult<Arc<ChatSync>> {
        self.chat.clone()
    }

    pub fn wake_fetcher(&self) {
        self.wake.notify_one();
    }

    pub fn remember_picked(&self, paths: &[PathBuf]) {
        let mut set = self.picked.lock().unwrap_or_else(|e| e.into_inner());
        set.extend(paths.iter().cloned());
    }

    /// `true` when `path` was picked in Mira's file dialog this session. Kept
    /// after sending so a failed send can be retried.
    pub fn was_picked(&self, path: &Path) -> bool {
        let set = self.picked.lock().unwrap_or_else(|e| e.into_inner());
        set.contains(path)
    }

    fn spawn_fetcher(&self) {
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                this.fetch_round().await;
                let _ = tokio::time::timeout(FETCH_INTERVAL, this.wake.notified()).await;
            }
        });
    }

    /// Tries every queued download once.
    pub async fn fetch_round(&self) {
        let Ok(chat) = self.chat() else { return };
        let jobs = match tauri::async_runtime::spawn_blocking(move || chat.fetch_jobs()).await {
            Ok(Ok(jobs)) => jobs,
            Ok(Err(err)) => {
                eprintln!(
                    "Mira: antrean unduhan chat tidak terbaca [{}]: {err}",
                    err.code()
                );
                return;
            }
            Err(_) => return,
        };
        for job in jobs {
            // Failures are recorded in the queue by `fetch_failed`.
            let _ = self.fetch_one(job).await;
        }
    }

    /// Downloads one queued file now. Returns the error text on failure.
    pub async fn fetch_one(&self, job: FetchJob) -> Result<(), String> {
        let tmp = match self.tmp_path(&job.hash) {
            Ok(p) => p,
            Err(err) => return Err(err),
        };
        let result = self
            .hub
            .fetch_blob(&job.hash, job.size, job.prefer.clone(), &tmp)
            .await;
        let chat = self.chat().map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn_blocking(move || {
            let out = match result {
                Ok(_) => chat.fetch_done(&job, &tmp).map_err(|e| e.to_string()),
                Err(err) => {
                    let _ = chat.fetch_failed(&job, &err);
                    Err(err)
                }
            };
            let _ = std::fs::remove_file(&tmp);
            out
        })
        .await
        .map_err(|e| e.to_string())?
    }

    fn tmp_path(&self, hash: &str) -> Result<PathBuf, String> {
        let dir = self
            .chat()
            .and_then(|c| c.data_dir())
            .map_err(|e| e.to_string())?
            .join("chat-tmp");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        // Unique per attempt: the background round and a click on "Unduh" may
        // fetch the same hash at the same time.
        Ok(dir.join(format!("{hash}-{}.part", super::model::random_hex32())))
    }
}
