//! Contract for syncing feature data (chat, board, documents, signing) with
//! colleagues' laptops, on top of the member connections from Tahap 1.
//!
//! Tahap 1 syncs one thing, the signed membership ops. Every later feature
//! needs the same pattern: "these are the record ids you may have, tell me
//! which ones you are missing, here they are". This module fixes that pattern
//! once so each feature only writes its own [`FeatureSync`] and never touches
//! the transport (`node.rs`, `wire.rs`).
//!
//! The pieces:
//! - [`FeatureRecord`]: one opaque record, id = BLAKE3 of its body.
//! - [`FeatureSync`]: implemented by a feature. Decides what each peer may
//!   receive and checks everything that arrives (signature, format, role).
//! - [`BlobSource`]: implemented by a feature that owns files. Decides whether
//!   a peer may download a blob and where the bytes are.
//! - [`FeatureHub`]: managed Tauri state. Features register themselves and
//!   call [`FeatureHub::notify_changed`] after a local change, and
//!   [`FeatureHub::fetch_blob`] to download a file from a colleague.
//! - [`FeatureLink`]: the transport behind the hub. [`OfflineLink`] until the
//!   network wires the real one in with [`FeatureHub::set_link`].
//! - [`check_incoming`]: the checks the transport applies to every received
//!   batch before it reaches [`FeatureSync::ingest`]. The in-memory test
//!   helpers apply the same checks, so feature tests see what the network
//!   would deliver.
//! - [`testing`]: in-memory sync between several `FeatureSync` instances, for
//!   feature tests that need two or three "laptops" without QUIC.
//!
//! Wire protocol (implemented by the transport, listed here so all sides
//! agree): `Msg::FeatureHave { topic, ids }`, `Msg::FeatureWant { topic, ids }`
//! and `Msg::FeatureRecords { topic, records }` on the member connection,
//! split so no frame exceeds `wire::MAX_FRAME`. A blob is downloaded on its
//! own bidirectional stream: `Msg::BlobGet { hash }`, answered with
//! `Msg::BlobHeader { size }` (or `Msg::BlobRefused { code }`) followed by the
//! raw bytes. The receiver checks size and BLAKE3 before accepting the file.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};

/// Largest record body in bytes. Larger content (files) goes through blobs.
pub const MAX_RECORD_BYTES: usize = 256 * 1024;

/// Most records in one `FeatureRecords` batch handed to `ingest`.
pub const MAX_RECORDS_PER_BATCH: usize = 512;

/// Most ids in one `FeatureHave` or `FeatureWant` frame. The transport splits
/// longer lists into several frames.
pub const MAX_IDS_PER_FRAME: usize = 8192;

/// Topics in use. A topic is lowercase ASCII letters, 1 to 16 characters.
pub const TOPIC_CHAT: &str = "chat";
pub const TOPIC_BOARD: &str = "board";
pub const TOPIC_DOCS: &str = "docs";
pub const TOPIC_SIGN: &str = "sign";
/// Join requests forwarded to the laptops that may decide them (v0.3,
/// `join_sync.rs`).
pub const TOPIC_JOIN: &str = "join";
/// Kopi, positive reputation (`kopi/sync.rs`).
pub const TOPIC_KOPI: &str = "kopi";

/// Boxed future returned by [`FeatureLink::fetch_blob`].
pub type BlobFuture = Pin<Box<dyn Future<Output = Result<u64, String>> + Send>>;

/// One record of a feature. The body is opaque to the network (usually JSON
/// with the author's key and signature inside); the id is the BLAKE3 hash of
/// the body as 64 lowercase hex characters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeatureRecord {
    pub id: String,
    pub body: String,
}

impl FeatureRecord {
    pub fn new(body: impl Into<String>) -> Self {
        let body = body.into();
        let id = record_id(&body);
        Self { id, body }
    }

