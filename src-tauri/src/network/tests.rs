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
