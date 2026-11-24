//! AD onboarding (docs/plans/onboarding-ad.md, 2 and 3.5): the `ad` claim
//! in join requests, its version gate, the `ad_settings_set` op, and what
//! the approver's card makes of a claim.

use ed25519_dalek::{Signer, SigningKey};
use rand_core::OsRng;
use serde::Deserialize;

use super::join_tests::{Node, Office, all_on, device, ip, now, office, target};
use crate::ad::OuMapping;
use crate::error::AppError;
use crate::org::Organization;
use crate::permissions::fold::{DeviceInfo, MemberKind, MemberState, MemberStatus, OrgState};
use crate::permissions::join::{
    self as j, JoinAdClaim, JoinExtras, JoinRequestPayload, MAX_JOIN_REQUEST_BYTES,
};
use crate::permissions::op::{Body, OP_VERSION, Payload, Scope, validate_payload};
use crate::permissions::{self as p, JoinRequestRefusal};

const DOMAIN: &str = "biro.co.id";
const DN: &str = "CN=Sari Lestari,OU=Desain,OU=Kantor Pusat,DC=biro,DC=co,DC=id";

fn claim() -> JoinAdClaim {
    JoinAdClaim {
        domain: DOMAIN.into(),
        user: "sari.l".into(),
        dn: Some(DN.into()),
        name: Some("Sari Lestari".into()),
        department: Some("Desain".into()),
    }
}

fn genesis_org() -> Organization {
    Organization {
        id: "0123456789abcdef0123456789abcdef".into(),
        name: "Biro Contoh".into(),
        founder_public_key: "11".repeat(32),
        created_at: "2026-11-01T00:00:00Z".into(),
        genesis_signature: "22".repeat(64),
    }
}

fn payload(member: &str, ad: Option<JoinAdClaim>) -> JoinRequestPayload {
    JoinRequestPayload {
        v: 1,
        org: genesis_org().id,
        org_fp: j::org_fingerprint(&genesis_org()),
        member: member.into(),
        name: "Sari".into(),
        team: "ab".repeat(16),
        laptop: "LAPTOP-DESAIN-03".into(),
        os: "Windows 11".into(),
        app_version: "0.5.0".into(),
        note: Some("Staf desain".into()),
        account: Some("sari.l".into()),
        ad,
        at: "2026-11-24T08:00:00Z".into(),
        nonce: "cd".repeat(16),
    }
}

/// A DN of at most `MAX_DN_CHARS` characters, most of them four bytes long.
fn long_dn() -> String {
    let dn = format!(
        "CN=Sari,OU={},DC=biro,DC=co,DC=id",
        "\u{1F3E2}".repeat(480)
    );
    assert!(dn.chars().count() <= crate::ad::dn::MAX_DN_CHARS);
    dn
}

fn new_key() -> String {
    hex::encode(SigningKey::generate(&mut OsRng).verifying_key().as_bytes())
}

/// A request as Mira v0.4.0 writes it, byte for byte (with note and account).
const V040_PAYLOAD: &str = concat!(
    "{\"v\":1,\"org\":\"0123456789abcdef0123456789abcdef\",",
    "\"org_fp\":\"ORGFP\",\"member\":\"MEMBER\",\"name\":\"Sari\",",
    "\"team\":\"abababababababababababababababab\",\"laptop\":\"LAPTOP-DESAIN-03\",",
    "\"os\":\"Windows 11\",\"app_version\":\"0.5.0\",\"note\":\"Staf desain\",",
    "\"account\":\"sari.l\",\"at\":\"2026-11-24T08:00:00Z\",",
    "\"nonce\":\"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd\"}"
);

// ----- The claim in the signed request --------------------------------------------

#[test]
fn request_without_ad_is_byte_identical_to_v040() {
    let pk = new_key();
    let v040 = V040_PAYLOAD
        .replace("ORGFP", &j::org_fingerprint(&genesis_org()))
        .replace("MEMBER", &pk);
    let p = j::parse_request_payload(&v040).unwrap();
    assert_eq!(p, payload(&pk, None));
    assert!(!p.has_ad());
    assert_eq!(serde_json::to_string(&payload(&pk, None)).unwrap(), v040);
}

#[test]
fn ad_is_signed_after_account_with_absent_parts_left_out() {
    let sk = SigningKey::generate(&mut OsRng);
    let pk = hex::encode(sk.verifying_key().as_bytes());
    let full = payload(&pk, Some(claim()));
    let signed = j::sign_join_request(&full, |m| sk.sign(m));
    let expected = format!(
        "\"account\":\"sari.l\",\"ad\":{{\"domain\":\"{DOMAIN}\",\"user\":\"sari.l\",\
         \"dn\":\"{DN}\",\"name\":\"Sari Lestari\",\"department\":\"Desain\"}},\"at\""
    );
    assert!(signed.payload.contains(&expected), "{}", signed.payload);
    let parsed = j::parse_request_payload(&signed.payload).unwrap();
    assert_eq!(parsed, full);
    assert!(parsed.has_ad() && parsed.has_extras());
    // Only domain and user: the other keys are absent, not null.
    let bare = JoinAdClaim {
        dn: None,
        name: None,
        department: None,
        ..claim()
    };
    let s = serde_json::to_string(&payload(&pk, Some(bare.clone()))).unwrap();
    assert!(s.contains(&format!(
        "\"ad\":{{\"domain\":\"{DOMAIN}\",\"user\":\"sari.l\"}}"
    )));
    assert_eq!(j::parse_request_payload(&s).unwrap().ad, Some(bare));
}

