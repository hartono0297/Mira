//! What one change from another laptop is allowed to do, judged from the
//! operations inside it (docs/plans/sinkron-board.md, "Konflik").
//!
//! Every operation is judged against the change's dependencies only, never
//! against the current document, so the outcome is the same on every laptop
//! whatever order changes arrive in and whatever other changes a laptop
//! already holds:
//!
//! - the object an operation touches must exist at the dependencies (each
//!   step of its path, from the root, holds it there); otherwise the change
//!   is refused for good, also on a laptop that happens to hold the change
//!   that made the object;
//! - every predecessor (`pred`) of an operation must be a value of the same
//!   object and key at the dependencies, or an earlier operation of the same
//!   change on that object and key (for a list or text: a value of that
//!   object at the dependencies, or an earlier operation of the change on
//!   it). Automerge removes any operation named as a predecessor, even under
//!   another key or one the change does not depend on, so without this one
//!   put could wipe a task's subtasks or someone's time entry;
//! - the element a list or text operation refers to (inserts after, or
//!   deletes) is in that object at the dependencies or made earlier in the
//!   change, so it can be placed the same way on every laptop;
//! - "already exists" (a task id, a comment, a subtask or time entry id in
//!   any of the conflicting maps, the `comments`/`activity`/`subtasks`/`time`
//!   key of a task) is read at the dependencies.
//!
//! Allowed, per object (A = the change's author):
//!
//! | Object | Allowed |
//! |---|---|
//! | root | put `next_number` (integer up to the number ceiling + 1) |
//! | `project` | put `name` or `code` (needs the manage right) |
//! | `tasks` | make a map at a key missing at the dependencies, without predecessors (a new task, its id bound to A) |
//! | an existing task | put `column`, `assignee`, `due`, `priority`, `updated_at`, `rank` (a valid rank, [`rank::is_valid`]), or delete some but not all of their values (what Automerge writes when a put repeats the winning value of a conflict); put `number` (integer up to the ceiling) when the task is not deleted; put `deleted = true` (needs the delete right); make `title`/`description` text or `labels` list; make `comments`/`activity`/`subtasks`/`time` only when missing at the dependencies, without predecessors |
//! | a new task | once per key: `nonce`, `column`, `priority`, `created_by`, `created_at`, `updated_at` (str), `assignee`, `due` (str or null), `deleted` (bool), `number` (up to the ceiling), `rank` (valid), `title`/`description` (text), `labels`/`activity` (list), `comments`/`subtasks`/`time` (map); delete a value this change wrote (a task shaped like one from before v0.4) |
//! | title, description, labels | insert or delete elements (no nested objects, no second value for an element) |
//! | `comments` of a task | make a map at a key missing at the dependencies (a new comment, its id bound to A) |
//! | a new comment | once per key: `nonce`, `author`, `at`, `body` (str) |
//! | `activity` of a task | insert a new map (a new entry) |
//! | a new activity entry | once per key: `at`, `actor`, `kind`, `detail` (str) |
//! | `subtasks` of a task | make a map at a key missing at the dependencies in every `subtasks` map of the task (a new subtask, created by A, its id bound to A), up to [`MAX_PEER_SUBTASKS`] per task |
//! | a new subtask | once per key: `nonce`, `created_by` (str), `title` (str, up to 200 characters), `done`, `deleted` (bool), `rank` (valid), `assignee` (str or null), `done_by` (A or null), `done_at` (time or null), `created_at` (time) |
//! | an existing subtask | put `title` (str, up to 200 characters), `done` (bool), `rank` (valid), `assignee` (str or null), `done_by` (A or null), `done_at` (time or null), or delete some but not all of their values; put `deleted = true` |
//! | `time` of a task | make a map at a key missing at the dependencies in every `time` map of the task (a new entry, `by` = A, its id bound to A), up to [`MAX_PEER_TIME_ENTRIES`] per task |
//! | a new time entry | once per key: `nonce`, `by` (str), `start` (time), `end` (time not before `start`, or null), `manual`, `deleted` (bool), `note` (str, up to 200 characters) |
//! | an existing time entry whose every `by` is A | put `start` (time), `end` (time, never null again, not before `start`), `note` (str, up to 200 characters), or delete some but not all of their values; put `deleted = true` |
//!
//! "Time" is RFC 3339 of at most [`MAX_TIME_LEN`] characters. "Once per key"
//! means the key never holds two values: a second put to it must name the
//! first as its predecessor. Nothing in a new comment, activity entry,
//! subtask or time entry is deleted.
//!
//! Everything else (deleting a task, comment, subtask or time entry key,
//! replacing `tasks` or `project`, changing `created_by`, `by` or `nonce`,
//! editing someone's comment, an old activity entry or someone else's time
//! entry, bringing a deleted subtask or entry back, unknown keys, marks,
//! counters) is refused for good.
//!
//! A new task, comment, subtask or time entry must sit at the id bound to A
//! and its nonce (`doc::derive_task_id`, `doc::derive_comment_id`,
//! `doc::derive_subtask_id`, `doc::derive_time_id`, checked after applying
//! in [`check_new_authorship`], which reads every value of `created_by`,
//! `by`, `author`, `actor` and `nonce`), so two authors can never create the
//! same key and refusing an existing key gives the same answer on every
//! laptop.
//!
//! Two laptops that both make the `subtasks` or `time` map of an older task
//! offline are judged the same whatever order their changes arrive in. Both
//! maps then stay as a conflict and `doc.rs` reads the contents of both.
//!
//! The number ceiling is [`BoardDoc::fresh_number_at`] the change's
//! dependencies plus [`NUMBER_SLACK`], and "deleted" is read there too, so it
//! is the same on every laptop. Without it one huge number would pin
//! `fresh_number` at its maximum and every new task would share it.
//!
//! [`Needs::touched_tasks`] lists every task the change touches, so the shape
//! check after applying only reads those.
//!
//! Known limits (not checked here):
//! - activity entries are only bound to their author (`actor`); `at`, `kind`
//!   and `detail` are free, so a member can write entries that shift the
//!   time a task spent in each column (`timing.rs`). Nothing reliable to
//!   compare `at` with exists on every laptop;
//! - the author of a subtask or time entry can make the same id (same nonce)
//!   again in a change that does not depend on its first making, at the same
//!   key or in a conflicting `subtasks`/`time` map. Each change alone is
//!   valid, so the reading side has to treat an id as deleted when any copy
//!   of it is;
//! - [`MAX_PEER_SUBTASKS`] and [`MAX_PEER_TIME_ENTRIES`] count live and
//!   deleted entries and are looser than the local limits
//!   (`model::SUBTASKS_MAX`, `model::TIME_ENTRIES_MAX`, live only), so
//!   another laptop can still fill a task up to the local limit;
//! - times are only checked for format, so a member can still log a long
//!   stretch (for example from year 0001) under their own name.
//!
//! The first change of a project (no dependencies) is not judged here;
//! `sync::import_project` validates it.

