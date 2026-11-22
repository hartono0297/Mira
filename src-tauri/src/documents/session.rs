//! The edit flow (plan, decisions 6 to 11): adding files, working copies,
//! a new version after every settled save, finishing an edit, read-only
//! copies, and recovering edit sessions when Mira starts.
//!
//! No Tauri types here, so tests drive it directly. The Tauri side
//! (`documents::runtime`) supplies the [`Launcher`] (Windows "open with the
//! default app") and the [`DocumentEvents`] emitter.
//!
//! Locking:
//! - The core mutex (`MiraState::with_core`) is held only for database work.
//!   Files are hashed into the blob store before taking it, so a large file
//!   never blocks the window.
//! - Session work on one document (start, save, finish, restore, recovery) is
//!   serialized by a per-document mutex, so a save that settles while
//!   "Selesai mengedit" runs is neither lost nor recorded twice. It is always
//!   taken before the core mutex, never the other way round.
//! - Watcher callbacks run on the watcher thread. `OfficeWatcher::unwatch`
//!   does not wait for a running callback, so every callback re-reads the
//!   session row and tolerates a session that has already ended.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};
use std::time::Duration;

use rusqlite::Connection;

use crate::blobs::{BlobHash, BlobStore};
use crate::clock;
use crate::documents::access::{DocAction, DocumentAccess};
use crate::documents::kinds::DocumentKind;
use crate::documents::office;
use crate::documents::store::{
    self, DocScope, DocumentDetail, DocumentRecord, DocumentSummary, EditSession, VersionRecord,
};
use crate::documents::sync::DocumentSync;
use crate::documents::watch::{OfficeWatcher, WatchSink};
use crate::error::{AppError, AppResult};
use crate::identity::Identity;
use crate::state::{Core, MiraState};

/// Folder under the data folder with one subfolder per edited document.
pub const WORKING_DIR: &str = "working";
/// Folder under the data folder with read-only copies, one subfolder per version.
pub const VIEW_DIR: &str = "view";

/// Opens a file with the app Windows associates with it (Word, Excel, ...).
pub trait Launcher: Send + Sync {
    fn open(&self, path: &Path) -> AppResult<()>;
}

/// Told after every change to a document, so the window can reload.
pub trait DocumentEvents: Send + Sync {
    fn changed(&self, document_id: &str);
}

/// What the environment plugs in.
pub struct DocsDeps {
    pub access: Arc<dyn DocumentAccess>,
    pub sync: Arc<dyn DocumentSync>,
    pub launcher: Arc<dyn Launcher>,
    pub events: Arc<dyn DocumentEvents>,
    /// Quiet time before a save counts (`watch::DEFAULT_SETTLE` in the app).
    pub settle: Duration,
}

/// Everything the document commands and the watcher callbacks need.
pub struct DocsEnv {
    state: MiraState,
    blobs: BlobStore,
    data_dir: PathBuf,
    access: Arc<dyn DocumentAccess>,
    sync: Arc<dyn DocumentSync>,
    launcher: Arc<dyn Launcher>,
    events: Arc<dyn DocumentEvents>,
    watcher: OfficeWatcher,
    doc_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

/// Watcher sink that forwards to the environment. It holds a `Weak` (set once
/// the environment exists) so the watcher, owned by the environment, does not
/// keep the environment alive.
struct SessionSink {
    env: OnceLock<Weak<DocsEnv>>,
}

impl SessionSink {
    fn env(&self) -> Option<Arc<DocsEnv>> {
        self.env.get().and_then(Weak::upgrade)
    }
}

impl WatchSink for SessionSink {
    fn file_settled(&self, document_id: &str) {
        if let Some(env) = self.env() {
            env.on_file_settled(document_id);
        }
    }

    fn lock_released(&self, document_id: &str) {
        if let Some(env) = self.env() {
            env.on_lock_released(document_id);
        }
    }

