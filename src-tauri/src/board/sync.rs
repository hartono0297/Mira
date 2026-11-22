//! Hook points for exchanging board changes with other laptops.
//!
//! Network transport is not part of Tahap 3 (local). What exists here is
//! everything a transport needs, tested with two local databases:
//!
//! - [`BoardSyncHook::on_local_change`] is called after every committed local
//!   change (send it to peers that may receive the project).
//! - [`heads`] and [`changes_since`] answer a peer that says what it has.
//! - [`apply_remote_changes`] stores and merges changes for a known project.
//! - [`import_project`] creates a project this laptop has not seen yet from
//!   its changes (the project row is not sent separately; it is derived from
//!   the project's first change, whose author is the creator).
//!
//! For every remote change, in this order: envelope (hex fields, size,
//! uncompressed chunk, signature; `sign::verify_envelope`), the author's
//! permission (`BoardAction::RemoteChange`), parsing (`sign::parse_change`),
//! then applying it alone with the document shape checked afterwards
//! (`BoardDoc::apply_remote`). A refused change is recorded in
//! `rejected_changes`, never stored, and does not stop the rest of the batch.
//! Applying is idempotent. One call handles at most [`MAX_BATCH_CHANGES`]
//! changes and [`MAX_BATCH_BYTES`]; the rest is reported as `deferred`.
//!
//! # Open decisions for the network stage
//!
//! - Which peers receive a project (probably the members of its team).
//! - Changes from a member who was later removed. The policy reads the
//!   current member tables, so a change made while the author was still a
//!   member but received after the removal is refused (`board_forbidden`).
//!   Every later change that depends on it, even from active members, then
//!   stays in `missing_deps` on this laptop forever, while laptops that
//!   received it in time keep it: the documents diverge. Options: judge each
//!   change against the membership at the time it was made (needs a trusted
//!   time or the membership log position in the change), or accept changes
//!   from removed members whose dependencies are all older than the removal.
//!   Behavior stays as is until this is decided.

use automerge::{Change, ChangeHash};
use rusqlite::{Connection, Transaction, TransactionBehavior, params};
use time::OffsetDateTime;

use super::doc::BoardDoc;
use super::model::{validate_project_code, validate_project_name};
use super::policy::{BoardAction, BoardPolicy};
use super::sign::{ChangeRejection, SignedChange, parse_change, verify_envelope};
use super::store::{self, ProjectRow};
use crate::clock;
use crate::error::{AppError, AppResult};
use crate::permissions;

/// Actor used for documents only read or merged here; never authors a change.
const MERGE_ACTOR: [u8; 32] = [0; 32];

/// Most changes handled in one call; the rest are `deferred`.
pub const MAX_BATCH_CHANGES: usize = 1_000;
/// Most change bytes handled in one call; the rest are `deferred`.
pub const MAX_BATCH_BYTES: usize = 16 * 1024 * 1024;

/// Called after every committed local change, outside the database lock.
pub trait BoardSyncHook: Send + Sync {
    fn on_local_change(&self, project_id: &str, change: &SignedChange);
}

/// Hook used until board sync exists.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoopSync;

