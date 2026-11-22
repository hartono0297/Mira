//! Transport for feature sync (`feature.rs`): sessions on the member
//! connection, scheduling, and the `FeatureLink` set on the hub.
//!
//! Session (one bidirectional stream per peer and topic, opened by the side
//! that offers):
//! 1. Initiator: `FeatureHave { topic, ids }` with at most
//!    `MAX_IDS_PER_FRAME` ids of `record_ids_for(peer)`.
//! 2. Responder: `FeatureWant { topic, ids }`, the offered ids it lacks
//!    (`unknown_ids`), never more than it was offered.
//! 3. Initiator: `records_for(peer, want)`, filtered to the wanted ids, sent
//!    as `FeatureRecords` batches (`wire::batch_records`). Then the next
//!    `FeatureHave` chunk, and so on; finally the initiator finishes its side.
//! 4. Responder: keeps only records it asked for in this session, runs
//!    `check_incoming`, logs dropped records with `log_rejection`, calls
//!    `ingest` on the blocking pool, emits `NetEvent::FeatureChanged` when
//!    `changed`, and offers the topic to the other peers when `accepted > 0`.
//!
//! A responder that does not know the topic stops the stream; the
//! initiator ends that session quietly. The connection stays up.
//!
//! STUB: filled in by the implementation task (docs/plans/transport-fitur.md).

use std::sync::{Arc, Weak};

use quinn::{RecvStream, SendStream};

use super::feature::{BlobFuture, FeatureHub, FeatureLink};
use super::node::Inner;

/// State for feature sessions, held by `Inner`.
pub(crate) struct FeatureNet {
    pub(crate) hub: Arc<FeatureHub>,
}

impl FeatureNet {
    pub(crate) fn new(hub: Arc<FeatureHub>) -> Self {
        Self { hub }
    }
}

/// The `FeatureLink` set on the hub while the network runs. Holds a weak
/// reference so the hub does not keep a stopped network alive.
pub(crate) struct NetLink {
    inner: Weak<Inner>,
}

impl NetLink {
    pub(crate) fn new(inner: Weak<Inner>) -> Self {
        Self { inner }
    }
}

impl FeatureLink for NetLink {
    fn notify_changed(&self, topic: &str) {
        if let Some(inner) = self.inner.upgrade() {
            inner.feature_notify(topic);
        }
    }

    fn fetch_blob(
        &self,
        hash: String,
        max_size: u64,
        prefer: Vec<String>,
        dest: std::path::PathBuf,
    ) -> BlobFuture {
        let inner = self.inner.upgrade();
        Box::pin(async move {
            match inner {
                Some(inner) => inner.fetch_blob(hash, max_size, prefer, dest).await,
                None => Err("Jaringan Mira tidak berjalan.".to_owned()),
            }
        })
    }

    fn connected_peers(&self) -> Vec<String> {
        self.inner
            .upgrade()
            .map(|i| i.connected_peers())
            .unwrap_or_default()
    }
}

impl Inner {
    /// A local change in `topic`: offer it to all connected peers after a
    /// short delay that merges bursts of calls.
    pub(crate) fn feature_notify(self: &Arc<Self>, _topic: &str) {}

    /// A member connection to `pk` is registered: call `peer_connected` on
    /// every feature (blocking pool), then sync every topic with `pk`.
    pub(crate) fn feature_peer_up(self: &Arc<Self>, _pk: &str) {}

    /// Sync every registered topic with every connected peer except
    /// `except`.
    pub(crate) fn feature_sync_all(self: &Arc<Self>, _except: Option<&str>) {}

    /// Responder side of a feature session. `first_ids` came with the first
    /// `FeatureHave`. The caller applies the session time limit and finishes
    /// `send` afterwards.
    pub(crate) async fn respond_feature(
        self: &Arc<Self>,
        _pk: &str,
        _topic: String,
        _first_ids: Vec<String>,
        _send: &mut SendStream,
        recv: &mut RecvStream,
    ) {
        let _ = recv.stop(quinn::VarInt::from_u32(0));
    }
}

/// Background task: runs the delayed syncs after `feature_notify` and a
/// periodic sync of every topic with every peer as a fallback.
pub(crate) async fn feature_loop(_weak: Weak<Inner>) {}
