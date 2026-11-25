//! Finding peers: mDNS (plan 2.5) and the dial loop over remembered,
//! manual and mDNS-discovered addresses with per-address backoff.
//!
//! mDNS TXT records are hints only. A discovered (key, address) pair is kept
//! in memory as a dial candidate; it reaches the backend's remembered
//! addresses only after a connection to that address proved a member key.

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use tokio::sync::Semaphore;

use super::AddressSource;
use super::node::{DialCtx, Inner, lock};
use super::route;
use super::wire;

pub(crate) const SERVICE_TYPE: &str = "_mira._udp.local.";

const DIAL_INTERVAL: Duration = Duration::from_secs(10);
const BACKOFF_START: Duration = Duration::from_secs(10);
const BACKOFF_MAX: Duration = Duration::from_secs(300);
/// mDNS candidates not seen again for this long are forgotten.
const CANDIDATE_TTL: Duration = Duration::from_secs(600);
const MAX_CANDIDATES: usize = 256;
/// mDNS addresses kept per announced key.
const MAX_CANDIDATES_PER_KEY: usize = 4;
/// Peers dialed at the same time.
const MAX_CONCURRENT_DIALS: usize = 8;
/// Longest TXT `on` (organization name) in bytes, sent and read (contract
/// 8.1). Keeps the whole TXT record well inside one mDNS packet.
const MAX_TXT_ORG_NAME: usize = 63;
/// Longest TXT `ad` (organization's AD domain) value announced: one TXT
/// string holds 255 bytes, `ad=` included. A normalized domain is at most
/// 253 bytes, so only the very longest are left out.
const MAX_TXT_AD: usize = 252;

struct MdnsHandle {
    daemon: ServiceDaemon,
    /// Full service name and contents of the current advertisement.
    registered: Option<(String, Advert)>,
}

/// What this laptop announces besides its key. A change of any field
/// (organization, its name, whether join requests are taken, AD domain)
/// re-registers the service so browsers see the new TXT.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Advert {
    /// TXT `org`.
    org: String,
    /// TXT `on`, already cut to `MAX_TXT_ORG_NAME`; left out when `None`.
    org_name: Option<String>,
    /// TXT `j` = `"1"`. Left out (not `"0"`) when false, so the record stays
    /// what a v0.2 laptop sends and readers only test for `"1"`.
    accepts_join: bool,
    /// TXT `ad`: the organization's AD domain (onboarding-ad, plan 6.3).
    /// Older Mira ignores the key.
    ad_domain: Option<String>,
}

/// TXT key/value pairs for `advert`, in the order they are sent.
fn advert_props(me: &str, advert: &Advert) -> Vec<(&'static str, String)> {
    let mut props = vec![
        ("v", "1".to_owned()),
        ("pk", me.to_owned()),
        ("org", advert.org.clone()),
    ];
    if let Some(name) = &advert.org_name {
        props.push(("on", name.clone()));
    }
    if advert.accepts_join {
        props.push(("j", "1".to_owned()));
    }
    if let Some(domain) = &advert.ad_domain {
        props.push(("ad", domain.clone()));
    }
    props
}

/// The AD domain as announced: a valid domain short enough for one TXT
/// string, `None` otherwise.
fn txt_ad_domain(domain: &str) -> Option<String> {
    crate::ad::dn::normalize_domain(domain).filter(|d| d.len() <= MAX_TXT_AD)
}

/// TXT `ad` as received: anyone on the LAN can send anything, so only a
/// valid domain (normalized) is kept.
fn parse_txt_ad(raw: &str) -> Option<String> {
    crate::ad::dn::normalize_domain(raw)
}

#[derive(Debug, Clone)]
pub(crate) struct Candidate {
    pub pk: String,
    pub org: Option<String>,
    /// TXT `on`, cleaned by `parse_txt_org_name`. Unauthenticated hint.
    pub org_name: Option<String>,
    /// TXT `j` == `"1"`. Unauthenticated hint.
    pub accepts_join: bool,
    /// TXT `ad`, cleaned by `parse_txt_ad`. Unauthenticated hint.
    pub ad_domain: Option<String>,
    pub seen: Instant,
}

/// `name` cut at a character boundary to at most `MAX_TXT_ORG_NAME` bytes.
fn txt_org_name(name: &str) -> String {
    truncate_at_char(name, MAX_TXT_ORG_NAME).to_owned()
}

