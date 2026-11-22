//! Attacks found in the security review of the membership core: replayed
//! invite proofs, extreme timestamps, duplicate JSON keys and lamport jumps.

use super::sim::*;
use crate::permissions::fold::Reason as R;
use crate::permissions::op::{OP_VERSION, signed_message};
use crate::permissions::{
    Body, InviteRole, Payload, Scope, SignedOp, TeamRole, fold, invite_public_key, verify_op,
};

/// Signs an arbitrary JSON payload string with `by`.
fn sign_raw(by: &Actor, payload: &str) -> SignedOp {
    use ed25519_dalek::Signer;
    SignedOp {
        payload: payload.to_owned(),
        sig: hex::encode(by.sk.sign(&signed_message(payload)).to_bytes()),
    }
}

fn payload_with_at(sim: &Sim, by: &Actor, lamport: u64, at: &str, body: Body) -> Payload {
    Payload {
        v: OP_VERSION,
        org: sim.org.id.clone(),
        author: by.pk.clone(),
        lamport,
        deps: sim.heads_below(lamport),
        at: at.into(),
        nonce: rand_hex16(),
        scope: Scope::Org,
        body,
    }
}

#[test]
fn replayed_accept_cannot_restore_a_demoted_team_admin() {
    let mut sim = Sim::new();
    let f = sim.founder();
    let team = sim.team("Tim A");
    // Reusable admin invite; A becomes team admin through it.
    let inv = sim.invite(&f, &team, InviteRole::TeamAdmin, false);
    let a = Actor::new();
    let accept = sim.accept_body(&inv, &a, "Ani");
    assert_eq!(sim.push(&f, accept.clone()), Ok(()));
    assert_eq!(sim.state().team_role(&team, &a.pk), Some(TeamRole::Admin));

    // Superadmin demotes A.
    assert_eq!(
        sim.push(
            &f,
            Body::TeamAdminUnset {
                team: team.clone(),
                member: a.pk.clone(),
            },
        ),
        Ok(())
    );
    // Long after the invite expired, A replays the proof from the log with
    // the original `at` (author-chosen) and a fresh lamport.
    sim.lamport += 1;
    let replay = sim.make_at(&a, sim.lamport, accept);
    assert_eq!(sim.add(replay), Err(R::InviteUsed));
    assert_eq!(sim.state().team_role(&team, &a.pk), Some(TeamRole::Member));
}

#[test]
fn replayed_accept_cannot_put_a_member_back_into_a_team() {
    let mut sim = Sim::new();
    let f = sim.founder();
    let team = sim.team("Tim A");
    let other = sim.team("Tim B");
    let helper = sim.join(&other, InviteRole::Member, "Bayu");
    let inv = sim.invite(&f, &team, InviteRole::Member, false);
    let x = Actor::new();
    let accept = sim.accept_body(&inv, &x, "Xena");
    assert_eq!(sim.push(&f, accept.clone()), Ok(()));
    assert_eq!(
        sim.push(
            &f,
            Body::TeamMemberRemove {
                team: team.clone(),
                member: x.pk.clone(),
            },
        ),
        Ok(())
    );
    // Any other member copies X's proof from the log.
    assert_eq!(sim.push(&helper, accept), Err(R::InviteUsed));
    assert_eq!(sim.state().team_role(&team, &x.pk), None);
}

#[test]
fn extreme_timestamps_are_rejected_without_panicking() {
    let sim = Sim::new();
    let f = sim.founder();
    let team = rand_hex16();
    let code = new_code();
    let invite_body = |expires: &str| Body::InviteCreate {
        invite: rand_hex16(),
        team: team.clone(),
        role: InviteRole::Member,
        projects: vec![],
        expires: expires.into(),
        single_use: false,
        tag: code.tag().into(),
        key: invite_public_key(&code),
        key_sig: "0".repeat(128),
    };
    for (at, expires) in [
        // `at + 7 days` overflows the largest date.
        ("9999-12-31T23:00:00Z", "9999-12-31T23:30:00Z"),
        // Converting to UTC overflows.
        ("9999-12-31T20:00:00-05:00", "9999-12-31T21:00:00-05:00"),
        // `created - 5 minutes` underflows in the fold.
        ("0000-01-01T00:00:00Z", "0000-01-01T01:00:00Z"),
        ("0000-01-01T00:00:00+05:00", "0000-01-01T01:00:00+05:00"),
    ] {
        let p = payload_with_at(&sim, &f, 1, at, invite_body(expires));
        let op = Sim::sign(&f, &p);
        let r = std::panic::catch_unwind(|| verify_op(&op, &sim.org.id, sim.now));
        let r = r.unwrap_or_else(|_| panic!("verify_op panicked for at={at}"));
        assert_eq!(r.map(|_| ()).unwrap_err().code, "bad_format", "{at}");
    }
}

