//! Storage of ops, recomputing the derived tables, per-peer filtering and
//! the log of rejected changes.

use std::net::SocketAddr;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Serialize;
use time::OffsetDateTime;

use super::fold::{FoldResult, MemberStatus, OrgState, fold};
use super::format::format_time;
use super::op::{MAX_LAMPORT_JUMP, SignedOp, VerifiedOp, parse_op, verify_op};
use crate::error::{AppError, AppResult};
use crate::identity::{self, Identity};
use crate::org::{self, Organization};

/// Rows kept in `rejected_changes`.
pub const REJECTED_KEEP: i64 = 1000;
const DETAIL_MAX_CHARS: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct IngestReport {
    /// Valid ops that were not stored before.
    pub new_ops: usize,
    /// Ops refused before storing (logged in `rejected_changes`).
    pub invalid: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectedChange {
    pub at: String,
    pub peer: Option<String>,
    pub address: Option<String>,
    pub code: String,
    pub detail: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Membership {
    None,
    Active,
    /// 0.5.1: suspended; can be reinstated.
    Suspended,
    Removed,
}

/// What a laptop is to us, for accepting its connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerAuthState {
    Member {
        display_name: String,
    },
    /// 0.5.1: suspended member. Its connection serves membership op sync
    /// only (org-scope ops), nothing else.
    Suspended {
        display_name: String,
    },
    /// Removed member; `removal_op` is the id of the `member_remove` op.
    Removed {
        removal_op: Option<String>,
    },
    Unknown,
}

pub(crate) fn not_in_org() -> AppError {
    AppError::NotFound("Laptop ini belum tergabung dalam organisasi.".into())
}

pub(crate) fn require_org(conn: &Connection) -> AppResult<Organization> {
    org::load_organization(conn)?.ok_or_else(not_in_org)
}

struct StoredRow {
    id: String,
    payload: String,
    sig: String,
    status: String,
    reason: Option<String>,
}

fn stored_rows(conn: &Connection) -> AppResult<Vec<StoredRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, payload, sig, status, reject_reason FROM org_ops ORDER BY lamport, author, id",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(StoredRow {
                id: r.get(0)?,
                payload: r.get(1)?,
                sig: r.get(2)?,
                status: r.get(3)?,
                reason: r.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Every stored op, parsed (signatures were checked when stored).
pub fn load_ops(conn: &Connection) -> AppResult<Vec<VerifiedOp>> {
    Ok(stored_rows(conn)?
        .into_iter()
        .filter_map(|r| {
            parse_op(&SignedOp {
                payload: r.payload,
                sig: r.sig,
            })
            .ok()
        })
        .collect())
}

/// Current membership state, or `None` without an organization.
pub fn load_state(conn: &Connection) -> AppResult<Option<OrgState>> {
    let Some(org) = org::load_organization(conn)? else {
        return Ok(None);
    };
    Ok(Some(fold(&org, &load_ops(conn)?).state))
}

pub fn max_lamport(conn: &Connection) -> AppResult<u64> {
    let max: i64 = conn.query_row("SELECT COALESCE(MAX(lamport), 0) FROM org_ops", [], |r| {
        r.get(0)
    })?;
    Ok(max.max(0) as u64)
}

/// Inserts a verified op; returns false when it was already stored.
pub(crate) fn insert_op(
    conn: &Connection,
    op: &VerifiedOp,
    from: Option<&str>,
    now: OffsetDateTime,
) -> AppResult<bool> {
    let n = conn.execute(
        "INSERT OR IGNORE INTO org_ops
           (id, org_id, author, lamport, kind, scope_team, payload, sig, received_at, received_from, status, reject_reason)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'applied', NULL)",
        params![
            op.id,
            op.payload.org,
            op.payload.author,
            op.payload.lamport as i64,
            op.payload.body.kind(),
            op.payload.scope.team(),
            op.signed.payload,
            op.signed.sig,
            format_time(now),
            from,
        ],
    )?;
    Ok(n == 1)
}

