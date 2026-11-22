//! Documents, versions, the version graph, restore, conflict resolution and
//! this laptop's edit-session rows (plan, bagian 3.3).
//!
//! Every function takes the connection from the caller and times as RFC 3339
//! strings, so the same code serves the Tauri commands, the save watcher and
//! the network stage.
//!
//! Version graph: each version lists its parents in
//! `document_version_parents`. A head is a version of the document that no
//! other version of that document names as a parent. One head is normal;
//! more than one head is a conflict ("bentrok"). `current` is the head with
//! the highest `seq`. `seq` is a display number local to this laptop
//! ("Versi 3"), the next one is `max + 1` per document.
//!
//! The views for the frontend (`summary`, `detail`, `summaries`) live in
//! `documents::view` and are re-exported here.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use rand_core::{OsRng, RngCore};
use rusqlite::{Connection, OptionalExtension, Row, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

use crate::blobs::{BlobHash, BlobInfo};
use crate::documents::kinds::DocumentKind;
use crate::error::{AppError, AppResult};
use crate::org::is_lower_hex;

pub use crate::documents::view::{
    DocumentCan, DocumentDetail, DocumentSummary, DocumentVersion, EditingInfo, PersonRef, detail,
    summaries, summary,
};

/// Length of document and version ids as hex text.
pub const ID_HEX_LEN: usize = 32;
/// Length of a public key as hex text.
pub const KEY_HEX_LEN: usize = 64;
/// Longest file name, in characters (also a CHECK in the schema).
pub const NAME_MAX_CHARS: usize = 255;

/// Where a document lives. Both `None` = the organization's general library
/// ("Umum") until projects exist.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocScope {
    pub team_id: Option<String>,
    pub project_id: Option<String>,
}

/// How a version came to be.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VersionOrigin {
    /// First version, from "Tambah file".
    Added,
    /// Saved from Word or Excel.
    Edited,
    /// "Pulihkan": the content of an older version.
    Restored,
    /// Conflict resolved ("Pakai versi ini" or a merge save with several parents).
    Resolved,
}

