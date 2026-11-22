//! Transport for feature sync (`feature.rs`): sessions on the member
//! connection, scheduling, and the `FeatureLink` set on the hub.
//!
//! Session (one bidirectional stream per peer and topic, opened by the side
//! that offers):
//! 1. Initiator: `FeatureHave { topic, ids }` with at most
//!    `MAX_IDS_PER_FRAME` ids of `record_ids_for(peer)`.
//! 2. Responder: `FeatureWant { topic, ids }`, the offered ids it lacks
//!    (`unknown_ids`), never more than it was offered. Ids asked for in the
//!    previous chunk and never delivered are forgotten when the next
//!    `FeatureHave` arrives, so at most one chunk is outstanding.
//! 3. Initiator: `records_for(peer, want)` in parts of `RECORDS_FOR_CHUNK`
//!    ids, filtered to the wanted ids and collected into `FeatureRecords`
//!    batches of up to `MAX_RECORDS_PER_BATCH` records or about
//!    `RECORDS_BATCH_BYTES`. Then the next `FeatureHave` chunk, and so on;
//!    finally the initiator finishes its side and waits for the responder to
//!    finish.
//! 4. Responder: keeps only records it asked for, runs `check_incoming`,
//!    calls `ingest` on the blocking pool (one per peer and
//!    `MAX_CONCURRENT_INGEST` overall at once), emits
//!    `NetEvent::FeatureChanged` when `changed` (at most once per
//!    `EVENT_INTERVAL` per topic), and offers the topic to the other peers
//!    when `accepted > 0`. Dropped records are logged once per session with
//!    `log_rejection`.
//!
//! Both sides check membership again before every `records_for` and
//! `ingest`. A responder that does not know the topic stops the stream and
//! finishes its side; the initiator ends that session quietly. A responder
//! that is busy with the same peer and topic, or that ends a session early,
//! resets its side; the initiator then retries a few times. The connection
//! stays up in every case.
//!
//! Scheduling: one running session per (peer, topic) as initiator, started
//! at least `MIN_SESSION_GAP` apart; requests while it runs merge into one
//! follow-up session, and an incomplete session is retried up to
//! `MAX_RETRIES` times. `feature_notify` and gossip collect topics and
//! `feature_loop` offers them `NOTIFY_DELAY` after the first call; the same
//! loop syncs every topic with every peer each `PERIODIC_SYNC`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use quinn::{RecvStream, SendStream, VarInt};
use serde::Deserialize;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::{Notify, Semaphore};

use super::NetEvent;
use super::feature::{
    self, BlobFuture, FeatureHub, FeatureLink, FeatureRecord, FeatureSync, MAX_IDS_PER_FRAME,
    MAX_RECORDS_PER_BATCH,
};
use super::node::{Inner, READ_TIMEOUT, SYNC_SESSION_TIMEOUT, WRITE_TIMEOUT, lock};
use super::wire::{self, MAX_FRAME, Msg, WireError};

/// Wait after the first `feature_notify` (or gossip) so a burst of changes
/// becomes one round of sessions.
const NOTIFY_DELAY: Duration = Duration::from_millis(250);
/// Fallback: every topic with every peer this often.
const PERIODIC_SYNC: Duration = Duration::from_secs(60);
/// Least time between the starts of two initiator sessions for the same
/// peer and topic, and the wait before retrying an incomplete one.
const MIN_SESSION_GAP: Duration = Duration::from_secs(2);
/// Retries of an incomplete session before it waits for the next trigger.
const MAX_RETRIES: u8 = 3;
/// `FeatureChanged` per topic at most this often (the last change is always
/// emitted).
const EVENT_INTERVAL: Duration = Duration::from_millis(500);
/// Ids a responder keeps as "asked for" at once. The plan named 100,000;
/// since leftovers are cleared at every `FeatureHave`, at most one chunk
/// (`MAX_IDS_PER_FRAME`, 8192) is outstanding in a correct session, so this
/// is only a defensive bound and the lower value costs nothing.
const MAX_WANTED_PER_SESSION: usize = 30_000;
/// Responder sessions per peer at once (one per topic in any case).
const MAX_RESPONDERS_PER_PEER: usize = 4;
/// `FeatureSync::ingest` calls running at once, over all sessions.
const MAX_CONCURRENT_INGEST: usize = 4;
/// `FeatureSync::ingest` calls for one peer at once.
const MAX_INGEST_PER_PEER: usize = 1;
/// Longest wait for an ingest slot before the session ends.
const INGEST_WAIT: Duration = Duration::from_secs(10);
/// Initiator limit for frame reads and writes once records are on the way:
/// the responder may be waiting for an ingest slot meanwhile.
const RECORD_PHASE_TIMEOUT: Duration = INGEST_WAIT.saturating_add(READ_TIMEOUT);
/// Ids per `records_for` call at the initiator, so only a few records are
/// loaded at once.
const RECORDS_FOR_CHUNK: usize = 64;
/// Target JSON size of one `FeatureRecords` frame.
const RECORDS_BATCH_BYTES: usize = 1024 * 1024;
/// Largest `FeatureHave` or `FeatureWant` frame (8192 ids are about 550 KB).
const MAX_IDS_FRAME: usize = 1024 * 1024;
/// Largest `FeatureRecords` frame the responder reads (`FeatureBatcher`
/// leaves out records above `MAX_FRAME / 2`).
const MAX_RECORDS_FRAME: usize = MAX_FRAME / 2 + 64 * 1024;
/// Stop code a responder uses for a topic it does not serve.
const STOP_UNKNOWN_TOPIC: u32 = 0x20;
/// Stop and reset code a responder uses when it already runs a session for
/// this peer and topic, or too many for this peer.
const STOP_BUSY: u32 = 0x21;
/// Reset code a responder uses when it ends a session early.
const RESET_ABORTED: u32 = 0x22;

