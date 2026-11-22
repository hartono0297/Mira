//! Who is in a conversation and who administers it (plan section 4).
//!
//! Everything here reads the tables the membership fold maintains (`members`,
//! `teams`, `team_members`, `channels`) plus the board projects through
//! [`ProjectAudience`]. [`Directory`] loads the membership tables once, so
//! `record_ids_for` can judge thousands of records without a query each.
//!
//! Only members with `status = 'active'` are ever in an audience. Guests are
//! only in the project conversations they have access to; chat pribadi is only
//! between two active members who are not guests; a deleted team has no
//! members.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension};
use time::OffsetDateTime;

use super::model::{self, Conv};
use crate::error::AppResult;
use crate::identity;
use crate::permissions::{self, format::parse_time};

/// Shown as the scope of `#umum` and organization channels.
pub const ORG_SCOPE_NAME: &str = "Seluruh kantor";
/// Channel name used when a project name has no usable characters.
pub const PROJECT_FALLBACK_NAME: &str = "proyek";

/// A board project as chat sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub team_id: Option<String>,
}

/// "Who may be in this project's channel". Every answer is limited to active
/// members of the organization.
pub trait ProjectAudience: Send + Sync {
    fn project(&self, conn: &Connection, project_id: &str) -> AppResult<Option<ProjectInfo>>;
    fn projects(&self, conn: &Connection) -> AppResult<Vec<ProjectInfo>>;
    fn is_member(&self, conn: &Connection, project_id: &str, pk: &str) -> AppResult<bool>;
    fn members(&self, conn: &Connection, project_id: &str) -> AppResult<Vec<String>>;
}

/// Temporary [`ProjectAudience`] reading `board_projects.team_id`. A project
/// with a team: that team's members plus guests listed in `guest_access` for
/// the project. A project without a team: every active member who is not a
/// guest, plus those guests. A project whose team is deleted has nobody.
///
/// Connection point for the board-sync session: when board sync grants guest
/// access per project, it replaces this implementation.
#[derive(Debug, Default, Clone, Copy)]
pub struct BoardTeamAudience;

impl BoardTeamAudience {
    fn team_alive(conn: &Connection, team_id: &str) -> AppResult<bool> {
        let n: i64 = conn.query_row(
            "SELECT count(*) FROM teams WHERE id = ?1 AND deleted = 0",
            [team_id],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }
}

impl ProjectAudience for BoardTeamAudience {
    fn project(&self, conn: &Connection, project_id: &str) -> AppResult<Option<ProjectInfo>> {
        Ok(conn
            .query_row(
                "SELECT id, name, team_id FROM board_projects WHERE id = ?1",
                [project_id],
                |r| {
                    Ok(ProjectInfo {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        team_id: r.get(2)?,
                    })
                },
            )
            .optional()?)
    }