impl VersionOrigin {
    pub fn as_str(self) -> &'static str {
        match self {
            VersionOrigin::Added => "added",
            VersionOrigin::Edited => "edited",
            VersionOrigin::Restored => "restored",
            VersionOrigin::Resolved => "resolved",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "added" => Some(VersionOrigin::Added),
            "edited" => Some(VersionOrigin::Edited),
            "restored" => Some(VersionOrigin::Restored),
            "resolved" => Some(VersionOrigin::Resolved),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRecord {
    pub id: String,
    pub team_id: Option<String>,
    pub project_id: Option<String>,
    pub name: String,
    pub kind: DocumentKind,
    pub created_by: String,
    pub created_at: String,
}

impl DocumentRecord {
    pub fn scope(&self) -> DocScope {
        DocScope {
            team_id: self.team_id.clone(),
            project_id: self.project_id.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionRecord {
    pub id: String,
    pub document_id: String,
    pub seq: i64,
    pub blob: BlobInfo,
    pub author: String,
    pub created_at: String,
    pub origin: VersionOrigin,
    pub restored_from: Option<String>,
    /// Set when the version came from a rekan (the time it arrived here).
    pub received_at: Option<String>,
    /// Sorted. May name versions this laptop has not received yet.
    pub parent_ids: Vec<String>,
}

/// This laptop's open edit of a document in Office (at most one per document).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EditSession {
    pub document_id: String,
    pub editor: String,
    /// The parents of the next saved version: the version the edit started
    /// from, or every head for a manual merge; after each save, that version.
    pub parent_ids: Vec<String>,
    pub working_path: PathBuf,
    pub started_at: String,
    /// Hash of the working copy as last seen (start or last saved version).
    pub last_hash: BlobHash,
    pub last_saved_at: Option<String>,
    /// An Office lock file (`~$name`) was seen for the working copy.
    pub lock_seen: bool,
}

/// 16 random bytes as 32 lowercase hex characters.
pub fn new_id() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

// ---------------------------------------------------------------------------
// Names

const RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];
const FORBIDDEN_CHARS: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

fn invalid_name(detail: &str) -> AppError {
    AppError::InvalidInput(format!("Nama file tidak bisa dipakai: {detail}."))
}

/// A file name that is safe on Windows: the directory part is dropped,
/// surrounding spaces and trailing dots are trimmed, and names that Windows
/// cannot store are refused with `invalid_input`.
pub fn sanitize_file_name(raw: &str) -> AppResult<String> {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    let name = base.trim().trim_end_matches(['.', ' ']);
    if name.is_empty() {
        return Err(invalid_name("nama kosong"));
    }
    if name.chars().any(|c| c.is_control()) {
        return Err(invalid_name("ada karakter kontrol"));
    }
    if let Some(c) = name.chars().find(|c| FORBIDDEN_CHARS.contains(c)) {
        return Err(invalid_name(&format!(
            "karakter {c} tidak boleh ada di nama file"
        )));
    }
    let stem = name.split('.').next().unwrap_or(name).trim_end();
    if RESERVED_NAMES.iter().any(|r| r.eq_ignore_ascii_case(stem)) {
        return Err(invalid_name(&format!("{stem} adalah nama khusus Windows")));
    }
    if name.chars().count() > NAME_MAX_CHARS {
        return Err(invalid_name(&format!(
            "nama lebih dari {NAME_MAX_CHARS} karakter"
        )));
    }
    Ok(name.to_owned())
}

/// Splits "Laporan.docx" into ("Laporan", ".docx"). A leading dot alone is
/// not an extension.
fn split_extension(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => name.split_at(i),
        _ => (name, ""),
    }
}

/// `wanted` if no document in the same project scope has that name (ignoring
/// case), otherwise "name (2).ext", "name (3).ext", ... `project_id` NULL (the
/// general library) is its own scope. The stem is shortened if the result
/// would exceed the name limit.
pub fn unique_name(conn: &Connection, scope: &DocScope, wanted: &str) -> AppResult<String> {
    let mut stmt = conn.prepare("SELECT name FROM documents WHERE project_id IS ?1")?;
    let taken: HashSet<String> = stmt
        .query_map(params![scope.project_id], |r| r.get::<_, String>(0))?
        .map(|n| n.map(|n| n.to_lowercase()))
        .collect::<Result<_, _>>()?;
    if !taken.contains(&wanted.to_lowercase()) {
        return Ok(wanted.to_owned());
    }
    let (stem, ext) = split_extension(wanted);
    for n in 2u64.. {
        let suffix = format!(" ({n}){ext}");
        let room = NAME_MAX_CHARS.saturating_sub(suffix.chars().count());
        let stem: String = stem.chars().take(room).collect();
        let candidate = format!("{}{suffix}", stem.trim_end());
        if !taken.contains(&candidate.to_lowercase()) {
            return Ok(candidate);
        }
    }
    unreachable!("an unused suffix always exists")
}

// ---------------------------------------------------------------------------
// Validation helpers (shared with `sync`)

pub(crate) fn check_id(id: &str, what: &str) -> AppResult<()> {
    if is_lower_hex(id, ID_HEX_LEN) {
        Ok(())
    } else {
        Err(AppError::InvalidInput(format!(
            "Id {what} tidak valid: harus 32 karakter hex huruf kecil."
        )))
    }
}

pub(crate) fn check_key(key: &str, what: &str) -> AppResult<()> {
    if is_lower_hex(key, KEY_HEX_LEN) {
        Ok(())
    } else {
        Err(AppError::InvalidInput(format!(
            "Kunci {what} tidak valid: harus 64 karakter hex huruf kecil."
        )))
    }
}

fn size_to_db(size: u64) -> AppResult<i64> {
    i64::try_from(size).map_err(|_| AppError::InvalidInput("Ukuran file terlalu besar.".into()))
}

fn document_not_found() -> AppError {
    AppError::NotFound("Dokumen tidak ditemukan di laptop ini.".into())
}

fn version_not_found() -> AppError {
    AppError::NotFound("Versi dokumen tidak ditemukan di laptop ini.".into())
}

fn editing_here() -> AppError {
    AppError::DocumentEditing(
        "Dokumen ini sedang Anda edit. Tutup file di Office dan pilih Selesai mengedit dulu."
            .into(),
    )
}

fn corrupt(detail: impl std::fmt::Display) -> AppError {
    AppError::Database(format!(
        "Data dokumen di database lokal tidak lengkap. Detail: {detail}"
    ))
}

// ---------------------------------------------------------------------------
// Documents

const DOC_COLUMNS: &str = "id, team_id, project_id, name, kind, created_by, created_at";

fn doc_from_row(r: &Row<'_>) -> rusqlite::Result<(DocumentRecord, String)> {
    let kind: String = r.get(4)?;
    Ok((
        DocumentRecord {
            id: r.get(0)?,
            team_id: r.get(1)?,
            project_id: r.get(2)?,
            name: r.get(3)?,
            kind: DocumentKind::Other,
            created_by: r.get(5)?,
            created_at: r.get(6)?,
        },
        kind,
    ))
}

fn finish_doc((mut doc, kind): (DocumentRecord, String)) -> AppResult<DocumentRecord> {
    doc.kind = DocumentKind::parse(&kind).ok_or_else(|| corrupt(format!("jenis {kind}")))?;
    Ok(doc)
}

pub(crate) fn insert_document_row(conn: &Connection, doc: &DocumentRecord) -> AppResult<()> {
    conn.execute(
        "INSERT INTO documents (id, team_id, project_id, name, kind, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            doc.id,
            doc.team_id,
            doc.project_id,
            doc.name,
            doc.kind.as_str(),
            doc.created_by,
            doc.created_at
        ],
    )?;
    Ok(())
}

/// Adds a file to the library: the document plus version 1 (origin `added`,
/// no parents). `name` goes through [`sanitize_file_name`] and
/// [`unique_name`] inside the same transaction, so the returned record holds
/// the final name. The blob must already be in the blob store.
pub fn create_document(
    conn: &mut Connection,
    scope: &DocScope,
    name: &str,
    blob: &BlobInfo,
    author: &str,
    now: &str,
) -> AppResult<(DocumentRecord, VersionRecord)> {
    check_key(author, "penulis")?;
    let name = sanitize_file_name(name)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let name = unique_name(&tx, scope, &name)?;
    let doc = DocumentRecord {
        id: new_id(),
        team_id: scope.team_id.clone(),
        project_id: scope.project_id.clone(),
        kind: DocumentKind::from_file_name(&name),
        name,
        created_by: author.to_owned(),
        created_at: now.to_owned(),
    };
    insert_document_row(&tx, &doc)?;
    let version = insert_version(
        &tx,
        &NewVersion {
            id: new_id(),
            document_id: &doc.id,
            parent_ids: &[],
            blob_hash: blob.hash.as_str(),
            size: blob.size,
            author,
            created_at: now,
            origin: VersionOrigin::Added,
            restored_from: None,
            received_at: None,
        },
    )?;
    tx.commit()?;
    Ok((doc, version))
}

pub fn get_document(conn: &Connection, id: &str) -> AppResult<DocumentRecord> {
    let row = conn
        .query_row(
            &format!("SELECT {DOC_COLUMNS} FROM documents WHERE id = ?1"),
            params![id],
            doc_from_row,
        )
        .optional()?
        .ok_or_else(document_not_found)?;
    finish_doc(row)
}

pub(crate) fn document_exists(conn: &Connection, id: &str) -> AppResult<bool> {
    Ok(conn
        .query_row("SELECT 1 FROM documents WHERE id = ?1", params![id], |_| {
            Ok(())
        })
        .optional()?
        .is_some())
}

/// Documents of one library: `None` = the general library (`project_id`
/// NULL), not "all". Sorted by name (ASCII case-insensitive), then id.
pub fn list_documents(
    conn: &Connection,
    project_id: Option<&str>,
) -> AppResult<Vec<DocumentRecord>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {DOC_COLUMNS} FROM documents WHERE project_id IS ?1
         ORDER BY name COLLATE NOCASE, id"
    ))?;
    let rows = stmt
        .query_map(params![project_id], doc_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter().map(finish_doc).collect()
}

// ---------------------------------------------------------------------------
// Versions

const VERSION_COLUMNS: &str =
    "id, document_id, seq, blob_hash, size, author, created_at, origin, restored_from, received_at";

struct VersionRow {
    id: String,
    document_id: String,
    seq: i64,
    blob_hash: String,
    size: i64,
    author: String,
    created_at: String,
    origin: String,
    restored_from: Option<String>,
    received_at: Option<String>,
}

