//! Folder watcher for working copies. See docs/plans/tahap-4-lokal.md (tugas B).
//!
//! Each working copy lives alone in `<data>/working/<document_id>/`, so the watcher only cares
//! about two names in that folder: the target file and its Office lock file. Everything else
//! (Word `~WRL0001.tmp`, Excel `A1B2C3D4`, ...) is ignored without restarting the debounce.
//!
//! Layout: one shared `notify` watcher with one non-recursive watch per folder, and one worker
//! thread. The notify callback only forwards events into a channel; the worker maps them to
//! document ids, drives two [`SettleTracker`]s (target file, lock file) with
//! `recv_timeout(next_deadline)`, and calls the [`WatchSink`]. Sink calls happen on the worker
//! thread without holding any lock that `watch`/`unwatch` need, so a sink may call them.
//!
//! Lock state is always read back from the folder ([`lock_present`]) after things settle and
//! on a slow poll, so a missed notify event cannot leave an edit session hanging.
//!
//! Backends: `ReadDirectoryChangesW` on Windows, FSEvents on macOS. FSEvents coalesces: one
//! callback may carry several flags for a path (created, modified, renamed, removed, xattr), and
//! notify turns each flag into its own event, all with the same path. Only the file name
//! matters here, so the order and number of those events do not; every one restarts the quiet
//! period. Dropped-event notices (`MustScanSubDirs`) arrive as rescan events and re-check every
//! document. Paths from FSEvents are canonical (`/private/var/...` for `/var/...`), which is
//! why the watched folder is canonicalized too, and names may come in NFD, which is why names
//! are compared with [`name_key`]. A metadata-only event (macOS sets the
//! `com.apple.lastuseddate#PS` xattr when a file is opened) also settles, which is harmless: a
//! settle with unchanged content records no version.

use std::collections::HashMap;
use std::fs::File;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle, ThreadId};
use std::time::{Duration, Instant};

use notify::event::{Event, EventKind};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};

use super::office::{SettleTracker, is_lock_file_for, lock_present, name_key};
use crate::error::{AppError, AppResult};

pub const DEFAULT_SETTLE: Duration = Duration::from_millis(1500);

/// How often the lock state of every watched file is read back from disk even without events.
const LOCK_POLL: Duration = Duration::from_secs(5);

/// How many extra quiet periods to wait when the target is missing or cannot be opened (a save
/// in progress, a sharing violation) before reporting `file_settled` anyway.
const MAX_NOT_READY_RETRIES: u32 = 20;

pub trait WatchSink: Send + Sync + 'static {
    /// File target berubah dan sudah tenang. Dipanggil dari thread pemantau.
    fn file_settled(&self, document_id: &str);
    /// Kunci Office untuk target hilang setelah sebelumnya terlihat (file ditutup).
    fn lock_released(&self, document_id: &str);
    /// Kunci Office untuk target muncul (dipakai untuk menandai lock_seen).
    fn lock_appeared(&self, _document_id: &str) {}
}

/// Watches working-copy folders and reports settled saves and Office lock changes.
/// `Send + Sync`; dropping it stops the worker thread.
pub struct OfficeWatcher {
    shared: Arc<Mutex<Shared>>,
    tx: Sender<Msg>,
    worker: Option<JoinHandle<()>>,
    worker_id: ThreadId,
}

struct Shared {
    notify: RecommendedWatcher,
    targets: HashMap<String, Target>,
    /// Watched folder key -> (path given to notify, number of targets in it).
    folders: HashMap<String, (PathBuf, usize)>,
}

#[derive(Clone)]
struct Target {
    dir: PathBuf,
    dir_key: String,
    name: String,
    name_key: String,
}

impl Target {
    fn path(&self) -> PathBuf {
        self.dir.join(&self.name)
    }
}

enum Msg {
    Event(notify::Result<Event>),
    Watched(String),
    Unwatched(String),
    Shutdown,
}

impl OfficeWatcher {
    pub fn new(sink: Arc<dyn WatchSink>, settle: Duration) -> AppResult<Self> {
        let (tx, rx) = mpsc::channel::<Msg>();
        let event_tx = tx.clone();
        let notify = notify::recommended_watcher(move |event: notify::Result<Event>| {
            let _ = event_tx.send(Msg::Event(event));
        })
        .map_err(|err| {
            AppError::Storage(format!(
                "Mira tidak bisa menyiapkan pemantau file untuk salinan kerja. Detail: {err}"
            ))
        })?;
        let shared = Arc::new(Mutex::new(Shared {
            notify,
            targets: HashMap::new(),
            folders: HashMap::new(),
        }));
        let worker_state = Worker {
            shared: Arc::clone(&shared),
            sink,
            files: SettleTracker::new(settle),
            locks: SettleTracker::new(settle),
            lock_held: HashMap::new(),
            retries: HashMap::new(),
            next_poll: Instant::now() + LOCK_POLL,
        };
        let worker = thread::Builder::new()
            .name("mira-office-watch".into())
            .spawn(move || worker_state.run(rx))
            .map_err(|err| {
                AppError::Storage(format!(
                    "Mira tidak bisa menjalankan pemantau file untuk salinan kerja. Detail: {err}"
                ))
            })?;
        let worker_id = worker.thread().id();
        Ok(OfficeWatcher {
            shared,
            tx,
            worker: Some(worker),
            worker_id,
        })
    }

