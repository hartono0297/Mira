//! The office organization, its members and roles (F-ROLE-08, F-ROLE-09).
//!
//! Tahap 0 holds at most one organization per laptop. The founder signs a
//! genesis record with the laptop key; this is the root of the trust chain
//! (F-ROLE-12) that Tahap 1 extends with signed admin appointments and invites.
//!
//! # Genesis bytes (version 1)
//!
//! The founder signs, with Ed25519, the UTF-8 bytes of these five fields joined
//! by a single `\n` (0x0A), with no trailing newline:
//!
//! ```text
//! mira-org-genesis-v1
//! <id: 32 lowercase hex chars>
//! <name: exactly as stored, already trimmed>
//! <founder public key: 64 lowercase hex chars>
//! <created_at: RFC 3339, exactly as stored>
//! ```
//!
//! Names cannot contain control characters, so `\n` cannot appear inside a
//! field and the encoding is unambiguous. The name is not Unicode-normalized:
//! verifiers must use the stored bytes as is. The signature is stored as 128
//! lowercase hex chars in `organizations.genesis_signature`.

use rand_core::{OsRng, RngCore};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Serialize;

use crate::clock;
use crate::error::{AppError, AppResult};
use crate::identity::{self, Identity};

pub const GENESIS_DOMAIN_V1: &str = "mira-org-genesis-v1";
pub const ORG_NAME_MIN_CHARS: usize = 2;
pub const ORG_NAME_MAX_CHARS: usize = 80;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Superadmin,
    TeamAdmin,
    Member,
    Guest,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Superadmin => "superadmin",
            Role::TeamAdmin => "team_admin",
            Role::Member => "member",
            Role::Guest => "guest",
        }
    }

    pub fn parse(s: &str) -> Option<Role> {
        match s {
            "superadmin" => Some(Role::Superadmin),
            "team_admin" => Some(Role::TeamAdmin),
            "member" => Some(Role::Member),
            "guest" => Some(Role::Guest),
            _ => None,
        }
    }
}

/// What the frontend sees: the organization plus this laptop's role in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgInfo {
    pub id: String,
    pub name: String,
    pub role: Role,
    pub created_at: String,
}

/// Full organization record as stored, including the genesis signature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Organization {
    pub id: String,
    pub name: String,
    pub founder_public_key: String,
    pub created_at: String,
    pub genesis_signature: String,
}

impl Organization {
    pub fn genesis_message(&self) -> Vec<u8> {
        genesis_message(
            &self.id,
            &self.name,
            &self.founder_public_key,
            &self.created_at,
        )
    }

    /// True when `genesis_signature` is a valid founder signature over the record.
    pub fn verify_genesis(&self) -> bool {
        identity::verify_hex(
            &self.founder_public_key,
            &self.genesis_message(),
            &self.genesis_signature,
        )
    }
}

/// Canonical genesis bytes; see the module docs for the format.
pub fn genesis_message(
    id: &str,
    name: &str,
    founder_public_key: &str,
    created_at: &str,
) -> Vec<u8> {
    [GENESIS_DOMAIN_V1, id, name, founder_public_key, created_at]
        .join("\n")
        .into_bytes()
}

/// Trimmed organization name, 2 to 80 characters, no control characters.
pub fn validate_org_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    let len = name.chars().count();
    if len < ORG_NAME_MIN_CHARS {
        return Err(AppError::InvalidName(format!(
            "Nama organisasi minimal {ORG_NAME_MIN_CHARS} karakter."
        )));
    }
    if len > ORG_NAME_MAX_CHARS {
        return Err(AppError::InvalidName(format!(
            "Nama organisasi paling banyak {ORG_NAME_MAX_CHARS} karakter."
        )));
    }
    if identity::has_forbidden_chars(name) {
        return Err(AppError::InvalidName(
            "Nama organisasi berisi karakter yang tidak diizinkan, misalnya baris baru atau tab."
                .into(),
        ));
    }
    Ok(name.to_owned())
}

/// Creates the organization with this laptop as founder and superadmin.
pub fn create_organization(
    conn: &mut Connection,
    identity: &Identity,
    name: &str,
) -> AppResult<OrgInfo> {
    let display_name = identity
        .display_name()
        .ok_or(AppError::NameRequired)?
        .to_owned();
    let name = validate_org_name(name)?;

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing: i64 = tx.query_row("SELECT count(*) FROM organizations", [], |r| r.get(0))?;
    if existing > 0 {
        return Err(AppError::OrgExists);
    }

    let mut id_bytes = [0u8; 16];
    OsRng.fill_bytes(&mut id_bytes);
    let org = Organization {
        id: hex::encode(id_bytes),
        founder_public_key: identity.public_key_hex().to_owned(),
        created_at: clock::now_rfc3339(),
        genesis_signature: String::new(),
        name,
    };
    let org = Organization {
        genesis_signature: hex::encode(identity.sign(&org.genesis_message()).to_bytes()),
        ..org
    };

    tx.execute(
        "INSERT INTO organizations (id, name, founder_public_key, created_at, genesis_signature)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            org.id,
            org.name,
            org.founder_public_key,
            org.created_at,
            org.genesis_signature
        ],
    )?;
    tx.execute(
        "INSERT INTO members (organization_id, public_key, display_name, role, added_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            org.id,
            org.founder_public_key,
            display_name,
            Role::Superadmin.as_str(),
            org.created_at
        ],
    )?;
    tx.commit()?;

    Ok(OrgInfo {
        id: org.id,
        name: org.name,
        role: Role::Superadmin,
        created_at: org.created_at,
    })
}

