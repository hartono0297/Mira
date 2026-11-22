//! Who may do what with a document: the connection point for role-based
//! permissions (plan, bagian 3.3).
//!
//! Today the check is the role of this laptop in the organization:
//! - Tamu (guest): view and export ("Simpan salinan") only.
//! - Anggota, Admin tim, Superadmin: everything.
//! - No organization, or a laptop that was removed: nothing.
//!
//! Team and guest-project scoping (a member only sees the documents of their
//! teams, a guest only the projects in `guest_access`) needs projects from
//! Tahap 3. The hook for it is [`scope_allows`]; it allows everything until
//! documents carry a `team_id` / `project_id`.

use rusqlite::{Connection, OptionalExtension, params};

use crate::documents::store::DocScope;
use crate::error::{AppError, AppResult};
use crate::identity::Identity;
use crate::org::{self, Role};

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

/// The real check: this laptop's role from `org::get_organization`, plus its
/// membership status from `members` (kept up to date by the membership fold).
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
        let Some(info) = org::get_organization(conn, me)? else {
            return Err(AppError::Forbidden(
                "Laptop ini belum tergabung dalam organisasi, jadi belum bisa memakai dokumen."
                    .into(),
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
        if !scope_allows(conn, me, info.role, scope, action)? {
            return Err(AppError::Forbidden(
                "Dokumen ini ada di tim atau proyek yang tidak bisa Anda buka.".into(),
            ));
        }
        Ok(())
    }
}

/// TODO(Tahap 3 projects): team and guest-project scoping hook.
///
/// When documents get a `team_id` / `project_id`, this should load
/// `permissions::load_state` (an `OrgState`) and allow:
/// - superadmin: every scope;
/// - team admin and member: documents whose `team_id` is one of their teams
///   (`OrgState::teams[..].members`), plus the general library (`team_id` NULL);
/// - guest: only documents whose (`team_id`, `project_id`) is in
///   `OrgState::guest_access` for their key, and never the general library.
///
/// Until then every document lives in the general library (both ids NULL)
/// and the role check in [`role_allows`] is the whole rule.
pub fn scope_allows(
    _conn: &Connection,
    _me: &Identity,
    _role: Role,
    _scope: &DocScope,
    _action: DocAction,
) -> AppResult<bool> {
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
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

        conn.execute("UPDATE members SET role = 'guest'", [])
            .unwrap();
        for action in ALL {
            let allowed = RoleAccess.allows(&conn, &me, &scope, action).unwrap();
            assert_eq!(
                allowed,
                matches!(action, DocAction::View | DocAction::Export),
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
}
