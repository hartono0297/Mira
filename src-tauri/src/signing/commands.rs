//! Perintah Tauri tanda tangan PDF (kontrak: `docs/plans/tahap-5-lokal.md`
//! bagian 5, sisi frontend `src/api/signing.ts`).
//!
//! Tipis: membangun `SignContext` lalu memanggil `service`. Perintah berat
//! (Argon2, hash berkas, baca tulis PDF) berjalan di `spawn_blocking`
//! (`run_blocking`); yang ringan langsung (`run`). Byte PDF lewat IPC
//! mentah Tauri 2: badan permintaan `InvokeBody::Raw`, data lain di header
//! (`x-mira-file-name` berisi `encodeURIComponent(nama)`), dan
//! `sign_read_file` membalas `tauri::ipc::Response` berisi byte.
//!
//! - File PDF: `BlobDocumentStore` (blob store `<data_dir>/blobs`, dengan
//!   cadangan berkas lama `<data_dir>/ttd-berkas`).
//! - Perubahan lokal memberi tahu jaringan lewat `HubOutbox`
//!   (`FeatureHub::notify_changed("sign")`).
//! - Folder ekspor: `MIRA_EXPORT_DIR` kalau diisi, kalau tidak folder Unduhan
//!   Windows, kalau itu pun gagal `<data_dir>/ekspor`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroizing;

use super::err;
use super::outbox::{HubOutbox, LocalOnlyOutbox, SignOutbox};
use super::peer_sync::{self, Downloading, SignSync};
use super::pin::KdfParams;
use super::repo::RequestScope;
use super::service::{
    Candidate, ExportResult, ImportedPdf, RequestDetail, SignContext, SignOverview, UnlockResult,
    VerifyResult,
};
use super::session::SignSessions;
use super::store::{BlobDocumentStore, MAX_SIGNED_PDF_BYTES};
use super::vault::SavedSignatureInfo;
use crate::clock;
use crate::documents::scope::InviteGuestProjects;
use crate::error::{AppError, AppResult};
use crate::network::feature::FeatureHub;
use crate::state::MiraState;

/// Folder ekspor pilihan (untuk uji ujung ke ujung dan pengguna mahir).
pub const EXPORT_DIR_ENV: &str = "MIRA_EXPORT_DIR";

/// Subfolder `data_dir` berkas PDF lama (sebelum blob store).
pub const STORE_FOLDER: &str = super::store::LEGACY_FOLDER;

const HEADER_FILE_NAME: &str = "x-mira-file-name";
const HEADER_REQUEST: &str = "x-mira-request";
const HEADER_TOKEN: &str = "x-mira-token";
const HEADER_BASE_HASH: &str = "x-mira-base-hash";

fn export_dir(app: &AppHandle, data_dir: &Path) -> PathBuf {
    if let Some(value) = std::env::var_os(EXPORT_DIR_ENV).filter(|v| !v.is_empty()) {
        let path = PathBuf::from(value);
        return std::path::absolute(&path).unwrap_or(path);
    }
    app.path()
        .download_dir()
        .unwrap_or_else(|_| data_dir.join("ekspor"))
}