    /// Memantau folder induk `working_file` (tidak rekursif). Memanggil ulang untuk id yang sama mengganti target.
    pub fn watch(&self, document_id: &str, working_file: &Path) -> AppResult<()> {
        let name = working_file
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .filter(|n| !n.is_empty())
            .ok_or_else(|| {
                AppError::InvalidInput(format!(
                    "Path salinan kerja tidak valid: {}",
                    working_file.display()
                ))
            })?;
        let parent = working_file
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let dir = std::fs::canonicalize(parent)
            .map(|p| strip_verbatim(&p))
            .map_err(|err| {
                AppError::Storage(format!(
                    "Folder salinan kerja {} tidak bisa dibuka untuk dipantau. Detail: {err}",
                    parent.display()
                ))
            })?;
        let target = Target {
            dir_key: path_key(&dir),
            name_key: name_key(&name),
            name,
            dir,
        };

        {
            let mut shared = lock(&self.shared);
            let shared = &mut *shared;
            // Watch the new folder first so a failure leaves the old target in place.
            let already = shared
                .targets
                .get(document_id)
                .is_some_and(|old| old.dir_key == target.dir_key);
            if !already {
                match shared.folders.get_mut(&target.dir_key) {
                    Some((_, count)) => *count += 1,
                    None => {
                        shared
                            .notify
                            .watch(&target.dir, RecursiveMode::NonRecursive)
                            .map_err(|err| {
                                AppError::Storage(format!(
                                    "Mira tidak bisa memantau folder salinan kerja {}. Detail: {err}",
                                    target.dir.display()
                                ))
                            })?;
                        shared
                            .folders
                            .insert(target.dir_key.clone(), (target.dir.clone(), 1));
                    }
                }
                if let Some(old) = shared.targets.remove(document_id) {
                    release_folder(shared, &old.dir_key);
                }
            }
            shared.targets.insert(document_id.to_string(), target);
        }
        self.send(Msg::Watched(document_id.to_string()));
        Ok(())
    }

    /// Stops watching `document_id`. A sink call that is already running on the worker thread
    /// may still finish; no new call for this id starts after this returns.
    pub fn unwatch(&self, document_id: &str) {
        let removed = {
            let mut shared = lock(&self.shared);
            let shared = &mut *shared;
            match shared.targets.remove(document_id) {
                Some(old) => {
                    release_folder(shared, &old.dir_key);
                    true
                }
                None => false,
            }
        };
        if removed {
            self.send(Msg::Unwatched(document_id.to_string()));
        }
    }

    pub fn is_watching(&self, document_id: &str) -> bool {
        lock(&self.shared).targets.contains_key(document_id)
    }

    fn send(&self, msg: Msg) {
        let _ = self.tx.send(msg);
    }
}

impl Drop for OfficeWatcher {
    fn drop(&mut self) {
        self.send(Msg::Shutdown);
        if let Some(worker) = self.worker.take() {
            // Dropped from inside a sink call: the worker exits on its own after Shutdown.
            if thread::current().id() != self.worker_id {
                let _ = worker.join();
            }
        }
    }
}

fn lock(shared: &Mutex<Shared>) -> MutexGuard<'_, Shared> {
    shared.lock().unwrap_or_else(|e| e.into_inner())
}

/// Drops one user of a folder and stops watching it when none is left.
fn release_folder(shared: &mut Shared, dir_key: &str) {
    let Some((dir, count)) = shared.folders.get_mut(dir_key) else {
        return;
    };
    *count -= 1;
    if *count == 0 {
        let dir = dir.clone();
        shared.folders.remove(dir_key);
        // The folder may already be gone (session cleaned up); nothing to undo then.
        let _ = shared.notify.unwatch(&dir);
    }
}

/// `\\?\C:\x` -> `C:\x` and `\\?\UNC\srv\x` -> `\\srv\x`, so paths match what users and notify
/// print. Other paths are returned unchanged.
fn strip_verbatim(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path.to_path_buf()
    }
}

