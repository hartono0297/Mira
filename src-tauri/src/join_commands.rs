//! Requester side of joining by request (v0.3, docs/plans/v03-a.md section
//! 3, contract 8.3). TypeScript: `src/api/join.ts`.
//!
//! The logic is in plain async functions over `MiraState`, `Network` and
//! [`JoinClient`], so it runs in tests without Tauri; the commands at the
//! end only fetch the network and call them. The core lock is never held
//! across an await.
//!
//! Trust: mDNS hints only say where to ask. Every office shown comes from a
//! `join_info` answer whose genesis record verified locally, and an office is
//! the pair (org id, full genesis fingerprint). A request goes only to
//! laptops that answered for that exact pair, and never to an office whose
//! id is also claimed by another genesis (`conflict`).
//!
//! v0.4 (docs/plans/v04-onboarding.md): the request may carry a note for
//! the approver and the login account name. Mira v0.3 refuses requests with
//! either field, so they are added only for offices whose answering members
//! all said `extras >= 1` in `join_info` ([`FoundOffice::accepts_note`]).
//!
//! AD onboarding (docs/plans/onboarding-ad.md): the laptop's domain account
//! is read once per process ([`JoinClient::ad_profile`]) and, when the person
//! agrees, signed into the request as `ad`. That claim goes only to offices
//! whose AD domain is the laptop's own and whose answering members all said
//! `extras >= 2` ([`FoundOffice::accepts_ad`]); Mira v0.4.0 refuses it.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::net::SocketAddr;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::task::JoinSet;

use crate::ad::{self, LocalAd, OuMapping, dept::DeptSuggestion};
use crate::clock;
use crate::device;
use crate::error::{AppError, AppResult};
use crate::net_backend::{self, AppNet};
use crate::network::{
    JOIN_INFO_EXTRAS, JOIN_INFO_EXTRAS_AD, JoinInfoWire, JoinReject, JoinRequestWire,
    JoinStatusWire, Network, OfficeHint,
};
use crate::org::{self, OrgInfo, Organization};
use crate::peers;
use crate::permissions::join::{JOIN_ACCOUNT_MAX_CHARS, JoinAdClaim, JoinExtras};
use crate::permissions::{self, JoinDepartment, JoinTarget, OutgoingJoinRequest, OutgoingStatus};
use crate::settings;
use crate::state::MiraState;

/// `join_info_get` per laptop (plan 3.1).
pub const INFO_TIMEOUT: Duration = Duration::from_secs(4);
/// `join_request` and `join_status_get` per laptop. The member computes the
/// matching code (Argon2id) before answering, and an approval can be large.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
/// A member's `join_info` answer is reused this long before asking again.
pub const INFO_TTL: Duration = Duration::from_secs(60);
/// `join_request` goes again to members that have not received it.
pub const RESEND_EVERY: Duration = Duration::from_secs(60);
/// Laptops asked per organization in one search pass.
pub const MAX_QUERIES_PER_ORG: usize = 8;
/// Laptops asked in one search pass, over all organizations.
pub const MAX_QUERIES_PER_PASS: usize = 24;
/// Members a request is sent to at once.
pub const MAX_SEND: usize = 5;
/// Addresses typed by the person, kept so polling still reaches the office
/// after Mira restarts. JSON array of `ip:port` strings.
pub const SETTING_ADDRESSES: &str = "join.addresses";
const MAX_SAVED_ADDRESSES: usize = 8;
/// Offices and member answers kept in memory. Anyone on the LAN can answer
/// `join_info` with a fresh genesis or key on every pass, so both are
/// capped and stale entries dropped.
const MAX_OFFICES: usize = 16;
const MAX_ASKED: usize = 512;
/// OU mapping rows kept from one `join_info` answer (the op allows 100).
const MAX_OU_ROWS: usize = 100;
/// Longest OU name kept from a `join_info` answer, in characters.
const MAX_OU_CHARS: usize = 64;
/// A member that has not answered for this long no longer counts.
const MEMBER_TTL: Duration = Duration::from_secs(5 * 60);
/// A rejection signed by someone other than the founder is shown only when
/// no member has said "pending" for this long. The requester cannot check
/// who may reject (it has no log), so a laptop on the LAN could sign a
/// `join_reject` with any key; members holding the request contradict it.
pub const REJECT_CONFIRM: Duration = Duration::from_secs(30);

/// Command line argument that opens Mira in "set up the office" mode (v0.4,
/// for the IT admin preparing a laptop).
pub const SETUP_MODE_ARG: &str = "--siapkan-kantor";

/// Refusals that will not change by sending again to another member.
const FINAL_CODES: [&str; 5] = [
    "team_not_found",
    "removed",
    "request_expired",
    "invalid_request",
    "wrong_key",
];

// ----- Shapes (src/api/join.ts) ---------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinDevice {
    pub laptop: String,
    pub os: String,
    pub app_version: String,
    /// v0.4: login account name, signed into the request; `None` when the
    /// system does not tell.
    pub account: Option<String>,
    pub addresses: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundOffice {
    pub key: String,
    pub org_id: String,
    pub name: String,
    pub fingerprint: String,
    pub departments: Vec<JoinDepartment>,
    pub peer_count: usize,
    pub conflict: bool,
    pub same_name: bool,
    /// Every member that answered for this office is v0.4 or later: the
    /// request carries the note and the login account name.
    pub accepts_note: bool,
    /// The office's AD domain, lowercase ([`Office::ad`]).
    pub ad_domain: Option<String>,
    /// Every member that answered for this office takes the AD claim.
    pub accepts_ad: bool,
    /// 0.5.1: the most active members on a Mira too old for the AD claim
    /// that any answering member reported; `None` when no answer said
    /// (members before 0.5.1).
    pub ad_outdated: Option<u32>,
    /// From the verified genesis record (RFC 3339).
    pub created_at: String,
}

/// An office announced over mDNS only by Mira 0.1/0.2 laptops (TXT `org`
/// without `j` and `on`): seen, but it cannot take join requests.
/// Unauthenticated.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyOffice {
    pub org_id: String,
    /// TXT `on` of another laptop announcing the same org, if any.
    pub name: Option<String>,
    pub peer_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinSearch {
    pub offices: Vec<FoundOffice>,
    pub legacy_offices: Vec<LegacyOffice>,
    pub org_seen: bool,
    pub mdns_ok: bool,
    pub mdns_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum JoinPoll {
    None,
    Pending { request: OutgoingJoinRequest },
    Rejected { request: OutgoingJoinRequest },
    Approved { org: OrgInfo },
}

// ----- Client state ------------------------------------------------------------------------

/// An office as verified here: one genesis record and the members that
/// answered for it.
#[derive(Debug, Clone)]
struct Office {
    org: Organization,
    short_fp: String,
    departments: Vec<JoinDepartment>,
    /// Member key → its latest answer.
    members: HashMap<String, Member>,
}

/// One member's latest `join_info` answer for an office.
#[derive(Debug, Clone)]
struct Member {
    addr: SocketAddr,
    at: Instant,
    extras: u32,
    ad_domain: Option<String>,
    ad_ou_map: Vec<OuMapping>,
    /// `JoinInfoWire.ad_outdated` (0.5.1).
    ad_outdated: Option<u32>,
}

impl Member {
    /// The answer speaks about AD settings: a member that takes the claim
    /// (so `ad_domain: None` means "not set"), or one that named a domain.
    /// Mira v0.4.0 members know nothing about AD and are skipped.
    fn knows_ad(&self) -> bool {
        self.extras >= JOIN_INFO_EXTRAS_AD || self.ad_domain.is_some()
    }
}

impl Office {
    /// Every member that answered said `extras >= level`: 1 takes `note`
    /// and `account`, 2 also takes `ad`.
    fn accepts(&self, level: u32) -> bool {
        !self.members.is_empty() && self.members.values().all(|m| m.extras >= level)
    }

    /// Every member that answered takes requests with `note` and `account`.
    fn accepts_extras(&self) -> bool {
        self.accepts(JOIN_INFO_EXTRAS)
    }

    /// AD domain and OU mapping of the office. When members disagree (one
    /// has not received the latest `ad_settings_set` yet), the freshest
    /// answer that speaks about AD wins, as for departments; answers from
    /// members that know nothing about AD do not erase it.
    fn ad(&self) -> (Option<&str>, &[OuMapping]) {
        self.members
            .iter()
            .filter(|(_, m)| m.knows_ad())
            .max_by(|a, b| a.1.at.cmp(&b.1.at).then_with(|| b.0.cmp(a.0)))
            .map_or((None, &[][..]), |(_, m)| {
                (m.ad_domain.as_deref(), m.ad_ou_map.as_slice())
            })
    }

    /// Largest `ad_outdated` among the answers; `None` when no member
    /// reported it.
    fn ad_outdated(&self) -> Option<u32> {
        self.members.values().filter_map(|m| m.ad_outdated).max()
    }

    fn department_pairs(&self) -> Vec<(String, String)> {
        self.departments
            .iter()
            .map(|d| (d.id.clone(), d.name.clone()))
            .collect()
    }
}

/// Domains compare without case and a trailing dot.
fn same_domain(a: &str, b: &str) -> bool {
    let tidy = |s: &str| s.trim().trim_end_matches('.').to_lowercase();
    let (a, b) = (tidy(a), tidy(b));
    !a.is_empty() && a == b
}

/// The AD claim for a request to `office`, when it applies: the office
/// takes it (`extras >= 2` from every member), its AD domain is the
/// laptop's own, and the account name was read. A partial profile (no DN,
/// name or department) still claims domain and account.
fn ad_claim_for(profile: &LocalAd, office: &Office) -> Option<JoinAdClaim> {
    if !office.accepts(JOIN_INFO_EXTRAS_AD) {
        return None;
    }
    let domain = office.ad().0?;
    if !same_domain(domain, &profile.domain) {
        return None;
    }
    let user = profile
        .user
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())?;
    Some(JoinAdClaim {
        domain: domain.to_owned(),
        user: user.to_owned(),
        dn: profile.dn.clone(),
        name: profile.display_name.clone(),
        department: profile.department.clone(),
    })
}

/// What a new request to `office` carries: nothing for an office with
/// v0.3 members; the note and login name otherwise; and the AD claim when
/// the person asked for it and [`ad_claim_for`] allows it.
fn send_extras(
    office: &Office,
    note: Option<&str>,
    account: Option<String>,
    profile: Option<&LocalAd>,
    use_ad: bool,
) -> Option<JoinExtras> {
    office.accepts_extras().then(|| JoinExtras {
        note: note.map(str::to_owned),
        account,
        ad: profile
            .filter(|_| use_ad)
            .and_then(|p| ad_claim_for(p, office)),
    })
}

#[derive(Debug, Default)]
struct ClientState {
    /// Key `"{org id}:{full fingerprint}"`.
    offices: HashMap<String, Office>,
    /// Member key → when it was last asked for `join_info`.
    asked: HashMap<String, Instant>,
    /// Addresses typed in this session.
    manual: Vec<SocketAddr>,
    /// Round robin over the status candidates.
    status_turn: usize,
    /// The request the fields below are about.
    request_id: Option<String>,
    /// Member keys that took the current request.
    delivered: HashSet<String>,
    last_send: Option<Instant>,
    /// A rejection not signed by the founder, waiting for [`REJECT_CONFIRM`].
    suspect: Option<SuspectReject>,
    /// Laptops that sent a rejection another member contradicted. Not asked
    /// again for this request.
    distrusted: HashSet<SocketAddr>,
}

