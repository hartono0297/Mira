//! Kopi from work (docs/plans/kopi.md, 1 and 3.5): computed from the boards
//! this laptop holds.
//!
//! - [`project_people`]: who may work in a project, from `OrgState` alone.
//! - [`tasks_from_boards`]: one [`WorkTask`] per task of every project this
//!   laptop can read now, plus the ids of those projects.
//! - [`qualify`]: the tasks that earn Kopi (before the daily limit,
//!   `rules::cap_work`).
//! - [`own_items`]: this laptop's own events, for its work snapshot.
//!
//! Board times are UTC RFC 3339 written with the clock of the laptop that
//! made the change; `done_at` and `due_set_at` are normalised to UTC with
//! whole seconds so that string order is time order.

use std::collections::{BTreeSet, HashSet};

use rusqlite::{Connection, OptionalExtension};
use time::macros::format_description;
use time::{Date, Duration, OffsetDateTime, UtcOffset};

use super::types::{
    ON_TIME_HORIZON_DAYS, QUICK_SELF_TASK_SECS, WORK_SNAPSHOT_MAX, WorkEvent, WorkItem, WorkSource,
    WorkTask, WorkWhy,
};
use crate::board::access::{ProjectRef, Rights};
use crate::board::doc::{ActivityData, TaskData, kind};
use crate::board::model::ColumnId;
use crate::board::store;
use crate::board::timing::{column_of, parse_time};
use crate::clock;
use crate::error::AppResult;
use crate::permissions::{MemberKind, MemberStatus, OrgState};

/// People who may work in `project`: the board's writers
/// (`access::Rights::writers`), that is active non-guest members who are
/// explicit members of the registered project (or, for a project with a
/// department, hold guest access to it from an earlier invite). Guests
/// never count: they may read but not be assigned. 0 for a project the log
/// does not know.
pub fn project_people(org: &OrgState, project: &str) -> usize {
    people(org, project).len()
}

/// The people of [`project_people`], sorted. `rules::fold` uses the same
/// set for snapshots, so a claim and the board agree on who may earn Kopi.
pub(crate) fn people(org: &OrgState, project: &str) -> BTreeSet<String> {
    let Some(p) = org.projects.get(project) else {
        return BTreeSet::new();
    };
    let guest_access = p.team.as_deref().map_or_else(BTreeSet::new, |team| {
        org.guest_access
            .iter()
            .filter(|g| g.project == p.id && g.team == team)
            .map(|g| g.public_key.as_str())
            .collect()
    });
    org.members
        .values()
        .filter(|m| m.status == MemberStatus::Active && m.kind != MemberKind::Guest)
        .filter(|m| {
            p.members.contains_key(&m.public_key) || guest_access.contains(m.public_key.as_str())
        })
        .map(|m| m.public_key.clone())
        .collect()
}

/// This laptop's public key, `None` before an identity exists.
fn my_key(conn: &Connection) -> AppResult<Option<String>> {
    Ok(conn
        .query_row("SELECT public_key FROM identity WHERE id = 1", [], |r| {
            r.get(0)
        })
        .optional()?)
}

/// Every task (deleted ones too) of every board project this laptop holds
/// and may read now (`Rights::can_read` for this laptop's key, so a board
/// it no longer receives is left to the recipients' snapshots), sorted by
/// `(project, task)`, plus the ids of those projects. Each document is read
/// once. A document that cannot be read is skipped and left out of the
/// set.
pub fn tasks_from_boards(
    conn: &Connection,
    org: &OrgState,
) -> AppResult<(Vec<WorkTask>, HashSet<String>)> {
    let mut tasks = Vec::new();
    let mut readable = HashSet::new();
    let Some(me) = my_key(conn)? else {
        return Ok((tasks, readable));
    };
    let rights = Rights::from_state(org);
    for row in store::projects(conn)? {
        let p = ProjectRef {
            id: &row.id,
            team_id: row.team_id.as_deref(),
            created_by: &row.created_by,
        };
        if !rights.can_read(&me, p) {
            continue;
        }
        let read = store::load_doc(conn, &row.id, &[0; 32]).and_then(|doc| doc.tasks());
        let board = match read {
            Ok(t) => t,
            Err(e) => {
                eprintln!("Mira: board {} tidak terbaca untuk Kopi: {e}", row.id);
                continue;
            }
        };
        let who = people(org, &row.id);
        tasks.extend(board.iter().map(|t| work_task(&row.id, t, &who)));
        readable.insert(row.id);
    }
    tasks.sort_by(|a, b| (&a.project_id, &a.task_id).cmp(&(&b.project_id, &b.task_id)));
    Ok((tasks, readable))
}

