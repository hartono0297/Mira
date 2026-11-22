//! Tes alur tanda tangan (`service::SignContext`) dengan database sementara,
//! `MemoryStore`, dan `KdfParams::TEST`.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Mutex;

use data_encoding::BASE64;
use rusqlite::{Connection, params};
use time::{Duration, OffsetDateTime};

use super::increment::testing as pdf;
use super::outbox::SignOutbox;
use super::pin::KdfParams;
use super::repo;
use super::request::{RequestStatus, SignRequest};
use super::seal::{self, EventKind, EventRecord};
use super::service::{
    RequestDetail, SignContext, VerifyState, clean_file_name, clean_name_part, export_stem,
};
use super::session::SignSessions;
use super::store::{DocumentStore, MemoryStore};
use crate::documents::scope::InviteGuestProjects;
use crate::error::{AppError, AppResult};
use crate::identity::{self, Identity, MemoryKeyStore};
use crate::{clock, db, org};

const PIN: &str = "123456";

#[derive(Default)]
struct RecordingOutbox {
    calls: Mutex<Vec<String>>,
}

impl RecordingOutbox {
    fn push(&self, s: String) {
        self.calls.lock().unwrap().push(s);
    }
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

impl SignOutbox for RecordingOutbox {
    fn request_created(&self, r: &SignRequest) -> AppResult<()> {
        self.push(format!("created:{}", r.id));
        Ok(())
    }
    fn version_signed(&self, r: &SignRequest, signer: &str, hash: &str) -> AppResult<()> {
        assert_eq!(hash, r.current_hash);
        self.push(format!(
            "signed:{}:{}:{}",
            r.id,
            &signer[..8],
            r.status.as_str()
        ));
        Ok(())
    }
    fn request_cancelled(&self, r: &SignRequest) -> AppResult<()> {
        self.push(format!("cancelled:{}", r.id));
        Ok(())
    }
}

struct Fx {
    _dir: tempfile::TempDir,
    export_dir: PathBuf,
    conn: Connection,
    id: Identity,
    store: MemoryStore,
    sessions: SignSessions,
    outbox: RecordingOutbox,
    org_id: String,
}

fn fx() -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let mut conn = db::open(dir.path()).unwrap();
    let mut id = identity::ensure_identity(&conn, &MemoryKeyStore::new()).unwrap();
    identity::save_display_name(&mut conn, &mut id, "Sari Dewi").unwrap();
    let org = org::create_organization(&mut conn, &id, "CV Maju Jaya").unwrap();
    Fx {
        export_dir: dir.path().join("Unduhan"),
        _dir: dir,
        conn,
        id,
        store: MemoryStore::new(),
        sessions: SignSessions::default(),
        outbox: RecordingOutbox::default(),
        org_id: org.id,
    }
}

fn t(secs: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp(1_795_000_000 + secs).unwrap()
}

fn tiny_png(width: u32, height: u32) -> Vec<u8> {
    let mut v = vec![0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];
    v.extend_from_slice(&13u32.to_be_bytes());
    v.extend_from_slice(b"IHDR");
    v.extend_from_slice(&width.to_be_bytes());
    v.extend_from_slice(&height.to_be_bytes());
    v.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
    v.extend_from_slice(&0u32.to_be_bytes());
    v.extend_from_slice(b"IEND");
    v.extend_from_slice(&[0xae, 0x42, 0x60, 0x82]);
    v
}

fn original_pdf() -> Vec<u8> {
    pdf::sample_pdf(1)
}

/// Versi ke-`n` permintaan `id`: `n` kali stempel incremental di atas
/// `original_pdf()` (n >= 1), jadi lolos bukti stempel terhadap versi ke-(n-1).
fn stamped(id: &str, n: u32) -> Vec<u8> {
    let tag = seal::doc_tag(id);
    (0..n.max(1)).fold(original_pdf(), |prev, _| pdf::stamp(&prev, &tag))
}

fn code<T: std::fmt::Debug>(r: AppResult<T>) -> &'static str {
    r.unwrap_err().code()
}

impl Fx {
    fn ctx(&mut self) -> SignContext<'_> {
        SignContext {
            conn: &mut self.conn,
            identity: &self.id,
            store: &self.store,
            sessions: &self.sessions,
            outbox: &self.outbox,
            guests: &InviteGuestProjects,
            export_dir: &self.export_dir,
            kdf: KdfParams::TEST,
        }
    }

    fn me(&self) -> String {
        self.id.public_key_hex().to_owned()
    }

    fn add_member(&self, n: u8, name: &str, kind: &str, role: &str, status: &str) -> String {
        let pk = format!("{:02x}", n).repeat(32);
        self.conn
            .execute(
                "INSERT INTO members (organization_id, public_key, display_name, role, added_at, status, kind)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![self.org_id, pk, name, role, clock::format_rfc3339(t(0)), status, kind],
            )
            .unwrap();
        pk
    }

    fn set_my_row(&self, kind: &str, role: &str) {
        self.conn
            .execute(
                "UPDATE members SET kind = ?1, role = ?2 WHERE public_key = ?3",
                params![kind, role, self.id.public_key_hex()],
            )
            .unwrap();
    }

    fn save_signature(&mut self) {
        let png = BASE64.encode(&tiny_png(300, 100));
        self.ctx().save_signature(PIN, &png, t(0)).unwrap();
    }

    fn import(&mut self, bytes: &[u8]) -> String {
        self.ctx()
            .import_pdf(bytes, "Kontrak Sewa.pdf")
            .unwrap()
            .file_hash
    }

    fn create(&mut self, signers: &[String], mode: &str) -> RequestDetail {
        let hash = self.import(&original_pdf());
        self.ctx()
            .create_request("Kontrak Sewa.pdf", &hash, mode, signers, t(5))
            .unwrap()
    }

    fn unlock(&mut self, at: OffsetDateTime) -> String {
        self.ctx().unlock(PIN, at).unwrap().token
    }

    fn sign(&mut self, d: &RequestDetail, bytes: &[u8]) -> AppResult<RequestDetail> {
        let token = self.ctx().unlock(PIN, t(10))?.token;
        let (id, base) = (d.summary.id.clone(), d.current_hash.clone());
        self.ctx().complete(&id, &token, &base, bytes, t(20))
    }

    fn exec(&self, sql: &str, p: impl rusqlite::Params) {
        self.conn.execute(sql, p).unwrap();
    }
}

fn kinds(d: &RequestDetail) -> Vec<&str> {
    d.events.iter().map(|e| e.kind.as_str()).collect()
}

