//! Kopi rules: the deterministic fold (docs/plans/kopi.md, 3.3).
//!
//! Pure: no SQLite, no clock. Laptops holding the same records, org state
//! and boards compute the same `KopiState`, whatever order the input is in
//! (everything is sorted here first; duplicate record ids count once).
//!
//! Order of records is `(at as an instant, record id)`. A record whose `at`
//! does not parse as RFC 3339 is ignored.
//!
//! Settings: the latest `Settings` record from a current superadmin
//! (`OrgState::is_superadmin`: active and superadmin now) wins. With none,
//! the feature and the board are on. Records from anyone else are ignored.
//!
//! Gives, in record order. A give counts when:
//! - the giver is in `org.members` with kind `Member` (guests never give)
//!   and is active, or was removed later than the give's `at`;
//! - the recipient is in `org.members` (member or guest) and is not the
//!   giver;
//! - `at` is not before `KOPI_EPOCH`, nor before the giver's or the
//!   recipient's `joined_at` (a give backdated by a changed clock to a time
//!   nobody can check anymore never counts);
//! - the giver has no counted give with the same `Target::key` yet (once
//!   per message, once per task, once per recipient per profile day);
//! - the giver has fewer than `PAIR_MONTHLY_LIMIT` counted gives to the
//!   same recipient in the same local calendar month (the month written in
//!   `at`);
//! - the giver has fewer than `GIVE_DAILY_LIMIT` counted gives on the same
//!   local day, the date written in `at` with its own offset (so
//!   23:30+07:00 and 00:30+07:00 the next morning are two days even though
//!   both fall on one UTC day).
//!
//! The last three checks only read counters of gives that counted, and a
//! give that fails any of them uses nothing: it claims no target key and
//! no pair or daily quota. So the order of these checks does not change
//! the result; they run as listed.
//!
//! Hide: per give id, the latest `Hide` record from a current superadmin
//! sets `hidden`. A hidden give stays in `gives` and keeps using the
//! giver's quotas and key, but adds nothing to totals.
//!
//! Work: `local_work` (computed from boards this laptop holds) for projects
//! in `readable_projects`, plus, per author, the items of the author's
//! latest `Work` snapshot (claims) for projects NOT in `readable_projects`,
//! only when:
//! - the project is in `org.projects`, has at least 2 people, and the
//!   author is one of them (`work::people`, the same set the board uses);
//! - the item's `done` is not more than `FUTURE_SKEW_SECS` after the
//!   snapshot's `at`, not before the project's `created_at`, and not before
//!   the author was added to the project (`ProjectMember::added_at`, when
//!   the author is an explicit member).
//!
//! Then `cap_work`: Board events always win over claims for the same task;
//! one Kopi per `(project, task, recipient)`; at most `WORK_DAILY_LIMIT` per
//! recipient per UTC day of `done_at`, earliest first. A claim never removes
//! anyone else's Kopi.
//!
//! The feature being off does not change the fold; views and commands
//! filter.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use time::{Date, Duration, OffsetDateTime, UtcOffset};

use super::types::{
    FUTURE_SKEW_SECS, GIVE_DAILY_LIMIT, GiveEntry, KOPI_EPOCH, KopiState, PAIR_MONTHLY_LIMIT,
    Payload, Settings, StoredRecord, WORK_DAILY_LIMIT, WorkEvent, WorkItem, WorkSource,
};
use super::work::people;
use crate::permissions::format::parse_time;
use crate::permissions::{MemberKind, MemberStatus, OrgState};

pub fn fold(
    records: &[StoredRecord],
    org: &OrgState,
    local_work: &[WorkEvent],
    readable_projects: &HashSet<String>,
) -> KopiState {
    let mut recs: Vec<&StoredRecord> = records.iter().collect();
    recs.sort_by(|a, b| a.id.cmp(&b.id));
    recs.dedup_by(|a, b| a.id == b.id);

    let mut gives = fold_gives(&recs, org);
    let hidden = fold_hides(&recs, org);
    for g in &mut gives {
        g.hidden = hidden.get(g.id.as_str()).copied().unwrap_or(false);
    }

    KopiState {
        settings: fold_settings(&recs, org),
        gives,
        work: fold_work(&recs, org, local_work, readable_projects),
    }
}

/// The Kopi from work that count. Events whose `done_at` does not parse
/// are dropped. Then:
/// - a `Claim` for a `(project, task)` that has a `Board` event is dropped
///   (the board this laptop reads always wins);
/// - one event per `(project, task, recipient)`, the earliest;
/// - in order `(done_at, project, task, recipient, ...)`, at most
///   `WORK_DAILY_LIMIT` per `(recipient, UTC date of done_at)`.
///
/// Claims are only deduplicated per recipient, so a forged claim on
/// someone else's task can never take that person's Kopi away; it only
/// competes with the forger's own daily limit.
pub fn cap_work(events: Vec<WorkEvent>) -> Vec<WorkEvent> {
    let on_board: HashSet<(String, String)> = events
        .iter()
        .filter(|e| e.source == WorkSource::Board)
        .map(|e| (e.project_id.clone(), e.task_id.clone()))
        .collect();
    let mut timed: Vec<(i128, WorkEvent)> = events
        .into_iter()
        .filter(|e| {
            e.source == WorkSource::Board
                || !on_board.contains(&(e.project_id.clone(), e.task_id.clone()))
        })
        .filter_map(|e| parse_time(&e.done_at).map(|t| (t.unix_timestamp_nanos(), e)))
        .collect();
    timed.sort_by(|(ta, a), (tb, b)| {
        ta.cmp(tb)
            .then_with(|| a.project_id.cmp(&b.project_id))
            .then_with(|| a.task_id.cmp(&b.task_id))
            .then_with(|| a.recipient.cmp(&b.recipient))
            .then_with(|| source_rank(a.source).cmp(&source_rank(b.source)))
            .then_with(|| a.why.cmp(&b.why))
            .then_with(|| a.title.cmp(&b.title))
            .then_with(|| a.done_at.cmp(&b.done_at))
    });

    let mut seen: HashSet<(String, String, String)> = HashSet::new();
    let mut per_day: HashMap<(String, Date), usize> = HashMap::new();
    let mut out = Vec::new();
    for (nanos, e) in timed {
        let key = (e.project_id.clone(), e.task_id.clone(), e.recipient.clone());
        if !seen.insert(key) {
            continue;
        }
        let Ok(t) = OffsetDateTime::from_unix_timestamp_nanos(nanos) else {
            continue;
        };
        let used = per_day.entry((e.recipient.clone(), t.date())).or_insert(0);
        if *used >= WORK_DAILY_LIMIT {
            continue;
        }
        *used += 1;
        out.push(e);
    }
    out
}

