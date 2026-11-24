// Teks dan tanggal yang dipakai bersama layar board, detail task, dan Task saya.
// Teksnya ada di kamus src/i18n/board.id.ts dan .en.ts (TEKS di teks.ts);
// semua fungsi di sini membaca bahasa aktif saat dipanggil.
import type { ColumnId, Priority } from "../../api/board";
import { subscribeLang } from "../../i18n/core";
import boardId from "../../i18n/board.id";
import { TEKS } from "./teks";

// Nama tampilan kolom bawaan dalam bahasa aktif (objek hidup, bukan salinan).
export const COLUMN_NAMES: Record<ColumnId, string> = TEKS.kolom;

export const COLUMN_ORDER: ColumnId[] = ["todo", "doing", "done"];

// Nama kolom untuk tampilan. Inti Rust menyimpan dan menyinkronkan nama kolom
// bawaan dalam bahasa Indonesia ("Dikerjakan"); nama itu ditampilkan dalam
// bahasa aktif. Nama lain (kalau suatu saat kolom bisa diberi nama) tampil apa adanya.
export function columnLabel(id: ColumnId, name?: string): string {
  if (name === undefined || name === boardId.kolom[id]) return COLUMN_NAMES[id] ?? name ?? id;
  return name;
}

// Kolom dari isi riwayat aktivitas: id ("doing") atau nama tersimpan ("Dikerjakan").
export function columnFromDetail(detail: string): ColumnId | null {
  return COLUMN_ORDER.find((c) => c === detail || boardId.kolom[c] === detail) ?? null;
}

export const PRIORITY_LABELS: Record<Priority, string> = TEKS.prioritas;

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
  const base = `${d.getDate()} ${TEKS.tanggal.bulan[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

// Teks tenggat untuk kartu: "Hari ini", "Besok", "Terlambat 2 hari", atau tanggal.
export function dueLabel(due: string, now: Date = new Date()): string {
  const n = daysUntil(due, now);
  if (n === null) return due;
  if (n === 0) return TEKS.tanggal.hariIni;
  if (n === 1) return TEKS.tanggal.besok;
  if (n < 0) return TEKS.tanggal.terlambat(-n);
  return formatDue(due, now);
}

// Waktu RFC 3339 jadi "22 Nov, 09.12" (Inggris "22 Nov, 09:12") dalam jam lokal.
export function formatDateTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const day = `${d.getDate()} ${TEKS.tanggal.bulan[d.getMonth()]}`;
  const date = d.getFullYear() === now.getFullYear() ? day : `${day} ${d.getFullYear()}`;
  return TEKS.tanggal.tanggalJam(date, hh, mm);
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

// Teks dalam bahasa aktif. `export let` diperbarui saat bahasa berganti, jadi
// yang mengimpornya selalu membaca nilai terbaru saat render.
export let NAME_RULE = TEKS.proyek.namaAturan;
export let NO_DEPARTMENT = TEKS.proyek.tanpaDepartemen;
subscribeLang(() => {
  NAME_RULE = TEKS.proyek.namaAturan;
  NO_DEPARTMENT = TEKS.proyek.tanpaDepartemen;
});

// Aturan nama proyek, sama untuk Proyek baru dan Ubah nama proyek. Inti Rust memeriksa ulang.
export function projectNameProblem(clean: string): string | null {
  if (!clean) return TEKS.proyek.namaKosong;
  const length = Array.from(clean).length;
  return length < 2 || length > 80 ? TEKS.proyek.namaAturan : null;
}

// Nama departemen untuk kalimat: "Departemen Keuangan" (Inggris "Keuangan department").
// Nama yang sudah menyebut departemen tidak diberi tambahan lagi. ("team" di inti Rust = departemen.)
export function teamLabel(name: string): string {
  return TEKS.proyek.departemen(name.trim());
}
