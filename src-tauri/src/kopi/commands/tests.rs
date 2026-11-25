//! Tests of the plain `*_in` functions with a real database. The org state
//! is the founder's genesis state, extended in memory with the people a
//! test needs (the functions take the `OrgState` as an argument).

use rusqlite::params;
use time::OffsetDateTime;
use time::macros::datetime;

use super::*;
use crate::identity::{self, MemoryKeyStore};
use crate::kopi::view::KopiEntry;
use crate::network::feature::FeatureRecord;
use crate::org;
use crate::permissions::MemberState;

/// 14:00 in Jakarta (UTC+7).
const NOW: OffsetDateTime = datetime!(2026-11-24 07:00 UTC);
const WIB: i32 = 420;
const TODAY: &str = "2026-11-24";

struct Laptop {
    _tmp: tempfile::TempDir,
    state: MiraState,
    pk: String,
}

impl Laptop {
    fn new(name: &str) -> Laptop {
        let tmp = tempfile::tempdir().unwrap();
        let state = MiraState::new(Ok(tmp.path().to_path_buf()), Box::new(MemoryKeyStore::new()));
        let pk = state
            .with_core(|c| {
                identity::save_display_name(&mut c.db, &mut c.identity, name)?;
                Ok(c.identity.public_key_hex().to_owned())
            })
            .unwrap();
        Laptop {
            _tmp: tmp,
            state,
            pk,
        }
    }

    fn core<T>(&self, f: impl FnOnce(&mut Core) -> AppResult<T>) -> AppResult<T> {
        self.state.with_core(f)
    }

    /// A record sealed with this laptop's key.
    fn seal(&self, payload: &Payload) -> FeatureRecord {
        self.core(|c| Ok(record::seal(&c.identity, payload).unwrap()))
            .unwrap()
    }
}

/// This laptop founded the office (superadmin); `org` is its state.
struct Office {
    me: Laptop,
    org: OrgState,
}

fn key(n: u8) -> String {
    format!("{n:02x}").repeat(32)
}

fn member(pk: &str, name: &str, kind: MemberKind, superadmin: bool) -> MemberState {
    MemberState {
        public_key: pk.to_owned(),
        display_name: Some(name.to_owned()),
        status: MemberStatus::Active,
        kind,
        is_superadmin: superadmin,
        joined_at: "2026-01-01T00:00:00Z".into(),
        removed_at: None,
        removal_op: None,
        has_profile: true,
        device: None,
        suspended_at: None,
        suspended_by: None,
        suspension_op: None,
        snapshot: None,
        joint_suspensions: Vec::new(),
        suspended_by_superadmin: false,
    }
}

impl Office {
    /// Me (superadmin, "Sari") plus members Budi (`key(1)`), Citra
    /// (`key(2)`), Dewi (`key(3)`), Eko (`key(4)`) and guest Gita (`key(9)`).
    fn new() -> Office {
        let me = Laptop::new("Sari");
        let org = me
            .core(|c| {
                org::create_organization(&mut c.db, &c.identity, "CV Kopi Jaya")?;
                permissions::require_state(&c.db)
            })
            .unwrap();
        let mut office = Office { me, org };
        // The genesis says the founder joined at the real clock's now; the
        // tests give at NOW, which may be earlier.
        office.me_mut().joined_at = "2026-01-01T00:00:00Z".into();
        for (n, name) in [(1, "Budi"), (2, "Citra"), (3, "Dewi"), (4, "Eko")] {
            office.add(&key(n), name, MemberKind::Member, false);
        }
        office.add(&key(9), "Gita", MemberKind::Guest, false);
        office
    }

    fn add(&mut self, pk: &str, name: &str, kind: MemberKind, superadmin: bool) {
        self.org
            .members
            .insert(pk.to_owned(), member(pk, name, kind, superadmin));
    }

    fn me_mut(&mut self) -> &mut MemberState {
        let pk = self.me.pk.clone();
        self.org.members.get_mut(&pk).unwrap()
    }

    fn give(&self, to: &str, target: Target, reason: &str) -> AppResult<()> {
        let input = GiveInput {
            to: to.to_owned(),
            target,
            reason: reason.to_owned(),
        };
        self.me.core(|c| give_in(c, &self.org, &input, WIB, NOW))
    }

