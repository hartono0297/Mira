//! Time tracking of a task (docs/plans/v04-board.md, "Pelacakan waktu"):
//! time per column from the move history, and totals of the time entries.
//! Pure functions over what `doc.rs` reads, so the view and the tests share
//! them.
//!
//! Every time in the history was written with the clock of the laptop that
//! made the change, so times from different laptops may disagree. Times that
//! do not parse are skipped, negative intervals count as 0, and
//! [`StatusTime::clock_warning`] tells the viewer when the history looks
//! off (a time in the future, or an order that disagrees with the times).

use std::collections::BTreeMap;

use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

use super::doc::{ActivityData, TimeData, kind};
use super::model::{ColumnId, ColumnSecs, StatusTime};

/// How far in the future a time may be before it counts as a clock problem.
pub const CLOCK_SLACK: Duration = Duration::minutes(5);

pub fn parse_time(s: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(s, &Rfc3339).ok()
}

/// Whole seconds from `a` to `b`, at least 0.
fn secs_between(a: OffsetDateTime, b: OffsetDateTime) -> i64 {
    (b - a).whole_seconds().max(0)
}

/// Length of a time entry: `end - start` in seconds, at least 0; 0 while
/// it runs or when a time does not parse.
pub fn entry_secs(start: &str, end: Option<&str>) -> i64 {
    match (parse_time(start), end.and_then(parse_time)) {
        (Some(s), Some(e)) => secs_between(s, e),
        _ => 0,
    }
}

/// Seconds of the stopped entries that are not deleted.
pub fn tracked_secs(entries: &[TimeData]) -> i64 {
    entries
        .iter()
        .filter(|e| !e.deleted && e.end.is_some())
        .map(|e| entry_secs(&e.start, e.end.as_deref()))
        .fold(0, i64::saturating_add)
}

/// Start of every running timer, sorted.
pub fn running_since(entries: &[TimeData]) -> Vec<String> {
    let mut out: Vec<String> = entries
        .iter()
        .filter(|e| e.is_running())
        .map(|e| e.start.clone())
        .collect();
    out.sort();
    out
}

/// Time of one person on a task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersonTime {
    /// Public key (64 hex).
    pub by: String,
    /// Seconds of stopped entries.
    pub secs: i64,
    /// Start of the running timer (the earliest, should there be several).
    pub running_since: Option<String>,
}

/// Totals per person over the entries that are not deleted, by public key.
pub fn totals_by_person(entries: &[TimeData]) -> Vec<PersonTime> {
    let mut by: BTreeMap<&str, PersonTime> = BTreeMap::new();
    for e in entries.iter().filter(|e| !e.deleted) {
        let t = by.entry(e.by.as_str()).or_insert_with(|| PersonTime {
            by: e.by.clone(),
            secs: 0,
            running_since: None,
        });
        match &e.end {
            Some(end) => t.secs = t.secs.saturating_add(entry_secs(&e.start, Some(end))),
            None => {
                if t.running_since.as_ref().is_none_or(|s| e.start < *s) {
                    t.running_since = Some(e.start.clone());
                }
            }
        }
    }
    by.into_values().collect()
}

/// Column named in a `created` or `moved` entry: its shown name ("To do",
/// "Dikerjakan", "Selesai") or its id.
pub fn column_of(detail: &str) -> Option<ColumnId> {
    ColumnId::parse(detail).or_else(|| ColumnId::ALL.into_iter().find(|c| c.name() == detail))
}

/// One `created` or `moved` entry that could be read.
struct Step<'a> {
    at: OffsetDateTime,
    at_text: &'a str,
    column: ColumnId,
    created: bool,
}

