//! v0.3 changes made on this laptop: departments, join decisions, project
//! members, labels and the device profile. Each one authors a signed op
//! through `actions::author_in`, which refuses (and stores nothing) when
//! the fold would reject it.

use rand_core::{OsRng, RngCore};
use rusqlite::{Connection, TransactionBehavior};
use time::OffsetDateTime;

use super::actions::{author_in, reason_error};
use super::fold::{AdSettings, MemberStatus, Reason};
use super::format::{is_lower_hex, validate_label_name, validate_team_name};
use super::join::{
    AD_OU_MAP_MAX_ROWS, ad_settings_allowed, is_below_ad_threshold, is_valid_ou_name, join_ad_allowed,
    parse_request_payload,
};
use super::join_store::{DeviceProfile, stored_request};
use super::op::{Body, MAX_PAYLOAD_BYTES, Scope, SignedOp};
use super::store::{load_state, not_in_org, recompute_in, require_org};
use crate::ad::OuMapping;
use crate::error::{AppError, AppResult};
use crate::identity::Identity;

/// `approve_join` refusal when the office has AD settings and the
/// requester's Mira is older than `JOIN_AD_SINCE`.
pub const REQUESTER_OUTDATED: &str = "Mira di laptop peminta terlalu lama untuk kantor yang memakai pengaturan AD. Minta peminta memperbarui Mira dulu, lalu mengirim permintaan lagi.";
/// `approve_join` refusal for a request with an AD claim while some laptop
/// of the office runs a Mira older than `JOIN_AD_SINCE`.
pub const AD_CLAIM_GATE_CLOSED: &str = "Permintaan ini membawa data AD, tapi masih ada laptop kantor dengan Mira versi lama. Perbarui Mira di laptop itu dulu, atau tolak permintaan ini dan minta peminta mengirim ulang.";
/// `set_ad_settings` refusal while some laptop runs an older Mira.
pub const AD_SETTINGS_GATE_CLOSED: &str =
    "Pengaturan AD baru bisa disimpan setelah semua laptop kantor memakai Mira versi terbaru.";
/// Room left in an op for everything but the `ad_settings_set` body: the
/// other payload fields, with `deps` at its longest, take about 2.5 KiB.
const AD_SETTINGS_MAX_BODY_BYTES: usize = MAX_PAYLOAD_BYTES - 4 * 1024;

fn random_hex16() -> String {
    let mut b = [0u8; 16];
    OsRng.fill_bytes(&mut b);
    hex::encode(b)
}

fn author(
    conn: &mut Connection,
    identity: &Identity,
    body: Body,
    now: OffsetDateTime,
) -> AppResult<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    author_in(&tx, identity, Scope::Org, body, now)?;
    tx.commit()?;
    Ok(())
}

fn check_id(id: &str, missing: Reason) -> AppResult<()> {
    if is_lower_hex(id, 32) {
        Ok(())
    } else {
        Err(reason_error(missing))
    }
}

fn check_key(pk: &str) -> AppResult<()> {
    if is_lower_hex(pk, 64) {
        Ok(())
    } else {
        Err(reason_error(Reason::TargetNotActive))
    }
}

/// Folds the stored log again and rewrites the derived tables. Run once at
/// startup: after the v9 migration the derived tables still hold the v0.2
/// fold until something changes.
pub fn recompute(conn: &mut Connection) -> AppResult<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(org) = crate::org::load_organization(&tx)? {
        recompute_in(&tx, &org)?;
    }
    tx.commit()?;
    Ok(())
}

// ----- Departments -----------------------------------------------------------

pub fn rename_department(
    conn: &mut Connection,
    identity: &Identity,
    team: &str,
    name: &str,
    now: OffsetDateTime,
) -> AppResult<()> {
    check_id(team, Reason::TeamNotFound)?;
    let name = validate_team_name(name).map_err(|_| {
        AppError::InvalidName(
            "Nama departemen harus 2 sampai 60 karakter, tanpa baris baru.".into(),
        )
    })?;
    author(
        conn,
        identity,
        Body::TeamRename {
            team: team.into(),
            name,
        },
        now,
    )
}

pub fn set_department_archived(
    conn: &mut Connection,
    identity: &Identity,
    team: &str,
    archived: bool,
    now: OffsetDateTime,
) -> AppResult<()> {
    check_id(team, Reason::TeamNotFound)?;
    author(
        conn,
        identity,
        Body::TeamArchive {
            team: team.into(),
            archived,
        },
        now,
    )
}

