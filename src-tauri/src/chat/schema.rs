//! SQLite tables for chat (docs/plans/tahap-2.md, section 11). Appended as one
//! entry at the end of `db::migrations::MIGRATIONS`.
//!
//! `chat_records` is the source of truth: every record ever accepted, keyed by
//! its id. A purged record keeps its row with `body` NULL so it counts as
//! known and is never accepted or offered again. The other synced tables are
//! derived from the records as they are applied. `chat_fetch_queue` and
//! `chat_conv_settings` are local to this laptop, as are the flags
//! `deposited`, `opened`, `acked` and `file_keys` of `chat_envelopes`.
//!
//! `chat_messages.placeholder` marks a row made from a `message_delete` that
//! arrived before its message. `chat_envelopes.acked` is 0 while the envelope
//! is live, 1 once its recipient acked it, 2 when it expired unopened.
//!
//! `chat_blobs` lists the blobs chat put into the blob store (sent, fetched,
//! decrypted) and whether the blob was already there. Chat deletes only those
//! it created itself. `chat_blobs.convs` (JSON `[{"conv":..,"own":..}]`) says
//! for which conversations this laptop holds a plain blob: `own` when it
//! attached the file to its own message there, otherwise fetched or
//! decrypted for a message there. A plain blob is served only to members of
//! those conversations, and a preexisting one only through an `own` entry.
//! `chat_fetch_queue.convs` (JSON list) keeps the conversations a queued
//! plain download is for until it lands. `chat_envelopes.ack_failed` is 1 when the recipient acked
//! an envelope it could not open.

pub const CHAT_SCHEMA: &str = r#"
CREATE TABLE chat_records (
    id            TEXT PRIMARY KEY CHECK (length(id) = 64),
    kind          TEXT NOT NULL,
    conv          TEXT,
    author        TEXT NOT NULL CHECK (length(author) = 64),
    at            TEXT NOT NULL,
    target        TEXT,
    body          TEXT,
    received_at   TEXT NOT NULL,
    received_from TEXT
) STRICT;
CREATE INDEX chat_records_conv ON chat_records (conv, kind);
CREATE INDEX chat_records_target ON chat_records (target) WHERE target IS NOT NULL;

CREATE TABLE chat_channels (
    conv          TEXT PRIMARY KEY,
    name          TEXT,
    scope_kind    TEXT CHECK (scope_kind IS NULL OR scope_kind IN ('org', 'team', 'project')),
    scope_id      TEXT,
    created_by    TEXT,
    created_at    TEXT,
    archived      INTEGER NOT NULL DEFAULT 0,
    archive_at    TEXT,
    archive_id    TEXT,
    deleted       INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE chat_messages (
    id            TEXT PRIMARY KEY CHECK (length(id) = 64),
    conv          TEXT NOT NULL,
    author        TEXT NOT NULL,
    at            TEXT NOT NULL,
    text          TEXT NOT NULL DEFAULT '',
    reply_to      TEXT,
    mentions      TEXT NOT NULL DEFAULT '[]',
    deleted       INTEGER NOT NULL DEFAULT 0,
    placeholder   INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX chat_messages_conv ON chat_messages (conv, at);

CREATE TABLE chat_files (
    message_id    TEXT NOT NULL REFERENCES chat_messages (id) ON DELETE CASCADE,
    idx           INTEGER NOT NULL,
    hash          TEXT NOT NULL CHECK (length(hash) = 64),
    size          INTEGER NOT NULL,
    name          TEXT NOT NULL,
    mime          TEXT NOT NULL,
    PRIMARY KEY (message_id, idx)
) STRICT;
CREATE INDEX chat_files_hash ON chat_files (hash);

CREATE TABLE chat_receipts (
    message_id    TEXT NOT NULL,
    reader        TEXT NOT NULL,
    state         TEXT NOT NULL CHECK (state IN ('delivered', 'read')),
    conv          TEXT NOT NULL,
    at            TEXT NOT NULL,
    PRIMARY KEY (message_id, reader, state)
) STRICT;
CREATE INDEX chat_receipts_conv ON chat_receipts (conv, reader, state);

CREATE TABLE chat_envelopes (
    id            TEXT PRIMARY KEY CHECK (length(id) = 64),
    author        TEXT NOT NULL,
    recipient     TEXT NOT NULL,
    at            TEXT NOT NULL,
    cipher_files  TEXT NOT NULL DEFAULT '[]',
    message_id    TEXT,
    file_keys     TEXT,
    deposited     INTEGER NOT NULL DEFAULT 0,
    opened        INTEGER NOT NULL DEFAULT 0,
    acked         INTEGER NOT NULL DEFAULT 0 CHECK (acked IN (0, 1, 2)),
    ack_failed    INTEGER NOT NULL DEFAULT 0,
    open_error    TEXT
) STRICT;
CREATE INDEX chat_envelopes_recipient ON chat_envelopes (recipient, opened, acked);
CREATE INDEX chat_envelopes_message ON chat_envelopes (message_id) WHERE message_id IS NOT NULL;

CREATE TABLE chat_fetch_queue (
    hash          TEXT NOT NULL CHECK (length(hash) = 64),
    kind          TEXT NOT NULL CHECK (kind IN ('plain', 'cipher')),
    size          INTEGER NOT NULL,
    plain         TEXT,
    prefer        TEXT NOT NULL DEFAULT '[]',
    priority      INTEGER NOT NULL DEFAULT 0,
    queued_at     TEXT NOT NULL,
    attempts      INTEGER NOT NULL DEFAULT 0,
    last_try_at   TEXT,
    next_try_at   TEXT,
    first_error_at TEXT,
    last_error    TEXT,
    convs         TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (hash, kind)
) STRICT;

CREATE TABLE chat_blobs (
    hash          TEXT PRIMARY KEY CHECK (length(hash) = 64),
    kind          TEXT NOT NULL CHECK (kind IN ('plain', 'cipher')),
    preexisting   INTEGER NOT NULL,
    added_at      TEXT NOT NULL,
    convs         TEXT NOT NULL DEFAULT '[]'
) STRICT;

CREATE TABLE chat_conv_settings (
    conv          TEXT PRIMARY KEY,
    muted         INTEGER NOT NULL DEFAULT 0,
    opened_at     TEXT
) STRICT;
"#;

#[cfg(test)]
mod tests {
    use crate::db;

    #[test]
    fn chat_tables_exist_after_migration() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = db::open(tmp.path()).unwrap();
        for t in [
            "chat_records",
            "chat_channels",
            "chat_messages",
            "chat_files",
            "chat_receipts",
            "chat_envelopes",
            "chat_fetch_queue",
            "chat_conv_settings",
            "chat_blobs",
        ] {
            let n: i64 = conn
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [t],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "missing table {t}");
        }
    }

    #[test]
    fn record_ids_are_checked() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = db::open(tmp.path()).unwrap();
        let bad = conn.execute(
            "INSERT INTO chat_records (id, kind, author, at, received_at) VALUES ('x', 'message', ?1, 't', 't')",
            [&"a".repeat(64)],
        );
        assert!(bad.is_err());
    }
}
