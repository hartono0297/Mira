//! Network tests over real QUIC on loopback, with `MemoryBackend`.
//! mDNS is off; peers dial each other through `known_addresses`.

use std::collections::HashSet;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ed25519_dalek::SigningKey;
use zeroize::Zeroizing;

use super::testing::{MemoryBackend, op};
use super::*;

const ORG: &str = "0123456789abcdef0123456789abcdef";
const OTHER_ORG: &str = "fedcba9876543210fedcba9876543210";
const TAG: &str = "ABCD2345";

fn pk_of(seed: u8) -> String {
    hex::encode(
        SigningKey::from_bytes(&[seed; 32])
            .verifying_key()
            .as_bytes(),
    )
}

struct Node {
    net: Network,
    backend: Arc<MemoryBackend>,
    pk: String,
    addr: SocketAddr,
    events: Arc<Mutex<Vec<NetEvent>>>,
}

impl Node {
    fn connected_to(&self, other: &Node) -> bool {
        self.net.connected_peers().contains(&other.pk)
    }

    fn count(&self, ev: NetEvent) -> usize {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| **e == ev)
            .count()
    }
}

async fn node(seed: u8, org: Option<&str>) -> Node {
    let backend = Arc::new(MemoryBackend::new(org));
    node_with(seed, backend).await
}

async fn node_with(seed: u8, backend: Arc<MemoryBackend>) -> Node {
    let pk = pk_of(seed);
    let events: Arc<Mutex<Vec<NetEvent>>> = Arc::default();
    let rec = events.clone();
    let net = Network::start(
        NetConfig {
            identity_secret: Zeroizing::new([seed; 32]),
            public_key: pk.clone(),
            port: Some(0),
            mdns_enabled: false,
        },
        backend.clone(),
        Arc::new(move |e| rec.lock().unwrap().push(e)),
    )
    .await
    .expect("network starts");
    let port = net.status().listen_port.expect("listening");
    Node {
        net,
        backend,
        pk,
        addr: SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
        events,
    }
}

/// Two nodes in `ORG` that know each other as members.
async fn pair(a: u8, b: u8) -> (Node, Node) {
    let na = node(a, Some(ORG)).await;
    let nb = node(b, Some(ORG)).await;
    na.backend.add_member(&nb.pk);
    nb.backend.add_member(&na.pk);
    (na, nb)
}

async fn wait_for(what: &str, cond: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for: {what}");
}

