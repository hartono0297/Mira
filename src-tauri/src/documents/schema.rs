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
