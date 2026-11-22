//! Tauri commands of the board (docs/plans/tahap-3-lokal.md, "Kontrak command
//! Tauri"). Each command is a thin wrapper over a plain function taking
//! `&MiraState`, so tests run without a Tauri runtime. After every successful
//! mutation the wrapper emits `mira://board` and the plain function hands the
//! new signed changes to the `BoardSyncHook` (after the database lock is
//! released).

use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use super::assignees::{AssigneeDirectory, LocalMembers};
use super::doc::{Stamp, TaskChanges, TaskInit};
use super::model::{
    self, BoardView, ColumnId, MyTask, NewTask, ProjectSummary, TaskDetail, TaskPatch,
};
use super::policy::{BoardAction, BoardPolicy, LocalRolePolicy};
use super::sign::SignedChange;
use super::store::{self, Committed, ProjectRow};
use super::sync::{BoardSyncHook, NoopSync};
use super::view::Ctx;
use crate::clock;
use crate::error::{AppError, AppResult};
use crate::state::{Core, MiraState};

pub const BOARD_EVENT: &str = "mira://board";

/// Board state managed by Tauri next to `MiraState`.
#[derive(Clone)]
pub struct BoardRuntime {
    pub hook: Arc<dyn BoardSyncHook>,
}

impl Default for BoardRuntime {
    fn default() -> Self {
        Self {
            hook: Arc::new(NoopSync),
        }
    }
}

fn notify(hook: &dyn BoardSyncHook, project_id: &str, changes: &[SignedChange]) {
    for c in changes {
        hook.on_local_change(project_id, c);
    }
}

/// Runs `f` with the core, the viewer's policy and directory.
fn with_ctx<T>(
    state: &MiraState,
    f: impl FnOnce(&mut Core, &dyn BoardPolicy, &dyn AssigneeDirectory) -> AppResult<T>,
) -> AppResult<T> {
    state.with_core(|core| {
        let dir = LocalMembers::new(&core.identity);
        f(core, &LocalRolePolicy, &dir)
    })
}

fn ctx<'a>(core: &'a Core, policy: &'a dyn BoardPolicy, dir: &'a dyn AssigneeDirectory) -> Ctx<'a> {
    Ctx {
        conn: &core.db,
        me: core.identity.public_key_hex(),
        policy,
        dir,
    }
}

fn check_assignee(
    core: &Core,
    dir: &dyn AssigneeDirectory,
    project: &ProjectRow,
    pk: Option<&str>,
) -> AppResult<()> {
    let Some(pk) = pk else { return Ok(()) };
    if dir
        .assignable(&core.db, project)?
        .iter()
        .any(|p| p.public_key == pk)
    {
        Ok(())
    } else {
        Err(AppError::InvalidInput(
            "Penanggung jawab harus anggota proyek ini. Pilih nama dari daftar.".into(),
        ))
    }
}

fn opt_due(due: Option<&str>) -> AppResult<Option<String>> {
    due.map(model::validate_due).transpose()
}

pub fn list_projects(state: &MiraState) -> AppResult<Vec<ProjectSummary>> {
    with_ctx(state, |core, policy, dir| {
        let c = ctx(core, policy, dir);
        store::projects(&core.db)?
            .iter()
            .filter(|row| c.can_view(&row.id))
            .map(|row| c.summary(row))
            .collect()
    })
}

pub fn create_project(
    state: &MiraState,
    hook: &dyn BoardSyncHook,
    name: &str,
    code: &str,
    team_id: Option<&str>,
) -> AppResult<ProjectSummary> {
    let team_id = model::normalize_team_id(team_id);
    let (summary, project_id, changes) = with_ctx(state, |core, policy, dir| {
        let me = core.identity.public_key_hex().to_owned();
        policy.check(
            &core.db,
            &me,
            &BoardAction::CreateProject {
                team_id: team_id.map(str::to_owned),
            },
        )?;
        let Committed {
            value: row,
            changes,
            ..
        } = store::create_project(&mut core.db, &core.identity, name, code, team_id)?;
        let summary = ctx(core, policy, dir).summary(&row)?;
        Ok((summary, row.id, changes))
    })?;
    notify(hook, &project_id, &changes);
    Ok(summary)
}

