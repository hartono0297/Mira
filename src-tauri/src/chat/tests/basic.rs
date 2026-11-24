//! Convergence in `#umum`, receipts and statuses, deletes, archive rights.

use super::super::testutil::{Office, Who, pull, sync};
use super::super::view::{DeliveryState, NewChannelScope, NotifyMode, ScopeKind};
use super::{messages, sign_as, status_of};
use crate::chat::model::Body;

fn office() -> Office {
    Office::new(&[
        ("Sari", Who::Superadmin),
        ("Budi", Who::Member),
        ("Citra", Who::Member),
    ])
}

fn connect_all(o: &Office) {
    let keys: Vec<String> = o.l.iter().map(|l| l.pk.clone()).collect();
    for l in &o.l {
        let others: Vec<&str> = keys
            .iter()
            .filter(|k| **k != l.pk)
            .map(String::as_str)
            .collect();
        l.hooks.set_connected(&others);
    }
}

#[test]
fn three_laptops_converge_in_umum_with_receipts_and_statuses() {
    let o = office();
    connect_all(&o);
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let umum = o.umum();
    let m = a
        .chat
        .send(&umum, "Halo semua", None, vec![b.pk.clone()], vec![])
        .unwrap();
    assert!(m.mine);
    let st = m.status.clone().unwrap();
    assert_eq!((st.state, st.total), (DeliveryState::Pending, 2));
    assert_eq!(
        a.count("SELECT count(*) FROM chat_envelopes"),
        0,
        "everyone online: no envelopes"
    );
    assert!(a.hooks.snapshot().notify_changed >= 1);

    sync(&[a, b, c]);
    for l in [b, c] {
        let ms = messages(l, &umum);
        assert_eq!(ms.len(), 1);
        assert_eq!(ms[0].text, "Halo semua");
        assert_eq!(ms[0].author.name, "Sari");
        assert!(!ms[0].mine);
    }
    let st = messages(a, &umum)[0].status.clone().unwrap();
    assert_eq!(
        (st.state, st.delivered, st.read),
        (DeliveryState::Delivered, 2, 0)
    );

    let ob = b.chat.overview().unwrap();
    let sb = ob.conversations.iter().find(|s| s.id == umum).unwrap();
    assert_eq!((sb.unread, sb.mention_unread), (1, 1));
    assert!(sb.is_umum && sb.can_post && !sb.can_archive);
    assert_eq!(sb.last_preview.as_deref(), Some("Sari: Halo semua"));
    let sc = c.chat.overview().unwrap();
    let sc = sc.conversations.iter().find(|s| s.id == umum).unwrap();
    assert_eq!((sc.unread, sc.mention_unread), (1, 0));
    let notes = b.hooks.take_notifications();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].title, "Sari di #umum");
    assert_eq!(notes[0].body, "Halo semua");

    b.chat.mark_read(&umum).unwrap();
    sync(&[a, b, c]);
    let st = messages(a, &umum)[0].status.clone().unwrap();
    assert_eq!(
        (st.state, st.read, st.delivered),
        (DeliveryState::Delivered, 1, 2)
    );
    c.chat.mark_read(&umum).unwrap();
    sync(&[a, b, c]);
    assert_eq!(status_of(a, &umum, &m.id), DeliveryState::Read);
    let receipts = a.chat.message_receipts(&m.id).unwrap();
    assert_eq!(receipts.len(), 2);
    assert!(receipts.iter().all(|r| r.state == DeliveryState::Read));
    let ob = b.chat.overview().unwrap();
    assert_eq!(
        ob.conversations
            .iter()
            .find(|s| s.id == umum)
            .unwrap()
            .unread,
        0
    );

    // Same rows everywhere.
    for l in [a, b, c] {
        assert_eq!(
            l.count("SELECT count(*) FROM chat_receipts WHERE state = 'read'"),
            2
        );
        assert_eq!(l.count("SELECT count(*) FROM chat_messages"), 1);
    }
}

