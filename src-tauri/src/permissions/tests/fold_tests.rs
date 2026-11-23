//! The fold: every row of the authority table (plan 1.2), invites (1.3),
//! ordering and late arrival.

use super::sim::*;
use crate::org::Role;
use crate::permissions::fold::Reason as R;
use crate::permissions::{
    Body, GuestAccess, InviteRole, MemberKind, MemberStatus, TeamRole, fold, umum_channel_id,
};

fn bodies() -> Bodies {
    Bodies
}

/// Short constructors for op bodies.
struct Bodies;

impl Bodies {
    fn team_create(&self, team: &str) -> Body {
        Body::TeamCreate {
            team: team.into(),
            name: "Tim Lain".into(),
        }
    }
    fn team_delete(&self, team: &str) -> Body {
        Body::TeamDelete { team: team.into() }
    }
    fn sa_add(&self, m: &Actor) -> Body {
        Body::SuperadminAdd {
            member: m.pk.clone(),
        }
    }
    fn sa_remove(&self, m: &Actor) -> Body {
        Body::SuperadminRemove {
            member: m.pk.clone(),
        }
    }
    fn admin_set(&self, team: &str, m: &Actor) -> Body {
        Body::TeamAdminSet {
            team: team.into(),
            member: m.pk.clone(),
        }
    }
    fn admin_unset(&self, team: &str, m: &Actor) -> Body {
        Body::TeamAdminUnset {
            team: team.into(),
            member: m.pk.clone(),
        }
    }
    fn tm_add(&self, team: &str, m: &Actor) -> Body {
        Body::TeamMemberAdd {
            team: team.into(),
            member: m.pk.clone(),
        }
    }
    fn tm_remove(&self, team: &str, m: &Actor) -> Body {
        Body::TeamMemberRemove {
            team: team.into(),
            member: m.pk.clone(),
        }
    }
    fn remove(&self, m: &Actor) -> Body {
        Body::MemberRemove {
            member: m.pk.clone(),
        }
    }
    fn revoke(&self, invite: &str) -> Body {
        Body::InviteRevoke {
            invite: invite.into(),
        }
    }
    fn channel(&self, team: &str) -> Body {
        Body::ChannelCreate {
            channel: rand_hex16(),
            team: team.into(),
            name: "tim-desain".into(),
        }
    }
    fn profile(&self, name: &str) -> Body {
        Body::ProfileSet { name: name.into() }
    }
}

/// Founder, team A with admin `admin_a` and member `member_a`, team B with
/// admin `admin_b`, a guest, and someone outside the organization.
struct World {
    sim: Sim,
    f: Actor,
    team_a: String,
    team_b: String,
    admin_a: Actor,
    member_a: Actor,
    admin_b: Actor,
    guest: Actor,
    stranger: Actor,
}

fn world() -> World {
    let mut sim = Sim::new();
    let f = sim.founder();
    let team_a = sim.team("Tim A");
    let team_b = sim.team("Tim B");
    let admin_a = sim.join(&team_a, InviteRole::TeamAdmin, "Admin A");
    let member_a = sim.join(&team_a, InviteRole::Member, "Anggota A");
    let admin_b = sim.join(&team_b, InviteRole::TeamAdmin, "Admin B");
    let guest = sim.join(&team_a, InviteRole::Guest, "Tamu");
    World {
        sim,
        f,
        team_a,
        team_b,
        admin_a,
        member_a,
        admin_b,
        guest,
        stranger: Actor::new(),
    }
}

#[test]
fn genesis_state() {
    let sim = Sim::new();
    let s = sim.state();
    assert!(s.is_superadmin(&sim.founder.pk));
    assert_eq!(s.superadmin_count(), 1);
    assert_eq!(s.org_role(&sim.founder.pk), Role::Superadmin);
    let umum = umum_channel_id(&sim.org.id);
    assert_eq!(umum.len(), 32);
    let expected = blake3::hash(format!("mira-channel-umum-v1\n{}", sim.org.id).as_bytes());
    assert_eq!(umum, expected.to_hex()[..32]);
    assert_eq!(s.channels[&umum].name, "umum");
    assert_eq!(s.channels[&umum].team, None);
}

#[test]
fn world_roles_are_derived() {
    let w = world();
    let s = w.sim.state();
    assert_eq!(s.org_role(&w.f.pk), Role::Superadmin);
    assert_eq!(s.org_role(&w.admin_a.pk), Role::TeamAdmin);
    assert_eq!(s.org_role(&w.member_a.pk), Role::Member);
    assert_eq!(s.org_role(&w.guest.pk), Role::Guest);
    assert_eq!(s.team_role(&w.team_a, &w.admin_a.pk), Some(TeamRole::Admin));
    assert_eq!(
        s.team_role(&w.team_a, &w.member_a.pk),
        Some(TeamRole::Member)
    );
    assert_eq!(
        s.team_role(&w.team_a, &w.guest.pk),
        None,
        "guests are not team members"
    );
    assert_eq!(s.member(&w.guest.pk).unwrap().kind, MemberKind::Guest);
    let access: Vec<&GuestAccess> = s.guest_access.iter().collect();
    assert_eq!(access.len(), 2);
    assert!(
        access
            .iter()
            .all(|g| g.public_key == w.guest.pk && g.team == w.team_a)
    );
    assert_eq!(
        s.member(&w.member_a.pk).unwrap().display_name.as_deref(),
        Some("Anggota A")
    );
}