fn work_task(project_id: &str, t: &TaskData, people: &BTreeSet<String>) -> WorkTask {
    let assigned_by = t
        .activity
        .iter()
        .rev()
        .find(|e| e.kind == kind::ASSIGNEE)
        .map_or_else(|| t.created_by.clone(), |e| e.actor.clone());
    let (done_at, done_by) = if t.column == ColumnId::Done {
        last_done(&t.activity).unzip()
    } else {
        (None, None)
    };
    WorkTask {
        project_id: project_id.to_owned(),
        task_id: t.id.clone(),
        title: t.title.clone(),
        assignee: t.assignee.clone(),
        assigned_by,
        created_by: t.created_by.clone(),
        created_at: t.created_at.clone(),
        done_at,
        done_by,
        due: t.due.clone(),
        due_set_at: t.due.as_deref().and_then(|due| due_set_at(t, due)),
        deleted: t.deleted,
        project_people: people.len(),
        assignee_in_project: t.assignee.as_ref().is_some_and(|a| people.contains(a)),
    }
}

/// UTC RFC 3339 with whole seconds, `None` when `s` does not parse.
fn utc(s: &str) -> Option<String> {
    let t = parse_time(s)?.to_offset(UtcOffset::UTC);
    Some(clock::format_rfc3339(t.replace_nanosecond(0).unwrap_or(t)))
}

/// Time and actor of the last entry (document order) that put the task in
/// Selesai: a `moved` there, or a `created` there for a task made in
/// Selesai.
fn last_done(activity: &[ActivityData]) -> Option<(String, String)> {
    activity
        .iter()
        .rev()
        .filter(|e| e.kind == kind::MOVED || e.kind == kind::CREATED)
        .filter(|e| column_of(&e.detail) == Some(ColumnId::Done))
        .find_map(|e| Some((utc(&e.at)?, e.actor.clone())))
}

/// When the current due date was set: the latest `due` entry naming it,
/// else the latest `due` entry, else `created_at` (set at creation).
fn due_set_at(t: &TaskData, due: &str) -> Option<String> {
    let entries = || t.activity.iter().rev().filter(|e| e.kind == kind::DUE);
    let at = entries()
        .find(|e| e.detail == due)
        .or_else(|| entries().next())
        .map_or(t.created_at.as_str(), |e| e.at.as_str());
    utc(at)
}

fn due_date(due: &str) -> Option<Date> {
    Date::parse(due, format_description!("[year]-[month]-[day]")).ok()
}

fn time_of(s: Option<&str>) -> Option<OffsetDateTime> {
    s.and_then(parse_time)
}

/// Why `t` earns Kopi, `None` when it does not (docs/plans/kopi.md, 1).
/// Only the assignee's own move into Selesai earns: a task someone else
/// pushed to Selesai earns nothing for anyone.
fn why(t: &WorkTask) -> Option<(&str, OffsetDateTime, WorkWhy)> {
    if t.deleted || t.project_people < 2 || !t.assignee_in_project {
        return None;
    }
    let assignee = t.assignee.as_deref()?;
    if t.done_by.as_deref() != Some(assignee) {
        return None;
    }
    let done = time_of(t.done_at.as_deref())?;
    if t.created_by == assignee {
        let created = parse_time(&t.created_at)?;
        if (done - created).whole_seconds() < QUICK_SELF_TASK_SECS {
            return None;
        }
    }
    if t.assigned_by != assignee {
        return Some((assignee, done, WorkWhy::Assigned));
    }
    on_time(t, done).then_some((assignee, done, WorkWhy::OnTime))
}

