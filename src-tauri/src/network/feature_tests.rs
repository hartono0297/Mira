//! Feature sync over real QUIC on loopback: three nodes with a toy feature
//! and a toy blob source (docs/plans/transport-fitur.md, task C).
//!
//! Every node gets its own `FeatureHub` with a `Toy` feature (topic `toy`)
//! and a `ToyBlobs` source, and is started with `start_with_features`.
//! mDNS is off; peers dial each other through `known_addresses`. Seeds
//! 141..=180 are used here so keys never repeat those of `tests.rs`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ed25519_dalek::SigningKey;
use tempfile::TempDir;
use zeroize::Zeroizing;

use super::feature::{
    BlobSource, FeatureHub, FeatureIngest, FeatureRecord, FeatureSync, MAX_RECORD_BYTES,
};
use super::testing::MemoryBackend;
use super::*;

const ORG: &str = "0123456789abcdef0123456789abcdef";
const TOY: &str = "toy";
const EXTRA: &str = "extra";

/// Time given to the transport to (not) deliver something before asserting
/// that it did not arrive. Well above the 250 ms notify delay.
const GRACE: Duration = Duration::from_millis(2000);

fn pk_of(seed: u8) -> String {
    hex::encode(
        SigningKey::from_bytes(&[seed; 32])
            .verifying_key()
            .as_bytes(),
    )
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ----- Toy feature -----------------------------------------------------------

/// In-memory feature. Records whose body starts with `rahasia` are hidden
/// from the peers in `hide_from`; bodies starting with `bad` are refused by
/// `ingest`. With `forge` set, `records_for` lies: same id, other body.
struct Toy {
    topic: &'static str,
    store: Mutex<BTreeMap<String, FeatureRecord>>,
    hide_from: Mutex<HashSet<String>>,
    forge: AtomicBool,
    rejected: AtomicUsize,
    /// Every `peer_connected` call.
    connected: Mutex<Vec<String>>,
    /// Every `ingest` call: (from, ids).
    ingested: Mutex<Vec<(String, Vec<String>)>>,
    /// Every `record_ids_for` call: (peer, ids offered).
    offered: Mutex<Vec<(String, Vec<String>)>>,
    /// Every `records_for` call: (peer, ids returned).
    served: Mutex<Vec<(String, Vec<String>)>>,
}

impl Toy {
    fn new(topic: &'static str) -> Self {
        Self {
            topic,
            store: Mutex::new(BTreeMap::new()),
            hide_from: Mutex::new(HashSet::new()),
            forge: AtomicBool::new(false),
            rejected: AtomicUsize::new(0),
            connected: Mutex::new(Vec::new()),
            ingested: Mutex::new(Vec::new()),
            offered: Mutex::new(Vec::new()),
            served: Mutex::new(Vec::new()),
        }
    }

    /// Stores a record locally (no notify) and returns its id.
    fn insert(&self, r: FeatureRecord) -> String {
        let id = r.id.clone();
        lock(&self.store).insert(id.clone(), r);
        id
    }

    fn has(&self, id: &str) -> bool {
        lock(&self.store).contains_key(id)
    }

    fn body(&self, id: &str) -> Option<String> {
        lock(&self.store).get(id).map(|r| r.body.clone())
    }

    fn ids(&self) -> HashSet<String> {
        lock(&self.store).keys().cloned().collect()
    }

    fn hide_secrets_from(&self, peer: &str) {
        lock(&self.hide_from).insert(peer.to_owned());
    }

    fn visible(&self, peer: &str, r: &FeatureRecord) -> bool {
        !(r.body.starts_with("rahasia") && lock(&self.hide_from).contains(peer))
    }

    fn was_connected_to(&self, peer: &str) -> bool {
        lock(&self.connected).iter().any(|p| p == peer)
    }

    /// Ids handed to `ingest` with `from == from`.
    fn ingested_from(&self, from: &str) -> HashSet<String> {
        lock(&self.ingested)
            .iter()
            .filter(|(f, _)| f == from)
            .flat_map(|(_, ids)| ids.clone())
            .collect()
    }

    /// Every id ever handed to `ingest`, from anyone.
    fn ingested_any(&self) -> HashSet<String> {
        lock(&self.ingested)
            .iter()
            .flat_map(|(_, ids)| ids.clone())
            .collect()
    }

    fn served_to(&self, peer: &str) -> HashSet<String> {
        lock(&self.served)
            .iter()
            .filter(|(p, _)| p == peer)
            .flat_map(|(_, ids)| ids.clone())
            .collect()
    }

    fn offered_to(&self, peer: &str) -> HashSet<String> {
        lock(&self.offered)
            .iter()
            .filter(|(p, _)| p == peer)
            .flat_map(|(_, ids)| ids.clone())
            .collect()
    }

    fn was_offered_to(&self, peer: &str) -> bool {
        lock(&self.offered).iter().any(|(p, _)| p == peer)
    }
}

impl FeatureSync for Toy {
    fn topic(&self) -> &'static str {
        self.topic
    }

    fn record_ids_for(&self, peer: &str) -> Result<Vec<String>, String> {
        let ids: Vec<String> = lock(&self.store)
            .values()
            .filter(|r| self.visible(peer, r))
            .map(|r| r.id.clone())
            .collect();
        lock(&self.offered).push((peer.to_owned(), ids.clone()));
        Ok(ids)
    }

    fn unknown_ids(&self, ids: &[String]) -> Result<Vec<String>, String> {
        let s = lock(&self.store);
        Ok(ids
            .iter()
            .filter(|i| !s.contains_key(*i))
            .cloned()
            .collect())
    }

    fn records_for(&self, peer: &str, ids: &[String]) -> Result<Vec<FeatureRecord>, String> {
        // `ids` comes from the peer: filter by scope again.
        let out: Vec<FeatureRecord> = {
            let s = lock(&self.store);
            ids.iter()
                .filter_map(|i| s.get(i))
                .filter(|r| self.visible(peer, r))
                .cloned()
                .collect()
        };
        lock(&self.served).push((peer.to_owned(), out.iter().map(|r| r.id.clone()).collect()));
        if self.forge.load(Ordering::SeqCst) {
            return Ok(out
                .into_iter()
                .map(|r| FeatureRecord {
                    id: r.id,
                    body: format!("palsu {}", r.body),
                })
                .collect());
        }
        Ok(out)
    }

    fn ingest(&self, from: &str, records: Vec<FeatureRecord>) -> Result<FeatureIngest, String> {
        lock(&self.ingested).push((
            from.to_owned(),
            records.iter().map(|r| r.id.clone()).collect(),
        ));
        let mut s = lock(&self.store);
        let mut out = FeatureIngest::default();
        for r in records {
            if r.body.starts_with("bad") {
                out.rejected += 1;
                self.rejected.fetch_add(1, Ordering::SeqCst);
            } else if s.insert(r.id.clone(), r).is_none() {
                out.accepted += 1;
                out.changed = true;
            }
        }
        Ok(out)
    }

    fn peer_connected(&self, peer: &str) {
        lock(&self.connected).push(peer.to_owned());
    }
}