#[test]
fn full_flow_single_signer() {
    let mut f = fx();
    let me = f.me();
    assert!(f.ctx().overview(t(1000)).unwrap().saved.is_none());
    f.save_signature();
    let saved = f.ctx().overview(t(1000)).unwrap().saved.unwrap();
    assert_eq!((saved.width, saved.height), (300, 100));

    let d = f.create(std::slice::from_ref(&me), "sequential");
    let id = d.summary.id.clone();
    assert_eq!(id.len(), 32);
    assert_eq!(d.summary.status.as_str(), "in_progress");
    assert_eq!(d.summary.my_state.as_str(), "your_turn");
    assert_eq!(d.summary.integrity, seal::Integrity::Intact);
    assert_eq!(d.original_hash, seal::hash_hex(&original_pdf()));
    assert_eq!(d.current_hash, d.original_hash);
    assert_eq!(d.requested_by.public_key, me);
    assert_eq!(d.requested_by.display_name, "Sari Dewi");
    assert_eq!(d.signers[0].display_name, "Sari Dewi");
    assert!(d.signers[0].is_me && d.signers[0].can_sign_now);
    assert!(d.is_last_pending);
    assert_eq!(d.doc_tag, format!("mira-doc:{id}"));
    assert_eq!(d.seal_valid, None);
    assert_eq!(kinds(&d), ["created"]);
    assert!(d.events[0].valid);
    assert_eq!(
        d.events[0].hash_after.as_deref(),
        Some(d.original_hash.as_str())
    );

    let unlocked = f.ctx().unlock(PIN, t(10)).unwrap();
    assert_eq!(
        BASE64.decode(unlocked.png_base64.as_bytes()).unwrap(),
        tiny_png(300, 100)
    );
    assert_eq!(unlocked.signed_at, clock::format_rfc3339(t(10)));
    assert_eq!((unlocked.width, unlocked.height), (300, 100));

    let signed = stamped(&id, 1);
    let done = f
        .ctx()
        .complete(&id, &unlocked.token, &d.current_hash, &signed, t(20))
        .unwrap();
    assert_eq!(done.summary.status.as_str(), "completed");
    assert_eq!(done.summary.my_state.as_str(), "signed");
    assert_eq!(done.current_hash, seal::hash_hex(&signed));
    assert_eq!(done.summary.completed_at, Some(unlocked.signed_at.clone()));
    assert_eq!(done.signers[0].signed_at, Some(unlocked.signed_at.clone()));
    assert_eq!(
        done.signers[0].hash_after.as_deref(),
        Some(done.current_hash.as_str())
    );
    assert!(!done.signers[0].can_sign_now);
    assert!(!done.is_last_pending);
    assert_eq!(done.seal_valid, Some(true));
    assert_eq!(kinds(&done), ["created", "signed", "completed"]);
    assert!(done.events.iter().all(|e| e.valid));
    assert_eq!(
        done.events[1].hash_before.as_deref(),
        Some(d.original_hash.as_str())
    );
    assert_eq!(done.events[1].at, unlocked.signed_at);
    assert_eq!(done.events[2].detail, "1 penanda tangan");

    // Token sudah terpakai.
    assert_eq!(
        code(f.ctx().complete(
            &id,
            &unlocked.token,
            &done.current_hash,
            &stamped(&id, 2),
            t(21)
        )),
        "session_expired"
    );

    let ov = f.ctx().overview(t(1000)).unwrap();
    assert_eq!(ov.requests.len(), 1);
    assert_eq!(ov.requests[0].integrity, seal::Integrity::Intact);
    assert_eq!(ov.requests[0].signed_count, 1);
    assert!(ov.can_request);
    assert_eq!(ov.me.display_name, "Sari Dewi");

    assert_eq!(
        f.outbox.calls(),
        [
            format!("created:{id}"),
            format!("signed:{id}:{}:completed", &me[..8])
        ]
    );

    // Hapus tanda tangan dicatat; hapus kedua kali tidak error.
    f.ctx().delete_signature(None, t(30)).unwrap();
    f.ctx().delete_signature(None, t(31)).unwrap();
    assert!(f.ctx().overview(t(1000)).unwrap().saved.is_none());
    let personal: Vec<String> = f
        .conn
        .prepare("SELECT kind FROM sign_events WHERE request_id IS NULL ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(personal, ["signature_saved", "signature_deleted"]);
    assert_eq!(code(f.ctx().unlock(PIN, t(40))), "signature_missing");
}

#[test]
fn token_expired_foreign_and_single_use() {
    let mut f = fx();
    let me = f.me();
    f.save_signature();
    let d = f.create(std::slice::from_ref(&me), "parallel");
    let id = d.summary.id.clone();
    let base = d.current_hash.clone();
    let good = stamped(&id, 1);

    let token = f.unlock(t(0));
    assert_eq!(
        code(
            f.ctx()
                .complete(&id, &token, &base, &good, t(0) + Duration::minutes(6))
        ),
        "session_expired"
    );

    let (foreign, _) = f.sessions.issue(&"ab".repeat(32), t(0));
    assert_eq!(
        code(f.ctx().complete(&id, &foreign, &base, &good, t(1))),
        "session_expired"
    );
    assert_eq!(
        code(f.ctx().complete(&id, "bukan-token", &base, &good, t(1))),
        "session_expired"
    );

    // Gagal karena alasan lain tetap menghabiskan token.
    let token = f.unlock(t(0));
    assert_eq!(
        code(f.ctx().complete(&id, &token, &base, &original_pdf(), t(1))),
        "tag_missing"
    );
    assert_eq!(
        code(f.ctx().complete(&id, &token, &base, &good, t(2))),
        "session_expired"
    );

    assert_eq!(code(f.ctx().unlock("654321", t(3))), "pin_wrong");
    assert_eq!(code(f.ctx().unlock("12", t(3))), "pin_invalid");
}

#[test]
fn version_conflict_tag_missing_and_unchanged_file() {
    let mut f = fx();
    let me = f.me();
    f.save_signature();
    let d = f.create(std::slice::from_ref(&me), "sequential");
    let id = d.summary.id.clone();

    let token = f.unlock(t(10));
    assert_eq!(
        code(
            f.ctx()
                .complete(&id, &token, &"0".repeat(64), &stamped(&id, 1), t(11))
        ),
        "version_conflict"
    );

    let other_id = "f".repeat(32);
    let token = f.unlock(t(10));
    assert_eq!(
        code(
            f.ctx()
                .complete(&id, &token, &d.current_hash, &stamped(&other_id, 1), t(11))
        ),
        "tag_missing"
    );

    let token = f.unlock(t(10));
    assert_eq!(
        code(
            f.ctx()
                .complete(&id, &token, &d.current_hash, b"bukan pdf mira-doc:x", t(11))
        ),
        "pdf_invalid"
    );

    // Versi terkini yang sudah memuat penanda, lalu dikirim ulang tanpa perubahan.
    let tagged = stamped(&id, 1);
    let tagged_hash = f.store.put(&tagged).unwrap();
    f.exec(
        "UPDATE sign_requests SET current_hash = ?1 WHERE id = ?2",
        params![tagged_hash, id],
    );
    let token = f.unlock(t(10));
    let err = f
        .ctx()
        .complete(&id, &token, &tagged_hash, &tagged, t(11))
        .unwrap_err();
    assert_eq!(err.code(), "pdf_invalid");
    assert!(err.to_string().contains("sama persis"));

    // Tidak ada yang tercatat dari percobaan yang gagal.
    let d = f.ctx().get_request(&id).unwrap();
    assert_eq!(kinds(&d), ["created"]);
    assert_eq!(d.summary.signed_count, 0);
}

#[test]
fn sequential_order_and_parallel_mode() {
    let mut f = fx();
    let me = f.me();
    let budi = f.add_member(0xb1, "Budi Santoso", "member", "member", "active");
    f.save_signature();

    let d = f.create(&[budi.clone(), me.clone()], "sequential");
    assert_eq!(d.summary.my_state.as_str(), "waiting_others");
    assert!(d.signers[0].can_sign_now && !d.signers[0].is_me);
    assert!(!d.signers[1].can_sign_now && d.signers[1].is_me);
    assert_eq!(d.signers[0].display_name, "Budi Santoso");
    assert!(!d.is_last_pending);
    let err = f.sign(&d, &stamped(&d.summary.id, 1)).unwrap_err();
    assert_eq!(err.code(), "not_your_turn");
    assert!(err.to_string().contains("Budi Santoso"));

    let d = f.create(&[budi.clone(), me.clone()], "parallel");
    assert_eq!(d.summary.my_state.as_str(), "your_turn");
    assert!(d.signers[0].can_sign_now && d.signers[1].can_sign_now);
    assert!(!d.is_last_pending);
    let after = f.sign(&d, &stamped(&d.summary.id, 1)).unwrap();
    assert_eq!(after.summary.status.as_str(), "in_progress");
    assert_eq!(after.summary.my_state.as_str(), "signed");
    assert_eq!(after.summary.signed_count, 1);
    assert_eq!(after.seal_valid, None);
    assert_eq!(kinds(&after), ["created", "signed"]);
    assert_eq!(after.events[1].detail, "penanda tangan ke-2 dari 2");
    assert_eq!(
        code(f.sign(&after, &stamped(&d.summary.id, 2))),
        "already_signed"
    );

    // Bukan penanda tangan.
    let d = f.create(std::slice::from_ref(&budi), "parallel");
    assert_eq!(d.summary.my_state.as_str(), "waiting_others");
    assert_eq!(code(f.sign(&d, &stamped(&d.summary.id, 1))), "not_a_signer");
}

#[test]
fn guest_rules() {
    let mut f = fx();
    let me = f.me();
    let tamu = f.add_member(0xc1, "Tamu Klien", "guest", "guest", "active");
    f.save_signature();
    // Tamu tidak muncul tanpa proyek, dan juga tidak di proyek yang tidak
    // diizinkan untuknya.
    let candidates = f.ctx().list_candidates().unwrap();
    assert_eq!(candidates.len(), 1);
    assert!(candidates[0].is_me);
    let in_project = f
        .ctx()
        .list_candidates_for(None, Some(&"ab".repeat(16)))
        .unwrap();
    assert!(in_project.iter().all(|c| c.public_key != tamu));
    // Tamu sebagai penanda tangan tanpa proyek ditolak.
    let hash = f.import(&original_pdf());
    let err = f
        .ctx()
        .create_request("Lain", &hash, "parallel", std::slice::from_ref(&tamu), t(6))
        .unwrap_err();
    assert_eq!(err.code(), "request_invalid");
    assert!(err.to_string().contains("Tamu Klien adalah Tamu"), "{err}");

    // Dibuat saat masih anggota; lalu laptop ini menjadi Tamu.
    let d = f.create(std::slice::from_ref(&me), "sequential");
    f.set_my_row("guest", "member");
    let ov = f.ctx().overview(t(1000)).unwrap();
    assert!(!ov.can_request);
    assert_eq!(ov.me.kind.as_str(), "guest");
    let hash = f.import(&original_pdf());
    assert_eq!(
        code(
            f.ctx()
                .create_request("Lain", &hash, "parallel", std::slice::from_ref(&me), t(6))
        ),
        "guest_cannot_request"
    );
    // Peran lama `guest` juga Tamu.
    f.set_my_row("member", "guest");
    assert!(!f.ctx().overview(t(1000)).unwrap().can_request);
    assert_eq!(
        code(
            f.ctx()
                .create_request("Lain", &hash, "parallel", std::slice::from_ref(&me), t(6))
        ),
        "guest_cannot_request"
    );

    // Tamu tetap boleh menandatangani.
    let done = f.sign(&d, &stamped(&d.summary.id, 1)).unwrap();
    assert_eq!(done.summary.status.as_str(), "completed");

    // Laptop yang dikeluarkan tidak bisa meminta atau menandatangani.
    f.set_my_row("member", "member");
    let d = f.create(std::slice::from_ref(&me), "sequential");
    f.exec(
        "UPDATE members SET status = 'removed' WHERE public_key = ?1",
        params![me],
    );
    assert!(!f.ctx().overview(t(1000)).unwrap().can_request);
    assert_eq!(code(f.sign(&d, &stamped(&d.summary.id, 1))), "removed");
    assert_eq!(
        code(
            f.ctx()
                .create_request("Lain", &hash, "parallel", std::slice::from_ref(&me), t(6))
        ),
        "removed"
    );
}

#[test]
fn invalid_requests() {
    let mut f = fx();
    let me = f.me();
    let removed = f.add_member(0xd1, "Keluar", "member", "member", "removed");
    let hash = f.import(&original_pdf());
    let mut ctx = f.ctx();

    let stranger = "e".repeat(64);
    let err = ctx
        .create_request("Kontrak", &hash, "parallel", &[me.clone(), stranger], t(1))
        .unwrap_err();
    assert_eq!(err.code(), "request_invalid");
    assert!(err.to_string().contains("ke-2"));
    assert_eq!(
        code(ctx.create_request("Kontrak", &hash, "parallel", &[removed], t(1))),
        "request_invalid"
    );
    assert_eq!(
        code(ctx.create_request("Kontrak", &hash, "acak", std::slice::from_ref(&me), t(1))),
        "request_invalid"
    );
    assert_eq!(
        code(ctx.create_request("Kontrak", &hash, "parallel", &[], t(1))),
        "request_invalid"
    );
    assert_eq!(
        code(ctx.create_request("  ", &hash, "parallel", std::slice::from_ref(&me), t(1))),
        "request_invalid"
    );
    assert_eq!(
        code(ctx.create_request(
            "Kontrak",
            &hash,
            "parallel",
            &[me.clone(), me.clone()],
            t(1)
        )),
        "request_invalid"
    );
    assert_eq!(
        code(ctx.create_request(
            "Kontrak",
            &"a".repeat(64),
            "parallel",
            std::slice::from_ref(&me),
            t(1)
        )),
        "not_found"
    );
    assert_eq!(
        code(ctx.create_request(
            "Kontrak",
            "../x",
            "parallel",
            std::slice::from_ref(&me),
            t(1)
        )),
        "not_found"
    );
    assert_eq!(
        code(ctx.import_pdf(b"PK\x03\x04 zip", "a.docx")),
        "pdf_invalid"
    );
    assert_eq!(code(ctx.get_request(&"0".repeat(32))), "not_found");
    assert_eq!(code(ctx.get_request("../../etc")), "not_found");
    assert!(ctx.overview(t(1000)).unwrap().requests.is_empty());
}

#[test]
fn no_organization_means_no_requests() {
    let dir = tempfile::tempdir().unwrap();
    let mut conn = db::open(dir.path()).unwrap();
    let id = identity::ensure_identity(&conn, &MemoryKeyStore::new()).unwrap();
    let (store, sessions, outbox) = (
        MemoryStore::new(),
        SignSessions::default(),
        RecordingOutbox::default(),
    );
    let mut ctx = SignContext {
        conn: &mut conn,
        identity: &id,
        store: &store,
        sessions: &sessions,
        outbox: &outbox,
        guests: &InviteGuestProjects,
        export_dir: dir.path(),
        kdf: KdfParams::TEST,
    };
    let ov = ctx.overview(t(1000)).unwrap();
    assert!(!ov.can_request);
    assert_eq!(ov.me.display_name, "");
    assert!(ctx.list_candidates().unwrap().is_empty());
    let hash = ctx.import_pdf(&original_pdf(), "a.pdf").unwrap().file_hash;
    let pk = id.public_key_hex().to_owned();
    assert_eq!(
        code(ctx.create_request("Kontrak", &hash, "parallel", &[pk], t(1))),
        "request_invalid"
    );
}

#[test]
fn tampered_blob_is_reported_and_blocks_export() {
    let mut f = fx();
    let me = f.me();
    f.save_signature();
    let d = f.create(std::slice::from_ref(&me), "sequential");
    let done = f.sign(&d, &stamped(&d.summary.id, 1)).unwrap();
    let id = done.summary.id.clone();

    f.store.tamper(&done.current_hash, b"%PDF-1.7 diubah");
    assert_eq!(
        f.ctx().overview(t(1000)).unwrap().requests[0].integrity,
        seal::Integrity::Changed
    );
    let d = f.ctx().get_request(&id).unwrap();
    assert_eq!(d.summary.integrity, seal::Integrity::Changed);
    assert_eq!(d.seal_valid, Some(false));
    assert_eq!(code(f.ctx().export(&id, t(30))), "export_failed");

    f.store.remove(&done.current_hash);
    let d = f.ctx().get_request(&id).unwrap();
    assert_eq!(d.summary.integrity, seal::Integrity::Missing);
    assert_eq!(d.seal_valid, Some(false));
    assert_eq!(code(f.ctx().export(&id, t(30))), "export_failed");
    assert!(!f.export_dir.exists() || std::fs::read_dir(&f.export_dir).unwrap().next().is_none());
}

#[test]
fn export_does_not_overwrite_and_watches_files() {
    let mut f = fx();
    let me = f.me();
    f.save_signature();
    let d = f.create(std::slice::from_ref(&me), "sequential");
    let id = d.summary.id.clone();

    let first = f.ctx().export(&id, t(25)).unwrap();
    assert!(
        first
            .path
            .ends_with("Kontrak Sewa (belum ditandatangani).pdf"),
        "{}",
        first.path
    );

    let done = f.sign(&d, &stamped(&id, 1)).unwrap();
    let a = f.ctx().export(&id, t(30)).unwrap();
    let b = f.ctx().export(&id, t(31)).unwrap();
    let a_path = PathBuf::from(&a.path);
    let b_path = PathBuf::from(&b.path);
    assert_eq!(
        a_path.file_name().unwrap(),
        "Kontrak Sewa (ditandatangani).pdf"
    );
    assert_eq!(
        b_path.file_name().unwrap(),
        "Kontrak Sewa (ditandatangani) (2).pdf"
    );
    assert_eq!(a_path.parent().unwrap(), f.export_dir);
    assert_eq!(std::fs::read(&a_path).unwrap(), stamped(&id, 1));
    assert_eq!(std::fs::read(&b_path).unwrap(), stamped(&id, 1));

    let d = f.ctx().get_request(&id).unwrap();
    assert_eq!(d.exports.len(), 3);
    assert!(d.exports.iter().all(|e| e.state == seal::Integrity::Intact));
    let exported: Vec<&str> = d
        .events
        .iter()
        .filter(|e| e.kind == "exported")
        .map(|e| e.detail.as_str())
        .collect();
    assert_eq!(
        exported,
        [
            "Kontrak Sewa (belum ditandatangani).pdf",
            "Kontrak Sewa (ditandatangani).pdf",
            "Kontrak Sewa (ditandatangani) (2).pdf"
        ]
    );
    assert!(d.events.iter().all(|e| e.valid));
    assert_eq!(
        f.ctx().overview(t(1000)).unwrap().requests[0].export_warnings,
        0
    );

    // Ubah satu byte file ekspor.
    let mut bytes = std::fs::read(&a_path).unwrap();
    bytes[10] ^= 0x01;
    std::fs::write(&a_path, &bytes).unwrap();
    assert_eq!(
        f.ctx().overview(t(1000)).unwrap().requests[0].export_warnings,
        1
    );
    let d = f.ctx().get_request(&id).unwrap();
    let state_of =
        |d: &RequestDetail, p: &str| d.exports.iter().find(|e| e.path == p).unwrap().state;
    assert_eq!(state_of(&d, &a.path), seal::Integrity::Changed);
    assert_eq!(d.summary.export_warnings, 1);

    // File yang dihapus: terlihat hilang, tidak dihitung sebagai peringatan.
    std::fs::remove_file(&b_path).unwrap();
    let d = f.ctx().get_request(&id).unwrap();
    assert_eq!(state_of(&d, &b.path), seal::Integrity::Missing);
    assert_eq!(d.summary.export_warnings, 1);
    assert_eq!(d.seal_valid, Some(true));
    assert_eq!(done.summary.status.as_str(), "completed");
}

#[test]
fn export_names_are_clean() {
    assert_eq!(
        clean_file_name(r"C:\Users\sari\Kontrak<1>.pdf"),
        "Kontrak-1-.pdf"
    );
    assert_eq!(clean_file_name("../../rahasia.pdf"), "rahasia.pdf");
    assert_eq!(clean_file_name(""), "dokumen.pdf");
    assert_eq!(clean_file_name("a\u{202e}b\tc.pdf"), "ab c.pdf");
    assert_eq!(
        clean_name_part("  ..Laporan:  Q1?  .. ", "x"),
        "Laporan- Q1-"
    );
    assert_eq!(clean_name_part("...", "Dokumen"), "Dokumen");
    assert_eq!(clean_name_part(&"a".repeat(300), "x").chars().count(), 120);

    let mut req = SignRequest {
        id: "0".repeat(32),
        title: "Surat Kuasa 1/2026.PDF".into(),
        requested_by: "1".repeat(64),
        mode: super::request::SignMode::Parallel,
        status: super::request::RequestStatus::InProgress,
        original_hash: "2".repeat(64),
        current_hash: "2".repeat(64),
        created_at: String::new(),
        updated_at: String::new(),
        completed_at: None,
        signers: vec![
            super::request::Signer {
                position: 0,
                public_key: "3".repeat(64),
                display_name: "A".into(),
                kind: super::request::SignerKind::Member,
                status: super::request::SignerStatus::Signed,
                signed_at: None,
                hash_after: None,
            },
            super::request::Signer {
                position: 1,
                public_key: "4".repeat(64),
                display_name: "B".into(),
                kind: super::request::SignerKind::Member,
                status: super::request::SignerStatus::Waiting,
                signed_at: None,
                hash_after: None,
            },
        ],
    };
    assert_eq!(
        export_stem(&req),
        "Surat Kuasa 1-2026 (versi 1 tanda tangan)"
    );
    req.status = super::request::RequestStatus::Completed;
    assert_eq!(export_stem(&req), "Surat Kuasa 1-2026 (ditandatangani)");
}

#[test]
fn verify_file_states() {
    let mut f = fx();
    let me = f.me();
    let budi = f.add_member(0xb2, "Budi Santoso", "member", "member", "active");
    f.save_signature();

    let d = f.create(std::slice::from_ref(&me), "sequential");
    let id = d.summary.id.clone();
    let final_bytes = stamped(&id, 1);
    let done = f.sign(&d, &final_bytes).unwrap();

    let ctx = f.ctx();
    let r = ctx.verify_file(&final_bytes).unwrap();
    assert_eq!(r.state, VerifyState::MatchFinal);
    assert_eq!(r.file_hash, done.current_hash);
    assert_eq!(r.request_id.as_deref(), Some(id.as_str()));
    assert_eq!(r.title.as_deref(), Some("Kontrak Sewa.pdf"));
    assert_eq!(r.completed_at, done.summary.completed_at);
    assert_eq!(r.signers.len(), 1);
    assert_eq!(r.signers[0].display_name, "Sari Dewi");
    assert_eq!(r.signers[0].signed_at, done.signers[0].signed_at);

    // Versi asli dipakai bersama permintaan lain nanti; tetap versi tercatat.
    let r = ctx.verify_file(&original_pdf()).unwrap();
    assert_eq!(r.state, VerifyState::MatchVersion);
    assert_eq!(r.request_id.as_deref(), Some(id.as_str()));

    let mut changed = final_bytes.clone();
    changed.extend_from_slice(b"% sisipan\n");
    let r = ctx.verify_file(&changed).unwrap();
    assert_eq!(r.state, VerifyState::Changed);
    assert_eq!(r.request_id.as_deref(), Some(id.as_str()));
    assert_eq!(r.title.as_deref(), Some("Kontrak Sewa.pdf"));

    let r = ctx.verify_file(b"%PDF-1.4 file lain").unwrap();
    assert_eq!(r.state, VerifyState::Unknown);
    assert_eq!(r.request_id, None);
    assert_eq!(r.title, None);
    assert!(r.signers.is_empty());

    let r = ctx.verify_file(&stamped(&"9".repeat(32), 1)).unwrap();
    assert_eq!(r.state, VerifyState::Unknown);

    // Versi tengah permintaan yang belum selesai.
    let d = f.create(&[me.clone(), budi], "parallel");
    let mid = stamped(&d.summary.id, 1);
    f.sign(&d, &mid).unwrap();
    let r = f.ctx().verify_file(&mid).unwrap();
    assert_eq!(r.state, VerifyState::MatchVersion);
    assert_eq!(r.completed_at, None);

    // `current_hash` yang diubah langsung di DB tidak cukup untuk match_final.
    f.exec(
        "UPDATE sign_requests SET current_hash = ?1, status = 'completed' WHERE id = ?2",
        params![seal::hash_hex(&mid), d.summary.id],
    );
    assert_eq!(
        f.ctx().verify_file(&mid).unwrap().state,
        VerifyState::MatchVersion
    );
}

#[test]
fn tampered_audit_records_are_invalid() {
    let mut f = fx();
    let me = f.me();
    f.save_signature();
    let d = f.create(std::slice::from_ref(&me), "sequential");
    let id = d.summary.id.clone();
    f.sign(&d, &stamped(&id, 1)).unwrap();

    f.exec(
        "UPDATE sign_events SET actor_name = 'Orang Lain' WHERE kind = 'signed'",
        [],
    );
    let d = f.ctx().get_request(&id).unwrap();
    let valid: Vec<(&str, bool)> = d
        .events
        .iter()
        .map(|e| (e.kind.as_str(), e.valid))
        .collect();
    assert_eq!(
        valid,
        [("created", true), ("signed", false), ("completed", true)]
    );
    // Catatan `signed` yang tidak sah memutus rantai.
    assert_eq!(d.seal_valid, Some(false));
    assert_eq!(
        f.ctx().verify_file(&stamped(&id, 1)).unwrap().state,
        VerifyState::MatchVersion
    );

    f.exec(
        "UPDATE sign_events SET detail = '5 penanda tangan' WHERE kind = 'completed'",
        [],
    );
    let d = f.ctx().get_request(&id).unwrap();
    assert!(!d.events[2].valid);
    assert_eq!(d.seal_valid, Some(false));

    // Jenis yang tidak dikenal juga tidak sah, tetapi tetap tampil.
    f.exec(
        "UPDATE sign_events SET kind = 'aneh' WHERE kind = 'created'",
        [],
    );
    let d = f.ctx().get_request(&id).unwrap();
    assert_eq!(d.events[0].kind, "aneh");
    assert!(!d.events[0].valid);
}

#[test]
fn read_file_only_serves_versions_of_the_request() {
    let mut f = fx();
    let me = f.me();
    f.save_signature();
    let d = f.create(std::slice::from_ref(&me), "sequential");
    let id = d.summary.id.clone();
    let done = f.sign(&d, &stamped(&id, 1)).unwrap();
    let foreign = f.store.put(b"%PDF-1.7 dokumen lain").unwrap();

    let ctx = f.ctx();
    assert_eq!(
        ctx.read_file(&id, &done.original_hash).unwrap(),
        original_pdf()
    );
    assert_eq!(
        ctx.read_file(&id, &done.current_hash).unwrap(),
        stamped(&id, 1)
    );
    assert_eq!(code(ctx.read_file(&id, &foreign)), "not_found");
    assert_eq!(code(ctx.read_file(&id, &"a".repeat(64))), "not_found");
    assert_eq!(
        code(ctx.read_file(&"0".repeat(32), &done.original_hash)),
        "not_found"
    );
    f.store.remove(&done.original_hash);
    assert_eq!(
        code(f.ctx().read_file(&id, &done.original_hash)),
        "not_found"
    );
}

#[test]
fn cancel_rules() {
    let mut f = fx();
    let me = f.me();
    let budi = f.add_member(0xb3, "Budi Santoso", "member", "member", "active");
    f.save_signature();
    let d = f.create(&[budi.clone(), me.clone()], "parallel");
    let id = d.summary.id.clone();

    let c = f.ctx().cancel(&id, t(40)).unwrap();
    assert_eq!(c.summary.status.as_str(), "cancelled");
    assert_eq!(c.summary.my_state.as_str(), "not_involved");
    assert_eq!(kinds(&c), ["created", "cancelled"]);
    assert!(c.events.iter().all(|e| e.valid));
    assert!(f.outbox.calls().contains(&format!("cancelled:{id}")));
    assert_eq!(code(f.ctx().cancel(&id, t(41))), "request_closed");
    assert_eq!(code(f.sign(&c, &stamped(&id, 1))), "request_closed");

    let d = f.create(std::slice::from_ref(&me), "parallel");
    f.exec(
        "UPDATE sign_requests SET requested_by = ?1 WHERE id = ?2",
        params![budi, d.summary.id],
    );
    assert_eq!(code(f.ctx().cancel(&d.summary.id, t(42))), "not_requester");
    let d = f.ctx().get_request(&d.summary.id).unwrap();
    assert_eq!(d.requested_by.display_name, "Budi Santoso");
}

#[test]
fn overview_lists_latest_change_first() {
    let mut f = fx();
    let me = f.me();
    f.save_signature();
    let first = f.create(std::slice::from_ref(&me), "parallel");
    let hash = f.import(b"%PDF-1.7 kedua");
    let second = f
        .ctx()
        .create_request("Kedua", &hash, "parallel", std::slice::from_ref(&me), t(6))
        .unwrap();
    let ov = f.ctx().overview(t(1000)).unwrap();
    let ids: Vec<&str> = ov.requests.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, [second.summary.id.as_str(), first.summary.id.as_str()]);

    // Ditandatangani di t(10) lebih baru dari pembuatan permintaan kedua.
    f.sign(&first, &stamped(&first.summary.id, 1)).unwrap();
    let ov = f.ctx().overview(t(1000)).unwrap();
    assert_eq!(ov.requests[0].id, first.summary.id);
}

