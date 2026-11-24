//! Join requests with real databases: the requester's outbox, a member that
//! receives the request directly, forwarding to approvers, the decision,
//! status answers, installing the organization, and the hardening (pinned
//! genesis, verified rejections, caps per laptop and per address).

use std::net::IpAddr;

use rusqlite::Connection;
use time::OffsetDateTime;

use crate::db;
use crate::identity::{self, Identity, MemoryKeyStore};
use crate::org::{self, Organization};
use crate::permissions::{
    self as p, DeviceProfile, JoinRecord, JoinRequestRefusal, JoinStatusAnswer, JoinTarget,
    OutgoingStatus, SignedJoinRequest,
};

pub(super) struct Node {
    pub(super) _tmp: tempfile::TempDir,
    pub(super) conn: Connection,
    pub(super) id: Identity,
}

pub(super) fn now() -> OffsetDateTime {
    OffsetDateTime::now_utc()
}

pub(super) fn device() -> DeviceProfile {
    DeviceProfile {
        laptop: "LAPTOP-DESAIN-03".into(),
        os: "Windows 11".into(),
        app_version: "0.3.0".into(),
    }
}

pub(super) fn ip(s: &str) -> Option<IpAddr> {
    Some(s.parse().unwrap())
}

impl Node {
    pub(super) fn new(name: &str) -> Node {
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

    pub(super) fn pk(&self) -> String {
        self.id.public_key_hex().to_owned()
    }

    /// Publishes this laptop's device profile with Mira `version`.
    pub(super) fn report_version(&mut self, version: &str) {
        let profile = DeviceProfile {
            app_version: version.into(),
            ..device()
        };
        p::ensure_device_op(&mut self.conn, &self.id, &profile, now()).unwrap();
    }

    pub(super) fn state(&self) -> p::OrgState {
        p::load_state(&self.conn).unwrap().unwrap()
    }

    /// Sends every op `to` may receive.
    pub(super) fn sync_to(&self, to: &mut Node) {
        let state = self.state();
        let ids = p::op_ids_for(&self.conn, &state, &to.pk()).unwrap();
        let missing = p::missing_op_ids(&to.conn, &ids).unwrap();
        let ops = p::ops_for(&self.conn, &state, &to.pk(), &missing).unwrap();
        p::ingest(&mut to.conn, Some(&self.pk()), ops, now()).unwrap();
    }
}

/// Founder Andi (superadmin, in Administrasi), department Desain with admin
/// Rina, plain member Dimas in Desain, and Budi in Administrasi.
pub(super) struct Office {
    pub(super) andi: Node,
    pub(super) rina: Node,
    pub(super) dimas: Node,
    pub(super) desain: String,
    pub(super) admin: String,
}

fn join_by_code(inviter: &mut Node, joiner: &mut Node, team: &str, role: p::InviteRole) {
    let at = now();
    let code = p::create_invite(
        &mut inviter.conn,
        &inviter.id,
        team,
        role,
        vec![],
        p::Validity::H24,
        at,
    )
    .unwrap()
    .1;
    let code = p::normalize_code(&code).unwrap();
    let (org, invite) = p::join_lookup(&inviter.conn, code.tag(), at).unwrap();
    let proof = p::build_join_proof(&code, &org, &invite, &joiner.id).unwrap();
    let accepted = p::join_accept(
        &mut inviter.conn,
        &inviter.id,
        &joiner.pk(),
        &invite,
        &proof,
        at,
    )
    .unwrap();
    p::install_joined_org(
        &mut joiner.conn,
        &joiner.id,
        accepted.org,
        accepted.ops,
        &code,
        at,
    )
    .unwrap();
}

pub(super) fn office() -> Office {
    let mut andi = Node::new("Andi");
    org::create_organization(&mut andi.conn, &andi.id, "Biro Contoh").unwrap();
    let admin = p::create_team(&mut andi.conn, &andi.id, "Administrasi", now())
        .unwrap()
        .id;
    let desain = p::create_team(&mut andi.conn, &andi.id, "Desain", now())
        .unwrap()
        .id;
    let me = andi.pk();
    p::move_member(&mut andi.conn, &andi.id, &me, &admin, now()).unwrap();
    let mut rina = Node::new("Rina");
    let mut dimas = Node::new("Dimas");
    join_by_code(&mut andi, &mut rina, &desain, p::InviteRole::TeamAdmin);
    join_by_code(&mut andi, &mut dimas, &desain, p::InviteRole::Member);
    andi.sync_to(&mut rina);
    andi.sync_to(&mut dimas);
    Office {
        andi,
        rina,
        dimas,
        desain,
        admin,
    }
}

pub(super) fn target(member: &Node, team: &str) -> JoinTarget {
    let info = p::join_info(&member.conn).unwrap().unwrap();
    let dept = info.departments.iter().find(|d| d.id == team).unwrap();
    JoinTarget {
        org: info.org,
        team_id: dept.id.clone(),
        team_name: dept.name.clone(),
    }
}

#[test]
fn request_reaches_an_approver_through_a_member_and_the_requester_joins() {
    let mut o = office();
    let mut sari = Node::new("Sari");
    // Join info: genesis and open departments only.
    let info = p::join_info(&o.dimas.conn).unwrap().unwrap();
    assert_eq!(info.org.name, "Biro Contoh");
    assert_eq!(info.fingerprint, p::org_fingerprint_short(&info.org));
    let names: Vec<&str> = info.departments.iter().map(|d| d.name.as_str()).collect();
    assert_eq!(names, ["Administrasi", "Desain"]);
    assert!(
        p::join_info(&sari.conn).unwrap().is_none(),
        "non-members answer nothing"
    );

    let mine = p::create_join_request(
        &mut sari.conn,
        &sari.id,
        &target(&o.dimas, &o.desain),
        &device(),
        None,
        now(),
    )
    .unwrap();
    assert_eq!(mine.status, OutgoingStatus::Pending);
    assert_eq!(mine.org_name, "Biro Contoh");
    assert_eq!(mine.team_name, "Desain");

    // Dimas (plain member) receives it directly; the key must be Sari's.
    let wrong = p::receive_join_request(
        &mut o.dimas.conn,
        &o.dimas.id,
        &mine.request,
        &o.rina.pk(),
        ip("192.168.1.23"),
        now(),
    );
    assert_eq!(wrong, Err(JoinRequestRefusal::WrongKey));
    let (id, code) = p::receive_join_request(
        &mut o.dimas.conn,
        &o.dimas.id,
        &mine.request,
        &sari.pk(),
        ip("192.168.1.23"),
        now(),
    )
    .unwrap();
    assert_eq!(id, mine.request_id);
    assert_eq!(code, mine.code, "the same code on both screens");
    // Dimas cannot decide it and does not list it.
    let dimas_state = o.dimas.state();
    assert!(
        p::pending_join_requests(&o.dimas.conn, &dimas_state, &o.dimas.pk(), now())
            .unwrap()
            .is_empty()
    );
    assert!(p::approve_join(&mut o.dimas.conn, &o.dimas.id, &id, now()).is_err());
    // Status for Sari: pending; for someone else: unknown.
    assert_eq!(
        p::join_status_for(&o.dimas.conn, &id, &sari.pk()).unwrap(),
        JoinStatusAnswer::Pending
    );
    assert_eq!(
        p::join_status_for(&o.dimas.conn, &id, &o.rina.pk()).unwrap(),
        JoinStatusAnswer::Unknown
    );

    // Forwarded only to approvers: Rina (admin of Desain) and Andi.
    assert!(
        p::join_record_ids_for(&o.dimas.conn, &dimas_state, &o.dimas.pk())
            .unwrap()
            .is_empty()
    );
    let for_rina = p::join_record_ids_for(&o.dimas.conn, &dimas_state, &o.rina.pk()).unwrap();
    assert_eq!(for_rina.len(), 1);
    let unknown = p::unknown_join_record_ids(&o.rina.conn, &for_rina).unwrap();
    let records = p::join_records_for(&o.dimas.conn, &dimas_state, &o.rina.pk(), &unknown).unwrap();
    let bodies: Vec<String> = records.into_iter().map(|(_, b)| b).collect();
    let r = p::ingest_join_records(&mut o.rina.conn, &o.dimas.pk(), &bodies, now()).unwrap();
    assert_eq!(r.accepted, 1);
    assert!(
        p::unknown_join_record_ids(&o.rina.conn, &for_rina)
            .unwrap()
            .is_empty()
    );

    let rina_state = o.rina.state();
    let cards = p::pending_join_requests(&o.rina.conn, &rina_state, &o.rina.pk(), now()).unwrap();
    assert_eq!(cards.len(), 1);
    let card = &cards[0];
    assert_eq!(card.display_name, "Sari");
    assert_eq!(card.team_name, "Desain");
    assert_eq!(card.code, mine.code);
    assert_eq!(card.ip.as_deref(), Some("192.168.1.23"));
    assert_eq!(card.seen_by_name.as_deref(), Some("Dimas"));
    assert_eq!(card.laptop, "LAPTOP-DESAIN-03");
    // A request without the v0.4 fields.
    assert_eq!(card.note, None);
    assert_eq!(card.account, None);
    assert_eq!(mine.note, None);
    assert!(!mine.request.payload.contains("note"));
    assert!(!mine.request.payload.contains("account"));

    p::approve_join(&mut o.rina.conn, &o.rina.id, &id, now()).unwrap();
    let rina_state = o.rina.state();
    assert!(
        p::pending_join_requests(&o.rina.conn, &rina_state, &o.rina.pk(), now())
            .unwrap()
            .is_empty()
    );
    // Dimas learns about it through the log and answers Sari.
    o.rina.sync_to(&mut o.dimas);
    let JoinStatusAnswer::Approved(data) =
        p::join_status_for(&o.dimas.conn, &id, &sari.pk()).unwrap()
    else {
        panic!("approved expected");
    };
    let info =
        p::install_approved_org(&mut sari.conn, &sari.id, data.org, data.ops, now()).unwrap();
    assert_eq!(info.name, "Biro Contoh");
    assert!(p::outgoing_join_request(&sari.conn).unwrap().is_none());
    let s = sari.state();
    assert!(s.is_active(&sari.pk()));
    assert_eq!(s.department_of(&sari.pk()).unwrap().0.id, o.desain);
    // The request is gone from Dimas's store once decided.
    let dimas_state = o.dimas.state();
    assert_eq!(
        p::prune_join_requests(&o.dimas.conn, &dimas_state, now()).unwrap(),
        1
    );
}

#[test]
fn note_and_account_reach_the_approver_card() {
    let mut o = office();
    all_on(&mut o, "0.4.0");
    let mut sari = Node::new("Sari");
    let extras = p::join::JoinExtras {
        note: Some("  Staf gudang, NIK 1234 ".into()),
        account: Some("sari.w".into()),
        ad: None,
    };
    let mine = p::create_join_request(
        &mut sari.conn,
        &sari.id,
        &target(&o.andi, &o.desain),
        &device(),
        Some(&extras),
        now(),
    )
    .unwrap();
    assert_eq!(mine.note.as_deref(), Some("Staf gudang, NIK 1234"));
    let json = serde_json::to_value(&mine).unwrap();
    assert_eq!(json["note"], "Staf gudang, NIK 1234");
    // Read back from the outbox (after a restart).
    let again = p::outgoing_join_request(&sari.conn).unwrap().unwrap();
    assert_eq!(again.note.as_deref(), Some("Staf gudang, NIK 1234"));
    p::receive_join_request(
        &mut o.andi.conn,
        &o.andi.id,
        &mine.request,
        &sari.pk(),
        ip("192.168.1.23"),
        now(),
    )
    .unwrap();
    let state = o.andi.state();
    let cards = p::pending_join_requests(&o.andi.conn, &state, &o.andi.pk(), now()).unwrap();
    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0].note.as_deref(), Some("Staf gudang, NIK 1234"));
    assert_eq!(cards[0].account.as_deref(), Some("sari.w"));
    let card = serde_json::to_value(&cards[0]).unwrap();
    assert_eq!(card["note"], "Staf gudang, NIK 1234");
    assert_eq!(card["account"], "sari.w");
    p::approve_join(&mut o.andi.conn, &o.andi.id, &mine.request_id, now()).unwrap();
    assert!(o.andi.state().is_active(&sari.pk()));
}