/// The stored organization record, if any.
pub fn load_organization(conn: &Connection) -> AppResult<Option<Organization>> {
    Ok(conn
        .query_row(
            "SELECT id, name, founder_public_key, created_at, genesis_signature
             FROM organizations ORDER BY created_at LIMIT 1",
            [],
            |r| {
                Ok(Organization {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    founder_public_key: r.get(2)?,
                    created_at: r.get(3)?,
                    genesis_signature: r.get(4)?,
                })
            },
        )
        .optional()?)
}

/// The organization with this laptop's role, if any.
pub fn get_organization(conn: &Connection, identity: &Identity) -> AppResult<Option<OrgInfo>> {
    let Some(org) = load_organization(conn)? else {
        return Ok(None);
    };
    let role: Option<String> = conn
        .query_row(
            "SELECT role FROM members WHERE organization_id = ?1 AND public_key = ?2",
            params![org.id, identity.public_key_hex()],
            |r| r.get(0),
        )
        .optional()?;
    let role = role.as_deref().and_then(Role::parse).ok_or_else(|| {
        AppError::Internal(
            "Data organisasi di laptop ini tidak lengkap: peran laptop ini tidak ditemukan.".into(),
        )
    })?;
    Ok(Some(OrgInfo {
        id: org.id,
        name: org.name,
        role,
        created_at: org.created_at,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::identity::{self, MemoryKeyStore};

    struct Fixture {
        _tmp: tempfile::TempDir,
        conn: Connection,
        identity: Identity,
    }

    fn fixture(with_name: bool) -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let mut conn = db::open(tmp.path()).unwrap();
        let mut identity = identity::ensure_identity(&conn, &MemoryKeyStore::new()).unwrap();
        if with_name {
            identity::save_display_name(&mut conn, &mut identity, "Sari").unwrap();
        }
        Fixture {
            _tmp: tmp,
            conn,
            identity,
        }
    }

    #[test]
    fn founder_becomes_superadmin() {
        let mut f = fixture(true);
        let info = create_organization(&mut f.conn, &f.identity, "  CV Maju Jaya ").unwrap();
        assert_eq!(info.name, "CV Maju Jaya");
        assert_eq!(info.role, Role::Superadmin);
        assert_eq!(info.id.len(), 32);
        assert!(info.id.chars().all(|c| c.is_ascii_hexdigit()));

        let (role, name): (String, String) = f
            .conn
            .query_row(
                "SELECT role, display_name FROM members WHERE organization_id = ?1 AND public_key = ?2",
                [&info.id, f.identity.public_key_hex()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(role, "superadmin");
        assert_eq!(name, "Sari");

        assert_eq!(get_organization(&f.conn, &f.identity).unwrap(), Some(info));
    }

    #[test]
    fn genesis_signature_is_valid_and_breaks_when_tampered() {
        let mut f = fixture(true);
        create_organization(&mut f.conn, &f.identity, "CV Maju Jaya").unwrap();
        let org = load_organization(&f.conn).unwrap().unwrap();
        assert_eq!(org.founder_public_key, f.identity.public_key_hex());
        assert!(org.verify_genesis());

        let renamed = Organization {
            name: "CV Maju Jaya!".into(),
            ..org.clone()
        };
        assert!(!renamed.verify_genesis());
        let other_founder = Organization {
            founder_public_key: "ab".repeat(32),
            ..org.clone()
        };
        assert!(!other_founder.verify_genesis());
        let garbage = Organization {
            genesis_signature: "zz".into(),
            ..org
        };
        assert!(!garbage.verify_genesis());
    }

    #[test]
    fn genesis_message_format() {
        let msg = genesis_message("00ff", "Kantor A", "abcd", "2026-11-22T00:00:00Z");
        assert_eq!(
            msg,
            b"mira-org-genesis-v1\n00ff\nKantor A\nabcd\n2026-11-22T00:00:00Z".to_vec()
        );
    }

    #[test]
    fn cannot_create_twice() {
        let mut f = fixture(true);
        create_organization(&mut f.conn, &f.identity, "Satu").unwrap();
        let err = create_organization(&mut f.conn, &f.identity, "Dua").unwrap_err();
        assert_eq!(err.code(), "org_exists");
        assert_eq!(load_organization(&f.conn).unwrap().unwrap().name, "Satu");
    }

    #[test]
    fn requires_display_name() {
        let mut f = fixture(false);
        let err = create_organization(&mut f.conn, &f.identity, "CV Maju Jaya").unwrap_err();
        assert_eq!(err.code(), "name_required");
        assert_eq!(load_organization(&f.conn).unwrap(), None);
        assert_eq!(get_organization(&f.conn, &f.identity).unwrap(), None);
    }

    #[test]
    fn org_name_validation() {
        assert_eq!(validate_org_name(" AB ").unwrap(), "AB");
        assert!(validate_org_name(&"ü".repeat(80)).is_ok());
        for bad in ["", " A ", &"x".repeat(81), "Kantor\nA", "Kantor\tA"] {
            assert_eq!(
                validate_org_name(bad).unwrap_err().code(),
                "invalid_name",
                "{bad:?}"
            );
        }
        let mut f = fixture(true);
        let err = create_organization(&mut f.conn, &f.identity, "A").unwrap_err();
        assert_eq!(err.code(), "invalid_name");
    }

    #[test]
    fn roles_serialize_as_contract_strings() {
        for (role, s) in [
            (Role::Superadmin, "superadmin"),
            (Role::TeamAdmin, "team_admin"),
            (Role::Member, "member"),
            (Role::Guest, "guest"),
        ] {
            assert_eq!(serde_json::to_value(role).unwrap(), s);
            assert_eq!(Role::parse(s), Some(role));
        }
    }
}
