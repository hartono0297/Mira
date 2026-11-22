//! Op format, signature and verification (plan 1.1).

use super::sim::*;
use crate::permissions::format::format_time;
use crate::permissions::{Body, InviteRole, MAX_PAYLOAD_BYTES, Scope, SignedOp, op_id, verify_op};

fn team_create() -> Body {
    Body::TeamCreate {
        team: rand_hex16(),
        name: "Tim Desain".into(),
    }
}

fn code_of(
    r: Result<crate::permissions::VerifiedOp, crate::permissions::Rejection>,
) -> &'static str {
    r.map(|_| "ok").unwrap_or_else(|e| e.code)
}

#[test]
fn valid_op_verifies_and_id_is_blake3_of_payload() {
    let sim = Sim::new();
    let f = sim.founder();
    let signed = Sim::sign(&f, &sim.payload(&f, 1, Scope::Org, team_create()));
    let v = verify_op(&signed, &sim.org.id, sim.now).unwrap();
    assert_eq!(
        v.id,
        blake3::hash(signed.payload.as_bytes()).to_hex().to_string()
    );
    assert_eq!(v.id, op_id(&signed.payload));
    assert_eq!(v.id.len(), 64);
    assert_eq!(v.author(), f.pk);

    let json = serde_json::to_value(&signed).unwrap();
    assert_eq!(json.as_object().unwrap().len(), 2);
    assert!(json["payload"].is_string());
    assert_eq!(json["sig"].as_str().unwrap().len(), 128);
    let p: serde_json::Value = serde_json::from_str(&signed.payload).unwrap();
    assert_eq!(p["v"], 1);
    assert_eq!(p["scope"]["kind"], "org");
    assert_eq!(p["body"]["type"], "team_create");
}

#[test]
fn tampered_payload_or_signature_is_rejected() {
    let sim = Sim::new();
    let f = sim.founder();
    let signed = Sim::sign(&f, &sim.payload(&f, 1, Scope::Org, team_create()));

    let mut bad = signed.clone();
    bad.payload = bad.payload.replace("Tim Desain", "Tim Desaim");
    assert_eq!(
        code_of(verify_op(&bad, &sim.org.id, sim.now)),
        "bad_signature"
    );

    let mut bad = signed.clone();
    let flip = if bad.sig.starts_with('0') { "1" } else { "0" };
    bad.sig.replace_range(0..1, flip);
    assert_eq!(
        code_of(verify_op(&bad, &sim.org.id, sim.now)),
        "bad_signature"
    );

    let mut bad = signed.clone();
    bad.sig = bad.sig.to_uppercase();
    assert_eq!(
        code_of(verify_op(&bad, &sim.org.id, sim.now)),
        "bad_signature"
    );

    let other = Actor::new();
    let mut forged = sim.payload(&f, 1, Scope::Org, team_create());
    forged.author = f.pk.clone();
    let bad = Sim::sign(&other, &forged);
    assert_eq!(
        code_of(verify_op(&bad, &sim.org.id, sim.now)),
        "bad_signature"
    );

    // Same bytes with a whitespace change are a different message.
    let mut bad = signed;
    bad.payload.push(' ');
    assert_eq!(
        code_of(verify_op(&bad, &sim.org.id, sim.now)),
        "bad_signature"
    );
}

#[test]
fn other_org_is_rejected() {
    let sim = Sim::new();
    let f = sim.founder();
    let signed = Sim::sign(&f, &sim.payload(&f, 1, Scope::Org, team_create()));
    assert_eq!(
        code_of(verify_op(&signed, &rand_hex16(), sim.now)),
        "wrong_org"
    );
}

