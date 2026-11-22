//! Alur tanda tangan PDF: ringkasan, tanda tangan tersimpan, unlock, impor
//! PDF, buat permintaan, selesai tanda tangan, batal, ekspor, periksa file.
//!
//! Semua alur memakai `SignContext`, jadi bisa dites tanpa Tauri (tes memakai
//! `MemoryStore` dan `KdfParams::TEST`). `signing::commands` hanya membangun
//! konteks ini lalu memanggil metodenya. Bentuk hasil (nama field camelCase)
//! adalah kontrak di `docs/plans/tahap-5-lokal.md` bagian 5 dan
//! `src/api/signing.ts`.
//!
//! Aturan kepercayaan: nama dan jenis penanda tangan diambil dari tabel
//! `members`, bukan dari frontend. Waktu tanda tangan resmi adalah waktu
//! terbit token unlock (lihat `session`), sama dengan waktu di stempel.

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use data_encoding::BASE64;
use rand_core::{OsRng, RngCore};
use rusqlite::{Connection, TransactionBehavior};
use serde::Serialize;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use zeroize::Zeroizing;

use super::err;
use super::outbox::SignOutbox;
use super::pin::{KdfParams, MAX_PNG_BYTES};
use super::repo::{self, ExportRow, MemberRow, StoredEvent};
use super::request::{
    self, MyState, NewRequest, RequestStatus, Requester, SignMode, SignRequest, Signer,
    SignerInput, SignerKind, SignerStatus,
};
use super::seal::{self, EventKind, EventRecord, Integrity};
use super::session::SignSessions;
use super::store::{DocumentStore, MAX_PDF_BYTES, MAX_SIGNED_PDF_BYTES};
use super::vault::{self, SavedSignatureInfo};
use crate::clock;
use crate::error::{AppError, AppResult};
use crate::identity::{self, Identity, has_forbidden_chars};
use crate::org;