    /// `true` when `id` is the BLAKE3 of `body`.
    pub fn id_matches(&self) -> bool {
        self.id == record_id(&self.body)
    }
}

/// BLAKE3 of `body` as 64 lowercase hex characters.
pub fn record_id(body: &str) -> String {
    blake3::hash(body.as_bytes()).to_hex().to_string()
}

/// Result of [`FeatureSync::ingest`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FeatureIngest {
    /// Records stored now (new and valid).
    pub accepted: usize,
    /// Records refused by the feature (bad signature, no right, bad format).
    /// The feature logs them where admins can see them.
    pub rejected: usize,
    /// `true` when something visible changed, so the UI should refresh. The
    /// transport then emits `mira://feature` with the topic.
    pub changed: bool,
}

/// Implemented by each feature that syncs data. Methods are synchronous; the
/// transport calls them on tokio's blocking pool. `peer` and `from` are the
/// colleague's public key (64 hex), already proven in the TLS handshake and
/// checked as an active member of the organization.
pub trait FeatureSync: Send + Sync + 'static {
    /// One of the `TOPIC_*` constants. Must be unique per hub.
    fn topic(&self) -> &'static str;

    /// Ids of the records `peer` may receive. Data scoping lives here: team
    /// data only for that team's members, project data for guests of that
    /// project, sealed store-and-forward records for any member.
    fn record_ids_for(&self, peer: &str) -> Result<Vec<String>, String>;

    /// Of the offered ids, the ones this laptop does not have yet.
    fn unknown_ids(&self, ids: &[String]) -> Result<Vec<String>, String>;

    /// The records among `ids` that `peer` may receive. Must filter again:
    /// `ids` comes from the peer.
    fn records_for(&self, peer: &str, ids: &[String]) -> Result<Vec<FeatureRecord>, String>;

    /// Store records received from `from`. The batch already passed
    /// [`check_incoming`]. The feature checks signatures and rights itself,
    /// ignores duplicates, and must be idempotent.
    fn ingest(&self, from: &str, records: Vec<FeatureRecord>) -> Result<FeatureIngest, String>;

    /// Called when a member connection to `peer` is up. Optional.
    fn peer_connected(&self, _peer: &str) {}
}

/// Implemented by features that keep files in the blob store.
pub trait BlobSource: Send + Sync + 'static {
    /// The file for `hash` (64 hex) if `peer` may download it from this
    /// laptop, `None` otherwise. Checked for every request.
    fn blob_path_for(&self, peer: &str, hash: &str) -> Option<PathBuf>;
}

/// The transport behind the hub.
pub trait FeatureLink: Send + Sync + 'static {
    /// A local change happened in `topic`: offer the new ids to connected
    /// peers soon. Cheap; the transport batches calls.
    fn notify_changed(&self, topic: &str);

    /// Download blob `hash` from any connected peer that serves it (trying
    /// `prefer` first), write it to `dest` and return its size. The transport
    /// refuses more than `max_size` bytes and checks the BLAKE3 hash before
    /// returning `Ok`; on error `dest` is removed.
    fn fetch_blob(&self, hash: String, max_size: u64, prefer: Vec<String>, dest: PathBuf) -> BlobFuture;

    /// Public keys of peers with a live member connection.
    fn connected_peers(&self) -> Vec<String>;
}

/// Used until the network is running: nothing is sent, downloads fail.
#[derive(Debug, Default)]
pub struct OfflineLink;

impl FeatureLink for OfflineLink {
    fn notify_changed(&self, _topic: &str) {}

    fn fetch_blob(&self, _hash: String, _max_size: u64, _prefer: Vec<String>, _dest: PathBuf) -> BlobFuture {
        Box::pin(async { Err("Belum tersambung ke laptop rekan.".to_owned()) })
    }

    fn connected_peers(&self) -> Vec<String> {
        Vec::new()
    }
}

