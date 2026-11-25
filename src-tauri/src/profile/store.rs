//! Queries on `profile_records`, `profile_seen` and `profile_fetch`
//! (schema.rs).

use rusqlite::{Connection, OptionalExtension, params};
use time::{Duration, OffsetDateTime};

use super::record::{ProfileRecord, RecordKind, RecordRow};
use crate::error::AppResult;
use crate::permissions::format::format_time;

/// First wait after a failed photo download.
pub const RETRY_BASE: Duration = Duration::seconds(60);
/// Longest wait between two tries.
pub const RETRY_MAX: Duration = Duration::hours(1);

fn to_i64(n: u64) -> i64 {
    i64::try_from(n).unwrap_or(i64::MAX)
}

fn to_u64(n: i64) -> u64 {
    u64::try_from(n).unwrap_or(0)
}

/// Stores an accepted record as a live row. `false` when it was already
/// there.
pub fn insert(
    conn: &Connection,
    id: &str,
    rec: &ProfileRecord,
    body: &str,
    now: OffsetDateTime,
) -> AppResult<bool> {
    let n = conn.execute(
        "INSERT OR IGNORE INTO profile_records
           (id, owner, author, kind, photo, size, seq, at, body, received_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            id,
            rec.owner,
            rec.author,
            rec.kind.as_str(),
            rec.photo,
            rec.size.map(to_i64),
            to_i64(rec.seq),
            rec.at,
            body,
            format_time(now),
        ],
    )?;
    Ok(n > 0)
}

/// Remembers only the id of a record that lost to a newer one (a
/// tombstone): known to `unknown_ids`, never stored in full or offered.
pub fn forget(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("INSERT OR IGNORE INTO profile_seen (id) VALUES (?1)", [id])?;
    Ok(())
}

/// What [`put_owner_record`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Placed {
    /// An equal or newer record of the owner is stored: kept as a tombstone.
    Lost,
    /// Now the owner's record; `replaced` was the one before (now a tombstone).
    Won { replaced: Option<RecordRow> },
}

/// Stores an owner `set`/`clear` record when it beats the owner's current
/// one by `(seq, at, id)`. The loser of the two keeps only its id.
pub fn put_owner_record(
    conn: &Connection,
    id: &str,
    rec: &ProfileRecord,
    body: &str,
    now: OffsetDateTime,
) -> AppResult<Placed> {
    let cur = current(conn, &rec.owner)?;
    if let Some(c) = &cur
        && (c.seq, c.at.as_str(), c.id.as_str()) >= (rec.seq, rec.at.as_str(), id)
    {
        if c.id != id {
            forget(conn, id)?;
        }
        return Ok(Placed::Lost);
    }
    if let Some(c) = &cur {
        conn.execute("DELETE FROM profile_records WHERE id = ?1", [&c.id])?;
        forget(conn, &c.id)?;
    }
    insert(conn, id, rec, body, now)?;
    Ok(Placed::Won { replaced: cur })
}

pub fn is_known(conn: &Connection, id: &str) -> AppResult<bool> {
    Ok(unknown_ids(conn, &[id.to_owned()])?.is_empty())
}

pub fn unknown_ids(conn: &Connection, ids: &[String]) -> AppResult<Vec<String>> {
    let mut live = conn.prepare_cached("SELECT 1 FROM profile_records WHERE id = ?1")?;
    let mut seen = conn.prepare_cached("SELECT 1 FROM profile_seen WHERE id = ?1")?;
    let mut out = Vec::new();
    for id in ids {
        if !live.exists([id])? && !seen.exists([id])? {
            out.push(id.clone());
        }
    }
    Ok(out)
}

const ROW_COLUMNS: &str = "id, kind, owner, author, photo, size, seq, at";

fn read_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Option<RecordRow>> {
    let kind: String = r.get(1)?;
    let Some(kind) = RecordKind::parse(&kind) else {
        return Ok(None);
    };
    Ok(Some(RecordRow {
        id: r.get(0)?,
        kind,
        owner: r.get(2)?,
        author: r.get(3)?,
        photo: r.get(4)?,
        size: r.get::<_, Option<i64>>(5)?.map(to_u64),
        seq: to_u64(r.get(6)?),
        at: r.get(7)?,
    }))
}

/// Row and body of a live record.
pub fn live_record(conn: &Connection, id: &str) -> AppResult<Option<(RecordRow, String)>> {
    let found = conn
        .query_row(
            &format!("SELECT {ROW_COLUMNS}, body FROM profile_records WHERE id = ?1"),
            [id],
            |r| {
                let body: String = r.get(8)?;
                Ok(read_row(r)?.map(|row| (row, body)))
            },
        )
        .optional()?;
    Ok(found.flatten())
}

/// Every live record (one owner record per owner plus the removes), for
/// `record::effective`.
pub fn rows(conn: &Connection) -> AppResult<Vec<RecordRow>> {
    let mut stmt = conn.prepare(&format!("SELECT {ROW_COLUMNS} FROM profile_records"))?;
    let rows = stmt
        .query_map([], read_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows.into_iter().flatten().collect())
}

/// The owner's winning `set`/`clear` record (`profile_records_current`).
pub fn current(conn: &Connection, owner: &str) -> AppResult<Option<RecordRow>> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT {ROW_COLUMNS} FROM profile_records WHERE owner = ?1 AND kind <> 'remove'"
            ),
            [owner],
            read_row,
        )
        .optional()?
        .flatten())
}