// ----- Toy blob source -------------------------------------------------------

/// Files in a temporary folder. A peer may download a blob only when
/// (peer, hash) was allowed. `serve_wrong` maps a hash to a file whose
/// contents have another hash.
struct ToyBlobs {
    dir: TempDir,
    files: Mutex<HashMap<String, PathBuf>>,
    allowed: Mutex<HashSet<(String, String)>>,
    /// Every `blob_path_for` call: (peer, hash).
    asked: Mutex<Vec<(String, String)>>,
}

impl ToyBlobs {
    fn new() -> Self {
        Self {
            dir: tempfile::tempdir().expect("temp dir"),
            files: Mutex::new(HashMap::new()),
            allowed: Mutex::new(HashSet::new()),
            asked: Mutex::new(Vec::new()),
        }
    }

    fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.dir.path().join(name);
        std::fs::write(&path, bytes).expect("write blob");
        path
    }

    /// Stores `bytes` and returns their BLAKE3 hash.
    fn add(&self, bytes: &[u8]) -> String {
        let hash = blake3::hash(bytes).to_hex().to_string();
        let path = self.write(&hash, bytes);
        lock(&self.files).insert(hash.clone(), path);
        hash
    }

    /// Serves `bytes` under `hash`, which is not their hash.
    fn serve_wrong(&self, hash: &str, bytes: &[u8]) {
        assert_ne!(blake3::hash(bytes).to_hex().as_str(), hash);
        let path = self.write("wrong.bin", bytes);
        lock(&self.files).insert(hash.to_owned(), path);
    }

    fn allow(&self, peer: &str, hash: &str) {
        lock(&self.allowed).insert((peer.to_owned(), hash.to_owned()));
    }

    fn was_asked(&self, peer: &str, hash: &str) -> bool {
        lock(&self.asked)
            .iter()
            .any(|(p, h)| p == peer && h == hash)
    }
}

