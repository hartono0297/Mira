//! 0.5.1 suspend, reinstate and remove for good
//! (docs/plans/perbaikan-bergabung.md): the fold rules, who may do what,
//! the snapshot, concurrency, what a suspended laptop receives, the version
//! gate, the views and the join request hint.

use std::collections::HashMap;

use super::join_tests::{Node, Office, all_on, now, office};
use super::sim::*;
use crate::error::AppError;
use crate::permissions::fold::{JoinDecision, Reason as R};
use crate::permissions::{
    self as p, Body, InviteRole, Membership, MemberStatus, PeerAuthState, PreviousMatch, Scope,
    SuspendSnapshot, TeamRole, VerifiedOp, fold, project_id_for,
};

// ----- Body helpers ----------------------------------------------------------

fn suspend(m: &Actor) -> Body {
    Body::MemberSuspend {
        member: m.pk.clone(),
    }
}

fn reinstate(m: &Actor) -> Body {
    Body::MemberReinstate {
        member: m.pk.clone(),
    }
}

fn remove(m: &Actor) -> Body {
    Body::MemberRemove {
        member: m.pk.clone(),
    }
}

fn sa_add(m: &Actor) -> Body {
    Body::SuperadminAdd {
        member: m.pk.clone(),
    }
}

fn profile(name: &str) -> Body {
    Body::ProfileSet { name: name.into() }
}

/// `project_create` by `creator` in `team`; returns the project id.
fn project(creator: &Actor, team: &str) -> (String, Body) {
    let nonce = rand_hex16();
    let id = project_id_for(&creator.pk, Some(team), &nonce);
    (
        id.clone(),
        Body::ProjectCreate {
            project: id,
            team: Some(team.into()),
            creator: creator.pk.clone(),
            nonce,
            members: Vec::new(),
        },
    )
}

/// A new label assigned to `m` by the founder; returns its id.
fn label_for(sim: &mut Sim, m: &Actor) -> String {
    let f = sim.founder();
    let label = rand_hex16();
    let create = Body::LabelCreate {
        label: label.clone(),
        name: format!("Label {}", &label[..4]),
    };
    assert_eq!(sim.push(&f, create), Ok(()));
    let assign = Body::LabelAssign {
        label: label.clone(),
        member: m.pk.clone(),
    };
    assert_eq!(sim.push(&f, assign), Ok(()));
    label
}

// ----- World -----------------------------------------------------------------

/// Founder (superadmin, in Desain), Desain with admins `admin_d` and
/// `admin_d2` and member `member_d`, Drafting with admin `admin_g` and
/// member `member_g`, a guest of Desain, and a second superadmin `sa2` in
/// Drafting.
struct World {
    sim: Sim,
    f: Actor,
    desain: String,
    admin_d: Actor,
    admin_d2: Actor,
    member_d: Actor,
    admin_g: Actor,
    member_g: Actor,
    guest: Actor,
    sa2: Actor,
}

fn world() -> World {
    let mut sim = Sim::new();
    let f = sim.founder();
    let desain = sim.team("Desain");
    let drafting = sim.team("Drafting");
    let admin_d = sim.join(&desain, InviteRole::TeamAdmin, "Rina");
    let admin_d2 = sim.join(&desain, InviteRole::TeamAdmin, "Tono");
    let member_d = sim.join(&desain, InviteRole::Member, "Dimas");
    let admin_g = sim.join(&drafting, InviteRole::TeamAdmin, "Budi");
    let member_g = sim.join(&drafting, InviteRole::Member, "Sari");
    let guest = sim.join(&desain, InviteRole::Guest, "Yusuf");
    let sa2 = sim.join(&drafting, InviteRole::Member, "Andi");
    assert_eq!(sim.push(&f, sa_add(&sa2)), Ok(()));
    let to_desain = Body::TeamMove {
        team: desain.clone(),
        member: f.pk.clone(),
    };
    assert_eq!(sim.push(&f, to_desain), Ok(()));
    World {
        sim,
        f,
        desain,
        admin_d,
        admin_d2,
        member_d,
        admin_g,
        member_g,
        guest,
        sa2,
    }
}

/// A copy of `sim` to try one variant of a concurrent scenario on.
fn fork(sim: &Sim) -> Sim {
    Sim {
        org: sim.org.clone(),
        founder: sim.founder(),
        ops: sim.ops.clone(),
        lamport: sim.lamport,
        now: sim.now,
    }
}

/// Same state and outcomes for several arrival orders.
fn assert_order_free(sim: &Sim) {
    let base = fold(&sim.org, &sim.ops);
    let mut rev: Vec<VerifiedOp> = sim.ops.clone();
    rev.reverse();
    let mut rot = sim.ops.clone();
    rot.rotate_left(sim.ops.len() / 2);
    for ops in [rev, rot] {
        let r = fold(&sim.org, &ops);
        assert_eq!(r.state, base.state);
        assert_eq!(r.outcomes, base.outcomes);
    }
}

fn status(sim: &Sim, m: &Actor) -> MemberStatus {
    sim.state().member(&m.pk).unwrap().status
}

