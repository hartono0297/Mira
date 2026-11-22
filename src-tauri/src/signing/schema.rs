//! SQL migrasi tanda tangan PDF. Didaftarkan sebagai satu entri di akhir
//! `db::migrations::MIGRATIONS`; nomor versinya ditentukan saat merge.
//!
//! Kunci publik, hash, dan tanda tangan disimpan sebagai hex huruf kecil.
//! Waktu dalam RFC 3339 UTC.
//!
//! `sign_pin_resets` mencatat kapan tanda tangan terakhir dihapus tanpa PIN
//! (jalur lupa PIN), per pemilik. Tanda tangan yang dibuat dalam 24 jam
//! sesudahnya mendapat `sign_saved_signature.usable_after` (lihat `vault`).

pub const SIGNING_SCHEMA: &str = r#"
CREATE TABLE sign_saved_signature (
    owner           TEXT PRIMARY KEY CHECK (length(owner) = 64),
    kdf             TEXT NOT NULL,
    salt            BLOB NOT NULL CHECK (length(salt) = 16),
    nonce           BLOB NOT NULL CHECK (length(nonce) = 24),
    ciphertext      BLOB NOT NULL,
    width           INTEGER NOT NULL CHECK (width > 0),
    height          INTEGER NOT NULL CHECK (height > 0),
    created_at      TEXT NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
    locked_until    TEXT,
    usable_after    TEXT
) STRICT;

CREATE TABLE sign_pin_resets (
    owner    TEXT PRIMARY KEY CHECK (length(owner) = 64),
    reset_at TEXT NOT NULL
) STRICT;

CREATE TABLE sign_requests (
    id            TEXT PRIMARY KEY CHECK (length(id) = 32),
    title         TEXT NOT NULL,
    requested_by  TEXT NOT NULL CHECK (length(requested_by) = 64),
    mode          TEXT NOT NULL CHECK (mode IN ('sequential', 'parallel')),
    status        TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'cancelled')),
    original_hash TEXT NOT NULL CHECK (length(original_hash) = 64),
    current_hash  TEXT NOT NULL CHECK (length(current_hash) = 64),
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    completed_at  TEXT
) STRICT;

CREATE TABLE sign_signers (
    request_id   TEXT NOT NULL REFERENCES sign_requests (id) ON DELETE CASCADE,
    position     INTEGER NOT NULL CHECK (position >= 0),
    public_key   TEXT NOT NULL CHECK (length(public_key) = 64),
    display_name TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('member', 'guest')),
    status       TEXT NOT NULL CHECK (status IN ('waiting', 'signed')),
    signed_at    TEXT,
    hash_after   TEXT CHECK (hash_after IS NULL OR length(hash_after) = 64),
    PRIMARY KEY (request_id, position),
    UNIQUE (request_id, public_key)
) STRICT;

CREATE TABLE sign_events (
    id          INTEGER PRIMARY KEY,
    request_id  TEXT,
    kind        TEXT NOT NULL,
    actor       TEXT NOT NULL CHECK (length(actor) = 64),
    actor_name  TEXT NOT NULL,
    at          TEXT NOT NULL,
    hash_before TEXT,
    hash_after  TEXT,
    detail      TEXT NOT NULL DEFAULT '',
    sig         TEXT NOT NULL CHECK (length(sig) = 128)
) STRICT;
CREATE INDEX sign_events_request ON sign_events (request_id, id);

CREATE TABLE sign_exports (
    request_id  TEXT NOT NULL REFERENCES sign_requests (id) ON DELETE CASCADE,
    path        TEXT NOT NULL,
    hash        TEXT NOT NULL CHECK (length(hash) = 64),
    exported_at TEXT NOT NULL,
    PRIMARY KEY (request_id, path)
) STRICT;
"#;