use std::collections::{BTreeSet, HashMap, HashSet};

use automerge::legacy::{ElementId, Key, ObjectId, Op, OpId, OpType, SortedVec};
use automerge::{
    ActorId, AutoCommit, Change, ChangeHash, ObjId, ObjType, Prop, ReadDoc, ScalarValue, Value,
};

use super::doc::{
    BoardDoc, derive_comment_id, derive_subtask_id, derive_task_id, derive_time_id, is_bound_id,
};
use super::model::{SUBTASK_TITLE_MAX_CHARS, TIME_NOTE_MAX_CHARS};
use super::rank;
use super::timing::parse_time;

/// Most operations in one change from another laptop. A local change with a
/// full description stays far below this.
pub const MAX_CHANGE_OPS: usize = 50_000;

/// How far above the next free number a change may set a task number. One
/// local change renumbers or creates far fewer tasks than this.
pub const NUMBER_SLACK: i64 = 10_000;

/// Most subtasks (live and deleted, every conflicting map) one task may hold
/// after a change from another laptop. Far above the local limit of live
/// subtasks, so honest work is never refused.
pub const MAX_PEER_SUBTASKS: usize = 500;

/// Most time entries (live and deleted) one task may hold after a change
/// from another laptop, like [`MAX_PEER_SUBTASKS`].
pub const MAX_PEER_TIME_ENTRIES: usize = 5_000;

/// Longest time string (RFC 3339) a subtask or time entry may hold.
pub const MAX_TIME_LEN: usize = 40;

/// What a change needs besides the write right.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Needs {
    /// Changes the project's name or code.
    pub manage: bool,
    /// Tasks it marks deleted that existed before: `(task id, created_by)`.
    pub delete: Vec<(String, String)>,
    /// Task maps it creates: `(object id, task id)`, object ids as
    /// `counter@actor`.
    pub new_tasks: Vec<(String, String)>,
    /// Comment maps it creates: `(object id, comment id)`.
    pub new_comments: Vec<(String, String)>,
    /// Activity entries it creates, as object ids.
    pub new_activity: Vec<String>,
    /// Subtask maps it creates: `(object id, subtask id)`.
    pub new_subtasks: Vec<(String, String)>,
    /// Time entry maps it creates: `(object id, entry id)`.
    pub new_time: Vec<(String, String)>,
    /// Id of every task whose map or anything inside it (comments, activity,
    /// subtasks, time entries, new tasks too) an operation touches.
    pub touched_tasks: BTreeSet<String>,
}

impl Needs {
    /// Whether the change creates anything [`check_new_authorship`] checks.
    pub fn creates(&self) -> bool {
        !self.new_tasks.is_empty()
            || !self.new_comments.is_empty()
            || !self.new_activity.is_empty()
            || !self.new_subtasks.is_empty()
            || !self.new_time.is_empty()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Root,
    Project,
    Tasks,
    Task,
    /// Title or description text, labels list.
    Free,
    Comments,
    Comment,
    Activity,
    Entry,
    Subtasks,
    Subtask,
    Times,
    Time,
    Other,
}

/// An object an operation writes into.
#[derive(Debug, Clone)]
struct Target {
    kind: Kind,
    /// Made by this change (so not at its dependencies).
    new: bool,
    /// `(task id, task object id)` of the task it belongs to.
    task: Option<(String, String)>,
}

impl Target {
    fn plain(kind: Kind) -> Target {
        Target {
            kind,
            new: false,
            task: None,
        }
    }

