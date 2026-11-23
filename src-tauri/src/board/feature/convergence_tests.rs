//! Convergence and scoping of board sync across three laptops, through
//! `network::feature::testing`, with a real membership log (signed ops
//! synced between the laptops before the board records).
//!
//! - random offline edits on three laptops end in the same document, heads,
//!   task index and unique task numbers, whatever order the pairs sync in;
//! - colliding task numbers, delete against edit, records arriving one by
//!   one in any order;
//! - who is offered what (other team, guest per project, removed from the
//!   team, superadmin before and after joining the team);
//! - forged changes are refused, logged and not asked for again;
//! - project rename and colliding project codes.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::Arc;

use automerge::transaction::Transactable;
use automerge::{AutoCommit, ObjId, ObjType, ROOT, ReadDoc, Value};
use proptest::prelude::*;
use tempfile::TempDir;

use super::*;
use crate::board::commands;
use crate::board::doc::{BoardDoc, Stamp, TaskData, TaskInit, kind};
use crate::board::model::{ColumnId, NewTask, Priority, TaskPatch};
use crate::board::sign::{sign_change, signing_message};
use crate::board::store::{self, IndexRow};
use crate::board::sync::{self, NoopSync};
use crate::board::testutil::org_ops;
use crate::clock;
use crate::error::AppResult;
use crate::identity::{self, MemoryKeyStore};
use crate::network::feature::check_incoming;
use crate::network::feature::testing::{pull, sync_all};
use crate::org;
use crate::permissions::{self as p, InviteRole};
use crate::state::{Core, MiraState};

/// One laptop: its own data folder, key and board feature.
struct Lap {
    _tmp: TempDir,
    state: MiraState,
    f: BoardFeature,
    pk: String,
}

impl Lap {
    fn new(name: &str) -> Lap {
        let tmp = tempfile::tempdir().unwrap();
        let state = MiraState::new(Ok(tmp.path().to_path_buf()), Box::new(MemoryKeyStore::new()));
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

    fn founder(name: &str) -> Lap {
        let l = Lap::new(name);
        l.core(|c| org::create_organization(&mut c.db, &c.identity, "CV Maju Jaya").map(|_| ()));
        l
    }

    fn core<T>(&self, f: impl FnOnce(&mut Core) -> AppResult<T>) -> T {
        self.state.with_core(f).unwrap()
    }

    fn me(&self) -> (&str, &dyn FeatureSync) {
        (&self.pk, &self.f)
    }

    fn count(&self, sql: &str) -> i64 {
        self.core(|c| Ok(c.db.query_row(sql, [], |r| r.get(0))?))
    }

    fn pending(&self, reason: &str) -> i64 {
        self.core(|c| {
            Ok(c.db.query_row(
                "SELECT count(*) FROM board_pending WHERE reason = ?1",
                [reason],
                |r| r.get(0),
            )?)
        })
    }

    fn is_refused(&self, record_id: &str) -> bool {
        self.core(|c| {
            Ok(c.db.query_row(
                "SELECT count(*) FROM board_rejected WHERE record_id = ?1",
                [record_id],
                |r| r.get::<_, i64>(0),
            )? == 1)
        })
    }

    fn rejections(&self) -> Vec<String> {
        self.core(|c| {
            let mut stmt = c.db.prepare("SELECT code FROM rejected_changes ORDER BY id")?;
            let rows = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
            Ok(rows)
        })
    }

    fn tasks(&self, pid: &str) -> Vec<TaskData> {
        self.core(|c| store::load_doc(&c.db, pid, &store::actor_of(&c.identity))?.tasks())
    }

    fn task(&self, pid: &str, id: &str) -> TaskData {
        self.tasks(pid).into_iter().find(|t| t.id == id).unwrap()
    }

    fn heads(&self, pid: &str) -> Vec<String> {
        self.core(|c| sync::heads(&c.db, pid))
    }

    fn has_project(&self, pid: &str) -> bool {
        self.core(|c| Ok(store::project(&c.db, pid).is_ok()))
    }

    fn index(&self, pid: &str) -> Vec<IndexRow> {
        self.core(|c| store::index_rows(&c.db, pid))
    }

    /// `(name, shown code, code in the document)` of a project.
    fn project_names(&self, pid: &str) -> (String, String, String) {
        self.core(|c| {
            let row = store::project(&c.db, pid)?;
            let doc = store::load_doc(&c.db, pid, &[0; 32])?;
            Ok((row.name, row.code, doc.project().code))
        })
    }

    fn record_ids(&self, pid: &str) -> Vec<String> {
        self.core(|c| store::stored_changes(&c.db, pid))
            .iter()
            .map(SignedChange::record_id)
            .collect()
    }
}

/// Runs `f` with the cores of two laptops at once.
fn both<T>(a: &Lap, b: &Lap, f: impl FnOnce(&mut Core, &mut Core) -> T) -> T {
    a.state
        .with_core(|ca| b.state.with_core(|cb| Ok(f(ca, cb))))
        .unwrap()
}

fn join(inviter: &Lap, joiner: &Lap, team: &str, role: InviteRole, projects: Vec<String>) {
    both(inviter, joiner, |i, j| {
        org_ops::join(
            (&mut i.db, &i.identity),
            (&mut j.db, &j.identity),
            team,
            role,
            projects,
        )
    });
}

/// Membership ops between every pair until nothing new arrives.
fn sync_ops(laps: &[&Lap]) {
    for _ in 0..10 {
        let mut n = 0;
        for a in laps {
            for b in laps {
                if a.pk != b.pk {
                    n += both(a, b, |ca, cb| org_ops::sync(&ca.db, &mut cb.db, &b.pk, &a.pk));
                }
            }
        }
        if n == 0 {
            return;
        }
    }
    panic!("membership ops did not settle");
}

/// Sari (founder, superadmin), Budi (admin of team Desain) and Citra (member
/// of Desain).
struct Office {
    sari: Lap,
    budi: Lap,
    citra: Lap,
    team: String,
}

impl Office {
    fn laps(&self) -> [&Lap; 3] {
        [&self.sari, &self.budi, &self.citra]
    }

    fn all(&self) -> [(&str, &dyn FeatureSync); 3] {
        [self.sari.me(), self.budi.me(), self.citra.me()]
    }

    /// A new laptop that joins department Desain as a member through Sari's
    /// invite; the membership ops reach every laptop of the office.
    fn member(&self, name: &str) -> Lap {
        let l = Lap::new(name);
        join(&self.sari, &l, &self.team, InviteRole::Member, vec![]);
        sync_ops(&[&self.sari, &self.budi, &self.citra, &l]);
        l
    }

