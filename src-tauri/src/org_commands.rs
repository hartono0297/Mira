//! Tauri commands for v0.3 organization data: departments, people, the
//! superadmin's user list, labels, project members and join requests
//! (docs/plans/v0.3-kontrak.md, "Command"). TypeScript side:
//! `src/api/org.ts`.
//!
//! Every mutation authors one signed op through `permissions`, then syncs
//! and emits `mira://directory` (`net_backend::after_change`).

use std::collections::HashMap;

use tauri::{AppHandle, State};

use crate::clock;
use crate::error::{AppError, AppResult};
use crate::net_backend::{self, AppNet};
use crate::permissions::{
    self, DepartmentView, JoinRequestView, LabelView, LivePeer, OrgOverview, PersonView,
    ProjectMembersView, UserView,
};
use crate::state::{Core, MiraState};

/// Emitted when the join requests this laptop holds changed (a request
/// arrived directly or was forwarded). The network side (agent A) emits it;
/// decisions emit `mira://directory` like every other op.
pub const EVENT_JOIN_REQUESTS: &str = "mira://join-requests";

fn state_of(c: &Core) -> AppResult<permissions::OrgState> {
    permissions::require_state(&c.db)
}

pub(crate) async fn mutate<T>(
    state: &MiraState,
    net: &AppNet,
    app: &AppHandle,
    f: impl FnOnce(&mut Core) -> AppResult<T>,
) -> AppResult<T> {
    let out = state.with_core(f)?;
    net_backend::after_change(net, app).await;
    Ok(out)
}

// ----- Read --------------------------------------------------------------------

#[tauri::command]
pub async fn org_overview(state: State<'_, MiraState>) -> AppResult<OrgOverview> {
    state.with_core(|c| {
        let s = state_of(c)?;
        permissions::org_overview(&c.db, &s, c.identity.public_key_hex(), clock::now())
    })
}

#[tauri::command]
pub async fn org_departments(
    state: State<'_, MiraState>,
    include_archived: bool,
) -> AppResult<Vec<DepartmentView>> {
    state.with_core(|c| Ok(permissions::departments(&state_of(c)?, include_archived)))
}

#[tauri::command]
pub async fn org_people(state: State<'_, MiraState>) -> AppResult<Vec<PersonView>> {
    state.with_core(|c| {
        let s = state_of(c)?;
        Ok(permissions::people(
            &s,
            c.identity.public_key_hex(),
            c.identity.display_name(),
        ))
    })
}

/// Superadmin: everyone; department admin: their department's people
/// (`forbidden` for anyone else).
#[tauri::command]
pub async fn org_users(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
) -> AppResult<Vec<UserView>> {
    let online: HashMap<String, LivePeer> = match net.running().await {
        Some(n) => n
            .status()
            .peers
            .into_iter()
            .map(|p| {
                (
                    p.public_key,
                    LivePeer {
                        address: Some(p.address.to_string()),
                    },
                )
            })
            .collect(),
        None => HashMap::new(),
    };
    state.with_core(|c| {
        let s = state_of(c)?;
        permissions::users(
            &c.db,
            &s,
            c.identity.public_key_hex(),
            c.identity.display_name(),
            &online,
        )
    })
}

#[tauri::command]
pub async fn org_labels(state: State<'_, MiraState>) -> AppResult<Vec<LabelView>> {
    state.with_core(|c| Ok(permissions::labels(&state_of(c)?)))
}

#[tauri::command]
pub async fn org_project_members(
    state: State<'_, MiraState>,
    project_id: String,
) -> AppResult<ProjectMembersView> {
    state.with_core(|c| {
        Ok(permissions::project_members(
            &state_of(c)?,
            &project_id,
            c.identity.public_key_hex(),
        ))
    })
}

/// Pending requests this person may decide (empty for everyone else).
#[tauri::command]
pub async fn org_join_requests(state: State<'_, MiraState>) -> AppResult<Vec<JoinRequestView>> {
    state.with_core(|c| {
        let s = state_of(c)?;
        permissions::pending_join_requests(&c.db, &s, c.identity.public_key_hex(), clock::now())
    })
}

// ----- Departments -------------------------------------------------------------

/// Superadmin: new department with its channel.
#[tauri::command]
pub async fn org_create_department(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    name: String,
) -> AppResult<DepartmentView> {
    mutate(&state, &net, &app, |c| {
        let team = permissions::create_team(&mut c.db, &c.identity, &name, clock::now())?;
        permissions::departments(&state_of(c)?, true)
            .into_iter()
            .find(|d| d.id == team.id)
            .ok_or_else(|| AppError::Internal("Departemen baru tidak ditemukan.".into()))
    })
    .await
}

#[tauri::command]
pub async fn org_rename_department(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    team_id: String,
    name: String,
) -> AppResult<()> {
    mutate(&state, &net, &app, |c| {
        permissions::rename_department(&mut c.db, &c.identity, &team_id, &name, clock::now())
    })
    .await
}

#[tauri::command]
pub async fn org_set_department_archived(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    team_id: String,
    archived: bool,
) -> AppResult<()> {
    mutate(&state, &net, &app, |c| {
        permissions::set_department_archived(
            &mut c.db,
            &c.identity,
            &team_id,
            archived,
            clock::now(),
        )
    })
    .await
}