#[derive(Debug, Clone)]
struct SuspectReject {
    op: permissions::SignedOp,
    by_name: String,
    from: SocketAddr,
    since: Instant,
}

impl ClientState {
    fn record(&mut self, pk: &str, addr: SocketAddr, info: VerifiedInfo, now: Instant) -> String {
        let VerifiedInfo {
            org,
            departments,
            extras,
            ad_domain,
            ad_ou_map,
            ad_outdated,
        } = info;
        self.prune(now);
        let key = office_key(&org);
        if !self.offices.contains_key(&key) && self.offices.len() >= MAX_OFFICES {
            // Make room by dropping the office heard from least recently.
            let oldest = self
                .offices
                .iter()
                .min_by_key(|(_, o)| o.members.values().map(|m| m.at).max())
                .map(|(k, _)| k.clone());
            if let Some(k) = oldest {
                self.offices.remove(&k);
            }
        }
        let entry = self.offices.entry(key.clone()).or_insert_with(|| Office {
            short_fp: permissions::org_fingerprint_short(&org),
            org,
            departments: Vec::new(),
            members: HashMap::new(),
        });
        // Departments from the freshest answer.
        entry.departments = departments;
        entry.members.insert(
            pk.to_owned(),
            Member {
                addr,
                at: now,
                extras,
                ad_domain,
                ad_ou_map,
                ad_outdated,
            },
        );
        self.asked.insert(pk.to_owned(), now);
        key
    }

    /// Drops members not heard from within [`MEMBER_TTL`], offices left
    /// without members, and old `asked` entries.
    fn prune(&mut self, now: Instant) {
        for o in self.offices.values_mut() {
            o.members
                .retain(|_, m| now.saturating_duration_since(m.at) < MEMBER_TTL);
        }
        self.offices.retain(|_, o| !o.members.is_empty());
        self.asked
            .retain(|_, at| now.saturating_duration_since(*at) < INFO_TTL);
        if self.asked.len() > MAX_ASKED {
            self.asked.clear();
        }
    }

    fn conflict(&self, office: &Office) -> bool {
        self.offices
            .values()
            .any(|o| o.org.id == office.org.id && o.org != office.org)
    }

    fn found(&self, key: &str, office: &Office) -> FoundOffice {
        FoundOffice {
            key: key.to_owned(),
            org_id: office.org.id.clone(),
            name: office.org.name.clone(),
            fingerprint: office.short_fp.clone(),
            departments: office.departments.clone(),
            peer_count: office.members.len(),
            conflict: self.conflict(office),
            same_name: self
                .offices
                .iter()
                .any(|(k, o)| k != key && o.org.name == office.org.name),
            accepts_note: office.accepts_extras(),
            ad_domain: office.ad().0.map(str::to_owned),
            accepts_ad: office.accepts(JOIN_INFO_EXTRAS_AD),
            ad_outdated: office.ad_outdated(),
            created_at: office.org.created_at.clone(),
        }
    }

    fn snapshot(&self) -> Vec<FoundOffice> {
        let mut out: Vec<FoundOffice> =
            self.offices.iter().map(|(k, o)| self.found(k, o)).collect();
        out.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.key.cmp(&b.key)));
        out
    }

    /// Verified members of an office, freshest answer first, that said
    /// `extras >= level` ([`required_level`]): a v0.3 member refuses `note`
    /// and `account`, a v0.4.0 member refuses `ad`.
    fn members_of(&self, key: &str, level: u32) -> Vec<(String, SocketAddr)> {
        let Some(office) = self.offices.get(key) else {
            return Vec::new();
        };
        let mut m: Vec<(&String, &Member)> = office
            .members
            .iter()
            .filter(|(_, m)| m.extras >= level)
            .collect();
        m.sort_by(|a, b| b.1.at.cmp(&a.1.at).then_with(|| a.0.cmp(b.0)));
        m.into_iter().map(|(pk, m)| (pk.clone(), m.addr)).collect()
    }

    /// A verified office whose AD domain is one of `domains`, the oldest
    /// first (the "main office" when several share a domain).
    fn office_with_domain(&self, domains: &[&str]) -> Option<(String, String)> {
        self.offices
            .values()
            .filter_map(|o| {
                let d = o.ad().0?;
                domains
                    .iter()
                    .any(|x| same_domain(x, d))
                    .then(|| (o.org.created_at.clone(), o.org.name.clone(), d.to_owned()))
            })
            .min()
            .map(|(_, name, domain)| (name, domain))
    }

    /// Starts tracking `request_id` (a no-op when it is already the current one).
    fn track(&mut self, request_id: &str) {
        if self.request_id.as_deref() != Some(request_id) {
            self.request_id = Some(request_id.to_owned());
            self.delivered.clear();
            self.last_send = None;
            self.suspect = None;
            self.distrusted.clear();
        }
    }

    fn forget_request(&mut self) {
        self.request_id = None;
        self.delivered.clear();
        self.last_send = None;
        self.status_turn = 0;
        self.suspect = None;
        self.distrusted.clear();
    }
}

/// In-memory requester state, managed by Tauri.
#[derive(Debug, Default)]
pub struct JoinClient {
    inner: Mutex<ClientState>,
    /// One search pass at a time; a call during a pass gets the snapshot.
    search: tokio::sync::Mutex<()>,
    /// Sending, polling, resending and cancelling one at a time.
    ops: tokio::sync::Mutex<()>,
    /// This laptop's domain account, read once per process. Callers that
    /// arrive during the read wait for it instead of reading again.
    ad_profile: tokio::sync::OnceCell<Option<LocalAd>>,
}

impl JoinClient {
    fn lock(&self) -> MutexGuard<'_, ClientState> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `join_ad_profile`: this laptop's domain account, read at most once
    /// per process and never waiting much past [`ad::READ_TIMEOUT`].
    pub async fn ad_profile(&self) -> Option<LocalAd> {
        // `read_local` keeps its own limit; the outer one only guards
        // against a reader that ignores it.
        self.ad_profile_with(
            || ad::read_local(ad::READ_TIMEOUT),
            ad::READ_TIMEOUT + Duration::from_secs(1),
        )
        .await
    }

    /// [`Self::ad_profile`] with the reader and the limit passed in (tests).
    /// A read that does not finish within `limit` counts as "no profile".
    async fn ad_profile_with<F, Fut>(&self, read: F, limit: Duration) -> Option<LocalAd>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Option<LocalAd>>,
    {
        self.ad_profile
            .get_or_init(|| async move {
                tokio::time::timeout(limit, read())
                    .await
                    .ok()
                    .flatten()
            })
            .await
            .clone()
    }

    /// The profile if it was read already; never reads.
    fn cached_ad_profile(&self) -> Option<LocalAd> {
        self.ad_profile.get().cloned().flatten()
    }

    /// A verified office whose AD domain is one of `domains` (name, domain).
    pub fn office_with_ad_domain(&self, domains: &[&str]) -> Option<(String, String)> {
        self.lock().office_with_domain(domains)
    }
}

fn office_key(org: &Organization) -> String {
    format!("{}:{}", org.id, permissions::org_fingerprint(org))
}

/// A `join_info` answer whose genesis record verified.
#[derive(Debug, Clone)]
struct VerifiedInfo {
    org: Organization,
    departments: Vec<JoinDepartment>,
    /// What the member said it accepts (`JoinInfoWire.extras`).
    extras: u32,
    /// Normalized; `None` when absent or not a valid domain.
    ad_domain: Option<String>,
    ad_ou_map: Vec<OuMapping>,
    /// `JoinInfoWire.ad_outdated` (0.5.1); `None` from older members.
    ad_outdated: Option<u32>,
}

/// OU rows of an answer that could be real (1 to 64 printable
/// characters), at most [`MAX_OU_ROWS`]. Rows naming a department the
/// office does not list are skipped later by `ad::dept::suggest`.
fn clean_ou_map(rows: Vec<crate::network::OuMapWire>) -> Vec<OuMapping> {
    rows.into_iter()
        .map(OuMapping::from)
        .filter(|r| {
            let n = r.ou.chars().count();
            (1..=MAX_OU_CHARS).contains(&n)
                && !r.ou.chars().any(char::is_control)
                && !r.ou.trim().is_empty()
        })
        .take(MAX_OU_ROWS)
        .collect()
}

/// The genesis record and departments of an answer, if the record verifies
/// and (for mDNS hints) its id is the one announced.
fn verify_info(info: JoinInfoWire, expected_org: Option<&str>) -> Option<VerifiedInfo> {
    let extras = info.extras;
    let ad_outdated = info.ad_outdated;
    let ad_domain = info
        .ad_domain
        .as_deref()
        .and_then(ad::dn::normalize_domain);
    let ad_ou_map = clean_ou_map(info.ad_ou_map);
    let org = net_backend::organization(info.org);
    if org::validate_org_record(&org).is_err() || !org.verify_genesis() {
        return None;
    }
    if expected_org.is_some_and(|id| id != org.id) {
        return None;
    }
    // Only names a fold would accept (no control or bidi characters), so a
    // laptop on the LAN cannot put misleading text on the screen.
    let departments = info
        .departments
        .into_iter()
        .filter(|d| permissions::format::is_canonical_team_name(&d.name))
        .map(|d| JoinDepartment {
            id: d.id,
            name: d.name,
        })
        .collect();
    Some(VerifiedInfo {
        org,
        departments,
        extras,
        ad_domain,
        ad_ou_map,
        ad_outdated,
    })
}

fn unreachable_reject() -> JoinReject {
    JoinReject::new("peer_unreachable", "Laptop rekan tidak menjawab.")
}

/// `join_info_get` to each address at once, each with [`INFO_TIMEOUT`].
async fn ask_info(
    net: &Network,
    addrs: Vec<(SocketAddr, Option<String>)>,
) -> Vec<(
    SocketAddr,
    Option<String>,
    Result<(String, JoinInfoWire), JoinReject>,
)> {
    let mut set = JoinSet::new();
    for (addr, tag) in addrs {
        let net = net.clone();
        set.spawn(async move {
            let r = tokio::time::timeout(INFO_TIMEOUT, net.join_info_at(addr))
                .await
                .unwrap_or_else(|_| Err(unreachable_reject()));
            (addr, tag, r)
        });
    }
    let mut out = Vec::new();
    while let Some(r) = set.join_next().await {
        if let Ok(r) = r {
            out.push(r);
        }
    }
    out
}

// ----- Device and search --------------------------------------------------------------

#[cfg(windows)]
fn raw_account() -> Option<String> {
    std::env::var("USERNAME").ok()
}

#[cfg(not(windows))]
fn raw_account() -> Option<String> {
    std::env::var("USER").ok()
}

/// Login account name as a request may carry it: without the characters
/// `permissions::join::strip_join_text` drops (control, invisible, stacked
/// marks), trimmed, at most 64 characters; `None` when nothing is left.
fn clean_account(raw: &str) -> Option<String> {
    let kept = permissions::join::strip_join_text(raw);
    let cut: String = kept.trim().chars().take(JOIN_ACCOUNT_MAX_CHARS).collect();
    let cut = cut.trim();
    (!cut.is_empty()).then(|| cut.to_owned())
}

/// This laptop's login account name (Windows `USERNAME`, macOS `USER`).
pub(crate) fn login_account() -> Option<String> {
    clean_account(&raw_account()?)
}

