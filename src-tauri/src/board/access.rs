//! Who may see and change which project (docs/plans/sinkron-board.md,
//! "Aturan akses").
//!
//! [`Rights`] is the membership as far as the board cares: active members
//! (guest or not, superadmin or not), live departments (internally `team`)
//! with their admins, guest access per project, and the projects registered
//! in the membership log with their explicit members (v0.3,
//! docs/plans/v0.3-kontrak.md). It is read from the tables the fold keeps
//! (`members`, `teams`, `team_members`, `guest_access`, `projects`,
//! `project_members`), or built from an `OrgState`.
//!
//! "Manager" of a project P of department T: the creator while a member of
//! P, an admin of T, or a superadmin who is a member of P.
//!
//! | Right | Rule |
//! |---|---|
//! | read | P is registered and the person is an explicit member of P, or has guest access (pk, T, P) |
//! | write | read, and not a guest |
//! | delete task | write, and task creator or manager |
//! | manage project (rename) | write, and manager |
//! | manage members | manager (an admin of T need not be a member) |
//! | create project | admin of T or any superadmin; without department: superadmin or admin of any department |
//! | create project for division D of T | a head of D (in T), an admin of T or any superadmin; D live and not archived |
//!
//! A project that is not registered (`project_create` not received yet, or
//! made before v0.3 and not registered yet) is readable by nobody: data
//! stays where it is until the log says who may have it. Guest access only
//! counts when the invite's department is the project's department.
//! Superadmins do not read a project unless they are members (F-ROLE-11).
//!
//! [`RightsHistory`] replays the accepted membership ops to answer "did the
//! author have this right when the change was made": allowed when the right
//! exists now, or existed and was taken away after the change's time.
//!
//! Chat and documents use [`projects_accessible_by`] and
//! [`may_access_project`] for project-scoped data.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use rusqlite::{Connection, OptionalExtension, params};
use time::OffsetDateTime;

use crate::error::{AppError, AppResult};
use crate::org;
use crate::permissions::{self, MemberKind, MemberStatus, OrgState, TeamRole};

/// A project as the rules need it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProjectRef<'a> {
    pub id: &'a str,
    pub team_id: Option<&'a str>,
    /// Public key of the project creator.
    pub created_by: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MemberRights {
    guest: bool,
    superadmin: bool,
}

/// A project registered in the membership log.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Registered {
    team: Option<String>,
    creator: String,
    /// Explicit members, guests included.
    members: BTreeSet<String>,
    /// v0.6: the division the project was made for.
    division: Option<String>,
}

/// A live division as the board needs it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct DivisionRights {
    team: String,
    archived: bool,
    /// Heads as recorded; `can_create_division_project` checks they are
    /// still active members of the team.
    heads: BTreeSet<String>,
}

/// Board-relevant membership at one moment.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Rights {
    /// Active members only.
    members: BTreeMap<String, MemberRights>,
    /// Live teams: team id -> member public key -> is team admin.
    teams: BTreeMap<String, BTreeMap<String, bool>>,
    /// `(public key, team id, project id)`.
    guests: BTreeSet<(String, String, String)>,
    /// Registered projects by id.
    projects: BTreeMap<String, Registered>,
    /// Divisions that are not deleted, by id.
    divisions: BTreeMap<String, DivisionRights>,
    /// `false` without an organization.
    has_org: bool,
}

