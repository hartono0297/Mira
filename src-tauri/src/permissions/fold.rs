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

use super::division::{ChatSettingsState, DivisionState};
use super::format::{channel_name_for, format_time, parse_time};
use super::invite::{invite_key_message, redeem_message};
use super::join::{
    JOIN_REQUEST_VALIDITY, SignedJoinRequest, VerifiedJoinRequest, verify_join_request,
};
use super::op::{Body, CLOCK_SLACK, InviteRole, Scope, VerifiedOp};
use crate::ad::OuMapping;
use crate::org::{Organization, Role};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemberStatus {
    Active,
    /// 0.5.1: suspended by `member_suspend`; `member_reinstate` makes the
    /// member active again (same laptop key).
    Suspended,
    Removed,
}

impl MemberStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            MemberStatus::Active => "active",
            MemberStatus::Suspended => "suspended",
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

/// What a laptop says about itself (`device_set`, or the join request it
/// was admitted with).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceInfo {
    pub laptop: String,
    pub os: String,
    pub app_version: String,
    /// `at` of the op that set it.
    pub at: String,
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
    pub device: Option<DeviceInfo>,
    /// 0.5.1: `at` of the `member_suspend` op while suspended.
    pub suspended_at: Option<String>,
    /// Author of the `member_suspend` op while suspended.
    pub suspended_by: Option<String>,
    /// Id of the `member_suspend` op while suspended.
    pub suspension_op: Option<String>,
    /// What `member_reinstate` gives back, while suspended.
    pub snapshot: Option<SuspendSnapshot>,
    /// Ids of further `member_suspend` ops applied while already suspended
    /// (made concurrently with `suspension_op`). A `member_reinstate` must
    /// have seen all of them.
    pub joint_suspensions: Vec<String>,
    /// The suspension in force, or one of the joint ones, was made by a
    /// superadmin. Only a superadmin may then lift it or add to it.
    pub suspended_by_superadmin: bool,
}

