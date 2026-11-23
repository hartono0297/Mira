//! v0.4: a group may start with only its creator, and a project's built-in
//! chat is shown as a group of the project's members.

use super::super::testutil::{Laptop, Office, Who};
use super::super::view::{ChatSection, ConversationKind};
use super::{feature, sign_as};
use crate::chat::model::{self, Body};

fn office() -> Office {
    let o = Office::new(&[
        ("Sari", Who::Superadmin),
        ("Budi", Who::Member),
        ("Citra", Who::Member),
    ]);
    o.connect_all();
    o
}

fn send(l: &Laptop, conv: &str, text: &str) {
    l.chat.send(conv, text, None, vec![], vec![]).unwrap();
}

#[test]
fn group_with_only_its_creator_then_people_added_later() {
    let o = office();
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let s = b.chat.create_group("Catatan Pribadi", vec![]).unwrap();
    assert_eq!(
        (s.kind, s.section, s.member_count),
        (ConversationKind::Group, ChatSection::Grup, 1)
    );
    let conv = s.id;
    send(b, &conv, "draf pertama");
    o.sync_all();
    assert_eq!(a.conv_records(&conv), 0);
    assert_eq!(c.conv_records(&conv), 0);

    let g = b.chat.group(&conv).unwrap();
    assert_eq!(g.members.len(), 1);
    assert!(g.members[0].me && g.members[0].owner);
    assert!(g.can_add && g.can_leave);
    let events: Vec<String> = b
        .chat
        .conversation(&conv, None, 100)
        .unwrap()
        .events
        .into_iter()
        .map(|e| e.text)
        .collect();
    assert_eq!(events, vec!["Anda membuat grup ini."]);

    // Adding nobody is still refused.
    assert!(b.chat.group_add(&conv, vec![]).is_err());
    assert!(b.chat.group_add(&conv, vec![b.pk.clone()]).is_err());

    b.chat.group_add(&conv, vec![a.pk.clone()]).unwrap();
    o.sync_all();
    let sa = a.summary(&conv).expect("Sari now sees the group");
    assert_eq!(sa.member_count, 2);
    assert_eq!(a.texts(&conv), vec!["draf pertama"]);
    send(a, &conv, "sudah saya baca");
    o.sync_all();
    assert_eq!(b.texts(&conv), vec!["draf pertama", "sudah saya baca"]);
    assert_eq!(c.conv_records(&conv), 0);
}

#[test]
fn creator_alone_can_leave_and_the_group_ends_former() {
    let o = office();
    let b = &o.l[1];
    let conv = b.chat.create_group("Sendiri", vec![]).unwrap().id;
    b.chat.group_leave(&conv).unwrap();
    let s = b.summary(&conv).expect("kept, read-only");
    assert!(s.former && !s.can_post);
    assert_eq!(s.member_count, 0);
}

#[test]
fn project_chat_is_a_group_of_the_project_members() {
    let o = office();
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let p = o.add_project("Renovasi Kantor Klien", None, &b.pk, &[&a.pk]);
    let conv = model::channel_conv(&p);

    let sb = b.summary(&conv).expect("Budi sees his project chat");
    assert_eq!(sb.kind, ConversationKind::Project);
    assert_eq!(sb.section, ChatSection::Proyek);
    assert_eq!(sb.name, "Renovasi Kantor Klien");
    assert_eq!(sb.member_count, 2);
    assert!(sb.can_post && !sb.former);
    // It lives as long as the project: no archive, no delete, even for the
    // project manager.
    assert!(!sb.can_archive && !sb.can_delete && !sb.can_lock);
    assert!(b.chat.set_archived(&conv, true).is_err());
    assert!(b.chat.delete_channel(&conv).is_err());
    assert!(c.summary(&conv).is_none());
    // Someone outside the project cannot read its member list.
    assert!(c.chat.project_chat(&conv).is_err());

    // Never in Umum, on any laptop.
    for l in [a, b] {
        let overview = l.chat.overview().unwrap();
        for s in &overview.conversations {
            if s.id == conv {
                assert_eq!(s.section, ChatSection::Proyek, "{}", l.name);
            }
            if s.section == ChatSection::Umum {
                assert_ne!(s.kind, ConversationKind::Project, "{}", l.name);
            }
        }
    }

    let v = b.chat.project_chat(&conv).unwrap();
    assert_eq!(v.project_id, p);
    assert_eq!(v.name, "Renovasi Kantor Klien");
    assert!(v.can_manage && !v.former);
    let names: Vec<(&str, bool, bool)> = v
        .members
        .iter()
        .map(|m| (m.person.name.as_str(), m.me, m.manager))
        .collect();
    // Sari is a superadmin and a member, so the board makes her a manager too.
    assert_eq!(names, vec![("Budi", true, true), ("Sari", false, true)]);

    send(b, &conv, "jadwal survei");
    o.sync_all();
    assert_eq!(a.texts(&conv), vec!["jadwal survei"]);
    assert_eq!(c.conv_records(&conv), 0);

    // Members follow the project: Citra joins and receives the history.
    o.add_project_member(&p, &c.pk);
    o.sync_all();
    let sc = c.summary(&conv).expect("Citra joined the project");
    assert_eq!(sc.kind, ConversationKind::Project);
    assert_eq!(sc.member_count, 3);
    assert_eq!(c.texts(&conv), vec!["jadwal survei"]);
    assert_eq!(b.chat.project_chat(&conv).unwrap().members.len(), 3);
    let vc = c.chat.project_chat(&conv).unwrap();
    assert!(!vc.can_manage && !vc.former);
    assert!(vc.members.iter().any(|m| m.me && !m.manager && m.person.name == "Citra"));

    // Sari leaves the project: the count drops, her chat turns former.
    o.exec(
        "DELETE FROM project_members WHERE project_id = ?1 AND public_key = ?2",
        &[&p, &a.pk],
    );
    assert_eq!(b.summary(&conv).unwrap().member_count, 2);
    let sa = a.summary(&conv).expect("kept, read-only");
    assert!(sa.former && !sa.can_post);
    assert!(a.chat.project_chat(&conv).unwrap().former);

    // A group or another channel is not a project chat.
    let gr = b.chat.create_group("Biasa", vec![]).unwrap().id;
    assert!(b.chat.project_chat(&gr).is_err());
    assert!(b.chat.project_chat(&o.umum()).is_err());
}