#[test]
fn null_and_unknown_ad_fields_are_refused() {
    let pk = new_key();
    let ok = serde_json::to_string(&payload(&pk, Some(claim()))).unwrap();
    assert!(j::parse_request_payload(&ok).is_ok());
    let without = serde_json::to_string(&payload(&pk, None)).unwrap();
    let cases = [
        without.replace("\"at\"", "\"ad\":null,\"at\""),
        ok.replace("\"dn\":", "\"dn\":null,\"x\":"),
        ok.replace(
            "\"department\":\"Desain\"",
            "\"department\":\"Desain\",\"title\":\"Staf\"",
        ),
        ok.replace("\"name\":\"Sari Lestari\"", "\"name\":null"),
        ok.replace("\"department\":\"Desain\"", "\"department\":null"),
        ok.replace("\"user\":\"sari.l\",", ""),
        ok.replace("\"user\":\"sari.l\"", "\"user\":5"),
        without.replace("\"at\"", "\"ad\":\"biro.co.id\",\"at\""),
    ];
    for bad in cases {
        assert_ne!(bad, ok);
        assert!(j::parse_request_payload(&bad).is_err(), "{bad}");
    }
}

#[test]
fn invalid_claims_are_refused() {
    let pk = new_key();
    let with = |c: JoinAdClaim| serde_json::to_string(&payload(&pk, Some(c))).unwrap();
    let valid = [
        claim(),
        JoinAdClaim {
            user: "x".repeat(j::AD_USER_MAX_CHARS),
            ..claim()
        },
        JoinAdClaim {
            user: "sari_l-2.adm$".into(),
            ..claim()
        },
        JoinAdClaim {
            name: Some("é".repeat(j::AD_TEXT_MAX_CHARS)),
            ..claim()
        },
        // Escaped characters in the DN.
        JoinAdClaim {
            dn: Some("CN=Lestari\\, Sari,OU=Desain,DC=biro,DC=co,DC=id".into()),
            ..claim()
        },
    ];
    for c in valid {
        assert!(j::parse_request_payload(&with(c.clone())).is_ok(), "{c:?}");
    }
    let mut invalid: Vec<JoinAdClaim> = [
        "Biro.co.id",
        "biro.co.id.",
        " biro.co.id",
        "biro",
        "biro..co.id",
        "",
    ]
    .iter()
    .map(|d| JoinAdClaim {
        domain: (*d).into(),
        dn: None,
        ..claim()
    })
    .collect();
    for user in [
        "",
        " sari",
        "sari ",
        "BIRO\\sari",
        "sari@biro.co.id",
        "sa/ri",
        "sa\"ri",
        "sa[ri]",
        "sa:ri",
        "sa;ri",
        "sa|ri",
        "sa=ri",
        "sa,ri",
        "sa+ri",
        "sa*ri",
        "sa?ri",
        "sa<ri>",
        "sa\u{202E}ri",
        "sa\u{200B}ri",
        "sa\nri",
        &"x".repeat(j::AD_USER_MAX_CHARS + 1),
    ] {
        invalid.push(JoinAdClaim {
            user: user.into(),
            ..claim()
        });
    }
    for dn in [
        // Another domain than the claim's.
        "CN=Sari,OU=Desain,DC=lain,DC=co,DC=id".to_owned(),
        "CN=Sari,OU=Desain".to_owned(),
        "bukan DN".to_owned(),
        String::new(),
        "CN=Sa\u{202E}ri,DC=biro,DC=co,DC=id".to_owned(),
        format!(
            "CN={},DC=biro,DC=co,DC=id",
            "x".repeat(crate::ad::dn::MAX_DN_CHARS)
        ),
    ] {
        invalid.push(JoinAdClaim {
            dn: Some(dn),
            ..claim()
        });
    }
    for text in [
        "",
        " Desain",
        "Desain\n",
        "De\u{3164}sain",
        &"x".repeat(j::AD_TEXT_MAX_CHARS + 1),
    ] {
        invalid.push(JoinAdClaim {
            name: Some(text.into()),
            ..claim()
        });
        invalid.push(JoinAdClaim {
            department: Some(text.into()),
            ..claim()
        });
    }
    for c in invalid {
        assert!(j::check_ad_claim(&c).is_err(), "{c:?}");
        assert!(j::parse_request_payload(&with(c.clone())).is_err(), "{c:?}");
    }
}

#[test]
fn oversized_claim_loses_its_dn_then_itself() {
    let pk = new_key();
    // A long OU of four-byte characters pushes the request past the limit,
    // and without the DN it fits.
    let long_dn = long_dn();
    let mut p = payload(
        &pk,
        Some(JoinAdClaim {
            dn: Some(long_dn.clone()),
            ..claim()
        }),
    );
    assert!(j::check_ad_claim(p.ad.as_ref().unwrap()).is_ok());
    assert!(serde_json::to_string(&p).unwrap().len() > MAX_JOIN_REQUEST_BYTES);
    j::fit_ad_claim(&mut p);
    let ad = p.ad.clone().expect("the claim stays");
    assert_eq!(ad.dn, None);
    assert_eq!(ad.user, "sari.l");
    let s = serde_json::to_string(&p).unwrap();
    assert!(s.len() <= MAX_JOIN_REQUEST_BYTES);
    assert!(j::parse_request_payload(&s).is_ok());

    // Every other field at its widest: the claim goes as a whole.
    let wide = "\u{1F600}";
    let mut p = JoinRequestPayload {
        name: wide.repeat(crate::identity::DISPLAY_NAME_MAX_CHARS),
        laptop: wide.repeat(crate::permissions::format::LAPTOP_NAME_MAX_CHARS),
        os: wide.repeat(crate::permissions::format::OS_NAME_MAX_CHARS),
        note: Some(wide.repeat(j::JOIN_NOTE_MAX_CHARS)),
        account: Some(wide.repeat(j::JOIN_ACCOUNT_MAX_CHARS)),
        ..payload(
            &pk,
            Some(JoinAdClaim {
                dn: Some(long_dn),
                name: Some(wide.repeat(j::AD_TEXT_MAX_CHARS)),
                department: Some(wide.repeat(j::AD_TEXT_MAX_CHARS)),
                ..claim()
            }),
        )
    };
    j::fit_ad_claim(&mut p);
    assert_eq!(p.ad, None);
    let s = serde_json::to_string(&p).unwrap();
    assert!(s.len() <= MAX_JOIN_REQUEST_BYTES, "{}", s.len());
    // A claim that fits is left alone.
    let mut small = payload(&pk, Some(claim()));
    j::fit_ad_claim(&mut small);
    assert_eq!(small.ad, Some(claim()));
}

