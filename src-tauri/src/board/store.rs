//! SQLite storage of projects, signed changes, snapshots and the task index.
//!
//! The signed change log (`board_changes`) is the source of truth; the
//! snapshot (`board_projects.doc`) makes opening fast and the task index
//! (`board_task_index`) serves "Task saya" and the reminders without opening
//! every document. All three are written in one transaction per change.

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use time::OffsetDateTime;

use super::doc::{BoardDoc, ProjectMeta, random_id};
use super::model::{ColumnId, normalize_team_id, validate_project_code, validate_project_name};
use super::sign::{MAX_CHANGE_BYTES, SignedChange, sign_change};
use crate::clock;
use crate::error::{AppError, AppResult};
use crate::identity::Identity;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectRow {
    pub id: String,
    pub code: String,
    pub name: String,
    pub team_id: Option<String>,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
}

/// Result of a committed local mutation.
pub struct Committed<T> {
    pub value: T,
    /// The document after the change, for building the response.
    pub doc: BoardDoc,
    /// Empty when the mutation changed nothing.
    pub changes: Vec<SignedChange>,
}

const PROJECT_COLS: &str = "id, code, name, team_id, created_by, created_at, updated_at";

fn row_to_project(r: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectRow> {
    Ok(ProjectRow {
        id: r.get(0)?,
        code: r.get(1)?,
        name: r.get(2)?,
        team_id: r.get(3)?,
        created_by: r.get(4)?,
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
    })
}

pub fn project_not_found() -> AppError {
    AppError::NotFound("Proyek tidak ditemukan. Mungkin sudah dihapus dari laptop ini.".into())
}

pub fn project(conn: &Connection, id: &str) -> AppResult<ProjectRow> {
    conn.query_row(
        &format!("SELECT {PROJECT_COLS} FROM board_projects WHERE id = ?1"),
        [id],
        row_to_project,
    )
    .optional()?
    .ok_or_else(project_not_found)
}

/// All projects, by name then code.
pub fn projects(conn: &Connection) -> AppResult<Vec<ProjectRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {PROJECT_COLS} FROM board_projects ORDER BY lower(name), code"
    ))?;
    let rows = stmt
        .query_map([], row_to_project)?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

