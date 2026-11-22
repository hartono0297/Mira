//! Transport for feature sync (`feature.rs`): sessions on the member
//! connection, scheduling, and the `FeatureLink` set on the hub.
//!
//! Session (one bidirectional stream per peer and topic, opened by the side
//! that offers):
//! 1. Initiator: `FeatureHave { topic, ids }` with at most
//!    `MAX_IDS_PER_FRAME` ids of `record_ids_for(peer)`.
//! 2. Responder: `FeatureWant { topic, ids }`, the offered ids it lacks
//!    (`unknown_ids`), never more than it was offered. Per session it reads
//!    at most `MAX_HAVES_PER_SESSION` `FeatureHave` frames, skips ids offered
//!    earlier in the session, and keeps at most `MAX_WANTED_PER_SESSION`
//!    ids outstanding.
//! 3. Initiator: `records_for(peer, want)` in parts of `RECORDS_FOR_CHUNK`
//!    ids, filtered to the wanted ids, sent as `FeatureRecords` batches
//!    (`wire::batch_records`) before the next part is loaded. Then the next
//!    `FeatureHave` chunk, and so on; finally the initiator finishes its side
//!    and waits for the responder to finish.
//! 4. Responder: keeps only records it asked for in this session, runs
//!    `check_incoming`, calls `ingest` on the blocking pool (one per peer and
//!    `MAX_CONCURRENT_INGEST` overall at once), emits
//!    `NetEvent::FeatureChanged` when `changed` (at most once per
//!    `EVENT_INTERVAL` per topic), and offers the topic to the other peers
//!    when `accepted > 0`. Dropped records are logged once per session with
//!    `log_rejection`.
//!
//! Both sides check membership again before every `records_for` and
//! `ingest`. A responder that does not know the topic, or already runs a
//! session for that peer and topic, stops the stream; the initiator ends
//! that session quietly. The connection stays up.
//!
//! Scheduling: one running session per (peer, topic) as initiator, started
//! at least `MIN_SESSION_GAP` apart; requests while it runs merge into one
//! follow-up session. `feature_notify` and gossip collect topics and
//! `feature_loop` offers them `NOTIFY_DELAY` after the first call; the same
//! loop syncs every topic with every peer each `PERIODIC_SYNC`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use quinn::{RecvStream, SendStream, VarInt};
use tokio::sync::{Notify, Semaphore};

use super::NetEvent;
use super::feature::{
    self, BlobFuture, FeatureHub, FeatureLink, FeatureRecord, FeatureSync, MAX_IDS_PER_FRAME,
    MAX_RECORDS_PER_BATCH,
};
use super::node::{Inner, READ_TIMEOUT, SYNC_SESSION_TIMEOUT, WRITE_TIMEOUT, lock};
use super::wire::{self, MAX_FRAME, Msg};

/// Wait after the first `feature_notify` (or gossip) so a burst of changes
/// becomes one round of sessions.
const NOTIFY_DELAY: Duration = Duration::from_millis(250);
/// Fallback: every topic with every peer this often.
const PERIODIC_SYNC: Duration = Duration::from_secs(60);
/// Least time between the starts of two initiator sessions for the same
/// peer and topic.
const MIN_SESSION_GAP: Duration = Duration::from_secs(2);
/// A peer that comes up again within this time gets `peer_connected` but no
/// new full sync.
const PEER_UP_QUIET: Duration = Duration::from_secs(10);
/// `FeatureChanged` per topic at most this often (the last change is always
/// emitted).
const EVENT_INTERVAL: Duration = Duration::from_millis(500);
/// Ids a responder keeps as "asked for" in one session.
const MAX_WANTED_PER_SESSION: usize = 30_000;
/// `FeatureHave` frames a responder reads in one session.
const MAX_HAVES_PER_SESSION: usize = 32;
/// Responder sessions per peer at once (one per topic in any case).
const MAX_RESPONDERS_PER_PEER: usize = 4;
/// `FeatureSync::ingest` calls running at once, over all sessions.
const MAX_CONCURRENT_INGEST: usize = 4;
/// `FeatureSync::ingest` calls for one peer at once.
const MAX_INGEST_PER_PEER: usize = 1;
/// Longest wait for an ingest slot before the session ends.
const INGEST_WAIT: Duration = Duration::from_secs(10);
/// Ids per `records_for` call at the initiator, so only a few records are
/// in memory at once.
const RECORDS_FOR_CHUNK: usize = 64;
/// Target JSON size of one `FeatureRecords` frame.
const RECORDS_BATCH_BYTES: usize = 1024 * 1024;
/// Largest `FeatureWant` frame the initiator reads (8192 ids are about
/// 550 KB).
const MAX_WANT_FRAME: usize = 1024 * 1024;
/// Largest frame the responder reads after the first one (`FeatureHave` or
/// `FeatureRecords`; `batch_records` leaves out records above
/// `MAX_FRAME / 2`).
const MAX_RECORDS_FRAME: usize = MAX_FRAME / 2 + 64 * 1024;
/// Stop code a responder uses for a topic it does not serve.
const STOP_UNKNOWN_TOPIC: u32 = 0x20;
/// Stop code a responder uses when it already runs a session for this peer
/// and topic, or too many for this peer.
const STOP_BUSY: u32 = 0x21;

