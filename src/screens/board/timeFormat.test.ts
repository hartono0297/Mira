import { describe, expect, it } from "vitest";
import type { StatusTime, TimeEntry } from "../../api/board";
import { TEKS } from "./teks";
import {
  cardTrackedSecs,
  formatClock,
  formatDuration,
  formatDurationLong,
  liveStatusSecs,
  myTimer,
  parseMinutes,
  personTimer,
  runningSecs,
} from "./timeFormat";

const NOW = new Date("2026-11-23T10:00:00Z");
const ago = (secs: number) => new Date(NOW.getTime() - secs * 1000).toISOString();

describe("formatDuration", () => {
  it.each([
    [0, "0m"],
    [-5, "0m"],
    [Number.NaN, "0m"],
    [Number.POSITIVE_INFINITY, "0m"],
    [1, "<1m"],
    [59, "<1m"],
    [60, "1m"],
    [45 * 60 + 59, "45m"],
    [3600, "1j"],
    [3 * 3600 + 20 * 60, "3j 20m"],
    [3 * 3600 + 20 * 60 + 59, "3j 20m"],
    [23 * 3600 + 59 * 60, "23j 59m"],
    [86_400, "1hr"],
    [2 * 86_400 + 5 * 3600 + 40 * 60, "2hr 5j"],
    [40 * 86_400, "40hr"],
  ])("%s detik = %s", (secs, text) => {
    expect(formatDuration(secs)).toBe(text);
  });
});

describe("formatDurationLong", () => {
  it.each([
    [0, "0 menit"],
    [30, "kurang dari 1 menit"],
    [45 * 60, "45 menit"],
    [3 * 3600 + 20 * 60, "3 jam 20 menit"],
    [2 * 3600, "2 jam"],
    [2 * 86_400 + 5 * 3600, "2 hari 5 jam"],
  ])("%s detik = %s", (secs, text) => {
    expect(formatDurationLong(secs)).toBe(text);
  });
});

describe("formatClock", () => {
  it.each([
    [0, "00:00:00"],
    [-3, "00:00:00"],
    [Number.NaN, "00:00:00"],
    [42 * 60 + 10, "00:42:10"],
    [3600 + 5, "01:00:05"],
    [123 * 3600 + 4 * 60 + 5, "123:04:05"],
    [59.9, "00:00:59"],
  ])("%s detik = %s", (secs, text) => {
    expect(formatClock(secs)).toBe(text);
  });
});

describe("runningSecs", () => {
  it("menghitung detik penuh sejak waktu mulai", () => {
    expect(runningSecs(ago(90), NOW)).toBe(90);
    expect(runningSecs(ago(90), NOW.getTime() + 500)).toBe(90);
  });

  it("menerima zona waktu lain", () => {
    expect(runningSecs("2026-11-23T16:59:00+07:00", NOW)).toBe(60);
  });

  it("waktu mulai di masa depan (jam laptop berbeda) = 0", () => {
    expect(runningSecs(ago(-120), NOW)).toBe(0);
  });

  it("waktu yang tidak terbaca = 0", () => {
    expect(runningSecs("bukan waktu", NOW)).toBe(0);
    expect(runningSecs("", NOW)).toBe(0);
    expect(runningSecs(ago(60), Number.NaN)).toBe(0);
  });
});

describe("liveStatusSecs", () => {
  const st: StatusTime = {
    closedSecs: { todo: 600, doing: 1200, done: 0 },
    currentColumn: "doing",
    currentSince: ago(300),
    cycleSecs: null,
    clockWarning: false,
  };

  it("menambah selang yang berjalan ke kolom sekarang saja", () => {
    expect(liveStatusSecs(st, NOW)).toEqual({ todo: 600, doing: 1500, done: 0 });
  });

  it("tidak mengubah objek asal", () => {
    liveStatusSecs(st, NOW);
    expect(st.closedSecs.doing).toBe(1200);
  });

  it("selang dari masa depan tidak mengurangi total", () => {
    expect(liveStatusSecs({ ...st, currentSince: ago(-60) }, NOW).doing).toBe(1200);
  });
});

describe("cardTrackedSecs", () => {
  it("tanpa timer berjalan = trackedSecs", () => {
    expect(cardTrackedSecs({ trackedSecs: 4500, timersRunningSince: [] }, NOW)).toBe(4500);
  });

  it("menjumlah semua timer yang berjalan", () => {
    expect(cardTrackedSecs({ trackedSecs: 100, timersRunningSince: [ago(60), ago(240)] }, NOW)).toBe(400);
  });

  it("timer dengan waktu rusak dihitung 0", () => {
    expect(cardTrackedSecs({ trackedSecs: 0, timersRunningSince: ["rusak", ago(-30)] }, NOW)).toBe(0);
  });
});

