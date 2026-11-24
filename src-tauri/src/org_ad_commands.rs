//! Tauri commands for the approver side of AD onboarding
//! (docs/plans/onboarding-ad.md 3.6, 6.3 and 6.1.3): the office's AD
//! settings, the directory re-check of a join request's AD claim, and the
//! notice about other Mira offices on the same network. TypeScript side:
//! `src/api/org.ts` (`AdSettingsView`, `AdCheck`, `OtherOfficesView`).

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::net::SocketAddr;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, State};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokio::task::JoinSet;

use crate::ad::check::{self, AdCheck};
use crate::ad::{self, DirectoryUser, LookupError, OuMapping};
use crate::clock;
use crate::error::{AppError, AppResult};
use crate::net_backend::{self, AppNet};
use crate::network::{JoinInfoWire, Network, OfficeHint};
use crate::org::Organization;
use crate::org_commands;
use crate::permissions::{self, JoinRequestView, Membership, OrgState};
use crate::state::MiraState;

/// A directory re-check is reused this long per request.
const CHECK_TTL: Duration = Duration::from_secs(120);
/// Re-checks kept at most; the oldest goes first.
const MAX_CHECKS: usize = 64;
/// `org_other_offices` is reused this long.
const OFFICES_TTL: Duration = Duration::from_secs(60);
/// Other offices with the same AD domain asked for `join_info`, at most.
const OLDER_ORGS_ASKED: usize = 4;
/// Laptops asked per such office, one after the other.
const OLDER_ADDRS_PER_ORG: usize = 3;
/// Wait for one `join_info` answer.
const OLDER_INFO_TIMEOUT: Duration = Duration::from_secs(3);
/// Wait for all of them.
const OLDER_TOTAL_TIMEOUT: Duration = Duration::from_secs(6);
/// Office names returned, at most.
const MAX_NAMES: usize = 10;

/// Same text as `permissions::reject_join` and `approve_join` use.
const REQUEST_NOT_HERE: &str =
    "Permintaan bergabung tidak ditemukan di laptop ini. Mungkin sudah diputuskan di laptop lain.";
const REQUEST_NO_AD: &str = "Permintaan bergabung ini tidak membawa data AD.";

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// In-memory caches of this module, managed by Tauri.
#[derive(Default)]
pub struct OrgAdCache {
    checks: Mutex<CheckCache>,
    offices: Mutex<Option<OfficesEntry>>,
}

impl OrgAdCache {
    /// Forgets every cached re-check (the OU mapping changed).
    fn clear_checks(&self) {
        lock(&self.checks).entries.clear();
    }

    fn offices_get(&self, key: &OfficesKey, now: Instant) -> Option<OtherOfficesView> {
        lock(&self.offices)
            .as_ref()
            .filter(|e| e.key == *key && now.saturating_duration_since(e.at) < OFFICES_TTL)
            .map(|e| e.view.clone())
    }

    fn offices_put(&self, key: OfficesKey, view: OtherOfficesView, now: Instant) {
        *lock(&self.offices) = Some(OfficesEntry { at: now, key, view });
    }
}

/// Organization id and its AD domain: a change of either makes the cached
/// view stale.
type OfficesKey = (String, Option<String>);

struct OfficesEntry {
    at: Instant,
    key: OfficesKey,
    view: OtherOfficesView,
}

#[derive(Default)]
struct CheckCache {
    entries: HashMap<String, (Instant, AdCheck)>,
}

impl CheckCache {
    fn get(&self, id: &str, now: Instant) -> Option<AdCheck> {
        self.entries
            .get(id)
            .filter(|(at, _)| now.saturating_duration_since(*at) < CHECK_TTL)
            .map(|(_, c)| c.clone())
    }

    fn put(&mut self, id: String, check: AdCheck, now: Instant) {
        self.entries
            .retain(|_, (at, _)| now.saturating_duration_since(*at) < CHECK_TTL);
        self.entries.remove(&id);
        while self.entries.len() >= MAX_CHECKS {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, (at, _))| *at)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            self.entries.remove(&oldest);
        }
        self.entries.insert(id, (now, check));
    }
}