type SessionKey = (String, String);
/// A record id (64 lowercase hex) as bytes.
type IdKey = [u8; 32];

/// State for feature sessions, held by `Inner`.
pub(crate) struct FeatureNet {
    pub(crate) hub: Arc<FeatureHub>,
    sessions: Mutex<SessionSlots>,
    responders: Mutex<ResponderSlots>,
    pending: Mutex<PendingTopics>,
    /// Wakes `feature_loop` after `feature_notify`. An `Arc` so the loop can
    /// wait on it without keeping `Inner` alive.
    wake: Arc<Notify>,
    ingest_slots: Arc<Semaphore>,
    ingest_by_peer: Mutex<PeerSemaphores>,
    events: Mutex<EventGate>,
    peer_ups: Mutex<RecentPeers>,
}

impl FeatureNet {
    pub(crate) fn new(hub: Arc<FeatureHub>) -> Self {
        Self {
            hub,
            sessions: Mutex::new(SessionSlots::default()),
            responders: Mutex::new(ResponderSlots::default()),
            pending: Mutex::new(PendingTopics::default()),
            wake: Arc::new(Notify::new()),
            ingest_slots: Arc::new(Semaphore::new(MAX_CONCURRENT_INGEST)),
            ingest_by_peer: Mutex::new(PeerSemaphores::default()),
            events: Mutex::new(EventGate::default()),
            peer_ups: Mutex::new(RecentPeers::default()),
        }
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

/// Initiator sessions per (peer, topic): running, asked for again while
/// running, and when the last one started.
#[derive(Default)]
struct SessionSlots {
    running: HashSet<SessionKey>,
    again: HashSet<SessionKey>,
    started: HashMap<SessionKey, Instant>,
}

impl SessionSlots {
    /// `Some(wait)` when the caller should start a session for `key` after
    /// `wait`; `None` when the request merged into the running session's
    /// follow-up.
    fn begin(&mut self, key: &SessionKey, now: Instant) -> Option<Duration> {
        if self.running.contains(key) {
            self.again.insert(key.clone());
            return None;
        }
        let running = &self.running;
        self.started.retain(|k, t| {
            running.contains(k) || now.saturating_duration_since(*t) < MIN_SESSION_GAP
        });
        self.running.insert(key.clone());
        Some(self.wait(key, now))
    }

    /// The session for `key` starts now; requests made before are covered.
    fn start(&mut self, key: &SessionKey, now: Instant) {
        self.again.remove(key);
        self.started.insert(key.clone(), now);
    }

    /// A session for `key` ended. `Some(wait)` when a follow-up session
    /// should start after `wait`; otherwise the slot is released.
    fn end(&mut self, key: &SessionKey, closing: bool, now: Instant) -> Option<Duration> {
        if self.again.remove(key) && !closing {
            return Some(self.wait(key, now));
        }
        self.running.remove(key);
        None
    }

    fn wait(&self, key: &SessionKey, now: Instant) -> Duration {
        self.started
            .get(key)
            .map(|t| (*t + MIN_SESSION_GAP).saturating_duration_since(now))
            .unwrap_or(Duration::ZERO)
    }
}

/// Responder sessions: one per (peer, topic), a few per peer.
#[derive(Default)]
struct ResponderSlots {
    active: HashSet<SessionKey>,
    per_peer: HashMap<String, usize>,
}

impl ResponderSlots {
    fn try_enter(&mut self, pk: &str, topic: &str) -> bool {
        let key = (pk.to_owned(), topic.to_owned());
        let n = self.per_peer.get(pk).copied().unwrap_or(0);
        if self.active.contains(&key) || n >= MAX_RESPONDERS_PER_PEER {
            return false;
        }
        self.active.insert(key);
        self.per_peer.insert(pk.to_owned(), n + 1);
        true
    }

    fn leave(&mut self, pk: &str, topic: &str) {
        if !self.active.remove(&(pk.to_owned(), topic.to_owned())) {
            return;
        }
        if let Some(n) = self.per_peer.get_mut(pk) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                self.per_peer.remove(pk);
            }
        }
    }
}

/// One semaphore per peer that is ingesting or waiting to. Idle entries are
/// removed on the next lookup, so the map stays as small as the live users.
#[derive(Default)]
struct PeerSemaphores(HashMap<String, Arc<Semaphore>>);

impl PeerSemaphores {
    fn get(&mut self, pk: &str) -> Arc<Semaphore> {
        // Only the map holds an idle entry; permits and waiters hold clones.
        self.0.retain(|_, s| Arc::strong_count(s) > 1);
        self.0
            .entry(pk.to_owned())
            .or_insert_with(|| Arc::new(Semaphore::new(MAX_INGEST_PER_PEER)))
            .clone()
    }
}

/// What to do with a `FeatureChanged` for a topic.
#[derive(Debug, PartialEq, Eq)]
enum Emit {
    Now,
    /// Emit after this wait (a trailing emit for this topic is now pending).
    After(Duration),
    /// A trailing emit is already pending and covers this change.
    Skip,
}

/// Limits `FeatureChanged` to one per `EVENT_INTERVAL` per topic without
/// losing the last change.
#[derive(Default)]
struct EventGate {
    last: HashMap<&'static str, Instant>,
    waiting: HashSet<&'static str>,
}

