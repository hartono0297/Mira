// Kontrak board dengan inti Rust (docs/plans/tahap-3-lokal.md, "Kontrak command Tauri").
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri, NO_TAURI_ERROR, toAppError } from ".";

export type ColumnId = "todo" | "doing" | "done";
export type Priority = "none" | "low" | "medium" | "high";

export type Person = { publicKey: string; name: string };

export type ProjectSummary = {
  id: string;
  code: string;
  name: string;
  teamId: string | null;
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
  | "commented";

export type Activity = { at: string; actor: Person; kind: ActivityKind | string; detail: string };

export type TaskDetail = TaskCard & {
  projectId: string;
  description: string;
  createdBy: Person;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
  activity: Activity[];
  canEdit: boolean;
  canDelete: boolean;
};

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

// Kunci pengaturan pengingat tenggat (per laptop), nilai "on" atau "off", bawaan "on".
export const REMINDER_DAY_BEFORE = "board.reminder.day_before";
export const REMINDER_DUE_DAY = "board.reminder.due_day";

export const BOARD_EVENT = "mira://board";

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw NO_TAURI_ERROR;
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw toAppError(err);
  }
}

export const boardApi = {
  listProjects: () => call<ProjectSummary[]>("board_list_projects"),
  createProject: (name: string, code: string, teamId: string | null = null) =>
    call<ProjectSummary>("board_create_project", { name, code, teamId }),
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
};

// Memuat ulang saat board berubah. Di luar aplikasi desktop tidak melakukan apa pun.
export function subscribeBoard(handler: () => void): () => void {
  if (!isTauri()) return () => {};
  let stopped = false;
  let unlisten: (() => unknown) | null = null;
  const stop = (fn: () => unknown) => void Promise.resolve().then(fn).catch(() => {});
  try {
    listen(BOARD_EVENT, () => {
      if (!stopped) handler();
    })
      .then((fn) => {
        if (stopped) stop(fn);
        else unlisten = fn;
      })
      .catch(() => {});
  } catch {
    // listen tidak tersedia: pemanggil tetap memuat ulang setelah aksinya sendiri.
  }
  return () => {
    stopped = true;
    if (unlisten) stop(unlisten);
  };
}