// ----- Fold: suspend and reinstate ----------------------------------------------

#[test]
fn suspend_strips_everything_and_reinstate_gives_it_back() {
    let World {
        mut sim,
        f,
        desain,
        member_d,
        ..
    } = world();
    let (proj, body) = project(&member_d, &desain);
    assert_eq!(sim.push(&member_d, body), Ok(()));
    let label = label_for(&mut sim, &member_d);

    assert_eq!(sim.push(&f, suspend(&member_d)), Ok(()));
    let s = sim.state();
    let m = s.member(&member_d.pk).unwrap();
    assert_eq!(m.status, MemberStatus::Suspended);
    assert_eq!(m.suspended_by.as_deref(), Some(f.pk.as_str()));
    assert!(m.suspended_at.is_some() && m.suspension_op.is_some());
    assert!(m.removed_at.is_none() && m.removal_op.is_none());
    assert_eq!(
        m.snapshot,
        Some(SuspendSnapshot {
            department: Some((desain.clone(), TeamRole::Member)),
            superadmin: false,
            projects: vec![proj.clone()],
            labels: vec![label.clone()],
            guest_access: Vec::new(),
        })
    );
    assert!(!s.is_active(&member_d.pk));
    assert!(s.department_of(&member_d.pk).is_none());
    assert!(!s.is_project_member(&proj, &member_d.pk));
    assert!(!s.labels[&label].members.contains(&member_d.pk));
    // A suspended member cannot change anything.
    assert_eq!(sim.push(&member_d, profile("Dimas B")), Err(R::AuthorNotActive));

    assert_eq!(sim.push(&f, reinstate(&member_d)), Ok(()));
    let s = sim.state();
    let m = s.member(&member_d.pk).unwrap();
    assert_eq!(m.status, MemberStatus::Active);
    assert!(m.suspended_at.is_none() && m.suspended_by.is_none());
    assert!(m.suspension_op.is_none() && m.snapshot.is_none());
    assert_eq!(s.team_role(&desain, &member_d.pk), Some(TeamRole::Member));
    assert!(s.is_project_member(&proj, &member_d.pk));
    assert!(s.labels[&label].members.contains(&member_d.pk));
    assert_eq!(sim.push(&member_d, profile("Dimas B")), Ok(()));
    assert_order_free(&sim);
}

#[test]
fn superadmin_and_department_admin_roles_come_back() {
    let World {
        mut sim,
        f,
        desain,
        admin_d,
        sa2,
        ..
    } = world();
    assert_eq!(sim.push(&f, suspend(&sa2)), Ok(()));
    let s = sim.state();
    assert!(!s.is_superadmin(&sa2.pk));
    assert!(!s.member(&sa2.pk).unwrap().is_superadmin);
    assert_eq!(s.superadmin_count(), 1);
    assert!(s.member(&sa2.pk).unwrap().snapshot.as_ref().unwrap().superadmin);
    assert_eq!(sim.push(&f, reinstate(&sa2)), Ok(()));
    assert!(sim.state().is_superadmin(&sa2.pk));
    assert_eq!(sim.state().superadmin_count(), 2);

    assert_eq!(sim.push(&f, suspend(&admin_d)), Ok(()));
    assert_eq!(sim.state().team_role(&desain, &admin_d.pk), None);
    assert_eq!(sim.push(&f, reinstate(&admin_d)), Ok(()));
    assert_eq!(
        sim.state().team_role(&desain, &admin_d.pk),
        Some(TeamRole::Admin)
    );
    assert_order_free(&sim);
}

#[test]
fn guest_access_comes_back_while_its_department_lives() {
    let World {
        mut sim,
        f,
        desain,
        guest,
        ..
    } = world();
    let access = |sim: &Sim| -> Vec<_> {
        sim.state()
            .guest_access
            .iter()
            .filter(|g| g.public_key == guest.pk)
            .cloned()
            .collect()
    };
    let before = access(&sim);
    assert_eq!(before.len(), 2);
    assert_eq!(sim.push(&f, suspend(&guest)), Ok(()));
    assert!(access(&sim).is_empty());
    assert_eq!(
        sim.state().member(&guest.pk).unwrap().snapshot.as_ref().unwrap().guest_access,
        before
    );
    assert_eq!(sim.push(&f, reinstate(&guest)), Ok(()));
    assert_eq!(access(&sim), before);

    // Department deleted while suspended: nothing to give back.
    assert_eq!(sim.push(&f, suspend(&guest)), Ok(()));
    let delete = Body::TeamDelete {
        team: desain.clone(),
    };
    assert_eq!(sim.push(&f, delete), Ok(()));
    assert_eq!(sim.push(&f, reinstate(&guest)), Ok(()));
    assert!(access(&sim).is_empty());
    assert!(sim.state().is_active(&guest.pk));
    assert_order_free(&sim);
}

