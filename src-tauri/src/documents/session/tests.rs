//! Integration tests for the edit flow: a real data folder, database, blob
//! store and `OfficeWatcher`, with a recording launcher instead of Office.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use super::*;
use crate::documents::access::RoleAccess;
use crate::documents::store::VersionOrigin;
use crate::documents::store::tests::{T1, T2};
use crate::documents::sync::{self, RemoteVersion};
use crate::identity::{self, MemoryKeyStore};
use crate::org;

#[derive(Default)]
struct RecordingLauncher {
    opened: Mutex<Vec<PathBuf>>,
    fail: AtomicBool,
}

impl Launcher for RecordingLauncher {
    fn open(&self, path: &Path) -> AppResult<()> {
        lock_mutex(&self.opened).push(path.to_path_buf());
        if self.fail.load(Ordering::SeqCst) {
            Err(AppError::OpenFailed("tidak ada aplikasi".into()))
        } else {
            Ok(())
        }
    }
}

#[derive(Default)]
struct RecordingEvents {
    ids: Mutex<Vec<String>>,
}

impl DocumentEvents for RecordingEvents {
    fn changed(&self, document_id: &str) {
        lock_mutex(&self.ids).push(document_id.to_owned());
    }
}

#[derive(Default)]
struct RecordingSync {
    calls: Mutex<Vec<String>>,
}

impl DocumentSync for RecordingSync {
    fn document_added(&self, doc: &DocumentRecord, first: &VersionRecord) {
        lock_mutex(&self.calls).push(format!("added {} {}", doc.name, first.seq));
    }
    fn version_added(&self, _doc: &DocumentRecord, version: &VersionRecord) {
        lock_mutex(&self.calls).push(format!("version {}", version.seq));
    }
    fn editing_changed(&self, _document_id: &str, _editor: &str, editing: bool, _at: &str) {
        lock_mutex(&self.calls).push(format!("editing {editing}"));
    }
}

struct Harness {
    tmp: tempfile::TempDir,
    env: Arc<DocsEnv>,
    launcher: Arc<RecordingLauncher>,
    events: Arc<RecordingEvents>,
    sync: Arc<RecordingSync>,
}

impl Harness {
    fn new() -> Self {
        Self::with_settle(Duration::from_millis(300))
    }

    fn with_settle(settle: Duration) -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let state = MiraState::new(
            Ok(tmp.path().to_path_buf()),
            Box::new(MemoryKeyStore::new()),
        );
        state
            .with_core(|core| {
                let Core { db, identity } = core;
                identity::save_display_name(db, identity, "Sari")?;
                org::create_organization(db, identity, "CV Maju Jaya")?;
                Ok(())
            })
            .unwrap();
        let launcher = Arc::new(RecordingLauncher::default());
        let events = Arc::new(RecordingEvents::default());
        let sync = Arc::new(RecordingSync::default());
        let env = DocsEnv::new(
            state,
            DocsDeps {
                access: Arc::new(RoleAccess),
                sync: sync.clone(),
                launcher: launcher.clone(),
                events: events.clone(),
                settle,
            },
        )
        .unwrap();
        Harness {
            tmp,
            env,
            launcher,
            events,
            sync,
        }
    }

    /// A file outside the data folder, as picked in "Tambah file".
    fn file(&self, name: &str, content: &str) -> PathBuf {
        let dir = self.tmp.path().join("pilihan");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, content).unwrap();
        path
    }

    fn add(&self, name: &str, content: &str) -> DocumentSummary {
        let mut added = self
            .env
            .add_documents(&[self.file(name, content)], None)
            .unwrap();
        assert_eq!(added.len(), 1);
        added.remove(0)
    }

    fn session(&self, id: &str) -> Option<EditSession> {
        self.env.core(|db, _| store::edit_session(db, id)).unwrap()
    }

    fn versions(&self, id: &str) -> Vec<VersionRecord> {
        self.env.core(|db, _| store::versions(db, id)).unwrap()
    }

    fn heads(&self, id: &str) -> Vec<VersionRecord> {
        self.env.core(|db, _| store::heads(db, id)).unwrap()
    }

    fn content(&self, v: &VersionRecord) -> String {
        String::from_utf8(self.env.blobs.read_all(&v.blob.hash).unwrap()).unwrap()
    }

    fn working(&self, id: &str) -> PathBuf {
        self.session(id).expect("edit session").working_path
    }

    fn opened(&self) -> Vec<PathBuf> {
        lock_mutex(&self.launcher.opened).clone()
    }

    fn event_count(&self, id: &str) -> usize {
        lock_mutex(&self.events.ids)
            .iter()
            .filter(|x| *x == id)
            .count()
    }

    fn sync_calls(&self) -> Vec<String> {
        lock_mutex(&self.sync.calls).clone()
    }
}

fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Excel's save: write an 8-hex temp file, move the original away, move the
/// temp file to the target name, delete the original.
fn excel_save(working: &Path, content: &str) {
    let dir = working.parent().unwrap();
    let temp = dir.join("A1B2C3D4");
    fs::write(&temp, content).unwrap();
    let old = dir.join("5E6F7A8B.tmp");
    fs::rename(working, &old).unwrap();
    fs::rename(&temp, working).unwrap();
    fs::remove_file(&old).unwrap();
}

fn lock_file(working: &Path) -> PathBuf {
    let name = working.file_name().unwrap().to_string_lossy();
    working.with_file_name(format!("~${name}"))
}

#[test]
fn edit_save_and_close_in_excel_makes_one_version_and_ends_the_session() {
    let h = Harness::new();
    let doc = h.add("Anggaran.xlsx", "versi satu");
    let v1 = h.versions(&doc.id).remove(0);

    let summary = h.env.start_edit(&doc.id, None).unwrap();
    let working = h.env.working_dir(&doc.id).join("Anggaran.xlsx");
    assert_eq!(h.working(&doc.id), working);
    assert_eq!(h.opened(), vec![working.clone()]);
    assert_eq!(fs::read_to_string(&working).unwrap(), "versi satu");
    assert_eq!(summary.editing.len(), 1);
    assert!(summary.editing[0].local);
    assert!(summary.editing[0].editor.is_me);
    assert!(h.env.watcher.is_watching(&doc.id));
    let events_before = h.event_count(&doc.id);

    excel_save(&working, "versi dua");
    wait_until("version 2", || h.versions(&doc.id).len() == 2);
    // One save sequence is one version, even after the watcher settles again.
    std::thread::sleep(Duration::from_millis(1000));
    let versions = h.versions(&doc.id);
    assert_eq!(versions.len(), 2);
    assert_eq!(versions[0].seq, 2);
    assert_eq!(versions[0].origin, VersionOrigin::Edited);
    assert_eq!(versions[0].parent_ids, vec![v1.id.clone()]);
    assert_eq!(h.content(&versions[0]), "versi dua");
    assert!(h.event_count(&doc.id) > events_before);
    assert!(h.session(&doc.id).unwrap().last_saved_at.is_some());

    // Excel opens the file (lock appears), then closes it (lock goes away).
    let lock = lock_file(&working);
    fs::write(&lock, "kunci").unwrap();
    wait_until("lock seen", || h.session(&doc.id).unwrap().lock_seen);
    fs::remove_file(&lock).unwrap();
    wait_until("session ended", || h.session(&doc.id).is_none());
    wait_until("working folder removed", || {
        !h.env.working_dir(&doc.id).exists()
    });
    assert!(!h.env.watcher.is_watching(&doc.id));
    assert_eq!(h.versions(&doc.id).len(), 2);
    assert!(h.env.summary(&doc.id).unwrap().editing.is_empty());
    assert_eq!(
        h.sync_calls(),
        vec![
            "added Anggaran.xlsx 1",
            "editing true",
            "version 2",
            "editing false"
        ]
    );
}

#[test]
fn start_edit_again_reopens_the_same_working_copy() {
    let h = Harness::new();
    let doc = h.add("Laporan.docx", "isi");
    h.env.start_edit(&doc.id, None).unwrap();
    let working = h.working(&doc.id);
    fs::write(&working, "belum disimpan ke versi").unwrap();

    let again = h.env.start_edit(&doc.id, None).unwrap();
    assert_eq!(h.opened(), vec![working.clone(), working.clone()]);
    assert_eq!(again.editing.len(), 1);
    assert_eq!(h.env.core(|db, _| store::edit_sessions(db)).unwrap().len(), 1);
    // The working copy was not replaced.
    assert_eq!(
        fs::read_to_string(&working).unwrap(),
        "belum disimpan ke versi"
    );
    assert!(h.env.watcher.is_watching(&doc.id));

    // Deleted by hand: "Buka lagi" brings back the last saved content.
    fs::remove_file(&working).unwrap();
    h.env.start_edit(&doc.id, None).unwrap();
    assert_eq!(fs::read_to_string(&working).unwrap(), "isi");
    h.env.finish_edit(&doc.id).unwrap();
}