    /// Budi (admin of Desain, so a manager of its projects) adds `who` to
    /// project `pid`; the op reaches every laptop of the office and `who`.
    fn add_to_project(&self, pid: &str, who: &Lap) {
        let pk = who.pk.clone();
        self.budi
            .core(|c| p::add_project_member(&mut c.db, &c.identity, pid, &pk, org_ops::now()));
        sync_ops(&[&self.sari, &self.budi, &self.citra, who]);
    }
}

/// The office; Sari joins Desain through an `add_team_member` op when
/// `sari_in_team`.
fn office_with(sari_in_team: bool) -> Office {
    let sari = Lap::founder("Sari");
    let budi = Lap::new("Budi");
    let citra = Lap::new("Citra");
    let team = sari.core(|c| Ok(org_ops::create_team(&mut c.db, &c.identity, "Desain")));
    join(&sari, &budi, &team, InviteRole::TeamAdmin, vec![]);
    join(&sari, &citra, &team, InviteRole::Member, vec![]);
    if sari_in_team {
        let sari_pk = sari.pk.clone();
        sari.core(|c| p::add_team_member(&mut c.db, &c.identity, &team, &sari_pk, org_ops::now()));
    }
    sync_ops(&[&sari, &budi, &citra]);
    Office {
        sari,
        budi,
        citra,
        team,
    }
}

fn office() -> Office {
    office_with(true)
}

/// `creator`'s project of Desain, with every other office laptop in Desain
/// as a project member (everyone who saw a department project before v0.3).
/// The membership ops reach every laptop of the office.
fn project(o: &Office, creator: &Lap, name: &str, code: &str) -> String {
    let pid = commands::create_project(&creator.state, &NoopSync, name, code, Some(&o.team))
        .unwrap()
        .id;
    let team = o.team.clone();
    let others: Vec<String> = creator.core(|c| {
        let state = p::require_state(&c.db)?;
        Ok(state
            .members
            .keys()
            .filter(|pk| **pk != creator.pk && state.team_role(&team, pk).is_some())
            .cloned()
            .collect())
    });
    for pk in others {
        creator.core(|c| p::add_project_member(&mut c.db, &c.identity, &pid, &pk, org_ops::now()));
    }
    sync_ops(&o.laps());
    pid
}

/// A project every laptop of the office already holds.
fn shared_project(o: &Office, creator: &Lap, name: &str, code: &str) -> String {
    let pid = project(o, creator, name, code);
    sync_all(&o.all()).unwrap();
    pid
}

fn new_task(l: &Lap, pid: &str, title: &str) -> String {
    let input = NewTask {
        title: title.into(),
        ..NewTask::default()
    };
    commands::create_task(&l.state, &NoopSync, pid, input)
        .unwrap()
        .card
        .id
}

/// A task with a chosen `created_at`, through the store (the same change the
/// app would make, without the permission check of `commands`).
fn task_at(l: &Lap, pid: &str, title: &str, created_at: &str) -> String {
    l.core(|c| {
        let me = c.identity.public_key_hex().to_owned();
        let done = store::commit_local(&mut c.db, &c.identity, pid, |d| {
            d.create_task(
                Stamp {
                    actor: &me,
                    at: created_at,
                },
                TaskInit {
                    title: title.into(),
                    ..TaskInit::default()
                },
            )
        })?;
        Ok(done.value)
    })
}

fn at(minute: u32) -> String {
    format!("2026-11-22T01:{minute:02}:00Z")
}

fn retitle(l: &Lap, pid: &str, task: &str, title: &str) {
    commands::update_task(&l.state, &NoopSync, pid, task, TaskPatch {
        title: Some(title.into()),
        ..TaskPatch::default()
    })
    .unwrap();
}

fn ingest(to: &Lap, from: &Lap, records: Vec<FeatureRecord>) -> FeatureIngest {
    let (ok, dropped) = check_incoming(records);
    assert_eq!(dropped, 0);
    to.f.ingest(&from.pk, ok).unwrap()
}

fn record(sc: &SignedChange) -> FeatureRecord {
    FeatureRecord::new(sc.record_body())
}

/// The object at `key` in `parent`.
fn obj(am: &AutoCommit, parent: &ObjId, key: &str) -> ObjId {
    match am.get(parent, key).unwrap() {
        Some((Value::Object(_), id)) => id,
        other => panic!("{key} is not an object: {other:?}"),
    }
}

/// `author` edits a copy of `source`'s document directly (no permission
/// check, no shape check) and signs the change: what a modified app could
/// send. Nothing is stored.
fn forge(
    author: &Lap,
    source: &Lap,
    pid: &str,
    f: impl FnOnce(&mut AutoCommit, &str),
) -> SignedChange {
    let snapshot: Vec<u8> = source.core(|c| {
        Ok(c.db.query_row("SELECT doc FROM board_projects WHERE id = ?1", [pid], |r| r.get(0))?)
    });
    author.core(|c| {
        let mut doc = BoardDoc::load(&snapshot, &store::actor_of(&c.identity))?;
        let before = doc.heads();
        let me = c.identity.public_key_hex().to_owned();
        f(doc.raw(), &me);
        doc.commit(clock::now().unix_timestamp());
        let change = doc.changes_after(&before).pop().unwrap();
        Ok(sign_change(&c.identity, pid, &change))
    })
}

/// A change `l` makes in its own document without the permission check of
/// `commands`, stored and offered like any local change.
fn forced(l: &Lap, pid: &str, f: impl FnOnce(&mut BoardDoc, &str) -> AppResult<()>) -> SignedChange {
    l.core(|c| {
        let me = c.identity.public_key_hex().to_owned();
        let done = store::commit_local(&mut c.db, &c.identity, pid, |d| f(d, &me))?;
        Ok(done.changes.into_iter().next().unwrap())
    })
}

/// Live task numbers are unique.
fn assert_unique_numbers(tasks: &[TaskData]) {
    let live: Vec<i64> = tasks.iter().filter(|t| !t.deleted).map(|t| t.number).collect();
    let set: BTreeSet<i64> = live.iter().copied().collect();
    assert_eq!(set.len(), live.len(), "duplicate numbers: {live:?}");
}

/// The task index of `l` says what the document says, with `code` as the
/// project code.
fn assert_index_matches_doc(l: &Lap, pid: &str, code: &str) {
    let mut expected: Vec<IndexRow> = l
        .tasks(pid)
        .into_iter()
        .map(|t| {
            (
                t.id,
                store::task_code(code, t.number),
                t.title,
                t.column,
                t.assignee,
                t.due,
                t.deleted,
            )
        })
        .collect();
    expected.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(l.index(pid), expected);
}

/// Every laptop holds the same document, heads and index, numbers are
/// unique, nothing waits and nothing was refused.
fn assert_converged(laps: &[&Lap], pid: &str, code: &str) {
    let tasks = laps[0].tasks(pid);
    let heads = laps[0].heads(pid);
    let index = laps[0].index(pid);
    let ids: BTreeSet<String> = laps[0].record_ids(pid).into_iter().collect();
    assert_unique_numbers(&tasks);
    for l in laps {
        assert_eq!(l.tasks(pid), tasks);
        assert_eq!(l.heads(pid), heads);
        assert_eq!(l.index(pid), index);
        assert_eq!(l.record_ids(pid).into_iter().collect::<BTreeSet<_>>(), ids);
        assert_index_matches_doc(l, pid, code);
        assert_eq!(l.count("SELECT count(*) FROM board_pending"), 0);
        assert_eq!(l.count("SELECT count(*) FROM board_rejected"), 0);
        assert!(l.rejections().is_empty(), "{:?}", l.rejections());
    }
}

fn shuffled<T: Clone>(items: &[T], seed: u64) -> Vec<T> {
    let mut out = items.to_vec();
    let mut s = seed.max(1);
    for i in (1..out.len()).rev() {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        let j = usize::try_from(s % (i as u64 + 1)).unwrap();
        out.swap(i, j);
    }
    out
}

// ---------------------------------------------------------------------------
// 1. Random offline edits converge.

#[derive(Debug, Clone)]
enum Op {
    Create(u8, u8),
    Title(u8, u8),
    Describe(u8, u8),
    Move(u8, u8, u8),
    Comment(u8, u8),
    DeleteOwn(u8),
    /// Any live task: allowed for the admin (Budi) and the superadmin in the
    /// team (Sari), and for Citra only on her own tasks.
    DeleteAny(u8),
    Due(u8, Option<u8>),
    Priority(u8, u8),
    Labels(u8, Vec<u8>),
    /// A pull from one of the other two laptops (partial sync mid-way).
    Pull(u8),
}

fn op() -> impl Strategy<Value = Op> {
    let b = any::<u8>;
    prop_oneof![
        3 => (b(), 0u8..3).prop_map(|(t, c)| Op::Create(t, c)),
        2 => (b(), b()).prop_map(|(i, t)| Op::Title(i, t)),
        1 => (b(), b()).prop_map(|(i, t)| Op::Describe(i, t)),
        2 => (b(), 0u8..3, 0u8..4).prop_map(|(i, c, x)| Op::Move(i, c, x)),
        2 => (b(), b()).prop_map(|(i, t)| Op::Comment(i, t)),
        1 => b().prop_map(Op::DeleteOwn),
        1 => b().prop_map(Op::DeleteAny),
        1 => (b(), proptest::option::of(0u8..28)).prop_map(|(i, d)| Op::Due(i, d)),
        1 => (b(), 0u8..4).prop_map(|(i, x)| Op::Priority(i, x)),
        1 => (b(), proptest::collection::vec(0u8..5, 0..4)).prop_map(|(i, l)| Op::Labels(i, l)),
        1 => (0u8..2).prop_map(Op::Pull),
    ]
}

/// Runs `op` on laptop `who` through `commands`, as the app would.
fn run(o: &Office, who: usize, op: &Op, pid: &str) {
    let laps = o.laps();
    let l = laps[who];
    let live: Vec<TaskData> = l.tasks(pid).into_iter().filter(|t| !t.deleted).collect();
    let own: Vec<&TaskData> = live.iter().filter(|t| t.created_by == l.pk).collect();
    let pick = |i: &u8| live.get(usize::from(*i) % live.len().max(1));
    let column = |c: &u8| ColumnId::ALL[usize::from(*c) % 3];
    let hook = &NoopSync;
    let edit = |id: &str, patch: TaskPatch| {
        commands::update_task(&l.state, hook, pid, id, patch).unwrap();
    };
    match op {
        Op::Create(t, c) => {
            let input = NewTask {
                title: format!("Task {t}"),
                column_id: Some(column(c)),
                ..NewTask::default()
            };
            commands::create_task(&l.state, hook, pid, input).unwrap();
        }
        Op::Pull(k) => {
            let from = laps[(who + 1 + usize::from(*k)) % 3];
            pull(from.me(), l.me()).unwrap();
        }
        Op::DeleteOwn(i) => {
            if !own.is_empty() {
                let t = own[usize::from(*i) % own.len()];
                commands::delete_task(&l.state, hook, pid, &t.id).unwrap();
            }
        }
        Op::DeleteAny(i) => {
            if let Some(t) = pick(i) {
                let res = commands::delete_task(&l.state, hook, pid, &t.id);
                let allowed = who != 2 || t.created_by == l.pk;
                assert_eq!(res.is_ok(), allowed, "{res:?}");
            }
        }
        Op::Title(i, x) => {
            if let Some(t) = pick(i) {
                edit(&t.id, TaskPatch {
                    title: Some(format!("Judul {x}")),
                    ..TaskPatch::default()
                });
            }
        }
        Op::Describe(i, x) => {
            if let Some(t) = pick(i) {
                edit(&t.id, TaskPatch {
                    description: Some(format!("Deskripsi {x} dari {who}")),
                    ..TaskPatch::default()
                });
            }
        }
        Op::Move(i, c, x) => {
            if let Some(t) = pick(i) {
                commands::move_task(&l.state, hook, pid, &t.id, column(c), usize::from(*x)).unwrap();
            }
        }
        Op::Comment(i, x) => {
            if let Some(t) = pick(i) {
                commands::add_comment(&l.state, hook, pid, &t.id, &format!("Komentar {x}")).unwrap();
            }
        }
        Op::Due(i, d) => {
            if let Some(t) = pick(i) {
                edit(&t.id, TaskPatch {
                    due: Some(d.map(|d| format!("2026-12-{:02}", d + 1))),
                    ..TaskPatch::default()
                });
            }
        }
        Op::Priority(i, x) => {
            if let Some(t) = pick(i) {
                let all = [Priority::None, Priority::Low, Priority::Medium, Priority::High];
                edit(&t.id, TaskPatch {
                    priority: Some(all[usize::from(*x) % 4]),
                    ..TaskPatch::default()
                });
            }
        }
        Op::Labels(i, ls) => {
            if let Some(t) = pick(i) {
                edit(&t.id, TaskPatch {
                    labels: Some(ls.iter().map(|x| format!("L{x}")).collect()),
                    ..TaskPatch::default()
                });
            }
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 16,
        failure_persistence: None,
        ..ProptestConfig::default()
    })]

