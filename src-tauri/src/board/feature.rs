//! Board sync with colleagues' laptops: the [`FeatureSync`] of topic `board`
//! (docs/plans/sinkron-board.md).
//!
//! One record = one signed Automerge change (`SignedChange::record_body`),
//! id = BLAKE3 of the body, stored in `board_changes.record_id`.
//!
//! - Offering: only changes of projects the peer may read now
//!   (`access::Rights::can_read`), checked again for every requested id.
//!   Received changes that are not applied (`board_pending`) or refused
//!   (`board_rejected`) are never offered.
//! - Receiving: the record shape and envelope (signature) are checked first;
//!   a failure is refused for good. The rest goes per project through
//!   `sync::import_project` (which hands known projects to
//!   `apply_remote_changes`), together with what is still pending for that
//!   project, so a waiting chain continues when its missing link arrives.
//!   The outcome of each change decides where it goes:
//!
//!   | outcome | stored in |
//!   |---|---|
//!   | applied, duplicate | `board_changes` (removed from pending) |
//!   | missing parent, over the batch limit | `board_pending`, reason `deps` |
//!   | project unknown | `board_pending`, reason `project` |
//!   | author (a member) lacks the right | `board_pending`, reason `rights`, logged once |
//!   | author never a member, or a guest | `board_rejected`, logged |
//!   | refused | `board_rejected` (logged by `sync` or here) |
//!
//! - Held changes (`rights`) are retried when the membership log changes,
//!   checked in `ingest`, `record_ids_for` and `peer_connected`.
//! - `board_pending` is bounded: [`MAX_PENDING_ROWS`] and
//!   [`MAX_PENDING_BYTES`] in total, [`MAX_PENDING_PER_SENDER`] rows per
//!   sending peer; `deps` and `project` rows older than [`PENDING_MAX_AGE`]
//!   are dropped at the next `ingest`.
//! - After changes were applied to a project, duplicate task numbers are
//!   resolved (`numbers::renumber_duplicates`) and the hook is told: it
//!   checks the reminders and offers the new changes to the other peers
//!   (forwarding).
//!
//! [`BoardSyncNotifier`] is the hook for local changes: the reminders plus
//! `FeatureHub::notify_changed`. [`register`] wires both into the app.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::{Arc, Mutex, Weak};

use rusqlite::{Connection, OptionalExtension, params};
use tauri::Manager;
use time::OffsetDateTime;

use super::access::{ProjectRef, Rights};
use super::commands::BoardRuntime;
use super::numbers;
use super::policy::BatchPolicy;
use super::sign::{SignedChange, verify_envelope};
use super::store;
use super::sync::{self, BoardSyncHook, ChangeOutcome, NoopSync};
use crate::clock;
use crate::error::AppResult;
use crate::network::feature::{
    FeatureHub, FeatureIngest, FeatureRecord, FeatureSync, TOPIC_BOARD, record_id,
};
use crate::permissions;
use crate::state::{Core, MiraState};

/// Most rows in `board_pending`; records beyond it are not kept (peers offer
/// them again later).
pub const MAX_PENDING_ROWS: i64 = 20_000;
/// Most body bytes in `board_pending`.
pub const MAX_PENDING_BYTES: i64 = 64 * 1024 * 1024;
/// Most rows in `board_pending` received from one peer.
pub const MAX_PENDING_PER_SENDER: i64 = 5_000;
/// Pending `deps` and `project` rows older than this are dropped.
pub const PENDING_MAX_AGE: time::Duration = time::Duration::days(30);
/// Safety cap on apply rounds for one project in one call.
const MAX_ROUNDS: usize = 64;

/// Why a received change waits in `board_pending`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reason {
    Deps,
    Project,
    Rights,
}

impl Reason {
    fn as_str(self) -> &'static str {
        match self {
            Reason::Deps => "deps",
            Reason::Project => "project",
            Reason::Rights => "rights",
        }
    }

    fn parse(s: &str) -> Option<Reason> {
        match s {
            "deps" => Some(Reason::Deps),
            "project" => Some(Reason::Project),
            "rights" => Some(Reason::Rights),
            _ => None,
        }
    }
}

