// Kontrak "Departemen saya" dan Divisi dengan inti Rust (docs/plans/dept-divisi.md, bagian 5).
// Departemen di sini sama dengan "team" di inti Rust: id departemen = teamId.
import { invoke } from "@tauri-apps/api/core";
import { isTauri, NO_TAURI_ERROR, toAppError } from ".";
import { localizeError } from "../i18n/errors";

export type DivisionRole = "head" | "member";

export type DivisionRef = {
  id: string;
  name: string;
  teamId: string;
  teamName: string;
  archived: boolean;
  // Peran saya di divisi itu; null kalau saya hanya mengelolanya. Opsional supaya data uji lama tetap sah.
  role?: DivisionRole | null;
};

export type DeptMember = {
  publicKey: string;
  displayName: string;
  fingerprint: string;
  isSuperadmin: boolean;
  isAdmin: boolean;
  isMe: boolean;
  online: boolean;
  labels: { id: string; name: string }[];
  divisions: { id: string; name: string; role: DivisionRole }[];
  appVersion: string | null;
};

export type DivisionView = {
  id: string;
  name: string;
  archived: boolean;
  createdAt: string;
  members: { publicKey: string; displayName: string; role: DivisionRole }[];
  // Admin departemen atau superadmin: ganti nama, arsip, tunjuk kepala.
  canManage: boolean;
  // canManage atau kepala divisi ini: tambah dan keluarkan anggota, atur chat divisi.
  canEditMembers: boolean;
  // Percakapan chat divisi, "ch:<id>".
  conv: string;
  settings: ChatSettingsView;
};

export type DeptProject = {
  id: string;
  name: string;
  divisionId: string | null;
  divisionName: string | null;
  members: { publicKey: string; displayName: string }[];
};

export type ChatSettingsView = {
  pinned: string;
  announce: boolean;
  setAt: string | null;
  setByName: string | null;
};

export type AdminEvent = {
  at: string;
  byName: string;
  targetName: string;
  admin: boolean;
  status: "applied" | "rejected";
};

export type GateBlocker = { publicKey: string; name: string; appVersion: string | null };

export type DeptOverview = {
  teamId: string;
  teamName: string;
  archived: boolean;
  // Departemen yang boleh dipilih (superadmin: semua yang hidup).
  choices: { id: string; name: string }[];
  me: { publicKey: string; isSuperadmin: boolean; isAdmin: boolean; headOf: string[] };
  // Superadmin atau admin departemen ini.
  canManageDept: boolean;
  members: DeptMember[];
  divisions: DivisionView[];
  projects: DeptProject[];
  channel: { conv: string; name: string; settings: ChatSettingsView };
  // Terbaru dulu, paling banyak 50.
  adminHistory: AdminEvent[];
  // Gerbang versi: perubahan divisi baru bisa disimpan setelah semua laptop cukup baru.
  gate: { open: boolean; since: string; blockers: GateBlocker[] };
};

export type ConversationSettings = {
  pinned: string;
  announce: boolean;
  // false: mode pengumuman aktif dan orang ini bukan pengelola.
  canWrite: boolean;
  // Boleh mengubah catatan dan mode pengumuman.
  canEdit: boolean;
  teamId: string;
  divisionId: string | null;
};

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw NO_TAURI_ERROR;
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw localizeError(toAppError(err));
  }
}

export const divisionApi = {
  // Baca. null: orang ini tidak berhak melihat departemen itu.
  deptOverview: (teamId: string | null) => call<DeptOverview | null>("dept_overview", { teamId }),
  myDivisions: () => call<DivisionRef[]>("my_divisions"),
  conversationSettings: (conv: string) => call<ConversationSettings | null>("conversation_settings", { conv }),

  // Divisi (admin departemen atau superadmin; anggota juga oleh kepala divisi)
  createDivision: (teamId: string, name: string) => call<string>("division_create", { teamId, name }),
  renameDivision: (divisionId: string, name: string) => call<null>("division_rename", { divisionId, name }),
  setDivisionArchived: (divisionId: string, archived: boolean) =>
    call<null>("division_archive", { divisionId, archived }),
  setDivisionHead: (divisionId: string, publicKey: string, head: boolean) =>
    call<null>("division_set_head", { divisionId, publicKey, head }),
  addDivisionMember: (divisionId: string, publicKey: string) =>
    call<null>("division_add_member", { divisionId, publicKey }),
  removeDivisionMember: (divisionId: string, publicKey: string) =>
    call<null>("division_remove_member", { divisionId, publicKey }),

  // Admin departemen (admin departemen itu atau superadmin)
  setDeptAdmin: (teamId: string, publicKey: string, admin: boolean) =>
    call<null>("dept_set_admin", { teamId, publicKey, admin }),

  // Catatan disematkan dan mode pengumuman. divisionId null: channel departemen.
  setChatSettings: (teamId: string, divisionId: string | null, pinned: string, announce: boolean) =>
    call<null>("chat_settings_set", { teamId, divisionId, pinned, announce }),
};