/// `join_device`: what the approver will see about this laptop.
pub fn device_info(net: &Network) -> JoinDevice {
    let d = device::current();
    let mut addresses: Vec<String> = Vec::new();
    for a in net.status().local_addresses {
        let ip = a.ip().to_string();
        if !addresses.contains(&ip) {
            addresses.push(ip);
        }
    }
    JoinDevice {
        laptop: d.laptop,
        os: d.os,
        app_version: d.app_version,
        account: login_account(),
        addresses,
    }
}

/// Offices seen only through Mira 0.1/0.2 laptops: an org id announced by
/// at least one hint without `j` and without `on` (Mira 0.3 and later
/// always announce `on`, so a member that does not take requests, a guest
/// for instance, does not count). Orgs in `verified` and orgs with a laptop
/// that takes requests (`j`, still being asked) are left out. Grouped per
/// org id; the name comes from any hint of that org with `on`.
fn legacy_offices(hints: &[OfficeHint], verified: &HashSet<String>) -> Vec<LegacyOffice> {
    let mut per_org: BTreeMap<&str, Vec<&OfficeHint>> = BTreeMap::new();
    for h in hints {
        per_org.entry(h.org.as_str()).or_default().push(h);
    }
    let mut out: Vec<LegacyOffice> = per_org
        .into_iter()
        .filter(|(org, hs)| {
            !verified.contains(*org)
                && !hs.iter().any(|h| h.accepts_join)
                && hs.iter().any(|h| h.org_name.is_none())
        })
        .map(|(org, hs)| {
            let laptops: HashSet<&str> = hs.iter().map(|h| h.public_key.as_str()).collect();
            LegacyOffice {
                org_id: org.to_owned(),
                name: hs.iter().find_map(|h| h.org_name.clone()),
                peer_count: laptops.len(),
            }
        })
        .collect();
    out.sort_by(|a, b| {
        a.name
            .is_none()
            .cmp(&b.name.is_none())
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.org_id.cmp(&b.org_id))
    });
    out
}

/// `join_search`: asks the mDNS candidates not asked in the last minute.
pub async fn search(net: &Network, client: &JoinClient) -> JoinSearch {
    let hints = net.office_hints();
    let status = net.status();
    let result = |client: &JoinClient| {
        let (offices, verified) = {
            let st = client.lock();
            let verified: HashSet<String> =
                st.offices.values().map(|o| o.org.id.clone()).collect();
            (st.snapshot(), verified)
        };
        JoinSearch {
            offices,
            legacy_offices: legacy_offices(&hints, &verified),
            org_seen: !hints.is_empty(),
            mdns_ok: status.mdns_ok,
            mdns_error: status.mdns_error.clone(),
        }
    };
    let Ok(_pass) = client.search.try_lock() else {
        return result(client);
    };
    let now = Instant::now();
    let targets: Vec<(SocketAddr, Option<String>)> = {
        let mut st = client.lock();
        let mut per_org: HashMap<String, usize> = HashMap::new();
        let mut picked: HashSet<String> = HashSet::new();
        let mut targets = Vec::new();
        st.prune(now);
        for h in hints.iter().filter(|h| h.accepts_join) {
            if targets.len() >= MAX_QUERIES_PER_PASS {
                break;
            }
            let fresh = st
                .asked
                .get(&h.public_key)
                .is_some_and(|t| now.duration_since(*t) < INFO_TTL);
            let count = per_org.entry(h.org.clone()).or_default();
            if fresh || *count >= MAX_QUERIES_PER_ORG || !picked.insert(h.public_key.clone()) {
                continue;
            }
            *count += 1;
            st.asked.insert(h.public_key.clone(), now);
            targets.push((h.address, Some(h.org.clone())));
        }
        targets
    };
    for (addr, expected, answer) in ask_info(net, targets).await {
        let Ok((pk, info)) = answer else { continue };
        if let Some(info) = verify_info(info, expected.as_deref()) {
            client.lock().record(&pk, addr, info, Instant::now());
        }
    }
    result(client)
}

fn load_saved(conn: &rusqlite::Connection) -> AppResult<Vec<SocketAddr>> {
    Ok(settings::get(conn, SETTING_ADDRESSES)?
        .and_then(|v| serde_json::from_str::<Vec<String>>(&v).ok())
        .unwrap_or_default()
        .iter()
        .filter_map(|s| s.parse().ok())
        .collect())
}

fn save_addresses(conn: &rusqlite::Connection, add: &[SocketAddr]) -> AppResult<()> {
    let mut all = load_saved(conn)?;
    for a in add {
        all.retain(|x| x != a);
        all.push(*a);
    }
    let start = all.len().saturating_sub(MAX_SAVED_ADDRESSES);
    let list: Vec<String> = all[start..].iter().map(ToString::to_string).collect();
    let json = serde_json::to_string(&list).map_err(|e| AppError::Internal(e.to_string()))?;
    settings::set(conn, SETTING_ADDRESSES, &json)
}

/// `join_connect_address`: asks the laptop(s) at a typed address or
/// `mira://peer` link. Returns the offices they answered for.
pub async fn connect_address(
    state: &MiraState,
    net: &Network,
    client: &JoinClient,
    address: &str,
) -> AppResult<Vec<FoundOffice>> {
    let parsed = peers::parse_address_input(address)?;
    let targets = parsed.addrs.iter().map(|a| (*a, None)).collect();
    let mut keys: Vec<String> = Vec::new();
    let mut answered: Vec<SocketAddr> = Vec::new();
    let mut bad_record = false;
    let mut wrong_key = false;
    let mut first_err: Option<JoinReject> = None;
    for (addr, _, answer) in ask_info(net, targets).await {
        match answer {
            Ok((pk, info)) => {
                if parsed.public_key.as_deref().is_some_and(|k| k != pk) {
                    wrong_key = true;
                    continue;
                }
                match verify_info(info, None) {
                    Some(info) => {
                        let key = client.lock().record(&pk, addr, info, Instant::now());
                        if !keys.contains(&key) {
                            keys.push(key);
                        }
                        answered.push(addr);
                    }
                    None => bad_record = true,
                }
            }
            Err(e) => {
                first_err.get_or_insert(e);
            }
        }
    }
    if keys.is_empty() {
        return Err(connect_error(bad_record, wrong_key, first_err));
    }
    {
        let mut st = client.lock();
        for a in &answered {
            if !st.manual.contains(a) {
                st.manual.push(*a);
            }
        }
    }
    if let Err(e) = state.with_core(|c| save_addresses(&c.db, &answered)) {
        eprintln!("Mira: alamat kantor tidak tersimpan [{}]: {e}", e.code());
    }
    let st = client.lock();
    Ok(keys
        .iter()
        .filter_map(|k| st.offices.get(k).map(|o| st.found(k, o)))
        .collect())
}

fn connect_error(bad_record: bool, wrong_key: bool, err: Option<JoinReject>) -> AppError {
    if bad_record {
        return AppError::Network(
            "Laptop di alamat itu mengirim data kantor yang tidak sah. Coba alamat laptop rekan lain.".into(),
        );
    }
    if wrong_key {
        return AppError::Network(
            "Laptop di alamat itu bukan laptop yang ada di tautan. Minta tautan baru ke rekan."
                .into(),
        );
    }
    match err.as_ref().map(|e| e.code.as_str()) {
        Some("not_member") => AppError::NotFound(
            "Laptop di alamat itu belum tergabung ke kantor, jadi tidak bisa menerima permintaan bergabung. Coba alamat laptop rekan lain.".into(),
        ),
        Some("rate_limited") => AppError::Network(
            "Terlalu banyak percobaan dari laptop ini. Tunggu satu menit, lalu coba lagi.".into(),
        ),
        _ => AppError::PeerUnreachable(
            "Laptop di alamat itu tidak menjawab. Pastikan laptop itu menyala dan membuka Mira, alamatnya benar, dan firewall mengizinkan Mira.".into(),
        ),
    }
}

/// `join_ad_suggest`: the department the directory data points to in a
/// found office. `None` when no profile was read yet, the office is
/// unknown, or its AD domain is not the laptop's own.
pub fn ad_suggest(client: &JoinClient, office_key: &str) -> Option<DeptSuggestion> {
    let profile = client.cached_ad_profile()?;
    let st = client.lock();
    let office = st.offices.get(office_key)?;
    let (domain, map) = office.ad();
    if !same_domain(domain?, &profile.domain) {
        return None;
    }
    Some(ad::dept::suggest(
        profile.department.as_deref(),
        profile.dn.as_deref(),
        &office.department_pairs(),
        map,
    ))
}

// ----- Sending -------------------------------------------------------------------------

#[derive(Debug, Default)]
struct Delivery {
    delivered: usize,
    errors: Vec<JoinReject>,
}

impl Delivery {
    /// The refusal to show when nobody took the request and every member
    /// refused for a reason that sending again will not fix.
    fn final_refusal(&self) -> Option<&JoinReject> {
        if self.delivered > 0 || self.errors.is_empty() {
            return None;
        }
        if !self
            .errors
            .iter()
            .all(|e| FINAL_CODES.contains(&e.code.as_str()))
        {
            return None;
        }
        ["removed", "team_not_found", "request_expired"]
            .iter()
            .find_map(|c| self.errors.iter().find(|e| e.code == *c))
            .or_else(|| self.errors.first())
    }

    /// `last_error` text when nobody took the request.
    fn error_text(&self) -> Option<&'static str> {
        if self.delivered > 0 {
            return None;
        }
        Some(match self.errors.first().map(|e| e.code.as_str()) {
            Some("busy") => {
                "Laptop rekan sedang menampung terlalu banyak permintaan. Mira mencoba lagi nanti."
            }
            Some("rate_limited") => {
                "Terlalu banyak percobaan dari laptop ini. Mira mencoba lagi sebentar lagi."
            }
            Some("code_mismatch") => {
                "Kode dari laptop rekan tidak sama dengan kode di laptop ini. Mira mencoba laptop rekan lain."
            }
            Some("not_member") => {
                "Laptop rekan yang ditemukan tidak bisa menerima permintaan. Mira mencoba laptop lain."
            }
            _ => {
                "Laptop rekan belum bisa dihubungi. Mira mencoba lagi setiap menit selama layar ini terbuka."
            }
        })
    }
}

fn refusal_error(r: &JoinReject) -> AppError {
    match r.code.as_str() {
        "removed" => AppError::Removed,
        "team_not_found" => AppError::NotFound(
            "Departemen yang dipilih sudah tidak ada atau diarsipkan. Cari kantor lagi dan pilih departemen lain.".into(),
        ),
        "request_expired" => AppError::InvalidInput(
            "Laptop rekan menolak permintaan karena tanggalnya. Periksa jam dan tanggal di laptop ini, lalu kirim lagi.".into(),
        ),
        _ => AppError::InvalidInput(
            "Laptop rekan menolak permintaan ini karena isinya tidak sah. Cari kantor lagi, lalu kirim permintaan baru.".into(),
        ),
    }
}

/// Sends `out` to the given members at once. A member counts as having the
/// request only when it answers with the same request id and matching code.
async fn deliver(
    net: &Network,
    client: &JoinClient,
    out: &OutgoingJoinRequest,
    members: Vec<SocketAddr>,
) -> Delivery {
    let mut set = JoinSet::new();
    for addr in members {
        let net = net.clone();
        let wire = JoinRequestWire {
            payload: out.request.payload.clone(),
            sig: out.request.sig.clone(),
        };
        set.spawn(async move {
            tokio::time::timeout(REQUEST_TIMEOUT, net.join_request_at(addr, wire))
                .await
                .unwrap_or_else(|_| Err(unreachable_reject()))
        });
    }
    let mut d = Delivery::default();
    while let Some(r) = set.join_next().await {
        match r {
            Ok(Ok((pk, ok))) if ok.request_id == out.request_id && ok.code == out.code => {
                d.delivered += 1;
                let mut st = client.lock();
                if st.request_id.as_deref() == Some(out.request_id.as_str()) {
                    st.delivered.insert(pk);
                }
            }
            Ok(Ok(_)) => d
                .errors
                .push(JoinReject::new("code_mismatch", "Kode tidak sama.")),
            Ok(Err(e)) => d.errors.push(e),
            Err(_) => d.errors.push(unreachable_reject()),
        }
    }
    d
}