impl EventGate {
    fn on_change(&mut self, topic: &'static str, now: Instant) -> Emit {
        if self.waiting.contains(topic) {
            return Emit::Skip;
        }
        if let Some(t) = self.last.get(topic) {
            let since = now.saturating_duration_since(*t);
            if since < EVENT_INTERVAL {
                self.waiting.insert(topic);
                return Emit::After(EVENT_INTERVAL - since);
            }
        }
        self.last.insert(topic, now);
        Emit::Now
    }

    /// The trailing emit for `topic` happened.
    fn fired(&mut self, topic: &'static str, now: Instant) {
        self.waiting.remove(topic);
        self.last.insert(topic, now);
    }
}

/// Peers that came up recently, to skip repeated full syncs of a flapping
/// connection.
#[derive(Default)]
struct RecentPeers(HashMap<String, Instant>);

impl RecentPeers {
    /// Records that `pk` came up. `true` when it already came up less than
    /// `PEER_UP_QUIET` ago (the earlier time stays).
    fn came_up(&mut self, pk: &str, now: Instant) -> bool {
        self.0
            .retain(|_, t| now.saturating_duration_since(*t) < PEER_UP_QUIET);
        if self.0.contains_key(pk) {
            return true;
        }
        self.0.insert(pk.to_owned(), now);
        false
    }
}

/// Topics to offer soon, each with the one peer to leave out (the peer the
/// records came from), or `None` for all peers.
#[derive(Default)]
struct PendingTopics(BTreeMap<String, Option<String>>);

impl PendingTopics {
    fn add(&mut self, topic: &str, except: Option<&str>) {
        match self.0.get_mut(topic) {
            None => {
                self.0.insert(topic.to_owned(), except.map(str::to_owned));
            }
            // Two different sources (or a local change): every peer.
            Some(cur) if cur.as_deref() != except => *cur = None,
            Some(_) => {}
        }
    }

    fn drain(&mut self) -> Vec<(String, Option<String>)> {
        std::mem::take(&mut self.0).into_iter().collect()
    }
}

/// 64 lowercase hex characters as bytes; `None` for anything else.
fn id_key(id: &str) -> Option<IdKey> {
    fn nibble(b: u8) -> Option<u8> {
        match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'a'..=b'f' => Some(b - b'a' + 10),
            _ => None,
        }
    }
    let bytes = id.as_bytes();
    if bytes.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = (nibble(bytes[2 * i])? << 4) | nibble(bytes[2 * i + 1])?;
    }
    Some(out)
}

/// Responder bookkeeping for one session.
struct Session {
    /// Every valid id offered in this session (at most
    /// `haves_limit * MAX_IDS_PER_FRAME`).
    offered: HashSet<IdKey>,
    /// Ids asked for and not received yet.
    wanted: HashSet<IdKey>,
    haves: usize,
    haves_limit: usize,
    wanted_limit: usize,
}

impl Session {
    fn new(haves_limit: usize, wanted_limit: usize) -> Self {
        Self {
            offered: HashSet::new(),
            wanted: HashSet::new(),
            haves: 0,
            haves_limit,
            wanted_limit,
        }
    }

    /// A `FeatureHave`: the ids worth asking the feature about (valid, not
    /// offered before in this session), sorted, without duplicates. `None`
    /// when the frame has more than `MAX_IDS_PER_FRAME` ids or the session
    /// already had `haves_limit` frames (ends the session).
    fn candidates(&mut self, offered: Vec<String>) -> Option<Vec<String>> {
        if self.haves >= self.haves_limit || offered.len() > MAX_IDS_PER_FRAME {
            return None;
        }
        self.haves += 1;
        let mut ids: Vec<String> = offered
            .into_iter()
            .filter(|id| id_key(id).is_some_and(|k| self.offered.insert(k)))
            .collect();
        ids.sort();
        Some(ids)
    }

    /// Of `missing` (from `unknown_ids`), the ids to ask for: only
    /// `candidates`, sorted, without duplicates, remembered as asked for.
    /// `None` when that would pass the session limit (ends the session).
    fn ask(&mut self, candidates: &[String], missing: Vec<String>) -> Option<Vec<String>> {
        let offered: HashSet<&str> = candidates.iter().map(String::as_str).collect();
        let mut want: Vec<String> = missing
            .into_iter()
            .filter(|id| offered.contains(id.as_str()))
            .collect();
        want.sort();
        want.dedup();
        let keys: Vec<IdKey> = want
            .iter()
            .filter_map(|id| id_key(id))
            .filter(|k| !self.wanted.contains(k))
            .collect();
        if self.wanted.len() + keys.len() > self.wanted_limit {
            return None;
        }
        self.wanted.extend(keys);
        Some(want)
    }

    /// Keeps the records whose id was asked for (each id once) and returns
    /// them with the number dropped.
    fn take(&mut self, records: Vec<FeatureRecord>) -> (Vec<FeatureRecord>, usize) {
        let total = records.len();
        let kept: Vec<FeatureRecord> = records
            .into_iter()
            .filter(|r| id_key(&r.id).is_some_and(|k| self.wanted.remove(&k)))
            .collect();
        let dropped = total - kept.len();
        (kept, dropped)
    }
}