fn version_row(r: &Row<'_>) -> rusqlite::Result<VersionRow> {
    Ok(VersionRow {
        id: r.get(0)?,
        document_id: r.get(1)?,
        seq: r.get(2)?,
        blob_hash: r.get(3)?,
        size: r.get(4)?,
        author: r.get(5)?,
        created_at: r.get(6)?,
        origin: r.get(7)?,
        restored_from: r.get(8)?,
        received_at: r.get(9)?,
    })
}

fn finish_version(row: VersionRow, parent_ids: Vec<String>) -> AppResult<VersionRecord> {
    let origin =
        VersionOrigin::parse(&row.origin).ok_or_else(|| corrupt(format!("asal {}", row.origin)))?;
    let hash = BlobHash::parse(&row.blob_hash).map_err(|_| corrupt("hash isi versi"))?;
    let size = u64::try_from(row.size).map_err(|_| corrupt("ukuran versi"))?;
    Ok(VersionRecord {
        id: row.id,
        document_id: row.document_id,
        seq: row.seq,
        blob: BlobInfo { hash, size },
        author: row.author,
        created_at: row.created_at,
        origin,
        restored_from: row.restored_from,
        received_at: row.received_at,
        parent_ids,
    })
}

fn parents_of(conn: &Connection, version_id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT parent_id FROM document_version_parents WHERE version_id = ?1 ORDER BY parent_id",
    )?;
    let ids = stmt
        .query_map(params![version_id], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    Ok(ids)
}

/// Parent lists of every version of a document, in one query.
fn parents_by_version(
    conn: &Connection,
    document_id: &str,
) -> AppResult<HashMap<String, Vec<String>>> {
    let mut stmt = conn.prepare(
        "SELECT p.version_id, p.parent_id
         FROM document_version_parents p JOIN document_versions v ON v.id = p.version_id
         WHERE v.document_id = ?1 ORDER BY p.version_id, p.parent_id",
    )?;
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    let rows = stmt.query_map(params![document_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (version, parent) = row?;
        map.entry(version).or_default().push(parent);
    }
    Ok(map)
}

fn versions_where(
    conn: &Connection,
    document_id: &str,
    filter: &str,
) -> AppResult<Vec<VersionRecord>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {VERSION_COLUMNS} FROM document_versions v
         WHERE v.document_id = ?1 {filter} ORDER BY v.seq DESC"
    ))?;
    let rows = stmt
        .query_map(params![document_id], version_row)?
        .collect::<Result<Vec<_>, _>>()?;
    let mut parents = parents_by_version(conn, document_id)?;
    rows.into_iter()
        .map(|row| {
            let p = parents.remove(&row.id).unwrap_or_default();
            finish_version(row, p)
        })
        .collect()
}

/// Every version of a document, newest first (`seq` descending).
pub fn versions(conn: &Connection, document_id: &str) -> AppResult<Vec<VersionRecord>> {
    versions_where(conn, document_id, "")
}

pub fn get_version(conn: &Connection, version_id: &str) -> AppResult<VersionRecord> {
    let row = conn
        .query_row(
            &format!("SELECT {VERSION_COLUMNS} FROM document_versions WHERE id = ?1"),
            params![version_id],
            version_row,
        )
        .optional()?
        .ok_or_else(version_not_found)?;
    let parents = parents_of(conn, &row.id)?;
    finish_version(row, parents)
}

/// Versions of the document that no other version of it names as a parent,
/// `seq` descending. More than one = conflict.
pub fn heads(conn: &Connection, document_id: &str) -> AppResult<Vec<VersionRecord>> {
    versions_where(
        conn,
        document_id,
        "AND NOT EXISTS (
             SELECT 1 FROM document_version_parents p
             JOIN document_versions c ON c.id = p.version_id
             WHERE p.parent_id = v.id AND c.document_id = v.document_id)",
    )
}

/// The head with the highest `seq`. `not_found` when the document has no
/// version on this laptop yet (a document announced by a rekan whose first
/// version has not arrived).
pub fn current(conn: &Connection, document_id: &str) -> AppResult<VersionRecord> {
    if let Some(head) = heads(conn, document_id)?.into_iter().next() {
        return Ok(head);
    }
    // Only reachable with a malformed graph (a cycle from a rekan); fall back
    // to the newest version rather than showing nothing.
    versions(conn, document_id)?
        .into_iter()
        .next()
        .ok_or_else(|| {
            if document_exists(conn, document_id).unwrap_or(false) {
                AppError::NotFound("Isi dokumen ini belum diterima dari rekan.".into())
            } else {
                document_not_found()
            }
        })
}

/// Fields of a version to insert; shared by local saves and `sync`.
pub(crate) struct NewVersion<'a> {
    pub id: String,
    pub document_id: &'a str,
    pub parent_ids: &'a [String],
    pub blob_hash: &'a str,
    pub size: u64,
    pub author: &'a str,
    pub created_at: &'a str,
    pub origin: VersionOrigin,
    pub restored_from: Option<&'a str>,
    pub received_at: Option<&'a str>,
}

/// Inserts a version with the next local `seq` and its parent rows. The
/// caller validates the fields and owns the transaction.
pub(crate) fn insert_version(conn: &Connection, v: &NewVersion<'_>) -> AppResult<VersionRecord> {
    let seq: i64 = conn.query_row(
        "SELECT coalesce(max(seq), 0) + 1 FROM document_versions WHERE document_id = ?1",
        params![v.document_id],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO document_versions
             (id, document_id, seq, blob_hash, size, author, created_at, origin, restored_from, received_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            v.id,
            v.document_id,
            seq,
            v.blob_hash,
            size_to_db(v.size)?,
            v.author,
            v.created_at,
            v.origin.as_str(),
            v.restored_from,
            v.received_at
        ],
    )?;
    let mut parent_ids: Vec<String> = v.parent_ids.to_vec();
    parent_ids.sort();
    parent_ids.dedup();
    for parent in &parent_ids {
        conn.execute(
            "INSERT INTO document_version_parents (version_id, parent_id) VALUES (?1, ?2)",
            params![v.id, parent],
        )?;
    }
    get_version(conn, &v.id)
}

