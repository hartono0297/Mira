//! Blob transfer for features (`feature.rs`): each download on its own
//! bidirectional stream of the member connection.
//!
//! Requester: `BlobGet { hash }`. Server: `BlobHeader { size }` followed by
//! exactly `size` raw bytes and the end of the stream, or
//! `BlobRefused { code }` (`busy` or `unavailable`).
//!
//! Server, in this order: more than `BLOB_GETS_PER_SECOND` requests from the
//! peer in the last second: `busy`. Hash not 64 hex: `unavailable` (format
//! only). No free serve slot (`MAX_SERVES` at once, `MAX_SERVES_PER_PEER` per
//! peer): `busy`. Only then `is_member` and
//! `FeatureHub::blob_path_for(peer, hash)` on the blocking pool; a blob that
//! does not exist and one the peer may not have both get `unavailable`. So
//! `busy` says nothing about whether a blob exists. During a long transfer it
//! asks again every `RECHECK_EVERY` bytes and resets the stream when access
//! was revoked, and resets it when the file turns out shorter or longer than
//! announced.
//!
//! Requester: `dest` must be an absolute path to a file in an existing
//! folder. One fetch per `dest` at a time; a `dest` that already holds the
//! blob is returned without the network. At most `MAX_DOWNLOADS` downloads at
//! once and `MAX_DOWNLOADS_PER_PEER` per peer, at most one `BlobGet` per
//! `CLIENT_GET_GAP` to the same peer (below the server's rate limit).
//! Preferred connected peers first, then the other connected peers; a peer
//! that answers `busy` is asked again after 1 to 2 seconds, a few times,
//! within `DOWNLOAD_QUEUE_TIMEOUT`. It refuses more than `max_size` bytes,
//! reads exactly `size` bytes and then requires the end of the stream, writes
//! to a temporary file next to `dest` ([`BlobWriter`], on the blocking pool),
//! checks BLAKE3, and only then moves the file to `dest`. A local failure
//! (disk, rename) ends the fetch without asking other peers. On any error
//! `dest` is removed unless it already holds the blob.
//!
//! Both sides limit a transfer to `transfer_limit(size)` and require at least
//! `WINDOW_MIN_BYTES` per `THROUGHPUT_WINDOW` ([`Throughput`]), so a peer
//! that trickles bytes cannot hold a slot for long.
//!
//! A crash during a download can leave a `*.part-*` file next to `dest`;
//! the feature that owns the folder may sweep those at startup.

use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use quinn::{Connection, RecvStream, SendStream, VarInt};
use rand_core::{OsRng, RngCore};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard, OwnedSemaphorePermit, Semaphore, mpsc};
use tokio::time::Instant;

use super::node::{Inner, READ_TIMEOUT, WRITE_TIMEOUT, code, lock};
use super::wire::{self, Msg};

/// Blobs served at once, all peers together.
const MAX_SERVES: usize = 8;
/// Blobs served at once to one peer.
const MAX_SERVES_PER_PEER: usize = 2;
/// `BlobGet` requests per peer per `RATE_WINDOW`; more get `busy`.
const BLOB_GETS_PER_SECOND: u32 = 10;
const RATE_WINDOW: Duration = Duration::from_secs(1);
/// Requester side: least time between two `BlobGet` to one peer (8 per
/// second, below `BLOB_GETS_PER_SECOND`).
const CLIENT_GET_GAP: Duration = Duration::from_millis(125);
/// Downloads at once on this laptop.
const MAX_DOWNLOADS: usize = 4;
/// Downloads at once from one peer (a connection has 8 stream slots).
const MAX_DOWNLOADS_PER_PEER: usize = 2;
/// How long a download waits for a free slot, and the overall limit for
/// retrying busy peers.
const DOWNLOAD_QUEUE_TIMEOUT: Duration = Duration::from_secs(60);
/// Attempts per peer that answers `busy`.
const MAX_BUSY_TRIES: u32 = 4;
/// Next look at a peer whose local download slots are all taken.
const LOCAL_BUSY_RETRY: Duration = Duration::from_millis(250);
/// Raw bytes per read or write.
const CHUNK: usize = 64 * 1024;
/// Chunks buffered between the network and the disk, each direction.
const CHUNK_QUEUE: usize = 8;
/// One read of blob bytes, or one hand-over to the disk writer; longer
/// means the other side stalled.
const STALL_TIMEOUT: Duration = Duration::from_secs(15);
/// How long the requester waits for the disk writer to finish (sync and
/// rename) after the last byte.
const WRITER_WAIT: Duration = Duration::from_secs(120);
/// Transfer time limit: `TRANSFER_BASE` plus the size at `MIN_AVG_RATE`
/// bytes per second, at most `TRANSFER_MAX`.
const TRANSFER_BASE: Duration = Duration::from_secs(60);
const MIN_AVG_RATE: u64 = 256 * 1024;
const TRANSFER_MAX: Duration = Duration::from_secs(30 * 60);
/// Rolling throughput floor: at least `WINDOW_MIN_BYTES` (or what is left)
/// in every `THROUGHPUT_WINDOW`.
const THROUGHPUT_WINDOW: Duration = Duration::from_secs(30);
/// About 34 KB/s: slow VPN links pass, a peer trickling bytes to hold a
/// transfer slot does not.
const WINDOW_MIN_BYTES: u64 = 1024 * 1024;
/// The server checks membership and access again after this many bytes.
const RECHECK_EVERY: u64 = 4 * 1024 * 1024;
/// Largest header frame (`BlobHeader` or `BlobRefused`).
const MAX_HEADER_FRAME: usize = 1024;
/// Longest `dest` file name (bytes) used in the temporary name; longer names
/// get `TMP_FALLBACK_NAME` so the path stays within limits.
const MAX_TMP_BASE: usize = 64;
const TMP_FALLBACK_NAME: &str = "mira-blob";
/// Rename attempts when the target is locked (Windows: virus scanner or an
/// open handle).
const RENAME_TRIES: u32 = 5;
const RENAME_BACKOFF: Duration = Duration::from_millis(100);

const STOPPING: &str = "Jaringan Mira sedang berhenti.";

/// Limits for blob transfers, held by `Inner`.
pub(crate) struct BlobState {
    serves: ServeLimiter,
    serve_rate: PeerRate,
    downloads: Semaphore,
    peer_downloads: PeerSemaphores,
    pacer: Pacer,
    fetches: FetchLocks,
}

impl BlobState {
    pub(crate) fn new() -> Self {
        Self {
            serves: ServeLimiter::new(MAX_SERVES, MAX_SERVES_PER_PEER),
            serve_rate: PeerRate::new(BLOB_GETS_PER_SECOND, RATE_WINDOW),
            downloads: Semaphore::new(MAX_DOWNLOADS),
            peer_downloads: PeerSemaphores::new(MAX_DOWNLOADS_PER_PEER),
            pacer: Pacer::new(CLIENT_GET_GAP),
            fetches: FetchLocks::default(),
        }
    }
}

/// Why one download attempt failed.
#[derive(Debug, Clone, PartialEq, Eq)]
enum FetchError {
    /// The peer answered `busy`: ask it again later.
    Busy(String),
    /// Something about this peer or its data: try the next peer.
    Peer(String),
    /// Something on this laptop (disk, rename, shutdown): stop.
    Local(String),
}