    #[test]
    fn random_offline_edits_on_three_laptops_converge(
        steps in proptest::collection::vec((0usize..3, op()), 0..24),
        order in Just(vec![0usize, 1, 2]).prop_shuffle(),
    ) {
        let o = office();
        let pid = shared_project(&o, &o.budi, "Peluncuran produk", "PL");
        // One shared task per creator, so deletes and edits have targets.
        for (l, title) in [(&o.sari, "Dari Sari"), (&o.budi, "Dari Budi"), (&o.citra, "Dari Citra")] {
            new_task(l, &pid, title);
        }
        sync_all(&o.all()).unwrap();

        for (who, op) in &steps {
            run(&o, *who, op, &pid);
        }

        let all = o.all();
        let laptops: Vec<(&str, &dyn FeatureSync)> = order.iter().map(|&i| all[i]).collect();
        sync_all(&laptops).unwrap();
        assert_converged(&o.laps(), &pid, "PL");
    }
}

// ---------------------------------------------------------------------------
// 2. Colliding task numbers.

#[test]
fn colliding_numbers_end_unique_and_the_same_everywhere() {
    let o = office();
    let pid = project(&o, &o.budi, "Peluncuran produk", "PL");
    sync_all(&o.all()).unwrap();
    // Offline: Budi and Citra both create PL-1 and PL-2; Budi's are older.
    let b1 = task_at(&o.budi, &pid, "b1", &at(1));
    let b2 = task_at(&o.budi, &pid, "b2", &at(2));
    let c1 = task_at(&o.citra, &pid, "c1", &at(3));
    let c2 = task_at(&o.citra, &pid, "c2", &at(4));
    assert_eq!(o.citra.task(&pid, &c1).number, 1);

    sync_all(&o.all()).unwrap();
    assert_converged(&o.laps(), &pid, "PL");
    for l in o.laps() {
        let n: HashMap<String, i64> = l.tasks(&pid).into_iter().map(|t| (t.id, t.number)).collect();
        assert_eq!((n[&b1], n[&b2], n[&c1], n[&c2]), (1, 2, 3, 4));
        let codes: HashMap<String, String> = l.index(&pid).into_iter().map(|r| (r.0, r.1)).collect();
        assert_eq!(codes[&c1], "PL-3");
        assert_eq!(codes[&c2], "PL-4");
    }
    // The losing tasks carry a `renumbered` entry with the old code, written
    // by their creator; the winners have none.
    for (id, old) in [(&c1, "PL-1"), (&c2, "PL-2")] {
        let t = o.sari.task(&pid, id);
        let last = t.activity.last().unwrap();
        assert_eq!(last.kind, kind::RENUMBERED);
        assert_eq!(last.detail, old);
        assert_eq!(last.actor, o.citra.pk);
    }
    for id in [&b1, &b2] {
        let t = o.sari.task(&pid, id);
        assert!(t.activity.iter().all(|e| e.kind != kind::RENUMBERED));
    }
    // The next task continues after the new numbers, on any laptop.
    let next = new_task(&o.sari, &pid, "Sesudahnya");
    assert_eq!(o.sari.task(&pid, &next).number, 5);
}

