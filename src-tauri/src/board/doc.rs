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
//!     number, title: Text, description: Text, column, rank,
//!     assignee (str or null), due (str or null), priority, labels: List<str>,
//!     created_by, created_at, updated_at, deleted,
//!     comments: Map<comment_id> { author, at, body },
//!     activity: List<{ at, actor, kind, detail }>
//!   }
//! ```
//!
//! Mutations only stage operations; `store::commit_local` turns them into one
//! signed change. Reads are lenient: a document merged from other laptops may
//! hold unexpected values, which fall back to defaults instead of failing.
//! The document actor is the laptop's 32-byte public key, so the author of a
//! change can be checked against its signer (`sign.rs`).

use std::collections::HashMap;

use automerge::transaction::Transactable;
use automerge::{
    ActorId, AutoCommit, AutomergeError, Change, ChangeHash, ObjId, ObjType, ROOT, ReadDoc,
    ScalarValue, Value,
};
use rand_core::{OsRng, RngCore};
use serde::Serialize;

use super::model::{ColumnId, LABELS_MAX, Priority};
use super::rank;
use crate::error::{AppError, AppResult};

pub const DOC_VERSION: i64 = 1;

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

fn am(err: AutomergeError) -> AppError {
    AppError::Internal(format!("Dokumen board tidak bisa diproses. Detail: {err}"))
}

fn task_not_found() -> AppError {
    AppError::NotFound("Task tidak ditemukan. Mungkin sudah dihapus.".into())
}

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
            && matches!(self.field(&ROOT, "next_number"), Some(Field::Int(_)))
            && matches!(self.field(&ROOT, "project"), Some(Field::Obj(ObjType::Map)))
            && matches!(self.field(&ROOT, "tasks"), Some(Field::Obj(ObjType::Map)));
        if !root_ok {
            return Err("struktur utama dokumen board rusak".into());
        }
        let tasks = self.tasks_obj().map_err(|e| e.to_string())?;
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
            let fields_ok = matches!(f("number"), Some(Field::Int(_)))
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
                && matches!(f("deleted"), Some(Field::Bool(_)));
            if !fields_ok {
                return bad("isian wajib hilang atau jenisnya salah");
            }
            let created_by = self.str(&t, "created_by").unwrap_or_default();
            let deleted = f("deleted") == Some(Field::Bool(true));
            match before.get(&id) {
                Some((was_by, _)) if *was_by != created_by => return bad("pembuat task diubah"),
                Some((_, true)) if !deleted => return bad("task yang dihapus dimunculkan lagi"),
                None if created_by != author => {
                    return bad("task baru dibuat atas nama laptop lain");
                }
                _ => {}
            }
        }
        Ok(())
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

        let id = random_id();
        let d = &mut self.doc;
        d.put(ROOT, "next_number", number + 1).map_err(am)?;
        let t = d
            .put_object(&tasks, id.as_str(), ObjType::Map)
            .map_err(am)?;
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
        Ok(self.next_number()?.max(max_number.saturating_add(1)).max(1))
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
        let comment_id = random_id();
        let c = self
            .doc
            .put_object(&comments, comment_id.as_str(), ObjType::Map)
            .map_err(am)?;
        self.doc.put(&c, "author", stamp.actor).map_err(am)?;
        self.doc.put(&c, "at", stamp.at).map_err(am)?;
        self.doc.put(&c, "body", body).map_err(am)?;
        self.doc.put(&t, "updated_at", stamp.at).map_err(am)?;
        self.log(&t, stamp, kind::COMMENTED, "")?;
        Ok(comment_id)
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
        })
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
}
