//! This laptop's identity: an Ed25519 key pair plus a display name.
//!
//! The secret key lives only in the `KeyStore` (Windows Credential Manager,
//! F-ID-04). The database holds the public key, display name and creation time.
//! A missing or mismatching secret is reported as `key_mismatch`; a new key is
//! never generated silently because that would replace the person's identity.

mod keystore;

pub use keystore::{KEYRING_SERVICE, KeyStore, KeyringStore, MemoryKeyStore, SecretKey};

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use hex::FromHex;
use rand_core::OsRng;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use zeroize::Zeroizing;

use crate::clock;
use crate::error::{AppError, AppResult};

pub const DISPLAY_NAME_MAX_CHARS: usize = 50;

/// What the frontend sees about this laptop's identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityInfo {
    pub public_key: String,
    pub fingerprint: String,
    pub display_name: Option<String>,
    pub created_at: String,
}

/// The loaded identity. Holds the signing key in memory for the app's
/// lifetime; `ed25519_dalek::SigningKey` wipes itself on drop.
pub struct Identity {
    signing_key: SigningKey,
    public_key_hex: String,
    display_name: Option<String>,
    created_at: String,
}

impl std::fmt::Debug for Identity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Identity")
            .field("public_key", &self.public_key_hex)
            .field("display_name", &self.display_name)
            .finish_non_exhaustive()
    }
}

impl Identity {
    pub fn public_key_hex(&self) -> &str {
        &self.public_key_hex
    }

    pub fn verifying_key(&self) -> VerifyingKey {
        self.signing_key.verifying_key()
    }

    pub fn display_name(&self) -> Option<&str> {
        self.display_name.as_deref()
    }

    pub fn sign(&self, message: &[u8]) -> Signature {
        self.signing_key.sign(message)
    }

    /// Copy of the secret key for the network's TLS certificate (Tahap 1).
    /// Wiped when dropped.
    pub fn secret_bytes(&self) -> Zeroizing<[u8; 32]> {
        Zeroizing::new(self.signing_key.to_bytes())
    }

    pub fn info(&self) -> IdentityInfo {
        IdentityInfo {
            public_key: self.public_key_hex.clone(),
            fingerprint: fingerprint(&self.public_key_hex),
            display_name: self.display_name.clone(),
            created_at: self.created_at.clone(),
        }
    }
}

/// Keystore account for a public key. Including the key keeps several
/// instances (different `MIRA_DATA_DIR`) on one laptop from colliding.
pub fn keystore_account(public_key_hex: &str) -> String {
    format!("device-key-{public_key_hex}")
}