/// What a member had when suspended (docs/plans/perbaikan-bergabung.md).
/// `member_reinstate` restores what is still valid then.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SuspendSnapshot {
    /// Department and role in it.
    pub department: Option<(String, TeamRole)>,
    /// v0.6: order key of the op that made the member an admin of
    /// `department`, so a reinstated admin keeps their seniority. Division
    /// memberships are not kept: a reinstated member is added back to
    /// divisions by hand.
    pub appointed: Option<(u64, String, String)>,
    pub superadmin: bool,
    /// Projects the member was an explicit member of.
    pub projects: Vec<String>,
    pub labels: Vec<String>,
    pub guest_access: Vec<GuestAccess>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeamMember {
    pub role: TeamRole,
    pub added_at: String,
    /// Order key `(lamport, author, op id)` of the op that made this person
    /// an admin of the department; `None` while a plain member. A
    /// department admin may demote only admins appointed after them
    /// (v0.6), so two admins can never demote each other.
    pub appointed: Option<(u64, String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeamState {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub created_by: String,
    pub deleted: bool,
    /// Archived departments are empty, read-only and cannot receive anyone.
    pub archived: bool,
    pub archived_at: Option<String>,
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
pub struct ProjectMember {
    pub added_at: String,
    pub added_by: String,
}

/// A board project registered in the log (`project_create`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectState {
    pub id: String,
    /// The project's department, `None` for a project without department.
    pub team: Option<String>,
    /// The project's creator (bound to the id), who manages it while a
    /// project member.
    pub creator: String,
    /// Author of the `project_create` op (the creator, or the superadmin or
    /// department admin who registered a project made before v0.3).
    pub registered_by: String,
    pub created_at: String,
    /// Explicit members (guests included). Guests invited by code are in
    /// `OrgState::guest_access` instead.
    pub members: BTreeMap<String, ProjectMember>,
    /// v0.6: the division the project was made for, in `team`.
    pub division: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LabelState {
    pub id: String,
    pub name: String,
    pub archived: bool,
    pub created_at: String,
    pub members: BTreeSet<String>,
}

/// The decision on one join request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JoinDecision {
    /// Request id (64 hex).
    pub request: String,
    pub member: String,
    pub name: String,
    pub team: String,
    pub approved: bool,
    pub by: String,
    pub at: String,
    /// AD onboarding: `(domain, user)` of the request's AD claim, if any.
    pub ad_account: Option<(String, String)>,
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
    /// Ids of every team, channel or label ever created, so ids are never
    /// reused.
    pub used_ids: BTreeSet<String>,
    /// Registered board projects.
    pub projects: BTreeMap<String, ProjectState>,
    pub labels: BTreeMap<String, LabelState>,
    /// Decided join requests by request id.
    pub join_decisions: BTreeMap<String, JoinDecision>,
    /// Active Directory settings (`ad_settings_set`, the latest wins).
    pub ad: AdSettings,
    /// 0.5.1: a `member_suspend` was applied. From then on a laptop older
    /// than `join::suspend_threshold` must not be admitted (it cannot read
    /// the log).
    pub suspend_used: bool,
    /// v0.6: divisions by id, deleted ones included (`division.rs`).
    pub divisions: BTreeMap<String, DivisionState>,
    /// v0.6: chat settings by `(team, division id or "")`.
    pub chat_settings: BTreeMap<(String, String), ChatSettingsState>,
}

/// The organization's Active Directory settings (docs/plans/onboarding-ad.md).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AdSettings {
    /// Lowercase DNS domain; `None` when not set or cleared.
    pub domain: Option<String>,
    /// OU to department mapping, as the superadmin saved it.
    pub ou_map: Vec<OuMapping>,
    /// An `ad_settings_set` op was applied (even one clearing the domain):
    /// every member's Mira understands the op, and a laptop joining must
    /// too.
    pub set: bool,
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
    BadDeps,
    ConcurrentWithRevocation,
    AlreadyInDepartment,
    DepartmentArchived,
    DepartmentNotEmpty,
    NoChange,
    ProjectNotFound,
    BadProjectId,
    AlreadyInProject,
    NotInProject,
    LabelNotFound,
    LabelArchived,
    BadJoinRequest,
    JoinRequestExpired,
    JoinAlreadyDecided,
    AlreadyMember,
    TargetNotSuspended,
    DivisionNotFound,
    DivisionArchived,
    AlreadyInDivision,
    NotInDivision,
    AlreadyDivisionHead,
    NotDivisionHead,
    TargetNotInDepartment,
    LastTeamAdmin,
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
            Reason::BadDeps => "bad_deps",
            Reason::ConcurrentWithRevocation => "concurrent_with_revocation",
            Reason::AlreadyInDepartment => "already_in_department",
            Reason::DepartmentArchived => "department_archived",
            Reason::DepartmentNotEmpty => "department_not_empty",
            Reason::NoChange => "no_change",
            Reason::ProjectNotFound => "project_not_found",
            Reason::BadProjectId => "bad_project_id",
            Reason::AlreadyInProject => "already_in_project",
            Reason::NotInProject => "not_in_project",
            Reason::LabelNotFound => "label_not_found",
            Reason::LabelArchived => "label_archived",
            Reason::BadJoinRequest => "bad_join_request",
            Reason::JoinRequestExpired => "join_request_expired",
            Reason::JoinAlreadyDecided => "join_already_decided",
            Reason::AlreadyMember => "already_member",
            Reason::TargetNotSuspended => "target_not_suspended",
            Reason::DivisionNotFound => "division_not_found",
            Reason::DivisionArchived => "division_archived",
            Reason::AlreadyInDivision => "already_in_division",
            Reason::NotInDivision => "not_in_division",
            Reason::AlreadyDivisionHead => "already_division_head",
            Reason::NotDivisionHead => "not_division_head",
            Reason::TargetNotInDepartment => "target_not_in_department",
            Reason::LastTeamAdmin => "last_team_admin",
        }
    }

    /// Indonesian text for the person who tried the change.
    pub fn message(self) -> &'static str {
        match self {
            Reason::AuthorNotActive => "Pembuat perubahan bukan anggota aktif organisasi.",
            Reason::NotAuthorized => "Anda tidak berhak melakukan perubahan ini.",
            Reason::GuestNotAllowed => "Tamu tidak bisa melakukan perubahan ini.",
            Reason::IdInUse => "Id ini sudah pernah dipakai.",
            Reason::TeamNotFound => "Departemen tidak ditemukan atau sudah dihapus.",
            Reason::TargetNotActive => "Orang itu bukan anggota aktif organisasi.",
            Reason::TargetIsGuest => "Tamu tidak bisa diberi peran ini.",
            Reason::AlreadySuperadmin => "Orang itu sudah superadmin.",
            Reason::NotSuperadmin => "Orang itu bukan superadmin.",
            Reason::LastSuperadmin => {
                "Organisasi harus punya minimal satu superadmin. Angkat superadmin lain dulu."
            }
            Reason::AlreadyTeamAdmin => "Orang itu sudah admin departemen ini.",
            Reason::NotTeamAdmin => "Orang itu bukan admin departemen ini.",
            Reason::AlreadyInTeam => "Orang itu sudah ada di departemen ini.",
            Reason::NotInTeam => "Orang itu tidak ada di departemen ini.",
            Reason::InviteNotFound => "Undangan tidak ditemukan.",
            Reason::InviteRevoked => "Undangan sudah dicabut.",
            Reason::InviteExpired => "Undangan sudah kedaluwarsa.",
            Reason::InviteNotYetValid => {
                "Undangan belum berlaku menurut jam laptop ini. Periksa jam laptop."
            }
            Reason::InviteUsed => "Undangan ini sudah dipakai.",
            Reason::InviterNotAuthorized => {
                "Pembuat undangan sudah tidak berhak mengundang ke departemen ini."
            }
            Reason::BadInviteSignature => "Bukti kode undangan tidak sah.",
            Reason::BadMemberSignature => "Tanda tangan laptop yang bergabung tidak sah.",
            Reason::MemberRemoved => "Laptop itu sudah dikeluarkan dari organisasi.",
            Reason::BadDeps => "Rujukan perubahan ini ke perubahan sebelumnya tidak sah.",
            Reason::ConcurrentWithRevocation => {
                "Perubahan ini dibuat bersamaan dengan pencabutan hak yang dipakainya, jadi tidak berlaku."
            }
            Reason::AlreadyInDepartment => {
                "Orang itu sudah masuk departemen lain. Hanya superadmin yang bisa memindahkannya."
            }
            Reason::DepartmentArchived => "Departemen ini sudah diarsipkan.",
            Reason::DepartmentNotEmpty => {
                "Departemen hanya bisa diarsipkan kalau sudah kosong. Pindahkan dulu orangnya."
            }
            Reason::NoChange => "Tidak ada yang berubah.",
            Reason::ProjectNotFound => "Proyek tidak ditemukan.",
            Reason::BadProjectId => "Id proyek tidak cocok dengan pembuat dan departemennya.",
            Reason::AlreadyInProject => "Orang itu sudah menjadi anggota proyek ini.",
            Reason::NotInProject => "Orang itu bukan anggota proyek ini.",
            Reason::LabelNotFound => "Label tidak ditemukan.",
            Reason::LabelArchived => "Label ini sudah diarsipkan.",
            Reason::BadJoinRequest => "Permintaan bergabung tidak sah.",
            Reason::JoinRequestExpired => {
                "Permintaan bergabung sudah lebih dari 7 hari. Minta orangnya mengirim ulang."
            }
            Reason::JoinAlreadyDecided => "Permintaan ini sudah disetujui atau ditolak.",
            Reason::AlreadyMember => "Laptop itu sudah menjadi anggota organisasi.",
            Reason::TargetNotSuspended => "Orang itu tidak sedang dinonaktifkan.",
            Reason::DivisionNotFound => "Divisi tidak ditemukan atau sudah dihapus.",
            Reason::DivisionArchived => "Divisi ini sudah diarsipkan.",
            Reason::AlreadyInDivision => "Orang itu sudah menjadi anggota divisi ini.",
            Reason::NotInDivision => "Orang itu bukan anggota divisi ini.",
            Reason::AlreadyDivisionHead => "Orang itu sudah menjadi kepala divisi ini.",
            Reason::NotDivisionHead => "Orang itu bukan kepala divisi ini.",
            Reason::TargetNotInDepartment => {
                "Orang itu bukan anggota departemen ini. Minta superadmin memindahkannya dulu."
            }
            Reason::LastTeamAdmin => {
                "Departemen harus punya minimal satu admin. Angkat admin lain dulu."
            }
        }
    }

    pub fn parse(code: &str) -> Option<Reason> {
        ALL_REASONS.iter().copied().find(|r| r.code() == code)
    }
}