/// Renames a project (`project.name` in the document, as a signed change).
/// The code stays: other laptops and messages refer to it.
pub fn update_project(
    state: &MiraState,
    hook: &dyn BoardSyncHook,
    project_id: &str,
    name: &str,
) -> AppResult<ProjectSummary> {
    let (summary, changes) = with_ctx(state, |core, policy, dir| {
        let me = core.identity.public_key_hex().to_owned();
        let row = store::project(&core.db, project_id)?;
        policy.check(
            &core.db,
            &me,
            &BoardAction::ManageProject {
                project_id: row.id.clone(),
            },
        )?;
        let name = model::validate_project_name(name)?;
        let c = store::commit_local(&mut core.db, &core.identity, project_id, |doc| {
            doc.rename_project(&name)
        })?;
        let row = store::project(&core.db, project_id)?;
        Ok((ctx(core, policy, dir).summary(&row)?, c.changes))
    })?;
    notify(hook, project_id, &changes);
    Ok(summary)
}

/// Refuses projects the viewer may not see (for example after leaving the
/// team): the local copy stays but is not shown.
fn require_view(core: &Core, policy: &dyn BoardPolicy, project_id: &str) -> AppResult<()> {
    policy.check(
        &core.db,
        core.identity.public_key_hex(),
        &BoardAction::ViewProject {
            project_id: project_id.to_owned(),
        },
    )
}

pub fn get_board(state: &MiraState, project_id: &str) -> AppResult<BoardView> {
    with_ctx(state, |core, policy, dir| {
        let row = store::project(&core.db, project_id)?;
        require_view(core, policy, project_id)?;
        let doc = store::load_doc(&core.db, project_id, &store::actor_of(&core.identity))?;
        ctx(core, policy, dir).board(&row, &doc)
    })
}

pub fn create_task(
    state: &MiraState,
    hook: &dyn BoardSyncHook,
    project_id: &str,
    input: NewTask,
) -> AppResult<TaskDetail> {
    let (detail, changes) = with_ctx(state, |core, policy, dir| {
        let me = core.identity.public_key_hex().to_owned();
        let row = store::project(&core.db, project_id)?;
        policy.check(
            &core.db,
            &me,
            &BoardAction::CreateTask {
                project_id: row.id.clone(),
            },
        )?;
        let init = TaskInit {
            title: model::validate_title(&input.title)?,
            description: model::validate_description(input.description.as_deref().unwrap_or(""))?,
            column: input.column_id,
            assignee: input.assignee.filter(|a| !a.is_empty()),
            due: opt_due(input.due.as_deref())?,
            priority: input.priority.unwrap_or_default(),
            labels: model::validate_labels(input.labels.as_deref().unwrap_or(&[]))?,
        };
        check_assignee(core, dir, &row, init.assignee.as_deref())?;
        let at = clock::now_rfc3339();
        let c = store::commit_local(&mut core.db, &core.identity, project_id, |doc| {
            doc.create_task(
                Stamp {
                    actor: &me,
                    at: &at,
                },
                init,
            )
        })?;
        let task = c.doc.live_task(&c.value)?;
        Ok((ctx(core, policy, dir).detail(&row, &task), c.changes))
    })?;
    notify(hook, project_id, &changes);
    Ok(detail)
}

pub fn get_task(state: &MiraState, project_id: &str, task_id: &str) -> AppResult<TaskDetail> {
    with_ctx(state, |core, policy, dir| {
        let row = store::project(&core.db, project_id)?;
        require_view(core, policy, project_id)?;
        let doc = store::load_doc(&core.db, project_id, &store::actor_of(&core.identity))?;
        let task = doc.live_task(task_id)?;
        Ok(ctx(core, policy, dir).detail(&row, &task))
    })
}

