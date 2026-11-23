//! SQLite tables for the board (docs/plans/tahap-3-lokal.md, "Skema SQLite").
//!
//! Schema v3 in `db::migrations::MIGRATIONS` (after v2 membership, before v4
//! documents).

pub const BOARD_SCHEMA: &str = r#"
CREATE TABLE board_projects (
    id         TEXT PRIMARY KEY CHECK (length(id) = 32),
    code       TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    team_id    TEXT,
    created_by TEXT NOT NULL CHECK (length(created_by) = 64),
    created_at TEXT NOT NULL,
    doc        BLOB NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE board_changes (
    hash          TEXT PRIMARY KEY CHECK (length(hash) = 64),
    project_id    TEXT NOT NULL REFERENCES board_projects (id) ON DELETE CASCADE,
    author        TEXT NOT NULL CHECK (length(author) = 64),
    seq           INTEGER NOT NULL,
    bytes         BLOB NOT NULL,
    sig           TEXT NOT NULL CHECK (length(sig) = 128),
    created_at    TEXT NOT NULL,
    received_at   TEXT NOT NULL,
    received_from TEXT
) STRICT;
CREATE INDEX board_changes_project ON board_changes (project_id, author, seq);

CREATE TABLE board_task_index (
    project_id TEXT NOT NULL REFERENCES board_projects (id) ON DELETE CASCADE,
    task_id    TEXT NOT NULL,
    code       TEXT NOT NULL,
    title      TEXT NOT NULL,
    column_id  TEXT NOT NULL,
    assignee   TEXT,
    due        TEXT,
    deleted    INTEGER NOT NULL,
    PRIMARY KEY (project_id, task_id)
) STRICT;
CREATE INDEX board_task_index_assignee ON board_task_index (assignee, deleted);

CREATE TABLE board_reminders_sent (
    project_id TEXT NOT NULL,
    task_id    TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('day_before', 'due_day')),
    due        TEXT NOT NULL,
    sent_at    TEXT NOT NULL,
    PRIMARY KEY (project_id, task_id, kind, due)
) STRICT;
"#;

/// Board sync with other laptops (docs/plans/sinkron-board.md): schema v6 in
/// `db::migrations::MIGRATIONS` (after v5 signing, before v7 chat).
///
/// - `board_changes.record_id`: BLAKE3 of the change's `FeatureRecord` body,
///   filled for new rows and backfilled on first use for older rows.
/// - `board_projects.doc_code`: the code written in the project document.
///   `code` is the code shown on this laptop, which differs only when two
///   projects want the same code (see `store::refresh_codes`).
/// - `board_projects.bound`: whether the project id is bound to its creator
///   and team (`store::is_syncable`), 1 or 0; NULL until first computed. Id,
///   creator, team and nonce never change, so the value never goes stale.
/// - `board_pending`: received changes not applied yet (missing parent
///   change, unknown project, or author without the right as far as this
///   laptop knows). Retried later; never sent on.
/// - `board_rejected`: ids of records refused for good (bad signature,
///   format, document shape), so they are not downloaded again.
pub const BOARD_SYNC_SCHEMA: &str = r#"
ALTER TABLE board_changes ADD COLUMN record_id TEXT;
CREATE UNIQUE INDEX board_changes_record ON board_changes (record_id);

ALTER TABLE board_projects ADD COLUMN doc_code TEXT NOT NULL DEFAULT '';
UPDATE board_projects SET doc_code = code;
ALTER TABLE board_projects ADD COLUMN bound INTEGER CHECK (bound IN (0, 1));

CREATE TABLE board_pending (
    record_id     TEXT PRIMARY KEY CHECK (length(record_id) = 64),
    project_id    TEXT NOT NULL,
    hash          TEXT NOT NULL,
    author        TEXT NOT NULL,
    body          TEXT NOT NULL,
    reason        TEXT NOT NULL CHECK (reason IN ('deps', 'project', 'rights')),
    received_from TEXT,
    received_at   TEXT NOT NULL
) STRICT;
CREATE INDEX board_pending_project ON board_pending (project_id);

CREATE TABLE board_rejected (
    record_id TEXT PRIMARY KEY CHECK (length(record_id) = 64),
    at        TEXT NOT NULL
) STRICT;
"#;
