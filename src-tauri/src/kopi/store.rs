//! SQLite tables of Kopi (docs/plans/kopi.md, 3.2).
//!
//! The tables are created on first use ([`ensure_schema`], called by every
//! function here) instead of through a numbered migration, so parallel
//! branches that add migrations never clash with this one.
//!
//! - `kopi_records`: records that passed `record::open` and the ingest
//!   checks, with the exact body as received.
//! - `kopi_seen`: ids never asked for again: work snapshots replaced by a
//!   newer one of the same author (or that arrived after a newer one),
//!   records whose content can never pass `record::open` (bad signature or
//!   shape, with an id that does match the body), and this laptop's own
//!   records retired because their `at` was far in the future.
//! - `kopi_published`: per author, the hash of the work items this laptop
//!   last published (used by `runtime.rs`).

use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;

use super::record;
use super::types::{Payload, StoredRecord};
use crate::clock;
use crate::error::{AppError, AppResult};
use crate::network::feature::FeatureRecord;
use crate::state::Core;

/// Creates the Kopi tables when missing. Cheap; called before every use.
pub fn ensure_schema(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS kopi_records (
             id TEXT PRIMARY KEY,
             author TEXT NOT NULL,
             kind TEXT NOT NULL,
             body TEXT NOT NULL,
             at TEXT NOT NULL,
             received_at TEXT NOT NULL,
             received_from TEXT
         ) STRICT;
         CREATE INDEX IF NOT EXISTS kopi_records_author_kind ON kopi_records (author, kind);
         CREATE TABLE IF NOT EXISTS kopi_seen (id TEXT PRIMARY KEY) STRICT;
         CREATE TABLE IF NOT EXISTS kopi_published (
             author TEXT PRIMARY KEY,
             items_hash TEXT NOT NULL
         ) STRICT;",
    )?;
    Ok(())
}

