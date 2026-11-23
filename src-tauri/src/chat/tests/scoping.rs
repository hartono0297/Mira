//! Who receives what: team channels, guests, removed members.

use super::super::testutil::{Office, Who, pull, sync};
use super::super::view::{NewChannelScope, ScopeKind};
use super::{feature, messages, sign_as, text_message};
use crate::chat::audience::{BoardAudience, Ctx, ProjectAudience};
use crate::chat::model::{self, Body};
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
    let p = o.add_project("Renovasi Kantor Klien", Some(&team), &a.pk, &[&b.pk]);
    let q = o.add_project("Gudang", Some(&team), &a.pk, &[&b.pk]);
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

#[test]
fn guest_access_counts_only_for_the_projects_own_team() {
    let o = Office::new(&[
        ("Sari", Who::Superadmin),
        ("Budi", Who::Member),
        ("Gita", Who::Guest),
    ]);
    let (a, b, g) = (&o.l[0], &o.l[1], &o.l[2]);
    let (team, _) = o.add_team("Proyek", &[(&a.pk, true), (&b.pk, false)]);
    let (other, _) = o.add_team("Gudang", &[(&b.pk, true)]);
    let p = o.add_project("Renovasi Kantor Klien", Some(&team), &a.pk, &[&b.pk]);
    let open = o.add_project("Kegiatan Kantor", None, &a.pk, &[&b.pk]);
    // An invite from another team, and any invite to a project without a
    // team, grant nothing on the board, so nothing in chat either.
    o.grant_guest(&g.pk, &other, &p);
    o.grant_guest(&g.pk, &team, &open);
    let (p_conv, open_conv) = (model::channel_conv(&p), model::channel_conv(&open));
    a.with_conn(|c| {
        for id in [&p, &open] {
            assert!(!BoardAudience.is_member(c, id, &g.pk).unwrap());
            assert!(BoardAudience.is_member(c, id, &b.pk).unwrap());
        }
        let all = BoardAudience.members_by_project(c).unwrap();
        assert!(!all[&p].contains(&g.pk) && !all[&open].contains(&g.pk));
    });

    a.hooks.set_connected(&[&b.pk, &g.pk]);
    for conv in [&p_conv, &open_conv] {
        a.chat.send(conv, "info", None, vec![], vec![]).unwrap();
    }
    sync(&[a, b, g]);
    assert_eq!(b.count("SELECT count(*) FROM chat_messages"), 2);
    assert_eq!(g.count("SELECT count(*) FROM chat_messages"), 0);
    assert!(a.chat.record_ids_for(&g.pk).unwrap().is_empty());
    let ov = g.chat.overview().unwrap();
    assert!(ov.conversations.is_empty() && ov.projects.is_empty());
    for conv in [&p_conv, &open_conv] {
        assert_eq!(
            g.chat.conversation(conv, None, 10).unwrap_err().code(),
            "forbidden"
        );
    }
}

#[test]
fn project_the_board_never_syncs_has_no_channel() {
    let o = Office::new(&[("Sari", Who::Superadmin), ("Budi", Who::Member)]);
    let (a, b) = (&o.l[0], &o.l[1]);
    let (team, _) = o.add_team("Proyek", &[(&a.pk, true), (&b.pk, false)]);
    let p = o.add_project("Arsip Lama", Some(&team), &a.pk, &[&b.pk]);
    o.each(|c| {
        c.execute("UPDATE board_projects SET bound = 0 WHERE id = ?1", [&p])
            .unwrap();
    });
    let conv = model::channel_conv(&p);
    a.with_conn(|c| {
        assert_eq!(BoardAudience.project(c, &p).unwrap(), None);
        assert!(BoardAudience.projects(c).unwrap().is_empty());
        assert!(!BoardAudience.is_member(c, &p, &a.pk).unwrap());
        assert!(BoardAudience.members_by_project(c).unwrap().is_empty());
        let ctx = Ctx::load(c, &a.pk, &BoardAudience).unwrap().unwrap();
        assert_eq!(ctx.conv(&conv).unwrap(), None);
        assert!(!ctx.all_channel_convs().unwrap().contains(&conv));
    });

    let ov = a.chat.overview().unwrap();
    assert!(!ov.conversations.iter().any(|s| s.id == conv));
    assert!(ov.projects.is_empty());
    assert!(a.chat.send(&conv, "halo", None, vec![], vec![]).is_err());
    let scope = NewChannelScope {
        kind: ScopeKind::Project,
        id: Some(p.clone()),
    };
    assert_eq!(
        a.chat.create_channel("Diskusi", scope).unwrap_err().code(),
        "not_found"
    );
    // A record for it from another laptop waits: the channel is unknown here.
    let rec = sign_as(
        b,
        &o.org_id,
        crate::clock::now(),
        text_message(&conv, "halo"),
    );
    let got = a.chat.ingest(&b.pk, vec![feature(&rec)]).unwrap();
    assert_eq!((got.accepted, got.rejected), (0, 0));
    assert_eq!(a.count("SELECT count(*) FROM chat_messages"), 0);
}

