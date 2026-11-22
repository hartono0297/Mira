//! Exchanging board changes with other laptops: the storage side. The
//! network side is `feature.rs` (the `FeatureSync` of topic `board`).
//!
//! - [`BoardSyncHook::on_local_change`] is called after every committed local
//!   change (offer it to peers, check reminders).
//! - [`heads`] and [`changes_since`] list what a peer is missing.
//! - [`apply_remote_changes`] stores and merges changes for a known project.
//! - [`import_project`] creates a project this laptop has not seen yet from
//!   its changes (the project row is derived from the project's first
//!   change, whose author is the creator).
//!
//! For every remote change, in this order:
//! 1. already known: `Duplicate`;
//! 2. envelope (hex fields, size, uncompressed chunk, signature;
//!    `sign::verify_envelope`), wrong project: `Rejected`;
//! 3. the author may write in the project now. If not, an author who was
//!    never a member is `Held` without parsing anything; otherwise the change
//!    is parsed and judged at its own time (`BoardPolicy::check_at`): the
//!    right counts when the author lost it after the change was made;
//! 4. parsing (`sign::parse_change`): `Rejected` on failure;
//! 5. applied alone, in dependency order, with the document shape checked
//!    (`BoardDoc::apply_remote`, `Rejected` on failure), then the meaning:
//!    tasks it deletes need `DeleteTask` and a changed project name or code
//!    needs `ManageProject` (at the change's time, otherwise `Held` and the
//!    document is restored); a changed project id or team is `Rejected`;
//! 6. whatever still misses a parent change: `MissingDeps`.
//!
//! `Rejected` changes are logged in `rejected_changes`; `Held` ones are not
//! (the caller logs them once, it knows whether this is a retry). Neither is
//! stored here. Applying is idempotent. One call handles at most
//! [`MAX_BATCH_CHANGES`] changes and [`MAX_BATCH_BYTES`]; the rest is
//! `Deferred`.
//!
//! `Held` instead of refused for good: membership ops and board changes
//! travel separately, so a new member's change can arrive before the op that
//! adds them to the team. The caller retries held changes when the
//! membership changes.

use automerge::{Change, ChangeHash};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use time::OffsetDateTime;

use super::doc::{BoardDoc, ProjectMeta};
use super::rules;
use super::model::{validate_project_code, validate_project_name};
use super::policy::{BoardAction, BoardPolicy};
use super::sign::{ChangeRejection, SignedChange, parse_change, verify_envelope};
use super::store::{self, ProjectRow};
use crate::clock;
use crate::error::AppResult;
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

/// What happened to one received change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChangeOutcome {
    /// Stored and merged now.
    Applied,
    /// Already stored (same hash).
    Duplicate,
    /// Valid so far but a parent change is missing; not stored.
    MissingDeps,
    /// The project is unknown and its first change is missing or held.
    NoProject,
    /// The author has no right for it as far as this laptop knows; not
    /// stored, not logged. Retry when the membership changes.
    Held { code: &'static str, detail: String },
    /// Refused for good and logged.
    Rejected { code: &'static str },
    /// Over the batch limits, not looked at.
    Deferred,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ApplyReport {
    /// New changes stored and merged.
    pub applied: usize,
    /// Already known (same hash), skipped.
    pub duplicates: usize,
    /// Refused for good (bad signature, format, wrong project, refused by
    /// Automerge, breaks the document shape) and logged.
    pub rejected: usize,
    /// The author lacks the right (now and at the change's time).
    pub held: usize,
    /// Valid but waiting for a change this laptop does not have (or for the
    /// project's first change); not stored.
    pub missing_deps: usize,
    /// Over the batch limits, not looked at; ask again with our new heads.
    pub deferred: usize,
    /// `(change hash, outcome)` for every change handed in, in input order
    /// of first appearance.
    pub outcomes: Vec<(String, ChangeOutcome)>,
}

impl ApplyReport {
    fn push(&mut self, hash: &str, outcome: ChangeOutcome) {
        match &outcome {
            ChangeOutcome::Applied => self.applied += 1,
            ChangeOutcome::Duplicate => self.duplicates += 1,
            ChangeOutcome::MissingDeps | ChangeOutcome::NoProject => self.missing_deps += 1,
            ChangeOutcome::Held { .. } => self.held += 1,
            ChangeOutcome::Rejected { .. } => self.rejected += 1,
            ChangeOutcome::Deferred => self.deferred += 1,
        }
        self.outcomes.push((hash.to_owned(), outcome));
    }

    /// The outcome recorded for `hash`.
    pub fn outcome(&self, hash: &str) -> Option<&ChangeOutcome> {
        self.outcomes
            .iter()
            .find(|(h, _)| h == hash)
            .map(|(_, o)| o)
    }
}

/// Keeps what fits the batch limits; returns it and the deferred rest.
fn limit_batch(mut changes: Vec<SignedChange>) -> (Vec<SignedChange>, Vec<SignedChange>) {
    let mut bytes = 0usize;
    let keep = changes
        .iter()
        .take(MAX_BATCH_CHANGES)
        .take_while(|c| {
            bytes = bytes.saturating_add(c.bytes.len());
            bytes <= MAX_BATCH_BYTES
        })
        .count();
    let rest = changes.split_off(keep);
    (changes, rest)
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
    let (changes, rest) = limit_batch(changes);
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let row = store::project(&tx, project_id)?;
    let mut doc = store::load_doc(&tx, project_id, &MERGE_ACTOR)?;
    let mut report = ApplyReport::default();
    ingest(
        &tx,
        policy,
        &row,
        &mut doc,
        from_peer,
        changes,
        clock::now(),
        &mut report,
    )?;
    for sc in rest {
        report.push(&sc.hash, ChangeOutcome::Deferred);
    }
    tx.commit()?;
    Ok(report)
}

/// Whether `pk` was ever a member of the organization (active or removed).
fn ever_member(conn: &Connection, pk: &str) -> AppResult<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM members WHERE public_key = ?1 LIMIT 1",
            [pk],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
        .is_some())
}