/// A change handed to `sync`: just received, or taken from `board_pending`.
#[derive(Debug, Clone)]
struct Item {
    record_id: String,
    body: String,
    sc: SignedChange,
    from: Option<String>,
    /// Why it was pending before this call; `None` for a record received now.
    was: Option<Reason>,
}

/// Counts for the records received in this call (retried ones not counted).
#[derive(Debug, Default)]
struct Tally {
    accepted: usize,
    rejected: usize,
}

/// `(project id, change)` to hand to the hook once the database lock is
/// released: applied from peers, or made here by renumbering.
type Announce = Vec<(String, SignedChange)>;

/// The board's [`FeatureSync`].
pub struct BoardFeature {
    state: MiraState,
    hook: Arc<dyn BoardSyncHook>,
    /// Membership log version at the last retry of held changes.
    membership: Mutex<Option<(i64, i64)>>,
}

impl BoardFeature {
    /// `hook` is told about changes applied here (from peers or by
    /// renumbering). In the app it is [`BoardSyncNotifier`], so reminders
    /// are checked and the changes are offered to the other peers.
    pub fn new(state: MiraState, hook: Arc<dyn BoardSyncHook>) -> Self {
        Self {
            state,
            hook,
            membership: Mutex::new(None),
        }
    }

    /// Runs `f` with the core, then tells the hook what it applied (outside
    /// the lock, also when `f` failed halfway).
    fn run<T>(&self, f: impl FnOnce(&mut Core, &mut Announce) -> AppResult<T>) -> Result<T, String> {
        let mut announce = Announce::new();
        let out = self.state.with_core(|core| f(core, &mut announce));
        for (project_id, change) in &announce {
            self.hook.on_local_change(project_id, change);
        }
        out.map_err(|e| e.to_string())
    }

    /// Retries held (`rights`) changes when the membership log changed since
    /// the last retry (always on the first call).
    fn retry_held(&self, core: &mut Core, policy: &BatchPolicy, announce: &mut Announce) -> AppResult<()> {
        let version = membership_version(&core.db)?;
        let mut last = self.membership.lock().unwrap_or_else(|e| e.into_inner());
        if *last == Some(version) {
            return Ok(());
        }
        let projects: Vec<String> = {
            let mut stmt = core.db.prepare(
                "SELECT DISTINCT project_id FROM board_pending WHERE reason = 'rights' ORDER BY project_id",
            )?;
            stmt.query_map([], |r| r.get(0))?
                .collect::<Result<_, _>>()?
        };
        let mut tally = Tally::default();
        for project_id in projects {
            process_project(core, policy, &project_id, Vec::new(), true, &mut tally, announce)?;
        }
        *last = Some(version);
        Ok(())
    }
}