#[test]
fn profile_set_row() {
    let mut w = world();
    let b = bodies();
    assert_eq!(w.sim.push(&w.member_a, b.profile("Budi")), Ok(()));
    assert_eq!(w.sim.push(&w.guest, b.profile("Tamu Baru")), Ok(()));
    assert_eq!(
        w.sim.push(&w.stranger, b.profile("Asing")),
        Err(R::AuthorNotActive)
    );
    let s = w.sim.state();
    assert_eq!(
        s.member(&w.member_a.pk).unwrap().display_name.as_deref(),
        Some("Budi")
    );
    assert!(s.member(&w.member_a.pk).unwrap().has_profile);
    assert!(s.member(&w.stranger.pk).is_none());
}

#[test]
fn team_create_row() {
    let mut w = world();
    let b = bodies();
    let id = rand_hex16();
    assert_eq!(
        w.sim.push(&w.admin_a, b.team_create(&id)),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&w.member_a, b.team_create(&id)),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&w.guest, b.team_create(&id)),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&w.stranger, b.team_create(&id)),
        Err(R::AuthorNotActive)
    );
    assert_eq!(w.sim.push(&w.f, b.team_create(&id)), Ok(()));
    assert_eq!(w.sim.push(&w.f, b.team_create(&id)), Err(R::IdInUse));
    assert_eq!(w.sim.push(&w.f, b.team_delete(&id)), Ok(()));
    assert_eq!(
        w.sim.push(&w.f, b.team_create(&id)),
        Err(R::IdInUse),
        "ids are never reused"
    );
    let team = &w.sim.state().teams[&id];
    assert_eq!(team.created_by, w.f.pk);
    assert!(team.members.is_empty());
}

#[test]
fn team_delete_row_and_effects() {
    let mut w = world();
    let b = bodies();
    assert_eq!(w.sim.push(&w.f, b.channel(&w.team_a)), Ok(()));
    let pending = w.sim.invite(&w.f, &w.team_a, InviteRole::Member, false);
    assert_eq!(pending.outcome, Ok(()));

    assert_eq!(
        w.sim.push(&w.admin_a, b.team_delete(&w.team_a)),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&w.member_a, b.team_delete(&w.team_a)),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&w.f, b.team_delete(&rand_hex16())),
        Err(R::TeamNotFound)
    );
    assert_eq!(w.sim.push(&w.f, b.team_delete(&w.team_a)), Ok(()));
    assert_eq!(
        w.sim.push(&w.f, b.team_delete(&w.team_a)),
        Err(R::TeamNotFound)
    );

    let s = w.sim.state();
    assert!(s.live_team(&w.team_a).is_none());
    assert!(s.teams[&w.team_a].deleted);
    assert!(s.teams[&w.team_a].members.is_empty());
    assert_eq!(
        s.org_role(&w.admin_a.pk),
        Role::Member,
        "no longer admin anywhere"
    );
    assert!(
        s.channels
            .values()
            .all(|c| c.team.as_deref() != Some(w.team_a.as_str()))
    );
    assert!(s.guest_access.is_empty());
    assert!(
        s.is_active(&w.member_a.pk),
        "deleting a team keeps the members in the org"
    );

    // Deleted team invalidates its invites.
    let x = Actor::new();
    assert_eq!(
        w.sim.accept(&w.f, &pending, &x, "Baru"),
        Err(R::TeamNotFound)
    );
    // And nothing can be added to it.
    assert_eq!(
        w.sim.push(&w.f, b.tm_add(&w.team_a, &w.member_a)),
        Err(R::TeamNotFound)
    );
    assert_eq!(w.sim.push(&w.f, b.channel(&w.team_a)), Err(R::TeamNotFound));
}

#[test]
fn superadmin_add_row() {
    let mut w = world();
    let b = bodies();
    assert_eq!(
        w.sim.push(&w.admin_a, b.sa_add(&w.member_a)),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&w.member_a, b.sa_add(&w.member_a)),
        Err(R::NotAuthorized)
    );
    assert_eq!(w.sim.push(&w.f, b.sa_add(&w.guest)), Err(R::TargetIsGuest));
    assert_eq!(
        w.sim.push(&w.f, b.sa_add(&w.stranger)),
        Err(R::TargetNotActive)
    );
    assert_eq!(w.sim.push(&w.f, b.sa_add(&w.f)), Err(R::AlreadySuperadmin));
    assert_eq!(w.sim.push(&w.f, b.sa_add(&w.member_a)), Ok(()));
    assert_eq!(
        w.sim.push(&w.f, b.sa_add(&w.member_a)),
        Err(R::AlreadySuperadmin)
    );
    // The new superadmin has full rights.
    assert_eq!(w.sim.push(&w.member_a, b.sa_add(&w.admin_b)), Ok(()));
    let s = w.sim.state();
    assert_eq!(s.superadmin_count(), 3);
    assert_eq!(s.org_role(&w.member_a.pk), Role::Superadmin);

    assert_eq!(w.sim.push(&w.f, b.remove(&w.admin_a)), Ok(()));
    assert_eq!(
        w.sim.push(&w.f, b.sa_add(&w.admin_a)),
        Err(R::TargetNotActive)
    );
}