/// The longest prefix of `s` with at most `max` bytes that ends on a
/// character boundary.
fn truncate_at_char(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// TXT `on` as received: anyone on the LAN can send anything, so at most
/// `MAX_TXT_ORG_NAME` bytes, no control characters, trimmed. Empty: `None`.
fn parse_txt_org_name(raw: &str) -> Option<String> {
    let cleaned: String = truncate_at_char(raw, MAX_TXT_ORG_NAME)
        .chars()
        .filter(|c| !c.is_control())
        .collect();
    let trimmed = cleaned.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

struct Backoff {
    next: Instant,
    delay: Duration,
}

pub(crate) struct Discovery {
    mdns: Mutex<Option<MdnsHandle>>,
    status: Mutex<(bool, Option<String>)>,
    candidates: Mutex<HashMap<SocketAddr, Candidate>>,
    backoff: Mutex<HashMap<SocketAddr, Backoff>>,
    in_flight: Mutex<HashSet<String>>,
    /// Manual addresses (no key yet in the backend) that a connection has
    /// already tied to a key, so they are not dialed again while connected.
    resolved_manual: Mutex<HashMap<SocketAddr, String>>,
    dial_slots: Arc<Semaphore>,
}

impl Discovery {
    pub(crate) fn new() -> Self {
        Self {
            mdns: Mutex::new(None),
            status: Mutex::new((false, None)),
            candidates: Mutex::new(HashMap::new()),
            backoff: Mutex::new(HashMap::new()),
            in_flight: Mutex::new(HashSet::new()),
            resolved_manual: Mutex::new(HashMap::new()),
            dial_slots: Arc::new(Semaphore::new(MAX_CONCURRENT_DIALS)),
        }
    }

    pub(crate) fn set_mdns_status(&self, ok: bool, error: Option<String>) {
        *lock(&self.status) = (ok, error);
    }

    pub(crate) fn mdns_status(&self) -> (bool, Option<String>) {
        lock(&self.status).clone()
    }

    pub(crate) fn mdns_running(&self) -> bool {
        lock(&self.mdns).is_some()
    }

    /// `true` while a dial round for some peer or address is running.
    pub(crate) fn dials_in_flight(&self) -> bool {
        !lock(&self.in_flight).is_empty()
    }

    /// Laptops announcing an organization (TXT `org`, `on`, `j`, `ad`), freshest
    /// first, without this laptop and without candidates older than
    /// `CANDIDATE_TTL` (v0.3 onboarding). Hints only.
    pub(crate) fn office_hints(&self, me: &str) -> Vec<super::OfficeHint> {
        let now = Instant::now();
        let mut v: Vec<(Instant, super::OfficeHint)> = lock(&self.candidates)
            .iter()
            .filter(|(_, c)| c.pk != me && now.duration_since(c.seen) < CANDIDATE_TTL)
            .filter_map(|(a, c)| {
                let org = c.org.clone()?;
                Some((
                    c.seen,
                    super::OfficeHint {
                        public_key: c.pk.clone(),
                        address: *a,
                        org,
                        org_name: c.org_name.clone(),
                        accepts_join: c.accepts_join,
                        ad_domain: c.ad_domain.clone(),
                    },
                ))
            })
            .collect();
        v.sort_by_key(|x| std::cmp::Reverse(x.0));
        v.into_iter().map(|(_, h)| h).collect()
    }

    /// mDNS candidates advertising an organization, freshest first.
    pub(crate) fn org_candidates(&self, me: &str) -> Vec<SocketAddr> {
        let mut v: Vec<(SocketAddr, Instant)> = lock(&self.candidates)
            .iter()
            .filter(|(_, c)| c.org.is_some() && c.pk != me)
            .map(|(a, c)| (*a, c.seen))
            .collect();
        v.sort_by_key(|x| std::cmp::Reverse(x.1));
        v.into_iter().map(|(a, _)| a).collect()
    }

    pub(crate) fn add_candidate(&self, addr: SocketAddr, c: Candidate) {
        let mut map = lock(&self.candidates);
        let now = Instant::now();
        map.retain(|_, v| now.duration_since(v.seen) < CANDIDATE_TTL);
        let pk = c.pk.clone();
        map.insert(addr, c);
        // Keep only the newest few addresses announced for this key.
        let mut same: Vec<(SocketAddr, Instant)> = map
            .iter()
            .filter(|(a, v)| v.pk == pk && **a != addr)
            .map(|(a, v)| (*a, v.seen))
            .collect();
        if same.len() >= MAX_CANDIDATES_PER_KEY {
            same.sort_by_key(|x| x.1);
            let excess = same.len() + 1 - MAX_CANDIDATES_PER_KEY;
            for (a, _) in same.into_iter().take(excess) {
                map.remove(&a);
            }
        }
        while map.len() > MAX_CANDIDATES {
            let Some(oldest) = map.iter().min_by_key(|(_, v)| v.seen).map(|(a, _)| *a) else {
                break;
            };
            map.remove(&oldest);
        }
    }

    fn backoff_due(&self, addr: &SocketAddr) -> bool {
        lock(&self.backoff)
            .get(addr)
            .is_none_or(|b| Instant::now() >= b.next)
    }

    fn backoff_record(&self, addr: SocketAddr, ok: bool) {
        let mut map = lock(&self.backoff);
        if ok {
            map.remove(&addr);
            return;
        }
        let delay = map
            .get(&addr)
            .map(|b| (b.delay * 2).min(BACKOFF_MAX))
            .unwrap_or(BACKOFF_START);
        map.insert(
            addr,
            Backoff {
                next: Instant::now() + delay,
                delay,
            },
        );
    }

    pub(crate) fn reset_backoff(&self) {
        lock(&self.backoff).clear();
    }
}

// ----- mDNS ----------------------------------------------------------------

pub(crate) async fn start_mdns(inner: &Arc<Inner>) {
    let daemon = match ServiceDaemon::new() {
        Ok(d) => d,
        Err(e) => {
            inner
                .disc
                .set_mdns_status(false, Some(format!("mDNS tidak bisa dijalankan: {e}")));
            return;
        }
    };
    match daemon.browse(SERVICE_TYPE) {
        Ok(rx) => {
            let weak = Arc::downgrade(inner);
            tokio::spawn(browse_loop(weak, rx));
            inner.disc.set_mdns_status(true, None);
        }
        Err(e) => {
            inner
                .disc
                .set_mdns_status(false, Some(format!("Pencarian mDNS gagal: {e}")));
        }
    }
    *lock(&inner.disc.mdns) = Some(MdnsHandle {
        daemon,
        registered: None,
    });
    refresh_mdns(inner).await;
}

/// Advertises this laptop when it has an organization, with the current
/// org, its name, whether it takes join requests and the organization's AD
/// domain in TXT; withdraws the
/// advertisement otherwise. Called on start, `Network::refresh` and new ops,
/// which covers renames and role changes.
pub(crate) async fn refresh_mdns(inner: &Arc<Inner>) {
    if !inner.disc.mdns_running() {
        return;
    }
    // Backend reads may hit the database: keep them off the async workers.
    let desired = inner
        .blocking(|b| {
            b.org_id().map(|org| Advert {
                org,
                org_name: b
                    .org_name()
                    .map(|n| txt_org_name(&n))
                    .filter(|n| !n.is_empty()),
                accepts_join: b.accepts_join_requests(),
                ad_domain: b.ad_domain().as_deref().and_then(txt_ad_domain),
            })
        })
        .await;
    let Some(desired) = desired else {
        return;
    };
    let mut old_unregister = None;
    {
        let mut guard = lock(&inner.disc.mdns);
        let Some(h) = guard.as_mut() else {
            return;
        };
        if h.registered.as_ref().map(|(_, a)| a) == desired.as_ref() {
            return;
        }
        if let Some((fullname, _)) = h.registered.take() {
            old_unregister = h.daemon.unregister(&fullname).ok();
        }
        if let Some(advert) = desired {
            let instance = &inner.me[..16];
            let host = format!("mira-{instance}.local.");
            let props = advert_props(&inner.me, &advert);
            let result = ServiceInfo::new(
                SERVICE_TYPE,
                instance,
                &host,
                (),
                inner.listen_port,
                &props[..],
            )
            .map(ServiceInfo::enable_addr_auto)
            .and_then(|info| {
                let fullname = info.get_fullname().to_owned();
                h.daemon.register(info).map(|()| fullname)
            });
            match result {
                Ok(fullname) => h.registered = Some((fullname, advert)),
                Err(e) => inner
                    .disc
                    .set_mdns_status(false, Some(format!("Iklan mDNS gagal: {e}"))),
            }
        }
    }
    if let Some(rx) = old_unregister {
        let _ = tokio::time::timeout(Duration::from_secs(1), rx.recv_async()).await;
    }
}

pub(crate) async fn stop_mdns(inner: &Inner) {
    let handle = lock(&inner.disc.mdns).take();
    let Some(h) = handle else {
        return;
    };
    if let Some((fullname, _)) = &h.registered
        && let Ok(rx) = h.daemon.unregister(fullname)
    {
        let _ = tokio::time::timeout(Duration::from_secs(1), rx.recv_async()).await;
    }
    if let Ok(rx) = h.daemon.shutdown() {
        let _ = tokio::time::timeout(Duration::from_secs(1), rx.recv_async()).await;
    }
}

async fn browse_loop(weak: Weak<Inner>, rx: mdns_sd::Receiver<ServiceEvent>) {
    while let Ok(ev) = rx.recv_async().await {
        let Some(inner) = weak.upgrade() else {
            break;
        };
        if inner.is_closing() {
            break;
        }
        let ServiceEvent::ServiceResolved(svc) = ev else {
            continue;
        };
        let Some(pk) = svc.get_property_val_str("pk").filter(|p| wire::is_hex64(p)) else {
            continue;
        };
        if pk == inner.me {
            continue;
        }
        let org = svc
            .get_property_val_str("org")
            .filter(|o| wire::is_hex_id32(o))
            .map(str::to_owned);
        let org_name = svc.get_property_val_str("on").and_then(parse_txt_org_name);
        let accepts_join = svc.get_property_val_str("j") == Some("1");
        let ad_domain = svc.get_property_val_str("ad").and_then(parse_txt_ad);
        let port = svc.get_port();
        let mut added = false;
        for ip in svc.get_addresses_v4() {
            let addr = SocketAddr::from((ip, port));
            if !route::is_dialable(&addr) {
                continue;
            }
            inner.disc.add_candidate(
                addr,
                Candidate {
                    pk: pk.to_owned(),
                    org: org.clone(),
                    org_name: org_name.clone(),
                    accepts_join,
                    ad_domain: ad_domain.clone(),
                    seen: Instant::now(),
                },
            );
            added = true;
        }
        if added && org.is_some() && org.as_deref() == inner.standing().org() {
            dial_pass(&inner);
        }
    }
}

// ----- Dialing -------------------------------------------------------------

struct Attempt {
    ctx: DialCtx,
    /// Report the result through `manual_attempt` (addresses from
    /// `known_addresses`).
    report: bool,
    last_success: Option<String>,
}

pub(crate) async fn dial_loop(weak: Weak<Inner>) {
    let mut tick = tokio::time::interval(DIAL_INTERVAL);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let Some(inner) = weak.upgrade() else {
            break;
        };
        if inner.is_closing() {
            break;
        }
        dial_pass(&inner);
    }
}

/// One round: for every active member without a live connection, try its
/// addresses (last successful first) whose backoff has passed. Manual
/// addresses not yet tied to a key are tried as well. A suspended laptop
/// (0.5.1) dials too: its connections carry the membership log only.
pub(crate) fn dial_pass(inner: &Arc<Inner>) {
    if inner.is_closing() {
        return;
    }
    let Some(org) = inner.standing().org().map(str::to_owned) else {
        return;
    };
    let members: HashSet<String> = inner
        .backend
        .active_members()
        .into_iter()
        .filter(|m| *m != inner.me)
        .collect();
    // Limited connections count as connected: no second dial.
    let connected: HashSet<String> = inner.linked_peers().into_iter().collect();
    let connected_addrs = inner.connected_addresses();
    let own = inner.own_addresses();
    let resolved = lock(&inner.disc.resolved_manual).clone();

    let mut targets: HashMap<String, Vec<Attempt>> = HashMap::new();
    let wanted = |pk: &str| pk != inner.me && members.contains(pk) && !connected.contains(pk);

    for ka in inner.backend.known_addresses() {
        if !route::is_dialable(&ka.address) || own.contains(&ka.address) {
            continue;
        }
        let pk = ka
            .public_key
            .clone()
            .or_else(|| resolved.get(&ka.address).cloned());
        match pk {
            Some(pk) => {
                if wanted(&pk) {
                    targets.entry(pk.clone()).or_default().push(Attempt {
                        ctx: DialCtx {
                            addr: ka.address,
                            expected: Some(pk),
                            source: if ka.public_key.is_some() {
                                AddressSource::Outgoing
                            } else {
                                AddressSource::Manual
                            },
                        },
                        report: true,
                        last_success: ka.last_success_at.clone(),
                    });
                }
            }
            None => {
                if !connected_addrs.contains(&ka.address) {
                    targets
                        .entry(format!("addr:{}", ka.address))
                        .or_default()
                        .push(Attempt {
                            ctx: DialCtx {
                                addr: ka.address,
                                expected: None,
                                source: AddressSource::Manual,
                            },
                            report: true,
                            last_success: None,
                        });
                }
            }
        }
    }

    {
        let now = Instant::now();
        let candidates = lock(&inner.disc.candidates);
        for (addr, c) in candidates.iter() {
            if now.duration_since(c.seen) >= CANDIDATE_TTL
                || c.org.as_deref() != Some(org.as_str())
                || !wanted(&c.pk)
                || own.contains(addr)
            {
                continue;
            }
            targets.entry(c.pk.clone()).or_default().push(Attempt {
                ctx: DialCtx {
                    addr: *addr,
                    expected: None,
                    source: AddressSource::Mdns,
                },
                report: false,
                last_success: None,
            });
        }
    }

    for (key, mut attempts) in targets {
        // Last successful first; RFC 3339 UTC strings sort by time.
        attempts.sort_by(|a, b| b.last_success.cmp(&a.last_success));
        let mut seen = HashSet::new();
        attempts.retain(|a| seen.insert(a.ctx.addr));
        if !lock(&inner.disc.in_flight).insert(key.clone()) {
            continue;
        }
        let me = inner.clone();
        tokio::spawn(async move {
            if let Ok(_slot) = me.disc.dial_slots.clone().acquire_owned().await {
                dial_target(&me, attempts).await;
            }
            lock(&me.disc.in_flight).remove(&key);
        });
    }
}

async fn dial_target(inner: &Arc<Inner>, attempts: Vec<Attempt>) {
    for a in attempts {
        if inner.is_closing() {
            return;
        }
        if let Some(pk) = &a.ctx.expected
            && inner.is_linked(pk)
        {
            return;
        }
        if !inner.disc.backoff_due(&a.ctx.addr) {
            continue;
        }
        let result = inner.dial(&a.ctx).await;
        inner.disc.backoff_record(a.ctx.addr, result.is_ok());
        if let Ok(pk) = &result
            && a.ctx.source == AddressSource::Manual
        {
            lock(&inner.disc.resolved_manual).insert(a.ctx.addr, pk.clone());
        }
        if a.report {
            let backend = inner.backend.clone();
            let addr = a.ctx.addr;
            let r = result.clone();
            let _ = tokio::task::spawn_blocking(move || backend.manual_attempt(addr, r)).await;
        }
        if result.is_ok() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// mDNS is unauthenticated: anyone can announce a member's key at many
    /// addresses. Only the newest few per key are kept, so one key's dial
    /// round stays short and other keys' candidates are not pushed out.
    #[test]
    fn candidates_per_key_are_capped_to_the_newest() {
        let d = Discovery::new();
        let t0 = Instant::now();
        let pk = "a".repeat(64);
        for i in 0..10u8 {
            d.add_candidate(
                SocketAddr::from(([10, 0, 0, i], 47800)),
                Candidate {
                    pk: pk.clone(),
                    org: Some("0".repeat(32)),
                    org_name: None,
                    accepts_join: false,
                    ad_domain: None,
                    seen: t0 + Duration::from_millis(u64::from(i)),
                },
            );
        }
        d.add_candidate(
            SocketAddr::from(([10, 0, 1, 1], 47800)),
            Candidate {
                pk: "b".repeat(64),
                org: Some("0".repeat(32)),
                org_name: None,
                accepts_join: false,
                ad_domain: None,
                seen: t0,
            },
        );
        let map = lock(&d.candidates);
        let mut kept: Vec<u8> = map
            .iter()
            .filter(|(_, c)| c.pk == pk)
            .map(|(a, _)| match a {
                SocketAddr::V4(v4) => v4.ip().octets()[3],
                SocketAddr::V6(_) => unreachable!(),
            })
            .collect();
        kept.sort();
        let newest: Vec<u8> = (10 - MAX_CANDIDATES_PER_KEY as u8..10).collect();
        assert_eq!(kept, newest);
        assert_eq!(map.len(), MAX_CANDIDATES_PER_KEY + 1);
    }

    #[test]
    fn txt_org_name_cuts_at_a_char_boundary() {
        // Short names stay as they are.
        assert_eq!(txt_org_name("Biro Arsitektur"), "Biro Arsitektur");
        assert_eq!(txt_org_name(""), "");

        // Exactly 63 bytes stays whole; 64 loses the last byte.
        let exact = "a".repeat(63);
        assert_eq!(txt_org_name(&exact), exact);
        let over = "b".repeat(64);
        assert_eq!(txt_org_name(&over), "b".repeat(63));

        // Two-byte letters: 31 of them are 62 bytes, the 32nd would end at 64.
        let accents = "Ü".repeat(40);
        let cut = txt_org_name(&accents);
        assert_eq!(cut, "Ü".repeat(31));
        assert_eq!(cut.len(), 62);

        // A long name with accents and emoji: never longer than 63 bytes,
        // always valid UTF-8, always a prefix of the original.
        let name = "Biro Arsitektur Ünïcödé Sejahtera 🏗️ Cabang Jakarta Selatan 🌴 dan Sekitarnya";
        assert!(name.len() > 63);
        let cut = txt_org_name(name);
        assert!(cut.len() <= 63, "{} bytes", cut.len());
        assert!(name.starts_with(&cut));
        assert!(cut.len() >= 60, "cut no more than one character: {cut:?}");

        // A four-byte emoji straddling byte 63 is dropped whole.
        let emoji = format!("{}🌴", "x".repeat(61));
        assert_eq!(emoji.len(), 65);
        assert_eq!(txt_org_name(&emoji), "x".repeat(61));
        // One that ends exactly at byte 63 is kept.
        let fits = format!("{}🌴", "x".repeat(59));
        assert_eq!(fits.len(), 63);
        assert_eq!(txt_org_name(&fits), fits);
    }

    #[test]
    fn txt_org_name_from_the_lan_is_cleaned() {
        assert_eq!(
            parse_txt_org_name("  Kantor Pusat  ").as_deref(),
            Some("Kantor Pusat")
        );
        assert_eq!(parse_txt_org_name(""), None);
        assert_eq!(parse_txt_org_name("   "), None);
        assert_eq!(parse_txt_org_name("\u{7}\n\t"), None);
        assert_eq!(
            parse_txt_org_name("Kan\u{0}tor\nPusat\u{1b}").as_deref(),
            Some("KantorPusat")
        );
        // At most 63 bytes are read, at a character boundary.
        let long = "é".repeat(100);
        let got = parse_txt_org_name(&long).expect("not empty");
        assert_eq!(got, "é".repeat(31));
        assert_eq!(parse_txt_org_name(&"z".repeat(300)), Some("z".repeat(63)));
    }

    fn props_map(props: &[(&'static str, String)]) -> HashMap<&'static str, String> {
        props.iter().cloned().collect()
    }

    #[test]
    fn txt_ad_is_written_when_the_office_has_a_domain() {
        let me = "e".repeat(64);
        let org = "0123456789abcdef0123456789abcdef".to_owned();
        let full = Advert {
            org: org.clone(),
            org_name: Some("MCF".into()),
            accepts_join: true,
            ad_domain: txt_ad_domain("MACF.co.id."),
        };
        let props = advert_props(&me, &full);
        let keys: Vec<&str> = props.iter().map(|(k, _)| *k).collect();
        assert_eq!(keys, ["v", "pk", "org", "on", "j", "ad"]);
        assert_eq!(props_map(&props)["ad"], "macf.co.id");

        let none = Advert {
            ad_domain: None,
            ..full.clone()
        };
        assert!(!props_map(&advert_props(&me, &none)).contains_key("ad"));

        // Not a domain, or too long for one TXT string: left out.
        assert_eq!(txt_ad_domain("bukan domain"), None);
        assert_eq!(txt_ad_domain("corp"), None);
        let long = format!(
            "{}.{}.{}.{}",
            "a".repeat(63),
            "b".repeat(63),
            "c".repeat(63),
            "d".repeat(61)
        );
        assert_eq!(long.len(), 253);
        assert!(crate::ad::dn::normalize_domain(&long).is_some());
        assert_eq!(txt_ad_domain(&long), None);
        let fits = &long[2..];
        assert_eq!(txt_ad_domain(fits).as_deref(), Some(fits));
    }

    /// The shape a Mira 0.1/0.2 laptop announces (`MIRA_TEST_LEGACY_ADVERT`):
    /// key and organization only.
    #[test]
    fn legacy_advert_carries_only_org() {
        let me = "e".repeat(64);
        let legacy = Advert {
            org: "0123456789abcdef0123456789abcdef".into(),
            org_name: None,
            accepts_join: false,
            ad_domain: None,
        };
        let keys: Vec<&str> = advert_props(&me, &legacy).iter().map(|(k, _)| *k).collect();
        assert_eq!(keys, ["v", "pk", "org"]);
    }

    #[test]
    fn txt_ad_from_the_lan_is_cleaned() {
        assert_eq!(parse_txt_ad(" MACF.CO.ID. ").as_deref(), Some("macf.co.id"));
        assert_eq!(parse_txt_ad("macf.co.id").as_deref(), Some("macf.co.id"));
        for bad in [
            "",
            "   ",
            "corp",
            "macf..co.id",
            "mac f.co.id",
            "macf.co.id\u{0}",
            "-a.co.id",
        ] {
            assert_eq!(parse_txt_ad(bad), None, "{bad:?}");
        }
        assert_eq!(parse_txt_ad(&"a.".repeat(200)), None);
    }

    #[test]
    fn office_hints_carry_the_ad_domain() {
        let d = Discovery::new();
        let mut c = hint_candidate(
            'a',
            Some("0123456789abcdef0123456789abcdef"),
            None,
            true,
            Instant::now(),
        );
        c.ad_domain = parse_txt_ad("Macf.co.id");
        d.add_candidate(SocketAddr::from(([10, 0, 0, 1], 47800)), c);
        let hints = d.office_hints(&"e".repeat(64));
        assert_eq!(hints[0].ad_domain.as_deref(), Some("macf.co.id"));
    }

    fn hint_candidate(
        pk: char,
        org: Option<&str>,
        name: Option<&str>,
        j: bool,
        seen: Instant,
    ) -> Candidate {
        Candidate {
            pk: pk.to_string().repeat(64),
            org: org.map(str::to_owned),
            org_name: name.map(str::to_owned),
            accepts_join: j,
            ad_domain: None,
            seen,
        }
    }

    #[test]
    fn office_hints_lists_fresh_org_candidates_newest_first() {
        let d = Discovery::new();
        let me = "e".repeat(64);
        let org = "0123456789abcdef0123456789abcdef";
        let now = Instant::now();
        let addr = |n: u8| SocketAddr::from(([10, 0, 0, n], 47800));
        d.add_candidate(
            addr(1),
            hint_candidate('a', Some(org), Some("Kantor"), true, now),
        );
        d.add_candidate(
            addr(2),
            hint_candidate('b', Some(org), None, false, now + Duration::from_millis(5)),
        );
        // No organization: an unjoined laptop, not an office.
        d.add_candidate(addr(3), hint_candidate('c', None, None, false, now));
        // This laptop itself.
        d.add_candidate(
            addr(4),
            hint_candidate('e', Some(org), Some("Kantor"), true, now),
        );
        // Stale: past `CANDIDATE_TTL` (only when the clock allows it).
        // Inserted directly, since `add_candidate` prunes stale entries.
        if let Some(old) = now.checked_sub(CANDIDATE_TTL + Duration::from_secs(1)) {
            lock(&d.candidates).insert(
                addr(5),
                hint_candidate('f', Some(org), Some("Lama"), true, old),
            );
        }

        let hints = d.office_hints(&me);
        assert_eq!(hints.len(), 2, "{hints:?}");
        assert_eq!(
            hints[0],
            super::super::OfficeHint {
                public_key: "b".repeat(64),
                address: addr(2),
                org: org.to_owned(),
                org_name: None,
                accepts_join: false,
                ad_domain: None,
            }
        );
        assert_eq!(
            hints[1],
            super::super::OfficeHint {
                public_key: "a".repeat(64),
                address: addr(1),
                org: org.to_owned(),
                org_name: Some("Kantor".to_owned()),
                accepts_join: true,
                ad_domain: None,
            }
        );
        assert!(Discovery::new().office_hints(&me).is_empty());
    }
}
