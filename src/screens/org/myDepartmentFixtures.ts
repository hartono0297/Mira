// Data uji tab Departemen saya. Nama dan kunci jelas buatan, hanya untuk tes.
import type { DeptMember, DeptOverview, DivisionView } from "../../api/division";
import { ME, PK_B, PK_C, PK_D, TEAM_1, TEAM_2 } from "../../test/orgFixtures";

export const DIV_1 = "7".repeat(32);
export const DIV_2 = "8".repeat(32);
export const DIV_3 = "9".repeat(32);

const EMPTY_SETTINGS = { pinned: "", announce: false, setAt: null, setByName: null };

export function deptMember(publicKey: string, displayName: string, extra: Partial<DeptMember> = {}): DeptMember {
  return {
    publicKey,
    displayName,
    fingerprint: `${publicKey.slice(0, 4).toUpperCase()} 0000 0000 0000`,
    isSuperadmin: false,
    isAdmin: false,
    isMe: publicKey === ME,
    online: false,
    labels: [],
    divisions: [],
    appVersion: "0.6.0",
    ...extra,
  };
}

export function division(id: string, name: string, extra: Partial<DivisionView> = {}): DivisionView {
  return {
    id,
    name,
    archived: false,
    createdAt: "2026-11-24T02:00:00Z",
    members: [],
    canManage: true,
    canEditMembers: true,
    conv: `ch:${id}`,
    settings: EMPTY_SETTINGS,
    ...extra,
  };
}

// Admin departemen TEAM_1 (bukan superadmin). Divisi Mobile berisi Citra (kepala) dan Bayu.
export function deptOverview(extra: Partial<DeptOverview> = {}): DeptOverview {
  return {
    teamId: TEAM_1,
    teamName: "Desain",
    archived: false,
    choices: [{ id: TEAM_1, name: "Desain" }],
    me: { publicKey: ME, isSuperadmin: false, isAdmin: true, headOf: [] },
    canManageDept: true,
    members: [
      deptMember(ME, "Penguji", { isAdmin: true, online: true }),
      deptMember(PK_B, "Bayu", { divisions: [{ id: DIV_1, name: "Mobile", role: "member" }], labels: [{ id: "l1", name: "Drafter" }] }),
      deptMember(PK_C, "Citra", { online: true, divisions: [{ id: DIV_1, name: "Mobile", role: "head" }] }),
      deptMember(PK_D, "Dewi"),
    ],
    divisions: [
      division(DIV_1, "Mobile", {
        members: [
          { publicKey: PK_B, displayName: "Bayu", role: "member" },
          { publicKey: PK_C, displayName: "Citra", role: "head" },
        ],
      }),
      division(DIV_2, "Web"),
      division(DIV_3, "Lama", { archived: true }),
    ],
    projects: [
      {
        id: "p".repeat(32),
        name: "Aplikasi Kasir",
        divisionId: DIV_1,
        divisionName: "Mobile",
        members: [
          { publicKey: PK_B, displayName: "Bayu" },
          { publicKey: PK_C, displayName: "Citra" },
        ],
      },
    ],
    channel: { conv: `c${TEAM_1.slice(1)}`, name: "desain", settings: EMPTY_SETTINGS },
    adminHistory: [
      { at: "2026-11-24T03:00:00Z", byName: "Penguji", targetName: "Citra", admin: true, status: "applied" },
      { at: "2026-11-24T02:00:00Z", byName: "Bayu", targetName: "Penguji", admin: false, status: "rejected" },
    ],
    gate: { open: true, since: "0.6.0", blockers: [] },
    ...extra,
  };
}

// Kepala divisi Mobile, bukan admin departemen.
export function headOverview(extra: Partial<DeptOverview> = {}): DeptOverview {
  const base = deptOverview();
  return {
    ...base,
    me: { publicKey: PK_C, isSuperadmin: false, isAdmin: false, headOf: [DIV_1] },
    canManageDept: false,
    members: base.members.map((m) => ({ ...m, isMe: m.publicKey === PK_C, isAdmin: false })),
    divisions: base.divisions.map((d) => ({
      ...d,
      canManage: false,
      canEditMembers: d.id === DIV_1,
    })),
    adminHistory: [],
    ...extra,
  };
}

export { ME, PK_B, PK_C, PK_D, TEAM_1, TEAM_2 };