#[test]
fn three_laptops_creating_the_first_task_at_once_converge() {
    let o = office();
    let pid = project(&o, &o.budi, "Peluncuran produk", "PL");
    sync_all(&o.all()).unwrap();
    let mut created = Vec::new();
    for (l, title) in [(&o.sari, "Satu dari Sari"), (&o.budi, "Satu dari Budi"), (&o.citra, "Satu dari Citra")] {
        let id = new_task(l, &pid, title);
        assert_eq!(l.task(&pid, &id).number, 1);
        created.push(id);
    }
    sync_all(&o.all()).unwrap();
    assert_converged(&o.laps(), &pid, "PL");
    let tasks = o.budi.tasks(&pid);
    let mut numbers: Vec<i64> = tasks.iter().map(|t| t.number).collect();
    numbers.sort();
    assert_eq!(numbers, [1, 2, 3]);
    // Two tasks lost number 1; each says so, written by its own creator.
    let renumbered: Vec<&TaskData> = tasks
        .iter()
        .filter(|t| t.activity.iter().any(|e| e.kind == kind::RENUMBERED))
        .collect();
    assert_eq!(renumbered.len(), 2);
    for t in renumbered {
        assert_ne!(t.number, 1);
        let e = t.activity.iter().find(|e| e.kind == kind::RENUMBERED).unwrap();
        assert_eq!(e.detail, "PL-1");
        assert_eq!(e.actor, t.created_by);
    }
}

// ---------------------------------------------------------------------------
// 3. Delete against edit.

/// `deleter` deletes `creator`'s task while `editor` edits and comments on
/// it, all offline.
fn delete_while_editing(o: &Office, creator: &Lap, deleter: &Lap, editor: &Lap) {
    let pid = shared_project(o, &o.budi, "Peluncuran produk", "PL");
    let task = new_task(creator, &pid, "Spanduk");
    sync_all(&o.all()).unwrap();

    commands::delete_task(&deleter.state, &NoopSync, &pid, &task).unwrap();
    retitle(editor, &pid, &task, "Spanduk besar");
    commands::add_comment(&editor.state, &NoopSync, &pid, &task, "Masih dikerjakan").unwrap();

    sync_all(&o.all()).unwrap();
    assert_converged(&o.laps(), &pid, "PL");
    for l in o.laps() {
        let t = l.task(&pid, &task);
        assert!(t.deleted, "the task stays deleted");
        assert_eq!(t.title, "Spanduk besar", "the edit is kept in the document");
        assert_eq!(t.comments.len(), 1);
        assert_eq!(t.comments[0].author, editor.pk);
        assert!(t.activity.iter().any(|e| e.kind == kind::DELETED && e.actor == deleter.pk));
        assert!(commands::get_task(&l.state, &pid, &task).is_err());
        let board = commands::get_board(&l.state, &pid).unwrap();
        assert!(board.columns.iter().all(|c| c.tasks.iter().all(|x| x.id != task)));
    }
}

#[test]
fn admin_deletes_while_the_creator_edits() {
    let o = office();
    delete_while_editing(&o, &o.citra, &o.budi, &o.citra);
}

#[test]
fn creator_deletes_while_someone_else_edits() {
    let o = office();
    delete_while_editing(&o, &o.citra, &o.citra, &o.sari);
}

// ---------------------------------------------------------------------------
// 4. Arrival order.

#[test]
fn records_in_any_arrival_order_give_the_same_result() {
    let o = office();
    let pid = shared_project(&o, &o.budi, "Peluncuran produk", "PL");
    let a = new_task(&o.budi, &pid, "Logo");
    new_task(&o.citra, &pid, "Brosur");
    sync_all(&o.all()).unwrap();
    // Offline edits on all three, a colliding number and an admin delete.
    retitle(&o.citra, &pid, &a, "Logo final");
    commands::add_comment(&o.sari.state, &NoopSync, &pid, &a, "Bagus").unwrap();
    let doomed = new_task(&o.citra, &pid, "Salah buat");
    new_task(&o.budi, &pid, "Poster");
    commands::move_task(&o.budi.state, &NoopSync, &pid, &a, ColumnId::Done, 0).unwrap();
    sync_all(&o.all()).unwrap();
    commands::delete_task(&o.budi.state, &NoopSync, &pid, &doomed).unwrap();
    sync_all(&o.all()).unwrap();
    assert_converged(&o.laps(), &pid, "PL");

    let receivers = [o.member("Dewi"), o.member("Eko"), o.member("Fajar"), o.member("Gita")];
    for r in &receivers {
        o.add_to_project(&pid, r);
    }
    let ids = o.budi.f.record_ids_for(&receivers[0].pk).unwrap();
    let records = o.budi.f.records_for(&receivers[0].pk, &ids).unwrap();
    assert_eq!(records.len(), o.budi.record_ids(&pid).len());
    assert!(records.len() >= 10, "{}", records.len());

    let mut reversed = records.clone();
    reversed.reverse();
    let mut twice = shuffled(&records, 7);
    twice.extend(shuffled(&records, 99));
    let orders = [records.clone(), reversed, shuffled(&records, 12_345), twice];
    for (to, order) in receivers.iter().zip(orders) {
        for r in order {
            ingest(to, &o.budi, vec![r]);
        }
    }
    let mut laps: Vec<&Lap> = o.laps().to_vec();
    laps.extend(receivers.iter());
    assert_converged(&laps, &pid, "PL");
    assert!(o.budi.task(&pid, &doomed).deleted);
}

// ---------------------------------------------------------------------------
// 5. Scoping.