describe("parseMinutes", () => {
  it.each([
    ["90", 90],
    [" 90 ", 90],
    ["45m", 45],
    ["45 m", 45],
    ["45 menit", 45],
    ["45 mnt", 45],
    ["2j", 120],
    ["2 jam", 120],
    ["1j 30m", 90],
    ["1j30m", 90],
    ["1 jam 30 menit", 90],
    ["1J 30M", 90],
    ["1:30", 90],
    ["0:45", 45],
    ["24:00", 1440],
    ["1,5j", 90],
    ["1.5j", 90],
    ["1,25 jam", 75],
    ["0,33j", 20],
    ["1", 1],
    ["1440", 1440],
  ])("%j = %i menit", (input, minutes) => {
    expect(parseMinutes(input)).toEqual({ minutes, reason: null });
  });

  it.each([
    ["", TEKS.waktu.isian.kosong],
    ["   ", TEKS.waktu.isian.kosong],
    ["0", TEKS.waktu.isian.terlaluSingkat],
    ["0m", TEKS.waktu.isian.terlaluSingkat],
    ["0:00", TEKS.waktu.isian.terlaluSingkat],
    ["1441", TEKS.waktu.isian.terlaluLama],
    ["25j", TEKS.waktu.isian.terlaluLama],
    ["24:01", TEKS.waktu.isian.terlaluLama],
    ["abc", TEKS.waktu.isian.tidakDikenali],
    ["1,5", TEKS.waktu.isian.tidakDikenali],
    ["-30", TEKS.waktu.isian.tidakDikenali],
    ["30m 1j", TEKS.waktu.isian.tidakDikenali],
    ["1:75", TEKS.waktu.isian.tidakDikenali],
    ["2h", TEKS.waktu.isian.tidakDikenali],
    ["1hr", TEKS.waktu.isian.tidakDikenali],
    ["1,5m", TEKS.waktu.isian.tidakDikenali],
  ])("%j ditolak", (input, reason) => {
    expect(parseMinutes(input)).toEqual({ minutes: null, reason });
  });
});

describe("personTimer dan myTimer", () => {
  const ME = "a".repeat(64);
  const OTHER = "b".repeat(64);
  const me = { publicKey: ME, name: "Penguji Satu" };
  const other = { publicKey: OTHER, name: "Sari Uji" };

  function seg(id: string, startAgo: number, endAgo: number | null, extra: Partial<TimeEntry> = {}): TimeEntry {
    return {
      id,
      person: me,
      start: ago(startAgo),
      end: endAgo === null ? null : ago(endAgo),
      manual: false,
      note: "",
      secs: endAgo === null ? 0 : startAgo - endAgo,
      mine: true,
      ...extra,
    };
  }

  it("tanpa catatan: idle, total 0", () => {
    expect(personTimer([], ME, NOW)).toEqual({ state: "idle", running: null, closedSecs: 0, totalSecs: 0 });
  });

  it("hanya catatan manual: tetap idle, tapi total menghitungnya", () => {
    const t = personTimer([seg("m", 7200, 3600, { manual: true })], ME, NOW);
    expect(t.state).toBe("idle");
    expect(t.totalSecs).toBe(3600);
  });

  it("segmen timer berhenti tanpa yang berjalan: paused, total semua segmen termasuk manual", () => {
    const entries = [seg("b", 3000, 1200), seg("a", 9000, 7200), seg("m", 20000, 19400, { manual: true })];
    const t = personTimer(entries, ME, NOW);
    expect(t.state).toBe("paused");
    expect(t.running).toBeNull();
    expect(t.closedSecs).toBe(1800 + 1800 + 600);
    expect(t.totalSecs).toBe(4200);
  });

  it("segmen berjalan: running, total ditambah segmen berjalan sampai now", () => {
    const run = seg("r", 600, null);
    const t = personTimer([run, seg("a", 9000, 7200)], ME, NOW);
    expect(t.state).toBe("running");
    expect(t.running).toBe(run);
    expect(t.closedSecs).toBe(1800);
    expect(t.totalSecs).toBe(2400);
    // now bertambah 1 menit.
    expect(personTimer([run], ME, NOW.getTime() + 60_000).totalSecs).toBe(660);
  });

  it("dua segmen berjalan: keduanya dihitung, running = yang paling baru dimulai", () => {
    const old = seg("old", 3600, null);
    const fresh = seg("new", 300, null);
    const t = personTimer([old, fresh], ME, NOW);
    expect(t.running).toBe(fresh);
    expect(t.totalSecs).toBe(3900);
  });

  it("catatan orang lain tidak dihitung", () => {
    const entries = [seg("o", 600, null, { person: other, mine: false }), seg("o2", 9000, 7200, { person: other })];
    expect(personTimer(entries, ME, NOW).state).toBe("idle");
    expect(personTimer(entries, OTHER, NOW)).toMatchObject({ state: "running", closedSecs: 1800, totalSecs: 2400 });
  });

  it("detik yang tidak masuk akal dibersihkan", () => {
    const t = personTimer([seg("x", 100, 50, { secs: Number.NaN }), seg("y", 100, 50, { secs: -5 })], ME, NOW);
    expect(t).toMatchObject({ state: "paused", totalSecs: 0 });
  });

  it("myTimer memakai timeEntries task untuk orang `me`", () => {
    const task = { timeEntries: [seg("a", 9000, 7200), seg("o", 600, null, { person: other })] };
    expect(myTimer(task, ME, NOW)).toMatchObject({ state: "paused", totalSecs: 1800 });
    expect(myTimer(task, OTHER, NOW)).toMatchObject({ state: "running", totalSecs: 600 });
  });
});
