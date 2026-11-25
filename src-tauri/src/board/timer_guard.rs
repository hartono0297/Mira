//! Timer guard (docs/plans/timer-jeda.md, "Aturan jeda otomatis"): pauses
//! the viewer's running timers that nobody else may pause for them.
//!
//! The sync rules let only the owner of a time entry end it, so when a
//! colleague moves a task to Selesai or deletes it, the owner's laptop
//! pauses the owner's timer. The guard also notices that Mira was closed,
//! crashed or the laptop slept (no "last alive" mark for longer than
//! [`IDLE_GAP`]) and pauses the running timers at the last alive mark, and
//! keeps one running timer per person across projects.
//!
//! [`run_once`] is one pass; [`spawn`] runs it about 3 seconds after start
//! and then every 60 seconds. Every pause is an ordinary signed change of the
//! owner (`end` put on their own entry), the same as a pause by hand, so
//! laptops on v0.5 accept it.

use std::collections::BTreeMap;
use std::time::Duration as StdDuration;

use rusqlite::Connection;
use tauri::AppHandle;
use time::{Duration, OffsetDateTime};

use super::commands::{self, BoardRuntime, PauseOrder};
use super::doc::{TaskData, TimeData, kind};
use super::model::{ColumnId, TimerNotice, TimerPauseReason};
use super::policy::{BoardPolicy, LocalRolePolicy};
use super::sign::SignedChange;
use super::store::{self, ProjectRow, task_code};
use super::sync::BoardSyncHook;
use super::timing;
use crate::clock;
use crate::error::AppResult;
use crate::settings;
use crate::state::{Core, MiraState};

/// Local setting with the last time the guard ran (RFC 3339).
pub const LAST_ALIVE_KEY: &str = "board.timer.last_alive";

/// A longer gap between two passes means Mira was not running.
pub const IDLE_GAP: Duration = Duration::minutes(10);

/// Test hook: overrides [`IDLE_GAP`] in seconds, for the e2e tests.
pub const IDLE_GAP_ENV: &str = "MIRA_TIMER_IDLE_GAP_SECS";

const FIRST_RUN_DELAY: StdDuration = StdDuration::from_secs(3);
const RUN_INTERVAL: StdDuration = StdDuration::from_secs(60);

/// [`IDLE_GAP`], or the whole positive seconds in [`IDLE_GAP_ENV`].
pub fn idle_gap() -> Duration {
    std::env::var(IDLE_GAP_ENV)
        .ok()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|s| *s > 0)
        .map_or(IDLE_GAP, Duration::seconds)
}

/// One pass at `now` with [`idle_gap`]; returns the pauses it made. Does
/// nothing before the core and an organization exist.
pub fn run_once(
    state: &MiraState,
    hook: &dyn BoardSyncHook,
    now: OffsetDateTime,
) -> AppResult<Vec<TimerNotice>> {
    run_with_gap(state, hook, now, idle_gap())
}

/// [`run_once`] with an explicit idle gap.
pub fn run_with_gap(
    state: &MiraState,
    hook: &dyn BoardSyncHook,
    now: OffsetDateTime,
    gap: Duration,
) -> AppResult<Vec<TimerNotice>> {
    // A core that cannot open (no key yet, no data folder) is not an error
    // of the guard; the commands report it.
    if !matches!(state.with_core(|core| board_ready(&core.db)), Ok(true)) {
        return Ok(Vec::new());
    }
    let (notices, changes) = state.with_core(|core| guard(core, &LocalRolePolicy, now, gap))?;
    for (project_id, ch) in &changes {
        commands::notify(hook, project_id, ch);
    }
    Ok(notices)
}

/// Starts the loop: first pass about 3 seconds after start, then every 60
/// seconds. Pauses are queued in `runtime.notices` and announced with
/// `mira://board`.
pub fn spawn(state: MiraState, runtime: BoardRuntime, app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_RUN_DELAY).await;
        loop {
            let (s, r) = (state.clone(), runtime.clone());
            let result = tauri::async_runtime::spawn_blocking(move || {
                run_once(&s, r.hook.as_ref(), clock::now())
            })
            .await;
            match result {
                Ok(Ok(notices)) => {
                    if !notices.is_empty() {
                        runtime.notices.push(notices);
                        commands::emit(&app);
                    }
                }
                Ok(Err(e)) => eprintln!("Mira: penjaga timer gagal [{}]: {e}", e.code()),
                Err(e) => eprintln!("Mira: penjaga timer berhenti di tengah jalan: {e}"),
            }
            tokio::time::sleep(RUN_INTERVAL).await;
        }
    });
}

fn board_ready(conn: &Connection) -> AppResult<bool> {
    let has_table: bool = conn.query_row(
        "SELECT count(*) = 1 FROM sqlite_master WHERE type = 'table' AND name = 'board_projects'",
        [],
        |r| r.get(0),
    )?;
    Ok(has_table && crate::org::load_organization(conn)?.is_some())
}

/// One running segment of the viewer, in project `rows[project]`.
struct Running {
    project: usize,
    task: TaskData,
    entry: TimeData,
}

