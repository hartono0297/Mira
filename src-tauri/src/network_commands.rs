//! Tauri commands for the network status, addresses and Windows Firewall
//! (Tahap 1, docs/plans/tahap-1.md section 4).

use std::collections::HashMap;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::clock;
use crate::error::{AppError, AppResult};
use crate::firewall::{self, FirewallStatus};
use crate::identity;
use crate::net_backend::{self, AppNet};
use crate::network::{NetState, Route};
use crate::org::Role;
use crate::peers::{self, ManualAddress};
use crate::permissions::{self, Membership};
use crate::qr;
use crate::state::MiraState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MdnsView {
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerView {
    pub public_key: String,
    pub display_name: String,
    pub fingerprint: String,
    pub org_role: Role,
    pub online: bool,
    pub route: Option<Route>,
    pub address: Option<String>,
    pub last_seen_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkStatus {
    pub state: NetState,
    pub listen_port: Option<u16>,
    pub local_addresses: Vec<String>,
    pub share_link: String,
    pub qr_svg: String,
    pub mdns: MdnsView,
    pub peers: Vec<PeerView>,
    pub manual_addresses: Vec<ManualAddress>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirewallRequest {
    pub started: bool,
}

#[tauri::command]
pub async fn get_network_status(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
) -> AppResult<NetworkStatus> {
    let network = net.get(&state, &app).await?;
    let snap = network.status();
    let online: HashMap<&str, _> = snap
        .peers
        .iter()
        .map(|p| (p.public_key.as_str(), p))
        .collect();
    let now = clock::now();

    let (membership, me, peers, manual) = state.with_core(|c| {
        let membership = permissions::membership(&c.db, &c.identity)?;
        let me = c.identity.public_key_hex().to_owned();
        let mut views = Vec::new();
        if let Some(org_state) = permissions::load_state(&c.db)? {
            for (pk, m) in &org_state.members {
                if pk == &me || !org_state.is_active(pk) {
                    continue;
                }
                let conn = online.get(pk.as_str());
                if conn.is_some() {
                    peers::mark_seen(&c.db, pk, now)?;
                }
                views.push(PeerView {
                    public_key: pk.clone(),
                    display_name: m
                        .display_name
                        .clone()
                        .unwrap_or_else(|| identity::fingerprint(pk)),
                    fingerprint: identity::fingerprint(pk),
                    org_role: org_state.org_role(pk),
                    online: conn.is_some(),
                    route: conn.map(|p| p.route),
                    address: conn.map(|p| p.address.to_string()),
                    last_seen_at: peers::last_seen(&c.db, pk)?,
                });
            }
        }
        // Online first, then by name.
        views.sort_by(|a, b| {
            b.online.cmp(&a.online).then_with(|| {
                a.display_name
                    .to_lowercase()
                    .cmp(&b.display_name.to_lowercase())
            })
        });
        Ok((membership, me, views, peers::manual_addresses(&c.db)?))
    })?;

    let state_view = match membership {
        Membership::Removed => NetState::Removed,
        Membership::Suspended => NetState::Suspended,
        _ => snap.state,
    };
    let share_link = if snap.listen_port.is_some() {
        qr::share_link(&me, &snap.local_addresses)
    } else {
        String::new()
    };
    let qr_svg = if share_link.is_empty() {
        String::new()
    } else {
        qr::qr_svg(&share_link)
    };
    Ok(NetworkStatus {
        state: state_view,
        listen_port: snap.listen_port,
        local_addresses: snap.local_addresses.iter().map(|a| a.to_string()).collect(),
        share_link,
        qr_svg,
        mdns: MdnsView {
            ok: snap.mdns_ok,
            error: snap.mdns_error,
        },
        peers,
        manual_addresses: manual,
    })
}

#[tauri::command]
pub async fn add_manual_address(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    address: String,
) -> AppResult<ManualAddress> {
    let added = state.with_core(|c| peers::add_manual(&c.db, &address, clock::now()))?;
    let first = added.into_iter().next().ok_or_else(|| {
        AppError::InvalidAddress("Tautan itu tidak berisi alamat laptop rekan.".into())
    })?;
    net_backend::after_change(&net, &app).await;
    Ok(first)
}

#[tauri::command]
pub async fn remove_manual_address(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    address: String,
) -> AppResult<()> {
    state.with_core(|c| peers::remove_manual(&c.db, &address))?;
    net_backend::after_change(&net, &app).await;
    Ok(())
}

fn program_path() -> AppResult<std::path::PathBuf> {
    std::env::current_exe().map_err(|e| {
        AppError::Internal(format!(
            "Lokasi program Mira tidak bisa dibaca. Detail: {e}"
        ))
    })
}

#[tauri::command]
pub async fn get_firewall_status() -> AppResult<FirewallStatus> {
    let program = program_path()?;
    tauri::async_runtime::spawn_blocking(move || firewall::status(&program))
        .await
        .map_err(|e| AppError::Internal(format!("Pemeriksaan firewall berhenti. Detail: {e}")))
}

/// Starts the elevated rule setup; Windows asks for administrator approval.
#[tauri::command]
pub async fn request_firewall_rule() -> AppResult<FirewallRequest> {
    let program = program_path()?;
    let started = tauri::async_runtime::spawn_blocking(move || firewall::request_rule(&program))
        .await
        .map_err(|e| AppError::Internal(format!("Pengaturan firewall berhenti. Detail: {e}")))??;
    Ok(FirewallRequest { started })
}

/// 0.5.1: result of "Periksa lagi" on the suspended screen.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MembershipCheck {
    pub membership: Membership,
    /// RFC 3339, when the check finished.
    pub checked_at: String,
    /// Office laptops this laptop synced with during the check.
    pub peers_reached: u32,
}

/// Longest "Periksa lagi" check.
pub const CHECK_MEMBERSHIP_LIMIT: std::time::Duration = std::time::Duration::from_secs(4);

/// Syncs the membership log with every reachable office laptop (dialing
/// the ones that are not connected, waits at most
/// [`CHECK_MEMBERSHIP_LIMIT`]), then reports this laptop's membership. A
/// suspended laptop syncs org-scope ops only (decision 6).
#[tauri::command]
pub async fn check_membership(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
) -> AppResult<MembershipCheck> {
    let network = net.get(&state, &app).await?;
    let reached = network.check_membership(CHECK_MEMBERSHIP_LIMIT).await;
    membership_check(&state, reached)
}

/// The command's answer once the sync is done.
pub(crate) fn membership_check(state: &MiraState, reached: usize) -> AppResult<MembershipCheck> {
    let membership = state.with_core(|c| permissions::membership(&c.db, &c.identity))?;
    Ok(MembershipCheck {
        membership,
        checked_at: permissions::format::format_time(clock::now()),
        peers_reached: u32::try_from(reached).unwrap_or(u32::MAX),
    })
}
