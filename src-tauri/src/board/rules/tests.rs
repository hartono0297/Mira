use automerge::transaction::Transactable;
use automerge::{AutoCommit, ObjId, ObjType, ROOT, ReadDoc, Value};

use super::*;
use crate::board::doc::{
    MAX_TASK_NUMBER, ProjectMeta, Stamp, TaskChanges, TaskInit, derive_comment_id, derive_task_id,
    random_id,
};
use crate::board::model::ColumnId;

const A: [u8; 32] = [0xaa; 32];
const B: [u8; 32] = [0xbb; 32];

fn hex32(b: &[u8; 32]) -> String {
    hex::encode(b)
}

/// A project by A with one task by A (with one comment), one task by B and
/// one deleted task by A.
fn base() -> (BoardDoc, String, String, String) {
    let meta = ProjectMeta {
        id: "1".repeat(32),
        code: "PA".into(),
        name: "Proyek A".into(),
        team_id: None,
    };
    let mut d = BoardDoc::create(&A, &meta).unwrap();
    d.commit(1);
    let a = hex32(&A);
    let task_a = d
        .create_task(
            Stamp { actor: &a, at: "t1" },
            TaskInit {
                title: "Punya A".into(),
                ..Default::default()
            },
        )
        .unwrap();
    d.add_comment(Stamp { actor: &a, at: "t1" }, &task_a, "halo").unwrap();
    let gone = d
        .create_task(
            Stamp { actor: &a, at: "t1" },
            TaskInit {
                title: "Terhapus".into(),
                ..Default::default()
            },
        )
        .unwrap();
    d.delete_task(Stamp { actor: &a, at: "t1" }, &gone).unwrap();
    d.commit(2);
    let mut db = BoardDoc::load(&d.save(), &B).unwrap();
    let b = hex32(&B);
    let task_b = db
        .create_task(
            Stamp { actor: &b, at: "t2" },
            TaskInit {
                title: "Punya B".into(),
                ..Default::default()
            },
        )
        .unwrap();
    db.commit(3);
    (BoardDoc::load(&db.save(), &A).unwrap(), task_a, task_b, gone)
}

/// One change by `actor` made with `f` on top of `doc`.
fn change_by(doc: &mut BoardDoc, actor: &[u8; 32], f: impl FnOnce(&mut BoardDoc)) -> Change {
    let mut d = BoardDoc::load(&doc.save(), actor).unwrap();
    let before = d.heads();
    f(&mut d);
    d.commit(10).expect("something staged");
    let mut changes = d.changes_after(&before);
    assert_eq!(changes.len(), 1);
    changes.remove(0)
}

fn task_obj(d: &mut BoardDoc, id: &str) -> automerge::ObjId {
    let am = d.raw();
    let (_, tasks) = am.get(ROOT, "tasks").unwrap().unwrap();
    let (_, t) = am.get(&tasks, id).unwrap().unwrap();
    t
}

#[test]
fn ordinary_edits_need_only_the_write_right() {
    let (mut doc, task_a, _, _) = base();
    let b = hex32(&B);
    let c = change_by(&mut doc, &B, |d| {
        let s = Stamp { actor: &b, at: "t3" };
        d.create_task(
            s,
            TaskInit {
                title: "Baru".into(),
                labels: vec!["x".into()],
                ..Default::default()
            },
        )
        .unwrap();
        d.update_task(
            s,
            &task_a,
            &TaskChanges {
                title: Some("Judul baru".into()),
                description: Some("isi".into()),
                labels: Some(vec!["L".into()]),
                due: Some(Some("2026-12-01".into())),
                ..Default::default()
            },
            &|_| String::new(),
        )
        .unwrap();
        d.move_task(s, &task_a, ColumnId::Doing, 0).unwrap();
        d.add_comment(s, &task_a, "oke").unwrap();
    });
    let needs = judge(&doc, &c).unwrap();
    assert!(!needs.manage);
    assert!(needs.delete.is_empty());
    assert_eq!(needs.new_comments.len(), 1);
    assert!(needs.new_activity.len() >= 4, "{needs:?}");
    doc.apply(c).unwrap();
    check_new_authorship(&doc, &needs, &b).unwrap();
}

#[test]
fn deleting_a_task_needs_the_delete_right_of_its_creator() {
    let (mut doc, task_a, task_b, _) = base();
    let b = hex32(&B);
    let c = change_by(&mut doc, &B, |d| {
        let s = Stamp { actor: &b, at: "t3" };
        d.delete_task(s, &task_a).unwrap();
        d.delete_task(s, &task_b).unwrap();
    });
    let needs = judge(&doc, &c).unwrap();
    let mut del = needs.delete.clone();
    del.sort();
    let mut want = vec![(task_a, hex32(&A)), (task_b, b)];
    want.sort();
    assert_eq!(del, want);
}

#[test]
fn renaming_the_project_needs_the_manage_right() {
    let (mut doc, _, _, _) = base();
    let c = change_by(&mut doc, &B, |d| {
        let am = d.raw();
        let (_, p) = am.get(ROOT, "project").unwrap().unwrap();
        am.put(&p, "name", "Nama Lain").unwrap();
    });
    assert!(judge(&doc, &c).unwrap().manage);
}

