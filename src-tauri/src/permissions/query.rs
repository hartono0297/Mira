//! Read models for the v0.3 Organisasi pages, the people pickers and the
//! project member panel (docs/plans/v0.3-kontrak.md, "Command"). Pure
//! functions over the folded `OrgState`, plus `users` which also reads the
//! peer tables kept by the network (`peer_addresses`, `peer_seen`).

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use super::fold::{MemberKind, MemberState, MemberStatus, OrgState, TeamRole};
use super::store::display_name_for;
use crate::error::{AppError, AppResult};
use crate::identity;
use crate::org::Role;

/// `(public key, name)`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonRef {
    pub public_key: String,
    pub display_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelRef {
    pub id: String,
    pub name: String,
}

/// `(division id, name, role)`; `role` is `"head"` or `"member"`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DivisionRefLite {
    pub id: String,
    pub name: String,
    pub role: super::division::DivisionRole,
}

/// What this laptop's person may do on the Organisasi pages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgOverview {
    pub public_key: String,
    pub is_superadmin: bool,
    pub is_guest: bool,
    pub department_id: Option<String>,
    /// Departments whose join requests this person may decide (all open
    /// departments for a superadmin).
    pub decide_join_team_ids: Vec<String>,
    /// Pending requests this person may decide (for the menu badge).
    pub pending_join_count: usize,
    /// Superadmin only: departments, moving people, labels, user list.
    pub manage_org: bool,
    /// The Pengguna list (`org_users`): everyone for a superadmin, their
    /// own department's people for a department admin.
    pub list_users: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepartmentView {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub archived: bool,
    pub archived_at: Option<String>,
    /// Active people in the department.
    pub member_count: usize,
    pub admins: Vec<PersonRef>,
    /// The automatic department channel (from the log), if any.
    pub channel_id: Option<String>,
    pub channel_name: Option<String>,
}

/// One person, for pickers, chat and the department page. Active members
/// only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonView {
    pub public_key: String,
    pub display_name: String,
    pub fingerprint: String,
    pub role: Role,
    pub is_superadmin: bool,
    pub is_guest: bool,
    pub department_id: Option<String>,
    pub department_name: Option<String>,
    /// `admin` for "Admin departemen".
    pub department_role: Option<TeamRole>,
    /// Active labels, sorted by name. The UI shows at most 3 next to a name.
    pub labels: Vec<LabelRef>,
    /// Active divisions that are not archived, sorted by name (v0.6).
    pub divisions: Vec<DivisionRefLite>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    pub laptop: String,
    pub os: String,
    pub app_version: String,
    pub reported_at: String,
}