fn held(code: &'static str, detail: impl Into<String>) -> ChangeOutcome {
    ChangeOutcome::Held {
        code,
        detail: detail.into(),
    }
}

/// Result of step 3 and 4 of the module docs.
enum Gate {
    /// The author may write; the parsed change.
    Ok(Box<Change>),
    /// Not allowed (yet).
    Held(ChangeOutcome),
    /// The change cannot be parsed.
    Bad(ChangeRejection),
}

/// Steps 3 and 4 of the module docs.
fn author_may_write(
    tx: &Transaction<'_>,
    policy: &dyn BoardPolicy,
    sc: &SignedChange,
    action: &BoardAction,
) -> AppResult<Gate> {
    let now = policy.check(tx, &sc.author, action);
    if now.is_err() && !ever_member(tx, &sc.author)? {
        return Ok(Gate::Held(held(
            "board_forbidden",
            format!("penulis {} bukan anggota organisasi", short(&sc.author)),
        )));
    }
    let change = match parse_change(sc) {
        Ok(c) => c,
        Err(r) => return Ok(Gate::Bad(r)),
    };
    if now.is_err()
        && let Err(e) = policy.check_at(tx, &sc.author, action, change.timestamp())
    {
        return Ok(Gate::Held(held(
            "board_forbidden",
            format!("penulis {}: {e}", short(&sc.author)),
        )));
    }
    Ok(Gate::Ok(Box::new(change)))
}

