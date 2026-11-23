import { describe, expect, it } from "vitest";
import { dueParts, parseDueInput, quickDues } from "./dueText";

// Senin, 23 November 2026.
const MON = new Date(2026, 10, 23, 10, 5);

describe("dueParts", () => {
  it("nama hari, tanggal, dan sisa hari", () => {
    expect(dueParts("2026-11-27", MON)).toEqual({ date: "Jumat, 27 Nov", rel: "4 hari lagi", late: false });
    expect(dueParts("2026-11-23", MON)).toEqual({ date: "Senin, 23 Nov", rel: "hari ini", late: false });
    expect(dueParts("2026-11-24", MON).rel).toBe("besok");
  });

  it("terlambat dan tahun lain", () => {
    expect(dueParts("2026-11-21", MON)).toEqual({ date: "Sabtu, 21 Nov", rel: "terlambat 2 hari", late: true });
    expect(dueParts("2027-01-04", MON).date).toBe("Senin, 4 Jan 2027");
  });
});

describe("quickDues", () => {
  it("dari Senin: Hari ini, Besok, Jumat ini, Senin depan", () => {
    expect(quickDues(MON).map((q) => [q.label, q.iso, q.short])).toEqual([
      ["Hari ini", "2026-11-23", "Sen, 23 Nov"],
      ["Besok", "2026-11-24", "Sel, 24 Nov"],
      ["Jumat ini", "2026-11-27", "Jum, 27 Nov"],
      ["Senin depan", "2026-11-30", "Sen, 30 Nov"],
    ]);
  });

  it("dari Kamis: Jumat besok tidak diulang, Jumat berikutnya disebut Jumat depan", () => {
    const thu = new Date(2026, 10, 26);
    expect(quickDues(thu).map((q) => q.label)).toEqual(["Hari ini", "Besok", "Jumat depan", "Senin depan"]);
    expect(quickDues(thu)[2].iso).toBe("2026-12-04");
  });

  it("dari Minggu: Senin depan sama dengan besok, jadi tidak diulang", () => {
    const sun = new Date(2026, 10, 29);
    expect(quickDues(sun).map((q) => q.label)).toEqual(["Hari ini", "Besok", "Jumat depan"]);
  });
});

describe("parseDueInput", () => {
  it("hari/bulan/tahun dengan berbagai pemisah", () => {
    expect(parseDueInput("27/11/2026")).toEqual({ iso: "2026-11-27", problem: null });
    expect(parseDueInput(" 1-2-2027 ")).toEqual({ iso: "2027-02-01", problem: null });
    expect(parseDueInput("5.12.26")).toEqual({ iso: "2026-12-05", problem: null });
  });

  it("menolak yang kosong, tidak dikenali, atau tidak ada di kalender", () => {
    expect(parseDueInput("").problem).toMatch(/Tulis tanggalnya dulu/);
    expect(parseDueInput("11/27").problem).toMatch(/tidak dikenali/);
    expect(parseDueInput("31/02/2027").problem).toMatch(/tidak ada di kalender/);
    expect(parseDueInput("12/13/2026").problem).toMatch(/tidak ada di kalender/);
  });
});
