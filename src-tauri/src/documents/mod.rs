//! Document library per project (Tahap 4, local part): files stored as blobs,
//! versions with parents (a version graph), restore, conflicts ("bentrok"),
//! editing in Microsoft Office with automatic new versions after each save.
//!
//! Plan and contracts: `docs/plans/tahap-4-lokal.md`.
//!
//! - `schema`  SQL for the documents migration.
//! - `kinds`   file kind from the extension (Word, Excel, PDF, other).
//! - `store`   documents, versions, heads, restore, resolve, edit-session rows.
//! - `view`    what the frontend sees (summary, detail), re-exported by `store`.
//! - `access`  who may do what (role check; team/project scoping hook).
//! - `sync`    connection points for the network stage (outbound trait and
//!   inbound `apply_remote_*` functions).
//! - `office`  Office file-name patterns and the save debounce (pure).
//! - `watch`   folder watcher for working copies (notify).
//! - `session` the edit flow: working copies, versions from saves, finishing,
//!   read-only copies, recovery at start (no Tauri types).
//! - `runtime` Tauri managed state: launcher, event emitter, watcher.
//! - `commands` Tauri commands for the Dokumen screen.
//! - `peer_sync` sync with rekan (FeatureSync, BlobSource, DocumentSync).
//! - `envelope` signed record bodies sent to rekan (documents and signing).
//! - `scope`   who may see a team or project scope (any key), on the board's
//!   project and guest rules (`board::access`).
//! - `sync_schema` migration for document and signing sync.
//! - `test_lab` (tests only) three laptops in one organization.

pub mod access;
pub mod commands;
pub mod envelope;
pub mod kinds;
pub mod office;
pub mod peer_sync;
pub mod runtime;
pub mod schema;
pub mod scope;
pub mod session;
pub mod store;
pub mod sync;
pub mod sync_schema;
#[cfg(test)]
pub mod test_lab;
pub mod view;
pub mod watch;