/// Holds a responder slot while a session runs; on drop (also when the
/// session is cancelled by its time limit) releases it and logs the records
/// dropped in the whole session as one entry.
struct ResponderGuard<'a> {
    inner: &'a Inner,
    pk: &'a str,
    topic: &'static str,
    dropped: usize,
}

impl<'a> ResponderGuard<'a> {
    fn enter(inner: &'a Inner, pk: &'a str, topic: &'static str) -> Option<Self> {
        lock(&inner.features.responders)
            .try_enter(pk, topic)
            .then_some(Self {
                inner,
                pk,
                topic,
                dropped: 0,
            })
    }
}

impl Drop for ResponderGuard<'_> {
    fn drop(&mut self) {
        lock(&self.inner.features.responders).leave(self.pk, self.topic);
        if self.dropped > 0 {
            let remote = self.inner.peer_conn(self.pk).map(|c| c.remote_address());
            // Only our own values go into the detail: the topic comes from
            // the registered feature, not from the peer.
            self.inner.log_rejection(
                Some(self.pk),
                remote,
                "feature_records_dropped",
                &format!(
                    "{} record fitur \"{}\" dari laptop rekan dibuang dalam satu sesi karena tidak diminta atau tidak lolos pemeriksaan.",
                    self.dropped, self.topic
                ),
            );
        }
    }
}

/// Initiator: a peer's `FeatureWant` reduced to ids offered in this chunk,
/// sorted, without duplicates.
fn filter_want(offered: &[String], want: Vec<String>) -> Vec<String> {
    let offered: HashSet<&str> = offered.iter().map(String::as_str).collect();
    let mut want: Vec<String> = want
        .into_iter()
        .filter(|id| offered.contains(id.as_str()))
        .collect();
    want.sort();
    want.dedup();
    want
}

/// Initiator: what `records_for` returned, reduced to the wanted ids, each
/// id once.
fn filter_records(records: Vec<FeatureRecord>, want: &[String]) -> Vec<FeatureRecord> {
    let want: HashSet<&str> = want.iter().map(String::as_str).collect();
    let mut sent: HashSet<String> = HashSet::new();
    records
        .into_iter()
        .filter(|r| want.contains(r.id.as_str()) && sent.insert(r.id.clone()))
        .collect()
}

/// Runs a synchronous feature call on the blocking pool.
async fn on_pool<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    tokio::task::spawn_blocking(f).await.ok()
}

impl Inner {
    /// A local change in `topic`: offer it to all connected peers after a
    /// short delay that merges bursts of calls.
    pub(crate) fn feature_notify(self: &Arc<Self>, topic: &str) {
        self.feature_pending(topic, None);
    }

    /// Records from `from` were accepted in `topic`: offer it to the other
    /// peers through the same delay as local changes.
    fn feature_gossip(self: &Arc<Self>, topic: &str, from: &str) {
        self.feature_pending(topic, Some(from));
    }

    fn feature_pending(self: &Arc<Self>, topic: &str, except: Option<&str>) {
        if self.is_closing() || !feature::is_topic(topic) {
            return;
        }
        if self.features.hub.feature(topic).is_none() {
            return;
        }
        lock(&self.features.pending).add(topic, except);
        self.features.wake.notify_one();
    }

    /// A member connection to `pk` is registered: call `peer_connected` on
    /// every feature (blocking pool), then sync every topic with `pk`. A
    /// peer that came up less than `PEER_UP_QUIET` ago gets no new full sync.
    pub(crate) fn feature_peer_up(self: &Arc<Self>, pk: &str) {
        if self.is_closing() {
            return;
        }
        let recent = lock(&self.features.peer_ups).came_up(pk, Instant::now());
        let me = self.clone();
        let pk = pk.to_owned();
        self.rt.spawn(async move {
            let features = me.features.hub.features();
            let list = features.clone();
            let peer = pk.clone();
            let _ = on_pool(move || {
                for f in &list {
                    f.peer_connected(&peer);
                }
            })
            .await;
            if recent {
                return;
            }
            for f in features {
                me.schedule_feature(&pk, f.topic());
            }
        });
    }

    /// Sync every registered topic with every connected peer except
    /// `except`.
    pub(crate) fn feature_sync_all(self: &Arc<Self>, except: Option<&str>) {
        if self.is_closing() {
            return;
        }
        let peers = self.connected_peers();
        for f in self.features.hub.features() {
            for pk in &peers {
                if Some(pk.as_str()) != except {
                    self.schedule_feature(pk, f.topic());
                }
            }
        }
    }

    /// Sync `topic` with every connected peer except `except`.
    fn feature_offer(self: &Arc<Self>, topic: &str, except: Option<&str>) {
        for pk in self.connected_peers() {
            if Some(pk.as_str()) != except {
                self.schedule_feature(&pk, topic);
            }
        }
    }