    fn projects(&self, conn: &Connection) -> AppResult<Vec<ProjectInfo>> {
        let mut stmt =
            conn.prepare("SELECT id, name, team_id FROM board_projects ORDER BY name")?;
        let rows = stmt
            .query_map([], |r| {
                Ok(ProjectInfo {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    team_id: r.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    fn is_member(&self, conn: &Connection, project_id: &str, pk: &str) -> AppResult<bool> {
        Ok(self.members(conn, project_id)?.iter().any(|m| m == pk))
    }

    fn members(&self, conn: &Connection, project_id: &str) -> AppResult<Vec<String>> {
        let Some(project) = self.project(conn, project_id)? else {
            return Ok(Vec::new());
        };
        let mut out: Vec<String> = match &project.team_id {
            Some(team) if !Self::team_alive(conn, team)? => return Ok(Vec::new()),
            Some(team) => query_keys(
                conn,
                "SELECT tm.public_key FROM team_members tm
                 JOIN members m ON m.public_key = tm.public_key
                 WHERE tm.team_id = ?1 AND m.status = 'active' AND m.kind = 'member'",
                team,
            )?,
            None => {
                let mut stmt = conn.prepare(
                    "SELECT public_key FROM members WHERE status = 'active' AND kind = 'member'",
                )?;
                stmt.query_map([], |r| r.get(0))?
                    .collect::<Result<Vec<String>, _>>()?
            }
        };
        out.extend(query_keys(
            conn,
            "SELECT g.public_key FROM guest_access g
             JOIN members m ON m.public_key = g.public_key
             WHERE g.project_id = ?1 AND m.status = 'active' AND m.kind = 'guest'",
            project_id,
        )?);
        out.sort();
        out.dedup();
        Ok(out)
    }
}

fn query_keys(conn: &Connection, sql: &str, arg: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt
        .query_map([arg], |r| r.get(0))?
        .collect::<Result<Vec<String>, _>>()?;
    Ok(rows)
}

#[derive(Debug, Clone)]
pub struct MemberInfo {
    pub name: Option<String>,
    pub active: bool,
    pub guest: bool,
    pub superadmin: bool,
    pub removed_at: Option<OffsetDateTime>,
}

#[derive(Debug, Clone)]
pub struct TeamInfo {
    pub name: String,
    pub deleted: bool,
    /// Public key to "is team admin".
    pub members: HashMap<String, bool>,
}

/// The membership tables, loaded once.
#[derive(Debug, Clone)]
pub struct Directory {
    pub org_id: String,
    pub me: String,
    /// `#umum` channel id (32 hex).
    pub umum: String,
    pub members: HashMap<String, MemberInfo>,
    pub teams: HashMap<String, TeamInfo>,
    /// Channels from the membership log: id to (team id, name).
    pub log_channels: HashMap<String, (Option<String>, String)>,
}

impl Directory {
    /// `None` when this laptop has no organization yet.
    pub fn load(conn: &Connection, me: &str) -> AppResult<Option<Directory>> {
        let Some(org) = crate::org::load_organization(conn)? else {
            return Ok(None);
        };
        let mut dir = Directory {
            umum: permissions::umum_channel_id(&org.id),
            org_id: org.id,
            me: me.to_owned(),
            members: HashMap::new(),
            teams: HashMap::new(),
            log_channels: HashMap::new(),
        };
        dir.load_members(conn)?;
        dir.load_teams(conn)?;
        let mut stmt = conn.prepare("SELECT id, team_id, name FROM channels")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (id, team, name) = row?;
            dir.log_channels.insert(id, (team, name));
        }
        Ok(Some(dir))
    }

    fn load_members(&mut self, conn: &Connection) -> AppResult<()> {
        let mut stmt = conn.prepare(
            "SELECT public_key, display_name, status, kind, is_superadmin, role, removed_at
             FROM members WHERE organization_id = ?1",
        )?;
        let rows = stmt.query_map([&self.org_id], |r| {
            let status: String = r.get(2)?;
            let kind: String = r.get(3)?;
            let role: String = r.get(5)?;
            let removed_at: Option<String> = r.get(6)?;
            Ok((
                r.get::<_, String>(0)?,
                MemberInfo {
                    name: r
                        .get::<_, Option<String>>(1)?
                        .filter(|n| !n.trim().is_empty()),
                    active: status == "active",
                    guest: kind == "guest" || role == "guest",
                    superadmin: r.get::<_, i64>(4)? != 0,
                    removed_at: removed_at.as_deref().and_then(parse_time),
                },
            ))
        })?;
        for row in rows {
            let (pk, info) = row?;
            self.members.insert(pk, info);
        }
        Ok(())
    }

    fn load_teams(&mut self, conn: &Connection) -> AppResult<()> {
        let mut stmt = conn.prepare("SELECT id, name, deleted FROM teams")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)? != 0,
            ))
        })?;
        for row in rows {
            let (id, name, deleted) = row?;
            self.teams.insert(
                id,
                TeamInfo {
                    name,
                    deleted,
                    members: HashMap::new(),
                },
            );
        }
        let mut stmt = conn.prepare("SELECT team_id, public_key, role FROM team_members")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)? == "admin",
            ))
        })?;
        for row in rows {
            let (team, pk, admin) = row?;
            if let Some(t) = self.teams.get_mut(&team) {
                t.members.insert(pk, admin);
            }
        }
        Ok(())
    }

    pub fn member(&self, pk: &str) -> Option<&MemberInfo> {
        self.members.get(pk)
    }

    pub fn is_active(&self, pk: &str) -> bool {
        self.member(pk).is_some_and(|m| m.active)
    }

    /// Active and not a guest.
    pub fn is_full_member(&self, pk: &str) -> bool {
        self.member(pk).is_some_and(|m| m.active && !m.guest)
    }

    pub fn is_superadmin(&self, pk: &str) -> bool {
        self.member(pk).is_some_and(|m| m.active && m.superadmin)
    }

    /// Display name, or the key fingerprint when none is known.
    pub fn name(&self, pk: &str) -> String {
        self.member(pk)
            .and_then(|m| m.name.clone())
            .unwrap_or_else(|| identity::fingerprint(pk))
    }

    /// Active members who are not guests, sorted.
    pub fn full_members(&self) -> Vec<String> {
        let mut out: Vec<String> = self
            .members
            .iter()
            .filter(|(_, m)| m.active && !m.guest)
            .map(|(pk, _)| pk.clone())
            .collect();
        out.sort();
        out
    }

    pub fn team(&self, id: &str) -> Option<&TeamInfo> {
        self.teams.get(id).filter(|t| !t.deleted)
    }

    pub fn in_team(&self, team: &str, pk: &str) -> bool {
        self.team(team).is_some_and(|t| t.members.contains_key(pk))
    }

    pub fn is_team_admin(&self, team: &str, pk: &str) -> bool {
        self.team(team)
            .is_some_and(|t| t.members.get(pk).copied().unwrap_or(false))
    }
}