#[test]
fn who_may_suspend_reinstate_and_remove() {
    let World {
        mut sim,
        f,
        admin_d,
        admin_d2,
        member_d,
        admin_g,
        member_g,
        guest,
        sa2,
        ..
    } = world();
    // A department admin may not suspend another admin, a superadmin (the
    // founder is a plain member of Desain), a guest, or someone in another
    // department. Regular members and guests may not suspend anyone.
    for (by, target) in [
        (&admin_d, &admin_d2),
        (&admin_d, &f),
        (&admin_d, &guest),
        (&admin_d, &member_g),
        (&admin_g, &member_d),
        (&member_g, &member_d),
        (&guest, &member_d),
    ] {
        assert_eq!(sim.state().may_suspend(&by.pk, &target.pk), Err(R::NotAuthorized));
        assert_eq!(sim.push(by, suspend(target)), Err(R::NotAuthorized));
    }
    // The admin of Dimas's department may suspend and reinstate him, but
    // removing for good stays with superadmins.
    assert_eq!(sim.push(&admin_d, suspend(&member_d)), Ok(()));
    assert_eq!(sim.push(&admin_g, reinstate(&member_d)), Err(R::NotAuthorized));
    assert_eq!(sim.push(&admin_d, remove(&member_d)), Err(R::NotAuthorized));
    assert_eq!(sim.push(&admin_d2, reinstate(&member_d)), Ok(()));
    assert_eq!(status(&sim, &member_d), MemberStatus::Active);

    // An admin reinstates only their own former regular member: not a
    // suspended admin, not a suspended superadmin.
    assert_eq!(sim.push(&f, suspend(&admin_d2)), Ok(()));
    assert_eq!(sim.push(&admin_d, reinstate(&admin_d2)), Err(R::NotAuthorized));
    assert_eq!(sim.push(&sa2, reinstate(&admin_d2)), Ok(()));
    assert_eq!(sim.push(&f, suspend(&sa2)), Ok(()));
    assert_eq!(sim.push(&admin_g, reinstate(&sa2)), Err(R::NotAuthorized));
    assert_eq!(sim.push(&f, suspend(&member_g)), Ok(()));
    assert_eq!(sim.push(&admin_g, reinstate(&member_g)), Ok(()));
    assert_order_free(&sim);
}

#[test]
fn the_last_superadmin_cannot_be_suspended() {
    let mut sim = Sim::new();
    let f = sim.founder();
    assert_eq!(sim.state().may_suspend(&f.pk, &f.pk), Err(R::LastSuperadmin));
    assert_eq!(sim.push(&f, suspend(&f)), Err(R::LastSuperadmin));

    let World { mut sim, f, sa2, .. } = world();
    assert_eq!(sim.push(&sa2, suspend(&f)), Ok(()));
    assert_eq!(sim.push(&sa2, suspend(&sa2)), Err(R::LastSuperadmin));
    assert_eq!(sim.push(&sa2, remove(&sa2)), Err(R::LastSuperadmin));
    // The suspended founder no longer counts, and can be removed for good.
    assert_eq!(sim.push(&sa2, remove(&f)), Ok(()));
    assert_eq!(status(&sim, &f), MemberStatus::Removed);
}

#[test]
fn targets_must_be_in_the_right_state() {
    let World {
        mut sim,
        f,
        member_d,
        member_g,
        ..
    } = world();
    assert_eq!(sim.push(&f, reinstate(&member_d)), Err(R::TargetNotSuspended));
    assert_eq!(sim.push(&f, suspend(&member_d)), Ok(()));
    assert_eq!(sim.state().may_suspend(&f.pk, &member_d.pk), Err(R::TargetNotActive));
    assert_eq!(sim.state().may_reinstate(&f.pk, &member_d.pk), Ok(()));
    let unknown = Actor::new();
    assert_eq!(sim.push(&f, suspend(&unknown)), Err(R::TargetNotActive));
    assert_eq!(sim.push(&f, reinstate(&unknown)), Err(R::TargetNotSuspended));
    assert_eq!(sim.push(&f, remove(&member_g)), Ok(()));
    assert_eq!(sim.push(&f, suspend(&member_g)), Err(R::TargetNotActive));
    assert_eq!(sim.push(&f, reinstate(&member_g)), Err(R::TargetNotSuspended));
    assert_eq!(sim.push(&f, remove(&member_g)), Err(R::TargetNotActive));
    // Someone suspended cannot be admitted again with an invite code.
    let f2 = sim.founder();
    let team = sim.team("Baru");
    let inv = sim.invite(&f2, &team, InviteRole::Member, true);
    assert_eq!(sim.accept(&f, &inv, &member_d, "Dimas"), Err(R::TargetNotActive));
    assert_eq!(status(&sim, &member_d), MemberStatus::Suspended);
}