impl FetchError {
    fn into_message(self) -> String {
        match self {
            FetchError::Busy(m) | FetchError::Peer(m) | FetchError::Local(m) => m,
        }
    }
}

// ----- Limits -----------------------------------------------------------------

#[derive(Default)]
struct ServeCounts {
    total: usize,
    per_peer: HashMap<String, usize>,
}

/// Serves in progress, globally and per peer.
struct ServeLimiter {
    max_total: usize,
    max_per_peer: usize,
    counts: Arc<Mutex<ServeCounts>>,
}

/// One serve in progress; releases its place on drop.
struct ServeSlot {
    pk: String,
    counts: Arc<Mutex<ServeCounts>>,
}

impl ServeLimiter {
    fn new(max_total: usize, max_per_peer: usize) -> Self {
        Self {
            max_total,
            max_per_peer,
            counts: Arc::default(),
        }
    }

    fn try_acquire(&self, pk: &str) -> Option<ServeSlot> {
        let mut c = lock(&self.counts);
        if c.total >= self.max_total {
            return None;
        }
        let n = c.per_peer.entry(pk.to_owned()).or_insert(0);
        if *n >= self.max_per_peer {
            return None;
        }
        *n += 1;
        c.total += 1;
        Some(ServeSlot {
            pk: pk.to_owned(),
            counts: self.counts.clone(),
        })
    }
}

impl Drop for ServeSlot {
    fn drop(&mut self) {
        let mut c = lock(&self.counts);
        c.total = c.total.saturating_sub(1);
        if let Some(n) = c.per_peer.get_mut(&self.pk) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                c.per_peer.remove(&self.pk);
            }
        }
    }
}

/// At most `max` events per peer per `window` (fixed windows). Entries of
/// expired windows are dropped on every call, so the map only holds peers
/// active in the last window.
struct PeerRate {
    max: u32,
    window: Duration,
    map: Mutex<HashMap<String, (Instant, u32)>>,
}

impl PeerRate {
    fn new(max: u32, window: Duration) -> Self {
        Self {
            max,
            window,
            map: Mutex::new(HashMap::new()),
        }
    }

    fn check(&self, pk: &str, now: Instant) -> bool {
        let mut map = lock(&self.map);
        map.retain(|_, (start, _)| now.saturating_duration_since(*start) < self.window);
        let (_, n) = map.entry(pk.to_owned()).or_insert((now, 0));
        if *n >= self.max {
            return false;
        }
        *n += 1;
        true
    }
}

/// Requester side: spaces `BlobGet` to one peer at least `gap` apart.
struct Pacer {
    gap: Duration,
    next: Mutex<HashMap<String, Instant>>,
}

impl Pacer {
    fn new(gap: Duration) -> Self {
        Self {
            gap,
            next: Mutex::new(HashMap::new()),
        }
    }

    /// Reserves the next send time for `pk` (`now` or later).
    fn reserve(&self, pk: &str, now: Instant) -> Instant {
        let mut map = lock(&self.next);
        map.retain(|_, t| *t > now);
        let at = map.get(pk).copied().unwrap_or(now).max(now);
        map.insert(pk.to_owned(), at + self.gap);
        at
    }
}

/// One semaphore per peer for downloads. Entries no permit refers to are
/// dropped on the next lookup.
struct PeerSemaphores {
    per_peer: usize,
    map: Mutex<HashMap<String, Arc<Semaphore>>>,
}

impl PeerSemaphores {
    fn new(per_peer: usize) -> Self {
        Self {
            per_peer,
            map: Mutex::new(HashMap::new()),
        }
    }

    fn try_acquire(&self, pk: &str) -> Option<OwnedSemaphorePermit> {
        let sem = {
            let mut map = lock(&self.map);
            map.retain(|_, s| Arc::strong_count(s) > 1);
            map.entry(pk.to_owned())
                .or_insert_with(|| Arc::new(Semaphore::new(self.per_peer)))
                .clone()
        };
        sem.try_acquire_owned().ok()
    }
}

type FetchMap = Arc<Mutex<HashMap<PathBuf, Arc<AsyncMutex<()>>>>>;

/// Serializes fetches to the same `dest`.
#[derive(Default)]
struct FetchLocks {
    map: FetchMap,
}

/// The turn of one fetch; the next fetch to the same `dest` starts when the
/// last clone is dropped. The blocking writer holds a clone, so a writer that
/// is still finishing keeps the turn even after the fetch returned.
struct FetchTurn {
    guard: Option<OwnedMutexGuard<()>>,
    key: PathBuf,
    map: FetchMap,
}

impl FetchLocks {
    async fn turn(&self, key: PathBuf) -> Arc<FetchTurn> {
        let m = {
            let mut map = lock(&self.map);
            map.retain(|_, m| Arc::strong_count(m) > 1);
            map.entry(key.clone()).or_default().clone()
        };
        let guard = m.lock_owned().await;
        Arc::new(FetchTurn {
            guard: Some(guard),
            key,
            map: self.map.clone(),
        })
    }
}

impl Drop for FetchTurn {
    fn drop(&mut self) {
        drop(self.guard.take());
        let mut map = lock(&self.map);
        if map
            .get(&self.key)
            .is_some_and(|m| Arc::strong_count(m) == 1)
        {
            map.remove(&self.key);
        }
    }
}

/// Key for the per-`dest` lock: `dest` without `.` parts or doubled
/// separators, lowercase on Windows and macOS (NTFS and APFS file names are
/// case-insensitive by default).
fn dest_key(dest: &Path) -> PathBuf {
    let clean: PathBuf = dest.components().collect();
    if cfg!(any(windows, target_os = "macos")) {
        PathBuf::from(clean.to_string_lossy().to_lowercase())
    } else {
        clean
    }
}

/// Time limit for transferring `size` bytes.
fn transfer_limit(size: u64) -> Duration {
    let secs = TRANSFER_BASE.as_secs().saturating_add(size / MIN_AVG_RATE);
    Duration::from_secs(secs).min(TRANSFER_MAX)
}

/// Wait before asking a busy peer again: 1 to 2 seconds from `rand`.
fn busy_backoff(rand: u32) -> Duration {
    Duration::from_millis(1000 + u64::from(rand % 1000))
}

/// Rolling throughput floor for one transfer of `total` bytes.
struct Throughput {
    window_start: Instant,
    window_bytes: u64,
    /// Bytes still to move when the current window started.
    left_at_start: u64,
    left: u64,
}

impl Throughput {
    fn new(total: u64, now: Instant) -> Self {
        Self {
            window_start: now,
            window_bytes: 0,
            left_at_start: total,
            left: total,
        }
    }

    fn needed(&self) -> u64 {
        WINDOW_MIN_BYTES.min(self.left_at_start)
    }

    /// When the current window ends while still short of its minimum.
    fn deadline(&self) -> Option<Instant> {
        (self.window_bytes < self.needed()).then_some(self.window_start + THROUGHPUT_WINDOW)
    }

    /// `true` when the current window ended short of its minimum.
    fn too_slow(&self, now: Instant) -> bool {
        self.deadline().is_some_and(|d| now >= d)
    }

