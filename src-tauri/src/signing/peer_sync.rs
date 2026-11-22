//! Sinkron tanda tangan dengan laptop rekan (`TOPIC_SIGN`). Rencana:
//! `docs/plans/sinkron-dokumen-ttd.md` bagian 5.
//!
//! **Record** (amplop `documents::envelope`, domain `mira-sign-sync-v1`,
//! payload JSON dengan field `t`):
//! - `request`: definisi permintaan + catatan audit `created`. Penulis =
//!   pengirim.
//! - `signed`: versi baru (hash sebelum dan sesudah, ukuran) + catatan
//!   `signed` (dan `completed` kalau terakhir). Penulis = penanda tangan.
//! - `cancelled`: catatan `cancelled`. Penulis = pengirim.
//!
//! Record milik laptop ini ditulis `service.rs` di transaksi yang sama dengan
//! perubahan lokal (`store_own`). Record dari rekan diperiksa di `ingest`,
//! disimpan di `sign_sync_records`, lalu keadaan permintaan dihitung ulang
//! (`fold`) dari semua record yang sah. Hasil fold hanya bergantung pada
//! record dan file yang dipegang, jadi sama di semua laptop yang memegang hal
//! yang sama.
//!
//! **Aturan fold** (urut):
//! 1. Mulai dari versi asli. Kandidat langkah = record `signed` dengan
//!    `hash_before` = versi sekarang, diurutkan menurut (waktu tanda tangan,
//!    kunci penanda tangan, id record).
//! 2. Setiap kandidat diperiksa terhadap keadaan sebelum langkah itu:
//!    `can_sign` (urutan berurutan ditegakkan) gagal -> `rejected` dengan
//!    pesan `can_sign`; sudah ada pemenang -> `rejected` "ditandatangani
//!    bersamaan"; file versi lama atau baru belum ada -> `pending`, fold
//!    berhenti di sini; catatan `completed` tidak sesuai, penanda dokumen
//!    tidak ada, atau `increment::check_increment` gagal -> `rejected` dengan
//!    pesannya. Kandidat pertama yang lolos menang.
//! 3. Record yang tersisa: dibangun di atas versi yang ditolak -> `rejected`;
//!    di atas versi dalam rantai (misalnya setelah selesai) -> `rejected`
//!    dengan pesan `can_sign`; selain itu -> `pending` (versi sebelumnya
//!    belum sampai).
//! 4. `cancelled` dari pengirim berlaku hanya kalau rantai tidak selesai
//!    (tidak ada catatan `completed` yang sah). Kalau selesai, pembatalan
//!    `rejected`.
//! 5. Baris `sign_requests`, `sign_signers`, dan catatan audit
//!    (`created`/`signed`/`completed`/`cancelled`) ditulis ulang persis dari
//!    record yang `ok`; catatan lain (misalnya `exported`) tidak disentuh.
//!
//! **Pengirim**: record satu permintaan hanya ditawarkan ke pengirim dan
//! penanda tangannya yang anggota aktif; Tamu hanya kalau proyek permintaan
//! diizinkan untuknya (`GuestProjects`). Disaring ulang di `records_for`.
//! File versi (`BlobSource`) dengan aturan yang sama.
//!
//! **File**: setelah `ingest`, file versi sampai 20 MB yang belum ada diminta
//! lewat `FileFetcher` (aplikasi: `HubFetcher`, lewat
//! `FeatureHub::fetch_blob`), dan diulang saat rekan tersambung. File lebih
//! besar diunduh dengan perintah `sign_download_file`.
//!
//! **Notifikasi**: "Giliran Anda menandatangani: <judul>" sekali per
//! (permintaan, versi) lewat `sign_notified`, saat giliran laptop ini tiba
//! dan file versinya sudah ada.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use super::err;
use super::increment;
use super::repo::{self, RequestScope};
use super::request::{
    self, NewRequest, RequestStatus, Requester, SignMode, SignRequest, Signer, SignerInput,
    SignerKind, SignerStatus,
};
use super::seal::{self, EventKind, EventRecord};
use super::service::parse_at;
use super::store::{BlobDocumentStore, DocumentStore, MAX_PDF_BYTES, MAX_SIGNED_PDF_BYTES};
use crate::blobs::{AUTO_REPLICATE_MAX_BYTES, BlobHash};
use crate::board::reminder::Notifier;
use crate::clock;
use crate::documents::envelope::{self, SIGN_DOMAIN};
use crate::documents::scope::{GuestProjects, may_write};
use crate::documents::store::DocScope;
use crate::error::{AppError, AppResult};
use crate::identity::Identity;
use crate::network::feature::{BlobSource, FeatureIngest, FeatureRecord, FeatureSync, TOPIC_SIGN};
use crate::org::is_lower_hex;
use crate::permissions::{self, MemberKind, OrgState};
use crate::state::MiraState;

/// Judul notifikasi giliran.
pub const TURN_TITLE: &str = "Giliran Anda menandatangani";

/// Subfolder `data_dir` untuk file yang sedang diunduh dari rekan.
pub const DOWNLOAD_FOLDER: &str = "ttd-unduhan";

/// Kode di `rejected_changes` untuk record tanda tangan yang ditolak.
const REJECT_CODE: &str = "sign_rejected";

const STATE_OK: &str = "ok";
const STATE_PENDING: &str = "pending";
const STATE_REJECTED: &str = "rejected";

// ---------------------------------------------------------------------------
// Bentuk record.
// ---------------------------------------------------------------------------

/// Satu catatan jejak audit beserta tanda tangan pelakunya, di dalam record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireEvent {
    pub kind: String,
    pub actor: String,
    pub actor_name: String,
    pub at: String,
    pub hash_before: Option<String>,
    pub hash_after: Option<String>,
    pub detail: String,
    pub sig: String,
}

impl WireEvent {
    pub fn new(rec: &EventRecord, sig: &str) -> Self {
        Self {
            kind: rec.kind.as_str().to_owned(),
            actor: rec.actor.clone(),
            actor_name: rec.actor_name.clone(),
            at: rec.at.clone(),
            hash_before: rec.hash_before.clone(),
            hash_after: rec.hash_after.clone(),
            detail: rec.detail.clone(),
            sig: sig.to_owned(),
        }
    }