/// First 16 hex characters of the public key, uppercase, in groups of four.
pub fn fingerprint(public_key_hex: &str) -> String {
    let head: Vec<char> = public_key_hex
        .chars()
        .take(16)
        .map(|c| c.to_ascii_uppercase())
        .collect();
    head.chunks(4)
        .map(|group| group.iter().collect::<String>())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Loads this laptop's identity, creating the key pair on first run.
///
/// First run: generate the key, store the secret in the keystore first, then
/// write the public key to the database. If the database write fails the
/// secret is removed again so no orphan is left behind.
pub fn ensure_identity(conn: &Connection, keystore: &dyn KeyStore) -> AppResult<Identity> {
    let row = conn
        .query_row(
            "SELECT public_key, display_name, created_at FROM identity WHERE id = 1",
            [],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?;

    match row {
        Some((public_key_hex, display_name, created_at)) => {
            let account = keystore_account(&public_key_hex);
            let secret = keystore.get(&account)?.ok_or_else(|| {
                AppError::KeyMismatch(format!(
                    "Kunci laptop ini tidak ditemukan di Windows Credential Manager (entri {account}). \
                     Data Mira ada, tapi tanpa kunci itu Mira tidak bisa bertindak atas nama identitas ini. \
                     Mira tidak membuat kunci baru otomatis supaya identitas Anda tidak berganti. \
                     Pulihkan kunci dari cadangan, atau minta bantuan admin."
                ))
            })?;
            let signing_key = SigningKey::from_bytes(&secret);
            if hex::encode(signing_key.verifying_key().as_bytes()) != public_key_hex {
                return Err(AppError::KeyMismatch(
                    "Kunci laptop di Windows Credential Manager tidak cocok dengan identitas yang tersimpan di data Mira. \
                     Mira tidak membuat kunci baru otomatis supaya identitas Anda tidak berganti. \
                     Pulihkan kunci yang benar dari cadangan, atau minta bantuan admin."
                        .into(),
                ));
            }
            Ok(Identity {
                signing_key,
                public_key_hex,
                display_name,
                created_at,
            })
        }
        None => {
            let signing_key = SigningKey::generate(&mut OsRng);
            let public_key_hex = hex::encode(signing_key.verifying_key().as_bytes());
            let account = keystore_account(&public_key_hex);
            keystore.set(&account, &Zeroizing::new(signing_key.to_bytes()))?;

            let created_at = clock::now_rfc3339();
            if let Err(e) = conn.execute(
                "INSERT INTO identity (id, public_key, display_name, created_at) VALUES (1, ?1, NULL, ?2)",
                params![public_key_hex, created_at],
            ) {
                let _ = keystore.delete(&account);
                return Err(e.into());
            }
            Ok(Identity {
                signing_key,
                public_key_hex,
                display_name: None,
                created_at,
            })
        }
    }
}

/// Validates and stores the display name, also on this laptop's member rows.
pub fn save_display_name(
    conn: &mut Connection,
    identity: &mut Identity,
    name: &str,
) -> AppResult<IdentityInfo> {
    let name = validate_display_name(name)?;
    let tx = conn.transaction()?;
    let updated = tx.execute(
        "UPDATE identity SET display_name = ?1 WHERE id = 1 AND public_key = ?2",
        params![name, identity.public_key_hex],
    )?;
    if updated != 1 {
        return Err(AppError::Internal(
            "Identitas laptop tidak ditemukan di data Mira saat menyimpan nama.".into(),
        ));
    }
    tx.execute(
        "UPDATE members SET display_name = ?1 WHERE public_key = ?2",
        params![name, identity.public_key_hex],
    )?;
    tx.commit()?;
    identity.display_name = Some(name);
    Ok(identity.info())
}

/// Trimmed display name, 1 to 50 characters, no control characters.
pub fn validate_display_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::InvalidName("Nama tampilan wajib diisi.".into()));
    }
    if name.chars().count() > DISPLAY_NAME_MAX_CHARS {
        return Err(AppError::InvalidName(format!(
            "Nama tampilan paling banyak {DISPLAY_NAME_MAX_CHARS} karakter."
        )));
    }
    if has_forbidden_chars(name) {
        return Err(AppError::InvalidName(
            "Nama tampilan berisi karakter yang tidak diizinkan, misalnya baris baru atau tab."
                .into(),
        ));
    }
    Ok(name.to_owned())
}

/// Control characters, line separators, and invisible format characters
/// (bidi overrides and marks, zero-width characters, BOM). These can make a
/// name look empty or look like someone else's on other laptops.
pub(crate) fn has_forbidden_chars(s: &str) -> bool {
    s.chars().any(|c| {
        c.is_control()
            || matches!(
                c,
                '\u{00AD}'
                    | '\u{061C}'
                    | '\u{180E}'
                    | '\u{200B}'..='\u{200F}'
                    | '\u{2028}'..='\u{202E}'
                    | '\u{2060}'..='\u{206F}'
                    | '\u{FEFF}'
                    | '\u{FFF9}'..='\u{FFFB}'
            )
    })
}