/// Verified members of the request's office that have not received it,
/// at most [`MAX_SEND`]. After a restart nothing is cached: the candidate
/// addresses are asked for `join_info` first.
async fn send_targets(
    state: &MiraState,
    net: &Network,
    client: &JoinClient,
    out: &OutgoingJoinRequest,
) -> AppResult<Vec<SocketAddr>> {
    let key = office_key(&out.org);
    // A request with `note` or `account` (or `ad`) goes only to members
    // that said they take it; older members refuse it as invalid.
    let level = required_level(out);
    ask_office_if_unknown(state, net, client, out, level).await?;
    // No conflict check here: the request is pinned to one genesis record
    // (chosen in `send_request`), and only laptops that answered with that
    // exact record are sent to.
    let st = client.lock();
    Ok(st
        .members_of(&key, level)
        .into_iter()
        .filter(|(pk, _)| !st.delivered.contains(pk))
        .take(MAX_SEND)
        .map(|(_, addr)| addr)
        .collect())
}

/// After a restart nothing is cached: asks the candidate addresses of
/// `out`'s office for `join_info` when no member saying `extras >= level`
/// is known.
async fn ask_office_if_unknown(
    state: &MiraState,
    net: &Network,
    client: &JoinClient,
    out: &OutgoingJoinRequest,
    level: u32,
) -> AppResult<()> {
    let key = office_key(&out.org);
    if !client.lock().members_of(&key, level).is_empty() {
        return Ok(());
    }
    let saved = state.with_core(|c| load_saved(&c.db))?;
    let addrs: Vec<(SocketAddr, Option<String>)> = status_candidates(net, client, out, &saved)
        .into_iter()
        .take(MAX_QUERIES_PER_ORG)
        .map(|a| (a, Some(out.org_id.clone())))
        .collect();
    for (addr, expected, answer) in ask_info(net, addrs).await {
        let Ok((pk, info)) = answer else { continue };
        if let Some(info) = verify_info(info, expected.as_deref()) {
            client.lock().record(&pk, addr, info, Instant::now());
        }
    }
    Ok(())
}

/// What a resent request carries: the previous note and the current login
/// name, only when the previous request had v0.4 fields and the office
/// still takes them (`office_accepts`); otherwise the v0.3 shape. The
/// previous AD claim stays only with `keep_ad` (the office still takes it
/// and still has the claim's domain).
fn resend_extras(
    old: &OutgoingJoinRequest,
    office_accepts: bool,
    keep_ad: bool,
) -> Option<JoinExtras> {
    (office_accepts && required_level(old) > 0).then(|| JoinExtras {
        note: old.note.clone(),
        account: login_account(),
        ad: old.ad.clone().filter(|_| keep_ad),
    })
}

/// Whether the AD claim of `old` may go again to `office`.
fn keeps_ad(old: &OutgoingJoinRequest, office: &Office) -> bool {
    let domain = office.ad().0;
    office.accepts(JOIN_INFO_EXTRAS_AD)
        && old
            .ad
            .as_ref()
            .is_some_and(|c| domain.is_some_and(|d| same_domain(d, &c.domain)))
}

/// The `extras` a member must have said to take `out`: 2 with `ad`, 1
/// with `note` or `account`, 0 for the v0.3 shape.
fn required_level(out: &OutgoingJoinRequest) -> u32 {
    match permissions::join::parse_request_payload(&out.request.payload) {
        Ok(p) if p.has_ad() => JOIN_INFO_EXTRAS_AD,
        Ok(p) if p.has_extras() => JOIN_INFO_EXTRAS,
        _ => 0,
    }
}

/// Sends the current outgoing request and records the result. A refusal
/// that sending again cannot fix is returned; the request is kept.
async fn send_and_record(
    state: &MiraState,
    net: &Network,
    client: &JoinClient,
    out: &OutgoingJoinRequest,
    targets: Vec<SocketAddr>,
) -> AppResult<OutgoingJoinRequest> {
    client.lock().last_send = Some(Instant::now());
    let d = if targets.is_empty() {
        Delivery {
            delivered: 0,
            errors: vec![unreachable_reject()],
        }
    } else {
        deliver(net, client, out, targets).await
    };
    if let Some(refusal) = d.final_refusal() {
        // The request stays: these refusals are unsigned, so any laptop that
        // answered for the office could have sent them. The person sees the
        // reason and decides (another department, cancel, or wait).
        let err = refusal_error(refusal);
        state.with_core(|c| {
            permissions::mark_join_sent(&c.db, clock::now(), Some(&err.to_string()))
        })?;
        return Err(err);
    }
    state.with_core(|c| {
        permissions::mark_join_sent(&c.db, clock::now(), d.error_text())?;
        permissions::outgoing_join_request(&c.db)?
            .ok_or_else(|| AppError::NotFound("Permintaan bergabung sudah dibatalkan.".into()))
    })
}

/// `join_send_request`: signs a request for a department of a found office
/// and sends it to up to five members that answered for that office.
///
/// When another genesis claims the same org id (`conflict`), the person
/// must first compare the short fingerprint with the superadmin (by phone
/// or at the desk) and pass it as `confirm_fingerprint`; the request then
/// goes only to laptops that answered with that exact genesis.
///
/// `note` and the login account name go into the request only when the
/// office accepts them ([`FoundOffice::accepts_note`]). Otherwise the
/// request has the v0.3 shape and a note is dropped: the screen hides the
/// note field for such an office, so a note only arrives here when the
/// office changed between the search and the send (a v0.3 member answered
/// meanwhile). Sending without it beats a request the office refuses.
///
/// Without the AD claim; see [`send_request_with_ad`].
pub async fn send_request(
    state: &MiraState,
    net: &Network,
    client: &JoinClient,
    office_key: &str,
    team_id: &str,
    confirm_fingerprint: Option<&str>,
    note: Option<&str>,
) -> AppResult<OutgoingJoinRequest> {
    send_request_with_ad(
        state,
        net,
        client,
        office_key,
        team_id,
        confirm_fingerprint,
        note,
        false,
    )
    .await
}

/// [`send_request`], and with `use_ad` the laptop's domain account (read
/// earlier by `join_ad_profile`) is signed in as well when
/// [`ad_claim_for`] allows it; otherwise the request goes without it. A
/// request with the claim goes only to members that said `extras >= 2`.
#[allow(clippy::too_many_arguments)]
pub async fn send_request_with_ad(
    state: &MiraState,
    net: &Network,
    client: &JoinClient,
    office_key: &str,
    team_id: &str,
    confirm_fingerprint: Option<&str>,
    note: Option<&str>,
    use_ad: bool,
) -> AppResult<OutgoingJoinRequest> {
    let _op = client.ops.lock().await;
    let profile = client.cached_ad_profile();
    let (target, extras) = {
        let st = client.lock();
        let office = st.offices.get(office_key).ok_or_else(|| {
            AppError::NotFound(
                "Kantor ini tidak ditemukan lagi. Cari kantor lagi, lalu pilih kantornya.".into(),
            )
        })?;
        let confirmed = confirm_fingerprint.is_some_and(|f| f.trim() == office.short_fp);
        if st.conflict(office) && !confirmed {
            return Err(AppError::Forbidden(format!(
                "Ada dua kantor dengan id yang sama, jadi salah satunya tiruan. Permintaan belum dikirim. Telepon superadmin, cocokkan sidik organisasi {} dengan yang tertulis di halaman Organisasi miliknya, lalu tandai bahwa sidiknya sama.",
                office.short_fp
            )));
        }
        let team = office.departments.iter().find(|d| d.id == team_id).ok_or_else(|| {
            AppError::InvalidInput("Departemen itu tidak ada di kantor ini. Cari kantor lagi dan pilih departemen lain.".into())
        })?;
        (
            JoinTarget {
                org: office.org.clone(),
                team_id: team.id.clone(),
                team_name: team.name.clone(),
            },
            send_extras(office, note, login_account(), profile.as_ref(), use_ad),
        )
    };
    let out = state.with_core(|c| {
        permissions::create_join_request(
            &mut c.db,
            &c.identity,
            &target,
            &device::current(),
            extras.as_ref(),
            clock::now(),
        )
    })?;
    // Chosen from what was signed: `create_join_request` may have dropped
    // parts of the claim that did not fit.
    let members: Vec<SocketAddr> = {
        let mut st = client.lock();
        st.track(&out.request_id);
        st.members_of(office_key, required_level(&out))
            .into_iter()
            .take(MAX_SEND)
            .map(|(_, a)| a)
            .collect()
    };
    send_and_record(state, net, client, &out, members).await
}

/// `join_resend`: a new request (new id and code) to the same office and
/// department, sent right away. With the previous note and the current
/// login account name if the previous request carried v0.4 fields and the
/// office still takes them (a member may have been replaced by a v0.3
/// laptop meanwhile); the v0.3 shape otherwise. The previous AD claim
/// stays only while the office still takes it ([`keeps_ad`]).
pub async fn resend(
    state: &MiraState,
    net: &Network,
    client: &JoinClient,
) -> AppResult<OutgoingJoinRequest> {
    let _op = client.ops.lock().await;
    let old = state
        .with_core(|c| permissions::outgoing_join_request(&c.db))?
        .ok_or_else(|| {
            AppError::NotFound("Belum ada permintaan bergabung. Cari kantor lagi.".into())
        })?;
    let target = JoinTarget {
        org: old.org.clone(),
        team_id: old.team_id.clone(),
        team_name: old.team_name.clone(),
    };
    ask_office_if_unknown(state, net, client, &old, 0).await?;
    let (accepts, keep_ad) = client
        .lock()
        .offices
        .get(&office_key(&old.org))
        .map_or((false, false), |o| (o.accepts_extras(), keeps_ad(&old, o)));
    let extras = resend_extras(&old, accepts, keep_ad);
    let out = state.with_core(|c| {
        permissions::create_join_request(
            &mut c.db,
            &c.identity,
            &target,
            &device::current(),
            extras.as_ref(),
            clock::now(),
        )
    })?;
    client.lock().track(&out.request_id);
    let targets = send_targets(state, net, client, &out).await?;
    send_and_record(state, net, client, &out, targets).await
}

// ----- Polling -------------------------------------------------------------------------

/// Where to ask for the status: verified members of the office, mDNS hints
/// for the same org id, addresses typed this session and saved ones.
fn status_candidates(
    net: &Network,
    client: &JoinClient,
    out: &OutgoingJoinRequest,
    saved: &[SocketAddr],
) -> Vec<SocketAddr> {
    let mut list: Vec<SocketAddr> = Vec::new();
    let mut push = |a: SocketAddr| {
        if !list.contains(&a) {
            list.push(a);
        }
    };
    let st = client.lock();
    for (_, a) in st.members_of(&office_key(&out.org), 0) {
        push(a);
    }
    for h in net
        .office_hints()
        .into_iter()
        .filter(|h| h.org == out.org_id)
    {
        push(h.address);
    }
    for a in st.manual.iter().chain(saved) {
        push(*a);
    }
    list
}