    fn thank(&self, to: &str) -> AppResult<()> {
        self.give(
            to,
            Target::Profile { day: TODAY.into() },
            "Terima kasih sudah membantu laporan bulanan",
        )
    }

    fn overview(&self) -> KopiOverview {
        self.me
            .core(|c| overview_in(c, &self.org, WIB, NOW))
            .unwrap()
    }

    fn profile(&self, pk: &str) -> KopiProfile {
        self.me.core(|c| profile_in(c, &self.org, pk)).unwrap()
    }

    fn board(&self, month: &str) -> KopiBoard {
        self.me
            .core(|c| board_in(c, &self.org, month, WIB, NOW))
            .unwrap()
    }

    fn settings(&self, enabled: bool, board: bool) -> AppResult<()> {
        self.me
            .core(|c| set_settings_in(c, &self.org, enabled, board, NOW))
    }

    fn hide(&self, id: &str, hidden: bool) -> AppResult<()> {
        self.me.core(|c| hide_in(c, &self.org, id, hidden, NOW))
    }

    /// Stores a record sealed elsewhere, as sync would.
    fn receive(&self, rec: &FeatureRecord, from: &str) {
        let opened = record::open(rec).unwrap();
        self.me
            .core(|c| store::insert(&c.db, rec, &opened, Some(from)))
            .unwrap();
    }

    /// A chat message by `author` stored on this laptop.
    fn message(&self, id: &str, author: &str) {
        self.me
            .core(|c| {
                c.db.execute(
                    "INSERT INTO chat_messages (id, conv, author, at, text)
                     VALUES (?1, 'ch:umum', ?2, '2026-11-24T06:00:00Z', 'Laporan sudah saya kirim')",
                    params![id, author],
                )?;
                Ok(())
            })
            .unwrap();
    }

    fn records(&self) -> usize {
        self.me
            .core(|c| Ok(store::load_all(&c.db)?.len()))
            .unwrap()
    }
}

fn code(r: AppResult<()>) -> &'static str {
    r.expect_err("should be refused").code()
}

#[test]
fn give_succeeds_then_the_same_target_is_refused() {
    let office = Office::new();
    office.thank(&key(1)).unwrap();

    let ov = office.overview();
    assert_eq!(ov.given_today, 1);
    assert_eq!(ov.given_targets, vec![format!("profile:{}:{TODAY}", key(1))]);
    let budi = ov.badges.iter().find(|b| b.public_key == key(1)).unwrap();
    assert_eq!((budi.peer, budi.work, budi.score), (1, 0, 3));

    let err = office.thank(&key(1)).unwrap_err();
    assert_eq!(err.code(), "invalid_input");
    assert_eq!(err.to_string(), "Anda sudah memberi Kopi untuk ini.");
    assert_eq!(office.records(), 1);
}

#[test]
fn signed_at_carries_the_local_offset_and_reason_is_trimmed() {
    let office = Office::new();
    office
        .give(&key(1), Target::Profile { day: "1999-01-01".into() }, "  Cepat sekali  ")
        .unwrap();
    let records = office.me.core(|c| store::load_all(&c.db)).unwrap();
    let Payload::Give {
        at, reason, target, nonce, ..
    } = &records[0].payload
    else {
        panic!("not a give");
    };
    assert_eq!(at, "2026-11-24T14:00:00+07:00");
    assert_eq!(reason, "Cepat sekali");
    assert_eq!(target, &Target::Profile { day: TODAY.into() });
    assert_eq!(nonce.len(), 16);
}

#[test]
fn fourth_give_of_the_day_is_refused() {
    let office = Office::new();
    office.thank(&key(1)).unwrap();
    office.thank(&key(2)).unwrap();
    office.thank(&key(3)).unwrap();
    let msg = "ab".repeat(32);
    office.message(&msg, &key(4));
    let err = office
        .give(&key(4), Target::Message { id: msg }, "Penjelasannya jelas")
        .unwrap_err();
    assert_eq!(err.code(), "invalid_input");
    assert!(err.to_string().starts_with("Jatah Kopi Anda hari ini sudah habis"));
    assert_eq!(office.overview().given_today, 3);
    // Tomorrow (local) the quota is back.
    let tomorrow = datetime!(2026-11-24 17:30 UTC); // 00:30 WIB on the 25th
    let input = GiveInput {
        to: key(4),
        target: Target::Profile { day: "2026-11-25".into() },
        reason: "Rapi".into(),
    };
    office
        .me
        .core(|c| give_in(c, &office.org, &input, WIB, tomorrow))
        .unwrap();
}

