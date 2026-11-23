//! v0.3 fold rules (docs/plans/v0.3-kontrak.md): departments (one per
//! person, move, rename, archive), join requests, projects with explicit
//! members, labels and the device profile. Includes rejections for every
//! rule, the multi-team rule for v0.2 logs, concurrent revocations and
//! order independence.

use ed25519_dalek::Signer;
use rand_core::{OsRng, RngCore};
use time::Duration;

use super::sim::*;
use crate::org::Role;
use crate::permissions::fold::Reason as R;
use crate::permissions::format::format_time;
use crate::permissions::join::{JoinRequestPayload, sign_join_request};
use crate::permissions::{
    Body, InviteRole, MemberStatus, OrgState, TeamRole, VerifiedOp, fold, project_id_for,
    umum_channel_id,
};

// ----- Body helpers --------------------------------------------------------

fn move_to(team: &str, m: &Actor) -> Body {
    Body::TeamMove {
        team: team.into(),
        member: m.pk.clone(),
    }
}

fn rename(team: &str, name: &str) -> Body {
    Body::TeamRename {
        team: team.into(),
        name: name.into(),
    }
}

fn archive(team: &str, archived: bool) -> Body {
    Body::TeamArchive {
        team: team.into(),
        archived,
    }
}

fn admin_set(team: &str, m: &Actor) -> Body {
    Body::TeamAdminSet {
        team: team.into(),
        member: m.pk.clone(),
    }
}

fn tm_add(team: &str, m: &Actor) -> Body {
    Body::TeamMemberAdd {
        team: team.into(),
        member: m.pk.clone(),
    }
}

fn tm_remove(team: &str, m: &Actor) -> Body {
    Body::TeamMemberRemove {
        team: team.into(),
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

fn admin_unset(team: &str, m: &Actor) -> Body {
    Body::TeamAdminUnset {
        team: team.into(),
        member: m.pk.clone(),
    }
}

/// A join request signed by `who`, dated `at`.
fn request(
    sim: &Sim,
    who: &Actor,
    name: &str,
    team: &str,
    at: time::OffsetDateTime,
) -> (String, String) {
    request_with(sim, who, name, team, at, None, None)
}

/// Same with the v0.4 fields `note` and `account`.
fn request_with(
    sim: &Sim,
    who: &Actor,
    name: &str,
    team: &str,
    at: time::OffsetDateTime,
    note: Option<&str>,
    account: Option<&str>,
) -> (String, String) {
    let p = JoinRequestPayload {
        v: 1,
        org: sim.org.id.clone(),
        org_fp: crate::permissions::org_fingerprint(&sim.org),
        member: who.pk.clone(),
        name: name.into(),
        team: team.into(),
        laptop: "LAPTOP-DESAIN-03".into(),
        os: "Windows 11".into(),
        app_version: "0.3.0".into(),
        note: note.map(str::to_owned),
        account: account.map(str::to_owned),
        at: format_time(at),
        nonce: rand_hex16(),
    };
    let s = sign_join_request(&p, |m| who.sk.sign(m));
    (s.payload, s.sig)
}

fn approve((request, request_sig): &(String, String)) -> Body {
    Body::JoinApprove {
        request: request.clone(),
        request_sig: request_sig.clone(),
    }
}

fn reject((request, request_sig): &(String, String)) -> Body {
    Body::JoinReject {
        request: request.clone(),
        request_sig: request_sig.clone(),
    }
}

struct Project {
    id: String,
    body: Body,
}

/// `project_create` by `creator` (bound id) with initial `members`.
fn project(creator: &Actor, team: Option<&str>, members: &[&Actor]) -> Project {
    project_for(creator, &creator.pk, team, members)
}

/// Registration authored by `by` for a project of `creator`.
fn project_for(_by: &Actor, creator: &str, team: Option<&str>, members: &[&Actor]) -> Project {
    let nonce = rand_hex16();
    let id = project_id_for(creator, team, &nonce);
    let mut members: Vec<String> = members.iter().map(|a| a.pk.clone()).collect();
    members.sort();
    members.dedup();
    Project {
        body: Body::ProjectCreate {
            project: id.clone(),
            team: team.map(str::to_owned),
            creator: creator.into(),
            nonce,
            members,
        },
        id,
    }
}

fn p_add(project: &str, m: &Actor) -> Body {
    Body::ProjectMemberAdd {
        project: project.into(),
        member: m.pk.clone(),
    }
}

fn p_remove(project: &str, m: &Actor) -> Body {
    Body::ProjectMemberRemove {
        project: project.into(),
        member: m.pk.clone(),
    }
}

// ----- World ---------------------------------------------------------------

/// Founder (superadmin, in Desain), Desain with admin `admin_d` and member
/// `member_d`, Drafting with admin `admin_g` and member `member_g`, a guest
/// of Desain, and a second superadmin `sa2` in Drafting.
struct World {
    sim: Sim,
    f: Actor,
    desain: String,
    drafting: String,
    admin_d: Actor,
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
    let member_d = sim.join(&desain, InviteRole::Member, "Dimas");
    let admin_g = sim.join(&drafting, InviteRole::TeamAdmin, "Budi");
    let member_g = sim.join(&drafting, InviteRole::Member, "Sari");
    let guest = sim.join(&desain, InviteRole::Guest, "Yusuf");
    let sa2 = sim.join(&drafting, InviteRole::Member, "Andi");
    assert_eq!(sim.push(&f, sa_add(&sa2)), Ok(()));
    assert_eq!(sim.push(&f, move_to(&desain, &f)), Ok(()));
    World {
        sim,
        f,
        desain,
        drafting,
        admin_d,
        member_d,
        admin_g,
        member_g,
        guest,
        sa2,
    }
}

fn shuffled(ops: &[VerifiedOp]) -> Vec<VerifiedOp> {
    let mut v = ops.to_vec();
    for i in (1..v.len()).rev() {
        let j = (OsRng.next_u32() as usize) % (i + 1);
        v.swap(i, j);
    }
    v
}

/// Same state and outcomes for several arrival orders.
fn assert_order_free(sim: &Sim) {
    let base = fold(&sim.org, &sim.ops);
    let mut rev = sim.ops.clone();
    rev.reverse();
    for ops in [rev, shuffled(&sim.ops), shuffled(&sim.ops)] {
        let r = fold(&sim.org, &ops);
        assert_eq!(r.state, base.state);
        assert_eq!(r.outcomes, base.outcomes);
    }
}

fn dept(s: &OrgState, m: &Actor) -> Option<String> {
    s.department_of(&m.pk).map(|(t, _)| t.id.clone())
}

// ----- Departments -----------------------------------------------------------

#[test]
fn one_department_per_person() {
    let w = world();
    let s = w.sim.state();
    for (m, team) in [
        (&w.f, &w.desain),
        (&w.admin_d, &w.desain),
        (&w.member_d, &w.desain),
        (&w.admin_g, &w.drafting),
        (&w.member_g, &w.drafting),
        (&w.sa2, &w.drafting),
    ] {
        assert_eq!(s.teams_of(&m.pk).len(), 1);
        assert_eq!(dept(&s, m).as_ref(), Some(team));
    }
    assert_eq!(dept(&s, &w.guest), None, "guests have no department");
}

#[test]
fn team_move_row() {
    let mut w = world();
    let (d, g) = (w.desain.clone(), w.drafting.clone());
    // Only a superadmin moves people.
    assert_eq!(
        w.sim.push(&w.admin_d, move_to(&g, &w.member_d)),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&w.admin_g, move_to(&g, &w.member_d)),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&w.member_d, move_to(&g, &w.member_d)),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&w.f, move_to(&g, &w.guest)),
        Err(R::TargetIsGuest)
    );
    assert_eq!(
        w.sim.push(&w.f, move_to(&d, &w.member_d)),
        Err(R::AlreadyInTeam)
    );
    assert_eq!(
        w.sim.push(&w.f, move_to(&rand_hex16(), &w.member_d)),
        Err(R::TeamNotFound)
    );
    assert_eq!(
        w.sim.push(&w.f, move_to(&g, &Actor::new())),
        Err(R::TargetNotActive)
    );
    // Atomic: out of Desain, into Drafting.
    assert_eq!(w.sim.push(&w.sa2, move_to(&g, &w.member_d)), Ok(()));
    let s = w.sim.state();
    assert_eq!(dept(&s, &w.member_d), Some(g.clone()));
    assert_eq!(s.team_role(&d, &w.member_d.pk), None);
    // Moving a department admin ends that admin role.
    assert_eq!(w.sim.push(&w.f, move_to(&g, &w.admin_d)), Ok(()));
    let s = w.sim.state();
    assert_eq!(s.team_role(&g, &w.admin_d.pk), Some(TeamRole::Member));
    assert_eq!(s.org_role(&w.admin_d.pk), Role::Member);
    assert_order_free(&w.sim);
}