impl FeatureSync for BoardFeature {
    fn topic(&self) -> &'static str {
        TOPIC_BOARD
    }

    fn record_ids_for(&self, peer: &str) -> Result<Vec<String>, String> {
        self.run(|core, announce| {
            self.retry_held(core, &BatchPolicy::new(), announce)?;
            backfill_record_ids(&core.db)?;
            let readable = readable_projects(&core.db, peer)?;
            if readable.is_empty() {
                return Ok(Vec::new());
            }
            let mut stmt = core
                .db
                .prepare("SELECT project_id, record_id FROM board_changes ORDER BY rowid")?;
            let rows = stmt.query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })?;
            let mut ids = Vec::new();
            for row in rows {
                let (project_id, id) = row?;
                if let Some(id) = id
                    && readable.contains(&project_id)
                {
                    ids.push(id);
                }
            }
            Ok(ids)
        })
    }

    fn unknown_ids(&self, ids: &[String]) -> Result<Vec<String>, String> {
        self.run(|core, _| {
            let mut seen = HashSet::new();
            let mut out = Vec::new();
            for id in ids {
                if seen.insert(id.as_str()) && !is_known(&core.db, id)? {
                    out.push(id.clone());
                }
            }
            Ok(out)
        })
    }

    fn records_for(&self, peer: &str, ids: &[String]) -> Result<Vec<FeatureRecord>, String> {
        self.run(|core, _| {
            let readable = readable_projects(&core.db, peer)?;
            if readable.is_empty() {
                return Ok(Vec::new());
            }
            let mut stmt = core.db.prepare(
                "SELECT rowid, project_id, hash, author, seq, bytes, sig FROM board_changes
                 WHERE record_id = ?1",
            )?;
            let mut seen = HashSet::new();
            let mut found: Vec<(i64, SignedChange)> = Vec::new();
            for id in ids {
                if !seen.insert(id.as_str()) {
                    continue;
                }
                let row = stmt
                    .query_row([id], |r| {
                        let seq: i64 = r.get(4)?;
                        Ok((
                            r.get::<_, i64>(0)?,
                            SignedChange {
                                project_id: r.get(1)?,
                                hash: r.get(2)?,
                                author: r.get(3)?,
                                seq: u64::try_from(seq).unwrap_or_default(),
                                bytes: r.get(5)?,
                                sig: r.get(6)?,
                            },
                        ))
                    })
                    .optional()?;
                if let Some((rowid, sc)) = row
                    && readable.contains(&sc.project_id)
                {
                    found.push((rowid, sc));
                }
            }
            // Stored order is causal order: parents before children.
            found.sort_by_key(|(rowid, _)| *rowid);
            Ok(found
                .into_iter()
                .map(|(_, sc)| FeatureRecord::new(sc.record_body()))
                .collect())
        })
    }

    fn ingest(&self, from: &str, records: Vec<FeatureRecord>) -> Result<FeatureIngest, String> {
        self.run(|core, announce| {
            // One policy per call: the membership history is loaded at most
            // once, and the membership log does not change during the call.
            let policy = BatchPolicy::new();
            let now = clock::now();
            drop_stale_pending(&core.db, now)?;
            self.retry_held(core, &policy, announce)?;
            let mut tally = Tally::default();
            let mut groups: BTreeMap<String, Vec<Item>> = BTreeMap::new();
            let mut seen = HashSet::new();
            for r in records {
                let id = record_id(&r.body);
                if !seen.insert(id.clone()) || is_known(&core.db, &id)? {
                    continue;
                }
                let checked = SignedChange::from_record_body(&r.body)
                    .and_then(|sc| verify_envelope(&sc).map(|()| sc));
                let sc = match checked {
                    Ok(sc) => sc,
                    Err(rej) => {
                        let detail = format!("record board {}: {}", short(&id), rej.detail);
                        refuse(&core.db, &id, Some(from), Some((rej.code, &detail)), now)?;
                        tally.rejected += 1;
                        continue;
                    }
                };
                groups.entry(sc.project_id.clone()).or_default().push(Item {
                    record_id: id,
                    body: r.body,
                    sc,
                    from: Some(from.to_owned()),
                    was: None,
                });
            }
            for (project_id, items) in groups {
                process_project(core, &policy, &project_id, items, false, &mut tally, announce)?;
            }
            Ok(FeatureIngest {
                accepted: tally.accepted,
                rejected: tally.rejected,
                changed: !announce.is_empty(),
            })
        })
    }

    fn peer_connected(&self, _peer: &str) {
        if let Err(e) = self.run(|core, announce| self.retry_held(core, &BatchPolicy::new(), announce)) {
            eprintln!("Mira: perubahan board yang ditahan belum bisa dicoba lagi: {e}");
        }
    }
}