#[test]
fn note_is_cleaned_and_checked_before_signing() {
    let o = office();
    let mut sari = Node::new("Sari");
    let make = |sari: &mut Node, note: &str, account: Option<&str>| {
        p::create_join_request(
            &mut sari.conn,
            &sari.id,
            &target(&o.andi, &o.desain),
            &device(),
            Some(&p::join::JoinExtras {
                note: Some(note.into()),
                account: account.map(str::to_owned),
                ad: None,
            }),
            now(),
        )
    };
    // Blank note and no account: the v0.3 shape.
    let blank = make(&mut sari, "   ", None).unwrap();
    assert_eq!(blank.note, None);
    assert!(!blank.request.payload.contains("note"));
    let max = "é".repeat(p::join::JOIN_NOTE_MAX_CHARS);
    assert_eq!(make(&mut sari, &max, None).unwrap().note, Some(max));
    let long = make(
        &mut sari,
        &"x".repeat(p::join::JOIN_NOTE_MAX_CHARS + 1),
        None,
    )
    .unwrap_err();
    assert_eq!(long.code(), "invalid_input");
    assert_eq!(long.to_string(), "Keterangan paling banyak 80 karakter.");
    let newline = make(&mut sari, "Staf\ngudang", None).unwrap_err();
    assert_eq!(newline.code(), "invalid_input");
    // An account name that does not fit is left out, not an error.
    let odd = make(&mut sari, "Staf", Some(&"x".repeat(65))).unwrap();
    assert!(!odd.request.payload.contains("account"));
    let odd = make(&mut sari, "Staf", Some(" \t ")).unwrap();
    assert!(!odd.request.payload.contains("account"));
    // Blank-looking and stacked characters are refused like control ones.
    for bad in ["Staf\u{3164}", "Staf\u{FE0F}x", "a\u{0301}\u{0301}\u{0301}"] {
        let err = make(&mut sari, bad, None).unwrap_err();
        assert_eq!(err.code(), "invalid_input", "{bad:?}");
    }
    let odd = make(&mut sari, "Staf", Some("ri\u{E0041}na")).unwrap();
    assert!(!odd.request.payload.contains("account"));
}