#[test]
fn forbidden_operations_are_refused_for_good() {
    let (mut doc, task_a, _, gone) = base();
    type Edit = Box<dyn Fn(&mut BoardDoc, &str)>;
    let cases: Vec<(&str, Edit)> = vec![
        (
            "hapus key task",
            Box::new(|d, id| {
                let am = d.raw();
                let (_, tasks) = am.get(ROOT, "tasks").unwrap().unwrap();
                am.delete(&tasks, id).unwrap();
            }),
        ),
        (
            "ganti map tasks",
            Box::new(|d, _| {
                d.raw().put_object(ROOT, "tasks", ObjType::Map).unwrap();
            }),
        ),
        (
            "ganti map project",
            Box::new(|d, _| {
                d.raw().put_object(ROOT, "project", ObjType::Map).unwrap();
            }),
        ),
        (
            "pindah tim",
            Box::new(|d, _| {
                let am = d.raw();
                let (_, p) = am.get(ROOT, "project").unwrap().unwrap();
                am.put(&p, "team_id", "2".repeat(32)).unwrap();
            }),
        ),
        (
            "ganti pembuat",
            Box::new(|d, id| {
                let t = task_obj(d, id);
                d.raw().put(&t, "created_by", hex32(&B)).unwrap();
            }),
        ),
        (
            "timpa task",
            Box::new(|d, id| {
                let am = d.raw();
                let (_, tasks) = am.get(ROOT, "tasks").unwrap().unwrap();
                am.put_object(&tasks, id, ObjType::Map).unwrap();
            }),
        ),
        (
            "ganti riwayat",
            Box::new(|d, id| {
                let t = task_obj(d, id);
                d.raw().put_object(&t, "activity", ObjType::List).unwrap();
            }),
        ),
        (
            "ubah komentar orang",
            Box::new(|d, id| {
                let t = task_obj(d, id);
                let am = d.raw();
                let (_, comments) = am.get(&t, "comments").unwrap().unwrap();
                let cid = am.keys(&comments).next().unwrap();
                let (_, c) = am.get(&comments, &cid).unwrap().unwrap();
                am.put(&c, "body", "palsu").unwrap();
            }),
        ),
        (
            "hapus komentar",
            Box::new(|d, id| {
                let t = task_obj(d, id);
                let am = d.raw();
                let (_, comments) = am.get(&t, "comments").unwrap().unwrap();
                let cid = am.keys(&comments).next().unwrap();
                am.delete(&comments, &cid).unwrap();
            }),
        ),
        (
            "ubah riwayat lama",
            Box::new(|d, id| {
                let t = task_obj(d, id);
                let am = d.raw();
                let (_, list) = am.get(&t, "activity").unwrap().unwrap();
                let (_, e) = am.get(&list, 0).unwrap().unwrap();
                am.put(&e, "actor", hex32(&B)).unwrap();
            }),
        ),
        (
            "hapus riwayat",
            Box::new(|d, id| {
                let t = task_obj(d, id);
                let am = d.raw();
                let (_, list) = am.get(&t, "activity").unwrap().unwrap();
                am.delete(&list, 0).unwrap();
            }),
        ),
        (
            "isian asing di task",
            Box::new(|d, id| {
                let t = task_obj(d, id);
                d.raw().put(&t, "rahasia", 1).unwrap();
            }),
        ),
    ];
    for (label, edit) in cases {
        let c = change_by(&mut doc, &B, |d| edit(d, &task_a));
        assert!(judge(&doc, &c).is_err(), "{label} harus ditolak");
    }
    // Bringing a deleted task back.
    let c = change_by(&mut doc, &B, |d| {
        let t = task_obj(d, &gone);
        d.raw().put(&t, "deleted", false).unwrap();
    });
    assert!(judge(&doc, &c).is_err(), "hidupkan lagi harus ditolak");
}

#[test]
fn a_comment_or_activity_in_someone_elses_name_is_caught_after_applying() {
    let (mut doc, task_a, _, _) = base();
    let a = hex32(&A);
    let b = hex32(&B);
    // B writes a comment (and its activity entry) claiming A wrote it.
    let c = change_by(&mut doc, &B, |d| {
        d.add_comment(Stamp { actor: &a, at: "t3" }, &task_a, "atas nama A")
            .unwrap();
    });
    let needs = judge(&doc, &c).unwrap();
    assert_eq!(needs.new_comments.len(), 1);
    doc.apply(c).unwrap();
    assert!(check_new_authorship(&doc, &needs, &b).is_err());
}

#[test]
fn too_many_operations_are_refused() {
    let (mut doc, task_a, _, _) = base();
    let c = change_by(&mut doc, &B, |d| {
        let t = task_obj(d, &task_a);
        let am = d.raw();
        let (v, text) = am.get(&t, "description").unwrap().unwrap();
        assert!(matches!(v, Value::Object(ObjType::Text)));
        am.splice_text(&text, 0, 0, &"x".repeat(MAX_CHANGE_OPS + 1)).unwrap();
    });
    let err = judge(&doc, &c).unwrap_err();
    assert!(err.contains("operasi"), "{err}");
}

/// Stages a bare task map at `id` in `d` (enough for the rules, not for the
/// shape check).
fn raw_task(d: &mut BoardDoc, id: &str, created_by: &str, nonce: Option<&str>) {
    let am = d.raw();
    let (_, tasks) = am.get(ROOT, "tasks").unwrap().unwrap();
    let t = am.put_object(&tasks, id, ObjType::Map).unwrap();
    if let Some(n) = nonce {
        am.put(&t, "nonce", n).unwrap();
    }
    am.put(&t, "number", 50).unwrap();
    am.put(&t, "created_by", created_by).unwrap();
}

/// Stages a bare comment at `cid` on task `id`.
fn raw_comment(d: &mut BoardDoc, id: &str, cid: &str, author: &str, nonce: Option<&str>) {
    let t = task_obj(d, id);
    let am = d.raw();
    let (_, comments) = am.get(&t, "comments").unwrap().unwrap();
    let c = am.put_object(&comments, cid, ObjType::Map).unwrap();
    if let Some(n) = nonce {
        am.put(&c, "nonce", n).unwrap();
    }
    am.put(&c, "author", author).unwrap();
    am.put(&c, "body", "x").unwrap();
}

