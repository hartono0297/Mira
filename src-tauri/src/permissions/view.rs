//! What the frontend sees (plan section 4): `Directory` and its parts.

use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};

use super::fold::{InviteState, MemberStatus, OrgState, TeamRole, TeamState};
use super::op::{CLOCK_SLACK, InviteRole};
use super::store::{display_name_for, load_state, require_org};
use crate::error::AppResult;
use crate::identity::{self, Identity};
use crate::org::{OrgInfo, Role};

/// Invite validity choices: "24h", "7d" (reusable) and "once" (one person,
/// valid up to 7 days).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Validity {
    #[serde(rename = "24h")]
    H24,
    #[serde(rename = "7d")]
    D7,
    #[serde(rename = "once")]
    Once,
}

impl Validity {
    pub fn parse(s: &str) -> Option<Validity> {
        match s {
            "24h" => Some(Validity::H24),
            "7d" => Some(Validity::D7),
            "once" => Some(Validity::Once),
            _ => None,
        }
    }

    pub fn duration(self) -> Duration {
        match self {
            Validity::H24 => Duration::hours(24),
            Validity::D7 | Validity::Once => Duration::days(7),
        }
    }

    pub fn single_use(self) -> bool {
        self == Validity::Once
    }

    /// Recovers the choice from a stored invite.
    pub fn of(invite: &InviteState) -> Validity {
        if invite.single_use {
            Validity::Once
        } else if invite.expires - invite.created <= Duration::hours(24) + CLOCK_SLACK {
            Validity::H24
        } else {
            Validity::D7
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InviteStatus {
    Active,
    Used,
    Expired,
    Revoked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Directory {
    pub org: OrgInfo,
    pub me: MeView,
    pub superadmin_count: usize,
    pub can: CanView,
    pub members: Vec<MemberView>,
    pub teams: Vec<TeamView>,
    pub invites: Vec<InviteView>,
    pub channels: Vec<ChannelView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeView {
    pub public_key: String,
    pub is_superadmin: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanView {
    pub create_team: bool,
    pub manage_superadmins: bool,
    pub remove_members: bool,
    pub manage_team_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberView {
    pub public_key: String,
    pub fingerprint: String,
    pub display_name: String,
    pub org_role: Role,
    pub is_superadmin: bool,
    pub status: MemberStatus,
    pub joined_at: String,
    pub teams: Vec<MemberTeamView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberTeamView {
    pub team_id: String,
    pub role: TeamRole,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamView {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub members: Vec<TeamMemberView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMemberView {
    pub public_key: String,
    pub role: TeamRole,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteView {
    pub id: String,
    pub team_id: String,
    pub team_name: String,
    pub role: InviteRole,
    pub project_ids: Vec<String>,
    pub validity: Validity,
    pub expires_at: String,
    pub created_by: String,
    pub created_at: String,
    pub status: InviteStatus,
    pub used_by: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelView {
    pub id: String,
    pub name: String,
    pub team_id: Option<String>,
}

pub fn team_view(team: &TeamState) -> TeamView {
    TeamView {
        id: team.id.clone(),
        name: team.name.clone(),
        created_at: team.created_at.clone(),
        members: team
            .members
            .iter()
            .map(|(pk, m)| TeamMemberView {
                public_key: pk.clone(),
                role: m.role,
            })
            .collect(),
    }
}

/// Status at `now`. An invite whose team is gone or whose creator lost the
/// right to make it can never be used again, so it shows as revoked.
pub fn invite_status(state: &OrgState, invite: &InviteState, now: OffsetDateTime) -> InviteStatus {
    if invite.revoked
        || state.live_team(&invite.team).is_none()
        || !state.may_invite(&invite.created_by, &invite.team, invite.role)
    {
        InviteStatus::Revoked
    } else if invite.single_use && !invite.used_by.is_empty() {
        InviteStatus::Used
    } else if now > invite.expires {
        InviteStatus::Expired
    } else {
        InviteStatus::Active
    }
}

pub fn invite_view(state: &OrgState, invite: &InviteState, now: OffsetDateTime) -> InviteView {
    InviteView {
        id: invite.id.clone(),
        team_id: invite.team.clone(),
        team_name: state
            .teams
            .get(&invite.team)
            .map(|t| t.name.clone())
            .unwrap_or_default(),
        role: invite.role,
        project_ids: invite.projects.clone(),
        validity: Validity::of(invite),
        expires_at: invite.expires_at.clone(),
        created_by: invite.created_by.clone(),
        created_at: invite.created_at.clone(),
        status: invite_status(state, invite, now),
        used_by: invite.used_by.clone(),
    }
}

pub fn org_info(state: &OrgState, pk: &str) -> OrgInfo {
    OrgInfo {
        id: state.org.id.clone(),
        name: state.org.name.clone(),
        role: state.org_role(pk),
        created_at: state.org.created_at.clone(),
    }
}

/// The organization as this laptop may see and manage it.
pub fn directory(
    conn: &rusqlite::Connection,
    identity: &Identity,
    now: OffsetDateTime,
) -> AppResult<Directory> {
    require_org(conn)?;
    let state = load_state(conn)?.ok_or_else(super::store::not_in_org)?;
    Ok(build_directory(
        &state,
        identity.public_key_hex(),
        identity.display_name(),
        now,
    ))
}

pub fn build_directory(
    state: &OrgState,
    me: &str,
    my_name: Option<&str>,
    now: OffsetDateTime,
) -> Directory {
    let active = state.is_active(me);
    let is_superadmin = state.is_superadmin(me);
    let me_ref = Some((me, my_name));

    let manage_team_ids: Vec<String> = if !active {
        Vec::new()
    } else if is_superadmin {
        state
            .teams
            .values()
            .filter(|t| !t.deleted)
            .map(|t| t.id.clone())
            .collect()
    } else {
        state
            .teams_of(me)
            .into_iter()
            .filter(|(_, r)| *r == TeamRole::Admin)
            .map(|(t, _)| t.id.clone())
            .collect()
    };

    let mut members: Vec<MemberView> = state
        .members
        .values()
        .map(|m| MemberView {
            public_key: m.public_key.clone(),
            fingerprint: identity::fingerprint(&m.public_key),
            display_name: display_name_for(state, &m.public_key, me_ref),
            org_role: state.org_role(&m.public_key),
            is_superadmin: m.status == MemberStatus::Active && m.is_superadmin,
            status: m.status,
            joined_at: m.joined_at.clone(),
            teams: state
                .teams_of(&m.public_key)
                .into_iter()
                .map(|(t, role)| MemberTeamView {
                    team_id: t.id.clone(),
                    role,
                })
                .collect(),
        })
        .collect();
    members.sort_by(|a, b| {
        (a.status != MemberStatus::Active)
            .cmp(&(b.status != MemberStatus::Active))
            .then_with(|| {
                a.display_name
                    .to_lowercase()
                    .cmp(&b.display_name.to_lowercase())
            })
            .then_with(|| a.public_key.cmp(&b.public_key))
    });

    let mut teams: Vec<TeamView> = state
        .teams
        .values()
        .filter(|t| !t.deleted)
        .map(team_view)
        .collect();
    teams.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });

    let mut invites: Vec<InviteView> = state
        .invites
        .values()
        .filter(|i| state.live_team(&i.team).is_some())
        .filter(|i| manage_team_ids.contains(&i.team))
        .map(|i| invite_view(state, i, now))
        .collect();
    invites.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });

    let mut channels: Vec<ChannelView> = state
        .channels
        .values()
        .filter(|c| match &c.team {
            None => active,
            Some(team) => {
                active
                    && (state.team_role(team, me).is_some() || c.created_by.as_deref() == Some(me))
            }
        })
        .map(|c| ChannelView {
            id: c.id.clone(),
            name: c.name.clone(),
            team_id: c.team.clone(),
        })
        .collect();
    channels.sort_by(|a, b| {
        a.team_id
            .is_some()
            .cmp(&b.team_id.is_some())
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.id.cmp(&b.id))
    });

    Directory {
        org: org_info(state, me),
        me: MeView {
            public_key: me.to_owned(),
            is_superadmin,
        },
        superadmin_count: state.superadmin_count(),
        can: CanView {
            create_team: is_superadmin,
            manage_superadmins: is_superadmin,
            remove_members: is_superadmin,
            manage_team_ids,
        },
        members,
        teams,
        invites,
        channels,
    }
}
