// Status pembaruan sebagai reducer murni, supaya setiap perpindahan bisa diuji tanpa Tauri.
import type { AppError } from "../api";
import type { UpdateCheck } from "../api/updater";

export type ErrorKind = "offline" | "notConfigured" | "failed";
// Langkah yang diulang oleh tombol coba lagi.
export type RetryTarget = "check" | "download" | "install";

export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "upToDate" }
  | { status: "available"; version: string; notes: string | null; date: string | null }
  | { status: "downloading"; version: string; percent: number | null }
  | { status: "ready"; version: string }
  | { status: "installing"; version: string }
  | { status: "error"; kind: ErrorKind; message: string; retry: RetryTarget; version: string | null };

export type UpdateAction =
  | { type: "checkStart" }
  | { type: "checkDone"; result: UpdateCheck }
  | { type: "silentFail" }
  | { type: "downloadStart"; version: string }
  | { type: "progress"; downloaded: number; total: number | null }
  | { type: "downloadDone"; version: string }
  | { type: "installStart" }
  | { type: "failed"; error: AppError; during: RetryTarget };

export const initialUpdateState: UpdateState = { status: "idle" };

export function errorKind(error: AppError): ErrorKind {
  if (error.code === "update_offline") return "offline";
  if (error.code === "update_not_configured") return "notConfigured";
  return "failed";
}

// Sedang mengunduh atau memasang: cek baru tidak boleh memotongnya.
export function isBusy(state: UpdateState): boolean {
  return state.status === "checking" || state.status === "downloading" || state.status === "installing";
}

export function hasUpdate(state: UpdateState): boolean {
  return state.status === "available" || state.status === "downloading" || state.status === "ready";
}

function percentOf(downloaded: number, total: number | null): number | null {
  if (total === null || !(total > 0) || !(downloaded >= 0)) return null;
  return Math.min(100, Math.floor((downloaded / total) * 100));
}

function versionOf(state: UpdateState): string | null {
  return "version" in state ? state.version : null;
}

export function updateReducer(state: UpdateState, action: UpdateAction): UpdateState {
  switch (action.type) {
    case "checkStart":
      return isBusy(state) ? state : { status: "checking" };
    case "checkDone": {
      if (state.status !== "checking") return state;
      const r = action.result;
      return r.available
        ? { status: "available", version: r.version, notes: r.notes, date: r.date }
        : { status: "upToDate" };
    }
    case "silentFail":
      return state.status === "checking" ? { status: "idle" } : state;
    case "downloadStart":
      if (state.status === "available" || (state.status === "error" && state.retry === "download")) {
        return { status: "downloading", version: action.version, percent: null };
      }
      return state;
    case "progress": {
      if (state.status !== "downloading") return state;
      const percent = percentOf(action.downloaded, action.total);
      return percent === state.percent ? state : { ...state, percent };
    }
    case "downloadDone":
      return state.status === "downloading" ? { status: "ready", version: action.version } : state;
    case "installStart":
      if (state.status === "ready" || (state.status === "error" && state.retry === "install" && state.version)) {
        return { status: "installing", version: state.version as string };
      }
      return state;
    case "failed": {
      // Unduhan yang tertunda hilang: satu-satunya jalan adalah cek ulang.
      const pendingLost = action.error.code === "update_no_pending";
      return {
        status: "error",
        kind: errorKind(action.error),
        message: action.error.message,
        retry: pendingLost ? "check" : action.during,
        version: versionOf(state),
      };
    }
  }
}