#[test]
fn old_team_ops_keep_one_department() {
    let mut w = world();
    let (d, g) = (w.desain.clone(), w.drafting.clone());
    // A department admin can no longer pull someone from another department.
    assert_eq!(
        w.sim.push(&w.admin_g, tm_add(&g, &w.member_d)),
        Err(R::AlreadyInDepartment)
    );
    assert_eq!(
        w.sim.push(&w.f, tm_add(&g, &w.member_d)),
        Err(R::AlreadyInDepartment)
    );
    assert_eq!(
        w.sim.push(&w.f, admin_set(&g, &w.member_d)),
        Err(R::AlreadyInDepartment)
    );
    // `team_member_remove` keeps the v0.2 rule so old logs fold the same
    // (self, department admin for plain members, superadmin).
    assert_eq!(
        w.sim.push(&w.member_g, tm_remove(&d, &w.member_d)),
        Err(R::NotAuthorized)
    );
    assert_eq!(w.sim.push(&w.admin_d, tm_remove(&d, &w.member_d)), Ok(()));
    assert!(
        w.sim.state().department_of(&w.member_d.pk).is_none(),
        "no department now"
    );
    // Without a department, the department admin may add them back.
    assert_eq!(w.sim.push(&w.admin_d, tm_add(&d, &w.member_d)), Ok(()));
    assert_eq!(
        w.sim.push(&w.admin_d, tm_add(&d, &w.member_d)),
        Err(R::AlreadyInTeam)
    );
    // Admin of a department: only someone in it, or without one.
    assert_eq!(w.sim.push(&w.f, admin_set(&d, &w.member_d)), Ok(()));
    assert_order_free(&w.sim);
}

