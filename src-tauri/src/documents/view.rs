//! What the frontend sees about documents (plan, bagian 4). The structs
//! serialize to the TypeScript types `DocumentSummary`, `DocumentDetail`,
//! `DocumentVersion`, `EditingInfo` and `PersonRef` in camelCase.
//!
//! Re-exported from `documents::store`, so callers use `store::summary` etc.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::blobs::{self, BlobStore};
use crate::documents::access::{DocAction, DocumentAccess};
use crate::documents::kinds::DocumentKind;
use crate::documents::peer_sync;
use crate::documents::store::{self, DocumentRecord, VersionOrigin, VersionRecord};
use crate::documents::sync::is_fresh;
use crate::error::{AppError, AppResult};
use crate::identity::{self, Identity};

/// A person shown next to a version or an edit mark.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonRef {
    pub public_key: String,
    pub display_name: String,
    pub is_me: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentVersion {
    pub id: String,
    /// Local `seq` ("Versi 3").
    pub number: i64,
    pub size: u64,
    pub blob_hash: String,
    pub author: PersonRef,
    pub created_at: String,
    pub origin: VersionOrigin,
    /// Number of the restored version, `None` if not a restore or that
    /// version is not on this laptop.
    pub restored_from_number: Option<i64>,
    pub parent_ids: Vec<String>,
    pub is_head: bool,
    /// Came from a rekan.
    pub received: bool,
    /// The content is in this laptop's blob store.
    pub available: bool,
    /// The content is being copied from a rekan right now.
    pub downloading: bool,
    /// Small enough (up to 20 MB) to be copied as soon as it arrives; larger
    /// files are copied with `download_version`.
    pub auto_download: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditingInfo {
    pub editor: PersonRef,
    pub since: String,
    /// The edit runs on this laptop.
    pub local: bool,
    pub last_saved_at: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentCan {
    pub edit: bool,
    pub restore: bool,
    pub resolve: bool,
    pub export: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSummary {
    pub id: String,
    pub name: String,
    pub kind: DocumentKind,
    pub project_id: Option<String>,
    pub team_id: Option<String>,
    pub created_at: String,
    pub created_by: PersonRef,
    /// The head with the highest number.
    pub current: DocumentVersion,
    pub version_count: usize,
    /// More than one head.
    pub conflict: bool,
    /// The heads while in conflict (number descending), empty otherwise.
    pub conflict_versions: Vec<DocumentVersion>,
    /// This laptop's session first, then fresh marks from rekan.
    pub editing: Vec<EditingInfo>,
    pub can: DocumentCan,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentDetail {
    #[serde(flatten)]
    pub summary: DocumentSummary,
    /// Every version, number descending.
    pub versions: Vec<DocumentVersion>,
}

/// Resolves public keys to names once per view.
struct People<'a> {
    conn: &'a Connection,
    me: &'a Identity,
    cache: HashMap<String, PersonRef>,
}

impl<'a> People<'a> {
    fn new(conn: &'a Connection, me: &'a Identity) -> Self {
        People {
            conn,
            me,
            cache: HashMap::new(),
        }
    }

    fn get(&mut self, public_key: &str) -> AppResult<PersonRef> {
        if let Some(p) = self.cache.get(public_key) {
            return Ok(p.clone());
        }
        let p = person_ref(self.conn, self.me, public_key)?;
        self.cache.insert(public_key.to_owned(), p.clone());
        Ok(p)
    }
}

/// Name from `members` (any status, so removed people keep their name in the
/// history); for this laptop without a member row, its own display name;
/// otherwise "Rekan " plus the first fingerprint group.
pub fn person_ref(conn: &Connection, me: &Identity, public_key: &str) -> AppResult<PersonRef> {
    let is_me = public_key == me.public_key_hex();
    let member: Option<String> = conn
        .query_row(
            "SELECT display_name FROM members WHERE public_key = ?1
             ORDER BY status = 'active' DESC LIMIT 1",
            params![public_key],
            |r| r.get(0),
        )
        .optional()?;
    let display_name = match member {
        Some(name) => name,
        None => match me.display_name().filter(|_| is_me) {
            Some(name) => name.to_owned(),
            None => {
                let fp = identity::fingerprint(public_key);
                let group = fp.split(' ').next().unwrap_or_default();
                format!("Rekan {group}")
            }
        },
    };
    Ok(PersonRef {
        public_key: public_key.to_owned(),
        display_name,
        is_me,
    })
}

fn view_version(
    v: &VersionRecord,
    numbers: &HashMap<&str, i64>,
    head_ids: &HashSet<&str>,
    blobs: &BlobStore,
    people: &mut People<'_>,
) -> AppResult<DocumentVersion> {
    Ok(DocumentVersion {
        id: v.id.clone(),
        number: v.seq,
        size: v.blob.size,
        blob_hash: v.blob.hash.as_str().to_owned(),
        author: people.get(&v.author)?,
        created_at: v.created_at.clone(),
        origin: v.origin,
        restored_from_number: v
            .restored_from
            .as_deref()
            .and_then(|id| numbers.get(id).copied()),
        parent_ids: v.parent_ids.clone(),
        is_head: head_ids.contains(v.id.as_str()),
        received: v.received_at.is_some(),
        available: blobs.contains(&v.blob.hash),
        downloading: peer_sync::is_downloading(blobs, &v.blob.hash),
        auto_download: blobs::should_auto_replicate(v.blob.size),
    })
}

fn editing(
    conn: &Connection,
    document_id: &str,
    now: &str,
    people: &mut People<'_>,
) -> AppResult<Vec<EditingInfo>> {
    let mut out = Vec::new();
    if let Some(s) = store::edit_session(conn, document_id)? {
        out.push(EditingInfo {
            editor: people.get(&s.editor)?,
            since: s.started_at,
            local: true,
            last_saved_at: s.last_saved_at,
        });
    }
    let mut stmt = conn.prepare(
        "SELECT editor, since, seen_at FROM document_remote_editing
         WHERE document_id = ?1 ORDER BY since, editor",
    )?;
    let marks = stmt
        .query_map(params![document_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (editor, since, seen_at) in marks {
        if editor == people.me.public_key_hex() || !is_fresh(&seen_at, now) {
            continue;
        }
        out.push(EditingInfo {
            editor: people.get(&editor)?,
            since,
            local: false,
            last_saved_at: None,
        });
    }
    Ok(out)
}

/// Builds the summary (and the version list when asked). `None` when the
/// document has no version on this laptop yet.
fn build(
    conn: &Connection,
    blobs: &BlobStore,
    me: &Identity,
    access: &dyn DocumentAccess,
    doc: DocumentRecord,
    now: &str,
    with_versions: bool,
) -> AppResult<Option<(DocumentSummary, Vec<DocumentVersion>)>> {
    let all = store::versions(conn, &doc.id)?;
    if all.is_empty() {
        return Ok(None);
    }
    let heads = store::heads(conn, &doc.id)?;
    let numbers: HashMap<&str, i64> = all.iter().map(|v| (v.id.as_str(), v.seq)).collect();
    let head_ids: HashSet<&str> = heads.iter().map(|v| v.id.as_str()).collect();
    let mut people = People::new(conn, me);

    // `heads` is empty only for a malformed graph; fall back to the newest.
    let current = heads.first().unwrap_or(&all[0]);
    let current = view_version(current, &numbers, &head_ids, blobs, &mut people)?;
    let conflict = heads.len() > 1;
    let conflict_versions = if conflict {
        heads
            .iter()
            .map(|v| view_version(v, &numbers, &head_ids, blobs, &mut people))
            .collect::<AppResult<_>>()?
    } else {
        Vec::new()
    };
    let versions = if with_versions {
        all.iter()
            .map(|v| view_version(v, &numbers, &head_ids, blobs, &mut people))
            .collect::<AppResult<_>>()?
    } else {
        Vec::new()
    };

    let scope = doc.scope();
    let can = DocumentCan {
        edit: doc.kind.editable() && access.allows(conn, me, &scope, DocAction::Edit)?,
        restore: access.allows(conn, me, &scope, DocAction::Restore)?,
        resolve: access.allows(conn, me, &scope, DocAction::Resolve)?,
        export: access.allows(conn, me, &scope, DocAction::Export)?,
    };
    let summary = DocumentSummary {
        editing: editing(conn, &doc.id, now, &mut people)?,
        created_by: people.get(&doc.created_by)?,
        version_count: all.len(),
        id: doc.id,
        name: doc.name,
        kind: doc.kind,
        project_id: doc.project_id,
        team_id: doc.team_id,
        created_at: doc.created_at,
        current,
        conflict,
        conflict_versions,
        can,
    };
    Ok(Some((summary, versions)))
}

fn not_received() -> AppError {
    AppError::NotFound("Isi dokumen ini belum diterima dari rekan.".into())
}

/// One document for the list. `forbidden` when this laptop may not view it,
/// `not_found` when it is unknown or has no version here yet.
pub fn summary(
    conn: &Connection,
    blobs: &BlobStore,
    me: &Identity,
    access: &dyn DocumentAccess,
    document_id: &str,
    now: &str,
) -> AppResult<DocumentSummary> {
    let doc = store::get_document(conn, document_id)?;
    access.check(conn, me, &doc.scope(), DocAction::View)?;
    build(conn, blobs, me, access, doc, now, false)?
        .map(|(s, _)| s)
        .ok_or_else(not_received)
}

/// The summary plus every version (number descending).
pub fn detail(
    conn: &Connection,
    blobs: &BlobStore,
    me: &Identity,
    access: &dyn DocumentAccess,
    document_id: &str,
    now: &str,
) -> AppResult<DocumentDetail> {
    let doc = store::get_document(conn, document_id)?;
    access.check(conn, me, &doc.scope(), DocAction::View)?;
    build(conn, blobs, me, access, doc, now, true)?
        .map(|(summary, versions)| DocumentDetail { summary, versions })
        .ok_or_else(not_received)
}

/// One library (`None` = general library), sorted by name. Documents this
/// laptop may not view, and documents without a version here yet, are left out.
pub fn summaries(
    conn: &Connection,
    blobs: &BlobStore,
    me: &Identity,
    access: &dyn DocumentAccess,
    project_id: Option<&str>,
    now: &str,
) -> AppResult<Vec<DocumentSummary>> {
    let mut out = Vec::new();
    for doc in store::list_documents(conn, project_id)? {
        if !access.allows(conn, me, &doc.scope(), DocAction::View)? {
            continue;
        }
        if let Some((s, _)) = build(conn, blobs, me, access, doc, now, false)? {
            out.push(s);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::documents::access::RoleAccess;
    use crate::documents::store::tests::{Fixture, T0, T1, T2, T3, put};
    use crate::documents::store::{
        VersionOrigin, add_version, insert_edit_session, record_saved_version, restore_version,
    };

    fn keys(v: &serde_json::Value) -> Vec<String> {
        let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        k.sort();
        k
    }

    fn sorted(list: &[&str]) -> Vec<String> {
        let mut v: Vec<String> = list.iter().map(|s| s.to_string()).collect();
        v.sort();
        v
    }

    #[test]
    fn summary_json_has_the_frontend_shape() {
        let mut f = Fixture::new();
        let (doc, v1) = f.add("Laporan.docx", "isi");
        insert_edit_session(&f.conn, &f.session(&doc, &[&v1.id], &v1.blob)).unwrap();
        let s = summary(&f.conn, &f.blobs, &f.me, &RoleAccess, &doc.id, T1).unwrap();
        let json = serde_json::to_value(&s).unwrap();

        assert_eq!(
            keys(&json),
            sorted(&[
                "id",
                "name",
                "kind",
                "projectId",
                "teamId",
                "createdAt",
                "createdBy",
                "current",
                "versionCount",
                "conflict",
                "conflictVersions",
                "editing",
                "can",
            ])
        );
        assert_eq!(json["kind"], "word");
        assert_eq!(json["projectId"], serde_json::Value::Null);
        assert_eq!(json["teamId"], serde_json::Value::Null);
        assert_eq!(json["versionCount"], 1);
        assert_eq!(json["conflict"], false);
        assert_eq!(json["conflictVersions"], serde_json::json!([]));
        assert_eq!(
            keys(&json["createdBy"]),
            sorted(&["publicKey", "displayName", "isMe"])
        );
        assert_eq!(json["createdBy"]["displayName"], "Sari");
        assert_eq!(json["createdBy"]["isMe"], true);
        assert_eq!(
            keys(&json["current"]),
            sorted(&[
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
                "downloading",
                "autoDownload",
            ])
        );
        assert_eq!(json["current"]["downloading"], false);
        assert_eq!(json["current"]["autoDownload"], true);
        assert_eq!(json["current"]["number"], 1);
        assert_eq!(json["current"]["size"], 3);
        assert_eq!(json["current"]["origin"], "added");
        assert_eq!(
            json["current"]["restoredFromNumber"],
            serde_json::Value::Null
        );
        assert_eq!(json["current"]["parentIds"], serde_json::json!([]));
        assert_eq!(json["current"]["isHead"], true);
        assert_eq!(json["current"]["received"], false);
        assert_eq!(json["current"]["available"], true);
        assert_eq!(
            keys(&json["editing"][0]),
            sorted(&["editor", "since", "local", "lastSavedAt"])
        );
        assert_eq!(json["editing"][0]["local"], true);
        assert_eq!(json["editing"][0]["since"], T1);
        assert_eq!(json["editing"][0]["lastSavedAt"], serde_json::Value::Null);
        assert_eq!(
            keys(&json["can"]),
            sorted(&["edit", "restore", "resolve", "export"])
        );

        let d = detail(&f.conn, &f.blobs, &f.me, &RoleAccess, &doc.id, T1).unwrap();
        let json = serde_json::to_value(&d).unwrap();
        let mut expected = keys(&serde_json::to_value(&s).unwrap());
        expected.push("versions".into());
        expected.sort();
        assert_eq!(keys(&json), expected);
        assert_eq!(json["versions"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn detail_lists_versions_with_heads_numbers_and_restore_source() {
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
        let v3 = restore_version(&mut f.conn, &doc.id, &v1.id, &pk, T2).unwrap();

        let d = detail(&f.conn, &f.blobs, &f.me, &RoleAccess, &doc.id, T3).unwrap();
        let numbers: Vec<i64> = d.versions.iter().map(|v| v.number).collect();
        assert_eq!(numbers, vec![3, 2, 1]);
        assert_eq!(d.summary.current.id, v3.id);
        assert_eq!(d.summary.version_count, 3);
        assert_eq!(d.versions[0].restored_from_number, Some(1));
        assert_eq!(d.versions[0].origin, VersionOrigin::Restored);
        assert_eq!(d.versions[0].parent_ids, vec![v2.id.clone()]);
        assert!(d.versions[0].is_head);
        assert!(!d.versions[1].is_head && !d.versions[2].is_head);
        assert!(d.versions.iter().all(|v| v.available && !v.received));
        assert!(d.versions.iter().all(|v| v.author.is_me));
        assert!(!d.summary.conflict);
    }

    #[test]
    fn can_flags_follow_role_and_kind() {
        let mut f = Fixture::new();
        let (word, _) = f.add("Surat.docx", "w");
        let (pdf, _) = f.add("Kontrak.pdf", "p");

        let s = summary(&f.conn, &f.blobs, &f.me, &RoleAccess, &word.id, T0).unwrap();
        assert_eq!(
            s.can,
            DocumentCan {
                edit: true,
                restore: true,
                resolve: true,
                export: true
            }
        );
        let s = summary(&f.conn, &f.blobs, &f.me, &RoleAccess, &pdf.id, T0).unwrap();
        assert!(!s.can.edit, "PDF is not editable");
        assert!(s.can.restore);

        // Tamu: nothing in the general library (plan, "Batas tim dan
        // proyek"). In an allowed project a guest may view and export only
        // (`access::tests::scope_follows_teams_and_guest_projects`).
        f.conn
            .execute("UPDATE members SET role = 'guest'", [])
            .unwrap();
        let err = summary(&f.conn, &f.blobs, &f.me, &RoleAccess, &word.id, T0).unwrap_err();
        assert_eq!(err.code(), "forbidden");
        assert!(
            summaries(&f.conn, &f.blobs, &f.me, &RoleAccess, None, T0)
                .unwrap()
                .is_empty()
        );

        // Removed laptop: nothing, not even the list.
        f.conn
            .execute("UPDATE members SET status = 'removed'", [])
            .unwrap();
        let err = summary(&f.conn, &f.blobs, &f.me, &RoleAccess, &word.id, T0).unwrap_err();
        assert_eq!(err.code(), "forbidden");
        assert!(
            summaries(&f.conn, &f.blobs, &f.me, &RoleAccess, None, T0)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn people_come_from_members_or_the_fingerprint() {
        let f = Fixture::new();
        let me = person_ref(&f.conn, &f.me, &f.pk()).unwrap();
        assert_eq!((me.display_name.as_str(), me.is_me), ("Sari", true));

        let stranger = "ab12cd34".repeat(8);
        let p = person_ref(&f.conn, &f.me, &stranger).unwrap();
        assert_eq!(p.display_name, "Rekan AB12");
        assert!(!p.is_me);

        let org_id: String = f
            .conn
            .query_row("SELECT id FROM organizations", [], |r| r.get(0))
            .unwrap();
        f.conn
            .execute(
                "INSERT INTO members (organization_id, public_key, display_name, role, added_at, status)
                 VALUES (?1, ?2, 'Budi', 'member', ?3, 'removed')",
                params![org_id, stranger, T0],
            )
            .unwrap();
        let p = person_ref(&f.conn, &f.me, &stranger).unwrap();
        assert_eq!(p.display_name, "Budi", "removed members keep their name");
    }

    #[test]
    fn summaries_are_sorted_by_name_and_show_last_save() {
        let mut f = Fixture::new();
        let (b, b1) = f.add("b-anggaran.xlsx", "b");
        f.add("A-surat.docx", "a");
        f.add("c.pdf", "c");
        let pk = f.pk();
        insert_edit_session(&f.conn, &f.session(&b, &[&b1.id], &b1.blob)).unwrap();
        record_saved_version(&mut f.conn, &b.id, &put(&f.blobs, "b2"), &pk, T2).unwrap();

        let list = summaries(&f.conn, &f.blobs, &f.me, &RoleAccess, None, T3).unwrap();
        let names: Vec<&str> = list.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["A-surat.docx", "b-anggaran.xlsx", "c.pdf"]);
        let b_sum = &list[1];
        assert_eq!(b_sum.current.number, 2);
        assert_eq!(b_sum.current.origin, VersionOrigin::Edited);
        assert_eq!(b_sum.editing.len(), 1);
        assert_eq!(b_sum.editing[0].last_saved_at.as_deref(), Some(T2));
        assert!(b_sum.editing[0].editor.is_me);
    }
}