    /// A child made by this change in the same task.
    fn child(&self, kind: Kind) -> Target {
        Target {
            kind,
            new: true,
            task: self.task.clone(),
        }
    }
}

fn obj_key(counter: u64, actor: &ActorId) -> String {
    format!("{counter}@{}", actor.to_hex_string())
}

fn op_key(id: &OpId) -> String {
    obj_key(id.0, &id.1)
}

fn obj_str(obj: &ObjectId) -> String {
    match obj {
        ObjectId::Root => "_root".to_owned(),
        ObjectId::Id(id) => op_key(id),
    }
}

fn map_key(p: &Prop) -> Option<&str> {
    match p {
        Prop::Map(s) => Some(s.as_str()),
        Prop::Seq(_) => None,
    }
}

fn no<T>(what: impl Into<String>) -> Result<T, String> {
    Err(what.into())
}

fn int_of(v: &ScalarValue) -> Option<i64> {
    match v {
        ScalarValue::Int(n) => Some(*n),
        ScalarValue::Uint(n) => i64::try_from(*n).ok(),
        _ => None,
    }
}

/// RFC 3339 and not too long.
fn time_ok(s: &str) -> bool {
    s.len() <= MAX_TIME_LEN && parse_time(s).is_some()
}

/// `end` is before `start` (both parse).
fn ends_before_start(start: &str, end: &str) -> bool {
    matches!((parse_time(start), parse_time(end)), (Some(s), Some(e)) if e < s)
}

fn short_str(s: &str, max_chars: usize) -> bool {
    s.chars().count() <= max_chars
}

/// The document as it was at a change's dependencies, read through Automerge
/// `*_at` with results cached for the change.
struct AtDeps<'a> {
    am: &'a AutoCommit,
    deps: &'a [ChangeHash],
    values: HashMap<(String, String), Vec<(Value<'a>, String)>>,
    seq_ids: HashMap<String, HashSet<String>>,
}

impl<'a> AtDeps<'a> {
    fn new(am: &'a AutoCommit, deps: &'a [ChangeHash]) -> Self {
        AtDeps {
            am,
            deps,
            values: HashMap::new(),
            seq_ids: HashMap::new(),
        }
    }

    /// Every value of `key` in `obj` with the id of the operation that wrote
    /// it.
    fn values(&mut self, obj: &str, key: &str) -> &[(Value<'a>, String)] {
        let (am, deps) = (self.am, self.deps);
        self.values
            .entry((obj.to_owned(), key.to_owned()))
            .or_insert_with(|| {
                let Ok(o) = am.import_obj(obj) else {
                    return Vec::new();
                };
                am.get_all_at(&o, key, deps)
                    .map(|v| v.into_iter().map(|(v, id)| (v, id.to_string())).collect())
                    .unwrap_or_default()
            })
    }

    fn has(&mut self, obj: &str, key: &str, id: &str) -> bool {
        self.values(obj, key).iter().any(|(_, i)| i == id)
    }

    fn present(&mut self, obj: &str, key: &str) -> bool {
        !self.values(obj, key).is_empty()
    }

    fn ids(&mut self, obj: &str, key: &str) -> Vec<String> {
        self.values(obj, key).iter().map(|(_, i)| i.clone()).collect()
    }

    /// Every value of `key` as a string (`None` for anything else).
    fn strs(&mut self, obj: &str, key: &str) -> Vec<Option<String>> {
        self.values(obj, key)
            .iter()
            .map(|(v, _)| v.as_str().map(str::to_owned))
            .collect()
    }

    /// The winning value of `key`.
    fn winner(&self, obj: &str, key: &str) -> Option<Value<'a>> {
        let o = self.am.import_obj(obj).ok()?;
        self.am.get_at(&o, key, self.deps).ok().flatten().map(|(v, _)| v)
    }

    fn winner_str(&self, obj: &str, key: &str) -> Option<String> {
        self.winner(obj, key)
            .and_then(|v| v.as_str().map(str::to_owned))
    }

    /// Ids of the maps at `key` of `obj` (every conflicting value).
    fn maps(&mut self, obj: &str, key: &str) -> Vec<String> {
        self.values(obj, key)
            .iter()
            .filter(|(v, _)| matches!(v, Value::Object(ObjType::Map)))
            .map(|(_, i)| i.clone())
            .collect()
    }

    /// Keys of every map at `part` of the task `task_obj`.
    fn entry_count(&mut self, task_obj: &str, part: &str) -> usize {
        let maps = self.maps(task_obj, part);
        maps.iter()
            .filter_map(|m| self.am.import_obj(m).ok())
            .map(|m| self.am.keys_at(&m, self.deps).count())
            .sum()
    }