/// `(peer, work)` Kopi of `pk`; hidden gives do not count.
pub fn totals(state: &KopiState, pk: &str) -> (u32, u32) {
    let peer = state
        .gives
        .iter()
        .filter(|g| !g.hidden && g.to == pk)
        .count();
    let work = state.work.iter().filter(|w| w.recipient == pk).count();
    (to_u32(peer), to_u32(work))
}

/// `(pk, peer, work)` for everyone with Kopi in `month` (`YYYY-MM`),
/// ordered by public key. A give counts in the month of its `at` (the
/// giver's local date), work in the UTC month of `done_at`. Hidden gives do
/// not count.
pub fn month_totals(state: &KopiState, month: &str) -> Vec<(String, u32, u32)> {
    let mut by: BTreeMap<&str, (u32, u32)> = BTreeMap::new();
    for g in &state.gives {
        if !g.hidden && g.day.get(..7) == Some(month) && g.day.len() == 10 {
            let e = by.entry(g.to.as_str()).or_default();
            e.0 = e.0.saturating_add(1);
        }
    }
    for w in &state.work {
        let in_month = parse_time(&w.done_at)
            .is_some_and(|t| month_of(t.to_offset(UtcOffset::UTC).date()) == month);
        if in_month {
            let e = by.entry(w.recipient.as_str()).or_default();
            e.1 = e.1.saturating_add(1);
        }
    }
    by.into_iter()
        .map(|(pk, (peer, work))| (pk.to_owned(), peer, work))
        .collect()
}

/// Counted gives by `from` on the local `day` (`YYYY-MM-DD`), hidden ones
/// included: they use the quota too.
pub fn given_on(state: &KopiState, from: &str, day: &str) -> usize {
    state
        .gives
        .iter()
        .filter(|g| g.from == from && g.day == day)
        .count()
}

/// Counted gives by `from` to `to` in the local `month` (`YYYY-MM`), hidden
/// ones included: they use the pair quota too.
pub fn given_pair_month(state: &KopiState, from: &str, to: &str, month: &str) -> usize {
    state
        .gives
        .iter()
        .filter(|g| g.from == from && g.to == to && g.day.get(..7) == Some(month))
        .count()
}

/// Target keys `from` already used (hidden gives included), sorted.
pub fn given_keys(state: &KopiState, from: &str) -> Vec<String> {
    let mut keys: Vec<String> = state
        .gives
        .iter()
        .filter(|g| g.from == from)
        .map(|g| g.target.key(&g.to))
        .collect();
    keys.sort();
    keys.dedup();
    keys
}

fn fold_settings(recs: &[&StoredRecord], org: &OrgState) -> Settings {
    let mut best: Option<((i128, &str), Settings)> = None;
    for r in recs {
        let Payload::Settings { enabled, board, at } = &r.payload else {
            continue;
        };
        if !org.is_superadmin(&r.author) {
            continue;
        }
        let Some(t) = parse_time(at) else { continue };
        let key = (t.unix_timestamp_nanos(), r.id.as_str());
        if best.as_ref().is_none_or(|(k, _)| key > *k) {
            best = Some((
                key,
                Settings {
                    enabled: *enabled,
                    board: *board,
                    changed_by: Some(r.author.clone()),
                    changed_at: Some(at.clone()),
                },
            ));
        }
    }
    best.map(|(_, s)| s).unwrap_or_default()
}

fn fold_gives(recs: &[&StoredRecord], org: &OrgState) -> Vec<GiveEntry> {
    let epoch = parse_time(KOPI_EPOCH);
    let mut candidates: Vec<(i128, GiveEntry)> = Vec::new();
    for r in recs {
        let Payload::Give {
            to,
            target,
            reason,
            at,
            ..
        } = &r.payload
        else {
            continue;
        };
        let Some(t) = parse_time(at) else { continue };
        if !may_give(org, &r.author, t) || *to == r.author || !org.members.contains_key(to) {
            continue;
        }
        let earliest = [epoch, joined(org, &r.author), joined(org, to)]
            .into_iter()
            .flatten()
            .max();
        if earliest.is_some_and(|e| t < e) {
            continue;
        }
        candidates.push((
            t.unix_timestamp_nanos(),
            GiveEntry {
                id: r.id.clone(),
                from: r.author.clone(),
                to: to.clone(),
                target: target.clone(),
                reason: reason.clone(),
                at: at.clone(),
                day: day_of(t.date()),
                hidden: false,
            },
        ));
    }
    candidates.sort_by(|(ta, a), (tb, b)| ta.cmp(tb).then_with(|| a.id.cmp(&b.id)));

    let mut keys: HashSet<(String, String)> = HashSet::new();
    let mut per_pair: HashMap<(String, String, String), usize> = HashMap::new();
    let mut per_day: HashMap<(String, String), usize> = HashMap::new();
    let mut out = Vec::new();
    for (_, g) in candidates {
        let key = (g.from.clone(), g.target.key(&g.to));
        if keys.contains(&key) {
            continue;
        }
        let month = g.day.get(..7).unwrap_or_default().to_owned();
        let pair = (g.from.clone(), g.to.clone(), month);
        if per_pair.get(&pair).copied().unwrap_or(0) >= PAIR_MONTHLY_LIMIT {
            continue;
        }
        let day = (g.from.clone(), g.day.clone());
        if per_day.get(&day).copied().unwrap_or(0) >= GIVE_DAILY_LIMIT {
            continue;
        }
        *per_pair.entry(pair).or_insert(0) += 1;
        *per_day.entry(day).or_insert(0) += 1;
        keys.insert(key);
        out.push(g);
    }
    out
}