#[test]
fn superadmin_remove_row_and_last_superadmin() {
    let mut w = world();
    let b = bodies();
    assert_eq!(w.sim.push(&w.f, b.sa_remove(&w.f)), Err(R::LastSuperadmin));
    assert_eq!(
        w.sim.push(&w.f, b.sa_remove(&w.member_a)),
        Err(R::NotSuperadmin)
    );
    assert_eq!(w.sim.push(&w.f, b.sa_add(&w.member_a)), Ok(()));
    assert_eq!(
        w.sim.push(&w.admin_a, b.sa_remove(&w.member_a)),
        Err(R::NotAuthorized)
    );
    assert_eq!(w.sim.push(&w.member_a, b.sa_remove(&w.f)), Ok(()));
    assert!(!w.sim.state().is_superadmin(&w.f.pk));
    assert_eq!(
        w.sim.push(&w.member_a, b.sa_remove(&w.member_a)),
        Err(R::LastSuperadmin)
    );
    assert_eq!(
        w.sim.push(&w.f, b.sa_add(&w.f)),
        Err(R::NotAuthorized),
        "no longer superadmin"
    );
    assert_eq!(w.sim.state().superadmin_count(), 1);
}

#[test]
fn team_admin_set_row() {
    let mut w = world();
    let b = bodies();
    assert_eq!(
        w.sim.push(&w.admin_a, b.admin_set(&w.team_a, &w.member_a)),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&w.member_a, b.admin_set(&w.team_a, &w.member_a)),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&w.f, b.admin_set(&w.team_a, &w.guest)),
        Err(R::TargetIsGuest)
    );
    assert_eq!(
        w.sim.push(&w.f, b.admin_set(&w.team_a, &w.stranger)),
        Err(R::TargetNotActive)
    );
    assert_eq!(
        w.sim.push(&w.f, b.admin_set(&rand_hex16(), &w.member_a)),
        Err(R::TeamNotFound)
    );
    assert_eq!(
        w.sim.push(&w.f, b.admin_set(&w.team_a, &w.admin_a)),
        Err(R::AlreadyTeamAdmin)
    );
    assert_eq!(
        w.sim.push(&w.f, b.admin_set(&w.team_a, &w.member_a)),
        Ok(())
    );
    // v0.3: one department per person, so not admin of team B too.
    assert_eq!(
        w.sim.push(&w.f, b.admin_set(&w.team_b, &w.member_a)),
        Err(R::AlreadyInDepartment)
    );
    let s = w.sim.state();
    assert_eq!(
        s.team_role(&w.team_a, &w.member_a.pk),
        Some(TeamRole::Admin)
    );
    assert_eq!(s.team_role(&w.team_b, &w.member_a.pk), None);
    assert_eq!(s.org_role(&w.member_a.pk), Role::TeamAdmin);
}

#[test]
fn team_admin_unset_row() {
    let mut w = world();
    let b = bodies();
    assert_eq!(
        w.sim.push(&w.admin_a, b.admin_unset(&w.team_a, &w.admin_a)),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&w.admin_b, b.admin_unset(&w.team_a, &w.admin_a)),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&w.f, b.admin_unset(&w.team_a, &w.member_a)),
        Err(R::NotTeamAdmin)
    );
    assert_eq!(
        w.sim.push(&w.f, b.admin_unset(&w.team_b, &w.admin_a)),
        Err(R::NotTeamAdmin)
    );
    assert_eq!(
        w.sim.push(&w.f, b.admin_unset(&w.team_a, &w.admin_a)),
        Ok(())
    );
    let s = w.sim.state();
    assert_eq!(
        s.team_role(&w.team_a, &w.admin_a.pk),
        Some(TeamRole::Member)
    );
    assert_eq!(s.org_role(&w.admin_a.pk), Role::Member);
}