/// `add_version` without its own transaction. Parents must be versions of
/// this document on this laptop.
#[allow(clippy::too_many_arguments)]
fn add_version_in(
    conn: &Connection,
    document_id: &str,
    parent_ids: &[String],
    blob: &BlobInfo,
    author: &str,
    origin: VersionOrigin,
    restored_from: Option<&str>,
    now: &str,
) -> AppResult<VersionRecord> {
    check_key(author, "penulis")?;
    if !document_exists(conn, document_id)? {
        return Err(document_not_found());
    }
    for parent in parent_ids {
        check_id(parent, "versi induk")?;
        let owner: Option<String> = conn
            .query_row(
                "SELECT document_id FROM document_versions WHERE id = ?1",
                params![parent],
                |r| r.get(0),
            )
            .optional()?;
        if owner.as_deref() != Some(document_id) {
            return Err(AppError::InvalidInput(
                "Versi induk bukan versi dari dokumen ini.".into(),
            ));
        }
    }
    if let Some(from) = restored_from {
        check_id(from, "versi asal")?;
    }
    insert_version(
        conn,
        &NewVersion {
            id: new_id(),
            document_id,
            parent_ids,
            blob_hash: blob.hash.as_str(),
            size: blob.size,
            author,
            created_at: now,
            origin,
            restored_from,
            received_at: None,
        },
    )
}

/// Adds a version made on this laptop. Parents must be versions of the same
/// document already stored here.
#[allow(clippy::too_many_arguments)]
pub fn add_version(
    conn: &mut Connection,
    document_id: &str,
    parent_ids: &[String],
    blob: &BlobInfo,
    author: &str,
    origin: VersionOrigin,
    restored_from: Option<&str>,
    now: &str,
) -> AppResult<VersionRecord> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let v = add_version_in(
        &tx,
        document_id,
        parent_ids,
        blob,
        author,
        origin,
        restored_from,
        now,
    )?;
    tx.commit()?;
    Ok(v)
}

fn head_ids(heads: &[VersionRecord]) -> Vec<String> {
    heads.iter().map(|h| h.id.clone()).collect()
}

/// "Pulihkan": a new version with the content of `version_id`, whose parents
/// are all current heads (so restoring also ends a conflict). Refused with
/// `document_editing` while this laptop edits the document, and with
/// `invalid_input` when the version already is the only head.
pub fn restore_version(
    conn: &mut Connection,
    document_id: &str,
    version_id: &str,
    author: &str,
    now: &str,
) -> AppResult<VersionRecord> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if !document_exists(&tx, document_id)? {
        return Err(document_not_found());
    }
    if edit_session(&tx, document_id)?.is_some() {
        return Err(editing_here());
    }
    let old = get_version(&tx, version_id)?;
    if old.document_id != document_id {
        return Err(version_not_found());
    }
    let heads = heads(&tx, document_id)?;
    if heads.len() == 1 && heads[0].id == old.id {
        return Err(AppError::InvalidInput(
            "Versi ini sudah menjadi versi sekarang.".into(),
        ));
    }
    let v = add_version_in(
        &tx,
        document_id,
        &head_ids(&heads),
        &old.blob,
        author,
        VersionOrigin::Restored,
        Some(&old.id),
        now,
    )?;
    tx.commit()?;
    Ok(v)
}

/// "Pakai versi ini": ends a conflict with a new version holding the content
/// of `keep_version_id`, whose parents are all heads (origin `resolved`).
/// `keep_version_id` must be one of the heads and the document must be in
/// conflict, otherwise `invalid_input`. Refused with `document_editing`
/// while this laptop edits the document (finish or merge there first).
pub fn resolve_conflict(
    conn: &mut Connection,
    document_id: &str,
    keep_version_id: &str,
    author: &str,
    now: &str,
) -> AppResult<VersionRecord> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if !document_exists(&tx, document_id)? {
        return Err(document_not_found());
    }
    if edit_session(&tx, document_id)?.is_some() {
        return Err(editing_here());
    }
    let heads = heads(&tx, document_id)?;
    if heads.len() < 2 {
        return Err(AppError::InvalidInput(
            "Dokumen ini tidak sedang bentrok.".into(),
        ));
    }
    let keep = heads
        .iter()
        .find(|h| h.id == keep_version_id)
        .ok_or_else(|| {
            AppError::InvalidInput("Versi yang dipilih bukan salah satu versi yang bentrok.".into())
        })?;
    let v = add_version_in(
        &tx,
        document_id,
        &head_ids(&heads),
        &keep.blob,
        author,
        VersionOrigin::Resolved,
        None,
        now,
    )?;
    tx.commit()?;
    Ok(v)
}

// ---------------------------------------------------------------------------
// Edit sessions

const SESSION_COLUMNS: &str = "document_id, editor, parent_ids, working_path, started_at, last_hash, last_saved_at, lock_seen";

struct SessionRow {
    document_id: String,
    editor: String,
    parent_ids: String,
    working_path: String,
    started_at: String,
    last_hash: String,
    last_saved_at: Option<String>,
    lock_seen: i64,
}

fn session_row(r: &Row<'_>) -> rusqlite::Result<SessionRow> {
    Ok(SessionRow {
        document_id: r.get(0)?,
        editor: r.get(1)?,
        parent_ids: r.get(2)?,
        working_path: r.get(3)?,
        started_at: r.get(4)?,
        last_hash: r.get(5)?,
        last_saved_at: r.get(6)?,
        lock_seen: r.get(7)?,
    })
}

fn finish_session(row: SessionRow) -> AppResult<EditSession> {
    Ok(EditSession {
        document_id: row.document_id,
        editor: row.editor,
        parent_ids: serde_json::from_str(&row.parent_ids)
            .map_err(|e| corrupt(format!("induk sesi edit: {e}")))?,
        working_path: PathBuf::from(row.working_path),
        started_at: row.started_at,
        last_hash: BlobHash::parse(&row.last_hash).map_err(|_| corrupt("hash sesi edit"))?,
        last_saved_at: row.last_saved_at,
        lock_seen: row.lock_seen != 0,
    })
}

pub fn edit_session(conn: &Connection, document_id: &str) -> AppResult<Option<EditSession>> {
    let row = conn
        .query_row(
            &format!("SELECT {SESSION_COLUMNS} FROM document_edit_sessions WHERE document_id = ?1"),
            params![document_id],
            session_row,
        )
        .optional()?;
    row.map(finish_session).transpose()
}

