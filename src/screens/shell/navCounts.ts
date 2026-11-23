// Angka di menu sidebar (badge opsi C, docs/plans/v03-d.md D1 sampai D4).
// Fungsi murni dari data yang sudah dibaca. Bentuk data diterima longgar:
// field yang hilang atau rusak dihitung nol, dan field baru tidak mengganggu.
import type { MyTask } from "../../api/board";
import { dueSummary } from "../board/dueCounts";

function amount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

// D2: pesan belum dibaca di percakapan yang tidak diarsipkan dan tidak dibisukan.
export function chatUnread(overview: unknown): number {
  let total = 0;
  for (const item of list(record(overview)?.conversations)) {
    const c = record(item);
    if (!c || c.archived === true || c.muted === true) continue;
    total += amount(c.unread);
  }
  return total;
}

// D3: permintaan yang masih berjalan dan sedang menunggu tanda tangan saya.
export function signWaiting(overview: unknown): number {
  return list(record(overview)?.requests).filter((item) => {
    const r = record(item);
    return r?.status === "in_progress" && r.myState === "your_turn";
  }).length;
}

// D1: task saya yang belum Selesai dengan tenggat hari ini atau sudah lewat.
// today: YYYY-MM-DD lokal (todayIso).
export function boardDue(myTasks: readonly MyTask[] | null | undefined, today: string): number {
  const valid = list(myTasks).filter((t): t is MyTask => record(record(t)?.task) !== null);
  return dueSummary(valid, today).total;
}

// D4: permintaan bergabung, hanya untuk orang yang boleh memutuskannya.
export function joinPending(overview: unknown): number {
  const o = record(overview);
  if (!o || list(o.decideJoinTeamIds).length === 0) return 0;
  return amount(o.pendingJoinCount);
}