    /// Emits `FeatureChanged` for `topic`, at most once per `EVENT_INTERVAL`
    /// with a trailing emit for changes in between.
    fn feature_changed(self: &Arc<Self>, topic: &'static str) {
        let step = lock(&self.features.events).on_change(topic, Instant::now());
        match step {
            Emit::Now => self.emit(NetEvent::FeatureChanged { topic }),
            Emit::After(wait) => {
                let weak = Arc::downgrade(self);
                self.rt.spawn(async move {
                    tokio::time::sleep(wait).await;
                    let Some(inner) = weak.upgrade() else {
                        return;
                    };
                    lock(&inner.features.events).fired(topic, Instant::now());
                    inner.emit(NetEvent::FeatureChanged { topic });
                });
            }
            Emit::Skip => {}
        }
    }

    /// Runs a session for (`pk`, `topic`), merging requests that arrive while
    /// one runs into a single follow-up session, and keeping
    /// `MIN_SESSION_GAP` between session starts.
    fn schedule_feature(self: &Arc<Self>, pk: &str, topic: &str) {
        if self.is_closing() {
            return;
        }
        let key = (pk.to_owned(), topic.to_owned());
        let Some(mut wait) = lock(&self.features.sessions).begin(&key, Instant::now()) else {
            return;
        };
        let me = self.clone();
        self.rt.spawn(async move {
            loop {
                if !wait.is_zero() {
                    tokio::time::sleep(wait).await;
                }
                if me.is_closing() {
                    lock(&me.features.sessions).end(&key, true, Instant::now());
                    break;
                }
                lock(&me.features.sessions).start(&key, Instant::now());
                let _ = tokio::time::timeout(
                    SYNC_SESSION_TIMEOUT,
                    me.feature_sync_once(&key.0, &key.1),
                )
                .await;
                let next = lock(&me.features.sessions).end(&key, me.is_closing(), Instant::now());
                match next {
                    Some(w) => wait = w,
                    None => break,
                }
            }
        });
    }

    /// Initiator side: offer the ids the feature allows for `pk`, send
    /// exactly the requested records that `records_for` returns. Errors are
    /// not logged; the next scheduled session tries again.
    async fn feature_sync_once(self: &Arc<Self>, pk: &str, topic: &str) -> Result<(), String> {
        let Some(feature) = self.features.hub.feature(topic) else {
            return Ok(());
        };
        if !self.is_member(pk) {
            self.recheck_peers();
            return Ok(());
        }
        let Some(conn) = self.peer_conn(pk) else {
            return Ok(());
        };
        let (f, peer) = (feature.clone(), pk.to_owned());
        let ids = on_pool(move || f.record_ids_for(&peer))
            .await
            .ok_or("fitur gagal")??;
        if ids.is_empty() {
            return Ok(());
        }
        let (mut send, mut recv) = tokio::time::timeout(READ_TIMEOUT, conn.open_bi())
            .await
            .map_err(|_| "waktu tunggu habis saat membuka sesi fitur")?
            .map_err(|e| e.to_string())?;
        for chunk in ids.chunks(MAX_IDS_PER_FRAME) {
            let have = Msg::FeatureHave {
                topic: topic.to_owned(),
                ids: chunk.to_vec(),
            };
            if wire::write_msg_timeout(&mut send, &have, WRITE_TIMEOUT)
                .await
                .is_err()
            {
                // The responder stopped the stream (unknown topic, busy) or
                // left.
                return Ok(());
            }
            let want = match wire::read_msg_timeout(&mut recv, MAX_WANT_FRAME, READ_TIMEOUT).await {
                Ok(Some(Msg::FeatureWant { topic: t, ids })) if t == topic => ids,
                Ok(None) | Err(_) => return Ok(()),
                Ok(Some(_)) => return Err("jawaban sinkron fitur tidak sah".into()),
            };
            let want = filter_want(chunk, want);
            for part in want.chunks(RECORDS_FOR_CHUNK) {
                if !self.is_member(pk) {
                    return Ok(());
                }
                let (f, peer, ask) = (feature.clone(), pk.to_owned(), part.to_vec());
                let records = on_pool(move || f.records_for(&peer, &ask))
                    .await
                    .ok_or("fitur gagal")??;
                let records = filter_records(records, part);
                for batch in
                    wire::batch_records(records, MAX_RECORDS_PER_BATCH, RECORDS_BATCH_BYTES)
                {
                    let msg = Msg::FeatureRecords {
                        topic: topic.to_owned(),
                        records: batch,
                    };
                    if wire::write_msg_timeout(&mut send, &msg, WRITE_TIMEOUT)
                        .await
                        .is_err()
                    {
                        return Ok(());
                    }
                }
            }
        }
        let _ = send.finish();
        // Wait until the responder has ingested everything and finished its
        // side, so the session's records are stored when this returns.
        while let Ok(Some(_)) =
            wire::read_msg_timeout(&mut recv, MAX_WANT_FRAME, READ_TIMEOUT).await
        {}
        Ok(())
    }

