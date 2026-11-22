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
fn removed_laptop_cannot_change_but_can_read() {
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
    let board = get_board(&state, &project.id).unwrap();
    assert!(!board.can_create);
    assert!(!board.project.can_manage);
    let detail = get_task(&state, &project.id, &t.card.id).unwrap();
    assert!(!detail.can_edit && !detail.can_delete);
}
