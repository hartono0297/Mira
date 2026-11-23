//! Local storage around join requests (v0.3). The decision itself is an op
//! (`join_approve`, `join_reject`); everything here is per laptop:
//!
//! - **Requester** (no organization yet): `join_outbox` keeps its own signed
//!   request and the genesis record it pinned, so it survives a restart and
//!   only an approval in that very organization is accepted.
//!   [`create_join_request`], [`outgoing_join_request`],
//!   [`mark_join_sent`], [`mark_join_rejected`], [`cancel_join_request`],
//!   [`install_approved_org`].
//! - **Member** laptops: `join_requests` holds requests received directly
//!   ([`receive_join_request`]) or forwarded by another member
//!   ([`ingest_join_records`]), until decided or older than 7 days. They are
//!   forwarded only to laptops that may decide them
//!   ([`join_record_ids_for`], [`join_records_for`]).
//! - Answers to a requester polling for its status: [`join_status_for`].
//!
//! The network side (who calls these and over which ALPN) is in
//! docs/plans/v0.3-kontrak.md, "Protokol bergabung".

use std::net::IpAddr;

use rand_core::{OsRng, RngCore};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use super::actions::JoinAcceptedData;
use super::fold::{MemberStatus, OrgState};
use super::format::{format_time, is_lower_hex, parse_time};
use super::join::{
    JOIN_NOTE_MAX_CHARS, JOIN_REQUEST_VALIDITY, JOIN_REQUEST_VERSION, JoinExtras,
    JoinRequestPayload, SignedJoinRequest, VerifiedJoinRequest, is_valid_join_account,
    org_fingerprint, org_fingerprint_short, request_code, request_id, sign_join_request,
    verify_join_request,
};
use super::op::{Body, CLOCK_SLACK, MAX_CLOCK_AHEAD, SignedOp, verify_op};
use super::store::{
    display_name_for, ingest_in, load_ops, load_state, op_ids_for, ops_for, require_org,
};
use crate::error::{AppError, AppResult};
use crate::identity::{self, Identity};
use crate::org::{self, OrgInfo, Organization};

/// Undecided requests kept per laptop. A flood of new keys from one
/// network cannot grow the table past this.
pub const MAX_PENDING_REQUESTS: usize = 50;
/// Undecided requests kept per observed address group (one IPv4 address,
/// or one IPv6 /64).
pub const MAX_PENDING_PER_IP: usize = 3;
pub const JOIN_SEEN_DOMAIN: &str = "mira-join-seen-v1\n";
/// Record ids remembered for copies of requests that were not kept.
const MAX_ALIASES: i64 = 1000;

/// What the requester says about its laptop.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceProfile {
    pub laptop: String,
    pub os: String,
    pub app_version: String,
}

/// The organization (its genesis record, from `JoinInfo`) and the
/// department the requester picked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinTarget {
    pub org: Organization,
    pub team_id: String,
    pub team_name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OutgoingStatus {
    Pending,
    Rejected,
}

/// This laptop's own request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingJoinRequest {
    pub request_id: String,
    #[serde(skip)]
    pub request: SignedJoinRequest,
    /// The genesis record this request is pinned to.
    #[serde(skip)]
    pub org: Organization,
    /// `XXXX XXXX`, the same on the approver's screen.
    pub code: String,
    /// `XXXX-XXXX`, to compare with the superadmin's Organisasi page.
    pub org_fingerprint: String,
    pub org_id: String,
    pub org_name: String,
    pub team_id: String,
    pub team_name: String,
    pub display_name: String,
    /// v0.4: the note signed in the request, if any.
    pub note: Option<String>,
    pub created_at: String,
    pub status: OutgoingStatus,
    pub decided_by_name: Option<String>,
    pub decided_at: Option<String>,
    pub last_sent_at: Option<String>,
    pub last_error: Option<String>,
}

/// Who saw the request arrive directly from the requester, and from which
/// IP. Signed by `by`, so a forwarding laptop cannot change it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Seen {
    pub ip: Option<String>,
    pub by: String,
    pub at: String,
    pub sig: String,
}

/// Body of a forwarded join request (feature record, see the contract).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JoinRecord {
    pub request: SignedJoinRequest,
    pub seen: Seen,
}

impl JoinRecord {
    pub fn body(&self) -> String {
        serde_json::to_string(self).expect("join record always serializes")
    }
}

fn seen_message(request_id: &str, ip: Option<&str>, at: &str) -> Vec<u8> {
    format!("{JOIN_SEEN_DOMAIN}{request_id}\n{}\n{at}", ip.unwrap_or("")).into_bytes()
}

