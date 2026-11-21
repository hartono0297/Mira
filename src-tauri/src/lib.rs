//! Mira desktop core.
//!
//! Modules are split by concern so later stages can add `network/`, `sync/`
//! and `permissions/` next to these without reshaping them.

pub mod clock;
pub mod commands;
pub mod db;
pub mod error;
pub mod identity;
pub mod org;
pub mod paths;
pub mod settings;
pub mod state;

use tauri::{App, Manager, WebviewWindowBuilder};

use crate::identity::KeyringStore;
use crate::paths::DataDir;
use crate::state::MiraState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = paths::resolve_data_dir(app.handle());
            let state = MiraState::new(
                data_dir
                    .as_ref()
                    .map(|d| d.path.clone())
                    .map_err(Clone::clone),
                Box::new(KeyringStore::new()),
            );
            // Initialize eagerly. A failure is not fatal: the window still
            // opens and `get_app_state` returns the error (and retries).
            if let Err(err) = state.with_core(|_| Ok(())) {
                eprintln!("Mira: inisialisasi gagal [{}]: {err}", err.code());
            }
            app.manage(state);
            create_main_window(app, data_dir.ok().as_ref())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_state,
            commands::save_display_name,
            commands::create_organization,
            commands::get_setting,
            commands::set_setting,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Builds the main window from `tauri.conf.json` (which has `create: false`).
/// With `MIRA_DATA_DIR` set, WebView2 data goes to `<data_dir>/webview` and the
/// title names the folder, so several instances on one laptop stay apart.
fn create_main_window(app: &App, data_dir: Option<&DataDir>) -> tauri::Result<()> {
    let config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or_else(|| tauri::Error::WindowNotFound)?;
    let mut builder = WebviewWindowBuilder::from_config(app.handle(), &config)?;
    if let Some(dir) = data_dir.filter(|d| d.from_env) {
        builder = builder
            .data_directory(dir.path.join("webview"))
            .title(format!("{} ({})", config.title, dir.folder_name()));
    }
    builder.build()?;
    Ok(())
}
