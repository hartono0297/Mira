//! Storage, authoring, joining, filtering and convergence with real
//! databases (one temp folder per laptop).

use rusqlite::Connection;
use time::{Duration, OffsetDateTime};

use super::sim::rand_hex16;
use crate::db;
use crate::error::AppResult;
use crate::identity::{self, Identity, MemoryKeyStore};
use crate::org::{self, OrgInfo, Role};
use crate::permissions::{
    self as p, Body, InviteRole, InviteStatus, Membership, PeerAuthState, Scope, SignedOp,
    TeamRole, Validity,
};

struct Node {
    _tmp: tempfile::TempDir,
    conn: Connection,
    id: Identity,
}

impl Node {
    fn new(name: &str) -> Node {
        let tmp = tempfile::tempdir().unwrap();
        let mut conn = db::open(tmp.path()).unwrap();
        let mut id = identity::ensure_identity(&conn, &MemoryKeyStore::new()).unwrap();
        identity::save_display_name(&mut conn, &mut id, name).unwrap();
        Node {
            _tmp: tmp,
            conn,
            id,
        }
    }

    fn founder(name: &str) -> Node {
        let mut n = Node::new(name);
        org::create_organization(&mut n.conn, &n.id, "CV Maju Jaya").unwrap();
        n
    }

    fn pk(&self) -> String {
        self.id.public_key_hex().to_owned()
    }

    fn state(&self) -> p::OrgState {
        p::load_state(&self.conn).unwrap().unwrap()
    }

    fn op_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .conn
            .prepare("SELECT id FROM org_ops")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        ids.sort();
        ids
    }

    fn statuses(&self) -> Vec<(String, String, Option<String>)> {
        self.conn
            .prepare("SELECT id, status, reject_reason FROM org_ops ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    fn create_team(&mut self, name: &str) -> String {
        p::create_team(&mut self.conn, &self.id, name, now())
            .unwrap()
            .id
    }

    fn invite(&mut self, team: &str, role: InviteRole, validity: Validity) -> String {
        let projects = if role == InviteRole::Guest {
            vec![rand_hex16()]
        } else {
            vec![]
        };
        p::create_invite(
            &mut self.conn,
            &self.id,
            team,
            role,
            projects,
            validity,
            now(),
        )
        .unwrap()
        .1
    }
}

fn now() -> OffsetDateTime {
    OffsetDateTime::now_utc()
}

/// Sends `from` everything `to` may receive (as the network sync does).
fn sync(from: &Node, to: &mut Node) -> usize {
    let state = from.state();
    let ids = p::op_ids_for(&from.conn, &state, &to.pk()).unwrap();
    let missing = p::missing_op_ids(&to.conn, &ids).unwrap();
    let ops = p::ops_for(&from.conn, &state, &to.pk(), &missing).unwrap();
    p::ingest(&mut to.conn, Some(&from.pk()), ops, now())
        .unwrap()
        .new_ops
}

fn sync_both(a: &mut Node, b: &mut Node) {
    sync(a, b);
    sync(b, a);
}

/// Full join flow through a member laptop.
fn join(
    member: &mut Node,
    joiner: &mut Node,
    code: &str,
    at: OffsetDateTime,
) -> AppResult<OrgInfo> {
    let code = p::normalize_code(code)?;
    let (org, invite) =
        p::join_lookup(&member.conn, code.tag(), at).map_err(|c| c.to_app_error())?;
    let proof = p::build_join_proof(&code, &org, &invite, &joiner.id)?;
    let accepted = p::join_accept(
        &mut member.conn,
        &member.id,
        &joiner.pk(),
        &invite,
        &proof,
        at,
    )
    .map_err(|c| c.to_app_error())?;
    p::install_joined_org(
        &mut joiner.conn,
        &joiner.id,
        accepted.org,
        accepted.ops,
        &code,
        at,
    )
}