/// Judges, applies and checks `c` like `sync` does.
fn accept(doc: &mut BoardDoc, c: Change, author: &str) -> Result<Needs, String> {
    let needs = judge(doc, &c)?;
    doc.apply(c).unwrap();
    check_new_authorship(doc, &needs, author)?;
    Ok(needs)
}

fn nonce_of(d: &mut BoardDoc, id: &str) -> String {
    let t = task_obj(d, id);
    let (v, _) = d.raw().get(&t, "nonce").unwrap().unwrap();
    v.as_str().unwrap().to_owned()
}

#[test]
fn the_local_flow_passes_every_check() {
    let (mut doc, task_a, _, _) = base();
    let b = hex32(&B);
    let s = Stamp { actor: &b, at: "t3" };
    let mut new_id = String::new();
    let c = change_by(&mut doc, &B, |d| {
        new_id = d
            .create_task(
                s,
                TaskInit {
                    title: "Baru".into(),
                    ..Default::default()
                },
            )
            .unwrap();
    });
    let needs = accept(&mut doc, c, &b).unwrap();
    assert_eq!(needs.new_tasks.len(), 1);
    assert_eq!(needs.new_tasks[0].1, new_id);

    type Step<'a> = Box<dyn Fn(&mut BoardDoc) + 'a>;
    let steps: Vec<Step> = vec![
        Box::new(|d| {
            d.update_task(
                s,
                &new_id,
                &TaskChanges {
                    title: Some("Ubah".into()),
                    ..Default::default()
                },
                &|_| String::new(),
            )
            .unwrap()
        }),
        Box::new(|d| d.move_task(s, &new_id, ColumnId::Done, 0).unwrap()),
        Box::new(|d| {
            d.add_comment(s, &new_id, "satu").unwrap();
            d.add_comment(s, &task_a, "dua").unwrap();
        }),
        Box::new(|d| {
            let n = d.fresh_number().unwrap();
            d.renumber_task(s, &task_a, n, "PA-1").unwrap();
        }),
        Box::new(|d| d.rename_project("Nama Baru").unwrap()),
        Box::new(|d| d.delete_task(s, &new_id).unwrap()),
    ];
    for step in steps {
        let c = change_by(&mut doc, &B, |d| step(d));
        accept(&mut doc, c, &b).unwrap();
    }
    assert!(doc.task(&new_id).unwrap().unwrap().deleted);
    assert_eq!(doc.project().name, "Nama Baru");
}

#[test]
fn a_new_task_must_sit_at_the_id_bound_to_its_creator() {
    let (mut doc, _, _, _) = base();
    let b = hex32(&B);
    let nonce = random_id();
    let cases: Vec<(&str, String, Option<String>)> = vec![
        ("id acak", random_id(), Some(nonce.clone())),
        ("tanpa nonce", derive_task_id(&b, &nonce), None),
        ("nonce bukan hex", derive_task_id(&b, "zz"), Some("zz".into())),
        (
            "id pembuat lain",
            derive_task_id(&hex32(&A), &nonce),
            Some(nonce.clone()),
        ),
        (
            "id komentar, bukan task",
            derive_comment_id(&b, &nonce),
            Some(nonce.clone()),
        ),
    ];
    for (label, id, n) in cases {
        let mut d = BoardDoc::load(&doc.save(), &A).unwrap();
        let c = change_by(&mut d, &B, |x| raw_task(x, &id, &b, n.as_deref()));
        let err = accept(&mut d, c, &b).expect_err(label);
        assert!(err.contains("tidak cocok"), "{label}: {err}");
    }
    let id = derive_task_id(&b, &nonce);
    let c = change_by(&mut doc, &B, |x| raw_task(x, &id, &b, Some(&nonce)));
    accept(&mut doc, c, &b).unwrap();
}

#[test]
fn nobody_can_create_a_task_at_someone_elses_id() {
    let (mut doc, _, _, _) = base();
    let a = hex32(&A);
    let b = hex32(&B);
    // A creates a task that B has not seen yet.
    let mut task = String::new();
    let mut nonce = String::new();
    let ca = change_by(&mut doc, &A, |d| {
        task = d
            .create_task(Stamp { actor: &a, at: "t3" }, TaskInit::default())
            .unwrap();
        nonce = nonce_of(d, &task);
    });
    // B, concurrently, makes the same key, as itself or in A's name.
    for created_by in [&b, &a] {
        let cb = change_by(&mut doc, &B, |d| {
            raw_task(d, &task, created_by, Some(&nonce))
        });
        // Refused by a laptop without A's change...
        let mut without = BoardDoc::load(&doc.save(), &A).unwrap();
        assert!(accept(&mut without, cb.clone(), &b).is_err());
        // ...and by one that has it, so A's change is never blocked.
        let mut with = BoardDoc::load(&doc.save(), &A).unwrap();
        accept(&mut with, ca.clone(), &a).unwrap();
        assert!(judge(&with, &cb).is_err());
    }
}

