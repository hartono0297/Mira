//! v0.3 Umum channels: only superadmins make them, the v0.2 migration rule,
//! and read-only (`channel_lock`) channels.

use super::super::testutil::{Office, Who, sync};
use super::super::view::{ChatSection, NewChannelScope, ScopeKind};
use super::{feature, sign_as, text_message};
use crate::chat::model::{Body, ChannelScope};

fn office() -> Office {
    let o = Office::new(&[
        ("Sari", Who::Superadmin),
        ("Budi", Who::Member),
        ("Citra", Who::Member),
    ]);
    o.connect_all();
    o
}

fn org_scope() -> NewChannelScope {
    NewChannelScope {
        kind: ScopeKind::Org,
        id: None,
    }
}

fn org_channel(name: &str) -> Body {
    Body::ChannelCreate {
        channel: String::new(),
        name: name.to_owned(),
        scope: ChannelScope::Org,
    }
}

#[test]
fn superadmin_umum_channel_reaches_every_full_member_but_no_guest() {
    let o = Office::new(&[
        ("Sari", Who::Superadmin),
        ("Budi", Who::Member),
        ("Gita", Who::Guest),
    ]);
    o.connect_all();
    let (a, b, g) = (&o.l[0], &o.l[1], &o.l[2]);
    let s = a.chat.create_channel("pengumuman", org_scope()).unwrap();
    assert_eq!(s.section, ChatSection::Umum);
    assert!(s.can_lock && !s.locked);
    a.chat
        .send(&s.id, "rapat jam sembilan", None, vec![], vec![])
        .unwrap();
    o.sync_all();

    let sb = b.summary(&s.id).expect("Budi sees the Umum channel");
    assert_eq!(sb.section, ChatSection::Umum);
    assert!(sb.can_post && !sb.former && !sb.can_lock);
    assert_eq!(b.texts(&s.id), vec!["rapat jam sembilan"]);
    let kinds: Vec<String> = b.records_of(&s.id).into_iter().map(|(k, _)| k).collect();
    assert!(kinds.contains(&"channel_create".to_owned()) && kinds.contains(&"message".to_owned()));

    assert_eq!(g.conv_records(&s.id), 0);
    assert!(g.summary(&s.id).is_none());
    assert!(g.chat.conversation(&s.id, None, 10).is_err());
}

#[test]
fn member_cannot_make_an_umum_channel_and_a_forged_one_is_rejected() {
    let o = office();
    let (b, c) = (&o.l[1], &o.l[2]);
    assert_eq!(
        b.chat
            .create_channel("gosip", org_scope())
            .unwrap_err()
            .code(),
        "forbidden"
    );
    assert!(!b.chat.overview().unwrap().can_create_org_channel);

    let rec = sign_as(b, &o.org_id, crate::clock::now(), org_channel("gosip"));
    let conv = rec.body().conv().unwrap();
    let got = c.chat_ingest(&b.pk, vec![feature(&rec)]);
    assert_eq!((got.accepted, got.rejected), (0, 1));
    assert_eq!(c.rejected_codes(), vec!["chat_forbidden"]);
    assert!(!c.has_record(&rec.id));
    assert_eq!(
        c.count(&format!(
            "SELECT count(*) FROM chat_channels WHERE conv = '{conv}'"
        )),
        0
    );
    assert!(c.summary(&conv).is_none());
}

#[test]
fn umum_channel_of_someone_superadmin_at_the_time_stays_valid() {
    let o = office();
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    // Sari founded the office; she loses the superadmin role everywhere.
    o.exec(
        "UPDATE members SET is_superadmin = 0, role = 'member' WHERE public_key = ?1",
        &[&a.pk],
    );
    assert_eq!(
        a.chat
            .create_channel("baru", org_scope())
            .unwrap_err()
            .code(),
        "forbidden"
    );

    // A channel she made while founder (v0.2) is still accepted.
    let old = sign_as(a, &o.org_id, crate::clock::now(), org_channel("lama"));
    let conv = old.body().conv().unwrap();
    let got = b.chat_ingest(&a.pk, vec![feature(&old)]);
    assert_eq!((got.accepted, got.rejected), (1, 0));
    assert!(
        b.summary(&conv)
            .is_some_and(|s| s.section == ChatSection::Umum)
    );

    // Before the organization existed she was nobody's superadmin.
    let created = a.with_conn(|conn| crate::org::load_organization(conn).unwrap().unwrap());
    let created = crate::permissions::format::parse_time(&created.created_at).unwrap();
    let early = sign_as(
        a,
        &o.org_id,
        created - time::Duration::days(1),
        org_channel("terlalu-awal"),
    );
    let got = b.chat_ingest(&a.pk, vec![feature(&early)]);
    assert_eq!((got.accepted, got.rejected), (0, 1));
    assert!(!b.has_record(&early.id));

    // Budi was never a superadmin.
    let never = sign_as(b, &o.org_id, crate::clock::now(), org_channel("budi"));
    let got = c.chat_ingest(&b.pk, vec![feature(&never)]);
    assert_eq!((got.accepted, got.rejected), (0, 1));
    assert_eq!(c.rejected_codes().last().unwrap(), "chat_forbidden");
    assert!(!c.has_record(&never.id));

    // Every laptop ends up with the same: the old channel only.
    sync(&[a, b, c]);
    for l in &o.l {
        assert!(l.has_record(&old.id), "{}", l.name);
        assert!(!l.has_record(&never.id) && !l.has_record(&early.id));
    }
}

