//! Two laptops (two databases, two keys) exchanging board changes.

use proptest::prelude::*;
use rusqlite::Connection;

use super::*;
use crate::board::assignees::LocalMembers;
use crate::board::doc::{Stamp, TaskChanges, TaskData, TaskInit};
use crate::board::model::{ColumnId, Priority};
use crate::board::policy::LocalRolePolicy;
use crate::board::sign::sign_change;
use crate::board::store::{actor_of, commit_local, create_project, stored_changes};
use crate::board::testutil::{Laptop, add_member};
use crate::board::view::Ctx;

fn pair() -> (Laptop, Laptop) {
    let a = Laptop::founder("Sari");
    let b = Laptop::joined(&a, "Budi");
    (a, b)
}

fn now_stamp(me: &str) -> (String, String) {
    (me.to_owned(), clock::now_rfc3339())
}

fn mutate<T>(
    l: &mut Laptop,
    project: &str,
    f: impl FnOnce(&mut BoardDoc, Stamp<'_>) -> AppResult<T>,
) -> T {
    let (me, at) = now_stamp(l.id.public_key_hex());
    commit_local(&mut l.conn, &l.id, project, |d| {
        f(
            d,
            Stamp {
                actor: &me,
                at: &at,
            },
        )
    })
    .unwrap()
    .value
}

fn rejected(conn: &Connection) -> Vec<String> {
    conn.prepare("SELECT code FROM rejected_changes ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

/// Sends `from` everything `to` lacks, as a transport would.
fn send(from: &Laptop, to: &mut Laptop, project: &str) -> ApplyReport {
    let have = if store::project(&to.conn, project).is_ok() {
        heads(&to.conn, project).unwrap()
    } else {
        Vec::new()
    };
    let changes = changes_since(&from.conn, project, &have).unwrap();
    let from_pk = from.pk();
    import_project(
        &mut to.conn,
        &LocalRolePolicy,
        project,
        Some(&from_pk),
        changes,
    )
    .unwrap()
}

fn tasks(l: &Laptop, project: &str) -> Vec<TaskData> {
    store::load_doc(&l.conn, project, &actor_of(&l.id))
        .unwrap()
        .tasks()
        .unwrap()
}

/// Board and every task detail as JSON, without the viewer-specific fields.
fn view_json(l: &Laptop, project: &str) -> serde_json::Value {
    let dir = LocalMembers::new(&l.id);
    let ctx = Ctx {
        conn: &l.conn,
        me: l.id.public_key_hex(),
        policy: &LocalRolePolicy,
        dir: &dir,
    };
    let row = store::project(&l.conn, project).unwrap();
    let doc = store::load_doc(&l.conn, project, &actor_of(&l.id)).unwrap();
    let board = ctx.board(&row, &doc).unwrap();
    let details: Vec<serde_json::Value> = doc
        .tasks()
        .unwrap()
        .iter()
        .filter(|t| !t.deleted)
        .map(|t| {
            let mut v = serde_json::to_value(ctx.detail(&row, t)).unwrap();
            let o = v.as_object_mut().unwrap();
            o.remove("canEdit");
            o.remove("canDelete");
            v
        })
        .collect();
    serde_json::json!({
        "columns": board.columns,
        "openCount": board.project.open_count,
        "taskCount": board.project.task_count,
        "details": details,
    })
}

#[test]
fn concurrent_edits_of_the_same_task_merge_without_loss() {
    let (mut a, mut b) = pair();
    let p = create_project(&mut a.conn, &a.id, "Situs Web", "WEB", None)
        .unwrap()
        .value;
    let task = mutate(&mut a, &p.id, |d, s| {
        d.create_task(
            s,
            TaskInit {
                title: "Halaman depan".into(),
                description: "Draf awal".into(),
                ..Default::default()
            },
        )
    });
    let r = send(&a, &mut b, &p.id);
    assert_eq!((r.applied, r.rejected, r.missing_deps), (2, 0, 0));
    let imported = store::project(&b.conn, &p.id).unwrap();
    assert_eq!(imported.code, "WEB");
    assert_eq!(imported.name, "Situs Web");
    assert_eq!(imported.created_by, a.pk());

    // Offline: A renames and moves; B edits the description, comments and sets a due date.
    mutate(&mut a, &p.id, |d, s| {
        d.update_task(
            s,
            &task,
            &TaskChanges {
                title: Some("Halaman depan baru".into()),
                ..Default::default()
            },
            &|_| String::new(),
        )
    });
    mutate(&mut a, &p.id, |d, s| {
        d.move_task(s, &task, ColumnId::Doing, 0)
    });
    mutate(&mut b, &p.id, |d, s| {
        d.update_task(
            s,
            &task,
            &TaskChanges {
                description: Some("Draf awal, tambah foto tim".into()),
                due: Some(Some("2026-12-01".into())),
                ..Default::default()
            },
            &|_| String::new(),
        )
    });
    let comment = mutate(&mut b, &p.id, |d, s| {
        d.add_comment(s, &task, "Fotonya saya siapkan")
    });

    let ab = send(&a, &mut b, &p.id);
    let ba = send(&b, &mut a, &p.id);
    assert_eq!((ab.applied, ab.rejected), (2, 0));
    assert_eq!((ba.applied, ba.rejected), (2, 0));

    let ta = tasks(&a, &p.id);
    assert_eq!(ta, tasks(&b, &p.id));
    let t = &ta[0];
    assert_eq!(t.title, "Halaman depan baru");
    assert_eq!(t.column, ColumnId::Doing);
    assert_eq!(t.description, "Draf awal, tambah foto tim");
    assert_eq!(t.due.as_deref(), Some("2026-12-01"));
    assert_eq!(t.comments.len(), 1);
    assert_eq!(t.comments[0].id, comment);
    assert_eq!(t.comments[0].author, b.pk());
    let kinds: Vec<&str> = t.activity.iter().map(|x| x.kind.as_str()).collect();
    for k in [
        "created",
        "title",
        "moved",
        "description",
        "due",
        "commented",
    ] {
        assert!(kinds.contains(&k), "{k} missing from {kinds:?}");
    }
    assert_eq!(view_json(&a, &p.id), view_json(&b, &p.id));
    assert_eq!(
        heads(&a.conn, &p.id).unwrap(),
        heads(&b.conn, &p.id).unwrap()
    );
    assert_eq!(
        store::index_rows(&a.conn, &p.id).unwrap(),
        store::index_rows(&b.conn, &p.id).unwrap()
    );

    // Sending again is a no-op.
    let again = send(&a, &mut b, &p.id);
    assert_eq!(again, ApplyReport::default());
    let all = stored_changes(&a.conn, &p.id).unwrap();
    let dup =
        apply_remote_changes(&mut b.conn, &LocalRolePolicy, &p.id, None, all.clone()).unwrap();
    assert_eq!(dup.duplicates, all.len());
    assert_eq!(dup.applied, 0);
    assert!(rejected(&a.conn).is_empty() && rejected(&b.conn).is_empty());
}

#[test]
fn changes_out_of_order_wait_for_dependencies() {
    let (mut a, mut b) = pair();
    let p = create_project(&mut a.conn, &a.id, "Alfa", "PA", None)
        .unwrap()
        .value;
    send(&a, &mut b, &p.id);
    let t = mutate(&mut a, &p.id, |d, s| {
        d.create_task(
            s,
            TaskInit {
                title: "x".into(),
                ..Default::default()
            },
        )
    });
    mutate(&mut a, &p.id, |d, s| d.add_comment(s, &t, "y"));
    let mut fresh = changes_since(&a.conn, &p.id, &heads(&b.conn, &p.id).unwrap()).unwrap();
    assert_eq!(fresh.len(), 2);
    let last = fresh.pop().unwrap();
    let r = apply_remote_changes(
        &mut b.conn,
        &LocalRolePolicy,
        &p.id,
        None,
        vec![last.clone()],
    )
    .unwrap();
    assert_eq!((r.applied, r.missing_deps), (0, 1));
    fresh.reverse();
    fresh.insert(0, last);
    let r = apply_remote_changes(&mut b.conn, &LocalRolePolicy, &p.id, None, fresh).unwrap();
    assert_eq!((r.applied, r.missing_deps), (2, 0));
    assert_eq!(tasks(&a, &p.id), tasks(&b, &p.id));
}

#[test]
fn bad_signature_and_non_member_are_rejected_and_logged() {
    let (mut a, mut b) = pair();
    let p = create_project(&mut a.conn, &a.id, "Alfa", "PA", None)
        .unwrap()
        .value;
    send(&a, &mut b, &p.id);

    // Tampered signature.
    mutate(&mut a, &p.id, |d, s| {
        d.create_task(
            s,
            TaskInit {
                title: "x".into(),
                ..Default::default()
            },
        )
    });
    let mut fresh = changes_since(&a.conn, &p.id, &heads(&b.conn, &p.id).unwrap()).unwrap();
    let flipped = if fresh[0].sig.starts_with("00") {
        "11"
    } else {
        "00"
    };
    fresh[0].sig.replace_range(0..2, flipped);
    let r =
        apply_remote_changes(&mut b.conn, &LocalRolePolicy, &p.id, Some(&a.pk()), fresh).unwrap();
    assert_eq!((r.applied, r.rejected), (0, 1));
    assert_eq!(rejected(&b.conn), ["board_bad_signature"]);
    assert_eq!(tasks(&b, &p.id).len(), 0, "nothing applied");
    assert_eq!(stored_changes(&b.conn, &p.id).unwrap().len(), 1);

    // An outsider with a valid signature, building on the shared document.
    let mut outsider = Laptop::bare("Orang Luar");
    let snapshot: Vec<u8> = a
        .conn
        .query_row(
            "SELECT doc FROM board_projects WHERE id = ?1",
            [&p.id],
            |r| r.get(0),
        )
        .unwrap();
    let mut doc = BoardDoc::load(&snapshot, &actor_of(&outsider.id)).unwrap();
    let before = doc.heads();
    let me = outsider.pk();
    doc.create_task(
        Stamp {
            actor: &me,
            at: "t",
        },
        TaskInit {
            title: "spam".into(),
            ..Default::default()
        },
    )
    .unwrap();
    doc.commit(0).unwrap();
    let signed: Vec<SignedChange> = doc
        .changes_after(&before)
        .iter()
        .map(|c| sign_change(&outsider.id, &p.id, c))
        .collect();
    let r = apply_remote_changes(
        &mut a.conn,
        &LocalRolePolicy,
        &p.id,
        Some(&me),
        signed.clone(),
    )
    .unwrap();
    // Held, not refused for good: the op that admits the author may still
    // be on its way. Held changes are not logged here (the caller logs once).
    assert_eq!((r.applied, r.rejected, r.held), (0, 0, 1));
    assert!(matches!(
        r.outcome(&signed[0].hash),
        Some(ChangeOutcome::Held {
            code: "board_forbidden",
            ..
        })
    ));
    assert!(rejected(&a.conn).is_empty());

    // A removed member is held too; a guest as well.
    add_member(&a.conn, &me, "Orang Luar", "removed");
    let r = apply_remote_changes(
        &mut a.conn,
        &LocalRolePolicy,
        &p.id,
        Some(&me),
        signed.clone(),
    )
    .unwrap();
    assert_eq!(r.held, 1);
    add_member(&a.conn, &me, "Orang Luar", "guest");
    let r = apply_remote_changes(
        &mut a.conn,
        &LocalRolePolicy,
        &p.id,
        Some(&me),
        signed.clone(),
    )
    .unwrap();
    assert_eq!(r.held, 1);
    // Once a member, the same change is accepted.
    add_member(&a.conn, &me, "Orang Luar", "member");
    let r = apply_remote_changes(&mut a.conn, &LocalRolePolicy, &p.id, Some(&me), signed).unwrap();
    assert_eq!(r.applied, 1);
    let _ = &mut outsider;

    // A change for another project is refused.
    let other = create_project(&mut a.conn, &a.id, "Beta", "PB", None)
        .unwrap()
        .value;
    let wrong = stored_changes(&a.conn, &other.id).unwrap();
    let r = apply_remote_changes(&mut b.conn, &LocalRolePolicy, &p.id, None, wrong).unwrap();
    assert_eq!(r.rejected, 1);
    assert_eq!(rejected(&b.conn).last().unwrap(), "board_wrong_project");
}

#[test]
fn import_requires_a_creator_allowed_to_create_projects() {
    let (mut a, mut b) = pair();
    // B is a plain member on A's laptop and cannot create projects there.
    let mut b_admin = Laptop::founder("Budi");
    let p = create_project(&mut b_admin.conn, &b_admin.id, "Gamma", "PG", None)
        .unwrap()
        .value;
    add_member(&a.conn, &b_admin.pk(), "Budi", "member");
    let changes = stored_changes(&b_admin.conn, &p.id).unwrap();
    let root = changes[0].hash.clone();
    let r = import_project(&mut a.conn, &LocalRolePolicy, &p.id, None, changes).unwrap();
    assert!(matches!(
        r.outcome(&root),
        Some(ChangeOutcome::Held {
            code: "board_forbidden",
            ..
        })
    ));
    assert_eq!(r.applied, 0);
    assert!(store::project(&a.conn, &p.id).is_err());
    assert!(rejected(&a.conn).is_empty());

    // Code already used locally: both projects stay, with distinct codes.
    let local = create_project(&mut a.conn, &a.id, "Lokal", "PG", None)
        .unwrap()
        .value;
    add_member(&a.conn, &b_admin.pk(), "Budi", "superadmin");
    let changes = stored_changes(&b_admin.conn, &p.id).unwrap();
    let r = import_project(&mut a.conn, &LocalRolePolicy, &p.id, None, changes).unwrap();
    assert_eq!(r.applied, 1);
    let mut codes = vec![
        store::project(&a.conn, &p.id).unwrap().code,
        store::project(&a.conn, &local.id).unwrap().code,
    ];
    codes.sort();
    assert_eq!(codes, ["PG", "PG2"]);

    // Without the first change the project cannot be imported.
    let p2 = create_project(&mut a.conn, &a.id, "Delta", "PD", None)
        .unwrap()
        .value;
    mutate(&mut a, &p2.id, |d, s| {
        d.create_task(
            s,
            TaskInit {
                title: "x".into(),
                ..Default::default()
            },
        )
    });
    let mut changes = stored_changes(&a.conn, &p2.id).unwrap();
    changes.remove(0);
    let r = import_project(&mut b.conn, &LocalRolePolicy, &p2.id, None, changes).unwrap();
    assert_eq!((r.applied, r.missing_deps), (0, 1));
    assert_eq!(r.outcomes[0].1, ChangeOutcome::NoProject);
    assert!(store::project(&b.conn, &p2.id).is_err());
}

#[test]
fn duplicate_numbers_are_detected() {
    let (mut a, mut b) = pair();
    let p = create_project(&mut a.conn, &a.id, "Alfa", "PA", None)
        .unwrap()
        .value;
    send(&a, &mut b, &p.id);
    let ta = mutate(&mut a, &p.id, |d, s| {
        d.create_task(
            s,
            TaskInit {
                title: "a".into(),
                ..Default::default()
            },
        )
    });
    let tb = mutate(&mut b, &p.id, |d, s| {
        d.create_task(
            s,
            TaskInit {
                title: "b".into(),
                ..Default::default()
            },
        )
    });
    send(&a, &mut b, &p.id);
    send(&b, &mut a, &p.id);
    let doc = store::load_doc(&a.conn, &p.id, &actor_of(&a.id)).unwrap();
    let dups = duplicate_numbers(&doc).unwrap();
    assert_eq!(dups.len(), 1);
    assert_eq!(dups[0].0, 1);
    let mut ids = dups[0].1.clone();
    ids.sort();
    let mut want = vec![ta, tb];
    want.sort();
    assert_eq!(ids, want);
    // The next task on either side gets a fresh number.
    let n = mutate(&mut a, &p.id, |d, s| {
        d.create_task(
            s,
            TaskInit {
                title: "c".into(),
                ..Default::default()
            },
        )
    });
    let doc = store::load_doc(&a.conn, &p.id, &actor_of(&a.id)).unwrap();
    assert_eq!(doc.live_task(&n).unwrap().number, 2);
}

/// A's document as stored, opened with A's actor, for crafting changes.
fn fork_of(l: &Laptop, project: &str) -> BoardDoc {
    let snapshot: Vec<u8> = l
        .conn
        .query_row(
            "SELECT doc FROM board_projects WHERE id = ?1",
            [project],
            |r| r.get(0),
        )
        .unwrap();
    BoardDoc::load(&snapshot, &actor_of(&l.id)).unwrap()
}

/// Signed changes `edit` makes on `doc`, each commit one change.
fn craft(
    l: &Laptop,
    project: &str,
    doc: &mut BoardDoc,
    edit: impl FnOnce(&mut BoardDoc),
) -> Vec<SignedChange> {
    let before = doc.heads();
    edit(doc);
    doc.commit(0);
    doc.changes_after(&before)
        .iter()
        .map(|c| sign_change(&l.id, project, c))
        .collect()
}

fn new_task(title: &str) -> TaskInit {
    TaskInit {
        title: title.into(),
        ..Default::default()
    }
}

#[test]
fn a_change_automerge_refuses_does_not_block_the_batch() {
    let (mut a, mut b) = pair();
    let p = create_project(&mut a.conn, &a.id, "Alfa", "PA", None)
        .unwrap()
        .value;
    send(&a, &mut b, &p.id);
    let me = a.pk();
    let stamp = Stamp {
        actor: &me,
        at: "t",
    };

    // Two different changes with A's actor and the same sequence number.
    let mut d1 = fork_of(&a, &p.id);
    let mut d2 = fork_of(&a, &p.id);
    let first = craft(&a, &p.id, &mut d1, |d| {
        d.create_task(stamp, new_task("satu")).unwrap();
    });
    let forked = craft(&a, &p.id, &mut d2, |d| {
        d.create_task(stamp, new_task("kembar")).unwrap();
    });
    let after = craft(&a, &p.id, &mut d1, |d| {
        d.create_task(stamp, new_task("dua")).unwrap();
    });
    assert_eq!(first[0].seq, forked[0].seq);
    assert_ne!(first[0].hash, forked[0].hash);

    // Garbage with a valid envelope and signature.
    let mut junk = vec![0x85, 0x6f, 0x4a, 0x83, 0, 0, 0, 0, 1];
    junk.extend_from_slice(b"bukan change automerge");
    let garbage = SignedChange {
        project_id: p.id.clone(),
        hash: "ab".repeat(32),
        author: a.pk(),
        seq: 9,
        sig: hex::encode(
            a.id.sign(&crate::board::sign::signing_message(&p.id, &junk))
                .to_bytes(),
        ),
        bytes: junk,
    };

    let batch = [vec![garbage], first, forked, after].concat();
    let r = apply_remote_changes(&mut b.conn, &LocalRolePolicy, &p.id, Some(&me), batch).unwrap();
    assert_eq!((r.applied, r.rejected, r.missing_deps), (2, 2, 0));
    assert_eq!(
        rejected(&b.conn),
        ["board_bad_format", "board_apply_failed"]
    );
    let titles: Vec<String> = tasks(&b, &p.id).into_iter().map(|t| t.title).collect();
    assert_eq!(titles, ["satu", "dua"]);
    for sc in stored_changes(&b.conn, &p.id).unwrap() {
        crate::board::sign::verify_change(&sc).unwrap();
    }
    // The board still opens and later changes still apply.
    view_json(&b, &p.id);
    mutate(&mut b, &p.id, |d, s| d.create_task(s, new_task("tiga")));
    assert_eq!(tasks(&b, &p.id).len(), 3);
}

#[test]
fn changes_that_break_the_document_shape_are_refused() {
    let (mut a, mut b) = pair();
    let p = create_project(&mut a.conn, &a.id, "Alfa", "PA", None)
        .unwrap()
        .value;
    let task = mutate(&mut a, &p.id, |d, s| d.create_task(s, new_task("satu")));
    mutate(&mut a, &p.id, |d, s| d.create_task(s, new_task("dua")));
    let gone = mutate(&mut a, &p.id, |d, s| d.create_task(s, new_task("hapus")));
    mutate(&mut a, &p.id, |d, s| d.delete_task(s, &gone));
    send(&a, &mut b, &p.id);
    let me = a.pk();

    use automerge::ROOT;
    use automerge::ReadDoc;
    use automerge::transaction::Transactable;
    let task_obj = |d: &mut BoardDoc, id: &str| {
        let tasks = d.raw().get(ROOT, "tasks").unwrap().unwrap().1;
        d.raw().get(&tasks, id).unwrap().unwrap().1
    };
    type Edit = Box<dyn Fn(&mut BoardDoc)>;
    let (t1, t3) = (task.clone(), gone.clone());
    let cases: Vec<(&str, Edit)> = vec![
        (
            "tasks replaced by a scalar",
            Box::new(|d| {
                d.raw().put(ROOT, "tasks", "rusak").unwrap();
            }),
        ),
        (
            "created_by rewritten",
            Box::new(move |d| {
                let t = task_obj(d, &t1);
                d.raw().put(&t, "created_by", "ab".repeat(32)).unwrap();
            }),
        ),
        (
            "deleted task brought back",
            Box::new(move |d| {
                let t = task_obj(d, &t3);
                d.raw().put(&t, "deleted", false).unwrap();
            }),
        ),
        (
            "unknown column",
            Box::new({
                let t1 = task.clone();
                move |d| {
                    let t = task_obj(d, &t1);
                    d.raw().put(&t, "column", "arsip").unwrap();
                }
            }),
        ),
        (
            "title not text",
            Box::new({
                let t1 = task.clone();
                move |d| {
                    let t = task_obj(d, &t1);
                    d.raw().put(&t, "title", 5_i64).unwrap();
                }
            }),
        ),
        (
            "task in someone else's name",
            Box::new(move |d| {
                let other = "cd".repeat(32);
                d.create_task(
                    Stamp {
                        actor: &other,
                        at: "t",
                    },
                    new_task("palsu"),
                )
                .unwrap();
            }),
        ),
    ];
    let before = tasks(&b, &p.id);
    for (label, edit) in cases {
        let mut d = fork_of(&a, &p.id);
        let bad = craft(&a, &p.id, &mut d, |d| edit(d));
        assert_eq!(bad.len(), 1, "{label}");
        let r = apply_remote_changes(&mut b.conn, &LocalRolePolicy, &p.id, Some(&me), bad).unwrap();
        assert_eq!((r.applied, r.rejected), (0, 1), "{label}");
        assert_eq!(
            rejected(&b.conn).last().unwrap(),
            "board_invalid_doc",
            "{label}"
        );
        assert_eq!(tasks(&b, &p.id), before, "{label}");
    }
    view_json(&b, &p.id);
    // A good change from A still goes through afterwards.
    mutate(&mut a, &p.id, |d, s| d.add_comment(s, &task, "oke"));
    let r = send(&a, &mut b, &p.id);
    assert_eq!((r.applied, r.rejected), (1, 0));
}

#[test]
fn strangers_are_refused_before_parsing_and_batches_are_capped() {
    let (mut a, mut b) = pair();
    let p = create_project(&mut a.conn, &a.id, "Alfa", "PA", None)
        .unwrap()
        .value;
    send(&a, &mut b, &p.id);
    // An outsider's garbage is refused for the author, not for its content.
    let outsider = Laptop::bare("Orang Luar");
    let mut junk = vec![0x85, 0x6f, 0x4a, 0x83, 0, 0, 0, 0, 1];
    junk.extend_from_slice(b"isi acak");
    let sc = SignedChange {
        project_id: p.id.clone(),
        hash: "ab".repeat(32),
        author: outsider.pk(),
        seq: 1,
        sig: hex::encode(
            outsider
                .id
                .sign(&crate::board::sign::signing_message(&p.id, &junk))
                .to_bytes(),
        ),
        bytes: junk,
    };
    let r = apply_remote_changes(&mut b.conn, &LocalRolePolicy, &p.id, None, vec![sc]).unwrap();
    // Held without being parsed (junk bytes would otherwise be rejected as
    // bad format); held changes are logged by the caller, not here.
    assert_eq!((r.held, r.rejected), (1, 0));
    assert!(rejected(&b.conn).is_empty());

    // Over the count limit: the rest is deferred, not dropped silently.
    for i in 0..3 {
        mutate(&mut a, &p.id, |d, s| {
            d.create_task(s, new_task(&format!("t{i}")))
        });
    }
    let fresh = changes_since(&a.conn, &p.id, &heads(&b.conn, &p.id).unwrap()).unwrap();
    let mut batch = Vec::new();
    while batch.len() <= MAX_BATCH_CHANGES {
        batch.extend(fresh.iter().cloned());
    }
    let total = batch.len();
    let r = apply_remote_changes(&mut b.conn, &LocalRolePolicy, &p.id, None, batch).unwrap();
    assert_eq!(r.applied, 3);
    assert_eq!(r.deferred, total - MAX_BATCH_CHANGES);
    assert_eq!(r.applied + r.duplicates + r.deferred, total);
}

#[derive(Debug, Clone)]
enum Op {
    Create(u8, u8),
    Title(usize, u8),
    Describe(usize, u8),
    Move(usize, u8, usize),
    Comment(usize, u8),
    Delete(usize),
    Due(usize, Option<u8>),
    Priority(usize, u8),
    Labels(usize, Vec<u8>),
}

fn op() -> impl Strategy<Value = Op> {
    let ix = any::<usize>;
    prop_oneof![
        (any::<u8>(), 0u8..3).prop_map(|(t, c)| Op::Create(t, c)),
        (ix(), any::<u8>()).prop_map(|(i, t)| Op::Title(i, t)),
        (ix(), any::<u8>()).prop_map(|(i, t)| Op::Describe(i, t)),
        (ix(), 0u8..3, 0usize..6).prop_map(|(i, c, p)| Op::Move(i, c, p)),
        (ix(), any::<u8>()).prop_map(|(i, t)| Op::Comment(i, t)),
        ix().prop_map(Op::Delete),
        (ix(), proptest::option::of(1u8..28)).prop_map(|(i, d)| Op::Due(i, d)),
        (ix(), 0u8..4).prop_map(|(i, p)| Op::Priority(i, p)),
        (ix(), proptest::collection::vec(0u8..5, 0..4)).prop_map(|(i, l)| Op::Labels(i, l)),
    ]
}

fn run(l: &mut Laptop, project: &str, op: &Op) {
    let live: Vec<String> = tasks(l, project)
        .into_iter()
        .filter(|t| !t.deleted)
        .map(|t| t.id)
        .collect();
    let pick = |i: usize| live.get(i % live.len().max(1)).cloned();
    let column = |c: u8| ColumnId::ALL[usize::from(c) % 3];
    match op {
        Op::Create(t, c) => {
            let col = column(*c);
            mutate(l, project, |d, s| {
                d.create_task(
                    s,
                    TaskInit {
                        title: format!("Task {t}"),
                        column: Some(col),
                        ..Default::default()
                    },
                )
            });
        }
        other => {
            let Some(id) = pick(match other {
                Op::Title(i, _)
                | Op::Describe(i, _)
                | Op::Move(i, _, _)
                | Op::Comment(i, _)
                | Op::Delete(i)
                | Op::Due(i, _)
                | Op::Priority(i, _)
                | Op::Labels(i, _) => *i,
                Op::Create(..) => 0,
            }) else {
                return;
            };
            let names = |_: &str| String::new();
            mutate(l, project, |d, s| match other {
                Op::Title(_, t) => d.update_task(
                    s,
                    &id,
                    &TaskChanges {
                        title: Some(format!("Judul {t}")),
                        ..Default::default()
                    },
                    &names,
                ),
                Op::Describe(_, t) => {
                    let cur = d.live_task(&id)?.description;
                    d.update_task(
                        s,
                        &id,
                        &TaskChanges {
                            description: Some(format!("{cur} kata{t}")),
                            ..Default::default()
                        },
                        &names,
                    )
                }
                Op::Move(_, c, pos) => d.move_task(s, &id, column(*c), *pos),
                Op::Comment(_, t) => d.add_comment(s, &id, &format!("komentar {t}")).map(|_| ()),
                Op::Delete(_) => d.delete_task(s, &id),
                Op::Due(_, day) => d.update_task(
                    s,
                    &id,
                    &TaskChanges {
                        due: Some(day.map(|x| format!("2026-12-{x:02}"))),
                        ..Default::default()
                    },
                    &names,
                ),
                Op::Priority(_, p) => d.update_task(
                    s,
                    &id,
                    &TaskChanges {
                        priority: Some(
                            [
                                Priority::None,
                                Priority::Low,
                                Priority::Medium,
                                Priority::High,
                            ][usize::from(*p)],
                        ),
                        ..Default::default()
                    },
                    &names,
                ),
                Op::Labels(_, ls) => d.update_task(
                    s,
                    &id,
                    &TaskChanges {
                        labels: Some({
                            let mut v: Vec<String> = ls.iter().map(|x| format!("L{x}")).collect();
                            v.dedup();
                            v.sort();
                            v.dedup();
                            v
                        }),
                        ..Default::default()
                    },
                    &names,
                ),
                Op::Create(..) => Ok(()),
            });
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 24, ..ProptestConfig::default() })]

    #[test]
    fn random_concurrent_edits_converge(
        shared in proptest::collection::vec(op(), 0..6),
        ops_a in proptest::collection::vec(op(), 0..12),
        ops_b in proptest::collection::vec(op(), 0..12),
    ) {
        let (mut a, mut b) = pair();
        // Both may delete any task (superadmins of a project without team).
        add_member(&a.conn, &b.pk(), "Budi", "superadmin");
        add_member(&b.conn, &b.pk(), "Budi", "superadmin");
        let p = create_project(&mut a.conn, &a.id, "Alfa", "PA", None).unwrap().value;
        run(&mut a, &p.id, &Op::Create(0, 0));
        for o in &shared {
            run(&mut a, &p.id, o);
        }
        send(&a, &mut b, &p.id);
        prop_assert_eq!(tasks(&a, &p.id), tasks(&b, &p.id));

        for o in &ops_a {
            run(&mut a, &p.id, o);
        }
        for o in &ops_b {
            run(&mut b, &p.id, o);
        }
        let ab = send(&a, &mut b, &p.id);
        let ba = send(&b, &mut a, &p.id);
        prop_assert_eq!(ab.rejected + ba.rejected + ab.missing_deps + ba.missing_deps, 0);

        prop_assert_eq!(tasks(&a, &p.id), tasks(&b, &p.id));
        prop_assert_eq!(view_json(&a, &p.id), view_json(&b, &p.id));
        prop_assert_eq!(heads(&a.conn, &p.id).unwrap(), heads(&b.conn, &p.id).unwrap());
        prop_assert_eq!(
            store::index_rows(&a.conn, &p.id).unwrap(),
            store::index_rows(&b.conn, &p.id).unwrap()
        );
        // Every edit made on either side survives somewhere in the history.
        let total = stored_changes(&a.conn, &p.id).unwrap().len();
        prop_assert_eq!(total, stored_changes(&b.conn, &p.id).unwrap().len());
    }
}
