//! v0.6 divisions (docs/plans/dept-divisi.md): op format, fold rules,
//! effects of the older ops, department admins, division projects, OU rows
//! with a division, concurrency, the version gate and the read models.

use rand_core::{OsRng, RngCore};

use super::join_tests::{all_on, now, office};
use super::sim::*;
use crate::ad::OuMapping;
use crate::error::AppError;
use crate::permissions::fold::Reason as R;
use crate::permissions::op::{OP_VERSION, Payload, Scope, validate_payload};
use crate::permissions::{
    self as p, Body, DivisionRole, InviteRole, OrgState, VerifiedOp, fold, project_id_for,
};

// ----- Bodies ---------------------------------------------------------------------

fn create(division: &str, team: &str, name: &str) -> Body {
    Body::DivisionCreate {
        division: division.into(),
        team: team.into(),
        name: name.into(),
    }
}

fn rename(division: &str, name: &str) -> Body {
    Body::DivisionRename {
        division: division.into(),
        name: name.into(),
    }
}

fn archive(division: &str, archived: bool) -> Body {
    Body::DivisionArchive {
        division: division.into(),
        archived,
    }
}

fn head(division: &str, m: &Actor, head: bool) -> Body {
    Body::DivisionHeadSet {
        division: division.into(),
        member: m.pk.clone(),
        head,
    }
}

fn add(division: &str, m: &Actor) -> Body {
    Body::DivisionMemberAdd {
        division: division.into(),
        member: m.pk.clone(),
    }
}

fn rm(division: &str, m: &Actor) -> Body {
    Body::DivisionMemberRemove {
        division: division.into(),
        member: m.pk.clone(),
    }
}

fn chat(team: &str, division: Option<&str>, pinned: &str, announce: bool) -> Body {
    Body::ChatSettingsSet {
        team: team.into(),
        division: division.map(str::to_owned),
        pinned: pinned.into(),
        announce,
    }
}

fn admin_set(team: &str, m: &Actor) -> Body {
    Body::TeamAdminSet {
        team: team.into(),
        member: m.pk.clone(),
    }
}

fn admin_unset(team: &str, m: &Actor) -> Body {
    Body::TeamAdminUnset {
        team: team.into(),
        member: m.pk.clone(),
    }
}

fn team_move(team: &str, m: &Actor) -> Body {
    Body::TeamMove {
        team: team.into(),
        member: m.pk.clone(),
    }
}

fn project(creator: &Actor, team: &str, division: Option<&str>) -> Body {
    let nonce = rand_hex16();
    Body::ProjectCreate {
        project: project_id_for(&creator.pk, Some(team), &nonce),
        team: Some(team.into()),
        creator: creator.pk.clone(),
        nonce,
        members: Vec::new(),
        division: division.map(str::to_owned),
    }
}

trait CloneActor {
    fn clone_actor(&self) -> Actor;
}

impl CloneActor for Actor {
    fn clone_actor(&self) -> Actor {
        Actor {
            sk: self.sk.clone(),
            pk: self.pk.clone(),
        }
    }
}

fn clone_sim(sim: &Sim) -> Sim {
    Sim {
        org: sim.org.clone(),
        founder: sim.founder(),
        ops: sim.ops.clone(),
        lamport: sim.lamport,
        now: sim.now,
    }
}

// ----- World ----------------------------------------------------------------------

/// Founder (superadmin, no department), department IT with admin Ani and
/// members Budi and Citra, department HR with member Dedi, guest Gita
/// (through IT), and division "Mobile" in IT.
struct W {
    sim: Sim,
    f: Actor,
    it: String,
    hr: String,
    ani: Actor,
    budi: Actor,
    citra: Actor,
    dedi: Actor,
    gita: Actor,
    mobile: String,
}

fn world() -> W {
    let mut sim = Sim::new();
    let f = sim.founder();
    let it = sim.team("IT");
    let hr = sim.team("HR");
    let ani = sim.join(&it, InviteRole::TeamAdmin, "Ani");
    let budi = sim.join(&it, InviteRole::Member, "Budi");
    let citra = sim.join(&it, InviteRole::Member, "Citra");
    let dedi = sim.join(&hr, InviteRole::Member, "Dedi");
    let gita = sim.join(&it, InviteRole::Guest, "Gita");
    let mobile = rand_hex16();
    assert_eq!(sim.push(&ani, create(&mobile, &it, "Mobile")), Ok(()));
    W {
        sim,
        f,
        it,
        hr,
        ani,
        budi,
        citra,
        dedi,
        gita,
        mobile,
    }
}

impl W {
    fn state(&self) -> OrgState {
        self.sim.state()
    }

    fn role(&self, m: &Actor) -> Option<DivisionRole> {
        self.state().division_role(&self.mobile, &m.pk)
    }

    /// Recorded in the division at all (whatever the filters say).
    fn recorded(&self, m: &Actor) -> bool {
        self.state().divisions[&self.mobile]
            .members
            .contains_key(&m.pk)
    }
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

fn shuffled(ops: &[VerifiedOp]) -> Vec<VerifiedOp> {
    let mut out = ops.to_vec();
    for i in (1..out.len()).rev() {
        let j = (OsRng.next_u64() % (i as u64 + 1)) as usize;
        out.swap(i, j);
    }
    out
}

// ----- Op format ------------------------------------------------------------------------

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

#[test]
fn division_ops_have_kinds_and_checked_fields() {
    let d = "22".repeat(16);
    let t = "33".repeat(16);
    let m = Actor::new();
    let kinds = [
        (create(&d, &t, "Mobile"), "division_create"),
        (rename(&d, "Web"), "division_rename"),
        (archive(&d, true), "division_archive"),
        (head(&d, &m, true), "division_head_set"),
        (add(&d, &m), "division_member_add"),
        (rm(&d, &m), "division_member_remove"),
        (chat(&t, Some(&d), "Halo", true), "chat_settings_set"),
        (chat(&t, None, "", false), "chat_settings_set"),
    ];
    for (body, kind) in kinds {
        assert_eq!(body.kind(), kind);
        let payload = op_payload(body.clone());
        assert!(validate_payload(&payload).is_ok(), "{kind}");
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains(&format!("\"type\":\"{kind}\"")));
        assert_eq!(serde_json::from_str::<Payload>(&json).unwrap(), payload);
        // Team scope is refused for every division op.
        let mut scoped = payload;
        scoped.scope = Scope::Team { team: t.clone() };
        assert!(validate_payload(&scoped).is_err(), "{kind}");
    }
    let bad = [
        create("XYZ", &t, "Mobile"),
        create(&d, &"AB".repeat(16), "Mobile"),
        create(&d, &t, "M"),
        create(&d, &t, " Mobile"),
        create(&d, &t, "Mo\nbile"),
        rename(&d, &"x".repeat(61)),
        Body::DivisionMemberAdd {
            division: d.clone(),
            member: "12".into(),
        },
        chat(&t, Some("zz"), "", false),
        chat(&t, None, &"x".repeat(p::PINNED_MAX_CHARS + 1), false),
        chat(&t, None, " Halo", false),
        chat(&t, None, "Halo\n", false),
        chat(&t, None, "Ha\tlo", false),
        chat(&t, None, "Ha\u{200B}lo", false),
    ];
    for body in bad {
        assert!(
            validate_payload(&op_payload(body.clone())).is_err(),
            "{body:?}"
        );
    }
    for ok in [
        String::new(),
        "x".repeat(p::PINNED_MAX_CHARS),
        "Rapat Senin\njam 9\n\nbawa laptop".into(),
    ] {
        assert!(p::is_valid_pinned_note(&ok));
        assert!(validate_payload(&op_payload(chat(&t, None, &ok, false))).is_ok());
    }
}