/// v0.2 logs where someone joined several teams fold to one department:
/// the earliest membership wins, later additions are rejected.
#[test]
fn multi_team_v02_log_keeps_the_earliest_department() {
    let mut sim = Sim::new();
    let f = sim.founder();
    let a = sim.team("Tim A");
    let b = sim.team("Tim B");
    let c = sim.team("Tim C");
    let m = sim.join(&a, InviteRole::Member, "Wulan");
    // v0.2 let her accept another team's invite and be made admin of a third.
    let inv_b = sim.invite(&f, &b, InviteRole::Member, true);
    assert_eq!(
        sim.accept(&f, &inv_b, &m, "Wulan"),
        Err(R::AlreadyInDepartment)
    );
    assert_eq!(sim.push(&f, admin_set(&c, &m)), Err(R::AlreadyInDepartment));
    assert_eq!(sim.push(&f, tm_add(&b, &m)), Err(R::AlreadyInDepartment));
    let s = sim.state();
    assert_eq!(dept(&s, &m), Some(a.clone()));
    assert_eq!(s.teams_of(&m.pk).len(), 1);
    // A team admin invite to the same team still upgrades the role.
    let inv_a = sim.invite(&f, &a, InviteRole::TeamAdmin, true);
    assert_eq!(sim.accept(&f, &inv_a, &m, "Wulan"), Ok(()));
    assert_eq!(sim.state().team_role(&a, &m.pk), Some(TeamRole::Admin));
    // A guest who becomes a member gets the invite's department.
    let g = sim.join(&a, InviteRole::Guest, "Klien");
    let inv_c = sim.invite(&f, &c, InviteRole::Member, true);
    assert_eq!(sim.accept(&f, &inv_c, &g, "Klien"), Ok(()));
    assert_eq!(dept(&sim.state(), &g), Some(c.clone()));
    assert_order_free(&sim);
}

#[test]
fn team_rename_row_renames_the_department_channel() {
    let mut w = world();
    let d = w.desain.clone();
    let channel = Body::ChannelCreate {
        channel: rand_hex16(),
        team: d.clone(),
        name: "desain".into(),
    };
    assert_eq!(w.sim.push(&w.f, channel), Ok(()));
    assert_eq!(
        w.sim.push(&w.admin_d, rename(&d, "Desain Arsitektur")),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&w.member_d, rename(&d, "Desain Arsitektur")),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&w.f, rename(&rand_hex16(), "X Y")),
        Err(R::TeamNotFound)
    );
    assert_eq!(w.sim.push(&w.f, rename(&d, "Desain")), Err(R::NoChange));
    assert_eq!(w.sim.push(&w.f, rename(&d, "Desain Arsitektur")), Ok(()));
    let s = w.sim.state();
    assert_eq!(s.teams[&d].name, "Desain Arsitektur");
    let ch: Vec<_> = s
        .channels
        .values()
        .filter(|c| c.team.as_deref() == Some(d.as_str()))
        .collect();
    assert_eq!(ch.len(), 1);
    assert_eq!(ch[0].name, "desain-arsitektur");
    assert_eq!(s.channels[&umum_channel_id(&w.sim.org.id)].name, "umum");
}

#[test]
fn team_archive_row() {
    let mut w = world();
    let empty = w.sim.team("Interior");
    let d = w.desain.clone();
    assert_eq!(
        w.sim.push(&w.admin_d, archive(&empty, true)),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&w.f, archive(&d, true)),
        Err(R::DepartmentNotEmpty)
    );
    assert_eq!(w.sim.push(&w.f, archive(&empty, false)), Err(R::NoChange));
    let pending = w.sim.invite(&w.f, &empty, InviteRole::Member, false);
    assert_eq!(pending.outcome, Ok(()));
    assert_eq!(w.sim.push(&w.f, archive(&empty, true)), Ok(()));
    assert_eq!(w.sim.push(&w.f, archive(&empty, true)), Err(R::NoChange));
    // Nobody can be put in an archived department.
    assert_eq!(
        w.sim.push(&w.f, move_to(&empty, &w.member_d)),
        Err(R::DepartmentArchived)
    );
    assert_eq!(
        w.sim.push(&w.f, admin_set(&empty, &w.member_d)),
        Err(R::DepartmentArchived)
    );
    let inv = w.sim.invite(&w.f, &empty, InviteRole::Member, false);
    assert_eq!(inv.outcome, Err(R::DepartmentArchived));
    assert_eq!(
        w.sim.accept(&w.f, &pending, &Actor::new(), "Baru"),
        Err(R::DepartmentArchived),
        "invites made before the archive stop working"
    );
    let s = w.sim.state();
    assert!(s.teams[&empty].archived);
    assert!(s.teams[&empty].archived_at.is_some());
    assert!(s.live_team(&empty).is_some(), "archived is not deleted");
    // Restored, it takes people again.
    assert_eq!(w.sim.push(&w.f, archive(&empty, false)), Ok(()));
    assert_eq!(w.sim.push(&w.f, move_to(&empty, &w.member_d)), Ok(()));
    assert_order_free(&w.sim);
}

// ----- Join requests ---------------------------------------------------------

#[test]
fn join_approve_admits_with_name_department_and_device() {
    let mut w = world();
    let rina2 = Actor::new();
    let req = request(&w.sim, &rina2, "Lestari", &w.desain, w.sim.now);
    assert_eq!(w.sim.push(&w.admin_d, approve(&req)), Ok(()));
    let s = w.sim.state();
    let m = s.member(&rina2.pk).unwrap();
    assert_eq!(m.status, MemberStatus::Active);
    assert_eq!(m.display_name.as_deref(), Some("Lestari"));
    assert!(!m.is_superadmin);
    assert_eq!(dept(&s, &rina2), Some(w.desain.clone()));
    assert_eq!(s.team_role(&w.desain, &rina2.pk), Some(TeamRole::Member));
    let device = m.device.as_ref().unwrap();
    assert_eq!(device.laptop, "LAPTOP-DESAIN-03");
    assert_eq!(device.os, "Windows 11");
    let decision = s.join_decisions.values().next().unwrap();
    assert!(decision.approved);
    assert_eq!(decision.by, w.admin_d.pk);
    assert_order_free(&w.sim);
}

