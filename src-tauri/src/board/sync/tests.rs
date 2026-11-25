//! Two laptops (two databases, two keys) exchanging board changes.

use proptest::prelude::*;
use rusqlite::Connection;

use super::*;
use crate::board::assignees::LocalMembers;
use crate::board::doc::{Stamp, TaskChanges, TaskData, TaskInit};
use crate::board::model::{ColumnId, Priority};
use crate::board::policy::LocalRolePolicy;
use crate::board::sign::sign_change;
use crate::board::store::{Committed, ProjectRow, actor_of, commit_local, stored_changes};
use crate::board::testutil::{
    Laptop, add_member, add_project_member, copy_registration, org_ops, register_project,
    register_v02,
};
use crate::board::view::Ctx;
use crate::identity::Identity;
use crate::permissions::{self as p, InviteRole};

fn pair() -> (Laptop, Laptop) {
    let a = Laptop::founder("Sari");
    let b = Laptop::joined(&a, "Budi");
    (a, b)
}

/// Creates a project registered with its v0.2 readers on this laptop's
/// membership tables (written directly by the fixtures, so no op is
/// authored). `send` copies the registration, as syncing the log would.
fn create_project(
    conn: &mut Connection,
    id: &Identity,
    name: &str,
    code: &str,
    team: Option<&str>,
) -> AppResult<Committed<ProjectRow>> {
    let c = store::create_project_local(conn, id, name, code, team)?;
    register_v02(conn, &c.value.id);
    Ok(c)
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
    copy_registration(&from.conn, &to.conn, project);
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
            o.remove("myTimerRunning");
            v
        })
        .collect();
    let mut columns = serde_json::to_value(&board.columns).unwrap();
    for c in columns.as_array_mut().unwrap() {
        for t in c["tasks"].as_array_mut().unwrap() {
            let o = t.as_object_mut().unwrap();
            o.remove("canEdit");
            o.remove("canDelete");
            o.remove("myTimerRunning");
        }
    }
    serde_json::json!({
        "columns": columns,
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

/// Like `mutate`, with the stamp `at`.
fn mutate_at<T>(
    l: &mut Laptop,
    project: &str,
    at: &str,
    f: impl FnOnce(&mut BoardDoc, Stamp<'_>) -> AppResult<T>,
) -> T {
    let me = l.id.public_key_hex().to_owned();
    commit_local(&mut l.conn, &l.id, project, |d| f(d, Stamp { actor: &me, at }))
        .unwrap()
        .value
}

#[test]
fn deleting_a_task_edited_concurrently_in_the_same_second_is_accepted() {
    // Both laptops edit a task offline in the same second, so `updated_at`
    // holds two equal concurrent values. A then deletes the task in that
    // second: Automerge writes the repeated `updated_at` as a delete of B's
    // value. B used to refuse it for good, and every later change of A
    // waited for it forever.
    let (mut a, mut b) = pair();
    let p = create_project(&mut a.conn, &a.id, "Situs Web", "WEB", None)
        .unwrap()
        .value;
    let at = "2026-11-22T10:00:00Z";
    let task = mutate_at(&mut a, &p.id, "2026-11-22T09:59:00Z", |d, s| {
        d.create_task(s, TaskInit {
            title: "Halaman depan".into(),
            ..Default::default()
        })
    });
    send(&a, &mut b, &p.id);
    mutate_at(&mut a, &p.id, at, |d, s| {
        d.move_task(s, &task, ColumnId::Doing, 0)
    });
    mutate_at(&mut b, &p.id, at, |d, s| d.add_comment(s, &task, "oke"));
    send(&a, &mut b, &p.id);
    send(&b, &mut a, &p.id);
    mutate_at(&mut a, &p.id, at, |d, s| d.delete_task(s, &task));
    mutate_at(&mut a, &p.id, at, |d, s| {
        d.create_task(s, TaskInit {
            title: "Sesudahnya".into(),
            ..Default::default()
        })
    });

    let r = send(&a, &mut b, &p.id);
    assert_eq!((r.applied, r.rejected, r.missing_deps), (2, 0, 0), "{r:?}");
    assert_eq!(tasks(&a, &p.id), tasks(&b, &p.id));
    assert_eq!(heads(&a.conn, &p.id).unwrap(), heads(&b.conn, &p.id).unwrap());
    assert!(rejected(&b.conn).is_empty(), "{:?}", rejected(&b.conn));
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
    // Once a member of the organization and of the project, the same
    // change is accepted.
    add_member(&a.conn, &me, "Orang Luar", "member");
    add_project_member(&a.conn, &p.id, &me);
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
    copy_registration(&b_admin.conn, &a.conn, &p.id);
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
        let code = rejected(&b.conn).last().unwrap().clone();
        assert!(
            code == "board_invalid_doc" || code == "board_not_allowed",
            "{label}: {code}"
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

#[test]
fn a_forged_first_change_cannot_take_over_a_project_id() {
    let (mut a, b) = pair();
    let mut c = Laptop::joined(&a, "Citra");
    // B may create projects on C's laptop (superadmin there).
    add_member(&c.conn, &b.pk(), "Budi", "superadmin");
    let p = create_project(&mut a.conn, &a.id, "Alfa", "PA", None)
        .unwrap()
        .value;
    assert!(store::is_syncable(&a.conn, &p.id).unwrap(), "bound id");

    // B forges a first change with A's project id under B's own key.
    let meta = crate::board::doc::ProjectMeta {
        id: p.id.clone(),
        code: "PX".into(),
        name: "Palsu".into(),
        team_id: None,
    };
    let mut forged = BoardDoc::create(&actor_of(&b.id), &meta).unwrap();
    forged.set_project_nonce(&"ab".repeat(16)).unwrap();
    forged.commit(1).unwrap();
    let fake: Vec<SignedChange> = forged
        .changes_after(&[])
        .iter()
        .map(|ch| sign_change(&b.id, &p.id, ch))
        .collect();
    let r = import_project(&mut c.conn, &LocalRolePolicy, &p.id, None, fake).unwrap();
    assert_eq!(r.applied, 0);
    assert_eq!(r.rejected, 1);
    assert!(store::project(&c.conn, &p.id).is_err());

    // The real project still imports afterwards.
    let r = send(&a, &mut c, &p.id);
    assert_eq!(r.applied, 1);
    assert_eq!(store::project(&c.conn, &p.id).unwrap().name, "Alfa");
}

// --- Rights lost later and the project's first change -------------------

/// Ani (founder, superadmin, member of team Desain) and team Lain, with a
/// real signed membership log.
struct Office {
    ani: Laptop,
    desain: String,
    lain: String,
}

fn office() -> Office {
    let mut ani = Laptop::founder("Ani");
    let desain = org_ops::create_team(&mut ani.conn, &ani.id, "Desain");
    let lain = org_ops::create_team(&mut ani.conn, &ani.id, "Lain");
    let me = ani.pk();
    p::add_team_member(&mut ani.conn, &ani.id, &desain, &me, org_ops::now()).unwrap();
    Office { ani, desain, lain }
}

impl Office {
    /// A new laptop that joins through an invite to `team`.
    fn hire(&mut self, name: &str, team: &str) -> Laptop {
        let mut l = Laptop::bare(name);
        org_ops::join(
            (&mut self.ani.conn, &self.ani.id),
            (&mut l.conn, &l.id),
            team,
            InviteRole::Member,
            vec![],
        );
        l
    }

    /// Sends `l` the membership ops it is missing.
    fn tell(&self, l: &mut Laptop) {
        let to = l.pk();
        org_ops::sync(&self.ani.conn, &mut l.conn, &to, &self.ani.pk());
    }

    fn out_of_team(&mut self, team: &str, who: &Laptop) {
        p::remove_team_member(&mut self.ani.conn, &self.ani.id, team, &who.pk(), org_ops::now())
            .unwrap();
    }

    fn team_admin(&mut self, team: &str, who: &Laptop, admin: bool) {
        p::set_team_admin(&mut self.ani.conn, &self.ani.id, team, &who.pk(), admin, org_ops::now())
            .unwrap();
    }

    /// Ani registers her project of `root` (`project_create` with `members`).
    fn register_ani(&mut self, root: &(SignedChange, String), team: Option<&str>, members: &[String]) {
        p::register_own_project_in(
            &self.ani.conn,
            &self.ani.id,
            &root.0.project_id,
            team,
            &root.1,
            members,
            None,
            org_ops::now(),
        )
        .unwrap();
    }

    /// Another `creator` registers the project of `root` on its own laptop;
    /// the op reaches Ani's laptop.
    fn register_by(&mut self, creator: &Laptop, root: &(SignedChange, String), team: Option<&str>, members: &[String]) {
        p::register_own_project_in(
            &creator.conn,
            &creator.id,
            &root.0.project_id,
            team,
            &root.1,
            members,
            None,
            org_ops::now(),
        )
        .unwrap();
        let (to, from) = (self.ani.pk(), creator.pk());
        org_ops::sync(&creator.conn, &mut self.ani.conn, &to, &from);
    }

    fn out_of_project(&mut self, project: &str, who: &Laptop) {
        p::remove_project_member(&mut self.ani.conn, &self.ani.id, project, &who.pk(), org_ops::now())
            .unwrap();
    }

    fn in_project(&mut self, project: &str, who: &Laptop) {
        p::add_project_member(&mut self.ani.conn, &self.ani.id, project, &who.pk(), org_ops::now())
            .unwrap();
    }
}

/// Unix seconds, `offset` from now.
fn unix(offset: i64) -> i64 {
    clock::now().unix_timestamp() + offset
}

/// The first change of a new project by `l`, dated `at`.
fn root_at(l: &Laptop, name: &str, code: &str, team: Option<&str>, at: i64) -> SignedChange {
    root_with_nonce(l, name, code, team, at).0
}

/// `root_at` plus the project nonce, to register the project in the log.
fn root_with_nonce(
    l: &Laptop,
    name: &str,
    code: &str,
    team: Option<&str>,
    at: i64,
) -> (SignedChange, String) {
    let nonce = crate::board::doc::random_id();
    let id = store::derive_project_id(&l.pk(), team, &nonce);
    let meta = ProjectMeta {
        id: id.clone(),
        code: code.into(),
        name: name.into(),
        team_id: team.map(str::to_owned),
    };
    let mut doc = BoardDoc::create(&actor_of(&l.id), &meta).unwrap();
    doc.set_project_nonce(&nonce).unwrap();
    doc.commit(at).unwrap();
    (sign_change(&l.id, &id, &doc.changes_after(&[])[0]), nonce)
}

/// The document made of `changes`, with `who`'s actor.
fn doc_of(who: &Identity, changes: &[&SignedChange]) -> BoardDoc {
    let mut d = BoardDoc::empty(&actor_of(who));
    for sc in changes {
        d.apply(parse_change(sc).unwrap()).unwrap();
    }
    d
}

/// One signed change by `who` on `doc`, dated `at` (the author's clock).
fn write_at(
    who: &Identity,
    project: &str,
    doc: &mut BoardDoc,
    at: i64,
    edit: impl FnOnce(&mut BoardDoc, Stamp<'_>),
) -> SignedChange {
    let me = who.public_key_hex().to_owned();
    let before = doc.heads();
    edit(
        doc,
        Stamp {
            actor: &me,
            at: "2026-11-22T08:00:00Z",
        },
    );
    doc.commit(at).unwrap();
    let changes = doc.changes_after(&before);
    assert_eq!(changes.len(), 1);
    sign_change(who, project, &changes[0])
}

fn is_held(r: &ApplyReport, sc: &SignedChange) -> bool {
    matches!(
        r.outcome(&sc.hash),
        Some(ChangeOutcome::Held {
            code: "board_forbidden",
            ..
        })
    )
}

#[test]
fn history_of_a_member_who_left_the_project_is_accepted_once_a_colleague_built_on_it() {
    let mut o = office();
    let (desain, lain) = (o.desain.clone(), o.lain.clone());
    let budi = o.hire("Budi", &desain);
    let mut sari = o.hire("Sari", &lain);
    let rooted = root_with_nonce(&o.ani, "Situs Web", "WEB", Some(&desain), unix(-600));
    o.register_ani(&rooted, Some(&desain), &[budi.pk()]);
    let root = rooted.0.clone();
    let pid = root.project_id.clone();

    // Monday: Budi writes in the project.
    let mut bd = doc_of(&budi.id, &[&root]);
    let logo = write_at(&budi.id, &pid, &mut bd, unix(-300), |d, s| {
        d.create_task(s, new_task("Logo")).unwrap();
    });
    // Tuesday: Budi leaves the project. Wednesday: Sari, from another
    // department, joins it.
    o.out_of_project(&pid, &budi);
    o.in_project(&pid, &sari);
    o.tell(&mut sari);

    // Nobody who still writes there has built on Budi's change yet: held,
    // not refused, and the project itself is imported.
    let r = import_project(
        &mut sari.conn,
        &LocalRolePolicy,
        &pid,
        None,
        vec![root.clone(), logo.clone()],
    )
    .unwrap();
    assert_eq!(r.outcome(&root.hash), Some(&ChangeOutcome::Applied), "{r:?}");
    assert!(is_held(&r, &logo), "{r:?}");
    assert!(tasks(&sari, &pid).is_empty());

    // Ani (still in Desain) comments on Budi's task: both are accepted.
    let mut ad = doc_of(&o.ani.id, &[&root, &logo]);
    let task = ad.tasks().unwrap()[0].id.clone();
    let comment = write_at(&o.ani.id, &pid, &mut ad, unix(0), |d, s| {
        d.add_comment(s, &task, "Bagus").unwrap();
    });
    let r = apply_remote_changes(
        &mut sari.conn,
        &LocalRolePolicy,
        &pid,
        None,
        vec![logo, comment],
    )
    .unwrap();
    assert_eq!((r.applied, r.held, r.rejected), (2, 0, 0), "{r:?}");
    let t = &tasks(&sari, &pid)[0];
    assert_eq!(t.title, "Logo");
    assert_eq!(t.created_by, budi.pk());
    assert_eq!(t.comments.len(), 1);
    assert!(rejected(&sari.conn).is_empty());
}

#[test]
fn a_backdated_change_without_a_colleague_stays_held() {
    let mut o = office();
    let desain = o.desain.clone();
    let budi = o.hire("Budi", &desain);
    let rooted = root_with_nonce(&o.ani, "Situs Web", "WEB", Some(&desain), unix(-600));
    o.register_ani(&rooted, Some(&desain), &[budi.pk()]);
    let root = rooted.0.clone();
    let pid = root.project_id.clone();
    let r = import_project(&mut o.ani.conn, &LocalRolePolicy, &pid, None, vec![root.clone()])
        .unwrap();
    assert_eq!(r.applied, 1);

    // Budi leaves the project, then writes and dates the change before
    // that. Building on it himself does not count as support.
    o.out_of_project(&pid, &budi);
    let mut bd = doc_of(&budi.id, &[&root]);
    let back = write_at(&budi.id, &pid, &mut bd, unix(-300), |d, s| {
        d.create_task(s, new_task("Mundur")).unwrap();
    });
    let task = bd.tasks().unwrap()[0].id.clone();
    let own = write_at(&budi.id, &pid, &mut bd, unix(-290), |d, s| {
        d.add_comment(s, &task, "Sendiri").unwrap();
    });
    let r = apply_remote_changes(
        &mut o.ani.conn,
        &LocalRolePolicy,
        &pid,
        None,
        vec![back.clone(), own.clone()],
    )
    .unwrap();
    assert_eq!((r.applied, r.held, r.rejected), (0, 2, 0), "{r:?}");
    assert!(is_held(&r, &back) && is_held(&r, &own));
    assert!(tasks(&o.ani, &pid).is_empty());
}

#[test]
fn a_delete_by_a_demoted_admin_needs_a_colleague_too() {
    let mut o = office();
    let desain = o.desain.clone();
    let dewi = o.hire("Dewi", &desain);
    o.team_admin(&desain, &dewi, true);
    let mut sari = o.hire("Sari", &desain);
    let rooted = root_with_nonce(&o.ani, "Situs Web", "WEB", Some(&desain), unix(-600));
    o.register_ani(&rooted, Some(&desain), &[dewi.pk(), sari.pk()]);
    let root = rooted.0.clone();
    let pid = root.project_id.clone();
    let mut ad = doc_of(&o.ani.id, &[&root]);
    let poster = write_at(&o.ani.id, &pid, &mut ad, unix(-500), |d, s| {
        d.create_task(s, new_task("Poster")).unwrap();
    });
    let task = ad.tasks().unwrap()[0].id.clone();

    // Dewi stops being department admin (she still writes in the project), deletes
    // Ani's task dated before that, and builds on it herself.
    o.team_admin(&desain, &dewi, false);
    o.tell(&mut sari);
    let mut dd = doc_of(&dewi.id, &[&root, &poster]);
    let delete = write_at(&dewi.id, &pid, &mut dd, unix(-300), |d, s| {
        d.delete_task(s, &task).unwrap();
    });
    let own = write_at(&dewi.id, &pid, &mut dd, unix(-290), |d, s| {
        d.create_task(s, new_task("Sendiri")).unwrap();
    });
    let r = import_project(
        &mut sari.conn,
        &LocalRolePolicy,
        &pid,
        None,
        vec![root.clone(), poster.clone(), delete.clone(), own.clone()],
    )
    .unwrap();
    assert_eq!(r.applied, 2, "{r:?}");
    assert!(is_held(&r, &delete), "{r:?}");
    assert_eq!(r.outcome(&own.hash), Some(&ChangeOutcome::MissingDeps));
    assert!(!tasks(&sari, &pid)[0].deleted);

    // Ani builds on Dewi's work: the delete is supported through the chain.
    let mut ad = doc_of(&o.ani.id, &[&root, &poster, &delete, &own]);
    let next = write_at(&o.ani.id, &pid, &mut ad, unix(0), |d, s| {
        d.create_task(s, new_task("Baru")).unwrap();
    });
    let r = apply_remote_changes(
        &mut sari.conn,
        &LocalRolePolicy,
        &pid,
        None,
        vec![delete, own, next],
    )
    .unwrap();
    assert_eq!((r.applied, r.held), (3, 0), "{r:?}");
    let all = tasks(&sari, &pid);
    assert!(all.iter().find(|t| t.id == task).unwrap().deleted);
}

#[test]
fn a_project_by_an_admin_who_left_the_team_imports_once_a_colleague_built_on_it() {
    let mut o = office();
    let desain = o.desain.clone();
    let dewi = o.hire("Dewi", &desain);
    o.team_admin(&desain, &dewi, true);
    let mut sari = o.hire("Sari", &desain);
    let rooted = root_with_nonce(&dewi, "Pameran", "PM", Some(&desain), unix(-600));
    let members = [o.ani.pk(), sari.pk()];
    o.register_by(&dewi, &rooted, Some(&desain), &members);
    let root = rooted.0.clone();
    let pid = root.project_id.clone();
    o.out_of_team(&desain, &dewi);
    o.tell(&mut sari);

    let r = import_project(&mut sari.conn, &LocalRolePolicy, &pid, None, vec![root.clone()])
        .unwrap();
    assert!(is_held(&r, &root), "{r:?}");
    assert!(store::project(&sari.conn, &pid).is_err());

    let mut ad = doc_of(&o.ani.id, &[&root]);
    let booth = write_at(&o.ani.id, &pid, &mut ad, unix(0), |d, s| {
        d.create_task(s, new_task("Booth")).unwrap();
    });
    let r = import_project(
        &mut sari.conn,
        &LocalRolePolicy,
        &pid,
        None,
        vec![root, booth],
    )
    .unwrap();
    assert_eq!((r.applied, r.held), (2, 0), "{r:?}");
    let row = store::project(&sari.conn, &pid).unwrap();
    assert_eq!(row.created_by, dewi.pk());
    assert_eq!(row.name, "Pameran");
}

/// A change without dependencies by `l` that sets up a project document
/// with `doc_id` as its id, signed for `project`, whose hash sorts after
/// `after` (so `import_project` never tries it as the first change).
fn second_root(l: &Laptop, project: &str, doc_id: &str, after: &str) -> SignedChange {
    // Keys are random, so `after` can be close to ffff... and a match rare
    // (about 1 in 100 tries for an fd.. hash). Search far enough that the
    // test never fails by chance.
    for i in 0..1_000_000 {
        let meta = ProjectMeta {
            id: doc_id.into(),
            code: "PX".into(),
            name: format!("Palsu {i}"),
            team_id: None,
        };
        let mut doc = BoardDoc::create(&actor_of(&l.id), &meta).unwrap();
        doc.commit(unix(0)).unwrap();
        let sc = sign_change(&l.id, project, &doc.changes_after(&[])[0]);
        if sc.hash.as_str() > after {
            return sc;
        }
    }
    panic!("no hash after {after}");
}

#[test]
fn only_the_chosen_first_change_skips_the_rules() {
    for same_id in [true, false] {
        let (a, b) = pair();
        let mut c = Laptop::joined(&a, "Citra");
        add_member(&c.conn, &b.pk(), "Budi", "member");
        let root = root_at(&a, "Alfa", "PA", None, unix(-60));
        let pid = root.project_id.clone();
        register_project(&c.conn, &pid, None, &a.pk(), &[&a.pk(), &b.pk(), &c.pk()]);
        let id = if same_id { pid.as_str() } else { "" };
        let fake = second_root(&b, &pid, id, &root.hash);
        let mut ad = doc_of(&a.id, &[&root]);
        let child = write_at(&a.id, &pid, &mut ad, unix(0), |d, s| {
            d.create_task(s, new_task("Satu")).unwrap();
        });
        // The forged change comes first in the batch.
        let r = import_project(
            &mut c.conn,
            &LocalRolePolicy,
            &pid,
            None,
            vec![fake.clone(), root.clone(), child.clone()],
        )
        .unwrap();
        let refused = Some(&ChangeOutcome::Rejected {
            code: "board_not_allowed",
        });
        assert_eq!(r.outcome(&fake.hash), refused, "{same_id}: {r:?}");
        assert_eq!(r.outcome(&root.hash), Some(&ChangeOutcome::Applied), "{same_id}");
        assert_eq!(r.outcome(&child.hash), Some(&ChangeOutcome::Applied), "{same_id}");
        assert_eq!(store::project(&c.conn, &pid).unwrap().name, "Alfa");
        let doc = store::load_doc(&c.conn, &pid, &actor_of(&c.id)).unwrap();
        assert_eq!(doc.project().id, pid);
        assert_eq!(doc.project().name, "Alfa");
        assert_eq!(tasks(&c, &pid).len(), 1);

        // Sent later to the existing project: refused all the same.
        let again = second_root(&b, &pid, id, &fake.hash);
        let r = apply_remote_changes(&mut c.conn, &LocalRolePolicy, &pid, None, vec![again.clone()])
            .unwrap();
        assert_eq!(r.outcome(&again.hash), refused, "{same_id}");
        let doc = store::load_doc(&c.conn, &pid, &actor_of(&c.id)).unwrap();
        assert_eq!(doc.project().name, "Alfa");
    }
}

#[test]
fn a_first_change_for_another_project_id_is_refused_after_applying() {
    let mut l = Laptop::founder("Sari");
    let pid = "ab".repeat(16);
    // Signed for `pid`, but the document names another id.
    let meta = ProjectMeta {
        id: "cd".repeat(16),
        code: "PA".into(),
        name: "Alfa".into(),
        team_id: None,
    };
    let mut d = BoardDoc::create(&actor_of(&l.id), &meta).unwrap();
    d.commit(unix(0)).unwrap();
    let root = sign_change(&l.id, &pid, &d.changes_after(&[])[0]);
    let row = ProjectRow {
        id: pid.clone(),
        code: "PA".into(),
        name: "Alfa".into(),
        team_id: None,
        created_by: l.pk(),
        created_at: "t".into(),
        updated_at: "t".into(),
    };
    let tx = l.conn.transaction().unwrap();
    tx.execute(
        "INSERT INTO board_projects (id, code, doc_code, name, team_id, created_by, created_at, doc, updated_at)
         VALUES (?1, 'PA', 'PA', 'Alfa', NULL, ?2, 't', x'', 't')",
        params![pid, row.created_by],
    )
    .unwrap();
    register_project(&tx, &pid, None, &row.created_by, &[&row.created_by]);
    let mut doc = BoardDoc::empty(&MERGE_ACTOR);
    let mut report = ApplyReport::default();
    ingest(
        &tx,
        &LocalRolePolicy,
        &row,
        &mut doc,
        None,
        vec![root.clone()],
        Some(&root.hash),
        clock::now(),
        &mut report,
    )
    .unwrap();
    assert_eq!(
        report.outcome(&root.hash),
        Some(&ChangeOutcome::Rejected {
            code: "board_invalid_doc"
        })
    );
    assert_eq!(report.applied, 0);
    assert!(doc.heads().is_empty(), "document restored");
    assert!(doc.project().id.is_empty());
    let detail: String = tx
        .query_row("SELECT detail FROM rejected_changes", [], |r| r.get(0))
        .unwrap();
    assert!(detail.contains("id proyek"), "{detail}");
}

#[test]
fn an_oversized_first_change_is_refused_before_the_probe() {
    use automerge::transaction::Transactable;
    use automerge::{ObjType, ROOT};

    let (a, mut b) = pair();
    let nonce = crate::board::doc::random_id();
    let id = store::derive_project_id(&a.pk(), None, &nonce);
    let meta = ProjectMeta {
        id: id.clone(),
        code: "PA".into(),
        name: "Alfa".into(),
        team_id: None,
    };
    let mut doc = BoardDoc::create(&actor_of(&a.id), &meta).unwrap();
    doc.set_project_nonce(&nonce).unwrap();
    let text = doc.raw().put_object(ROOT, "catatan", ObjType::Text).unwrap();
    doc.raw()
        .splice_text(&text, 0, 0, &"x".repeat(rules::MAX_CHANGE_OPS + 1))
        .unwrap();
    doc.commit(unix(0)).unwrap();
    let change = doc.changes_after(&[]).remove(0);
    assert!(change.len() > rules::MAX_CHANGE_OPS);
    let root = sign_change(&a.id, &id, &change);
    verify_envelope(&root).expect("within the byte limit, only the operation count is over");

    let r = import_project(&mut b.conn, &LocalRolePolicy, &id, None, vec![root.clone()]).unwrap();
    assert_eq!(
        r.outcome(&root.hash),
        Some(&ChangeOutcome::Rejected {
            code: "board_bad_project"
        })
    );
    assert!(store::project(&b.conn, &id).is_err());
    assert_eq!(rejected(&b.conn), ["board_bad_project"]);
}

#[test]
fn a_broken_task_from_an_older_version_does_not_freeze_the_board() {
    let (mut a, mut b) = pair();
    let p = create_project(&mut a.conn, &a.id, "Alfa", "PA", None)
        .unwrap()
        .value;
    let other = mutate(&mut a, &p.id, |d, s| d.create_task(s, new_task("lain")));
    send(&a, &mut b, &p.id);

    // B holds a task with `subtasks: "x"`, as v0.3 accepted from a peer.
    use automerge::ROOT;
    use automerge::ReadDoc;
    use automerge::transaction::Transactable;
    mutate(&mut b, &p.id, |d, s| {
        let id = d.create_task(s, new_task("lama"))?;
        let tasks = d.raw().get(ROOT, "tasks").unwrap().unwrap().1;
        let t = d.raw().get(&tasks, id.as_str()).unwrap().unwrap().1;
        d.raw().put(&t, "subtasks", "x").unwrap();
        Ok(id)
    });

    // Changes from A to other tasks still go through on B.
    mutate(&mut a, &p.id, |d, s| d.add_subtask(s, &other, "baru", None));
    mutate(&mut a, &p.id, |d, s| d.create_task(s, new_task("baru")));
    let r = send(&a, &mut b, &p.id);
    assert_eq!((r.applied, r.rejected), (2, 0));
    let on_b = tasks(&b, &p.id);
    assert_eq!(on_b.len(), 3);
    let lain = on_b.iter().find(|t| t.id == other).unwrap();
    assert_eq!(lain.subtasks.len(), 1);
    assert!(on_b.iter().find(|t| t.title == "lama").unwrap().subtasks.is_empty());
    view_json(&b, &p.id);
}

// --- Division projects (v0.6) ---------------------------------------------

/// Every laptop reports this Mira, so the division gate is open.
fn report_versions(o: &mut Office, laptops: &mut [&mut Laptop]) {
    let profile = p::DeviceProfile {
        laptop: "LAPTOP-01".into(),
        os: "Windows 11".into(),
        app_version: crate::device::APP_VERSION.into(),
    };
    p::ensure_device_op(&mut o.ani.conn, &o.ani.id, &profile, org_ops::now()).unwrap();
    for l in laptops.iter_mut() {
        o.tell(l);
        p::ensure_device_op(&mut l.conn, &l.id, &profile, org_ops::now()).unwrap();
        let (to, from) = (o.ani.pk(), l.pk());
        org_ops::sync(&l.conn, &mut o.ani.conn, &to, &from);
    }
    for l in laptops.iter_mut() {
        o.tell(l);
    }
}

fn create_for(team: &str, division: Option<&str>) -> BoardAction {
    BoardAction::CreateProject {
        team_id: Some(team.to_owned()),
        division_id: division.map(str::to_owned),
    }
}

#[test]
fn a_division_head_creates_a_division_project_that_members_accept() {
    let mut o = office();
    let desain = o.desain.clone();
    let mut budi = o.hire("Budi", &desain);
    let mut citra = o.hire("Citra", &desain);
    report_versions(&mut o, &mut [&mut budi, &mut citra]);
    let now = org_ops::now();
    let mobile = p::create_division(&mut o.ani.conn, &o.ani.id, &desain, "Mobile", now).unwrap();
    p::set_division_head(&mut o.ani.conn, &o.ani.id, &mobile, &budi.pk(), true, now).unwrap();
    p::add_division_member(&mut o.ani.conn, &o.ani.id, &mobile, &citra.pk(), now).unwrap();
    o.tell(&mut budi);
    o.tell(&mut citra);

    // Budi heads Mobile without being a department admin: a project for
    // Mobile only. Citra, a plain member, may not.
    let policy = LocalRolePolicy;
    assert!(policy.check(&budi.conn, &budi.pk(), &create_for(&desain, Some(&mobile))).is_ok());
    assert!(policy.check(&budi.conn, &budi.pk(), &create_for(&desain, None)).is_err());
    assert!(policy.check(&citra.conn, &citra.pk(), &create_for(&desain, Some(&mobile))).is_err());
    assert!(policy.check(&budi.conn, &budi.pk(), &create_for(&o.lain, Some(&mobile))).is_err());
    let err = store::create_division_project(
        &mut citra.conn,
        &citra.id,
        "Coba",
        "COBA",
        &desain,
        &[],
        &mobile,
    )
    .map(|_| ())
    .unwrap_err();
    assert_eq!(err.code(), "forbidden", "the fold refuses plain members too");

    let made = store::create_division_project(
        &mut budi.conn,
        &budi.id,
        "Aplikasi",
        "APP",
        &desain,
        &[citra.pk()],
        &mobile,
    )
    .unwrap();
    let pid = made.value.id.clone();
    let dir = LocalMembers::new(&budi.id);
    let summary = Ctx {
        conn: &budi.conn,
        me: budi.id.public_key_hex(),
        policy: &LocalRolePolicy,
        dir: &dir,
    }
    .summary(&made.value)
    .unwrap();
    assert_eq!(summary.division_id.as_deref(), Some(mobile.as_str()));
    assert_eq!(summary.division_name.as_deref(), Some("Mobile"));
    let json = serde_json::to_value(&summary).unwrap();
    assert_eq!(json["divisionId"], mobile.as_str());

    // Citra's laptop learns the project from the log, then accepts the
    // board made by the head.
    let (to, from) = (citra.pk(), budi.pk());
    org_ops::sync(&budi.conn, &mut citra.conn, &to, &from);
    let r = send(&budi, &mut citra, &pid);
    assert_eq!((r.applied, r.held, r.rejected), (1, 0, 0), "{r:?}");
    assert_eq!(store::project(&citra.conn, &pid).unwrap().name, "Aplikasi");
}