// ----- AD settings ---------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutdatedLaptop {
    pub name: String,
    pub app_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdSettingsView {
    pub domain: Option<String>,
    pub ou_map: Vec<OuMapping>,
    /// Superadmin.
    pub can_edit: bool,
    /// Every member's Mira is recent enough to take `ad_settings_set`.
    pub allowed: bool,
    /// The laptops keeping `allowed` false.
    pub outdated: Vec<OutdatedLaptop>,
    /// This laptop's AD domain.
    pub machine_domain: Option<String>,
}

fn ad_settings_view(state: &OrgState, me: &str, machine_domain: Option<String>) -> AdSettingsView {
    AdSettingsView {
        domain: state.ad.domain.clone(),
        ou_map: state.ad.ou_map.clone(),
        can_edit: state.is_superadmin(me),
        allowed: permissions::ad_settings_allowed(state),
        outdated: permissions::ad_blockers(state)
            .into_iter()
            .map(|b| OutdatedLaptop {
                name: b.name,
                app_version: b.app_version,
            })
            .collect(),
        machine_domain,
    }
}

#[tauri::command]
pub async fn org_ad_settings(state: State<'_, MiraState>) -> AppResult<AdSettingsView> {
    let (s, me) = state.with_core(|c| {
        Ok((
            permissions::require_state(&c.db)?,
            c.identity.public_key_hex().to_owned(),
        ))
    })?;
    Ok(ad_settings_view(&s, &me, ad::machine_domain()))
}

/// Superadmin: saves the AD domain (empty clears it) and the OU mapping as
/// one `ad_settings_set` op.
#[tauri::command]
pub async fn org_set_ad_settings(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
    cache: State<'_, OrgAdCache>,
    domain: String,
    ou_map: Vec<OuMapping>,
) -> AppResult<()> {
    org_commands::mutate(&state, &net, &app, |c| {
        permissions::set_ad_settings(&mut c.db, &c.identity, &domain, ou_map, clock::now())
    })
    .await?;
    // Department mismatches depend on the mapping.
    cache.clear_checks();
    Ok(())
}

// ----- Re-check of a request's AD claim -------------------------------------------

/// What a pending request claims, with what `check::compare` needs.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CheckTarget {
    domain: String,
    user: String,
    name: String,
    team_id: String,
    team_name: String,
    /// (id, name) of the open departments.
    departments: Vec<(String, String)>,
    ou_map: Vec<OuMapping>,
}

/// The pending request `id` among `pending` (what this person may decide),
/// which must carry an AD claim.
fn find_target(
    pending: Vec<JoinRequestView>,
    id: &str,
    departments: Vec<(String, String)>,
    ou_map: Vec<OuMapping>,
) -> AppResult<CheckTarget> {
    let req = pending
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(|| AppError::NotFound(REQUEST_NOT_HERE.into()))?;
    let claim = req
        .ad
        .ok_or_else(|| AppError::InvalidInput(REQUEST_NO_AD.into()))?;
    Ok(CheckTarget {
        domain: claim.domain,
        user: claim.user,
        name: req.display_name,
        team_id: req.team_id,
        team_name: req.team_name,
        departments,
        ou_map,
    })
}

fn check_result(
    t: &CheckTarget,
    found: Result<DirectoryUser, LookupError>,
    checked_at: String,
) -> AdCheck {
    match found {
        Ok(entry) => check::compare(
            &t.name,
            &t.team_id,
            &t.team_name,
            &entry,
            &t.departments,
            &t.ou_map,
            checked_at,
        ),
        Err(err) => check::from_error(&err, checked_at),
    }
}

/// The cached re-check of request `id`, or a new one through `lookup`
/// (domain, user) when there is none or `refresh` is set. No lock is held
/// while `lookup` runs.
async fn cached_check<F, Fut>(
    cache: &OrgAdCache,
    id: &str,
    refresh: bool,
    target: &CheckTarget,
    lookup: F,
) -> AdCheck
where
    F: FnOnce(String, String) -> Fut,
    Fut: Future<Output = Result<DirectoryUser, LookupError>>,
{
    if !refresh && let Some(hit) = lock(&cache.checks).get(id, Instant::now()) {
        return hit;
    }
    let found = lookup(target.domain.clone(), target.user.clone()).await;
    let result = check_result(target, found, clock::now_rfc3339());
    lock(&cache.checks).put(id.to_owned(), result.clone(), Instant::now());
    result
}

