//! Tauri commands called by the frontend. Arguments arrive camelCase from JS;
//! results serialize camelCase; errors serialize as `{ code, message }`.
//!
//! Commands are `async` so Tauri runs them off the main (UI) thread. Each one
//! delegates to a plain function that tests can call without a Tauri runtime.

use serde::Serialize;
use tauri::State;

use crate::error::AppResult;
use crate::identity::{self, IdentityInfo};
use crate::org::{self, OrgInfo};
use crate::permissions::{self, Membership};
use crate::settings;
use crate::state::MiraState;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub identity: IdentityInfo,
    pub organization: Option<OrgInfo>,
    /// Tahap 1: `none`, `active` or `removed`.
    pub membership: Membership,
    pub data_dir: String,
}

pub fn app_state(state: &MiraState) -> AppResult<AppState> {
    let data_dir = state.data_dir()?.display().to_string();
    state.with_core(|core| {
        Ok(AppState {
            identity: core.identity.info(),
            organization: org::get_organization(&core.db, &core.identity)?,
            membership: permissions::membership(&core.db, &core.identity)?,
            data_dir,
        })
    })
}

pub fn display_name(state: &MiraState, name: &str) -> AppResult<IdentityInfo> {
    state.with_core(|core| {
        let info = identity::save_display_name(&mut core.db, &mut core.identity, name)?;
        // In an organization the name travels as a signed `profile_set` op.
        permissions::set_display_name_op(&mut core.db, &core.identity, crate::clock::now())?;
        Ok(info)
    })
}

pub fn organization(state: &MiraState, name: &str) -> AppResult<OrgInfo> {
    state.with_core(|core| org::create_organization(&mut core.db, &core.identity, name))
}

pub fn setting(state: &MiraState, key: &str) -> AppResult<Option<String>> {
    state.with_core(|core| settings::get(&core.db, key))
}

pub fn put_setting(state: &MiraState, key: &str, value: &str) -> AppResult<()> {
    state.with_core(|core| settings::set(&core.db, key, value))
}

#[tauri::command]
pub async fn get_app_state(state: State<'_, MiraState>) -> AppResult<AppState> {
    app_state(&state)
}

#[tauri::command]
pub async fn save_display_name(
    state: State<'_, MiraState>,
    net: State<'_, crate::net_backend::AppNet>,
    app: tauri::AppHandle,
    name: String,
) -> AppResult<IdentityInfo> {
    let info = display_name(&state, &name)?;
    crate::net_backend::after_change(&net, &app).await;
    Ok(info)
}

#[tauri::command]
pub async fn create_organization(
    state: State<'_, MiraState>,
    net: State<'_, crate::net_backend::AppNet>,
    app: tauri::AppHandle,
    name: String,
) -> AppResult<OrgInfo> {
    let info = organization(&state, &name)?;
    // v0.3: the founder's name, OS and version for the user list now.
    state.with_core(|c| {
        crate::join_commands::publish_device(c);
        Ok(())
    })?;
    crate::net_backend::after_change(&net, &app).await;
    Ok(info)
}

#[tauri::command]
pub async fn get_setting(state: State<'_, MiraState>, key: String) -> AppResult<Option<String>> {
    setting(&state, &key)
}

#[tauri::command]
pub async fn set_setting(state: State<'_, MiraState>, key: String, value: String) -> AppResult<()> {
    put_setting(&state, &key, &value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::MemoryKeyStore;

    #[test]
    fn onboarding_flow_and_json_shape() {
        let tmp = tempfile::tempdir().unwrap();
        let state = MiraState::new(
            Ok(tmp.path().to_path_buf()),
            Box::new(MemoryKeyStore::new()),
        );

        let first = app_state(&state).unwrap();
        assert_eq!(first.identity.display_name, None);
        assert_eq!(first.organization, None);
        assert_eq!(first.data_dir, tmp.path().display().to_string());

        assert_eq!(
            organization(&state, "CV Maju Jaya").unwrap_err().code(),
            "name_required"
        );
        display_name(&state, "Sari").unwrap();
        let org = organization(&state, "CV Maju Jaya").unwrap();
        assert_eq!(
            organization(&state, "Lain").unwrap_err().code(),
            "org_exists"
        );

        put_setting(&state, "theme.mode", "dark").unwrap();
        assert_eq!(
            setting(&state, "theme.mode").unwrap().as_deref(),
            Some("dark")
        );
        assert_eq!(setting(&state, "theme.name").unwrap(), None);

        let json = serde_json::to_value(app_state(&state).unwrap()).unwrap();
        assert_eq!(json["identity"]["displayName"], "Sari");
        assert_eq!(json["identity"]["publicKey"].as_str().unwrap().len(), 64);
        assert_eq!(json["identity"]["fingerprint"].as_str().unwrap().len(), 19);
        assert!(json["identity"]["createdAt"].is_string());
        assert_eq!(json["organization"]["id"], org.id);
        assert_eq!(json["organization"]["name"], "CV Maju Jaya");
        assert_eq!(json["organization"]["role"], "superadmin");
        assert!(json["organization"]["createdAt"].is_string());
        assert!(json["dataDir"].is_string());
        assert_eq!(json["membership"], "active");
    }
}