/// The group an address counts against for `MAX_PENDING_PER_IP`: the IPv4
/// address itself, or the /64 of an IPv6 address (one LAN host can hold a
/// whole /64).
pub fn ip_group(ip: IpAddr) -> String {
    match ip.to_canonical() {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => {
            let s = v6.segments();
            format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3])
        }
    }
}

fn random_hex16() -> String {
    let mut b = [0u8; 16];
    OsRng.fill_bytes(&mut b);
    hex::encode(b)
}

fn internal(e: impl std::fmt::Display) -> AppError {
    AppError::Internal(e.to_string())
}

// ----- Requester side ------------------------------------------------------

/// The note as typed: trimmed, blank means none. Too long or with control
/// or invisible characters is an error the person can fix.
fn clean_note(note: Option<&str>) -> AppResult<Option<String>> {
    let Some(note) = note.map(str::trim).filter(|n| !n.is_empty()) else {
        return Ok(None);
    };
    if note.chars().count() > JOIN_NOTE_MAX_CHARS {
        return Err(AppError::InvalidInput(format!(
            "Keterangan paling banyak {JOIN_NOTE_MAX_CHARS} karakter."
        )));
    }
    if identity::has_forbidden_chars(note) {
        return Err(AppError::InvalidInput(
            "Keterangan berisi karakter yang tidak diizinkan, misalnya baris baru atau tab.".into(),
        ));
    }
    Ok(Some(note.to_owned()))
}

/// The login name read from the system, trimmed. Left out when it does not
/// fit the request format: the person cannot change it, so it is no reason
/// to refuse the request.
fn clean_account(account: Option<&str>) -> Option<String> {
    account
        .map(str::trim)
        .filter(|a| is_valid_join_account(a))
        .map(str::to_owned)
}

