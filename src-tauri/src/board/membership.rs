//! Registering board projects made before v0.3 in the membership log
//! (docs/plans/v0.3-kontrak.md, "Proyek lama").
//!
//! Since v0.3 a project is visible only to the members listed in the log
//! (`project_create`, `project_member_add`). Projects created with v0.2 have
//! no such op, so nobody may receive them until one laptop registers them:
//!
//! - the creator's laptop, when the creator is still an active member;
//! - otherwise the laptop of a superadmin or of an admin of the project's
//!   department.
//!
//! The initial members are the v0.2 readers: everyone in the project's
//! department (every active non-guest member for a project without
//! department). Guests keep their invite access. If two laptops register
//! the same project at once, the fold keeps the first `project_create` and
//! rejects the other (`id_in_use`): the result is the same everywhere.

use rusqlite::Connection;
use time::OffsetDateTime;

use super::store;
use crate::error::AppResult;
use crate::identity::Identity;
use crate::permissions::{self, OrgState, TeamRole};

/// Board projects on this laptop that are bound to their creator
/// (syncable) and not registered in the log yet.
fn unregistered(
    conn: &Connection,
    state: &OrgState,
) -> AppResult<Vec<(String, Option<String>, String)>> {
    let rows: Vec<(String, Option<String>, String)> = conn
        .prepare("SELECT id, team_id, created_by FROM board_projects ORDER BY id")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_, _>>()?;
    let mut out = Vec::new();
    for row in rows {
        if !state.projects.contains_key(&row.0) && store::is_syncable(conn, &row.0)? {
            out.push(row);
        }
    }
    Ok(out)
}

/// The people who could read the project under the v0.2 rules.
fn v02_readers(state: &OrgState, team: Option<&str>) -> Vec<String> {
    state
        .members
        .keys()
        .filter(|pk| state.is_active_non_guest(pk))
        .filter(|pk| team.is_none_or(|t| state.team_role(t, pk).is_some()))
        .cloned()
        .collect()
}

/// Registers every unregistered project this laptop is the right one to
/// register. Returns how many were registered. Failures of one project are
/// skipped (for example a project whose department was deleted).
pub fn register_legacy_projects(
    conn: &mut Connection,
    identity: &Identity,
    now: OffsetDateTime,
) -> AppResult<usize> {
    let Some(state) = permissions::load_state(conn)? else {
        return Ok(0);
    };
    let me = identity.public_key_hex();
    if !state.is_active_non_guest(me) {
        return Ok(0);
    }
    let mut done = 0;
    for (id, team, creator) in unregistered(conn, &state)? {
        let mine = creator == me;
        let creator_gone = !state.is_active_non_guest(&creator);
        let manager = state.is_superadmin(me)
            || team
                .as_deref()
                .is_some_and(|t| state.team_role(t, me) == Some(TeamRole::Admin));
        if !(mine || (creator_gone && manager)) {
            continue;
        }
        let doc = store::load_doc(conn, &id, &[0; 32])?;
        let Some(nonce) = doc.project_nonce() else {
            continue;
        };
        let members = v02_readers(&state, team.as_deref());
        let tx = conn.transaction()?;
        let result = permissions::register_project_for_in(
            &tx,
            identity,
            &id,
            team.as_deref(),
            &creator,
            &nonce,
            members,
            now,
        );
        match result {
            Ok(()) => {
                tx.commit()?;
                done += 1;
            }
            Err(e) => {
                eprintln!(
                    "Mira: proyek lama {id} belum bisa didaftarkan [{}]: {e}",
                    e.code()
                );
            }
        }
    }
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::testutil::Laptop;
    use crate::permissions::Body;

    #[test]
    fn creator_registers_v02_project_with_department_members() {
        let mut l = Laptop::founder("Sari");
        let team = crate::board::testutil::org_ops::create_team(&mut l.conn, &l.id, "Desain");
        let me = l.pk();
        permissions::move_member(&mut l.conn, &l.id, &me, &team, OffsetDateTime::now_utc())
            .unwrap();
        // A v0.2 project: created on the board, never registered.
        let p = store::create_project(&mut l.conn, &l.id, "Gudang", "GD", Some(&team)).unwrap();
        let id = p.value.id.clone();
        l.conn
            .execute("DELETE FROM org_ops WHERE kind = 'project_create'", [])
            .unwrap();
        permissions::recompute(&mut l.conn).unwrap();
        assert!(
            !permissions::load_state(&l.conn)
                .unwrap()
                .unwrap()
                .projects
                .contains_key(&id)
        );

        let n = register_legacy_projects(&mut l.conn, &l.id, OffsetDateTime::now_utc()).unwrap();
        assert_eq!(n, 1);
        let state = permissions::load_state(&l.conn).unwrap().unwrap();
        let reg = &state.projects[&id];
        assert_eq!(reg.creator, l.pk());
        assert_eq!(reg.team.as_deref(), Some(team.as_str()));
        assert!(reg.members.contains_key(&l.pk()));
        // Running again changes nothing.
        let n = register_legacy_projects(&mut l.conn, &l.id, OffsetDateTime::now_utc()).unwrap();
        assert_eq!(n, 0);
        let ops = permissions::load_ops(&l.conn).unwrap();
        let creates = ops
            .iter()
            .filter(|o| matches!(o.payload.body, Body::ProjectCreate { .. }))
            .count();
        assert_eq!(creates, 1);
    }
}