#[test]
fn join_approve_with_note_and_account_admits() {
    let mut w = world();
    let x = Actor::new();
    let req = request_with(
        &w.sim,
        &x,
        "Lestari",
        &w.desain,
        w.sim.now,
        Some("Staf gudang, NIK 1234"),
        Some("lestari"),
    );
    assert!(req.0.contains("\"note\":\"Staf gudang, NIK 1234\""));
    assert_eq!(w.sim.push(&w.admin_d, approve(&req)), Ok(()));
    let s = w.sim.state();
    assert!(s.is_active(&x.pk));
    assert_eq!(dept(&s, &x), Some(w.desain.clone()));
    assert_order_free(&w.sim);
    // A request whose note breaks the format does not even pass the op
    // format check (`verify_op` refuses it).
    let y = Actor::new();
    let bad = request_with(
        &w.sim,
        &y,
        "Yudi",
        &w.desain,
        w.sim.now,
        Some("baris\nbaru"),
        None,
    );
    let p = w.sim.payload(
        &w.admin_d,
        w.sim.lamport + 1,
        crate::permissions::Scope::Org,
        approve(&bad),
    );
    let signed = Sim::sign(&w.admin_d, &p);
    assert_eq!(
        crate::permissions::verify_op(&signed, &w.sim.org.id, w.sim.now)
            .unwrap_err()
            .code,
        "bad_format"
    );
}

#[test]
fn join_decision_authority() {
    let mut w = world();
    let x = Actor::new();
    let req = request(&w.sim, &x, "Xena", &w.desain, w.sim.now);
    // Admin of another department, plain members and guests cannot decide.
    assert_eq!(w.sim.push(&w.admin_g, approve(&req)), Err(R::NotAuthorized));
    assert_eq!(
        w.sim.push(&w.member_d, approve(&req)),
        Err(R::NotAuthorized)
    );
    assert_eq!(w.sim.push(&w.guest, approve(&req)), Err(R::NotAuthorized));
    assert_eq!(w.sim.push(&w.admin_g, reject(&req)), Err(R::NotAuthorized));
    assert_eq!(w.sim.push(&w.member_d, reject(&req)), Err(R::NotAuthorized));
    // A superadmin from any department can.
    assert_eq!(w.sim.push(&w.sa2, approve(&req)), Ok(()));
    assert_eq!(w.sim.push(&w.f, approve(&req)), Err(R::JoinAlreadyDecided));
    assert_eq!(w.sim.push(&w.f, reject(&req)), Err(R::JoinAlreadyDecided));
    // A second request from the same, now active, laptop.
    let again = request(&w.sim, &x, "Xena", &w.drafting, w.sim.now);
    assert_eq!(w.sim.push(&w.f, approve(&again)), Err(R::AlreadyMember));
}

#[test]
fn rejected_request_cannot_be_approved_and_a_new_one_can() {
    let mut w = world();
    let x = Actor::new();
    let req = request(&w.sim, &x, "Xena", &w.desain, w.sim.now);
    assert_eq!(w.sim.push(&w.admin_d, reject(&req)), Ok(()));
    assert_eq!(w.sim.push(&w.f, approve(&req)), Err(R::JoinAlreadyDecided));
    let s = w.sim.state();
    assert!(s.member(&x.pk).is_none());
    assert!(!s.join_decisions.values().next().unwrap().approved);
    let again = request(&w.sim, &x, "Xena", &w.desain, w.sim.now);
    assert_eq!(w.sim.push(&w.admin_d, approve(&again)), Ok(()));
    assert!(w.sim.state().is_active(&x.pk));
}

#[test]
fn join_request_checks() {
    let mut w = world();
    let x = Actor::new();
    // Signed by someone else than the requester key: rejected.
    let (payload, _) = request(&w.sim, &x, "Xena", &w.desain, w.sim.now);
    let forged_sig = hex::encode(Actor::new().sk.sign(b"x").to_bytes());
    assert_eq!(
        w.sim.push(&w.f, approve(&(payload.clone(), forged_sig))),
        Err(R::BadJoinRequest)
    );
    // Tampered after signing (name changed by the approver).
    let (p, sig) = request(&w.sim, &x, "Xena", &w.desain, w.sim.now);
    let tampered = p.replace("Xena", "Xeno");
    assert_eq!(
        w.sim.push(&w.f, approve(&(tampered, sig))),
        Err(R::BadJoinRequest)
    );
    // Unknown or archived department.
    let unknown = request(&w.sim, &x, "Xena", &rand_hex16(), w.sim.now);
    assert_eq!(w.sim.push(&w.f, approve(&unknown)), Err(R::TeamNotFound));
    let empty = w.sim.team("Interior");
    assert_eq!(w.sim.push(&w.f, archive(&empty, true)), Ok(()));
    let archived = request(&w.sim, &x, "Xena", &empty, w.sim.now);
    assert_eq!(
        w.sim.push(&w.f, approve(&archived)),
        Err(R::DepartmentArchived)
    );
    // Approval more than 7 days after the request, or before it.
    let old = request(&w.sim, &x, "Xena", &w.desain, w.sim.now - Duration::days(8));
    assert_eq!(w.sim.push(&w.f, approve(&old)), Err(R::JoinRequestExpired));
    let future = request(
        &w.sim,
        &x,
        "Xena",
        &w.desain,
        w.sim.now + Duration::hours(1),
    );
    assert_eq!(
        w.sim.push(&w.f, approve(&future)),
        Err(R::JoinRequestExpired)
    );
    // Removed laptops cannot come back.
    assert_eq!(w.sim.push(&w.f, remove(&w.member_g)), Ok(()));
    let back = request(&w.sim, &w.member_g, "Sari", &w.drafting, w.sim.now);
    assert_eq!(w.sim.push(&w.f, approve(&back)), Err(R::MemberRemoved));
    // A request for another organization does not even pass the format
    // check (`verify_op` refuses it).
    let other = Sim::new();
    let foreign = request(&other, &x, "Xena", &w.desain, w.sim.now);
    let p = w.sim.payload(
        &w.f,
        w.sim.lamport + 1,
        crate::permissions::Scope::Org,
        approve(&foreign),
    );
    let signed = Sim::sign(&w.f, &p);
    assert_eq!(
        crate::permissions::verify_op(&signed, &w.sim.org.id, w.sim.now)
            .unwrap_err()
            .code,
        "bad_format"
    );
}