/// Every member of the office reports Mira `version`, and Andi has all
/// the device profiles.
pub(super) fn all_on(o: &mut Office, version: &str) {
    o.andi.report_version(version);
    o.rina.report_version(version);
    o.dimas.report_version(version);
    o.rina.sync_to(&mut o.andi);
    o.dimas.sync_to(&mut o.andi);
    o.andi.sync_to(&mut o.rina);
    o.andi.sync_to(&mut o.dimas);
}

#[test]
fn extras_gate_needs_every_member_on_a_recent_version() {
    let mut o = office();
    let gate = |n: &Node| p::join::join_extras_allowed_since(&n.state(), (0, 4, 0));
    // Members that never reported a device profile count as too old.
    assert!(!gate(&o.andi));
    assert!(!p::join::join_extras_allowed(&o.andi.state()));
    assert!(!p::join_info(&o.andi.conn).unwrap().unwrap().extras);
    all_on(&mut o, "0.4.0");
    assert!(gate(&o.andi));
    assert!(p::join::join_extras_allowed(&o.andi.state()));
    assert!(p::join_info(&o.andi.conn).unwrap().unwrap().extras);
    // One laptop on an older Mira closes the gate again.
    o.dimas.report_version("0.3.0");
    o.dimas.sync_to(&mut o.andi);
    assert!(!gate(&o.andi));
    o.dimas.report_version("0.2.9");
    o.dimas.sync_to(&mut o.andi);
    assert!(!p::join::join_extras_allowed(&o.andi.state()));
    assert!(!p::join_info(&o.andi.conn).unwrap().unwrap().extras);
    o.dimas.report_version("0.4.1");
    o.dimas.sync_to(&mut o.andi);
    assert!(gate(&o.andi));
    // A removed member does not count.
    let rina = o.rina.pk();
    o.rina.report_version("0.3.0");
    o.rina.sync_to(&mut o.andi);
    assert!(!gate(&o.andi));
    p::remove_member(&mut o.andi.conn, &o.andi.id, &rina, now()).unwrap();
    assert!(gate(&o.andi));
}

