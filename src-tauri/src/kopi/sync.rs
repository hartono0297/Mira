//! `FeatureSync` for topic `kopi` (docs/plans/kopi.md, 3.6).
//!
//! Scoping ([`KopiSync::record_ids_for`]): an active member (not a guest)
//! receives every record. An active guest receives the `settings` records,
//! the gives addressed to them and the `hide` records of those gives.
//! Anyone else receives nothing. `records_for` applies the same filter to
//! the ids the peer asked for.
//!
//! Ingest: `record::open` (id, signature, shape), then the checks that need
//! the org state, the clock and what is stored:
//! - a give must come from someone in the org with kind `Member` (guests
//!   never give; a removed member's older gives still sync);
//! - `settings` and `hide` must come from a current superadmin;
//! - a work snapshot must come from someone in the org;
//! - a record more than `FUTURE_SKEW_SECS` in the future is not stored and
//!   not counted as refused: it is offered again later and accepted then;
//! - flood limits: a give is refused while its author already has
//!   `GIVE_STORED_DAILY_MAX` gives stored on the same local day (the date
//!   in `at`), a `hide` or `settings` record while its author already has
//!   `ADMIN_STORED_DAILY_MAX` of those stored on the same UTC day.
//!
//! Two kinds of refusal:
//! - never valid: `record::open` fails although the id matches the body
//!   (bad signature, unreadable payload, bad shape). That content can never
//!   pass, so the id goes to `kopi_seen` and is not asked for again. A body
//!   that does not match its id proves nothing about the real record of
//!   that id, so it is only refused;
//! - not now: the role and flood checks. Roles change and stored counts
//!   are local, so the record is asked for again on the next sync.
//!
//! Refused records are logged with `permissions::log_rejection`, code
//! `kopi_rejected`, once per record id while the app runs (a refusal that
//! is retried every sync does not flood the log).

use std::collections::HashSet;
use std::sync::{Arc, Mutex, PoisonError};

use rusqlite::Connection;
use tauri::{AppHandle, Manager, Runtime};
use time::{Duration, OffsetDateTime, UtcOffset};

use super::commands::KopiCache;
use super::record;
use super::store;
use super::types::{
    ADMIN_STORED_DAILY_MAX, FUTURE_SKEW_SECS, GIVE_STORED_DAILY_MAX, Payload, StoredRecord,
};
use crate::clock;
use crate::error::AppResult;
use crate::network::feature::{FeatureHub, FeatureIngest, FeatureRecord, FeatureSync, TOPIC_KOPI};
use crate::permissions::{self, MemberKind, MemberStatus, OrgState};
use crate::state::MiraState;

/// Code of refused Kopi records in `rejected_changes`.
pub const REJECT_CODE: &str = "kopi_rejected";
/// Most record ids remembered as already logged; the set starts over when
/// full.
const LOGGED_MAX: usize = 10_000;

pub struct KopiSync {
    state: MiraState,
    /// Ids whose refusal was already logged.
    logged: Mutex<HashSet<String>>,
}

/// What ingest does with one record.
enum Verdict {
    Store(StoredRecord),
    /// Valid, but from the future: not stored now, not refused.
    Later,
    /// Refused for now; asked for again on the next sync.
    NotNow(String),
    /// Can never be valid: remembered in `kopi_seen`.
    Never(String),
}

impl KopiSync {
    pub fn new(state: MiraState) -> Self {
        Self {
            state,
            logged: Mutex::new(HashSet::new()),
        }
    }

    /// `true` the first time `id` is seen here.
    fn first_refusal(&self, id: &str) -> bool {
        let mut logged = self.logged.lock().unwrap_or_else(PoisonError::into_inner);
        if logged.contains(id) {
            return false;
        }
        if logged.len() >= LOGGED_MAX {
            logged.clear();
        }
        logged.insert(id.to_owned())
    }

