//! Tes sinkron tanda tangan antar laptop: `documents::test_lab::Lab` (satu
//! organisasi, beberapa laptop) dengan `network::feature::testing`.
//! File versi dibuat dengan `increment::testing`, jadi tes ini berlaku untuk
//! bukti stempel sementara maupun yang asli.

use std::sync::{Arc, Mutex};

use data_encoding::BASE64;
use rusqlite::params;
use rusqlite::types::Value;
use time::OffsetDateTime;

use super::increment::{self, testing as pdf};
use super::outbox::LocalOnlyOutbox;
use super::peer_sync::{
    self, CancelledPayload, Downloading, FileFetcher, MAX_PENDING_PER_AUTHOR,
    MAX_REJECTED_PER_SIGNER, Payload, RequestPayload, SignSync, SignedPayload, TURN_TITLE,
    WireEvent, WireSigner, code, request_id_for,
};
use super::pin::KdfParams;
use super::repo::{self, RequestScope};
use super::request::{RequestStatus, SignMode};
use super::seal::{self, EventKind, EventRecord};
use super::service::{RequestDetail, SignContext, seal_chain_valid};
use super::session::SignSessions;
use super::store::DocumentStore;
use crate::blobs::AUTO_REPLICATE_MAX_BYTES;
use crate::board::reminder::Notifier;
use crate::clock;
use crate::documents::envelope::{self, SIGN_DOMAIN};
use crate::documents::scope::InviteGuestProjects;
use crate::documents::test_lab::{Lab, Laptop};
use crate::error::AppResult;
use crate::network::feature::{BlobSource, FeatureRecord, FeatureSync, testing};

const PIN: &str = "123456";

fn t(secs: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp(1_795_000_000 + secs).unwrap()
}

fn at(secs: i64) -> String {
    clock::format_rfc3339(t(secs))
}

#[derive(Default)]
struct RecFetcher {
    wants: Mutex<Vec<(String, u64)>>,
}

impl FileFetcher for RecFetcher {
    fn want(&self, hash: &str, max_size: u64, _prefer: &[String]) {
        self.wants.lock().unwrap().push((hash.to_owned(), max_size));
    }
}

impl RecFetcher {
    fn take(&self) -> Vec<(String, u64)> {
        std::mem::take(&mut *self.wants.lock().unwrap())
    }
    fn wanted(&self, hash: &str) -> bool {
        self.wants.lock().unwrap().iter().any(|(h, _)| h == hash)
    }
}

#[derive(Default)]
struct RecNotifier {
    shown: Mutex<Vec<(String, String)>>,
}

impl Notifier for RecNotifier {
    fn notify(&self, title: &str, body: &str) -> Result<(), String> {
        self.shown
            .lock()
            .unwrap()
            .push((title.to_owned(), body.to_owned()));
        Ok(())
    }
}

impl RecNotifier {
    fn shown(&self) -> Vec<(String, String)> {
        self.shown.lock().unwrap().clone()
    }
}

struct Node {
    sync: Arc<SignSync>,
    fetcher: Arc<RecFetcher>,
    notifier: Arc<RecNotifier>,
    sessions: SignSessions,
}

fn node(l: &Laptop) -> Node {
    let fetcher = Arc::new(RecFetcher::default());
    let notifier = Arc::new(RecNotifier::default());
    let store = super::store::BlobDocumentStore::in_data_dir(l.data_dir()).unwrap();
    let sync = Arc::new(SignSync::new(
        l.state.clone(),
        store,
        Arc::new(InviteGuestProjects),
        fetcher.clone(),
        notifier.clone(),
    ));
    Node {
        sync,
        fetcher,
        notifier,
        sessions: SignSessions::default(),
    }
}

struct World {
    lab: Lab,
    nodes: Vec<Node>,
}

/// Baris yang dibandingkan antar laptop.
#[derive(Debug, PartialEq, Eq)]
struct Snapshot {
    request: Vec<String>,
    signers: Vec<Vec<String>>,
    events: Vec<Vec<String>>,
    records: Vec<Vec<String>>,
}

fn rows(conn: &rusqlite::Connection, sql: &str, id: &str) -> Vec<Vec<String>> {
    let mut stmt = conn.prepare(sql).unwrap();
    let n = stmt.column_count();
    stmt.query_map(params![id], |r| {
        (0..n)
            .map(|i| r.get::<_, Value>(i).map(|v| format!("{v:?}")))
            .collect::<rusqlite::Result<Vec<_>>>()
    })
    .unwrap()
    .collect::<rusqlite::Result<Vec<_>>>()
    .unwrap()
}

impl World {
    fn new(names: &[&str]) -> World {
        let mut w = World {
            lab: Lab::new(names),
            nodes: Vec::new(),
        };
        w.attach();
        w
    }

    fn attach(&mut self) {
        while self.nodes.len() < self.lab.laptops.len() {
            let n = node(&self.lab.laptops[self.nodes.len()]);
            self.nodes.push(n);
        }
    }

    fn add_guest(&mut self, name: &str, projects: &[&str]) -> usize {
        let i = self.lab.add_guest(name, projects);
        self.attach();
        i
    }

    fn add_member_elsewhere(&mut self, name: &str) -> usize {
        let i = self.lab.add_member_elsewhere(name);
        self.attach();
        i
    }

    fn pk(&self, i: usize) -> String {
        self.lab.pk(i)
    }

