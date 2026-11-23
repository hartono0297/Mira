//! Who may do what with a document: the connection point for role-based
//! permissions (plan, bagian 3.3).
//!
//! Two rules, both must allow the action:
//! - The role of this laptop in the organization ([`role_allows`]): Tamu
//!   (guest) may view and export ("Simpan salinan") only; Anggota, Admin tim
//!   and Superadmin may do everything; no organization, or a laptop that was
//!   removed: nothing.
//! - The document's team and project ([`scope_allows`]), the same rules the
//!   sync applies to rekan (`documents::scope`): the general library for every
//!   non-guest member, a team scope for that team's members (a superadmin
//!   only after joining the team), a project scope only for a board project
//!   of exactly that team, guests only in the projects [`GuestProjects`]
//!   allows.

use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension, params};

use crate::documents::scope::{self, BoardGuestProjects, GuestProjects};
use crate::documents::store::DocScope;
use crate::error::{AppError, AppResult};
use crate::identity::Identity;
use crate::org::{self, Role};
use crate::permissions;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DocAction {
    View,
    Add,
    Edit,
    Restore,
    Resolve,
    Export,
}

/// What a role may do, ignoring team and project scoping.
pub fn role_allows(role: Role, action: DocAction) -> bool {
    match role {
        Role::Guest => matches!(action, DocAction::View | DocAction::Export),
        Role::Member | Role::TeamAdmin | Role::Superadmin => true,
    }
}

/// True for the actions that add a document or a version.
pub fn is_write(action: DocAction) -> bool {
    matches!(
        action,
        DocAction::Add | DocAction::Edit | DocAction::Restore | DocAction::Resolve
    )
}

/// Permission check used by the document commands and views. `check` returns
/// `AppError::Forbidden` with an Indonesian message when the action is not
/// allowed; other errors (database) are passed through.
pub trait DocumentAccess: Send + Sync {
    fn check(
        &self,
        conn: &Connection,
        me: &Identity,
        scope: &DocScope,
        action: DocAction,
    ) -> AppResult<()>;

    /// `check` as a yes/no for the view's `can` flags: `Forbidden` becomes
    /// `false`, any other error is returned.
    fn allows(
        &self,
        conn: &Connection,
        me: &Identity,
        scope: &DocScope,
        action: DocAction,
    ) -> AppResult<bool> {
        match self.check(conn, me, scope, action) {
            Ok(()) => Ok(true),
            Err(AppError::Forbidden(_)) => Ok(false),
            Err(e) => Err(e),
        }
    }
}

/// The real check: this laptop's role from `org::get_organization`, its
/// membership status from `members` (kept up to date by the membership fold),
/// and [`scope_allows`] with the board's guest projects
/// ([`BoardGuestProjects`]).
#[derive(Clone, Copy, Debug, Default)]
pub struct RoleAccess;

impl DocumentAccess for RoleAccess {
    fn check(
        &self,
        conn: &Connection,
        me: &Identity,
        scope: &DocScope,
        action: DocAction,
    ) -> AppResult<()> {
        check_role_and_scope(conn, me, scope, action, &BoardGuestProjects)
    }
}

/// [`RoleAccess`] with another source of guest projects. The runtime gives
/// the same [`GuestProjects`] to this check and to the document sync, so this
/// laptop and what it sends to rekan follow one rule.
#[derive(Clone)]
pub struct RoleAccessWith(pub Arc<dyn GuestProjects>);

impl DocumentAccess for RoleAccessWith {
    fn check(
        &self,
        conn: &Connection,
        me: &Identity,
        scope: &DocScope,
        action: DocAction,
    ) -> AppResult<()> {
        check_role_and_scope(conn, me, scope, action, self.0.as_ref())
    }
}

