//! Test-only transport for end-to-end tests with several Mira instances on one
//! PC, until the real feature transport (`network/node.rs`) is merged. Active
//! only when `MIRA_TEST_BRIDGE_DIR` is set; otherwise every command here
//! returns `forbidden` and the hub keeps its normal link.
//!
//! The test script moves records with [`debug_feature_offer`] (on the sending
//! instance, filtered by the feature exactly like the transport would) and
//! [`debug_feature_ingest`] (on the receiving instance: `unknown_ids`,
//! `check_incoming`, `ingest`, then the `mira://feature` event). Blobs move
//! through the shared folder:
//!
//! - `peers/<pk>`: written by each instance at start; `connected_peers` lists
//!   the other instances (the script removes a file to simulate "offline").
//! - `wants/<pk>/<hash>`: written while an instance waits in `fetch_blob`.
//! - `blobs/<hash>`: written by [`debug_blob_serve`] on an instance that may
//!   serve the blob to that peer (`FeatureHub::blob_path_for`, the same check
//!   as the transport). `fetch_blob` then checks size and BLAKE3 and copies
//!   it to its destination.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::error::{AppError, AppResult};
use crate::network::feature::{BlobFuture, FeatureHub, FeatureLink, FeatureRecord, check_incoming};
use crate::org::is_lower_hex;

/// Folder shared by the instances of one test run.
pub const BRIDGE_DIR_ENV: &str = "MIRA_TEST_BRIDGE_DIR";

/// Event the real transport emits after an ingest that changed something.
pub const FEATURE_EVENT: &str = "mira://feature";

const FETCH_TIMEOUT: Duration = Duration::from_secs(60);