    fn ingest_at(
        &self,
        from: &str,
        records: Vec<FeatureRecord>,
        now: OffsetDateTime,
    ) -> AppResult<FeatureIngest> {
        self.state.with_core(|core| {
            store::ensure_schema(&core.db)?;
            let mut out = FeatureIngest::default();
            let Some(org) = permissions::load_state(&core.db)? else {
                out.rejected = records.len();
                return Ok(out);
            };
            let tx = core.db.transaction()?;
            for rec in &records {
                if store::known(&tx, &rec.id)? {
                    continue;
                }
                let reason = match check_incoming(&tx, &org, rec, now)? {
                    Verdict::Store(opened) => {
                        if store::insert(&tx, rec, &opened, Some(from))? {
                            out.accepted += 1;
                        }
                        continue;
                    }
                    Verdict::Later => continue,
                    Verdict::NotNow(reason) => reason,
                    Verdict::Never(reason) => {
                        store::forget(&tx, &rec.id)?;
                        reason
                    }
                };
                out.rejected += 1;
                if self.first_refusal(&rec.id) {
                    permissions::log_rejection(
                        &tx,
                        Some(from),
                        None,
                        REJECT_CODE,
                        &format!("record {}: {reason}", rec.id),
                        now,
                    )?;
                }
            }
            tx.commit()?;
            out.changed = out.accepted > 0;
            Ok(out)
        })
    }
}

/// `true` when the payload names a record kind (`t`) or give target kind
/// (`target.kind`) this version does not know. The signature is not checked
/// here; such a record is only refused for now, never remembered as invalid.
fn from_newer_version(body: &str) -> bool {
    const KINDS: [&str; 4] = ["give", "hide", "settings", "work"];
    const TARGETS: [&str; 3] = ["message", "task", "profile"];
    let Ok(env) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    let Some(p) = env.get("p").and_then(|p| p.as_str()) else {
        return false;
    };
    let Ok(p) = serde_json::from_str::<serde_json::Value>(p) else {
        return false;
    };
    match p.get("t").and_then(|t| t.as_str()) {
        Some(t) if !KINDS.contains(&t) => true,
        Some("give") => p
            .get("target")
            .and_then(|x| x.get("kind"))
            .and_then(|k| k.as_str())
            .is_some_and(|k| !TARGETS.contains(&k)),
        _ => false,
    }
}

fn check_incoming(
    conn: &Connection,
    org: &OrgState,
    rec: &FeatureRecord,
    now: OffsetDateTime,
) -> AppResult<Verdict> {
    let opened = match record::open(rec) {
        Ok(o) => o,
        // A kind this version does not know may come from a newer Mira:
        // asked for again later, so it is accepted once this laptop updates.
        Err(reason) if from_newer_version(&rec.body) => return Ok(Verdict::NotNow(reason)),
        Err(reason) if rec.id_matches() => return Ok(Verdict::Never(reason)),
        Err(reason) => return Ok(Verdict::NotNow(reason)),
    };
    let author = opened.author.as_str();
    let in_org = org.member(author);
    let role_ok = match &opened.payload {
        Payload::Give { .. } => in_org.is_some_and(|m| m.kind == MemberKind::Member),
        Payload::Hide { .. } | Payload::Settings { .. } => org.is_superadmin(author),
        Payload::Work { .. } => in_org.is_some(),
    };
    if !role_ok {
        let reason = match &opened.payload {
            Payload::Give { .. } => "pemberi bukan anggota kantor",
            Payload::Hide { .. } | Payload::Settings { .. } => "penulis bukan superadmin",
            Payload::Work { .. } => "penulis bukan orang kantor",
        };
        return Ok(Verdict::NotNow(reason.into()));
    }
    let at_text = record::payload_at(&opened.payload);
    let Some(at) = record::parse_at(at_text) else {
        return Ok(Verdict::Never("waktu bukan RFC 3339".into()));
    };
    if at > now + Duration::seconds(FUTURE_SKEW_SECS) {
        return Ok(Verdict::Later);
    }
    match &opened.payload {
        Payload::Give { .. } => {
            let day = record::local_day(at_text).unwrap_or_default();
            if store::gives_on(conn, author, &day)? >= GIVE_STORED_DAILY_MAX {
                return Ok(Verdict::NotNow(format!(
                    "pemberi sudah punya {GIVE_STORED_DAILY_MAX} pemberian tersimpan pada {day}"
                )));
            }
        }
        Payload::Hide { .. } | Payload::Settings { .. } => {
            let d = at.to_offset(UtcOffset::UTC).date();
            let day = format!("{:04}-{:02}-{:02}", d.year(), u8::from(d.month()), d.day());
            if store::admin_on(conn, author, &day)? >= ADMIN_STORED_DAILY_MAX {
                return Ok(Verdict::NotNow(format!(
                    "superadmin sudah punya {ADMIN_STORED_DAILY_MAX} perubahan tersimpan pada {day} (UTC)"
                )));
            }
        }
        Payload::Work { .. } => {}
    }
    Ok(Verdict::Store(opened))
}

