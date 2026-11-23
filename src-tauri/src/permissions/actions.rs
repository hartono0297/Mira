//! Changes made on this laptop: authoring ops, team and member management,
//! invites, and both sides of joining with a code.

use rand_core::{OsRng, RngCore};
use rusqlite::{Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use super::causal::heads;
use super::fold::{MemberKind, MemberStatus, OrgState, Reason, fold};
use super::format::{
    channel_name_for, format_time, is_canonical_display_name, is_lower_hex, validate_team_name,
};
use super::invite::{
    JoinProofData, NormalizedCode, build_join_proof, invite_key_message, invite_public_key,
    redeem_message, sign_invite_key,
};
use super::op::{Body, InviteRole, OP_VERSION, Payload, Scope, SignedOp, sign_payload, verify_op};
use super::store::{
    ingest_in, insert_op, load_ops, load_state, max_lamport, op_ids_for, ops_for, require_org,
    store_fold,
};
use super::view::{InviteView, TeamView, Validity, invite_view, team_view};
use crate::error::{AppError, AppResult};
use crate::identity::{self, Identity};
use crate::org::{self, OrgInfo, Organization};

fn random_hex16() -> String {
    let mut b = [0u8; 16];
    OsRng.fill_bytes(&mut b);
    hex::encode(b)
}

pub(crate) fn reason_error(reason: Reason) -> AppError {
    match reason {
        Reason::LastSuperadmin => AppError::LastSuperadmin,
        Reason::TeamNotFound
        | Reason::TargetNotActive
        | Reason::InviteNotFound
        | Reason::ProjectNotFound
        | Reason::LabelNotFound => AppError::NotFound(reason.message().into()),
        Reason::InviteExpired | Reason::InviteNotYetValid => AppError::InviteExpired,
        Reason::InviteUsed => AppError::InviteUsed,
        Reason::InviteRevoked | Reason::InviterNotAuthorized => AppError::InviteRevoked,
        _ => AppError::Forbidden(reason.message().into()),
    }
}

fn state_in(conn: &Connection, org: &Organization) -> AppResult<OrgState> {
    Ok(fold(org, &load_ops(conn)?).state)
}

/// Signs a new op as this laptop and stores it, but only if it would be
/// applied on the current state. Otherwise nothing is stored and the reason
/// comes back as `forbidden`, `not_found`, `last_superadmin` or `removed`.
pub fn author_op(
    conn: &mut Connection,
    identity: &Identity,
    scope: Scope,
    body: Body,
    now: OffsetDateTime,
) -> AppResult<SignedOp> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let op = author_in(&tx, identity, scope, body, now)?;
    tx.commit()?;
    Ok(op)
}

/// `author_op` inside the caller's transaction.
pub(crate) fn author_in(
    conn: &Connection,
    identity: &Identity,
    scope: Scope,
    body: Body,
    now: OffsetDateTime,
) -> AppResult<SignedOp> {
    let org = require_org(conn)?;
    let mut ops = load_ops(conn)?;
    let state = fold(&org, &ops).state;
    let me = identity.public_key_hex();
    match state.member(me).map(|m| m.status) {
        Some(MemberStatus::Active) => {}
        Some(MemberStatus::Removed) => return Err(AppError::Removed),
        None => {
            return Err(AppError::Forbidden(
                "Laptop ini belum menjadi anggota organisasi.".into(),
            ));
        }
    }
    let payload = Payload {
        v: OP_VERSION,
        org: org.id.clone(),
        author: me.to_owned(),
        lamport: max_lamport(conn)? + 1,
        deps: heads(&ops),
        at: format_time(now),
        nonce: random_hex16(),
        scope,
        body,
    };
    let signed = sign_payload(&payload, |m| identity.sign(m));
    let verified = verify_op(&signed, &org.id, now).map_err(|r| {
        AppError::Internal(format!(
            "Perubahan tidak bisa dibuat karena isinya tidak valid ({}: {}).",
            r.code, r.detail
        ))
    })?;
    // The new op sorts last, but as a revocation it can still reject
    // earlier ops it has not seen, so fold everything again.
    let id = verified.id.clone();
    ops.push(verified.clone());
    let result = fold(&org, &ops);
    let outcome = result
        .outcomes
        .iter()
        .find(|(i, _)| *i == id)
        .map_or(Err(Reason::NotAuthorized), |(_, o)| *o);
    outcome.map_err(reason_error)?;
    insert_op(conn, &verified, None, now)?;
    store_fold(conn, &result)?;
    Ok(signed)
}

