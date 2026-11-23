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

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::task::JoinSet;

use crate::clock;
use crate::device;
use crate::error::{AppError, AppResult};
use crate::net_backend::{self, AppNet};
use crate::network::{
    JOIN_INFO_EXTRAS, JoinInfoWire, JoinReject, JoinRequestWire, JoinStatusWire, Network,
};
use crate::org::{self, OrgInfo, Organization};
use crate::peers;
use crate::permissions::join::{JOIN_ACCOUNT_MAX_CHARS, JoinExtras};
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinSearch {
    pub offices: Vec<FoundOffice>,
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
    /// Member key → address it answered on, when, and its `extras`.
    members: HashMap<String, (SocketAddr, Instant, u32)>,
}

impl Office {
    /// Every member that answered takes requests with `note` and `account`.
    fn accepts_extras(&self) -> bool {
        !self.members.is_empty() && self.members.values().all(|m| m.2 >= JOIN_INFO_EXTRAS)
    }
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
        } = info;
        self.prune(now);
        let key = office_key(&org);
        if !self.offices.contains_key(&key) && self.offices.len() >= MAX_OFFICES {
            // Make room by dropping the office heard from least recently.
            let oldest = self
                .offices
                .iter()
                .min_by_key(|(_, o)| o.members.values().map(|m| m.1).max())
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
        entry.members.insert(pk.to_owned(), (addr, now, extras));
        self.asked.insert(pk.to_owned(), now);
        key
    }

    /// Drops members not heard from within [`MEMBER_TTL`], offices left
    /// without members, and old `asked` entries.
    fn prune(&mut self, now: Instant) {
        for o in self.offices.values_mut() {
            o.members
                .retain(|_, (_, at, _)| now.saturating_duration_since(*at) < MEMBER_TTL);
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
        }
    }

    fn snapshot(&self) -> Vec<FoundOffice> {
        let mut out: Vec<FoundOffice> =
            self.offices.iter().map(|(k, o)| self.found(k, o)).collect();
        out.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.key.cmp(&b.key)));
        out
    }

    /// Verified members of an office, freshest answer first. With
    /// `needs_extras`, only those that take requests with `note` and
    /// `account` (a v0.3 member refuses them).
    fn members_of(&self, key: &str, needs_extras: bool) -> Vec<(String, SocketAddr)> {
        let Some(office) = self.offices.get(key) else {
            return Vec::new();
        };
        let mut m: Vec<(&String, &(SocketAddr, Instant, u32))> = office
            .members
            .iter()
            .filter(|(_, m)| !needs_extras || m.2 >= JOIN_INFO_EXTRAS)
            .collect();
        m.sort_by(|a, b| b.1.1.cmp(&a.1.1).then_with(|| a.0.cmp(b.0)));
        m.into_iter()
            .map(|(pk, (addr, _, _))| (pk.clone(), *addr))
            .collect()
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
}

impl JoinClient {
    fn lock(&self) -> MutexGuard<'_, ClientState> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
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
}

