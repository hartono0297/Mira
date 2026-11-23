//! Three (or more) laptops in one organization (`test_lab::Lab`), each with
//! its own `DocsPeerSync`, synced in memory with `network::feature::testing`.
//! Downloads go through a recording fetcher that copies from the other test
//! laptops with `testing::copy_blob`, so the `BlobSource` rules apply.

use std::sync::Mutex;

use super::*;
use crate::blobs::AUTO_REPLICATE_MAX_BYTES;
use crate::documents::access::RoleAccess;
use crate::documents::scope::InviteGuestProjects;
use crate::documents::store::{
    DocumentRecord, DocumentSummary, EditSession, VersionOrigin, VersionRecord,
};
use crate::documents::test_lab::{Lab, Laptop};
use crate::identity::{self, MemoryKeyStore};
use crate::network::feature::testing::{copy_blob, pull, sync_all};

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Default)]
struct Events(Mutex<Vec<String>>);

impl DocumentEvents for Events {
    fn changed(&self, document_id: &str) {
        lock(&self.0).push(document_id.to_owned());
    }
}

/// Records every request and copies from the laptops in `sources` (the
/// "connected rekan"), `prefer` first. Background jobs wait in `queue` until
/// `run_all`.
#[derive(Default)]
struct TestFetcher {
    me: String,
    sources: Mutex<Vec<(String, Weak<DocsPeerSync>)>>,
    requests: Mutex<Vec<(String, u64)>>,
    queue: Mutex<Vec<Job>>,
}

impl BlobFetcher for TestFetcher {
    fn fetch(&self, hash: &str, max_size: u64, prefer: Vec<String>, dest: &Path) -> BlobFuture {
        lock(&self.requests).push((hash.to_owned(), max_size));
        let mut sources = lock(&self.sources).clone();
        sources.sort_by_key(|(pk, _)| !prefer.contains(pk));
        let mut result = Err("tidak ada rekan yang punya file ini".to_owned());
        for (_, source) in sources {
            let Some(source) = source.upgrade() else {
                continue;
            };
            if let Ok(n) = copy_blob(source.as_ref(), &self.me, hash, max_size, dest) {
                result = Ok(n);
                break;
            }
        }
        Box::pin(async move { result })
    }

    fn spawn(&self, job: Job) {
        lock(&self.queue).push(job);
    }
}

impl TestFetcher {
    fn requested(&self) -> Vec<String> {
        lock(&self.requests)
            .iter()
            .map(|(h, _)| h.clone())
            .collect()
    }

    fn queued(&self) -> usize {
        lock(&self.queue).len()
    }

    fn run_all(&self) {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        loop {
            let jobs: Vec<Job> = std::mem::take(&mut *lock(&self.queue));
            if jobs.is_empty() {
                return;
            }
            for job in jobs {
                rt.block_on(job);
            }
        }
    }
}

struct Node {
    sync: Arc<DocsPeerSync>,
    fetcher: Arc<TestFetcher>,
    events: Arc<Events>,
}

struct World {
    lab: Lab,
    nodes: Vec<Node>,
}

fn now_s() -> String {
    clock::now_rfc3339()
}

fn general() -> DocScope {
    DocScope::default()
}

impl World {
    fn new(names: &[&str]) -> World {
        let mut w = World {
            lab: Lab::new(names),
            nodes: Vec::new(),
        };
        w.attach_new();
        w
    }

    fn attach_new(&mut self) {
        for i in self.nodes.len()..self.lab.laptops.len() {
            let laptop = &self.lab.laptops[i];
            let fetcher = Arc::new(TestFetcher {
                me: laptop.pk.clone(),
                ..TestFetcher::default()
            });
            let events = Arc::new(Events::default());
            let sync = DocsPeerSync::new(
                laptop.state.clone(),
                PeerSyncDeps {
                    guests: Arc::new(InviteGuestProjects),
                    hub: Arc::new(FeatureHub::default()),
                    fetcher: fetcher.clone(),
                    events: events.clone(),
                },
            )
            .unwrap();
            self.nodes.push(Node {
                sync,
                fetcher,
                events,
            });
        }
        for (i, node) in self.nodes.iter().enumerate() {
            let others = (0..self.nodes.len())
                .filter(|j| *j != i)
                .collect::<Vec<_>>();
            self.connect(i, &others, node);
        }
    }

    fn connect(&self, _i: usize, others: &[usize], node: &Node) {
        *lock(&node.fetcher.sources) = others
            .iter()
            .map(|j| (self.pk(*j), Arc::downgrade(&self.nodes[*j].sync)))
            .collect();
    }

