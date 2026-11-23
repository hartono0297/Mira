//! In-app updates from GitHub Releases (`docs/plans/updater.md`).
//!
//! The frontend drives four commands in order: `update_info`, `update_check`,
//! `update_download` (progress over a channel) and `update_install`. The
//! update found by the check and the verified bytes of the download live in
//! [`UpdaterState`] between calls, so the UI never handles the package itself.
//!
//! Errors serialize like `AppError` (`{ code, message }`) but stay local to this
//! module, so `error.rs` does not change for the updater.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde::ser::{SerializeStruct, Serializer};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_updater::{Error as PluginError, Update, UpdaterExt};

use crate::net_backend::AppNet;
use crate::state::MiraState;

/// Whole-request cap for the check. Downloads have none (a slow office line
/// still finishes), only [`CONNECT_TIMEOUT`].
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Upper bound for the network goodbye inside the Windows exit hook, so a stuck
/// peer cannot keep the installer from starting.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// Pubkey prefix committed before the real key existed. Kept as a safety net:
/// a build carrying it must not try to update.
const PUBKEY_PLACEHOLDER_PREFIX: &str = "BELUM-DIISI";

/// Debug builds only: points the check at a local `latest.json` for testing.
#[cfg(debug_assertions)]
const ENDPOINT_ENV: &str = "MIRA_UPDATER_ENDPOINT";

/// Progress events are sent at most every [`PROGRESS_INTERVAL`] or every 1%.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Updater error with the same wire shape as `AppError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateError {
    code: &'static str,
    message: String,
}

impl UpdateError {
    fn offline() -> Self {
        Self {
            code: "update_offline",
            message: "Tidak bisa menghubungi GitHub. Coba lagi saat laptop tersambung ke internet."
                .into(),
        }
    }

    fn not_configured() -> Self {
        Self {
            code: "update_not_configured",
            message: "Pembaruan otomatis belum disiapkan di versi Mira ini.".into(),
        }
    }

    fn no_pending() -> Self {
        Self {
            code: "update_no_pending",
            message: "Belum ada pembaruan yang diunduh. Cek pembaruan dulu.".into(),
        }
    }

    fn bad_signature() -> Self {
        Self {
            code: "update_bad_signature",
            message: "Berkas pembaruan tidak cocok dengan tanda tangan Mira, jadi tidak dipasang."
                .into(),
        }
    }

    fn failed(detail: &str) -> Self {
        Self {
            code: "update_failed",
            message: format!("Pembaruan gagal: {}.", short_detail(detail)),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }
}

impl std::fmt::Display for UpdateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for UpdateError {}

impl Serialize for UpdateError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("UpdateError", 2)?;
        s.serialize_field("code", self.code)?;
        s.serialize_field("message", &self.message)?;
        s.end()
    }
}

/// Plugin messages are English and sometimes long or wrapped in backticks;
/// keep one readable clause for the Indonesian sentence around it.
fn short_detail(detail: &str) -> String {
    const MAX_CHARS: usize = 160;
    let cleaned = detail.replace('`', "").replace('\u{2014}', "-");
    let cleaned = cleaned.trim().trim_end_matches('.').trim();
    if cleaned.chars().count() <= MAX_CHARS {
        return cleaned.to_string();
    }
    let cut: String = cleaned.chars().take(MAX_CHARS).collect();
    format!("{}...", cut.trim_end())
}

/// A reqwest error means "offline" when no HTTP answer came back: connect and
/// DNS failures, timeouts, and transport errors while sending or streaming.
fn transport_is_offline(connect: bool, timeout: bool, transport: bool, has_status: bool) -> bool {
    !has_status && (connect || timeout || transport)
}

/// Maps a plugin error to the codes the UI knows.
pub fn classify(err: &PluginError) -> UpdateError {
    match err {
        PluginError::Reqwest(e) => {
            if transport_is_offline(
                e.is_connect(),
                e.is_timeout(),
                e.is_request() || e.is_body(),
                e.status().is_some(),
            ) {
                UpdateError::offline()
            } else {
                UpdateError::failed(&err.to_string())
            }
        }
        PluginError::Minisign(_)
        | PluginError::Base64(_)
        | PluginError::SignatureUtf8(_)
        | PluginError::SignedVersionMismatch { .. }
        | PluginError::MissingSignedVersion => UpdateError::bad_signature(),
        other => UpdateError::failed(&other.to_string()),
    }
}