async fn connect(a: &Node, b: &Node) {
    a.backend.know(Some(&b.pk), b.addr);
    a.net.refresh();
    wait_for("connection both ways", || {
        a.connected_to(b) && b.connected_to(a)
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn members_connect_and_sync_both_ways() {
    let (a, b) = pair(11, 12).await;
    let op1 = a.backend.add_op(op("{\"n\":1}"));
    let op2 = b.backend.add_op(op("{\"n\":2}"));

    connect(&a, &b).await;
    wait_for("both have both ops", || {
        a.backend.has_op(&op2) && b.backend.has_op(&op1)
    })
    .await;

    // Status: connected over loopback counts as LAN.
    let st = a.net.status();
    assert_eq!(st.state, NetState::Lan);
    assert_eq!(st.peers.len(), 1);
    assert_eq!(st.peers[0].public_key, b.pk);
    assert_eq!(st.peers[0].route, Route::Local);
    assert!(a.count(NetEvent::StatusChanged) >= 1);
    wait_for("OrgChanged on both", || {
        a.count(NetEvent::OrgChanged) >= 1 && b.count(NetEvent::OrgChanged) >= 1
    })
    .await;

    // Addresses proven by the connection are remembered.
    assert!(a.backend.with(|s| {
        s.remembered.iter().any(|(pk, addr, src)| {
            *pk == b.pk && *addr == b.addr && *src == AddressSource::Outgoing
        })
    }));
    assert!(b.backend.with(|s| {
        s.remembered
            .iter()
            .any(|(pk, _, src)| *pk == a.pk && *src == AddressSource::Incoming)
    }));
    // Dial result reported for the known address.
    wait_for("dial result reported", || {
        a.backend.with(|s| {
            s.manual
                .iter()
                .any(|(addr, r)| *addr == b.addr && r.as_deref() == Ok(b.pk.as_str()))
        })
    })
    .await;

    // A later op travels too (refresh triggers sync).
    let op3 = a.backend.add_op(op("{\"n\":3}"));
    a.net.refresh();
    wait_for("op3 reaches b", || b.backend.has_op(&op3)).await;

    a.net.shutdown().await;
    wait_for("b sees a go away", || !b.connected_to(&a)).await;
    b.net.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn non_member_is_refused_and_logged() {
    let a = node(21, Some(ORG)).await;
    let c = node(23, Some(ORG)).await;
    // c thinks a is a member, a does not know c.
    c.backend.add_member(&a.pk);
    c.backend.know(Some(&a.pk), a.addr);
    c.net.refresh();

    wait_for("a logs the rejection", || {
        a.backend.with(|s| {
            s.rejections
                .iter()
                .any(|(pk, _, code)| pk.as_deref() == Some(c.pk.as_str()) && code == "not_member")
        })
    })
    .await;
    wait_for("c records the failed attempt", || {
        c.backend.with(|s| {
            s.manual
                .iter()
                .any(|(addr, r)| *addr == a.addr && r.is_err())
        })
    })
    .await;
    assert!(a.net.connected_peers().is_empty());
    assert!(c.net.connected_peers().is_empty());
    // Nothing was synced to the stranger.
    assert!(a.backend.with(|s| s.served.is_empty()));
}

#[tokio::test(flavor = "multi_thread")]
async fn listener_refuses_a_dialer_it_does_not_know() {
    // The non-member is the listener this time: a dials c, c is unknown to a.
    let a = node(24, Some(ORG)).await;
    let c = node(25, Some(ORG)).await;
    a.backend.add_member(&c.pk);
    // a lists c as member but c does not know a: c must refuse.
    a.backend.know(Some(&c.pk), c.addr);
    a.net.refresh();
    wait_for("c logs a as not a member", || {
        c.backend.with(|s| {
            s.rejections
                .iter()
                .any(|(pk, _, code)| pk.as_deref() == Some(a.pk.as_str()) && code == "not_member")
        })
    })
    .await;
    assert!(c.net.connected_peers().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn removed_peer_receives_removed_then_is_disconnected() {
    let (a, b) = pair(31, 32).await;
    connect(&a, &b).await;

    let removal = op("{\"type\":\"member_remove\"}");
    let removal_id = super::wire::op_id(&removal);
    a.backend.with(|s| {
        s.auth.insert(
            b.pk.clone(),
            PeerAuth::Removed {
                removal: Some(removal.clone()),
            },
        )
    });
    // b's backend learns it was removed when it ingests the op.
    let a_pk = a.pk.clone();
    b.backend.with(|s| {
        s.on_ingest = Some(Box::new(move |s, _from, ops| {
            if ops.iter().any(|o| o.payload.contains("member_remove")) {
                s.org = None;
                s.auth.remove(&a_pk);
            }
        }))
    });
    a.net.refresh();

    wait_for("b ingests the removal op from a", || {
        b.backend.with(|s| {
            s.ingested
                .iter()
                .any(|(from, ids)| *from == a.pk && ids.contains(&removal_id))
        })
    })
    .await;
    wait_for("both sides disconnected", || {
        !a.connected_to(&b) && !b.connected_to(&a)
    })
    .await;
    assert!(a.backend.with(|s| {
        s.rejections
            .iter()
            .any(|(pk, _, code)| pk.as_deref() == Some(b.pk.as_str()) && code == "removed_member")
    }));
    assert_eq!(b.net.status().state, NetState::NoOrg);
}

#[tokio::test(flavor = "multi_thread")]
async fn removed_peer_dialing_in_gets_removed_op() {
    let (a, b) = pair(33, 34).await;
    let removal = op("{\"type\":\"member_remove\",\"x\":2}");
    let removal_id = super::wire::op_id(&removal);
    a.backend.with(|s| {
        s.auth.insert(
            b.pk.clone(),
            PeerAuth::Removed {
                removal: Some(removal.clone()),
            },
        )
    });
    b.backend.know(Some(&a.pk), a.addr);
    b.net.refresh();
    wait_for("b ingests the removal op", || {
        b.backend.with(|s| {
            s.ingested
                .iter()
                .any(|(from, ids)| *from == a.pk && ids.contains(&removal_id))
        })
    })
    .await;
    wait_for("b's dial is reported as failed", || {
        b.backend.with(|s| {
            s.manual
                .iter()
                .any(|(addr, r)| *addr == a.addr && r.is_err())
        })
    })
    .await;
    assert!(!a.connected_to(&b));
}

#[tokio::test(flavor = "multi_thread")]
async fn dialer_expecting_another_key_refuses() {
    let (a, b) = pair(41, 42).await;
    let x = pk_of(43);
    a.backend.add_member(&x);
    // a remembers b's address as belonging to x.
    a.backend.know(Some(&x), b.addr);
    a.net.refresh();
    wait_for("a logs unexpected_peer", || {
        a.backend.with(|s| {
            s.rejections.iter().any(|(pk, addr, code)| {
                pk.as_deref() == Some(b.pk.as_str())
                    && *addr == Some(b.addr)
                    && code == "unexpected_peer"
            })
        })
    })
    .await;
    assert!(!a.connected_to(&b));
    assert!(!b.connected_to(&a));
    // The wrong mapping was not stored as remembered for b.
    assert!(a.backend.with(|s| s.remembered.is_empty()));
}

#[tokio::test(flavor = "multi_thread")]
async fn only_ops_the_backend_offers_are_delivered() {
    let (a, b) = pair(51, 52).await;
    let visible = a.backend.add_op(op("{\"team\":\"a\"}"));
    let hidden1 = a.backend.add_op(op("{\"team\":\"b\"}"));
    let hidden2 = a.backend.add_op(op("{\"team\":\"c\"}"));
    a.backend.with(|s| {
        s.visible
            .insert(b.pk.clone(), HashSet::from([visible.clone()]))
    });

    connect(&a, &b).await;
    wait_for("visible op arrives", || b.backend.has_op(&visible)).await;
    // More sync rounds must not leak anything.
    a.net.refresh();
    b.net.refresh();
    tokio::time::sleep(Duration::from_millis(800)).await;

    assert!(!b.backend.has_op(&hidden1));
    assert!(!b.backend.has_op(&hidden2));
    let served: HashSet<String> = a.backend.with(|s| {
        s.served
            .iter()
            .filter(|(peer, _)| *peer == b.pk)
            .flat_map(|(_, ids)| ids.clone())
            .collect()
    });
    let received: HashSet<String> = b.backend.with(|s| {
        s.ingested
            .iter()
            .filter(|(from, _)| *from == a.pk)
            .flat_map(|(_, ids)| ids.clone())
            .collect()
    });
    assert!(received.is_subset(&served), "{received:?} vs {served:?}");
    assert_eq!(received, HashSet::from([visible]));
}

#[tokio::test(flavor = "multi_thread")]
async fn new_ops_gossip_to_other_peers() {
    let a = node(61, Some(ORG)).await;
    let b = node(62, Some(ORG)).await;
    let c = node(63, Some(ORG)).await;
    for (x, y) in [(&a, &b), (&b, &c), (&a, &c)] {
        x.backend.add_member(&y.pk);
        y.backend.add_member(&x.pk);
    }
    // a only knows b, c only knows b.
    connect(&a, &b).await;
    connect(&c, &b).await;
    let id = a.backend.add_op(op("{\"gossip\":1}"));
    a.net.refresh();
    wait_for("op reaches c through b", || c.backend.has_op(&id)).await;
    assert!(!a.connected_to(&c));
}

#[tokio::test(flavor = "multi_thread")]
async fn org_mismatch_in_hello_is_refused() {
    let a = node(71, Some(ORG)).await;
    let b = node(72, Some(OTHER_ORG)).await;
    a.backend.add_member(&b.pk);
    b.backend.add_member(&a.pk);
    a.backend.know(Some(&b.pk), b.addr);
    a.net.refresh();
    wait_for("org mismatch logged", || {
        a.backend
            .with(|s| s.rejections.iter().any(|(_, _, c)| c == "org_mismatch"))
            || b.backend
                .with(|s| s.rejections.iter().any(|(_, _, c)| c == "org_mismatch"))
    })
    .await;
    assert!(!a.connected_to(&b));
}

#[tokio::test(flavor = "multi_thread")]
async fn simultaneous_dials_leave_one_connection() {
    let (a, b) = pair(81, 82).await;
    a.backend.know(Some(&b.pk), b.addr);
    b.backend.know(Some(&a.pk), a.addr);
    a.net.refresh();
    b.net.refresh();
    wait_for("connected", || a.connected_to(&b) && b.connected_to(&a)).await;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(a.connected_to(&b) && b.connected_to(&a));
    let pa = &a.net.status().peers;
    let pb = &b.net.status().peers;
    assert_eq!(pa.len(), 1);
    assert_eq!(pb.len(), 1);
    // Both sides kept the same connection: a sees b's port and b sees a's.
    assert_eq!(pa[0].address.port(), b.addr.port());
    assert_eq!(pb[0].address.port(), a.addr.port());
}

#[tokio::test(flavor = "multi_thread")]
async fn manual_address_without_key_is_tied_to_the_proven_key() {
    let (a, b) = pair(85, 86).await;
    a.backend.know(None, b.addr);
    a.net.refresh();
    wait_for("connected", || a.connected_to(&b)).await;
    assert!(a.backend.with(|s| {
        s.remembered
            .iter()
            .any(|(pk, addr, src)| *pk == b.pk && *addr == b.addr && *src == AddressSource::Manual)
    }));
    // Reported once `dial` returns, slightly after the peer is registered.
    wait_for("manual attempt reported with the proven key", || {
        a.backend.with(|s| {
            s.manual
                .iter()
                .any(|(addr, r)| *addr == b.addr && r.as_deref() == Ok(b.pk.as_str()))
        })
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn status_states() {
    let lonely = node(91, Some(ORG)).await;
    assert_eq!(lonely.net.status().state, NetState::Starting);
    let no_org = node(92, None).await;
    assert_eq!(no_org.net.status().state, NetState::NoOrg);
    let st = lonely.net.status();
    assert!(!st.mdns_ok);
    assert!(st.mdns_error.is_some());
    assert!(st.local_addresses.iter().all(|a| !a.ip().is_loopback()));
}

// ----- Handshake floods ----------------------------------------------------

/// UDP relay between a QUIC client and `server`: forwards every client packet,
/// but only the server packets `pass` lets through. Its server-facing socket
/// is bound on `ip`, which is the address the server sees.
async fn lossy_relay(ip: Ipv4Addr, server: SocketAddr, pass: fn(&[u8]) -> bool) -> SocketAddr {
    let front = Arc::new(
        tokio::net::UdpSocket::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap(),
    );
    let back = Arc::new(tokio::net::UdpSocket::bind((ip, 0)).await.unwrap());
    let front_addr = front.local_addr().unwrap();
    let client: Arc<Mutex<Option<SocketAddr>>> = Arc::default();
    {
        let (front, back, client) = (front.clone(), back.clone(), client.clone());
        tokio::spawn(async move {
            let mut buf = vec![0u8; 65536];
            loop {
                // Windows reports ICMP errors as recv errors: keep going.
                let Ok((n, from)) = front.recv_from(&mut buf).await else {
                    continue;
                };
                *client.lock().unwrap() = Some(from);
                let _ = back.send_to(&buf[..n], server).await;
            }
        });
    }
    tokio::spawn(async move {
        let mut buf = vec![0u8; 65536];
        loop {
            let Ok((n, _)) = back.recv_from(&mut buf).await else {
                continue;
            };
            let to = *client.lock().unwrap();
            if let Some(to) = to
                && pass(&buf[..n])
            {
                let _ = front.send_to(&buf[..n], to).await;
            }
        }
    });
    front_addr
}

/// QUIC v1 long header of type Retry.
fn is_retry_packet(p: &[u8]) -> bool {
    p.first()
        .is_some_and(|b| b & 0x80 != 0 && (b >> 4) & 0x03 == 0x03)
}

/// Starts new handshakes through `relay` without end (about 200 per second);
/// none of them can complete because the relay drops the server's answers.
fn handshake_flood(relay: SocketAddr) -> tokio::task::JoinHandle<()> {
    let id = super::tls::TlsIdentity::new(&[99; 32]).unwrap();
    let cfg = super::tls::client_config(&id, super::tls::ALPN_MEMBER).unwrap();
    let ep = quinn::Endpoint::client(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).unwrap();
    tokio::spawn(async move {
        loop {
            for _ in 0..20 {
                if let Ok(c) = ep.connect_with(cfg.clone(), relay, super::tls::SERVER_NAME) {
                    tokio::spawn(async move {
                        let _ = c.await;
                    });
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
}

/// A device that sends handshake packets (from spoofed or real addresses)
/// and never finishes them must not use up the connection slots: a member
/// still gets in.
async fn member_connects_during_flood(attacker_ip: Ipv4Addr, pass: fn(&[u8]) -> bool) {
    let (a, b) = pair_seeds_for_flood(attacker_ip).await;
    let relay = lossy_relay(attacker_ip, a.addr, pass).await;
    let flood = handshake_flood(relay);
    tokio::time::sleep(Duration::from_millis(2500)).await;
    b.backend.know(Some(&a.pk), a.addr);
    b.net.refresh();
    wait_for("member connects despite the flood", || {
        b.connected_to(&a) && a.connected_to(&b)
    })
    .await;
    flood.abort();
}

async fn pair_seeds_for_flood(attacker_ip: Ipv4Addr) -> (Node, Node) {
    if attacker_ip == Ipv4Addr::LOCALHOST {
        pair(121, 122).await
    } else {
        pair(123, 124).await
    }
}

/// Spoofed handshakes: the server's answers never reach the sender. Answered
/// with a stateless Retry, they cost no slot.
#[tokio::test(flavor = "multi_thread")]
async fn unanswered_handshakes_do_not_lock_out_members() {
    member_connects_during_flood(Ipv4Addr::LOCALHOST, |_| false).await;
}

/// Handshakes from one real address that pass the Retry and then stall are
/// capped per address. The attacker uses 127.0.0.2, the member 127.0.0.1.
#[tokio::test(flavor = "multi_thread")]
async fn stalled_handshakes_from_one_address_do_not_lock_out_members() {
    member_connects_during_flood(Ipv4Addr::new(127, 0, 0, 2), is_retry_packet).await;
}

// ----- Join --------------------------------------------------------------

fn invite() -> JoinChallenge {
    JoinChallenge {
        org: ORG.into(),
        invite: "1".repeat(32),
    }
}

fn good_prove(member: String) -> ProveFn {
    Box::new(move |c: &JoinChallenge| {
        assert_eq!(c.org, ORG);
        Ok(JoinProof {
            member,
            name: "Budi".into(),
            invite_sig: "good".into(),
            member_sig: "good".into(),
        })
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn join_with_correct_code_is_accepted() {
    let a = node(101, Some(ORG)).await;
    a.backend.with(|s| s.invites.insert(TAG.into(), invite()));
    let op_id = a.backend.add_op(op("{\"genesis_follow\":1}"));
    let j = node(102, None).await;

    let accepted = j
        .net
        .join(TAG, vec![a.addr], good_prove(j.pk.clone()))
        .await
        .expect("join accepted");
    assert_eq!(accepted.org.id, ORG);
    assert!(accepted.ops.iter().any(|o| super::wire::op_id(o) == op_id));
    assert!(
        a.backend
            .with(|s| s.join_accepts.iter().any(|(k, _)| *k == j.pk))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn join_with_unknown_tag_is_not_found() {
    let a = node(103, Some(ORG)).await;
    let j = node(104, None).await;
    let err = j
        .net
        .join("ZZZZ9999", vec![a.addr], good_prove(j.pk.clone()))
        .await
        .unwrap_err();
    assert_eq!(err.code, "invite_not_found");
}

#[tokio::test(flavor = "multi_thread")]
async fn join_proof_for_another_key_is_invalid() {
    let a = node(105, Some(ORG)).await;
    a.backend.with(|s| s.invites.insert(TAG.into(), invite()));
    let j = node(106, None).await;
    let err = j
        .net
        .join(TAG, vec![a.addr], good_prove(pk_of(107)))
        .await
        .unwrap_err();
    assert_eq!(err.code, "invalid_proof");
    assert!(a.backend.with(|s| s.join_accepts.is_empty()));
    assert!(a.backend.with(|s| {
        s.rejections
            .iter()
            .any(|(pk, _, code)| pk.as_deref() == Some(j.pk.as_str()) && code == "invalid_proof")
    }));
}

#[tokio::test(flavor = "multi_thread")]
async fn eleventh_join_attempt_in_a_minute_is_rate_limited() {
    let a = node(108, Some(ORG)).await;
    a.backend.with(|s| s.invites.insert(TAG.into(), invite()));
    let j = node(109, None).await;
    for i in 0..10 {
        let err = j
            .net
            .join("ZZZZ9999", vec![a.addr], good_prove(j.pk.clone()))
            .await
            .unwrap_err();
        assert_eq!(err.code, "invite_not_found", "attempt {i}");
    }
    // Even the right code is refused now.
    let err = j
        .net
        .join(TAG, vec![a.addr], good_prove(j.pk.clone()))
        .await
        .unwrap_err();
    assert_eq!(err.code, "rate_limited");
    assert!(a.backend.with(|s| s.join_accepts.is_empty()));
}

#[tokio::test(flavor = "multi_thread")]
async fn join_tries_the_next_peer_after_not_found() {
    let a = node(110, Some(ORG)).await; // does not know the invite
    let b = node(111, Some(ORG)).await;
    b.backend.with(|s| s.invites.insert(TAG.into(), invite()));
    let j = node(112, None).await;
    let accepted = j
        .net
        .join(TAG, vec![a.addr, b.addr], good_prove(j.pk.clone()))
        .await
        .expect("second peer accepts");
    assert_eq!(accepted.org.id, ORG);
}

/// One device cannot hold the join slots with sessions it never starts: the
/// connection over the per-address limit is closed at once.
#[tokio::test(flavor = "multi_thread")]
async fn idle_join_connections_are_capped_per_address() {
    let a = node(126, Some(ORG)).await;
    let id = super::tls::TlsIdentity::new(&[98; 32]).unwrap();
    let cfg = super::tls::client_config(&id, super::tls::ALPN_JOIN).unwrap();
    let ep = quinn::Endpoint::client(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).unwrap();
    let limit = super::join::MAX_JOINS_PER_IP;
    let mut conns = Vec::new();
    for _ in 0..=limit {
        let c = ep
            .connect_with(cfg.clone(), a.addr, super::tls::SERVER_NAME)
            .unwrap()
            .await
            .unwrap();
        conns.push(c);
    }
    tokio::time::sleep(Duration::from_secs(3)).await;
    let closed = conns.iter().filter(|c| c.close_reason().is_some()).count();
    assert_eq!(
        closed,
        1,
        "{closed} of {} idle join connections closed",
        limit + 1
    );
}

/// Any device on the LAN can be a join candidate (mDNS is unauthenticated)
/// and answer what it likes. A lie from one candidate must not end the join
/// while an honest member is still to be tried.
#[tokio::test(flavor = "multi_thread")]
async fn a_lying_candidate_does_not_stop_the_join() {
    // The liar claims the invite expired before any proof is sent.
    let liar = node(127, Some(ORG)).await;
    liar.backend
        .with(|s| s.lookup_reject = Some(JoinReject::new("invite_expired", "bohong")));
    let honest = node(128, Some(ORG)).await;
    honest
        .backend
        .with(|s| s.invites.insert(TAG.into(), invite()));
    let j = node(129, None).await;
    let accepted = j
        .net
        .join(TAG, vec![liar.addr, honest.addr], good_prove(j.pk.clone()))
        .await
        .expect("the honest member accepts");
    assert_eq!(accepted.org.id, ORG);
}

/// A candidate that relays the real challenge, takes the proof and then
/// refuses must not use up the only proof: the same challenge from an honest
/// member gets the same proof.
#[tokio::test(flavor = "multi_thread")]
async fn proof_is_reused_for_the_same_challenge_after_a_refusal() {
    let liar = node(130, Some(ORG)).await;
    liar.backend.with(|s| {
        s.invites.insert(TAG.into(), invite());
        s.accept_reject = Some(JoinReject::new("invalid_proof", "bohong"));
    });
    let honest = node(131, Some(ORG)).await;
    honest
        .backend
        .with(|s| s.invites.insert(TAG.into(), invite()));
    let j = node(132, None).await;
    let accepted = j
        .net
        .join(TAG, vec![liar.addr, honest.addr], good_prove(j.pk.clone()))
        .await
        .expect("the honest member accepts the same proof");
    assert_eq!(accepted.org.id, ORG);
    assert!(
        honest
            .backend
            .with(|s| s.join_accepts.iter().any(|(k, _)| *k == j.pk))
    );
}

/// The only honest answer is still reported when every candidate refuses.
#[tokio::test(flavor = "multi_thread")]
async fn a_refusal_is_reported_when_no_candidate_accepts() {
    let a = node(133, Some(ORG)).await;
    a.backend
        .with(|s| s.lookup_reject = Some(JoinReject::new("invite_used", "sudah dipakai")));
    let b = node(134, Some(ORG)).await; // does not know the invite
    let j = node(135, None).await;
    let err = j
        .net
        .join(TAG, vec![a.addr, b.addr], good_prove(j.pk.clone()))
        .await
        .unwrap_err();
    assert_eq!(err.code, "invite_used");
}

// ----- Join requests (v0.3) ------------------------------------------------

fn org_record() -> OrgRecord {
    OrgRecord {
        id: ORG.into(),
        name: "Kantor".into(),
        founder_public_key: "f".repeat(64),
        created_at: "2026-11-22T08:00:00Z".into(),
        genesis_signature: "0".repeat(128),
    }
}

fn join_info_sample() -> JoinInfoWire {
    JoinInfoWire {
        org: org_record(),
        fingerprint: "ABCD-EF12".into(),
        departments: vec![
            JoinDept {
                id: "1".repeat(32),
                name: "Keuangan".into(),
            },
            JoinDept {
                id: "2".repeat(32),
                name: "Gudang".into(),
            },
        ],
        extras: crate::network::JOIN_INFO_EXTRAS,
        ad_domain: None,
        ad_ou_map: Vec::new(),
        ad_outdated: Some(0),
    }
}

fn join_request_sample() -> JoinRequestWire {
    JoinRequestWire {
        payload: "{\"v\":1,\"kind\":\"join_request\"}".into(),
        sig: "0".repeat(128),
    }
}

/// A member that takes join requests.
async fn join_member(seed: u8) -> Node {
    let a = node(seed, Some(ORG)).await;
    a.backend.with(|s| {
        s.join_info = Some(join_info_sample());
        s.join_request_answer = Some(Ok(JoinRequestOk {
            request_id: "a".repeat(64),
            code: "ABCD EFGH".into(),
        }));
    });
    a
}

/// One raw message on the join ALPN from a throwaway client; the answer, or
/// `None` when the server closes without one.
async fn raw_join(addr: SocketAddr, seed: u8, msg: &super::wire::Msg) -> Option<super::wire::Msg> {
    let id = super::tls::TlsIdentity::new(&[seed; 32]).unwrap();
    let cfg = super::tls::client_config(&id, super::tls::ALPN_JOIN).unwrap();
    let ep = quinn::Endpoint::client(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).unwrap();
    let conn = ep
        .connect_with(cfg, addr, super::tls::SERVER_NAME)
        .unwrap()
        .await
        .unwrap();
    let (mut send, mut recv) = conn.open_bi().await.unwrap();
    super::wire::write_msg(&mut send, msg).await.unwrap();
    let _ = send.finish();
    let got =
        super::wire::read_msg_timeout(&mut recv, super::wire::MAX_FRAME, Duration::from_secs(5))
            .await
            .ok()
            .flatten();
    conn.close(0u32.into(), b"done");
    got
}

#[tokio::test(flavor = "multi_thread")]
async fn join_info_and_request_reach_a_member() {
    let a = join_member(140).await;
    let j = node(141, None).await;

    let (pk, info) = j.net.join_info_at(a.addr).await.expect("join info");
    assert_eq!(pk, a.pk);
    assert_eq!(info, join_info_sample());

    let (pk, ok) = j
        .net
        .join_request_at(a.addr, join_request_sample())
        .await
        .expect("request accepted");
    assert_eq!(pk, a.pk);
    assert_eq!(ok.request_id, "a".repeat(64));
    assert_eq!(ok.code, "ABCD EFGH");
    // The key comes from the handshake and the address from the connection.
    let got = a.backend.with(|s| s.join_requests.clone());
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].0, j.pk);
    assert_eq!(got[0].1, std::net::IpAddr::from(Ipv4Addr::LOCALHOST));
    assert_eq!(got[0].2, join_request_sample());
    wait_for("JoinRequestsChanged", || {
        a.count(NetEvent::JoinRequestsChanged) == 1
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn join_status_answers_every_variant() {
    let a = join_member(142).await;
    let j = node(143, None).await;
    let pending = "1".repeat(64);
    let approved = "2".repeat(64);
    let rejected = "3".repeat(64);
    let unknown = "4".repeat(64);
    // Bigger than MAX_JOIN_FRAME: the org log rides on this answer.
    let ops: Vec<WireOp> = (0..100)
        .map(|i| op(&format!("{{\"n\":{i},\"pad\":\"{}\"}}", "x".repeat(1024))))
        .collect();
    let accepted = JoinAccepted {
        org: org_record(),
        ops,
    };
    assert!(serde_json::to_vec(&accepted).unwrap().len() > super::wire::MAX_JOIN_FRAME);
    let reject_op = op("{\"kind\":\"join_reject\"}");
    a.backend.with(|s| {
        s.join_statuses
            .insert(pending.clone(), JoinStatusWire::Pending);
        s.join_statuses
            .insert(approved.clone(), JoinStatusWire::Approved(accepted.clone()));
        s.join_statuses.insert(
            rejected.clone(),
            JoinStatusWire::Rejected {
                by_name: "Sari".into(),
                at: "2026-11-23T08:00:00Z".into(),
                op: reject_op.clone(),
            },
        );
    });

    let (pk, st) = j.net.join_status_at(a.addr, &pending).await.unwrap();
    assert_eq!(pk, a.pk);
    assert_eq!(st, JoinStatusWire::Pending);
    let (_, st) = j.net.join_status_at(a.addr, &approved).await.unwrap();
    assert_eq!(st, JoinStatusWire::Approved(accepted));
    let (_, st) = j.net.join_status_at(a.addr, &rejected).await.unwrap();
    assert_eq!(
        st,
        JoinStatusWire::Rejected {
            by_name: "Sari".into(),
            at: "2026-11-23T08:00:00Z".into(),
            op: reject_op,
        }
    );
    let (_, st) = j.net.join_status_at(a.addr, &unknown).await.unwrap();
    assert_eq!(st, JoinStatusWire::Unknown);
    assert!(
        a.backend
            .with(|s| s.status_asks.iter().all(|(k, _)| *k == j.pk) && s.status_asks.len() == 4)
    );

    // A malformed id is refused before anything is sent.
    let err = j.net.join_status_at(a.addr, "XYZ").await.unwrap_err();
    assert_eq!(err.code, "invalid_request");
    assert_eq!(a.backend.with(|s| s.status_asks.len()), 4);
}

/// The server checks the id itself, and ends sessions that start with
/// anything other than a join message.
#[tokio::test(flavor = "multi_thread")]
async fn join_server_checks_ids_and_first_messages() {
    use super::wire::Msg;
    let a = join_member(144).await;
    let got = raw_join(
        a.addr,
        97,
        &Msg::JoinStatusGet {
            request_id: "A".repeat(64),
        },
    )
    .await;
    assert_eq!(got, Some(Msg::JoinStatusUnknown));
    assert!(a.backend.with(|s| s.status_asks.is_empty()));

    let got = raw_join(a.addr, 97, &Msg::SyncWant { ids: vec![] }).await;
    assert_eq!(got, None);
    let got = raw_join(a.addr, 97, &Msg::JoinStatusPending).await;
    assert_eq!(got, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn join_refusals_keep_known_codes_only() {
    let a = node(145, Some(ORG)).await; // takes no join requests
    let j = node(146, None).await;
    let err = j.net.join_info_at(a.addr).await.unwrap_err();
    assert_eq!(err.code, "not_member");
    assert!(!err.message.is_empty());

    a.backend
        .with(|s| s.join_request_answer = Some(Err(JoinReject::new("wrong_key", "Kunci beda."))));
    let err = j
        .net
        .join_request_at(a.addr, join_request_sample())
        .await
        .unwrap_err();
    assert_eq!(err.code, "wrong_key");
    assert_eq!(err.message, "Kunci beda.");

    a.backend
        .with(|s| s.join_request_answer = Some(Err(JoinReject::new("<b>aneh</b>", "x"))));
    let err = j
        .net
        .join_request_at(a.addr, join_request_sample())
        .await
        .unwrap_err();
    assert_eq!(err.code, "invalid_request");
    // Refused requests are not announced.
    assert_eq!(a.count(NetEvent::JoinRequestsChanged), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn twenty_first_status_get_in_a_minute_is_rate_limited() {
    let a = join_member(147).await;
    let j = node(148, None).await;
    let id = "5".repeat(64);
    for i in 0..super::join::JOIN_STATUS_PER_MINUTE {
        let (_, st) = j
            .net
            .join_status_at(a.addr, &id)
            .await
            .unwrap_or_else(|e| panic!("status {i}: {e}"));
        assert_eq!(st, JoinStatusWire::Unknown);
    }
    let err = j.net.join_status_at(a.addr, &id).await.unwrap_err();
    assert_eq!(err.code, "rate_limited");
    assert!(!err.message.is_empty());
    assert!(a.backend.with(|s| {
        s.rejections
            .iter()
            .any(|(pk, _, c)| pk.as_deref() == Some(j.pk.as_str()) && c == "rate_limited")
    }));
    // The other join messages have their own budget.
    j.net
        .join_info_at(a.addr)
        .await
        .expect("info still allowed");
}

#[tokio::test(flavor = "multi_thread")]
async fn eleventh_join_info_in_a_minute_is_rate_limited() {
    let a = join_member(149).await;
    let j = node(150, None).await;
    for i in 0..super::join::JOIN_ATTEMPTS_PER_MINUTE {
        j.net
            .join_info_at(a.addr)
            .await
            .unwrap_or_else(|e| panic!("info {i}: {e}"));
    }
    let err = j
        .net
        .join_request_at(a.addr, join_request_sample())
        .await
        .unwrap_err();
    assert_eq!(err.code, "rate_limited");
    assert!(a.backend.with(|s| s.join_requests.is_empty()));
    // Status questions are counted separately.
    j.net
        .join_status_at(a.addr, &"6".repeat(64))
        .await
        .expect("status still allowed");
}

#[tokio::test(flavor = "multi_thread")]
async fn join_requests_skip_self_unreachable_and_no_org_laptops() {
    let j = node(151, None).await;
    // Own address.
    let err = j.net.join_info_at(j.addr).await.unwrap_err();
    assert_eq!(err.code, "peer_unreachable");
    // Not dialable.
    let err = j
        .net
        .join_info_at("[::1]:47800".parse().unwrap())
        .await
        .unwrap_err();
    assert_eq!(err.code, "peer_unreachable");
    // Another instance with this laptop's own key.
    let twin = join_member(151).await;
    let err = j.net.join_info_at(twin.addr).await.unwrap_err();
    assert_eq!(err.code, "peer_unreachable");
    assert!(twin.backend.with(|s| s.join_requests.is_empty()));
    // A laptop without an organization serves nothing.
    let lonely = node(152, None).await;
    lonely
        .backend
        .with(|s| s.join_info = Some(join_info_sample()));
    let err = j.net.join_info_at(lonely.addr).await.unwrap_err();
    assert_eq!(err.code, "peer_unreachable");
    let err = j
        .net
        .join_status_at(lonely.addr, &"7".repeat(64))
        .await
        .unwrap_err();
    assert_eq!(err.code, "peer_unreachable");
}

/// A member may list a loopback address in `Hello` only when it is itself
/// on this machine; otherwise colleagues would dial their own local ports.
#[test]
fn hello_addresses_drop_loopback_from_remote_peers() {
    let addrs: Vec<String> = vec![
        "127.0.0.1:47801".into(),
        "192.168.1.5:47800".into(),
        "0.0.0.0:47800".into(),
        "nonsense".into(),
    ];
    let remote: SocketAddr = "192.168.1.5:47800".parse().unwrap();
    assert_eq!(
        super::node::hello_addresses(&addrs, remote),
        vec!["192.168.1.5:47800".parse::<SocketAddr>().unwrap()]
    );
    let local: SocketAddr = "127.0.0.1:47805".parse().unwrap();
    assert_eq!(super::node::hello_addresses(&addrs, local).len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn laptop_without_org_refuses_everything_and_join_finds_no_peer() {
    let lonely = node(113, None).await;
    let j = node(114, None).await;
    let err = j
        .net
        .join(TAG, vec![lonely.addr], good_prove(j.pk.clone()))
        .await
        .unwrap_err();
    assert_eq!(err.code, "no_peer_found");

    let err = j
        .net
        .join(TAG, vec![], good_prove(j.pk.clone()))
        .await
        .unwrap_err();
    assert_eq!(err.code, "no_peer_found");
}

#[tokio::test(flavor = "multi_thread")]
async fn member_alpn_is_not_served_on_join_and_join_does_not_make_a_member() {
    // A joining laptop that is not a member can only use the join ALPN: a
    // member-ALPN dial to the same laptop is refused.
    let a = node(115, Some(ORG)).await;
    let j = node(116, Some(ORG)).await; // has an org id but a does not know it
    j.backend.add_member(&a.pk);
    j.backend.know(Some(&a.pk), a.addr);
    j.net.refresh();
    wait_for("a refuses j", || {
        a.backend.with(|s| {
            s.rejections
                .iter()
                .any(|(pk, _, c)| pk.as_deref() == Some(j.pk.as_str()) && c == "not_member")
        })
    })
    .await;
    assert!(a.net.connected_peers().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn start_rejects_a_mismatched_public_key() {
    let backend = Arc::new(MemoryBackend::new(Some(ORG)));
    let err = Network::start(
        NetConfig {
            identity_secret: Zeroizing::new([1; 32]),
            public_key: pk_of(2),
            port: Some(0),
            mdns_enabled: false,
        },
        backend,
        Arc::new(|_| {}),
    )
    .await
    .unwrap_err();
    assert!(err.contains("tidak cocok"), "{err}");
}

/// Real mDNS on this machine: two nodes find each other without any known
/// address. Ignored by default because it needs multicast (and may trigger a
/// firewall prompt). Run with `cargo test network::tests::mdns -- --ignored`.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn mdns_discovery_connects_members() {
    async fn mdns_node(seed: u8) -> Node {
        let pk = pk_of(seed);
        let backend = Arc::new(MemoryBackend::new(Some(ORG)));
        let net = Network::start(
            NetConfig {
                identity_secret: Zeroizing::new([seed; 32]),
                public_key: pk.clone(),
                port: Some(0),
                mdns_enabled: true,
            },
            backend.clone(),
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
        let port = net.status().listen_port.unwrap();
        Node {
            net,
            backend,
            pk,
            addr: SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
            events: Arc::default(),
        }
    }
    let a = mdns_node(201).await;
    let b = mdns_node(202).await;
    a.backend.add_member(&b.pk);
    b.backend.add_member(&a.pk);
    assert!(a.net.status().mdns_ok, "{:?}", a.net.status().mdns_error);
    a.net.refresh();
    b.net.refresh();
    wait_for("mDNS connection", || {
        a.connected_to(&b) && b.connected_to(&a)
    })
    .await;
    let via_mdns = |n: &Node, other: &Node| {
        n.backend.with(|s| {
            s.remembered
                .iter()
                .any(|(pk, _, src)| *pk == other.pk && *src == AddressSource::Mdns)
        })
    };
    assert!(via_mdns(&a, &b) || via_mdns(&b, &a));
    a.net.shutdown().await;
    b.net.shutdown().await;
}

// ----- Version gate (v0.3) -----------------------------------------------------

/// A v0.2 laptop sends `Hello` without `features`: it decodes as 1, which
/// is not feature-capable, while `proto` stays 1 so the connection (and
/// membership-log sync) is kept.
#[test]
fn v02_hello_without_features_decodes_as_one() {
    let v02 = format!(
        r#"{{"t":"hello","proto":1,"org":"{ORG}","pk":"{}","listen_port":47800,"addrs":["192.168.1.10:47800"]}}"#,
        "b".repeat(64)
    );
    let Ok(wire::Msg::Hello {
        proto, features, ..
    }) = wire::decode(v02.as_bytes())
    else {
        panic!("a v0.2 hello must decode");
    };
    assert_eq!(proto, wire::PROTO_VERSION);
    assert_eq!(features, 1);
    assert!(!node::feature_capable(features));

    // What v0.3 sends round-trips with its feature version.
    let ours = wire::Msg::Hello {
        proto: wire::PROTO_VERSION,
        org: ORG.into(),
        pk: "b".repeat(64),
        listen_port: 47800,
        addrs: vec![],
        features: wire::FEATURE_PROTO_VERSION,
    };
    let frame = wire::encode(&ours).expect("encodes");
    let Ok(wire::Msg::Hello { features, .. }) = wire::decode(&frame[4..]) else {
        panic!("our hello must decode");
    };
    assert_eq!(features, wire::FEATURE_PROTO_VERSION);
    assert!(node::feature_capable(features));
    // A later version stays capable.
    assert!(node::feature_capable(wire::FEATURE_PROTO_VERSION + 1));
}

// ----- 0.5.1: suspended laptops (docs/plans/perbaikan-bergabung.md) --------

/// An office laptop `a` and a suspended laptop `b` that knows `a`'s
/// address. `a` holds an org op, a team op (`team_ops`, which a suspended
/// peer may not receive) and the suspension op.
struct SuspendedPair {
    a: Node,
    b: Node,
    org_op: String,
    team_op: String,
    suspension: WireOp,
}

async fn suspended_pair(sa: u8, sb: u8) -> SuspendedPair {
    let (a, b) = pair(sa, sb).await;
    let org_op = a.backend.add_op(op("{\"type\":\"team_create\",\"n\":1}"));
    let team_op = a.backend.add_op(op("{\"type\":\"project_create\",\"team\":\"x\"}"));
    let suspension = op(&format!(
        "{{\"type\":\"member_suspend\",\"member\":\"{}\"}}",
        b.pk
    ));
    a.backend.add_op(suspension.clone());
    a.backend.with(|s| s.team_ops.insert(team_op.clone()));
    a.backend.suspend(&b.pk, Some(suspension.clone()));
    b.backend.set_self_suspended(true);
    b.backend.know(Some(&a.pk), a.addr);
    SuspendedPair {
        a,
        b,
        org_op,
        team_op,
        suspension,
    }
}

/// Ids `from`'s backend served to `peer` with `ops_for`.
fn served_to(from: &Node, peer: &Node) -> HashSet<String> {
    from.backend.with(|s| {
        s.served
            .iter()
            .filter(|(p, _)| *p == peer.pk)
            .flat_map(|(_, ids)| ids.clone())
            .collect()
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn suspended_laptop_syncs_org_ops_only_on_an_unlisted_connection() {
    let p = suspended_pair(211, 212).await;
    let (a, b) = (&p.a, &p.b);
    let b_op = b.backend.add_op(op("{\"type\":\"label_create\",\"n\":2}"));
    b.net.refresh();

    wait_for("b gets the org ops", || {
        b.backend.has_op(&p.org_op) && b.backend.has_op(&super::wire::op_id(&p.suspension))
    })
    .await;
    // The office takes what the suspended laptop offers (signed ops the
    // fold checks like any other).
    wait_for("a ingests b's op", || a.backend.has_op(&b_op)).await;
    assert!(a.net.is_linked(&b.pk) && b.net.is_linked(&a.pk));

    // More rounds leak nothing.
    a.net.refresh();
    b.net.refresh();
    tokio::time::sleep(Duration::from_millis(1000)).await;
    assert!(!b.backend.has_op(&p.team_op), "team op reached a suspended laptop");
    assert!(!served_to(a, b).contains(&p.team_op));

    // Neither side lists the limited connection.
    assert!(a.net.connected_peers().is_empty());
    assert!(b.net.connected_peers().is_empty());
    assert!(a.net.status().peers.is_empty());
    assert!(b.net.status().peers.is_empty());
    // A suspended laptop reports no organization of its own.
    assert_eq!(b.net.status().state, NetState::NoOrg);

    // "Periksa lagi": the office syncs back after b's session.
    let reached = b.net.check_membership(Duration::from_secs(4)).await;
    assert_eq!(reached, 1);

    a.net.shutdown().await;
    b.net.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn check_membership_dials_the_office_and_reports_no_one_when_alone() {
    let p = suspended_pair(213, 214).await;
    // No dial before the check: the check itself dials.
    let reached = p.b.net.check_membership(Duration::from_secs(4)).await;
    assert_eq!(reached, 1);
    assert!(p.b.backend.has_op(&p.org_op));

    // Nobody to reach: returns 0 within the limit.
    let lonely = node(215, None).await;
    lonely.backend.with(|s| s.suspended_org = Some(ORG.into()));
    let t = Instant::now();
    assert_eq!(lonely.net.check_membership(Duration::from_millis(600)).await, 0);
    assert!(t.elapsed() < Duration::from_secs(3));
}

#[tokio::test(flavor = "multi_thread")]
async fn member_suspended_while_connected_gets_the_op_then_comes_back_limited_and_reinstated() {
    let (a, b) = pair(221, 222).await;
    b.backend.know(Some(&a.pk), a.addr);
    connect(&a, &b).await;

    let suspension = op(&format!(
        "{{\"type\":\"member_suspend\",\"member\":\"{}\"}}",
        b.pk
    ));
    let suspension_id = super::wire::op_id(&suspension);
    let reinstate = op(&format!(
        "{{\"type\":\"member_reinstate\",\"member\":\"{}\"}}",
        b.pk
    ));
    let reinstate_id = super::wire::op_id(&reinstate);
    // b learns that it is reinstated from the op it ingests. It does not
    // act on the suspension op yet: had it closed the connection itself
    // first, the office's SUSPENDED close would not be seen.
    b.backend.with(|s| {
        s.on_ingest = Some(Box::new(|s, _from, ops| {
            if ops.iter().any(|o| o.payload.contains("member_reinstate"))
                && let Some(org) = s.suspended_org.take()
            {
                s.org = Some(org);
            }
        }))
    });
    a.backend.add_op(suspension.clone());
    a.backend.suspend(&b.pk, Some(suspension.clone()));
    a.net.refresh();

    wait_for("b ingests the pushed suspension op", || {
        b.backend.with(|s| {
            s.ingested
                .iter()
                .any(|(from, ids)| *from == a.pk && ids.contains(&suspension_id))
        })
    })
    .await;
    wait_for("the full connection is gone", || {
        !a.connected_to(&b) && !b.connected_to(&a)
    })
    .await;
    wait_for("b saw the SUSPENDED close", || {
        b.net
            .close_codes_from(&a.pk)
            .contains(&u64::from(node::code::SUSPENDED))
    })
    .await;
    assert!(a.backend.with(|s| {
        s.rejections
            .iter()
            .any(|(pk, _, code)| pk.as_deref() == Some(b.pk.as_str()) && code == "suspended_member")
    }));

    // b now knows it is suspended, keeps dialing and gets a limited
    // connection: new org ops still reach it, but it is not listed.
    b.backend.set_self_suspended(true);
    b.net.refresh();
    let later = a.backend.add_op(op("{\"type\":\"team_create\",\"n\":9}"));
    wait_for("limited connection again", || {
        a.net.is_linked(&b.pk)
            && b.net.is_linked(&a.pk)
            && !a.connected_to(&b)
            && !b.connected_to(&a)
    })
    .await;
    a.net.refresh();
    wait_for("org op reaches the suspended laptop", || b.backend.has_op(&later)).await;
    assert!(!a.connected_to(&b) && !b.connected_to(&a));

    // Reinstated: both sides turn the same connection into a full one,
    // without restarting either node.
    a.backend.add_op(reinstate);
    a.backend.add_member(&b.pk);
    a.net.refresh();
    wait_for("b ingests the reinstate op", || b.backend.has_op(&reinstate_id)).await;
    wait_for("full connection both ways", || {
        a.connected_to(&b) && b.connected_to(&a)
    })
    .await;
    assert_eq!(b.net.status().state, NetState::Lan);

    a.net.shutdown().await;
    b.net.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn removing_a_suspended_laptop_works_like_a_removal() {
    let p = suspended_pair(223, 224).await;
    let (a, b) = (&p.a, &p.b);
    b.net.refresh();
    wait_for("limited connection", || {
        a.net.is_linked(&b.pk) && b.backend.has_op(&p.org_op)
    })
    .await;

    let removal = op(&format!(
        "{{\"type\":\"member_remove\",\"member\":\"{}\"}}",
        b.pk
    ));
    let removal_id = super::wire::op_id(&removal);
    b.backend.with(|s| {
        s.on_ingest = Some(Box::new(|s, _from, ops| {
            if ops.iter().any(|o| o.payload.contains("member_remove")) {
                s.suspended_org = None;
                s.org = None;
            }
        }))
    });
    a.backend.with(|s| {
        s.auth.insert(
            b.pk.clone(),
            PeerAuth::Removed {
                removal: Some(removal.clone()),
            },
        )
    });
    a.net.refresh();
    wait_for("b ingests the removal op", || {
        b.backend.with(|s| {
            s.ingested
                .iter()
                .any(|(from, ids)| *from == a.pk && ids.contains(&removal_id))
        })
    })
    .await;
    wait_for("disconnected", || {
        !a.net.is_linked(&b.pk) && !b.net.is_linked(&a.pk)
    })
    .await;
    assert!(a.backend.with(|s| {
        s.rejections
            .iter()
            .any(|(pk, _, code)| pk.as_deref() == Some(b.pk.as_str()) && code == "removed_member")
    }));
    // A removed laptop stops dialing: no new connection shows up.
    b.net.refresh();
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert!(!a.net.is_linked(&b.pk));
    assert_eq!(b.net.status().state, NetState::NoOrg);
}

#[tokio::test(flavor = "multi_thread")]
async fn two_suspended_laptops_do_not_sync_back_and_forth() {
    let (a, b) = pair(225, 226).await;
    for (x, y) in [(&a, &b), (&b, &a)] {
        x.backend.suspend(&y.pk, None);
        x.backend.set_self_suspended(true);
    }
    // A suspended laptop dials active members only; a manual address is
    // dialed anyway.
    a.backend.add_op(op("{\"n\":1}"));
    b.backend.add_op(op("{\"n\":2}"));
    a.backend.know(None, b.addr);
    a.net.refresh();
    wait_for("both ops on both sides", || {
        a.backend.op_ids().len() == 2 && b.backend.op_ids().len() == 2
    })
    .await;
    let offers = || a.backend.with(|s| s.offers) + b.backend.with(|s| s.offers);
    tokio::time::sleep(Duration::from_millis(500)).await;
    let before = offers();
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(offers() <= before + 2, "sync ping-pong: {before} -> {}", offers());
}
