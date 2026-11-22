//! SQLite tables for the board (docs/plans/tahap-3-lokal.md, "Skema SQLite").
//!
//! Appended as one entry at the end of `db::migrations::MIGRATIONS`. The final
//! schema number is decided when the stage branches are merged.

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
