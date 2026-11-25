//! Tauri commands of profile photos (docs/plans/foto-profil.md, section 2.6).
//! Each command runs the matching `ProfileSync` method on the blocking pool;
//! the method itself sends `mira://feature` and tells the hub about local
//! changes. File paths never come from the webview: the picked file is read
//! here and only a token goes back.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use super::image::{self, Crop};
use super::runtime::ProfileRuntime;
use super::sync::ProfileSync;
use super::{MAX_SOURCE_BYTES, PHOTO_BROKEN, PHOTO_TOO_BIG};
use crate::error::{AppError, AppResult};
use crate::state::MiraState;
use crate::ui_lang::{self, UiLang};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoEntry {
    pub owner: String,
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MyPhoto {
    pub hash: Option<String>,
    pub removed_by_admin: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedPhoto {
    /// 32 hex, valid for ten minutes, used once.
    pub token: String,
    /// Base64 JPEG preview.
    pub preview: String,
    /// Source size after orientation (the pixels `Crop` is in).
    pub width: u32,
    pub height: u32,
    pub preview_width: u32,
    pub preview_height: u32,
}

/// Debug builds only: with this set to a file path, `profile_pick_photo`
/// uses that file instead of opening Windows' dialog (which e2e tests cannot
/// drive).
#[cfg(debug_assertions)]
pub const E2E_PICK_ENV: &str = "MIRA_E2E_PICK_PHOTO";

#[cfg(debug_assertions)]
fn e2e_pick() -> Option<PathBuf> {
    std::env::var_os(E2E_PICK_ENV)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

#[cfg(not(debug_assertions))]
fn e2e_pick() -> Option<PathBuf> {
    None
}

async fn run<T: Send + 'static>(
    rt: &ProfileRuntime,
    f: impl FnOnce(&ProfileSync) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    let profile = rt.profile()?;
    tauri::async_runtime::spawn_blocking(move || f(&profile))
        .await
        .map_err(|e| {
            AppError::Internal(format!(
                "Perintah foto profil berhenti di tengah jalan: {e}"
            ))
        })?
}

fn base64(bytes: &[u8]) -> String {
    data_encoding::BASE64.encode(bytes)
}

/// Reads a picked file, refusing more than `MAX_SOURCE_BYTES`.
pub fn read_source(path: &Path) -> AppResult<Vec<u8>> {
    let file =
        std::fs::File::open(path).map_err(|_| AppError::InvalidInput(PHOTO_BROKEN.into()))?;
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if len > MAX_SOURCE_BYTES {
        return Err(AppError::InvalidInput(PHOTO_TOO_BIG.into()));
    }
    let mut bytes = Vec::new();
    file.take(MAX_SOURCE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| AppError::InvalidInput(PHOTO_BROKEN.into()))?;
    if bytes.len() as u64 > MAX_SOURCE_BYTES {
        return Err(AppError::InvalidInput(PHOTO_TOO_BIG.into()));
    }
    Ok(bytes)
}

/// Decodes `bytes` and builds the crop dialog's data (token added by the caller).
fn prepare(bytes: &[u8]) -> AppResult<(String, u32, u32, u32, u32)> {
    let src = image::load_source(bytes)?;
    let preview = image::preview_jpeg(&src)?;
    let (pw, ph) = ::image::ImageReader::new(std::io::Cursor::new(&preview))
        .with_guessed_format()
        .ok()
        .and_then(|r| r.into_dimensions().ok())
        .ok_or_else(|| AppError::InvalidInput(PHOTO_BROKEN.into()))?;
    Ok((base64(&preview), src.width(), src.height(), pw, ph))
}

#[tauri::command]
pub async fn profile_photos(rt: State<'_, ProfileRuntime>) -> AppResult<Vec<PhotoEntry>> {
    run(&rt, |p| p.photos()).await
}

#[tauri::command]
pub async fn profile_photo_data(rt: State<'_, ProfileRuntime>, hash: String) -> AppResult<String> {
    let bytes = run(&rt, move |p| p.photo_data(&hash)).await?;
    Ok(base64(&bytes))
}

#[tauri::command]
pub async fn profile_my_photo(rt: State<'_, ProfileRuntime>) -> AppResult<MyPhoto> {
    run(&rt, |p| p.my_photo()).await
}

/// Opens the file dialog in Rust (PNG, JPEG, WebP), reads and decodes the
/// file, and keeps its bytes under a token for `profile_set_photo`. `None`
/// when cancelled.
#[tauri::command]
pub async fn profile_pick_photo(
    app: AppHandle,
    rt: State<'_, ProfileRuntime>,
) -> AppResult<Option<PickedPhoto>> {
    run(&rt, |p| p.ensure_can_set()).await?;
    let path = match e2e_pick() {
        Some(p) => Some(p),
        None => tauri::async_runtime::spawn_blocking(move || {
            let lang = UiLang::current(&app.state::<MiraState>());
            app.dialog()
                .file()
                .set_title(ui_lang::photo_dialog_title(lang))
                .add_filter("PNG, JPEG, WebP", &["png", "jpg", "jpeg", "webp"])
                .blocking_pick_file()
        })
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .and_then(|f| f.into_path().ok()),
    };
    let Some(path) = path else {
        return Ok(None);
    };
    let (bytes, (preview, width, height, preview_width, preview_height)) =
        tauri::async_runtime::spawn_blocking(move || {
            let bytes = read_source(&path)?;
            let prepared = prepare(&bytes)?;
            Ok::<_, AppError>((bytes, prepared))
        })
        .await
        .map_err(|e| AppError::Internal(e.to_string()))??;
    let token = rt.picks.put(bytes, Instant::now());
    Ok(Some(PickedPhoto {
        token,
        preview,
        width,
        height,
        preview_width,
        preview_height,
    }))
}

/// Crops the picked file, makes the 256x256 JPEG and sets it as this
/// person's photo. The token is used up only when this succeeds.
#[tauri::command]
pub async fn profile_set_photo(
    rt: State<'_, ProfileRuntime>,
    token: String,
    crop: Crop,
) -> AppResult<PhotoEntry> {
    let bytes = rt.picks.get(&token, Instant::now())?;
    let entry = run(&rt, move |p| {
        let src = image::load_source(&bytes)?;
        let jpeg = image::crop_to_photo(&src, crop)?;
        p.set_photo(&jpeg)
    })
    .await?;
    rt.picks.consume(&token);
    Ok(entry)
}

#[tauri::command]
pub async fn profile_clear_photo(rt: State<'_, ProfileRuntime>) -> AppResult<()> {
    run(&rt, |p| p.clear_photo()).await
}

/// Superadmins only, for someone else's photo.
#[tauri::command]
pub async fn profile_admin_remove_photo(
    rt: State<'_, ProfileRuntime>,
    owner: String,
) -> AppResult<()> {
    run(&rt, move |p| p.admin_remove(&owner)).await
}