#[test]
fn finish_edit_is_refused_while_open_and_records_the_last_save() {
    // Long settle: the watcher stays out of the way, so `finish_edit` itself
    // must record the save.
    let h = Harness::with_settle(Duration::from_secs(3));
    let doc = h.add("Anggaran.xlsx", "satu");
    h.env.start_edit(&doc.id, None).unwrap();
    let working = h.working(&doc.id);

    let lock = lock_file(&working);
    fs::write(&lock, "kunci").unwrap();
    let err = h.env.finish_edit(&doc.id).unwrap_err();
    assert_eq!(err.code(), "document_editing");
    assert_eq!(
        err.to_string(),
        "File masih terbuka di Word/Excel. Simpan dan tutup dulu, lalu tekan Selesai mengedit lagi."
    );
    assert!(h.session(&doc.id).is_some());

    fs::write(&working, "dua").unwrap();
    fs::remove_file(&lock).unwrap();
    let summary = h.env.finish_edit(&doc.id).unwrap();
    assert!(summary.editing.is_empty());
    assert_eq!(summary.current.number, 2);
    assert_eq!(summary.version_count, 2);
    assert_eq!(h.content(&h.versions(&doc.id)[0]), "dua");
    assert!(h.session(&doc.id).is_none());
    assert!(!h.env.working_dir(&doc.id).exists());
    assert!(!h.env.watcher.is_watching(&doc.id));

    // Finishing again is harmless.
    assert_eq!(h.env.finish_edit(&doc.id).unwrap().version_count, 2);
}

#[test]
fn saving_identical_content_makes_no_version() {
    let h = Harness::new();
    let doc = h.add("Anggaran.xlsx", "sama");
    h.env.start_edit(&doc.id, None).unwrap();
    let working = h.working(&doc.id);

    excel_save(&working, "sama");
    h.env.on_file_settled(&doc.id);
    std::thread::sleep(Duration::from_millis(1200));
    assert_eq!(h.versions(&doc.id).len(), 1);
    assert_eq!(h.session(&doc.id).unwrap().last_saved_at, None);
    h.env.finish_edit(&doc.id).unwrap();
    assert_eq!(h.versions(&doc.id).len(), 1);
}

#[test]
fn restore_makes_a_new_version_and_is_refused_while_editing() {
    let h = Harness::new();
    let doc = h.add("Anggaran.xlsx", "asli");
    let v1 = h.versions(&doc.id).remove(0);
    h.env.start_edit(&doc.id, None).unwrap();
    fs::write(h.working(&doc.id), "diubah").unwrap();
    h.env.on_file_settled(&doc.id);
    assert_eq!(h.versions(&doc.id).len(), 2);

    let err = h.env.restore_version(&doc.id, &v1.id).unwrap_err();
    assert_eq!(err.code(), "document_editing");

    h.env.finish_edit(&doc.id).unwrap();
    let restored = h.env.restore_version(&doc.id, &v1.id).unwrap();
    assert_eq!(restored.current.number, 3);
    assert_eq!(restored.current.origin, VersionOrigin::Restored);
    assert_eq!(restored.current.restored_from_number, Some(1));
    assert_eq!(restored.current.blob_hash, v1.blob.hash.as_str());
    assert!(h.sync_calls().contains(&"version 3".to_owned()));

    let again = h
        .env
        .restore_version(&doc.id, &restored.current.id)
        .unwrap_err();
    assert_eq!(again.code(), "invalid_input");
}

