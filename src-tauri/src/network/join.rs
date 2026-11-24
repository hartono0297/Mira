//! The `mira-join/1` ALPN: redeeming an invite code (plan 2.4) and the v0.3
//! join requests (docs/plans/v0.3-kontrak.md 8.2).
//!
//! The first message of a session decides the flow. `JoinHello` starts the
//! invite flow: `JoinChallenge` or `JoinRejected`, then one `JoinProof`, then
//! `JoinAccepted` or `JoinRejected`. `JoinInfoGet`, `JoinRequest` and
//! `JoinStatusGet` get exactly one answer. Nothing else is served on this
//! ALPN. Sessions are limited per remote IP; `JoinStatusGet` has a budget of
//! its own because a waiting requester polls it.

use std::collections::{HashMap, HashSet, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use quinn::{Connection, VarInt};

use super::feature::TOPIC_JOIN;
use super::node::{HANDSHAKE_TIMEOUT, Inner, READ_TIMEOUT, WRITE_TIMEOUT, code, lock};
use super::route;
use super::tls::{self, SERVER_NAME};
use super::wire::{self, MAX_FRAME, MAX_JOIN_FRAME, Msg};
use super::{
    JoinAccepted, JoinChallenge, JoinInfoWire, JoinProof, JoinReject, JoinRequestOk,
    JoinRequestWire, JoinStatusWire, NetEvent, ProveFn,
};

pub(crate) const JOIN_ATTEMPTS_PER_MINUTE: usize = 10;
/// `join_status_get` sessions per IP per minute, counted apart from the
/// other join messages: a waiting requester asks every 5 seconds (12 per
/// minute), which must not use up its budget for `join_request`.
pub(crate) const JOIN_STATUS_PER_MINUTE: usize = 20;
pub(crate) const MAX_CONCURRENT_JOINS: usize = 16;
/// Join sessions from one IP at once, so one device cannot hold all
/// `MAX_CONCURRENT_JOINS` slots with sessions it never finishes.
pub(crate) const MAX_JOINS_PER_IP: usize = 2;
/// Whole `Network::join` call.
const JOIN_TOTAL_TIMEOUT: Duration = Duration::from_secs(20);
/// Whole `join_info_at`, `join_request_at` or `join_status_at` call.
const REQUEST_TOTAL_TIMEOUT: Duration = Duration::from_secs(10);
/// Largest `join_request_ok.code` accepted (`XXXX XXXX` is 9).
const MAX_CODE_CHARS: usize = 16;
/// Largest department list in a `join_info` answer.
const MAX_DEPARTMENTS: usize = 500;
const MAX_DEPT_NAME_CHARS: usize = 200;
/// Longest server message passed on to the UI.
const MAX_MESSAGE_CHARS: usize = 300;
/// How long to wait for mDNS to find someone when no address is known.
const MDNS_WAIT: Duration = Duration::from_secs(3);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Server keeps the connection open this long for the client to read the
/// final answer and close.
const FINAL_LINGER: Duration = Duration::from_secs(5);
/// Remote IPs tracked by a limiter before old entries are dropped.
const MAX_TRACKED_IPS: usize = 4096;
/// Join sessions of every kind from all addresses together, per minute.
/// Each one can cost a fold and an Argon2id run under the core lock, so a
/// host rotating addresses must not be able to keep the laptop busy.
pub(crate) const JOIN_GLOBAL_PER_MINUTE: usize = 240;
const GLOBAL_KEY: IpAddr = IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED);

/// The address a limit counts against: the IPv4 address, or the /64 of an
/// IPv6 address (one LAN host can use any address of its /64, the same
/// grouping as `permissions::ip_group`).
pub(crate) fn limit_key(ip: IpAddr) -> IpAddr {
    match ip.to_canonical() {
        IpAddr::V4(v4) => IpAddr::V4(v4),
        IpAddr::V6(v6) => {
            let s = v6.segments();
            IpAddr::V6(std::net::Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0))
        }
    }
}

/// Sliding-window limit per remote IP.
pub(crate) struct RateLimiter {
    max: usize,
    window: Duration,
    hits: HashMap<IpAddr, VecDeque<Instant>>,
}

impl RateLimiter {
    pub(crate) fn new(max: usize, window: Duration) -> Self {
        Self {
            max,
            window,
            hits: HashMap::new(),
        }
    }

    /// Records an attempt from `ip` at `now`; false when over the limit.
    pub(crate) fn check(&mut self, ip: IpAddr, now: Instant) -> bool {
        if self.hits.len() >= MAX_TRACKED_IPS && !self.hits.contains_key(&ip) {
            let window = self.window;
            self.hits.retain(|_, q| {
                q.back()
                    .is_some_and(|last| now.saturating_duration_since(*last) < window)
            });
            if self.hits.len() >= MAX_TRACKED_IPS {
                // Still full of active IPs: refuse rather than grow without bound.
                return false;
            }
        }
        let q = self.hits.entry(ip).or_default();
        while q
            .front()
            .is_some_and(|t| now.saturating_duration_since(*t) >= self.window)
        {
            q.pop_front();
        }
        if q.len() >= self.max {
            return false;
        }
        q.push_back(now);
        true
    }
}

fn reject(code: &str, message: &str) -> Msg {
    Msg::JoinRejected {
        code: code.to_owned(),
        message: message.to_owned(),
    }
}

