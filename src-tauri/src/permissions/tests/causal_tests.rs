//! Causal dependencies: ops signed with a chosen (low or high) lamport
//! cannot win over a revocation they were made concurrently with.

use super::sim::*;
use crate::permissions::fold::Reason as R;
use crate::permissions::{Body, InviteRole, MemberStatus, VerifiedOp, fold, heads, verify_op};

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

fn team_create() -> Body {
    Body::TeamCreate {
        team: rand_hex16(),
        name: "Tim Baru".into(),
    }
}

fn profile(name: &str) -> Body {
    Body::ProfileSet { name: name.into() }
}

/// Founder plus superadmin A (promoted by the founder) and team "Tim A".
fn with_superadmin() -> (Sim, Actor, Actor, String) {
    let mut sim = Sim::new();
    let f = sim.founder();
    let team = sim.team("Tim A");
    let a = sim.join(&team, InviteRole::Member, "Ani");
    assert_eq!(sim.push(&f, sa_add(&a)), Ok(()));
    // So that ops backdated to the current lamport sort after the promotion.
    assert_eq!(sim.push(&f, profile("Sari")), Ok(()));
    (sim, f, a, team)
}

/// Every permutation of the ops gives the same fold.
fn assert_order_free(sim: &Sim) {
    let base = fold(&sim.org, &sim.ops);
    let mut rev = sim.ops.clone();
    rev.reverse();
    let mut rot = sim.ops.clone();
    rot.rotate_left(sim.ops.len() / 2);
    for ops in [rev, rot] {
        let r = fold(&sim.org, &ops);
        assert_eq!(r.state, base.state);
        assert_eq!(r.outcomes, base.outcomes);
    }
}

#[test]
fn backdated_member_remove_counter_attack_is_rejected() {
    let (mut sim, f, a, _) = with_superadmin();
    let seen = sim.lamport;
    let removal = sim.make_at(&f, seen + 1, remove(&a));
    // A learns about the removal and signs a removal of the founder that
    // sorts before it, claiming it has not seen anything newer.
    let counter = sim.make_with_deps(&a, seen, sim.heads_below(seen), remove(&f));
    assert!(counter.order_key() < removal.order_key());
    let _ = sim.add(counter.clone());
    let _ = sim.add(removal.clone());
    assert_eq!(sim.outcome(&removal.id), Ok(()));
    assert_eq!(sim.outcome(&counter.id), Err(R::ConcurrentWithRevocation));
    let s = sim.state();
    assert!(s.is_superadmin(&f.pk));
    assert_eq!(s.member(&a.pk).unwrap().status, MemberStatus::Removed);
    assert_order_free(&sim);
}

#[test]
fn forward_dated_counter_attack_is_rejected() {
    let (mut sim, f, a, _) = with_superadmin();
    let seen = sim.lamport;
    let deps = sim.heads_below(seen + 1);
    assert_eq!(sim.push(&f, remove(&a)), Ok(()));
    // Sorted after the removal, without listing it: A claims it never saw it.
    let counter = sim.make_with_deps(&a, seen + 5, deps, remove(&f));
    assert_eq!(sim.add(counter), Err(R::ConcurrentWithRevocation));
    assert!(sim.state().is_superadmin(&f.pk));
    assert!(!sim.state().is_active(&a.pk));
    assert_order_free(&sim);
}

#[test]
fn concurrent_mutual_removal_is_won_by_the_senior_superadmin() {
    let mut sim = Sim::new();
    let f = sim.founder();
    let team = sim.team("Tim A");
    let a = sim.join(&team, InviteRole::Member, "Ani");
    let b = sim.join(&team, InviteRole::Member, "Budi");
    assert_eq!(sim.push(&f, sa_add(&a)), Ok(()));
    assert_eq!(sim.push(&f, sa_add(&b)), Ok(()));
    // A (promoted first) and B remove each other offline, at every relative
    // lamport. A wins each time.
    for (la, lb) in [(1, 1), (1, 3), (3, 1)] {
        let mut s = Sim {
            org: sim.org.clone(),
            founder: sim.founder(),
            ops: sim.ops.clone(),
            lamport: sim.lamport,
            now: sim.now,
        };
        let deps = s.heads_below(s.lamport + 1);
        let by_a = s.make_with_deps(&a, s.lamport + la, deps.clone(), remove(&b));
        let by_b = s.make_with_deps(&b, s.lamport + lb, deps, remove(&a));
        let _ = s.add(by_a.clone());
        let _ = s.add(by_b.clone());
        assert_eq!(s.outcome(&by_a.id), Ok(()), "{la} {lb}");
        assert_eq!(s.outcome(&by_b.id), Err(R::ConcurrentWithRevocation));
        assert!(s.state().is_superadmin(&a.pk));
        assert!(!s.state().is_active(&b.pk));
        assert_order_free(&s);
    }
}