/// The author of `op` if it is a `join_reject` of exactly this request,
/// signed for the pinned organization. Says nothing about whether the
/// author may reject; only the founder can be checked without the log.
fn reject_author(out: &OutgoingJoinRequest, op: &permissions::SignedOp) -> Option<String> {
    let v = permissions::verify_op(op, &out.org.id, clock::now()).ok()?;
    match &v.payload.body {
        permissions::Body::JoinReject {
            request,
            request_sig,
        } if *request == out.request.payload && *request_sig == out.request.sig => {
            Some(v.payload.author.clone())
        }
        _ => None,
    }
}

/// Name shown as "rejected by": printable characters only, at most 60.
/// It comes from the answering laptop and is not checked.
fn clean_name(name: &str) -> String {
    let bidi = |c: char| matches!(c, '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}');
    let s: String = name
        .chars()
        .filter(|c| !c.is_control() && !bidi(*c))
        .take(60)
        .collect();
    let s = s.trim();
    if s.is_empty() {
        "Admin kantor".to_owned()
    } else {
        s.to_owned()
    }
}

/// Records a rejection (`mark_join_rejected` checks it again) and returns
/// the updated request, or `None` when it was not recorded.
fn record_rejection(
    state: &MiraState,
    op: &permissions::SignedOp,
    by_name: &str,
) -> AppResult<Option<OutgoingJoinRequest>> {
    state.with_core(|c| {
        if permissions::mark_join_rejected(&c.db, op, &clean_name(by_name), clock::now())? {
            permissions::outgoing_join_request(&c.db)
        } else {
            Ok(None)
        }
    })
}

/// `join_poll`, called every 5 seconds by the waiting screen. `on_joined`
/// runs after the organization is installed (the network is already
/// refreshed), to tell the UI.
pub async fn poll(
    state: &MiraState,
    net: &Network,
    client: &JoinClient,
    on_joined: impl FnOnce(),
) -> AppResult<JoinPoll> {
    let _op = client.ops.lock().await;
    let Some(out) = state.with_core(|c| permissions::outgoing_join_request(&c.db))? else {
        client.lock().forget_request();
        return Ok(JoinPoll::None);
    };
    if out.status == OutgoingStatus::Rejected {
        return Ok(JoinPoll::Rejected { request: out });
    }
    client.lock().track(&out.request_id);
    let saved = state.with_core(|c| load_saved(&c.db))?;
    let mut candidates = status_candidates(net, client, &out, &saved);
    let pick = {
        let mut st = client.lock();
        candidates.retain(|a| !st.distrusted.contains(a));
        // While a rejection waits for confirmation, ask the others.
        if let Some(s) = &st.suspect
            && candidates.len() > 1
        {
            candidates.retain(|a| *a != s.from);
        }
        let pick = (!candidates.is_empty()).then(|| candidates[st.status_turn % candidates.len()]);
        st.status_turn = st.status_turn.wrapping_add(1);
        pick
    };
    if let Some(addr) = pick {
        let answer =
            tokio::time::timeout(REQUEST_TIMEOUT, net.join_status_at(addr, &out.request_id))
                .await
                .unwrap_or_else(|_| Err(unreachable_reject()));
        match answer {
            Ok((_, JoinStatusWire::Approved(accepted))) => {
                let installed = state.with_core(|c| {
                    let info = permissions::install_approved_org(
                        &mut c.db,
                        &c.identity,
                        net_backend::organization(accepted.org),
                        accepted
                            .ops
                            .into_iter()
                            .map(net_backend::from_wire)
                            .collect(),
                        clock::now(),
                    )?;
                    // Keep the typed addresses so this laptop reaches the
                    // office again where mDNS does not work (VPN).
                    let typed: Vec<SocketAddr> = client.lock().manual.clone();
                    for a in typed.iter().chain(&saved) {
                        if let Err(e) = peers::add_manual(&c.db, &a.to_string(), clock::now()) {
                            eprintln!("Mira: alamat kantor tidak tersimpan [{}]: {e}", e.code());
                        }
                    }
                    settings::set(&c.db, SETTING_ADDRESSES, "[]")?;
                    publish_device(c);
                    Ok(info)
                });
                match installed {
                    Ok(info) => {
                        *client.lock() = ClientState::default();
                        net.refresh();
                        on_joined();
                        return Ok(JoinPoll::Approved { org: info });
                    }
                    // Ignore this answer; the next poll asks another member.
                    Err(e) => eprintln!(
                        "Mira: persetujuan bergabung tidak dipakai [{}]: {e}",
                        e.code()
                    ),
                }
            }
            Ok((_, JoinStatusWire::Rejected { by_name, op, .. })) => {
                let op = net_backend::from_wire(op);
                match reject_author(&out, &op) {
                    // Signed by the founder: checkable against the pinned
                    // genesis, so final right away.
                    Some(author) if author == out.org.founder_public_key => {
                        if let Some(request) = record_rejection(state, &op, &by_name)? {
                            return Ok(JoinPoll::Rejected { request });
                        }
                    }
                    Some(_) => {
                        let mut st = client.lock();
                        let same = st.suspect.as_ref().is_some_and(|s| s.op == op);
                        if !same {
                            st.suspect = Some(SuspectReject {
                                op,
                                by_name,
                                from: addr,
                                since: Instant::now(),
                            });
                        }
                    }
                    None => {}
                }
            }
            Ok((pk, JoinStatusWire::Pending)) => {
                let mut st = client.lock();
                st.delivered.insert(pk);
                // A member still holds the request undecided: the rejection
                // that arrived earlier was not real.
                if let Some(s) = st.suspect.take()
                    && s.from != addr
                {
                    st.distrusted.insert(s.from);
                }
            }
            Ok((_, JoinStatusWire::Unknown)) | Err(_) => {}
        }
    }
    let ripe = {
        let st = client.lock();
        st.suspect
            .as_ref()
            .filter(|s| s.since.elapsed() >= REJECT_CONFIRM)
            .cloned()
    };
    if let Some(s) = ripe {
        client.lock().suspect = None;
        if let Some(request) = record_rejection(state, &s.op, &s.by_name)? {
            return Ok(JoinPoll::Rejected { request });
        }
    }
    let due = client
        .lock()
        .last_send
        .is_none_or(|t| t.elapsed() >= RESEND_EVERY);
    if due {
        let targets = send_targets(state, net, client, &out).await?;
        client.lock().last_send = Some(Instant::now());
        if !targets.is_empty() {
            let d = deliver(net, client, &out, targets).await;
            let nobody = client.lock().delivered.is_empty();
            if d.delivered > 0 || nobody {
                let text = if d.delivered > 0 {
                    None
                } else {
                    d.error_text()
                };
                state.with_core(|c| permissions::mark_join_sent(&c.db, clock::now(), text))?;
            }
        }
    }
    let request = state
        .with_core(|c| permissions::outgoing_join_request(&c.db))?
        .unwrap_or(out);
    Ok(JoinPoll::Pending { request })
}

/// Publishes this laptop's name, OS and version (`device_set`) right after
/// it became a member, so the superadmin's user list shows them now
/// instead of after the next start. A failure is only logged.
pub fn publish_device(c: &mut crate::state::Core) {
    if let Err(e) =
        permissions::ensure_device_op(&mut c.db, &c.identity, &device::current(), clock::now())
    {
        eprintln!("Mira: profil laptop belum diterbitkan [{}]: {e}", e.code());
    }
}

/// `join_cancel`.
pub async fn cancel(state: &MiraState, client: &JoinClient) -> AppResult<()> {
    let _op = client.ops.lock().await;
    state.with_core(|c| permissions::cancel_join_request(&c.db))?;
    client.lock().forget_request();
    Ok(())
}

// ----- Tauri commands ------------------------------------------------------------------

#[tauri::command]
pub async fn join_device(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
) -> AppResult<JoinDevice> {
    let network = net.get(&state, &app).await?;
    Ok(device_info(&network))
}

#[tauri::command]
pub async fn join_search(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    client: State<'_, JoinClient>,
    app: AppHandle,
) -> AppResult<JoinSearch> {
    let network = net.get(&state, &app).await?;
    Ok(search(&network, &client).await)
}

#[tauri::command]
pub async fn join_connect_address(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    client: State<'_, JoinClient>,
    app: AppHandle,
    address: String,
) -> AppResult<Vec<FoundOffice>> {
    let network = net.get(&state, &app).await?;
    connect_address(&state, &network, &client, &address).await
}

// Each argument is one field of the `invoke` call in src/api/join.ts.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn join_send_request(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    client: State<'_, JoinClient>,
    app: AppHandle,
    office_key: String,
    team_id: String,
    confirm_fingerprint: Option<String>,
    note: Option<String>,
    use_ad: Option<bool>,
) -> AppResult<OutgoingJoinRequest> {
    let network = net.get(&state, &app).await?;
    send_request_with_ad(
        &state,
        &network,
        &client,
        &office_key,
        &team_id,
        confirm_fingerprint.as_deref(),
        note.as_deref(),
        use_ad.unwrap_or(false),
    )
    .await
}

/// `join_ad_profile`: this laptop's domain account, `null` for none.
#[tauri::command]
pub async fn join_ad_profile(client: State<'_, JoinClient>) -> AppResult<Option<LocalAd>> {
    Ok(client.ad_profile().await)
}

/// `join_ad_suggest`: department suggested from the AD data for a found
/// office, `null` when there is no AD data or the domains differ.
#[tauri::command]
pub async fn join_ad_suggest(
    client: State<'_, JoinClient>,
    office_key: String,
) -> AppResult<Option<DeptSuggestion>> {
    Ok(ad_suggest(&client, &office_key))
}

#[tauri::command]
pub async fn join_outgoing(state: State<'_, MiraState>) -> AppResult<Option<OutgoingJoinRequest>> {
    state.with_core(|c| permissions::outgoing_join_request(&c.db))
}

#[tauri::command]
pub async fn join_poll(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    client: State<'_, JoinClient>,
    app: AppHandle,
) -> AppResult<JoinPoll> {
    let network = net.get(&state, &app).await?;
    poll(&state, &network, &client, || {
        let _ = app.emit(net_backend::EVENT_DIRECTORY, ());
        let _ = app.emit(net_backend::EVENT_NETWORK, ());
    })
    .await
}

#[tauri::command]
pub async fn join_cancel(
    state: State<'_, MiraState>,
    client: State<'_, JoinClient>,
) -> AppResult<()> {
    cancel(&state, &client).await
}

#[tauri::command]
pub async fn join_resend(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    client: State<'_, JoinClient>,
    app: AppHandle,
) -> AppResult<OutgoingJoinRequest> {
    let network = net.get(&state, &app).await?;
    resend(&state, &network, &client).await
}

/// The program arguments (the program itself first) ask for the setup mode.
fn has_setup_arg(args: impl IntoIterator<Item = String>) -> bool {
    args.into_iter().skip(1).any(|a| a == SETUP_MODE_ARG)
}

/// `join_setup_mode`: Mira was started with `--siapkan-kantor`.
#[tauri::command]
pub fn join_setup_mode() -> bool {
    has_setup_arg(std::env::args())
}