/// Creates the founder's (or any member's) first `profile_set` if this
/// laptop is an active member with a display name and no profile op yet.
/// Works for Tahap 0 organizations; call at startup.
pub fn ensure_profile_op(
    conn: &mut Connection,
    identity: &Identity,
    now: OffsetDateTime,
) -> AppResult<Option<SignedOp>> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let op = ensure_profile_in(&tx, identity, now)?;
    tx.commit()?;
    Ok(op)
}

pub(crate) fn ensure_profile_in(
    conn: &Connection,
    identity: &Identity,
    now: OffsetDateTime,
) -> AppResult<Option<SignedOp>> {
    profile_if(conn, identity, now, |m_name, has_profile, name| {
        !has_profile && m_name != Some(name)
    })
}

/// After the display name changed: signs a `profile_set` when this laptop
/// is an active member and the log has a different name.
pub fn set_display_name_op(
    conn: &mut Connection,
    identity: &Identity,
    now: OffsetDateTime,
) -> AppResult<Option<SignedOp>> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let op = profile_if(&tx, identity, now, |m_name, _, name| m_name != Some(name))?;
    tx.commit()?;
    Ok(op)
}

fn profile_if(
    conn: &Connection,
    identity: &Identity,
    now: OffsetDateTime,
    needed: impl FnOnce(Option<&str>, bool, &str) -> bool,
) -> AppResult<Option<SignedOp>> {
    let Some(name) = identity.display_name() else {
        return Ok(None);
    };
    let Some(state) = load_state(conn)? else {
        return Ok(None);
    };
    let Some(m) = state
        .member(identity.public_key_hex())
        .filter(|m| m.status == MemberStatus::Active)
    else {
        return Ok(None);
    };
    if !needed(m.display_name.as_deref(), m.has_profile, name) {
        return Ok(None);
    }
    author_in(
        conn,
        identity,
        Scope::Org,
        Body::ProfileSet {
            name: name.to_owned(),
        },
        now,
    )
    .map(Some)
}

fn check_team_id(id: &str) -> AppResult<()> {
    if is_lower_hex(id, 32) {
        Ok(())
    } else {
        Err(AppError::NotFound(Reason::TeamNotFound.message().into()))
    }
}

fn check_member_key(pk: &str) -> AppResult<()> {
    if is_lower_hex(pk, 64) {
        Ok(())
    } else {
        Err(AppError::NotFound(Reason::TargetNotActive.message().into()))
    }
}

fn author_one(
    conn: &mut Connection,
    identity: &Identity,
    body: Body,
    now: OffsetDateTime,
) -> AppResult<()> {
    author_op(conn, identity, Scope::Org, body, now).map(|_| ())
}

/// Superadmin: new team plus its team channel (name in lowercase, spaces as `-`).
pub fn create_team(
    conn: &mut Connection,
    identity: &Identity,
    name: &str,
    now: OffsetDateTime,
) -> AppResult<TeamView> {
    let name = validate_team_name(name)?;
    let team = random_hex16();
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    author_in(
        &tx,
        identity,
        Scope::Org,
        Body::TeamCreate {
            team: team.clone(),
            name: name.clone(),
        },
        now,
    )?;
    author_in(
        &tx,
        identity,
        Scope::Team { team: team.clone() },
        Body::ChannelCreate {
            channel: random_hex16(),
            team: team.clone(),
            name: channel_name_for(&name),
        },
        now,
    )?;
    let state = load_state(&tx)?.ok_or_else(super::store::not_in_org)?;
    tx.commit()?;
    state
        .live_team(&team)
        .map(team_view)
        .ok_or_else(|| AppError::Internal("Tim baru tidak ditemukan setelah dibuat.".into()))
}

pub fn delete_team(
    conn: &mut Connection,
    identity: &Identity,
    team: &str,
    now: OffsetDateTime,
) -> AppResult<()> {
    check_team_id(team)?;
    author_one(conn, identity, Body::TeamDelete { team: team.into() }, now)
}

