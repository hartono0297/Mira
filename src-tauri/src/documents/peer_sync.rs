//! Sync of the document library with rekan (`TOPIC_DOCS`, plan
//! `docs/plans/sinkron-dokumen-ttd.md`, bagian 4).
//!
//! Records are signed envelopes (`envelope`, domain `mira-docs-v1`) whose
//! payload is a [`DocPayload`]:
//! - `doc`: a [`RemoteDocument`], signed by its creator;
//! - `ver`: a [`RemoteVersion`], signed by its author;
//! - `edit`: an [`EditMark`] ("Sedang diedit"), signed by the editor. Only the
//!   latest per (document, editor) is kept and it is offered only while fresh
//!   ([`REMOTE_EDITING_STALE_SECS`]). While this laptop edits, the mark is
//!   repeated every [`EDIT_REFRESH_SECS`] ([`DocsPeerSync::refresh_editing`]).
//!
//! Every record is stored in `docs_sync_records` with its exact body, so any
//! laptop can forward it unchanged and the receiver still checks the author's
//! signature.
//!
//! Rules:
//! - Sending ([`FeatureSync::record_ids_for`], [`FeatureSync::records_for`]):
//!   only records of documents the peer may view (`scope::may_view`), from
//!   authors who are still active members, edit marks only while fresh.
//! - Receiving ([`FeatureSync::ingest`]): valid signature, the payload names
//!   the signer as author, the signer is an active member, not a guest, and
//!   allowed to write in the document's scope (`scope::may_write`; for `ver`
//!   and `edit` the scope of the stored document, never the sender's).
//!   Refused records are logged (`permissions::log_rejection`, codes
//!   `docs_*`), not stored and so never forwarded.
//! - Ids are bound to their author: new documents and versions get
//!   `store::derive_id(author, salt)` and the salt travels in the payload. A
//!   record whose id does not match is refused (`docs_bad_id`). Records from
//!   before (no salt) are accepted only for an id unknown here, or known with
//!   the same author and the same content. An id already stored is never
//!   given other content, another author or another scope (`docs_bad_id`).
//! - Waiting: a `ver` for a document not here yet is stored `pending` (at
//!   most [`PENDING_MAX_PER_AUTHOR`] per author, dropped after
//!   [`PENDING_MAX_AGE_SECS`]) and applied when the document arrives. An
//!   `edit` mark for an unknown document is dropped.
//! - Reusing a file (`docs_blob_reuse`): a received version may name a file
//!   (hash) that this laptop already knows only when its author may see every
//!   other use of it here: every document scope with a version of that hash,
//!   every signing request with that file (as sender or signer), every chat
//!   conversation chat holds it for when chat put it in the store
//!   (`scope::chat_allows`: the author must be in one of them), and, when
//!   the file is in the blob store, at least one such use. Without this, a
//!   member could announce the hash of a team, signing or chat file in the
//!   general library and have rekan copy it to everyone.
//! - Files ([`BlobSource`]): a blob is served to a peer only through a
//!   version of a document the peer may view that is either made on this
//!   laptop or whose author may see every other use of the file here (the
//!   rule above, checked again when serving). So a reused hash that arrived
//!   before the file's real owner cannot open the owner's file to the reuse's
//!   readers. Cost: when the same bytes are in the general library and later
//!   in a team document or signing request its author does not take part in,
//!   this laptop serves them only for the team or request.
//! - Downloads: after a version arrives, files up to
//!   [`blobs::AUTO_REPLICATE_MAX_BYTES`] are copied right away through the
//!   [`BlobFetcher`] (again when a rekan connects and at start); larger files
//!   with [`DocsPeerSync::download_version`].

use std::collections::{HashMap, HashSet};
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::blobs::{self, BlobHash, BlobStore};
use crate::clock;
use crate::documents::access::{DocAction, DocumentAccess, RoleAccessWith};
use crate::documents::envelope::{self, DOCS_DOMAIN, Opened};
use crate::documents::scope::{self, GuestProjects};
use crate::documents::session::DocumentEvents;
use crate::documents::store::{self, DocScope};
use crate::documents::sync::{
    self, DocumentSync, REMOTE_EDITING_STALE_SECS, RemoteDocument, RemoteVersion,
};
use crate::error::{AppError, AppResult};
use crate::identity::Identity;
use crate::network::feature::{
    BlobFuture, BlobSource, FeatureHub, FeatureIngest, FeatureRecord, FeatureSync, TOPIC_DOCS,
};
use crate::org::is_lower_hex;
use crate::permissions::{self, MemberKind, OrgState};
use crate::state::{Core, MiraState};

/// While this laptop edits a document, its "Sedang diedit" mark is sent again
/// when the last one is this old (well inside the 10 minutes rekan keep it).
pub const EDIT_REFRESH_SECS: i64 = 240;

/// Folder under the data folder for files being downloaded from rekan.
pub const INCOMING_DIR: &str = "docs-incoming";

/// Error code of [`DocsPeerSync::download_version`] when no connected rekan
/// serves the file.
pub const NOT_AVAILABLE: &str = "not_available";

/// Most `pending` records kept per author (versions of documents not here).
pub const PENDING_MAX_PER_AUTHOR: i64 = 1000;

/// `pending` records older than this (since arrival) are dropped.
pub const PENDING_MAX_AGE_SECS: i64 = 7 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Records

/// "Sedang diedit" as sent to rekan. `editing = false` clears the mark.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditMark {
    pub document_id: String,
    pub editor: String,
    pub editing: bool,
    /// When the edit started.
    pub since: String,
    /// When this mark was made (the freshness clock).
    pub at: String,
}

/// Payload of a document record, tagged with `t`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t")]
pub enum DocPayload {
    #[serde(rename = "doc")]
    Doc(RemoteDocument),
    #[serde(rename = "ver")]
    Ver(RemoteVersion),
    #[serde(rename = "edit")]
    Edit(EditMark),
}