/// Finished on time, with a due date that means something:
/// - the due date is at most [`ON_TIME_HORIZON_DAYS`] after the UTC day it
///   was set (no far-away due date for a free Kopi);
/// - the task was finished at least [`QUICK_SELF_TASK_SECS`] after the due
///   date was set (setting a due date right before finishing earns
///   nothing);
/// - `done_at` is before 12:00 UTC on the day after the due date, the end
///   of the due day at UTC-12 (the westernmost zone). Board times carry no
///   local offset, so this bound never counts anyone late who finished on
///   their own due day, wherever they are; further east it allows up to a
///   day of slack.
fn on_time(t: &WorkTask, done: OffsetDateTime) -> bool {
    let (Some(due), Some(set)) = (
        t.due.as_deref().and_then(due_date),
        time_of(t.due_set_at.as_deref()),
    ) else {
        return false;
    };
    let set_day = set.to_offset(UtcOffset::UTC).date();
    let Some(horizon) = set_day.checked_add(Duration::days(ON_TIME_HORIZON_DAYS)) else {
        return false;
    };
    if due > horizon || (done - set).whole_seconds() < QUICK_SELF_TASK_SECS {
        return false;
    }
    due.next_day()
        .and_then(|d| d.with_hms(12, 0, 0).ok())
        .is_some_and(|deadline| done < deadline.assume_utc())
}

/// The tasks that earn Kopi, one event each, in the order of `tasks`. The
/// daily limit is not applied here (`rules::cap_work`).
pub fn qualify(tasks: &[WorkTask]) -> Vec<WorkEvent> {
    tasks
        .iter()
        .filter_map(|t| {
            let (recipient, done, why) = why(t)?;
            Some(WorkEvent {
                project_id: t.project_id.clone(),
                task_id: t.task_id.clone(),
                title: Some(t.title.clone()),
                recipient: recipient.to_owned(),
                done_at: clock::format_rfc3339(done.to_offset(UtcOffset::UTC)),
                why,
                source: WorkSource::Board,
            })
        })
        .collect()
}