// ----- Mira v0.4.0 laptops ----------------------------------------------------------

/// `JoinRequestPayload` as Mira v0.4.0 parses it.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct V040Request {
    v: u32,
    org: String,
    org_fp: String,
    member: String,
    name: String,
    team: String,
    laptop: String,
    os: String,
    app_version: String,
    #[serde(default)]
    note: Option<String>,
    #[serde(default)]
    account: Option<String>,
    at: String,
    nonce: String,
}

/// `JoinInfoWire` as Mira v0.4.0 parses it (no `deny_unknown_fields`).
#[derive(Deserialize)]
#[allow(dead_code)]
struct V040Info {
    org: crate::network::OrgRecord,
    fingerprint: String,
    departments: Vec<crate::network::JoinDept>,
    #[serde(default)]
    extras: u32,
}

#[test]
fn v040_refuses_requests_with_ad_and_takes_the_others() {
    // Why the gate exists: v0.4.0 refuses the request and every
    // `join_approve` op that carries it.
    let pk = new_key();
    let with = serde_json::to_string(&payload(&pk, Some(claim()))).unwrap();
    assert!(serde_json::from_str::<V040Request>(&with).is_err());
    let without = serde_json::to_string(&payload(&pk, None)).unwrap();
    assert!(serde_json::from_str::<V040Request>(&without).is_ok());
}

#[test]
fn v040_reads_a_join_info_answer_with_ad_fields() {
    let info = crate::network::JoinInfoWire {
        org: crate::network::OrgRecord {
            id: "a".repeat(32),
            name: "Biro Contoh".into(),
            founder_public_key: "f".repeat(64),
            created_at: "2026-11-22T08:00:00Z".into(),
            genesis_signature: "0".repeat(128),
        },
        fingerprint: "AB12-CD34".into(),
        departments: vec![crate::network::JoinDept {
            id: "1".repeat(32),
            name: "Desain".into(),
        }],
        extras: crate::network::JOIN_INFO_EXTRAS_AD,
        ad_domain: Some(DOMAIN.into()),
        ad_ou_map: vec![crate::network::OuMapWire {
            ou: "Kantor Pusat".into(),
            team: "1".repeat(32),
        }],
        ad_outdated: None,
    };
    let json = serde_json::to_value(&info).unwrap();
    assert_eq!(json["extras"], 2);
    assert_eq!(json["ad_domain"], DOMAIN);
    assert_eq!(json["ad_ou_map"][0]["ou"], "Kantor Pusat");
    let old: V040Info = serde_json::from_value(json.clone()).unwrap();
    // v0.4.0 takes note and account from a member answering 2.
    assert!(old.extras >= crate::network::JOIN_INFO_EXTRAS);
    // Through the frame decoder too.
    let frame =
        serde_json::to_vec(&crate::network::wire::Msg::JoinInfo { info: info.clone() }).unwrap();
    match crate::network::wire::decode(&frame).unwrap() {
        crate::network::wire::Msg::JoinInfo { info: back } => assert_eq!(back, info),
        other => panic!("{other:?}"),
    }
    // Without AD settings the fields are absent.
    let plain = crate::network::JoinInfoWire {
        ad_domain: None,
        ad_ou_map: Vec::new(),
        ..info
    };
    let json = serde_json::to_value(&plain).unwrap();
    assert!(json.get("ad_domain").is_none() && json.get("ad_ou_map").is_none());
}

// ----- The version gate ---------------------------------------------------------

fn member(pk: &str, kind: MemberKind, version: Option<&str>) -> MemberState {
    MemberState {
        public_key: pk.into(),
        display_name: Some(format!("Orang {}", &pk[..2])),
        status: MemberStatus::Active,
        kind,
        is_superadmin: false,
        joined_at: "2026-11-01T00:00:00Z".into(),
        removed_at: None,
        removal_op: None,
        has_profile: true,
        device: version.map(|v| DeviceInfo {
            laptop: "L".into(),
            os: "Windows 11".into(),
            app_version: v.into(),
            at: "2026-11-01T00:00:00Z".into(),
        }),
        suspended_at: None,
        suspended_by: None,
        suspension_op: None,
        snapshot: None,
        joint_suspensions: Vec::new(),
        suspended_by_superadmin: false,
    }
}

fn state_with(members: &[(&str, MemberKind, Option<&str>)]) -> OrgState {
    let mut s = OrgState::genesis(&genesis_org());
    s.members.clear();
    for (pk, kind, v) in members {
        s.members.insert((*pk).into(), member(pk, *kind, *v));
    }
    s
}

#[test]
fn ad_gate_counts_every_active_member_including_guests() {
    let since = (0, 5, 0);
    let a = "aa".repeat(32);
    let b = "bb".repeat(32);
    let g = "cc".repeat(32);
    let all_new = state_with(&[
        (&a, MemberKind::Member, Some("0.5.0")),
        (&b, MemberKind::Member, Some("0.6.1")),
        (&g, MemberKind::Guest, Some("0.5.0-beta.2")),
    ]);
    assert!(j::join_ad_allowed_since(&all_new, since));
    assert!(j::ad_blockers_since(&all_new, since).is_empty());

    // A member still on v0.4.0 keeps the gate closed (it would refuse the
    // request and the op), while the v0.4 extras gate stays open.
    let mut s = all_new.clone();
    s.members.insert(b.clone(), member(&b, MemberKind::Member, Some("0.4.0")));
    assert!(!j::join_ad_allowed_since(&s, since));
    assert!(j::join_extras_allowed_since(&s, (0, 4, 0)));
    let blockers = j::ad_blockers_since(&s, since);
    assert_eq!(blockers.len(), 1);
    assert_eq!(blockers[0].member, b);
    assert_eq!(blockers[0].name, "Orang bb");
    assert_eq!(blockers[0].app_version.as_deref(), Some("0.4.0"));
    let json = serde_json::to_value(&blockers[0]).unwrap();
    assert_eq!(json["appVersion"], "0.4.0");

    // A guest counts too: guests receive the ops.
    let mut s = all_new.clone();
    s.members.insert(g.clone(), member(&g, MemberKind::Guest, Some("0.4.0")));
    assert!(!j::join_ad_allowed_since(&s, since));
    // No profile at all, or an unreadable version, counts as too old.
    let mut s = all_new.clone();
    s.members.insert(g.clone(), member(&g, MemberKind::Guest, None));
    assert!(!j::join_ad_allowed_since(&s, since));
    let blockers = j::ad_blockers_since(&s, since);
    assert_eq!(blockers[0].app_version, None);

    // A removed member does not count.
    let mut s = all_new.clone();
    let mut gone = member(&b, MemberKind::Member, Some("0.3.0"));
    gone.status = MemberStatus::Removed;
    s.members.insert(b.clone(), gone);
    assert!(j::join_ad_allowed_since(&s, since));

    // Blockers are sorted by name.
    let s = state_with(&[
        (&b, MemberKind::Member, Some("0.4.0")),
        (&a, MemberKind::Member, None),
    ]);
    let names: Vec<String> = j::ad_blockers_since(&s, since)
        .into_iter()
        .map(|x| x.name)
        .collect();
    assert_eq!(names, ["Orang aa", "Orang bb"]);
}