    /// Ids of the values of the list or text `obj` (every conflicting value
    /// of an element too).
    fn seq_has(&mut self, obj: &str, id: &str) -> bool {
        let (am, deps) = (self.am, self.deps);
        self.seq_ids
            .entry(obj.to_owned())
            .or_insert_with(|| {
                let mut out = HashSet::new();
                let Ok(o) = am.import_obj(obj) else {
                    return out;
                };
                for item in am.list_range_at(&o, .., deps) {
                    out.insert(item.id().to_string());
                    if item.conflict {
                        for (_, i) in am.get_all_at(&o, item.index, deps).unwrap_or_default() {
                            out.insert(i.to_string());
                        }
                    }
                }
                out
            })
            .contains(id)
    }
}

const NOT_AT_DEPS: &str = "mengubah objek yang tidak ada pada perubahan yang menjadi dasarnya";

struct Judge<'a> {
    before: &'a BoardDoc,
    at: AtDeps<'a>,
    author: String,
    needs: Needs,
    /// Objects this change makes.
    made: HashMap<String, Target>,
    /// Objects of the dependencies already classified.
    known: HashMap<String, Target>,
    /// Operations of this change so far, per (object, map key).
    map_ops: HashMap<(String, String), Vec<String>>,
    /// Operations of this change so far, per list or text object.
    seq_ops: HashMap<String, HashSet<String>>,
    /// Last string this change put, per (object, key).
    put_strs: HashMap<(String, String), String>,
    /// Subtasks or time entries per (task object, part): at the
    /// dependencies plus those this change makes.
    counts: HashMap<(String, &'static str), usize>,
    ceiling: Option<i64>,
}

/// Judges every operation of `change` against `before` (a document that
/// holds all of the change's dependencies, before applying it). `Ok` lists
/// the rights still to check; `Err` is the reason it is refused for good.
pub fn judge(before: &BoardDoc, change: &Change) -> Result<Needs, String> {
    if change.len() > MAX_CHANGE_OPS {
        return no(format!(
            "perubahan berisi {} operasi, lebih dari batas {MAX_CHANGE_OPS}",
            change.len()
        ));
    }
    let expanded = change.decode();
    let actor = expanded.actor_id.clone();
    let start = expanded.start_op.get();
    let deps: Vec<ChangeHash> = change.deps().to_vec();
    let mut j = Judge {
        before,
        at: AtDeps::new(before.automerge(), &deps),
        author: actor.to_hex_string(),
        needs: Needs::default(),
        made: HashMap::new(),
        known: HashMap::new(),
        map_ops: HashMap::new(),
        seq_ops: HashMap::new(),
        put_strs: HashMap::new(),
        counts: HashMap::new(),
        ceiling: None,
    };
    for (i, op) in expanded.operations.iter().enumerate() {
        let this = obj_key(start + i as u64, &actor);
        j.op(&this, op)?;
    }
    Ok(j.needs)
}

impl Judge<'_> {
    fn op(&mut self, this: &str, op: &Op) -> Result<(), String> {
        let obj = obj_str(&op.obj);
        let target = self.target(&obj)?;
        if let Some((id, _)) = &target.task {
            self.needs.touched_tasks.insert(id.clone());
        }
        if matches!(
            op.action,
            OpType::Increment(_) | OpType::MarkBegin(..) | OpType::MarkEnd(_)
        ) {
            return no("penanda teks atau penghitung tidak dipakai board");
        }
        self.check_pred(&obj, &target, op)?;
        let child = self.child(this, &obj, &target, op)?;
        match &op.key {
            Key::Map(k) => {
                let at = (obj.clone(), k.to_string());
                if let OpType::Put(ScalarValue::Str(s)) = &op.action {
                    self.put_strs.insert(at.clone(), s.to_string());
                }
                self.map_ops.entry(at).or_default().push(this.to_owned());
            }
            Key::Seq(_) => {
                self.seq_ops.entry(obj).or_default().insert(this.to_owned());
            }
        }
        if let Some(c) = child {
            self.made.insert(this.to_owned(), c);
        }
        Ok(())
    }

    /// The object `obj` writes into: made earlier in this change, or present
    /// at the dependencies.
    fn target(&mut self, obj: &str) -> Result<Target, String> {
        if obj == "_root" {
            return Ok(Target::plain(Kind::Root));
        }
        if let Some(t) = self.made.get(obj) {
            return Ok(t.clone());
        }
        if let Some(t) = self.known.get(obj) {
            return Ok(t.clone());
        }
        let t = self.existing(obj)?;
        self.known.insert(obj.to_owned(), t.clone());
        Ok(t)
    }

    /// Kind of an object that every step of its path holds at the
    /// dependencies, from that path. `Err` when it is not there.
    fn existing(&mut self, obj: &str) -> Result<Target, String> {
        let am = self.at.am;
        let id = am.import_obj(obj).map_err(|_| NOT_AT_DEPS.to_owned())?;
        let parents = am.parents(&id).map_err(|_| NOT_AT_DEPS.to_owned())?;
        let path: Vec<(ObjId, Prop)> = parents.path();
        for (i, (parent, prop)) in path.iter().enumerate() {
            let child = path.get(i + 1).map_or_else(|| obj.to_owned(), |(o, _)| o.to_string());
            let parent = parent.to_string();
            let there = match prop {
                Prop::Map(k) => self.at.has(&parent, k, &child),
                Prop::Seq(_) => self.at.seq_has(&parent, &child),
            };
            if !there {
                return no(NOT_AT_DEPS);
            }
        }
        let m = map_key;
        let task = |i: usize| -> Option<(String, String)> {
            let id = m(&path.get(1)?.1)?.to_owned();
            let obj = path.get(i).map_or_else(|| obj.to_owned(), |(o, _)| o.to_string());
            Some((id, obj))
        };
        let props: Vec<&Prop> = path.iter().map(|(_, p)| p).collect();
        let (kind, task) = match props.as_slice() {
            [p] if m(p) == Some("project") => (Kind::Project, None),
            [p] if m(p) == Some("tasks") => (Kind::Tasks, None),
            [t, Prop::Map(_)] if m(t) == Some("tasks") => (Kind::Task, task(2)),
            [t, Prop::Map(_), f] if m(t) == Some("tasks") => {
                let kind = match m(f) {
                    Some("title" | "description" | "labels") => Kind::Free,
                    Some("comments") => Kind::Comments,
                    Some("activity") => Kind::Activity,
                    Some("subtasks") => Kind::Subtasks,
                    Some("time") => Kind::Times,
                    _ => Kind::Other,
                };
                (kind, task(2))
            }
            [t, Prop::Map(_), f, _] if m(t) == Some("tasks") => {
                let kind = match m(f) {
                    Some("comments") => Kind::Comment,
                    Some("activity") => Kind::Entry,
                    Some("subtasks") => Kind::Subtask,
                    Some("time") => Kind::Time,
                    _ => Kind::Other,
                };
                (kind, task(2))
            }
            _ => (Kind::Other, None),
        };
        Ok(Target {
            kind,
            new: false,
            task,
        })
    }

