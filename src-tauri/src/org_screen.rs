//! Extra pieces for the Organisasi page (v0.3 part B, docs/plans/v03-b.md):
//!
//! - `org_fingerprint`: the short organization fingerprint (`XXXX-XXXX`) for
//!   the page header, so people can compare it by phone with the screen of a
//!   laptop that asks to join (docs/plans/v0.3-kontrak.md, 8.6).
//! - An OS notification when a join request this laptop may decide arrives
//!   (`mira://join-requests`), at most one per 5 minutes. The menu count
//!   stays exact either way; it comes from `org_overview`.
//!
//! TypeScript side: `src/api/orgScreen.ts`.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Listener, Manager, Runtime, State};
use time::{Duration, OffsetDateTime};

use crate::clock;
use crate::error::AppResult;
use crate::org_commands::EVENT_JOIN_REQUESTS;
use crate::permissions::{self, JoinRequestView};
use crate::state::MiraState;

/// Minimum time between two join request notifications.
pub const ALERT_GAP: Duration = Duration::minutes(5);

#[tauri::command]
pub async fn org_fingerprint(state: State<'_, MiraState>) -> AppResult<String> {
    state.with_core(|c| {
        let s = permissions::require_state(&c.db)?;
        Ok(permissions::org_fingerprint_short(&s.org))
    })
}

/// What the notifier remembers between events.
#[derive(Debug, Default)]
pub struct AlertState {
    /// Pending request ids already seen (notified or skipped by the gap).
    seen: HashSet<String>,
    last: Option<OffsetDateTime>,
}

impl AlertState {
    /// Requests pending at start were there before this run: no notification.
    pub fn seeded(pending: &[JoinRequestView]) -> Self {
        Self {
            seen: pending.iter().map(|r| r.id.clone()).collect(),
            last: None,
        }
    }
}

/// Title and body of the notification for the requests in `pending` that
/// were not seen before, or `None` (nothing new, or the last notification was
/// less than [`ALERT_GAP`] ago). New requests are marked seen either way, so a
/// flood shows one notification, not one per request after the gap.
pub fn next_alert(
    st: &mut AlertState,
    pending: &[JoinRequestView],
    now: OffsetDateTime,
) -> Option<(String, String)> {
    let fresh: Vec<&JoinRequestView> = pending.iter().filter(|r| !st.seen.contains(&r.id)).collect();
    st.seen = pending.iter().map(|r| r.id.clone()).collect();
    if fresh.is_empty() {
        return None;
    }
    if let Some(last) = st.last
        && now - last < ALERT_GAP
    {
        return None;
    }
    st.last = Some(now);
    let title = "Permintaan bergabung baru".to_string();
    let body = match fresh.as_slice() {
        [one] => format!(
            "{} minta bergabung ke {}. Buka Organisasi untuk mencocokkan kode lalu menyetujui atau menolak.",
            one.display_name, one.team_name
        ),
        many => format!(
            "{} orang minta bergabung. Buka Organisasi, bagian Permintaan bergabung.",
            many.len()
        ),
    };
    Some((title, body))
}

fn pending_now(state: &MiraState) -> AppResult<Vec<JoinRequestView>> {
    state.with_core(|c| {
        let Some(s) = permissions::load_state(&c.db)? else {
            return Ok(Vec::new());
        };
        permissions::pending_join_requests(&c.db, &s, c.identity.public_key_hex(), clock::now())
    })
}

/// Listens for `mira://join-requests` (emitted by the join network code) and
/// shows an OS notification for new requests. Call once in `setup`, after
/// `MiraState` is managed.
pub fn spawn_join_notifier<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<MiraState>().inner().clone();
    let seeded = pending_now(&state).unwrap_or_default();
    let alerts = Arc::new(Mutex::new(AlertState::seeded(&seeded)));
    let handle = app.clone();
    app.listen_any(EVENT_JOIN_REQUESTS, move |_| {
        let state = state.clone();
        let alerts = Arc::clone(&alerts);
        let handle = handle.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let pending = match pending_now(&state) {
                Ok(p) => p,
                Err(err) => {
                    eprintln!("Mira: permintaan bergabung belum terbaca [{}]: {err}", err.code());
                    return;
                }
            };
            let alert = match alerts.lock() {
                Ok(mut st) => next_alert(&mut st, &pending, clock::now()),
                Err(_) => return,
            };
            if let Some((title, body)) = alert {
                use tauri_plugin_notification::NotificationExt;
                if let Err(err) = handle.notification().builder().title(&title).body(&body).show() {
                    eprintln!("Mira: notifikasi permintaan bergabung gagal: {err}");
                }
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    fn req(id: &str, name: &str, team: &str) -> JoinRequestView {
        JoinRequestView {
            id: id.into(),
            public_key: "a".repeat(64),
            display_name: name.into(),
            team_id: "1".repeat(32),
            team_name: team.into(),
            laptop: "LAPTOP-UJI".into(),
            os: "Windows 11".into(),
            app_version: "0.3.0".into(),
            requested_at: "2026-11-23T01:00:00Z".into(),
            received_at: "2026-11-23T01:00:01Z".into(),
            code: "ABCD EFGH".into(),
            ip: Some("192.168.1.20".into()),
            seen_by_name: None,
        }
    }

    const T0: OffsetDateTime = datetime!(2026-11-23 08:00 UTC);

    #[test]
    fn one_new_request_names_person_and_department() {
        let mut st = AlertState::default();
        let (title, body) = next_alert(&mut st, &[req("r1", "Rina", "Desain")], T0).unwrap();
        assert_eq!(title, "Permintaan bergabung baru");
        assert!(body.starts_with("Rina minta bergabung ke Desain."), "{body}");
    }

    #[test]
    fn several_new_requests_are_one_notification() {
        let mut st = AlertState::default();
        let list = [req("r1", "Rina", "Desain"), req("r2", "Fajar", "Drafting")];
        let (_, body) = next_alert(&mut st, &list, T0).unwrap();
        assert!(body.starts_with("2 orang minta bergabung."), "{body}");
    }

    #[test]
    fn nothing_new_no_notification() {
        let mut st = AlertState::default();
        let list = [req("r1", "Rina", "Desain")];
        assert!(next_alert(&mut st, &list, T0).is_some());
        assert!(next_alert(&mut st, &list, T0 + Duration::minutes(10)).is_none());
        assert!(next_alert(&mut st, &[], T0 + Duration::minutes(20)).is_none());
    }

    #[test]
    fn at_most_one_per_five_minutes() {
        let mut st = AlertState::default();
        assert!(next_alert(&mut st, &[req("r1", "Rina", "Desain")], T0).is_some());
        let two = [req("r1", "Rina", "Desain"), req("r2", "Fajar", "Drafting")];
        assert!(next_alert(&mut st, &two, T0 + Duration::minutes(4)).is_none());
        // r2 was already counted in the skipped window; only r3 is new.
        let three = [two[0].clone(), two[1].clone(), req("r3", "Sari", "Drafting")];
        let (_, body) = next_alert(&mut st, &three, T0 + Duration::minutes(5)).unwrap();
        assert!(body.starts_with("Sari minta bergabung"), "{body}");
    }

    #[test]
    fn requests_pending_at_start_are_not_announced() {
        let list = [req("r1", "Rina", "Desain")];
        let mut st = AlertState::seeded(&list);
        assert!(next_alert(&mut st, &list, T0).is_none());
        let more = [list[0].clone(), req("r2", "Fajar", "Drafting")];
        assert!(next_alert(&mut st, &more, T0).is_some());
    }
}