/// One row of the superadmin's user list (every member ever, removed
/// included).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserView {
    #[serde(flatten)]
    pub person: PersonView,
    /// `active`, `suspended` or `removed`.
    pub status: MemberStatus,
    pub joined_at: String,
    pub removed_at: Option<String>,
    /// 0.6.0: when and by whom the member was suspended, while suspended.
    pub suspended_at: Option<String>,
    pub suspended_by_name: Option<String>,
    /// What the viewing laptop's person may do to this one (the fold rules;
    /// never to themselves). `can_suspend` ignores the version gate, which
    /// `org_suspend_gate` reports separately.
    pub can_suspend: bool,
    pub can_reinstate: bool,
    pub can_remove: bool,
    /// `None` until the laptop reported it ("Belum dilaporkan").
    pub device: Option<DeviceView>,
    /// IP seen on the connection (current, or the last successful one),
    /// never self-reported. `None` for this laptop and unknown peers.
    pub last_ip: Option<String>,
    pub online: bool,
    pub last_seen_at: Option<String>,
    pub is_me: bool,
    /// For guests: projects they may see ("Tamu, 1 proyek").
    pub guest_project_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectRole {
    /// Creator (while a member), admin of the department, or a superadmin
    /// who is a member.
    Manager,
    Member,
    Guest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMemberView {
    pub public_key: String,
    pub display_name: String,
    pub department_name: Option<String>,
    pub role: ProjectRole,
    pub is_creator: bool,
    /// Guest admitted to the project by an invite code (not in the
    /// explicit member list).
    pub by_invite: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMembersView {
    pub project_id: String,
    /// `false` until `project_create` arrived; nobody sees the project then.
    pub registered: bool,
    pub team_id: Option<String>,
    pub creator: Option<String>,
    pub members: Vec<ProjectMemberView>,
    /// This person may add and remove members.
    pub can_manage: bool,
    /// This person is in the project and may leave it.
    pub can_leave: bool,
    /// This person is a superadmin outside the project and may add
    /// themselves (recorded in the log).
    pub can_join_self: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelView {
    pub id: String,
    pub name: String,
    pub archived: bool,
    pub created_at: String,
    /// Active members with this label.
    pub member_keys: Vec<String>,
}

fn by_name<T>(items: &mut [T], name: impl Fn(&T) -> &str, id: impl Fn(&T) -> &str) {
    items.sort_by(|a, b| {
        name(a)
            .to_lowercase()
            .cmp(&name(b).to_lowercase())
            .then_with(|| id(a).cmp(id(b)))
    });
}

fn person_ref(state: &OrgState, pk: &str) -> PersonRef {
    PersonRef {
        public_key: pk.to_owned(),
        display_name: display_name_for(state, pk, None),
    }
}

pub fn org_overview(
    conn: &Connection,
    state: &OrgState,
    me: &str,
    now: time::OffsetDateTime,
) -> AppResult<OrgOverview> {
    let is_superadmin = state.is_superadmin(me);
    let decide_join_team_ids: Vec<String> = state
        .teams
        .values()
        .filter(|t| !t.deleted && !t.archived && state.may_decide_join(me, &t.id))
        .map(|t| t.id.clone())
        .collect();
    let pending = super::join_store::pending_join_requests(conn, state, me, now)?;
    Ok(OrgOverview {
        public_key: me.to_owned(),
        is_superadmin,
        is_guest: state
            .member(me)
            .is_some_and(|m| m.kind == MemberKind::Guest),
        department_id: state.department_of(me).map(|(t, _)| t.id.clone()),
        decide_join_team_ids,
        pending_join_count: pending.len(),
        manage_org: is_superadmin,
        list_users: may_list_users(state, me),
    })
}

/// Live departments with counts, archived ones last when included.
pub fn departments(state: &OrgState, include_archived: bool) -> Vec<DepartmentView> {
    let mut out: Vec<DepartmentView> = state
        .teams
        .values()
        .filter(|t| !t.deleted && (include_archived || !t.archived))
        .map(|t| {
            let active: Vec<(&String, TeamRole)> = t
                .members
                .iter()
                .filter(|(pk, _)| state.is_active(pk))
                .map(|(pk, m)| (pk, m.role))
                .collect();
            let mut admins: Vec<PersonRef> = active
                .iter()
                .filter(|(_, r)| *r == TeamRole::Admin)
                .map(|(pk, _)| person_ref(state, pk))
                .collect();
            by_name(&mut admins, |p| &p.display_name, |p| &p.public_key);
            let channel = state
                .channels
                .values()
                .filter(|c| c.team.as_deref() == Some(t.id.as_str()))
                .min_by(|a, b| {
                    a.created_at
                        .cmp(&b.created_at)
                        .then_with(|| a.id.cmp(&b.id))
                });
            DepartmentView {
                id: t.id.clone(),
                name: t.name.clone(),
                created_at: t.created_at.clone(),
                archived: t.archived,
                archived_at: t.archived_at.clone(),
                member_count: active.len(),
                admins,
                channel_id: channel.map(|c| c.id.clone()),
                channel_name: channel.map(|c| c.name.clone()),
            }
        })
        .collect();
    out.sort_by(|a, b| {
        a.archived
            .cmp(&b.archived)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.id.cmp(&b.id))
    });
    out
}

fn labels_of(state: &OrgState, pk: &str) -> Vec<LabelRef> {
    let mut out: Vec<LabelRef> = state
        .labels
        .values()
        .filter(|l| !l.archived && l.members.contains(pk))
        .map(|l| LabelRef {
            id: l.id.clone(),
            name: l.name.clone(),
        })
        .collect();
    by_name(&mut out, |l| &l.name, |l| &l.id);
    out
}

fn person_view(
    state: &OrgState,
    m: &MemberState,
    my_name: Option<(&str, Option<&str>)>,
) -> PersonView {
    let dept = state.department_of(&m.public_key);
    let active = m.status == MemberStatus::Active;
    PersonView {
        public_key: m.public_key.clone(),
        display_name: display_name_for(state, &m.public_key, my_name),
        fingerprint: identity::fingerprint(&m.public_key),
        role: state.org_role(&m.public_key),
        is_superadmin: active && m.is_superadmin,
        is_guest: m.kind == MemberKind::Guest,
        department_id: dept.map(|(t, _)| t.id.clone()),
        department_name: dept.map(|(t, _)| t.name.clone()),
        department_role: dept.map(|(_, r)| r),
        labels: if active {
            labels_of(state, &m.public_key)
        } else {
            Vec::new()
        },
        divisions: super::division_view::person_divisions(state, &m.public_key),
    }
}

/// Active people, sorted by name. Anyone in the organization may read it
/// (the same data is in the membership log every laptop holds).
pub fn people(state: &OrgState, me: &str, my_name: Option<&str>) -> Vec<PersonView> {
    let mine = Some((me, my_name));
    let mut out: Vec<PersonView> = state
        .members
        .values()
        .filter(|m| m.status == MemberStatus::Active)
        .map(|m| person_view(state, m, mine))
        .collect();
    by_name(&mut out, |p| &p.display_name, |p| &p.public_key);
    out
}

/// What the network knows about one peer now.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LivePeer {
    /// Remote address of the current connection.
    pub address: Option<String>,
}

fn ip_of(address: &str) -> String {
    address
        .parse::<std::net::SocketAddr>()
        .map(|a| a.ip().to_canonical().to_string())
        .unwrap_or_else(|_| address.to_owned())
}

/// `person_view`, but a suspended person shows the department (and role)
/// of their snapshot while it exists, instead of none.
fn user_person(
    state: &OrgState,
    m: &MemberState,
    my_name: Option<(&str, Option<&str>)>,
) -> PersonView {
    let mut person = person_view(state, m, my_name);
    if m.status == MemberStatus::Suspended
        && let Some((team, role)) = m.snapshot.as_ref().and_then(|s| s.department.as_ref())
        && let Some(t) = state.live_team(team)
    {
        person.department_id = Some(t.id.clone());
        person.department_name = Some(t.name.clone());
        person.department_role = Some(*role);
    }
    person
}

/// Departments `pk` is an admin of (live ones).
fn admin_teams(state: &OrgState, pk: &str) -> Vec<String> {
    if !state.is_active_non_guest(pk) {
        return Vec::new();
    }
    state
        .teams_of(pk)
        .into_iter()
        .filter(|(_, role)| *role == TeamRole::Admin)
        .map(|(t, _)| t.id.clone())
        .collect()
}

/// Whether `pk` may open the Pengguna list: a superadmin, or an active
/// department admin.
pub fn may_list_users(state: &OrgState, pk: &str) -> bool {
    state.is_superadmin(pk) || !admin_teams(state, pk).is_empty()
}

/// Superadmin: everyone who ever joined, with laptop details, last IP and
/// last seen. Department admin: themselves, the people now in a department
/// they admin, and the suspended people whose snapshot department is one
/// of those (no removed people, no other departments). `online` maps the
/// keys connected now to their address.
pub fn users(
    conn: &Connection,
    state: &OrgState,
    me: &str,
    my_name: Option<&str>,
    online: &HashMap<String, LivePeer>,
) -> AppResult<Vec<UserView>> {
    let everyone = state.is_superadmin(me);
    let teams = admin_teams(state, me);
    if !everyone && teams.is_empty() {
        return Err(AppError::Forbidden(
            "Daftar pengguna hanya untuk superadmin dan admin departemen.".into(),
        ));
    }
    let listed = |m: &MemberState| {
        everyone
            || m.public_key == me
            || match m.status {
                MemberStatus::Active => state
                    .department_of(&m.public_key)
                    .is_some_and(|(t, _)| teams.contains(&t.id)),
                MemberStatus::Suspended => m
                    .snapshot
                    .as_ref()
                    .and_then(|s| s.department.as_ref())
                    .is_some_and(|(t, _)| teams.contains(t)),
                MemberStatus::Removed => false,
            }
    };
    let mut last_ip = conn.prepare(
        "SELECT address FROM peer_addresses
         WHERE public_key = ?1 AND last_success_at IS NOT NULL
         ORDER BY last_success_at DESC LIMIT 1",
    )?;
    let mut last_seen = conn.prepare("SELECT last_seen_at FROM peer_seen WHERE public_key = ?1")?;
    let mine = Some((me, my_name));
    let mut out = Vec::with_capacity(state.members.len());
    for m in state.members.values().filter(|m| listed(m)) {
        let pk = m.public_key.as_str();
        let is_me = pk == me;
        let live = online.get(pk);
        // The IP is for superadmins only.
        let ip = if is_me || !everyone {
            None
        } else if let Some(addr) = live.and_then(|l| l.address.as_deref()) {
            Some(ip_of(addr))
        } else {
            last_ip
                .query_row([pk], |r| r.get::<_, String>(0))
                .optional()?
                .map(|a| ip_of(&a))
        };
        let seen: Option<String> = last_seen.query_row([pk], |r| r.get(0)).optional()?;
        let guest_project_count = if m.kind == MemberKind::Guest {
            let mut projects: std::collections::BTreeSet<&str> = state
                .guest_access
                .iter()
                .filter(|g| g.public_key == pk)
                .map(|g| g.project.as_str())
                .collect();
            projects.extend(
                state
                    .projects
                    .values()
                    .filter(|p| p.members.contains_key(pk))
                    .map(|p| p.id.as_str()),
            );
            projects.len()
        } else {
            0
        };
        let acts = |ok: bool| ok && !is_me && state.is_active(me);
        out.push(UserView {
            person: user_person(state, m, mine),
            status: m.status,
            joined_at: m.joined_at.clone(),
            removed_at: m.removed_at.clone(),
            suspended_at: m.suspended_at.clone(),
            suspended_by_name: m
                .suspended_by
                .as_deref()
                .map(|by| display_name_for(state, by, mine)),
            can_suspend: acts(state.may_suspend(me, pk).is_ok()),
            can_reinstate: acts(state.may_reinstate(me, pk).is_ok()),
            can_remove: acts(state.may_remove(me, pk).is_ok()),
            device: m.device.as_ref().map(|d| DeviceView {
                laptop: d.laptop.clone(),
                os: d.os.clone(),
                app_version: d.app_version.clone(),
                reported_at: d.at.clone(),
            }),
            last_ip: ip,
            online: is_me || live.is_some(),
            last_seen_at: seen,
            is_me,
            guest_project_count,
        });
    }
    let rank = |s: MemberStatus| match s {
        MemberStatus::Active => 0,
        MemberStatus::Suspended => 1,
        MemberStatus::Removed => 2,
    };
    out.sort_by(|a, b| {
        rank(a.status)
            .cmp(&rank(b.status))
            .then_with(|| {
                a.person
                    .display_name
                    .to_lowercase()
                    .cmp(&b.person.display_name.to_lowercase())
            })
            .then_with(|| a.person.public_key.cmp(&b.person.public_key))
    });
    Ok(out)
}

/// Members of project `project` (explicit members and guests invited by
/// code), as `me` sees them.
pub fn project_members(state: &OrgState, project: &str, me: &str) -> ProjectMembersView {
    let Some(p) = state.projects.get(project) else {
        return ProjectMembersView {
            project_id: project.to_owned(),
            registered: false,
            team_id: None,
            creator: None,
            members: Vec::new(),
            can_manage: false,
            can_leave: false,
            can_join_self: false,
        };
    };
    let dept_name = |pk: &str| state.department_of(pk).map(|(t, _)| t.name.clone());
    let mut members: Vec<ProjectMemberView> = p
        .members
        .keys()
        .filter(|pk| state.is_active(pk))
        .map(|pk| {
            let guest = state
                .member(pk)
                .is_some_and(|m| m.kind == MemberKind::Guest);
            let role = if guest {
                ProjectRole::Guest
            } else if state.may_manage_project(project, pk) {
                ProjectRole::Manager
            } else {
                ProjectRole::Member
            };
            ProjectMemberView {
                public_key: pk.clone(),
                display_name: display_name_for(state, pk, None),
                department_name: dept_name(pk),
                role,
                is_creator: *pk == p.creator,
                by_invite: false,
            }
        })
        .collect();
    for g in &state.guest_access {
        if g.project == project
            && p.team.as_deref() == Some(g.team.as_str())
            && state.is_active(&g.public_key)
            && !p.members.contains_key(&g.public_key)
        {
            members.push(ProjectMemberView {
                public_key: g.public_key.clone(),
                display_name: display_name_for(state, &g.public_key, None),
                department_name: None,
                role: ProjectRole::Guest,
                is_creator: false,
                by_invite: true,
            });
        }
    }
    members.sort_by(|a, b| {
        a.role
            .rank()
            .cmp(&b.role.rank())
            .then_with(|| {
                a.display_name
                    .to_lowercase()
                    .cmp(&b.display_name.to_lowercase())
            })
            .then_with(|| a.public_key.cmp(&b.public_key))
    });
    let in_project = members.iter().any(|m| m.public_key == me);
    ProjectMembersView {
        project_id: project.to_owned(),
        registered: true,
        team_id: p.team.clone(),
        creator: Some(p.creator.clone()),
        can_manage: state.may_manage_project(project, me),
        can_leave: in_project,
        can_join_self: !in_project && state.is_superadmin(me),
        members,
    }
}

impl ProjectRole {
    fn rank(self) -> u8 {
        match self {
            ProjectRole::Manager => 0,
            ProjectRole::Member => 1,
            ProjectRole::Guest => 2,
        }
    }
}

/// Every label, archived last.
pub fn labels(state: &OrgState) -> Vec<LabelView> {
    let mut out: Vec<LabelView> = state
        .labels
        .values()
        .map(|l| LabelView {
            id: l.id.clone(),
            name: l.name.clone(),
            archived: l.archived,
            created_at: l.created_at.clone(),
            member_keys: l
                .members
                .iter()
                .filter(|pk| state.is_active(pk))
                .cloned()
                .collect(),
        })
        .collect();
    out.sort_by(|a, b| {
        a.archived
            .cmp(&b.archived)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.id.cmp(&b.id))
    });
    out
}