#[test]
fn a_new_comment_must_sit_at_the_id_bound_to_its_author() {
    let (mut doc, task_a, _, _) = base();
    let b = hex32(&B);
    let nonce = random_id();
    let cases: Vec<(&str, String, Option<String>)> = vec![
        ("id acak", random_id(), Some(nonce.clone())),
        ("tanpa nonce", derive_comment_id(&b, &nonce), None),
        (
            "id task, bukan komentar",
            derive_task_id(&b, &nonce),
            Some(nonce.clone()),
        ),
        (
            "id penulis lain",
            derive_comment_id(&hex32(&A), &nonce),
            Some(nonce.clone()),
        ),
    ];
    for (label, cid, n) in cases {
        let mut d = BoardDoc::load(&doc.save(), &A).unwrap();
        let c = change_by(&mut d, &B, |x| {
            raw_comment(x, &task_a, &cid, &b, n.as_deref())
        });
        let err = accept(&mut d, c, &b).expect_err(label);
        assert!(err.contains("tidak cocok"), "{label}: {err}");
    }
    let cid = derive_comment_id(&b, &nonce);
    let c = change_by(&mut doc, &B, |x| {
        raw_comment(x, &task_a, &cid, &b, Some(&nonce))
    });
    let needs = accept(&mut doc, c, &b).unwrap();
    assert_eq!(needs.new_comments.len(), 1);
    assert_eq!(needs.new_comments[0].1, cid);
}

#[test]
fn the_nonce_is_only_written_with_its_task_or_comment() {
    let (mut doc, task_a, _, _) = base();
    let c = change_by(&mut doc, &B, |d| {
        let t = task_obj(d, &task_a);
        d.raw().put(&t, "nonce", random_id()).unwrap();
    });
    assert!(judge(&doc, &c).is_err(), "nonce task lama");
    let c = change_by(&mut doc, &B, |d| {
        let t = task_obj(d, &task_a);
        let am = d.raw();
        let (_, comments) = am.get(&t, "comments").unwrap().unwrap();
        let cid = am.keys(&comments).next().unwrap();
        let (_, cm) = am.get(&comments, &cid).unwrap().unwrap();
        am.put(&cm, "nonce", random_id()).unwrap();
    });
    assert!(judge(&doc, &c).is_err(), "nonce komentar lama");
}

#[test]
fn task_numbers_stay_below_the_ceiling() {
    let (mut doc, task_a, _, gone) = base();
    let b = hex32(&B);
    let fresh = doc.fresh_number().unwrap();
    let put_number = |doc: &mut BoardDoc, id: &str, n: i64| {
        change_by(doc, &B, |d| {
            let t = task_obj(d, id);
            d.raw().put(&t, "number", n).unwrap();
        })
    };
    for n in [0, -1, fresh + NUMBER_SLACK + 1, MAX_TASK_NUMBER] {
        let c = put_number(&mut doc, &task_a, n);
        assert!(judge(&doc, &c).is_err(), "nomor {n} harus ditolak");
    }
    let c = change_by(&mut doc, &B, |d| {
        let t = task_obj(d, &task_a);
        d.raw().put(&t, "number", "5").unwrap();
    });
    assert!(judge(&doc, &c).is_err(), "nomor berupa teks");
    let c = put_number(&mut doc, &gone, 1);
    assert!(judge(&doc, &c).is_err(), "nomor task terhapus");
    let c = change_by(&mut doc, &B, |d| {
        d.raw().put(ROOT, "next_number", MAX_TASK_NUMBER).unwrap();
    });
    assert!(judge(&doc, &c).is_err(), "next_number terlalu besar");
    let c = change_by(&mut doc, &B, |d| {
        let id = d
            .create_task(Stamp { actor: &b, at: "t3" }, TaskInit::default())
            .unwrap();
        let t = task_obj(d, &id);
        d.raw().put(&t, "number", fresh + NUMBER_SLACK + 1).unwrap();
    });
    assert!(judge(&doc, &c).is_err(), "nomor task baru terlalu besar");

    let c = put_number(&mut doc, &task_a, fresh + NUMBER_SLACK);
    judge(&doc, &c).unwrap();
    let c = change_by(&mut doc, &B, |d| {
        d.raw()
            .put(ROOT, "next_number", fresh + NUMBER_SLACK + 1)
            .unwrap();
    });
    judge(&doc, &c).unwrap();
}

#[test]
fn renumbering_a_task_deleted_concurrently_is_judged_the_same_everywhere() {
    let (mut doc, task_a, _, _) = base();
    let a = hex32(&A);
    let b = hex32(&B);
    let del = change_by(&mut doc, &A, |d| {
        d.delete_task(Stamp { actor: &a, at: "t3" }, &task_a).unwrap()
    });
    let ren = change_by(&mut doc, &B, |d| {
        let n = d.fresh_number().unwrap();
        d.renumber_task(Stamp { actor: &b, at: "t3" }, &task_a, n, "PA-1")
            .unwrap();
    });
    let mut delete_first = BoardDoc::load(&doc.save(), &A).unwrap();
    accept(&mut delete_first, del.clone(), &a).unwrap();
    accept(&mut delete_first, ren.clone(), &b).unwrap();
    let mut renumber_first = BoardDoc::load(&doc.save(), &A).unwrap();
    accept(&mut renumber_first, ren, &b).unwrap();
    accept(&mut renumber_first, del, &a).unwrap();
}

/// `doc` after A and B both edited `task` offline with the same stamp, so
/// `updated_at` holds two concurrent values that are equal.
fn conflicting_updated_at(doc: &mut BoardDoc, task: &str) {
    let a = hex32(&A);
    let b = hex32(&B);
    let by_a = change_by(doc, &A, |d| {
        let changes = TaskChanges {
            due: Some(Some("2026-12-01".into())),
            ..Default::default()
        };
        d.update_task(Stamp { actor: &a, at: "t3" }, task, &changes, &|_| String::new())
            .unwrap();
    });
    let by_b = change_by(doc, &B, |d| {
        d.add_comment(Stamp { actor: &b, at: "t3" }, task, "oke").unwrap();
    });
    accept(doc, by_a, &a).unwrap();
    accept(doc, by_b, &b).unwrap();
    let t = task_obj(doc, task);
    assert_eq!(doc.raw().get_all(&t, "updated_at").unwrap().len(), 2);
}