#[test]
fn unknown_fields_are_rejected() {
    let sim = Sim::new();
    let f = sim.founder();
    let p = sim.payload(&f, 1, Scope::Org, team_create());
    let mut value = serde_json::to_value(&p).unwrap();
    for edit in [
        |v: &mut serde_json::Value| v["extra"] = 1.into(),
        |v: &mut serde_json::Value| v["body"]["extra"] = 1.into(),
        |v: &mut serde_json::Value| v["scope"]["extra"] = 1.into(),
        |v: &mut serde_json::Value| v["body"]["type"] = "team_explode".into(),
        |v: &mut serde_json::Value| v["scope"]["team"] = "ab".repeat(16).into(),
        |v: &mut serde_json::Value| v["scope"] = serde_json::json!({"kind": "team"}),
        |v: &mut serde_json::Value| v["scope"] = serde_json::json!({"kind": "dunia"}),
        |v: &mut serde_json::Value| v["lamport"] = (-1).into(),
        |v: &mut serde_json::Value| {
            v.as_object_mut().unwrap().remove("nonce");
        },
    ] {
        let mut v = value.clone();
        edit(&mut v);
        let payload = serde_json::to_string(&v).unwrap();
        let sig = hex::encode(
            ed25519_dalek::Signer::sign(&f.sk, &crate::permissions::op::signed_message(&payload))
                .to_bytes(),
        );
        let op = SignedOp { payload, sig };
        assert_eq!(
            code_of(verify_op(&op, &sim.org.id, sim.now)),
            "bad_format",
            "{v}"
        );
    }
    value["v"] = 2.into();
    let payload = serde_json::to_string(&value).unwrap();
    let sig = hex::encode(
        ed25519_dalek::Signer::sign(&f.sk, &crate::permissions::op::signed_message(&payload))
            .to_bytes(),
    );
    assert_eq!(
        code_of(verify_op(&SignedOp { payload, sig }, &sim.org.id, sim.now)),
        "bad_format"
    );
}

#[test]
fn future_at_is_rejected_but_can_be_accepted_later() {
    let mut sim = Sim::new();
    let f = sim.founder();
    let receiver_now = sim.now;
    sim.now = receiver_now + time::Duration::minutes(11);
    let signed = Sim::sign(&f, &sim.payload(&f, 1, Scope::Org, team_create()));
    assert_eq!(
        code_of(verify_op(&signed, &sim.org.id, receiver_now)),
        "future"
    );
    let later = receiver_now + time::Duration::minutes(2);
    assert_eq!(code_of(verify_op(&signed, &sim.org.id, later)), "ok");

    sim.now = receiver_now + time::Duration::minutes(9);
    let signed = Sim::sign(&f, &sim.payload(&f, 1, Scope::Org, team_create()));
    assert_eq!(code_of(verify_op(&signed, &sim.org.id, receiver_now)), "ok");
}

#[test]
fn oversized_payload_is_rejected() {
    let sim = Sim::new();
    let op = SignedOp {
        payload: "x".repeat(MAX_PAYLOAD_BYTES + 1),
        sig: "0".repeat(128),
    };
    assert_eq!(code_of(verify_op(&op, &sim.org.id, sim.now)), "too_large");
}