#[test]
fn early_invite_and_accept_fold_without_panicking() {
    // Valid-looking but very old timestamps must not reach date arithmetic
    // that can underflow.
    let mut sim = Sim::new();
    let f = sim.founder();
    let team = sim.team("Tim A");
    let code = new_code();
    let invite = rand_hex16();
    let expires = "1970-01-01T01:00:00Z";
    let key_sig = sim.key_sig(
        &f,
        &invite,
        &team,
        InviteRole::Member,
        &[],
        expires,
        false,
        &code,
    );
    let body = Body::InviteCreate {
        invite: invite.clone(),
        team: team.clone(),
        role: InviteRole::Member,
        projects: vec![],
        expires: expires.into(),
        single_use: false,
        tag: code.tag().into(),
        key: invite_public_key(&code),
        key_sig,
    };
    sim.lamport += 1;
    let p = payload_with_at(&sim, &f, sim.lamport, "1970-01-01T00:00:00Z", body);
    let op = verify_op(&Sim::sign(&f, &p), &sim.org.id, sim.now).unwrap();
    sim.ops.push(op);
    let x = Actor::new();
    let inv = Invite {
        id: invite,
        code,
        outcome: Ok(()),
    };
    sim.now = t("1970-01-01T00:30:00Z");
    assert_eq!(sim.accept(&f, &inv, &x, "Xena"), Ok(()));
}

#[test]
fn duplicate_json_keys_are_rejected() {
    let sim = Sim::new();
    let f = sim.founder();
    let p = sim.payload(
        &f,
        5,
        Scope::Org,
        Body::ProfileSet {
            name: "Sari".into(),
        },
    );
    let json = serde_json::to_string(&p).unwrap();
    let cases = [
        json.replacen("\"lamport\":5", "\"lamport\":5,\"lamport\":1", 1),
        json.replacen(
            "\"type\":\"profile_set\"",
            "\"type\":\"profile_set\",\"type\":\"team_delete\"",
            1,
        ),
        json.replacen(
            "\"name\":\"Sari\"",
            "\"name\":\"Sari\",\"name\":\"Budi\"",
            1,
        ),
        json.replacen("\"kind\":\"org\"", "\"kind\":\"org\",\"kind\":\"org\"", 1),
    ];
    for payload in cases {
        assert_ne!(payload, json);
        let op = sign_raw(&f, &payload);
        let r = verify_op(&op, &sim.org.id, sim.now);
        assert!(r.is_err(), "duplicate key accepted: {payload}");
    }
}

#[test]
fn deeply_nested_json_is_rejected_without_overflow() {
    let sim = Sim::new();
    let f = sim.founder();
    let payload = format!("{}{}", "[".repeat(8000), "]".repeat(8000));
    let op = sign_raw(&f, &payload);
    assert_eq!(
        verify_op(&op, &sim.org.id, sim.now).unwrap_err().code,
        "bad_format"
    );
}