/// When `pk` joined the org, if known and readable.
fn joined(org: &OrgState, pk: &str) -> Option<OffsetDateTime> {
    org.members.get(pk).and_then(|m| parse_time(&m.joined_at))
}

/// A member (never a guest) who is active, or was removed after `at`.
fn may_give(org: &OrgState, pk: &str, at: OffsetDateTime) -> bool {
    let Some(m) = org.members.get(pk) else {
        return false;
    };
    if m.kind != MemberKind::Member {
        return false;
    }
    match m.status {
        MemberStatus::Active => true,
        MemberStatus::Removed => m
            .removed_at
            .as_deref()
            .and_then(parse_time)
            .is_some_and(|removed| at < removed),
        // 0.6.0: gives made before the suspension stand, like a removal.
        MemberStatus::Suspended => m
            .suspended_at
            .as_deref()
            .and_then(parse_time)
            .is_some_and(|suspended| at < suspended),
    }
}

/// Give id -> hidden, from the latest `Hide` per give by a current
/// superadmin.
fn fold_hides<'a>(recs: &[&'a StoredRecord], org: &OrgState) -> HashMap<&'a str, bool> {
    let mut latest: HashMap<&'a str, ((i128, &'a str), bool)> = HashMap::new();
    for &r in recs {
        let Payload::Hide { record, hidden, at } = &r.payload else {
            continue;
        };
        if !org.is_superadmin(&r.author) {
            continue;
        }
        let Some(t) = parse_time(at) else { continue };
        let key = (t.unix_timestamp_nanos(), r.id.as_str());
        let slot = latest.entry(record.as_str()).or_insert((key, *hidden));
        if key > slot.0 {
            *slot = (key, *hidden);
        }
    }
    latest.into_iter().map(|(id, (_, h))| (id, h)).collect()
}

fn fold_work(
    recs: &[&StoredRecord],
    org: &OrgState,
    local_work: &[WorkEvent],
    readable: &HashSet<String>,
) -> Vec<WorkEvent> {
    let mut events: Vec<WorkEvent> = local_work
        .iter()
        .filter(|e| readable.contains(&e.project_id))
        .cloned()
        .collect();

    let mut latest: BTreeMap<&str, Snapshot> = BTreeMap::new();
    for r in recs {
        let Payload::Work { at, items } = &r.payload else {
            continue;
        };
        let Some(t) = parse_time(at) else { continue };
        let key = (t.unix_timestamp_nanos(), r.id.as_str());
        let slot = latest
            .entry(r.author.as_str())
            .or_insert((key, t, items.as_slice()));
        if key > slot.0 {
            *slot = (key, t, items.as_slice());
        }
    }

    let mut who: HashMap<&str, BTreeSet<String>> = HashMap::new();
    for (author, (_, at, items)) in latest {
        let newest = at + Duration::seconds(FUTURE_SKEW_SECS);
        for item in items {
            let p = item.p.as_str();
            if readable.contains(p) {
                continue;
            }
            let Some(project) = org.projects.get(p) else {
                continue;
            };
            let set = who.entry(p).or_insert_with(|| people(org, p));
            if set.len() < 2 || !set.contains(author) {
                continue;
            }
            let Some(done) = parse_time(&item.done) else {
                continue;
            };
            let added = project
                .members
                .get(author)
                .and_then(|m| parse_time(&m.added_at));
            let earliest = [parse_time(&project.created_at), added]
                .into_iter()
                .flatten()
                .max();
            if done > newest || earliest.is_some_and(|e| done < e) {
                continue;
            }
            events.push(WorkEvent {
                project_id: item.p.clone(),
                task_id: item.t.clone(),
                title: None,
                recipient: author.to_owned(),
                done_at: item.done.clone(),
                why: item.why,
                source: WorkSource::Claim,
            });
        }
    }
    cap_work(events)
}

/// The latest work snapshot of one author: order key `(at, record id)`,
/// its `at`, and its items.
type Snapshot<'a> = ((i128, &'a str), OffsetDateTime, &'a [WorkItem]);

fn source_rank(s: WorkSource) -> u8 {
    match s {
        WorkSource::Board => 0,
        WorkSource::Claim => 1,
    }
}

fn day_of(d: Date) -> String {
    format!("{:04}-{:02}-{:02}", d.year(), u8::from(d.month()), d.day())
}

fn month_of(d: Date) -> String {
    format!("{:04}-{:02}", d.year(), u8::from(d.month()))
}