/// Applies `fresh` (received now) together with the pending changes of the
/// project (`deps` and `project`, plus `rights` when `include_rights`), in
/// rounds until nothing more can be applied, then records where each change
/// ends up.
fn process_project(
    core: &mut Core,
    policy: &BatchPolicy,
    project_id: &str,
    fresh: Vec<Item>,
    include_rights: bool,
    tally: &mut Tally,
    announce: &mut Announce,
) -> AppResult<()> {
    let fresh_ids: HashSet<String> = fresh.iter().map(|i| i.record_id.clone()).collect();
    let mut items = fresh;
    items.extend(
        load_pending(&core.db, project_id, include_rights)?
            .into_iter()
            .filter(|i| !fresh_ids.contains(&i.record_id)),
    );
    if items.is_empty() {
        return Ok(());
    }
    let existed = store::project(&core.db, project_id).is_ok();
    let mut outcomes: BTreeMap<usize, ChangeOutcome> = BTreeMap::new();
    let mut waiting: BTreeSet<usize> = BTreeSet::new();
    let mut todo: Vec<usize> = (0..items.len()).collect();
    let mut last_applied: Option<usize> = None;
    for _ in 0..MAX_ROUNDS {
        if todo.is_empty() {
            break;
        }
        // One record per change hash per call; a second record with the
        // same hash (forged copy) gets no outcome and stays as it was.
        let mut hashes = HashSet::new();
        let batch: Vec<usize> = todo
            .iter()
            .copied()
            .filter(|&i| hashes.insert(items[i].sc.hash.clone()))
            .collect();
        // Logs and `received_from` name one peer per call: the sender of the
        // first change (records received now come first).
        let from = items[batch[0]].from.clone();
        let changes = batch.iter().map(|&i| items[i].sc.clone()).collect();
        let report = sync::import_project(&mut core.db, policy, project_id, from.as_deref(), changes)?;
        // A project that could not be created rolls back the rejections
        // `sync` logged with it (except a bad first change, which is kept).
        let rolled_back = !existed && store::project(&core.db, project_id).is_err();
        let mut deferred = Vec::new();
        for &i in &batch {
            let Some(outcome) = report.outcome(&items[i].sc.hash) else {
                continue;
            };
            waiting.remove(&i);
            match outcome {
                ChangeOutcome::Deferred => deferred.push(i),
                ChangeOutcome::MissingDeps | ChangeOutcome::NoProject => {
                    waiting.insert(i);
                }
                ChangeOutcome::Applied => last_applied = Some(i),
                ChangeOutcome::Rejected { code } if rolled_back && *code != "board_bad_project" => {
                    let detail = format!(
                        "proyek {} perubahan {}: ditolak ({code})",
                        short(project_id),
                        short(&items[i].sc.hash)
                    );
                    permissions::log_rejection(&core.db, items[i].from.as_deref(), None, code, &detail, clock::now())?;
                }
                _ => {}
            }
            outcomes.insert(i, outcome.clone());
        }
        // Waiting changes of this batch already saw everything it applied;
        // older waiting ones may be ready now.
        todo = deferred;
        if report.applied > 0 {
            let in_batch: HashSet<usize> = batch.iter().copied().collect();
            todo.extend(waiting.iter().copied().filter(|i| !in_batch.contains(i)));
        }
    }

    let now = clock::now();
    let tx = core.db.transaction()?;
    let mut usage = Usage::load(&tx)?;
    let rights = Rights::load(&tx)?;
    for (i, outcome) in outcomes {
        let item = &items[i];
        let fresh = item.was.is_none();
        match outcome {
            ChangeOutcome::Applied => {
                unpend(&tx, &item.record_id)?;
                if fresh {
                    tally.accepted += 1;
                }
            }
            ChangeOutcome::Duplicate => unpend(&tx, &item.record_id)?,
            ChangeOutcome::MissingDeps | ChangeOutcome::Deferred => {
                if keep(&tx, item, Reason::Deps, &mut usage, now)? && fresh {
                    tally.accepted += 1;
                }
            }
            ChangeOutcome::NoProject => {
                if keep(&tx, item, Reason::Project, &mut usage, now)? && fresh {
                    tally.accepted += 1;
                }
            }
            ChangeOutcome::Held { code, detail } => {
                let logged = item.was == Some(Reason::Rights);
                let detail = format!(
                    "proyek {} perubahan {} ditahan: {detail}",
                    short(project_id),
                    short(&item.sc.hash)
                );
                let log = (!logged).then_some((code, detail.as_str()));
                // Someone who was never a member, or a guest, cannot gain the
                // right through an op that is merely late: refused for good,
                // so random keys cannot fill the pending table.
                if !ever_member(&tx, &item.sc.author)? || rights.is_guest(&item.sc.author) {
                    refuse(&tx, &item.record_id, item.from.as_deref(), log, now)?;
                    if fresh {
                        tally.rejected += 1;
                    }
                } else if keep(&tx, item, Reason::Rights, &mut usage, now)? {
                    if let Some((code, detail)) = log {
                        permissions::log_rejection(&tx, item.from.as_deref(), None, code, detail, now)?;
                    }
                    if fresh {
                        tally.rejected += 1;
                    }
                }
            }
            ChangeOutcome::Rejected { .. } => {
                refuse(&tx, &item.record_id, item.from.as_deref(), None, now)?;
                if fresh {
                    tally.rejected += 1;
                }
            }
        }
    }
    tx.commit()?;

    if let Some(i) = last_applied {
        announce.push((project_id.to_owned(), items[i].sc.clone()));
        match numbers::renumber_duplicates(&mut core.db, &core.identity, project_id) {
            Ok(changes) => announce.extend(changes.into_iter().map(|c| (project_id.to_owned(), c))),
            Err(e) => eprintln!("Mira: nomor task ganda belum bisa dibereskan: {e}"),
        }
    }
    Ok(())
}