#[test]
fn ad_threshold_follows_the_extras_rule() {
    let own = j::parse_app_version(crate::device::APP_VERSION).unwrap();
    let since = j::parse_app_version(j::JOIN_AD_SINCE).unwrap();
    assert_eq!(since, (0, 5, 0));
    assert_eq!(j::join_ad_threshold(), own.min(since));
    assert!(j::is_below_ad_threshold("0.3.9"));
    assert!(j::is_below_ad_threshold("bukan versi"));
    assert!(!j::is_below_ad_threshold("9.0.0"));
}

// ----- The ad_settings_set op --------------------------------------------------------

fn op_payload(body: Body) -> Payload {
    Payload {
        v: OP_VERSION,
        org: "01".repeat(16),
        author: "11".repeat(32),
        lamport: 1,
        deps: Vec::new(),
        at: "2026-11-24T08:00:00Z".into(),
        nonce: "ab".repeat(16),
        scope: Scope::Org,
        body,
    }
}

fn row(ou: &str, team: &str) -> OuMapping {
    OuMapping {
        ou: ou.into(),
        team: team.into(),
    }
}

#[test]
fn ad_settings_op_format_is_checked() {
    let team = "22".repeat(16);
    let set = |domain: &str, map: Vec<OuMapping>| {
        validate_payload(&op_payload(Body::AdSettingsSet {
            domain: domain.into(),
            ou_map: map,
        }))
    };
    assert!(set(DOMAIN, vec![row("Desain", &team)]).is_ok());
    assert!(set("", Vec::new()).is_ok(), "empty domain clears it");
    let full: Vec<OuMapping> = (0..j::AD_OU_MAP_MAX_ROWS)
        .map(|i| row(&format!("OU {i}"), &team))
        .collect();
    assert!(set(DOMAIN, full.clone()).is_ok());
    let mut over = full;
    over.push(row("OU lebih", &team));
    assert!(set(DOMAIN, over).is_err());
    for domain in ["Biro.co.id", "biro.co.id.", "biro", " biro.co.id"] {
        assert!(set(domain, Vec::new()).is_err(), "{domain}");
    }
    for map in [
        vec![row("Desain", &team), row("desain", &team)],
        vec![row("", &team)],
        vec![row(" Desain", &team)],
        vec![row("Desa\nin", &team)],
        vec![row(&"x".repeat(j::AD_OU_MAX_CHARS + 1), &team)],
        vec![row("Desain", "XYZ")],
        vec![row("Desain", &"AB".repeat(16))],
    ] {
        assert!(set(DOMAIN, map.clone()).is_err(), "{map:?}");
    }
    // Team scope is refused; unknown fields in a row too.
    let mut p = op_payload(Body::AdSettingsSet {
        domain: DOMAIN.into(),
        ou_map: Vec::new(),
    });
    p.scope = Scope::Team { team: team.clone() };
    assert!(validate_payload(&p).is_err());
    let json = serde_json::to_string(&op_payload(Body::AdSettingsSet {
        domain: DOMAIN.into(),
        ou_map: vec![row("Desain", &team)],
    }))
    .unwrap();
    assert!(json.contains("\"type\":\"ad_settings_set\""));
    let extra = json.replace("\"team\":\"2222", "\"x\":1,\"team\":\"2222");
    assert_ne!(extra, json);
    assert!(serde_json::from_str::<Payload>(&extra).is_err());
    assert_eq!(
        Body::AdSettingsSet {
            domain: String::new(),
            ou_map: Vec::new()
        }
        .kind(),
        "ad_settings_set"
    );
}

/// Office with every laptop on this build's version, so the AD gate is open.
fn open_office() -> Office {
    let mut o = office();
    all_on(&mut o, crate::device::APP_VERSION);
    o
}

fn op_count(n: &Node) -> usize {
    p::load_ops(&n.conn).unwrap().len()
}