/// Managed Tauri state shared by the features and the transport.
pub struct FeatureHub {
    features: RwLock<Vec<Arc<dyn FeatureSync>>>,
    blob_sources: RwLock<Vec<Arc<dyn BlobSource>>>,
    link: RwLock<Arc<dyn FeatureLink>>,
}

impl Default for FeatureHub {
    fn default() -> Self {
        Self {
            features: RwLock::new(Vec::new()),
            blob_sources: RwLock::new(Vec::new()),
            link: RwLock::new(Arc::new(OfflineLink)),
        }
    }
}

impl FeatureHub {
    /// Adds a feature. A second feature with the same topic replaces the first.
    pub fn register(&self, feature: Arc<dyn FeatureSync>) {
        let topic = feature.topic();
        debug_assert!(is_topic(topic), "invalid topic {topic}");
        let mut list = self.features.write().unwrap_or_else(|e| e.into_inner());
        list.retain(|f| f.topic() != topic);
        list.push(feature);
    }

    pub fn register_blob_source(&self, source: Arc<dyn BlobSource>) {
        self.blob_sources.write().unwrap_or_else(|e| e.into_inner()).push(source);
    }

    /// Called by the transport when it starts (and with [`OfflineLink`] when
    /// it stops).
    pub fn set_link(&self, link: Arc<dyn FeatureLink>) {
        *self.link.write().unwrap_or_else(|e| e.into_inner()) = link;
    }

