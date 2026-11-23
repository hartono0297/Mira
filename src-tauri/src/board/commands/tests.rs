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
