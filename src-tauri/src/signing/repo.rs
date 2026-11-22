//! Baca tulis tabel `sign_requests`, `sign_signers`, `sign_events`,
//! `sign_exports`, dan pembacaan `members` yang dibutuhkan alur tanda tangan.
//!
//! Penulisan permintaan (`save_request`) wajib di dalam transaksi supaya baris
//! permintaan dan daftar penanda tangannya selalu berubah bersama. Fungsi lain
//! menerima `&Connection`, jadi bisa dipanggil dengan transaksi yang sama.

use rusqlite::{Connection, OptionalExtension, Row, Transaction, params};

use super::request::{RequestStatus, SignMode, SignRequest, Signer, SignerKind, SignerStatus};
use super::seal::{self, EventKind, EventRecord};
use crate::error::{AppError, AppResult};

fn corrupt(what: &str) -> AppError {
    AppError::Internal(format!(
        "Data tanda tangan di database Mira rusak ({what}). Tutup lalu buka lagi Mira; kalau masih terjadi, minta bantuan admin."
    ))
}

const REQUEST_COLUMNS: &str = "id, title, requested_by, mode, status, original_hash, current_hash, created_at, updated_at, completed_at";

struct RequestRow {
    id: String,
    title: String,
    requested_by: String,
    mode: String,
    status: String,
    original_hash: String,
    current_hash: String,
    created_at: String,
    updated_at: String,
    completed_at: Option<String>,
}

fn request_row(r: &Row<'_>) -> rusqlite::Result<RequestRow> {
    Ok(RequestRow {
        id: r.get(0)?,
        title: r.get(1)?,
        requested_by: r.get(2)?,
        mode: r.get(3)?,
        status: r.get(4)?,
        original_hash: r.get(5)?,
        current_hash: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
        completed_at: r.get(9)?,
    })
}

fn load_signers(conn: &Connection, request_id: &str) -> AppResult<Vec<Signer>> {
    let mut stmt = conn.prepare_cached(
        "SELECT position, public_key, display_name, kind, status, signed_at, hash_after
         FROM sign_signers WHERE request_id = ?1 ORDER BY position",
    )?;
    let rows = stmt.query_map(params![request_id], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, Option<String>>(5)?,
            r.get::<_, Option<String>>(6)?,
        ))
    })?;
    let mut signers = Vec::new();
    for row in rows {
        let (position, public_key, display_name, kind, status, signed_at, hash_after) = row?;
        signers.push(Signer {
            position: u32::try_from(position).map_err(|_| corrupt("posisi penanda tangan"))?,
            public_key,
            display_name,
            kind: SignerKind::parse(&kind).ok_or_else(|| corrupt("jenis penanda tangan"))?,
            status: SignerStatus::parse(&status).ok_or_else(|| corrupt("status penanda tangan"))?,
            signed_at,
            hash_after,
        });
    }
    Ok(signers)
}

fn into_request(conn: &Connection, row: RequestRow) -> AppResult<SignRequest> {
    let signers = load_signers(conn, &row.id)?;
    Ok(SignRequest {
        mode: SignMode::parse(&row.mode).ok_or_else(|| corrupt("mode permintaan"))?,
        status: RequestStatus::parse(&row.status).ok_or_else(|| corrupt("status permintaan"))?,
        id: row.id,
        title: row.title,
        requested_by: row.requested_by,
        original_hash: row.original_hash,
        current_hash: row.current_hash,
        created_at: row.created_at,
        updated_at: row.updated_at,
        completed_at: row.completed_at,
        signers,
    })
}

/// Menyimpan permintaan utuh (baru atau perubahan) beserta penanda tangannya.
pub fn save_request(tx: &Transaction<'_>, req: &SignRequest) -> AppResult<()> {
    tx.execute(
        "INSERT INTO sign_requests
             (id, title, requested_by, mode, status, original_hash, current_hash, created_at, updated_at, completed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT (id) DO UPDATE SET
             title = excluded.title,
             requested_by = excluded.requested_by,
             mode = excluded.mode,
             status = excluded.status,
             original_hash = excluded.original_hash,
             current_hash = excluded.current_hash,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at,
             completed_at = excluded.completed_at",
        params![
            req.id,
            req.title,
            req.requested_by,
            req.mode.as_str(),
            req.status.as_str(),
            req.original_hash,
            req.current_hash,
            req.created_at,
            req.updated_at,
            req.completed_at,
        ],
    )?;
    tx.execute(
        "DELETE FROM sign_signers WHERE request_id = ?1",
        params![req.id],
    )?;
    let mut stmt = tx.prepare_cached(
        "INSERT INTO sign_signers
             (request_id, position, public_key, display_name, kind, status, signed_at, hash_after)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )?;
    for s in &req.signers {
        stmt.execute(params![
            req.id,
            s.position,
            s.public_key,
            s.display_name,
            s.kind.as_str(),
            s.status.as_str(),
            s.signed_at,
            s.hash_after,
        ])?;
    }
    Ok(())
}

/// Cakupan tim dan proyek permintaan (kolom `team_id`, `project_id`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RequestScope {
    pub team_id: Option<String>,
    pub project_id: Option<String>,
}