/// `true` when `id` is stored or was seen and dropped (an older work
/// snapshot).
pub fn known(conn: &Connection, id: &str) -> AppResult<bool> {
    ensure_schema(conn)?;
    let n: i64 = conn.query_row(
        "SELECT (SELECT COUNT(*) FROM kopi_records WHERE id = ?1)
              + (SELECT COUNT(*) FROM kopi_seen WHERE id = ?1)",
        params![id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// Order of two records: `(at as an instant, id)`. A time that does not
/// parse sorts first (never happens for stored records).
fn order_key(at: &str, id: &str) -> (Option<time::OffsetDateTime>, String) {
    (record::parse_at(at), id.to_owned())
}

/// Stores a checked record. Returns `true` when it is stored now; `false`
/// for a duplicate or a work snapshot older than the author's stored one
/// (that id goes to `kopi_seen`). A newer work snapshot replaces the
/// author's older ones, which move to `kopi_seen`.
pub fn insert(
    conn: &Connection,
    rec: &FeatureRecord,
    opened: &StoredRecord,
    from: Option<&str>,
) -> AppResult<bool> {
    ensure_schema(conn)?;
    if known(conn, &rec.id)? {
        return Ok(false);
    }
    let at = record::payload_at(&opened.payload);
    if matches!(opened.payload, Payload::Work { .. }) {
        let mine = order_key(at, &rec.id);
        let existing = work_records(conn, &opened.author)?;
        if existing.iter().any(|(id, a)| order_key(a, id) > mine) {
            conn.execute("INSERT OR IGNORE INTO kopi_seen (id) VALUES (?1)", params![rec.id])?;
            return Ok(false);
        }
        for (id, _) in existing {
            conn.execute("DELETE FROM kopi_records WHERE id = ?1", params![id])?;
            conn.execute("INSERT OR IGNORE INTO kopi_seen (id) VALUES (?1)", params![id])?;
        }
    }
    let n = conn.execute(
        "INSERT OR IGNORE INTO kopi_records (id, author, kind, body, at, received_at, received_from)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            rec.id,
            opened.author,
            record::kind_name(&opened.payload),
            rec.body,
            at,
            clock::now_rfc3339(),
            from,
        ],
    )?;
    Ok(n == 1)
}

/// `(id, at)` of the stored work snapshots of `author` (normally one).
pub fn work_records(conn: &Connection, author: &str) -> AppResult<Vec<(String, String)>> {
    ensure_schema(conn)?;
    let mut stmt =
        conn.prepare("SELECT id, at FROM kopi_records WHERE author = ?1 AND kind = 'work'")?;
    let rows = stmt
        .query_map(params![author], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Remembers `id` as seen without storing it, so it is never asked for
/// again (a record that can never pass `record::open`).
pub fn forget(conn: &Connection, id: &str) -> AppResult<()> {
    ensure_schema(conn)?;
    conn.execute("INSERT OR IGNORE INTO kopi_seen (id) VALUES (?1)", params![id])?;
    Ok(())
}

/// Moves a stored record to `kopi_seen`: it no longer counts here and is
/// neither offered nor asked for again.
pub fn retire(conn: &Connection, id: &str) -> AppResult<()> {
    ensure_schema(conn)?;
    conn.execute("DELETE FROM kopi_records WHERE id = ?1", params![id])?;
    conn.execute("INSERT OR IGNORE INTO kopi_seen (id) VALUES (?1)", params![id])?;
    Ok(())
}

/// Stored gives by `author` whose `at` is on the local `day` (`YYYY-MM-DD`,
/// the date written in `at`).
pub fn gives_on(conn: &Connection, author: &str, day: &str) -> AppResult<usize> {
    ensure_schema(conn)?;
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM kopi_records
         WHERE author = ?1 AND kind = 'give' AND substr(at, 1, 10) = ?2",
        params![author, day],
        |r| r.get(0),
    )?;
    Ok(usize::try_from(n).unwrap_or(usize::MAX))
}

/// Stored `hide` and `settings` records by `author` whose `at` falls on the
/// UTC `day` (`YYYY-MM-DD`; SQLite's `date()` reads the offset in `at`).
pub fn admin_on(conn: &Connection, author: &str, day: &str) -> AppResult<usize> {
    ensure_schema(conn)?;
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM kopi_records
         WHERE author = ?1 AND kind IN ('hide', 'settings') AND date(at) = ?2",
        params![author, day],
        |r| r.get(0),
    )?;
    Ok(usize::try_from(n).unwrap_or(usize::MAX))
}

/// Changes whenever a Kopi record is stored, replaced or retired.
pub fn records_marker(conn: &Connection) -> AppResult<String> {
    ensure_schema(conn)?;
    Ok(conn.query_row(
        "SELECT (SELECT COUNT(*) FROM kopi_records) || ':'
              || (SELECT COALESCE(MAX(rowid), 0) FROM kopi_records) || ':'
              || (SELECT COUNT(*) FROM kopi_seen)",
        [],
        |r| r.get(0),
    )?)
}

/// Changes whenever a board change arrives or is made, or a board project
/// is added, removed or rewritten.
pub fn board_marker(conn: &Connection) -> AppResult<String> {
    Ok(conn.query_row(
        "SELECT (SELECT COUNT(*) FROM board_changes) || ':'
              || (SELECT COALESCE(MAX(rowid), 0) FROM board_changes) || ':'
              || (SELECT COUNT(*) FROM board_projects) || ':'
              || (SELECT COALESCE(MAX(rowid), 0) FROM board_projects) || ':'
              || (SELECT COALESCE(MAX(updated_at), '') FROM board_projects)",
        [],
        |r| r.get(0),
    )?)
}

/// Changes whenever the membership log changes (an op stored or its status
/// changed) or the organization itself does.
pub fn org_marker(conn: &Connection) -> AppResult<String> {
    Ok(conn.query_row(
        "SELECT (SELECT COUNT(*) FROM org_ops) || ':'
              || (SELECT COALESCE(MAX(rowid), 0) FROM org_ops) || ':'
              || (SELECT COALESCE(SUM(status = 'applied'), 0) FROM org_ops) || ':'
              || (SELECT COALESCE(group_concat(id), '') FROM organizations)",
        [],
        |r| r.get(0),
    )?)
}

/// `at` of the stored work snapshot of `author`, if any.
pub fn latest_work_at(conn: &Connection, author: &str) -> AppResult<Option<String>> {
    ensure_schema(conn)?;
    Ok(work_records(conn, author)?
        .into_iter()
        .max_by(|a, b| order_key(&a.1, &a.0).cmp(&order_key(&b.1, &b.0)))
        .map(|(_, at)| at))
}

/// The parts of an envelope needed to read a stored record again. The
/// signature was checked when it was stored.
#[derive(Deserialize)]
struct StoredBody {
    a: String,
    p: String,
}

fn parse_stored(id: String, body: &str) -> Option<StoredRecord> {
    let b: StoredBody = serde_json::from_str(body).ok()?;
    let payload: Payload = serde_json::from_str(&b.p).ok()?;
    Some(StoredRecord {
        id,
        author: b.a,
        payload,
    })
}

/// Every stored record, by id. A row that no longer parses is skipped.
pub fn load_all(conn: &Connection) -> AppResult<Vec<StoredRecord>> {
    ensure_schema(conn)?;
    let mut stmt = conn.prepare("SELECT id, body FROM kopi_records ORDER BY id")?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, body)| parse_stored(id, &body))
        .collect())
}

