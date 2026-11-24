// Kontrak board dengan inti Rust (docs/plans/tahap-3-lokal.md, "Kontrak command Tauri").
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri, NO_TAURI_ERROR, toAppError } from ".";
import { localizeError } from "../i18n/errors";

export type ColumnId = "todo" | "doing" | "done";
export type Priority = "none" | "low" | "medium" | "high";

export type Person = { publicKey: string; name: string };

export type ProjectSummary = {
  id: string;
  code: string;
  name: string;
  // Departemen proyek ("team" di inti Rust). null = proyek tanpa departemen.
  // Sejak v0.3 yang melihat proyek hanya anggotanya (orgApi.projectMembers), bukan seluruh departemen.
  teamId: string | null;
  teamName: string | null;
  openCount: number;
  taskCount: number;
  canManage: boolean;
};

export type TaskCard = {
  id: string;
  code: string;
  title: string;
  columnId: ColumnId;
  assignee: Person | null;
  due: string | null; // YYYY-MM-DD
  priority: Priority;
  labels: string[];
  commentCount: number;
  // Ada perubahan dari laptop lain yang digabung otomatis (F-TASK-04). Selalu false sampai sinkron board ada.
  merged: boolean;
  // v0.4: progres subtask (yang belum dihapus) dan waktu tercatat.
  subtaskDone: number;
  subtaskTotal: number;
  // Total detik dari catatan waktu yang sudah berhenti (semua orang).
  trackedSecs: number;
  // Waktu mulai (RFC 3339) setiap timer yang masih berjalan, semua orang.
  timersRunningSince: string[];
  // v0.4 menu klik kanan: saya boleh mengubah task ini (hak tulis di proyek),
  // boleh menghapusnya, dan timer saya sedang berjalan di task ini. Opsional
  // supaya data uji lama tetap sah; inti Rust selalu mengirimnya.
  canEdit?: boolean;
  canDelete?: boolean;
  myTimerRunning?: boolean;
};

export type Column = { id: ColumnId; name: string; tasks: TaskCard[] };

export type BoardView = {
  project: ProjectSummary;
  columns: Column[];
  assignees: Person[];
  me: string;
  canCreate: boolean;
};

export type Comment = { id: string; author: Person; at: string; body: string };

export type ActivityKind =
  | "created"
  | "title"
  | "description"
  | "moved"
  | "assignee"
  | "due"
  | "priority"
  | "labels"
  | "deleted"
  | "commented"
  | "renumbered"
  | "subtask_added"
  | "subtask_done"
  | "subtask_reopened"
  | "subtask_deleted"
  | "time_logged";

export type Activity = { at: string; actor: Person; kind: ActivityKind | string; detail: string };

// Subtask hidup, urut menurut posisinya.
export type Subtask = {
  id: string;
  title: string;
  done: boolean;
  assignee: Person | null;
  doneBy: Person | null;
  doneAt: string | null;
  createdBy: Person;
};

// Satu catatan waktu. end null = timer masih berjalan. secs = end - start (0 kalau berjalan).
export type TimeEntry = {
  id: string;
  person: Person;
  start: string;
  end: string | null;
  manual: boolean;
  note: string;
  secs: number;
  mine: boolean;
};

// Total per orang. secs = catatan yang sudah berhenti; runningSince = timer yang berjalan.
export type TimeTotal = { person: Person; secs: number; runningSince: string | null };

// Durasi per status dari riwayat perpindahan. closedSecs tidak termasuk selang yang
// masih berjalan; tambahkan (sekarang - currentSince) ke currentColumn.
export type StatusTime = {
  closedSecs: Record<ColumnId, number>;
  currentColumn: ColumnId;
  currentSince: string;
  // Dari dibuat sampai terakhir masuk Selesai; null kalau task belum di Selesai.
  cycleSecs: number | null;
  // Ada waktu di masa depan atau urutan riwayat tidak cocok dengan urutan waktu:
  // jam beberapa laptop mungkin berbeda.
  clockWarning: boolean;
};

export type TaskDetail = TaskCard & {
  projectId: string;
  description: string;
  createdBy: Person;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
  activity: Activity[];
  // Di inti Rust kedua field ini milik kartu; di detail selalu ada.
  canEdit: boolean;
  canDelete: boolean;
  canComment: boolean;
  subtasks: Subtask[];
  timeEntries: TimeEntry[]; // terbaru dulu, tanpa yang dihapus
  timeTotals: TimeTotal[];
  // Id catatan timer saya yang sedang berjalan di task ini.
  myRunningEntry: string | null;
  statusTime: StatusTime;
};

// Field yang tidak ada = tidak diubah. assignee null = dikosongkan.
export type SubtaskPatch = { title?: string; done?: boolean; assignee?: string | null };

export type NewTask = {
  title: string;
  columnId?: ColumnId;
  description?: string;
  assignee?: string | null;
  due?: string | null;
  priority?: Priority;
  labels?: string[];
};

// Field yang tidak ada = tidak diubah. assignee/due bernilai null = dikosongkan.
export type TaskPatch = {
  title?: string;
  description?: string;
  assignee?: string | null;
  due?: string | null;
  priority?: Priority;
  labels?: string[];
};

export type MyTask = { projectId: string; projectCode: string; projectName: string; task: TaskCard };

// Proyek terdaftar yang belum saya ikuti, hanya untuk superadmin (board_outside_projects).
// Log keanggotaan tidak memuat nama proyek: code dan name hanya ada kalau laptop ini
// masih menyimpan board-nya. Superadmin boleh menambahkan dirinya sendiri
// (orgApi.addProjectMember dengan kuncinya), dan langkah itu tercatat di log.
export type OutsideProject = {
  id: string;
  code: string | null;
  name: string | null;
  teamId: string | null;
  teamName: string | null;
  creatorName: string;
  memberCount: number;
  createdAt: string;
};