/// Signs a new request for `target` and keeps it in `join_outbox`,
/// replacing any earlier one. Needs a display name and no organization.
/// The genesis record in `target` must be valid; the request is pinned to
/// it.
///
/// `extras` (v0.4) adds the note and login name. Pass `None` for an office
/// with v0.3 members: they refuse requests that carry either field. With
/// both empty the request has the v0.3 shape anyway.
pub fn create_join_request(
    conn: &mut Connection,
    identity: &Identity,
    target: &JoinTarget,
    device: &DeviceProfile,
    extras: Option<&JoinExtras>,
    now: OffsetDateTime,
) -> AppResult<OutgoingJoinRequest> {
    let name = identity
        .display_name()
        .ok_or(AppError::NameRequired)?
        .to_owned();
    let note = clean_note(extras.and_then(|e| e.note.as_deref()))?;
    let account = clean_account(extras.and_then(|e| e.account.as_deref()));
    let org = &target.org;
    if org::validate_org_record(org).is_err()
        || !org.verify_genesis()
        || !is_lower_hex(&target.team_id, 32)
    {
        return Err(AppError::InvalidInput(
            "Data kantor dari laptop rekan tidak sah. Cari kantor lagi.".into(),
        ));
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if org::load_organization(&tx)?.is_some() {
        return Err(AppError::AlreadyInOrg);
    }
    let payload = JoinRequestPayload {
        v: JOIN_REQUEST_VERSION,
        org: org.id.clone(),
        org_fp: org_fingerprint(org),
        member: identity.public_key_hex().to_owned(),
        name,
        team: target.team_id.clone(),
        laptop: device.laptop.clone(),
        os: device.os.clone(),
        app_version: device.app_version.clone(),
        note,
        account,
        at: format_time(now),
        nonce: random_hex16(),
    };
    let signed = sign_join_request(&payload, |m| identity.sign(m));
    // The same checks the approver will run, so a bad field fails here.
    verify_join_request(&signed, org).map_err(|d| {
        AppError::InvalidInput(format!("Permintaan bergabung tidak bisa dibuat: {d}."))
    })?;
    let record = serde_json::to_string(org).map_err(internal)?;
    tx.execute(
        "INSERT OR REPLACE INTO join_outbox
           (id, request_id, org_id, org_name, org_record, code, team_id, team_name, payload, sig,
            created_at, status, decided_by_name, decided_at, last_sent_at, last_error)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending', NULL, NULL, NULL, NULL)",
        params![
            signed.id(),
            org.id,
            org.name,
            record,
            request_code(&payload),
            target.team_id,
            target.team_name,
            signed.payload,
            signed.sig,
            payload.at,
        ],
    )?;
    tx.commit()?;
    outgoing_join_request(conn)?
        .ok_or_else(|| AppError::Internal("Permintaan bergabung tidak tersimpan.".into()))
}

struct OutboxRow {
    request_id: String,
    org_record: String,
    code: String,
    team_id: String,
    team_name: String,
    payload: String,
    sig: String,
    created_at: String,
    status: String,
    decided_by_name: Option<String>,
    decided_at: Option<String>,
    last_sent_at: Option<String>,
    last_error: Option<String>,
}

/// This laptop's request, if any.
pub fn outgoing_join_request(conn: &Connection) -> AppResult<Option<OutgoingJoinRequest>> {
    let row = conn
        .query_row(
            "SELECT request_id, org_record, code, team_id, team_name, payload, sig, created_at,
                    status, decided_by_name, decided_at, last_sent_at, last_error
             FROM join_outbox WHERE id = 1",
            [],
            |r| {
                Ok(OutboxRow {
                    request_id: r.get(0)?,
                    org_record: r.get(1)?,
                    code: r.get(2)?,
                    team_id: r.get(3)?,
                    team_name: r.get(4)?,
                    payload: r.get(5)?,
                    sig: r.get(6)?,
                    created_at: r.get(7)?,
                    status: r.get(8)?,
                    decided_by_name: r.get(9)?,
                    decided_at: r.get(10)?,
                    last_sent_at: r.get(11)?,
                    last_error: r.get(12)?,
                })
            },
        )
        .optional()?;
    let Some(row) = row else {
        return Ok(None);
    };
    let org: Organization = serde_json::from_str(&row.org_record).map_err(internal)?;
    let request = SignedJoinRequest {
        payload: row.payload,
        sig: row.sig,
    };
    let parsed = super::join::parse_request_payload(&request.payload).map_err(internal)?;
    Ok(Some(OutgoingJoinRequest {
        request_id: row.request_id,
        request,
        code: row.code,
        org_fingerprint: org_fingerprint_short(&org),
        org_id: org.id.clone(),
        org_name: org.name.clone(),
        org,
        team_id: row.team_id,
        team_name: row.team_name,
        display_name: parsed.name,
        note: parsed.note,
        created_at: row.created_at,
        status: if row.status == "rejected" {
            OutgoingStatus::Rejected
        } else {
            OutgoingStatus::Pending
        },
        decided_by_name: row.decided_by_name,
        decided_at: row.decided_at,
        last_sent_at: row.last_sent_at,
        last_error: row.last_error,
    }))
}

/// After a send attempt: when it happened and the error text, if any.
pub fn mark_join_sent(
    conn: &Connection,
    now: OffsetDateTime,
    error: Option<&str>,
) -> AppResult<()> {
    let error: Option<String> = error.map(|e| e.chars().take(300).collect());
    conn.execute(
        "UPDATE join_outbox SET last_sent_at = ?1, last_error = ?2 WHERE id = 1",
        params![format_time(now), error],
    )?;
    Ok(())
}

/// A member answered that this laptop's request was rejected, with the
/// `join_reject` op. Recorded only when the op is signed for the pinned
/// organization and carries exactly this laptop's pending request, so a
/// laptop that is not a member cannot fake a rejection. `by_name` is the
/// name the answering laptop gave for the op's author (shown as is; the
/// requester cannot check who may reject). Returns whether it was
/// recorded.
pub fn mark_join_rejected(
    conn: &Connection,
    op: &SignedOp,
    by_name: &str,
    now: OffsetDateTime,
) -> AppResult<bool> {
    let Some(mine) = outgoing_join_request(conn)? else {
        return Ok(false);
    };
    let Ok(v) = verify_op(op, &mine.org.id, now) else {
        return Ok(false);
    };
    let matches = matches!(
        &v.payload.body,
        Body::JoinReject { request, request_sig }
            if *request == mine.request.payload && *request_sig == mine.request.sig
    );
    if !matches {
        return Ok(false);
    }
    let by: String = by_name.chars().take(100).collect();
    conn.execute(
        "UPDATE join_outbox SET status = 'rejected', decided_by_name = ?2, decided_at = ?3
         WHERE id = 1 AND request_id = ?1",
        params![mine.request_id, by, v.payload.at],
    )?;
    Ok(true)
}

/// Forgets this laptop's request ("Batalkan permintaan").
pub fn cancel_join_request(conn: &Connection) -> AppResult<()> {
    conn.execute("DELETE FROM join_outbox WHERE id = 1", [])?;
    Ok(())
}

/// Requester side, after a member answered "approved": the organization
/// record must be exactly the pinned genesis, the ops are verified and
/// stored, and the log must hold an applied `join_approve` of this laptop's
/// own pending request. Nothing is kept when a check fails. Clears
/// `join_outbox` on success.
pub fn install_approved_org(
    conn: &mut Connection,
    identity: &Identity,
    org: Organization,
    ops: Vec<SignedOp>,
    now: OffsetDateTime,
) -> AppResult<OrgInfo> {
    let mine = outgoing_join_request(conn)?.ok_or_else(|| {
        AppError::Network(
            "Laptop ini tidak sedang meminta bergabung ke organisasi mana pun.".into(),
        )
    })?;
    if mine.org != org {
        return Err(AppError::Network(
            "Laptop rekan mengirim organisasi lain dari yang diminta. Persetujuan ini tidak dipakai."
                .into(),
        ));
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if org::load_organization(&tx)?.is_some() {
        return Err(AppError::AlreadyInOrg);
    }
    if org::validate_org_record(&org).is_err() || !org.verify_genesis() {
        return Err(AppError::Network(
            "Tanda tangan organisasi dari laptop rekan tidak sah.".into(),
        ));
    }
    tx.execute(
        "INSERT INTO organizations (id, name, founder_public_key, created_at, genesis_signature)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            org.id,
            org.name,
            org.founder_public_key,
            org.created_at,
            org.genesis_signature
        ],
    )?;
    ingest_in(&tx, &org, None, ops, now)?;
    let state = load_state(&tx)?.ok_or_else(super::store::not_in_org)?;
    let me = identity.public_key_hex();
    let approved = state
        .join_decisions
        .get(&mine.request_id)
        .is_some_and(|d| d.approved && d.member == me);
    if !approved || !state.is_active(me) {
        return Err(AppError::Network(
            "Laptop rekan belum mengirim persetujuan untuk permintaan ini. Coba lagi.".into(),
        ));
    }
    tx.execute("DELETE FROM join_outbox WHERE id = 1", [])?;
    let info = super::view::org_info(&state, me);
    tx.commit()?;
    Ok(info)
}

// ----- Member side -----------------------------------------------------------

/// A department the requester can pick.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinDepartment {
    pub id: String,
    pub name: String,
}