#[test]
fn old_shapes_keep_their_bytes_and_unknown_fields_are_refused() {
    let k = "11".repeat(32);
    let old = format!(
        "{{\"v\":1,\"org\":\"{o}\",\"author\":\"{k}\",\"lamport\":1,\"deps\":[],\"at\":\"2026-11-24T08:00:00Z\",\"nonce\":\"{n}\",\"scope\":{{\"kind\":\"org\"}},\"body\":{{\"type\":\"project_create\",\"project\":\"{pr}\",\"team\":\"{t}\",\"creator\":\"{k}\",\"nonce\":\"{n}\",\"members\":[\"{m}\"]}}}}",
        o = "01".repeat(16),
        n = "ab".repeat(16),
        pr = "22".repeat(16),
        t = "33".repeat(16),
        m = "44".repeat(32),
    );
    let parsed: Payload = serde_json::from_str(&old).unwrap();
    assert!(matches!(
        &parsed.body,
        Body::ProjectCreate { division: None, .. }
    ));
    assert_eq!(serde_json::to_string(&parsed).unwrap(), old);
    assert!(validate_payload(&parsed).is_ok());

    // With a division the field follows the members.
    let mut with = parsed.clone();
    if let Body::ProjectCreate { division, .. } = &mut with.body {
        *division = Some("55".repeat(16));
    }
    let json = serde_json::to_string(&with).unwrap();
    assert!(json.ends_with(&format!("\"division\":\"{}\"}}}}", "55".repeat(16))));
    assert!(validate_payload(&with).is_ok());
    // A division project needs a department.
    if let Body::ProjectCreate { team, .. } = &mut with.body {
        *team = None;
    }
    assert!(validate_payload(&with).is_err());

    // OU rows: old shape byte-identical, a division is checked.
    let row = format!("{{\"ou\":\"Desain\",\"team\":\"{}\"}}", "22".repeat(16));
    let parsed: OuMapping = serde_json::from_str(&row).unwrap();
    assert_eq!(parsed.division, None);
    assert_eq!(serde_json::to_string(&parsed).unwrap(), row);
    let ad = |division: Option<String>| {
        validate_payload(&op_payload(Body::AdSettingsSet {
            domain: "biro.co.id".into(),
            ou_map: vec![OuMapping {
                ou: "Desain".into(),
                team: "22".repeat(16),
                division,
            }],
        }))
    };
    assert!(ad(Some("66".repeat(16))).is_ok());
    assert!(ad(Some("6".into())).is_err());

    // Unknown fields are refused in the new bodies.
    let json = serde_json::to_string(&op_payload(create(
        &"22".repeat(16),
        &"33".repeat(16),
        "Mobile",
    )))
    .unwrap();
    let extra = json.replace("\"name\":", "\"x\":1,\"name\":");
    assert_ne!(extra, json);
    assert!(serde_json::from_str::<Payload>(&extra).is_err());
    let json = serde_json::to_string(&op_payload(chat(&"33".repeat(16), None, "", true))).unwrap();
    assert!(json.contains("\"division\":null"));
    let extra = json.replace("\"announce\":", "\"pin\":1,\"announce\":");
    assert!(serde_json::from_str::<Payload>(&extra).is_err());
}

#[test]
fn every_new_reason_has_a_code_and_an_indonesian_message() {
    let codes = [
        (R::DivisionNotFound, "division_not_found"),
        (R::DivisionArchived, "division_archived"),
        (R::AlreadyInDivision, "already_in_division"),
        (R::NotInDivision, "not_in_division"),
        (R::AlreadyDivisionHead, "already_division_head"),
        (R::NotDivisionHead, "not_division_head"),
        (R::TargetNotInDepartment, "target_not_in_department"),
        (R::LastTeamAdmin, "last_team_admin"),
    ];
    for (reason, code) in codes {
        assert_eq!(reason.code(), code);
        assert_eq!(R::parse(code), Some(reason));
        assert!(!reason.message().is_empty());
        assert!(!reason.message().contains('\u{2014}'));
    }
    assert!(p::DIVISION_GATE_CLOSED.contains("0.6.0"));
    assert!(!p::DIVISION_GATE_CLOSED.contains('\u{2014}'));
}

// ----- Fold rules --------------------------------------------------------------------------

#[test]
fn creating_renaming_and_archiving_divisions() {
    let mut w = world();
    let (f, ani, budi) = (w.f.clone_actor(), w.ani.clone_actor(), w.budi.clone_actor());
    // An admin creates only in their department; members never.
    assert_eq!(
        w.sim.push(&ani, create(&rand_hex16(), &w.hr, "Rekrut")),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&budi, create(&rand_hex16(), &w.it, "Web")),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&f, create(&rand_hex16(), &w.hr, "Rekrut")),
        Ok(())
    );
    assert_eq!(
        w.sim.push(&f, create(&rand_hex16(), &rand_hex16(), "X1")),
        Err(R::TeamNotFound)
    );
    assert_eq!(
        w.sim.push(&f, create(&w.mobile.clone(), &w.it, "Lagi")),
        Err(R::IdInUse)
    );
    assert_eq!(
        w.sim.push(&f, create(&w.it.clone(), &w.it, "Lagi")),
        Err(R::IdInUse)
    );
    let old = w.sim.team("Lama");
    assert_eq!(
        w.sim.push(
            &f,
            Body::TeamArchive {
                team: old.clone(),
                archived: true
            }
        ),
        Ok(())
    );
    assert_eq!(
        w.sim.push(&f, create(&rand_hex16(), &old, "Arsip")),
        Err(R::DepartmentArchived)
    );
    let s = w.state();
    let d = &s.divisions[&w.mobile];
    assert_eq!(
        (d.name.as_str(), d.team.as_str()),
        ("Mobile", w.it.as_str())
    );
    assert_eq!(d.created_by, w.ani.pk);

    let m = w.mobile.clone();
    assert_eq!(w.sim.push(&ani, rename(&m, "Mobile")), Err(R::NoChange));
    assert_eq!(
        w.sim.push(&budi, rename(&m, "Seluler")),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&ani, rename(&rand_hex16(), "Seluler")),
        Err(R::DivisionNotFound)
    );
    assert_eq!(w.sim.push(&ani, rename(&m, "Seluler")), Ok(()));
    assert_eq!(w.sim.push(&ani, archive(&m, false)), Err(R::NoChange));
    assert_eq!(w.sim.push(&budi, archive(&m, true)), Err(R::NotAuthorized));
    assert_eq!(w.sim.push(&ani, archive(&m, true)), Ok(()));
    assert!(w.state().divisions[&m].archived);
    assert!(w.state().divisions[&m].archived_at.is_some());
    assert_eq!(w.sim.push(&ani, archive(&m, true)), Err(R::NoChange));
    // An archived division may be renamed and restored.
    assert_eq!(w.sim.push(&ani, rename(&m, "Mobile")), Ok(()));
    assert_eq!(w.sim.push(&f, archive(&m, false)), Ok(()));
    assert!(!w.state().divisions[&m].archived);
}