    /// Responder side of a feature session. `first_ids` came with the first
    /// `FeatureHave`. The caller applies the session time limit and finishes
    /// `send` afterwards.
    pub(crate) async fn respond_feature(
        self: &Arc<Self>,
        pk: &str,
        topic: String,
        first_ids: Vec<String>,
        send: &mut SendStream,
        recv: &mut RecvStream,
    ) {
        let feature = if feature::is_topic(&topic) {
            self.features.hub.feature(&topic)
        } else {
            None
        };
        let Some(feature) = feature else {
            let _ = recv.stop(VarInt::from_u32(STOP_UNKNOWN_TOPIC));
            return;
        };
        let Some(mut guard) = ResponderGuard::enter(self, pk, feature.topic()) else {
            let _ = recv.stop(VarInt::from_u32(STOP_BUSY));
            return;
        };
        let mut session = Session::new(MAX_HAVES_PER_SESSION, MAX_WANTED_PER_SESSION);
        let mut have = Some(first_ids);
        loop {
            if let Some(ids) = have.take() {
                let Some(candidates) = session.candidates(ids) else {
                    return;
                };
                let missing = if candidates.is_empty() {
                    Vec::new()
                } else {
                    let (f, ask) = (feature.clone(), candidates.clone());
                    match on_pool(move || f.unknown_ids(&ask)).await {
                        Some(Ok(m)) => m,
                        _ => return,
                    }
                };
                let Some(want) = session.ask(&candidates, missing) else {
                    return;
                };
                let msg = Msg::FeatureWant {
                    topic: topic.clone(),
                    ids: want,
                };
                if wire::write_msg_timeout(send, &msg, WRITE_TIMEOUT)
                    .await
                    .is_err()
                {
                    return;
                }
            }
            match wire::read_msg_timeout(recv, MAX_RECORDS_FRAME, READ_TIMEOUT).await {
                Ok(Some(Msg::FeatureHave { topic: t, ids })) if t == topic => have = Some(ids),
                Ok(Some(Msg::FeatureRecords { topic: t, records })) if t == topic => {
                    let (kept, unasked) = session.take(records);
                    let (ok, failed) = feature::check_incoming(kept);
                    guard.dropped += unasked + failed;
                    if !ok.is_empty() && !self.ingest_feature_records(pk, &feature, ok).await {
                        return;
                    }
                }
                _ => return,
            }
        }
    }

    /// Hands checked records to `ingest` within the per-peer and global
    /// limits. `false` ends the session.
    async fn ingest_feature_records(
        self: &Arc<Self>,
        pk: &str,
        feature: &Arc<dyn FeatureSync>,
        records: Vec<FeatureRecord>,
    ) -> bool {
        let per_peer = lock(&self.features.ingest_by_peer).get(pk);
        let global = self.features.ingest_slots.clone();
        let permits = tokio::time::timeout(INGEST_WAIT, async move {
            let p = per_peer.acquire_owned().await.ok()?;
            let g = global.acquire_owned().await.ok()?;
            Some((p, g))
        })
        .await;
        let Ok(Some(permits)) = permits else {
            return false;
        };
        if !self.is_member(pk) {
            return false;
        }
        let (f, from) = (feature.clone(), pk.to_owned());
        // The permits move into the blocking call so the limits hold even
        // when the session is cancelled while `ingest` runs.
        let out = match on_pool(move || {
            let _permits = permits;
            f.ingest(&from, records)
        })
        .await
        {
            Some(Ok(out)) => out,
            _ => return false,
        };
        let topic = feature.topic();
        if out.changed {
            self.feature_changed(topic);
        }
        if out.accepted > 0 {
            self.feature_gossip(topic, pk);
        }
        true
    }
}