// ---------------------------------------------------------------------------
// Bentuk hasil (kontrak dengan frontend).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestSummary {
    pub id: String,
    pub title: String,
    pub mode: SignMode,
    pub status: RequestStatus,
    pub my_state: MyState,
    pub signed_count: usize,
    pub signer_count: usize,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    /// Keadaan file versi terkini di penyimpanan Mira.
    pub integrity: Integrity,
    /// Jumlah file ekspor yang isinya berubah (yang hilang tidak dihitung).
    pub export_warnings: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    pub public_key: String,
    pub display_name: String,
    pub kind: SignerKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignOverview {
    pub saved: Option<SavedSignatureInfo>,
    pub requests: Vec<RequestSummary>,
    pub can_request: bool,
    pub me: Me,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub public_key: String,
    pub display_name: String,
    pub kind: SignerKind,
    pub is_me: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignerView {
    pub position: u32,
    pub public_key: String,
    pub display_name: String,
    pub kind: SignerKind,
    pub status: SignerStatus,
    pub signed_at: Option<String>,
    pub hash_after: Option<String>,
    pub is_me: bool,
    /// Penanda tangan INI boleh menandatangani sekarang (gilirannya). Untuk
    /// tahu apakah laptop ini boleh, gabungkan dengan `is_me` atau pakai
    /// `RequestSummary::my_state == your_turn`.
    pub can_sign_now: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventView {
    pub kind: String,
    pub actor_key: String,
    pub actor_name: String,
    pub at: String,
    pub hash_before: Option<String>,
    pub hash_after: Option<String>,
    pub detail: String,
    /// Tanda tangan pelaku atas catatan ini sah.
    pub valid: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportView {
    pub path: String,
    pub exported_at: String,
    pub state: Integrity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartyRef {
    pub public_key: String,
    pub display_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestDetail {
    #[serde(flatten)]
    pub summary: RequestSummary,
    pub requested_by: PartyRef,
    pub original_hash: String,
    pub current_hash: String,
    pub signers: Vec<SignerView>,
    pub events: Vec<EventView>,
    pub exports: Vec<ExportView>,
    pub is_last_pending: bool,
    pub doc_tag: String,
    /// `None` kalau belum selesai; `true` kalau rantai jejak audit utuh
    /// (lihat `seal_chain_valid`) dan file versi final di penyimpanan utuh.
    pub seal_valid: Option<bool>,
}

/// `Debug` manual: token dan gambar tanda tangan tidak pernah dicetak.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockResult {
    pub token: String,
    pub png_base64: String,
    pub signed_at: String,
    pub width: u32,
    pub height: u32,
}

impl std::fmt::Debug for UnlockResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UnlockResult")
            .field("token", &"<disembunyikan>")
            .field("png_base64_len", &self.png_base64.len())
            .field("signed_at", &self.signed_at)
            .field("width", &self.width)
            .field("height", &self.height)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedPdf {
    pub file_hash: String,
    pub size: usize,
    pub file_name: String,
    /// Selalu `null`: inti Rust tidak mengurai PDF; frontend menghitung
    /// halaman dengan pdf.js.
    pub page_count: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VerifyState {
    MatchFinal,
    MatchVersion,
    Changed,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifySigner {
    pub display_name: String,
    pub signed_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyResult {
    pub state: VerifyState,
    pub file_hash: String,
    pub request_id: Option<String>,
    pub title: Option<String>,
    pub completed_at: Option<String>,
    pub signers: Vec<VerifySigner>,
}

// ---------------------------------------------------------------------------
// Konteks.
// ---------------------------------------------------------------------------

/// Semua yang dibutuhkan alur tanda tangan.
pub struct SignContext<'a> {
    pub conn: &'a mut Connection,
    pub identity: &'a Identity,
    pub store: &'a dyn DocumentStore,
    pub sessions: &'a SignSessions,
    pub outbox: &'a dyn SignOutbox,
    /// Folder tujuan `export`.
    pub export_dir: &'a Path,
    /// Parameter Argon2id untuk tanda tangan baru (`KdfParams::DEFAULT`;
    /// tes memakai `KdfParams::TEST`).
    pub kdf: KdfParams,
}

/// Batas panjang nama file hasil bersih (tanpa akhiran).
const FILE_STEM_MAX_CHARS: usize = 120;

/// Batas panjang base64 gambar tanda tangan (PNG maksimal 1 MB).
const MAX_PNG_BASE64_LEN: usize = MAX_PNG_BYTES.div_ceil(3) * 4 + 4;

/// Batas nama ekspor yang sama di satu folder (`(2)` sampai `(999)`).
const MAX_EXPORT_SUFFIX: u32 = 999;

fn now_str(now: OffsetDateTime) -> String {
    clock::format_rfc3339(now)
}

fn my_name(identity: &Identity) -> String {
    identity
        .display_name()
        .map(str::to_owned)
        .unwrap_or_else(|| identity::fingerprint(identity.public_key_hex()))
}

fn new_event(
    identity: &Identity,
    request_id: Option<&str>,
    kind: EventKind,
    at: &str,
) -> EventRecord {
    EventRecord {
        request_id: request_id.map(str::to_owned),
        kind,
        actor: identity.public_key_hex().to_owned(),
        actor_name: my_name(identity),
        at: at.to_owned(),
        hash_before: None,
        hash_after: None,
        detail: String::new(),
    }
}

fn store_event(identity: &Identity, conn: &Connection, rec: &EventRecord) -> AppResult<()> {
    let sig = seal::sign_event(identity, rec)?;
    repo::insert_event(conn, rec, &sig)?;
    Ok(())
}

fn random_id() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn request_not_found() -> AppError {
    AppError::NotFound(
        "Permintaan tanda tangan ini tidak ditemukan di laptop ini. Muat ulang daftar permintaan."
            .into(),
    )
}

const IMPORT_TOO_LARGE: &str =
    "Ukuran PDF melebihi batas 50 MB. Perkecil berkasnya dulu, lalu coba lagi.";
const SIGNED_TOO_LARGE: &str = "Ukuran PDF hasil tanda tangan melebihi batas 100 MB. Perkecil berkas aslinya dulu, misalnya kompres gambar di dalamnya, lalu buat permintaan baru.";
const VERIFY_TOO_LARGE: &str =
    "Ukuran PDF melebihi batas 100 MB, jadi tidak bisa diperiksa di Mira.";

/// Ukuran (paling banyak `max` byte) dan header PDF.
fn check_pdf(bytes: &[u8], max: usize, too_large: &str, not_pdf: &str) -> AppResult<()> {
    if bytes.len() > max {
        return Err(err("pdf_too_large", too_large));
    }
    if !seal::looks_like_pdf(bytes) {
        return Err(err("pdf_invalid", not_pdf));
    }
    Ok(())
}

fn blob_integrity(store: &dyn DocumentStore, hash: &str) -> Integrity {
    match store.get(hash) {
        Ok(bytes) => seal::check_bytes(hash, bytes.as_deref()),
        // Tidak bisa dibaca sama dengan tidak bisa dipastikan ada.
        Err(_) => Integrity::Missing,
    }
}

/// Keadaan file di luar Mira dibanding `expected_hash`, tanpa memuat seluruh
/// file ke memori: ukuran diperiksa dulu (lebih dari `MAX_SIGNED_PDF_BYTES`
/// berarti `Changed` tanpa dibaca), lalu di-hash secara streaming. File yang
/// tidak ada atau tidak bisa dibaca dianggap `Missing`.
pub fn file_integrity(path: &Path, expected_hash: &str) -> Integrity {
    let limit = MAX_SIGNED_PDF_BYTES as u64;
    let Ok(meta) = fs::metadata(path) else {
        return Integrity::Missing;
    };
    if !meta.is_file() {
        return Integrity::Missing;
    }
    if meta.len() > limit {
        return Integrity::Changed;
    }
    let Ok(file) = fs::File::open(path) else {
        return Integrity::Missing;
    };
    let mut hasher = blake3::Hasher::new();
    // `take` menjaga kalau file membesar setelah `metadata`.
    let mut reader = io::BufReader::with_capacity(64 * 1024, file).take(limit + 1);
    match io::copy(&mut reader, &mut hasher) {
        Ok(n) if n > limit => Integrity::Changed,
        Ok(_) if hasher.finalize().to_hex().as_str() == expected_hash => Integrity::Intact,
        Ok(_) => Integrity::Changed,
        Err(_) => Integrity::Missing,
    }
}

fn export_state(row: &ExportRow) -> Integrity {
    file_integrity(Path::new(&row.path), &row.hash)
}

fn parse_at(s: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(s, &Rfc3339).ok()
}

/// Rantai jejak audit permintaan yang selesai utuh:
///
/// - ada catatan `created` sah dari `requested_by` dengan `hash_after` =
///   versi asli;
/// - setiap penanda tangan berstatus signed punya catatan `signed` sah dari
///   kuncinya sendiri dengan `hash_after` = `hash_after` penanda tangan itu,
///   dan semua penanda tangan sudah signed;
/// - diurutkan menurut waktu, `hash_before` setiap catatan `signed` = hash
///   versi sebelumnya (yang pertama = versi asli), dan versi terakhir =
///   `current_hash`;
/// - catatan `completed` terakhir sah, `hash_after`-nya = `current_hash`, dan
///   pelakunya penanda tangan yang `hash_after`-nya versi final itu.
///
/// Jadi catatan dari kunci yang bukan penanda tangan, atau database yang
/// diubah langsung, tidak cukup untuk membuat permintaan tampak terkunci sah.
pub fn seal_chain_valid(req: &SignRequest, events: &[StoredEvent]) -> bool {
    let final_hash = req.current_hash.as_str();
    let created_ok = events.iter().any(|e| {
        e.kind == EventKind::Created.as_str()
            && e.actor == req.requested_by
            && e.hash_after.as_deref() == Some(req.original_hash.as_str())
            && e.is_valid()
    });
    if !created_ok {
        return false;
    }

    let mut chain = Vec::with_capacity(req.signers.len());
    for s in &req.signers {
        let (SignerStatus::Signed, Some(after)) = (s.status, s.hash_after.as_deref()) else {
            return false;
        };
        let Some(e) = events.iter().find(|e| {
            e.kind == EventKind::Signed.as_str()
                && e.actor == s.public_key
                && e.hash_after.as_deref() == Some(after)
                && e.is_valid()
        }) else {
            return false;
        };
        let Some(at) = parse_at(&e.at) else {
            return false;
        };
        chain.push((at, e.id, e));
    }
    chain.sort_by_key(|(at, id, _)| (*at, *id));
    let mut prev = req.original_hash.as_str();
    for (_, _, e) in &chain {
        if e.hash_before.as_deref() != Some(prev) {
            return false;
        }
        prev = e.hash_after.as_deref().unwrap_or_default();
    }
    if prev != final_hash {
        return false;
    }

    events
        .iter()
        .rev()
        .find(|e| e.kind == EventKind::Completed.as_str())
        .is_some_and(|done| {
            done.hash_after.as_deref() == Some(final_hash)
                && req.signers.iter().any(|s| {
                    s.public_key == done.actor && s.hash_after.as_deref() == Some(final_hash)
                })
                && done.is_valid()
        })
}

/// Penanda tangan yang sudah menandatangani sampai versi `file_hash`, urut
/// waktu. Kosong untuk versi asli (atau hash yang tidak dikenal).
fn signers_up_to<'a>(req: &'a SignRequest, file_hash: &str) -> Vec<&'a Signer> {
    let mut signed: Vec<&Signer> = req
        .signers
        .iter()
        .filter(|s| s.status == SignerStatus::Signed)
        .collect();
    signed.sort_by_key(|s| (s.signed_at.as_deref().and_then(parse_at), s.position));
    match signed
        .iter()
        .position(|s| s.hash_after.as_deref() == Some(file_hash))
    {
        Some(i) => signed[..=i].to_vec(),
        None => Vec::new(),
    }
}

/// Menyisipkan `extra` (urut waktu) ke `events` menurut waktu, tanpa
/// mengubah urutan `events` sendiri. Catatan dengan waktu sama: `events`
/// lebih dulu.
fn merge_by_time(events: Vec<StoredEvent>, extra: Vec<StoredEvent>) -> Vec<StoredEvent> {
    let mut out = Vec::with_capacity(events.len() + extra.len());
    let mut extra = extra.into_iter().peekable();
    for e in events {
        let at = parse_at(&e.at);
        while extra.peek().is_some_and(|x| match (parse_at(&x.at), at) {
            (Some(xa), Some(ea)) => xa < ea,
            _ => false,
        }) {
            out.extend(extra.next());
        }
        out.push(e);
    }
    out.extend(extra);
    out
}

/// Bagian nama file yang aman untuk Windows: tanpa `<>:"/\|?*`, karakter
/// kontrol, atau karakter tak terlihat; spasi dirapikan; titik dan spasi di
/// ujung dibuang. Kosong menjadi `fallback`.
pub fn clean_name_part(s: &str, fallback: &str) -> String {
    let replaced: String = s
        .chars()
        .filter(|c| c.is_control() || !has_forbidden_chars(&c.to_string()))
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let collapsed = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
    let short: String = collapsed.chars().take(FILE_STEM_MAX_CHARS).collect();
    let trimmed = short.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if trimmed.is_empty() {
        fallback.to_owned()
    } else {
        trimmed.to_owned()
    }
}

/// Nama file dari frontend tanpa folder dan karakter terlarang.
pub fn clean_file_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or(name);
    clean_name_part(last, "dokumen.pdf")
}

fn strip_pdf_ext(title: &str) -> &str {
    let t = title.trim();
    match t.len().checked_sub(4) {
        Some(i) if t.is_char_boundary(i) && t[i..].eq_ignore_ascii_case(".pdf") => &t[..i],
        _ => t,
    }
}

/// Nama ekspor tanpa akhiran `.pdf`.
pub fn export_stem(req: &SignRequest) -> String {
    let base = clean_name_part(strip_pdf_ext(&req.title), "Dokumen");
    let signed = req.signed_count();
    match req.status {
        RequestStatus::Completed => format!("{base} (ditandatangani)"),
        _ if signed == 0 => format!("{base} (belum ditandatangani)"),
        _ => format!("{base} (versi {signed} tanda tangan)"),
    }
}

fn export_io(path: &Path, e: io::Error) -> AppError {
    err(
        "export_failed",
        format!(
            "File tidak bisa disimpan ke {}. Periksa folder tujuan masih ada dan bisa ditulis, lalu coba lagi. Detail: {e}",
            path.display()
        ),
    )
}

/// Menulis `bytes` ke `<dir>/<stem>.pdf` tanpa menimpa file yang sudah ada:
/// kalau nama itu terpakai, dicoba `<stem> (2).pdf`, `<stem> (3).pdf`, dan
/// seterusnya.
fn write_unique(dir: &Path, stem: &str, bytes: &[u8]) -> AppResult<PathBuf> {
    fs::create_dir_all(dir).map_err(|e| export_io(dir, e))?;
    for n in 1..=MAX_EXPORT_SUFFIX {
        let name = if n == 1 {
            format!("{stem}.pdf")
        } else {
            format!("{stem} ({n}).pdf")
        };
        let path = dir.join(name);
        match fs::File::create_new(&path) {
            Ok(mut file) => {
                if let Err(e) = file.write_all(bytes).and_then(|()| file.sync_all()) {
                    drop(file);
                    let _ = fs::remove_file(&path);
                    return Err(export_io(&path, e));
                }
                return Ok(path);
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(export_io(&path, e)),
        }
    }
    Err(err(
        "export_failed",
        format!(
            "Sudah ada terlalu banyak file bernama \"{stem}\" di {}. Pindahkan atau hapus sebagian, lalu coba lagi.",
            dir.display()
        ),
    ))
}

fn summary(
    req: &SignRequest,
    me: &str,
    integrity: Integrity,
    exports: &[ExportView],
) -> RequestSummary {
    RequestSummary {
        id: req.id.clone(),
        title: req.title.clone(),
        mode: req.mode,
        status: req.status,
        my_state: req.my_state(me),
        signed_count: req.signed_count(),
        signer_count: req.signers.len(),
        created_at: req.created_at.clone(),
        updated_at: req.updated_at.clone(),
        completed_at: req.completed_at.clone(),
        integrity,
        export_warnings: exports
            .iter()
            .filter(|e| e.state == Integrity::Changed)
            .count(),
    }
}

fn mode_label(mode: SignMode) -> &'static str {
    match mode {
        SignMode::Sequential => "berurutan",
        SignMode::Parallel => "bebas",
    }
}

impl SignContext<'_> {
    fn db(&self) -> &Connection {
        &*self.conn
    }

    fn me(&self) -> &str {
        self.identity.public_key_hex()
    }

    /// Organisasi (id) dan baris `members` laptop ini.
    fn membership(&self) -> AppResult<(Option<String>, Option<MemberRow>)> {
        let Some(org) = org::load_organization(self.db())? else {
            return Ok((None, None));
        };
        let row = repo::member(self.db(), &org.id, self.me())?;
        Ok((Some(org.id), row))
    }

    fn load(&self, id: &str) -> AppResult<SignRequest> {
        if !org::is_lower_hex(id, 32) {
            return Err(request_not_found());
        }
        repo::load_request(self.db(), id)?.ok_or_else(request_not_found)
    }

    fn export_views(&self, request_id: &str) -> AppResult<Vec<ExportView>> {
        Ok(repo::exports_for(self.db(), request_id)?
            .into_iter()
            .map(|row| ExportView {
                state: export_state(&row),
                path: row.path,
                exported_at: row.exported_at,
            })
            .collect())
    }

    fn name_of(&self, pk: &str, req: &SignRequest) -> AppResult<String> {
        if pk == self.me() {
            return Ok(my_name(self.identity));
        }
        if let Some(org) = org::load_organization(self.db())?
            && let Some(row) = repo::member(self.db(), &org.id, pk)?
        {
            return Ok(row.display_name);
        }
        if let Some(s) = req.signers.iter().find(|s| s.public_key == pk) {
            return Ok(s.display_name.clone());
        }
        Ok(identity::fingerprint(pk))
    }

    /// Laptop yang sudah dikeluarkan dari organisasi tidak boleh bertindak.
    fn ensure_not_removed(&self) -> AppResult<()> {
        match self.membership()? {
            (_, Some(row)) if !row.is_active() => Err(AppError::Removed),
            _ => Ok(()),
        }
    }

    /// Catatan `signature_saved` dan `signature_deleted` milik penanda tangan
    /// `req` sejak permintaan dibuat, urut waktu. Catatan ini tidak terikat
    /// permintaan (`request_id` kosong), tetapi ditampilkan supaya pengirim
    /// tahu kalau tanda tangan seseorang dibuat ulang selama permintaan
    /// berjalan.
    fn signature_events_since_created(&self, req: &SignRequest) -> AppResult<Vec<StoredEvent>> {
        let Some(since) = parse_at(&req.created_at) else {
            return Ok(Vec::new());
        };
        let mut extra = Vec::new();
        for s in &req.signers {
            extra.extend(
                repo::signature_events_of(self.db(), &s.public_key)?
                    .into_iter()
                    .filter(|e| parse_at(&e.at).is_some_and(|at| at >= since)),
            );
        }
        extra.sort_by_key(|e| (parse_at(&e.at), e.id));
        Ok(extra)
    }

    fn detail(&self, req: &SignRequest) -> AppResult<RequestDetail> {
        let me = self.me();
        let integrity = blob_integrity(self.store, &req.current_hash);
        let exports = self.export_views(&req.id)?;
        let events = repo::events_for(self.db(), &req.id)?;
        let seal_valid = (req.status == RequestStatus::Completed)
            .then(|| integrity == Integrity::Intact && seal_chain_valid(req, &events));
        let events = merge_by_time(events, self.signature_events_since_created(req)?);
        let signers = req
            .signers
            .iter()
            .map(|s| SignerView {
                position: s.position,
                public_key: s.public_key.clone(),
                display_name: s.display_name.clone(),
                kind: s.kind,
                status: s.status,
                signed_at: s.signed_at.clone(),
                hash_after: s.hash_after.clone(),
                is_me: s.public_key == me,
                can_sign_now: req.can_sign(&s.public_key).is_ok(),
            })
            .collect();
        let events = events
            .iter()
            .map(|e| EventView {
                valid: e.is_valid(),
                kind: e.kind.clone(),
                actor_key: e.actor.clone(),
                actor_name: e.actor_name.clone(),
                at: e.at.clone(),
                hash_before: e.hash_before.clone(),
                hash_after: e.hash_after.clone(),
                detail: e.detail.clone(),
            })
            .collect();
        Ok(RequestDetail {
            summary: summary(req, me, integrity, &exports),
            requested_by: PartyRef {
                public_key: req.requested_by.clone(),
                display_name: self.name_of(&req.requested_by, req)?,
            },
            original_hash: req.original_hash.clone(),
            current_hash: req.current_hash.clone(),
            signers,
            events,
            exports,
            is_last_pending: req.is_last_pending(me),
            doc_tag: seal::doc_tag(&req.id),
            seal_valid,
        })
    }

    // -----------------------------------------------------------------------
    // Alur.
    // -----------------------------------------------------------------------

    /// Ringkasan layar Tanda tangan. `now` dipakai untuk membatasi kunci
    /// waktu PIN yang terlalu panjang karena jam laptop dimundurkan.
    pub fn overview(&self, now: OffsetDateTime) -> AppResult<SignOverview> {
        let me = self.me();
        let (org_id, row) = self.membership()?;
        let kind = row
            .as_ref()
            .map(MemberRow::signer_kind)
            .unwrap_or(SignerKind::Member);
        let can_request =
            org_id.is_some() && row.as_ref().is_some_and(|r| r.is_active() && !r.is_guest());
        let display_name = self
            .identity
            .display_name()
            .map(str::to_owned)
            .or_else(|| row.as_ref().map(|r| r.display_name.clone()))
            .unwrap_or_default();
        let mut requests = Vec::new();
        for req in repo::list_requests(self.db())? {
            let integrity = blob_integrity(self.store, &req.current_hash);
            let exports = self.export_views(&req.id)?;
            requests.push(summary(&req, me, integrity, &exports));
        }
        Ok(SignOverview {
            saved: vault::status(self.db(), me, now)?,
            requests,
            can_request,
            me: Me {
                public_key: me.to_owned(),
                display_name,
                kind,
            },
        })
    }

    /// Menyimpan gambar tanda tangan (PNG base64) yang dikunci `pin`.
    pub fn save_signature(
        &mut self,
        pin: &str,
        png_base64: &str,
        now: OffsetDateTime,
    ) -> AppResult<SavedSignatureInfo> {
        self.ensure_not_removed()?;
        let encoded = png_base64.trim();
        if encoded.len() > MAX_PNG_BASE64_LEN {
            return Err(err(
                "image_invalid",
                "Gambar tanda tangan terlalu besar. Batasnya 1 MB.",
            ));
        }
        let png = Zeroizing::new(BASE64.decode(encoded.as_bytes()).map_err(|_| {
            err(
                "image_invalid",
                "Gambar tanda tangan tidak terbaca. Gambar ulang atau impor gambar PNG lain.",
            )
        })?);
        let identity = self.identity;
        let at = now_str(now);
        let tx = self.conn.transaction()?;
        let info = vault::save(&tx, identity, pin, &png, now, &self.kdf)?;
        let mut detail = format!("{}x{} piksel", info.width, info.height);
        if info.usable_after.is_some() {
            detail.push_str(", masa tunggu 24 jam karena tanda tangan lama dihapus tanpa PIN");
        }
        store_event(
            identity,
            &tx,
            &EventRecord {
                detail,
                ..new_event(identity, None, EventKind::SignatureSaved, &at)
            },
        )?;
        tx.commit()?;
        Ok(info)
    }

    /// Menghapus tanda tangan tersimpan. Dengan `pin`: PIN diperiksa seperti
    /// `unlock` dan tanda tangan baru bisa langsung dipakai. Tanpa PIN (lupa
    /// PIN): tanda tangan baru baru bisa dipakai 24 jam setelah penghapusan
    /// (lihat `vault`). Tidak ada yang dihapus juga dianggap berhasil.
    pub fn delete_signature(&mut self, pin: Option<&str>, now: OffsetDateTime) -> AppResult<()> {
        self.ensure_not_removed()?;
        let identity = self.identity;
        let at = now_str(now);
        let event = |detail: &str| EventRecord {
            detail: detail.to_owned(),
            ..new_event(identity, None, EventKind::SignatureDeleted, &at)
        };
        match pin {
            Some(pin) => {
                vault::delete_with_pin(self.conn, identity, pin, now, |tx| {
                    store_event(identity, tx, &event("dengan PIN"))
                })?;
            }
            None => {
                let tx = self.conn.transaction()?;
                if vault::delete_forgot_pin(&tx, identity.public_key_hex(), now)? {
                    store_event(
                        identity,
                        &tx,
                        &event("tanpa PIN (lupa PIN), masa tunggu 24 jam"),
                    )?;
                }
                tx.commit()?;
            }
        }
        Ok(())
    }

    /// Membuka gambar tanda tangan dengan PIN dan menerbitkan token sekali
    /// pakai untuk `complete`.
    pub fn unlock(&mut self, pin: &str, now: OffsetDateTime) -> AppResult<UnlockResult> {
        self.ensure_not_removed()?;
        let unlocked = vault::unlock(self.conn, self.identity, pin, now)?;
        let (token, signed_at) = self.sessions.issue(self.identity.public_key_hex(), now);
        Ok(UnlockResult {
            token,
            png_base64: BASE64.encode(&unlocked.png),
            signed_at,
            width: unlocked.width,
            height: unlocked.height,
        })
    }

    /// Anggota aktif organisasi yang bisa dipilih sebagai penanda tangan
    /// (laptop ini lebih dulu, lalu urut nama).
    pub fn list_candidates(&self) -> AppResult<Vec<Candidate>> {
        let Some(org) = org::load_organization(self.db())? else {
            return Ok(Vec::new());
        };
        let me = self.me();
        let mut out: Vec<Candidate> = repo::active_members(self.db(), &org.id)?
            .into_iter()
            .map(|m| {
                let is_me = m.public_key == me;
                Candidate {
                    display_name: match self.identity.display_name() {
                        Some(name) if is_me => name.to_owned(),
                        _ => m.display_name.clone(),
                    },
                    kind: m.signer_kind(),
                    is_me,
                    public_key: m.public_key,
                }
            })
            .collect();
        out.sort_by_key(|c| !c.is_me);
        Ok(out)
    }

    /// Menyimpan PDF yang dibuka ke penyimpanan Mira.
    pub fn import_pdf(&self, bytes: &[u8], file_name: &str) -> AppResult<ImportedPdf> {
        check_pdf(
            bytes,
            MAX_PDF_BYTES,
            IMPORT_TOO_LARGE,
            "File yang dipilih bukan PDF yang valid. Pilih file PDF lain.",
        )?;
        let file_hash = self.store.put(bytes)?;
        Ok(ImportedPdf {
            file_hash,
            size: bytes.len(),
            file_name: clean_file_name(file_name),
            page_count: None,
        })
    }

    /// Membuat permintaan tanda tangan atas PDF `file_hash` yang sudah
    /// diimpor. `signers` berisi kunci publik, berurutan.
    pub fn create_request(
        &mut self,
        title: &str,
        file_hash: &str,
        mode: &str,
        signers: &[String],
        now: OffsetDateTime,
    ) -> AppResult<RequestDetail> {
        let mode = SignMode::parse(mode).ok_or_else(|| {
            err(
                "request_invalid",
                "Pilih urutan tanda tangan: berurutan atau bebas.",
            )
        })?;
        let me = self.me().to_owned();
        let (Some(org_id), my_row) = self.membership()? else {
            return Err(err(
                "request_invalid",
                "Laptop ini belum tergabung dalam organisasi. Buat atau gabung organisasi dulu sebelum meminta tanda tangan.",
            ));
        };
        let Some(my_row) = my_row else {
            return Err(err(
                "request_invalid",
                "Laptop ini belum terdaftar sebagai anggota organisasi, jadi belum bisa meminta tanda tangan.",
            ));
        };
        let requester = Requester {
            public_key: me.clone(),
            kind: my_row.signer_kind(),
            active: my_row.is_active(),
        };
        if !requester.active || requester.kind == SignerKind::Guest {
            // `validate_new` menolak pengirim seperti ini sebelum memeriksa
            // isi permintaan, jadi pesannya tepat (Tamu atau dikeluarkan).
            request::validate_new(
                &requester,
                &NewRequest {
                    title: String::new(),
                    mode,
                    signers: Vec::new(),
                },
            )?;
        }

        let original = if seal::is_hash_hex(file_hash) {
            self.store.get(file_hash)?
        } else {
            None
        };
        match seal::check_bytes(file_hash, original.as_deref()) {
            Integrity::Intact => {}
            Integrity::Missing => {
                return Err(AppError::NotFound(
                    "File PDF untuk permintaan ini tidak ditemukan di Mira. Buka file PDF-nya lagi."
                        .into(),
                ));
            }
            Integrity::Changed => {
                return Err(err(
                    "pdf_invalid",
                    "File PDF yang dibuka sudah berubah di penyimpanan Mira. Buka file PDF-nya lagi.",
                ));
            }
        }

        let mut inputs = Vec::with_capacity(signers.len());
        for (i, pk) in signers.iter().enumerate() {
            let row = repo::member(self.db(), &org_id, pk)?
                .filter(MemberRow::is_active)
                .ok_or_else(|| {
                    err(
                        "request_invalid",
                        format!(
                            "Penanda tangan ke-{} bukan anggota aktif organisasi. Pilih ulang penanda tangan dari daftar.",
                            i + 1
                        ),
                    )
                })?;
            let display_name = match self.identity.display_name() {
                Some(name) if row.public_key == me => name.to_owned(),
                _ => row.display_name.clone(),
            };
            inputs.push(SignerInput {
                kind: row.signer_kind(),
                public_key: row.public_key,
                display_name,
            });
        }
        let new = NewRequest {
            title: title.to_owned(),
            mode,
            signers: inputs,
        };
        request::validate_new(&requester, &new)?;

        let at = now_str(now);
        let req = SignRequest::new(random_id(), new, me, file_hash.to_owned(), &at);
        let identity = self.identity;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        repo::save_request(&tx, &req)?;
        store_event(
            identity,
            &tx,
            &EventRecord {
                hash_after: Some(req.original_hash.clone()),
                detail: format!(
                    "{}, {} penanda tangan",
                    mode_label(req.mode),
                    req.signers.len()
                ),
                ..new_event(identity, Some(&req.id), EventKind::Created, &at)
            },
        )?;
        tx.commit()?;
        self.outbox.request_created(&req)?;
        self.detail(&req)
    }

    /// Rincian satu permintaan.
    pub fn get_request(&self, id: &str) -> AppResult<RequestDetail> {
        let req = self.load(id)?;
        self.detail(&req)
    }

    /// Isi file versi `hash` milik permintaan `id`, apa adanya (tanpa
    /// verifikasi; keadaan file terlihat di `integrity`).
    pub fn read_file(&self, id: &str, hash: &str) -> AppResult<Vec<u8>> {
        let req = self.load(id)?;
        let known = hash == req.original_hash
            || hash == req.current_hash
            || req
                .signers
                .iter()
                .any(|s| s.hash_after.as_deref() == Some(hash));
        if !known {
            return Err(AppError::NotFound(
                "File itu bukan bagian dari permintaan tanda tangan ini. Muat ulang dokumen."
                    .into(),
            ));
        }
        self.store.get(hash)?.ok_or_else(|| {
            AppError::NotFound(
                "File PDF ini tidak ditemukan di penyimpanan Mira. Mungkin terhapus di luar Mira."
                    .into(),
            )
        })
    }

    /// Menyimpan versi bertanda tangan buatan frontend.
    ///
    /// `token` dari `unlock` (sekali pakai; waktu terbitnya menjadi waktu
    /// tanda tangan resmi), `base_hash` = versi yang distempel (harus versi
    /// terkini, dan file-nya di penyimpanan masih utuh), `bytes` = PDF hasil
    /// stempel (paling besar `MAX_SIGNED_PDF_BYTES`) yang memuat
    /// `mira-doc:<id>` di mana saja (penanda lama dari ekspor sebelumnya
    /// boleh ada di depannya).
    pub fn complete(
        &mut self,
        request_id: &str,
        token: &str,
        base_hash: &str,
        bytes: &[u8],
        now: OffsetDateTime,
    ) -> AppResult<RequestDetail> {
        let me = self.me().to_owned();
        let signed_at = self.sessions.take(token, &me, now)?;
        let mut req = self.load(request_id)?;
        self.ensure_not_removed()?;
        req.can_sign(&me)?;
        if base_hash != req.current_hash {
            return Err(err(
                "version_conflict",
                "Dokumen ini sudah berubah sejak Anda membukanya, misalnya sudah ditandatangani orang lain. Muat ulang dokumen, lalu tanda tangani versi terbaru.",
            ));
        }
        check_pdf(
            bytes,
            MAX_SIGNED_PDF_BYTES,
            SIGNED_TOO_LARGE,
            "File hasil tanda tangan bukan PDF yang valid. Ulangi tanda tangan dari layar Mira.",
        )?;
        if !seal::contains_doc_tag(bytes, &req.id) {
            return Err(err(
                "tag_missing",
                "File hasil tanda tangan tidak memuat penanda dokumen Mira untuk permintaan ini. Ulangi tanda tangan dari layar Mira.",
            ));
        }
        match blob_integrity(self.store, &req.current_hash) {
            Integrity::Intact => {}
            Integrity::Changed => {
                return Err(err(
                    "pdf_invalid",
                    "File versi sebelumnya di penyimpanan Mira sudah berubah sejak dicatat, jadi tanda tangan tidak bisa disimpan di atasnya. Minta pengirim atau penanda tangan sebelumnya mengirim ulang filenya.",
                ));
            }
            Integrity::Missing => {
                return Err(err(
                    "pdf_invalid",
                    "File versi sebelumnya tidak ditemukan di penyimpanan Mira, jadi tanda tangan tidak bisa disimpan di atasnya. Minta pengirim atau penanda tangan sebelumnya mengirim ulang filenya.",
                ));
            }
        }
        if seal::hash_hex(bytes) == req.current_hash {
            return Err(err(
                "pdf_invalid",
                "File hasil tanda tangan sama persis dengan versi sebelumnya, jadi tanda tangan belum masuk. Tempatkan tanda tangan lalu simpan lagi.",
            ));
        }
        let new_hash = self.store.put(bytes)?;
        let before = req.current_hash.clone();
        req.record_signature(&me, &signed_at, &new_hash)?;
        let position = req
            .signers
            .iter()
            .find(|s| s.public_key == me)
            .map_or(0, |s| s.position + 1);
        let total = req.signers.len();

        let identity = self.identity;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        repo::save_request(&tx, &req)?;
        store_event(
            identity,
            &tx,
            &EventRecord {
                hash_before: Some(before),
                hash_after: Some(new_hash.clone()),
                detail: format!("penanda tangan ke-{position} dari {total}"),
                ..new_event(identity, Some(&req.id), EventKind::Signed, &signed_at)
            },
        )?;
        if req.status == RequestStatus::Completed {
            store_event(
                identity,
                &tx,
                &EventRecord {
                    hash_after: Some(new_hash.clone()),
                    detail: format!("{total} penanda tangan"),
                    ..new_event(identity, Some(&req.id), EventKind::Completed, &signed_at)
                },
            )?;
        }
        tx.commit()?;
        self.outbox.version_signed(&req, &me, &new_hash)?;
        self.detail(&req)
    }

    /// Pengirim membatalkan permintaan yang masih berjalan.
    pub fn cancel(&mut self, id: &str, now: OffsetDateTime) -> AppResult<RequestDetail> {
        self.ensure_not_removed()?;
        let mut req = self.load(id)?;
        let at = now_str(now);
        req.cancel(self.me(), &at)?;
        let identity = self.identity;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        repo::save_request(&tx, &req)?;
        store_event(
            identity,
            &tx,
            &EventRecord {
                hash_before: Some(req.current_hash.clone()),
                ..new_event(identity, Some(&req.id), EventKind::Cancelled, &at)
            },
        )?;
        tx.commit()?;
        self.outbox.request_cancelled(&req)?;
        self.detail(&req)
    }

    /// Menyimpan salinan versi terkini ke folder ekspor tanpa menimpa file.
    pub fn export(&mut self, id: &str, now: OffsetDateTime) -> AppResult<ExportResult> {
        let req = self.load(id)?;
        let bytes = self.store.get(&req.current_hash)?;
        match seal::check_bytes(&req.current_hash, bytes.as_deref()) {
            Integrity::Intact => {}
            Integrity::Changed => {
                return Err(err(
                    "export_failed",
                    "File versi terakhir di penyimpanan Mira sudah berubah sejak ditandatangani, jadi tidak diekspor. Minta penanda tangan terakhir mengirim ulang filenya.",
                ));
            }
            Integrity::Missing => {
                return Err(err(
                    "export_failed",
                    "File versi terakhir tidak ditemukan di penyimpanan Mira, jadi tidak bisa diekspor. Minta penanda tangan terakhir mengirim ulang filenya.",
                ));
            }
        }
        let bytes = bytes.unwrap_or_default();
        let path = write_unique(self.export_dir, &export_stem(&req), &bytes)?;
        let path_text = path.display().to_string();
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path_text.clone());
        let at = now_str(now);
        let identity = self.identity;
        let tx = self.conn.transaction()?;
        repo::upsert_export(&tx, &req.id, &path_text, &req.current_hash, &at)?;
        store_event(
            identity,
            &tx,
            &EventRecord {
                hash_after: Some(req.current_hash.clone()),
                detail: file_name,
                ..new_event(identity, Some(&req.id), EventKind::Exported, &at)
            },
        )?;
        tx.commit()?;
        Ok(ExportResult { path: path_text })
    }

    /// Mencocokkan file dari mana saja (paling besar `MAX_SIGNED_PDF_BYTES`)
    /// dengan yang tercatat di Mira.
    ///
    /// - `match_final`: permintaan selesai, hash sama dengan versi final, dan
    ///   rantai jejak audit utuh (`seal_chain_valid`: catatan `created`,
    ///   setiap `signed` dari kunci penanda tangannya sendiri dan bersambung
    ///   dari versi asli sampai versi final, lalu `completed` dari penanda
    ///   tangan terakhir). Mengubah `current_hash` atau status langsung di
    ///   database, atau menambah catatan dari kunci lain, tidak cukup.
    /// - `match_version`: hash sama dengan salah satu versi tercatat.
    ///   `signers` hanya berisi yang sudah menandatangani sampai versi itu
    ///   (urut waktu) dan `completed_at` kosong.
    /// - `changed`: hash tidak dikenal, tetapi file memuat penanda
    ///   `mira-doc:<id>` permintaan yang dikenal. Semua penanda yang valid
    ///   dicocokkan (file yang disimpan ulang aplikasi lain bisa membawa
    ///   penanda lama di depan); kalau lebih dari satu dikenal, dipilih yang
    ///   terakhir berubah.
    /// - `unknown`: selain itu.
    pub fn verify_file(&self, bytes: &[u8]) -> AppResult<VerifyResult> {
        if bytes.len() > MAX_SIGNED_PDF_BYTES {
            return Err(err("pdf_too_large", VERIFY_TOO_LARGE));
        }
        let file_hash = seal::hash_hex(bytes);
        let mut matches = Vec::new();
        for id in repo::find_ids_by_hash(self.db(), &file_hash)? {
            if let Some(req) = repo::load_request(self.db(), &id)? {
                matches.push(req);
            }
        }
        matches.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

        for req in &matches {
            if req.status == RequestStatus::Completed
                && req.current_hash == file_hash
                && seal_chain_valid(req, &repo::events_for(self.db(), &req.id)?)
            {
                let signers = req.signers.iter().collect();
                return Ok(verify_result(
                    VerifyState::MatchFinal,
                    file_hash,
                    Some(req),
                    req.completed_at.clone(),
                    signers,
                ));
            }
        }
        if let Some(req) = matches.first() {
            let signers = signers_up_to(req, &file_hash);
            return Ok(verify_result(
                VerifyState::MatchVersion,
                file_hash,
                Some(req),
                None,
                signers,
            ));
        }
        let mut tagged = Vec::new();
        for id in seal::find_all_mira_doc_ids(bytes) {
            if let Some(req) = repo::load_request(self.db(), &id)? {
                tagged.push(req);
            }
        }
        tagged.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        if let Some(req) = tagged.first() {
            let signers = req.signers.iter().collect();
            return Ok(verify_result(
                VerifyState::Changed,
                file_hash,
                Some(req),
                req.completed_at.clone(),
                signers,
            ));
        }
        Ok(verify_result(
            VerifyState::Unknown,
            file_hash,
            None,
            None,
            Vec::new(),
        ))
    }
}

fn verify_result(
    state: VerifyState,
    file_hash: String,
    req: Option<&SignRequest>,
    completed_at: Option<String>,
    signers: Vec<&Signer>,
) -> VerifyResult {
    VerifyResult {
        state,
        file_hash,
        request_id: req.map(|r| r.id.clone()),
        title: req.map(|r| r.title.clone()),
        completed_at,
        signers: signers
            .into_iter()
            .map(|s| VerifySigner {
                display_name: s.display_name.clone(),
                signed_at: s.signed_at.clone(),
            })
            .collect(),
    }
}