#[test]
fn message_target_must_exist_and_be_written_by_the_recipient() {
    let office = Office::new();
    let msg = "cd".repeat(32);
    let missing = office.give(&key(1), Target::Message { id: msg.clone() }, "Mantap");
    assert_eq!(code(missing), "not_found");
    office.message(&msg, &key(2));
    let wrong = office.give(&key(1), Target::Message { id: msg.clone() }, "Mantap");
    assert_eq!(code(wrong), "invalid_input");
    office
        .give(&key(2), Target::Message { id: msg.clone() }, "Mantap")
        .unwrap();
    assert!(office
        .overview()
        .given_targets
        .contains(&format!("message:{msg}")));
}

#[test]
fn task_target_must_be_on_a_readable_board() {
    let office = Office::new();
    let task = Target::Task {
        project: "11".repeat(16),
        task: "22".repeat(16),
    };
    assert_eq!(code(office.give(&key(1), task, "Selesai cepat")), "not_found");
}

#[test]
fn giving_to_yourself_is_refused() {
    let office = Office::new();
    let err = office.thank(&office.me.pk.clone()).unwrap_err();
    assert_eq!(err.code(), "invalid_input");
    assert_eq!(err.to_string(), "Kopi tidak bisa diberikan ke diri sendiri.");
}

#[test]
fn unknown_recipient_and_bad_reason_are_refused() {
    let office = Office::new();
    assert_eq!(code(office.thank(&key(7))), "not_found");
    let empty = office.give(&key(1), Target::Profile { day: TODAY.into() }, "   ");
    assert_eq!(code(empty), "invalid_input");
    let long = "a".repeat(REASON_MAX + 1);
    let too_long = office.give(&key(1), Target::Profile { day: TODAY.into() }, &long);
    assert_eq!(code(too_long), "invalid_input");
    let two_lines = office.give(&key(1), Target::Profile { day: TODAY.into() }, "satu\ndua");
    assert_eq!(code(two_lines), "invalid_input");
    assert_eq!(office.records(), 0);
}

#[test]
fn guests_can_receive_but_not_give() {
    let mut office = Office::new();
    office.thank(&key(9)).unwrap();
    assert_eq!(office.profile(&key(9)).peer, 1);

    office.me_mut().kind = MemberKind::Guest;
    office.me_mut().is_superadmin = false;
    let err = office.thank(&key(1)).unwrap_err();
    assert_eq!(err.code(), "forbidden");
    assert!(!office.overview().can_give);
}

#[test]
fn bad_offset_is_refused() {
    let office = Office::new();
    let input = GiveInput {
        to: key(1),
        target: Target::Profile { day: TODAY.into() },
        reason: "Oke".into(),
    };
    let r = office
        .me
        .core(|c| give_in(c, &office.org, &input, 15 * 60, NOW));
    assert_eq!(code(r), "invalid_input");
    let r = office.me.core(|c| overview_in(c, &office.org, -841, NOW).map(|_| ()));
    assert_eq!(code(r), "invalid_input");
}

#[test]
fn feature_off_refuses_gives_and_turns_the_board_off() {
    let office = Office::new();
    office.thank(&key(1)).unwrap();
    assert!(office.board("2026-11").enabled);

    office.settings(false, true).unwrap();
    let err = office.thank(&key(2)).unwrap_err();
    assert_eq!(err.code(), "forbidden");
    let ov = office.overview();
    assert!(!ov.enabled && !ov.can_give);
    assert!(ov.badges.is_empty());
    let board = office.board("2026-11");
    assert!(!board.enabled);
    assert!(board.rows.is_empty());

    // Board off only: gives work, the board stays off.
    office.settings(true, false).unwrap();
    office.thank(&key(2)).unwrap();
    assert!(!office.board("2026-11").enabled);
    assert!(!office.overview().board_enabled);

    office.settings(true, true).unwrap();
    assert!(office.board("2026-11").enabled);
}

