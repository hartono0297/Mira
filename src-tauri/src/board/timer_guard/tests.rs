use std::sync::Mutex;

use super::*;
use crate::board::commands::{create_project, create_task};
use crate::board::doc::{BoardDoc, Stamp};
use crate::board::model::NewTask;
use crate::board::sync::NoopSync;
use crate::identity::MemoryKeyStore;

/// A colleague's public key; only the stamp carries it.
const OTHER: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/// Counts the changes handed to the sync hook.
#[derive(Default)]
struct Counter(Mutex<usize>);

impl BoardSyncHook for Counter {
    fn on_local_change(&self, _project_id: &str, _change: &SignedChange) {
        *self.0.lock().unwrap() += 1;
    }
}

impl Counter {
    fn count(&self) -> usize {
        *self.0.lock().unwrap()
    }
}

fn at(s: &str) -> OffsetDateTime {
    timing::parse_time(s).unwrap()
}

struct Setup {
    _tmp: tempfile::TempDir,
    state: MiraState,
    me: String,
    /// `(project id, task id)` of WEB-1 and INT-1.
    web: (String, String),
    int: (String, String),
}

fn setup() -> Setup {
    let tmp = tempfile::tempdir().unwrap();
    let state = MiraState::new(Ok(tmp.path().to_path_buf()), Box::new(MemoryKeyStore::new()));
    crate::commands::display_name(&state, "Sari").unwrap();
    crate::commands::organization(&state, "CV Maju Jaya").unwrap();
    let me = state
        .with_core(|c| Ok(c.identity.public_key_hex().to_owned()))
        .unwrap();
    let mut made = Vec::new();
    for (name, code) in [("Situs Web", "WEB"), ("Internal", "INT")] {
        let p = create_project(&state, &NoopSync, name, code, None).unwrap();
        let tid = new_task(&state, &p.id, &format!("Tugas {code}"));
        made.push((p.id, tid));
    }
    let int = made.pop().unwrap();
    let web = made.pop().unwrap();
    Setup {
        _tmp: tmp,
        state,
        me,
        web,
        int,
    }
}

fn new_task(state: &MiraState, project_id: &str, title: &str) -> String {
    let input: NewTask = serde_json::from_value(serde_json::json!({ "title": title })).unwrap();
    create_task(state, &NoopSync, project_id, input).unwrap().card.id
}