fn has_delete_of(c: &Change, key: &str) -> bool {
    c.decode()
        .operations
        .iter()
        .any(|op| matches!(op.action, OpType::Delete) && op.key == Key::Map(key.into()))
}

#[test]
fn putting_the_winning_value_of_a_conflict_again_is_allowed() {
    // Automerge writes a put that repeats the winning value of a conflicted
    // key as a delete of the losing values; deleting a task in the same
    // second as two concurrent edits does that to `updated_at`.
    let (mut doc, task_a, _, _) = base();
    conflicting_updated_at(&mut doc, &task_a);
    let a = hex32(&A);
    let c = change_by(&mut doc, &A, |d| {
        d.delete_task(Stamp { actor: &a, at: "t3" }, &task_a).unwrap();
    });
    assert!(has_delete_of(&c, "updated_at"), "{:?}", c.decode().operations);
    let needs = accept(&mut doc, c, &a).unwrap();
    assert_eq!(needs.delete, vec![(task_a.clone(), a)]);
    let t = task_obj(&mut doc, &task_a);
    let left = doc.raw().get_all(&t, "updated_at").unwrap();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].0.as_str(), Some("t3"));
}

#[test]
fn deleting_a_task_field_is_still_refused() {
    let (mut doc, task_a, _, _) = base();
    // Its only value.
    let c = change_by(&mut doc, &B, |d| {
        let t = task_obj(d, &task_a);
        d.raw().delete(&t, "updated_at").unwrap();
    });
    assert!(has_delete_of(&c, "updated_at"));
    assert!(judge(&doc, &c).is_err(), "hapus satu-satunya nilai harus ditolak");
    // Every value of a conflict.
    conflicting_updated_at(&mut doc, &task_a);
    let c = change_by(&mut doc, &B, |d| {
        let t = task_obj(d, &task_a);
        d.raw().delete(&t, "updated_at").unwrap();
    });
    assert!(has_delete_of(&c, "updated_at"));
    assert!(judge(&doc, &c).is_err(), "hapus semua nilai konflik harus ditolak");
}

// ---------------------------------------------------------------------------
// v0.4: subtasks and time entries.

use crate::board::doc::{SubtaskChanges, derive_subtask_id, derive_time_id};

const T0: &str = "2026-11-23T08:00:00Z";
const T1: &str = "2026-11-23T09:00:00Z";

/// The map at `key` of task `id` (the winning value).
fn part_obj(d: &mut BoardDoc, id: &str, key: &str) -> automerge::ObjId {
    let t = task_obj(d, id);
    let (_, m) = d.raw().get(&t, key).unwrap().unwrap();
    m
}

/// Entry `eid` of the maps at `key` of task `id`, in any conflicting map.
fn entry(d: &mut BoardDoc, id: &str, key: &str, eid: &str) -> automerge::ObjId {
    let t = task_obj(d, id);
    let am = d.raw();
    am.get_all(&t, key)
        .unwrap()
        .into_iter()
        .find_map(|(_, m)| am.get(&m, eid).unwrap().map(|(_, e)| e))
        .unwrap()
}

/// `base()` where `task_a` has no `subtasks` and `time`, as tasks made
/// before v0.4.
fn old_base() -> (BoardDoc, String, String) {
    let (mut doc, task_a, task_b, _) = base();
    let mut d = BoardDoc::load(&doc.save(), &A).unwrap();
    let before = d.heads();
    let t = task_obj(&mut d, &task_a);
    d.raw().delete(&t, "subtasks").unwrap();
    d.raw().delete(&t, "time").unwrap();
    d.commit(5).unwrap();
    for c in d.changes_after(&before) {
        doc.apply(c).unwrap();
    }
    (doc, task_a, task_b)
}

fn first_subtask(d: &BoardDoc, task: &str) -> String {
    d.task(task).unwrap().unwrap().subtasks[0].id.clone()
}

