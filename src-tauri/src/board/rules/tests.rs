use automerge::transaction::Transactable;
use automerge::{ObjType, ROOT, ReadDoc, Value};

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