#[test]
fn team_member_add_row() {
    let mut w = world();
    let b = bodies();
    let c = w.sim.join(&w.team_b.clone(), InviteRole::Member, "Citra");
    // v0.3: only people without a department can be added.
    assert_eq!(
        w.sim.push(&w.admin_a, b.tm_add(&w.team_a, &c)),
        Err(R::AlreadyInDepartment)
    );
    assert_eq!(
        w.sim.push(&w.f, b.tm_add(&w.team_b, &w.member_a)),
        Err(R::AlreadyInDepartment)
    );
    assert_eq!(w.sim.push(&w.f, b.tm_remove(&w.team_b, &c)), Ok(()));
    assert_eq!(
        w.sim.push(&w.member_a, b.tm_add(&w.team_a, &c)),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&w.admin_b, b.tm_add(&w.team_a, &c)),
        Err(R::NotAuthorized),
        "admin of another team"
    );
    assert_eq!(
        w.sim.push(&w.guest, b.tm_add(&w.team_a, &c)),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&w.admin_a, b.tm_add(&w.team_a, &w.guest)),
        Err(R::TargetIsGuest)
    );
    assert_eq!(
        w.sim.push(&w.admin_a, b.tm_add(&w.team_a, &w.stranger)),
        Err(R::TargetNotActive)
    );
    assert_eq!(
        w.sim.push(&w.admin_a, b.tm_add(&w.team_a, &w.member_a)),
        Err(R::AlreadyInTeam)
    );
    assert_eq!(
        w.sim.push(&w.admin_a, b.tm_add(&rand_hex16(), &c)),
        Err(R::TeamNotFound)
    );
    assert_eq!(
        w.sim.push(&w.admin_a, b.tm_add(&w.team_a, &c)),
        Ok(()),
        "team admin"
    );
    let d = w.sim.join(&w.team_b.clone(), InviteRole::Member, "Dedi");
    assert_eq!(w.sim.push(&d, b.tm_remove(&w.team_b, &d)), Ok(()), "left");
    assert_eq!(w.sim.push(&w.f, b.tm_add(&w.team_b, &d)), Ok(()), "superadmin");
    let s = w.sim.state();
    assert_eq!(s.team_role(&w.team_a, &c.pk), Some(TeamRole::Member));
    assert_eq!(s.team_role(&w.team_b, &c.pk), None);
    assert_eq!(s.team_role(&w.team_b, &d.pk), Some(TeamRole::Member));
}

#[test]
fn team_member_remove_row() {
    let mut w = world();
    let b = bodies();
    let c = w.sim.join(&w.team_a.clone(), InviteRole::Member, "Citra");
    let d = w.sim.join(&w.team_a.clone(), InviteRole::Member, "Dedi");
    let admin2 = w
        .sim
        .join(&w.team_a.clone(), InviteRole::TeamAdmin, "Admin Dua");
    assert_eq!(
        w.sim.push(&w.member_a, b.tm_remove(&w.team_a, &c)),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&w.admin_b, b.tm_remove(&w.team_a, &c)),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&w.admin_a, b.tm_remove(&w.team_a, &admin2)),
        Err(R::NotAuthorized),
        "admin cannot remove admin"
    );
    assert_eq!(
        w.sim.push(&w.admin_a, b.tm_remove(&w.team_a, &w.admin_b)),
        Err(R::NotInTeam)
    );
    assert_eq!(
        w.sim.push(&w.admin_a, b.tm_remove(&w.team_a, &c)),
        Ok(()),
        "admin removes member"
    );
    assert_eq!(
        w.sim.push(&w.f, b.tm_remove(&w.team_a, &admin2)),
        Ok(()),
        "superadmin removes admin"
    );
    assert_eq!(
        w.sim.push(&d, b.tm_remove(&w.team_a, &d)),
        Ok(()),
        "leaving the team"
    );
    assert_eq!(
        w.sim.push(&w.admin_a, b.tm_remove(&w.team_a, &w.admin_a)),
        Ok(()),
        "admin leaves"
    );
    let s = w.sim.state();
    for gone in [&c, &d, &admin2, &w.admin_a] {
        assert_eq!(s.team_role(&w.team_a, &gone.pk), None);
        assert!(s.is_active(&gone.pk));
    }
}

#[test]
fn member_remove_row_and_effects() {
    let mut w = world();
    let b = bodies();
    assert_eq!(
        w.sim.push(&w.admin_a, b.remove(&w.member_a)),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&w.member_a, b.remove(&w.member_a)),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&w.f, b.remove(&w.stranger)),
        Err(R::TargetNotActive)
    );
    assert_eq!(w.sim.push(&w.f, b.remove(&w.f)), Err(R::LastSuperadmin));
    assert_eq!(w.sim.push(&w.f, b.sa_add(&w.admin_a)), Ok(()));
    assert_eq!(w.sim.push(&w.f, b.remove(&w.guest)), Ok(()));
    assert_eq!(
        w.sim.push(&w.admin_a, b.remove(&w.f)),
        Ok(()),
        "superadmin removes another superadmin"
    );
    assert_eq!(
        w.sim.push(&w.admin_a, b.remove(&w.admin_a)),
        Err(R::LastSuperadmin)
    );
    assert_eq!(
        w.sim.push(&w.admin_a, b.remove(&w.f)),
        Err(R::TargetNotActive)
    );

    let s = w.sim.state();
    let f = s.member(&w.f.pk).unwrap();
    assert_eq!(f.status, MemberStatus::Removed);
    assert!(!f.is_superadmin);
    assert!(f.removal_op.is_some());
    assert!(s.teams_of(&w.f.pk).is_empty());
    assert!(
        s.guest_access.is_empty(),
        "guest access removed with the guest"
    );
    assert_eq!(s.superadmin_count(), 1);
}