    fn ctx<T>(
        &self,
        i: usize,
        f: impl FnOnce(&mut SignContext<'_>) -> AppResult<T>,
    ) -> AppResult<T> {
        let node = &self.nodes[i];
        let store = node.sync.store().clone();
        let export = self.lab.laptops[i].data_dir().join("ekspor");
        self.lab.laptops[i].state.with_core(|core| {
            let mut ctx = SignContext {
                conn: &mut core.db,
                identity: &core.identity,
                store: &store,
                sessions: &node.sessions,
                outbox: &LocalOnlyOutbox,
                guests: &InviteGuestProjects,
                export_dir: &export,
                kdf: KdfParams::TEST,
            };
            f(&mut ctx)
        })
    }

    fn save_signature(&self, i: usize) {
        let png = BASE64.encode(&tiny_png());
        self.ctx(i, |c| c.save_signature(PIN, &png, t(0))).unwrap();
    }

    fn create(
        &self,
        i: usize,
        original: &[u8],
        mode: &str,
        signers: &[usize],
        scope: &RequestScope,
    ) -> AppResult<RequestDetail> {
        let keys: Vec<String> = signers.iter().map(|&s| self.pk(s)).collect();
        self.ctx(i, |c| {
            let hash = c.import_pdf(original, "Kontrak Sewa.pdf")?.file_hash;
            c.create_request_scoped("Kontrak Sewa", &hash, mode, &keys, scope, t(5))
        })
    }

    fn detail(&self, i: usize, id: &str) -> RequestDetail {
        self.ctx(i, |c| c.get_request(id)).unwrap()
    }

    /// Laptop `i` menandatangani versi terkini dengan `make(versi, penanda)`
    /// pada waktu `secs`.
    fn sign(
        &self,
        i: usize,
        id: &str,
        make: impl FnOnce(&[u8], &str) -> Vec<u8>,
        secs: i64,
    ) -> AppResult<RequestDetail> {
        self.ctx(i, |c| {
            let d = c.get_request(id)?;
            let prev = c.read_file(id, &d.current_hash)?;
            let bytes = make(&prev, &seal::doc_tag(id));
            let token = c.unlock(PIN, t(secs))?.token;
            c.complete(id, &token, &d.current_hash, &bytes, t(secs))
        })
    }

    fn sync(&self, which: &[usize]) {
        let pks: Vec<String> = which.iter().map(|&i| self.pk(i)).collect();
        let feats: Vec<(&str, &dyn FeatureSync)> = which
            .iter()
            .zip(&pks)
            .map(|(&i, pk)| (pk.as_str(), &*self.nodes[i].sync as &dyn FeatureSync))
            .collect();
        testing::sync_all(&feats).unwrap();
    }

    /// Memenuhi permintaan file yang tercatat dari laptop lain di `which`
    /// (seperti `FeatureHub::fetch_blob`). Hasilnya jumlah file yang sampai.
    fn deliver(&self, which: &[usize]) -> usize {
        let mut delivered = 0;
        for &i in which {
            let mut seen = Vec::new();
            for (hash, max) in self.nodes[i].fetcher.take() {
                if seen.contains(&hash) {
                    continue;
                }
                seen.push(hash.clone());
                let me = self.pk(i);
                let dest = self.lab.laptops[i].data_dir().join(format!("dl-{hash}"));
                for &j in which.iter().filter(|&&j| j != i) {
                    if testing::copy_blob(&*self.nodes[j].sync, &me, &hash, max, &dest).is_ok() {
                        self.nodes[i].sync.add_downloaded(&dest, &hash).unwrap();
                        delivered += 1;
                        break;
                    }
                }
            }
        }
        delivered
    }

    /// Sinkron record dan file sampai tidak ada yang baru.
    fn converge(&self, which: &[usize]) {
        for _ in 0..12 {
            self.sync(which);
            for &i in which {
                for &j in which.iter().filter(|&&j| j != i) {
                    self.nodes[i].sync.peer_connected(&self.pk(j));
                }
            }
            if self.deliver(which) == 0 {
                return;
            }
        }
        panic!("tidak konvergen");
    }

    fn snapshot(&self, i: usize, id: &str) -> Snapshot {
        self.lab.laptops[i].with(|c| Snapshot {
            request: rows(
                &c.db,
                "SELECT id, title, requested_by, mode, status, original_hash, current_hash,
                        created_at, updated_at, completed_at, team_id, project_id
                 FROM sign_requests WHERE id = ?1",
                id,
            )
            .concat(),
            signers: rows(
                &c.db,
                "SELECT position, public_key, display_name, kind, status, signed_at, hash_after
                 FROM sign_signers WHERE request_id = ?1 ORDER BY position",
                id,
            ),
            events: {
                let mut e = rows(
                    &c.db,
                    "SELECT kind, actor, actor_name, at, hash_before, hash_after, detail, sig
                     FROM sign_events WHERE request_id = ?1
                       AND kind IN ('created', 'signed', 'completed', 'cancelled')",
                    id,
                );
                e.sort();
                e
            },
            records: rows(
                &c.db,
                "SELECT id, kind, author, state, reason FROM sign_sync_records
                 WHERE request_id = ?1 ORDER BY id",
                id,
            ),
        })
    }

    fn assert_identical(&self, which: &[usize], id: &str) {
        let first = self.snapshot(which[0], id);
        assert!(!first.request.is_empty());
        for &i in &which[1..] {
            assert_eq!(
                self.snapshot(i, id),
                first,
                "laptop {i} beda dengan {}",
                which[0]
            );
        }
    }

    fn chain_valid(&self, i: usize, id: &str) -> bool {
        self.lab.laptops[i].with(|c| {
            let req = repo::load_request(&c.db, id).unwrap().unwrap();
            seal_chain_valid(&req, &repo::events_for(&c.db, id).unwrap())
        })
    }

    fn record_count(&self, i: usize, id: &str) -> i64 {
        self.lab.laptops[i].with(|c| {
            c.db.query_row(
                "SELECT COUNT(*) FROM sign_sync_records WHERE request_id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap()
        })
    }

    fn all_records(&self, i: usize) -> i64 {
        self.lab.laptops[i].with(|c| {
            c.db.query_row("SELECT COUNT(*) FROM sign_sync_records", [], |r| r.get(0))
                .unwrap()
        })
    }

    // -- Record buatan tangan (pemalsuan dan record yang melewati cek lokal).

    fn event(
        &self,
        i: usize,
        id: &str,
        kind: EventKind,
        before: Option<&str>,
        after: Option<&str>,
        secs: i64,
    ) -> WireEvent {
        self.lab.laptops[i].with(|c| {
            let rec = EventRecord {
                request_id: Some(id.to_owned()),
                kind,
                actor: c.identity.public_key_hex().to_owned(),
                actor_name: self.lab.laptops[i].name.clone(),
                at: at(secs),
                hash_before: before.map(str::to_owned),
                hash_after: after.map(str::to_owned),
                detail: String::new(),
            };
            let sig = seal::sign_event(&c.identity, &rec).unwrap();
            WireEvent::new(&rec, &sig)
        })
    }

    fn seal_as(&self, i: usize, payload: &Payload) -> FeatureRecord {
        self.lab.laptops[i].with(|c| envelope::seal(&c.identity, SIGN_DOMAIN, payload).unwrap())
    }

    /// Record `signed` laptop `i` atas `before` dengan isi `bytes` (disimpan
    /// di laptop `i`), tanpa lewat pemeriksaan lokal.
    fn signed_payload(
        &self,
        i: usize,
        id: &str,
        before: &str,
        bytes: &[u8],
        completed: bool,
        secs: i64,
    ) -> Payload {
        let after = self.nodes[i].sync.store().put(bytes).unwrap();
        Payload::Signed(SignedPayload {
            request_id: id.to_owned(),
            hash_before: before.to_owned(),
            hash_after: after.clone(),
            size: bytes.len() as u64,
            signed: self.event(i, id, EventKind::Signed, Some(before), Some(&after), secs),
            completed: completed
                .then(|| self.event(i, id, EventKind::Completed, None, Some(&after), secs)),
        })
    }

    fn ingest(&self, to: usize, from: usize, rec: FeatureRecord) -> (usize, usize) {
        let got = self.nodes[to]
            .sync
            .ingest(&self.pk(from), vec![rec])
            .unwrap();
        (got.accepted, got.rejected)
    }

    fn read(&self, i: usize, hash: &str) -> Vec<u8> {
        self.nodes[i].sync.store().get(hash).unwrap().unwrap()
    }
}

fn tiny_png() -> Vec<u8> {
    let mut v = vec![0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];
    v.extend_from_slice(&13u32.to_be_bytes());
    v.extend_from_slice(b"IHDR");
    v.extend_from_slice(&300u32.to_be_bytes());
    v.extend_from_slice(&100u32.to_be_bytes());
    v.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
    v.extend_from_slice(&0u32.to_be_bytes());
    v.extend_from_slice(b"IEND");
    v.extend_from_slice(&[0xae, 0x42, 0x60, 0x82]);
    v
}

fn stamp(prev: &[u8], tag: &str) -> Vec<u8> {
    pdf::stamp(prev, tag)
}

fn no_scope() -> RequestScope {
    RequestScope::default()
}

const ALL3: [usize; 3] = [0, 1, 2];

#[test]
fn sequential_a_b_c_converges_everywhere() {
    let w = World::new(&["Sari", "Budi", "Citra"]);
    for i in ALL3 {
        w.save_signature(i);
    }
    let d = w
        .create(0, &pdf::sample_pdf(2), "sequential", &ALL3, &no_scope())
        .unwrap();
    let id = d.summary.id.clone();
    assert!(!d.summary.from_peer);

    // Sari (pengirim, penanda tangan pertama) menandatangani di laptopnya.
    w.sign(0, &id, stamp, 10).unwrap();
    w.converge(&ALL3);

    let b = w.detail(1, &id);
    assert_eq!(b.summary.my_state.as_str(), "your_turn");
    assert!(b.summary.from_peer);
    assert_eq!(b.summary.requested_by_name, "Sari");
    assert!(b.summary.file_available);
    assert!(!b.summary.pending);
    assert_eq!(b.summary.signed_count, 1);
    assert_eq!(b.summary.file_size, w.read(0, &b.current_hash).len() as u64);
    let v1 = b.current_hash.clone();

    // Citra belum giliran: ditolak di laptopnya sendiri.
    let c = w.detail(2, &id);
    assert_eq!(c.summary.my_state.as_str(), "waiting_others");
    assert_eq!(
        w.sign(2, &id, stamp, 20).unwrap_err().code(),
        "not_your_turn"
    );

    // Record Citra yang dipalsukan sebelum gilirannya: disimpan tetapi tidak
    // diterapkan.
    let early = stamp(&w.read(2, &v1), &seal::doc_tag(&id));
    let forged = w.seal_as(2, &w.signed_payload(2, &id, &v1, &early, false, 15));
    assert_eq!(w.ingest(1, 2, forged), (1, 0));
    let b = w.detail(1, &id);
    assert_eq!(b.current_hash, v1);
    assert_eq!(b.signers[2].status.as_str(), "waiting");
    assert_eq!(b.rejected.len(), 1);
    assert_eq!(b.rejected[0].signer_name, "Citra");
    assert_eq!(b.rejected[0].code, code::NOT_YOUR_TURN);
    assert_eq!(b.rejected[0].other_name, None);

    w.sign(1, &id, stamp, 30).unwrap();
    w.converge(&ALL3);
    let c = w.detail(2, &id);
    assert_eq!(c.summary.my_state.as_str(), "your_turn");
    assert!(c.is_last_pending);

    w.sign(2, &id, pdf::stamp_with_audit_page, 40).unwrap();
    w.converge(&ALL3);

    for i in ALL3 {
        let d = w.detail(i, &id);
        assert_eq!(d.summary.status, RequestStatus::Completed, "laptop {i}");
        assert_eq!(d.summary.signed_count, 3);
        assert_eq!(d.summary.my_state.as_str(), "signed");
        assert_eq!(d.seal_valid, Some(true), "laptop {i}");
        assert!(d.events.iter().all(|e| e.valid));
        assert_eq!(d.rejected.len(), 1, "palsuan tetap tercatat ditolak");
        assert!(w.chain_valid(i, &id));
        assert_eq!(w.record_count(i, &id), 5);
    }
    w.assert_identical(&ALL3, &id);
}

#[test]
fn parallel_concurrent_signatures_resolve_identically() {
    let w = World::new(&["Sari", "Budi", "Citra"]);
    w.save_signature(1);
    w.save_signature(2);
    let d = w
        .create(0, &pdf::sample_pdf(1), "parallel", &[1, 2], &no_scope())
        .unwrap();
    let id = d.summary.id.clone();
    w.converge(&ALL3);

    // Keduanya menandatangani versi asli tanpa tersambung. Citra lebih awal.
    let b_local = w
        .sign(1, &id, |p, tag| stamp(&stamp(p, tag), tag), 100)
        .unwrap();
    let c_local = w.sign(2, &id, stamp, 90).unwrap();
    assert_ne!(b_local.current_hash, c_local.current_hash);
    w.converge(&ALL3);

    for i in ALL3 {
        let d = w.detail(i, &id);
        assert_eq!(d.current_hash, c_local.current_hash, "laptop {i}");
        assert_eq!(d.summary.signed_count, 1);
        assert_eq!(d.signers[0].status.as_str(), "waiting");
        assert_eq!(d.signers[1].status.as_str(), "signed");
        assert_eq!(d.rejected.len(), 1);
        assert_eq!(d.rejected[0].signer_name, "Budi");
        assert_eq!(d.rejected[0].code, code::SKIPPED_CONCURRENT);
        assert_eq!(d.rejected[0].other_name.as_deref(), Some("Citra"));
        let j = serde_json::to_value(&d.rejected[0]).unwrap();
        let mut keys: Vec<&str> = j.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(keys, ["at", "code", "otherName", "reason", "signerName"]);
    }
    w.assert_identical(&ALL3, &id);
    assert_eq!(w.detail(1, &id).summary.my_state.as_str(), "your_turn");

    // Budi menandatangani ulang versi terbaru dan menutup permintaan.
    w.sign(1, &id, pdf::stamp_with_audit_page, 110).unwrap();
    w.converge(&ALL3);
    for i in ALL3 {
        let d = w.detail(i, &id);
        assert_eq!(d.summary.status, RequestStatus::Completed);
        assert_eq!(d.seal_valid, Some(true));
        assert_eq!(d.rejected.len(), 1);
    }
    w.assert_identical(&ALL3, &id);
}

#[test]
fn version_that_changes_content_is_rejected_everywhere() {
    let w = World::new(&["Sari", "Budi", "Citra"]);
    w.save_signature(1);
    let orig = pdf::sample_pdf(1);
    let d = w
        .create(0, &orig, "sequential", &[1, 2], &no_scope())
        .unwrap();
    let id = d.summary.id.clone();
    w.converge(&ALL3);

    // Laptop sendiri menolak.
    let e = w.sign(1, &id, pdf::tamper, 20).unwrap_err();
    assert!(
        ["version_not_prefix", "version_changes_content"].contains(&e.code()),
        "{e:?}"
    );

    // Record yang melewati cek lokal tetap ditolak di semua laptop.
    let tampered = pdf::tamper(&orig, &seal::doc_tag(&id));
    let expected = increment::check_increment(&orig, &tampered).unwrap_err();
    let rec = w.seal_as(
        1,
        &w.signed_payload(1, &id, &d.original_hash, &tampered, false, 20),
    );
    assert_eq!(w.ingest(1, 1, rec), (1, 0));
    w.converge(&ALL3);
    // Laptop Budi menolaknya dan tidak mengirim file versi yang ditolak, jadi
    // laptop lain menunggu dan tidak memakainya.
    let tampered_hash = seal::hash_hex(&tampered);
    for i in ALL3 {
        let d = w.detail(i, &id);
        assert_eq!(d.current_hash, d.original_hash, "laptop {i}");
        assert_eq!(d.summary.signed_count, 0);
        assert_eq!(d.rejected.len(), usize::from(i == 1), "laptop {i}");
        assert_eq!(d.summary.pending, i != 1, "laptop {i}");
        assert!(
            w.nodes[1]
                .sync
                .blob_path_for(&w.pk(i), &tampered_hash)
                .is_none()
        );
    }
    // File yang sampai lewat jalan lain ditolak dengan alasan yang sama.
    for i in [0, 2] {
        let path = w.lab.laptops[i].data_dir().join("rusak.part");
        std::fs::write(&path, &tampered).unwrap();
        w.nodes[i]
            .sync
            .add_downloaded(&path, &tampered_hash)
            .unwrap();
    }
    for i in ALL3 {
        let d = w.detail(i, &id);
        assert_eq!(d.current_hash, d.original_hash, "laptop {i}");
        assert_eq!(d.rejected.len(), 1);
        assert_eq!(d.rejected[0].reason, expected.message);
        assert_eq!(d.rejected[0].code, expected.code);
        assert!(!d.summary.pending);
    }
    w.assert_identical(&ALL3, &id);
    assert_eq!(w.detail(1, &id).summary.my_state.as_str(), "your_turn");

    // Citra menandatangani di atas versi yang ditolak itu.
    let on_top = stamp(&tampered, &seal::doc_tag(&id));
    let rec = w.seal_as(
        2,
        &w.signed_payload(2, &id, &tampered_hash, &on_top, true, 30),
    );
    assert_eq!(w.ingest(2, 2, rec), (1, 0));
    w.converge(&ALL3);
    for i in ALL3 {
        let d = w.detail(i, &id);
        assert_eq!(d.rejected.len(), 2, "laptop {i}");
        let citra = d
            .rejected
            .iter()
            .find(|r| r.signer_name == "Citra")
            .unwrap();
        assert_eq!(citra.code, code::ON_REJECTED);
    }
    w.assert_identical(&ALL3, &id);
}

#[test]
fn forged_audit_events_are_rejected() {
    let mut w = World::new(&["Sari", "Budi", "Citra"]);
    let dewi = w.add_member_elsewhere("Dewi");
    let d = w
        .create(0, &pdf::sample_pdf(1), "sequential", &[1, 2], &no_scope())
        .unwrap();
    let id = d.summary.id.clone();
    let orig = d.original_hash.clone();
    w.converge(&ALL3);
    let next = stamp(&pdf::sample_pdf(1), &seal::doc_tag(&id));

    // Tanda tangan catatan audit rusak.
    let Payload::Signed(mut p) = w.signed_payload(1, &id, &orig, &next, false, 20) else {
        unreachable!()
    };
    let mut sig = p.signed.sig.into_bytes();
    sig[0] = if sig[0] == b'0' { b'1' } else { b'0' };
    p.signed.sig = String::from_utf8(sig).unwrap();
    assert_eq!(w.ingest(0, 1, w.seal_as(1, &Payload::Signed(p))), (0, 1));

    // Tanda tangan sah, tetapi dari kunci yang bukan penanda tangan.
    let stranger = w.signed_payload(dewi, &id, &orig, &next, false, 20);
    assert_eq!(w.ingest(0, dewi, w.seal_as(dewi, &stranger)), (0, 1));

    // Catatan Budi di dalam amplop Citra (pelaku bukan penulis record).
    let budi = w.signed_payload(1, &id, &orig, &next, false, 20);
    assert_eq!(w.ingest(0, 2, w.seal_as(2, &budi)), (0, 1));

    // Pembatalan dari selain pengirim.
    let cancel = Payload::Cancelled(CancelledPayload {
        request_id: id.clone(),
        cancelled: w.event(1, &id, EventKind::Cancelled, Some(&orig), None, 25),
    });
    assert_eq!(w.ingest(0, 1, w.seal_as(1, &cancel)), (0, 1));

    // Record yang tidak cocok dengan isinya.
    let real = w.seal_as(1, &budi);
    let broken = FeatureRecord {
        id: real.id.clone(),
        body: real.body.replace("Budi", "Badu"),
    };
    assert_eq!(w.ingest(0, 1, broken), (0, 1));

    assert_eq!(w.record_count(0, &id), 1, "hanya record permintaan");
    let d = w.detail(0, &id);
    assert_eq!(d.current_hash, orig);
    assert_eq!(d.summary.signed_count, 0);
    let logged: i64 = w.lab.laptops[0].with(|c| {
        c.db.query_row(
            "SELECT COUNT(*) FROM rejected_changes WHERE code = 'sign_rejected'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    });
    assert_eq!(logged, 5);
}

#[test]
fn cancel_reaches_signers_and_is_ignored_after_completion() {
    let w = World::new(&["Sari", "Budi", "Citra"]);
    w.save_signature(1);
    w.save_signature(2);

    let d = w
        .create(0, &pdf::sample_pdf(1), "parallel", &[1, 2], &no_scope())
        .unwrap();
    let id = d.summary.id.clone();
    w.converge(&ALL3);
    w.ctx(0, |c| c.cancel(&id, t(40))).unwrap();
    w.converge(&ALL3);
    for i in ALL3 {
        let d = w.detail(i, &id);
        assert_eq!(d.summary.status, RequestStatus::Cancelled, "laptop {i}");
        assert!(d.events.iter().any(|e| e.kind == "cancelled" && e.valid));
    }
    assert_eq!(
        w.sign(1, &id, stamp, 50).unwrap_err().code(),
        "request_closed"
    );
    w.assert_identical(&ALL3, &id);

    // Budi menyelesaikan saat Sari membatalkan tanpa tersambung.
    let d = w
        .create(0, &pdf::sample_pdf(2), "sequential", &[1], &no_scope())
        .unwrap();
    let id = d.summary.id.clone();
    w.converge(&ALL3);
    w.sign(1, &id, pdf::stamp_with_audit_page, 50).unwrap();
    w.ctx(0, |c| c.cancel(&id, t(60))).unwrap();
    w.converge(&ALL3);
    for i in [0, 1] {
        let d = w.detail(i, &id);
        assert_eq!(d.summary.status, RequestStatus::Completed, "laptop {i}");
        assert_eq!(d.seal_valid, Some(true));
        assert!(d.events.iter().all(|e| e.kind != "cancelled"));
    }
    let state: String = w.lab.laptops[0].with(|c| {
        c.db.query_row(
            "SELECT state FROM sign_sync_records WHERE request_id = ?1 AND kind = 'cancelled'",
            params![id],
            |r| r.get(0),
        )
        .unwrap()
    });
    assert_eq!(state, "rejected");
    w.assert_identical(&[0, 1], &id);
    assert_eq!(w.record_count(2, &id), 0, "Citra tidak terlibat");
}

#[test]
fn guest_signs_only_in_allowed_project_and_never_requests() {
    let project = "ab".repeat(16);
    let other = "cd".repeat(16);
    let mut w = World::new(&["Sari", "Budi"]);
    let g = w.add_guest("Tamu", &[&project]);
    w.save_signature(1);
    w.save_signature(g);
    let team = Some(w.lab.team.clone());
    let scope = RequestScope {
        team_id: team.clone(),
        project_id: Some(project.clone()),
    };
    let wrong = RequestScope {
        team_id: team.clone(),
        project_id: Some(other.clone()),
    };

    let plain = w.ctx(0, |c| c.list_candidates()).unwrap();
    assert!(plain.iter().all(|c| c.public_key != w.pk(g)));
    let in_project = w
        .ctx(0, |c| {
            c.list_candidates_for(team.as_deref(), Some(&project))
        })
        .unwrap();
    assert!(in_project.iter().any(|c| c.public_key == w.pk(g)));
    let elsewhere = w
        .ctx(0, |c| c.list_candidates_for(team.as_deref(), Some(&other)))
        .unwrap();
    assert!(elsewhere.iter().all(|c| c.public_key != w.pk(g)));

    let sample = pdf::sample_pdf(1);
    let e = w
        .create(0, &sample, "sequential", &[1, g], &no_scope())
        .unwrap_err();
    assert_eq!(e.code(), "request_invalid");
    let e = w
        .create(0, &sample, "sequential", &[1, g], &wrong)
        .unwrap_err();
    assert_eq!(e.code(), "request_invalid");

    let d = w.create(0, &sample, "sequential", &[1, g], &scope).unwrap();
    let id = d.summary.id.clone();
    assert_eq!(d.scope.project_id.as_deref(), Some(project.as_str()));
    let all = [0, 1, g];
    w.converge(&all);
    let gd = w.detail(g, &id);
    assert_eq!(gd.signers[1].kind.as_str(), "guest");
    assert_eq!(gd.scope.project_id.as_deref(), Some(project.as_str()));
    w.sign(1, &id, stamp, 20).unwrap();
    w.converge(&all);
    w.sign(g, &id, pdf::stamp_with_audit_page, 30).unwrap();
    w.converge(&all);
    for i in all {
        let d = w.detail(i, &id);
        assert_eq!(d.summary.status, RequestStatus::Completed, "laptop {i}");
        assert_eq!(d.seal_valid, Some(true));
    }
    w.assert_identical(&all, &id);

    // Permintaan yang tidak melibatkan Tamu tidak sampai kepadanya.
    let only_budi = w.create(0, &sample, "parallel", &[1], &scope).unwrap();
    w.converge(&all);
    assert_eq!(w.record_count(g, &only_budi.summary.id), 0);
    assert_eq!(w.record_count(1, &only_budi.summary.id), 1);

    // Tamu tidak bisa meminta tanda tangan, di laptopnya sendiri...
    let budi = w.pk(1);
    let e = w
        .ctx(g, |c| {
            let hash = c.import_pdf(&sample, "a.pdf")?.file_hash;
            c.create_request_scoped("Dari Tamu", &hash, "parallel", &[budi], &scope, t(5))
        })
        .unwrap_err();
    assert_eq!(e.code(), "guest_cannot_request");

    // ...dan record permintaan buatan Tamu ditolak laptop lain.
    let hash = seal::hash_hex(&sample);
    let salt = peer_sync::new_salt();
    let rid = request_id_for(&w.pk(g), &salt);
    let created = w.event(g, &rid, EventKind::Created, None, Some(&hash), 5);
    let from_guest = Payload::Request(RequestPayload {
        id: rid.clone(),
        salt,
        title: "Dari Tamu".into(),
        mode: SignMode::Parallel,
        requested_by: w.pk(g),
        team_id: team.clone(),
        project_id: Some(project.clone()),
        original_hash: hash.clone(),
        original_size: sample.len() as u64,
        created_at: created.at.clone(),
        signers: vec![WireSigner {
            public_key: w.pk(1),
            display_name: "Budi".into(),
        }],
        created,
    });
    assert_eq!(w.ingest(1, g, w.seal_as(g, &from_guest)), (0, 1));

    // Record permintaan tanpa proyek yang memasukkan Tamu ditolak di mana pun.
    let salt = peer_sync::new_salt();
    let rid = request_id_for(&w.pk(0), &salt);
    let created = w.event(0, &rid, EventKind::Created, None, Some(&hash), 5);
    let no_project = Payload::Request(RequestPayload {
        id: rid,
        salt,
        title: "Tanpa proyek".into(),
        mode: SignMode::Parallel,
        requested_by: w.pk(0),
        team_id: None,
        project_id: None,
        original_hash: hash,
        original_size: sample.len() as u64,
        created_at: created.at.clone(),
        signers: vec![
            WireSigner {
                public_key: w.pk(1),
                display_name: "Budi".into(),
            },
            WireSigner {
                public_key: w.pk(g),
                display_name: "Tamu".into(),
            },
        ],
        created,
    });
    let rec = w.seal_as(0, &no_project);
    assert_eq!(w.ingest(1, 0, rec.clone()), (0, 1));
    assert_eq!(w.ingest(g, 0, rec), (0, 1));
}

#[test]
fn removed_member_records_are_rejected_and_they_receive_nothing() {
    let mut w = World::new(&["Sari", "Budi", "Citra"]);
    w.save_signature(1);
    let d = w
        .create(0, &pdf::sample_pdf(1), "parallel", &[1, 2], &no_scope())
        .unwrap();
    let id = d.summary.id.clone();
    w.converge(&ALL3);
    let citra_before = w.all_records(2);

    w.lab.remove(2);
    let next = stamp(&pdf::sample_pdf(1), &seal::doc_tag(&id));
    let late = w.signed_payload(2, &id, &d.original_hash, &next, false, 20);
    assert_eq!(w.ingest(0, 2, w.seal_as(2, &late)), (0, 1));
    assert!(w.nodes[0].sync.record_ids_for(&w.pk(2)).unwrap().is_empty());
    assert!(
        w.nodes[0]
            .sync
            .blob_path_for(&w.pk(2), &d.original_hash)
            .is_none()
    );

    w.sign(1, &id, stamp, 30).unwrap();
    w.converge(&ALL3);
    assert_eq!(
        w.all_records(2),
        citra_before,
        "Citra tidak menerima apa pun"
    );
    let a = w.detail(0, &id);
    assert_eq!(a.summary.signed_count, 1);
    assert_eq!(a.signers[1].status.as_str(), "waiting");
    w.assert_identical(&[0, 1], &id);
}

#[test]
fn non_involved_member_receives_nothing() {
    let w = World::new(&["Sari", "Budi", "Citra", "Dewi"]);
    let d = w
        .create(0, &pdf::sample_pdf(1), "parallel", &[1], &no_scope())
        .unwrap();
    let all = [0, 1, 2, 3];
    w.converge(&all);
    assert_eq!(w.record_count(1, &d.summary.id), 1);
    for i in [2, 3] {
        assert_eq!(w.all_records(i), 0, "laptop {i}");
        assert!(w.nodes[0].sync.record_ids_for(&w.pk(i)).unwrap().is_empty());
        assert!(
            w.ctx(i, |c| c.overview(t(1000)))
                .unwrap()
                .requests
                .is_empty()
        );
        assert!(
            w.nodes[0]
                .sync
                .blob_path_for(&w.pk(i), &d.original_hash)
                .is_none()
        );
    }
    assert!(
        w.nodes[0]
            .sync
            .blob_path_for(&w.pk(1), &d.original_hash)
            .is_some()
    );
}

#[test]
fn large_file_is_not_fetched_automatically_and_served_only_to_involved() {
    let w = World::new(&["Sari", "Budi", "Citra"]);
    w.save_signature(1);
    let mut big = pdf::sample_pdf(1);
    big.resize(AUTO_REPLICATE_MAX_BYTES as usize + 1024, b' ');
    let d = w.create(0, &big, "sequential", &[1], &no_scope()).unwrap();
    let id = d.summary.id.clone();
    let hash = d.original_hash.clone();
    w.converge(&ALL3);

    w.nodes[1].sync.peer_connected(&w.pk(0));
    assert!(!w.nodes[1].fetcher.wanted(&hash));
    let b = w.detail(1, &id);
    assert!(!b.summary.file_available);
    assert_eq!(b.summary.file_size, big.len() as u64);
    assert!(w.nodes[1].notifier.shown().is_empty(), "file belum ada");
    let missing = w.nodes[1].sync.missing_files(&id).unwrap();
    assert_eq!(missing.len(), 1);
    assert_eq!(missing[0].hash, hash);
    assert_eq!(missing[0].size, big.len() as u64);
    assert_eq!(missing[0].prefer, vec![w.pk(0)]);

    let max = big.len() as u64;
    let dest = w.lab.laptops[1].data_dir().join("besar.part");
    assert!(testing::copy_blob(&*w.nodes[0].sync, &w.pk(2), &hash, max, &dest).is_err());
    testing::copy_blob(&*w.nodes[0].sync, &w.pk(1), &hash, max, &dest).unwrap();
    w.nodes[1].sync.add_downloaded(&dest, &hash).unwrap();
    assert!(!dest.exists());

    let b = w.detail(1, &id);
    assert!(b.summary.file_available);
    assert_eq!(b.summary.integrity, seal::Integrity::Intact);
    assert_eq!(w.nodes[1].notifier.shown().len(), 1);
    assert!(w.nodes[1].sync.missing_files(&id).unwrap().is_empty());
}

#[test]
fn turn_notification_fires_once_per_version() {
    let w = World::new(&["Sari", "Budi", "Citra"]);
    w.save_signature(1);
    w.save_signature(2);
    let d = w
        .create(0, &pdf::sample_pdf(1), "sequential", &[1, 2], &no_scope())
        .unwrap();
    let id = d.summary.id.clone();
    w.converge(&ALL3);
    let expected = vec![(TURN_TITLE.to_owned(), "Kontrak Sewa".to_owned())];
    assert_eq!(TURN_TITLE, "Giliran Anda menandatangani");
    assert_eq!(w.nodes[1].notifier.shown(), expected);
    assert!(w.nodes[2].notifier.shown().is_empty());
    assert!(w.nodes[0].notifier.shown().is_empty());

    w.converge(&ALL3);
    assert_eq!(w.nodes[1].notifier.shown().len(), 1);

    w.sign(1, &id, stamp, 20).unwrap();
    w.converge(&ALL3);
    assert_eq!(w.nodes[2].notifier.shown(), expected);
    assert_eq!(w.nodes[1].notifier.shown().len(), 1);
    w.converge(&ALL3);
    assert_eq!(w.nodes[2].notifier.shown().len(), 1);
}

#[test]
fn records_arriving_out_of_order_wait_then_apply() {
    let w = World::new(&["Sari", "Budi", "Citra"]);
    w.save_signature(1);
    let d = w
        .create(0, &pdf::sample_pdf(1), "sequential", &[1], &no_scope())
        .unwrap();
    let id = d.summary.id.clone();
    w.converge(&[0, 1]);
    w.sign(1, &id, pdf::stamp_with_audit_page, 20).unwrap();

    // Sari menerima record `signed` sebelum filenya: menunggu.
    let ids = w.nodes[1].sync.record_ids_for(&w.pk(0)).unwrap();
    let wanted = w.nodes[0].sync.unknown_ids(&ids).unwrap();
    let recs = w.nodes[1].sync.records_for(&w.pk(0), &wanted).unwrap();
    assert_eq!(recs.len(), 1);
    w.nodes[0].sync.ingest(&w.pk(1), recs).unwrap();
    let a = w.detail(0, &id);
    assert!(a.summary.pending);
    assert_eq!(a.summary.status, RequestStatus::InProgress);

    assert_eq!(w.deliver(&[0, 1]), 1);
    let a = w.detail(0, &id);
    assert!(!a.summary.pending);
    assert_eq!(a.summary.status, RequestStatus::Completed);
    assert_eq!(a.seal_valid, Some(true));
    w.assert_identical(&[0, 1], &id);
}

fn request_payload_from(
    w: &World,
    author: usize,
    id: &str,
    salt: &str,
    original: &[u8],
    signers: &[(usize, &str)],
) -> Payload {
    let hash = seal::hash_hex(original);
    let created = w.event(author, id, EventKind::Created, None, Some(&hash), 4);
    Payload::Request(RequestPayload {
        id: id.to_owned(),
        salt: salt.to_owned(),
        title: "Kontrak".into(),
        mode: SignMode::Parallel,
        requested_by: w.pk(author),
        team_id: None,
        project_id: None,
        original_hash: hash,
        original_size: original.len() as u64,
        created_at: created.at.clone(),
        signers: signers
            .iter()
            .map(|&(i, name)| WireSigner {
                public_key: w.pk(i),
                display_name: name.into(),
            })
            .collect(),
        created,
    })
}

#[test]
fn request_id_cannot_be_taken_by_another_laptop() {
    let w = World::new(&["Sari", "Budi", "Citra"]);
    let sample = pdf::sample_pdf(1);
    assert_ne!(
        request_id_for(&w.pk(0), "aa"),
        request_id_for(&w.pk(2), "aa")
    );
    assert_ne!(
        request_id_for(&w.pk(0), "aa"),
        request_id_for(&w.pk(0), "ab")
    );

    let d = w.create(0, &sample, "parallel", &[1], &no_scope()).unwrap();
    let id = d.summary.id.clone();

    // Citra memakai id permintaan Sari dengan dirinya sebagai pengirim, dan
    // recordnya sampai ke Budi lebih dulu: ditolak.
    let salt = peer_sync::new_salt();
    let forged = request_payload_from(&w, 2, &id, &salt, &sample, &[(1, "Budi")]);
    assert_eq!(w.ingest(1, 2, w.seal_as(2, &forged)), (0, 1));
    // Salt kosong (record lama) juga ditolak.
    let old_id = request_id_for(&w.pk(2), "");
    let old = request_payload_from(&w, 2, &old_id, "", &sample, &[(1, "Budi")]);
    assert_eq!(w.ingest(1, 2, w.seal_as(2, &old)), (0, 1));
    // Permintaan Citra dengan id dari kuncinya sendiri diterima.
    let salt = peer_sync::new_salt();
    let own_id = request_id_for(&w.pk(2), &salt);
    let own = request_payload_from(&w, 2, &own_id, &salt, &sample, &[(1, "Budi")]);
    assert_eq!(w.ingest(1, 2, w.seal_as(2, &own)), (1, 0));

    // Permintaan Sari yang asli tetap sampai.
    w.converge(&[0, 1]);
    let b = w.detail(1, &id);
    assert_eq!(b.summary.requested_by_name, "Sari");
    assert_eq!(b.summary.title, "Kontrak Sewa");
}

#[test]
fn files_of_rejected_or_foreign_records_are_not_served() {
    let w = World::new(&["Sari", "Budi", "Citra"]);
    let orig = pdf::sample_pdf(1);
    let d = w.create(0, &orig, "parallel", &[1], &no_scope()).unwrap();
    let id = d.summary.id.clone();
    w.converge(&ALL3);
    let sari = &w.nodes[0].sync;
    assert!(sari.blob_path_for(&w.pk(1), &d.original_hash).is_some());

    // File lain yang dipegang Sari (bukan bagian permintaan mana pun).
    let secret = pdf::sample_pdf(3);
    let secret_hash = sari.store().put(&secret).unwrap();
    assert!(sari.blob_path_for(&w.pk(1), &secret_hash).is_none());

    // Budi mengakuinya sebagai versi bertanda tangannya: record disimpan dan
    // ditolak, dan filenya tetap tidak dikirim ke siapa pun.
    let claim = w.signed_payload(1, &id, &d.original_hash, &secret, true, 20);
    assert_eq!(w.ingest(0, 1, w.seal_as(1, &claim)), (1, 0));
    let a = w.detail(0, &id);
    assert_eq!(a.rejected.len(), 1);
    assert_eq!(a.rejected[0].code, "version_not_prefix");
    for peer in [1, 2] {
        assert!(
            sari.blob_path_for(&w.pk(peer), &secret_hash).is_none(),
            "laptop {peer}"
        );
    }

    // File permintaan lain yang tidak melibatkan Budi: record Budi yang
    // memakainya ditolak sebelum disimpan.
    let other = pdf::sample_pdf(4);
    let d2 = w.create(0, &other, "parallel", &[2], &no_scope()).unwrap();
    let before = w.record_count(0, &id);
    let claim = w.signed_payload(1, &id, &d.original_hash, &other, true, 25);
    assert_eq!(w.ingest(0, 1, w.seal_as(1, &claim)), (0, 1));
    assert_eq!(w.record_count(0, &id), before);
    assert!(sari.blob_path_for(&w.pk(1), &d2.original_hash).is_none());
    assert!(sari.blob_path_for(&w.pk(2), &d2.original_hash).is_some());
}

#[test]
fn file_of_a_hidden_document_is_not_served_through_a_request() {
    let w = World::new(&["Sari", "Budi"]);
    let secret = pdf::sample_pdf(2);
    let sari = &w.nodes[0].sync;
    let hash = sari.store().put(&secret).unwrap();
    let salt = peer_sync::new_salt();
    let rid = request_id_for(&w.pk(1), &salt);
    let req = request_payload_from(&w, 1, &rid, &salt, &secret, &[(0, "Sari")]);

    // Permintaan Budi sampai sebelum Sari memegang file itu sebagai dokumen.
    assert_eq!(w.ingest(0, 1, w.seal_as(1, &req)), (1, 0));
    assert!(sari.blob_path_for(&w.pk(1), &hash).is_some());

    // File yang sama ternyata versi dokumen di tim yang tidak boleh dilihat
    // Budi: tidak dikirim lagi lewat permintaan itu.
    let hidden_team = "9".repeat(32);
    let doc = "d".repeat(32);
    let now = clock::now_rfc3339();
    w.lab.laptops[0].with(|c| {
        c.db.execute(
            "INSERT INTO documents (id, team_id, project_id, name, kind, created_by, created_at)
             VALUES (?1, ?2, NULL, 'Rahasia.pdf', 'pdf', ?3, ?4)",
            params![doc, hidden_team, w.pk(0), now],
        )
        .unwrap();
        c.db.execute(
            "INSERT INTO document_versions (id, document_id, seq, blob_hash, size, author, created_at, origin)
             VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, 'added')",
            params!["e".repeat(32), doc, hash, secret.len() as i64, w.pk(0), now],
        )
        .unwrap();
    });
    assert!(sari.blob_path_for(&w.pk(1), &hash).is_none());

    // Permintaan baru dengan file itu ditolak saat diterima.
    let salt = peer_sync::new_salt();
    let rid = request_id_for(&w.pk(1), &salt);
    let again = request_payload_from(&w, 1, &rid, &salt, &secret, &[(0, "Sari")]);
    assert_eq!(w.ingest(0, 1, w.seal_as(1, &again)), (0, 1));
}

#[test]
fn rejected_and_pending_records_are_capped() {
    let w = World::new(&["Sari", "Budi"]);
    w.save_signature(1);
    let orig = pdf::sample_pdf(1);
    let d = w.create(0, &orig, "parallel", &[1], &no_scope()).unwrap();
    let id = d.summary.id.clone();
    w.converge(&[0, 1]);

    // Versi yang ditolak dari satu penanda tangan: paling banyak
    // MAX_REJECTED_PER_SIGNER, sisanya dibuang dan dicatat.
    let extra = 2;
    let recs: Vec<FeatureRecord> = (0..MAX_REJECTED_PER_SIGNER + extra)
        .map(|i| {
            let bad = pdf::tamper(&orig, &format!("{}{i}", seal::doc_tag(&id)));
            let p = w.signed_payload(1, &id, &d.original_hash, &bad, true, 20 + i);
            w.seal_as(1, &p)
        })
        .collect();
    let bad_files: Vec<Vec<u8>> = (0..MAX_REJECTED_PER_SIGNER)
        .map(|i| pdf::tamper(&orig, &format!("{}{i}", seal::doc_tag(&id))))
        .collect();
    let got = w.nodes[0].sync.ingest(&w.pk(1), recs).unwrap();
    assert_eq!(got.accepted as i64, MAX_REJECTED_PER_SIGNER);
    assert_eq!(got.rejected as i64, extra);
    // Filenya sampai (laptop Budi tidak mengirim versi yang ditolak).
    for (i, bad) in bad_files.iter().enumerate() {
        let path = w.lab.laptops[0].data_dir().join(format!("rusak-{i}.part"));
        std::fs::write(&path, bad).unwrap();
        w.nodes[0]
            .sync
            .add_downloaded(&path, &seal::hash_hex(bad))
            .unwrap();
    }
    w.converge(&[0, 1]);
    let a = w.detail(0, &id);
    assert_eq!(a.rejected.len() as i64, MAX_REJECTED_PER_SIGNER);
    assert!(!a.summary.pending);
    // Setelah batas itu, record Budi berikutnya untuk permintaan ini dibuang
    // di laptop Sari (termasuk yang sah) dan dicatat.
    let logged = |w: &World| -> i64 {
        w.lab.laptops[0].with(|c| {
            c.db.query_row(
                "SELECT COUNT(*) FROM rejected_changes WHERE code = 'sign_rejected'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        })
    };
    let before = logged(&w);
    w.sign(1, &id, pdf::stamp_with_audit_page, 90).unwrap();
    w.sync(&[0, 1]);
    assert_eq!(w.detail(0, &id).summary.status, RequestStatus::InProgress);
    assert_eq!(logged(&w), before + 1);
    assert_eq!(w.record_count(0, &id), 1 + MAX_REJECTED_PER_SIGNER);

    // Record untuk permintaan yang tidak dikenal: paling banyak
    // MAX_PENDING_PER_AUTHOR per penulis.
    let next = stamp(&orig, "x");
    let recs: Vec<FeatureRecord> = (0..=MAX_PENDING_PER_AUTHOR)
        .map(|i| {
            let rid = request_id_for(&w.pk(1), &format!("{i:032x}"));
            let p = w.signed_payload(1, &rid, &d.original_hash, &next, false, i);
            w.seal_as(1, &p)
        })
        .collect();
    let got = w.nodes[0].sync.ingest(&w.pk(1), recs).unwrap();
    assert_eq!(got.accepted as i64, MAX_PENDING_PER_AUTHOR);
    assert_eq!(got.rejected, 1);
    let pending = |w: &World| -> i64 {
        w.lab.laptops[0].with(|c| {
            c.db.query_row(
                "SELECT COUNT(*) FROM sign_sync_records WHERE state = 'pending'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        })
    };
    assert_eq!(pending(&w), MAX_PENDING_PER_AUTHOR);

    // Setelah 7 hari tanpa data permintaan, record itu dihapus.
    let old = clock::format_rfc3339(clock::now() - time::Duration::days(8));
    w.lab.laptops[0].with(|c| {
        c.db.execute(
            "UPDATE sign_sync_records SET received_at = ?1 WHERE state = 'pending'",
            params![old],
        )
        .unwrap();
    });
    let rid = request_id_for(&w.pk(1), "baru");
    let p = w.signed_payload(1, &rid, &d.original_hash, &next, false, 500);
    assert_eq!(w.ingest(0, 1, w.seal_as(1, &p)), (1, 0));
    assert_eq!(pending(&w), 1);
}

#[test]
fn downloads_cover_current_and_pending_versions_only() {
    let w = World::new(&["Sari", "Budi", "Citra"]);
    w.save_signature(1);
    w.save_signature(2);
    let d = w
        .create(0, &pdf::sample_pdf(1), "parallel", &[1, 2], &no_scope())
        .unwrap();
    let id = d.summary.id.clone();
    w.converge(&ALL3);

    // Budi menandatangani; Citra menerima recordnya, belum filenya.
    let v1 = w.sign(1, &id, stamp, 20).unwrap().current_hash;
    w.sync(&ALL3);
    let c = w.detail(2, &id);
    assert!(c.summary.pending);
    let missing = w.nodes[2].sync.missing_files(&id).unwrap();
    assert_eq!(
        missing.iter().map(|m| m.hash.as_str()).collect::<Vec<_>>(),
        vec![v1.as_str()]
    );
    assert_eq!(c.summary.download_size, missing[0].size);
    assert_eq!(missing[0].size, w.read(1, &v1).len() as u64);

    // Selama file itu diunduh, permintaan tampil `downloading`.
    assert!(!c.summary.downloading);
    let store = w.nodes[2].sync.store();
    let guard = Downloading::begin(store, &v1).unwrap();
    assert!(
        Downloading::begin(store, &v1).is_none(),
        "satu unduhan per file"
    );
    assert!(w.detail(2, &id).summary.downloading);
    assert!(!w.detail(0, &id).summary.downloading);
    drop(guard);
    assert!(!w.detail(2, &id).summary.downloading);

    w.converge(&ALL3);
    let c = w.detail(2, &id);
    assert!(!c.summary.pending);
    assert_eq!(c.summary.download_size, 0);
    assert_eq!(c.current_hash, v1);
    // Bukti stempel dicatat (di luar kunci inti), dengan aturannya.
    let cached: String = w.lab.laptops[2].with(|c| {
        c.db.query_row(
            "SELECT reason FROM sign_proof_checks WHERE hash_after = ?1",
            params![v1],
            |r| r.get(0),
        )
        .unwrap()
    });
    assert!(cached.contains("\"completing\":false"), "{cached}");

    w.sign(2, &id, pdf::stamp_with_audit_page, 30).unwrap();
    w.converge(&ALL3);
    for i in ALL3 {
        let stuck: i64 = w.lab.laptops[i].with(|c| {
            c.db.query_row(
                "SELECT COUNT(*) FROM sign_sync_records WHERE state != 'ok'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        });
        assert_eq!(stuck, 0, "laptop {i}");
    }

    // Setelah rantai berjalan, versi asli tidak diminta lagi.
    let h = crate::blobs::BlobHash::parse(&d.original_hash).unwrap();
    w.lab.laptops[1].blobs().remove(&h).unwrap();
    assert!(w.nodes[1].sync.missing_files(&id).unwrap().is_empty());
    assert_eq!(w.detail(1, &id).summary.download_size, 0);
}
