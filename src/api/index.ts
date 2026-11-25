import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ERROR_TEXT, localizeError } from "../i18n/errors";
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
  MembershipCheck,
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

// Semua error yang sampai ke layar dibentuk jadi AppError dengan pesan dalam bahasa aktif.
export function toAppError(value: unknown): AppError {
  if (isAppError(value)) return value;
  const detail = value instanceof Error ? value.message : typeof value === "string" ? value : "";
  return {
    code: "unknown",
    message: detail ? ERROR_TEXT.unknownDetail(detail) : ERROR_TEXT.byCode.unknown,
  };
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// Objek yang sama setiap kali (pemanggil boleh membandingkannya), pesannya
// dibaca saat dipakai supaya mengikuti bahasa aktif.
export const NO_TAURI_ERROR: AppError = {
  code: "no_tauri",
  get message() {
    return ERROR_TEXT.byCode.no_tauri;
  },
};

// Error dari inti Rust diterjemahkan di sini (lihat src/i18n/errors.ts).
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw NO_TAURI_ERROR;
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw localizeError(toAppError(err));
  }
}

export const api = {
  getAppState: () => call<AppState>("get_app_state"),
  // 0.6.0: sinkron log keanggotaan dengan laptop kantor yang tersambung (paling
  // lama 4 detik), lalu laporkan keanggotaan laptop ini. Untuk layar nonaktif.
  checkMembership: () => call<MembershipCheck>("check_membership"),
  // 0.6.0: hanya untuk laptop yang dikeluarkan permanen. Menghapus data
  // organisasi dan kunci laptop ini, membuat kunci baru, kembali ke onboarding.
  resetRemovedLaptop: () => call<AppState>("reset_removed_laptop"),
  saveDisplayName: (name: string) => call<IdentityInfo>("save_display_name", { name }),
  // adDomain: domain Active Directory kantor (onboarding-ad), null atau "" kalau tidak dipakai.
  createOrganization: (name: string, adDomain: string | null = null) =>
    call<OrgInfo>("create_organization", { name, adDomain }),
  // Domain AD tempat PC ini bergabung (huruf kecil), null kalau tidak ada atau bukan Windows.
  machineAdDomain: () => call<string | null>("machine_ad_domain"),
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

// Event sinkron fitur dari laptop rekan (network/feature.rs). Isinya { topic }.
export const FEATURE_EVENT = "mira://feature";
export type FeatureTopic = "docs" | "sign" | (string & {});

// Berlangganan satu event Tauri dengan aman. Di luar aplikasi desktop (browser
// biasa, tes) tidak melakukan apa pun, dan polling atau muat ulang saat fokus
// di pemanggil tetap jadi cadangan.
function listenSafely(event: string, onEvent: (payload: unknown) => void): () => void {
  if (!isTauri()) return () => {};
  let stopped = false;
  let unlisten: (() => unknown) | null = null;
  // Berhenti berlangganan bisa gagal kalau jendela sedang ditutup; tidak perlu ditampilkan.
  const stop = (fn: () => unknown) => void Promise.resolve().then(fn).catch(() => {});
  try {
    listen(event, (e: { payload?: unknown } | undefined) => {
      if (!stopped) onEvent(e?.payload);
    })
      .then((fn) => {
        if (stopped) stop(fn);
        else unlisten = fn;
      })
      .catch(() => {});
  } catch {
    // listen tidak tersedia: cadangan di pemanggil tetap berjalan.
  }
  return () => {
    stopped = true;
    if (unlisten) stop(unlisten);
  };
}

// Berlangganan event dari inti Rust. Isi event tidak dipakai: tampilan cukup memuat ulang.
export function subscribe(event: MiraEvent, handler: () => void): () => void {
  return listenSafely(event, () => handler());
}

// Memuat ulang hanya untuk topik fitur sendiri: perubahan board dari rekan
// tidak membuat layar Dokumen membaca ulang daftarnya.
export function subscribeFeature(topic: FeatureTopic, handler: () => void): () => void {
  return listenSafely(FEATURE_EVENT, (payload) => {
    const got = payload && typeof payload === "object" ? (payload as { topic?: unknown }).topic : undefined;
    if (got === topic) handler();
  });
}
