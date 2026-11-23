//! Tauri commands of chat (docs/plans/tahap-2.md, section 10). Each command
//! runs the matching `ChatSync` method on the blocking pool; the method
//! itself sends `mira://feature` and tells the hub about local changes.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use super::runtime::ChatRuntime;
use super::sync::ChatSync;
use super::view::{
    ChatOverview, ConversationSummary, ConversationView, FileView, GroupView, MessageView,
    NewChannelScope, NotifyMode, ReceiptView,
};
use crate::error::{AppError, AppResult};

/// Default and largest page of messages.
const DEFAULT_LIMIT: u32 = 100;
const MAX_LIMIT: u32 = 500;

async fn run<T: Send + 'static>(
    rt: &ChatRuntime,
    f: impl FnOnce(&ChatSync) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    let chat = rt.chat()?;
    tauri::async_runtime::spawn_blocking(move || f(&chat))
        .await
        .map_err(|e| AppError::Internal(format!("Perintah chat berhenti di tengah jalan: {e}")))?
}

/// Marks a file that came from a colleague the way browsers do (Mark of the
/// Web, zone 3), so Office opens it in Protected View and SmartScreen checks
/// it. Best effort: FAT drives have no alternate data streams.
fn mark_from_network(path: &std::path::Path) {
    if !cfg!(windows) {
        return;
    }
    let mut stream = path.as_os_str().to_owned();
    stream.push(":Zone.Identifier");
    let _ = std::fs::write(PathBuf::from(stream), "[ZoneTransfer]\r\nZoneId=3\r\n");
}

#[tauri::command]
pub async fn chat_overview(rt: State<'_, ChatRuntime>) -> AppResult<ChatOverview> {
    run(&rt, |c| c.overview()).await
}

#[tauri::command]
pub async fn chat_messages(
    rt: State<'_, ChatRuntime>,
    conv: String,
    before: Option<String>,
    limit: Option<u32>,
) -> AppResult<ConversationView> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    run(&rt, move |c| c.conversation(&conv, before, limit)).await
}

#[tauri::command]
pub async fn chat_send(
    rt: State<'_, ChatRuntime>,
    conv: String,
    text: String,
    reply_to: Option<String>,
    mentions: Vec<String>,
    files: Vec<String>,
) -> AppResult<MessageView> {
    let files: Vec<PathBuf> = files.into_iter().map(PathBuf::from).collect();
    if let Some(bad) = files.iter().find(|f| !rt.was_picked(f)) {
        return Err(AppError::Forbidden(format!(
            "File {} tidak dipilih lewat tombol Lampirkan. Pilih ulang filenya.",
            bad.file_name()
                .map(|n| n.to_string_lossy())
                .unwrap_or_default()
        )));
    }
    let view = run(&rt, move |c| {
        c.send(&conv, &text, reply_to, mentions, files)
    })
    .await?;
    rt.wake_fetcher();
    Ok(view)
}

#[tauri::command]
pub async fn chat_delete_message(
    rt: State<'_, ChatRuntime>,
    conv: String,
    message_id: String,
) -> AppResult<()> {
    run(&rt, move |c| c.delete_message(&conv, &message_id)).await
}

#[tauri::command]
pub async fn chat_mark_read(rt: State<'_, ChatRuntime>, conv: String) -> AppResult<()> {
    run(&rt, move |c| c.mark_read(&conv)).await
}

#[tauri::command]
pub async fn chat_create_channel(
    rt: State<'_, ChatRuntime>,
    name: String,
    scope: NewChannelScope,
) -> AppResult<ConversationSummary> {
    run(&rt, move |c| c.create_channel(&name, scope)).await
}

#[tauri::command]
pub async fn chat_set_archived(
    rt: State<'_, ChatRuntime>,
    conv: String,
    archived: bool,
) -> AppResult<()> {
    run(&rt, move |c| c.set_archived(&conv, archived)).await
}

#[tauri::command]
pub async fn chat_delete_channel(rt: State<'_, ChatRuntime>, conv: String) -> AppResult<()> {
    run(&rt, move |c| c.delete_channel(&conv)).await
}

#[tauri::command]
pub async fn chat_open_dm(
    rt: State<'_, ChatRuntime>,
    public_key: String,
) -> AppResult<ConversationSummary> {
    run(&rt, move |c| c.open_dm(&public_key)).await
}

#[tauri::command]
pub async fn chat_message_receipts(
    rt: State<'_, ChatRuntime>,
    message_id: String,
) -> AppResult<Vec<ReceiptView>> {
    run(&rt, move |c| c.message_receipts(&message_id)).await
}

