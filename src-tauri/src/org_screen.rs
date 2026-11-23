//! Extra pieces for the Organisasi page (v0.3 part B, docs/plans/v03-b.md):
//!
//! - `org_fingerprint`: the short organization fingerprint (`XXXX-XXXX`) for
//!   the page header, so people can compare it by phone with the screen of a
//!   laptop that asks to join (docs/plans/v0.3-kontrak.md, 8.6).
//!
//! The OS notification for new join requests lives in `join_sync.rs`
//! (`JoinAlerts`), which sees both direct and forwarded requests.
//!
//! TypeScript side: `src/api/orgScreen.ts`.

use tauri::State;

use crate::error::AppResult;
use crate::permissions;
use crate::state::MiraState;

#[tauri::command]
pub async fn org_fingerprint(state: State<'_, MiraState>) -> AppResult<String> {
    state.with_core(|c| {
        let s = permissions::require_state(&c.db)?;
        Ok(permissions::org_fingerprint_short(&s.org))
    })
}