/// A valid genesis record signed with the key `[n; 32]` (tests).
#[cfg(test)]
pub(crate) fn test_genesis(n: u8, name: &str, created_at: &str) -> Organization {
    use ed25519_dalek::Signer;
    let sk = ed25519_dalek::SigningKey::from_bytes(&[n; 32]);
    let mut o = Organization {
        id: format!("{n:02x}").repeat(16),
        name: name.to_owned(),
        founder_public_key: hex::encode(sk.verifying_key().as_bytes()),
        created_at: created_at.to_owned(),
        genesis_signature: String::new(),
    };
    o.genesis_signature = hex::encode(sk.sign(&o.genesis_message()).to_bytes());
    o
}

#[cfg(test)]
impl JoinClient {
    /// Records `org` as answered by one member with `extras` and
    /// `ad_domain`. Returns the office key.
    pub(crate) fn add_test_office(
        &self,
        org: Organization,
        extras: u32,
        ad_domain: Option<&str>,
    ) -> String {
        let pk = format!("{:0>64}", org.id);
        let info = VerifiedInfo {
            org,
            departments: Vec::new(),
            extras,
            ad_domain: ad_domain.map(str::to_owned),
            ad_ou_map: Vec::new(),
            ad_outdated: None,
        };
        let addr: SocketAddr = "192.168.1.9:47800".parse().expect("address");
        self.lock().record(&pk, addr, info, Instant::now())
    }