    /// Records `n` bytes moved at `now`. `Err` when the window that ended
    /// moved too little.
    fn record(&mut self, n: u64, now: Instant) -> Result<(), ()> {
        self.window_bytes = self.window_bytes.saturating_add(n);
        self.left = self.left.saturating_sub(n);
        if now.saturating_duration_since(self.window_start) >= THROUGHPUT_WINDOW {
            if self.window_bytes < self.needed() {
                return Err(());
            }
            self.window_start = now;
            self.window_bytes = 0;
            self.left_at_start = self.left;
        }
        Ok(())
    }

    /// Deadline for the next step: `step` from now, never past `end` or the
    /// end of an unfinished window.
    fn step_deadline(&self, step: Duration, end: Instant) -> Instant {
        let d = (Instant::now() + step).min(end);
        match self.deadline() {
            Some(w) => d.min(w),
            None => d,
        }
    }
}

/// Peers to ask, in order: connected peers from `prefer`, then the other
/// connected peers. No duplicates, never `me`.
fn order_candidates(me: &str, prefer: &[String], connected: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for pk in prefer.iter().chain(connected) {
        if pk != me && connected.contains(pk) && !out.contains(pk) {
            out.push(pk.clone());
        }
    }
    out
}

/// One peer waiting in the [`CandidateQueue`].
#[derive(Debug, Clone, PartialEq, Eq)]
struct Attempt {
    pk: String,
    busy_tries: u32,
    not_before: Instant,
}

/// What to do next with the [`CandidateQueue`].
#[derive(Debug, PartialEq, Eq)]
enum Next {
    Ready(Attempt),
    WaitUntil(Instant),
    Done,
}

/// Peers to try in order, with retries for busy peers, all before one
/// overall `deadline`.
struct CandidateQueue {
    items: VecDeque<Attempt>,
    deadline: Instant,
}

impl CandidateQueue {
    fn new(pks: Vec<String>, now: Instant, deadline: Instant) -> Self {
        let items = pks
            .into_iter()
            .map(|pk| Attempt {
                pk,
                busy_tries: 0,
                not_before: now,
            })
            .collect();
        Self { items, deadline }
    }

    /// The first peer that may be tried at `now`, else when to look again.
    fn next(&mut self, now: Instant) -> Next {
        let deadline = self.deadline;
        self.items.retain(|a| a.not_before <= deadline);
        if let Some(i) = self.items.iter().position(|a| a.not_before <= now) {
            return self.items.remove(i).map_or(Next::Done, Next::Ready);
        }
        match self.items.iter().map(|a| a.not_before).min() {
            Some(t) => Next::WaitUntil(t),
            None => Next::Done,
        }
    }

    /// Puts `a` back to be tried at `at`, unless that is past the deadline.
    fn retry_at(&mut self, mut a: Attempt, at: Instant) {
        if at <= self.deadline {
            a.not_before = at;
            self.items.push_back(a);
        }
    }
}

// ----- Files (blocking) ---------------------------------------------------------

/// Temporary file for `dest`: `<dest file name>.part-<16 hex>` in `dest`'s
/// folder, with a short fixed base when the name is long.
fn temp_path(dest: &Path, rand: u64) -> Option<PathBuf> {
    let name = dest.file_name()?;
    let mut tmp_name = if name.len() <= MAX_TMP_BASE {
        name.to_os_string()
    } else {
        TMP_FALLBACK_NAME.into()
    };
    tmp_name.push(format!(".part-{rand:016x}"));
    Some(match dest.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.join(tmp_name),
        _ => PathBuf::from(tmp_name),
    })
}

/// Renames, retrying a few times when the target is locked.
fn rename_with_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut tries = 1;
    loop {
        match std::fs::rename(from, to) {
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied && tries < RENAME_TRIES => {
                tries += 1;
                std::thread::sleep(RENAME_BACKOFF);
            }
            other => return other,
        }
    }
}

/// Requester's file side: receives the bytes of one blob into a temporary
/// file next to `dest`, enforces the announced size and the BLAKE3 hash, and
/// moves the file to `dest` only in [`BlobWriter::finish`]. Dropped without a
/// successful `finish`, it deletes the temporary file.
struct BlobWriter {
    file: Option<File>,
    tmp: PathBuf,
    dest: PathBuf,
    size: u64,
    hash: String,
    written: u64,
    hasher: blake3::Hasher,
}

impl BlobWriter {
    fn create(dest: &Path, size: u64, hash: &str) -> Result<Self, FetchError> {
        let tmp = temp_path(dest, OsRng.next_u64())
            .ok_or_else(|| FetchError::Local("Lokasi tujuan berkas tidak valid.".to_owned()))?;
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| FetchError::Local(format!("File sementara tidak bisa dibuat: {e}")))?;
        Ok(Self {
            file: Some(file),
            tmp,
            dest: dest.to_path_buf(),
            size,
            hash: hash.to_owned(),
            written: 0,
            hasher: blake3::Hasher::new(),
        })
    }

    fn write(&mut self, chunk: &[u8]) -> Result<(), FetchError> {
        let len = chunk.len() as u64;
        if self.size - self.written < len {
            return Err(FetchError::Peer(
                "Laptop rekan mengirim lebih banyak byte dari ukuran berkas.".to_owned(),
            ));
        }
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| FetchError::Local("File sementara sudah ditutup.".to_owned()))?;
        file.write_all(chunk)
            .map_err(|e| FetchError::Local(format!("Gagal menulis file sementara: {e}")))?;
        self.hasher.update(chunk);
        self.written += len;
        Ok(())
    }

    /// Checks size and hash, syncs the file and renames it to `dest`
    /// (replacing an existing file). On error the temporary file is removed.
    fn finish(mut self) -> Result<u64, FetchError> {
        if self.written != self.size {
            return Err(FetchError::Peer(format!(
                "Berkas tidak lengkap: {} dari {} byte.",
                self.written, self.size
            )));
        }
        if self.hasher.finalize().to_hex().as_str() != self.hash {
            return Err(FetchError::Peer(
                "Isi berkas tidak cocok dengan hash BLAKE3-nya.".to_owned(),
            ));
        }
        let file = self
            .file
            .take()
            .ok_or_else(|| FetchError::Local("File sementara sudah ditutup.".to_owned()))?;
        file.sync_all()
            .map_err(|e| FetchError::Local(format!("Gagal menyimpan file sementara: {e}")))?;
        drop(file);
        rename_with_retry(&self.tmp, &self.dest)
            .map_err(|e| FetchError::Local(format!("Berkas tidak bisa dipindah ke tujuan: {e}")))?;
        // Renamed: nothing left for `drop` to clean up.
        self.tmp = PathBuf::new();
        Ok(self.size)
    }
}

impl Drop for BlobWriter {
    fn drop(&mut self) {
        drop(self.file.take());
        if !self.tmp.as_os_str().is_empty() {
            let _ = std::fs::remove_file(&self.tmp);
        }
    }
}

/// Checks `dest` before any network work: a file path (not a folder) in an
/// existing folder. `dest` is already known to be absolute. Blocking.
fn check_dest(dest: &Path) -> Result<(), String> {
    if dest.is_dir() {
        return Err("Lokasi tujuan berkas adalah folder.".to_owned());
    }
    match dest.parent() {
        Some(p) if p.is_dir() => Ok(()),
        _ => Err("Folder tujuan berkas tidak ada.".to_owned()),
    }
}

