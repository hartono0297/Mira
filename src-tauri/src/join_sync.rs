//! Join requests between member laptops (v0.3, docs/plans/v0.3-kontrak.md
//! 8.4 and 8.6).
//!
//! - [`JoinFeature`]: the `join` feature topic. A request that reached any
//!   member is forwarded only to the laptops that may decide it (superadmin,
//!   or admin of the requested department). All checks live in
//!   `permissions::join_store`; this is the adapter.
//! - [`JoinNotifier`]: one OS notification per 5 minutes at most for new
//!   requests this laptop may decide. Requests that arrive inside the window
//!   are held and go into the next notification.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::board::reminder::{Notifier, TauriNotifier};
use crate::clock;
use crate::error::AppResult;
use crate::network::feature::{FeatureHub, FeatureIngest, FeatureRecord, FeatureSync, TOPIC_JOIN};
use crate::org_commands::EVENT_JOIN_REQUESTS;
use crate::permissions::{self, JoinRequestView};
use crate::state::MiraState;
use crate::ui_lang::UiLang;

/// At most one notification per this window (contract 8.6).
pub const NOTIFY_WINDOW: Duration = Duration::from_secs(5 * 60);

// ----- Feature topic `join` ------------------------------------------------------

/// `FeatureSync` for topic `join` over the shared state.
pub struct JoinFeature {
    state: MiraState,
}

impl JoinFeature {
    pub fn new(state: MiraState) -> Self {
        Self { state }
    }
}

impl FeatureSync for JoinFeature {
    fn topic(&self) -> &'static str {
        TOPIC_JOIN
    }

    fn record_ids_for(&self, peer: &str) -> Result<Vec<String>, String> {
        self.state
            .with_core(|c| {
                let Some(state) = permissions::load_state(&c.db)? else {
                    return Ok(Vec::new());
                };
                permissions::join_record_ids_for(&c.db, &state, peer)
            })
            .map_err(|e| e.to_string())
    }

    fn unknown_ids(&self, ids: &[String]) -> Result<Vec<String>, String> {
        self.state
            .with_core(|c| permissions::unknown_join_record_ids(&c.db, ids))
            .map_err(|e| e.to_string())
    }

    fn records_for(&self, peer: &str, ids: &[String]) -> Result<Vec<FeatureRecord>, String> {
        self.state
            .with_core(|c| {
                let Some(state) = permissions::load_state(&c.db)? else {
                    return Ok(Vec::new());
                };
                Ok(permissions::join_records_for(&c.db, &state, peer, ids)?
                    .into_iter()
                    .map(|(id, body)| FeatureRecord { id, body })
                    .collect())
            })
            .map_err(|e| e.to_string())
    }

    /// `from` is the key the transport proved in TLS, never a value taken
    /// from the records.
    fn ingest(&self, from: &str, records: Vec<FeatureRecord>) -> Result<FeatureIngest, String> {
        let bodies: Vec<String> = records.into_iter().map(|r| r.body).collect();
        self.state
            .with_core(|c| permissions::ingest_join_records(&mut c.db, from, &bodies, clock::now()))
            .map(|r| FeatureIngest {
                accepted: r.accepted,
                rejected: r.rejected,
                changed: r.accepted > 0,
            })
            .map_err(|e| e.to_string())
    }
}

/// Registers [`JoinFeature`] on the managed hub and manages the approver
/// notifier. Needs `MiraState` and `Arc<FeatureHub>` managed first.
pub fn register<R: Runtime>(app: &AppHandle<R>) {
    let (Some(hub), Some(state)) = (
        app.try_state::<Arc<FeatureHub>>(),
        app.try_state::<MiraState>(),
    ) else {
        eprintln!("Mira: sinkron permintaan bergabung tidak didaftarkan (state belum dikelola).");
        return;
    };
    let state = state.inner().clone();
    hub.register(Arc::new(JoinFeature::new(state.clone())));
    app.manage(JoinAlerts::new(JoinNotifier::new(
        Arc::new(DbPendingJoins { state }),
        Arc::new(TauriNotifier::new(app.clone())),
    )));
}

