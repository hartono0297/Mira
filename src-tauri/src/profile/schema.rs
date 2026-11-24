//! SQLite tables for profile photos (docs/plans/foto-profil.md, section 2.4).
//! Appended as one entry at the end of `db::migrations::MIGRATIONS`.
//!
//! `profile_records` keeps every accepted record, also the ones a newer
//! record of the same owner replaced, so `unknown_ids` never asks for them
//! again. Only the winning record per owner (and `remove` records of active
//! superadmins) is offered to colleagues.
//!
//! `profile_fetch` is local to this laptop: photos to download, with the
//! retry state. `bad = 1` marks bytes that failed `is_valid_photo`; that hash
//! is never tried again.

pub const PROFILE_SCHEMA: &str = r#"
CREATE TABLE profile_records (
    id          TEXT PRIMARY KEY CHECK (length(id) = 64),
    owner       TEXT NOT NULL CHECK (length(owner) = 64),
    author      TEXT NOT NULL CHECK (length(author) = 64),
    kind        TEXT NOT NULL CHECK (kind IN ('set', 'clear', 'remove')),
    photo       TEXT CHECK (photo IS NULL OR length(photo) = 64),
    size        INTEGER,
    seq         INTEGER NOT NULL CHECK (seq >= 0),
    at          TEXT NOT NULL,
    body        TEXT NOT NULL,
    received_at TEXT NOT NULL
) STRICT;
CREATE INDEX profile_records_owner ON profile_records (owner, kind);

CREATE TABLE profile_fetch (
    hash        TEXT PRIMARY KEY CHECK (length(hash) = 64),
    owner       TEXT NOT NULL,
    size        INTEGER NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    next_try_at TEXT,
    bad         INTEGER NOT NULL DEFAULT 0
) STRICT;
"#;
