//! Queries on `profile_records` and `profile_fetch` (schema.rs).

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

/// Stores an accepted record. `false` when it was already there.
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

pub fn is_known(conn: &Connection, id: &str) -> AppResult<bool> {
    Ok(conn
        .query_row("SELECT 1 FROM profile_records WHERE id = ?1", [id], |_| {
            Ok(())
        })
        .optional()?
        .is_some())
}

pub fn unknown_ids(conn: &Connection, ids: &[String]) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT 1 FROM profile_records WHERE id = ?1")?;
    let mut out = Vec::new();
    for id in ids {
        if !stmt.exists([id])? {
            out.push(id.clone());
        }
    }
    Ok(out)
}

pub fn body_of(conn: &Connection, id: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT body FROM profile_records WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .optional()?)
}

/// Every stored record, for `record::effective`.
pub fn rows(conn: &Connection) -> AppResult<Vec<RecordRow>> {
    let mut stmt =
        conn.prepare("SELECT id, kind, owner, author, photo, size, seq, at FROM profile_records")?;
    let rows = stmt
        .query_map([], |r| {
            let kind: String = r.get(1)?;
            Ok((
                kind,
                RecordRow {
                    id: r.get(0)?,
                    kind: RecordKind::Clear,
                    owner: r.get(2)?,
                    author: r.get(3)?,
                    photo: r.get(4)?,
                    size: r.get::<_, Option<i64>>(5)?.map(to_u64),
                    seq: to_u64(r.get(6)?),
                    at: r.get(7)?,
                },
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows
        .into_iter()
        .filter_map(|(kind, mut row)| {
            row.kind = RecordKind::parse(&kind)?;
            Some(row)
        })
        .collect())
}

/// Highest `seq` of the owner's own `set`/`clear` records known here (0 when
/// none).
pub fn max_seq(conn: &Connection, owner: &str) -> AppResult<u64> {
    let n: Option<i64> = conn.query_row(
        "SELECT max(seq) FROM profile_records
         WHERE owner = ?1 AND author = ?1 AND kind IN ('set', 'clear')",
        [owner],
        |r| r.get(0),
    )?;
    Ok(n.map_or(0, to_u64))
}

/// Every photo hash any record names.
pub fn named_photos(conn: &Connection) -> AppResult<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT DISTINCT photo FROM profile_records WHERE photo IS NOT NULL")?;
    let out = stmt
        .query_map([], |r| r.get(0))?
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

/// Makes the queue hold exactly `wanted` (photos to fetch): adds missing
/// rows, drops rows no longer wanted. Retry state and `bad` of kept rows
/// stay. Returns `true` when a row was added.
pub fn sync_queue(conn: &Connection, wanted: &[PhotoJob]) -> AppResult<bool> {
    let mut added = false;
    for job in wanted {
        added |= conn.execute(
            "INSERT OR IGNORE INTO profile_fetch (hash, owner, size) VALUES (?1, ?2, ?3)",
            params![job.hash, job.owner, to_i64(job.size)],
        )? > 0;
    }
    let keep: Vec<&str> = wanted.iter().map(|j| j.hash.as_str()).collect();
    let mut stmt = conn.prepare("SELECT hash FROM profile_fetch")?;
    let queued = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for hash in queued {
        if !keep.contains(&hash.as_str()) {
            conn.execute("DELETE FROM profile_fetch WHERE hash = ?1", [&hash])?;
        }
    }
    Ok(added)
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

/// The bytes of `hash` are not a valid photo: never try it again.
pub fn mark_bad(conn: &Connection, hash: &str) -> AppResult<()> {
    conn.execute("UPDATE profile_fetch SET bad = 1 WHERE hash = ?1", [hash])?;
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

pub fn unqueue(conn: &Connection, hash: &str) -> AppResult<()> {
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