impl BlobSource for ToyBlobs {
    fn blob_path_for(&self, peer: &str, hash: &str) -> Option<PathBuf> {
        lock(&self.asked).push((peer.to_owned(), hash.to_owned()));
        if !lock(&self.allowed).contains(&(peer.to_owned(), hash.to_owned())) {
            return None;
        }
        lock(&self.files).get(hash).cloned()
    }
}

/// Deterministic test content of `len` bytes, several 64 KiB chunks long.
fn blob_bytes(len: usize, salt: u8) -> Vec<u8> {
    (0..len)
        .map(|i| (i as u8).wrapping_mul(31).wrapping_add((i / 251) as u8) ^ salt)
        .collect()
}

/// Names of the entries in `dir` (to spot leftover temporary files).
fn entries(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .expect("read dir")
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect()
}

// ----- Nodes -----------------------------------------------------------------

struct Node {
    net: Network,
    backend: Arc<MemoryBackend>,
    hub: Arc<FeatureHub>,
    toy: Arc<Toy>,
    /// Second topic, registered only when the node was built with it.
    extra: Option<Arc<Toy>>,
    blobs: Arc<ToyBlobs>,
    pk: String,
    addr: SocketAddr,
    events: Arc<Mutex<Vec<NetEvent>>>,
    /// Download destinations of this node.
    downloads: TempDir,
}

impl Node {
    fn connected_to(&self, other: &Node) -> bool {
        self.net.connected_peers().contains(&other.pk)
    }

    fn feature_events(&self, topic: &'static str) -> usize {
        lock(&self.events)
            .iter()
            .filter(|e| **e == NetEvent::FeatureChanged { topic })
            .count()
    }

    /// A local change: store a `toy` record and tell the hub.
    fn add(&self, body: &str) -> String {
        let id = self.toy.insert(FeatureRecord::new(body));
        self.hub.notify_changed(TOY);
        id
    }

    fn has_rejection(&self, from: &Node, code: &str) -> bool {
        self.backend.with(|s| {
            s.rejections
                .iter()
                .any(|(pk, _, c)| pk.as_deref() == Some(from.pk.as_str()) && c == code)
        })
    }

    fn connected_at(&self, other: &Node) -> Option<String> {
        self.net
            .status()
            .peers
            .into_iter()
            .find(|p| p.public_key == other.pk)
            .map(|p| p.connected_at)
    }

    async fn fetch(
        &self,
        hash: &str,
        max: u64,
        prefer: &[&Node],
        dest: &Path,
    ) -> Result<u64, String> {
        let prefer = prefer.iter().map(|n| n.pk.clone()).collect();
        self.hub.fetch_blob(hash, max, prefer, dest).await
    }
}

/// A node with the `toy` feature, a blob source and, with `with_extra`, the
/// `extra` topic, started with its own hub.
async fn node_full(seed: u8, with_extra: bool) -> Node {
    let hub = Arc::new(FeatureHub::default());
    let toy = Arc::new(Toy::new(TOY));
    hub.register(toy.clone());
    let extra = with_extra.then(|| Arc::new(Toy::new(EXTRA)));
    if let Some(x) = &extra {
        hub.register(x.clone());
    }
    let blobs = Arc::new(ToyBlobs::new());
    hub.register_blob_source(blobs.clone());

    let pk = pk_of(seed);
    let backend = Arc::new(MemoryBackend::new(Some(ORG)));
    let events: Arc<Mutex<Vec<NetEvent>>> = Arc::default();
    let rec = events.clone();
    let net = Network::start_with_features(
        NetConfig {
            identity_secret: Zeroizing::new([seed; 32]),
            public_key: pk.clone(),
            port: Some(0),
            mdns_enabled: false,
        },
        backend.clone(),
        Arc::new(move |e| lock(&rec).push(e)),
        hub.clone(),
    )
    .await
    .expect("network starts");
    let port = net.status().listen_port.expect("listening");
    Node {
        net,
        backend,
        hub,
        toy,
        extra,
        blobs,
        pk,
        addr: SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
        events,
        downloads: tempfile::tempdir().expect("temp dir"),
    }
}

async fn node(seed: u8) -> Node {
    node_full(seed, false).await
}

/// Makes every node a member in every other node's backend.
fn members(nodes: &[&Node]) {
    for x in nodes {
        for y in nodes {
            if x.pk != y.pk {
                x.backend.add_member(&y.pk);
            }
        }
    }
}