/// The genesis record and departments of an answer, if the record verifies
/// and (for mDNS hints) its id is the one announced.
fn verify_info(info: JoinInfoWire, expected_org: Option<&str>) -> Option<VerifiedInfo> {
    let extras = info.extras;
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

/// `join_search`: asks the mDNS candidates not asked in the last minute.
pub async fn search(net: &Network, client: &JoinClient) -> JoinSearch {
    let hints = net.office_hints();
    let status = net.status();
    let result = |client: &JoinClient| JoinSearch {
        offices: client.lock().snapshot(),
        org_seen: !hints.is_empty(),
        mdns_ok: status.mdns_ok,
        mdns_error: status.mdns_error.clone(),
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
    // A request with `note` or `account` goes only to members that said
    // they take it; v0.3 members refuse it as invalid.
    let needs_extras = has_extras(out);
    ask_office_if_unknown(state, net, client, out, needs_extras).await?;
    // No conflict check here: the request is pinned to one genesis record
    // (chosen in `send_request`), and only laptops that answered with that
    // exact record are sent to.
    let st = client.lock();
    Ok(st
        .members_of(&key, needs_extras)
        .into_iter()
        .filter(|(pk, _)| !st.delivered.contains(pk))
        .take(MAX_SEND)
        .map(|(_, addr)| addr)
        .collect())
}

/// After a restart nothing is cached: asks the candidate addresses of
/// `out`'s office for `join_info` when no member (taking the v0.4 fields,
/// with `needs_extras`) is known.
async fn ask_office_if_unknown(
    state: &MiraState,
    net: &Network,
    client: &JoinClient,
    out: &OutgoingJoinRequest,
    needs_extras: bool,
) -> AppResult<()> {
    let key = office_key(&out.org);
    if !client.lock().members_of(&key, needs_extras).is_empty() {
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
/// still takes them; otherwise the v0.3 shape.
fn resend_extras(old: &OutgoingJoinRequest, office_accepts: bool) -> Option<JoinExtras> {
    (office_accepts && has_extras(old)).then(|| JoinExtras {
        note: old.note.clone(),
        account: login_account(),
    })
}

/// The request carries a v0.4 field (`note` or `account`).
fn has_extras(out: &OutgoingJoinRequest) -> bool {
    permissions::join::parse_request_payload(&out.request.payload).is_ok_and(|p| p.has_extras())
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
pub async fn send_request(
    state: &MiraState,
    net: &Network,
    client: &JoinClient,
    office_key: &str,
    team_id: &str,
    confirm_fingerprint: Option<&str>,
    note: Option<&str>,
) -> AppResult<OutgoingJoinRequest> {
    let _op = client.ops.lock().await;
    let (target, members, accepts_extras) = {
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
        let accepts_extras = office.accepts_extras();
        let members: Vec<SocketAddr> = st
            .members_of(office_key, accepts_extras)
            .into_iter()
            .take(MAX_SEND)
            .map(|(_, a)| a)
            .collect();
        (
            JoinTarget {
                org: office.org.clone(),
                team_id: team.id.clone(),
                team_name: team.name.clone(),
            },
            members,
            accepts_extras,
        )
    };
    let extras = accepts_extras.then(|| JoinExtras {
        note: note.map(str::to_owned),
        account: login_account(),
    });
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
    send_and_record(state, net, client, &out, members).await
}

/// `join_resend`: a new request (new id and code) to the same office and
/// department, sent right away. With the previous note and the current
/// login account name if the previous request carried v0.4 fields and the
/// office still takes them (a member may have been replaced by a v0.3
/// laptop meanwhile); the v0.3 shape otherwise.
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
    ask_office_if_unknown(state, net, client, &old, false).await?;
    let accepts = client
        .lock()
        .offices
        .get(&office_key(&old.org))
        .is_some_and(Office::accepts_extras);
    let extras = resend_extras(&old, accepts);
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
    for (_, a) in st.members_of(&office_key(&out.org), false) {
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
) -> AppResult<OutgoingJoinRequest> {
    let network = net.get(&state, &app).await?;
    send_request(
        &state,
        &network,
        &client,
        &office_key,
        &team_id,
        confirm_fingerprint.as_deref(),
        note.as_deref(),
    )
    .await
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
        };
        let v = serde_json::to_value(&office).unwrap();
        let keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        let mut keys = keys;
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "acceptsNote",
                "conflict",
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
        let s = serde_json::to_value(JoinSearch {
            offices: vec![],
            org_seen: true,
            mdns_ok: false,
            mdns_error: None,
        })
        .unwrap();
        assert_eq!(
            s,
            serde_json::json!({ "offices": [], "orgSeen": true, "mdnsOk": false, "mdnsError": null })
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
        };
        let v = serde_json::to_value(&out).unwrap();
        assert_eq!(
            sorted_keys(&v),
            [
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
        let v = serde_json::to_value(OutgoingJoinRequest { note: None, ..out }).unwrap();
        assert_eq!(v["note"], serde_json::Value::Null);

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
        };
        let v = serde_json::to_value(&card).unwrap();
        assert_eq!(
            sorted_keys(&v),
            [
                "account",
                "appVersion",
                "code",
                "displayName",
                "id",
                "ip",
                "laptop",
                "note",
                "os",
                "publicKey",
                "receivedAt",
                "requestedAt",
                "seenByName",
                "teamId",
                "teamName"
            ]
        );
        assert_eq!(v["note"], "Staf gudang");
        assert_eq!(v["account"], serde_json::Value::Null);
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
        let request = |note: Option<&str>| {
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
            }
        };
        let with = request(Some("Staf gudang"));
        let extras = resend_extras(&with, true).unwrap();
        assert_eq!(extras.note.as_deref(), Some("Staf gudang"));
        assert_eq!(extras.account, login_account());
        assert_eq!(
            resend_extras(&with, false),
            None,
            "office went back to v0.3"
        );
        assert_eq!(resend_extras(&request(None), true), None, "was v0.3 shape");
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
        VerifiedInfo {
            org,
            departments: Vec::new(),
            extras,
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
        assert_eq!(st.members_of(&key, true).len(), 1);
        // A v0.3 member answers for the same office.
        st.record(&"02".repeat(32), a2, info(genesis(1), 0), t0);
        assert!(!found(&st).accepts_note);
        assert_eq!(found(&st).peer_count, 2);
        assert_eq!(st.members_of(&key, false).len(), 2);
        assert_eq!(st.members_of(&key, true), vec![("01".repeat(32), a1)]);
        // It updates to v0.4 and answers again.
        st.record(&"02".repeat(32), a2, info(genesis(1), JOIN_INFO_EXTRAS), t0);
        assert!(found(&st).accepts_note);
        // Only v0.3 members: no.
        let other = st.record(&"03".repeat(32), a1, info(genesis(2), 0), t0);
        assert!(!st.found(&other, &st.offices[&other]).accepts_note);
        assert!(st.members_of(&other, true).is_empty());
    }

    #[test]
    fn rejecter_name_from_the_lan_is_cleaned() {
        assert_eq!(clean_name("Andi"), "Andi");
        assert_eq!(clean_name("An\u{202E}di\n\u{0007}"), "Andi");
        assert_eq!(clean_name("  \u{200F} "), "Admin kantor");
        assert_eq!(clean_name(&"x".repeat(200)).chars().count(), 60);
    }

    fn genesis(n: u8) -> Organization {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[n; 32]);
        let mut o = Organization {
            id: format!("{n:02x}").repeat(16),
            name: format!("Kantor {n}"),
            founder_public_key: hex::encode(sk.verifying_key().as_bytes()),
            created_at: "2026-11-23T08:00:00Z".into(),
            genesis_signature: String::new(),
        };
        use ed25519_dalek::Signer;
        o.genesis_signature = hex::encode(sk.sign(&o.genesis_message()).to_bytes());
        o
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
}
