// Tenggat di dialog detail task: teks "Jumat, 27 Nov" dengan sisa hari,
// pilihan cepat, dan isian hari/bulan/tahun (pengganti kolom tanggal bawaan
// yang memakai format Amerika di sebagian laptop).
import { daysUntil, todayIso } from "./format";
import { TEKS_DIALOG, teksDialog } from "./teksDialog";

const DAYS = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
const DAYS_SHORT = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

function parseIso(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

function addDays(base: Date, n: number): Date {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  d.setDate(d.getDate() + n);
  return d;
}

function dayMonth(d: Date, now: Date): string {
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

export type DueParts = { date: string; rel: string; late: boolean };

// "Jumat, 27 Nov" dan "4 hari lagi". Tahun ditulis kalau beda dari tahun ini.
export function dueParts(iso: string, now: Date = new Date()): DueParts {
  const d = parseIso(iso);
  const n = daysUntil(iso, now);
  if (!d || n === null) return { date: iso, rel: "", late: false };
  return { date: `${DAYS[d.getDay()]}, ${dayMonth(d, now)}`, rel: teksDialog.sisaHari(n), late: n < 0 };
}

export type QuickDue = { key: string; label: string; iso: string; short: string };

// Hari ini, Besok, Jumat terdekat setelah besok, Senin depan. Tanggal yang sama tidak diulang.
export function quickDues(now: Date = new Date()): QuickDue[] {
  const today = addDays(now, 0);
  const daysTo = (weekday: number, from: number) => {
    let n = from;
    while (addDays(today, n).getDay() !== weekday) n++;
    return n;
  };
  const fri = daysTo(5, 2);
  // Minggu dihitung Senin sampai Minggu: Jumat yang masih di minggu ini disebut "Jumat ini".
  const toSunday = (7 - today.getDay()) % 7;
  const list = [
    { key: "today", label: TEKS_DIALOG.hariIni, n: 0 },
    { key: "tomorrow", label: TEKS_DIALOG.besok, n: 1 },
    { key: "friday", label: fri <= toSunday ? TEKS_DIALOG.jumatIni : TEKS_DIALOG.jumatDepan, n: fri },
    { key: "monday", label: TEKS_DIALOG.seninDepan, n: daysTo(1, 1) },
  ];
  const seen = new Set<string>();
  const out: QuickDue[] = [];
  for (const item of list) {
    const d = addDays(today, item.n);
    const iso = todayIso(d);
    if (seen.has(iso)) continue;
    seen.add(iso);
    out.push({ key: item.key, label: item.label, iso, short: `${DAYS_SHORT[d.getDay()]}, ${dayMonth(d, now)}` });
  }
  return out;
}

export type ParsedDue = { iso: string; problem: null } | { iso: null; problem: string };

// "27/11/2026", "27-11-2026", "27.11.26", "1/2/2027". Tahun dua angka = 20xx.
export function parseDueInput(input: string): ParsedDue {
  const text = input.trim();
  if (!text) return { iso: null, problem: TEKS_DIALOG.tanggalKosong };
  const m = /^(\d{1,2})\s*[/.\-\s]\s*(\d{1,2})\s*[/.\-\s]\s*(\d{2}|\d{4})$/.exec(text);
  if (!m) return { iso: null, problem: TEKS_DIALOG.tanggalSalah };
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  if (year < 2000 || year > 2100) return { iso: null, problem: TEKS_DIALOG.tanggalSalah };
  const d = new Date(year, month - 1, day);
  if (month < 1 || month > 12 || d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    return { iso: null, problem: TEKS_DIALOG.tanggalTidakAda };
  }
  return { iso: todayIso(d), problem: null };
}