impl DocPayload {
    /// The `kind` column of `docs_sync_records`.
    pub fn kind(&self) -> &'static str {
        match self {
            DocPayload::Doc(_) => "doc",
            DocPayload::Ver(_) => "ver",
            DocPayload::Edit(_) => "edit",
        }
    }

    pub fn document_id(&self) -> &str {
        match self {
            DocPayload::Doc(d) => &d.id,
            DocPayload::Ver(v) => &v.document_id,
            DocPayload::Edit(e) => &e.document_id,
        }
    }

    /// The key the payload names as its author; must be the signer.
    fn claimed_author(&self) -> &str {
        match self {
            DocPayload::Doc(d) => &d.created_by,
            DocPayload::Ver(v) => &v.author,
            DocPayload::Edit(e) => &e.editor,
        }
    }

    /// The `created_at` column: the document's or version's time, the mark's `at`.
    fn time(&self) -> &str {
        match self {
            DocPayload::Doc(d) => &d.created_at,
            DocPayload::Ver(v) => &v.created_at,
            DocPayload::Edit(e) => &e.at,
        }
    }

    /// Documents first, so versions in the same batch find them.
    fn order(&self) -> u8 {
        match self {
            DocPayload::Doc(_) => 0,
            DocPayload::Ver(_) => 1,
            DocPayload::Edit(_) => 2,
        }
    }
}

fn parse_time(s: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(s, &Rfc3339).ok()
}

/// A mark made at `at` is still shown and offered at `now`.
fn mark_is_fresh(at: &str, now: OffsetDateTime) -> bool {
    parse_time(at).is_some_and(|at| (now - at).whole_seconds() <= REMOTE_EDITING_STALE_SECS)
}

/// Ordering key of edit marks: time, then record id (same on every laptop).
fn mark_key(at: &str, id: &str) -> (i128, String) {
    let t = parse_time(at).map_or(i128::MIN, |t| t.unix_timestamp_nanos());
    (t, id.to_owned())
}