#[test]
fn removed_superadmin_cannot_strike_whoever_empowered_the_remover() {
    let (mut sim, f, a, team) = with_superadmin();
    let b = sim.join(&team, InviteRole::Member, "Budi");
    let deps_a = sim.heads_below(sim.lamport + 1);
    assert_eq!(sim.push(&f, sa_add(&b)), Ok(()));
    let l = sim.lamport;
    assert_eq!(sim.push(&b, remove(&a)), Ok(()));
    // A, removed by B, removes the founder with a later lamport, which would
    // reject the founder's promotion of B (made concurrently with A's op).
    let strike = sim.make_with_deps(&a, l + 10, deps_a, remove(&f));
    assert_eq!(sim.add(strike), Err(R::ConcurrentWithRevocation));
    let s = sim.state();
    assert!(s.is_superadmin(&f.pk) && s.is_superadmin(&b.pk));
    assert!(!s.is_active(&a.pk));
}

#[test]
fn fake_revocations_do_not_disable_the_rule() {
    let (mut sim, f, a, _) = with_superadmin();
    let outsider = Actor::new();
    let seen = sim.lamport;
    let removal = sim.make_at(&f, seen + 1, remove(&a));
    let counter = sim.make_with_deps(&a, seen, sim.heads_below(seen), remove(&f));
    // Removals of the founder signed by a key that never was a member,
    // sorted after everything, claiming to have seen nothing.
    let fake1 = sim.make_with_deps(&outsider, seen + 50, vec![], remove(&f));
    let fake2 = sim.make_with_deps(&outsider, seen + 51, vec![], remove(&a));
    for op in [
        counter.clone(),
        removal.clone(),
        fake1.clone(),
        fake2.clone(),
    ] {
        let _ = sim.add(op);
    }
    assert_eq!(sim.outcome(&removal.id), Ok(()));
    assert_eq!(sim.outcome(&counter.id), Err(R::ConcurrentWithRevocation));
    assert_eq!(sim.outcome(&fake1.id), Err(R::AuthorNotActive));
    assert_eq!(sim.outcome(&fake2.id), Err(R::AuthorNotActive));
    assert!(sim.state().is_superadmin(&f.pk));
    // A plain member's revocation of the founder does not reject the
    // founder's concurrent ops either.
    let team_b = sim.team("Tim B");
    let m = sim.join(&team_b, InviteRole::Member, "Mira");
    let l = sim.lamport;
    let deps = sim.heads_below(l + 1);
    let by_m = sim.make_with_deps(&m, l + 2, deps.clone(), remove(&f));
    let by_f = sim.make_with_deps(&f, l + 1, deps, team_create());
    let _ = sim.add(by_m.clone());
    assert_eq!(sim.add(by_f), Ok(()));
    assert_eq!(sim.outcome(&by_m.id), Err(R::NotAuthorized));
}

#[test]
fn demoted_team_admin_cannot_backdate_an_invite() {
    type Demote = fn(&str, &Actor) -> Body;
    let demotions: [(&str, Demote); 4] = [
        ("team_admin_unset", |t, a| Body::TeamAdminUnset {
            team: t.into(),
            member: a.pk.clone(),
        }),
        ("team_member_remove", |t, a| Body::TeamMemberRemove {
            team: t.into(),
            member: a.pk.clone(),
        }),
        ("member_remove", |_, a| remove(a)),
        ("team_delete", |t, _| Body::TeamDelete { team: t.into() }),
    ];
    for (name, demote) in demotions {
        let mut sim = Sim::new();
        let f = sim.founder();
        let team = sim.team("Tim A");
        let a = sim.join(&team, InviteRole::TeamAdmin, "Ani");
        // An invite A made before, which the demoting superadmin had seen.
        let old = sim.invite(&a, &team, InviteRole::Member, false);
        assert_eq!(old.outcome, Ok(()));
        let old_op = sim.ops.last().unwrap().id.clone();
        let before = sim.lamport;
        assert_eq!(sim.push(&f, demote(&team, &a)), Ok(()), "{name}");

        let code = new_code();
        let (id, body) = sim.invite_body(&a, &team, InviteRole::Member, false, 24, &code);
        let backdated = sim.make_with_deps(&a, before, sim.heads_below(before), body);
        assert_eq!(
            sim.add(backdated),
            Err(R::ConcurrentWithRevocation),
            "{name}"
        );
        let inv = Invite {
            id,
            code,
            outcome: Ok(()),
        };
        assert!(
            sim.accept(&f, &inv, &Actor::new(), "Xena").is_err(),
            "{name}"
        );
        // The invite made before stays valid as an op.
        assert_eq!(sim.outcome(&old_op), Ok(()), "{name}");
    }
}