fn run<T>(
    app: &AppHandle,
    state: &MiraState,
    sessions: &SignSessions,
    f: impl FnOnce(&mut SignContext<'_>) -> AppResult<T>,
) -> AppResult<T> {
    let data_dir = state.data_dir()?.to_path_buf();
    let store = match app.try_state::<Arc<SignSync>>() {
        Some(sync) => sync.store().clone(),
        None => BlobDocumentStore::in_data_dir(&data_dir)?,
    };
    let outbox: Box<dyn SignOutbox> = match app.try_state::<Arc<FeatureHub>>() {
        Some(hub) => Box::new(HubOutbox::new(hub.inner().clone())),
        None => Box::new(LocalOnlyOutbox),
    };
    let export_dir = export_dir(app, &data_dir);
    state.with_core(|core| {
        let mut ctx = SignContext {
            conn: &mut core.db,
            identity: &core.identity,
            store: &store,
            sessions,
            outbox: outbox.as_ref(),
            guests: &InviteGuestProjects,
            export_dir: &export_dir,
            kdf: KdfParams::DEFAULT,
        };
        f(&mut ctx)
    })
}

/// Pesan untuk pengguna tetap sederhana; rinciannya hanya ke log.
fn not_available(detail: impl std::fmt::Display) -> AppError {
    eprintln!("Mira: file tanda tangan belum bisa diunduh: {detail}");
    err(
        "not_available",
        "File ini belum bisa diunduh: tidak ada laptop rekan tersambung yang menyimpannya. Pastikan laptop pengirim atau penanda tangan menyala dan tersambung, lalu coba lagi.",
    )
}

fn join_error(e: impl std::fmt::Display) -> AppError {
    AppError::Internal(format!(
        "Pekerjaan tanda tangan berhenti di tengah jalan. Coba lagi. Detail: {e}"
    ))
}

/// Seperti `run`, tetapi di thread `spawn_blocking`, supaya Argon2, hash
/// BLAKE3 berkas besar, dan baca tulis berkas tidak memblokir thread async
/// Tauri. `MiraState` dan `SignSessions` di-clone (berbagi isi yang sama).
async fn run_blocking<T: Send + 'static>(
    app: &AppHandle,
    state: &State<'_, MiraState>,
    sessions: &State<'_, SignSessions>,
    f: impl FnOnce(&mut SignContext<'_>) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    let (app, state, sessions) = (app.clone(), state.inner().clone(), sessions.inner().clone());
    tauri::async_runtime::spawn_blocking(move || run(&app, &state, &sessions, f))
        .await
        .map_err(join_error)?
}

fn raw_body<'a>(request: &'a Request<'_>) -> AppResult<&'a [u8]> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes),
        InvokeBody::Json(_) => Err(AppError::Internal(
            "Isi file harus dikirim ke inti Mira sebagai byte mentah, bukan JSON. Muat ulang aplikasi lalu coba lagi."
                .into(),
        )),
    }
}

fn header<'a>(request: &'a Request<'_>, name: &str) -> Option<&'a str> {
    request.headers().get(name)?.to_str().ok()
}

fn required_header<'a>(request: &'a Request<'_>, name: &str) -> AppResult<&'a str> {
    header(request, name).ok_or_else(|| {
        AppError::Internal(format!(
            "Permintaan ke inti Mira tidak lengkap: header {name} tidak ada. Muat ulang aplikasi lalu coba lagi."
        ))
    })
}

