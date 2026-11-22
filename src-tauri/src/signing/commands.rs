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
//! - File PDF: `FolderStore` di `<data_dir>/ttd-berkas`.
//! - Folder ekspor: `MIRA_EXPORT_DIR` kalau diisi, kalau tidak folder Unduhan
//!   Windows, kalau itu pun gagal `<data_dir>/ekspor`.

use std::path::{Path, PathBuf};

use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroizing;

use super::outbox::LocalOnlyOutbox;
use super::pin::KdfParams;
use super::service::{
    Candidate, ExportResult, ImportedPdf, RequestDetail, SignContext, SignOverview, UnlockResult,
    VerifyResult,
};
use super::session::SignSessions;
use super::store::FolderStore;
use super::vault::SavedSignatureInfo;
use crate::clock;
use crate::error::{AppError, AppResult};
use crate::state::MiraState;

/// Folder ekspor pilihan (untuk uji ujung ke ujung dan pengguna mahir).
pub const EXPORT_DIR_ENV: &str = "MIRA_EXPORT_DIR";

/// Subfolder `data_dir` untuk file PDF tanda tangan.
pub const STORE_FOLDER: &str = "ttd-berkas";

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
    let store = FolderStore::new(data_dir.join(STORE_FOLDER));
    let export_dir = export_dir(app, &data_dir);
    state.with_core(|core| {
        let mut ctx = SignContext {
            conn: &mut core.db,
            identity: &core.identity,
            store: &store,
            sessions,
            outbox: &LocalOnlyOutbox,
            export_dir: &export_dir,
            kdf: KdfParams::DEFAULT,
        };
        f(&mut ctx)
    })
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
        .map_err(|e| {
            AppError::Internal(format!(
                "Pekerjaan tanda tangan berhenti di tengah jalan. Coba lagi. Detail: {e}"
            ))
        })?
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

#[tauri::command]
pub async fn sign_list_candidates(
    app: AppHandle,
    state: State<'_, MiraState>,
    sessions: State<'_, SignSessions>,
) -> AppResult<Vec<Candidate>> {
    run(&app, &state, &sessions, |c| c.list_candidates())
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

#[tauri::command]
pub async fn sign_create_request(
    app: AppHandle,
    state: State<'_, MiraState>,
    sessions: State<'_, SignSessions>,
    title: String,
    file_hash: String,
    mode: String,
    signers: Vec<String>,
) -> AppResult<RequestDetail> {
    run(&app, &state, &sessions, |c| {
        c.create_request(&title, &file_hash, &mode, &signers, clock::now())
    })
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