#[test]
fn subtask_and_timer_edits_of_v04_pass_every_check() {
    for old in [false, true] {
        let (mut doc, task_a, _) = if old {
            old_base()
        } else {
            let (d, a, b, _) = base();
            (d, a, b)
        };
        let b = hex32(&B);
        let a = hex32(&A);
        // A adds a subtask and logs time; B works on the task.
        let c = change_by(&mut doc, &A, |d| {
            d.add_subtask(Stamp { actor: &a, at: T0 }, &task_a, "Punya A", None)
                .unwrap();
            d.log_time(Stamp { actor: &a, at: T0 }, &task_a, 60, "").unwrap();
        });
        let needs = accept(&mut doc, c, &a).unwrap();
        assert_eq!((needs.new_subtasks.len(), needs.new_time.len()), (1, 1), "{needs:?}");
        let sa = first_subtask(&doc, &task_a);

        let s = Stamp { actor: &b, at: T1 };
        let mut sb = String::new();
        let c = change_by(&mut doc, &B, |d| {
            sb = d.add_subtask(s, &task_a, "Punya B", Some(&a)).unwrap();
        });
        let needs = accept(&mut doc, c, &b).unwrap();
        assert_eq!(needs.new_subtasks.len(), 1);
        assert_eq!(needs.new_subtasks[0].1, sb);

        type Step<'a> = Box<dyn Fn(&mut BoardDoc) + 'a>;
        let steps: Vec<Step> = vec![
            Box::new(|d| {
                let ch = SubtaskChanges {
                    title: Some("Ganti".into()),
                    done: Some(true),
                    assignee: Some(Some(b.clone())),
                };
                d.update_subtask(s, &task_a, &sa, &ch).unwrap();
            }),
            Box::new(|d| {
                let ch = SubtaskChanges {
                    done: Some(false),
                    assignee: Some(None),
                    ..Default::default()
                };
                d.update_subtask(s, &task_a, &sa, &ch).unwrap();
            }),
            Box::new(|d| d.move_subtask(s, &task_a, &sb, 0).unwrap()),
            Box::new(|d| {
                d.start_timer(s, &task_a).unwrap();
            }),
            Box::new(|d| d.stop_timer(s, &task_a, "selesai").unwrap()),
            Box::new(|d| {
                d.log_time(s, &task_a, 120, "manual").unwrap();
            }),
            Box::new(|d| {
                let mine = d
                    .task(&task_a)
                    .unwrap()
                    .unwrap()
                    .time
                    .into_iter()
                    .find(|e| e.by == hex32(&B) && e.manual)
                    .unwrap();
                d.delete_time_entry(s, &task_a, &mine.id).unwrap();
            }),
            Box::new(|d| d.delete_subtask(s, &task_a, &sa).unwrap()),
        ];
        for (i, step) in steps.iter().enumerate() {
            let c = change_by(&mut doc, &B, |d| step(d));
            if let Err(e) = accept(&mut doc, c, &b) {
                panic!("langkah {i} (task lama: {old}): {e}");
            }
        }
        let t = doc.task(&task_a).unwrap().unwrap();
        assert!(t.subtasks.iter().find(|x| x.id == sa).unwrap().deleted);
        assert_eq!(t.time.iter().filter(|e| !e.deleted).count(), 2);
    }
}

#[test]
fn starting_a_timer_stops_mine_on_another_task_and_is_accepted() {
    let (mut doc, task_a, task_b, _) = base();
    let b = hex32(&B);
    let c = change_by(&mut doc, &B, |d| {
        d.start_timer(Stamp { actor: &b, at: T0 }, &task_a).unwrap();
    });
    accept(&mut doc, c, &b).unwrap();
    let c = change_by(&mut doc, &B, |d| {
        d.start_timer(Stamp { actor: &b, at: T1 }, &task_b).unwrap();
    });
    accept(&mut doc, c, &b).unwrap();
    let ta = doc.task(&task_a).unwrap().unwrap();
    assert_eq!(ta.time[0].end.as_deref(), Some(T1));
}

#[test]
fn two_laptops_making_the_maps_of_an_old_task_are_judged_the_same_in_any_order() {
    let (mut doc, task_a, _) = old_base();
    let a = hex32(&A);
    let b = hex32(&B);
    let ca = change_by(&mut doc, &A, |x| {
        x.add_subtask(Stamp { actor: &a, at: T0 }, &task_a, "Dari A", None)
            .unwrap();
        x.start_timer(Stamp { actor: &a, at: T0 }, &task_a).unwrap();
    });
    let cb = change_by(&mut doc, &B, |x| {
        x.add_subtask(Stamp { actor: &b, at: T0 }, &task_a, "Dari B", None)
            .unwrap();
        x.log_time(Stamp { actor: &b, at: T0 }, &task_a, 300, "").unwrap();
    });
    let mut a_first = BoardDoc::load(&doc.save(), &A).unwrap();
    accept(&mut a_first, ca.clone(), &a).unwrap();
    accept(&mut a_first, cb.clone(), &b).unwrap();
    let mut b_first = BoardDoc::load(&doc.save(), &B).unwrap();
    accept(&mut b_first, cb, &b).unwrap();
    accept(&mut b_first, ca, &a).unwrap();
    assert_eq!(a_first.heads(), b_first.heads());
    let ta = a_first.task(&task_a).unwrap().unwrap();
    assert_eq!(ta, b_first.task(&task_a).unwrap().unwrap());
    let mut got: Vec<String> = ta.subtasks.iter().map(|s| s.title.clone()).collect();
    got.sort();
    assert_eq!(got, ["Dari A", "Dari B"]);
    assert_eq!(ta.time.len(), 2);

    // Later edits reach the subtask and the timer in the losing map too.
    let sa = ta.subtasks.iter().find(|s| s.title == "Dari A").unwrap().id.clone();
    let sb = ta.subtasks.iter().find(|s| s.title == "Dari B").unwrap().id.clone();
    let tick = SubtaskChanges {
        done: Some(true),
        ..Default::default()
    };
    let c = change_by(&mut a_first, &B, |x| {
        let s = Stamp { actor: &b, at: T1 };
        x.update_subtask(s, &task_a, &sa, &tick).unwrap();
        x.update_subtask(s, &task_a, &sb, &tick).unwrap();
    });
    accept(&mut a_first, c, &b).unwrap();
    let c = change_by(&mut a_first, &A, |x| {
        x.stop_timer(Stamp { actor: &a, at: T1 }, &task_a, "").unwrap();
    });
    accept(&mut a_first, c, &a).unwrap();
    let ta = a_first.task(&task_a).unwrap().unwrap();
    assert!(ta.subtasks.iter().all(|s| s.done));
    assert!(ta.time.iter().all(|e| e.end.is_some()));
}

/// What a forbidden edit touches.
#[derive(Clone, Copy)]
enum On {
    Entry,
    GoneEntry,
    Gone,
    Live,
    Subtasks,
    Time,
    Task,
}

