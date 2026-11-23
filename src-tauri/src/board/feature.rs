//! Board sync with colleagues' laptops: the [`FeatureSync`] of topic `board`
//! (docs/plans/sinkron-board.md).
//!
//! One record = one signed Automerge change (`SignedChange::record_body`),
//! id = BLAKE3 of the body, stored in `board_changes.record_id`.
//!
//! - Offering: only changes of projects the peer may read now
//!   (`access::Rights::can_read`), checked again for every requested id.
//!   Received changes that are not applied (`board_pending`) or refused
//!   (`board_rejected`) are never offered. One `records_for` call returns at
//!   most [`MAX_RECORDS_FOR_BYTES`] of bodies; the peer asks for the rest
//!   in its next round (they are still unknown there).
//! - Receiving: the record shape and envelope (signature) are checked first;
//!   a failure is refused for good. The rest goes per project through
//!   `sync::import_project` (which hands known projects to
//!   `apply_remote_changes`), together with what is still pending for that
//!   project, so a waiting chain continues when its missing link arrives.
//!   Changes are handed to `sync` one sending peer at a time, so its logs
//!   and `received_from` name the peer that sent each change. The outcome of
//!   each change decides where it goes:
//!
//!   | outcome | stored in |
//!   |---|---|
//!   | applied, duplicate | `board_changes` (removed from pending) |
//!   | missing parent, over the batch limit | `board_pending`, reason `deps` |
//!   | project unknown | `board_pending`, reason `project` |
//!   | author (a member) lacks the right | `board_pending`, reason `rights`, logged once |
//!   | author is a guest now and lacks the right | nothing |
//!   | refused | `board_rejected` (logged by `sync` or here) |
//!
//!   Only authors this laptop has seen as members (a row in `members`,
//!   active or removed) get a `board_pending` row. For anyone else nothing is
//!   stored or logged, whatever the outcome: the op admitting them may still
//!   be on its way, so the record is offered and checked again later, and
//!   keys outside the organization cannot fill the table. A held change of
//!   someone who is a guest here is treated the same way: the op making them
//!   a member may still be on its way, and refusing it for good would leave
//!   this laptop without a change the others accept.
//!
//! - Held changes (`rights`) are retried when the membership log changes,
//!   checked in `ingest`, `record_ids_for` and `peer_connected`.
//! - `board_pending` is bounded: [`MAX_PENDING_ROWS`] and
//!   [`MAX_PENDING_BYTES`] in total, [`MAX_PENDING_PER_SENDER`] rows and
//!   [`MAX_PENDING_BYTES_PER_SENDER`] per sending peer. At the next `ingest`,
//!   `deps` and `project` rows older than [`PENDING_MAX_AGE`] and `rights`
//!   rows older than [`PENDING_RIGHTS_MAX_AGE`] are dropped (age counts from
//!   the first receipt, also after the reason changed).
//! - After changes were applied to a project, duplicate task numbers are
//!   resolved (`numbers::renumber_duplicates`) and the hook is told: it
//!   checks the reminders and offers the new changes to the other peers
//!   (forwarding).
//!
//! - When the change rules grow (v0.4: subtasks and time entries), records
//!   an older version refused for good may be fine now. [`reset_rejected_once`]
//!   empties `board_rejected` once per rules version, so peers offer those
//!   records again and the new rules judge them; changes waiting on them
//!   follow. Records that are still wrong are refused again.
//!
//! [`BoardSyncNotifier`] is the hook for local changes: the reminders plus
//! `FeatureHub::notify_changed`. [`register`] wires both into the app.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};

use rusqlite::{Connection, OptionalExtension, Row, params};
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
use crate::settings;
use crate::state::{Core, MiraState};

/// Setting that records which change rules `board_rejected` was last
/// emptied for ([`reset_rejected_once`]).
pub const RULES_VERSION_KEY: &str = "board.rules_version";
/// Version of `rules.rs`: 2 = v0.4 (subtasks and time entries).
pub const RULES_VERSION: i64 = 2;

/// Empties `board_rejected` once for [`RULES_VERSION`] and records it in
/// `settings`; `true` when it did. Records refused under older rules are
/// then asked for and judged again.
pub fn reset_rejected_once(conn: &Connection) -> AppResult<bool> {
    let done = settings::get(conn, RULES_VERSION_KEY)?
        .and_then(|v| v.trim().parse::<i64>().ok())
        .is_some_and(|v| v >= RULES_VERSION);
    if done {
        return Ok(false);
    }
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM board_rejected", [])?;
    settings::set(&tx, RULES_VERSION_KEY, &RULES_VERSION.to_string())?;
    tx.commit()?;
    Ok(true)
}