/// Pending changes of a project, oldest first.
fn load_pending(conn: &Connection, project_id: &str, include_rights: bool) -> AppResult<Vec<Item>> {
    let mut stmt = conn.prepare(
        "SELECT record_id, body, reason, received_from FROM board_pending
         WHERE project_id = ?1 AND (reason IN ('deps', 'project') OR (?2 AND reason = 'rights'))
         ORDER BY rowid",
    )?;
    let rows: Vec<(String, String, String, Option<String>)> = stmt
        .query_map(params![project_id, include_rights], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?
        .collect::<Result<_, _>>()?;
    let mut out = Vec::new();
    for (id, body, reason, from) in rows {
        let parsed = SignedChange::from_record_body(&body).ok();
        match (parsed, Reason::parse(&reason)) {
            (Some(sc), Some(reason)) if sc.project_id == project_id => out.push(Item {
                record_id: id,
                body,
                sc,
                from,
                was: Some(reason),
            }),
            // Only bodies that parsed are stored; drop anything else.
            _ => unpend(conn, &id)?,
        }
    }
    Ok(out)
}

/// How full `board_pending` is: in total and per sender (loaded lazily).
struct Usage {
    rows: i64,
    bytes: i64,
    per_sender: HashMap<String, i64>,
}

impl Usage {
    fn load(conn: &Connection) -> AppResult<Usage> {
        let (rows, bytes) = conn.query_row(
            "SELECT count(*), coalesce(sum(length(CAST(body AS BLOB))), 0) FROM board_pending",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        Ok(Usage {
            rows,
            bytes,
            per_sender: HashMap::new(),
        })
    }

    fn sender(&mut self, conn: &Connection, from: &str) -> AppResult<&mut i64> {
        if !self.per_sender.contains_key(from) {
            let n: i64 = conn.query_row(
                "SELECT count(*) FROM board_pending WHERE received_from = ?1",
                [from],
                |r| r.get(0),
            )?;
            self.per_sender.insert(from.to_owned(), n);
        }
        Ok(self.per_sender.entry(from.to_owned()).or_default())
    }
}

/// Stores or updates `item` in `board_pending`; `false` when a new row does
/// not fit the limits (total rows and bytes, rows per sender), then it is not
/// kept at all.
fn keep(
    conn: &Connection,
    item: &Item,
    reason: Reason,
    usage: &mut Usage,
    now: OffsetDateTime,
) -> AppResult<bool> {
    if item.was.is_some() {
        conn.execute(
            "UPDATE board_pending SET reason = ?2 WHERE record_id = ?1",
            params![item.record_id, reason.as_str()],
        )?;
        return Ok(true);
    }
    let size = i64::try_from(item.body.len()).unwrap_or(i64::MAX);
    if usage.rows >= MAX_PENDING_ROWS || usage.bytes.saturating_add(size) > MAX_PENDING_BYTES {
        return Ok(false);
    }
    if let Some(from) = &item.from
        && *usage.sender(conn, from)? >= MAX_PENDING_PER_SENDER
    {
        return Ok(false);
    }
    let n = conn.execute(
        "INSERT OR IGNORE INTO board_pending
           (record_id, project_id, hash, author, body, reason, received_from, received_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            item.record_id,
            item.sc.project_id,
            item.sc.hash,
            item.sc.author,
            item.body,
            reason.as_str(),
            item.from,
            clock::format_rfc3339(now)
        ],
    )?;
    if n == 1 {
        usage.rows += 1;
        usage.bytes = usage.bytes.saturating_add(size);
        if let Some(from) = &item.from {
            *usage.sender(conn, from)? += 1;
        }
    }
    Ok(true)
}

/// Drops `deps` and `project` rows older than [`PENDING_MAX_AGE`]; their
/// missing changes are not coming (peers offer them again if they have them).
fn drop_stale_pending(conn: &Connection, now: OffsetDateTime) -> AppResult<()> {
    conn.execute(
        "DELETE FROM board_pending WHERE reason IN ('deps', 'project') AND received_at < ?1",
        [clock::format_rfc3339(now - PENDING_MAX_AGE)],
    )?;
    Ok(())
}

/// Whether `pk` has a row in `members` (active or removed).
fn ever_member(conn: &Connection, pk: &str) -> AppResult<bool> {
    Ok(conn
        .query_row("SELECT 1 FROM members WHERE public_key = ?1 LIMIT 1", [pk], |r| {
            r.get::<_, i64>(0)
        })
        .optional()?
        .is_some())
}

fn unpend(conn: &Connection, record_id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM board_pending WHERE record_id = ?1", [record_id])?;
    Ok(())
}

/// Refuses a record for good; logs it when `log` is given (`sync` already
/// logged the ones it refused).
fn refuse(
    conn: &Connection,
    record_id: &str,
    from: Option<&str>,
    log: Option<(&str, &str)>,
    now: OffsetDateTime,
) -> AppResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO board_rejected (record_id, at) VALUES (?1, ?2)",
        params![record_id, clock::format_rfc3339(now)],
    )?;
    unpend(conn, record_id)?;
    if let Some((code, detail)) = log {
        permissions::log_rejection(conn, from, None, code, detail, now)?;
    }
    Ok(())
}