/// Who `peer` is for scoping.
enum Reader {
    Member,
    Guest,
    Nobody,
}

fn reader(org: &OrgState, peer: &str) -> Reader {
    match org.member(peer) {
        Some(m) if m.status == MemberStatus::Active && m.kind == MemberKind::Member => {
            Reader::Member
        }
        Some(m) if m.status == MemberStatus::Active => Reader::Guest,
        _ => Reader::Nobody,
    }
}

/// Ids of the stored records `peer` may receive, sorted.
pub fn record_ids_for(conn: &Connection, org: &OrgState, peer: &str) -> AppResult<Vec<String>> {
    match reader(org, peer) {
        Reader::Member => store::ids(conn),
        Reader::Nobody => Ok(Vec::new()),
        Reader::Guest => {
            let all = store::load_all(conn)?;
            let gives: HashSet<&str> = all
                .iter()
                .filter(|r| matches!(&r.payload, Payload::Give { to, .. } if to == peer))
                .map(|r| r.id.as_str())
                .collect();
            let mut ids: Vec<String> = all
                .iter()
                .filter(|r| match &r.payload {
                    Payload::Settings { .. } => true,
                    Payload::Give { .. } => gives.contains(r.id.as_str()),
                    Payload::Hide { record, .. } => gives.contains(record.as_str()),
                    Payload::Work { .. } => false,
                })
                .map(|r| r.id.clone())
                .collect();
            ids.sort();
            Ok(ids)
        }
    }
}

impl FeatureSync for KopiSync {
    fn topic(&self) -> &'static str {
        TOPIC_KOPI
    }

    fn record_ids_for(&self, peer: &str) -> Result<Vec<String>, String> {
        self.state
            .with_core(|c| {
                let Some(org) = permissions::load_state(&c.db)? else {
                    return Ok(Vec::new());
                };
                record_ids_for(&c.db, &org, peer)
            })
            .map_err(|e| e.to_string())
    }

    fn unknown_ids(&self, ids: &[String]) -> Result<Vec<String>, String> {
        self.state
            .with_core(|c| {
                let mut out = Vec::new();
                for id in ids {
                    if !store::known(&c.db, id)? {
                        out.push(id.clone());
                    }
                }
                Ok(out)
            })
            .map_err(|e| e.to_string())
    }

    fn records_for(&self, peer: &str, ids: &[String]) -> Result<Vec<FeatureRecord>, String> {
        self.state
            .with_core(|c| {
                let Some(org) = permissions::load_state(&c.db)? else {
                    return Ok(Vec::new());
                };
                let allowed: HashSet<String> =
                    record_ids_for(&c.db, &org, peer)?.into_iter().collect();
                let asked: Vec<String> = ids
                    .iter()
                    .filter(|id| allowed.contains(*id))
                    .cloned()
                    .collect();
                store::bodies(&c.db, &asked)
            })
            .map_err(|e| e.to_string())
    }

    /// `from` is the key the transport proved in TLS; the author of each
    /// record is checked from its own signature.
    fn ingest(&self, from: &str, records: Vec<FeatureRecord>) -> Result<FeatureIngest, String> {
        self.ingest_at(from, records, clock::now())
            .map_err(|e| e.to_string())
    }
}