/// Verifies and stores ops received from another laptop (`from`), then
/// recomputes the state once. Everything happens in one immediate transaction.
pub fn ingest(
    conn: &mut Connection,
    from: Option<&str>,
    ops: Vec<SignedOp>,
    now: OffsetDateTime,
) -> AppResult<IngestReport> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let org = require_org(&tx)?;
    let report = ingest_in(&tx, &org, from, ops, now)?;
    tx.commit()?;
    Ok(report)
}

pub(crate) fn ingest_in(
    conn: &Connection,
    org: &Organization,
    from: Option<&str>,
    ops: Vec<SignedOp>,
    now: OffsetDateTime,
) -> AppResult<IngestReport> {
    let mut report = IngestReport::default();
    let mut verified = Vec::with_capacity(ops.len());
    for op in ops {
        match verify_op(&op, &org.id, now) {
            Ok(v) => verified.push(v),
            Err(rej) => {
                report.invalid += 1;
                log_rejection(conn, from, None, rej.code, &rej.detail, now)?;
            }
        }
    }
    // In lamport order, so the jump limit does not depend on batch order.
    verified.sort_by(|a, b| a.order_key().cmp(&b.order_key()));
    let mut known_max = max_lamport(conn)?;
    for v in verified {
        if v.lamport() > known_max.saturating_add(MAX_LAMPORT_JUMP) {
            report.invalid += 1;
            let detail = format!(
                "lamport {} terlalu jauh di atas lamport tertinggi yang diketahui ({known_max})",
                v.lamport()
            );
            log_rejection(conn, from, None, "lamport_jump", &detail, now)?;
            continue;
        }
        if insert_op(conn, &v, from, now)? {
            report.new_ops += 1;
        }
        known_max = known_max.max(v.lamport());
    }
    if report.new_ops > 0 {
        recompute_in(conn, org)?;
    }
    Ok(report)
}

/// Folds every stored op, updates `org_ops.status` and rewrites the derived
/// tables. Call inside a transaction.
pub(crate) fn recompute_in(conn: &Connection, org: &Organization) -> AppResult<OrgState> {
    let rows = stored_rows(conn)?;
    let mut ops = Vec::with_capacity(rows.len());
    let mut update =
        conn.prepare("UPDATE org_ops SET status = ?2, reject_reason = ?3 WHERE id = ?1")?;
    for r in rows {
        let signed = SignedOp {
            payload: r.payload,
            sig: r.sig,
        };
        match parse_op(&signed) {
            Ok(v) => ops.push(v),
            Err(_) => {
                if r.status != "rejected" || r.reason.as_deref() != Some("bad_format") {
                    update.execute(params![r.id, "rejected", "bad_format"])?;
                }
            }
        }
    }
    let result = fold(org, &ops);
    store_fold(conn, &result)?;
    Ok(result.state)
}

/// Writes a fold result: `org_ops.status` of every folded op (only rows
/// that change) and the derived tables.
pub(crate) fn store_fold(conn: &Connection, result: &FoldResult) -> AppResult<()> {
    let current: std::collections::HashMap<String, (String, Option<String>)> = conn
        .prepare("SELECT id, status, reject_reason FROM org_ops")?
        .query_map([], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))?
        .collect::<Result<_, _>>()?;
    let mut update =
        conn.prepare("UPDATE org_ops SET status = ?2, reject_reason = ?3 WHERE id = ?1")?;
    for (id, outcome) in &result.outcomes {
        let (status, reason) = match outcome {
            Ok(()) => ("applied", None),
            Err(reason) => ("rejected", Some(reason.code())),
        };
        let unchanged = current
            .get(id)
            .is_some_and(|(s, r)| s == status && r.as_deref() == reason);
        if !unchanged {
            update.execute(params![id, status, reason])?;
        }
    }
    write_derived(conn, &result.state)
}

