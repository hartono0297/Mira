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

struct MdnsHandle {
    daemon: ServiceDaemon,
    /// Full service name and org of the current advertisement.
    registered: Option<(String, String)>,
}

#[derive(Debug, Clone)]
pub(crate) struct Candidate {
    pub pk: String,
    pub org: Option<String>,
    pub seen: Instant,
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

/// Advertises this laptop when it has an organization, with the current org
/// in TXT; withdraws the advertisement otherwise.
pub(crate) async fn refresh_mdns(inner: &Arc<Inner>) {
    let desired = inner.backend.org_id();
    let mut old_unregister = None;
    {
        let mut guard = lock(&inner.disc.mdns);
        let Some(h) = guard.as_mut() else {
            return;
        };
        if h.registered.as_ref().map(|(_, o)| o) == desired.as_ref() {
            return;
        }
        if let Some((fullname, _)) = h.registered.take() {
            old_unregister = h.daemon.unregister(&fullname).ok();
        }
        if let Some(org) = desired {
            let instance = &inner.me[..16];
            let host = format!("mira-{instance}.local.");
            let props = [
                ("v", "1".to_owned()),
                ("pk", inner.me.clone()),
                ("org", org.clone()),
            ];
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
                Ok(fullname) => h.registered = Some((fullname, org)),
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
                    seen: Instant::now(),
                },
            );
            added = true;
        }
        if added && org.is_some() && org == inner.backend.org_id() {
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
/// addresses not yet tied to a key are tried as well.
pub(crate) fn dial_pass(inner: &Arc<Inner>) {
    if inner.is_closing() {
        return;
    }
    let Some(org) = inner.backend.org_id() else {
        return;
    };
    let members: HashSet<String> = inner
        .backend
        .active_members()
        .into_iter()
        .filter(|m| *m != inner.me)
        .collect();
    let connected: HashSet<String> = inner.connected_peers().into_iter().collect();
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
            && inner.connected_peers().iter().any(|p| p == pk)
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
                    seen: t0 + Duration::from_millis(u64::from(i)),
                },
            );
        }
        d.add_candidate(
            SocketAddr::from(([10, 0, 1, 1], 47800)),
            Candidate {
                pk: "b".repeat(64),
                org: Some("0".repeat(32)),
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
}