/// One local change on the project, as `actor` at `when`.
fn write(
    s: &Setup,
    project_id: &str,
    actor: &str,
    when: &str,
    f: impl FnOnce(&mut BoardDoc, Stamp<'_>) -> AppResult<()>,
) {
    s.state
        .with_core(|c| {
            store::commit_local(&mut c.db, &c.identity, project_id, |d| {
                f(d, Stamp { actor, at: when })
            })
            .map(|_| ())
        })
        .unwrap();
}

fn start(s: &Setup, (pid, tid): &(String, String), when: &str) {
    write(s, pid, &s.me.clone(), when, |d, st| d.start_timer(st, tid).map(|_| ()));
}

fn set_alive(s: &Setup, when: &str) {
    s.state
        .with_core(|c| settings::set(&c.db, LAST_ALIVE_KEY, when))
        .unwrap();
}

fn alive(s: &Setup) -> Option<String> {
    s.state
        .with_core(|c| settings::get(&c.db, LAST_ALIVE_KEY))
        .unwrap()
}

/// My entries on the task.
fn mine(s: &Setup, (pid, tid): &(String, String)) -> Vec<TimeData> {
    s.state
        .with_core(|c| {
            let doc = store::load_doc(&c.db, pid, &store::actor_of(&c.identity))?;
            Ok(doc.task(tid)?.unwrap().time)
        })
        .unwrap()
        .into_iter()
        .filter(|e| e.by == s.me)
        .collect()
}

fn running(s: &Setup, task: &(String, String)) -> bool {
    mine(s, task).iter().any(TimeData::is_running)
}

fn run(s: &Setup, hook: &Counter, now: &str) -> Vec<TimerNotice> {
    run_with_gap(&s.state, hook, at(now), IDLE_GAP).unwrap()
}

#[test]
fn a_gap_over_ten_minutes_pauses_at_the_last_alive_mark() {
    let s = setup();
    let hook = Counter::default();
    start(&s, &s.web, "2026-11-24T08:00:00Z");
    set_alive(&s, "2026-11-24T09:00:00Z");
    // Started after the mark (in the seconds before the first pass): stays.
    start(&s, &s.int, "2026-11-24T09:14:30Z");

    let notices = run(&s, &hook, "2026-11-24T09:15:00Z");
    assert_eq!(notices.len(), 1, "{notices:?}");
    let n = &notices[0];
    assert_eq!(n.reason, TimerPauseReason::Idle);
    assert_eq!((n.project_id.as_str(), n.task_id.as_str()), (s.web.0.as_str(), s.web.1.as_str()));
    assert_eq!((n.code.as_str(), n.title.as_str()), ("WEB-1", "Tugas WEB"));
    assert_eq!(n.at, "2026-11-24T09:00:00Z");
    assert_eq!(n.started_code, None);
    assert_eq!(mine(&s, &s.web)[0].end.as_deref(), Some("2026-11-24T09:00:00Z"));
    assert!(running(&s, &s.int));
    assert_eq!(hook.count(), 1);
    assert_eq!(alive(&s).as_deref(), Some("2026-11-24T09:15:00Z"));

    // The next pass finds nothing to do.
    assert!(run(&s, &hook, "2026-11-24T09:16:00Z").is_empty());
    assert_eq!(hook.count(), 1);
}

#[test]
fn a_short_gap_or_no_mark_pauses_nothing() {
    let s = setup();
    let hook = Counter::default();
    start(&s, &s.web, "2026-11-24T08:00:00Z");
    // First pass ever: no mark yet.
    assert!(run(&s, &hook, "2026-11-24T08:58:00Z").is_empty());
    assert_eq!(alive(&s).as_deref(), Some("2026-11-24T08:58:00Z"));
    assert!(run(&s, &hook, "2026-11-24T09:00:00Z").is_empty());
    assert!(running(&s, &s.web));
    assert_eq!(hook.count(), 0);
    assert_eq!(alive(&s).as_deref(), Some("2026-11-24T09:00:00Z"));
}

#[test]
fn a_clock_that_went_back_pauses_nothing() {
    let s = setup();
    let hook = Counter::default();
    start(&s, &s.web, "2026-11-24T08:00:00Z");
    set_alive(&s, "2026-11-24T10:00:00Z");
    assert!(run(&s, &hook, "2026-11-24T09:30:00Z").is_empty());
    assert!(running(&s, &s.web));
    assert_eq!(alive(&s).as_deref(), Some("2026-11-24T09:30:00Z"));
}

#[test]
fn a_task_a_colleague_finished_pauses_my_timer_but_not_one_started_later() {
    let s = setup();
    let hook = Counter::default();
    set_alive(&s, "2026-11-24T08:30:00Z");
    // INT-1 was already in Selesai when I started its timer.
    let int = s.int.clone();
    write(&s, &int.0, OTHER, "2026-11-24T08:05:00Z", |d, st| {
        d.move_task(st, &int.1, ColumnId::Done, 0).map(|_| ())
    });
    start(&s, &s.int, "2026-11-24T08:10:00Z");
    // My timer on WEB-1 runs; a colleague then moves WEB-1 to Selesai.
    start(&s, &s.web, "2026-11-24T08:20:00Z");
    let web = s.web.clone();
    write(&s, &web.0, OTHER, "2026-11-24T08:30:00Z", |d, st| {
        d.move_task(st, &web.1, ColumnId::Done, 0).map(|_| ())
    });
    assert!(running(&s, &s.web) && running(&s, &s.int));

    let notices = run(&s, &hook, "2026-11-24T08:31:00Z");
    assert_eq!(notices.len(), 1, "{notices:?}");
    assert_eq!(notices[0].reason, TimerPauseReason::Done);
    assert_eq!(notices[0].task_id, s.web.1);
    assert_eq!(notices[0].at, "2026-11-24T08:31:00Z");
    assert!(!running(&s, &s.web));
    assert!(running(&s, &s.int), "started after the task was finished");
    assert_eq!(hook.count(), 1);
    assert!(run(&s, &hook, "2026-11-24T08:32:00Z").is_empty());
}

#[test]
fn a_task_a_colleague_deleted_pauses_my_timer() {
    let s = setup();
    let hook = Counter::default();
    set_alive(&s, "2026-11-24T08:15:00Z");
    start(&s, &s.web, "2026-11-24T08:00:00Z");
    let web = s.web.clone();
    write(&s, &web.0, OTHER, "2026-11-24T08:20:00Z", |d, st| {
        d.delete_task(st, &web.1).map(|_| ())
    });
    assert!(running(&s, &s.web));

    let notices = run(&s, &hook, "2026-11-24T08:21:00Z");
    assert_eq!(notices.len(), 1, "{notices:?}");
    assert_eq!(notices[0].reason, TimerPauseReason::Deleted);
    assert_eq!((notices[0].code.as_str(), notices[0].title.as_str()), ("WEB-1", "Tugas WEB"));
    assert!(!running(&s, &s.web));
    assert_eq!(hook.count(), 1);
}

#[test]
fn of_two_running_timers_the_newest_stays() {
    let s = setup();
    let hook = Counter::default();
    set_alive(&s, "2026-11-24T08:30:00Z");
    // Separate projects, so neither start paused the other (as with a
    // timer started on a v0.5 laptop).
    start(&s, &s.web, "2026-11-24T08:00:00Z");
    start(&s, &s.int, "2026-11-24T08:20:00Z");
    assert!(running(&s, &s.web) && running(&s, &s.int));

    let notices = run(&s, &hook, "2026-11-24T08:31:00Z");
    assert_eq!(notices.len(), 1, "{notices:?}");
    assert_eq!(notices[0].reason, TimerPauseReason::Switched);
    assert_eq!(notices[0].task_id, s.web.1);
    assert_eq!(notices[0].started_code.as_deref(), Some("INT-1"));
    assert!(!running(&s, &s.web) && running(&s, &s.int));
    assert!(run(&s, &hook, "2026-11-24T08:32:00Z").is_empty());
}

#[test]
fn nothing_happens_before_an_organization_exists() {
    let tmp = tempfile::tempdir().unwrap();
    let state = MiraState::new(Ok(tmp.path().to_path_buf()), Box::new(MemoryKeyStore::new()));
    let hook = Counter::default();
    assert!(run_with_gap(&state, &hook, at("2026-11-24T08:00:00Z"), IDLE_GAP)
        .unwrap()
        .is_empty());
    // A core that cannot open is skipped too.
    let broken = MiraState::new(
        Err(crate::error::AppError::Internal("tidak ada folder".into())),
        Box::new(MemoryKeyStore::new()),
    );
    assert!(run_once(&broken, &hook, at("2026-11-24T08:00:00Z")).unwrap().is_empty());
}