#[test]
fn heads_and_members() {
    let mut w = world();
    let m = w.mobile.clone();
    let (ani, budi, citra, dedi, gita) = (
        w.ani.clone_actor(),
        w.budi.clone_actor(),
        w.citra.clone_actor(),
        w.dedi.clone_actor(),
        w.gita.clone_actor(),
    );
    // Appointing a head makes them a member too.
    assert_eq!(w.sim.push(&ani, head(&m, &budi, true)), Ok(()));
    assert_eq!(w.role(&budi), Some(DivisionRole::Head));
    assert_eq!(
        w.sim.push(&ani, head(&m, &budi, true)),
        Err(R::AlreadyDivisionHead)
    );
    assert_eq!(
        w.sim.push(&ani, head(&m, &dedi, true)),
        Err(R::TargetNotInDepartment)
    );
    assert_eq!(
        w.sim.push(&ani, head(&m, &gita, true)),
        Err(R::TargetIsGuest)
    );
    assert_eq!(
        w.sim.push(&ani, head(&m, &Actor::new(), true)),
        Err(R::TargetNotActive)
    );
    assert_eq!(
        w.sim.push(&ani, head(&m, &citra, false)),
        Err(R::NotDivisionHead)
    );
    // Heads do not appoint heads.
    assert_eq!(
        w.sim.push(&budi, head(&m, &citra, true)),
        Err(R::NotAuthorized)
    );

    // A head adds people of the department who are not guests.
    assert_eq!(w.sim.push(&budi, add(&m, &citra)), Ok(()));
    assert_eq!(w.role(&citra), Some(DivisionRole::Member));
    assert_eq!(
        w.sim.push(&budi, add(&m, &citra)),
        Err(R::AlreadyInDivision)
    );
    assert_eq!(
        w.sim.push(&budi, add(&m, &dedi)),
        Err(R::TargetNotInDepartment)
    );
    assert_eq!(w.sim.push(&budi, add(&m, &gita)), Err(R::TargetIsGuest));
    assert_eq!(
        w.sim.push(&budi, add(&rand_hex16(), &citra)),
        Err(R::DivisionNotFound)
    );
    // A plain member does not.
    assert_eq!(w.sim.push(&citra, add(&m, &ani)), Err(R::NotAuthorized));

    // A head removes members, not other heads.
    assert_eq!(w.sim.push(&budi, rm(&m, &citra)), Ok(()));
    assert_eq!(w.sim.push(&budi, rm(&m, &citra)), Err(R::NotInDivision));
    assert_eq!(w.sim.push(&ani, head(&m, &citra, true)), Ok(()));
    assert_eq!(w.sim.push(&budi, rm(&m, &citra)), Err(R::NotAuthorized));
    // Anyone may leave.
    assert_eq!(w.sim.push(&citra, rm(&m, &citra)), Ok(()));
    assert!(!w.recorded(&citra));
    // Relieving a head keeps them as a member.
    assert_eq!(w.sim.push(&ani, head(&m, &budi, false)), Ok(()));
    assert_eq!(w.role(&budi), Some(DivisionRole::Member));
    assert_eq!(w.sim.push(&ani, rm(&m, &budi)), Ok(()));
    assert_eq!(w.state().division_people(&m), Vec::new());

    // An archived division takes nobody new; people may still leave.
    assert_eq!(w.sim.push(&ani, add(&m, &budi)), Ok(()));
    assert_eq!(w.sim.push(&ani, archive(&m, true)), Ok(()));
    assert_eq!(w.sim.push(&ani, add(&m, &citra)), Err(R::DivisionArchived));
    assert_eq!(
        w.sim.push(&ani, head(&m, &citra, true)),
        Err(R::DivisionArchived)
    );
    assert_eq!(w.sim.push(&budi, rm(&m, &budi)), Ok(()));
}

#[test]
fn chat_settings() {
    let mut w = world();
    let m = w.mobile.clone();
    let (it, hr) = (w.it.clone(), w.hr.clone());
    let (f, ani, budi, citra) = (
        w.f.clone_actor(),
        w.ani.clone_actor(),
        w.budi.clone_actor(),
        w.citra.clone_actor(),
    );
    // Nothing set yet: the defaults are no change.
    assert_eq!(
        w.sim.push(&ani, chat(&it, None, "", false)),
        Err(R::NoChange)
    );
    assert_eq!(
        w.sim
            .push(&ani, chat(&it, None, "Rapat Senin\njam 9", true)),
        Ok(())
    );
    let s = w.state();
    let c = s.chat_settings_for(&it, None).unwrap();
    assert_eq!(
        (c.pinned.as_str(), c.announce),
        ("Rapat Senin\njam 9", true)
    );
    assert_eq!(c.set_by, ani.pk);
    assert_eq!(
        w.sim
            .push(&ani, chat(&it, None, "Rapat Senin\njam 9", true)),
        Err(R::NoChange)
    );
    assert_eq!(
        w.sim.push(&budi, chat(&it, None, "x1", false)),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&ani, chat(&hr, None, "x1", false)),
        Err(R::NotAuthorized)
    );
    assert_eq!(w.sim.push(&f, chat(&hr, None, "x1", false)), Ok(()));
    assert_eq!(
        w.sim.push(&f, chat(&rand_hex16(), None, "x1", false)),
        Err(R::TeamNotFound)
    );

    // Division chat: its head may set it too; only in its department.
    assert_eq!(w.sim.push(&ani, head(&m, &budi, true)), Ok(()));
    assert_eq!(w.sim.push(&budi, add(&m, &citra)), Ok(()));
    assert_eq!(
        w.sim.push(&budi, chat(&it, Some(&m), "Sprint", false)),
        Ok(())
    );
    assert_eq!(
        w.sim.push(&citra, chat(&it, Some(&m), "Saya", false)),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&f, chat(&hr, Some(&m), "Salah", false)),
        Err(R::DivisionNotFound)
    );
    assert_eq!(
        w.state().chat_settings_for(&it, Some(&m)).unwrap().pinned,
        "Sprint"
    );
    // The department channel settings are separate.
    assert!(w.state().chat_settings_for(&it, None).unwrap().announce);
    assert_eq!(w.sim.push(&ani, archive(&m, true)), Ok(()));
    assert_eq!(
        w.sim.push(&ani, chat(&it, Some(&m), "Arsip", false)),
        Err(R::DivisionArchived)
    );
    // Deleted department.
    assert_eq!(
        w.sim.push(&f, Body::TeamDelete { team: hr.clone() }),
        Ok(())
    );
    assert_eq!(
        w.sim.push(&f, chat(&hr, None, "x2", false)),
        Err(R::TeamNotFound)
    );
}

#[test]
fn department_admins_promote_and_demote_their_people() {
    let mut w = world();
    let (it, hr) = (w.it.clone(), w.hr.clone());
    let (f, ani, budi, citra, dedi, gita) = (
        w.f.clone_actor(),
        w.ani.clone_actor(),
        w.budi.clone_actor(),
        w.citra.clone_actor(),
        w.dedi.clone_actor(),
        w.gita.clone_actor(),
    );
    assert_eq!(w.sim.push(&ani, admin_set(&it, &budi)), Ok(()));
    assert_eq!(
        w.sim.push(&ani, admin_set(&it, &budi)),
        Err(R::AlreadyTeamAdmin)
    );
    // Nobody from another department or without one.
    assert_eq!(
        w.sim.push(&ani, admin_set(&it, &dedi)),
        Err(R::TargetNotInDepartment)
    );
    let loner = w.sim.join(&it, InviteRole::Member, "Eko");
    assert_eq!(
        w.sim.push(
            &f,
            Body::TeamMemberRemove {
                team: it.clone(),
                member: loner.pk.clone()
            }
        ),
        Ok(())
    );
    assert_eq!(
        w.sim.push(&ani, admin_set(&it, &loner)),
        Err(R::TargetNotInDepartment)
    );
    assert_eq!(
        w.sim.push(&ani, admin_set(&it, &gita)),
        Err(R::TargetIsGuest)
    );
    // Not in another department, not by a plain member.
    assert_eq!(
        w.sim.push(&ani, admin_set(&hr, &dedi)),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&citra, admin_set(&it, &citra)),
        Err(R::NotAuthorized)
    );
    // A superadmin still pulls people without a department in.
    assert_eq!(w.sim.push(&f, admin_set(&it, &loner)), Ok(()));
    assert_eq!(w.sim.push(&ani, admin_unset(&it, &loner)), Ok(()));

    // Demoting: another admin freely, oneself unless the last one.
    assert_eq!(w.sim.push(&ani, admin_unset(&it, &budi)), Ok(()));
    assert_eq!(
        w.sim.push(&ani, admin_unset(&it, &citra)),
        Err(R::NotTeamAdmin)
    );
    assert_eq!(
        w.sim.push(&ani, admin_unset(&it, &ani)),
        Err(R::LastTeamAdmin)
    );
    assert_eq!(w.sim.push(&ani, admin_set(&it, &budi)), Ok(()));
    assert_eq!(w.sim.push(&ani, admin_unset(&it, &ani)), Ok(()));
    assert_eq!(w.state().team_admin_count(&it), 1);
    assert_eq!(
        w.sim.push(&budi, admin_unset(&it, &budi)),
        Err(R::LastTeamAdmin)
    );
    // Ani is no longer an admin.
    assert_eq!(
        w.sim.push(&ani, admin_set(&it, &citra)),
        Err(R::NotAuthorized)
    );
    // A superadmin may remove the last admin.
    assert_eq!(w.sim.push(&f, admin_unset(&it, &budi)), Ok(()));
    assert_eq!(w.state().team_admin_count(&it), 0);
}