/// Comparison key for a folder: no verbatim prefix, one separator style, no trailing separator,
/// and folded with [`name_key`] (NFC, lowercase) on Windows and macOS, whose default file
/// systems (NTFS, APFS) are case-insensitive; APFS is also normalization-insensitive.
fn path_key(path: &Path) -> String {
    let stripped = strip_verbatim(path);
    let mut s = stripped.to_string_lossy().replace('/', "\\");
    while s.len() > 1 && s.ends_with('\\') {
        s.pop();
    }
    if cfg!(any(windows, target_os = "macos")) {
        name_key(&s)
    } else {
        s
    }
}

/// True when the target exists and can be opened for reading right now.
fn target_ready(path: &Path) -> bool {
    File::open(path).is_ok()
}

struct Worker {
    shared: Arc<Mutex<Shared>>,
    sink: Arc<dyn WatchSink>,
    files: SettleTracker,
    locks: SettleTracker,
    /// Last lock state reported to the sink per id (`true` = lock seen and not yet released).
    lock_held: HashMap<String, bool>,
    retries: HashMap<String, u32>,
    next_poll: Instant,
}

/// What one notify event means for the watched documents.
#[derive(Default)]
struct Touched {
    files: Vec<String>,
    locks: Vec<String>,
}

impl Worker {
    fn run(mut self, rx: Receiver<Msg>) {
        loop {
            let now = Instant::now();
            let deadline = [
                self.files.next_deadline(),
                self.locks.next_deadline(),
                Some(self.next_poll),
            ]
            .into_iter()
            .flatten()
            .min()
            .unwrap_or(now);
            let msg = match rx.recv_timeout(deadline.saturating_duration_since(now)) {
                Ok(msg) => Some(msg),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => break,
            };
            match msg {
                Some(Msg::Shutdown) => break,
                Some(Msg::Event(event)) => self.on_event(event),
                Some(Msg::Watched(id)) => {
                    // Watching an id again ("Buka lagi", recovery) must not drop a save that
                    // is still settling; an extra settle is harmless (same hash, no version).
                    let pending = self.files.is_pending(&id);
                    self.reset(&id);
                    if pending {
                        self.files.touch(&id, Instant::now());
                    }
                    // A lock that already exists (Office still open after Mira restarted) is
                    // reported right away.
                    self.check_lock(&id);
                }
                Some(Msg::Unwatched(id)) => self.reset(&id),
                None => {}
            }
            self.process_due(Instant::now());
        }
    }

    fn reset(&mut self, id: &str) {
        self.files.forget(id);
        self.locks.forget(id);
        self.lock_held.remove(id);
        self.retries.remove(id);
    }

    fn on_event(&mut self, event: notify::Result<Event>) {
        let now = Instant::now();
        let touched = self.resolve(&event);
        for id in touched.files {
            self.files.touch(&id, now);
        }
        for id in touched.locks {
            self.locks.touch(&id, now);
        }
    }

    /// Maps an event to the documents it concerns. Errors and rescan requests concern every
    /// document: re-reading costs little, and the session drops saves with an unchanged hash.
    fn resolve(&self, event: &notify::Result<Event>) -> Touched {
        let shared = lock(&self.shared);
        let everything = || Touched {
            files: shared.targets.keys().cloned().collect(),
            locks: shared.targets.keys().cloned().collect(),
        };
        let event = match event {
            Ok(event) => event,
            Err(_) => return everything(),
        };
        if event.need_rescan() {
            return everything();
        }
        if matches!(event.kind, EventKind::Access(_)) {
            return Touched::default();
        }
        let mut touched = Touched::default();
        for path in &event.paths {
            let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
                continue;
            };
            let parent_key = path_key(parent);
            let name = name.to_string_lossy();
            let key = name_key(&name);
            for (id, target) in &shared.targets {
                if target.dir_key != parent_key {
                    continue;
                }
                if key == target.name_key {
                    push_unique(&mut touched.files, id);
                } else if is_lock_file_for(&name, &target.name) {
                    push_unique(&mut touched.locks, id);
                }
            }
        }
        touched
    }

    fn process_due(&mut self, now: Instant) {
        for id in self.files.due(now) {
            let Some(target) = self.target(&id) else {
                continue;
            };
            let tries = self.retries.entry(id.clone()).or_insert(0);
            if !target_ready(&target.path()) && *tries < MAX_NOT_READY_RETRIES {
                // Between Office renames or under a sharing violation: wait another quiet period.
                *tries += 1;
                self.files.touch(&id, now);
                continue;
            }
            self.retries.remove(&id);
            self.call(&id, |sink, id| sink.file_settled(id));
            // The save may have come together with closing the file.
            self.locks.forget(&id);
            self.check_lock(&id);
        }
        for id in self.locks.due(now) {
            self.check_lock(&id);
        }
        if now >= self.next_poll {
            self.next_poll = now + LOCK_POLL;
            let ids: Vec<String> = lock(&self.shared).targets.keys().cloned().collect();
            for id in ids {
                self.check_lock(&id);
            }
        }
    }

    /// Reads the lock state from disk and reports a change. While a save of the same document
    /// is still settling, a release waits until after `file_settled` so the last save is not
    /// lost when the session ends on `lock_released`.
    fn check_lock(&mut self, id: &str) {
        let Some(target) = self.target(id) else {
            return;
        };
        let present = lock_present(&target.path());
        let held = self.lock_held.get(id).copied().unwrap_or(false);
        if present && !held {
            self.lock_held.insert(id.to_string(), true);
            self.call(id, |sink, id| sink.lock_appeared(id));
        } else if !present && held {
            if self.files.is_pending(id) {
                return;
            }
            self.lock_held.insert(id.to_string(), false);
            self.call(id, |sink, id| sink.lock_released(id));
        }
    }

    fn target(&self, id: &str) -> Option<Target> {
        lock(&self.shared).targets.get(id).cloned()
    }

    /// Calls the sink if `id` is still watched. No lock is held during the call, and a panic in
    /// the sink does not stop the worker.
    fn call(&self, id: &str, f: impl FnOnce(&dyn WatchSink, &str)) {
        if !lock(&self.shared).targets.contains_key(id) {
            return;
        }
        let sink = Arc::clone(&self.sink);
        let _ = catch_unwind(AssertUnwindSafe(|| f(sink.as_ref(), id)));
    }
}

