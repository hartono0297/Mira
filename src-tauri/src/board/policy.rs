//! Who may do what on the board.
//!
//! `BoardPolicy` is the seam for permission checks. `LocalRolePolicy` applies
//! the rules of `access.rs` (the PRD permission table, guests per project,
//! superadmins only in teams they joined) to the membership tables the Tahap 1
//! fold keeps. For changes from other laptops, `check_at` judges the author
//! against the moment the change was made (`access::RightsHistory`), for
//! everyone who lost a right; `sync` adds the condition that guards against
//! backdating (sync.rs, "Rights lost later").
//!
//! Every action first requires an active member; a removed laptop gets
//! `AppError::Removed`. Guests may only read.

use rusqlite::{Connection, OptionalExtension};

use super::access::{ProjectRef, Rights, RightsHistory};
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BoardAction {
    CreateProject {
        team_id: Option<String>,
    },
    ManageProject {
        project_id: String,
    },
    CreateTask {
        project_id: String,
    },
    EditTask {
        project_id: String,
        task_id: String,
    },
    MoveTask {
        project_id: String,
        task_id: String,
    },
    Comment {
        project_id: String,
        task_id: String,
    },
    DeleteTask {
        project_id: String,
        task_id: String,
        created_by: String,
    },
    /// Any change from another laptop: the author must be able to write in
    /// the project. Deletes and project changes inside it are checked
    /// separately by `sync` with `DeleteTask` and `ManageProject`.
    RemoteChange {
        project_id: String,
    },
    /// Seeing the project at all.
    ViewProject {
        project_id: String,
    },
}

pub trait BoardPolicy {
    /// `Ok(())` when `actor` (64-hex public key) may do `action` now.
    fn check(&self, conn: &Connection, actor: &str, action: &BoardAction) -> AppResult<()>;

    /// Like `check`, for a change made at `at` (unix seconds, the author's
    /// clock): also allowed when the author had the right and lost it after
    /// `at`. The caller must not trust `at` alone (it can be backdated). The
    /// default ignores time.
    fn check_at(
        &self,
        conn: &Connection,
        actor: &str,
        action: &BoardAction,
        at: i64,
    ) -> AppResult<()> {
        let _ = at;
        self.check(conn, actor, action)
    }