#[test]
fn conflict_from_a_rekan_and_manual_merge() {
    let h = Harness::new();
    let doc = h.add("Anggaran.xlsx", "awal");
    let v1 = h.versions(&doc.id).remove(0);
    h.env.start_edit(&doc.id, None).unwrap();

    // A rekan's version arrives during the edit.
    let remote_blob = h.env.blobs.put_bytes(b"dari rekan").unwrap();
    let remote = RemoteVersion {
        id: store::new_id(),
        document_id: doc.id.clone(),
        parent_ids: vec![v1.id.clone()],
        blob_hash: remote_blob.hash.as_str().to_owned(),
        size: remote_blob.size,
        author: "ab".repeat(32),
        created_at: T1.into(),
        origin: VersionOrigin::Edited,
        restored_from: None,
    };
    h.env
        .core(|db, _| sync::apply_remote_version(db, &remote, T2))
        .unwrap();

    // The local save branches from v1 too: two heads.
    fs::write(h.working(&doc.id), "dari saya").unwrap();
    h.env.on_file_settled(&doc.id);
    assert_eq!(h.heads(&doc.id).len(), 2);
    let summary = h.env.summary(&doc.id).unwrap();
    assert!(summary.conflict);
    assert_eq!(summary.conflict_versions.len(), 2);
    h.env.finish_edit(&doc.id).unwrap();

    let err = h.env.start_edit(&doc.id, None).unwrap_err();
    assert_eq!(err.code(), "invalid_input");
    assert!(err.to_string().contains("bentrok"), "{err}");
    let err = h.env.start_edit(&doc.id, Some(&v1.id)).unwrap_err();
    assert_eq!(err.code(), "invalid_input");
    assert!(h.session(&doc.id).is_none());

    // Manual merge from the rekan's head.
    h.env.start_edit(&doc.id, Some(&remote.id)).unwrap();
    let mut heads: Vec<String> = h.heads(&doc.id).into_iter().map(|v| v.id).collect();
    heads.sort();
    let mut parents = h.session(&doc.id).unwrap().parent_ids;
    parents.sort();
    assert_eq!(parents, heads);
    assert_eq!(fs::read_to_string(h.working(&doc.id)).unwrap(), "dari rekan");

    fs::write(h.working(&doc.id), "gabungan").unwrap();
    h.env.on_file_settled(&doc.id);
    let after = h.heads(&doc.id);
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].origin, VersionOrigin::Resolved);
    assert_eq!(after[0].parent_ids, heads);
    assert_eq!(h.content(&after[0]), "gabungan");
    assert!(!h.env.finish_edit(&doc.id).unwrap().conflict);
}

/// A session row and working copy as left by a Mira that closed mid-edit.
fn leftover_session(h: &Harness, doc: &DocumentSummary, content: &str) -> PathBuf {
    let v1 = h.versions(&doc.id).remove(0);
    let dir = h.env.working_dir(&doc.id);
    fs::create_dir_all(&dir).unwrap();
    let working = dir.join(&doc.name);
    fs::write(&working, content).unwrap();
    let session = EditSession {
        document_id: doc.id.clone(),
        editor: doc.created_by.public_key.clone(),
        parent_ids: vec![v1.id.clone()],
        working_path: working.clone(),
        started_at: T1.into(),
        last_hash: v1.blob.hash.clone(),
        last_saved_at: None,
        lock_seen: false,
    };
    h.env
        .core(|db, _| store::insert_edit_session(db, &session))
        .unwrap();
    working
}

#[test]
fn recovery_saves_changes_and_ends_or_resumes_sessions() {
    let h = Harness::new();
    let closed = h.add("Tutup.xlsx", "lama");
    leftover_session(&h, &closed, "diubah saat Mira tertutup");
    let open = h.add("Masih Buka.xlsx", "lama");
    let open_working = leftover_session(&h, &open, "lama");
    let lock = lock_file(&open_working);
    fs::write(&lock, "kunci").unwrap();
    let gone = h.add("Hilang.xlsx", "lama");
    let gone_working = leftover_session(&h, &gone, "lama");
    fs::remove_file(&gone_working).unwrap();

    h.env.recover_sessions().unwrap();

    // Closed while Mira was down: the change is a version, the session ends.
    let versions = h.versions(&closed.id);
    assert_eq!(versions.len(), 2);
    assert_eq!(h.content(&versions[0]), "diubah saat Mira tertutup");
    assert!(h.session(&closed.id).is_none());
    assert!(!h.env.working_dir(&closed.id).exists());

    // Working copy gone: the session ends, nothing saved.
    assert!(h.session(&gone.id).is_none());
    assert_eq!(h.versions(&gone.id).len(), 1);

    // Still open in Office: watching resumes, and closing ends the session.
    let session = h.session(&open.id).unwrap();
    assert!(session.lock_seen);
    assert!(h.env.watcher.is_watching(&open.id));
    assert_eq!(h.versions(&open.id).len(), 1);
    fs::remove_file(&lock).unwrap();
    wait_until("resumed session ended", || h.session(&open.id).is_none());
}