/// Join requests held here changed (received directly or forwarded): tell
/// the UI and check whether to notify. Cheap; the check runs on the
/// blocking pool.
pub fn join_requests_changed<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit(EVENT_JOIN_REQUESTS, ());
    if let Some(alerts) = app.try_state::<JoinAlerts>() {
        alerts.trigger();
    }
}

// ----- Approver notifications ---------------------------------------------------------

/// The requests this laptop may decide right now.
pub trait PendingJoins: Send + Sync {
    fn pending(&self) -> AppResult<Vec<JoinRequestView>>;
    /// Language of the notification text.
    fn lang(&self) -> UiLang {
        UiLang::default()
    }
}

/// `permissions::pending_join_requests` for this laptop.
pub struct DbPendingJoins {
    pub state: MiraState,
}

impl PendingJoins for DbPendingJoins {
    fn pending(&self) -> AppResult<Vec<JoinRequestView>> {
        self.state.with_core(|c| {
            let Some(state) = permissions::load_state(&c.db)? else {
                return Ok(Vec::new());
            };
            permissions::pending_join_requests(
                &c.db,
                &state,
                c.identity.public_key_hex(),
                clock::now(),
            )
        })
    }

    fn lang(&self) -> UiLang {
        UiLang::current(&self.state)
    }
}

/// What to do after a check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AlertDecision {
    /// No request that was not notified yet.
    Nothing,
    /// Show this notification now.
    Send { title: String, body: String },
    /// New requests are held by the 5-minute window; check again then.
    WaitUntil(Instant),
}

/// The rate-limit decision, without Tauri or a database: which request ids
/// were notified already and when the last notification went out.
#[derive(Debug, Default)]
pub struct AlertGate {
    notified: HashSet<String>,
    last_sent: Option<Instant>,
}

impl AlertGate {
    pub fn decide(
        &mut self,
        pending: &[JoinRequestView],
        now: Instant,
        lang: UiLang,
    ) -> AlertDecision {
        // Forget requests that were decided or dropped, so the set stays small.
        self.notified
            .retain(|id| pending.iter().any(|p| &p.id == id));
        let new: Vec<&JoinRequestView> = pending
            .iter()
            .filter(|p| !self.notified.contains(&p.id))
            .collect();
        if new.is_empty() {
            return AlertDecision::Nothing;
        }
        if let Some(last) = self.last_sent {
            let open_at = last + NOTIFY_WINDOW;
            if now < open_at {
                return AlertDecision::WaitUntil(open_at);
            }
        }
        let (title, body) = alert_text(&new, lang);
        for p in &new {
            self.notified.insert(p.id.clone());
        }
        self.last_sent = Some(now);
        AlertDecision::Send { title, body }
    }
}

/// Notification text for the requests not notified yet (at least one).
pub fn alert_text(new: &[&JoinRequestView], lang: UiLang) -> (String, String) {
    if lang == UiLang::En {
        return alert_text_en(new);
    }
    let title = "Permintaan bergabung baru".to_owned();
    let body = match new {
        [one] if one.team_name.is_empty() => format!(
            "{} minta bergabung ke kantor. Buka Organisasi untuk mencocokkan kode dan menyetujui.",
            one.display_name
        ),
        [one] => format!(
            "{} minta bergabung ke departemen {}. Buka Organisasi untuk mencocokkan kode dan menyetujui.",
            one.display_name, one.team_name
        ),
        many => format!(
            "{} orang minta bergabung. Buka Organisasi untuk memeriksanya.",
            many.len()
        ),
    };
    (title, body)
}

fn alert_text_en(new: &[&JoinRequestView]) -> (String, String) {
    let title = "New join request".to_owned();
    let body = match new {
        [one] if one.team_name.is_empty() => format!(
            "{} wants to join the office. Open Organization to match the code and approve.",
            one.display_name
        ),
        [one] => format!(
            "{} wants to join the {} department. Open Organization to match the code and approve.",
            one.display_name, one.team_name
        ),
        many => format!(
            "{} people want to join. Open Organization to review them.",
            many.len()
        ),
    };
    (title, body)
}

