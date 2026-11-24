//! Mira desktop core.
//!
//! Modules are split by concern so later stages can add `network/`, `sync/`
//! and `permissions/` next to these without reshaping them.

pub mod ad;
pub mod blobs;
pub mod board;
pub mod chat;
pub mod clock;
pub mod commands;
pub mod db;
pub mod device;
pub mod documents;
pub mod error;
pub mod firewall;
pub mod identity;
pub mod join_commands;
pub mod join_sync;
pub mod net_backend;
pub mod network;
pub mod network_commands;
pub mod org;
pub mod org_commands;
pub mod org_screen;
pub mod paths;
pub mod peers;
pub mod permissions;
pub mod qr;
pub mod runnable;
pub mod settings;
pub mod signing;
pub mod state;
pub mod team_commands;
pub mod ui_lang;
pub mod updater;
pub mod window_theme;

use tauri::{App, Manager, RunEvent, WebviewWindowBuilder};

use crate::net_backend::AppNet;

use crate::identity::KeyringStore;
use crate::state::MiraState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            app.manage(updater::UpdaterState::default());
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
            // Tahap 0 organizations: publish the founder's name as a signed op.
            if let Err(err) = state.with_core(|core| {
                permissions::ensure_profile_op(&mut core.db, &core.identity, clock::now())
                    .map(|_| ())
            }) {
                eprintln!(
                    "Mira: profil belum bisa diterbitkan [{}]: {err}",
                    err.code()
                );
            }
            // v0.3: fold the log with the new rules once (the derived tables
            // may still hold the v0.2 fold), publish this laptop's name, OS
            // and version, and register projects made before v0.3.
            if let Err(err) = state.with_core(|core| {
                permissions::recompute(&mut core.db)?;
                permissions::ensure_device_op(
                    &mut core.db,
                    &core.identity,
                    &device::current(),
                    clock::now(),
                )?;
                board::membership::register_legacy_projects(
                    &mut core.db,
                    &core.identity,
                    clock::now(),
                )
                .map(|_| ())
            }) {
                eprintln!(
                    "Mira: data organisasi v0.3 belum siap [{}]: {err}",
                    err.code()
                );
            }
            // Window background from the saved theme mode, so a dark start
            // does not flash white before the page loads.
            let background = state
                .with_core(|core| Ok(window_theme::initial_background(Some(&core.db))))
                .unwrap_or_else(|_| window_theme::initial_background(None));
            // Feature sync contract (network/feature.rs): chat, board, documents
            // and signing register here; the network sets the real link.
            let features = std::sync::Arc::new(network::feature::FeatureHub::default());
            app.manage(features.clone());
            let net = AppNet::new(features);
            app.manage(net.clone());
            // Start the network in the background; commands start it too if
            // this fails now (for example before the key problem is fixed).
            {
                let state = state.clone();
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(err) = net.get(&state, &handle).await {
                        eprintln!("Mira: jaringan belum berjalan [{}]: {err}", err.code());
                    }
                });
            }
            // Deadline reminders (F-TASK-06). The trigger doubles as the board's
            // local-change hook so a new due date is checked right away.
            let reminders = board::reminder::spawn(
                state.clone(),
                std::sync::Arc::new(board::reminder::TauriNotifier::new(app.handle().clone())),
            );
            app.manage(board::commands::BoardRuntime {
                hook: std::sync::Arc::new(board::feature::BoardSyncNotifier::new(
                    std::sync::Arc::new(reminders),
                    app.handle().clone(),
                )),
            });
            app.manage(state);
            board::feature::register(app.handle());
            // Document library: managed even when the data folder is missing
            // (its commands then return the error). Edit sessions left from
            // the last run are recovered in the background.
            let documents = documents::runtime::DocumentsRuntime::new(
                app.handle(),
                app.state::<MiraState>().inner().clone(),
            );
            app.manage(documents.clone());
            documents.spawn_recovery();
            app.manage(signing::session::SignSessions::default());
            signing::peer_sync::register(app.handle());
            // v0.3 join requests: topic `join`, approver notifications, and
            // the requester's in-memory state.
            join_sync::register(app.handle());
            app.manage(join_commands::JoinClient::default());
            // Chat (Tahap 2): registers with the FeatureHub and starts the
            // attachment downloader.
            let chat = chat::runtime::ChatRuntime::install(app.handle());
            app.manage(chat);
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
            team_commands::get_directory,
            team_commands::create_team,
            team_commands::delete_team,
            team_commands::add_team_member,
            team_commands::remove_team_member,
            team_commands::set_team_admin,
            team_commands::add_superadmin,
            team_commands::remove_superadmin,
            team_commands::remove_member,
            team_commands::create_invite,
            team_commands::revoke_invite,
            team_commands::redeem_invite,
            team_commands::join_with_code,
            team_commands::get_rejected_changes,
            org_commands::org_overview,
            org_commands::org_departments,
            org_commands::org_people,
            org_commands::org_users,
            org_commands::org_labels,
            org_commands::org_project_members,
            org_commands::org_join_requests,
            org_commands::org_create_department,
            org_commands::org_rename_department,
            org_commands::org_set_department_archived,
            org_commands::org_set_department_admin,
            org_commands::org_move_member,
            org_commands::org_approve_join,
            org_commands::org_reject_join,
            org_commands::org_add_project_member,
            org_commands::org_remove_project_member,
            org_commands::org_create_label,
            org_commands::org_rename_label,
            org_commands::org_set_label_archived,
            org_commands::org_set_label_assigned,
            org_screen::org_fingerprint,
            join_commands::join_device,
            join_commands::join_search,
            join_commands::join_connect_address,
            join_commands::join_send_request,
            join_commands::join_outgoing,
            join_commands::join_poll,
            join_commands::join_cancel,
            join_commands::join_resend,
            join_commands::join_setup_mode,
            network_commands::get_network_status,
            network_commands::add_manual_address,
            network_commands::remove_manual_address,
            network_commands::get_firewall_status,
            network_commands::request_firewall_rule,
            board::commands::board_list_projects,
            board::commands::board_create_project,
            board::commands::board_get_board,
            board::commands::board_create_task,
            board::commands::board_get_task,
            board::commands::board_update_task,
            board::commands::board_move_task,
            board::commands::board_delete_task,
            board::commands::board_add_comment,
            board::commands::board_add_subtask,
            board::commands::board_update_subtask,
            board::commands::board_move_subtask,
            board::commands::board_delete_subtask,
            board::commands::board_start_timer,
            board::commands::board_stop_timer,
            board::commands::board_log_time,
            board::commands::board_delete_time_entry,
            board::commands::board_my_tasks,
            board::commands::board_update_project,
            board::outside::board_outside_projects,
            documents::commands::list_documents,
            documents::commands::get_document,
            documents::commands::add_documents,
            documents::commands::start_edit,
            documents::commands::finish_edit,
            documents::commands::open_read_only,
            documents::commands::restore_version,
            documents::commands::resolve_conflict,
            documents::commands::export_version,
            documents::commands::download_version,
            signing::commands::sign_overview,
            signing::commands::sign_save_signature,
            signing::commands::sign_delete_signature,
            signing::commands::sign_unlock,
            signing::commands::sign_list_candidates,
            signing::commands::sign_import_pdf,
            signing::commands::sign_create_request,
            signing::commands::sign_get_request,
            signing::commands::sign_read_file,
            signing::commands::sign_complete,
            signing::commands::sign_cancel,
            signing::commands::sign_export,
            signing::commands::sign_verify_file,
            signing::commands::sign_download_file,
            chat::commands::chat_overview,
            chat::commands::chat_messages,
            chat::commands::chat_send,
            chat::commands::chat_delete_message,
            chat::commands::chat_mark_read,
            chat::commands::chat_create_channel,
            chat::commands::chat_set_archived,
            chat::commands::chat_delete_channel,
            chat::commands::chat_open_dm,
            chat::commands::chat_message_receipts,
            chat::commands::chat_pick_files,
            chat::commands::chat_file_open,
            chat::commands::chat_file_save,
            chat::commands::chat_file_download,
            chat::commands::chat_set_notify,
            chat::commands::chat_set_muted,
            chat::commands::chat_set_locked,
            chat::commands::chat_create_group,
            chat::commands::chat_group,
            chat::commands::chat_group_add,
            chat::commands::chat_group_remove,
            chat::commands::chat_group_leave,
            chat::commands::chat_group_rename,
            chat::commands::chat_project,
            chat::commands::chat_set_folded,
            updater::update_info,
            updater::update_check,
            updater::update_download,
            updater::update_install,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // Say goodbye on mDNS and close connections cleanly.
            if let RunEvent::Exit = event {
                let net = app.state::<AppNet>().inner().clone();
                tauri::async_runtime::block_on(net.shutdown());
            }
        });
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
    // Akses papan klip untuk menu teks (Tempel) tanpa prompt izin WebView2
    // yang berbahasa Inggris. Halaman hanya frontend Mira sendiri (CSP 'self').
    let mut builder = WebviewWindowBuilder::from_config(app.handle(), &config)?
        .background_color(background)
        .enable_clipboard_access();
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