/// Creates a project from its changes as received from a peer. The first
/// change (the one without dependencies) defines the project: its author is
/// the creator and must have been allowed to create projects for that team
/// when the change was made, and its timestamp is the creation time. When
/// the project already exists this is `apply_remote_changes`.
///
/// When the project cannot be created yet (first change missing or held),
/// nothing is stored and every change gets `NoProject` (the first change
/// `Held` or `Rejected`).
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
    let (changes, rest) = limit_batch(changes);
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut report = ApplyReport::default();
    let no_project = |report: &mut ApplyReport, changes: &[SignedChange], except: Option<&str>| {
        for sc in changes {
            if Some(sc.hash.as_str()) != except && report.outcome(&sc.hash).is_none() {
                report.push(&sc.hash, ChangeOutcome::NoProject);
            }
        }
    };

    // Candidates for the first change: right project, valid envelope, no
    // dependencies. Authors who were never members are not parsed. Every
    // candidate is tried in hash order, so a bogus first change sent ahead of
    // the real one cannot block the import, and every laptop picks the same.
    let mut candidates: Vec<(SignedChange, Change)> = Vec::new();
    for sc in &changes {
        if sc.project_id != project_id || verify_envelope(sc).is_err() {
            continue;
        }
        if !ever_member(&tx, &sc.author)? {
            continue;
        }
        if let Ok(c) = parse_change(sc)
            && c.deps().is_empty()
            && !candidates.iter().any(|(x, _)| x.hash == sc.hash)
        {
            candidates.push((sc.clone(), c));
        }
    }
    candidates.sort_by(|a, b| a.0.hash.cmp(&b.0.hash));
    let mut root: Option<(SignedChange, i64, ProjectMeta)> = None;
    let mut logged = false;
    for (sc, change) in candidates {
        let creator = sc.author.clone();
        let mut probe = BoardDoc::empty(&MERGE_ACTOR);
        let time = change.timestamp();
        let probe_ok = probe.apply_remote(change, &creator).is_ok();
        let meta = probe.project();
        let meta_ok = probe_ok
            && meta.id == project_id
            && validate_project_name(&meta.name).is_ok_and(|n| n == meta.name)
            && validate_project_code(&meta.code).is_ok_and(|c| c == meta.code)
            && meta.team_id.as_deref().is_none_or(|t| crate::org::is_lower_hex(t, 32))
            && store::project_id_matches(&meta, &creator);
        if !meta_ok {
            log(
                &tx,
                from_peer,
                &ChangeRejection::new(
                    "board_bad_project",
                    format!(
                        "proyek {} perubahan {}: data proyek di perubahan pertama tidak valid",
                        short(project_id),
                        short(&sc.hash)
                    ),
                ),
                now,
            )?;
            logged = true;
            report.push(
                &sc.hash,
                ChangeOutcome::Rejected {
                    code: "board_bad_project",
                },
            );
            continue;
        }
        let create = BoardAction::CreateProject {
            team_id: meta.team_id.clone(),
        };
        if let Err(e) = policy.check_at(&tx, &creator, &create, time) {
            report.push(
                &sc.hash,
                held(
                    "board_forbidden",
                    format!("pembuat proyek {}: {e}", short(&creator)),
                ),
            );
            continue;
        }
        root = Some((sc, time, meta));
        break;
    }
    let Some((root_sc, root_time, meta)) = root else {
        no_project(&mut report, &changes, None);
        for sc in rest {
            report.push(&sc.hash, ChangeOutcome::Deferred);
        }
        if logged {
            tx.commit()?;
        }
        return Ok(report);
    };
    let creator = root_sc.author.clone();
    let created_at = OffsetDateTime::from_unix_timestamp(root_time)
        .map(clock::format_rfc3339)
        .unwrap_or_else(|_| clock::format_rfc3339(now));
    let code = store::claim_code(&tx, &meta.code, project_id, &created_at)?;
    let row = ProjectRow {
        id: meta.id.clone(),
        code,
        name: meta.name.clone(),
        team_id: meta.team_id.clone(),
        created_by: creator,
        updated_at: created_at.clone(),
        created_at,
    };
    tx.execute(
        "INSERT INTO board_projects (id, code, doc_code, name, team_id, created_by, created_at, doc, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, x'', ?8)",
        params![
            row.id,
            row.code,
            meta.code,
            row.name,
            row.team_id,
            row.created_by,
            row.created_at,
            row.updated_at
        ],
    )?;
    let mut doc = BoardDoc::empty(&MERGE_ACTOR);
    ingest(
        &tx,
        policy,
        &row,
        &mut doc,
        from_peer,
        changes,
        now,
        &mut report,
    )?;
    for sc in rest {
        report.push(&sc.hash, ChangeOutcome::Deferred);
    }
    if report.applied == 0 {
        // Dropping the transaction also drops the half-made project row and
        // any rejection logged with it; report the changes as waiting.
        let mut waiting = ApplyReport::default();
        for (hash, o) in report.outcomes {
            let o = match o {
                ChangeOutcome::MissingDeps => ChangeOutcome::NoProject,
                other => other,
            };
            waiting.push(&hash, o);
        }
        return Ok(waiting);
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

#[allow(clippy::too_many_arguments)]
fn ingest(
    tx: &Transaction<'_>,
    policy: &dyn BoardPolicy,
    row: &ProjectRow,
    doc: &mut BoardDoc,
    from_peer: Option<&str>,
    changes: Vec<SignedChange>,
    now: OffsetDateTime,
    report: &mut ApplyReport,
) -> AppResult<()> {
    let mut pending: Vec<(SignedChange, Change)> = Vec::new();
    let write = BoardAction::RemoteChange {
        project_id: row.id.clone(),
    };
    for sc in changes {
        if report.outcome(&sc.hash).is_some() || pending.iter().any(|(p, _)| p.hash == sc.hash) {
            // The same change twice in one batch: counted, reported once.
            report.duplicates += 1;
            continue;
        }
        let hash = sc.hash.parse::<ChangeHash>().ok();
        let known = match hash {
            Some(h) => doc.has_change(&h) || store::change_exists(tx, &sc.hash)?,
            None => false,
        };
        if known {
            report.push(&sc.hash, ChangeOutcome::Duplicate);
            continue;
        }
        let envelope = if sc.project_id != row.id {
            Err(ChangeRejection::new(
                "board_wrong_project",
                "perubahan untuk proyek lain dikirim ke proyek ini",
            ))
        } else {
            verify_envelope(&sc)
        };
        if let Err(r) = envelope {
            reject(tx, report, row, &sc, from_peer, r, now)?;
            continue;
        }
        match author_may_write(tx, policy, &sc, &write)? {
            Gate::Ok(change) => pending.push((sc, *change)),
            Gate::Bad(r) => reject(tx, report, row, &sc, from_peer, r, now)?,
            Gate::Held(outcome) => report.push(&sc.hash, outcome),
        }
    }

    // Apply in dependency order, one change at a time, so a bad change is
    // refused alone; whatever still misses a dependency waits.
    let mut applied_any = false;
    loop {
        let ready = pending
            .iter()
            .position(|(_, c)| c.deps().iter().all(|d| doc.has_change(d)));
        let Some(i) = ready else { break };
        let (sc, change) = pending.swap_remove(i);
        let time = change.timestamp();
        // A project document is born from its first change, which
        // `import_project` validated; every later change is judged by its
        // operations before it touches the document.
        let first = doc.project().id.is_empty();
        let needs = if first {
            rules::Needs::default()
        } else {
            match rules::judge(doc, &change) {
                Ok(n) => n,
                Err(detail) => {
                    let r = ChangeRejection::new("board_not_allowed", detail);
                    reject(tx, report, row, &sc, from_peer, r, now)?;
                    continue;
                }
            }
        };
        let mut refusal: Option<String> = None;
        if needs.manage {
            let manage = BoardAction::ManageProject {
                project_id: row.id.clone(),
            };
            if let Err(e) = policy.check_at(tx, &sc.author, &manage, time) {
                refusal = Some(format!("mengubah proyek: {e}"));
            }
        }
        for (task_id, created_by) in &needs.delete {
            if refusal.is_some() {
                break;
            }
            let delete = BoardAction::DeleteTask {
                project_id: row.id.clone(),
                task_id: task_id.clone(),
                created_by: created_by.clone(),
            };
            if let Err(e) = policy.check_at(tx, &sc.author, &delete, time) {
                refusal = Some(format!("menghapus task {}: {e}", short(task_id)));
            }
        }
        if let Some(detail) = refusal {
            report.push(
                &sc.hash,
                held(
                    "board_forbidden",
                    format!("penulis {} {detail}", short(&sc.author)),
                ),
            );
            continue;
        }
        let backup = (!needs.new_comments.is_empty() || !needs.new_activity.is_empty())
            .then(|| doc.fork());
        if let Err((code, detail)) = doc.apply_remote(change, &sc.author) {
            reject(tx, report, row, &sc, from_peer, ChangeRejection::new(code, detail), now)?;
            continue;
        }
        if let Err(detail) = rules::check_new_authorship(doc, &needs, &sc.author) {
            if let Some(b) = backup {
                *doc = b;
            }
            let r = ChangeRejection::new("board_not_allowed", detail);
            reject(tx, report, row, &sc, from_peer, r, now)?;
            continue;
        }
        store::insert_change(tx, &sc, time, from_peer, now)?;
        report.push(&sc.hash, ChangeOutcome::Applied);
        applied_any = true;
    }
    for (sc, _) in pending {
        report.push(&sc.hash, ChangeOutcome::MissingDeps);
    }
    if applied_any {
        store::save_doc(tx, row, doc, now)?;
    }
    Ok(())
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
    report.push(&sc.hash, ChangeOutcome::Rejected { code: r.code });
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