#[test]
fn demoted_superadmin_cannot_backdate_superadmin_ops() {
    let (mut sim, f, s2, team) = with_superadmin();
    let before = sim.lamport;
    assert_eq!(
        sim.push(
            &f,
            Body::SuperadminRemove {
                member: s2.pk.clone(),
            },
        ),
        Ok(())
    );
    let deps = sim.heads_below(before);
    let create = sim.make_with_deps(&s2, before, deps.clone(), team_create());
    assert_eq!(sim.add(create), Err(R::ConcurrentWithRevocation));
    let code = new_code();
    let (_, body) = sim.invite_body(&s2, &team, InviteRole::TeamAdmin, false, 24, &code);
    let inv = sim.make_with_deps(&s2, before, deps.clone(), body);
    assert_eq!(sim.add(inv), Err(R::ConcurrentWithRevocation));
    // An op that did not need the superadmin right stays.
    let name = sim.make_with_deps(&s2, before, deps, profile("Ani Baru"));
    assert_eq!(sim.add(name), Ok(()));
}

#[test]
fn backdated_accept_before_invite_revoke_is_rejected() {
    let mut sim = Sim::new();
    let f = sim.founder();
    let team = sim.team("Tim A");
    let m = sim.join(&team, InviteRole::Member, "Mira");
    let inv = sim.invite(&f, &team, InviteRole::Member, false);
    let x = Actor::new();
    assert_eq!(sim.accept(&f, &inv, &x, "Xena"), Ok(()));
    let before = sim.lamport;
    assert_eq!(
        sim.push(
            &f,
            Body::InviteRevoke {
                invite: inv.id.clone(),
            },
        ),
        Ok(())
    );
    let y = Actor::new();
    let body = sim.accept_body(&inv, &y, "Yudi");
    let backdated = sim.make_with_deps(&m, before, sim.heads_below(before), body);
    assert_eq!(sim.add(backdated), Err(R::ConcurrentWithRevocation));
    let s = sim.state();
    assert!(s.is_active(&x.pk), "accepted before the revoke, seen by it");
    assert!(s.member(&y.pk).is_none());
}

#[test]
fn accept_must_have_the_invite_in_its_past() {
    let mut sim = Sim::new();
    let f = sim.founder();
    let team = sim.team("Tim A");
    let m = sim.join(&team, InviteRole::Member, "Mira");
    let before_invite = sim.lamport;
    let inv = sim.invite(&f, &team, InviteRole::Member, true);
    sim.push(&f, profile("Sari")).unwrap();
    sim.push(&f, profile("Sari W")).unwrap();
    let x = Actor::new();
    assert_eq!(sim.accept(&f, &inv, &x, "Xena"), Ok(()));

    // An accept that takes the single-use slot early without having seen
    // the invite.
    let y = Actor::new();
    let early = sim.make_with_deps(
        &m,
        before_invite + 2,
        sim.heads_below(before_invite + 1),
        sim.accept_body(&inv, &y, "Yudi"),
    );
    assert_eq!(sim.add(early), Err(R::BadDeps));
    // No deps at all.
    let z = Actor::new();
    let bare = sim.make_with_deps(
        &m,
        sim.lamport + 1,
        vec![],
        sim.accept_body(&inv, &z, "Zaki"),
    );
    assert_eq!(sim.add(bare), Err(R::BadDeps));
    let s = sim.state();
    assert!(s.is_active(&x.pk));
    assert!(s.member(&y.pk).is_none() && s.member(&z.pk).is_none());
}

#[test]
fn dep_with_an_equal_or_higher_lamport_is_rejected() {
    let mut sim = Sim::new();
    let f = sim.founder();
    sim.team("Tim A");
    sim.push(&f, profile("Sari")).unwrap();
    let last = sim.ops.last().unwrap().clone();
    for lamport in [last.lamport(), last.lamport() - 1] {
        let op = sim.make_with_deps(&f, lamport, vec![last.id.clone()], team_create());
        let r = fold(&sim.org, &[sim.ops.clone(), vec![op.clone()]].concat());
        let outcome = r.outcomes.iter().find(|(i, _)| *i == op.id).unwrap().1;
        assert_eq!(outcome, Err(R::BadDeps), "lamport {lamport}");
    }
    // A missing dep is allowed.
    let op = sim.make_with_deps(&f, sim.lamport + 1, vec!["ab".repeat(32)], team_create());
    assert_eq!(sim.add(op), Ok(()));
}

