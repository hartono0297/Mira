//! Tauri commands of the document library (plan, bagian 4). Arguments arrive
//! camelCase from JS; results are `DocumentSummary`, `DocumentDetail` or
//! `null`; errors serialize as `{ code, message }`.
//!
//! Each command runs its `DocsEnv` method on a blocking thread, because
//! adding, saving and exporting read whole files.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::State;

use crate::documents::runtime::DocumentsRuntime;
use crate::documents::session::DocsEnv;
use crate::documents::store::{DocumentDetail, DocumentSummary};
use crate::error::{AppError, AppResult};

/// Runs `f` with the environment off the async runtime's worker threads.
pub async fn run<T: Send + 'static>(
    runtime: &DocumentsRuntime,
    f: impl FnOnce(&DocsEnv) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    let env: Arc<DocsEnv> = runtime.env()?;
    tauri::async_runtime::spawn_blocking(move || f(&env))
        .await
        .map_err(|err| AppError::Internal(format!("Perintah dokumen berhenti mendadak: {err}")))?
}

#[tauri::command]
pub async fn list_documents(
    runtime: State<'_, DocumentsRuntime>,
    project_id: Option<String>,
) -> AppResult<Vec<DocumentSummary>> {
    run(&runtime, move |env| env.list(project_id.as_deref())).await
}

#[tauri::command]
pub async fn get_document(
    runtime: State<'_, DocumentsRuntime>,
    document_id: String,
) -> AppResult<DocumentDetail> {
    run(&runtime, move |env| env.detail(&document_id)).await
}

#[tauri::command]
pub async fn add_documents(
    runtime: State<'_, DocumentsRuntime>,
    paths: Vec<String>,
    project_id: Option<String>,
) -> AppResult<Vec<DocumentSummary>> {
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    run(&runtime, move |env| {
        env.add_documents(&paths, project_id.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn start_edit(
    runtime: State<'_, DocumentsRuntime>,
    document_id: String,
    from_version_id: Option<String>,
) -> AppResult<DocumentSummary> {
    run(&runtime, move |env| {
        env.start_edit(&document_id, from_version_id.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn finish_edit(
    runtime: State<'_, DocumentsRuntime>,
    document_id: String,
) -> AppResult<DocumentSummary> {
    run(&runtime, move |env| env.finish_edit(&document_id)).await
}

#[tauri::command]
pub async fn open_read_only(
    runtime: State<'_, DocumentsRuntime>,
    document_id: String,
    version_id: Option<String>,
) -> AppResult<()> {
    run(&runtime, move |env| {
        env.open_read_only(&document_id, version_id.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn restore_version(
    runtime: State<'_, DocumentsRuntime>,
    document_id: String,
    version_id: String,
) -> AppResult<DocumentSummary> {
    run(&runtime, move |env| {
        env.restore_version(&document_id, &version_id)
    })
    .await
}

#[tauri::command]
pub async fn resolve_conflict(
    runtime: State<'_, DocumentsRuntime>,
    document_id: String,
    keep_version_id: String,
) -> AppResult<DocumentSummary> {
    run(&runtime, move |env| {
        env.resolve_conflict(&document_id, &keep_version_id)
    })
    .await
}

/// "Unduh": copies a version's file from a connected rekan (any size; files
/// up to 20 MB usually arrive by themselves). Error `not_available` when no
/// connected rekan has it. Returns the summary, with `downloading` set when
/// an automatic download of the same file is still running.
#[tauri::command]
pub async fn download_version(
    runtime: State<'_, DocumentsRuntime>,
    document_id: String,
    version_id: String,
) -> AppResult<DocumentSummary> {
    let peer = runtime.peer_sync()?;
    peer.download_version(document_id.clone(), version_id)
        .await?;
    run(&runtime, move |env| env.summary(&document_id)).await
}

#[tauri::command]
pub async fn export_version(
    runtime: State<'_, DocumentsRuntime>,
    document_id: String,
    version_id: Option<String>,
    destination: String,
) -> AppResult<()> {
    run(&runtime, move |env| {
        env.export_version(
            &document_id,
            version_id.as_deref(),
            &PathBuf::from(destination),
        )
    })
    .await
}
