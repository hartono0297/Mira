//! The fold: membership state computed from the genesis record plus every
//! stored op, applied in `(lamport, author, id)` order (plan 1.2, 1.3).
//!
//! Pure and deterministic: laptops holding the same set of ops compute the
//! same state and the same applied/rejected outcome for every op.

use std::collections::{BTreeMap, BTreeSet};

use ed25519_dalek::{Signature, VerifyingKey};
use hex::FromHex;
use serde::Serialize;
use time::OffsetDateTime;

use super::format::{format_time, parse_time};
use super::invite::redeem_message;
use super::op::{Body, CLOCK_SLACK, InviteRole, Scope, VerifiedOp};
use crate::org::{Organization, Role};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemberStatus {
    Active,
    Removed,
}

impl MemberStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            MemberStatus::Active => "active",
            MemberStatus::Removed => "removed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemberKind {
    Member,
    Guest,
}

impl MemberKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MemberKind::Member => "member",
            MemberKind::Guest => "guest",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamRole {
    Admin,
    Member,
}

impl TeamRole {
    pub fn as_str(self) -> &'static str {
        match self {
            TeamRole::Admin => "admin",
            TeamRole::Member => "member",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberState {
    pub public_key: String,
    /// From the latest `profile_set` or the accepted invite; `None` for a
    /// Tahap 0 founder whose profile op has not arrived yet.
    pub display_name: Option<String>,
    pub status: MemberStatus,
    pub kind: MemberKind,
    pub is_superadmin: bool,
    pub joined_at: String,
    pub removed_at: Option<String>,
    /// Id of the `member_remove` op.
    pub removal_op: Option<String>,
    pub has_profile: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeamMember {
    pub role: TeamRole,
    pub added_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeamState {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub created_by: String,
    pub deleted: bool,
    pub members: BTreeMap<String, TeamMember>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteState {
    pub id: String,
    pub team: String,
    pub role: InviteRole,
    pub projects: Vec<String>,
    pub expires_at: String,
    pub expires: OffsetDateTime,
    pub single_use: bool,
    pub tag: String,
    /// Public invite key, 64 hex.
    pub key: String,
    pub created_by: String,
    pub created_at: String,
    pub created: OffsetDateTime,
    pub revoked: bool,
    /// Members admitted by a valid `invite_accept`, in fold order.
    pub used_by: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelState {
    pub id: String,
    /// `None` for `#umum`.
    pub team: Option<String>,
    pub name: String,
    pub created_at: String,
    pub created_by: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct GuestAccess {
    pub public_key: String,
    pub team: String,
    pub project: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrgState {
    pub org: Organization,
    /// Everyone who ever was a member, active or removed.
    pub members: BTreeMap<String, MemberState>,
    /// Including deleted teams (their members are cleared).
    pub teams: BTreeMap<String, TeamState>,
    pub invites: BTreeMap<String, InviteState>,
    pub guest_access: BTreeSet<GuestAccess>,
    /// `#umum` plus channels of live teams.
    pub channels: BTreeMap<String, ChannelState>,
    /// Ids of every team or channel ever created, so ids are never reused.
    pub used_ids: BTreeSet<String>,
}

/// Why the fold rejected an op. `code` is stored in `org_ops.reject_reason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    AuthorNotActive,
    NotAuthorized,
    GuestNotAllowed,
    IdInUse,
    TeamNotFound,
    TargetNotActive,
    TargetIsGuest,
    AlreadySuperadmin,
    NotSuperadmin,
    LastSuperadmin,
    AlreadyTeamAdmin,
    NotTeamAdmin,
    AlreadyInTeam,
    NotInTeam,
    InviteNotFound,
    InviteRevoked,
    InviteExpired,
    InviteNotYetValid,
    InviteUsed,
    InviterNotAuthorized,
    BadInviteSignature,
    BadMemberSignature,
    MemberRemoved,
}

impl Reason {
    pub fn code(self) -> &'static str {
        match self {
            Reason::AuthorNotActive => "author_not_active",
            Reason::NotAuthorized => "not_authorized",
            Reason::GuestNotAllowed => "guest_not_allowed",
            Reason::IdInUse => "id_in_use",
            Reason::TeamNotFound => "team_not_found",
            Reason::TargetNotActive => "target_not_active",
            Reason::TargetIsGuest => "target_is_guest",
            Reason::AlreadySuperadmin => "already_superadmin",
            Reason::NotSuperadmin => "not_superadmin",
            Reason::LastSuperadmin => "last_superadmin",
            Reason::AlreadyTeamAdmin => "already_team_admin",
            Reason::NotTeamAdmin => "not_team_admin",
            Reason::AlreadyInTeam => "already_in_team",
            Reason::NotInTeam => "not_in_team",
            Reason::InviteNotFound => "invite_not_found",
            Reason::InviteRevoked => "invite_revoked",
            Reason::InviteExpired => "invite_expired",
            Reason::InviteNotYetValid => "invite_not_yet_valid",
            Reason::InviteUsed => "invite_used",
            Reason::InviterNotAuthorized => "inviter_not_authorized",
            Reason::BadInviteSignature => "bad_invite_signature",
            Reason::BadMemberSignature => "bad_member_signature",
            Reason::MemberRemoved => "member_removed",
        }
    }

    /// Indonesian text for the person who tried the change.
    pub fn message(self) -> &'static str {
        match self {
            Reason::AuthorNotActive => "Pembuat perubahan bukan anggota aktif organisasi.",
            Reason::NotAuthorized => "Anda tidak berhak melakukan perubahan ini.",
            Reason::GuestNotAllowed => "Tamu tidak bisa melakukan perubahan ini.",
            Reason::IdInUse => "Id ini sudah pernah dipakai.",
            Reason::TeamNotFound => "Tim tidak ditemukan atau sudah dihapus.",
            Reason::TargetNotActive => "Orang itu bukan anggota aktif organisasi.",
            Reason::TargetIsGuest => "Tamu tidak bisa diberi peran ini.",
            Reason::AlreadySuperadmin => "Orang itu sudah superadmin.",
            Reason::NotSuperadmin => "Orang itu bukan superadmin.",
            Reason::LastSuperadmin => {
                "Organisasi harus punya minimal satu superadmin. Angkat superadmin lain dulu."
            }
            Reason::AlreadyTeamAdmin => "Orang itu sudah admin tim ini.",
            Reason::NotTeamAdmin => "Orang itu bukan admin tim ini.",
            Reason::AlreadyInTeam => "Orang itu sudah ada di tim ini.",
            Reason::NotInTeam => "Orang itu tidak ada di tim ini.",
            Reason::InviteNotFound => "Undangan tidak ditemukan.",
            Reason::InviteRevoked => "Undangan sudah dicabut.",
            Reason::InviteExpired => "Undangan sudah kedaluwarsa.",
            Reason::InviteNotYetValid => {
                "Undangan belum berlaku menurut jam laptop ini. Periksa jam laptop."
            }
            Reason::InviteUsed => "Undangan sekali pakai ini sudah dipakai.",
            Reason::InviterNotAuthorized => {
                "Pembuat undangan sudah tidak berhak mengundang ke tim ini."
            }
            Reason::BadInviteSignature => "Bukti kode undangan tidak sah.",
            Reason::BadMemberSignature => "Tanda tangan laptop yang bergabung tidak sah.",
            Reason::MemberRemoved => "Laptop itu sudah dikeluarkan dari organisasi.",
        }
    }

    pub fn parse(code: &str) -> Option<Reason> {
        ALL_REASONS.iter().copied().find(|r| r.code() == code)
    }
}

const ALL_REASONS: [Reason; 23] = [
    Reason::AuthorNotActive,
    Reason::NotAuthorized,
    Reason::GuestNotAllowed,
    Reason::IdInUse,
    Reason::TeamNotFound,
    Reason::TargetNotActive,
    Reason::TargetIsGuest,
    Reason::AlreadySuperadmin,
    Reason::NotSuperadmin,
    Reason::LastSuperadmin,
    Reason::AlreadyTeamAdmin,
    Reason::NotTeamAdmin,
    Reason::AlreadyInTeam,
    Reason::NotInTeam,
    Reason::InviteNotFound,
    Reason::InviteRevoked,
    Reason::InviteExpired,
    Reason::InviteNotYetValid,
    Reason::InviteUsed,
    Reason::InviterNotAuthorized,
    Reason::BadInviteSignature,
    Reason::BadMemberSignature,
    Reason::MemberRemoved,
];

pub type Outcome = Result<(), Reason>;

#[derive(Debug, Clone)]
pub struct FoldResult {
    pub state: OrgState,
    /// `(op id, outcome)` in fold order.
    pub outcomes: Vec<(String, Outcome)>,
}

/// `#umum` channel id: first 32 hex of `blake3("mira-channel-umum-v1\n" + org_id)`.
pub fn umum_channel_id(org_id: &str) -> String {
    let hash = blake3::hash(format!("mira-channel-umum-v1\n{org_id}").as_bytes());
    hash.to_hex()[..32].to_owned()
}

pub const UMUM_CHANNEL_NAME: &str = "umum";

/// Sorts the ops into fold order and applies them to the genesis state.
pub fn fold(org: &Organization, ops: &[VerifiedOp]) -> FoldResult {
    let mut sorted: Vec<&VerifiedOp> = ops.iter().collect();
    sorted.sort_by(|a, b| a.order_key().cmp(&b.order_key()));
    sorted.dedup_by(|a, b| a.id == b.id);
    let mut state = OrgState::genesis(org);
    let outcomes = sorted
        .into_iter()
        .map(|op| (op.id.clone(), state.apply(op)))
        .collect();
    FoldResult { state, outcomes }
}

fn verify_sig(public_key: &str, message: &[u8], sig: &str) -> bool {
    let (Ok(pk), Ok(sig)) = (<[u8; 32]>::from_hex(public_key), <[u8; 64]>::from_hex(sig)) else {
        return false;
    };
    VerifyingKey::from_bytes(&pk).is_ok_and(|k| {
        k.verify_strict(message, &Signature::from_bytes(&sig))
            .is_ok()
    })
}

impl OrgState {
    /// Founder is the first superadmin and an active member; `#umum` exists.
    pub fn genesis(org: &Organization) -> OrgState {
        let founder = MemberState {
            public_key: org.founder_public_key.clone(),
            display_name: None,
            status: MemberStatus::Active,
            kind: MemberKind::Member,
            is_superadmin: true,
            joined_at: org.created_at.clone(),
            removed_at: None,
            removal_op: None,
            has_profile: false,
        };
        let umum = ChannelState {
            id: umum_channel_id(&org.id),
            team: None,
            name: UMUM_CHANNEL_NAME.to_owned(),
            created_at: org.created_at.clone(),
            created_by: None,
        };
        OrgState {
            org: org.clone(),
            members: BTreeMap::from([(founder.public_key.clone(), founder)]),
            teams: BTreeMap::new(),
            invites: BTreeMap::new(),
            guest_access: BTreeSet::new(),
            used_ids: BTreeSet::from([umum.id.clone()]),
            channels: BTreeMap::from([(umum.id.clone(), umum)]),
        }
    }

    pub fn member(&self, pk: &str) -> Option<&MemberState> {
        self.members.get(pk)
    }

    pub fn is_active(&self, pk: &str) -> bool {
        self.member(pk)
            .is_some_and(|m| m.status == MemberStatus::Active)
    }

    pub fn is_superadmin(&self, pk: &str) -> bool {
        self.member(pk)
            .is_some_and(|m| m.status == MemberStatus::Active && m.is_superadmin)
    }

    fn is_active_non_guest(&self, pk: &str) -> bool {
        self.member(pk)
            .is_some_and(|m| m.status == MemberStatus::Active && m.kind == MemberKind::Member)
    }

    pub fn superadmin_count(&self) -> usize {
        self.members
            .values()
            .filter(|m| m.status == MemberStatus::Active && m.is_superadmin)
            .count()
    }

    /// A team that exists and is not deleted.
    pub fn live_team(&self, id: &str) -> Option<&TeamState> {
        self.teams.get(id).filter(|t| !t.deleted)
    }

    pub fn team_role(&self, team: &str, pk: &str) -> Option<TeamRole> {
        self.live_team(team)
            .and_then(|t| t.members.get(pk))
            .map(|m| m.role)
    }

    /// Live teams of a member with their role there.
    pub fn teams_of(&self, pk: &str) -> Vec<(&TeamState, TeamRole)> {
        self.teams
            .values()
            .filter(|t| !t.deleted)
            .filter_map(|t| t.members.get(pk).map(|m| (t, m.role)))
            .collect()
    }

    /// Role shown per person (`orgRole`).
    pub fn org_role(&self, pk: &str) -> Role {
        let Some(m) = self.member(pk) else {
            return Role::Member;
        };
        if m.status == MemberStatus::Active && m.is_superadmin {
            Role::Superadmin
        } else if self
            .teams_of(pk)
            .iter()
            .any(|(_, role)| *role == TeamRole::Admin)
        {
            Role::TeamAdmin
        } else if m.kind == MemberKind::Guest {
            Role::Guest
        } else {
            Role::Member
        }
    }

    /// Whether `creator` may create an invite with this team and role now.
    pub fn may_invite(&self, creator: &str, team: &str, role: InviteRole) -> bool {
        if self.live_team(team).is_none() || !self.is_active(creator) {
            return false;
        }
        self.is_superadmin(creator)
            || (self.team_role(team, creator) == Some(TeamRole::Admin)
                && matches!(role, InviteRole::Member | InviteRole::Guest))
    }

    /// Whether the invite can still admit someone at time `at` (not
    /// counting signatures). Checked in this order: revoked or dead team or
    /// creator without authority, used, expired, not yet valid.
    pub fn invite_usable(&self, invite: &InviteState, at: OffsetDateTime) -> Result<(), Reason> {
        if invite.revoked {
            return Err(Reason::InviteRevoked);
        }
        if self.live_team(&invite.team).is_none() {
            return Err(Reason::TeamNotFound);
        }
        if !self.may_invite(&invite.created_by, &invite.team, invite.role) {
            return Err(Reason::InviterNotAuthorized);
        }
        if invite.single_use && !invite.used_by.is_empty() {
            return Err(Reason::InviteUsed);
        }
        if at > invite.expires {
            return Err(Reason::InviteExpired);
        }
        if at < invite.created - CLOCK_SLACK {
            return Err(Reason::InviteNotYetValid);
        }
        Ok(())
    }

    /// Whether this laptop's member may author an `invite_accept`.
    pub fn may_check_codes(&self, pk: &str) -> bool {
        self.is_active_non_guest(pk)
    }

    fn require_superadmin(&self, author: &str) -> Result<(), Reason> {
        if self.is_superadmin(author) {
            Ok(())
        } else {
            Err(Reason::NotAuthorized)
        }
    }

    fn require_active_non_guest_target(&self, pk: &str) -> Result<(), Reason> {
        match self.member(pk) {
            Some(m) if m.status == MemberStatus::Active => {
                if m.kind == MemberKind::Guest {
                    Err(Reason::TargetIsGuest)
                } else {
                    Ok(())
                }
            }
            _ => Err(Reason::TargetNotActive),
        }
    }

    fn live_team_mut(&mut self, id: &str) -> Result<&mut TeamState, Reason> {
        self.teams
            .get_mut(id)
            .filter(|t| !t.deleted)
            .ok_or(Reason::TeamNotFound)
    }

    /// Applies one op on top of the current state. On `Err` nothing changed.
    pub fn apply(&mut self, op: &VerifiedOp) -> Outcome {
        let author = op.author().to_owned();
        let at = op.payload.at.clone();
        if !self.is_active(&author) {
            return Err(Reason::AuthorNotActive);
        }

        match &op.payload.body {
            Body::ProfileSet { name } => {
                let m = self
                    .members
                    .get_mut(&author)
                    .ok_or(Reason::AuthorNotActive)?;
                m.display_name = Some(name.clone());
                m.has_profile = true;
            }
            Body::TeamCreate { team, name } => {
                self.require_superadmin(&author)?;
                if self.used_ids.contains(team) {
                    return Err(Reason::IdInUse);
                }
                self.used_ids.insert(team.clone());
                self.teams.insert(
                    team.clone(),
                    TeamState {
                        id: team.clone(),
                        name: name.clone(),
                        created_at: at,
                        created_by: author,
                        deleted: false,
                        members: BTreeMap::new(),
                    },
                );
            }
            Body::TeamDelete { team } => {
                self.require_superadmin(&author)?;
                let t = self.live_team_mut(team)?;
                t.deleted = true;
                t.members.clear();
                self.channels.retain(|_, c| c.team.as_deref() != Some(team));
                self.guest_access.retain(|g| &g.team != team);
            }
            Body::SuperadminAdd { member } => {
                self.require_superadmin(&author)?;
                self.require_active_non_guest_target(member)?;
                let m = self
                    .members
                    .get_mut(member)
                    .ok_or(Reason::TargetNotActive)?;
                if m.is_superadmin {
                    return Err(Reason::AlreadySuperadmin);
                }
                m.is_superadmin = true;
            }
            Body::SuperadminRemove { member } => {
                self.require_superadmin(&author)?;
                if !self.is_superadmin(member) {
                    return Err(Reason::NotSuperadmin);
                }
                if self.superadmin_count() <= 1 {
                    return Err(Reason::LastSuperadmin);
                }
                if let Some(m) = self.members.get_mut(member) {
                    m.is_superadmin = false;
                }
            }
            Body::TeamAdminSet { team, member } => {
                self.require_superadmin(&author)?;
                if self.live_team(team).is_none() {
                    return Err(Reason::TeamNotFound);
                }
                self.require_active_non_guest_target(member)?;
                let t = self.live_team_mut(team)?;
                match t.members.get_mut(member) {
                    Some(tm) if tm.role == TeamRole::Admin => return Err(Reason::AlreadyTeamAdmin),
                    Some(tm) => tm.role = TeamRole::Admin,
                    None => {
                        t.members.insert(
                            member.clone(),
                            TeamMember {
                                role: TeamRole::Admin,
                                added_at: at,
                            },
                        );
                    }
                }
            }
            Body::TeamAdminUnset { team, member } => {
                self.require_superadmin(&author)?;
                let t = self.live_team_mut(team)?;
                match t.members.get_mut(member) {
                    Some(tm) if tm.role == TeamRole::Admin => tm.role = TeamRole::Member,
                    _ => return Err(Reason::NotTeamAdmin),
                }
            }
            Body::TeamMemberAdd { team, member } => {
                if self.live_team(team).is_none() {
                    return Err(Reason::TeamNotFound);
                }
                if !self.is_superadmin(&author)
                    && self.team_role(team, &author) != Some(TeamRole::Admin)
                {
                    return Err(Reason::NotAuthorized);
                }
                self.require_active_non_guest_target(member)?;
                let t = self.live_team_mut(team)?;
                if t.members.contains_key(member) {
                    return Err(Reason::AlreadyInTeam);
                }
                t.members.insert(
                    member.clone(),
                    TeamMember {
                        role: TeamRole::Member,
                        added_at: at,
                    },
                );
            }
            Body::TeamMemberRemove { team, member } => {
                if self.live_team(team).is_none() {
                    return Err(Reason::TeamNotFound);
                }
                let Some(target_role) = self.team_role(team, member) else {
                    return Err(Reason::NotInTeam);
                };
                let allowed = self.is_superadmin(&author)
                    || &author == member
                    || (self.team_role(team, &author) == Some(TeamRole::Admin)
                        && target_role != TeamRole::Admin);
                if !allowed {
                    return Err(Reason::NotAuthorized);
                }
                self.live_team_mut(team)?.members.remove(member);
            }
            Body::MemberRemove { member } => {
                self.require_superadmin(&author)?;
                if !self.is_active(member) {
                    return Err(Reason::TargetNotActive);
                }
                if self.is_superadmin(member) && self.superadmin_count() <= 1 {
                    return Err(Reason::LastSuperadmin);
                }
                for t in self.teams.values_mut() {
                    t.members.remove(member);
                }
                self.guest_access.retain(|g| &g.public_key != member);
                if let Some(m) = self.members.get_mut(member) {
                    m.status = MemberStatus::Removed;
                    m.is_superadmin = false;
                    m.removed_at = Some(at);
                    m.removal_op = Some(op.id.clone());
                }
            }
            Body::InviteCreate {
                invite,
                team,
                role,
                projects,
                expires,
                single_use,
                tag,
                key,
            } => {
                if self.live_team(team).is_none() {
                    return Err(Reason::TeamNotFound);
                }
                if !self.may_invite(&author, team, *role) {
                    return Err(Reason::NotAuthorized);
                }
                if self.invites.contains_key(invite) {
                    return Err(Reason::IdInUse);
                }
                let (Some(exp), Some(created)) = (parse_time(expires), parse_time(&at)) else {
                    return Err(Reason::NotAuthorized);
                };
                self.invites.insert(
                    invite.clone(),
                    InviteState {
                        id: invite.clone(),
                        team: team.clone(),
                        role: *role,
                        projects: projects.clone(),
                        expires_at: format_time(exp),
                        expires: exp,
                        single_use: *single_use,
                        tag: tag.clone(),
                        key: key.clone(),
                        created_by: author,
                        created_at: at,
                        created,
                        revoked: false,
                        used_by: Vec::new(),
                    },
                );
            }
            Body::InviteRevoke { invite } => {
                let inv = self.invites.get(invite).ok_or(Reason::InviteNotFound)?;
                let allowed = self.is_superadmin(&author)
                    || inv.created_by == author
                    || self.team_role(&inv.team, &author) == Some(TeamRole::Admin);
                if !allowed {
                    return Err(Reason::NotAuthorized);
                }
                if inv.revoked {
                    return Err(Reason::InviteRevoked);
                }
                if let Some(inv) = self.invites.get_mut(invite) {
                    inv.revoked = true;
                }
            }
            Body::InviteAccept {
                invite,
                member,
                name,
                invite_sig,
                member_sig,
            } => {
                if !self.is_active_non_guest(&author) {
                    return Err(Reason::GuestNotAllowed);
                }
                let inv = self.invites.get(invite).ok_or(Reason::InviteNotFound)?;
                self.invite_usable(inv, op.at)?;
                let msg = redeem_message(&self.org.id, invite, member, name);
                if !verify_sig(&inv.key, &msg, invite_sig) {
                    return Err(Reason::BadInviteSignature);
                }
                if !verify_sig(member, &msg, member_sig) {
                    return Err(Reason::BadMemberSignature);
                }
                if self
                    .member(member)
                    .is_some_and(|m| m.status == MemberStatus::Removed)
                {
                    return Err(Reason::MemberRemoved);
                }
                let inv = inv.clone();
                self.admit(&inv, member, name, &at);
                if let Some(i) = self.invites.get_mut(invite) {
                    i.used_by.push(member.clone());
                }
            }
            Body::ChannelCreate {
                channel,
                team,
                name,
            } => {
                debug_assert_eq!(op.payload.scope, Scope::Team { team: team.clone() });
                if self.live_team(team).is_none() {
                    return Err(Reason::TeamNotFound);
                }
                if !self.is_superadmin(&author) && self.team_role(team, &author).is_none() {
                    return Err(Reason::NotAuthorized);
                }
                if self.used_ids.contains(channel) {
                    return Err(Reason::IdInUse);
                }
                self.used_ids.insert(channel.clone());
                self.channels.insert(
                    channel.clone(),
                    ChannelState {
                        id: channel.clone(),
                        team: Some(team.clone()),
                        name: name.clone(),
                        created_at: at,
                        created_by: Some(author),
                    },
                );
            }
        }
        Ok(())
    }

    /// Effect of a valid `invite_accept` (plan 1.3).
    fn admit(&mut self, inv: &InviteState, member: &str, name: &str, at: &str) {
        let guest = inv.role == InviteRole::Guest;
        let existing = self.members.get_mut(member);
        match existing {
            Some(m) => {
                if !guest && m.kind == MemberKind::Guest {
                    m.kind = MemberKind::Member;
                }
            }
            None => {
                self.members.insert(
                    member.to_owned(),
                    MemberState {
                        public_key: member.to_owned(),
                        display_name: Some(name.to_owned()),
                        status: MemberStatus::Active,
                        kind: if guest {
                            MemberKind::Guest
                        } else {
                            MemberKind::Member
                        },
                        is_superadmin: false,
                        joined_at: at.to_owned(),
                        removed_at: None,
                        removal_op: None,
                        has_profile: false,
                    },
                );
            }
        }
        if guest {
            for project in &inv.projects {
                self.guest_access.insert(GuestAccess {
                    public_key: member.to_owned(),
                    team: inv.team.clone(),
                    project: project.clone(),
                });
            }
            return;
        }
        let role = if inv.role == InviteRole::TeamAdmin {
            TeamRole::Admin
        } else {
            TeamRole::Member
        };
        if let Some(t) = self.teams.get_mut(&inv.team) {
            match t.members.get_mut(member) {
                Some(tm) => tm.role = tm.role.min(role),
                None => {
                    t.members.insert(
                        member.to_owned(),
                        TeamMember {
                            role,
                            added_at: at.to_owned(),
                        },
                    );
                }
            }
        }
    }

    /// Whether accepting `inv` would change anything for an existing member.
    pub fn accept_changes_anything(&self, inv: &InviteState, member: &str) -> bool {
        let Some(m) = self.member(member) else {
            return true;
        };
        match inv.role {
            InviteRole::Guest => inv.projects.iter().any(|p| {
                !self.guest_access.contains(&GuestAccess {
                    public_key: member.to_owned(),
                    team: inv.team.clone(),
                    project: p.clone(),
                })
            }),
            InviteRole::Member => {
                m.kind == MemberKind::Guest || self.team_role(&inv.team, member).is_none()
            }
            InviteRole::TeamAdmin => {
                m.kind == MemberKind::Guest
                    || self.team_role(&inv.team, member) != Some(TeamRole::Admin)
            }
        }
    }
}