#[test]
fn other_department_gets_nothing_and_a_guest_gets_only_their_project() {
    let o = office();
    let pa = shared_project(&o, &o.budi, "Untuk klien", "PA");
    let pb = shared_project(&o, &o.budi, "Internal", "PB");
    new_task(&o.budi, &pa, "Desain kemasan");
    new_task(&o.citra, &pb, "Rapat internal");
    sync_all(&o.all()).unwrap();

    let dodi = Lap::new("Dodi");
    let tamu = Lap::new("Klien");
    let keuangan = o.sari.core(|c| Ok(org_ops::create_team(&mut c.db, &c.identity, "Keuangan")));
    join(&o.sari, &dodi, &keuangan, InviteRole::Member, vec![]);
    join(&o.sari, &tamu, &o.team, InviteRole::Guest, vec![pa.clone()]);
    sync_ops(&[&o.sari, &o.budi, &o.citra, &dodi, &tamu]);

    let pa_ids: BTreeSet<String> = o.budi.record_ids(&pa).into_iter().collect();
    let mut every: Vec<String> = o.budi.record_ids(&pa);
    every.extend(o.budi.record_ids(&pb));
    for l in o.laps() {
        // Another department: nothing offered, nothing sent even when asked by id.
        assert!(l.f.record_ids_for(&dodi.pk).unwrap().is_empty());
        assert!(l.f.records_for(&dodi.pk, &every).unwrap().is_empty());
        // The guest: project PA only.
        let offered: BTreeSet<String> = l.f.record_ids_for(&tamu.pk).unwrap().into_iter().collect();
        assert_eq!(offered, pa_ids);
        let sent: BTreeSet<String> = l
            .f
            .records_for(&tamu.pk, &every)
            .unwrap()
            .into_iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(sent, pa_ids);
    }
    for l in o.laps() {
        assert_eq!(pull(l.me(), dodi.me()).unwrap().0.accepted, 0);
        pull(l.me(), tamu.me()).unwrap();
    }
    assert!(!dodi.has_project(&pa) && !dodi.has_project(&pb));
    assert!(tamu.has_project(&pa));
    assert!(!tamu.has_project(&pb));
    assert_eq!(tamu.heads(&pa), o.budi.heads(&pa));

    // The guest's laptop makes a change anyway and offers it.
    let by_guest = forced(&tamu, &pa, |d, me| {
        let at = clock::now_rfc3339();
        d.create_task(Stamp { actor: me, at: &at }, TaskInit {
            title: "Dari tamu".into(),
            ..TaskInit::default()
        })
        .map(|_| ())
    });
    let guest_id = by_guest.record_id();
    assert!(tamu.f.record_ids_for(&o.budi.pk).unwrap().contains(&guest_id));
    let heads = o.budi.heads(&pa);
    let five = [o.sari.me(), o.budi.me(), o.citra.me(), dodi.me(), tamu.me()];
    sync_all(&five).unwrap();
    for l in o.laps() {
        assert_eq!(l.heads(&pa), heads, "the guest's change is not applied");
        // Not kept and not refused for good: the guest may have just become
        // a member on a laptop we have not heard from. Asked for again later.
        assert!(!l.is_refused(&guest_id));
        assert_eq!(l.count("SELECT count(*) FROM board_pending"), 0);
        assert!(l.rejections().is_empty());
        let asks_again = l.f.unknown_ids(std::slice::from_ref(&guest_id)).unwrap();
        assert!(l.pk == tamu.pk || asks_again == vec![guest_id.clone()]);
        assert!(!l.f.record_ids_for(&o.sari.pk).unwrap().contains(&guest_id));
    }
    assert!(!tamu.has_project(&pb));
    assert!(!dodi.has_project(&pa));
}

#[test]
fn member_removed_from_the_project_gets_nothing_new_and_is_not_accepted() {
    let o = office();
    let pid = project(&o, &o.budi, "Peluncuran produk", "PL");
    let task = new_task(&o.budi, &pid, "Logo");
    sync_all(&o.all()).unwrap();

    // Budi (department admin) takes Citra out of the project; she stays in
    // the department.
    let citra_pk = o.citra.pk.clone();
    o.budi
        .core(|c| p::remove_project_member(&mut c.db, &c.identity, &pid, &citra_pk, org_ops::now()));
    sync_ops(&o.laps());

    new_task(&o.budi, &pid, "Sesudah Citra keluar");
    let latest = o.budi.record_ids(&pid).pop().unwrap();
    for l in [&o.sari, &o.budi] {
        assert!(l.f.record_ids_for(&o.citra.pk).unwrap().is_empty());
        assert!(l.f.records_for(&o.citra.pk, std::slice::from_ref(&latest)).unwrap().is_empty());
    }
    assert_eq!(pull(o.budi.me(), o.citra.me()).unwrap().0.accepted, 0);
    assert_eq!(o.citra.tasks(&pid).len(), 1);

    // Her laptop still writes (a modified app) and offers the change.
    let late = forced(&o.citra, &pid, |d, me| {
        let at = clock::now_rfc3339();
        let changes = crate::board::doc::TaskChanges {
            title: Some("Diubah sesudah keluar".into()),
            ..Default::default()
        };
        d.update_task(Stamp { actor: me, at: &at }, &task, &changes, &|_| String::new())
    });
    let late_id = late.record_id();
    let got = pull(o.citra.me(), o.budi.me()).unwrap().0;
    assert_eq!((got.accepted, got.rejected, got.changed), (0, 1, false));
    assert_eq!(o.budi.task(&pid, &task).title, "Logo");
    assert_eq!(o.budi.pending("rights"), 1, "held: membership may still change");
    assert_eq!(o.budi.rejections(), vec!["board_forbidden".to_owned()]);
    assert!(o.budi.f.unknown_ids(std::slice::from_ref(&late_id)).unwrap().is_empty());
    // Not forwarded.
    assert!(!o.budi.f.record_ids_for(&o.sari.pk).unwrap().contains(&late_id));
    pull(o.budi.me(), o.sari.me()).unwrap();
    assert_eq!(o.sari.count("SELECT count(*) FROM board_pending"), 0);
    // A later membership op (retry of held changes) does not let it in.
    o.sari.core(|c| p::create_team(&mut c.db, &c.identity, "Gudang", org_ops::now()).map(|_| ()));
    sync_ops(&[&o.sari, &o.budi]);
    o.budi.f.peer_connected(&o.sari.pk);
    assert_eq!(o.budi.task(&pid, &task).title, "Logo");
    assert_eq!(o.budi.pending("rights"), 1);
    assert_eq!(o.budi.rejections().len(), 1, "logged once");
}

#[test]
fn superadmin_reads_a_project_only_after_joining_it() {
    let o = office_with(false);
    let pid = project(&o, &o.budi, "Peluncuran produk", "PL");
    new_task(&o.budi, &pid, "Logo");
    sync_all(&o.all()).unwrap();
    let ids = o.budi.record_ids(&pid);
    assert!(!o.sari.has_project(&pid));
    for l in [&o.budi, &o.citra] {
        assert!(l.f.record_ids_for(&o.sari.pk).unwrap().is_empty());
        assert!(l.f.records_for(&o.sari.pk, &ids).unwrap().is_empty());
    }

    // Joining the department is not enough (v0.3).
    let (team, sari_pk) = (o.team.clone(), o.sari.pk.clone());
    o.sari.core(|c| p::add_team_member(&mut c.db, &c.identity, &team, &sari_pk, org_ops::now()));
    sync_ops(&o.laps());
    for l in [&o.budi, &o.citra] {
        assert!(l.f.record_ids_for(&o.sari.pk).unwrap().is_empty());
    }
    // She adds herself to the project (recorded in the log).
    o.sari
        .core(|c| p::add_project_member(&mut c.db, &c.identity, &pid, &sari_pk, org_ops::now()));
    sync_ops(&o.laps());
    for l in [&o.budi, &o.citra] {
        let offered: BTreeSet<String> = l.f.record_ids_for(&o.sari.pk).unwrap().into_iter().collect();
        assert_eq!(offered, ids.iter().cloned().collect());
    }
    let got = pull(o.citra.me(), o.sari.me()).unwrap().0;
    assert_eq!(got.accepted, ids.len());
    assert_converged(&o.laps(), &pid, "PL");
}

// ---------------------------------------------------------------------------
// 6. Forged changes.