/// The result of `Updater::check`. `ReleaseNotFound` is what every endpoint
/// answering 404 turns into (no `latest.json` on the newest release yet), and
/// from the user's side that simply means there is nothing to install.
fn check_outcome<T>(result: Result<Option<T>, PluginError>) -> Result<Option<T>, UpdateError> {
    match result {
        Ok(found) => Ok(found),
        Err(PluginError::ReleaseNotFound) => Ok(None),
        Err(err) => Err(classify(&err)),
    }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// False for a missing, empty or placeholder pubkey: such a build cannot verify
/// any package, so it should not even ask GitHub.
fn pubkey_configured(pubkey: Option<&str>) -> bool {
    match pubkey.map(str::trim) {
        Some(key) => !key.is_empty() && !key.starts_with(PUBKEY_PLACEHOLDER_PREFIX),
        None => false,
    }
}

fn is_configured<R: Runtime>(app: &AppHandle<R>) -> bool {
    let pubkey = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|section| section.get("pubkey"))
        .and_then(|value| value.as_str());
    pubkey_configured(pubkey)
}

/// A usable URL from `MIRA_UPDATER_ENDPOINT`, or `None` to keep the configured
/// endpoint. Compiled only into debug builds, so a release binary cannot be
/// pointed elsewhere through the environment.
#[cfg(debug_assertions)]
fn endpoint_override(value: Option<String>) -> Option<tauri::Url> {
    let value = value?;
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let url = tauri::Url::parse(value).ok()?;
    matches!(url.scheme(), "http" | "https").then_some(url)
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

struct Pending {
    update: Update,
    /// Set by `update_download` once the plugin has verified the signature.
    bytes: Option<Vec<u8>>,
}

/// The update found by the last check and, after a download, its bytes.
#[derive(Default)]
pub struct UpdaterState {
    pending: Mutex<Option<Pending>>,
}

impl UpdaterState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Pending>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn set_found(&self, update: Option<Update>) {
        *self.lock() = update.map(|update| Pending {
            update,
            bytes: None,
        });
    }

    fn found(&self) -> Option<Update> {
        self.lock().as_ref().map(|p| p.update.clone())
    }

    /// Keeps the bytes only if the check did not move on to another version
    /// while the download ran.
    fn store_bytes(&self, version: &str, bytes: Vec<u8>) {
        if let Some(pending) = self.lock().as_mut()
            && pending.update.version == version
        {
            pending.bytes = Some(bytes);
        }
    }

    fn take_ready(&self) -> Option<(Update, Vec<u8>)> {
        let mut guard = self.lock();
        let bytes = guard.as_mut()?.bytes.take()?;
        let update = guard.take()?.update;
        Some((update, bytes))
    }

    fn restore(&self, update: Update, bytes: Vec<u8>) {
        *self.lock() = Some(Pending {
            update,
            bytes: Some(bytes),
        });
    }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub configured: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub available: bool,
    pub current_version: String,
    #[serde(flatten)]
    pub release: Option<ReleaseInfo>,
}