impl Rights {
    /// Current rights from the tables kept by the membership fold.
    pub fn load(conn: &Connection) -> AppResult<Rights> {
        let org: Option<String> = conn
            .query_row(
                "SELECT id FROM organizations ORDER BY created_at LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()?;
        let Some(org) = org else {
            return Ok(Rights::default());
        };
        let mut rights = Rights {
            has_org: true,
            ..Rights::default()
        };
        let mut stmt = conn.prepare(
            "SELECT public_key, role, is_superadmin, kind FROM members
             WHERE organization_id = ?1 AND status = 'active'",
        )?;
        let rows = stmt.query_map([&org], |r| {
            let pk: String = r.get(0)?;
            let role: String = r.get(1)?;
            let sa: i64 = r.get(2)?;
            let kind: String = r.get(3)?;
            Ok((pk, role, sa, kind))
        })?;
        for row in rows {
            let (pk, role, sa, kind) = row?;
            rights.members.insert(
                pk,
                MemberRights {
                    guest: kind == "guest" || role == "guest",
                    superadmin: sa != 0 || role == "superadmin",
                },
            );
        }
        let mut stmt = conn.prepare(
            "SELECT t.id, tm.public_key, tm.role FROM teams t
             LEFT JOIN team_members tm ON tm.team_id = t.id
             WHERE t.deleted = 0",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })?;
        for row in rows {
            let (team, pk, role) = row?;
            let members = rights.teams.entry(team).or_default();
            if let Some(pk) = pk {
                members.insert(pk, role.as_deref() == Some("admin"));
            }
        }
        let mut stmt = conn.prepare("SELECT public_key, team_id, project_id FROM guest_access")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        for row in rows {
            rights.guests.insert(row?);
        }
        let mut stmt = conn.prepare("SELECT id, team_id, creator, division_id FROM projects")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })?;
        for row in rows {
            let (id, team, creator, division) = row?;
            rights.projects.insert(
                id,
                Registered {
                    team,
                    creator,
                    members: BTreeSet::new(),
                    division,
                },
            );
        }
        let mut stmt =
            conn.prepare("SELECT id, team_id, archived FROM divisions WHERE deleted = 0")?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, bool>(2)?))
        })?;
        for row in rows {
            let (id, team, archived) = row?;
            rights.divisions.insert(
                id,
                DivisionRights {
                    team,
                    archived,
                    heads: BTreeSet::new(),
                },
            );
        }
        let mut stmt =
            conn.prepare("SELECT division_id, public_key FROM division_members WHERE head = 1")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (division, pk) = row?;
            if let Some(d) = rights.divisions.get_mut(&division) {
                d.heads.insert(pk);
            }
        }
        let mut stmt = conn.prepare("SELECT project_id, public_key FROM project_members")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (project, pk) = row?;
            if let Some(p) = rights.projects.get_mut(&project) {
                p.members.insert(pk);
            }
        }
        Ok(rights)
    }

    pub fn from_state(state: &OrgState) -> Rights {
        let members = state
            .members
            .values()
            .filter(|m| m.status == MemberStatus::Active)
            .map(|m| {
                (
                    m.public_key.clone(),
                    MemberRights {
                        guest: m.kind == MemberKind::Guest,
                        superadmin: m.is_superadmin,
                    },
                )
            })
            .collect();
        let teams = state
            .teams
            .values()
            .filter(|t| !t.deleted)
            .map(|t| {
                let members = t
                    .members
                    .iter()
                    .map(|(pk, m)| (pk.clone(), m.role == TeamRole::Admin))
                    .collect();
                (t.id.clone(), members)
            })
            .collect();
        let guests = state
            .guest_access
            .iter()
            .map(|g| (g.public_key.clone(), g.team.clone(), g.project.clone()))
            .collect();
        let projects = state
            .projects
            .values()
            .map(|p| {
                (
                    p.id.clone(),
                    Registered {
                        team: p.team.clone(),
                        creator: p.creator.clone(),
                        members: p.members.keys().cloned().collect(),
                        division: p.division.clone(),
                    },
                )
            })
            .collect();
        let divisions = state
            .divisions
            .values()
            .filter(|d| !d.deleted)
            .map(|d| {
                let heads = d
                    .members
                    .iter()
                    .filter(|(_, m)| m.head)
                    .map(|(pk, _)| pk.clone())
                    .collect();
                (
                    d.id.clone(),
                    DivisionRights {
                        team: d.team.clone(),
                        archived: d.archived,
                        heads,
                    },
                )
            })
            .collect();
        Rights {
            members,
            teams,
            guests,
            projects,
            divisions,
            has_org: true,
        }
    }

    pub fn has_org(&self) -> bool {
        self.has_org
    }

    fn active(&self, pk: &str) -> Option<MemberRights> {
        self.members.get(pk).copied()
    }

    /// Active member, guest or not.
    pub fn is_active(&self, pk: &str) -> bool {
        self.members.contains_key(pk)
    }

    /// Active member who is not a guest.
    pub fn is_active_member(&self, pk: &str) -> bool {
        self.active(pk).is_some_and(|m| !m.guest)
    }

    pub fn is_guest(&self, pk: &str) -> bool {
        self.active(pk).is_some_and(|m| m.guest)
    }

    pub fn is_superadmin(&self, pk: &str) -> bool {
        self.active(pk).is_some_and(|m| m.superadmin)
    }

    /// Member of the live team (any role).
    pub fn in_team(&self, team: &str, pk: &str) -> bool {
        self.teams.get(team).is_some_and(|m| m.contains_key(pk))
    }

    pub fn is_team_admin(&self, team: &str, pk: &str) -> bool {
        self.teams
            .get(team)
            .is_some_and(|m| m.get(pk).copied().unwrap_or(false))
    }

    fn is_any_team_admin(&self, pk: &str) -> bool {
        self.teams
            .values()
            .any(|m| m.get(pk).copied().unwrap_or(false))
    }

    fn has_guest_access(&self, pk: &str, team: &str, project: &str) -> bool {
        self.guests
            .contains(&(pk.to_owned(), team.to_owned(), project.to_owned()))
    }

    /// The registered project, when the board's row agrees with the log on
    /// department and creator (the id binds both, so a mismatch means a
    /// forged or broken row: no access at all).
    fn registered(&self, p: ProjectRef<'_>) -> Option<&Registered> {
        self.projects
            .get(p.id)
            .filter(|r| r.team.as_deref() == p.team_id && r.creator == p.created_by)
    }

    /// Whether the project is registered in the membership log.
    pub fn is_registered(&self, project_id: &str) -> bool {
        self.projects.contains_key(project_id)
    }

    /// Explicit member of the registered project.
    pub fn is_project_member(&self, pk: &str, p: ProjectRef<'_>) -> bool {
        self.registered(p).is_some_and(|r| r.members.contains(pk))
    }

    /// Creator while a member, admin of the project's department, or
    /// superadmin who is a member. Guests never.
    pub fn is_project_manager(&self, pk: &str, p: ProjectRef<'_>) -> bool {
        let Some(r) = self.registered(p) else {
            return false;
        };
        if !self.is_active_member(pk) {
            return false;
        }
        let member = r.members.contains(pk);
        (member && r.creator == pk)
            || r.team.as_deref().is_some_and(|t| self.is_team_admin(t, pk))
            || (member && self.is_superadmin(pk))
    }

    pub fn can_read(&self, pk: &str, p: ProjectRef<'_>) -> bool {
        if self.active(pk).is_none() {
            return false;
        }
        let Some(r) = self.registered(p) else {
            return false;
        };
        r.members.contains(pk)
            || r.team
                .as_deref()
                .is_some_and(|team| self.has_guest_access(pk, team, p.id))
    }

    pub fn can_write(&self, pk: &str, p: ProjectRef<'_>) -> bool {
        self.is_active_member(pk) && self.can_read(pk, p)
    }

    pub fn can_delete_task(&self, pk: &str, p: ProjectRef<'_>, task_created_by: &str) -> bool {
        self.can_write(pk, p) && (task_created_by == pk || self.is_project_manager(pk, p))
    }

    pub fn can_manage(&self, pk: &str, p: ProjectRef<'_>) -> bool {
        self.can_write(pk, p) && self.is_project_manager(pk, p)
    }

    /// May add and remove project members (`project_member_add` and
    /// `project_member_remove`). Does not need read access: an admin of
    /// the department manages members without being one.
    pub fn can_manage_members(&self, pk: &str, p: ProjectRef<'_>) -> bool {
        self.is_project_manager(pk, p)
    }

    pub fn can_create_project(&self, pk: &str, team: Option<&str>) -> bool {
        if !self.is_active_member(pk) {
            return false;
        }
        match team {
            Some(t) => self.is_superadmin(pk) || self.is_team_admin(t, pk),
            None => self.is_superadmin(pk) || self.is_any_team_admin(pk),
        }
    }

    /// A project for `division` of `team`: the division is live (its team
    /// too) and not archived, and `pk` heads it while in the team, is an
    /// admin of the team or a superadmin. Plain division members may not.
    pub fn can_create_division_project(&self, pk: &str, team: &str, division: &str) -> bool {
        if !self.is_active_member(pk) || !self.teams.contains_key(team) {
            return false;
        }
        let Some(d) = self.divisions.get(division) else {
            return false;
        };
        d.team == team
            && !d.archived
            && (self.is_superadmin(pk)
                || self.is_team_admin(team, pk)
                || (d.heads.contains(pk) && self.in_team(team, pk)))
    }

    /// The division a registered project was made for (v0.6), when the
    /// board's row agrees with the log.
    pub fn registered_division(&self, p: ProjectRef<'_>) -> Option<&str> {
        self.registered(p)?.division.as_deref()
    }

    /// Everyone who may read the project, sorted.
    pub fn readers(&self, p: ProjectRef<'_>) -> Vec<String> {
        self.members
            .keys()
            .filter(|pk| self.can_read(pk, p))
            .cloned()
            .collect()
    }

    /// Everyone who may write in the project, sorted.
    pub fn writers(&self, p: ProjectRef<'_>) -> Vec<String> {
        self.members
            .keys()
            .filter(|pk| self.can_write(pk, p))
            .cloned()
            .collect()
    }
}

