//! Projects a superadmin is not a member of (v0.3, contract section 2.2).
//!
//! A superadmin does not see a project's board until added (F-ROLE-11), but
//! may add themselves; that step is a `project_member_add` op in the
//! membership log, visible to everyone. To offer it, the board lists the
//! registered projects the superadmin is outside of. The log carries the
//! department, creator and members, not the project's name: the name is
//! shown only when this laptop still holds the board (for example from
//! v0.2, when superadmins read every project of their team).

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use tauri::State;

use crate::error::AppResult;
use crate::identity;
use crate::permissions::{self, OrgState};
use crate::state::MiraState;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutsideProject {
    pub id: String,
    /// From the local board copy, when this laptop has one.
    pub code: Option<String>,
    pub name: Option<String>,
    pub team_id: Option<String>,
    pub team_name: Option<String>,
    pub creator_name: String,
    pub member_count: u32,
    pub created_at: String,
}

fn local_name(conn: &Connection, id: &str) -> AppResult<Option<(String, String)>> {
    Ok(conn
        .query_row(
            "SELECT code, name FROM board_projects WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?)
}

fn creator_name(state: &OrgState, pk: &str) -> String {
    state
        .members
        .get(pk)
        .and_then(|m| m.display_name.clone())
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| {
            let short = identity::fingerprint(pk);
            format!("Laptop {}", short.split(' ').next().unwrap_or_default())
        })
}

/// Registered projects `me` may join as superadmin (`can_join_self`),
/// newest first. Empty for everyone else.
pub fn outside_projects(
    conn: &Connection,
    state: &OrgState,
    me: &str,
) -> AppResult<Vec<OutsideProject>> {
    let mut out = Vec::new();
    for p in state.projects.values() {
        let view = permissions::project_members(state, &p.id, me);
        if !view.can_join_self {
            continue;
        }
        let local = local_name(conn, &p.id)?;
        out.push(OutsideProject {
            id: p.id.clone(),
            code: local.as_ref().map(|(c, _)| c.clone()),
            name: local.map(|(_, n)| n),
            team_id: p.team.clone(),
            team_name: p
                .team
                .as_deref()
                .and_then(|t| state.teams.get(t))
                .map(|t| t.name.clone()),
            creator_name: creator_name(state, &p.creator),
            member_count: u32::try_from(view.members.len()).unwrap_or(u32::MAX),
            created_at: p.created_at.clone(),
        });
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(a.id.cmp(&b.id)));
    Ok(out)
}

#[tauri::command]
pub async fn board_outside_projects(state: State<'_, MiraState>) -> AppResult<Vec<OutsideProject>> {
    state.with_core(|c| {
        let Some(s) = permissions::load_state(&c.db)? else {
            return Ok(Vec::new());
        };
        outside_projects(&c.db, &s, c.identity.public_key_hex())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::store;
    use crate::board::testutil::{Laptop, org_ops};
    use crate::permissions::InviteRole;

    #[test]
    fn lists_projects_the_superadmin_may_join() {
        let mut f = Laptop::founder("Rina");
        let team = org_ops::create_team(&mut f.conn, &f.id, "Desain");
        let mut b = Laptop::bare("Budi");
        let (fpk, bpk) = (f.pk(), b.pk());
        org_ops::join(
            (&mut f.conn, &f.id),
            (&mut b.conn, &b.id),
            &team,
            InviteRole::TeamAdmin,
            Vec::new(),
        );
        org_ops::sync(&f.conn, &mut b.conn, &bpk, &fpk);
        // Budi (admin of Desain) creates a project without the superadmin.
        let row = store::create_project_with_members(
            &mut b.conn,
            &b.id,
            "Gudang",
            "GD",
            Some(&team),
            &[],
        )
        .unwrap()
        .value;
        org_ops::sync(&b.conn, &mut f.conn, &fpk, &bpk);

        let state = permissions::load_state(&f.conn).unwrap().unwrap();
        let list = outside_projects(&f.conn, &state, &fpk).unwrap();
        assert_eq!(list.len(), 1, "{list:?}");
        let p = &list[0];
        assert_eq!(p.id, row.id);
        assert_eq!(p.name, None, "the name is not in the log");
        assert_eq!(p.team_name.as_deref(), Some("Desain"));
        assert_eq!(p.creator_name, "Budi");
        assert_eq!(p.member_count, 1);
        let json = serde_json::to_value(p).unwrap();
        assert_eq!(json["memberCount"], 1);
        assert_eq!(json["creatorName"], "Budi");

        let bstate = permissions::load_state(&b.conn).unwrap().unwrap();
        assert!(
            outside_projects(&b.conn, &bstate, &bpk).unwrap().is_empty(),
            "only superadmins may add themselves"
        );

        // After joining, the project is no longer outside.
        permissions::add_project_member(&mut f.conn, &f.id, &row.id, &fpk, org_ops::now()).unwrap();
        let state = permissions::load_state(&f.conn).unwrap().unwrap();
        assert!(outside_projects(&f.conn, &state, &fpk).unwrap().is_empty());
    }
}
