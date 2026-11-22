//! What one change from another laptop is allowed to do, judged from the
//! operations inside it (docs/plans/sinkron-board.md, "Konflik").
//!
//! Judging the operations, not the merged result, keeps the outcome the same
//! on every laptop whatever order changes arrive in: the objects an operation
//! touches were created by changes it depends on, so every laptop classifies
//! them the same way (by where they were created, visible or not).
//!
//! Allowed, per object (A = the change's author):
//!
//! | Object | Allowed |
//! |---|---|
//! | root | put `next_number` (integer up to the number ceiling + 1) |
//! | `project` | put `name` or `code` (needs the manage right) |
//! | `tasks` | make a map at a key that is not a task yet (a new task, its id bound to A) |
//! | an existing task | put `column`, `rank`, `assignee`, `due`, `priority`, `updated_at`, or delete some but not all of their values (what Automerge writes when a put repeats the winning value of a conflict); put `number` (integer up to the ceiling) when the task is not deleted; put `deleted = true` (needs the delete right); make `title`/`description` text or `labels` list; make `comments`/`activity` only when missing |
//! | title, description, labels | anything |
//! | `comments` of a task | make a map at a new key (a new comment, its id bound to A) |
//! | `activity` of a task | insert a new map (a new entry) |
//! | anything created in this change | anything (the shape check and [`check_new_authorship`] follow) |
//!
//! Everything else (deleting a task or comment key, replacing `tasks` or
//! `project`, changing `created_by` or `nonce`, editing someone's comment or
//! an old activity entry, marks, counters) is refused for good.
//!
//! A new task or comment must sit at the id bound to A and its nonce
//! (`doc::derive_task_id`, `doc::derive_comment_id`, checked after applying
//! in [`check_new_authorship`]), so two authors can never create the same
//! key and refusing an existing key gives the same answer on every laptop.
//!
//! The number ceiling is [`BoardDoc::fresh_number_at`] the change's
//! dependencies plus [`NUMBER_SLACK`], and "deleted" is read there too, so it
//! is the same on every laptop. Without it one huge number would pin
//! `fresh_number` at its maximum and every new task would share it.
//!
//! The first change of a project (no dependencies) is not judged here;
//! `sync::import_project` validates it.

use std::cell::OnceCell;
use std::collections::HashMap;

use automerge::legacy::{Key, ObjectId, OpId, OpType, SortedVec};
use automerge::{ActorId, Change, ChangeHash, ObjType, Prop, ReadDoc, ScalarValue};

use super::doc::{BoardDoc, derive_comment_id, derive_task_id, is_bound_id};

/// Most operations in one change from another laptop. A local change with a
/// full description stays far below this.
pub const MAX_CHANGE_OPS: usize = 50_000;

/// How far above the next free number a change may set a task number. One
/// local change renumbers or creates far fewer tasks than this.
pub const NUMBER_SLACK: i64 = 10_000;

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
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Kind {
    Root,
    Project,
    Tasks,
    Task { id: String, new: bool },
    Free,
    Comments { new: bool },
    Comment { new: bool },
    Activity { new: bool },
    Entry { new: bool },
    Other,
}

fn obj_key(counter: u64, actor: &ActorId) -> String {
    format!("{counter}@{}", actor.to_hex_string())
}

fn op_key(id: &OpId) -> String {
    obj_key(id.0, &id.1)
}

/// Kind of an object that exists in `doc` (created by an earlier change),
/// from its creation path.
fn existing_kind(doc: &BoardDoc, key: &str) -> Kind {
    let am = doc.automerge();
    let Ok(obj) = am.import_obj(key) else {
        return Kind::Other;
    };
    let Ok(parents) = am.parents(&obj) else {
        return Kind::Other;
    };
    let path: Vec<Prop> = parents.path().into_iter().map(|(_, p)| p).collect();
    let m = map_key;
    match path.as_slice() {
        [p] if m(p) == Some("project") => Kind::Project,
        [p] if m(p) == Some("tasks") => Kind::Tasks,
        [t, Prop::Map(id)] if m(t) == Some("tasks") => Kind::Task {
            id: id.clone(),
            new: false,
        },
        [t, Prop::Map(_), f] if m(t) == Some("tasks") => match m(f) {
            Some("title" | "description" | "labels") => Kind::Free,
            Some("comments") => Kind::Comments { new: false },
            Some("activity") => Kind::Activity { new: false },
            _ => Kind::Other,
        },
        [t, Prop::Map(_), f, _] if m(t) == Some("tasks") => match m(f) {
            Some("comments") => Kind::Comment { new: false },
            Some("activity") => Kind::Entry { new: false },
            _ => Kind::Other,
        },
        _ => Kind::Other,
    }
}