    fn record(&self, request_id: &str) -> Option<EventRecord> {
        Some(EventRecord {
            request_id: Some(request_id.to_owned()),
            kind: EventKind::parse(&self.kind)?,
            actor: self.actor.clone(),
            actor_name: self.actor_name.clone(),
            at: self.at.clone(),
            hash_before: self.hash_before.clone(),
            hash_after: self.hash_after.clone(),
            detail: self.detail.clone(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireSigner {
    pub public_key: String,
    pub display_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestPayload {
    pub id: String,
    pub title: String,
    pub mode: SignMode,
    pub requested_by: String,
    pub team_id: Option<String>,
    pub project_id: Option<String>,
    pub original_hash: String,
    pub original_size: u64,
    pub created_at: String,
    /// Urutan = urutan tanda tangan untuk mode berurutan.
    pub signers: Vec<WireSigner>,
    pub created: WireEvent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedPayload {
    pub request_id: String,
    pub hash_before: String,
    pub hash_after: String,
    pub size: u64,
    pub signed: WireEvent,
    pub completed: Option<WireEvent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelledPayload {
    pub request_id: String,
    pub cancelled: WireEvent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Payload {
    Request(RequestPayload),
    Signed(SignedPayload),
    Cancelled(CancelledPayload),
}

impl Payload {
    pub fn kind(&self) -> &'static str {
        match self {
            Payload::Request(_) => "request",
            Payload::Signed(_) => "signed",
            Payload::Cancelled(_) => "cancelled",
        }
    }

    pub fn request_id(&self) -> &str {
        match self {
            Payload::Request(p) => &p.id,
            Payload::Signed(p) => &p.request_id,
            Payload::Cancelled(p) => &p.request_id,
        }
    }
}

/// Menandatangani `payload` dengan kunci laptop ini dan menyimpannya sebagai
/// record `ok`. Dipanggil `service.rs` di dalam transaksi perubahan lokal.
pub fn store_own(
    conn: &Connection,
    identity: &Identity,
    payload: &Payload,
    at: &str,
) -> AppResult<String> {
    let rec = envelope::seal(identity, SIGN_DOMAIN, payload).map_err(AppError::Internal)?;
    insert_record(
        conn,
        &rec,
        payload,
        identity.public_key_hex(),
        STATE_OK,
        at,
        None,
    )?;
    Ok(rec.id)
}

fn insert_record(
    conn: &Connection,
    rec: &FeatureRecord,
    payload: &Payload,
    author: &str,
    state: &str,
    created_at: &str,
    received_at: Option<&str>,
) -> AppResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO sign_sync_records
             (id, kind, request_id, author, body, state, reason, created_at, received_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7, ?8)",
        params![
            rec.id,
            payload.kind(),
            payload.request_id(),
            author,
            rec.body,
            state,
            created_at,
            received_at
        ],
    )?;
    Ok(())
}

/// Hasil bukti stempel `before -> after` dicatat di `sign_proof_checks`.
pub fn cache_proof(
    conn: &Connection,
    before: &str,
    after: &str,
    result: Result<(), &str>,
    at: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO sign_proof_checks (hash_before, hash_after, ok, reason, checked_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            before,
            after,
            result.is_ok(),
            result.err().unwrap_or_default(),
            at
        ],
    )?;
    Ok(())
}

fn cached_proof(conn: &Connection, before: &str, after: &str) -> AppResult<Option<(bool, String)>> {
    Ok(conn
        .query_row(
            "SELECT ok, reason FROM sign_proof_checks WHERE hash_before = ?1 AND hash_after = ?2",
            params![before, after],
            |r| Ok((r.get::<_, bool>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?)
}

// ---------------------------------------------------------------------------
// Membaca record tersimpan.
// ---------------------------------------------------------------------------

struct Stored {
    id: String,
    author: String,
    state: String,
    payload: Payload,
}

fn open_body(id: String, body: String) -> Option<(String, Payload)> {
    let rec = FeatureRecord { id, body };
    envelope::open::<Payload>(SIGN_DOMAIN, &rec)
        .ok()
        .map(|o| (o.author, o.payload))
}

fn load_records(conn: &Connection, request_id: &str) -> AppResult<Vec<Stored>> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, body, state FROM sign_sync_records WHERE request_id = ?1 ORDER BY id",
    )?;
    let rows = stmt
        .query_map(params![request_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, body, state)| {
            let (author, payload) = open_body(id.clone(), body)?;
            (payload.request_id() == request_id).then_some(Stored {
                id,
                author,
                state,
                payload,
            })
        })
        .collect())
}

/// Record `request` pertama (menurut id) untuk permintaan itu.
fn request_payload(conn: &Connection, request_id: &str) -> AppResult<Option<RequestPayload>> {
    let rows: Vec<(String, String)> = conn
        .prepare_cached(
            "SELECT id, body FROM sign_sync_records WHERE request_id = ?1 AND kind = 'request' ORDER BY id",
        )?
        .query_map(params![request_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (id, body) in rows {
        if let Some((_, Payload::Request(p))) = open_body(id, body) {
            return Ok(Some(p));
        }
    }
    Ok(None)
}

/// Semua permintaan yang punya record `request`.
fn all_requests(conn: &Connection) -> AppResult<Vec<RequestPayload>> {
    let ids: Vec<String> = conn
        .prepare("SELECT DISTINCT request_id FROM sign_sync_records WHERE kind = 'request'")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut out = Vec::new();
    for id in ids {
        if let Some(p) = request_payload(conn, &id)? {
            out.push(p);
        }
    }
    Ok(out)
}

fn record_exists(conn: &Connection, id: &str) -> AppResult<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM sign_sync_records WHERE id = ?1",
            params![id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// Ada record permintaan ini yang menunggu (file atau versi sebelumnya).
pub fn has_pending(conn: &Connection, request_id: &str) -> AppResult<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM sign_sync_records WHERE request_id = ?1 AND state = 'pending' LIMIT 1",
            params![request_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// Ukuran versi `hash` menurut record permintaan ini (untuk file yang belum
/// diunduh).
pub fn known_size(conn: &Connection, request_id: &str, hash: &str) -> AppResult<Option<u64>> {
    for r in load_records(conn, request_id)? {
        match &r.payload {
            Payload::Request(p) if p.original_hash == hash => return Ok(Some(p.original_size)),
            Payload::Signed(p) if p.hash_after == hash => return Ok(Some(p.size)),
            _ => {}
        }
    }
    Ok(None)
}

/// Versi yang ditolak (di layar "versi ditolak").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RejectedVersion {
    pub signer: String,
    pub at: String,
    pub reason: String,
}

pub fn rejected_versions(conn: &Connection, request_id: &str) -> AppResult<Vec<RejectedVersion>> {
    let reasons: HashMap<String, String> = conn
        .prepare_cached(
            "SELECT id, reason FROM sign_sync_records
             WHERE request_id = ?1 AND kind = 'signed' AND state = 'rejected'",
        )?
        .query_map(params![request_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut out: Vec<RejectedVersion> = load_records(conn, request_id)?
        .into_iter()
        .filter_map(|r| {
            let reason = reasons.get(&r.id)?.clone();
            let Payload::Signed(p) = r.payload else {
                return None;
            };
            Some(RejectedVersion {
                signer: r.author,
                at: p.signed.at,
                reason,
            })
        })
        .collect();
    out.sort_by(|a, b| (parse_at(&a.at), &a.signer).cmp(&(parse_at(&b.at), &b.signer)));
    Ok(out)
}

// ---------------------------------------------------------------------------
// Aturan cakupan (dipakai pembuatan lokal dan record yang diterima).
// ---------------------------------------------------------------------------

fn scope_of(scope: &RequestScope) -> DocScope {
    DocScope {
        team_id: scope.team_id.clone(),
        project_id: scope.project_id.clone(),
    }
}

fn is_guest(state: &OrgState, pk: &str) -> bool {
    state
        .member(pk)
        .is_some_and(|m| m.kind == MemberKind::Guest)
}

fn kind_of(state: Option<&OrgState>, pk: &str) -> SignerKind {
    match state {
        Some(s) if is_guest(s, pk) => SignerKind::Guest,
        _ => SignerKind::Member,
    }
}

/// Aturan tim, proyek, dan Tamu untuk permintaan baru:
/// - id tim dan proyek (kalau ada) 32 hex huruf kecil;
/// - kalau ada cakupan, pengirim boleh menulis di sana (`may_write`);
/// - penanda tangan Tamu hanya kalau permintaan punya proyek yang diizinkan
///   untuknya (`GuestProjects`).
pub fn check_scope_rules(
    conn: &Connection,
    state: Option<&OrgState>,
    guests: &dyn GuestProjects,
    requester: &str,
    signers: &[SignerInput],
    scope: &RequestScope,
) -> AppResult<()> {
    for id in [&scope.team_id, &scope.project_id].into_iter().flatten() {
        if !is_lower_hex(id, 32) {
            return Err(err(
                "request_invalid",
                "Tim atau proyek permintaan tidak valid. Pilih ulang proyeknya.",
            ));
        }
    }
    let scoped = scope.team_id.is_some() || scope.project_id.is_some();
    if scoped {
        let allowed = match state {
            Some(s) => may_write(conn, s, guests, requester, &scope_of(scope))?,
            None => false,
        };
        if !allowed {
            return Err(err(
                "request_invalid",
                "Pengirim tidak termasuk tim proyek ini, jadi tidak bisa meminta tanda tangan di proyek itu.",
            ));
        }
    }
    for s in signers.iter().filter(|s| s.kind == SignerKind::Guest) {
        let allowed = match (state, scope.project_id.as_deref()) {
            (Some(st), Some(project)) => guests.guest_may_access(
                conn,
                st,
                &s.public_key,
                scope.team_id.as_deref(),
                project,
            )?,
            _ => false,
        };
        if !allowed {
            return Err(err(
                "request_invalid",
                format!(
                    "{} adalah Tamu. Tamu hanya bisa menandatangani dokumen di proyek yang diizinkan untuknya. Pilih proyek itu untuk permintaan ini, atau hapus {} dari daftar penanda tangan.",
                    s.display_name.trim(),
                    s.display_name.trim()
                ),
            ));
        }
    }
    Ok(())
}

/// `pk` boleh menerima data permintaan ini: pengirim atau penanda tangan yang
/// anggota aktif; Tamu hanya kalau proyeknya diizinkan.
fn involved(
    conn: &Connection,
    state: &OrgState,
    guests: &dyn GuestProjects,
    pk: &str,
    p: &RequestPayload,
) -> AppResult<bool> {
    if !state.is_active(pk) {
        return Ok(false);
    }
    if pk != p.requested_by && !p.signers.iter().any(|s| s.public_key == pk) {
        return Ok(false);
    }
    if is_guest(state, pk) {
        return match p.project_id.as_deref() {
            Some(project) => {
                guests.guest_may_access(conn, state, pk, p.team_id.as_deref(), project)
            }
            None => Ok(false),
        };
    }
    Ok(true)
}

// ---------------------------------------------------------------------------
// Pemeriksaan record yang diterima.
// ---------------------------------------------------------------------------

type Check<T> = Result<T, String>;

fn check_event(
    ev: &WireEvent,
    want: EventKind,
    author: &str,
    request_id: &str,
) -> Check<EventRecord> {
    if ev.kind != want.as_str() {
        return Err(format!("catatan audit harus berjenis {}", want.as_str()));
    }
    if ev.actor != author {
        return Err("pelaku catatan audit bukan penulis record".into());
    }
    let rec = ev
        .record(request_id)
        .ok_or_else(|| "catatan audit rusak".to_owned())?;
    if parse_at(&rec.at).is_none() {
        return Err("waktu catatan audit tidak valid".into());
    }
    if !seal::verify_event(&rec, &ev.sig) {
        return Err("tanda tangan catatan audit tidak sah".into());
    }
    Ok(rec)
}

fn check_hash(h: &str) -> Check<()> {
    if seal::is_hash_hex(h) {
        Ok(())
    } else {
        Err("hash versi tidak valid".into())
    }
}

fn check_request(
    conn: &Connection,
    state: &OrgState,
    guests: &dyn GuestProjects,
    author: &str,
    p: &RequestPayload,
) -> Check<()> {
    if !is_lower_hex(&p.id, 32) {
        return Err("id permintaan tidak valid".into());
    }
    if p.requested_by != author {
        return Err("pengirim permintaan bukan penulis record".into());
    }
    check_hash(&p.original_hash)?;
    if p.original_size == 0 || p.original_size > MAX_PDF_BYTES as u64 {
        return Err("ukuran file asli tidak valid".into());
    }
    if p.created_at != p.created.at {
        return Err("waktu permintaan tidak sama dengan catatan audit".into());
    }
    let created = check_event(&p.created, EventKind::Created, author, &p.id)?;
    if created.hash_after.as_deref() != Some(p.original_hash.as_str())
        || created.hash_before.is_some()
    {
        return Err("catatan audit dibuat tidak menunjuk file asli".into());
    }
    let requester = Requester {
        public_key: author.to_owned(),
        kind: kind_of(Some(state), author),
        active: state.is_active(author),
    };
    let mut signers = Vec::with_capacity(p.signers.len());
    for (i, s) in p.signers.iter().enumerate() {
        if !state.is_active(&s.public_key) {
            return Err(format!("penanda tangan ke-{} bukan anggota aktif", i + 1));
        }
        signers.push(SignerInput {
            public_key: s.public_key.clone(),
            display_name: s.display_name.clone(),
            kind: kind_of(Some(state), &s.public_key),
        });
    }
    let new = NewRequest {
        title: p.title.clone(),
        mode: p.mode,
        signers,
    };
    request::validate_new(&requester, &new).map_err(|e| e.to_string())?;
    if new.title.trim() != p.title {
        return Err("judul permintaan tidak rapi".into());
    }
    let scope = RequestScope {
        team_id: p.team_id.clone(),
        project_id: p.project_id.clone(),
    };
    check_scope_rules(conn, Some(state), guests, author, &new.signers, &scope)
        .map_err(|e| e.to_string())
}

fn check_signed(author: &str, p: &SignedPayload, req: Option<&RequestPayload>) -> Check<()> {
    if !is_lower_hex(&p.request_id, 32) {
        return Err("id permintaan tidak valid".into());
    }
    check_hash(&p.hash_before)?;
    check_hash(&p.hash_after)?;
    if p.hash_before == p.hash_after {
        return Err("versi baru sama dengan versi sebelumnya".into());
    }
    if p.size == 0 || p.size > MAX_SIGNED_PDF_BYTES as u64 {
        return Err("ukuran versi baru tidak valid".into());
    }
    let signed = check_event(&p.signed, EventKind::Signed, author, &p.request_id)?;
    if signed.hash_before.as_deref() != Some(p.hash_before.as_str())
        || signed.hash_after.as_deref() != Some(p.hash_after.as_str())
    {
        return Err("catatan audit ditandatangani tidak menunjuk versi record".into());
    }
    if let Some(done) = &p.completed {
        let done = check_event(done, EventKind::Completed, author, &p.request_id)?;
        if done.hash_after.as_deref() != Some(p.hash_after.as_str()) {
            return Err("catatan audit selesai tidak menunjuk versi record".into());
        }
    }
    if let Some(req) = req
        && !req.signers.iter().any(|s| s.public_key == author)
    {
        return Err("penulis bukan penanda tangan permintaan ini".into());
    }
    Ok(())
}

fn check_cancelled(author: &str, p: &CancelledPayload, req: Option<&RequestPayload>) -> Check<()> {
    if !is_lower_hex(&p.request_id, 32) {
        return Err("id permintaan tidak valid".into());
    }
    check_event(&p.cancelled, EventKind::Cancelled, author, &p.request_id)?;
    if let Some(req) = req
        && req.requested_by != author
    {
        return Err("hanya pengirim yang bisa membatalkan permintaan".into());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Fold.
// ---------------------------------------------------------------------------

/// File versi yang belum ada di laptop ini.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WantedFile {
    pub hash: String,
    pub size: u64,
    /// Laptop yang kemungkinan besar memegangnya, dicoba lebih dulu.
    pub prefer: Vec<String>,
}

#[derive(Debug, Default)]
struct FoldReport {
    /// Judul permintaan kalau giliran laptop ini baru tiba (notifikasi).
    turn: Option<String>,
}

enum Proof {
    Ok,
    Missing,
    Bad(String),
}

/// Isi file `hash` kalau ada dan utuh. File yang rusak dianggap belum ada.
fn read_verified(store: &dyn DocumentStore, hash: &str) -> AppResult<Option<Vec<u8>>> {
    Ok(store.get(hash)?.filter(|b| seal::hash_hex(b) == hash))
}

fn proof(
    conn: &Connection,
    store: &dyn DocumentStore,
    request_id: &str,
    before: &str,
    after: &str,
    now: &str,
) -> AppResult<Proof> {
    let Some(new) = read_verified(store, after)? else {
        return Ok(Proof::Missing);
    };
    let failed = match cached_proof(conn, before, after)? {
        Some((ok, reason)) => (!ok).then_some(reason),
        None => {
            let Some(old) = read_verified(store, before)? else {
                return Ok(Proof::Missing);
            };
            let reason = increment::check_increment(&old, &new)
                .err()
                .map(|e| e.message);
            cache_proof(
                conn,
                before,
                after,
                reason.as_deref().map_or(Ok(()), Err),
                now,
            )?;
            reason
        }
    };
    if let Some(reason) = failed {
        return Ok(Proof::Bad(reason));
    }
    // Penanda diperiksa setiap kali (tidak di-cache): pasangan hash yang sama
    // tidak boleh lolos untuk permintaan lain.
    if !seal::contains_doc_tag(&new, request_id) {
        return Ok(Proof::Bad(
            "File versi ini tidak memuat penanda dokumen Mira untuk permintaan ini.".into(),
        ));
    }
    Ok(Proof::Ok)
}

struct SignedRec<'a> {
    id: &'a str,
    author: &'a str,
    p: &'a SignedPayload,
    at: OffsetDateTime,
}

/// Menghitung ulang keadaan permintaan `request_id` dari record yang
/// tersimpan dan menulis hasilnya. Lihat aturan di dokumentasi modul.
fn fold(
    tx: &Transaction<'_>,
    store: &dyn DocumentStore,
    state: Option<&OrgState>,
    me: &str,
    request_id: &str,
    now: &str,
) -> AppResult<FoldReport> {
    let records = load_records(tx, request_id)?;
    let mut decision: BTreeMap<&str, (&'static str, String)> = BTreeMap::new();

    let Some((req_rec, rp)) = records.iter().find_map(|r| match &r.payload {
        Payload::Request(p) => Some((r, p)),
        _ => None,
    }) else {
        for r in &records {
            decision.insert(
                &r.id,
                (
                    STATE_PENDING,
                    "Menunggu data permintaan dari laptop rekan.".into(),
                ),
            );
        }
        write_decisions(tx, &decision)?;
        return Ok(FoldReport::default());
    };
    for r in &records {
        if matches!(r.payload, Payload::Request(_)) {
            let d = if r.id == req_rec.id {
                (STATE_OK, String::new())
            } else {
                (STATE_REJECTED, "Data permintaan ganda.".into())
            };
            decision.insert(&r.id, d);
        }
    }

    let mut req = SignRequest {
        id: rp.id.clone(),
        title: rp.title.trim().to_owned(),
        requested_by: rp.requested_by.clone(),
        mode: rp.mode,
        status: RequestStatus::InProgress,
        original_hash: rp.original_hash.clone(),
        current_hash: rp.original_hash.clone(),
        created_at: rp.created_at.clone(),
        updated_at: rp.created_at.clone(),
        completed_at: None,
        signers: rp
            .signers
            .iter()
            .enumerate()
            .map(|(i, s)| Signer {
                position: i as u32,
                public_key: s.public_key.clone(),
                display_name: s.display_name.trim().to_owned(),
                kind: kind_of(state, &s.public_key),
                status: SignerStatus::Waiting,
                signed_at: None,
                hash_after: None,
            })
            .collect(),
    };
    let mut events: Vec<(EventRecord, String)> = Vec::new();
    if let Some(created) = rp.created.record(&rp.id) {
        events.push((created, rp.created.sig.clone()));
    }
    let mut latest = (parse_at(&rp.created_at), rp.created_at.clone());

    // Record `signed`: periksa dasar, lalu rantai.
    let mut open: Vec<SignedRec<'_>> = Vec::new();
    for r in &records {
        let Payload::Signed(p) = &r.payload else {
            continue;
        };
        if !req.signers.iter().any(|s| s.public_key == r.author) {
            decision.insert(
                &r.id,
                (
                    STATE_REJECTED,
                    "Bukan penanda tangan permintaan ini.".into(),
                ),
            );
            continue;
        }
        let Some(at) = parse_at(&p.signed.at) else {
            decision.insert(
                &r.id,
                (STATE_REJECTED, "Waktu tanda tangan tidak valid.".into()),
            );
            continue;
        };
        open.push(SignedRec {
            id: &r.id,
            author: &r.author,
            p,
            at,
        });
    }

    let mut chain: Vec<String> = vec![req.original_hash.clone()];
    let mut stopped = false;
    while req.status == RequestStatus::InProgress {
        let current = req.current_hash.clone();
        let mut cands: Vec<&SignedRec<'_>> = open
            .iter()
            .filter(|s| s.p.hash_before == current && !decision.contains_key(s.id))
            .collect();
        if cands.is_empty() {
            break;
        }
        cands.sort_by(|a, b| (a.at, a.author, a.id).cmp(&(b.at, b.author, b.id)));
        let waiting = req
            .signers
            .iter()
            .filter(|s| s.status == SignerStatus::Waiting)
            .count();
        let mut winner: Option<&SignedRec<'_>> = None;
        for c in cands {
            if let Err(e) = req.can_sign(c.author) {
                decision.insert(c.id, (STATE_REJECTED, e.to_string()));
                continue;
            }
            if let Some(w) = winner {
                let name = signer_name(&req, w.author);
                decision.insert(
                    c.id,
                    (
                        STATE_REJECTED,
                        format!(
                            "Ditandatangani bersamaan dengan {name} pada versi yang sama. Versi {name} yang dipakai, jadi tanda tangani ulang versi terbaru."
                        ),
                    ),
                );
                continue;
            }
            if stopped {
                decision.insert(
                    c.id,
                    (
                        STATE_PENDING,
                        "Menunggu file versi lain diunduh dari laptop rekan.".into(),
                    ),
                );
                continue;
            }
            if c.p.completed.is_some() != (waiting == 1) {
                decision.insert(
                    c.id,
                    (
                        STATE_REJECTED,
                        "Catatan selesai tidak sesuai dengan jumlah penanda tangan yang tersisa."
                            .into(),
                    ),
                );
                continue;
            }
            match proof(tx, store, &req.id, &current, &c.p.hash_after, now)? {
                Proof::Missing => {
                    decision.insert(
                        c.id,
                        (
                            STATE_PENDING,
                            "Menunggu file versi ini diunduh dari laptop rekan.".into(),
                        ),
                    );
                    stopped = true;
                }
                Proof::Bad(reason) => {
                    decision.insert(c.id, (STATE_REJECTED, reason));
                }
                Proof::Ok => winner = Some(c),
            }
        }
        if stopped {
            break;
        }
        let Some(w) = winner else {
            break;
        };
        decision.insert(w.id, (STATE_OK, String::new()));
        req.record_signature(w.author, &w.p.signed.at, &w.p.hash_after)?;
        if let Some(rec) = w.p.signed.record(&req.id) {
            events.push((rec, w.p.signed.sig.clone()));
        }
        if let Some(done) = &w.p.completed
            && let Some(rec) = done.record(&req.id)
        {
            events.push((rec, done.sig.clone()));
        }
        if Some(w.at) > latest.0 {
            latest = (Some(w.at), w.p.signed.at.clone());
        }
        chain.push(w.p.hash_after.clone());
    }

    // Record yang belum diputuskan.
    loop {
        let rejected_after: HashSet<&str> = open
            .iter()
            .filter(|s| decision.get(s.id).is_some_and(|d| d.0 == STATE_REJECTED))
            .map(|s| s.p.hash_after.as_str())
            .collect();
        let mut progressed = false;
        for s in &open {
            if decision.contains_key(s.id) || !rejected_after.contains(s.p.hash_before.as_str()) {
                continue;
            }
            decision.insert(
                s.id,
                (
                    STATE_REJECTED,
                    "Ditandatangani di atas versi yang ditolak.".into(),
                ),
            );
            progressed = true;
        }
        if !progressed {
            break;
        }
    }
    for s in &open {
        if decision.contains_key(s.id) {
            continue;
        }
        let d = if !stopped && chain.contains(&s.p.hash_before) {
            let reason = req
                .can_sign(s.author)
                .err()
                .map(|e| e.to_string())
                .unwrap_or_else(|| "Versi ini sudah dilewati.".into());
            (STATE_REJECTED, reason)
        } else {
            (
                STATE_PENDING,
                "Menunggu versi sebelumnya dari laptop rekan.".into(),
            )
        };
        decision.insert(s.id, d);
    }

    // Pembatalan.
    let mut cancels: Vec<(&Stored, &CancelledPayload, Option<OffsetDateTime>)> = Vec::new();
    for r in &records {
        let Payload::Cancelled(p) = &r.payload else {
            continue;
        };
        if r.author != req.requested_by {
            decision.insert(
                &r.id,
                (
                    STATE_REJECTED,
                    "Hanya pengirim permintaan yang bisa membatalkannya.".into(),
                ),
            );
            continue;
        }
        cancels.push((r, p, parse_at(&p.cancelled.at)));
    }
    cancels.sort_by(|a, b| (a.2, &a.0.id).cmp(&(b.2, &b.0.id)));
    if req.status == RequestStatus::Completed {
        for (r, _, _) in &cancels {
            decision.insert(
                &r.id,
                (
                    STATE_REJECTED,
                    "Semua penanda tangan sudah menandatangani sebelum pembatalan sampai, jadi pembatalan tidak berlaku."
                        .into(),
                ),
            );
        }
    } else if let Some((_, p, at)) = cancels.first() {
        req.status = RequestStatus::Cancelled;
        if *at > latest.0 {
            latest = (*at, p.cancelled.at.clone());
        }
        if let Some(rec) = p.cancelled.record(&req.id) {
            events.push((rec, p.cancelled.sig.clone()));
        }
        for (r, _, _) in &cancels {
            decision.insert(&r.id, (STATE_OK, String::new()));
        }
    }
    req.updated_at = latest.1;

    // Tulis hasil.
    repo::save_request(tx, &req)?;
    repo::set_scope(
        tx,
        &req.id,
        &RequestScope {
            team_id: rp.team_id.clone(),
            project_id: rp.project_id.clone(),
        },
    )?;
    write_events(tx, &req.id, &events)?;
    write_decisions(tx, &decision)?;

    let mut report = FoldReport::default();
    if req.can_sign(me).is_ok() && store.contains(&req.current_hash)? {
        let n = tx.execute(
            "INSERT OR IGNORE INTO sign_notified (request_id, hash, notified_at) VALUES (?1, ?2, ?3)",
            params![req.id, req.current_hash, now],
        )?;
        if n == 1 {
            report.turn = Some(req.title.clone());
        }
    }
    Ok(report)
}

fn signer_name(req: &SignRequest, pk: &str) -> String {
    req.signers
        .iter()
        .find(|s| s.public_key == pk)
        .map(|s| s.display_name.clone())
        .unwrap_or_else(|| crate::identity::fingerprint(pk))
}

const SYNCED_KINDS: [EventKind; 4] = [
    EventKind::Created,
    EventKind::Signed,
    EventKind::Completed,
    EventKind::Cancelled,
];

/// Catatan audit sinkron di `sign_events` dibuat persis sama dengan
/// `events`: yang tidak ada dihapus, yang kurang ditambah (urut `events`).
fn write_events(
    tx: &Connection,
    request_id: &str,
    events: &[(EventRecord, String)],
) -> AppResult<()> {
    let key = |kind: &str, actor: &str, sig: &str| format!("{kind}\n{actor}\n{sig}");
    let wanted: HashSet<String> = events
        .iter()
        .map(|(r, s)| key(r.kind.as_str(), &r.actor, s))
        .collect();
    let mut have = HashSet::new();
    for e in repo::events_for(tx, request_id)? {
        if !SYNCED_KINDS.iter().any(|k| k.as_str() == e.kind) {
            continue;
        }
        let k = key(&e.kind, &e.actor, &e.sig);
        if wanted.contains(&k) && have.insert(k) {
            continue;
        }
        repo::delete_event(tx, e.id)?;
    }
    for (rec, sig) in events {
        if have.insert(key(rec.kind.as_str(), &rec.actor, sig)) {
            repo::insert_event(tx, rec, sig)?;
        }
    }
    Ok(())
}

fn write_decisions(
    tx: &Connection,
    decision: &BTreeMap<&str, (&'static str, String)>,
) -> AppResult<()> {
    let mut stmt =
        tx.prepare_cached("UPDATE sign_sync_records SET state = ?1, reason = ?2 WHERE id = ?3")?;
    for (id, (state, reason)) in decision {
        stmt.execute(params![state, reason, id])?;
    }
    Ok(())
}

/// File versi yang dibutuhkan permintaan ini dan belum ada: versi asli dan
/// versi dari record `ok` atau `pending`.
fn wanted_files(
    conn: &Connection,
    store: &dyn DocumentStore,
    request_id: &str,
) -> AppResult<Vec<WantedFile>> {
    let records = load_records(conn, request_id)?;
    let Some(rp) = records.iter().find_map(|r| match &r.payload {
        Payload::Request(p) => Some(p),
        _ => None,
    }) else {
        return Ok(Vec::new());
    };
    let mut out: Vec<WantedFile> = Vec::new();
    let mut add = |hash: &str, size: u64, prefer: Vec<String>| -> AppResult<()> {
        if !out.iter().any(|w| w.hash == hash) && read_verified(store, hash)?.is_none() {
            out.push(WantedFile {
                hash: hash.to_owned(),
                size,
                prefer,
            });
        }
        Ok(())
    };
    add(
        &rp.original_hash,
        rp.original_size,
        vec![rp.requested_by.clone()],
    )?;
    for r in &records {
        if r.state == STATE_REJECTED {
            continue;
        }
        if let Payload::Signed(p) = &r.payload {
            add(
                &p.hash_after,
                p.size,
                vec![r.author.clone(), rp.requested_by.clone()],
            )?;
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Sinkron.
// ---------------------------------------------------------------------------

/// Meminta file dari rekan tanpa menunggu. Aplikasi: `HubFetcher`; tes
/// mencatat permintaannya.
pub trait FileFetcher: Send + Sync {
    /// Minta file `hash` (paling besar `max_size` byte), coba `prefer` lebih
    /// dulu. Setelah file sampai, implementasi memanggil
    /// `SignSync::add_downloaded`.
    fn want(&self, hash: &str, max_size: u64, prefer: &[String]);
}

/// Sinkron tanda tangan untuk satu laptop: `FeatureSync` dan `BlobSource`.
pub struct SignSync {
    state: MiraState,
    store: BlobDocumentStore,
    guests: Arc<dyn GuestProjects>,
    fetcher: Arc<dyn FileFetcher>,
    notifier: Arc<dyn Notifier>,
}

fn to_msg(e: AppError) -> String {
    e.to_string()
}

impl SignSync {
    pub fn new(
        state: MiraState,
        store: BlobDocumentStore,
        guests: Arc<dyn GuestProjects>,
        fetcher: Arc<dyn FileFetcher>,
        notifier: Arc<dyn Notifier>,
    ) -> Self {
        Self {
            state,
            store,
            guests,
            fetcher,
            notifier,
        }
    }

    pub fn store(&self) -> &BlobDocumentStore {
        &self.store
    }

    /// Menjalankan fold untuk `ids` dalam satu transaksi, lalu menampilkan
    /// notifikasi giliran dan meminta file yang kecil.
    fn refold(&self, ids: &[String]) -> AppResult<()> {
        let now = clock::now_rfc3339();
        let (turns, wanted) = self.state.with_core(|core| {
            let me = core.identity.public_key_hex().to_owned();
            let state = permissions::load_state(&core.db)?;
            let tx = core.db.transaction()?;
            let mut turns = Vec::new();
            let mut wanted = Vec::new();
            for id in ids {
                let report = fold(&tx, &self.store, state.as_ref(), &me, id, &now)?;
                turns.extend(report.turn);
                wanted.extend(wanted_files(&tx, &self.store, id)?);
            }
            tx.commit()?;
            Ok((turns, wanted))
        })?;
        for title in turns {
            // Notifikasi yang gagal tidak membatalkan sinkron.
            let _ = self.notifier.notify(TURN_TITLE, &title);
        }
        self.request_files(&wanted, None);
        Ok(())
    }

    fn request_files(&self, wanted: &[WantedFile], first: Option<&str>) {
        let mut seen = HashSet::new();
        for w in wanted {
            if w.size > AUTO_REPLICATE_MAX_BYTES || !seen.insert(w.hash.as_str()) {
                continue;
            }
            let mut prefer: Vec<String> = first.map(str::to_owned).into_iter().collect();
            prefer.extend(
                w.prefer
                    .iter()
                    .filter(|p| Some(p.as_str()) != first)
                    .cloned(),
            );
            self.fetcher.want(&w.hash, w.size, &prefer);
        }
    }

    /// Semua file versi permintaan `request_id` yang belum ada (berapa pun
    /// ukurannya), untuk perintah `sign_download_file`.
    pub fn missing_files(&self, request_id: &str) -> AppResult<Vec<WantedFile>> {
        self.state
            .with_core(|core| wanted_files(&core.db, &self.store, request_id))
    }

    /// File `expected_hash` sudah diunduh ke `path`: simpan ke blob store,
    /// hapus `path`, lalu hitung ulang permintaan yang memakainya.
    pub fn add_downloaded(&self, path: &Path, expected_hash: &str) -> AppResult<()> {
        let stored = self.store.blobs().put_file(path);
        let _ = std::fs::remove_file(path);
        let info = stored?;
        if info.hash.as_str() != expected_hash {
            return Err(AppError::Storage(
                "File yang diterima dari laptop rekan tidak sama dengan yang diminta. Coba unduh lagi."
                    .into(),
            ));
        }
        let ids = self
            .state
            .with_core(|core| requests_using(&core.db, expected_hash))?;
        self.refold(&ids)
    }

    /// Path sementara untuk mengunduh `hash`.
    pub fn download_path(&self, hash: &str) -> AppResult<PathBuf> {
        let dir = self.state.data_dir()?.join(DOWNLOAD_FOLDER);
        std::fs::create_dir_all(&dir).map_err(|e| {
            AppError::Storage(format!(
                "Folder unduhan {} tidak bisa dibuat. Detail: {e}",
                dir.display()
            ))
        })?;
        Ok(dir.join(format!("{hash}.part")))
    }

    fn ingest_one(
        &self,
        conn: &Connection,
        state: &OrgState,
        me: &str,
        rec: &FeatureRecord,
        now: &str,
    ) -> Check<Option<String>> {
        let opened = envelope::open::<Payload>(SIGN_DOMAIN, rec)?;
        if record_exists(conn, &rec.id).map_err(to_msg)? {
            return Ok(None);
        }
        let author = opened.author;
        if !state.is_active(&author) {
            return Err("penulis record bukan anggota aktif organisasi".into());
        }
        let request_id = opened.payload.request_id().to_owned();
        let known = request_payload(conn, &request_id).map_err(to_msg)?;
        match &opened.payload {
            Payload::Request(p) => {
                if known.is_some() {
                    return Err("id permintaan sudah dipakai".into());
                }
                check_request(conn, state, self.guests.as_ref(), &author, p)?;
                if !involved(conn, state, self.guests.as_ref(), me, p).map_err(to_msg)? {
                    return Err("laptop ini tidak terlibat dalam permintaan itu".into());
                }
            }
            Payload::Signed(p) => check_signed(&author, p, known.as_ref())?,
            Payload::Cancelled(p) => check_cancelled(&author, p, known.as_ref())?,
        }
        insert_record(
            conn,
            rec,
            &opened.payload,
            &author,
            STATE_PENDING,
            now,
            Some(now),
        )
        .map_err(to_msg)?;
        Ok(Some(request_id))
    }

    /// Record yang boleh diterima `peer`: semua record permintaan yang
    /// melibatkannya.
    fn offered(&self, conn: &Connection, peer: &str) -> AppResult<HashSet<String>> {
        let mut out = HashSet::new();
        let Some(state) = permissions::load_state(conn)? else {
            return Ok(out);
        };
        if !state.is_active(peer) {
            return Ok(out);
        }
        for p in all_requests(conn)? {
            if !involved(conn, &state, self.guests.as_ref(), peer, &p)? {
                continue;
            }
            let ids: Vec<String> = conn
                .prepare_cached("SELECT id FROM sign_sync_records WHERE request_id = ?1")?
                .query_map(params![p.id], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            out.extend(ids);
        }
        Ok(out)
    }
}

/// Permintaan yang memakai file `hash` (sebagai versi asli atau versi baru).
fn requests_using(conn: &Connection, hash: &str) -> AppResult<Vec<String>> {
    let pattern = format!("%{hash}%");
    let candidates: Vec<String> = conn
        .prepare_cached("SELECT DISTINCT request_id FROM sign_sync_records WHERE body LIKE ?1")?
        .query_map(params![pattern], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut out = Vec::new();
    for id in candidates {
        let uses = load_records(conn, &id)?.iter().any(|r| match &r.payload {
            Payload::Request(p) => p.original_hash == hash,
            Payload::Signed(p) => p.hash_after == hash || p.hash_before == hash,
            Payload::Cancelled(_) => false,
        });
        if uses {
            out.push(id);
        }
    }
    Ok(out)
}

impl FeatureSync for SignSync {
    fn topic(&self) -> &'static str {
        TOPIC_SIGN
    }

    fn record_ids_for(&self, peer: &str) -> Result<Vec<String>, String> {
        let mut ids: Vec<String> = self
            .state
            .with_core(|core| self.offered(&core.db, peer))
            .map_err(to_msg)?
            .into_iter()
            .collect();
        ids.sort();
        Ok(ids)
    }

    fn unknown_ids(&self, ids: &[String]) -> Result<Vec<String>, String> {
        self.state
            .with_core(|core| {
                let mut out = Vec::new();
                for id in ids {
                    if !record_exists(&core.db, id)? {
                        out.push(id.clone());
                    }
                }
                Ok(out)
            })
            .map_err(to_msg)
    }

    fn records_for(&self, peer: &str, ids: &[String]) -> Result<Vec<FeatureRecord>, String> {
        self.state
            .with_core(|core| {
                let allowed = self.offered(&core.db, peer)?;
                let mut out = Vec::new();
                for id in ids.iter().filter(|id| allowed.contains(*id)) {
                    let body: Option<String> = core
                        .db
                        .query_row(
                            "SELECT body FROM sign_sync_records WHERE id = ?1",
                            params![id],
                            |r| r.get(0),
                        )
                        .optional()?;
                    if let Some(body) = body {
                        out.push(FeatureRecord {
                            id: id.clone(),
                            body,
                        });
                    }
                }
                Ok(out)
            })
            .map_err(to_msg)
    }

    fn ingest(&self, from: &str, records: Vec<FeatureRecord>) -> Result<FeatureIngest, String> {
        let now_t = clock::now();
        let now = clock::format_rfc3339(now_t);
        let mut out = FeatureIngest::default();
        let touched = self
            .state
            .with_core(|core| {
                let me = core.identity.public_key_hex().to_owned();
                let Some(state) = permissions::load_state(&core.db)? else {
                    out.rejected = records.len();
                    return Ok(Vec::new());
                };
                let tx = core.db.transaction()?;
                let mut touched: Vec<String> = Vec::new();
                for rec in &records {
                    match self.ingest_one(&tx, &state, &me, rec, &now) {
                        Ok(Some(id)) => {
                            out.accepted += 1;
                            if !touched.contains(&id) {
                                touched.push(id);
                            }
                        }
                        Ok(None) => {}
                        Err(reason) => {
                            out.rejected += 1;
                            permissions::log_rejection(
                                &tx,
                                Some(from),
                                None,
                                REJECT_CODE,
                                &format!("record {}: {reason}", rec.id),
                                now_t,
                            )?;
                        }
                    }
                }
                tx.commit()?;
                Ok(touched)
            })
            .map_err(to_msg)?;
        if !touched.is_empty() {
            out.changed = true;
            self.refold(&touched).map_err(to_msg)?;
        }
        Ok(out)
    }

    fn peer_connected(&self, peer: &str) {
        let wanted = self.state.with_core(|core| {
            let mut all = Vec::new();
            for p in all_requests(&core.db)? {
                all.extend(wanted_files(&core.db, &self.store, &p.id)?);
            }
            Ok(all)
        });
        if let Ok(wanted) = wanted {
            self.request_files(&wanted, Some(peer));
        }
    }
}

impl BlobSource for SignSync {
    fn blob_path_for(&self, peer: &str, hash: &str) -> Option<PathBuf> {
        if !seal::is_hash_hex(hash) || BlobHash::parse(hash).is_err() {
            return None;
        }
        let allowed = self
            .state
            .with_core(|core| {
                let Some(state) = permissions::load_state(&core.db)? else {
                    return Ok(false);
                };
                for id in requests_using(&core.db, hash)? {
                    if let Some(p) = request_payload(&core.db, &id)?
                        && involved(&core.db, &state, self.guests.as_ref(), peer, &p)?
                    {
                        return Ok(true);
                    }
                }
                Ok(false)
            })
            .unwrap_or(false);
        if !allowed {
            return None;
        }
        self.store.path_for(hash).ok().flatten()
    }
}

// ---------------------------------------------------------------------------
// Aplikasi (Tauri).
// ---------------------------------------------------------------------------

/// Event yang membuat layar Tanda tangan memuat ulang.
pub const FEATURE_EVENT: &str = "mira://feature";

/// Mengunduh lewat `FeatureHub::fetch_blob` ke file sementara, lalu
/// `SignSync::add_downloaded` dan event `mira://feature` `{topic:"sign"}`.
pub struct HubFetcher {
    app: tauri::AppHandle,
    hub: Arc<crate::network::feature::FeatureHub>,
    sync: OnceLock<Weak<SignSync>>,
    inflight: Arc<Mutex<HashSet<String>>>,
}

impl HubFetcher {
    pub fn new(app: tauri::AppHandle, hub: Arc<crate::network::feature::FeatureHub>) -> Self {
        Self {
            app,
            hub,
            sync: OnceLock::new(),
            inflight: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    pub fn bind(&self, sync: &Arc<SignSync>) {
        let _ = self.sync.set(Arc::downgrade(sync));
    }
}

/// Mengirim `mira://feature` `{topic:"sign"}` ke layar.
pub fn emit_changed(app: &tauri::AppHandle) {
    use tauri::Emitter;
    let _ = app.emit(FEATURE_EVENT, serde_json::json!({ "topic": TOPIC_SIGN }));
}

impl FileFetcher for HubFetcher {
    fn want(&self, hash: &str, max_size: u64, prefer: &[String]) {
        let Some(sync) = self.sync.get().and_then(Weak::upgrade) else {
            return;
        };
        {
            let mut set = self.inflight.lock().unwrap_or_else(|e| e.into_inner());
            if !set.insert(hash.to_owned()) {
                return;
            }
        }
        let Ok(dest) = sync.download_path(hash) else {
            self.inflight
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(hash);
            return;
        };
        let (app, hub, inflight) = (self.app.clone(), self.hub.clone(), self.inflight.clone());
        let (hash, prefer) = (hash.to_owned(), prefer.to_vec());
        tauri::async_runtime::spawn(async move {
            let fetched = hub.fetch_blob(&hash, max_size, prefer, &dest).await;
            if fetched.is_ok() {
                let (h, d) = (hash.clone(), dest.clone());
                let done =
                    tauri::async_runtime::spawn_blocking(move || sync.add_downloaded(&d, &h)).await;
                if matches!(done, Ok(Ok(()))) {
                    emit_changed(&app);
                }
            } else {
                let _ = std::fs::remove_file(&dest);
            }
            inflight
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&hash);
        });
    }
}

/// Membangun sinkron tanda tangan dan mendaftarkannya ke `FeatureHub`
/// (sebagai `FeatureSync` dan `BlobSource`), lalu `app.manage(Arc<SignSync>)`.
/// Dipanggil sekali dari `lib.rs` setup, setelah `MiraState` dan
/// `Arc<FeatureHub>` dikelola Tauri. Kalau folder data tidak tersedia,
/// sinkron tidak didaftarkan (perintah lokal tetap memberi error yang jelas).
pub fn register(app: &tauri::AppHandle) {
    use tauri::Manager;
    let (Some(state), Some(hub)) = (
        app.try_state::<MiraState>(),
        app.try_state::<Arc<crate::network::feature::FeatureHub>>(),
    ) else {
        eprintln!("Mira: sinkron tanda tangan tidak didaftarkan (state belum dikelola).");
        return;
    };
    let (state, hub) = (state.inner().clone(), hub.inner().clone());
    let store = match state.data_dir().and_then(BlobDocumentStore::in_data_dir) {
        Ok(s) => s,
        Err(e) => {
            eprintln!(
                "Mira: sinkron tanda tangan tidak didaftarkan [{}]: {e}",
                e.code()
            );
            return;
        }
    };
    let fetcher = Arc::new(HubFetcher::new(app.clone(), hub.clone()));
    let sync = Arc::new(SignSync::new(
        state,
        store,
        Arc::new(crate::documents::scope::InviteGuestProjects),
        fetcher.clone(),
        Arc::new(crate::board::reminder::TauriNotifier::new(app.clone())),
    ));
    fetcher.bind(&sync);
    hub.register(sync.clone());
    hub.register_blob_source(sync.clone());
    app.manage(sync);
}
