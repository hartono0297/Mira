//! Task numbers and project codes that collide after sync
//! (docs/plans/sinkron-board.md, "Konflik").
//!
//! Placeholder in the foundation commit: the rules are filled in by the
//! numbering work.

use rusqlite::Connection;

use super::sign::SignedChange;
use crate::error::AppResult;
use crate::identity::Identity;

/// After remote changes were applied to `project_id`: renumbers the
/// duplicate tasks this laptop is responsible for, as signed local changes
/// (already stored). The caller offers the returned changes to peers.
pub fn renumber_duplicates(
    _conn: &mut Connection,
    _identity: &Identity,
    _project_id: &str,
) -> AppResult<Vec<SignedChange>> {
    Ok(Vec::new())
}
