//! Documents migration. Appended to `db::migrations::MIGRATIONS`; the final
//! schema number is decided when the stage branches are merged (Tahap 1 = v2).
//!
//! Model (docs/plans/tahap-4-lokal.md, bagian 2):
//! - `documents`: one row per file in the library. `team_id` and `project_id`
//!   stay NULL until projects exist (NULL = the organization's general library).
//! - `document_versions`: immutable; `seq` is the local display number
//!   ("Versi 3"), `blob_hash` points into the blob store. `received_at` is set
//!   for versions that came from a rekan.
//! - `document_version_parents`: the version graph. A version with no child is
//!   a head; more than one head means "bentrok". Restoring or resolving makes a
//!   new version whose parents are all current heads.
//! - `document_edit_sessions`: this laptop's open edit in Office (one per
//!   document): working copy path, the parents the next save is based on, and
//!   the hash of the last content seen.
//! - `document_remote_editing`: "Sedang diedit" marks received from rekan.

pub const MIGRATION: &str = r#"
CREATE TABLE documents (
    id         TEXT PRIMARY KEY CHECK (length(id) = 32),
    team_id    TEXT,
    project_id TEXT,
    name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
    kind       TEXT NOT NULL CHECK (kind IN ('word', 'excel', 'pdf', 'other')),
    created_by TEXT NOT NULL CHECK (length(created_by) = 64),
    created_at TEXT NOT NULL
) STRICT;
CREATE INDEX documents_project ON documents (project_id, name);

CREATE TABLE document_versions (
    id            TEXT PRIMARY KEY CHECK (length(id) = 32),
    document_id   TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    seq           INTEGER NOT NULL CHECK (seq > 0),
    blob_hash     TEXT NOT NULL CHECK (length(blob_hash) = 64),
    size          INTEGER NOT NULL CHECK (size >= 0),
    author        TEXT NOT NULL CHECK (length(author) = 64),
    created_at    TEXT NOT NULL,
    origin        TEXT NOT NULL CHECK (origin IN ('added', 'edited', 'restored', 'resolved')),
    restored_from TEXT,
    received_at   TEXT,
    UNIQUE (document_id, seq)
) STRICT;

CREATE TABLE document_version_parents (
    version_id TEXT NOT NULL REFERENCES document_versions (id) ON DELETE CASCADE,
    parent_id  TEXT NOT NULL CHECK (length(parent_id) = 32),
    PRIMARY KEY (version_id, parent_id)
) STRICT;
CREATE INDEX document_version_parents_parent ON document_version_parents (parent_id);

CREATE TABLE document_edit_sessions (
    document_id   TEXT PRIMARY KEY REFERENCES documents (id) ON DELETE CASCADE,
    editor        TEXT NOT NULL CHECK (length(editor) = 64),
    parent_ids    TEXT NOT NULL,
    working_path  TEXT NOT NULL,
    started_at    TEXT NOT NULL,
    last_hash     TEXT NOT NULL CHECK (length(last_hash) = 64),
    last_saved_at TEXT,
    lock_seen     INTEGER NOT NULL DEFAULT 0 CHECK (lock_seen IN (0, 1))
) STRICT;