/// What a conversation is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scope {
    Umum,
    /// A channel for the whole office made with `channel_create`.
    Org,
    Team(String),
    Project(String),
    Direct(String, String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConvInfo {
    pub conv: String,
    pub scope: Scope,
    /// Channel name without `#`; empty for chat pribadi.
    pub name: String,
    /// Team or project name, or [`ORG_SCOPE_NAME`].
    pub scope_name: String,
    /// Made with a `channel_create` record.
    pub created: bool,
    pub archived: bool,
    pub deleted: bool,
}

impl ConvInfo {
    pub fn is_channel(&self) -> bool {
        !matches!(self.scope, Scope::Direct(..))
    }
}

/// Row of `chat_channels`.
struct ChannelRow {
    name: Option<String>,
    scope_kind: Option<String>,
    scope_id: Option<String>,
    archived: bool,
    deleted: bool,
}

fn channel_row(conn: &Connection, conv: &str) -> AppResult<Option<ChannelRow>> {
    Ok(conn
        .query_row(
            "SELECT name, scope_kind, scope_id, archived, deleted FROM chat_channels WHERE conv = ?1",
            [conv],
            |r| {
                Ok(ChannelRow {
                    name: r.get(0)?,
                    scope_kind: r.get(1)?,
                    scope_id: r.get(2)?,
                    archived: r.get::<_, i64>(3)? != 0,
                    deleted: r.get::<_, i64>(4)? != 0,
                })
            },
        )
        .optional()?)
}

/// Directory plus project lookups and a per-call cache of conversations.
pub struct Ctx<'a> {
    pub conn: &'a Connection,
    pub dir: Directory,
    pub projects: &'a dyn ProjectAudience,
    convs: RefCell<HashMap<String, Option<ConvInfo>>>,
    project_members: RefCell<HashMap<String, HashSet<String>>>,
}

impl<'a> Ctx<'a> {
    pub fn new(conn: &'a Connection, dir: Directory, projects: &'a dyn ProjectAudience) -> Self {
        Self {
            conn,
            dir,
            projects,
            convs: RefCell::new(HashMap::new()),
            project_members: RefCell::new(HashMap::new()),
        }
    }

    /// `None` when there is no organization.
    pub fn load(
        conn: &'a Connection,
        me: &str,
        projects: &'a dyn ProjectAudience,
    ) -> AppResult<Option<Self>> {
        Ok(Directory::load(conn, me)?.map(|dir| Self::new(conn, dir, projects)))
    }

