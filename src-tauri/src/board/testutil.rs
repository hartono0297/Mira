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

/// Registers project `id` in the derived tables (`projects`,
/// `project_members`) as the v0.3 fold would after `project_create`, for
/// fixtures that write the membership tables directly. The creator is not
/// added on its own: list everyone who should be a member in `members`.
pub fn register_project(
    conn: &Connection,
    id: &str,
    team: Option<&str>,
    creator: &str,
    members: &[&str],
) {
    conn.execute(
        "INSERT OR REPLACE INTO projects (id, team_id, creator, registered_by, created_at)
         VALUES (?1, ?2, ?3, ?3, 't')",
        params![id, team, creator],
    )
    .unwrap();
    for pk in members {
        add_project_member(conn, id, pk);
    }
}

/// Adds `pk` to the registered project `id` (derived table only).
pub fn add_project_member(conn: &Connection, id: &str, pk: &str) {
    conn.execute(
        "INSERT OR IGNORE INTO project_members (project_id, public_key, added_at, added_by)
         VALUES (?1, ?2, 't', ?2)",
        params![id, pk],
    )
    .unwrap();
}

/// Registers board project `id` (already in `board_projects`) with the
/// people who could read it under the v0.2 rules, read from this laptop's
/// membership tables: the active non-guest members of its team (every
/// active non-guest member for a project without team). For tests written
/// for those rules.
pub fn register_v02(conn: &Connection, id: &str) {
    let (team, creator): (Option<String>, String) = conn
        .query_row(
            "SELECT team_id, created_by FROM board_projects WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    let readers: Vec<String> = match &team {
        Some(t) => conn
            .prepare(
                "SELECT m.public_key FROM members m JOIN team_members tm ON tm.public_key = m.public_key
                 WHERE tm.team_id = ?1 AND m.status = 'active' AND m.kind = 'member'",
            )
            .unwrap()
            .query_map([t], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap(),
        None => conn
            .prepare("SELECT public_key FROM members WHERE status = 'active' AND kind = 'member'")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap(),
    };
    let refs: Vec<&str> = readers.iter().map(String::as_str).collect();
    register_project(conn, id, team.as_deref(), &creator, &refs);
}

/// Copies the registration of project `id` from one laptop's derived
/// tables to another's when the other lacks it, as syncing the membership
/// log would.
pub fn copy_registration(from: &Connection, to: &Connection, id: &str) {
    let known: Option<i64> = to
        .query_row("SELECT 1 FROM projects WHERE id = ?1", [id], |r| r.get(0))
        .ok();
    if known.is_some() {
        return;
    }
    let row: Option<(Option<String>, String)> = from
        .query_row(
            "SELECT team_id, creator FROM projects WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    let Some((team, creator)) = row else {
        return;
    };
    let members: Vec<String> = from
        .prepare("SELECT public_key FROM project_members WHERE project_id = ?1")
        .unwrap()
        .query_map([id], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let refs: Vec<&str> = members.iter().map(String::as_str).collect();
    register_project(to, id, team.as_deref(), &creator, &refs);
}

/// Real membership log helpers (signed ops, folded by Tahap 1), generic over
/// the connection and identity so tests can use `Laptop` or a `MiraState`.
#[allow(dead_code)]
pub mod org_ops {
    use rusqlite::Connection;
    use time::OffsetDateTime;

    use crate::identity::Identity;
    use crate::permissions::{self as p, InviteRole, Validity};

    pub fn now() -> OffsetDateTime {
        OffsetDateTime::now_utc()
    }

    pub fn create_team(conn: &mut Connection, id: &Identity, name: &str) -> String {
        p::create_team(conn, id, name, now()).unwrap().id
    }

    /// `inviter` creates an invite (guest invites carry `projects`) and
    /// `joiner` (a laptop without organization) joins through it.
    pub fn join(
        inviter: (&mut Connection, &Identity),
        joiner: (&mut Connection, &Identity),
        team: &str,
        role: InviteRole,
        projects: Vec<String>,
    ) {
        let (iconn, iid) = inviter;
        let (jconn, jid) = joiner;
        let at = now();
        let code = p::create_invite(iconn, iid, team, role, projects, Validity::H24, at)
            .unwrap()
            .1;
        let code = p::normalize_code(&code).unwrap();
        let (org, invite) = p::join_lookup(iconn, code.tag(), at).unwrap();
        let proof = p::build_join_proof(&code, &org, &invite, jid).unwrap();
        let accepted = p::join_accept(iconn, iid, jid.public_key_hex(), &invite, &proof, at)
            .unwrap_or_else(|c| panic!("join_accept: {c:?}"));
        p::install_joined_org(jconn, jid, accepted.org, accepted.ops, &code, at).unwrap();
    }

    /// An existing member accepts another invite (for example a guest invite
    /// to a project of another team): same flow without a new organization.
    pub fn accept_more(
        inviter: (&mut Connection, &Identity),
        joiner_id: &Identity,
        team: &str,
        role: InviteRole,
        projects: Vec<String>,
    ) {
        let (iconn, iid) = inviter;
        let at = now();
        let code = p::create_invite(iconn, iid, team, role, projects, Validity::H24, at)
            .unwrap()
            .1;
        let code = p::normalize_code(&code).unwrap();
        let (org, invite) = p::join_lookup(iconn, code.tag(), at).unwrap();
        let proof = p::build_join_proof(&code, &org, &invite, joiner_id).unwrap();
        p::join_accept(iconn, iid, joiner_id.public_key_hex(), &invite, &proof, at)
            .unwrap_or_else(|c| panic!("join_accept: {c:?}"));
    }

    /// Sends `from` every op `to` may receive, as the Tahap 1 sync does.
    pub fn sync(from: &Connection, to: &mut Connection, to_pk: &str, from_pk: &str) -> usize {
        let state = p::load_state(from).unwrap().unwrap();
        let ids = p::op_ids_for(from, &state, to_pk).unwrap();
        let missing = p::missing_op_ids(to, &ids).unwrap();
        let ops = p::ops_for(from, &state, to_pk, &missing).unwrap();
        p::ingest(to, Some(from_pk), ops, now()).unwrap().new_ops
    }
}