#[test]
fn snapshot_is_restored_only_where_still_valid() {
    let World { mut sim, f, .. } = world();
    // Archived department.
    let arsip = sim.team("Arsip");
    let x = sim.join(&arsip, InviteRole::Member, "Xena");
    let (proj, body) = project(&x, &arsip);
    assert_eq!(sim.push(&x, body), Ok(()));
    assert_eq!(sim.push(&f, suspend(&x)), Ok(()));
    let archive = Body::TeamArchive {
        team: arsip.clone(),
        archived: true,
    };
    assert_eq!(sim.push(&f, archive), Ok(()));
    assert_eq!(sim.push(&f, reinstate(&x)), Ok(()));
    let s = sim.state();
    assert!(s.is_active(&x.pk));
    assert!(s.department_of(&x.pk).is_none());
    assert!(s.is_project_member(&proj, &x.pk));

    // Deleted department.
    let hapus = sim.team("Hapus");
    let y = sim.join(&hapus, InviteRole::TeamAdmin, "Yanti");
    assert_eq!(sim.push(&f, suspend(&y)), Ok(()));
    let delete = Body::TeamDelete {
        team: hapus.clone(),
    };
    assert_eq!(sim.push(&f, delete), Ok(()));
    assert_eq!(sim.push(&f, reinstate(&y)), Ok(()));
    assert!(sim.state().is_active(&y.pk));
    assert!(sim.state().department_of(&y.pk).is_none());
    assert_order_free(&sim);

    // A project or label gone from the state is skipped (the fold has no
    // op that deletes them; the restore must not bring them back).
    let open = sim.team("Buka");
    let z = sim.join(&open, InviteRole::Member, "Zaki");
    let (gone_proj, body) = project(&z, &open);
    assert_eq!(sim.push(&z, body), Ok(()));
    let (kept_proj, body) = project(&z, &open);
    assert_eq!(sim.push(&z, body), Ok(()));
    let gone_label = label_for(&mut sim, &z);
    let kept_label = label_for(&mut sim, &z);
    assert_eq!(sim.push(&f, suspend(&z)), Ok(()));
    let mut s = sim.state();
    s.projects.remove(&gone_proj);
    s.labels.remove(&gone_label);
    let op = sim.make_at(&f, sim.lamport + 1, reinstate(&z));
    assert_eq!(s.apply(&op), Ok(()));
    assert_eq!(s.team_role(&open, &z.pk), Some(TeamRole::Member));
    assert!(s.is_project_member(&kept_proj, &z.pk));
    assert!(!s.projects.contains_key(&gone_proj));
    assert!(s.labels[&kept_label].members.contains(&z.pk));
    assert!(!s.labels.contains_key(&gone_label));
}

#[test]
fn remove_for_good_from_suspended_and_from_active() {
    let World {
        mut sim,
        f,
        member_d,
        member_g,
        ..
    } = world();
    assert_eq!(sim.push(&f, suspend(&member_d)), Ok(()));
    assert_eq!(sim.state().may_remove(&f.pk, &member_d.pk), Ok(()));
    assert_eq!(sim.push(&f, remove(&member_d)), Ok(()));
    let s = sim.state();
    let m = s.member(&member_d.pk).unwrap();
    assert_eq!(m.status, MemberStatus::Removed);
    assert!(m.removed_at.is_some() && m.removal_op.is_some());
    assert!(m.snapshot.is_none() && m.suspended_at.is_none() && m.suspension_op.is_none());
    assert_eq!(sim.push(&f, reinstate(&member_d)), Err(R::TargetNotSuspended));

    // The old `member_remove` on an active member is still for good.
    assert_eq!(sim.push(&f, remove(&member_g)), Ok(()));
    let s = sim.state();
    let m = s.member(&member_g.pk).unwrap();
    assert_eq!(m.status, MemberStatus::Removed);
    assert!(m.snapshot.is_none());
    assert!(s.department_of(&member_g.pk).is_none());
    assert_eq!(sim.push(&f, reinstate(&member_g)), Err(R::TargetNotSuspended));
    assert_order_free(&sim);
}

// ----- Concurrency -------------------------------------------------------------

#[test]
fn reinstate_concurrent_with_a_removal_loses() {
    let World {
        mut sim,
        f,
        member_d,
        sa2,
        ..
    } = world();
    assert_eq!(sim.push(&f, suspend(&member_d)), Ok(()));
    for (lr, lm) in [(1, 2), (2, 1), (1, 1), (1, 5)] {
        let mut s = fork(&sim);
        let deps = s.heads_below(s.lamport + 1);
        let back = s.make_with_deps(&sa2, s.lamport + lr, deps.clone(), reinstate(&member_d));
        let gone = s.make_with_deps(&f, s.lamport + lm, deps, remove(&member_d));
        let _ = s.add(back.clone());
        let _ = s.add(gone.clone());
        assert_eq!(s.outcome(&gone.id), Ok(()), "{lr} {lm}");
        assert!(s.outcome(&back.id).is_err(), "{lr} {lm}");
        assert_eq!(status(&s, &member_d), MemberStatus::Removed);
        assert_order_free(&s);
    }
}