    fn allows(&self, conn: &Connection, actor: &str, action: &BoardAction) -> bool {
        self.check(conn, actor, action).is_ok()
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct LocalRolePolicy;

fn forbidden(msg: &str) -> AppError {
    AppError::Forbidden(msg.to_owned())
}

/// A stored project as the rules need it.
struct Owner {
    id: String,
    team_id: Option<String>,
    created_by: String,
}

impl Owner {
    fn as_ref(&self) -> ProjectRef<'_> {
        ProjectRef {
            id: &self.id,
            team_id: self.team_id.as_deref(),
            created_by: &self.created_by,
        }
    }
}

fn project_owner(conn: &Connection, project_id: &str) -> AppResult<Owner> {
    conn.query_row(
        "SELECT team_id, created_by FROM board_projects WHERE id = ?1",
        [project_id],
        |r| {
            Ok(Owner {
                id: project_id.to_owned(),
                team_id: r.get(0)?,
                created_by: r.get(1)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("Proyek tidak ditemukan.".into()))
}

fn project_of(action: &BoardAction) -> Option<&str> {
    match action {
        BoardAction::CreateProject { .. } => None,
        BoardAction::ManageProject { project_id }
        | BoardAction::CreateTask { project_id }
        | BoardAction::EditTask { project_id, .. }
        | BoardAction::MoveTask { project_id, .. }
        | BoardAction::Comment { project_id, .. }
        | BoardAction::DeleteTask { project_id, .. }
        | BoardAction::RemoteChange { project_id }
        | BoardAction::ViewProject { project_id } => Some(project_id),
    }
}

/// The rule itself: `Ok` or the message explaining the refusal.
fn decide(
    rights: &Rights,
    actor: &str,
    action: &BoardAction,
    owner: Option<&Owner>,
) -> AppResult<()> {
    if let BoardAction::CreateProject { team_id } = action {
        if rights.can_create_project(actor, team_id.as_deref()) {
            return Ok(());
        }
        if team_id.is_some() && rights.is_superadmin(actor) {
            return Err(forbidden(
                "Superadmin perlu masuk ke tim ini dulu sebelum membuat proyek untuk tim itu. Tambahkan diri Anda ke tim di halaman Organisasi.",
            ));
        }
        return Err(forbidden(
            "Hanya superadmin atau admin tim yang bisa membuat proyek. Minta admin tim membuatkannya.",
        ));
    }
    let Some(owner) = owner else {
        return Err(AppError::NotFound("Proyek tidak ditemukan.".into()));
    };
    let p = owner.as_ref();
    if !rights.can_read(actor, p) {
        return Err(forbidden(
            "Anda bukan anggota tim proyek ini. Minta admin tim menambahkan Anda.",
        ));
    }
    match action {
        BoardAction::ViewProject { .. } => Ok(()),
        _ if rights.is_guest(actor) => Err(forbidden(
            "Tamu hanya bisa melihat board dan komentar. Minta admin tim kalau perlu mengubah task.",
        )),
        BoardAction::CreateTask { .. }
        | BoardAction::EditTask { .. }
        | BoardAction::MoveTask { .. }
        | BoardAction::Comment { .. }
        | BoardAction::RemoteChange { .. } => {
            if rights.can_write(actor, p) {
                Ok(())
            } else {
                Err(forbidden("Anda tidak bisa mengubah board proyek ini."))
            }
        }
        BoardAction::ManageProject { .. } => {
            if rights.can_manage(actor, p) {
                Ok(())
            } else {
                Err(forbidden(
                    "Hanya superadmin, admin tim proyek ini, atau pembuat proyek yang bisa mengatur proyek ini.",
                ))
            }
        }
        BoardAction::DeleteTask { created_by, .. } => {
            if rights.can_delete_task(actor, p, created_by) {
                Ok(())
            } else {
                Err(forbidden(
                    "Task ini hanya bisa dihapus oleh pembuatnya, admin tim proyek, atau superadmin.",
                ))
            }
        }
        BoardAction::CreateProject { .. } => Ok(()),
    }
}

/// Checks that need no project: an organization exists and the actor is an
/// active member.
fn require_member(conn: &Connection, rights: &Rights, actor: &str) -> AppResult<()> {
    if !rights.has_org() {
        return Err(forbidden(
            "Board baru bisa dipakai setelah laptop ini membuat atau bergabung dengan organisasi.",
        ));
    }
    if rights.is_active(actor) {
        return Ok(());
    }
    let removed: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM members WHERE public_key = ?1 AND status = 'removed' LIMIT 1",
            [actor],
            |r| r.get(0),
        )
        .optional()?;
    if removed.is_some() {
        Err(AppError::Removed)
    } else {
        Err(forbidden(
            "Laptop ini belum menjadi anggota organisasi, jadi belum bisa mengubah board.",
        ))
    }
}

fn owner_for(conn: &Connection, action: &BoardAction) -> AppResult<Option<Owner>> {
    project_of(action)
        .map(|id| project_owner(conn, id))
        .transpose()
}

impl BoardPolicy for LocalRolePolicy {
    fn check(&self, conn: &Connection, actor: &str, action: &BoardAction) -> AppResult<()> {
        let rights = Rights::load(conn)?;
        require_member(conn, &rights, actor)?;
        let owner = owner_for(conn, action)?;
        decide(&rights, actor, action, owner.as_ref())
    }

    fn check_at(
        &self,
        conn: &Connection,
        actor: &str,
        action: &BoardAction,
        at: i64,
    ) -> AppResult<()> {
        BatchPolicy::new().check_at(conn, actor, action, at)
    }
}

/// `LocalRolePolicy` with the membership history loaded at most once, for
/// one batch of changes from other laptops (loading the history replays the
/// whole membership log). Make a new one per batch: it does not notice
/// membership changes after the first `check_at` that needed the history.
#[derive(Debug, Default)]
pub struct BatchPolicy {
    history: std::cell::OnceCell<RightsHistory>,
}

impl BatchPolicy {
    pub fn new() -> Self {
        Self::default()
    }
}

impl BoardPolicy for BatchPolicy {
    fn check(&self, conn: &Connection, actor: &str, action: &BoardAction) -> AppResult<()> {
        LocalRolePolicy.check(conn, actor, action)
    }

    fn check_at(
        &self,
        conn: &Connection,
        actor: &str,
        action: &BoardAction,
        at: i64,
    ) -> AppResult<()> {
        let Err(err) = self.check(conn, actor, action) else {
            return Ok(());
        };
        if matches!(err, AppError::NotFound(_)) {
            return Err(err);
        }
        // Anyone who lost the right (moved out of a team, demoted, removed
        // from the organization) is judged at the time of the change. That
        // time is the author's own clock, so this alone would allow
        // backdating: `sync` also requires a colleague who still has the
        // right to have built on the change (sync.rs, "Rights lost later").
        let owner = owner_for(conn, action)?;
        if self.history.get().is_none() {
            let loaded = RightsHistory::load(conn)?;
            let _ = self.history.set(loaded);
        }
        let Some(history) = self.history.get() else {
            return Err(err);
        };
        let allowed = history.allowed_at(at, |r| {
            r.is_active(actor) && decide(r, actor, action, owner.as_ref()).is_ok()
        });
        if allowed { Ok(()) } else { Err(err) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use crate::board::testutil::{Laptop, add_member, add_team};

    fn pk(n: u8) -> String {
        format!("{n:02x}").repeat(32)
    }

    fn create(team: Option<&str>) -> BoardAction {
        BoardAction::CreateProject {
            team_id: team.map(str::to_owned),
        }
    }

    fn insert_project(l: &Laptop, id: &str, team: Option<&str>, creator: &str) {
        l.conn
            .execute(
                "INSERT INTO board_projects (id, code, doc_code, name, team_id, created_by, created_at, doc, updated_at)
                 VALUES (?1, ?2, ?2, 'P', ?3, ?4, 't', x'00', 't')",
                params![id, format!("P{}", &id[..2].to_uppercase()), team, creator],
            )
            .unwrap();
    }

    #[test]
    fn no_organization_is_forbidden_with_clear_message() {
        let l = Laptop::bare("Sari");
        let err = LocalRolePolicy
            .check(&l.conn, &l.pk(), &create(None))
            .unwrap_err();
        assert_eq!(err.code(), "forbidden");
        assert!(err.to_string().contains("organisasi"));
    }

    #[test]
    fn create_project_rules() {
        let l = Laptop::founder("Sari");
        let p = LocalRolePolicy;
        let (admin, member, guest, removed, stranger) = (pk(1), pk(2), pk(3), pk(4), pk(5));
        add_member(&l.conn, &admin, "Admin", "member");
        add_member(&l.conn, &member, "Budi", "member");
        add_member(&l.conn, &guest, "Tamu", "guest");
        add_member(&l.conn, &removed, "Lama", "removed");
        let team = add_team(&l.conn, "Desain", &[(&admin, "admin"), (&member, "member")]);
        let other_team = add_team(&l.conn, "Lain", &[]);

        assert!(p.allows(&l.conn, &l.pk(), &create(None)), "superadmin");
        let err = p
            .check(&l.conn, &l.pk(), &create(Some(&other_team)))
            .unwrap_err();
        assert!(
            err.to_string().contains("masuk ke tim"),
            "superadmin outside the team: {err}"
        );
        assert!(p.allows(&l.conn, &admin, &create(Some(&team))));
        assert!(
            p.allows(&l.conn, &admin, &create(None)),
            "admin of some team"
        );
        assert!(!p.allows(&l.conn, &admin, &create(Some(&other_team))));
        assert_eq!(
            p.check(&l.conn, &member, &create(None)).unwrap_err().code(),
            "forbidden"
        );
        assert_eq!(
            p.check(&l.conn, &guest, &create(None)).unwrap_err().code(),
            "forbidden"
        );
        assert_eq!(
            p.check(&l.conn, &removed, &create(None))
                .unwrap_err()
                .code(),
            "removed"
        );
        assert_eq!(
            p.check(&l.conn, &stranger, &create(None))
                .unwrap_err()
                .code(),
            "forbidden"
        );
    }

    #[test]
    fn task_rules() {
        let l = Laptop::founder("Sari");
        let p = LocalRolePolicy;
        let (admin, member, other, guest, removed) = (pk(1), pk(2), pk(3), pk(4), pk(5));
        add_member(&l.conn, &admin, "Admin", "member");
        add_member(&l.conn, &member, "Budi", "member");
        add_member(&l.conn, &other, "Citra", "member");
        add_member(&l.conn, &guest, "Tamu", "guest");
        add_member(&l.conn, &removed, "Lama", "removed");
        let team = add_team(
            &l.conn,
            "Desain",
            &[(&admin, "admin"), (&member, "member"), (&other, "member")],
        );
        let proj = "ab".repeat(16);
        insert_project(&l, &proj, Some(&team), &l.pk());
        let pid = proj.clone();
        let edits = [
            BoardAction::CreateTask {
                project_id: pid.clone(),
            },
            BoardAction::EditTask {
                project_id: pid.clone(),
                task_id: "t".into(),
            },
            BoardAction::MoveTask {
                project_id: pid.clone(),
                task_id: "t".into(),
            },
            BoardAction::Comment {
                project_id: pid.clone(),
                task_id: "t".into(),
            },
            BoardAction::RemoteChange {
                project_id: pid.clone(),
            },
        ];
        for a in &edits {
            assert!(p.allows(&l.conn, &member, a), "{a:?}");
            assert_eq!(p.check(&l.conn, &guest, a).unwrap_err().code(), "forbidden");
            assert_eq!(p.check(&l.conn, &removed, a).unwrap_err().code(), "removed");
        }

        let delete = BoardAction::DeleteTask {
            project_id: pid.clone(),
            task_id: "t".into(),
            created_by: member.clone(),
        };
        assert!(p.allows(&l.conn, &member, &delete), "creator");
        assert!(p.allows(&l.conn, &admin, &delete), "team admin");
        assert!(
            !p.allows(&l.conn, &l.pk(), &delete),
            "superadmin outside the team"
        );
        assert_eq!(
            p.check(&l.conn, &other, &delete).unwrap_err().code(),
            "forbidden"
        );

        let manage = BoardAction::ManageProject {
            project_id: pid.clone(),
        };
        assert!(!p.allows(&l.conn, &l.pk(), &manage));
        assert!(p.allows(&l.conn, &admin, &manage));
        assert!(!p.allows(&l.conn, &member, &manage));
        // A superadmin who joins the team may manage and delete there.
        l.conn
            .execute(
                "INSERT INTO team_members (team_id, public_key, role, added_at) VALUES (?1, ?2, 'member', 't')",
                params![team, l.pk()],
            )
            .unwrap();
        assert!(p.allows(&l.conn, &l.pk(), &manage));
        assert!(p.allows(&l.conn, &l.pk(), &delete), "superadmin in the team");
        // Members outside the team see nothing.
        let outsider = pk(6);
        add_member(&l.conn, &outsider, "Eko", "member");
        assert_eq!(
            p.check(&l.conn, &outsider, &edits[0]).unwrap_err().code(),
            "forbidden"
        );

        // Project without team: only creator and superadmin may manage/delete others' tasks.
        let solo = "cd".repeat(16);
        insert_project(&l, &solo, None, &member);
        let manage_solo = BoardAction::ManageProject {
            project_id: solo.clone(),
        };
        assert!(p.allows(&l.conn, &member, &manage_solo));
        assert!(!p.allows(&l.conn, &admin, &manage_solo));
        let delete_solo = BoardAction::DeleteTask {
            project_id: solo,
            task_id: "t".into(),
            created_by: other.clone(),
        };
        assert!(!p.allows(&l.conn, &admin, &delete_solo));
    }

    #[test]
    fn check_at_uses_the_history_for_active_members_too() {
        use crate::board::testutil::org_ops;
        use crate::permissions::{self as p, InviteRole};

        let mut l = Laptop::founder("Sari");
        let mut budi = Laptop::bare("Budi");
        let desain = org_ops::create_team(&mut l.conn, &l.id, "Desain");
        let lain = org_ops::create_team(&mut l.conn, &l.id, "Lain");
        org_ops::join(
            (&mut l.conn, &l.id),
            (&mut budi.conn, &budi.id),
            &desain,
            InviteRole::Member,
            vec![],
        );
        let proj = "ab".repeat(16);
        insert_project(&l, &proj, Some(&desain), &l.pk());
        let write = BoardAction::RemoteChange {
            project_id: proj.clone(),
        };
        let before = org_ops::now().unix_timestamp() - 60;
        // Budi moves to another team but stays in the organization.
        p::remove_team_member(&mut l.conn, &l.id, &desain, &budi.pk(), org_ops::now()).unwrap();
        p::add_team_member(&mut l.conn, &l.id, &lain, &budi.pk(), org_ops::now()).unwrap();
        let after = org_ops::now().unix_timestamp() + 60;

        assert!(!LocalRolePolicy.allows(&l.conn, &budi.pk(), &write));
        assert!(
            BatchPolicy::new()
                .check_at(&l.conn, &budi.pk(), &write, before)
                .is_ok(),
            "made while in the team"
        );
        assert!(
            BatchPolicy::new()
                .check_at(&l.conn, &budi.pk(), &write, after)
                .is_err(),
            "made after leaving the team"
        );
        // Someone who never had the right gets nothing from the history.
        let stranger = pk(9);
        add_member(&l.conn, &stranger, "Eko", "member");
        assert!(
            BatchPolicy::new()
                .check_at(&l.conn, &stranger, &write, before)
                .is_err()
        );
    }

    #[test]
    fn removed_self_gets_removed_error() {
        let l = Laptop::founder("Sari");
        l.conn
            .execute(
                "UPDATE members SET status = 'removed' WHERE public_key = ?1",
                [l.pk()],
            )
            .unwrap();
        let err = LocalRolePolicy
            .check(
                &l.conn,
                &l.pk(),
                &BoardAction::CreateTask {
                    project_id: "x".into(),
                },
            )
            .unwrap_err();
        assert_eq!(err, AppError::Removed);
    }
}
