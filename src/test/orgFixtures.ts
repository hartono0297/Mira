// Data uji untuk halaman Organisasi v0.3 (src/api/org.ts). Nama, laptop, dan
// alamat jelas buatan, hanya untuk tes.
import type {
  DepartmentView,
  JoinRequestView,
  LabelView,
  OrgOverview,
  PersonView,
  UserView,
} from "../api/org";
import { ME, PK_B, PK_C, PK_D, TEAM_1 } from "./fixtures";

export { ME, PK_B, PK_C, PK_D, TEAM_1 };
export const TEAM_2 = "2".repeat(32);
export const TEAM_3 = "3".repeat(32);
export const LABEL_1 = "4".repeat(32);
export const LABEL_2 = "5".repeat(32);

export function overview(extra: Partial<OrgOverview> = {}): OrgOverview {
  return {
    publicKey: ME,
    isSuperadmin: true,
    isGuest: false,
    departmentId: TEAM_1,
    decideJoinTeamIds: [TEAM_1, TEAM_2],
    pendingJoinCount: 0,
    manageOrg: true,
    ...extra,
  };
}

// Admin departemen TEAM_1, bukan superadmin.
export function adminOverview(extra: Partial<OrgOverview> = {}): OrgOverview {
  return overview({ isSuperadmin: false, manageOrg: false, decideJoinTeamIds: [TEAM_1], ...extra });
}

// Anggota biasa: tidak memutuskan apa pun.
export function memberOverview(extra: Partial<OrgOverview> = {}): OrgOverview {
  return overview({ isSuperadmin: false, manageOrg: false, decideJoinTeamIds: [], ...extra });
}

export function department(id: string, name: string, extra: Partial<DepartmentView> = {}): DepartmentView {
  return {
    id,
    name,
    createdAt: "2026-11-20T03:00:00Z",
    archived: false,
    archivedAt: null,
    memberCount: 0,
    admins: [],
    channelId: `c${id.slice(1)}`,
    channelName: name.toLowerCase().replace(/\s+/g, "-"),
    ...extra,
  };
}

export function person(publicKey: string, displayName: string, extra: Partial<PersonView> = {}): PersonView {
  return {
    publicKey,
    displayName,
    fingerprint: `${publicKey.slice(0, 4).toUpperCase()} 0000 0000 0000`,
    role: "member",
    isSuperadmin: false,
    isGuest: false,
    departmentId: TEAM_1,
    departmentName: "Desain",
    departmentRole: "member",
    labels: [],
    ...extra,
  };
}

export function user(publicKey: string, displayName: string, extra: Partial<UserView> = {}): UserView {
  return {
    ...person(publicKey, displayName),
    status: "active",
    joinedAt: "2026-11-04T02:00:00Z",
    removedAt: null,
    device: { laptop: `LAPTOP-${displayName.toUpperCase()}`, os: "Windows 11 24H2", appVersion: "0.3.0", reportedAt: "2026-11-22T01:00:00Z" },
    lastIp: "192.168.1.23",
    online: true,
    lastSeenAt: null,
    isMe: publicKey === ME,
    guestProjectCount: 0,
    ...extra,
  };
}

export function label(id: string, name: string, memberKeys: string[] = [], extra: Partial<LabelView> = {}): LabelView {
  return { id, name, archived: false, createdAt: "2026-11-21T03:00:00Z", memberKeys, ...extra };
}

export function joinRequest(id: string, displayName: string, extra: Partial<JoinRequestView> = {}): JoinRequestView {
  return {
    id,
    publicKey: id.padEnd(64, "0").slice(0, 64),
    displayName,
    teamId: TEAM_1,
    teamName: "Desain",
    laptop: `LAPTOP-${displayName.toUpperCase()}`,
    os: "Windows 11 24H2",
    appVersion: "0.3.0",
    requestedAt: "2026-11-23T01:55:00Z",
    receivedAt: "2026-11-23T01:55:02Z",
    code: "4F2A 91C0",
    ip: "192.168.1.23",
    seenByName: "Penguji",
    // Permintaan v0.4. Untuk permintaan dari Mira v0.3 berikan note: null, account: null.
    note: "Staf baru, mulai minggu ini.",
    account: displayName.toLowerCase(),
    ad: null,
    requesterOutdated: false,
    ...extra,
  };
}