#[test]
fn demoted_department_admin_cannot_approve_concurrently() {
    let mut w = world();
    let x = Actor::new();
    let req = request(&w.sim, &x, "Xena", &w.desain, w.sim.now);
    let before = w.sim.lamport;
    // The superadmin removes Rina's admin role; Rina approves offline with
    // a lamport that sorts first and without having seen the removal.
    assert_eq!(w.sim.push(&w.f, admin_unset(&w.desain, &w.admin_d)), Ok(()));
    let late = w
        .sim
        .make_with_deps(&w.admin_d, before, w.sim.heads_below(before), approve(&req));
    assert_eq!(w.sim.add(late), Err(R::ConcurrentWithRevocation));
    assert!(!w.sim.state().is_active(&x.pk));
    assert_order_free(&w.sim);
}

// ----- Projects ----------------------------------------------------------------

#[test]
fn project_create_row() {
    let mut w = world();
    let p = project(&w.member_d, Some(&w.desain), &[&w.member_g, &w.guest]);
    assert_eq!(w.sim.push(&w.member_d, p.body.clone()), Ok(()));
    assert_eq!(w.sim.push(&w.member_d, p.body.clone()), Err(R::IdInUse));
    let s = w.sim.state();
    let reg = &s.projects[&p.id];
    assert_eq!(reg.creator, w.member_d.pk);
    assert_eq!(reg.team.as_deref(), Some(w.desain.as_str()));
    let members: Vec<&String> = reg.members.keys().collect();
    assert_eq!(members.len(), 3, "creator plus the two picked");
    assert!(
        reg.members.contains_key(&w.member_g.pk),
        "members come from any department"
    );
    assert!(reg.members.contains_key(&w.guest.pk));
    // Guests cannot create projects; ids must be bound to creator and team.
    let g = project(&w.guest, Some(&w.desain), &[]);
    assert_eq!(w.sim.push(&w.guest, g.body), Err(R::GuestNotAllowed));
    let Body::ProjectCreate { nonce, members, .. } =
        project(&w.member_d, Some(&w.desain), &[]).body
    else {
        unreachable!()
    };
    let wrong_team = Body::ProjectCreate {
        project: project_id_for(&w.member_d.pk, Some(&w.desain), &nonce),
        team: Some(w.drafting.clone()),
        creator: w.member_d.pk.clone(),
        nonce,
        members,
    };
    assert_eq!(w.sim.push(&w.member_d, wrong_team), Err(R::BadProjectId));
    let unknown = project(&w.member_d, Some(&rand_hex16()), &[]);
    assert_eq!(w.sim.push(&w.member_d, unknown.body), Err(R::TeamNotFound));
    // Someone else cannot register a project of an active creator.
    let other = project_for(&w.f, &w.member_g.pk, Some(&w.drafting), &[]);
    assert_eq!(w.sim.push(&w.f, other.body), Err(R::NotAuthorized));
    // Removed people in the initial list are skipped.
    assert_eq!(w.sim.push(&w.f, remove(&w.member_g)), Ok(()));
    let p2 = project(&w.admin_d, Some(&w.desain), &[&w.member_g]);
    assert_eq!(w.sim.push(&w.admin_d, p2.body), Ok(()));
    assert_eq!(w.sim.state().projects[&p2.id].members.len(), 1);
    assert_order_free(&w.sim);
}

#[test]
fn legacy_project_of_a_removed_creator_can_be_registered_by_a_manager() {
    let mut w = world();
    let gone = w.member_g.pk.clone();
    assert_eq!(w.sim.push(&w.f, remove(&w.member_g)), Ok(()));
    // Plain members and admins of other departments cannot.
    let by_member = project_for(&w.member_d, &gone, Some(&w.drafting), &[]);
    assert_eq!(
        w.sim.push(&w.member_d, by_member.body),
        Err(R::NotAuthorized)
    );
    let by_other_admin = project_for(&w.admin_d, &gone, Some(&w.drafting), &[]);
    assert_eq!(
        w.sim.push(&w.admin_d, by_other_admin.body),
        Err(R::NotAuthorized)
    );
    // The department admin can, with the v0.2 readers as members.
    let ok = project_for(&w.admin_g, &gone, Some(&w.drafting), &[&w.admin_g, &w.sa2]);
    assert_eq!(w.sim.push(&w.admin_g, ok.body), Ok(()));
    let s = w.sim.state();
    let reg = &s.projects[&ok.id];
    assert_eq!(reg.creator, gone);
    assert_eq!(reg.registered_by, w.admin_g.pk);
    assert_eq!(reg.members.len(), 2, "the removed creator is not a member");
    // A superadmin can register a project without department.
    let none = project_for(&w.sa2, &gone, None, &[&w.member_d]);
    assert_eq!(w.sim.push(&w.sa2, none.body), Ok(()));
    assert_order_free(&w.sim);
}

