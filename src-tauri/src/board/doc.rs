//! The Automerge document of one project and the mutations on it.
//!
//! Shape (docs/plans/tahap-3-lokal.md, "Bentuk dokumen Automerge"):
//!
//! ```text
//! ROOT
//!   v: 1
//!   project: { id, code, name, team_id (str or null) }
//!   next_number: int
//!   tasks: Map<task_id> {
//!     nonce, number, title: Text, description: Text, column, rank,
//!     assignee (str or null), due (str or null), priority, labels: List<str>,
//!     created_by, created_at, updated_at, deleted,
//!     comments: Map<comment_id> { nonce, author, at, body },
//!     activity: List<{ at, actor, kind, detail }>,
//!     subtasks: Map<subtask_id> {            (v0.4, optional)
//!       nonce, title, done, rank, assignee (str or null),
//!       done_by (str or null), done_at (str or null),
//!       created_by, created_at, deleted
//!     },
//!     time: Map<entry_id> {                  (v0.4, optional)
//!       nonce, by, start, end (str or null, null = running), manual, note,
//!       deleted
//!     }
//!   }
//! ```
//!
//! `subtasks` and `time` (docs/plans/v04-board.md) are made with every new
//! task and, for older tasks, with their first subtask or time entry. When
//! two laptops make the same map offline, Automerge keeps both values as a
//! conflict; reads merge the contents of every value ([`BoardDoc::tasks`])
//! and writes look an entry up in all of them, so nothing written offline is
//! lost. New entries go into the winning map.
//!
//! A task id is bound to its creator and a comment id to its author through
//! the random `nonce` stored next to it ([`derive_task_id`],
//! [`derive_comment_id`], [`derive_subtask_id`], [`derive_time_id`]), so nobody can create a task or comment at a key
//! that someone else's task or comment could take. Tasks and comments made
//! before ids were bound have no nonce; they are still read normally.
//!
//! Mutations only stage operations; `store::commit_local` turns them into one
//! signed change. Reads are lenient: a document merged from other laptops may
//! hold unexpected values, which fall back to defaults instead of failing.
//! The document actor is the laptop's 32-byte public key, so the author of a
//! change can be checked against its signer (`sign.rs`).

use std::collections::{HashMap, HashSet};

use automerge::transaction::Transactable;
use automerge::{
    ActorId, AutoCommit, AutomergeError, Change, ChangeHash, ObjId, ObjType, ROOT, ReadDoc,
    ScalarValue, Value,
};
use rand_core::{OsRng, RngCore};
use serde::Serialize;
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

use super::model::{ColumnId, LABELS_MAX, Priority, SUBTASKS_MAX, TIME_ENTRIES_MAX};
use super::rank;
use super::timing;
use crate::error::{AppError, AppResult};

pub const DOC_VERSION: i64 = 1;

/// Largest task number a document may hold, so `+ 1` never overflows.
pub const MAX_TASK_NUMBER: i64 = 1_000_000_000;

/// Activity kinds stored in `activity[].kind`.
pub mod kind {
    pub const CREATED: &str = "created";
    pub const TITLE: &str = "title";
    pub const DESCRIPTION: &str = "description";
    pub const MOVED: &str = "moved";
    pub const ASSIGNEE: &str = "assignee";
    pub const DUE: &str = "due";
    pub const PRIORITY: &str = "priority";
    pub const LABELS: &str = "labels";
    pub const DELETED: &str = "deleted";
    pub const COMMENTED: &str = "commented";
    /// The task got a new number because another task had the same one after
    /// sync; `detail` is the old code, for example `PA-12`.
    pub const RENUMBERED: &str = "renumbered";
    /// `detail` is the subtask title.
    pub const SUBTASK_ADDED: &str = "subtask_added";
    pub const SUBTASK_DONE: &str = "subtask_done";
    pub const SUBTASK_REOPENED: &str = "subtask_reopened";
    pub const SUBTASK_DELETED: &str = "subtask_deleted";
    /// A timer stopped or time logged by hand; `detail` is the seconds.
    pub const TIME_LOGGED: &str = "time_logged";
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectMeta {
    pub id: String,
    pub code: String,
    pub name: String,
    pub team_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommentData {
    pub id: String,
    pub author: String,
    pub at: String,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ActivityData {
    pub at: String,
    pub actor: String,
    pub kind: String,
    pub detail: String,
}

/// One subtask as read from the document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SubtaskData {
    pub id: String,
    pub title: String,
    pub done: bool,
    pub rank: String,
    pub assignee: Option<String>,
    pub done_by: Option<String>,
    pub done_at: Option<String>,
    pub created_by: String,
    pub created_at: String,
    pub deleted: bool,
}

/// One time entry as read from the document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TimeData {
    pub id: String,
    /// Who tracked it (64 hex); only they may change it.
    pub by: String,
    pub start: String,
    /// `None` while the timer runs.
    pub end: Option<String>,
    pub manual: bool,
    pub note: String,
    pub deleted: bool,
}

impl TimeData {
    /// A timer that still runs (not stopped, not deleted).
    pub fn is_running(&self) -> bool {
        self.end.is_none() && !self.deleted
    }
}

/// One task as read from the document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TaskData {
    pub id: String,
    pub number: i64,
    pub title: String,
    pub description: String,
    pub column: ColumnId,
    pub rank: String,
    pub assignee: Option<String>,
    pub due: Option<String>,
    pub priority: Priority,
    pub labels: Vec<String>,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
    pub deleted: bool,
    /// Sorted by `(at, id)`.
    pub comments: Vec<CommentData>,
    /// In document order (oldest first).
    pub activity: Vec<ActivityData>,
    /// Live and deleted, sorted by `(rank, id)`, from every value of a
    /// conflicted `subtasks` key.
    pub subtasks: Vec<SubtaskData>,
    /// Live and deleted, sorted by `(start, id)`, from every value of a
    /// conflicted `time` key.
    pub time: Vec<TimeData>,
}

/// Validated input for a new task.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TaskInit {
    pub title: String,
    pub description: String,
    pub column: Option<ColumnId>,
    pub assignee: Option<String>,
    pub due: Option<String>,
    pub priority: Priority,
    pub labels: Vec<String>,
}

/// Validated field changes; `None` = leave as is.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TaskChanges {
    pub title: Option<String>,
    pub description: Option<String>,
    pub assignee: Option<Option<String>>,
    pub due: Option<Option<String>>,
    pub priority: Option<Priority>,
    pub labels: Option<Vec<String>>,
}

/// Validated subtask changes; `None` = leave as is.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SubtaskChanges {
    pub title: Option<String>,
    pub done: Option<bool>,
    pub assignee: Option<Option<String>>,
}

/// Who did it and when, for `updated_at` and the activity entry.
#[derive(Debug, Clone, Copy)]
pub struct Stamp<'a> {
    pub actor: &'a str,
    pub at: &'a str,
}

pub fn random_id() -> String {
    let mut b = [0u8; 16];
    OsRng.fill_bytes(&mut b);
    hex::encode(b)
}

/// A task id bound to its creator: the first 32 hex characters of BLAKE3
/// over `mira-task-v1`, creator and nonce, separated by newlines.
pub fn derive_task_id(created_by: &str, nonce: &str) -> String {
    bound_id("mira-task-v1", created_by, nonce)
}

/// A comment id bound to its author, like [`derive_task_id`] with
/// `mira-comment-v1`.
pub fn derive_comment_id(author: &str, nonce: &str) -> String {
    bound_id("mira-comment-v1", author, nonce)
}

/// A subtask id bound to its creator, like [`derive_task_id`] with
/// `mira-subtask-v1`.
pub fn derive_subtask_id(created_by: &str, nonce: &str) -> String {
    bound_id("mira-subtask-v1", created_by, nonce)
}

/// A time entry id bound to whoever tracked it, like [`derive_task_id`] with
/// `mira-time-v1`.
pub fn derive_time_id(by: &str, nonce: &str) -> String {
    bound_id("mira-time-v1", by, nonce)
}