/// `(open, total)` tasks of a project, deleted ones not counted.
pub fn counts(conn: &Connection, project_id: &str) -> AppResult<(u32, u32)> {
    Ok(conn.query_row(
        "SELECT coalesce(sum(column_id <> 'done'), 0), count(*)
         FROM board_task_index WHERE project_id = ?1 AND deleted = 0",
        [project_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?)
}

/// `(project_id, task_id)` of the live tasks assigned to `assignee`.
pub fn assigned_to(conn: &Connection, assignee: &str) -> AppResult<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT project_id, task_id FROM board_task_index
         WHERE assignee = ?1 AND deleted = 0 ORDER BY project_id, task_id",
    )?;
    let rows = stmt
        .query_map([assignee], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

fn team_exists(conn: &Connection, team_id: &str) -> AppResult<bool> {
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM teams WHERE id = ?1 AND deleted = 0",
        [team_id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// Refuses a code for a new local project when another project shows it
/// (`code`) or has it in its document (`doc_code`).
pub(crate) fn ensure_code_free(conn: &Connection, code: &str, except_id: &str) -> AppResult<()> {
    let taken: Option<String> = conn
        .query_row(
            "SELECT name FROM board_projects WHERE (code = ?1 OR doc_code = ?1) AND id <> ?2
             ORDER BY created_at, id LIMIT 1",
            params![code, except_id],
            |r| r.get(0),
        )
        .optional()?;
    match taken {
        Some(name) => Err(AppError::InvalidInput(format!(
            "Kode {code} sudah dipakai proyek \"{name}\". Pilih kode lain."
        ))),
        None => Ok(()),
    }
}

/// One project as the code rule needs it.
struct CodeRow {
    id: String,
    doc_code: String,
    created_at: String,
}

/// The code shown for each project (docs/plans/sinkron-board.md, "Kode
/// proyek ganda"): among projects with the same `doc_code`, the first by
/// `(created_at, id)` shows it, each other one the first `doc_code2`,
/// `doc_code3`, ... that no project has as its document code and no project
/// shows yet. Depends only on the set of projects, so every laptop holding
/// the same projects shows the same codes. Returns `(project id, code)`.
fn shown_codes(mut rows: Vec<CodeRow>) -> Vec<(String, String)> {
    rows.sort_by(|a, b| {
        (&a.doc_code, &a.created_at, &a.id).cmp(&(&b.doc_code, &b.created_at, &b.id))
    });
    let mut used: std::collections::HashSet<String> =
        rows.iter().map(|r| r.doc_code.clone()).collect();
    let mut out = Vec::with_capacity(rows.len());
    let mut rest = Vec::new();
    for (i, r) in rows.iter().enumerate() {
        if i > 0 && rows[i - 1].doc_code == r.doc_code {
            rest.push(r);
        } else {
            out.push((r.id.clone(), r.doc_code.clone()));
        }
    }
    for r in rest {
        let code = (2u64..)
            .map(|n| format!("{}{n}", r.doc_code))
            .find(|c| !used.contains(c))
            .unwrap_or_default();
        used.insert(code.clone());
        out.push((r.id.clone(), code));
    }
    out
}

fn code_rows(conn: &Connection) -> AppResult<Vec<CodeRow>> {
    let mut stmt = conn.prepare("SELECT id, doc_code, created_at FROM board_projects")?;
    let rows = stmt
        .query_map([], |r| {
            Ok(CodeRow {
                id: r.get(0)?,
                doc_code: r.get(1)?,
                created_at: r.get(2)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

/// Gives every project the code [`shown_codes`] says and rewrites the task
/// index rows of the projects whose code changed (task codes follow).
/// Returns the ids of those projects.
pub fn refresh_codes(conn: &Connection) -> AppResult<Vec<String>> {
    let mut current: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT id, code FROM board_projects")?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get(1)?)))? {
            let (id, code) = row?;
            current.insert(id, code);
        }
    }
    let changed: Vec<(String, String)> = shown_codes(code_rows(conn)?)
        .into_iter()
        .filter(|(id, code)| current.get(id) != Some(code))
        .collect();
    // `code` is UNIQUE: park the moving rows first so codes can swap.
    for (id, _) in &changed {
        conn.execute(
            "UPDATE board_projects SET code = '~' || id WHERE id = ?1",
            [id],
        )?;
    }
    for (id, code) in &changed {
        conn.execute(
            "UPDATE board_projects SET code = ?2 WHERE id = ?1",
            params![id, code],
        )?;
        // Task codes are `<project code>-<number>`; project codes have no '-'.
        conn.execute(
            "UPDATE board_task_index SET code = ?2 || substr(code, instr(code, '-'))
             WHERE project_id = ?1",
            params![id, code],
        )?;
    }
    Ok(changed.into_iter().map(|(id, _)| id).collect())
}

/// The code to insert for a project received from another laptop whose
/// document says `wanted`: the code [`shown_codes`] gives it when no other
/// project shows that code now, otherwise a temporary one. The insert is
/// followed by `save_doc`, whose [`refresh_codes`] settles every code.
pub(crate) fn claim_code(
    conn: &Connection,
    wanted: &str,
    project_id: &str,
    created_at: &str,
) -> AppResult<String> {
    let mut rows = code_rows(conn)?;
    rows.retain(|r| r.id != project_id);
    rows.push(CodeRow {
        id: project_id.to_owned(),
        doc_code: wanted.to_owned(),
        created_at: created_at.to_owned(),
    });
    let code = shown_codes(rows)
        .into_iter()
        .find(|(id, _)| id == project_id)
        .map(|(_, c)| c)
        .unwrap_or_else(|| wanted.to_owned());
    let taken = conn
        .query_row(
            "SELECT 1 FROM board_projects WHERE code = ?1 AND id <> ?2",
            params![code, project_id],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
        .is_some();
    Ok(if taken {
        format!("~{project_id}")
    } else {
        code
    })
}

/// A project id bound to its creator and team: the first 32 hex characters
/// of BLAKE3 over `mira-board-project-v1`, creator, team (or empty) and
/// nonce, each followed by a newline except the last. Nobody can present
/// another creator's or team's project under that id, so a forged first
/// change cannot take over a project.
pub fn derive_project_id(creator: &str, team_id: Option<&str>, nonce: &str) -> String {
    let input = format!(
        "mira-board-project-v1\n{creator}\n{}\n{nonce}",
        team_id.unwrap_or("")
    );
    blake3::hash(input.as_bytes()).to_hex()[..32].to_owned()
}

/// Whether the project in `doc` (its first change by `creator`) has a bound
/// id. Projects made before ids were bound have no nonce and stay on the
/// laptop that made them.
pub fn project_id_matches(doc: &BoardDoc, creator: &str) -> bool {
    let meta = doc.project();
    doc.project_nonce().is_some_and(|nonce| {
        crate::org::is_lower_hex(&nonce, 32)
            && derive_project_id(creator, meta.team_id.as_deref(), &nonce) == meta.id
    })
}

/// Whether a stored project may be offered to other laptops (bound id).
/// Computed from the document once, then read from `board_projects.bound`:
/// the id, creator, team and nonce never change.
pub fn is_syncable(conn: &Connection, project_id: &str) -> AppResult<bool> {
    let bound: Option<i64> = conn
        .query_row(
            "SELECT bound FROM board_projects WHERE id = ?1",
            [project_id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(project_not_found)?;
    if let Some(bound) = bound {
        return Ok(bound == 1);
    }
    let row = project(conn, project_id)?;
    let doc = load_doc(conn, project_id, &[0; 32])?;
    let bound = project_id_matches(&doc, &row.created_by);
    conn.execute(
        "UPDATE board_projects SET bound = ?2 WHERE id = ?1",
        params![project_id, bound],
    )?;
    Ok(bound)
}

/// Creates a project and its document. Permission is checked by the caller.
pub fn create_project(
    conn: &mut Connection,
    identity: &Identity,
    name: &str,
    code: &str,
    team_id: Option<&str>,
) -> AppResult<Committed<ProjectRow>> {
    create_project_with_members(conn, identity, name, code, team_id, &[])
}

/// Creates a project and its document, and registers it in the membership
/// log (`project_create`, v0.3) with the creator and `members` (public
/// keys) as its members, in the same transaction. Without an organization
/// the project stays on this laptop and nothing is registered. Permission
/// is checked by the caller.
pub fn create_project_with_members(
    conn: &mut Connection,
    identity: &Identity,
    name: &str,
    code: &str,
    team_id: Option<&str>,
    members: &[String],
) -> AppResult<Committed<ProjectRow>> {
    create_project_inner(conn, identity, name, code, team_id, Some((members, None)))
}

/// `create_project_with_members` for a project owned by `division` (v0.6),
/// which must be a live division of `team_id`. Permission and the member
/// list are the caller's.
pub fn create_division_project(
    conn: &mut Connection,
    identity: &Identity,
    name: &str,
    code: &str,
    team_id: &str,
    members: &[String],
    division: &str,
) -> AppResult<Committed<ProjectRow>> {
    let register = Some((members, Some(division)));
    create_project_inner(conn, identity, name, code, Some(team_id), register)
}

/// Tests whose membership tables are written directly (not by the fold):
/// creates the project without authoring `project_create`, so the fold does
/// not rewrite those tables. Register it with `testutil::register_project`.
#[cfg(test)]
pub fn create_project_local(
    conn: &mut Connection,
    identity: &Identity,
    name: &str,
    code: &str,
    team_id: Option<&str>,
) -> AppResult<Committed<ProjectRow>> {
    create_project_inner(conn, identity, name, code, team_id, None)
}

/// `register`: the initial members and division to register in the log
/// with, `None` to skip registration (tests only).
fn create_project_inner(
    conn: &mut Connection,
    identity: &Identity,
    name: &str,
    code: &str,
    team_id: Option<&str>,
    register: Option<(&[String], Option<&str>)>,
) -> AppResult<Committed<ProjectRow>> {
    let name = validate_project_name(name)?;
    let code = validate_project_code(code)?;
    let team_id = normalize_team_id(team_id);

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(team) = team_id
        && !team_exists(&tx, team)?
    {
        return Err(AppError::InvalidInput(
            "Departemen yang dipilih tidak ditemukan. Pilih departemen lain atau buat proyek tanpa departemen.".into(),
        ));
    }
    let nonce = random_id();
    let id = derive_project_id(identity.public_key_hex(), team_id, &nonce);
    ensure_code_free(&tx, &code, &id)?;
    let now = clock::now();
    let at = clock::format_rfc3339(now);
    let row = ProjectRow {
        id,
        code,
        name,
        team_id: team_id.map(str::to_owned),
        created_by: identity.public_key_hex().to_owned(),
        created_at: at.clone(),
        updated_at: at,
    };
    let meta = ProjectMeta {
        id: row.id.clone(),
        code: row.code.clone(),
        name: row.name.clone(),
        team_id: row.team_id.clone(),
    };
    let mut doc = BoardDoc::create(&actor_of(identity), &meta)?;
    doc.set_project_nonce(&nonce)?;
    tx.execute(
        "INSERT INTO board_projects (id, code, doc_code, name, team_id, created_by, created_at, doc, updated_at)
         VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, x'', ?7)",
        params![
            row.id,
            row.code,
            row.name,
            row.team_id,
            row.created_by,
            row.created_at,
            row.updated_at
        ],
    )?;
    let changes = commit_and_sign(&tx, identity, &row, &mut doc, &[], now)?;
    if let Some((members, division)) = register {
        crate::permissions::register_own_project_in(
            &tx,
            identity,
            &row.id,
            team_id,
            &nonce,
            members,
            division,
            now,
        )?;
    }
    tx.commit()?;
    Ok(Committed {
        value: row,
        doc,
        changes,
    })
}

pub fn actor_of(identity: &Identity) -> [u8; 32] {
    identity.verifying_key().to_bytes()
}

pub fn load_doc(conn: &Connection, project_id: &str, actor: &[u8]) -> AppResult<BoardDoc> {
    let bytes: Vec<u8> = conn
        .query_row(
            "SELECT doc FROM board_projects WHERE id = ?1",
            [project_id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(project_not_found)?;
    BoardDoc::load(&bytes, actor)
}

/// Runs `f` on the project's document and commits what it staged as one
/// signed change, together with the snapshot and the task index, in one
/// transaction. Nothing is written when `f` fails or stages nothing.
pub fn commit_local<T>(
    conn: &mut Connection,
    identity: &Identity,
    project_id: &str,
    f: impl FnOnce(&mut BoardDoc) -> AppResult<T>,
) -> AppResult<Committed<T>> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let row = project(&tx, project_id)?;
    let mut doc = load_doc(&tx, project_id, &actor_of(identity))?;
    let before = doc.heads();
    let value = f(&mut doc)?;
    let changes = commit_and_sign(&tx, identity, &row, &mut doc, &before, clock::now())?;
    tx.commit()?;
    Ok(Committed {
        value,
        doc,
        changes,
    })
}

fn commit_and_sign(
    tx: &Transaction<'_>,
    identity: &Identity,
    row: &ProjectRow,
    doc: &mut BoardDoc,
    before: &[automerge::ChangeHash],
    now: OffsetDateTime,
) -> AppResult<Vec<SignedChange>> {
    if doc.commit(now.unix_timestamp()).is_none() {
        return Ok(Vec::new());
    }
    let mut signed = Vec::new();
    for change in doc.changes_after(before) {
        // Other laptops refuse bigger changes, so it must not be stored here.
        if change.raw_bytes().len() > MAX_CHANGE_BYTES {
            return Err(AppError::InvalidInput(
                "Perubahan ini terlalu besar untuk disimpan. Persingkat deskripsi atau komentarnya, lalu coba lagi."
                    .into(),
            ));
        }
        if change.len() > super::rules::MAX_CHANGE_OPS {
            return Err(AppError::InvalidInput(
                "Perubahan ini terlalu besar untuk disimpan. Persingkat deskripsi atau komentarnya, lalu coba lagi."
                    .into(),
            ));
        }
        let sc = sign_change(identity, &row.id, &change);
        if sc.author != identity.public_key_hex() {
            return Err(AppError::Internal(
                "Perubahan board dibuat atas nama laptop lain. Tutup lalu buka lagi Mira.".into(),
            ));
        }
        insert_change(tx, &sc, change.timestamp(), None, now)?;
        signed.push(sc);
    }
    save_doc(tx, row, doc, now)?;
    Ok(signed)
}

/// Inserts a change unless its hash is already stored; true when new.
pub(crate) fn insert_change(
    conn: &Connection,
    sc: &SignedChange,
    change_time: i64,
    received_from: Option<&str>,
    now: OffsetDateTime,
) -> AppResult<bool> {
    let created_at = OffsetDateTime::from_unix_timestamp(change_time)
        .map(clock::format_rfc3339)
        .unwrap_or_else(|_| clock::format_rfc3339(now));
    let seq = i64::try_from(sc.seq)
        .map_err(|_| AppError::InvalidInput("Nomor urut perubahan board terlalu besar.".into()))?;
    let n = conn.execute(
        "INSERT OR IGNORE INTO board_changes
           (hash, project_id, author, seq, bytes, sig, created_at, received_at, received_from, record_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            sc.hash,
            sc.project_id,
            sc.author,
            seq,
            sc.bytes,
            sc.sig,
            created_at,
            clock::format_rfc3339(now),
            received_from,
            sc.record_id()
        ],
    )?;
    Ok(n == 1)
}

pub(crate) fn change_exists(conn: &Connection, hash: &str) -> AppResult<bool> {
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM board_changes WHERE hash = ?1",
        [hash],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// Writes the snapshot, takes the project name and document code from the
/// document (so a rename from another laptop shows), settles the shown codes
/// ([`refresh_codes`]) and rewrites the project's rows in the task index.
pub(crate) fn save_doc(
    conn: &Connection,
    row: &ProjectRow,
    doc: &mut BoardDoc,
    now: OffsetDateTime,
) -> AppResult<()> {
    conn.execute(
        "UPDATE board_projects SET doc = ?2, updated_at = ?3 WHERE id = ?1",
        params![row.id, doc.save(), clock::format_rfc3339(now)],
    )?;
    // A value that would not pass the local checks keeps the previous one.
    let meta = doc.project();
    if meta.id == row.id {
        if validate_project_name(&meta.name).is_ok_and(|n| n == meta.name) {
            conn.execute(
                "UPDATE board_projects SET name = ?2 WHERE id = ?1",
                params![row.id, meta.name],
            )?;
        }
        if validate_project_code(&meta.code).is_ok_and(|c| c == meta.code) {
            conn.execute(
                "UPDATE board_projects SET doc_code = ?2 WHERE id = ?1",
                params![row.id, meta.code],
            )?;
        }
    }
    refresh_codes(conn)?;
    let code: String = conn.query_row(
        "SELECT code FROM board_projects WHERE id = ?1",
        [&row.id],
        |r| r.get(0),
    )?;
    conn.execute(
        "DELETE FROM board_task_index WHERE project_id = ?1",
        [&row.id],
    )?;
    let mut stmt = conn.prepare(
        "INSERT INTO board_task_index
           (project_id, task_id, code, title, column_id, assignee, due, deleted)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )?;
    for t in doc.tasks()? {
        stmt.execute(params![
            row.id,
            t.id,
            task_code(&code, t.number),
            t.title,
            t.column.as_str(),
            t.assignee,
            t.due,
            t.deleted
        ])?;
    }
    Ok(())
}

pub fn task_code(project_code: &str, number: i64) -> String {
    format!("{project_code}-{number}")
}

/// Every stored change of a project in the order it was stored (which is
/// causal order: a change is stored only after its dependencies).
pub fn stored_changes(conn: &Connection, project_id: &str) -> AppResult<Vec<SignedChange>> {
    let mut stmt = conn.prepare(
        "SELECT project_id, hash, author, seq, bytes, sig FROM board_changes
         WHERE project_id = ?1 ORDER BY rowid",
    )?;
    let rows = stmt
        .query_map([project_id], row_to_change)?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

pub(crate) fn change_by_hash(conn: &Connection, hash: &str) -> AppResult<Option<SignedChange>> {
    Ok(conn
        .query_row(
            "SELECT project_id, hash, author, seq, bytes, sig FROM board_changes WHERE hash = ?1",
            [hash],
            row_to_change,
        )
        .optional()?)
}

fn row_to_change(r: &rusqlite::Row<'_>) -> rusqlite::Result<SignedChange> {
    let seq: i64 = r.get(3)?;
    Ok(SignedChange {
        project_id: r.get(0)?,
        hash: r.get(1)?,
        author: r.get(2)?,
        seq: u64::try_from(seq).unwrap_or_default(),
        bytes: r.get(4)?,
        sig: r.get(5)?,
    })
}

/// Index rows (for tests and the reminders): `(task_id, code, title, column, assignee, due, deleted)`.
pub type IndexRow = (
    String,
    String,
    String,
    ColumnId,
    Option<String>,
    Option<String>,
    bool,
);

pub fn index_rows(conn: &Connection, project_id: &str) -> AppResult<Vec<IndexRow>> {
    let mut stmt = conn.prepare(
        "SELECT task_id, code, title, column_id, assignee, due, deleted FROM board_task_index
         WHERE project_id = ?1 ORDER BY task_id",
    )?;
    let rows = stmt
        .query_map([project_id], |r| {
            let col: String = r.get(3)?;
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                ColumnId::parse(&col).unwrap_or(ColumnId::Todo),
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
            ))
        })?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::doc::{Stamp, TaskInit};
    use crate::board::sign::verify_change;
    use crate::board::testutil::{Laptop, add_member};
    use crate::db;
    use crate::identity::{MemoryKeyStore, ensure_identity};
    use automerge::Change;

    fn add(l: &mut Laptop, project: &str, title: &str) -> String {
        let me = l.pk();
        commit_local(&mut l.conn, &l.id, project, |d| {
            d.create_task(
                Stamp {
                    actor: &me,
                    at: "2026-11-22T00:00:00Z",
                },
                TaskInit {
                    title: title.into(),
                    assignee: Some(me.clone()),
                    due: Some("2026-11-28".into()),
                    ..Default::default()
                },
            )
        })
        .unwrap()
        .value
    }

    #[test]
    fn create_project_validates_and_keeps_codes_unique() {
        let mut l = Laptop::founder("Sari");
        let p = create_project(&mut l.conn, &l.id, " Proyek Alfa ", " pa ", None).unwrap();
        assert_eq!(p.value.name, "Proyek Alfa");
        assert_eq!(p.value.code, "PA");
        assert_eq!(p.changes.len(), 1);
        let err = create_project(&mut l.conn, &l.id, "Lain", "PA", None)
            .err()
            .unwrap();
        assert_eq!(err.code(), "invalid_input");
        assert!(err.to_string().contains("Proyek Alfa"));
        let err = create_project(&mut l.conn, &l.id, "X", "PB", None)
            .err()
            .unwrap();
        assert_eq!(err.code(), "invalid_input");
        let err = create_project(&mut l.conn, &l.id, "Lain", "PB", Some(&"ab".repeat(16)))
            .err()
            .unwrap();
        assert_eq!(err.code(), "invalid_input");
        let team = crate::board::testutil::org_ops::create_team(&mut l.conn, &l.id, "Desain");
        let p = create_project(&mut l.conn, &l.id, "Lain", "PB", Some(&team)).unwrap();
        assert_eq!(p.value.team_id, Some(team));
        assert_eq!(projects(&l.conn).unwrap().len(), 2);
    }

    #[test]
    fn reopen_keeps_data_and_index() {
        let tmp = tempfile::tempdir().unwrap();
        let store = MemoryKeyStore::new();
        let project_id;
        let task;
        {
            let mut conn = db::open(tmp.path()).unwrap();
            let mut id = ensure_identity(&conn, &store).unwrap();
            crate::identity::save_display_name(&mut conn, &mut id, "Sari").unwrap();
            crate::org::create_organization(&mut conn, &id, "Kantor").unwrap();
            let mut l = (conn, id);
            project_id = create_project(&mut l.0, &l.1, "Alfa", "PA", None)
                .unwrap()
                .value
                .id;
            let me = l.1.public_key_hex().to_owned();
            task = commit_local(&mut l.0, &l.1, &project_id, |d| {
                d.create_task(
                    Stamp {
                        actor: &me,
                        at: "t",
                    },
                    TaskInit {
                        title: "Tulis laporan".into(),
                        ..Default::default()
                    },
                )
            })
            .unwrap()
            .value;
        }
        let conn = db::open(tmp.path()).unwrap();
        let id = ensure_identity(&conn, &store).unwrap();
        let doc = load_doc(&conn, &project_id, &actor_of(&id)).unwrap();
        assert_eq!(doc.live_task(&task).unwrap().title, "Tulis laporan");
        let rows = index_rows(&conn, &project_id).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].1, "PA-1");
        assert_eq!(counts(&conn, &project_id).unwrap(), (1, 1));
    }

    #[test]
    fn snapshot_equals_replay_and_every_change_verifies() {
        let mut l = Laptop::founder("Sari");
        let p = create_project(&mut l.conn, &l.id, "Alfa", "PA", None)
            .unwrap()
            .value;
        let a = add(&mut l, &p.id, "Satu");
        add(&mut l, &p.id, "Dua");
        let me = l.pk();
        commit_local(&mut l.conn, &l.id, &p.id, |d| {
            let s = Stamp {
                actor: &me,
                at: "t2",
            };
            d.move_task(s, &a, ColumnId::Done, 0)?;
            d.add_comment(s, &a, "beres")
        })
        .unwrap();

        let stored = stored_changes(&l.conn, &p.id).unwrap();
        assert_eq!(stored.len(), 4, "one change per mutation");
        let mut replay = BoardDoc::empty(&[9; 32]);
        for sc in &stored {
            let change: Change = verify_change(sc).unwrap();
            assert_eq!(sc.author, l.pk());
            replay.apply(change).unwrap();
        }
        let mut snap = load_doc(&l.conn, &p.id, &actor_of(&l.id)).unwrap();
        assert_eq!(replay.tasks().unwrap(), snap.tasks().unwrap());
        assert_eq!(replay.heads(), snap.heads());
        assert_eq!(replay.project(), snap.project());
        assert_eq!(counts(&l.conn, &p.id).unwrap(), (1, 2));
        assert_eq!(assigned_to(&l.conn, &l.pk()).unwrap().len(), 2);
    }

    #[test]
    fn oversized_local_change_is_refused() {
        let mut l = Laptop::founder("Sari");
        let p = create_project(&mut l.conn, &l.id, "Alfa", "PA", None)
            .unwrap()
            .value;
        let id = add(&mut l, &p.id, "Satu");
        let me = l.pk();
        // The doc layer does not validate lengths; a huge text must still be refused.
        let huge = "x".repeat(MAX_CHANGE_BYTES + 1);
        let err = commit_local(&mut l.conn, &l.id, &p.id, |d| {
            d.update_task(
                Stamp {
                    actor: &me,
                    at: "t",
                },
                &id,
                &crate::board::doc::TaskChanges {
                    description: Some(huge),
                    ..Default::default()
                },
                &|_| String::new(),
            )
        })
        .err()
        .unwrap();
        assert_eq!(err.code(), "invalid_input");
        assert_eq!(stored_changes(&l.conn, &p.id).unwrap().len(), 2);
        let doc = load_doc(&l.conn, &p.id, &actor_of(&l.id)).unwrap();
        assert_eq!(doc.live_task(&id).unwrap().description, "");
    }

    /// The code this laptop shows for the project.
    fn shown(l: &Laptop, project: &str) -> String {
        super::project(&l.conn, project).unwrap().code
    }

    fn task_codes(l: &Laptop, project: &str) -> Vec<String> {
        let mut v: Vec<String> = index_rows(&l.conn, project)
            .unwrap()
            .into_iter()
            .map(|r| r.1)
            .collect();
        v.sort();
        v
    }

    /// Sends `from` everything `to` lacks, as a transport would.
    fn send(from: &Laptop, to: &mut Laptop, project: &str) {
        use crate::board::sync;
        let have = if super::project(&to.conn, project).is_ok() {
            sync::heads(&to.conn, project).unwrap()
        } else {
            Vec::new()
        };
        let changes = sync::changes_since(&from.conn, project, &have).unwrap();
        crate::board::testutil::copy_registration(&from.conn, &to.conn, project);
        let r = sync::import_project(
            &mut to.conn,
            &crate::board::policy::LocalRolePolicy,
            project,
            Some(&from.pk()),
            changes,
        )
        .unwrap();
        assert_eq!((r.rejected, r.held, r.missing_deps), (0, 0, 0), "{r:?}");
        assert!(r.applied > 0, "{r:?}");
    }

    #[test]
    fn refresh_codes_follows_creation_order_and_rewrites_the_index() {
        let mut l = Laptop::founder("Sari");
        let p1 = create_project(&mut l.conn, &l.id, "Satu", "PA", None)
            .unwrap()
            .value;
        let p2 = create_project(&mut l.conn, &l.id, "Dua", "PB", None)
            .unwrap()
            .value;
        let p3 = create_project(&mut l.conn, &l.id, "Tiga", "PC", None)
            .unwrap()
            .value;
        add(&mut l, &p1.id, "a");
        add(&mut l, &p2.id, "b");
        // As if p2's document said PA and p2 were older than p1.
        l.conn
            .execute(
                "UPDATE board_projects SET doc_code = 'PA', created_at = '2026-01-01T00:00:00Z' WHERE id = ?1",
                [&p2.id],
            )
            .unwrap();
        let mut changed = refresh_codes(&l.conn).unwrap();
        changed.sort();
        let mut want = vec![p1.id.clone(), p2.id.clone()];
        want.sort();
        assert_eq!(changed, want);
        assert_eq!(shown(&l, &p2.id), "PA");
        assert_eq!(shown(&l, &p1.id), "PA2");
        assert_eq!(task_codes(&l, &p1.id), ["PA2-1"]);
        assert_eq!(task_codes(&l, &p2.id), ["PA-1"]);
        assert!(refresh_codes(&l.conn).unwrap().is_empty(), "stable");

        // A project whose own code is PA2 keeps it; the duplicate moves on.
        l.conn
            .execute(
                "UPDATE board_projects SET doc_code = 'PA2' WHERE id = ?1",
                [&p3.id],
            )
            .unwrap();
        refresh_codes(&l.conn).unwrap();
        assert_eq!(shown(&l, &p3.id), "PA2");
        assert_eq!(shown(&l, &p1.id), "PA3");
        assert_eq!(task_codes(&l, &p1.id), ["PA3-1"]);

        // New local projects may not take a shown code or a document code.
        for code in ["PA", "PA2", "PA3"] {
            let err = create_project(&mut l.conn, &l.id, "Baru", code, None)
                .err()
                .unwrap();
            assert_eq!(err.code(), "invalid_input", "{code}");
        }
        create_project(&mut l.conn, &l.id, "Baru", "PA4", None).unwrap();
    }

    #[test]
    fn two_offline_projects_with_one_code_show_the_same_codes_everywhere() {
        let mut a = Laptop::founder("Sari");
        let mut b = Laptop::joined(&a, "Budi");
        let mut c = Laptop::joined(&a, "Cici");
        // Budi may create projects too (superadmin on every laptop).
        for conn in [&a.conn, &b.conn, &c.conn] {
            add_member(conn, &b.pk(), "Budi", "superadmin");
        }
        add_member(&b.conn, &c.pk(), "Cici", "member");
        // Fixture tables are written directly, so no `project_create` op:
        // each project is registered with every member.
        let pa = create_project_local(&mut a.conn, &a.id, "Alfa", "PA", None)
            .unwrap()
            .value;
        let pb = create_project_local(&mut b.conn, &b.id, "Beta", "PA", None)
            .unwrap()
            .value;
        let everyone = [a.pk(), b.pk(), c.pk()];
        let everyone: Vec<&str> = everyone.iter().map(String::as_str).collect();
        crate::board::testutil::register_project(&a.conn, &pa.id, None, &a.pk(), &everyone);
        crate::board::testutil::register_project(&b.conn, &pb.id, None, &b.pk(), &everyone);
        add(&mut a, &pa.id, "a");
        add(&mut b, &pb.id, "b");

        // C only gets Beta: it shows the code in the document.
        send(&b, &mut c, &pb.id);
        assert_eq!(shown(&c, &pb.id), "PA");
        assert_eq!(task_codes(&c, &pb.id), ["PA-1"]);

        send(&a, &mut b, &pa.id);
        send(&b, &mut a, &pb.id);
        send(&a, &mut c, &pa.id);
        let first_is_alfa = (&pa.created_at, &pa.id) <= (&pb.created_at, &pb.id);
        let (first, second) = if first_is_alfa {
            (&pa.id, &pb.id)
        } else {
            (&pb.id, &pa.id)
        };
        for l in [&a, &b, &c] {
            assert_eq!(shown(l, first), "PA");
            assert_eq!(shown(l, second), "PA2");
            assert_eq!(task_codes(l, first), ["PA-1"]);
            assert_eq!(task_codes(l, second), ["PA2-1"]);
        }
        // The documents keep PA.
        let doc = load_doc(&a.conn, second, &actor_of(&a.id)).unwrap();
        assert_eq!(doc.project().code, "PA");
    }

    #[test]
    fn rename_from_another_laptop_shows() {
        let mut a = Laptop::founder("Sari");
        let mut b = Laptop::joined(&a, "Budi");
        let p = create_project_local(&mut a.conn, &a.id, "Alfa", "PA", None)
            .unwrap()
            .value;
        crate::board::testutil::register_project(&a.conn, &p.id, None, &a.pk(), &[&a.pk(), &b.pk()]);
        add(&mut a, &p.id, "a");
        send(&a, &mut b, &p.id);
        let c = commit_local(&mut a.conn, &a.id, &p.id, |d| d.rename_project("Alfa Baru")).unwrap();
        assert_eq!(c.changes.len(), 1);
        assert_eq!(super::project(&a.conn, &p.id).unwrap().name, "Alfa Baru");
        send(&a, &mut b, &p.id);
        let row = super::project(&b.conn, &p.id).unwrap();
        assert_eq!((row.name.as_str(), row.code.as_str()), ("Alfa Baru", "PA"));
        assert_eq!(task_codes(&b, &p.id), ["PA-1"]);
    }

    #[test]
    fn failed_or_empty_mutation_writes_nothing() {
        let mut l = Laptop::founder("Sari");
        let p = create_project(&mut l.conn, &l.id, "Alfa", "PA", None)
            .unwrap()
            .value;
        let err = commit_local(&mut l.conn, &l.id, &p.id, |d| {
            d.delete_task(
                Stamp {
                    actor: "x",
                    at: "t",
                },
                "nope",
            )
        })
        .err()
        .unwrap();
        assert_eq!(err.code(), "not_found");
        let empty = commit_local(&mut l.conn, &l.id, &p.id, |_| Ok(())).unwrap();
        assert!(empty.changes.is_empty());
        assert_eq!(stored_changes(&l.conn, &p.id).unwrap().len(), 1);
        assert_eq!(
            commit_local(&mut l.conn, &l.id, &"f".repeat(32), |_| Ok(()))
                .err()
                .unwrap()
                .code(),
            "not_found"
        );
    }
}
