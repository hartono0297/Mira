use automerge::transaction::Transactable;
use automerge::{ObjType, ROOT, ReadDoc, Value};

use super::*;
use crate::board::doc::{ProjectMeta, Stamp, TaskChanges, TaskInit};
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
