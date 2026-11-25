//! v0.6 division chats and announcement mode (docs/plans/dept-divisi.md
//! section 6). Division rows are written directly on every laptop, like the
//! fold would leave them.

use time::{Duration, OffsetDateTime};

use super::super::audience::{BoardAudience, Ctx};
use super::super::testutil::{Laptop, Office, Who};
use super::super::view::{ChatSection, ConversationKind, ScopeKind};
use super::{feature, sign_as, text_message};
use crate::chat::model::{self, Body};
use crate::permissions::format::format_time;

const SARI: usize = 0; // superadmin, not in the department
const BUDI: usize = 1; // head of Mobile
const CITRA: usize = 2; // member of Mobile
const DEWI: usize = 3; // admin of the department, not in Mobile
const EKO: usize = 4; // in the department, not in Mobile
const GITA: usize = 5; // guest recorded in Mobile

struct Setup {
    o: Office,
    team: String,
    team_conv: String,
    division: String,
    conv: String,
}

fn setup() -> Setup {
    let o = Office::new(&[
        ("Sari", Who::Superadmin),
        ("Budi", Who::Member),
        ("Citra", Who::Member),
        ("Dewi", Who::Member),
        ("Eko", Who::Member),
        ("Gita", Who::Guest),
    ]);
    o.connect_all();
    let pk = |i: usize| o.l[i].pk.clone();
    let (team, team_conv) = o.add_team(
        "IT",
        &[
            (&pk(BUDI), false),
            (&pk(CITRA), false),
            (&pk(DEWI), true),
            (&pk(EKO), false),
            (&pk(GITA), false),
        ],
    );
    let division = add_division(
        &o,
        &team,
        "Mobile",
        &[(&pk(BUDI), true), (&pk(CITRA), false), (&pk(GITA), false)],
    );
    let conv = model::channel_conv(&division);
    Setup {
        o,
        team,
        team_conv,
        division,
        conv,
    }
}

fn add_division(o: &Office, team: &str, name: &str, members: &[(&str, bool)]) -> String {
    let id = model::random_hex32();
    o.exec(
        "INSERT INTO divisions (id, team_id, name, created_at, created_by) VALUES (?1, ?2, ?3, 't', 'x')",
        &[&id, team, name],
    );
    for (pk, head) in members {
        add_member(o, &id, pk, *head);
    }
    id
}

fn add_member(o: &Office, division: &str, pk: &str, head: bool) {
    o.exec(
        "INSERT INTO division_members (division_id, public_key, head, added_at, added_by)
         VALUES (?1, ?2, ?3, 't', 'x')",
        &[division, pk, if head { "1" } else { "0" }],
    );
}

fn set_announce(o: &Office, team: &str, division: &str, at: OffsetDateTime) {
    o.exec(
        "INSERT OR REPLACE INTO chat_settings (team_id, division_id, pinned, announce, set_at, set_by)
         VALUES (?1, ?2, '', 1, ?3, 'x')",
        &[team, division, &format_time(at)],
    );
}

fn send(l: &Laptop, conv: &str, text: &str) {
    l.chat.send(conv, text, None, vec![], vec![]).unwrap();
}

fn is_admin(l: &Laptop, conv: &str, pk: &str) -> bool {
    l.with_conn(|c| {
        let ctx = Ctx::load(c, &l.pk, &BoardAudience).unwrap().unwrap();
        let info = ctx.conv(conv).unwrap().expect("known conversation");
        ctx.is_admin(&info, pk).unwrap()
    })
}

/// `(accepted, rejected)` of `rec` ingested by `to` from its author `from`.
fn ingest(from: &Laptop, to: &Laptop, rec: &model::VerifiedRecord) -> (usize, usize) {
    let got = to.chat_ingest(&from.pk, vec![feature(rec)]);
    (got.accepted, got.rejected)
}