    /// Stands in for the AD read (tests never touch the real directory).
    pub(crate) fn set_test_ad_profile(&self, profile: Option<LocalAd>) {
        let _ = self.ad_profile.set(profile);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn poll_and_office_shapes_match_join_ts() {
        assert_eq!(
            serde_json::to_value(JoinPoll::None).unwrap(),
            serde_json::json!({ "status": "none" })
        );
        let org = OrgInfo {
            id: "ab".repeat(16),
            name: "CV Maju Jaya".into(),
            role: crate::org::Role::Member,
            created_at: "2026-11-23T08:00:00Z".into(),
        };
        let v = serde_json::to_value(JoinPoll::Approved { org }).unwrap();
        assert_eq!(v["status"], "approved");
        assert_eq!(v["org"]["name"], "CV Maju Jaya");
        assert_eq!(v["org"]["createdAt"], "2026-11-23T08:00:00Z");

        let office = FoundOffice {
            key: "k".into(),
            org_id: "o".into(),
            name: "n".into(),
            fingerprint: "ABCD-EFGH".into(),
            departments: vec![JoinDepartment {
                id: "d".into(),
                name: "Desain".into(),
            }],
            peer_count: 2,
            conflict: false,
            same_name: true,
            accepts_note: true,
            ad_domain: Some("macf.co.id".into()),
            accepts_ad: false,
            ad_outdated: Some(1),
            created_at: "2026-11-23T08:00:00Z".into(),
        };
        let v = serde_json::to_value(&office).unwrap();
        let keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        let mut keys = keys;
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "acceptsAd",
                "acceptsNote",
                "adDomain",
                "adOutdated",
                "conflict",
                "createdAt",
                "departments",
                "fingerprint",
                "key",
                "name",
                "orgId",
                "peerCount",
                "sameName"
            ]
        );
        assert_eq!(v["acceptsNote"], true);
        assert_eq!(v["adDomain"], "macf.co.id");
        assert_eq!(v["acceptsAd"], false);
        assert_eq!(v["adOutdated"], 1);
        assert_eq!(v["createdAt"], "2026-11-23T08:00:00Z");
        let v = serde_json::to_value(FoundOffice {
            ad_domain: None,
            ad_outdated: None,
            ..office
        })
        .unwrap();
        assert_eq!(v["adDomain"], serde_json::Value::Null);
        assert_eq!(v["adOutdated"], serde_json::Value::Null);
        let s = serde_json::to_value(JoinSearch {
            offices: vec![],
            legacy_offices: vec![
                LegacyOffice {
                    org_id: "o".into(),
                    name: Some("Kantor".into()),
                    peer_count: 2,
                },
                LegacyOffice {
                    org_id: "p".into(),
                    name: None,
                    peer_count: 1,
                },
            ],
            org_seen: true,
            mdns_ok: false,
            mdns_error: None,
        })
        .unwrap();
        assert_eq!(
            s,
            serde_json::json!({
                "offices": [],
                "legacyOffices": [
                    { "orgId": "o", "name": "Kantor", "peerCount": 2 },
                    { "orgId": "p", "name": null, "peerCount": 1 }
                ],
                "orgSeen": true,
                "mdnsOk": false,
                "mdnsError": null
            })
        );
        let device = JoinDevice {
            laptop: "L".into(),
            os: "Windows 11".into(),
            app_version: "0.3.0".into(),
            account: Some("rina.w".into()),
            addresses: vec!["192.168.1.2".into()],
        };
        let d = serde_json::to_value(&device).unwrap();
        assert_eq!(
            d,
            serde_json::json!({
                "laptop": "L",
                "os": "Windows 11",
                "appVersion": "0.3.0",
                "account": "rina.w",
                "addresses": ["192.168.1.2"]
            })
        );
        let d = serde_json::to_value(JoinDevice {
            account: None,
            ..device
        })
        .unwrap();
        assert_eq!(d["account"], serde_json::Value::Null);
    }

    fn sorted_keys(v: &serde_json::Value) -> Vec<String> {
        let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        k.sort_unstable();
        k
    }

    #[test]
    fn request_shapes_match_join_ts_and_org_ts() {
        let out = OutgoingJoinRequest {
            request_id: "r".into(),
            request: permissions::SignedJoinRequest {
                payload: "{}".into(),
                sig: "s".into(),
            },
            org: genesis(1),
            code: "ABCD EFGH".into(),
            org_fingerprint: "ABCD-EFGH".into(),
            org_id: "o".into(),
            org_name: "Kantor".into(),
            team_id: "t".into(),
            team_name: "Desain".into(),
            display_name: "Rina".into(),
            note: Some("Staf gudang".into()),
            created_at: "2026-11-23T08:00:00Z".into(),
            status: OutgoingStatus::Pending,
            decided_by_name: None,
            decided_at: None,
            last_sent_at: None,
            last_error: None,
            ad: None,
        };
        let v = serde_json::to_value(&out).unwrap();
        assert_eq!(
            sorted_keys(&v),
            [
                "ad",
                "code",
                "createdAt",
                "decidedAt",
                "decidedByName",
                "displayName",
                "lastError",
                "lastSentAt",
                "note",
                "orgFingerprint",
                "orgId",
                "orgName",
                "requestId",
                "status",
                "teamId",
                "teamName"
            ]
        );
        assert_eq!(v["note"], "Staf gudang");
        assert_eq!(v["status"], "pending");
        assert_eq!(v["ad"], serde_json::Value::Null);
        let v = serde_json::to_value(OutgoingJoinRequest {
            note: None,
            ad: Some(JoinAdClaim {
                domain: "macf.co.id".into(),
                user: "rina".into(),
                dn: None,
                name: Some("Rina Wijaya".into()),
                department: None,
            }),
            ..out
        })
        .unwrap();
        assert_eq!(v["note"], serde_json::Value::Null);
        // Every field of `JoinAdClaim` in join.ts, `null` when unknown.
        assert_eq!(
            v["ad"],
            serde_json::json!({
                "domain": "macf.co.id",
                "user": "rina",
                "dn": null,
                "name": "Rina Wijaya",
                "department": null
            })
        );

        let card = permissions::JoinRequestView {
            id: "i".into(),
            public_key: "p".into(),
            display_name: "Rina".into(),
            team_id: "t".into(),
            team_name: "Desain".into(),
            laptop: "L".into(),
            os: "Windows 11".into(),
            app_version: "0.4.0".into(),
            requested_at: "2026-11-23T08:00:00Z".into(),
            received_at: "2026-11-23T08:00:01Z".into(),
            code: "ABCD EFGH".into(),
            ip: None,
            seen_by_name: None,
            note: Some("Staf gudang".into()),
            account: None,
            ad: None,
            requester_outdated: false,
            previously_removed: None,
        };
        let v = serde_json::to_value(&card).unwrap();
        assert_eq!(
            sorted_keys(&v),
            [
                "account",
                "ad",
                "appVersion",
                "code",
                "displayName",
                "id",
                "ip",
                "laptop",
                "note",
                "os",
                "previouslyRemoved",
                "publicKey",
                "receivedAt",
                "requestedAt",
                "requesterOutdated",
                "seenByName",
                "teamId",
                "teamName"
            ]
        );
        assert_eq!(v["note"], "Staf gudang");
        assert_eq!(v["account"], serde_json::Value::Null);
        assert_eq!(v["ad"], serde_json::Value::Null);
        assert_eq!(v["requesterOutdated"], false);
    }

    #[test]
    fn login_account_is_cleaned() {
        assert_eq!(clean_account("rina.w").as_deref(), Some("rina.w"));
        assert_eq!(
            clean_account("  Rina W\u{202E} \n").as_deref(),
            Some("Rina W")
        );
        assert_eq!(clean_account(" \t\u{200B} "), None);
        assert_eq!(clean_account(""), None);
        // Blank-looking characters and stacked marks go too.
        assert_eq!(
            clean_account("ri\u{3164}na\u{FE0F}\u{E0041}").as_deref(),
            Some("rina")
        );
        assert_eq!(
            clean_account("a\u{0301}\u{0301}\u{0301}").as_deref(),
            Some("a\u{0301}\u{0301}")
        );
        assert_eq!(clean_account("\u{3164}\u{2800}"), None);
        let long = clean_account(&"é".repeat(100)).unwrap();
        assert_eq!(long.chars().count(), JOIN_ACCOUNT_MAX_CHARS);
        // Whatever the system says passes the request check.
        for raw in [
            "rina.w",
            " a b ",
            "x\u{0007}y",
            &"z".repeat(70),
            "\u{115F}x\u{034F}",
            "e\u{0302}\u{0323}\u{0301}\u{0300}",
        ] {
            if let Some(a) = clean_account(raw) {
                assert!(permissions::join::is_valid_join_account(&a), "{raw:?}");
            }
        }
        if let Some(a) = login_account() {
            assert!(permissions::join::is_valid_join_account(&a));
        }
    }

    #[test]
    fn resend_keeps_the_note_only_while_the_office_takes_it() {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[7; 32]);
        let request = |note: Option<&str>, ad: Option<JoinAdClaim>| {
            let p = permissions::join::JoinRequestPayload {
                v: 1,
                org: "01".repeat(16),
                org_fp: "ab".repeat(32),
                member: hex::encode(sk.verifying_key().as_bytes()),
                name: "Rina".into(),
                team: "22".repeat(16),
                laptop: "L".into(),
                os: "Windows 11".into(),
                app_version: "0.4.0".into(),
                note: note.map(str::to_owned),
                account: None,
                ad: ad.clone(),
                at: "2026-11-23T08:00:00Z".into(),
                nonce: "cd".repeat(16),
            };
            use ed25519_dalek::Signer;
            let signed = permissions::join::sign_join_request(&p, |m| sk.sign(m));
            OutgoingJoinRequest {
                request_id: signed.id(),
                request: signed,
                org: genesis(1),
                code: "ABCD EFGH".into(),
                org_fingerprint: "ABCD-EFGH".into(),
                org_id: "01".repeat(16),
                org_name: "Kantor".into(),
                team_id: "22".repeat(16),
                team_name: "Desain".into(),
                display_name: "Rina".into(),
                note: note.map(str::to_owned),
                created_at: "2026-11-23T08:00:00Z".into(),
                status: OutgoingStatus::Rejected,
                decided_by_name: None,
                decided_at: None,
                last_sent_at: None,
                last_error: None,
                ad,
            }
        };
        let with = request(Some("Staf gudang"), None);
        let extras = resend_extras(&with, true, true).unwrap();
        assert_eq!(extras.note.as_deref(), Some("Staf gudang"));
        assert_eq!(extras.account, login_account());
        assert_eq!(extras.ad, None);
        assert_eq!(
            resend_extras(&with, false, false),
            None,
            "office went back to v0.3"
        );
        assert_eq!(
            resend_extras(&request(None, None), true, true),
            None,
            "was v0.3 shape"
        );

        // The AD claim stays only while the office still takes it.
        let claim = JoinAdClaim {
            domain: "macf.co.id".into(),
            user: "rina".into(),
            dn: None,
            name: Some("Rina Wijaya".into()),
            department: Some("Keuangan".into()),
        };
        let with_ad = request(None, Some(claim.clone()));
        assert_eq!(required_level(&with_ad), JOIN_INFO_EXTRAS_AD);
        assert_eq!(required_level(&with), JOIN_INFO_EXTRAS);
        assert_eq!(required_level(&request(None, None)), 0);
        let mut st = ClientState::default();
        let t0 = Instant::now();
        let a1: SocketAddr = "192.168.1.9:47800".parse().unwrap();
        let key = st.record(
            &"01".repeat(32),
            a1,
            ad_info(genesis(1), JOIN_INFO_EXTRAS_AD, Some("macf.co.id")),
            t0,
        );
        assert!(keeps_ad(&with_ad, &st.offices[&key]));
        assert!(!keeps_ad(&with, &st.offices[&key]), "had no claim");
        let extras = resend_extras(&with_ad, true, true).unwrap();
        assert_eq!(extras.ad, Some(claim.clone()));
        assert_eq!(extras.note, None);
        // A v0.4.0 laptop joined the answers: the claim goes, the rest stays.
        st.record(&"02".repeat(32), a1, ad_info(genesis(1), JOIN_INFO_EXTRAS, None), t0);
        let office = &st.offices[&key];
        assert!(office.accepts_extras());
        assert!(!keeps_ad(&with_ad, office));
        let extras = resend_extras(&with_ad, true, keeps_ad(&with_ad, office)).unwrap();
        assert_eq!(extras.ad, None);
        assert_eq!(extras.account, login_account());
        // The office now has another domain.
        let mut st = ClientState::default();
        let key = st.record(
            &"01".repeat(32),
            a1,
            ad_info(genesis(1), JOIN_INFO_EXTRAS_AD, Some("lain.co.id")),
            t0,
        );
        assert!(!keeps_ad(&with_ad, &st.offices[&key]));
    }

    #[test]
    fn setup_mode_needs_the_exact_argument() {
        let args = |a: &[&str]| a.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        assert!(has_setup_arg(args(&["mira.exe", "--siapkan-kantor"])));
        assert!(has_setup_arg(args(&[
            "mira.exe",
            "--x",
            "--siapkan-kantor"
        ])));
        assert!(!has_setup_arg(args(&["mira.exe"])));
        assert!(
            !has_setup_arg(args(&["--siapkan-kantor"])),
            "program name only"
        );
        assert!(!has_setup_arg(args(&["mira.exe", "--siapkan-kantor=1"])));
        assert!(!has_setup_arg(args(&["mira.exe", "siapkan-kantor"])));
        // The test binary is not started with it.
        assert!(!join_setup_mode());
    }

    fn info(org: Organization, extras: u32) -> VerifiedInfo {
        ad_info(org, extras, None)
    }

    fn ad_info(org: Organization, extras: u32, domain: Option<&str>) -> VerifiedInfo {
        VerifiedInfo {
            org,
            departments: vec![
                JoinDepartment {
                    id: "aa".repeat(16),
                    name: "Keuangan".into(),
                },
                JoinDepartment {
                    id: "bb".repeat(16),
                    name: "Gudang".into(),
                },
            ],
            extras,
            ad_domain: domain.map(str::to_owned),
            ad_ou_map: Vec::new(),
            ad_outdated: None,
        }
    }

    #[test]
    fn note_is_accepted_only_when_every_member_answered_with_extras() {
        let mut st = ClientState::default();
        let t0 = Instant::now();
        let a1: SocketAddr = "192.168.1.9:47800".parse().unwrap();
        let a2: SocketAddr = "192.168.1.10:47800".parse().unwrap();
        let key = st.record(&"01".repeat(32), a1, info(genesis(1), JOIN_INFO_EXTRAS), t0);
        let found = |st: &ClientState| st.found(&key, &st.offices[&key]);
        assert!(found(&st).accepts_note);
        assert_eq!(st.members_of(&key, JOIN_INFO_EXTRAS).len(), 1);
        // A v0.3 member answers for the same office.
        st.record(&"02".repeat(32), a2, info(genesis(1), 0), t0);
        assert!(!found(&st).accepts_note);
        assert_eq!(found(&st).peer_count, 2);
        assert_eq!(st.members_of(&key, 0).len(), 2);
        assert_eq!(
            st.members_of(&key, JOIN_INFO_EXTRAS),
            vec![("01".repeat(32), a1)]
        );
        // It updates to v0.4 and answers again.
        st.record(&"02".repeat(32), a2, info(genesis(1), JOIN_INFO_EXTRAS), t0);
        assert!(found(&st).accepts_note);
        // Only v0.3 members: no.
        let other = st.record(&"03".repeat(32), a1, info(genesis(2), 0), t0);
        assert!(!st.found(&other, &st.offices[&other]).accepts_note);
        assert!(st.members_of(&other, JOIN_INFO_EXTRAS).is_empty());
    }

    #[test]
    fn rejecter_name_from_the_lan_is_cleaned() {
        assert_eq!(clean_name("Andi"), "Andi");
        assert_eq!(clean_name("An\u{202E}di\n\u{0007}"), "Andi");
        assert_eq!(clean_name("  \u{200F} "), "Admin kantor");
        assert_eq!(clean_name(&"x".repeat(200)).chars().count(), 60);
    }

    fn genesis(n: u8) -> Organization {
        test_genesis(n, &format!("Kantor {n}"), "2026-11-23T08:00:00Z")
    }

    #[test]
    fn offices_heard_from_the_lan_are_capped_and_expire() {
        let mut st = ClientState::default();
        let t0 = Instant::now();
        let addr: SocketAddr = "192.168.1.9:47800".parse().unwrap();
        for n in 1..=(MAX_OFFICES as u8 + 5) {
            let at = t0 + Duration::from_secs(u64::from(n));
            st.record(
                &format!("{n:02x}").repeat(32),
                addr,
                info(genesis(n), 0),
                at,
            );
        }
        assert_eq!(st.offices.len(), MAX_OFFICES);
        // The newest stay, the oldest went first.
        assert!(
            st.offices
                .contains_key(&office_key(&genesis(MAX_OFFICES as u8 + 5)))
        );
        assert!(!st.offices.contains_key(&office_key(&genesis(1))));
        st.prune(t0 + MEMBER_TTL + Duration::from_secs(100));
        assert!(st.offices.is_empty());
        assert!(st.asked.is_empty());
    }

    #[test]
    fn final_refusal_needs_every_member_to_refuse_for_good() {
        let r = |c: &str| JoinReject::new(c, "x");
        let d = Delivery {
            delivered: 0,
            errors: vec![r("invalid_request"), r("team_not_found")],
        };
        assert_eq!(d.final_refusal().unwrap().code, "team_not_found");
        let d = Delivery {
            delivered: 0,
            errors: vec![r("team_not_found"), r("peer_unreachable")],
        };
        assert!(d.final_refusal().is_none());
        assert!(d.error_text().is_some());
        let d = Delivery {
            delivered: 1,
            errors: vec![r("team_not_found")],
        };
        assert!(d.final_refusal().is_none());
        assert!(d.error_text().is_none());
    }

    fn profile(domain: &str) -> LocalAd {
        LocalAd {
            domain: domain.into(),
            user: Some("rina".into()),
            dn: Some("CN=Rina Wijaya,OU=Keuangan,OU=Jakarta,DC=macf,DC=co,DC=id".into()),
            display_name: Some("Rina Wijaya".into()),
            department: None,
            complete: true,
        }
    }

    const LIMIT: Duration = Duration::from_secs(5);

    #[tokio::test]
    async fn ad_profile_is_read_once_and_cached() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};
        let client = JoinClient::default();
        assert_eq!(client.cached_ad_profile(), None, "nothing read yet");
        let reads = Arc::new(AtomicUsize::new(0));
        let read = |reads: Arc<AtomicUsize>| {
            move || async move {
                reads.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(50)).await;
                Some(profile("macf.co.id"))
            }
        };
        // Two callers at once share one read.
        let (a, b) = tokio::join!(
            client.ad_profile_with(read(reads.clone()), LIMIT),
            client.ad_profile_with(read(reads.clone()), LIMIT),
        );
        assert_eq!(a, Some(profile("macf.co.id")));
        assert_eq!(a, b);
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        // Later calls come from the cache.
        assert_eq!(
            client.ad_profile_with(read(reads.clone()), LIMIT).await,
            Some(profile("macf.co.id"))
        );
        assert_eq!(client.ad_profile().await, Some(profile("macf.co.id")));
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        assert_eq!(client.cached_ad_profile(), Some(profile("macf.co.id")));

        // "No domain account" is cached as well.
        let client = JoinClient::default();
        let none = |reads: Arc<AtomicUsize>| {
            move || async move {
                reads.fetch_add(1, Ordering::SeqCst);
                None
            }
        };
        let reads = Arc::new(AtomicUsize::new(0));
        assert_eq!(client.ad_profile_with(none(reads.clone()), LIMIT).await, None);
        assert_eq!(client.ad_profile_with(none(reads.clone()), LIMIT).await, None);
        assert_eq!(reads.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn ad_profile_never_waits_past_the_limit() {
        let client = JoinClient::default();
        let slow = || async {
            tokio::time::sleep(Duration::from_secs(60)).await;
            Some(profile("macf.co.id"))
        };
        let start = Instant::now();
        let limit = Duration::from_millis(50);
        assert_eq!(client.ad_profile_with(slow, limit).await, None);
        assert!(start.elapsed() < Duration::from_secs(5));
        assert_eq!(client.cached_ad_profile(), None);
    }

    #[test]
    fn ad_suggest_needs_the_office_domain() {
        let client = JoinClient::default();
        let t0 = Instant::now();
        let a1: SocketAddr = "192.168.1.9:47800".parse().unwrap();
        let (mine, other, none) = {
            let mut st = client.lock();
            let mine = st.record(
                &"01".repeat(32),
                a1,
                ad_info(genesis(1), JOIN_INFO_EXTRAS_AD, Some("macf.co.id")),
                t0,
            );
            let other = st.record(
                &"02".repeat(32),
                a1,
                ad_info(genesis(2), JOIN_INFO_EXTRAS_AD, Some("lain.co.id")),
                t0,
            );
            let none = st.record(
                &"03".repeat(32),
                a1,
                ad_info(genesis(3), JOIN_INFO_EXTRAS_AD, None),
                t0,
            );
            (mine, other, none)
        };
        assert_eq!(ad_suggest(&client, &mine), None, "no profile read yet");
        client.set_test_ad_profile(Some(profile("MACF.co.id")));
        let s = ad_suggest(&client, &mine).unwrap();
        // No `department` attribute: the innermost OU names the department.
        assert_eq!(s.team_id, Some("aa".repeat(16)));
        assert_eq!(s.source, Some(ad::dept::DeptSource::OuName));
        assert_eq!(s.ad_department.as_deref(), Some("Keuangan"));
        assert!(s.in_mira);
        assert_eq!(ad_suggest(&client, &other), None, "another domain");
        assert_eq!(ad_suggest(&client, &none), None, "office without a domain");
        assert_eq!(ad_suggest(&client, "nope"), None, "unknown office");

        // The OU mapping of the office is used.
        let client = JoinClient::default();
        client.set_test_ad_profile(Some(profile("macf.co.id")));
        let key = {
            let mut info = ad_info(genesis(1), JOIN_INFO_EXTRAS_AD, Some("macf.co.id"));
            info.ad_ou_map = vec![OuMapping {
                ou: "Jakarta".into(),
                team: "bb".repeat(16),
                division: None,
            }];
            info.departments.retain(|d| d.name != "Keuangan");
            client.lock().record(&"01".repeat(32), a1, info, t0)
        };
        let s = ad_suggest(&client, &key).unwrap();
        assert_eq!(s.team_id, Some("bb".repeat(16)));
        assert_eq!(s.source, Some(ad::dept::DeptSource::OuMap));
    }

    #[test]
    fn office_ad_domain_comes_from_the_freshest_answer_that_knows_ad() {
        let mut st = ClientState::default();
        let t0 = Instant::now();
        let a1: SocketAddr = "192.168.1.9:47800".parse().unwrap();
        let at = |s: u64| t0 + Duration::from_secs(s);
        let wire = |domain: Option<&str>, map: Vec<OuMapping>| JoinInfoWire {
            org: net_backend::org_record(genesis(1)),
            fingerprint: String::new(),
            departments: Vec::new(),
            extras: JOIN_INFO_EXTRAS_AD,
            ad_domain: domain.map(str::to_owned),
            ad_ou_map: map.into_iter().map(Into::into).collect(),
            ad_outdated: None,
        };
        let info = verify_info(wire(Some("MACF.co.id."), Vec::new()), None).unwrap();
        let key = st.record(&"01".repeat(32), a1, info, at(1));
        let found = |st: &ClientState| st.found(&key, &st.offices[&key]);
        assert_eq!(
            found(&st).ad_domain.as_deref(),
            Some("macf.co.id"),
            "normalized"
        );
        assert!(found(&st).accepts_ad);
        assert_eq!(found(&st).created_at, "2026-11-23T08:00:00Z");
        // A v0.4.0 member says nothing about AD: the domain stays, the claim
        // is no longer taken.
        st.record(
            &"02".repeat(32),
            a1,
            ad_info(genesis(1), JOIN_INFO_EXTRAS, None),
            at(2),
        );
        assert_eq!(found(&st).ad_domain.as_deref(), Some("macf.co.id"));
        assert!(!found(&st).accepts_ad);
        assert!(found(&st).accepts_note);
        assert_eq!(st.members_of(&key, JOIN_INFO_EXTRAS_AD).len(), 1);
        assert_eq!(st.members_of(&key, JOIN_INFO_EXTRAS).len(), 2);
        // A newer answer from a member that knows AD wins.
        st.record(
            &"03".repeat(32),
            a1,
            ad_info(genesis(1), JOIN_INFO_EXTRAS_AD, Some("baru.co.id")),
            at(3),
        );
        assert_eq!(found(&st).ad_domain.as_deref(), Some("baru.co.id"));
        // The superadmin cleared it, as told by a member that takes the claim.
        st.record(
            &"01".repeat(32),
            a1,
            ad_info(genesis(1), JOIN_INFO_EXTRAS_AD, None),
            at(4),
        );
        assert_eq!(found(&st).ad_domain, None);
        // Not a domain at all, and OU rows that cannot be real: dropped.
        let row = |ou: String| OuMapping {
            ou,
            team: "aa".repeat(16),
            division: None,
        };
        let info = verify_info(
            wire(
                Some("not a domain"),
                vec![row("Ok".into()), row("x\n".into()), row("y".repeat(65)), row(" ".into())],
            ),
            None,
        )
        .unwrap();
        assert_eq!(info.ad_domain, None);
        assert_eq!(info.ad_ou_map, vec![row("Ok".into())]);
    }

    #[test]
    fn ad_claim_goes_only_where_it_applies() {
        let t0 = Instant::now();
        let a1: SocketAddr = "192.168.1.9:47800".parse().unwrap();
        let office = |extras: u32, domain: Option<&str>| {
            let mut st = ClientState::default();
            let key = st.record(&"01".repeat(32), a1, ad_info(genesis(1), extras, domain), t0);
            st.offices.remove(&key).unwrap()
        };
        let p = profile("macf.co.id");
        let acct = || Some("rina".to_owned());
        let ok = office(JOIN_INFO_EXTRAS_AD, Some("macf.co.id"));

        let e = send_extras(&ok, Some("Staf"), acct(), Some(&p), true).unwrap();
        let claim = e.ad.unwrap();
        assert_eq!(claim.domain, "macf.co.id");
        assert_eq!(claim.user, "rina");
        assert_eq!(claim.name.as_deref(), Some("Rina Wijaya"));
        assert_eq!(claim.dn, p.dn);
        assert_eq!(claim.department, None);
        assert_eq!(e.note.as_deref(), Some("Staf"));

        // Not asked for, or no profile.
        assert_eq!(
            send_extras(&ok, None, acct(), Some(&p), false).unwrap().ad,
            None
        );
        assert_eq!(send_extras(&ok, None, acct(), None, true).unwrap().ad, None);
        // The office does not take it (a v0.4.0 member) or has another or
        // no domain: the request goes without it, note and account stay.
        let old = office(JOIN_INFO_EXTRAS, Some("macf.co.id"));
        let e = send_extras(&old, Some("Staf"), acct(), Some(&p), true).unwrap();
        assert_eq!(e.ad, None);
        assert_eq!(e.note.as_deref(), Some("Staf"));
        assert_eq!(e.account.as_deref(), Some("rina"));
        for o in [
            office(JOIN_INFO_EXTRAS_AD, Some("lain.co.id")),
            office(JOIN_INFO_EXTRAS_AD, None),
        ] {
            assert_eq!(
                send_extras(&o, None, acct(), Some(&p), true).unwrap().ad,
                None
            );
        }
        // A v0.3 office takes nothing.
        assert_eq!(
            send_extras(&office(0, None), Some("Staf"), acct(), Some(&p), true),
            None
        );
        // Domain case does not matter.
        let upper = profile("MACF.CO.ID");
        assert!(
            send_extras(&ok, None, acct(), Some(&upper), true)
                .unwrap()
                .ad
                .is_some()
        );
        // Partial read: domain and account only.
        let partial = LocalAd {
            dn: None,
            display_name: None,
            department: None,
            complete: false,
            ..profile("macf.co.id")
        };
        let claim = send_extras(&ok, None, acct(), Some(&partial), true)
            .unwrap()
            .ad
            .unwrap();
        assert_eq!(
            claim,
            JoinAdClaim {
                domain: "macf.co.id".into(),
                user: "rina".into(),
                dn: None,
                name: None,
                department: None,
            }
        );
        // Without the account name there is no claim.
        let no_user = LocalAd {
            user: Some("  ".into()),
            ..profile("macf.co.id")
        };
        assert_eq!(
            send_extras(&ok, None, acct(), Some(&no_user), true)
                .unwrap()
                .ad,
            None
        );

        // Signed into the request as built here; it then needs `extras >= 2`.
        let tmp = tempfile::tempdir().unwrap();
        let state = MiraState::new(
            Ok(tmp.path().to_path_buf()),
            Box::new(crate::identity::MemoryKeyStore::new()),
        );
        crate::commands::display_name(&state, "Rina").unwrap();
        let target = JoinTarget {
            org: genesis(1),
            team_id: "aa".repeat(16),
            team_name: "Keuangan".into(),
        };
        let create = |extras: Option<JoinExtras>| {
            state
                .with_core(|c| {
                    permissions::create_join_request(
                        &mut c.db,
                        &c.identity,
                        &target,
                        &device::current(),
                        extras.as_ref(),
                        clock::now(),
                    )
                })
                .unwrap()
        };
        let out = create(send_extras(&ok, None, acct(), Some(&partial), true));
        assert_eq!(out.ad, Some(claim));
        assert_eq!(required_level(&out), JOIN_INFO_EXTRAS_AD);
        let out = create(send_extras(&ok, None, acct(), Some(&p), true));
        assert_eq!(
            out.ad.as_ref().and_then(|c| c.dn.as_deref()),
            p.dn.as_deref()
        );
        let out = create(send_extras(&old, None, acct(), Some(&p), true));
        assert_eq!(out.ad, None);
        assert_eq!(required_level(&out), JOIN_INFO_EXTRAS);
    }

    fn hint(pk: char, org: &str, name: Option<&str>, join: bool) -> OfficeHint {
        OfficeHint {
            public_key: pk.to_string().repeat(64),
            address: "10.0.0.1:47800".parse().unwrap(),
            org: org.into(),
            org_name: name.map(str::to_owned),
            accepts_join: join,
            ad_domain: None,
        }
    }

    #[test]
    fn legacy_offices_are_orgs_announced_without_j_and_on() {
        let old = "01".repeat(16);
        let named = "02".repeat(16);
        let guest = "03".repeat(16);
        let current = "04".repeat(16);
        let verified_org = "05".repeat(16);
        let hints = [
            // Mira 0.1/0.2: org only, two laptops (one seen twice).
            hint('a', &old, None, false),
            hint('b', &old, None, false),
            hint('b', &old, None, false),
            // A 0.2 laptop next to a 0.3 guest that announces the name.
            hint('c', &named, None, false),
            hint('d', &named, Some("Kantor Lama"), false),
            // A guest of a current office: `on` without `j`.
            hint('e', &guest, Some("Kantor Baru"), false),
            // A laptop that takes requests, still being asked.
            hint('f', &current, None, false),
            hint('g', &current, Some("Kantor Kini"), true),
            // Already verified through `join_info`.
            hint('h', &verified_org, None, false),
        ];
        let verified: HashSet<String> = [verified_org].into_iter().collect();
        assert_eq!(
            legacy_offices(&hints, &verified),
            vec![
                LegacyOffice {
                    org_id: named,
                    name: Some("Kantor Lama".into()),
                    peer_count: 2,
                },
                LegacyOffice {
                    org_id: old,
                    name: None,
                    peer_count: 2,
                },
            ]
        );
        assert!(legacy_offices(&[], &HashSet::new()).is_empty());
    }

    #[test]
    fn office_with_ad_domain_finds_the_oldest_match() {
        let client = JoinClient::default();
        assert_eq!(client.office_with_ad_domain(&["macf.co.id"]), None);
        client.add_test_office(
            test_genesis(1, "MCF Baru", "2026-11-20T08:00:00Z"),
            JOIN_INFO_EXTRAS_AD,
            Some("macf.co.id"),
        );
        client.add_test_office(
            test_genesis(2, "MCF", "2026-01-05T08:00:00Z"),
            JOIN_INFO_EXTRAS_AD,
            Some("macf.co.id"),
        );
        client.add_test_office(genesis(3), JOIN_INFO_EXTRAS_AD, Some("lain.co.id"));
        assert_eq!(
            client.office_with_ad_domain(&["x.co.id", "MACF.co.id"]),
            Some(("MCF".into(), "macf.co.id".into()))
        );
        assert_eq!(client.office_with_ad_domain(&["x.co.id"]), None);
        assert_eq!(client.office_with_ad_domain(&[]), None);
    }
}