/// Checks the pending requests and notifies through `notifier`.
pub struct JoinNotifier {
    gate: Mutex<AlertGate>,
    source: Arc<dyn PendingJoins>,
    notifier: Arc<dyn Notifier>,
}

impl JoinNotifier {
    pub fn new(source: Arc<dyn PendingJoins>, notifier: Arc<dyn Notifier>) -> Self {
        Self {
            gate: Mutex::new(AlertGate::default()),
            source,
            notifier,
        }
    }

    /// One check at `now`. Returns when to check again if new requests are
    /// held by the window.
    pub fn check(&self, now: Instant) -> Option<Instant> {
        let pending = match self.source.pending() {
            Ok(p) => p,
            Err(e) => {
                eprintln!(
                    "Mira: permintaan bergabung tidak terbaca [{}]: {e}",
                    e.code()
                );
                return None;
            }
        };
        let lang = self.source.lang();
        let decision = self
            .gate
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .decide(&pending, now, lang);
        match decision {
            AlertDecision::Nothing => None,
            AlertDecision::WaitUntil(at) => Some(at),
            AlertDecision::Send { title, body } => {
                if let Err(e) = self.notifier.notify(&title, &body) {
                    eprintln!("Mira: notifikasi permintaan bergabung gagal: {e}");
                }
                None
            }
        }
    }
}

/// Managed state: the notifier plus the single delayed re-check.
pub struct JoinAlerts {
    notifier: Arc<JoinNotifier>,
    recheck_pending: Arc<AtomicBool>,
}