    fn lock_appeared(&self, document_id: &str) {
        if let Some(env) = self.env() {
            env.on_lock_appeared(document_id);
        }
    }
}

/// What `start_edit` decided inside the database lock.
enum EditPlan {
    /// "Buka lagi": this laptop already edits the document.
    Reopen {
        doc: DocumentRecord,
        session: EditSession,
    },
    Start {
        doc: DocumentRecord,
        base: BlobHash,
        parents: Vec<String>,
        me: String,
    },
}

const STILL_OPEN: &str =
    "File masih terbuka di Word/Excel. Simpan dan tutup dulu, lalu tekan Selesai mengedit lagi.";

fn log(what: &str, document_id: &str, err: &AppError) {
    eprintln!(
        "Mira: {what} untuk dokumen {document_id} gagal [{}]: {err}",
        err.code()
    );
}

fn lock_mutex<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl DocsEnv {
    /// Needs the data folder (not the database), so it works even while the
    /// core cannot be opened yet; commands then report the core's error.
    pub fn new(state: MiraState, deps: DocsDeps) -> AppResult<Arc<Self>> {
        let data_dir = state.data_dir()?.to_path_buf();
        let blobs = BlobStore::in_data_dir(&data_dir)?;
        let sink = Arc::new(SessionSink {
            env: OnceLock::new(),
        });
        let watcher = OfficeWatcher::new(sink.clone() as Arc<dyn WatchSink>, deps.settle)?;
        let env = Arc::new(DocsEnv {
            state,
            blobs,
            data_dir,
            access: deps.access,
            sync: deps.sync,
            launcher: deps.launcher,
            events: deps.events,
            watcher,
            doc_locks: Mutex::new(HashMap::new()),
        });
        let _ = sink.env.set(Arc::downgrade(&env));
        Ok(env)
    }

    pub fn blobs(&self) -> &BlobStore {
        &self.blobs
    }

    /// `<data>/working/<document_id>`.
    pub fn working_dir(&self, document_id: &str) -> PathBuf {
        self.data_dir.join(WORKING_DIR).join(document_id)
    }

    fn core<T>(&self, f: impl FnOnce(&mut Connection, &Identity) -> AppResult<T>) -> AppResult<T> {
        self.state.with_core(|core| {
            let Core { db, identity } = core;
            f(db, identity)
        })
    }

    fn check(
        &self,
        conn: &Connection,
        me: &Identity,
        doc: &DocumentRecord,
        action: DocAction,
    ) -> AppResult<()> {
        self.access.check(conn, me, &doc.scope(), action)
    }

    fn doc_lock(&self, document_id: &str) -> Arc<Mutex<()>> {
        lock_mutex(&self.doc_locks)
            .entry(document_id.to_owned())
            .or_default()
            .clone()
    }

    // -----------------------------------------------------------------------
    // Views

    /// One library (`None` = "Umum"), sorted by name.
    pub fn list(&self, project_id: Option<&str>) -> AppResult<Vec<DocumentSummary>> {
        let now = clock::now_rfc3339();
        self.core(|db, me| {
            store::summaries(db, &self.blobs, me, self.access.as_ref(), project_id, &now)
        })
    }

    pub fn summary(&self, document_id: &str) -> AppResult<DocumentSummary> {
        let now = clock::now_rfc3339();
        self.core(|db, me| {
            store::summary(db, &self.blobs, me, self.access.as_ref(), document_id, &now)
        })
    }

    pub fn detail(&self, document_id: &str) -> AppResult<DocumentDetail> {
        let now = clock::now_rfc3339();
        self.core(|db, me| {
            store::detail(db, &self.blobs, me, self.access.as_ref(), document_id, &now)
        })
    }

    // -----------------------------------------------------------------------
    // Adding files

    /// "Tambah file": every path is checked first (a regular file that can be
    /// read), so a bad pick adds nothing. Then each file is hashed into the
    /// blob store and becomes a document with version 1. Returns the new
    /// documents in the order given.
    pub fn add_documents(
        &self,
        paths: &[PathBuf],
        project_id: Option<&str>,
    ) -> AppResult<Vec<DocumentSummary>> {
        let scope = DocScope {
            team_id: None,
            project_id: project_id.map(str::to_owned),
        };
        self.core(|db, me| self.access.check(db, me, &scope, DocAction::Add))?;
        for path in paths {
            check_source(path)?;
        }
        let mut added = Vec::with_capacity(paths.len());
        for path in paths {
            let name = file_label(path);
            let blob = self.blobs.put_file(path)?;
            let now = clock::now_rfc3339();
            let (doc, first) = self.core(|db, me| {
                store::create_document(db, &scope, &name, &blob, me.public_key_hex(), &now)
            })?;
            self.sync.document_added(&doc, &first);
            self.events.changed(&doc.id);
            added.push(doc.id);
        }
        added.iter().map(|id| self.summary(id)).collect()
    }

    // -----------------------------------------------------------------------
    // Editing

    /// "Edit di Word/Excel". Prepares the working copy, starts watching it and
    /// opens it. While this laptop already edits the document ("Buka lagi")
    /// the existing working copy is opened again.
    ///
    /// In a conflict `from_version_id` must name one of the heads (manual
    /// merge): the first save gets every head as parent. Otherwise the edit
    /// starts from the current version; an older version is refused (restore
    /// it first).
    ///
    /// If the app cannot be opened the session is kept (the user can press
    /// "Buka lagi") and `open_failed` is returned.
    pub fn start_edit(
        &self,
        document_id: &str,
        from_version_id: Option<&str>,
    ) -> AppResult<DocumentSummary> {
        let doc_lock = self.doc_lock(document_id);
        let _guard = lock_mutex(&doc_lock);
        let plan = self.core(|db, me| {
            let doc = store::get_document(db, document_id)?;
            self.check(db, me, &doc, DocAction::Edit)?;
            if !doc.kind.editable() {
                return Err(AppError::InvalidInput(
                    "Hanya file Word dan Excel yang bisa diedit dari Mira. Pakai Buka untuk file ini."
                        .into(),
                ));
            }
            if let Some(session) = store::edit_session(db, document_id)? {
                return Ok(EditPlan::Reopen { doc, session });
            }
            let heads = store::heads(db, document_id)?;
            let (base, parents) = edit_base(&heads, from_version_id)?;
            Ok(EditPlan::Start {
                doc,
                base,
                parents,
                me: me.public_key_hex().to_owned(),
            })
        })?;

        match plan {
            EditPlan::Reopen { doc, session } => {
                let working = &session.working_path;
                if !working.is_file() {
                    // Deleted by hand: bring back the last saved content.
                    self.blobs.copy_to(&session.last_hash, working)?;
                }
                if !self.watcher.is_watching(document_id) {
                    self.watcher.watch(document_id, working)?;
                }
                self.launch(&doc, working)?;
            }
            EditPlan::Start {
                doc,
                base,
                parents,
                me,
            } => {
                check_launchable(&doc.name)?;
                let dir = self.working_dir(&doc.id);
                clear_dir(&dir)?;
                let working = dir.join(fit_file_name(&dir, &doc.name));
                self.blobs.copy_to(&base, &working)?;
                let now = clock::now_rfc3339();
                let session = EditSession {
                    document_id: doc.id.clone(),
                    editor: me.clone(),
                    parent_ids: parents,
                    working_path: working.clone(),
                    started_at: now.clone(),
                    last_hash: base,
                    last_saved_at: None,
                    lock_seen: false,
                };
                if let Err(err) = self.core(|db, _| store::insert_edit_session(db, &session)) {
                    remove_dir_best_effort(&dir);
                    return Err(err);
                }
                if let Err(err) = self.watcher.watch(&doc.id, &working) {
                    let _ = self.core(|db, _| store::delete_edit_session(db, &doc.id));
                    remove_dir_best_effort(&dir);
                    return Err(err);
                }
                self.sync.editing_changed(&doc.id, &me, true, &now);
                self.events.changed(&doc.id);
                self.launch(&doc, &working)?;
            }
        }
        self.summary(document_id)
    }

    /// "Selesai mengedit". Refused while Office still has the file open, so a
    /// later save cannot be lost. A save made just before becomes a version.
    /// Without a session this only returns the summary.
    pub fn finish_edit(&self, document_id: &str) -> AppResult<DocumentSummary> {
        let doc_lock = self.doc_lock(document_id);
        let _guard = lock_mutex(&doc_lock);
        let session = self.core(|db, me| {
            let doc = store::get_document(db, document_id)?;
            self.check(db, me, &doc, DocAction::View)?;
            store::edit_session(db, document_id)
        })?;
        if let Some(session) = session {
            if office::lock_present(&session.working_path) {
                return Err(AppError::DocumentEditing(STILL_OPEN.into()));
            }
            self.record_save(document_id, &session.working_path)?;
            self.end_session(&session)?;
        }
        self.summary(document_id)
    }

    /// Watcher: a save of the working copy settled.
    pub fn on_file_settled(&self, document_id: &str) {
        let doc_lock = self.doc_lock(document_id);
        let _guard = lock_mutex(&doc_lock);
        let session = match self.core(|db, _| store::edit_session(db, document_id)) {
            Ok(Some(s)) => s,
            Ok(None) => return,
            Err(err) => return log("membaca sesi edit", document_id, &err),
        };
        if let Err(err) = self.record_save(document_id, &session.working_path) {
            log("menyimpan versi baru", document_id, &err);
        }
    }

    /// Watcher: Office opened the working copy (its lock file appeared).
    pub fn on_lock_appeared(&self, document_id: &str) {
        if let Err(err) = self.core(|db, _| store::set_lock_seen(db, document_id)) {
            log("mencatat file terbuka", document_id, &err);
        }
    }

    /// Watcher: Office closed the working copy. Takes a last look at the file,
    /// then ends the session. Ignored unless the lock was seen before (an app
    /// without lock files is finished with the button instead).
    pub fn on_lock_released(&self, document_id: &str) {
        let doc_lock = self.doc_lock(document_id);
        let _guard = lock_mutex(&doc_lock);
        let session = match self.core(|db, _| store::edit_session(db, document_id)) {
            Ok(Some(s)) if s.lock_seen => s,
            Ok(_) => return,
            Err(err) => return log("membaca sesi edit", document_id, &err),
        };
        if let Err(err) = self.record_save(document_id, &session.working_path) {
            // Keep the session so the save is not lost; "Selesai mengedit"
            // or the next start tries again.
            return log("menyimpan versi terakhir", document_id, &err);
        }
        if office::lock_present(&session.working_path) {
            // Opened again in the meantime.
            return;
        }
        if let Err(err) = self.end_session(&session) {
            log("mengakhiri sesi edit", document_id, &err);
        }
    }

    /// At start: edit sessions left from before Mira closed. A working copy
    /// changed meanwhile becomes a version. If Office still has it open,
    /// watching resumes; otherwise the session ends. Errors of one session are
    /// logged and do not stop the others.
    pub fn recover_sessions(&self) -> AppResult<()> {
        let sessions = self.core(|db, _| store::edit_sessions(db))?;
        for session in sessions {
            let id = session.document_id.clone();
            let doc_lock = self.doc_lock(&id);
            let _guard = lock_mutex(&doc_lock);
            if let Err(err) = self.recover_one(&session) {
                log("memulihkan sesi edit", &id, &err);
            }
        }
        Ok(())
    }

    fn recover_one(&self, session: &EditSession) -> AppResult<()> {
        let id = &session.document_id;
        let working = &session.working_path;
        if !working.is_file() {
            return self.end_session(session);
        }
        let saved = self.record_save(id, working);
        let open = office::lock_present(working);
        if open || saved.is_err() {
            if open {
                self.core(|db, _| store::set_lock_seen(db, id))?;
            }
            // "Buka lagi" may have resumed watching already; watching again
            // would restart the watcher's state for this id.
            if !self.watcher.is_watching(id) {
                self.watcher.watch(id, working)?;
            }
            return saved.map(|_| ());
        }
        self.end_session(session)
    }

    /// Hashes the working copy and records a version if it changed. A missing
    /// file (between Office renames) or a session that ended meanwhile is not
    /// an error.
    fn record_save(&self, document_id: &str, working: &Path) -> AppResult<Option<VersionRecord>> {
        if !working.is_file() {
            return Ok(None);
        }
        let blob = self.blobs.put_file(working)?;
        let now = clock::now_rfc3339();
        let saved = self.core(|db, me| {
            match store::record_saved_version(db, document_id, &blob, me.public_key_hex(), &now) {
                Ok(Some(v)) => Ok(Some((store::get_document(db, document_id)?, v))),
                Ok(None) | Err(AppError::NotFound(_)) => Ok(None),
                Err(err) => Err(err),
            }
        })?;
        Ok(saved.map(|(doc, version)| {
            self.sync.version_added(&doc, &version);
            self.events.changed(document_id);
            version
        }))
    }

    /// Deletes the session row, stops watching and removes the working
    /// folder (best effort; a leftover folder is cleared by the next edit).
    fn end_session(&self, session: &EditSession) -> AppResult<()> {
        let id = &session.document_id;
        self.core(|db, _| store::delete_edit_session(db, id))?;
        self.watcher.unwatch(id);
        self.sync
            .editing_changed(id, &session.editor, false, &clock::now_rfc3339());
        let dir = self.working_dir(id);
        if session.working_path.parent() == Some(dir.as_path()) {
            remove_dir_best_effort(&dir);
        }
        self.events.changed(id);
        Ok(())
    }

    fn launch(&self, doc: &DocumentRecord, path: &Path) -> AppResult<()> {
        check_launchable(&doc.name)?;
        self.launcher.open(path).map_err(|err| {
            let hint = match doc.kind {
                DocumentKind::Word => "Pastikan Microsoft Word terpasang di laptop ini",
                DocumentKind::Excel => "Pastikan Microsoft Excel terpasang di laptop ini",
                DocumentKind::Pdf | DocumentKind::Other => {
                    "Pastikan ada aplikasi untuk membuka file jenis ini"
                }
            };
            AppError::OpenFailed(format!(
                "File {} tidak bisa dibuka. {hint}, lalu coba lagi. Detail: {err}",
                doc.name
            ))
        })
    }

    // -----------------------------------------------------------------------
    // Versions

    /// "Buka" (read-only): a read-only copy of the version (`None` = current)
    /// at `<data>/view/<version_id>/<name>`, reused if already there, opened
    /// with the default app.
    pub fn open_read_only(&self, document_id: &str, version_id: Option<&str>) -> AppResult<()> {
        let (doc, version) = self.core(|db, me| {
            let doc = store::get_document(db, document_id)?;
            self.check(db, me, &doc, DocAction::View)?;
            let version = version_of(db, document_id, version_id)?;
            Ok((doc, version))
        })?;
        check_launchable(&doc.name)?;
        let dir = self.data_dir.join(VIEW_DIR).join(&version.id);
        let path = dir.join(fit_file_name(&dir, &doc.name));
        if !path.is_file() {
            self.blobs.copy_to(&version.blob.hash, &path)?;
            set_read_only(&path)?;
        }
        self.launch(&doc, &path)
    }

    /// "Simpan salinan": writes the version (`None` = current) to the path
    /// chosen in the save dialog.
    pub fn export_version(
        &self,
        document_id: &str,
        version_id: Option<&str>,
        destination: &Path,
    ) -> AppResult<()> {
        if destination.as_os_str().is_empty() {
            return Err(AppError::InvalidInput(
                "Pilih lokasi untuk menyimpan salinan.".into(),
            ));
        }
        let version = self.core(|db, me| {
            let doc = store::get_document(db, document_id)?;
            self.check(db, me, &doc, DocAction::Export)?;
            version_of(db, document_id, version_id)
        })?;
        self.blobs.copy_to(&version.blob.hash, destination)
    }

    /// "Pulihkan": a new version with the content of `version_id`.
    pub fn restore_version(
        &self,
        document_id: &str,
        version_id: &str,
    ) -> AppResult<DocumentSummary> {
        self.new_version(document_id, DocAction::Restore, |db, me| {
            store::restore_version(db, document_id, version_id, me, &clock::now_rfc3339())
        })
    }

    /// "Pakai versi ini": ends a conflict with the content of `keep_version_id`.
    pub fn resolve_conflict(
        &self,
        document_id: &str,
        keep_version_id: &str,
    ) -> AppResult<DocumentSummary> {
        self.new_version(document_id, DocAction::Resolve, |db, me| {
            store::resolve_conflict(db, document_id, keep_version_id, me, &clock::now_rfc3339())
        })
    }

    fn new_version(
        &self,
        document_id: &str,
        action: DocAction,
        make: impl FnOnce(&mut Connection, &str) -> AppResult<VersionRecord>,
    ) -> AppResult<DocumentSummary> {
        let doc_lock = self.doc_lock(document_id);
        let _guard = lock_mutex(&doc_lock);
        let (doc, version) = self.core(|db, me| {
            let doc = store::get_document(db, document_id)?;
            self.check(db, me, &doc, action)?;
            let version = make(db, me.public_key_hex())?;
            Ok((doc, version))
        })?;
        self.sync.version_added(&doc, &version);
        self.events.changed(document_id);
        self.summary(document_id)
    }
}

/// Base content and parents for a new edit session (see `start_edit`).
fn edit_base(heads: &[VersionRecord], from: Option<&str>) -> AppResult<(BlobHash, Vec<String>)> {
    match heads {
        [] => Err(AppError::NotFound(
            "Isi dokumen ini belum diterima dari rekan.".into(),
        )),
        [head] => match from {
            Some(from) if from != head.id => Err(AppError::InvalidInput(
                "Edit hanya bisa dimulai dari versi sekarang. Pulihkan dulu versi lama kalau ingin melanjutkannya."
                    .into(),
            )),
            _ => Ok((head.blob.hash.clone(), vec![head.id.clone()])),
        },
        _ => {
            let from = from.ok_or_else(|| {
                AppError::InvalidInput(
                    "Dokumen ini sedang bentrok. Pilih salah satu versi yang bentrok untuk digabung manual."
                        .into(),
                )
            })?;
            let base = heads.iter().find(|h| h.id == from).ok_or_else(|| {
                AppError::InvalidInput(
                    "Versi yang dipilih bukan salah satu versi yang bentrok.".into(),
                )
            })?;
            let parents = heads.iter().map(|h| h.id.clone()).collect();
            Ok((base.blob.hash.clone(), parents))
        }
    }
}

/// The version `version_id` of the document, or the current one for `None`.
fn version_of(
    conn: &Connection,
    document_id: &str,
    version_id: Option<&str>,
) -> AppResult<VersionRecord> {
    match version_id {
        None => store::current(conn, document_id),
        Some(id) => {
            let version = store::get_version(conn, id)?;
            if version.document_id != document_id {
                return Err(AppError::NotFound(
                    "Versi dokumen tidak ditemukan di laptop ini.".into(),
                ));
            }
            Ok(version)
        }
    }
}

/// The file name for messages and the library, or the whole path if it has none.
fn file_label(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

/// A path picked for "Tambah file" must be a readable regular file.
fn check_source(path: &Path) -> AppResult<()> {
    let name = file_label(path);
    match fs::metadata(path) {
        Ok(meta) if meta.is_file() => {}
        Ok(meta) if meta.is_dir() => {
            return Err(AppError::InvalidInput(format!(
                "{name} adalah folder, bukan file. Pilih file yang ingin ditambahkan."
            )));
        }
        Ok(_) => {
            return Err(AppError::InvalidInput(format!(
                "{name} bukan file biasa, jadi tidak bisa ditambahkan."
            )));
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Err(AppError::InvalidInput(format!(
                "File {name} tidak ditemukan. Mungkin sudah dipindah atau dihapus."
            )));
        }
        Err(e) => {
            return Err(AppError::InvalidInput(format!(
                "File {name} tidak bisa dibaca. Detail: {e}"
            )));
        }
    }
    store::sanitize_file_name(&name).map(|_| ())
}

/// Empties (or creates) a working folder. Fails when Office still holds a
/// file in it.
fn clear_dir(dir: &Path) -> AppResult<()> {
    match fs::remove_dir_all(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(AppError::Storage(format!(
                "Folder salinan kerja {} tidak bisa dikosongkan. Tutup file ini di Word atau Excel lalu coba lagi. Detail: {e}",
                dir.display()
            )));
        }
    }
    fs::create_dir_all(dir).map_err(|e| {
        AppError::Storage(format!(
            "Folder salinan kerja {} tidak bisa dibuat. Detail: {e}",
            dir.display()
        ))
    })
}

/// Removes a working folder. Office may hold its files for a moment after
/// closing, so access errors are retried briefly; a folder that still cannot
/// be removed is left for the next edit to clear.
fn remove_dir_best_effort(dir: &Path) {
    const TRIES: u32 = 5;
    for attempt in 1..=TRIES {
        match fs::remove_dir_all(dir) {
            Ok(()) => return,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return,
            Err(e) if attempt == TRIES => {
                eprintln!(
                    "Mira: folder salinan kerja {} belum bisa dihapus: {e}",
                    dir.display()
                );
            }
            Err(_) => std::thread::sleep(Duration::from_millis(100)),
        }
    }
}

/// Excel refuses paths longer than about 218 characters; working and view
/// copies stay below this.
const MAX_OPEN_PATH_CHARS: usize = 200;

/// `name` for a file in `dir`, with the part before the extension shortened
/// when `<dir>\<name>` would be longer than [`MAX_OPEN_PATH_CHARS`].
fn fit_file_name(dir: &Path, name: &str) -> String {
    let room = MAX_OPEN_PATH_CHARS.saturating_sub(dir.to_string_lossy().chars().count() + 1);
    if name.chars().count() <= room {
        return name.to_owned();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => name.split_at(i),
        _ => (name, ""),
    };
    let keep = room.saturating_sub(ext.chars().count()).max(1);
    let short: String = stem.chars().take(keep).collect();
    let short = short.trim_end_matches([' ', '.']);
    let short = if short.is_empty() { "file" } else { short };
    format!("{short}{ext}")
}

/// Extensions Windows would run instead of open. Mira never launches them,
/// even read-only, because a rekan could have added such a file.
const BLOCKED_EXTENSIONS: &[&str] = &[
    "exe", "bat", "cmd", "com", "lnk", "js", "jse", "vbs", "vbe", "vb", "wsf", "wsh", "ws", "ps1",
    "psm1", "hta", "msi", "msp", "scr", "pif", "reg", "cpl", "jar", "msc", "scf", "url",
    "application", "appref-ms", "gadget",
];

fn check_launchable(name: &str) -> AppResult<()> {
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if BLOCKED_EXTENSIONS.contains(&ext.as_str()) {
        return Err(AppError::InvalidInput(
            "File jenis ini tidak dibuka dari Mira demi keamanan. Pakai Simpan salinan.".into(),
        ));
    }
    Ok(())
}

fn set_read_only(path: &Path) -> AppResult<()> {
    let err = |e: io::Error| {
        AppError::Storage(format!(
            "File {} tidak bisa dijadikan hanya baca. Detail: {e}",
            path.display()
        ))
    };
    let mut perms = fs::metadata(path).map_err(err)?.permissions();
    perms.set_readonly(true);
    fs::set_permissions(path, perms).map_err(err)
}

#[cfg(test)]
mod tests;
