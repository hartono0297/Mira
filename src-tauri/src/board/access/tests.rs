use rusqlite::params;

use super::*;
use crate::board::testutil::org_ops;
use crate::board::testutil::{Laptop, add_member, add_team};
use crate::permissions::{self as p, InviteRole};

fn pk(n: u8) -> String {
    format!("{n:02x}").repeat(32)
}

fn proj<'a>(id: &'a str, team: Option<&'a str>, creator: &'a str) -> ProjectRef<'a> {
    ProjectRef {
        id,
        team_id: team,
        created_by: creator,
    }
}

fn add_guest(l: &Laptop, who: &str, team: &str, project: &str) {
    l.conn
        .execute(
            "INSERT INTO guest_access (public_key, team_id, project_id) VALUES (?1, ?2, ?3)",
            params![who, team, project],
        )
        .unwrap();
}

#[test]
fn no_organization_means_no_rights() {
    let l = Laptop::bare("Sari");
    let r = Rights::load(&l.conn).unwrap();
    assert!(!r.has_org());
    assert!(!r.can_read(&l.pk(), proj("p", None, "x")));
}

#[test]
fn team_project_rules() {
    let l = Laptop::founder("Sari");
    let me = l.pk(); // superadmin, not in the team yet
    let (admin, member, outsider, guest, removed, guest_member) =
        (pk(1), pk(2), pk(3), pk(4), pk(5), pk(6));
    add_member(&l.conn, &admin, "Admin", "member");
    add_member(&l.conn, &member, "Budi", "member");
    add_member(&l.conn, &outsider, "Citra", "member");
    add_member(&l.conn, &guest, "Klien", "guest");
    add_member(&l.conn, &removed, "Lama", "removed");
    add_member(&l.conn, &guest_member, "Dewi", "member");
    let team = add_team(
        &l.conn,
        "Desain",
        &[(&admin, "admin"), (&member, "member"), (&removed, "member")],
    );
    let other = add_team(&l.conn, "Lain", &[(&outsider, "member")]);
    let pid = "ab".repeat(16);
    add_guest(&l, &guest, &team, &pid);
    add_guest(&l, &guest_member, &team, &pid);
    // Guest access granted through another team does not count.
    add_guest(&l, &outsider, &other, &pid);
    let r = Rights::load(&l.conn).unwrap();
    let p = proj(&pid, Some(&team), &admin);

    assert!(!r.can_read(&me, p), "superadmin outside the team");
    assert!(!r.can_create_project(&me, Some(&team)));
    assert!(r.can_read(&admin, p) && r.can_write(&admin, p));
    assert!(r.can_read(&member, p) && r.can_write(&member, p));
    assert!(!r.can_read(&outsider, p), "guest access from another team");
    assert!(r.can_read(&guest, p) && !r.can_write(&guest, p), "guest reads only");
    assert!(r.can_write(&guest_member, p), "member invited to the project");
    assert!(!r.can_read(&removed, p), "removed member");
    assert!(!r.can_read(&guest, proj(&"cd".repeat(16), Some(&team), &admin)), "other project");

    assert!(r.can_delete_task(&member, p, &member), "own task");
    assert!(!r.can_delete_task(&member, p, &admin), "someone else's task");
    assert!(r.can_delete_task(&admin, p, &member), "team admin");
    assert!(!r.can_delete_task(&guest, p, &guest));
    assert!(r.can_manage(&admin, p));
    assert!(!r.can_manage(&member, p));
    assert!(r.can_create_project(&admin, Some(&team)));
    assert!(!r.can_create_project(&admin, Some(&other)));
    assert!(!r.can_create_project(&member, Some(&team)));

    assert_eq!(r.readers(p), {
        let mut v = vec![admin.clone(), member.clone(), guest.clone(), guest_member.clone()];
        v.sort();
        v
    });
    assert!(!r.writers(p).contains(&guest));

    // After the superadmin joins the team, everything opens up for them.
    l.conn
        .execute(
            "INSERT INTO team_members (team_id, public_key, role, added_at) VALUES (?1, ?2, 'member', 't')",
            params![team, me],
        )
        .unwrap();
    let r = Rights::load(&l.conn).unwrap();
    assert!(r.can_read(&me, p) && r.can_manage(&me, p) && r.can_delete_task(&me, p, &member));
    assert!(r.can_create_project(&me, Some(&team)));
}

#[test]
fn project_without_team_is_for_every_member() {
    let l = Laptop::founder("Sari");
    let (member, guest) = (pk(1), pk(2));
    add_member(&l.conn, &member, "Budi", "member");
    add_member(&l.conn, &guest, "Klien", "guest");
    let r = Rights::load(&l.conn).unwrap();
    let founder = l.pk();
    let p = proj("p", None, &founder);
    assert!(r.can_write(&member, p));
    assert!(!r.can_read(&guest, p));
    assert!(!r.can_manage(&member, p));
    assert!(r.can_manage(&l.pk(), p));
    assert!(r.can_create_project(&l.pk(), None));
    assert!(!r.can_create_project(&member, None));
}