/// Looks the AD account of pending request `request_id` up from this
/// laptop and compares it with the request. Kept 2 minutes per request;
/// `refresh` asks the directory again.
#[tauri::command]
pub async fn org_join_ad_check(
    state: State<'_, MiraState>,
    cache: State<'_, OrgAdCache>,
    request_id: String,
    refresh: bool,
) -> AppResult<AdCheck> {
    let target = state.with_core(|c| {
        let s = permissions::require_state(&c.db)?;
        let pending = permissions::pending_join_requests(
            &c.db,
            &s,
            c.identity.public_key_hex(),
            clock::now(),
        )?;
        find_target(
            pending,
            &request_id,
            permissions::open_departments(&s),
            s.ad.ou_map.clone(),
        )
    })?;
    Ok(cached_check(
        &cache,
        &request_id,
        refresh,
        &target,
        |domain, user| async move { ad::lookup_user(&domain, &user, ad::LOOKUP_TIMEOUT).await },
    )
    .await)
}

// ----- Other offices on the network ------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OlderOffice {
    pub name: String,
    pub created_at: String,
    /// `XXXX-XXXX`, computed here from the verified genesis record.
    pub fingerprint: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OtherOfficesView {
    /// Laptops announcing an organization other than this one.
    pub laptops: usize,
    /// Distinct organizations among them.
    pub offices: usize,
    /// Of those laptops, the ones announcing this office's AD domain.
    pub same_domain_laptops: usize,
    /// Organization names from TXT `on`, freshest first, without repeats.
    pub names: Vec<String>,
    /// Another office with the same AD domain whose verified genesis is
    /// older than this one's (the oldest, when several).
    pub older_same_domain: Option<OlderOffice>,
}

struct HintSummary {
    view: OtherOfficesView,
    /// Other organizations announcing this office's AD domain, with
    /// addresses to ask (takers of join requests first).
    same_domain: Vec<(String, Vec<SocketAddr>)>,
}

/// Counts mDNS hints (freshest first) per laptop: a key seen at several
/// addresses is one laptop, and its freshest hint says which organization
/// it is in.
fn summarize_hints(hints: &[OfficeHint], own_org: &str, own_domain: Option<&str>) -> HintSummary {
    let mut org_of: HashMap<&str, &str> = HashMap::new();
    for h in hints {
        org_of
            .entry(h.public_key.as_str())
            .or_insert(h.org.as_str());
    }
    let mut view = OtherOfficesView::default();
    let mut orgs: HashSet<&str> = HashSet::new();
    let mut counted: HashSet<&str> = HashSet::new();
    let mut same_domain: Vec<(String, Vec<(bool, SocketAddr)>)> = Vec::new();
    for h in hints {
        // Only this laptop's current organization, and not this office.
        if org_of.get(h.public_key.as_str()) != Some(&h.org.as_str()) || h.org == own_org {
            continue;
        }
        let same = own_domain.is_some() && h.ad_domain.as_deref() == own_domain;
        if counted.insert(h.public_key.as_str()) {
            view.laptops += 1;
            orgs.insert(h.org.as_str());
            if same {
                view.same_domain_laptops += 1;
            }
        }
        if let Some(name) = &h.org_name
            && view.names.len() < MAX_NAMES
            && !view.names.contains(name)
        {
            view.names.push(name.clone());
        }
        if same {
            match same_domain.iter_mut().find(|(o, _)| *o == h.org) {
                Some((_, addrs)) => addrs.push((h.accepts_join, h.address)),
                None => same_domain.push((h.org.clone(), vec![(h.accepts_join, h.address)])),
            }
        }
    }
    view.offices = orgs.len();
    let same_domain = same_domain
        .into_iter()
        .map(|(org, mut addrs)| {
            // Stable: freshness stays the order within each group.
            addrs.sort_by_key(|(j, _)| !*j);
            let mut seen = HashSet::new();
            let addrs: Vec<SocketAddr> = addrs
                .into_iter()
                .map(|(_, a)| a)
                .filter(|a| seen.insert(*a))
                .take(OLDER_ADDRS_PER_ORG)
                .collect();
            (org, addrs)
        })
        .collect();
    HintSummary { view, same_domain }
}