#[test]
fn leaving_a_department_leaves_its_divisions() {
    let mut w = world();
    let m = w.mobile.clone();
    let (it, hr) = (w.it.clone(), w.hr.clone());
    let (f, ani, budi, citra) = (
        w.f.clone_actor(),
        w.ani.clone_actor(),
        w.budi.clone_actor(),
        w.citra.clone_actor(),
    );
    for who in [&ani, &budi, &citra] {
        assert_eq!(w.sim.push(&ani, add(&m, who)), Ok(()));
    }
    assert_eq!(w.sim.push(&ani, head(&m, &budi, true)), Ok(()));
    let web = rand_hex16();
    assert_eq!(w.sim.push(&ani, create(&web, &it, "Web")), Ok(()));
    assert_eq!(w.sim.push(&ani, add(&web, &citra)), Ok(()));
    assert_eq!(w.state().divisions_of(&citra.pk).len(), 2);

    // team_move: out of every division outside the new department.
    assert_eq!(w.sim.push(&f, team_move(&hr, &citra)), Ok(()));
    assert!(!w.recorded(&citra));
    assert!(w.state().divisions_of(&citra.pk).is_empty());
    // Moving back does not restore anything.
    assert_eq!(w.sim.push(&f, team_move(&it, &citra)), Ok(()));
    assert!(w.state().divisions_of(&citra.pk).is_empty());

    // team_member_remove: out of that department's divisions.
    assert_eq!(
        w.sim.push(
            &f,
            Body::TeamMemberRemove {
                team: it.clone(),
                member: budi.pk.clone()
            }
        ),
        Ok(())
    );
    assert!(!w.recorded(&budi));

    // member_remove: out of every division.
    assert_eq!(
        w.sim.push(
            &f,
            Body::MemberRemove {
                member: ani.pk.clone()
            }
        ),
        Ok(())
    );
    assert!(!w.recorded(&ani));

    // team_delete: its divisions are deleted and emptied.
    assert_eq!(w.sim.push(&f, add(&m, &citra)), Ok(()));
    assert_eq!(
        w.sim.push(&f, Body::TeamDelete { team: it.clone() }),
        Ok(())
    );
    let s = w.state();
    assert!(s.divisions[&m].deleted && s.divisions[&web].deleted);
    assert!(s.divisions[&m].members.is_empty());
    assert!(s.live_division(&m).is_none());
    assert_eq!(w.sim.push(&f, rename(&m, "Baru")), Err(R::DivisionNotFound));
    assert_eq!(w.sim.push(&f, add(&m, &citra)), Err(R::DivisionNotFound));
}

#[test]
fn leave_divisions_keeps_the_named_department() {
    let mut w = world();
    let m = w.mobile.clone();
    let (ani, citra) = (w.ani.clone_actor(), w.citra.clone_actor());
    assert_eq!(w.sim.push(&ani, add(&m, &citra)), Ok(()));
    let mut s = w.state();
    s.leave_divisions(&citra.pk, Some(&w.it));
    assert!(s.divisions[&m].members.contains_key(&citra.pk));
    s.leave_divisions(&citra.pk, None);
    assert!(!s.divisions[&m].members.contains_key(&citra.pk));
}

#[test]
fn projects_made_for_a_division() {
    let mut w = world();
    let m = w.mobile.clone();
    let (it, hr) = (w.it.clone(), w.hr.clone());
    let (f, ani, budi, citra, dedi) = (
        w.f.clone_actor(),
        w.ani.clone_actor(),
        w.budi.clone_actor(),
        w.citra.clone_actor(),
        w.dedi.clone_actor(),
    );
    // A plain member of the division may not, like department projects.
    assert_eq!(w.sim.push(&ani, add(&m, &budi)), Ok(()));
    assert_eq!(
        w.sim.push(&budi, project(&budi, &it, Some(&m))),
        Err(R::NotAuthorized)
    );
    // Its head may.
    assert_eq!(w.sim.push(&ani, head(&m, &budi, true)), Ok(()));
    let body = project(&budi, &it, Some(&m));
    let Body::ProjectCreate { project: id, .. } = &body else {
        unreachable!()
    };
    let id = id.clone();
    assert_eq!(w.sim.push(&budi, body), Ok(()));
    assert_eq!(
        w.state().projects[&id].division.as_deref(),
        Some(m.as_str())
    );
    // In the division's department only.
    assert_eq!(
        w.sim.push(&dedi, project(&dedi, &hr, Some(&m))),
        Err(R::DivisionNotFound)
    );
    assert_eq!(
        w.sim.push(&budi, project(&budi, &it, Some(&rand_hex16()))),
        Err(R::DivisionNotFound)
    );
    // Someone outside the division who does not manage it may not.
    assert_eq!(
        w.sim.push(&citra, project(&citra, &it, Some(&m))),
        Err(R::NotAuthorized)
    );
    assert_eq!(w.sim.push(&ani, project(&ani, &it, Some(&m))), Ok(()));
    assert_eq!(w.sim.push(&f, project(&f, &it, Some(&m))), Ok(()));
    // A project without division is unchanged.
    assert_eq!(w.sim.push(&citra, project(&citra, &it, None)), Ok(()));
    assert_eq!(w.sim.push(&ani, archive(&m, true)), Ok(()));
    assert_eq!(
        w.sim.push(&budi, project(&budi, &it, Some(&m))),
        Err(R::DivisionArchived)
    );
}

#[test]
fn ou_rows_keep_only_divisions_of_their_department() {
    let mut w = world();
    let m = w.mobile.clone();
    let (it, hr) = (w.it.clone(), w.hr.clone());
    let f = w.f.clone_actor();
    let gone = rand_hex16();
    let row = |ou: &str, team: &str, division: Option<&str>| OuMapping {
        ou: ou.into(),
        team: team.into(),
        division: division.map(str::to_owned),
    };
    let body = Body::AdSettingsSet {
        domain: "biro.co.id".into(),
        ou_map: vec![
            row("Mobile", &it, Some(&m)),
            row("Personalia", &hr, Some(&m)),
            row("Lain", &it, Some(&gone)),
            row("Umum", &it, None),
        ],
    };
    assert_eq!(w.sim.push(&f, body), Ok(()));
    assert_eq!(
        w.state().ad.ou_map,
        [
            row("Mobile", &it, Some(&m)),
            row("Personalia", &hr, None),
            row("Lain", &it, None),
            row("Umum", &it, None),
        ]
    );
}

// ----- Concurrency ---------------------------------------------------------------------------

/// The world with Budi as head of Mobile and the founder's profile op, so
/// ops made at the current lamport sort after everything.
fn with_head() -> W {
    let mut w = world();
    let (ani, budi) = (w.ani.clone_actor(), w.budi.clone_actor());
    let m = w.mobile.clone();
    assert_eq!(w.sim.push(&ani, head(&m, &budi, true)), Ok(()));
    let f = w.f.clone_actor();
    assert_eq!(
        w.sim.push(
            &f,
            Body::ProfileSet {
                name: "Sari".into()
            }
        ),
        Ok(())
    );
    w
}