/// What a member laptop tells a laptop that is looking for the office.
/// `org` is the genesis record; the requester checks it
/// (`validate_org_record`, `verify_genesis`) and pins it in its request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinInfo {
    pub org: Organization,
    /// `XXXX-XXXX`, from the genesis record.
    pub fingerprint: String,
    pub departments: Vec<JoinDepartment>,
}

/// Organization record and open departments, sorted by name. `None` when
/// this laptop is not an active non-guest member (it then answers nothing).
pub fn join_info(conn: &Connection) -> AppResult<Option<JoinInfo>> {
    let Some(state) = load_state(conn)? else {
        return Ok(None);
    };
    let me = super::store::self_row(conn)?
        .map(|(pk, _)| pk)
        .unwrap_or_default();
    if !state.is_active_non_guest(&me) {
        return Ok(None);
    }
    let mut departments: Vec<JoinDepartment> = state
        .teams
        .values()
        .filter(|t| !t.deleted && !t.archived)
        .map(|t| JoinDepartment {
            id: t.id.clone(),
            name: t.name.clone(),
        })
        .collect();
    departments.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(Some(JoinInfo {
        fingerprint: org_fingerprint_short(&state.org),
        org: state.org,
        departments,
    }))
}

/// Why a member laptop refused to take a request. `code()` goes on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JoinRequestRefusal {
    /// This laptop is not an active non-guest member of an organization.
    NotMember,
    /// Bad format, other organization, or bad signature.
    Invalid,
    /// The TLS key of the connection is not the requester's key.
    WrongKey,
    /// Dated more than 7 days ago or more than 10 minutes ahead.
    Expired,
    /// The department is unknown or archived.
    TeamNotFound,
    /// The requester was removed from the organization.
    Removed,
    /// Too many pending requests on this laptop or from this address.
    Busy,
}

impl JoinRequestRefusal {
    pub fn code(self) -> &'static str {
        match self {
            JoinRequestRefusal::NotMember => "not_member",
            JoinRequestRefusal::Invalid => "invalid_request",
            JoinRequestRefusal::WrongKey => "wrong_key",
            JoinRequestRefusal::Expired => "request_expired",
            JoinRequestRefusal::TeamNotFound => "team_not_found",
            JoinRequestRefusal::Removed => "removed",
            JoinRequestRefusal::Busy => "busy",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            JoinRequestRefusal::NotMember => {
                "Laptop rekan ini tidak bisa menerima permintaan bergabung. Coba laptop lain."
            }
            JoinRequestRefusal::Invalid | JoinRequestRefusal::WrongKey => {
                "Permintaan bergabung ditolak karena isinya tidak sah. Buat permintaan baru."
            }
            JoinRequestRefusal::Expired => {
                "Permintaan bergabung sudah kedaluwarsa atau jam laptop ini salah. Periksa jam, lalu kirim ulang."
            }
            JoinRequestRefusal::TeamNotFound => {
                "Departemen yang dipilih tidak ada lagi. Cari kantor lagi dan pilih departemen lain."
            }
            JoinRequestRefusal::Removed => {
                "Laptop ini sudah pernah dikeluarkan dari organisasi, jadi tidak bisa bergabung lagi."
            }
            JoinRequestRefusal::Busy => {
                "Terlalu banyak permintaan bergabung yang menunggu. Coba lagi nanti atau hubungi superadmin."
            }
        }
    }
}