#[test]
fn removed_member_ops_are_rejected() {
    let mut w = world();
    let b = bodies();
    assert_eq!(w.sim.push(&w.f, b.sa_add(&w.admin_a)), Ok(()));
    assert_eq!(w.sim.push(&w.f, b.remove(&w.admin_a)), Ok(()));
    let s = w.sim.state();
    assert_eq!(s.team_role(&w.team_a, &w.admin_a.pk), None);
    assert!(!s.is_superadmin(&w.admin_a.pk));
    for body in [
        b.profile("Masih Ada"),
        b.team_create(&rand_hex16()),
        b.tm_add(&w.team_a, &w.member_a),
        b.remove(&w.f),
        b.channel(&w.team_a),
    ] {
        assert_eq!(w.sim.push(&w.admin_a, body), Err(R::AuthorNotActive));
    }
    let inv = w
        .sim
        .invite(&w.admin_a, &w.team_a, InviteRole::Member, false);
    assert_eq!(inv.outcome, Err(R::AuthorNotActive));
    // A removed key cannot come back through an invite.
    let inv = w.sim.invite(&w.f, &w.team_a, InviteRole::Member, false);
    let admin_a = Actor {
        sk: w.admin_a.sk.clone(),
        pk: w.admin_a.pk.clone(),
    };
    assert_eq!(
        w.sim.accept(&w.f, &inv, &admin_a, "Kembali"),
        Err(R::MemberRemoved)
    );
}

#[test]
fn invite_create_row() {
    let mut w = world();
    let (f, admin_a, admin_b, member_a, guest) = (
        w.sim.founder(),
        &w.admin_a,
        &w.admin_b,
        &w.member_a,
        &w.guest,
    );
    for role in [InviteRole::TeamAdmin, InviteRole::Member, InviteRole::Guest] {
        assert_eq!(
            w.sim.invite(&f, &w.team_a, role, false).outcome,
            Ok(()),
            "superadmin {role:?}"
        );
    }
    assert_eq!(
        w.sim
            .invite(admin_a, &w.team_a, InviteRole::Member, false)
            .outcome,
        Ok(())
    );
    assert_eq!(
        w.sim
            .invite(admin_a, &w.team_a, InviteRole::Guest, true)
            .outcome,
        Ok(())
    );
    assert_eq!(
        w.sim
            .invite(admin_a, &w.team_a, InviteRole::TeamAdmin, false)
            .outcome,
        Err(R::NotAuthorized),
        "team admin cannot invite admins"
    );
    assert_eq!(
        w.sim
            .invite(admin_b, &w.team_a, InviteRole::Member, false)
            .outcome,
        Err(R::NotAuthorized),
        "admin of another team"
    );
    assert_eq!(
        w.sim
            .invite(member_a, &w.team_a, InviteRole::Member, false)
            .outcome,
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim
            .invite(guest, &w.team_a, InviteRole::Member, false)
            .outcome,
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim
            .invite(&f, &rand_hex16(), InviteRole::Member, false)
            .outcome,
        Err(R::TeamNotFound)
    );

    let code = new_code();
    let (id, body) = w
        .sim
        .invite_body(&f, &w.team_a, InviteRole::Member, false, 24, &code);
    assert_eq!(w.sim.push(&f, body.clone()), Ok(()));
    assert_eq!(w.sim.push(&f, body), Err(R::IdInUse));
    let inv = &w.sim.state().invites[&id];
    assert_eq!(inv.created_by, f.pk);
    assert_eq!(inv.tag, code.tag());
}

#[test]
fn invite_revoke_row() {
    let mut w = world();
    let b = bodies();
    let f = w.sim.founder();
    let by_admin = w
        .sim
        .invite(&w.admin_a, &w.team_a, InviteRole::Member, false);
    let by_f1 = w.sim.invite(&f, &w.team_a, InviteRole::Member, false);
    let by_f2 = w.sim.invite(&f, &w.team_a, InviteRole::Member, false);
    let by_f3 = w.sim.invite(&f, &w.team_b, InviteRole::Member, false);
    assert_eq!(
        w.sim.push(&w.member_a, b.revoke(&by_f1.id)),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&w.admin_b, b.revoke(&by_f1.id)),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&w.f, b.revoke(&rand_hex16())),
        Err(R::InviteNotFound)
    );
    assert_eq!(
        w.sim.push(&w.admin_a, b.revoke(&by_admin.id)),
        Ok(()),
        "creator"
    );
    assert_eq!(
        w.sim.push(&w.admin_a, b.revoke(&by_f1.id)),
        Ok(()),
        "admin of the invite's team"
    );
    assert_eq!(w.sim.push(&w.f, b.revoke(&by_f2.id)), Ok(()), "superadmin");
    assert_eq!(w.sim.push(&w.f, b.revoke(&by_f2.id)), Err(R::InviteRevoked));
    assert_eq!(w.sim.push(&w.admin_b, b.revoke(&by_f3.id)), Ok(()));
    let x = Actor::new();
    assert_eq!(w.sim.accept(&f, &by_f1, &x, "Baru"), Err(R::InviteRevoked));
}

