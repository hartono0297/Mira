import { describe, expect, it } from "vitest";
import type { CalTask } from "../../api/calendar";
import type { ColumnId, TaskCard } from "../../api/board";
import { setLang } from "../../i18n/core";
import {
  addDays,
  addMonths,
  applyFilter,
  canMoveDue,
  dayLong,
  dayNumber,
  groupByDay,
  isOverdue,
  monthGrid,
  monthTitle,
  projectColors,
  rangeFor,
  sameMonth,
  startOfWeek,
  taskKey,
  todayKey,
  weekDays,
  weekdayShort,
  weekTitle,
} from "./calendarModel";

const ME = "kunci-saya";
const ORANG_LAIN = "kunci-lain";

function card(over: Partial<TaskCard> = {}): TaskCard {
  return {
    id: "t1",
    code: "TES-1",
    title: "Laporan",
    columnId: "todo",
    assignee: null,
    due: "2026-11-24",
    priority: "none",
    labels: [],
    commentCount: 0,
    merged: false,
    subtaskDone: 0,
    subtaskTotal: 0,
    trackedSecs: 0,
    timersRunningSince: [],
    ...over,
  };
}

function task(
  over: Partial<TaskCard> & { projectId?: string; projectCode?: string; projectName?: string } = {},
): CalTask {
  const { projectId = "p1", projectCode = "TES", projectName = "Tes", ...rest } = over;
  return { projectId, projectCode, projectName, task: card(rest) };
}

const codes = (list: CalTask[] | undefined) => (list ?? []).map((t) => t.task.code);

describe("todayKey", () => {
  it("memakai tanggal lokal, bukan UTC", () => {
    expect(todayKey(new Date(2026, 10, 24, 0, 5))).toBe("2026-11-24");
    expect(todayKey(new Date(2026, 10, 24, 23, 59))).toBe("2026-11-24");
    expect(todayKey(new Date(2027, 0, 1, 0, 0, 1))).toBe("2027-01-01");
  });

  it("menulis bulan dan hari dengan dua angka", () => {
    expect(todayKey(new Date(2026, 0, 5, 12))).toBe("2026-01-05");
  });

  it("tanpa argumen memakai waktu sekarang", () => {
    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    expect(todayKey()).toBe(expected);
  });
});

describe("addDays", () => {
  it("maju dan mundur dalam bulan", () => {
    expect(addDays("2026-11-24", 1)).toBe("2026-11-25");
    expect(addDays("2026-11-24", -1)).toBe("2026-11-23");
    expect(addDays("2026-11-24", 0)).toBe("2026-11-24");
  });

  it("melewati akhir bulan dan akhir tahun", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
    expect(addDays("2026-12-29", 7)).toBe("2027-01-05");
  });

  it("melewati 29 Februari di tahun kabisat", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2028-02-29", 1)).toBe("2028-03-01");
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
  });

  it("tidak bergeser di sekitar pergantian jam musim panas Eropa dan Amerika", () => {
    expect(addDays("2026-03-28", 1)).toBe("2026-03-29");
    expect(addDays("2026-03-29", 1)).toBe("2026-03-30");
    expect(addDays("2026-03-07", 2)).toBe("2026-03-09");
    expect(addDays("2026-10-24", 2)).toBe("2026-10-26");
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
    expect(addDays("2026-03-01", 30)).toBe("2026-03-31");
  });

  it("lompatan besar", () => {
    expect(addDays("2026-01-01", 365)).toBe("2027-01-01");
    expect(addDays("2028-01-01", 366)).toBe("2029-01-01");
  });
});