/// Superadmin: puts `member` in department `team` (from another
/// department or from none).
pub fn move_member(
    conn: &mut Connection,
    identity: &Identity,
    member: &str,
    team: &str,
    now: OffsetDateTime,
) -> AppResult<()> {
    check_key(member)?;
    check_id(team, Reason::TeamNotFound)?;
    author(
        conn,
        identity,
        Body::TeamMove {
            team: team.into(),
            member: member.into(),
        },
        now,
    )
}

// ----- Join decisions --------------------------------------------------------

fn decide_join(
    conn: &mut Connection,
    identity: &Identity,
    request_id: &str,
    approve: bool,
    now: OffsetDateTime,
) -> AppResult<()> {
    if !is_lower_hex(request_id, 64) {
        return Err(AppError::NotFound(
            "Permintaan bergabung tidak ditemukan.".into(),
        ));
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let req = stored_request(&tx, request_id)?.ok_or_else(|| {
        AppError::NotFound(
            "Permintaan bergabung tidak ditemukan di laptop ini. Mungkin sudah diputuskan di laptop lain."
                .into(),
        )
    })?;
    if approve
        && let (Some(state), Ok(p)) = (load_state(&tx)?, parse_request_payload(&req.payload))
    {
        // An office with AD settings has an `ad_settings_set` op in its log.
        // An older Mira refuses that op, so the new member's log would stall.
        if state.ad.set && is_below_ad_threshold(&p.app_version) {
            return Err(AppError::InvalidInput(REQUESTER_OUTDATED.into()));
        }
        // The gate may have closed since the request was stored (a laptop
        // on an older Mira joined by invite code): that laptop would refuse
        // the `join_approve` op carrying the claim.
        if p.has_ad() && !join_ad_allowed(&state) {
            return Err(AppError::InvalidInput(AD_CLAIM_GATE_CLOSED.into()));
        }
    }
    let body = if approve {
        Body::JoinApprove {
            request: req.payload,
            request_sig: req.sig,
        }
    } else {
        Body::JoinReject {
            request: req.payload,
            request_sig: req.sig,
        }
    };
    author_in(&tx, identity, Scope::Org, body, now)?;
    if approve {
        super::division::join_ad_division_in(&tx, identity, request_id, now);
    }
    tx.execute("DELETE FROM join_requests WHERE id = ?1", [request_id])?;
    tx.commit()?;
    Ok(())
}

/// Superadmin or admin of the requested department admits the requester.
pub fn approve_join(
    conn: &mut Connection,
    identity: &Identity,
    request_id: &str,
    now: OffsetDateTime,
) -> AppResult<()> {
    decide_join(conn, identity, request_id, true, now)
}

pub fn reject_join(
    conn: &mut Connection,
    identity: &Identity,
    request_id: &str,
    now: OffsetDateTime,
) -> AppResult<()> {
    decide_join(conn, identity, request_id, false, now)
}

// ----- Active Directory settings ---------------------------------------------------

/// Superadmin: saves the organization's AD domain (empty clears it) and the
/// OU to department mapping as one `ad_settings_set` op. The domain is
/// normalized first (`Kantor.CO.ID.` becomes `kantor.co.id`) and OU names
/// are trimmed. Refused until every active member runs a Mira that
/// understands the op ([`ad_settings_allowed`]). Saving what the log
/// already holds writes nothing.
pub fn set_ad_settings(
    conn: &mut Connection,
    identity: &Identity,
    domain: &str,
    ou_map: Vec<OuMapping>,
    now: OffsetDateTime,
) -> AppResult<()> {
    let domain = match domain.trim() {
        "" => String::new(),
        d => crate::ad::dn::normalize_domain(d).ok_or_else(|| {
            AppError::InvalidInput("Domain tidak valid. Contoh: kantor.co.id".into())
        })?,
    };
    let ou_map = clean_ou_map(ou_map)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let state = load_state(&tx)?.ok_or_else(not_in_org)?;
    if !state.is_superadmin(identity.public_key_hex()) {
        return Err(reason_error(Reason::NotAuthorized));
    }
    if !ad_settings_allowed(&state) {
        return Err(AppError::InvalidInput(AD_SETTINGS_GATE_CLOSED.into()));
    }
    if let Some(row) = ou_map.iter().find(|r| state.live_team(&r.team).is_none()) {
        return Err(AppError::NotFound(format!(
            "Departemen untuk OU \"{}\" tidak ditemukan atau sudah dihapus.",
            row.ou
        )));
    }
    super::division::check_ou_map_divisions(&state, &ou_map)?;
    let next = AdSettings {
        domain: (!domain.is_empty()).then(|| domain.clone()),
        ou_map: ou_map.clone(),
        set: true,
    };
    if state.ad == next {
        return Ok(());
    }
    let body = Body::AdSettingsSet { domain, ou_map };
    let size = serde_json::to_string(&body).map_or(usize::MAX, |s| s.len());
    if size > AD_SETTINGS_MAX_BODY_BYTES {
        return Err(AppError::InvalidInput(
            "Pemetaan OU terlalu panjang untuk disimpan. Kurangi barisnya atau singkat nama OU-nya."
                .into(),
        ));
    }
    author_in(&tx, identity, Scope::Org, body, now)?;
    tx.commit()?;
    Ok(())
}

/// OU names trimmed and checked, with messages the superadmin can act on.
fn clean_ou_map(map: Vec<OuMapping>) -> AppResult<Vec<OuMapping>> {
    if map.len() > AD_OU_MAP_MAX_ROWS {
        return Err(AppError::InvalidInput(
            "Pemetaan OU paling banyak 100 baris.".into(),
        ));
    }
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(map.len());
    for row in map {
        let ou = row.ou.trim().to_owned();
        if !is_valid_ou_name(&ou) {
            return Err(AppError::InvalidInput(
                "Nama OU harus 1 sampai 64 karakter, tanpa baris baru, tab, atau karakter tak terlihat."
                    .into(),
            ));
        }
        check_id(&row.team, Reason::TeamNotFound)?;
        if !seen.insert(ou.to_lowercase()) {
            return Err(AppError::InvalidInput(format!(
                "OU \"{ou}\" tercantum lebih dari sekali. Satu OU hanya bisa dipetakan ke satu departemen."
            )));
        }
        if let Some(division) = &row.division {
            check_id(division, Reason::DivisionNotFound)?;
        }
        out.push(OuMapping {
            ou,
            team: row.team,
            division: row.division,
        });
    }
    Ok(out)
}

// ----- Projects ----------------------------------------------------------------

/// Registers a board project this laptop just created (`project_create`
/// with this laptop as creator, plus the initial members). Returns `false`
/// and does nothing when this laptop has no organization or is not an
/// active non-guest member (a board kept only on this laptop). A project
/// for `division` (v0.6) waits for the division gate.
#[allow(clippy::too_many_arguments)]
pub(crate) fn register_own_project_in(
    conn: &Connection,
    identity: &Identity,
    project: &str,
    team: Option<&str>,
    nonce: &str,
    members: &[String],
    division: Option<&str>,
    now: OffsetDateTime,
) -> AppResult<bool> {
    let Some(state) = load_state(conn)? else {
        return Ok(false);
    };
    let me = identity.public_key_hex();
    if !state.is_active_non_guest(me) {
        return Ok(false);
    }
    if division.is_some() && !super::division::division_gate_open(&state) {
        return Err(AppError::InvalidInput(
            super::division::DIVISION_GATE_CLOSED.into(),
        ));
    }
    let mut members: Vec<String> = members
        .iter()
        .filter(|pk| pk.as_str() != me)
        .cloned()
        .collect();
    for pk in &members {
        check_key(pk)?;
    }
    members.sort();
    members.dedup();
    author_in(
        conn,
        identity,
        Scope::Org,
        Body::ProjectCreate {
            project: project.to_owned(),
            team: team.map(str::to_owned),
            creator: me.to_owned(),
            nonce: nonce.to_owned(),
            members,
            division: division.map(str::to_owned),
        },
        now,
    )?;
    Ok(true)
}

/// Registers a project made before v0.3 (`creator` is the board's creator).
/// Used by `board::membership::register_legacy_projects`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn register_project_for_in(
    conn: &Connection,
    identity: &Identity,
    project: &str,
    team: Option<&str>,
    creator: &str,
    nonce: &str,
    mut members: Vec<String>,
    now: OffsetDateTime,
) -> AppResult<()> {
    members.retain(|pk| pk != creator);
    members.sort();
    members.dedup();
    members.truncate(super::op::MAX_PROJECT_INITIAL_MEMBERS);
    author_in(
        conn,
        identity,
        Scope::Org,
        Body::ProjectCreate {
            project: project.to_owned(),
            team: team.map(str::to_owned),
            creator: creator.to_owned(),
            nonce: nonce.to_owned(),
            members,
            division: None,
        },
        now,
    )?;
    Ok(())
}

