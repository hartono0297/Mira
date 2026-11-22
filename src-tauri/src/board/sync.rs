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
//! 3. an author who may not write now and was never a member is `Held`
//!    without parsing anything;
//! 4. parsing (`sign::parse_change`): `Rejected` on failure;
//! 5. the author may write in the project (see "Rights lost later" below),
//!    otherwise `Held`;
//! 6. applied alone, in dependency order. Only the project's first change
//!    (the one `import_project` picked) skips `rules::judge`; any other
//!    change without dependencies is `Rejected`. Every other change is
//!    judged by its operations (`Rejected` when refused), tasks it deletes
//!    need `DeleteTask` and a changed project name or code needs
//!    `ManageProject` (see below, otherwise `Held`). Then the document shape
//!    is checked (`BoardDoc::apply_remote`) and the project id must still be
//!    the stored one; on failure `Rejected` and the document is restored;
//! 7. whatever still misses a parent change: `MissingDeps`.
//!
//! Rights lost later. Each right (write, delete a task, manage the project,
//! create the project for the first change) is checked against the current
//! membership first. When the author lacks it now, the change is accepted
//! only when both hold:
//! - the author had the right when the change was made
//!   (`BoardPolicy::check_at`, `access::RightsHistory::allowed_at`); and
//! - the change is supported: another change of the same batch, written by
//!   someone else who may write in the project now, depends on it directly
//!   or through a chain of dependencies inside the batch.
//!
//! The change's time is the author's own clock, so the history alone would
//! let someone who lost a right backdate a change. A colleague who still has
//! the right and built on the change has seen it before the loss reached
//! them, which a backdated change cannot get. This applies to everyone:
//! members moved out of a team or demoted, and people removed from the
//! organization. An unsupported change stays `Held`; it is accepted in a
//! later batch that also holds a supporting change (the caller retries held
//! changes together with the project's other pending changes).
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

use std::collections::{HashMap, HashSet};

use automerge::{Change, ChangeHash};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use time::OffsetDateTime;

use super::access::{ProjectRef, Rights};
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
        None,
        clock::now(),
        &mut report,
    )?;
    for sc in rest {
        report.push(&sc.hash, ChangeOutcome::Deferred);
    }
    tx.commit()?;
    Ok(report)
}

/// The parsed changes of one batch and who builds on whom, to tell whether
/// a change is supported (module docs, "Rights lost later").
struct BatchGraph {
    /// `(hash, author)` per change.
    nodes: Vec<(String, String)>,
    /// Dependency hash -> changes of the batch that list it.
    children: HashMap<String, Vec<usize>>,
}

impl BatchGraph {
    fn new<'a>(changes: impl IntoIterator<Item = (&'a SignedChange, &'a Change)>) -> BatchGraph {
        let mut nodes = Vec::new();
        let mut children: HashMap<String, Vec<usize>> = HashMap::new();
        for (sc, change) in changes {
            let i = nodes.len();
            nodes.push((change.hash().to_string(), sc.author.clone()));
            for dep in change.deps() {
                children.entry(dep.to_string()).or_default().push(i);
            }
        }
        BatchGraph { nodes, children }
    }

    /// Whether a change of the batch that depends on `hash`, directly or
    /// through other changes of the batch, was written by someone other
    /// than `author` for whom `writes_now` holds.
    fn supported(&self, hash: &str, author: &str, writes_now: impl Fn(&str) -> bool) -> bool {
        let mut seen: HashSet<usize> = HashSet::new();
        let mut todo = vec![hash];
        while let Some(h) = todo.pop() {
            for &i in self.children.get(h).into_iter().flatten() {
                if !seen.insert(i) {
                    continue;
                }
                let (child, by) = &self.nodes[i];
                if by != author && writes_now(by) {
                    return true;
                }
                todo.push(child);
            }
        }
        false
    }
}

/// Appended to the reason when a right the author had at the change's time
/// still lacks a colleague's support.
const UNSUPPORTED: &str = "Perubahan ini dibuat saat penulis masih berhak, dan akan diterima begitu ada rekan yang masih berhak melanjutkannya.";