/// Time per column of a task from its history (`activity`, document
/// order), its `created_at` and its current column, as seen at `now`.
///
/// Steps are ordered by their time. Each interval counts for the column of
/// the step that starts it; the last one, still open, belongs to `current`
/// (the column the task really is in, which may differ from the last step
/// after concurrent moves). Cycle time runs from creation to the last move
/// into Selesai, only when the task is in Selesai now.
pub fn status_time(
    created_at: &str,
    activity: &[ActivityData],
    current: ColumnId,
    now: OffsetDateTime,
) -> StatusTime {
    let mut steps: Vec<Step<'_>> = activity
        .iter()
        .filter(|e| e.kind == kind::CREATED || e.kind == kind::MOVED)
        .filter_map(|e| {
            Some(Step {
                at: parse_time(&e.at)?,
                at_text: &e.at,
                column: column_of(&e.detail)?,
                created: e.kind == kind::CREATED,
            })
        })
        .collect();
    if !steps.iter().any(|s| s.created)
        && let Some(at) = parse_time(created_at)
    {
        steps.insert(
            0,
            Step {
                at,
                at_text: created_at,
                column: ColumnId::Todo,
                created: true,
            },
        );
    }

    let late = now + CLOCK_SLACK;
    let in_future = activity
        .iter()
        .map(|e| e.at.as_str())
        .chain([created_at])
        .filter_map(parse_time)
        .any(|t| t > late);
    let out_of_order = steps.windows(2).any(|w| w[0].at > w[1].at);

    steps.sort_by_key(|s| s.at);
    let mut closed = ColumnSecs::default();
    for w in steps.windows(2) {
        closed.add(w[0].column, secs_between(w[0].at, w[1].at));
    }
    let current_since = steps
        .last()
        .map_or(created_at, |s| s.at_text)
        .to_owned();
    let cycle_secs = match (current, steps.last()) {
        (ColumnId::Done, Some(last)) => {
            let start = steps.iter().find(|s| s.created).unwrap_or(&steps[0]).at;
            let end = steps
                .iter()
                .rev()
                .find(|s| s.column == ColumnId::Done && !s.created)
                .unwrap_or(last)
                .at;
            Some(secs_between(start, end))
        }
        _ => None,
    };
    StatusTime {
        closed_secs: closed,
        current_column: current,
        current_since,
        cycle_secs,
        clock_warning: in_future || out_of_order,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t0() -> OffsetDateTime {
        parse_time("2026-11-23T08:00:00Z").unwrap()
    }

    /// RFC 3339 of `t0 + secs`.
    fn at(secs: i64) -> String {
        crate::clock::format_rfc3339(t0() + Duration::seconds(secs))
    }

    fn entry(kind: &str, secs: i64, detail: &str) -> ActivityData {
        ActivityData {
            at: at(secs),
            actor: "aa".into(),
            kind: kind.into(),
            detail: detail.into(),
        }
    }

    fn secs(todo: i64, doing: i64, done: i64) -> ColumnSecs {
        ColumnSecs { todo, doing, done }
    }

    #[test]
    fn normal_order_counts_each_column_and_the_cycle() {
        let history = [
            entry(kind::CREATED, 0, "To do"),
            entry(kind::TITLE, 30, "x"),
            entry(kind::MOVED, 60, "Dikerjakan"),
            entry(kind::MOVED, 180, "Selesai"),
        ];
        let s = status_time(&at(0), &history, ColumnId::Done, t0() + Duration::seconds(300));
        assert_eq!(s.closed_secs, secs(60, 120, 0));
        assert_eq!(s.current_column, ColumnId::Done);
        assert_eq!(s.current_since, at(180));
        assert_eq!(s.cycle_secs, Some(180));
        assert!(!s.clock_warning);
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["closedSecs"], serde_json::json!({"todo": 60, "doing": 120, "done": 0}));
        assert_eq!(json["currentColumn"], "done");
        assert_eq!(json["cycleSecs"], 180);
        assert_eq!(json["clockWarning"], false);
    }

    #[test]
    fn not_in_done_has_no_cycle_and_ids_are_read_too() {
        let history = [
            entry(kind::CREATED, 0, "todo"),
            entry(kind::MOVED, 100, "done"),
            entry(kind::MOVED, 250, "doing"),
        ];
        let s = status_time(&at(0), &history, ColumnId::Doing, t0() + Duration::seconds(400));
        assert_eq!(s.closed_secs, secs(100, 0, 150));
        assert_eq!(s.current_since, at(250));
        assert_eq!(s.cycle_secs, None);
        assert_eq!(serde_json::to_value(&s).unwrap()["cycleSecs"], serde_json::Value::Null);
    }

    #[test]
    fn a_clock_running_behind_reorders_and_warns() {
        // The move to Selesai was written by a laptop whose clock is behind,
        // so it sorts before the move to Dikerjakan.
        let history = [
            entry(kind::CREATED, 0, "To do"),
            entry(kind::MOVED, 100, "Dikerjakan"),
            entry(kind::MOVED, 50, "Selesai"),
        ];
        let s = status_time(&at(0), &history, ColumnId::Done, t0() + Duration::seconds(500));
        assert!(s.clock_warning);
        assert_eq!(s.closed_secs, secs(50, 0, 50));
        assert_eq!(s.current_since, at(100));
        assert_eq!(s.cycle_secs, Some(50));
        for v in [s.closed_secs.todo, s.closed_secs.doing, s.closed_secs.done] {
            assert!(v >= 0);
        }
    }

    #[test]
    fn a_time_in_the_future_warns() {
        let history = [
            entry(kind::CREATED, 0, "To do"),
            entry(kind::MOVED, 3_600, "Dikerjakan"),
        ];
        let now = t0() + Duration::seconds(600);
        let s = status_time(&at(0), &history, ColumnId::Doing, now);
        assert!(s.clock_warning);
        // Within the slack is fine.
        let s = status_time(&at(0), &history, ColumnId::Doing, t0() + Duration::seconds(3_400));
        assert!(!s.clock_warning);
    }

    #[test]
    fn the_open_interval_belongs_to_the_real_column() {
        // Two laptops moved the task at once; the column kept by the
        // document (Selesai) is not the last step in the history.
        let history = [
            entry(kind::CREATED, 0, "To do"),
            entry(kind::MOVED, 40, "Selesai"),
            entry(kind::MOVED, 70, "Dikerjakan"),
        ];
        let s = status_time(&at(0), &history, ColumnId::Done, t0() + Duration::seconds(100));
        assert_eq!(s.current_column, ColumnId::Done);
        assert_eq!(s.current_since, at(70));
        assert_eq!(s.closed_secs, secs(40, 0, 30));
        assert_eq!(s.cycle_secs, Some(40), "last move into Selesai");

        // In Selesai without any move there: up to the last step.
        let history = [
            entry(kind::CREATED, 0, "To do"),
            entry(kind::MOVED, 90, "Dikerjakan"),
        ];
        let s = status_time(&at(0), &history, ColumnId::Done, t0() + Duration::seconds(100));
        assert_eq!(s.cycle_secs, Some(90));
    }

    #[test]
    fn unreadable_entries_are_skipped() {
        let mut bad = entry(kind::MOVED, 50, "Dikerjakan");
        bad.at = "kemarin".into();
        let history = [
            entry(kind::CREATED, 0, "To do"),
            bad,
            entry(kind::MOVED, 80, "Kolom aneh"),
            entry(kind::MOVED, 120, "Selesai"),
        ];
        let s = status_time(&at(0), &history, ColumnId::Done, t0() + Duration::seconds(200));
        assert_eq!(s.closed_secs, secs(120, 0, 0));
        assert!(!s.clock_warning);

        // No history at all: everything from created_at.
        let s = status_time(&at(0), &[], ColumnId::Todo, t0());
        assert_eq!(s.closed_secs, ColumnSecs::default());
        assert_eq!(s.current_since, at(0));
        // A history without its `created` entry starts at created_at in To do.
        let s = status_time(
            &at(0),
            &[entry(kind::MOVED, 30, "Dikerjakan")],
            ColumnId::Doing,
            t0() + Duration::seconds(60),
        );
        assert_eq!(s.closed_secs, secs(30, 0, 0));
    }

    fn time(by: &str, start: i64, end: Option<i64>, deleted: bool) -> TimeData {
        TimeData {
            id: format!("{by}{start}"),
            by: by.into(),
            start: at(start),
            end: end.map(at),
            manual: false,
            note: String::new(),
            deleted,
        }
    }

    #[test]
    fn entry_lengths_and_totals() {
        assert_eq!(entry_secs(&at(0), Some(&at(90))), 90);
        assert_eq!(entry_secs(&at(90), Some(&at(0))), 0, "never negative");
        assert_eq!(entry_secs(&at(0), None), 0);
        assert_eq!(entry_secs("x", Some(&at(0))), 0);

        let entries = [
            time("bb", 0, Some(60), false),
            time("aa", 10, Some(40), false),
            time("aa", 100, None, false),
            time("aa", 200, Some(900), true),
            time("bb", 300, None, true),
            time("bb", 50, Some(20), false),
        ];
        assert_eq!(tracked_secs(&entries), 90);
        assert_eq!(running_since(&entries), [at(100)]);
        assert_eq!(
            totals_by_person(&entries),
            [
                PersonTime {
                    by: "aa".into(),
                    secs: 30,
                    running_since: Some(at(100)),
                },
                PersonTime {
                    by: "bb".into(),
                    secs: 60,
                    running_since: None,
                },
            ]
        );
    }
}
