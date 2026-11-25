//! Read models of the "Departemen saya" tab, the division picker and the
//! chat banner (docs/plans/dept-divisi.md, 5). Field names match
//! `src/api/division.ts`.

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use super::division::{DIVISION_SINCE, DivisionRole, division_blockers, division_gate_open};
use super::fold::{OrgState, TeamRole};
use super::format::channel_name_for;
use super::op::{Body, Payload};
use super::query::{DivisionRefLite, LabelRef, PersonRef};
use super::store::display_name_for;
use crate::error::AppResult;
use crate::identity;

/// Most entries in `admin_history`.
pub const ADMIN_HISTORY_MAX: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DivisionRefData {
    pub id: String,
    pub name: String,
    pub team_id: String,
    pub team_name: String,
    pub archived: bool,
    /// This person's role there; `None` when it only manages the division.
    pub role: Option<DivisionRole>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeptChoiceData {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeptMeData {
    pub public_key: String,
    pub is_superadmin: bool,
    pub is_admin: bool,
    /// Divisions of this department this person heads.
    pub head_of: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberDivisionData {
    pub id: String,
    pub name: String,
    pub role: DivisionRole,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeptMemberData {
    pub public_key: String,
    pub display_name: String,
    pub fingerprint: String,
    pub is_superadmin: bool,
    pub is_admin: bool,
    pub is_me: bool,
    pub online: bool,
    pub labels: Vec<LabelRef>,
    /// Divisions of this department that are not archived.
    pub divisions: Vec<MemberDivisionData>,
    pub app_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DivisionMemberData {
    pub public_key: String,
    pub display_name: String,
    pub role: DivisionRole,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSettingsData {
    pub pinned: String,
    pub announce: bool,
    pub set_at: Option<String>,
    pub set_by_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DivisionViewData {
    pub id: String,
    pub name: String,
    pub archived: bool,
    pub created_at: String,
    /// Heads first, then by name.
    pub members: Vec<DivisionMemberData>,
    pub can_manage: bool,
    pub can_edit_members: bool,
    /// `ch:<division id>`.
    pub conv: String,
    pub settings: ChatSettingsData,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeptProjectData {
    pub id: String,
    pub name: String,
    pub division_id: Option<String>,
    pub division_name: Option<String>,
    pub members: Vec<PersonRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeptChannelData {
    /// `ch:<channel id>`; empty when the department has no channel.
    pub conv: String,
    pub name: String,
    pub settings: ChatSettingsData,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminEventData {
    pub at: String,
    pub by_name: String,
    pub target_name: String,
    pub admin: bool,
    /// `applied` or `rejected`.
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GateBlockerData {
    pub public_key: String,
    pub name: String,
    pub app_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GateData {
    pub open: bool,
    pub since: String,
    pub blockers: Vec<GateBlockerData>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeptOverviewData {
    pub team_id: String,
    pub team_name: String,
    pub archived: bool,
    pub choices: Vec<DeptChoiceData>,
    pub me: DeptMeData,
    pub can_manage_dept: bool,
    pub members: Vec<DeptMemberData>,
    pub divisions: Vec<DivisionViewData>,
    pub projects: Vec<DeptProjectData>,
    pub channel: DeptChannelData,
    pub admin_history: Vec<AdminEventData>,
    pub gate: GateData,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSettingsData {
    pub pinned: String,
    pub announce: bool,
    /// false: announcement mode is on and this person does not manage the
    /// conversation, or the division is archived.
    pub can_write: bool,
    pub can_edit: bool,
    pub team_id: String,
    pub division_id: Option<String>,
}

fn name_of(state: &OrgState, pk: &str) -> String {
    display_name_for(state, pk, None)
}

fn sort_by_name<T>(items: &mut [T], key: impl Fn(&T) -> (&str, &str)) {
    items.sort_by(|a, b| {
        let (na, ia) = key(a);
        let (nb, ib) = key(b);
        na.to_lowercase()
            .cmp(&nb.to_lowercase())
            .then_with(|| ia.cmp(ib))
    });
}

fn heads_in(state: &OrgState, me: &str, team: &str) -> Vec<String> {
    state
        .divisions_of(me)
        .into_iter()
        .filter(|(d, r)| d.team == team && *r == DivisionRole::Head)
        .map(|(d, _)| d.id.clone())
        .collect()
}

/// Departments `me` may open in the tab: every live one for a superadmin,
/// else those it administers or heads a division in.
fn dept_choices(state: &OrgState, me: &str) -> Vec<DeptChoiceData> {
    if !state.is_active_non_guest(me) {
        return Vec::new();
    }
    let sa = state.is_superadmin(me);
    let mut out: Vec<DeptChoiceData> = state
        .teams
        .values()
        .filter(|t| !t.deleted)
        .filter(|t| {
            sa || state.team_role(&t.id, me) == Some(TeamRole::Admin)
                || !heads_in(state, me, &t.id).is_empty()
        })
        .map(|t| DeptChoiceData {
            id: t.id.clone(),
            name: t.name.clone(),
        })
        .collect();
    sort_by_name(&mut out, |c| (&c.name, &c.id));
    out
}

fn chat_settings_data(state: &OrgState, team: &str, division: Option<&str>) -> ChatSettingsData {
    match state.chat_settings_for(team, division) {
        Some(c) => ChatSettingsData {
            pinned: c.pinned.clone(),
            announce: c.announce,
            set_at: Some(c.set_at.clone()),
            set_by_name: Some(name_of(state, &c.set_by)),
        },
        None => ChatSettingsData {
            pinned: String::new(),
            announce: false,
            set_at: None,
            set_by_name: None,
        },
    }
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
    sort_by_name(&mut out, |l| (&l.name, &l.id));
    out
}

fn admin_history(
    conn: &Connection,
    state: &OrgState,
    team: &str,
) -> AppResult<Vec<AdminEventData>> {
    let mut stmt = conn.prepare(
        "SELECT payload, status FROM org_ops
         WHERE kind IN ('team_admin_set', 'team_admin_unset')
         ORDER BY lamport DESC, author DESC, id DESC",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut out = Vec::new();
    for row in rows {
        let (payload, status) = row?;
        let Ok(p) = serde_json::from_str::<Payload>(&payload) else {
            continue;
        };
        let (t, member, admin) = match &p.body {
            Body::TeamAdminSet { team, member } => (team, member, true),
            Body::TeamAdminUnset { team, member } => (team, member, false),
            _ => continue,
        };
        if t != team {
            continue;
        }
        out.push(AdminEventData {
            at: p.at.clone(),
            by_name: name_of(state, &p.author),
            target_name: name_of(state, member),
            admin,
            status,
        });
        if out.len() >= ADMIN_HISTORY_MAX {
            break;
        }
    }
    Ok(out)
}

fn project_name(conn: &Connection, id: &str) -> AppResult<String> {
    let name: Option<String> = conn
        .query_row("SELECT name FROM board_projects WHERE id = ?1", [id], |r| {
            r.get(0)
        })
        .optional()?;
    Ok(name.unwrap_or_else(|| "Proyek".to_owned()))
}

/// The "Departemen saya" tab for department `team` (none: this person's
/// own department when allowed, else the first one it may open). `None`
/// unless `me` is a superadmin (any live department), an admin of the
/// department or a head of one of its divisions. `online` tells whether a
/// key is connected now.
pub fn dept_overview(
    conn: &Connection,
    state: &OrgState,
    me: &str,
    team: Option<&str>,
    online: &dyn Fn(&str) -> bool,
) -> AppResult<Option<DeptOverviewData>> {
    let choices = dept_choices(state, me);
    let allowed = |id: &str| choices.iter().any(|c| c.id == id);
    let team_id = match team {
        Some(id) if allowed(id) => id.to_owned(),
        Some(_) => return Ok(None),
        None => match state.department_of(me).filter(|(t, _)| allowed(&t.id)) {
            Some((t, _)) => t.id.clone(),
            None => match choices.first() {
                Some(c) => c.id.clone(),
                None => return Ok(None),
            },
        },
    };
    let Some(t) = state.live_team(&team_id) else {
        return Ok(None);
    };

    let mut members: Vec<DeptMemberData> = t
        .members
        .iter()
        .filter(|(pk, _)| state.is_active(pk))
        .map(|(pk, tm)| {
            let mut divisions: Vec<MemberDivisionData> = state
                .divisions_of(pk)
                .into_iter()
                .filter(|(d, _)| d.team == team_id && !d.archived)
                .map(|(d, role)| MemberDivisionData {
                    id: d.id.clone(),
                    name: d.name.clone(),
                    role,
                })
                .collect();
            sort_by_name(&mut divisions, |d| (&d.name, &d.id));
            DeptMemberData {
                public_key: pk.clone(),
                display_name: name_of(state, pk),
                fingerprint: identity::fingerprint(pk),
                is_superadmin: state.is_superadmin(pk),
                is_admin: tm.role == TeamRole::Admin,
                is_me: pk == me,
                online: pk == me || online(pk),
                labels: labels_of(state, pk),
                divisions,
                app_version: state
                    .member(pk)
                    .and_then(|m| m.device.as_ref())
                    .map(|d| d.app_version.clone()),
            }
        })
        .collect();
    sort_by_name(&mut members, |m| (&m.display_name, &m.public_key));

    let mut divisions: Vec<DivisionViewData> = state
        .divisions
        .values()
        .filter(|d| d.team == team_id && !d.deleted)
        .map(|d| {
            let mut people: Vec<DivisionMemberData> = state
                .division_people(&d.id)
                .into_iter()
                .map(|(pk, role)| DivisionMemberData {
                    public_key: pk.to_owned(),
                    display_name: name_of(state, pk),
                    role,
                })
                .collect();
            sort_by_name(&mut people, |p| (&p.display_name, &p.public_key));
            people.sort_by_key(|p| p.role);
            DivisionViewData {
                id: d.id.clone(),
                name: d.name.clone(),
                archived: d.archived,
                created_at: d.created_at.clone(),
                members: people,
                can_manage: state.may_manage_division(me, &d.id),
                can_edit_members: state.may_edit_division_members(me, &d.id),
                conv: format!("ch:{}", d.id),
                settings: chat_settings_data(state, &team_id, Some(&d.id)),
            }
        })
        .collect();
    sort_by_name(&mut divisions, |d| (&d.name, &d.id));
    divisions.sort_by_key(|d| d.archived);

    let mut projects = Vec::new();
    for p in state
        .projects
        .values()
        .filter(|p| p.team.as_deref() == Some(team_id.as_str()))
    {
        let mut people: Vec<PersonRef> = p
            .members
            .keys()
            .filter(|pk| state.is_active(pk))
            .map(|pk| PersonRef {
                public_key: pk.clone(),
                display_name: name_of(state, pk),
            })
            .collect();
        sort_by_name(&mut people, |r| (&r.display_name, &r.public_key));
        projects.push(DeptProjectData {
            id: p.id.clone(),
            name: project_name(conn, &p.id)?,
            division_id: p.division.clone(),
            division_name: p
                .division
                .as_deref()
                .and_then(|id| state.divisions.get(id))
                .map(|d| d.name.clone()),
            members: people,
        });
    }
    sort_by_name(&mut projects, |p| (&p.name, &p.id));

    let channel = state.department_channel(&team_id);
    let channel = DeptChannelData {
        conv: channel.map_or_else(String::new, |c| format!("ch:{}", c.id)),
        name: channel.map_or_else(|| channel_name_for(&t.name), |c| c.name.clone()),
        settings: chat_settings_data(state, &team_id, None),
    };

    let mut head_of = heads_in(state, me, &team_id);
    head_of.sort();
    let gate = GateData {
        open: division_gate_open(state),
        since: DIVISION_SINCE.to_owned(),
        blockers: division_blockers(state)
            .into_iter()
            .map(|b| GateBlockerData {
                public_key: b.member,
                name: b.name,
                app_version: b.app_version,
            })
            .collect(),
    };
    Ok(Some(DeptOverviewData {
        team_id: team_id.clone(),
        team_name: t.name.clone(),
        archived: t.archived,
        me: DeptMeData {
            public_key: me.to_owned(),
            is_superadmin: state.is_superadmin(me),
            is_admin: state.team_role(&team_id, me) == Some(TeamRole::Admin),
            head_of,
        },
        can_manage_dept: state.is_team_manager(me, &team_id),
        choices,
        members,
        divisions,
        projects,
        channel,
        admin_history: admin_history(conn, state, &team_id)?,
        gate,
    }))
}

/// Divisions for the "Proyek baru" dialog: those `me` counts in plus those
/// it may manage, archived ones included (flagged), deleted ones left out.
pub fn my_divisions(state: &OrgState, me: &str) -> Vec<DivisionRefData> {
    let mut out: Vec<DivisionRefData> = state
        .divisions
        .values()
        .filter(|d| state.live_division(&d.id).is_some())
        .filter(|d| {
            state.division_role(&d.id, me).is_some() || state.may_manage_division(me, &d.id)
        })
        .map(|d| DivisionRefData {
            id: d.id.clone(),
            name: d.name.clone(),
            team_id: d.team.clone(),
            team_name: state
                .teams
                .get(&d.team)
                .map(|t| t.name.clone())
                .unwrap_or_default(),
            archived: d.archived,
            role: state.division_role(&d.id, me),
        })
        .collect();
    sort_by_name(&mut out, |d| (&d.name, &d.id));
    out.sort_by_key(|a| a.team_name.to_lowercase());
    out
}

/// Active (not archived) divisions `pk` counts in, by name, for
/// `PersonView`.
pub(super) fn person_divisions(state: &OrgState, pk: &str) -> Vec<DivisionRefLite> {
    let mut out: Vec<DivisionRefLite> = state
        .divisions_of(pk)
        .into_iter()
        .filter(|(d, _)| !d.archived)
        .map(|(d, _)| DivisionRefLite {
            id: d.id.clone(),
            name: d.name.clone(),
        })
        .collect();
    sort_by_name(&mut out, |d| (&d.name, &d.id));
    out
}

/// What a chat conversation id points at: `ch:<live division>` is that
/// division's chat, `ch:<department channel>` the channel of its live
/// department. Anything else has no settings.
pub fn conversation_target(state: &OrgState, conv: &str) -> Option<(String, Option<String>)> {
    let id = conv.strip_prefix("ch:")?;
    if let Some(d) = state.live_division(id) {
        return Some((d.team.clone(), Some(d.id.clone())));
    }
    let team = state.channels.get(id)?.team.as_deref()?;
    state.live_team(team)?;
    let first = state.department_channel(team)?;
    (first.id == id).then(|| (team.to_owned(), None))
}

/// The chat banner of `conv` for `me`; `None` for conversations without
/// settings.
pub fn conversation_settings(
    state: &OrgState,
    me: &str,
    conv: &str,
) -> Option<ConversationSettingsData> {
    let (team, division) = conversation_target(state, conv)?;
    Some(conversation_settings_for(
        state,
        me,
        &team,
        division.as_deref(),
    ))
}

/// Pinned note, announcement mode and what `me` may do in the department
/// channel of `team` (`division` none) or in a division chat.
pub fn conversation_settings_for(
    state: &OrgState,
    me: &str,
    team: &str,
    division: Option<&str>,
) -> ConversationSettingsData {
    let (pinned, announce) = state
        .chat_settings_for(team, division)
        .map_or((String::new(), false), |c| (c.pinned.clone(), c.announce));
    let manager = match division {
        None => state.is_team_manager(me, team),
        Some(id) => state.may_edit_division_members(me, id),
    };
    let archived = division.is_some_and(|id| state.live_division(id).is_none_or(|d| d.archived));
    ConversationSettingsData {
        pinned,
        announce,
        can_write: !archived && (!announce || manager),
        can_edit: state.may_edit_chat_settings(me, team, division),
        team_id: team.to_owned(),
        division_id: division.map(str::to_owned),
    }
}