/// Manages the commands' [`KopiCache`] and registers [`KopiSync`] on the
/// managed hub. Needs `MiraState` and `Arc<FeatureHub>` managed first.
pub fn register<R: Runtime>(app: &AppHandle<R>) {
    app.manage(KopiCache::default());
    let (Some(hub), Some(state)) = (
        app.try_state::<Arc<FeatureHub>>(),
        app.try_state::<MiraState>(),
    ) else {
        eprintln!("Mira: sinkron Kopi tidak didaftarkan (state belum dikelola).");
        return;
    };
    hub.register(Arc::new(KopiSync::new(state.inner().clone())));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::documents::test_lab::{Lab, Laptop};
    use crate::kopi::types::{Target, WorkItem, WorkWhy};
    use crate::network::feature::testing;

    fn sync(l: &Laptop) -> KopiSync {
        KopiSync::new(l.state.clone())
    }

    fn seal(l: &Laptop, p: &Payload) -> FeatureRecord {
        l.with(|c| record::seal(&c.identity, p).unwrap())
    }

    fn store(l: &Laptop, p: &Payload) -> FeatureRecord {
        l.with(|c| store::seal_and_store(c, p).unwrap())
    }

    fn at_in(secs: i64) -> String {
        clock::format_rfc3339(clock::now() + Duration::seconds(secs))
    }

    fn give(to: &str, id: &str, at: &str) -> Payload {
        Payload::Give {
            to: to.to_owned(),
            target: Target::Message { id: id.to_owned() },
            reason: "Terima kasih bantuannya".into(),
            at: at.to_owned(),
            nonce: "0011223344556677".into(),
        }
    }

    fn settings(at: &str) -> Payload {
        Payload::Settings {
            enabled: false,
            board: true,
            at: at.to_owned(),
        }
    }

    fn hide(record: &str, at: &str) -> Payload {
        Payload::Hide {
            record: record.to_owned(),
            hidden: true,
            at: at.to_owned(),
        }
    }

    fn work(at: &str) -> Payload {
        Payload::Work {
            at: at.to_owned(),
            items: vec![WorkItem {
                p: "ab".repeat(16),
                t: "cd".repeat(16),
                done: "2026-11-24T01:00:00Z".into(),
                why: WorkWhy::Assigned,
            }],
        }
    }

    fn ids(l: &Laptop) -> Vec<String> {
        l.with(|c| store::ids(&c.db).unwrap())
    }

    fn rejected(l: &Laptop) -> i64 {
        l.with(|c| {
            c.db.query_row(
                "SELECT COUNT(*) FROM rejected_changes WHERE code = ?1",
                [REJECT_CODE],
                |r| r.get(0),
            )
            .unwrap()
        })
    }

    #[test]
    fn ingest_checks_roles() {
        let mut lab = Lab::new(&["Sari", "Budi", "Citra"]);
        let team = lab.team.clone();
        let project = lab.register_project(0, Some(&team), &[1]);
        let guest = lab.add_guest("Tamu", &[&project]);
        let (sa, budi, citra, tamu) = (0, 1, 2, guest);
        let now = at_in(0);
        let receiver = sync(&lab.laptops[citra]);
        let from = lab.pk(budi);

        // Give from a guest: refused.
        let g = seal(&lab.laptops[tamu], &give(&lab.pk(citra), "m1", &now));
        let got = receiver.ingest(&from, vec![g]).unwrap();
        assert_eq!((got.accepted, got.rejected, got.changed), (0, 1, false));

        // Settings and hide from a non-superadmin: refused.
        let s = seal(&lab.laptops[budi], &settings(&now));
        let h = seal(&lab.laptops[budi], &hide(&"ee".repeat(32), &now));
        let got = receiver.ingest(&from, vec![s, h]).unwrap();
        assert_eq!((got.accepted, got.rejected), (0, 2));
        assert_eq!(rejected(&lab.laptops[citra]), 3);

        // From the superadmin, and a give and work from a member: stored.
        let ok = vec![
            seal(&lab.laptops[sa], &settings(&now)),
            seal(&lab.laptops[sa], &hide(&"ee".repeat(32), &now)),
            seal(&lab.laptops[budi], &give(&lab.pk(tamu), "m2", &now)),
            seal(&lab.laptops[budi], &work(&now)),
            seal(&lab.laptops[tamu], &work(&now)),
        ];
        let got = receiver.ingest(&from, ok.clone()).unwrap();
        assert_eq!((got.accepted, got.rejected, got.changed), (5, 0, true));
        // Idempotent.
        let got = receiver.ingest(&from, ok).unwrap();
        assert_eq!((got.accepted, got.rejected, got.changed), (0, 0, false));

        // Someone outside the org.
        let outsider = Laptop::new("Luar");
        let w = seal(&outsider, &work(&now));
        let g = seal(&outsider, &give(&lab.pk(citra), "m3", &now));
        assert_eq!(receiver.ingest(&from, vec![w, g]).unwrap().rejected, 2);
        // A forged body never gets past `open`.
        let forged = FeatureRecord::new("{\"a\":\"x\"}");
        assert_eq!(receiver.ingest(&from, vec![forged]).unwrap().rejected, 1);
    }

    #[test]
    fn ingest_skips_records_from_the_future_until_later() {
        let lab = Lab::new(&["Sari", "Budi"]);
        let receiver = sync(&lab.laptops[1]);
        let from = lab.pk(0);
        let soon = seal(&lab.laptops[0], &give(&lab.pk(1), "m1", &at_in(FUTURE_SKEW_SECS - 30)));
        let late = seal(&lab.laptops[0], &give(&lab.pk(1), "m2", &at_in(3600)));
        let got = receiver.ingest(&from, vec![soon.clone(), late.clone()]).unwrap();
        assert_eq!((got.accepted, got.rejected), (1, 0));
        assert_eq!(receiver.unknown_ids(&[soon.id.clone(), late.id.clone()]).unwrap(), vec![late.id.clone()]);
        assert_eq!(rejected(&lab.laptops[1]), 0);

        // An hour later the same record is accepted.
        let later = clock::now() + Duration::seconds(3600);
        let got = receiver.ingest_at(&from, vec![late.clone()], later).unwrap();
        assert_eq!(got.accepted, 1);
        assert!(receiver.unknown_ids(&[late.id]).unwrap().is_empty());
    }

    #[test]
    fn never_valid_records_are_remembered_and_role_refusals_retried() {
        let mut lab = Lab::new(&["Sari", "Budi"]);
        let team = lab.team.clone();
        let project = lab.register_project(0, Some(&team), &[1]);
        let tamu = lab.add_guest("Tamu", &[&project]);
        let receiver = sync(&lab.laptops[1]);
        let from = lab.pk(0);

        // Bad signature or shape, id matching the body: never asked again.
        let forged = FeatureRecord::new("{\"a\":\"x\"}");
        assert_eq!(receiver.ingest(&from, vec![forged.clone()]).unwrap().rejected, 1);
        assert!(receiver.unknown_ids(std::slice::from_ref(&forged.id)).unwrap().is_empty());
        // Sent again anyway: skipped, not logged twice.
        assert_eq!(receiver.ingest(&from, vec![forged]).unwrap().rejected, 0);
        assert_eq!(rejected(&lab.laptops[1]), 1);

        // A body that does not match its id says nothing about that id.
        let real = seal(&lab.laptops[0], &give(&lab.pk(1), "m1", &at_in(0)));
        let swapped = FeatureRecord {
            id: real.id.clone(),
            body: "{\"a\":\"x\"}".into(),
        };
        assert_eq!(receiver.ingest(&from, vec![swapped]).unwrap().rejected, 1);
        assert_eq!(receiver.unknown_ids(std::slice::from_ref(&real.id)).unwrap(), vec![real.id.clone()]);
        assert_eq!(receiver.ingest(&from, vec![real]).unwrap().accepted, 1);

        // A role refusal is retried on every sync but logged once.
        let g = seal(&lab.laptops[tamu], &give(&lab.pk(1), "m2", &at_in(0)));
        for _ in 0..3 {
            assert_eq!(receiver.ingest(&from, vec![g.clone()]).unwrap().rejected, 1);
            assert_eq!(receiver.unknown_ids(std::slice::from_ref(&g.id)).unwrap(), vec![g.id.clone()]);
        }
        assert_eq!(rejected(&lab.laptops[1]), 3);

        // A kind from a newer Mira is asked for again, so it can be accepted
        // once this laptop updates.
        for p in [
            r#"{"t":"cheers","at":"2026-12-01T08:00:00Z"}"#,
            r#"{"t":"give","to":"x","target":{"kind":"document","id":"d"},"reason":"r","at":"2026-12-01T08:00:00Z","nonce":"0123456789abcdef"}"#,
        ] {
            let body = serde_json::json!({ "a": from, "p": p, "s": "0".repeat(128) }).to_string();
            let newer = FeatureRecord::new(body);
            assert_eq!(receiver.ingest(&from, vec![newer.clone()]).unwrap().rejected, 1);
            assert_eq!(receiver.unknown_ids(std::slice::from_ref(&newer.id)).unwrap(), vec![newer.id]);
        }
    }

    #[test]
    fn flooding_gives_and_admin_records_is_refused_for_now() {
        let lab = Lab::new(&["Sari", "Budi", "Citra"]);
        let receiver = sync(&lab.laptops[2]);
        let from = lab.pk(1);
        let now = OffsetDateTime::parse("2026-11-26T04:00:00Z", &time::format_description::well_known::Rfc3339)
            .unwrap();

        // Budi: twice the daily limit stored on the local 26th, then refused.
        let gives: Vec<FeatureRecord> = (0..=GIVE_STORED_DAILY_MAX)
            .map(|i| {
                let at = format!("2026-11-26T09:{i:02}:00+07:00");
                seal(&lab.laptops[1], &give(&lab.pk(2), &format!("m{i}"), &at))
            })
            .collect();
        let got = receiver.ingest_at(&from, gives.clone(), now).unwrap();
        assert_eq!((got.accepted, got.rejected), (GIVE_STORED_DAILY_MAX, 1));
        let extra = gives.last().unwrap().clone();
        assert_eq!(receiver.unknown_ids(std::slice::from_ref(&extra.id)).unwrap(), vec![extra.id.clone()]);
        let got = receiver.ingest_at(&from, vec![extra], now).unwrap();
        assert_eq!(got.rejected, 1);
        assert_eq!(rejected(&lab.laptops[2]), 1, "logged once");
        // Another local day is fine.
        let next = seal(&lab.laptops[1], &give(&lab.pk(2), "m99", "2026-11-25T23:00:00+07:00"));
        assert_eq!(receiver.ingest_at(&from, vec![next], now).unwrap().accepted, 1);

        // The superadmin: at most ADMIN_STORED_DAILY_MAX per UTC day.
        let base = OffsetDateTime::parse("2026-11-25T01:00:00Z", &time::format_description::well_known::Rfc3339)
            .unwrap();
        let many: Vec<FeatureRecord> = (0..ADMIN_STORED_DAILY_MAX as i64)
            .map(|i| seal(&lab.laptops[0], &settings(&clock::format_rfc3339(base + Duration::seconds(i)))))
            .collect();
        let got = receiver.ingest_at(&from, many, now).unwrap();
        assert_eq!(got.accepted, ADMIN_STORED_DAILY_MAX);
        // Local 26th but UTC 25th: refused.
        let late = seal(&lab.laptops[0], &hide(&"ee".repeat(32), "2026-11-26T06:30:00+07:00"));
        assert_eq!(receiver.ingest_at(&from, vec![late], now).unwrap().rejected, 1);
        let next = seal(&lab.laptops[0], &hide(&"ee".repeat(32), "2026-11-26T07:30:00+07:00"));
        assert_eq!(receiver.ingest_at(&from, vec![next], now).unwrap().accepted, 1);
    }

    #[test]
    fn replaced_work_snapshot_is_not_asked_for_again() {
        let lab = Lab::new(&["Sari", "Budi"]);
        let receiver = sync(&lab.laptops[1]);
        let from = lab.pk(0);
        let old = seal(&lab.laptops[0], &work(&at_in(-120)));
        let new = seal(&lab.laptops[0], &work(&at_in(-60)));
        assert_eq!(receiver.ingest(&from, vec![new.clone()]).unwrap().accepted, 1);
        let got = receiver.ingest(&from, vec![old.clone()]).unwrap();
        assert_eq!((got.accepted, got.rejected, got.changed), (0, 0, false));
        assert!(receiver.unknown_ids(&[old.id, new.id.clone()]).unwrap().is_empty());
        assert_eq!(ids(&lab.laptops[1]), vec![new.id]);
    }

    #[test]
    fn scoping_members_guests_and_outsiders() {
        let mut lab = Lab::new(&["Sari", "Budi", "Citra"]);
        let team = lab.team.clone();
        let project = lab.register_project(0, Some(&team), &[1]);
        let tamu = lab.add_guest("Tamu", &[&project]);
        let now = at_in(0);
        let l0 = &lab.laptops[0];
        let to_guest = store(l0, &give(&lab.pk(tamu), "m1", &now));
        let to_budi = store(l0, &give(&lab.pk(1), "m2", &now));
        let s = store(l0, &settings(&now));
        let hide_guest = store(l0, &hide(&to_guest.id, &now));
        let hide_budi = store(l0, &hide(&to_budi.id, &now));
        let w = store(l0, &work(&now));
        let all = {
            let mut v = vec![
                to_guest.id.clone(),
                to_budi.id.clone(),
                s.id.clone(),
                hide_guest.id.clone(),
                hide_budi.id.clone(),
                w.id.clone(),
            ];
            v.sort();
            v
        };
        let f = sync(l0);
        assert_eq!(f.record_ids_for(&lab.pk(2)).unwrap(), all, "member gets all");
        let mut for_guest = vec![to_guest.id.clone(), s.id.clone(), hide_guest.id.clone()];
        for_guest.sort();
        assert_eq!(f.record_ids_for(&lab.pk(tamu)).unwrap(), for_guest);
        let outsider = Laptop::new("Luar");
        assert!(f.record_ids_for(&outsider.pk).unwrap().is_empty());

        // `records_for` filters what the peer asks for.
        let got = f.records_for(&lab.pk(tamu), &all).unwrap();
        let mut got_ids: Vec<String> = got.into_iter().map(|r| r.id).collect();
        got_ids.sort();
        assert_eq!(got_ids, for_guest);
        assert!(f.records_for(&outsider.pk, &all).unwrap().is_empty());
        assert_eq!(f.records_for(&lab.pk(2), &all).unwrap().len(), all.len());

        // A removed member gets nothing.
        lab.remove(2);
        assert!(f.record_ids_for(&lab.pk(2)).unwrap().is_empty());
    }

    #[test]
    fn three_laptops_converge() {
        let mut lab = Lab::new(&["Sari", "Budi", "Citra"]);
        let team = lab.team.clone();
        let project = lab.register_project(0, Some(&team), &[1]);
        let tamu = lab.add_guest("Tamu", &[&project]);
        let now = at_in(0);
        let (l0, l1, l2) = (&lab.laptops[0], &lab.laptops[1], &lab.laptops[2]);
        store(l1, &give(&lab.pk(2), "m1", &now));
        let to_guest = store(l2, &give(&lab.pk(tamu), "m2", &now));
        store(l2, &work(&now));
        store(l0, &settings(&now));
        store(l0, &hide(&to_guest.id, &now));
        store(l0, &give(&lab.pk(1), "m3", &now));

        let (s0, s1, s2, s3) = (sync(l0), sync(l1), sync(l2), sync(&lab.laptops[tamu]));
        let laptops: Vec<(&str, &dyn FeatureSync)> = vec![
            (l0.pk.as_str(), &s0),
            (l1.pk.as_str(), &s1),
            (l2.pk.as_str(), &s2),
            (lab.laptops[tamu].pk.as_str(), &s3),
        ];
        testing::sync_all(&laptops).unwrap();
        let a = ids(l0);
        assert_eq!(a.len(), 6);
        assert_eq!(ids(l1), a);
        assert_eq!(ids(l2), a);
        // The guest holds only the settings, its give and that give's hide.
        assert_eq!(ids(&lab.laptops[tamu]).len(), 3);
        for l in [l0, l1, l2, &lab.laptops[tamu]] {
            assert_eq!(rejected(l), 0, "{}", l.name);
        }
    }
}
