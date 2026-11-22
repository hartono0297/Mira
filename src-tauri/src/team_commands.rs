//! Tauri commands for the organization, teams and invites (Tahap 1,
//! docs/plans/tahap-1.md section 4). Each mutation is a signed op authored
//! through `permissions`; afterwards the network syncs it and the UI reloads.

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::clock;
use crate::error::{AppError, AppResult};
use crate::net_backend::{self, AppNet};
use crate::org::OrgInfo;
use crate::peers;
use crate::permissions::{
    self, Directory, InviteRole, InviteView, RejectedChange, TeamView, Validity,
};
use crate::state::MiraState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedInvite {
    pub code: String,
    pub invite: InviteView,
}

#[tauri::command]
pub async fn get_directory(state: State<'_, MiraState>) -> AppResult<Directory> {
    state.with_core(|c| permissions::directory(&c.db, &c.identity, clock::now()))
}

/// Runs a mutation, then lets the network sync it and the UI reload.
async fn mutate<T>(
    state: &MiraState,
    net: &AppNet,
    app: &AppHandle,
    f: impl FnOnce(&mut crate::state::Core) -> AppResult<T>,
) -> AppResult<T> {
    let out = state.with_core(f)?;
    net_backend::after_change(net, app).await;
    Ok(out)
}

#[tauri::command]
pub async fn create_team(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    name: String,
) -> AppResult<TeamView> {
    mutate(&state, &net, &app, |c| {
        permissions::create_team(&mut c.db, &c.identity, &name, clock::now())
    })
    .await
}

#[tauri::command]
pub async fn delete_team(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    team_id: String,
) -> AppResult<()> {
    mutate(&state, &net, &app, |c| {
        permissions::delete_team(&mut c.db, &c.identity, &team_id, clock::now())
    })
    .await
}

#[tauri::command]
pub async fn add_team_member(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    team_id: String,
    public_key: String,
) -> AppResult<()> {
    mutate(&state, &net, &app, |c| {
        permissions::add_team_member(&mut c.db, &c.identity, &team_id, &public_key, clock::now())
    })
    .await
}

#[tauri::command]
pub async fn remove_team_member(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    team_id: String,
    public_key: String,
) -> AppResult<()> {
    mutate(&state, &net, &app, |c| {
        permissions::remove_team_member(&mut c.db, &c.identity, &team_id, &public_key, clock::now())
    })
    .await
}

#[tauri::command]
pub async fn set_team_admin(
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

#[tauri::command]
pub async fn add_superadmin(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    public_key: String,
) -> AppResult<()> {
    mutate(&state, &net, &app, |c| {
        permissions::add_superadmin(&mut c.db, &c.identity, &public_key, clock::now())
    })
    .await
}

#[tauri::command]
pub async fn remove_superadmin(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    public_key: String,
) -> AppResult<()> {
    mutate(&state, &net, &app, |c| {
        permissions::remove_superadmin(&mut c.db, &c.identity, &public_key, clock::now())
    })
    .await
}

#[tauri::command]
pub async fn remove_member(
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

#[tauri::command]
pub async fn create_invite(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    team_id: String,
    role: String,
    validity: String,
    project_ids: Vec<String>,
) -> AppResult<CreatedInvite> {
    let role = InviteRole::parse(&role)
        .ok_or_else(|| AppError::Forbidden("Peran undangan tidak dikenali.".into()))?;
    let validity = Validity::parse(&validity)
        .ok_or_else(|| AppError::Forbidden("Masa berlaku undangan tidak dikenali.".into()))?;
    let (invite, code) = mutate(&state, &net, &app, |c| {
        permissions::create_invite(
            &mut c.db,
            &c.identity,
            &team_id,
            role,
            project_ids,
            validity,
            clock::now(),
        )
    })
    .await?;
    Ok(CreatedInvite { code, invite })
}

#[tauri::command]
pub async fn revoke_invite(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    invite_id: String,
) -> AppResult<()> {
    mutate(&state, &net, &app, |c| {
        permissions::revoke_invite(&mut c.db, &c.identity, &invite_id, clock::now())
    })
    .await
}

/// An existing member uses a code for another team.
#[tauri::command]
pub async fn redeem_invite(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    code: String,
) -> AppResult<()> {
    let code = permissions::normalize_code(&code)?;
    mutate(&state, &net, &app, |c| {
        permissions::redeem_as_member(&mut c.db, &c.identity, &code, clock::now()).map(|_| ())
    })
    .await
}

/// A laptop without an organization joins with a code (plan 2.4).
#[tauri::command]
pub async fn join_with_code(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    code: String,
    address: Option<String>,
) -> AppResult<OrgInfo> {
    let code = permissions::normalize_code(&code)?;
    state.with_core(|c| {
        if c.identity.display_name().is_none() {
            return Err(AppError::NameRequired);
        }
        if crate::org::load_organization(&c.db)?.is_some() {
            return Err(AppError::AlreadyInOrg);
        }
        Ok(())
    })?;
    let extra = match address.as_deref().map(str::trim).filter(|a| !a.is_empty()) {
        Some(a) => peers::parse_address_input(a)?.addrs,
        None => Vec::new(),
    };
    let network = net.get(&state, &app).await?;

    let prover_state = state.inner().clone();
    let prover_code = code.clone();
    let prove: crate::network::ProveFn = Box::new(move |challenge| {
        prover_state
            .with_core(|c| {
                permissions::build_join_proof(
                    &prover_code,
                    &challenge.org,
                    &challenge.invite,
                    &c.identity,
                )
            })
            .map(net_backend::proof_to_wire)
            .map_err(|e| e.to_string())
    });
    let accepted = network
        .join(code.tag(), extra, prove)
        .await
        .map_err(net_backend::join_error)?;

    let info = state.with_core(|c| {
        permissions::install_joined_org(
            &mut c.db,
            &c.identity,
            net_backend::organization(accepted.org),
            accepted
                .ops
                .into_iter()
                .map(net_backend::from_wire)
                .collect(),
            &code,
            clock::now(),
        )
    })?;
    net_backend::after_change(&net, &app).await;
    Ok(info)
}

#[tauri::command]
pub async fn get_rejected_changes(state: State<'_, MiraState>) -> AppResult<Vec<RejectedChange>> {
    state.with_core(|c| permissions::rejected_changes(&c.db, 200))
}
