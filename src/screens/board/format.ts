// Teks dan tanggal yang dipakai bersama layar board, detail task, dan Task saya.
import type { ColumnId, Priority } from "../../api/board";

export const COLUMN_NAMES: Record<ColumnId, string> = {
  todo: "To do",
  doing: "Dikerjakan",
  done: "Selesai",
};

export const COLUMN_ORDER: ColumnId[] = ["todo", "doing", "done"];

export const PRIORITY_LABELS: Record<Priority, string> = {
  none: "Tanpa prioritas",
  low: "Rendah",
  medium: "Sedang",
  high: "Tinggi",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

// Tanggal lokal hari ini sebagai YYYY-MM-DD.
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseIso(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// Selisih hari kalender dari hari ini ke tanggal tenggat (negatif = sudah lewat).
export function daysUntil(due: string, now: Date = new Date()): number | null {
  const d = parseIso(due);
  const t = parseIso(todayIso(now));
  if (!d || !t) return null;
  return Math.round((d.getTime() - t.getTime()) / 86_400_000);
}

// "28 Nov" atau "28 Nov 2027" kalau beda tahun.
export function formatDue(due: string, now: Date = new Date()): string {
  const d = parseIso(due);
  if (!d) return due;
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

// Teks tenggat untuk kartu: "Hari ini", "Besok", "Terlambat 2 hari", atau tanggal.
export function dueLabel(due: string, now: Date = new Date()): string {
  const n = daysUntil(due, now);
  if (n === null) return due;
  if (n === 0) return "Hari ini";
  if (n === 1) return "Besok";
  if (n < 0) return `Terlambat ${-n} hari`;
  return formatDue(due, now);
}

// Waktu RFC 3339 jadi "22 Nov, 09.12" dalam jam lokal.
export function formatDateTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  const date = d.getFullYear() === now.getFullYear() ? day : `${day} ${d.getFullYear()}`;
  return `${date}, ${hh}.${mm}`;
}

// Usulan kode proyek dari nama: huruf awal tiap kata, 2 sampai 6 karakter.
export function suggestCode(name: string): string {
  const words = name
    .normalize("NFD")
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  let code = words.map((w) => w[0]).join("").toUpperCase();
  if (code.length < 2 && words[0]) code = words[0].slice(0, 3).toUpperCase();
  code = code.replace(/^[0-9]+/, "");
  return code.slice(0, 6);
}

export const PROJECT_CODE_RE = /^[A-Z][A-Z0-9]{1,5}$/;

export const NAME_RULE = "Nama proyek harus 2 sampai 80 karakter.";

// Aturan nama proyek, sama untuk Proyek baru dan Ubah nama proyek. Inti Rust memeriksa ulang.
export function projectNameProblem(clean: string): string | null {
  if (!clean) return "Tulis nama proyek dulu.";
  const length = Array.from(clean).length;
  return length < 2 || length > 80 ? NAME_RULE : null;
}

// Nama tim untuk kalimat: "Tim Keuangan". Nama yang sudah diawali "Tim" tidak diberi awalan lagi.
export function teamLabel(name: string): string {
  return /^tim\b/i.test(name.trim()) ? name.trim() : `Tim ${name.trim()}`;
}
