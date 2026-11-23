//! Who may see data in a team or project scope, for any laptop key (this
//! laptop for `access::scope_allows`, a rekan for what sync sends them).
//! Shared by documents and signing.
//!
//! Rules (plan `docs/plans/sinkron-dokumen-ttd.md`, bagian "Batas tim dan
//! proyek"), the same as the board's (`board::access`):
//! - Only active members of the organization see anything.
//! - General library (no team, no project): every active non-guest member.
//!   Guests never.
//! - Team scope: members of that live team (any team role). A superadmin
//!   only after joining the team (F-ROLE-11).
//! - Project scope: the project must exist on this laptop's board, be
//!   syncable (`board::store::is_syncable`) and belong to exactly the team the
//!   scope names ([`board_team`]). Then, since v0.3, the board's project
//!   rule (`board::access::may_access_project`): explicit project members
//!   only, from any department; a superadmin only as a member.
//! - Guests: only a project scope that [`GuestProjects`] allows for them.
//!   [`BoardGuestProjects`] asks the board (`board::access::may_access_project`):
//!   the invite's team must be the project's team, and a project without team
//!   has no guests.

use rusqlite::{Connection, OptionalExtension, params};

use crate::board;
use crate::chat::audience::{BoardAudience, Ctx};
use crate::chat::fetch::{self, FetchKind};
use crate::documents::store::DocScope;
use crate::error::AppResult;
use crate::permissions::{MemberKind, OrgState};

/// Which projects a guest may open. The app uses [`BoardGuestProjects`].
pub trait GuestProjects: Send + Sync {
    /// True when `guest` (an active guest key) may open project `project_id`
    /// (of team `team_id`, when the scope names one).
    fn guest_may_access(
        &self,
        conn: &Connection,
        state: &OrgState,
        guest: &str,
        team_id: Option<&str>,
        project_id: &str,
    ) -> AppResult<bool>;
}

/// The team of board project `project_id`: `None` when the project is not on
/// this laptop's board or is not syncable (its id is not bound to its creator
/// and team), `Some(None)` for a project without team.
pub fn board_team(conn: &Connection, project_id: &str) -> AppResult<Option<Option<String>>> {
    let team: Option<Option<String>> = conn
        .query_row(
            "SELECT team_id FROM board_projects WHERE id = ?1",
            params![project_id],
            |r| r.get(0),
        )
        .optional()?;
    match team {
        Some(team) if board::store::is_syncable(conn, project_id)? => Ok(Some(team)),
        _ => Ok(None),
    }
}

/// True when `scope` names a project on the board with exactly the scope's
/// team, or names no project.
fn project_matches(conn: &Connection, scope: &DocScope) -> AppResult<bool> {
    match scope.project_id.as_deref() {
        Some(project) => Ok(board_team(conn, project)? == Some(scope.team_id.clone())),
        None => Ok(true),
    }
}

/// Chat's claim on file `hash`, judged for `pk`. `None` when chat did not
/// put the file into the shared blob store (no `chat_blobs` row, or the file
/// was there before chat touched it: `preexisting = 1`, so it belongs to
/// documents or signing). Otherwise `Some(true)` when `pk` may have it
/// through chat (a plain file held for a conversation `pk` is in now) and
/// `Some(false)` when not (a cipher file, or no such conversation).
///
/// Documents and signing refuse a file chat withholds from `pk` and never
/// serve it on `pk`'s behalf, so a rekan who learns the hash of a chat
/// attachment cannot fetch it through a crafted document version or signing
/// request.
pub fn chat_allows(conn: &Connection, hash: &str, pk: &str) -> AppResult<Option<bool>> {
    let kind: Option<String> = conn
        .query_row(
            "SELECT kind FROM chat_blobs WHERE hash = ?1 AND preexisting = 0",
            params![hash],
            |r| r.get(0),
        )
        .optional()?;
    let Some(kind) = kind else {
        return Ok(None);
    };
    if kind != FetchKind::Plain.as_str() {
        return Ok(Some(false));
    }
    let me: String = conn
        .query_row("SELECT public_key FROM identity WHERE id = 1", [], |r| {
            r.get(0)
        })
        .optional()?
        .unwrap_or_default();
    let projects = BoardAudience;
    let Some(ctx) = Ctx::load(conn, &me, &projects)? else {
        return Ok(Some(false));
    };
    for held in fetch::blob_convs(conn, hash)? {
        if let Some(info) = ctx.conv(&held.conv)?
            && !info.deleted
            && ctx.in_audience(&info, pk)?
        {
            return Ok(Some(true));
        }
    }
    Ok(Some(false))
}

/// The board's guest rule: the guest may read the project on the board
/// (`board::access::may_access_project`) and the project's board team is the
/// team the scope names. False for unknown or unsyncable projects.
#[derive(Clone, Copy, Debug, Default)]
pub struct BoardGuestProjects;