/// The organization in a `join_info` answer, when its genesis record
/// verifies, it is the one announced and it has the AD domain `domain`.
fn verify_office(info: JoinInfoWire, expected_org: &str, domain: &str) -> Option<Organization> {
    if info.ad_domain.as_deref() != Some(domain) {
        return None;
    }
    let org = net_backend::organization(info.org);
    (org.id == expected_org && org.verify_genesis()).then_some(org)
}

/// Genesis order: creation time, then id, so two offices created in the
/// same instant still agree on which one came first.
fn genesis_order(org: &Organization) -> Option<(OffsetDateTime, String)> {
    OffsetDateTime::parse(&org.created_at, &Rfc3339)
        .ok()
        .map(|t| (t, org.id.clone()))
}

/// Of `others`, the earliest created before `own`.
fn pick_older(own: &Organization, others: Vec<Organization>) -> Option<OlderOffice> {
    let mine = genesis_order(own)?;
    others
        .into_iter()
        .filter(|o| o.id != own.id)
        .filter_map(|o| genesis_order(&o).map(|k| (k, o)))
        .filter(|(k, _)| *k < mine)
        .min_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, o)| OlderOffice {
            fingerprint: permissions::org_fingerprint_short(&o),
            name: o.name,
            created_at: o.created_at,
        })
}

/// Asks laptops of each same-domain office for `join_info` and returns the
/// earliest verified office older than `own`.
async fn older_same_domain(
    net: &Network,
    own: &Organization,
    domain: &str,
    targets: Vec<(String, Vec<SocketAddr>)>,
) -> Option<OlderOffice> {
    let mut set = JoinSet::new();
    for (org, addrs) in targets.into_iter().take(OLDER_ORGS_ASKED) {
        let net = net.clone();
        let domain = domain.to_owned();
        set.spawn(async move {
            for addr in addrs {
                if let Ok(Ok((_, info))) =
                    tokio::time::timeout(OLDER_INFO_TIMEOUT, net.join_info_at(addr)).await
                    && let Some(found) = verify_office(info, &org, &domain)
                {
                    return Some(found);
                }
            }
            None
        });
    }
    let deadline = tokio::time::Instant::now() + OLDER_TOTAL_TIMEOUT;
    let mut found = Vec::new();
    while let Ok(Some(joined)) = tokio::time::timeout_at(deadline, set.join_next()).await {
        if let Ok(Some(org)) = joined {
            found.push(org);
        }
    }
    pick_older(own, found)
}