/// Present only when `available` is true; `notes` and `date` are then always
/// sent, as `null` when the manifest has none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseInfo {
    pub version: String,
    pub notes: Option<String>,
    /// RFC 3339.
    pub date: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadEvent {
    /// Bytes received so far.
    pub downloaded: u64,
    /// `Content-Length`, when the server sent one.
    pub total: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Downloaded {
    pub version: String,
}

fn release_info(update: &Update) -> ReleaseInfo {
    ReleaseInfo {
        version: update.version.clone(),
        notes: update.body.clone().filter(|b| !b.trim().is_empty()),
        date: update.date.and_then(|d| {
            d.format(&time::format_description::well_known::Rfc3339)
                .ok()
        }),
    }
}

// ---------------------------------------------------------------------------
// Progress throttling
// ---------------------------------------------------------------------------

/// Decides which chunks become `DownloadEvent`s. A 30 MB installer arrives in
/// thousands of chunks; the UI only needs a smooth bar.
#[derive(Debug)]
struct ProgressThrottle {
    last_bytes: Option<u64>,
    last_at: Instant,
}

impl ProgressThrottle {
    fn new(now: Instant) -> Self {
        Self {
            last_bytes: None,
            last_at: now,
        }
    }

    fn should_emit(&mut self, downloaded: u64, total: Option<u64>, now: Instant) -> bool {
        let emit = match self.last_bytes {
            None => true,
            Some(last) if last == downloaded => false,
            Some(last) => {
                let one_percent = total.map(|t| (t / 100).max(1));
                total.is_some_and(|t| downloaded >= t)
                    || one_percent.is_some_and(|step| downloaded - last >= step)
                    || now.duration_since(self.last_at) >= PROGRESS_INTERVAL
            }
        };
        if emit {
            self.last_bytes = Some(downloaded);
            self.last_at = now;
        }
        emit
    }

    /// The closing event, unless the last one already reported these bytes.
    fn finish(&mut self, downloaded: u64) -> bool {
        let emit = self.last_bytes != Some(downloaded);
        self.last_bytes = Some(downloaded);
        emit
    }
}

// ---------------------------------------------------------------------------
// Network shutdown before exit
// ---------------------------------------------------------------------------

/// For the plugin's Windows `on_before_exit` hook: the installer is started and
/// then `std::process::exit(0)` runs, which skips `RunEvent::Exit`. The hook
/// is synchronous and may run on a runtime thread, where `block_on` would
/// panic, so the goodbye runs on a fresh thread. `AppNet::shutdown` is a no-op
/// when `update_install` already shut the network down.
fn shutdown_network_blocking<R: Runtime>(app: &AppHandle<R>) {
    let Some(net) = app.try_state::<AppNet>().map(|s| s.inner().clone()) else {
        return;
    };
    let _ = std::thread::spawn(move || {
        tauri::async_runtime::block_on(async move {
            let _ = tokio::time::timeout(SHUTDOWN_GRACE, net.shutdown()).await;
        });
    })
    .join();
}

/// Brings the network back after a failed install, as `run` does at startup.
fn restart_network(app: &AppHandle) {
    let (Some(state), Some(net)) = (app.try_state::<MiraState>(), app.try_state::<AppNet>()) else {
        return;
    };
    let state = state.inner().clone();
    let net = net.inner().clone();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = net.get(&state, &handle).await {
            eprintln!("Mira: jaringan belum berjalan [{}]: {err}", err.code());
        }
    });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn update_info(app: AppHandle) -> UpdateInfo {
    UpdateInfo {
        current_version: app.package_info().version.to_string(),
        configured: is_configured(&app),
    }
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<UpdateCheck, UpdateError> {
    let current_version = app.package_info().version.to_string();
    if !is_configured(&app) {
        return Err(UpdateError::not_configured());
    }

    let hook_app = app.clone();
    #[allow(unused_mut)]
    let mut builder = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .configure_client(|client| client.connect_timeout(CONNECT_TIMEOUT))
        .on_before_exit(move || shutdown_network_blocking(&hook_app));
    #[cfg(debug_assertions)]
    if let Some(url) = endpoint_override(std::env::var(ENDPOINT_ENV).ok()) {
        builder = builder.endpoints(vec![url]).map_err(|e| classify(&e))?;
    }
    let updater = builder.build().map_err(|e| classify(&e))?;
    let found = check_outcome(updater.check().await)?;

    let release = found.as_ref().map(release_info);
    app.state::<UpdaterState>().set_found(found);
    Ok(UpdateCheck {
        available: release.is_some(),
        current_version,
        release,
    })
}

#[tauri::command]
pub async fn update_download(
    app: AppHandle,
    on_event: Channel<DownloadEvent>,
) -> Result<Downloaded, UpdateError> {
    let state = app.state::<UpdaterState>();
    let mut update = state.found().ok_or_else(UpdateError::no_pending)?;
    // The check's 20 s cap would cut off a download on a slow line; the
    // connect timeout from `configure_client` still applies.
    update.timeout = None;

    let mut throttle = ProgressThrottle::new(Instant::now());
    let mut downloaded: u64 = 0;
    let mut total: Option<u64> = None;
    let bytes = update
        .download(
            |chunk, length| {
                downloaded += chunk as u64;
                total = length;
                if throttle.should_emit(downloaded, length, Instant::now()) {
                    let _ = on_event.send(DownloadEvent { downloaded, total });
                }
            },
            || {},
        )
        .await
        .map_err(|e| classify(&e))?;

    let size = bytes.len() as u64;
    if throttle.finish(size) {
        let _ = on_event.send(DownloadEvent {
            downloaded: size,
            total: total.or(Some(size)),
        });
    }
    state.store_bytes(&update.version, bytes);
    Ok(Downloaded {
        version: update.version,
    })
}

/// Windows: the plugin starts the installer and exits, so this does not
/// return; the installer opens Mira again. macOS: the `.app` is replaced, then
/// Mira restarts itself.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), UpdateError> {
    let state = app.state::<UpdaterState>();
    let (update, bytes) = state.take_ready().ok_or_else(UpdateError::no_pending)?;

    app.state::<AppNet>().inner().clone().shutdown().await;

    // `install` blocks (and on Windows runs the exit hook), so keep it off the
    // async workers.
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let result = update.install(&bytes);
        (update, bytes, result)
    })
    .await;

    match joined {
        Ok((_, _, Ok(()))) => app.restart(),
        Ok((update, bytes, Err(err))) => {
            state.restore(update, bytes);
            restart_network(&app);
            Err(classify(&err))
        }
        Err(err) => {
            restart_network(&app);
            Err(UpdateError::failed(&err.to_string()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_and_empty_pubkeys_are_not_configured() {
        assert!(!pubkey_configured(None));
        assert!(!pubkey_configured(Some("")));
        assert!(!pubkey_configured(Some("   ")));
        assert!(!pubkey_configured(Some(
            "BELUM-DIISI-lihat-docs-plans-updater.md"
        )));
        assert!(pubkey_configured(Some(
            "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWdu"
        )));
    }

    #[test]
    fn committed_config_has_a_real_pubkey() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater = &config["plugins"]["updater"];
        assert!(pubkey_configured(updater["pubkey"].as_str()));
        assert_eq!(updater["windows"]["installMode"], "quiet");
        // Blocks pairing a newer version number with an older signed package.
        assert_eq!(updater["requireSignedVersion"], true);
        assert_eq!(
            updater["endpoints"][0],
            "https://github.com/hartono0297/Mira/releases/latest/download/latest.json"
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn endpoint_override_accepts_only_http_urls() {
        assert_eq!(endpoint_override(None), None);
        assert_eq!(endpoint_override(Some(String::new())), None);
        assert_eq!(endpoint_override(Some("  ".into())), None);
        assert_eq!(endpoint_override(Some("bukan url".into())), None);
        assert_eq!(
            endpoint_override(Some("file:///C:/latest.json".into())),
            None
        );
        let url = endpoint_override(Some(" http://127.0.0.1:8787/latest.json ".into())).unwrap();
        assert_eq!(url.as_str(), "http://127.0.0.1:8787/latest.json");
        assert!(endpoint_override(Some("https://example.test/latest.json".into())).is_some());
    }

    #[test]
    fn offline_only_without_an_http_status() {
        assert!(transport_is_offline(true, false, false, false));
        assert!(transport_is_offline(false, true, false, false));
        assert!(transport_is_offline(false, false, true, false));
        assert!(!transport_is_offline(false, false, false, false));
        assert!(!transport_is_offline(false, false, true, true));
    }

    #[test]
    fn signature_errors_map_to_bad_signature() {
        let cases = [
            PluginError::SignatureUtf8("x".into()),
            PluginError::MissingSignedVersion,
            PluginError::SignedVersionMismatch {
                signed: "0.3.0".into(),
                announced: "0.4.0".into(),
            },
        ];
        for err in cases {
            assert_eq!(classify(&err).code(), "update_bad_signature", "{err}");
        }
    }

    #[test]
    fn other_errors_map_to_failed_with_short_detail() {
        let err = classify(&PluginError::Network(
            "Download request failed with status: 404 Not Found".into(),
        ));
        assert_eq!(err.code(), "update_failed");
        assert_eq!(
            err.to_string(),
            "Pembaruan gagal: Download request failed with status: 404 Not Found."
        );
        let io = classify(&PluginError::Io(std::io::Error::other("disk penuh")));
        assert_eq!(io.to_string(), "Pembaruan gagal: disk penuh.");
        assert_eq!(
            classify(&PluginError::EmptyEndpoints).code(),
            "update_failed"
        );
    }

    #[test]
    fn release_not_found_means_up_to_date() {
        assert_eq!(
            check_outcome::<()>(Err(PluginError::ReleaseNotFound)),
            Ok(None)
        );
        assert_eq!(check_outcome(Ok(Some(1))), Ok(Some(1)));
        assert_eq!(check_outcome::<()>(Ok(None)), Ok(None));
        assert_eq!(
            check_outcome::<()>(Err(PluginError::TargetNotFound("windows-x86_64".into())))
                .unwrap_err()
                .code(),
            "update_failed"
        );
    }

    #[test]
    fn short_detail_trims_and_caps() {
        assert_eq!(short_detail("  `boom`. "), "boom");
        assert_eq!(short_detail("a \u{2014} b"), "a - b");
        let long = "x".repeat(500);
        let cut = short_detail(&long);
        assert!(cut.ends_with("..."));
        assert_eq!(cut.chars().count(), 163);
    }

    #[test]
    fn errors_serialize_as_code_and_message_without_em_dash() {
        let all = [
            UpdateError::offline(),
            UpdateError::not_configured(),
            UpdateError::no_pending(),
            UpdateError::bad_signature(),
            UpdateError::failed("x"),
        ];
        let codes = [
            "update_offline",
            "update_not_configured",
            "update_no_pending",
            "update_bad_signature",
            "update_failed",
        ];
        for (err, code) in all.iter().zip(codes) {
            let json = serde_json::to_value(err).unwrap();
            assert_eq!(json["code"], code);
            assert_eq!(json["message"], err.to_string());
            assert_eq!(json.as_object().unwrap().len(), 2);
            assert!(!err.to_string().contains('\u{2014}'), "{code}");
        }
    }

    #[test]
    fn results_serialize_in_camel_case() {
        let info = serde_json::to_value(UpdateInfo {
            current_version: "0.3.0".into(),
            configured: true,
        })
        .unwrap();
        assert_eq!(
            info,
            serde_json::json!({ "currentVersion": "0.3.0", "configured": true })
        );

        let none = serde_json::to_value(UpdateCheck {
            available: false,
            current_version: "0.3.0".into(),
            release: None,
        })
        .unwrap();
        assert_eq!(
            none,
            serde_json::json!({ "available": false, "currentVersion": "0.3.0" })
        );

        let some = serde_json::to_value(UpdateCheck {
            available: true,
            current_version: "0.3.0".into(),
            release: Some(ReleaseInfo {
                version: "0.4.0".into(),
                notes: None,
                date: Some("2026-11-23T08:00:00Z".into()),
            }),
        })
        .unwrap();
        assert_eq!(
            some,
            serde_json::json!({
                "available": true,
                "currentVersion": "0.3.0",
                "version": "0.4.0",
                "notes": null,
                "date": "2026-11-23T08:00:00Z",
            })
        );

        let event = serde_json::to_value(DownloadEvent {
            downloaded: 10,
            total: None,
        })
        .unwrap();
        assert_eq!(
            event,
            serde_json::json!({ "downloaded": 10, "total": null })
        );
        assert_eq!(
            serde_json::to_value(Downloaded {
                version: "0.4.0".into()
            })
            .unwrap(),
            serde_json::json!({ "version": "0.4.0" })
        );
    }

    #[test]
    fn progress_emits_first_then_per_percent_or_interval() {
        let start = Instant::now();
        let mut t = ProgressThrottle::new(start);
        let total = Some(10_000);
        assert!(t.should_emit(10, total, start));
        // Under 1% and under 200 ms: skipped.
        assert!(!t.should_emit(50, total, start + Duration::from_millis(10)));
        // 1% (100 bytes) since the last event.
        assert!(t.should_emit(110, total, start + Duration::from_millis(20)));
        // Interval elapsed with tiny progress.
        assert!(t.should_emit(115, total, start + Duration::from_millis(300)));
        // Same byte count is never repeated.
        assert!(!t.should_emit(115, total, start + Duration::from_secs(2)));
        // Reaching the total always emits.
        assert!(t.should_emit(10_000, total, start + Duration::from_millis(310)));
        // Final event already sent for these bytes.
        assert!(!t.finish(10_000));
    }

    #[test]
    fn progress_without_total_uses_the_interval_and_finishes() {
        let start = Instant::now();
        let mut t = ProgressThrottle::new(start);
        assert!(t.should_emit(1, None, start));
        assert!(!t.should_emit(1_000_000, None, start + Duration::from_millis(100)));
        assert!(t.should_emit(2_000_000, None, start + Duration::from_millis(250)));
        assert!(t.finish(2_500_000));
        assert!(!t.finish(2_500_000));
    }
}