/// Rights after every accepted membership op, to judge a change against the
/// moment it was made.
#[derive(Debug, Clone, Default)]
pub struct RightsHistory {
    current: Rights,
    /// `(time of the op that produced it, rights)`, oldest first. The first
    /// entry is the genesis state; consecutive entries differ.
    steps: Vec<(OffsetDateTime, Rights)>,
}

impl RightsHistory {
    /// Current rights from the tables, history from the stored ops.
    pub fn load(conn: &Connection) -> AppResult<RightsHistory> {
        let current = Rights::load(conn)?;
        let Some(org) = org::load_organization(conn)? else {
            return Ok(RightsHistory {
                current,
                steps: Vec::new(),
            });
        };
        let ops = permissions::load_ops(conn)?;
        Ok(RightsHistory {
            current,
            steps: replay(&org, &ops),
        })
    }

    pub fn from_parts(current: Rights, steps: Vec<(OffsetDateTime, Rights)>) -> RightsHistory {
        RightsHistory { current, steps }
    }

    pub fn current(&self) -> &Rights {
        &self.current
    }

    /// `true` when `check` holds now, or held at some point and the op that
    /// took it away is dated after `at` (unix seconds). The start of a right
    /// is not compared with `at`, so a laptop whose clock runs behind is not
    /// refused.
    pub fn allowed_at(&self, at: i64, check: impl Fn(&Rights) -> bool) -> bool {
        if check(&self.current) {
            return true;
        }
        let last_true = self.steps.iter().rposition(|(_, r)| check(r));
        match last_true {
            Some(i) => self
                .steps
                .get(i + 1)
                .is_some_and(|(lost_at, _)| at < lost_at.unix_timestamp()),
            None => false,
        }
    }
}

