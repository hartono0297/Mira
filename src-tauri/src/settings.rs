//! Local per-laptop settings (key-value), e.g. `theme.mode`, `theme.name`.

use rusqlite::{Connection, OptionalExtension, params};

use crate::clock;
use crate::error::{AppError, AppResult};

pub const KEY_MAX_LEN: usize = 64;
pub const VALUE_MAX_BYTES: usize = 4096;

pub fn get(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    validate_key(key)?;
    Ok(conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
            r.get(0)
        })
        .optional()?)
}

pub fn set(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    validate_key(key)?;
    if value.len() > VALUE_MAX_BYTES {
        return Err(AppError::InvalidSetting(format!(
            "Nilai pengaturan terlalu panjang (maksimal {VALUE_MAX_BYTES} byte)."
        )));
    }
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value, clock::now_rfc3339()],
    )?;
    Ok(())
}

/// Keys match `[a-z0-9._-]{1,64}`.
pub fn validate_key(key: &str) -> AppResult<()> {
    let ok = !key.is_empty()
        && key.len() <= KEY_MAX_LEN
        && key
            .bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-'));
    if ok {
        Ok(())
    } else {
        Err(AppError::InvalidSetting(format!(
            "Nama pengaturan tidak valid. Gunakan 1 sampai {KEY_MAX_LEN} karakter huruf kecil, angka, titik, garis bawah, atau tanda hubung."
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    #[test]
    fn set_get_and_overwrite() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = db::open(tmp.path()).unwrap();
        assert_eq!(get(&conn, "theme.mode").unwrap(), None);
        set(&conn, "theme.mode", "dark").unwrap();
        assert_eq!(get(&conn, "theme.mode").unwrap().as_deref(), Some("dark"));
        set(&conn, "theme.mode", "system").unwrap();
        assert_eq!(get(&conn, "theme.mode").unwrap().as_deref(), Some("system"));
        set(&conn, "x", "").unwrap();
        assert_eq!(get(&conn, "x").unwrap().as_deref(), Some(""));
    }

    #[test]
    fn rejects_bad_keys_and_large_values() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = db::open(tmp.path()).unwrap();
        for bad in ["", "Theme", "theme mode", "téma", &"a".repeat(65)] {
            assert_eq!(
                set(&conn, bad, "v").unwrap_err().code(),
                "invalid_setting",
                "{bad:?}"
            );
            assert_eq!(get(&conn, bad).unwrap_err().code(), "invalid_setting");
        }
        assert!(validate_key(&"a".repeat(64)).is_ok());
        assert!(validate_key("a-b_c.9").is_ok());
        assert!(set(&conn, "big", &"x".repeat(VALUE_MAX_BYTES)).is_ok());
        let err = set(&conn, "big", &"x".repeat(VALUE_MAX_BYTES + 1)).unwrap_err();
        assert_eq!(err.code(), "invalid_setting");
    }
}