#[test]
fn project_member_management_rules() {
    let mut w = world();
    let p = project(&w.member_d, Some(&w.desain), &[]);
    assert_eq!(w.sim.push(&w.member_d, p.body), Ok(()));
    let id = p.id.clone();
    // The creator manages.
    assert_eq!(w.sim.push(&w.member_d, p_add(&id, &w.member_g)), Ok(()));
    assert_eq!(
        w.sim.push(&w.member_d, p_add(&id, &w.member_g)),
        Err(R::AlreadyInProject)
    );
    // A plain member of the project does not.
    assert_eq!(
        w.sim.push(&w.member_g, p_add(&id, &w.admin_g)),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&w.member_g, p_remove(&id, &w.member_d)),
        Err(R::NotAuthorized)
    );
    // The department admin manages without being a member.
    assert!(!w.sim.state().is_project_member(&id, &w.admin_d.pk));
    assert_eq!(w.sim.push(&w.admin_d, p_add(&id, &w.guest)), Ok(()));
    // An admin of another department does not.
    assert_eq!(
        w.sim.push(&w.admin_g, p_add(&id, &w.sa2)),
        Err(R::NotAuthorized)
    );
    // A superadmin outside the project cannot add others, only themselves.
    assert_eq!(
        w.sim.push(&w.sa2, p_add(&id, &w.admin_g)),
        Err(R::NotAuthorized)
    );
    assert_eq!(w.sim.push(&w.sa2, p_add(&id, &w.sa2)), Ok(()));
    assert_eq!(
        w.sim.push(&w.sa2, p_add(&id, &w.admin_g)),
        Ok(()),
        "as a member"
    );
    // Guests cannot manage, and targets must be active.
    assert_eq!(
        w.sim.push(&w.guest, p_add(&id, &w.f)),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&w.member_d, p_add(&id, &Actor::new())),
        Err(R::TargetNotActive)
    );
    assert_eq!(
        w.sim.push(&w.member_d, p_add(&rand_hex16(), &w.f)),
        Err(R::ProjectNotFound)
    );
    // Anyone may leave.
    assert_eq!(w.sim.push(&w.member_g, p_remove(&id, &w.member_g)), Ok(()));
    assert_eq!(
        w.sim.push(&w.member_g, p_remove(&id, &w.member_g)),
        Err(R::NotInProject)
    );
    // The creator who left the project no longer manages it.
    assert_eq!(w.sim.push(&w.member_d, p_remove(&id, &w.member_d)), Ok(()));
    assert_eq!(
        w.sim.push(&w.member_d, p_add(&id, &w.member_g)),
        Err(R::NotAuthorized)
    );
    let s = w.sim.state();
    let members: Vec<&String> = s.projects[&id].members.keys().collect();
    assert_eq!(members.len(), 3, "guest, sa2, admin_g");
    assert_order_free(&w.sim);
}

#[test]
fn guest_invited_by_code_is_removed_from_the_project() {
    let mut w = world();
    let p = project(&w.admin_d, Some(&w.desain), &[]);
    assert_eq!(w.sim.push(&w.admin_d, p.body), Ok(()));
    // A guest invite through the project's department.
    let code = new_code();
    let (_, body) = w
        .sim
        .invite_body(&w.admin_d, &w.desain, InviteRole::Guest, true, 24, &code);
    let Body::InviteCreate {
        invite,
        tag,
        key,
        expires,
        single_use,
        ..
    } = body
    else {
        unreachable!()
    };
    let projects = vec![p.id.clone()];
    let key_sig = w.sim.key_sig(
        &w.admin_d,
        &invite,
        &w.desain,
        InviteRole::Guest,
        &projects,
        &expires,
        single_use,
        &code,
    );
    let body = Body::InviteCreate {
        invite: invite.clone(),
        team: w.desain.clone(),
        role: InviteRole::Guest,
        projects,
        expires,
        single_use,
        tag,
        key,
        key_sig,
    };
    assert_eq!(w.sim.push(&w.admin_d, body), Ok(()));
    let klien = Actor::new();
    let inv = Invite {
        id: invite,
        code,
        outcome: Ok(()),
    };
    assert_eq!(w.sim.accept(&w.admin_d, &inv, &klien, "Klien"), Ok(()));
    assert!(w.sim.state().has_project_guest_access(&p.id, &klien.pk));
    assert_eq!(
        w.sim.push(&w.member_g, p_remove(&p.id, &klien)),
        Err(R::NotAuthorized)
    );
    assert_eq!(w.sim.push(&w.admin_d, p_remove(&p.id, &klien)), Ok(()));
    assert!(!w.sim.state().has_project_guest_access(&p.id, &klien.pk));
}

#[test]
fn creator_removed_from_project_concurrently_cannot_add_members() {
    let mut w = world();
    let p = project(&w.member_d, Some(&w.desain), &[]);
    assert_eq!(w.sim.push(&w.member_d, p.body), Ok(()));
    let bump = Body::ProfileSet {
        name: "Andi".into(),
    };
    assert_eq!(w.sim.push(&w.f, bump), Ok(()));
    let before = w.sim.lamport;
    // The department admin takes the creator out; the creator, offline,
    // adds someone at a lamport that sorts first.
    assert_eq!(w.sim.push(&w.admin_d, p_remove(&p.id, &w.member_d)), Ok(()));
    let late = w.sim.make_with_deps(
        &w.member_d,
        before,
        w.sim.heads_below(before),
        p_add(&p.id, &w.member_g),
    );
    assert_eq!(w.sim.add(late), Err(R::ConcurrentWithRevocation));
    assert!(!w.sim.state().is_project_member(&p.id, &w.member_g.pk));
    assert_order_free(&w.sim);
}