/// Verifies an Ed25519 signature given as hex against a hex public key.
/// Returns false for malformed input.
pub fn verify_hex(public_key_hex: &str, message: &[u8], signature_hex: &str) -> bool {
    let Ok(pk) = <[u8; 32]>::from_hex(public_key_hex) else {
        return false;
    };
    let Ok(sig) = <[u8; 64]>::from_hex(signature_hex) else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(&pk) else {
        return false;
    };
    key.verify_strict(message, &Signature::from_bytes(&sig))
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn setup() -> (tempfile::TempDir, Connection) {
        let tmp = tempfile::tempdir().unwrap();
        let conn = db::open(tmp.path()).unwrap();
        (tmp, conn)
    }

    #[test]
    fn creates_key_once_and_reuses_it_after_reopen() {
        let (tmp, conn) = setup();
        let store = MemoryKeyStore::new();
        let first = ensure_identity(&conn, &store).unwrap();
        assert_eq!(first.public_key_hex().len(), 64);
        assert!(
            store
                .get(&keystore_account(first.public_key_hex()))
                .unwrap()
                .is_some(),
            "secret must be in the keystore"
        );
        drop(conn);

        let conn = db::open(tmp.path()).unwrap();
        let second = ensure_identity(&conn, &store).unwrap();
        assert_eq!(first.public_key_hex(), second.public_key_hex());
        assert_eq!(first.info().created_at, second.info().created_at);
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM identity", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1);
    }

    #[test]
    fn signatures_verify_with_public_key() {
        let (_tmp, conn) = setup();
        let identity = ensure_identity(&conn, &MemoryKeyStore::new()).unwrap();
        let sig = identity.sign(b"halo");
        assert!(
            identity
                .verifying_key()
                .verify_strict(b"halo", &sig)
                .is_ok()
        );
        let sig_hex = hex::encode(sig.to_bytes());
        assert!(verify_hex(identity.public_key_hex(), b"halo", &sig_hex));
        assert!(!verify_hex(identity.public_key_hex(), b"halo!", &sig_hex));
        assert!(!verify_hex("zz", b"halo", &sig_hex));
        assert!(!verify_hex(identity.public_key_hex(), b"halo", "00"));
    }

    #[test]
    fn missing_secret_is_key_mismatch_and_identity_is_kept() {
        let (_tmp, conn) = setup();
        let store = MemoryKeyStore::new();
        let identity = ensure_identity(&conn, &store).unwrap();
        let pk = identity.public_key_hex().to_owned();
        store.delete(&keystore_account(&pk)).unwrap();

        let err = ensure_identity(&conn, &store).unwrap_err();
        assert_eq!(err.code(), "key_mismatch");
        assert!(err.to_string().contains("Windows Credential Manager"));
        let stored: String = conn
            .query_row("SELECT public_key FROM identity", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stored, pk, "identity must not be replaced");
    }

    #[test]
    fn wrong_secret_is_key_mismatch() {
        let (_tmp, conn) = setup();
        let store = MemoryKeyStore::new();
        let identity = ensure_identity(&conn, &store).unwrap();
        store
            .set(&keystore_account(identity.public_key_hex()), &[1u8; 32])
            .unwrap();
        let err = ensure_identity(&conn, &store).unwrap_err();
        assert_eq!(err.code(), "key_mismatch");
    }

    #[test]
    fn info_has_fingerprint_and_no_name_yet() {
        let (_tmp, conn) = setup();
        let identity = ensure_identity(&conn, &MemoryKeyStore::new()).unwrap();
        let info = identity.info();
        assert_eq!(info.display_name, None);
        assert_eq!(info.fingerprint.len(), 19);
        assert_eq!(
            info.fingerprint.replace(' ', ""),
            info.public_key[..16].to_uppercase()
        );
    }

    #[test]
    fn fingerprint_format() {
        let pk = format!("a1b2c3d4e5f60718{}", "0".repeat(48));
        assert_eq!(fingerprint(&pk), "A1B2 C3D4 E5F6 0718");
    }

    #[test]
    fn saves_display_name_and_keeps_it_after_reopen() {
        let (tmp, mut conn) = setup();
        let store = MemoryKeyStore::new();
        let mut identity = ensure_identity(&conn, &store).unwrap();
        let info = save_display_name(&mut conn, &mut identity, "  Sari Wulandari ").unwrap();
        assert_eq!(info.display_name.as_deref(), Some("Sari Wulandari"));
        assert_eq!(identity.display_name(), Some("Sari Wulandari"));
        drop(conn);

        let conn = db::open(tmp.path()).unwrap();
        let reopened = ensure_identity(&conn, &store).unwrap();
        assert_eq!(reopened.display_name(), Some("Sari Wulandari"));
    }

    #[test]
    fn display_name_validation() {
        assert_eq!(validate_display_name(" Budi ").unwrap(), "Budi");
        assert_eq!(validate_display_name("A").unwrap(), "A");
        let fifty: String = "é".repeat(50);
        assert_eq!(
            validate_display_name(&fifty).unwrap(),
            fifty,
            "counts chars"
        );
        for bad in [
            "",
            "   ",
            &"x".repeat(51),
            "Bu\ndi",
            "Bu\u{0}di",
            "a\u{202E}b",
            "\u{200B}",
            "Bu\u{200D}di",
            "\u{FEFF}Budi",
            "Bu\u{2028}di",
        ] {
            let err = validate_display_name(bad).unwrap_err();
            assert_eq!(err.code(), "invalid_name", "{bad:?}");
        }
    }

    #[test]
    fn invalid_name_is_not_saved() {
        let (_tmp, mut conn) = setup();
        let mut identity = ensure_identity(&conn, &MemoryKeyStore::new()).unwrap();
        assert!(save_display_name(&mut conn, &mut identity, "   ").is_err());
        assert_eq!(identity.display_name(), None);
    }
}
