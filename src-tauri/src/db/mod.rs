//! Local SQLite database (`<data_dir>/mira.db`) and numbered migrations.
//!
//! The schema version lives in `PRAGMA user_version`. Migration N (1-based)
//! is `migrations::MIGRATIONS[N - 1]`; each one runs in its own transaction
//! together with the `user_version` bump, so a failed migration leaves the
//! database at the previous version. Later stages only append to the list.

mod migrations;

use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, TransactionBehavior};

use crate::error::{AppError, AppResult};

pub const DB_FILE_NAME: &str = "mira.db";

/// Opens (or creates) `<data_dir>/mira.db`, configures it and runs pending migrations.
pub fn open(data_dir: &Path) -> AppResult<Connection> {
    let mut conn = Connection::open(data_dir.join(DB_FILE_NAME))?;
    configure(&conn)?;
    migrate(&mut conn)?;
    Ok(conn)
}

fn configure(conn: &Connection) -> AppResult<()> {
    conn.busy_timeout(Duration::from_secs(5))?;
    let mode: String = conn.pragma_update_and_check(None, "journal_mode", "WAL", |r| r.get(0))?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(AppError::Database(format!(
            "Database lokal Mira tidak bisa memakai mode WAL (mode sekarang: {mode})."
        )));
    }
    conn.pragma_update(None, "foreign_keys", "ON")?;
    // FULL: a power cut must not lose a committed identity or organization.
    conn.pragma_update(None, "synchronous", "FULL")?;
    Ok(())
}

/// Highest schema version this build knows about.
pub fn latest_version() -> u32 {
    migrations::MIGRATIONS.len() as u32
}

pub fn schema_version(conn: &Connection) -> AppResult<u32> {
    Ok(conn.pragma_query_value(None, "user_version", |r| r.get(0))?)
}