#[test]
fn division_chat_reaches_only_counted_members() {
    let s = setup();
    let o = &s.o;
    let l = &o.l;
    send(&l[BUDI], &s.conv, "standup jam 9");
    o.sync_all();
    assert_eq!(l[CITRA].texts(&s.conv), vec!["standup jam 9"]);
    for i in [SARI, DEWI, EKO, GITA] {
        assert_eq!(l[i].conv_records(&s.conv), 0, "{}", l[i].name);
        assert!(l[i].summary(&s.conv).is_none(), "{}", l[i].name);
        assert!(l[i].chat.conversation(&s.conv, None, 10).is_err());
    }
    // The guest row does not count.
    assert_eq!(l[BUDI].summary(&s.conv).unwrap().member_count, 2);

    // Added later: receives the history.
    add_member(o, &s.division, &l[EKO].pk, false);
    o.sync_all();
    assert_eq!(l[EKO].texts(&s.conv), vec!["standup jam 9"]);
    assert_eq!(l[BUDI].summary(&s.conv).unwrap().member_count, 3);

    // Citra moves to another department: out of the division chat.
    let (other, _) = o.add_team("Keuangan", &[]);
    o.exec(
        "DELETE FROM team_members WHERE public_key = ?1",
        &[&l[CITRA].pk],
    );
    o.exec(
        "INSERT INTO team_members (team_id, public_key, role, added_at) VALUES (?1, ?2, 'member', 't')",
        &[&other, &l[CITRA].pk],
    );
    let sc = l[CITRA].summary(&s.conv).expect("kept, read-only");
    assert!(sc.former && !sc.can_post);
    assert_eq!(
        sc.post_blocked_reason.as_deref(),
        Some("Anda sudah tidak di divisi ini. Pesan baru tidak dikirim lagi ke laptop Anda.")
    );
    assert_eq!(l[BUDI].summary(&s.conv).unwrap().member_count, 2);

    // Eko is removed from the organization.
    o.remove_member(&l[EKO].pk, &format_time(crate::clock::now()));
    assert_eq!(l[BUDI].summary(&s.conv).unwrap().member_count, 1);

    send(&l[BUDI], &s.conv, "setelah pindah");
    o.sync_all();
    assert_eq!(l[CITRA].texts(&s.conv), vec!["standup jam 9"]);
    assert_eq!(l[EKO].texts(&s.conv), vec!["standup jam 9"]);
}

#[test]
fn division_chat_summary_fields() {
    let s = setup();
    let (b, c) = (&s.o.l[BUDI], &s.o.l[CITRA]);
    let sc = c.summary(&s.conv).expect("Citra sees her division chat");
    assert_eq!(sc.kind, ConversationKind::Division);
    assert_eq!(sc.section, ChatSection::Departemen);
    assert_eq!(sc.name, "Mobile");
    let scope = sc.scope.clone().unwrap();
    assert_eq!(scope.kind, ScopeKind::Team);
    assert_eq!(scope.id.as_deref(), Some(s.team.as_str()));
    assert_eq!(scope.name, "IT");
    assert!(sc.can_post && !sc.archived && !sc.former);
    assert!(!sc.can_archive && !sc.can_delete && !sc.can_lock);
    // Not even a manager may archive or delete it.
    let sb = b.summary(&s.conv).unwrap();
    assert!(!sb.can_archive && !sb.can_delete && !sb.can_lock);

    let v = serde_json::to_value(&sc).unwrap();
    assert_eq!(v["kind"], "division");
    assert_eq!(v["section"], "departemen");
    assert_eq!(v["divisionId"], s.division.as_str());
    assert_eq!(v["teamId"], s.team.as_str());
    assert_eq!(v["scope"]["kind"], "team");

    // Other conversations carry no division ids.
    let team = c.summary(&s.team_conv).unwrap();
    assert_eq!(team.kind, ConversationKind::Channel);
    let v = serde_json::to_value(&team).unwrap();
    assert!(v.get("divisionId").is_none() && v.get("teamId").is_none());
}

#[test]
fn division_managers_are_heads_department_admins_and_superadmins() {
    let s = setup();
    let l = &s.o.l;
    let b = &l[BUDI];
    for (i, want) in [
        (SARI, true),
        (BUDI, true),
        (CITRA, false),
        (DEWI, true),
        (EKO, false),
        (GITA, false),
    ] {
        assert_eq!(is_admin(b, &s.conv, &l[i].pk), want, "{}", l[i].name);
    }

    // A head deletes someone else's message; a member may not.
    let mine = l[CITRA]
        .chat
        .send(&s.conv, "salah kirim", None, vec![], vec![])
        .unwrap();
    let theirs = b
        .chat
        .send(&s.conv, "dari kepala", None, vec![], vec![])
        .unwrap();
    s.o.sync_all();
    assert!(l[CITRA].chat.delete_message(&s.conv, &theirs.id).is_err());
    b.chat.delete_message(&s.conv, &mine.id).unwrap();
    s.o.sync_all();
    let deleted: Vec<bool> = super::messages(&l[CITRA], &s.conv)
        .into_iter()
        .map(|m| m.deleted)
        .collect();
    assert_eq!(deleted, vec![true, false]);
}