impl BoardSyncHook for NoopSync {
    fn on_local_change(&self, _project_id: &str, _change: &SignedChange) {}
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ApplyReport {
    /// New changes stored and merged.
    pub applied: usize,
    /// Already known (same hash), skipped.
    pub duplicates: usize,
    /// Refused (bad signature, format, wrong project, author not allowed,
    /// refused by Automerge, breaks the document shape) and logged.
    pub rejected: usize,
    /// Valid but waiting for a change this laptop does not have; not stored.
    /// The peer should be asked for `changes_since` our heads again.
    pub missing_deps: usize,
    /// Over the batch limits, not looked at; ask again with our new heads.
    pub deferred: usize,
}

/// Keeps what fits the batch limits; returns it and the number deferred.
fn limit_batch(mut changes: Vec<SignedChange>) -> (Vec<SignedChange>, usize) {
    let mut bytes = 0usize;
    let keep = changes
        .iter()
        .take(MAX_BATCH_CHANGES)
        .take_while(|c| {
            bytes = bytes.saturating_add(c.bytes.len());
            bytes <= MAX_BATCH_BYTES
        })
        .count();
    let deferred = changes.len() - keep;
    changes.truncate(keep);
    (changes, deferred)
}

/// Current heads of a project's document, sorted, as 64-hex hashes.
pub fn heads(conn: &Connection, project_id: &str) -> AppResult<Vec<String>> {
    let mut doc = store::load_doc(conn, project_id, &MERGE_ACTOR)?;
    Ok(doc.heads().iter().map(ToString::to_string).collect())
}

/// Stored changes a peer with `have_heads` is missing, in causal order.
/// Unknown or malformed heads are ignored (the peer then gets more than it
/// needs, which applying skips as duplicates).
pub fn changes_since(
    conn: &Connection,
    project_id: &str,
    have_heads: &[String],
) -> AppResult<Vec<SignedChange>> {
    let mut doc = store::load_doc(conn, project_id, &MERGE_ACTOR)?;
    let have: Vec<ChangeHash> = have_heads.iter().filter_map(|h| h.parse().ok()).collect();
    let mut out = Vec::new();
    for change in doc.changes_after(&have) {
        if let Some(sc) = store::change_by_hash(conn, &change.hash().to_string())? {
            out.push(sc);
        }
    }
    Ok(out)
}

/// Verifies, stores and merges changes of a project this laptop already has.
pub fn apply_remote_changes(
    conn: &mut Connection,
    policy: &dyn BoardPolicy,
    project_id: &str,
    from_peer: Option<&str>,
    changes: Vec<SignedChange>,
) -> AppResult<ApplyReport> {
    let (changes, deferred) = limit_batch(changes);
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let row = store::project(&tx, project_id)?;
    let mut doc = store::load_doc(&tx, project_id, &MERGE_ACTOR)?;
    let mut report = ingest(
        &tx,
        policy,
        &row,
        &mut doc,
        from_peer,
        changes,
        clock::now(),
    )?;
    report.deferred = deferred;
    tx.commit()?;
    Ok(report)
}

/// Creates a project from its changes as received from a peer. The first
/// change (the one without dependencies) defines the project: its author is
/// the creator and must be allowed to create projects, and its timestamp is
/// the creation time. When the project already exists this is
/// `apply_remote_changes`.
///
/// Fails with `invalid_input` when the project code is already used by
/// another local project; renaming codes on conflict is not decided yet.
pub fn import_project(
    conn: &mut Connection,
    policy: &dyn BoardPolicy,
    project_id: &str,
    from_peer: Option<&str>,
    changes: Vec<SignedChange>,
) -> AppResult<ApplyReport> {
    if store::project(conn, project_id).is_ok() {
        return apply_remote_changes(conn, policy, project_id, from_peer, changes);
    }
    let now = clock::now();
    let incomplete = || {
        AppError::NotFound(
            "Data proyek dari laptop rekan belum lengkap. Coba sinkron lagi nanti.".into(),
        )
    };
    let (changes, deferred) = limit_batch(changes);
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let write = BoardAction::RemoteChange {
        project_id: project_id.to_owned(),
    };
    // Only changes whose author may write are parsed at all.
    let root = changes
        .iter()
        .filter(|sc| sc.project_id == project_id)
        .filter(|sc| verify_envelope(sc).is_ok())
        .filter(|sc| policy.allows(&tx, &sc.author, &write))
        .find_map(|sc| match parse_change(sc) {
            Ok(c) if c.deps().is_empty() => Some((sc.author.clone(), c)),
            _ => None,
        });
    let Some((creator, root_change)) = root else {
        return Err(incomplete());
    };
    let mut probe = BoardDoc::empty(&MERGE_ACTOR);
    let root_time = root_change.timestamp();
    let probe_ok = probe.apply_remote(root_change, &creator).is_ok();
    let meta = probe.project();
    let meta_ok = probe_ok
        && meta.id == project_id
        && validate_project_name(&meta.name).is_ok_and(|n| n == meta.name)
        && validate_project_code(&meta.code).is_ok_and(|c| c == meta.code);
    if !meta_ok {
        log(
            &tx,
            from_peer,
            &ChangeRejection::new(
                "board_bad_project",
                "data proyek di perubahan pertama tidak valid",
            ),
            now,
        )?;
        tx.commit()?;
        return Err(incomplete());
    }
    let create = BoardAction::CreateProject {
        team_id: meta.team_id.clone(),
    };
    if let Err(e) = policy.check(&tx, &creator, &create) {
        log(
            &tx,
            from_peer,
            &ChangeRejection::new(
                "board_forbidden",
                format!("pembuat proyek {}: {e}", short(&creator)),
            ),
            now,
        )?;
        tx.commit()?;
        return Err(e);
    }
    store::ensure_code_free(&tx, &meta.code, project_id)?;
    let created_at = OffsetDateTime::from_unix_timestamp(root_time)
        .map(clock::format_rfc3339)
        .unwrap_or_else(|_| clock::format_rfc3339(now));
    let row = ProjectRow {
        id: meta.id,
        code: meta.code,
        name: meta.name,
        team_id: meta.team_id,
        created_by: creator,
        updated_at: created_at.clone(),
        created_at,
    };
    tx.execute(
        "INSERT INTO board_projects (id, code, name, team_id, created_by, created_at, doc, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, x'', ?7)",
        params![
            row.id,
            row.code,
            row.name,
            row.team_id,
            row.created_by,
            row.created_at,
            row.updated_at
        ],
    )?;
    let mut doc = BoardDoc::empty(&MERGE_ACTOR);
    let mut report = ingest(&tx, policy, &row, &mut doc, from_peer, changes, now)?;
    report.deferred = deferred;
    if report.applied == 0 {
        // Dropping the transaction also drops the half-made project row.
        return Err(incomplete());
    }
    tx.commit()?;
    Ok(report)
}

fn short(pk: &str) -> &str {
    pk.get(..16).unwrap_or(pk)
}

fn log(
    conn: &Connection,
    from_peer: Option<&str>,
    r: &ChangeRejection,
    now: OffsetDateTime,
) -> AppResult<()> {
    permissions::log_rejection(conn, from_peer, None, r.code, &r.detail, now)
}

fn ingest(
    tx: &Transaction<'_>,
    policy: &dyn BoardPolicy,
    row: &ProjectRow,
    doc: &mut BoardDoc,
    from_peer: Option<&str>,
    changes: Vec<SignedChange>,
    now: OffsetDateTime,
) -> AppResult<ApplyReport> {
    let mut report = ApplyReport::default();
    let mut pending: Vec<(SignedChange, Change)> = Vec::new();
    let allowed = BoardAction::RemoteChange {
        project_id: row.id.clone(),
    };
    for sc in changes {
        let hash = sc.hash.parse::<ChangeHash>().ok();
        let known = match hash {
            Some(h) => doc.has_change(&h) || store::change_exists(tx, &sc.hash)?,
            None => false,
        };
        if known || pending.iter().any(|(p, _)| p.hash == sc.hash) {
            report.duplicates += 1;
            continue;
        }
        let checked = if sc.project_id != row.id {
            Err(ChangeRejection::new(
                "board_wrong_project",
                "perubahan untuk proyek lain dikirim ke proyek ini",
            ))
        } else {
            verify_envelope(&sc)
                .and_then(|()| {
                    policy.check(tx, &sc.author, &allowed).map_err(|e| {
                        ChangeRejection::new(
                            "board_forbidden",
                            format!("penulis {}: {e}", short(&sc.author)),
                        )
                    })
                })
                .and_then(|()| parse_change(&sc))
        };
        match checked {
            Ok(change) => pending.push((sc, change)),
            Err(r) => reject(tx, &mut report, row, &sc, from_peer, r, now)?,
        }
    }

    // Apply in dependency order, one change at a time, so a bad change is
    // refused alone; whatever still misses a dependency waits.
    loop {
        let ready = pending
            .iter()
            .position(|(_, c)| c.deps().iter().all(|d| doc.has_change(d)));
        let Some(i) = ready else { break };
        let (sc, change) = pending.swap_remove(i);
        let time = change.timestamp();
        match doc.apply_remote(change, &sc.author) {
            Ok(()) => {
                store::insert_change(tx, &sc, time, from_peer, now)?;
                report.applied += 1;
            }
            Err((code, detail)) => {
                let r = ChangeRejection::new(code, detail);
                reject(tx, &mut report, row, &sc, from_peer, r, now)?;
            }
        }
    }
    report.missing_deps = pending.len();
    if report.applied > 0 {
        store::save_doc(tx, row, doc, now)?;
    }
    Ok(report)
}

fn reject(
    tx: &Transaction<'_>,
    report: &mut ApplyReport,
    row: &ProjectRow,
    sc: &SignedChange,
    from_peer: Option<&str>,
    r: ChangeRejection,
    now: OffsetDateTime,
) -> AppResult<()> {
    report.rejected += 1;
    let detail = format!(
        "proyek {} perubahan {}: {}",
        short(&row.id),
        short(&sc.hash),
        r.detail
    );
    log(tx, from_peer, &ChangeRejection::new(r.code, detail), now)
}

/// Groups of live tasks that share a number after a merge, as
/// `(number, task ids sorted by (created_at, id))`.
pub fn duplicate_numbers(doc: &BoardDoc) -> AppResult<Vec<(i64, Vec<String>)>> {
    let mut tasks = doc.tasks()?;
    tasks.retain(|t| !t.deleted);
    tasks.sort_by(|a, b| (a.number, &a.created_at, &a.id).cmp(&(b.number, &b.created_at, &b.id)));
    let mut out: Vec<(i64, Vec<String>)> = Vec::new();
    for t in tasks {
        match out.last_mut() {
            Some((n, ids)) if *n == t.number => ids.push(t.id),
            _ => out.push((t.number, vec![t.id])),
        }
    }
    out.retain(|(_, ids)| ids.len() > 1);
    Ok(out)
}

/// Intended rule for task numbers that collide after sync (not implemented,
/// not called yet):
///
/// Two laptops offline can both create `PA-12`. After merging, for each
/// group from [`duplicate_numbers`] the first task by `(created_at, id)`
/// keeps the number. Every other task in the group gets a fresh number from
/// `next_number`, written only by the laptop that created that task (its
/// `created_by`), so exactly one laptop renumbers each task and two laptops
/// never renumber concurrently into a new collision. The renumbering is one
/// signed change with a `renumbered` activity entry (old code in `detail`),
/// so links and messages that mention the old code can be explained.
pub fn resolve_duplicate_numbers(_doc: &mut BoardDoc, _me: &str) -> AppResult<()> {
    Ok(())
}

#[cfg(test)]
mod tests;