fn push_unique(list: &mut Vec<String>, id: &str) {
    if !list.iter().any(|x| x == id) {
        list.push(id.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::{Condvar, OnceLock, Weak};

    const TEST_SETTLE: Duration = Duration::from_millis(300);
    const WAIT: Duration = Duration::from_secs(10);
    /// Long enough after the last expected call that a stray extra call would have shown up.
    const QUIET: Duration = Duration::from_millis(1500);
    const STEP: Duration = Duration::from_millis(30);

    #[derive(Clone, Debug, PartialEq, Eq)]
    enum Call {
        Settled(String),
        Appeared(String),
        Released(String),
    }

    #[derive(Default)]
    struct RecordingSink {
        calls: Mutex<Vec<Call>>,
        changed: Condvar,
        /// When set, `file_settled` unwatches the document from inside the callback.
        unwatch_on_settle: OnceLock<Weak<OfficeWatcher>>,
    }

    impl RecordingSink {
        fn push(&self, call: Call) {
            self.calls.lock().unwrap().push(call);
            self.changed.notify_all();
        }

        fn calls(&self) -> Vec<Call> {
            self.calls.lock().unwrap().clone()
        }

        fn count(&self, call: &Call) -> usize {
            self.calls().iter().filter(|c| *c == call).count()
        }

        /// Waits until `call` has been recorded at least `n` times.
        fn wait_for(&self, call: &Call, n: usize) {
            let deadline = Instant::now() + WAIT;
            let mut calls = self.calls.lock().unwrap();
            while calls.iter().filter(|c| *c == call).count() < n {
                let now = Instant::now();
                assert!(
                    now < deadline,
                    "timed out waiting for {call:?}; got {calls:?}"
                );
                calls = self.changed.wait_timeout(calls, deadline - now).unwrap().0;
            }
        }
    }

    impl WatchSink for RecordingSink {
        fn file_settled(&self, document_id: &str) {
            if let Some(watcher) = self.unwatch_on_settle.get().and_then(Weak::upgrade) {
                watcher.unwatch(document_id);
            }
            self.push(Call::Settled(document_id.to_string()));
        }
        fn lock_released(&self, document_id: &str) {
            self.push(Call::Released(document_id.to_string()));
        }
        fn lock_appeared(&self, document_id: &str) {
            self.push(Call::Appeared(document_id.to_string()));
        }
    }

    fn settled(id: &str) -> Call {
        Call::Settled(id.into())
    }
    fn appeared(id: &str) -> Call {
        Call::Appeared(id.into())
    }
    fn released(id: &str) -> Call {
        Call::Released(id.into())
    }

    /// A working-copy folder `<root>/<id>/<name>` with initial content.
    fn working_copy(root: &Path, id: &str, name: &str) -> PathBuf {
        let dir = root.join(id);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join(name);
        fs::write(&file, b"versi 1").unwrap();
        file
    }

    fn setup() -> (tempfile::TempDir, Arc<RecordingSink>, OfficeWatcher) {
        let root = tempfile::tempdir().unwrap();
        let sink = Arc::new(RecordingSink::default());
        let watcher = OfficeWatcher::new(sink.clone(), TEST_SETTLE).unwrap();
        (root, sink, watcher)
    }

    fn watch(watcher: &OfficeWatcher, id: &str, file: &Path) {
        if cfg!(target_os = "macos") {
            // Let fseventsd journal the setup writes first, so they cannot show up as
            // events after the watch starts.
            thread::sleep(Duration::from_millis(300));
        }
        watcher.watch(id, file).unwrap();
        // Give the backend a moment to arm the directory watch.
        thread::sleep(Duration::from_millis(100));
    }

    /// Word: write `~WRD0000.tmp`, rename the original to `~WRL0001.tmp`, rename the new temp to
    /// the original name, delete the old copy.
    fn word_save(file: &Path, content: &[u8]) {
        let dir = file.parent().unwrap();
        let new_tmp = dir.join("~WRD0000.tmp");
        let old_tmp = dir.join("~WRL0001.tmp");
        fs::write(&new_tmp, content).unwrap();
        thread::sleep(STEP);
        fs::rename(file, &old_tmp).unwrap();
        thread::sleep(STEP);
        fs::rename(&new_tmp, file).unwrap();
        thread::sleep(STEP);
        fs::remove_file(&old_tmp).unwrap();
    }

    /// Excel: write `A1B2C3D4`, rename the original to `F3E2D1C0.tmp`, rename the new file to the
    /// original name, delete the old copy.
    fn excel_save(file: &Path, content: &[u8]) {
        let dir = file.parent().unwrap();
        let new_tmp = dir.join("A1B2C3D4");
        let old_tmp = dir.join("F3E2D1C0.tmp");
        fs::write(&new_tmp, content).unwrap();
        thread::sleep(STEP);
        fs::rename(file, &old_tmp).unwrap();
        thread::sleep(STEP);
        fs::rename(&new_tmp, file).unwrap();
        thread::sleep(STEP);
        fs::remove_file(&old_tmp).unwrap();
    }

    /// Office for Mac, sandboxed safe save: a hidden `.dat.nosync` scratch file, the new content
    /// written inside a hidden `.sb-` folder next to the document, an atomic rename onto the
    /// document (it never disappears), then the helpers are removed.
    fn mac_safe_save(file: &Path, content: &[u8]) {
        let dir = file.parent().unwrap();
        let scratch = dir.join(".dat.nosync0d4a.3jXWxy");
        fs::write(&scratch, b"x").unwrap();
        let helper = dir.join(".sb-6c1f02a1-Ab12Cd");
        fs::create_dir(&helper).unwrap();
        let temp = helper.join(file.file_name().unwrap());
        fs::write(&temp, content).unwrap();
        thread::sleep(STEP);
        fs::rename(&temp, file).unwrap();
        thread::sleep(STEP);
        fs::remove_dir(&helper).unwrap();
        fs::remove_file(&scratch).unwrap();
    }

    /// Excel for Mac: write the 8-hex temp file, delete the document, rename the temp file to
    /// the document name (the document is missing for a moment).
    fn mac_excel_save(file: &Path, content: &[u8]) {
        let dir = file.parent().unwrap();
        let temp = dir.join("Cedd4100");
        fs::write(&temp, content).unwrap();
        thread::sleep(STEP);
        fs::remove_file(file).unwrap();
        thread::sleep(STEP);
        fs::rename(&temp, file).unwrap();
    }

    /// Feeds an event to the worker as if the backend had sent it.
    fn inject(watcher: &OfficeWatcher, event: Event) {
        watcher.send(Msg::Event(Ok(event)));
    }

    #[test]
    fn watcher_is_send_and_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<OfficeWatcher>();
    }

    #[test]
    fn word_save_sequence_settles_once() {
        let (root, sink, watcher) = setup();
        let file = working_copy(root.path(), "doc-a", "laporan-bulanan.docx");
        watch(&watcher, "doc-a", &file);
        word_save(&file, b"versi 2");
        sink.wait_for(&settled("doc-a"), 1);
        thread::sleep(QUIET);
        assert_eq!(sink.calls(), vec![settled("doc-a")]);
    }

    #[test]
    fn excel_save_sequence_settles_once() {
        let (root, sink, watcher) = setup();
        let file = working_copy(root.path(), "doc-x", "RAB proyek.xlsx");
        watch(&watcher, "doc-x", &file);
        excel_save(&file, b"versi 2");
        sink.wait_for(&settled("doc-x"), 1);
        thread::sleep(QUIET);
        assert_eq!(sink.calls(), vec![settled("doc-x")]);
    }

    #[test]
    fn mac_safe_save_settles_once() {
        let (root, sink, watcher) = setup();
        let file = working_copy(root.path(), "doc-a", "laporan-bulanan.docx");
        watch(&watcher, "doc-a", &file);
        mac_safe_save(&file, b"versi 2");
        sink.wait_for(&settled("doc-a"), 1);
        thread::sleep(QUIET);
        assert_eq!(sink.calls(), vec![settled("doc-a")]);
        assert_eq!(fs::read(&file).unwrap(), b"versi 2");
    }

    #[test]
    fn mac_excel_delete_then_rename_settles_once() {
        let (root, sink, watcher) = setup();
        let file = working_copy(root.path(), "doc-x", "RAB proyek.xlsx");
        watch(&watcher, "doc-x", &file);
        mac_excel_save(&file, b"versi 2");
        sink.wait_for(&settled("doc-x"), 1);
        thread::sleep(QUIET);
        assert_eq!(sink.calls(), vec![settled("doc-x")]);
    }

    /// Word for Mac: the owner file name may be written in NFD while Mira named the document in
    /// NFC. Open, save, close gives appeared, settled, released in that order.
    #[test]
    fn mac_word_session_with_decomposed_owner_file() {
        let (root, sink, watcher) = setup();
        let file = working_copy(root.path(), "doc-a", "Laporan Kaf\u{e9} Mei.docx");
        let lock = file
            .parent()
            .unwrap()
            .join("~$poran Kafe\u{301} Mei.docx");
        watch(&watcher, "doc-a", &file);
        fs::write(&lock, b"pemilik").unwrap();
        sink.wait_for(&appeared("doc-a"), 1);

        mac_safe_save(&file, b"versi 2");
        fs::remove_file(&lock).unwrap();
        sink.wait_for(&released("doc-a"), 1);
        thread::sleep(QUIET);
        assert_eq!(
            sink.calls(),
            vec![appeared("doc-a"), settled("doc-a"), released("doc-a")]
        );
    }

    /// What FSEvents delivers, fed in directly so it runs on every platform: one coalesced
    /// change arrives as several events for the same path, with the name in another case and
    /// in NFD; helper files and the `.sb-` folder content are ignored; a rescan re-checks every
    /// document.
    #[test]
    fn fsevents_style_coalesced_events() {
        use notify::event::{
            CreateKind, DataChange, Flag, MetadataKind, ModifyKind, RemoveKind, RenameMode,
        };

        let (root, sink, watcher) = setup();
        let file = working_copy(root.path(), "doc-a", "Laporan Kaf\u{e9}.docx");
        watch(&watcher, "doc-a", &file);
        let dir = strip_verbatim(&fs::canonicalize(file.parent().unwrap()).unwrap());

        // Helpers next to the document and files inside the helper folder: nothing.
        for path in [
            dir.join(".dat.nosync0d4a.3jXWxy"),
            dir.join(".sb-6c1f02a1-Ab12Cd"),
            dir.join(".sb-6c1f02a1-Ab12Cd").join("Laporan Kaf\u{e9}.docx"),
            dir.join("Cedd4100"),
        ] {
            inject(
                &watcher,
                Event::new(EventKind::Create(CreateKind::Any)).add_path(path.clone()),
            );
            inject(
                &watcher,
                Event::new(EventKind::Remove(RemoveKind::Any)).add_path(path),
            );
        }
        thread::sleep(QUIET);
        assert_eq!(sink.calls(), Vec::<Call>::new());

        // One coalesced FSEvents record (created, renamed, modified, xattr) for the target.
        let target = dir.join("LAPORAN KAFE\u{301}.DOCX");
        for kind in [
            EventKind::Create(CreateKind::File),
            EventKind::Modify(ModifyKind::Name(RenameMode::Any)),
            EventKind::Modify(ModifyKind::Data(DataChange::Content)),
            EventKind::Modify(ModifyKind::Metadata(MetadataKind::Extended)),
        ] {
            inject(&watcher, Event::new(kind).add_path(target.clone()));
        }
        sink.wait_for(&settled("doc-a"), 1);
        thread::sleep(QUIET);
        assert_eq!(sink.calls(), vec![settled("doc-a")]);

        // Dropped events: FSEvents asks for a rescan, every document settles once more.
        inject(&watcher, Event::new(EventKind::Other).set_flag(Flag::Rescan));
        sink.wait_for(&settled("doc-a"), 2);
        thread::sleep(QUIET);
        assert_eq!(sink.count(&settled("doc-a")), 2);
        assert_eq!(sink.calls().len(), 2);
    }

    #[test]
    fn two_saves_apart_settle_twice() {
        let (root, sink, watcher) = setup();
        let file = working_copy(root.path(), "doc-a", "surat.docx");
        watch(&watcher, "doc-a", &file);
        word_save(&file, b"versi 2");
        sink.wait_for(&settled("doc-a"), 1);
        thread::sleep(Duration::from_millis(200));
        fs::write(&file, b"versi 3").unwrap();
        sink.wait_for(&settled("doc-a"), 2);
        thread::sleep(QUIET);
        assert_eq!(sink.count(&settled("doc-a")), 2);
    }

    #[test]
    fn temp_files_alone_do_not_settle() {
        let (root, sink, watcher) = setup();
        let file = working_copy(root.path(), "doc-a", "laporan.docx");
        let dir = file.parent().unwrap().to_path_buf();
        watch(&watcher, "doc-a", &file);
        for name in ["~WRD0003.tmp", "A1B2C3D4", "catatan lain.txt"] {
            let path = dir.join(name);
            fs::write(&path, b"x").unwrap();
            thread::sleep(STEP);
            fs::write(&path, b"xy").unwrap();
            thread::sleep(STEP);
            fs::remove_file(&path).unwrap();
        }
        thread::sleep(QUIET);
        assert_eq!(sink.calls(), Vec::<Call>::new());
    }

    #[test]
    fn lock_appears_and_releases_once() {
        let (root, sink, watcher) = setup();
        let file = working_copy(root.path(), "doc-a", "laporan-bulanan.docx");
        let lock = file.parent().unwrap().join("~$poran-bulanan.docx");
        watch(&watcher, "doc-a", &file);

        fs::write(&lock, b"kunci").unwrap();
        thread::sleep(STEP);
        fs::write(&lock, b"kunci lagi").unwrap();
        sink.wait_for(&appeared("doc-a"), 1);

        fs::remove_file(&lock).unwrap();
        sink.wait_for(&released("doc-a"), 1);
        thread::sleep(QUIET);
        assert_eq!(sink.calls(), vec![appeared("doc-a"), released("doc-a")]);
    }

    #[test]
    fn lock_matching_ignores_case_and_handles_libreoffice() {
        let (root, sink, watcher) = setup();
        let file = working_copy(root.path(), "doc-a", "RAB Proyek.xlsx");
        let lock = file.parent().unwrap().join(".~lock.rab proyek.XLSX#");
        watch(&watcher, "doc-a", &file);
        fs::write(&lock, b"kunci").unwrap();
        sink.wait_for(&appeared("doc-a"), 1);
        fs::remove_file(&lock).unwrap();
        sink.wait_for(&released("doc-a"), 1);
        assert_eq!(sink.calls(), vec![appeared("doc-a"), released("doc-a")]);
    }

    #[test]
    fn existing_lock_is_reported_on_watch() {
        let (root, sink, watcher) = setup();
        let file = working_copy(root.path(), "doc-a", "RAB.xlsx");
        let lock = file.parent().unwrap().join("~$RAB.xlsx");
        fs::write(&lock, b"kunci").unwrap();
        watch(&watcher, "doc-a", &file);
        sink.wait_for(&appeared("doc-a"), 1);
        fs::remove_file(&lock).unwrap();
        sink.wait_for(&released("doc-a"), 1);
        thread::sleep(QUIET);
        assert_eq!(sink.calls(), vec![appeared("doc-a"), released("doc-a")]);
    }

    #[test]
    fn save_then_close_reports_the_save_before_the_release() {
        let (root, sink, watcher) = setup();
        let file = working_copy(root.path(), "doc-a", "laporan-bulanan.docx");
        let lock = file.parent().unwrap().join("~$poran-bulanan.docx");
        watch(&watcher, "doc-a", &file);
        fs::write(&lock, b"kunci").unwrap();
        sink.wait_for(&appeared("doc-a"), 1);

        word_save(&file, b"versi 2");
        fs::remove_file(&lock).unwrap();
        sink.wait_for(&released("doc-a"), 1);
        thread::sleep(QUIET);
        assert_eq!(
            sink.calls(),
            vec![appeared("doc-a"), settled("doc-a"), released("doc-a")]
        );
    }

    #[test]
    fn two_documents_stay_separate() {
        let (root, sink, watcher) = setup();
        let word = working_copy(root.path(), "doc-w", "laporan.docx");
        let excel = working_copy(root.path(), "doc-x", "RAB proyek.xlsx");
        watch(&watcher, "doc-w", &word);
        watch(&watcher, "doc-x", &excel);
        assert!(watcher.is_watching("doc-w") && watcher.is_watching("doc-x"));

        word_save(&word, b"versi 2");
        sink.wait_for(&settled("doc-w"), 1);
        thread::sleep(QUIET);
        assert_eq!(sink.calls(), vec![settled("doc-w")]);

        let excel_lock = excel.parent().unwrap().join("~$RAB proyek.xlsx");
        fs::write(&excel_lock, b"kunci").unwrap();
        excel_save(&excel, b"versi 2");
        sink.wait_for(&settled("doc-x"), 1);
        sink.wait_for(&appeared("doc-x"), 1);
        thread::sleep(QUIET);
        assert_eq!(sink.count(&settled("doc-w")), 1);
        assert_eq!(sink.count(&settled("doc-x")), 1);
        assert_eq!(sink.count(&appeared("doc-w")), 0);
        assert_eq!(sink.calls().len(), 3);
    }

    #[test]
    fn unwatch_stops_callbacks() {
        let (root, sink, watcher) = setup();
        let file = working_copy(root.path(), "doc-a", "laporan.docx");
        watch(&watcher, "doc-a", &file);
        assert!(watcher.is_watching("doc-a"));
        watcher.unwatch("doc-a");
        watcher.unwatch("doc-a");
        assert!(!watcher.is_watching("doc-a"));

        word_save(&file, b"versi 2");
        fs::write(file.parent().unwrap().join("~$laporan.docx"), b"kunci").unwrap();
        thread::sleep(QUIET);
        assert_eq!(sink.calls(), Vec::<Call>::new());
    }

    #[test]
    fn unwatch_during_pending_burst_drops_it() {
        let (root, sink, watcher) = setup();
        let file = working_copy(root.path(), "doc-a", "laporan.docx");
        watch(&watcher, "doc-a", &file);
        word_save(&file, b"versi 2");
        watcher.unwatch("doc-a");
        thread::sleep(QUIET);
        assert_eq!(sink.calls(), Vec::<Call>::new());
    }

    #[test]
    fn rewatch_replaces_the_target() {
        let (root, sink, watcher) = setup();
        let old = working_copy(root.path(), "lama", "surat.docx");
        let new = working_copy(root.path(), "baru", "surat (2).docx");
        watch(&watcher, "doc-a", &old);
        watch(&watcher, "doc-a", &new);
        assert!(watcher.is_watching("doc-a"));

        word_save(&old, b"versi lama");
        thread::sleep(QUIET);
        assert_eq!(sink.calls(), Vec::<Call>::new());

        word_save(&new, b"versi baru");
        sink.wait_for(&settled("doc-a"), 1);
        thread::sleep(QUIET);
        assert_eq!(sink.calls(), vec![settled("doc-a")]);
    }

    #[test]
    fn differently_cased_path_still_matches() {
        let (root, sink, watcher) = setup();
        let file = working_copy(root.path(), "doc-a", "Laporan.docx");
        let given = if cfg!(any(windows, target_os = "macos")) {
            file.parent().unwrap().join("LAPORAN.DOCX")
        } else {
            file.clone()
        };
        watch(&watcher, "doc-a", &given);
        excel_save(&file, b"versi 2");
        sink.wait_for(&settled("doc-a"), 1);
        thread::sleep(QUIET);
        assert_eq!(sink.calls(), vec![settled("doc-a")]);
    }

    #[test]
    fn sink_may_unwatch_from_inside_a_callback() {
        let root = tempfile::tempdir().unwrap();
        let sink = Arc::new(RecordingSink::default());
        let watcher = Arc::new(OfficeWatcher::new(sink.clone(), TEST_SETTLE).unwrap());
        sink.unwatch_on_settle
            .set(Arc::downgrade(&watcher))
            .unwrap();
        let file = working_copy(root.path(), "doc-a", "laporan.docx");
        watch(&watcher, "doc-a", &file);
        word_save(&file, b"versi 2");
        sink.wait_for(&settled("doc-a"), 1);
        assert!(!watcher.is_watching("doc-a"));
        fs::write(&file, b"versi 3").unwrap();
        thread::sleep(QUIET);
        assert_eq!(sink.calls(), vec![settled("doc-a")]);
    }

    #[test]
    fn watch_rejects_a_missing_folder() {
        let (root, _sink, watcher) = setup();
        let err = watcher
            .watch("doc-a", &root.path().join("tidak-ada").join("x.docx"))
            .unwrap_err();
        assert_eq!(err.code(), "storage");
        assert!(!watcher.is_watching("doc-a"));
    }

    #[test]
    fn path_keys_ignore_verbatim_prefix_separators_and_case() {
        assert_eq!(
            path_key(Path::new(r"\\?\C:\Data\working\abc")),
            path_key(Path::new("C:/Data/working/abc/"))
        );
        if cfg!(any(windows, target_os = "macos")) {
            assert_eq!(
                path_key(Path::new(r"C:\DATA\Working\ABC")),
                path_key(Path::new(r"c:\data\working\abc"))
            );
            assert_eq!(
                path_key(Path::new("/Users/budi/Library/Application Support/Kafe\u{301}")),
                path_key(Path::new("/users/BUDI/Library/Application Support/Kaf\u{e9}/"))
            );
        }
        assert_eq!(
            strip_verbatim(Path::new(r"\\?\UNC\server\share\x")),
            PathBuf::from(r"\\server\share\x")
        );
    }
}
