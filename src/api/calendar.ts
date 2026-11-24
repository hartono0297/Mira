// Kalender task: semua task bertenggat dari proyek yang boleh saya lihat
// (docs/plans/sidebar-kalender.md, bagian 2.1 dan 2.2). Pembaruan lewat
// subscribeBoard dari ./board; ubah tenggat lewat boardApi.updateTask.
import { invoke } from "@tauri-apps/api/core";
import { isTauri, NO_TAURI_ERROR, toAppError } from ".";
import { localizeError } from "../i18n/errors";
import type { MyTask } from "./board";

export type CalTask = MyTask; // { projectId, projectCode, projectName, task: TaskCard }

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw NO_TAURI_ERROR;
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw localizeError(toAppError(err));
  }
}

export const calendarApi = {
  // Rentang inklusif YYYY-MM-DD; null = tanpa batas di sisi itu.
  tasks: (from: string | null, to: string | null) => call<CalTask[]>("board_calendar", { from, to }),
};
