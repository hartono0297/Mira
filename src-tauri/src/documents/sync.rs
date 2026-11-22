//! Connection points for the network stage (plan, bagian 3.3). Nothing here
//! talks to the network; the sync stage plugs in at two places:
//!
//! - Outbound: [`DocumentSync`]. The document runtime calls it after every
//!   local change (new document, new version, edit started or finished). The
//!   local build uses [`NoSync`]. The network implementation queues the
//!   records for rekan and pushes small blobs right away ([`blob_fetch_policy`]).
//! - Inbound: [`apply_remote_document`], [`apply_remote_version`] and
//!   [`set_remote_editing`] store what a rekan sent. They are idempotent, so
//!   the same record may arrive any number of times from any rekan. A version
//!   that branches from an older head simply becomes a second head, which is
//!   a conflict ("bentrok") without any special network logic.
//!
//! The network stage must check signatures and permissions (author is an
//! active member allowed to write in the document's scope) before calling
//! the `apply_remote_*` functions; they only validate the shape of the data.

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::blobs::{self, BlobHash};
use crate::documents::kinds::DocumentKind;
use crate::documents::store::{
    self, DocScope, DocumentRecord, NewVersion, VersionOrigin, VersionRecord, check_id, check_key,
};
use crate::error::{AppError, AppResult};

/// A remote "Sedang diedit" mark without an update for longer than this is
/// ignored in the view (the rekan's laptop probably went offline mid-edit).
pub const REMOTE_EDITING_STALE_SECS: i64 = 600;

/// Outbound hook: told about every local change that rekan should learn of.
/// All methods default to doing nothing. Called after the change is
/// committed; implementations must not block (queue and return).
pub trait DocumentSync: Send + Sync {
    /// A file was added to the library on this laptop.
    fn document_added(&self, doc: &DocumentRecord, first: &VersionRecord) {
        let _ = (doc, first);
    }

    /// A version was made on this laptop (save, restore, resolve).
    fn version_added(&self, doc: &DocumentRecord, version: &VersionRecord) {
        let _ = (doc, version);
    }

    /// This laptop started (`editing = true`) or finished editing a
    /// document. While editing, the network stage should repeat the mark more
    /// often than [`REMOTE_EDITING_STALE_SECS`] so rekan keep showing it.
    fn editing_changed(&self, document_id: &str, editor: &str, editing: bool, at: &str) {
        let _ = (document_id, editor, editing, at);
    }
}

/// Tahap 4 local build: no network.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoSync;

impl DocumentSync for NoSync {}

/// When a rekan should copy a version's content.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlobFetch {
    /// Small file: copy as soon as the version record arrives.
    Auto,
    /// Large file: copy when someone opens or exports it.
    OnDemand,
}

/// Uses [`blobs::should_auto_replicate`] (about 20 MB, PRD F-CHAT-05).
pub fn blob_fetch_policy(size: u64) -> BlobFetch {
    if blobs::should_auto_replicate(size) {
        BlobFetch::Auto
    } else {
        BlobFetch::OnDemand
    }
}

/// A document record as sent by a rekan.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDocument {
    pub id: String,
    pub team_id: Option<String>,
    pub project_id: Option<String>,
    pub name: String,
    pub kind: DocumentKind,
    pub created_by: String,
    pub created_at: String,
}

impl RemoteDocument {
    /// What this laptop sends for a local document.
    pub fn from_record(doc: &DocumentRecord) -> Self {
        RemoteDocument {
            id: doc.id.clone(),
            team_id: doc.team_id.clone(),
            project_id: doc.project_id.clone(),
            name: doc.name.clone(),
            kind: doc.kind,
            created_by: doc.created_by.clone(),
            created_at: doc.created_at.clone(),
        }
    }
}

/// A version record as sent by a rekan (without `seq`, which is local).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteVersion {
    pub id: String,
    pub document_id: String,
    pub parent_ids: Vec<String>,
    pub blob_hash: String,
    pub size: u64,
    pub author: String,
    pub created_at: String,
    pub origin: VersionOrigin,
    pub restored_from: Option<String>,
}

