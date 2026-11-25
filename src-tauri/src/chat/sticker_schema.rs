//! Migration v13 (v0.5.1): office stickers, my own stickers, and checked
//! sticker images (docs/plans/chat-sticker.md 3).
//!
//! `chat_office_stickers` is derived from `sticker_set` records: per sticker
//! the winning record (greatest `(at, record_id)`) gives every column except
//! `created_at` and `created_record`, which come from the sticker's earliest
//! record and decide who owns a `:nama:` when two active stickers share it
//! (smallest `(created_at, created_record)` wins).
//!
//! `chat_my_stickers` and `chat_sticker_checks` are local to this laptop.
//! `chat_sticker_checks` caches `sticker_file::inspect` per blob hash so a
//! received image is checked once: `ok` 0 means it failed and is never
//! shown as a sticker.

pub const STICKER_SCHEMA: &str = r#"
CREATE TABLE chat_office_stickers (
    id             TEXT PRIMARY KEY CHECK (length(id) = 32),
    pack           TEXT NOT NULL,
    name           TEXT NOT NULL,
    keywords       TEXT NOT NULL DEFAULT '[]',
    hash           TEXT NOT NULL CHECK (length(hash) = 64),
    size           INTEGER NOT NULL,
    mime           TEXT NOT NULL,
    file_name      TEXT NOT NULL,
    state          TEXT NOT NULL CHECK (state IN ('active', 'hidden', 'deleted')),
    created_at     TEXT NOT NULL,
    created_record TEXT NOT NULL CHECK (length(created_record) = 64),
    at             TEXT NOT NULL,
    record_id      TEXT NOT NULL CHECK (length(record_id) = 64)
) STRICT;
CREATE INDEX chat_office_stickers_name ON chat_office_stickers (name);
CREATE INDEX chat_office_stickers_hash ON chat_office_stickers (hash);

CREATE TABLE chat_my_stickers (
    id            TEXT PRIMARY KEY CHECK (length(id) = 32),
    name          TEXT NOT NULL,
    keywords      TEXT NOT NULL DEFAULT '[]',
    hash          TEXT NOT NULL UNIQUE CHECK (length(hash) = 64),
    size          INTEGER NOT NULL,
    mime          TEXT NOT NULL,
    added_at      TEXT NOT NULL
) STRICT;

CREATE TABLE chat_sticker_checks (
    hash          TEXT PRIMARY KEY CHECK (length(hash) = 64),
    ok            INTEGER NOT NULL CHECK (ok IN (0, 1)),
    mime          TEXT,
    width         INTEGER,
    height        INTEGER,
    frames        INTEGER,
    checked_at    TEXT NOT NULL
) STRICT;
"#;