#[test]
fn notify_setting_and_mute_limit_notifications() {
    let o = office();
    connect_all(&o);
    let (a, b) = (&o.l[0], &o.l[1]);
    let umum = o.umum();
    b.chat.set_notify(NotifyMode::Mentions).unwrap();
    a.chat
        .send(&umum, "tanpa sebutan", None, vec![], vec![])
        .unwrap();
    pull(a, b);
    assert!(b.hooks.take_notifications().is_empty());
    a.chat
        .send(&umum, "untuk Budi", None, vec![b.pk.clone()], vec![])
        .unwrap();
    pull(a, b);
    assert_eq!(b.hooks.take_notifications().len(), 1);
    b.chat.set_muted(&umum, true).unwrap();
    a.chat
        .send(&umum, "lagi untuk Budi", None, vec![b.pk.clone()], vec![])
        .unwrap();
    pull(a, b);
    assert!(b.hooks.take_notifications().is_empty());
    assert_eq!(b.chat.overview().unwrap().notify, NotifyMode::Mentions);
}

#[test]
fn message_delete_converges_and_purges_bodies() {
    let o = office();
    connect_all(&o);
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let umum = o.umum();
    let m = a
        .chat
        .send(&umum, "salah kirim", None, vec![], vec![])
        .unwrap();
    sync(&[a, b, c]);
    assert!(
        b.chat.delete_message(&umum, &m.id).is_err(),
        "not the author, not admin"
    );
    a.chat.delete_message(&umum, &m.id).unwrap();
    sync(&[a, b, c]);
    for l in [a, b, c] {
        let ms = messages(l, &umum);
        assert!(ms[0].deleted && ms[0].text.is_empty());
        let body: i64 = l.count(&format!(
            "SELECT count(*) FROM chat_records WHERE id = '{}' AND body IS NULL",
            m.id
        ));
        assert_eq!(body, 1);
        let s = l.chat.overview().unwrap();
        let s = s.conversations.iter().find(|s| s.id == umum).unwrap();
        assert_eq!(s.last_preview.as_deref(), Some("Pesan dihapus"));
    }
}

#[test]
fn delete_arriving_before_its_message_still_converges() {
    let o = office();
    connect_all(&o);
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let umum = o.umum();
    let m = a
        .chat
        .send(&umum, "akan dihapus", None, vec![], vec![])
        .unwrap();
    pull(a, b);
    a.chat.delete_message(&umum, &m.id).unwrap();
    pull(a, c);
    let ms = messages(c, &umum);
    assert_eq!(ms.len(), 1, "placeholder");
    assert!(ms[0].deleted);
    pull(b, c);
    sync(&[a, b, c]);
    for l in [a, b, c] {
        let ms = messages(l, &umum);
        assert!(ms.iter().all(|x| x.deleted), "{}", l.name);
        assert_eq!(
            l.count(&format!(
                "SELECT count(*) FROM chat_records WHERE id = '{}' AND body IS NOT NULL",
                m.id
            )),
            0
        );
    }
}

#[test]
fn forged_delete_before_message_does_not_hide_it() {
    let o = office();
    connect_all(&o);
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let umum = o.umum();
    let m = a
        .chat
        .send(&umum, "pesan asli", None, vec![], vec![])
        .unwrap();
    // Budi claims to be the author of Sari's message and deletes it.
    let lie = sign_as(
        b,
        &o.org_id,
        crate::clock::now(),
        Body::MessageDelete {
            conv: umum.clone(),
            message: m.id.clone(),
            message_author: b.pk.clone(),
            message_at: m.at.clone(),
        },
    );
    let got = c.chat_ingest(&b.pk, vec![lie.to_feature_record()]);
    assert_eq!(
        got.accepted, 1,
        "judged by its claim until the message is known"
    );
    pull(a, c);
    let ms = messages(c, &umum);
    assert_eq!(ms.len(), 1);
    assert!(!ms[0].deleted);
    assert_eq!(ms[0].text, "pesan asli");
    assert_eq!(ms[0].author.public_key, a.pk);
}