pub fn add_team_member(
    conn: &mut Connection,
    identity: &Identity,
    team: &str,
    member: &str,
    now: OffsetDateTime,
) -> AppResult<()> {
    check_team_id(team)?;
    check_member_key(member)?;
    let body = Body::TeamMemberAdd {
        team: team.into(),
        member: member.into(),
    };
    author_one(conn, identity, body, now)
}

pub fn remove_team_member(
    conn: &mut Connection,
    identity: &Identity,
    team: &str,
    member: &str,
    now: OffsetDateTime,
) -> AppResult<()> {
    check_team_id(team)?;
    check_member_key(member)?;
    let body = Body::TeamMemberRemove {
        team: team.into(),
        member: member.into(),
    };
    author_one(conn, identity, body, now)
}

pub fn set_team_admin(
    conn: &mut Connection,
    identity: &Identity,
    team: &str,
    member: &str,
    admin: bool,
    now: OffsetDateTime,
) -> AppResult<()> {
    check_team_id(team)?;
    check_member_key(member)?;
    let (team, member) = (team.to_owned(), member.to_owned());
    let body = if admin {
        Body::TeamAdminSet { team, member }
    } else {
        Body::TeamAdminUnset { team, member }
    };
    author_one(conn, identity, body, now)
}

pub fn add_superadmin(
    conn: &mut Connection,
    identity: &Identity,
    member: &str,
    now: OffsetDateTime,
) -> AppResult<()> {
    check_member_key(member)?;
    let body = Body::SuperadminAdd {
        member: member.into(),
    };
    author_one(conn, identity, body, now)
}

pub fn remove_superadmin(
    conn: &mut Connection,
    identity: &Identity,
    member: &str,
    now: OffsetDateTime,
) -> AppResult<()> {
    check_member_key(member)?;
    let body = Body::SuperadminRemove {
        member: member.into(),
    };
    author_one(conn, identity, body, now)
}

pub fn remove_member(
    conn: &mut Connection,
    identity: &Identity,
    member: &str,
    now: OffsetDateTime,
) -> AppResult<()> {
    check_member_key(member)?;
    let body = Body::MemberRemove {
        member: member.into(),
    };
    author_one(conn, identity, body, now)
}

/// Creates an invite; returns its view and the code (shown once, never stored).
pub fn create_invite(
    conn: &mut Connection,
    identity: &Identity,
    team: &str,
    role: InviteRole,
    projects: Vec<String>,
    validity: Validity,
    now: OffsetDateTime,
) -> AppResult<(InviteView, String)> {
    check_team_id(team)?;
    let code = super::invite::generate_invite_code();
    let normalized = super::invite::normalize_code(&code)?;
    let invite = random_hex16();
    let at = format_time(now);
    let expires = super::format::parse_time(&at)
        .map(|t| format_time(t + validity.duration()))
        .ok_or_else(|| AppError::Internal("Waktu laptop tidak valid.".into()))?;
    if role == InviteRole::Guest && projects.is_empty() {
        return Err(AppError::Forbidden(
            "Undangan Tamu harus memilih minimal satu proyek.".into(),
        ));
    }
    if role != InviteRole::Guest && !projects.is_empty() {
        return Err(AppError::Forbidden(
            "Proyek hanya bisa dipilih untuk undangan Tamu.".into(),
        ));
    }
    if projects.len() > super::op::MAX_GUEST_PROJECTS
        || projects.iter().any(|p| !is_lower_hex(p, 32))
    {
        return Err(AppError::NotFound("Proyek tidak ditemukan.".into()));
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let org = require_org(&tx)?;
    let tag = normalized.tag().to_owned();
    let key_sig = sign_invite_key(
        &normalized,
        &invite_key_message(
            &org.id,
            &org.founder_public_key,
            identity.public_key_hex(),
            &invite,
            team,
            role,
            &projects,
            &expires,
            validity.single_use(),
            &tag,
        ),
    );
    author_in(
        &tx,
        identity,
        Scope::Org,
        Body::InviteCreate {
            invite: invite.clone(),
            team: team.into(),
            role,
            projects,
            expires,
            single_use: validity.single_use(),
            tag,
            key: invite_public_key(&normalized),
            key_sig,
        },
        now,
    )?;
    let state = load_state(&tx)?.ok_or_else(super::store::not_in_org)?;
    tx.commit()?;
    let view = state
        .invites
        .get(&invite)
        .map(|i| invite_view(&state, i, now))
        .ok_or_else(|| AppError::Internal("Undangan baru tidak ditemukan.".into()))?;
    Ok((view, code))
}

pub fn revoke_invite(
    conn: &mut Connection,
    identity: &Identity,
    invite: &str,
    now: OffsetDateTime,
) -> AppResult<()> {
    if !is_lower_hex(invite, 32) {
        return Err(AppError::NotFound(Reason::InviteNotFound.message().into()));
    }
    let body = Body::InviteRevoke {
        invite: invite.into(),
    };
    author_one(conn, identity, body, now)
}

/// Why a join attempt was refused; `code()` matches plan 2.4.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JoinRejectCode {
    InviteNotFound,
    InviteExpired,
    InviteUsed,
    InviteRevoked,
    InvalidProof,
    Removed,
    Internal,
}