fn keys(v: &serde_json::Value) -> BTreeSet<String> {
    v.as_object().unwrap().keys().cloned().collect()
}

fn set(names: &[&str]) -> BTreeSet<String> {
    names.iter().map(|s| (*s).to_owned()).collect()
}

#[test]
fn json_uses_contract_field_names() {
    let mut f = fx();
    let me = f.me();
    f.save_signature();
    let d = f.create(std::slice::from_ref(&me), "sequential");
    let id = d.summary.id.clone();
    f.sign(&d, &stamped(&id, 1)).unwrap();
    f.ctx().export(&id, t(30)).unwrap();
    let done = f.ctx().get_request(&id).unwrap();

    let summary_keys = [
        "id",
        "title",
        "mode",
        "status",
        "myState",
        "signedCount",
        "signerCount",
        "createdAt",
        "updatedAt",
        "completedAt",
        "integrity",
        "exportWarnings",
        "fromPeer",
        "requestedByName",
        "fileAvailable",
        "fileSize",
        "pending",
    ];
    let mut detail_keys = summary_keys.to_vec();
    detail_keys.extend([
        "requestedBy",
        "originalHash",
        "currentHash",
        "signers",
        "events",
        "exports",
        "isLastPending",
        "docTag",
        "sealValid",
        "scope",
        "rejected",
    ]);
    let j = serde_json::to_value(&done).unwrap();
    assert_eq!(keys(&j), set(&detail_keys));
    assert_eq!(keys(&j["requestedBy"]), set(&["publicKey", "displayName"]));
    assert_eq!(
        keys(&j["signers"][0]),
        set(&[
            "position",
            "publicKey",
            "displayName",
            "kind",
            "status",
            "signedAt",
            "hashAfter",
            "isMe",
            "canSignNow"
        ])
    );
    assert_eq!(
        keys(&j["events"][0]),
        set(&[
            "kind",
            "actorKey",
            "actorName",
            "at",
            "hashBefore",
            "hashAfter",
            "detail",
            "valid"
        ])
    );
    assert_eq!(
        keys(&j["exports"][0]),
        set(&["path", "exportedAt", "state"])
    );
    assert_eq!(j["mode"], "sequential");
    assert_eq!(j["status"], "completed");
    assert_eq!(j["myState"], "signed");
    assert_eq!(j["integrity"], "intact");
    assert_eq!(j["sealValid"], true);
    assert_eq!(j["signers"][0]["kind"], "member");
    assert_eq!(j["signers"][0]["status"], "signed");
    assert_eq!(j["exports"][0]["state"], "intact");
    assert_eq!(j["events"][1]["kind"], "signed");
    assert_eq!(keys(&j["scope"]), set(&["teamId", "projectId"]));
    assert_eq!(j["scope"]["projectId"], serde_json::Value::Null);
    assert_eq!(j["rejected"], serde_json::json!([]));
    assert_eq!(j["fromPeer"], false);
    assert_eq!(j["requestedByName"], "Sari Dewi");
    assert_eq!(j["fileAvailable"], true);
    assert_eq!(j["fileSize"], stamped(&id, 1).len());
    assert_eq!(j["pending"], false);

    let ov = serde_json::to_value(f.ctx().overview(t(1000)).unwrap()).unwrap();
    assert_eq!(keys(&ov), set(&["saved", "requests", "canRequest", "me"]));
    assert_eq!(keys(&ov["me"]), set(&["publicKey", "displayName", "kind"]));
    assert_eq!(keys(&ov["requests"][0]), set(&summary_keys));
    assert_eq!(
        keys(&ov["saved"]),
        set(&[
            "width",
            "height",
            "createdAt",
            "failedAttempts",
            "lockedUntil",
            "attemptsLeft",
            "usableAfter"
        ])
    );
    assert_eq!(ov["saved"]["usableAfter"], serde_json::Value::Null);

    let c = serde_json::to_value(f.ctx().list_candidates().unwrap()).unwrap();
    assert_eq!(
        keys(&c[0]),
        set(&["publicKey", "displayName", "kind", "isMe"])
    );

    let u = serde_json::to_value(f.ctx().unlock(PIN, t(50)).unwrap()).unwrap();
    assert_eq!(
        keys(&u),
        set(&["token", "pngBase64", "signedAt", "width", "height"])
    );

    let i = serde_json::to_value(f.ctx().import_pdf(&original_pdf(), "a.pdf").unwrap()).unwrap();
    assert_eq!(
        keys(&i),
        set(&["fileHash", "size", "fileName", "pageCount"])
    );
    assert_eq!(i["pageCount"], serde_json::Value::Null);

    let v = serde_json::to_value(f.ctx().verify_file(&stamped(&id, 1)).unwrap()).unwrap();
    assert_eq!(
        keys(&v),
        set(&[
            "state",
            "fileHash",
            "requestId",
            "title",
            "completedAt",
            "signers"
        ])
    );
    assert_eq!(v["state"], "match_final");
    assert_eq!(keys(&v["signers"][0]), set(&["displayName", "signedAt"]));

    let e = serde_json::to_value(f.ctx().export(&id, t(60)).unwrap()).unwrap();
    assert_eq!(keys(&e), set(&["path"]));

    let in_progress = f.create(std::slice::from_ref(&me), "parallel");
    let j = serde_json::to_value(&in_progress).unwrap();
    assert_eq!(j["sealValid"], serde_json::Value::Null);
    assert_eq!(j["completedAt"], serde_json::Value::Null);
}

