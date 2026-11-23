//! v0.3 groups over three and four laptops: who receives what, the owner's
//! rights, guests, removed members, forged and out-of-order ops.

use super::super::testutil::{Laptop, Office, Who, pull};
use super::super::view::{ChatSection, ConversationKind};
use super::{feature, sign_as, text_message};
use crate::chat::model::Body;
use crate::network::feature::FeatureSync;

fn office(n: usize) -> Office {
    let people = [
        ("Sari", Who::Superadmin),
        ("Budi", Who::Member),
        ("Citra", Who::Member),
        ("Dewi", Who::Member),
    ];
    let o = Office::new(&people[..n]);
    o.connect_all();
    o
}

fn sorted(keys: &[&Laptop]) -> Vec<String> {
    let mut out: Vec<String> = keys.iter().map(|l| l.pk.clone()).collect();
    out.sort();
    out
}

fn events(l: &Laptop, conv: &str) -> Vec<String> {
    l.chat
        .conversation(conv, None, 100)
        .unwrap()
        .events
        .into_iter()
        .map(|e| e.text)
        .collect()
}

fn owner(l: &Laptop, conv: &str) -> Option<String> {
    l.chat.group(conv).unwrap().owner.map(|p| p.public_key)
}

#[test]
fn group_reaches_its_members_and_never_an_outsider() {
    let o = office(3);
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let s = b
        .chat
        .create_group("Makan Siang", vec![a.pk.clone()])
        .unwrap();
    assert_eq!(
        (s.kind, s.section),
        (ConversationKind::Group, ChatSection::Grup)
    );
    let conv = s.id;
    assert!(conv.starts_with("gr:"));
    o.sync_all();

    let sa = a.summary(&conv).expect("Sari sees the group");
    assert_eq!(sa.section, ChatSection::Grup);
    assert_eq!(sa.name, "Makan Siang");
    assert!(sa.can_post && !sa.former);
    assert_eq!(sa.member_count, 2);
    a.chat
        .send(&conv, "nasi padang?", None, vec![], vec![])
        .unwrap();
    b.chat.send(&conv, "setuju", None, vec![], vec![]).unwrap();
    o.sync_all();
    for l in [a, b] {
        let mut t = l.texts(&conv);
        t.sort();
        assert_eq!(t, vec!["nasi padang?", "setuju"], "{}", l.name);
    }

    // Citra gets nothing of it, not even from Sari who is a member.
    assert_eq!(c.conv_records(&conv), 0);
    let ids: Vec<String> = a.records_of(&conv).into_iter().map(|(_, r)| r.id).collect();
    assert!(ids.len() >= 3);
    for _ in 0..3 {
        pull(a, c);
        pull(c, a);
        pull(b, c);
    }
    assert_eq!(
        c.count("SELECT count(*) FROM chat_records WHERE conv LIKE 'gr:%'"),
        0
    );
    let offered = a.chat.record_ids_for(&c.pk).unwrap();
    assert!(ids.iter().all(|id| !offered.contains(id)));
    assert!(a.chat.records_for(&c.pk, &ids).unwrap().is_empty());
    assert!(b.chat.records_for(&c.pk, &ids).unwrap().is_empty());
    assert!(c.summary(&conv).is_none());
    assert!(c.chat.conversation(&conv, None, 10).is_err());
    assert!(c.chat.group(&conv).is_err());
}