    /// Only `others` serve files to laptop `i`.
    fn connect_only(&self, i: usize, others: &[usize]) {
        self.connect(i, others, &self.nodes[i]);
    }

    fn guest(&mut self, name: &str, projects: &[&str]) -> usize {
        let i = self.lab.add_guest(name, projects);
        self.attach_new();
        i
    }

    fn outsider(&mut self, name: &str) -> usize {
        let i = self.lab.add_member_elsewhere(name);
        self.attach_new();
        i
    }

    fn pk(&self, i: usize) -> String {
        self.lab.pk(i)
    }

    fn laptop(&self, i: usize) -> &Laptop {
        &self.lab.laptops[i]
    }

    fn sync(&self, i: usize) -> &DocsPeerSync {
        &self.nodes[i].sync
    }

    fn sync_among(&self, which: &[usize]) {
        let pks: Vec<String> = which.iter().map(|i| self.pk(*i)).collect();
        let laptops: Vec<(&str, &dyn FeatureSync)> = which
            .iter()
            .zip(&pks)
            .map(|(i, pk)| (pk.as_str(), self.sync(*i) as &dyn FeatureSync))
            .collect();
        sync_all(&laptops).unwrap();
    }

    fn sync_everyone(&self) {
        let all: Vec<usize> = (0..self.nodes.len()).collect();
        self.sync_among(&all);
    }

    fn pull(&self, from: usize, to: usize) -> FeatureIngest {
        let (from_pk, to_pk) = (self.pk(from), self.pk(to));
        pull(
            (&from_pk, self.sync(from) as &dyn FeatureSync),
            (&to_pk, self.sync(to) as &dyn FeatureSync),
        )
        .unwrap()
        .0
    }

    fn add_doc(
        &self,
        i: usize,
        scope: &DocScope,
        name: &str,
        content: &[u8],
    ) -> (DocumentRecord, VersionRecord) {
        let laptop = self.laptop(i);
        let blob = laptop.blobs().put_bytes(content).unwrap();
        let pk = laptop.pk.clone();
        let (doc, v) = laptop
            .with(|c| store::create_document(&mut c.db, scope, name, &blob, &pk, &now_s()))
            .unwrap();
        self.sync(i).document_added(&doc, &v);
        (doc, v)
    }

    /// A version on laptop `i` based on its current heads.
    fn add_version(&self, i: usize, doc: &DocumentRecord, content: &[u8]) -> VersionRecord {
        let laptop = self.laptop(i);
        let blob = laptop.blobs().put_bytes(content).unwrap();
        let pk = laptop.pk.clone();
        let v = laptop
            .with(|c| {
                let parents: Vec<String> = store::heads(&c.db, &doc.id)?
                    .into_iter()
                    .map(|h| h.id)
                    .collect();
                store::add_version(
                    &mut c.db,
                    &doc.id,
                    &parents,
                    &blob,
                    &pk,
                    VersionOrigin::Edited,
                    None,
                    &now_s(),
                )
            })
            .unwrap();
        self.sync(i).version_added(doc, &v);
        v
    }

    fn has_doc(&self, i: usize, doc: &str) -> bool {
        self.laptop(i)
            .with(|c| store::document_exists(&c.db, doc))
            .unwrap()
    }

    fn heads(&self, i: usize, doc: &str) -> Vec<String> {
        let mut ids: Vec<String> = self
            .laptop(i)
            .with(|c| store::heads(&c.db, doc))
            .unwrap()
            .into_iter()
            .map(|v| v.id)
            .collect();
        ids.sort();
        ids
    }

    fn version_ids(&self, i: usize, doc: &str) -> Vec<String> {
        let mut ids: Vec<String> = self
            .laptop(i)
            .with(|c| store::versions(&c.db, doc))
            .unwrap()
            .into_iter()
            .map(|v| v.id)
            .collect();
        ids.sort();
        ids
    }

    fn summary_at(&self, i: usize, doc: &str, now: &str) -> DocumentSummary {
        let laptop = self.laptop(i);
        let blobs = laptop.blobs();
        laptop
            .with(|c| store::summary(&c.db, &blobs, &c.identity, &RoleAccess, doc, now))
            .unwrap()
    }

    fn summary(&self, i: usize, doc: &str) -> DocumentSummary {
        self.summary_at(i, doc, &now_s())
    }

    fn has_blob(&self, i: usize, hash: &BlobHash) -> bool {
        self.laptop(i).blobs().contains(hash)
    }