/// Serves one join connection. The caller already checked that this laptop
/// has an organization.
pub(crate) async fn serve(inner: &Arc<Inner>, conn: Connection) {
    let Some(client_pk) = tls::peer_public_key(&conn) else {
        conn.close(VarInt::from_u32(code::PROTOCOL), b"no identity");
        return;
    };
    let remote = conn.remote_address();
    let Some(_per_ip) = inner.joins_by_ip.try_acquire(limit_key(remote.ip())) else {
        conn.close(VarInt::from_u32(code::PROTOCOL), b"busy");
        return;
    };
    let Ok(_slot) = inner.join_slots.clone().try_acquire_owned() else {
        conn.close(VarInt::from_u32(code::PROTOCOL), b"busy");
        return;
    };
    if let Some(mut send) = serve_session(inner, &conn, &client_pk, remote).await {
        let _ = send.finish();
        let _ = tokio::time::timeout(FINAL_LINGER, conn.closed()).await;
    }
    conn.close(VarInt::from_u32(code::NORMAL), b"done");
}

async fn serve_session(
    inner: &Arc<Inner>,
    conn: &Connection,
    client_pk: &str,
    remote: SocketAddr,
) -> Option<quinn::SendStream> {
    let (mut send, mut recv) = tokio::time::timeout(READ_TIMEOUT, conn.accept_bi())
        .await
        .ok()?
        .ok()?;
    let first = match wire::read_msg_timeout(&mut recv, MAX_JOIN_FRAME, READ_TIMEOUT).await {
        Ok(Some(Msg::JoinHello { tag })) => {
            return serve_hello(inner, client_pk, remote, tag, send, recv).await;
        }
        Ok(Some(
            msg @ (Msg::JoinInfoGet | Msg::JoinRequest { .. } | Msg::JoinStatusGet { .. }),
        )) => msg,
        _ => return None,
    };
    let answer = answer_request(inner, client_pk, remote, first).await;
    wire::write_msg_timeout(&mut send, &answer, WRITE_TIMEOUT)
        .await
        .ok()?;
    Some(send)
}

/// Counts a session against the limiter for its kind. `Some(answer)` when
/// the remote IP is over the limit.
fn over_limit(inner: &Inner, client_pk: &str, remote: SocketAddr, status: bool) -> Option<Msg> {
    let limiter = if status {
        &inner.join_status_limiter
    } else {
        &inner.join_limiter
    };
    let now = Instant::now();
    if lock(limiter).check(limit_key(remote.ip()), now)
        && lock(&inner.join_global_limiter).check(GLOBAL_KEY, now)
    {
        return None;
    }
    inner.log_rejection(
        Some(client_pk),
        Some(remote),
        "rate_limited",
        "Terlalu banyak percobaan bergabung dari alamat ini.",
    );
    Some(reject(
        "rate_limited",
        "Terlalu banyak percobaan bergabung. Tunggu satu menit lalu coba lagi.",
    ))
}

/// The one answer to `JoinInfoGet`, `JoinRequest` or `JoinStatusGet`. The
/// requester's key is the one proven in the handshake and its IP the one
/// the connection came from; nothing in the message is taken for identity.
async fn answer_request(inner: &Arc<Inner>, client_pk: &str, remote: SocketAddr, msg: Msg) -> Msg {
    let status = matches!(msg, Msg::JoinStatusGet { .. });
    if let Some(limited) = over_limit(inner, client_pk, remote, status) {
        return limited;
    }
    let tls_key = client_pk.to_owned();
    match msg {
        Msg::JoinInfoGet => match inner.blocking(|b| b.join_info()).await {
            Some(Some(info)) => Msg::JoinInfo { info },
            _ => reject("not_member", request_message("not_member")),
        },
        Msg::JoinRequest { request } => {
            let ip = remote.ip();
            match inner
                .blocking(move |b| b.join_request(&tls_key, ip, request))
                .await
            {
                Some(Ok(ok)) => {
                    inner.emit(NetEvent::JoinRequestsChanged);
                    // Forward the new record to the approvers now rather
                    // than at the next periodic feature sync.
                    inner.features.hub.notify_changed(TOPIC_JOIN);
                    Msg::JoinRequestOk {
                        request_id: ok.request_id,
                        code: ok.code,
                    }
                }
                Some(Err(rej)) => reject(&rej.code, &rej.message),
                None => reject("invalid_request", request_message("invalid_request")),
            }
        }
        Msg::JoinStatusGet { request_id } => {
            if !wire::is_hex64(&request_id) {
                return Msg::JoinStatusUnknown;
            }
            match inner
                .blocking(move |b| b.join_status(&tls_key, &request_id))
                .await
            {
                Some(JoinStatusWire::Pending) => Msg::JoinStatusPending,
                Some(JoinStatusWire::Approved(accepted)) => Msg::JoinStatusApproved { accepted },
                Some(JoinStatusWire::Rejected { by_name, at, op }) => {
                    Msg::JoinStatusRejected { by_name, at, op }
                }
                Some(JoinStatusWire::Unknown) | None => Msg::JoinStatusUnknown,
            }
        }
        _ => reject("invalid_request", request_message("invalid_request")),
    }
}

/// The invite flow, after its `JoinHello`.
async fn serve_hello(
    inner: &Arc<Inner>,
    client_pk: &str,
    remote: SocketAddr,
    tag: String,
    mut send: quinn::SendStream,
    recv: quinn::RecvStream,
) -> Option<quinn::SendStream> {
    let first = if let Some(limited) = over_limit(inner, client_pk, remote, false) {
        limited
    } else if !wire::is_invite_tag(&tag) {
        reject("invite_not_found", "Kode undangan tidak dikenal.")
    } else {
        let lookup = inner.blocking(move |b| b.join_lookup(&tag)).await;
        match lookup {
            Some(Ok(challenge)) => {
                return serve_proof(inner, client_pk, remote, challenge, send, recv).await;
            }
            Some(Err(rej)) => reject(&rej.code, &rej.message),
            None => reject("invite_not_found", "Kode undangan tidak bisa diperiksa."),
        }
    };
    wire::write_msg_timeout(&mut send, &first, WRITE_TIMEOUT)
        .await
        .ok()?;
    Some(send)
}

