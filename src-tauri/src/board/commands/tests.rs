use std::sync::Mutex;

use super::*;
use crate::identity::MemoryKeyStore;

/// Records what the commands hand to the sync hook.
#[derive(Default)]
struct Recorder(Mutex<Vec<(String, String)>>);

impl BoardSyncHook for Recorder {
    fn on_local_change(&self, project_id: &str, change: &SignedChange) {
        self.0
            .lock()
            .unwrap()
            .push((project_id.to_owned(), change.hash.clone()));
    }
}

impl Recorder {
    fn count(&self) -> usize {
        self.0.lock().unwrap().len()
    }
}

fn app() -> (tempfile::TempDir, MiraState) {
    let tmp = tempfile::tempdir().unwrap();
    let state = MiraState::new(
        Ok(tmp.path().to_path_buf()),
        Box::new(MemoryKeyStore::new()),
    );
    crate::commands::display_name(&state, "Sari").unwrap();
    (tmp, state)
}

fn me(state: &MiraState) -> String {
    state
        .with_core(|c| Ok(c.identity.public_key_hex().to_owned()))
        .unwrap()
}

#[test]
fn needs_an_organization() {
    let (_t, state) = app();
    let err = create_project(&state, &NoopSync, "Alfa", "PA", None).unwrap_err();
    assert_eq!(err.code(), "forbidden");
    assert!(list_projects(&state).unwrap().is_empty());
    assert!(my_tasks(&state).unwrap().is_empty());
}