#[test]
fn removing_a_member_clears_projects_and_labels() {
    let mut w = world();
    let p = project(&w.member_d, Some(&w.desain), &[&w.member_g]);
    assert_eq!(w.sim.push(&w.member_d, p.body), Ok(()));
    let label = rand_hex16();
    let create = Body::LabelCreate {
        label: label.clone(),
        name: "Drafter".into(),
    };
    assert_eq!(w.sim.push(&w.f, create), Ok(()));
    let assign = Body::LabelAssign {
        label: label.clone(),
        member: w.member_g.pk.clone(),
    };
    assert_eq!(w.sim.push(&w.f, assign), Ok(()));
    assert_eq!(w.sim.push(&w.f, remove(&w.member_g)), Ok(()));
    let s = w.sim.state();
    assert!(!s.is_project_member(&p.id, &w.member_g.pk));
    assert!(s.labels[&label].members.is_empty());
}

// ----- Labels --------------------------------------------------------------------

#[test]
fn label_rows_are_superadmin_only() {
    let mut w = world();
    let id = rand_hex16();
    let create = |name: &str| Body::LabelCreate {
        label: id.clone(),
        name: name.into(),
    };
    for who in [&w.admin_d, &w.member_d, &w.guest] {
        assert_eq!(w.sim.push(who, create("K3")), Err(R::NotAuthorized));
    }
    assert_eq!(w.sim.push(&w.f, create("K3")), Ok(()));
    assert_eq!(w.sim.push(&w.f, create("K3")), Err(R::IdInUse));
    let lr = |name: &str| Body::LabelRename {
        label: id.clone(),
        name: name.into(),
    };
    let la = |archived: bool| Body::LabelArchive {
        label: id.clone(),
        archived,
    };
    let assign = |m: &Actor, on: bool| {
        let (label, member) = (id.clone(), m.pk.clone());
        if on {
            Body::LabelAssign { label, member }
        } else {
            Body::LabelUnassign { label, member }
        }
    };
    assert_eq!(w.sim.push(&w.admin_d, lr("Ahli K3")), Err(R::NotAuthorized));
    assert_eq!(w.sim.push(&w.sa2, lr("K3")), Err(R::NoChange));
    assert_eq!(w.sim.push(&w.sa2, lr("Ahli K3")), Ok(()));
    assert_eq!(
        w.sim.push(&w.admin_d, assign(&w.member_d, true)),
        Err(R::NotAuthorized)
    );
    assert_eq!(w.sim.push(&w.f, assign(&w.member_d, true)), Ok(()));
    assert_eq!(
        w.sim.push(&w.f, assign(&w.member_d, true)),
        Err(R::NoChange)
    );
    assert_eq!(
        w.sim.push(&w.f, assign(&w.guest, true)),
        Ok(()),
        "guests may carry labels"
    );
    assert_eq!(
        w.sim.push(&w.f, assign(&Actor::new(), true)),
        Err(R::TargetNotActive)
    );
    assert_eq!(
        w.sim.push(&w.admin_d, assign(&w.member_d, false)),
        Err(R::NotAuthorized)
    );
    assert_eq!(w.sim.push(&w.f, assign(&w.member_d, false)), Ok(()));
    assert_eq!(
        w.sim.push(&w.f, assign(&w.member_d, false)),
        Err(R::NoChange)
    );
    assert_eq!(w.sim.push(&w.admin_d, la(true)), Err(R::NotAuthorized));
    assert_eq!(w.sim.push(&w.f, la(true)), Ok(()));
    assert_eq!(
        w.sim.push(&w.f, assign(&w.member_d, true)),
        Err(R::LabelArchived)
    );
    assert_eq!(w.sim.push(&w.f, la(false)), Ok(()));
    let missing = Body::LabelRename {
        label: rand_hex16(),
        name: "X".into(),
    };
    assert_eq!(w.sim.push(&w.f, missing), Err(R::LabelNotFound));
    let s = w.sim.state();
    let l = &s.labels[&id];
    assert_eq!(l.name, "Ahli K3");
    assert!(!l.archived);
    assert!(l.members.contains(&w.guest.pk));
    assert_order_free(&w.sim);
}

// ----- Device profile ------------------------------------------------------------

#[test]
fn device_set_row() {
    let mut w = world();
    let d = |laptop: &str, version: &str| Body::DeviceSet {
        laptop: laptop.into(),
        os: "Windows 11".into(),
        app_version: version.into(),
    };
    assert_eq!(w.sim.push(&w.member_d, d("LAPTOP-01", "0.3.0")), Ok(()));
    assert_eq!(
        w.sim.push(&w.member_d, d("LAPTOP-01", "0.3.0")),
        Err(R::NoChange)
    );
    assert_eq!(w.sim.push(&w.member_d, d("LAPTOP-01", "0.3.1")), Ok(()));
    assert_eq!(w.sim.push(&w.guest, d("LAPTOP-KLIEN", "0.3.0")), Ok(()));
    assert_eq!(
        w.sim.push(&Actor::new(), d("X", "0.3.0")),
        Err(R::AuthorNotActive)
    );
    let s = w.sim.state();
    let dev = s.member(&w.member_d.pk).unwrap().device.clone().unwrap();
    assert_eq!(dev.app_version, "0.3.1");
    // Only about oneself: the op has no target field.
    assert!(s.member(&w.f.pk).unwrap().device.is_none());
}