async fn serve_proof(
    inner: &Arc<Inner>,
    client_pk: &str,
    remote: SocketAddr,
    challenge: JoinChallenge,
    mut send: quinn::SendStream,
    mut recv: quinn::RecvStream,
) -> Option<quinn::SendStream> {
    wire::write_msg_timeout(
        &mut send,
        &Msg::JoinChallenge {
            org: challenge.org.clone(),
            invite: challenge.invite.clone(),
        },
        WRITE_TIMEOUT,
    )
    .await
    .ok()?;
    let Ok(Some(Msg::JoinProof { proof })) =
        wire::read_msg_timeout(&mut recv, MAX_JOIN_FRAME, READ_TIMEOUT).await
    else {
        return None;
    };
    let answer = if proof.member != client_pk {
        inner.log_rejection(
            Some(client_pk),
            Some(remote),
            "invalid_proof",
            "Bukti bergabung memakai kunci yang berbeda dari kunci koneksi.",
        );
        reject(
            "invalid_proof",
            "Bukti kode undangan tidak cocok dengan laptop ini.",
        )
    } else {
        let tls_key = client_pk.to_owned();
        match inner
            .blocking(move |b| b.join_accept(&tls_key, &challenge, proof))
            .await
        {
            Some(Ok(accepted)) => Msg::JoinAccepted { accepted },
            Some(Err(rej)) => reject(&rej.code, &rej.message),
            None => reject("invalid_proof", "Kode undangan tidak bisa diperiksa."),
        }
    };
    wire::write_msg_timeout(&mut send, &answer, WRITE_TIMEOUT)
        .await
        .ok()?;
    Some(send)
}

// ----- Client --------------------------------------------------------------

enum Outcome {
    Accepted(JoinAccepted),
    /// A local failure (making the proof): stop and report this.
    Final(JoinReject),
    /// A candidate refused. Not final: any device on the LAN can be a
    /// candidate and say anything, so the others are still tried.
    Refused(JoinReject),
    NotFound,
    RateLimited,
    Unreachable,
}

/// Makes the proof once, for the first challenge, and hands the same proof
/// to later candidates that send the same challenge. A candidate that only
/// took the proof and refused therefore does not end the join.
struct Prover {
    make: Option<ProveFn>,
    made: Option<(JoinChallenge, JoinProof)>,
}

impl Prover {
    /// `Ok(None)`: the proof was already made for a different challenge.
    fn proof_for(&mut self, challenge: &JoinChallenge) -> Result<Option<JoinProof>, String> {
        if let Some((c, p)) = &self.made {
            return Ok((c == challenge).then(|| p.clone()));
        }
        let Some(make) = self.make.take() else {
            return Ok(None);
        };
        let proof = make(challenge)?;
        self.made = Some((challenge.clone(), proof.clone()));
        Ok(Some(proof))
    }
}

fn local_message(code: &str) -> &'static str {
    match code {
        "invite_not_found" => "Kode undangan tidak dikenal oleh laptop rekan yang bisa dihubungi.",
        "invite_expired" => "Kode undangan sudah kedaluwarsa.",
        "invite_used" => "Kode undangan sekali pakai ini sudah dipakai.",
        "invite_revoked" => "Kode undangan ini sudah dicabut.",
        "invalid_proof" => "Kode undangan tidak cocok.",
        "rate_limited" => "Terlalu banyak percobaan bergabung. Tunggu satu menit lalu coba lagi.",
        _ => {
            "Tidak ada laptop rekan yang bisa dihubungi. Pastikan tersambung ke jaringan kantor, \
              atau isi alamat laptop rekan."
        }
    }
}

fn final_reject(code: &str, server_message: &str) -> JoinReject {
    let known = matches!(
        code,
        "invite_not_found"
            | "invite_expired"
            | "invite_used"
            | "invite_revoked"
            | "invalid_proof"
            | "rate_limited"
    );
    if known {
        let msg: String = server_message.chars().take(300).collect();
        let msg = if msg.trim().is_empty() {
            local_message(code).to_owned()
        } else {
            msg
        };
        JoinReject::new(code, &msg)
    } else {
        JoinReject::new("invalid_proof", local_message("invalid_proof"))
    }
}

pub(crate) async fn join(
    inner: &Arc<Inner>,
    tag: &str,
    extra: Vec<SocketAddr>,
    prove: ProveFn,
) -> Result<JoinAccepted, JoinReject> {
    if !wire::is_invite_tag(tag) {
        return Err(JoinReject::new(
            "invite_not_found",
            local_message("invite_not_found"),
        ));
    }
    match tokio::time::timeout(JOIN_TOTAL_TIMEOUT, join_inner(inner, tag, extra, prove)).await {
        Ok(r) => r,
        Err(_) => Err(JoinReject::new(
            "no_peer_found",
            local_message("no_peer_found"),
        )),
    }
}