#[test]
fn open_read_only_and_export_write_copies() {
    let h = Harness::new();
    let doc = h.add("Kontrak.pdf", "isi pdf");
    let v1 = h.versions(&doc.id).remove(0);

    h.env.open_read_only(&doc.id, None).unwrap();
    let view = h
        .tmp
        .path()
        .join(VIEW_DIR)
        .join(&v1.id)
        .join("Kontrak.pdf");
    assert_eq!(fs::read_to_string(&view).unwrap(), "isi pdf");
    assert!(fs::metadata(&view).unwrap().permissions().readonly());
    assert_eq!(h.opened(), vec![view.clone()]);
    // A second open reuses the copy.
    h.env.open_read_only(&doc.id, Some(&v1.id)).unwrap();
    assert_eq!(h.opened().len(), 2);

    let dest = h.tmp.path().join("salinan").join("Kontrak salinan.pdf");
    h.env.export_version(&doc.id, Some(&v1.id), &dest).unwrap();
    assert_eq!(fs::read_to_string(&dest).unwrap(), "isi pdf");
    assert!(!fs::metadata(&dest).unwrap().permissions().readonly());

    let other = h.add("Lain.pdf", "lain");
    let err = h
        .env
        .export_version(&other.id, Some(&v1.id), &dest)
        .unwrap_err();
    assert_eq!(err.code(), "not_found");
    let err = h
        .env
        .export_version(&doc.id, None, Path::new(""))
        .unwrap_err();
    assert_eq!(err.code(), "invalid_input");
}

#[test]
fn launch_failure_keeps_the_session_and_names_the_file() {
    let h = Harness::new();
    let doc = h.add("Anggaran.xlsx", "isi");
    h.launcher.fail.store(true, Ordering::SeqCst);
    let err = h.env.start_edit(&doc.id, None).unwrap_err();
    assert_eq!(err.code(), "open_failed");
    let msg = err.to_string();
    assert!(msg.contains("Anggaran.xlsx"), "{msg}");
    assert!(msg.contains("Microsoft Excel"), "{msg}");
    assert!(h.session(&doc.id).is_some());

    h.launcher.fail.store(false, Ordering::SeqCst);
    h.env.start_edit(&doc.id, None).unwrap();
    h.env.finish_edit(&doc.id).unwrap();
}

#[test]
fn start_edit_refuses_other_kinds_and_old_versions() {
    let h = Harness::new();
    let pdf = h.add("Kontrak.pdf", "pdf");
    assert_eq!(
        h.env.start_edit(&pdf.id, None).unwrap_err().code(),
        "invalid_input"
    );

    let doc = h.add("Anggaran.xlsx", "satu");
    let v1 = h.versions(&doc.id).remove(0);
    h.env.start_edit(&doc.id, Some(&v1.id)).unwrap();
    fs::write(h.working(&doc.id), "dua").unwrap();
    h.env.finish_edit(&doc.id).unwrap();
    let err = h.env.start_edit(&doc.id, Some(&v1.id)).unwrap_err();
    assert_eq!(err.code(), "invalid_input");
    assert!(err.to_string().contains("Pulihkan"), "{err}");
    assert_eq!(h.opened().len(), 1);
}

#[test]
fn executables_are_never_launched() {
    let h = Harness::new();
    let doc = h.add("setup.exe", "MZ");
    let err = h.env.open_read_only(&doc.id, None).unwrap_err();
    assert_eq!(err.code(), "invalid_input");
    assert!(err.to_string().contains("Simpan salinan"), "{err}");
    assert!(h.opened().is_empty());
    // Saving a copy still works.
    let dest = h.tmp.path().join("setup salinan.exe");
    h.env.export_version(&doc.id, None, &dest).unwrap();
    assert!(dest.is_file());
}