impl RemoteVersion {
    /// What this laptop sends for a version it holds.
    pub fn from_record(v: &VersionRecord) -> Self {
        RemoteVersion {
            id: v.id.clone(),
            document_id: v.document_id.clone(),
            parent_ids: v.parent_ids.clone(),
            blob_hash: v.blob.hash.as_str().to_owned(),
            size: v.blob.size,
            author: v.author.clone(),
            created_at: v.created_at.clone(),
            origin: v.origin,
            restored_from: v.restored_from.clone(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ApplyOutcome {
    /// The version was new on this laptop.
    pub inserted: bool,
    /// The document has more than one head after applying.
    pub conflict: bool,
}

fn check_optional_id(id: Option<&str>, what: &str) -> AppResult<()> {
    id.map_or(Ok(()), |id| check_id(id, what))
}

/// Stores a document announced by a rekan. Idempotent by id: `Ok(false)` if
/// it is already here (the stored record is not changed). A name already
/// used in the same library gets a local suffix (" (2)"), so nothing is
/// hidden. The document shows up in lists once its first version arrives.
pub fn apply_remote_document(
    conn: &mut Connection,
    d: &RemoteDocument,
    now: &str,
) -> AppResult<bool> {
    let _ = now;
    check_id(&d.id, "dokumen")?;
    check_optional_id(d.team_id.as_deref(), "tim")?;
    check_optional_id(d.project_id.as_deref(), "proyek")?;
    check_key(&d.created_by, "pembuat dokumen")?;
    let name = store::sanitize_file_name(&d.name)?;

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if store::document_exists(&tx, &d.id)? {
        return Ok(false);
    }
    let scope = DocScope {
        team_id: d.team_id.clone(),
        project_id: d.project_id.clone(),
    };
    let doc = DocumentRecord {
        id: d.id.clone(),
        team_id: d.team_id.clone(),
        project_id: d.project_id.clone(),
        name: store::unique_name(&tx, &scope, &name)?,
        // Derived from the name, never trusted from the rekan, so the icon and
        // the Edit button always match what Windows will open.
        kind: DocumentKind::from_file_name(&name),
        created_by: d.created_by.clone(),
        created_at: d.created_at.clone(),
    };
    store::insert_document_row(&tx, &doc)?;
    tx.commit()?;
    Ok(true)
}

/// Every version that descends from `version_id` (through stored parent
/// rows), used to refuse a version that would close a cycle.
fn descendants(conn: &Connection, version_id: &str) -> AppResult<HashSet<String>> {
    let mut stmt = conn.prepare(
        "WITH RECURSIVE d(id) AS (
             SELECT version_id FROM document_version_parents WHERE parent_id = ?1
             UNION
             SELECT p.version_id FROM document_version_parents p JOIN d ON p.parent_id = d.id)
         SELECT id FROM d",
    )?;
    let ids = stmt
        .query_map(params![version_id], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    Ok(ids)
}

/// Stores a version made by a rekan. Idempotent by id (`inserted: false` when
/// it is already here). The document must already be stored (`not_found`
/// otherwise; apply the document first). It gets the next local `seq` and
/// `received_at = now`.
///
/// Parents this laptop has not received yet are stored anyway: the version
/// is simply not their child until they arrive, and the graph completes
/// itself. A parent that belongs to another document, or a parent list that
/// would make a cycle, is refused with `invalid_input`.
///
/// This laptop's edit session is never touched: if the document is being
/// edited here, the next local save still uses the session's parents, so it
/// becomes a second head next to this version (a conflict the user resolves).
pub fn apply_remote_version(
    conn: &mut Connection,
    v: &RemoteVersion,
    now: &str,
) -> AppResult<ApplyOutcome> {
    check_id(&v.id, "versi")?;
    check_id(&v.document_id, "dokumen")?;
    for parent in &v.parent_ids {
        check_id(parent, "versi induk")?;
    }
    if v.parent_ids.contains(&v.id) {
        return Err(AppError::InvalidInput(
            "Versi tidak boleh menjadi induk dirinya sendiri.".into(),
        ));
    }
    let hash = BlobHash::parse(&v.blob_hash)?;
    check_key(&v.author, "penulis")?;
    check_optional_id(v.restored_from.as_deref(), "versi asal")?;

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing: Option<String> = tx
        .query_row(
            "SELECT document_id FROM document_versions WHERE id = ?1",
            params![v.id],
            |r| r.get(0),
        )
        .optional()?;
    let inserted = match existing {
        Some(doc) if doc == v.document_id => false,
        Some(_) => {
            return Err(AppError::InvalidInput(
                "Versi ini sudah tercatat untuk dokumen lain.".into(),
            ));
        }
        None => {
            if !store::document_exists(&tx, &v.document_id)? {
                return Err(AppError::NotFound(
                    "Dokumen untuk versi ini belum ada di laptop ini.".into(),
                ));
            }
            for parent in &v.parent_ids {
                let owner: Option<String> = tx
                    .query_row(
                        "SELECT document_id FROM document_versions WHERE id = ?1",
                        params![parent],
                        |r| r.get(0),
                    )
                    .optional()?;
                if owner.is_some_and(|o| o != v.document_id) {
                    return Err(AppError::InvalidInput(
                        "Versi induk bukan versi dari dokumen ini.".into(),
                    ));
                }
            }
            let below = descendants(&tx, &v.id)?;
            if v.parent_ids.iter().any(|p| below.contains(p)) {
                return Err(AppError::InvalidInput(
                    "Riwayat versi dari rekan tidak masuk akal (berputar).".into(),
                ));
            }
            store::insert_version(
                &tx,
                &NewVersion {
                    id: v.id.clone(),
                    document_id: &v.document_id,
                    parent_ids: &v.parent_ids,
                    blob_hash: hash.as_str(),
                    size: v.size,
                    author: &v.author,
                    created_at: &v.created_at,
                    origin: v.origin,
                    restored_from: v.restored_from.as_deref(),
                    received_at: Some(now),
                },
            )?;
            true
        }
    };
    let conflict = store::heads(&tx, &v.document_id)?.len() > 1;
    tx.commit()?;
    Ok(ApplyOutcome { inserted, conflict })
}

/// Stores or clears a rekan's "Sedang diedit" mark. `since = Some(start)`
/// sets it (and refreshes `seen_at = now`); `None` removes it.
pub fn set_remote_editing(
    conn: &Connection,
    document_id: &str,
    editor: &str,
    since: Option<&str>,
    now: &str,
) -> AppResult<()> {
    check_key(editor, "editor")?;
    match since {
        None => {
            conn.execute(
                "DELETE FROM document_remote_editing WHERE document_id = ?1 AND editor = ?2",
                params![document_id, editor],
            )?;
        }
        Some(since) => {
            if !store::document_exists(conn, document_id)? {
                return Err(AppError::NotFound(
                    "Dokumen tidak ditemukan di laptop ini.".into(),
                ));
            }
            conn.execute(
                "INSERT INTO document_remote_editing (document_id, editor, since, seen_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (document_id, editor) DO UPDATE SET since = ?3, seen_at = ?4",
                params![document_id, editor, since, now],
            )?;
        }
    }
    Ok(())
}

/// True when a mark seen at `seen_at` is at most
/// [`REMOTE_EDITING_STALE_SECS`] old at `now`. Unreadable times count as stale.
pub fn is_fresh(seen_at: &str, now: &str) -> bool {
    match (
        OffsetDateTime::parse(seen_at, &Rfc3339),
        OffsetDateTime::parse(now, &Rfc3339),
    ) {
        (Ok(seen), Ok(now)) => (now - seen).whole_seconds() <= REMOTE_EDITING_STALE_SECS,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blobs::{AUTO_REPLICATE_MAX_BYTES, BlobHash};
    use crate::documents::access::RoleAccess;
    use crate::documents::store::tests::{Fixture, T0, T1, T2, T3, put};
    use crate::documents::store::{
        current, edit_session, get_document, heads, insert_edit_session, new_id,
        record_saved_version, resolve_conflict, versions,
    };
    use crate::documents::view::{detail, summaries, summary};

    const REKAN: &str = "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00";

    fn remote_version(doc: &str, parents: &[&str], content: &str) -> RemoteVersion {
        let hash = BlobHash::of_bytes(content.as_bytes());
        RemoteVersion {
            id: new_id(),
            document_id: doc.into(),
            parent_ids: parents.iter().map(|p| p.to_string()).collect(),
            blob_hash: hash.as_str().into(),
            size: content.len() as u64,
            author: REKAN.into(),
            created_at: T1.into(),
            origin: VersionOrigin::Edited,
            restored_from: None,
        }
    }

    fn remote_doc(name: &str) -> RemoteDocument {
        RemoteDocument {
            id: new_id(),
            team_id: None,
            project_id: None,
            name: name.into(),
            kind: DocumentKind::from_file_name(name),
            created_by: REKAN.into(),
            created_at: T0.into(),
        }
    }

    #[test]
    fn remote_kind_comes_from_the_name_not_the_sender() {
        let mut f = Fixture::new();
        let lying = RemoteDocument {
            kind: DocumentKind::Word,
            ..remote_doc("laporan.exe")
        };
        assert!(apply_remote_document(&mut f.conn, &lying, T1).unwrap());
        let stored = store::get_document(&f.conn, &lying.id).unwrap();
        assert_eq!(stored.kind, DocumentKind::Other);
    }

    #[test]
    fn fetch_policy_follows_the_auto_replicate_limit() {
        assert_eq!(blob_fetch_policy(0), BlobFetch::Auto);
        assert_eq!(blob_fetch_policy(AUTO_REPLICATE_MAX_BYTES), BlobFetch::Auto);
        assert_eq!(
            blob_fetch_policy(AUTO_REPLICATE_MAX_BYTES + 1),
            BlobFetch::OnDemand
        );
    }

    #[test]
    fn no_sync_does_nothing() {
        let mut f = Fixture::new();
        let (doc, v1) = f.add("a.docx", "a");
        let sync: &dyn DocumentSync = &NoSync;
        sync.document_added(&doc, &v1);
        sync.version_added(&doc, &v1);
        sync.editing_changed(&doc.id, REKAN, true, T1);
    }

    #[test]
    fn remote_document_and_versions_are_idempotent() {
        let mut f = Fixture::new();
        f.add("Laporan.docx", "lokal");
        let d = remote_doc("Laporan.docx");
        assert!(apply_remote_document(&mut f.conn, &d, T1).unwrap());
        assert!(!apply_remote_document(&mut f.conn, &d, T2).unwrap());
        let stored = get_document(&f.conn, &d.id).unwrap();
        assert_eq!(
            stored.name, "Laporan (2).docx",
            "local suffix for a taken name"
        );
        assert_eq!(stored.created_by, REKAN);

        // No version yet: hidden from the list, not_found for the summary.
        let list = summaries(&f.conn, &f.blobs, &f.me, &RoleAccess, None, T1).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(
            summary(&f.conn, &f.blobs, &f.me, &RoleAccess, &d.id, T1)
                .unwrap_err()
                .code(),
            "not_found"
        );
        assert_eq!(current(&f.conn, &d.id).unwrap_err().code(), "not_found");

        let v1 = RemoteVersion {
            origin: VersionOrigin::Added,
            ..remote_version(&d.id, &[], "isi rekan")
        };
        let out = apply_remote_version(&mut f.conn, &v1, T2).unwrap();
        assert_eq!(
            out,
            ApplyOutcome {
                inserted: true,
                conflict: false
            }
        );
        let out = apply_remote_version(&mut f.conn, &v1, T3).unwrap();
        assert_eq!(
            out,
            ApplyOutcome {
                inserted: false,
                conflict: false
            }
        );
        let vs = versions(&f.conn, &d.id).unwrap();
        assert_eq!(vs.len(), 1);
        assert_eq!(vs[0].seq, 1);
        assert_eq!(vs[0].received_at.as_deref(), Some(T2));
        assert_eq!(RemoteVersion::from_record(&vs[0]), v1);
        assert_eq!(RemoteDocument::from_record(&stored).id, d.id);

        let s = summary(&f.conn, &f.blobs, &f.me, &RoleAccess, &d.id, T3).unwrap();
        assert!(s.current.received);
        assert!(!s.current.available, "content not copied yet");
        assert_eq!(s.created_by.display_name, "Rekan C0FF");
        assert!(!s.created_by.is_me);
        assert_eq!(
            summaries(&f.conn, &f.blobs, &f.me, &RoleAccess, None, T3)
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn remote_records_are_validated() {
        let mut f = Fixture::new();
        let (doc, v1) = f.add("a.docx", "a");
        let (other, o1) = f.add("b.docx", "b");

        for bad in [
            RemoteDocument {
                id: "xyz".into(),
                ..remote_doc("x.docx")
            },
            RemoteDocument {
                created_by: "AB".repeat(32),
                ..remote_doc("x.docx")
            },
            RemoteDocument {
                name: "CON.docx".into(),
                ..remote_doc("x.docx")
            },
            RemoteDocument {
                project_id: Some("1".into()),
                ..remote_doc("x.docx")
            },
        ] {
            assert_eq!(
                apply_remote_document(&mut f.conn, &bad, T1)
                    .unwrap_err()
                    .code(),
                "invalid_input"
            );
        }

        let good = remote_version(&doc.id, &[&v1.id], "x");
        let cases = [
            RemoteVersion {
                id: "ABCD".repeat(8),
                ..good.clone()
            },
            RemoteVersion {
                blob_hash: "ab".into(),
                ..good.clone()
            },
            RemoteVersion {
                blob_hash: "AB".repeat(32),
                ..good.clone()
            },
            RemoteVersion {
                author: "12".into(),
                ..good.clone()
            },
            RemoteVersion {
                parent_ids: vec!["nope".into()],
                ..good.clone()
            },
            RemoteVersion {
                parent_ids: vec![good.id.clone()],
                ..good.clone()
            },
            RemoteVersion {
                parent_ids: vec![o1.id.clone()],
                ..good.clone()
            },
            RemoteVersion {
                restored_from: Some("x".into()),
                ..good.clone()
            },
            RemoteVersion {
                id: o1.id.clone(),
                ..good.clone()
            },
        ];
        for bad in cases {
            let err = apply_remote_version(&mut f.conn, &bad, T1).unwrap_err();
            assert_eq!(err.code(), "invalid_input", "{bad:?}");
        }
        let missing_doc = RemoteVersion {
            document_id: "00".repeat(16),
            ..good.clone()
        };
        assert_eq!(
            apply_remote_version(&mut f.conn, &missing_doc, T1)
                .unwrap_err()
                .code(),
            "not_found"
        );
        assert_eq!(versions(&f.conn, &doc.id).unwrap().len(), 1);
        assert_eq!(versions(&f.conn, &other.id).unwrap().len(), 1);
        apply_remote_version(&mut f.conn, &good, T1).unwrap();
    }

    #[test]
    fn unknown_parents_are_kept_and_the_graph_completes_later() {
        let mut f = Fixture::new();
        let (doc, v1) = f.add("a.docx", "a");
        // v3 arrives before its parent v2.
        let v2 = remote_version(&doc.id, &[&v1.id], "dua");
        let v3 = remote_version(&doc.id, &[&v2.id], "tiga");
        let out = apply_remote_version(&mut f.conn, &v3, T1).unwrap();
        assert!(out.inserted);
        assert!(out.conflict, "v1 and v3 are both heads until v2 arrives");
        assert_eq!(get_version_parents(&f, &v3.id), vec![v2.id.clone()]);

        let out = apply_remote_version(&mut f.conn, &v2, T2).unwrap();
        assert_eq!(
            out,
            ApplyOutcome {
                inserted: true,
                conflict: false
            }
        );
        let hs = heads(&f.conn, &doc.id).unwrap();
        assert_eq!(hs.len(), 1);
        assert_eq!(hs[0].id, v3.id);
        assert_eq!(hs[0].seq, 2, "local numbers follow arrival order");

        // A version claiming one of its descendants as parent would close a cycle.
        let unknown = new_id();
        let child = remote_version(&doc.id, &[&unknown], "anak");
        apply_remote_version(&mut f.conn, &child, T3).unwrap();
        let loop_back = RemoteVersion {
            id: unknown,
            ..remote_version(&doc.id, &[&child.id], "putar")
        };
        assert_eq!(
            apply_remote_version(&mut f.conn, &loop_back, T3)
                .unwrap_err()
                .code(),
            "invalid_input"
        );
    }

    fn get_version_parents(f: &Fixture, id: &str) -> Vec<String> {
        crate::documents::store::get_version(&f.conn, id)
            .unwrap()
            .parent_ids
    }

    #[test]
    fn remote_version_during_local_edit_becomes_a_conflict_on_save() {
        let mut f = Fixture::new();
        let (doc, v1) = f.add("Kontrak.docx", "satu");
        let pk = f.pk();
        insert_edit_session(&f.conn, &f.session(&doc, &[&v1.id], &v1.blob)).unwrap();
        let before = edit_session(&f.conn, &doc.id).unwrap();

        // A rekan's version based on v1 arrives while Sari edits.
        let remote = remote_version(&doc.id, &[&v1.id], "versi rekan");
        let out = apply_remote_version(&mut f.conn, &remote, T1).unwrap();
        assert_eq!(
            out,
            ApplyOutcome {
                inserted: true,
                conflict: false
            }
        );
        assert_eq!(
            edit_session(&f.conn, &doc.id).unwrap(),
            before,
            "session untouched"
        );

        // Sari saves: her version is also based on v1, so two heads.
        let mine =
            record_saved_version(&mut f.conn, &doc.id, &put(&f.blobs, "versi Sari"), &pk, T2)
                .unwrap()
                .unwrap();
        assert_eq!(mine.parent_ids, vec![v1.id.clone()]);
        let hs = heads(&f.conn, &doc.id).unwrap();
        assert_eq!(hs.len(), 2);

        let s = summary(&f.conn, &f.blobs, &f.me, &RoleAccess, &doc.id, T2).unwrap();
        assert!(s.conflict);
        let numbers: Vec<i64> = s.conflict_versions.iter().map(|v| v.number).collect();
        assert_eq!(numbers, vec![3, 2]);
        assert_eq!(s.current.number, 3);
        assert!(s.conflict_versions.iter().all(|v| v.is_head));
        assert!(s.conflict_versions[1].received && !s.conflict_versions[1].available);
        assert!(s.conflict_versions[0].available);

        // After finishing the edit, "Pakai versi ini" ends the conflict.
        crate::documents::store::delete_edit_session(&f.conn, &doc.id).unwrap();
        let resolved = resolve_conflict(&mut f.conn, &doc.id, &mine.id, &pk, T3).unwrap();
        let s = detail(&f.conn, &f.blobs, &f.me, &RoleAccess, &doc.id, T3).unwrap();
        assert!(!s.summary.conflict);
        assert!(s.summary.conflict_versions.is_empty());
        assert_eq!(s.summary.current.id, resolved.id);
        assert_eq!(s.versions.len(), 4);
    }

    #[test]
    fn remote_editing_marks_expire_and_can_be_cleared() {
        let mut f = Fixture::new();
        let (doc, v1) = f.add("a.docx", "a");
        let start = "2026-11-22T09:00:00Z";
        set_remote_editing(&f.conn, &doc.id, REKAN, Some(start), start).unwrap();

        let at = |now: &str| summary(&f.conn, &f.blobs, &f.me, &RoleAccess, &doc.id, now).unwrap();
        let s = at("2026-11-22T09:10:00Z");
        assert_eq!(s.editing.len(), 1);
        assert!(!s.editing[0].local);
        assert_eq!(s.editing[0].since, start);
        assert_eq!(s.editing[0].editor.display_name, "Rekan C0FF");
        assert!(
            at("2026-11-22T09:10:01Z").editing.is_empty(),
            "stale after 10 minutes"
        );

        // A refresh keeps `since` and moves `seen_at`.
        set_remote_editing(&f.conn, &doc.id, REKAN, Some(start), "2026-11-22T09:09:00Z").unwrap();
        assert_eq!(at("2026-11-22T09:15:00Z").editing.len(), 1);

        // Local session comes first.
        insert_edit_session(&f.conn, &f.session(&doc, &[&v1.id], &v1.blob)).unwrap();
        let s = at("2026-11-22T09:15:00Z");
        assert_eq!(s.editing.len(), 2);
        assert!(s.editing[0].local && s.editing[0].editor.is_me);
        assert!(!s.editing[1].local);

        set_remote_editing(&f.conn, &doc.id, REKAN, None, "2026-11-22T09:16:00Z").unwrap();
        set_remote_editing(&f.conn, &doc.id, REKAN, None, "2026-11-22T09:16:00Z").unwrap();
        assert_eq!(at("2026-11-22T09:16:00Z").editing.len(), 1);

        assert_eq!(
            set_remote_editing(&f.conn, &"00".repeat(16), REKAN, Some(start), start)
                .unwrap_err()
                .code(),
            "not_found"
        );
        assert_eq!(
            set_remote_editing(&f.conn, &doc.id, "bad", Some(start), start)
                .unwrap_err()
                .code(),
            "invalid_input"
        );
    }

    #[test]
    fn freshness_uses_the_stale_limit() {
        assert!(is_fresh("2026-11-22T09:00:00Z", "2026-11-22T09:10:00Z"));
        assert!(!is_fresh("2026-11-22T09:00:00Z", "2026-11-22T09:10:01Z"));
        assert!(
            is_fresh("2026-11-22T09:05:00Z", "2026-11-22T09:00:00Z"),
            "clock skew"
        );
        assert!(!is_fresh("kemarin", "2026-11-22T09:00:00Z"));
    }
}