/// Stores a record. For `edit`, only the latest per (document, author) is
/// kept: an older one is replaced, a newer one already here wins (`false`).
/// `false` also when the id is already stored.
fn store_record(
    conn: &Connection,
    record: &FeatureRecord,
    payload: &DocPayload,
    author: &str,
    state: &str,
    received_at: Option<&str>,
) -> AppResult<bool> {
    if let DocPayload::Edit(e) = payload {
        let mut stmt = conn.prepare(
            "SELECT id, created_at FROM docs_sync_records
             WHERE kind = 'edit' AND document_id = ?1 AND author = ?2",
        )?;
        let existing = stmt
            .query_map(params![e.document_id, author], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let new_key = mark_key(&e.at, &record.id);
        if existing.iter().any(|(id, at)| mark_key(at, id) >= new_key) {
            return Ok(false);
        }
        conn.execute(
            "DELETE FROM docs_sync_records WHERE kind = 'edit' AND document_id = ?1 AND author = ?2",
            params![e.document_id, author],
        )?;
    }
    let n = conn.execute(
        "INSERT OR IGNORE INTO docs_sync_records
             (id, kind, document_id, author, body, state, created_at, received_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            record.id,
            payload.kind(),
            payload.document_id(),
            author,
            record.body,
            state,
            payload.time(),
            received_at
        ],
    )?;
    Ok(n > 0)
}

/// Drops `pending` records that arrived more than [`PENDING_MAX_AGE_SECS`]
/// ago (or whose arrival time is unreadable). Returns how many.
fn expire_pending(conn: &Connection, now: OffsetDateTime) -> AppResult<usize> {
    let rows: Vec<(String, Option<String>)> = conn
        .prepare("SELECT id, received_at FROM docs_sync_records WHERE state = 'pending'")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    let mut dropped = 0;
    for (id, received_at) in rows {
        let old = received_at
            .as_deref()
            .and_then(parse_time)
            .is_none_or(|t| (now - t).whole_seconds() > PENDING_MAX_AGE_SECS);
        if old {
            dropped += conn.execute(
                "DELETE FROM docs_sync_records WHERE id = ?1 AND state = 'pending'",
                params![id],
            )?;
        }
    }
    Ok(dropped)
}

fn is_guest(state: &OrgState, pk: &str) -> bool {
    state
        .member(pk)
        .is_some_and(|m| m.kind == MemberKind::Guest)
}

/// True when `author` already has a record for this document or version
/// (one record per document and per version; edit marks are always new).
fn published(conn: &Connection, payload: &DocPayload, author: &str) -> AppResult<bool> {
    let found = match payload {
        DocPayload::Doc(d) => conn
            .query_row(
                "SELECT 1 FROM docs_sync_records WHERE kind = 'doc' AND document_id = ?1 AND author = ?2",
                params![d.id, author],
                |_| Ok(()),
            )
            .optional()?,
        DocPayload::Ver(v) => conn
            .query_row(
                "SELECT 1 FROM docs_sync_records
                 WHERE kind = 'ver' AND document_id = ?1 AND author = ?2
                   AND json_extract(json_extract(body, '$.p'), '$.id') = ?3",
                params![v.document_id, author, v.id],
                |_| Ok(()),
            )
            .optional()?,
        DocPayload::Edit(_) => None,
    };
    Ok(found.is_some())
}

fn record_known(conn: &Connection, id: &str) -> AppResult<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM docs_sync_records WHERE id = ?1",
            params![id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

// ---------------------------------------------------------------------------
// Downloads in flight (shown as `downloading` in the view)

fn in_flight() -> &'static Mutex<HashSet<PathBuf>> {
    static SET: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    SET.get_or_init(Default::default)
}

/// True while the blob is being downloaded into `blobs` by this process.
pub fn is_downloading(blobs: &BlobStore, hash: &BlobHash) -> bool {
    in_flight()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(&blobs.path_of(hash))
}

/// One download of one blob into one store; released on drop.
struct InFlight(PathBuf);

impl InFlight {
    fn begin(blobs: &BlobStore, hash: &BlobHash) -> Option<InFlight> {
        let key = blobs.path_of(hash);
        let mut set = in_flight().lock().unwrap_or_else(|e| e.into_inner());
        // `then`, not `then_some`: an `InFlight` built and dropped here would
        // lock `in_flight()` again while `set` holds it (deadlock).
        set.insert(key.clone()).then(|| InFlight(key))
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        in_flight()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}

/// A background job (an automatic download).
pub type Job = Pin<Box<dyn Future<Output = ()> + Send>>;

/// How blobs are downloaded from rekan. The app uses [`HubFetcher`]; tests
/// record the requests and copy from other test laptops.
pub trait BlobFetcher: Send + Sync + 'static {
    /// Downloads `hash` (at most `max_size` bytes, BLAKE3 checked) to `dest`
    /// from a connected rekan, trying `prefer` first.
    fn fetch(&self, hash: &str, max_size: u64, prefer: Vec<String>, dest: &Path) -> BlobFuture;

    /// Runs `job` in the background.
    fn spawn(&self, job: Job);
}

/// [`FeatureHub::fetch_blob`] on Tauri's async runtime.
pub struct HubFetcher(pub Arc<FeatureHub>);

impl BlobFetcher for HubFetcher {
    fn fetch(&self, hash: &str, max_size: u64, prefer: Vec<String>, dest: &Path) -> BlobFuture {
        self.0.fetch_blob(hash, max_size, prefer, dest)
    }

    fn spawn(&self, job: Job) {
        tauri::async_runtime::spawn(job);
    }
}

#[derive(Clone, Debug)]
struct FetchJob {
    hash: BlobHash,
    size: u64,
    prefer: Vec<String>,
}

fn not_available() -> AppError {
    AppError::Signing {
        code: NOT_AVAILABLE,
        message: "File versi ini belum bisa diunduh: tidak ada laptop rekan tersambung yang menyimpannya. Coba lagi saat laptop rekan menyala dan membuka Mira."
            .into(),
    }
}

// ---------------------------------------------------------------------------
// Receiving

/// Why a received record is refused (logged with its code) or a local error.
enum Fail {
    Reject(&'static str, String),
    App(AppError),
}

impl From<AppError> for Fail {
    fn from(err: AppError) -> Self {
        Fail::App(err)
    }
}

impl From<rusqlite::Error> for Fail {
    fn from(err: rusqlite::Error) -> Self {
        Fail::App(err.into())
    }
}

fn reject(code: &'static str, detail: impl Into<String>) -> Fail {
    Fail::Reject(code, detail.into())
}

/// Shape errors from `apply_remote_*` and the id checks become rejections.
fn bad_record(err: AppError) -> Fail {
    match err {
        AppError::InvalidInput(m) | AppError::NotFound(m) => Fail::Reject("docs_bad_record", m),
        other => Fail::App(other),
    }
}

fn bad_id(detail: &str) -> Fail {
    reject("docs_bad_id", detail)
}

/// The id is bound to the author when the record carries a salt
/// (`store::derive_id`). Without a salt (records from before) nothing can be
/// checked here; [`check_known_document`] and [`check_known_version`] then
/// keep stored ids from changing.
fn check_bound_id(id: &str, author: &str, salt: Option<&str>) -> Result<(), Fail> {
    match salt {
        Some(salt) if !is_lower_hex(salt, store::ID_HEX_LEN) => {
            Err(bad_id("Garam id catatan tidak valid."))
        }
        Some(salt) if store::derive_id(author, salt) != id => Err(bad_id(
            "Id catatan tidak cocok dengan penulisnya, jadi tidak dipakai.",
        )),
        _ => Ok(()),
    }
}

/// A document id already stored keeps its creator, scope and time.
fn check_known_document(conn: &Connection, d: &RemoteDocument) -> Result<(), Fail> {
    if !store::document_exists(conn, &d.id)? {
        return Ok(());
    }
    let stored = store::get_document(conn, &d.id)?;
    let scope = DocScope {
        team_id: d.team_id.clone(),
        project_id: d.project_id.clone(),
    };
    if stored.created_by != d.created_by
        || stored.scope() != scope
        || stored.created_at != d.created_at
    {
        return Err(bad_id(
            "Id dokumen ini sudah tercatat dengan pembuat, departemen, proyek, atau waktu lain.",
        ));
    }
    Ok(())
}

/// A version id already stored keeps its content. `Ok(true)` when it is
/// stored (and the same).
fn check_known_version(conn: &Connection, v: &RemoteVersion) -> Result<bool, Fail> {
    let stored = match store::get_version(conn, &v.id) {
        Ok(stored) => stored,
        Err(AppError::NotFound(_)) => return Ok(false),
        Err(err) => return Err(Fail::App(err)),
    };
    let mut parents = v.parent_ids.clone();
    parents.sort();
    parents.dedup();
    let same = stored.document_id == v.document_id
        && stored.author == v.author
        && stored.blob.hash.as_str() == v.blob_hash
        && stored.blob.size == v.size
        && stored.created_at == v.created_at
        && stored.origin == v.origin
        && stored.restored_from == v.restored_from
        && stored.parent_ids == parents;
    if same {
        Ok(true)
    } else {
        Err(bad_id(
            "Id versi ini sudah tercatat dengan isi atau penulis lain.",
        ))
    }
}

/// True when `author` may see every other use of file `hash` on this laptop
/// (module docs, "Reusing a file"): every document scope with a version of
/// it other than `except_version`, every signing request with it (as sender
/// or signer), and a chat attachment only from a conversation the author is
/// in (`scope::chat_allows`). With `in_store`, at least one such use must
/// exist, since a file here that nothing the author may see uses belongs to
/// something else (signing, another feature).
fn may_reuse_blob(
    conn: &Connection,
    state: &OrgState,
    guests: &dyn GuestProjects,
    author: &str,
    hash: &str,
    except_version: &str,
    in_store: bool,
) -> AppResult<bool> {
    let scopes: Vec<DocScope> = conn
        .prepare(
            "SELECT DISTINCT d.team_id, d.project_id
             FROM document_versions v JOIN documents d ON d.id = v.document_id
             WHERE v.blob_hash = ?1 AND v.id <> ?2",
        )?
        .query_map(params![hash, except_version], |r| {
            Ok(DocScope {
                team_id: r.get(0)?,
                project_id: r.get(1)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    let mut seen = false;
    for scope in &scopes {
        if !scope::may_view(conn, state, guests, author, scope)? {
            return Ok(false);
        }
        seen = true;
    }
    let requests: Vec<bool> = conn
        .prepare(
            "SELECT r.requested_by = ?2
                 OR EXISTS (SELECT 1 FROM sign_signers s
                            WHERE s.request_id = r.id AND s.public_key = ?2)
             FROM sign_requests r
             WHERE r.original_hash = ?1 OR r.current_hash = ?1
                OR EXISTS (SELECT 1 FROM sign_signers s
                           WHERE s.request_id = r.id AND s.hash_after = ?1)",
        )?
        .query_map(params![hash, author], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    for takes_part in requests {
        if !takes_part {
            return Ok(false);
        }
        seen = true;
    }
    // A chat attachment from a conversation the author is not in: refused
    // even when the file is not in the store yet, so a version received
    // before the chat download is never served once the file arrives.
    match scope::chat_allows(conn, hash, author)? {
        Some(false) => return Ok(false),
        Some(true) => seen = true,
        None => {}
    }
    Ok(seen || !in_store)
}

/// What applying records changed.
#[derive(Default)]
struct Applied {
    stored: bool,
    changed: bool,
    fetch: Vec<FetchJob>,
}

/// Context of one received batch.
struct Batch<'a> {
    state: &'a OrgState,
    from: &'a str,
    now: OffsetDateTime,
    now_s: String,
}

fn log_rejection(
    conn: &Connection,
    peer: &str,
    code: &str,
    detail: &str,
    now: OffsetDateTime,
) -> AppResult<()> {
    permissions::log_rejection(conn, Some(peer), None, code, detail, now)
}

// ---------------------------------------------------------------------------
// The feature

/// What [`DocsPeerSync::new`] plugs in.
pub struct PeerSyncDeps {
    pub guests: Arc<dyn GuestProjects>,
    pub hub: Arc<FeatureHub>,
    pub fetcher: Arc<dyn BlobFetcher>,
    pub events: Arc<dyn DocumentEvents>,
}

/// Document sync with rekan: [`FeatureSync`] for `docs`, [`BlobSource`] for
/// version files, and the outbound [`DocumentSync`] of the document runtime.
pub struct DocsPeerSync {
    this: Weak<DocsPeerSync>,
    state: MiraState,
    blobs: BlobStore,
    incoming_dir: PathBuf,
    guests: Arc<dyn GuestProjects>,
    access: Arc<dyn DocumentAccess>,
    hub: Arc<FeatureHub>,
    fetcher: Arc<dyn BlobFetcher>,
    events: Arc<dyn DocumentEvents>,
    backfilled: AtomicBool,
}

impl DocsPeerSync {
    /// Needs the data folder (for the blob store), not the database.
    pub fn new(state: MiraState, deps: PeerSyncDeps) -> AppResult<Arc<Self>> {
        let data_dir = state.data_dir()?.to_path_buf();
        let blobs = BlobStore::in_data_dir(&data_dir)?;
        let incoming_dir = data_dir.join(INCOMING_DIR);
        // Leftovers of downloads cut off by the last close.
        let _ = fs::remove_dir_all(&incoming_dir);
        let access: Arc<dyn DocumentAccess> = Arc::new(RoleAccessWith(deps.guests.clone()));
        Ok(Arc::new_cyclic(|this| DocsPeerSync {
            this: this.clone(),
            state,
            blobs,
            incoming_dir,
            guests: deps.guests,
            access,
            hub: deps.hub,
            fetcher: deps.fetcher,
            events: deps.events,
            backfilled: AtomicBool::new(false),
        }))
    }

    fn core<T>(&self, f: impl FnOnce(&mut Connection, &Identity) -> AppResult<T>) -> AppResult<T> {
        self.state.with_core(|core| {
            let Core { db, identity } = core;
            f(db, identity)
        })
    }

    // -----------------------------------------------------------------------
    // Outbound

    /// Seals and stores records signed by this laptop, then tells the hub.
    fn publish(&self, payloads: &[DocPayload]) {
        let stored = self.core(|db, me| {
            let mut stored = false;
            for p in payloads {
                if published(db, p, me.public_key_hex())? {
                    continue;
                }
                let record = envelope::seal(me, DOCS_DOMAIN, p).map_err(AppError::Internal)?;
                stored |= store_record(db, &record, p, me.public_key_hex(), "applied", None)?;
            }
            Ok(stored)
        });
        match stored {
            Ok(true) => self.hub.notify_changed(TOPIC_DOCS),
            Ok(false) => {}
            Err(err) => eprintln!(
                "Mira: catatan sinkron dokumen tidak bisa dibuat [{}]: {err}",
                err.code()
            ),
        }
    }

    /// Records for documents and versions made here before sync existed (or
    /// whose record could not be made). Once per run, before the first offer.
    fn ensure_backfill(&self) {
        if self.backfilled.load(Ordering::Acquire) {
            return;
        }
        match self.backfill() {
            Ok(_) => self.backfilled.store(true, Ordering::Release),
            Err(err) => eprintln!(
                "Mira: catatan sinkron dokumen lama tidak bisa dibuat [{}]: {err}",
                err.code()
            ),
        }
    }

    /// Returns how many records were made.
    fn backfill(&self) -> AppResult<usize> {
        self.core(|db, me| {
            let pk = me.public_key_hex().to_owned();
            let doc_ids: Vec<String> = db
                .prepare(
                    "SELECT d.id FROM documents d WHERE d.created_by = ?1 AND NOT EXISTS (
                         SELECT 1 FROM docs_sync_records r
                         WHERE r.kind = 'doc' AND r.document_id = d.id AND r.author = ?1)",
                )?
                .query_map(params![pk], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            let version_ids: Vec<String> = db
                .prepare(
                    "SELECT v.id FROM document_versions v
                     WHERE v.author = ?1 AND v.received_at IS NULL AND NOT EXISTS (
                         SELECT 1 FROM docs_sync_records r
                         WHERE r.kind = 'ver' AND r.document_id = v.document_id AND r.author = ?1
                           AND json_extract(json_extract(r.body, '$.p'), '$.id') = v.id)",
                )?
                .query_map(params![pk], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            let mut made = 0;
            for id in doc_ids {
                let doc = store::get_document(db, &id)?;
                let p = DocPayload::Doc(RemoteDocument::from_record(&doc));
                let record = envelope::seal(me, DOCS_DOMAIN, &p).map_err(AppError::Internal)?;
                made += usize::from(store_record(db, &record, &p, &pk, "applied", None)?);
            }
            for id in version_ids {
                let v = store::get_version(db, &id)?;
                let p = DocPayload::Ver(RemoteVersion::from_record(&v));
                let record = envelope::seal(me, DOCS_DOMAIN, &p).map_err(AppError::Internal)?;
                made += usize::from(store_record(db, &record, &p, &pk, "applied", None)?);
            }
            Ok(made)
        })
    }

    /// Repeats this laptop's "Sedang diedit" mark for every document it edits
    /// whose last mark is [`EDIT_REFRESH_SECS`] old. The runtime calls this
    /// every minute. Returns the number of marks sent.
    pub fn refresh_editing(&self) -> AppResult<usize> {
        self.refresh_editing_at(clock::now())
    }

    pub fn refresh_editing_at(&self, now: OffsetDateTime) -> AppResult<usize> {
        let made = self.core(|db, me| {
            let pk = me.public_key_hex().to_owned();
            let mut made = 0;
            for session in store::edit_sessions(db)? {
                if session.editor != pk {
                    continue;
                }
                let last: Option<String> = db
                    .query_row(
                        "SELECT created_at FROM docs_sync_records
                         WHERE kind = 'edit' AND document_id = ?1 AND author = ?2",
                        params![session.document_id, pk],
                        |r| r.get(0),
                    )
                    .optional()?;
                let due = last
                    .as_deref()
                    .and_then(parse_time)
                    .is_none_or(|t| (now - t).whole_seconds() >= EDIT_REFRESH_SECS);
                if !due {
                    continue;
                }
                let p = DocPayload::Edit(EditMark {
                    document_id: session.document_id.clone(),
                    editor: pk.clone(),
                    editing: true,
                    since: session.started_at.clone(),
                    at: clock::format_rfc3339(now),
                });
                let record = envelope::seal(me, DOCS_DOMAIN, &p).map_err(AppError::Internal)?;
                made += usize::from(store_record(db, &record, &p, &pk, "applied", None)?);
            }
            Ok(made)
        })?;
        if made > 0 {
            self.hub.notify_changed(TOPIC_DOCS);
        }
        Ok(made)
    }

    // -----------------------------------------------------------------------
    // Sending

    /// The applied records `peer` may receive (all, or among `ids`), with
    /// bodies only when `with_body`.
    fn offer(
        &self,
        peer: &str,
        ids: Option<&[String]>,
        with_body: bool,
        now: OffsetDateTime,
    ) -> AppResult<Vec<FeatureRecord>> {
        self.ensure_backfill();
        self.core(|db, me| {
            let Some(state) = permissions::load_state(db)? else {
                return Ok(Vec::new());
            };
            if !state.is_active(peer) || !state.is_active(me.public_key_hex()) {
                return Ok(Vec::new());
            }
            let body = if with_body { "r.body" } else { "''" };
            let base = format!(
                "SELECT r.id, r.kind, r.author, r.created_at, d.team_id, d.project_id, {body}
                 FROM docs_sync_records r JOIN documents d ON d.id = r.document_id
                 WHERE r.state = 'applied'"
            );
            type Row = (
                String,
                String,
                String,
                String,
                Option<String>,
                Option<String>,
                String,
            );
            let read = |r: &rusqlite::Row<'_>| -> rusqlite::Result<Row> {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ))
            };
            let rows: Vec<Row> = match ids {
                None => db
                    .prepare(&format!("{base} ORDER BY r.rowid"))?
                    .query_map([], read)?
                    .collect::<Result<_, _>>()?,
                Some(ids) => {
                    let mut stmt = db.prepare(&format!("{base} AND r.id = ?1"))?;
                    let mut rows = Vec::with_capacity(ids.len());
                    for id in ids {
                        if let Some(row) = stmt.query_row(params![id], read).optional()? {
                            rows.push(row);
                        }
                    }
                    rows
                }
            };
            let mut visible: HashMap<DocScope, bool> = HashMap::new();
            let mut out = Vec::new();
            for (id, kind, author, created_at, team_id, project_id, body) in rows {
                if !state.is_active(&author) || (kind == "edit" && !mark_is_fresh(&created_at, now))
                {
                    continue;
                }
                let scope = DocScope {
                    team_id,
                    project_id,
                };
                let may = match visible.get(&scope) {
                    Some(may) => *may,
                    None => {
                        let may = scope::may_view(db, &state, self.guests.as_ref(), peer, &scope)?;
                        visible.insert(scope, may);
                        may
                    }
                };
                if may {
                    out.push(FeatureRecord { id, body });
                }
            }
            Ok(out)
        })
    }

    // -----------------------------------------------------------------------
    // Receiving

    fn ingest_at(
        &self,
        from: &str,
        records: Vec<FeatureRecord>,
        now: OffsetDateTime,
    ) -> AppResult<FeatureIngest> {
        let mut opened: Vec<(FeatureRecord, Opened<DocPayload>)> = Vec::new();
        let mut bad = Vec::new();
        for record in records {
            match envelope::open::<DocPayload>(DOCS_DOMAIN, &record) {
                Ok(o) => opened.push((record, o)),
                Err(why) => bad.push((record.id, why)),
            }
        }
        opened.sort_by_key(|(_, o)| o.payload.order());
        let (out, jobs) = self.core(|db, _| {
            let mut out = FeatureIngest::default();
            let mut jobs = Vec::new();
            expire_pending(db, now)?;
            for (id, why) in &bad {
                let detail = format!("Catatan dokumen {id}: {why}");
                log_rejection(db, from, "docs_bad_signature", &detail, now)?;
                out.rejected += 1;
            }
            let Some(state) = permissions::load_state(db)? else {
                out.rejected += opened.len();
                return Ok((out, jobs));
            };
            let batch = Batch {
                state: &state,
                from,
                now,
                now_s: clock::format_rfc3339(now),
            };
            for (record, o) in &opened {
                if record_known(db, &record.id)? {
                    continue;
                }
                match self.ingest_one(db, &batch, record, o) {
                    Ok(a) => {
                        out.accepted += usize::from(a.stored);
                        out.changed |= a.changed;
                        jobs.extend(a.fetch);
                    }
                    Err(Fail::Reject(code, detail)) => {
                        let detail = format!(
                            "Catatan dokumen {} ({}) dari {}: {detail}",
                            record.id,
                            o.payload.kind(),
                            o.author
                        );
                        log_rejection(db, from, code, &detail, now)?;
                        out.rejected += 1;
                    }
                    Err(Fail::App(err)) => return Err(err),
                }
            }
            Ok((out, jobs))
        })?;
        self.spawn_fetches(jobs);
        Ok(out)
    }

    fn may_write(
        &self,
        conn: &Connection,
        state: &OrgState,
        author: &str,
        scope: &DocScope,
    ) -> Result<(), Fail> {
        if scope::may_write(conn, state, self.guests.as_ref(), author, scope)? {
            Ok(())
        } else {
            Err(reject(
                "docs_forbidden",
                "Penulis tidak berhak menulis di departemen atau proyek dokumen ini.",
            ))
        }
    }

    /// [`may_reuse_blob`] for a received version not stored yet.
    fn check_blob_reuse(
        &self,
        conn: &Connection,
        state: &OrgState,
        v: &RemoteVersion,
    ) -> Result<(), Fail> {
        if check_known_version(conn, v)? {
            return Ok(());
        }
        let in_store = BlobHash::parse(&v.blob_hash).is_ok_and(|h| self.blobs.contains(&h));
        if may_reuse_blob(
            conn,
            state,
            self.guests.as_ref(),
            &v.author,
            &v.blob_hash,
            &v.id,
            in_store,
        )? {
            Ok(())
        } else {
            Err(reject(
                "docs_blob_reuse",
                "Versi ini memakai file milik departemen, proyek, atau tanda tangan yang tidak bisa dibuka penulisnya.",
            ))
        }
    }

    fn ingest_one(
        &self,
        db: &mut Connection,
        b: &Batch<'_>,
        record: &FeatureRecord,
        o: &Opened<DocPayload>,
    ) -> Result<Applied, Fail> {
        let author = o.author.as_str();
        if o.payload.claimed_author() != author {
            return Err(reject(
                "docs_wrong_author",
                "Isi catatan menyebut penulis lain dari yang menandatangani.",
            ));
        }
        if !b.state.is_active(author) {
            return Err(reject(
                "docs_not_member",
                "Penulis bukan anggota aktif organisasi.",
            ));
        }
        if is_guest(b.state, author) {
            return Err(reject(
                "docs_forbidden",
                "Tamu tidak bisa menambah atau mengubah dokumen.",
            ));
        }
        store::check_id(o.payload.document_id(), "dokumen").map_err(bad_record)?;
        let received = Some(b.now_s.as_str());
        match &o.payload {
            DocPayload::Doc(d) => {
                check_bound_id(&d.id, author, d.salt.as_deref())?;
                let scope = DocScope {
                    team_id: d.team_id.clone(),
                    project_id: d.project_id.clone(),
                };
                check_known_document(db, d)?;
                self.may_write(db, b.state, author, &scope)?;
                let inserted = sync::apply_remote_document(db, d, &b.now_s).map_err(bad_record)?;
                store_record(db, record, &o.payload, author, "applied", received)?;
                let mut a = Applied {
                    stored: true,
                    changed: inserted,
                    fetch: Vec::new(),
                };
                self.apply_pending(db, b, &d.id, &scope, &mut a)?;
                Ok(a)
            }
            DocPayload::Ver(v) => {
                store::check_id(&v.id, "versi").map_err(bad_record)?;
                check_bound_id(&v.id, author, v.salt.as_deref())?;
                check_known_version(db, v)?;
                if !store::document_exists(db, &v.document_id)? {
                    let waiting: i64 = db.query_row(
                        "SELECT count(*) FROM docs_sync_records WHERE state = 'pending' AND author = ?1",
                        params![author],
                        |r| r.get(0),
                    )?;
                    if waiting >= PENDING_MAX_PER_AUTHOR {
                        return Err(reject(
                            "docs_pending_full",
                            "Terlalu banyak versi dari penulis ini yang dokumennya belum ada.",
                        ));
                    }
                    let stored = store_record(db, record, &o.payload, author, "pending", received)?;
                    return Ok(Applied {
                        stored,
                        ..Applied::default()
                    });
                }
                let scope = store::get_document(db, &v.document_id)?.scope();
                self.may_write(db, b.state, author, &scope)?;
                self.check_blob_reuse(db, b.state, v)?;
                let out = sync::apply_remote_version(db, v, &b.now_s).map_err(bad_record)?;
                store_record(db, record, &o.payload, author, "applied", received)?;
                Ok(Applied {
                    stored: true,
                    changed: out.inserted,
                    fetch: self.auto_job(v, b.from).into_iter().collect(),
                })
            }
            DocPayload::Edit(e) => {
                let (Some(at), Some(_)) = (parse_time(&e.at), parse_time(&e.since)) else {
                    return Err(reject("docs_bad_record", "Waktu tanda edit tidak terbaca."));
                };
                if (at - b.now).whole_seconds() > REMOTE_EDITING_STALE_SECS {
                    return Err(reject(
                        "docs_bad_record",
                        "Waktu tanda edit jauh di masa depan.",
                    ));
                }
                if !mark_is_fresh(&e.at, b.now) {
                    // Too old to show; nothing to store or forward.
                    return Ok(Applied::default());
                }
                if !store::document_exists(db, &e.document_id)? {
                    // Not stored: the editor repeats the mark every few
                    // minutes, so one arrives after the document.
                    return Ok(Applied::default());
                }
                let scope = store::get_document(db, &e.document_id)?.scope();
                self.may_write(db, b.state, author, &scope)?;
                let stored = store_record(db, record, &o.payload, author, "applied", received)?;
                if stored {
                    apply_edit(db, e, b.now)?;
                }
                Ok(Applied {
                    stored,
                    changed: stored,
                    fetch: Vec::new(),
                })
            }
        }
    }

    /// Applies the pending `ver` and `edit` records of a document that just
    /// arrived. Records the author may not write are removed and logged.
    fn apply_pending(
        &self,
        db: &mut Connection,
        b: &Batch<'_>,
        document_id: &str,
        scope: &DocScope,
        a: &mut Applied,
    ) -> Result<(), Fail> {
        let pending: Vec<(String, String)> = db
            .prepare(
                "SELECT id, body FROM docs_sync_records WHERE document_id = ?1 AND state = 'pending'
                 ORDER BY kind = 'edit', created_at, id",
            )?
            .query_map(params![document_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        for (id, body) in pending {
            let record = FeatureRecord { id, body };
            let result = match envelope::open::<DocPayload>(DOCS_DOMAIN, &record) {
                Ok(o) => self.apply_one_pending(db, b, scope, &o, a),
                Err(why) => Err(reject("docs_bad_signature", why)),
            };
            match result {
                Ok(()) => {
                    db.execute(
                        "UPDATE docs_sync_records SET state = 'applied' WHERE id = ?1",
                        params![record.id],
                    )?;
                }
                Err(Fail::Reject(code, detail)) => {
                    db.execute(
                        "DELETE FROM docs_sync_records WHERE id = ?1",
                        params![record.id],
                    )?;
                    if !code.is_empty() {
                        let detail = format!("Catatan dokumen {} (menunggu): {detail}", record.id);
                        log_rejection(db, b.from, code, &detail, b.now)?;
                    }
                }
                Err(Fail::App(err)) => return Err(Fail::App(err)),
            }
        }
        Ok(())
    }

    fn apply_one_pending(
        &self,
        db: &mut Connection,
        b: &Batch<'_>,
        scope: &DocScope,
        o: &Opened<DocPayload>,
        a: &mut Applied,
    ) -> Result<(), Fail> {
        self.may_write(db, b.state, &o.author, scope)?;
        match &o.payload {
            DocPayload::Ver(v) => {
                self.check_blob_reuse(db, b.state, v)?;
                let out = sync::apply_remote_version(db, v, &b.now_s).map_err(bad_record)?;
                a.changed |= out.inserted;
                a.fetch.extend(self.auto_job(v, b.from));
                Ok(())
            }
            DocPayload::Edit(e) => {
                if !mark_is_fresh(&e.at, b.now) {
                    // Expired while waiting: dropped without a log entry.
                    return Err(Fail::Reject("", String::new()));
                }
                apply_edit(db, e, b.now)?;
                a.changed = true;
                Ok(())
            }
            DocPayload::Doc(_) => Err(reject("docs_bad_record", "Dokumen tidak bisa menunggu.")),
        }
    }

    // -----------------------------------------------------------------------
    // Downloads

    /// The automatic download of a received version, if it is small and its
    /// file is missing here.
    fn auto_job(&self, v: &RemoteVersion, from: &str) -> Option<FetchJob> {
        let hash = BlobHash::parse(&v.blob_hash).ok()?;
        if !blobs::should_auto_replicate(v.size) || self.blobs.contains(&hash) {
            return None;
        }
        let mut prefer = vec![from.to_owned()];
        if v.author != from {
            prefer.push(v.author.clone());
        }
        Some(FetchJob {
            hash,
            size: v.size,
            prefer,
        })
    }

    /// Starts the downloads not already running.
    fn spawn_fetches(&self, jobs: Vec<FetchJob>) {
        let Some(this) = self.this.upgrade() else {
            return;
        };
        for job in jobs {
            let Some(guard) = InFlight::begin(&self.blobs, &job.hash) else {
                continue;
            };
            let this = this.clone();
            self.fetcher.spawn(Box::pin(async move {
                let hash = job.hash.clone();
                if let Err(err) = this.run_fetch(job, guard).await {
                    eprintln!(
                        "Mira: file dokumen {hash} belum bisa diunduh [{}]: {err}",
                        err.code()
                    );
                }
            }));
        }
    }

    /// Drops `pending` records older than [`PENDING_MAX_AGE_SECS`]. Called at
    /// start (and with every received batch).
    pub fn expire_pending(&self) -> AppResult<usize> {
        self.core(|db, _| expire_pending(db, clock::now()))
    }

    /// Starts the automatic downloads of every received small version whose
    /// file is missing, trying `prefer` first. Called at start and when a
    /// rekan connects.
    pub fn resume_downloads(&self, prefer: Vec<String>) {
        let jobs = self.core(|db, _| {
            let rows: Vec<(String, i64, String)> = db
                .prepare(
                    "SELECT blob_hash, size, min(author) FROM document_versions
                     WHERE received_at IS NOT NULL AND size <= ?1 GROUP BY blob_hash, size",
                )?
                .query_map(
                    params![i64::try_from(blobs::AUTO_REPLICATE_MAX_BYTES).unwrap_or(i64::MAX)],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?
                .collect::<Result<_, _>>()?;
            Ok(rows
                .into_iter()
                .filter_map(|(hash, size, author)| {
                    let hash = BlobHash::parse(&hash).ok()?;
                    if self.blobs.contains(&hash) {
                        return None;
                    }
                    let mut prefer = prefer.clone();
                    if !prefer.contains(&author) {
                        prefer.push(author);
                    }
                    Some(FetchJob {
                        hash,
                        size: u64::try_from(size).ok()?,
                        prefer,
                    })
                })
                .collect::<Vec<_>>())
        });
        match jobs {
            Ok(jobs) => self.spawn_fetches(jobs),
            Err(err) => eprintln!(
                "Mira: unduhan file dokumen tidak bisa dilanjutkan [{}]: {err}",
                err.code()
            ),
        }
    }

    /// "Unduh" for a version (any size): copies its file from a connected
    /// rekan. Returns when the file is here, or right away when it already is
    /// or a download of it is running (the view then shows `downloading`).
    /// `not_available` when no connected rekan serves it.
    pub async fn download_version(
        self: Arc<Self>,
        document_id: String,
        version_id: String,
    ) -> AppResult<()> {
        let this = Arc::clone(&self);
        let job = tokio::task::spawn_blocking(move || this.manual_job(&document_id, &version_id))
            .await
            .map_err(|err| AppError::Internal(format!("Unduhan berhenti mendadak: {err}")))??;
        let Some(job) = job else {
            return Ok(());
        };
        let Some(guard) = InFlight::begin(&self.blobs, &job.hash) else {
            return Ok(());
        };
        self.run_fetch(job, guard).await
    }

    fn manual_job(&self, document_id: &str, version_id: &str) -> AppResult<Option<FetchJob>> {
        self.core(|db, me| {
            let doc = store::get_document(db, document_id)?;
            self.access.check(db, me, &doc.scope(), DocAction::View)?;
            let v = store::get_version(db, version_id)?;
            if v.document_id != document_id {
                return Err(AppError::NotFound(
                    "Versi dokumen tidak ditemukan di laptop ini.".into(),
                ));
            }
            if self.blobs.contains(&v.blob.hash) {
                return Ok(None);
            }
            let prefer = if v.author == me.public_key_hex() {
                Vec::new()
            } else {
                vec![v.author.clone()]
            };
            Ok(Some(FetchJob {
                hash: v.blob.hash,
                size: v.blob.size,
                prefer,
            }))
        })
    }

    /// Downloads into a temporary file, stores it in the blob store and
    /// checks the hash. Tells the window about every document using the file,
    /// whatever the outcome (so `downloading` goes away).
    async fn run_fetch(self: Arc<Self>, job: FetchJob, guard: InFlight) -> AppResult<()> {
        let result = Arc::clone(&self).fetch_into_store(&job).await;
        drop(guard);
        self.announce(&job.hash);
        result
    }

    async fn fetch_into_store(self: Arc<Self>, job: &FetchJob) -> AppResult<()> {
        if self.blobs.contains(&job.hash) {
            return Ok(());
        }
        fs::create_dir_all(&self.incoming_dir).map_err(|e| {
            AppError::Storage(format!(
                "Folder unduhan {} tidak bisa dibuat. Detail: {e}",
                self.incoming_dir.display()
            ))
        })?;
        let temp = self
            .incoming_dir
            .join(format!("{}-{}.part", job.hash, store::new_id()));
        let fetched = self
            .fetcher
            .fetch(job.hash.as_str(), job.size, job.prefer.clone(), &temp)
            .await;
        if let Err(err) = fetched {
            let _ = fs::remove_file(&temp);
            eprintln!("Mira: unduhan file {} gagal: {err}", job.hash);
            return Err(not_available());
        }
        let this = Arc::clone(&self);
        let (hash, path) = (job.hash.clone(), temp.clone());
        let stored = tokio::task::spawn_blocking(move || this.store_download(&hash, &path)).await;
        let _ = fs::remove_file(&temp);
        stored.map_err(|err| AppError::Internal(format!("Unduhan berhenti mendadak: {err}")))?
    }

    fn store_download(&self, hash: &BlobHash, temp: &Path) -> AppResult<()> {
        let info = self.blobs.put_file(temp)?;
        if info.hash != *hash {
            eprintln!(
                "Mira: file dokumen dari rekan berbeda: diminta {hash}, diterima {}.",
                info.hash
            );
            return Err(AppError::Storage(
                "File yang diterima dari laptop rekan rusak di jalan. Coba unduh lagi.".into(),
            ));
        }
        Ok(())
    }

    fn announce(&self, hash: &BlobHash) {
        let docs = self.core(|db, _| {
            let ids: Vec<String> = db
                .prepare("SELECT DISTINCT document_id FROM document_versions WHERE blob_hash = ?1")?
                .query_map(params![hash.as_str()], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            Ok(ids)
        });
        for id in docs.unwrap_or_default() {
            self.events.changed(&id);
        }
    }
}

/// Stores or clears a rekan's mark. `seen_at` is the mark's own time (not
/// the arrival), so a relayed mark expires when the original would.
fn apply_edit(conn: &Connection, e: &EditMark, now: OffsetDateTime) -> AppResult<()> {
    let at = parse_time(&e.at).map_or(now, |at| at.min(now));
    let seen = clock::format_rfc3339(at);
    let since = e.editing.then_some(e.since.as_str());
    sync::set_remote_editing(conn, &e.document_id, &e.editor, since, &seen)
}

impl FeatureSync for DocsPeerSync {
    fn topic(&self) -> &'static str {
        TOPIC_DOCS
    }

    fn record_ids_for(&self, peer: &str) -> Result<Vec<String>, String> {
        self.offer(peer, None, false, clock::now())
            .map(|records| records.into_iter().map(|r| r.id).collect())
            .map_err(|e| e.to_string())
    }

    fn unknown_ids(&self, ids: &[String]) -> Result<Vec<String>, String> {
        self.core(|db, _| {
            let mut out = Vec::new();
            for id in ids {
                if !record_known(db, id)? {
                    out.push(id.clone());
                }
            }
            Ok(out)
        })
        .map_err(|e| e.to_string())
    }

    fn records_for(&self, peer: &str, ids: &[String]) -> Result<Vec<FeatureRecord>, String> {
        self.offer(peer, Some(ids), true, clock::now())
            .map_err(|e| e.to_string())
    }

    fn ingest(&self, from: &str, records: Vec<FeatureRecord>) -> Result<FeatureIngest, String> {
        self.ingest_at(from, records, clock::now())
            .map_err(|e| e.to_string())
    }

    fn peer_connected(&self, peer: &str) {
        self.resume_downloads(vec![peer.to_owned()]);
    }
}

impl BlobSource for DocsPeerSync {
    fn blob_path_for(&self, peer: &str, hash: &str) -> Option<PathBuf> {
        let hash = BlobHash::parse(hash).ok()?;
        let allowed = self.core(|db, _| {
            let Some(state) = permissions::load_state(db)? else {
                return Ok(false);
            };
            type Row = (String, String, bool, Option<String>, Option<String>);
            let rows: Vec<Row> = db
                .prepare(
                    "SELECT v.id, v.author, v.received_at IS NULL, d.team_id, d.project_id
                     FROM document_versions v JOIN documents d ON d.id = v.document_id
                     WHERE v.blob_hash = ?1",
                )?
                .query_map(params![hash.as_str()], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                })?
                .collect::<Result<_, _>>()?;
            for (version_id, author, made_here, team_id, project_id) in rows {
                let scope = DocScope {
                    team_id,
                    project_id,
                };
                if !scope::may_view(db, &state, self.guests.as_ref(), peer, &scope)? {
                    continue;
                }
                if made_here
                    || may_reuse_blob(
                        db,
                        &state,
                        self.guests.as_ref(),
                        &author,
                        hash.as_str(),
                        &version_id,
                        false,
                    )?
                {
                    return Ok(true);
                }
            }
            Ok(false)
        });
        match allowed {
            Ok(true) if self.blobs.contains(&hash) => Some(self.blobs.path_of(&hash)),
            Ok(_) => None,
            Err(err) => {
                eprintln!(
                    "Mira: izin file dokumen tidak bisa diperiksa [{}]: {err}",
                    err.code()
                );
                None
            }
        }
    }
}

impl DocumentSync for DocsPeerSync {
    fn document_added(&self, doc: &store::DocumentRecord, first: &store::VersionRecord) {
        self.publish(&[
            DocPayload::Doc(RemoteDocument::from_record(doc)),
            DocPayload::Ver(RemoteVersion::from_record(first)),
        ]);
    }

    fn version_added(&self, _doc: &store::DocumentRecord, version: &store::VersionRecord) {
        self.publish(&[DocPayload::Ver(RemoteVersion::from_record(version))]);
    }

    fn editing_changed(&self, document_id: &str, editor: &str, editing: bool, at: &str) {
        self.publish(&[DocPayload::Edit(EditMark {
            document_id: document_id.to_owned(),
            editor: editor.to_owned(),
            editing,
            since: at.to_owned(),
            at: at.to_owned(),
        })]);
    }
}

#[cfg(test)]
mod tests;