#[test]
fn signing_sources_have_no_em_dash() {
    let sources = [
        include_str!("service.rs"),
        include_str!("commands.rs"),
        include_str!("session.rs"),
        include_str!("outbox.rs"),
        include_str!("repo.rs"),
        include_str!("vault.rs"),
        include_str!("seal.rs"),
        include_str!("store.rs"),
        include_str!("peer_sync.rs"),
        include_str!("sync_tests.rs"),
    ];
    for src in sources {
        assert!(!src.contains('\u{2014}'));
    }
    let e: AppError = super::err("x", "y");
    assert_eq!(e.code(), "x");
}

// ---------------------------------------------------------------------------
// Perbaikan review keamanan.
// ---------------------------------------------------------------------------

fn other_identity() -> (tempfile::TempDir, Identity) {
    let dir = tempfile::tempdir().unwrap();
    let conn = db::open(dir.path()).unwrap();
    let id = identity::ensure_identity(&conn, &MemoryKeyStore::new()).unwrap();
    (dir, id)
}

fn png_b64() -> String {
    BASE64.encode(&tiny_png(300, 100))
}

impl Fx {
    /// Menyisipkan catatan yang ditandatangani `signer` (sah secara
    /// kriptografi, tetapi belum tentu bagian rantai yang benar).
    fn forge(&self, signer: &Identity, rec: EventRecord) {
        let sig = seal::sign_event(signer, &rec).unwrap();
        repo::insert_event(&self.conn, &rec, &sig).unwrap();
    }

