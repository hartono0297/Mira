//! SQLite tables for profile photos (docs/plans/foto-profil.md, section 2.4).
//! Appended as one entry at the end of `db::migrations::MIGRATIONS`.
//!
//! `profile_records` holds only live records: the winning `set`/`clear` per
//! owner (at most one, enforced by `profile_records_current`, so this table
//! doubles as the per-owner summary of the effective state) and the `remove`
//! records. A record that lost to a newer one of the same owner is deleted
//! and only its id stays in `profile_seen`, so `unknown_ids` never asks for
//! it again but its body costs nothing and it is never offered.
//!
//! `profile_fetch` is local to this laptop: photos to download, with the
//! retry state. `bad = 1` marks a hash whose bytes failed `is_valid_photo`,
//! or that is being checked right now (set before decoding, so a decoder
//! crash is not repeated after a restart); that hash is never tried again
//! and the row is kept for good.

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
CREATE UNIQUE INDEX profile_records_current ON profile_records (owner) WHERE kind <> 'remove';
CREATE INDEX profile_records_photo ON profile_records (photo, kind);

CREATE TABLE profile_seen (
    id TEXT PRIMARY KEY CHECK (length(id) = 64)
) STRICT, WITHOUT ROWID;

CREATE TABLE profile_fetch (
    hash        TEXT PRIMARY KEY CHECK (length(hash) = 64),
    owner       TEXT NOT NULL,
    size        INTEGER NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    next_try_at TEXT,
    bad         INTEGER NOT NULL DEFAULT 0
) STRICT;
"#;