#[test]
fn founder_gets_profile_op_and_derived_tables() {
    let f = Node::founder("Sari");
    let ops = p::load_ops(&f.conn).unwrap();
    assert_eq!(ops.len(), 1);
    assert_eq!(
        ops[0].payload.body,
        Body::ProfileSet {
            name: "Sari".into()
        }
    );
    assert_eq!(ops[0].lamport(), 1);
    let (name, role, sa, status): (String, String, i64, String) = f
        .conn
        .query_row(
            "SELECT display_name, role, is_superadmin, status FROM members WHERE public_key = ?1",
            [f.pk()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!(
        (name.as_str(), role.as_str(), sa, status.as_str()),
        ("Sari", "superadmin", 1, "active")
    );
    let channels: i64 = f
        .conn
        .query_row(
            "SELECT count(*) FROM channels WHERE team_id IS NULL AND name = 'umum'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(channels, 1);
    assert_eq!(p::membership(&f.conn, &f.id).unwrap(), Membership::Active);
    assert_eq!(
        org::get_organization(&f.conn, &f.id).unwrap().unwrap().role,
        Role::Superadmin
    );
    // Idempotent.
    let mut f = f;
    assert_eq!(
        p::ensure_profile_op(&mut f.conn, &f.id, now()).unwrap(),
        None
    );
}

#[test]
fn tahap_0_org_gets_profile_op_at_startup() {
    let mut f = Node::founder("Sari");
    f.conn.execute("DELETE FROM org_ops", []).unwrap();
    assert!(p::load_ops(&f.conn).unwrap().is_empty());
    let op = p::ensure_profile_op(&mut f.conn, &f.id, now()).unwrap();
    assert!(op.is_some());
    assert_eq!(
        p::ensure_profile_op(&mut f.conn, &f.id, now()).unwrap(),
        None
    );

    identity::save_display_name(&mut f.conn, &mut f.id, "Sari W").unwrap();
    assert!(
        p::set_display_name_op(&mut f.conn, &f.id, now())
            .unwrap()
            .is_some()
    );
    assert_eq!(
        p::set_display_name_op(&mut f.conn, &f.id, now()).unwrap(),
        None
    );
    let d = p::directory(&f.conn, &f.id, now()).unwrap();
    assert_eq!(d.members[0].display_name, "Sari W");
}

#[test]
fn author_op_refuses_unauthorized_changes_and_stores_nothing() {
    let mut f = Node::founder("Sari");
    let team = f.create_team("Tim Desain");
    let mut a = Node::new("Ani");
    {
        let code = f.invite(&team, InviteRole::Member, Validity::Once);
        join(&mut f, &mut a, &code, now())
    }
    .unwrap();
    let before = a.op_ids();

    let err = p::create_team(&mut a.conn, &a.id, "Tim Liar", now()).unwrap_err();
    assert_eq!(err.code(), "forbidden");
    let err = p::create_invite(
        &mut a.conn,
        &a.id,
        &team,
        InviteRole::Member,
        vec![],
        Validity::H24,
        now(),
    )
    .unwrap_err();
    assert_eq!(err.code(), "forbidden");
    let err = p::remove_superadmin(&mut f.conn, &f.id, f.id.public_key_hex(), now()).unwrap_err();
    assert_eq!(err.code(), "last_superadmin");
    let err = p::remove_member(&mut f.conn, &f.id, f.id.public_key_hex(), now()).unwrap_err();
    assert_eq!(err.code(), "last_superadmin");
    let err = p::delete_team(&mut f.conn, &f.id, &rand_hex16(), now()).unwrap_err();
    assert_eq!(err.code(), "not_found");
    let err = p::add_team_member(&mut f.conn, &f.id, &team, "bukan-kunci", now()).unwrap_err();
    assert_eq!(err.code(), "not_found");
    assert_eq!(a.op_ids(), before, "nothing stored");

    // Name changes from members are allowed.
    identity::save_display_name(&mut a.conn, &mut a.id, "Ani Lestari").unwrap();
    assert!(
        p::set_display_name_op(&mut a.conn, &a.id, now())
            .unwrap()
            .is_some()
    );
}

#[test]
fn create_team_makes_team_and_channel() {
    let mut f = Node::founder("Sari");
    let view = p::create_team(&mut f.conn, &f.id, "  Tim Desain Grafis ", now()).unwrap();
    assert_eq!(view.name, "Tim Desain Grafis");
    assert!(view.members.is_empty());
    let d = p::directory(&f.conn, &f.id, now()).unwrap();
    assert_eq!(d.teams.len(), 1);
    // The superadmin made the channel op, so it is listed even outside the team.
    let ch = d
        .channels
        .iter()
        .find(|c| c.team_id.as_deref() == Some(view.id.as_str()))
        .unwrap();
    assert_eq!(ch.name, "tim-desain-grafis");
    assert_eq!(
        p::create_team(&mut f.conn, &f.id, "A", now())
            .unwrap_err()
            .code(),
        "invalid_name"
    );
    let scope: Option<String> = f
        .conn
        .query_row(
            "SELECT scope_team FROM org_ops WHERE kind = 'channel_create'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(scope.as_deref(), Some(view.id.as_str()));
}

#[test]
fn join_flow_admits_member_with_role_and_syncs() {
    let mut f = Node::founder("Sari");
    let team = f.create_team("Tim Desain");
    let code = f.invite(&team, InviteRole::TeamAdmin, Validity::D7);
    let mut a = Node::new("Ani");
    let info = join(
        &mut f,
        &mut a,
        &code.to_lowercase().replace('-', " "),
        now(),
    )
    .unwrap();
    assert_eq!(info.role, Role::TeamAdmin);
    assert_eq!(info.id, f.state().org.id);
    assert_eq!(p::membership(&a.conn, &a.id).unwrap(), Membership::Active);
    assert_eq!(
        org::get_organization(&a.conn, &a.id).unwrap().unwrap().role,
        Role::TeamAdmin
    );
    assert_eq!(
        a.state(),
        f.state(),
        "joiner received everything it may see"
    );
    assert_eq!(a.op_ids(), f.op_ids());

    let received_from: Option<String> = a
        .conn
        .query_row(
            "SELECT received_from FROM org_ops WHERE kind = 'invite_accept'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(received_from, Some(f.pk()));

    // A team admin can invite members; Budi joins through Ani's laptop.
    let code_b = a.invite(&team, InviteRole::Member, Validity::Once);
    let mut b = Node::new("Budi");
    let info = join(&mut a, &mut b, &code_b, now()).unwrap();
    assert_eq!(info.role, Role::Member);
    sync_both(&mut a, &mut f);
    assert_eq!(f.state(), a.state());
    assert_eq!(f.state(), b.state());

    // Single use: a second laptop cannot use the same code.
    let mut c = Node::new("Citra");
    assert_eq!(
        join(&mut f, &mut c, &code_b, now()).unwrap_err().code(),
        "invite_used"
    );
    assert_eq!(p::membership(&c.conn, &c.id).unwrap(), Membership::None);
}

#[test]
fn join_rejections() {
    let mut f = Node::founder("Sari");
    let team = f.create_team("Tim Desain");
    let mut x = Node::new("Xena");

    // Unknown tag, bad code.
    assert_eq!(
        join(&mut f, &mut x, "ABCD-EFGH-JKMN-PQRS-TVWX", now())
            .unwrap_err()
            .code(),
        "invite_not_found"
    );
    assert_eq!(
        join(&mut f, &mut x, "ABCD", now()).unwrap_err().code(),
        "invite_invalid"
    );

    // Expired according to the member laptop's clock.
    let code = f.invite(&team, InviteRole::Member, Validity::H24);
    let late = now() + Duration::hours(25);
    assert_eq!(
        join(&mut f, &mut x, &code, late).unwrap_err().code(),
        "invite_expired"
    );

    // Revoked.
    let code2 = f.invite(&team, InviteRole::Member, Validity::D7);
    let d = p::directory(&f.conn, &f.id, now()).unwrap();
    let inv2 = d
        .invites
        .iter()
        .find(|i| i.validity == Validity::D7)
        .unwrap()
        .id
        .clone();
    p::revoke_invite(&mut f.conn, &f.id, &inv2, now()).unwrap();
    assert_eq!(
        join(&mut f, &mut x, &code2, now()).unwrap_err().code(),
        "invite_revoked"
    );

    // Deleted team.
    let team2 = f.create_team("Tim Hilang");
    let code3 = f.invite(&team2, InviteRole::Member, Validity::D7);
    p::delete_team(&mut f.conn, &f.id, &team2, now()).unwrap();
    assert_eq!(
        join(&mut f, &mut x, &code3, now()).unwrap_err().code(),
        "invite_revoked"
    );

    // Proof whose member is not the TLS key, and a proof from a wrong code.
    let code4 = p::normalize_code(&f.invite(&team, InviteRole::Member, Validity::D7)).unwrap();
    let (org, invite) = p::join_lookup(&f.conn, code4.tag(), now()).unwrap();
    let proof = p::build_join_proof(&code4, &org, &invite, &x.id).unwrap();
    let other = Node::new("Lain");
    assert_eq!(
        p::join_accept(&mut f.conn, &f.id, &other.pk(), &invite, &proof, now()).unwrap_err(),
        p::JoinRejectCode::InvalidProof
    );
    let wrong = p::normalize_code(&p::generate_invite_code()).unwrap();
    let bad = p::build_join_proof(&wrong, &org, &invite, &x.id).unwrap();
    assert_eq!(
        p::join_accept(&mut f.conn, &f.id, &x.pk(), &invite, &bad, now()).unwrap_err(),
        p::JoinRejectCode::InvalidProof
    );
    let mut tampered = proof.clone();
    tampered.name = "Ratu".into();
    assert_eq!(
        p::join_accept(&mut f.conn, &f.id, &x.pk(), &invite, &tampered, now()).unwrap_err(),
        p::JoinRejectCode::InvalidProof
    );
    assert_eq!(p::membership(&x.conn, &x.id).unwrap(), Membership::None);
    assert!(!f.state().is_active(&x.pk()));

    // The real proof works.
    let accepted = p::join_accept(&mut f.conn, &f.id, &x.pk(), &invite, &proof, now()).unwrap();
    // Installing with a different code is refused and leaves nothing behind.
    let err = p::install_joined_org(
        &mut x.conn,
        &x.id,
        accepted.org.clone(),
        accepted.ops.clone(),
        &wrong,
        now(),
    )
    .unwrap_err();
    assert_eq!(err.code(), "network");
    assert_eq!(org::load_organization(&x.conn).unwrap(), None);
    // Tampered organization record.
    let mut forged = accepted.org.clone();
    forged.name = "CV Palsu".into();
    let err = p::install_joined_org(
        &mut x.conn,
        &x.id,
        forged,
        accepted.ops.clone(),
        &code4,
        now(),
    )
    .unwrap_err();
    assert_eq!(err.code(), "network");
    // Ops that do not admit this laptop.
    let without: Vec<SignedOp> = accepted
        .ops
        .iter()
        .filter(|op| !op.payload.contains("invite_accept"))
        .cloned()
        .collect();
    let err = p::install_joined_org(
        &mut x.conn,
        &x.id,
        accepted.org.clone(),
        without,
        &code4,
        now(),
    )
    .unwrap_err();
    assert_eq!(err.code(), "network");
    assert_eq!(org::load_organization(&x.conn).unwrap(), None);
    p::install_joined_org(
        &mut x.conn,
        &x.id,
        accepted.org.clone(),
        accepted.ops.clone(),
        &code4,
        now(),
    )
    .unwrap();
    let err = p::install_joined_org(
        &mut x.conn,
        &x.id,
        accepted.org,
        accepted.ops,
        &code4,
        now(),
    )
    .unwrap_err();
    assert_eq!(err.code(), "already_in_org");
}

#[test]
fn concurrent_single_use_accepts_on_two_laptops_converge() {
    let mut f = Node::founder("Sari");
    let team = f.create_team("Tim Desain");
    let mut a = Node::new("Ani");
    {
        let code = f.invite(&team, InviteRole::Member, Validity::Once);
        join(&mut f, &mut a, &code, now())
    }
    .unwrap();
    let code = f.invite(&team, InviteRole::Member, Validity::Once);
    sync(&f, &mut a);

    // Network split: X joins through F, Y through A, with the same code.
    let (mut x, mut y) = (Node::new("Xena"), Node::new("Yudi"));
    join(&mut f, &mut x, &code, now()).unwrap();
    join(&mut a, &mut y, &code, now()).unwrap();

    sync_both(&mut f, &mut a);
    assert_eq!(f.state(), a.state());
    assert_eq!(f.statuses(), a.statuses());
    let s = f.state();
    let x_in = s.is_active(&x.pk());
    let y_in = s.is_active(&y.pk());
    assert!(x_in ^ y_in, "exactly one wins");
    let rejected: Vec<_> = f
        .statuses()
        .into_iter()
        .filter(|(_, st, _)| st == "rejected")
        .collect();
    assert_eq!(rejected.len(), 1);
    assert_eq!(rejected[0].2.as_deref(), Some("invite_used"));

    // The winner keeps syncing; the loser is no longer offered anything.
    let (winner, loser) = if x_in {
        (&mut x, &mut y)
    } else {
        (&mut y, &mut x)
    };
    sync(&f, winner);
    assert_eq!(
        p::membership(&winner.conn, &winner.id).unwrap(),
        Membership::Active
    );
    assert!(
        p::op_ids_for(&f.conn, &f.state(), &loser.pk())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn removed_member_is_cut_off() {
    let mut f = Node::founder("Sari");
    let team = f.create_team("Tim Desain");
    let mut a = Node::new("Ani");
    {
        let code = f.invite(&team, InviteRole::Member, Validity::Once);
        join(&mut f, &mut a, &code, now())
    }
    .unwrap();
    p::remove_member(&mut f.conn, &f.id, &a.pk(), now()).unwrap();

    let s = f.state();
    let PeerAuthState::Removed { removal_op } = p::peer_auth(&s, &a.pk()) else {
        panic!("expected removed");
    };
    let removal = p::load_op(&f.conn, removal_op.as_deref().unwrap())
        .unwrap()
        .unwrap();
    assert!(p::op_ids_for(&f.conn, &s, &a.pk()).unwrap().is_empty());
    assert!(
        p::ops_for(&f.conn, &s, &a.pk(), &f.op_ids())
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        p::peer_auth(&s, &f.pk()),
        PeerAuthState::Member {
            display_name: "Sari".into()
        }
    );
    assert_eq!(
        p::peer_auth(&s, &rand_hex16().repeat(2)),
        PeerAuthState::Unknown
    );

    // A learns about it from the last message.
    p::ingest(&mut a.conn, Some(&f.pk()), vec![removal], now()).unwrap();
    assert_eq!(p::membership(&a.conn, &a.id).unwrap(), Membership::Removed);
    assert_eq!(
        p::create_team(&mut a.conn, &a.id, "Tim X", now())
            .unwrap_err()
            .code(),
        "removed"
    );
    let d = p::directory(&a.conn, &a.id, now()).unwrap();
    assert!(!d.can.create_team && d.can.manage_team_ids.is_empty());
    assert!(d.channels.is_empty());
    let removed = d.members.iter().find(|m| m.public_key == a.pk()).unwrap();
    assert_eq!(serde_json::to_value(removed.status).unwrap(), "removed");
    assert_eq!(
        d.members.last().unwrap().public_key,
        a.pk(),
        "removed members last"
    );
}

#[test]
fn ops_from_a_removed_member_are_stored_as_rejected() {
    let mut f = Node::founder("Sari");
    let team = f.create_team("Tim Desain");
    let mut a = Node::new("Ani");
    {
        let code = f.invite(&team, InviteRole::Member, Validity::Once);
        join(&mut f, &mut a, &code, now())
    }
    .unwrap();
    // A changes its name while F removes it concurrently.
    identity::save_display_name(&mut a.conn, &mut a.id, "Ani Baru").unwrap();
    p::set_display_name_op(&mut a.conn, &a.id, now())
        .unwrap()
        .unwrap();
    p::remove_member(&mut f.conn, &f.id, &a.pk(), now()).unwrap();
    // Push A's op to F directly (as the last message before closing).
    let a_state = a.state();
    let ids = p::op_ids_for(&a.conn, &a_state, &f.pk()).unwrap();
    let ops = p::ops_for(&a.conn, &a_state, &f.pk(), &ids).unwrap();
    let report = p::ingest(&mut f.conn, Some(&a.pk()), ops, now()).unwrap();
    assert_eq!(report.new_ops, 1);
    let st = f.statuses();
    let rejected: Vec<_> = st.iter().filter(|(_, s, _)| s == "rejected").collect();
    // Both ops have the same lamport; whichever is ordered first decides.
    let name = f
        .state()
        .member(&a.pk())
        .unwrap()
        .display_name
        .clone()
        .unwrap();
    if rejected.is_empty() {
        assert_eq!(name, "Ani Baru");
    } else {
        assert_eq!(rejected[0].2.as_deref(), Some("author_not_active"));
        assert_eq!(name, "Ani");
    }
}

#[test]
fn team_content_only_goes_to_team_members_and_author() {
    let mut f = Node::founder("Sari");
    let team_a = f.create_team("Tim A");
    let mut a = Node::new("Ani");
    {
        let code = f.invite(&team_a, InviteRole::TeamAdmin, Validity::Once);
        join(&mut f, &mut a, &code, now())
    }
    .unwrap();
    // Another superadmin outside team B.
    p::add_superadmin(&mut f.conn, &f.id, &a.pk(), now()).unwrap();
    sync(&f, &mut a);
    let team_b = a.create_team("Tim B");
    sync(&a, &mut f);
    let mut b = Node::new("Budi");
    let code_b = a.invite(&team_b, InviteRole::Member, Validity::Once);
    join(&mut a, &mut b, &code_b, now()).unwrap();
    sync_both(&mut a, &mut f);
    let mut m = Node::new("Mira");
    {
        let code = f.invite(&team_a, InviteRole::Member, Validity::Once);
        join(&mut f, &mut m, &code, now())
    }
    .unwrap();
    sync_both(&mut a, &mut f);

    let channel_b: String = a
        .conn
        .query_row(
            "SELECT id FROM org_ops WHERE kind = 'channel_create' AND scope_team = ?1",
            [&team_b],
            |r| r.get(0),
        )
        .unwrap();
    let s = a.state();
    // M is only in team A.
    assert!(
        !p::op_ids_for(&a.conn, &s, &m.pk())
            .unwrap()
            .contains(&channel_b)
    );
    assert!(
        p::ops_for(&a.conn, &s, &m.pk(), std::slice::from_ref(&channel_b))
            .unwrap()
            .is_empty()
    );
    // F is superadmin but not in team B: no team content.
    assert!(
        !p::op_ids_for(&a.conn, &s, &f.pk())
            .unwrap()
            .contains(&channel_b)
    );
    assert!(!f.op_ids().contains(&channel_b));
    // B is in team B.
    assert!(
        p::op_ids_for(&a.conn, &s, &b.pk())
            .unwrap()
            .contains(&channel_b)
    );
    assert!(b.op_ids().contains(&channel_b));
    // The author always gets its own op.
    let channel_a: String = f
        .conn
        .query_row(
            "SELECT id FROM org_ops WHERE kind = 'channel_create' AND scope_team = ?1",
            [&team_a],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        p::op_ids_for(&a.conn, &s, &f.pk())
            .unwrap()
            .contains(&channel_a)
    );
    // Org-scope ops go to everyone active.
    let profile_ids: Vec<String> = f
        .conn
        .prepare("SELECT id FROM org_ops WHERE scope_team IS NULL")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let for_m = p::op_ids_for(&f.conn, &f.state(), &m.pk()).unwrap();
    assert!(profile_ids.iter().all(|id| for_m.contains(id)));

    // Directory channels follow the same rule.
    let d = p::directory(&f.conn, &f.id, now()).unwrap();
    assert!(
        d.channels
            .iter()
            .all(|c| c.team_id.as_deref() != Some(team_b.as_str()))
    );
    let d = p::directory(&b.conn, &b.id, now()).unwrap();
    assert!(
        d.channels
            .iter()
            .any(|c| c.team_id.as_deref() == Some(team_b.as_str()))
    );
    assert!(
        d.channels
            .iter()
            .any(|c| c.team_id.is_none() && c.name == "umum")
    );
}

#[test]
fn late_arrival_in_the_database_flips_status() {
    let mut f = Node::founder("Sari");
    let mut a = Node::new("Ani");
    let team = f.create_team("Tim A");
    {
        let code = f.invite(&team, InviteRole::Member, Validity::Once);
        join(&mut f, &mut a, &code, now())
    }
    .unwrap();
    let t2 = f.create_team("Tim B");
    p::add_team_member(&mut f.conn, &f.id, &t2, &a.pk(), now()).unwrap();
    let s = f.state();
    let ids = p::op_ids_for(&f.conn, &s, &a.pk()).unwrap();
    let missing = p::missing_op_ids(&a.conn, &ids).unwrap();
    let ops = p::ops_for(&f.conn, &s, &a.pk(), &missing).unwrap();
    // team_create, channel_create (A not in team B yet, but now a member), team_member_add.
    let add = ops
        .iter()
        .find(|o| o.payload.contains("team_member_add"))
        .unwrap()
        .clone();
    let rest: Vec<SignedOp> = ops.iter().filter(|o| **o != add).cloned().collect();
    p::ingest(&mut a.conn, Some(&f.pk()), vec![add.clone()], now()).unwrap();
    let st = a.statuses();
    let add_status = st.iter().find(|(id, _, _)| *id == add.id()).unwrap();
    assert_eq!(add_status.1, "rejected");
    assert_eq!(add_status.2.as_deref(), Some("team_not_found"));
    let report = p::ingest(&mut a.conn, Some(&f.pk()), rest, now()).unwrap();
    assert!(report.new_ops >= 1);
    let st = a.statuses();
    assert!(st.iter().all(|(_, s, _)| s == "applied"), "{st:?}");
    assert_eq!(a.state().team_role(&t2, &a.pk()), Some(TeamRole::Member));
    // Duplicates are ignored.
    let again = p::ingest(&mut a.conn, Some(&f.pk()), vec![add], now()).unwrap();
    assert_eq!(again.new_ops, 0);
}

#[test]
fn three_laptops_converge_and_an_offline_one_catches_up() {
    let mut f = Node::founder("Sari");
    let team = f.create_team("Tim A");
    let mut a = Node::new("Ani");
    let mut b = Node::new("Budi");
    {
        let code = f.invite(&team, InviteRole::TeamAdmin, Validity::Once);
        join(&mut f, &mut a, &code, now())
    }
    .unwrap();
    {
        let code = f.invite(&team, InviteRole::Member, Validity::Once);
        join(&mut f, &mut b, &code, now())
    }
    .unwrap();
    sync_both(&mut f, &mut a);
    sync_both(&mut f, &mut b);
    sync_both(&mut a, &mut b);

    // B goes offline. F and A make changes concurrently and in both orders.
    p::add_superadmin(&mut f.conn, &f.id, &a.pk(), now()).unwrap();
    identity::save_display_name(&mut a.conn, &mut a.id, "Ani Lestari").unwrap();
    p::set_display_name_op(&mut a.conn, &a.id, now()).unwrap();
    let code = a.invite(&team, InviteRole::Member, Validity::D7);
    let mut c = Node::new("Citra");
    join(&mut a, &mut c, &code, now()).unwrap();
    let t2 = f.create_team("Tim B");
    sync(&a, &mut f);
    sync(&f, &mut a);
    p::add_team_member(&mut f.conn, &f.id, &t2, &a.pk(), now()).unwrap();
    sync_both(&mut f, &mut a);
    sync_both(&mut a, &mut c);
    assert_eq!(f.state(), a.state());
    assert_ne!(f.state(), b.state(), "B is behind");

    // B comes back and catches up from either laptop.
    assert!(sync(&a, &mut b) > 0);
    sync(&f, &mut b);
    let fs = f.state();
    let bs = b.state();
    // B is not in team B, so it lacks that team's channel op; compare the
    // org-scope state.
    assert_eq!(fs.members, bs.members);
    assert_eq!(fs.invites, bs.invites);
    assert_eq!(
        fs.teams.keys().collect::<Vec<_>>(),
        bs.teams.keys().collect::<Vec<_>>()
    );
    assert_eq!(
        bs.member(&a.pk()).unwrap().display_name.as_deref(),
        Some("Ani Lestari")
    );
    assert!(bs.is_superadmin(&a.pk()));
    assert!(bs.is_active(&c.pk()));
    assert_eq!(f.state(), a.state());

    let tables = |n: &Node| -> Vec<(String, String, String, i64)> {
        n.conn
            .prepare(
                "SELECT public_key, role, status, is_superadmin FROM members ORDER BY public_key",
            )
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    assert_eq!(tables(&f), tables(&b));
    assert_eq!(tables(&f), tables(&c));
}

#[test]
fn invalid_ops_are_logged_not_stored() {
    let mut f = Node::founder("Sari");
    let good = p::load_ops(&f.conn).unwrap()[0].signed.clone();
    let mut bad_sig = good.clone();
    bad_sig.payload = bad_sig.payload.replace("Sari", "Sara");
    let junk = SignedOp {
        payload: "{}".into(),
        sig: "0".repeat(128),
    };
    let before = f.op_ids();
    let report = p::ingest(
        &mut f.conn,
        Some(&"ab".repeat(32)),
        vec![bad_sig, junk, good],
        now(),
    )
    .unwrap();
    assert_eq!(report.new_ops, 0);
    assert_eq!(report.invalid, 2);
    assert_eq!(f.op_ids(), before);
    let rejected = p::rejected_changes(&f.conn, 10).unwrap();
    assert_eq!(rejected.len(), 2);
    assert_eq!(rejected[0].code, "bad_format", "latest first");
    assert_eq!(rejected[1].code, "bad_signature");
    assert_eq!(rejected[0].peer.as_deref(), Some("ab".repeat(32).as_str()));
    let json = serde_json::to_value(&rejected[0]).unwrap();
    for k in ["at", "peer", "address", "code", "detail"] {
        assert!(json.get(k).is_some(), "{k}");
    }
}

#[test]
fn rejected_changes_keep_the_latest_1000() {
    let f = Node::founder("Sari");
    let addr: std::net::SocketAddr = "192.168.1.5:47800".parse().unwrap();
    for i in 0..1005 {
        p::log_rejection(
            &f.conn,
            None,
            Some(addr),
            "not_member",
            &format!("ke-{i}"),
            now(),
        )
        .unwrap();
    }
    let count: i64 = f
        .conn
        .query_row("SELECT count(*) FROM rejected_changes", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1000);
    let latest = p::rejected_changes(&f.conn, 2).unwrap();
    assert_eq!(latest[0].detail, "ke-1004");
    assert_eq!(latest[0].address.as_deref(), Some("192.168.1.5:47800"));
    let all = p::rejected_changes(&f.conn, 5000).unwrap();
    assert_eq!(all.last().unwrap().detail, "ke-5");
}

#[test]
fn directory_shape_and_visibility() {
    let mut f = Node::founder("Sari");
    let team_a = f.create_team("Tim A");
    let team_b = f.create_team("Tim B");
    let mut a = Node::new("Ani");
    {
        let code = f.invite(&team_a, InviteRole::TeamAdmin, Validity::Once);
        join(&mut f, &mut a, &code, now())
    }
    .unwrap();
    let mut m = Node::new("Mira");
    {
        let code = f.invite(&team_a, InviteRole::Member, Validity::Once);
        join(&mut f, &mut m, &code, now())
    }
    .unwrap();
    f.invite(&team_b, InviteRole::Member, Validity::H24);
    sync(&f, &mut a);
    sync(&f, &mut m);
    a.invite(&team_a, InviteRole::Member, Validity::D7);
    sync(&a, &mut f);
    sync(&f, &mut m);

    let df = p::directory(&f.conn, &f.id, now()).unwrap();
    assert!(df.me.is_superadmin);
    assert_eq!(df.superadmin_count, 1);
    assert!(df.can.create_team && df.can.manage_superadmins && df.can.remove_members);
    assert_eq!(df.can.manage_team_ids.len(), 2);
    assert_eq!(df.invites.len(), 4, "superadmin sees every invite");
    assert_eq!(df.org.role, Role::Superadmin);
    let used: Vec<_> = df
        .invites
        .iter()
        .filter(|i| i.status == InviteStatus::Used)
        .collect();
    assert_eq!(used.len(), 2);
    assert!(
        used.iter()
            .all(|i| i.validity == Validity::Once && i.used_by.len() == 1)
    );
    let day = df
        .invites
        .iter()
        .find(|i| i.validity == Validity::H24)
        .unwrap();
    assert_eq!(day.team_name, "Tim B");
    assert_eq!(day.status, InviteStatus::Active);

    let da = p::directory(&a.conn, &a.id, now()).unwrap();
    assert!(!da.me.is_superadmin);
    assert!(!da.can.create_team);
    assert_eq!(da.can.manage_team_ids, vec![team_a.clone()]);
    assert!(
        da.invites.iter().all(|i| i.team_id == team_a),
        "team admin sees only their team"
    );
    assert_eq!(da.invites.len(), 3);
    assert_eq!(da.org.role, Role::TeamAdmin);

    let dm = p::directory(&m.conn, &m.id, now()).unwrap();
    assert!(dm.invites.is_empty());
    assert!(dm.can.manage_team_ids.is_empty());
    assert_eq!(dm.members.len(), 3);
    assert_eq!(dm.teams.len(), 2);

    let json = serde_json::to_value(&df).unwrap();
    for k in [
        "org",
        "me",
        "superadminCount",
        "can",
        "members",
        "teams",
        "invites",
        "channels",
    ] {
        assert!(json.get(k).is_some(), "{k}");
    }
    for k in [
        "createTeam",
        "manageSuperadmins",
        "removeMembers",
        "manageTeamIds",
    ] {
        assert!(json["can"].get(k).is_some(), "{k}");
    }
    let member = &json["members"][0];
    for k in [
        "publicKey",
        "fingerprint",
        "displayName",
        "orgRole",
        "isSuperadmin",
        "status",
        "joinedAt",
        "teams",
    ] {
        assert!(member.get(k).is_some(), "{k}");
    }
    let ani = json["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["publicKey"] == a.pk())
        .unwrap();
    assert_eq!(ani["orgRole"], "team_admin");
    assert_eq!(ani["teams"][0]["role"], "admin");
    assert_eq!(ani["teams"][0]["teamId"], team_a);
    let inv = &json["invites"][0];
    for k in [
        "id",
        "teamId",
        "teamName",
        "role",
        "projectIds",
        "validity",
        "expiresAt",
        "createdBy",
        "createdAt",
        "status",
        "usedBy",
    ] {
        assert!(inv.get(k).is_some(), "{k}");
    }
    let team = &json["teams"][0];
    for k in ["id", "name", "createdAt", "members"] {
        assert!(team.get(k).is_some(), "{k}");
    }
    assert!(json["channels"][0].get("teamId").is_some());
    assert_eq!(json["org"]["role"], "superadmin");
}

#[test]
fn invite_validity_and_status() {
    let mut f = Node::founder("Sari");
    let team = f.create_team("Tim A");
    let (view, code) = p::create_invite(
        &mut f.conn,
        &f.id,
        &team,
        InviteRole::Member,
        vec![],
        Validity::Once,
        now(),
    )
    .unwrap();
    assert_eq!(view.validity, Validity::Once);
    assert_eq!(view.status, InviteStatus::Active);
    assert_eq!(code.len(), 24);
    let expires = p::format::parse_time(&view.expires_at).unwrap();
    let created = p::format::parse_time(&view.created_at).unwrap();
    assert_eq!(expires - created, Duration::days(7));
    let json = serde_json::to_value(&view).unwrap();
    assert_eq!(json["validity"], "once");
    assert_eq!(json["role"], "member");
    assert_eq!(json["status"], "active");

    let (v24, _) = p::create_invite(
        &mut f.conn,
        &f.id,
        &team,
        InviteRole::TeamAdmin,
        vec![],
        Validity::H24,
        now(),
    )
    .unwrap();
    assert_eq!(serde_json::to_value(v24.validity).unwrap(), "24h");
    let later = p::directory(&f.conn, &f.id, now() + Duration::hours(25)).unwrap();
    let v = later.invites.iter().find(|i| i.id == v24.id).unwrap();
    assert_eq!(v.status, InviteStatus::Expired);

    // Guest invites need projects, others must not have them.
    assert_eq!(
        p::create_invite(
            &mut f.conn,
            &f.id,
            &team,
            InviteRole::Guest,
            vec![],
            Validity::D7,
            now()
        )
        .unwrap_err()
        .code(),
        "forbidden"
    );
    assert_eq!(
        p::create_invite(
            &mut f.conn,
            &f.id,
            &team,
            InviteRole::Member,
            vec![rand_hex16()],
            Validity::D7,
            now()
        )
        .unwrap_err()
        .code(),
        "forbidden"
    );
    let (g, _) = p::create_invite(
        &mut f.conn,
        &f.id,
        &team,
        InviteRole::Guest,
        vec![rand_hex16()],
        Validity::D7,
        now(),
    )
    .unwrap();
    assert_eq!(g.project_ids.len(), 1);
    assert_eq!(serde_json::to_value(g.validity).unwrap(), "7d");
}

#[test]
fn guest_joins_with_project_access_only() {
    let mut f = Node::founder("Sari");
    let team = f.create_team("Tim A");
    let mut g = Node::new("Tamu");
    let info = {
        let code = f.invite(&team, InviteRole::Guest, Validity::Once);
        join(&mut f, &mut g, &code, now())
    }
    .unwrap();
    assert_eq!(info.role, Role::Guest);
    let rows: i64 = g
        .conn
        .query_row(
            "SELECT count(*) FROM guest_access WHERE public_key = ?1",
            [g.pk()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(rows, 1);
    let teams: i64 = g
        .conn
        .query_row(
            "SELECT count(*) FROM team_members WHERE public_key = ?1",
            [g.pk()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(teams, 0);
    // A guest's laptop cannot check codes for others.
    let code = f.invite(&team, InviteRole::Member, Validity::D7);
    sync(&f, &mut g);
    let normalized = p::normalize_code(&code).unwrap();
    assert_eq!(
        p::join_lookup(&g.conn, normalized.tag(), now()).unwrap_err(),
        p::JoinRejectCode::InviteNotFound
    );
}

#[test]
fn redeem_as_member_for_another_team() {
    let mut f = Node::founder("Sari");
    let team_a = f.create_team("Tim A");
    let team_b = f.create_team("Tim B");
    let mut a = Node::new("Ani");
    {
        let code = f.invite(&team_a, InviteRole::Member, Validity::Once);
        join(&mut f, &mut a, &code, now())
    }
    .unwrap();
    let code =
        p::normalize_code(&f.invite(&team_b, InviteRole::TeamAdmin, Validity::Once)).unwrap();
    sync(&f, &mut a);
    p::redeem_as_member(&mut a.conn, &a.id, &code, now()).unwrap();
    assert_eq!(a.state().team_role(&team_b, &a.pk()), Some(TeamRole::Admin));
    assert_eq!(
        p::redeem_as_member(&mut a.conn, &a.id, &code, now())
            .unwrap_err()
            .code(),
        "invite_used"
    );
    sync(&a, &mut f);
    assert_eq!(f.state().team_role(&team_b, &a.pk()), Some(TeamRole::Admin));

    // Nothing to gain: refused before spending the code.
    let again = p::normalize_code(&f.invite(&team_a, InviteRole::Member, Validity::Once)).unwrap();
    sync(&f, &mut a);
    assert_eq!(
        p::redeem_as_member(&mut a.conn, &a.id, &again, now())
            .unwrap_err()
            .code(),
        "forbidden"
    );
    let unknown = p::normalize_code(&p::generate_invite_code()).unwrap();
    assert_eq!(
        p::redeem_as_member(&mut a.conn, &a.id, &unknown, now())
            .unwrap_err()
            .code(),
        "invite_not_found"
    );
}

#[test]
fn author_op_uses_lamport_after_everything_known() {
    let mut f = Node::founder("Sari");
    let team = f.create_team("Tim A");
    let mut a = Node::new("Ani");
    {
        let code = f.invite(&team, InviteRole::Member, Validity::Once);
        join(&mut f, &mut a, &code, now())
    }
    .unwrap();
    let max = p::max_lamport(&a.conn).unwrap();
    let op = p::author_op(
        &mut a.conn,
        &a.id,
        Scope::Org,
        Body::ProfileSet {
            name: "Ani L".into(),
        },
        now(),
    )
    .unwrap();
    let v = p::verify_op(&op, &f.state().org.id, now()).unwrap();
    assert_eq!(v.lamport(), max + 1);
    assert_eq!(v.author(), a.pk());
}

/// Signs a payload as `node` with an explicit lamport (what a modified
/// laptop could send).
fn raw_op(node: &Node, org: &str, lamport: u64, body: Body) -> SignedOp {
    let payload = p::Payload {
        v: 1,
        org: org.to_owned(),
        author: node.pk(),
        lamport,
        at: crate::permissions::format::format_time(now()),
        nonce: rand_hex16(),
        scope: Scope::Org,
        body,
    };
    let json = serde_json::to_string(&payload).unwrap();
    let sig = node.id.sign(&crate::permissions::op::signed_message(&json));
    SignedOp {
        payload: json,
        sig: hex::encode(sig.to_bytes()),
    }
}

#[test]
fn a_huge_lamport_cannot_freeze_the_organization() {
    let mut f = Node::founder("Sari");
    let team = f.create_team("Tim A");
    let mut g = Node::new("Tamu");
    {
        let code = f.invite(&team, InviteRole::Member, Validity::Once);
        join(&mut f, &mut g, &code, now())
    }
    .unwrap();
    let org = f.state().org.id;
    // Even a plain member's profile op with the largest lamport would make
    // every later `max + 1` invalid.
    let op = raw_op(
        &g,
        &org,
        crate::permissions::op::MAX_LAMPORT,
        Body::ProfileSet {
            name: "Tamu".into(),
        },
    );
    let report = p::ingest(&mut f.conn, Some(&g.pk()), vec![op], now()).unwrap();
    assert_eq!(report.new_ops, 0, "lamport jump must be refused");
    assert_eq!(report.invalid, 1);
    // The organization keeps working.
    f.create_team("Tim B");
}

#[test]
fn a_reasonable_lamport_gap_is_accepted() {
    let mut f = Node::founder("Sari");
    let team = f.create_team("Tim A");
    let mut a = Node::new("Ani");
    {
        let code = f.invite(&team, InviteRole::Member, Validity::Once);
        join(&mut f, &mut a, &code, now())
    }
    .unwrap();
    let org = f.state().org.id;
    let max = p::max_lamport(&f.conn).unwrap();
    // A gap left by team ops the receiver cannot see, or ops still in flight.
    let ops = vec![
        raw_op(
            &a,
            &org,
            max + 500,
            Body::ProfileSet {
                name: "Ani A".into(),
            },
        ),
        raw_op(
            &a,
            &org,
            max + 900,
            Body::ProfileSet {
                name: "Ani B".into(),
            },
        ),
    ];
    let report = p::ingest(&mut f.conn, Some(&a.pk()), ops, now()).unwrap();
    assert_eq!(report.new_ops, 2);
}

#[test]
fn joiner_refuses_admission_through_a_different_invite() {
    // A responder that challenges the joiner with another invite (another
    // team or role) and re-signs the invite part of the proof with that
    // invite's own code.
    let mut f = Node::founder("Sari");
    let team_a = f.create_team("Tim A");
    let team_b = f.create_team("Tim B");
    let code_a = p::normalize_code(&f.invite(&team_a, InviteRole::Member, Validity::D7)).unwrap();
    let code_b =
        p::normalize_code(&f.invite(&team_b, InviteRole::TeamAdmin, Validity::D7)).unwrap();
    let state = f.state();
    let org = state.org.id.clone();
    let invite_b = state
        .invites
        .values()
        .find(|i| i.tag == code_b.tag())
        .unwrap()
        .id
        .clone();

    let mut joiner = Node::new("Joko");
    // The joiner signs for the challenged invite with its own code.
    let proof = p::build_join_proof(&code_a, &org, &invite_b, &joiner.id).unwrap();
    let msg = p::redeem_message(&org, &invite_b, &proof.member, &proof.name);
    let forged_invite_sig = {
        use ed25519_dalek::Signer;
        hex::encode(p::invite_signing_key(&code_b).sign(&msg).to_bytes())
    };
    p::author_op(
        &mut f.conn,
        &f.id,
        Scope::Org,
        Body::InviteAccept {
            invite: invite_b.clone(),
            member: proof.member.clone(),
            name: proof.name.clone(),
            invite_sig: forged_invite_sig,
            member_sig: proof.member_sig.clone(),
        },
        now(),
    )
    .unwrap();
    let state = f.state();
    let ids = p::op_ids_for(&f.conn, &state, &joiner.pk()).unwrap();
    let ops = p::ops_for(&f.conn, &state, &joiner.pk(), &ids).unwrap();
    let org_record = org::load_organization(&f.conn).unwrap().unwrap();
    let err = p::install_joined_org(
        &mut joiner.conn,
        &joiner.id,
        org_record,
        ops,
        &code_a,
        now(),
    )
    .unwrap_err();
    assert_eq!(err.code(), "network");
    assert_eq!(
        p::membership(&joiner.conn, &joiner.id).unwrap(),
        Membership::None
    );
}

#[test]
fn join_retry_after_a_lost_answer_is_idempotent() {
    let mut f = Node::founder("Sari");
    let team = f.create_team("Tim A");
    let code = p::normalize_code(&f.invite(&team, InviteRole::Member, Validity::D7)).unwrap();
    let mut a = Node::new("Ani");
    let (org, invite) = p::join_lookup(&f.conn, code.tag(), now()).unwrap();
    let proof = p::build_join_proof(&code, &org, &invite, &a.id).unwrap();
    // First answer is lost on the way.
    p::join_accept(&mut f.conn, &f.id, &a.pk(), &invite, &proof, now()).unwrap();
    let ops_before = f.op_ids();
    let (org2, invite2) = p::join_lookup(&f.conn, code.tag(), now()).unwrap();
    let proof = p::build_join_proof(&code, &org2, &invite2, &a.id).unwrap();
    let accepted = p::join_accept(&mut f.conn, &f.id, &a.pk(), &invite2, &proof, now()).unwrap();
    assert_eq!(f.op_ids(), ops_before, "no second accept op");
    p::install_joined_org(&mut a.conn, &a.id, accepted.org, accepted.ops, &code, now()).unwrap();
    assert_eq!(p::membership(&a.conn, &a.id).unwrap(), Membership::Active);
    // The person cannot use the same invite again from their own laptop.
    assert_eq!(
        p::redeem_as_member(&mut a.conn, &a.id, &code, now())
            .unwrap_err()
            .code(),
        "forbidden"
    );
}

#[test]
fn joiner_refuses_a_look_alike_organization() {
    // Mallory saw the real invite in the log and runs her own organization
    // with a copy of that invite, hoping to catch the person with the code.
    let mut f = Node::founder("Sari");
    let team = f.create_team("Tim A");
    let code = p::normalize_code(&f.invite(&team, InviteRole::Member, Validity::D7)).unwrap();
    let real_body = p::load_ops(&f.conn)
        .unwrap()
        .into_iter()
        .find(|o| o.payload.body.kind() == "invite_create")
        .unwrap()
        .payload
        .body;
    let p::Body::InviteCreate {
        invite,
        team: real_team,
        ..
    } = real_body.clone()
    else {
        unreachable!()
    };

    let m = Node::founder("Mallory");
    let fake_org = m.state().org.id;
    let fake_team_op = raw_op(
        &m,
        &fake_org,
        50,
        Body::TeamCreate {
            team: real_team,
            name: "Tim A".into(),
        },
    );
    let fake_invite_op = raw_op(&m, &fake_org, 51, real_body);
    let mut joiner = Node::new("Joko");
    let proof = p::build_join_proof(&code, &fake_org, &invite, &joiner.id).unwrap();
    let accept = raw_op(
        &m,
        &fake_org,
        52,
        Body::InviteAccept {
            invite,
            member: proof.member,
            name: proof.name,
            invite_sig: proof.invite_sig,
            member_sig: proof.member_sig,
        },
    );
    let mut ops: Vec<SignedOp> = p::load_ops(&m.conn)
        .unwrap()
        .into_iter()
        .map(|v| v.signed)
        .collect();
    ops.extend([fake_team_op, fake_invite_op, accept]);
    let record = org::load_organization(&m.conn).unwrap().unwrap();
    let err =
        p::install_joined_org(&mut joiner.conn, &joiner.id, record, ops, &code, now()).unwrap_err();
    assert_eq!(err.code(), "network");
    assert_eq!(
        p::membership(&joiner.conn, &joiner.id).unwrap(),
        Membership::None
    );
}