/// `Ok(Ok(()))` when `author` may do `action` now, or had the right at `at`
/// and `supported()` holds (module docs, "Rights lost later"); otherwise
/// `Ok(Err(reason))`.
fn may_do(
    tx: &Transaction<'_>,
    policy: &dyn BoardPolicy,
    author: &str,
    action: &BoardAction,
    at: i64,
    supported: impl FnOnce() -> bool,
) -> AppResult<Result<(), String>> {
    let Err(now) = policy.check(tx, author, action) else {
        return Ok(Ok(()));
    };
    if let Err(e) = policy.check_at(tx, author, action, at) {
        return Ok(Err(e.to_string()));
    }
    if supported() {
        Ok(Ok(()))
    } else {
        Ok(Err(format!("{now} {UNSUPPORTED}")))
    }
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

/// Creates a project from its changes as received from a peer. The first
/// change (the one without dependencies) defines the project: its author is
/// the creator and must be allowed to create projects for that team (now,
/// or at the change's time with a colleague's support, module docs), and its
/// timestamp is the creation time. When the project already exists this is
/// `apply_remote_changes`.
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

    // Every change of the batch with the right project and a valid envelope
    // is parsed (authors who were never members are not), to tell whether a
    // first change is supported. Candidates for the first change are those
    // without dependencies. Every candidate is tried in hash order, so a
    // bogus first change sent ahead of the real one cannot block the import,
    // and every laptop picks the same.
    let mut parsed: Vec<(SignedChange, Change)> = Vec::new();
    for sc in &changes {
        if sc.project_id != project_id || verify_envelope(sc).is_err() {
            continue;
        }
        if parsed.iter().any(|(x, _)| x.hash == sc.hash) || !ever_member(&tx, &sc.author)? {
            continue;
        }
        if let Ok(c) = parse_change(sc) {
            parsed.push((sc.clone(), c));
        }
    }
    let graph = BatchGraph::new(parsed.iter().map(|(sc, c)| (sc, c)));
    let mut candidates: Vec<(SignedChange, Change)> = parsed
        .into_iter()
        .filter(|(_, c)| c.deps().is_empty())
        .collect();
    candidates.sort_by(|a, b| a.0.hash.cmp(&b.0.hash));
    let mut rights: Option<Rights> = None;
    let mut root: Option<(SignedChange, i64, ProjectMeta)> = None;
    let mut logged = false;
    for (sc, change) in candidates {
        let creator = sc.author.clone();
        // Refused before anything is applied, as `rules::judge` does for
        // every later change.
        if change.len() > rules::MAX_CHANGE_OPS {
            log(
                &tx,
                from_peer,
                &ChangeRejection::new(
                    "board_bad_project",
                    format!(
                        "proyek {} perubahan {}: perubahan pertama berisi {} operasi, lebih dari batas {}",
                        short(project_id),
                        short(&sc.hash),
                        change.len(),
                        rules::MAX_CHANGE_OPS
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
        let mut probe = BoardDoc::empty(&MERGE_ACTOR);
        let time = change.timestamp();
        let probe_ok = probe.apply_remote(change, &creator).is_ok();
        let meta = probe.project();
        let meta_ok = probe_ok
            && meta.id == project_id
            && validate_project_name(&meta.name).is_ok_and(|n| n == meta.name)
            && validate_project_code(&meta.code).is_ok_and(|c| c == meta.code)
            && meta.team_id.as_deref().is_none_or(|t| crate::org::is_lower_hex(t, 32))
            && store::project_id_matches(&probe, &creator);
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
        if rights.is_none() {
            rights = Some(Rights::load(&tx)?);
        }
        let writes_now = |pk: &str| {
            rights.as_ref().is_some_and(|r| {
                r.can_write(
                    pk,
                    ProjectRef {
                        id: project_id,
                        team_id: meta.team_id.as_deref(),
                        created_by: &creator,
                    },
                )
            })
        };
        let allowed = may_do(&tx, policy, &creator, &create, time, || {
            graph.supported(&sc.hash, &creator, writes_now)
        })?;
        if let Err(e) = allowed {
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
        Some(&root_sc.hash),
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

/// Steps 1 to 7 of the module docs for one batch. `root` is the hash of the
/// project's first change when `import_project` creates the project now: the
/// only change allowed to skip `rules::judge`.
#[allow(clippy::too_many_arguments)]
fn ingest(
    tx: &Transaction<'_>,
    policy: &dyn BoardPolicy,
    row: &ProjectRow,
    doc: &mut BoardDoc,
    from_peer: Option<&str>,
    changes: Vec<SignedChange>,
    root: Option<&str>,
    now: OffsetDateTime,
    report: &mut ApplyReport,
) -> AppResult<()> {
    let write = BoardAction::RemoteChange {
        project_id: row.id.clone(),
    };
    // Steps 1 to 4: every change that may be judged further is parsed, also
    // when its author may not write now, so support can be told.
    let mut parsed: Vec<(SignedChange, Change)> = Vec::new();
    let mut writes_now: HashMap<String, bool> = HashMap::new();
    for sc in changes {
        if report.outcome(&sc.hash).is_some() || parsed.iter().any(|(p, _)| p.hash == sc.hash) {
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
        let writer = match writes_now.get(&sc.author) {
            Some(w) => *w,
            None => {
                let w = policy.check(tx, &sc.author, &write).is_ok();
                writes_now.insert(sc.author.clone(), w);
                w
            }
        };
        if !writer && !ever_member(tx, &sc.author)? {
            report.push(
                &sc.hash,
                held(
                    "board_forbidden",
                    format!("penulis {} bukan anggota organisasi", short(&sc.author)),
                ),
            );
            continue;
        }
        match parse_change(&sc) {
            Ok(change) => parsed.push((sc, change)),
            Err(r) => reject(tx, report, row, &sc, from_peer, r, now)?,
        }
    }
    let graph = BatchGraph::new(parsed.iter().map(|(sc, c)| (sc, c)));
    let writer = |pk: &str| writes_now.get(pk).copied().unwrap_or(false);
    let supported = |sc: &SignedChange| graph.supported(&sc.hash, &sc.author, writer);

    // Step 5: the write right.
    let mut pending: Vec<(SignedChange, Change)> = Vec::new();
    for (sc, change) in parsed {
        if writer(&sc.author) {
            pending.push((sc, change));
            continue;
        }
        match may_do(tx, policy, &sc.author, &write, change.timestamp(), || supported(&sc))? {
            Ok(()) => pending.push((sc, change)),
            Err(e) => report.push(
                &sc.hash,
                held("board_forbidden", format!("penulis {}: {e}", short(&sc.author))),
            ),
        }
    }

    // Step 6: apply in dependency order, one change at a time, so a bad
    // change is refused alone; whatever still misses a dependency waits.
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
        // operations before it touches the document. Every change of a
        // project builds on its first change, so any other change without
        // dependencies is refused whatever it contains.
        let is_root = root == Some(sc.hash.as_str());
        let needs = if is_root {
            rules::Needs::default()
        } else if change.deps().is_empty() {
            let r = ChangeRejection::new(
                "board_not_allowed",
                "perubahan tanpa induk, padahal bukan perubahan pertama proyek",
            );
            reject(tx, report, row, &sc, from_peer, r, now)?;
            continue;
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
            if let Err(e) = may_do(tx, policy, &sc.author, &manage, time, || supported(&sc))? {
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
            if let Err(e) = may_do(tx, policy, &sc.author, &delete, time, || supported(&sc))? {
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
        let backup = (is_root || !needs.new_comments.is_empty() || !needs.new_activity.is_empty())
            .then(|| doc.fork());
        let applied_hash = change.hash();
        if let Err((code, detail)) = doc.apply_remote(change, &sc.author) {
            reject(tx, report, row, &sc, from_peer, ChangeRejection::new(code, detail), now)?;
            continue;
        }
        let after = if doc.project().id != row.id {
            Err(ChangeRejection::new(
                "board_invalid_doc",
                "perubahan mengubah id proyek di dokumen",
            ))
        } else {
            rules::check_new_authorship(doc, &needs, &sc.author)
                .map_err(|detail| ChangeRejection::new("board_not_allowed", detail))
        };
        if let Err(r) = after {
            *doc = match backup {
                Some(b) => b,
                None => without_change(doc, applied_hash)?,
            };
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

/// `doc` rebuilt without `hash`, the change applied last (nothing depends on
/// it yet), for a refusal after applying without a backup at hand.
fn without_change(doc: &mut BoardDoc, hash: ChangeHash) -> AppResult<BoardDoc> {
    let mut out = BoardDoc::empty(&MERGE_ACTOR);
    for change in doc.changes_after(&[]) {
        if change.hash() != hash {
            out.apply(change)?;
        }
    }
    Ok(out)
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
/// `(number, task ids sorted by (created_at, id))`. The first task of each
/// group keeps the number; `numbers::renumber_duplicates` renumbers the rest.
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

#[cfg(test)]
mod tests;