pub fn update_task(
    state: &MiraState,
    hook: &dyn BoardSyncHook,
    project_id: &str,
    task_id: &str,
    patch: TaskPatch,
) -> AppResult<TaskDetail> {
    let (detail, changes) = with_ctx(state, |core, policy, dir| {
        let me = core.identity.public_key_hex().to_owned();
        let row = store::project(&core.db, project_id)?;
        policy.check(
            &core.db,
            &me,
            &BoardAction::EditTask {
                project_id: row.id.clone(),
                task_id: task_id.to_owned(),
            },
        )?;
        let changes = TaskChanges {
            title: patch
                .title
                .as_deref()
                .map(model::validate_title)
                .transpose()?,
            description: patch
                .description
                .as_deref()
                .map(model::validate_description)
                .transpose()?,
            assignee: patch.assignee.map(|a| a.filter(|a| !a.is_empty())),
            due: patch.due.map(|d| opt_due(d.as_deref())).transpose()?,
            priority: patch.priority,
            labels: patch
                .labels
                .as_deref()
                .map(model::validate_labels)
                .transpose()?,
        };
        if let Some(Some(pk)) = &changes.assignee {
            check_assignee(core, dir, &row, Some(pk))?;
        }
        let at = clock::now_rfc3339();
        let name_of = |pk: &str| dir.name_of(&core.db, pk);
        let names: Vec<(String, String)> = match &changes.assignee {
            Some(Some(pk)) => vec![(pk.clone(), name_of(pk))],
            _ => Vec::new(),
        };
        let lookup = |pk: &str| {
            names
                .iter()
                .find(|(k, _)| k == pk)
                .map(|(_, n)| n.clone())
                .unwrap_or_default()
        };
        let c = store::commit_local(&mut core.db, &core.identity, project_id, |doc| {
            doc.update_task(
                Stamp {
                    actor: &me,
                    at: &at,
                },
                task_id,
                &changes,
                &lookup,
            )
        })?;
        let task = c.doc.live_task(task_id)?;
        Ok((ctx(core, policy, dir).detail(&row, &task), c.changes))
    })?;
    notify(hook, project_id, &changes);
    Ok(detail)
}

pub fn move_task(
    state: &MiraState,
    hook: &dyn BoardSyncHook,
    project_id: &str,
    task_id: &str,
    column_id: ColumnId,
    index: usize,
) -> AppResult<BoardView> {
    let (view, changes) = with_ctx(state, |core, policy, dir| {
        let me = core.identity.public_key_hex().to_owned();
        let row = store::project(&core.db, project_id)?;
        policy.check(
            &core.db,
            &me,
            &BoardAction::MoveTask {
                project_id: row.id.clone(),
                task_id: task_id.to_owned(),
            },
        )?;
        let at = clock::now_rfc3339();
        let c = store::commit_local(&mut core.db, &core.identity, project_id, |doc| {
            doc.move_task(
                Stamp {
                    actor: &me,
                    at: &at,
                },
                task_id,
                column_id,
                index,
            )
        })?;
        Ok((ctx(core, policy, dir).board(&row, &c.doc)?, c.changes))
    })?;
    notify(hook, project_id, &changes);
    Ok(view)
}

pub fn delete_task(
    state: &MiraState,
    hook: &dyn BoardSyncHook,
    project_id: &str,
    task_id: &str,
) -> AppResult<()> {
    let changes = with_ctx(state, |core, policy, _dir| {
        let me = core.identity.public_key_hex().to_owned();
        let row = store::project(&core.db, project_id)?;
        let task = store::load_doc(&core.db, project_id, &store::actor_of(&core.identity))?
            .live_task(task_id)?;
        policy.check(
            &core.db,
            &me,
            &BoardAction::DeleteTask {
                project_id: row.id.clone(),
                task_id: task_id.to_owned(),
                created_by: task.created_by,
            },
        )?;
        let at = clock::now_rfc3339();
        let c = store::commit_local(&mut core.db, &core.identity, project_id, |doc| {
            doc.delete_task(
                Stamp {
                    actor: &me,
                    at: &at,
                },
                task_id,
            )
        })?;
        Ok(c.changes)
    })?;
    notify(hook, project_id, &changes);
    Ok(())
}

pub fn add_comment(
    state: &MiraState,
    hook: &dyn BoardSyncHook,
    project_id: &str,
    task_id: &str,
    body: &str,
) -> AppResult<TaskDetail> {
    let (detail, changes) = with_ctx(state, |core, policy, dir| {
        let me = core.identity.public_key_hex().to_owned();
        let row = store::project(&core.db, project_id)?;
        policy.check(
            &core.db,
            &me,
            &BoardAction::Comment {
                project_id: row.id.clone(),
                task_id: task_id.to_owned(),
            },
        )?;
        let body = model::validate_comment(body)?;
        let at = clock::now_rfc3339();
        let c = store::commit_local(&mut core.db, &core.identity, project_id, |doc| {
            doc.add_comment(
                Stamp {
                    actor: &me,
                    at: &at,
                },
                task_id,
                &body,
            )
        })?;
        let task = c.doc.live_task(task_id)?;
        Ok((ctx(core, policy, dir).detail(&row, &task), c.changes))
    })?;
    notify(hook, project_id, &changes);
    Ok(detail)
}