// Kunci pengaturan pengingat tenggat (per laptop), nilai "on" atau "off", bawaan "on".
export const REMINDER_DAY_BEFORE = "board.reminder.day_before";
export const REMINDER_DUE_DAY = "board.reminder.due_day";

// Perubahan board di laptop ini.
export const BOARD_EVENT = "mira://board";
// Perubahan dari laptop lain lewat sinkron fitur. Payload { topic }, board memakai topik "board".
export const FEATURE_EVENT = "mira://feature";
export const BOARD_TOPIC = "board";
// Op keanggotaan baru (anggota proyek ditambah atau dikeluarkan) mengubah proyek yang terlihat.
export const DIRECTORY_EVENT = "mira://directory";

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw NO_TAURI_ERROR;
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw localizeError(toAppError(err));
  }
}

export const boardApi = {
  listProjects: () => call<ProjectSummary[]>("board_list_projects"),
  // members: kunci publik orang yang dipilih selain pembuat (pembuat selalu anggota).
  createProject: (name: string, code: string, teamId: string | null = null, members: string[] = []) =>
    call<ProjectSummary>("board_create_project", { name, code, teamId, members }),
  outsideProjects: () => call<OutsideProject[]>("board_outside_projects"),
  updateProject: (projectId: string, name: string) =>
    call<ProjectSummary>("board_update_project", { projectId, name }),
  getBoard: (projectId: string) => call<BoardView>("board_get_board", { projectId }),
  createTask: (projectId: string, input: NewTask) => call<TaskDetail>("board_create_task", { projectId, input }),
  getTask: (projectId: string, taskId: string) => call<TaskDetail>("board_get_task", { projectId, taskId }),
  updateTask: (projectId: string, taskId: string, patch: TaskPatch) =>
    call<TaskDetail>("board_update_task", { projectId, taskId, patch }),
  // index = posisi di kolom tujuan setelah pindah, 0 = paling atas.
  moveTask: (projectId: string, taskId: string, columnId: ColumnId, index: number) =>
    call<BoardView>("board_move_task", { projectId, taskId, columnId, index }),
  deleteTask: (projectId: string, taskId: string) => call<null>("board_delete_task", { projectId, taskId }),
  addComment: (projectId: string, taskId: string, body: string) =>
    call<TaskDetail>("board_add_comment", { projectId, taskId, body }),
  myTasks: () => call<MyTask[]>("board_my_tasks"),
  addSubtask: (projectId: string, taskId: string, title: string, assignee: string | null = null) =>
    call<TaskDetail>("board_add_subtask", { projectId, taskId, title, assignee }),
  updateSubtask: (projectId: string, taskId: string, subtaskId: string, patch: SubtaskPatch) =>
    call<TaskDetail>("board_update_subtask", { projectId, taskId, subtaskId, patch }),
  // index = posisi setelah pindah, 0 = paling atas.
  moveSubtask: (projectId: string, taskId: string, subtaskId: string, index: number) =>
    call<TaskDetail>("board_move_subtask", { projectId, taskId, subtaskId, index }),
  deleteSubtask: (projectId: string, taskId: string, subtaskId: string) =>
    call<TaskDetail>("board_delete_subtask", { projectId, taskId, subtaskId }),
  // Menghentikan timer saya yang lain di proyek yang sama.
  startTimer: (projectId: string, taskId: string) => call<TaskDetail>("board_start_timer", { projectId, taskId }),
  stopTimer: (projectId: string, taskId: string, note: string | null = null) =>
    call<TaskDetail>("board_stop_timer", { projectId, taskId, note }),
  // minutes 1 sampai 1440.
  logTime: (projectId: string, taskId: string, minutes: number, note: string | null = null) =>
    call<TaskDetail>("board_log_time", { projectId, taskId, minutes, note }),
  deleteTimeEntry: (projectId: string, taskId: string, entryId: string) =>
    call<TaskDetail>("board_delete_time_entry", { projectId, taskId, entryId }),
};

function isBoardTopic(payload: unknown): boolean {
  return !!payload && typeof payload === "object" && (payload as { topic?: unknown }).topic === BOARD_TOPIC;
}

// Memuat ulang saat board berubah, baik di laptop ini (mira://board) maupun
// dari laptop lain (mira://feature dengan topik "board"), dan saat anggota
// proyek berubah (mira://directory). Topik fitur lain diabaikan. Di luar
// aplikasi desktop tidak melakukan apa pun.
export function subscribeBoard(handler: () => void): () => void {
  if (!isTauri()) return () => {};
  let stopped = false;
  const unlisteners: (() => unknown)[] = [];
  const stop = (fn: () => unknown) => void Promise.resolve().then(fn).catch(() => {});
  const watch = (event: string, accept: (payload: unknown) => boolean) => {
    try {
      listen(event, (e) => {
        if (!stopped && accept(e?.payload)) handler();
      })
        .then((fn) => {
          if (stopped) stop(fn);
          else unlisteners.push(fn);
        })
        .catch(() => {});
    } catch {
      // listen tidak tersedia: pemanggil tetap memuat ulang setelah aksinya sendiri dan lewat polling.
    }
  };
  watch(BOARD_EVENT, () => true);
  watch(FEATURE_EVENT, isBoardTopic);
  watch(DIRECTORY_EVENT, () => true);
  return () => {
    stopped = true;
    unlisteners.splice(0).forEach(stop);
  };
}