/// The state of a request as this laptop knows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JoinStatusAnswer {
    /// Stored here, not decided yet.
    Pending,
    /// Approved: the organization and the ops the new member may receive.
    Approved(JoinAcceptedData),
    /// Rejected: the `join_reject` op (the requester checks it with
    /// `mark_join_rejected`) and its author's name.
    Rejected {
        by_name: String,
        at: String,
        op: SignedOp,
    },
    /// Not known here (not received, or older than 7 days and dropped).
    Unknown,
}

fn in_window(req: &VerifiedJoinRequest, now: OffsetDateTime) -> bool {
    req.at <= now + MAX_CLOCK_AHEAD && req.at + JOIN_REQUEST_VALIDITY + CLOCK_SLACK >= now
}

/// Checks a request against the organization: still undecided, requester
/// not removed or already admitted, department open. `Ok(false)` when it is
/// already decided (nothing to store).
fn admissible(
    state: &OrgState,
    req: &VerifiedJoinRequest,
    now: OffsetDateTime,
) -> Result<bool, JoinRequestRefusal> {
    if state.join_decisions.contains_key(&req.id) {
        return Ok(false);
    }
    match state.member(&req.payload.member).map(|m| m.status) {
        Some(MemberStatus::Removed) => return Err(JoinRequestRefusal::Removed),
        Some(MemberStatus::Active) => return Ok(false),
        None => {}
    }
    if !in_window(req, now) {
        return Err(JoinRequestRefusal::Expired);
    }
    if state.open_team(&req.payload.team).is_none() {
        return Err(JoinRequestRefusal::TeamNotFound);
    }
    Ok(true)
}

/// Deletes requests that are decided, expired, or from members admitted
/// some other way. Call before counting or listing.
pub fn prune_join_requests(
    conn: &Connection,
    state: &OrgState,
    now: OffsetDateTime,
) -> AppResult<usize> {
    let rows: Vec<(String, String, String)> = conn
        .prepare("SELECT id, member, requested_at FROM join_requests")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_, _>>()?;
    let mut dropped = 0;
    for (id, member, requested_at) in rows {
        let decided = state.join_decisions.contains_key(&id);
        let known = state.member(&member).is_some();
        let expired = parse_time(&requested_at)
            .is_none_or(|at| at + JOIN_REQUEST_VALIDITY + CLOCK_SLACK < now);
        if decided || known || expired {
            conn.execute("DELETE FROM join_requests WHERE id = ?1", [&id])?;
            conn.execute(
                "DELETE FROM join_request_aliases WHERE request_id = ?1",
                [&id],
            )?;
            dropped += 1;
        }
    }
    // Aliases of requests that were replaced stay so their copies are not
    // fetched again; keep only the latest ones.
    conn.execute(
        "DELETE FROM join_request_aliases
         WHERE rowid <= (SELECT MAX(rowid) FROM join_request_aliases) - ?1",
        [MAX_ALIASES],
    )?;
    Ok(dropped)
}

fn alias(conn: &Connection, record_id: &str, request: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT OR IGNORE INTO join_request_aliases (record_id, request_id) VALUES (?1, ?2)",
        params![record_id, request],
    )
}