async fn trio(a: u8, b: u8, c: u8) -> (Node, Node, Node) {
    let (na, nb, nc) = (node(a).await, node(b).await, node(c).await);
    members(&[&na, &nb, &nc]);
    (na, nb, nc)
}

async fn duo(a: u8, b: u8) -> (Node, Node) {
    let (na, nb) = (node(a).await, node(b).await);
    members(&[&na, &nb]);
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

async fn mesh(nodes: &[&Node]) {
    for (i, x) in nodes.iter().enumerate() {
        for y in &nodes[i + 1..] {
            connect(x, y).await;
        }
    }
}

async fn shutdown(nodes: &[&Node]) {
    for n in nodes {
        n.net.shutdown().await;
    }
}

fn mark_removed(n: &Node, removed: &Node) {
    n.backend.with(|s| {
        s.auth
            .insert(removed.pk.clone(), PeerAuth::Removed { removal: None })
    });
}

// ----- Sessions --------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn three_nodes_converge_on_the_union() {
    let (a, b, c) = trio(141, 142, 143).await;
    let mut all = vec![a.add("a sebelum"), b.add("b sebelum"), c.add("c sebelum")];

    mesh(&[&a, &b, &c]).await;
    all.push(a.add("a sesudah"));
    all.push(b.add("b sesudah"));
    all.push(c.add("c sesudah"));
    let all: HashSet<String> = all.into_iter().collect();

    wait_for("all three hold the union", || {
        [&a, &b, &c].iter().all(|n| n.toy.ids() == all)
    })
    .await;
    wait_for("FeatureChanged(toy) on every receiver", || {
        [&a, &b, &c].iter().all(|n| n.feature_events(TOY) >= 1)
    })
    .await;
    wait_for("peer_connected for every connected peer", || {
        a.toy.was_connected_to(&b.pk)
            && a.toy.was_connected_to(&c.pk)
            && b.toy.was_connected_to(&a.pk)
            && b.toy.was_connected_to(&c.pk)
            && c.toy.was_connected_to(&a.pk)
            && c.toy.was_connected_to(&b.pk)
    })
    .await;
    // Records arrive intact and only from members of this test.
    for n in [&a, &b, &c] {
        assert_eq!(
            n.toy.body(&FeatureRecord::new("a sesudah").id).as_deref(),
            Some("a sesudah")
        );
        let senders: HashSet<String> = lock(&n.toy.ingested)
            .iter()
            .map(|(f, _)| f.clone())
            .collect();
        assert!(
            senders.iter().all(|f| [&a.pk, &b.pk, &c.pk].contains(&f)),
            "{senders:?}"
        );
        assert!(!senders.contains(&n.pk), "a node never ingests from itself");
    }
    shutdown(&[&a, &b, &c]).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn notify_after_connection_reaches_peers_quickly() {
    let (a, b, c) = trio(144, 145, 146).await;
    let first = a.add("pertama");
    mesh(&[&a, &b, &c]).await;
    wait_for("initial sync done", || {
        b.toy.has(&first) && c.toy.has(&first)
    })
    .await;
    // Let the sessions started by the connections finish, so only the
    // notify can deliver the next record (the periodic sync is 60 s away).
    tokio::time::sleep(Duration::from_millis(500)).await;

    let started = Instant::now();
    let later = a.add("kemudian");
    wait_for("later record reaches b and c", || {
        b.toy.has(&later) && c.toy.has(&later)
    })
    .await;
    let took = started.elapsed();
    assert!(took < Duration::from_secs(10), "notify took {took:?}");
    shutdown(&[&a, &b, &c]).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn records_hidden_from_a_peer_never_reach_it() {
    let (a, b, c) = trio(147, 148, 149).await;
    // A real feature scopes on every laptop: b applies the same rule, so b
    // cannot forward a's secrets to c either.
    a.toy.hide_secrets_from(&c.pk);
    b.toy.hide_secrets_from(&c.pk);
    let secret1 = a.add("rahasia 1");
    let public1 = a.add("umum 1");

    mesh(&[&a, &b, &c]).await;
    wait_for("b gets both, c gets the public one", || {
        b.toy.has(&secret1) && b.toy.has(&public1) && c.toy.has(&public1)
    })
    .await;

    let secret2 = a.add("rahasia 2");
    let public2 = a.add("umum 2");
    wait_for("later records: b both, c public", || {
        b.toy.has(&secret2) && b.toy.has(&public2) && c.toy.has(&public2)
    })
    .await;
    // More rounds must not leak anything.
    a.net.refresh();
    b.net.refresh();
    c.net.refresh();
    tokio::time::sleep(GRACE).await;

    let secrets = HashSet::from([secret1.clone(), secret2.clone()]);
    assert!(c.toy.ids().is_disjoint(&secrets), "c holds a secret");
    assert!(
        c.toy.ingested_any().is_disjoint(&secrets),
        "a secret reached c's ingest"
    );
    for sender in [&a, &b] {
        assert!(
            sender.toy.offered_to(&c.pk).is_disjoint(&secrets),
            "a secret was offered to c"
        );
        assert!(
            sender.toy.served_to(&c.pk).is_disjoint(&secrets),
            "a secret was served to c"
        );
    }
    let public_served = a.toy.served_to(&c.pk).contains(&public2)
        || b.toy.served_to(&c.pk).contains(&public2);
    assert!(public_served, "c got the public record from a or b");
    shutdown(&[&a, &b, &c]).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn forged_and_oversize_records_are_dropped_and_logged() {
    let (liar, r) = duo(150, 151).await;
    liar.toy.forge.store(true, Ordering::SeqCst);
    let real1 = liar.add("asli 1");
    let real2 = liar.add("asli 2");
    // Correct id, but over the size limit: dropped even when not forged.
    let big = liar
        .toy
        .insert(FeatureRecord::new("x".repeat(MAX_RECORD_BYTES + 1)));

    connect(&liar, &r).await;
    wait_for("r logs dropped records from the liar", || {
        r.has_rejection(&liar, "feature_records_dropped")
    })
    .await;
    wait_for("the liar served the forged records", || {
        liar.toy.served_to(&r.pk).contains(&real1)
    })
    .await;
    let bad = HashSet::from([real1.clone(), real2.clone(), big.clone()]);
    assert!(
        r.toy.ingested_any().is_disjoint(&bad),
        "a forged record reached ingest"
    );
    assert!(r.toy.ids().is_disjoint(&bad));

    // Honest again: the real records arrive (nothing was poisoned), the
    // oversize one never does.
    liar.toy.forge.store(false, Ordering::SeqCst);
    liar.hub.notify_changed(TOY);
    wait_for("real records arrive once the liar stops lying", || {
        r.toy.has(&real1) && r.toy.has(&real2)
    })
    .await;
    assert_eq!(r.toy.body(&real1).as_deref(), Some("asli 1"));
    liar.net.refresh();
    tokio::time::sleep(GRACE).await;
    assert!(
        !r.toy.ingested_any().contains(&big),
        "oversize record reached ingest"
    );
    assert!(!r.toy.has(&big));
    assert!(r.connected_to(&liar));
    shutdown(&[&liar, &r]).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn records_refused_by_the_feature_do_not_stop_sync() {
    let (a, b) = duo(152, 153).await;
    let bad = a.add("bad record");
    let good1 = a.add("baik 1");

    connect(&a, &b).await;
    wait_for("good record arrives, bad one refused", || {
        b.toy.has(&good1) && b.toy.rejected.load(Ordering::SeqCst) >= 1
    })
    .await;
    assert!(!b.toy.has(&bad));
    assert!(
        b.toy.ingested_from(&a.pk).contains(&bad),
        "the transport delivered it to ingest"
    );

    let good2 = a.add("baik 2");
    wait_for("sync goes on after a refusal", || b.toy.has(&good2)).await;
    assert!(!b.toy.has(&bad));
    assert!(a.connected_to(&b) && b.connected_to(&a));
    shutdown(&[&a, &b]).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn unknown_topic_is_ignored_without_dropping_the_connection() {
    let a = node_full(154, true).await;
    let b = node(155).await;
    members(&[&a, &b]);
    let extra = a.extra.clone().expect("a has the extra topic");
    // Not empty, so a really opens an `extra` session to b.
    extra.insert(FeatureRecord::new("tambahan 1"));

    connect(&a, &b).await;
    let since = a.connected_at(&b).expect("a lists b");
    wait_for("a offered the extra topic to b", || {
        extra.was_offered_to(&b.pk)
    })
    .await;
    extra.insert(FeatureRecord::new("tambahan 2"));
    a.hub.notify_changed(EXTRA);
    tokio::time::sleep(GRACE).await;

    assert!(
        a.connected_to(&b) && b.connected_to(&a),
        "connection dropped"
    );
    assert_eq!(
        a.connected_at(&b),
        Some(since.clone()),
        "the connection was replaced"
    );
    assert!(
        extra.served_to(&b.pk).is_empty(),
        "b cannot have asked for extra records"
    );

    let id = a.add("toy setelah extra");
    wait_for("toy still syncs", || b.toy.has(&id)).await;
    assert_eq!(
        a.connected_at(&b),
        Some(since),
        "the connection was replaced"
    );
    assert!(b.toy.ingested_any().iter().all(|i| a.toy.has(i)));
    shutdown(&[&a, &b]).await;
}

// ----- Blobs -----------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn blob_download_succeeds() {
    let (a, b) = duo(156, 157).await;
    let bytes = blob_bytes(300_000, 1);
    let hash = a.blobs.add(&bytes);
    a.blobs.allow(&b.pk, &hash);
    connect(&a, &b).await;

    let dest = b.downloads.path().join("unduhan.bin");
    let size = b
        .fetch(&hash, 1_000_000, &[&a], &dest)
        .await
        .expect("download succeeds");
    assert_eq!(size, bytes.len() as u64);
    let got = std::fs::read(&dest).expect("dest exists");
    assert_eq!(got, bytes);
    assert_eq!(blake3::hash(&got).to_hex().as_str(), hash);
    assert_eq!(entries(b.downloads.path()), vec!["unduhan.bin".to_owned()]);
    assert!(a.blobs.was_asked(&b.pk, &hash));
    shutdown(&[&a, &b]).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn blob_not_allowed_is_refused() {
    let (a, b) = duo(158, 159).await;
    let hash = a.blobs.add(&blob_bytes(10_000, 2));
    // Allowed for someone else, not for b.
    a.blobs.allow(&pk_of(200), &hash);
    connect(&a, &b).await;

    let dest = b.downloads.path().join("ditolak.bin");
    let res = b.fetch(&hash, 1_000_000, &[&a], &dest).await;
    assert!(res.is_err(), "{res:?}");
    assert!(!dest.exists());
    assert!(entries(b.downloads.path()).is_empty());
    assert!(a.blobs.was_asked(&b.pk, &hash), "a was asked and refused");
    shutdown(&[&a, &b]).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn blob_with_wrong_hash_is_refused() {
    let (a, b) = duo(160, 161).await;
    let claimed = blake3::hash(b"isi yang diharapkan").to_hex().to_string();
    a.blobs.serve_wrong(&claimed, &blob_bytes(150_000, 3));
    a.blobs.allow(&b.pk, &claimed);
    connect(&a, &b).await;

    let dest = b.downloads.path().join("salah.bin");
    let res = b.fetch(&claimed, 1_000_000, &[&a], &dest).await;
    assert!(res.is_err(), "{res:?}");
    assert!(!dest.exists());
    let left = entries(b.downloads.path());
    assert!(left.is_empty(), "leftover files: {left:?}");
    assert!(a.blobs.was_asked(&b.pk, &claimed));
    shutdown(&[&a, &b]).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn blob_larger_than_max_size_is_refused() {
    let (a, b) = duo(162, 163).await;
    let bytes = blob_bytes(100_000, 4);
    let hash = a.blobs.add(&bytes);
    a.blobs.allow(&b.pk, &hash);
    connect(&a, &b).await;

    let dest = b.downloads.path().join("besar.bin");
    let res = b.fetch(&hash, bytes.len() as u64 - 1, &[&a], &dest).await;
    assert!(res.is_err(), "{res:?}");
    assert!(!dest.exists());
    let left = entries(b.downloads.path());
    assert!(left.is_empty(), "leftover files: {left:?}");
    assert!(a.blobs.was_asked(&b.pk, &hash));

    // The same blob within the limit still works on the same connection.
    let size = b
        .fetch(&hash, bytes.len() as u64, &[&a], &dest)
        .await
        .expect("exact max_size is allowed");
    assert_eq!(size, bytes.len() as u64);
    shutdown(&[&a, &b]).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn preferred_peer_that_refuses_falls_back_to_another() {
    let (a, b, c) = trio(164, 165, 166).await;
    let bytes = blob_bytes(80_000, 5);
    let hash = a.blobs.add(&bytes);
    assert_eq!(c.blobs.add(&bytes), hash);
    // a has it but refuses b; c allows b.
    c.blobs.allow(&b.pk, &hash);
    mesh(&[&a, &b, &c]).await;

    let dest = b.downloads.path().join("cadangan.bin");
    let size = b
        .fetch(&hash, 1_000_000, &[&a], &dest)
        .await
        .expect("c serves it");
    assert_eq!(size, bytes.len() as u64);
    assert_eq!(std::fs::read(&dest).unwrap(), bytes);
    // c answered, and a was tried first (had c been tried first, a would
    // never have been asked).
    assert!(c.blobs.was_asked(&b.pk, &hash));
    assert!(a.blobs.was_asked(&b.pk, &hash), "prefer was not tried");
    assert_eq!(entries(b.downloads.path()), vec!["cadangan.bin".to_owned()]);
    shutdown(&[&a, &b, &c]).await;
}

// ----- Removal and offline ---------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn removed_peer_receives_no_more_records_or_blobs() {
    let (a, b, c) = trio(167, 168, 169).await;
    let before = a.add("sebelum dikeluarkan");
    let hash = a.blobs.add(&blob_bytes(20_000, 6));
    a.blobs.allow(&c.pk, &hash);
    mesh(&[&a, &b, &c]).await;
    wait_for("synced before the removal", || {
        b.toy.has(&before) && c.toy.has(&before)
    })
    .await;

    // The removal op reaches every member, so both a and b mark c removed
    // (b would otherwise forward a's new record to c, which is correct for a
    // laptop that does not know about the removal yet). That makes "c never
    // gets the new record" deterministic: nobody connected to c is allowed
    // to send it.
    mark_removed(&a, &c);
    mark_removed(&b, &c);
    a.net.refresh();
    b.net.refresh();
    wait_for("a and b drop c", || {
        !a.net.connected_peers().contains(&c.pk) && !b.net.connected_peers().contains(&c.pk)
    })
    .await;
    assert!(a.connected_to(&b));
    let asked_before = lock(&a.blobs.asked).len();

    let after = a.add("sesudah dikeluarkan");
    wait_for("b gets the new record", || b.toy.has(&after)).await;
    a.net.refresh();
    b.net.refresh();
    tokio::time::sleep(GRACE).await;

    assert!(!c.toy.has(&after), "removed peer got the new record");
    assert!(!c.toy.ingested_any().contains(&after));
    assert!(!a.toy.served_to(&c.pk).contains(&after));
    assert!(!a.toy.offered_to(&c.pk).contains(&after));
    assert!(!b.toy.served_to(&c.pk).contains(&after));

    let dest = c.downloads.path().join("terlarang.bin");
    let res = c.fetch(&hash, 1_000_000, &[&a], &dest).await;
    assert!(res.is_err(), "{res:?}");
    assert!(!dest.exists());
    assert!(
        lock(&a.blobs.asked)[asked_before..]
            .iter()
            .all(|(p, _)| *p != c.pk),
        "a asked its blob source on behalf of a removed peer"
    );
    shutdown(&[&a, &b, &c]).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn hub_is_offline_before_start_and_after_shutdown() {
    // Before any network: the default link.
    let hub = FeatureHub::default();
    assert!(hub.connected_peers().is_empty());
    let tmp = tempfile::tempdir().unwrap();
    let res = hub
        .fetch_blob(&"0".repeat(64), 10, vec![], &tmp.path().join("x"))
        .await;
    assert!(res.is_err());

    let (a, b) = duo(170, 171).await;
    connect(&a, &b).await;
    assert_eq!(a.hub.connected_peers(), vec![b.pk.clone()]);

    a.net.shutdown().await;
    assert!(a.hub.connected_peers().is_empty());
    let hash = a.blobs.add(b"apa saja");
    a.blobs.allow(&b.pk, &hash);
    let dest = a.downloads.path().join("luring.bin");
    let res = a.fetch(&hash, 1_000, &[&b], &dest).await;
    assert!(res.is_err(), "{res:?}");
    assert!(!dest.exists());
    // Harmless once offline.
    a.add("setelah berhenti");
    wait_for("b sees a go away", || !b.connected_to(&a)).await;
    b.net.shutdown().await;
    assert!(b.hub.connected_peers().is_empty());
}

// ----- Version gate (v0.3) ---------------------------------------------------

/// Makes `n` send `Hello.features = 1`, as a v0.2 laptop does. Must be
/// called before `n` connects. The rest of `n` stays v0.3 code, so it still
/// tries feature sessions and downloads towards v0.3 peers: that is what
/// exercises the refusals on their side.
fn play_v02(n: &Node) {
    n.net
        .inner
        .features
        .hello_features
        .store(1, Ordering::SeqCst);
}

/// One laptop announces `features = 1` (v0.2), two announce 2. The
/// membership log syncs among all three; feature records and blobs flow
/// only between the two v0.3 laptops, in neither direction with the v0.2
/// one, and every connection stays up.
#[tokio::test(flavor = "multi_thread")]
async fn v02_peer_syncs_the_membership_log_but_no_features() {
    let (old, new, new2) = trio(172, 173, 174).await;
    play_v02(&old);
    let old_rec = old.add("dari laptop lama");
    let new_rec = new.add("dari laptop baru");
    let new2_rec = new2.add("dari laptop baru kedua");
    let old_op = old.backend.add_op(super::testing::op("op laptop lama"));
    let new_op = new.backend.add_op(super::testing::op("op laptop baru"));
    let new_blob = new.blobs.add(&blob_bytes(30_000, 7));
    new.blobs.allow(&old.pk, &new_blob);
    let old_blob = old.blobs.add(&blob_bytes(30_000, 8));
    old.blobs.allow(&new.pk, &old_blob);

    mesh(&[&old, &new, &new2]).await;

    // Membership log: everyone gets every op, also from and to v0.2.
    wait_for("ops reach every laptop", || {
        [&old, &new, &new2]
            .iter()
            .all(|n| n.backend.has_op(&old_op) && n.backend.has_op(&new_op))
    })
    .await;
    // Features between the two v0.3 laptops still sync.
    wait_for("v0.3 laptops exchange records", || {
        new.toy.has(&new2_rec) && new2.toy.has(&new_rec)
    })
    .await;
    // The v0.2 laptop (v0.3 code here) did offer to the v0.3 ones, so their
    // refusal of `FeatureHave` was exercised.
    wait_for("the v0.2 laptop tried feature sessions", || {
        old.toy.was_offered_to(&new.pk) && old.toy.was_offered_to(&new2.pk)
    })
    .await;

    // Blobs: v0.3 serves nothing to v0.2, and does not ask v0.2.
    let dest = old.downloads.path().join("dari-baru.bin");
    let res = old.fetch(&new_blob, 1_000_000, &[&new], &dest).await;
    assert!(res.is_err(), "{res:?}");
    assert!(!dest.exists());
    assert!(
        !new.blobs.was_asked(&old.pk, &new_blob),
        "a v0.3 laptop looked up a blob for a v0.2 peer"
    );
    let dest = new.downloads.path().join("dari-lama.bin");
    let res = new.fetch(&old_blob, 1_000_000, &[&old], &dest).await;
    assert!(res.is_err(), "{res:?}");
    assert!(!dest.exists());
    assert!(
        !old.blobs.was_asked(&new.pk, &old_blob),
        "a v0.3 laptop asked a v0.2 peer for a blob"
    );

    // More rounds must not change anything.
    for n in [&old, &new, &new2] {
        n.net.refresh();
    }
    tokio::time::sleep(GRACE).await;

    for v3 in [&new, &new2] {
        assert!(
            !v3.toy.was_offered_to(&old.pk),
            "a v0.3 laptop offered records to a v0.2 peer"
        );
        assert!(v3.toy.served_to(&old.pk).is_empty());
        assert!(
            !v3.toy.was_connected_to(&old.pk),
            "peer_connected was called for a v0.2 peer"
        );
        assert!(
            v3.toy.ingested_from(&old.pk).is_empty(),
            "records from a v0.2 peer reached ingest"
        );
        assert!(!v3.toy.has(&old_rec));
        // Connected for the membership log, offline for the features.
        assert!(v3.net.connected_peers().contains(&old.pk));
        assert!(!v3.hub.connected_peers().contains(&old.pk));
    }
    assert_eq!(new.hub.connected_peers(), vec![new2.pk.clone()]);
    assert!(old.toy.ingested_any().is_empty(), "v0.2 received records");
    assert!(!old.toy.has(&new_rec) && !old.toy.has(&new2_rec));
    assert!(old.toy.served_to(&new.pk).is_empty());
    assert!(old.toy.served_to(&new2.pk).is_empty());

    // Connections stay up, and the membership log keeps syncing.
    assert!(old.connected_to(&new) && new.connected_to(&old));
    assert!(old.connected_to(&new2) && new2.connected_to(&old));
    let later = new.backend.add_op(super::testing::op("op sesudahnya"));
    new.net.refresh();
    wait_for("a later op reaches the v0.2 laptop", || {
        old.backend.has_op(&later)
    })
    .await;
    shutdown(&[&old, &new, &new2]).await;
}