#[test]
fn requests_with_extras_are_refused_while_the_gate_is_closed() {
    let mut o = office();
    let mut sari = Node::new("Sari");
    let extras = p::join::JoinExtras {
        note: Some("Staf gudang".into()),
        account: Some("sari".into()),
        ad: None,
    };
    let with = p::create_join_request(
        &mut sari.conn,
        &sari.id,
        &target(&o.andi, &o.desain),
        &device(),
        Some(&extras),
        now(),
    )
    .unwrap();
    // No member reported a version yet: closed.
    let refused = p::receive_join_request(
        &mut o.andi.conn,
        &o.andi.id,
        &with.request,
        &sari.pk(),
        ip("192.168.1.23"),
        now(),
    );
    assert_eq!(refused, Err(JoinRequestRefusal::ExtrasNotAccepted));
    let r = JoinRequestRefusal::ExtrasNotAccepted;
    assert_eq!(r.code(), "invalid_request");
    assert_eq!(
        r.message(),
        "Kantor ini masih punya laptop Mira versi lama. Kirim ulang permintaan tanpa keterangan."
    );
    let andi_state = o.andi.state();
    assert!(
        p::pending_join_requests(&o.andi.conn, &andi_state, &o.andi.pk(), now())
            .unwrap()
            .is_empty()
    );
    // The v0.3 shape is taken.
    let plain = p::create_join_request(
        &mut sari.conn,
        &sari.id,
        &target(&o.andi, &o.desain),
        &device(),
        None,
        now(),
    )
    .unwrap();
    assert!(
        p::receive_join_request(
            &mut o.andi.conn,
            &o.andi.id,
            &plain.request,
            &sari.pk(),
            ip("192.168.1.23"),
            now(),
        )
        .is_ok()
    );

    // Forwarding: Dimas (gate open on his laptop) took a request with
    // extras; Rina's laptop has not seen every profile, so it does not
    // store the forwarded copy.
    let mut tia = Node::new("Tia");
    let tia_req = p::create_join_request(
        &mut tia.conn,
        &tia.id,
        &target(&o.andi, &o.desain),
        &device(),
        Some(&extras),
        now(),
    )
    .unwrap();
    o.andi.report_version("0.4.0");
    o.rina.report_version("0.4.0");
    o.dimas.report_version("0.4.0");
    o.andi.sync_to(&mut o.dimas);
    o.rina.sync_to(&mut o.dimas);
    p::receive_join_request(
        &mut o.dimas.conn,
        &o.dimas.id,
        &tia_req.request,
        &tia.pk(),
        ip("192.168.1.24"),
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
    // Rina's own laptop knows only her own profile.
    let r = p::ingest_join_records(&mut o.rina.conn, &o.dimas.pk(), &bodies, now()).unwrap();
    assert_eq!(r.accepted, 0);
    assert!(
        p::unknown_join_record_ids(&o.rina.conn, &ids)
            .unwrap()
            .len()
            == 1,
        "not stored"
    );
    // Once Rina's laptop has every profile, the copy is stored.
    o.dimas.sync_to(&mut o.rina);
    o.andi.sync_to(&mut o.rina);
    let r = p::ingest_join_records(&mut o.rina.conn, &o.dimas.pk(), &bodies, now()).unwrap();
    assert_eq!(r.accepted, 1);
}

#[test]
fn approval_from_a_copy_of_the_office_is_refused() {
    let mut o = office();
    let mut sari = Node::new("Sari");
    let mine = p::create_join_request(
        &mut sari.conn,
        &sari.id,
        &target(&o.andi, &o.desain),
        &device(),
        None,
        now(),
    )
    .unwrap();
    // A rogue laptop makes an organization with the same id and name but
    // its own genesis, and "approves" Sari there.
    let mut rogue = Node::new("Andi");
    let real = org::load_organization(&o.andi.conn).unwrap().unwrap();
    let mut fake = Organization {
        genesis_signature: String::new(),
        founder_public_key: rogue.pk(),
        ..real.clone()
    };
    fake.genesis_signature = hex::encode(rogue.id.sign(&fake.genesis_message()).to_bytes());
    assert!(fake.verify_genesis());
    rogue
        .conn
        .execute(
            "INSERT INTO organizations (id, name, founder_public_key, created_at, genesis_signature)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![fake.id, fake.name, fake.founder_public_key, fake.created_at, fake.genesis_signature],
        )
        .unwrap();
    // The request is pinned to the real genesis: the copy cannot even take it.
    let refused = p::receive_join_request(
        &mut rogue.conn,
        &rogue.id,
        &mine.request,
        &sari.pk(),
        ip("10.0.0.9"),
        now(),
    );
    assert_eq!(refused, Err(JoinRequestRefusal::Invalid));
    // And Sari refuses to install anything but the pinned record.
    let err = p::install_approved_org(&mut sari.conn, &sari.id, fake, vec![], now()).unwrap_err();
    assert_eq!(err.code(), "network");
    assert!(org::load_organization(&sari.conn).unwrap().is_none());
    // Approving in the real office still works.
    p::receive_join_request(
        &mut o.andi.conn,
        &o.andi.id,
        &mine.request,
        &sari.pk(),
        ip("10.0.0.5"),
        now(),
    )
    .unwrap();
    p::approve_join(&mut o.andi.conn, &o.andi.id, &mine.request_id, now()).unwrap();
}

#[test]
fn rejection_is_recorded_only_with_the_matching_reject_op() {
    let mut o = office();
    let mut sari = Node::new("Sari");
    let mine = p::create_join_request(
        &mut sari.conn,
        &sari.id,
        &target(&o.rina, &o.desain),
        &device(),
        None,
        now(),
    )
    .unwrap();
    p::receive_join_request(
        &mut o.rina.conn,
        &o.rina.id,
        &mine.request,
        &sari.pk(),
        ip("192.168.1.30"),
        now(),
    )
    .unwrap();
    // An unrelated op (signed, same organization) is not a rejection.
    let other = p::author_op(
        &mut o.rina.conn,
        &o.rina.id,
        p::Scope::Org,
        p::Body::ProfileSet {
            name: "Rina K".into(),
        },
        now(),
    )
    .unwrap();
    assert!(!p::mark_join_rejected(&sari.conn, &other, "Rina", now()).unwrap());
    p::reject_join(&mut o.rina.conn, &o.rina.id, &mine.request_id, now()).unwrap();
    let JoinStatusAnswer::Rejected { by_name, op, .. } =
        p::join_status_for(&o.rina.conn, &mine.request_id, &sari.pk()).unwrap()
    else {
        panic!("rejected expected");
    };
    assert_eq!(by_name, "Rina K");
    // A tampered op fails the signature check.
    let mut forged = op.clone();
    forged.payload = forged.payload.replace("\"lamport\":", "\"lamport\": ");
    assert!(!p::mark_join_rejected(&sari.conn, &forged, "Rina", now()).unwrap());
    assert!(p::mark_join_rejected(&sari.conn, &op, &by_name, now()).unwrap());
    let mine = p::outgoing_join_request(&sari.conn).unwrap().unwrap();
    assert_eq!(mine.status, OutgoingStatus::Rejected);
    assert_eq!(mine.decided_by_name.as_deref(), Some("Rina K"));
    // A new request gets a new id and code and can be approved.
    let again = p::create_join_request(
        &mut sari.conn,
        &sari.id,
        &target(&o.rina, &o.desain),
        &device(),
        None,
        now(),
    )
    .unwrap();
    assert_ne!(again.request_id, mine.request_id);
    assert_ne!(again.code, mine.code);
    p::receive_join_request(
        &mut o.rina.conn,
        &o.rina.id,
        &again.request,
        &sari.pk(),
        ip("192.168.1.30"),
        now(),
    )
    .unwrap();
    p::approve_join(&mut o.rina.conn, &o.rina.id, &again.request_id, now()).unwrap();
}

#[test]
fn caps_per_address_group_per_key_and_per_laptop() {
    let mut o = office();
    let team = o.admin.clone();
    let send = |o: &mut Office, from: &str| {
        let mut n = Node::new("Tamu Wifi");
        let mine = p::create_join_request(
            &mut n.conn,
            &n.id,
            &target(&o.andi, &team),
            &device(),
            None,
            now(),
        )
        .unwrap();
        let r = p::receive_join_request(
            &mut o.andi.conn,
            &o.andi.id,
            &mine.request,
            &n.pk(),
            ip(from),
            now(),
        );
        (n, mine, r)
    };
    for _ in 0..3 {
        assert!(send(&mut o, "192.168.7.7").2.is_ok());
    }
    assert_eq!(send(&mut o, "192.168.7.7").2, Err(JoinRequestRefusal::Busy));
    // One IPv6 /64 counts as one address.
    for i in 0..3 {
        assert!(send(&mut o, &format!("fd00:1:2:3::{}", i + 1)).2.is_ok());
    }
    assert_eq!(
        send(&mut o, "fd00:1:2:3::99").2,
        Err(JoinRequestRefusal::Busy)
    );
    // A key sending again replaces its own pending request.
    let (mut n, first, r) = send(&mut o, "192.168.8.1");
    assert!(r.is_ok());
    let second = p::create_join_request(
        &mut n.conn,
        &n.id,
        &target(&o.andi, &team),
        &device(),
        None,
        now(),
    )
    .unwrap();
    p::receive_join_request(
        &mut o.andi.conn,
        &o.andi.id,
        &second.request,
        &n.pk(),
        ip("192.168.8.1"),
        now(),
    )
    .unwrap();
    let state = o.andi.state();
    let ids: Vec<String> = p::pending_join_requests(&o.andi.conn, &state, &o.andi.pk(), now())
        .unwrap()
        .into_iter()
        .map(|c| c.id)
        .collect();
    assert!(ids.contains(&second.request_id) && !ids.contains(&first.request_id));
    // At most 50 pending requests per laptop.
    let mut last = Ok((String::new(), String::new()));
    for i in 0..60 {
        last = send(&mut o, &format!("10.1.{}.{}", i / 200, i % 200 + 1)).2;
    }
    assert_eq!(last, Err(JoinRequestRefusal::Busy));
    let state = o.andi.state();
    assert_eq!(
        p::pending_join_requests(&o.andi.conn, &state, &o.andi.pk(), now())
            .unwrap()
            .len(),
        p::MAX_PENDING_REQUESTS
    );
}

#[test]
fn forwarded_records_need_a_valid_signed_observation() {
    let mut o = office();
    let mut sari = Node::new("Sari");
    let mine = p::create_join_request(
        &mut sari.conn,
        &sari.id,
        &target(&o.dimas, &o.desain),
        &device(),
        None,
        now(),
    )
    .unwrap();
    p::receive_join_request(
        &mut o.dimas.conn,
        &o.dimas.id,
        &mine.request,
        &sari.pk(),
        ip("192.168.1.23"),
        now(),
    )
    .unwrap();
    let dimas_state = o.dimas.state();
    let ids = p::join_record_ids_for(&o.dimas.conn, &dimas_state, &o.rina.pk()).unwrap();
    let (_, body) = p::join_records_for(&o.dimas.conn, &dimas_state, &o.rina.pk(), &ids)
        .unwrap()
        .remove(0);
    let record: JoinRecord = serde_json::from_str(&body).unwrap();
    // The forwarder changes the observed address: signature no longer matches.
    let mut moved = record.clone();
    moved.seen.ip = Some("10.9.9.9".into());
    // Not from a member: everything refused.
    let r = p::ingest_join_records(
        &mut o.rina.conn,
        &sari.pk(),
        std::slice::from_ref(&body),
        now(),
    )
    .unwrap();
    assert_eq!((r.accepted, r.rejected), (0, 1));
    let r =
        p::ingest_join_records(&mut o.rina.conn, &o.dimas.pk(), &[moved.body()], now()).unwrap();
    assert_eq!((r.accepted, r.rejected), (0, 1));
    // A request with a forged requester signature.
    let mut forged = record.clone();
    forged.request = SignedJoinRequest {
        payload: record.request.payload.replace("Sari", "Sara"),
        sig: record.request.sig.clone(),
    };
    let r =
        p::ingest_join_records(&mut o.rina.conn, &o.dimas.pk(), &[forged.body()], now()).unwrap();
    assert_eq!((r.accepted, r.rejected), (0, 1));
    let r = p::ingest_join_records(&mut o.rina.conn, &o.dimas.pk(), &[body], now()).unwrap();
    assert_eq!((r.accepted, r.rejected), (1, 0));
}

#[test]
fn removed_laptops_and_archived_departments_are_refused_on_receipt() {
    let mut o = office();
    let empty = p::create_team(&mut o.andi.conn, &o.andi.id, "Interior", now())
        .unwrap()
        .id;
    let mut sari = Node::new("Sari");
    let mine = p::create_join_request(
        &mut sari.conn,
        &sari.id,
        &target(&o.andi, &empty),
        &device(),
        None,
        now(),
    )
    .unwrap();
    p::set_department_archived(&mut o.andi.conn, &o.andi.id, &empty, true, now()).unwrap();
    let r = p::receive_join_request(
        &mut o.andi.conn,
        &o.andi.id,
        &mine.request,
        &sari.pk(),
        ip("192.168.1.40"),
        now(),
    );
    assert_eq!(r, Err(JoinRequestRefusal::TeamNotFound));
    let dimas = o.dimas.pk();
    p::remove_member(&mut o.andi.conn, &o.andi.id, &dimas, now()).unwrap();
    // A removed laptop (Dimas, wiped and asking again with the same key).
    let mut again = Node::new("Dimas");
    let _ = &mut again;
    let dimas_req = {
        let info = p::join_info(&o.andi.conn).unwrap().unwrap();
        let payload = p::JoinRequestPayload {
            v: 1,
            org: info.org.id.clone(),
            org_fp: p::org_fingerprint(&info.org),
            member: dimas.clone(),
            name: "Dimas".into(),
            team: o.desain.clone(),
            laptop: "L".into(),
            os: "Windows 11".into(),
            app_version: "0.3.0".into(),
            note: None,
            account: None,
            ad: None,
            at: p::format::format_time(now()),
            nonce: "ab".repeat(16),
        };
        p::join::sign_join_request(&payload, |m| o.dimas.id.sign(m))
    };
    let r = p::receive_join_request(
        &mut o.andi.conn,
        &o.andi.id,
        &dimas_req,
        &dimas,
        ip("192.168.1.41"),
        now(),
    );
    assert_eq!(r, Err(JoinRequestRefusal::Removed));
}