pub fn add_project_member(
    conn: &mut Connection,
    identity: &Identity,
    project: &str,
    member: &str,
    now: OffsetDateTime,
) -> AppResult<()> {
    check_id(project, Reason::ProjectNotFound)?;
    check_key(member)?;
    author(
        conn,
        identity,
        Body::ProjectMemberAdd {
            project: project.into(),
            member: member.into(),
        },
        now,
    )
}

/// Removes a member or a guest from the project (also "leave the project"
/// when `member` is this laptop).
pub fn remove_project_member(
    conn: &mut Connection,
    identity: &Identity,
    project: &str,
    member: &str,
    now: OffsetDateTime,
) -> AppResult<()> {
    check_id(project, Reason::ProjectNotFound)?;
    check_key(member)?;
    author(
        conn,
        identity,
        Body::ProjectMemberRemove {
            project: project.into(),
            member: member.into(),
        },
        now,
    )
}

// ----- Labels --------------------------------------------------------------------

/// Superadmin: new label; returns its id.
pub fn create_label(
    conn: &mut Connection,
    identity: &Identity,
    name: &str,
    now: OffsetDateTime,
) -> AppResult<String> {
    let name = validate_label_name(name)?;
    let label = random_hex16();
    author(
        conn,
        identity,
        Body::LabelCreate {
            label: label.clone(),
            name,
        },
        now,
    )?;
    Ok(label)
}