#[test]
fn only_a_superadmin_sets_ad_settings_and_the_latest_wins() {
    let mut o = open_office();
    assert_eq!(o.andi.state().ad, p::AdSettings::default());
    let map = vec![row("Desain", &o.desain), row(" Kantor Pusat ", &o.admin)];
    p::set_ad_settings(&mut o.andi.conn, &o.andi.id, " Biro.CO.id. ", map, now()).unwrap();
    let ad = o.andi.state().ad;
    assert_eq!(ad.domain.as_deref(), Some(DOMAIN));
    assert_eq!(
        ad.ou_map,
        [row("Desain", &o.desain), row("Kantor Pusat", &o.admin)]
    );
    assert!(ad.set);
    // Saving the same thing again writes nothing.
    let before = op_count(&o.andi);
    p::set_ad_settings(
        &mut o.andi.conn,
        &o.andi.id,
        DOMAIN,
        vec![row("Desain", &o.desain), row("Kantor Pusat", &o.admin)],
        now(),
    )
    .unwrap();
    assert_eq!(op_count(&o.andi), before);
    // Clearing: no domain, still `set`.
    p::set_ad_settings(&mut o.andi.conn, &o.andi.id, "", Vec::new(), now()).unwrap();
    let ad = o.andi.state().ad;
    assert_eq!((ad.domain, ad.ou_map.len(), ad.set), (None, 0, true));
    // Other laptops fold the same.
    o.andi.sync_to(&mut o.dimas);
    assert_eq!(o.dimas.state().ad, o.andi.state().ad);

    // A department admin is not a superadmin: refused here and by the fold.
    o.andi.sync_to(&mut o.rina);
    let err = p::set_ad_settings(&mut o.rina.conn, &o.rina.id, DOMAIN, Vec::new(), now())
        .unwrap_err();
    assert!(matches!(err, AppError::Forbidden(_)), "{err:?}");
    let err = p::author_op(
        &mut o.rina.conn,
        &o.rina.id,
        Scope::Org,
        Body::AdSettingsSet {
            domain: DOMAIN.into(),
            ou_map: Vec::new(),
        },
        now(),
    )
    .unwrap_err();
    assert!(matches!(err, AppError::Forbidden(_)), "{err:?}");
}

#[test]
fn ad_settings_need_live_departments_and_valid_input() {
    let mut o = open_office();
    let unknown = "99".repeat(16);
    let err = p::set_ad_settings(
        &mut o.andi.conn,
        &o.andi.id,
        DOMAIN,
        vec![row("Gudang", &unknown)],
        now(),
    )
    .unwrap_err();
    assert!(matches!(err, AppError::NotFound(_)), "{err:?}");
    assert_eq!(
        err.to_string(),
        "Departemen untuk OU \"Gudang\" tidak ditemukan atau sudah dihapus."
    );
    // The fold leaves rows of a missing department out instead of refusing
    // the op: a department deleted concurrently by another superadmin must
    // not undo the domain.
    p::author_op(
        &mut o.andi.conn,
        &o.andi.id,
        Scope::Org,
        Body::AdSettingsSet {
            domain: DOMAIN.into(),
            ou_map: vec![row("Gudang", &unknown), row("Desain", &o.desain)],
        },
        now(),
    )
    .unwrap();
    let ad = o.andi.state().ad;
    assert_eq!(ad.domain.as_deref(), Some(DOMAIN));
    assert_eq!(ad.ou_map, [row("Desain", &o.desain)]);

    // A deleted department is gone; an archived one may stay mapped.
    let gudang = p::create_team(&mut o.andi.conn, &o.andi.id, "Gudang", now())
        .unwrap()
        .id;
    let arsip = p::create_team(&mut o.andi.conn, &o.andi.id, "Arsip", now())
        .unwrap()
        .id;
    p::set_department_archived(&mut o.andi.conn, &o.andi.id, &arsip, true, now()).unwrap();
    p::delete_team(&mut o.andi.conn, &o.andi.id, &gudang, now()).unwrap();
    assert!(
        p::set_ad_settings(
            &mut o.andi.conn,
            &o.andi.id,
            DOMAIN,
            vec![row("Gudang", &gudang)],
            now(),
        )
        .is_err()
    );
    p::set_ad_settings(
        &mut o.andi.conn,
        &o.andi.id,
        DOMAIN,
        vec![row("Arsip", &arsip), row("Desain", &o.desain)],
        now(),
    )
    .unwrap();
    // `join_info` only offers rows of open departments.
    let info = p::join_info(&o.andi.conn).unwrap().unwrap();
    assert_eq!(info.ad_domain.as_deref(), Some(DOMAIN));
    assert_eq!(info.ad_ou_map, [row("Desain", &o.desain)]);
    assert!(info.accepts_ad && info.extras);

    let msg = |r: Result<(), AppError>| match r.unwrap_err() {
        AppError::InvalidInput(m) => m,
        other => panic!("{other:?}"),
    };
    let (conn, id) = (&mut o.andi.conn, &o.andi.id);
    assert_eq!(
        msg(p::set_ad_settings(conn, id, "biro", Vec::new(), now())),
        "Domain tidak valid. Contoh: kantor.co.id"
    );
    assert_eq!(
        msg(p::set_ad_settings(
            conn,
            id,
            DOMAIN,
            vec![row("Desain", &o.desain), row("DESAIN ", &o.admin)],
            now()
        )),
        "OU \"DESAIN\" tercantum lebih dari sekali. Satu OU hanya bisa dipetakan ke satu departemen."
    );
    assert_eq!(
        msg(p::set_ad_settings(
            conn,
            id,
            DOMAIN,
            vec![row("  ", &o.desain)],
            now()
        )),
        "Nama OU harus 1 sampai 64 karakter, tanpa baris baru, tab, atau karakter tak terlihat."
    );
    let many: Vec<OuMapping> = (0..=j::AD_OU_MAP_MAX_ROWS)
        .map(|i| row(&format!("OU {i}"), &o.desain))
        .collect();
    assert_eq!(j::AD_OU_MAP_MAX_ROWS, 100, "the message says 100");
    assert_eq!(
        msg(p::set_ad_settings(conn, id, DOMAIN, many, now())),
        "Pemetaan OU paling banyak 100 baris."
    );
    // Long OU names in many rows would not fit in one op.
    let wide: Vec<OuMapping> = (0..j::AD_OU_MAP_MAX_ROWS)
        .map(|i| row(&format!("{i:03}{}", "漢".repeat(60)), &o.desain))
        .collect();
    assert_eq!(
        msg(p::set_ad_settings(conn, id, DOMAIN, wide, now())),
        "Pemetaan OU terlalu panjang untuk disimpan. Kurangi barisnya atau singkat nama OU-nya."
    );
}