    /// Every predecessor is a value of the same object and key at the
    /// dependencies, or an earlier operation of this change there. The
    /// element a list or text operation refers to (inserts after it, or
    /// deletes it) is one too: Automerge cannot place it on a laptop that
    /// lacks it, so the laptops that hold it would differ from the rest.
    fn check_pred(&mut self, obj: &str, target: &Target, op: &Op) -> Result<(), String> {
        if let Key::Seq(ElementId::Id(e)) = &op.key {
            let e = op_key(e);
            let ok = self.seq_ops.get(obj).is_some_and(|s| s.contains(&e))
                || (!target.new && self.at.seq_has(obj, &e));
            if !ok {
                return no(
                    "operasi merujuk elemen yang tidak ada pada perubahan yang menjadi dasarnya",
                );
            }
        }
        if op.pred.is_empty() {
            return Ok(());
        }
        match &op.key {
            Key::Map(k) => {
                let earlier = self.map_ops.get(&(obj.to_owned(), k.to_string()));
                for p in op.pred.iter() {
                    let p = op_key(p);
                    let ok = earlier.is_some_and(|e| e.contains(&p))
                        || (!target.new && self.at.has(obj, k, &p));
                    if !ok {
                        return no(format!(
                            "operasi di {k} menimpa nilai yang tidak ada di kunci itu pada perubahan yang menjadi dasarnya"
                        ));
                    }
                }
            }
            Key::Seq(_) => {
                if op.insert {
                    return no("sisipan di daftar atau teks tidak boleh menimpa nilai lain");
                }
                for p in op.pred.iter() {
                    let p = op_key(p);
                    let ok = self.seq_ops.get(obj).is_some_and(|e| e.contains(&p))
                        || (!target.new && self.at.seq_has(obj, &p));
                    if !ok {
                        return no(
                            "operasi menimpa elemen yang tidak ada pada perubahan yang menjadi dasarnya",
                        );
                    }
                }
            }
        }
        Ok(())
    }

    /// Nothing written at `key` of `obj` before: no predecessors, no
    /// earlier operation of this change there.
    fn fresh(&self, obj: &str, key: &str, op: &Op) -> bool {
        op.pred.is_empty() && !self.map_ops.contains_key(&(obj.to_owned(), key.to_owned()))
    }

    /// `key` of a new object keeps exactly one value: the first write has no
    /// predecessors, a later one replaces the last.
    fn single(&self, obj: &str, key: &str, op: &Op) -> bool {
        let last = self
            .map_ops
            .get(&(obj.to_owned(), key.to_owned()))
            .and_then(|e| e.last());
        match last {
            None => op.pred.is_empty(),
            Some(l) => op.pred.len() == 1 && op.pred.iter().all(|p| op_key(p) == *l),
        }
    }

    fn number_ok(&mut self, v: &ScalarValue, extra: i64) -> bool {
        let max = *self.ceiling.get_or_insert_with(|| {
            self.before
                .fresh_number_at(self.at.deps)
                .saturating_add(NUMBER_SLACK)
        });
        int_of(v).is_some_and(|n| (1..=max.saturating_add(extra)).contains(&n))
    }

    /// Whether a delete of `key` in `obj` with predecessors `pred` removes
    /// only some of the values `key` held at the dependencies, so at least
    /// one stays. A local put that repeats the winning value of a conflicted
    /// key is written by Automerge as such a delete of the losing values.
    fn drops_only_losers(&mut self, obj: &str, key: &str, pred: &SortedVec<OpId>) -> bool {
        let ids = self.at.ids(obj, key);
        !pred.is_empty() && pred.len() < ids.len() && pred.iter().all(|p| ids.contains(&op_key(p)))
    }

    /// Counts one more subtask or time entry of the task, refused past
    /// `max`.
    fn count_one(&mut self, target: &Target, part: &'static str, max: usize) -> Result<(), String> {
        let task_obj = target.task.as_ref().map(|(_, o)| o.clone()).unwrap_or_default();
        let at_deps = match self.counts.get(&(task_obj.clone(), part)) {
            Some(n) => *n,
            None => self.at.entry_count(&task_obj, part),
        };
        let n = at_deps + 1;
        if n > max {
            return no(format!("satu task paling banyak punya {max} isian {part} dari laptop lain"));
        }
        self.counts.insert((task_obj, part), n);
        Ok(())
    }

    /// The string `key` of `obj` holds after the operations so far: put by
    /// this change, or the winning value at the dependencies.
    fn str_now(&self, obj: &str, key: &str, new: bool) -> Option<String> {
        match self.put_strs.get(&(obj.to_owned(), key.to_owned())) {
            Some(s) => Some(s.clone()),
            None if !new => self.at.winner_str(obj, key),
            None => None,
        }
    }

