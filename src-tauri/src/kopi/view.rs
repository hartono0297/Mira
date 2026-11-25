//! What the Kopi screens read (docs/plans/kopi.md, 3.8). The JSON shapes
//! match `src/api/kopi.ts` exactly (camelCase). Everything here is pure: it
//! builds views from a folded `KopiState`, the `OrgState` and names known on
//! this laptop.

use std::cmp::Ordering;
use std::collections::{BTreeSet, HashMap};

use serde::Serialize;
use time::OffsetDateTime;

use super::rules;
use super::tier;
use super::types::{
    GIVE_DAILY_LIMIT, KopiState, REASON_MAX, Target, Tier, WorkEvent, WorkWhy,
};
use crate::identity;
use crate::permissions::OrgState;
use crate::permissions::format::parse_time;

/// Most entries in a profile history.
pub const HISTORY_MAX: usize = 100;
/// Most rows on the monthly board.
pub const BOARD_MAX: usize = 10;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KopiPerson {
    pub public_key: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KopiBadge {
    pub public_key: String,
    pub peer: u32,
    pub work: u32,
    pub score: u32,
    pub tier: Tier,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TierStep {
    pub tier: Tier,
    pub min_score: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KopiOverview {
    pub enabled: bool,
    pub board_enabled: bool,
    pub is_superadmin: bool,
    pub can_give: bool,
    pub me: String,
    pub given_today: usize,
    pub daily_limit: usize,
    pub reason_max: usize,
    pub given_targets: Vec<String>,
    pub badges: Vec<KopiBadge>,
    pub tiers: Vec<TierStep>,
    pub peer_weight: u32,
    pub work_weight: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum KopiEntry {
    Peer {
        id: String,
        from: KopiPerson,
        target: Target,
        reason: String,
        at: String,
        hidden: bool,
    },
    Work {
        /// `<project>:<task>`.
        id: String,
        project_id: String,
        task_id: String,
        title: Option<String>,
        project_name: Option<String>,
        why: WorkWhy,
        at: String,
    },
}

impl KopiEntry {
    fn at(&self) -> &str {
        match self {
            KopiEntry::Peer { at, .. } | KopiEntry::Work { at, .. } => at,
        }
    }

    fn id(&self) -> &str {
        match self {
            KopiEntry::Peer { id, .. } | KopiEntry::Work { id, .. } => id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KopiProfile {
    pub person: KopiPerson,
    pub peer: u32,
    pub work: u32,
    pub score: u32,
    pub tier: Tier,
    pub next: Option<TierStep>,
    pub history: Vec<KopiEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KopiBoardRow {
    pub person: KopiPerson,
    pub peer: u32,
    pub work: u32,
    pub score: u32,
    pub tier: Tier,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KopiBoard {
    pub month: String,
    pub enabled: bool,
    pub rows: Vec<KopiBoardRow>,
}

/// Names known on this laptop: the org log, this laptop's own name, and the
/// projects it can read.
pub struct Names<'a> {
    pub org: &'a OrgState,
    pub me: &'a str,
    pub my_name: Option<&'a str>,
    /// Project id to name, readable projects only.
    pub projects: &'a HashMap<String, String>,
}

impl Names<'_> {
    /// Best known name: from the log, else this laptop's own name, else the
    /// key fingerprint (same order as `permissions::display_name_for`).
    pub fn name(&self, pk: &str) -> String {
        if let Some(name) = self
            .org
            .member(pk)
            .and_then(|m| m.display_name.as_deref())
            .filter(|n| !n.trim().is_empty())
        {
            return name.to_owned();
        }
        if pk == self.me
            && let Some(name) = self.my_name.filter(|n| !n.trim().is_empty())
        {
            return name.to_owned();
        }
        identity::fingerprint(pk)
    }

    pub fn person(&self, pk: &str) -> KopiPerson {
        KopiPerson {
            public_key: pk.to_owned(),
            name: self.name(pk),
        }
    }
}

fn tiers() -> Vec<TierStep> {
    tier::THRESHOLDS
        .iter()
        .map(|(tier, min)| TierStep {
            tier: *tier,
            min_score: *min,
        })
        .collect()
}

/// Everyone who appears in the state (as recipient), sorted.
fn recipients(state: &KopiState) -> BTreeSet<&str> {
    state
        .gives
        .iter()
        .map(|g| g.to.as_str())
        .chain(state.work.iter().map(|w| w.recipient.as_str()))
        .collect()
}

/// `today` is the viewer's local `YYYY-MM-DD`. With the feature off there
/// are no badges (the marks next to names disappear).
pub fn overview(state: &KopiState, org: &OrgState, me: &str, today: &str) -> KopiOverview {
    let enabled = state.settings.enabled;
    let badges = if enabled {
        recipients(state)
            .into_iter()
            .filter_map(|pk| {
                let (peer, work) = rules::totals(state, pk);
                let score = tier::score(peer, work);
                (score > 0).then(|| KopiBadge {
                    public_key: pk.to_owned(),
                    peer,
                    work,
                    score,
                    tier: tier::of(score),
                })
            })
            .collect()
    } else {
        Vec::new()
    };
    KopiOverview {
        enabled,
        board_enabled: state.settings.board,
        is_superadmin: org.is_superadmin(me),
        can_give: enabled && org.is_active_non_guest(me),
        me: me.to_owned(),
        given_today: rules::given_on(state, me, today),
        daily_limit: GIVE_DAILY_LIMIT,
        reason_max: REASON_MAX,
        given_targets: rules::given_keys(state, me),
        badges,
        tiers: tiers(),
        peer_weight: tier::PEER_WEIGHT,
        work_weight: tier::WORK_WEIGHT,
    }
}

fn instant(at: &str) -> Option<OffsetDateTime> {
    parse_time(at)
}

/// Newest first by instant, then by id (descending) so the order is stable.
fn newest_first(a: &KopiEntry, b: &KopiEntry) -> Ordering {
    let (ta, tb) = (instant(a.at()), instant(b.at()));
    tb.cmp(&ta).then_with(|| b.id().cmp(a.id()))
}

fn work_entry(w: &WorkEvent, names: &Names) -> KopiEntry {
    let readable = names.projects.get(&w.project_id);
    KopiEntry::Work {
        id: format!("{}:{}", w.project_id, w.task_id),
        project_id: w.project_id.clone(),
        task_id: w.task_id.clone(),
        title: readable.and(w.title.clone()),
        project_name: readable.cloned(),
        why: w.why,
        at: w.done_at.clone(),
    }
}

/// Profile of `pk` as `viewer` sees it: hidden gives are listed only for a
/// superadmin (and never counted).
pub fn profile(state: &KopiState, names: &Names, viewer: &str, pk: &str) -> KopiProfile {
    let (peer, work) = rules::totals(state, pk);
    let score = tier::score(peer, work);
    let show_hidden = names.org.is_superadmin(viewer);
    let mut history: Vec<KopiEntry> = state
        .gives
        .iter()
        .filter(|g| g.to == pk && (show_hidden || !g.hidden))
        .map(|g| KopiEntry::Peer {
            id: g.id.clone(),
            from: names.person(&g.from),
            target: g.target.clone(),
            reason: g.reason.clone(),
            at: g.at.clone(),
            hidden: g.hidden,
        })
        .chain(
            state
                .work
                .iter()
                .filter(|w| w.recipient == pk)
                .map(|w| work_entry(w, names)),
        )
        .collect();
    history.sort_by(newest_first);
    history.truncate(HISTORY_MAX);
    KopiProfile {
        person: names.person(pk),
        peer,
        work,
        score,
        tier: tier::of(score),
        next: tier::next(score).map(|(tier, min_score)| TierStep { tier, min_score }),
        history,
    }
}

/// The monthly board of `month` (`YYYY-MM`): highest score first, then
/// public key; at most `BOARD_MAX` rows with a score above 0. Empty when
/// the feature or the board is off. Ties go by key, not name: names differ
/// between laptops (a name may not have arrived yet) and can be chosen to
/// win a tie, so the 10th place would differ from laptop to laptop.
pub fn board(state: &KopiState, names: &Names, month: &str) -> KopiBoard {
    let enabled = state.settings.enabled && state.settings.board;
    let mut rows: Vec<KopiBoardRow> = if enabled {
        rules::month_totals(state, month)
            .into_iter()
            .filter_map(|(pk, peer, work)| {
                let score = tier::score(peer, work);
                (score > 0).then(|| KopiBoardRow {
                    person: names.person(&pk),
                    peer,
                    work,
                    score,
                    tier: tier::of(score),
                })
            })
            .collect()
    } else {
        Vec::new()
    };
    rows.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.person.public_key.cmp(&b.person.public_key))
    });
    rows.truncate(BOARD_MAX);
    KopiBoard {
        month: month.to_owned(),
        enabled,
        rows,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kopi::types::{GiveEntry, Settings};
    use crate::org::Organization;

    #[test]
    fn board_ties_go_by_public_key_not_name() {
        let mut org = OrgState::genesis(&Organization {
            id: "11".repeat(32),
            name: "Kantor".into(),
            founder_public_key: "ff".repeat(32),
            created_at: "2026-11-24T00:00:00Z".into(),
            genesis_signature: "00".repeat(64),
        });
        let founder = org.members.values().next().unwrap().clone();
        // Name order is the opposite of key order.
        for (k, name) in [("aa", "Zainal"), ("cc", "Ani")] {
            let mut m = founder.clone();
            m.public_key = k.repeat(32);
            m.display_name = Some(name.into());
            org.members.insert(k.repeat(32), m);
        }
        let give = |id: &str, to: String| GiveEntry {
            id: id.into(),
            from: "ff".repeat(32),
            to,
            target: Target::Message { id: id.into() },
            reason: "Mantap".into(),
            at: "2026-11-25T09:00:00+07:00".into(),
            day: "2026-11-25".into(),
            hidden: false,
        };
        // Same score.
        let state = KopiState {
            settings: Settings::default(),
            gives: vec![give("g1", "cc".repeat(32)), give("g2", "aa".repeat(32))],
            work: Vec::new(),
        };
        let projects = HashMap::new();
        let names = Names {
            org: &org,
            me: "",
            my_name: None,
            projects: &projects,
        };
        let keys: Vec<String> = board(&state, &names, "2026-11")
            .rows
            .into_iter()
            .map(|r| r.person.public_key)
            .collect();
        assert_eq!(keys, ["aa".repeat(32), "cc".repeat(32)]);
    }
}
