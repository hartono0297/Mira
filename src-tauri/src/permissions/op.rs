//! Signed membership ops: wire shape, signing and verification (plan 1.1).

use std::collections::BTreeSet;

use ed25519_dalek::{Signature, VerifyingKey};
use hex::FromHex;
use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};

use super::format::{
    is_canonical_display_name, is_canonical_label_name, is_canonical_team_name, is_lower_hex,
    is_tag, is_valid_app_version, is_valid_channel_name, is_valid_laptop_name, is_valid_os_name,
    parse_time,
};

/// Domain prefix of the signed message.
pub const OP_DOMAIN: &str = "mira-op-v1\n";
pub const OP_VERSION: u32 = 1;
pub const MAX_PAYLOAD_BYTES: usize = 16 * 1024;
/// Largest accepted lamport value (safe integer in JavaScript, fits SQLite).
pub const MAX_LAMPORT: u64 = (1 << 53) - 1;
/// A received op may be at most this far above the highest lamport this
/// laptop holds. Otherwise one op near `MAX_LAMPORT` would make every later
/// op (`max + 1`) invalid and freeze the organization. Reaching the limit
/// in steps would take billions of ops. Refused ops are not stored and can
/// be accepted later, once the ops in between have arrived.
pub const MAX_LAMPORT_JUMP: u64 = 1_000_000;
/// Ops dated further than this in the receiver's future are refused.
pub const MAX_CLOCK_AHEAD: Duration = Duration::minutes(10);
/// Longest invite validity, plus slack for clock differences.
pub const MAX_INVITE_VALIDITY: Duration = Duration::days(7);
pub const CLOCK_SLACK: Duration = Duration::minutes(5);
pub const MAX_GUEST_PROJECTS: usize = 50;
/// Most people listed in `project_create.members`.
pub const MAX_PROJECT_INITIAL_MEMBERS: usize = 200;
/// Most ops listed in `deps`. With more heads, the author keeps the latest
/// ones in fold order; the others stay implied only through lamport.
pub const MAX_DEPS: usize = 32;

/// One op as stored and sent: the exact signed payload string and its
/// signature (128 lowercase hex).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignedOp {
    pub payload: String,
    pub sig: String,
}

impl SignedOp {
    /// `hex(blake3(payload bytes))`, 64 lowercase hex.
    pub fn id(&self) -> String {
        op_id(&self.payload)
    }
}

pub fn op_id(payload: &str) -> String {
    blake3::hash(payload.as_bytes()).to_hex().to_string()
}