    pub fn me(&self) -> &str {
        &self.dir.me
    }

    /// Drops cached answers after a channel or board change.
    pub fn forget(&self, conv: &str) {
        self.convs.borrow_mut().remove(conv);
    }

    /// The conversation, or `None` when this laptop does not know it (yet).
    pub fn conv(&self, conv: &str) -> AppResult<Option<ConvInfo>> {
        if let Some(hit) = self.convs.borrow().get(conv) {
            return Ok(hit.clone());
        }
        let info = self.resolve(conv)?;
        self.convs
            .borrow_mut()
            .insert(conv.to_owned(), info.clone());
        Ok(info)
    }

    fn resolve(&self, conv: &str) -> AppResult<Option<ConvInfo>> {
        let id = match model::parse_conv(conv) {
            None => return Ok(None),
            Some(Conv::Direct(a, b)) => {
                return Ok(Some(ConvInfo {
                    conv: conv.to_owned(),
                    scope: Scope::Direct(a, b),
                    name: String::new(),
                    scope_name: String::new(),
                    created: false,
                    archived: false,
                    deleted: false,
                }));
            }
            Some(Conv::Channel(id)) => id,
        };
        let row = channel_row(self.conn, conv)?;
        let (archived, deleted) = row
            .as_ref()
            .map_or((false, false), |r| (r.archived, r.deleted));
        let base = |scope, name: String, scope_name: String, created| ConvInfo {
            conv: conv.to_owned(),
            scope,
            name,
            scope_name,
            created,
            archived,
            deleted,
        };
        if id == self.dir.umum {
            let name = permissions::UMUM_CHANNEL_NAME.to_owned();
            return Ok(Some(base(Scope::Umum, name, ORG_SCOPE_NAME.into(), false)));
        }
        if let Some((team, name)) = self.dir.log_channels.get(&id) {
            let name = model::normalize_channel_name(name).unwrap_or_else(|| name.clone());
            return Ok(Some(match team {
                Some(t) => base(Scope::Team(t.clone()), name, self.team_name(t), false),
                None => base(Scope::Org, name, ORG_SCOPE_NAME.into(), false),
            }));
        }
        if let Some(r) = row.as_ref().filter(|r| r.scope_kind.is_some()) {
            let name = r.name.clone().unwrap_or_default();
            let scope_id = r.scope_id.clone().unwrap_or_default();
            let info = match r.scope_kind.as_deref() {
                Some("team") => {
                    let scope_name = self.team_name(&scope_id);
                    base(Scope::Team(scope_id), name, scope_name, true)
                }
                Some("project") => {
                    let scope_name = self.project_name(&scope_id)?;
                    base(Scope::Project(scope_id), name, scope_name, true)
                }
                _ => base(Scope::Org, name, ORG_SCOPE_NAME.into(), true),
            };
            return Ok(Some(info));
        }
        if let Some(p) = self.projects.project(self.conn, &id)? {
            let name = model::normalize_channel_name(&p.name)
                .unwrap_or_else(|| PROJECT_FALLBACK_NAME.to_owned());
            return Ok(Some(base(Scope::Project(p.id), name, p.name, false)));
        }
        Ok(None)
    }

    fn team_name(&self, team: &str) -> String {
        self.dir
            .teams
            .get(team)
            .map_or_else(|| "Tim".to_owned(), |t| t.name.clone())
    }

    fn project_name(&self, project: &str) -> AppResult<String> {
        Ok(self
            .projects
            .project(self.conn, project)?
            .map_or_else(|| "Proyek".to_owned(), |p| p.name))
    }

    fn project_members(&self, project: &str) -> AppResult<HashSet<String>> {
        if let Some(hit) = self.project_members.borrow().get(project) {
            return Ok(hit.clone());
        }
        let set: HashSet<String> = self
            .projects
            .members(self.conn, project)?
            .into_iter()
            .filter(|pk| self.dir.is_active(pk))
            .collect();
        self.project_members
            .borrow_mut()
            .insert(project.to_owned(), set.clone());
        Ok(set)
    }