#[test]
fn reinstate_that_missed_a_concurrent_suspension_loses() {
    let World {
        sim,
        f,
        admin_d,
        member_d,
        sa2,
        ..
    } = world();
    // The founder and Rina (admin of Desain) suspend Dimas concurrently.
    // Andi saw only the founder's suspension and reinstates: Rina's
    // suspension still stands, whatever the lamports.
    for x in [1, 2, 3, 5] {
        let mut s = fork(&sim);
        let base = s.lamport;
        let deps = s.heads_below(base + 1);
        let by_f = s.make_with_deps(&f, base + 1, deps.clone(), suspend(&member_d));
        let _ = s.add(by_f.clone());
        let back = s.make_with_deps(
            &sa2,
            base + 2,
            vec![by_f.id.clone()],
            reinstate(&member_d),
        );
        let by_rina = s.make_with_deps(&admin_d, base + x, deps, suspend(&member_d));
        let _ = s.add(back.clone());
        let _ = s.add(by_rina.clone());
        assert_eq!(s.outcome(&back.id), Err(R::ConcurrentWithRevocation), "{x}");
        assert_eq!(status(&s, &member_d), MemberStatus::Suspended, "{x}");
        assert_order_free(&s);
        // A reinstatement that saw both lifts the suspension.
        let both = s.make_with_deps(
            &sa2,
            base + 10,
            vec![by_f.id.clone(), by_rina.id.clone()],
            reinstate(&member_d),
        );
        assert_eq!(s.add(both), Ok(()), "{x}");
        assert_eq!(status(&s, &member_d), MemberStatus::Active);
        assert_order_free(&s);
    }
}

#[test]
fn concurrent_mutual_suspension_is_won_by_the_senior_superadmin() {
    let World {
        sim, f, sa2, admin_d, ..
    } = world();
    let mut base = fork(&sim);
    assert_eq!(base.push(&f, sa_add(&admin_d)), Ok(()));
    // sa2 was promoted before admin_d.
    for (la, lb) in [(1, 1), (1, 3), (3, 1)] {
        let mut s = fork(&base);
        let deps = s.heads_below(s.lamport + 1);
        let by_a = s.make_with_deps(&sa2, s.lamport + la, deps.clone(), suspend(&admin_d));
        let by_b = s.make_with_deps(&admin_d, s.lamport + lb, deps, suspend(&sa2));
        let _ = s.add(by_a.clone());
        let _ = s.add(by_b.clone());
        assert_eq!(s.outcome(&by_a.id), Ok(()), "{la} {lb}");
        assert_eq!(s.outcome(&by_b.id), Err(R::ConcurrentWithRevocation));
        assert!(s.state().is_superadmin(&sa2.pk));
        assert_eq!(status(&s, &admin_d), MemberStatus::Suspended);
        assert_order_free(&s);
    }
}

#[test]
fn ops_made_concurrently_with_the_suspension_of_their_author_are_rejected() {
    let World {
        mut sim,
        f,
        admin_d,
        member_d,
        ..
    } = world();
    let seen = sim.lamport;
    let suspension = sim.make_at(&f, seen + 1, suspend(&admin_d));
    // Rina, about to be suspended, backdates changes it has not seen.
    let own = sim.make_with_deps(&admin_d, seen, sim.heads_below(seen), profile("Rina X"));
    let late = sim.make_with_deps(&admin_d, seen + 3, sim.heads_below(seen), suspend(&member_d));
    assert!(own.order_key() < suspension.order_key());
    let _ = sim.add(own.clone());
    let _ = sim.add(suspension.clone());
    let _ = sim.add(late.clone());
    assert_eq!(sim.outcome(&suspension.id), Ok(()));
    assert_eq!(sim.outcome(&own.id), Err(R::ConcurrentWithRevocation));
    assert_eq!(sim.outcome(&late.id), Err(R::ConcurrentWithRevocation));
    assert_eq!(status(&sim, &member_d), MemberStatus::Active);
    assert_order_free(&sim);
}

#[test]
fn an_admin_suspension_loses_to_a_concurrent_loss_of_the_admin_right() {
    let World {
        mut sim,
        f,
        desain,
        admin_d,
        member_d,
        ..
    } = world();
    let seen = sim.lamport;
    let deps = sim.heads_below(seen + 1);
    let unset = Body::TeamAdminUnset {
        team: desain.clone(),
        member: admin_d.pk.clone(),
    };
    let unset = sim.make_with_deps(&f, seen + 2, deps.clone(), unset);
    let by_admin = sim.make_with_deps(&admin_d, seen + 1, deps, suspend(&member_d));
    let _ = sim.add(by_admin.clone());
    let _ = sim.add(unset.clone());
    assert_eq!(sim.outcome(&unset.id), Ok(()));
    assert_eq!(sim.outcome(&by_admin.id), Err(R::ConcurrentWithRevocation));
    assert_eq!(status(&sim, &member_d), MemberStatus::Active);
    assert_order_free(&sim);
}

// ----- Databases: what a suspended laptop receives ---------------------------------

/// Office with every laptop on this build's version (gates open).
fn open_office() -> Office {
    let mut o = office();
    all_on(&mut o, crate::device::APP_VERSION);
    o
}

fn scope_of(n: &Node, id: &str) -> Option<String> {
    n.conn
        .query_row("SELECT scope_team FROM org_ops WHERE id = ?1", [id], |r| {
            r.get(0)
        })
        .unwrap()
}