/// Ids of every stored record, sorted.
pub fn ids(conn: &Connection) -> AppResult<Vec<String>> {
    ensure_schema(conn)?;
    let mut stmt = conn.prepare("SELECT id FROM kopi_records ORDER BY id")?;
    let ids = stmt
        .query_map([], |r| r.get(0))?
        .collect::<Result<Vec<String>, _>>()?;
    Ok(ids)
}

/// The stored records among `ids`, in the order asked; unknown ids are
/// skipped.
pub fn bodies(conn: &Connection, ids: &[String]) -> AppResult<Vec<FeatureRecord>> {
    ensure_schema(conn)?;
    let mut stmt = conn.prepare("SELECT body FROM kopi_records WHERE id = ?1")?;
    let mut out = Vec::new();
    for id in ids {
        let body: Option<String> = stmt.query_row(params![id], |r| r.get(0)).optional()?;
        if let Some(body) = body {
            out.push(FeatureRecord {
                id: id.clone(),
                body,
            });
        }
    }
    Ok(out)
}

/// Hash of the work items this laptop last published for `author`.
pub fn published_hash(conn: &Connection, author: &str) -> AppResult<Option<String>> {
    ensure_schema(conn)?;
    Ok(conn
        .query_row(
            "SELECT items_hash FROM kopi_published WHERE author = ?1",
            params![author],
            |r| r.get(0),
        )
        .optional()?)
}

pub fn set_published_hash(conn: &Connection, author: &str, hash: &str) -> AppResult<()> {
    ensure_schema(conn)?;
    conn.execute(
        "INSERT INTO kopi_published (author, items_hash) VALUES (?1, ?2)
         ON CONFLICT (author) DO UPDATE SET items_hash = excluded.items_hash",
        params![author, hash],
    )?;
    Ok(())
}