#[test]
fn board_flow_and_json_shape() {
    let (_t, state) = app();
    crate::commands::organization(&state, "CV Maju Jaya").unwrap();
    let hook = Recorder::default();
    let me = me(&state);

    let project = create_project(&state, &hook, "Situs Web", "web", None).unwrap();
    assert_eq!(project.code, "WEB");
    assert_eq!(hook.count(), 1);
    let json = serde_json::to_value(&project).unwrap();
    assert_eq!(json["teamId"], serde_json::Value::Null);
    assert_eq!(json["openCount"], 0);
    assert_eq!(json["taskCount"], 0);
    assert_eq!(json["canManage"], true);
    assert_eq!(
        create_project(&state, &hook, "Lain", "WEB", None)
            .unwrap_err()
            .code(),
        "invalid_input"
    );

    let input: NewTask =
        serde_json::from_value(serde_json::json!({ "title": "  Halaman depan " })).unwrap();
    let t1 = create_task(&state, &hook, &project.id, input).unwrap();
    assert_eq!(hook.count(), 2);
    let json = serde_json::to_value(&t1).unwrap();
    assert_eq!(json["code"], "WEB-1");
    assert_eq!(json["title"], "Halaman depan");
    assert_eq!(json["columnId"], "todo");
    assert_eq!(json["due"], serde_json::Value::Null);
    assert_eq!(json["assignee"], serde_json::Value::Null);
    assert_eq!(json["priority"], "none");
    assert_eq!(json["labels"], serde_json::json!([]));
    assert_eq!(json["commentCount"], 0);
    assert_eq!(json["merged"], false);
    assert_eq!(json["projectId"], project.id);
    assert_eq!(json["description"], "");
    assert_eq!(json["createdBy"]["publicKey"], me);
    assert_eq!(json["createdBy"]["name"], "Sari");
    assert!(json["createdAt"].is_string() && json["updatedAt"].is_string());
    assert_eq!(json["activity"][0]["kind"], "created");
    assert_eq!(json["activity"][0]["actor"]["name"], "Sari");
    assert_eq!(json["activity"][0]["detail"], "To do");
    assert_eq!(json["canEdit"], true);
    assert_eq!(json["canDelete"], true);
    let keys: Vec<&String> = json.as_object().unwrap().keys().collect();
    for k in ["id", "comments", "activity", "commentCount"] {
        assert!(keys.iter().any(|x| *x == k), "{k}");
    }

    let input: NewTask = serde_json::from_value(serde_json::json!({
        "title": "Foto tim", "columnId": "doing", "assignee": me, "due": "2026-12-01",
        "priority": "high", "labels": ["Desain", "desain", "Web"], "description": "Semua orang"
    }))
    .unwrap();
    let t2 = create_task(&state, &hook, &project.id, input).unwrap();
    assert_eq!(t2.card.code, "WEB-2");
    assert_eq!(t2.card.labels, ["Desain", "Web"]);
    assert_eq!(t2.card.assignee.as_ref().unwrap().name, "Sari");

    // Validation.
    for bad in [
        serde_json::json!({ "title": "" }),
        serde_json::json!({ "title": "x", "due": "2026-02-30" }),
        serde_json::json!({ "title": "x", "assignee": "ab".repeat(32) }),
        serde_json::json!({ "title": "x", "labels": ["a\nb"] }),
    ] {
        let input: NewTask = serde_json::from_value(bad.clone()).unwrap();
        assert_eq!(
            create_task(&state, &hook, &project.id, input)
                .unwrap_err()
                .code(),
            "invalid_input",
            "{bad}"
        );
    }
    assert_eq!(hook.count(), 3, "failed calls do not reach the hook");

    // Update: absent fields untouched, null clears.
    let patch: TaskPatch =
        serde_json::from_value(serde_json::json!({ "assignee": null, "title": "Foto tim kantor" }))
            .unwrap();
    let t2 = update_task(&state, &hook, &project.id, &t2.card.id, patch).unwrap();
    assert_eq!(t2.card.assignee, None);
    assert_eq!(t2.card.title, "Foto tim kantor");
    assert_eq!(t2.card.due.as_deref(), Some("2026-12-01"));
    assert_eq!(t2.card.priority, model::Priority::High);
    let patch: TaskPatch = serde_json::from_value(serde_json::json!({ "due": null })).unwrap();
    let t2 = update_task(&state, &hook, &project.id, &t2.card.id, patch).unwrap();
    assert_eq!(t2.card.due, None);
    let n = hook.count();
    let same: TaskPatch =
        serde_json::from_value(serde_json::json!({ "title": "Foto tim kantor" })).unwrap();
    update_task(&state, &hook, &project.id, &t2.card.id, same).unwrap();
    assert_eq!(hook.count(), n, "no change, nothing signed");

    // Move and board shape.
    let view = move_task(&state, &hook, &project.id, &t1.card.id, ColumnId::Doing, 0).unwrap();
    let json = serde_json::to_value(&view).unwrap();
    assert_eq!(json["me"], me);
    assert_eq!(json["canCreate"], true);
    assert_eq!(json["columns"][0]["id"], "todo");
    assert_eq!(json["columns"][1]["name"], "Dikerjakan");
    assert_eq!(json["columns"][2]["name"], "Selesai");
    let doing: Vec<&str> = view.columns[1]
        .tasks
        .iter()
        .map(|t| t.code.as_str())
        .collect();
    assert_eq!(doing, ["WEB-1", "WEB-2"]);
    assert_eq!(json["assignees"][0]["publicKey"], me);
    assert_eq!(json["project"]["openCount"], 2);

    let detail = add_comment(&state, &hook, &project.id, &t1.card.id, " Sudah mulai ").unwrap();
    assert_eq!(detail.comments.len(), 1);
    assert_eq!(detail.comments[0].body, "Sudah mulai");
    assert_eq!(detail.card.comment_count, 1);
    assert_eq!(
        add_comment(&state, &hook, &project.id, &t1.card.id, "  ")
            .unwrap_err()
            .code(),
        "invalid_input"
    );

    // My tasks: assigned to me and not deleted.
    let patch: TaskPatch =
        serde_json::from_value(serde_json::json!({ "assignee": me, "due": "2026-11-30" })).unwrap();
    update_task(&state, &hook, &project.id, &t1.card.id, patch).unwrap();
    let mine = my_tasks(&state).unwrap();
    assert_eq!(mine.len(), 1);
    let json = serde_json::to_value(&mine[0]).unwrap();
    assert_eq!(json["projectCode"], "WEB");
    assert_eq!(json["projectName"], "Situs Web");
    assert_eq!(json["projectId"], project.id);
    assert_eq!(json["task"]["code"], "WEB-1");

    delete_task(&state, &hook, &project.id, &t1.card.id).unwrap();
    assert_eq!(
        get_task(&state, &project.id, &t1.card.id)
            .unwrap_err()
            .code(),
        "not_found"
    );
    assert!(my_tasks(&state).unwrap().is_empty());
    let board = get_board(&state, &project.id).unwrap();
    assert_eq!(board.project.task_count, 1);
    assert_eq!(list_projects(&state).unwrap()[0].task_count, 1);

    assert_eq!(
        get_board(&state, &"f".repeat(32)).unwrap_err().code(),
        "not_found"
    );
    assert_eq!(
        get_task(&state, &project.id, "nope").unwrap_err().code(),
        "not_found"
    );

    // Every change the hook saw is stored and verifies.
    let stored = state
        .with_core(|c| store::stored_changes(&c.db, &project.id))
        .unwrap();
    assert_eq!(stored.len(), hook.count());
    for sc in &stored {
        crate::board::sign::verify_change(sc).unwrap();
    }
}