/// Size of `dest` when it is a file holding exactly blob `hash` of at most
/// `max_size` bytes. Blocking.
fn existing_blob(dest: &Path, hash: &str, max_size: u64) -> Option<u64> {
    let file = File::open(dest).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut hasher = blake3::Hasher::new();
    let n = std::io::copy(&mut file.take(max_size.saturating_add(1)), &mut hasher).ok()?;
    (n <= max_size && hasher.finalize().to_hex().as_str() == hash).then_some(n)
}

/// After a failed fetch: removes `dest` unless it holds blob `hash`.
/// Blocking.
fn remove_invalid_dest(dest: &Path, hash: &str) {
    if dest.is_file() && existing_blob(dest, hash, u64::MAX).is_none() {
        let _ = std::fs::remove_file(dest);
    }
}

/// Reads exactly `size` bytes of `file` in chunks into `tx`. Sends an error
/// when the file is shorter or longer than `size`. Runs on the blocking pool.
fn read_blob_file(mut file: File, size: u64, tx: mpsc::Sender<Result<Vec<u8>, String>>) {
    let mut left = size;
    while left > 0 {
        let want = (CHUNK as u64).min(left) as usize;
        let mut buf = vec![0u8; want];
        let mut filled = 0;
        while filled < want {
            match file.read(&mut buf[filled..]) {
                Ok(0) => {
                    let _ = tx.blocking_send(Err("file lebih pendek dari ukurannya".into()));
                    return;
                }
                Ok(n) => filled += n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => {
                    let _ = tx.blocking_send(Err(format!("file tidak terbaca: {e}")));
                    return;
                }
            }
        }
        if tx.blocking_send(Ok(buf)).is_err() {
            return;
        }
        left -= want as u64;
    }
    let mut extra = [0u8; 1];
    match file.read(&mut extra) {
        Ok(0) => {}
        Ok(_) => {
            let _ = tx.blocking_send(Err("file lebih panjang dari ukurannya".into()));
        }
        Err(e) => {
            let _ = tx.blocking_send(Err(format!("file tidak terbaca: {e}")));
        }
    }
}

// ----- Server -------------------------------------------------------------------

async fn refuse(send: &mut SendStream, reason: &str) {
    let _ = wire::write_msg_timeout(
        send,
        &Msg::BlobRefused {
            code: reason.into(),
        },
        WRITE_TIMEOUT,
    )
    .await;
}

impl Inner {
    /// Server side: answer one `BlobGet` from member `pk`. Applies its own
    /// time limits; the caller finishes `send` afterwards.
    pub(crate) async fn serve_blob(
        self: &Arc<Self>,
        pk: &str,
        hash: String,
        send: &mut SendStream,
        recv: &mut RecvStream,
    ) {
        // The request is complete; nothing more is expected from the peer.
        let _ = recv.stop(VarInt::from_u32(code::NORMAL));
        // Limits first, before membership or files: `busy` reveals nothing.
        if !self.blobs.serve_rate.check(pk, Instant::now()) {
            refuse(send, "busy").await;
            return;
        }
        if !wire::is_hex64(&hash) {
            refuse(send, "unavailable").await;
            return;
        }
        let Some(_slot) = self.blobs.serves.try_acquire(pk) else {
            refuse(send, "busy").await;
            return;
        };
        let me = self.clone();
        let peer = pk.to_owned();
        let h = hash.clone();
        let lookup = tokio::task::spawn_blocking(move || -> Option<(File, u64)> {
            if !me.is_member(&peer) {
                return None;
            }
            let path = me.features.hub.blob_path_for(&peer, &h)?;
            let file = File::open(path).ok()?;
            let meta = file.metadata().ok()?;
            meta.is_file().then_some((file, meta.len()))
        });
        let opened = match tokio::time::timeout(READ_TIMEOUT, lookup).await {
            Ok(Ok(found)) => found,
            _ => None,
        };
        let Some((file, size)) = opened else {
            refuse(send, "unavailable").await;
            return;
        };
        if wire::write_msg_timeout(send, &Msg::BlobHeader { size }, WRITE_TIMEOUT)
            .await
            .is_err()
        {
            let _ = send.reset(VarInt::from_u32(code::PROTOCOL));
            return;
        }
        if self
            .send_blob_body(pk, &hash, file, size, send)
            .await
            .is_err()
        {
            let _ = send.reset(VarInt::from_u32(code::PROTOCOL));
        }
    }

    /// `true` when `pk` is still a member and may still download `hash`.
    async fn may_serve(self: &Arc<Self>, pk: &str, hash: &str) -> bool {
        let me = self.clone();
        let (pk, hash) = (pk.to_owned(), hash.to_owned());
        let check = tokio::task::spawn_blocking(move || {
            me.is_member(&pk) && me.features.hub.blob_path_for(&pk, &hash).is_some()
        });
        matches!(
            tokio::time::timeout(READ_TIMEOUT, check).await,
            Ok(Ok(true))
        )
    }

    /// Sends the `size` bytes of `file` on `send`. `Err` when the file
    /// changed size, access was revoked, a write stalled, the receiver read
    /// too slowly, or the transfer took too long.
    async fn send_blob_body(
        self: &Arc<Self>,
        pk: &str,
        hash: &str,
        file: File,
        size: u64,
        send: &mut SendStream,
    ) -> Result<(), String> {
        let end = Instant::now() + transfer_limit(size);
        let mut rate = Throughput::new(size, Instant::now());
        let (tx, mut rx) = mpsc::channel(CHUNK_QUEUE);
        tokio::task::spawn_blocking(move || read_blob_file(file, size, tx));
        let mut sent: u64 = 0;
        let mut next_check = RECHECK_EVERY;
        loop {
            let item = tokio::time::timeout_at(rate.step_deadline(TRANSFER_MAX, end), rx.recv())
                .await
                .map_err(|_| "transfer terlalu lama".to_owned())?;
            let buf = match item {
                None => break,
                Some(Err(e)) => return Err(e),
                Some(Ok(buf)) => buf,
            };
            tokio::time::timeout_at(rate.step_deadline(WRITE_TIMEOUT, end), send.write_all(&buf))
                .await
                .map_err(|_| "penerima berhenti membaca".to_owned())?
                .map_err(|e| e.to_string())?;
            sent += buf.len() as u64;
            rate.record(buf.len() as u64, Instant::now())
                .map_err(|_| "penerima terlalu lambat".to_owned())?;
            if sent >= next_check && sent < size {
                next_check = next_check.saturating_add(RECHECK_EVERY);
                if !self.may_serve(pk, hash).await {
                    return Err("akses dicabut".into());
                }
            }
        }
        if sent != size {
            return Err("file lebih pendek dari ukurannya".into());
        }
        Ok(())
    }
}

// ----- Requester ----------------------------------------------------------------

/// From the network task to the blocking writer.
enum WriterMsg {
    Chunk(Vec<u8>),
    /// All bytes received and the stream ended: check and move the file.
    /// Without it (channel closed, also when the fetch is cancelled) the
    /// writer deletes the temporary file.
    Done,
}