#[test]
fn a_head_losing_the_right_cannot_add_concurrently() {
    let base = with_head();
    let m = base.mobile.clone();
    type Revoke = fn(&W) -> (Actor, Body);
    let revocations: [(&str, Revoke); 5] = [
        ("relieved", |w| {
            (w.ani.clone_actor(), head(&w.mobile, &w.budi, false))
        }),
        ("removed from the division", |w| {
            (w.ani.clone_actor(), rm(&w.mobile, &w.budi))
        }),
        ("division archived", |w| {
            (w.ani.clone_actor(), archive(&w.mobile, true))
        }),
        ("moved to another department", |w| {
            (w.f.clone_actor(), team_move(&w.hr, &w.budi))
        }),
        ("removed from the department", |w| {
            (
                w.f.clone_actor(),
                Body::TeamMemberRemove {
                    team: w.it.clone(),
                    member: w.budi.pk.clone(),
                },
            )
        }),
    ];
    for (name, revoke) in revocations {
        for (la, lr) in [(1, 1), (1, 3), (3, 1)] {
            let mut sim = clone_sim(&base.sim);
            let deps = sim.heads_below(sim.lamport + 1);
            let (by, body) = revoke(&base);
            let r = sim.make_with_deps(&by, sim.lamport + lr, deps.clone(), body);
            let a = sim.make_with_deps(&base.budi, sim.lamport + la, deps, add(&m, &base.citra));
            let _ = sim.add(r.clone());
            let _ = sim.add(a.clone());
            assert_eq!(sim.outcome(&r.id), Ok(()), "{name} {la} {lr}");
            let got = sim.outcome(&a.id);
            if a.order_key() < r.order_key() {
                assert_eq!(got, Err(R::ConcurrentWithRevocation), "{name} {la} {lr}");
            } else {
                assert!(got.is_err(), "{name} {la} {lr}");
            }
            assert!(
                !sim.state().divisions[&m]
                    .members
                    .contains_key(&base.citra.pk),
                "{name} {la} {lr}"
            );
            assert_order_free(&sim);
        }
    }
}

#[test]
fn a_head_relieved_after_adding_keeps_the_member() {
    // Sequential: the relieving admin had seen the add.
    let mut w = with_head();
    let m = w.mobile.clone();
    let (ani, budi, citra) = (
        w.ani.clone_actor(),
        w.budi.clone_actor(),
        w.citra.clone_actor(),
    );
    assert_eq!(w.sim.push(&budi, add(&m, &citra)), Ok(()));
    assert_eq!(w.sim.push(&ani, head(&m, &budi, false)), Ok(()));
    assert_eq!(w.role(&citra), Some(DivisionRole::Member));
}

#[test]
fn moved_while_being_added_ends_outside_the_division() {
    let base = with_head();
    let m = base.mobile.clone();
    for (la, lm) in [(1, 1), (1, 3), (3, 1)] {
        let mut sim = clone_sim(&base.sim);
        let deps = sim.heads_below(sim.lamport + 1);
        let mv = sim.make_with_deps(
            &base.f,
            sim.lamport + lm,
            deps.clone(),
            team_move(&base.hr, &base.citra),
        );
        let a = sim.make_with_deps(&base.ani, sim.lamport + la, deps, add(&m, &base.citra));
        let _ = sim.add(a.clone());
        let _ = sim.add(mv.clone());
        assert_eq!(sim.outcome(&mv.id), Ok(()));
        let added = sim.outcome(&a.id);
        if a.order_key() < mv.order_key() {
            assert_eq!(added, Ok(()), "{la} {lm}");
        } else {
            assert_eq!(added, Err(R::TargetNotInDepartment), "{la} {lm}");
        }
        let s = sim.state();
        assert!(!s.divisions[&m].members.contains_key(&base.citra.pk));
        assert_eq!(s.department_of(&base.citra.pk).unwrap().0.id, base.hr);
        assert_order_free(&sim);
    }
}

#[test]
fn department_admins_demoting_each_other_leave_one_admin() {
    let mut base = world();
    let it = base.it.clone();
    let (ani, budi) = (base.ani.clone_actor(), base.budi.clone_actor());
    assert_eq!(base.sim.push(&ani, admin_set(&it, &budi)), Ok(()));
    let f = base.f.clone_actor();
    assert_eq!(
        base.sim.push(
            &f,
            Body::ProfileSet {
                name: "Sari".into()
            }
        ),
        Ok(())
    );
    for (la, lb) in [(1, 1), (1, 3), (3, 1)] {
        let mut sim = clone_sim(&base.sim);
        let deps = sim.heads_below(sim.lamport + 1);
        let by_a = sim.make_with_deps(
            &ani,
            sim.lamport + la,
            deps.clone(),
            admin_unset(&it, &budi),
        );
        let by_b = sim.make_with_deps(&budi, sim.lamport + lb, deps, admin_unset(&it, &ani));
        let _ = sim.add(by_a.clone());
        let _ = sim.add(by_b.clone());
        // Only the senior admin (Ani, appointed first) may demote the other,
        // whatever lamports they picked.
        assert_eq!(sim.outcome(&by_a.id), Ok(()), "{la} {lb}");
        // Sorting before Ani's demotion, Budi's op is caught by the causal
        // rule first; after it, by the seniority rule.
        let expected = if by_b.order_key() < by_a.order_key() {
            R::ConcurrentWithRevocation
        } else {
            R::NotAuthorized
        };
        assert_eq!(sim.outcome(&by_b.id), Err(expected), "{la} {lb}");
        let s = sim.state();
        assert_eq!(s.team_admin_count(&it), 1, "{la} {lb}");
        assert!(s.is_team_manager(&ani.pk, &it));
        assert_order_free(&sim);
        // The same whichever laptop got which op first.
        for _ in 0..3 {
            let r = fold(&sim.org, &shuffled(&sim.ops));
            assert_eq!(r.state, s);
        }
    }
}

#[test]
fn shuffled_division_logs_fold_the_same() {
    let mut w = with_head();
    let m = w.mobile.clone();
    let it = w.it.clone();
    let (f, ani, budi, citra) = (
        w.f.clone_actor(),
        w.ani.clone_actor(),
        w.budi.clone_actor(),
        w.citra.clone_actor(),
    );
    let web = rand_hex16();
    let _ = w.sim.push(&budi, add(&m, &citra));
    let _ = w.sim.push(&ani, create(&web, &it, "Web"));
    let _ = w.sim.push(&ani, head(&web, &citra, true));
    let _ = w.sim.push(&citra, chat(&it, Some(&web), "Halo tim", true));
    let _ = w.sim.push(&ani, admin_set(&it, &budi));
    let _ = w.sim.push(&budi, rename(&web, "Web App"));
    let _ = w.sim.push(&f, team_move(&w.hr.clone(), &citra));
    let _ = w.sim.push(&ani, project(&ani, &it, Some(&m)));
    let _ = w.sim.push(&budi, archive(&m, true));
    // Two concurrent ops at the end.
    let deps = w.sim.heads_below(w.sim.lamport + 1);
    let l = w.sim.lamport;
    let x = w
        .sim
        .make_with_deps(&ani, l + 1, deps.clone(), admin_unset(&it, &budi));
    let y = w.sim.make_with_deps(&budi, l + 1, deps, archive(&m, false));
    w.sim.add(x).ok();
    w.sim.add(y).ok();
    let base = fold(&w.sim.org, &w.sim.ops);
    for _ in 0..8 {
        let r = fold(&w.sim.org, &shuffled(&w.sim.ops));
        assert_eq!(r.state, base.state);
        assert_eq!(r.outcomes, base.outcomes);
    }
}

// ----- Version gate and authoring on a laptop ------------------------------------------------

fn gate_msg(err: AppError) {
    assert!(
        matches!(&err, AppError::InvalidInput(m) if m == p::DIVISION_GATE_CLOSED),
        "{err:?}"
    );
}