    fn completed_single(&mut self) -> RequestDetail {
        let me = self.me();
        self.save_signature();
        let d = self.create(std::slice::from_ref(&me), "sequential");
        let done = self.sign(&d, &stamped(&d.summary.id, 1)).unwrap();
        assert_eq!(done.seal_valid, Some(true));
        done
    }
}

fn rec(
    actor: &Identity,
    request_id: &str,
    kind: EventKind,
    before: Option<&str>,
    after: Option<&str>,
) -> EventRecord {
    EventRecord {
        request_id: Some(request_id.to_owned()),
        kind,
        actor: actor.public_key_hex().to_owned(),
        actor_name: "Pemalsu".into(),
        at: clock::format_rfc3339(t(15)),
        hash_before: before.map(str::to_owned),
        hash_after: after.map(str::to_owned),
        detail: String::new(),
    }
}

#[test]
fn delete_without_pin_cools_new_signature_and_shows_in_request() {
    let mut f = fx();
    let me = f.me();
    f.save_signature();
    let d = f.create(std::slice::from_ref(&me), "sequential");
    let id = d.summary.id.clone();
    let budi = f.add_member(0xb4, "Budi Santoso", "member", "member", "active");
    let others = f.create(std::slice::from_ref(&budi), "parallel");

    // Rekan menghapus tanpa PIN, lalu membuat tanda tangan dengan PIN-nya.
    f.ctx().delete_signature(None, t(30)).unwrap();
    let info = f.ctx().save_signature("999999", &png_b64(), t(40)).unwrap();
    let until = t(30) + Duration::hours(24);
    assert_eq!(info.usable_after, Some(clock::format_rfc3339(until)));
    assert_eq!(
        f.ctx().overview(t(41)).unwrap().saved.unwrap().usable_after,
        info.usable_after
    );
    let err = f.ctx().unlock("999999", t(50)).unwrap_err();
    assert_eq!(err.code(), "signature_cooling");
    assert!(err.to_string().contains("sekitar 24 jam lagi"), "{err}");

    // Menghapus dengan PIN barunya lalu membuat lagi tidak menghapus masa tunggu.
    f.ctx().delete_signature(Some("999999"), t(60)).unwrap();
    let info = f.ctx().save_signature("999999", &png_b64(), t(70)).unwrap();
    assert_eq!(info.usable_after, Some(clock::format_rfc3339(until)));
    assert_eq!(code(f.ctx().unlock("999999", t(80))), "signature_cooling");

    // Pengirim melihat semua penggantian di jejak audit permintaan, urut waktu.
    let d = f.ctx().get_request(&id).unwrap();
    let seen: Vec<(&str, &str)> = d
        .events
        .iter()
        .map(|e| (e.kind.as_str(), e.detail.as_str()))
        .collect();
    assert_eq!(
        seen,
        [
            ("created", "berurutan, 1 penanda tangan"),
            (
                "signature_deleted",
                "tanpa PIN (lupa PIN), masa tunggu 24 jam"
            ),
            (
                "signature_saved",
                "300x100 piksel, masa tunggu 24 jam karena tanda tangan lama dihapus tanpa PIN"
            ),
            ("signature_deleted", "dengan PIN"),
            (
                "signature_saved",
                "300x100 piksel, masa tunggu 24 jam karena tanda tangan lama dihapus tanpa PIN"
            ),
        ]
    );
    assert!(d.events.iter().all(|e| e.valid));
    // Permintaan yang tidak melibatkan laptop ini tidak menampilkannya.
    assert_eq!(
        kinds(&f.ctx().get_request(&others.summary.id).unwrap()),
        ["created"]
    );

    // Setelah masa tunggu habis, tanda tangan bisa dipakai dan tercatat di
    // antara catatan penggantian sesuai waktunya.
    let unlocked = f.ctx().unlock("999999", until).unwrap();
    let done = f
        .ctx()
        .complete(
            &id,
            &unlocked.token,
            &d.current_hash,
            &stamped(&id, 1),
            until,
        )
        .unwrap();
    assert_eq!(
        kinds(&done),
        [
            "created",
            "signature_deleted",
            "signature_saved",
            "signature_deleted",
            "signature_saved",
            "signed",
            "completed"
        ]
    );
    assert_eq!(done.seal_valid, Some(true));
}

