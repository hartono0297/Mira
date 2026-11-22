// Kalimat riwayat aktivitas task dari kind, detail, dan pelakunya.
import type { Activity, ColumnId, Person, Priority } from "../../api/board";
import { COLUMN_NAMES, formatDue, PRIORITY_LABELS } from "./format";

const HEX_KEY = /^[0-9a-f]{64}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function columnName(detail: string): string {
  return COLUMN_NAMES[detail as ColumnId] ?? detail;
}

function personName(detail: string, people: Person[], me: string): string {
  if (!HEX_KEY.test(detail)) return detail;
  if (detail === me) return "Anda";
  return people.find((p) => p.publicKey === detail)?.name ?? "anggota lain";
}

// "Sari memindahkan task ke Dikerjakan". Pelaku = "Anda" kalau itu laptop ini.
export function activitySentence(a: Activity, me: string, people: Person[] = [], now: Date = new Date()): string {
  const who = a.actor.publicKey === me ? "Anda" : a.actor.name;
  const d = a.detail.trim();
  switch (a.kind) {
    case "created":
      return `${who} membuat task ini`;
    case "title":
      return d ? `${who} mengubah judul menjadi "${d}"` : `${who} mengubah judul`;
    case "description":
      return `${who} mengubah deskripsi`;
    case "moved":
      return d ? `${who} memindahkan task ke ${columnName(d)}` : `${who} memindahkan task`;
    case "assignee":
      return d ? `${who} menugaskan task ke ${personName(d, people, me)}` : `${who} mengosongkan penanggung jawab`;
    case "due":
      if (!d) return `${who} menghapus tenggat`;
      return `${who} mengubah tenggat menjadi ${ISO_DATE.test(d) ? formatDue(d, now) : d}`;
    case "priority":
      return `${who} mengubah prioritas menjadi ${PRIORITY_LABELS[d as Priority] ?? d}`;
    case "labels":
      return d ? `${who} mengubah label menjadi ${d}` : `${who} menghapus semua label`;
    case "deleted":
      return `${who} menghapus task ini`;
    case "commented":
      return `${who} menambahkan komentar`;
    case "renumbered":
      // Dua laptop offline membuat nomor yang sama; satu task diberi nomor baru.
      return d
        ? `${who} mengganti nomor task ini dari ${d} karena nomornya sama dengan task lain`
        : `${who} mengganti nomor task ini`;
    default:
      return d ? `${who} mengubah task: ${d}` : `${who} mengubah task`;
  }
}