#[test]
fn channel_create_row() {
    let mut w = world();
    let b = bodies();
    assert_eq!(
        w.sim.push(&w.f, b.channel(&w.team_b)),
        Ok(()),
        "superadmin outside the team"
    );
    assert_eq!(
        w.sim.push(&w.member_a, b.channel(&w.team_a)),
        Ok(()),
        "team member"
    );
    assert_eq!(
        w.sim.push(&w.admin_a, b.channel(&w.team_a)),
        Ok(()),
        "team admin"
    );
    assert_eq!(
        w.sim.push(&w.member_a, b.channel(&w.team_b)),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&w.guest, b.channel(&w.team_a)),
        Err(R::NotAuthorized)
    );
    assert_eq!(
        w.sim.push(&w.f, b.channel(&rand_hex16())),
        Err(R::TeamNotFound)
    );
    let id = rand_hex16();
    let ch = |id: &str| Body::ChannelCreate {
        channel: id.into(),
        team: w.team_a.clone(),
        name: "dua".into(),
    };
    assert_eq!(w.sim.push(&w.f, ch(&id)), Ok(()));
    assert_eq!(w.sim.push(&w.f, ch(&id)), Err(R::IdInUse));
    let umum = umum_channel_id(&w.sim.org.id);
    assert_eq!(w.sim.push(&w.f, ch(&umum)), Err(R::IdInUse));
    assert_eq!(w.sim.state().channels.len(), 5);
}

// --- Trust chain (TDD list) ---

#[test]
fn trust_chain_superadmin_appoints_admin_who_invites_a_member() {
    let mut sim = Sim::new();
    let f = sim.founder();
    let team = sim.team("Tim Desain");
    let b = bodies();
    let ani = sim.join(&team, InviteRole::Member, "Ani");
    assert_eq!(sim.push(&f, b.admin_set(&team, &ani)), Ok(()));
    let inv = sim.invite(&ani, &team, InviteRole::Member, true);
    assert_eq!(inv.outcome, Ok(()));
    let budi = Actor::new();
    // Any active non-guest member may check the code, also the team admin.
    assert_eq!(sim.accept(&ani, &inv, &budi, "Budi"), Ok(()));
    let s = sim.state();
    assert_eq!(s.team_role(&team, &budi.pk), Some(TeamRole::Member));
    assert_eq!(s.org_role(&budi.pk), Role::Member);
    assert_eq!(s.invites[&inv.id].used_by, vec![budi.pk.clone()]);
}

#[test]
fn trust_chain_demoted_or_removed_inviter_invites_die() {
    let mut w = world();
    let b = bodies();
    let f = w.sim.founder();
    let inv1 = w
        .sim
        .invite(&w.admin_a, &w.team_a, InviteRole::Member, false);
    assert_eq!(inv1.outcome, Ok(()));
    assert_eq!(w.sim.push(&f, b.admin_unset(&w.team_a, &w.admin_a)), Ok(()));
    let x = Actor::new();
    assert_eq!(
        w.sim.accept(&f, &inv1, &x, "Xena"),
        Err(R::InviterNotAuthorized)
    );

    // Admin again: the invite works again (authority checked at accept time).
    assert_eq!(w.sim.push(&f, b.admin_set(&w.team_a, &w.admin_a)), Ok(()));
    assert_eq!(w.sim.accept(&f, &inv1, &x, "Xena"), Ok(()));

    let inv2 = w
        .sim
        .invite(&w.admin_a, &w.team_a, InviteRole::Member, false);
    assert_eq!(w.sim.push(&f, b.remove(&w.admin_a)), Ok(()));
    let y = Actor::new();
    assert_eq!(
        w.sim.accept(&f, &inv2, &y, "Yudi"),
        Err(R::InviterNotAuthorized)
    );
    // Superadmin inviter demoted to plain member.
    let s2 = w
        .sim
        .join(&w.team_a.clone(), InviteRole::Member, "Super Dua");
    assert_eq!(w.sim.push(&f, b.sa_add(&s2)), Ok(()));
    let inv3 = w.sim.invite(&s2, &w.team_b, InviteRole::TeamAdmin, false);
    assert_eq!(inv3.outcome, Ok(()));
    assert_eq!(w.sim.push(&f, b.sa_remove(&s2)), Ok(()));
    let z = Actor::new();
    assert_eq!(
        w.sim.accept(&f, &inv3, &z, "Zaki"),
        Err(R::InviterNotAuthorized)
    );
}

// --- Invites (plan 1.3) ---

#[test]
fn invite_expiry_uses_op_time() {
    let mut sim = Sim::new();
    let f = sim.founder();
    let team = sim.team("Tim A");
    let inv = sim.invite(&f, &team, InviteRole::Member, false);
    let x = Actor::new();
    sim.now += time::Duration::hours(24);
    assert_eq!(
        sim.accept(&f, &inv, &x, "Pas"),
        Ok(()),
        "at == expires is still valid"
    );
    sim.now += time::Duration::seconds(1);
    let y = Actor::new();
    assert_eq!(sim.accept(&f, &inv, &y, "Telat"), Err(R::InviteExpired));
    // Before the invite existed (beyond clock slack).
    sim.now -= time::Duration::hours(25);
    let z = Actor::new();
    assert_eq!(sim.accept(&f, &inv, &z, "Awal"), Err(R::InviteNotYetValid));
}

#[test]
fn reusable_invite_admits_several_people() {
    let mut sim = Sim::new();
    let f = sim.founder();
    let team = sim.team("Tim A");
    let inv = sim.invite(&f, &team, InviteRole::Member, false);
    for name in ["Satu", "Dua", "Tiga"] {
        let x = Actor::new();
        assert_eq!(sim.accept(&f, &inv, &x, name), Ok(()));
    }
    assert_eq!(sim.state().invites[&inv.id].used_by.len(), 3);
}