#[test]
fn ad_settings_wait_for_every_laptop() {
    // Nobody reported a version yet: closed.
    let mut o = office();
    assert!(!j::ad_settings_allowed(&o.andi.state()));
    let err = p::set_ad_settings(&mut o.andi.conn, &o.andi.id, DOMAIN, Vec::new(), now())
        .unwrap_err();
    assert!(
        matches!(&err, AppError::InvalidInput(m) if m == p::AD_SETTINGS_GATE_CLOSED),
        "{err:?}"
    );
    assert_eq!(
        p::AD_SETTINGS_GATE_CLOSED,
        "Pengaturan AD baru bisa disimpan setelah semua laptop kantor memakai Mira versi terbaru."
    );
    assert_eq!(p::ad_blockers(&o.andi.state()).len(), 3);
    all_on(&mut o, crate::device::APP_VERSION);
    assert!(p::ad_blockers(&o.andi.state()).is_empty());
    p::set_ad_settings(&mut o.andi.conn, &o.andi.id, DOMAIN, Vec::new(), now()).unwrap();
}

// ----- Requests with a claim, on member laptops ---------------------------------------

fn request_with(
    o: &Office,
    who: &mut Node,
    extras: Option<&JoinExtras>,
    version: &str,
) -> p::OutgoingJoinRequest {
    let profile = p::DeviceProfile {
        app_version: version.into(),
        ..device()
    };
    p::create_join_request(
        &mut who.conn,
        &who.id,
        &target(&o.andi, &o.desain),
        &profile,
        extras,
        now(),
    )
    .unwrap()
}

fn ad_extras(c: JoinAdClaim) -> JoinExtras {
    JoinExtras {
        note: None,
        account: Some("sari.l".into()),
        ad: Some(c),
    }
}

#[test]
fn claims_are_refused_while_the_ad_gate_is_closed() {
    let mut o = office();
    let mut sari = Node::new("Sari");
    let mine = request_with(&o, &mut sari, Some(&ad_extras(claim())), "0.5.0");
    assert!(mine.request.payload.contains("\"ad\":"));
    let refused = p::receive_join_request(
        &mut o.andi.conn,
        &o.andi.id,
        &mine.request,
        &sari.pk(),
        ip("192.168.1.30"),
        now(),
    );
    assert_eq!(refused, Err(JoinRequestRefusal::AdNotAccepted));
    let r = JoinRequestRefusal::AdNotAccepted;
    assert_eq!(r.code(), "invalid_request");
    assert_eq!(
        r.message(),
        "Kantor ini masih punya laptop Mira versi lama. Kirim ulang permintaan tanpa data AD."
    );
    let st = o.andi.state();
    assert!(
        p::pending_join_requests(&o.andi.conn, &st, &o.andi.pk(), now())
            .unwrap()
            .is_empty()
    );

    // Forwarded copies are not stored either while the gate is closed on
    // the receiving laptop.
    all_on(&mut o, crate::device::APP_VERSION);
    p::receive_join_request(
        &mut o.dimas.conn,
        &o.dimas.id,
        &mine.request,
        &sari.pk(),
        ip("192.168.1.30"),
        now(),
    )
    .unwrap();
    let dimas_state = o.dimas.state();
    let ids = p::join_record_ids_for(&o.dimas.conn, &dimas_state, &o.rina.pk()).unwrap();
    let bodies: Vec<String> = p::join_records_for(&o.dimas.conn, &dimas_state, &o.rina.pk(), &ids)
        .unwrap()
        .into_iter()
        .map(|(_, b)| b)
        .collect();
    assert_eq!(bodies.len(), 1);
    // Rina's laptop hears of a laptop on v0.4.0: closed there.
    o.rina.report_version("0.3.9");
    let r = p::ingest_join_records(&mut o.rina.conn, &o.dimas.pk(), &bodies, now()).unwrap();
    assert_eq!(r.accepted, 0);
    assert_eq!(p::unknown_join_record_ids(&o.rina.conn, &ids).unwrap().len(), 1);
    o.rina.report_version(crate::device::APP_VERSION);
    let r = p::ingest_join_records(&mut o.rina.conn, &o.dimas.pk(), &bodies, now()).unwrap();
    assert_eq!(r.accepted, 1);
}

#[test]
fn the_card_shows_the_claim_and_a_suggested_department() {
    let mut o = open_office();
    p::set_ad_settings(
        &mut o.andi.conn,
        &o.andi.id,
        DOMAIN,
        vec![row("Kantor Pusat", &o.admin)],
        now(),
    )
    .unwrap();
    let mut sari = Node::new("Sari");
    // Messy input from the system is cleaned before signing.
    let messy = JoinAdClaim {
        domain: "Biro.CO.ID".into(),
        user: " sari.l ".into(),
        name: Some(" Sari Lestari\u{200B} ".into()),
        ..claim()
    };
    let mine = request_with(&o, &mut sari, Some(&ad_extras(messy)), "0.5.0");
    assert_eq!(mine.ad, Some(claim()));
    let screen = serde_json::to_value(&mine).unwrap();
    assert_eq!(screen["ad"]["user"], "sari.l");
    assert_eq!(screen["ad"]["dn"], DN);
    // After a restart.
    let again = p::outgoing_join_request(&sari.conn).unwrap().unwrap();
    assert_eq!(again.ad, Some(claim()));

    p::receive_join_request(
        &mut o.andi.conn,
        &o.andi.id,
        &mine.request,
        &sari.pk(),
        ip("192.168.1.31"),
        now(),
    )
    .unwrap();
    let st = o.andi.state();
    let cards = p::pending_join_requests(&o.andi.conn, &st, &o.andi.pk(), now()).unwrap();
    assert_eq!(cards.len(), 1);
    let ad = cards[0].ad.clone().expect("claim on the card");
    assert_eq!(ad.user, "sari.l");
    assert_eq!(ad.domain, DOMAIN);
    assert_eq!(ad.ous, ["Desain", "Kantor Pusat"]);
    // The `department` attribute names a Mira department.
    assert_eq!(ad.suggested_team_id.as_deref(), Some(o.desain.as_str()));
    assert!(ad.department_in_mira);
    assert!(!cards[0].requester_outdated);
    let json = serde_json::to_value(&cards[0]).unwrap();
    assert_eq!(json["requesterOutdated"], false);
    let keys: Vec<&String> = json["ad"].as_object().unwrap().keys().collect();
    let mut keys: Vec<&str> = keys.into_iter().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "department",
            "departmentInMira",
            "dn",
            "domain",
            "name",
            "ous",
            "suggestedTeamId",
            "usedBy",
            "user"
        ]
    );
    p::approve_join(&mut o.andi.conn, &o.andi.id, &mine.request_id, now()).unwrap();
    assert!(o.andi.state().is_active(&sari.pk()));
}

