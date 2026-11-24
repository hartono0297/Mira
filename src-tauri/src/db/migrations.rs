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
    // Sinkron dokumen dan tanda tangan, v8.
    crate::documents::sync_schema::SYNC_SCHEMA,
    // v0.3: departemen, anggota proyek, label, profil laptop, permintaan bergabung, v9.
    V9_ORG_V03,
    // v0.6: divisi dan pengaturan chat, v10.
    V10_DIVISIONS,
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

/// v0.3 (docs/plans/v0.3-kontrak.md): tables derived from the new ops
/// (archived departments, device profile columns, registered projects and
/// their members, labels, join decisions), plus the local join request
/// stores: `join_requests` on member laptops (requests received or
/// forwarded, waiting for an approver) and `join_outbox` on the laptop that
/// asks to join (its own request, kept across restarts).
///
/// Nothing is migrated row by row: the derived tables are rewritten by the
/// next fold, which applies the v0.3 rules to the existing log (one
/// department per person, the earliest wins; projects stay closed until
/// they are registered with `project_create`).
const V9_ORG_V03: &str = r#"
ALTER TABLE teams ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE teams ADD COLUMN archived_at TEXT;

ALTER TABLE members ADD COLUMN laptop TEXT;
ALTER TABLE members ADD COLUMN os TEXT;
ALTER TABLE members ADD COLUMN app_version TEXT;
ALTER TABLE members ADD COLUMN device_at TEXT;

CREATE TABLE projects (
    id            TEXT PRIMARY KEY CHECK (length(id) = 32),
    team_id       TEXT,
    creator       TEXT NOT NULL CHECK (length(creator) = 64),
    registered_by TEXT NOT NULL CHECK (length(registered_by) = 64),
    created_at    TEXT NOT NULL
) STRICT;

CREATE TABLE project_members (
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    public_key TEXT NOT NULL CHECK (length(public_key) = 64),
    added_at   TEXT NOT NULL,
    added_by   TEXT NOT NULL,
    PRIMARY KEY (project_id, public_key)
) STRICT;

CREATE TABLE labels (
    id         TEXT PRIMARY KEY CHECK (length(id) = 32),
    name       TEXT NOT NULL,
    archived   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
) STRICT;

CREATE TABLE label_members (
    label_id   TEXT NOT NULL REFERENCES labels (id) ON DELETE CASCADE,
    public_key TEXT NOT NULL CHECK (length(public_key) = 64),
    PRIMARY KEY (label_id, public_key)
) STRICT;

CREATE TABLE join_decisions (
    request_id TEXT PRIMARY KEY CHECK (length(request_id) = 64),
    member     TEXT NOT NULL,
    name       TEXT NOT NULL,
    team_id    TEXT NOT NULL,
    approved   INTEGER NOT NULL,
    decided_by TEXT NOT NULL,
    decided_at TEXT NOT NULL
) STRICT;

CREATE TABLE join_requests (
    id            TEXT PRIMARY KEY CHECK (length(id) = 64),
    member        TEXT NOT NULL CHECK (length(member) = 64),
    team_id       TEXT NOT NULL,
    requested_at  TEXT NOT NULL,
    payload       TEXT NOT NULL,
    sig           TEXT NOT NULL CHECK (length(sig) = 128),
    record_id     TEXT NOT NULL UNIQUE CHECK (length(record_id) = 64),
    record        TEXT NOT NULL,
    code          TEXT NOT NULL,
    seen_ip       TEXT,
    ip_group      TEXT,
    seen_by       TEXT,
    received_at   TEXT NOT NULL,
    received_from TEXT
) STRICT;
CREATE INDEX join_requests_member ON join_requests (member);

CREATE TABLE join_request_aliases (
    record_id  TEXT PRIMARY KEY CHECK (length(record_id) = 64),
    request_id TEXT NOT NULL
) STRICT;

CREATE TABLE join_outbox (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    request_id      TEXT NOT NULL CHECK (length(request_id) = 64),
    org_id          TEXT NOT NULL CHECK (length(org_id) = 32),
    org_name        TEXT NOT NULL,
    org_record      TEXT NOT NULL,
    code            TEXT NOT NULL,
    team_id         TEXT NOT NULL,
    team_name       TEXT NOT NULL,
    payload         TEXT NOT NULL,
    sig             TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('pending', 'rejected')),
    decided_by_name TEXT,
    decided_at      TEXT,
    last_sent_at    TEXT,
    last_error      TEXT
) STRICT;
"#;

/// v0.6 (docs/plans/dept-divisi.md, 4): divisions, their members and the
/// chat settings, all derived from the membership log, plus the division a
/// project was made for. Rewritten by the next fold like the v9 tables.
const V10_DIVISIONS: &str = r#"
CREATE TABLE divisions (
    id         TEXT PRIMARY KEY CHECK (length(id) = 32),
    team_id    TEXT NOT NULL,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    archived   INTEGER NOT NULL DEFAULT 0,
    deleted    INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX divisions_team ON divisions (team_id);

CREATE TABLE division_members (
    division_id TEXT NOT NULL,
    public_key  TEXT NOT NULL CHECK (length(public_key) = 64),
    head        INTEGER NOT NULL DEFAULT 0,
    added_at    TEXT NOT NULL,
    added_by    TEXT NOT NULL,
    PRIMARY KEY (division_id, public_key)
) STRICT;
CREATE INDEX division_members_key ON division_members (public_key);

CREATE TABLE chat_settings (
    team_id     TEXT NOT NULL,
    division_id TEXT NOT NULL DEFAULT '',
    pinned      TEXT NOT NULL DEFAULT '',
    announce    INTEGER NOT NULL DEFAULT 0,
    set_at      TEXT NOT NULL,
    set_by      TEXT NOT NULL,
    PRIMARY KEY (team_id, division_id)
) STRICT;

ALTER TABLE projects ADD COLUMN division_id TEXT;
"#;
