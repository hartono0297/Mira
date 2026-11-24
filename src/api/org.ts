// Kontrak organisasi v0.3 dengan inti Rust (docs/plans/v0.3-kontrak.md, bagian "Command").
// Departemen di sini sama dengan "team" di inti Rust: id departemen = teamId.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri, NO_TAURI_ERROR, toAppError } from ".";
import { localizeError } from "../i18n/errors";
import type { Role, TeamRole } from "./types";

export type PersonRef = { publicKey: string; displayName: string };
export type LabelRef = { id: string; name: string };

export type OrgOverview = {
  publicKey: string;
  isSuperadmin: boolean;
  isGuest: boolean;
  departmentId: string | null;
  // Departemen yang permintaan bergabungnya boleh diputuskan orang ini (semua untuk superadmin).
  decideJoinTeamIds: string[];
  // Untuk angka di menu Organisasi.
  pendingJoinCount: number;
  // Superadmin: departemen, pindah orang, label, daftar pengguna.
  manageOrg: boolean;
};

export type DepartmentView = {
  id: string;
  name: string;
  createdAt: string;
  archived: boolean;
  archivedAt: string | null;
  memberCount: number;
  admins: PersonRef[];
  channelId: string | null;
  channelName: string | null;
};

export type PersonView = {
  publicKey: string;
  displayName: string;
  fingerprint: string;
  role: Role;
  isSuperadmin: boolean;
  isGuest: boolean;
  departmentId: string | null;
  departmentName: string | null;
  // "admin" = Admin departemen.
  departmentRole: TeamRole | null;
  // Label aktif, urut nama. Tampilkan paling banyak 3 di samping nama.
  labels: LabelRef[];
};

export type DeviceView = { laptop: string; os: string; appVersion: string; reportedAt: string };

export type UserView = PersonView & {
  status: "active" | "removed";
  joinedAt: string;
  removedAt: string | null;
  // null = "Belum dilaporkan".
  device: DeviceView | null;
  // Dilihat dari koneksi, bukan laporan laptop itu sendiri. null untuk laptop ini.
  lastIp: string | null;
  online: boolean;
  lastSeenAt: string | null;
  isMe: boolean;
  guestProjectCount: number;
};

export type ProjectRole = "manager" | "member" | "guest";

export type ProjectMemberView = {
  publicKey: string;
  displayName: string;
  departmentName: string | null;
  role: ProjectRole;
  isCreator: boolean;
  // Tamu yang masuk lewat kode undangan, bukan dari daftar anggota.
  byInvite: boolean;
};

export type ProjectMembersView = {
  projectId: string;
  // false: proyek belum terdaftar di log, belum ada yang boleh melihatnya.
  registered: boolean;
  teamId: string | null;
  creator: string | null;
  members: ProjectMemberView[];
  canManage: boolean;
  canLeave: boolean;
  // Superadmin di luar proyek boleh menambahkan dirinya sendiri (tercatat di log).
  canJoinSelf: boolean;
};

export type LabelView = {
  id: string;
  name: string;
  archived: boolean;
  createdAt: string;
  memberKeys: string[];
};

export type JoinRequestView = {
  id: string;
  publicKey: string;
  displayName: string;
  teamId: string;
  teamName: string;
  laptop: string;
  os: string;
  appVersion: string;
  requestedAt: string;
  receivedAt: string;
  // "XXXX XXXX", dicocokkan dengan layar laptop peminta.
  code: string;
  // Alamat yang dilihat laptop penerima (seenByName), bukan laporan peminta.
  ip: string | null;
  seenByName: string | null;
  // v0.4, dari permintaan bertanda tangan. null untuk permintaan dari Mira v0.3.
  // Keterangan untuk admin yang diketik peminta (jabatan, nomor karyawan).
  note: string | null;
  // Nama akun login Windows atau macOS di laptop peminta.
  account: string | null;
};

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw NO_TAURI_ERROR;
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw localizeError(toAppError(err));
  }
}

export const orgApi = {
  // Baca
  overview: () => call<OrgOverview>("org_overview"),
  departments: (includeArchived = false) => call<DepartmentView[]>("org_departments", { includeArchived }),
  people: () => call<PersonView[]>("org_people"),
  users: () => call<UserView[]>("org_users"),
  labels: () => call<LabelView[]>("org_labels"),
  projectMembers: (projectId: string) => call<ProjectMembersView>("org_project_members", { projectId }),
  joinRequests: () => call<JoinRequestView[]>("org_join_requests"),

  // Departemen (superadmin)
  createDepartment: (name: string) => call<DepartmentView>("org_create_department", { name }),
  renameDepartment: (teamId: string, name: string) => call<null>("org_rename_department", { teamId, name }),
  setDepartmentArchived: (teamId: string, archived: boolean) =>
    call<null>("org_set_department_archived", { teamId, archived }),
  setDepartmentAdmin: (teamId: string, publicKey: string, admin: boolean) =>
    call<null>("org_set_department_admin", { teamId, publicKey, admin }),
  moveMember: (publicKey: string, teamId: string) => call<null>("org_move_member", { publicKey, teamId }),

  // Permintaan bergabung (superadmin atau admin departemen tujuan)
  approveJoin: (requestId: string) => call<null>("org_approve_join", { requestId }),
  rejectJoin: (requestId: string) => call<null>("org_reject_join", { requestId }),

  // Anggota proyek
  addProjectMember: (projectId: string, publicKey: string) =>
    call<null>("org_add_project_member", { projectId, publicKey }),
  removeProjectMember: (projectId: string, publicKey: string) =>
    call<null>("org_remove_project_member", { projectId, publicKey }),

  // Label (superadmin)
  createLabel: (name: string) => call<string>("org_create_label", { name }),
  renameLabel: (labelId: string, name: string) => call<null>("org_rename_label", { labelId, name }),
  setLabelArchived: (labelId: string, archived: boolean) =>
    call<null>("org_set_label_archived", { labelId, archived }),
  setLabelAssigned: (labelId: string, publicKey: string, assigned: boolean) =>
    call<null>("org_set_label_assigned", { labelId, publicKey, assigned }),
};

// Data organisasi berubah (op baru dari laptop ini atau rekan).
export const DIRECTORY_EVENT = "mira://directory";
// Permintaan bergabung yang dipegang laptop ini berubah (datang langsung atau diteruskan rekan).
export const JOIN_REQUESTS_EVENT = "mira://join-requests";

// Memuat ulang data organisasi saat salah satu event di atas datang. Di luar aplikasi
// desktop tidak melakukan apa pun; pemanggil tetap memuat ulang setelah aksinya sendiri.
export function subscribeOrg(handler: () => void): () => void {
  if (!isTauri()) return () => {};
  let stopped = false;
  const unlisteners: (() => unknown)[] = [];
  const stop = (fn: () => unknown) => void Promise.resolve().then(fn).catch(() => {});
  for (const event of [DIRECTORY_EVENT, JOIN_REQUESTS_EVENT]) {
    try {
      listen(event, () => {
        if (!stopped) handler();
      })
        .then((fn) => {
          if (stopped) stop(fn);
          else unlisteners.push(fn);
        })
        .catch(() => {});
    } catch {
      // listen tidak tersedia: pemanggil tetap memuat ulang sendiri.
    }
  }
  return () => {
    stopped = true;
    unlisteners.splice(0).forEach(stop);
  };
}