#[test]
fn archive_and_delete_rights() {
    let o = Office::new(&[
        ("Sari", Who::Superadmin),
        ("Budi", Who::Member),
        ("Citra", Who::Member),
    ]);
    connect_all(&o);
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let umum = o.umum();
    assert_eq!(
        a.chat.set_archived(&umum, true).unwrap_err().code(),
        "forbidden"
    );
    assert_eq!(
        a.chat.delete_channel(&umum).unwrap_err().code(),
        "forbidden"
    );

    let (team, team_conv) = o.add_team(
        "Desain Interior",
        &[(&a.pk, false), (&b.pk, false), (&c.pk, true)],
    );
    let org_scope = NewChannelScope {
        kind: ScopeKind::Org,
        id: None,
    };
    assert_eq!(
        b.chat
            .create_channel("Gosip", org_scope.clone())
            .unwrap_err()
            .code(),
        "forbidden"
    );
    assert!(!b.chat.overview().unwrap().can_create_org_channel);
    assert!(a.chat.overview().unwrap().can_create_org_channel);
    let pengumuman = a.chat.create_channel("Pengumuman", org_scope).unwrap();
    assert_eq!(pengumuman.name, "pengumuman");
    let team_scope = NewChannelScope {
        kind: ScopeKind::Team,
        id: Some(team.clone()),
    };
    let sketsa = b
        .chat
        .create_channel("Sketsa Awal", team_scope.clone())
        .unwrap();
    assert_eq!(sketsa.scope.as_ref().unwrap().name, "Desain Interior");
    assert_eq!(
        b.chat
            .create_channel("sketsa-awal", team_scope)
            .unwrap_err()
            .code(),
        "invalid_input"
    );
    sync(&[a, b, c]);
    assert!(
        c.chat
            .overview()
            .unwrap()
            .conversations
            .iter()
            .any(|s| s.id == sketsa.id)
    );

    assert_eq!(
        b.chat.set_archived(&sketsa.id, true).unwrap_err().code(),
        "forbidden",
        "member"
    );
    assert_eq!(
        b.chat.set_archived(&team_conv, true).unwrap_err().code(),
        "forbidden"
    );
    c.chat.set_archived(&sketsa.id, true).unwrap(); // team admin
    sync(&[a, b, c]);
    let s = b.chat.overview().unwrap();
    let s = s.conversations.iter().find(|s| s.id == sketsa.id).unwrap();
    assert!(s.archived && !s.can_post);
    assert_eq!(
        b.chat
            .send(&sketsa.id, "masih bisa?", None, vec![], vec![])
            .unwrap_err()
            .code(),
        "forbidden"
    );
    a.chat.set_archived(&sketsa.id, false).unwrap(); // superadmin in the team
    sync(&[a, b, c]);
    for l in [a, b, c] {
        let s = l.chat.overview().unwrap();
        assert!(
            !s.conversations
                .iter()
                .find(|s| s.id == sketsa.id)
                .unwrap()
                .archived
        );
    }

    b.chat
        .send(&sketsa.id, "draf pertama", None, vec![], vec![])
        .unwrap();
    sync(&[a, b, c]);
    // A forged archive by a plain member waits (admin rights may arrive later).
    let forged = sign_as(
        b,
        &o.org_id,
        crate::clock::now(),
        Body::ChannelArchive {
            conv: sketsa.id.clone(),
            archived: true,
        },
    );
    let got = a.chat_ingest(&b.pk, vec![forged.to_feature_record()]);
    assert_eq!((got.accepted, got.rejected), (0, 0));
    let umum_archive = sign_as(
        b,
        &o.org_id,
        crate::clock::now(),
        Body::ChannelArchive {
            conv: umum.clone(),
            archived: true,
        },
    );
    assert_eq!(
        a.chat_ingest(&b.pk, vec![umum_archive.to_feature_record()])
            .rejected,
        1
    );

    c.chat.delete_channel(&sketsa.id).unwrap();
    sync(&[a, b, c]);
    for l in [a, b, c] {
        assert!(
            !l.chat
                .overview()
                .unwrap()
                .conversations
                .iter()
                .any(|s| s.id == sketsa.id)
        );
        assert_eq!(
            l.count(&format!(
                "SELECT count(*) FROM chat_messages WHERE conv = '{}'",
                sketsa.id
            )),
            0
        );
        assert_eq!(
            l.chat
                .conversation(&sketsa.id, None, 10)
                .unwrap_err()
                .code(),
            "not_found"
        );
    }
}