fn to_u32(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kopi::types::{Target, WorkWhy};
    use crate::org::Organization;
    use crate::permissions::{MemberState, ProjectMember, ProjectState};

    fn pk(c: char) -> String {
        c.to_string().repeat(64)
    }

    /// a: superadmin, b and c: members, g: guest, r: removed on
    /// 2026-12-20 (was superadmin). Projects: p1 {a, b}, p2 {b}, p3 {a, b, c},
    /// p4 {a, b}.
    fn org() -> OrgState {
        let a = pk('a');
        let mut s = OrgState::genesis(&Organization {
            id: "11".repeat(32),
            name: "Kantor".into(),
            founder_public_key: a.clone(),
            created_at: "2026-12-01T00:00:00Z".into(),
            genesis_signature: "00".repeat(64),
        });
        s.members.clear();
        let add = |s: &mut OrgState, c: char, kind, sa, removed: Option<&str>| {
            let k = pk(c);
            s.members.insert(
                k.clone(),
                MemberState {
                    public_key: k,
                    display_name: None,
                    status: if removed.is_some() {
                        MemberStatus::Removed
                    } else {
                        MemberStatus::Active
                    },
                    kind,
                    is_superadmin: sa,
                    joined_at: "2026-12-01T00:00:00Z".into(),
                    removed_at: removed.map(str::to_owned),
                    removal_op: None,
                    has_profile: true,
                    device: None,
                    suspended_at: None,
                    suspended_by: None,
                    suspension_op: None,
                    snapshot: None,
                    joint_suspensions: Vec::new(),
                    suspended_by_superadmin: false,
                },
            );
        };
        add(&mut s, 'a', MemberKind::Member, true, None);
        add(&mut s, 'b', MemberKind::Member, false, None);
        add(&mut s, 'c', MemberKind::Member, false, None);
        add(&mut s, 'd', MemberKind::Guest, false, None);
        add(&mut s, 'e', MemberKind::Member, true, Some("2026-12-20T00:00:00Z"));
        for (id, members) in [
            ("p1", vec!['a', 'b']),
            ("p2", vec!['b']),
            ("p3", vec!['a', 'b', 'c']),
            ("p4", vec!['a', 'b']),
        ] {
            s.projects.insert(
                id.into(),
                ProjectState {
                    id: id.into(),
                    team: None,
                    creator: a.clone(),
                    registered_by: a.clone(),
                    created_at: "2026-12-01T00:00:00Z".into(),
                    division: None,
                    members: members
                        .into_iter()
                        .map(|c| {
                            (
                                pk(c),
                                ProjectMember {
                                    added_at: "2026-12-01T00:00:00Z".into(),
                                    added_by: a.clone(),
                                },
                            )
                        })
                        .collect::<BTreeMap<_, _>>(),
                },
            );
        }
        s
    }

    fn guest() -> String {
        pk('d')
    }
    fn removed() -> String {
        pk('e')
    }

    fn rec(id: &str, author: &str, payload: Payload) -> StoredRecord {
        StoredRecord {
            id: id.into(),
            author: author.into(),
            payload,
        }
    }

    fn give(id: &str, from: &str, to: &str, target: Target, at: &str) -> StoredRecord {
        rec(
            id,
            from,
            Payload::Give {
                to: to.into(),
                target,
                reason: "Terima kasih".into(),
                at: at.into(),
                nonce: "0123456789abcdef".into(),
            },
        )
    }

    fn msg(id: &str) -> Target {
        Target::Message { id: id.into() }
    }

    fn hide(id: &str, by: &str, record: &str, hidden: bool, at: &str) -> StoredRecord {
        rec(
            id,
            by,
            Payload::Hide {
                record: record.into(),
                hidden,
                at: at.into(),
            },
        )
    }

    fn item(p: &str, t: &str, done: &str) -> WorkItem {
        WorkItem {
            p: p.into(),
            t: t.into(),
            done: done.into(),
            why: WorkWhy::Assigned,
        }
    }

    fn event(p: &str, t: &str, to: &str, done: &str) -> WorkEvent {
        WorkEvent {
            project_id: p.into(),
            task_id: t.into(),
            title: Some(format!("Task {t}")),
            recipient: to.into(),
            done_at: done.into(),
            why: WorkWhy::OnTime,
            source: WorkSource::Board,
        }
    }

    fn run(records: &[StoredRecord]) -> KopiState {
        fold(records, &org(), &[], &HashSet::new())
    }

    fn ids(state: &KopiState) -> Vec<&str> {
        state.gives.iter().map(|g| g.id.as_str()).collect()
    }

    #[test]
    fn daily_limit_is_three_per_giver_per_local_day() {
        let (a, b) = (pk('a'), pk('b'));
        let records = [
            // UTC 2026-12-23 18:00, local day 2026-12-24.
            give("g1", &a, &b, msg("m1"), "2026-12-24T01:00:00+07:00"),
            give("g2", &a, &b, msg("m2"), "2026-12-24T08:00:00+07:00"),
            give("g3", &a, &b, msg("m3"), "2026-12-24T09:00:00+07:00"),
            // Fourth on local 2026-12-24 (UTC 16:30 on the 24th): dropped.
            give("g4", &a, &b, msg("m4"), "2026-12-24T23:30:00+07:00"),
            // Same UTC day as g4 (17:30 on the 24th), local day 2026-12-25.
            give("g5", &a, &b, msg("m5"), "2026-12-25T00:30:00+07:00"),
        ];
        let s = run(&records);
        assert_eq!(ids(&s), ["g1", "g2", "g3", "g5"]);
        assert_eq!(s.gives[0].day, "2026-12-24");
        assert_eq!(s.gives[3].day, "2026-12-25");
        assert_eq!(given_on(&s, &a, "2026-12-24"), 3);
        assert_eq!(given_on(&s, &a, "2026-12-25"), 1);
        assert_eq!(given_on(&s, &a, "2026-12-23"), 0);
        // A give dropped by the limit does not claim its key.
        assert!(!given_keys(&s, &a).contains(&"message:m4".to_owned()));
        // Another giver has their own quota.
        let mut more = records.to_vec();
        more.push(give("h1", &pk('c'), &b, msg("m1"), "2026-12-24T10:00:00+07:00"));
        assert_eq!(ids(&run(&more)), ["g1", "g2", "g3", "h1", "g5"]);
    }

    #[test]
    fn no_give_to_self() {
        let a = pk('a');
        let s = run(&[give("g1", &a, &a, msg("m1"), "2026-12-24T09:00:00+07:00")]);
        assert!(s.gives.is_empty());
    }

    #[test]
    fn once_per_message_task_and_profile_day() {
        let (a, b, c) = (pk('a'), pk('b'), pk('c'));
        let task = || Target::Task {
            project: "p1".into(),
            task: "t1".into(),
        };
        let profile = |d: &str| Target::Profile { day: d.into() };
        let records = [
            give("g01", &a, &b, msg("m1"), "2026-12-24T09:00:00+07:00"),
            give("g02", &a, &b, msg("m1"), "2026-12-24T09:01:00+07:00"),
            give("g03", &a, &b, profile("2026-12-24"), "2026-12-24T09:02:00+07:00"),
            give("g04", &a, &b, profile("2026-12-24"), "2026-12-24T09:03:00+07:00"),
            give("g05", &a, &c, profile("2026-12-24"), "2026-12-24T09:04:00+07:00"),
            give("g06", &a, &b, task(), "2026-12-25T09:00:00+07:00"),
            give("g07", &a, &b, task(), "2026-12-25T09:01:00+07:00"),
            give("g08", &a, &b, profile("2026-12-25"), "2026-12-25T09:02:00+07:00"),
            // Another giver may give for the same message.
            give("g09", &c, &b, msg("m1"), "2026-12-24T09:05:00+07:00"),
        ];
        let s = run(&records);
        assert_eq!(ids(&s), ["g01", "g03", "g05", "g09", "g06", "g08"]);
        let b_profile_24 = format!("profile:{b}:2026-12-24");
        let c_profile_24 = format!("profile:{c}:2026-12-24");
        let b_profile_25 = format!("profile:{b}:2026-12-25");
        let mut want = vec![
            "message:m1".to_owned(),
            b_profile_24,
            c_profile_24,
            b_profile_25,
            "task:p1:t1".to_owned(),
        ];
        want.sort();
        assert_eq!(given_keys(&s, &a), want);
        assert_eq!(given_keys(&s, &c), ["message:m1"]);
        // Duplicates did not use the quota.
        assert_eq!(given_on(&s, &a, "2026-12-24"), 3);
    }

    #[test]
    fn guest_does_not_give_but_may_receive() {
        let (a, g) = (pk('a'), guest());
        let s = run(&[
            give("g1", &g, &a, msg("m1"), "2026-12-24T09:00:00+07:00"),
            give("g2", &a, &g, msg("m2"), "2026-12-24T09:00:00+07:00"),
        ]);
        assert_eq!(ids(&s), ["g2"]);
        assert_eq!(totals(&s, &g), (1, 0));
    }

    #[test]
    fn removed_member_counts_only_before_removal() {
        let (r, b) = (removed(), pk('b'));
        let s = run(&[
            give("g1", &r, &b, msg("m1"), "2026-12-19T23:59:59Z"),
            give("g2", &r, &b, msg("m2"), "2026-12-20T00:00:00Z"),
            give("g3", &r, &b, msg("m3"), "2026-12-21T08:00:00+07:00"),
        ]);
        assert_eq!(ids(&s), ["g1"]);
        // A removed person can still receive.
        let s = run(&[give("g4", &b, &r, msg("m4"), "2026-12-24T09:00:00+07:00")]);
        assert_eq!(ids(&s), ["g4"]);
    }

    #[test]
    fn unknown_people_and_bad_times_are_ignored() {
        let (a, x) = (pk('a'), pk('f'));
        let s = run(&[
            give("g1", &a, &x, msg("m1"), "2026-12-24T09:00:00+07:00"),
            give("g2", &x, &a, msg("m2"), "2026-12-24T09:00:00+07:00"),
            give("g3", &a, &pk('b'), msg("m3"), "kemarin"),
        ]);
        assert!(s.gives.is_empty());
    }

    #[test]
    fn hide_by_current_superadmin_latest_wins() {
        let (a, b, c) = (pk('a'), pk('b'), pk('c'));
        let gives = vec![
            give("g1", &b, &c, msg("m1"), "2026-12-24T09:00:00+07:00"),
            give("g2", &b, &c, msg("m2"), "2026-12-24T09:01:00+07:00"),
            give("g3", &b, &c, msg("m3"), "2026-12-24T09:02:00+07:00"),
            give("g4", &b, &c, msg("m4"), "2026-12-24T09:03:00+07:00"),
        ];
        let mut records = gives.clone();
        records.push(hide("h1", &a, "g1", true, "2026-12-24T10:00:00+07:00"));
        // Not a superadmin, or no longer one: ignored.
        records.push(hide("h2", &b, "g2", true, "2026-12-24T10:00:00+07:00"));
        records.push(hide("h3", &removed(), "g3", true, "2026-12-19T10:00:00Z"));
        let s = run(&records);
        assert_eq!(ids(&s), ["g1", "g2", "g3"]);
        let hidden: Vec<bool> = s.gives.iter().map(|g| g.hidden).collect();
        assert_eq!(hidden, [true, false, false]);
        assert_eq!(totals(&s, &c), (2, 0));
        // The hidden give still uses the quota: g4 stays out.
        assert_eq!(given_on(&s, &b, "2026-12-24"), 3);
        assert!(given_keys(&s, &b).contains(&"message:m1".to_owned()));

        // Unhide later wins.
        let mut later = records.clone();
        later.push(hide("h4", &a, "g1", false, "2026-12-24T11:00:00+07:00"));
        let s = run(&later);
        assert!(!s.gives[0].hidden);
        assert_eq!(totals(&s, &c), (3, 0));

        // Unhide earlier loses.
        let mut earlier = records;
        earlier.push(hide("h4", &a, "g1", false, "2026-12-24T09:30:00+07:00"));
        assert!(run(&earlier).gives[0].hidden);

        // Same `at`: the larger record id wins.
        let mut tie = gives;
        tie.push(hide("h5", &a, "g1", true, "2026-12-24T10:00:00Z"));
        tie.push(hide("h6", &a, "g1", false, "2026-12-24T10:00:00Z"));
        assert!(!run(&tie).gives[0].hidden);
    }

    #[test]
    fn settings_latest_from_superadmin_wins() {
        let (a, b) = (pk('a'), pk('b'));
        let set = |id: &str, by: &str, enabled, board, at: &str| {
            rec(
                id,
                by,
                Payload::Settings {
                    enabled,
                    board,
                    at: at.into(),
                },
            )
        };
        assert_eq!(run(&[]).settings, Settings::default());
        assert!(run(&[]).settings.enabled && run(&[]).settings.board);

        let s = run(&[
            set("s2", &a, true, false, "2026-12-24T10:00:00+07:00"),
            set("s1", &a, false, false, "2026-12-24T09:00:00+07:00"),
            set("s3", &b, false, true, "2026-12-24T11:00:00+07:00"),
            set("s4", &removed(), false, true, "2026-12-25T11:00:00+07:00"),
        ]);
        assert_eq!(
            s.settings,
            Settings {
                enabled: true,
                board: false,
                changed_by: Some(a.clone()),
                changed_at: Some("2026-12-24T10:00:00+07:00".into()),
            }
        );
        // Only non-superadmin settings: default.
        let s = run(&[set("s3", &b, false, false, "2026-12-24T11:00:00+07:00")]);
        assert_eq!(s.settings, Settings::default());
    }

    #[test]
    fn work_uses_board_for_readable_and_snapshots_for_the_rest() {
        let (a, b, c) = (pk('a'), pk('b'), pk('c'));
        let readable: HashSet<String> = ["p1".to_owned()].into();
        let local = vec![
            event("p1", "t1", &a, "2026-12-24T03:00:00Z"),
            // Not readable here: not used from local_work.
            event("p3", "tx", &a, "2026-12-24T03:00:00Z"),
        ];
        let work = |id: &str, by: &str, at: &str, items: Vec<WorkItem>| {
            rec(id, by, Payload::Work { at: at.into(), items })
        };
        let records = [
            // Older snapshot of b: replaced by the newer one.
            work(
                "w1",
                &b,
                "2026-12-24T05:00:00Z",
                vec![item("p3", "old", "2026-12-24T01:00:00Z")],
            ),
            work(
                "w2",
                &b,
                "2026-12-24T06:00:00Z",
                vec![
                    item("p1", "t2", "2026-12-24T02:00:00Z"), // readable: board wins
                    item("p3", "t3", "2026-12-24T02:00:00Z"), // kept
                    item("p2", "t4", "2026-12-24T02:00:00Z"), // one person
                    item("p9", "t5", "2026-12-24T02:00:00Z"), // unknown project
                ],
            ),
            // c is not a member of p4.
            work(
                "w3",
                &c,
                "2026-12-24T06:00:00Z",
                vec![item("p4", "t6", "2026-12-24T02:00:00Z")],
            ),
        ];
        let s = fold(&records, &org(), &local, &readable);
        let got: Vec<(&str, &str, &str, WorkSource)> = s
            .work
            .iter()
            .map(|w| {
                (
                    w.project_id.as_str(),
                    w.task_id.as_str(),
                    w.recipient.as_str(),
                    w.source,
                )
            })
            .collect();
        assert_eq!(
            got,
            [
                ("p3", "t3", b.as_str(), WorkSource::Claim),
                ("p1", "t1", a.as_str(), WorkSource::Board),
            ]
        );
        assert_eq!(s.work[0].title, None);
        assert_eq!(totals(&s, &b), (0, 1));
        assert_eq!(totals(&s, &a), (0, 1));
    }

    #[test]
    fn cap_work_three_per_person_per_utc_day_and_once_per_task() {
        let (a, b) = (pk('a'), pk('b'));
        let events = vec![
            event("p1", "t4", &a, "2026-12-24T20:00:00Z"),
            event("p1", "t1", &a, "2026-12-24T01:00:00Z"),
            event("p1", "t1", &a, "2026-12-24T00:30:00Z"), // same task, earlier
            event("p1", "t2", &a, "2026-12-24T02:00:00Z"),
            event("p1", "t3", &a, "2026-12-24T23:30:00Z"),
            event("p1", "t5", &a, "2026-12-25T00:30:00Z"), // next UTC day
            event("p1", "t6", &b, "2026-12-24T21:00:00Z"), // other person
            event("p1", "t7", &a, "not a time"),
        ];
        let out = cap_work(events);
        let got: Vec<(&str, &str)> = out
            .iter()
            .map(|e| (e.task_id.as_str(), e.done_at.as_str()))
            .collect();
        assert_eq!(
            got,
            [
                ("t1", "2026-12-24T00:30:00Z"),
                ("t2", "2026-12-24T02:00:00Z"),
                ("t4", "2026-12-24T20:00:00Z"),
                ("t6", "2026-12-24T21:00:00Z"),
                ("t5", "2026-12-25T00:30:00Z"),
            ]
        );
    }

    #[test]
    fn month_totals_use_local_give_month_and_utc_work_month() {
        let (a, b, c) = (pk('a'), pk('b'), pk('c'));
        let records = [
            give("g1", &a, &b, msg("m1"), "2026-12-31T20:00:00+07:00"),
            // UTC 2026-12-31 18:00, local January.
            give("g2", &a, &b, msg("m2"), "2027-01-01T01:00:00+07:00"),
            give("g3", &a, &c, msg("m3"), "2026-12-10T09:00:00+07:00"),
            hide("h1", &a, "g3", true, "2026-12-11T09:00:00+07:00"),
        ];
        let local = vec![
            event("p1", "t1", &c, "2026-12-31T23:30:00Z"),
            event("p1", "t2", &c, "2027-01-01T00:30:00Z"),
        ];
        let readable: HashSet<String> = ["p1".to_owned()].into();
        let s = fold(&records, &org(), &local, &readable);
        assert_eq!(
            month_totals(&s, "2026-12"),
            [(b.clone(), 1, 0), (c.clone(), 0, 1)]
        );
        assert_eq!(month_totals(&s, "2027-01"), [(b, 1, 0), (c, 0, 1)]);
        assert!(month_totals(&s, "2026-11").is_empty());
    }

    #[test]
    fn input_order_does_not_change_the_result() {
        let (a, b, c) = (pk('a'), pk('b'), pk('c'));
        let mut records = vec![
            give("g1", &a, &b, msg("m1"), "2026-12-24T09:00:00+07:00"),
            give("g2", &a, &b, msg("m2"), "2026-12-24T02:00:00Z"),
            give("g3", &a, &c, msg("m3"), "2026-12-24T09:00:00+07:00"),
            give("g4", &a, &c, msg("m4"), "2026-12-24T09:00:00+07:00"),
            give("g5", &a, &b, msg("m1"), "2026-12-24T08:00:00+07:00"),
            give("g6", &b, &a, msg("m9"), "2026-12-24T08:00:00+07:00"),
            hide("h1", &a, "g6", true, "2026-12-24T10:00:00Z"),
            hide("h2", &a, "g6", false, "2026-12-24T10:00:00Z"),
            rec(
                "s1",
                &a,
                Payload::Settings {
                    enabled: false,
                    board: true,
                    at: "2026-12-24T10:00:00Z".into(),
                },
            ),
            rec(
                "s2",
                &a,
                Payload::Settings {
                    enabled: true,
                    board: false,
                    at: "2026-12-24T17:00:00+07:00".into(),
                },
            ),
            rec(
                "w1",
                &b,
                Payload::Work {
                    at: "2026-12-24T06:00:00Z".into(),
                    items: vec![
                        item("p3", "t1", "2026-12-24T01:00:00Z"),
                        item("p3", "t2", "2026-12-24T01:00:00Z"),
                        item("p3", "t3", "2026-12-24T01:00:00Z"),
                        item("p3", "t4", "2026-12-24T01:00:00Z"),
                    ],
                },
            ),
        ];
        let base = run(&records);
        assert_eq!(base.gives.len(), 4);
        assert_eq!(base.work.len(), 3);
        for step in 1..records.len() {
            records.rotate_left(step);
            assert_eq!(run(&records), base);
            records.reverse();
            assert_eq!(run(&records), base);
        }
        // A record seen twice counts once.
        let mut doubled = records.clone();
        doubled.extend(records.iter().cloned());
        assert_eq!(run(&doubled), base);

        let local = vec![
            event("p1", "t1", &a, "2026-12-24T01:00:00Z"),
            event("p1", "t2", &a, "2026-12-24T01:00:00Z"),
            event("p1", "t3", &a, "2026-12-24T01:00:00Z"),
            event("p1", "t4", &a, "2026-12-24T01:00:00Z"),
        ];
        let mut reversed = local.clone();
        reversed.reverse();
        assert_eq!(cap_work(local), cap_work(reversed));
    }

    fn claim(p: &str, t: &str, to: &str, done: &str) -> WorkEvent {
        WorkEvent {
            title: None,
            source: WorkSource::Claim,
            why: WorkWhy::Assigned,
            ..event(p, t, to, done)
        }
    }

    fn work_rec(id: &str, by: &str, at: &str, items: Vec<WorkItem>) -> StoredRecord {
        rec(id, by, Payload::Work { at: at.into(), items })
    }

    fn work_of(s: &KopiState) -> Vec<(&str, &str, &str)> {
        s.work
            .iter()
            .map(|w| (w.project_id.as_str(), w.task_id.as_str(), w.recipient.as_str()))
            .collect()
    }

    #[test]
    fn a_claim_never_takes_anyone_elses_work_kopi() {
        let (a, b, c) = (pk('a'), pk('b'), pk('c'));
        // The board wins over a claim for the same task, even an earlier one.
        let out = cap_work(vec![
            claim("p1", "t1", &c, "2026-12-24T01:00:00Z"),
            event("p1", "t1", &a, "2026-12-24T02:00:00Z"),
        ]);
        assert_eq!(out.len(), 1);
        assert_eq!((out[0].recipient.as_str(), out[0].source), (a.as_str(), WorkSource::Board));

        // Two claims on one task by different people: neither removes the
        // other; each counts against its own daily limit only.
        let out = cap_work(vec![
            claim("p3", "t1", &b, "2026-12-24T02:00:00Z"),
            claim("p3", "t1", &c, "2026-12-24T01:00:00Z"),
            claim("p3", "t1", &c, "2026-12-24T00:30:00Z"),
        ]);
        let got: Vec<(&str, &str)> = out
            .iter()
            .map(|e| (e.recipient.as_str(), e.done_at.as_str()))
            .collect();
        assert_eq!(
            got,
            [(c.as_str(), "2026-12-24T00:30:00Z"), (b.as_str(), "2026-12-24T02:00:00Z")]
        );

        // Through the fold: c forges b's task in a snapshot, b keeps it.
        let records = [
            work_rec("w1", &b, "2026-12-24T06:00:00Z", vec![item("p3", "t1", "2026-12-24T02:00:00Z")]),
            work_rec("w2", &c, "2026-12-24T06:00:00Z", vec![item("p3", "t1", "2026-12-24T01:00:00Z")]),
        ];
        let s = run(&records);
        assert_eq!(totals(&s, &b), (0, 1));
        assert_eq!(totals(&s, &c), (0, 1));
    }

    #[test]
    fn snapshot_author_must_be_one_of_the_project_people() {
        let (a, b) = (pk('a'), pk('b'));
        let mut o = org();
        // p5 lists a guest and a removed member explicitly; only a and b work.
        let mut p5 = o.projects["p3"].clone();
        p5.id = "p5".into();
        for who in [guest(), removed()] {
            let m = p5.members[&a].clone();
            p5.members.insert(who, m);
        }
        p5.members.remove(&pk('c'));
        o.projects.insert("p5".into(), p5);
        let it = |t: &str| vec![item("p5", t, "2026-12-24T02:00:00Z")];
        let records = [
            work_rec("w1", &guest(), "2026-12-24T06:00:00Z", it("t1")),
            work_rec("w2", &removed(), "2026-12-24T06:00:00Z", it("t2")),
            work_rec("w3", &b, "2026-12-24T06:00:00Z", it("t3")),
        ];
        let s = fold(&records, &o, &[], &HashSet::new());
        assert_eq!(work_of(&s), [("p5", "t3", b.as_str())]);
        assert_eq!(super::people(&o, "p5").len(), 2);
    }

    #[test]
    fn snapshot_items_outside_the_possible_time_are_dropped() {
        let b = pk('b');
        let mut o = org();
        o.projects.get_mut("p3").unwrap().created_at = "2026-12-05T00:00:00Z".into();
        o.projects.get_mut("p1").unwrap().members.get_mut(&b).unwrap().added_at =
            "2026-12-10T00:00:00Z".into();
        // p1 is not readable here: b's claims for it go through the checks.
        let records = [work_rec(
            "w1",
            &b,
            "2026-12-24T06:00:00Z",
            vec![
                item("p3", "early", "2026-12-04T23:59:59Z"), // before the project
                item("p3", "ok1", "2026-12-05T00:00:00Z"),
                item("p1", "before-added", "2026-12-09T12:00:00Z"),
                item("p1", "ok2", "2026-12-10T12:00:00Z"),
                item("p3", "ok3", "2026-12-24T06:10:00Z"), // at + 600 s
                item("p3", "future", "2026-12-24T06:10:01Z"),
            ],
        )];
        let s = fold(&records, &o, &[], &HashSet::new());
        let mut tasks: Vec<&str> = s.work.iter().map(|w| w.task_id.as_str()).collect();
        tasks.sort();
        assert_eq!(tasks, ["ok1", "ok2", "ok3"]);
    }

    #[test]
    fn backdated_gives_never_count() {
        let (a, b, c) = (pk('a'), pk('b'), pk('c'));
        let mut o = org();
        for k in [&a, &b] {
            o.members.get_mut(k).unwrap().joined_at = "2026-01-01T00:00:00Z".into();
        }
        o.members.get_mut(&c).unwrap().joined_at = "2026-12-10T00:00:00Z".into();
        let records = [
            // Before the epoch.
            give("g1", &a, &b, msg("m1"), "2026-11-23T23:59:59Z"),
            give("g2", &a, &b, msg("m2"), "2026-11-24T06:59:59+07:00"),
            give("g3", &a, &b, msg("m3"), KOPI_EPOCH),
            // Before the recipient or the giver joined.
            give("g4", &a, &c, msg("m4"), "2026-12-09T23:59:59Z"),
            give("g5", &a, &c, msg("m5"), "2026-12-10T00:00:00Z"),
            give("g6", &c, &b, msg("m6"), "2026-12-09T12:00:00Z"),
            give("g7", &c, &b, msg("m7"), "2026-12-10T12:00:00Z"),
        ];
        let s = fold(&records, &o, &[], &HashSet::new());
        assert_eq!(ids(&s), ["g3", "g5", "g7"]);
        // A dropped give claims no key.
        assert!(!given_keys(&s, &a).contains(&"message:m1".to_owned()));
    }

    #[test]
    fn pair_limit_is_four_per_recipient_per_local_month() {
        let (a, b, c) = (pk('a'), pk('b'), pk('c'));
        let records = [
            give("g1", &a, &b, msg("m1"), "2026-12-02T09:00:00+07:00"),
            give("g2", &a, &b, msg("m2"), "2026-12-03T09:00:00+07:00"),
            give("g3", &a, &b, msg("m3"), "2026-12-04T09:00:00+07:00"),
            give("g4", &a, &b, msg("m4"), "2026-12-05T09:00:00+07:00"),
            // Fifth to b this month: dropped, uses no daily quota or key.
            give("g5", &a, &b, msg("m5"), "2026-12-06T09:00:00+07:00"),
            give("g6", &a, &c, msg("m6"), "2026-12-06T10:00:00+07:00"),
            give("g7", &a, &c, msg("m7"), "2026-12-06T11:00:00+07:00"),
            give("g8", &a, &c, msg("m8"), "2026-12-06T12:00:00+07:00"),
            // UTC December, local January: a new month for the pair.
            give("g9", &a, &b, msg("m5"), "2027-01-01T01:00:00+07:00"),
        ];
        let s = run(&records);
        assert_eq!(ids(&s), ["g1", "g2", "g3", "g4", "g6", "g7", "g8", "g9"]);
        assert_eq!(given_pair_month(&s, &a, &b, "2026-12"), PAIR_MONTHLY_LIMIT);
        assert_eq!(given_pair_month(&s, &a, &b, "2027-01"), 1);
        assert_eq!(given_pair_month(&s, &a, &c, "2026-12"), 3);
        assert_eq!(given_on(&s, &a, "2026-12-06"), 3);
        assert!(given_keys(&s, &a).contains(&"message:m5".to_owned()), "g9 took m5");
    }
}