/// Blocking writer task: writes chunks until `Done`, then checks and moves
/// the file. A closed channel without `Done` (failed or cancelled fetch)
/// drops the [`BlobWriter`], which deletes the temporary file.
fn run_writer(
    mut rx: mpsc::Receiver<WriterMsg>,
    dest: &Path,
    size: u64,
    hash: &str,
) -> Result<u64, FetchError> {
    let mut w = BlobWriter::create(dest, size, hash)?;
    while let Some(msg) = rx.blocking_recv() {
        match msg {
            WriterMsg::Chunk(c) => w.write(&c)?,
            WriterMsg::Done => return w.finish(),
        }
    }
    Err(FetchError::Peer("Unduhan dibatalkan.".to_owned()))
}

/// Receives exactly `size` bytes from `recv`, then the end of the stream,
/// into `dest` through a [`BlobWriter`] on the blocking pool. The writer
/// holds `turn` until it is done.
async fn receive_blob_body(
    recv: &mut RecvStream,
    size: u64,
    hash: String,
    dest: PathBuf,
    turn: Arc<FetchTurn>,
    is_closing: impl Fn() -> bool,
) -> Result<u64, FetchError> {
    let end = Instant::now() + transfer_limit(size);
    let mut rate = Throughput::new(size, Instant::now());
    let (tx, rx) = mpsc::channel::<WriterMsg>(CHUNK_QUEUE);
    let writer = tokio::task::spawn_blocking(move || {
        let res = run_writer(rx, &dest, size, &hash);
        drop(turn);
        res
    });

    let timed_out = |rate: &Throughput| -> FetchError {
        let now = Instant::now();
        FetchError::Peer(if now >= end {
            "Unduhan melewati batas waktu.".into()
        } else if rate.too_slow(now) {
            "Unduhan terlalu lambat.".into()
        } else {
            "Laptop rekan berhenti mengirim data.".into()
        })
    };

    let mut buf = vec![0u8; CHUNK];
    let mut got: u64 = 0;
    let mut net_err: Option<FetchError> = None;
    while got < size {
        if is_closing() {
            net_err = Some(FetchError::Local(STOPPING.into()));
            break;
        }
        let want = (CHUNK as u64).min(size - got) as usize;
        let read = tokio::time::timeout_at(
            rate.step_deadline(STALL_TIMEOUT, end),
            recv.read(&mut buf[..want]),
        )
        .await;
        let n = match read {
            Err(_) => {
                net_err = Some(timed_out(&rate));
                break;
            }
            Ok(Err(e)) => {
                net_err = Some(FetchError::Peer(format!("Unduhan terputus: {e}")));
                break;
            }
            Ok(Ok(None)) => {
                net_err = Some(FetchError::Peer(
                    "Unduhan berakhir sebelum berkas lengkap.".into(),
                ));
                break;
            }
            Ok(Ok(Some(n))) => n,
        };
        got += n as u64;
        if rate.record(n as u64, Instant::now()).is_err() {
            net_err = Some(FetchError::Peer("Unduhan terlalu lambat.".into()));
            break;
        }
        let chunk = WriterMsg::Chunk(buf[..n].to_vec());
        match tokio::time::timeout(STALL_TIMEOUT, tx.send(chunk)).await {
            Ok(Ok(())) => {}
            // The writer stopped; its result carries the reason.
            Ok(Err(_)) => break,
            Err(_) => {
                net_err = Some(FetchError::Local(
                    "Penyimpanan terlalu lambat menulis berkas.".into(),
                ));
                break;
            }
        }
    }
    if net_err.is_none() && got == size {
        let mut probe = [0u8; 1];
        let after = tokio::time::timeout(READ_TIMEOUT, recv.read(&mut probe)).await;
        net_err = match after {
            Ok(Ok(None)) => {
                match tokio::time::timeout(STALL_TIMEOUT, tx.send(WriterMsg::Done)).await {
                    Ok(_) => None,
                    Err(_) => Some(FetchError::Local(
                        "Penyimpanan terlalu lambat menulis berkas.".into(),
                    )),
                }
            }
            Ok(Ok(Some(_))) => Some(FetchError::Peer(
                "Laptop rekan mengirim lebih banyak byte dari ukuran berkas.".into(),
            )),
            Ok(Err(e)) => Some(FetchError::Peer(format!("Unduhan terputus: {e}"))),
            Err(_) => Some(FetchError::Peer(
                "Laptop rekan tidak menutup transfer.".into(),
            )),
        };
    }
    drop(tx);
    let written = match tokio::time::timeout(WRITER_WAIT, writer).await {
        Ok(Ok(res)) => res,
        Ok(Err(_)) => Err(FetchError::Local(
            "Penulis berkas berhenti mendadak.".into(),
        )),
        Err(_) => Err(FetchError::Local(
            "Penyimpanan tidak selesai menulis berkas.".into(),
        )),
    };
    match net_err {
        Some(e) => Err(e),
        None => written,
    }
}

/// One download attempt from the peer behind `conn`.
async fn fetch_from(
    conn: &Connection,
    hash: &str,
    max_size: u64,
    dest: &Path,
    turn: Arc<FetchTurn>,
    is_closing: impl Fn() -> bool,
) -> Result<u64, FetchError> {
    let peer = FetchError::Peer;
    let (mut send, mut recv) = tokio::time::timeout(READ_TIMEOUT, conn.open_bi())
        .await
        .map_err(|_| peer("Laptop rekan tidak menjawab.".to_owned()))?
        .map_err(|e| peer(format!("Stream ke laptop rekan gagal dibuka: {e}")))?;
    let get = Msg::BlobGet {
        hash: hash.to_owned(),
    };
    if let Err(e) = wire::write_msg_timeout(&mut send, &get, WRITE_TIMEOUT).await {
        let _ = recv.stop(VarInt::from_u32(code::NORMAL));
        return Err(peer(format!("Permintaan berkas gagal dikirim: {e}")));
    }
    let _ = send.finish();
    let header = wire::read_msg_timeout(&mut recv, MAX_HEADER_FRAME, READ_TIMEOUT).await;
    let size = match header {
        Ok(Some(Msg::BlobHeader { size })) if size <= max_size => size,
        other => {
            let _ = recv.stop(VarInt::from_u32(code::NORMAL));
            return Err(match other {
                Ok(Some(Msg::BlobHeader { .. })) => {
                    peer("Berkas lebih besar dari batas yang diizinkan.".to_owned())
                }
                Ok(Some(Msg::BlobRefused { code: c })) if c == "busy" => {
                    FetchError::Busy("Laptop rekan sedang sibuk.".to_owned())
                }
                Ok(Some(Msg::BlobRefused { .. })) => {
                    peer("Laptop rekan tidak menyediakan berkas ini.".to_owned())
                }
                Ok(_) => peer("Jawaban laptop rekan tidak dikenal.".to_owned()),
                Err(e) => peer(format!("Jawaban laptop rekan tidak terbaca: {e}")),
            });
        }
    };
    let res = receive_blob_body(
        &mut recv,
        size,
        hash.to_owned(),
        dest.to_path_buf(),
        turn,
        is_closing,
    )
    .await;
    if res.is_err() {
        let _ = recv.stop(VarInt::from_u32(code::PROTOCOL));
    }
    res
}