/// Stored, pending or refused.
fn is_known(conn: &Connection, record_id: &str) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM board_changes WHERE record_id = ?1)
             OR EXISTS (SELECT 1 FROM board_pending WHERE record_id = ?1)
             OR EXISTS (SELECT 1 FROM board_rejected WHERE record_id = ?1)",
        [record_id],
        |r| r.get(0),
    )?)
}

/// Fills `record_id` for rows stored before it existed.
fn backfill_record_ids(conn: &Connection) -> AppResult<()> {
    let rows: Vec<(i64, SignedChange)> = {
        let mut stmt = conn.prepare(
            "SELECT rowid, project_id, hash, author, seq, bytes, sig FROM board_changes
             WHERE record_id IS NULL",
        )?;
        stmt.query_map([], |r| {
            let seq: i64 = r.get(4)?;
            Ok((
                r.get(0)?,
                SignedChange {
                    project_id: r.get(1)?,
                    hash: r.get(2)?,
                    author: r.get(3)?,
                    seq: u64::try_from(seq).unwrap_or_default(),
                    bytes: r.get(5)?,
                    sig: r.get(6)?,
                },
            ))
        })?
        .collect::<Result<_, _>>()?
    };
    for (rowid, sc) in rows {
        conn.execute(
            "UPDATE board_changes SET record_id = ?2 WHERE rowid = ?1",
            params![rowid, sc.record_id()],
        )?;
    }
    Ok(())
}

