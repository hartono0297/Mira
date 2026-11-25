//! Tauri commands of chat (docs/plans/tahap-2.md, section 10). Each command
//! runs the matching `ChatSync` method on the blocking pool; the method
//! itself sends `mira://feature` and tells the hub about local changes.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use super::runtime::ChatRuntime;
use super::sync::ChatSync;
use super::view::{
    ChatOverview, ConversationSummary, ConversationView, FileView, GroupView, MessageView,
    MyStickerView, NewChannelScope, NotifyMode, OfficeStickerState, OfficeStickerView,
    PickedSticker, ProjectChatView, ReceiptView, StickerCatalog, StickerSource,
};
use crate::error::{AppError, AppResult};
use crate::state::MiraState;
use crate::ui_lang::{self, UiLang};

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
        let lang = UiLang::current(&app.state::<MiraState>());
        app.dialog()
            .file()
            .set_title(ui_lang::attach_dialog_title(lang))
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
        let lang = UiLang::current(&app.state::<MiraState>());
        app.dialog()
            .file()
            .set_title(ui_lang::save_dialog_title(lang))
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

/// Sidebar sections folded on this laptop (v0.4).
#[tauri::command]
pub async fn chat_set_folded(rt: State<'_, ChatRuntime>, sections: Vec<String>) -> AppResult<()> {
    run(&rt, move |c| c.set_folded(&sections)).await
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

/// Members of a project chat (v0.4); they are changed on the board.
#[tauri::command]
pub async fn chat_project(rt: State<'_, ChatRuntime>, conv: String) -> AppResult<ProjectChatView> {
    run(&rt, move |c| c.project_chat(&conv)).await
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

// ---- v0.6.0: reactions, emoji, stickers (docs/plans/chat-sticker.md 6) ----

/// Turns my reaction on a message on or off.
#[tauri::command]
pub async fn chat_react(
    rt: State<'_, ChatRuntime>,
    conv: String,
    message_id: String,
    emoji: String,
    on: bool,
) -> AppResult<()> {
    run(&rt, move |c| c.react(&conv, &message_id, &emoji, on)).await
}

/// Remembers an emoji for the "recently used" list of this laptop.
#[tauri::command]
pub async fn chat_emoji_used(rt: State<'_, ChatRuntime>, emoji: String) -> AppResult<()> {
    run(&rt, move |c| c.emoji_used(&emoji)).await
}

#[tauri::command]
pub async fn chat_stickers(rt: State<'_, ChatRuntime>) -> AppResult<StickerCatalog> {
    run(&rt, |c| c.stickers()).await
}

/// A checked sticker image as a `data:` URL (CSP allows `data:` images).
#[tauri::command]
pub async fn chat_sticker_image(rt: State<'_, ChatRuntime>, hash: String) -> AppResult<String> {
    run(&rt, move |c| c.sticker_image(&hash)).await
}

/// Opens Mira's own dialog for one PNG, WebP or GIF and checks it. `None`
/// when cancelled. Only a path from this dialog is accepted by
/// `chat_my_sticker_add` and `chat_office_sticker_add`.
#[tauri::command]
pub async fn chat_sticker_pick(
    app: AppHandle,
    rt: State<'_, ChatRuntime>,
) -> AppResult<Option<PickedSticker>> {
    // Debug builds only: end-to-end tests cannot drive the Windows dialog,
    // so `MIRA_E2E_PICK` names the file the dialog "returns" every time (the
    // test rewrites that file between uploads). Release builds ignore it.
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("MIRA_E2E_PICK").filter(|p| !p.is_empty()) {
        let path = PathBuf::from(path);
        rt.remember_picked(std::slice::from_ref(&path));
        return run(&rt, move |c| c.inspect_picked(&path)).await.map(Some);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let lang = UiLang::current(&app.state::<MiraState>());
        app.dialog()
            .file()
            .set_title(lang.pick("Pilih gambar sticker", "Choose a sticker image"))
            .add_filter(
                lang.pick("Gambar PNG, WebP, GIF", "PNG, WebP, GIF images"),
                &["png", "webp", "gif"],
            )
            .blocking_pick_file()
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;
    let Some(path) = picked.and_then(|f| f.into_path().ok()) else {
        return Ok(None);
    };
    rt.remember_picked(std::slice::from_ref(&path));
    run(&rt, move |c| c.inspect_picked(&path)).await.map(Some)
}

fn picked_path(rt: &ChatRuntime, path: String) -> AppResult<PathBuf> {
    let path = PathBuf::from(path);
    if !rt.was_picked(&path) {
        return Err(AppError::Forbidden(
            "Gambar sticker tidak dipilih lewat tombol Unggah. Pilih ulang gambarnya.".into(),
        ));
    }
    Ok(path)
}

#[tauri::command]
pub async fn chat_my_sticker_add(
    rt: State<'_, ChatRuntime>,
    path: String,
    name: String,
    keywords: Vec<String>,
) -> AppResult<MyStickerView> {
    let path = picked_path(&rt, path)?;
    run(&rt, move |c| c.my_sticker_add(&path, &name, &keywords)).await
}

/// Saves the sticker of a message to my own collection.
#[tauri::command]
pub async fn chat_my_sticker_save(
    rt: State<'_, ChatRuntime>,
    message_id: String,
) -> AppResult<MyStickerView> {
    run(&rt, move |c| c.my_sticker_save(&message_id)).await
}

#[tauri::command]
pub async fn chat_my_sticker_remove(rt: State<'_, ChatRuntime>, id: String) -> AppResult<()> {
    run(&rt, move |c| c.my_sticker_remove(&id)).await
}

/// Superadmin: adds an office sticker.
#[tauri::command]
pub async fn chat_office_sticker_add(
    rt: State<'_, ChatRuntime>,
    path: String,
    pack: String,
    name: String,
    keywords: Vec<String>,
) -> AppResult<OfficeStickerView> {
    let path = picked_path(&rt, path)?;
    let view = run(&rt, move |c| c.office_sticker_add(&path, &pack, &name, &keywords)).await?;
    rt.wake_fetcher();
    Ok(view)
}

/// Superadmin: renames, regroups, hides, shows or deletes an office sticker.
#[tauri::command]
pub async fn chat_office_sticker_update(
    rt: State<'_, ChatRuntime>,
    id: String,
    pack: String,
    name: String,
    keywords: Vec<String>,
    state: OfficeStickerState,
) -> AppResult<()> {
    run(&rt, move |c| c.office_sticker_update(&id, &pack, &name, &keywords, state)).await
}

/// Sends an office sticker or one of mine as its own message.
#[tauri::command]
pub async fn chat_send_sticker(
    rt: State<'_, ChatRuntime>,
    conv: String,
    source: StickerSource,
    reply_to: Option<String>,
) -> AppResult<MessageView> {
    let view = run(&rt, move |c| c.send_sticker(&conv, source, reply_to)).await?;
    rt.wake_fetcher();
    Ok(view)
}