#[test]
fn settings_and_hide_are_superadmin_only() {
    let mut office = Office::new();
    office.thank(&key(1)).unwrap();
    let id = office.profile(&key(1)).history[0].clone();
    let KopiEntry::Peer { id, .. } = id else {
        panic!("not a peer entry");
    };

    office.me_mut().is_superadmin = false;
    assert_eq!(code(office.hide(&id, true)), "forbidden");
    assert_eq!(code(office.settings(false, false)), "forbidden");
    assert_eq!(office.records(), 1);
}

#[test]
fn hide_unknown_give_is_not_found() {
    let office = Office::new();
    assert_eq!(code(office.hide(&"ef".repeat(32), true)), "not_found");
}

#[test]
fn hidden_entries_are_shown_to_superadmins_only() {
    let mut office = Office::new();
    // A second superadmin on another laptop hides my give.
    let sa = Laptop::new("Rina");
    office.add(&sa.pk.clone(), "Rina", MemberKind::Member, true);
    office.me_mut().is_superadmin = false;

    office.thank(&key(1)).unwrap();
    office.thank(&key(2)).unwrap();
    let to_hide = match &office.profile(&key(1)).history[0] {
        KopiEntry::Peer { id, .. } => id.clone(),
        KopiEntry::Work { .. } => panic!("not a peer entry"),
    };
    let hide = sa.seal(&Payload::Hide {
        record: to_hide.clone(),
        hidden: true,
        at: "2026-11-24T07:30:00Z".into(),
    });
    office.receive(&hide, &sa.pk);

    let seen = office.profile(&key(1));
    assert_eq!(seen.peer, 0);
    assert!(seen.history.is_empty());
    // Hidden gives still use the quota and the target.
    assert_eq!(office.overview().given_today, 2);

    office.me_mut().is_superadmin = true;
    let seen = office.profile(&key(1));
    assert_eq!(seen.peer, 0);
    assert_eq!(seen.history.len(), 1);
    assert!(matches!(&seen.history[0], KopiEntry::Peer { hidden: true, id, .. } if *id == to_hide));

    // Shown again by me (now superadmin): counts again.
    office.hide(&to_hide, false).unwrap();
    assert_eq!(office.profile(&key(1)).peer, 1);
}

#[test]
fn settings_changed_twice_in_one_second_keep_the_last() {
    let office = Office::new();
    office.settings(false, false).unwrap();
    office.settings(true, false).unwrap();
    office.settings(true, true).unwrap();
    let ov = office.overview();
    assert!(ov.enabled && ov.board_enabled);
}

#[test]
fn board_ranks_by_score_then_name() {
    let office = Office::new();
    office.thank(&key(2)).unwrap(); // Citra
    office.thank(&key(1)).unwrap(); // Budi
    let msg = "ab".repeat(32);
    office.message(&msg, &key(1));
    office
        .give(&key(1), Target::Message { id: msg }, "Membantu")
        .unwrap();

    let board = office.board("2026-11");
    let names: Vec<(&str, u32)> = board
        .rows
        .iter()
        .map(|r| (r.person.name.as_str(), r.score))
        .collect();
    assert_eq!(names, vec![("Budi", 6), ("Citra", 3)]);
    assert!(office.board("2026-10").rows.is_empty());
    // Empty month: this month at the laptop's offset.
    assert_eq!(office.board("").month, "2026-11");
    let bad = office
        .me
        .core(|c| board_in(c, &office.org, "2026-13", WIB, NOW).map(|_| ()));
    assert_eq!(code(bad), "invalid_input");
}

#[test]
fn profile_of_unknown_person_is_not_found() {
    let office = Office::new();
    let r = office
        .me
        .core(|c| profile_in(c, &office.org, &key(8)).map(|_| ()));
    assert_eq!(code(r), "not_found");
}