#[test]
fn forged_changes_are_refused_logged_and_not_asked_again() {
    let o = office();
    let pid = shared_project(&o, &o.budi, "Peluncuran produk", "PL");
    let budi_task = new_task(&o.budi, &pid, "Logo");
    let citra_task = new_task(&o.citra, &pid, "Brosur");
    sync_all(&o.all()).unwrap();
    let other_team = o.sari.core(|c| Ok(org_ops::create_team(&mut c.db, &c.identity, "Gudang")));
    sync_ops(&o.laps());

    // A real offline change by Budi, used for the envelope forgeries.
    retitle(&o.budi, &pid, &budi_task, "Logo final");
    let real = o.budi.core(|c| store::stored_changes(&c.db, &pid)).pop().unwrap();

    let mut bad_sig = real.clone();
    let last = if bad_sig.sig.ends_with('0') { "1" } else { "0" };
    bad_sig.sig.replace_range(127.., last);
    let not_signer = o.citra.core(|c| {
        let mut sc = real.clone();
        sc.author = c.identity.public_key_hex().to_owned();
        sc.sig = hex::encode(c.identity.sign(&signing_message(&pid, &sc.bytes)).to_bytes());
        Ok(sc)
    });
    // Same change, same fields, but not in canonical form (a space).
    let loose = FeatureRecord::new(real.record_body().replacen("{\"v\":1,", "{\"v\": 1,", 1));
    assert_ne!(loose.body, real.record_body());

    // Citra removes Budi's task from the map.
    let drop_key = forge(&o.citra, &o.sari, &pid, |am, _| {
        let tasks = obj(am, &ROOT, "tasks");
        am.delete(&tasks, budi_task.as_str()).unwrap();
    });
    // Citra writes a comment signed with Budi's name.
    let budi_pk = o.budi.pk.clone();
    let as_budi = forge(&o.citra, &o.sari, &pid, |am, _| {
        let tasks = obj(am, &ROOT, "tasks");
        let t = obj(am, &tasks, &citra_task);
        let comments = obj(am, &t, "comments");
        let c = am.put_object(&comments, "ab".repeat(16).as_str(), ObjType::Map).unwrap();
        am.put(&c, "author", budi_pk.as_str()).unwrap();
        am.put(&c, "at", clock::now_rfc3339()).unwrap();
        am.put(&c, "body", "Setuju").unwrap();
    });
    // Budi, admin of Desain, moves the project to another team.
    let move_team = forge(&o.budi, &o.sari, &pid, |am, _| {
        let project = obj(am, &ROOT, "project");
        am.put(&project, "team_id", other_team.as_str()).unwrap();
    });
    // Citra (no admin) marks Budi's task deleted: held, not refused.
    let delete_other = forge(&o.citra, &o.sari, &pid, |am, _| {
        let tasks = obj(am, &ROOT, "tasks");
        let t = obj(am, &tasks, &budi_task);
        am.put(&t, "deleted", true).unwrap();
        am.put(&t, "updated_at", clock::now_rfc3339()).unwrap();
    });

    let refused = vec![
        record(&bad_sig),
        record(&not_signer),
        loose,
        record(&drop_key),
        record(&as_budi),
        record(&move_team),
    ];
    let mut all = refused.clone();
    all.push(record(&delete_other));
    let ids: Vec<String> = all.iter().map(|r| r.id.clone()).collect();
    let heads = o.sari.heads(&pid);
    let tasks = o.sari.tasks(&pid);

    let got = ingest(&o.sari, &o.citra, all.clone());
    assert_eq!(got, FeatureIngest {
        accepted: 0,
        rejected: 7,
        changed: false,
    });
    assert_eq!(o.sari.heads(&pid), heads);
    assert_eq!(o.sari.tasks(&pid), tasks);
    for r in &refused {
        assert!(o.sari.is_refused(&r.id), "{}", r.body);
    }
    assert_eq!(o.sari.pending("rights"), 1);
    let mut codes = o.sari.rejections();
    codes.sort();
    assert_eq!(codes, [
        "board_actor_mismatch",
        "board_bad_format",
        "board_bad_signature",
        "board_forbidden",
        "board_not_allowed",
        "board_not_allowed",
        "board_not_allowed",
    ]);
    assert!(o.sari.f.unknown_ids(&ids).unwrap().is_empty());
    let offered: HashSet<String> = o.sari.f.record_ids_for(&o.citra.pk).unwrap().into_iter().collect();
    assert!(ids.iter().all(|id| !offered.contains(id)));

    // Offered again: nothing new, nothing logged again.
    assert_eq!(ingest(&o.sari, &o.citra, all), FeatureIngest::default());
    assert_eq!(o.sari.rejections().len(), 7);

    // The real changes still get through, including Citra's next change,
    // which has the same sequence number as her forged ones.
    commands::add_comment(&o.citra.state, &NoopSync, &pid, &citra_task, "Asli").unwrap();
    sync_all(&o.all()).unwrap();
    let t = o.sari.task(&pid, &budi_task);
    assert_eq!(t.title, "Logo final");
    assert!(!t.deleted);
    assert_eq!(o.sari.task(&pid, &citra_task).comments.len(), 1);
    assert_eq!(o.sari.heads(&pid), o.budi.heads(&pid));
    assert_eq!(o.sari.heads(&pid), o.citra.heads(&pid));
    assert_eq!(o.sari.project_names(&pid).0, "Peluncuran produk");
    for l in [&o.budi, &o.citra] {
        assert!(l.rejections().is_empty());
    }
}

// ---------------------------------------------------------------------------
// 7. Project name and code.

#[test]
fn rename_by_team_admin_syncs_and_rename_by_member_is_held() {
    let o = office();
    // Sari (superadmin in Desain) creates it; Budi is department admin and
    // a project member, not creator.
    let pid = project(&o, &o.sari, "Peluncuran produk", "PL");
    sync_all(&o.all()).unwrap();
    commands::update_project(&o.budi.state, &NoopSync, &pid, "Peluncuran 2027").unwrap();
    sync_all(&o.all()).unwrap();
    for l in o.laps() {
        assert_eq!(l.project_names(&pid), ("Peluncuran 2027".into(), "PL".into(), "PL".into()));
        let listed = commands::list_projects(&l.state).unwrap();
        assert!(listed.iter().any(|p| p.id == pid && p.name == "Peluncuran 2027"));
        assert!(l.rejections().is_empty());
    }

    // Citra may not manage the project; her app does it anyway.
    assert!(commands::update_project(&o.citra.state, &NoopSync, &pid, "Nama liar").is_err());
    let wild = forced(&o.citra, &pid, |d, _| d.rename_project("Nama liar"));
    let wild_id = wild.record_id();
    let got = pull(o.citra.me(), o.budi.me()).unwrap().0;
    assert_eq!((got.accepted, got.rejected), (0, 1));
    assert_eq!(o.budi.pending("rights"), 1);
    assert_eq!(o.budi.rejections(), vec!["board_forbidden".to_owned()]);
    // Budi does not pass it on.
    assert!(!o.budi.f.record_ids_for(&o.sari.pk).unwrap().contains(&wild_id));
    assert_eq!(pull(o.budi.me(), o.sari.me()).unwrap().0.accepted, 0);
    assert_eq!(o.sari.count("SELECT count(*) FROM board_pending"), 0);

    sync_all(&o.all()).unwrap();
    for l in [&o.sari, &o.budi] {
        assert_eq!(l.project_names(&pid).0, "Peluncuran 2027");
        assert!(!l.record_ids(&pid).contains(&wild_id));
    }
    assert_eq!(o.sari.heads(&pid), o.budi.heads(&pid));
}