pub fn rename_label(
    conn: &mut Connection,
    identity: &Identity,
    label: &str,
    name: &str,
    now: OffsetDateTime,
) -> AppResult<()> {
    check_id(label, Reason::LabelNotFound)?;
    let name = validate_label_name(name)?;
    author(
        conn,
        identity,
        Body::LabelRename {
            label: label.into(),
            name,
        },
        now,
    )
}

pub fn set_label_archived(
    conn: &mut Connection,
    identity: &Identity,
    label: &str,
    archived: bool,
    now: OffsetDateTime,
) -> AppResult<()> {
    check_id(label, Reason::LabelNotFound)?;
    author(
        conn,
        identity,
        Body::LabelArchive {
            label: label.into(),
            archived,
        },
        now,
    )
}

pub fn assign_label(
    conn: &mut Connection,
    identity: &Identity,
    label: &str,
    member: &str,
    assigned: bool,
    now: OffsetDateTime,
) -> AppResult<()> {
    check_id(label, Reason::LabelNotFound)?;
    check_key(member)?;
    let (label, member) = (label.to_owned(), member.to_owned());
    let body = if assigned {
        Body::LabelAssign { label, member }
    } else {
        Body::LabelUnassign { label, member }
    };
    author(conn, identity, body, now)
}

// ----- Device profile ------------------------------------------------------------

/// Publishes this laptop's name, OS and Mira version when they differ from
/// what the log holds (so restarts do not add ops). Does nothing without
/// an organization or when this laptop is not an active member.
pub fn ensure_device_op(
    conn: &mut Connection,
    identity: &Identity,
    device: &DeviceProfile,
    now: OffsetDateTime,
) -> AppResult<Option<SignedOp>> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let Some(state) = load_state(&tx)? else {
        return Ok(None);
    };
    let Some(m) = state
        .member(identity.public_key_hex())
        .filter(|m| m.status == MemberStatus::Active)
    else {
        return Ok(None);
    };
    let same = m.device.as_ref().is_some_and(|d| {
        d.laptop == device.laptop && d.os == device.os && d.app_version == device.app_version
    });
    if same {
        return Ok(None);
    }
    let op = author_in(
        &tx,
        identity,
        Scope::Org,
        Body::DeviceSet {
            laptop: device.laptop.clone(),
            os: device.os.clone(),
            app_version: device.app_version.clone(),
        },
        now,
    )?;
    tx.commit()?;
    Ok(Some(op))
}

/// Used by tests and by `board` to read who is in a project now.
pub fn require_state(conn: &Connection) -> AppResult<super::fold::OrgState> {
    require_org(conn)?;
    load_state(conn)?.ok_or_else(not_in_org)
}