/// Stores a verified, admissible request with its first observation. Older
/// undecided requests of the same key are replaced. Refuses when the laptop
/// already holds `MAX_PENDING_REQUESTS`, or `MAX_PENDING_PER_IP` from the
/// same address group.
fn store_request(
    conn: &Connection,
    req: &VerifiedJoinRequest,
    record: &JoinRecord,
    from: Option<&str>,
    now: OffsetDateTime,
) -> Result<(), JoinRequestRefusal> {
    let db = |_| JoinRequestRefusal::Busy;
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM join_requests WHERE id = ?1",
            [&req.id],
            |_| Ok(()),
        )
        .optional()
        .map_err(db)?
        .is_some();
    let body = record.body();
    let record_id = crate::network::feature::record_id(&body);
    if exists {
        // Same request seen elsewhere: remember this copy's id so it is not
        // fetched again.
        alias(conn, &record_id, &req.id).map_err(db)?;
        return Ok(());
    }
    // One pending request per key: the newest (by its own `at`) wins.
    let newer: bool = conn
        .query_row(
            "SELECT 1 FROM join_requests WHERE member = ?1 AND requested_at > ?2",
            params![req.payload.member, req.payload.at],
            |_| Ok(()),
        )
        .optional()
        .map_err(db)?
        .is_some();
    if newer {
        alias(conn, &record_id, &req.id).map_err(db)?;
        return Ok(());
    }
    let same_member: i64 = conn
        .query_row(
            "SELECT count(*) FROM join_requests WHERE member = ?1",
            [&req.payload.member],
            |r| r.get(0),
        )
        .map_err(db)?;
    let total: i64 = conn
        .query_row("SELECT count(*) FROM join_requests", [], |r| r.get(0))
        .map_err(db)?;
    if same_member == 0 && total as usize >= MAX_PENDING_REQUESTS {
        return Err(JoinRequestRefusal::Busy);
    }
    let group = record
        .seen
        .ip
        .as_deref()
        .and_then(|ip| ip.parse::<IpAddr>().ok())
        .map(ip_group);
    if let Some(group) = &group {
        let per_ip: i64 = conn
            .query_row(
                "SELECT count(*) FROM join_requests WHERE ip_group = ?1 AND member <> ?2",
                params![group, req.payload.member],
                |r| r.get(0),
            )
            .map_err(db)?;
        if per_ip as usize >= MAX_PENDING_PER_IP {
            return Err(JoinRequestRefusal::Busy);
        }
    }
    conn.execute(
        "DELETE FROM join_request_aliases WHERE request_id IN
           (SELECT id FROM join_requests WHERE member = ?1)",
        [&req.payload.member],
    )
    .map_err(db)?;
    conn.execute(
        "DELETE FROM join_requests WHERE member = ?1",
        [&req.payload.member],
    )
    .map_err(db)?;
    conn.execute(
        "INSERT INTO join_requests
           (id, member, team_id, requested_at, payload, sig, record_id, record, code, seen_ip,
            ip_group, seen_by, received_at, received_from)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            req.id,
            req.payload.member,
            req.payload.team,
            req.payload.at,
            req.signed.payload,
            req.signed.sig,
            record_id,
            body,
            request_code(&req.payload),
            record.seen.ip,
            group,
            record.seen.by,
            format_time(now),
            from,
        ],
    )
    .map_err(db)?;
    Ok(())
}

/// Member side: a laptop that is not a member yet sent its request directly
/// over the join ALPN. `tls_key` is the key it proved in the handshake and
/// `ip` the address the connection came from (always pass it: without it
/// the per-address limit does not apply). Returns the request id and the
/// matching code. A request that is already decided is accepted (the
/// requester then asks for its status).
///
/// The cheap checks (format, organization, signature, key, dates) run
/// before any write transaction or fold.
pub fn receive_join_request(
    conn: &mut Connection,
    identity: &Identity,
    signed: &SignedJoinRequest,
    tls_key: &str,
    ip: Option<IpAddr>,
    now: OffsetDateTime,
) -> Result<(String, String), JoinRequestRefusal> {
    let org = org::load_organization(conn)
        .ok()
        .flatten()
        .ok_or(JoinRequestRefusal::NotMember)?;
    let req = verify_join_request(signed, &org).map_err(|_| JoinRequestRefusal::Invalid)?;
    if req.payload.member != tls_key {
        return Err(JoinRequestRefusal::WrongKey);
    }
    if !in_window(&req, now) {
        return Err(JoinRequestRefusal::Expired);
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| JoinRequestRefusal::Busy)?;
    let state = load_state(&tx)
        .ok()
        .flatten()
        .ok_or(JoinRequestRefusal::NotMember)?;
    let me = identity.public_key_hex();
    if !state.is_active_non_guest(me) {
        return Err(JoinRequestRefusal::NotMember);
    }
    prune_join_requests(&tx, &state, now).map_err(|_| JoinRequestRefusal::Busy)?;
    if admissible(&state, &req, now)? {
        let ip = ip.map(|ip| ip.to_canonical().to_string());
        let at = format_time(now);
        let sig = hex::encode(
            identity
                .sign(&seen_message(&req.id, ip.as_deref(), &at))
                .to_bytes(),
        );
        let record = JoinRecord {
            request: signed.clone(),
            seen: Seen {
                ip,
                by: me.to_owned(),
                at,
                sig,
            },
        };
        store_request(&tx, &req, &record, None, now)?;
    }
    tx.commit().map_err(|_| JoinRequestRefusal::Busy)?;
    let code = request_code(&req.payload);
    Ok((req.id, code))
}

/// The `join_reject` op of request `request_id`, if stored here.
fn reject_op(conn: &Connection, request_id: &str) -> AppResult<Option<SignedOp>> {
    for op in load_ops(conn)? {
        if let Body::JoinReject { request, .. } = &op.payload.body
            && super::join::request_id(request) == request_id
        {
            return Ok(Some(op.signed));
        }
    }
    Ok(None)
}