#[test]
fn delete_with_wrong_pin_counts_and_keeps_signature() {
    let mut f = fx();
    f.save_signature();
    let err = f.ctx().delete_signature(Some("000000"), t(1)).unwrap_err();
    assert_eq!(err.code(), "pin_wrong");
    assert_eq!(
        err.to_string(),
        "PIN salah. Sisa 4 kali lagi sebelum dikunci sementara."
    );
    assert_eq!(
        code(f.ctx().delete_signature(Some("12"), t(1))),
        "pin_invalid"
    );
    let saved = f.ctx().overview(t(2)).unwrap().saved.unwrap();
    assert_eq!(saved.failed_attempts, 1);

    f.ctx().delete_signature(Some(PIN), t(3)).unwrap();
    assert!(f.ctx().overview(t(3)).unwrap().saved.is_none());
    let info = f.ctx().save_signature(PIN, &png_b64(), t(4)).unwrap();
    assert_eq!(info.usable_after, None);
    assert!(f.ctx().unlock(PIN, t(5)).is_ok());
}

#[test]
fn removed_laptop_cannot_act() {
    let mut f = fx();
    let me = f.me();
    f.save_signature();
    let d = f.create(std::slice::from_ref(&me), "parallel");
    f.exec(
        "UPDATE members SET status = 'removed' WHERE public_key = ?1",
        params![me],
    );
    assert_eq!(code(f.ctx().cancel(&d.summary.id, t(10))), "removed");
    assert_eq!(code(f.ctx().unlock(PIN, t(10))), "removed");
    assert_eq!(code(f.ctx().delete_signature(None, t(10))), "removed");
    assert_eq!(code(f.ctx().delete_signature(Some(PIN), t(10))), "removed");
    assert_eq!(
        code(f.ctx().save_signature(PIN, &png_b64(), t(10))),
        "removed"
    );
    // Tidak ada yang berubah.
    assert!(f.ctx().overview(t(11)).unwrap().saved.is_some());
    assert_eq!(
        f.ctx().get_request(&d.summary.id).unwrap().summary.status,
        RequestStatus::InProgress
    );
}