#[tauri::command]
pub async fn org_set_department_admin(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    team_id: String,
    public_key: String,
    admin: bool,
) -> AppResult<()> {
    mutate(&state, &net, &app, |c| {
        permissions::set_team_admin(
            &mut c.db,
            &c.identity,
            &team_id,
            &public_key,
            admin,
            clock::now(),
        )
    })
    .await
}

/// Superadmin: moves a person to another department (or into one, when
/// they have none).
#[tauri::command]
pub async fn org_move_member(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    public_key: String,
    team_id: String,
) -> AppResult<()> {
    mutate(&state, &net, &app, |c| {
        permissions::move_member(&mut c.db, &c.identity, &public_key, &team_id, clock::now())
    })
    .await
}

// ----- Join requests -----------------------------------------------------------

#[tauri::command]
pub async fn org_approve_join(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    request_id: String,
) -> AppResult<()> {
    mutate(&state, &net, &app, |c| {
        permissions::approve_join(&mut c.db, &c.identity, &request_id, clock::now())
    })
    .await
}

#[tauri::command]
pub async fn org_reject_join(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    request_id: String,
) -> AppResult<()> {
    mutate(&state, &net, &app, |c| {
        permissions::reject_join(&mut c.db, &c.identity, &request_id, clock::now())
    })
    .await
}

// ----- Project members ---------------------------------------------------------

#[tauri::command]
pub async fn org_add_project_member(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    project_id: String,
    public_key: String,
) -> AppResult<()> {
    mutate(&state, &net, &app, |c| {
        permissions::add_project_member(
            &mut c.db,
            &c.identity,
            &project_id,
            &public_key,
            clock::now(),
        )
    })
    .await
}

#[tauri::command]
pub async fn org_remove_project_member(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    project_id: String,
    public_key: String,
) -> AppResult<()> {
    mutate(&state, &net, &app, |c| {
        permissions::remove_project_member(
            &mut c.db,
            &c.identity,
            &project_id,
            &public_key,
            clock::now(),
        )
    })
    .await
}

// ----- Labels --------------------------------------------------------------------

/// Superadmin: new label; returns its id.
#[tauri::command]
pub async fn org_create_label(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    name: String,
) -> AppResult<String> {
    mutate(&state, &net, &app, |c| {
        permissions::create_label(&mut c.db, &c.identity, &name, clock::now())
    })
    .await
}

#[tauri::command]
pub async fn org_rename_label(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    label_id: String,
    name: String,
) -> AppResult<()> {
    mutate(&state, &net, &app, |c| {
        permissions::rename_label(&mut c.db, &c.identity, &label_id, &name, clock::now())
    })
    .await
}

#[tauri::command]
pub async fn org_set_label_archived(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    label_id: String,
    archived: bool,
) -> AppResult<()> {
    mutate(&state, &net, &app, |c| {
        permissions::set_label_archived(&mut c.db, &c.identity, &label_id, archived, clock::now())
    })
    .await
}

#[tauri::command]
pub async fn org_set_label_assigned(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    label_id: String,
    public_key: String,
    assigned: bool,
) -> AppResult<()> {
    mutate(&state, &net, &app, |c| {
        permissions::assign_label(
            &mut c.db,
            &c.identity,
            &label_id,
            &public_key,
            assigned,
            clock::now(),
        )
    })
    .await
}

// ----- 0.6.0: suspend, reinstate, remove for good ----------------------------------
// (docs/plans/perbaikan-bergabung.md).

/// Active members whose laptop keeps the suspend gate closed.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuspendGateView {
    pub allowed: bool,
    pub outdated: Vec<OutdatedLaptop>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutdatedLaptop {
    pub name: String,
    pub app_version: Option<String>,
}

/// Whether this laptop may write `member_suspend` now, and the laptops
/// that keep the gate closed.
#[tauri::command]
pub async fn org_suspend_gate(state: State<'_, MiraState>) -> AppResult<SuspendGateView> {
    state.with_core(|c| {
        let s = state_of(c)?;
        let outdated: Vec<OutdatedLaptop> = permissions::suspend_blockers(&s)
            .into_iter()
            .map(|b| OutdatedLaptop {
                name: b.name,
                app_version: b.app_version,
            })
            .collect();
        Ok(SuspendGateView {
            allowed: outdated.is_empty(),
            outdated,
        })
    })
}

#[tauri::command]
pub async fn org_suspend_member(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    public_key: String,
) -> AppResult<()> {
    mutate(&state, &net, &app, |c| {
        permissions::suspend_member(&mut c.db, &c.identity, &public_key, clock::now())
    })
    .await
}

#[tauri::command]
pub async fn org_reinstate_member(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    public_key: String,
) -> AppResult<()> {
    mutate(&state, &net, &app, |c| {
        permissions::reinstate_member(&mut c.db, &c.identity, &public_key, clock::now())
    })
    .await
}

/// Removes for good: an active or a suspended member.
#[tauri::command]
pub async fn org_remove_member(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    public_key: String,
) -> AppResult<()> {
    mutate(&state, &net, &app, |c| {
        permissions::remove_member(&mut c.db, &c.identity, &public_key, clock::now())
    })
    .await
}
