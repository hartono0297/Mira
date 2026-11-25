//! v0.6 division wiring (docs/plans/dept-divisi.md, 5 and 7): the chat
//! banner target, divisions on `PersonView`, the "Proyek baru" picker and
//! the division picked from an AD claim when a join request is approved.

use super::join_tests::{Node, Office, all_on, device, ip, now, office, target};
use crate::ad::OuMapping;
use crate::permissions::fold::ChannelState;
use crate::permissions::join::{JoinAdClaim, JoinExtras};
use crate::permissions::{self as p, DivisionRole, OrgState};

const DOMAIN: &str = "biro.co.id";
const DN: &str = "CN=Sari Lestari,OU=Cetak,OU=Desain,OU=Kantor Pusat,DC=biro,DC=co,DC=id";

fn open_office() -> Office {
    let mut o = office();
    all_on(&mut o, crate::device::APP_VERSION);
    o
}

fn row(ou: &str, team: &str, division: Option<&str>) -> OuMapping {
    OuMapping {
        ou: ou.into(),
        team: team.into(),
        division: division.map(str::to_owned),
    }
}

/// Rina (admin of Desain) makes division `name`.
fn division(o: &mut Office, name: &str) -> String {
    o.andi.sync_to(&mut o.rina);
    let id = p::create_division(&mut o.rina.conn, &o.rina.id, &o.desain, name, now()).unwrap();
    o.rina.sync_to(&mut o.andi);
    id
}

fn with_map(state: &OrgState, map: Vec<OuMapping>) -> OrgState {
    let mut s = state.clone();
    s.ad.ou_map = map;
    s
}

// ----- Chat banner target -----------------------------------------------------------

#[test]
fn conversation_target_knows_division_chats_and_department_channels() {
    let mut o = open_office();
    let cetak = division(&mut o, "Cetak");
    let mut s = o.andi.state();
    let desain = o.desain.clone();

    assert_eq!(
        p::conversation_target(&s, &format!("ch:{cetak}")),
        Some((desain.clone(), Some(cetak.clone())))
    );
    let channel = s
        .department_channel(&desain)
        .map(|c| c.id.clone())
        .unwrap_or_else(|| {
            // Older offices may have no channel yet: add one for the test.
            let id = "c1".repeat(16);
            s.channels.insert(
                id.clone(),
                ChannelState {
                    id: id.clone(),
                    team: Some(desain.clone()),
                    name: "desain".into(),
                    created_at: "2026-11-01T00:00:00Z".into(),
                    created_by: None,
                },
            );
            id
        });
    assert_eq!(
        p::conversation_target(&s, &format!("ch:{channel}")),
        Some((desain.clone(), None))
    );
    // A later channel of the department is not its department channel.
    let later = "c2".repeat(16);
    s.channels.insert(
        later.clone(),
        ChannelState {
            id: later.clone(),
            team: Some(desain.clone()),
            name: "desain-lain".into(),
            created_at: "2099-01-01T00:00:00Z".into(),
            created_by: None,
        },
    );
    assert_eq!(p::conversation_target(&s, &format!("ch:{later}")), None);
    // #umum, DMs, unknown ids and missing prefixes have no settings.
    let umum = p::umum_channel_id(&o.andi.state().org.id);
    assert_eq!(p::conversation_target(&s, &format!("ch:{umum}")), None);
    assert_eq!(p::conversation_target(&s, &format!("dm:{cetak}")), None);
    assert_eq!(p::conversation_target(&s, &format!("ch:{}", "ab".repeat(16))), None);
    assert_eq!(p::conversation_target(&s, &cetak), None);

    // Banner: Dimas (plain member of Desain) may not edit the department
    // channel; Rina may.
    let banner = p::conversation_settings(&s, &o.dimas.pk(), &format!("ch:{channel}")).unwrap();
    assert!(banner.can_write && !banner.can_edit);
    let banner = p::conversation_settings(&s, &o.rina.pk(), &format!("ch:{cetak}")).unwrap();
    assert!(banner.can_edit);
    assert_eq!(banner.division_id.as_deref(), Some(cetak.as_str()));
}