#[test]
fn seal_rejects_completed_from_a_non_signer() {
    let mut f = fx();
    let done = f.completed_single();
    let id = done.summary.id.clone();
    let (_dir, other) = other_identity();
    f.forge(
        &other,
        rec(
            &other,
            &id,
            EventKind::Completed,
            None,
            Some(&done.current_hash),
        ),
    );
    let d = f.ctx().get_request(&id).unwrap();
    assert!(
        d.events.last().unwrap().valid,
        "tanda tangannya sendiri sah"
    );
    assert_eq!(d.seal_valid, Some(false));
    assert_eq!(
        f.ctx().verify_file(&stamped(&id, 1)).unwrap().state,
        VerifyState::MatchVersion
    );
}

#[test]
fn seal_rejects_broken_chain() {
    let (_dir, other) = other_identity();

    // `signed` dari kunci lain menggantikan catatan penanda tangan.
    let mut f = fx();
    let done = f.completed_single();
    let id = done.summary.id.clone();
    f.exec("DELETE FROM sign_events WHERE kind = 'signed'", []);
    f.forge(
        &other,
        rec(
            &other,
            &id,
            EventKind::Signed,
            Some(&done.original_hash),
            Some(&done.current_hash),
        ),
    );
    assert_eq!(f.ctx().get_request(&id).unwrap().seal_valid, Some(false));

    // `signed` sah dari penanda tangan, tetapi `hash_before` bukan versi asli.
    let mut f = fx();
    let done = f.completed_single();
    let id = done.summary.id.clone();
    f.exec("DELETE FROM sign_events WHERE kind = 'signed'", []);
    f.forge(
        &f.id,
        rec(
            &f.id,
            &id,
            EventKind::Signed,
            Some(&"a".repeat(64)),
            Some(&done.current_hash),
        ),
    );
    assert_eq!(f.ctx().get_request(&id).unwrap().seal_valid, Some(false));
    // Catatan yang benar mengembalikan rantai.
    f.exec("DELETE FROM sign_events WHERE kind = 'signed'", []);
    f.forge(
        &f.id,
        rec(
            &f.id,
            &id,
            EventKind::Signed,
            Some(&done.original_hash),
            Some(&done.current_hash),
        ),
    );
    assert_eq!(f.ctx().get_request(&id).unwrap().seal_valid, Some(true));

    // `created` dari kunci selain pengirim.
    f.exec("DELETE FROM sign_events WHERE kind = 'created'", []);
    f.forge(
        &other,
        rec(
            &other,
            &id,
            EventKind::Created,
            None,
            Some(&done.original_hash),
        ),
    );
    assert_eq!(f.ctx().get_request(&id).unwrap().seal_valid, Some(false));

    // Status penanda tangan diubah langsung di database.
    let mut f = fx();
    let done = f.completed_single();
    let id = done.summary.id.clone();
    f.exec(
        "UPDATE sign_signers SET hash_after = ?1 WHERE request_id = ?2",
        params!["b".repeat(64), id],
    );
    assert_eq!(f.ctx().get_request(&id).unwrap().seal_valid, Some(false));
}