#[test]
fn deps_format_is_validated() {
    let sim = Sim::new();
    let f = sim.founder();
    let ids = |n: usize| -> Vec<String> {
        let mut v: Vec<String> = (0..n).map(|_| rand_hex16().repeat(2)).collect();
        v.sort();
        v
    };
    let code = |deps: Vec<String>| {
        let p = sim.payload_with_deps(&f, 40, deps, crate::permissions::Scope::Org, team_create());
        verify_op(&Sim::sign(&f, &p), &sim.org.id, sim.now)
            .map(|_| "ok")
            .unwrap_or_else(|e| e.code)
    };
    assert_eq!(code(vec![]), "ok");
    assert_eq!(code(ids(32)), "ok");
    assert_eq!(code(ids(33)), "bad_format", "more than 32");
    let mut upper = ids(2);
    upper[1] = upper[1].to_uppercase();
    assert_eq!(code(upper), "bad_format", "uppercase");
    let mut dup = ids(2);
    dup[1] = dup[0].clone();
    assert_eq!(code(dup), "bad_format", "duplicate");
    let mut unsorted = ids(3);
    unsorted.reverse();
    assert_eq!(code(unsorted), "bad_format", "unsorted");
    assert_eq!(code(vec![rand_hex16()]), "bad_format", "32 hex");
    // Missing field is refused too.
    let p = sim.payload(&f, 1, crate::permissions::Scope::Org, team_create());
    let mut json: serde_json::Value = serde_json::to_value(&p).unwrap();
    json.as_object_mut().unwrap().remove("deps");
    let payload = serde_json::to_string(&json).unwrap();
    let signed = {
        use ed25519_dalek::Signer;
        crate::permissions::SignedOp {
            sig: hex::encode(
                f.sk.sign(&crate::permissions::op::signed_message(&payload))
                    .to_bytes(),
            ),
            payload,
        }
    };
    assert_eq!(
        verify_op(&signed, &sim.org.id, sim.now).unwrap_err().code,
        "bad_format"
    );
}

#[test]
fn heads_skip_ops_with_a_missing_past_and_keep_the_latest_32() {
    let mut sim = Sim::new();
    let f = sim.founder();
    sim.team("Tim A");
    let known = sim.ops.clone();
    let tip = heads(&known);
    assert_eq!(tip.len(), 1);
    // An op listing a withheld op is not vouched for, and does not hide
    // the op it lists either.
    let withheld = "cd".repeat(32);
    let mut deps = tip.clone();
    deps.push(withheld);
    let y = sim.make_with_deps(&f, sim.lamport + 1, deps, profile("Sari"));
    assert_eq!(heads(&[known.clone(), vec![y.clone()]].concat()), tip);
    // A complete op replaces what it lists.
    let z = sim.make_with_deps(&f, sim.lamport + 1, tip.clone(), profile("Sari"));
    assert_eq!(
        heads(&[known.clone(), vec![z.clone()]].concat()),
        vec![z.id]
    );
    // Team ops are never listed.
    let team = rand_hex16();
    let ch = sim.make_at(
        &f,
        sim.lamport + 1,
        Body::ChannelCreate {
            channel: rand_hex16(),
            team: team.clone(),
            name: "tim-a".into(),
        },
    );
    assert_eq!(heads(&[known.clone(), vec![ch]].concat()), tip);

    // 40 concurrent ops: the 32 latest in fold order.
    let mut many: Vec<VerifiedOp> = (0..40)
        .map(|i| sim.make_with_deps(&f, 10 + i, vec![], profile("Sari")))
        .collect();
    let h = heads(&many);
    assert_eq!(h.len(), 32);
    many.sort_by(|a, b| a.order_key().cmp(&b.order_key()));
    let mut latest: Vec<String> = many[8..].iter().map(|o| o.id.clone()).collect();
    latest.sort();
    assert_eq!(h, latest);
}