#[test]
fn project_chat_notification_names_the_project() {
    let o = office();
    let (a, b) = (&o.l[0], &o.l[1]);
    let p = o.add_project("Alfa", None, &b.pk, &[&a.pk]);
    let conv = model::channel_conv(&p);
    a.hooks.take_notifications();
    send(b, &conv, "rapat jam 3");
    o.sync_all();
    let n = a.hooks.take_notifications();
    assert!(
        n.iter().any(|n| n.conv == conv && n.title == "Budi di Proyek Alfa"),
        "{n:?}"
    );
}

#[test]
fn peers_cannot_archive_or_delete_a_project_chat_but_may_restore_an_old_archive() {
    let o = office();
    let (a, b) = (&o.l[0], &o.l[1]);
    let p = o.add_project("Alfa", None, &a.pk, &[&b.pk]);
    let conv = model::channel_conv(&p);

    // A v0.3 laptop (or a modified one) of the project manager sends both.
    let now = crate::clock::now();
    let del = sign_as(a, &o.org_id, now, Body::ChannelDelete { conv: conv.clone() });
    let arch = sign_as(
        a,
        &o.org_id,
        now,
        Body::ChannelArchive {
            conv: conv.clone(),
            archived: true,
        },
    );
    let got = b.chat_ingest(&a.pk, vec![feature(&del), feature(&arch)]);
    assert_eq!((got.accepted, got.rejected), (0, 2));
    assert!(!b.has_record(&del.id) && !b.has_record(&arch.id));
    let sb = b.summary(&conv).expect("still there");
    assert!(!sb.archived && sb.can_post);

    // An archive v0.3 left behind can still be restored by the manager.
    o.exec(
        "INSERT INTO chat_channels (conv, archived, archive_at) VALUES (?1, 1, '2020-01-01T00:00:00Z')",
        &[&conv],
    );
    let sb = b.summary(&conv).unwrap();
    assert!(sb.archived && !sb.can_post && !sb.can_archive);
    assert!(
        sb.post_blocked_reason
            .as_deref()
            .is_some_and(|r| r.starts_with("Chat proyek ini diarsipkan")),
        "{:?}",
        sb.post_blocked_reason
    );
    let sa = a.summary(&conv).unwrap();
    assert!(sa.can_archive && !sa.can_delete);
    a.chat.set_archived(&conv, false).unwrap();
    o.sync_all();
    for l in [a, b] {
        let s = l.summary(&conv).unwrap();
        assert!(!s.archived && s.can_post, "{}", l.name);
    }
}

#[test]
fn project_label_does_not_repeat_proyek() {
    use crate::chat::sync::project_label;
    assert_eq!(project_label("Alfa"), "Proyek Alfa");
    assert_eq!(project_label("Proyek Lintas Kantor"), "Proyek Lintas Kantor");
    assert_eq!(project_label("proyek kecil"), "proyek kecil");
    assert_eq!(project_label("Proyeksi"), "Proyek Proyeksi");
    assert_eq!(project_label("É"), "Proyek É");
}

#[test]
fn folded_sections_are_kept_per_laptop_in_the_database() {
    let o = office();
    let (a, b) = (&o.l[0], &o.l[1]);
    assert!(a.chat.overview().unwrap().folded.is_empty());
    let names = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    a.chat
        .set_folded(&names(&["grup", "umum", "bukan-bagian", "grup"]))
        .unwrap();
    assert_eq!(
        a.chat.overview().unwrap().folded,
        vec![ChatSection::Umum, ChatSection::Grup]
    );
    // Another laptop keeps its own.
    o.sync_all();
    assert!(b.chat.overview().unwrap().folded.is_empty());
    a.chat.set_folded(&[]).unwrap();
    assert!(a.chat.overview().unwrap().folded.is_empty());
}
