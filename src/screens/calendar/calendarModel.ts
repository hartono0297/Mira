// Logika murni Kalender (docs/plans/sidebar-kalender.md, bagian 2.3).
// Semua tanggal di luar file ini adalah string YYYY-MM-DD waktu lokal. Di dalam,
// hitungan tanggal memakai Date.UTC dan format memakai timeZone "UTC", jadi
// pergantian jam musim panas dan zona waktu laptop tidak menggeser hari.
import type { CalTask } from "../../api/calendar";
import type { Priority } from "../../api/board";
import { getLang, locale, type Lang } from "../../i18n/core";

export type DayKey = string; // "2026-11-24"
export type CalView = "month" | "week" | "agenda";
export type CalFilter = { scope: "mine" | "all" | { project: string }; showDone: boolean };

const DAY_MS = 86_400_000;

type Ymd = { y: number; m: number; d: number }; // m = 1..12

function parse(day: DayKey): Ymd {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) throw new RangeError(`Tanggal tidak sah: ${day}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function key(y: number, m: number, d: number): DayKey {
  return `${String(y).padStart(4, "0")}-${pad(m)}-${pad(d)}`;
}

function toUtc(day: DayKey): Date {
  const { y, m, d } = parse(day);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUtc(date: Date): DayKey {
  return key(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function firstOfMonth(day: DayKey): DayKey {
  const { y, m } = parse(day);
  return key(y, m, 1);
}

function lastOfMonth(day: DayKey): DayKey {
  const { y, m } = parse(day);
  return key(y, m, daysInMonth(y, m));
}

export function todayKey(now: Date = new Date()): DayKey {
  return key(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function addDays(day: DayKey, n: number): DayKey {
  return fromUtc(new Date(toUtc(day).getTime() + n * DAY_MS));
}

// Dijepit ke akhir bulan: 31 Januari + 1 bulan = 28 atau 29 Februari.
export function addMonths(day: DayKey, n: number): DayKey {
  const { y, m, d } = parse(day);
  const index = y * 12 + (m - 1) + n;
  const ny = Math.floor(index / 12);
  const nm = index - ny * 12 + 1;
  return key(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

// Minggu dimulai Senin. getUTCDay: 0 = Minggu.
export function startOfWeek(day: DayKey): DayKey {
  const back = (toUtc(day).getUTCDay() + 6) % 7;
  return addDays(day, -back);
}

export function weekDays(day: DayKey): DayKey[] {
  const monday = startOfWeek(day);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

// Minggu-minggu (Senin dulu) yang menutupi bulan: 4 sampai 6 baris.
export function monthGrid(day: DayKey): DayKey[][] {
  const last = lastOfMonth(day);
  const rows: DayKey[][] = [];
  let monday = startOfWeek(firstOfMonth(day));
  while (monday <= last) {
    rows.push(weekDays(monday));
    monday = addDays(monday, 7);
  }
  return rows;
}

export function sameMonth(a: DayKey, b: DayKey): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

export function rangeFor(view: CalView, anchor: DayKey): { from: DayKey; to: DayKey } {
  if (view === "week") {
    const from = startOfWeek(anchor);
    return { from, to: addDays(from, 6) };
  }
  if (view === "agenda") return { from: firstOfMonth(anchor), to: lastOfMonth(anchor) };
  const grid = monthGrid(anchor);
  return { from: grid[0][0], to: grid[grid.length - 1][6] };
}

const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2, none: 3 };

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// "TES-10" sesudah "TES-2": awalan dibandingkan sebagai teks, nomor sebagai angka.
function compareTaskCode(a: string, b: string): number {
  const ma = /^(.*?)(\d+)$/.exec(a);
  const mb = /^(.*?)(\d+)$/.exec(b);
  if (ma && mb) {
    return compareText(ma[1], mb[1]) || Number(ma[2]) - Number(mb[2]) || compareText(a, b);
  }
  return compareText(a, b);
}

function compareTasks(a: CalTask, b: CalTask): number {
  const doneA = a.task.columnId === "done" ? 1 : 0;
  const doneB = b.task.columnId === "done" ? 1 : 0;
  return (
    doneA - doneB ||
    (PRIORITY_RANK[a.task.priority] ?? 3) - (PRIORITY_RANK[b.task.priority] ?? 3) ||
    compareText(a.projectCode, b.projectCode) ||
    compareTaskCode(a.task.code, b.task.code) ||
    compareText(taskKey(a), taskKey(b))
  );
}

// Task tanpa tenggat dilewati. Urutan per hari: belum selesai dulu, lalu
// prioritas tinggi ke tanpa prioritas, kode proyek, kode task.
export function groupByDay(tasks: CalTask[]): Map<DayKey, CalTask[]> {
  const map = new Map<DayKey, CalTask[]>();
  for (const t of tasks) {
    const due = t.task.due;
    if (!due) continue;
    const list = map.get(due);
    if (list) list.push(t);
    else map.set(due, [t]);
  }
  for (const list of map.values()) list.sort(compareTasks);
  return map;
}

export function applyFilter(tasks: CalTask[], filter: CalFilter, me: string): CalTask[] {
  const { scope, showDone } = filter;
  return tasks.filter((t) => {
    if (!showDone && t.task.columnId === "done") return false;
    if (scope === "all") return true;
    if (scope === "mine") return t.task.assignee?.publicKey === me;
    return t.projectId === scope.project;
  });
}

export function isOverdue(t: CalTask, today: DayKey): boolean {
  const due = t.task.due;
  return !!due && due < today && t.task.columnId !== "done";
}

// Indeks warna 0..7 menurut urutan kode proyek (lalu id), berputar setelah 8.
export function projectColors(projects: { id: string; code: string }[]): Map<string, number> {
  const sorted = [...projects].sort((a, b) => compareText(a.code, b.code) || compareText(a.id, b.id));
  return new Map(sorted.map((p, i) => [p.id, i % 8]));
}

export function taskKey(t: CalTask): string {
  return `${t.projectId}/${t.task.id}`;
}

export function canMoveDue(t: CalTask): boolean {
  return t.task.canEdit === true;
}

// Format. Teks disusun dari bagian-bagian Intl supaya hasilnya sama di semua
// versi ICU (en-GB lama menulis "Monday 24 November 2026" tanpa koma).

function part(day: DayKey, lang: Lang, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale(lang), { ...options, timeZone: "UTC" }).format(toUtc(day));
}

function monthName(day: DayKey, lang: Lang): string {
  return part(day, lang, { month: "long" });
}

function stripDot(text: string): string {
  return text.replace(/\.+$/, "");
}

export function monthTitle(day: DayKey, lang: Lang = getLang()): string {
  return `${monthName(day, lang)} ${parse(day).y}`;
}

// "24 sampai 30 November 2026", "26 Oktober sampai 1 November 2026",
// "29 Desember 2025 sampai 4 Januari 2026". Tanpa tanda pisah.
export function weekTitle(day: DayKey, lang: Lang = getLang()): string {
  const from = startOfWeek(day);
  const to = addDays(from, 6);
  const a = parse(from);
  const b = parse(to);
  const word = lang === "en" ? "to" : "sampai";
  const end = `${b.d} ${monthName(to, lang)} ${b.y}`;
  if (a.y !== b.y) return `${a.d} ${monthName(from, lang)} ${a.y} ${word} ${end}`;
  if (a.m !== b.m) return `${a.d} ${monthName(from, lang)} ${word} ${end}`;
  return `${a.d} ${word} ${end}`;
}

// 7 nama hari pendek, Senin dulu: "Sen".."Min" / "Mon".."Sun".
export function weekdayShort(lang: Lang = getLang()): string[] {
  // 2026-11-23 adalah Senin.
  return weekDays("2026-11-23").map((d) => stripDot(part(d, lang, { weekday: "short" })));
}

// "Senin, 24 November 2026" / "Monday, 24 November 2026".
export function dayLong(day: DayKey, lang: Lang = getLang()): string {
  const { y, d } = parse(day);
  const weekday = stripDot(part(day, lang, { weekday: "long" }));
  return `${weekday}, ${d} ${monthName(day, lang)} ${y}`;
}

export function dayNumber(day: DayKey): string {
  return String(parse(day).d);
}
