//! Signed membership log: ops, the fold, invites, per-team filtering and the
//! directory shown to the frontend (docs/plans/tahap-1.md, section 1).
//!
//! Every membership change is an op signed by the laptop that made it. The
//! state (members, superadmins, teams, invites, guest access, channels) is
//! recomputed from the organization's genesis record plus every stored op in
//! `(lamport, author, id)` order. Ops whose author had no right to make them
//! at their position are kept but marked `rejected`; they may become valid
//! when an earlier op arrives later. Laptops with the same ops compute the
//! same state.
//!
//! Each op lists in `deps` the ops its author had seen. A revocation wins
//! over ops made concurrently with it that used the right it takes away,
//! whatever lamport they carry (`causal.rs`).
//!
//! The source of truth is `organizations` + `org_ops`. The tables `members`,
//! `teams`, `team_members`, `invites`, `guest_access` and `channels` are
//! rewritten from the fold in the same transaction that changes `org_ops`.

mod actions;
mod causal;
mod fold;
pub mod format;
mod invite;
pub mod join;
mod join_store;
mod op;
mod org_actions;
mod query;
mod store;
mod view;

pub(crate) use actions::ensure_profile_in;
pub use actions::{
    JoinAcceptedData, JoinRejectCode, add_superadmin, add_team_member, author_op, create_invite,
    create_team, delete_team, ensure_profile_op, install_joined_org, join_accept, join_lookup,
    redeem_as_member, remove_member, remove_superadmin, remove_team_member, revoke_invite,
    set_display_name_op, set_team_admin,
};
pub use causal::heads;
pub use fold::{
    AdSettings, ChannelState, DeviceInfo, FoldResult, GuestAccess, InviteState, JoinDecision,
    LabelState, MemberKind, MemberState, MemberStatus, OrgState, Outcome, ProjectMember,
    ProjectState, Reason, TeamMember, TeamRole, TeamState, UMUM_CHANNEL_NAME, fold, project_id_for,
    umum_channel_id,
};
pub use invite::{
    JoinProofData, NormalizedCode, build_join_proof, generate_invite_code, invite_key_message,
    invite_public_key, invite_signing_key, normalize_code, redeem_message, sign_invite_key,
};
pub use op::{
    Body, InviteRole, MAX_PAYLOAD_BYTES, OP_DOMAIN, Payload, Rejection, Scope, SignedOp,
    VerifiedOp, op_id, verify_op,
};
pub use store::{
    IngestReport, Membership, PeerAuthState, REJECTED_KEEP, RejectedChange, ingest, load_op,
    load_ops, load_state, log_rejection, max_lamport, may_receive, membership, missing_op_ids,
    op_ids_for, ops_for, peer_auth, rejected_changes,
};
pub use join::{
    AdBlocker, JOIN_AD_SINCE, JoinAdClaim, JoinExtras, JoinRequestPayload, SignedJoinRequest,
    ad_blockers, ad_settings_allowed, join_ad_allowed, matching_code, org_fingerprint,
    org_fingerprint_short, request_code,
};
pub use join_store::{
    DeviceProfile, JoinAdView, JoinDepartment, JoinInfo, JoinIngest, JoinRecord, JoinRequestRefusal,
    JoinRequestView, JoinStatusAnswer, JoinTarget, MAX_PENDING_PER_IP, MAX_PENDING_REQUESTS,
    OutgoingJoinRequest, OutgoingStatus, Seen, cancel_join_request, create_join_request,
    ingest_join_records, install_approved_org, ip_group, join_info, join_record_ids_for,
    join_records_for, join_request_id, join_status_for, mark_join_rejected, mark_join_sent,
    open_departments, outgoing_join_request, pending_join_requests, prune_join_requests,
    receive_join_request, unknown_join_record_ids,
};
pub(crate) use org_actions::{register_own_project_in, register_project_for_in};
pub use org_actions::{
    AD_SETTINGS_GATE_CLOSED, REQUESTER_OUTDATED, add_project_member, approve_join, assign_label,
    create_label, ensure_device_op, move_member, recompute, reject_join, remove_project_member,
    rename_department, rename_label, require_state, set_ad_settings, set_department_archived,
    set_label_archived,
};
pub use query::*;
pub use view::{
    CanView, ChannelView, Directory, InviteStatus, InviteView, MeView, MemberTeamView, MemberView,
    TeamMemberView, TeamView, Validity, build_directory, directory, invite_status,
};

#[cfg(test)]
mod tests;
