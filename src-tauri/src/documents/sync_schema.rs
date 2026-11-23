//! Migration for syncing documents and signing with rekan (one entry at the
//! end of `db::migrations::MIGRATIONS`; v6 on this branch, the final number
//! is decided when the parallel branches are merged).
//!
//! - `docs_sync_records`: every signed document record this laptop holds
//!   (own and received), the body exactly as sent so it can be forwarded.
//!   `state = 'pending'` while a version waits for its document record.
//!   Only the latest `edit` mark per (document, author) is kept.
//! - `sign_sync_records`: signed signing records (request, signed version,
//!   cancel). `state`: `ok` (part of the request state), `pending` (waits for
//!   the request record or a file), `rejected` (valid signature but refused,
//!   for example a version that changes more than the stamp; `reason` says
//!   why and the screen shows it).
//! - `sign_proof_checks`: cache of the "new version = old version + stamp"
//!   check per pair of file hashes, so large PDFs are parsed once.
//! - `sign_notified`: Windows notification "giliran Anda" already shown for
//!   this request at this version.
//! - `sign_requests.team_id` / `project_id`: scope of a request, so guests
//!   only take part in projects they may open.

pub const SYNC_SCHEMA: &str = r#"
CREATE TABLE docs_sync_records (
    id          TEXT PRIMARY KEY CHECK (length(id) = 64),
    kind        TEXT NOT NULL CHECK (kind IN ('doc', 'ver', 'edit')),
    document_id TEXT NOT NULL CHECK (length(document_id) = 32),
    author      TEXT NOT NULL CHECK (length(author) = 64),
    body        TEXT NOT NULL,
    state       TEXT NOT NULL DEFAULT 'applied' CHECK (state IN ('applied', 'pending')),
    created_at  TEXT NOT NULL,
    received_at TEXT
) STRICT;
CREATE INDEX docs_sync_records_doc ON docs_sync_records (document_id, kind, author);

CREATE TABLE sign_sync_records (
    id          TEXT PRIMARY KEY CHECK (length(id) = 64),
    kind        TEXT NOT NULL CHECK (kind IN ('request', 'signed', 'cancelled')),
    request_id  TEXT NOT NULL CHECK (length(request_id) = 32),
    author      TEXT NOT NULL CHECK (length(author) = 64),
    body        TEXT NOT NULL,
    state       TEXT NOT NULL DEFAULT 'ok' CHECK (state IN ('ok', 'pending', 'rejected')),
    reason      TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    received_at TEXT
) STRICT;
CREATE INDEX sign_sync_records_request ON sign_sync_records (request_id, kind);

CREATE TABLE sign_proof_checks (
    hash_before TEXT NOT NULL CHECK (length(hash_before) = 64),
    hash_after  TEXT NOT NULL CHECK (length(hash_after) = 64),
    ok          INTEGER NOT NULL CHECK (ok IN (0, 1)),
    reason      TEXT NOT NULL DEFAULT '',
    checked_at  TEXT NOT NULL,
    PRIMARY KEY (hash_before, hash_after)
) STRICT;

CREATE TABLE sign_notified (
    request_id  TEXT NOT NULL CHECK (length(request_id) = 32),
    hash        TEXT NOT NULL CHECK (length(hash) = 64),
    notified_at TEXT NOT NULL,
    PRIMARY KEY (request_id, hash)
) STRICT;

ALTER TABLE sign_requests ADD COLUMN team_id TEXT;
ALTER TABLE sign_requests ADD COLUMN project_id TEXT;
"#;