fn bridge_dir() -> Option<PathBuf> {
    std::env::var_os(BRIDGE_DIR_ENV)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn require_bridge() -> AppResult<PathBuf> {
    bridge_dir().ok_or_else(|| {
        AppError::Forbidden("Perintah uji ini hanya aktif dalam uji ujung ke ujung.".into())
    })
}

/// The test link, or `None` without [`BRIDGE_DIR_ENV`].
pub fn link_from_env(my_pk: &str) -> Option<Arc<dyn FeatureLink>> {
    let dir = bridge_dir()?;
    let link = BridgeLink {
        dir,
        me: my_pk.to_owned(),
    };
    for sub in ["peers", "blobs"] {
        let _ = std::fs::create_dir_all(link.dir.join(sub));
    }
    let _ = std::fs::create_dir_all(link.dir.join("wants").join(my_pk));
    let _ = std::fs::write(link.dir.join("peers").join(my_pk), b"");
    Some(Arc::new(link))
}

struct BridgeLink {
    dir: PathBuf,
    me: String,
}

fn fetch(dir: &Path, me: &str, hash: &str, max_size: u64, dest: &Path) -> Result<u64, String> {
    if !is_lower_hex(hash, 64) {
        return Err("hash tidak valid".into());
    }
    let want = dir.join("wants").join(me).join(hash);
    std::fs::write(&want, max_size.to_string()).map_err(|e| e.to_string())?;
    let src = dir.join("blobs").join(hash);
    let start = std::time::Instant::now();
    let result = loop {
        if let Ok(bytes) = std::fs::read(&src) {
            if bytes.len() as u64 > max_size {
                break Err("blob lebih besar dari batas".to_owned());
            }
            if blake3::hash(&bytes).to_hex().as_str() != hash {
                break Err("hash blob tidak cocok".to_owned());
            }
            break std::fs::write(dest, &bytes)
                .map(|_| bytes.len() as u64)
                .map_err(|e| e.to_string());
        }
        if start.elapsed() > FETCH_TIMEOUT {
            break Err("Belum ada laptop rekan yang mengirim file ini.".to_owned());
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    let _ = std::fs::remove_file(&want);
    if result.is_err() {
        let _ = std::fs::remove_file(dest);
    }
    result
}

impl FeatureLink for BridgeLink {
    fn notify_changed(&self, _topic: &str) {}

    fn fetch_blob(
        &self,
        hash: String,
        max_size: u64,
        _prefer: Vec<String>,
        dest: PathBuf,
    ) -> BlobFuture {
        let (dir, me) = (self.dir.clone(), self.me.clone());
        Box::pin(async move {
            tokio::task::spawn_blocking(move || fetch(&dir, &me, &hash, max_size, &dest))
                .await
                .map_err(|e| e.to_string())?
        })
    }

    fn connected_peers(&self) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(self.dir.join("peers")) else {
            return Vec::new();
        };
        entries
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter(|pk| is_lower_hex(pk, 64) && *pk != self.me)
            .collect()
    }
}

fn feature(
    hub: &FeatureHub,
    topic: &str,
) -> AppResult<Arc<dyn crate::network::feature::FeatureSync>> {
    hub.feature(topic)
        .ok_or_else(|| AppError::NotFound(format!("Fitur {topic} belum terdaftar.")))
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .map_err(AppError::Internal)
}

/// Sender side: every record of `topic` that `peer` may receive.
#[tauri::command]
pub async fn debug_feature_offer(
    hub: State<'_, Arc<FeatureHub>>,
    topic: String,
    peer: String,
) -> AppResult<Vec<FeatureRecord>> {
    require_bridge()?;
    let f = feature(&hub, &topic)?;
    blocking(move || {
        let ids = f.record_ids_for(&peer)?;
        f.records_for(&peer, &ids)
    })
    .await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeIngest {
    pub accepted: usize,
    pub rejected: usize,
    pub dropped: usize,
}

#[derive(Clone, Serialize)]
struct FeatureChanged {
    topic: String,
}

/// Receiver side: what the transport does with an offer from `from`.
#[tauri::command]
pub async fn debug_feature_ingest(
    app: AppHandle,
    hub: State<'_, Arc<FeatureHub>>,
    topic: String,
    from: String,
    records: Vec<FeatureRecord>,
) -> AppResult<BridgeIngest> {
    require_bridge()?;
    let f = feature(&hub, &topic)?;
    let out = blocking(move || {
        let ids: Vec<String> = records.iter().map(|r| r.id.clone()).collect();
        let wanted: std::collections::HashSet<String> = f.unknown_ids(&ids)?.into_iter().collect();
        let fresh: Vec<FeatureRecord> = records
            .into_iter()
            .filter(|r| wanted.contains(&r.id))
            .collect();
        let (ok, dropped) = check_incoming(fresh);
        if ok.is_empty() {
            return Ok((
                BridgeIngest {
                    accepted: 0,
                    rejected: 0,
                    dropped,
                },
                false,
            ));
        }
        let got = f.ingest(&from, ok)?;
        Ok((
            BridgeIngest {
                accepted: got.accepted,
                rejected: got.rejected,
                dropped,
            },
            got.changed,
        ))
    })
    .await?;
    if out.1 {
        let _ = app.emit(FEATURE_EVENT, FeatureChanged { topic });
    }
    Ok(out.0)
}

/// Copies blob `hash` into the shared folder if `peer` may download it from
/// this instance. Returns `false` when refused or missing.
#[tauri::command]
pub async fn debug_blob_serve(
    hub: State<'_, Arc<FeatureHub>>,
    peer: String,
    hash: String,
) -> AppResult<bool> {
    let dir = require_bridge()?;
    let Some(path) = hub.blob_path_for(&peer, &hash) else {
        return Ok(false);
    };
    blocking(move || {
        let tmp = dir.join("blobs").join(format!(".{hash}.tmp"));
        std::fs::copy(&path, &tmp).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, dir.join("blobs").join(&hash)).map_err(|e| e.to_string())?;
        Ok(true)
    })
    .await
}

/// Tells every feature that `peer` is connected (retries downloads).
#[tauri::command]
pub async fn debug_peer_connected(hub: State<'_, Arc<FeatureHub>>, peer: String) -> AppResult<()> {
    require_bridge()?;
    let features = hub.features();
    blocking(move || {
        for f in features {
            f.peer_connected(&peer);
        }
        Ok(())
    })
    .await
}
