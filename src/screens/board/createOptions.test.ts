import { describe, expect, it } from "vitest";
import type { DepartmentView, OrgOverview, PersonView } from "../../api/org";
import { createOptions } from "./createOptions";

const ME = "a".repeat(64);
const DEP_DESAIN = "1".repeat(32);
const DEP_ARSIP = "2".repeat(32);
const DEP_ADM = "3".repeat(32);

function overview(extra: Partial<OrgOverview> = {}): OrgOverview {
  return {
    publicKey: ME,
    isSuperadmin: false,
    isGuest: false,
    departmentId: DEP_DESAIN,
    decideJoinTeamIds: [],
    pendingJoinCount: 0,
    manageOrg: false,
    listUsers: false,
    ...extra,
  };
}

function person(extra: Partial<PersonView> = {}): PersonView {
  return {
    publicKey: ME,
    displayName: "Penguji",
    fingerprint: "AAAA AAAA AAAA AAAA",
    role: "member",
    isSuperadmin: false,
    isGuest: false,
    departmentId: DEP_DESAIN,
    departmentName: "Desain",
    departmentRole: "member",
    labels: [],
    ...extra,
  };
}

function dep(id: string, name: string, archived = false): DepartmentView {
  return {
    id,
    name,
    createdAt: "2026-11-22T03:00:00Z",
    archived,
    archivedAt: archived ? "2026-11-22T04:00:00Z" : null,
    memberCount: 1,
    admins: [],
    channelId: null,
    channelName: null,
  };
}

const departments = [dep(DEP_DESAIN, "Desain"), dep(DEP_ARSIP, "Arsip Lama", true), dep(DEP_ADM, "Administrasi")];

describe("createOptions", () => {
  it("superadmin: semua departemen terbuka urut nama, tanpa departemen boleh, bawaan departemen saya", () => {
    const o = createOptions(
      overview({ isSuperadmin: true }),
      [person({ isSuperadmin: true, role: "superadmin" })],
      departments,
    );
    expect(o.canCreate).toBe(true);
    expect(o.departments.map((d) => d.name)).toEqual(["Administrasi", "Desain"]);
    expect(o.allowNoDepartment).toBe(true);
    expect(o.defaultDepartment).toBe(DEP_DESAIN);
    expect(o.me).toBe(ME);
  });

  it("superadmin tanpa departemen: bawaan departemen pertama", () => {
    const o = createOptions(
      overview({ isSuperadmin: true, departmentId: null }),
      [
        person({
          isSuperadmin: true,
          departmentId: null,
          departmentName: null,
          departmentRole: null,
        }),
      ],
      departments,
    );
    expect(o.defaultDepartment).toBe(DEP_ADM);
  });

  it("admin departemen: hanya departemennya sendiri, ditambah tanpa departemen", () => {
    const o = createOptions(overview(), [person({ departmentRole: "admin" })], departments);
    expect(o.canCreate).toBe(true);
    expect(o.departments).toEqual([{ id: DEP_DESAIN, name: "Desain" }]);
    expect(o.allowNoDepartment).toBe(true);
    expect(o.defaultDepartment).toBe(DEP_DESAIN);
  });

  it("admin departemen yang departemennya diarsipkan: hanya tanpa departemen", () => {
    const o = createOptions(
      overview({ departmentId: DEP_ARSIP }),
      [
        person({
          departmentId: DEP_ARSIP,
          departmentName: "Arsip Lama",
          departmentRole: "admin",
        }),
      ],
      departments,
    );
    expect(o.canCreate).toBe(true);
    expect(o.departments).toEqual([]);
    expect(o.allowNoDepartment).toBe(true);
    expect(o.defaultDepartment).toBeNull();
  });

  it("anggota biasa: tidak bisa membuat proyek", () => {
    const o = createOptions(overview(), [person()], departments);
    expect(o).toMatchObject({
      canCreate: false,
      departments: [],
      allowNoDepartment: false,
      defaultDepartment: null,
    });
  });

  it("Tamu: tidak bisa membuat proyek walau tercatat admin", () => {
    const o = createOptions(
      overview({ isGuest: true }),
      [person({ isGuest: true, role: "guest", departmentRole: "admin" })],
      departments,
    );
    expect(o.canCreate).toBe(false);
  });

  it("saya tidak ada di daftar orang: tidak bisa membuat proyek", () => {
    const o = createOptions(overview({ isSuperadmin: true }), [], departments);
    expect(o.canCreate).toBe(false);
  });
});