#[tauri::command]
pub async fn chat_file_open(
    app: AppHandle,
    rt: State<'_, ChatRuntime>,
    message_id: String,
    hash: String,
) -> AppResult<()> {
    let path = run(&rt, move |c| c.open_file_path(&message_id, &hash)).await?;
    let stored_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if super::model::is_executable_name(&stored_name) {
        return Err(AppError::Forbidden(
            "File ini bisa menjalankan program, jadi Mira tidak membukanya langsung. Simpan dulu, lalu periksa sebelum membukanya."
                .into(),
        ));
    }
    mark_from_network(&path);
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|err| AppError::OpenFailed(err.to_string()))
}

/// A file picked for attaching.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedFile {
    pub path: String,
    pub name: String,
    pub size: u64,
}

/// Opens Windows' file picker in Rust. Only paths picked here can be
/// attached with `chat_send`.
#[tauri::command]
pub async fn chat_pick_files(
    app: AppHandle,
    rt: State<'_, ChatRuntime>,
) -> AppResult<Vec<PickedFile>> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Lampirkan file")
            .blocking_pick_files()
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;
    let paths: Vec<PathBuf> = picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|f| f.into_path().ok())
        .collect();
    rt.remember_picked(&paths);
    Ok(paths
        .into_iter()
        .map(|p| PickedFile {
            name: p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            size: std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0),
            path: p.to_string_lossy().into_owned(),
        })
        .collect())
}

/// Opens Windows' save dialog in Rust (the webview never chooses the
/// destination) and copies the attachment there. `false` when cancelled.
#[tauri::command]
pub async fn chat_file_save(
    app: AppHandle,
    rt: State<'_, ChatRuntime>,
    hash: String,
) -> AppResult<bool> {
    let h = hash.clone();
    let file = run(&rt, move |c| c.file_view(&h)).await?;
    let dest = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Simpan file")
            .set_file_name(&file.name)
            .blocking_save_file()
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;
    let Some(dest) = dest.and_then(|d| d.into_path().ok()) else {
        return Ok(false);
    };
    run(&rt, move |c| c.save_file(&hash, &dest)).await?;
    Ok(true)
}

/// Queues a large file and tries to download it right away from any
/// colleague who has it; returns the file's state afterwards.
#[tauri::command]
pub async fn chat_file_download(rt: State<'_, ChatRuntime>, hash: String) -> AppResult<FileView> {
    let h = hash.clone();
    run(&rt, move |c| c.request_download(&h)).await?;
    let chat = rt.chat()?;
    let jobs = tauri::async_runtime::spawn_blocking(move || chat.fetch_jobs())
        .await
        .map_err(|e| AppError::Internal(e.to_string()))??;
    if let Some(job) = jobs.into_iter().find(|j| j.hash == hash) {
        // The outcome is reflected in the file state returned below.
        let _ = rt.fetch_one(job).await;
    }
    run(&rt, move |c| c.file_view(&hash)).await
}

#[tauri::command]
pub async fn chat_set_notify(rt: State<'_, ChatRuntime>, mode: NotifyMode) -> AppResult<()> {
    run(&rt, move |c| c.set_notify(mode)).await
}

#[tauri::command]
pub async fn chat_set_muted(
    rt: State<'_, ChatRuntime>,
    conv: String,
    muted: bool,
) -> AppResult<()> {
    run(&rt, move |c| c.set_muted(&conv, muted)).await
}

#[tauri::command]
pub async fn chat_set_locked(
    rt: State<'_, ChatRuntime>,
    conv: String,
    locked: bool,
) -> AppResult<()> {
    run(&rt, move |c| c.set_locked(&conv, locked)).await
}

#[tauri::command]
pub async fn chat_create_group(
    rt: State<'_, ChatRuntime>,
    name: String,
    members: Vec<String>,
) -> AppResult<ConversationSummary> {
    run(&rt, move |c| c.create_group(&name, members)).await
}

#[tauri::command]
pub async fn chat_group(rt: State<'_, ChatRuntime>, conv: String) -> AppResult<GroupView> {
    run(&rt, move |c| c.group(&conv)).await
}

#[tauri::command]
pub async fn chat_group_add(
    rt: State<'_, ChatRuntime>,
    conv: String,
    members: Vec<String>,
) -> AppResult<()> {
    run(&rt, move |c| c.group_add(&conv, members)).await
}

#[tauri::command]
pub async fn chat_group_remove(
    rt: State<'_, ChatRuntime>,
    conv: String,
    member: String,
) -> AppResult<()> {
    run(&rt, move |c| c.group_remove(&conv, &member)).await
}

#[tauri::command]
pub async fn chat_group_leave(rt: State<'_, ChatRuntime>, conv: String) -> AppResult<()> {
    run(&rt, move |c| c.group_leave(&conv)).await
}

#[tauri::command]
pub async fn chat_group_rename(
    rt: State<'_, ChatRuntime>,
    conv: String,
    name: String,
) -> AppResult<()> {
    run(&rt, move |c| c.group_rename(&conv, &name)).await
}