impl GuestProjects for BoardGuestProjects {
    fn guest_may_access(
        &self,
        conn: &Connection,
        _state: &OrgState,
        guest: &str,
        team_id: Option<&str>,
        project_id: &str,
    ) -> AppResult<bool> {
        match board_team(conn, project_id)? {
            Some(team) if team.as_deref() == team_id => {
                board::access::may_access_project(conn, guest, project_id)
            }
            _ => Ok(false),
        }
    }
}

fn is_guest(state: &OrgState, pk: &str) -> bool {
    state
        .member(pk)
        .is_some_and(|m| m.kind == MemberKind::Guest)
}

/// True when `pk` may see data in `scope`.
pub fn may_view(
    conn: &Connection,
    state: &OrgState,
    guests: &dyn GuestProjects,
    pk: &str,
    scope: &DocScope,
) -> AppResult<bool> {
    if !state.is_active(pk) || !project_matches(conn, scope)? {
        return Ok(false);
    }
    if is_guest(state, pk) {
        return match scope.project_id.as_deref() {
            Some(project) => {
                guests.guest_may_access(conn, state, pk, scope.team_id.as_deref(), project)
            }
            None => Ok(false),
        };
    }
    // v0.3: project data is for the project's members only, whatever
    // department they are in (`board::access`).
    if let Some(project) = scope.project_id.as_deref() {
        return board::access::may_access_project(conn, pk, project);
    }
    Ok(match scope.team_id.as_deref() {
        None => true,
        Some(team) => state.team_role(team, pk).is_some(),
    })
}

/// True when `pk` may add or change data in `scope`: may see it and is not a
/// guest.
pub fn may_write(
    conn: &Connection,
    state: &OrgState,
    guests: &dyn GuestProjects,
    pk: &str,
    scope: &DocScope,
) -> AppResult<bool> {
    Ok(!is_guest(state, pk) && may_view(conn, state, guests, pk, scope)?)
}

/// Tests only: board project `id` of `team` (none for a project without
/// team), created by `creator`, marked syncable (`bound = 1`) so the scope
/// rules accept it without a real project document. Since v0.3 nobody reads
/// it until it is registered in the membership log
/// ([`register_test_project`], or `test_lab::Lab::register_project`).
#[cfg(test)]
pub fn insert_test_project(conn: &Connection, id: &str, team: Option<&str>, creator: &str) {
    conn.execute(
        "INSERT INTO board_projects
             (id, code, doc_code, name, team_id, created_by, created_at, doc, updated_at, bound)
         VALUES (?1, ?1, ?1, ?1, ?2, ?3, '2026-01-01T00:00:00Z', x'', '2026-01-01T00:00:00Z', 1)",
        params![id, team, creator],
    )
    .unwrap();
}