/// Most rows in `board_pending`; records beyond it are not kept (peers offer
/// them again later).
pub const MAX_PENDING_ROWS: i64 = 20_000;
/// Most body bytes in `board_pending`.
pub const MAX_PENDING_BYTES: i64 = 64 * 1024 * 1024;
/// Most rows in `board_pending` received from one peer.
pub const MAX_PENDING_PER_SENDER: i64 = 5_000;
/// Most body bytes in `board_pending` received from one peer.
pub const MAX_PENDING_BYTES_PER_SENDER: i64 = 8 * 1024 * 1024;
/// Pending `deps` and `project` rows older than this are dropped.
pub const PENDING_MAX_AGE: time::Duration = time::Duration::days(30);
/// Pending `rights` rows older than this are dropped; the right is not
/// coming (peers offer the change again if it is ever allowed).
pub const PENDING_RIGHTS_MAX_AGE: time::Duration = time::Duration::days(90);
/// Most body bytes one `records_for` call returns.
pub const MAX_RECORDS_FOR_BYTES: usize = 8 * 1024 * 1024;
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
    /// [`reset_rejected_once`] ran (it also runs in [`register`]; this
    /// covers a start where the database was not ready yet).
    rules_checked: AtomicBool,
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
            rules_checked: AtomicBool::new(false),
        }
    }

    /// Runs `f` with the core, then tells the hook what it applied (outside
    /// the lock, also when `f` failed halfway).
    fn run<T>(&self, f: impl FnOnce(&mut Core, &mut Announce) -> AppResult<T>) -> Result<T, String> {
        let mut announce = Announce::new();
        let out = self.state.with_core(|core| {
            if !self.rules_checked.load(Ordering::Relaxed) {
                reset_rejected_once(&core.db)?;
                self.rules_checked.store(true, Ordering::Relaxed);
            }
            f(core, &mut announce)
        });
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
            // Rows first, without their bytes: only what fits is loaded.
            let mut find =
                core.db.prepare("SELECT rowid, project_id FROM board_changes WHERE record_id = ?1")?;
            let mut seen = HashSet::new();
            let mut rowids = Vec::new();
            for id in ids {
                if !seen.insert(id.as_str()) {
                    continue;
                }
                let row = find
                    .query_row([id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
                    .optional()?;
                if let Some((rowid, project_id)) = row
                    && readable.contains(&project_id)
                {
                    rowids.push(rowid);
                }
            }
            // Stored order is causal order: parents before children.
            rowids.sort_unstable();
            let mut load = core.db.prepare(
                "SELECT project_id, hash, author, seq, bytes, sig FROM board_changes WHERE rowid = ?1",
            )?;
            let mut out = Vec::new();
            let mut total = 0usize;
            for rowid in rowids {
                let body = load.query_row([rowid], |r| change_at(r, 0))?.record_body();
                // The rest stays unknown on the peer, which asks again next
                // round. The first record always goes, so every call helps.
                if !out.is_empty() && total.saturating_add(body.len()) > MAX_RECORDS_FOR_BYTES {
                    break;
                }
                total = total.saturating_add(body.len());
                out.push(FeatureRecord::new(body));
            }
            Ok(out)
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
                process_project(core, &policy, &project_id, items, true, &mut tally, announce)?;
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
    // Waiting change -> `applied` right after its last try. A waiting change
    // already saw everything applied in its own import; it is tried again
    // once something was applied after that.
    let mut waiting: BTreeMap<usize, usize> = BTreeMap::new();
    let mut applied = 0usize;
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
        let mut deferred = Vec::new();
        // One import for all of them: `sync` needs the whole batch to see
        // which held change a current writer has built on ("didukung").
        // Refusals and `received_from` are logged under the sender of the
        // first record (records received now come first).
        {
            let group = batch.clone();
            let from = items[group[0]].from.clone();
            let changes = group.iter().map(|&i| items[i].sc.clone()).collect();
            let report = sync::import_project(&mut core.db, policy, project_id, from.as_deref(), changes)?;
            applied += report.applied;
            // A project that could not be created rolls back the rejections
            // `sync` logged with it (except a bad first change, which is kept).
            let rolled_back = !existed && store::project(&core.db, project_id).is_err();
            for &i in &group {
                let Some(outcome) = report.outcome(&items[i].sc.hash) else {
                    continue;
                };
                waiting.remove(&i);
                match outcome {
                    ChangeOutcome::Deferred => deferred.push(i),
                    ChangeOutcome::MissingDeps | ChangeOutcome::NoProject => {
                        waiting.insert(i, applied);
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
        }
        todo = deferred;
        todo.extend(waiting.iter().filter(|&(_, &seen)| seen < applied).map(|(&i, _)| i));
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
            ChangeOutcome::MissingDeps | ChangeOutcome::Deferred | ChangeOutcome::NoProject => {
                let reason = if matches!(outcome, ChangeOutcome::NoProject) {
                    Reason::Project
                } else {
                    Reason::Deps
                };
                // Kept only for authors seen as members (see the module doc).
                if !ever_member(&tx, &item.sc.author)? {
                    unpend(&tx, &item.record_id)?;
                } else if keep(&tx, item, reason, &mut usage, now)? && fresh {
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
                // Someone this laptop has never seen as a member, or knows
                // only as a guest: nothing is stored or logged (see the
                // module doc).
                if !ever_member(&tx, &item.sc.author)? || rights.is_guest(&item.sc.author) {
                    unpend(&tx, &item.record_id)?;
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
    per_sender: HashMap<String, SenderUsage>,
}

/// Rows and body bytes in `board_pending` received from one peer.
#[derive(Debug, Clone, Copy, Default)]
struct SenderUsage {
    rows: i64,
    bytes: i64,
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

    fn sender(&mut self, conn: &Connection, from: &str) -> AppResult<&mut SenderUsage> {
        if !self.per_sender.contains_key(from) {
            let (rows, bytes) = conn.query_row(
                "SELECT count(*), coalesce(sum(length(CAST(body AS BLOB))), 0) FROM board_pending
                 WHERE received_from = ?1",
                [from],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            self.per_sender.insert(from.to_owned(), SenderUsage { rows, bytes });
        }
        Ok(self.per_sender.entry(from.to_owned()).or_default())
    }
}

/// Stores or updates `item` in `board_pending`; `false` when a new row does
/// not fit the limits (rows and bytes, in total and per sender), then it is
/// not kept at all.
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
    if let Some(from) = &item.from {
        let sender = *usage.sender(conn, from)?;
        if sender.rows >= MAX_PENDING_PER_SENDER
            || sender.bytes.saturating_add(size) > MAX_PENDING_BYTES_PER_SENDER
        {
            return Ok(false);
        }
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
            let sender = usage.sender(conn, from)?;
            sender.rows += 1;
            sender.bytes = sender.bytes.saturating_add(size);
        }
    }
    Ok(true)
}

/// Drops `deps` and `project` rows older than [`PENDING_MAX_AGE`] and
/// `rights` rows older than [`PENDING_RIGHTS_MAX_AGE`]: what they wait for is
/// not coming (peers offer the changes again if they have them).
fn drop_stale_pending(conn: &Connection, now: OffsetDateTime) -> AppResult<()> {
    conn.execute(
        "DELETE FROM board_pending
         WHERE (reason IN ('deps', 'project') AND received_at < ?1)
            OR (reason = 'rights' AND received_at < ?2)",
        params![
            clock::format_rfc3339(now - PENDING_MAX_AGE),
            clock::format_rfc3339(now - PENDING_RIGHTS_MAX_AGE)
        ],
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
        stmt.query_map([], |r| Ok((r.get(0)?, change_at(r, 1)?)))?
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

/// A stored change from the columns `project_id, hash, author, seq, bytes,
/// sig`, starting at column `at`.
fn change_at(r: &Row<'_>, at: usize) -> rusqlite::Result<SignedChange> {
    let seq: i64 = r.get(at + 3)?;
    Ok(SignedChange {
        project_id: r.get(at)?,
        hash: r.get(at + 1)?,
        author: r.get(at + 2)?,
        seq: u64::try_from(seq).unwrap_or_default(),
        bytes: r.get(at + 4)?,
        sig: r.get(at + 5)?,
    })
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
fn offerable(conn: &Connection, rights: &Rights, peer: &str, p: ProjectRef<'_>) -> AppResult<bool> {
    // Projects made before ids were bound stay on this laptop: other laptops
    // could not tell their first change from a forged one.
    Ok(rights.can_read(peer, p) && store::is_syncable(conn, p.id)?)
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

/// The hub managed by Tauri; `None` until it is managed (it is managed before
/// `AppNet::new` in `lib.rs`).
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
    // v0.4: records refused by the older rules are judged again.
    if let Err(err) = state.with_core(|core| reset_rejected_once(&core.db)) {
        eprintln!(
            "Mira: daftar perubahan board yang ditolak belum bisa disegarkan [{}]: {err}",
            err.code()
        );
    }
    hub.register(Arc::new(BoardFeature::new(state.inner().clone(), hook)));
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod convergence_tests;