describe("addMonths", () => {
  it("maju dan mundur biasa", () => {
    expect(addMonths("2026-11-24", 1)).toBe("2026-12-24");
    expect(addMonths("2026-11-24", -1)).toBe("2026-10-24");
    expect(addMonths("2026-11-24", 0)).toBe("2026-11-24");
  });

  it("melewati batas tahun", () => {
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-15");
    expect(addMonths("2026-11-15", 14)).toBe("2028-01-15");
    expect(addMonths("2026-02-15", -14)).toBe("2024-12-15");
  });

  it("dijepit ke akhir bulan", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-03-31", 1)).toBe("2026-04-30");
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonths("2026-05-31", -1)).toBe("2026-04-30");
    expect(addMonths("2028-02-29", 12)).toBe("2029-02-28");
  });
});

describe("startOfWeek dan weekDays", () => {
  it("Senin tetap Senin", () => {
    expect(startOfWeek("2026-11-23")).toBe("2026-11-23");
  });

  it("hari biasa mundur ke Senin", () => {
    expect(startOfWeek("2026-11-24")).toBe("2026-11-23");
    expect(startOfWeek("2026-11-28")).toBe("2026-11-23");
  });

  it("Minggu ikut minggu yang dimulai Senin sebelumnya", () => {
    expect(startOfWeek("2026-11-29")).toBe("2026-11-23");
    expect(startOfWeek("2026-11-01")).toBe("2026-10-26");
  });

  it("melewati batas tahun", () => {
    expect(startOfWeek("2026-01-01")).toBe("2025-12-29");
    expect(startOfWeek("2027-01-03")).toBe("2026-12-28");
  });

  it("weekDays memberi 7 hari Senin sampai Minggu", () => {
    expect(weekDays("2026-11-26")).toEqual([
      "2026-11-23",
      "2026-11-24",
      "2026-11-25",
      "2026-11-26",
      "2026-11-27",
      "2026-11-28",
      "2026-11-29",
    ]);
    expect(weekDays("2026-01-01")).toEqual([
      "2025-12-29",
      "2025-12-30",
      "2025-12-31",
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
    ]);
  });
});