fn bound_id(domain: &str, who: &str, nonce: &str) -> String {
    let input = format!("{domain}
{who}
{nonce}");
    blake3::hash(input.as_bytes()).to_hex()[..32].to_owned()
}

/// Whether `id` is the bound id of `who` and `nonce` (32 hex) under
/// `derive` ([`derive_task_id`] or [`derive_comment_id`]).
pub fn is_bound_id(
    derive: fn(&str, &str) -> String,
    id: &str,
    who: &str,
    nonce: Option<&str>,
) -> bool {
    nonce.is_some_and(|n| crate::org::is_lower_hex(n, 32) && derive(who, n) == id)
}

fn am(err: AutomergeError) -> AppError {
    AppError::Internal(format!("Dokumen board tidak bisa diproses. Detail: {err}"))
}

fn task_not_found() -> AppError {
    AppError::NotFound("Task tidak ditemukan. Mungkin sudah dihapus.".into())
}

fn subtask_not_found() -> AppError {
    AppError::NotFound(
        "Subtask tidak ditemukan. Mungkin sudah dihapus dari laptop lain. Tutup lalu buka lagi task ini."
            .into(),
    )
}

fn entry_not_found() -> AppError {
    AppError::NotFound(
        "Catatan waktu tidak ditemukan. Mungkin sudah dihapus. Tutup lalu buka lagi task ini.".into(),
    )
}

/// Keys of a task that hold a map of subtasks or of time entries.
const SUBTASKS: &str = "subtasks";
const TIME: &str = "time";

pub struct BoardDoc {
    doc: AutoCommit,
}

impl BoardDoc {
    /// A new project document. The operations are staged, not committed.
    pub fn create(actor: &[u8], meta: &ProjectMeta) -> AppResult<BoardDoc> {
        let mut doc = AutoCommit::new().with_actor(ActorId::from(actor));
        doc.put(ROOT, "v", DOC_VERSION).map_err(am)?;
        let project = doc.put_object(ROOT, "project", ObjType::Map).map_err(am)?;
        doc.put(&project, "id", meta.id.as_str()).map_err(am)?;
        doc.put(&project, "code", meta.code.as_str()).map_err(am)?;
        doc.put(&project, "name", meta.name.as_str()).map_err(am)?;
        doc.put(&project, "team_id", opt_scalar(meta.team_id.as_deref()))
            .map_err(am)?;
        doc.put(ROOT, "next_number", 1_i64).map_err(am)?;
        doc.put_object(ROOT, "tasks", ObjType::Map).map_err(am)?;
        Ok(BoardDoc { doc })
    }

    /// Stores the nonce that binds the project id to its creator and team
    /// (`store::derive_project_id`). Staged, part of the first change.
    pub fn set_project_nonce(&mut self, nonce: &str) -> AppResult<()> {
        let project = self.obj(&ROOT, "project").ok_or_else(|| {
            AppError::Internal("Dokumen proyek tidak lengkap: data proyek tidak ada.".into())
        })?;
        self.doc.put(&project, "nonce", nonce).map_err(am)
    }

    /// The nonce of [`BoardDoc::set_project_nonce`]; `None` for projects made
    /// before ids were bound.
    pub fn project_nonce(&self) -> Option<String> {
        self.obj(&ROOT, "project")
            .and_then(|p| self.str(&p, "nonce"))
    }

    /// Loads a snapshot made by [`BoardDoc::save`].
    pub fn load(bytes: &[u8], actor: &[u8]) -> AppResult<BoardDoc> {
        let doc = AutoCommit::load(bytes)
            .map_err(|e| {
                AppError::Database(format!(
                    "Data board di laptop ini rusak dan tidak bisa dibuka. Detail: {e}"
                ))
            })?
            .with_actor(ActorId::from(actor));
        Ok(BoardDoc { doc })
    }

    /// An empty document, to be filled with `apply`.
    pub fn empty(actor: &[u8]) -> BoardDoc {
        BoardDoc {
            doc: AutoCommit::new().with_actor(ActorId::from(actor)),
        }
    }

    pub fn save(&mut self) -> Vec<u8> {
        self.doc.save()
    }

    pub fn heads(&mut self) -> Vec<ChangeHash> {
        let mut heads = self.doc.get_heads();
        heads.sort();
        heads
    }

    /// Commits the staged operations as one change; `None` if nothing was staged.
    pub fn commit(&mut self, unix_time: i64) -> Option<ChangeHash> {
        self.doc
            .commit_with(automerge::transaction::CommitOptions::default().with_time(unix_time))
    }

    /// Changes that are not ancestors of `heads` (unknown hashes are ignored).
    pub fn changes_after(&mut self, heads: &[ChangeHash]) -> Vec<Change> {
        let known: Vec<ChangeHash> = heads
            .iter()
            .copied()
            .filter(|h| self.doc.get_change_by_hash(h).is_some())
            .collect();
        self.doc.get_changes(&known)
    }

    pub fn has_change(&mut self, hash: &ChangeHash) -> bool {
        self.doc.get_change_by_hash(hash).is_some()
    }

    /// Applies one change whose dependencies are already in the document.
    pub fn apply(&mut self, change: Change) -> AppResult<()> {
        self.doc.apply_changes([change]).map_err(am)
    }

    /// Applies a change from another laptop written by `author` (64 hex).
    /// When Automerge refuses it (for example two different changes with the
    /// same actor and sequence number) or the result breaks the document
    /// shape (see [`BoardDoc::check_shape`]), the document is restored to
    /// what it was and the error is `(rejection code, detail)`.
    pub fn apply_remote(
        &mut self,
        change: Change,
        author: &str,
    ) -> Result<(), (&'static str, String)> {
        let before = self.shape_guard();
        let actor = self.doc.get_actor().clone();
        let backup = self.doc.fork().with_actor(actor);
        let hash = change.hash();
        if let Err(e) = self.doc.apply_changes([change]) {
            self.doc = backup;
            return Err(("board_apply_failed", e.to_string()));
        }
        // Automerge queues a change it cannot apply yet instead of failing.
        if !self.has_change(&hash) {
            self.doc = backup;
            return Err((
                "board_apply_failed",
                "perubahan tidak bisa digabung ke dokumen".into(),
            ));
        }
        if let Err(e) = self.check_shape(&before, author) {
            self.doc = backup;
            return Err(("board_invalid_doc", e));
        }
        Ok(())
    }

    /// A copy with the same actor and history, to restore after a change
    /// that `sync` refuses once applied (for example a delete without right).
    pub fn fork(&mut self) -> BoardDoc {
        let actor = self.doc.get_actor().clone();
        BoardDoc {
            doc: self.doc.fork().with_actor(actor),
        }
    }

    /// Read access to the Automerge document, for `rules`.
    pub(crate) fn automerge(&self) -> &AutoCommit {
        &self.doc
    }

    /// What a remote change may not alter about existing tasks:
    /// task id -> (created_by, deleted).
    fn shape_guard(&self) -> HashMap<String, (String, bool)> {
        self.tasks()
            .map(|ts| {
                ts.into_iter()
                    .map(|t| (t.id, (t.created_by, t.deleted)))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Checks the document shape every laptop relies on to open the board:
    /// root fields and types, each task's fields and types, known column and
    /// priority values. Against `before`: `created_by` of existing tasks is
    /// unchanged, deleted tasks stay deleted, and new tasks are created by
    /// `author`.
    fn check_shape(
        &self,
        before: &HashMap<String, (String, bool)>,
        author: &str,
    ) -> Result<(), String> {
        let root_ok = matches!(self.field(&ROOT, "v"), Some(Field::Int(_)))
            && matches!(self.field(&ROOT, "next_number"), Some(Field::Int(n)) if (1..=MAX_TASK_NUMBER + 1).contains(&n))
            && matches!(self.field(&ROOT, "project"), Some(Field::Obj(ObjType::Map)))
            && matches!(self.field(&ROOT, "tasks"), Some(Field::Obj(ObjType::Map)));
        if !root_ok {
            return Err("struktur utama dokumen board rusak".into());
        }
        let tasks = self.tasks_obj().map_err(|e| e.to_string())?;
        let present: std::collections::HashSet<String> = self.doc.keys(&tasks).collect();
        if let Some(gone) = before.keys().find(|id| !present.contains(*id)) {
            return Err(format!("task {gone}: dihapus dari dokumen"));
        }
        let meta = self.project();
        if !meta.id.is_empty()
            && (super::model::validate_project_name(&meta.name).ok().as_deref() != Some(meta.name.as_str())
                || super::model::validate_project_code(&meta.code).ok().as_deref() != Some(meta.code.as_str()))
        {
            return Err("nama atau kode proyek tidak valid".into());
        }
        for id in self.doc.keys(&tasks) {
            let bad = |what: &str| Err(format!("task {id}: {what}"));
            let Some(t) = self.obj(&tasks, &id) else {
                return bad("bukan map");
            };
            if !matches!(self.doc.object_type(&t), Ok(ObjType::Map)) {
                return bad("bukan map");
            }
            let f = |k: &str| self.field(&t, k);
            let is_str = |k: &str| matches!(f(k), Some(Field::Str(_)));
            let is_obj = |k: &str, ty: ObjType| f(k) == Some(Field::Obj(ty));
            let str_or_null = |k: &str| matches!(f(k), Some(Field::Str(_) | Field::Null));
            let fields_ok = matches!(f("number"), Some(Field::Int(n)) if (1..=MAX_TASK_NUMBER).contains(&n))
                && is_obj("title", ObjType::Text)
                && is_obj("description", ObjType::Text)
                && matches!(f("column"), Some(Field::Str(c)) if ColumnId::parse(&c).is_some())
                && matches!(f("priority"), Some(Field::Str(p)) if Priority::parse(&p).is_some())
                && is_str("rank")
                && str_or_null("assignee")
                && str_or_null("due")
                && is_obj("labels", ObjType::List)
                && is_obj("comments", ObjType::Map)
                && is_obj("activity", ObjType::List)
                && is_str("created_by")
                && is_str("created_at")
                && is_str("updated_at")
                && matches!(f("deleted"), Some(Field::Bool(_)))
                && matches!(f("nonce"), None | Some(Field::Str(_)));
            if !fields_ok {
                return bad("isian wajib hilang atau jenisnya salah");
            }
            if !self.entries_ok(&t, SUBTASKS, subtask_shape_ok) {
                return bad("subtask rusak atau jenis isiannya salah");
            }
            if !self.entries_ok(&t, TIME, time_shape_ok) {
                return bad("catatan waktu rusak atau jenis isiannya salah");
            }
            let created_by = self.str(&t, "created_by").unwrap_or_default();
            let deleted = f("deleted") == Some(Field::Bool(true));
            match before.get(&id) {
                Some((was_by, _)) if *was_by != created_by => return bad("pembuat task diubah"),
                Some((_, true)) if !deleted => return bad("task yang dihapus dimunculkan lagi"),
                None if created_by != author => {
                    return bad("task baru dibuat atas nama laptop lain");
                }
                // Also checked by `rules::check_new_authorship`; failing here
                // lets `apply_remote` restore the document.
                None if !is_bound_id(
                    derive_task_id,
                    &id,
                    &created_by,
                    self.str(&t, "nonce").as_deref(),
                ) =>
                {
                    return bad("kode task baru tidak cocok dengan pembuatnya");
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// Every value at `key` of `task` (none is fine) is a map whose entries
    /// are maps passing `entry_ok`.
    fn entries_ok(&self, task: &ObjId, key: &str, entry_ok: ShapeCheck) -> bool {
        let Ok(values) = self.doc.get_all(task, key) else {
            return false;
        };
        values.into_iter().all(|(v, map)| {
            matches!(v, Value::Object(ObjType::Map))
                && self.doc.keys(&map).all(|id| match self.doc.get(&map, &id) {
                    Ok(Some((Value::Object(ObjType::Map), e))) => entry_ok(&|k| self.field(&e, k)),
                    _ => false,
                })
        })
    }

    fn field(&self, obj: &ObjId, key: &str) -> Option<Field> {
        match self.doc.get(obj, key) {
            Ok(Some((Value::Object(t), _))) => Some(Field::Obj(t)),
            Ok(Some((Value::Scalar(s), _))) => Some(match s.as_ref() {
                ScalarValue::Str(x) => Field::Str(x.to_string()),
                ScalarValue::Int(i) => Field::Int(*i),
                ScalarValue::Uint(u) => i64::try_from(*u).map_or(Field::Other, Field::Int),
                ScalarValue::Boolean(b) => Field::Bool(*b),
                ScalarValue::Null => Field::Null,
                _ => Field::Other,
            }),
            _ => None,
        }
    }

    #[cfg(test)]
    pub(crate) fn raw(&mut self) -> &mut AutoCommit {
        &mut self.doc
    }

    pub fn project(&self) -> ProjectMeta {
        let p = self.obj(&ROOT, "project");
        let s = |k: &str| p.as_ref().and_then(|p| self.str(p, k)).unwrap_or_default();
        ProjectMeta {
            id: s("id"),
            code: s("code"),
            name: s("name"),
            team_id: p.as_ref().and_then(|p| self.str(p, "team_id")),
        }
    }

    /// All tasks including deleted ones, sorted by `(rank, id)`.
    pub fn tasks(&self) -> AppResult<Vec<TaskData>> {
        let tasks = self.tasks_obj()?;
        let mut out: Vec<TaskData> = self
            .doc
            .keys(&tasks)
            .filter_map(|id| self.read_task(&tasks, &id))
            .collect();
        out.sort_by(|a, b| (&a.rank, &a.id).cmp(&(&b.rank, &b.id)));
        Ok(out)
    }

    pub fn task(&self, id: &str) -> AppResult<Option<TaskData>> {
        let tasks = self.tasks_obj()?;
        Ok(self.read_task(&tasks, id))
    }

    /// A task that exists and is not deleted.
    pub fn live_task(&self, id: &str) -> AppResult<TaskData> {
        match self.task(id)? {
            Some(t) if !t.deleted => Ok(t),
            _ => Err(task_not_found()),
        }
    }

    /// Adds a task at the bottom of its column; returns its id.
    pub fn create_task(&mut self, stamp: Stamp<'_>, init: TaskInit) -> AppResult<String> {
        let existing = self.tasks()?;
        let tasks = self.tasks_obj()?;
        let number = self.fresh_number()?;
        let column = init.column.unwrap_or(ColumnId::Todo);
        let last_rank = existing
            .iter()
            .filter(|t| !t.deleted && t.column == column)
            .map(|t| t.rank.as_str())
            .filter(|r| rank::is_valid(r))
            .max();
        let rank = rank::between(last_rank, None).unwrap_or_else(|| "V".to_owned());

        let nonce = random_id();
        let id = derive_task_id(stamp.actor, &nonce);
        let d = &mut self.doc;
        d.put(ROOT, "next_number", number + 1).map_err(am)?;
        let t = d
            .put_object(&tasks, id.as_str(), ObjType::Map)
            .map_err(am)?;
        d.put(&t, "nonce", nonce.as_str()).map_err(am)?;
        d.put(&t, "number", number).map_err(am)?;
        let title = d.put_object(&t, "title", ObjType::Text).map_err(am)?;
        d.splice_text(&title, 0, 0, &init.title).map_err(am)?;
        let desc = d.put_object(&t, "description", ObjType::Text).map_err(am)?;
        d.splice_text(&desc, 0, 0, &init.description).map_err(am)?;
        d.put(&t, "column", column.as_str()).map_err(am)?;
        d.put(&t, "rank", rank.as_str()).map_err(am)?;
        d.put(&t, "assignee", opt_scalar(init.assignee.as_deref()))
            .map_err(am)?;
        d.put(&t, "due", opt_scalar(init.due.as_deref()))
            .map_err(am)?;
        d.put(&t, "priority", init.priority.as_str()).map_err(am)?;
        put_labels(d, &t, &init.labels)?;
        d.put(&t, "created_by", stamp.actor).map_err(am)?;
        d.put(&t, "created_at", stamp.at).map_err(am)?;
        d.put(&t, "updated_at", stamp.at).map_err(am)?;
        d.put(&t, "deleted", false).map_err(am)?;
        d.put_object(&t, "comments", ObjType::Map).map_err(am)?;
        d.put_object(&t, "activity", ObjType::List).map_err(am)?;
        d.put_object(&t, SUBTASKS, ObjType::Map).map_err(am)?;
        d.put_object(&t, TIME, ObjType::Map).map_err(am)?;
        self.log(&t, stamp, kind::CREATED, column.name())?;
        Ok(id)
    }

    fn next_number(&self) -> AppResult<i64> {
        Ok(self
            .doc
            .get(ROOT, "next_number")
            .map_err(am)?
            .and_then(|(v, _)| v.as_i64())
            .unwrap_or(1))
    }

    /// The number a new or renumbered task gets: `next_number`, but above
    /// every number in use (deleted tasks included), at least 1.
    pub fn fresh_number(&self) -> AppResult<i64> {
        let max_number = self.tasks()?.iter().map(|t| t.number).max().unwrap_or(0);
        Ok(self
            .next_number()?
            .max(max_number.saturating_add(1))
            .clamp(1, MAX_TASK_NUMBER))
    }

    /// [`BoardDoc::fresh_number`] as the document was at `heads` (changes it
    /// holds), so every laptop computes the same value for a change judged
    /// against its dependencies.
    pub fn fresh_number_at(&self, heads: &[ChangeHash]) -> i64 {
        let d = &self.doc;
        let int = |obj: &ObjId, key: &str| -> Option<i64> {
            d.get_at(obj, key, heads).ok().flatten().and_then(|(v, _)| v.as_i64())
        };
        let max_number = match d.get_at(ROOT, "tasks", heads) {
            Ok(Some((Value::Object(ObjType::Map), tasks))) => d
                .keys_at(&tasks, heads)
                .filter_map(|id| match d.get_at(&tasks, id.as_str(), heads) {
                    Ok(Some((Value::Object(_), t))) => int(&t, "number"),
                    _ => None,
                })
                .max()
                .unwrap_or(0),
            _ => 0,
        };
        int(&ROOT, "next_number")
            .unwrap_or(1)
            .max(max_number.saturating_add(1))
            .clamp(1, MAX_TASK_NUMBER)
    }

    /// Gives a live task `new_number` (chosen by `numbers.rs`), raises
    /// `next_number` past it and logs a `renumbered` entry whose detail is
    /// the old code. Nothing is staged when the number is already that.
    pub fn renumber_task(
        &mut self,
        stamp: Stamp<'_>,
        id: &str,
        new_number: i64,
        old_code: &str,
    ) -> AppResult<()> {
        let cur = self.live_task(id)?;
        if cur.number == new_number {
            return Ok(());
        }
        let t = self.task_obj(id)?;
        self.doc.put(&t, "number", new_number).map_err(am)?;
        let next = new_number.saturating_add(1);
        if next > self.next_number()? {
            self.doc.put(ROOT, "next_number", next).map_err(am)?;
        }
        self.doc.put(&t, "updated_at", stamp.at).map_err(am)?;
        self.log(&t, stamp, kind::RENUMBERED, old_code)
    }

    /// Sets the project name (already validated); nothing is staged when it
    /// is unchanged.
    pub fn rename_project(&mut self, name: &str) -> AppResult<()> {
        if self.project().name == name {
            return Ok(());
        }
        let project = self.obj(&ROOT, "project").ok_or_else(|| {
            AppError::Internal("Dokumen proyek tidak lengkap: data proyek tidak ada.".into())
        })?;
        self.doc.put(&project, "name", name).map_err(am)
    }

    /// Applies the fields that differ from the current values, one activity
    /// entry each. `name_of` turns a public key into a display name for the
    /// assignee entry.
    pub fn update_task(
        &mut self,
        stamp: Stamp<'_>,
        id: &str,
        changes: &TaskChanges,
        name_of: &dyn Fn(&str) -> String,
    ) -> AppResult<()> {
        let cur = self.live_task(id)?;
        let t = self.task_obj(id)?;
        let mut changed = false;

        if let Some(title) = changes.title.as_ref().filter(|v| **v != cur.title) {
            self.set_text(&t, "title", title)?;
            self.log(&t, stamp, kind::TITLE, title)?;
            changed = true;
        }
        if let Some(desc) = changes
            .description
            .as_ref()
            .filter(|v| **v != cur.description)
        {
            self.set_text(&t, "description", desc)?;
            self.log(&t, stamp, kind::DESCRIPTION, "")?;
            changed = true;
        }
        if let Some(assignee) = changes.assignee.as_ref().filter(|v| **v != cur.assignee) {
            self.doc
                .put(&t, "assignee", opt_scalar(assignee.as_deref()))
                .map_err(am)?;
            let detail = assignee.as_deref().map(name_of).unwrap_or_default();
            self.log(&t, stamp, kind::ASSIGNEE, &detail)?;
            changed = true;
        }
        if let Some(due) = changes.due.as_ref().filter(|v| **v != cur.due) {
            self.doc
                .put(&t, "due", opt_scalar(due.as_deref()))
                .map_err(am)?;
            self.log(&t, stamp, kind::DUE, due.as_deref().unwrap_or_default())?;
            changed = true;
        }
        if let Some(priority) = changes.priority.filter(|v| *v != cur.priority) {
            self.doc
                .put(&t, "priority", priority.as_str())
                .map_err(am)?;
            self.log(&t, stamp, kind::PRIORITY, priority.label())?;
            changed = true;
        }
        if let Some(labels) = changes.labels.as_ref().filter(|v| **v != cur.labels) {
            put_labels(&mut self.doc, &t, labels)?;
            self.log(&t, stamp, kind::LABELS, &labels.join(", "))?;
            changed = true;
        }
        if changed {
            self.doc.put(&t, "updated_at", stamp.at).map_err(am)?;
        }
        Ok(())
    }

    /// Moves a task to `index` in `column` (position after the move, 0 = top,
    /// clamped). Usually writes only this task's rank; when the neighbours'
    /// ranks leave no room (equal ranks after a concurrent move) the whole
    /// column is renumbered in the same change.
    pub fn move_task(
        &mut self,
        stamp: Stamp<'_>,
        id: &str,
        column: ColumnId,
        index: usize,
    ) -> AppResult<()> {
        let cur = self.live_task(id)?;
        let t = self.task_obj(id)?;
        let mut others: Vec<TaskData> = self
            .tasks()?
            .into_iter()
            .filter(|x| !x.deleted && x.column == column && x.id != id)
            .collect();
        others.sort_by(|a, b| (&a.rank, &a.id).cmp(&(&b.rank, &b.id)));
        let index = index.min(others.len());

        if cur.column == column {
            let mut current: Vec<&TaskData> = others.iter().collect();
            current.push(&cur);
            current.sort_by(|a, b| (&a.rank, &a.id).cmp(&(&b.rank, &b.id)));
            if current.iter().position(|x| x.id == id) == Some(index) {
                return Ok(());
            }
        }

        let before = index.checked_sub(1).map(|i| others[i].rank.as_str());
        let after = others.get(index).map(|x| x.rank.as_str());
        match rank::between(before, after) {
            Some(r) => self.doc.put(&t, "rank", r.as_str()).map_err(am)?,
            None => {
                let mut order: Vec<&str> = others.iter().map(|x| x.id.as_str()).collect();
                order.insert(index, id);
                let tasks = self.tasks_obj()?;
                for (task_id, r) in order.into_iter().zip(rank::spread(others.len() + 1)) {
                    if let Some(obj) = self.obj(&tasks, task_id) {
                        self.doc.put(&obj, "rank", r.as_str()).map_err(am)?;
                    }
                }
            }
        }
        if cur.column != column {
            self.doc.put(&t, "column", column.as_str()).map_err(am)?;
            self.log(&t, stamp, kind::MOVED, column.name())?;
        }
        self.doc.put(&t, "updated_at", stamp.at).map_err(am)?;
        Ok(())
    }

    /// Marks the task deleted. It stays in the document so that concurrent
    /// edits from other laptops do not bring back a half task.
    pub fn delete_task(&mut self, stamp: Stamp<'_>, id: &str) -> AppResult<()> {
        self.live_task(id)?;
        let t = self.task_obj(id)?;
        self.doc.put(&t, "deleted", true).map_err(am)?;
        self.doc.put(&t, "updated_at", stamp.at).map_err(am)?;
        self.log(&t, stamp, kind::DELETED, "")
    }

    /// Adds a comment; returns its id.
    pub fn add_comment(&mut self, stamp: Stamp<'_>, id: &str, body: &str) -> AppResult<String> {
        self.live_task(id)?;
        let t = self.task_obj(id)?;
        let comments = match self.obj(&t, "comments") {
            Some(c) => c,
            None => self
                .doc
                .put_object(&t, "comments", ObjType::Map)
                .map_err(am)?,
        };
        let nonce = random_id();
        let comment_id = derive_comment_id(stamp.actor, &nonce);
        let c = self
            .doc
            .put_object(&comments, comment_id.as_str(), ObjType::Map)
            .map_err(am)?;
        self.doc.put(&c, "nonce", nonce.as_str()).map_err(am)?;
        self.doc.put(&c, "author", stamp.actor).map_err(am)?;
        self.doc.put(&c, "at", stamp.at).map_err(am)?;
        self.doc.put(&c, "body", body).map_err(am)?;
        self.doc.put(&t, "updated_at", stamp.at).map_err(am)?;
        self.log(&t, stamp, kind::COMMENTED, "")?;
        Ok(comment_id)
    }

    /// Adds a subtask at the bottom of the task's list; returns its id.
    pub fn add_subtask(
        &mut self,
        stamp: Stamp<'_>,
        task_id: &str,
        title: &str,
        assignee: Option<&str>,
    ) -> AppResult<String> {
        let task = self.live_task(task_id)?;
        let live: Vec<&SubtaskData> = task.subtasks.iter().filter(|s| !s.deleted).collect();
        if live.len() >= SUBTASKS_MAX {
            return Err(AppError::InvalidInput(format!(
                "Satu task paling banyak punya {SUBTASKS_MAX} subtask. Hapus subtask yang sudah tidak perlu, atau pecah task ini menjadi beberapa task."
            )));
        }
        let last = live
            .iter()
            .map(|s| s.rank.as_str())
            .filter(|r| rank::is_valid(r))
            .max();
        let rank = rank::between(last, None).unwrap_or_else(|| "V".to_owned());
        let t = self.task_obj(task_id)?;
        let map = self.map_for_new(&t, SUBTASKS)?;
        let nonce = random_id();
        let id = derive_subtask_id(stamp.actor, &nonce);
        let d = &mut self.doc;
        let s = d.put_object(&map, id.as_str(), ObjType::Map).map_err(am)?;
        d.put(&s, "nonce", nonce.as_str()).map_err(am)?;
        d.put(&s, "title", title).map_err(am)?;
        d.put(&s, "done", false).map_err(am)?;
        d.put(&s, "rank", rank.as_str()).map_err(am)?;
        d.put(&s, "assignee", opt_scalar(assignee)).map_err(am)?;
        d.put(&s, "done_by", ScalarValue::Null).map_err(am)?;
        d.put(&s, "done_at", ScalarValue::Null).map_err(am)?;
        d.put(&s, "created_by", stamp.actor).map_err(am)?;
        d.put(&s, "created_at", stamp.at).map_err(am)?;
        d.put(&s, "deleted", false).map_err(am)?;
        d.put(&t, "updated_at", stamp.at).map_err(am)?;
        self.log(&t, stamp, kind::SUBTASK_ADDED, title)?;
        Ok(id)
    }

    /// The live subtask `subtask_id` of the live task `task_id`, with the
    /// task object and the subtask object.
    fn live_subtask(&self, task_id: &str, subtask_id: &str) -> AppResult<(SubtaskData, ObjId, ObjId)> {
        let task = self.live_task(task_id)?;
        let cur = task
            .subtasks
            .into_iter()
            .find(|s| s.id == subtask_id && !s.deleted)
            .ok_or_else(subtask_not_found)?;
        let t = self.task_obj(task_id)?;
        let s = self
            .entry_obj(&t, SUBTASKS, subtask_id)
            .ok_or_else(subtask_not_found)?;
        Ok((cur, t, s))
    }

    /// Applies the subtask fields that differ. Ticking it records who and
    /// when; opening it again clears both.
    pub fn update_subtask(
        &mut self,
        stamp: Stamp<'_>,
        task_id: &str,
        subtask_id: &str,
        changes: &SubtaskChanges,
    ) -> AppResult<()> {
        let (cur, t, s) = self.live_subtask(task_id, subtask_id)?;
        let mut changed = false;
        let mut title = cur.title.clone();
        if let Some(v) = changes.title.as_ref().filter(|v| **v != cur.title) {
            self.doc.put(&s, "title", v.as_str()).map_err(am)?;
            title.clone_from(v);
            changed = true;
        }
        if let Some(a) = changes.assignee.as_ref().filter(|v| **v != cur.assignee) {
            self.doc
                .put(&s, "assignee", opt_scalar(a.as_deref()))
                .map_err(am)?;
            changed = true;
        }
        if let Some(done) = changes.done.filter(|v| *v != cur.done) {
            self.doc.put(&s, "done", done).map_err(am)?;
            let (by, at, what) = if done {
                (Some(stamp.actor), Some(stamp.at), kind::SUBTASK_DONE)
            } else {
                (None, None, kind::SUBTASK_REOPENED)
            };
            self.doc.put(&s, "done_by", opt_scalar(by)).map_err(am)?;
            self.doc.put(&s, "done_at", opt_scalar(at)).map_err(am)?;
            self.log(&t, stamp, what, &title)?;
            changed = true;
        }
        if changed {
            self.doc.put(&t, "updated_at", stamp.at).map_err(am)?;
        }
        Ok(())
    }

    /// Moves a subtask to `index` among the live subtasks (position after
    /// the move, 0 = top, clamped), like [`BoardDoc::move_task`]: usually
    /// one rank written, the whole list renumbered when there is no room.
    pub fn move_subtask(
        &mut self,
        stamp: Stamp<'_>,
        task_id: &str,
        subtask_id: &str,
        index: usize,
    ) -> AppResult<()> {
        let (_, t, s) = self.live_subtask(task_id, subtask_id)?;
        // Sorted by (rank, id) already.
        let live: Vec<SubtaskData> = self
            .live_task(task_id)?
            .subtasks
            .into_iter()
            .filter(|x| !x.deleted)
            .collect();
        let pos = live.iter().position(|x| x.id == subtask_id);
        let others: Vec<&SubtaskData> = live.iter().filter(|x| x.id != subtask_id).collect();
        let index = index.min(others.len());
        if pos == Some(index) {
            return Ok(());
        }
        let before = index.checked_sub(1).map(|i| others[i].rank.as_str());
        let after = others.get(index).map(|x| x.rank.as_str());
        match rank::between(before, after) {
            Some(r) => self.doc.put(&s, "rank", r.as_str()).map_err(am)?,
            None => {
                let mut order: Vec<&str> = others.iter().map(|x| x.id.as_str()).collect();
                order.insert(index, subtask_id);
                for (id, r) in order.into_iter().zip(rank::spread(others.len() + 1)) {
                    if let Some(obj) = self.entry_obj(&t, SUBTASKS, id) {
                        self.doc.put(&obj, "rank", r.as_str()).map_err(am)?;
                    }
                }
            }
        }
        self.doc.put(&t, "updated_at", stamp.at).map_err(am)?;
        Ok(())
    }

    /// Marks a subtask deleted; it is never brought back.
    pub fn delete_subtask(&mut self, stamp: Stamp<'_>, task_id: &str, subtask_id: &str) -> AppResult<()> {
        let (cur, t, s) = self.live_subtask(task_id, subtask_id)?;
        self.doc.put(&s, "deleted", true).map_err(am)?;
        self.doc.put(&t, "updated_at", stamp.at).map_err(am)?;
        self.log(&t, stamp, kind::SUBTASK_DELETED, &cur.title)
    }

    /// Starts the timer of `stamp.actor` on a live task; returns the entry
    /// id. Timers of the same person still running on other tasks of this
    /// project are stopped in the same change. When the timer already runs
    /// here nothing is staged and its entry is returned.
    pub fn start_timer(&mut self, stamp: Stamp<'_>, task_id: &str) -> AppResult<String> {
        let task = self.live_task(task_id)?;
        if let Some(e) = task.time.iter().find(|e| e.by == stamp.actor && e.is_running()) {
            return Ok(e.id.clone());
        }
        check_room_for_entry(&task)?;
        for other in self.tasks()? {
            if other.id == task_id {
                continue;
            }
            for e in other.time.iter().filter(|e| e.by == stamp.actor && e.is_running()) {
                self.stop_entry(&other.id, e, stamp, None)?;
            }
        }
        self.new_entry(stamp, task_id, stamp.at, None, "")
    }

    /// Stops the running timer of `stamp.actor` on the task, with `note`
    /// (already validated, may be empty).
    pub fn stop_timer(&mut self, stamp: Stamp<'_>, task_id: &str, note: &str) -> AppResult<()> {
        let task = self.live_task(task_id)?;
        let running: Vec<&TimeData> = task
            .time
            .iter()
            .filter(|e| e.by == stamp.actor && e.is_running())
            .collect();
        if running.is_empty() {
            return Err(AppError::InvalidInput(
                "Timer Anda di task ini sudah berhenti. Tutup lalu buka lagi task ini untuk melihat catatan terbaru."
                    .into(),
            ));
        }
        for e in running {
            self.stop_entry(task_id, e, stamp, Some(note))?;
        }
        Ok(())
    }

    /// Logs `secs` of work by hand, ending now (`stamp.at`, RFC 3339);
    /// returns the entry id.
    pub fn log_time(&mut self, stamp: Stamp<'_>, task_id: &str, secs: i64, note: &str) -> AppResult<String> {
        let task = self.live_task(task_id)?;
        check_room_for_entry(&task)?;
        let end = OffsetDateTime::parse(stamp.at, &Rfc3339).map_err(|_| {
            AppError::Internal(
                "Jam laptop ini tidak terbaca. Periksa pengaturan tanggal dan jam Windows, lalu coba lagi.".into(),
            )
        })?;
        let secs = secs.max(0);
        let start = crate::clock::format_rfc3339(end - Duration::seconds(secs));
        let id = self.new_entry(stamp, task_id, &start, Some(stamp.at), note)?;
        let t = self.task_obj(task_id)?;
        self.log(&t, stamp, kind::TIME_LOGGED, &secs.to_string())?;
        Ok(id)
    }

    /// Marks a time entry of `stamp.actor` deleted.
    pub fn delete_time_entry(&mut self, stamp: Stamp<'_>, task_id: &str, entry_id: &str) -> AppResult<()> {
        let task = self.live_task(task_id)?;
        let e = task
            .time
            .iter()
            .find(|e| e.id == entry_id && !e.deleted)
            .ok_or_else(entry_not_found)?;
        if e.by != stamp.actor {
            return Err(AppError::Forbidden(
                "Anda hanya bisa menghapus catatan waktu Anda sendiri. Minta pemiliknya menghapus catatan itu."
                    .into(),
            ));
        }
        let t = self.task_obj(task_id)?;
        let obj = self.entry_obj(&t, TIME, entry_id).ok_or_else(entry_not_found)?;
        self.doc.put(&obj, "deleted", true).map_err(am)
    }

    /// Stages a new time entry of `stamp.actor` (manual when `end` is given).
    fn new_entry(
        &mut self,
        stamp: Stamp<'_>,
        task_id: &str,
        start: &str,
        end: Option<&str>,
        note: &str,
    ) -> AppResult<String> {
        let t = self.task_obj(task_id)?;
        let map = self.map_for_new(&t, TIME)?;
        let nonce = random_id();
        let id = derive_time_id(stamp.actor, &nonce);
        let d = &mut self.doc;
        let e = d.put_object(&map, id.as_str(), ObjType::Map).map_err(am)?;
        d.put(&e, "nonce", nonce.as_str()).map_err(am)?;
        d.put(&e, "by", stamp.actor).map_err(am)?;
        d.put(&e, "start", start).map_err(am)?;
        d.put(&e, "end", opt_scalar(end)).map_err(am)?;
        d.put(&e, "manual", end.is_some()).map_err(am)?;
        d.put(&e, "note", note).map_err(am)?;
        d.put(&e, "deleted", false).map_err(am)?;
        Ok(id)
    }

    /// Ends the running entry `e` of task `task_id` now and logs its length.
    /// `note` replaces the entry's note when given.
    fn stop_entry(&mut self, task_id: &str, e: &TimeData, stamp: Stamp<'_>, note: Option<&str>) -> AppResult<()> {
        let t = self.task_obj(task_id)?;
        let obj = self.entry_obj(&t, TIME, &e.id).ok_or_else(entry_not_found)?;
        self.doc.put(&obj, "end", stamp.at).map_err(am)?;
        if let Some(n) = note.filter(|n| *n != e.note) {
            self.doc.put(&obj, "note", n).map_err(am)?;
        }
        let secs = timing::entry_secs(&e.start, Some(stamp.at));
        self.log(&t, stamp, kind::TIME_LOGGED, &secs.to_string())
    }

    /// Every map at `key` of `task`, the winning value of a conflict first.
    fn maps_at(&self, task: &ObjId, key: &str) -> Vec<ObjId> {
        let Ok(values) = self.doc.get_all(task, key) else {
            return Vec::new();
        };
        let mut maps: Vec<ObjId> = values
            .into_iter()
            .filter(|(v, _)| matches!(v, Value::Object(ObjType::Map)))
            .map(|(_, id)| id)
            .collect();
        if let Some(winner) = self.obj(task, key)
            && let Some(i) = maps.iter().position(|m| *m == winner)
        {
            maps.swap(0, i);
        }
        maps
    }

    /// The entry `id` in any of the maps at `key` of `task`.
    fn entry_obj(&self, task: &ObjId, key: &str, id: &str) -> Option<ObjId> {
        self.maps_at(task, key)
            .iter()
            .find_map(|m| match self.doc.get(m, id) {
                Ok(Some((Value::Object(ObjType::Map), e))) => Some(e),
                _ => None,
            })
    }

    /// The map at `key` of `task` that new entries go into (the winning
    /// value), made when the task has none (tasks from before v0.4).
    fn map_for_new(&mut self, task: &ObjId, key: &str) -> AppResult<ObjId> {
        match self.maps_at(task, key).into_iter().next() {
            Some(m) => Ok(m),
            None => self.doc.put_object(task, key, ObjType::Map).map_err(am),
        }
    }

    fn log(&mut self, task: &ObjId, stamp: Stamp<'_>, kind: &str, detail: &str) -> AppResult<()> {
        let list = match self.obj(task, "activity") {
            Some(l) => l,
            None => self
                .doc
                .put_object(task, "activity", ObjType::List)
                .map_err(am)?,
        };
        let len = self.doc.length(&list);
        let e = self
            .doc
            .insert_object(&list, len, ObjType::Map)
            .map_err(am)?;
        self.doc.put(&e, "at", stamp.at).map_err(am)?;
        self.doc.put(&e, "actor", stamp.actor).map_err(am)?;
        self.doc.put(&e, "kind", kind).map_err(am)?;
        self.doc.put(&e, "detail", detail).map_err(am)?;
        Ok(())
    }

    fn set_text(&mut self, obj: &ObjId, key: &str, value: &str) -> AppResult<()> {
        let existing = match self.doc.get(obj, key).map_err(am)? {
            Some((Value::Object(ObjType::Text), text)) => Some(text),
            _ => None,
        };
        match existing {
            Some(text) => self.doc.update_text(&text, value).map_err(am),
            None => {
                let text = self.doc.put_object(obj, key, ObjType::Text).map_err(am)?;
                self.doc.splice_text(&text, 0, 0, value).map_err(am)
            }
        }
    }

    fn tasks_obj(&self) -> AppResult<ObjId> {
        self.obj(&ROOT, "tasks").ok_or_else(|| {
            AppError::Internal("Dokumen proyek tidak lengkap: daftar task tidak ada.".into())
        })
    }

    fn task_obj(&self, id: &str) -> AppResult<ObjId> {
        let tasks = self.tasks_obj()?;
        self.obj(&tasks, id).ok_or_else(task_not_found)
    }

    fn obj(&self, parent: &ObjId, key: &str) -> Option<ObjId> {
        match self.doc.get(parent, key) {
            Ok(Some((Value::Object(_), id))) => Some(id),
            _ => None,
        }
    }

    fn str(&self, obj: &ObjId, key: &str) -> Option<String> {
        match self.doc.get(obj, key) {
            Ok(Some((v, _))) => v.as_str().map(str::to_owned),
            _ => None,
        }
    }

    fn text(&self, obj: &ObjId, key: &str) -> String {
        match self.doc.get(obj, key) {
            Ok(Some((Value::Object(ObjType::Text), id))) => self.doc.text(&id).unwrap_or_default(),
            Ok(Some((v, _))) => v.as_str().unwrap_or_default().to_owned(),
            _ => String::new(),
        }
    }

    fn read_task(&self, tasks: &ObjId, id: &str) -> Option<TaskData> {
        let t = self.obj(tasks, id)?;
        let s = |k: &str| self.str(&t, k).unwrap_or_default();
        let number = match self.doc.get(&t, "number") {
            Ok(Some((v, _))) => v.as_i64().unwrap_or(0),
            _ => 0,
        };
        let deleted = match self.doc.get(&t, "deleted") {
            Ok(Some((v, _))) => v.as_bool().unwrap_or(false),
            _ => false,
        };
        Some(TaskData {
            id: id.to_owned(),
            number,
            title: self.text(&t, "title"),
            description: self.text(&t, "description"),
            column: ColumnId::parse(&s("column")).unwrap_or(ColumnId::Todo),
            rank: s("rank"),
            assignee: self.str(&t, "assignee"),
            due: self.str(&t, "due"),
            priority: Priority::parse(&s("priority")).unwrap_or_default(),
            labels: self.labels(&t),
            created_by: s("created_by"),
            created_at: s("created_at"),
            updated_at: s("updated_at"),
            deleted,
            comments: self.comments(&t),
            activity: self.activity(&t),
            subtasks: self.subtasks(&t),
            time: self.time(&t),
        })
    }

    fn bool(&self, obj: &ObjId, key: &str) -> Option<bool> {
        match self.doc.get(obj, key) {
            Ok(Some((v, _))) => v.as_bool(),
            _ => None,
        }
    }

    /// `(id, object)` of every entry in the maps at `key` of `task`, an id
    /// found in more than one map only once (the winning map first).
    fn entries(&self, task: &ObjId, key: &str) -> Vec<(String, ObjId)> {
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for map in self.maps_at(task, key) {
            for id in self.doc.keys(&map) {
                if let Some(e) = self.obj(&map, &id)
                    && seen.insert(id.clone())
                {
                    out.push((id, e));
                }
            }
        }
        out
    }

    fn subtasks(&self, task: &ObjId) -> Vec<SubtaskData> {
        let mut out: Vec<SubtaskData> = self
            .entries(task, SUBTASKS)
            .into_iter()
            .map(|(id, s)| SubtaskData {
                title: self.str(&s, "title").unwrap_or_default(),
                done: self.bool(&s, "done").unwrap_or(false),
                rank: self.str(&s, "rank").unwrap_or_default(),
                assignee: self.str(&s, "assignee"),
                done_by: self.str(&s, "done_by"),
                done_at: self.str(&s, "done_at"),
                created_by: self.str(&s, "created_by").unwrap_or_default(),
                created_at: self.str(&s, "created_at").unwrap_or_default(),
                deleted: self.bool(&s, "deleted").unwrap_or(false),
                id,
            })
            .collect();
        out.sort_by(|a, b| (&a.rank, &a.id).cmp(&(&b.rank, &b.id)));
        out
    }

    fn time(&self, task: &ObjId) -> Vec<TimeData> {
        let mut out: Vec<TimeData> = self
            .entries(task, TIME)
            .into_iter()
            .map(|(id, e)| TimeData {
                by: self.str(&e, "by").unwrap_or_default(),
                start: self.str(&e, "start").unwrap_or_default(),
                end: self.str(&e, "end"),
                manual: self.bool(&e, "manual").unwrap_or(false),
                note: self.str(&e, "note").unwrap_or_default(),
                deleted: self.bool(&e, "deleted").unwrap_or(false),
                id,
            })
            .collect();
        out.sort_by(|a, b| (&a.start, &a.id).cmp(&(&b.start, &b.id)));
        out
    }

    fn labels(&self, task: &ObjId) -> Vec<String> {
        let Some(list) = self.obj(task, "labels") else {
            return Vec::new();
        };
        let mut out: Vec<String> = Vec::new();
        for i in 0..self.doc.length(&list) {
            if let Ok(Some((v, _))) = self.doc.get(&list, i)
                && let Some(l) = v.as_str()
            {
                let lower = l.to_lowercase();
                if !out.iter().any(|x| x.to_lowercase() == lower) {
                    out.push(l.to_owned());
                }
            }
        }
        out.truncate(LABELS_MAX);
        out
    }

    fn comments(&self, task: &ObjId) -> Vec<CommentData> {
        let Some(map) = self.obj(task, "comments") else {
            return Vec::new();
        };
        let mut out: Vec<CommentData> = self
            .doc
            .keys(&map)
            .filter_map(|id| {
                let c = self.obj(&map, &id)?;
                Some(CommentData {
                    author: self.str(&c, "author").unwrap_or_default(),
                    at: self.str(&c, "at").unwrap_or_default(),
                    body: self.str(&c, "body").unwrap_or_default(),
                    id,
                })
            })
            .collect();
        out.sort_by(|a, b| (&a.at, &a.id).cmp(&(&b.at, &b.id)));
        out
    }

    fn activity(&self, task: &ObjId) -> Vec<ActivityData> {
        let Some(list) = self.obj(task, "activity") else {
            return Vec::new();
        };
        (0..self.doc.length(&list))
            .filter_map(|i| match self.doc.get(&list, i) {
                Ok(Some((Value::Object(ObjType::Map), e))) => Some(ActivityData {
                    at: self.str(&e, "at").unwrap_or_default(),
                    actor: self.str(&e, "actor").unwrap_or_default(),
                    kind: self.str(&e, "kind").unwrap_or_default(),
                    detail: self.str(&e, "detail").unwrap_or_default(),
                }),
                _ => None,
            })
            .collect()
    }
}

/// Type of a value as far as [`BoardDoc::check_shape`] cares.
#[derive(Debug, PartialEq, Eq)]
enum Field {
    Obj(ObjType),
    Str(String),
    Int(i64),
    Bool(bool),
    Null,
    Other,
}

/// Checks one subtask or time entry, given its fields.
type ShapeCheck = fn(&dyn Fn(&str) -> Option<Field>) -> bool;

fn subtask_shape_ok(f: &dyn Fn(&str) -> Option<Field>) -> bool {
    let is_str = |k: &str| matches!(f(k), Some(Field::Str(_)));
    let str_or_null = |k: &str| matches!(f(k), Some(Field::Str(_) | Field::Null));
    let is_bool = |k: &str| matches!(f(k), Some(Field::Bool(_)));
    is_str("nonce")
        && is_str("title")
        && is_bool("done")
        && is_str("rank")
        && str_or_null("assignee")
        && str_or_null("done_by")
        && str_or_null("done_at")
        && is_str("created_by")
        && is_str("created_at")
        && is_bool("deleted")
}

fn time_shape_ok(f: &dyn Fn(&str) -> Option<Field>) -> bool {
    let is_str = |k: &str| matches!(f(k), Some(Field::Str(_)));
    let is_bool = |k: &str| matches!(f(k), Some(Field::Bool(_)));
    is_str("nonce")
        && is_str("by")
        && is_str("start")
        && matches!(f("end"), Some(Field::Str(_) | Field::Null))
        && is_bool("manual")
        && is_str("note")
        && is_bool("deleted")
}

fn check_room_for_entry(task: &TaskData) -> AppResult<()> {
    if task.time.iter().filter(|e| !e.deleted).count() >= TIME_ENTRIES_MAX {
        return Err(AppError::InvalidInput(format!(
            "Task ini sudah punya {TIME_ENTRIES_MAX} catatan waktu, batas paling banyak. Hapus catatan lama yang tidak perlu, atau catat waktunya di task lain."
        )));
    }
    Ok(())
}

fn opt_scalar(v: Option<&str>) -> ScalarValue {
    v.map_or(ScalarValue::Null, ScalarValue::from)
}

/// Replaces the whole list, so concurrent label edits resolve to one of them
/// instead of a mix of both.
fn put_labels(doc: &mut AutoCommit, task: &ObjId, labels: &[String]) -> AppResult<()> {
    let list = doc.put_object(task, "labels", ObjType::List).map_err(am)?;
    for (i, l) in labels.iter().enumerate() {
        doc.insert(&list, i, l.as_str()).map_err(am)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: [u8; 32] = [1; 32];
    const B: [u8; 32] = [2; 32];

    fn stamp(at: &str) -> Stamp<'_> {
        Stamp { actor: "aa", at }
    }

    fn meta() -> ProjectMeta {
        ProjectMeta {
            id: "0".repeat(32),
            code: "PA".into(),
            name: "Proyek A".into(),
            team_id: None,
        }
    }

    fn new_doc() -> BoardDoc {
        let mut d = BoardDoc::create(&A, &meta()).unwrap();
        d.commit(0).unwrap();
        d
    }

    fn init(title: &str) -> TaskInit {
        TaskInit {
            title: title.into(),
            ..Default::default()
        }
    }

    fn column_ids(d: &BoardDoc, c: ColumnId) -> Vec<String> {
        d.tasks()
            .unwrap()
            .into_iter()
            .filter(|t| !t.deleted && t.column == c)
            .map(|t| t.title)
            .collect()
    }

    #[test]
    fn create_reads_back_and_numbers_increase() {
        let mut d = new_doc();
        assert_eq!(d.project(), meta());
        let a = d.create_task(stamp("t1"), init("Satu")).unwrap();
        let b = d
            .create_task(
                stamp("t2"),
                TaskInit {
                    title: "Dua".into(),
                    description: "isi".into(),
                    column: Some(ColumnId::Doing),
                    assignee: Some("bb".into()),
                    due: Some("2026-11-28".into()),
                    priority: Priority::High,
                    labels: vec!["Web".into()],
                },
            )
            .unwrap();
        d.commit(0).unwrap();
        let ta = d.live_task(&a).unwrap();
        let tb = d.live_task(&b).unwrap();
        assert_eq!((ta.number, tb.number), (1, 2));
        assert_eq!(ta.column, ColumnId::Todo);
        assert_eq!(ta.assignee, None);
        assert_eq!(tb.title, "Dua");
        assert_eq!(tb.description, "isi");
        assert_eq!(tb.assignee.as_deref(), Some("bb"));
        assert_eq!(tb.due.as_deref(), Some("2026-11-28"));
        assert_eq!(tb.priority, Priority::High);
        assert_eq!(tb.labels, vec!["Web"]);
        assert_eq!(tb.activity.len(), 1);
        assert_eq!(tb.activity[0].kind, kind::CREATED);
        assert_eq!(tb.activity[0].detail, "Dikerjakan");
        assert_eq!(tb.created_by, "aa");
    }

    #[test]
    fn new_tasks_go_to_the_bottom() {
        let mut d = new_doc();
        for t in ["a", "b", "c"] {
            d.create_task(stamp("t"), init(t)).unwrap();
        }
        assert_eq!(column_ids(&d, ColumnId::Todo), ["a", "b", "c"]);
    }

    #[test]
    fn update_only_logs_real_changes() {
        let mut d = new_doc();
        let id = d.create_task(stamp("t1"), init("Satu")).unwrap();
        let names = |pk: &str| format!("nama-{pk}");
        let changes = TaskChanges {
            title: Some("Satu".into()),
            description: Some("baru".into()),
            assignee: Some(Some("bb".into())),
            due: Some(None),
            priority: Some(Priority::Low),
            labels: Some(vec!["X".into(), "Y".into()]),
        };
        d.update_task(stamp("t2"), &id, &changes, &names).unwrap();
        let t = d.live_task(&id).unwrap();
        let kinds: Vec<_> = t.activity.iter().map(|a| a.kind.as_str()).collect();
        assert_eq!(
            kinds,
            [
                kind::CREATED,
                kind::DESCRIPTION,
                kind::ASSIGNEE,
                kind::PRIORITY,
                kind::LABELS
            ]
        );
        assert_eq!(t.activity[2].detail, "nama-bb");
        assert_eq!(t.activity[3].detail, "Rendah");
        assert_eq!(t.activity[4].detail, "X, Y");
        assert_eq!(t.updated_at, "t2");
        assert_eq!(t.labels, ["X", "Y"]);

        d.commit(0);
        d.update_task(stamp("t3"), &id, &changes, &names).unwrap();
        assert_eq!(d.commit(0), None, "nothing changed, no change");
        d.update_task(
            stamp("t4"),
            &id,
            &TaskChanges {
                assignee: Some(None),
                ..Default::default()
            },
            &names,
        )
        .unwrap();
        let t = d.live_task(&id).unwrap();
        assert_eq!(t.assignee, None);
        assert_eq!(t.activity.last().unwrap().detail, "");
    }

    #[test]
    fn move_within_and_across_columns() {
        let mut d = new_doc();
        let ids: Vec<String> = ["a", "b", "c"]
            .iter()
            .map(|t| d.create_task(stamp("t"), init(t)).unwrap())
            .collect();
        d.move_task(stamp("t"), &ids[2], ColumnId::Todo, 0).unwrap();
        assert_eq!(column_ids(&d, ColumnId::Todo), ["c", "a", "b"]);
        d.move_task(stamp("t"), &ids[2], ColumnId::Todo, 1).unwrap();
        assert_eq!(column_ids(&d, ColumnId::Todo), ["a", "c", "b"]);
        d.move_task(stamp("t"), &ids[0], ColumnId::Doing, 5)
            .unwrap();
        assert_eq!(column_ids(&d, ColumnId::Doing), ["a"]);
        assert_eq!(column_ids(&d, ColumnId::Todo), ["c", "b"]);
        d.move_task(stamp("t"), &ids[1], ColumnId::Doing, 0)
            .unwrap();
        assert_eq!(column_ids(&d, ColumnId::Doing), ["b", "a"]);
        let a = d.live_task(&ids[0]).unwrap();
        assert_eq!(a.activity.last().unwrap().kind, kind::MOVED);
        assert_eq!(a.activity.last().unwrap().detail, "Dikerjakan");
        let c = d.live_task(&ids[2]).unwrap();
        assert_eq!(
            c.activity.len(),
            1,
            "reorder in the same column is not logged"
        );
    }

    #[test]
    fn move_to_same_place_is_a_no_op() {
        let mut d = new_doc();
        let a = d.create_task(stamp("t"), init("a")).unwrap();
        d.create_task(stamp("t"), init("b")).unwrap();
        d.commit(0).unwrap();
        d.move_task(stamp("t"), &a, ColumnId::Todo, 0).unwrap();
        assert_eq!(d.commit(0), None);
    }

    #[test]
    fn move_one_write_in_common_case() {
        let mut d = new_doc();
        let ids: Vec<String> = ["a", "b", "c"]
            .iter()
            .map(|t| d.create_task(stamp("t"), init(t)).unwrap())
            .collect();
        d.commit(0).unwrap();
        let before: Vec<String> = d.tasks().unwrap().into_iter().map(|t| t.rank).collect();
        d.move_task(stamp("t"), &ids[2], ColumnId::Todo, 1).unwrap();
        let after: Vec<(String, String)> = d
            .tasks()
            .unwrap()
            .into_iter()
            .map(|t| (t.id, t.rank))
            .collect();
        let changed = after.iter().filter(|(_, r)| !before.contains(r)).count();
        assert_eq!(changed, 1);
    }

    #[test]
    fn equal_ranks_are_renumbered() {
        let mut d = new_doc();
        let ids: Vec<String> = ["a", "b", "c"]
            .iter()
            .map(|t| d.create_task(stamp("t"), init(t)).unwrap())
            .collect();
        let tasks = d.tasks_obj().unwrap();
        for id in &ids {
            let t = d.obj(&tasks, id).unwrap();
            d.doc.put(&t, "rank", "V").unwrap();
        }
        let mut sorted = ids.clone();
        sorted.sort();
        // Move the last (by id) between the first two.
        d.move_task(stamp("t"), &sorted[2], ColumnId::Todo, 1)
            .unwrap();
        let order: Vec<String> = d.tasks().unwrap().into_iter().map(|t| t.id).collect();
        assert_eq!(
            order,
            [sorted[0].clone(), sorted[2].clone(), sorted[1].clone()]
        );
        let ranks: Vec<String> = d.tasks().unwrap().into_iter().map(|t| t.rank).collect();
        assert!(ranks.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn delete_and_comment() {
        let mut d = new_doc();
        let id = d.create_task(stamp("t1"), init("a")).unwrap();
        let c2 = d.add_comment(stamp("t3"), &id, "kedua").unwrap();
        let c1 = d.add_comment(stamp("t2"), &id, "pertama").unwrap();
        let t = d.live_task(&id).unwrap();
        assert_eq!(
            t.comments.iter().map(|c| c.id.clone()).collect::<Vec<_>>(),
            [c1, c2]
        );
        assert_eq!(t.comments[0].body, "pertama");
        assert_eq!(t.activity.last().unwrap().kind, kind::COMMENTED);
        d.delete_task(stamp("t4"), &id).unwrap();
        assert_eq!(d.live_task(&id).unwrap_err().code(), "not_found");
        let t = d.task(&id).unwrap().unwrap();
        assert!(t.deleted);
        assert_eq!(t.activity.last().unwrap().kind, kind::DELETED);
        assert_eq!(
            d.delete_task(stamp("t5"), &id).unwrap_err().code(),
            "not_found"
        );
        assert_eq!(
            d.add_comment(stamp("t5"), &id, "x").unwrap_err().code(),
            "not_found"
        );
        assert_eq!(d.live_task("nope").unwrap_err().code(), "not_found");
    }

    #[test]
    fn concurrent_text_edits_merge() {
        let mut a = new_doc();
        let id = a.create_task(stamp("t"), init("Judul")).unwrap();
        a.update_task(
            stamp("t"),
            &id,
            &TaskChanges {
                description: Some("Halo dunia".into()),
                ..Default::default()
            },
            &|s| s.to_owned(),
        )
        .unwrap();
        a.commit(0).unwrap();
        let snapshot = a.save();
        let mut b = BoardDoc::load(&snapshot, &B).unwrap();
        let base = a.heads();

        let edit = |d: &mut BoardDoc, text: &str| {
            d.update_task(
                stamp("t"),
                &id,
                &TaskChanges {
                    description: Some(text.into()),
                    ..Default::default()
                },
                &|s| s.to_owned(),
            )
            .unwrap();
            d.commit(0).unwrap();
        };
        edit(&mut a, "Halo dunia!");
        edit(&mut b, "Wah, Halo dunia");
        for c in a.changes_after(&base) {
            b.apply(c).unwrap();
        }
        for c in b.changes_after(&base) {
            if !a.has_change(&c.hash()) {
                a.apply(c).unwrap();
            }
        }
        let ta = a.live_task(&id).unwrap();
        assert_eq!(ta.description, "Wah, Halo dunia!");
        assert_eq!(ta, b.live_task(&id).unwrap());
    }

    #[test]
    fn renumber_moves_next_number_and_logs_old_code() {
        let mut d = new_doc();
        let a = d.create_task(stamp("t1"), init("a")).unwrap();
        d.create_task(stamp("t1"), init("b")).unwrap();
        assert_eq!(d.fresh_number().unwrap(), 3);
        d.commit(0).unwrap();
        d.renumber_task(stamp("t2"), &a, 7, "PA-1").unwrap();
        let t = d.live_task(&a).unwrap();
        assert_eq!(t.number, 7);
        assert_eq!(t.updated_at, "t2");
        let last = t.activity.last().unwrap();
        assert_eq!(
            (last.kind.as_str(), last.detail.as_str()),
            (kind::RENUMBERED, "PA-1")
        );
        assert_eq!(d.fresh_number().unwrap(), 8);
        d.commit(0).unwrap();
        d.renumber_task(stamp("t3"), &a, 7, "PA-7").unwrap();
        assert_eq!(d.commit(0), None, "same number, nothing staged");
        let c = d.create_task(stamp("t4"), init("c")).unwrap();
        assert_eq!(d.live_task(&c).unwrap().number, 8);
        d.delete_task(stamp("t5"), &c).unwrap();
        assert_eq!(
            d.renumber_task(stamp("t6"), &c, 9, "PA-8")
                .unwrap_err()
                .code(),
            "not_found"
        );
    }

    #[test]
    fn renumbering_by_another_laptop_keeps_the_shape() {
        let mut a = new_doc();
        let id = a
            .create_task(
                Stamp {
                    actor: &hex::encode(A),
                    at: "t1",
                },
                init("a"),
            )
            .unwrap();
        a.commit(0).unwrap();
        let base = a.heads();
        let mut b = BoardDoc::load(&a.save(), &B).unwrap();
        b.renumber_task(
            Stamp {
                actor: &hex::encode(B),
                at: "t2",
            },
            &id,
            5,
            "PA-1",
        )
        .unwrap();
        b.rename_project("Proyek Baru").unwrap();
        b.commit(0).unwrap();
        for c in b.changes_after(&base) {
            a.apply_remote(c, &hex::encode(B)).unwrap();
        }
        assert_eq!(a.live_task(&id).unwrap().number, 5);
        assert_eq!(a.project().name, "Proyek Baru");
        assert_eq!(a.fresh_number().unwrap(), 6);
    }

    fn nonce(d: &BoardDoc, obj: &ObjId) -> Option<String> {
        d.str(obj, "nonce")
    }

    #[test]
    fn task_and_comment_ids_are_bound_to_their_author() {
        let mut d = new_doc();
        let id = d.create_task(stamp("t1"), init("a")).unwrap();
        let cid = d.add_comment(stamp("t2"), &id, "halo").unwrap();
        let t = d.task_obj(&id).unwrap();
        let n = nonce(&d, &t).unwrap();
        assert!(crate::org::is_lower_hex(&n, 32));
        assert_eq!(id, derive_task_id("aa", &n));
        let c = d.obj(&d.obj(&t, "comments").unwrap(), &cid).unwrap();
        let cn = nonce(&d, &c).unwrap();
        assert_eq!(cid, derive_comment_id("aa", &cn));
        assert_ne!(n, cn);
        assert!(is_bound_id(derive_task_id, &id, "aa", Some(&n)));
        assert!(!is_bound_id(derive_task_id, &id, "bb", Some(&n)));
        assert!(!is_bound_id(derive_comment_id, &id, "aa", Some(&n)));
        assert!(!is_bound_id(derive_task_id, &id, "aa", None));
        // Fixed inputs give a fixed id, on every laptop and version.
        assert_eq!(derive_task_id("aa", "00"), derive_task_id("aa", "00"));
        assert_eq!(derive_task_id("aa", "00").len(), 32);
        assert_ne!(derive_task_id("aa", "00"), derive_comment_id("aa", "00"));
    }

    #[test]
    fn a_remote_task_at_an_unbound_id_breaks_the_shape() {
        let mut a = new_doc();
        let base = a.heads();
        let b_hex = hex::encode(B);
        let wrong: [(&str, Option<ScalarValue>); 3] = [
            ("nonce lain", Some(random_id().as_str().into())),
            ("tanpa nonce", None),
            ("nonce bukan teks", Some(5_i64.into())),
        ];
        for (label, value) in wrong {
            let mut b = BoardDoc::load(&a.save(), &B).unwrap();
            let id = b
                .create_task(Stamp { actor: &b_hex, at: "t1" }, init("x"))
                .unwrap();
            let t = b.task_obj(&id).unwrap();
            match value {
                Some(v) => b.doc.put(&t, "nonce", v).unwrap(),
                None => b.doc.delete(&t, "nonce").unwrap(),
            }
            b.commit(0).unwrap();
            let c = b.changes_after(&base).remove(0);
            let err = a.apply_remote(c, &b_hex).unwrap_err();
            assert_eq!(err.0, "board_invalid_doc", "{label}: {err:?}");
            assert_eq!(a.task(&id).unwrap(), None, "{label}: restored");
        }
        // The bound id is accepted.
        let mut b = BoardDoc::load(&a.save(), &B).unwrap();
        let id = b
            .create_task(Stamp { actor: &b_hex, at: "t1" }, init("x"))
            .unwrap();
        b.commit(0).unwrap();
        a.apply_remote(b.changes_after(&base).remove(0), &b_hex)
            .unwrap();
        assert!(a.live_task(&id).is_ok());
    }

    #[test]
    fn tasks_and_comments_without_a_nonce_are_still_read() {
        let mut d = new_doc();
        let id = d.create_task(stamp("t1"), init("lama")).unwrap();
        let cid = d.add_comment(stamp("t2"), &id, "komentar lama").unwrap();
        let t = d.task_obj(&id).unwrap();
        let c = d.obj(&d.obj(&t, "comments").unwrap(), &cid).unwrap();
        d.doc.delete(&t, "nonce").unwrap();
        d.doc.delete(&c, "nonce").unwrap();
        let task = d.live_task(&id).unwrap();
        assert_eq!(task.title, "lama");
        assert_eq!(task.comments[0].body, "komentar lama");
    }

    #[test]
    fn fresh_number_at_reads_the_past() {
        let mut d = new_doc();
        let first = d.heads();
        assert_eq!(d.fresh_number_at(&first), 1);
        let a = d.create_task(stamp("t1"), init("a")).unwrap();
        d.create_task(stamp("t1"), init("b")).unwrap();
        d.commit(0).unwrap();
        let second = d.heads();
        d.renumber_task(stamp("t2"), &a, 40, "PA-1").unwrap();
        d.doc.put(ROOT, "next_number", 3_i64).unwrap();
        d.commit(0).unwrap();
        let third = d.heads();
        assert_eq!(d.fresh_number_at(&first), 1);
        assert_eq!(d.fresh_number_at(&second), 3);
        assert_eq!(d.fresh_number_at(&third), 41);
        assert_eq!(d.fresh_number_at(&third), d.fresh_number().unwrap());
    }

    #[test]
    fn rename_project_only_stages_a_real_change() {
        let mut d = new_doc();
        d.rename_project("Proyek A").unwrap();
        assert_eq!(d.commit(0), None);
        d.rename_project("Proyek B").unwrap();
        assert!(d.commit(0).is_some());
        assert_eq!(d.project().name, "Proyek B");
        assert_eq!(d.project().code, "PA");
    }

    #[test]
    fn snapshot_round_trip_keeps_actor_sequence() {
        let mut d = new_doc();
        d.create_task(stamp("t"), init("a")).unwrap();
        d.commit(0).unwrap();
        let bytes = d.save();
        let mut again = BoardDoc::load(&bytes, &A).unwrap();
        assert_eq!(again.tasks().unwrap(), d.tasks().unwrap());
        again.create_task(stamp("t"), init("b")).unwrap();
        let h = again.commit(0).unwrap();
        let c = again.doc.get_change_by_hash(&h).unwrap();
        assert_eq!(c.seq(), 3);
        assert_eq!(c.actor_id().to_bytes(), &A);
    }

    // ---------------------------------------------------------------------
    // v0.4: subtasks and time entries.

    fn titles(d: &BoardDoc, id: &str) -> Vec<String> {
        d.live_task(id)
            .unwrap()
            .subtasks
            .into_iter()
            .filter(|s| !s.deleted)
            .map(|s| s.title)
            .collect()
    }

    fn sub(d: &BoardDoc, id: &str, sid: &str) -> SubtaskData {
        d.live_task(id)
            .unwrap()
            .subtasks
            .into_iter()
            .find(|s| s.id == sid)
            .unwrap()
    }

    /// Exchanges every change both ways.
    fn sync_both(a: &mut BoardDoc, b: &mut BoardDoc) {
        for c in a.changes_after(&[]) {
            if !b.has_change(&c.hash()) {
                b.apply(c).unwrap();
            }
        }
        for c in b.changes_after(&[]) {
            if !a.has_change(&c.hash()) {
                a.apply(c).unwrap();
            }
        }
        assert_eq!(a.heads(), b.heads());
    }

    fn by(actor: &'static str, at: &'static str) -> Stamp<'static> {
        Stamp { actor, at }
    }

    /// A committed task without `subtasks` and `time`, as made before v0.4.
    fn old_task(d: &mut BoardDoc) -> String {
        let id = d.create_task(stamp("t1"), init("Lama")).unwrap();
        let t = d.task_obj(&id).unwrap();
        d.doc.delete(&t, SUBTASKS).unwrap();
        d.doc.delete(&t, TIME).unwrap();
        d.commit(0).unwrap();
        id
    }

    #[test]
    fn new_tasks_get_empty_subtask_and_time_maps() {
        let mut d = new_doc();
        let id = d.create_task(stamp("t1"), init("a")).unwrap();
        let t = d.task_obj(&id).unwrap();
        for key in [SUBTASKS, TIME] {
            assert_eq!(d.field(&t, key), Some(Field::Obj(ObjType::Map)), "{key}");
        }
        let task = d.live_task(&id).unwrap();
        assert!(task.subtasks.is_empty() && task.time.is_empty());
    }

    #[test]
    fn subtasks_add_edit_tick_move_and_delete() {
        let mut d = new_doc();
        let id = d.create_task(stamp("t1"), init("a")).unwrap();
        let s1 = d.add_subtask(stamp("t2"), &id, "Satu", None).unwrap();
        let s2 = d.add_subtask(stamp("t3"), &id, "Dua", Some("bb")).unwrap();
        let s3 = d.add_subtask(stamp("t4"), &id, "Tiga", None).unwrap();
        assert_eq!(titles(&d, &id), ["Satu", "Dua", "Tiga"]);
        let t = d.live_task(&id).unwrap();
        assert_eq!(t.updated_at, "t4");
        let last = t.activity.last().unwrap();
        assert_eq!((last.kind.as_str(), last.detail.as_str()), (kind::SUBTASK_ADDED, "Tiga"));
        let first = sub(&d, &id, &s1);
        assert_eq!(first.created_by, "aa");
        assert_eq!(first.created_at, "t2");
        assert!(!first.done && first.done_by.is_none() && first.done_at.is_none());
        assert_eq!(sub(&d, &id, &s2).assignee.as_deref(), Some("bb"));
        let map = d.obj(&d.task_obj(&id).unwrap(), SUBTASKS).unwrap();
        let obj = d.obj(&map, &s1).unwrap();
        assert_eq!(s1, derive_subtask_id("aa", &nonce(&d, &obj).unwrap()));
        d.commit(0).unwrap();

        // Rename and tick in one go.
        let tick = SubtaskChanges {
            title: Some("Satu baru".into()),
            done: Some(true),
            ..Default::default()
        };
        d.update_subtask(stamp("t5"), &id, &s1, &tick).unwrap();
        let s = sub(&d, &id, &s1);
        assert_eq!(s.title, "Satu baru");
        assert!(s.done);
        assert_eq!((s.done_by.as_deref(), s.done_at.as_deref()), (Some("aa"), Some("t5")));
        let t = d.live_task(&id).unwrap();
        assert_eq!(t.updated_at, "t5");
        let last = t.activity.last().unwrap();
        assert_eq!((last.kind.as_str(), last.detail.as_str()), (kind::SUBTASK_DONE, "Satu baru"));
        d.commit(0).unwrap();
        d.update_subtask(stamp("t6"), &id, &s1, &tick).unwrap();
        assert_eq!(d.commit(0), None, "nothing changed, nothing staged");

        // Open it again, clear an assignee.
        let reopen = SubtaskChanges {
            done: Some(false),
            ..Default::default()
        };
        d.update_subtask(stamp("t7"), &id, &s1, &reopen).unwrap();
        let s = sub(&d, &id, &s1);
        assert!(!s.done && s.done_by.is_none() && s.done_at.is_none());
        assert_eq!(d.live_task(&id).unwrap().activity.last().unwrap().kind, kind::SUBTASK_REOPENED);
        let clear = SubtaskChanges {
            assignee: Some(None),
            ..Default::default()
        };
        d.update_subtask(stamp("t8"), &id, &s2, &clear).unwrap();
        assert_eq!(sub(&d, &id, &s2).assignee, None);

        // Move.
        d.move_subtask(stamp("t9"), &id, &s3, 0).unwrap();
        assert_eq!(titles(&d, &id), ["Tiga", "Satu baru", "Dua"]);
        d.commit(0).unwrap();
        d.move_subtask(stamp("t9"), &id, &s3, 0).unwrap();
        assert_eq!(d.commit(0), None, "same place, nothing staged");
        d.move_subtask(stamp("t10"), &id, &s3, 99).unwrap();
        assert_eq!(titles(&d, &id), ["Satu baru", "Dua", "Tiga"]);
        assert_eq!(d.live_task(&id).unwrap().updated_at, "t10");

        // Delete: kept as deleted, never edited again.
        d.delete_subtask(stamp("t11"), &id, &s2).unwrap();
        assert_eq!(titles(&d, &id), ["Satu baru", "Tiga"]);
        assert!(sub(&d, &id, &s2).deleted);
        let last = d.live_task(&id).unwrap().activity.last().unwrap().clone();
        assert_eq!((last.kind.as_str(), last.detail.as_str()), (kind::SUBTASK_DELETED, "Dua"));
        for err in [
            d.update_subtask(stamp("t12"), &id, &s2, &tick).unwrap_err(),
            d.delete_subtask(stamp("t12"), &id, &s2).unwrap_err(),
            d.move_subtask(stamp("t12"), &id, &s2, 0).unwrap_err(),
            d.delete_subtask(stamp("t12"), &id, "nope").unwrap_err(),
        ] {
            assert_eq!(err.code(), "not_found");
        }
        d.delete_task(stamp("t13"), &id).unwrap();
        assert_eq!(
            d.add_subtask(stamp("t14"), &id, "x", None).unwrap_err().code(),
            "not_found"
        );
    }

    #[test]
    fn at_most_a_hundred_live_subtasks() {
        let mut d = new_doc();
        let id = d.create_task(stamp("t1"), init("a")).unwrap();
        let mut first = String::new();
        for i in 0..SUBTASKS_MAX {
            let s = d.add_subtask(stamp("t"), &id, &format!("s{i}"), None).unwrap();
            if i == 0 {
                first = s;
            }
        }
        let err = d.add_subtask(stamp("t"), &id, "lagi", None).unwrap_err();
        assert_eq!(err.code(), "invalid_input");
        assert!(!err.to_string().contains('\u{2014}'));
        d.delete_subtask(stamp("t"), &id, &first).unwrap();
        d.add_subtask(stamp("t"), &id, "lagi", None).unwrap();
        assert_eq!(titles(&d, &id).len(), SUBTASKS_MAX);
    }

    /// A doc with a task holding subtasks "a", "b", "c", and its copy on B.
    fn two_laptops_with_subtasks() -> (BoardDoc, BoardDoc, String, Vec<String>) {
        let mut a = new_doc();
        let id = a.create_task(stamp("t1"), init("Tugas")).unwrap();
        let subs: Vec<String> = ["a", "b", "c"]
            .iter()
            .map(|t| a.add_subtask(stamp("t1"), &id, t, None).unwrap())
            .collect();
        a.commit(0).unwrap();
        let b = BoardDoc::load(&a.save(), &B).unwrap();
        (a, b, id, subs)
    }

    #[test]
    fn concurrent_tick_and_rename_both_survive() {
        let (mut a, mut b, id, subs) = two_laptops_with_subtasks();
        let tick = SubtaskChanges {
            done: Some(true),
            ..Default::default()
        };
        a.update_subtask(by("aa", "t2"), &id, &subs[0], &tick).unwrap();
        a.commit(0).unwrap();
        let rename = SubtaskChanges {
            title: Some("A baru".into()),
            ..Default::default()
        };
        b.update_subtask(by("bb", "t2"), &id, &subs[0], &rename).unwrap();
        b.commit(0).unwrap();
        sync_both(&mut a, &mut b);
        let s = sub(&a, &id, &subs[0]);
        assert!(s.done);
        assert_eq!(s.title, "A baru");
        assert_eq!(a.live_task(&id).unwrap(), b.live_task(&id).unwrap());
    }

    #[test]
    fn concurrent_delete_and_rename_stays_deleted() {
        let (mut a, mut b, id, subs) = two_laptops_with_subtasks();
        a.delete_subtask(by("aa", "t2"), &id, &subs[1]).unwrap();
        a.commit(0).unwrap();
        let rename = SubtaskChanges {
            title: Some("B baru".into()),
            done: Some(true),
            ..Default::default()
        };
        b.update_subtask(by("bb", "t2"), &id, &subs[1], &rename).unwrap();
        b.commit(0).unwrap();
        sync_both(&mut a, &mut b);
        for d in [&a, &b] {
            let s = sub(d, &id, &subs[1]);
            assert!(s.deleted);
            assert_eq!(s.title, "B baru");
            assert_eq!(titles(d, &id), ["a", "c"]);
        }
        assert_eq!(a.live_task(&id).unwrap(), b.live_task(&id).unwrap());
    }

    #[test]
    fn concurrent_moves_and_adds_converge_and_can_be_reordered() {
        let (mut a, mut b, id, subs) = two_laptops_with_subtasks();
        a.move_subtask(by("aa", "t2"), &id, &subs[2], 0).unwrap();
        a.add_subtask(by("aa", "t2"), &id, "dari A", None).unwrap();
        a.commit(0).unwrap();
        b.move_subtask(by("bb", "t2"), &id, &subs[0], 2).unwrap();
        b.add_subtask(by("bb", "t2"), &id, "dari B", None).unwrap();
        b.commit(0).unwrap();
        sync_both(&mut a, &mut b);
        let order = titles(&a, &id);
        assert_eq!(order, titles(&b, &id));
        assert_eq!(order.len(), 5);
        assert_eq!(a.live_task(&id).unwrap(), b.live_task(&id).unwrap());
    }

    #[test]
    fn equal_subtask_ranks_after_concurrent_adds_are_spread_by_a_move() {
        let (mut a, mut b, id, subs) = two_laptops_with_subtasks();
        let xa = a.add_subtask(by("aa", "t2"), &id, "x", None).unwrap();
        a.commit(0).unwrap();
        let xb = b.add_subtask(by("bb", "t2"), &id, "y", None).unwrap();
        b.commit(0).unwrap();
        sync_both(&mut a, &mut b);
        assert_eq!(sub(&a, &id, &xa).rank, sub(&a, &id, &xb).rank);
        // Between the two equal ranks: the list is renumbered.
        a.move_subtask(by("aa", "t3"), &id, &subs[0], 3).unwrap();
        assert_eq!(titles(&a, &id).iter().position(|t| t == "a"), Some(3));
        let ranks: Vec<String> = a
            .live_task(&id)
            .unwrap()
            .subtasks
            .into_iter()
            .map(|s| s.rank)
            .collect();
        assert!(ranks.windows(2).all(|w| w[0] < w[1]), "{ranks:?}");
    }

    #[test]
    fn both_laptops_making_the_maps_of_an_old_task_keep_everything() {
        let mut a = new_doc();
        let id = old_task(&mut a);
        let mut b = BoardDoc::load(&a.save(), &B).unwrap();
        let sa = a.add_subtask(by("aa", "2026-11-23T08:00:00Z"), &id, "Dari A", None).unwrap();
        a.log_time(by("aa", "2026-11-23T08:00:00Z"), &id, 600, "").unwrap();
        a.commit(0).unwrap();
        let sb = b.add_subtask(by("bb", "2026-11-23T08:00:00Z"), &id, "Dari B", None).unwrap();
        b.log_time(by("bb", "2026-11-23T08:00:00Z"), &id, 300, "").unwrap();
        b.commit(0).unwrap();
        sync_both(&mut a, &mut b);

        let t = a.task_obj(&id).unwrap();
        assert_eq!(a.doc.get_all(&t, SUBTASKS).unwrap().len(), 2, "a conflict");
        assert_eq!(a.doc.get_all(&t, TIME).unwrap().len(), 2, "a conflict");
        for d in [&a, &b] {
            let mut got = titles(d, &id);
            got.sort();
            assert_eq!(got, ["Dari A", "Dari B"]);
            assert_eq!(d.live_task(&id).unwrap().time.len(), 2);
        }
        assert_eq!(a.live_task(&id).unwrap(), b.live_task(&id).unwrap());

        // Each laptop edits the subtask of the other, whichever map it sits in.
        let tick = SubtaskChanges {
            done: Some(true),
            ..Default::default()
        };
        a.update_subtask(by("aa", "t3"), &id, &sb, &tick).unwrap();
        a.commit(0).unwrap();
        b.update_subtask(by("bb", "t3"), &id, &sa, &tick).unwrap();
        b.delete_time_entry(
            by("bb", "t3"),
            &id,
            &b.live_task(&id).unwrap().time.iter().find(|e| e.by == "bb").unwrap().id.clone(),
        )
        .unwrap();
        let sc = b.add_subtask(by("bb", "t3"), &id, "Ketiga", None).unwrap();
        b.commit(0).unwrap();
        sync_both(&mut a, &mut b);
        for d in [&a, &b] {
            assert!(sub(d, &id, &sa).done && sub(d, &id, &sb).done);
            assert_eq!(titles(d, &id).len(), 3);
            assert!(!sub(d, &id, &sc).deleted);
            let live: Vec<_> = d.live_task(&id).unwrap().time.into_iter().filter(|e| !e.deleted).collect();
            assert_eq!(live.len(), 1);
            assert_eq!(live[0].by, "aa");
        }
        assert_eq!(a.live_task(&id).unwrap(), b.live_task(&id).unwrap());
    }

    #[test]
    fn timers_start_stop_log_and_delete() {
        let mut d = new_doc();
        let x = d.create_task(stamp("t0"), init("x")).unwrap();
        let y = d.create_task(stamp("t0"), init("y")).unwrap();
        d.commit(0).unwrap();

        let e1 = d.start_timer(by("aa", "2026-11-23T08:00:00Z"), &x).unwrap();
        let e = &d.live_task(&x).unwrap().time[0];
        assert_eq!(e.id, e1);
        assert!(e.is_running() && !e.manual);
        assert_eq!((e.by.as_str(), e.start.as_str()), ("aa", "2026-11-23T08:00:00Z"));
        let map = d.obj(&d.task_obj(&x).unwrap(), TIME).unwrap();
        let obj = d.obj(&map, &e1).unwrap();
        assert_eq!(e1, derive_time_id("aa", &nonce(&d, &obj).unwrap()));
        d.commit(0).unwrap();
        assert_eq!(d.start_timer(by("aa", "2026-11-23T08:10:00Z"), &x).unwrap(), e1);
        assert_eq!(d.commit(0), None, "already running, nothing staged");

        // Someone else's timer on x keeps running when aa moves to y.
        let other = d.start_timer(by("bb", "2026-11-23T08:05:00Z"), &x).unwrap();
        let e2 = d.start_timer(by("aa", "2026-11-23T08:30:00Z"), &y).unwrap();
        let tx = d.live_task(&x).unwrap();
        let first = tx.time.iter().find(|e| e.id == e1).unwrap();
        assert_eq!(first.end.as_deref(), Some("2026-11-23T08:30:00Z"));
        assert!(tx.time.iter().find(|e| e.id == other).unwrap().is_running());
        let last = tx.activity.last().unwrap();
        assert_eq!((last.kind.as_str(), last.detail.as_str()), (kind::TIME_LOGGED, "1800"));
        assert_eq!(tx.updated_at, "t0", "timers do not touch updated_at");
        assert_eq!(
            d.stop_timer(by("aa", "2026-11-23T08:40:00Z"), &x, "").unwrap_err().code(),
            "invalid_input"
        );

        d.stop_timer(by("aa", "2026-11-23T09:00:00Z"), &y, "rapat").unwrap();
        let ty = d.live_task(&y).unwrap();
        let stopped = ty.time.iter().find(|e| e.id == e2).unwrap();
        assert_eq!(stopped.end.as_deref(), Some("2026-11-23T09:00:00Z"));
        assert_eq!(stopped.note, "rapat");
        assert_eq!(ty.activity.last().unwrap().detail, "1800");

        let m = d.log_time(by("aa", "2026-11-23T10:00:00Z"), &x, 900, "manual").unwrap();
        let tx = d.live_task(&x).unwrap();
        let manual = tx.time.iter().find(|e| e.id == m).unwrap();
        assert!(manual.manual);
        assert_eq!(manual.start, "2026-11-23T09:45:00Z");
        assert_eq!(manual.end.as_deref(), Some("2026-11-23T10:00:00Z"));
        assert_eq!(manual.note, "manual");
        assert_eq!(tx.activity.last().unwrap().detail, "900");
        assert_eq!(tx.updated_at, "t0");
        assert_eq!(
            d.log_time(stamp("bukan waktu"), &x, 60, "").unwrap_err().code(),
            "internal"
        );

        // Only the owner deletes an entry; a deleted one is gone.
        let err = d.delete_time_entry(by("bb", "t"), &x, &m).unwrap_err();
        assert_eq!(err.code(), "forbidden");
        d.delete_time_entry(by("aa", "t"), &x, &m).unwrap();
        assert!(d.live_task(&x).unwrap().time.iter().find(|e| e.id == m).unwrap().deleted);
        assert_eq!(
            d.delete_time_entry(by("aa", "t"), &x, &m).unwrap_err().code(),
            "not_found"
        );
        // A deleted running timer is not running.
        d.delete_time_entry(by("bb", "t"), &x, &other).unwrap();
        assert!(d.live_task(&x).unwrap().time.iter().all(|e| !e.is_running()));
    }

    #[test]
    fn remote_subtasks_and_entries_of_the_wrong_shape_are_refused() {
        let mut a = new_doc();
        let id = d_task(&mut a);
        let base = a.heads();
        let b_hex = hex::encode(B);
        // Subtask with `done` as text.
        let mut b = BoardDoc::load(&a.save(), &B).unwrap();
        let sid = b.add_subtask(Stamp { actor: &b_hex, at: "t" }, &id, "x", None).unwrap();
        let t = b.task_obj(&id).unwrap();
        let s = b.entry_obj(&t, SUBTASKS, &sid).unwrap();
        b.doc.put(&s, "done", "ya").unwrap();
        b.commit(0).unwrap();
        let err = a.apply_remote(b.changes_after(&base).remove(0), &b_hex).unwrap_err();
        assert_eq!(err.0, "board_invalid_doc");
        assert!(a.live_task(&id).unwrap().subtasks.is_empty(), "restored");
        // Time entry without `by`.
        let mut b = BoardDoc::load(&a.save(), &B).unwrap();
        let eid = b.start_timer(Stamp { actor: &b_hex, at: "t" }, &id).unwrap();
        let t = b.task_obj(&id).unwrap();
        let e = b.entry_obj(&t, TIME, &eid).unwrap();
        b.doc.delete(&e, "by").unwrap();
        b.commit(0).unwrap();
        let err = a.apply_remote(b.changes_after(&base).remove(0), &b_hex).unwrap_err();
        assert_eq!(err.0, "board_invalid_doc");
        // `subtasks` that is not a map, on a new task.
        let mut b = BoardDoc::load(&a.save(), &B).unwrap();
        let nid = b.create_task(Stamp { actor: &b_hex, at: "t" }, init("n")).unwrap();
        let t = b.task_obj(&nid).unwrap();
        b.doc.put(&t, SUBTASKS, 5).unwrap();
        b.commit(0).unwrap();
        let err = a.apply_remote(b.changes_after(&base).remove(0), &b_hex).unwrap_err();
        assert_eq!(err.0, "board_invalid_doc");
        // The real thing is accepted, also on a task without the maps.
        let mut b = BoardDoc::load(&a.save(), &B).unwrap();
        let old = old_task_by(&mut b, &b_hex);
        b.add_subtask(Stamp { actor: &b_hex, at: "t" }, &id, "x", None).unwrap();
        b.add_subtask(Stamp { actor: &b_hex, at: "t" }, &old, "y", None).unwrap();
        b.start_timer(Stamp { actor: &b_hex, at: "2026-11-23T08:00:00Z" }, &old).unwrap();
        b.commit(0).unwrap();
        for c in b.changes_after(&base) {
            a.apply_remote(c, &b_hex).unwrap();
        }
        assert_eq!(titles(&a, &id), ["x"]);
        assert_eq!(titles(&a, &old), ["y"]);
    }

    fn d_task(d: &mut BoardDoc) -> String {
        let id = d.create_task(stamp("t1"), init("a")).unwrap();
        d.commit(0).unwrap();
        id
    }

    /// Like [`old_task`], by `actor`.
    fn old_task_by(d: &mut BoardDoc, actor: &str) -> String {
        let id = d.create_task(Stamp { actor, at: "t" }, init("Lama")).unwrap();
        let t = d.task_obj(&id).unwrap();
        d.doc.delete(&t, SUBTASKS).unwrap();
        d.doc.delete(&t, TIME).unwrap();
        d.commit(0).unwrap();
        id
    }
}
