// Kontrak pembaruan dengan inti Rust (docs/plans/updater.md, "Kontrak Rust dan tampilan").
import { Channel, invoke } from "@tauri-apps/api/core";
import { isTauri, NO_TAURI_ERROR, toAppError } from ".";

export type UpdateInfo = { currentVersion: string; configured: boolean };

export type UpdateCheck =
  | { available: false; currentVersion: string }
  | { available: true; currentVersion: string; version: string; notes: string | null; date: string | null };

// `downloaded` adalah jumlah byte yang sudah diterima sejauh ini, `total` null
// kalau server tidak menyebut ukuran berkas.
export type DownloadProgress = { downloaded: number; total: number | null };

export type UpdateErrorCode =
  | "update_offline"
  | "update_not_configured"
  | "update_no_pending"
  | "update_bad_signature"
  | "update_failed";

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw NO_TAURI_ERROR;
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw toAppError(err);
  }
}

export function updateInfo(): Promise<UpdateInfo> {
  return call<UpdateInfo>("update_info");
}

export function updateCheck(): Promise<UpdateCheck> {
  return call<UpdateCheck>("update_check");
}

export async function updateDownload(onProgress: (p: DownloadProgress) => void): Promise<{ version: string }> {
  if (!isTauri()) throw NO_TAURI_ERROR;
  const onEvent = new Channel<DownloadProgress>();
  onEvent.onmessage = onProgress;
  return call<{ version: string }>("update_download", { onEvent });
}

// Di Windows perintah ini tidak kembali: Mira keluar dan installer membukanya lagi.
export function updateInstall(): Promise<null> {
  return call<null>("update_install");
}