impl Inner {
    /// Requester side, behind `FeatureLink::fetch_blob`.
    pub(crate) async fn fetch_blob(
        self: Arc<Self>,
        hash: String,
        max_size: u64,
        prefer: Vec<String>,
        dest: PathBuf,
    ) -> Result<u64, String> {
        if !wire::is_hex64(&hash) {
            return Err("Kode berkas tidak valid.".to_owned());
        }
        if !dest.is_absolute() {
            return Err("Lokasi tujuan berkas harus path lengkap.".to_owned());
        }
        if self.is_closing() {
            return Err(STOPPING.to_owned());
        }
        let turn = self.blobs.fetches.turn(dest_key(&dest)).await;
        let (d, h) = (dest.clone(), hash.clone());
        let checked = tokio::task::spawn_blocking(move || {
            check_dest(&d).map(|()| existing_blob(&d, &h, max_size))
        })
        .await
        .unwrap_or_else(|_| Err("Lokasi tujuan berkas tidak bisa diperiksa.".to_owned()));
        match checked {
            Err(e) => return Err(e),
            Ok(Some(size)) => return Ok(size),
            Ok(None) => {}
        }
        match self.download(&hash, max_size, &prefer, &dest, &turn).await {
            Ok(size) => Ok(size),
            Err(e) => {
                // Contract: on error `dest` is removed (unless it holds the
                // blob). Not on cancellation, where this never runs.
                let h = hash.clone();
                let _ = tokio::task::spawn_blocking(move || remove_invalid_dest(&dest, &h)).await;
                Err(e)
            }
        }
    }

    /// The network part of `fetch_blob`: slots, candidates, retries.
    async fn download(
        &self,
        hash: &str,
        max_size: u64,
        prefer: &[String],
        dest: &Path,
        turn: &Arc<FetchTurn>,
    ) -> Result<u64, String> {
        let _permit = match tokio::time::timeout(
            DOWNLOAD_QUEUE_TIMEOUT,
            self.blobs.downloads.acquire(),
        )
        .await
        {
            Ok(Ok(p)) => p,
            Ok(Err(_)) => return Err(STOPPING.to_owned()),
            Err(_) => {
                return Err("Terlalu banyak unduhan berjalan. Coba lagi sebentar lagi.".to_owned());
            }
        };
        let candidates = order_candidates(&self.me, prefer, &self.connected_peers());
        if candidates.is_empty() {
            return Err("Tidak ada laptop rekan yang tersambung.".to_owned());
        }
        let now = Instant::now();
        let mut queue = CandidateQueue::new(candidates, now, now + DOWNLOAD_QUEUE_TIMEOUT);
        let mut last = String::new();
        loop {
            if self.is_closing() {
                return Err(STOPPING.to_owned());
            }
            let now = Instant::now();
            let attempt = match queue.next(now) {
                Next::Done => break,
                Next::WaitUntil(t) => {
                    tokio::time::sleep_until(t).await;
                    continue;
                }
                Next::Ready(a) => a,
            };
            let Some(_slot) = self.blobs.peer_downloads.try_acquire(&attempt.pk) else {
                last = "Laptop rekan sedang melayani unduhan lain.".to_owned();
                queue.retry_at(attempt, now + LOCAL_BUSY_RETRY);
                continue;
            };
            let Some(conn) = self.peer_conn(&attempt.pk) else {
                last = "Laptop rekan sudah tidak tersambung.".to_owned();
                continue;
            };
            tokio::time::sleep_until(self.blobs.pacer.reserve(&attempt.pk, Instant::now())).await;
            let res = fetch_from(&conn, hash, max_size, dest, turn.clone(), || {
                self.is_closing()
            })
            .await;
            match res {
                Ok(size) => return Ok(size),
                Err(FetchError::Busy(m)) => {
                    last = m;
                    let mut a = attempt;
                    a.busy_tries += 1;
                    if a.busy_tries < MAX_BUSY_TRIES {
                        let at = Instant::now() + busy_backoff(OsRng.next_u32());
                        queue.retry_at(a, at);
                    }
                }
                Err(FetchError::Peer(m)) => last = m,
                Err(e @ FetchError::Local(_)) => return Err(e.into_message()),
            }
        }
        Err(format!(
            "Berkas tidak bisa diunduh dari laptop rekan. Alasan terakhir: {last}"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hash_of(bytes: &[u8]) -> String {
        blake3::hash(bytes).to_hex().to_string()
    }

    fn leftovers(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect()
    }

    fn write_all(dest: &Path, data: &[u8], announced: u64, hash: &str) -> Result<u64, FetchError> {
        let mut w = BlobWriter::create(dest, announced, hash)?;
        for chunk in data.chunks(7) {
            w.write(chunk)?;
        }
        w.finish()
    }

    #[test]
    fn correct_blob_lands_at_dest() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("berkas.pdf");
        let data = b"isi berkas yang benar".repeat(100);
        let size = write_all(&dest, &data, data.len() as u64, &hash_of(&data)).unwrap();
        assert_eq!(size, data.len() as u64);
        assert_eq!(std::fs::read(&dest).unwrap(), data);
        assert_eq!(leftovers(dir.path()), vec!["berkas.pdf".to_owned()]);
    }

    #[test]
    fn temp_file_sits_next_to_dest() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("a.bin");
        let w = BlobWriter::create(&dest, 1, &hash_of(b"x")).unwrap();
        let name = w.tmp.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(w.tmp.parent().unwrap(), dir.path());
        let suffix = name.strip_prefix("a.bin.part-").unwrap();
        assert_eq!(suffix.len(), 16);
        assert!(suffix.bytes().all(|b| b.is_ascii_hexdigit()));
        assert!(w.tmp.exists());
        drop(w);
        assert!(leftovers(dir.path()).is_empty());
    }

    #[test]
    fn long_dest_names_get_a_short_temp_name() {
        let dir = Path::new("/data");
        let long = "x".repeat(MAX_TMP_BASE + 1);
        let tmp = temp_path(&dir.join(&long), 0xab).unwrap();
        assert_eq!(tmp, dir.join("mira-blob.part-00000000000000ab"));
        let ok = "y".repeat(MAX_TMP_BASE);
        let tmp = temp_path(&dir.join(&ok), 1).unwrap();
        assert_eq!(tmp, dir.join(format!("{ok}.part-0000000000000001")));
        assert!(temp_path(Path::new("/"), 1).is_none());
    }

    #[test]
    fn hash_mismatch_leaves_nothing_and_is_the_peers_fault() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("b.bin");
        let data = b"isi asli";
        let err = write_all(&dest, b"isi lain", data.len() as u64, &hash_of(data)).unwrap_err();
        assert!(
            matches!(&err, FetchError::Peer(m) if m.contains("BLAKE3")),
            "{err:?}"
        );
        assert!(leftovers(dir.path()).is_empty());
    }