#[test]
fn seal_chain_follows_time_order_for_several_signers() {
    let mut f = fx();
    let me = f.me();
    let budi_id = other_identity();
    let budi = budi_id.1.public_key_hex().to_owned();
    f.exec(
        "INSERT INTO members (organization_id, public_key, display_name, role, added_at, status, kind)
         VALUES (?1, ?2, 'Budi Santoso', 'member', ?3, 'active', 'member')",
        params![f.org_id, budi, clock::format_rfc3339(t(0))],
    );
    f.save_signature();
    let d = f.create(&[budi.clone(), me.clone()], "parallel");
    let id = d.summary.id.clone();
    // Laptop ini menandatangani lebih dulu (versi 1).
    let v1 = f.sign(&d, &stamped(&id, 1)).unwrap();
    // Budi menandatangani versi 1 menjadi versi 2 (disimulasikan: catatan
    // dari kunci Budi, lalu baris permintaan diperbarui seperti sinkronisasi).
    let v2_bytes = stamped(&id, 2);
    let v2 = f.store.put(&v2_bytes).unwrap();
    let mut signed = rec(
        &budi_id.1,
        &id,
        EventKind::Signed,
        Some(&v1.current_hash),
        Some(&v2),
    );
    signed.at = clock::format_rfc3339(t(30));
    f.forge(&budi_id.1, signed);
    let mut completed = rec(&budi_id.1, &id, EventKind::Completed, None, Some(&v2));
    completed.at = clock::format_rfc3339(t(30));
    f.forge(&budi_id.1, completed);
    f.exec(
        "UPDATE sign_signers SET status = 'signed', signed_at = ?1, hash_after = ?2
         WHERE request_id = ?3 AND public_key = ?4",
        params![clock::format_rfc3339(t(30)), v2, id, budi],
    );
    f.exec(
        "UPDATE sign_requests SET status = 'completed', current_hash = ?1, completed_at = ?2 WHERE id = ?3",
        params![v2, clock::format_rfc3339(t(30)), id],
    );
    let d = f.ctx().get_request(&id).unwrap();
    assert_eq!(d.seal_valid, Some(true));

    let r = f.ctx().verify_file(&v2_bytes).unwrap();
    assert_eq!(r.state, VerifyState::MatchFinal);
    assert_eq!(r.signers.len(), 2);

    // Versi 1: hanya laptop ini yang sudah menandatangani, tanpa waktu selesai.
    let r = f.ctx().verify_file(&stamped(&id, 1)).unwrap();
    assert_eq!(r.state, VerifyState::MatchVersion);
    assert_eq!(r.completed_at, None);
    let names: Vec<&str> = r.signers.iter().map(|s| s.display_name.as_str()).collect();
    assert_eq!(names, ["Sari Dewi"]);
    assert_eq!(r.signers[0].signed_at, v1.signers[1].signed_at);

    // Versi asli: belum ada penanda tangan.
    let r = f.ctx().verify_file(&original_pdf()).unwrap();
    assert_eq!(r.state, VerifyState::MatchVersion);
    assert!(r.signers.is_empty());
    assert_eq!(r.completed_at, None);
}

#[test]
fn complete_accepts_old_tag_before_new_one() {
    let mut f = fx();
    let me = f.me();
    f.save_signature();
    let d = f.create(std::slice::from_ref(&me), "sequential");
    let id = d.summary.id.clone();
    let old = "f".repeat(32);
    let resaved = pdf::stamp(
        &pdf::stamp(&original_pdf(), &seal::doc_tag(&old)),
        &seal::doc_tag(&id),
    );
    assert_eq!(seal::find_mira_doc_id(&resaved), Some(old.clone()));
    let done = f.sign(&d, &resaved).unwrap();
    assert_eq!(done.summary.status, RequestStatus::Completed);

    // Periksa file: penanda lama (tidak dikenal) di depan tidak menghalangi.
    let mut changed = resaved.clone();
    changed.extend_from_slice(b"% diubah\n");
    let r = f.ctx().verify_file(&changed).unwrap();
    assert_eq!(r.state, VerifyState::Changed);
    assert_eq!(r.request_id.as_deref(), Some(id.as_str()));
}

#[test]
fn complete_requires_intact_base_version() {
    let mut f = fx();
    let me = f.me();
    f.save_signature();
    let d = f.create(std::slice::from_ref(&me), "sequential");
    let id = d.summary.id.clone();

    f.store.tamper(&d.current_hash, b"%PDF-1.7 diganti");
    let err = f.sign(&d, &stamped(&id, 1)).unwrap_err();
    assert_eq!(err.code(), "pdf_invalid");
    assert!(err.to_string().contains("sudah berubah"), "{err}");

    f.store.remove(&d.current_hash);
    let err = f.sign(&d, &stamped(&id, 1)).unwrap_err();
    assert_eq!(err.code(), "pdf_invalid");
    assert!(err.to_string().contains("tidak ditemukan"), "{err}");

    f.store.put(&original_pdf()).unwrap();
    assert!(f.sign(&d, &stamped(&id, 1)).is_ok());
}

#[test]
fn signed_version_may_exceed_import_limit() {
    use super::store::{MAX_PDF_BYTES, MAX_SIGNED_PDF_BYTES};
    let mut f = fx();
    let me = f.me();
    f.save_signature();
    let d = f.create(std::slice::from_ref(&me), "sequential");
    let id = d.summary.id.clone();

    let mut big = stamped(&id, 1);
    big.resize(MAX_PDF_BYTES + 1024, b' ');
    assert_eq!(code(f.ctx().import_pdf(&big, "besar.pdf")), "pdf_too_large");

    let mut too_big = stamped(&id, 1);
    too_big.resize(MAX_SIGNED_PDF_BYTES + 1, b' ');
    let err = f.sign(&d, &too_big).unwrap_err();
    assert_eq!(err.code(), "pdf_too_large");
    assert!(err.to_string().contains("100 MB"), "{err}");
    drop(too_big);

    let done = f.sign(&d, &big).unwrap();
    assert_eq!(done.summary.status, RequestStatus::Completed);
    assert_eq!(
        f.ctx().verify_file(&big).unwrap().state,
        VerifyState::MatchFinal
    );
}

#[test]
fn file_integrity_streams_and_skips_oversized_files() {
    use super::service::file_integrity;
    use super::store::MAX_SIGNED_PDF_BYTES;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a.pdf");
    std::fs::write(&path, b"%PDF-1.7 isi").unwrap();
    let h = seal::hash_hex(b"%PDF-1.7 isi");
    assert_eq!(file_integrity(&path, &h), seal::Integrity::Intact);
    assert_eq!(
        file_integrity(&path, &"0".repeat(64)),
        seal::Integrity::Changed
    );
    assert_eq!(
        file_integrity(&dir.path().join("tidak-ada.pdf"), &h),
        seal::Integrity::Missing
    );
    assert_eq!(file_integrity(dir.path(), &h), seal::Integrity::Missing);

    // Berkas jarang (sparse) yang lebih besar dari batas: berubah tanpa dibaca.
    let big = dir.path().join("besar.pdf");
    let file = std::fs::File::create(&big).unwrap();
    file.set_len(MAX_SIGNED_PDF_BYTES as u64 + 1).unwrap();
    drop(file);
    assert_eq!(file_integrity(&big, &h), seal::Integrity::Changed);
}

#[test]
fn unlock_result_debug_hides_secrets() {
    let mut f = fx();
    f.save_signature();
    let u = f.ctx().unlock(PIN, t(1)).unwrap();
    let shown = format!("{u:?}");
    assert!(!shown.contains(&u.token), "{shown}");
    assert!(!shown.contains(&u.png_base64), "{shown}");
    assert!(shown.contains("png_base64_len"), "{shown}");
}
