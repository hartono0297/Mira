use rusqlite::params;

use super::*;
use crate::board::testutil::org_ops;
use crate::board::testutil::{Laptop, add_member, add_team, register_project};
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

/// v0.3: explicit project members from any department, guests of the
/// project through its own department, superadmins only as members.
#[test]
fn project_member_rules() {
    let l = Laptop::founder("Sari");
    let me = l.pk(); // superadmin
    let (admin, creator, colleague, other_dept, guest, removed, member_elsewhere) =
        (pk(1), pk(2), pk(3), pk(4), pk(5), pk(6), pk(7));
    add_member(&l.conn, &admin, "Rina", "member");
    add_member(&l.conn, &creator, "Dimas", "member");
    add_member(&l.conn, &colleague, "Budi", "member");
    add_member(&l.conn, &other_dept, "Hendra", "member");
    add_member(&l.conn, &guest, "Klien", "guest");
    add_member(&l.conn, &removed, "Lama", "removed");
    add_member(&l.conn, &member_elsewhere, "Wulan", "member");
    let team = add_team(
        &l.conn,
        "Desain",
        &[
            (&admin, "admin"),
            (&creator, "member"),
            (&colleague, "member"),
            (&removed, "member"),
        ],
    );
    let other = add_team(
        &l.conn,
        "Sipil",
        &[(&other_dept, "member"), (&member_elsewhere, "member")],
    );
    let pid = "ab".repeat(16);
    // Dimas made it with Hendra from another department.
    register_project(
        &l.conn,
        &pid,
        Some(&team),
        &creator,
        &[&creator, &other_dept, &removed],
    );
    add_guest(&l, &guest, &team, &pid);
    // Guest access granted through another department does not count.
    add_guest(&l, &member_elsewhere, &other, &pid);
    let r = Rights::load(&l.conn).unwrap();
    let p = proj(&pid, Some(&team), &creator);

    assert!(r.is_registered(&pid));
    assert!(r.can_read(&creator, p) && r.can_write(&creator, p));
    assert!(
        r.can_read(&other_dept, p) && r.can_write(&other_dept, p),
        "member from any department"
    );
    assert!(!r.can_read(&colleague, p), "same department, not a member");
    assert!(!r.can_read(&admin, p), "department admin is not a reader");
    assert!(!r.can_read(&me, p), "superadmin outside the project");
    assert!(
        r.can_read(&guest, p) && !r.can_write(&guest, p),
        "guest reads only"
    );
    assert!(
        !r.can_read(&member_elsewhere, p),
        "guest access from another department"
    );
    assert!(!r.can_read(&removed, p), "removed member");
    assert!(
        !r.can_read(&guest, proj(&"cd".repeat(16), Some(&team), &creator)),
        "other project"
    );

    // Managers: creator while a member, the department admin (without
    // reading), a superadmin only as a member.
    assert!(r.can_manage_members(&creator, p) && r.can_manage(&creator, p));
    assert!(r.can_manage_members(&admin, p) && !r.can_manage(&admin, p));
    assert!(!r.can_manage_members(&other_dept, p));
    assert!(!r.can_manage_members(&me, p));
    assert!(!r.can_manage_members(&guest, p));
    assert!(r.can_delete_task(&other_dept, p, &other_dept), "own task");
    assert!(
        !r.can_delete_task(&other_dept, p, &creator),
        "someone else's task"
    );
    assert!(r.can_delete_task(&creator, p, &other_dept), "manager");
    assert!(!r.can_delete_task(&guest, p, &guest));

    assert_eq!(r.readers(p), {
        let mut v = vec![creator.clone(), other_dept.clone(), guest.clone()];
        v.sort();
        v
    });
    assert!(!r.writers(p).contains(&guest));

    // Project creation: superadmin anywhere, department admin in theirs.
    assert!(r.can_create_project(&me, Some(&team)));
    assert!(r.can_create_project(&admin, Some(&team)));
    assert!(!r.can_create_project(&admin, Some(&other)));
    assert!(!r.can_create_project(&creator, Some(&team)));
    assert!(!r.can_create_project(&guest, Some(&team)));

    // The superadmin as a member reads and manages.
    crate::board::testutil::add_project_member(&l.conn, &pid, &me);
    let r = Rights::load(&l.conn).unwrap();
    assert!(r.can_read(&me, p) && r.can_manage(&me, p) && r.can_delete_task(&me, p, &creator));
    // The creator who left the project no longer manages it.
    l.conn
        .execute(
            "DELETE FROM project_members WHERE project_id = ?1 AND public_key = ?2",
            params![pid, creator],
        )
        .unwrap();
    let r = Rights::load(&l.conn).unwrap();
    assert!(!r.can_read(&creator, p) && !r.can_manage_members(&creator, p));
}