impl JoinAlerts {
    pub fn new(notifier: JoinNotifier) -> Self {
        Self {
            notifier: Arc::new(notifier),
            recheck_pending: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Runs a check on the blocking pool; schedules one re-check at the end
    /// of the window when requests are held.
    pub fn trigger(&self) {
        let notifier = self.notifier.clone();
        let flag = self.recheck_pending.clone();
        tauri::async_runtime::spawn_blocking(move || {
            run_check(notifier, flag);
        });
    }
}

fn run_check(notifier: Arc<JoinNotifier>, flag: Arc<AtomicBool>) {
    let Some(at) = notifier.check(Instant::now()) else {
        return;
    };
    if flag.swap(true, Ordering::SeqCst) {
        return; // A re-check is already waiting.
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep_until(tokio::time::Instant::from_std(at)).await;
        flag.store(false, Ordering::SeqCst);
        let _ = tauri::async_runtime::spawn_blocking(move || run_check(notifier, flag)).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(id: &str, name: &str, team: &str) -> JoinRequestView {
        JoinRequestView {
            id: id.repeat(64 / id.len()),
            public_key: "11".repeat(32),
            display_name: name.into(),
            team_id: "22".repeat(16),
            team_name: team.into(),
            laptop: "LAPTOP-01".into(),
            os: "Windows 11".into(),
            app_version: "0.3.0".into(),
            requested_at: "2026-11-23T08:00:00Z".into(),
            received_at: "2026-11-23T08:00:01Z".into(),
            code: "ABCD EFGH".into(),
            ip: Some("192.168.1.20".into()),
            seen_by_name: Some("Budi".into()),
            note: None,
            account: None,
            ad: None,
            requester_outdated: false,
            previously_removed: None,
        }
    }

    #[derive(Default)]
    struct FakeSource(Mutex<Vec<JoinRequestView>>);
    impl PendingJoins for FakeSource {
        fn pending(&self) -> AppResult<Vec<JoinRequestView>> {
            Ok(self.0.lock().unwrap().clone())
        }
    }

    #[derive(Default)]
    struct FakeNotifier(Mutex<Vec<(String, String)>>);
    impl Notifier for FakeNotifier {
        fn notify(&self, title: &str, body: &str) -> Result<(), String> {
            self.0.lock().unwrap().push((title.into(), body.into()));
            Ok(())
        }
    }

    fn setup() -> (Arc<FakeSource>, Arc<FakeNotifier>, JoinNotifier) {
        let source = Arc::new(FakeSource::default());
        let sent = Arc::new(FakeNotifier::default());
        let n = JoinNotifier::new(source.clone(), sent.clone());
        (source, sent, n)
    }

    #[test]
    fn first_request_notifies_with_name_and_department() {
        let (source, sent, n) = setup();
        *source.0.lock().unwrap() = vec![req("a", "Rina", "Desain")];
        assert_eq!(n.check(Instant::now()), None);
        let sent = sent.0.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].0, "Permintaan bergabung baru");
        assert_eq!(
            sent[0].1,
            "Rina minta bergabung ke departemen Desain. Buka Organisasi untuk mencocokkan kode dan menyetujui."
        );
        assert!(!sent[0].1.contains('\u{2014}'));
    }

    #[test]
    fn second_request_inside_window_is_held_then_summarized() {
        let (source, sent, n) = setup();
        let t0 = Instant::now();
        *source.0.lock().unwrap() = vec![req("a", "Rina", "Desain")];
        n.check(t0);
        source.0.lock().unwrap().push(req("b", "Joko", "Keuangan"));
        // Inside the window: held, with a re-check at the end of it.
        assert_eq!(
            n.check(t0 + Duration::from_secs(60)),
            Some(t0 + NOTIFY_WINDOW)
        );
        assert_eq!(sent.0.lock().unwrap().len(), 1);
        source.0.lock().unwrap().push(req("c", "Sari", "Desain"));
        assert_eq!(
            n.check(t0 + Duration::from_secs(120)),
            Some(t0 + NOTIFY_WINDOW)
        );
        // After the window: the held request and the newer one, in one summary.
        assert_eq!(n.check(t0 + NOTIFY_WINDOW), None);
        let sent = sent.0.lock().unwrap();
        assert_eq!(sent.len(), 2);
        assert_eq!(
            sent[1].1,
            "2 orang minta bergabung. Buka Organisasi untuk memeriksanya."
        );
    }

    #[test]
    fn notified_requests_do_not_notify_again() {
        let (source, sent, n) = setup();
        let t0 = Instant::now();
        *source.0.lock().unwrap() = vec![req("a", "Rina", "Desain")];
        n.check(t0);
        assert_eq!(n.check(t0 + NOTIFY_WINDOW * 2), None);
        assert_eq!(n.check(t0 + NOTIFY_WINDOW * 3), None);
        assert_eq!(sent.0.lock().unwrap().len(), 1);
        // A request decided meanwhile is forgotten; a new one notifies.
        *source.0.lock().unwrap() = vec![req("d", "Dewi", "")];
        assert_eq!(n.check(t0 + NOTIFY_WINDOW * 4), None);
        let sent = sent.0.lock().unwrap();
        assert_eq!(sent.len(), 2);
        assert_eq!(
            sent[1].1,
            "Dewi minta bergabung ke kantor. Buka Organisasi untuk mencocokkan kode dan menyetujui."
        );
    }

    #[test]
    fn alert_text_in_english() {
        let (a, b, c) = (
            req("a", "Rina", "Desain"),
            req("b", "Joko", ""),
            req("c", "Sari", "Desain"),
        );
        assert_eq!(
            alert_text(&[&a], UiLang::En),
            (
                "New join request".into(),
                "Rina wants to join the Desain department. Open Organization to match the code and approve."
                    .into()
            )
        );
        assert_eq!(
            alert_text(&[&b], UiLang::En).1,
            "Joko wants to join the office. Open Organization to match the code and approve."
        );
        assert_eq!(
            alert_text(&[&a, &c], UiLang::En).1,
            "2 people want to join. Open Organization to review them."
        );
        assert_eq!(alert_text(&[&a], UiLang::Id).0, "Permintaan bergabung baru");
    }

    #[test]
    fn laptop_that_may_not_decide_never_notifies() {
        let (_source, sent, n) = setup();
        let t0 = Instant::now();
        for i in 0..5 {
            assert_eq!(n.check(t0 + NOTIFY_WINDOW * i), None);
        }
        assert!(sent.0.lock().unwrap().is_empty());
    }
}