    #[test]
    fn too_few_bytes_fails_and_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("c.bin");
        let data = b"tiga belas b";
        let err = write_all(&dest, &data[..5], data.len() as u64, &hash_of(data)).unwrap_err();
        assert!(matches!(&err, FetchError::Peer(m) if m.contains("tidak lengkap")));
        assert!(leftovers(dir.path()).is_empty());
    }

    #[test]
    fn too_many_bytes_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("d.bin");
        let data = b"lima!";
        let mut w = BlobWriter::create(&dest, 3, &hash_of(data)).unwrap();
        assert!(matches!(w.write(data), Err(FetchError::Peer(_))));
        drop(w);
        assert!(leftovers(dir.path()).is_empty());
    }

    #[test]
    fn existing_dest_is_replaced_on_success() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("e.bin");
        std::fs::write(&dest, b"versi lama yang lebih panjang").unwrap();
        let data = b"versi baru";
        write_all(&dest, data, data.len() as u64, &hash_of(data)).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), data);
        assert_eq!(leftovers(dir.path()), vec!["e.bin".to_owned()]);
    }

    #[test]
    fn local_failures_are_local() {
        let dir = tempfile::tempdir().unwrap();
        let data = b"isi";
        // Missing folder: the temp file cannot be created.
        let missing = dir.path().join("tidak-ada").join("f.bin");
        let err = write_all(&missing, data, 3, &hash_of(data)).unwrap_err();
        assert!(matches!(err, FetchError::Local(_)), "{err:?}");
        // `dest` is a non-empty folder: the rename fails after the checks.
        let folder = dir.path().join("folder");
        std::fs::create_dir(&folder).unwrap();
        std::fs::write(folder.join("isi.txt"), b"x").unwrap();
        let err = write_all(&folder, data, 3, &hash_of(data)).unwrap_err();
        assert!(matches!(err, FetchError::Local(_)), "{err:?}");
        let mut left = leftovers(dir.path());
        left.sort();
        assert_eq!(left, vec!["folder".to_owned()], "no temp file left");
    }

    #[test]
    fn dest_checks_before_the_network() {
        let dir = tempfile::tempdir().unwrap();
        assert!(check_dest(&dir.path().join("baru.bin")).is_ok());
        assert!(check_dest(dir.path()).is_err(), "folder");
        assert!(check_dest(&dir.path().join("tidak-ada").join("x.bin")).is_err());
    }

    #[test]
    fn rename_retry_gives_up_on_other_errors() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("a");
        std::fs::write(&from, b"1").unwrap();
        let to = dir.path().join("b");
        rename_with_retry(&from, &to).unwrap();
        assert_eq!(std::fs::read(&to).unwrap(), b"1");
        assert!(rename_with_retry(&from, &to).is_err(), "source is gone");
    }

    #[test]
    fn invalid_dest_is_removed_on_failure_valid_one_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("f.bin");
        let data = b"baru";
        std::fs::write(&dest, b"lama").unwrap();
        // A failed write never touches `dest`.
        assert!(write_all(&dest, b"rusak", data.len() as u64, &hash_of(data)).is_err());
        assert_eq!(std::fs::read(&dest).unwrap(), b"lama");
        remove_invalid_dest(&dest, &hash_of(data));
        assert!(leftovers(dir.path()).is_empty());
        remove_invalid_dest(&dest, &hash_of(data));

        std::fs::write(&dest, data).unwrap();
        remove_invalid_dest(&dest, &hash_of(data));
        assert_eq!(std::fs::read(&dest).unwrap(), data, "valid dest stays");
    }

    #[test]
    fn existing_blob_checks_hash_and_size() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("h.bin");
        let data = b"sudah ada";
        let h = hash_of(data);
        assert_eq!(existing_blob(&dest, &h, 100), None, "missing");
        std::fs::write(&dest, data).unwrap();
        assert_eq!(existing_blob(&dest, &h, 100), Some(data.len() as u64));
        assert_eq!(existing_blob(&dest, &h, data.len() as u64), Some(9));
        assert_eq!(existing_blob(&dest, &h, 3), None, "over max_size");
        assert_eq!(existing_blob(&dest, &hash_of(b"lain"), 100), None);
        assert_eq!(existing_blob(dir.path(), &h, 100), None, "folder");
    }

    #[test]
    fn empty_blob_is_fine() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("g.bin");
        write_all(&dest, b"", 0, &hash_of(b"")).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"");
    }

    #[test]
    fn serve_slots_limit_per_peer_and_release_on_drop() {
        let l = ServeLimiter::new(3, 2);
        let a1 = l.try_acquire("a").unwrap();
        let a2 = l.try_acquire("a").unwrap();
        assert!(l.try_acquire("a").is_none(), "third for one peer");
        let b1 = l.try_acquire("b").unwrap();
        assert!(l.try_acquire("c").is_none(), "global limit");
        drop(a1);
        assert!(l.try_acquire("c").is_some(), "freed by drop");
        let a3 = l.try_acquire("a").unwrap();
        drop((a2, a3, b1));
        let c = lock(&l.counts);
        assert_eq!(c.total, 0);
        assert!(c.per_peer.is_empty(), "zero entries are removed");
    }

    #[test]
    fn blob_state_uses_plan_limits() {
        let s = BlobState::new();
        let held: Vec<_> = (0..MAX_SERVES_PER_PEER)
            .map(|_| s.serves.try_acquire("a").unwrap())
            .collect();
        assert!(s.serves.try_acquire("a").is_none());
        drop(held);
        assert_eq!(s.downloads.available_permits(), MAX_DOWNLOADS);
        assert_eq!(
            (
                MAX_SERVES,
                MAX_SERVES_PER_PEER,
                MAX_DOWNLOADS,
                MAX_DOWNLOADS_PER_PEER
            ),
            (8, 2, 4, 2)
        );
    }

    #[test]
    fn peer_rate_allows_ten_per_second() {
        let r = PeerRate::new(10, Duration::from_secs(1));
        let t0 = Instant::now();
        for _ in 0..10 {
            assert!(r.check("a", t0));
        }
        assert!(!r.check("a", t0 + Duration::from_millis(500)));
        assert!(r.check("b", t0), "other peers are separate");
        assert!(r.check("a", t0 + Duration::from_secs(1)), "new window");
        assert_eq!(lock(&r.map).len(), 1, "expired windows are dropped");
    }

    #[test]
    fn paced_client_never_hits_the_server_rate_limit() {
        let pacer = Pacer::new(CLIENT_GET_GAP);
        let server = PeerRate::new(BLOB_GETS_PER_SECOND, RATE_WINDOW);
        let t0 = Instant::now();
        // 30 thumbnails asked for at the same moment from one peer.
        let times: Vec<Instant> = (0..30).map(|_| pacer.reserve("a", t0)).collect();
        assert_eq!(times[0], t0);
        assert_eq!(times[1], t0 + CLIENT_GET_GAP);
        for t in times {
            assert!(server.check("a", t), "refused at {:?}", t - t0);
        }
        assert_eq!(pacer.reserve("b", t0), t0, "other peers are separate");
        let later = t0 + Duration::from_secs(60);
        assert_eq!(pacer.reserve("c", later), later);
        assert_eq!(lock(&pacer.next).len(), 1, "old entries are dropped");
    }

    #[test]
    fn busy_backoff_is_one_to_two_seconds() {
        assert_eq!(busy_backoff(0), Duration::from_millis(1000));
        assert_eq!(busy_backoff(999), Duration::from_millis(1999));
        assert_eq!(busy_backoff(u32::MAX), Duration::from_millis(1295));
    }

    #[test]
    fn candidate_queue_retries_within_the_deadline() {
        let t0 = Instant::now();
        let s = Duration::from_secs;
        let mut q = CandidateQueue::new(vec!["a".into(), "b".into()], t0, t0 + s(10));
        let Next::Ready(a) = q.next(t0) else { panic!() };
        assert_eq!(a.pk, "a");
        q.retry_at(a, t0 + s(2));
        let Next::Ready(b) = q.next(t0) else { panic!() };
        assert_eq!(b.pk, "b");
        assert_eq!(q.next(t0), Next::WaitUntil(t0 + s(2)));
        let Next::Ready(a) = q.next(t0 + s(2)) else {
            panic!()
        };
        assert_eq!(a.pk, "a");
        q.retry_at(a, t0 + s(11));
        assert_eq!(q.next(t0 + s(3)), Next::Done, "past the deadline");
    }

    #[test]
    fn peer_download_slots_limit_and_prune() {
        let p = PeerSemaphores::new(2);
        let a1 = p.try_acquire("a").unwrap();
        let a2 = p.try_acquire("a").unwrap();
        assert!(p.try_acquire("a").is_none());
        let b1 = p.try_acquire("b").unwrap();
        drop(a1);
        assert!(p.try_acquire("a").is_some());
        drop((a2, b1));
        let _c = p.try_acquire("c").unwrap();
        assert_eq!(lock(&p.map).len(), 1, "unused peers are pruned");
    }

    #[test]
    fn dest_key_normalizes() {
        let a = dest_key(Path::new("/data/./unduhan//Foto.JPG"));
        let b = dest_key(Path::new("/data/unduhan/Foto.JPG"));
        assert_eq!(a, b);
        let upper = dest_key(Path::new("/data/unduhan/FOTO.jpg"));
        assert_eq!(
            upper == b,
            cfg!(any(windows, target_os = "macos")),
            "case folds on Windows and macOS only"
        );
    }

    #[tokio::test]
    async fn fetches_of_the_same_dest_take_turns() {
        let locks = FetchLocks::default();
        let key = PathBuf::from("/x");
        let first = locks.turn(key.clone()).await;
        let other = locks.turn(PathBuf::from("/y")).await;
        let waiting =
            tokio::time::timeout(Duration::from_millis(20), locks.turn(key.clone())).await;
        assert!(waiting.is_err(), "same dest waits");
        // A clone held by a writer keeps the turn.
        let writer_clone = first.clone();
        drop((first, other));
        let waiting =
            tokio::time::timeout(Duration::from_millis(20), locks.turn(key.clone())).await;
        assert!(waiting.is_err(), "writer still holds the turn");
        drop(writer_clone);
        let again = locks.turn(key.clone()).await;
        drop(again);
        assert!(lock(&locks.map).is_empty(), "entries go away after use");
    }

    #[test]
    fn transfer_limit_scales_with_size() {
        assert_eq!(transfer_limit(0), Duration::from_secs(60));
        assert_eq!(transfer_limit(256 * 1024 * 100), Duration::from_secs(160));
        assert_eq!(transfer_limit(u64::MAX), TRANSFER_MAX);
        assert_eq!(transfer_limit(10 * 1024 * 1024 * 1024), TRANSFER_MAX);
    }

    #[test]
    fn throughput_floor_per_window() {
        let t0 = Instant::now();
        let w = THROUGHPUT_WINDOW;
        let mut t = Throughput::new(10 * WINDOW_MIN_BYTES, t0);
        assert_eq!(t.deadline(), Some(t0 + w));
        t.record(WINDOW_MIN_BYTES, t0 + Duration::from_secs(5))
            .unwrap();
        assert_eq!(t.deadline(), None, "window satisfied");
        t.record(1, t0 + w).unwrap();
        assert_eq!(t.deadline(), Some(t0 + w + w), "new window");
        assert!(!t.too_slow(t0 + w + Duration::from_secs(10)));
        assert!(t.too_slow(t0 + w + w));
        assert!(t.record(100, t0 + w + w).is_err(), "trickle fails");
    }

    #[test]
    fn throughput_floor_shrinks_to_what_is_left() {
        let t0 = Instant::now();
        let mut t = Throughput::new(1000, t0);
        t.record(1000, t0 + THROUGHPUT_WINDOW).unwrap();
        assert_eq!(t.deadline(), None, "nothing left to move");
        let mut small = Throughput::new(10, t0);
        small.record(4, t0 + Duration::from_secs(1)).unwrap();
        assert!(small.record(1, t0 + THROUGHPUT_WINDOW).is_err());
    }

    #[test]
    fn candidates_prefer_first_without_self_or_duplicates() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let got = order_candidates(
            "me",
            &s(&["c", "x", "me", "c", "a"]),
            &s(&["a", "b", "c", "me"]),
        );
        assert_eq!(got, s(&["c", "a", "b"]));
        assert!(order_candidates("me", &s(&["a"]), &s(&["me"])).is_empty());
    }

    #[tokio::test]
    async fn file_reader_flags_size_changes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("src.bin");
        let data = vec![7u8; CHUNK * 2 + 10];
        std::fs::write(&path, &data).unwrap();

        let collect = |announced: u64| {
            let file = File::open(&path).unwrap();
            async move {
                let (tx, mut rx) = mpsc::channel(CHUNK_QUEUE);
                tokio::task::spawn_blocking(move || read_blob_file(file, announced, tx));
                let mut bytes = 0usize;
                let mut err = None;
                while let Some(item) = rx.recv().await {
                    match item {
                        Ok(b) => {
                            assert!(b.len() <= CHUNK);
                            bytes += b.len();
                        }
                        Err(e) => err = Some(e),
                    }
                }
                (bytes, err)
            }
        };
        let (n, err) = collect(data.len() as u64).await;
        assert_eq!((n, err), (data.len(), None));
        let (_, err) = collect(data.len() as u64 + 1).await;
        assert!(err.unwrap().contains("pendek"));
        let (n, err) = collect(data.len() as u64 - 1).await;
        assert_eq!(n, data.len() - 1);
        assert!(err.unwrap().contains("panjang"));
    }

    #[tokio::test]
    async fn cancelled_writer_leaves_no_part_file() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("k.bin");
        let data = b"isi panjang".repeat(10);
        let spawn = |rx| {
            let (d, h, n) = (dest.clone(), hash_of(&data), data.len() as u64);
            tokio::task::spawn_blocking(move || run_writer(rx, &d, n, &h))
        };

        // Channel closed without `Done`: cancelled fetch.
        let (tx, rx) = mpsc::channel(CHUNK_QUEUE);
        let writer = spawn(rx);
        tx.send(WriterMsg::Chunk(data[..20].to_vec()))
            .await
            .unwrap();
        drop(tx);
        assert!(writer.await.unwrap().is_err());
        assert!(leftovers(dir.path()).is_empty());

        // All bytes and `Done`: the file lands at `dest`.
        let (tx, rx) = mpsc::channel(CHUNK_QUEUE);
        let writer = spawn(rx);
        tx.send(WriterMsg::Chunk(data.clone())).await.unwrap();
        tx.send(WriterMsg::Done).await.unwrap();
        assert_eq!(writer.await.unwrap(), Ok(data.len() as u64));
        assert_eq!(leftovers(dir.path()), vec!["k.bin".to_owned()]);
    }
}