/// Applies the accepted ops one at a time from genesis and keeps the rights
/// after each op that changed them.
fn replay(
    org: &org::Organization,
    ops: &[permissions::VerifiedOp],
) -> Vec<(OffsetDateTime, Rights)> {
    let result = permissions::fold(org, ops);
    let by_id: HashMap<&str, &permissions::VerifiedOp> =
        ops.iter().map(|op| (op.id.as_str(), op)).collect();
    let mut state = OrgState::genesis(org);
    let start =
        permissions::format::parse_time(&org.created_at).unwrap_or(OffsetDateTime::UNIX_EPOCH);
    let mut steps = vec![(start, Rights::from_state(&state))];
    for (id, outcome) in &result.outcomes {
        if outcome.is_err() {
            continue;
        }
        let Some(op) = by_id.get(id.as_str()) else {
            continue;
        };
        if state.apply(op).is_err() {
            continue;
        }
        let rights = Rights::from_state(&state);
        if steps.last().is_some_and(|(_, last)| *last != rights) {
            steps.push((op.at, rights));
        }
    }
    steps
}

/// A project this peer may access, for chat and documents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectAccess {
    pub project_id: String,
    pub team_id: Option<String>,
    /// May create and change tasks (not a guest).
    pub can_write: bool,
}

fn project_rows(conn: &Connection) -> AppResult<Vec<(String, Option<String>, String)>> {
    let mut stmt =
        conn.prepare("SELECT id, team_id, created_by FROM board_projects ORDER BY id")?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

/// The projects on this laptop that `peer` (64 hex public key) may see now:
/// "proyek yang boleh diakses peer X". Chat and documents call this to scope
/// project channels and project files the same way the board does.
pub fn projects_accessible_by(conn: &Connection, peer: &str) -> AppResult<Vec<ProjectAccess>> {
    let rights = Rights::load(conn)?;
    Ok(project_rows(conn)?
        .into_iter()
        .filter_map(|(id, team, creator)| {
            let p = ProjectRef {
                id: &id,
                team_id: team.as_deref(),
                created_by: &creator,
            };
            rights.can_read(peer, p).then(|| ProjectAccess {
                can_write: rights.can_write(peer, p),
                project_id: id.clone(),
                team_id: team.clone(),
            })
        })
        .collect())
}

/// Whether `peer` may see `project_id` now. `false` for unknown projects.
pub fn may_access_project(conn: &Connection, peer: &str, project_id: &str) -> AppResult<bool> {
    let row: Option<(Option<String>, String)> = conn
        .query_row(
            "SELECT team_id, created_by FROM board_projects WHERE id = ?1",
            [project_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((team, creator)) = row else {
        return Ok(false);
    };
    Ok(Rights::load(conn)?.can_read(
        peer,
        ProjectRef {
            id: project_id,
            team_id: team.as_deref(),
            created_by: &creator,
        },
    ))
}

/// For a guest invite: every project must exist on this laptop and belong to
/// `team_id`, otherwise the invite would grant nothing.
pub fn check_guest_projects(
    conn: &Connection,
    team_id: &str,
    project_ids: &[String],
) -> AppResult<()> {
    for id in project_ids {
        let team: Option<Option<String>> = conn
            .query_row(
                "SELECT team_id FROM board_projects WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        match team {
            Some(Some(t)) if t == team_id => {}
            Some(_) => {
                return Err(AppError::InvalidInput(
                    "Tamu hanya bisa diundang ke proyek milik departemen yang dipilih. Pilih proyek dari departemen itu.".into(),
                ));
            }
            None => {
                return Err(AppError::NotFound(
                    "Proyek tidak ditemukan di laptop ini.".into(),
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