/// `{"kind":"org"}` or `{"kind":"team","team":"<32 hex>"}`.
///
/// Goes through `RawScope` because serde ignores `deny_unknown_fields` on
/// the unit variant of an internally tagged enum.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "RawScope", into = "RawScope")]
pub enum Scope {
    Org,
    Team { team: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ScopeKind {
    Org,
    Team,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawScope {
    kind: ScopeKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    team: Option<String>,
}

impl TryFrom<RawScope> for Scope {
    type Error = &'static str;

    fn try_from(raw: RawScope) -> Result<Self, Self::Error> {
        match (raw.kind, raw.team) {
            (ScopeKind::Org, None) => Ok(Scope::Org),
            (ScopeKind::Team, Some(team)) => Ok(Scope::Team { team }),
            (ScopeKind::Org, Some(_)) => Err("scope org tidak boleh berisi team"),
            (ScopeKind::Team, None) => Err("scope team wajib berisi team"),
        }
    }
}

impl From<Scope> for RawScope {
    fn from(scope: Scope) -> Self {
        match scope {
            Scope::Org => RawScope {
                kind: ScopeKind::Org,
                team: None,
            },
            Scope::Team { team } => RawScope {
                kind: ScopeKind::Team,
                team: Some(team),
            },
        }
    }
}

impl Scope {
    pub fn team(&self) -> Option<&str> {
        match self {
            Scope::Org => None,
            Scope::Team { team } => Some(team),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InviteRole {
    TeamAdmin,
    Member,
    Guest,
}

impl InviteRole {
    pub fn as_str(self) -> &'static str {
        match self {
            InviteRole::TeamAdmin => "team_admin",
            InviteRole::Member => "member",
            InviteRole::Guest => "guest",
        }
    }

    pub fn parse(s: &str) -> Option<InviteRole> {
        match s {
            "team_admin" => Some(InviteRole::TeamAdmin),
            "member" => Some(InviteRole::Member),
            "guest" => Some(InviteRole::Guest),
            _ => None,
        }
    }
}

/// Op bodies, one per row of the authority table (plan 1.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Body {
    ProfileSet {
        name: String,
    },
    TeamCreate {
        team: String,
        name: String,
    },
    TeamDelete {
        team: String,
    },
    SuperadminAdd {
        member: String,
    },
    SuperadminRemove {
        member: String,
    },
    TeamAdminSet {
        team: String,
        member: String,
    },
    TeamAdminUnset {
        team: String,
        member: String,
    },
    TeamMemberAdd {
        team: String,
        member: String,
    },
    TeamMemberRemove {
        team: String,
        member: String,
    },
    MemberRemove {
        member: String,
    },
    /// 0.6.0: superadmin, or the department admin of a regular member,
    /// suspends `member` (can be reinstated, same laptop key). Only written
    /// once every member is past `SUSPEND_SINCE`.
    MemberSuspend {
        member: String,
    },
    /// 0.6.0: makes a suspended member active again.
    MemberReinstate {
        member: String,
    },
    InviteCreate {
        invite: String,
        team: String,
        role: InviteRole,
        projects: Vec<String>,
        expires: String,
        single_use: bool,
        tag: String,
        key: String,
        /// Signature of the invite key over `invite_key_message`.
        key_sig: String,
    },
    InviteRevoke {
        invite: String,
    },
    InviteAccept {
        invite: String,
        member: String,
        name: String,
        invite_sig: String,
        member_sig: String,
    },
    ChannelCreate {
        channel: String,
        team: String,
        name: String,
    },
    // ----- v0.3: departments (internally still `team`) -----
    /// Superadmin renames a department; its department channel follows.
    TeamRename {
        team: String,
        name: String,
    },
    /// Superadmin archives (only when nobody is in it) or restores a
    /// department.
    TeamArchive {
        team: String,
        archived: bool,
    },
    /// Superadmin moves a non-guest member into `team`, out of whatever
    /// department they were in (one department per person).
    TeamMove {
        team: String,
        member: String,
    },
    // ----- v0.3: join requests -----
    /// Approver admits the laptop that signed `request` (a
    /// `JoinRequestPayload` JSON string, signed with `request_sig`).
    JoinApprove {
        request: String,
        request_sig: String,
    },
    /// Approver turns the request down; it can never be approved after.
    JoinReject {
        request: String,
        request_sig: String,
    },
    // ----- v0.3: projects with explicit members -----
    /// Registers a board project: `project` must equal
    /// `project_id_for(creator, team, nonce)`, the id the board derives.
    ///
    /// `members` (sorted, unique) join with the creator: the people picked
    /// in the "Proyek baru" dialog, or the v0.2 readers when a project made
    /// before v0.3 is registered.
    ProjectCreate {
        project: String,
        team: Option<String>,
        creator: String,
        nonce: String,
        members: Vec<String>,
        /// v0.6: the division that owns the project (in `team`). Absent
        /// from older ops, which keep their exact bytes.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        division: Option<String>,
    },
    ProjectMemberAdd {
        project: String,
        member: String,
    },
    ProjectMemberRemove {
        project: String,
        member: String,
    },
    // ----- v0.3: profile labels -----
    LabelCreate {
        label: String,
        name: String,
    },
    LabelRename {
        label: String,
        name: String,
    },
    LabelArchive {
        label: String,
        archived: bool,
    },
    LabelAssign {
        label: String,
        member: String,
    },
    LabelUnassign {
        label: String,
        member: String,
    },
    // ----- v0.3: device profile -----
    /// The author's own laptop name, operating system and Mira version.
    DeviceSet {
        laptop: String,
        os: String,
        app_version: String,
    },
    // ----- AD onboarding (docs/plans/onboarding-ad.md) -----
    /// Superadmin sets the organization's AD domain (empty: none) and the
    /// OU to department mapping. The latest applied one wins. Mira v0.4.0
    /// refuses it, so it is only written once every member is past
    /// `JOIN_AD_SINCE` (`join::ad_settings_allowed`).
    AdSettingsSet {
        domain: String,
        ou_map: Vec<crate::ad::OuMapping>,
    },
    // ----- v0.6: divisions (docs/plans/dept-divisi.md) -----
    /// Superadmin or admin of `team` creates a division in it.
    DivisionCreate {
        division: String,
        team: String,
        name: String,
    },
    DivisionRename {
        division: String,
        name: String,
    },
    DivisionArchive {
        division: String,
        archived: bool,
    },
    DivisionHeadSet {
        division: String,
        member: String,
        head: bool,
    },
    DivisionMemberAdd {
        division: String,
        member: String,
    },
    DivisionMemberRemove {
        division: String,
        member: String,
    },
    /// Pinned note and announcement mode of a department channel
    /// (`division` none) or of a division chat.
    ChatSettingsSet {
        team: String,
        division: Option<String>,
        pinned: String,
        announce: bool,
    },
}

impl Body {
    /// The `type` tag, stored in `org_ops.kind`.
    pub fn kind(&self) -> &'static str {
        match self {
            Body::ProfileSet { .. } => "profile_set",
            Body::TeamCreate { .. } => "team_create",
            Body::TeamDelete { .. } => "team_delete",
            Body::SuperadminAdd { .. } => "superadmin_add",
            Body::SuperadminRemove { .. } => "superadmin_remove",
            Body::TeamAdminSet { .. } => "team_admin_set",
            Body::TeamAdminUnset { .. } => "team_admin_unset",
            Body::TeamMemberAdd { .. } => "team_member_add",
            Body::TeamMemberRemove { .. } => "team_member_remove",
            Body::MemberRemove { .. } => "member_remove",
            Body::MemberSuspend { .. } => "member_suspend",
            Body::MemberReinstate { .. } => "member_reinstate",
            Body::InviteCreate { .. } => "invite_create",
            Body::InviteRevoke { .. } => "invite_revoke",
            Body::InviteAccept { .. } => "invite_accept",
            Body::ChannelCreate { .. } => "channel_create",
            Body::TeamRename { .. } => "team_rename",
            Body::TeamArchive { .. } => "team_archive",
            Body::TeamMove { .. } => "team_move",
            Body::JoinApprove { .. } => "join_approve",
            Body::JoinReject { .. } => "join_reject",
            Body::ProjectCreate { .. } => "project_create",
            Body::ProjectMemberAdd { .. } => "project_member_add",
            Body::ProjectMemberRemove { .. } => "project_member_remove",
            Body::LabelCreate { .. } => "label_create",
            Body::LabelRename { .. } => "label_rename",
            Body::LabelArchive { .. } => "label_archive",
            Body::LabelAssign { .. } => "label_assign",
            Body::LabelUnassign { .. } => "label_unassign",
            Body::DeviceSet { .. } => "device_set",
            Body::AdSettingsSet { .. } => "ad_settings_set",
            Body::DivisionCreate { .. } => "division_create",
            Body::DivisionRename { .. } => "division_rename",
            Body::DivisionArchive { .. } => "division_archive",
            Body::DivisionHeadSet { .. } => "division_head_set",
            Body::DivisionMemberAdd { .. } => "division_member_add",
            Body::DivisionMemberRemove { .. } => "division_member_remove",
            Body::ChatSettingsSet { .. } => "chat_settings_set",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Payload {
    pub v: u32,
    pub org: String,
    pub author: String,
    pub lamport: u64,
    /// Ids of the ops that were heads of the author's log when this op was
    /// made (its direct causal predecessors): sorted, unique, 64 lowercase
    /// hex each, at most `MAX_DEPS`.
    pub deps: Vec<String>,
    pub at: String,
    pub nonce: String,
    pub scope: Scope,
    pub body: Body,
}

/// An op whose format (and, on receipt, signature) has been checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedOp {
    pub id: String,
    pub signed: SignedOp,
    pub payload: Payload,
    pub at: OffsetDateTime,
}

impl VerifiedOp {
    pub fn author(&self) -> &str {
        &self.payload.author
    }

    pub fn lamport(&self) -> u64 {
        self.payload.lamport
    }

    pub fn deps(&self) -> &[String] {
        &self.payload.deps
    }

    /// Fold order: `(lamport, author, id)`.
    pub fn order_key(&self) -> (u64, &str, &str) {
        (self.payload.lamport, &self.payload.author, &self.id)
    }
}

/// Why an op was refused before storing. `code` is stable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejection {
    pub code: &'static str,
    pub detail: String,
}

impl Rejection {
    fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Rejection {
            code,
            detail: detail.into(),
        }
    }
}

/// The bytes that are signed: `"mira-op-v1\n"` followed by the payload.
pub fn signed_message(payload: &str) -> Vec<u8> {
    let mut msg = Vec::with_capacity(OP_DOMAIN.len() + payload.len());
    msg.extend_from_slice(OP_DOMAIN.as_bytes());
    msg.extend_from_slice(payload.as_bytes());
    msg
}

/// Serializes and signs a payload with the given signer.
pub fn sign_payload(payload: &Payload, sign: impl FnOnce(&[u8]) -> Signature) -> SignedOp {
    let payload = serde_json::to_string(payload).expect("payload always serializes");
    let sig = sign(&signed_message(&payload));
    SignedOp {
        payload,
        sig: hex::encode(sig.to_bytes()),
    }
}

/// Full check of an op received from anywhere: size, format of every field,
/// organization, strict Ed25519 signature, and `at` not too far in the future.
pub fn verify_op(
    op: &SignedOp,
    org_id: &str,
    now: OffsetDateTime,
) -> Result<VerifiedOp, Rejection> {
    if op.payload.len() > MAX_PAYLOAD_BYTES {
        return Err(Rejection::new(
            "too_large",
            format!(
                "isi perubahan {} byte, maksimal {MAX_PAYLOAD_BYTES}",
                op.payload.len()
            ),
        ));
    }
    if !is_lower_hex(&op.sig, 128) {
        return Err(Rejection::new(
            "bad_signature",
            "tanda tangan harus 128 karakter hex huruf kecil",
        ));
    }
    let verified = parse_op(op).map_err(|d| Rejection::new("bad_format", d))?;
    if verified.payload.org != org_id {
        return Err(Rejection::new(
            "wrong_org",
            format!("perubahan untuk organisasi lain ({})", verified.payload.org),
        ));
    }
    if !verify_signature(&verified.payload.author, &op.payload, &op.sig) {
        return Err(Rejection::new(
            "bad_signature",
            "tanda tangan tidak cocok dengan kunci pembuat",
        ));
    }
    if verified.at > now + MAX_CLOCK_AHEAD {
        return Err(Rejection::new(
            "future",
            format!(
                "waktu perubahan {} lebih dari 10 menit di depan jam laptop ini",
                verified.payload.at
            ),
        ));
    }
    Ok(verified)
}

/// Parses and format-checks an op without checking the signature or time.
/// Used for ops already verified when they were stored.
pub fn parse_op(op: &SignedOp) -> Result<VerifiedOp, String> {
    let payload: Payload = serde_json::from_str(&op.payload).map_err(|e| {
        let mut msg = format!("isi perubahan bukan JSON yang dikenal: {e}");
        msg.truncate(300);
        msg
    })?;
    let at = validate_payload(&payload)?;
    Ok(VerifiedOp {
        id: op.id(),
        signed: op.clone(),
        payload,
        at,
    })
}

fn verify_signature(author: &str, payload: &str, sig: &str) -> bool {
    let (Ok(pk), Ok(sig)) = (<[u8; 32]>::from_hex(author), <[u8; 64]>::from_hex(sig)) else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(&pk) else {
        return false;
    };
    key.verify_strict(&signed_message(payload), &Signature::from_bytes(&sig))
        .is_ok()
}

pub(crate) fn is_point(hex_key: &str) -> bool {
    <[u8; 32]>::from_hex(hex_key)
        .ok()
        .is_some_and(|b| VerifyingKey::from_bytes(&b).is_ok())
}

fn need(ok: bool, what: &str) -> Result<(), String> {
    if ok { Ok(()) } else { Err(what.to_owned()) }
}

fn id32(s: &str, field: &str) -> Result<(), String> {
    need(
        is_lower_hex(s, 32),
        &format!("{field} harus 32 karakter hex huruf kecil"),
    )
}

fn key64(s: &str, field: &str) -> Result<(), String> {
    need(
        is_lower_hex(s, 64),
        &format!("{field} harus 64 karakter hex huruf kecil"),
    )
}

/// Checks every field of the payload; returns the parsed `at`.
pub fn validate_payload(p: &Payload) -> Result<OffsetDateTime, String> {
    need(p.v == OP_VERSION, "versi perubahan tidak dikenal")?;
    id32(&p.org, "org")?;
    key64(&p.author, "author")?;
    need(
        (1..=MAX_LAMPORT).contains(&p.lamport),
        "lamport harus 1 atau lebih",
    )?;
    need(
        p.deps.len() <= MAX_DEPS,
        "deps berisi lebih dari 32 perubahan",
    )?;
    for dep in &p.deps {
        key64(dep, "deps")?;
    }
    need(
        p.deps.windows(2).all(|w| w[0] < w[1]),
        "deps harus urut dan tanpa id ganda",
    )?;
    let at = parse_time(&p.at).ok_or("at bukan waktu RFC 3339")?;
    id32(&p.nonce, "nonce")?;
    if let Scope::Team { team } = &p.scope {
        id32(team, "scope.team")?;
    }

    let org_scope = |p: &Payload| need(p.scope == Scope::Org, "perubahan ini harus ber-scope org");
    match &p.body {
        Body::ProfileSet { name } => {
            org_scope(p)?;
            need(is_canonical_display_name(name), "nama tampilan tidak valid")?;
        }
        Body::TeamCreate { team, name } => {
            org_scope(p)?;
            id32(team, "team")?;
            need(is_canonical_team_name(name), "nama tim tidak valid")?;
        }
        Body::TeamDelete { team } => {
            org_scope(p)?;
            id32(team, "team")?;
        }
        Body::SuperadminAdd { member }
        | Body::SuperadminRemove { member }
        | Body::MemberRemove { member }
        | Body::MemberSuspend { member }
        | Body::MemberReinstate { member } => {
            org_scope(p)?;
            key64(member, "member")?;
        }
        Body::TeamAdminSet { team, member }
        | Body::TeamAdminUnset { team, member }
        | Body::TeamMemberAdd { team, member }
        | Body::TeamMemberRemove { team, member } => {
            org_scope(p)?;
            id32(team, "team")?;
            key64(member, "member")?;
        }
        Body::InviteCreate {
            invite,
            team,
            role,
            projects,
            expires,
            single_use: _,
            tag,
            key,
            key_sig,
        } => {
            org_scope(p)?;
            id32(invite, "invite")?;
            need(is_lower_hex(key_sig, 128), "key_sig harus 128 karakter hex")?;
            id32(team, "team")?;
            match role {
                InviteRole::Guest => {
                    need(
                        (1..=MAX_GUEST_PROJECTS).contains(&projects.len()),
                        "undangan Tamu wajib berisi 1 sampai 50 proyek",
                    )?;
                    for project in projects {
                        id32(project, "projects")?;
                    }
                    let unique: BTreeSet<&String> = projects.iter().collect();
                    need(unique.len() == projects.len(), "projects berisi id ganda")?;
                }
                InviteRole::TeamAdmin | InviteRole::Member => {
                    need(projects.is_empty(), "projects hanya untuk undangan Tamu")?;
                }
            }
            let exp = parse_time(expires).ok_or("expires bukan waktu RFC 3339")?;
            need(exp > at, "expires harus sesudah at")?;
            need(
                exp <= at + MAX_INVITE_VALIDITY + CLOCK_SLACK,
                "masa berlaku undangan paling lama 7 hari",
            )?;
            need(is_tag(tag), "tag harus 8 karakter Crockford base32")?;
            key64(key, "key")?;
            need(is_point(key), "key bukan kunci Ed25519 yang sah")?;
        }
        Body::InviteRevoke { invite } => {
            org_scope(p)?;
            id32(invite, "invite")?;
        }
        Body::InviteAccept {
            invite,
            member,
            name,
            invite_sig,
            member_sig,
        } => {
            org_scope(p)?;
            id32(invite, "invite")?;
            key64(member, "member")?;
            need(is_canonical_display_name(name), "nama tampilan tidak valid")?;
            need(
                is_lower_hex(invite_sig, 128),
                "invite_sig harus 128 karakter hex",
            )?;
            need(
                is_lower_hex(member_sig, 128),
                "member_sig harus 128 karakter hex",
            )?;
        }
        Body::ChannelCreate {
            channel,
            team,
            name,
        } => {
            id32(channel, "channel")?;
            id32(team, "team")?;
            need(
                p.scope.team() == Some(team.as_str()),
                "channel_create harus ber-scope tim yang sama",
            )?;
            need(is_valid_channel_name(name), "nama channel tidak valid")?;
        }
        Body::TeamRename { team, name } => {
            org_scope(p)?;
            id32(team, "team")?;
            need(is_canonical_team_name(name), "nama departemen tidak valid")?;
        }
        Body::TeamArchive { team, archived: _ } => {
            org_scope(p)?;
            id32(team, "team")?;
        }
        Body::TeamMove { team, member } => {
            org_scope(p)?;
            id32(team, "team")?;
            key64(member, "member")?;
        }
        Body::JoinApprove {
            request,
            request_sig,
        }
        | Body::JoinReject {
            request,
            request_sig,
        } => {
            org_scope(p)?;
            need(
                is_lower_hex(request_sig, 128),
                "request_sig harus 128 karakter hex",
            )?;
            let req = super::join::parse_request_payload(request)?;
            need(
                req.org == p.org,
                "permintaan bergabung untuk organisasi lain",
            )?;
        }
        Body::ProjectCreate {
            project,
            team,
            creator,
            nonce,
            members,
            division,
        } => {
            org_scope(p)?;
            id32(project, "project")?;
            if let Some(team) = team {
                id32(team, "team")?;
            }
            if let Some(division) = division {
                id32(division, "division")?;
                need(team.is_some(), "proyek divisi wajib punya departemen")?;
            }
            key64(creator, "creator")?;
            id32(nonce, "nonce proyek")?;
            need(
                members.len() <= MAX_PROJECT_INITIAL_MEMBERS,
                "anggota awal proyek paling banyak 200 orang",
            )?;
            for m in members {
                key64(m, "members")?;
            }
            need(
                members.windows(2).all(|w| w[0] < w[1]),
                "anggota awal proyek harus urut dan tanpa ganda",
            )?;
        }
        Body::ProjectMemberAdd { project, member }
        | Body::ProjectMemberRemove { project, member } => {
            org_scope(p)?;
            id32(project, "project")?;
            key64(member, "member")?;
        }
        Body::LabelCreate { label, name } | Body::LabelRename { label, name } => {
            org_scope(p)?;
            id32(label, "label")?;
            need(is_canonical_label_name(name), "nama label tidak valid")?;
        }
        Body::LabelArchive { label, archived: _ } => {
            org_scope(p)?;
            id32(label, "label")?;
        }
        Body::LabelAssign { label, member } | Body::LabelUnassign { label, member } => {
            org_scope(p)?;
            id32(label, "label")?;
            key64(member, "member")?;
        }
        Body::DeviceSet {
            laptop,
            os,
            app_version,
        } => {
            org_scope(p)?;
            need(is_valid_laptop_name(laptop), "nama laptop tidak valid")?;
            need(is_valid_os_name(os), "nama sistem operasi tidak valid")?;
            need(is_valid_app_version(app_version), "versi Mira tidak valid")?;
        }
        Body::AdSettingsSet { domain, ou_map } => {
            org_scope(p)?;
            need(
                domain.is_empty() || super::join::is_valid_ad_domain(domain),
                "domain AD tidak valid",
            )?;
            super::join::check_ou_map(ou_map)?;
        }
        Body::DivisionCreate {
            division,
            team,
            name,
        } => {
            org_scope(p)?;
            id32(division, "division")?;
            id32(team, "team")?;
            need(is_canonical_team_name(name), "nama divisi tidak valid")?;
        }
        Body::DivisionRename { division, name } => {
            org_scope(p)?;
            id32(division, "division")?;
            need(is_canonical_team_name(name), "nama divisi tidak valid")?;
        }
        Body::DivisionArchive {
            division,
            archived: _,
        } => {
            org_scope(p)?;
            id32(division, "division")?;
        }
        Body::DivisionHeadSet {
            division,
            member,
            head: _,
        }
        | Body::DivisionMemberAdd { division, member }
        | Body::DivisionMemberRemove { division, member } => {
            org_scope(p)?;
            id32(division, "division")?;
            key64(member, "member")?;
        }
        Body::ChatSettingsSet {
            team,
            division,
            pinned,
            announce: _,
        } => {
            org_scope(p)?;
            id32(team, "team")?;
            if let Some(division) = division {
                id32(division, "division")?;
            }
            need(
                super::division::is_valid_pinned_note(pinned),
                "catatan disematkan tidak valid",
            )?;
        }
    }
    Ok(at)
}