impl JoinRejectCode {
    pub fn code(self) -> &'static str {
        match self {
            JoinRejectCode::InviteNotFound => "invite_not_found",
            JoinRejectCode::InviteExpired => "invite_expired",
            JoinRejectCode::InviteUsed => "invite_used",
            JoinRejectCode::InviteRevoked => "invite_revoked",
            JoinRejectCode::InvalidProof => "invalid_proof",
            JoinRejectCode::Removed => "removed",
            JoinRejectCode::Internal => "internal",
        }
    }

    pub fn message(self) -> String {
        match self {
            JoinRejectCode::InvalidProof => {
                "Bukti kode undangan tidak sah. Periksa kodenya lalu coba lagi.".into()
            }
            JoinRejectCode::Internal => {
                "Laptop rekan gagal memproses kode undangan. Coba lagi sebentar lagi.".into()
            }
            other => other.to_app_error().to_string(),
        }
    }

    pub fn to_app_error(self) -> AppError {
        match self {
            JoinRejectCode::InviteNotFound => AppError::InviteNotFound,
            JoinRejectCode::InviteExpired => AppError::InviteExpired,
            JoinRejectCode::InviteUsed => AppError::InviteUsed,
            JoinRejectCode::InviteRevoked => AppError::InviteRevoked,
            JoinRejectCode::InvalidProof => AppError::InviteInvalid,
            JoinRejectCode::Removed => AppError::Removed,
            JoinRejectCode::Internal => AppError::Network(self.message()),
        }
    }

    fn from_reason(reason: Reason) -> JoinRejectCode {
        match reason {
            Reason::InviteNotFound => JoinRejectCode::InviteNotFound,
            Reason::InviteExpired | Reason::InviteNotYetValid => JoinRejectCode::InviteExpired,
            Reason::InviteUsed => JoinRejectCode::InviteUsed,
            Reason::InviteRevoked | Reason::TeamNotFound | Reason::InviterNotAuthorized => {
                JoinRejectCode::InviteRevoked
            }
            Reason::BadInviteSignature | Reason::BadMemberSignature => JoinRejectCode::InvalidProof,
            Reason::MemberRemoved => JoinRejectCode::Removed,
            _ => JoinRejectCode::Internal,
        }
    }
}

/// What the member laptop sends back to the joiner (same shape as
/// `network::JoinAccepted`), plus the accept op it authored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JoinAcceptedData {
    pub org: Organization,
    pub ops: Vec<SignedOp>,
}