/// Ids of the projects whose changes may be offered to `peer` now.
fn readable_projects(conn: &Connection, peer: &str) -> AppResult<HashSet<String>> {
    let rights = Rights::load(conn)?;
    let mut stmt = conn.prepare("SELECT id, team_id, created_by FROM board_projects")?;
    let rows: Vec<(String, Option<String>, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_, _>>()?;
    let mut out = HashSet::new();
    for (id, team, creator) in rows {
        let p = ProjectRef {
            id: &id,
            team_id: team.as_deref(),
            created_by: &creator,
        };
        if offerable(conn, &rights, peer, p)? {
            out.insert(id);
        }
    }
    Ok(out)
}

/// The one per-project check before offering or sending a project's
/// changes to `peer` (`record_ids_for` and `records_for` both go through
/// it). Further conditions on the project itself belong here.
fn offerable(_conn: &Connection, rights: &Rights, peer: &str, p: ProjectRef<'_>) -> AppResult<bool> {
    Ok(rights.can_read(peer, p))
}

/// Changes whenever an op is added to the membership log.
fn membership_version(conn: &Connection) -> AppResult<(i64, i64)> {
    Ok(conn.query_row(
        "SELECT count(*), coalesce(max(rowid), 0) FROM org_ops",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?)
}

fn short(s: &str) -> &str {
    s.get(..16).unwrap_or(s)
}

/// Where [`BoardSyncNotifier`] finds the hub, looked up at every call.
pub trait HubSource: Send + Sync + 'static {
    fn hub(&self) -> Option<Arc<FeatureHub>>;
}

impl HubSource for Arc<FeatureHub> {
    fn hub(&self) -> Option<Arc<FeatureHub>> {
        Some(Arc::clone(self))
    }
}

impl HubSource for Weak<FeatureHub> {
    fn hub(&self) -> Option<Arc<FeatureHub>> {
        self.upgrade()
    }
}

/// The hub managed by Tauri; `None` until it is managed (it is managed after
/// `BoardRuntime` in `lib.rs`).
impl<R: tauri::Runtime> HubSource for tauri::AppHandle<R> {
    fn hub(&self) -> Option<Arc<FeatureHub>> {
        self.try_state::<Arc<FeatureHub>>()
            .map(|s| Arc::clone(s.inner()))
    }
}

/// Hook for board changes made on this laptop: runs the previous hook (the
/// deadline reminders) and offers the change to peers through the hub.
pub struct BoardSyncNotifier {
    inner: Arc<dyn BoardSyncHook>,
    hub: Box<dyn HubSource>,
}

impl BoardSyncNotifier {
    pub fn new(inner: Arc<dyn BoardSyncHook>, hub: impl HubSource) -> Self {
        Self {
            inner,
            hub: Box::new(hub),
        }
    }
}

impl BoardSyncHook for BoardSyncNotifier {
    fn on_local_change(&self, project_id: &str, change: &SignedChange) {
        self.inner.on_local_change(project_id, change);
        if let Some(hub) = self.hub.hub() {
            hub.notify_changed(TOPIC_BOARD);
        }
    }
}

/// Registers the board's [`FeatureSync`] with the managed hub. Its hook is
/// `BoardRuntime::hook` (reminders and hub), so changes received from a peer
/// are checked for reminders and offered on to the others.
pub fn register<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let (Some(hub), Some(state)) = (
        app.try_state::<Arc<FeatureHub>>(),
        app.try_state::<MiraState>(),
    ) else {
        return;
    };
    let hook = app
        .try_state::<BoardRuntime>()
        .map(|r| Arc::clone(&r.hook))
        .unwrap_or_else(|| Arc::new(NoopSync));
    hub.register(Arc::new(BoardFeature::new(state.inner().clone(), hook)));
}

#[cfg(test)]
mod tests;
