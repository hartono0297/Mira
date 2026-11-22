//! Who may do what on the board.
//!
//! `BoardPolicy` is the seam for permission checks. `LocalRolePolicy` follows
//! the PRD permission table as far as local data allows, reading the tables
//! the Tahap 1 membership fold maintains (`members`, `teams`, `team_members`):
//!
//! | Action | Allowed |
//! |---|---|
//! | create project | superadmin, or team admin (of that team when one is given) |
//! | manage project | superadmin, admin of the project's team, or the project creator |
//! | create, edit, move, comment, remote change | active member who is not a guest |
//! | delete task | task creator, admin of the project's team, or superadmin |
//!
//! Every action first requires an active, non-guest member; a removed laptop
//! gets `AppError::Removed`. Guests per project (F-ROLE-05) come later: a
//! policy built on `permissions::OrgState` can replace this one.

use rusqlite::{Connection, OptionalExtension, params};

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
    /// Any change from another laptop. Automerge changes are opaque
    /// operations, so a remote delete is held to the edit rule, not the
    /// stricter delete rule; a semantic check needs decoding the change.
    RemoteChange {
        project_id: String,
    },
}

pub trait BoardPolicy {
    /// `Ok(())` when `actor` (64-hex public key) may do `action`.
    fn check(&self, conn: &Connection, actor: &str, action: &BoardAction) -> AppResult<()>;

    fn allows(&self, conn: &Connection, actor: &str, action: &BoardAction) -> bool {
        self.check(conn, actor, action).is_ok()
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct LocalRolePolicy;

struct MemberRow {
    removed: bool,
    guest: bool,
    superadmin: bool,
    team_admin_role: bool,
}

fn forbidden(msg: &str) -> AppError {
    AppError::Forbidden(msg.to_owned())
}

fn member_row(conn: &Connection, pk: &str) -> AppResult<Option<MemberRow>> {
    let org: Option<String> = conn
        .query_row(
            "SELECT id FROM organizations ORDER BY created_at LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let Some(org) = org else {
        return Err(forbidden(
            "Board baru bisa dipakai setelah laptop ini membuat atau bergabung dengan organisasi.",
        ));
    };
    Ok(conn
        .query_row(
            "SELECT status, kind, is_superadmin, role FROM members
             WHERE organization_id = ?1 AND public_key = ?2",
            params![org, pk],
            |r| {
                let status: String = r.get(0)?;
                let kind: String = r.get(1)?;
                let is_superadmin: i64 = r.get(2)?;
                let role: String = r.get(3)?;
                Ok(MemberRow {
                    removed: status == "removed",
                    guest: kind == "guest" || role == "guest",
                    superadmin: is_superadmin != 0 || role == "superadmin",
                    team_admin_role: role == "team_admin",
                })
            },
        )
        .optional()?)
}

fn is_team_admin(conn: &Connection, pk: &str, team_id: &str) -> AppResult<bool> {
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM team_members tm JOIN teams t ON t.id = tm.team_id
         WHERE tm.team_id = ?1 AND tm.public_key = ?2 AND tm.role = 'admin' AND t.deleted = 0",
        params![team_id, pk],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

fn is_any_team_admin(conn: &Connection, pk: &str) -> AppResult<bool> {
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM team_members tm JOIN teams t ON t.id = tm.team_id
         WHERE tm.public_key = ?1 AND tm.role = 'admin' AND t.deleted = 0",
        [pk],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// `(team_id, created_by)` of a stored project.
fn project_owner(conn: &Connection, project_id: &str) -> AppResult<(Option<String>, String)> {
    conn.query_row(
        "SELECT team_id, created_by FROM board_projects WHERE id = ?1",
        [project_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("Proyek tidak ditemukan.".into()))
}

impl BoardPolicy for LocalRolePolicy {
    fn check(&self, conn: &Connection, actor: &str, action: &BoardAction) -> AppResult<()> {
        let m = member_row(conn, actor)?.ok_or_else(|| {
            forbidden(
                "Laptop ini belum menjadi anggota organisasi, jadi belum bisa mengubah board.",
            )
        })?;
        if m.removed {
            return Err(AppError::Removed);
        }
        if m.guest {
            return Err(forbidden(
                "Tamu belum bisa mengubah board. Minta admin tim menjadikan Anda anggota.",
            ));
        }
        match action {
            BoardAction::CreateProject { team_id } => {
                if m.superadmin {
                    return Ok(());
                }
                let admin = match team_id {
                    Some(team) => is_team_admin(conn, actor, team)?,
                    None => m.team_admin_role || is_any_team_admin(conn, actor)?,
                };
                if admin {
                    Ok(())
                } else {
                    Err(forbidden(
                        "Hanya superadmin atau admin tim yang bisa membuat proyek. Minta admin tim membuatkannya.",
                    ))
                }
            }
            BoardAction::ManageProject { project_id } => {
                let (team, creator) = project_owner(conn, project_id)?;
                let team_admin = match &team {
                    Some(t) => is_team_admin(conn, actor, t)?,
                    None => false,
                };
                if m.superadmin || creator == actor || team_admin {
                    Ok(())
                } else {
                    Err(forbidden(
                        "Hanya superadmin, admin tim proyek ini, atau pembuat proyek yang bisa mengatur proyek ini.",
                    ))
                }
            }
            BoardAction::CreateTask { .. }
            | BoardAction::EditTask { .. }
            | BoardAction::MoveTask { .. }
            | BoardAction::Comment { .. }
            | BoardAction::RemoteChange { .. } => Ok(()),
            BoardAction::DeleteTask {
                project_id,
                created_by,
                ..
            } => {
                if m.superadmin || created_by == actor {
                    return Ok(());
                }
                let (team, _) = project_owner(conn, project_id)?;
                if let Some(team) = team
                    && is_team_admin(conn, actor, &team)?
                {
                    return Ok(());
                }
                Err(forbidden(
                    "Task ini hanya bisa dihapus oleh pembuatnya, admin tim proyek, atau superadmin.",
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
                "INSERT INTO board_projects (id, code, name, team_id, created_by, created_at, doc, updated_at)
                 VALUES (?1, ?2, 'P', ?3, ?4, 't', x'00', 't')",
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
        assert!(p.allows(&l.conn, &l.pk(), &create(Some(&other_team))));
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
        let team = add_team(&l.conn, "Desain", &[(&admin, "admin")]);
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
        assert!(p.allows(&l.conn, &l.pk(), &delete), "superadmin");
        assert_eq!(
            p.check(&l.conn, &other, &delete).unwrap_err().code(),
            "forbidden"
        );

        let manage = BoardAction::ManageProject {
            project_id: pid.clone(),
        };
        assert!(p.allows(&l.conn, &l.pk(), &manage));
        assert!(p.allows(&l.conn, &admin, &manage));
        assert!(!p.allows(&l.conn, &member, &manage));

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