async fn join_inner(
    inner: &Arc<Inner>,
    tag: &str,
    extra: Vec<SocketAddr>,
    prove: ProveFn,
) -> Result<JoinAccepted, JoinReject> {
    let mut prover = Prover {
        make: Some(prove),
        made: None,
    };
    let mut tried: HashSet<SocketAddr> = HashSet::new();
    let own = inner.own_addresses();
    let mdns_deadline = Instant::now() + MDNS_WAIT;
    let mut refused: Option<JoinReject> = None;
    let mut saw_not_found = false;
    let mut saw_rate_limited = false;

    loop {
        let mut candidates: Vec<SocketAddr> = extra.clone();
        candidates.extend(inner.disc.org_candidates(&inner.me));
        let mut fresh = HashSet::new();
        candidates.retain(|a| {
            route::is_dialable(a) && !own.contains(a) && !tried.contains(a) && fresh.insert(*a)
        });
        if candidates.is_empty() {
            if inner.disc.mdns_running() && Instant::now() < mdns_deadline {
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
            break;
        }
        for addr in candidates {
            tried.insert(addr);
            match attempt(inner, addr, tag, &mut prover).await {
                Outcome::Accepted(a) => return Ok(a),
                Outcome::Final(r) => return Err(r),
                Outcome::Refused(r) => {
                    refused.get_or_insert(r);
                }
                Outcome::NotFound => saw_not_found = true,
                Outcome::RateLimited => saw_rate_limited = true,
                Outcome::Unreachable => {}
            }
        }
    }
    // A refusal names a specific reason (expired, used, bad proof): it beats
    // "not found" from laptops that do not know the invite.
    if let Some(r) = refused {
        return Err(r);
    }
    let code = if saw_not_found {
        "invite_not_found"
    } else if saw_rate_limited {
        "rate_limited"
    } else {
        "no_peer_found"
    };
    Err(JoinReject::new(code, local_message(code)))
}

async fn attempt(inner: &Arc<Inner>, addr: SocketAddr, tag: &str, prover: &mut Prover) -> Outcome {
    let Ok(connecting) = inner
        .endpoint
        .connect_with(inner.join_client.clone(), addr, SERVER_NAME)
    else {
        return Outcome::Unreachable;
    };
    let conn = match tokio::time::timeout(CONNECT_TIMEOUT.min(HANDSHAKE_TIMEOUT), connecting).await
    {
        Ok(Ok(c)) => c,
        _ => return Outcome::Unreachable,
    };
    let outcome = match tls::peer_public_key(&conn) {
        Some(pk) if pk != inner.me => session(&conn, tag, prover).await,
        _ => Outcome::Unreachable,
    };
    conn.close(VarInt::from_u32(code::NORMAL), b"done");
    outcome
}

async fn session(conn: &Connection, tag: &str, prover: &mut Prover) -> Outcome {
    let Ok(Ok((mut send, mut recv))) = tokio::time::timeout(READ_TIMEOUT, conn.open_bi()).await
    else {
        return Outcome::Unreachable;
    };
    let hello = Msg::JoinHello {
        tag: tag.to_owned(),
    };
    if wire::write_msg_timeout(&mut send, &hello, WRITE_TIMEOUT)
        .await
        .is_err()
    {
        return Outcome::Unreachable;
    }
    let challenge = match wire::read_msg_timeout(&mut recv, MAX_JOIN_FRAME, READ_TIMEOUT).await {
        Ok(Some(Msg::JoinChallenge { org, invite })) => {
            if !wire::is_hex_id32(&org) || !wire::is_hex_id32(&invite) {
                return Outcome::Unreachable;
            }
            JoinChallenge { org, invite }
        }
        Ok(Some(Msg::JoinRejected { code, message })) => {
            return match code.as_str() {
                "invite_not_found" => Outcome::NotFound,
                "rate_limited" => Outcome::RateLimited,
                _ => Outcome::Refused(final_reject(&code, &message)),
            };
        }
        _ => return Outcome::Unreachable,
    };
    let proof = match prover.proof_for(&challenge) {
        Ok(Some(p)) => p,
        // Another candidate sent a different challenge for the same tag:
        // one of them is lying.
        Ok(None) => {
            return Outcome::Refused(JoinReject::new(
                "invalid_proof",
                local_message("invalid_proof"),
            ));
        }
        Err(e) => return Outcome::Final(JoinReject::new("invalid_proof", &e)),
    };
    if wire::write_msg_timeout(&mut send, &Msg::JoinProof { proof }, WRITE_TIMEOUT)
        .await
        .is_err()
    {
        return Outcome::Unreachable;
    }
    let _ = send.finish();
    match wire::read_msg_timeout(&mut recv, MAX_FRAME, READ_TIMEOUT).await {
        Ok(Some(Msg::JoinAccepted { accepted })) => {
            if accepted.org.id != challenge.org {
                return Outcome::Refused(JoinReject::new(
                    "invalid_proof",
                    "Laptop rekan mengirim organisasi yang berbeda dari undangan.",
                ));
            }
            Outcome::Accepted(accepted)
        }
        Ok(Some(Msg::JoinRejected { code, message })) => {
            Outcome::Refused(final_reject(&code, &message))
        }
        _ => Outcome::Unreachable,
    }
}

// ----- Client: v0.3 join requests ------------------------------------------

/// Codes a member may answer a join request with
/// (`JoinRequestRefusal::code`). Anything else becomes `invalid_request`.
const REQUEST_REJECT_CODES: [&str; 8] = [
    "not_member",
    "invalid_request",
    "wrong_key",
    "request_expired",
    "team_not_found",
    "removed",
    "busy",
    "rate_limited",
];

fn request_message(code: &str) -> &'static str {
    match code {
        "not_member" => "Laptop rekan ini tidak bisa menerima permintaan bergabung.",
        "wrong_key" => "Permintaan bergabung tidak cocok dengan kunci laptop ini.",
        "request_expired" => "Permintaan bergabung sudah kedaluwarsa. Kirim permintaan baru.",
        "team_not_found" => "Departemen yang dipilih tidak ditemukan.",
        "removed" => "Laptop ini pernah dikeluarkan dari organisasi.",
        "busy" => "Laptop rekan sedang menampung terlalu banyak permintaan. Coba lagi nanti.",
        "rate_limited" => {
            "Terlalu banyak permintaan dari alamat ini. Tunggu satu menit lalu coba lagi."
        }
        "peer_unreachable" => "Laptop di alamat ini tidak bisa dihubungi.",
        "self" => "Alamat ini milik laptop ini sendiri.",
        "invalid_request" => "Permintaan bergabung tidak sah.",
        _ => "Jawaban laptop rekan tidak bisa dipakai.",
    }
}