pub fn my_tasks(state: &MiraState) -> AppResult<Vec<MyTask>> {
    with_ctx(state, |core, policy, dir| {
        ctx(core, policy, dir).my_tasks(&store::actor_of(&core.identity))
    })
}

fn emit(app: &AppHandle) {
    // The frontend also reloads after its own action, so a failed emit only
    // delays other open views until their next poll.
    let _ = app.emit(BOARD_EVENT, ());
}

#[tauri::command]
pub async fn board_list_projects(state: State<'_, MiraState>) -> AppResult<Vec<ProjectSummary>> {
    list_projects(&state)
}

#[tauri::command]
pub async fn board_create_project(
    app: AppHandle,
    state: State<'_, MiraState>,
    board: State<'_, BoardRuntime>,
    name: String,
    code: String,
    team_id: Option<String>,
) -> AppResult<ProjectSummary> {
    let out = create_project(
        &state,
        board.hook.as_ref(),
        &name,
        &code,
        team_id.as_deref(),
    )?;
    emit(&app);
    Ok(out)
}

#[tauri::command]
pub async fn board_update_project(
    app: AppHandle,
    state: State<'_, MiraState>,
    board: State<'_, BoardRuntime>,
    project_id: String,
    name: String,
) -> AppResult<ProjectSummary> {
    let out = update_project(&state, board.hook.as_ref(), &project_id, &name)?;
    emit(&app);
    Ok(out)
}

#[tauri::command]
pub async fn board_get_board(
    state: State<'_, MiraState>,
    project_id: String,
) -> AppResult<BoardView> {
    get_board(&state, &project_id)
}

#[tauri::command]
pub async fn board_create_task(
    app: AppHandle,
    state: State<'_, MiraState>,
    board: State<'_, BoardRuntime>,
    project_id: String,
    input: NewTask,
) -> AppResult<TaskDetail> {
    let out = create_task(&state, board.hook.as_ref(), &project_id, input)?;
    emit(&app);
    Ok(out)
}

#[tauri::command]
pub async fn board_get_task(
    state: State<'_, MiraState>,
    project_id: String,
    task_id: String,
) -> AppResult<TaskDetail> {
    get_task(&state, &project_id, &task_id)
}

#[tauri::command]
pub async fn board_update_task(
    app: AppHandle,
    state: State<'_, MiraState>,
    board: State<'_, BoardRuntime>,
    project_id: String,
    task_id: String,
    patch: TaskPatch,
) -> AppResult<TaskDetail> {
    let out = update_task(&state, board.hook.as_ref(), &project_id, &task_id, patch)?;
    emit(&app);
    Ok(out)
}

#[tauri::command]
pub async fn board_move_task(
    app: AppHandle,
    state: State<'_, MiraState>,
    board: State<'_, BoardRuntime>,
    project_id: String,
    task_id: String,
    column_id: ColumnId,
    index: usize,
) -> AppResult<BoardView> {
    let out = move_task(
        &state,
        board.hook.as_ref(),
        &project_id,
        &task_id,
        column_id,
        index,
    )?;
    emit(&app);
    Ok(out)
}

#[tauri::command]
pub async fn board_delete_task(
    app: AppHandle,
    state: State<'_, MiraState>,
    board: State<'_, BoardRuntime>,
    project_id: String,
    task_id: String,
) -> AppResult<()> {
    delete_task(&state, board.hook.as_ref(), &project_id, &task_id)?;
    emit(&app);
    Ok(())
}

#[tauri::command]
pub async fn board_add_comment(
    app: AppHandle,
    state: State<'_, MiraState>,
    board: State<'_, BoardRuntime>,
    project_id: String,
    task_id: String,
    body: String,
) -> AppResult<TaskDetail> {
    let out = add_comment(&state, board.hook.as_ref(), &project_id, &task_id, &body)?;
    emit(&app);
    Ok(out)
}

#[tauri::command]
pub async fn board_my_tasks(state: State<'_, MiraState>) -> AppResult<Vec<MyTask>> {
    my_tasks(&state)
}

#[cfg(test)]
mod tests;