/// Member side, step 3: finds a usable invite by tag. Returns `(org id,
/// invite id)`.
pub fn join_lookup(
    conn: &Connection,
    tag: &str,
    now: OffsetDateTime,
) -> Result<(String, String), JoinRejectCode> {
    let state = load_state(conn)
        .map_err(|_| JoinRejectCode::Internal)?
        .ok_or(JoinRejectCode::InviteNotFound)?;
    let me = super::store::self_row(conn)
        .map_err(|_| JoinRejectCode::Internal)?
        .map(|(pk, _)| pk)
        .unwrap_or_default();
    if !state.may_check_codes(&me) {
        return Err(JoinRejectCode::InviteNotFound);
    }
    let mut first_err = None;
    for inv in state.invites.values().filter(|i| i.tag == tag) {
        match state.invite_usable(inv, now) {
            Ok(()) => return Ok((state.org.id.clone(), inv.id.clone())),
            Err(r) => {
                first_err.get_or_insert(r);
            }
        }
    }
    Err(first_err.map_or(JoinRejectCode::InviteNotFound, JoinRejectCode::from_reason))
}

/// Member side, step 4: checks the joiner's proof and admits them by
/// authoring `invite_accept`. `tls_key` is the key the joiner proved in TLS.
pub fn join_accept(
    conn: &mut Connection,
    identity: &Identity,
    tls_key: &str,
    invite: &str,
    proof: &JoinProofData,
    now: OffsetDateTime,
) -> Result<JoinAcceptedData, JoinRejectCode> {
    let internal = |_| JoinRejectCode::Internal;
    if proof.member != tls_key || !is_lower_hex(&proof.member, 64) {
        return Err(JoinRejectCode::InvalidProof);
    }
    if !is_canonical_display_name(&proof.name)
        || !is_lower_hex(&proof.invite_sig, 128)
        || !is_lower_hex(&proof.member_sig, 128)
    {
        return Err(JoinRejectCode::InvalidProof);
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| JoinRejectCode::Internal)?;
    let org = require_org(&tx).map_err(|_| JoinRejectCode::InviteNotFound)?;
    let state = state_in(&tx, &org).map_err(internal)?;
    if !state.may_check_codes(identity.public_key_hex()) {
        return Err(JoinRejectCode::InviteNotFound);
    }
    let inv = state
        .invites
        .get(invite)
        .ok_or(JoinRejectCode::InviteNotFound)?;
    state
        .invite_usable(inv, now)
        .map_err(JoinRejectCode::from_reason)?;
    let msg = redeem_message(&org.id, invite, &proof.member, &proof.name);
    if !identity::verify_hex(&inv.key, &msg, &proof.invite_sig)
        || !identity::verify_hex(&proof.member, &msg, &proof.member_sig)
    {
        return Err(JoinRejectCode::InvalidProof);
    }
    if state
        .member(&proof.member)
        .is_some_and(|m| m.status == MemberStatus::Removed)
    {
        return Err(JoinRejectCode::Removed);
    }
    // A retry after a lost answer: this laptop was already admitted through
    // this invite (each person uses an invite once), so only resend the ops.
    let already_admitted = inv.used_by.contains(&proof.member) && state.is_active(&proof.member);
    if !already_admitted {
        let body = Body::InviteAccept {
            invite: invite.to_owned(),
            member: proof.member.clone(),
            name: proof.name.clone(),
            invite_sig: proof.invite_sig.clone(),
            member_sig: proof.member_sig.clone(),
        };
        author_in(&tx, identity, Scope::Org, body, now).map_err(|e| match e {
            AppError::InviteExpired => JoinRejectCode::InviteExpired,
            AppError::InviteUsed => JoinRejectCode::InviteUsed,
            AppError::InviteRevoked => JoinRejectCode::InviteRevoked,
            _ => JoinRejectCode::Internal,
        })?;
    }
    let state = state_in(&tx, &org).map_err(internal)?;
    let ids = op_ids_for(&tx, &state, &proof.member).map_err(internal)?;
    let ops = ops_for(&tx, &state, &proof.member, &ids).map_err(internal)?;
    tx.commit().map_err(|_| JoinRejectCode::Internal)?;
    Ok(JoinAcceptedData { org, ops })
}