pub fn set_scope(conn: &Connection, request_id: &str, scope: &RequestScope) -> AppResult<()> {
    conn.execute(
        "UPDATE sign_requests SET team_id = ?1, project_id = ?2 WHERE id = ?3",
        params![scope.team_id, scope.project_id, request_id],
    )?;
    Ok(())
}

pub fn load_scope(conn: &Connection, request_id: &str) -> AppResult<RequestScope> {
    Ok(conn
        .query_row(
            "SELECT team_id, project_id FROM sign_requests WHERE id = ?1",
            params![request_id],
            |r| {
                Ok(RequestScope {
                    team_id: r.get(0)?,
                    project_id: r.get(1)?,
                })
            },
        )
        .optional()?
        .unwrap_or_default())
}

/// Menghapus satu baris `sign_events` (dipakai sinkron saat catatan dari
/// versi yang kalah dibuang).
pub fn delete_event(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM sign_events WHERE id = ?1", params![id])?;
    Ok(())
}

/// Permintaan dengan id itu, atau `None`.
pub fn load_request(conn: &Connection, id: &str) -> AppResult<Option<SignRequest>> {
    let row = conn
        .query_row(
            &format!("SELECT {REQUEST_COLUMNS} FROM sign_requests WHERE id = ?1"),
            params![id],
            request_row,
        )
        .optional()?;
    row.map(|r| into_request(conn, r)).transpose()
}

/// Semua permintaan, yang terakhir berubah lebih dulu.
pub fn list_requests(conn: &Connection) -> AppResult<Vec<SignRequest>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {REQUEST_COLUMNS} FROM sign_requests
         ORDER BY updated_at DESC, created_at DESC, id"
    ))?;
    let rows = stmt
        .query_map([], request_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter().map(|r| into_request(conn, r)).collect()
}

/// Id permintaan yang mencatat `hash` sebagai versi asli, versi terkini, atau
/// hasil tanda tangan salah satu penanda tangan.
pub fn find_ids_by_hash(conn: &Connection, hash: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM sign_requests WHERE original_hash = ?1 OR current_hash = ?1
         UNION
         SELECT request_id FROM sign_signers WHERE hash_after = ?1",
    )?;
    let ids = stmt
        .query_map(params![hash], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ids)
}

/// Satu baris `sign_events` apa adanya. `kind` dibiarkan teks supaya baris
/// yang rusak tetap bisa ditampilkan (dan dinyatakan tidak sah).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredEvent {
    pub id: i64,
    pub request_id: Option<String>,
    pub kind: String,
    pub actor: String,
    pub actor_name: String,
    pub at: String,
    pub hash_before: Option<String>,
    pub hash_after: Option<String>,
    pub detail: String,
    pub sig: String,
}

impl StoredEvent {
    pub fn record(&self) -> Option<EventRecord> {
        Some(EventRecord {
            request_id: self.request_id.clone(),
            kind: EventKind::parse(&self.kind)?,
            actor: self.actor.clone(),
            actor_name: self.actor_name.clone(),
            at: self.at.clone(),
            hash_before: self.hash_before.clone(),
            hash_after: self.hash_after.clone(),
            detail: self.detail.clone(),
        })
    }

    /// Tanda tangan pelaku atas catatan ini sah.
    pub fn is_valid(&self) -> bool {
        self.record()
            .is_some_and(|rec| seal::verify_event(&rec, &self.sig))
    }
}

/// Menyimpan catatan jejak audit yang sudah ditandatangani.
pub fn insert_event(conn: &Connection, rec: &EventRecord, sig: &str) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO sign_events
             (request_id, kind, actor, actor_name, at, hash_before, hash_after, detail, sig)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            rec.request_id,
            rec.kind.as_str(),
            rec.actor,
            rec.actor_name,
            rec.at,
            rec.hash_before,
            rec.hash_after,
            rec.detail,
            sig,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