/// A `JoinRejected` from a member, as shown to the requester: only known
/// codes, the message capped, a local text when the member sent none.
fn request_reject(code: &str, server_message: &str) -> JoinReject {
    if !REQUEST_REJECT_CODES.contains(&code) {
        return bad_answer();
    }
    let msg: String = server_message.chars().take(MAX_MESSAGE_CHARS).collect();
    if msg.trim().is_empty() {
        JoinReject::new(code, request_message(code))
    } else {
        JoinReject::new(code, &msg)
    }
}

fn unreachable() -> JoinReject {
    JoinReject::new("peer_unreachable", request_message("peer_unreachable"))
}

/// The peer answered something this laptop cannot use.
fn bad_answer() -> JoinReject {
    JoinReject::new("invalid_request", request_message("bad_answer"))
}

/// `XXXX-XXXX` in uppercase Crockford base32 (`org_fingerprint_short`).
fn is_short_fingerprint(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 9
        && b[4] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || c.is_ascii_digit() || c.is_ascii_uppercase())
}

/// Shape of a `join_info` answer. The genesis record itself is checked by
/// the caller (`validate_org_record`, `verify_genesis`). The AD fields are
/// not part of it: see [`drop_bad_ad`].
fn check_info(info: &JoinInfoWire) -> bool {
    wire::is_hex_id32(&info.org.id)
        && is_short_fingerprint(&info.fingerprint)
        && info.departments.len() <= MAX_DEPARTMENTS
        && info
            .departments
            .iter()
            .all(|d| wire::is_hex_id32(&d.id) && d.name.chars().count() <= MAX_DEPT_NAME_CHARS)
}

/// Clears `ad_domain` and `ad_ou_map` together unless both are well formed
/// (a normalized domain; at most 100 rows of valid, unique OU names and 32
/// hex team ids). The rest of the answer stays usable: the requester then
/// treats the office as one without AD and sends no claim, which every
/// member takes. Refusing the whole answer instead would also lock out
/// requesters whenever a later Mira widens these formats.
fn drop_bad_ad(info: &mut JoinInfoWire) {
    use crate::permissions::join::{check_ou_map, is_valid_ad_domain};
    let domain_ok = info.ad_domain.as_deref().is_none_or(is_valid_ad_domain);
    let rows: Vec<crate::ad::OuMapping> = info.ad_ou_map.iter().cloned().map(Into::into).collect();
    if !domain_ok || check_ou_map(&rows).is_err() {
        info.ad_domain = None;
        info.ad_ou_map.clear();
    }
}

fn check_request_ok(ok: &JoinRequestOk) -> bool {
    wire::is_hex64(&ok.request_id)
        && !ok.code.is_empty()
        && ok.code.chars().count() <= MAX_CODE_CHARS
        && !ok.code.chars().any(char::is_control)
}

/// Shape of a `join_status_*` answer. `install_approved_org` and
/// `mark_join_rejected` check the contents.
fn check_status(status: &JoinStatusWire) -> bool {
    match status {
        JoinStatusWire::Approved(accepted) => wire::is_hex_id32(&accepted.org.id),
        JoinStatusWire::Rejected { by_name, at, .. } => {
            by_name.chars().count() <= MAX_DEPT_NAME_CHARS && at.len() <= 64
        }
        JoinStatusWire::Pending | JoinStatusWire::Unknown => true,
    }
}

/// One session on the join ALPN: connects to `addr`, sends `msg`, reads one
/// answer of at most `max` bytes. Returns the key the peer proved and its
/// answer. `JoinRejected` is turned into an error here.
async fn ask(
    inner: &Arc<Inner>,
    addr: SocketAddr,
    msg: Msg,
    max: usize,
) -> Result<(String, Msg), JoinReject> {
    if inner.own_addresses().contains(&addr) {
        return Err(JoinReject::new("peer_unreachable", request_message("self")));
    }
    if !route::is_dialable(&addr) {
        return Err(unreachable());
    }
    let answer = tokio::time::timeout(REQUEST_TOTAL_TIMEOUT, ask_inner(inner, addr, msg, max))
        .await
        .unwrap_or_else(|_| Err(unreachable()))?;
    match answer {
        (_, Msg::JoinRejected { code, message }) => Err(request_reject(&code, &message)),
        other => Ok(other),
    }
}

async fn ask_inner(
    inner: &Arc<Inner>,
    addr: SocketAddr,
    msg: Msg,
    max: usize,
) -> Result<(String, Msg), JoinReject> {
    let connecting = inner
        .endpoint
        .connect_with(inner.join_client.clone(), addr, SERVER_NAME)
        .map_err(|_| unreachable())?;
    let conn = match tokio::time::timeout(CONNECT_TIMEOUT.min(HANDSHAKE_TIMEOUT), connecting).await
    {
        Ok(Ok(c)) => c,
        _ => return Err(unreachable()),
    };
    let result = match tls::peer_public_key(&conn) {
        Some(pk) if pk == inner.me => {
            Err(JoinReject::new("peer_unreachable", request_message("self")))
        }
        Some(pk) => exchange(&conn, &msg, max).await.map(|m| (pk, m)),
        None => Err(unreachable()),
    };
    conn.close(VarInt::from_u32(code::NORMAL), b"done");
    result
}

