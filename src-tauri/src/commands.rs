//! Tauri commands called by the frontend. Arguments arrive camelCase from JS;
//! results serialize camelCase; errors serialize as `{ code, message }`.
//!
//! Commands are `async` so Tauri runs them off the main (UI) thread. Each one
//! delegates to a plain function that tests can call without a Tauri runtime.

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::identity::{self, IdentityInfo};
use crate::join_commands::JoinClient;
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

/// `create_organization` with the AD domain (onboarding-ad): `ad_domain`
/// empty or `None` means none. A bad domain is refused before anything is
/// written. One domain, one office: refused when `client` knows a verified
/// office whose AD domain is `machine_domain` (this computer's) or the one
/// typed. After the organization is made, the founder's device profile is
/// published first (the version gate of `ad_settings_set` reads it), then
/// the domain is written as an `ad_settings_set` op. A failure there only
/// logs: the office exists and the superadmin can set the domain later in
/// Organisasi. (docs/plans/onboarding-ad.md section 6 item 2.)
pub fn organization_with_ad(
    state: &MiraState,
    client: &JoinClient,
    name: &str,
    ad_domain: Option<&str>,
    machine_domain: Option<&str>,
) -> AppResult<OrgInfo> {
    let domain = match ad_domain.map(str::trim).filter(|d| !d.is_empty()) {
        None => None,
        Some(d) => Some(crate::ad::dn::normalize_domain(d).ok_or_else(|| {
            AppError::InvalidInput("Domain tidak valid. Contoh: kantor.co.id".into())
        })?),
    };
    let mine: Vec<&str> = machine_domain.into_iter().chain(domain.as_deref()).collect();
    if let Some((office, d)) = client.office_with_ad_domain(&mine) {
        return Err(AppError::InvalidInput(format!(
            "Kantor \"{office}\" sudah memakai domain AD {d} di jaringan ini. Satu domain cukup satu kantor Mira, jadi kantor baru tidak dibuat. Bergabunglah ke kantor itu dengan mengirim permintaan bergabung."
        )));
    }
    let info = organization(state, name)?;
    state.with_core(|c| {
        // v0.3: the founder's name, OS and version for the user list now.
        crate::join_commands::publish_device(c);
        if let Some(d) = &domain
            && let Err(e) =
                permissions::set_ad_settings(&mut c.db, &c.identity, d, vec![], crate::clock::now())
        {
            eprintln!("Mira: domain AD kantor belum tersimpan [{}]: {e}", e.code());
        }
        Ok(())
    })?;
    Ok(info)
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
    client: State<'_, JoinClient>,
    app: tauri::AppHandle,
    name: String,
    ad_domain: Option<String>,
) -> AppResult<OrgInfo> {
    let machine = crate::ad::machine_domain();
    let info = organization_with_ad(
        &state,
        &client,
        &name,
        ad_domain.as_deref(),
        machine.as_deref(),
    )?;
    crate::net_backend::after_change(&net, &app).await;
    Ok(info)
}

/// `machine_ad_domain`: the AD domain this computer is joined to, `null`
/// for none (macOS, a computer without a domain).
#[tauri::command]
pub async fn machine_ad_domain() -> Option<String> {
    crate::ad::machine_domain()
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

    fn named_state(tmp: &tempfile::TempDir) -> MiraState {
        let state = MiraState::new(
            Ok(tmp.path().to_path_buf()),
            Box::new(MemoryKeyStore::new()),
        );
        display_name(&state, "Sari").unwrap();
        state
    }

    fn ad_domain_in_log(state: &MiraState) -> (Option<String>, bool) {
        state
            .with_core(|c| {
                let st = permissions::load_state(&c.db)?.unwrap();
                Ok((st.ad.domain.clone(), st.ad.set))
            })
            .unwrap()
    }

    #[test]
    fn create_organization_writes_the_ad_domain() {
        let tmp = tempfile::tempdir().unwrap();
        let state = named_state(&tmp);
        let client = JoinClient::default();
        let err = organization_with_ad(&state, &client, "MCF", Some("bukan domain"), None)
            .unwrap_err();
        assert_eq!(err.code(), "invalid_input");
        assert_eq!(err.to_string(), "Domain tidak valid. Contoh: kantor.co.id");
        assert_eq!(
            app_state(&state).unwrap().organization,
            None,
            "nothing made before the domain is checked"
        );

        let org =
            organization_with_ad(&state, &client, "MCF", Some(" MACF.co.id. "), None).unwrap();
        assert_eq!(org.name, "MCF");
        assert_eq!(ad_domain_in_log(&state), (Some("macf.co.id".into()), true));
    }

    #[test]
    fn create_organization_without_a_domain_writes_no_ad_settings() {
        let tmp = tempfile::tempdir().unwrap();
        let state = named_state(&tmp);
        let client = JoinClient::default();
        organization_with_ad(&state, &client, "MCF", Some("  "), Some("macf.co.id")).unwrap();
        assert_eq!(ad_domain_in_log(&state), (None, false));
    }

    #[test]
    fn create_organization_refuses_a_second_office_for_a_domain() {
        use crate::network::JOIN_INFO_EXTRAS_AD;
        let tmp = tempfile::tempdir().unwrap();
        let state = named_state(&tmp);
        let client = JoinClient::default();
        client.add_test_office(
            crate::join_commands::test_genesis(9, "MCF Pusat", "2026-01-05T08:00:00Z"),
            JOIN_INFO_EXTRAS_AD,
            Some("macf.co.id"),
        );
        // This computer is in that domain.
        let err = organization_with_ad(&state, &client, "MCF 2", None, Some("MACF.co.id"))
            .unwrap_err();
        assert_eq!(err.code(), "invalid_input");
        assert_eq!(
            err.to_string(),
            "Kantor \"MCF Pusat\" sudah memakai domain AD macf.co.id di jaringan ini. Satu domain cukup satu kantor Mira, jadi kantor baru tidak dibuat. Bergabunglah ke kantor itu dengan mengirim permintaan bergabung."
        );
        // The domain typed for the new office is that domain.
        let err = organization_with_ad(&state, &client, "MCF 2", Some("macf.co.id"), None)
            .unwrap_err();
        assert_eq!(err.code(), "invalid_input");
        assert_eq!(app_state(&state).unwrap().organization, None);

        // Another domain is fine.
        organization_with_ad(
            &state,
            &client,
            "Lain",
            Some("lain.co.id"),
            Some("lain.co.id"),
        )
        .unwrap();
        assert_eq!(ad_domain_in_log(&state), (Some("lain.co.id".into()), true));
    }
}
