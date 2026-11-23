//! v0.3 project and department channels: the audience follows membership
//! now, people who leave keep what they have read-only (`former`), and
//! unregistered v0.2 projects reach nobody.

use super::super::testutil::{Laptop, Office, Who};
use super::super::view::ChatSection;
use super::{feature, sign_as, text_message};
use crate::chat::model;
use crate::network::feature::FeatureSync;

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
fn project_channel_follows_project_membership() {
    let o = office();
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let p = o.add_project("Renovasi Kantor Klien", None, &a.pk, &[&b.pk]);
    let conv = model::channel_conv(&p);
    send(a, &conv, "jadwal survei");
    o.sync_all();
    assert_eq!(b.texts(&conv), vec!["jadwal survei"]);
    assert_eq!(c.conv_records(&conv), 0);
    assert!(c.summary(&conv).is_none());
    assert!(a.chat.record_ids_for(&c.pk).unwrap().is_empty());
    let sb = b.summary(&conv).unwrap();
    assert_eq!(sb.section, ChatSection::Proyek);
    assert!(sb.can_post && !sb.former);

    // `project_member_remove` for Budi, as the fold leaves it everywhere.
    o.exec(
        "DELETE FROM project_members WHERE project_id = ?1 AND public_key = ?2",
        &[&p, &b.pk],
    );
    send(a, &conv, "anggaran baru");
    o.sync_all();
    assert_eq!(b.texts(&conv), vec!["jadwal survei"]);
    assert_eq!(a.texts(&conv), vec!["jadwal survei", "anggaran baru"]);
    assert_eq!(c.conv_records(&conv), 0);
    let sb = b.summary(&conv).expect("kept, read-only");
    assert_eq!(sb.section, ChatSection::Proyek);
    assert!(sb.former && !sb.can_post);
    assert!(
        sb.post_blocked_reason
            .as_deref()
            .is_some_and(|r| r.starts_with("Anda sudah bukan anggota proyek ini")),
        "{:?}",
        sb.post_blocked_reason
    );
    assert_eq!(messages_len(b, &conv), 1);
    assert!(b.chat.send(&conv, "masih?", None, vec![], vec![]).is_err());

    // Her later message is not taken.
    let late = sign_as(
        b,
        &o.org_id,
        crate::clock::now(),
        text_message(&conv, "titip"),
    );
    let got = a.chat_ingest(&b.pk, vec![feature(&late)]);
    assert_eq!(got.accepted, 0);
}

fn messages_len(l: &Laptop, conv: &str) -> usize {
    l.chat.conversation(conv, None, 100).unwrap().messages.len()
}

#[test]
fn department_channel_follows_the_department_and_archive_makes_it_read_only() {
    let o = office();
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let (t1, keu) = o.add_team("Keuangan", &[(&a.pk, true), (&b.pk, false)]);
    let (t2, lap) = o.add_team("Lapangan", &[(&c.pk, true)]);
    send(a, &keu, "laporan bulan ini");
    send(c, &lap, "cuaca cerah");
    o.sync_all();
    assert_eq!(b.texts(&keu), vec!["laporan bulan ini"]);
    assert_eq!(c.conv_records(&keu), 0);
    assert_eq!(a.conv_records(&lap), 0);
    assert_eq!(b.conv_records(&lap), 0);
    let sb = b.summary(&keu).unwrap();
    assert_eq!(sb.section, ChatSection::Departemen);
    assert!(sb.can_post && !sb.former);

    // Budi moves from Keuangan to Lapangan.
    o.exec(
        "DELETE FROM team_members WHERE team_id = ?1 AND public_key = ?2",
        &[&t1, &b.pk],
    );
    o.exec(
        "INSERT INTO team_members (team_id, public_key, role, added_at) VALUES (?1, ?2, 'member', 't')",
        &[&t2, &b.pk],
    );
    send(a, &keu, "gaji cair");
    send(c, &lap, "hujan");
    o.sync_all();
    assert_eq!(b.texts(&keu), vec!["laporan bulan ini"]);
    let mut lap_b = b.texts(&lap);
    lap_b.sort();
    assert_eq!(lap_b, vec!["cuaca cerah", "hujan"]);
    assert_eq!(c.conv_records(&keu), 0);
    let sb = b.summary(&keu).unwrap();
    assert!(sb.former && !sb.can_post);
    assert!(
        sb.post_blocked_reason
            .as_deref()
            .is_some_and(|r| r.starts_with("Anda sudah tidak di departemen ini")),
        "{:?}",
        sb.post_blocked_reason
    );
    let sl = b.summary(&lap).unwrap();
    assert!(sl.can_post && !sl.former);
    assert_eq!(b.chat.overview().unwrap().my_department.unwrap().id, t2);

    // Lapangan is archived: its channel is read-only for everyone in it.
    o.exec("UPDATE teams SET archived = 1 WHERE id = ?1", &[&t2]);
    for l in [b, c] {
        let s = l.summary(&lap).unwrap();
        assert!(!s.can_post, "{}", l.name);
        assert_eq!(
            s.post_blocked_reason.as_deref(),
            Some("Departemen ini diarsipkan, jadi channelnya hanya bisa dibaca.")
        );
        assert!(l.chat.send(&lap, "masih?", None, vec![], vec![]).is_err());
    }
    assert_eq!(c.texts(&lap).len(), 2, "messages stay readable");
}

#[test]
fn unregistered_v02_project_channel_reaches_nobody() {
    let o = office();
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let p = o.add_project("Gudang Lama", None, &a.pk, &[&b.pk, &c.pk]);
    let conv = model::channel_conv(&p);
    // Messages from v0.2 times, on Sari's laptop only.
    send(a, &conv, "stok semen");
    // The project was never registered (v0.2): board row, no `projects`.
    o.exec("DELETE FROM project_members WHERE project_id = ?1", &[&p]);
    o.exec("DELETE FROM projects WHERE id = ?1", &[&p]);
    assert_eq!(
        a.count(&format!(
            "SELECT count(*) FROM board_projects WHERE id = '{p}' AND bound = 1"
        )),
        1
    );

    o.sync_all();
    for l in [b, c] {
        assert_eq!(l.conv_records(&conv), 0, "{}", l.name);
        assert!(a.chat.record_ids_for(&l.pk).unwrap().is_empty());
    }
    let ids: Vec<String> = a.records_of(&conv).into_iter().map(|(_, r)| r.id).collect();
    assert!(a.chat.records_for(&b.pk, &ids).unwrap().is_empty());

    // Sari keeps it read-only.
    let sa = a.summary(&conv).expect("still listed for Sari");
    assert!(sa.former && !sa.can_post);
    assert_eq!(a.texts(&conv), vec!["stok semen"]);

    // A record for it from Budi waits; nothing is stored.
    let rec = sign_as(
        b,
        &o.org_id,
        crate::clock::now(),
        text_message(&conv, "halo"),
    );
    let got = c.chat_ingest(&b.pk, vec![feature(&rec)]);
    assert_eq!(got.accepted, 0);
    assert!(!c.has_record(&rec.id));
}
