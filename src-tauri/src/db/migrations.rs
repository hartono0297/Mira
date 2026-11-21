//! Numbered schema migrations. Never edit a migration that has shipped; append
//! a new one instead. Index 0 is schema version 1.

pub const MIGRATIONS: &[&str] = &[V1_FOUNDATION];

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