#[test]
fn a_suspended_peer_receives_org_ops_only_and_a_removed_one_nothing() {
    let mut o = open_office();
    let dimas = o.dimas.pk();
    let before = p::op_ids_for(&o.andi.conn, &o.andi.state(), &dimas).unwrap();
    assert!(
        before.iter().any(|id| scope_of(&o.andi, id).is_some()),
        "an active member of Desain receives its team ops"
    );
    p::suspend_member(&mut o.andi.conn, &o.andi.id, &dimas, now()).unwrap();
    let s = o.andi.state();
    assert_eq!(s.member(&dimas).unwrap().status, MemberStatus::Suspended);
    assert!(p::may_receive(&s, &dimas, None, &o.andi.pk()));
    assert!(!p::may_receive(&s, &dimas, Some(&o.desain), &o.andi.pk()));
    assert!(!p::may_receive(&s, &dimas, Some(&o.desain), &dimas));
    let ids = p::op_ids_for(&o.andi.conn, &s, &dimas).unwrap();
    assert!(!ids.is_empty());
    assert!(ids.iter().all(|id| scope_of(&o.andi, id).is_none()));
    let all: Vec<String> = before.clone();
    let ops = p::ops_for(&o.andi.conn, &s, &dimas, &all).unwrap();
    assert!(ops.len() < all.len(), "team ops are filtered out");
    assert_eq!(
        p::peer_auth(&s, &dimas),
        PeerAuthState::Suspended {
            display_name: "Dimas".into()
        }
    );
    // The derived `members` table only knows active and removed.
    let row: String = o
        .andi
        .conn
        .query_row(
            "SELECT status FROM members WHERE public_key = ?1",
            [&dimas],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(row, "removed");

    // Dimas's laptop syncs the log and sees itself suspended.
    o.andi.sync_to(&mut o.dimas);
    assert_eq!(p::membership(&o.dimas.conn, &o.dimas.id).unwrap(), Membership::Suspended);
    let err = p::author_op(&mut o.dimas.conn, &o.dimas.id, Scope::Org, profile("Dimas"), now())
        .unwrap_err();
    assert!(matches!(err, AppError::Suspended), "{err:?}");

    // Removed for good: nothing at all.
    p::remove_member(&mut o.andi.conn, &o.andi.id, &dimas, now()).unwrap();
    let s = o.andi.state();
    assert!(!p::may_receive(&s, &dimas, None, &o.andi.pk()));
    assert!(p::op_ids_for(&o.andi.conn, &s, &dimas).unwrap().is_empty());
    assert!(p::ops_for(&o.andi.conn, &s, &dimas, &all).unwrap().is_empty());
    assert!(matches!(p::peer_auth(&s, &dimas), PeerAuthState::Removed { .. }));
    let stranger = Node::new("Asing").pk();
    assert!(p::op_ids_for(&o.andi.conn, &s, &stranger).unwrap().is_empty());
    assert_eq!(p::peer_auth(&s, &stranger), PeerAuthState::Unknown);
}

#[test]
fn a_reinstated_laptop_learns_it_and_is_back_in_its_department() {
    let mut o = open_office();
    let dimas = o.dimas.pk();
    // Rina, admin of Desain, suspends and reinstates her regular member.
    o.andi.sync_to(&mut o.rina);
    p::suspend_member(&mut o.rina.conn, &o.rina.id, &dimas, now()).unwrap();
    o.rina.sync_to(&mut o.dimas);
    assert_eq!(p::membership(&o.dimas.conn, &o.dimas.id).unwrap(), Membership::Suspended);
    let err = p::remove_member(&mut o.rina.conn, &o.rina.id, &dimas, now()).unwrap_err();
    assert!(matches!(err, AppError::Forbidden(_)), "{err:?}");
    p::reinstate_member(&mut o.rina.conn, &o.rina.id, &dimas, now()).unwrap();
    o.rina.sync_to(&mut o.dimas);
    assert_eq!(p::membership(&o.dimas.conn, &o.dimas.id).unwrap(), Membership::Active);
    assert_eq!(
        o.dimas.state().team_role(&o.desain, &dimas),
        Some(TeamRole::Member)
    );
    // Back in Desain: team ops flow again.
    let s = o.rina.state();
    assert!(p::may_receive(&s, &dimas, Some(&o.desain), &o.rina.pk()));
}

#[test]
fn actions_check_rights_targets_and_the_gate() {
    let mut o = office();
    let dimas = o.dimas.pk();
    // Nobody reported a version yet: the gate is closed and names them.
    let err = p::suspend_member(&mut o.andi.conn, &o.andi.id, &dimas, now()).unwrap_err();
    let expected = p::suspend_gate_closed(&["Andi".into(), "Dimas".into(), "Rina".into()]);
    assert_eq!(
        expected,
        "Ada laptop yang belum diperbarui ke Mira 0.5.1: Andi, Dimas, Rina. Perbarui dulu, lalu coba lagi."
    );
    assert!(matches!(&err, AppError::InvalidInput(m) if *m == expected), "{err:?}");
    // Someone without the right is told so, not asked to update.
    o.andi.sync_to(&mut o.dimas);
    let andi = o.andi.pk();
    let err = p::suspend_member(&mut o.dimas.conn, &o.dimas.id, &andi, now()).unwrap_err();
    assert!(matches!(err, AppError::Forbidden(_)), "{err:?}");
    let err = p::suspend_member(&mut o.andi.conn, &o.andi.id, "xyz", now()).unwrap_err();
    assert!(matches!(err, AppError::NotFound(_)), "{err:?}");

    all_on(&mut o, crate::device::APP_VERSION);
    p::suspend_member(&mut o.andi.conn, &o.andi.id, &dimas, now()).unwrap();
    let err = p::suspend_member(&mut o.andi.conn, &o.andi.id, &dimas, now()).unwrap_err();
    assert!(matches!(err, AppError::NotFound(_)), "{err:?}");
    // Reinstating is not gated: Rina's laptop reports an old version.
    o.rina.report_version("0.4.0");
    o.rina.sync_to(&mut o.andi);
    assert!(!p::suspend_allowed(&o.andi.state()));
    p::reinstate_member(&mut o.andi.conn, &o.andi.id, &dimas, now()).unwrap();
    let err = p::reinstate_member(&mut o.andi.conn, &o.andi.id, &dimas, now()).unwrap_err();
    assert!(
        matches!(&err, AppError::Forbidden(m) if m == R::TargetNotSuspended.message()),
        "{err:?}"
    );
}

// ----- The version gate ------------------------------------------------------------

/// A version just below `t`.
fn below((a, b, c): (u32, u32, u32)) -> String {
    match (a, b, c) {
        (a, b, c) if c > 0 => format!("{a}.{b}.{}", c - 1),
        (a, b, _) if b > 0 => format!("{a}.{}.99", b - 1),
        (a, _, _) => format!("{}.99.99", a - 1),
    }
}

#[test]
fn suspend_gate_counts_active_members_below_the_threshold() {
    let own = p::join::parse_app_version(crate::device::APP_VERSION).unwrap();
    let t = p::suspend_threshold();
    assert_eq!(t, own.min((0, 5, 1)));
    assert_eq!(p::SUSPEND_SINCE, "0.5.1");
    let at = format!("{}.{}.{}", t.0, t.1, t.2);
    let above = format!("{}.{}.{}", t.0, t.1, t.2 + 1);

    let mut o = office();
    all_on(&mut o, &at);
    assert!(p::suspend_allowed(&o.andi.state()));
    assert!(p::suspend_blockers(&o.andi.state()).is_empty());
    o.rina.report_version(&above);
    o.rina.sync_to(&mut o.andi);
    assert!(p::suspend_allowed(&o.andi.state()));
    o.dimas.report_version(&below(t));
    o.dimas.sync_to(&mut o.andi);
    let s = o.andi.state();
    assert!(!p::suspend_allowed(&s));
    let blockers = p::suspend_blockers(&s);
    assert_eq!(blockers.len(), 1);
    assert_eq!(blockers[0].name, "Dimas");
    assert_eq!(blockers[0].app_version.as_deref(), Some(below(t).as_str()));

    // Suspended and removed members do not hold the gate.
    let mut st = s.clone();
    st.members.get_mut(&o.dimas.pk()).unwrap().status = MemberStatus::Suspended;
    assert!(p::suspend_allowed(&st));
    st.members.get_mut(&o.dimas.pk()).unwrap().status = MemberStatus::Removed;
    assert!(p::suspend_allowed(&st));
    // A member that never reported a version holds it.
    st.members.get_mut(&o.rina.pk()).unwrap().device = None;
    assert_eq!(p::suspend_blockers(&st)[0].name, "Rina");
}

// ----- Views -----------------------------------------------------------------------

#[test]
fn user_list_shows_status_and_allowed_actions() {
    let mut o = open_office();
    let (andi, rina, dimas) = (o.andi.pk(), o.rina.pk(), o.dimas.pk());
    p::suspend_member(&mut o.andi.conn, &o.andi.id, &dimas, now()).unwrap();
    let s = o.andi.state();
    let users = p::users(&o.andi.conn, &s, &andi, Some("Andi"), &HashMap::new()).unwrap();
    let row = |pk: &str| users.iter().find(|u| u.person.public_key == pk).unwrap();
    let d = row(&dimas);
    assert_eq!(d.status, MemberStatus::Suspended);
    assert!(d.suspended_at.is_some());
    assert_eq!(d.suspended_by_name.as_deref(), Some("Andi"));
    assert!(!d.can_suspend && d.can_reinstate && d.can_remove);
    let r = row(&rina);
    assert!(r.can_suspend && !r.can_reinstate && r.can_remove);
    assert!(r.suspended_at.is_none() && r.suspended_by_name.is_none());
    let me = row(&andi);
    assert!(!me.can_suspend && !me.can_reinstate && !me.can_remove);
    // Active first, then suspended.
    assert_eq!(users.last().unwrap().person.public_key, dimas);

    let json = serde_json::to_value(d).unwrap();
    assert_eq!(json["status"], "suspended");
    assert_eq!(json["suspendedByName"], "Andi");
    assert_eq!(json["canSuspend"], false);
    assert_eq!(json["canReinstate"], true);
    assert_eq!(json["canRemove"], true);
    assert!(json["suspendedAt"].is_string());

    // Pickers leave suspended people out; the directory shows the status.
    let people = p::people(&s, &andi, Some("Andi"));
    assert!(people.iter().all(|x| x.public_key != dimas));
    let dir = p::build_directory(&s, &andi, Some("Andi"), now());
    let m = dir.members.iter().find(|m| m.public_key == dimas).unwrap();
    assert_eq!(serde_json::to_value(m).unwrap()["status"], "suspended");

    p::remove_member(&mut o.andi.conn, &o.andi.id, &dimas, now()).unwrap();
    let s = o.andi.state();
    let users = p::users(&o.andi.conn, &s, &andi, Some("Andi"), &HashMap::new()).unwrap();
    let d = users.iter().find(|u| u.person.public_key == dimas).unwrap();
    assert_eq!(d.status, MemberStatus::Removed);
    assert!(!d.can_suspend && !d.can_reinstate && !d.can_remove);
}

#[test]
fn join_info_reports_how_many_laptops_hold_the_ad_gate() {
    let mut o = office();
    let info = p::join_info(&o.dimas.conn).unwrap().unwrap();
    assert_eq!(info.ad_outdated, Some(3));
    all_on(&mut o, crate::device::APP_VERSION);
    let info = p::join_info(&o.dimas.conn).unwrap().unwrap();
    assert_eq!(info.ad_outdated, Some(0));
    let json = serde_json::to_value(&info).unwrap();
    assert_eq!(json["adOutdated"], 0);
    // An answer from an older laptop has no count.
    let mut old = json.clone();
    old.as_object_mut().unwrap().remove("adOutdated");
    let back: p::JoinInfo = serde_json::from_value(old).unwrap();
    assert_eq!(back.ad_outdated, None);
}

#[test]
fn a_request_matching_someone_suspended_or_removed_gets_a_hint() {
    let World {
        mut sim,
        f,
        member_d,
        member_g,
        admin_g,
        ..
    } = world();
    let laptop = |sim: &mut Sim, m: &Actor, name: &str| {
        let body = Body::DeviceSet {
            laptop: name.into(),
            os: "Windows 11".into(),
            app_version: "0.5.0".into(),
        };
        assert_eq!(sim.push(m, body), Ok(()));
    };
    laptop(&mut sim, &member_d, "LAPTOP-DESAIN-03");
    laptop(&mut sim, &member_g, "PC-SARI");
    laptop(&mut sim, &admin_g, "PC-BUDI");
    assert_eq!(sim.push(&f, suspend(&member_d)), Ok(()));
    assert_eq!(sim.push(&f, remove(&member_g)), Ok(()));
    let mut s = sim.state();
    // Sari and Budi were admitted through join requests with AD accounts.
    for (m, user) in [(&member_g, "sari.l"), (&admin_g, "budi")] {
        let id = rand_hex16();
        s.join_decisions.insert(
            id.clone(),
            JoinDecision {
                request: id,
                member: m.pk.clone(),
                name: "x".into(),
                team: "t".into(),
                approved: true,
                by: f.pk.clone(),
                at: "2026-11-01T00:00:00Z".into(),
                ad_account: Some(("biro.co.id".into(), user.into())),
            },
        );
    }
    let new = Actor::new().pk;

    let hit = p::previously_removed(&s, &new, None, "laptop-desain-03").unwrap();
    assert_eq!(hit.name, "Dimas");
    assert_eq!(hit.status, MemberStatus::Suspended);
    assert_eq!(hit.matched_by, PreviousMatch::Laptop);
    assert_eq!(Some(hit.at.clone()), s.member(&member_d.pk).unwrap().suspended_at);

    // The AD account wins over a laptop name match.
    let hit = p::previously_removed(&s, &new, Some(("BIRO.co.id", "Sari.L")), "LAPTOP-DESAIN-03")
        .unwrap();
    assert_eq!(hit.name, "Sari");
    assert_eq!(hit.status, MemberStatus::Removed);
    assert_eq!(hit.matched_by, PreviousMatch::AdAccount);
    assert_eq!(Some(hit.at.clone()), s.member(&member_g.pk).unwrap().removed_at);
    let json = serde_json::to_value(&hit).unwrap();
    assert_eq!(json["match"], "ad_account");
    assert_eq!(json["status"], "removed");

    // Active people, other names and the requester itself give nothing.
    assert!(p::previously_removed(&s, &new, Some(("biro.co.id", "budi")), "PC-BUDI").is_none());
    assert!(p::previously_removed(&s, &new, Some(("lain.co.id", "sari.l")), "PC-LAIN").is_none());
    assert!(p::previously_removed(&s, &new, None, "").is_none());
    assert!(p::previously_removed(&s, &member_d.pk, None, "LAPTOP-DESAIN-03").is_none());
}