/// Background task: runs the delayed syncs after `feature_notify` and
/// gossip, and a periodic sync of every topic with every peer as a fallback.
pub(crate) async fn feature_loop(weak: Weak<Inner>) {
    let mut tick = tokio::time::interval(PERIODIC_SYNC);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    tick.tick().await;
    loop {
        let wake = match weak.upgrade() {
            Some(inner) if !inner.is_closing() => inner.features.wake.clone(),
            _ => break,
        };
        let notified = tokio::select! {
            _ = wake.notified() => true,
            _ = tick.tick() => false,
        };
        if notified {
            tokio::time::sleep(NOTIFY_DELAY).await;
        }
        let Some(inner) = weak.upgrade() else {
            break;
        };
        if inner.is_closing() {
            break;
        }
        if notified {
            let topics = lock(&inner.features.pending).drain();
            for (topic, except) in topics {
                inner.feature_offer(&topic, except.as_deref());
            }
        } else {
            inner.feature_sync_all(None);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(n: u32) -> String {
        format!("{n:064x}")
    }

    fn key(pk: &str, topic: &str) -> SessionKey {
        (pk.to_owned(), topic.to_owned())
    }

    #[test]
    fn id_key_decodes_lowercase_hex_only() {
        let k = id_key(&id(0x1ab)).unwrap();
        assert_eq!(&k[29..], &[0x00, 0x01, 0xab]);
        assert!(k[..29].iter().all(|b| *b == 0));
        let r = FeatureRecord::new("isi");
        assert_eq!(id_key(&r.id).unwrap(), *blake3::hash(b"isi").as_bytes());
        assert!(id_key(&"A".repeat(64)).is_none());
        assert!(id_key(&"g".repeat(64)).is_none());
        assert!(id_key(&"a".repeat(63)).is_none());
        assert!(id_key("").is_none());
    }

    #[test]
    fn want_is_limited_to_offered_chunk_sorted_and_unique() {
        let offered = vec![id(3), id(1), id(2)];
        let want = vec![id(2), id(9), id(1), id(2), "rusak".to_owned()];
        assert_eq!(filter_want(&offered, want), vec![id(1), id(2)]);
        assert!(filter_want(&offered, vec![]).is_empty());
    }

    #[test]
    fn records_are_limited_to_want_and_deduplicated() {
        let a = FeatureRecord::new("a");
        let b = FeatureRecord::new("b");
        let c = FeatureRecord::new("c");
        let want = vec![a.id.clone(), b.id.clone()];
        let out = filter_records(vec![a.clone(), c, b.clone(), a.clone()], &want);
        assert_eq!(out, vec![a, b]);
    }

    #[test]
    fn candidates_drop_invalid_duplicate_and_already_offered_ids() {
        let mut s = Session::new(10, 100);
        let got = s
            .candidates(vec![
                id(2),
                "bukan hex".into(),
                id(1),
                id(2),
                "A".repeat(64),
            ])
            .unwrap();
        assert_eq!(got, vec![id(1), id(2)]);
        // Offered again later in the session: skipped, even if not asked for.
        assert_eq!(
            s.candidates(vec![id(1), id(3), id(2)]).unwrap(),
            vec![id(3)]
        );
    }

    #[test]
    fn candidates_refuse_an_oversized_frame() {
        let mut s = Session::new(10, MAX_WANTED_PER_SESSION);
        let ids: Vec<String> = (0..=MAX_IDS_PER_FRAME as u32).map(id).collect();
        assert!(s.candidates(ids).is_none());
        let ids: Vec<String> = (0..MAX_IDS_PER_FRAME as u32).map(id).collect();
        assert_eq!(s.candidates(ids).unwrap().len(), MAX_IDS_PER_FRAME);
    }

    #[test]
    fn candidates_end_the_session_after_the_frame_limit() {
        let mut s = Session::new(3, 100);
        for n in 0..3 {
            assert!(s.candidates(vec![id(n)]).is_some());
        }
        assert!(s.candidates(vec![id(9)]).is_none());
        assert!(s.candidates(vec![]).is_none());
    }

    #[test]
    fn ask_keeps_only_offered_missing_ids_once() {
        let mut s = Session::new(10, 100);
        let cands = s.candidates(vec![id(1), id(2), id(3)]).unwrap();
        // The feature answers with an id that was not offered and a duplicate.
        let want = s.ask(&cands, vec![id(3), id(7), id(1), id(3)]).unwrap();
        assert_eq!(want, vec![id(1), id(3)]);
        assert_eq!(s.wanted.len(), 2);
    }

    #[test]
    fn ask_ends_the_session_past_the_limit() {
        let mut s = Session::new(10, 3);
        let ids: Vec<String> = (0..5).map(id).collect();
        let first = s.candidates(ids[..2].to_vec()).unwrap();
        assert_eq!(s.ask(&first, first.clone()).unwrap().len(), 2);
        let over = s.candidates(ids[2..].to_vec()).unwrap();
        assert!(s.ask(&over, over.clone()).is_none());
        // Exactly at the limit is fine.
        assert_eq!(s.ask(&over[..1], over[..1].to_vec()).unwrap().len(), 1);
    }

    #[test]
    fn take_keeps_only_asked_records_once() {
        let a = FeatureRecord::new("a");
        let b = FeatureRecord::new("b");
        let stranger = FeatureRecord::new("tidak diminta");
        let mut s = Session::new(10, 100);
        let cands = s.candidates(vec![a.id.clone(), b.id.clone()]).unwrap();
        s.ask(&cands, cands.clone()).unwrap();
        let (kept, dropped) = s.take(vec![a.clone(), stranger, a.clone()]);
        assert_eq!(kept, vec![a.clone()]);
        assert_eq!(dropped, 2);
        // `a` was delivered; sending it again is dropped, `b` still counts.
        let (kept, dropped) = s.take(vec![a, b.clone()]);
        assert_eq!(kept, vec![b]);
        assert_eq!(dropped, 1);
        assert!(s.wanted.is_empty());
    }

    #[test]
    fn sessions_run_once_with_one_merged_follow_up() {
        let mut s = SessionSlots::default();
        let t0 = Instant::now();
        let k = key("aa", "chat");
        assert_eq!(s.begin(&k, t0), Some(Duration::ZERO));
        // Requests before the session starts are covered by it.
        assert_eq!(s.begin(&k, t0), None);
        s.start(&k, t0);
        assert!(s.again.is_empty());
        // Another topic or peer runs on its own.
        assert!(s.begin(&key("aa", "board"), t0).is_some());
        assert!(s.begin(&key("bb", "chat"), t0).is_some());
        // Two requests while running give exactly one follow-up, which keeps
        // the gap from the last start.
        assert_eq!(s.begin(&k, t0), None);
        assert_eq!(s.begin(&k, t0), None);
        let t1 = t0 + Duration::from_millis(500);
        assert_eq!(s.end(&k, false, t1), Some(Duration::from_millis(1500)));
        s.start(&k, t0 + MIN_SESSION_GAP);
        let t2 = t0 + Duration::from_secs(10);
        assert_eq!(s.end(&k, false, t2), None);
        assert_eq!(s.begin(&k, t2), Some(Duration::ZERO));
    }

    #[test]
    fn a_new_session_waits_for_the_gap_after_the_last_start() {
        let mut s = SessionSlots::default();
        let t0 = Instant::now();
        let k = key("aa", "chat");
        s.begin(&k, t0);
        s.start(&k, t0);
        assert_eq!(s.end(&k, false, t0 + Duration::from_millis(100)), None);
        let t1 = t0 + Duration::from_millis(500);
        assert_eq!(s.begin(&k, t1), Some(Duration::from_millis(1500)));
        // Old start times of idle keys are pruned.
        let k2 = key("bb", "chat");
        s.begin(&k2, t1);
        s.start(&k2, t1);
        s.end(&k2, false, t1);
        s.begin(&key("cc", "chat"), t1 + Duration::from_secs(5));
        assert!(!s.started.contains_key(&k2));
        assert!(s.started.contains_key(&k), "running keys keep their start");
    }

    #[test]
    fn closing_skips_the_follow_up_and_frees_the_slot() {
        let mut s = SessionSlots::default();
        let t0 = Instant::now();
        let k = key("aa", "chat");
        assert!(s.begin(&k, t0).is_some());
        s.start(&k, t0);
        assert!(s.begin(&k, t0).is_none());
        assert_eq!(s.end(&k, true, t0), None);
        assert!(s.running.is_empty() && s.again.is_empty());
    }

    #[test]
    fn responders_allow_one_per_topic_and_a_few_per_peer() {
        let mut r = ResponderSlots::default();
        assert!(r.try_enter("aa", "chat"));
        assert!(!r.try_enter("aa", "chat"));
        assert!(r.try_enter("bb", "chat"));
        for t in ["board", "docs", "sign"] {
            assert!(r.try_enter("aa", t));
        }
        assert!(!r.try_enter("aa", "extra"));
        r.leave("aa", "docs");
        assert!(r.try_enter("aa", "extra"));
        // Leaving twice or leaving an unknown slot changes nothing.
        r.leave("bb", "chat");
        r.leave("bb", "chat");
        r.leave("cc", "chat");
        assert!(!r.per_peer.contains_key("bb"));
        assert_eq!(r.per_peer["aa"], MAX_RESPONDERS_PER_PEER);
        for t in ["chat", "board", "sign", "extra"] {
            r.leave("aa", t);
        }
        assert!(r.active.is_empty() && r.per_peer.is_empty());
    }

    #[test]
    fn peer_semaphores_are_shared_while_used_and_pruned_when_idle() {
        let mut m = PeerSemaphores::default();
        let a = m.get("aa");
        let permit = a.clone().try_acquire_owned().unwrap();
        drop(a);
        // Still in use (the permit holds it): the same semaphore, now full.
        let again = m.get("aa");
        assert!(again.clone().try_acquire_owned().is_err());
        drop(again);
        drop(permit);
        m.get("bb");
        assert!(!m.0.contains_key("aa"), "idle entry removed");
        assert_eq!(m.0.len(), 1);
    }

    #[test]
    fn event_gate_emits_at_most_once_per_interval_with_a_trailing_emit() {
        let mut g = EventGate::default();
        let t0 = Instant::now();
        assert_eq!(g.on_change("chat", t0), Emit::Now);
        let t1 = t0 + Duration::from_millis(100);
        assert_eq!(
            g.on_change("chat", t1),
            Emit::After(Duration::from_millis(400))
        );
        assert_eq!(g.on_change("chat", t1), Emit::Skip);
        // Other topics are independent.
        assert_eq!(g.on_change("board", t1), Emit::Now);
        let t2 = t0 + EVENT_INTERVAL;
        g.fired("chat", t2);
        assert_eq!(
            g.on_change("chat", t2 + Duration::from_millis(100)),
            Emit::After(Duration::from_millis(400))
        );
        g.fired("chat", t2 + EVENT_INTERVAL);
        assert_eq!(g.on_change("chat", t2 + 2 * EVENT_INTERVAL), Emit::Now);
    }

    #[test]
    fn recent_peers_skip_repeated_full_syncs() {
        let mut p = RecentPeers::default();
        let t0 = Instant::now();
        assert!(!p.came_up("aa", t0));
        assert!(p.came_up("aa", t0 + Duration::from_secs(5)));
        assert!(!p.came_up("bb", t0 + Duration::from_secs(5)));
        // The first time counts, so a flapping peer gets a full sync again
        // once the quiet time since that first time is over.
        assert!(!p.came_up("aa", t0 + PEER_UP_QUIET));
        assert!(!p.0.is_empty());
        p.came_up("cc", t0 + Duration::from_secs(60));
        assert_eq!(p.0.len(), 1, "old entries pruned");
    }

    #[test]
    fn pending_topics_merge_sources_and_drain() {
        let mut p = PendingTopics::default();
        p.add("chat", Some("aa"));
        p.add("chat", Some("aa"));
        p.add("board", Some("aa"));
        p.add("board", Some("bb"));
        p.add("docs", Some("aa"));
        p.add("docs", None);
        p.add("sign", None);
        p.add("sign", Some("aa"));
        assert_eq!(
            p.drain(),
            vec![
                ("board".to_owned(), None),
                ("chat".to_owned(), Some("aa".to_owned())),
                ("docs".to_owned(), None),
                ("sign".to_owned(), None),
            ]
        );
        assert!(p.drain().is_empty());
    }
}