/// This laptop's public key and display name, if the identity exists.
pub(crate) fn self_row(conn: &Connection) -> AppResult<Option<(String, Option<String>)>> {
    Ok(conn
        .query_row(
            "SELECT public_key, display_name FROM identity WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?)
}

/// Best known name: from the log, else this laptop's own name, else the
/// key fingerprint.
pub fn display_name_for(state: &OrgState, pk: &str, me: Option<(&str, Option<&str>)>) -> String {
    if let Some(name) = state.member(pk).and_then(|m| m.display_name.clone()) {
        return name;
    }
    if let Some((my_pk, Some(my_name))) = me
        && my_pk == pk
    {
        return my_name.to_owned();
    }
    identity::fingerprint(pk)
}

/// `members.status` as stored. The column only allows `active` and
/// `removed` (v2 migration); the feature modules read it as "may take part
/// or not", so a suspended member is written as `removed`. The fold state
/// (`load_state`) keeps the real status.
fn derived_status(status: MemberStatus) -> &'static str {
    match status {
        MemberStatus::Active => "active",
        MemberStatus::Suspended | MemberStatus::Removed => "removed",
    }
}

/// Rewrites members, teams, team_members, invites, guest_access, channels.
pub(crate) fn write_derived(conn: &Connection, state: &OrgState) -> AppResult<()> {
    let me = self_row(conn)?;
    let me_ref = me.as_ref().map(|(pk, n)| (pk.as_str(), n.as_deref()));
    conn.execute_batch(
        "DELETE FROM team_members; DELETE FROM teams; DELETE FROM invites;
         DELETE FROM guest_access; DELETE FROM channels;
         DELETE FROM project_members; DELETE FROM projects;
         DELETE FROM label_members; DELETE FROM labels; DELETE FROM join_decisions;",
    )?;
    conn.execute(
        "DELETE FROM members WHERE organization_id = ?1",
        [&state.org.id],
    )?;

    let mut stmt = conn.prepare(
        "INSERT INTO members
           (organization_id, public_key, display_name, role, added_at, status, is_superadmin, kind, removed_at,
            laptop, os, app_version, device_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
    )?;
    for m in state.members.values() {
        let d = m.device.as_ref();
        stmt.execute(params![
            state.org.id,
            m.public_key,
            display_name_for(state, &m.public_key, me_ref),
            state.org_role(&m.public_key).as_str(),
            m.joined_at,
            derived_status(m.status),
            m.is_superadmin,
            m.kind.as_str(),
            m.removed_at,
            d.map(|d| d.laptop.as_str()),
            d.map(|d| d.os.as_str()),
            d.map(|d| d.app_version.as_str()),
            d.map(|d| d.at.as_str()),
        ])?;
    }

    let mut team_stmt = conn.prepare(
        "INSERT INTO teams (id, name, created_at, created_by, deleted, archived, archived_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )?;
    let mut tm_stmt = conn.prepare(
        "INSERT INTO team_members (team_id, public_key, role, added_at) VALUES (?1, ?2, ?3, ?4)",
    )?;
    for t in state.teams.values() {
        team_stmt.execute(params![
            t.id,
            t.name,
            t.created_at,
            t.created_by,
            t.deleted,
            t.archived,
            t.archived_at
        ])?;
        for (pk, tm) in &t.members {
            tm_stmt.execute(params![t.id, pk, tm.role.as_str(), tm.added_at])?;
        }
    }

    let mut inv_stmt = conn.prepare(
        "INSERT INTO invites
           (id, team_id, role, projects, expires_at, single_use, tag, invite_key, created_by, created_at, revoked, used_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
    )?;
    for i in state.invites.values() {
        inv_stmt.execute(params![
            i.id,
            i.team,
            i.role.as_str(),
            serde_json::to_string(&i.projects).unwrap_or_else(|_| "[]".into()),
            i.expires_at,
            i.single_use,
            i.tag,
            i.key,
            i.created_by,
            i.created_at,
            i.revoked,
            serde_json::to_string(&i.used_by).unwrap_or_else(|_| "[]".into()),
        ])?;
    }

    let mut ga_stmt = conn.prepare(
        "INSERT INTO guest_access (public_key, team_id, project_id) VALUES (?1, ?2, ?3)",
    )?;
    for g in &state.guest_access {
        ga_stmt.execute(params![g.public_key, g.team, g.project])?;
    }

    let mut ch_stmt = conn
        .prepare("INSERT INTO channels (id, team_id, name, created_at) VALUES (?1, ?2, ?3, ?4)")?;
    for c in state.channels.values() {
        ch_stmt.execute(params![c.id, c.team, c.name, c.created_at])?;
    }

    let mut p_stmt = conn.prepare(
        "INSERT INTO projects (id, team_id, creator, registered_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    let mut pm_stmt = conn.prepare(
        "INSERT INTO project_members (project_id, public_key, added_at, added_by)
         VALUES (?1, ?2, ?3, ?4)",
    )?;
    for p in state.projects.values() {
        p_stmt.execute(params![
            p.id,
            p.team,
            p.creator,
            p.registered_by,
            p.created_at
        ])?;
        for (pk, m) in &p.members {
            pm_stmt.execute(params![p.id, pk, m.added_at, m.added_by])?;
        }
    }

    let mut l_stmt = conn
        .prepare("INSERT INTO labels (id, name, archived, created_at) VALUES (?1, ?2, ?3, ?4)")?;
    let mut lm_stmt =
        conn.prepare("INSERT INTO label_members (label_id, public_key) VALUES (?1, ?2)")?;
    for l in state.labels.values() {
        l_stmt.execute(params![l.id, l.name, l.archived, l.created_at])?;
        for pk in &l.members {
            lm_stmt.execute(params![l.id, pk])?;
        }
    }

    let mut jd_stmt = conn.prepare(
        "INSERT INTO join_decisions (request_id, member, name, team_id, approved, decided_by, decided_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )?;
    for d in state.join_decisions.values() {
        jd_stmt.execute(params![
            d.request, d.member, d.name, d.team, d.approved, d.by, d.at
        ])?;
    }
    Ok(())
}

/// Plan 1.4: whether `peer` may receive an op with this scope and author.
/// A suspended peer receives org-scope ops only (membership log sync, so it
/// learns when it is reinstated or removed); a removed or unknown peer
/// nothing.
pub fn may_receive(state: &OrgState, peer: &str, scope_team: Option<&str>, author: &str) -> bool {
    match state.member(peer).map(|m| m.status) {
        Some(MemberStatus::Active) => match scope_team {
            None => true,
            Some(team) => author == peer || state.team_role(team, peer).is_some(),
        },
        Some(MemberStatus::Suspended) => scope_team.is_none(),
        Some(MemberStatus::Removed) | None => false,
    }
}

/// Whether `peer` may receive any op at all (active or suspended).
fn may_sync(state: &OrgState, peer: &str) -> bool {
    state
        .member(peer)
        .is_some_and(|m| matches!(m.status, MemberStatus::Active | MemberStatus::Suspended))
}

/// Ids of every stored op that `peer` may receive, in fold order.
pub fn op_ids_for(conn: &Connection, state: &OrgState, peer: &str) -> AppResult<Vec<String>> {
    if !may_sync(state, peer) {
        return Ok(Vec::new());
    }
    let mut stmt =
        conn.prepare("SELECT id, scope_team, author FROM org_ops ORDER BY lamport, author, id")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    let mut ids = Vec::new();
    for row in rows {
        let (id, team, author) = row?;
        if may_receive(state, peer, team.as_deref(), &author) {
            ids.push(id);
        }
    }
    Ok(ids)
}

/// The requested ops that `peer` may receive (filtered again), in fold order.
pub fn ops_for(
    conn: &Connection,
    state: &OrgState,
    peer: &str,
    ids: &[String],
) -> AppResult<Vec<SignedOp>> {
    if !may_sync(state, peer) {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare("SELECT payload, sig, scope_team, author, lamport FROM org_ops WHERE id = ?1")?;
    let mut found = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for id in ids {
        if !seen.insert(id) {
            continue;
        }
        let row = stmt
            .query_row([id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            })
            .optional()?;
        if let Some((payload, sig, team, author, lamport)) = row
            && may_receive(state, peer, team.as_deref(), &author)
        {
            found.push(((lamport, author, id.clone()), SignedOp { payload, sig }));
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(found.into_iter().map(|(_, op)| op).collect())
}

/// Of the given ids, those not stored yet (for answering `SyncHave`).
pub fn missing_op_ids(conn: &Connection, ids: &[String]) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT 1 FROM org_ops WHERE id = ?1")?;
    let mut missing = Vec::new();
    // A set, not `missing.contains`: a peer can send tens of thousands of ids.
    let mut seen = std::collections::HashSet::with_capacity(ids.len());
    for id in ids {
        if seen.insert(id) && !stmt.exists([id])? {
            missing.push(id.clone());
        }
    }
    Ok(missing)
}

pub fn load_op(conn: &Connection, id: &str) -> AppResult<Option<SignedOp>> {
    Ok(conn
        .query_row(
            "SELECT payload, sig FROM org_ops WHERE id = ?1",
            [id],
            |r| {
                Ok(SignedOp {
                    payload: r.get(0)?,
                    sig: r.get(1)?,
                })
            },
        )
        .optional()?)
}

pub fn peer_auth(state: &OrgState, pk: &str) -> PeerAuthState {
    let name = |m: &super::fold::MemberState| {
        m.display_name
            .clone()
            .unwrap_or_else(|| identity::fingerprint(pk))
    };
    match state.member(pk) {
        Some(m) => match m.status {
            MemberStatus::Active => PeerAuthState::Member {
                display_name: name(m),
            },
            MemberStatus::Suspended => PeerAuthState::Suspended {
                display_name: name(m),
            },
            MemberStatus::Removed => PeerAuthState::Removed {
                removal_op: m.removal_op.clone(),
            },
        },
        None => PeerAuthState::Unknown,
    }
}

/// `none` without an organization, `active` or `suspended` by this
/// laptop's member status, otherwise `removed` (removed, or never
/// admitted).
pub fn membership(conn: &Connection, identity: &Identity) -> AppResult<Membership> {
    let Some(state) = load_state(conn)? else {
        return Ok(Membership::None);
    };
    Ok(
        match state.member(identity.public_key_hex()).map(|m| m.status) {
            Some(MemberStatus::Active) => Membership::Active,
            Some(MemberStatus::Suspended) => Membership::Suspended,
            Some(MemberStatus::Removed) | None => Membership::Removed,
        },
    )
}

/// Records a refused change; keeps only the latest 1000 rows.
pub fn log_rejection(
    conn: &Connection,
    peer: Option<&str>,
    address: Option<SocketAddr>,
    code: &str,
    detail: &str,
    now: OffsetDateTime,
) -> AppResult<()> {
    let detail: String = detail.chars().take(DETAIL_MAX_CHARS).collect();
    let peer: Option<String> = peer.map(|p| p.chars().take(128).collect());
    let code: String = code.chars().take(64).collect();
    conn.execute(
        "INSERT INTO rejected_changes (at, peer, address, code, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            format_time(now),
            peer,
            address.map(|a| a.to_string()),
            code,
            detail
        ],
    )?;
    conn.execute(
        "DELETE FROM rejected_changes WHERE id <= (SELECT MAX(id) FROM rejected_changes) - ?1",
        [REJECTED_KEEP],
    )?;
    Ok(())
}

/// Latest rejected changes first.
pub fn rejected_changes(conn: &Connection, limit: usize) -> AppResult<Vec<RejectedChange>> {
    let mut stmt = conn.prepare(
        "SELECT at, peer, address, code, detail FROM rejected_changes ORDER BY id DESC LIMIT ?1",
    )?;
    let rows = stmt
        .query_map([limit.min(i64::MAX as usize) as i64], |r| {
            Ok(RejectedChange {
                at: r.get(0)?,
                peer: r.get(1)?,
                address: r.get(2)?,
                code: r.get(3)?,
                detail: r.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