/// Seals `payload` with this laptop's key and stores it. A payload that
/// fails `record::validate_shape` is `InvalidInput`. The caller calls
/// `FeatureHub::notify_changed(TOPIC_KOPI)` afterwards.
pub fn seal_and_store(core: &mut Core, payload: &Payload) -> AppResult<FeatureRecord> {
    let rec = record::seal(&core.identity, payload).map_err(AppError::InvalidInput)?;
    let opened = record::open(&rec).map_err(AppError::Internal)?;
    insert(&core.db, &rec, &opened, None)?;
    Ok(rec)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::MemoryKeyStore;
    use crate::kopi::types::{Target, WorkItem, WorkWhy};
    use crate::state::MiraState;

    fn state() -> (tempfile::TempDir, MiraState) {
        let tmp = tempfile::tempdir().unwrap();
        let s = MiraState::new(Ok(tmp.path().to_path_buf()), Box::new(MemoryKeyStore::new()));
        (tmp, s)
    }

    fn work(at: &str, n: usize) -> Payload {
        Payload::Work {
            at: at.into(),
            items: (0..n)
                .map(|i| WorkItem {
                    p: "ab".repeat(16),
                    t: format!("{:032x}", i),
                    done: "2026-11-24T01:00:00Z".into(),
                    why: WorkWhy::Assigned,
                })
                .collect(),
        }
    }

    fn give() -> Payload {
        Payload::Give {
            to: "bb".repeat(32),
            target: Target::Message { id: "m1".into() },
            reason: "Makasih".into(),
            at: "2026-11-24T10:00:00+07:00".into(),
            nonce: "00112233aabbccdd".into(),
        }
    }

    #[test]
    fn insert_is_idempotent_and_reads_back() {
        let (_t, s) = state();
        s.with_core(|c| {
            let rec = record::seal(&c.identity, &give()).unwrap();
            let opened = record::open(&rec).unwrap();
            assert!(insert(&c.db, &rec, &opened, Some("cc")).unwrap());
            assert!(!insert(&c.db, &rec, &opened, Some("cc")).unwrap());
            assert!(known(&c.db, &rec.id).unwrap());
            assert!(!known(&c.db, &"00".repeat(32)).unwrap());
            assert_eq!(ids(&c.db).unwrap(), vec![rec.id.clone()]);
            assert_eq!(load_all(&c.db).unwrap(), vec![opened]);
            let got = bodies(&c.db, &[rec.id.clone(), "x".into()]).unwrap();
            assert_eq!(got, vec![rec]);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn newer_work_snapshot_replaces_older_and_older_is_only_seen() {
        let (_t, s) = state();
        s.with_core(|c| {
            let old = record::seal(&c.identity, &work("2026-11-24T08:00:00Z", 1)).unwrap();
            let new = record::seal(&c.identity, &work("2026-11-24T09:00:00Z", 2)).unwrap();
            let older = record::seal(&c.identity, &work("2026-11-24T07:00:00Z", 3)).unwrap();
            let o = |r: &FeatureRecord| record::open(r).unwrap();

            assert!(insert(&c.db, &old, &o(&old), None).unwrap());
            assert!(insert(&c.db, &new, &o(&new), None).unwrap());
            assert_eq!(ids(&c.db).unwrap(), vec![new.id.clone()]);
            // The replaced one is known, so `unknown_ids` never asks again.
            assert!(known(&c.db, &old.id).unwrap());
            assert!(!insert(&c.db, &old, &o(&old), None).unwrap());

            // Arrives after a newer one: only recorded as seen.
            assert!(!insert(&c.db, &older, &o(&older), None).unwrap());
            assert!(known(&c.db, &older.id).unwrap());
            assert_eq!(ids(&c.db).unwrap(), vec![new.id.clone()]);
            assert_eq!(
                latest_work_at(&c.db, c.identity.public_key_hex()).unwrap().as_deref(),
                Some("2026-11-24T09:00:00Z")
            );

            // Gives are untouched by snapshots.
            let g = record::seal(&c.identity, &give()).unwrap();
            assert!(insert(&c.db, &g, &o(&g), None).unwrap());
            assert_eq!(ids(&c.db).unwrap().len(), 2);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn seal_and_store_and_published_hash() {
        let (_t, s) = state();
        s.with_core(|c| {
            let rec = seal_and_store(c, &give())?;
            assert!(known(&c.db, &rec.id)?);
            let me = c.identity.public_key_hex().to_owned();
            let mut bad = give();
            if let Payload::Give { to, .. } = &mut bad {
                *to = me.clone();
            }
            assert_eq!(seal_and_store(c, &bad).unwrap_err().code(), "invalid_input");

            assert_eq!(published_hash(&c.db, &me)?, None);
            set_published_hash(&c.db, &me, "h1")?;
            set_published_hash(&c.db, &me, "h2")?;
            assert_eq!(published_hash(&c.db, &me)?.as_deref(), Some("h2"));
            Ok(())
        })
        .unwrap();
    }
}