fn map_key(p: &Prop) -> Option<&str> {
    match p {
        Prop::Map(s) => Some(s.as_str()),
        Prop::Seq(_) => None,
    }
}

fn refuse(what: impl Into<String>) -> Result<Needs, String> {
    Err(what.into())
}

/// Judges every operation of `change` against `before` (the document with
/// all of the change's dependencies, before applying it). `Ok` lists the
/// rights still to check; `Err` is the reason it is refused for good.
pub fn judge(before: &BoardDoc, change: &Change) -> Result<Needs, String> {
    if change.len() > MAX_CHANGE_OPS {
        return refuse(format!(
            "perubahan berisi {} operasi, lebih dari batas {MAX_CHANGE_OPS}",
            change.len()
        ));
    }
    let expanded = change.decode();
    let actor = expanded.actor_id.clone();
    let start = expanded.start_op.get();
    let mut needs = Needs::default();
    let mut new_objs: HashMap<String, Kind> = HashMap::new();
    let mut known: HashMap<String, Kind> = HashMap::new();
    let deps: Vec<ChangeHash> = change.deps().to_vec();
    let ceiling = OnceCell::new();
    let number_ok = |v: &ScalarValue, extra: i64| -> bool {
        let max = *ceiling.get_or_init(|| before.fresh_number_at(&deps).saturating_add(NUMBER_SLACK));
        int_of(v).is_some_and(|n| (1..=max.saturating_add(extra)).contains(&n))
    };

    for (i, op) in expanded.operations.iter().enumerate() {
        let this = obj_key(start + i as u64, &actor);
        let target = match &op.obj {
            ObjectId::Root => Kind::Root,
            ObjectId::Id(id) => {
                let k = op_key(id);
                if let Some(kind) = new_objs.get(&k) {
                    kind.clone()
                } else {
                    known
                        .entry(k.clone())
                        .or_insert_with(|| existing_kind(before, &k))
                        .clone()
                }
            }
        };
        let key = match &op.key {
            Key::Map(s) => Some(s.as_str()),
            Key::Seq(_) => None,
        };
        let made = match &op.action {
            OpType::Make(t) => Some(*t),
            _ => None,
        };
        let new_kind = |k: Kind| -> Option<Kind> { made.map(|_| k) };
        let child: Option<Kind> = match (&target, &op.action, key) {
            (Kind::Root, OpType::Put(v), Some("next_number")) => {
                if !number_ok(v, 1) {
                    return refuse("nomor task berikutnya di luar batas");
                }
                None
            }
            (Kind::Root, _, k) => return refuse(format!("mengubah struktur utama dokumen ({})", k.unwrap_or("?"))),

            (Kind::Project, OpType::Put(ScalarValue::Str(_)), Some("name" | "code")) => {
                needs.manage = true;
                None
            }
            (Kind::Project, _, k) => return refuse(format!("mengubah data proyek ({})", k.unwrap_or("?"))),

            (Kind::Tasks, OpType::Make(ObjType::Map), Some(id)) => {
                // Ids are bound to their creator, so this only meets an
                // earlier task by the same author.
                if before.task(id).ok().flatten().is_some() {
                    return refuse(format!("menimpa task {id}"));
                }
                needs.new_tasks.push((this.clone(), id.to_owned()));
                new_kind(Kind::Task {
                    id: id.to_owned(),
                    new: true,
                })
            }
            (Kind::Tasks, _, _) => return refuse("menghapus atau menimpa daftar task"),

            (Kind::Task { id, new: true }, OpType::Put(v), Some("number")) => {
                if !number_ok(v, 0) {
                    return refuse(format!("nomor task {id} di luar batas"));
                }
                None
            }
            (Kind::Task { new: true, .. }, _, k) => new_kind(match k {
                Some("title" | "description" | "labels") => Kind::Free,
                Some("comments") => Kind::Comments { new: true },
                Some("activity") => Kind::Activity { new: true },
                _ => Kind::Free,
            }),
            (Kind::Task { id, new: false }, action, Some(k)) => match (k, action) {
                ("column" | "rank" | "assignee" | "due" | "priority" | "updated_at", OpType::Put(_)) => None,
                ("column" | "rank" | "assignee" | "due" | "priority" | "updated_at", OpType::Delete)
                    if drops_only_losers(before, &op.obj, k, &op.pred, &deps) =>
                {
                    None
                }
                ("number", OpType::Put(v)) => {
                    if deleted_at(before, &op.obj, &deps) {
                        return refuse(format!("mengubah nomor task {id} yang sudah dihapus"));
                    }
                    if !number_ok(v, 0) {
                        return refuse(format!("nomor task {id} di luar batas"));
                    }
                    None
                }
                ("deleted", OpType::Put(ScalarValue::Boolean(true))) => {
                    let created_by = before
                        .task(id)
                        .ok()
                        .flatten()
                        .map(|t| t.created_by)
                        .unwrap_or_default();
                    if !needs.delete.iter().any(|(t, _)| t == id) {
                        needs.delete.push((id.clone(), created_by));
                    }
                    None
                }
                ("title" | "description", OpType::Make(ObjType::Text)) => Some(Kind::Free),
                ("labels", OpType::Make(ObjType::List)) => Some(Kind::Free),
                ("comments" | "activity", OpType::Make(t)) => {
                    let present = before
                        .automerge()
                        .import_obj(&op_key_of_target(&op.obj))
                        .ok()
                        .and_then(|task| before.automerge().get(&task, k).ok().flatten())
                        .is_some();
                    if present {
                        return refuse(format!("mengganti {k} task {id}"));
                    }
                    match (k, t) {
                        ("comments", ObjType::Map) => Some(Kind::Comments { new: true }),
                        ("activity", ObjType::List) => Some(Kind::Activity { new: true }),
                        _ => return refuse(format!("jenis {k} task {id} salah")),
                    }
                }
                _ => return refuse(format!("mengubah {k} task {id}")),
            },
            (Kind::Task { id, .. }, _, None) => return refuse(format!("operasi tidak dikenal di task {id}")),

            (Kind::Free, OpType::MarkBegin(..) | OpType::MarkEnd(_) | OpType::Increment(_), _) => {
                return refuse("penanda teks atau penghitung tidak dipakai board");
            }
            (Kind::Free, _, _) => new_kind(Kind::Free),

            (Kind::Comments { new: true }, _, _) => new_kind(Kind::Comment { new: true }),
            (Kind::Comments { new: false }, OpType::Make(ObjType::Map), Some(cid)) => {
                let exists = before
                    .automerge()
                    .import_obj(&op_key_of_target(&op.obj))
                    .ok()
                    .and_then(|c| before.automerge().get(&c, cid).ok().flatten())
                    .is_some();
                if exists {
                    return refuse("menimpa komentar yang sudah ada");
                }
                needs.new_comments.push((this.clone(), cid.to_owned()));
                Some(Kind::Comment { new: true })
            }
            (Kind::Comments { .. }, _, _) => return refuse("menghapus atau menimpa komentar"),

            (Kind::Comment { new: true }, _, _) => new_kind(Kind::Free),
            (Kind::Comment { new: false }, _, _) => return refuse("mengubah komentar yang sudah ada"),

            (Kind::Activity { new: true }, _, _) => {
                if made.is_some() {
                    needs.new_activity.push(this.clone());
                }
                new_kind(Kind::Entry { new: true })
            }
            (Kind::Activity { new: false }, OpType::Make(ObjType::Map), None) if op.insert => {
                needs.new_activity.push(this.clone());
                Some(Kind::Entry { new: true })
            }
            (Kind::Activity { .. }, _, _) => return refuse("menghapus atau mengubah riwayat aktivitas"),

            (Kind::Entry { new: true }, _, _) => new_kind(Kind::Free),
            (Kind::Entry { new: false }, _, _) => return refuse("mengubah riwayat aktivitas lama"),

            (Kind::Other, _, _) => return refuse("mengubah bagian dokumen yang tidak dikenal"),
        };
        // Comments made inside a comments map created in this change are new
        // comments too.
        if let (Kind::Comments { new: true }, Some(ObjType::Map)) = (&target, made) {
            needs
                .new_comments
                .push((this.clone(), key.unwrap_or_default().to_owned()));
        }
        if let Some(kind) = child {
            new_objs.insert(this, kind);
        }
    }
    Ok(needs)
}