/// `me`'s events computed from boards, at most one per task: the newest
/// [`WORK_SNAPSHOT_MAX`] by `(done_at, project, task)`, oldest first.
pub fn own_items(events: &[WorkEvent], me: &str) -> Vec<WorkItem> {
    let mut mine: Vec<&WorkEvent> = events
        .iter()
        .filter(|e| e.source == WorkSource::Board && e.recipient == me)
        .collect();
    mine.sort_by(|a, b| {
        (&b.done_at, &b.project_id, &b.task_id).cmp(&(&a.done_at, &a.project_id, &a.task_id))
    });
    let mut seen = HashSet::new();
    mine.retain(|e| seen.insert((e.project_id.as_str(), e.task_id.as_str())));
    mine.truncate(WORK_SNAPSHOT_MAX);
    mine.reverse();
    mine.into_iter()
        .map(|e| WorkItem {
            p: e.project_id.clone(),
            t: e.task_id.clone(),
            done: e.done_at.clone(),
            why: e.why,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "aa";
    const B: &str = "bb";

    fn t0() -> OffsetDateTime {
        parse_time("2026-11-23T08:00:00Z").unwrap()
    }

    fn at(secs: i64) -> String {
        clock::format_rfc3339(t0() + Duration::seconds(secs))
    }

    /// A created the task at t0 for B, B finished it two hours later.
    fn task() -> WorkTask {
        WorkTask {
            project_id: "p1".into(),
            task_id: "t1".into(),
            title: "Foto tim".into(),
            assignee: Some(B.into()),
            assigned_by: A.into(),
            created_by: A.into(),
            created_at: at(0),
            done_at: Some(at(7_200)),
            done_by: Some(B.into()),
            due: None,
            due_set_at: None,
            deleted: false,
            project_people: 2,
            assignee_in_project: true,
        }
    }

    /// B made the task for themself with due date `due` set at creation.
    fn own_task(due: &str, done_secs: i64) -> WorkTask {
        WorkTask {
            assigned_by: B.into(),
            created_by: B.into(),
            due: Some(due.into()),
            due_set_at: Some(at(0)),
            done_at: Some(at(done_secs)),
            ..task()
        }
    }

    fn whys(t: WorkTask) -> Vec<WorkWhy> {
        qualify(&[t]).into_iter().map(|e| e.why).collect()
    }

    #[test]
    fn assigned_by_someone_else() {
        let events = qualify(&[task()]);
        assert_eq!(
            events,
            [WorkEvent {
                project_id: "p1".into(),
                task_id: "t1".into(),
                title: Some("Foto tim".into()),
                recipient: B.into(),
                done_at: at(7_200),
                why: WorkWhy::Assigned,
                source: WorkSource::Board,
            }]
        );
        // Assigned wins over on time: still one event per task.
        let t = WorkTask {
            due: Some("2026-11-30".into()),
            due_set_at: Some(at(0)),
            ..task()
        };
        assert_eq!(whys(t), [WorkWhy::Assigned]);
        // Self-assigned without a due date: nothing.
        let t = WorkTask {
            assigned_by: B.into(),
            ..task()
        };
        assert!(qualify(&[t]).is_empty());
    }

    #[test]
    fn on_time_up_to_the_due_day() {
        assert_eq!(whys(own_task("2026-11-23", 7_200)), [WorkWhy::OnTime], "same day");
        assert_eq!(whys(own_task("2026-12-01", 7_200)), [WorkWhy::OnTime], "early");
        // The UTC date of done_at counts: 05:00 +07:00 is still the 23rd UTC.
        let t = WorkTask {
            done_at: Some("2026-11-24T05:00:00+07:00".into()),
            ..own_task("2026-11-23", 0)
        };
        let events = qualify(&[t]);
        assert_eq!(events[0].why, WorkWhy::OnTime);
        assert_eq!(events[0].done_at, "2026-11-23T22:00:00Z", "normalised to UTC");
    }

    #[test]
    fn late_earns_nothing() {
        // Due the 21st, finished the 23rd 10:00 UTC.
        assert!(whys(own_task("2026-11-21", 7_200)).is_empty());
        // Finished at 16:00 UTC on the 24th, due the 23rd.
        assert!(whys(own_task("2026-11-23", 32 * 3_600)).is_empty());
    }

    #[test]
    fn on_time_ends_at_noon_utc_the_next_day() {
        let done = |s: &str| WorkTask {
            done_at: Some(s.into()),
            ..own_task("2026-11-23", 0)
        };
        // The end of the 23rd at UTC-12.
        assert_eq!(whys(done("2026-11-24T11:59:59Z")), [WorkWhy::OnTime]);
        assert!(whys(done("2026-11-24T12:00:00Z")).is_empty());
        // Due the 22nd, finished the 23rd 10:00 UTC: still the 22nd at
        // UTC-12, so on time.
        assert_eq!(whys(own_task("2026-11-22", 7_200)), [WorkWhy::OnTime]);
    }

    #[test]
    fn far_due_date_earns_nothing() {
        // Set on the 23rd (UTC): up to the 7th of December.
        assert_eq!(whys(own_task("2026-12-07", 7_200)), [WorkWhy::OnTime]);
        assert!(whys(own_task("2026-12-08", 7_200)).is_empty());
        assert!(whys(own_task("2099-12-31", 7_200)).is_empty());
    }

    #[test]
    fn only_the_assignee_finishing_earns() {
        for by in [Some(A), None] {
            let t = WorkTask {
                done_by: by.map(str::to_owned),
                ..task()
            };
            assert!(whys(t).is_empty(), "assigned, done by {by:?}");
            let t = WorkTask {
                done_by: by.map(str::to_owned),
                ..own_task("2026-11-30", 7_200)
            };
            assert!(whys(t).is_empty(), "on time, done by {by:?}");
        }
    }

    #[test]
    fn due_set_after_or_just_before_finishing_earns_nothing() {
        let t = WorkTask {
            due_set_at: Some(at(7_260)),
            ..own_task("2026-11-30", 7_200)
        };
        assert!(whys(t).is_empty());
        let t = WorkTask {
            due_set_at: Some(at(7_200 - QUICK_SELF_TASK_SECS + 1)),
            ..own_task("2026-11-30", 7_200)
        };
        assert!(whys(t).is_empty(), "set less than an hour before finishing");
        let t = WorkTask {
            due_set_at: Some(at(7_200 - QUICK_SELF_TASK_SECS)),
            ..own_task("2026-11-30", 7_200)
        };
        assert_eq!(whys(t), [WorkWhy::OnTime], "set an hour before counts");
        let t = WorkTask {
            due_set_at: None,
            ..own_task("2026-11-30", 7_200)
        };
        assert!(whys(t).is_empty());
    }

    #[test]
    fn quick_own_task_earns_nothing() {
        assert!(whys(own_task("2026-11-30", QUICK_SELF_TASK_SECS - 1)).is_empty());
        assert_eq!(
            whys(own_task("2026-11-30", QUICK_SELF_TASK_SECS)),
            [WorkWhy::OnTime]
        );
        // Made by B, assigned to B by A afterwards: still B's own task.
        let t = WorkTask {
            created_by: B.into(),
            done_at: Some(at(600)),
            ..task()
        };
        assert!(whys(t).is_empty());
        let t = WorkTask {
            created_by: B.into(),
            ..task()
        };
        assert_eq!(whys(t), [WorkWhy::Assigned]);
        // A quick task made by someone else is fine.
        let t = WorkTask {
            done_at: Some(at(60)),
            ..task()
        };
        assert_eq!(whys(t), [WorkWhy::Assigned]);
    }

    #[test]
    fn project_and_assignee_conditions() {
        let one_person = WorkTask {
            project_people: 1,
            ..task()
        };
        let outsider = WorkTask {
            assignee_in_project: false,
            ..task()
        };
        let reopened = WorkTask {
            done_at: None,
            ..task()
        };
        let deleted = WorkTask {
            deleted: true,
            ..task()
        };
        let nobody = WorkTask {
            assignee: None,
            ..task()
        };
        let broken = WorkTask {
            done_at: Some("kemarin".into()),
            ..task()
        };
        let broken_created = WorkTask {
            created_at: "kemarin".into(),
            ..own_task("2026-11-30", 7_200)
        };
        let broken_due = own_task("30-11-2026", 7_200);
        for t in [
            one_person,
            outsider,
            reopened,
            deleted,
            nobody,
            broken,
            broken_created,
            broken_due,
        ] {
            assert!(qualify(std::slice::from_ref(&t)).is_empty(), "{t:?}");
        }
    }

    fn event(recipient: &str, task: &str, done: i64, source: WorkSource) -> WorkEvent {
        WorkEvent {
            project_id: "p1".into(),
            task_id: task.into(),
            title: None,
            recipient: recipient.into(),
            done_at: at(done),
            why: WorkWhy::Assigned,
            source,
        }
    }

    #[test]
    fn own_items_newest_board_events_of_me() {
        let events = [
            event(B, "t2", 20, WorkSource::Board),
            event(A, "t3", 30, WorkSource::Board),
            event(B, "t4", 40, WorkSource::Claim),
            event(B, "t1", 10, WorkSource::Board),
            event(B, "t1", 10, WorkSource::Board),
        ];
        let items = own_items(&events, B);
        let ids: Vec<&str> = items.iter().map(|i| i.t.as_str()).collect();
        assert_eq!(ids, ["t1", "t2"]);
        assert_eq!(items[0].done, at(10));
        assert_eq!(items[0].p, "p1");
        assert_eq!(items[0].why, WorkWhy::Assigned);

        let many: Vec<WorkEvent> = (0..WORK_SNAPSHOT_MAX as i64 + 5)
            .rev()
            .map(|i| event(B, &format!("t{i:05}"), i, WorkSource::Board))
            .collect();
        let items = own_items(&many, B);
        assert_eq!(items.len(), WORK_SNAPSHOT_MAX);
        assert_eq!(items[0].t, "t00005", "the oldest are dropped");
        assert_eq!(items.last().unwrap().done, at(WORK_SNAPSHOT_MAX as i64 + 4));
    }

    fn entry(kind: &str, actor: &str, secs: i64, detail: &str) -> ActivityData {
        ActivityData {
            at: at(secs),
            actor: actor.into(),
            kind: kind.into(),
            detail: detail.into(),
        }
    }

    fn data(column: ColumnId, due: Option<&str>, activity: Vec<ActivityData>) -> TaskData {
        TaskData {
            id: "t1".into(),
            number: 1,
            title: "Foto tim".into(),
            description: String::new(),
            column,
            rank: "m".into(),
            assignee: Some(B.into()),
            due: due.map(str::to_owned),
            priority: Default::default(),
            labels: Vec::new(),
            created_by: A.into(),
            created_at: at(0),
            updated_at: at(0),
            deleted: false,
            comments: Vec::new(),
            activity,
            subtasks: Vec::new(),
            time: Vec::new(),
        }
    }

    #[test]
    fn history_gives_assigner_done_and_due_times() {
        let people: BTreeSet<String> = [A, B].map(str::to_owned).into();
        let history = vec![
            entry(kind::CREATED, A, 0, "To do"),
            entry(kind::ASSIGNEE, B, 10, "Budi"),
            entry(kind::DUE, A, 20, "2026-11-25"),
            entry(kind::ASSIGNEE, A, 30, "Budi"),
            entry(kind::MOVED, B, 40, "Selesai"),
            entry(kind::DUE, A, 50, "2026-11-30"),
            entry(kind::MOVED, B, 60, "Dikerjakan"),
            entry(kind::MOVED, B, 70, "done"),
            entry(kind::DUE, B, 80, "2026-11-25"),
        ];
        let t = work_task("p1", &data(ColumnId::Done, Some("2026-11-25"), history.clone()), &people);
        assert_eq!(t.assigned_by, A, "latest assignee entry");
        assert_eq!(t.done_at.as_deref(), Some(at(70).as_str()), "last move into Selesai");
        assert_eq!(t.done_by.as_deref(), Some(B), "who moved it there");
        assert_eq!(t.due_set_at.as_deref(), Some(at(80).as_str()), "latest entry naming it");
        assert_eq!(t.project_people, 2);
        assert!(t.assignee_in_project);

        // A due date that no entry names: the latest due entry.
        let t = work_task("p1", &data(ColumnId::Done, Some("2026-12-24"), history.clone()), &people);
        assert_eq!(t.due_set_at.as_deref(), Some(at(80).as_str()));

        // Reopened: no done_at even though the history has moves to Selesai.
        let t = work_task("p1", &data(ColumnId::Doing, None, history), &people);
        assert_eq!(t.done_at, None);
        assert_eq!(t.done_by, None);
        assert_eq!(t.due_set_at, None);

        // Made in Selesai with its due date and assignee, B not in the project.
        let only_a: BTreeSet<String> = [A.to_owned()].into();
        let t = work_task(
            "p1",
            &data(ColumnId::Done, Some("2026-11-25"), vec![entry(kind::CREATED, A, 0, "Selesai")]),
            &only_a,
        );
        assert_eq!(t.assigned_by, A, "the creator");
        assert_eq!(t.done_at.as_deref(), Some(at(0).as_str()));
        assert_eq!(t.done_by.as_deref(), Some(A));
        assert_eq!(t.due_set_at.as_deref(), Some(at(0).as_str()), "created_at");
        assert_eq!(t.project_people, 1);
        assert!(!t.assignee_in_project);

        // In Selesai without a readable entry saying so: not finished.
        let t = work_task(
            "p1",
            &data(ColumnId::Done, None, vec![entry(kind::CREATED, A, 0, "To do")]),
            &people,
        );
        assert_eq!(t.done_at, None);
    }

    mod boards {
        use std::sync::Arc;

        use tempfile::TempDir;

        use super::super::*;
        use crate::board::commands;
        use crate::board::feature::BoardFeature;
        use crate::board::model::NewTask;
        use crate::board::sync::NoopSync;
        use crate::board::testutil::org_ops;
        use crate::identity::{self, MemoryKeyStore};
        use crate::network::feature::FeatureSync;
        use crate::network::feature::testing::sync_all;
        use crate::org;
        use crate::permissions::{self as p, InviteRole};
        use crate::state::{Core, MiraState};

        struct Lap {
            _tmp: TempDir,
            state: MiraState,
            f: BoardFeature,
            pk: String,
        }

        impl Lap {
            fn new(name: &str) -> Lap {
                let tmp = tempfile::tempdir().unwrap();
                let state =
                    MiraState::new(Ok(tmp.path().to_path_buf()), Box::new(MemoryKeyStore::new()));
                let pk = state
                    .with_core(|c| {
                        identity::save_display_name(&mut c.db, &mut c.identity, name)?;
                        Ok(c.identity.public_key_hex().to_owned())
                    })
                    .unwrap();
                let f = BoardFeature::new(state.clone(), Arc::new(NoopSync));
                Lap {
                    _tmp: tmp,
                    state,
                    f,
                    pk,
                }
            }

            fn core<T>(&self, f: impl FnOnce(&mut Core) -> AppResult<T>) -> T {
                self.state.with_core(f).unwrap()
            }

            fn me(&self) -> (&str, &dyn FeatureSync) {
                (&self.pk, &self.f)
            }

            fn org(&self) -> OrgState {
                self.core(|c| p::load_state(&c.db)).unwrap()
            }

            /// Kopi from work as this laptop computes it.
            fn work(&self) -> (Vec<WorkEvent>, HashSet<String>) {
                let org = self.org();
                let (tasks, readable) = self.core(|c| tasks_from_boards(&c.db, &org));
                (qualify(&tasks), readable)
            }
        }

        fn both<T>(a: &Lap, b: &Lap, f: impl FnOnce(&mut Core, &mut Core) -> T) -> T {
            a.state
                .with_core(|ca| b.state.with_core(|cb| Ok(f(ca, cb))))
                .unwrap()
        }

        fn sync_ops(a: &Lap, b: &Lap) {
            for _ in 0..10 {
                let n = both(a, b, |ca, cb| org_ops::sync(&ca.db, &mut cb.db, &b.pk, &a.pk))
                    + both(b, a, |cb, ca| org_ops::sync(&cb.db, &mut ca.db, &a.pk, &b.pk));
                if n == 0 {
                    return;
                }
            }
            panic!("membership ops did not settle");
        }

        fn sync_boards(a: &Lap, b: &Lap) {
            sync_all(&[a.me(), b.me()]).unwrap();
        }

        #[test]
        fn assigned_task_finished_reopened_and_deleted() {
            let sari = Lap::new("Sari");
            sari.core(|c| {
                org::create_organization(&mut c.db, &c.identity, "CV Maju Jaya").map(|_| ())
            });
            let budi = Lap::new("Budi");
            let team = sari.core(|c| Ok(org_ops::create_team(&mut c.db, &c.identity, "Desain")));
            both(&sari, &budi, |s, b| {
                org_ops::join(
                    (&mut s.db, &s.identity),
                    (&mut b.db, &b.identity),
                    &team,
                    InviteRole::Member,
                    vec![],
                )
            });
            sync_ops(&sari, &budi);

            let pid = commands::create_project_with_members(
                &sari.state,
                &NoopSync,
                "Situs Web",
                "WEB",
                None,
                std::slice::from_ref(&budi.pk),
            )
            .unwrap()
            .id;
            sync_ops(&sari, &budi);
            let org = sari.org();
            assert_eq!(project_people(&org, &pid), 2);
            let pr = &org.projects[&pid];
            let writers = Rights::from_state(&org).writers(ProjectRef {
                id: &pid,
                team_id: pr.team.as_deref(),
                created_by: &pr.creator,
            });
            assert_eq!(writers.len(), 2, "same as the board's writers");
            assert_eq!(project_people(&org, &"0".repeat(32)), 0);

            let input = NewTask {
                title: "Halaman depan".into(),
                assignee: Some(budi.pk.clone()),
                ..NewTask::default()
            };
            let tid = commands::create_task(&sari.state, &NoopSync, &pid, input)
                .unwrap()
                .card
                .id;
            sync_boards(&sari, &budi);
            let (events, readable) = budi.work();
            assert!(events.is_empty(), "not finished yet");
            assert_eq!(readable, HashSet::from([pid.clone()]));

            commands::move_task(&budi.state, &NoopSync, &pid, &tid, ColumnId::Done, 0).unwrap();
            let (events, _) = budi.work();
            assert_eq!(events.len(), 1);
            let e = &events[0];
            assert_eq!(
                (e.recipient.as_str(), e.why, e.source, e.task_id.as_str()),
                (budi.pk.as_str(), WorkWhy::Assigned, WorkSource::Board, tid.as_str())
            );
            assert_eq!(e.title.as_deref(), Some("Halaman depan"));
            let items = own_items(&events, &budi.pk);
            assert_eq!(items.len(), 1);
            assert!(own_items(&events, &sari.pk).is_empty());

            commands::move_task(&budi.state, &NoopSync, &pid, &tid, ColumnId::Doing, 0).unwrap();
            assert!(budi.work().0.is_empty(), "reopened");

            commands::move_task(&budi.state, &NoopSync, &pid, &tid, ColumnId::Done, 0).unwrap();
            sync_boards(&sari, &budi);
            assert_eq!(sari.work().0.len(), 1, "the assigner's laptop agrees");

            commands::delete_task(&sari.state, &NoopSync, &pid, &tid).unwrap();
            assert!(sari.work().0.is_empty(), "deleted");
            sync_boards(&sari, &budi);
            assert!(budi.work().0.is_empty());
        }
    }
}
