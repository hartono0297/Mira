//! Publishes this laptop's work snapshot (docs/plans/kopi.md, 3.7).
//!
//! At start and every [`INTERVAL`], the Kopi from work this laptop's person
//! earned on the boards held here (`work::own_items`) is hashed. When the
//! hash differs from the one last published, a new signed `Work` record
//! replaces the old one, the hub offers it to colleagues and the UI gets
//! `mira://feature {topic: "kopi"}`. Laptops that cannot read a project use
//! the snapshot; the others count from their own board.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use time::OffsetDateTime;

use super::store;
use super::types::{FUTURE_SKEW_SECS, Payload, WorkItem};
use super::work;
use crate::clock;
use crate::error::AppResult;
use crate::network::feature::{FeatureHub, TOPIC_KOPI};
use crate::permissions;
use crate::state::{Core, MiraState};

/// How often the snapshot is recomputed.
pub const INTERVAL: Duration = Duration::from_secs(60);

/// Same event name and payload as the transport sends after `ingest`.
pub const FEATURE_EVENT: &str = "mira://feature";

#[derive(Clone, Serialize)]
struct FeatureChanged<'a> {
    topic: &'a str,
}

/// Starts the background task. Needs `MiraState` and `Arc<FeatureHub>`
/// managed first.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let (Some(hub), Some(state)) = (
        app.try_state::<Arc<FeatureHub>>(),
        app.try_state::<MiraState>(),
    ) else {
        eprintln!("Mira: Kopi dari kerja tidak diterbitkan (state belum dikelola).");
        return;
    };
    let (hub, state, app) = (hub.inner().clone(), state.inner().clone(), app.clone());
    tauri::async_runtime::spawn(async move {
        let mut last: Option<String> = None;
        loop {
            let s = state.clone();
            let mut key = last.clone();
            let published = tauri::async_runtime::spawn_blocking(move || {
                let r = s.with_core(|c| publish_work(c, &mut key));
                (r, key)
            })
            .await;
            match published {
                Ok((Ok(true), key)) => {
                    last = key;
                    changed(&app, &hub);
                }
                Ok((Ok(false), key)) => last = key,
                Err(_) => {}
                Ok((Err(err), _)) => {
                    eprintln!("Mira: Kopi dari kerja belum terbit [{}]: {err}", err.code());
                }
            }
            tokio::time::sleep(INTERVAL).await;
        }
    });
}

/// A local Kopi change: offer it to colleagues and refresh the screens.
pub fn changed<R: Runtime>(app: &AppHandle<R>, hub: &FeatureHub) {
    hub.notify_changed(TOPIC_KOPI);
    let _ = app.emit(FEATURE_EVENT, FeatureChanged { topic: TOPIC_KOPI });
}

/// What the own work items are computed from: the boards and the
/// membership log (rights, project people, being active).
fn inputs_key(core: &Core) -> AppResult<String> {
    Ok(format!(
        "{}|{}",
        store::board_marker(&core.db)?,
        store::org_marker(&core.db)?
    ))
}

/// Computes this laptop's own Kopi from work and publishes it when it
/// changed. Returns `true` when a new snapshot was stored. `last` is the
/// [`inputs_key`] of the previous run: while the boards and the membership
/// log are unchanged nothing is read or recomputed. It is updated after a
/// run that finished.
pub fn publish_work(core: &mut Core, last: &mut Option<String>) -> AppResult<bool> {
    let key = inputs_key(core)?;
    if last.as_deref() == Some(key.as_str()) {
        return Ok(false);
    }
    let published = compute_and_publish(core)?;
    *last = Some(key);
    Ok(published)
}

fn compute_and_publish(core: &mut Core) -> AppResult<bool> {
    let Some(org) = permissions::load_state(&core.db)? else {
        return Ok(false);
    };
    let me = core.identity.public_key_hex().to_owned();
    if !org.is_active(&me) {
        return Ok(false);
    }
    let (tasks, _readable) = work::tasks_from_boards(&core.db, &org)?;
    let events = work::qualify(&tasks);
    let items = work::own_items(&events, &me);
    publish_items(core, items, clock::now())
}

/// Hash of the items as published (order matters: `own_items` is
/// deterministic).
fn items_hash(items: &[WorkItem]) -> String {
    let json = serde_json::to_string(items).unwrap_or_default();
    blake3::hash(json.as_bytes()).to_hex().to_string()
}

