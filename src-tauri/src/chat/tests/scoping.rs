//! Who receives what: team channels, guests, removed members.

use super::super::testutil::{Office, Who, pull, sync};
use super::{feature, messages, sign_as, text_message};
use crate::chat::model;
use crate::network::feature::FeatureSync;

#[test]
fn team_channel_never_reaches_a_non_member_even_through_a_relay() {
    let o = Office::new(&[
        ("Sari", Who::Superadmin),
        ("Budi", Who::Member),
        ("Dewi", Who::Member),
    ]);
    let (a, b, d) = (&o.l[0], &o.l[1], &o.l[2]);
    let (_team, conv) = o.add_team("Keuangan", &[(&a.pk, true), (&b.pk, false)]);
    a.hooks.set_connected(&[&b.pk, &d.pk]);
    a.chat
        .send(&conv, "laporan laba rugi", None, vec![], vec![])
        .unwrap();
    pull(a, b);
    assert_eq!(messages(b, &conv).len(), 1);
    // B relays to D: nothing of the team channel is offered or handed out.
    assert!(b.chat.record_ids_for(&d.pk).unwrap().is_empty());
    let ids: Vec<String> = a.with_conn(|c| {
        let mut s = c.prepare("SELECT id FROM chat_records").unwrap();
        s.query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    });
    assert!(b.chat.records_for(&d.pk, &ids).unwrap().is_empty());
    sync(&[a, b, d]);
    assert_eq!(d.count("SELECT count(*) FROM chat_records"), 0);
    assert_eq!(
        d.chat.conversation(&conv, None, 10).unwrap_err().code(),
        "forbidden"
    );
    assert!(
        !d.chat
            .overview()
            .unwrap()
            .conversations
            .iter()
            .any(|s| s.id == conv)
    );
}

#[test]
fn guest_sees_only_its_project_and_cannot_use_chat_pribadi() {
    let o = Office::new(&[
        ("Sari", Who::Superadmin),
        ("Budi", Who::Member),
        ("Gita", Who::Guest),
    ]);
    let (a, b, g) = (&o.l[0], &o.l[1], &o.l[2]);
    let (team, team_conv) = o.add_team("Proyek", &[(&a.pk, true), (&b.pk, false)]);
    let p = o.add_project("Renovasi Kantor Klien", Some(&team), &a.pk);
    let q = o.add_project("Gudang", Some(&team), &a.pk);
    o.grant_guest(&g.pk, &team, &p);
    let (p_conv, q_conv) = (model::channel_conv(&p), model::channel_conv(&q));
    a.hooks.set_connected(&[&b.pk, &g.pk]);
    for conv in [o.umum(), team_conv.clone(), p_conv.clone(), q_conv.clone()] {
        a.chat.send(&conv, "info", None, vec![], vec![]).unwrap();
    }
    sync(&[a, b, g]);
    let ov = g.chat.overview().unwrap();
    let ids: Vec<&str> = ov.conversations.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, vec![p_conv.as_str()]);
    assert_eq!(ov.conversations[0].name, "renovasi-kantor-klien");
    assert_eq!(
        ov.conversations[0].scope.as_ref().unwrap().name,
        "Renovasi Kantor Klien"
    );
    assert!(!ov.can_create_channel && !ov.can_direct_message);
    assert_eq!(g.count("SELECT count(*) FROM chat_messages"), 1);
    assert_eq!(b.count("SELECT count(*) FROM chat_messages"), 4);

    assert_eq!(g.chat.open_dm(&a.pk).unwrap_err().code(), "forbidden");
    assert_eq!(a.chat.open_dm(&g.pk).unwrap_err().code(), "forbidden");
    let dm = model::dm_conv(&a.pk, &g.pk);
    let forged = sign_as(
        g,
        &o.org_id,
        crate::clock::now(),
        text_message(&dm, "halo bos"),
    );
    let got = a.chat.ingest(&g.pk, vec![feature(&forged)]).unwrap();
    assert_eq!((got.accepted, got.rejected), (0, 1));
    assert_eq!(a.rejected_codes().last().unwrap(), "chat_forbidden");

    // The guest may hold a sealed envelope for an offline member.
    a.hooks.set_connected(&[&g.pk]);
    let m = a
        .chat
        .send(&p_conv, "untuk Budi lewat Gita", None, vec![], vec![])
        .unwrap();
    pull(a, g);
    assert_eq!(
        g.count("SELECT count(*) FROM chat_envelopes WHERE acked = 0"),
        1
    );
    assert_eq!(
        g.count("SELECT count(*) FROM chat_messages"),
        2,
        "the project message itself"
    );
    let a2 = a
        .chat
        .send(&o.umum(), "pengumuman untuk Budi", None, vec![], vec![])
        .unwrap();
    pull(a, g);
    assert_eq!(
        g.count("SELECT count(*) FROM chat_envelopes WHERE acked = 0"),
        2
    );
    assert_eq!(
        g.count("SELECT count(*) FROM chat_messages"),
        2,
        "umum stays sealed for the guest"
    );
    pull(g, b);
    let umum_msgs = messages(b, &o.umum());
    assert!(umum_msgs.iter().any(|x| x.id == a2.id));
    assert!(messages(b, &p_conv).iter().any(|x| x.id == m.id));
}

#[test]
fn removed_member_gets_nothing_and_late_records_are_judged_by_time() {
    let o = Office::new(&[
        ("Sari", Who::Superadmin),
        ("Budi", Who::Member),
        ("Citra", Who::Member),
    ]);
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let umum = o.umum();
    let now = crate::clock::now();
    let before = sign_as(
        b,
        &o.org_id,
        now - time::Duration::hours(2),
        text_message(&umum, "sebelum keluar"),
    );
    let after = sign_as(b, &o.org_id, now, text_message(&umum, "sesudah keluar"));
    a.hooks.set_connected(&[&c.pk]);
    a.chat.send(&umum, "halo", None, vec![], vec![]).unwrap();
    let removed_at = crate::permissions::format::format_time(now - time::Duration::hours(1));
    o.remove_member(&b.pk, &removed_at);

    assert!(a.chat.record_ids_for(&b.pk).unwrap().is_empty());
    let got = c
        .chat
        .ingest(&a.pk, vec![feature(&before), feature(&after)])
        .unwrap();
    assert_eq!((got.accepted, got.rejected), (1, 1));
    assert_eq!(c.rejected_codes().last().unwrap(), "chat_removed");
    let texts: Vec<String> = messages(c, &umum).into_iter().map(|m| m.text).collect();
    assert_eq!(texts, vec!["sebelum keluar"]);
    assert_eq!(b.chat.overview().unwrap_err().code(), "removed");
}