#[test]
fn unregistered_or_mismatched_projects_are_closed() {
    let l = Laptop::founder("Sari");
    let me = l.pk();
    let member = pk(1);
    add_member(&l.conn, &member, "Budi", "member");
    let team = add_team(&l.conn, "Desain", &[(&member, "admin")]);
    let r = Rights::load(&l.conn).unwrap();
    let pid = "ab".repeat(16);
    // Not registered: nobody, not even the department admin or creator.
    for who in [&me, &member] {
        assert!(!r.can_read(who, proj(&pid, Some(&team), &member)));
        assert!(!r.can_manage_members(who, proj(&pid, Some(&team), &member)));
    }
    assert!(!r.can_read(&member, proj(&pid, None, &member)));
    // Registered, but the board row names another department or creator.
    register_project(&l.conn, &pid, Some(&team), &member, &[&member]);
    let r = Rights::load(&l.conn).unwrap();
    assert!(r.can_read(&member, proj(&pid, Some(&team), &member)));
    assert!(
        !r.can_read(&member, proj(&pid, None, &member)),
        "row without department"
    );
    assert!(!r.can_read(&member, proj(&pid, Some(&"ff".repeat(16)), &member)));
    assert!(
        !r.can_read(&member, proj(&pid, Some(&team), &me)),
        "row with another creator"
    );
}

#[test]
fn project_without_department() {
    let l = Laptop::founder("Sari");
    let (member, guest, other) = (pk(1), pk(2), pk(3));
    add_member(&l.conn, &member, "Budi", "member");
    add_member(&l.conn, &guest, "Klien", "guest");
    add_member(&l.conn, &other, "Citra", "member");
    let founder = l.pk();
    let pid = "ab".repeat(16);
    register_project(&l.conn, &pid, None, &founder, &[&founder, &member, &guest]);
    let r = Rights::load(&l.conn).unwrap();
    let p = proj(&pid, None, &founder);
    assert!(r.can_write(&member, p));
    assert!(!r.can_read(&other, p), "not every member any more");
    assert!(
        r.can_read(&guest, p) && !r.can_write(&guest, p),
        "guest added as a member"
    );
    assert!(!r.can_manage(&member, p));
    assert!(r.can_manage(&founder, p), "creator and member");
    assert!(r.can_create_project(&founder, None));
    assert!(!r.can_create_project(&member, None));
}

/// Founder plus Budi in department Desain, real signed ops; Budi's project
/// with Budi as member.
fn org_with_project() -> (Laptop, Laptop, String, String) {
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
    let project =
        crate::board::store::create_project(&mut b.conn, &b.id, "Gudang", "GD", Some(&team))
            .unwrap()
            .value
            .id;
    let a_pk = a.pk();
    org_ops::sync(&b.conn, &mut a.conn, &a_pk, &b.pk());
    (a, b, team, project)
}

#[test]
fn history_judges_a_change_at_its_own_time() {
    let (mut a, b, team, pid) = org_with_project();
    let budi = b.pk();
    let write = |r: &Rights| r.can_write(&budi, proj(&pid, Some(&team), &budi));
    let h = RightsHistory::load(&a.conn).unwrap();
    assert!(h.allowed_at(0, write), "member now");

    // The department admin (here the superadmin as a member) takes Budi out.
    let sari = a.pk();
    p::add_project_member(&mut a.conn, &a.id, &pid, &sari, org_ops::now()).unwrap();
    let before = org_ops::now().unix_timestamp() - 60;
    p::remove_project_member(&mut a.conn, &a.id, &pid, &budi, org_ops::now()).unwrap();
    let after = org_ops::now().unix_timestamp() + 60;
    let h = RightsHistory::load(&a.conn).unwrap();
    assert!(!h.current().can_read(&budi, proj(&pid, Some(&team), &budi)));
    assert!(h.allowed_at(before, write), "made before the removal");
    assert!(!h.allowed_at(after, write), "made after the removal");

    // A stranger never had the right.
    let stranger = pk(9);
    assert!(!h.allowed_at(before, |r| {
        r.can_write(&stranger, proj(&pid, None, &stranger))
    }));
}

#[test]
fn history_after_member_remove_and_replay_matches_the_fold() {
    let (mut a, b, team, pid) = org_with_project();
    let budi = b.pk();
    let before = org_ops::now().unix_timestamp() - 60;
    p::remove_member(&mut a.conn, &a.id, &budi, org_ops::now()).unwrap();
    let h = RightsHistory::load(&a.conn).unwrap();
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
    register_project(&l.conn, &in_team, Some(&team), &me, &[&member]);
    register_project(&l.conn, &org_wide, None, &me, &[&me, &member]);
    add_guest(&l, &guest, &team, &in_team);

    let ids = |pk: &str| -> Vec<(String, bool)> {
        projects_accessible_by(&l.conn, pk)
            .unwrap()
            .into_iter()
            .map(|a| (a.project_id, a.can_write))
            .collect()
    };
    assert_eq!(
        ids(&member),
        vec![(in_team.clone(), true), (org_wide.clone(), true)]
    );
    assert_eq!(ids(&guest), vec![(in_team.clone(), false)]);
    assert_eq!(
        ids(&me),
        vec![(org_wide.clone(), true)],
        "superadmin outside the project"
    );
    assert!(may_access_project(&l.conn, &guest, &in_team).unwrap());
    assert!(!may_access_project(&l.conn, &guest, &org_wide).unwrap());
    assert!(!may_access_project(&l.conn, &member, &"ef".repeat(16)).unwrap());

    check_guest_projects(&l.conn, &team, std::slice::from_ref(&in_team)).unwrap();
    let err = check_guest_projects(&l.conn, &team, std::slice::from_ref(&org_wide)).unwrap_err();
    assert_eq!(err.code(), "invalid_input");
    let err = check_guest_projects(&l.conn, &team, &["ef".repeat(16)]).unwrap_err();
    assert_eq!(err.code(), "not_found");
}