    /// Checks `op` on `target`; returns the object it makes, if any.
    fn child(&mut self, this: &str, obj: &str, t: &Target, op: &Op) -> Result<Option<Target>, String> {
        let key = match &op.key {
            Key::Map(s) => Some(s.as_str()),
            Key::Seq(_) => None,
        };
        let task_id = t.task.as_ref().map(|(id, _)| id.clone()).unwrap_or_default();
        match t.kind {
            Kind::Root => match (&op.action, key) {
                (OpType::Put(v), Some("next_number")) => {
                    if !self.number_ok(v, 1) {
                        return no("nomor task berikutnya di luar batas");
                    }
                    Ok(None)
                }
                (_, k) => no(format!("mengubah struktur utama dokumen ({})", k.unwrap_or("?"))),
            },

            Kind::Project => match (&op.action, key) {
                (OpType::Put(ScalarValue::Str(_)), Some("name" | "code")) => {
                    self.needs.manage = true;
                    Ok(None)
                }
                (_, k) => no(format!("mengubah data proyek ({})", k.unwrap_or("?"))),
            },

            Kind::Tasks => match (&op.action, key) {
                (OpType::Make(ObjType::Map), Some(id)) => {
                    // Ids are bound to their creator, so this only meets an
                    // earlier task by the same author.
                    if !self.fresh(obj, id, op) || self.at.present(obj, id) {
                        return no(format!("menimpa task {id}"));
                    }
                    self.needs.new_tasks.push((this.to_owned(), id.to_owned()));
                    self.needs.touched_tasks.insert(id.to_owned());
                    Ok(Some(Target {
                        kind: Kind::Task,
                        new: true,
                        task: Some((id.to_owned(), this.to_owned())),
                    }))
                }
                _ => no("menghapus atau menimpa daftar task"),
            },

            Kind::Task if t.new => {
                let Some(k) = key else {
                    return no("operasi tidak dikenal di task baru");
                };
                if !self.single(obj, k, op) {
                    return no(format!("isian {k} task baru ditulis lebih dari satu nilai"));
                }
                match (k, &op.action) {
                    // Takes back the one value this change wrote (a task
                    // shaped like one from before v0.4, in tests and tools).
                    (_, OpType::Delete) if !op.pred.is_empty() => Ok(None),
                    ("number", OpType::Put(v)) => {
                        if !self.number_ok(v, 0) {
                            return no(format!("nomor task {task_id} di luar batas"));
                        }
                        Ok(None)
                    }
                    ("rank", OpType::Put(ScalarValue::Str(r))) if rank::is_valid(r) => Ok(None),
                    (
                        "nonce" | "column" | "priority" | "created_by" | "created_at" | "updated_at",
                        OpType::Put(ScalarValue::Str(_)),
                    )
                    | ("assignee" | "due", OpType::Put(ScalarValue::Str(_) | ScalarValue::Null))
                    | ("deleted", OpType::Put(ScalarValue::Boolean(_))) => Ok(None),
                    ("title" | "description", OpType::Make(ObjType::Text))
                    | ("labels", OpType::Make(ObjType::List)) => Ok(Some(t.child(Kind::Free))),
                    ("comments", OpType::Make(ObjType::Map)) => Ok(Some(t.child(Kind::Comments))),
                    ("activity", OpType::Make(ObjType::List)) => Ok(Some(t.child(Kind::Activity))),
                    ("subtasks", OpType::Make(ObjType::Map)) => Ok(Some(t.child(Kind::Subtasks))),
                    ("time", OpType::Make(ObjType::Map)) => Ok(Some(t.child(Kind::Times))),
                    _ => no(format!("isian {k} task baru tidak dikenal atau jenisnya salah")),
                }
            }
            Kind::Task => {
                let id = task_id;
                let Some(k) = key else {
                    return no(format!("operasi tidak dikenal di task {id}"));
                };
                match (k, &op.action) {
                    ("column" | "assignee" | "due" | "priority" | "updated_at", OpType::Put(_)) => {
                        Ok(None)
                    }
                    ("rank", OpType::Put(ScalarValue::Str(r))) if rank::is_valid(r) => Ok(None),
                    ("rank", OpType::Put(_)) => no(format!("rank task {id} tidak valid")),
                    ("column" | "rank" | "assignee" | "due" | "priority" | "updated_at", OpType::Delete)
                        if self.drops_only_losers(obj, k, &op.pred) =>
                    {
                        Ok(None)
                    }
                    ("number", OpType::Put(v)) => {
                        let deleted = self
                            .at
                            .winner(obj, "deleted")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        if deleted {
                            return no(format!("mengubah nomor task {id} yang sudah dihapus"));
                        }
                        if !self.number_ok(v, 0) {
                            return no(format!("nomor task {id} di luar batas"));
                        }
                        Ok(None)
                    }
                    ("deleted", OpType::Put(ScalarValue::Boolean(true))) => {
                        let created_by = self.at.winner_str(obj, "created_by").unwrap_or_default();
                        if !self.needs.delete.iter().any(|(t, _)| *t == id) {
                            self.needs.delete.push((id, created_by));
                        }
                        Ok(None)
                    }
                    ("title" | "description", OpType::Make(ObjType::Text))
                    | ("labels", OpType::Make(ObjType::List)) => Ok(Some(t.child(Kind::Free))),
                    ("comments" | "activity" | "subtasks" | "time", OpType::Make(ty)) => {
                        if !self.fresh(obj, k, op) || self.at.present(obj, k) {
                            return no(format!("mengganti {k} task {id}"));
                        }
                        match (k, ty) {
                            ("comments", ObjType::Map) => Ok(Some(t.child(Kind::Comments))),
                            ("activity", ObjType::List) => Ok(Some(t.child(Kind::Activity))),
                            ("subtasks", ObjType::Map) => Ok(Some(t.child(Kind::Subtasks))),
                            ("time", ObjType::Map) => Ok(Some(t.child(Kind::Times))),
                            _ => no(format!("jenis {k} task {id} salah")),
                        }
                    }
                    _ => no(format!("mengubah {k} task {id}")),
                }
            }

            // Text and lists are only spliced: an element never gets a
            // second value, so the element id is the id of its value.
            Kind::Free => match (&op.key, &op.action) {
                (Key::Seq(_), OpType::Put(_)) if op.insert => Ok(None),
                (Key::Seq(_), OpType::Delete) => Ok(None),
                (Key::Seq(_), OpType::Put(_)) => no("mengganti elemen judul, deskripsi, atau label"),
                (Key::Seq(_), OpType::Make(_)) => no("objek di dalam judul, deskripsi, atau label"),
                _ => no("operasi tidak dikenal di judul, deskripsi, atau label"),
            },

            Kind::Comments => match (&op.action, key) {
                (OpType::Make(ObjType::Map), Some(cid)) => {
                    if !self.fresh(obj, cid, op) || (!t.new && self.at.present(obj, cid)) {
                        return no("menimpa komentar yang sudah ada");
                    }
                    self.needs.new_comments.push((this.to_owned(), cid.to_owned()));
                    Ok(Some(t.child(Kind::Comment)))
                }
                _ => no("menghapus atau menimpa komentar"),
            },
            Kind::Comment if t.new => {
                self.new_fields(obj, op, "komentar", |k, v| {
                    matches!((k, v), ("nonce" | "author" | "at" | "body", ScalarValue::Str(_)))
                })?;
                Ok(None)
            }
            Kind::Comment => no("mengubah komentar yang sudah ada"),

            Kind::Activity => match (&op.key, &op.action) {
                (Key::Seq(_), OpType::Make(ObjType::Map)) if op.insert => {
                    self.needs.new_activity.push(this.to_owned());
                    Ok(Some(t.child(Kind::Entry)))
                }
                _ => no("menghapus atau mengubah riwayat aktivitas"),
            },
            Kind::Entry if t.new => {
                self.new_fields(obj, op, "riwayat aktivitas", |k, v| {
                    matches!((k, v), ("at" | "actor" | "kind" | "detail", ScalarValue::Str(_)))
                })?;
                Ok(None)
            }
            Kind::Entry => no("mengubah riwayat aktivitas lama"),

            Kind::Subtasks => match (&op.action, key) {
                (OpType::Make(ObjType::Map), Some(sid)) => {
                    if !self.fresh(obj, sid, op) || self.in_any_map(t, "subtasks", sid) {
                        return no("menimpa subtask yang sudah ada");
                    }
                    self.count_one(t, "subtasks", MAX_PEER_SUBTASKS)?;
                    self.needs.new_subtasks.push((this.to_owned(), sid.to_owned()));
                    Ok(Some(t.child(Kind::Subtask)))
                }
                _ => no("menghapus atau menimpa subtask"),
            },
            Kind::Subtask if t.new => {
                let author = self.author.clone();
                self.new_fields(obj, op, "subtask", |k, v| match (k, v) {
                    ("nonce" | "created_by", ScalarValue::Str(_))
                    | ("done" | "deleted", ScalarValue::Boolean(_))
                    | ("assignee" | "done_by" | "done_at", ScalarValue::Null) => true,
                    ("title", ScalarValue::Str(s)) => short_str(s, SUBTASK_TITLE_MAX_CHARS),
                    ("rank", ScalarValue::Str(r)) => rank::is_valid(r),
                    ("assignee", ScalarValue::Str(_)) => true,
                    ("done_by", ScalarValue::Str(s)) => **s == *author,
                    ("done_at" | "created_at", ScalarValue::Str(s)) => time_ok(s),
                    _ => false,
                })?;
                Ok(None)
            }
            Kind::Subtask => {
                let Some(k) = key else {
                    return no("operasi tidak dikenal di subtask");
                };
                let ok = match (k, &op.action) {
                    ("title", OpType::Put(ScalarValue::Str(s))) => short_str(s, SUBTASK_TITLE_MAX_CHARS),
                    ("rank", OpType::Put(ScalarValue::Str(r))) => rank::is_valid(r),
                    ("done", OpType::Put(ScalarValue::Boolean(_)))
                    | ("assignee", OpType::Put(ScalarValue::Str(_) | ScalarValue::Null))
                    | ("done_by" | "done_at", OpType::Put(ScalarValue::Null))
                    | ("deleted", OpType::Put(ScalarValue::Boolean(true))) => true,
                    ("done_by", OpType::Put(ScalarValue::Str(s))) => **s == *self.author,
                    ("done_at", OpType::Put(ScalarValue::Str(s))) => time_ok(s),
                    ("title" | "rank" | "done" | "assignee" | "done_by" | "done_at", OpType::Delete) => {
                        self.drops_only_losers(obj, k, &op.pred)
                    }
                    _ => false,
                };
                if !ok {
                    return no(format!("mengubah {k} subtask"));
                }
                Ok(None)
            }

            Kind::Times => match (&op.action, key) {
                (OpType::Make(ObjType::Map), Some(eid)) => {
                    if !self.fresh(obj, eid, op) || self.in_any_map(t, "time", eid) {
                        return no("menimpa catatan waktu yang sudah ada");
                    }
                    self.count_one(t, "time", MAX_PEER_TIME_ENTRIES)?;
                    self.needs.new_time.push((this.to_owned(), eid.to_owned()));
                    Ok(Some(t.child(Kind::Time)))
                }
                _ => no("menghapus atau menimpa catatan waktu"),
            },
            Kind::Time if t.new => {
                self.new_fields(obj, op, "catatan waktu", |k, v| match (k, v) {
                    ("nonce" | "by", ScalarValue::Str(_))
                    | ("end", ScalarValue::Null)
                    | ("manual" | "deleted", ScalarValue::Boolean(_)) => true,
                    ("start" | "end", ScalarValue::Str(s)) => time_ok(s),
                    ("note", ScalarValue::Str(s)) => short_str(s, TIME_NOTE_MAX_CHARS),
                    _ => false,
                })?;
                self.check_span(obj, op, true)?;
                Ok(None)
            }
            Kind::Time => {
                let by = self.at.strs(obj, "by");
                if by.is_empty() || by.iter().any(|b| b.as_deref() != Some(self.author.as_str())) {
                    return no("mengubah catatan waktu orang lain");
                }
                let ok = match (key, &op.action) {
                    (Some("start" | "end"), OpType::Put(ScalarValue::Str(s))) => time_ok(s),
                    (Some("note"), OpType::Put(ScalarValue::Str(s))) => short_str(s, TIME_NOTE_MAX_CHARS),
                    (Some("deleted"), OpType::Put(ScalarValue::Boolean(true))) => true,
                    (Some(k @ ("start" | "end" | "note")), OpType::Delete) => {
                        self.drops_only_losers(obj, k, &op.pred)
                    }
                    _ => false,
                };
                if !ok {
                    return no(format!("mengubah {} catatan waktu", key.unwrap_or("?")));
                }
                self.check_span(obj, op, false)?;
                Ok(None)
            }

            Kind::Other => no("mengubah bagian dokumen yang tidak dikenal"),
        }
    }

