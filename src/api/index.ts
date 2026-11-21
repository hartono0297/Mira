import { invoke } from "@tauri-apps/api/core";
import type { AppError, AppState, IdentityInfo, OrgInfo } from "./types";

export * from "./types";

export function isAppError(value: unknown): value is AppError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AppError).code === "string" &&
    typeof (value as AppError).message === "string"
  );
}

// Semua error yang sampai ke layar dibentuk jadi AppError dengan pesan Indonesia.
export function toAppError(value: unknown): AppError {
  if (isAppError(value)) return value;
  const detail = value instanceof Error ? value.message : typeof value === "string" ? value : "";
  return {
    code: "unknown",
    message: detail
      ? `Terjadi kesalahan yang tidak dikenali: ${detail}`
      : "Terjadi kesalahan yang tidak dikenali.",
  };
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const NO_TAURI_ERROR: AppError = {
  code: "no_tauri",
  message: "Halaman ini dibuka di browser biasa, jadi tidak bisa membaca data Mira di laptop ini.",
};

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw NO_TAURI_ERROR;
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw toAppError(err);
  }
}

export const api = {
  getAppState: () => call<AppState>("get_app_state"),
  saveDisplayName: (name: string) => call<IdentityInfo>("save_display_name", { name }),
  createOrganization: (name: string) => call<OrgInfo>("create_organization", { name }),
  getSetting: (key: string) => call<string | null>("get_setting", { key }),
  setSetting: (key: string, value: string) => call<null>("set_setting", { key, value }),
};
