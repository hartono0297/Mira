//! 0.5.1: "Reset dan mulai dari awal" for a laptop removed for good
//! (docs/plans/perbaikan-bergabung.md, decision 7).
//!
//! Skeleton: filled in by the reset task.

use tauri::{AppHandle, State};

use crate::commands::AppState;
use crate::error::{AppError, AppResult};
use crate::net_backend::AppNet;
use crate::state::MiraState;

/// Deletes this laptop's organization data and key, makes a new key, and
/// returns the new app state (onboarding). Only when this laptop was
/// removed for good.
#[tauri::command]
pub async fn reset_removed_laptop(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
) -> AppResult<AppState> {
    let _ = (&state, &net, &app);
    Err(AppError::Internal("Belum tersedia.".into()))
}