#[test]
fn division_changes_wait_for_every_laptop() {
    let mut o = office();
    // Nobody reported a version: closed, everyone listed.
    assert!(!p::division_gate_open(&o.andi.state()));
    assert_eq!(p::division_blockers(&o.andi.state()).len(), 3);
    gate_msg(
        p::create_division(&mut o.andi.conn, &o.andi.id, &o.desain, "Cetak", now()).unwrap_err(),
    );

    all_on(&mut o, crate::device::APP_VERSION);
    assert!(p::division_blockers(&o.andi.state()).is_empty());
    let cetak =
        p::create_division(&mut o.andi.conn, &o.andi.id, &o.desain, " Cetak ", now()).unwrap();
    assert_eq!(o.andi.state().divisions[&cetak].name, "Cetak");

    // Dimas falls back to an older Mira: the gate closes again.
    o.dimas.report_version("0.4.0");
    o.dimas.sync_to(&mut o.andi);
    o.andi.sync_to(&mut o.rina);
    let blockers = p::division_blockers(&o.andi.state());
    assert_eq!(blockers.len(), 1);
    assert_eq!(blockers[0].member, o.dimas.pk());
    assert_eq!(blockers[0].app_version.as_deref(), Some("0.4.0"));
    let dimas = o.dimas.pk();
    gate_msg(
        p::add_division_member(&mut o.andi.conn, &o.andi.id, &cetak, &dimas, now()).unwrap_err(),
    );
    gate_msg(
        p::set_chat_settings(
            &mut o.andi.conn,
            &o.andi.id,
            &o.desain,
            None,
            "Halo",
            false,
            now(),
        )
        .unwrap_err(),
    );
    gate_msg(
        p::set_dept_admin(&mut o.rina.conn, &o.rina.id, &o.desain, &dimas, true, now())
            .unwrap_err(),
    );
    // A superadmin promotes whatever the gate (older Mira folds that).
    p::set_dept_admin(&mut o.andi.conn, &o.andi.id, &o.desain, &dimas, true, now()).unwrap();
    assert!(o.andi.state().is_team_manager(&dimas, &o.desain));
}

#[test]
fn threshold_follows_the_min_rule() {
    let own = p::join::parse_app_version(crate::device::APP_VERSION).unwrap();
    let since = p::join::parse_app_version(p::DIVISION_SINCE).unwrap();
    assert_eq!(since, (0, 6, 0));
    assert_eq!(p::division_threshold(), own.min(since));
}