#[test]
fn overview_json_matches_the_frontend_contract() {
    let office = Office::new();
    office.thank(&key(1)).unwrap();
    let v = serde_json::to_value(office.overview()).unwrap();
    for field in [
        "enabled",
        "boardEnabled",
        "isSuperadmin",
        "canGive",
        "me",
        "givenToday",
        "dailyLimit",
        "reasonMax",
        "givenTargets",
        "badges",
        "tiers",
        "peerWeight",
        "workWeight",
    ] {
        assert!(v.get(field).is_some(), "missing {field}");
    }
    assert_eq!(v.as_object().unwrap().len(), 13);
    assert_eq!(v["dailyLimit"], 3);
    assert_eq!(v["reasonMax"], 120);
    assert_eq!(v["peerWeight"], 3);
    assert_eq!(v["isSuperadmin"], true);
    assert_eq!(v["canGive"], true);
    assert_eq!(v["tiers"][0]["tier"], "anak_baru");
    assert_eq!(v["tiers"][0]["minScore"], 0);
    assert_eq!(v["tiers"][3]["tier"], "legenda");
    assert_eq!(v["badges"][0]["publicKey"], key(1));
    assert_eq!(v["badges"][0]["score"], 3);
    assert_eq!(v["badges"][0]["tier"], "anak_baru");
}

#[test]
fn profile_json_matches_the_frontend_contract() {
    let office = Office::new();
    office.thank(&key(1)).unwrap();
    let v = serde_json::to_value(office.profile(&key(1))).unwrap();
    assert_eq!(v["person"]["publicKey"], key(1));
    assert_eq!(v["person"]["name"], "Budi");
    assert_eq!((v["peer"].clone(), v["work"].clone(), v["score"].clone()), (1.into(), 0.into(), 3.into()));
    assert_eq!(v["tier"], "anak_baru");
    assert_eq!(v["next"]["tier"], "andalan");
    assert_eq!(v["next"]["minScore"], 15);
    let e = &v["history"][0];
    assert_eq!(e["kind"], "peer");
    assert_eq!(e["from"]["publicKey"], office.me.pk);
    assert_eq!(e["from"]["name"], "Sari");
    assert_eq!(e["target"]["kind"], "profile");
    assert_eq!(e["target"]["day"], TODAY);
    assert_eq!(e["reason"], "Terima kasih sudah membantu laporan bulanan");
    assert_eq!(e["at"], "2026-11-24T14:00:00+07:00");
    assert_eq!(e["hidden"], false);
    assert_eq!(e["id"].as_str().unwrap().len(), 64);

    let work = KopiEntry::Work {
        id: "p:t".into(),
        project_id: "p".into(),
        task_id: "t".into(),
        title: None,
        project_name: Some("Gudang".into()),
        why: crate::kopi::WorkWhy::OnTime,
        at: "2026-11-24T01:00:00Z".into(),
    };
    let w = serde_json::to_value(work).unwrap();
    assert_eq!(w["kind"], "work");
    assert_eq!(w["projectId"], "p");
    assert_eq!(w["taskId"], "t");
    assert!(w["title"].is_null());
    assert_eq!(w["projectName"], "Gudang");
    assert_eq!(w["why"], "on_time");

    let board = serde_json::to_value(office.board("2026-11")).unwrap();
    assert_eq!(board["month"], "2026-11");
    assert_eq!(board["enabled"], true);
    assert_eq!(board["rows"][0]["person"]["publicKey"], key(1));
    assert_eq!(board["rows"][0]["tier"], "anak_baru");
}

#[test]
fn fifth_give_to_one_person_in_a_month_is_refused() {
    let office = Office::new();
    for d in 24..=27 {
        let at = OffsetDateTime::new_utc(
            time::Date::from_calendar_date(2026, time::Month::November, d).unwrap(),
            time::Time::from_hms(7, 0, 0).unwrap(),
        );
        let input = GiveInput {
            to: key(1),
            target: Target::Profile { day: String::new() },
            reason: "Rapi".into(),
        };
        office
            .me
            .core(|c| give_in(c, &office.org, &input, WIB, at))
            .unwrap();
    }
    let input = GiveInput {
        to: key(1),
        target: Target::Profile { day: String::new() },
        reason: "Rapi".into(),
    };
    let fifth = office
        .me
        .core(|c| give_in(c, &office.org, &input, WIB, datetime!(2026-11-28 07:00 UTC)));
    let err = fifth.unwrap_err();
    assert_eq!(err.code(), "invalid_input");
    assert!(err.to_string().contains("bulan ini"), "{err}");
    // Someone else is fine the same day, and Budi again next month.
    office
        .me
        .core(|c| {
            let other = GiveInput { to: key(2), ..input.clone() };
            give_in(c, &office.org, &other, WIB, datetime!(2026-11-28 07:00 UTC))
        })
        .unwrap();
    office
        .me
        .core(|c| give_in(c, &office.org, &input, WIB, datetime!(2026-12-01 07:00 UTC)))
        .unwrap();
}