    /// A put into an object this change made: a known key with a value
    /// `ok` accepts, keeping one value.
    fn new_fields(
        &self,
        obj: &str,
        op: &Op,
        what: &str,
        ok: impl Fn(&str, &ScalarValue) -> bool,
    ) -> Result<(), String> {
        let Key::Map(k) = &op.key else {
            return no(format!("operasi tidak dikenal di {what} baru"));
        };
        let fine = match &op.action {
            OpType::Put(v) => ok(k, v),
            _ => false,
        };
        if !fine {
            return no(format!("isian {k} {what} baru tidak dikenal atau nilainya salah"));
        }
        if !self.single(obj, k, op) {
            return no(format!("isian {k} {what} baru ditulis lebih dari satu nilai"));
        }
        Ok(())
    }

    /// `end` of a time entry is not before its `start` once the change has
    /// put one of them.
    fn check_span(&self, obj: &str, op: &Op, new: bool) -> Result<(), String> {
        let (Key::Map(k), OpType::Put(ScalarValue::Str(v))) = (&op.key, &op.action) else {
            return Ok(());
        };
        let bad = match k.as_str() {
            "start" => self
                .str_now(obj, "end", new)
                .is_some_and(|end| ends_before_start(v, &end)),
            "end" => self
                .str_now(obj, "start", new)
                .is_some_and(|start| ends_before_start(&start, v)),
            _ => false,
        };
        if bad {
            return no("catatan waktu berakhir sebelum mulai");
        }
        Ok(())
    }