#[test]
fn replies_mentions_and_pages() {
    let o = office();
    connect_all(&o);
    let (a, b) = (&o.l[0], &o.l[1]);
    let umum = o.umum();
    let first = a
        .chat
        .send(&umum, "rapat jam 9", None, vec![], vec![])
        .unwrap();
    for i in 0..5 {
        a.chat
            .send(&umum, &format!("pesan {i}"), None, vec![], vec![])
            .unwrap();
    }
    let reply = b
        .chat
        .send(
            &umum,
            "siap",
            Some(first.id.clone()),
            vec![a.pk.clone(), "zz".into()],
            vec![],
        )
        .unwrap_err();
    assert_eq!(
        reply.code(),
        "invalid_input",
        "Budi has not received the message yet"
    );
    pull(a, b);
    let reply = b
        .chat
        .send(
            &umum,
            "siap",
            Some(first.id.clone()),
            vec![a.pk.clone(), "zz".into()],
            vec![],
        )
        .unwrap();
    assert_eq!(reply.reply_to.as_ref().unwrap().preview, "rapat jam 9");
    assert_eq!(reply.mentions.len(), 1, "unknown keys are dropped");
    let page = b.chat.conversation(&umum, None, 3).unwrap();
    assert_eq!(page.messages.len(), 3);
    assert!(page.has_more);
    assert_eq!(page.messages.last().unwrap().text, "siap");
    let older = b
        .chat
        .conversation(&umum, Some(page.messages[0].id.clone()), 10)
        .unwrap();
    assert_eq!(older.messages.len(), 4);
    assert!(!older.has_more);
    assert_eq!(older.messages[0].text, "rapat jam 9");
    assert_eq!(
        b.chat
            .send(&umum, "   ", None, vec![], vec![])
            .unwrap_err()
            .code(),
        "invalid_input"
    );
}

#[test]
fn english_setting_changes_notification_and_preview_text() {
    let o = office();
    connect_all(&o);
    let (a, b) = (&o.l[0], &o.l[1]);
    let umum = o.umum();
    b.with_conn(|c| crate::settings::set(c, crate::ui_lang::SETTING_LANGUAGE, "en"))
        .unwrap();
    a.chat.send(&umum, "Hello", None, vec![], vec![]).unwrap();
    pull(a, b);
    let notes = b.hooks.take_notifications();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].title, "Sari in #umum");
    assert_eq!(notes[0].body, "Hello");

    let m = a.chat.send(&umum, "oops", None, vec![], vec![]).unwrap();
    a.chat.delete_message(&umum, &m.id).unwrap();
    pull(a, b);
    let preview = |l: &crate::chat::testutil::Laptop| {
        l.chat
            .overview()
            .unwrap()
            .conversations
            .into_iter()
            .find(|s| s.id == umum)
            .unwrap()
            .last_preview
    };
    assert_eq!(preview(b).as_deref(), Some("Message deleted"));
    // The sender's laptop still uses Indonesian.
    assert_eq!(preview(a).as_deref(), Some("Pesan dihapus"));
}