/// Laptops on this network in another Mira office (mDNS hints, not
/// verified), and the older office with the same AD domain (verified).
/// All zero when this laptop is not an active member. Kept 60 seconds.
#[tauri::command]
pub async fn org_other_offices(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    cache: State<'_, OrgAdCache>,
) -> AppResult<OtherOfficesView> {
    let own = state.with_core(|c| {
        if permissions::membership(&c.db, &c.identity)? != Membership::Active {
            return Ok(None);
        }
        let Some(org) = crate::org::load_organization(&c.db)? else {
            return Ok(None);
        };
        let domain = permissions::load_state(&c.db)?.and_then(|s| s.ad.domain);
        Ok(Some((org, domain)))
    })?;
    let Some((org, domain)) = own else {
        return Ok(OtherOfficesView::default());
    };
    let Some(net) = net.running().await else {
        return Ok(OtherOfficesView::default());
    };
    let key = (org.id.clone(), domain.clone());
    if let Some(hit) = cache.offices_get(&key, Instant::now()) {
        return Ok(hit);
    }
    let summary = summarize_hints(&net.office_hints(), &org.id, domain.as_deref());
    let mut view = summary.view;
    if let Some(d) = domain.as_deref()
        && !summary.same_domain.is_empty()
    {
        view.older_same_domain = older_same_domain(&net, &org, d, summary.same_domain).await;
    }
    cache.offices_put(key, view.clone(), Instant::now());
    Ok(view)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ad::check::AdCheckStatus;
    use crate::permissions::JoinAdView;
    use ed25519_dalek::{Signer, SigningKey};
    use std::sync::atomic::{AtomicUsize, Ordering};

    const TEAM: &str = "0123456789abcdef0123456789abcdef";

    fn target() -> CheckTarget {
        CheckTarget {
            domain: "macf.co.id".into(),
            user: "rina".into(),
            name: "Rina Wijaya".into(),
            team_id: TEAM.into(),
            team_name: "Keuangan".into(),
            departments: vec![(TEAM.into(), "Keuangan".into())],
            ou_map: Vec::new(),
        }
    }

    fn entry(name: &str, department: &str, disabled: bool) -> DirectoryUser {
        DirectoryUser {
            user: "rina".into(),
            dn: "CN=rina,OU=Staf,DC=macf,DC=co,DC=id".into(),
            display_name: Some(name.into()),
            department: Some(department.into()),
            disabled,
        }
    }

    fn request(id: &str, ad: Option<JoinAdView>) -> JoinRequestView {
        JoinRequestView {
            id: id.into(),
            public_key: "a".repeat(64),
            display_name: "Rina Wijaya".into(),
            team_id: TEAM.into(),
            team_name: "Keuangan".into(),
            laptop: "PC-RINA".into(),
            os: "Windows".into(),
            app_version: "0.5.0".into(),
            requested_at: "2026-11-24T08:00:00Z".into(),
            received_at: "2026-11-24T08:00:01Z".into(),
            code: "ABCD EFGH".into(),
            ip: None,
            seen_by_name: None,
            note: None,
            account: None,
            ad,
            requester_outdated: false,
        }
    }

    fn claim() -> JoinAdView {
        JoinAdView {
            domain: "macf.co.id".into(),
            user: "rina".into(),
            dn: None,
            name: Some("Rina Wijaya".into()),
            department: Some("Keuangan".into()),
            ous: Vec::new(),
            suggested_team_id: Some(TEAM.into()),
            department_in_mira: true,
        }
    }

    #[test]
    fn target_needs_a_pending_request_with_an_ad_claim() {
        let pending = vec![request("r1", Some(claim())), request("r2", None)];
        let t = find_target(pending.clone(), "r1", Vec::new(), Vec::new()).unwrap();
        assert_eq!((t.domain.as_str(), t.user.as_str()), ("macf.co.id", "rina"));
        assert_eq!(t.name, "Rina Wijaya");

        let err = find_target(pending.clone(), "r2", Vec::new(), Vec::new()).unwrap_err();
        assert!(
            matches!(&err, AppError::InvalidInput(m) if m == REQUEST_NO_AD),
            "{err:?}"
        );
        let err = find_target(pending, "r3", Vec::new(), Vec::new()).unwrap_err();
        assert!(
            matches!(&err, AppError::NotFound(m) if m == REQUEST_NOT_HERE),
            "{err:?}"
        );
    }

    #[test]
    fn lookup_results_map_to_statuses() {
        let t = target();
        let at = || "2026-11-24T08:00:00Z".to_owned();
        let status = |r| check_result(&t, r, at()).status;
        assert_eq!(
            status(Ok(entry("Rina Wijaya", "Keuangan", false))),
            AdCheckStatus::Match
        );
        assert_eq!(
            status(Ok(entry("Rini", "Keuangan", false))),
            AdCheckStatus::Mismatch
        );
        assert_eq!(
            status(Ok(entry("Rina Wijaya", "Keuangan", true))),
            AdCheckStatus::Disabled
        );
        assert_eq!(status(Err(LookupError::NotFound)), AdCheckStatus::NotFound);
        assert_eq!(
            status(Err(LookupError::Unreachable)),
            AdCheckStatus::Unreachable
        );
        assert_eq!(
            status(Err(LookupError::NotDomainMachine)),
            AdCheckStatus::NotDomainMachine
        );
        assert_eq!(
            status(Err(LookupError::OtherDomain {
                mine: "lain.co.id".into()
            })),
            AdCheckStatus::OtherDomain
        );
        let c = check_result(&t, Ok(entry("Rini", "Keuangan", false)), at());
        assert_eq!(c.mismatches.len(), 1);
        assert_eq!(c.checked_at, at());
    }

    #[tokio::test]
    async fn checks_are_cached_until_refresh() {
        let cache = OrgAdCache::default();
        let calls = AtomicUsize::new(0);
        let t = target();
        let lookup = |answer: Result<DirectoryUser, LookupError>| {
            let calls = &calls;
            move |domain: String, user: String| {
                assert_eq!((domain.as_str(), user.as_str()), ("macf.co.id", "rina"));
                calls.fetch_add(1, Ordering::SeqCst);
                async move { answer }
            }
        };

        let first = cached_check(
            &cache,
            "r1",
            false,
            &t,
            lookup(Err(LookupError::Unreachable)),
        )
        .await;
        assert_eq!(first.status, AdCheckStatus::Unreachable);
        // Cached: the directory is not asked again.
        let again = cached_check(
            &cache,
            "r1",
            false,
            &t,
            lookup(Ok(entry("Rina Wijaya", "Keuangan", false))),
        )
        .await;
        assert_eq!(again, first);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // Another request has its own entry.
        let other = cached_check(&cache, "r2", false, &t, lookup(Err(LookupError::NotFound))).await;
        assert_eq!(other.status, AdCheckStatus::NotFound);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        // Refresh asks again and replaces the entry.
        let fresh = cached_check(
            &cache,
            "r1",
            true,
            &t,
            lookup(Ok(entry("Rina Wijaya", "Keuangan", false))),
        )
        .await;
        assert_eq!(fresh.status, AdCheckStatus::Match);
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        let cached =
            cached_check(&cache, "r1", false, &t, lookup(Err(LookupError::NotFound))).await;
        assert_eq!(cached.status, AdCheckStatus::Match);
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        // A saved mapping forgets them.
        cache.clear_checks();
        cached_check(&cache, "r1", false, &t, lookup(Err(LookupError::NotFound))).await;
        assert_eq!(calls.load(Ordering::SeqCst), 4);
    }

    #[test]
    fn check_cache_expires_and_is_bounded() {
        let mut c = CheckCache::default();
        let t0 = Instant::now();
        let check = check::from_error(&LookupError::NotFound, "x".into());
        c.put("r".into(), check.clone(), t0);
        assert!(
            c.get("r", t0 + CHECK_TTL - Duration::from_secs(1))
                .is_some()
        );
        assert!(c.get("r", t0 + CHECK_TTL).is_none());

        for i in 0..(MAX_CHECKS + 10) {
            c.put(
                format!("r{i}"),
                check.clone(),
                t0 + Duration::from_millis(i as u64),
            );
        }
        assert_eq!(c.entries.len(), MAX_CHECKS);
        // The oldest went first.
        assert!(!c.entries.contains_key("r0"));
        assert!(c.entries.contains_key(&format!("r{}", MAX_CHECKS + 9)));
    }

    // ----- Other offices --------------------------------------------------------

    const OWN: &str = "00000000000000000000000000000000";
    const ORG_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const ORG_C: &str = "cccccccccccccccccccccccccccccccc";

    fn hint(
        pk: char,
        ip: u8,
        org: &str,
        name: Option<&str>,
        j: bool,
        ad: Option<&str>,
    ) -> OfficeHint {
        OfficeHint {
            public_key: pk.to_string().repeat(64),
            address: SocketAddr::from(([10, 0, 0, ip], 47800)),
            org: org.into(),
            org_name: name.map(str::to_owned),
            accepts_join: j,
            ad_domain: ad.map(str::to_owned),
        }
    }

    #[test]
    fn other_offices_are_counted_per_laptop() {
        let d = Some("macf.co.id");
        let hints = vec![
            // Laptop a at two addresses: one laptop.
            hint('a', 1, ORG_B, Some("MCF Baru"), false, d),
            hint('a', 2, ORG_B, Some("MCF Baru"), false, d),
            hint('b', 3, ORG_B, Some("MCF Baru"), true, d),
            // Another domain.
            hint('c', 4, ORG_C, Some("Toko"), true, Some("toko.co.id")),
            // This office: not counted.
            hint('d', 5, OWN, Some("MCF"), true, d),
            // Laptop e moved to this office; its older hint does not count.
            hint('e', 6, OWN, Some("MCF"), true, d),
            hint('e', 7, ORG_C, Some("Toko"), true, None),
        ];
        let s = summarize_hints(&hints, OWN, d);
        assert_eq!(s.view.laptops, 3);
        assert_eq!(s.view.offices, 2);
        assert_eq!(s.view.same_domain_laptops, 2);
        assert_eq!(s.view.names, ["MCF Baru", "Toko"]);
        assert_eq!(s.view.older_same_domain, None);
        // Takers of join requests are asked first.
        assert_eq!(s.same_domain.len(), 1);
        assert_eq!(s.same_domain[0].0, ORG_B);
        let ips: Vec<u8> = s.same_domain[0]
            .1
            .iter()
            .map(|a| match a.ip() {
                std::net::IpAddr::V4(v4) => v4.octets()[3],
                std::net::IpAddr::V6(_) => unreachable!(),
            })
            .collect();
        assert_eq!(ips, [3, 1, 2]);

        // Without an AD domain here, nothing counts as the same domain.
        let s = summarize_hints(&hints, OWN, None);
        assert_eq!(s.view.same_domain_laptops, 0);
        assert!(s.same_domain.is_empty());
        assert_eq!(s.view.laptops, 3);

        assert_eq!(
            summarize_hints(&[], OWN, d).view,
            OtherOfficesView::default()
        );
    }

    fn signed_org(seed: u8, id: &str, created_at: &str) -> Organization {
        let key = SigningKey::from_bytes(&[seed; 32]);
        let org = Organization {
            id: id.into(),
            name: format!("Kantor {seed}"),
            founder_public_key: hex::encode(key.verifying_key().to_bytes()),
            created_at: created_at.into(),
            genesis_signature: String::new(),
        };
        Organization {
            genesis_signature: hex::encode(key.sign(&org.genesis_message()).to_bytes()),
            ..org
        }
    }

    fn info(org: &Organization, ad: Option<&str>) -> JoinInfoWire {
        JoinInfoWire {
            org: net_backend::org_record(org.clone()),
            fingerprint: "ABCD-EFGH".into(),
            departments: Vec::new(),
            extras: 2,
            ad_domain: ad.map(str::to_owned),
            ad_ou_map: Vec::new(),
        }
    }

    #[test]
    fn office_answers_are_verified() {
        let d = "macf.co.id";
        let b = signed_org(2, ORG_B, "2026-01-01T00:00:00Z");
        assert_eq!(verify_office(info(&b, Some(d)), ORG_B, d), Some(b.clone()));
        // Not the office announced, another domain, or no domain.
        assert_eq!(verify_office(info(&b, Some(d)), ORG_C, d), None);
        assert_eq!(verify_office(info(&b, Some("lain.co.id")), ORG_B, d), None);
        assert_eq!(verify_office(info(&b, None), ORG_B, d), None);
        // A genesis record changed after signing.
        let forged = Organization {
            created_at: "2020-01-01T00:00:00Z".into(),
            ..b.clone()
        };
        assert_eq!(verify_office(info(&forged, Some(d)), ORG_B, d), None);
    }

    #[test]
    fn the_oldest_earlier_office_is_picked() {
        let own = signed_org(1, OWN, "2026-06-01T00:00:00Z");
        let newer = signed_org(2, ORG_B, "2026-07-01T00:00:00Z");
        let older = signed_org(3, ORG_C, "2026-03-01T00:00:00+07:00");
        let oldest = signed_org(
            4,
            "dddddddddddddddddddddddddddddddd",
            "2026-02-01T00:00:00Z",
        );

        assert_eq!(pick_older(&own, vec![newer.clone()]), None);
        assert_eq!(pick_older(&own, Vec::new()), None);

        let got = pick_older(&own, vec![newer.clone(), older.clone()]).unwrap();
        assert_eq!(got.name, older.name);
        assert_eq!(got.created_at, older.created_at);
        assert_eq!(got.fingerprint, permissions::org_fingerprint_short(&older));
        assert_eq!(got.fingerprint.len(), 9);

        let got = pick_older(&own, vec![older, newer, oldest.clone()]).unwrap();
        assert_eq!(got.name, oldest.name);

        // Same instant: the lower id is the earlier one.
        let twin = signed_org(
            5,
            "ffffffffffffffffffffffffffffffff",
            "2026-06-01T00:00:00Z",
        );
        assert_eq!(pick_older(&own, vec![twin]), None);
        let own_late = signed_org(
            6,
            "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            "2026-06-01T00:00:00Z",
        );
        let early_twin = signed_org(7, ORG_B, "2026-06-01T00:00:00Z");
        assert!(pick_older(&own_late, vec![early_twin]).is_some());
    }

    #[test]
    fn invalid_genesis_is_never_picked() {
        let own = signed_org(1, OWN, "2026-06-01T00:00:00Z");
        let older = signed_org(3, ORG_C, "2026-03-01T00:00:00Z");
        let forged = Organization {
            name: "Kantor Palsu".into(),
            ..older.clone()
        };
        // Only answers that pass `verify_office` reach `pick_older`.
        let found: Vec<Organization> = [info(&forged, Some("macf.co.id"))]
            .into_iter()
            .filter_map(|i| verify_office(i, ORG_C, "macf.co.id"))
            .collect();
        assert_eq!(pick_older(&own, found), None);
    }

    #[test]
    fn ad_settings_view_lists_what_blocks_saving() {
        use crate::identity::MemoryKeyStore;
        let dir = tempfile::tempdir().unwrap();
        let state = MiraState::new(
            Ok(dir.path().to_path_buf()),
            Box::new(MemoryKeyStore::new()),
        );
        let view = |machine: Option<String>| {
            state
                .with_core(|c| {
                    let s = permissions::require_state(&c.db)?;
                    Ok(ad_settings_view(&s, c.identity.public_key_hex(), machine))
                })
                .unwrap()
        };
        state
            .with_core(|c| {
                crate::identity::save_display_name(&mut c.db, &mut c.identity, "Andi")?;
                crate::org::create_organization(&mut c.db, &c.identity, "MCF").map(|_| ())
            })
            .unwrap();
        // No device report yet: the founder's own laptop blocks saving.
        let v = view(None);
        assert!(v.can_edit);
        assert!(!v.allowed);
        assert_eq!(
            v.outdated,
            [OutdatedLaptop {
                name: "Andi".into(),
                app_version: None
            }]
        );
        assert_eq!(v.domain, None);

        state
            .with_core(|c| {
                permissions::ensure_device_op(
                    &mut c.db,
                    &c.identity,
                    &crate::device::current(),
                    clock::now(),
                )?;
                permissions::set_ad_settings(
                    &mut c.db,
                    &c.identity,
                    "MACF.co.id",
                    Vec::new(),
                    clock::now(),
                )
            })
            .unwrap();
        let v = view(Some("macf.co.id".into()));
        assert!(v.allowed);
        assert!(v.outdated.is_empty());
        assert_eq!(v.domain.as_deref(), Some("macf.co.id"));
        assert_eq!(v.machine_domain.as_deref(), Some("macf.co.id"));
        let json = serde_json::to_value(&v).unwrap();
        for key in [
            "domain",
            "ouMap",
            "canEdit",
            "allowed",
            "outdated",
            "machineDomain",
        ] {
            assert!(json.get(key).is_some(), "{key}");
        }
    }
}