/// Highest `seq` of the owner's own `set`/`clear` records known here (0 when
/// none). The current record always has it.
pub fn max_seq(conn: &Connection, owner: &str) -> AppResult<u64> {
    Ok(current(conn, owner)?.map_or(0, |r| r.seq))
}

/// Owners whose current record sets `hash`, with the size they give.
pub fn setters(conn: &Connection, hash: &str) -> AppResult<Vec<(String, u64)>> {
    let mut stmt = conn.prepare_cached(
        "SELECT owner, size FROM profile_records WHERE photo = ?1 AND kind = 'set'",
    )?;
    let out = stmt
        .query_map([hash], |r| {
            Ok((r.get(0)?, to_u64(r.get::<_, Option<i64>>(1)?.unwrap_or(0))))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(out)
}

/// Authors of the `remove` records naming `hash` (any owner).
pub fn removers(conn: &Connection, hash: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare_cached(
        "SELECT author FROM profile_records WHERE photo = ?1 AND kind = 'remove'",
    )?;
    let out = stmt
        .query_map([hash], |r| r.get(0))?
        .collect::<Result<Vec<String>, _>>()?;
    Ok(out)
}

/// One photo to download.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhotoJob {
    pub hash: String,
    pub owner: String,
    pub size: u64,
}

/// Makes the queue hold `wanted` (photos to fetch): adds missing rows, drops
/// rows no longer wanted. Retry state of kept rows stays, and `bad` rows are
/// never dropped, so a hash that failed (or crashed) the check is not
/// downloaded and decoded again. Returns `true` when a row was added.
pub fn sync_queue(conn: &Connection, wanted: &[PhotoJob]) -> AppResult<bool> {
    let mut added = false;
    for job in wanted {
        added |= enqueue(conn, job)?;
    }
    let keep: Vec<&str> = wanted.iter().map(|j| j.hash.as_str()).collect();
    let mut stmt = conn.prepare("SELECT hash FROM profile_fetch WHERE bad = 0")?;
    let queued = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for hash in queued {
        if !keep.contains(&hash.as_str()) {
            unqueue(conn, &hash)?;
        }
    }
    Ok(added)
}

/// Queues one photo (left as it is when already queued). `true` when added.
pub fn enqueue(conn: &Connection, job: &PhotoJob) -> AppResult<bool> {
    Ok(conn.execute(
        "INSERT OR IGNORE INTO profile_fetch (hash, owner, size) VALUES (?1, ?2, ?3)",
        params![job.hash, job.owner, to_i64(job.size)],
    )? > 0)
}

/// Queued jobs that are not bad and whose next try time has come.
pub fn due_jobs(conn: &Connection, now: OffsetDateTime) -> AppResult<Vec<PhotoJob>> {
    let mut stmt = conn.prepare(
        "SELECT hash, owner, size FROM profile_fetch
         WHERE bad = 0 AND (next_try_at IS NULL OR next_try_at <= ?1)
         ORDER BY attempts, hash",
    )?;
    let out = stmt
        .query_map([format_time(now)], |r| {
            Ok(PhotoJob {
                hash: r.get(0)?,
                owner: r.get(1)?,
                size: to_u64(r.get(2)?),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(out)
}

/// Waits longer after each failure: 60 seconds, doubling, at most an hour.
pub fn retry_delay(attempts: i64) -> Duration {
    let shift = u32::try_from(attempts.clamp(0, 10)).unwrap_or(10);
    (RETRY_BASE * (1i32 << shift)).min(RETRY_MAX)
}

pub fn mark_failed(conn: &Connection, hash: &str, now: OffsetDateTime) -> AppResult<()> {
    let attempts: Option<i64> = conn
        .query_row(
            "SELECT attempts FROM profile_fetch WHERE hash = ?1",
            [hash],
            |r| r.get(0),
        )
        .optional()?;
    let Some(attempts) = attempts else {
        return Ok(());
    };
    conn.execute(
        "UPDATE profile_fetch SET attempts = attempts + 1, next_try_at = ?2 WHERE hash = ?1",
        params![hash, format_time(now + retry_delay(attempts))],
    )?;
    Ok(())
}

/// The bytes of `job` are not a valid photo, or are about to be decoded:
/// never try that hash again. Adds the row when it is gone.
pub fn mark_bad(conn: &Connection, job: &PhotoJob) -> AppResult<()> {
    conn.execute(
        "INSERT INTO profile_fetch (hash, owner, size, bad) VALUES (?1, ?2, ?3, 1)
         ON CONFLICT (hash) DO UPDATE SET bad = 1",
        params![job.hash, job.owner, to_i64(job.size)],
    )?;
    Ok(())
}

pub fn is_bad(conn: &Connection, hash: &str) -> AppResult<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM profile_fetch WHERE hash = ?1 AND bad = 1",
            [hash],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// Drops a queued job. `bad` rows stay.
pub fn unqueue(conn: &Connection, hash: &str) -> AppResult<()> {
    conn.execute("DELETE FROM profile_fetch WHERE hash = ?1 AND bad = 0", [hash])?;
    Ok(())
}

/// Drops the row of a hash whose bytes passed the check.
pub fn checked_ok(conn: &Connection, hash: &str) -> AppResult<()> {
    conn.execute("DELETE FROM profile_fetch WHERE hash = ?1", [hash])?;
    Ok(())
}

/// A colleague came online: try every (not bad) job now.
pub fn reset_backoff(conn: &Connection) -> AppResult<()> {
    conn.execute(
        "UPDATE profile_fetch SET next_try_at = NULL WHERE next_try_at IS NOT NULL",
        [],
    )?;
    Ok(())
}