type SessionKey = (String, String);
/// A record id (64 lowercase hex) as bytes.
type IdKey = [u8; 32];

/// How an initiator session ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    /// Done, or nothing to do (unknown topic, peer gone, not a member).
    Done,
    /// Busy responder, time limit, stream or feature error: retry.
    Incomplete,
}

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
/// running, retries of incomplete sessions, and when the last one started.
#[derive(Default)]
struct SessionSlots {
    running: HashSet<SessionKey>,
    again: HashSet<SessionKey>,
    retries: HashMap<SessionKey, u8>,
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

    /// A session for `key` ended with `outcome`. `Some(wait)` when another
    /// session should start after `wait` (a retry, or a follow-up asked for
    /// meanwhile); otherwise the slot is released.
    fn end(
        &mut self,
        key: &SessionKey,
        outcome: Outcome,
        closing: bool,
        now: Instant,
    ) -> Option<Duration> {
        if closing {
            self.release(key);
            return None;
        }
        let requested = self.again.remove(key);
        match outcome {
            Outcome::Incomplete => {
                let n = self.retries.entry(key.clone()).or_insert(0);
                if *n < MAX_RETRIES {
                    *n += 1;
                    return Some(MIN_SESSION_GAP);
                }
            }
            Outcome::Done => {
                self.retries.remove(key);
            }
        }
        if requested {
            return Some(self.wait(key, now));
        }
        self.release(key);
        None
    }

    /// Frees the slot for `key` (also used when a session task dies).
    fn release(&mut self, key: &SessionKey) {
        self.running.remove(key);
        self.again.remove(key);
        self.retries.remove(key);
    }

    fn wait(&self, key: &SessionKey, now: Instant) -> Duration {
        self.started
            .get(key)
            .map(|t| (*t + MIN_SESSION_GAP).saturating_duration_since(now))
            .unwrap_or(Duration::ZERO)
    }
}

/// Releases an initiator slot if the session task ends without doing so
/// itself (panic, or the runtime dropping the task).
struct SlotGuard {
    inner: Arc<Inner>,
    key: SessionKey,
    armed: bool,
}