#[test]
fn division_chat_cannot_be_archived_or_deleted() {
    let s = setup();
    let (a, b, c) = (&s.o.l[SARI], &s.o.l[BUDI], &s.o.l[CITRA]);
    assert_eq!(
        b.chat.set_archived(&s.conv, true).unwrap_err().code(),
        "invalid_input"
    );
    assert!(b.chat.set_archived(&s.conv, false).is_err());
    assert!(b.chat.delete_channel(&s.conv).is_err());

    let now = crate::clock::now();
    let del = sign_as(
        a,
        &s.o.org_id,
        now,
        Body::ChannelDelete {
            conv: s.conv.clone(),
        },
    );
    let arch = sign_as(
        b,
        &s.o.org_id,
        now,
        Body::ChannelArchive {
            conv: s.conv.clone(),
            archived: true,
        },
    );
    assert_eq!(ingest(a, c, &del), (0, 1));
    assert_eq!(ingest(b, c, &arch), (0, 1));
    assert_eq!(c.rejected_codes(), vec!["chat_forbidden", "chat_forbidden"]);
    let sc = c.summary(&s.conv).unwrap();
    assert!(!sc.archived && sc.can_post);
}

#[test]
fn archived_division_chat_is_read_only() {
    let s = setup();
    let o = &s.o;
    let (b, c) = (&o.l[BUDI], &o.l[CITRA]);
    send(b, &s.conv, "sebelum arsip");
    o.sync_all();
    o.exec(
        "UPDATE divisions SET archived = 1 WHERE id = ?1",
        &[&s.division],
    );
    for l in [b, c] {
        let sm = l.summary(&s.conv).expect("still listed");
        assert!(sm.archived && !sm.can_post && !sm.can_archive, "{}", l.name);
        assert_eq!(
            sm.post_blocked_reason.as_deref(),
            Some("Divisi ini diarsipkan, jadi chatnya hanya bisa dibaca.")
        );
        assert_eq!(
            l.chat
                .send(&s.conv, "boleh?", None, vec![], vec![])
                .unwrap_err()
                .code(),
            "forbidden"
        );
    }
    assert_eq!(c.texts(&s.conv), vec!["sebelum arsip"]);
    // Like an archived channel, a message from an older laptop is kept.
    let late = sign_as(
        c,
        &o.org_id,
        crate::clock::now(),
        text_message(&s.conv, "terlambat"),
    );
    assert_eq!(ingest(c, b, &late), (1, 0));

    // An archived department makes its division chats read-only too.
    o.exec(
        "UPDATE divisions SET archived = 0 WHERE id = ?1",
        &[&s.division],
    );
    o.exec("UPDATE teams SET archived = 1 WHERE id = ?1", &[&s.team]);
    let sm = c.summary(&s.conv).unwrap();
    assert!(!sm.archived && !sm.can_post);
    assert_eq!(
        sm.post_blocked_reason.as_deref(),
        Some("Departemen ini diarsipkan, jadi chat divisinya hanya bisa dibaca.")
    );

    // A deleted division leaves nothing listed and nothing offered.
    o.exec("UPDATE teams SET archived = 0 WHERE id = ?1", &[&s.team]);
    o.exec(
        "UPDATE divisions SET deleted = 1 WHERE id = ?1",
        &[&s.division],
    );
    assert!(b.summary(&s.conv).is_none());
    assert!(b.chat.conversation(&s.conv, None, 10).is_err());
}