    fn rejections(&self, i: usize) -> Vec<String> {
        self.laptop(i)
            .with(|c| {
                let mut stmt =
                    c.db.prepare("SELECT code FROM rejected_changes ORDER BY id")?;
                let codes = stmt
                    .query_map([], |r| r.get(0))?
                    .collect::<Result<Vec<String>, _>>()?;
                Ok::<_, AppError>(codes)
            })
            .unwrap()
    }

    fn record_count(&self, i: usize, kind: &str) -> i64 {
        self.laptop(i)
            .with(|c| {
                c.db.query_row(
                    "SELECT count(*) FROM docs_sync_records WHERE kind = ?1",
                    params![kind],
                    |r| r.get(0),
                )
            })
            .unwrap()
    }

    /// Records laptop `from` would send to laptop `to` (all it offers).
    fn records(&self, from: usize, to: usize) -> Vec<FeatureRecord> {
        let to_pk = self.pk(to);
        let ids = self.sync(from).record_ids_for(&to_pk).unwrap();
        self.sync(from).records_for(&to_pk, &ids).unwrap()
    }

    fn ingest(&self, to: usize, from: usize, records: Vec<FeatureRecord>) -> FeatureIngest {
        self.sync(to).ingest(&self.pk(from), records).unwrap()
    }
}

fn kind_of(r: &FeatureRecord) -> &'static str {
    envelope::open::<DocPayload>(DOCS_DOMAIN, r)
        .unwrap()
        .payload
        .kind()
}

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