/// Tests only: registers a project made by `identity` in the membership log
/// (`project_create` with `members`) and adds its board row. Returns the id.
#[cfg(test)]
pub fn register_test_project(
    conn: &mut Connection,
    identity: &crate::identity::Identity,
    team: Option<&str>,
    members: &[String],
) -> String {
    use crate::permissions::{self, Body, Scope};
    let me = identity.public_key_hex().to_owned();
    let nonce = crate::board::doc::random_id();
    let id = permissions::project_id_for(&me, team, &nonce);
    let mut members: Vec<String> = members.iter().filter(|m| m.as_str() != me).cloned().collect();
    members.sort();
    members.dedup();
    let body = Body::ProjectCreate {
        project: id.clone(),
        team: team.map(str::to_owned),
        creator: me.clone(),
        nonce,
        members,
    };
    permissions::author_op(conn, identity, Scope::Org, body, time::OffsetDateTime::now_utc())
        .unwrap();
    insert_test_project(conn, &id, team, &me);
    id
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::documents::test_lab::Lab;
    use crate::permissions;

    fn scope(team: Option<&str>, project: Option<&str>) -> DocScope {
        DocScope {
            team_id: team.map(str::to_owned),
            project_id: project.map(str::to_owned),
        }
    }

    #[test]
    fn project_scopes_follow_the_board() {
        let unknown = "12".repeat(16);
        let loose = "34".repeat(16);
        let mut lab = Lab::new(&["Sari", "Budi"]);
        let outsider = lab.add_member_elsewhere("Dewi");
        let other_team = lab.laptops[1]
            .org_state()
            .teams
            .values()
            .find(|t| t.id != lab.team)
            .unwrap()
            .id
            .clone();
        let team = lab.team.clone();
        // v0.3: explicit members. p (team project) is Budi's, q (no team)
        // has Dewi from the other department, r belongs to the other team.
        let p = lab.register_project(1, Some(&team), &[]);
        let q = lab.register_project(0, None, &[outsider]);
        let r = lab.register_project(0, Some(&other_team), &[]);
        // Invited to p, q, r and an unknown project, all under "Tim Proyek".
        let guest = lab.add_guest("Tamu", &[&p, &q, &r, &unknown]);
        lab.add_project(&p, Some(&team));
        lab.add_project(&q, None);
        lab.add_project(&r, Some(&other_team));
        lab.add_project(&loose, None);
        let s = lab.laptops[1].org_state();
        let (sari, budi, dewi, tamu) = (lab.pk(0), lab.pk(1), lab.pk(outsider), lab.pk(guest));
        lab.laptops[1].with(|c| {
            let db = &c.db;
            // A project id the board does not bind to its creator.
            db.execute("UPDATE board_projects SET bound = 0 WHERE id = ?1", [&loose])
                .unwrap();
            let view = |pk: &str, sc: DocScope| may_view(db, &s, &BoardGuestProjects, pk, &sc).unwrap();
            let t = Some(team.as_str());

            assert_eq!(board_team(db, &p).unwrap(), Some(Some(team.clone())));
            assert_eq!(board_team(db, &q).unwrap(), Some(None));
            assert_eq!(board_team(db, &unknown).unwrap(), None);
            assert_eq!(board_team(db, &loose).unwrap(), None);

            assert!(view(&budi, scope(t, Some(&p))));
            assert!(!view(&sari, scope(t, Some(&p))), "same department, not a member");
            assert!(!view(&budi, scope(None, Some(&q))), "project without team, not a member");
            assert!(!view(&budi, scope(None, Some(&p))), "team project without team");
            assert!(!view(&dewi, scope(None, Some(&p))), "team project without team");
            assert!(view(&dewi, scope(None, Some(&q))));
            assert!(!view(&budi, scope(t, Some(&q))), "wrong team");
            assert!(!view(&budi, scope(t, Some(&unknown))));
            assert!(!view(&budi, scope(None, Some(&unknown))));
            assert!(!view(&budi, scope(None, Some(&loose))), "not syncable");

            assert!(view(&tamu, scope(t, Some(&p))));
            assert!(!view(&tamu, scope(None, Some(&p))), "guest, no team named");
            assert!(!view(&tamu, scope(None, Some(&q))), "guest, project without team");
            assert!(!view(&tamu, scope(t, Some(&q))), "guest, project without team");
            assert!(!view(&tamu, scope(t, Some(&r))), "guest, project of another team");
            assert!(!view(&tamu, scope(Some(&other_team), Some(&r))), "invite of another team");
            assert!(!view(&tamu, scope(t, Some(&unknown))), "guest, unknown project");

            let g = BoardGuestProjects;
            assert!(g.guest_may_access(db, &s, &tamu, t, &p).unwrap());
            assert!(!g.guest_may_access(db, &s, &tamu, None, &p).unwrap());
            assert!(!g.guest_may_access(db, &s, &tamu, t, &unknown).unwrap());
        });
    }

    /// Team data follows the department, project data the project's
    /// members: a superadmin sees neither from outside (F-ROLE-11).
    #[test]
    fn superadmin_sees_team_data_only_inside_the_team() {
        let mut lab = Lab::new(&["Sari", "Budi"]);
        let team = lab.team.clone();
        let p = lab.register_project(1, Some(&team), &[]);
        lab.add_project(&p, Some(&team));
        let sari = lab.pk(0);
        let check = |lab: &Lab, in_team: bool, in_project: bool| {
            let s = lab.laptops[1].org_state();
            assert!(s.is_superadmin(&sari));
            lab.laptops[1].with(|c| {
                let g = BoardGuestProjects;
                let team_scope = scope(Some(&team), None);
                let project = scope(Some(&team), Some(&p));
                assert_eq!(may_view(&c.db, &s, &g, &sari, &team_scope).unwrap(), in_team);
                assert_eq!(may_view(&c.db, &s, &g, &sari, &project).unwrap(), in_project);
                assert_eq!(may_write(&c.db, &s, &g, &sari, &project).unwrap(), in_project);
                assert!(may_view(&c.db, &s, &g, &sari, &DocScope::default()).unwrap());
            });
        };
        check(&lab, true, false);
        // Adding herself to the project is recorded in the log.
        lab.add_to_project(0, &p, 0);
        check(&lab, true, true);
        lab.leave_team(0);
        check(&lab, false, true);
        lab.remove_from_project(0, &p, 0);
        check(&lab, false, false);
        // Joining the department again restores the department's data only.
        lab.laptops[0].with(|c| {
            let me = c.identity.public_key_hex().to_owned();
            permissions::add_team_member(&mut c.db, &c.identity, &team, &me, time::OffsetDateTime::now_utc())
                .unwrap();
        });
        lab.sync_membership();
        check(&lab, true, false);
    }
}