/// Applies every migration newer than the database's `user_version`.
pub fn migrate(conn: &mut Connection) -> AppResult<()> {
    let latest = latest_version();
    loop {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = schema_version(&tx)?;
        if current > latest {
            return Err(AppError::Database(format!(
                "Database lokal dibuat oleh versi Mira yang lebih baru (skema {current}, versi ini hanya mengenal sampai {latest}). Perbarui Mira dulu."
            )));
        }
        if current == latest {
            return Ok(());
        }
        tx.execute_batch(migrations::MIGRATIONS[current as usize])?;
        tx.pragma_update(None, "user_version", current + 1)?;
        tx.commit()?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table_names(conn: &Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .unwrap();
        stmt.query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    #[test]
    fn creates_file_with_wal_foreign_keys_and_tables() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = open(tmp.path()).unwrap();
        assert!(tmp.path().join(DB_FILE_NAME).is_file());

        let mode: String = conn
            .pragma_query_value(None, "journal_mode", |r| r.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        let fk: i64 = conn
            .pragma_query_value(None, "foreign_keys", |r| r.get(0))
            .unwrap();
        assert_eq!(fk, 1);

        let tables = table_names(&conn);
        for t in [
            "identity",
            "members",
            "organizations",
            "settings",
            "org_ops",
            "rejected_changes",
        ] {
            assert!(
                tables.iter().any(|n| n == t),
                "missing table {t}: {tables:?}"
            );
        }
        assert_eq!(schema_version(&conn).unwrap(), latest_version());
        assert!(latest_version() >= 1);
    }

    #[test]
    fn migrate_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let mut conn = open(tmp.path()).unwrap();
        migrate(&mut conn).unwrap();
        migrate(&mut conn).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), latest_version());
    }

    #[test]
    fn opening_twice_keeps_data() {
        let tmp = tempfile::tempdir().unwrap();
        {
            let conn = open(tmp.path()).unwrap();
            conn.execute(
                "INSERT INTO settings (key, value, updated_at) VALUES ('a', 'b', 'now')",
                [],
            )
            .unwrap();
        }
        let conn = open(tmp.path()).unwrap();
        let again = open(tmp.path()).unwrap();
        let v: String = conn
            .query_row("SELECT value FROM settings WHERE key = 'a'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(v, "b");
        assert_eq!(schema_version(&again).unwrap(), latest_version());
    }

    #[test]
    fn refuses_database_from_newer_build() {
        let tmp = tempfile::tempdir().unwrap();
        {
            let conn = open(tmp.path()).unwrap();
            conn.pragma_update(None, "user_version", latest_version() + 1)
                .unwrap();
        }
        let err = open(tmp.path()).unwrap_err();
        assert_eq!(err.code(), "database");
    }

    #[test]
    fn v1_database_upgrades_to_v2_without_losing_data() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(DB_FILE_NAME);
        let (org_id, founder, other) = ("0a".repeat(16), "1b".repeat(32), "2c".repeat(32));
        {
            let conn = Connection::open(&path).unwrap();
            configure(&conn).unwrap();
            conn.execute_batch(migrations::MIGRATIONS[0]).unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
            conn.execute(
                "INSERT INTO identity (id, public_key, display_name, created_at) VALUES (1, ?1, 'Sari', 't0')",
                [&founder],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO organizations (id, name, founder_public_key, created_at, genesis_signature)
                 VALUES (?1, 'CV Maju Jaya', ?2, '2026-11-01T00:00:00Z', ?3)",
                [&org_id, &founder, &"3d".repeat(64)],
            )
            .unwrap();
            for (pk, role, name) in [(&founder, "superadmin", "Sari"), (&other, "member", "Budi")] {
                conn.execute(
                    "INSERT INTO members (organization_id, public_key, display_name, role, added_at)
                     VALUES (?1, ?2, ?3, ?4, 't1')",
                    [&org_id, pk, &name.to_owned(), &role.to_owned()],
                )
                .unwrap();
            }
            conn.execute(
                "INSERT INTO settings (key, value, updated_at) VALUES ('theme.mode', 'dark', 't')",
                [],
            )
            .unwrap();
        }

        let conn = open(tmp.path()).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), latest_version());
        assert!(latest_version() >= 2);

        let name: String = conn
            .query_row(
                "SELECT name FROM organizations WHERE id = ?1",
                [&org_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(name, "CV Maju Jaya");
        let rows: Vec<(String, String, String, String, i64, String)> = conn
            .prepare(
                "SELECT public_key, display_name, role, status, is_superadmin, kind
                 FROM members ORDER BY display_name DESC",
            )
            .unwrap()
            .query_map([], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![
                (
                    founder.clone(),
                    "Sari".into(),
                    "superadmin".into(),
                    "active".into(),
                    1,
                    "member".into()
                ),
                (
                    other.clone(),
                    "Budi".into(),
                    "member".into(),
                    "active".into(),
                    0,
                    "member".into()
                ),
            ]
        );
        let theme: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'theme.mode'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(theme, "dark");
        let pk: String = conn
            .query_row("SELECT public_key FROM identity", [], |r| r.get(0))
            .unwrap();
        assert_eq!(pk, founder);

        let tables = table_names(&conn);
        for t in [
            "org_ops",
            "teams",
            "team_members",
            "invites",
            "guest_access",
            "channels",
            "peer_addresses",
            "manual_addresses",
            "peer_seen",
            "rejected_changes",
        ] {
            assert!(
                tables.iter().any(|n| n == t),
                "missing table {t}: {tables:?}"
            );
        }
    }

    #[test]
    fn members_require_existing_organization() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = open(tmp.path()).unwrap();
        let res = conn.execute(
            "INSERT INTO members (organization_id, public_key, display_name, role, added_at)
             VALUES (?1, ?2, 'A', 'member', 'now')",
            ["0".repeat(32), "a".repeat(64)],
        );
        assert!(res.is_err(), "foreign key must be enforced");
    }
}