#[test]
fn outgoing_claim_reaches_the_screen_with_nulls() {
    let o = open_office();
    let mut sari = Node::new("Sari");
    let bare = JoinAdClaim {
        dn: Some("CN=Sari,DC=lain,DC=co,DC=id".into()),
        name: None,
        department: Some("x".repeat(65)),
        ..claim()
    };
    let mine = request_with(&o, &mut sari, Some(&ad_extras(bare)), "0.5.0");
    // A DN of another domain and a too long department are left out.
    let ad = mine.ad.clone().unwrap();
    assert_eq!((ad.dn, ad.name, ad.department), (None, None, None));
    let json = serde_json::to_value(&mine).unwrap();
    assert_eq!(json["ad"]["dn"], serde_json::Value::Null);
    assert_eq!(json["ad"]["name"], serde_json::Value::Null);
    assert_eq!(json["ad"]["department"], serde_json::Value::Null);
    assert!(!mine.request.payload.contains("\"dn\""));
    // A bad domain or account name drops the claim.
    for c in [
        JoinAdClaim {
            domain: "biro".into(),
            ..claim()
        },
        JoinAdClaim {
            user: "BIRO\\sari".into(),
            ..claim()
        },
    ] {
        let mine = request_with(&o, &mut sari, Some(&ad_extras(c)), "0.5.0");
        assert_eq!(mine.ad, None);
        assert!(!mine.request.payload.contains("\"ad\""));
        assert_eq!(serde_json::to_value(&mine).unwrap()["ad"], serde_json::Value::Null);
    }
    // Oversized: the DN goes, the rest stays.
    let long_dn = long_dn();
    let mine = request_with(
        &o,
        &mut sari,
        Some(&ad_extras(JoinAdClaim {
            dn: Some(long_dn),
            ..claim()
        })),
        "0.5.0",
    );
    let ad = mine.ad.unwrap();
    assert_eq!(ad.dn, None);
    assert_eq!(ad.user, "sari.l");
    assert!(mine.request.payload.len() <= MAX_JOIN_REQUEST_BYTES);
}

#[test]
fn outdated_requesters_are_refused_only_once_ad_settings_exist() {
    let mut o = open_office();
    let mut old = Node::new("Tono");
    let mut older = Node::new("Tini");
    // Mira 0.3.0 requesters (no extras).
    let a = request_with(&o, &mut old, None, "0.3.0");
    let b = request_with(&o, &mut older, None, "0.3.0");
    for (r, n) in [(&a, &old), (&b, &older)] {
        p::receive_join_request(
            &mut o.andi.conn,
            &o.andi.id,
            &r.request,
            &n.pk(),
            ip("192.168.1.40"),
            now(),
        )
        .unwrap();
    }
    // No AD settings: approving works and the card does not warn.
    let st = o.andi.state();
    let cards = p::pending_join_requests(&o.andi.conn, &st, &o.andi.pk(), now()).unwrap();
    assert!(cards.iter().all(|c| !c.requester_outdated));
    p::approve_join(&mut o.andi.conn, &o.andi.id, &a.request_id, now()).unwrap();
    // Tono joined with Mira 0.3.0, which closes the gate; once he is removed
    // it opens again.
    assert!(!j::ad_settings_allowed(&o.andi.state()));
    let tono = old.pk();
    p::remove_member(&mut o.andi.conn, &o.andi.id, &tono, now()).unwrap();

    p::set_ad_settings(&mut o.andi.conn, &o.andi.id, DOMAIN, Vec::new(), now()).unwrap();
    let st = o.andi.state();
    let cards = p::pending_join_requests(&o.andi.conn, &st, &o.andi.pk(), now()).unwrap();
    assert_eq!(cards.len(), 1);
    assert!(cards[0].requester_outdated);
    let err = p::approve_join(&mut o.andi.conn, &o.andi.id, &b.request_id, now()).unwrap_err();
    assert!(
        matches!(&err, AppError::InvalidInput(m) if m == p::REQUESTER_OUTDATED),
        "{err:?}"
    );
    assert!(!o.andi.state().is_active(&older.pk()));
    // Rejecting is still possible.
    p::reject_join(&mut o.andi.conn, &o.andi.id, &b.request_id, now()).unwrap();
}

#[test]
fn join_info_announces_ad_only_with_settings() {
    let mut o = open_office();
    let info = p::join_info(&o.dimas.conn).unwrap().unwrap();
    assert_eq!(info.ad_domain, None);
    assert!(info.ad_ou_map.is_empty());
    assert!(info.accepts_ad);
    p::set_ad_settings(
        &mut o.andi.conn,
        &o.andi.id,
        DOMAIN,
        vec![row("Desain", &o.desain)],
        now(),
    )
    .unwrap();
    o.andi.sync_to(&mut o.dimas);
    let info = p::join_info(&o.dimas.conn).unwrap().unwrap();
    assert_eq!(info.ad_domain.as_deref(), Some(DOMAIN));
    assert_eq!(info.ad_ou_map, [row("Desain", &o.desain)]);
    // A laptop on an older Mira closes the gate, not the settings.
    o.rina.report_version("0.3.0");
    o.rina.sync_to(&mut o.dimas);
    let info = p::join_info(&o.dimas.conn).unwrap().unwrap();
    assert!(!info.accepts_ad);
    assert_eq!(info.ad_domain.as_deref(), Some(DOMAIN));
}