/// Status of request `request_id` for the laptop with `tls_key`. Only the
/// requester itself gets an answer other than `Unknown`, so nobody else can
/// fetch the organization's ops by naming someone's request.
pub fn join_status_for(
    conn: &Connection,
    request_id: &str,
    tls_key: &str,
) -> AppResult<JoinStatusAnswer> {
    if !is_lower_hex(request_id, 64) {
        return Ok(JoinStatusAnswer::Unknown);
    }
    let Some(state) = load_state(conn)? else {
        return Ok(JoinStatusAnswer::Unknown);
    };
    if let Some(d) = state.join_decisions.get(request_id) {
        if d.member != tls_key {
            return Ok(JoinStatusAnswer::Unknown);
        }
        if !d.approved {
            return Ok(match reject_op(conn, request_id)? {
                Some(op) => JoinStatusAnswer::Rejected {
                    by_name: display_name_for(&state, &d.by, None),
                    at: d.at.clone(),
                    op,
                },
                None => JoinStatusAnswer::Unknown,
            });
        }
        if !state.is_active(tls_key) {
            return Ok(JoinStatusAnswer::Unknown);
        }
        let org = require_org(conn)?;
        let ids = op_ids_for(conn, &state, tls_key)?;
        let ops = ops_for(conn, &state, tls_key, &ids)?;
        return Ok(JoinStatusAnswer::Approved(JoinAcceptedData { org, ops }));
    }
    let pending: Option<String> = conn
        .query_row(
            "SELECT member FROM join_requests WHERE id = ?1",
            [request_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(match pending {
        Some(member) if member == tls_key => JoinStatusAnswer::Pending,
        _ => JoinStatusAnswer::Unknown,
    })
}

/// Record ids of the pending requests `peer` may decide (superadmin, or
/// admin of the requested department), for the `join` feature topic.
pub fn join_record_ids_for(
    conn: &Connection,
    state: &OrgState,
    peer: &str,
) -> AppResult<Vec<String>> {
    if !state.is_active_non_guest(peer) {
        return Ok(Vec::new());
    }
    let rows: Vec<(String, String, String)> = conn
        .prepare("SELECT id, team_id, record_id FROM join_requests ORDER BY id")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_, _>>()?;
    Ok(rows
        .into_iter()
        .filter(|(id, team, _)| {
            !state.join_decisions.contains_key(id) && state.may_decide_join(peer, team)
        })
        .map(|(_, _, record_id)| record_id)
        .collect())
}

/// The records among `ids` that `peer` may receive (filtered again), as
/// `(record id, body)`.
pub fn join_records_for(
    conn: &Connection,
    state: &OrgState,
    peer: &str,
    ids: &[String],
) -> AppResult<Vec<(String, String)>> {
    let allowed: std::collections::HashSet<String> = join_record_ids_for(conn, state, peer)?
        .into_iter()
        .collect();
    let mut stmt = conn.prepare("SELECT record FROM join_requests WHERE record_id = ?1")?;
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for id in ids {
        if !allowed.contains(id) || !seen.insert(id) {
            continue;
        }
        if let Some(body) = stmt.query_row([id], |r| r.get::<_, String>(0)).optional()? {
            out.push((id.clone(), body));
        }
    }
    Ok(out)
}

/// Of the offered record ids, those this laptop does not hold.
pub fn unknown_join_record_ids(conn: &Connection, ids: &[String]) -> AppResult<Vec<String>> {
    let mut held = conn.prepare(
        "SELECT 1 FROM join_requests WHERE record_id = ?1
         UNION ALL SELECT 1 FROM join_request_aliases WHERE record_id = ?1",
    )?;
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for id in ids {
        if seen.insert(id) && !held.exists([id])? {
            out.push(id.clone());
        }
    }
    Ok(out)
}

/// Result of [`ingest_join_records`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct JoinIngest {
    pub accepted: usize,
    pub rejected: usize,
}

/// Stores join records forwarded by member `from` (the key proven in TLS,
/// never a value from the message). Each record must carry a valid request
/// and an observation signed by an active non-guest member, dated within
/// the request's 7 days. Decided, expired or over-limit requests are
/// dropped without error.
pub fn ingest_join_records(
    conn: &mut Connection,
    from: &str,
    bodies: &[String],
    now: OffsetDateTime,
) -> AppResult<JoinIngest> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let Some(state) = load_state(&tx)? else {
        return Ok(JoinIngest::default());
    };
    if !state.is_active_non_guest(from) {
        return Ok(JoinIngest {
            accepted: 0,
            rejected: bodies.len(),
        });
    }
    prune_join_requests(&tx, &state, now)?;
    let mut out = JoinIngest::default();
    for body in bodies {
        let Ok(record) = serde_json::from_str::<JoinRecord>(body) else {
            out.rejected += 1;
            continue;
        };
        if record.body() != *body {
            out.rejected += 1;
            continue;
        }
        let Ok(req) = verify_join_request(&record.request, &state.org) else {
            out.rejected += 1;
            continue;
        };
        let seen = &record.seen;
        let seen_at_ok = parse_time(&seen.at).is_some_and(|at| {
            at <= now + MAX_CLOCK_AHEAD && at + JOIN_REQUEST_VALIDITY + CLOCK_SLACK >= now
        });
        let seen_ok = seen_at_ok
            && state.is_active_non_guest(&seen.by)
            && seen
                .ip
                .as_deref()
                .is_none_or(|ip| ip.len() <= 64 && ip.parse::<IpAddr>().is_ok())
            && identity::verify_hex(
                &seen.by,
                &seen_message(&req.id, seen.ip.as_deref(), &seen.at),
                &seen.sig,
            );
        if !seen_ok {
            out.rejected += 1;
            continue;
        }
        match admissible(&state, &req, now) {
            Ok(true) => {}
            Ok(false) | Err(_) => continue,
        }
        if store_request(&tx, &req, &record, Some(from), now).is_ok() {
            out.accepted += 1;
        }
    }
    tx.commit()?;
    Ok(out)
}