#[test]
fn settings_written_while_the_clock_ran_ahead_are_retired() {
    let office = Office::new();
    let ahead = NOW + Duration::days(3);
    office
        .me
        .core(|c| set_settings_in(c, &office.org, false, false, ahead))
        .unwrap();
    let future_id = office.me.core(|c| store::ids(&c.db)).unwrap()[0].clone();
    office.settings(true, true).unwrap();
    let records = office.me.core(|c| store::load_all(&c.db)).unwrap();
    assert_eq!(records.len(), 1, "the future one is gone");
    let Payload::Settings { at, enabled, .. } = &records[0].payload else {
        panic!("not settings");
    };
    assert_eq!(at, &clock::format_rfc3339(NOW), "now, not one second after the future");
    assert!(enabled);
    assert!(office.me.core(|c| store::known(&c.db, &future_id)).unwrap());
    assert!(office.overview().enabled);
}

#[test]
fn cache_is_reused_until_records_boards_or_membership_change() {
    use crate::documents::test_lab::Lab;

    let lab = Lab::new(&["Sari", "Budi"]);
    let cache = KopiCache::default();
    let first = lab.laptops[0].with(|c| {
        let a = cache.snapshot(c).unwrap();
        let b = cache.snapshot(c).unwrap();
        assert!(Arc::ptr_eq(&a, &b));
        a
    });
    assert_eq!(cache.computed(), 1);
    assert!(first.loaded.state.settings.enabled);

    // A record stored here.
    lab.laptops[0].with(|c| {
        let at = clock::now_rfc3339();
        store::seal_and_store(c, &Payload::Settings { enabled: false, board: true, at }).unwrap();
        let s = cache.snapshot(c).unwrap();
        assert!(!s.loaded.state.settings.enabled);
        cache.snapshot(c).unwrap();
    });
    assert_eq!(cache.computed(), 2);

    // A record received through sync.
    let give = lab.laptops[1].with(|c| {
        record::seal(
            &c.identity,
            &Payload::Give {
                to: lab.pk(0),
                target: Target::Message { id: "m1".into() },
                reason: "Makasih".into(),
                at: clock::now_rfc3339(),
                nonce: "0011223344556677".into(),
            },
        )
        .unwrap()
    });
    let got = crate::network::feature::FeatureSync::ingest(
        &super::super::sync::KopiSync::new(lab.laptops[0].state.clone()),
        &lab.pk(1),
        vec![give],
    )
    .unwrap();
    assert_eq!(got.accepted, 1);
    lab.laptops[0].with(|c| {
        assert_eq!(cache.snapshot(c).unwrap().loaded.records.len(), 2);
    });
    assert_eq!(cache.computed(), 3);

    // A board project arrives.
    lab.add_project(&"ab".repeat(16), None);
    lab.laptops[0].with(|c| cache.snapshot(c).unwrap());
    assert_eq!(cache.computed(), 4);

    // The membership log changes.
    let team = lab.team.clone();
    lab.register_project(0, Some(&team), &[1]);
    lab.laptops[0].with(|c| cache.snapshot(c).unwrap());
    lab.laptops[0].with(|c| cache.snapshot(c).unwrap());
    assert_eq!(cache.computed(), 5);
}

#[test]
fn give_input_reads_the_frontend_shape() {
    let input: GiveInput = serde_json::from_value(serde_json::json!({
        "to": key(1),
        "target": { "kind": "task", "project": "aa", "task": "bb" },
        "reason": "Mantap",
    }))
    .unwrap();
    assert_eq!(
        input.target,
        Target::Task {
            project: "aa".into(),
            task: "bb".into()
        }
    );
}