CREATE TABLE document_remote_editing (
    document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    editor      TEXT NOT NULL CHECK (length(editor) = 64),
    since       TEXT NOT NULL,
    seen_at     TEXT NOT NULL,
    PRIMARY KEY (document_id, editor)
) STRICT;
"#;

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use crate::db;
    use crate::documents::store::{self, DocScope};
    use crate::identity::{self, MemoryKeyStore};
    use crate::org;

    const DOCUMENT_TABLES: [&str; 5] = [
        "documents",
        "document_versions",
        "document_version_parents",
        "document_edit_sessions",
        "document_remote_editing",
    ];

    fn table_exists(conn: &Connection, name: &str) -> bool {
        conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [name],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
            == 1
    }

    /// A database from before the documents migration (Tahap 1 = v2) with an
    /// identity, an organization and a setting upgrades to the latest schema,
    /// keeps its data and gets the documents tables.
    ///
    /// `db::migrations` is private, so the old database is made by opening a
    /// new one, filling it, then dropping the documents tables and setting
    /// `user_version` back to the version before this migration. After the
    /// stage merge the documents migration is v4, followed by Tahap 5's
    /// signing migration (v5) and Tahap 2's chat migration (v6), so their
    /// tables are dropped too.
    /// Tables of the migrations that come after documents (Tahap 5, v5),
    /// children before parents.
    const SIGNING_TABLES_AFTER_DOCUMENTS: [&str; 6] = [
        "sign_exports",
        "sign_events",
        "sign_signers",
        "sign_requests",
        "sign_pin_resets",
        "sign_saved_signature",
    ];

    /// Tables of the chat migration (Tahap 2, v6), children before parents.
    const CHAT_TABLES_AFTER_DOCUMENTS: [&str; 9] = [
        "chat_files",
        "chat_messages",
        "chat_records",
        "chat_channels",
        "chat_receipts",
        "chat_envelopes",
        "chat_fetch_queue",
        "chat_conv_settings",
        "chat_blobs",
    ];

    #[test]
    fn database_before_documents_upgrades_and_keeps_data() {
        let tmp = tempfile::tempdir().unwrap();
        // v1 foundation, v2 membership log, v3 board, v4 documents, v5 signing,
        // v6 chat.
        let before = 3;
        assert_eq!(db::latest_version(), 6, "update this test when a migration is added");
        let (pk, org_id) = {
            let mut conn = db::open(tmp.path()).unwrap();
            let mut me = identity::ensure_identity(&conn, &MemoryKeyStore::new()).unwrap();
            identity::save_display_name(&mut conn, &mut me, "Sari").unwrap();
            let info = org::create_organization(&mut conn, &me, "CV Maju Jaya").unwrap();
            conn.execute(
                "INSERT INTO settings (key, value, updated_at) VALUES ('theme.mode', 'dark', 't')",
                [],
            )
            .unwrap();
            for t in CHAT_TABLES_AFTER_DOCUMENTS {
                conn.execute_batch(&format!("DROP TABLE {t};")).unwrap();
            }
            for t in SIGNING_TABLES_AFTER_DOCUMENTS {
                conn.execute_batch(&format!("DROP TABLE {t};")).unwrap();
            }
            for t in DOCUMENT_TABLES.iter().rev() {
                conn.execute_batch(&format!("DROP TABLE {t};")).unwrap();
            }
            conn.pragma_update(None, "user_version", before).unwrap();
            (me.public_key_hex().to_owned(), info.id)
        };

        let mut conn = db::open(tmp.path()).unwrap();
        assert_eq!(db::schema_version(&conn).unwrap(), db::latest_version());
        for t in DOCUMENT_TABLES {
            assert!(table_exists(&conn, t), "missing table {t}");
        }
        let (name, role): (String, String) = conn
            .query_row(
                "SELECT o.name, m.role FROM organizations o JOIN members m ON m.organization_id = o.id
                 WHERE o.id = ?1 AND m.public_key = ?2",
                [&org_id, &pk],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            (name.as_str(), role.as_str()),
            ("CV Maju Jaya", "superadmin")
        );
        let theme: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'theme.mode'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(theme, "dark");
        let ops: i64 = conn
            .query_row("SELECT count(*) FROM org_ops", [], |r| r.get(0))
            .unwrap();
        assert!(ops >= 1, "membership log kept");

        // The new tables work, including their constraints.
        let blobs = crate::blobs::BlobStore::in_data_dir(tmp.path()).unwrap();
        let blob = blobs.put_bytes(b"isi").unwrap();
        let (doc, v1) = store::create_document(
            &mut conn,
            &DocScope::default(),
            "Laporan.docx",
            &blob,
            &pk,
            "2026-11-22T08:00:00Z",
        )
        .unwrap();
        assert_eq!(v1.seq, 1);
        let bad = conn.execute(
            "INSERT INTO document_versions (id, document_id, seq, blob_hash, size, author, created_at, origin)
             VALUES (?1, ?2, 2, ?3, 1, ?4, 't', 'copied')",
            [&"ab".repeat(16), &doc.id, &"cd".repeat(32), &pk],
        );
        assert!(bad.is_err(), "origin is checked");
    }
}