#[test]
fn add_rename_leave_and_remove_with_owner_passing_on() {
    let o = office(4);
    let (a, b, c, d) = (&o.l[0], &o.l[1], &o.l[2], &o.l[3]);
    let conv = b
        .chat
        .create_group("Tim Renovasi", vec![a.pk.clone()])
        .unwrap()
        .id;
    b.chat.group_add(&conv, vec![c.pk.clone()]).unwrap();
    b.chat.group_add(&conv, vec![d.pk.clone()]).unwrap();
    o.sync_all();
    for l in &o.l {
        assert_eq!(l.group_members(&conv), sorted(&[a, b, c, d]), "{}", l.name);
        assert_eq!(owner(l, &conv).as_deref(), Some(b.pk.as_str()));
    }
    let ev = events(a, &conv);
    assert_eq!(ev[0], "Budi membuat grup ini dan menambahkan Anda.");
    assert!(ev.contains(&"Budi menambahkan Citra.".to_owned()), "{ev:?}");
    assert_eq!(
        events(b, &conv)[0],
        "Anda membuat grup ini dan menambahkan Sari."
    );
    let view = a.chat.group(&conv).unwrap();
    assert!(view.can_add && view.can_rename && view.can_leave && !view.former);
    assert!(view.members.iter().all(|m| !m.can_remove), "only the owner");

    // A member renames; the owner leaves; ownership passes to Sari, the
    // member who has been in the group longest.
    c.chat
        .group_rename(&conv, "  Renovasi   Gedung B ")
        .unwrap();
    b.chat.group_leave(&conv).unwrap();
    o.sync_all();
    for l in [a, c, d] {
        let v = l.chat.group(&conv).unwrap();
        assert_eq!(v.name, "Renovasi Gedung B", "{}", l.name);
        assert_eq!(owner(l, &conv).as_deref(), Some(a.pk.as_str()));
        assert_eq!(l.group_members(&conv), sorted(&[a, c, d]));
    }
    let ev = events(c, &conv);
    for want in [
        "Anda mengganti nama grup menjadi \"Renovasi Gedung B\".",
        "Budi keluar dari grup.",
        "Sari sekarang pemilik grup.",
    ] {
        assert!(ev.contains(&want.to_owned()), "{want} not in {ev:?}");
    }
    let vb = b.chat.group(&conv).unwrap();
    assert!(vb.former && !vb.can_add && !vb.can_leave);
    let sb = b.summary(&conv).unwrap();
    assert!(sb.former && !sb.can_post);

    // The new owner removes Dewi.
    a.chat.group_remove(&conv, &d.pk).unwrap();
    o.sync_all();
    for l in [a, c, d] {
        assert_eq!(l.group_members(&conv), sorted(&[a, c]), "{}", l.name);
    }
    assert!(events(a, &conv).contains(&"Anda mengeluarkan Dewi.".to_owned()));
    assert!(events(d, &conv).contains(&"Sari mengeluarkan Anda.".to_owned()));
    assert!(d.chat.group(&conv).unwrap().former);
}

#[test]
fn only_the_owner_removes_and_only_members_add() {
    let o = office(4);
    let (a, b, c, d) = (&o.l[0], &o.l[1], &o.l[2], &o.l[3]);
    let conv = b
        .chat
        .create_group("Gudang", vec![a.pk.clone(), c.pk.clone()])
        .unwrap()
        .id;
    o.sync_all();
    assert_eq!(
        c.chat.group_remove(&conv, &a.pk).unwrap_err().code(),
        "forbidden"
    );

    let forged = sign_as(
        c,
        &o.org_id,
        crate::clock::now(),
        Body::GroupRemove {
            conv: conv.clone(),
            member: a.pk.clone(),
            deps: c.group_heads(&conv),
        },
    );
    for l in [a, b] {
        let got = l.chat_ingest(&c.pk, vec![feature(&forged)]);
        assert_eq!((got.accepted, got.rejected), (0, 1), "{}", l.name);
        assert_eq!(l.rejected_codes(), vec!["chat_not_group_owner"]);
        assert!(!l.has_record(&forged.id));
    }

    // Dewi is not in the group but got hold of its first record.
    let create = b.record_of(&conv, "group_create");
    let got = d.chat_ingest(&b.pk, vec![create.clone()]);
    assert_eq!(got.accepted, 1);
    let add = sign_as(
        d,
        &o.org_id,
        crate::clock::now(),
        Body::GroupAdd {
            conv: conv.clone(),
            members: vec![d.pk.clone()],
            deps: vec![create.id.clone()],
        },
    );
    for l in [a, b] {
        let got = l.chat_ingest(&d.pk, vec![feature(&add)]);
        assert_eq!((got.accepted, got.rejected), (0, 1), "{}", l.name);
        assert_eq!(l.rejected_codes().last().unwrap(), "chat_not_group_member");
        assert!(!l.has_record(&add.id));
    }
    o.sync_all();
    for l in &o.l {
        assert!(!l.has_record(&add.id) && !l.has_record(&forged.id));
    }
    assert_eq!(b.group_members(&conv), sorted(&[a, b, c]));
    assert!(d.summary(&conv).is_none_or(|s| s.former || !s.can_post));
}