#[test]
fn single_use_second_accept_is_rejected() {
    let mut sim = Sim::new();
    let f = sim.founder();
    let team = sim.team("Tim A");
    let inv = sim.invite(&f, &team, InviteRole::Member, true);
    let (x, y) = (Actor::new(), Actor::new());
    assert_eq!(sim.accept(&f, &inv, &x, "Xena"), Ok(()));
    assert_eq!(sim.accept(&f, &inv, &y, "Yudi"), Err(R::InviteUsed));
    let s = sim.state();
    assert!(s.is_active(&x.pk));
    assert!(!s.is_active(&y.pk));
}

#[test]
fn concurrent_single_use_accepts_resolve_the_same_way_in_any_order() {
    let mut sim = Sim::new();
    let f = sim.founder();
    let team = sim.team("Tim A");
    let a = sim.join(&team, InviteRole::Member, "Ani");
    let inv = sim.invite(&f, &team, InviteRole::Member, true);
    let (x, y) = (Actor::new(), Actor::new());
    // Laptops F and A each accept a different person with the same lamport.
    let lamport = sim.lamport + 1;
    let by_f = sim.make_at(&f, lamport, sim.accept_body(&inv, &x, "Xena"));
    let by_a = sim.make_at(&a, lamport, sim.accept_body(&inv, &y, "Yudi"));

    let base = sim.ops.clone();
    let mut order1 = base.clone();
    order1.extend([by_f.clone(), by_a.clone()]);
    let mut order2 = base;
    order2.extend([by_a.clone(), by_f.clone()]);
    order2.reverse();
    let r1 = fold(&sim.org, &order1);
    let r2 = fold(&sim.org, &order2);
    assert_eq!(r1.state, r2.state);
    assert_eq!(r1.outcomes, r2.outcomes);

    let winner_is_f = (f.pk.as_str(), by_f.id.as_str()) < (a.pk.as_str(), by_a.id.as_str());
    let (winner, loser) = if winner_is_f { (&x, &y) } else { (&y, &x) };
    assert!(r1.state.is_active(&winner.pk));
    assert!(!r1.state.is_active(&loser.pk));
    let rejected: Vec<_> = r1.outcomes.iter().filter(|(_, o)| o.is_err()).collect();
    assert_eq!(rejected.len(), 1);
    assert_eq!(rejected[0].1, Err(R::InviteUsed));
}

#[test]
fn wrong_code_or_tampered_proof_is_rejected() {
    let mut sim = Sim::new();
    let f = sim.founder();
    let team = sim.team("Tim A");
    let inv = sim.invite(&f, &team, InviteRole::Member, false);
    let x = Actor::new();

    // Proof made with another code: invite key signature is wrong.
    let wrong = Invite {
        id: inv.id.clone(),
        code: new_code(),
        outcome: Ok(()),
    };
    assert_eq!(
        sim.accept(&f, &wrong, &x, "Xena"),
        Err(R::BadInviteSignature)
    );

    // Name changed after signing.
    let mut body = sim.accept_body(&inv, &x, "Xena");
    if let Body::InviteAccept { name, .. } = &mut body {
        *name = "Ratu".into();
    }
    assert_eq!(sim.push(&f, body), Err(R::BadInviteSignature));

    // Member key swapped: the invite signature no longer matches either.
    let y = Actor::new();
    let mut body = sim.accept_body(&inv, &x, "Xena");
    if let Body::InviteAccept { member, .. } = &mut body {
        *member = y.pk.clone();
    }
    assert_eq!(sim.push(&f, body), Err(R::BadInviteSignature));

    // Member signature by somebody else.
    let mut body = sim.accept_body(&inv, &x, "Xena");
    let forged = sim.accept_body(&inv, &y, "Xena");
    if let (
        Body::InviteAccept { member_sig, .. },
        Body::InviteAccept {
            member_sig: other, ..
        },
    ) = (&mut body, &forged)
    {
        *member_sig = other.clone();
    }
    assert_eq!(sim.push(&f, body), Err(R::BadMemberSignature));

    // Unknown invite.
    let ghost = Invite {
        id: rand_hex16(),
        code: inv.code.clone(),
        outcome: Ok(()),
    };
    assert_eq!(sim.accept(&f, &ghost, &x, "Xena"), Err(R::InviteNotFound));
    assert!(!sim.state().is_active(&x.pk));
    assert_eq!(sim.accept(&f, &inv, &x, "Xena"), Ok(()));
}

