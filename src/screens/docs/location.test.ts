import { describe, expect, it } from "vitest";
import type { ProjectSummary } from "../../api/board";
import { resolveLocation } from "./location";

function project(id: string, code: string, name: string): ProjectSummary {
  return { id, code, name, teamId: "t1", teamName: "Gudang", openCount: 0, taskCount: 0, canManage: false };
}
const gudang = project("p1", "PA", "Gudang");
const kantor = project("p2", "KB", "Kantor Baru");
const remembered = { projectId: "p1", label: "PA Gudang" };

describe("lokasi yang dimuat", () => {
  it("anggota: Pustaka Umum bawaan, proyek yang diingat menunggu daftar proyek", () => {
    expect(resolveLocation(null, null, false, false)).toEqual({ kind: "library" });
    expect(resolveLocation(remembered, null, false, false)).toEqual({ kind: "pending" });
    expect(resolveLocation(remembered, [kantor, gudang], false, false)).toEqual({
      kind: "project",
      id: "p1",
      label: "PA Gudang",
    });
    // Tidak ada lagi di daftar: menunggu efek yang mengembalikan ke Pustaka Umum.
    expect(resolveLocation(remembered, [kantor], false, false)).toEqual({ kind: "pending" });
  });

  it("Tamu: tanpa Pustaka Umum, bawaan proyek pertama", () => {
    expect(resolveLocation(null, null, false, true)).toEqual({ kind: "pending" });
    expect(resolveLocation(null, [kantor, gudang], false, true)).toEqual({
      kind: "project",
      id: "p2",
      label: "KB Kantor Baru",
    });
    expect(resolveLocation(remembered, [kantor, gudang], false, true)).toEqual({
      kind: "project",
      id: "p1",
      label: "PA Gudang",
    });
    expect(resolveLocation(null, [], false, true)).toEqual({ kind: "none" });
    expect(resolveLocation(null, null, true, true)).toEqual({ kind: "unavailable" });
  });
});