#[test]
fn guests_cannot_make_join_or_be_added_to_groups() {
    let o = Office::new(&[
        ("Sari", Who::Superadmin),
        ("Budi", Who::Member),
        ("Gita", Who::Guest),
    ]);
    o.connect_all();
    let (a, b, g) = (&o.l[0], &o.l[1], &o.l[2]);
    assert!(!g.chat.overview().unwrap().can_create_group);
    assert_eq!(
        g.chat
            .create_group("Tamu", vec![a.pk.clone()])
            .unwrap_err()
            .code(),
        "forbidden"
    );
    let by_guest = sign_as(
        g,
        &o.org_id,
        crate::clock::now(),
        Body::GroupCreate {
            group: String::new(),
            name: "Tamu".into(),
            members: vec![a.pk.clone()],
        },
    );
    let got = a.chat_ingest(&g.pk, vec![feature(&by_guest)]);
    assert_eq!((got.accepted, got.rejected), (0, 1));
    assert_eq!(a.rejected_codes(), vec!["chat_forbidden"]);
    assert!(!a.has_record(&by_guest.id));

    assert_eq!(
        a.chat
            .create_group("Dengan Tamu", vec![g.pk.clone()])
            .unwrap_err()
            .code(),
        "forbidden"
    );
    let with_guest = sign_as(
        a,
        &o.org_id,
        crate::clock::now(),
        Body::GroupCreate {
            group: String::new(),
            name: "Dengan Tamu".into(),
            members: vec![g.pk.clone()],
        },
    );
    let got = b.chat_ingest(&a.pk, vec![feature(&with_guest)]);
    assert_eq!((got.accepted, got.rejected), (0, 1));
    assert_eq!(b.rejected_codes(), vec!["chat_guest_not_allowed"]);

    let conv = a.chat.create_group("Inti", vec![b.pk.clone()]).unwrap().id;
    o.sync_all();
    assert_eq!(
        a.chat
            .group_add(&conv, vec![g.pk.clone()])
            .unwrap_err()
            .code(),
        "forbidden"
    );
    let add = sign_as(
        a,
        &o.org_id,
        crate::clock::now(),
        Body::GroupAdd {
            conv: conv.clone(),
            members: vec![g.pk.clone()],
            deps: a.group_heads(&conv),
        },
    );
    let got = b.chat_ingest(&a.pk, vec![feature(&add)]);
    assert_eq!((got.accepted, got.rejected), (0, 1));
    assert_eq!(b.rejected_codes().last().unwrap(), "chat_guest_not_allowed");
    // A guest's message in the group is refused too.
    let msg = sign_as(
        g,
        &o.org_id,
        crate::clock::now(),
        text_message(&conv, "halo"),
    );
    let got = b.chat_ingest(&g.pk, vec![feature(&msg)]);
    assert_eq!((got.accepted, got.rejected), (0, 1));
    o.sync_all();
    assert_eq!(b.group_members(&conv), sorted(&[a, b]));
    assert_eq!(
        g.count("SELECT count(*) FROM chat_records WHERE conv LIKE 'gr:%'"),
        0
    );
}

/// Budi's group with Sari and Citra; Budi removes Citra. Returns the group
/// and the heads Citra knew before.
fn group_without_citra(o: &Office) -> (String, Vec<String>) {
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let conv = b
        .chat
        .create_group("Proyek Atap", vec![a.pk.clone(), c.pk.clone()])
        .unwrap()
        .id;
    o.sync_all();
    b.chat.send(&conv, "sebelum", None, vec![], vec![]).unwrap();
    o.sync_all();
    assert_eq!(c.texts(&conv), vec!["sebelum"]);
    let old_heads = c.group_heads(&conv);
    b.chat.group_remove(&conv, &c.pk).unwrap();
    b.chat.send(&conv, "sesudah", None, vec![], vec![]).unwrap();
    o.sync_all();
    (conv, old_heads)
}