/// Stores a new `Work` snapshot of `items` unless the same items were
/// published last. Nothing is published while there was never anything to
/// publish. The snapshot's `at` is after the stored one when the clock went
/// back a little, so it always replaces it. A stored snapshot more than
/// `FUTURE_SKEW_SECS` ahead (written while the clock was ahead) is retired
/// to `kopi_seen` instead and the new one gets `now`: one second after it
/// would be refused by every other laptop until then.
pub fn publish_items(core: &mut Core, items: Vec<WorkItem>, now: OffsetDateTime) -> AppResult<bool> {
    let me = core.identity.public_key_hex().to_owned();
    let hash = items_hash(&items);
    let last = store::published_hash(&core.db, &me)?;
    if last.as_deref() == Some(hash.as_str()) || (last.is_none() && items.is_empty()) {
        return Ok(false);
    }
    let limit = now + time::Duration::seconds(FUTURE_SKEW_SECS);
    for (id, at) in store::work_records(&core.db, &me)? {
        if super::record::parse_at(&at).is_some_and(|t| t > limit) {
            store::retire(&core.db, &id)?;
        }
    }
    let mut at = now;
    if let Some(prev) = store::latest_work_at(&core.db, &me)?.and_then(|a| super::record::parse_at(&a))
        && prev >= at
    {
        at = prev + time::Duration::seconds(1);
    }
    let payload = Payload::Work {
        at: clock::format_rfc3339(at),
        items,
    };
    store::seal_and_store(core, &payload)?;
    store::set_published_hash(&core.db, &me, &hash)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::documents::test_lab::Lab;
    use crate::kopi::types::WorkWhy;

    fn item(t: u8) -> WorkItem {
        WorkItem {
            p: "ab".repeat(16),
            t: format!("{t:02x}").repeat(16),
            done: "2026-11-24T01:00:00Z".into(),
            why: WorkWhy::OnTime,
        }
    }

    fn snapshot(core: &Core) -> Vec<(String, Payload)> {
        store::load_all(&core.db)
            .unwrap()
            .into_iter()
            .map(|r| (r.id, r.payload))
            .collect()
    }

    #[test]
    fn publishes_only_when_items_change() {
        let lab = Lab::new(&["Sari"]);
        let now = clock::now();
        lab.laptops[0].with(|c| {
            assert!(!publish_items(c, vec![], now).unwrap(), "nothing yet");
            assert!(snapshot(c).is_empty());

            assert!(publish_items(c, vec![item(1)], now).unwrap());
            let first = snapshot(c);
            assert_eq!(first.len(), 1);
            assert!(!publish_items(c, vec![item(1)], now).unwrap(), "same items");

            // Changed items, with the clock gone back: still replaces.
            let earlier = now - time::Duration::seconds(300);
            assert!(publish_items(c, vec![item(1), item(2)], earlier).unwrap());
            let second = snapshot(c);
            assert_eq!(second.len(), 1);
            assert_ne!(second[0].0, first[0].0);
            assert!(store::known(&c.db, &first[0].0).unwrap());
            match &second[0].1 {
                Payload::Work { items, at } => {
                    assert_eq!(items.len(), 2);
                    assert!(super::super::record::parse_at(at).unwrap() > now);
                }
                other => panic!("{other:?}"),
            }

            // Everything taken back (task reopened): an empty snapshot.
            assert!(publish_items(c, vec![], now).unwrap());
            match &snapshot(c)[0].1 {
                Payload::Work { items, .. } => assert!(items.is_empty()),
                other => panic!("{other:?}"),
            }
        });
    }

    #[test]
    fn publish_work_without_boards_publishes_nothing() {
        let lab = Lab::new(&["Sari", "Budi"]);
        lab.laptops[1].with(|c| {
            assert!(!publish_work(c, &mut None).unwrap());
            assert!(snapshot(c).is_empty());
        });
    }

    #[test]
    fn publish_work_recomputes_only_when_boards_or_membership_change() {
        let lab = Lab::new(&["Sari", "Budi"]);
        let mut last = None;
        let me = lab.pk(0);
        lab.laptops[0].with(|c| {
            assert!(!publish_work(c, &mut last).unwrap());
            assert!(last.is_some());
            // A recompute would now publish an empty snapshot (the stored
            // hash differs), so publishing shows whether it recomputed.
            store::set_published_hash(&c.db, &me, "lama").unwrap();
            assert!(!publish_work(c, &mut last).unwrap(), "same inputs: skipped");
            assert!(snapshot(c).is_empty());
        });
        // A board project arrives: the key changes, the items are computed.
        lab.add_project(&"ab".repeat(16), None);
        lab.laptops[0].with(|c| {
            assert!(publish_work(c, &mut last).unwrap());
            assert_eq!(snapshot(c).len(), 1);
            assert!(!publish_work(c, &mut last).unwrap());
        });
    }

    #[test]
    fn snapshot_from_a_clock_that_ran_ahead_is_retired() {
        let lab = Lab::new(&["Sari"]);
        let now = clock::now();
        lab.laptops[0].with(|c| {
            let ahead = now + time::Duration::days(2);
            assert!(publish_items(c, vec![item(1)], ahead).unwrap());
            let first = snapshot(c);

            assert!(publish_items(c, vec![item(1), item(2)], now).unwrap());
            let second = snapshot(c);
            assert_eq!(second.len(), 1);
            assert_ne!(second[0].0, first[0].0);
            assert!(store::known(&c.db, &first[0].0).unwrap(), "moved to kopi_seen");
            match &second[0].1 {
                Payload::Work { at, .. } => assert_eq!(*at, clock::format_rfc3339(now)),
                other => panic!("{other:?}"),
            }
        });
    }
}