    /// Whether `pk` is in the conversation now (active members only).
    pub fn in_audience(&self, info: &ConvInfo, pk: &str) -> AppResult<bool> {
        if !self.dir.is_active(pk) {
            return Ok(false);
        }
        Ok(match &info.scope {
            Scope::Umum | Scope::Org => self.dir.is_full_member(pk),
            Scope::Team(t) => self.dir.in_team(t, pk),
            Scope::Project(p) => self.project_members(p)?.contains(pk),
            Scope::Direct(a, b) => {
                (pk == a || pk == b) && self.dir.is_full_member(a) && self.dir.is_full_member(b)
            }
        })
    }

    /// Everyone in the conversation now, sorted.
    pub fn audience(&self, info: &ConvInfo) -> AppResult<Vec<String>> {
        let mut out: Vec<String> = match &info.scope {
            Scope::Umum | Scope::Org => self.dir.full_members(),
            Scope::Team(t) => self
                .dir
                .team(t)
                .map(|team| {
                    team.members
                        .keys()
                        .filter(|pk| self.dir.is_active(pk))
                        .cloned()
                        .collect()
                })
                .unwrap_or_default(),
            Scope::Project(p) => self.project_members(p)?.into_iter().collect(),
            Scope::Direct(a, b) => {
                if self.dir.is_full_member(a) && self.dir.is_full_member(b) {
                    vec![a.clone(), b.clone()]
                } else {
                    Vec::new()
                }
            }
        };
        out.sort();
        Ok(out)
    }

    /// May archive or delete the channel and delete other people's messages.
    pub fn is_admin(&self, info: &ConvInfo, pk: &str) -> AppResult<bool> {
        if !self.dir.is_active(pk) {
            return Ok(false);
        }
        Ok(match &info.scope {
            Scope::Umum | Scope::Org => self.dir.is_superadmin(pk),
            Scope::Team(t) => {
                (self.dir.is_superadmin(pk) && self.dir.in_team(t, pk))
                    || self.dir.is_team_admin(t, pk)
            }
            Scope::Project(p) => {
                if self.dir.is_superadmin(pk) {
                    true
                } else {
                    let team = self.projects.project(self.conn, p)?.and_then(|p| p.team_id);
                    team.is_some_and(|t| self.dir.is_team_admin(&t, pk))
                }
            }
            Scope::Direct(..) => false,
        })
    }

    /// The conversation ids of every channel this laptop can name: `#umum`,
    /// membership-log channels, created channels and project channels.
    pub fn all_channel_convs(&self) -> AppResult<Vec<String>> {
        let mut set: HashSet<String> = HashSet::new();
        set.insert(model::channel_conv(&self.dir.umum));
        for id in self.dir.log_channels.keys() {
            set.insert(model::channel_conv(id));
        }
        for p in self.projects.projects(self.conn)? {
            if crate::permissions::format::is_lower_hex(&p.id, 32) {
                set.insert(model::channel_conv(&p.id));
            }
        }
        let mut stmt = self
            .conn
            .prepare("SELECT conv FROM chat_channels WHERE scope_kind IS NOT NULL")?;
        for row in stmt.query_map([], |r| r.get::<_, String>(0))? {
            set.insert(row?);
        }
        let mut out: Vec<String> = set.into_iter().collect();
        out.sort();
        Ok(out)
    }
}

/// Checks whether two keys may talk in chat pribadi now.
pub fn dm_allowed(dir: &Directory, a: &str, b: &str) -> bool {
    a != b && dir.is_full_member(a) && dir.is_full_member(b)
}

impl Ctx<'_> {
    /// `a` and `b` are both in some conversation now: a pair allowed in chat
    /// pribadi, or a channel (project channels included) that has both.
    pub fn share_conversation(&self, a: &str, b: &str) -> AppResult<bool> {
        if dm_allowed(&self.dir, a, b) {
            return Ok(true);
        }
        for conv in self.all_channel_convs()? {
            let Some(info) = self.conv(&conv)? else {
                continue;
            };
            if !info.deleted && self.in_audience(&info, a)? && self.in_audience(&info, b)? {
                return Ok(true);
            }
        }
        Ok(false)
    }
}