fn hex_value(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Kebalikan `encodeURIComponent`: `%XX` menjadi byte, lalu UTF-8 (byte yang
/// tidak sah diganti U+FFFD). `%` yang tidak diikuti dua hex dibiarkan.
pub fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let (Some(hi), Some(lo)) = (
                bytes.get(i + 1).copied().and_then(hex_value),
                bytes.get(i + 2).copied().and_then(hex_value),
            )
        {
            out.push(hi * 16 + lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[tauri::command]
pub async fn sign_overview(
    app: AppHandle,
    state: State<'_, MiraState>,
    sessions: State<'_, SignSessions>,
) -> AppResult<SignOverview> {
    run_blocking(&app, &state, &sessions, |c| c.overview(clock::now())).await
}

#[tauri::command]
pub async fn sign_save_signature(
    app: AppHandle,
    state: State<'_, MiraState>,
    sessions: State<'_, SignSessions>,
    pin: String,
    png_base64: String,
) -> AppResult<SavedSignatureInfo> {
    let pin = Zeroizing::new(pin);
    run_blocking(&app, &state, &sessions, move |c| {
        c.save_signature(&pin, &png_base64, clock::now())
    })
    .await
}

/// `pin` kosong (`null`) berarti jalur lupa PIN: tanda tangan baru baru bisa
/// dipakai 24 jam setelah penghapusan.
#[tauri::command]
pub async fn sign_delete_signature(
    app: AppHandle,
    state: State<'_, MiraState>,
    sessions: State<'_, SignSessions>,
    pin: Option<String>,
) -> AppResult<()> {
    let pin = pin.map(Zeroizing::new);
    run_blocking(&app, &state, &sessions, move |c| {
        c.delete_signature(pin.as_deref().map(String::as_str), clock::now())
    })
    .await
}

#[tauri::command]
pub async fn sign_unlock(
    app: AppHandle,
    state: State<'_, MiraState>,
    sessions: State<'_, SignSessions>,
    pin: String,
) -> AppResult<UnlockResult> {
    let pin = Zeroizing::new(pin);
    run_blocking(&app, &state, &sessions, move |c| {
        c.unlock(&pin, clock::now())
    })
    .await
}

/// Tamu hanya muncul kalau `projectId` diisi dan proyek itu diizinkan untuknya.
#[tauri::command]
pub async fn sign_list_candidates(
    app: AppHandle,
    state: State<'_, MiraState>,
    sessions: State<'_, SignSessions>,
    project_id: Option<String>,
    team_id: Option<String>,
) -> AppResult<Vec<Candidate>> {
    run(&app, &state, &sessions, |c| {
        c.list_candidates_for(team_id.as_deref(), project_id.as_deref())
    })
}

#[tauri::command]
pub async fn sign_import_pdf(
    app: AppHandle,
    state: State<'_, MiraState>,
    sessions: State<'_, SignSessions>,
    request: Request<'_>,
) -> AppResult<ImportedPdf> {
    let bytes = raw_body(&request)?.to_vec();
    let file_name = header(&request, HEADER_FILE_NAME)
        .map(percent_decode)
        .unwrap_or_default();
    run_blocking(&app, &state, &sessions, move |c| {
        c.import_pdf(&bytes, &file_name)
    })
    .await
}

// Argumen perintah adalah kontrak dengan frontend (`src/api/signing.ts`).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn sign_create_request(
    app: AppHandle,
    state: State<'_, MiraState>,
    sessions: State<'_, SignSessions>,
    title: String,
    file_hash: String,
    mode: String,
    signers: Vec<String>,
    team_id: Option<String>,
    project_id: Option<String>,
) -> AppResult<RequestDetail> {
    let scope = RequestScope {
        team_id: team_id.filter(|s| !s.is_empty()),
        project_id: project_id.filter(|s| !s.is_empty()),
    };
    run(&app, &state, &sessions, |c| {
        c.create_request_scoped(&title, &file_hash, &mode, &signers, &scope, clock::now())
    })
}

/// Mengunduh file permintaan yang belum ada di laptop ini (versi terkini dan
/// versi baru yang menunggu, lihat `peer_sync::wanted_files`; termasuk yang
/// lebih dari 20 MB) dari laptop rekan, lalu mengembalikan rinciannya. File
/// yang sedang diunduh otomatis dilewati (rinciannya `downloading`). Error
/// `not_available` kalau tidak ada rekan tersambung yang menyimpannya.
#[tauri::command]
pub async fn sign_download_file(
    app: AppHandle,
    state: State<'_, MiraState>,
    sessions: State<'_, SignSessions>,
    request_id: String,
) -> AppResult<RequestDetail> {
    let sync = app
        .try_state::<Arc<SignSync>>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| not_available("sinkron tanda tangan belum berjalan"))?;
    let hub = app
        .try_state::<Arc<FeatureHub>>()
        .map(|h| h.inner().clone())
        .ok_or_else(|| not_available("jaringan belum berjalan"))?;
    let missing = {
        let (sync, id) = (sync.clone(), request_id.clone());
        tauri::async_runtime::spawn_blocking(move || sync.missing_files(&id))
            .await
            .map_err(join_error)??
    };
    let fetched = !missing.is_empty();
    for file in missing {
        let Some(guard) = Downloading::begin(sync.store(), &file.hash) else {
            continue;
        };
        let dest = sync.download_path(&file.hash)?;
        // Ukuran 0 = tidak diketahui: batasnya ukuran PDF bertanda tangan.
        let max = match file.size {
            0 => MAX_SIGNED_PDF_BYTES as u64,
            n => n.min(MAX_SIGNED_PDF_BYTES as u64),
        };
        if let Err(e) = hub.fetch_blob(&file.hash, max, file.prefer, &dest).await {
            let _ = std::fs::remove_file(&dest);
            return Err(not_available(e));
        }
        let (sync, hash) = (sync.clone(), file.hash.clone());
        tauri::async_runtime::spawn_blocking(move || sync.add_downloaded(&dest, &hash))
            .await
            .map_err(join_error)??;
        drop(guard);
    }
    if fetched {
        peer_sync::emit_changed(&app);
    }
    run_blocking(&app, &state, &sessions, move |c| c.get_request(&request_id)).await
}

#[tauri::command]
pub async fn sign_get_request(
    app: AppHandle,
    state: State<'_, MiraState>,
    sessions: State<'_, SignSessions>,
    id: String,
) -> AppResult<RequestDetail> {
    run_blocking(&app, &state, &sessions, move |c| c.get_request(&id)).await
}

#[tauri::command]
pub async fn sign_read_file(
    app: AppHandle,
    state: State<'_, MiraState>,
    sessions: State<'_, SignSessions>,
    id: String,
    hash: String,
) -> AppResult<Response> {
    let bytes = run(&app, &state, &sessions, |c| c.read_file(&id, &hash))?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn sign_complete(
    app: AppHandle,
    state: State<'_, MiraState>,
    sessions: State<'_, SignSessions>,
    request: Request<'_>,
) -> AppResult<RequestDetail> {
    let bytes = raw_body(&request)?.to_vec();
    let request_id = required_header(&request, HEADER_REQUEST)?.to_owned();
    let token = Zeroizing::new(required_header(&request, HEADER_TOKEN)?.to_owned());
    let base_hash = required_header(&request, HEADER_BASE_HASH)?.to_owned();
    run_blocking(&app, &state, &sessions, move |c| {
        c.complete(&request_id, &token, &base_hash, &bytes, clock::now())
    })
    .await
}

#[tauri::command]
pub async fn sign_cancel(
    app: AppHandle,
    state: State<'_, MiraState>,
    sessions: State<'_, SignSessions>,
    id: String,
) -> AppResult<RequestDetail> {
    run(&app, &state, &sessions, |c| c.cancel(&id, clock::now()))
}

#[tauri::command]
pub async fn sign_export(
    app: AppHandle,
    state: State<'_, MiraState>,
    sessions: State<'_, SignSessions>,
    id: String,
) -> AppResult<ExportResult> {
    run_blocking(&app, &state, &sessions, move |c| {
        c.export(&id, clock::now())
    })
    .await
}

#[tauri::command]
pub async fn sign_verify_file(
    app: AppHandle,
    state: State<'_, MiraState>,
    sessions: State<'_, SignSessions>,
    request: Request<'_>,
) -> AppResult<VerifyResult> {
    let bytes = raw_body(&request)?.to_vec();
    run_blocking(&app, &state, &sessions, move |c| c.verify_file(&bytes)).await
}

#[cfg(test)]
mod tests {
    use super::percent_decode;

    #[test]
    fn percent_decode_reverses_encode_uri_component() {
        assert_eq!(percent_decode("kontrak.pdf"), "kontrak.pdf");
        assert_eq!(
            percent_decode("Kontrak%20Sewa%20(final).pdf"),
            "Kontrak Sewa (final).pdf"
        );
        // "Perjanjian Kerja Sama – Ä.pdf" dengan en dash dan huruf beraksen.
        assert_eq!(
            percent_decode("Perjanjian%20Kerja%20Sama%20%E2%80%93%20%C3%84.pdf"),
            "Perjanjian Kerja Sama \u{2013} \u{c4}.pdf"
        );
        assert_eq!(percent_decode("a%2Fb%5cc"), "a/b\\c");
    }

    #[test]
    fn percent_decode_keeps_bad_sequences() {
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz%4"), "%zz%4");
        assert_eq!(percent_decode("%FF"), "\u{FFFD}");
        assert_eq!(percent_decode(""), "");
    }
}