#[test]
fn forbidden_subtask_and_time_edits_are_refused_for_good() {
    let (mut doc, task_a, _, _) = base();
    let a = hex32(&A);
    // A's subtasks (one deleted) and A's time entry.
    let c = change_by(&mut doc, &A, |d| {
        let s = Stamp { actor: &a, at: T0 };
        let gone = d.add_subtask(s, &task_a, "Terhapus", None).unwrap();
        d.add_subtask(s, &task_a, "Hidup", None).unwrap();
        d.delete_subtask(s, &task_a, &gone).unwrap();
        d.log_time(s, &task_a, 60, "").unwrap();
        let old = d.log_time(s, &task_a, 30, "").unwrap();
        d.delete_time_entry(s, &task_a, &old).unwrap();
    });
    accept(&mut doc, c, &a).unwrap();
    let t = doc.task(&task_a).unwrap().unwrap();
    let gone_entry = t.time.iter().find(|e| e.deleted).unwrap().id.clone();
    let gone = t.subtasks.iter().find(|s| s.deleted).unwrap().id.clone();
    let live = t.subtasks.iter().find(|s| !s.deleted).unwrap().id.clone();
    let eid = t.time.iter().find(|e| !e.deleted).unwrap().id.clone();

    type Edit = fn(&mut AutoCommit, &ObjId, &str);
    let b_hex = hex32(&B);
    let cases: Vec<(&str, &[u8; 32], On, Edit)> = vec![
        ("ubah catatan waktu orang", &B, On::Entry, |am, o, _| am.put(o, "note", "palsu").unwrap()),
        ("hapus catatan waktu orang", &B, On::Entry, |am, o, _| am.put(o, "deleted", true).unwrap()),
        ("hentikan timer orang", &B, On::Entry, |am, o, _| am.put(o, "end", T1).unwrap()),
        ("ganti pemilik catatan", &A, On::Entry, |am, o, b| am.put(o, "by", b).unwrap()),
        ("ubah manual", &A, On::Entry, |am, o, _| am.put(o, "manual", false).unwrap()),
        ("hidupkan catatan", &A, On::GoneEntry, |am, o, _| am.put(o, "deleted", false).unwrap()),
        ("start bukan teks", &A, On::Entry, |am, o, _| am.put(o, "start", 5).unwrap()),
        ("hidupkan subtask", &B, On::Gone, |am, o, _| am.put(o, "deleted", false).unwrap()),
        ("hapus isian deleted", &A, On::Gone, |am, o, _| am.delete(o, "deleted").unwrap()),
        ("ganti pembuat subtask", &B, On::Live, |am, o, b| am.put(o, "created_by", b).unwrap()),
        ("ganti nonce subtask", &A, On::Live, |am, o, _| am.put(o, "nonce", random_id()).unwrap()),
        ("done bukan bool", &B, On::Live, |am, o, _| am.put(o, "done", "ya").unwrap()),
        ("isian asing di subtask", &B, On::Live, |am, o, _| am.put(o, "warna", "merah").unwrap()),
        ("hapus key subtask", &A, On::Subtasks, |am, m, id| am.delete(m, id).unwrap()),
        ("timpa subtask", &A, On::Subtasks, |am, m, id| {
            am.put_object(m, id, ObjType::Map).unwrap();
        }),
        ("hapus key catatan", &A, On::Time, |am, m, id| am.delete(m, id).unwrap()),
        ("ganti map subtasks", &A, On::Task, |am, t, _| {
            am.put_object(t, "subtasks", ObjType::Map).unwrap();
        }),
        ("hapus map time", &A, On::Task, |am, t, _| am.delete(t, "time").unwrap()),
    ];
    for (label, who, on, edit) in cases {
        let c = change_by(&mut doc, who, |d| {
            let (obj, arg) = match on {
                On::Entry => (entry(d, &task_a, "time", &eid), b_hex.clone()),
                On::GoneEntry => (entry(d, &task_a, "time", &gone_entry), b_hex.clone()),
                On::Gone => (entry(d, &task_a, "subtasks", &gone), b_hex.clone()),
                On::Live => (entry(d, &task_a, "subtasks", &live), b_hex.clone()),
                On::Subtasks => (part_obj(d, &task_a, "subtasks"), live.clone()),
                On::Time => (part_obj(d, &task_a, "time"), eid.clone()),
                On::Task => (task_obj(d, &task_a), String::new()),
            };
            edit(d.raw(), &obj, &arg);
        });
        assert!(judge(&doc, &c).is_err(), "{label} harus ditolak");
    }
    // `time` made as a list on a task without it.
    let (mut old, old_task, _) = old_base();
    let c = change_by(&mut old, &A, |d| {
        let t = task_obj(d, &old_task);
        d.raw().put_object(&t, "time", ObjType::List).unwrap();
    });
    assert!(judge(&old, &c).is_err(), "time berupa list harus ditolak");
}

/// Stages a bare subtask at `sid` in the `subtasks` map of `task`.
fn raw_subtask(d: &mut BoardDoc, task: &str, sid: &str, created_by: &str, nonce: Option<&str>) {
    let m = part_obj(d, task, "subtasks");
    let am = d.raw();
    let s = am.put_object(&m, sid, ObjType::Map).unwrap();
    if let Some(n) = nonce {
        am.put(&s, "nonce", n).unwrap();
    }
    am.put(&s, "created_by", created_by).unwrap();
    am.put(&s, "title", "x").unwrap();
}

/// Stages a bare time entry at `eid` in the `time` map of `task`.
fn raw_entry(d: &mut BoardDoc, task: &str, eid: &str, by: &str, nonce: Option<&str>) {
    let m = part_obj(d, task, "time");
    let am = d.raw();
    let e = am.put_object(&m, eid, ObjType::Map).unwrap();
    if let Some(n) = nonce {
        am.put(&e, "nonce", n).unwrap();
    }
    am.put(&e, "by", by).unwrap();
    am.put(&e, "start", T0).unwrap();
}