impl SlotGuard {
    /// The slot was released normally; a new session may own it now.
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for SlotGuard {
    fn drop(&mut self) {
        if self.armed {
            lock(&self.inner.features.sessions).release(&self.key);
        }
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
    /// Ids asked for in the current chunk and not received yet.
    wanted: HashSet<IdKey>,
    wanted_limit: usize,
}

impl Session {
    fn new(wanted_limit: usize) -> Self {
        Self {
            wanted: HashSet::new(),
            wanted_limit,
        }
    }

    /// A new `FeatureHave`: forgets ids of the previous chunk that never
    /// arrived and returns the offered ids worth asking the feature about
    /// (valid, sorted, without duplicates). `None` when the frame has more
    /// than `MAX_IDS_PER_FRAME` ids (ends the session).
    fn next_have(&mut self, offered: Vec<String>) -> Option<Vec<String>> {
        if offered.len() > MAX_IDS_PER_FRAME {
            return None;
        }
        self.wanted.clear();
        let mut seen: HashSet<IdKey> = HashSet::with_capacity(offered.len());
        let mut ids: Vec<String> = offered
            .into_iter()
            .filter(|id| id_key(id).is_some_and(|k| !self.wanted.contains(&k) && seen.insert(k)))
            .collect();
        ids.sort();
        Some(ids)
    }

    /// Of `missing` (from `unknown_ids`), the ids to ask for: only
    /// `candidates`, sorted, without duplicates, remembered as asked for.
    /// `None` when that would pass the limit (ends the session).
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

/// Collects records into `FeatureRecords` batches of at most
/// `MAX_RECORDS_PER_BATCH` records and about `RECORDS_BATCH_BYTES` of JSON,
/// one record at a time (same rules as `wire::batch_records`).
#[derive(Default)]
struct FeatureBatcher {
    batch: Vec<FeatureRecord>,
    bytes: usize,
}

impl FeatureBatcher {
    /// Adds `record`; returns a full batch to send first, if any. A record
    /// whose JSON exceeds `MAX_FRAME / 2` is left out.
    fn push(&mut self, record: FeatureRecord) -> Option<Vec<FeatureRecord>> {
        let size = serde_json::to_vec(&record)
            .map(|v| v.len())
            .unwrap_or(usize::MAX);
        if size > MAX_FRAME / 2 {
            return None;
        }
        let full = !self.batch.is_empty()
            && (self.batch.len() >= MAX_RECORDS_PER_BATCH
                || self.bytes + size > RECORDS_BATCH_BYTES);
        let out = full.then(|| {
            self.bytes = 0;
            std::mem::take(&mut self.batch)
        });
        self.bytes += size + 1;
        self.batch.push(record);
        out
    }

    /// The last, partial batch.
    fn finish(&mut self) -> Option<Vec<FeatureRecord>> {
        self.bytes = 0;
        (!self.batch.is_empty()).then(|| std::mem::take(&mut self.batch))
    }
}

/// Only the tag of a frame. Every other field is skipped by serde_json
/// without building values, so probing a large frame allocates nothing.
#[derive(Deserialize)]
struct FrameTag {
    t: String,
}

/// Responder: whether a frame body read under `MAX_RECORDS_FRAME` may be
/// decoded. Frames above `MAX_IDS_FRAME` must be `FeatureRecords`, so a
/// large `FeatureHave` (or anything else) never decodes into millions of
/// strings.
fn frame_allowed(body: &[u8]) -> bool {
    if body.len() <= MAX_IDS_FRAME {
        return true;
    }
    matches!(
        serde_json::from_slice::<FrameTag>(body),
        Ok(FrameTag { t }) if t == "feature_records"
    )
}

/// Reads one frame body (as `wire::read_msg`, without decoding). `Ok(None)`
/// when the stream ended cleanly before a new frame.
async fn read_frame_body<R: AsyncRead + Unpin>(
    r: &mut R,
    max: usize,
) -> Result<Option<Vec<u8>>, WireError> {
    let mut header = [0u8; 4];
    let mut filled = 0;
    while filled < header.len() {
        let n = r
            .read(&mut header[filled..])
            .await
            .map_err(|e| WireError::Io(e.to_string()))?;
        if n == 0 {
            return if filled == 0 {
                Ok(None)
            } else {
                Err(WireError::Truncated)
            };
        }
        filled += n;
    }
    let len = u32::from_be_bytes(header) as usize;
    if len > max.min(MAX_FRAME) {
        return Err(WireError::TooLarge(len));
    }
    if len == 0 {
        return Err(WireError::Malformed("frame kosong".into()));
    }
    let mut body = Vec::new();
    let read = (&mut *r)
        .take(len as u64)
        .read_to_end(&mut body)
        .await
        .map_err(|e| WireError::Io(e.to_string()))?;
    if read != len {
        return Err(WireError::Truncated);
    }
    Ok(Some(body))
}

/// Responder: the next frame of a session within `READ_TIMEOUT`, at most
/// `MAX_RECORDS_FRAME` bytes and `MAX_IDS_FRAME` unless it is
/// `FeatureRecords`.
async fn read_responder_frame<R: AsyncRead + Unpin>(r: &mut R) -> Result<Option<Msg>, WireError> {
    let read = async {
        let Some(body) = read_frame_body(r, MAX_RECORDS_FRAME).await? else {
            return Ok(None);
        };
        if !frame_allowed(&body) {
            return Err(WireError::TooLarge(body.len()));
        }
        wire::decode(&body).map(Some)
    };
    tokio::time::timeout(READ_TIMEOUT, read)
        .await
        .map_err(|_| WireError::Timeout)?
}

/// Holds a responder slot while a session runs; on drop (also when the
/// session is cancelled by its time limit) releases it and logs the records
/// dropped in the whole session as one entry.
struct ResponderGuard {
    inner: Arc<Inner>,
    pk: String,
    topic: &'static str,
    dropped: usize,
}

impl ResponderGuard {
    fn enter(inner: &Arc<Inner>, pk: &str, topic: &'static str) -> Option<Self> {
        lock(&inner.features.responders)
            .try_enter(pk, topic)
            .then(|| Self {
                inner: inner.clone(),
                pk: pk.to_owned(),
                topic,
                dropped: 0,
            })
    }
}

impl Drop for ResponderGuard {
    fn drop(&mut self) {
        lock(&self.inner.features.responders).leave(&self.pk, self.topic);
        if self.dropped == 0 {
            return;
        }
        let remote = self.inner.peer_conn(&self.pk).map(|c| c.remote_address());
        // Only our own values go into the detail: the topic comes from the
        // registered feature, not from the peer.
        let detail = format!(
            "{} record fitur \"{}\" dari laptop rekan dibuang dalam satu sesi karena tidak diminta atau tidak lolos pemeriksaan.",
            self.dropped, self.topic
        );
        let inner = self.inner.clone();
        let pk = std::mem::take(&mut self.pk);
        // The log is a database write: keep it off the async workers.
        self.inner.rt.spawn_blocking(move || {
            inner.log_rejection(Some(&pk), remote, "feature_records_dropped", &detail);
        });
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

/// Initiator: sends one `FeatureRecords` frame. `false` on a stream error.
async fn send_records(
    send: &mut SendStream,
    topic: &str,
    records: Option<Vec<FeatureRecord>>,
) -> bool {
    let Some(records) = records else {
        return true;
    };
    let msg = Msg::FeatureRecords {
        topic: topic.to_owned(),
        records,
    };
    wire::write_msg_timeout(send, &msg, RECORD_PHASE_TIMEOUT)
        .await
        .is_ok()
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
    /// quick reconnect is rate limited by `MIN_SESSION_GAP`, not skipped.
    pub(crate) fn feature_peer_up(self: &Arc<Self>, pk: &str) {
        if self.is_closing() {
            return;
        }
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
                    if !inner.is_closing() {
                        inner.emit(NetEvent::FeatureChanged { topic });
                    }
                });
            }
            Emit::Skip => {}
        }
    }

    /// Runs a session for (`pk`, `topic`), merging requests that arrive while
    /// one runs into a single follow-up session, retrying incomplete ones a
    /// few times, and keeping `MIN_SESSION_GAP` between session starts.
    fn schedule_feature(self: &Arc<Self>, pk: &str, topic: &str) {
        if self.is_closing() {
            return;
        }
        let key = (pk.to_owned(), topic.to_owned());
        let Some(mut wait) = lock(&self.features.sessions).begin(&key, Instant::now()) else {
            return;
        };
        let mut guard = SlotGuard {
            inner: self.clone(),
            key,
            armed: true,
        };
        self.rt.spawn(async move {
            let me = guard.inner.clone();
            let key = guard.key.clone();
            loop {
                if !wait.is_zero() {
                    tokio::time::sleep(wait).await;
                }
                if me.is_closing() {
                    break;
                }
                lock(&me.features.sessions).start(&key, Instant::now());
                let outcome = tokio::time::timeout(
                    SYNC_SESSION_TIMEOUT,
                    me.feature_sync_once(&key.0, &key.1),
                )
                .await
                .unwrap_or(Outcome::Incomplete);
                let next =
                    lock(&me.features.sessions).end(&key, outcome, me.is_closing(), Instant::now());
                match next {
                    Some(w) => wait = w,
                    None => {
                        // `end` released the slot; a new session for this
                        // key may already own it.
                        guard.disarm();
                        break;
                    }
                }
            }
        });
    }

    /// Initiator side: offer the ids the feature allows for `pk`, send
    /// exactly the requested records that `records_for` returns. Nothing is
    /// logged; an incomplete session is retried by `schedule_feature`.
    async fn feature_sync_once(self: &Arc<Self>, pk: &str, topic: &str) -> Outcome {
        use Outcome::{Done, Incomplete};
        let Some(feature) = self.features.hub.feature(topic) else {
            return Done;
        };
        if !self.is_member(pk) {
            self.recheck_peers();
            return Done;
        }
        let Some(conn) = self.peer_conn(pk) else {
            return Done;
        };
        let (f, peer) = (feature.clone(), pk.to_owned());
        let Some(Ok(ids)) = on_pool(move || f.record_ids_for(&peer)).await else {
            return Incomplete;
        };
        if ids.is_empty() {
            return Done;
        }
        let Ok(Ok((mut send, mut recv))) = tokio::time::timeout(READ_TIMEOUT, conn.open_bi()).await
        else {
            return Incomplete;
        };
        let mut first = true;
        for chunk in ids.chunks(MAX_IDS_PER_FRAME) {
            let have = Msg::FeatureHave {
                topic: topic.to_owned(),
                ids: chunk.to_vec(),
            };
            let limit = if first {
                WRITE_TIMEOUT
            } else {
                RECORD_PHASE_TIMEOUT
            };
            if wire::write_msg_timeout(&mut send, &have, limit)
                .await
                .is_err()
            {
                return Incomplete;
            }
            // After the first chunk the responder may still be ingesting.
            let limit = if first {
                READ_TIMEOUT
            } else {
                RECORD_PHASE_TIMEOUT
            };
            first = false;
            let want = match wire::read_msg_timeout(&mut recv, MAX_IDS_FRAME, limit).await {
                Ok(Some(Msg::FeatureWant { topic: t, ids })) if t == topic => ids,
                // Unknown topic: the responder stopped and finished.
                Ok(None) => return Done,
                // Busy, aborted, time limit or broken stream.
                Err(_) => return Incomplete,
                // A peer that answers nonsense is not retried.
                Ok(Some(_)) => return Done,
            };
            let want = filter_want(chunk, want);
            let mut batcher = FeatureBatcher::default();
            for part in want.chunks(RECORDS_FOR_CHUNK) {
                if !self.is_member(pk) {
                    return Done;
                }
                let (f, peer, ask) = (feature.clone(), pk.to_owned(), part.to_vec());
                let Some(Ok(records)) = on_pool(move || f.records_for(&peer, &ask)).await else {
                    return Incomplete;
                };
                for r in filter_records(records, part) {
                    if !send_records(&mut send, topic, batcher.push(r)).await {
                        return Incomplete;
                    }
                }
            }
            if !send_records(&mut send, topic, batcher.finish()).await {
                return Incomplete;
            }
        }
        let _ = send.finish();
        // Wait until the responder has ingested everything and finished its
        // side, so the session's records are stored when this returns. A
        // reset (aborted ingest) or time limit means the session is not done.
        loop {
            match wire::read_msg_timeout(&mut recv, MAX_IDS_FRAME, RECORD_PHASE_TIMEOUT).await {
                Ok(None) => return Done,
                Ok(Some(_)) => {}
                Err(_) => return Incomplete,
            }
        }
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
            let _ = send.reset(VarInt::from_u32(STOP_BUSY));
            return;
        };
        let complete = self
            .feature_session(pk, &feature, &mut guard, first_ids, send, recv)
            .await;
        if !complete {
            let _ = recv.stop(VarInt::from_u32(RESET_ABORTED));
            let _ = send.reset(VarInt::from_u32(RESET_ABORTED));
        }
    }