    pub fn features(&self) -> Vec<Arc<dyn FeatureSync>> {
        self.features.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn feature(&self, topic: &str) -> Option<Arc<dyn FeatureSync>> {
        self.features().into_iter().find(|f| f.topic() == topic)
    }

    /// For the transport: the file `peer` may download, from the first source
    /// that serves it.
    pub fn blob_path_for(&self, peer: &str, hash: &str) -> Option<PathBuf> {
        if !super::wire::is_hex64(hash) {
            return None;
        }
        let sources = self.blob_sources.read().unwrap_or_else(|e| e.into_inner()).clone();
        sources.iter().find_map(|s| s.blob_path_for(peer, hash))
    }

    fn link(&self) -> Arc<dyn FeatureLink> {
        self.link.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn notify_changed(&self, topic: &str) {
        self.link().notify_changed(topic);
    }

    pub fn fetch_blob(&self, hash: &str, max_size: u64, prefer: Vec<String>, dest: &Path) -> BlobFuture {
        self.link().fetch_blob(hash.to_owned(), max_size, prefer, dest.to_path_buf())
    }

    pub fn connected_peers(&self) -> Vec<String> {
        self.link().connected_peers()
    }
}

/// `true` for 1 to 16 lowercase ASCII letters.
pub fn is_topic(topic: &str) -> bool {
    (1..=16).contains(&topic.len()) && topic.bytes().all(|b| b.is_ascii_lowercase())
}

/// What the transport does with a received batch before `ingest`: drop
/// records whose id is not the BLAKE3 of the body, bodies over
/// [`MAX_RECORD_BYTES`], duplicates within the batch, and anything after
/// [`MAX_RECORDS_PER_BATCH`]. Returns the records to ingest and how many were
/// dropped (the transport logs dropped records with `log_rejection`).
pub fn check_incoming(records: Vec<FeatureRecord>) -> (Vec<FeatureRecord>, usize) {
    let total = records.len();
    let mut seen = std::collections::HashSet::new();
    let ok: Vec<FeatureRecord> = records
        .into_iter()
        .filter(|r| r.body.len() <= MAX_RECORD_BYTES && super::wire::is_hex64(&r.id) && r.id_matches())
        .filter(|r| seen.insert(r.id.clone()))
        .take(MAX_RECORDS_PER_BATCH)
        .collect();
    let dropped = total - ok.len();
    (ok, dropped)
}

/// In-memory sync for feature tests: no QUIC, same checks as the transport.
pub mod testing {
    use super::*;

    /// One pull from `from` to `to`, exactly as the transport does it:
    /// `from` offers the ids `to` may have, `to` asks for the unknown ones,
    /// `from` sends them (filtered again), the batch passes
    /// [`check_incoming`] in chunks of [`MAX_RECORDS_PER_BATCH`], then
    /// `to.ingest`. Returns the summed outcome and the dropped count.
    pub fn pull(
        from: (&str, &dyn FeatureSync),
        to: (&str, &dyn FeatureSync),
    ) -> Result<(FeatureIngest, usize), String> {
        let (from_pk, from_f) = from;
        let (to_pk, to_f) = to;
        assert_eq!(from_f.topic(), to_f.topic(), "pull between different topics");
        let offered = from_f.record_ids_for(to_pk)?;
        let mut total = FeatureIngest::default();
        let mut dropped = 0;
        for ids in offered.chunks(MAX_IDS_PER_FRAME) {
            let wanted = to_f.unknown_ids(ids)?;
            if wanted.is_empty() {
                continue;
            }
            let records = from_f.records_for(to_pk, &wanted)?;
            for chunk in records.chunks(MAX_RECORDS_PER_BATCH) {
                let (ok, d) = check_incoming(chunk.to_vec());
                dropped += d;
                if ok.is_empty() {
                    continue;
                }
                let got = to_f.ingest(from_pk, ok)?;
                total.accepted += got.accepted;
                total.rejected += got.rejected;
                total.changed |= got.changed;
            }
        }
        Ok((total, dropped))
    }

    /// Pulls in both directions between every pair until nothing new is
    /// accepted (at most `laptops.len() + 2` rounds). Returns the rounds used.
    pub fn sync_all(laptops: &[(&str, &dyn FeatureSync)]) -> Result<usize, String> {
        let max_rounds = laptops.len() + 2;
        for round in 1..=max_rounds {
            let mut accepted = 0;
            for a in laptops {
                for b in laptops {
                    if a.0 != b.0 {
                        accepted += pull(*a, *b)?.0.accepted;
                    }
                }
            }
            if accepted == 0 {
                return Ok(round);
            }
        }
        Err("sync_all tidak selesai dalam batas putaran".to_owned())
    }

    /// Copies a blob the way the transport would: asks `source` whether
    /// `peer` may have it, checks size and BLAKE3, writes `dest`.
    pub fn copy_blob(
        source: &dyn BlobSource,
        peer: &str,
        hash: &str,
        max_size: u64,
        dest: &Path,
    ) -> Result<u64, String> {
        let path = source.blob_path_for(peer, hash).ok_or("blob ditolak atau tidak ada")?;
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        if bytes.len() as u64 > max_size {
            return Err("blob lebih besar dari batas".to_owned());
        }
        if blake3::hash(&bytes).to_hex().as_str() != hash {
            return Err("hash blob tidak cocok".to_owned());
        }
        std::fs::write(dest, &bytes).map_err(|e| e.to_string())?;
        Ok(bytes.len() as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    /// A toy feature: records visible to everyone except keys in `hidden_for`.
    struct Toy {
        store: Mutex<BTreeMap<String, FeatureRecord>>,
        hidden_for: Vec<String>,
    }

    impl Toy {
        fn new(hidden_for: &[&str]) -> Self {
            Self {
                store: Mutex::new(BTreeMap::new()),
                hidden_for: hidden_for.iter().map(|s| s.to_string()).collect(),
            }
        }
        fn add(&self, body: &str) {
            let r = FeatureRecord::new(body);
            self.store.lock().unwrap().insert(r.id.clone(), r);
        }
        fn ids(&self) -> Vec<String> {
            self.store.lock().unwrap().keys().cloned().collect()
        }
    }

    impl FeatureSync for Toy {
        fn topic(&self) -> &'static str {
            "toy"
        }
        fn record_ids_for(&self, peer: &str) -> Result<Vec<String>, String> {
            if self.hidden_for.iter().any(|h| h == peer) {
                return Ok(vec![]);
            }
            Ok(self.ids())
        }
        fn unknown_ids(&self, ids: &[String]) -> Result<Vec<String>, String> {
            let s = self.store.lock().unwrap();
            Ok(ids.iter().filter(|i| !s.contains_key(*i)).cloned().collect())
        }
        fn records_for(&self, peer: &str, ids: &[String]) -> Result<Vec<FeatureRecord>, String> {
            if self.hidden_for.iter().any(|h| h == peer) {
                return Ok(vec![]);
            }
            let s = self.store.lock().unwrap();
            Ok(ids.iter().filter_map(|i| s.get(i).cloned()).collect())
        }
        fn ingest(&self, _from: &str, records: Vec<FeatureRecord>) -> Result<FeatureIngest, String> {
            let mut s = self.store.lock().unwrap();
            let mut out = FeatureIngest::default();
            for r in records {
                if r.body.starts_with("bad") {
                    out.rejected += 1;
                } else if s.insert(r.id.clone(), r).is_none() {
                    out.accepted += 1;
                    out.changed = true;
                }
            }
            Ok(out)
        }
    }

    const A: &str = "aa";
    const B: &str = "bb";
    const C: &str = "cc";

    #[test]
    fn record_id_is_blake3_hex() {
        let r = FeatureRecord::new("halo");
        assert_eq!(r.id.len(), 64);
        assert!(r.id_matches());
        let forged = FeatureRecord { id: r.id.clone(), body: "lain".into() };
        assert!(!forged.id_matches());
    }

    #[test]
    fn check_incoming_drops_forged_oversize_and_duplicates() {
        let good = FeatureRecord::new("ok");
        let forged = FeatureRecord { id: good.id.clone(), body: "palsu".into() };
        let big = FeatureRecord::new("x".repeat(MAX_RECORD_BYTES + 1));
        let (ok, dropped) = check_incoming(vec![good.clone(), forged, big, good.clone()]);
        assert_eq!(ok, vec![good]);
        assert_eq!(dropped, 3);
    }

    #[test]
    fn three_laptops_converge_and_scoping_holds() {
        let a = Toy::new(&[C]);
        let b = Toy::new(&[]);
        let c = Toy::new(&[]);
        a.add("rahasia tim");
        b.add("umum");
        c.add("bad record");
        let rounds = testing::sync_all(&[(A, &a), (B, &b), (C, &c)]).unwrap();
        assert!(rounds >= 2);
        assert_eq!(a.ids().len(), 2, "a gets umum, refuses bad");
        assert_eq!(b.ids().len(), 2);
        // C never receives A's record directly; B forwards it because B's
        // scoping (none) allows it. A real feature scopes on every laptop.
        assert!(c.ids().contains(&FeatureRecord::new("rahasia tim").id));
    }

    #[test]
    fn hub_replaces_same_topic_and_is_offline_by_default() {
        let hub = FeatureHub::default();
        hub.register(Arc::new(Toy::new(&[])));
        hub.register(Arc::new(Toy::new(&[])));
        assert_eq!(hub.features().len(), 1);
        assert!(hub.feature("toy").is_some());
        assert!(hub.connected_peers().is_empty());
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let res = rt.block_on(hub.fetch_blob(&"0".repeat(64), 10, vec![], Path::new("x")));
        assert!(res.is_err());
        assert!(hub.blob_path_for("aa", "not-hex").is_none());
    }

    #[test]
    fn topics_are_lowercase_letters() {
        for t in [TOPIC_CHAT, TOPIC_BOARD, TOPIC_DOCS, TOPIC_SIGN, TOPIC_JOIN, TOPIC_KOPI] {
            assert!(is_topic(t));
        }
        assert!(!is_topic("Chat"));
        assert!(!is_topic(""));
        assert!(!is_topic("a1"));
    }
}