#[test]
fn two_projects_with_the_same_code_show_the_same_codes_everywhere() {
    let o = office();
    // Offline, Sari and Budi both create a project with code PA.
    let p1 = project(&o, &o.sari, "Alfa", "PA");
    let p2 = project(&o, &o.budi, "Beta", "PA");
    let t1 = new_task(&o.sari, &p1, "Satu");
    let t2 = new_task(&o.budi, &p2, "Dua");
    sync_all(&o.all()).unwrap();

    let first = o.budi.core(|c| {
        Ok(c.db.query_row(
            "SELECT id FROM board_projects ORDER BY created_at, id LIMIT 1",
            [],
            |r| r.get::<_, String>(0),
        )?)
    });
    let (winner, loser) = if first == p1 { (&p1, &p2) } else { (&p2, &p1) };
    for l in o.laps() {
        assert_eq!(l.project_names(winner).1, "PA");
        assert_eq!(l.project_names(loser).1, "PA2");
        // The documents keep PA.
        assert_eq!(l.project_names(winner).2, "PA");
        assert_eq!(l.project_names(loser).2, "PA");
        let task_of = |pid: &str| if pid == p1 { &t1 } else { &t2 };
        let code_of = |pid: &str| {
            l.index(pid)
                .into_iter()
                .find(|r| r.0 == *task_of(pid))
                .unwrap()
                .1
        };
        assert_eq!(code_of(winner), "PA-1");
        assert_eq!(code_of(loser), "PA2-1");
        assert_index_matches_doc(l, winner, "PA");
        assert_index_matches_doc(l, loser, "PA2");
    }

    // A guest who only sees the second project sees its code as PA.
    let tamu = Lap::new("Klien");
    join(&o.sari, &tamu, &o.team, InviteRole::Guest, vec![loser.clone()]);
    sync_ops(&[&o.sari, &o.budi, &o.citra, &tamu]);
    pull(o.budi.me(), tamu.me()).unwrap();
    assert!(!tamu.has_project(winner));
    assert_eq!(tamu.project_names(loser).1, "PA");
    assert_index_matches_doc(&tamu, loser, "PA");
}

// ---------------------------------------------------------------------------
// Order of arrival against the membership log.

/// A guest of PA becomes a member of Desain. Her first change as a member
/// reaches Budi before the op that made her a member: Budi still sees a
/// guest and refuses the change for good, while Sari (who knows the op)
/// applies it. Budi never asks for it again, so he misses it and everything
/// built on it.
#[test]
fn guest_promoted_to_member_converges_whatever_arrives_first() {
    let o = office();
    let pa = shared_project(&o, &o.budi, "Untuk klien", "PA");
    let tamu = Lap::new("Klien");
    join(&o.sari, &tamu, &o.team, InviteRole::Guest, vec![pa.clone()]);
    sync_ops(&[&o.sari, &o.budi, &o.citra, &tamu]);
    pull(o.budi.me(), tamu.me()).unwrap();
    assert!(tamu.has_project(&pa));

    // Sari makes her a member of Desain; only Sari and her laptop know yet.
    both(&o.sari, &tamu, |s, t| {
        org_ops::accept_more((&mut s.db, &s.identity), &t.identity, &o.team, InviteRole::Member, vec![]);
    });
    sync_ops(&[&o.sari, &tamu]);
    let task = new_task(&tamu, &pa, "Dari klien yang kini anggota");

    // Budi hears of the change first, then of the op.
    let first = tamu.record_ids(&pa).pop().unwrap();
    pull(tamu.me(), o.budi.me()).unwrap();
    let refused_before_op = o.budi.is_refused(&first);
    sync_ops(&[&o.sari, &o.budi, &o.citra, &tamu]);
    o.budi.f.peer_connected(&o.sari.pk);
    // Sari gets it after the op and builds on it.
    pull(tamu.me(), o.sari.me()).unwrap();
    commands::add_comment(&o.sari.state, &NoopSync, &pa, &task, "Selamat bergabung").unwrap();

    let four = [o.sari.me(), o.budi.me(), o.citra.me(), tamu.me()];
    sync_all(&four).unwrap();
    assert_eq!(
        o.budi.heads(&pa),
        o.sari.heads(&pa),
        "Budi misses the change (refused before the op arrived: {refused_before_op}, \
         Sari's comment waiting for it: {})",
        o.budi.pending("deps")
    );
    assert!(o.budi.tasks(&pa).iter().any(|t| t.id == task));
}

/// Citra (a member, modified app) answers Budi's new task with a concurrent
/// change that creates a task under the same id. Each laptop keeps the one
/// it saw first and refuses the other for good, so Sari and Dewi end with
/// different documents, and Dewi refuses Budi's real change.
#[test]
fn concurrent_task_with_the_same_id_does_not_split_the_laptops() {
    let o = office();
    let pid = shared_project(&o, &o.budi, "Peluncuran produk", "PL");
    let dewi = o.member("Dewi");
    o.add_to_project(&pid, &dewi);
    pull(o.budi.me(), dewi.me()).unwrap();
    let x = new_task(&o.budi, &pid, "Asli dari Budi");
    // Built on Citra's copy, which does not have Budi's task.
    let same_id = forge(&o.citra, &o.citra, &pid, |am, me| {
        let tasks = obj(am, &ROOT, "tasks");
        let at = clock::now_rfc3339();
        let t = am.put_object(&tasks, x.as_str(), ObjType::Map).unwrap();
        am.put(&t, "number", 1_i64).unwrap();
        let title = am.put_object(&t, "title", ObjType::Text).unwrap();
        am.splice_text(&title, 0, 0, "Tiruan").unwrap();
        am.put_object(&t, "description", ObjType::Text).unwrap();
        am.put(&t, "column", "todo").unwrap();
        am.put(&t, "rank", "V").unwrap();
        am.put(&t, "assignee", automerge::ScalarValue::Null).unwrap();
        am.put(&t, "due", automerge::ScalarValue::Null).unwrap();
        am.put(&t, "priority", "none").unwrap();
        am.put_object(&t, "labels", ObjType::List).unwrap();
        am.put(&t, "created_by", me).unwrap();
        am.put(&t, "created_at", at.as_str()).unwrap();
        am.put(&t, "updated_at", at.as_str()).unwrap();
        am.put(&t, "deleted", false).unwrap();
        am.put_object(&t, "comments", ObjType::Map).unwrap();
        let log = am.put_object(&t, "activity", ObjType::List).unwrap();
        let e = am.insert_object(&log, 0, ObjType::Map).unwrap();
        am.put(&e, "at", at.as_str()).unwrap();
        am.put(&e, "actor", me).unwrap();
        am.put(&e, "kind", kind::CREATED).unwrap();
        am.put(&e, "detail", "To do").unwrap();
        am.put(&ROOT, "next_number", 2_i64).unwrap();
    });
    let fake = record(&same_id);

    // Sari sees Budi's task first, Dewi sees Citra's first.
    pull(o.budi.me(), o.sari.me()).unwrap();
    ingest(&o.sari, &o.citra, vec![fake.clone()]);
    ingest(&dewi, &o.citra, vec![fake]);
    pull(o.budi.me(), dewi.me()).unwrap();

    let four = [o.sari.me(), o.budi.me(), o.citra.me(), dewi.me()];
    sync_all(&four).unwrap();
    let real = o.budi.record_ids(&pid).pop().unwrap();
    assert_eq!(
        dewi.heads(&pid),
        o.sari.heads(&pid),
        "laptops disagree (Sari refused the copy: {}, Dewi refused Budi's real change: {})",
        o.sari.is_refused(&same_id.record_id()),
        dewi.is_refused(&real)
    );
    assert_eq!(dewi.task(&pid, &x).title, "Asli dari Budi");
}