fn check_role_and_scope(
    conn: &Connection,
    me: &Identity,
    scope: &DocScope,
    action: DocAction,
    guests: &dyn GuestProjects,
) -> AppResult<()> {
    let Some(info) = org::get_organization(conn, me)? else {
        return Err(AppError::Forbidden(
            "Laptop ini belum tergabung dalam organisasi, jadi belum bisa memakai dokumen.".into(),
        ));
    };
    let status: Option<String> = conn
        .query_row(
            "SELECT status FROM members WHERE organization_id = ?1 AND public_key = ?2",
            params![info.id, me.public_key_hex()],
            |r| r.get(0),
        )
        .optional()?;
    match status.as_deref() {
        Some("active") => {}
        Some(_) => {
            return Err(AppError::Forbidden(
                "Laptop ini sudah dikeluarkan dari organisasi, jadi tidak bisa memakai dokumen lagi."
                    .into(),
            ));
        }
        None => {
            return Err(AppError::Forbidden(
                "Laptop ini belum menjadi anggota aktif organisasi, jadi belum bisa memakai dokumen."
                    .into(),
            ));
        }
    }
    if !role_allows(info.role, action) {
        return Err(AppError::Forbidden(
            "Tamu hanya bisa membuka dan menyimpan salinan dokumen.".into(),
        ));
    }
    if !scope_allows(conn, me, info.role, scope, action, guests)? {
        return Err(AppError::Forbidden(
            "Dokumen ini ada di tim atau proyek yang tidak bisa Anda buka.".into(),
        ));
    }
    Ok(())
}