#[test]
fn long_names_are_shortened_for_office() {
    let h = Harness::new();
    let long = format!("{}.xlsx", "Laporan anggaran ".repeat(13).trim_end());
    assert!(long.chars().count() > 200);
    let doc = h.add(&long, "isi");
    h.env.start_edit(&doc.id, None).unwrap();
    let working = h.working(&doc.id);
    assert!(working.to_string_lossy().chars().count() <= MAX_OPEN_PATH_CHARS);
    assert!(working.to_string_lossy().ends_with(".xlsx"));
    assert_eq!(fs::read_to_string(&working).unwrap(), "isi");
    h.env.finish_edit(&doc.id).unwrap();

    let dir = Path::new(r"C:\data");
    assert_eq!(fit_file_name(dir, "a.docx"), "a.docx");
    let fitted = fit_file_name(dir, &"x".repeat(300));
    assert_eq!(fitted.chars().count(), MAX_OPEN_PATH_CHARS - 8);
}

#[test]
fn add_documents_checks_every_path_first_and_renames_duplicates() {
    let h = Harness::new();
    let good = h.file("Laporan.docx", "isi");
    let folder = h.tmp.path().join("Folder Arsip");
    fs::create_dir_all(&folder).unwrap();
    let missing = h.tmp.path().join("hilang.docx");

    let err = h
        .env
        .add_documents(&[good.clone(), folder], None)
        .unwrap_err();
    assert_eq!(err.code(), "invalid_input");
    assert!(err.to_string().contains("Folder Arsip"), "{err}");
    let err = h
        .env
        .add_documents(&[good.clone(), missing], None)
        .unwrap_err();
    assert_eq!(err.code(), "invalid_input");
    assert!(err.to_string().contains("hilang.docx"), "{err}");
    assert!(h.env.list(None).unwrap().is_empty());

    let added = h
        .env
        .add_documents(&[good.clone(), good.clone()], None)
        .unwrap();
    let names: Vec<&str> = added.iter().map(|d| d.name.as_str()).collect();
    assert_eq!(names, ["Laporan.docx", "Laporan (2).docx"]);
    assert_eq!(h.env.list(None).unwrap().len(), 2);
    assert_eq!(h.event_count(&added[1].id), 1);
}

#[test]
fn command_results_use_the_contract_field_names() {
    let h = Harness::new();
    let doc = h.add("Anggaran.xlsx", "isi");
    h.env.start_edit(&doc.id, None).unwrap();

    let json = serde_json::to_value(h.env.summary(&doc.id).unwrap()).unwrap();
    let mut keys: Vec<&str> = json.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "can",
            "conflict",
            "conflictVersions",
            "createdAt",
            "createdBy",
            "current",
            "editing",
            "id",
            "kind",
            "name",
            "projectId",
            "teamId",
            "versionCount",
        ]
    );
    assert_eq!(json["kind"], "excel");
    assert!(json["projectId"].is_null());
    assert_eq!(json["createdBy"]["displayName"], "Sari");
    assert_eq!(json["createdBy"]["isMe"], true);
    assert!(json["createdBy"]["publicKey"].is_string());
    let current = &json["current"];
    for key in [
        "id",
        "number",
        "size",
        "blobHash",
        "author",
        "createdAt",
        "origin",
        "restoredFromNumber",
        "parentIds",
        "isHead",
        "received",
        "available",
    ] {
        assert!(current.get(key).is_some(), "current.{key}");
    }
    assert_eq!(current["number"], 1);
    assert_eq!(current["origin"], "added");
    assert_eq!(current["available"], true);
    let editing = &json["editing"][0];
    assert_eq!(editing["local"], true);
    assert!(editing["since"].is_string());
    assert!(editing["lastSavedAt"].is_null());
    assert_eq!(editing["editor"]["isMe"], true);
    assert_eq!(
        json["can"],
        serde_json::json!({ "edit": true, "restore": true, "resolve": true, "export": true })
    );

    let detail = serde_json::to_value(h.env.detail(&doc.id).unwrap()).unwrap();
    assert_eq!(detail["id"], json["id"]);
    assert_eq!(detail["versions"].as_array().unwrap().len(), 1);
    assert_eq!(detail["versions"][0]["number"], 1);
    h.env.finish_edit(&doc.id).unwrap();
}