async fn exchange(conn: &Connection, msg: &Msg, max: usize) -> Result<Msg, JoinReject> {
    let Ok(Ok((mut send, mut recv))) = tokio::time::timeout(READ_TIMEOUT, conn.open_bi()).await
    else {
        return Err(unreachable());
    };
    wire::write_msg_timeout(&mut send, msg, WRITE_TIMEOUT)
        .await
        .map_err(|_| unreachable())?;
    let _ = send.finish();
    match wire::read_msg_timeout(&mut recv, max, READ_TIMEOUT).await {
        Ok(Some(answer)) => Ok(answer),
        // The peer spoke, but not something this laptop can use.
        Err(wire::WireError::TooLarge(_) | wire::WireError::Malformed(_)) => Err(bad_answer()),
        Ok(None) | Err(_) => Err(unreachable()),
    }
}

/// `join_info_get` to the laptop at `addr`.
pub(crate) async fn info_at(
    inner: &Arc<Inner>,
    addr: SocketAddr,
) -> Result<(String, JoinInfoWire), JoinReject> {
    match ask(inner, addr, Msg::JoinInfoGet, MAX_JOIN_FRAME).await? {
        (pk, Msg::JoinInfo { mut info }) if check_info(&info) => {
            drop_bad_ad(&mut info);
            Ok((pk, info))
        }
        _ => Err(bad_answer()),
    }
}

/// `join_request` with this laptop's signed request to the member at `addr`.
pub(crate) async fn request_at(
    inner: &Arc<Inner>,
    addr: SocketAddr,
    request: JoinRequestWire,
) -> Result<(String, JoinRequestOk), JoinReject> {
    match ask(inner, addr, Msg::JoinRequest { request }, MAX_JOIN_FRAME).await? {
        (pk, Msg::JoinRequestOk { request_id, code }) => {
            let ok = JoinRequestOk { request_id, code };
            if check_request_ok(&ok) {
                Ok((pk, ok))
            } else {
                Err(bad_answer())
            }
        }
        _ => Err(bad_answer()),
    }
}