/// Team and project scoping for this laptop: [`scope::may_write`] for the
/// write actions ([`is_write`]), [`scope::may_view`] for View and Export,
/// with the organization state from `permissions::load_state`.
///
/// The general library (no team, no project) needs no fold: every active
/// non-guest member may use it, guests never. `role` comes from the same
/// membership fold (the `members` table), so this equals `may_view` there and
/// keeps the document list fast.
pub fn scope_allows(
    conn: &Connection,
    me: &Identity,
    role: Role,
    scope: &DocScope,
    action: DocAction,
    guests: &dyn GuestProjects,
) -> AppResult<bool> {
    if scope.team_id.is_none() && scope.project_id.is_none() {
        return Ok(role != Role::Guest);
    }
    let Some(state) = permissions::load_state(conn)? else {
        return Ok(false);
    };
    let pk = me.public_key_hex();
    if is_write(action) {
        scope::may_write(conn, &state, guests, pk, scope)
    } else {
        scope::may_view(conn, &state, guests, pk, scope)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::documents::test_lab::Lab;
    use crate::identity::{self, MemoryKeyStore};

    const ALL: [DocAction; 6] = [
        DocAction::View,
        DocAction::Add,
        DocAction::Edit,
        DocAction::Restore,
        DocAction::Resolve,
        DocAction::Export,
    ];

    #[test]
    fn guest_may_only_view_and_export() {
        for action in ALL {
            let expected = matches!(action, DocAction::View | DocAction::Export);
            assert_eq!(role_allows(Role::Guest, action), expected, "{action:?}");
            assert_eq!(is_write(action), !expected, "{action:?}");
            for role in [Role::Member, Role::TeamAdmin, Role::Superadmin] {
                assert!(role_allows(role, action), "{role:?} {action:?}");
            }
        }
    }

    fn setup() -> (tempfile::TempDir, Connection, Identity) {
        let tmp = tempfile::tempdir().unwrap();
        let mut conn = db::open(tmp.path()).unwrap();
        let mut me = identity::ensure_identity(&conn, &MemoryKeyStore::new()).unwrap();
        identity::save_display_name(&mut conn, &mut me, "Sari").unwrap();
        (tmp, conn, me)
    }

    #[test]
    fn role_access_follows_this_laptops_role_and_status() {
        let (_tmp, mut conn, me) = setup();
        let scope = DocScope::default();

        let err = RoleAccess
            .check(&conn, &me, &scope, DocAction::View)
            .unwrap_err();
        assert_eq!(err.code(), "forbidden", "no organization");

        org::create_organization(&mut conn, &me, "CV Maju Jaya").unwrap();
        for action in ALL {
            RoleAccess.check(&conn, &me, &scope, action).unwrap();
        }

        // A guest sees nothing in the general library (plan, "Batas tim dan
        // proyek"); project scopes are covered with real guests below.
        conn.execute("UPDATE members SET role = 'guest'", [])
            .unwrap();
        for action in ALL {
            assert!(
                !RoleAccess.allows(&conn, &me, &scope, action).unwrap(),
                "{action:?}"
            );
        }
        let err = RoleAccess
            .check(&conn, &me, &scope, DocAction::Edit)
            .unwrap_err();
        assert_eq!(err.code(), "forbidden");
        assert!(!err.to_string().contains('\u{2014}'));

        conn.execute("UPDATE members SET role = 'member', status = 'removed'", [])
            .unwrap();
        for action in ALL {
            assert!(!RoleAccess.allows(&conn, &me, &scope, action).unwrap());
        }

        conn.execute("DELETE FROM members", []).unwrap();
        assert!(
            !RoleAccess
                .allows(&conn, &me, &scope, DocAction::View)
                .unwrap()
        );
    }

    #[test]
    fn scope_follows_teams_and_guest_projects() {
        let project = "ab".repeat(16);
        let mut lab = Lab::new(&["Sari", "Budi"]);
        let guest = lab.add_guest("Tamu", &[&project]);
        let outsider = lab.add_member_elsewhere("Dewi");
        lab.add_project(&project, Some(&lab.team));
        lab.add_project(&"cd".repeat(16), Some(&lab.team));
        let team = DocScope {
            team_id: Some(lab.team.clone()),
            project_id: None,
        };
        let allowed_project = DocScope {
            team_id: Some(lab.team.clone()),
            project_id: Some(project.clone()),
        };
        let other_project = DocScope {
            team_id: Some(lab.team.clone()),
            project_id: Some("cd".repeat(16)),
        };
        let general = DocScope::default();
        let allows = |who: usize, scope: &DocScope, action: DocAction| {
            lab.laptops[who].with(|c| RoleAccess.allows(&c.db, &c.identity, scope, action).unwrap())
        };
        for action in ALL {
            assert!(allows(0, &team, action), "superadmin {action:?}");
            assert!(allows(1, &team, action), "team member {action:?}");
            assert!(allows(1, &general, action), "general {action:?}");
            assert!(!allows(outsider, &team, action), "other team {action:?}");
            assert!(allows(outsider, &general, action), "other team, general {action:?}");
            assert!(!allows(guest, &general, action), "guest, general {action:?}");
            assert!(!allows(guest, &team, action), "guest, team {action:?}");
            assert!(!allows(guest, &other_project, action), "guest {action:?}");
            assert_eq!(
                allows(guest, &allowed_project, action),
                !is_write(action),
                "guest, own project {action:?}"
            );
        }
        let with = RoleAccessWith(Arc::new(BoardGuestProjects));
        lab.laptops[guest].with(|c| {
            assert!(
                with.allows(&c.db, &c.identity, &allowed_project, DocAction::View)
                    .unwrap()
            );
        });

        // A team project named without its team is not the general library.
        let without_team = DocScope {
            team_id: None,
            project_id: Some(project.clone()),
        };
        for who in [1, outsider, guest] {
            assert!(!allows(who, &without_team, DocAction::View), "laptop {who}");
        }

        // A superadmin outside the team sees the general library only
        // (F-ROLE-11).
        lab.leave_team(0);
        let allows = |who: usize, scope: &DocScope, action: DocAction| {
            lab.laptops[who].with(|c| RoleAccess.allows(&c.db, &c.identity, scope, action).unwrap())
        };
        for action in ALL {
            assert!(!allows(0, &team, action), "superadmin outside {action:?}");
            assert!(!allows(0, &allowed_project, action), "superadmin outside {action:?}");
            assert!(allows(0, &general, action), "superadmin, general {action:?}");
        }
    }
}