#[test]
fn rename_project_keeps_the_code_and_needs_the_right() {
    let (_t, state) = app();
    crate::commands::organization(&state, "CV Maju Jaya").unwrap();
    let hook = Recorder::default();
    let project = create_project(&state, &hook, "Situs Web", "WEB", None).unwrap();
    let input: NewTask = serde_json::from_value(serde_json::json!({ "title": "x" })).unwrap();
    create_task(&state, &hook, &project.id, input).unwrap();
    assert_eq!(hook.count(), 2);

    let renamed = update_project(&state, &hook, &project.id, "  Situs Kantor ").unwrap();
    assert_eq!(renamed.name, "Situs Kantor");
    assert_eq!(renamed.code, "WEB");
    assert_eq!(renamed.task_count, 1);
    assert!(renamed.can_manage);
    assert_eq!(hook.count(), 3);
    assert_eq!(list_projects(&state).unwrap()[0].name, "Situs Kantor");
    assert_eq!(
        get_board(&state, &project.id).unwrap().project.name,
        "Situs Kantor"
    );
    let doc_name = state
        .with_core(|c| {
            let doc = store::load_doc(&c.db, &project.id, &store::actor_of(&c.identity))?;
            Ok(doc.project().name)
        })
        .unwrap();
    assert_eq!(doc_name, "Situs Kantor");
    let stored = state
        .with_core(|c| store::stored_changes(&c.db, &project.id))
        .unwrap();
    assert_eq!(stored.len(), 3);
    crate::board::sign::verify_change(&stored[2]).unwrap();

    // Same name: nothing signed. Bad name: refused.
    update_project(&state, &hook, &project.id, "Situs Kantor").unwrap();
    assert_eq!(hook.count(), 3);
    for bad in ["", "x", "a\nb"] {
        assert_eq!(
            update_project(&state, &hook, &project.id, bad)
                .unwrap_err()
                .code(),
            "invalid_input",
            "{bad:?}"
        );
    }
    assert_eq!(
        update_project(&state, &hook, &"f".repeat(32), "Nama")
            .unwrap_err()
            .code(),
        "not_found"
    );

    // A plain member who did not create the project may not rename it.
    state
        .with_core(|c| {
            c.db.execute("UPDATE members SET role = 'member', is_superadmin = 0", [])?;
            c.db.execute(
                "UPDATE board_projects SET created_by = ?1",
                [&"ab".repeat(32)],
            )?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        update_project(&state, &hook, &project.id, "Nama Lain")
            .unwrap_err()
            .code(),
        "forbidden"
    );
    assert_eq!(hook.count(), 3);
}

#[test]
fn removed_laptop_cannot_change_or_read() {
    let (_t, state) = app();
    crate::commands::organization(&state, "CV Maju Jaya").unwrap();
    let project = create_project(&state, &NoopSync, "Alfa", "PA", None).unwrap();
    let input: NewTask = serde_json::from_value(serde_json::json!({ "title": "x" })).unwrap();
    let t = create_task(&state, &NoopSync, &project.id, input).unwrap();
    state
        .with_core(|c| {
            c.db.execute("UPDATE members SET status = 'removed'", [])?;
            Ok(())
        })
        .unwrap();
    let input: NewTask = serde_json::from_value(serde_json::json!({ "title": "y" })).unwrap();
    assert_eq!(
        create_task(&state, &NoopSync, &project.id, input)
            .unwrap_err()
            .code(),
        "removed"
    );
    assert_eq!(
        delete_task(&state, &NoopSync, &project.id, &t.card.id)
            .unwrap_err()
            .code(),
        "removed"
    );
    // A removed laptop stops seeing the project (the app shows the removed
    // screen instead); the local copy is kept, nothing is deleted.
    assert_eq!(
        get_board(&state, &project.id).unwrap_err().code(),
        "removed"
    );
    assert_eq!(
        get_task(&state, &project.id, &t.card.id)
            .unwrap_err()
            .code(),
        "removed"
    );
    assert!(list_projects(&state).unwrap().is_empty());
}

#[test]
fn initial_members_must_be_active_members() {
    let (_t, state) = app();
    crate::commands::organization(&state, "CV Maju Jaya").unwrap();
    let me = me(&state);
    let stranger = "ab".repeat(32);
    let err = create_project_with_members(
        &state,
        &NoopSync,
        "Gudang",
        "GD",
        None,
        std::slice::from_ref(&stranger),
    )
    .unwrap_err();
    assert_eq!(err.code(), "invalid_input");
    assert!(list_projects(&state).unwrap().is_empty(), "nothing created");

    let many: Vec<String> = (0..200).map(|i| format!("{i:064x}")).collect();
    let err =
        create_project_with_members(&state, &NoopSync, "Gudang", "GD", None, &many).unwrap_err();
    assert_eq!(err.code(), "invalid_input");

    // The creator in the list is fine (always a member anyway).
    let p = create_project_with_members(
        &state,
        &NoopSync,
        "Gudang",
        "GD",
        None,
        &[me.to_uppercase()],
    )
    .unwrap();
    let members = state
        .with_core(|c| {
            let s = crate::permissions::require_state(&c.db)?;
            Ok(crate::permissions::project_members(&s, &p.id, &me))
        })
        .unwrap();
    assert!(members.registered);
    assert_eq!(members.members.len(), 1);
    assert_eq!(members.members[0].public_key, me);
}

#[test]
fn subtasks_and_timers_through_the_commands() {
    let (_t, state) = app();
    crate::commands::organization(&state, "CV Maju Jaya").unwrap();
    let hook = Recorder::default();
    let me = me(&state);
    let project = create_project(&state, &hook, "Situs Web", "WEB", None).unwrap();
    let pid = project.id.clone();
    let input: NewTask = serde_json::from_value(serde_json::json!({ "title": "Spanduk" })).unwrap();
    let task = create_task(&state, &hook, &pid, input).unwrap();
    let tid = task.card.id.clone();
    let json = serde_json::to_value(&task).unwrap();
    assert_eq!(json["subtaskDone"], 0);
    assert_eq!(json["subtaskTotal"], 0);
    assert_eq!(json["trackedSecs"], 0);
    assert_eq!(json["timersRunningSince"], serde_json::json!([]));
    assert_eq!(json["subtasks"], serde_json::json!([]));
    assert_eq!(json["timeEntries"], serde_json::json!([]));
    assert_eq!(json["timeTotals"], serde_json::json!([]));
    assert_eq!(json["myRunningEntry"], serde_json::Value::Null);
    assert_eq!(json["statusTime"]["currentColumn"], "todo");
    assert_eq!(
        json["statusTime"]["closedSecs"],
        serde_json::json!({ "todo": 0, "doing": 0, "done": 0 })
    );
    assert_eq!(json["statusTime"]["currentSince"], json["createdAt"]);
    assert_eq!(json["statusTime"]["cycleSecs"], serde_json::Value::Null);
    assert_eq!(json["statusTime"]["clockWarning"], false);
    let n = hook.count();

    // Subtasks.
    let d = add_subtask(&state, &hook, &pid, &tid, " Cek warna ", Some(&me)).unwrap();
    assert_eq!(d.subtasks.len(), 1);
    let json = serde_json::to_value(&d).unwrap();
    let s = &json["subtasks"][0];
    assert_eq!(s["title"], "Cek warna");
    assert_eq!(s["done"], false);
    assert_eq!(s["assignee"]["name"], "Sari");
    assert_eq!(s["doneBy"], serde_json::Value::Null);
    assert_eq!(s["doneAt"], serde_json::Value::Null);
    assert_eq!(s["createdBy"]["publicKey"], me);
    assert_eq!(json["subtaskTotal"], 1);
    assert_eq!(json["activity"].as_array().unwrap().last().unwrap()["kind"], "subtask_added");
    for (title, assignee) in [("", None), ("a\nb", None), ("x", Some("ab".repeat(32)))] {
        assert_eq!(
            add_subtask(&state, &hook, &pid, &tid, title, assignee.as_deref())
                .unwrap_err()
                .code(),
            "invalid_input",
            "{title:?}"
        );
    }
    let first = d.subtasks[0].id.clone();
    let d = add_subtask(&state, &hook, &pid, &tid, "Cetak", Some("")).unwrap();
    assert_eq!(d.subtasks[1].assignee, None, "empty assignee means none");
    let second = d.subtasks[1].id.clone();

    let patch: SubtaskPatch = serde_json::from_value(serde_json::json!({ "done": true })).unwrap();
    let d = update_subtask(&state, &hook, &pid, &tid, &first, patch).unwrap();
    assert!(d.subtasks[0].done);
    assert_eq!(d.subtasks[0].done_by.as_ref().unwrap().name, "Sari");
    assert!(d.subtasks[0].done_at.is_some());
    assert_eq!((d.card.subtask_done, d.card.subtask_total), (1, 2));
    let patch: SubtaskPatch =
        serde_json::from_value(serde_json::json!({ "assignee": null, "title": " Cek warna akhir " }))
            .unwrap();
    let d = update_subtask(&state, &hook, &pid, &tid, &first, patch).unwrap();
    assert_eq!(d.subtasks[0].assignee, None);
    assert_eq!(d.subtasks[0].title, "Cek warna akhir");
    assert!(d.subtasks[0].done, "absent field stays");
    let bad: SubtaskPatch =
        serde_json::from_value(serde_json::json!({ "assignee": "ab".repeat(32) })).unwrap();
    assert_eq!(
        update_subtask(&state, &hook, &pid, &tid, &first, bad).unwrap_err().code(),
        "invalid_input"
    );

    let d = move_subtask(&state, &hook, &pid, &tid, &second, 0).unwrap();
    let order: Vec<&str> = d.subtasks.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(order, [second.as_str(), first.as_str()]);
    let d = delete_subtask(&state, &hook, &pid, &tid, &second).unwrap();
    assert_eq!(d.subtasks.len(), 1);
    assert_eq!((d.card.subtask_done, d.card.subtask_total), (1, 1));
    assert_eq!(
        delete_subtask(&state, &hook, &pid, &tid, &second).unwrap_err().code(),
        "not_found"
    );

    // Timers.
    let d = start_timer(&state, &hook, &pid, &tid).unwrap();
    let running = d.my_running_entry.clone().unwrap();
    assert_eq!(d.card.timers_running_since.len(), 1);
    let json = serde_json::to_value(&d).unwrap();
    let e = &json["timeEntries"][0];
    assert_eq!(e["id"], running.as_str());
    assert_eq!(e["end"], serde_json::Value::Null);
    assert_eq!(e["mine"], true);
    assert_eq!(e["manual"], false);
    assert_eq!(e["secs"], 0);
    assert_eq!(e["person"]["name"], "Sari");
    assert_eq!(json["timeTotals"][0]["runningSince"], e["start"]);
    assert_eq!(json["timeTotals"][0]["secs"], 0);
    assert_eq!(
        stop_timer(&state, &hook, &pid, &tid, Some("a\nb")).unwrap_err().code(),
        "invalid_input"
    );
    let d = stop_timer(&state, &hook, &pid, &tid, Some(" rapat ")).unwrap();
    assert_eq!(d.my_running_entry, None);
    assert_eq!(d.time_entries[0].note, "rapat");
    assert!(d.time_entries[0].end.is_some());
    assert!(d.card.timers_running_since.is_empty());
    assert_eq!(d.activity.last().unwrap().kind, "time_logged");
    assert_eq!(
        stop_timer(&state, &hook, &pid, &tid, None).unwrap_err().code(),
        "invalid_input"
    );

    for bad in [0.0, 1441.0, 2.5] {
        assert_eq!(
            log_time(&state, &hook, &pid, &tid, bad, None).unwrap_err().code(),
            "invalid_input",
            "{bad}"
        );
    }
    let d = log_time(&state, &hook, &pid, &tid, 30.0, Some("manual")).unwrap();
    let manual = d.time_entries.iter().find(|e| e.manual).unwrap().clone();
    assert_eq!(manual.secs, 1800);
    assert_eq!(manual.note, "manual");
    assert!(d.card.tracked_secs >= 1800);
    assert_eq!(d.time_totals.len(), 1);
    assert_eq!(d.time_totals[0].secs, d.card.tracked_secs);
    assert_eq!(d.activity.last().unwrap().detail, "1800");
    let d = delete_time_entry(&state, &hook, &pid, &tid, &manual.id).unwrap();
    assert!(d.time_entries.iter().all(|e| e.id != manual.id));
    assert!(d.card.tracked_secs < 1800);

    // The board card carries the same numbers.
    let board = get_board(&state, &pid).unwrap();
    let card = serde_json::to_value(&board.columns[0].tasks[0]).unwrap();
    assert_eq!(card["subtaskDone"], 1);
    assert_eq!(card["subtaskTotal"], 1);
    assert_eq!(card["timersRunningSince"], serde_json::json!([]));

    // Failed calls sign nothing; every stored change verifies.
    assert_eq!(hook.count(), n + 10);
    let stored = state
        .with_core(|c| store::stored_changes(&c.db, &pid))
        .unwrap();
    assert_eq!(stored.len(), hook.count());
    for sc in &stored {
        crate::board::sign::verify_change(sc).unwrap();
    }

    // Guests read the task but cannot change subtasks or time.
    state
        .with_core(|c| {
            c.db.execute(
                "UPDATE members SET role = 'guest', kind = 'guest', is_superadmin = 0",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    let errs = [
        add_subtask(&state, &hook, &pid, &tid, "x", None).unwrap_err(),
        start_timer(&state, &hook, &pid, &tid).unwrap_err(),
        log_time(&state, &hook, &pid, &tid, 5.0, None).unwrap_err(),
        delete_subtask(&state, &hook, &pid, &tid, &first).unwrap_err(),
    ];
    for e in errs {
        assert_eq!(e.code(), "forbidden", "{e}");
    }
}

#[test]
fn starting_a_timer_stops_my_timer_on_another_task() {
    let (_t, state) = app();
    crate::commands::organization(&state, "CV Maju Jaya").unwrap();
    let project = create_project(&state, &NoopSync, "Situs Web", "WEB", None).unwrap();
    let new = |title: &str| {
        let input: NewTask = serde_json::from_value(serde_json::json!({ "title": title })).unwrap();
        create_task(&state, &NoopSync, &project.id, input).unwrap().card.id
    };
    let (x, y) = (new("x"), new("y"));
    let dx = start_timer(&state, &NoopSync, &project.id, &x).unwrap();
    let again = start_timer(&state, &NoopSync, &project.id, &x).unwrap();
    assert_eq!(again.my_running_entry, dx.my_running_entry, "one timer per task");
    assert_eq!(again.time_entries.len(), 1);
    let dy = start_timer(&state, &NoopSync, &project.id, &y).unwrap();
    assert!(dy.my_running_entry.is_some());
    let dx = get_task(&state, &project.id, &x).unwrap();
    assert_eq!(dx.my_running_entry, None);
    assert!(dx.time_entries[0].end.is_some());
    let board = get_board(&state, &project.id).unwrap();
    let running: Vec<usize> = board.columns[0]
        .tasks
        .iter()
        .map(|t| t.timers_running_since.len())
        .collect();
    assert_eq!(running, [0, 1]);
}

#[test]
fn cards_carry_the_viewers_delete_right_and_running_timer() {
    use crate::board::testutil::{Laptop, add_member, add_team, register_project};

    let mut l = Laptop::founder("Sari");
    let sari = l.pk();
    let pk = |n: u8| format!("{n:02x}").repeat(32);
    let (admin, budi, citra, guest, dedi, eko) = (pk(1), pk(2), pk(3), pk(4), pk(5), pk(6));
    add_member(&l.conn, &admin, "Admin", "member");
    add_member(&l.conn, &budi, "Budi", "member");
    add_member(&l.conn, &citra, "Citra", "member");
    add_member(&l.conn, &guest, "Tamu", "guest");
    add_member(&l.conn, &dedi, "Dedi", "member");
    add_member(&l.conn, &eko, "Eko", "superadmin");
    let team = add_team(
        &l.conn,
        "Desain",
        &[
            (&admin, "admin"),
            (&budi, "member"),
            (&citra, "member"),
            (&dedi, "member"),
        ],
    );
    // The founder (a superadmin) creates both projects; the registration
    // must name the same creator. Eko is a superadmin who did not create
    // them: a member of WEB, not of INT.
    let web = store::create_project_local(&mut l.conn, &l.id, "Situs Web", "WEB", Some(&team))
        .unwrap()
        .value;
    register_project(
        &l.conn,
        &web.id,
        Some(&team),
        &sari,
        &[&sari, &admin, &budi, &citra, &guest, &dedi, &eko],
    );
    // A project without department.
    let int = store::create_project_local(&mut l.conn, &l.id, "Internal", "INT", None)
        .unwrap()
        .value;
    register_project(
        &l.conn,
        &int.id,
        None,
        &sari,
        &[&sari, &budi, &citra, &guest],
    );

    let at = clock::now_rfc3339();
    let init = |title: &str, assignee: Option<&String>| TaskInit {
        title: title.into(),
        description: String::new(),
        column: None,
        assignee: assignee.cloned(),
        due: None,
        priority: model::Priority::None,
        labels: Vec::new(),
    };
    let create = |conn: &mut rusqlite::Connection, project: &str, by: &str, task: TaskInit| {
        let stamp = Stamp { actor: by, at: &at };
        store::commit_local(conn, &l.id, project, |d| {
            let id = d.create_task(stamp, task)?;
            if by == budi {
                d.start_timer(stamp, &id)?;
            }
            Ok(id)
        })
        .unwrap()
        .value
    };
    // Budi creates Spanduk (assigned to Citra) and starts a timer on it.
    let spanduk = create(&mut l.conn, &web.id, &budi, init("Spanduk", Some(&citra)));
    // Dedi creates Brosur, then leaves the project (still in the department).
    let brosur = create(&mut l.conn, &web.id, &dedi, init("Brosur", None));
    l.conn
        .execute(
            "DELETE FROM project_members WHERE project_id = ?1 AND public_key = ?2",
            [&web.id, &dedi],
        )
        .unwrap();
    // Citra creates Rapat in the project without department.
    let rapat = create(&mut l.conn, &int.id, &citra, init("Rapat", None));

    let dir = LocalMembers::new(&l.id);
    let actor = store::actor_of(&l.id);
    let view_as = |project: &ProjectRow, task_id: &str, me: &str| {
        let ctx = Ctx {
            conn: &l.conn,
            me,
            policy: &LocalRolePolicy,
            dir: &dir,
        };
        let doc = store::load_doc(&l.conn, &project.id, &actor).unwrap();
        let task = doc
            .tasks()
            .unwrap()
            .into_iter()
            .find(|t| t.id == task_id)
            .unwrap();
        let card = ctx
            .board(project, &doc)
            .unwrap()
            .columns
            .into_iter()
            .flat_map(|c| c.tasks)
            .find(|t| t.id == task_id)
            .unwrap();
        let may = |action: BoardAction| LocalRolePolicy.allows(&l.conn, me, &action);
        let edit = may(BoardAction::EditTask {
            project_id: project.id.clone(),
            task_id: task.id.clone(),
        });
        let delete = may(BoardAction::DeleteTask {
            project_id: project.id.clone(),
            task_id: task.id.clone(),
            created_by: task.created_by.clone(),
        });
        (card, ctx.detail(project, &task), edit, delete)
    };

    // (project, task, viewer, may edit, may delete, timer running)
    let cases = [
        (&web, &spanduk, &budi, true, true, true), // task creator
        (&web, &spanduk, &admin, true, true, false), // department admin
        (&web, &spanduk, &sari, true, true, false), // founder, project creator
        (&web, &spanduk, &eko, true, true, false),  // superadmin and member
        (&web, &spanduk, &citra, true, false, false),
        (&web, &spanduk, &guest, false, false, false),
        (&web, &spanduk, &dedi, false, false, false), // left the project
        (&web, &brosur, &dedi, false, false, false),  // creator who left
        (&web, &brosur, &budi, true, false, false),
        (&web, &brosur, &admin, true, true, false),
        (&web, &brosur, &eko, true, true, false),
        (&int, &rapat, &citra, true, true, false), // task creator
        (&int, &rapat, &budi, true, false, false),
        (&int, &rapat, &sari, true, true, false), // founder, project creator
        (&int, &rapat, &eko, false, false, false), // superadmin, not a member
        (&int, &rapat, &guest, false, false, false),
        (&int, &rapat, &admin, false, false, false), // not a member
    ];
    for (project, task, who, edit, delete, running) in cases {
        let (card, detail, may_edit, may_delete) = view_as(project, task, who);
        let at = format!("{} {who}", project.code);
        assert_eq!(card.can_edit, may_edit, "card agrees with EditTask: {at}");
        assert_eq!(card.can_delete, may_delete, "card agrees with DeleteTask: {at}");
        assert_eq!(card.can_edit, edit, "{at}");
        assert_eq!(card.can_delete, delete, "{at}");
        assert_eq!(card.my_timer_running, running, "{at}");
        assert_eq!(detail.card, card, "detail and board agree: {at}");
        assert_eq!(detail.my_running_entry.is_some(), running, "{at}");
    }

    // JSON: one camelCase key each, in the card and the flattened detail.
    let (card, detail, _, _) = view_as(&web, &spanduk, &budi);
    let json = serde_json::to_value(&card).unwrap();
    assert_eq!(json["canEdit"], true);
    assert_eq!(json["canDelete"], true);
    assert_eq!(json["myTimerRunning"], true);
    let text = serde_json::to_string(&detail).unwrap();
    assert_eq!(text.matches("\"canEdit\"").count(), 1);
    assert_eq!(text.matches("\"canDelete\"").count(), 1);
    assert_eq!(text.matches("\"myTimerRunning\"").count(), 1);

    // My tasks use the same rule.
    let ctx = Ctx {
        conn: &l.conn,
        me: &citra,
        policy: &LocalRolePolicy,
        dir: &dir,
    };
    let mine = ctx.my_tasks(&actor).unwrap();
    assert_eq!(mine.len(), 1);
    let t = &mine[0].task;
    assert!(t.can_edit && !t.can_delete && !t.my_timer_running);
}
