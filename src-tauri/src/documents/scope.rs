//! Who may see data in a team or project scope, for any laptop key (this
//! laptop for `access::scope_allows`, a rekan for what sync sends them).
//! Shared by documents and signing.
//!
//! Rules (plan `docs/plans/sinkron-dokumen-ttd.md`, bagian "Batas tim dan
//! proyek"):
//! - Only active members of the organization see anything.
//! - General library (no team, no project): every active non-guest member.
//!   Guests never.
//! - Team scope: superadmins and members of that live team (any team role).
//! - Project without team: every active non-guest member.
//! - Guests: only a project scope that [`GuestProjects`] allows for them.
//!
//! [`GuestProjects`] is a merge connection point: the board sync session owns
//! the real "projects a guest may open" function. Until it is merged,
//! [`InviteGuestProjects`] reads the projects named in the guest's invite
//! (`OrgState::guest_access`, from the signed membership log).

use rusqlite::Connection;

use crate::documents::store::DocScope;
use crate::error::AppResult;
use crate::permissions::{MemberKind, OrgState};

/// MERGE POINT (board sync): which projects a guest may open.
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

/// Temporary implementation: the projects listed in the guest's invite.
#[derive(Clone, Copy, Debug, Default)]
pub struct InviteGuestProjects;

impl GuestProjects for InviteGuestProjects {
    fn guest_may_access(
        &self,
        _conn: &Connection,
        state: &OrgState,
        guest: &str,
        team_id: Option<&str>,
        project_id: &str,
    ) -> AppResult<bool> {
        Ok(state.guest_access.iter().any(|g| {
            g.public_key == guest && g.project == project_id && team_id.is_none_or(|t| g.team == t)
        }))
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
    if !state.is_active(pk) {
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
    Ok(match scope.team_id.as_deref() {
        None => true,
        Some(team) => state.is_superadmin(pk) || state.team_role(team, pk).is_some(),
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