#[test]
fn announcement_mode_in_a_division_chat() {
    let s = setup();
    let o = &s.o;
    let (b, c) = (&o.l[BUDI], &o.l[CITRA]);
    let switched = crate::clock::now() - Duration::hours(1);
    set_announce(o, &s.team, &s.division, switched);

    let before = sign_as(
        c,
        &o.org_id,
        switched - Duration::minutes(1),
        text_message(&s.conv, "sebelum pengumuman"),
    );
    let after = sign_as(
        c,
        &o.org_id,
        switched + Duration::minutes(1),
        text_message(&s.conv, "sesudah pengumuman"),
    );
    let at_switch = sign_as(c, &o.org_id, switched, text_message(&s.conv, "tepat"));
    let head = sign_as(
        b,
        &o.org_id,
        switched + Duration::minutes(2),
        text_message(&s.conv, "dari kepala"),
    );
    assert_eq!(ingest(c, b, &before), (1, 0));
    assert_eq!(ingest(c, b, &after), (0, 1));
    assert_eq!(ingest(c, b, &at_switch), (0, 1));
    assert_eq!(ingest(b, c, &head), (1, 0));
    assert_eq!(
        b.rejected_codes(),
        vec!["chat_announce_only", "chat_announce_only"]
    );

    let sc = c.summary(&s.conv).unwrap();
    assert!(!sc.can_post);
    assert_eq!(
        sc.post_blocked_reason.as_deref(),
        Some("Mode pengumuman: hanya pengelola yang bisa menulis.")
    );
    assert_eq!(
        c.chat
            .send(&s.conv, "boleh?", None, vec![], vec![])
            .unwrap_err()
            .code(),
        "forbidden"
    );
    let sb = b.summary(&s.conv).unwrap();
    assert!(sb.can_post && sb.post_blocked_reason.is_none());
    send(b, &s.conv, "rilis jumat");
    o.sync_all();
    let mut got = c.texts(&s.conv);
    got.sort();
    assert_eq!(
        got,
        vec!["dari kepala", "rilis jumat", "sebelum pengumuman"]
    );
    assert!(!c.has_record(&after.id) && !c.has_record(&at_switch.id));

    // The department channel is not affected by the division's setting.
    assert!(c.summary(&s.team_conv).unwrap().can_post);
}

#[test]
fn announcement_mode_in_a_department_channel() {
    let s = setup();
    let o = &s.o;
    let (d, e, b) = (&o.l[DEWI], &o.l[EKO], &o.l[BUDI]);
    let switched = crate::clock::now() - Duration::hours(1);
    set_announce(o, &s.team, "", switched);

    let before = sign_as(
        e,
        &o.org_id,
        switched - Duration::seconds(1),
        text_message(&s.team_conv, "sebelum"),
    );
    let after = sign_as(
        e,
        &o.org_id,
        switched + Duration::seconds(1),
        text_message(&s.team_conv, "sesudah"),
    );
    let admin = sign_as(
        d,
        &o.org_id,
        switched + Duration::seconds(2),
        text_message(&s.team_conv, "dari admin"),
    );
    assert_eq!(ingest(e, b, &before), (1, 0));
    assert_eq!(ingest(e, b, &after), (0, 1));
    assert_eq!(ingest(d, b, &admin), (1, 0));
    assert_eq!(b.rejected_codes(), vec!["chat_announce_only"]);

    let se = e.summary(&s.team_conv).unwrap();
    assert!(!se.can_post);
    assert_eq!(
        se.post_blocked_reason.as_deref(),
        Some("Mode pengumuman: hanya pengelola yang bisa menulis.")
    );
    assert!(
        e.chat
            .send(&s.team_conv, "boleh?", None, vec![], vec![])
            .is_err()
    );
    assert!(d.summary(&s.team_conv).unwrap().can_post);
    // A head of a division is no manager of the department channel.
    assert!(!b.summary(&s.team_conv).unwrap().can_post);
    // The division chat keeps its own setting.
    assert!(b.summary(&s.conv).unwrap().can_post);
    assert!(o.l[CITRA].summary(&s.conv).unwrap().can_post);

    // Only the department's first channel has settings.
    let second = model::random_hex32();
    o.exec(
        "INSERT INTO channels (id, team_id, name, created_at) VALUES (?1, ?2, 'santai', 'u')",
        &[&second, &s.team],
    );
    let second_conv = model::channel_conv(&second);
    assert!(e.summary(&second_conv).unwrap().can_post);
    let other = sign_as(
        e,
        &o.org_id,
        switched + Duration::seconds(3),
        text_message(&second_conv, "di channel lain"),
    );
    assert_eq!(ingest(e, b, &other), (1, 0));
    assert!(e.summary(&s.team_conv).is_some_and(|x| !x.can_post));

    // Switched off: everyone writes again.
    o.exec("UPDATE chat_settings SET announce = 0", &[]);
    assert!(e.summary(&s.team_conv).unwrap().can_post);
    send(e, &s.team_conv, "terbuka lagi");
}

