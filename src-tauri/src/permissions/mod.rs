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
//! The source of truth is `organizations` + `org_ops`. The tables `members`,
//! `teams`, `team_members`, `invites`, `guest_access` and `channels` are
//! rewritten from the fold in the same transaction that changes `org_ops`.

mod actions;
mod fold;
pub mod format;
mod invite;
mod op;
mod store;
mod view;

pub(crate) use actions::ensure_profile_in;
pub use actions::{
    JoinAcceptedData, JoinRejectCode, add_superadmin, add_team_member, author_op, create_invite,
    create_team, delete_team, ensure_profile_op, install_joined_org, join_accept, join_lookup,
    redeem_as_member, remove_member, remove_superadmin, remove_team_member, revoke_invite,
    set_display_name_op, set_team_admin,
};
pub use fold::{
    ChannelState, FoldResult, GuestAccess, InviteState, MemberKind, MemberState, MemberStatus,
    OrgState, Outcome, Reason, TeamMember, TeamRole, TeamState, UMUM_CHANNEL_NAME, fold,
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
pub use view::{
    CanView, ChannelView, Directory, InviteStatus, InviteView, MeView, MemberTeamView, MemberView,
    TeamMemberView, TeamView, Validity, build_directory, directory, invite_status,
};

#[cfg(test)]
mod tests;