#[test]
fn authoring_checks_input_and_writes_the_derived_tables() {
    let mut o = office();
    all_on(&mut o, crate::device::APP_VERSION);
    let (rina, dimas) = (o.rina.pk(), o.dimas.pk());
    let desain = o.desain.clone();

    // Input errors in Indonesian.
    let err = p::create_division(&mut o.andi.conn, &o.andi.id, &desain, "X", now()).unwrap_err();
    assert!(matches!(err, AppError::InvalidName(_)), "{err:?}");
    let err = p::create_division(&mut o.andi.conn, &o.andi.id, "abc", "Cetak", now()).unwrap_err();
    assert!(matches!(err, AppError::NotFound(_)), "{err:?}");
    let err = p::rename_division(
        &mut o.andi.conn,
        &o.andi.id,
        &"12".repeat(16),
        "Cetak",
        now(),
    )
    .unwrap_err();
    assert_eq!(err.to_string(), R::DivisionNotFound.message());
    assert_eq!(
        p::clean_pinned_note("  Rapat\r\nSenin\r ").unwrap(),
        "Rapat\nSenin"
    );
    assert!(matches!(
        p::clean_pinned_note(&"x".repeat(501)),
        Err(AppError::InvalidInput(m)) if m == "Catatan disematkan paling banyak 500 karakter."
    ));
    assert!(matches!(
        p::clean_pinned_note("a\tb"),
        Err(AppError::InvalidInput(_))
    ));

    // Rina (admin of Desain) builds a division with Dimas as head.
    o.andi.sync_to(&mut o.rina);
    let cetak = p::create_division(&mut o.rina.conn, &o.rina.id, &desain, "Cetak", now()).unwrap();
    p::set_division_head(&mut o.rina.conn, &o.rina.id, &cetak, &dimas, true, now()).unwrap();
    p::add_division_member(&mut o.rina.conn, &o.rina.id, &cetak, &rina, now()).unwrap();
    p::set_chat_settings(
        &mut o.rina.conn,
        &o.rina.id,
        &desain,
        Some(&cetak),
        "Deadline Jumat\r\n",
        true,
        now(),
    )
    .unwrap();
    // Saving the same again writes nothing.
    let before = p::load_ops(&o.rina.conn).unwrap().len();
    p::set_chat_settings(
        &mut o.rina.conn,
        &o.rina.id,
        &desain,
        Some(&cetak),
        "Deadline Jumat",
        true,
        now(),
    )
    .unwrap();
    assert_eq!(p::load_ops(&o.rina.conn).unwrap().len(), before);
    // A refusal from the fold comes back as forbidden.
    let err = p::rename_division(&mut o.rina.conn, &o.rina.id, &cetak, "Cetak", now()).unwrap_err();
    assert!(matches!(err, AppError::Forbidden(_)), "{err:?}");

    // A project for the division, registered by Rina.
    let nonce = rand_hex16();
    let project = project_id_for(&rina, Some(&desain), &nonce);
    p::author_op(
        &mut o.rina.conn,
        &o.rina.id,
        Scope::Org,
        Body::ProjectCreate {
            project: project.clone(),
            team: Some(desain.clone()),
            creator: rina.clone(),
            nonce,
            members: vec![dimas.clone()],
            division: Some(cetak.clone()),
        },
        now(),
    )
    .unwrap();

    let conn = &o.rina.conn;
    let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
    assert_eq!(count("SELECT COUNT(*) FROM divisions"), 1);
    assert_eq!(count("SELECT COUNT(*) FROM division_members"), 2);
    assert_eq!(
        count("SELECT COUNT(*) FROM division_members WHERE head = 1"),
        1
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM chat_settings WHERE announce = 1"),
        1
    );
    let (pinned, division_id): (String, String) = conn
        .query_row("SELECT pinned, division_id FROM chat_settings", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(
        (pinned.as_str(), division_id.as_str()),
        ("Deadline Jumat", cetak.as_str())
    );
    let on_project: Option<String> = conn
        .query_row(
            "SELECT division_id FROM projects WHERE id = ?1",
            [&project],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(on_project.as_deref(), Some(cetak.as_str()));

    // The other laptops fold the same.
    o.rina.sync_to(&mut o.andi);
    assert_eq!(o.andi.state().divisions, o.rina.state().divisions);
    assert_eq!(o.andi.state().chat_settings, o.rina.state().chat_settings);

    // Dimas, as head, removes Rina (not a head).
    o.andi.sync_to(&mut o.dimas);
    p::remove_division_member(&mut o.dimas.conn, &o.dimas.id, &cetak, &rina, now()).unwrap();
    assert_eq!(o.dimas.state().division_role(&cetak, &rina), None);
}

#[test]
fn department_overview_and_settings_read_models() {
    let mut o = office();
    all_on(&mut o, crate::device::APP_VERSION);
    let (andi, rina, dimas) = (o.andi.pk(), o.rina.pk(), o.dimas.pk());
    let desain = o.desain.clone();
    o.andi.sync_to(&mut o.rina);
    let cetak = p::create_division(&mut o.rina.conn, &o.rina.id, &desain, "Cetak", now()).unwrap();
    let web =
        p::create_division(&mut o.rina.conn, &o.rina.id, &desain, "Arsip Web", now()).unwrap();
    p::set_division_archived(&mut o.rina.conn, &o.rina.id, &web, true, now()).unwrap();
    p::set_division_head(&mut o.rina.conn, &o.rina.id, &cetak, &dimas, true, now()).unwrap();
    p::set_dept_admin(&mut o.rina.conn, &o.rina.id, &desain, &dimas, true, now()).unwrap();
    p::set_dept_admin(&mut o.rina.conn, &o.rina.id, &desain, &dimas, false, now()).unwrap();
    p::set_chat_settings(
        &mut o.rina.conn,
        &o.rina.id,
        &desain,
        None,
        "Selamat datang",
        true,
        now(),
    )
    .unwrap();
    o.rina.sync_to(&mut o.andi);
    o.andi.sync_to(&mut o.dimas);

    let never = |_: &str| false;
    // Rina (admin) sees her department.
    let state = o.rina.state();
    let ov = p::dept_overview(&o.rina.conn, &state, &rina, None, &never)
        .unwrap()
        .unwrap();
    assert_eq!(ov.team_id, desain);
    assert!(ov.can_manage_dept && ov.me.is_admin && !ov.me.is_superadmin);
    assert_eq!(ov.choices.len(), 1);
    assert_eq!(ov.members.len(), 2);
    let me = ov.members.iter().find(|m| m.public_key == rina).unwrap();
    assert!(me.is_me && me.online && me.is_admin);
    let d = ov.members.iter().find(|m| m.public_key == dimas).unwrap();
    assert!(!d.online && !d.is_admin);
    assert_eq!(d.divisions.len(), 1);
    assert_eq!(d.divisions[0].role, DivisionRole::Head);
    assert_eq!(d.app_version.as_deref(), Some(crate::device::APP_VERSION));
    // Archived divisions last.
    let names: Vec<&str> = ov.divisions.iter().map(|d| d.name.as_str()).collect();
    assert_eq!(names, ["Cetak", "Arsip Web"]);
    assert_eq!(ov.divisions[0].conv, format!("ch:{cetak}"));
    assert!(ov.divisions[0].can_manage && ov.divisions[0].can_edit_members);
    assert_eq!(ov.divisions[0].members[0].role, DivisionRole::Head);
    assert!(ov.channel.conv.starts_with("ch:"));
    assert_eq!(ov.channel.name, "desain");
    assert!(ov.channel.settings.announce);
    assert_eq!(ov.channel.settings.set_by_name.as_deref(), Some("Rina"));
    // Newest first: demoted, then promoted, then Rina's admission is not
    // a team_admin op.
    let history: Vec<(bool, &str)> = ov
        .admin_history
        .iter()
        .map(|e| (e.admin, e.status.as_str()))
        .collect();
    assert_eq!(history, [(false, "applied"), (true, "applied")]);
    assert_eq!(ov.admin_history[0].by_name, "Rina");
    assert_eq!(ov.admin_history[0].target_name, "Dimas");
    assert!(ov.gate.open && ov.gate.blockers.is_empty());
    assert_eq!(ov.gate.since, p::DIVISION_SINCE);
    let json = serde_json::to_value(&ov).unwrap();
    for key in [
        "teamId",
        "teamName",
        "archived",
        "choices",
        "me",
        "canManageDept",
        "members",
        "divisions",
        "projects",
        "channel",
        "adminHistory",
        "gate",
    ] {
        assert!(json.get(key).is_some(), "{key}");
    }
    assert_eq!(json["me"]["headOf"], serde_json::json!([]));
    assert_eq!(json["divisions"][0]["members"][0]["role"], "head");
    assert!(json["divisions"][0]["canEditMembers"].as_bool().unwrap());
    assert!(json["channel"]["settings"]["setAt"].is_string());
    assert!(json["members"][0].get("appVersion").is_some());

    // Dimas (head, not admin) sees it without managing it.
    let state = o.dimas.state();
    let ov = p::dept_overview(&o.dimas.conn, &state, &dimas, None, &never)
        .unwrap()
        .unwrap();
    assert!(!ov.can_manage_dept);
    assert_eq!(ov.me.head_of, std::slice::from_ref(&cetak));
    assert!(!ov.divisions[0].can_manage && ov.divisions[0].can_edit_members);
    assert!(!ov.divisions[1].can_edit_members);
    // Andi (superadmin) opens his own department by default, any by id.
    let state = o.andi.state();
    let ov = p::dept_overview(&o.andi.conn, &state, &andi, None, &never)
        .unwrap()
        .unwrap();
    assert_eq!(ov.team_id, o.admin);
    assert_eq!(ov.choices.len(), 2);
    assert!(
        p::dept_overview(&o.andi.conn, &state, &andi, Some(&desain), &never)
            .unwrap()
            .is_some()
    );
    // Rina may not open Administrasi; unknown ids give nothing.
    let state = o.rina.state();
    assert!(
        p::dept_overview(&o.rina.conn, &state, &rina, Some(&o.admin), &never)
            .unwrap()
            .is_none()
    );

    // my_divisions and conversation settings.
    let mine = p::my_divisions(&o.dimas.state(), &dimas);
    assert_eq!(mine.len(), 1);
    assert_eq!(
        (mine[0].id.as_str(), mine[0].team_name.as_str()),
        (cetak.as_str(), "Desain")
    );
    assert_eq!(p::my_divisions(&o.rina.state(), &rina).len(), 2);
    let s = o.dimas.state();
    let ch = p::conversation_settings_for(&s, &dimas, &desain, None);
    assert!(ch.announce && !ch.can_write && !ch.can_edit);
    assert_eq!(ch.pinned, "Selamat datang");
    let ch = p::conversation_settings_for(&s, &rina, &desain, None);
    assert!(ch.can_write && ch.can_edit);
    let div = p::conversation_settings_for(&s, &dimas, &desain, Some(&cetak));
    assert!(div.can_write && div.can_edit && !div.announce);
    assert_eq!(div.division_id.as_deref(), Some(cetak.as_str()));
    let archived = p::conversation_settings_for(&s, &rina, &desain, Some(&web));
    assert!(!archived.can_write && !archived.can_edit);
    let json = serde_json::to_value(&div).unwrap();
    for key in [
        "pinned",
        "announce",
        "canWrite",
        "canEdit",
        "teamId",
        "divisionId",
    ] {
        assert!(json.get(key).is_some(), "{key}");
    }
}

// ----- Security review fixes (commit 8836c9a) ---------------------------------------------

#[test]
fn a_demoted_junior_admin_cannot_backdate_a_counter_demotion() {
    let mut w = world();
    let it = w.it.clone();
    let (f, ani, budi, citra) = (
        w.f.clone_actor(),
        w.ani.clone_actor(),
        w.budi.clone_actor(),
        w.citra.clone_actor(),
    );
    // Ani (admin by invite) appoints Budi: Ani is senior.
    assert_eq!(w.sim.push(&ani, admin_set(&it, &budi)), Ok(()));
    let p_set = w.sim.state().teams[&it].members[&budi.pk].appointed.clone();
    assert!(p_set.is_some());
    assert!(
        w.sim.state().teams[&it].members[&ani.pk].appointed < p_set,
        "the invite accept appointed Ani first"
    );
    // A junior admin may not demote a senior one, even sequentially.
    assert_eq!(
        w.sim.push(&budi, admin_unset(&it, &ani)),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(
            &f,
            Body::ProfileSet {
                name: "Sari".into()
            }
        ),
        Ok(())
    );

    let seen = w.sim.lamport;
    let old_deps = w.sim.heads_below(seen + 1);
    assert_eq!(w.sim.push(&ani, admin_unset(&it, &budi)), Ok(()));
    // Budi signs a demotion of Ani that sorts before his own demotion and
    // claims not to have seen it, then one forward-dated.
    let back = w
        .sim
        .make_with_deps(&budi, seen, w.sim.heads_below(seen), admin_unset(&it, &ani));
    let fwd = w
        .sim
        .make_with_deps(&budi, seen + 5, old_deps, admin_unset(&it, &ani));
    assert!(back.order_key() < fwd.order_key());
    assert!(w.sim.add(back).is_err());
    assert!(w.sim.add(fwd).is_err());
    let s = w.state();
    assert_eq!(s.team_role(&it, &ani.pk), Some(p::TeamRole::Admin));
    assert_eq!(s.team_role(&it, &budi.pk), Some(p::TeamRole::Member));
    assert_order_free(&w.sim);

    // A superadmin's appointment later than Ani's is junior to her too, and
    // re-appointing Budi makes him junior again.
    assert_eq!(w.sim.push(&f, admin_set(&it, &citra)), Ok(()));
    assert_eq!(
        w.sim.push(&citra, admin_unset(&it, &ani)),
        Err(R::NotAuthorized)
    );
    assert_eq!(w.sim.push(&ani, admin_set(&it, &budi)), Ok(()));
    assert_eq!(w.sim.push(&citra, admin_unset(&it, &budi)), Ok(()));
    // The superadmin rule is unchanged.
    assert_eq!(w.sim.push(&f, admin_unset(&it, &ani)), Ok(()));
}

#[test]
fn division_ids_do_not_depend_on_department_channels() {
    let base = world();
    let it = base.it.clone();
    let (ani, budi) = (base.ani.clone_actor(), base.budi.clone_actor());
    let id = rand_hex16();
    let channel = Body::ChannelCreate {
        channel: id.clone(),
        team: it.clone(),
        name: "rahasia".into(),
    };
    // Both orders: the channel (team scope, unknown outside IT) first, or
    // the division first.
    for channel_first in [true, false] {
        let mut sim = clone_sim(&base.sim);
        let l = sim.lamport;
        let (lc, ld) = if channel_first {
            (l + 1, l + 2)
        } else {
            (l + 2, l + 1)
        };
        let deps = sim.heads_below(l + 1);
        let ch = sim.make_with_deps(&budi, lc, deps.clone(), channel.clone());
        let div = sim.make_with_deps(&ani, ld, deps, create(&id, &it, "Mobile 2"));
        sim.ops.push(ch.clone());
        sim.ops.push(div.clone());
        let inside = fold(&sim.org, &sim.ops);
        let outside_ops: Vec<VerifiedOp> =
            sim.ops.iter().filter(|o| o.id != ch.id).cloned().collect();
        let outside = fold(&sim.org, &outside_ops);
        assert_eq!(
            inside.state.divisions, outside.state.divisions,
            "{channel_first}"
        );
        assert!(inside.state.live_division(&id).is_some(), "{channel_first}");
        let channel_outcome = inside
            .outcomes
            .iter()
            .find(|(i, _)| *i == ch.id)
            .map(|(_, o)| *o)
            .unwrap();
        if channel_first {
            assert_eq!(channel_outcome, Ok(()));
        } else {
            assert_eq!(channel_outcome, Err(R::IdInUse));
        }
    }
    // Org-scope ids stay taken: a team, a label, another division.
    let mut w = world();
    let ani = w.ani.clone_actor();
    let it = w.it.clone();
    let m = w.mobile.clone();
    assert_eq!(w.sim.push(&ani, create(&it, &it, "Sama")), Err(R::IdInUse));
    assert_eq!(w.sim.push(&ani, create(&m, &it, "Sama")), Err(R::IdInUse));
    let umum = p::umum_channel_id(&w.sim.org.id);
    assert_eq!(
        w.sim.push(&ani, create(&umum, &it, "Sama")),
        Err(R::IdInUse)
    );
}

#[test]
fn old_set_team_admin_command_waits_for_the_gate() {
    let mut o = office();
    let dimas = o.dimas.pk();
    // Nobody reported a version: a department admin is refused.
    gate_msg(
        p::set_team_admin(&mut o.rina.conn, &o.rina.id, &o.desain, &dimas, true, now())
            .unwrap_err(),
    );
    // A superadmin is not.
    p::set_team_admin(&mut o.andi.conn, &o.andi.id, &o.desain, &dimas, true, now()).unwrap();
    assert!(o.andi.state().is_team_manager(&dimas, &o.desain));
    all_on(&mut o, crate::device::APP_VERSION);
    p::set_team_admin(
        &mut o.rina.conn,
        &o.rina.id,
        &o.desain,
        &dimas,
        false,
        now(),
    )
    .unwrap();
    assert!(!o.rina.state().is_team_manager(&dimas, &o.desain));
}

#[test]
fn archived_divisions_and_departments_take_no_changes_from_heads() {
    let mut w = with_head();
    let m = w.mobile.clone();
    let (f, ani, budi, citra) = (
        w.f.clone_actor(),
        w.ani.clone_actor(),
        w.budi.clone_actor(),
        w.citra.clone_actor(),
    );
    let dedi_like = w.sim.join(&w.it.clone(), InviteRole::Member, "Eko");
    assert_eq!(w.sim.push(&budi, add(&m, &citra)), Ok(()));
    assert_eq!(w.sim.push(&budi, add(&m, &dedi_like)), Ok(()));
    assert_eq!(w.sim.push(&ani, archive(&m, true)), Ok(()));
    // The head may no longer remove anyone; a manager may, people may leave.
    assert_eq!(w.sim.push(&budi, rm(&m, &citra)), Err(R::DivisionArchived));
    assert_eq!(w.sim.push(&ani, rm(&m, &citra)), Ok(()));
    assert_eq!(w.sim.push(&dedi_like, rm(&m, &dedi_like)), Ok(()));
    assert_eq!(w.sim.push(&budi, add(&m, &citra)), Err(R::DivisionArchived));
    assert_eq!(
        w.sim
            .push(&budi, chat(&w.it.clone(), Some(&m), "Arsip", false)),
        Err(R::DivisionArchived)
    );
    // Managers still rename and restore.
    assert_eq!(w.sim.push(&ani, rename(&m, "Mobile Lama")), Ok(()));
    assert_eq!(w.sim.push(&ani, archive(&m, false)), Ok(()));

    // An archived department: no members, head or chat settings.
    let old = w.sim.team("Lama");
    let d = rand_hex16();
    assert_eq!(w.sim.push(&f, create(&d, &old, "Sisa")), Ok(()));
    assert_eq!(
        w.sim.push(
            &f,
            Body::TeamArchive {
                team: old.clone(),
                archived: true
            }
        ),
        Ok(())
    );
    assert_eq!(w.sim.push(&f, add(&d, &citra)), Err(R::DepartmentArchived));
    assert_eq!(
        w.sim.push(&f, head(&d, &citra, true)),
        Err(R::DepartmentArchived)
    );
    assert_eq!(
        w.sim.push(&f, chat(&old, Some(&d), "Halo", false)),
        Err(R::DepartmentArchived)
    );
    assert_eq!(
        w.sim.push(&f, chat(&old, None, "Halo", false)),
        Err(R::DepartmentArchived)
    );
    assert_eq!(w.sim.push(&f, rename(&d, "Sisa Lama")), Ok(()));
}

#[test]
fn deleting_a_department_drops_its_chat_settings() {
    let mut w = world();
    let (it, hr, m) = (w.it.clone(), w.hr.clone(), w.mobile.clone());
    let f = w.f.clone_actor();
    assert_eq!(w.sim.push(&f, chat(&hr, None, "HR", true)), Ok(()));
    assert_eq!(w.sim.push(&f, chat(&it, Some(&m), "Mobile", true)), Ok(()));
    assert_eq!(w.sim.push(&f, chat(&it, None, "IT", true)), Ok(()));
    assert_eq!(
        w.sim.push(&f, Body::TeamDelete { team: it.clone() }),
        Ok(())
    );
    let s = w.state();
    assert!(s.chat_settings.keys().all(|(t, _)| *t != it));
    assert!(s.chat_settings_for(&hr, None).is_some());
}

#[test]
fn pinned_notes_refuse_blank_fillers_and_long_line_counts() {
    for bad in [
        "a\u{E0041}b",
        "a\u{E007F}",
        "a\u{034F}b",
        "\u{115F}x",
        "x\u{1160}",
        "a\u{3164}b",
        "a\u{FFA0}b",
    ] {
        assert!(!p::is_valid_pinned_note(bad), "{bad:?}");
        assert!(matches!(
            p::clean_pinned_note(bad),
            Err(AppError::InvalidInput(_))
        ));
    }
    assert!(p::is_valid_pinned_note("Braille \u{2800} boleh"));
    let lines = |n: usize| vec!["baris"; n].join("\n");
    assert!(p::is_valid_pinned_note(&lines(p::PINNED_MAX_LINES)));
    assert!(!p::is_valid_pinned_note(&lines(p::PINNED_MAX_LINES + 1)));
    assert!(matches!(
        p::clean_pinned_note(&lines(21)),
        Err(AppError::InvalidInput(m)) if m == "Catatan disematkan paling banyak 20 baris."
    ));
}
