//! v0.3 changes made on this laptop: departments, join decisions, project
//! members, labels and the device profile. Each one authors a signed op
//! through `actions::author_in`, which refuses (and stores nothing) when
//! the fold would reject it.

use rand_core::{OsRng, RngCore};
use rusqlite::{Connection, TransactionBehavior};
use time::OffsetDateTime;

use super::actions::{author_in, reason_error};
use super::fold::{MemberStatus, Reason};
use super::format::{is_lower_hex, validate_label_name, validate_team_name};
use super::join_store::{DeviceProfile, stored_request};
use super::op::{Body, Scope, SignedOp};
use super::store::{load_state, not_in_org, recompute_in, require_org};
use crate::error::{AppError, AppResult};
use crate::identity::Identity;

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

// ----- Projects ----------------------------------------------------------------

/// Registers a board project this laptop just created (`project_create`
/// with this laptop as creator, plus the initial members). Returns `false`
/// and does nothing when this laptop has no organization or is not an
/// active non-guest member (a board kept only on this laptop).
pub(crate) fn register_own_project_in(
    conn: &Connection,
    identity: &Identity,
    project: &str,
    team: Option<&str>,
    nonce: &str,
    members: &[String],
    now: OffsetDateTime,
) -> AppResult<bool> {
    let Some(state) = load_state(conn)? else {
        return Ok(false);
    };
    let me = identity.public_key_hex();
    if !state.is_active_non_guest(me) {
        return Ok(false);
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