fn stored_event(r: &Row<'_>) -> rusqlite::Result<StoredEvent> {
    Ok(StoredEvent {
        id: r.get(0)?,
        request_id: r.get(1)?,
        kind: r.get(2)?,
        actor: r.get(3)?,
        actor_name: r.get(4)?,
        at: r.get(5)?,
        hash_before: r.get(6)?,
        hash_after: r.get(7)?,
        detail: r.get(8)?,
        sig: r.get(9)?,
    })
}

const EVENT_COLUMNS: &str =
    "id, request_id, kind, actor, actor_name, at, hash_before, hash_after, detail, sig";

/// Catatan jejak audit satu permintaan, urut waktu dicatat.
pub fn events_for(conn: &Connection, request_id: &str) -> AppResult<Vec<StoredEvent>> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {EVENT_COLUMNS} FROM sign_events WHERE request_id = ?1 ORDER BY id"
    ))?;
    let events = stmt
        .query_map(params![request_id], stored_event)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(events)
}

/// Catatan `signature_saved` dan `signature_deleted` milik `actor` (tanpa
/// permintaan), urut waktu dicatat.
pub fn signature_events_of(conn: &Connection, actor: &str) -> AppResult<Vec<StoredEvent>> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {EVENT_COLUMNS} FROM sign_events
         WHERE request_id IS NULL AND actor = ?1 AND kind IN (?2, ?3)
         ORDER BY id"
    ))?;
    let events = stmt
        .query_map(
            params![
                actor,
                EventKind::SignatureSaved.as_str(),
                EventKind::SignatureDeleted.as_str()
            ],
            stored_event,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(events)
}

/// Satu file hasil ekspor yang dicatat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportRow {
    pub path: String,
    pub hash: String,
    pub exported_at: String,
}

/// Mencatat (atau memperbarui) lokasi ekspor.
pub fn upsert_export(
    conn: &Connection,
    request_id: &str,
    path: &str,
    hash: &str,
    at: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO sign_exports (request_id, path, hash, exported_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (request_id, path) DO UPDATE SET hash = excluded.hash, exported_at = excluded.exported_at",
        params![request_id, path, hash, at],
    )?;
    Ok(())
}

/// Ekspor satu permintaan, urut waktu.
pub fn exports_for(conn: &Connection, request_id: &str) -> AppResult<Vec<ExportRow>> {
    let mut stmt = conn.prepare_cached(
        "SELECT path, hash, exported_at FROM sign_exports
         WHERE request_id = ?1 ORDER BY exported_at, path",
    )?;
    let rows = stmt
        .query_map(params![request_id], |r| {
            Ok(ExportRow {
                path: r.get(0)?,
                hash: r.get(1)?,
                exported_at: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Baris `members` yang dibutuhkan tanda tangan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberRow {
    pub public_key: String,
    pub display_name: String,
    pub role: String,
    pub kind: String,
    pub status: String,
}

impl MemberRow {
    /// Tamu menurut kolom `kind` (Tahap 1) atau peran lama `guest`.
    pub fn is_guest(&self) -> bool {
        self.kind == "guest" || self.role == "guest"
    }

    pub fn is_active(&self) -> bool {
        self.status == "active"
    }

    pub fn signer_kind(&self) -> SignerKind {
        if self.is_guest() {
            SignerKind::Guest
        } else {
            SignerKind::Member
        }
    }
}

fn member_row(r: &Row<'_>) -> rusqlite::Result<MemberRow> {
    Ok(MemberRow {
        public_key: r.get(0)?,
        display_name: r.get(1)?,
        role: r.get(2)?,
        kind: r.get(3)?,
        status: r.get(4)?,
    })
}

/// Baris anggota `public_key` di organisasi `org_id` (apa pun statusnya).
pub fn member(conn: &Connection, org_id: &str, public_key: &str) -> AppResult<Option<MemberRow>> {
    Ok(conn
        .query_row(
            "SELECT public_key, display_name, role, kind, status FROM members
             WHERE organization_id = ?1 AND public_key = ?2",
            params![org_id, public_key],
            member_row,
        )
        .optional()?)
}

/// Anggota aktif organisasi, urut nama.
pub fn active_members(conn: &Connection, org_id: &str) -> AppResult<Vec<MemberRow>> {
    let mut stmt = conn.prepare(
        "SELECT public_key, display_name, role, kind, status FROM members
         WHERE organization_id = ?1 AND status = 'active'
         ORDER BY display_name COLLATE NOCASE, public_key",
    )?;
    let rows = stmt
        .query_map(params![org_id], member_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}
