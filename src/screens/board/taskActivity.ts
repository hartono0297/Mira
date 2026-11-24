// Kalimat riwayat aktivitas task dari kind, detail, dan pelakunya. Kalimatnya
// ada di kamus board (TEKS.aktivitas); detail adalah data tersimpan dan tidak
// diterjemahkan, kecuali nama kolom bawaan dan prioritas yang punya nama tampilan.
import type { Activity, Person, Priority } from "../../api/board";
import { COLUMN_NAMES, columnFromDetail, formatDue, PRIORITY_LABELS } from "./format";
import { TEKS } from "./teks";
import { formatDurationLong } from "./timeFormat";

const HEX_KEY = /^[0-9a-f]{64}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Detail moved/created berisi id kolom atau nama yang disimpan inti Rust ("Dikerjakan").
function columnName(detail: string): string {
  const id = columnFromDetail(detail);
  return id ? COLUMN_NAMES[id] : detail;
}

// Detail time_logged = jumlah detik. "1 jam 30 menit", "45 menit", "kurang dari 1 menit".
function loggedText(detail: string): string | null {
  if (!/^\d+$/.test(detail)) return null;
  return formatDurationLong(Number(detail));
}

function personName(detail: string, people: Person[], me: string): string {
  if (!HEX_KEY.test(detail)) return detail;
  if (detail === me) return TEKS.aktivitas.andaObjek;
  return people.find((p) => p.publicKey === detail)?.name ?? TEKS.aktivitas.anggotaLain;
}

// "Sari memindahkan task ke Dikerjakan". Pelaku = "Anda" kalau itu laptop ini.
export function activitySentence(a: Activity, me: string, people: Person[] = [], now: Date = new Date()): string {
  const T = TEKS.aktivitas;
  const who = a.actor.publicKey === me ? T.anda : a.actor.name;
  const d = a.detail.trim();
  switch (a.kind) {
    case "created":
      return T.created(who);
    case "title":
      return T.title(who, d);
    case "description":
      return T.description(who);
    case "moved":
      return T.moved(who, d ? columnName(d) : "");
    case "assignee":
      return T.assignee(who, d ? personName(d, people, me) : "");
    case "due":
      return T.due(who, d ? (ISO_DATE.test(d) ? formatDue(d, now) : d) : "");
    case "priority":
      return T.priority(who, PRIORITY_LABELS[d as Priority] ?? d);
    case "labels":
      return T.labels(who, d);
    case "deleted":
      return T.deleted(who);
    case "commented":
      return T.commented(who);
    case "renumbered":
      // Dua laptop offline membuat nomor yang sama; satu task diberi nomor baru.
      return T.renumbered(who, d);
    case "subtask_added":
      return T.subtaskAdded(who, d);
    case "subtask_done":
      return T.subtaskDone(who, d);
    case "subtask_reopened":
      return T.subtaskReopened(who, d);
    case "subtask_deleted":
      return T.subtaskDeleted(who, d);
    case "time_logged":
      return T.timeLogged(who, loggedText(d) ?? "");
    default:
      return T.other(who, d);
  }
}