fn op_key_of_target(obj: &ObjectId) -> String {
    match obj {
        ObjectId::Root => "_root".to_owned(),
        ObjectId::Id(id) => op_key(id),
    }
}

fn int_of(v: &ScalarValue) -> Option<i64> {
    match v {
        ScalarValue::Int(n) => Some(*n),
        ScalarValue::Uint(n) => i64::try_from(*n).ok(),
        _ => None,
    }
}

/// Whether a delete of `key` in `obj` with predecessors `pred` removes only
/// some of the values `key` held as of `heads`, so at least one stays. A
/// local put that repeats the winning value of a conflicted key is written
/// by Automerge as such a delete of the losing values.
fn drops_only_losers(
    doc: &BoardDoc,
    obj: &ObjectId,
    key: &str,
    pred: &SortedVec<OpId>,
    heads: &[ChangeHash],
) -> bool {
    let am = doc.automerge();
    let Some(values) = am
        .import_obj(&op_key_of_target(obj))
        .ok()
        .and_then(|o| am.get_all_at(&o, key, heads).ok())
    else {
        return false;
    };
    let ids: Vec<String> = values.iter().map(|(_, id)| id.to_string()).collect();
    !pred.is_empty() && pred.len() < ids.len() && pred.iter().all(|p| ids.contains(&op_key(p)))
}