#[test]
fn laptop_without_the_division_ignores_its_records() {
    let s = setup();
    let o = &s.o;
    let (b, c) = (&o.l[BUDI], &o.l[CITRA]);
    // Citra's laptop has not folded the division yet (or runs an older
    // Mira): its records wait, nothing is stored or logged.
    c.with_conn(|conn| {
        conn.execute("DELETE FROM division_members", []).unwrap();
        conn.execute("DELETE FROM divisions", []).unwrap();
    });
    assert!(c.summary(&s.conv).is_none());
    send(b, &s.conv, "halo divisi");
    let rec = b.record_of(&s.conv, "message");
    let got = c.chat_ingest(&b.pk, vec![rec]);
    assert_eq!((got.accepted, got.rejected), (0, 0));
    assert_eq!(c.conv_records(&s.conv), 0);
    assert!(c.rejected_codes().is_empty());
    assert!(c.chat.overview().is_ok());

    // Once it knows the division, the record arrives.
    add_division_row(c, &s.division, &s.team, &[(&b.pk, true), (&c.pk, false)]);
    o.sync_all();
    assert_eq!(c.texts(&s.conv), vec!["halo divisi"]);
}

fn add_division_row(l: &Laptop, id: &str, team: &str, members: &[(&str, bool)]) {
    l.with_conn(|conn| {
        conn.execute(
            "INSERT INTO divisions (id, team_id, name, created_at, created_by) VALUES (?1, ?2, 'Mobile', 't', 'x')",
            [id, team],
        )
        .unwrap();
        for (pk, head) in members {
            conn.execute(
                "INSERT INTO division_members (division_id, public_key, head, added_at, added_by)
                 VALUES (?1, ?2, ?3, 't', 'x')",
                rusqlite::params![id, pk, head],
            )
            .unwrap();
        }
    });
}

#[test]
fn channel_with_a_division_id_never_takes_over_its_chat() {
    // Channel ids are derived from a hash, so this takes a stored row as a
    // tampered or buggy laptop would leave it: a department channel in
    // `chat_channels` and one in the membership log, both with the
    // division's id.
    let s = setup();
    let o = &s.o;
    let (b, c, e) = (&o.l[BUDI], &o.l[CITRA], &o.l[EKO]);
    e.with_conn(|conn| {
        conn.execute("DELETE FROM division_members", []).unwrap();
        conn.execute("DELETE FROM divisions", []).unwrap();
    });
    o.exec(
        "INSERT INTO chat_channels (conv, name, scope_kind, scope_id, created_by, created_at)
         VALUES (?1, 'ambil-alih', 'team', ?2, ?3, 't')",
        &[&s.conv, &s.team, &e.pk],
    );
    // Eko's laptop does not know the division: there it is that channel.
    assert!(
        e.summary(&s.conv)
            .is_some_and(|x| x.kind == ConversationKind::Channel)
    );
    for l in [b, c] {
        let sm = l.summary(&s.conv).unwrap();
        assert_eq!(sm.kind, ConversationKind::Division, "{}", l.name);
        assert_eq!((sm.name.as_str(), sm.member_count), ("Mobile", 2));
    }
    // Once the division is known there, the id is the division's chat.
    add_division_row(e, &s.division, &s.team, &[(&b.pk, true), (&c.pk, false)]);
    assert!(e.summary(&s.conv).is_none());
    assert!(e.chat.conversation(&s.conv, None, 10).is_err());

    // A membership-log channel with that id does not take it either.
    o.exec(
        "INSERT INTO channels (id, team_id, name, created_at) VALUES (?1, ?2, 'ambil-alih', 't')",
        &[&s.division, &s.team],
    );
    for l in [b, c] {
        let sm = l.summary(&s.conv).unwrap();
        assert_eq!(sm.kind, ConversationKind::Division, "{}", l.name);
        assert_eq!(sm.member_count, 2);
    }
    assert!(e.summary(&s.conv).is_none());
    send(b, &s.conv, "khusus divisi");
    o.sync_all();
    assert_eq!(c.texts(&s.conv), vec!["khusus divisi"]);
    assert_eq!(e.conv_records(&s.conv), 0);
}