#[test]
fn device_fields_are_format_checked() {
    let w = world();
    for body in [
        Body::DeviceSet {
            laptop: String::new(),
            os: "Windows 11".into(),
            app_version: "0.3.0".into(),
        },
        Body::DeviceSet {
            laptop: "L".into(),
            os: "Windows\n11".into(),
            app_version: "0.3.0".into(),
        },
        Body::DeviceSet {
            laptop: "L".into(),
            os: "Windows 11".into(),
            app_version: "0.3 beta".into(),
        },
        Body::LabelCreate {
            label: rand_hex16(),
            name: "x".repeat(31),
        },
    ] {
        let p = w.sim.payload(
            &w.f,
            w.sim.lamport + 1,
            crate::permissions::Scope::Org,
            body,
        );
        let signed = Sim::sign(&w.f, &p);
        assert_eq!(
            crate::permissions::verify_op(&signed, &w.sim.org.id, w.sim.now)
                .unwrap_err()
                .code,
            "bad_format"
        );
    }
}

// ----- Order independence with every new op kind -------------------------------

#[test]
fn fold_of_all_v03_ops_is_independent_of_arrival_order() {
    let mut w = world();
    let x = Actor::new();
    let req = request(&w.sim, &x, "Xena", &w.drafting, w.sim.now);
    let empty = w.sim.team("Interior");
    let label = rand_hex16();
    let p = project(&w.member_d, Some(&w.desain), &[&w.member_g]);
    let steps: Vec<(&Actor, Body)> = vec![
        (&w.admin_g, approve(&req)),
        (&w.f, rename(&w.desain, "Desain Arsitektur")),
        (&w.f, archive(&empty, true)),
        (&w.sa2, move_to(&w.desain, &w.member_g)),
        (&w.member_d, p.body.clone()),
        (&w.admin_d, p_add(&p.id, &w.guest)),
        (
            &w.f,
            Body::LabelCreate {
                label: label.clone(),
                name: "Senior".into(),
            },
        ),
        (
            &w.f,
            Body::LabelAssign {
                label: label.clone(),
                member: w.admin_g.pk.clone(),
            },
        ),
        (
            &w.member_g,
            Body::DeviceSet {
                laptop: "LAPTOP-DRAFT-02".into(),
                os: "Windows 11".into(),
                app_version: "0.3.0".into(),
            },
        ),
        (&w.member_g, p_remove(&p.id, &w.member_g)),
        (&w.f, archive(&empty, false)),
    ];
    for (by, body) in steps {
        assert_eq!(w.sim.push(by, body), Ok(()));
    }
    // A concurrent pair: two superadmins move the same person offline.
    let l = w.sim.lamport;
    let deps = w.sim.heads_below(l + 1);
    let a = w
        .sim
        .make_with_deps(&w.f, l + 1, deps.clone(), move_to(&empty, &w.member_d));
    let b = w
        .sim
        .make_with_deps(&w.sa2, l + 1, deps, move_to(&w.drafting, &w.member_d));
    let _ = w.sim.add(a);
    let _ = w.sim.add(b);
    let s = w.sim.state();
    assert_eq!(
        s.teams_of(&w.member_d.pk).len(),
        1,
        "one department either way"
    );
    for _ in 0..5 {
        assert_order_free(&w.sim);
    }
}

#[test]
fn op_allowed_through_two_rights_needs_both_revoked_to_be_rejected() {
    for revoke_both in [false, true] {
        let mut w = world();
        // Andi is superadmin and admin of Drafting: either right lets him
        // decide a request for Drafting.
        assert_eq!(w.sim.push(&w.f, admin_set(&w.drafting, &w.sa2)), Ok(()));
        let x = Actor::new();
        let req = request(&w.sim, &x, "Xena", &w.drafting, w.sim.now);
        // A neutral op, so the backdated approval below cannot sort before
        // the admin_set it relies on (equal lamports order by author key).
        let bump = Body::ProfileSet {
            name: "Andi".into(),
        };
        assert_eq!(w.sim.push(&w.sa2, bump), Ok(()));
        let before = w.sim.lamport;
        let sa_remove = Body::SuperadminRemove {
            member: w.sa2.pk.clone(),
        };
        assert_eq!(w.sim.push(&w.f, sa_remove), Ok(()));
        if revoke_both {
            assert_eq!(w.sim.push(&w.f, admin_unset(&w.drafting, &w.sa2)), Ok(()));
        }
        // Backdated before the revocations, without having seen them.
        let late = w
            .sim
            .make_with_deps(&w.sa2, before, w.sim.heads_below(before), approve(&req));
        let expected = if revoke_both {
            Err(R::ConcurrentWithRevocation)
        } else {
            Ok(())
        };
        assert_eq!(w.sim.add(late), expected, "both revoked: {revoke_both}");
        assert_order_free(&w.sim);
    }
}

#[test]
fn request_for_a_copy_of_the_organization_is_rejected() {
    let mut w = world();
    let x = Actor::new();
    // Same id, another founder: the requester pinned another genesis.
    let mut copy = w.sim.org.clone();
    copy.founder_public_key = Actor::new().pk;
    let p = JoinRequestPayload {
        v: 1,
        org: w.sim.org.id.clone(),
        org_fp: crate::permissions::org_fingerprint(&copy),
        member: x.pk.clone(),
        name: "Xena".into(),
        team: w.desain.clone(),
        laptop: "L".into(),
        os: "Windows 11".into(),
        app_version: "0.3.0".into(),
        note: None,
        account: None,
        at: format_time(w.sim.now),
        nonce: rand_hex16(),
    };
    let s = sign_join_request(&p, |m| x.sk.sign(m));
    assert_eq!(
        w.sim.push(&w.f, approve(&(s.payload, s.sig))),
        Err(R::BadJoinRequest)
    );
}