#[test]
fn locked_umum_channel_is_read_only_for_members_and_converges() {
    let o = office();
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let conv = a.chat.create_channel("pengumuman", org_scope()).unwrap().id;
    o.sync_all();
    b.chat
        .send(&conv, "sebelum dikunci", None, vec![], vec![])
        .unwrap();
    o.sync_all();

    assert_eq!(
        b.chat.set_locked(&conv, true).unwrap_err().code(),
        "forbidden"
    );
    a.chat.set_locked(&conv, true).unwrap();
    a.chat
        .send(&conv, "dari superadmin", None, vec![], vec![])
        .unwrap();
    o.sync_all();

    for l in [b, c] {
        let s = l.summary(&conv).unwrap();
        assert!(s.locked && !s.can_post && !s.can_lock, "{}", l.name);
        assert!(
            s.post_blocked_reason
                .as_deref()
                .is_some_and(|r| r.starts_with("Hanya superadmin")),
            "{:?}",
            s.post_blocked_reason
        );
    }
    let sa = a.summary(&conv).unwrap();
    assert!(sa.locked && sa.can_post && sa.can_lock);
    assert!(b.chat.send(&conv, "boleh?", None, vec![], vec![]).is_err());

    // A message signed after the lock (an older laptop) is still kept, so
    // every laptop stores the same records.
    let late = sign_as(
        b,
        &o.org_id,
        crate::clock::now(),
        text_message(&conv, "terlambat"),
    );
    let got = c.chat_ingest(&b.pk, vec![feature(&late)]);
    assert_eq!((got.accepted, got.rejected), (1, 0));

    // A member's lock record is refused.
    let unlock = sign_as(
        b,
        &o.org_id,
        crate::clock::now() + time::Duration::seconds(5),
        Body::ChannelLock {
            conv: conv.clone(),
            locked: false,
        },
    );
    let got = c.chat_ingest(&b.pk, vec![feature(&unlock)]);
    assert_eq!((got.accepted, got.rejected), (0, 1));
    assert_eq!(c.rejected_codes().last().unwrap(), "chat_forbidden");
    assert!(c.summary(&conv).unwrap().locked);

    o.sync_all();
    let want = vec!["dari superadmin", "sebelum dikunci", "terlambat"];
    for l in &o.l {
        let mut got = l.texts(&conv);
        got.sort();
        assert_eq!(got, want, "{}", l.name);
        assert!(!l.has_record(&unlock.id));
        assert!(l.summary(&conv).unwrap().locked);
    }

    a.chat.set_locked(&conv, false).unwrap();
    o.sync_all();
    let s = b.summary(&conv).unwrap();
    assert!(!s.locked && s.can_post && s.post_blocked_reason.is_none());
}

#[test]
fn umum_itself_cannot_be_locked() {
    let o = office();
    let (a, b) = (&o.l[0], &o.l[1]);
    let umum = o.umum();
    assert_eq!(
        a.chat.set_locked(&umum, true).unwrap_err().code(),
        "forbidden"
    );
    assert!(!a.summary(&umum).unwrap().can_lock);
    let rec = sign_as(
        a,
        &o.org_id,
        crate::clock::now(),
        Body::ChannelLock {
            conv: umum.clone(),
            locked: true,
        },
    );
    let got = b.chat_ingest(&a.pk, vec![feature(&rec)]);
    assert_eq!((got.accepted, got.rejected), (0, 1));
    assert_eq!(b.rejected_codes(), vec!["chat_forbidden"]);
    let s = b.summary(&umum).unwrap();
    assert!(!s.locked && s.can_post);
}
