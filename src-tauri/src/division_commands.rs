//! Tauri commands of the "Departemen saya" tab and divisions
//! (docs/plans/dept-divisi.md, 5). TypeScript side: `src/api/division.ts`.
//!
//! Every mutation authors one signed op through `permissions`, then syncs
//! and emits `mira://directory` (`net_backend::after_change`).

use std::collections::HashSet;

use tauri::{AppHandle, State};

use crate::clock;
use crate::error::AppResult;
use crate::net_backend::AppNet;
use crate::org_commands::mutate;
use crate::permissions::{
    self, ConversationSettingsData, DeptOverviewData, DivisionRefData,
};
use crate::state::MiraState;

/// Public keys of the peers connected now.
async fn online_keys(net: &AppNet) -> HashSet<String> {
    match net.running().await {
        Some(n) => n
            .status()
            .peers
            .into_iter()
            .map(|p| p.public_key)
            .collect(),
        None => HashSet::new(),
    }
}

// ----- Read ----------------------------------------------------------------------

/// `None` when this person may not open that department.
#[tauri::command]
pub async fn dept_overview(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    team_id: Option<String>,
) -> AppResult<Option<DeptOverviewData>> {
    let online = online_keys(&net).await;
    state.with_core(|c| {
        let s = permissions::require_state(&c.db)?;
        permissions::dept_overview(
            &c.db,
            &s,
            c.identity.public_key_hex(),
            team_id.as_deref(),
            &|pk| online.contains(pk),
        )
    })
}

/// Divisions this person counts in or manages (every live one for a
/// superadmin).
#[tauri::command]
pub async fn my_divisions(state: State<'_, MiraState>) -> AppResult<Vec<DivisionRefData>> {
    state.with_core(|c| {
        let s = permissions::require_state(&c.db)?;
        Ok(permissions::my_divisions(&s, c.identity.public_key_hex()))
    })
}

/// Banner of a department channel or division chat (`ch:<id>`); `None`
/// for every other conversation.
#[tauri::command]
pub async fn conversation_settings(
    state: State<'_, MiraState>,
    conv: String,
) -> AppResult<Option<ConversationSettingsData>> {
    state.with_core(|c| {
        let Some(s) = permissions::load_state(&c.db)? else {
            return Ok(None);
        };
        Ok(permissions::conversation_settings(
            &s,
            c.identity.public_key_hex(),
            &conv,
        ))
    })
}

// ----- Divisions -----------------------------------------------------------------

/// Returns the new division's id.
#[tauri::command]
pub async fn division_create(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    team_id: String,
    name: String,
) -> AppResult<String> {
    mutate(&state, &net, &app, |c| {
        permissions::create_division(&mut c.db, &c.identity, &team_id, &name, clock::now())
    })
    .await
}

#[tauri::command]
pub async fn division_rename(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    division_id: String,
    name: String,
) -> AppResult<()> {
    mutate(&state, &net, &app, |c| {
        permissions::rename_division(&mut c.db, &c.identity, &division_id, &name, clock::now())
    })
    .await
}

#[tauri::command]
pub async fn division_archive(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    division_id: String,
    archived: bool,
) -> AppResult<()> {
    mutate(&state, &net, &app, |c| {
        permissions::set_division_archived(
            &mut c.db,
            &c.identity,
            &division_id,
            archived,
            clock::now(),
        )
    })
    .await
}

#[tauri::command]
pub async fn division_set_head(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    division_id: String,
    public_key: String,
    head: bool,
) -> AppResult<()> {
    mutate(&state, &net, &app, |c| {
        permissions::set_division_head(
            &mut c.db,
            &c.identity,
            &division_id,
            &public_key,
            head,
            clock::now(),
        )
    })
    .await
}

#[tauri::command]
pub async fn division_add_member(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    division_id: String,
    public_key: String,
) -> AppResult<()> {
    mutate(&state, &net, &app, |c| {
        permissions::add_division_member(
            &mut c.db,
            &c.identity,
            &division_id,
            &public_key,
            clock::now(),
        )
    })
    .await
}

#[tauri::command]
pub async fn division_remove_member(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    division_id: String,
    public_key: String,
) -> AppResult<()> {
    mutate(&state, &net, &app, |c| {
        permissions::remove_division_member(
            &mut c.db,
            &c.identity,
            &division_id,
            &public_key,
            clock::now(),
        )
    })
    .await
}

// ----- Department admins and chat settings ---------------------------------------

#[tauri::command]
pub async fn dept_set_admin(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    team_id: String,
    public_key: String,
    admin: bool,
) -> AppResult<()> {
    mutate(&state, &net, &app, |c| {
        permissions::set_dept_admin(
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

/// `division_id` none: the department channel.
#[tauri::command]
pub async fn chat_settings_set(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    team_id: String,
    division_id: Option<String>,
    pinned: String,
    announce: bool,
) -> AppResult<()> {
    mutate(&state, &net, &app, |c| {
        permissions::set_chat_settings(
            &mut c.db,
            &c.identity,
            &team_id,
            division_id.as_deref(),
            &pinned,
            announce,
            clock::now(),
        )
    })
    .await
}