#[test]
fn approving_a_claim_waits_for_the_gate_again() {
    let mut o = open_office();
    let mut sari = Node::new("Sari");
    let mine = request_with(&o, &mut sari, Some(&ad_extras(claim())), "0.5.0");
    p::receive_join_request(
        &mut o.andi.conn,
        &o.andi.id,
        &mine.request,
        &sari.pk(),
        ip("192.168.1.50"),
        now(),
    )
    .unwrap();
    // A laptop on an older Mira shows up after the request was stored.
    o.dimas.report_version("0.3.0");
    o.dimas.sync_to(&mut o.andi);
    assert!(!j::join_ad_allowed(&o.andi.state()));
    let err = p::approve_join(&mut o.andi.conn, &o.andi.id, &mine.request_id, now()).unwrap_err();
    assert!(
        matches!(&err, AppError::InvalidInput(m) if m == p::AD_CLAIM_GATE_CLOSED),
        "{err:?}"
    );
    assert_eq!(
        p::AD_CLAIM_GATE_CLOSED,
        "Permintaan ini membawa data AD, tapi masih ada laptop kantor dengan Mira versi lama. Perbarui Mira di laptop itu dulu, atau tolak permintaan ini dan minta peminta mengirim ulang."
    );
    assert!(!o.andi.state().is_active(&sari.pk()));
    // Once that laptop is updated, the same request can be approved.
    o.dimas.report_version(crate::device::APP_VERSION);
    o.dimas.sync_to(&mut o.andi);
    p::approve_join(&mut o.andi.conn, &o.andi.id, &mine.request_id, now()).unwrap();
    assert!(o.andi.state().is_active(&sari.pk()));
}

#[test]
fn the_card_names_a_member_already_admitted_with_the_same_account() {
    let mut o = open_office();
    let mut sari = Node::new("Sari");
    let first = request_with(&o, &mut sari, Some(&ad_extras(claim())), "0.5.0");
    let receive = |o: &mut Office, r: &p::OutgoingJoinRequest, n: &Node| {
        p::receive_join_request(
            &mut o.andi.conn,
            &o.andi.id,
            &r.request,
            &n.pk(),
            ip("192.168.1.51"),
            now(),
        )
        .unwrap();
    };
    receive(&mut o, &first, &sari);
    let card = |o: &Office| {
        let st = o.andi.state();
        p::pending_join_requests(&o.andi.conn, &st, &o.andi.pk(), now()).unwrap()
    };
    assert_eq!(card(&o)[0].ad.as_ref().unwrap().used_by, None);
    p::approve_join(&mut o.andi.conn, &o.andi.id, &first.request_id, now()).unwrap();
    let decision = o.andi.state().join_decisions[&first.request_id].clone();
    assert_eq!(
        decision.ad_account,
        Some((DOMAIN.to_owned(), "sari.l".to_owned()))
    );

    // Someone else claims the same account, in other letter case.
    let mut tono = Node::new("Tono");
    let copy = JoinAdClaim {
        user: "SARI.L".into(),
        ..claim()
    };
    let second = request_with(&o, &mut tono, Some(&ad_extras(copy)), "0.5.0");
    receive(&mut o, &second, &tono);
    let cards = card(&o);
    assert_eq!(cards.len(), 1);
    let ad = cards[0].ad.as_ref().unwrap();
    assert_eq!(ad.used_by.as_deref(), Some("Sari"));
    assert_eq!(serde_json::to_value(ad).unwrap()["usedBy"], "Sari");
    assert_eq!(p::ad_account_used_by(&o.andi.state(), DOMAIN, "other"), None);
    // Only active members count.
    let sari_pk = sari.pk();
    p::remove_member(&mut o.andi.conn, &o.andi.id, &sari_pk, now()).unwrap();
    assert_eq!(card(&o)[0].ad.as_ref().unwrap().used_by, None);
}

#[test]
fn ad_settings_rows_of_a_department_deleted_meanwhile_are_dropped() {
    let mut o = open_office();
    let gudang = p::create_team(&mut o.andi.conn, &o.andi.id, "Gudang", now())
        .unwrap()
        .id;
    o.andi.sync_to(&mut o.rina);
    // Rina becomes superadmin; both edit at the same time.
    let rina = o.rina.pk();
    p::add_superadmin(&mut o.andi.conn, &o.andi.id, &rina, now()).unwrap();
    o.andi.sync_to(&mut o.rina);
    p::set_ad_settings(
        &mut o.rina.conn,
        &o.rina.id,
        DOMAIN,
        vec![row("Gudang", &gudang), row("Desain", &o.desain)],
        now(),
    )
    .unwrap();
    p::delete_team(&mut o.andi.conn, &o.andi.id, &gudang, now()).unwrap();
    o.rina.sync_to(&mut o.andi);
    o.andi.sync_to(&mut o.rina);
    for n in [&o.andi, &o.rina] {
        let ad = n.state().ad;
        assert_eq!(ad.domain.as_deref(), Some(DOMAIN), "the domain is kept");
        assert!(ad.ou_map.contains(&row("Desain", &o.desain)));
    }
    assert_eq!(o.andi.state().ad, o.rina.state().ad);
}

#[test]
fn join_info_rows_ignore_unknown_fields_but_the_op_does_not() {
    let team = "1".repeat(32);
    let json = serde_json::json!({
        "org": {
            "id": "a".repeat(32),
            "name": "Biro Contoh",
            "founder_public_key": "f".repeat(64),
            "created_at": "2026-11-22T08:00:00Z",
            "genesis_signature": "0".repeat(128),
        },
        "fingerprint": "AB12-CD34",
        "departments": [],
        "extras": 2,
        "ad_domain": DOMAIN,
        "ad_ou_map": [{ "ou": "Desain", "team": team, "priority": 1 }],
    });
    let info: crate::network::JoinInfoWire = serde_json::from_value(json).unwrap();
    assert_eq!(info.ad_ou_map[0].ou, "Desain");
    let row_json = serde_json::json!({ "ou": "Desain", "team": team, "priority": 1 });
    assert!(serde_json::from_value::<OuMapping>(row_json).is_err());
}