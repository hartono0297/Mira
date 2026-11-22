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

pub mod access;
pub mod kinds;
pub mod office;
pub mod schema;
pub mod store;
pub mod sync;
pub mod view;
pub mod watch;