    /// The responder's frame loop. `true` when the initiator finished its
    /// side and everything was handled; `false` when the session ended
    /// early.
    async fn feature_session(
        self: &Arc<Self>,
        pk: &str,
        feature: &Arc<dyn FeatureSync>,
        guard: &mut ResponderGuard,
        first_ids: Vec<String>,
        send: &mut SendStream,
        recv: &mut RecvStream,
    ) -> bool {
        let topic = feature.topic();
        let mut session = Session::new(MAX_WANTED_PER_SESSION);
        let mut have = Some(first_ids);
        loop {
            if let Some(ids) = have.take() {
                let Some(candidates) = session.next_have(ids) else {
                    return false;
                };
                let missing = if candidates.is_empty() {
                    Vec::new()
                } else {
                    let (f, ask) = (feature.clone(), candidates.clone());
                    match on_pool(move || f.unknown_ids(&ask)).await {
                        Some(Ok(m)) => m,
                        _ => return false,
                    }
                };
                let Some(want) = session.ask(&candidates, missing) else {
                    return false;
                };
                let msg = Msg::FeatureWant {
                    topic: topic.to_owned(),
                    ids: want,
                };
                if wire::write_msg_timeout(send, &msg, WRITE_TIMEOUT)
                    .await
                    .is_err()
                {
                    return false;
                }
            }
            match read_responder_frame(recv).await {
                Ok(None) => return true,
                Ok(Some(Msg::FeatureHave { topic: t, ids })) if t == topic => have = Some(ids),
                Ok(Some(Msg::FeatureRecords { topic: t, records })) if t == topic => {
                    let (kept, unasked) = session.take(records);
                    let (ok, failed) = feature::check_incoming(kept);
                    guard.dropped += unasked + failed;
                    if !ok.is_empty() && !self.ingest_feature_records(pk, feature, ok).await {
                        return false;
                    }
                }
                _ => return false,
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

    fn frame(msg: &Msg) -> Vec<u8> {
        wire::encode(msg).unwrap()
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
    fn next_have_drops_invalid_and_duplicate_ids() {
        let mut s = Session::new(100);
        let got = s
            .next_have(vec![
                id(2),
                "bukan hex".into(),
                id(1),
                id(2),
                "A".repeat(64),
            ])
            .unwrap();
        assert_eq!(got, vec![id(1), id(2)]);
        // A later frame may offer the same ids again (no session-wide set).
        assert_eq!(s.next_have(vec![id(1), id(3)]).unwrap(), vec![id(1), id(3)]);
    }

    #[test]
    fn next_have_refuses_an_oversized_frame_but_not_many_frames() {
        let mut s = Session::new(MAX_WANTED_PER_SESSION);
        let ids: Vec<String> = (0..=MAX_IDS_PER_FRAME as u32).map(id).collect();
        assert!(s.next_have(ids).is_none());
        let ids: Vec<String> = (0..MAX_IDS_PER_FRAME as u32).map(id).collect();
        assert_eq!(s.next_have(ids).unwrap().len(), MAX_IDS_PER_FRAME);
        // Far more frames than the old cap of 32 are fine.
        for n in 0..100 {
            assert!(s.next_have(vec![id(n)]).is_some());
        }
    }

    #[test]
    fn next_have_forgets_undelivered_ids_of_the_previous_chunk() {
        let mut s = Session::new(100);
        let a = FeatureRecord::new("a");
        let b = FeatureRecord::new("b");
        let cands = s.next_have(vec![a.id.clone(), b.id.clone()]).unwrap();
        s.ask(&cands, cands.clone()).unwrap();
        assert_eq!(s.wanted.len(), 2);
        let (kept, _) = s.take(vec![a.clone()]);
        assert_eq!(kept.len(), 1);
        // `b` never came; the next chunk clears it.
        s.next_have(vec![id(1)]).unwrap();
        assert!(s.wanted.is_empty());
        let (kept, dropped) = s.take(vec![b]);
        assert!(kept.is_empty());
        assert_eq!(dropped, 1);
    }

    #[test]
    fn ask_keeps_only_offered_missing_ids_once() {
        let mut s = Session::new(100);
        let cands = s.next_have(vec![id(1), id(2), id(3)]).unwrap();
        // The feature answers with an id that was not offered and a duplicate.
        let want = s.ask(&cands, vec![id(3), id(7), id(1), id(3)]).unwrap();
        assert_eq!(want, vec![id(1), id(3)]);
        assert_eq!(s.wanted.len(), 2);
    }

    #[test]
    fn ask_ends_the_session_past_the_limit() {
        let mut s = Session::new(3);
        let cands = s.next_have((0..5).map(id).collect()).unwrap();
        assert_eq!(s.ask(&cands[..2], cands[..2].to_vec()).unwrap().len(), 2);
        assert!(s.ask(&cands[2..], cands[2..].to_vec()).is_none());
        // Exactly at the limit is fine.
        assert_eq!(s.ask(&cands[2..3], cands[2..3].to_vec()).unwrap().len(), 1);
    }

    #[test]
    fn take_keeps_only_asked_records_once() {
        let a = FeatureRecord::new("a");
        let b = FeatureRecord::new("b");
        let stranger = FeatureRecord::new("tidak diminta");
        let mut s = Session::new(100);
        let cands = s.next_have(vec![a.id.clone(), b.id.clone()]).unwrap();
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
    fn batcher_respects_count_and_bytes_and_keeps_every_record() {
        let mut b = FeatureBatcher::default();
        let small: Vec<FeatureRecord> = (0..1300)
            .map(|i| FeatureRecord::new(format!("r{i}")))
            .collect();
        let mut batches = Vec::new();
        for r in small.clone() {
            batches.extend(b.push(r));
        }
        batches.extend(b.finish());
        assert_eq!(
            batches.iter().map(Vec::len).collect::<Vec<_>>(),
            vec![512, 512, 276]
        );
        assert_eq!(batches.concat(), small);
        assert!(b.finish().is_none());

        let big: Vec<FeatureRecord> = (0..8)
            .map(|i| FeatureRecord::new(format!("{i}{}", "x".repeat(200 * 1024))))
            .collect();
        let mut batches = Vec::new();
        for r in big.clone() {
            batches.extend(b.push(r));
        }
        batches.extend(b.finish());
        assert!(batches.len() >= 2);
        for batch in &batches {
            let m = Msg::FeatureRecords {
                topic: "chat".into(),
                records: batch.clone(),
            };
            assert!(wire::encoded_len(&m) <= MAX_RECORDS_FRAME);
        }
        assert_eq!(batches.concat(), big);
    }

    #[test]
    fn batcher_frames_fit_the_responder_limit_even_with_escaping() {
        let nasty = FeatureRecord::new("\u{1}".repeat(feature::MAX_RECORD_BYTES));
        let mut b = FeatureBatcher::default();
        assert!(b.push(nasty.clone()).is_none());
        let batch = b.finish().unwrap();
        let m = Msg::FeatureRecords {
            topic: "chat".into(),
            records: batch,
        };
        let len = wire::encoded_len(&m);
        assert!(len <= MAX_RECORDS_FRAME, "{len}");
        assert!(frame_allowed(&serde_json::to_vec(&m).unwrap()));
    }

    #[test]
    fn large_frames_must_be_records() {
        let small = serde_json::to_vec(&Msg::FeatureHave {
            topic: "chat".into(),
            ids: vec![id(1)],
        })
        .unwrap();
        assert!(frame_allowed(&small));
        // A FeatureHave of empty strings above the ids limit.
        let junk = serde_json::to_vec(&Msg::FeatureHave {
            topic: "chat".into(),
            ids: vec![String::new(); MAX_IDS_FRAME / 2],
        })
        .unwrap();
        assert!(junk.len() > MAX_IDS_FRAME);
        assert!(!frame_allowed(&junk));
        let records = serde_json::to_vec(&Msg::FeatureRecords {
            topic: "chat".into(),
            records: vec![FeatureRecord::new("x".repeat(MAX_IDS_FRAME + 1))],
        })
        .unwrap();
        assert!(frame_allowed(&records));
        assert!(!frame_allowed(&vec![b'x'; MAX_IDS_FRAME + 1]));
        // The largest real FeatureHave fits the ids limit.
        let have = Msg::FeatureHave {
            topic: "abcdefghijklmnop".into(),
            ids: vec!["f".repeat(64); MAX_IDS_PER_FRAME],
        };
        assert!(wire::encoded_len(&have) <= MAX_IDS_FRAME);
    }

    #[tokio::test]
    async fn responder_frames_are_read_within_limits() {
        let rec = FeatureRecord::new("isi");
        let mut bytes = frame(&Msg::FeatureHave {
            topic: "chat".into(),
            ids: vec![id(1)],
        });
        bytes.extend(frame(&Msg::FeatureRecords {
            topic: "chat".into(),
            records: vec![rec.clone()],
        }));
        let mut r: &[u8] = &bytes;
        assert!(matches!(
            read_responder_frame(&mut r).await,
            Ok(Some(Msg::FeatureHave { .. }))
        ));
        match read_responder_frame(&mut r).await {
            Ok(Some(Msg::FeatureRecords { records, .. })) => assert_eq!(records, vec![rec]),
            other => panic!("{other:?}"),
        }
        assert!(matches!(read_responder_frame(&mut r).await, Ok(None)));

        let junk = frame(&Msg::FeatureHave {
            topic: "chat".into(),
            ids: vec![String::new(); MAX_IDS_FRAME / 2],
        });
        let mut r: &[u8] = &junk;
        assert!(matches!(
            read_responder_frame(&mut r).await,
            Err(WireError::TooLarge(_))
        ));

        let mut header = ((MAX_RECORDS_FRAME + 1) as u32).to_be_bytes().to_vec();
        header.extend([b'{'; 16]);
        let mut r: &[u8] = &header;
        assert!(matches!(
            read_responder_frame(&mut r).await,
            Err(WireError::TooLarge(n)) if n == MAX_RECORDS_FRAME + 1
        ));

        let mut r: &[u8] = &[0, 0];
        assert!(matches!(
            read_responder_frame(&mut r).await,
            Err(WireError::Truncated)
        ));
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
        assert_eq!(
            s.end(&k, Outcome::Done, false, t1),
            Some(Duration::from_millis(1500))
        );
        s.start(&k, t0 + MIN_SESSION_GAP);
        let t2 = t0 + Duration::from_secs(10);
        assert_eq!(s.end(&k, Outcome::Done, false, t2), None);
        assert_eq!(s.begin(&k, t2), Some(Duration::ZERO));
    }

    #[test]
    fn a_new_session_waits_for_the_gap_after_the_last_start() {
        let mut s = SessionSlots::default();
        let t0 = Instant::now();
        let k = key("aa", "chat");
        s.begin(&k, t0);
        s.start(&k, t0);
        let t = t0 + Duration::from_millis(100);
        assert_eq!(s.end(&k, Outcome::Done, false, t), None);
        let t1 = t0 + Duration::from_millis(500);
        assert_eq!(s.begin(&k, t1), Some(Duration::from_millis(1500)));
        // Old start times of idle keys are pruned.
        let k2 = key("bb", "chat");
        s.begin(&k2, t1);
        s.start(&k2, t1);
        s.end(&k2, Outcome::Done, false, t1);
        s.begin(&key("cc", "chat"), t1 + Duration::from_secs(5));
        assert!(!s.started.contains_key(&k2));
        assert!(s.started.contains_key(&k), "running keys keep their start");
    }

    #[test]
    fn incomplete_sessions_retry_a_few_times_then_wait_for_a_trigger() {
        let mut s = SessionSlots::default();
        let t0 = Instant::now();
        let k = key("aa", "chat");
        s.begin(&k, t0);
        for _ in 0..MAX_RETRIES {
            s.start(&k, t0);
            assert_eq!(
                s.end(&k, Outcome::Incomplete, false, t0),
                Some(MIN_SESSION_GAP)
            );
        }
        s.start(&k, t0);
        assert_eq!(s.end(&k, Outcome::Incomplete, false, t0), None);
        assert!(s.running.is_empty() && s.retries.is_empty());
        // A new trigger gets fresh retries.
        assert!(s.begin(&k, t0 + Duration::from_secs(5)).is_some());
        s.start(&k, t0 + Duration::from_secs(5));
        assert_eq!(
            s.end(&k, Outcome::Incomplete, false, t0 + Duration::from_secs(5)),
            Some(MIN_SESSION_GAP)
        );
    }

    #[test]
    fn retries_reset_after_a_complete_session() {
        let mut s = SessionSlots::default();
        let t0 = Instant::now();
        let k = key("aa", "chat");
        s.begin(&k, t0);
        s.start(&k, t0);
        assert!(s.end(&k, Outcome::Incomplete, false, t0).is_some());
        s.start(&k, t0);
        // A request arrived during the retry: the follow-up still runs.
        assert!(s.begin(&k, t0).is_none());
        let t1 = t0 + Duration::from_secs(1);
        assert_eq!(
            s.end(&k, Outcome::Done, false, t1),
            Some(Duration::from_secs(1))
        );
        assert!(!s.retries.contains_key(&k));
    }

    #[test]
    fn a_trigger_after_exhausted_retries_still_runs_the_follow_up() {
        let mut s = SessionSlots::default();
        let t0 = Instant::now();
        let k = key("aa", "chat");
        s.begin(&k, t0);
        for _ in 0..MAX_RETRIES {
            s.start(&k, t0);
            s.end(&k, Outcome::Incomplete, false, t0);
        }
        s.start(&k, t0);
        assert!(s.begin(&k, t0).is_none());
        let t1 = t0 + Duration::from_secs(3);
        assert_eq!(
            s.end(&k, Outcome::Incomplete, false, t1),
            Some(Duration::ZERO)
        );
        s.start(&k, t1);
        assert_eq!(s.end(&k, Outcome::Incomplete, false, t1), None);
    }

    #[test]
    fn closing_skips_the_follow_up_and_frees_the_slot() {
        let mut s = SessionSlots::default();
        let t0 = Instant::now();
        let k = key("aa", "chat");
        assert!(s.begin(&k, t0).is_some());
        s.start(&k, t0);
        assert!(s.begin(&k, t0).is_none());
        assert_eq!(s.end(&k, Outcome::Incomplete, true, t0), None);
        assert!(s.running.is_empty() && s.again.is_empty() && s.retries.is_empty());
    }

    #[test]
    fn release_frees_a_slot_left_by_a_dead_task() {
        let mut s = SessionSlots::default();
        let t0 = Instant::now();
        let k = key("aa", "chat");
        s.begin(&k, t0);
        s.begin(&k, t0);
        s.release(&k);
        assert!(s.running.is_empty() && s.again.is_empty());
        assert!(s.begin(&k, t0).is_some());
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

    #[test]
    fn record_phase_timeout_allows_for_the_ingest_wait() {
        assert!(RECORD_PHASE_TIMEOUT >= INGEST_WAIT + READ_TIMEOUT);
        assert!(RECORD_PHASE_TIMEOUT < SYNC_SESSION_TIMEOUT);
    }
}