/// Every field format from plan 1.2, checked before the signature.
#[test]
fn field_formats_are_validated() {
    let sim = Sim::new();
    let f = sim.founder();
    let team = rand_hex16();
    let code = new_code();
    let check = |lamport: u64, scope: Scope, body: Body| {
        let p = sim.payload(&f, lamport, scope, body);
        code_of(verify_op(&Sim::sign(&f, &p), &sim.org.id, sim.now))
    };
    let org = || Scope::Org;
    let (_, good_invite) = sim.invite_body(&team, InviteRole::Member, false, 24, &code);
    assert_eq!(check(1, org(), good_invite.clone()), "ok");

    let invite_with = |edit: &dyn Fn(&mut Body)| {
        let mut b = good_invite.clone();
        edit(&mut b);
        b
    };
    let set = |field: &'static str, value: serde_json::Value| {
        move |b: &mut Body| {
            let mut v = serde_json::to_value(&*b).unwrap();
            v[field] = value.clone();
            *b = serde_json::from_value(v).unwrap();
        }
    };

    let bad_cases: Vec<(&str, u64, Scope, Body)> = vec![
        ("lamport 0", 0, org(), team_create()),
        (
            "team id short",
            1,
            org(),
            Body::TeamCreate {
                team: "ab".into(),
                name: "Tim A".into(),
            },
        ),
        (
            "team id upper",
            1,
            org(),
            Body::TeamCreate {
                team: rand_hex16().to_uppercase(),
                name: "Tim A".into(),
            },
        ),
        (
            "team name untrimmed",
            1,
            org(),
            Body::TeamCreate {
                team: rand_hex16(),
                name: " Tim A".into(),
            },
        ),
        (
            "team name short",
            1,
            org(),
            Body::TeamCreate {
                team: rand_hex16(),
                name: "A".into(),
            },
        ),
        (
            "team name long",
            1,
            org(),
            Body::TeamCreate {
                team: rand_hex16(),
                name: "x".repeat(61),
            },
        ),
        (
            "team name control",
            1,
            org(),
            Body::TeamCreate {
                team: rand_hex16(),
                name: "Tim\nA".into(),
            },
        ),
        (
            "member key short",
            1,
            org(),
            Body::SuperadminAdd {
                member: "ab".repeat(31),
            },
        ),
        (
            "member key upper",
            1,
            org(),
            Body::MemberRemove {
                member: f.pk.to_uppercase(),
            },
        ),
        (
            "profile name empty",
            1,
            org(),
            Body::ProfileSet { name: "".into() },
        ),
        (
            "profile name untrimmed",
            1,
            org(),
            Body::ProfileSet {
                name: "Budi ".into(),
            },
        ),
        (
            "profile name long",
            1,
            org(),
            Body::ProfileSet {
                name: "x".repeat(51),
            },
        ),
        (
            "team scope on org op",
            1,
            Scope::Team { team: team.clone() },
            team_create(),
        ),
        (
            "channel with org scope",
            1,
            org(),
            Body::ChannelCreate {
                channel: rand_hex16(),
                team: team.clone(),
                name: "umum-tim".into(),
            },
        ),
        (
            "channel other team scope",
            1,
            Scope::Team { team: rand_hex16() },
            Body::ChannelCreate {
                channel: rand_hex16(),
                team: team.clone(),
                name: "x1".into(),
            },
        ),
        (
            "channel name control",
            1,
            Scope::Team { team: team.clone() },
            Body::ChannelCreate {
                channel: rand_hex16(),
                team: team.clone(),
                name: "a\tb".into(),
            },
        ),
        (
            "invite expires before at",
            1,
            org(),
            invite_with(&set(
                "expires",
                format_time(sim.now - time::Duration::minutes(1)).into(),
            )),
        ),
        (
            "invite expires > 7d",
            1,
            org(),
            invite_with(&set(
                "expires",
                format_time(sim.now + time::Duration::days(7) + time::Duration::minutes(6)).into(),
            )),
        ),
        (
            "invite expires not rfc3339",
            1,
            org(),
            invite_with(&set("expires", "besok".into())),
        ),
        (
            "invite tag lowercase",
            1,
            org(),
            invite_with(&set("tag", code.tag().to_lowercase().into())),
        ),
        (
            "invite tag short",
            1,
            org(),
            invite_with(&set("tag", "ABC".into())),
        ),
        (
            "invite key not hex",
            1,
            org(),
            invite_with(&set("key", "zz".repeat(32).into())),
        ),
        (
            "member invite with projects",
            1,
            org(),
            invite_with(&set("projects", serde_json::json!([rand_hex16()]))),
        ),
        (
            "guest invite without projects",
            1,
            org(),
            invite_with(&|b| {
                set("role", "guest".into())(b);
            }),
        ),
        (
            "guest invite duplicate projects",
            1,
            org(),
            invite_with(&|b| {
                let p = rand_hex16();
                set("role", "guest".into())(b);
                set("projects", serde_json::json!([p, p]))(b);
            }),
        ),
        (
            "guest invite 51 projects",
            1,
            org(),
            invite_with(&|b| {
                set("role", "guest".into())(b);
                set(
                    "projects",
                    serde_json::json!((0..51).map(|_| rand_hex16()).collect::<Vec<_>>()),
                )(b);
            }),
        ),
        (
            "accept sig short",
            1,
            org(),
            Body::InviteAccept {
                invite: rand_hex16(),
                member: f.pk.clone(),
                name: "Budi".into(),
                invite_sig: "ab".into(),
                member_sig: "0".repeat(128),
            },
        ),
        (
            "accept name bad",
            1,
            org(),
            Body::InviteAccept {
                invite: rand_hex16(),
                member: f.pk.clone(),
                name: "Bu\u{202E}di".into(),
                invite_sig: "0".repeat(128),
                member_sig: "0".repeat(128),
            },
        ),
    ];
    for (label, lamport, scope, body) in bad_cases {
        assert_eq!(check(lamport, scope, body), "bad_format", "{label}");
    }

    let guest_ok = invite_with(&|b| {
        set("role", "guest".into())(b);
        set("projects", serde_json::json!([rand_hex16()]))(b);
    });
    assert_eq!(check(1, org(), guest_ok), "ok");
    let seven_days = invite_with(&set(
        "expires",
        format_time(sim.now + time::Duration::days(7) + time::Duration::minutes(5)).into(),
    ));
    assert_eq!(check(1, org(), seven_days), "ok");
}