// ----- PersonView and the "Proyek baru" picker -----------------------------------------

#[test]
fn people_carry_their_active_divisions_and_my_divisions_tells_the_role() {
    let mut o = open_office();
    let cetak = division(&mut o, "Cetak");
    let arsip = division(&mut o, "Arsip");
    let (dimas, rina) = (o.dimas.pk(), o.rina.pk());
    p::set_division_head(&mut o.rina.conn, &o.rina.id, &cetak, &dimas, true, now()).unwrap();
    p::add_division_member(&mut o.rina.conn, &o.rina.id, &arsip, &dimas, now()).unwrap();
    p::set_division_archived(&mut o.rina.conn, &o.rina.id, &arsip, true, now()).unwrap();
    o.rina.sync_to(&mut o.andi);
    let s = o.andi.state();

    let people = p::people(&s, &o.andi.pk(), Some("Andi"));
    let d = people.iter().find(|x| x.public_key == dimas).unwrap();
    let names: Vec<&str> = d.divisions.iter().map(|x| x.name.as_str()).collect();
    assert_eq!(names, ["Cetak"], "archived divisions are left out");
    let json = serde_json::to_value(d).unwrap();
    assert_eq!(json["divisions"][0]["id"], cetak.as_str());
    let r = people.iter().find(|x| x.public_key == rina).unwrap();
    assert!(r.divisions.is_empty());

    // Dimas heads Cetak (and is a member of the archived Arsip).
    let mine = p::my_divisions(&s, &dimas);
    let cetak_ref = mine.iter().find(|x| x.id == cetak).unwrap();
    assert_eq!(cetak_ref.role, Some(DivisionRole::Head));
    assert_eq!(serde_json::to_value(cetak_ref).unwrap()["role"], "head");
    // Rina manages both without being in them.
    let mine = p::my_divisions(&s, &rina);
    assert_eq!(mine.len(), 2);
    assert!(mine.iter().all(|x| x.role.is_none()));
    // The superadmin (in another department) gets every live division.
    let all = p::my_divisions(&s, &o.andi.pk());
    let mut ids: Vec<&str> = all.iter().map(|x| x.id.as_str()).collect();
    ids.sort_unstable();
    let mut want = vec![cetak.as_str(), arsip.as_str()];
    want.sort_unstable();
    assert_eq!(ids, want);
}

// ----- AD onboarding ---------------------------------------------------------------------

#[test]
fn ad_division_is_the_innermost_mapped_live_division_of_the_team() {
    let mut o = open_office();
    let cetak = division(&mut o, "Cetak");
    let layout = division(&mut o, "Layout");
    let (desain, admin) = (o.desain.clone(), o.admin.clone());
    let s = o.andi.state();
    let pick = |map: Vec<OuMapping>, team: &str, dn: Option<&str>| {
        p::division::ad_division_for(&with_map(&s, map), team, dn)
    };

    // Innermost OU first.
    let map = vec![
        row("Desain", &desain, Some(&layout)),
        row("cetak", &desain, Some(&cetak)),
    ];
    assert_eq!(pick(map.clone(), &desain, Some(DN)), Some(cetak.clone()));
    // An OU row without division is skipped for an outer one.
    let map2 = vec![
        row("Cetak", &desain, None),
        row("Desain", &desain, Some(&layout)),
    ];
    assert_eq!(pick(map2, &desain, Some(DN)), Some(layout.clone()));
    // Another department's request, no DN, no matching OU: nothing.
    assert_eq!(pick(map.clone(), &admin, Some(DN)), None);
    assert_eq!(pick(map.clone(), &desain, None), None);
    assert_eq!(
        pick(map, &desain, Some("CN=Sari,OU=Lain,DC=biro,DC=co,DC=id")),
        None
    );
    // A row pointing at an unknown division is skipped.
    let map3 = vec![
        row("Cetak", &desain, Some(&"ef".repeat(16))),
        row("Kantor Pusat", &desain, Some(&cetak)),
    ];
    assert_eq!(pick(map3, &desain, Some(DN)), Some(cetak.clone()));

    // Archived divisions are skipped.
    p::set_division_archived(&mut o.rina.conn, &o.rina.id, &cetak, true, now()).unwrap();
    o.rina.sync_to(&mut o.andi);
    let s = o.andi.state();
    let map = vec![
        row("Cetak", &desain, Some(&cetak)),
        row("Desain", &desain, Some(&layout)),
    ];
    assert_eq!(
        p::division::ad_division_for(&with_map(&s, map), &desain, Some(DN)),
        Some(layout)
    );
}