describe("monthGrid", () => {
  function checkShape(grid: string[][], month: string) {
    for (const row of grid) {
      expect(row).toHaveLength(7);
      expect(startOfWeek(row[0])).toBe(row[0]);
      for (let i = 1; i < 7; i++) expect(row[i]).toBe(addDays(row[i - 1], 1));
    }
    for (let r = 1; r < grid.length; r++) expect(grid[r][0]).toBe(addDays(grid[r - 1][6], 1));
    const flat = grid.flat();
    expect(flat.some((d) => d === `${month}-01`)).toBe(true);
    // Baris pertama dan terakhir memuat hari bulan ini (tidak ada baris kosong).
    expect(grid[0].some((d) => d.startsWith(month))).toBe(true);
    expect(grid[grid.length - 1].some((d) => d.startsWith(month))).toBe(true);
  }

  it("bulan yang dimulai Senin dan berisi 28 hari: 4 baris (Februari 2021)", () => {
    const grid = monthGrid("2021-02-10");
    expect(grid).toHaveLength(4);
    expect(grid[0][0]).toBe("2021-02-01");
    expect(grid[3][6]).toBe("2021-02-28");
    checkShape(grid, "2021-02");
  });

  it("bulan yang dimulai Senin: 5 baris (Juni 2026)", () => {
    const grid = monthGrid("2026-06-30");
    expect(grid).toHaveLength(5);
    expect(grid[0][0]).toBe("2026-06-01");
    expect(grid[4][6]).toBe("2026-07-05");
    checkShape(grid, "2026-06");
  });

  it("Februari tahun biasa yang dimulai Minggu: 5 baris (Februari 2026)", () => {
    const grid = monthGrid("2026-02-01");
    expect(grid).toHaveLength(5);
    expect(grid[0][0]).toBe("2026-01-26");
    expect(grid[0][6]).toBe("2026-02-01");
    expect(grid[4][6]).toBe("2026-03-01");
    checkShape(grid, "2026-02");
  });

  it("Februari kabisat yang dimulai Senin: 5 baris (Februari 2016)", () => {
    const grid = monthGrid("2016-02-29");
    expect(grid).toHaveLength(5);
    expect(grid[0][0]).toBe("2016-02-01");
    expect(grid[4][0]).toBe("2016-02-29");
    expect(grid[4][6]).toBe("2016-03-06");
    checkShape(grid, "2016-02");
  });

  it("Februari kabisat 2028 memuat tanggal 29", () => {
    const grid = monthGrid("2028-02-01");
    expect(grid.flat()).toContain("2028-02-29");
    checkShape(grid, "2028-02");
  });

  it("bulan 31 hari yang dimulai Minggu: 6 baris (Maret 2026)", () => {
    const grid = monthGrid("2026-03-15");
    expect(grid).toHaveLength(6);
    expect(grid[0][0]).toBe("2026-02-23");
    expect(grid[0][6]).toBe("2026-03-01");
    expect(grid[5][6]).toBe("2026-04-05");
    checkShape(grid, "2026-03");
  });

  it("bulan yang dimulai Sabtu: 6 baris (Agustus 2026)", () => {
    const grid = monthGrid("2026-08-01");
    expect(grid).toHaveLength(6);
    expect(grid[0][0]).toBe("2026-07-27");
    checkShape(grid, "2026-08");
  });

  it("November 2026 (dimulai Minggu, 30 hari): 6 baris", () => {
    const grid = monthGrid("2026-11-24");
    expect(grid).toHaveLength(6);
    expect(grid[0][0]).toBe("2026-10-26");
    expect(grid[5][6]).toBe("2026-12-06");
    checkShape(grid, "2026-11");
  });

  it("melewati batas tahun (Januari 2026 dan Desember 2026)", () => {
    const jan = monthGrid("2026-01-31");
    expect(jan[0][0]).toBe("2025-12-29");
    expect(jan).toHaveLength(5);
    checkShape(jan, "2026-01");
    const dec = monthGrid("2026-12-01");
    expect(dec[0][0]).toBe("2026-11-30");
    expect(dec[dec.length - 1][6]).toBe("2027-01-03");
    checkShape(dec, "2026-12");
  });

  it("selalu 4 sampai 6 baris untuk setiap bulan 2024 sampai 2030", () => {
    for (let y = 2024; y <= 2030; y++) {
      for (let m = 1; m <= 12; m++) {
        const month = `${y}-${String(m).padStart(2, "0")}`;
        const grid = monthGrid(`${month}-15`);
        expect(grid.length).toBeGreaterThanOrEqual(4);
        expect(grid.length).toBeLessThanOrEqual(6);
        checkShape(grid, month);
      }
    }
  });
});

describe("sameMonth", () => {
  it("membandingkan tahun dan bulan", () => {
    expect(sameMonth("2026-11-01", "2026-11-30")).toBe(true);
    expect(sameMonth("2026-11-30", "2026-12-01")).toBe(false);
    expect(sameMonth("2025-11-24", "2026-11-24")).toBe(false);
  });
});