#[test]
fn guests_cannot_check_codes_and_join_without_teams() {
    let mut w = world();
    let f = w.sim.founder();
    let inv = w.sim.invite(&f, &w.team_a, InviteRole::Member, false);
    let x = Actor::new();
    assert_eq!(
        w.sim.accept(&w.guest, &inv, &x, "Xena"),
        Err(R::GuestNotAllowed)
    );
    assert_eq!(
        w.sim.accept(&w.stranger, &inv, &x, "Xena"),
        Err(R::AuthorNotActive)
    );
    assert_eq!(w.sim.accept(&w.member_a, &inv, &x, "Xena"), Ok(()));

    let g = w
        .sim
        .invite(&w.admin_a, &w.team_a, InviteRole::Guest, false);
    let y = Actor::new();
    assert_eq!(w.sim.accept(&w.admin_a, &g, &y, "Yuni"), Ok(()));
    let s = w.sim.state();
    assert_eq!(s.member(&y.pk).unwrap().kind, MemberKind::Guest);
    assert!(s.teams_of(&y.pk).is_empty());
    assert_eq!(
        s.guest_access
            .iter()
            .filter(|a| a.public_key == y.pk)
            .count(),
        2
    );
}

#[test]
fn existing_members_redeem_for_other_teams_and_higher_roles() {
    let mut w = world();
    let f = w.sim.founder();
    let member_a = Actor {
        sk: w.member_a.sk.clone(),
        pk: w.member_a.pk.clone(),
    };
    // v0.3: an invite to another department does not add a second one.
    let inv_b = w.sim.invite(&f, &w.team_b, InviteRole::Member, true);
    assert_eq!(
        w.sim.accept(&member_a, &inv_b, &member_a, "Anggota A"),
        Err(R::AlreadyInDepartment)
    );
    let s = w.sim.state();
    assert_eq!(s.team_role(&w.team_b, &member_a.pk), None);
    assert_eq!(s.team_role(&w.team_a, &member_a.pk), Some(TeamRole::Member));
    assert_eq!(
        s.member(&member_a.pk).unwrap().display_name.as_deref(),
        Some("Anggota A")
    );

    let raise = w.sim.invite(&f, &w.team_a, InviteRole::TeamAdmin, true);
    assert_eq!(
        w.sim.accept(&member_a, &raise, &member_a, "Anggota A"),
        Ok(())
    );
    assert_eq!(
        w.sim.state().team_role(&w.team_a, &member_a.pk),
        Some(TeamRole::Admin)
    );

    // A member invite does not demote an admin.
    let plain = w.sim.invite(&f, &w.team_a, InviteRole::Member, false);
    assert!(
        !w.sim
            .state()
            .accept_changes_anything(&w.sim.state().invites[&plain.id], &member_a.pk)
    );
    assert_eq!(
        w.sim.accept(&member_a, &plain, &member_a, "Anggota A"),
        Ok(())
    );
    assert_eq!(
        w.sim.state().team_role(&w.team_a, &member_a.pk),
        Some(TeamRole::Admin)
    );

    // A guest promoted by a member invite.
    let guest = Actor {
        sk: w.guest.sk.clone(),
        pk: w.guest.pk.clone(),
    };
    let up = w.sim.invite(&f, &w.team_b, InviteRole::Member, true);
    assert_eq!(w.sim.accept(&f, &up, &guest, "Tamu"), Ok(()));
    let s = w.sim.state();
    assert_eq!(s.member(&guest.pk).unwrap().kind, MemberKind::Member);
    assert_eq!(s.org_role(&guest.pk), Role::Member);
    assert_eq!(s.team_role(&w.team_b, &guest.pk), Some(TeamRole::Member));
}

// --- Ordering ---

#[test]
fn late_arrival_makes_a_rejected_op_valid() {
    let sim = Sim::new();
    let f = sim.founder();
    let team = rand_hex16();
    let create = sim.make_at(&f, 1, bodies().team_create(&team));
    let channel = sim.make_at(&f, 2, bodies().channel(&team));
    let early = fold(&sim.org, std::slice::from_ref(&channel));
    assert_eq!(early.outcomes[0].1, Err(R::TeamNotFound));
    let both = fold(&sim.org, &[channel.clone(), create.clone()]);
    assert!(both.outcomes.iter().all(|(_, o)| o.is_ok()));
    assert_eq!(
        both.outcomes[0].0, create.id,
        "sorted by lamport, not arrival"
    );
}

#[test]
fn fold_order_is_lamport_then_author_then_id_and_duplicates_count_once() {
    let mut sim = Sim::new();
    let f = sim.founder();
    let team = sim.team("Tim A");
    let a = sim.join(&team, InviteRole::Member, "Ani");
    let b = bodies();
    // Concurrent: F promotes A to superadmin while A (not yet superadmin)
    // tries to create a team with the same lamport. A's op is ordered by key.
    let l = sim.lamport + 1;
    let promote = sim.make_at(&f, l, b.sa_add(&a));
    let create = sim.make_at(&a, l, b.team_create(&rand_hex16()));
    let mut ops = sim.ops.clone();
    ops.extend([create.clone(), promote.clone(), promote.clone()]);
    let r = fold(&sim.org, &ops);
    assert_eq!(r.outcomes.len(), sim.ops.len() + 2);
    let outcome = |id: &str| r.outcomes.iter().find(|(i, _)| i == id).unwrap().1;
    if f.pk < a.pk {
        assert_eq!(outcome(&create.id), Ok(()));
    } else {
        assert_eq!(outcome(&create.id), Err(R::NotAuthorized));
    }
    assert_eq!(outcome(&promote.id), Ok(()));
}