#[test]
fn payload_json_has_the_planned_shape() {
    let mark = DocPayload::Edit(EditMark {
        document_id: "ab".repeat(16),
        editor: "cd".repeat(32),
        editing: true,
        since: "2026-11-22T08:00:00Z".into(),
        at: "2026-11-22T08:04:00Z".into(),
    });
    let json = serde_json::to_value(&mark).unwrap();
    assert_eq!(json["t"], "edit");
    assert_eq!(json["documentId"], "ab".repeat(16));
    assert_eq!(json["editing"], true);
    let back: DocPayload = serde_json::from_value(json).unwrap();
    assert_eq!(back, mark);
    assert!(serde_json::from_str::<DocPayload>(r#"{"t":"lain"}"#).is_err());
}

#[test]
fn new_document_and_versions_reach_every_rekan() {
    let w = World::new(&["Sari", "Budi", "Citra"]);
    let (doc, v1) = w.add_doc(0, &general(), "Laporan.docx", b"versi satu");
    assert_eq!(w.record_count(0, "doc"), 1);
    assert_eq!(w.record_count(0, "ver"), 1);

    w.sync_everyone();
    for i in [1, 2] {
        assert!(w.has_doc(i, &doc.id), "laptop {i}");
        assert_eq!(w.version_ids(i, &doc.id), vec![v1.id.clone()]);
        let s = w.summary(i, &doc.id);
        assert!(s.current.received);
        assert!(s.current.auto_download);
        assert!(!s.current.available, "file not copied yet");
        assert!(s.current.downloading, "download queued");
        assert_eq!(s.created_by.display_name, "Sari");
        assert_eq!(w.nodes[i].fetcher.queued(), 1);
    }

    // Small files are fetched right away (here when the jobs run).
    for i in [1, 2] {
        w.nodes[i].fetcher.run_all();
        assert!(w.has_blob(i, &v1.blob.hash), "laptop {i}");
        assert_eq!(
            lock(&w.nodes[i].fetcher.requests).clone(),
            vec![(v1.blob.hash.as_str().to_owned(), v1.blob.size)]
        );
        let s = w.summary(i, &doc.id);
        assert!(s.current.available && !s.current.downloading);
        assert!(lock(&w.nodes[i].events.0).contains(&doc.id));
    }

    // A version from a rekan (Budi) reaches Sari and Citra.
    let v2 = w.add_version(1, &doc, b"versi dua dari Budi");
    w.sync_everyone();
    for i in 0..3 {
        assert_eq!(w.heads(i, &doc.id), vec![v2.id.clone()], "laptop {i}");
        assert_eq!(w.version_ids(i, &doc.id).len(), 2);
        let s = w.summary(i, &doc.id);
        assert_eq!(s.current.author.display_name, "Budi");
        assert!(!s.conflict);
    }
    w.nodes[0].fetcher.run_all();
    assert!(w.has_blob(0, &v2.blob.hash));
    assert!(w.rejections(0).is_empty() && w.rejections(2).is_empty());

    // Idempotent: nothing new on another round.
    assert_eq!(w.pull(0, 2).accepted, 0);
}

#[test]
fn offline_versions_on_the_same_parent_become_a_conflict_everywhere() {
    let w = World::new(&["Sari", "Budi", "Citra"]);
    let (doc, _) = w.add_doc(0, &general(), "Anggaran.xlsx", b"satu");
    w.sync_everyone();

    // Sari and Budi both save while offline, on the same version.
    let va = w.add_version(0, &doc, b"versi Sari");
    let vb = w.add_version(1, &doc, b"versi Budi");
    w.sync_everyone();

    let mut both = vec![va.id.clone(), vb.id.clone()];
    both.sort();
    for i in 0..3 {
        assert_eq!(w.heads(i, &doc.id), both, "laptop {i}");
        let s = w.summary(i, &doc.id);
        assert!(s.conflict, "laptop {i}");
        assert_eq!(s.conflict_versions.len(), 2);
        assert_eq!(w.version_ids(i, &doc.id).len(), 3);
    }
}

#[test]
fn large_files_are_not_fetched_automatically_but_on_demand() {
    let w = World::new(&["Sari", "Budi", "Citra"]);
    let (small, vs) = w.add_doc(0, &general(), "kecil.pdf", b"isi kecil");
    let big_bytes = vec![7u8; (AUTO_REPLICATE_MAX_BYTES + 1) as usize];
    let (big, vb) = w.add_doc(0, &general(), "besar.pdf", &big_bytes);
    drop(big_bytes);
    w.sync_everyone();

    // The fetcher records a request when its job runs; until `run_all` the
    // small file's download waits in the queue (and shows as downloading).
    let hs = vs.blob.hash.as_str().to_owned();
    let hb = vb.blob.hash.as_str().to_owned();
    for i in [1, 2] {
        assert_eq!(
            w.nodes[i].fetcher.queued(),
            1,
            "only the small file, laptop {i}"
        );
        assert!(w.summary(i, &small.id).current.downloading, "laptop {i}");
        let s = w.summary(i, &big.id);
        assert!(!s.current.auto_download && !s.current.available && !s.current.downloading);
        w.nodes[i].fetcher.run_all();
        assert!(w.nodes[i].fetcher.requested().contains(&hs), "laptop {i}");
        assert!(!w.nodes[i].fetcher.requested().contains(&hb), "laptop {i}");
    }
    assert!(w.has_blob(1, &vs.blob.hash));
    assert!(!w.has_blob(1, &vb.blob.hash));
    assert!(w.summary(1, &small.id).current.available);

    // The small file can be copied the way the transport does it.
    let dest = w.laptop(2).data_dir().join("salinan.part");
    let n = copy_blob(
        w.sync(0),
        &w.pk(2),
        vs.blob.hash.as_str(),
        vs.blob.size,
        &dest,
    )
    .unwrap();
    assert_eq!(n, vs.blob.size);

    // Rekan reconnecting does not start the large file either.
    w.sync(1).peer_connected(&w.pk(0));
    assert_eq!(w.nodes[1].fetcher.queued(), 0);
    assert!(!w.nodes[1].fetcher.requested().contains(&hb));

    // "Unduh" copies it, asking for exactly its size.
    let peer = Arc::clone(&w.nodes[1].sync);
    rt().block_on(peer.download_version(big.id.clone(), vb.id.clone()))
        .unwrap();
    assert!(w.has_blob(1, &vb.blob.hash));
    assert!(lock(&w.nodes[1].fetcher.requests).contains(&(hb.clone(), vb.blob.size)));
    let s = w.summary(1, &big.id);
    assert!(s.current.available && !s.current.downloading);
    assert!(lock(&w.nodes[1].events.0).contains(&big.id));
    assert!(
        std::fs::read_dir(w.laptop(1).data_dir().join(INCOMING_DIR))
            .unwrap()
            .next()
            .is_none(),
        "temporary file removed"
    );

    // Already here: nothing to do.
    let peer = Arc::clone(&w.nodes[1].sync);
    rt().block_on(peer.download_version(big.id.clone(), vb.id.clone()))
        .unwrap();

    // No connected rekan has it: not_available.
    w.connect_only(2, &[]);
    let peer = Arc::clone(&w.nodes[2].sync);
    let err = rt()
        .block_on(peer.download_version(big.id.clone(), vb.id.clone()))
        .unwrap_err();
    assert_eq!(err.code(), "not_available");
    assert!(!err.to_string().is_empty());
    assert!(!w.has_blob(2, &vb.blob.hash));
    assert!(!w.summary(2, &big.id).current.downloading);

    // Unknown version or a version of another document.
    let peer = Arc::clone(&w.nodes[2].sync);
    let err = rt()
        .block_on(peer.download_version(small.id.clone(), vb.id.clone()))
        .unwrap_err();
    assert_eq!(err.code(), "not_found");
}

#[test]
fn guests_receive_only_their_projects_and_cannot_write() {
    let project = "ab".repeat(16);
    let other = "cd".repeat(16);
    let mut w = World::new(&["Sari", "Budi", "Citra"]);
    let g = w.guest("Tamu", &[&project]);
    let team = DocScope {
        team_id: Some(w.lab.team.clone()),
        project_id: None,
    };
    let in_project = DocScope {
        team_id: Some(w.lab.team.clone()),
        project_id: Some(project.clone()),
    };
    let in_other = DocScope {
        team_id: Some(w.lab.team.clone()),
        project_id: Some(other),
    };
    let (umum, _) = w.add_doc(0, &general(), "umum.docx", b"umum");
    let (tim, _) = w.add_doc(0, &team, "tim.docx", b"tim");
    let (proj, pv) = w.add_doc(1, &in_project, "proyek.docx", b"proyek");
    let (lain, _) = w.add_doc(0, &in_other, "lain.docx", b"lain");
    w.sync_everyone();

    assert!(!w.has_doc(g, &umum.id), "no general library for guests");
    assert!(!w.has_doc(g, &tim.id));
    assert!(!w.has_doc(g, &lain.id));
    assert!(w.has_doc(g, &proj.id));
    for i in 0..3 {
        for d in [&umum, &tim, &proj, &lain] {
            assert!(w.has_doc(i, &d.id), "member {i} has {}", d.name);
        }
    }
    let s = w.summary(g, &proj.id);
    assert!(!s.can.edit && !s.can.restore && s.can.export);

    // A version made on the guest's laptop is refused by everyone.
    let gv = w.add_version(g, &proj, b"versi tamu");
    w.sync_everyone();
    for i in 0..3 {
        assert!(!w.version_ids(i, &proj.id).contains(&gv.id), "laptop {i}");
        assert!(w.rejections(i).contains(&"docs_forbidden".to_owned()));
    }
    assert_eq!(w.heads(0, &proj.id), vec![pv.id.clone()]);

    // The guest may download the project file, not the others.
    let gpk = w.pk(g);
    assert!(
        w.sync(1)
            .blob_path_for(&gpk, pv.blob.hash.as_str())
            .is_some()
    );
    let tim_hash = BlobHash::of_bytes(b"tim");
    assert!(w.sync(0).blob_path_for(&gpk, tim_hash.as_str()).is_none());
}

#[test]
fn members_of_another_team_and_relays_respect_team_scope() {
    let mut w = World::new(&["Sari", "Budi", "Citra"]);
    let d = w.outsider("Dewi");
    let team = DocScope {
        team_id: Some(w.lab.team.clone()),
        project_id: None,
    };
    let (tim, tv) = w.add_doc(0, &team, "tim.docx", b"rahasia tim");
    let (umum, _) = w.add_doc(0, &general(), "umum.docx", b"umum");

    // Relay A -> B -> C works; B never hands the team document to Dewi.
    assert!(w.pull(0, 1).accepted >= 4);
    assert!(
        w.pull(1, 2).accepted >= 4,
        "Citra gets Sari's records from Budi"
    );
    assert!(w.has_doc(2, &tim.id) && w.has_doc(2, &umum.id));
    w.pull(1, d);
    assert!(!w.has_doc(d, &tim.id));
    assert!(w.has_doc(d, &umum.id));
    let to_dewi = w.records(1, d);
    assert!(to_dewi.iter().all(|r| {
        let o = envelope::open::<DocPayload>(DOCS_DOMAIN, r).unwrap();
        o.payload.document_id() == umum.id
    }));
    // Filtered again when asked by id.
    let all_ids = w.sync(1).record_ids_for(&w.pk(2)).unwrap();
    assert!(
        w.sync(1)
            .records_for(&w.pk(d), &all_ids)
            .unwrap()
            .iter()
            .all(|r| !r.body.contains(&tim.id))
    );

    // Files through the relay: Citra copies from Budi only.
    w.nodes[1].fetcher.run_all();
    assert!(w.has_blob(1, &tv.blob.hash));
    w.connect_only(2, &[1]);
    w.nodes[2].fetcher.run_all();
    assert!(w.has_blob(2, &tv.blob.hash));

    w.sync_everyone();
    assert!(!w.has_doc(d, &tim.id));
    // Dewi cannot write in the team either.
    let forged = w
        .laptop(d)
        .with(|c| {
            envelope::seal(
                &c.identity,
                DOCS_DOMAIN,
                &DocPayload::Ver(RemoteVersion {
                    id: store::new_id(),
                    document_id: tim.id.clone(),
                    parent_ids: vec![tv.id.clone()],
                    blob_hash: BlobHash::of_bytes(b"x").as_str().into(),
                    size: 1,
                    author: c.identity.public_key_hex().into(),
                    created_at: now_s(),
                    origin: VersionOrigin::Edited,
                    restored_from: None,
                }),
            )
        })
        .unwrap();
    let got = w.ingest(0, d, vec![forged]);
    assert_eq!((got.accepted, got.rejected), (0, 1));
    assert_eq!(w.rejections(0).last().unwrap(), "docs_forbidden");
}

#[test]
fn removed_members_neither_receive_nor_are_accepted() {
    let mut w = World::new(&["Sari", "Budi", "Citra"]);
    let (doc, _) = w.add_doc(0, &general(), "a.docx", b"a");
    w.sync_everyone();
    assert!(w.has_doc(2, &doc.id));

    w.lab.remove(2);
    let (after, _) = w.add_doc(0, &general(), "b.docx", b"b");
    let cv = w.add_version(2, &doc, b"versi Citra setelah keluar");
    w.sync_everyone();

    assert!(!w.has_doc(2, &after.id), "removed laptop gets nothing new");
    assert!(w.records(0, 2).is_empty());
    for i in [0, 1] {
        assert!(!w.version_ids(i, &doc.id).contains(&cv.id));
        assert!(w.rejections(i).contains(&"docs_not_member".to_owned()));
    }
    // Their files are not served to them either.
    let hb = BlobHash::of_bytes(b"b");
    assert!(w.sync(0).blob_path_for(&w.pk(2), hb.as_str()).is_none());
    assert!(w.sync(0).blob_path_for(&w.pk(1), hb.as_str()).is_some());
}

#[test]
fn forged_tampered_and_misattributed_records_are_rejected() {
    let w = World::new(&["Sari", "Budi", "Citra"]);
    let (doc, v1) = w.add_doc(0, &general(), "a.docx", b"a");
    let records = w.records(0, 1);
    assert_eq!(records.len(), 2);

    // Changed content with a recomputed id: the signature no longer fits.
    let ver = records.iter().find(|r| kind_of(r) == "ver").unwrap();
    let tampered = FeatureRecord::new(ver.body.replace(&v1.id, &store::new_id()));
    assert_ne!(tampered.body, ver.body);
    let got = w.ingest(1, 0, vec![tampered]);
    assert_eq!((got.accepted, got.rejected), (0, 1));
    assert_eq!(w.rejections(1), vec!["docs_bad_signature".to_owned()]);

    // Citra signs a version that claims to be Sari's.
    let claimed = w
        .laptop(2)
        .with(|c| {
            envelope::seal(
                &c.identity,
                DOCS_DOMAIN,
                &DocPayload::Ver(RemoteVersion {
                    author: w.pk(0),
                    ..RemoteVersion::from_record(&v1)
                }),
            )
        })
        .unwrap();
    let got = w.ingest(1, 2, vec![claimed]);
    assert_eq!(got.rejected, 1);
    assert_eq!(w.rejections(1).last().unwrap(), "docs_wrong_author");

    // A key that is not in the organization.
    let tmp = tempfile::tempdir().unwrap();
    let conn = crate::db::open(tmp.path()).unwrap();
    let stranger = identity::ensure_identity(&conn, &MemoryKeyStore::new()).unwrap();
    let doc_payload = DocPayload::Doc(RemoteDocument {
        id: store::new_id(),
        created_by: stranger.public_key_hex().into(),
        ..RemoteDocument::from_record(&doc)
    });
    let foreign = envelope::seal(&stranger, DOCS_DOMAIN, &doc_payload).unwrap();
    let got = w.ingest(1, 2, vec![foreign]);
    assert_eq!(got.rejected, 1);
    assert_eq!(w.rejections(1).last().unwrap(), "docs_not_member");

    // A record of another family (signing domain) is not a document record.
    let other_domain = w
        .laptop(0)
        .with(|c| {
            envelope::seal(
                &c.identity,
                envelope::SIGN_DOMAIN,
                &DocPayload::Doc(RemoteDocument::from_record(&doc)),
            )
        })
        .unwrap();
    assert_eq!(w.ingest(1, 0, vec![other_domain]).rejected, 1);

    // Nothing refused was stored, so nothing is forwarded.
    assert!(!w.has_doc(1, &doc.id));
    assert!(w.records(1, 2).is_empty());

    // The genuine records still apply.
    let got = w.ingest(1, 0, records);
    assert_eq!((got.accepted, got.rejected), (2, 0));
    assert!(w.has_doc(1, &doc.id));
}

#[test]
fn a_version_before_its_document_waits_then_applies() {
    let w = World::new(&["Sari", "Budi", "Citra"]);
    let (doc, v1) = w.add_doc(0, &general(), "a.docx", b"a");
    let v2 = w.add_version(0, &doc, b"b");
    let records = w.records(0, 1);
    let (docs, vers): (Vec<_>, Vec<_>) = records.into_iter().partition(|r| kind_of(r) == "doc");
    assert_eq!((docs.len(), vers.len()), (1, 2));

    let got = w.ingest(1, 0, vers.clone());
    assert_eq!((got.accepted, got.rejected), (2, 0));
    assert!(!got.changed);
    assert!(!w.has_doc(1, &doc.id));
    assert_eq!(
        w.nodes[1].fetcher.queued(),
        0,
        "nothing fetched while pending"
    );
    // Pending records are known (not asked again) but not forwarded.
    assert!(
        w.sync(1)
            .unknown_ids(&[vers[0].id.clone()])
            .unwrap()
            .is_empty()
    );
    assert!(w.records(1, 2).is_empty());

    let got = w.ingest(1, 0, docs);
    assert_eq!(got.accepted, 1);
    assert!(got.changed);
    let mut both = vec![v1.id.clone(), v2.id.clone()];
    both.sort();
    assert_eq!(w.version_ids(1, &doc.id), both);
    assert_eq!(w.heads(1, &doc.id), vec![v2.id.clone()]);
    assert_eq!(w.records(1, 2).len(), 3);
    assert_eq!(w.nodes[1].fetcher.queued(), 2);

    // The same records again change nothing.
    let again = w.records(0, 1);
    assert_eq!(w.ingest(1, 0, again).accepted, 0);
}

#[test]
fn editing_marks_travel_refresh_and_expire() {
    let w = World::new(&["Sari", "Budi", "Citra"]);
    let (doc, v1) = w.add_doc(0, &general(), "a.docx", b"a");
    w.sync_everyone();
    let now = clock::now();
    let fmt = clock::format_rfc3339;

    // An old mark (11 minutes) is neither offered nor shown.
    let old = fmt(now - time::Duration::minutes(11));
    w.sync(0).editing_changed(&doc.id, &w.pk(0), true, &old);
    assert_eq!(w.record_count(0, "edit"), 1);
    assert!(!w.records(0, 1).iter().any(|r| kind_of(r) == "edit"));
    w.sync_everyone();
    assert!(w.summary(1, &doc.id).editing.is_empty());

    // A fresh mark reaches Budi and, relayed, Citra.
    let start = fmt(now - time::Duration::minutes(1));
    w.sync(0).editing_changed(&doc.id, &w.pk(0), true, &start);
    assert_eq!(w.record_count(0, "edit"), 1, "only the latest mark is kept");
    assert_eq!(w.pull(0, 1).accepted, 1);
    assert_eq!(w.pull(1, 2).accepted, 1);
    for i in [1, 2] {
        let s = w.summary(i, &doc.id);
        assert_eq!(s.editing.len(), 1, "laptop {i}");
        assert!(!s.editing[0].local);
        assert_eq!(s.editing[0].editor.display_name, "Sari");
        assert_eq!(s.editing[0].since, start);
        // Expires 10 minutes after the mark was made, not after it arrived.
        let later = fmt(now + time::Duration::minutes(10));
        assert!(w.summary_at(i, &doc.id, &later).editing.is_empty());
    }

    // While Sari edits, the mark is repeated every 4 minutes.
    let laptop = w.laptop(0);
    let session = EditSession {
        document_id: doc.id.clone(),
        editor: w.pk(0),
        parent_ids: vec![v1.id.clone()],
        working_path: laptop
            .data_dir()
            .join("working")
            .join(&doc.id)
            .join("a.docx"),
        started_at: start.clone(),
        last_hash: v1.blob.hash.clone(),
        last_saved_at: None,
        lock_seen: false,
    };
    laptop
        .with(|c| store::insert_edit_session(&c.db, &session))
        .unwrap();
    assert_eq!(w.sync(0).refresh_editing_at(now).unwrap(), 0, "still fresh");
    let in_5 = now + time::Duration::minutes(5);
    assert_eq!(w.sync(0).refresh_editing_at(in_5).unwrap(), 1);
    assert_eq!(w.sync(0).refresh_editing_at(in_5).unwrap(), 0);
    assert_eq!(w.record_count(0, "edit"), 1);
    // The refreshed mark is newer than Budi's and replaces it. Its time is
    // capped at the arrival, so it keeps the mark alive past the 10 minutes
    // of the first one (made a minute before `now`).
    let refreshed = w.records(0, 1);
    let got = w.ingest(1, 0, refreshed);
    assert_eq!(got.accepted, 1);
    let at_9_30 = fmt(now + time::Duration::seconds(570));
    assert_eq!(w.summary_at(1, &doc.id, &at_9_30).editing.len(), 1);
    assert!(w.summary_at(2, &doc.id, &at_9_30).editing.is_empty());
    assert_eq!(w.record_count(1, "edit"), 1);

    // Finishing clears the mark on the rekan.
    laptop
        .with(|c| store::delete_edit_session(&c.db, &doc.id))
        .unwrap();
    w.sync(0).editing_changed(
        &doc.id,
        &w.pk(0),
        false,
        &fmt(in_5 + time::Duration::seconds(1)),
    );
    w.sync_everyone();
    assert!(w.summary_at(1, &doc.id, &fmt(in_5)).editing.is_empty());
    assert!(w.summary_at(2, &doc.id, &fmt(in_5)).editing.is_empty());

    // An older mark arriving late does not bring it back.
    let stale_again = w
        .laptop(0)
        .with(|c| {
            envelope::seal(
                &c.identity,
                DOCS_DOMAIN,
                &DocPayload::Edit(EditMark {
                    document_id: doc.id.clone(),
                    editor: c.identity.public_key_hex().into(),
                    editing: true,
                    since: start.clone(),
                    at: fmt(now),
                }),
            )
        })
        .unwrap();
    let got = w.ingest(2, 0, vec![stale_again]);
    assert_eq!((got.accepted, got.rejected), (0, 0));
    assert!(w.summary_at(2, &doc.id, &fmt(in_5)).editing.is_empty());
}

#[test]
fn blob_source_serves_only_what_the_peer_may_see() {
    let project = "ab".repeat(16);
    let mut w = World::new(&["Sari", "Budi", "Citra"]);
    let d = w.outsider("Dewi");
    let g = w.guest("Tamu", &[&project]);
    let team = DocScope {
        team_id: Some(w.lab.team.clone()),
        project_id: None,
    };
    let (_, tv) = w.add_doc(0, &team, "tim.docx", b"tim");
    let (_, uv) = w.add_doc(0, &general(), "umum.docx", b"umum");
    let src = w.sync(0);
    let th = tv.blob.hash.as_str();
    assert!(src.blob_path_for(&w.pk(1), th).is_some());
    assert!(src.blob_path_for(&w.pk(d), th).is_none());
    assert!(src.blob_path_for(&w.pk(g), th).is_none());
    assert!(src.blob_path_for(&w.pk(d), uv.blob.hash.as_str()).is_some());
    assert!(src.blob_path_for(&w.pk(g), uv.blob.hash.as_str()).is_none());
    assert!(src.blob_path_for(&w.pk(1), &"0".repeat(64)).is_none());
    assert!(src.blob_path_for(&w.pk(1), "bukan-hash").is_none());
    let dest = w.laptop(d).data_dir().join("x.part");
    assert!(copy_blob(src, &w.pk(d), th, 100, &dest).is_err());
}

#[test]
fn documents_made_before_sync_are_backfilled_once() {
    let w = World::new(&["Sari", "Budi"]);
    // Made directly in the store, without the outbound hook.
    let laptop = w.laptop(0);
    let blob = laptop.blobs().put_bytes(b"lama").unwrap();
    let pk = w.pk(0);
    let (doc, v1) = laptop
        .with(|c| store::create_document(&mut c.db, &general(), "lama.docx", &blob, &pk, &now_s()))
        .unwrap();
    let v2 = laptop
        .with(|c| {
            store::add_version(
                &mut c.db,
                &doc.id,
                std::slice::from_ref(&v1.id),
                &blob,
                &pk,
                VersionOrigin::Edited,
                None,
                &now_s(),
            )
        })
        .unwrap();
    assert_eq!(w.record_count(0, "doc"), 0);
    w.sync_everyone();
    assert_eq!(w.record_count(0, "doc"), 1);
    assert_eq!(w.record_count(0, "ver"), 2);
    assert_eq!(w.heads(1, &doc.id), vec![v2.id.clone()]);
    // The hook made later for the same version adds nothing new.
    w.sync(0).version_added(&doc, &v2);
    assert_eq!(w.record_count(0, "ver"), 2);
    assert_eq!(w.sync(0).backfill().unwrap(), 0);
}