describe("rangeFor", () => {
  it("month = sel grid pertama sampai terakhir", () => {
    expect(rangeFor("month", "2026-11-24")).toEqual({ from: "2026-10-26", to: "2026-12-06" });
    expect(rangeFor("month", "2021-02-14")).toEqual({ from: "2021-02-01", to: "2021-02-28" });
  });

  it("week = Senin sampai Minggu", () => {
    expect(rangeFor("week", "2026-11-24")).toEqual({ from: "2026-11-23", to: "2026-11-29" });
    expect(rangeFor("week", "2026-11-29")).toEqual({ from: "2026-11-23", to: "2026-11-29" });
    expect(rangeFor("week", "2026-01-01")).toEqual({ from: "2025-12-29", to: "2026-01-04" });
  });

  it("agenda = tanggal 1 sampai akhir bulan", () => {
    expect(rangeFor("agenda", "2026-11-24")).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(rangeFor("agenda", "2026-02-10")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(rangeFor("agenda", "2028-02-10")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(rangeFor("agenda", "2026-12-31")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });
});

describe("groupByDay", () => {
  it("mengelompokkan menurut tenggat dan melewati task tanpa tenggat", () => {
    const map = groupByDay([
      task({ id: "a", code: "TES-1", due: "2026-11-24" }),
      task({ id: "b", code: "TES-2", due: "2026-11-25" }),
      task({ id: "c", code: "TES-3", due: null }),
      task({ id: "d", code: "TES-4", due: "2026-11-24" }),
    ]);
    expect([...map.keys()].sort()).toEqual(["2026-11-24", "2026-11-25"]);
    expect(codes(map.get("2026-11-24"))).toEqual(["TES-1", "TES-4"]);
    expect(codes(map.get("2026-11-25"))).toEqual(["TES-2"]);
  });

  it("daftar kosong memberi Map kosong", () => {
    expect(groupByDay([]).size).toBe(0);
  });

  it("belum selesai dulu, lalu prioritas, kode proyek, kode task", () => {
    const due = "2026-11-24";
    const list: CalTask[] = [
      task({ id: "1", code: "TES-1", columnId: "done", priority: "high", due }),
      task({ id: "2", code: "TES-2", priority: "none", due }),
      task({ id: "3", code: "TES-3", priority: "low", due }),
      task({ id: "4", code: "TES-4", priority: "medium", due }),
      task({ id: "5", code: "TES-5", priority: "high", due }),
      task({ id: "6", code: "ABC-9", priority: "high", due, projectId: "p2", projectCode: "ABC" }),
      task({ id: "7", code: "TES-6", columnId: "doing", priority: "high", due }),
      task({ id: "8", code: "TES-7", columnId: "done", priority: "none", due }),
    ];
    expect(codes(groupByDay(list).get(due))).toEqual([
      "ABC-9",
      "TES-5",
      "TES-6",
      "TES-4",
      "TES-3",
      "TES-2",
      "TES-1",
      "TES-7",
    ]);
  });

  it("nomor task dibandingkan sebagai angka", () => {
    const due = "2026-11-24";
    const list = ["TES-10", "TES-2", "TES-100", "TES-1"].map((code, i) => task({ id: `t${i}`, code, due }));
    expect(codes(groupByDay(list).get(due))).toEqual(["TES-1", "TES-2", "TES-10", "TES-100"]);
  });

  it("tidak mengubah daftar masukan", () => {
    const list = [task({ id: "a", code: "TES-2" }), task({ id: "b", code: "TES-1" })];
    groupByDay(list);
    expect(codes(list)).toEqual(["TES-2", "TES-1"]);
  });
});

describe("applyFilter", () => {
  const mine = task({ id: "m", code: "TES-1", assignee: { publicKey: ME, name: "Saya" } });
  const theirs = task({ id: "o", code: "TES-2", assignee: { publicKey: ORANG_LAIN, name: "Rina" } });
  const nobody = task({ id: "n", code: "TES-3", assignee: null });
  const mineDone = task({ id: "md", code: "TES-4", columnId: "done", assignee: { publicKey: ME, name: "Saya" } });
  const other = task({ id: "x", code: "ABC-1", projectId: "p2", projectCode: "ABC", assignee: { publicKey: ME, name: "Saya" } });
  const otherDone = task({ id: "xd", code: "ABC-2", projectId: "p2", projectCode: "ABC", columnId: "done" });
  const all = [mine, theirs, nobody, mineDone, other, otherDone];

  it("mine: hanya task yang ditugaskan ke saya", () => {
    expect(codes(applyFilter(all, { scope: "mine", showDone: false }, ME))).toEqual(["TES-1", "ABC-1"]);
    expect(codes(applyFilter(all, { scope: "mine", showDone: true }, ME))).toEqual(["TES-1", "TES-4", "ABC-1"]);
  });

  it("mine dengan kunci kosong tidak cocok dengan task tanpa penanggung", () => {
    expect(applyFilter([nobody], { scope: "mine", showDone: true }, "")).toEqual([]);
  });

  it("all: semua proyek", () => {
    expect(codes(applyFilter(all, { scope: "all", showDone: false }, ME))).toEqual(["TES-1", "TES-2", "TES-3", "ABC-1"]);
    expect(applyFilter(all, { scope: "all", showDone: true }, ME)).toHaveLength(all.length);
  });

  it("satu proyek", () => {
    expect(codes(applyFilter(all, { scope: { project: "p2" }, showDone: false }, ME))).toEqual(["ABC-1"]);
    expect(codes(applyFilter(all, { scope: { project: "p2" }, showDone: true }, ME))).toEqual(["ABC-1", "ABC-2"]);
    expect(applyFilter(all, { scope: { project: "tidak-ada" }, showDone: true }, ME)).toEqual([]);
  });

  it("showDone false hanya menyembunyikan kolom done", () => {
    const cols: ColumnId[] = ["todo", "doing", "done"];
    const list = cols.map((columnId, i) => task({ id: `c${i}`, code: `TES-${i + 1}`, columnId }));
    expect(codes(applyFilter(list, { scope: "all", showDone: false }, ME))).toEqual(["TES-1", "TES-2"]);
  });
});

describe("isOverdue", () => {
  const today = "2026-11-24";
  it("tenggat sebelum hari ini dan belum selesai", () => {
    expect(isOverdue(task({ due: "2026-11-23" }), today)).toBe(true);
    expect(isOverdue(task({ due: "2025-12-31", columnId: "doing" }), today)).toBe(true);
  });

  it("hari ini dan nanti bukan lewat tenggat", () => {
    expect(isOverdue(task({ due: today }), today)).toBe(false);
    expect(isOverdue(task({ due: "2026-11-25" }), today)).toBe(false);
  });

  it("task selesai tidak pernah lewat tenggat", () => {
    expect(isOverdue(task({ due: "2026-11-01", columnId: "done" }), today)).toBe(false);
  });

  it("task tanpa tenggat bukan lewat tenggat", () => {
    expect(isOverdue(task({ due: null }), today)).toBe(false);
  });
});

describe("projectColors", () => {
  it("indeks menurut urutan kode, bukan urutan masukan", () => {
    const colors = projectColors([
      { id: "p3", code: "ZED" },
      { id: "p1", code: "ABC" },
      { id: "p2", code: "MIR" },
    ]);
    expect(colors.get("p1")).toBe(0);
    expect(colors.get("p2")).toBe(1);
    expect(colors.get("p3")).toBe(2);
  });

  it("stabil untuk urutan masukan berbeda", () => {
    const list = [
      { id: "a", code: "TES" },
      { id: "b", code: "ABC" },
      { id: "c", code: "KOP" },
    ];
    const one = projectColors(list);
    const two = projectColors([...list].reverse());
    expect([...two.entries()].sort()).toEqual([...one.entries()].sort());
  });

  it("kode sama diurutkan menurut id", () => {
    const colors = projectColors([
      { id: "z", code: "TES" },
      { id: "a", code: "TES" },
    ]);
    expect(colors.get("a")).toBe(0);
    expect(colors.get("z")).toBe(1);
  });

  it("berputar setelah 8 warna", () => {
    const list = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, code: `P${String(i).padStart(2, "0")}` }));
    const colors = projectColors(list);
    expect(colors.get("p0")).toBe(0);
    expect(colors.get("p7")).toBe(7);
    expect(colors.get("p8")).toBe(0);
    expect(colors.get("p9")).toBe(1);
    for (const v of colors.values()) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(7);
    }
  });

  it("daftar kosong memberi Map kosong", () => {
    expect(projectColors([]).size).toBe(0);
  });
});