/// A pending request as the approver sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinRequestView {
    pub id: String,
    pub public_key: String,
    pub display_name: String,
    pub team_id: String,
    pub team_name: String,
    pub laptop: String,
    pub os: String,
    pub app_version: String,
    pub requested_at: String,
    pub received_at: String,
    /// `XXXX XXXX`, to compare with the requester's screen.
    pub code: String,
    /// IP the request came from, observed by `seenByName`'s laptop (not
    /// self-reported).
    pub ip: Option<String>,
    pub seen_by_name: Option<String>,
    /// v0.4, from the signed request; `None` for a v0.3 request.
    pub note: Option<String>,
    /// v0.4: the requester's login name, from the signed request.
    pub account: Option<String>,
}

struct PendingRow {
    id: String,
    team: String,
    payload: String,
    sig: String,
    code: String,
    ip: Option<String>,
    seen_by: Option<String>,
    received_at: String,
}

/// Pending requests `me` may decide, newest first.
pub fn pending_join_requests(
    conn: &Connection,
    state: &OrgState,
    me: &str,
    now: OffsetDateTime,
) -> AppResult<Vec<JoinRequestView>> {
    if !state.is_active_non_guest(me) {
        return Ok(Vec::new());
    }
    prune_join_requests(conn, state, now)?;
    let rows: Vec<PendingRow> = conn
        .prepare(
            "SELECT id, team_id, payload, sig, code, seen_ip, seen_by, received_at
             FROM join_requests",
        )?
        .query_map([], |r| {
            Ok(PendingRow {
                id: r.get(0)?,
                team: r.get(1)?,
                payload: r.get(2)?,
                sig: r.get(3)?,
                code: r.get(4)?,
                ip: r.get(5)?,
                seen_by: r.get(6)?,
                received_at: r.get(7)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    let mut out = Vec::new();
    for row in rows {
        if !state.may_decide_join(me, &row.team) || state.join_decisions.contains_key(&row.id) {
            continue;
        }
        let signed = SignedJoinRequest {
            payload: row.payload,
            sig: row.sig,
        };
        let Ok(req) = verify_join_request(&signed, &state.org) else {
            continue;
        };
        let p = req.payload;
        out.push(JoinRequestView {
            id: row.id,
            code: row.code,
            team_name: state
                .teams
                .get(&p.team)
                .map(|t| t.name.clone())
                .unwrap_or_default(),
            public_key: p.member,
            display_name: p.name,
            team_id: p.team,
            laptop: p.laptop,
            os: p.os,
            app_version: p.app_version,
            note: p.note,
            account: p.account,
            requested_at: p.at,
            received_at: row.received_at,
            ip: row.ip,
            seen_by_name: row.seen_by.map(|pk| display_name_for(state, &pk, None)),
        });
    }
    out.sort_by(|a, b| {
        b.requested_at
            .cmp(&a.requested_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(out)
}

/// The stored request with this id, for approving or rejecting it.
pub(crate) fn stored_request(
    conn: &Connection,
    request_id: &str,
) -> AppResult<Option<SignedJoinRequest>> {
    Ok(conn
        .query_row(
            "SELECT payload, sig FROM join_requests WHERE id = ?1",
            [request_id],
            |r| {
                Ok(SignedJoinRequest {
                    payload: r.get(0)?,
                    sig: r.get(1)?,
                })
            },
        )
        .optional()?)
}

/// Id of a request payload (same as `SignedJoinRequest::id`).
pub fn join_request_id(payload: &str) -> String {
    request_id(payload)
}
