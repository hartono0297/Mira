import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AppError,
  AppState,
  CreatedInvite,
  Directory,
  FirewallStatus,
  IdentityInfo,
  InviteRole,
  InviteValidity,
  ManualAddress,
  NetworkStatus,
  OrgInfo,
  RejectedChange,
  TeamView,
} from "./types";

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

  // Organisasi, tim, dan undangan
  getDirectory: () => call<Directory>("get_directory"),
  createTeam: (name: string) => call<TeamView>("create_team", { name }),
  deleteTeam: (teamId: string) => call<null>("delete_team", { teamId }),
  addTeamMember: (teamId: string, publicKey: string) => call<null>("add_team_member", { teamId, publicKey }),
  removeTeamMember: (teamId: string, publicKey: string) => call<null>("remove_team_member", { teamId, publicKey }),
  setTeamAdmin: (teamId: string, publicKey: string, admin: boolean) =>
    call<null>("set_team_admin", { teamId, publicKey, admin }),
  addSuperadmin: (publicKey: string) => call<null>("add_superadmin", { publicKey }),
  removeSuperadmin: (publicKey: string) => call<null>("remove_superadmin", { publicKey }),
  removeMember: (publicKey: string) => call<null>("remove_member", { publicKey }),
  createInvite: (teamId: string, role: InviteRole, validity: InviteValidity, projectIds: string[] = []) =>
    call<CreatedInvite>("create_invite", { teamId, role, validity, projectIds }),
  revokeInvite: (inviteId: string) => call<null>("revoke_invite", { inviteId }),
  joinWithCode: (code: string, address: string | null) => call<OrgInfo>("join_with_code", { code, address }),
  redeemInvite: (code: string) => call<null>("redeem_invite", { code }),

  // Jaringan
  getNetworkStatus: () => call<NetworkStatus>("get_network_status"),
  addManualAddress: (address: string) => call<ManualAddress>("add_manual_address", { address }),
  removeManualAddress: (address: string) => call<null>("remove_manual_address", { address }),
  getFirewallStatus: () => call<FirewallStatus>("get_firewall_status"),
  requestFirewallRule: () => call<{ started: boolean }>("request_firewall_rule"),
  getRejectedChanges: () => call<RejectedChange[]>("get_rejected_changes"),
};

export type MiraEvent = "mira://network" | "mira://directory";

// Berlangganan event dari inti Rust. Isi event tidak dipakai: tampilan cukup
// memuat ulang. Di luar aplikasi desktop (browser biasa, tes) tidak melakukan
// apa pun, dan polling di pemanggil tetap jadi cadangan.
export function subscribe(event: MiraEvent, handler: () => void): () => void {
  if (!isTauri()) return () => {};
  let stopped = false;
  let unlisten: (() => unknown) | null = null;
  // Berhenti berlangganan bisa gagal kalau jendela sedang ditutup; tidak perlu ditampilkan.
  const stop = (fn: () => unknown) => void Promise.resolve().then(fn).catch(() => {});
  try {
    listen(event, () => {
      if (!stopped) handler();
    })
      .then((fn) => {
        if (stopped) stop(fn);
        else unlisten = fn;
      })
      .catch(() => {});
  } catch {
    // listen tidak tersedia: polling tetap berjalan.
  }
  return () => {
    stopped = true;
    if (unlisten) stop(unlisten);
  };
}