#[test]
fn superadmin_outside_the_team_does_not_administer_its_project_channel() {
    let o = Office::new(&[
        ("Sari", Who::Superadmin),
        ("Budi", Who::Member),
        ("Dewi", Who::Member),
    ]);
    let (a, b, d) = (&o.l[0], &o.l[1], &o.l[2]);
    let (team, _) = o.add_team("Lapangan", &[(&b.pk, true), (&d.pk, false)]);
    let p = o.add_project("Gedung B", Some(&team), &b.pk, &[&d.pk]);
    let conv = model::channel_conv(&p);
    d.hooks.set_connected(&[&b.pk]);
    let m = d
        .chat
        .send(&conv, "foto progres", None, vec![], vec![])
        .unwrap();
    pull(d, b);
    assert_eq!(messages(b, &conv).len(), 1);
    b.with_conn(|c| {
        let ctx = Ctx::load(c, &b.pk, &BoardAudience).unwrap().unwrap();
        let info = ctx.conv(&conv).unwrap().unwrap();
        assert!(!ctx.is_admin(&info, &a.pk).unwrap());
        assert!(ctx.is_admin(&info, &b.pk).unwrap());
        assert!(!ctx.is_admin(&info, &d.pk).unwrap());
    });

    // Archive, delete and deleting Dewi's message, all signed by Sari, are
    // not accepted on Budi's laptop.
    let now = crate::clock::now();
    let bodies = [
        Body::ChannelArchive {
            conv: conv.clone(),
            archived: true,
        },
        Body::ChannelDelete { conv: conv.clone() },
        Body::MessageDelete {
            conv: conv.clone(),
            message: m.id.clone(),
            message_author: d.pk.clone(),
            message_at: m.at.clone(),
        },
    ];
    for body in bodies {
        let rec = sign_as(a, &o.org_id, now, body);
        let got = b.chat_ingest(&a.pk, vec![feature(&rec)]);
        assert_eq!(got.accepted, 0);
    }
    let view = b.chat.conversation(&conv, None, 10).unwrap();
    assert_eq!(view.messages.len(), 1);
    assert!(!view.messages[0].deleted);
    assert_eq!(
        b.count("SELECT count(*) FROM chat_channels WHERE archived = 1 OR deleted = 1"),
        0
    );

    // v0.3: joining the department is not enough; once Sari adds herself
    // to the project she administers its channel.
    b.with_conn(|c| {
        c.execute(
            "INSERT INTO team_members (team_id, public_key, role, added_at) VALUES (?1, ?2, 'member', 't')",
            [&team, &a.pk],
        )
        .unwrap();
        let ctx = Ctx::load(c, &b.pk, &BoardAudience).unwrap().unwrap();
        let info = ctx.conv(&conv).unwrap().unwrap();
        assert!(!ctx.is_admin(&info, &a.pk).unwrap());
    });
    o.add_project_member(&p, &a.pk);
    b.with_conn(|c| {
        let ctx = Ctx::load(c, &b.pk, &BoardAudience).unwrap().unwrap();
        let info = ctx.conv(&conv).unwrap().unwrap();
        assert!(ctx.is_admin(&info, &a.pk).unwrap());
        assert!(!ctx.is_admin(&info, &d.pk).unwrap(), "plain project member");
    });
}