/// Joiner side, step 5: checks the organization record and the ops, stores
/// them, and requires this laptop to be an active member afterwards.
/// Nothing is kept when any check fails.
pub fn install_joined_org(
    conn: &mut Connection,
    identity: &Identity,
    org: Organization,
    ops: Vec<SignedOp>,
    code: &NormalizedCode,
    now: OffsetDateTime,
) -> AppResult<OrgInfo> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if org::load_organization(&tx)?.is_some() {
        return Err(AppError::AlreadyInOrg);
    }
    if let Err(detail) = org::validate_org_record(&org) {
        return Err(AppError::Network(format!(
            "Data organisasi dari laptop rekan tidak sah: {detail}."
        )));
    }
    if !org.verify_genesis() {
        return Err(AppError::Network(
            "Tanda tangan organisasi dari laptop rekan tidak sah.".into(),
        ));
    }
    let me = identity.public_key_hex().to_owned();
    // The laptop that admitted us authored our `invite_accept`.
    let from = ops.iter().find_map(|op| {
        let v = verify_op(op, &org.id, now).ok()?;
        match &v.payload.body {
            Body::InviteAccept { member, .. } if *member == me => Some(v.payload.author.clone()),
            _ => None,
        }
    });
    tx.execute(
        "INSERT INTO organizations (id, name, founder_public_key, created_at, genesis_signature)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![
            org.id,
            org.name,
            org.founder_public_key,
            org.created_at,
            org.genesis_signature
        ],
    )?;
    ingest_in(&tx, &org, from.as_deref(), ops, now)?;
    let state = state_in(&tx, &org)?;
    let key = invite_public_key(code);
    if !state.invites.values().any(|i| i.key == key) {
        return Err(AppError::Network(
            "Laptop rekan tidak mengirim undangan yang cocok dengan kode ini.".into(),
        ));
    }
    // Admitted through the invite of this code, not through another invite
    // (another team or role) that the responding laptop chose.
    let admitted_by_code = state
        .invites
        .values()
        .any(|i| i.key == key && i.used_by.contains(&me));
    if !admitted_by_code || !state.is_active(&me) {
        return Err(AppError::Network(
            "Laptop rekan tidak menambahkan laptop ini sebagai anggota. Coba lagi.".into(),
        ));
    }
    let info = super::view::org_info(&state, &me);
    tx.commit()?;
    Ok(info)
}

/// An existing member uses a code (for another team, or a higher role):
/// this laptop checks the code itself and authors the `invite_accept`.
pub fn redeem_as_member(
    conn: &mut Connection,
    identity: &Identity,
    code: &NormalizedCode,
    now: OffsetDateTime,
) -> AppResult<SignedOp> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let org = require_org(&tx)?;
    let state = state_in(&tx, &org)?;
    let me = identity.public_key_hex();
    match state.member(me) {
        Some(m) if m.status == MemberStatus::Removed => return Err(AppError::Removed),
        Some(m) if m.kind == MemberKind::Member => {}
        Some(_) => {
            return Err(AppError::Forbidden(
                "Tamu tidak bisa memakai kode undangan sendiri. Minta admin tim memasukkan Anda."
                    .into(),
            ));
        }
        None => {
            return Err(AppError::Forbidden(
                "Laptop ini belum menjadi anggota organisasi.".into(),
            ));
        }
    }
    let key = invite_public_key(code);
    let inv = state
        .invites
        .values()
        .find(|i| i.tag == code.tag() && i.key == key)
        .ok_or(AppError::InviteNotFound)?;
    state.invite_usable(inv, now).map_err(reason_error)?;
    if inv.used_by.iter().any(|m| m == me) {
        return Err(AppError::Forbidden(
            "Anda sudah pernah memakai kode undangan ini.".into(),
        ));
    }
    if inv.role != InviteRole::Guest
        && state.team_role(&inv.team, me).is_none()
        && state.department_of(me).is_some()
    {
        return Err(AppError::Forbidden(
            Reason::AlreadyInDepartment.message().into(),
        ));
    }
    if !state.accept_changes_anything(inv, me) {
        return Err(AppError::Forbidden(
            "Anda sudah tergabung di tim itu dengan peran yang sama atau lebih tinggi.".into(),
        ));
    }
    let proof = build_join_proof(code, &org.id, &inv.id, identity)?;
    let body = Body::InviteAccept {
        invite: inv.id.clone(),
        member: proof.member,
        name: proof.name,
        invite_sig: proof.invite_sig,
        member_sig: proof.member_sig,
    };
    let op = author_in(&tx, identity, Scope::Org, body, now)?;
    tx.commit()?;
    Ok(op)
}