type Changes = Vec<(String, Vec<SignedChange>)>;

/// The pass itself, with the core held.
fn guard(
    core: &mut Core,
    policy: &dyn BoardPolicy,
    now: OffsetDateTime,
    gap: Duration,
) -> AppResult<(Vec<TimerNotice>, Changes)> {
    let me = core.identity.public_key_hex().to_owned();
    let now_text = clock::format_rfc3339(now);
    // A clock that went back (last alive after now) gives a negative gap:
    // nothing is paused for idleness.
    let idle_since = settings::get(&core.db, LAST_ALIVE_KEY)?
        .as_deref()
        .and_then(timing::parse_time)
        .filter(|last| now - *last > gap);

    let rows = store::projects(&core.db)?;
    let actor = store::actor_of(&core.identity);
    let mut running = Vec::new();
    for (i, row) in rows.iter().enumerate() {
        let doc = store::load_doc(&core.db, &row.id, &actor)?;
        for (task, entry) in commands::my_running(&doc, &me)? {
            // Without the edit right the change would be refused; the
            // timer stays as it is.
            if commands::may_edit(core, policy, &me, &row.id, &task.id) {
                running.push(Running {
                    project: i,
                    task,
                    entry,
                });
            }
        }
    }

    let mut orders: Vec<(usize, PauseOrder)> = Vec::new();
    let order = |r: &Running, at: &str, reason: TimerPauseReason, started_code: Option<String>| {
        (
            r.project,
            PauseOrder {
                task_id: r.task.id.clone(),
                entry_id: r.entry.id.clone(),
                at: at.to_owned(),
                reason,
                started_code,
            },
        )
    };
    let mut left: Vec<Running> = Vec::new();
    for r in running {
        let start = timing::parse_time(&r.entry.start);
        if let (Some(last), Some(start)) = (idle_since, start)
            && start < last
        {
            orders.push(order(&r, &clock::format_rfc3339(last), TimerPauseReason::Idle, None));
        } else if r.task.deleted {
            // The sync rules let the owner end their entry on a deleted
            // task (only `by` is checked), so this change is accepted.
            orders.push(order(&r, &now_text, TimerPauseReason::Deleted, None));
        } else if r.task.column == ColumnId::Done && entered_done_since(&r.task, start) {
            orders.push(order(&r, &now_text, TimerPauseReason::Done, None));
        } else {
            left.push(r);
        }
    }

    // One running timer per person: the one started last stays.
    if left.len() > 1 {
        let newest = left
            .iter()
            .enumerate()
            .max_by_key(|(_, r)| {
                (
                    timing::parse_time(&r.entry.start).unwrap_or(OffsetDateTime::UNIX_EPOCH),
                    r.entry.id.clone(),
                )
            })
            .map_or(0, |(i, _)| i);
        let keep = &left[newest];
        let code = task_code(&rows[keep.project].code, keep.task.number);
        for (i, r) in left.iter().enumerate() {
            if i != newest {
                orders.push(order(r, &now_text, TimerPauseReason::Switched, Some(code.clone())));
            }
        }
    }

    let mut by_project: BTreeMap<usize, Vec<PauseOrder>> = BTreeMap::new();
    for (i, o) in orders {
        by_project.entry(i).or_default().push(o);
    }
    let mut notices = Vec::new();
    let mut changes = Vec::new();
    let mut idle_failed = false;
    for (i, list) in by_project {
        let row: &ProjectRow = &rows[i];
        match commands::pause_in_project(core, row, &me, &list) {
            Ok((n, ch)) => {
                notices.extend(n);
                changes.push((row.id.clone(), ch));
            }
            Err(e) => {
                idle_failed |= list.iter().any(|o| o.reason == TimerPauseReason::Idle);
                eprintln!(
                    "Mira: timer di proyek {} belum bisa dijeda [{}]: {e}",
                    row.code,
                    e.code()
                );
            }
        }
    }
    // Keeping the old mark lets the next pass pause at the same time.
    if !idle_failed {
        settings::set(&core.db, LAST_ALIVE_KEY, &now_text)?;
    }
    Ok((notices, changes))
}

/// Whether the task (now in Selesai) entered Selesai at or after `start`, so
/// the timer ran when the task was finished. A timer someone starts on a
/// task that is already in Selesai is left running. Without a readable time
/// (of the move or of the start) the timer is paused.
///
/// Both times come from laptop clocks (the move from the laptop that made
/// it), so clocks that disagree can shift this comparison.
fn entered_done_since(task: &TaskData, start: Option<OffsetDateTime>) -> bool {
    let last = task
        .activity
        .iter()
        .rev()
        .find(|a| {
            (a.kind == kind::MOVED || a.kind == kind::CREATED)
                && timing::column_of(&a.detail) == Some(ColumnId::Done)
        })
        .and_then(|a| timing::parse_time(&a.at));
    match (last, start) {
        (Some(entered), Some(start)) => entered >= start,
        _ => true,
    }
}

#[cfg(test)]
mod tests;
