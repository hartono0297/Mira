//! Redeeming an invite code over the `mira-join/1` ALPN (plan 2.4).
//!
//! Server side (a member's laptop): one `JoinHello`, then `JoinChallenge` or
//! `JoinRejected`, then one `JoinProof`, then `JoinAccepted` or
//! `JoinRejected`. Nothing else is served on this ALPN. Attempts are limited
//! per remote IP.

use std::collections::{HashMap, HashSet, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use quinn::{Connection, VarInt};

use super::node::{HANDSHAKE_TIMEOUT, Inner, READ_TIMEOUT, WRITE_TIMEOUT, code, lock};
use super::route;
use super::tls::{self, SERVER_NAME};
use super::wire::{self, MAX_FRAME, MAX_JOIN_FRAME, Msg};
use super::{JoinAccepted, JoinChallenge, JoinReject, ProveFn};

pub(crate) const JOIN_ATTEMPTS_PER_MINUTE: usize = 10;
pub(crate) const MAX_CONCURRENT_JOINS: usize = 16;
/// Whole `Network::join` call.
const JOIN_TOTAL_TIMEOUT: Duration = Duration::from_secs(20);
/// How long to wait for mDNS to find someone when no address is known.
const MDNS_WAIT: Duration = Duration::from_secs(3);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Server keeps the connection open this long for the client to read the
/// final answer and close.
const FINAL_LINGER: Duration = Duration::from_secs(5);
/// Remote IPs tracked by a limiter before old entries are dropped.
const MAX_TRACKED_IPS: usize = 4096;

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
    let Ok(_slot) = inner.join_slots.clone().try_acquire_owned() else {
        conn.close(VarInt::from_u32(code::PROTOCOL), b"busy");
        return;
    };
    let remote = conn.remote_address();
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
    let Ok(Some(Msg::JoinHello { tag })) =
        wire::read_msg_timeout(&mut recv, MAX_JOIN_FRAME, READ_TIMEOUT).await
    else {
        return None;
    };

    let allowed = lock(&inner.join_limiter).check(remote.ip(), Instant::now());
    let first = if !allowed {
        inner.log_rejection(
            Some(client_pk),
            Some(remote),
            "rate_limited",
            "Terlalu banyak percobaan bergabung dari alamat ini.",
        );
        reject(
            "rate_limited",
            "Terlalu banyak percobaan bergabung. Tunggu satu menit lalu coba lagi.",
        )
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
    /// Stop and report this.
    Final(JoinReject),
    NotFound,
    RateLimited,
    Unreachable,
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
    let mut prove = Some(prove);
    let mut tried: HashSet<SocketAddr> = HashSet::new();
    let own = inner.own_addresses();
    let mdns_deadline = Instant::now() + MDNS_WAIT;
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
            match attempt(inner, addr, tag, &mut prove).await {
                Outcome::Accepted(a) => return Ok(a),
                Outcome::Final(r) => return Err(r),
                Outcome::NotFound => saw_not_found = true,
                Outcome::RateLimited => saw_rate_limited = true,
                Outcome::Unreachable => {}
            }
        }
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

async fn attempt(
    inner: &Arc<Inner>,
    addr: SocketAddr,
    tag: &str,
    prove: &mut Option<ProveFn>,
) -> Outcome {
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
        Some(pk) if pk != inner.me => session(&conn, tag, prove).await,
        _ => Outcome::Unreachable,
    };
    conn.close(VarInt::from_u32(code::NORMAL), b"done");
    outcome
}

async fn session(conn: &Connection, tag: &str, prove: &mut Option<ProveFn>) -> Outcome {
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
                _ => Outcome::Final(final_reject(&code, &message)),
            };
        }
        _ => return Outcome::Unreachable,
    };
    let Some(prove) = prove.take() else {
        return Outcome::Final(JoinReject::new(
            "invalid_proof",
            local_message("invalid_proof"),
        ));
    };
    let proof = match prove(&challenge) {
        Ok(p) => p,
        Err(e) => return Outcome::Final(JoinReject::new("invalid_proof", &e)),
    };
    if wire::write_msg_timeout(&mut send, &Msg::JoinProof { proof }, WRITE_TIMEOUT)
        .await
        .is_err()
    {
        return Outcome::Final(JoinReject::new(
            "no_peer_found",
            local_message("no_peer_found"),
        ));
    }
    let _ = send.finish();
    match wire::read_msg_timeout(&mut recv, MAX_FRAME, READ_TIMEOUT).await {
        Ok(Some(Msg::JoinAccepted { accepted })) => {
            if accepted.org.id != challenge.org {
                return Outcome::Final(JoinReject::new(
                    "invalid_proof",
                    "Laptop rekan mengirim organisasi yang berbeda dari undangan.",
                ));
            }
            Outcome::Accepted(accepted)
        }
        Ok(Some(Msg::JoinRejected { code, message })) => {
            Outcome::Final(final_reject(&code, &message))
        }
        _ => Outcome::Final(JoinReject::new(
            "no_peer_found",
            local_message("no_peer_found"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
