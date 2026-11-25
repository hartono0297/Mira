//! Attachments on this laptop: the local download queue (`chat_fetch_queue`)
//! and the list of blobs chat put into the blob store (`chat_blobs`).
//!
//! The queue holds small attachments to copy automatically, large ones the
//! user asked for, and cipher files of envelopes (custodians keep them for the
//! recipient, the recipient decrypts them). The Tauri fetcher asks for due
//! jobs, downloads through `FeatureHub::fetch_blob`, and reports back with
//! `ChatSync::fetch_done` or `fetch_failed`. A failing job waits longer each
//! time (1 minute doubling up to 1 hour) and is dropped after 7 days.
//!
//! `chat_blobs` exists because the blob store is shared with documents and
//! signing: chat serves only blobs it put there itself, and deletes only
//! those it created (never one that was already present) once nothing
//! references them. `chat_blobs.convs` records for which conversations a
//! plain blob came in (attached by this laptop, fetched or decrypted for a
//! message there); `sync::ChatSync::blob_path_for` serves by that record,
//! never just because some message names the hash.
//!
//! v0.5.1: [`OFFICE_STICKERS`] in `chat_blobs.convs` marks an office sticker
//! image this laptop downloaded for the catalog (or uploaded itself, `own`).
//! It is served to every active member while an office sticker that is not
//! deleted uses it. Office stickers that are not deleted and this laptop's
//! own stickers keep their blob (`release`).
//!
//! Hashing and copying a file into the store happens outside the core lock
//! ([`copy_in`]); only the bookkeeping ([`track_copy`]) runs inside.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};

use crate::blobs::{BlobHash, BlobInfo, BlobStore};
use crate::error::{AppError, AppResult};
use crate::permissions::format::{format_time, parse_time};

/// First retry delay after a failed download.
pub const RETRY_BASE: Duration = Duration::minutes(1);
/// Longest wait between two tries.
pub const RETRY_MAX: Duration = Duration::hours(1);
/// A job failing for this long is dropped.
pub const GIVE_UP_AFTER: Duration = Duration::days(7);
/// Priority of a download the user asked for.
pub const PRIORITY_USER: i64 = 10;
/// Priority of cipher files for this laptop's own envelopes.
pub const PRIORITY_MINE: i64 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FetchKind {
    Plain,
    Cipher,
}

impl FetchKind {
    pub fn as_str(self) -> &'static str {
        match self {
            FetchKind::Plain => "plain",
            FetchKind::Cipher => "cipher",
        }
    }

    fn parse(s: &str) -> Self {
        if s == "cipher" {
            FetchKind::Cipher
        } else {
            FetchKind::Plain
        }
    }
}

/// One download for the fetcher loop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchJob {
    pub hash: String,
    pub size: u64,
    pub kind: FetchKind,
    /// Peers to try first (message author, the laptop that sent the record).
    pub prefer: Vec<String>,
}

/// Queue state of one blob, for `FileView.state`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueueState {
    pub failed: bool,
}

#[allow(clippy::too_many_arguments)]
pub fn queue(
    conn: &Connection,
    hash: &str,
    kind: FetchKind,
    size: u64,
    plain: Option<&str>,
    prefer: &[String],
    priority: i64,
    now: &str,
) -> AppResult<()> {
    let prefer = serde_json::to_string(prefer).unwrap_or_else(|_| "[]".into());
    conn.execute(
        "INSERT INTO chat_fetch_queue (hash, kind, size, plain, prefer, priority, queued_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (hash, kind) DO UPDATE SET
           next_try_at = CASE WHEN excluded.priority > chat_fetch_queue.priority
                              THEN NULL ELSE chat_fetch_queue.next_try_at END,
           priority = max(chat_fetch_queue.priority, excluded.priority)",
        params![
            hash,
            kind.as_str(),
            size_i64(size),
            plain,
            prefer,
            priority,
            now
        ],
    )?;
    Ok(())
}

pub fn unqueue(conn: &Connection, hash: &str, kind: FetchKind) -> AppResult<()> {
    conn.execute(
        "DELETE FROM chat_fetch_queue WHERE hash = ?1 AND kind = ?2",
        params![hash, kind.as_str()],
    )?;
    Ok(())
}

/// Pseudo conversation in `chat_blobs.convs` and the queue's `convs`: the
/// blob is held for the office sticker catalog (v0.5.1). It never parses as
/// a conversation, so conversation rules skip it.
pub const OFFICE_STICKERS: &str = "sticker:office";