/// `join_status_get` for `request_id` to the member at `addr`. Reads up to
/// `MAX_FRAME`: an approval carries the organization's log.
pub(crate) async fn status_at(
    inner: &Arc<Inner>,
    addr: SocketAddr,
    request_id: &str,
) -> Result<(String, JoinStatusWire), JoinReject> {
    if !wire::is_hex64(request_id) {
        return Err(bad_answer());
    }
    let msg = Msg::JoinStatusGet {
        request_id: request_id.to_owned(),
    };
    let (pk, answer) = ask(inner, addr, msg, MAX_FRAME).await?;
    let status = match answer {
        Msg::JoinStatusPending => JoinStatusWire::Pending,
        Msg::JoinStatusApproved { accepted } => JoinStatusWire::Approved(accepted),
        Msg::JoinStatusRejected { by_name, at, op } => JoinStatusWire::Rejected { by_name, at, op },
        Msg::JoinStatusUnknown => JoinStatusWire::Unknown,
        _ => return Err(bad_answer()),
    };
    if !check_status(&status) {
        return Err(bad_answer());
    }
    Ok((pk, status))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_count_an_ipv6_slash_64_as_one_address() {
        let a: IpAddr = "fd00:1:2:3:aaaa::1".parse().unwrap();
        let b: IpAddr = "fd00:1:2:3:bbbb::9".parse().unwrap();
        let other: IpAddr = "fd00:1:2:4::1".parse().unwrap();
        assert_eq!(limit_key(a), limit_key(b));
        assert_ne!(limit_key(a), limit_key(other));
        let v4: IpAddr = [192, 168, 1, 20].into();
        assert_eq!(limit_key(v4), v4);
        let mapped: IpAddr = "::ffff:192.168.1.20".parse().unwrap();
        assert_eq!(limit_key(mapped), v4);
        // A host rotating addresses inside its /64 hits the per-address limit.
        let mut l = RateLimiter::new(JOIN_ATTEMPTS_PER_MINUTE, Duration::from_secs(60));
        let t0 = Instant::now();
        for i in 0..JOIN_ATTEMPTS_PER_MINUTE as u16 {
            let ip = IpAddr::V6(std::net::Ipv6Addr::new(0xfd00, 1, 2, 3, i, 0, 0, 1));
            assert!(l.check(limit_key(ip), t0));
        }
        let ip = IpAddr::V6(std::net::Ipv6Addr::new(0xfd00, 1, 2, 3, 999, 0, 0, 1));
        assert!(!l.check(limit_key(ip), t0));
    }

    #[test]
    fn status_limiter_allows_twenty_per_minute_beside_the_join_limiter() {
        let ip: IpAddr = [10, 0, 0, 1].into();
        let t0 = Instant::now();
        let mut status = RateLimiter::new(JOIN_STATUS_PER_MINUTE, Duration::from_secs(60));
        let mut joins = RateLimiter::new(JOIN_ATTEMPTS_PER_MINUTE, Duration::from_secs(60));
        // One poll every 5 seconds fits with room to spare.
        for i in 0..12 {
            assert!(
                status.check(ip, t0 + Duration::from_secs(5 * i)),
                "poll {i}"
            );
        }
        for i in 12..20 {
            assert!(status.check(ip, t0 + Duration::from_secs(59)), "burst {i}");
        }
        assert!(!status.check(ip, t0 + Duration::from_secs(59)));
        // The status budget does not touch the one for the other messages.
        for i in 0..JOIN_ATTEMPTS_PER_MINUTE {
            assert!(joins.check(ip, t0 + Duration::from_secs(59)), "join {i}");
        }
        assert!(!joins.check(ip, t0 + Duration::from_secs(59)));
        // The first poll leaves the window after 60 s.
        assert!(status.check(ip, t0 + Duration::from_secs(60)));
    }

    #[test]
    fn request_reject_codes_are_filtered() {
        for code in REQUEST_REJECT_CODES {
            let r = request_reject(code, "pesan");
            assert_eq!(r.code, code);
            assert_eq!(r.message, "pesan");
            let r = request_reject(code, "  ");
            assert_eq!(r.code, code);
            assert_eq!(r.message, request_message(code));
        }
        for code in [
            "<script>",
            "invite_used",
            "",
            "NOT_MEMBER",
            "peer_unreachable",
        ] {
            let r = request_reject(code, "x");
            assert_eq!(r.code, "invalid_request", "{code}");
            assert_eq!(r.message, request_message("bad_answer"));
        }
        let long = "\u{e9}".repeat(1000);
        assert_eq!(
            request_reject("busy", &long).message.chars().count(),
            MAX_MESSAGE_CHARS
        );
    }

    fn info() -> JoinInfoWire {
        JoinInfoWire {
            org: super::super::OrgRecord {
                id: "a".repeat(32),
                name: "Kantor".into(),
                founder_public_key: "f".repeat(64),
                created_at: "2026-11-22T08:00:00Z".into(),
                genesis_signature: "0".repeat(128),
            },
            fingerprint: "AB12-CD34".into(),
            departments: vec![super::super::JoinDept {
                id: "1".repeat(32),
                name: "Keuangan".into(),
            }],
            extras: super::super::JOIN_INFO_EXTRAS,
            ad_domain: None,
            ad_ou_map: Vec::new(),
        }
    }

    #[test]
    fn join_info_extras_is_optional_both_ways() {
        // v0.4 writes `extras` only when set.
        let v04 = serde_json::to_value(info()).unwrap();
        assert_eq!(v04["extras"], 1);
        let v03_shape = JoinInfoWire {
            extras: 0,
            ..info()
        };
        let v03 = serde_json::to_value(&v03_shape).unwrap();
        assert!(v03.get("extras").is_none());
        // A v0.3 answer (no field) parses as 0.
        let parsed: JoinInfoWire = serde_json::from_value(v03).unwrap();
        assert_eq!(parsed, v03_shape);
        // What a v0.3 laptop parses: the same struct without the field and
        // without `deny_unknown_fields`, so the v0.4 answer still parses.
        #[derive(serde::Deserialize)]
        #[allow(dead_code)]
        struct V03Info {
            org: super::super::OrgRecord,
            fingerprint: String,
            departments: Vec<super::super::JoinDept>,
        }
        assert!(serde_json::from_value::<V03Info>(v04.clone()).is_ok());
        // And through the frame decoder.
        let frame = serde_json::to_vec(&wire::Msg::JoinInfo { info: info() }).unwrap();
        match wire::decode(&frame).unwrap() {
            wire::Msg::JoinInfo { info: i } => assert_eq!(i.extras, 1),
            other => panic!("{other:?}"),
        }
        let mut old = serde_json::to_value(wire::Msg::JoinInfo { info: info() }).unwrap();
        old["info"].as_object_mut().unwrap().remove("extras");
        match wire::decode(&serde_json::to_vec(&old).unwrap()).unwrap() {
            wire::Msg::JoinInfo { info: i } => assert_eq!(i.extras, 0),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn join_info_shape_is_checked() {
        assert!(check_info(&info()));
        let mut i = info();
        i.departments.clear();
        assert!(check_info(&i), "no departments is fine");

        let bad: [fn(&mut JoinInfoWire); 7] = [
            |i| i.org.id = "A".repeat(32),
            |i| i.org.id = "a".repeat(31),
            |i| i.fingerprint = "AB12CD34".into(),
            |i| i.fingerprint = "ab12-cd34".into(),
            |i| i.departments[0].id = "x".into(),
            |i| i.departments[0].name = "n".repeat(MAX_DEPT_NAME_CHARS + 1),
            |i| {
                let d = i.departments[0].clone();
                i.departments = vec![d; MAX_DEPARTMENTS + 1];
            },
        ];
        for (n, spoil) in bad.iter().enumerate() {
            let mut i = info();
            spoil(&mut i);
            assert!(!check_info(&i), "case {n}");
        }
        let mut i = info();
        i.departments[0].name = "\u{e9}".repeat(MAX_DEPT_NAME_CHARS);
        assert!(check_info(&i), "the name limit counts characters");
    }

    fn ad_row(ou: &str) -> super::super::OuMapWire {
        super::super::OuMapWire {
            ou: ou.into(),
            team: "1".repeat(32),
        }
    }

    #[test]
    fn bad_ad_fields_are_dropped_together() {
        let with_ad = || JoinInfoWire {
            extras: super::super::JOIN_INFO_EXTRAS_AD,
            ad_domain: Some("biro.co.id".into()),
            ad_ou_map: vec![ad_row("Desain"), ad_row("Kantor Pusat")],
            ..info()
        };
        let mut i = with_ad();
        drop_bad_ad(&mut i);
        assert_eq!(i, with_ad(), "well formed: kept");
        let full: Vec<_> = (0..100).map(|n| ad_row(&format!("OU {n}"))).collect();
        let mut i = JoinInfoWire {
            ad_ou_map: full.clone(),
            ..with_ad()
        };
        drop_bad_ad(&mut i);
        assert_eq!(i.ad_ou_map, full);

        let bad: [fn(&mut JoinInfoWire); 7] = [
            |i| i.ad_domain = Some("Biro.co.id".into()),
            |i| i.ad_domain = Some("biro".into()),
            |i| i.ad_ou_map[0].team = "x".into(),
            |i| i.ad_ou_map[0].ou = String::new(),
            |i| i.ad_ou_map[1].ou = "desain".into(),
            |i| i.ad_ou_map[0].ou = "Desa\u{202E}in".into(),
            |i| i.ad_ou_map = (0..101).map(|n| ad_row(&format!("OU {n}"))).collect(),
        ];
        for (n, spoil) in bad.iter().enumerate() {
            let mut i = with_ad();
            spoil(&mut i);
            assert!(check_info(&i), "case {n}: the rest is still usable");
            drop_bad_ad(&mut i);
            assert_eq!(i.ad_domain, None, "case {n}");
            assert!(i.ad_ou_map.is_empty(), "case {n}");
            assert_eq!(i.extras, super::super::JOIN_INFO_EXTRAS_AD);
            assert_eq!(i.departments, info().departments);
        }
    }

    #[test]
    fn a_full_ou_map_fits_the_join_frame() {
        // 100 rows of 64 four-byte characters and 50 departments of 60.
        let ou_map: Vec<_> = (0..100)
            .map(|n| ad_row(&format!("{n:03}{}", "\u{1F3E2}".repeat(61))))
            .collect();
        let departments = (0..50)
            .map(|n| super::super::JoinDept {
                id: format!("{n:032x}"),
                name: "\u{1F3E2}".repeat(60),
            })
            .collect();
        let big = JoinInfoWire {
            departments,
            ad_domain: Some("biro.co.id".into()),
            ad_ou_map: ou_map,
            ..info()
        };
        let frame = serde_json::to_vec(&Msg::JoinInfo { info: big.clone() }).unwrap();
        assert!(frame.len() < MAX_JOIN_FRAME, "{} bytes", frame.len());
        // The member drops the mapping when the answer is too large to be
        // read safely; the rest stays.
        let mut huge = JoinInfoWire {
            departments: (0..200)
                .map(|n| super::super::JoinDept {
                    id: format!("{n:032x}"),
                    name: "\u{1F3E2}".repeat(60),
                })
                .collect(),
            ..big.clone()
        };
        crate::net_backend::fit_join_info(&mut huge);
        assert!(huge.ad_ou_map.is_empty());
        assert_eq!(huge.ad_domain.as_deref(), Some("biro.co.id"));
        let mut kept = big.clone();
        crate::net_backend::fit_join_info(&mut kept);
        assert_eq!(kept, big);
    }

    #[test]
    fn join_request_ok_shape_is_checked() {
        let ok = |id: String, code: &str| JoinRequestOk {
            request_id: id,
            code: code.into(),
        };
        assert!(check_request_ok(&ok("b".repeat(64), "ABCD EFGH")));
        assert!(!check_request_ok(&ok("b".repeat(63), "ABCD EFGH")));
        assert!(!check_request_ok(&ok("B".repeat(64), "ABCD EFGH")));
        assert!(!check_request_ok(&ok("b".repeat(64), "")));
        assert!(!check_request_ok(&ok("b".repeat(64), &"A".repeat(17))));
        assert!(!check_request_ok(&ok("b".repeat(64), "AB\nCD")));
    }

    #[test]
    fn join_status_shape_is_checked() {
        let accepted = |id: String| {
            JoinStatusWire::Approved(JoinAccepted {
                org: super::super::OrgRecord { id, ..info().org },
                ops: vec![],
            })
        };
        assert!(check_status(&accepted("a".repeat(32))));
        assert!(!check_status(&accepted("zz".into())));
        let rejected = |name: String| JoinStatusWire::Rejected {
            by_name: name,
            at: "2026-11-23T08:00:00Z".into(),
            op: super::super::WireOp {
                payload: "{}".into(),
                sig: "0".repeat(128),
            },
        };
        assert!(check_status(&rejected("Sari".into())));
        assert!(!check_status(&rejected(
            "n".repeat(MAX_DEPT_NAME_CHARS + 1)
        )));
        assert!(check_status(&JoinStatusWire::Pending));
        assert!(check_status(&JoinStatusWire::Unknown));
    }

    #[test]
    fn limiter_allows_ten_per_minute_per_ip() {
        let mut l = RateLimiter::new(10, Duration::from_secs(60));
        let ip: IpAddr = [10, 0, 0, 1].into();
        let other: IpAddr = [10, 0, 0, 2].into();
        let t0 = Instant::now();
        for i in 0..10 {
            assert!(l.check(ip, t0 + Duration::from_secs(i)), "attempt {i}");
        }
        assert!(!l.check(ip, t0 + Duration::from_secs(10)));
        assert!(l.check(other, t0 + Duration::from_secs(10)));
        // The first attempt leaves the window after 60 s.
        assert!(l.check(ip, t0 + Duration::from_secs(60)));
        assert!(!l.check(ip, t0 + Duration::from_secs(60)));
    }

    #[test]
    fn unknown_reject_codes_are_not_passed_through() {
        let r = final_reject("<script>", "x");
        assert_eq!(r.code, "invalid_proof");
        let r = final_reject("invite_expired", "");
        assert_eq!(r.code, "invite_expired");
        assert!(!r.message.is_empty());
        let long = "a".repeat(1000);
        assert_eq!(final_reject("invite_used", &long).message.len(), 300);
    }
}