    /// Whether `id` is a key of any `part` map of the task at the
    /// dependencies.
    fn in_any_map(&mut self, t: &Target, part: &str, id: &str) -> bool {
        let Some((_, task_obj)) = &t.task else {
            return false;
        };
        self.at
            .maps(task_obj, part)
            .iter()
            .any(|m| self.at.present(m, id))
    }
}

/// After applying: every task and subtask the change created names
/// `author` (64 hex) as its creator, every comment, activity entry and time
/// entry names it as author, and each new task, comment, subtask and time
/// entry sits at the id bound to `author` and its nonce. Every value of a
/// conflicted field is read, not only the winning one.
pub fn check_new_authorship(after: &BoardDoc, needs: &Needs, author: &str) -> Result<(), String> {
    let am = after.automerge();
    let values = |key: &str, name: &str| -> Vec<Option<String>> {
        let Ok(obj) = am.import_obj(key) else {
            return Vec::new();
        };
        am.get_all(&obj, name)
            .unwrap_or_default()
            .into_iter()
            .map(|(v, _)| v.as_str().map(str::to_owned))
            .collect()
    };
    let by_author = |key: &str, name: &str| -> bool {
        let v = values(key, name);
        !v.is_empty() && v.iter().all(|x| x.as_deref() == Some(author))
    };
    let bound = |derive: fn(&str, &str) -> String, id: &str, key: &str| -> bool {
        let v = values(key, "nonce");
        !v.is_empty() && v.iter().all(|n| is_bound_id(derive, id, author, n.as_deref()))
    };
    for (obj, id) in &needs.new_tasks {
        if !by_author(obj, "created_by") {
            return Err("task baru dibuat atas nama orang lain".into());
        }
        if !bound(derive_task_id, id, obj) {
            return Err(format!("kode task baru {id} tidak cocok dengan pembuatnya"));
        }
    }
    for (obj, id) in &needs.new_comments {
        if !by_author(obj, "author") {
            return Err("komentar baru dibuat atas nama orang lain".into());
        }
        if !bound(derive_comment_id, id, obj) {
            return Err("kode komentar baru tidak cocok dengan penulisnya".into());
        }
    }
    for e in &needs.new_activity {
        if !by_author(e, "actor") {
            return Err("riwayat aktivitas baru dibuat atas nama orang lain".into());
        }
    }
    for (obj, id) in &needs.new_subtasks {
        if !by_author(obj, "created_by") {
            return Err("subtask baru dibuat atas nama orang lain".into());
        }
        if !bound(derive_subtask_id, id, obj) {
            return Err("kode subtask baru tidak cocok dengan pembuatnya".into());
        }
    }
    for (obj, id) in &needs.new_time {
        if !by_author(obj, "by") {
            return Err("catatan waktu baru dibuat atas nama orang lain".into());
        }
        if !bound(derive_time_id, id, obj) {
            return Err("kode catatan waktu baru tidak cocok dengan pemiliknya".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
