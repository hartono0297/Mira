//! Mira desktop core.
//!
//! Modules are split by concern so later stages can add `network/`, `sync/`
//! and `permissions/` next to these without reshaping them.

pub mod clock;
pub mod commands;
pub mod db;
pub mod error;
pub mod firewall;
pub mod identity;
pub mod network;
pub mod org;
pub mod paths;
pub mod peers;
pub mod permissions;
pub mod qr;
pub mod settings;
pub mod signing;
pub mod state;
pub mod window_theme;

use tauri::{App, Manager, WebviewWindowBuilder};

use crate::identity::KeyringStore;
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
            // Window background from the saved theme mode, so a dark start
            // does not flash white before the page loads.
            let background = state
                .with_core(|core| Ok(window_theme::initial_background(Some(&core.db))))
                .unwrap_or_else(|_| window_theme::initial_background(None));
            app.manage(state);
            // Keep instances apart even when the env folder could not be prepared.
            let instance_dir = match &data_dir {
                Ok(d) => d.from_env.then(|| d.path.clone()),
                Err(_) => std::env::var_os(paths::DATA_DIR_ENV)
                    .filter(|v| !v.is_empty())
                    .map(std::path::PathBuf::from)
                    .and_then(|p| std::path::absolute(p).ok()),
            };
            create_main_window(app, instance_dir.as_deref(), background)?;
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
fn create_main_window(
    app: &App,
    instance_dir: Option<&std::path::Path>,
    background: tauri::window::Color,
) -> tauri::Result<()> {
    let config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or_else(|| tauri::Error::WindowNotFound)?;
    let mut builder =
        WebviewWindowBuilder::from_config(app.handle(), &config)?.background_color(background);
    if let Some(dir) = instance_dir {
        let folder = dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| dir.display().to_string());
        builder = builder
            .data_directory(dir.join("webview"))
            .title(format!("{} ({folder})", config.title));
    }
    builder.build()?;
    Ok(())
}