#[test]
fn fold_ignores_input_order_and_duplicates() {
    let mut sim = Sim::new();
    let f = sim.founder();
    let team = sim.team("Tim A");
    let a = sim.join(&team, InviteRole::Member, "Ani");
    sim.push(
        &f,
        Body::TeamAdminSet {
            team: team.clone(),
            member: a.pk.clone(),
        },
    )
    .unwrap();
    let inv = sim.invite(&a, &team, InviteRole::Member, true);
    let x = Actor::new();
    sim.accept(&a, &inv, &x, "Xena").unwrap();
    let mut shuffled = sim.ops.clone();
    shuffled.reverse();
    shuffled.extend(sim.ops.iter().cloned());
    let r1 = fold(&sim.org, &sim.ops);
    let r2 = fold(&sim.org, &shuffled);
    assert_eq!(r1.state, r2.state);
    assert_eq!(r1.outcomes, r2.outcomes);
}

/// Someone who saw an invite in the log copies its public key into an
/// invite of their own (another team or role), hoping the person with the
/// code is admitted there instead.
#[test]
fn invite_key_cannot_be_copied_into_another_invite() {
    let mut sim = Sim::new();
    let f = sim.founder();
    let team_a = sim.team("Tim A");
    let team_b = sim.team("Tim B");
    let admin_b = sim.join(&team_b, InviteRole::TeamAdmin, "Admin B");
    let real = sim.invite(&f, &team_a, InviteRole::Member, false);
    assert_eq!(real.outcome, Ok(()));

    // Admin B knows its own code, but not the real one.
    let own = new_code();
    let (copy_id, mut copy) =
        sim.invite_body(&admin_b, &team_b, InviteRole::Member, false, 24, &own);
    if let Body::InviteCreate { key, tag, .. } = &mut copy {
        *key = invite_public_key(&real.code);
        *tag = real.code.tag().into();
    }
    assert_eq!(sim.push(&admin_b, copy), Err(R::BadInviteSignature));

    // Even with an exact copy of the real `key_sig`.
    let real_sig = sim
        .ops
        .iter()
        .find_map(|o| match &o.payload.body {
            Body::InviteCreate {
                invite, key_sig, ..
            } if *invite == real.id => Some(key_sig.clone()),
            _ => None,
        })
        .unwrap();
    let (_, mut copy) = sim.invite_body(&admin_b, &team_b, InviteRole::Member, false, 24, &own);
    if let Body::InviteCreate {
        key, tag, key_sig, ..
    } = &mut copy
    {
        *key = invite_public_key(&real.code);
        *tag = real.code.tag().into();
        *key_sig = real_sig;
    }
    assert_eq!(sim.push(&admin_b, copy), Err(R::BadInviteSignature));

    // The person with the real code is not admitted through the copy.
    let x = Actor::new();
    let fake = Invite {
        id: copy_id,
        code: real.code.clone(),
        outcome: Ok(()),
    };
    assert_eq!(
        sim.accept(&admin_b, &fake, &x, "Xena"),
        Err(R::InviteNotFound)
    );
}

#[test]
fn invite_key_sig_binds_the_organization_and_founder() {
    // A look-alike organization (same id, another founder) cannot reuse a
    // real invite op's key and signature.
    let mut real = Sim::new();
    let f = real.founder();
    let team = real.team("Tim A");
    let inv = real.invite(&f, &team, InviteRole::Member, false);
    assert_eq!(inv.outcome, Ok(()));
    let real_op = real.ops.last().unwrap().clone();

    let attacker = Actor::new();
    let mut fake = Sim::new();
    fake.org = signed_org(&attacker, "2026-11-22T00:00:00Z");
    fake.org.id = real.org.id.clone();
    {
        use ed25519_dalek::Signer;
        fake.org.genesis_signature =
            hex::encode(attacker.sk.sign(&fake.org.genesis_message()).to_bytes());
    }
    assert!(fake.org.verify_genesis());
    fake.founder = Actor {
        sk: attacker.sk.clone(),
        pk: attacker.pk.clone(),
    };
    let fake_team = match &real_op.payload.body {
        Body::InviteCreate { team, .. } => team.clone(),
        _ => unreachable!(),
    };
    fake.push(
        &attacker,
        Body::TeamCreate {
            team: fake_team,
            name: "Tim A".into(),
        },
    )
    .unwrap();
    // Same body (key, key_sig, team, ...) authored by the fake founder.
    assert_eq!(
        fake.push(&attacker, real_op.payload.body.clone()),
        Err(R::BadInviteSignature)
    );
}