#[test]
fn removed_member_keeps_old_messages_and_gets_nothing_new() {
    let o = office(3);
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let (conv, _) = group_without_citra(&o);
    for l in [a, b] {
        let mut t = l.texts(&conv);
        t.sort();
        assert_eq!(t, vec!["sebelum", "sesudah"], "{}", l.name);
    }
    assert_eq!(c.texts(&conv), vec!["sebelum"]);
    assert!(
        c.records_of(&conv).iter().any(|(k, _)| k == "group_remove"),
        "Citra's laptop learns she is out"
    );
    let v = c.chat.group(&conv).unwrap();
    assert!(v.former && !v.can_add && !v.can_rename && !v.can_leave);
    assert!(v.candidates.is_empty());
    let s = c.summary(&conv).expect("still listed");
    assert_eq!(s.section, ChatSection::Grup);
    assert!(s.former && !s.can_post);
    assert!(
        s.post_blocked_reason
            .as_deref()
            .is_some_and(|r| r.starts_with("Anda sudah tidak ada di grup ini")),
        "{:?}",
        s.post_blocked_reason
    );
    assert!(events(c, &conv).contains(&"Budi mengeluarkan Anda.".to_owned()));
    assert!(c.chat.send(&conv, "masih?", None, vec![], vec![]).is_err());
    assert!(c.chat.group_leave(&conv).is_err());

    // Her later message is not taken by the members.
    let late = sign_as(
        c,
        &o.org_id,
        crate::clock::now() + time::Duration::hours(1),
        text_message(&conv, "titip pesan"),
    );
    let got = a.chat_ingest(&c.pk, vec![feature(&late)]);
    assert_eq!(got.accepted, 0);
    assert!(!a.has_record(&late.id));
}

#[test]
fn backdated_add_by_a_removed_member_adds_nobody() {
    let o = office(4);
    let (a, b, c, d) = (&o.l[0], &o.l[1], &o.l[2], &o.l[3]);
    let (conv, old_heads) = group_without_citra(&o);
    let forged = sign_as(
        c,
        &o.org_id,
        crate::clock::now() - time::Duration::hours(1),
        Body::GroupAdd {
            conv: conv.clone(),
            members: vec![d.pk.clone()],
            deps: old_heads,
        },
    );
    for l in [a, b] {
        l.chat_ingest(&c.pk, vec![feature(&forged)]);
    }
    o.sync_all();
    for l in [a, b] {
        assert_eq!(l.group_members(&conv), sorted(&[a, b]), "{}", l.name);
    }
    assert_eq!(d.conv_records(&conv), 0);
    assert!(d.summary(&conv).is_none());
    b.chat.send(&conv, "rahasia", None, vec![], vec![]).unwrap();
    o.sync_all();
    assert_eq!(d.conv_records(&conv), 0);
}

#[test]
fn group_ops_out_of_order_converge() {
    let o = office(3);
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let conv = b.chat.create_group("Satu", vec![a.pk.clone()]).unwrap().id;
    b.chat.group_add(&conv, vec![c.pk.clone()]).unwrap();
    b.chat.group_rename(&conv, "Dua").unwrap();
    let recs = b.records_of(&conv);
    let kinds: Vec<&str> = recs.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(kinds, vec!["group_create", "group_add", "group_rename"]);
    let recs: Vec<_> = recs.into_iter().map(|(_, r)| r).collect();

    // One batch, newest first.
    let mut reversed = recs.clone();
    reversed.reverse();
    let got = a.chat_ingest(&b.pk, reversed);
    assert_eq!((got.accepted, got.rejected), (3, 0));
    assert_eq!(a.group_members(&conv), sorted(&[a, b, c]));
    assert_eq!(a.group_state(&conv).unwrap().name, "Dua");

    // Separate batches, newest first: each waits for what it builds on.
    let got = c.chat_ingest(&b.pk, vec![recs[2].clone()]);
    assert_eq!((got.accepted, got.rejected), (0, 0));
    let got = c.chat_ingest(&b.pk, vec![recs[1].clone()]);
    assert_eq!((got.accepted, got.rejected), (0, 0));
    assert_eq!(c.conv_records(&conv), 0);
    let got = c.chat_ingest(&b.pk, vec![recs[0].clone()]);
    assert_eq!((got.accepted, got.rejected), (1, 0));
    assert_eq!(c.group_members(&conv), sorted(&[a, b]));
    o.sync_all();
    assert!(c.rejected_codes().is_empty() && a.rejected_codes().is_empty());
    let heads = b.group_heads(&conv);
    for l in &o.l {
        assert_eq!(l.group_members(&conv), sorted(&[a, b, c]), "{}", l.name);
        assert_eq!(l.group_state(&conv).unwrap().name, "Dua");
        assert_eq!(l.group_heads(&conv), heads);
        assert_eq!(l.chat.group(&conv).unwrap().name, "Dua");
    }
}