const ALL_REASONS: [Reason; 48] = [
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
    Reason::BadDeps,
    Reason::ConcurrentWithRevocation,
    Reason::AlreadyInDepartment,
    Reason::DepartmentArchived,
    Reason::DepartmentNotEmpty,
    Reason::NoChange,
    Reason::ProjectNotFound,
    Reason::BadProjectId,
    Reason::AlreadyInProject,
    Reason::NotInProject,
    Reason::LabelNotFound,
    Reason::LabelArchived,
    Reason::BadJoinRequest,
    Reason::JoinRequestExpired,
    Reason::JoinAlreadyDecided,
    Reason::AlreadyMember,
    Reason::TargetNotSuspended,
    Reason::DivisionNotFound,
    Reason::DivisionArchived,
    Reason::AlreadyInDivision,
    Reason::NotInDivision,
    Reason::AlreadyDivisionHead,
    Reason::NotDivisionHead,
    Reason::TargetNotInDepartment,
    Reason::LastTeamAdmin,
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

/// Board project id: first 32 hex of
/// `blake3("mira-board-project-v1\n" + creator + "\n" + team + "\n" + nonce)`,
/// with an empty team for a project without department. Same formula as
/// `board::store::derive_project_id`.
pub fn project_id_for(creator: &str, team: Option<&str>, nonce: &str) -> String {
    let input = format!(
        "mira-board-project-v1\n{creator}\n{}\n{nonce}",
        team.unwrap_or("")
    );
    blake3::hash(input.as_bytes()).to_hex()[..32].to_owned()
}

/// Sorts the ops into fold order and applies them to the genesis state,
/// with the causal rules of `causal.rs`: ops with bad `deps`, and ops made
/// concurrently with a revocation of the right they used, are rejected.
pub fn fold(org: &Organization, ops: &[VerifiedOp]) -> FoldResult {
    super::causal::fold_ops(org, ops)
}

/// Fold order key of an op, owned.
fn op_key(op: &VerifiedOp) -> (u64, String, String) {
    (op.lamport(), op.author().to_owned(), op.id.clone())
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
            device: None,
            suspended_at: None,
            suspended_by: None,
            suspension_op: None,
            snapshot: None,
            joint_suspensions: Vec::new(),
            suspended_by_superadmin: false,
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
            projects: BTreeMap::new(),
            labels: BTreeMap::new(),
            join_decisions: BTreeMap::new(),
            ad: AdSettings::default(),
            suspend_used: false,
            divisions: BTreeMap::new(),
            chat_settings: BTreeMap::new(),
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

    pub(crate) fn is_active_non_guest(&self, pk: &str) -> bool {
        self.member(pk)
            .is_some_and(|m| m.status == MemberStatus::Active && m.kind == MemberKind::Member)
    }

    pub fn superadmin_count(&self) -> usize {
        self.members
            .values()
            .filter(|m| m.status == MemberStatus::Active && m.is_superadmin)
            .count()
    }

    /// A team that exists and is not deleted (archived or not).
    pub fn live_team(&self, id: &str) -> Option<&TeamState> {
        self.teams.get(id).filter(|t| !t.deleted)
    }

    /// A department people can be put in: live and not archived.
    pub fn open_team(&self, id: &str) -> Option<&TeamState> {
        self.live_team(id).filter(|t| !t.archived)
    }

    /// `TeamNotFound` or `DepartmentArchived` unless `id` is open.
    pub(super) fn require_open_team(&self, id: &str) -> Result<(), Reason> {
        match self.live_team(id) {
            None => Err(Reason::TeamNotFound),
            Some(t) if t.archived => Err(Reason::DepartmentArchived),
            Some(_) => Ok(()),
        }
    }

    pub fn team_role(&self, team: &str, pk: &str) -> Option<TeamRole> {
        self.live_team(team)
            .and_then(|t| t.members.get(pk))
            .map(|m| m.role)
    }

    /// Live teams of a member with their role there. Since v0.3 at most one
    /// (the department); older logs are folded to the same rule.
    pub fn teams_of(&self, pk: &str) -> Vec<(&TeamState, TeamRole)> {
        self.teams
            .values()
            .filter(|t| !t.deleted)
            .filter_map(|t| t.members.get(pk).map(|m| (t, m.role)))
            .collect()
    }

    /// The member's department and role in it.
    pub fn department_of(&self, pk: &str) -> Option<(&TeamState, TeamRole)> {
        self.teams_of(pk).into_iter().next()
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
        if self.open_team(team).is_none() || !self.is_active(creator) {
            return false;
        }
        self.is_superadmin(creator)
            || (self.team_role(team, creator) == Some(TeamRole::Admin)
                && matches!(role, InviteRole::Member | InviteRole::Guest))
    }

    /// Whether `pk` may approve or reject a join request for `team`:
    /// a superadmin, or an admin of that department.
    pub fn may_decide_join(&self, pk: &str, team: &str) -> bool {
        self.is_active_non_guest(pk)
            && (self.is_superadmin(pk) || self.team_role(team, pk) == Some(TeamRole::Admin))
    }

    /// Whether the invite can still admit someone at time `at` (not
    /// counting signatures). Checked in this order: revoked or dead team or
    /// creator without authority, used, expired, not yet valid.
    pub fn invite_usable(&self, invite: &InviteState, at: OffsetDateTime) -> Result<(), Reason> {
        if invite.revoked {
            return Err(Reason::InviteRevoked);
        }
        self.require_open_team(&invite.team)?;
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

    /// Explicit member of a registered project.
    pub fn is_project_member(&self, project: &str, pk: &str) -> bool {
        self.projects
            .get(project)
            .is_some_and(|p| p.members.contains_key(pk))
    }

    /// Guest invited by code to the project, through the project's own
    /// department (an invite through another department grants nothing).
    pub fn has_project_guest_access(&self, project: &str, pk: &str) -> bool {
        let Some(p) = self.projects.get(project) else {
            return false;
        };
        let Some(team) = p.team.as_deref() else {
            return false;
        };
        self.guest_access.contains(&GuestAccess {
            public_key: pk.to_owned(),
            team: team.to_owned(),
            project: project.to_owned(),
        })
    }

    /// Ways `pk` may manage the members of `project`: as its creator while a
    /// project member, as an admin of its department, or as a superadmin
    /// who is a project member. Empty when none applies.
    pub(crate) fn project_manager_paths(&self, project: &str, pk: &str) -> Vec<ManagerPath> {
        let mut paths = Vec::new();
        let Some(p) = self.projects.get(project) else {
            return paths;
        };
        if !self.is_active_non_guest(pk) {
            return paths;
        }
        let member = p.members.contains_key(pk);
        if member && p.creator == pk {
            paths.push(ManagerPath::Creator);
        }
        if let Some(team) = p.team.as_deref()
            && self.team_role(team, pk) == Some(TeamRole::Admin)
        {
            paths.push(ManagerPath::DepartmentAdmin(team.to_owned()));
        }
        if member && self.is_superadmin(pk) {
            paths.push(ManagerPath::Superadmin);
        }
        paths
    }

    pub fn may_manage_project(&self, project: &str, pk: &str) -> bool {
        !self.project_manager_paths(project, pk).is_empty()
    }

    pub(super) fn require_superadmin(&self, author: &str) -> Result<(), Reason> {
        if self.is_superadmin(author) {
            Ok(())
        } else {
            Err(Reason::NotAuthorized)
        }
    }

    pub(super) fn require_active_non_guest_target(&self, pk: &str) -> Result<(), Reason> {
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

    /// A non-guest target may join `team` as its department: not in any
    /// department yet (`AlreadyInTeam` when already in this one,
    /// `AlreadyInDepartment` when in another).
    fn require_no_department(&self, team: &str, pk: &str) -> Result<(), Reason> {
        match self.department_of(pk) {
            None => Ok(()),
            Some((t, _)) if t.id == team => Err(Reason::AlreadyInTeam),
            Some(_) => Err(Reason::AlreadyInDepartment),
        }
    }

    pub(super) fn live_team_mut(&mut self, id: &str) -> Result<&mut TeamState, Reason> {
        self.teams
            .get_mut(id)
            .filter(|t| !t.deleted)
            .ok_or(Reason::TeamNotFound)
    }

    fn label_mut(&mut self, id: &str) -> Result<&mut LabelState, Reason> {
        self.labels.get_mut(id).ok_or(Reason::LabelNotFound)
    }

    /// Removes `pk` from every department (one at most since v0.3).
    fn leave_departments(&mut self, pk: &str) {
        for t in self.teams.values_mut() {
            t.members.remove(pk);
        }
    }

    /// Takes `pk` out of every department, division (head role included),
    /// project, label and guest access (what `member_remove` and
    /// `member_suspend` do).
    fn strip_member(&mut self, pk: &str) {
        self.leave_departments(pk);
        self.leave_divisions(pk, None);
        self.guest_access.retain(|g| g.public_key != pk);
        for p in self.projects.values_mut() {
            p.members.remove(pk);
        }
        for l in self.labels.values_mut() {
            l.members.remove(pk);
        }
    }

    /// What `strip_member` is about to take from `pk`.
    fn snapshot_of(&self, pk: &str) -> SuspendSnapshot {
        SuspendSnapshot {
            department: self.department_of(pk).map(|(t, r)| (t.id.clone(), r)),
            appointed: self
                .department_of(pk)
                .and_then(|(t, _)| t.members.get(pk))
                .and_then(|tm| tm.appointed.clone()),
            superadmin: self.is_superadmin(pk),
            projects: self
                .projects
                .values()
                .filter(|p| p.members.contains_key(pk))
                .map(|p| p.id.clone())
                .collect(),
            labels: self
                .labels
                .values()
                .filter(|l| l.members.contains(pk))
                .map(|l| l.id.clone())
                .collect(),
            guest_access: self
                .guest_access
                .iter()
                .filter(|g| g.public_key == pk)
                .cloned()
                .collect(),
        }
    }

    /// Effect of `member_reinstate`: active again, with what the snapshot
    /// held that is still valid (open department, existing projects and
    /// labels, guest access through a live team).
    fn restore_member(&mut self, pk: &str, by: &str, at: &str) {
        let Some(m) = self.members.get_mut(pk) else {
            return;
        };
        let snapshot = m.snapshot.take().unwrap_or_default();
        m.status = MemberStatus::Active;
        m.is_superadmin = snapshot.superadmin;
        m.suspended_at = None;
        m.suspended_by = None;
        m.suspension_op = None;
        m.joint_suspensions.clear();
        m.suspended_by_superadmin = false;
        if let Some((team, role)) = snapshot.department
            && let Some(t) = self.teams.get_mut(&team).filter(|t| !t.deleted && !t.archived)
        {
            t.members.insert(
                pk.to_owned(),
                TeamMember {
                    role,
                    added_at: at.to_owned(),
                    appointed: (role == TeamRole::Admin)
                        .then(|| snapshot.appointed.clone())
                        .flatten(),
                },
            );
        }
        for project in &snapshot.projects {
            if let Some(p) = self.projects.get_mut(project) {
                p.members.entry(pk.to_owned()).or_insert(ProjectMember {
                    added_at: at.to_owned(),
                    added_by: by.to_owned(),
                });
            }
        }
        // Archived labels take nobody (`label_assign` refuses them).
        for label in &snapshot.labels {
            if let Some(l) = self.labels.get_mut(label).filter(|l| !l.archived) {
                l.members.insert(pk.to_owned());
            }
        }
        for g in snapshot.guest_access {
            if self.live_team(&g.team).is_some() {
                self.guest_access.insert(g);
            }
        }
    }

    /// The department whose admin `author` is and through which they may
    /// suspend `target`: the target is a regular member (not a guest, not a
    /// superadmin, role `member`) of that department.
    pub(crate) fn suspend_admin_team(&self, author: &str, target: &str) -> Option<String> {
        let m = self.member(target)?;
        if m.status != MemberStatus::Active || m.kind != MemberKind::Member || m.is_superadmin {
            return None;
        }
        let (team, role) = self.department_of(target)?;
        (role == TeamRole::Member && self.team_role(&team.id, author) == Some(TeamRole::Admin))
            .then(|| team.id.clone())
    }

    /// The department whose admin `author` is, when `target` is suspended
    /// and was a regular member there (not a superadmin). Through it the
    /// admin may add a suspension made concurrently with another one.
    pub(crate) fn snapshot_admin_team(&self, author: &str, target: &str) -> Option<String> {
        let m = self.member(target)?;
        let snapshot = m.snapshot.as_ref()?;
        if m.status != MemberStatus::Suspended || m.kind != MemberKind::Member || snapshot.superadmin
        {
            return None;
        }
        let (team, role) = snapshot.department.as_ref()?;
        (*role == TeamRole::Member && self.team_role(team, author) == Some(TeamRole::Admin))
            .then(|| team.clone())
    }

    /// The department through which `author` may reinstate `target`: as
    /// [`Self::snapshot_admin_team`], and no superadmin took part in the
    /// suspension (an admin never lifts a superadmin's suspension).
    pub(crate) fn reinstate_admin_team(&self, author: &str, target: &str) -> Option<String> {
        if self.member(target)?.suspended_by_superadmin {
            return None;
        }
        self.snapshot_admin_team(author, target)
    }

    /// Whether `author` may write `member_suspend` for `target` now (the
    /// fold rule; `author` must be active too).
    pub fn may_suspend(&self, author: &str, target: &str) -> Result<(), Reason> {
        if !self.is_active(target) {
            return Err(Reason::TargetNotActive);
        }
        if !self.is_superadmin(author) && self.suspend_admin_team(author, target).is_none() {
            return Err(Reason::NotAuthorized);
        }
        if self.is_superadmin(target) && self.superadmin_count() <= 1 {
            return Err(Reason::LastSuperadmin);
        }
        Ok(())
    }

    /// Whether `author` may write `member_reinstate` for `target` now.
    pub fn may_reinstate(&self, author: &str, target: &str) -> Result<(), Reason> {
        if self.member(target).map(|m| m.status) != Some(MemberStatus::Suspended) {
            return Err(Reason::TargetNotSuspended);
        }
        if !self.is_superadmin(author) && self.reinstate_admin_team(author, target).is_none() {
            return Err(Reason::NotAuthorized);
        }
        Ok(())
    }

    /// Whether `author` may write `member_remove` for `target` now: a
    /// superadmin, for an active or a suspended member.
    pub fn may_remove(&self, author: &str, target: &str) -> Result<(), Reason> {
        self.require_superadmin(author)?;
        match self.member(target).map(|m| m.status) {
            Some(MemberStatus::Active | MemberStatus::Suspended) => {}
            Some(MemberStatus::Removed) | None => return Err(Reason::TargetNotActive),
        }
        if self.is_superadmin(target) && self.superadmin_count() <= 1 {
            return Err(Reason::LastSuperadmin);
        }
        Ok(())
    }

    /// Renames the department channels of `team` after its new name.
    fn rename_team_channels(&mut self, team: &str, name: &str) {
        let channel = channel_name_for(name);
        for c in self.channels.values_mut() {
            if c.team.as_deref() == Some(team) {
                c.name = channel.clone();
            }
        }
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
                        archived: false,
                        archived_at: None,
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
                self.delete_team_divisions(team);
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
                // v0.6: an admin of the department may promote its people.
                let sa = self.is_superadmin(&author);
                if !sa && self.team_role(team, &author) != Some(TeamRole::Admin) {
                    return Err(Reason::NotAuthorized);
                }
                self.require_open_team(team)?;
                self.require_active_non_guest_target(member)?;
                // The admin of a department is one of its people: someone in
                // another department has to be moved first.
                let current = self.team_role(team, member);
                if current.is_none() {
                    if !sa {
                        return Err(Reason::TargetNotInDepartment);
                    }
                    self.require_no_department(team, member)?;
                }
                let appointed = Some(op_key(op));
                let t = self.live_team_mut(team)?;
                match t.members.get_mut(member) {
                    Some(tm) if tm.role == TeamRole::Admin => return Err(Reason::AlreadyTeamAdmin),
                    Some(tm) => {
                        tm.role = TeamRole::Admin;
                        tm.appointed = appointed;
                    }
                    None => {
                        t.members.insert(
                            member.clone(),
                            TeamMember {
                                role: TeamRole::Admin,
                                added_at: at,
                                appointed,
                            },
                        );
                    }
                }
            }
            Body::TeamAdminUnset { team, member } => {
                // v0.6: an admin of the department may demote the admins
                // appointed after them, and themselves unless they are the
                // last one. Seniority comes from the appointing op, which
                // the junior admin cannot choose, so a demoted admin cannot
                // answer with a backdated demotion of the senior one.
                let sa = self.is_superadmin(&author);
                if !sa && self.team_role(team, &author) != Some(TeamRole::Admin) {
                    return Err(Reason::NotAuthorized);
                }
                let t = self.live_team_mut(team)?;
                let Some(target) = t
                    .members
                    .get(member)
                    .filter(|tm| tm.role == TeamRole::Admin)
                else {
                    return Err(Reason::NotTeamAdmin);
                };
                if !sa && member != &author {
                    let mine = t.members.get(&author).and_then(|tm| tm.appointed.as_ref());
                    let junior = matches!(
                        (target.appointed.as_ref(), mine),
                        (Some(theirs), Some(mine)) if theirs > mine
                    );
                    if !junior {
                        return Err(Reason::NotAuthorized);
                    }
                }
                if !sa && member == &author && self.team_admin_count(team) <= 1 {
                    return Err(Reason::LastTeamAdmin);
                }
                if let Some(tm) = self.live_team_mut(team)?.members.get_mut(member) {
                    tm.role = TeamRole::Member;
                    tm.appointed = None;
                }
            }
            Body::TeamMemberAdd { team, member } => {
                self.require_open_team(team)?;
                if !self.is_superadmin(&author)
                    && self.team_role(team, &author) != Some(TeamRole::Admin)
                {
                    return Err(Reason::NotAuthorized);
                }
                self.require_active_non_guest_target(member)?;
                // Only people without a department can be added; moving
                // between departments is `team_move` (superadmin).
                self.require_no_department(team, member)?;
                let t = self.live_team_mut(team)?;
                t.members.insert(
                    member.clone(),
                    TeamMember {
                        role: TeamRole::Member,
                        added_at: at,
                        appointed: None,
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
                // Same rule as v0.2, so old logs keep the removals they had
                // (a v0.2 self-leave or admin kick must stay out). The v0.3
                // UI never offers it: people move with `team_move`.
                let allowed = self.is_superadmin(&author)
                    || &author == member
                    || (self.team_role(team, &author) == Some(TeamRole::Admin)
                        && target_role != TeamRole::Admin);
                if !allowed {
                    return Err(Reason::NotAuthorized);
                }
                self.live_team_mut(team)?.members.remove(member);
                self.leave_team_divisions(member, team);
            }
            Body::MemberRemove { member } => {
                self.may_remove(&author, member)?;
                self.strip_member(member);
                if let Some(m) = self.members.get_mut(member) {
                    m.status = MemberStatus::Removed;
                    m.is_superadmin = false;
                    m.removed_at = Some(at);
                    m.removal_op = Some(op.id.clone());
                    m.suspended_at = None;
                    m.suspended_by = None;
                    m.suspension_op = None;
                    m.joint_suspensions.clear();
                    m.suspended_by_superadmin = false;
                    m.snapshot = None;
                }
            }
            Body::MemberSuspend { member } => {
                // Already suspended: suspensions made concurrently all
                // stand, so a reinstatement must have seen each of them
                // (checked in `causal.rs`). The UI never offers this
                // (`may_suspend` refuses a suspended target).
                if self.member(member).map(|m| m.status) == Some(MemberStatus::Suspended) {
                    let by_superadmin = self.is_superadmin(&author);
                    if !by_superadmin && self.snapshot_admin_team(&author, member).is_none() {
                        return Err(Reason::NotAuthorized);
                    }
                    if let Some(m) = self.members.get_mut(member) {
                        m.joint_suspensions.push(op.id.clone());
                        m.suspended_by_superadmin |= by_superadmin;
                    }
                    self.suspend_used = true;
                    return Ok(());
                }
                self.may_suspend(&author, member)?;
                let by_superadmin = self.is_superadmin(&author);
                let snapshot = self.snapshot_of(member);
                self.strip_member(member);
                self.suspend_used = true;
                if let Some(m) = self.members.get_mut(member) {
                    m.suspended_by_superadmin = by_superadmin;
                    m.status = MemberStatus::Suspended;
                    m.is_superadmin = false;
                    m.suspended_at = Some(at);
                    m.suspended_by = Some(author);
                    m.suspension_op = Some(op.id.clone());
                    m.snapshot = Some(snapshot);
                }
            }
            Body::MemberReinstate { member } => {
                self.may_reinstate(&author, member)?;
                self.restore_member(member, &author, &at);
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
                key_sig,
            } => {
                self.require_open_team(team)?;
                if !self.may_invite(&author, team, *role) {
                    return Err(Reason::NotAuthorized);
                }
                if self.invites.contains_key(invite) {
                    return Err(Reason::IdInUse);
                }
                let key_msg = invite_key_message(
                    &self.org.id,
                    &self.org.founder_public_key,
                    &author,
                    invite,
                    team,
                    *role,
                    projects,
                    expires,
                    *single_use,
                    tag,
                );
                if !verify_sig(key, &key_msg, key_sig) {
                    return Err(Reason::BadInviteSignature);
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
                // Each person can use an invite once. Accept proofs are in the
                // log and `at` is chosen by the author, so without this anyone
                // could replay an old proof (even after expiry) to put that
                // person back into the team or restore a team admin role.
                if inv.used_by.contains(member) {
                    return Err(Reason::InviteUsed);
                }
                let msg = redeem_message(&self.org.id, invite, member, name);
                if !verify_sig(&inv.key, &msg, invite_sig) {
                    return Err(Reason::BadInviteSignature);
                }
                if !verify_sig(member, &msg, member_sig) {
                    return Err(Reason::BadMemberSignature);
                }
                match self.member(member).map(|m| m.status) {
                    Some(MemberStatus::Removed) => return Err(Reason::MemberRemoved),
                    // A suspended member comes back only through
                    // `member_reinstate`.
                    Some(MemberStatus::Suspended) => return Err(Reason::TargetNotActive),
                    Some(MemberStatus::Active) | None => {}
                }
                // One department per person: a member (or a guest becoming a
                // member) already in another department keeps it. This is
                // also the rule that folds v0.2 logs where someone joined
                // several teams: the earliest membership stays.
                if inv.role != InviteRole::Guest
                    && self.team_role(&inv.team, member).is_none()
                    && self.department_of(member).is_some()
                {
                    return Err(Reason::AlreadyInDepartment);
                }
                let inv = inv.clone();
                self.admit(&inv, member, name, &at, op_key(op));
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
            Body::TeamRename { team, name } => {
                self.require_superadmin(&author)?;
                let t = self.live_team_mut(team)?;
                if &t.name == name {
                    return Err(Reason::NoChange);
                }
                t.name = name.clone();
                self.rename_team_channels(team, name);
            }
            Body::TeamArchive { team, archived } => {
                self.require_superadmin(&author)?;
                let t = self.live_team_mut(team)?;
                if t.archived == *archived {
                    return Err(Reason::NoChange);
                }
                if *archived && !t.members.is_empty() {
                    return Err(Reason::DepartmentNotEmpty);
                }
                t.archived = *archived;
                t.archived_at = archived.then_some(at);
            }
            Body::TeamMove { team, member } => {
                self.require_superadmin(&author)?;
                self.require_open_team(team)?;
                self.require_active_non_guest_target(member)?;
                if self.team_role(team, member).is_some() {
                    return Err(Reason::AlreadyInTeam);
                }
                self.leave_departments(member);
                self.leave_divisions(member, Some(team));
                self.live_team_mut(team)?.members.insert(
                    member.clone(),
                    TeamMember {
                        role: TeamRole::Member,
                        added_at: at,
                        appointed: None,
                    },
                );
            }
            Body::JoinApprove {
                request,
                request_sig,
            } => {
                let req = self.join_request(request, request_sig)?;
                if !self.may_decide_join(&author, &req.payload.team) {
                    return Err(Reason::NotAuthorized);
                }
                if self.join_decisions.contains_key(&req.id) {
                    return Err(Reason::JoinAlreadyDecided);
                }
                self.require_open_team(&req.payload.team)?;
                match self.member(&req.payload.member).map(|m| m.status) {
                    Some(MemberStatus::Removed) => return Err(Reason::MemberRemoved),
                    Some(MemberStatus::Active | MemberStatus::Suspended) => {
                        return Err(Reason::AlreadyMember);
                    }
                    None => {}
                }
                if op.at < req.at - CLOCK_SLACK
                    || op.at > req.at + JOIN_REQUEST_VALIDITY + CLOCK_SLACK
                {
                    return Err(Reason::JoinRequestExpired);
                }
                let p = &req.payload;
                self.members.insert(
                    p.member.clone(),
                    MemberState {
                        public_key: p.member.clone(),
                        display_name: Some(p.name.clone()),
                        status: MemberStatus::Active,
                        kind: MemberKind::Member,
                        is_superadmin: false,
                        joined_at: at.clone(),
                        removed_at: None,
                        removal_op: None,
                        has_profile: false,
                        device: Some(DeviceInfo {
                            laptop: p.laptop.clone(),
                            os: p.os.clone(),
                            app_version: p.app_version.clone(),
                            at: p.at.clone(),
                        }),
                        suspended_at: None,
                        suspended_by: None,
                        suspension_op: None,
                        snapshot: None,
                        joint_suspensions: Vec::new(),
                        suspended_by_superadmin: false,
                    },
                );
                self.live_team_mut(&p.team)?.members.insert(
                    p.member.clone(),
                    TeamMember {
                        role: TeamRole::Member,
                        added_at: at.clone(),
                        appointed: None,
                    },
                );
                self.decide(&req, true, author, at);
            }
            Body::JoinReject {
                request,
                request_sig,
            } => {
                let req = self.join_request(request, request_sig)?;
                if !self.may_decide_join(&author, &req.payload.team) {
                    return Err(Reason::NotAuthorized);
                }
                if self.join_decisions.contains_key(&req.id) {
                    return Err(Reason::JoinAlreadyDecided);
                }
                self.decide(&req, false, author, at);
            }
            Body::ProjectCreate {
                project,
                team,
                creator,
                nonce,
                members: initial,
                division,
            } => {
                if !self.is_active_non_guest(&author) {
                    return Err(Reason::GuestNotAllowed);
                }
                if project_id_for(creator, team.as_deref(), nonce) != *project {
                    return Err(Reason::BadProjectId);
                }
                if self.projects.contains_key(project) {
                    return Err(Reason::IdInUse);
                }
                // A new project goes into an open department; a project
                // made before v0.3 may be registered in an archived one.
                if let Some(team) = team {
                    if &author == creator {
                        self.require_open_team(team)?;
                    } else if self.live_team(team).is_none() {
                        return Err(Reason::TeamNotFound);
                    }
                }
                // The creator registers their own project. A project made
                // before v0.3 whose creator is no longer an active member
                // can be registered by a superadmin or an admin of its
                // department.
                if &author != creator {
                    if self.is_active_non_guest(creator) {
                        return Err(Reason::NotAuthorized);
                    }
                    let admin = team
                        .as_deref()
                        .is_some_and(|t| self.team_role(t, &author) == Some(TeamRole::Admin));
                    if !self.is_superadmin(&author) && !admin {
                        return Err(Reason::NotAuthorized);
                    }
                }
                if let Some(division) = division {
                    self.check_project_division(&author, team.as_deref(), division)?;
                }
                let mut members = BTreeMap::new();
                let joining = initial
                    .iter()
                    .filter(|pk| self.is_active(pk))
                    .chain(self.is_active_non_guest(creator).then_some(creator));
                for pk in joining {
                    members.insert(
                        pk.clone(),
                        ProjectMember {
                            added_at: at.clone(),
                            added_by: author.clone(),
                        },
                    );
                }
                self.projects.insert(
                    project.clone(),
                    ProjectState {
                        id: project.clone(),
                        team: team.clone(),
                        creator: creator.clone(),
                        registered_by: author,
                        created_at: at,
                        members,
                        division: division.clone(),
                    },
                );
            }
            Body::ProjectMemberAdd { project, member } => {
                if !self.projects.contains_key(project) {
                    return Err(Reason::ProjectNotFound);
                }
                // A superadmin may add themselves (F-ROLE-11: the step is in
                // the log for everyone to see), not anyone else.
                let self_join = member == &author && self.is_superadmin(&author);
                if !self_join && !self.may_manage_project(project, &author) {
                    return Err(Reason::NotAuthorized);
                }
                if !self.is_active(member) {
                    return Err(Reason::TargetNotActive);
                }
                if self.is_project_member(project, member) {
                    return Err(Reason::AlreadyInProject);
                }
                if let Some(p) = self.projects.get_mut(project) {
                    p.members.insert(
                        member.clone(),
                        ProjectMember {
                            added_at: at,
                            added_by: author,
                        },
                    );
                }
            }
            Body::ProjectMemberRemove { project, member } => {
                if !self.projects.contains_key(project) {
                    return Err(Reason::ProjectNotFound);
                }
                let listed = self.is_project_member(project, member);
                let guest = self.has_project_guest_access(project, member);
                if !listed && !guest {
                    return Err(Reason::NotInProject);
                }
                if &author != member && !self.may_manage_project(project, &author) {
                    return Err(Reason::NotAuthorized);
                }
                if let Some(p) = self.projects.get_mut(project) {
                    p.members.remove(member);
                }
                self.guest_access
                    .retain(|g| !(&g.public_key == member && &g.project == project));
            }
            Body::LabelCreate { label, name } => {
                self.require_superadmin(&author)?;
                if self.used_ids.contains(label) {
                    return Err(Reason::IdInUse);
                }
                self.used_ids.insert(label.clone());
                self.labels.insert(
                    label.clone(),
                    LabelState {
                        id: label.clone(),
                        name: name.clone(),
                        archived: false,
                        created_at: at,
                        members: BTreeSet::new(),
                    },
                );
            }
            Body::LabelRename { label, name } => {
                self.require_superadmin(&author)?;
                let l = self.label_mut(label)?;
                if &l.name == name {
                    return Err(Reason::NoChange);
                }
                l.name = name.clone();
            }
            Body::LabelArchive { label, archived } => {
                self.require_superadmin(&author)?;
                let l = self.label_mut(label)?;
                if l.archived == *archived {
                    return Err(Reason::NoChange);
                }
                l.archived = *archived;
            }
            Body::LabelAssign { label, member } => {
                self.require_superadmin(&author)?;
                if !self.is_active(member) {
                    return Err(Reason::TargetNotActive);
                }
                let l = self.label_mut(label)?;
                if l.archived {
                    return Err(Reason::LabelArchived);
                }
                if !l.members.insert(member.clone()) {
                    return Err(Reason::NoChange);
                }
            }
            Body::LabelUnassign { label, member } => {
                self.require_superadmin(&author)?;
                let l = self.label_mut(label)?;
                if !l.members.remove(member) {
                    return Err(Reason::NoChange);
                }
            }
            Body::DeviceSet {
                laptop,
                os,
                app_version,
            } => {
                let m = self
                    .members
                    .get_mut(&author)
                    .ok_or(Reason::AuthorNotActive)?;
                let same = m.device.as_ref().is_some_and(|d| {
                    &d.laptop == laptop && &d.os == os && &d.app_version == app_version
                });
                if same {
                    return Err(Reason::NoChange);
                }
                m.device = Some(DeviceInfo {
                    laptop: laptop.clone(),
                    os: os.clone(),
                    app_version: app_version.clone(),
                    at,
                });
            }
            Body::AdSettingsSet { domain, ou_map } => {
                self.require_superadmin(&author)?;
                // Rows of a deleted (or unknown) department are left out
                // rather than refusing the op: a department deleted
                // concurrently must not undo another superadmin's domain.
                // Archived departments may stay mapped (suggestions skip
                // them).
                let ou_map: Vec<OuMapping> = ou_map
                    .iter()
                    .filter(|row| self.live_team(&row.team).is_some())
                    .map(|row| self.ou_row_checked(row))
                    .collect();
                let next = AdSettings {
                    domain: (!domain.is_empty()).then(|| domain.clone()),
                    ou_map,
                    set: true,
                };
                if self.ad == next {
                    return Err(Reason::NoChange);
                }
                self.ad = next;
            }
            Body::DivisionCreate {
                division,
                team,
                name,
            } => self.apply_division_create(&author, &at, division, team, name)?,
            Body::DivisionRename { division, name } => {
                self.apply_division_rename(&author, division, name)?
            }
            Body::DivisionArchive { division, archived } => {
                self.apply_division_archive(&author, &at, division, *archived)?
            }
            Body::DivisionHeadSet {
                division,
                member,
                head,
            } => self.apply_division_head_set(&author, &at, division, member, *head)?,
            Body::DivisionMemberAdd { division, member } => {
                self.apply_division_member_add(&author, &at, division, member)?
            }
            Body::DivisionMemberRemove { division, member } => {
                self.apply_division_member_remove(&author, division, member)?
            }
            Body::ChatSettingsSet {
                team,
                division,
                pinned,
                announce,
            } => self.apply_chat_settings_set(
                &author,
                &at,
                team,
                division.as_deref(),
                pinned,
                *announce,
            )?,
        }
        Ok(())
    }

    /// The request inside a join op, checked against this organization and
    /// the requester's signature.
    pub(crate) fn join_request(
        &self,
        request: &str,
        request_sig: &str,
    ) -> Result<VerifiedJoinRequest, Reason> {
        verify_join_request(
            &SignedJoinRequest {
                payload: request.to_owned(),
                sig: request_sig.to_owned(),
            },
            &self.org,
        )
        .map_err(|_| Reason::BadJoinRequest)
    }

    fn decide(&mut self, req: &VerifiedJoinRequest, approved: bool, by: String, at: String) {
        self.join_decisions.insert(
            req.id.clone(),
            JoinDecision {
                request: req.id.clone(),
                member: req.payload.member.clone(),
                name: req.payload.name.clone(),
                team: req.payload.team.clone(),
                approved,
                by,
                at,
                ad_account: req
                    .payload
                    .ad
                    .as_ref()
                    .map(|c| (c.domain.clone(), c.user.clone())),
            },
        );
    }

    /// Effect of a valid `invite_accept` (plan 1.3).
    fn admit(
        &mut self,
        inv: &InviteState,
        member: &str,
        name: &str,
        at: &str,
        key: (u64, String, String),
    ) {
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
                        device: None,
                        suspended_at: None,
                        suspended_by: None,
                        suspension_op: None,
                        snapshot: None,
                        joint_suspensions: Vec::new(),
                        suspended_by_superadmin: false,
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
        let appointed = (role == TeamRole::Admin).then_some(key);
        if let Some(t) = self.teams.get_mut(&inv.team) {
            match t.members.get_mut(member) {
                Some(tm) if tm.role == TeamRole::Admin => {}
                Some(tm) => {
                    tm.role = role;
                    tm.appointed = appointed;
                }
                None => {
                    t.members.insert(
                        member.to_owned(),
                        TeamMember {
                            role,
                            added_at: at.to_owned(),
                            appointed,
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

/// One way to be allowed to manage a project's members.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ManagerPath {
    Creator,
    DepartmentAdmin(String),
    Superadmin,
}
