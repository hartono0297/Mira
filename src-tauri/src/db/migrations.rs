//! Numbered schema migrations. Never edit a migration that has shipped; append
//! a new one instead. Index 0 is schema version 1.

pub const MIGRATIONS: &[&str] = &[
    V1_FOUNDATION,
    V2_MEMBERSHIP_LOG,
    // Tahap 3 (board), v3.
    crate::board::schema::BOARD_SCHEMA,
    // Tahap 4 (dokumen), v4.
    crate::documents::schema::MIGRATION,
    // Tahap 5 (tanda tangan PDF), v5.
    crate::signing::schema::SIGNING_SCHEMA,
    // Sinkron board (record id, pending, rejected, doc_code), v6.
    crate::board::schema::BOARD_SYNC_SCHEMA,
    // Tahap 2 (chat), v7.
    crate::chat::schema::CHAT_SCHEMA,
];

/// Tahap 0: this laptop's identity, its organization, members and local settings.
///
/// Keys and signatures are stored as lowercase hex text. Timestamps are RFC 3339.
const V1_FOUNDATION: &str = r#"
CREATE TABLE identity (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    public_key   TEXT NOT NULL UNIQUE CHECK (length(public_key) = 64),
    display_name TEXT,
    created_at   TEXT NOT NULL
) STRICT;

CREATE TABLE organizations (
    id                 TEXT PRIMARY KEY CHECK (length(id) = 32),
    name               TEXT NOT NULL,
    founder_public_key TEXT NOT NULL CHECK (length(founder_public_key) = 64),
    created_at         TEXT NOT NULL,
    genesis_signature  TEXT NOT NULL CHECK (length(genesis_signature) = 128)
) STRICT;

CREATE TABLE members (
    organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    public_key      TEXT NOT NULL CHECK (length(public_key) = 64),
    display_name    TEXT NOT NULL,
    role            TEXT NOT NULL
                    CHECK (role IN ('superadmin', 'team_admin', 'member', 'guest')),
    added_at        TEXT NOT NULL,
    PRIMARY KEY (organization_id, public_key)
) STRICT;

CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;
"#;

/// Tahap 1: signed membership log (`org_ops`), the tables derived from it by
/// the fold (members columns, teams, team_members, invites, guest_access,
/// channels), peer addresses, and the log of rejected changes.
///
/// The final `UPDATE` keeps Tahap 0 founders marked as superadmin until the
/// first fold rewrites the derived tables.
const V2_MEMBERSHIP_LOG: &str = r#"
CREATE TABLE org_ops (
    id            TEXT PRIMARY KEY CHECK (length(id) = 64),
    org_id        TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    author        TEXT NOT NULL CHECK (length(author) = 64),
    lamport       INTEGER NOT NULL CHECK (lamport > 0),
    kind          TEXT NOT NULL,
    scope_team    TEXT,
    payload       TEXT NOT NULL,
    sig           TEXT NOT NULL CHECK (length(sig) = 128),
    received_at   TEXT NOT NULL,
    received_from TEXT,
    status        TEXT NOT NULL CHECK (status IN ('applied', 'rejected')),
    reject_reason TEXT
) STRICT;
CREATE INDEX org_ops_order ON org_ops (lamport, author, id);

ALTER TABLE members ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed'));
ALTER TABLE members ADD COLUMN is_superadmin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE members ADD COLUMN kind TEXT NOT NULL DEFAULT 'member' CHECK (kind IN ('member', 'guest'));
ALTER TABLE members ADD COLUMN removed_at TEXT;

CREATE TABLE teams (
    id         TEXT PRIMARY KEY CHECK (length(id) = 32),
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE team_members (
    team_id    TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    public_key TEXT NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    added_at   TEXT NOT NULL,
    PRIMARY KEY (team_id, public_key)
) STRICT;

CREATE TABLE invites (
    id          TEXT PRIMARY KEY CHECK (length(id) = 32),
    team_id     TEXT NOT NULL,
    role        TEXT NOT NULL,
    projects    TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    single_use  INTEGER NOT NULL,
    tag         TEXT NOT NULL,
    invite_key  TEXT NOT NULL,
    created_by  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    revoked     INTEGER NOT NULL DEFAULT 0,
    used_by     TEXT NOT NULL DEFAULT '[]'
) STRICT;
CREATE INDEX invites_tag ON invites (tag);

CREATE TABLE guest_access (
    public_key TEXT NOT NULL,
    team_id    TEXT NOT NULL,
    project_id TEXT NOT NULL,
    PRIMARY KEY (public_key, team_id, project_id)
) STRICT;

CREATE TABLE channels (
    id         TEXT PRIMARY KEY CHECK (length(id) = 32),
    team_id    TEXT,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;

CREATE TABLE peer_addresses (
    public_key      TEXT NOT NULL,
    address         TEXT NOT NULL,
    source          TEXT NOT NULL,
    last_success_at TEXT,
    last_seen_at    TEXT NOT NULL,
    PRIMARY KEY (public_key, address)
) STRICT;

CREATE TABLE manual_addresses (
    address       TEXT PRIMARY KEY,
    added_at      TEXT NOT NULL,
    last_tried_at TEXT,
    last_error    TEXT,
    public_key    TEXT
) STRICT;

CREATE TABLE peer_seen (
    public_key   TEXT PRIMARY KEY,
    last_seen_at TEXT NOT NULL
) STRICT;

CREATE TABLE rejected_changes (
    id     INTEGER PRIMARY KEY,
    at     TEXT NOT NULL,
    peer   TEXT,
    address TEXT,
    code   TEXT NOT NULL,
    detail TEXT NOT NULL
) STRICT;

UPDATE members SET is_superadmin = 1 WHERE role = 'superadmin';
"#;