/// Every edit session on this laptop (for recovery at start), oldest first.
pub fn edit_sessions(conn: &Connection) -> AppResult<Vec<EditSession>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SESSION_COLUMNS} FROM document_edit_sessions ORDER BY started_at, document_id"
    ))?;
    let rows = stmt
        .query_map([], session_row)?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter().map(finish_session).collect()
}

/// Starts tracking an edit. `document_editing` if the document already has a
/// session on this laptop.
pub fn insert_edit_session(conn: &Connection, s: &EditSession) -> AppResult<()> {
    check_key(&s.editor, "editor")?;
    for parent in &s.parent_ids {
        check_id(parent, "versi induk")?;
    }
    if !document_exists(conn, &s.document_id)? {
        return Err(document_not_found());
    }
    if edit_session(conn, &s.document_id)?.is_some() {
        return Err(AppError::DocumentEditing(
            "Dokumen ini sudah sedang diedit di laptop ini.".into(),
        ));
    }
    let path = s.working_path.to_str().ok_or_else(|| {
        AppError::InvalidInput("Lokasi salinan kerja memakai karakter yang tidak didukung.".into())
    })?;
    let parents = serde_json::to_string(&s.parent_ids)
        .map_err(|e| AppError::Internal(format!("Induk sesi edit tidak bisa disimpan: {e}")))?;
    conn.execute(
        "INSERT INTO document_edit_sessions
             (document_id, editor, parent_ids, working_path, started_at, last_hash, last_saved_at, lock_seen)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            s.document_id,
            s.editor,
            parents,
            path,
            s.started_at,
            s.last_hash.as_str(),
            s.last_saved_at,
            s.lock_seen as i64
        ],
    )?;
    Ok(())
}

/// A save of the working copy settled. In one transaction: if the content is
/// the same as last seen, nothing happens (`None`); otherwise a new version
/// with the session's parents (origin `resolved` for a merge with several
/// parents, else `edited`), and the session moves on to that version.
/// `not_found` if there is no session.
pub fn record_saved_version(
    conn: &mut Connection,
    document_id: &str,
    blob: &BlobInfo,
    author: &str,
    now: &str,
) -> AppResult<Option<VersionRecord>> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let session = edit_session(&tx, document_id)?
        .ok_or_else(|| AppError::NotFound("Sesi edit untuk dokumen ini tidak ditemukan.".into()))?;
    if blob.hash == session.last_hash {
        return Ok(None);
    }
    let origin = if session.parent_ids.len() > 1 {
        VersionOrigin::Resolved
    } else {
        VersionOrigin::Edited
    };
    let v = add_version_in(
        &tx,
        document_id,
        &session.parent_ids,
        blob,
        author,
        origin,
        None,
        now,
    )?;
    let parents = serde_json::to_string(&[&v.id])
        .map_err(|e| AppError::Internal(format!("Induk sesi edit tidak bisa disimpan: {e}")))?;
    tx.execute(
        "UPDATE document_edit_sessions SET parent_ids = ?2, last_hash = ?3, last_saved_at = ?4
         WHERE document_id = ?1",
        params![document_id, parents, blob.hash.as_str(), now],
    )?;
    tx.commit()?;
    Ok(Some(v))
}

/// Marks that an Office lock file was seen. No-op without a session.
pub fn set_lock_seen(conn: &Connection, document_id: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE document_edit_sessions SET lock_seen = 1 WHERE document_id = ?1",
        params![document_id],
    )?;
    Ok(())
}