/// Pseudo conversation in `chat_blobs.convs` (always `own`): this laptop's
/// person picked these bytes as one of their own stickers (v0.5.1). Never
/// served by it; it only says chat may use a preexisting blob as a sticker.
pub const MY_STICKERS: &str = "sticker:mine";

/// One of the sticker pseudo conversations above.
pub fn is_sticker_hold(conv: &str) -> bool {
    conv == OFFICE_STICKERS || conv == MY_STICKERS
}

/// Whether a message on this laptop (deleted or not) carries `hash`.
pub fn message_carries(conn: &Connection, hash: &str) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM chat_files WHERE hash = ?1)",
        [hash],
        |r| r.get(0),
    )?)
}

/// One conversation a plain blob is held for (`chat_blobs.convs`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlobConv {
    pub conv: String,
    /// Attached by this laptop to its own message there.
    #[serde(default)]
    pub own: bool,
}

/// Conversations plain blob `hash` is held for; empty when untracked.
pub fn blob_convs(conn: &Connection, hash: &str) -> AppResult<Vec<BlobConv>> {
    let json: Option<String> = conn
        .query_row(
            "SELECT convs FROM chat_blobs WHERE hash = ?1",
            [hash],
            |r| r.get(0),
        )
        .optional()?;
    Ok(json
        .and_then(|j| serde_json::from_str(&j).ok())
        .unwrap_or_default())
}

fn set_blob_convs(conn: &Connection, hash: &str, convs: &[BlobConv]) -> AppResult<()> {
    let json = serde_json::to_string(convs).unwrap_or_else(|_| "[]".into());
    conn.execute(
        "UPDATE chat_blobs SET convs = ?2 WHERE hash = ?1",
        params![hash, json],
    )?;
    Ok(())
}

/// Notes that this laptop holds plain blob `hash` (tracked already) for
/// `conv`: attached to its own message there (`own`), or fetched or
/// decrypted for a message there.
pub fn add_blob_conv(conn: &Connection, hash: &str, conv: &str, own: bool) -> AppResult<()> {
    let mut convs = blob_convs(conn, hash)?;
    match convs.iter_mut().find(|c| c.conv == conv) {
        Some(c) => c.own |= own,
        None => convs.push(BlobConv {
            conv: conv.to_owned(),
            own,
        }),
    }
    set_blob_convs(conn, hash, &convs)
}

fn queued_convs(conn: &Connection, hash: &str) -> AppResult<Vec<String>> {
    let json: Option<String> = conn
        .query_row(
            "SELECT convs FROM chat_fetch_queue WHERE hash = ?1 AND kind = 'plain'",
            [hash],
            |r| r.get(0),
        )
        .optional()?;
    Ok(json
        .and_then(|j| serde_json::from_str(&j).ok())
        .unwrap_or_default())
}

fn set_queued_convs(conn: &Connection, hash: &str, convs: &[String]) -> AppResult<()> {
    let json = serde_json::to_string(convs).unwrap_or_else(|_| "[]".into());
    conn.execute(
        "UPDATE chat_fetch_queue SET convs = ?2 WHERE hash = ?1 AND kind = 'plain'",
        params![hash, json],
    )?;
    Ok(())
}

/// Notes that the queued plain download of `hash` (queued already) is for a
/// message in `conv`.
pub fn queue_for_conv(conn: &Connection, hash: &str, conv: &str) -> AppResult<()> {
    let mut convs = queued_convs(conn, hash)?;
    if !convs.iter().any(|c| c == conv) {
        convs.push(conv.to_owned());
        set_queued_convs(conn, hash, &convs)?;
    }
    Ok(())
}

/// A plain download landed (and is tracked): the conversations it was queued
/// for become the conversations the blob is held for. Call before `unqueue`.
///
/// The office catalog ([`OFFICE_STICKERS`]) only holds bytes fetched for it
/// alone: when the job was also for a conversation, or a message here
/// carries the file, a peer may have sent it under that conversation's
/// rules, so it is not marked for the catalog (and never served to every
/// member).
pub fn land_fetch_convs(conn: &Connection, hash: &str) -> AppResult<()> {
    let convs = queued_convs(conn, hash)?;
    let shared = convs.iter().any(|c| !is_sticker_hold(c)) || message_carries(conn, hash)?;
    for conv in convs {
        if conv == OFFICE_STICKERS && shared {
            continue;
        }
        add_blob_conv(conn, hash, &conv, false)?;
    }
    Ok(())
}