fn claim() -> JoinAdClaim {
    JoinAdClaim {
        domain: DOMAIN.into(),
        user: "sari.l".into(),
        dn: Some(DN.into()),
        name: Some("Sari Lestari".into()),
        department: Some("Desain".into()),
    }
}

/// Sari asks to join Desain with an AD claim; Andi holds the request.
fn ad_request(o: &mut Office, sari: &mut Node) -> String {
    let profile = p::DeviceProfile {
        app_version: crate::device::APP_VERSION.into(),
        ..device()
    };
    let extras = JoinExtras {
        note: None,
        account: Some("sari.l".into()),
        ad: Some(claim()),
    };
    let mine = p::create_join_request(
        &mut sari.conn,
        &sari.id,
        &target(&o.andi, &o.desain),
        &profile,
        Some(&extras),
        now(),
    )
    .unwrap();
    p::receive_join_request(
        &mut o.andi.conn,
        &o.andi.id,
        &mine.request,
        &sari.pk(),
        ip("192.168.1.31"),
        now(),
    )
    .unwrap();
    mine.request_id
}

#[test]
fn approving_an_ad_request_adds_the_member_to_the_mapped_division() {
    let mut o = open_office();
    let cetak = division(&mut o, "Cetak");
    let desain = o.desain.clone();
    let map = vec![row("Cetak", &desain, Some(&cetak))];
    p::set_ad_settings(&mut o.andi.conn, &o.andi.id, DOMAIN, map, now()).unwrap();

    let mut sari = Node::new("Sari");
    let id = ad_request(&mut o, &mut sari);
    p::approve_join(&mut o.andi.conn, &o.andi.id, &id, now()).unwrap();
    let s = o.andi.state();
    assert!(s.is_active(&sari.pk()));
    assert_eq!(s.division_role(&cetak, &sari.pk()), Some(DivisionRole::Member));
    // Both ops reach the other laptops.
    o.andi.sync_to(&mut o.rina);
    assert_eq!(
        o.rina.state().division_role(&cetak, &sari.pk()),
        Some(DivisionRole::Member)
    );
}

#[test]
fn approval_stands_when_the_mapped_division_takes_nobody() {
    let mut o = open_office();
    let cetak = division(&mut o, "Cetak");
    let desain = o.desain.clone();
    let map = vec![row("Cetak", &desain, Some(&cetak))];
    p::set_ad_settings(&mut o.andi.conn, &o.andi.id, DOMAIN, map, now()).unwrap();
    o.andi.sync_to(&mut o.rina);
    p::set_division_archived(&mut o.rina.conn, &o.rina.id, &cetak, true, now()).unwrap();
    o.rina.sync_to(&mut o.andi);

    let mut sari = Node::new("Sari");
    let id = ad_request(&mut o, &mut sari);
    let before = p::load_ops(&o.andi.conn).unwrap().len();
    p::approve_join(&mut o.andi.conn, &o.andi.id, &id, now()).unwrap();
    let s = o.andi.state();
    assert!(s.is_active(&sari.pk()));
    assert_eq!(s.division_role(&cetak, &sari.pk()), None);
    assert_eq!(p::load_ops(&o.andi.conn).unwrap().len(), before + 1);
}