#[test]
fn honest_sequential_flow_is_unaffected() {
    let mut sim = Sim::new();
    let f = sim.founder();
    let team = sim.team("Tim A");
    let a = sim.join(&team, InviteRole::Member, "Ani");
    let admin = |t: &str, m: &Actor, on: bool| {
        let (team, member) = (t.to_owned(), m.pk.clone());
        if on {
            Body::TeamAdminSet { team, member }
        } else {
            Body::TeamAdminUnset { team, member }
        }
    };
    assert_eq!(sim.push(&f, admin(&team, &a, true)), Ok(()));
    let inv = sim.invite(&a, &team, InviteRole::Member, false);
    assert_eq!(inv.outcome, Ok(()));
    let x = Actor::new();
    assert_eq!(sim.accept(&a, &inv, &x, "Xena"), Ok(()));
    assert_eq!(sim.push(&f, admin(&team, &a, false)), Ok(()));
    let y = Actor::new();
    assert_eq!(
        sim.accept(&f, &inv, &y, "Yudi"),
        Err(R::InviterNotAuthorized)
    );
    assert_eq!(sim.push(&f, admin(&team, &a, true)), Ok(()));
    assert_eq!(sim.accept(&f, &inv, &y, "Yudi"), Ok(()));
    assert_eq!(
        sim.push(
            &a,
            Body::TeamMemberRemove {
                team: team.clone(),
                member: x.pk.clone(),
            },
        ),
        Ok(())
    );
    assert_eq!(sim.push(&f, remove(&y)), Ok(()));
    assert_eq!(sim.push(&f, sa_add(&a)), Ok(()));
    assert_eq!(sim.push(&a, team_create()), Ok(()));
    let rejected: Vec<_> = fold(&sim.org, &sim.ops)
        .outcomes
        .into_iter()
        .filter(|(_, o)| o.is_err())
        .collect();
    assert_eq!(rejected.len(), 1, "only the accept while A was demoted");
}

#[test]
fn concurrent_honest_op_is_rejected_the_same_way_everywhere() {
    let (mut sim, f, a, team) = with_superadmin();
    let deps = sim.heads_below(sim.lamport + 1);
    let l = sim.lamport;
    // Offline at the same time: A adds a team while the founder demotes A.
    let by_a = sim.make_with_deps(&a, l + 1, deps.clone(), team_create());
    let by_f = sim.make_with_deps(
        &f,
        l + 2,
        deps,
        Body::SuperadminRemove {
            member: a.pk.clone(),
        },
    );
    let _ = sim.add(by_f);
    assert_eq!(sim.add(by_a), Err(R::ConcurrentWithRevocation));
    assert!(sim.state().live_team(&team).is_some());
    assert_order_free(&sim);
}

/// Appends an op with the next lamport without folding.
fn append(sim: &mut Sim, by: &Actor, body: Body) -> String {
    sim.lamport += 1;
    let op = sim.make_at(by, sim.lamport, body);
    let id = op.id.clone();
    sim.ops.push(op);
    id
}

/// A larger log (about 1000 ops, 400 revocations) folds in reasonable time,
/// also with a concurrent revocation early on.
#[test]
fn large_log_folds() {
    for concurrent in [false, true] {
        let mut sim = Sim::new();
        let f = sim.founder();
        let teams: Vec<String> = (0..20)
            .map(|_| {
                let t = rand_hex16();
                append(
                    &mut sim,
                    &f,
                    Body::TeamCreate {
                        team: t.clone(),
                        name: "Tim Uji".into(),
                    },
                );
                t
            })
            .collect();
        let a = Actor::new();
        if concurrent {
            // A superadmin whose ops are concurrent with their demotion.
            let inv = sim.invite(&f, &teams[0], InviteRole::Member, false);
            sim.accept(&f, &inv, &a, "Ani").unwrap();
            append(&mut sim, &f, sa_add(&a));
            let deps = sim.heads_below(sim.lamport + 1);
            let by_a = sim.make_with_deps(&a, sim.lamport + 1, deps.clone(), team_create());
            sim.ops.push(by_a);
            append(
                &mut sim,
                &f,
                Body::SuperadminRemove {
                    member: a.pk.clone(),
                },
            );
        }
        for round in 0..20 {
            for t in &teams {
                let code = new_code();
                let (id, body) = sim.invite_body(&f, t, InviteRole::Member, true, 24, &code);
                append(&mut sim, &f, body);
                append(&mut sim, &f, Body::InviteRevoke { invite: id });
            }
            append(&mut sim, &f, profile(&format!("Sari {round:02}")));
        }
        let started = std::time::Instant::now();
        let r = fold(&sim.org, &sim.ops);
        let elapsed = started.elapsed();
        eprintln!("fold of {} ops: {elapsed:?}", r.outcomes.len());
        let rejected = r.outcomes.iter().filter(|(_, o)| o.is_err()).count();
        assert_eq!(rejected, usize::from(concurrent), "{concurrent}");
        assert!(
            elapsed < std::time::Duration::from_secs(10),
            "{} ops: {elapsed:?}",
            r.outcomes.len()
        );
    }
}
