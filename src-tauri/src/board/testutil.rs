//! Test fixtures: laptops with their own database and key, and organization
//! rows written directly (the board only reads the derived member tables).

use rusqlite::{Connection, params};

use crate::db;
use crate::identity::{self, Identity, MemoryKeyStore};
use crate::org;

pub struct Laptop {
    _tmp: tempfile::TempDir,
    pub conn: Connection,
    pub id: Identity,
}

impl Laptop {
    /// Identity with a display name, no organization.
    pub fn bare(name: &str) -> Laptop {
        let tmp = tempfile::tempdir().unwrap();
        let mut conn = db::open(tmp.path()).unwrap();
        let mut id = identity::ensure_identity(&conn, &MemoryKeyStore::new()).unwrap();
        identity::save_display_name(&mut conn, &mut id, name).unwrap();
        Laptop {
            _tmp: tmp,
            conn,
            id,
        }
    }

    /// Founder and superadmin of a new organization.
    pub fn founder(name: &str) -> Laptop {
        let mut l = Laptop::bare(name);
        org::create_organization(&mut l.conn, &l.id, "CV Maju Jaya").unwrap();
        l
    }

    /// A member laptop in `founder`'s organization; both laptops know each other.
    pub fn joined(founder: &Laptop, name: &str) -> Laptop {
        let l = Laptop::bare(name);
        let o = org::load_organization(&founder.conn).unwrap().unwrap();
        l.conn
            .execute(
                "INSERT INTO organizations (id, name, founder_public_key, created_at, genesis_signature)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![o.id, o.name, o.founder_public_key, o.created_at, o.genesis_signature],
            )
            .unwrap();
        let founder_name = founder.id.display_name().unwrap_or("Pendiri").to_owned();
        insert_member(
            &l.conn,
            &founder.pk(),
            &founder_name,
            "superadmin",
            "active",
            "member",
        );
        insert_member(&l.conn, &l.pk(), name, "member", "active", "member");
        insert_member(&founder.conn, &l.pk(), name, "member", "active", "member");
        l
    }

    pub fn pk(&self) -> String {
        self.id.public_key_hex().to_owned()
    }
}

fn org_id(conn: &Connection) -> String {
    conn.query_row("SELECT id FROM organizations", [], |r| r.get(0))
        .unwrap()
}

fn insert_member(conn: &Connection, pk: &str, name: &str, role: &str, status: &str, kind: &str) {
    conn.execute(
        "INSERT OR REPLACE INTO members
           (organization_id, public_key, display_name, role, added_at, status, is_superadmin, kind)
         VALUES (?1, ?2, ?3, ?4, 't', ?5, ?6, ?7)",
        params![
            org_id(conn),
            pk,
            name,
            role,
            status,
            i64::from(role == "superadmin"),
            kind
        ],
    )
    .unwrap();
}

/// `what` is `member`, `guest`, `removed` or `superadmin`.
pub fn add_member(conn: &Connection, pk: &str, name: &str, what: &str) {
    match what {
        "guest" => insert_member(conn, pk, name, "guest", "active", "guest"),
        "removed" => insert_member(conn, pk, name, "member", "removed", "member"),
        "superadmin" => insert_member(conn, pk, name, "superadmin", "active", "member"),
        _ => insert_member(conn, pk, name, "member", "active", "member"),
    }
}

/// Creates a team with `(public key, "admin" | "member")` rows; returns its id.
pub fn add_team(conn: &Connection, name: &str, members: &[(&str, &str)]) -> String {
    let id = crate::board::doc::random_id();
    conn.execute(
        "INSERT INTO teams (id, name, created_at, created_by) VALUES (?1, ?2, 't', 'x')",
        params![id, name],
    )
    .unwrap();
    for (pk, role) in members {
        conn.execute(
            "INSERT INTO team_members (team_id, public_key, role, added_at) VALUES (?1, ?2, ?3, 't')",
            params![id, pk, role],
        )
        .unwrap();
    }
    id
}