/// Founder plus Budi, member of team Desain, with real signed ops.
fn org_with_member() -> (Laptop, Laptop, String) {
    let mut a = Laptop::founder("Sari");
    let mut b = Laptop::bare("Budi");
    let team = org_ops::create_team(&mut a.conn, &a.id, "Desain");
    org_ops::join(
        (&mut a.conn, &a.id),
        (&mut b.conn, &b.id),
        &team,
        InviteRole::Member,
        vec![],
    );
    (a, b, team)
}

#[test]
fn history_judges_a_change_at_its_own_time() {
    let (mut a, b, team) = org_with_member();
    let pid = "ab".repeat(16);
    let budi = b.pk();
    let write = |r: &Rights| r.can_write(&budi, proj(&pid, Some(&team), &budi));
    let h = RightsHistory::load(&a.conn).unwrap();
    assert!(h.allowed_at(0, write), "member now");

    let before = org_ops::now().unix_timestamp() - 60;
    p::remove_team_member(&mut a.conn, &a.id, &team, &budi, org_ops::now()).unwrap();
    let after = org_ops::now().unix_timestamp() + 60;
    let h = RightsHistory::load(&a.conn).unwrap();
    assert!(!h.current().can_read(&budi, proj(&pid, Some(&team), &budi)));
    assert!(h.allowed_at(before, write), "made before the removal");
    assert!(!h.allowed_at(after, write), "made after the removal");

    // A stranger never had the right.
    let stranger = pk(9);
    assert!(!h.allowed_at(before, |r| r.can_write(&stranger, proj(&pid, None, &stranger))));
}

#[test]
fn history_after_member_remove_and_replay_matches_the_fold() {
    let (mut a, b, team) = org_with_member();
    let budi = b.pk();
    let before = org_ops::now().unix_timestamp() - 60;
    p::remove_member(&mut a.conn, &a.id, &budi, org_ops::now()).unwrap();
    let h = RightsHistory::load(&a.conn).unwrap();
    let pid = "ab".repeat(16);
    let write = |r: &Rights| r.can_write(&budi, proj(&pid, Some(&team), &budi));
    assert!(!write(h.current()));
    assert!(h.allowed_at(before, write));
    assert!(!h.allowed_at(org_ops::now().unix_timestamp() + 60, write));

    // The last replayed step equals the fold's state and the tables.
    let state = p::load_state(&a.conn).unwrap().unwrap();
    let last = &h.steps.last().unwrap().1;
    assert_eq!(*last, Rights::from_state(&state));
    assert_eq!(*last, Rights::load(&a.conn).unwrap());
}

#[test]
fn accessible_projects_and_guest_project_check() {
    let l = Laptop::founder("Sari");
    let me = l.pk();
    let (member, guest) = (pk(1), pk(2));
    add_member(&l.conn, &member, "Budi", "member");
    add_member(&l.conn, &guest, "Klien", "guest");
    let team = add_team(&l.conn, "Desain", &[(&member, "admin")]);
    let in_team = "ab".repeat(16);
    let org_wide = "cd".repeat(16);
    for (id, code, t) in [(&in_team, "PA", Some(&team)), (&org_wide, "PB", None)] {
        l.conn
            .execute(
                "INSERT INTO board_projects (id, code, doc_code, name, team_id, created_by, created_at, doc, updated_at)
                 VALUES (?1, ?2, ?2, 'P', ?3, ?4, 't', x'', 't')",
                params![id, code, t, me],
            )
            .unwrap();
    }
    add_guest(&l, &guest, &team, &in_team);

    let ids = |pk: &str| -> Vec<(String, bool)> {
        projects_accessible_by(&l.conn, pk)
            .unwrap()
            .into_iter()
            .map(|a| (a.project_id, a.can_write))
            .collect()
    };
    assert_eq!(ids(&member), vec![(in_team.clone(), true), (org_wide.clone(), true)]);
    assert_eq!(ids(&guest), vec![(in_team.clone(), false)]);
    assert_eq!(ids(&me), vec![(org_wide.clone(), true)], "superadmin outside the team");
    assert!(may_access_project(&l.conn, &guest, &in_team).unwrap());
    assert!(!may_access_project(&l.conn, &guest, &org_wide).unwrap());
    assert!(!may_access_project(&l.conn, &member, &"ef".repeat(16)).unwrap());

    check_guest_projects(&l.conn, &team, std::slice::from_ref(&in_team)).unwrap();
    let err = check_guest_projects(&l.conn, &team, std::slice::from_ref(&org_wide)).unwrap_err();
    assert_eq!(err.code(), "invalid_input");
    let err = check_guest_projects(&l.conn, &team, &["ef".repeat(16)]).unwrap_err();
    assert_eq!(err.code(), "not_found");
}
