//! Reactions (v0.5.1, docs/plans/chat-sticker.md 2, 3 and 5).
//!
//! `testutil::Office` leaves `members.app_version` NULL, and the version
//! gate (`compat`) offers `reaction` records only to laptops reporting at
//! least `sticker_threshold()`. [`office`] therefore writes this build's
//! version for everyone before any sync.

use time::Duration;

use super::super::reactions::{recent_emoji, validate_emoji};
use super::super::testutil::{Laptop, Office, Who, pull};
use super::super::view::{NewChannelScope, ScopeKind};
use super::{feature, messages, sign_as};
use crate::chat::model::Body;
use crate::clock;
use crate::network::feature::FeatureSync;

/// Every laptop reports this build's version, so the gate lets reactions through.
fn same_version(o: &Office) {
    o.exec(
        "UPDATE members SET app_version = ?1",
        &[crate::device::APP_VERSION],
    );
}

fn office(people: &[(&str, Who)]) -> Office {
    let o = Office::new(people);
    o.connect_all();
    same_version(&o);
    o
}

fn three() -> Office {
    office(&[
        ("Sari", Who::Superadmin),
        ("Budi", Who::Member),
        ("Citra", Who::Member),
    ])
}

fn send(l: &Laptop, conv: &str, text: &str) -> String {
    l.chat.send(conv, text, None, vec![], vec![]).unwrap().id
}

