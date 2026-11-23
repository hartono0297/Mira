// Data uji untuk tes tampilan. Nama dan kunci jelas buatan, hanya untuk tes.
import type {
  AppState,
  Directory,
  FirewallStatus,
  MemberView,
  NetworkStatus,
  OrgInfo,
  PeerView,
} from "../api";

export const ME = "a".repeat(64);
export const PK_B = "b".repeat(64);
export const PK_C = "c".repeat(64);
export const PK_D = "d".repeat(64);
export const TEAM_1 = "1".repeat(32);

export const org: OrgInfo = { id: "e".repeat(32), name: "Kantor Uji", role: "superadmin", createdAt: "2026-11-22T01:05:00Z" };

export function appState(overrides: Partial<AppState> = {}): AppState {
  return {
    identity: { publicKey: ME, fingerprint: "AAAA AAAA AAAA AAAA", displayName: "Penguji", createdAt: "2026-11-22T01:00:00Z" },
    organization: org,
    membership: "active",
    dataDir: "C:\\data\\mira",
    ...overrides,
  };
}

export function member(publicKey: string, displayName: string, extra: Partial<MemberView> = {}): MemberView {
  return {
    publicKey,
    fingerprint: `${publicKey.slice(0, 4).toUpperCase()} 0000 0000 0000`,
    displayName,
    orgRole: "member",
    isSuperadmin: false,
    status: "active",
    joinedAt: "2026-11-22T02:00:00Z",
    teams: [],
    ...extra,
  };
}

export function directory(overrides: Partial<Directory> = {}): Directory {
  return {
    org,
    me: { publicKey: ME, isSuperadmin: true },
    superadminCount: 2,
    can: { createTeam: true, manageSuperadmins: true, removeMembers: true, manageTeamIds: [TEAM_1] },
    members: [
      member(ME, "Penguji", { orgRole: "superadmin", isSuperadmin: true, teams: [{ teamId: TEAM_1, role: "admin" }] }),
      member(PK_B, "Anggota Satu", { teams: [{ teamId: TEAM_1, role: "member" }] }),
      member(PK_C, "Anggota Dua"),
    ],
    teams: [
      {
        id: TEAM_1,
        name: "Tim Uji",
        createdAt: "2026-11-22T03:00:00Z",
        members: [
          { publicKey: ME, role: "admin" },
          { publicKey: PK_B, role: "member" },
        ],
      },
    ],
    invites: [],
    channels: [
      { id: "f".repeat(32), name: "umum", teamId: null },
      { id: "9".repeat(32), name: "tim-uji", teamId: TEAM_1 },
    ],
    ...overrides,
  };
}

export function peer(publicKey: string, displayName: string, extra: Partial<PeerView> = {}): PeerView {
  return {
    publicKey,
    displayName,
    fingerprint: `${publicKey.slice(0, 4).toUpperCase()} 0000 0000 0000`,
    orgRole: "member",
    online: true,
    route: "lan",
    address: "192.168.1.20:47800",
    lastSeenAt: null,
    ...extra,
  };
}

export function network(overrides: Partial<NetworkStatus> = {}): NetworkStatus {
  return {
    state: "lan",
    listenPort: 47800,
    localAddresses: ["192.168.1.10:47800"],
    shareLink: `mira://peer?pk=${ME}&addr=192.168.1.10:47800`,
    qrSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#fff"/></svg>',
    mdns: { ok: true, error: null },
    peers: [],
    manualAddresses: [],
    ...overrides,
  };
}

export function firewall(overrides: Partial<FirewallStatus> = {}): FirewallStatus {
  return {
    platform: "windows",
    supported: true,
    rule: "missing",
    profiles: [{ name: "Jaringan Kantor", category: "private", interfaceAlias: "Wi-Fi" }],
    programPath: "C:\\Program Files\\Mira\\mira.exe",
    adminCommand: 'New-NetFirewallRule -DisplayName "Mira" -Direction Inbound -Protocol UDP -Action Allow',
    detail: null,
    ...overrides,
  };
}

type Handler = (args: Record<string, unknown> | undefined) => unknown;
type Answer = Handler | object | string | number | boolean | null;

// Tiruan invoke: setiap command dijawab dari tabel. Command yang tidak ada
// di tabel dijawab null, seperti command yang tidak mengembalikan apa-apa.
export function router(table: Record<string, Answer>) {
  return async (cmd: string, args?: Record<string, unknown>) => {
    if (!(cmd in table)) return null;
    const entry = table[cmd];
    return typeof entry === "function" ? (entry as Handler)(args) : entry;
  };
}

export function rustError(code: string, message: string) {
  return () => {
    throw { code, message };
  };
}