describe("taskKey dan canMoveDue", () => {
  it("taskKey = proyek/id", () => {
    expect(taskKey(task({ id: "t9", projectId: "p5" }))).toBe("p5/t9");
  });

  it("canMoveDue hanya kalau canEdit true", () => {
    expect(canMoveDue(task({ canEdit: true }))).toBe(true);
    expect(canMoveDue(task({ canEdit: false }))).toBe(false);
    expect(canMoveDue(task())).toBe(false);
  });
});

describe("format tanggal", () => {
  it("monthTitle", () => {
    expect(monthTitle("2026-11-24", "id")).toBe("November 2026");
    expect(monthTitle("2026-11-24", "en")).toBe("November 2026");
    expect(monthTitle("2026-01-01", "id")).toBe("Januari 2026");
    expect(monthTitle("2026-01-01", "en")).toBe("January 2026");
    expect(monthTitle("2026-08-31", "id")).toBe("Agustus 2026");
    expect(monthTitle("2026-12-31", "id")).toBe("Desember 2026");
  });

  it("monthTitle mengikuti bahasa aktif tanpa argumen", () => {
    setLang("id");
    expect(monthTitle("2026-05-01")).toBe("Mei 2026");
    setLang("en");
    expect(monthTitle("2026-05-01")).toBe("May 2026");
  });

  it("weekTitle dalam satu bulan", () => {
    expect(weekTitle("2025-11-26", "id")).toBe("24 sampai 30 November 2025");
    expect(weekTitle("2025-11-26", "en")).toBe("24 to 30 November 2025");
    expect(weekTitle("2026-11-24", "id")).toBe("23 sampai 29 November 2026");
  });

  it("weekTitle melewati bulan dalam tahun yang sama", () => {
    expect(weekTitle("2026-11-01", "id")).toBe("26 Oktober sampai 1 November 2026");
    expect(weekTitle("2026-11-01", "en")).toBe("26 October to 1 November 2026");
  });

  it("weekTitle melewati tahun", () => {
    expect(weekTitle("2026-01-01", "id")).toBe("29 Desember 2025 sampai 4 Januari 2026");
    expect(weekTitle("2026-01-01", "en")).toBe("29 December 2025 to 4 January 2026");
  });

  it("weekTitle tidak memakai tanda pisah", () => {
    for (const lang of ["id", "en"] as const) {
      for (const day of ["2026-11-24", "2026-11-01", "2026-01-01"]) {
        expect(weekTitle(day, lang)).not.toMatch(/[–—-]/);
      }
    }
  });

  it("weekTitle mengikuti bahasa aktif tanpa argumen", () => {
    setLang("en");
    expect(weekTitle("2026-11-24")).toBe("23 to 29 November 2026");
  });

  it("weekdayShort: 7 nama, Senin dulu, tanpa titik", () => {
    expect(weekdayShort("id")).toEqual(["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"]);
    expect(weekdayShort("en")).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    setLang("en");
    expect(weekdayShort()[0]).toBe("Mon");
  });

  it("dayLong", () => {
    expect(dayLong("2025-11-24", "id")).toBe("Senin, 24 November 2025");
    expect(dayLong("2025-11-24", "en")).toBe("Monday, 24 November 2025");
    expect(dayLong("2026-11-28", "id")).toBe("Sabtu, 28 November 2026");
    expect(dayLong("2026-11-29", "en")).toBe("Sunday, 29 November 2026");
    expect(dayLong("2026-01-01", "id")).toBe("Kamis, 1 Januari 2026");
    expect(dayLong("2028-02-29", "en")).toBe("Tuesday, 29 February 2028");
    setLang("en");
    expect(dayLong("2026-11-27")).toBe("Friday, 27 November 2026");
  });

  it("dayNumber tanpa nol di depan", () => {
    expect(dayNumber("2026-11-24")).toBe("24");
    expect(dayNumber("2026-11-01")).toBe("1");
    expect(dayNumber("2026-12-09")).toBe("9");
  });

  it("format tidak bergeser oleh zona waktu: hari pertama dan terakhir tetap", () => {
    expect(dayLong("2026-03-01", "id")).toBe("Minggu, 1 Maret 2026");
    expect(monthTitle("2026-03-01", "en")).toBe("March 2026");
    expect(monthTitle("2026-03-31", "en")).toBe("March 2026");
  });
});