/// `(emoji, count, mine, names)` of every chip under message `id` on `l`.
fn chips(l: &Laptop, conv: &str, id: &str) -> Vec<(String, u32, bool, Vec<String>)> {
    messages(l, conv)
        .into_iter()
        .find(|m| m.id == id)
        .map(|m| {
            m.reactions
                .into_iter()
                .map(|r| {
                    (
                        r.emoji,
                        r.count,
                        r.mine,
                        r.people.into_iter().map(|p| p.name).collect(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Chips without `mine` (which differs per laptop).
fn shared(l: &Laptop, conv: &str, id: &str) -> Vec<(String, u32, Vec<String>)> {
    chips(l, conv, id)
        .into_iter()
        .map(|(e, n, _, p)| (e, n, p))
        .collect()
}

/// [`shared`] sorted by emoji, people by name: for reactions made through
/// `react`, whose order within one second is the emoji (and the key).
fn unordered(l: &Laptop, conv: &str, id: &str) -> Vec<(String, u32, Vec<String>)> {
    let mut v = shared(l, conv, id);
    for c in &mut v {
        c.2.sort();
    }
    v.sort_by(|a, b| a.0.cmp(&b.0));
    v
}

fn reaction(conv: &str, message: &str, emoji: &str, on: bool) -> Body {
    Body::Reaction {
        conv: conv.to_owned(),
        message: message.to_owned(),
        emoji: emoji.to_owned(),
        on,
    }
}

fn reaction_records(l: &Laptop) -> i64 {
    l.count("SELECT count(*) FROM chat_records WHERE kind = 'reaction'")
}

fn names(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| (*s).to_owned()).collect()
}

#[test]
fn emoji_rules() {
    for ok in [
        "👍",
        "❤️",
        "😂",
        "👨‍👩‍👧‍👦",
        "🇮🇩",
        "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
        "1️⃣",
        "#️⃣",
        "*️⃣",
        "👍🏽",
        "👩🏻‍❤️‍💋‍👨🏼",
        "ℹ️",
        ":kopi:",
        ":ok_12:",
    ] {
        assert!(validate_emoji(ok).is_ok(), "{ok:?} should pass");
    }
    for bad in [
        "",
        "a",
        "ok",
        "1",
        "#",
        "1⃣",
        "1️",
        "👍 ",
        " 👍",
        "👍\n",
        "\u{7}",
        "\u{202E}👍",
        "👍\u{200B}",
        "\u{FEFF}",
        "\u{3000}",
        "<3",
        "::",
        ":k:",
        ":Kopi:",
        ":kopi",
        "kopi:",
        ":ko pi:",
        ":abcdefghijklmnopqrstuvwxyz0123456:",
        ":kopi-susu:",
    ] {
        assert!(validate_emoji(bad).is_err(), "{bad:?} should be refused");
    }
    // One emoji, not several side by side.
    assert!(validate_emoji("😀😀").is_err());
    // 16 characters is the limit (here 56 bytes).
    let joined = |n: usize| format!("👍{}", "\u{200D}👍".repeat(n));
    assert!(validate_emoji(&format!("{}\u{FE0F}", joined(7))).is_ok());
    assert!(validate_emoji(&joined(8)).is_err());
    assert!(validate_emoji(&format!(":{}:", "a".repeat(32))).is_ok());
}

/// Every emoji of the picker (`src/components/emoji/emojiData.ts`, lines
/// `emoji|nama|name|kata kunci`), as written and with U+FE0F added the way
/// the picker adds it to a single code point.
#[test]
fn every_picker_emoji_passes() {
    let data = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../src/components/emoji/emojiData.ts"
    ));
    let mut n = 0;
    for line in data.lines() {
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() != 4 || line.trim_start().starts_with("//") {
            continue;
        }
        let e = parts[0].trim();
        let points: Vec<u32> = e.chars().map(u32::from).collect();
        assert!(validate_emoji(e).is_ok(), "{e:?} {points:x?}");
        if points.len() == 1 {
            let with = format!("{e}\u{FE0F}");
            assert!(validate_emoji(&with).is_ok(), "{with:?}");
        }
        n += 1;
    }
    assert!(n >= 390, "read {n} emoji");
}

#[test]
fn free_text_and_invisible_characters_are_not_emoji() {
    for bad in [
        "中",
        "ب",
        "Ａ",
        "é",
        "👍\u{0301}\u{0301}",
        "\u{0301}",
        "👍\u{FE0E}",
        "👍\u{FE00}",
        "👍\u{E0100}",
        "\u{2800}",
        "\u{E0067}\u{E007F}",
        "👍\u{E0067}\u{E007F}",
        "🏴\u{E0067}\u{E0062}",
        "\u{1F3FB}",
        "\u{FE0F}",
        "\u{200D}👍",
        "👍\u{200D}",
        "👍\u{200D}\u{200D}👍",
        "🇮",
        "🇮🇩🇮",
        "\u{20E3}",
        "1\u{20E3}",
        "👍中",
        "中👍",
    ] {
        assert!(validate_emoji(bad).is_err(), "{bad:?} should be refused");
    }
}

#[test]
fn reactions_reach_others_and_taking_back_too() {
    let o = three();
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let umum = o.umum();
    let m = send(a, &umum, "rapat jam tiga");
    o.sync_all();
    assert!(b.chat.conversation(&umum, None, 50).unwrap().can_react);

    b.chat.react(&umum, &m, "👍", true).unwrap();
    c.chat.react(&umum, &m, "👍", true).unwrap();
    c.chat.react(&umum, &m, "❤️", true).unwrap();
    o.sync_all();
    for l in [a, b, c] {
        assert_eq!(
            unordered(l, &umum, &m),
            vec![
                ("❤️".to_owned(), 1, names(&["Citra"])),
                ("👍".to_owned(), 2, names(&["Budi", "Citra"])),
            ],
            "{}",
            l.name
        );
    }
    let mine: Vec<(String, bool)> = chips(b, &umum, &m)
        .into_iter()
        .map(|c| (c.0, c.2))
        .filter(|c| c.1)
        .collect();
    assert_eq!(mine, vec![("👍".to_owned(), true)]);
    assert!(chips(a, &umum, &m).iter().all(|c| !c.2));

    c.chat.react(&umum, &m, "👍", false).unwrap();
    o.sync_all();
    for l in [a, b, c] {
        assert_eq!(
            unordered(l, &umum, &m),
            vec![
                ("❤️".to_owned(), 1, names(&["Citra"])),
                ("👍".to_owned(), 1, names(&["Budi"])),
            ],
            "{}",
            l.name
        );
    }
    // No notification and no unread for reactions.
    assert_eq!(a.summary(&umum).unwrap().unread, 0);
}

#[test]
fn several_emoji_once_each_and_react_is_idempotent() {
    let o = three();
    let (a, b) = (&o.l[0], &o.l[1]);
    let umum = o.umum();
    let m = send(a, &umum, "selamat ulang tahun");
    o.sync_all();

    b.chat.react(&umum, &m, "🎉", true).unwrap();
    b.chat.react(&umum, &m, "🎉", true).unwrap();
    b.chat.react(&umum, &m, "🎂", true).unwrap();
    assert_eq!(reaction_records(b), 2);
    assert_eq!(
        unordered(b, &umum, &m),
        vec![
            ("🎂".to_owned(), 1, names(&["Budi"])),
            ("🎉".to_owned(), 1, names(&["Budi"])),
        ]
    );
    assert!(chips(b, &umum, &m).iter().all(|c| c.2));
    // Taking back twice, or something never given, makes no record.
    b.chat.react(&umum, &m, "🎉", false).unwrap();
    b.chat.react(&umum, &m, "🎉", false).unwrap();
    b.chat.react(&umum, &m, "👍", false).unwrap();
    assert_eq!(reaction_records(b), 3);
    assert_eq!(
        chips(b, &umum, &m),
        vec![("🎂".to_owned(), 1, true, names(&["Budi"]))]
    );
    // On again right away (same second): the new record still wins.
    b.chat.react(&umum, &m, "🎉", true).unwrap();
    b.chat.react(&umum, &m, "🎉", false).unwrap();
    b.chat.react(&umum, &m, "🎉", true).unwrap();
    assert_eq!(chips(b, &umum, &m).len(), 2);
    o.sync_all();
    assert_eq!(shared(a, &umum, &m), shared(b, &umum, &m));

    // Bad input.
    assert_eq!(
        b.chat.react(&umum, &m, "ok", true).unwrap_err().code(),
        "invalid_input"
    );
    assert_eq!(
        b.chat.react(&umum, &"0".repeat(64), "👍", true).unwrap_err().code(),
        "not_found"
    );
}

#[test]
fn concurrent_reactions_end_the_same_whatever_the_order() {
    let o = three();
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let umum = o.umum();
    let m = send(a, &umum, "makan siang di mana?");
    o.sync_all();

    // Offline: both add and remove the same and different emoji.
    b.chat.react(&umum, &m, "👍", true).unwrap();
    b.chat.react(&umum, &m, "😂", true).unwrap();
    c.chat.react(&umum, &m, "👍", true).unwrap();
    c.chat.react(&umum, &m, "😮", true).unwrap();
    b.chat.react(&umum, &m, "😂", false).unwrap();
    c.chat.react(&umum, &m, "👍", false).unwrap();

    // Different orders on different laptops.
    pull(c, a);
    pull(b, a);
    pull(b, c);
    pull(c, b);
    o.sync_all();
    let want = vec![
        ("👍".to_owned(), 1, names(&["Budi"])),
        ("😮".to_owned(), 1, names(&["Citra"])),
    ];
    for l in [a, b, c] {
        assert_eq!(unordered(l, &umum, &m), want, "{}", l.name);
    }
}

#[test]
fn last_writer_wins_on_at_then_record_id() {
    let o = three();
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let umum = o.umum();
    let m = send(a, &umum, "laporan sudah dikirim");
    o.sync_all();

    let t0 = clock::now() - Duration::minutes(5);
    let on1 = sign_as(b, &o.org_id, t0, reaction(&umum, &m, "👍", true));
    let off = sign_as(b, &o.org_id, t0 + Duration::seconds(5), reaction(&umum, &m, "👍", false));
    let on2 = sign_as(b, &o.org_id, t0 + Duration::seconds(3), reaction(&umum, &m, "👍", true));
    // Same time as `off`: the greater record id wins.
    let tie = sign_as(b, &o.org_id, t0 + Duration::seconds(5), reaction(&umum, &m, "🙏", true));
    let tie_off = sign_as(b, &o.org_id, t0 + Duration::seconds(5), reaction(&umum, &m, "🙏", false));
    let pray_on = tie.id > tie_off.id;

    // Sari: in time order, one record per batch.
    for r in [&on1, &on2, &off, &tie, &tie_off] {
        a.chat_ingest(&b.pk, vec![feature(r)]);
    }
    // Citra: the take-back arrives before the earlier add, all in one batch
    // and then again separately.
    c.chat_ingest(&b.pk, vec![feature(&tie_off), feature(&off)]);
    c.chat_ingest(&b.pk, vec![feature(&on2)]);
    c.chat_ingest(&b.pk, vec![feature(&tie), feature(&on1)]);

    let want: Vec<(String, u32, Vec<String>)> = if pray_on {
        vec![("🙏".to_owned(), 1, names(&["Budi"]))]
    } else {
        vec![]
    };
    assert_eq!(shared(a, &umum, &m), want);
    assert_eq!(shared(c, &umum, &m), want);
    assert_eq!(reaction_records(a), 5);
    assert_eq!(reaction_records(c), 5);
    // The rows hold the same winning record everywhere.
    let rows = |l: &Laptop| -> Vec<(String, i64, String)> {
        l.with_conn(|conn| {
            let mut s = conn
                .prepare("SELECT emoji, active, record_id FROM chat_reactions ORDER BY emoji")
                .unwrap();
            s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        })
    };
    assert_eq!(rows(a), rows(c));
}

#[test]
fn chips_follow_their_earliest_active_reaction() {
    let o = three();
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let umum = o.umum();
    let m = send(a, &umum, "foto acara");
    o.sync_all();
    let t0 = clock::now() - Duration::minutes(5);
    let s = |n| t0 + Duration::seconds(n);
    let recs = [
        sign_as(c, &o.org_id, s(1), reaction(&umum, &m, "❤️", true)),
        sign_as(b, &o.org_id, s(2), reaction(&umum, &m, "👍", true)),
        sign_as(a, &o.org_id, s(3), reaction(&umum, &m, "❤️", true)),
    ];
    for r in &recs {
        let from = if r.author() == c.pk { &c.pk } else { &b.pk };
        a.chat_ingest(from, vec![feature(r)]);
    }
    assert_eq!(
        chips(a, &umum, &m),
        vec![
            ("❤️".to_owned(), 2, true, names(&["Citra", "Sari"])),
            ("👍".to_owned(), 1, false, names(&["Budi"])),
        ]
    );
    let off = sign_as(c, &o.org_id, s(4), reaction(&umum, &m, "❤️", false));
    a.chat_ingest(&c.pk, vec![feature(&off)]);
    assert_eq!(
        chips(a, &umum, &m),
        vec![
            ("👍".to_owned(), 1, false, names(&["Budi"])),
            ("❤️".to_owned(), 1, true, names(&["Sari"])),
        ]
    );
}

#[test]
fn reaction_waits_for_its_message_and_deleted_messages_show_none() {
    let o = three();
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let umum = o.umum();
    let m = send(a, &umum, "draf kontrak");
    pull(a, b);
    b.chat.react(&umum, &m, "👀", true).unwrap();
    let rrec = b.record_of(&umum, "reaction");
    let mrec = a.record_of(&umum, "message");

    let got = c.chat_ingest(&b.pk, vec![rrec]);
    assert_eq!(got.accepted, 1);
    assert!(messages(c, &umum).is_empty());
    assert_eq!(c.count("SELECT count(*) FROM chat_reactions"), 1);
    c.chat_ingest(&a.pk, vec![mrec]);
    assert_eq!(
        chips(c, &umum, &m),
        vec![("👀".to_owned(), 1, false, names(&["Budi"]))]
    );

    a.chat.delete_message(&umum, &m).unwrap();
    o.sync_all();
    for l in [a, b, c] {
        let msg = messages(l, &umum).into_iter().find(|x| x.id == m).unwrap();
        assert!(msg.deleted && msg.reactions.is_empty(), "{}", l.name);
    }
    assert_eq!(
        b.chat.react(&umum, &m, "👍", true).unwrap_err().code(),
        "not_found"
    );
}

#[test]
fn reaction_naming_another_conversation_is_not_shown() {
    let o = three();
    let (a, b) = (&o.l[0], &o.l[1]);
    let umum = o.umum();
    let m = send(a, &umum, "di umum");
    o.sync_all();
    let dm = a.chat.open_dm(&b.pk).unwrap().id;
    let rec = sign_as(b, &o.org_id, clock::now(), reaction(&dm, &m, "👍", true));
    assert_eq!(a.chat_ingest(&b.pk, vec![feature(&rec)]).accepted, 1);
    assert!(chips(a, &umum, &m).is_empty());
}

#[test]
fn removed_author_still_counts() {
    let o = three();
    let (a, b) = (&o.l[0], &o.l[1]);
    let umum = o.umum();
    let m = send(a, &umum, "terima kasih semua");
    o.sync_all();
    b.chat.react(&umum, &m, "🙏", true).unwrap();
    o.sync_all();
    let later = crate::permissions::format::format_time(clock::now() + Duration::minutes(1));
    o.remove_member(&b.pk, &later);
    assert_eq!(
        shared(a, &umum, &m),
        vec![("🙏".to_owned(), 1, names(&["Budi"]))]
    );
}

#[test]
fn locked_umum_channel_takes_reactions_from_members() {
    let o = three();
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let conv = a
        .chat
        .create_channel(
            "Pengumuman",
            NewChannelScope {
                kind: ScopeKind::Org,
                id: None,
            },
        )
        .unwrap()
        .id;
    a.chat.set_locked(&conv, true).unwrap();
    let m = send(a, &conv, "kantor libur hari Jumat");
    o.sync_all();

    let view = b.chat.conversation(&conv, None, 50).unwrap();
    assert!(!view.conversation.can_post && view.can_react);
    b.chat.react(&conv, &m, "👍", true).unwrap();
    o.sync_all();
    for l in [a, c] {
        assert_eq!(
            shared(l, &conv, &m),
            vec![("👍".to_owned(), 1, names(&["Budi"]))],
            "{}",
            l.name
        );
    }
    assert!(a.rejected_codes().is_empty() && c.rejected_codes().is_empty());
}

#[test]
fn archived_channel_refuses_new_reactions() {
    let o = three();
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let (team, _) = o.add_team(
        "Desain Interior",
        &[(&a.pk, false), (&b.pk, false), (&c.pk, true)],
    );
    let conv = b
        .chat
        .create_channel(
            "Sketsa",
            NewChannelScope {
                kind: ScopeKind::Team,
                id: Some(team),
            },
        )
        .unwrap()
        .id;
    let m = send(b, &conv, "sketsa lantai dua");
    o.sync_all();
    let before = sign_as(a, &o.org_id, clock::now() - Duration::minutes(3), reaction(&conv, &m, "👍", true));

    c.chat.set_archived(&conv, true).unwrap();
    o.sync_all();
    assert!(!b.chat.conversation(&conv, None, 50).unwrap().can_react);
    assert_eq!(
        b.chat.react(&conv, &m, "👍", true).unwrap_err().code(),
        "forbidden"
    );

    // Made while archived (by a laptop that did not know yet): stored like
    // a message, so every laptop keeps the same records and nothing is
    // logged, but not shown. Made before the archive: shown.
    let after = sign_as(a, &o.org_id, clock::now() + Duration::seconds(2), reaction(&conv, &m, "❤️", true));
    let got = b.chat_ingest(&a.pk, vec![feature(&after)]);
    assert_eq!((got.accepted, got.rejected), (1, 0));
    assert!(b.rejected_codes().is_empty());
    let got = b.chat_ingest(&a.pk, vec![feature(&before)]);
    assert_eq!(got.accepted, 1);
    assert_eq!(
        shared(b, &conv, &m),
        vec![("👍".to_owned(), 1, names(&["Sari"]))]
    );
    // Citra's laptop gets the same records and shows the same.
    c.chat_ingest(&a.pk, vec![feature(&after), feature(&before)]);
    assert_eq!(shared(c, &conv, &m), shared(b, &conv, &m));
    assert!(c.rejected_codes().is_empty());
}

#[test]
fn outsiders_are_deferred_or_refused() {
    let o = office(&[
        ("Sari", Who::Superadmin),
        ("Budi", Who::Member),
        ("Citra", Who::Member),
        ("Gita", Who::Guest),
    ]);
    let (a, b, c, g) = (&o.l[0], &o.l[1], &o.l[2], &o.l[3]);
    let now = clock::now();

    // Department channel: Citra is not in the team. Her team membership may
    // not have arrived yet, so the record waits.
    let (_, team_conv) = o.add_team("Keuangan", &[(&a.pk, true), (&b.pk, false)]);
    let m = send(a, &team_conv, "anggaran Q1");
    o.sync_all();
    let rec = sign_as(c, &o.org_id, now, reaction(&team_conv, &m, "👍", true));
    let got = a.chat_ingest(&c.pk, vec![feature(&rec)]);
    assert_eq!((got.accepted, got.rejected), (0, 0));
    assert!(!a.has_record(&rec.id));

    // Group: Citra is not a member, waits too.
    let group = a.chat.create_group("Makan Siang", vec![b.pk.clone()]).unwrap().id;
    let gm = send(a, &group, "pesan apa?");
    o.sync_all();
    let rec = sign_as(c, &o.org_id, now, reaction(&group, &gm, "🍜", true));
    let got = a.chat_ingest(&c.pk, vec![feature(&rec)]);
    assert_eq!((got.accepted, got.rejected), (0, 0));
    // Budi, a member, is taken.
    b.chat.react(&group, &gm, "🍜", true).unwrap();
    o.sync_all();
    assert_eq!(shared(a, &group, &gm).len(), 1);

    // Chat pribadi of Sari and Budi: Citra is refused.
    let dm = a.chat.open_dm(&b.pk).unwrap().id;
    let dmm = send(a, &dm, "sudah makan?");
    o.sync_all();
    let rec = sign_as(c, &o.org_id, now, reaction(&dm, &dmm, "😋", true));
    let got = a.chat_ingest(&c.pk, vec![feature(&rec)]);
    assert_eq!(got.rejected, 1);
    b.chat.react(&dm, &dmm, "😋", true).unwrap();
    o.sync_all();
    assert_eq!(shared(a, &dm, &dmm).len(), 1);

    // A guest in the Umum channel: refused, and the guest's laptop does not
    // offer it.
    let umum = o.umum();
    let um = send(a, &umum, "selamat datang");
    o.sync_all();
    let rec = sign_as(g, &o.org_id, now, reaction(&umum, &um, "👋", true));
    let before = a.rejected_codes().len();
    let got = a.chat_ingest(&g.pk, vec![feature(&rec)]);
    assert_eq!(got.rejected, 1);
    assert_eq!(a.rejected_codes().len(), before + 1);
}

#[test]
fn guest_reacts_where_it_may_post() {
    let o = office(&[
        ("Sari", Who::Superadmin),
        ("Budi", Who::Member),
        ("Gita", Who::Guest),
    ]);
    let (a, g) = (&o.l[0], &o.l[2]);
    let (team, _) = o.add_team("Proyek", &[(&a.pk, true)]);
    let project = o.add_project("Renovasi Kantor", Some(&team), &a.pk, &[]);
    o.grant_guest(&g.pk, &team, &project);
    let conv = format!("ch:{project}");
    let m = send(a, &conv, "jadwal survei");
    o.sync_all();
    assert!(g.chat.conversation(&conv, None, 50).unwrap().can_react);
    g.chat.react(&conv, &m, "✅", true).unwrap();
    o.sync_all();
    assert_eq!(
        shared(a, &conv, &m),
        vec![("✅".to_owned(), 1, names(&["Gita"]))]
    );
}

#[test]
fn deleted_channel_reaction_is_known_but_purged() {
    let o = three();
    let (a, b) = (&o.l[0], &o.l[1]);
    let conv = a
        .chat
        .create_channel(
            "Sementara",
            NewChannelScope {
                kind: ScopeKind::Org,
                id: None,
            },
        )
        .unwrap()
        .id;
    let m = send(a, &conv, "sebentar saja");
    o.sync_all();
    let rec = sign_as(b, &o.org_id, clock::now(), reaction(&conv, &m, "👍", true));
    a.chat.delete_channel(&conv).unwrap();
    let got = a.chat_ingest(&b.pk, vec![feature(&rec)]);
    assert_eq!((got.accepted, got.rejected), (1, 0));
    assert!(!a.has_record(&rec.id));
    assert_eq!(a.count("SELECT count(*) FROM chat_reactions"), 0);
}

#[test]
fn older_laptops_are_not_offered_reactions() {
    let o = three();
    let (a, b) = (&o.l[0], &o.l[1]);
    let umum = o.umum();
    let m = send(a, &umum, "versi baru");
    o.sync_all();
    a.chat.react(&umum, &m, "🚀", true).unwrap();
    let rid = a.record_of(&umum, "reaction").id;
    let offered = |v: Option<&str>| -> (bool, bool) {
        a.with_conn(|c| {
            c.execute(
                "UPDATE members SET app_version = ?1 WHERE public_key = ?2",
                rusqlite::params![v, b.pk],
            )
            .unwrap();
        });
        let ids = a.chat.record_ids_for(&b.pk).unwrap();
        let recs = a.chat.records_for(&b.pk, std::slice::from_ref(&rid)).unwrap();
        (ids.contains(&rid), !recs.is_empty())
    };
    assert_eq!(offered(None), (false, false));
    assert_eq!(offered(Some("0.4.9")), (false, false));
    assert_eq!(offered(Some(crate::device::APP_VERSION)), (true, true));
    assert_eq!(offered(Some("9.9.9")), (true, true));
    // The message itself goes to everyone.
    a.with_conn(|c| {
        c.execute("UPDATE members SET app_version = NULL", []).unwrap();
    });
    assert!(a.chat.record_ids_for(&b.pk).unwrap().contains(&m));
}

#[test]
fn recent_emoji_per_laptop_newest_first_unique_at_most_24() {
    let o = three();
    let (a, b) = (&o.l[0], &o.l[1]);
    let recent = |l: &Laptop| l.with_conn(|c| recent_emoji(c).unwrap());
    assert!(recent(b).is_empty());

    let all: Vec<String> = (0x1F600u32..0x1F600 + 30)
        .map(|c| char::from_u32(c).unwrap().to_string())
        .collect();
    for e in &all {
        b.chat.emoji_used(e).unwrap();
    }
    let got = recent(b);
    assert_eq!(got.len(), 24);
    assert_eq!(got[0], all[29]);
    assert_eq!(got[23], all[6]);

    b.chat.emoji_used(&all[10]).unwrap();
    let got = recent(b);
    assert_eq!(got.len(), 24);
    assert_eq!(got[0], all[10]);
    assert_eq!(got.iter().filter(|e| **e == all[10]).count(), 1);

    b.chat.emoji_used(":kopi:").unwrap();
    assert_eq!(recent(b)[0], ":kopi:");
    assert_eq!(
        b.chat.emoji_used("halo").unwrap_err().code(),
        "invalid_input"
    );

    // Reacting counts as using.
    let umum = o.umum();
    let m = send(a, &umum, "kopi siapa?");
    o.sync_all();
    b.chat.react(&umum, &m, "☕", true).unwrap();
    assert_eq!(recent(b)[0], "☕");
    o.sync_all();
    assert!(recent(a).is_empty());

    // A damaged setting reads as empty, bad entries are skipped.
    b.with_conn(|c| {
        crate::settings::set(c, "chat.emoji_recent", r#"["👍","halo","👍","❤️"]"#).unwrap();
    });
    assert_eq!(recent(b), names(&["👍", "❤️"]));
    b.with_conn(|c| crate::settings::set(c, "chat.emoji_recent", "{rusak").unwrap());
    assert!(recent(b).is_empty());
}