/// Forgets that `hash` is held or queued for `conv` (its messages there are
/// gone).
pub fn forget_conv(conn: &Connection, hash: &str, conv: &str) -> AppResult<()> {
    let mut held = blob_convs(conn, hash)?;
    let before = held.len();
    held.retain(|c| c.conv != conv);
    if held.len() != before {
        set_blob_convs(conn, hash, &held)?;
    }
    let mut queued = queued_convs(conn, hash)?;
    let before = queued.len();
    queued.retain(|c| c != conv);
    if queued.len() != before {
        set_queued_convs(conn, hash, &queued)?;
    }
    Ok(())
}

/// A peer came online: every waiting job is due again.
pub fn reset_backoff(conn: &Connection) -> AppResult<()> {
    conn.execute(
        "UPDATE chat_fetch_queue SET next_try_at = NULL WHERE next_try_at IS NOT NULL",
        [],
    )?;
    Ok(())
}

/// Whether an unacked envelope lists `hash` among its cipher files.
pub fn live_envelope_lists(conn: &Connection, hash: &str) -> AppResult<bool> {
    let mut stmt =
        conn.prepare_cached("SELECT cipher_files FROM chat_envelopes WHERE acked = 0")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let json: String = row.get(0)?;
        let files: Vec<super::model::CipherFileRef> =
            serde_json::from_str(&json).unwrap_or_default();
        if files.iter().any(|f| f.hash == hash) {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn queue_state(
    conn: &Connection,
    hash: &str,
    kind: FetchKind,
) -> AppResult<Option<QueueState>> {
    Ok(conn
        .query_row(
            "SELECT last_error FROM chat_fetch_queue WHERE hash = ?1 AND kind = ?2",
            params![hash, kind.as_str()],
            |r| {
                Ok(QueueState {
                    failed: r.get::<_, Option<String>>(0)?.is_some(),
                })
            },
        )
        .optional()?)
}

/// Queue state of the cipher job that will produce plaintext `hash`, if any.
pub fn cipher_state_for_plain(conn: &Connection, hash: &str) -> AppResult<Option<QueueState>> {
    Ok(conn
        .query_row(
            "SELECT last_error FROM chat_fetch_queue WHERE kind = 'cipher' AND plain = ?1 LIMIT 1",
            [hash],
            |r| {
                Ok(QueueState {
                    failed: r.get::<_, Option<String>>(0)?.is_some(),
                })
            },
        )
        .optional()?)
}

/// Every job, due or not (for clean-up).
pub fn all_jobs(conn: &Connection) -> AppResult<Vec<FetchJob>> {
    jobs_where(conn, "1 = 1", "")
}

/// Jobs whose next try time has come, most important first.
pub fn due_jobs(conn: &Connection, now: &str) -> AppResult<Vec<FetchJob>> {
    jobs_where(conn, "next_try_at IS NULL OR next_try_at <= ?1", now)
}

fn jobs_where(conn: &Connection, filter: &str, now: &str) -> AppResult<Vec<FetchJob>> {
    let sql = format!(
        "SELECT hash, size, kind, prefer FROM chat_fetch_queue WHERE ({filter}) AND ?1 = ?1
         ORDER BY priority DESC, queued_at, hash"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([now], |r| {
            let prefer: String = r.get(3)?;
            Ok(FetchJob {
                hash: r.get(0)?,
                size: u64::try_from(r.get::<_, i64>(1)?).unwrap_or(0),
                kind: FetchKind::parse(&r.get::<_, String>(2)?),
                prefer: serde_json::from_str(&prefer).unwrap_or_default(),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Records a failed try. Returns `true` when the job was dropped for good.
pub fn mark_failed(
    conn: &Connection,
    job: &FetchJob,
    err: &str,
    now: OffsetDateTime,
) -> AppResult<bool> {
    let row: Option<(i64, Option<String>)> = conn
        .query_row(
            "SELECT attempts, first_error_at FROM chat_fetch_queue WHERE hash = ?1 AND kind = ?2",
            params![job.hash, job.kind.as_str()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((attempts, first)) = row else {
        return Ok(false);
    };
    let first = first.as_deref().and_then(parse_time).unwrap_or(now);
    if now - first > GIVE_UP_AFTER {
        unqueue(conn, &job.hash, job.kind)?;
        return Ok(true);
    }
    let shift = u32::try_from(attempts.clamp(0, 10)).unwrap_or(10);
    let delay = (RETRY_BASE * (1i32 << shift)).min(RETRY_MAX);
    let err: String = err.chars().take(300).collect();
    conn.execute(
        "UPDATE chat_fetch_queue SET attempts = attempts + 1, last_try_at = ?3, next_try_at = ?4,
           first_error_at = ?5, last_error = ?6
         WHERE hash = ?1 AND kind = ?2",
        params![
            job.hash,
            job.kind.as_str(),
            format_time(now),
            format_time(now + delay),
            format_time(first),
            err
        ],
    )?;
    Ok(false)
}

fn size_i64(size: u64) -> i64 {
    i64::try_from(size).unwrap_or(i64::MAX)
}

/// BLAKE3 of a file, streamed.
pub fn hash_file(path: &Path) -> AppResult<(BlobHash, u64)> {
    let mut file = File::open(path).map_err(|e| file_err(path, &e))?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let n = file.read(&mut buf).map_err(|e| file_err(path, &e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    Ok((BlobHash::parse(hasher.finalize().to_hex().as_str())?, total))
}

fn file_err(path: &Path, e: &std::io::Error) -> AppError {
    AppError::Storage(format!(
        "File {} tidak bisa dibaca. Detail: {e}",
        path.display()
    ))
}

/// Notes that chat put `hash` into the store. The first entry wins, so a blob
/// that was present before chat touched it stays marked as preexisting.
pub fn track(
    conn: &Connection,
    hash: &str,
    kind: FetchKind,
    preexisting: bool,
    now: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO chat_blobs (hash, kind, preexisting, added_at) VALUES (?1, ?2, ?3, ?4)",
        params![hash, kind.as_str(), preexisting, now],
    )?;
    Ok(())
}

/// A file copied into the blob store outside the core lock, waiting for
/// [`track_copy`].
#[derive(Debug, Clone)]
pub struct Copied {
    pub info: BlobInfo,
    /// The blob was in the store before this copy.
    pub preexisting: bool,
}

/// Copies `path`, whose BLAKE3 is `hash`, into the store. No database work:
/// call it before taking the core lock.
pub fn copy_in(blobs: &BlobStore, path: &Path, hash: &BlobHash) -> AppResult<Copied> {
    let pre = blobs.contains(hash);
    let info = blobs.put_file(path)?;
    let preexisting = pre && info.hash == *hash;
    Ok(Copied { info, preexisting })
}

/// Records a [`copy_in`] inside the transaction. If chat released and removed
/// the blob in between, it is copied again (rare; the only copy under lock).
pub fn track_copy(
    conn: &Connection,
    blobs: &BlobStore,
    copied: &Copied,
    path: &Path,
    kind: FetchKind,
    now: &str,
) -> AppResult<()> {
    let mut preexisting = copied.preexisting;
    if !blobs.contains(&copied.info.hash) {
        blobs.put_file(path)?;
        preexisting = false;
    }
    track(conn, copied.info.hash.as_str(), kind, preexisting, now)
}

pub fn put_tracked_bytes(
    conn: &Connection,
    blobs: &BlobStore,
    bytes: &[u8],
    kind: FetchKind,
    now: &str,
) -> AppResult<BlobInfo> {
    let pre = blobs.contains(&BlobHash::of_bytes(bytes));
    let info = blobs.put_bytes(bytes)?;
    track(conn, info.hash.as_str(), kind, pre, now)?;
    Ok(info)
}

/// If chat created `hash` and nothing references it any more (no message
/// file, no unacked envelope, no document version, no signing request, no
/// office sticker that is not deleted, none of this laptop's own stickers),
/// forgets it and returns `true`: the caller removes the file after commit.
pub fn release(conn: &Connection, hash: &str) -> AppResult<bool> {
    let created: Option<bool> = conn
        .query_row(
            "SELECT preexisting = 0 FROM chat_blobs WHERE hash = ?1",
            [hash],
            |r| r.get(0),
        )
        .optional()?;
    if created != Some(true) {
        return Ok(false);
    }
    let refs: i64 = conn.query_row(
        "SELECT (SELECT count(*) FROM chat_files WHERE hash = ?1)
              + (SELECT count(*) FROM document_versions WHERE blob_hash = ?1)
              + (SELECT count(*) FROM sign_requests WHERE original_hash = ?1 OR current_hash = ?1)",
        params![hash],
        |r| r.get(0),
    )?;
    if refs > 0 || live_envelope_lists(conn, hash)? || super::stickers::holds_blob(conn, hash)? {
        return Ok(false);
    }
    conn.execute("DELETE FROM chat_blobs WHERE hash = ?1", [hash])?;
    conn.execute("DELETE FROM chat_fetch_queue WHERE hash = ?1", [hash])?;
    Ok(true)
}