// ---------------------------------------------------------------------------
// v0.4: subtasks and time entries.

/// A task without `subtasks` and `time`, as made before v0.4, by `l`.
fn old_task(l: &Lap, pid: &str, title: &str) -> String {
    l.core(|c| {
        let me = c.identity.public_key_hex().to_owned();
        let at = clock::now_rfc3339();
        let done = store::commit_local(&mut c.db, &c.identity, pid, |d| {
            let id = d.create_task(Stamp { actor: &me, at: &at }, TaskInit {
                title: title.into(),
                ..TaskInit::default()
            })?;
            let am = d.raw();
            let tasks = obj(am, &ROOT, "tasks");
            let t = obj(am, &tasks, &id);
            am.delete(&t, "subtasks").unwrap();
            am.delete(&t, "time").unwrap();
            Ok(id)
        })?;
        Ok(done.value)
    })
}

fn sorted_titles(t: &TaskData) -> Vec<String> {
    let mut out: Vec<String> = t
        .subtasks
        .iter()
        .filter(|s| !s.deleted)
        .map(|s| s.title.clone())
        .collect();
    out.sort();
    out
}

#[test]
fn subtasks_and_time_made_offline_on_an_old_task_reach_everyone() {
    let o = office();
    let pid = shared_project(&o, &o.budi, "Peluncuran produk", "PL");
    let task = old_task(&o.budi, &pid, "Spanduk");
    sync_all(&o.all()).unwrap();
    assert!(o.citra.task(&pid, &task).subtasks.is_empty());

    // Offline: Citra and Sari both make the first subtask and time entry.
    commands::add_subtask(&o.citra.state, &NoopSync, &pid, &task, "Dari Citra", None).unwrap();
    commands::log_time(&o.citra.state, &NoopSync, &pid, &task, 15.0, Some("desain")).unwrap();
    commands::add_subtask(&o.sari.state, &NoopSync, &pid, &task, "Dari Sari", None).unwrap();
    commands::start_timer(&o.sari.state, &NoopSync, &pid, &task).unwrap();
    sync_all(&o.all()).unwrap();
    assert_converged(&o.laps(), &pid, "PL");
    for l in o.laps() {
        let t = l.task(&pid, &task);
        assert_eq!(sorted_titles(&t), ["Dari Citra", "Dari Sari"]);
        assert_eq!(t.time.len(), 2);
    }

    // Budi ticks both, Citra deletes hers, Sari stops her timer.
    let detail = commands::get_task(&o.budi.state, &pid, &task).unwrap();
    assert_eq!(detail.subtasks.len(), 2);
    for s in &detail.subtasks {
        let patch = crate::board::model::SubtaskPatch {
            done: Some(true),
            ..Default::default()
        };
        commands::update_subtask(&o.budi.state, &NoopSync, &pid, &task, &s.id, patch).unwrap();
    }
    let mine = detail.subtasks.iter().find(|s| s.title == "Dari Citra").unwrap();
    commands::delete_subtask(&o.citra.state, &NoopSync, &pid, &task, &mine.id).unwrap();
    commands::stop_timer(&o.sari.state, &NoopSync, &pid, &task, None).unwrap();
    sync_all(&o.all()).unwrap();
    assert_converged(&o.laps(), &pid, "PL");
    for l in o.laps() {
        let d = commands::get_task(&l.state, &pid, &task).unwrap();
        assert_eq!(d.subtasks.len(), 1);
        assert!(d.subtasks[0].done);
        assert_eq!(d.subtasks[0].done_by.as_ref().unwrap().public_key, o.budi.pk);
        assert_eq!(d.time_entries.len(), 2);
        assert!(d.time_entries.iter().all(|e| e.end.is_some()));
        assert_eq!(d.time_totals.len(), 2);
    }

    // Citra's forged edit of Sari's time entry is refused for good.
    let entry = o.sari.task(&pid, &task).time.into_iter().find(|e| e.by == o.sari.pk).unwrap();
    let task_id = task.clone();
    let forged = forge(&o.citra, &o.sari, &pid, move |am, _| {
        let tasks = obj(am, &ROOT, "tasks");
        let t = obj(am, &tasks, &task_id);
        let e = am
            .get_all(&t, "time")
            .unwrap()
            .into_iter()
            .find_map(|(_, m)| am.get(&m, entry.id.as_str()).unwrap().map(|(_, e)| e))
            .unwrap();
        am.put(&e, "note", "palsu").unwrap();
    });
    let heads = o.budi.heads(&pid);
    let got = ingest(&o.budi, &o.citra, vec![record(&forged)]);
    assert_eq!(got.rejected, 1);
    assert!(o.budi.is_refused(&forged.record_id()));
    assert_eq!(o.budi.heads(&pid), heads);
}

#[test]
fn rejected_records_are_cleared_once_for_the_new_rules() {
    let tmp = tempfile::tempdir().unwrap();
    let conn = crate::db::open(tmp.path()).unwrap();
    let add = |id: &str| {
        conn.execute(
            "INSERT INTO board_rejected (record_id, at) VALUES (?1, 't')",
            [id],
        )
        .unwrap();
    };
    let count = || -> i64 {
        conn.query_row("SELECT count(*) FROM board_rejected", [], |r| r.get(0))
            .unwrap()
    };
    add(&"a".repeat(64));
    add(&"b".repeat(64));
    assert!(reset_rejected_once(&conn).unwrap());
    assert_eq!(count(), 0);
    assert_eq!(
        settings::get(&conn, RULES_VERSION_KEY).unwrap().as_deref(),
        Some("2")
    );
    // Refused again under the new rules: stays refused.
    add(&"c".repeat(64));
    assert!(!reset_rejected_once(&conn).unwrap());
    assert_eq!(count(), 1);
}

#[test]
fn a_record_refused_by_the_old_rules_is_asked_for_again_after_the_update() {
    let o = office();
    let pid = shared_project(&o, &o.budi, "Peluncuran produk", "PL");
    let task = old_task(&o.budi, &pid, "Spanduk");
    sync_all(&o.all()).unwrap();
    // Before the update Citra's laptop refused Sari's first subtask (v0.3
    // rules) and kept waiting on her later changes.
    commands::add_subtask(&o.sari.state, &NoopSync, &pid, &task, "Dari Sari", None).unwrap();
    let first = o.sari.core(|c| store::stored_changes(&c.db, &pid)).last().unwrap().record_id();
    o.citra.core(|c| {
        c.db.execute(
            "INSERT INTO board_rejected (record_id, at) VALUES (?1, 't')",
            [&first],
        )?;
        c.db.execute("DELETE FROM settings WHERE key = ?1", [RULES_VERSION_KEY])?;
        Ok(())
    });
    // Citra's app starts as v0.4: a new board feature on the same data.
    let updated = BoardFeature::new(o.citra.state.clone(), Arc::new(NoopSync));
    assert_eq!(updated.unknown_ids(std::slice::from_ref(&first)).unwrap(), std::slice::from_ref(&first));
    let set = [o.sari.me(), o.budi.me(), (o.citra.pk.as_str(), &updated as &dyn FeatureSync)];
    sync_all(&set).unwrap();
    assert_eq!(sorted_titles(&o.citra.task(&pid, &task)), ["Dari Sari"]);
    assert!(!o.citra.is_refused(&first));
}