#[test]
fn new_subtasks_and_entries_must_be_bound_to_their_author() {
    let (mut doc, task_a, _, _) = base();
    let a = hex32(&A);
    let b = hex32(&B);
    let nonce = random_id();
    let n = Some(nonce.clone());
    // (label, subtask?, id, written as, nonce, expected error part)
    type Case<'a> = (&'a str, bool, String, &'a String, Option<String>, &'a str);
    let cases: Vec<Case> = vec![
        ("subtask id acak", true, random_id(), &b, n.clone(), "tidak cocok"),
        ("subtask tanpa nonce", true, derive_subtask_id(&b, &nonce), &b, None, "tidak cocok"),
        ("subtask id task", true, derive_task_id(&b, &nonce), &b, n.clone(), "tidak cocok"),
        ("subtask atas nama A", true, derive_subtask_id(&a, &nonce), &a, n.clone(), "atas nama"),
        ("catatan id acak", false, random_id(), &b, n.clone(), "tidak cocok"),
        ("catatan id subtask", false, derive_subtask_id(&b, &nonce), &b, n.clone(), "tidak cocok"),
        ("catatan atas nama A", false, derive_time_id(&a, &nonce), &a, n.clone(), "atas nama"),
    ];
    for (label, is_sub, id, as_who, n, want) in cases {
        let mut d = BoardDoc::load(&doc.save(), &A).unwrap();
        let c = change_by(&mut d, &B, |x| {
            if is_sub {
                raw_subtask(x, &task_a, &id, as_who, n.as_deref());
            } else {
                raw_entry(x, &task_a, &id, as_who, n.as_deref());
            }
        });
        let err = accept(&mut d, c, &b).expect_err(label);
        assert!(err.contains(want), "{label}: {err}");
    }
    let mut d = BoardDoc::load(&doc.save(), &A).unwrap();
    let c = change_by(&mut d, &B, |x| {
        raw_subtask(x, &task_a, &derive_subtask_id(&b, &nonce), &b, Some(&nonce));
        raw_entry(x, &task_a, &derive_time_id(&b, &nonce), &b, Some(&nonce));
    });
    let needs = accept(&mut d, c, &b).unwrap();
    assert_eq!(needs.new_subtasks.len(), 1);
    assert_eq!(needs.new_time.len(), 1);
}

#[test]
fn subtasks_in_a_new_map_or_a_new_task_are_checked_too() {
    // A new `subtasks` map on an old task, holding a subtask in A's name.
    let (mut doc, task_a, _) = old_base();
    let a = hex32(&A);
    let b = hex32(&B);
    let mut d = BoardDoc::load(&doc.save(), &A).unwrap();
    let c = change_by(&mut d, &B, |x| {
        x.add_subtask(Stamp { actor: &a, at: T0 }, &task_a, "palsu", None)
            .unwrap();
    });
    let needs = judge(&d, &c).unwrap();
    assert_eq!(needs.new_subtasks.len(), 1, "{needs:?}");
    assert!(accept(&mut d, c, &b).is_err());

    // A new task of B with a time entry in A's name.
    let mut d = BoardDoc::load(&doc.save(), &A).unwrap();
    let c = change_by(&mut d, &B, |x| {
        let id = x
            .create_task(Stamp { actor: &b, at: T0 }, TaskInit::default())
            .unwrap();
        x.log_time(Stamp { actor: &a, at: T0 }, &id, 60, "").unwrap();
    });
    let needs = judge(&d, &c).unwrap();
    assert_eq!(needs.new_time.len(), 1, "{needs:?}");
    let err = accept(&mut d, c, &b).unwrap_err();
    assert!(err.contains("atas nama"), "{err}");
}

#[test]
fn ticking_a_subtask_ticked_concurrently_is_allowed() {
    let (mut doc, task_a, _, _) = base();
    let a = hex32(&A);
    let b = hex32(&B);
    let c = change_by(&mut doc, &A, |d| {
        d.add_subtask(Stamp { actor: &a, at: T0 }, &task_a, "s", None).unwrap();
    });
    accept(&mut doc, c, &a).unwrap();
    let sid = first_subtask(&doc, &task_a);
    let tick = SubtaskChanges {
        done: Some(true),
        ..Default::default()
    };
    // Both tick it offline: `done`, `done_by` and `done_at` conflict.
    let ca = change_by(&mut doc, &A, |d| {
        d.update_subtask(Stamp { actor: &a, at: T1 }, &task_a, &sid, &tick).unwrap();
    });
    let cb = change_by(&mut doc, &B, |d| {
        d.update_subtask(Stamp { actor: &b, at: T1 }, &task_a, &sid, &tick).unwrap();
    });
    accept(&mut doc, ca, &a).unwrap();
    accept(&mut doc, cb, &b).unwrap();
    let o = entry(&mut doc, &task_a, "subtasks", &sid);
    assert_eq!(doc.raw().get_all(&o, "done").unwrap().len(), 2);
    // Opening it again overwrites every conflicting value.
    let open = SubtaskChanges {
        done: Some(false),
        ..Default::default()
    };
    let c = change_by(&mut doc, &B, |d| {
        d.update_subtask(Stamp { actor: &b, at: T1 }, &task_a, &sid, &open).unwrap();
    });
    accept(&mut doc, c, &b).unwrap();
    let o = entry(&mut doc, &task_a, "subtasks", &sid);
    assert_eq!(doc.raw().get_all(&o, "done_at").unwrap().len(), 1);
}