/// Whether the task `obj` was deleted as of `heads`.
fn deleted_at(doc: &BoardDoc, obj: &ObjectId, heads: &[ChangeHash]) -> bool {
    let am = doc.automerge();
    am.import_obj(&op_key_of_target(obj))
        .ok()
        .and_then(|t| am.get_at(&t, "deleted", heads).ok().flatten())
        .and_then(|(v, _)| v.as_bool())
        .unwrap_or(false)
}

/// After applying: every task the change created names `author` (64 hex)
/// as its creator and every comment and activity entry names it as author,
/// and each new task and comment sits at the id bound to `author` and its
/// nonce.
pub fn check_new_authorship(after: &BoardDoc, needs: &Needs, author: &str) -> Result<(), String> {
    let am = after.automerge();
    let field = |key: &str, name: &str| -> Option<String> {
        let obj = am.import_obj(key).ok()?;
        match am.get(&obj, name).ok().flatten() {
            Some((v, _)) => v.as_str().map(str::to_owned),
            None => None,
        }
    };
    for (obj, id) in &needs.new_tasks {
        if field(obj, "created_by").as_deref() != Some(author) {
            return Err("task baru dibuat atas nama orang lain".into());
        }
        if !is_bound_id(derive_task_id, id, author, field(obj, "nonce").as_deref()) {
            return Err(format!("kode task baru {id} tidak cocok dengan pembuatnya"));
        }
    }
    for (obj, id) in &needs.new_comments {
        if field(obj, "author").as_deref() != Some(author) {
            return Err("komentar baru dibuat atas nama orang lain".into());
        }
        if !is_bound_id(derive_comment_id, id, author, field(obj, "nonce").as_deref()) {
            return Err("kode komentar baru tidak cocok dengan penulisnya".into());
        }
    }
    for e in &needs.new_activity {
        if field(e, "actor").as_deref() != Some(author) {
            return Err("riwayat aktivitas baru dibuat atas nama orang lain".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