/// Ends tracking an edit. No-op without a session.
pub fn delete_edit_session(conn: &Connection, document_id: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM document_edit_sessions WHERE document_id = ?1",
        params![document_id],
    )?;
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::blobs::BlobStore;
    use crate::db;
    use crate::identity::{self, Identity, MemoryKeyStore};
    use crate::org;

    pub(crate) const T0: &str = "2026-11-22T08:00:00Z";
    pub(crate) const T1: &str = "2026-11-22T08:05:00Z";
    pub(crate) const T2: &str = "2026-11-22T08:10:00Z";
    pub(crate) const T3: &str = "2026-11-22T08:15:00Z";

    /// Stores `content` as a blob. A free function so tests can borrow
    /// `f.blobs` next to `&mut f.conn`.
    pub(crate) fn put(blobs: &BlobStore, content: &str) -> BlobInfo {
        blobs.put_bytes(content.as_bytes()).unwrap()
    }

    /// A laptop with an identity ("Sari"), an organization (superadmin) and a
    /// blob store, all in a temporary data folder.
    pub(crate) struct Fixture {
        pub tmp: tempfile::TempDir,
        pub conn: Connection,
        pub me: Identity,
        pub blobs: BlobStore,
    }

    impl Fixture {
        pub fn new() -> Self {
            let tmp = tempfile::tempdir().unwrap();
            let mut conn = db::open(tmp.path()).unwrap();
            let mut me = identity::ensure_identity(&conn, &MemoryKeyStore::new()).unwrap();
            identity::save_display_name(&mut conn, &mut me, "Sari").unwrap();
            org::create_organization(&mut conn, &me, "CV Maju Jaya").unwrap();
            let blobs = BlobStore::in_data_dir(tmp.path()).unwrap();
            Fixture {
                tmp,
                conn,
                me,
                blobs,
            }
        }

        pub fn pk(&self) -> String {
            self.me.public_key_hex().to_owned()
        }

        pub fn blob(&self, content: &str) -> BlobInfo {
            put(&self.blobs, content)
        }

        pub fn add(&mut self, name: &str, content: &str) -> (DocumentRecord, VersionRecord) {
            let blob = self.blob(content);
            let pk = self.pk();
            create_document(&mut self.conn, &DocScope::default(), name, &blob, &pk, T0).unwrap()
        }

        pub fn session(
            &self,
            doc: &DocumentRecord,
            parents: &[&str],
            start: &BlobInfo,
        ) -> EditSession {
            EditSession {
                document_id: doc.id.clone(),
                editor: self.pk(),
                parent_ids: parents.iter().map(|p| p.to_string()).collect(),
                working_path: self
                    .tmp
                    .path()
                    .join("working")
                    .join(&doc.id)
                    .join(&doc.name),
                started_at: T1.into(),
                last_hash: start.hash.clone(),
                last_saved_at: None,
                lock_seen: false,
            }
        }
    }

    fn ids(vs: &[VersionRecord]) -> Vec<String> {
        vs.iter().map(|v| v.id.clone()).collect()
    }

    fn sorted(mut v: Vec<String>) -> Vec<String> {
        v.sort();
        v
    }

    #[test]
    fn new_id_is_32_lowercase_hex_and_random() {
        let a = new_id();
        assert!(is_lower_hex(&a, 32), "{a}");
        assert_ne!(a, new_id());
    }

    #[test]
    fn sanitize_strips_directories_and_refuses_bad_names() {
        assert_eq!(sanitize_file_name("Laporan.docx").unwrap(), "Laporan.docx");
        assert_eq!(
            sanitize_file_name(r"C:\Users\Sari\Desktop\Laporan Q3.docx").unwrap(),
            "Laporan Q3.docx"
        );
        assert_eq!(sanitize_file_name("a/b/c.xlsx").unwrap(), "c.xlsx");
        assert_eq!(
            sanitize_file_name("  catatan.txt. . ").unwrap(),
            "catatan.txt"
        );
        assert_eq!(sanitize_file_name(".gitignore").unwrap(), ".gitignore");
        assert_eq!(sanitize_file_name("CONTOH.docx").unwrap(), "CONTOH.docx");
        assert_eq!(
            sanitize_file_name("Anggaran ä 2026.xlsx").unwrap(),
            "Anggaran ä 2026.xlsx"
        );

        for bad in [
            "",
            "   ",
            ".",
            "..",
            "dir/",
            r"dir\..",
            "CON",
            "con.txt",
            "Nul.docx",
            "COM1",
            "lpt9.xlsx",
            "aux .txt",
            "a<b.docx",
            "a>b",
            "a:b.docx",
            "a\"b",
            "a|b",
            "a?b",
            "a*b",
            "a\u{0}b",
            "baris\nbaru.docx",
            "tab\t.docx",
        ] {
            let err = sanitize_file_name(bad).unwrap_err();
            assert_eq!(err.code(), "invalid_input", "{bad:?}");
            assert!(!err.to_string().contains('\u{2014}'));
        }

        let long = format!("{}.docx", "a".repeat(250));
        assert_eq!(sanitize_file_name(&long).unwrap().chars().count(), 255);
        let too_long = format!("{}.docx", "a".repeat(251));
        assert_eq!(
            sanitize_file_name(&too_long).unwrap_err().code(),
            "invalid_input"
        );
    }

    #[test]
    fn new_document_is_version_1_without_parents() {
        let mut f = Fixture::new();
        let (doc, v1) = f.add("Laporan.docx", "isi 1");
        assert_eq!(doc.kind, DocumentKind::Word);
        assert_eq!(doc.name, "Laporan.docx");
        assert_eq!(doc.created_by, f.pk());
        assert_eq!(doc.scope(), DocScope::default());
        assert_eq!(v1.seq, 1);
        assert!(v1.parent_ids.is_empty());
        assert_eq!(v1.origin, VersionOrigin::Added);
        assert_eq!(v1.received_at, None);
        assert_eq!(v1.blob, f.blob("isi 1"));

        assert_eq!(get_document(&f.conn, &doc.id).unwrap(), doc);
        assert_eq!(get_version(&f.conn, &v1.id).unwrap(), v1);
        assert_eq!(heads(&f.conn, &doc.id).unwrap(), vec![v1.clone()]);
        assert_eq!(current(&f.conn, &doc.id).unwrap(), v1);
        assert_eq!(list_documents(&f.conn, None).unwrap(), vec![doc]);
        assert!(
            list_documents(&f.conn, Some(&"ab".repeat(16)))
                .unwrap()
                .is_empty()
        );

        assert_eq!(
            get_document(&f.conn, &"00".repeat(16)).unwrap_err().code(),
            "not_found"
        );
        assert_eq!(
            get_version(&f.conn, &"00".repeat(16)).unwrap_err().code(),
            "not_found"
        );
    }

    #[test]
    fn linear_versions_have_one_head() {
        let mut f = Fixture::new();
        let (doc, v1) = f.add("Anggaran.xlsx", "a");
        let pk = f.pk();
        let v2 = add_version(
            &mut f.conn,
            &doc.id,
            std::slice::from_ref(&v1.id),
            &put(&f.blobs, "b"),
            &pk,
            VersionOrigin::Edited,
            None,
            T1,
        )
        .unwrap();
        let v3 = add_version(
            &mut f.conn,
            &doc.id,
            std::slice::from_ref(&v2.id),
            &put(&f.blobs, "c"),
            &pk,
            VersionOrigin::Edited,
            None,
            T2,
        )
        .unwrap();
        assert_eq!((v2.seq, v3.seq), (2, 3));
        assert_eq!(v3.parent_ids, vec![v2.id.clone()]);
        assert_eq!(
            ids(&versions(&f.conn, &doc.id).unwrap()),
            vec![v3.id.clone(), v2.id.clone(), v1.id.clone()]
        );
        assert_eq!(ids(&heads(&f.conn, &doc.id).unwrap()), vec![v3.id.clone()]);
        assert_eq!(current(&f.conn, &doc.id).unwrap().id, v3.id);

        // Parents must be versions of this document.
        let (other, o1) = f.add("Lain.docx", "x");
        let err = add_version(
            &mut f.conn,
            &doc.id,
            std::slice::from_ref(&o1.id),
            &put(&f.blobs, "d"),
            &pk,
            VersionOrigin::Edited,
            None,
            T3,
        )
        .unwrap_err();
        assert_eq!(err.code(), "invalid_input");
        let err = add_version(
            &mut f.conn,
            &doc.id,
            &["zz".repeat(16)],
            &put(&f.blobs, "d"),
            &pk,
            VersionOrigin::Edited,
            None,
            T3,
        )
        .unwrap_err();
        assert_eq!(err.code(), "invalid_input");
        assert_eq!(versions(&f.conn, &doc.id).unwrap().len(), 3);
        assert_eq!(versions(&f.conn, &other.id).unwrap().len(), 1);
    }

    #[test]
    fn same_name_gets_a_suffix_within_the_same_scope() {
        let mut f = Fixture::new();
        let pk = f.pk();
        assert_eq!(f.add("Laporan.docx", "1").0.name, "Laporan.docx");
        assert_eq!(f.add("laporan.DOCX", "2").0.name, "laporan (2).DOCX");
        assert_eq!(f.add("Laporan.docx", "3").0.name, "Laporan (3).docx");
        assert_eq!(f.add("README", "4").0.name, "README");
        assert_eq!(f.add("readme", "5").0.name, "readme (2)");
        assert_eq!(f.add(".gitignore", "6").0.name, ".gitignore");
        assert_eq!(f.add(".gitignore", "7").0.name, ".gitignore (2)");

        // Another project is its own scope.
        let project = DocScope {
            team_id: Some("11".repeat(16)),
            project_id: Some("22".repeat(16)),
        };
        let (d, _) = create_document(
            &mut f.conn,
            &project,
            "Laporan.docx",
            &put(&f.blobs, "p"),
            &pk,
            T0,
        )
        .unwrap();
        assert_eq!(d.name, "Laporan.docx");
        assert_eq!(d.scope(), project);
        assert_eq!(
            list_documents(&f.conn, Some(&"22".repeat(16))).unwrap(),
            vec![d]
        );
        assert_eq!(
            unique_name(&f.conn, &project, "LAPORAN.docx").unwrap(),
            "LAPORAN (2).docx"
        );

        // Long names are shortened to fit the limit.
        let long = format!("{}.docx", "b".repeat(250));
        let first = f.add(&long, "l1").0.name;
        let second = f.add(&long, "l2").0.name;
        assert_eq!(first, long);
        assert_eq!(second.chars().count(), 255);
        assert!(second.ends_with(" (2).docx"), "{second}");

        // Sorted by name in the general library.
        let names: Vec<String> = list_documents(&f.conn, None)
            .unwrap()
            .into_iter()
            .map(|d| d.name)
            .collect();
        let mut expected = names.clone();
        expected.sort_by_key(|n| n.to_ascii_lowercase());
        assert_eq!(names, expected);
    }

    #[test]
    fn restore_makes_a_new_version_with_old_content_and_heads_as_parents() {
        let mut f = Fixture::new();
        let (doc, v1) = f.add("Surat.docx", "versi satu");
        let pk = f.pk();
        let v2 = add_version(
            &mut f.conn,
            &doc.id,
            std::slice::from_ref(&v1.id),
            &put(&f.blobs, "versi dua"),
            &pk,
            VersionOrigin::Edited,
            None,
            T1,
        )
        .unwrap();

        let err = restore_version(&mut f.conn, &doc.id, &v2.id, &pk, T2).unwrap_err();
        assert_eq!(
            err.code(),
            "invalid_input",
            "current version cannot be restored"
        );

        let v3 = restore_version(&mut f.conn, &doc.id, &v1.id, &pk, T2).unwrap();
        assert_eq!(v3.seq, 3);
        assert_eq!(v3.blob, v1.blob);
        assert_eq!(v3.parent_ids, vec![v2.id.clone()]);
        assert_eq!(v3.origin, VersionOrigin::Restored);
        assert_eq!(v3.restored_from.as_deref(), Some(v1.id.as_str()));
        assert_eq!(current(&f.conn, &doc.id).unwrap().id, v3.id);
        assert_eq!(
            versions(&f.conn, &doc.id).unwrap().len(),
            3,
            "history is kept"
        );

        let (other, o1) = f.add("Lain.docx", "x");
        assert_eq!(
            restore_version(&mut f.conn, &doc.id, &o1.id, &pk, T3)
                .unwrap_err()
                .code(),
            "not_found"
        );
        assert_eq!(
            restore_version(&mut f.conn, &"00".repeat(16), &v1.id, &pk, T3)
                .unwrap_err()
                .code(),
            "not_found"
        );
        assert_eq!(versions(&f.conn, &other.id).unwrap().len(), 1);
    }

    #[test]
    fn restore_is_refused_while_editing_here() {
        let mut f = Fixture::new();
        let (doc, v1) = f.add("Surat.docx", "satu");
        let pk = f.pk();
        let v2 = add_version(
            &mut f.conn,
            &doc.id,
            std::slice::from_ref(&v1.id),
            &put(&f.blobs, "dua"),
            &pk,
            VersionOrigin::Edited,
            None,
            T1,
        )
        .unwrap();
        let s = f.session(&doc, &[&v2.id], &v2.blob);
        insert_edit_session(&f.conn, &s).unwrap();

        let err = restore_version(&mut f.conn, &doc.id, &v1.id, &pk, T2).unwrap_err();
        assert_eq!(err.code(), "document_editing");
        assert!(!err.to_string().contains('\u{2014}'));
        assert_eq!(versions(&f.conn, &doc.id).unwrap().len(), 2);

        delete_edit_session(&f.conn, &doc.id).unwrap();
        restore_version(&mut f.conn, &doc.id, &v1.id, &pk, T2).unwrap();
    }

    #[test]
    fn edit_session_rows_round_trip() {
        let mut f = Fixture::new();
        let (doc, v1) = f.add("Surat.docx", "satu");
        assert_eq!(edit_session(&f.conn, &doc.id).unwrap(), None);
        let s = f.session(&doc, &[&v1.id], &v1.blob);
        insert_edit_session(&f.conn, &s).unwrap();
        assert_eq!(edit_session(&f.conn, &doc.id).unwrap(), Some(s.clone()));
        assert_eq!(edit_sessions(&f.conn).unwrap(), vec![s.clone()]);

        let err = insert_edit_session(&f.conn, &s).unwrap_err();
        assert_eq!(err.code(), "document_editing");

        set_lock_seen(&f.conn, &doc.id).unwrap();
        assert!(edit_session(&f.conn, &doc.id).unwrap().unwrap().lock_seen);

        delete_edit_session(&f.conn, &doc.id).unwrap();
        delete_edit_session(&f.conn, &doc.id).unwrap();
        set_lock_seen(&f.conn, &doc.id).unwrap();
        assert!(edit_sessions(&f.conn).unwrap().is_empty());

        let mut missing = s.clone();
        missing.document_id = "00".repeat(16);
        assert_eq!(
            insert_edit_session(&f.conn, &missing).unwrap_err().code(),
            "not_found"
        );
    }

    #[test]
    fn saved_version_follows_the_session_and_skips_same_content() {
        let mut f = Fixture::new();
        let (doc, v1) = f.add("Anggaran.xlsx", "awal");
        let pk = f.pk();
        insert_edit_session(&f.conn, &f.session(&doc, &[&v1.id], &v1.blob)).unwrap();

        // Saving the same bytes (Excel rewrites the file without changes).
        let same = f.blob("awal");
        assert_eq!(
            record_saved_version(&mut f.conn, &doc.id, &same, &pk, T1).unwrap(),
            None
        );
        assert_eq!(versions(&f.conn, &doc.id).unwrap().len(), 1);

        let v2 = record_saved_version(&mut f.conn, &doc.id, &put(&f.blobs, "ubah 1"), &pk, T2)
            .unwrap()
            .unwrap();
        assert_eq!(v2.seq, 2);
        assert_eq!(v2.parent_ids, vec![v1.id.clone()]);
        assert_eq!(v2.origin, VersionOrigin::Edited);
        let s = edit_session(&f.conn, &doc.id).unwrap().unwrap();
        assert_eq!(s.parent_ids, vec![v2.id.clone()]);
        assert_eq!(s.last_hash, v2.blob.hash);
        assert_eq!(s.last_saved_at.as_deref(), Some(T2));

        assert_eq!(
            record_saved_version(&mut f.conn, &doc.id, &put(&f.blobs, "ubah 1"), &pk, T3).unwrap(),
            None
        );
        let v3 = record_saved_version(&mut f.conn, &doc.id, &put(&f.blobs, "ubah 2"), &pk, T3)
            .unwrap()
            .unwrap();
        assert_eq!(v3.parent_ids, vec![v2.id.clone()]);
        assert_eq!(ids(&heads(&f.conn, &doc.id).unwrap()), vec![v3.id.clone()]);

        delete_edit_session(&f.conn, &doc.id).unwrap();
        let err =
            record_saved_version(&mut f.conn, &doc.id, &put(&f.blobs, "x"), &pk, T3).unwrap_err();
        assert_eq!(err.code(), "not_found");
    }

    /// Two heads made directly (as the network would): v1 <- v2 (rekan), v1 <- v3.
    fn conflict_fixture() -> (
        Fixture,
        DocumentRecord,
        VersionRecord,
        VersionRecord,
        VersionRecord,
    ) {
        let mut f = Fixture::new();
        let (doc, v1) = f.add("Kontrak.docx", "satu");
        let pk = f.pk();
        let v2 = add_version(
            &mut f.conn,
            &doc.id,
            std::slice::from_ref(&v1.id),
            &put(&f.blobs, "dua"),
            &pk,
            VersionOrigin::Edited,
            None,
            T1,
        )
        .unwrap();
        let v3 = add_version(
            &mut f.conn,
            &doc.id,
            std::slice::from_ref(&v1.id),
            &put(&f.blobs, "tiga"),
            &pk,
            VersionOrigin::Edited,
            None,
            T2,
        )
        .unwrap();
        (f, doc, v1, v2, v3)
    }

    #[test]
    fn resolve_conflict_returns_to_one_head() {
        let (mut f, doc, v1, v2, v3) = conflict_fixture();
        let pk = f.pk();
        assert_eq!(
            ids(&heads(&f.conn, &doc.id).unwrap()),
            vec![v3.id.clone(), v2.id.clone()]
        );
        assert_eq!(current(&f.conn, &doc.id).unwrap().id, v3.id);

        let err = resolve_conflict(&mut f.conn, &doc.id, &v1.id, &pk, T3).unwrap_err();
        assert_eq!(err.code(), "invalid_input", "keep must be a head");

        let v4 = resolve_conflict(&mut f.conn, &doc.id, &v2.id, &pk, T3).unwrap();
        assert_eq!(v4.seq, 4);
        assert_eq!(v4.blob, v2.blob);
        assert_eq!(v4.origin, VersionOrigin::Resolved);
        assert_eq!(v4.parent_ids, sorted(vec![v2.id.clone(), v3.id.clone()]));
        assert_eq!(ids(&heads(&f.conn, &doc.id).unwrap()), vec![v4.id.clone()]);

        let err = resolve_conflict(&mut f.conn, &doc.id, &v4.id, &pk, T3).unwrap_err();
        assert_eq!(err.code(), "invalid_input", "no conflict any more");
    }

    #[test]
    fn resolve_is_refused_while_editing_here() {
        let (mut f, doc, _v1, v2, v3) = conflict_fixture();
        let pk = f.pk();
        insert_edit_session(&f.conn, &f.session(&doc, &[&v3.id], &v3.blob)).unwrap();
        let err = resolve_conflict(&mut f.conn, &doc.id, &v2.id, &pk, T3).unwrap_err();
        assert_eq!(err.code(), "document_editing");
    }

    #[test]
    fn restore_during_conflict_also_resolves_it() {
        let (mut f, doc, v1, v2, v3) = conflict_fixture();
        let pk = f.pk();
        let v4 = restore_version(&mut f.conn, &doc.id, &v1.id, &pk, T3).unwrap();
        assert_eq!(v4.parent_ids, sorted(vec![v2.id.clone(), v3.id.clone()]));
        assert_eq!(v4.blob, v1.blob);
        assert_eq!(ids(&heads(&f.conn, &doc.id).unwrap()), vec![v4.id.clone()]);
    }

    #[test]
    fn manual_merge_session_with_two_parents_resolves_the_conflict() {
        let (mut f, doc, _v1, v2, v3) = conflict_fixture();
        let pk = f.pk();
        // "Gabung manual": edit starts from v3, the next save's parents are both heads.
        insert_edit_session(&f.conn, &f.session(&doc, &[&v3.id, &v2.id], &v3.blob)).unwrap();
        let v4 = record_saved_version(&mut f.conn, &doc.id, &put(&f.blobs, "gabungan"), &pk, T3)
            .unwrap()
            .unwrap();
        assert_eq!(v4.origin, VersionOrigin::Resolved);
        assert_eq!(v4.parent_ids, sorted(vec![v2.id.clone(), v3.id.clone()]));
        assert_eq!(ids(&heads(&f.conn, &doc.id).unwrap()), vec![v4.id.clone()]);
        let s = edit_session(&f.conn, &doc.id).unwrap().unwrap();
        assert_eq!(s.parent_ids, vec![v4.id.clone()]);

        // The next save in the same session is a plain edit.
        let v5 = record_saved_version(&mut f.conn, &doc.id, &put(&f.blobs, "lagi"), &pk, T3)
            .unwrap()
            .unwrap();
        assert_eq!(v5.origin, VersionOrigin::Edited);
    }
}
