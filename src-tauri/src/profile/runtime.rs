//! Tauri side of profile photos: the hooks (`FeatureHub` notifications, the
//! `mira://feature` event, waking the downloader), registration with the
//! [`FeatureHub`], the background task that downloads colleagues' photos,
//! and the one picked file waiting to be cropped.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

use super::store::PhotoJob;
use super::sync::{ProfileHooks, ProfileSync, TMP_DIR};
use super::{MAX_PHOTO_BYTES, PHOTO_TOKEN, TOPIC_PROFILE};
use crate::chat::runtime::FEATURE_EVENT;
use crate::error::{AppError, AppResult};
use crate::network::feature::FeatureHub;
use crate::state::MiraState;

/// The downloader looks at its queue at least this often.
const FETCH_INTERVAL: Duration = Duration::from_secs(60);

/// How long a picked file waits for `profile_set_photo`.
pub const PICK_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Serialize)]
struct FeatureChanged<'a> {
    topic: &'a str,
}

struct TauriProfileHooks {
    app: AppHandle,
    hub: Weak<FeatureHub>,
    wake: Arc<Notify>,
}

impl ProfileHooks for TauriProfileHooks {
    fn notify_changed(&self) {
        if let Some(hub) = self.hub.upgrade() {
            hub.notify_changed(TOPIC_PROFILE);
        }
    }

    fn ui_changed(&self) {
        let _ = self.app.emit(
            FEATURE_EVENT,
            FeatureChanged {
                topic: TOPIC_PROFILE,
            },
        );
    }

    fn wake_fetcher(&self) {
        self.wake.notify_one();
    }
}

struct Picked {
    token: String,
    bytes: Arc<Vec<u8>>,
    at: Instant,
}

/// The last file picked in Mira's photo dialog: its original bytes (not the
/// decoded image, to keep memory small) under a random token. Only one is
/// kept; a new pick replaces it. Used once, valid for [`PICK_TTL`].
#[derive(Default)]
pub struct PickSlot {
    inner: Mutex<Option<Picked>>,
}

impl PickSlot {
    pub fn put(&self, bytes: Vec<u8>, now: Instant) -> String {
        let token = crate::chat::model::random_hex32();
        *self.inner.lock().unwrap_or_else(|e| e.into_inner()) = Some(Picked {
            token: token.clone(),
            bytes: Arc::new(bytes),
            at: now,
        });
        token
    }

    /// The bytes under `token`; `PHOTO_TOKEN` when unknown, used or expired.
    pub fn get(&self, token: &str, now: Instant) -> AppResult<Arc<Vec<u8>>> {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        match guard.as_ref() {
            Some(p) if p.token == token && now.saturating_duration_since(p.at) <= PICK_TTL => {
                Ok(p.bytes.clone())
            }
            _ => Err(AppError::InvalidInput(PHOTO_TOKEN.into())),
        }
    }

    /// Forgets `token` (after the photo was saved).
    pub fn consume(&self, token: &str) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if guard.as_ref().is_some_and(|p| p.token == token) {
            *guard = None;
        }
    }
}

/// Managed Tauri state for the profile commands.
#[derive(Clone)]
pub struct ProfileRuntime {
    /// `Err` when the data folder could not be prepared; every command then
    /// returns that error.
    profile: Result<Arc<ProfileSync>, AppError>,
    pub hub: Arc<FeatureHub>,
    wake: Arc<Notify>,
    pub picks: Arc<PickSlot>,
}

impl ProfileRuntime {
    /// Builds the feature, registers it with the hub and starts the
    /// downloader. Needs `MiraState` and `Arc<FeatureHub>` in managed state.
    pub fn install(app: &AppHandle) -> ProfileRuntime {
        let state = app.state::<MiraState>().inner().clone();
        let hub = app.state::<Arc<FeatureHub>>().inner().clone();
        let wake = Arc::new(Notify::new());
        let hooks = Arc::new(TauriProfileHooks {
            app: app.clone(),
            hub: Arc::downgrade(&hub),
            wake: wake.clone(),
        });
        let profile = ProfileSync::new(state, hooks).map(Arc::new);
        match &profile {
            Ok(p) => {
                hub.register(p.clone());
                hub.register_blob_source(p.clone());
            }
            Err(err) => eprintln!(
                "Mira: foto profil belum bisa dipakai [{}]: {err}",
                err.code()
            ),
        }
        let runtime = ProfileRuntime {
            profile,
            hub,
            wake,
            picks: Arc::new(PickSlot::default()),
        };
        if runtime.profile.is_ok() {
            runtime.spawn_fetcher();
        }
        runtime
    }

    pub fn profile(&self) -> AppResult<Arc<ProfileSync>> {
        self.profile.clone()
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

    /// Tries every due photo once.
    pub async fn fetch_round(&self) {
        let Ok(profile) = self.profile() else { return };
        let jobs = match tauri::async_runtime::spawn_blocking(move || profile.fetch_jobs()).await {
            Ok(Ok(jobs)) => jobs,
            Ok(Err(err)) => {
                eprintln!(
                    "Mira: antrean unduhan foto profil tidak terbaca [{}]: {err}",
                    err.code()
                );
                return;
            }
            Err(_) => return,
        };
        for job in jobs {
            // Failures are recorded in the queue.
            let _ = self.fetch_one(job).await;
        }
    }

    async fn fetch_one(&self, job: PhotoJob) -> Result<(), String> {
        let tmp = self.tmp_path(&job.hash)?;
        let result = self
            .hub
            .fetch_blob(&job.hash, MAX_PHOTO_BYTES, vec![job.owner.clone()], &tmp)
            .await;
        let profile = self.profile().map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn_blocking(move || {
            let out = match result {
                Ok(_) => profile.fetch_done(&job, &tmp).map_err(|e| e.to_string()),
                Err(err) => {
                    let _ = profile.fetch_failed(&job);
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
            .profile()
            .and_then(|p| p.data_dir())
            .map_err(|e| e.to_string())?
            .join(TMP_DIR);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(dir.join(format!(
            "{hash}-{}.part",
            crate::chat::model::random_hex32()
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pick_is_used_once_and_expires() {
        let slot = PickSlot::default();
        let t0 = Instant::now();
        let token = slot.put(vec![1, 2, 3], t0);
        assert_eq!(token.len(), 32);
        assert_eq!(*slot.get(&token, t0).unwrap(), vec![1, 2, 3]);
        // Reading does not use it up (a bad crop can be retried).
        assert!(slot.get(&token, t0 + PICK_TTL).is_ok());
        assert_eq!(
            slot.get(&token, t0 + PICK_TTL + Duration::from_secs(1))
                .unwrap_err()
                .to_string(),
            PHOTO_TOKEN
        );
        slot.consume(&token);
        assert!(slot.get(&token, t0).is_err());
    }

    #[test]
    fn only_the_last_pick_is_kept() {
        let slot = PickSlot::default();
        let t0 = Instant::now();
        let first = slot.put(vec![1], t0);
        let second = slot.put(vec![2], t0);
        assert_ne!(first, second);
        assert!(slot.get(&first, t0).is_err());
        assert_eq!(*slot.get(&second, t0).unwrap(), vec![2]);
        // Consuming an old token leaves the current one alone.
        slot.consume(&first);
        assert!(slot.get(&second, t0).is_ok());
        assert!(slot.get("", t0).is_err());
    }
}
