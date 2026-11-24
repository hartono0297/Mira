// Command tambahan milik halaman Organisasi (src-tauri/src/org_screen.rs).
// Kontrak bersama ada di ./org.ts; file ini hanya untuk B.
import { invoke } from "@tauri-apps/api/core";
import { isTauri, NO_TAURI_ERROR, toAppError } from ".";
import { localizeError } from "../i18n/errors";

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw NO_TAURI_ERROR;
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw localizeError(toAppError(err));
  }
}

export const orgScreenApi = {
  // Sidik organisasi pendek "XXXX-XXXX" (kontrak v0.3, 8.6), untuk dicocokkan
  // dengan layar laptop yang minta bergabung.
  fingerprint: () => call<string>("org_fingerprint"),
};
