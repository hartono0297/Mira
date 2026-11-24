// Logika murni untuk memindah kartu di board (tampilan optimis, tujuan dari
// tombol Pindahkan dan pintasan Alt + panah).
import type { BoardView, ColumnId, TaskCard } from "../../api/board";
import { COLUMN_ORDER } from "./format";
import { TEKS } from "./teks";

export type Place = { columnId: ColumnId; index: number };

export function locate(view: BoardView, taskId: string): (Place & { task: TaskCard; size: number }) | null {
  for (const col of view.columns) {
    const index = col.tasks.findIndex((t) => t.id === taskId);
    if (index >= 0) return { columnId: col.id, index, task: col.tasks[index], size: col.tasks.length };
  }
  return null;
}

// Board setelah kartu dipindah. index = posisi di kolom tujuan setelah pindah.
export function applyMove(view: BoardView, taskId: string, to: Place): BoardView {
  const from = locate(view, taskId);
  if (!from) return view;
  const moved: TaskCard = { ...from.task, columnId: to.columnId };
  const columns = view.columns.map((col) => ({ ...col, tasks: col.tasks.filter((t) => t.id !== taskId) }));
  const target = columns.find((c) => c.id === to.columnId);
  if (!target) return view;
  const index = Math.max(0, Math.min(to.index, target.tasks.length));
  target.tasks.splice(index, 0, moved);
  return { ...view, columns };
}

export function samePlace(view: BoardView, taskId: string, to: Place): boolean {
  const from = locate(view, taskId);
  return !!from && from.columnId === to.columnId && from.index === to.index;
}

// Tujuan untuk pintasan keyboard. null = tidak bisa ke arah itu.
export type Direction = "left" | "right" | "up" | "down";

export function neighbourPlace(view: BoardView, taskId: string, dir: Direction): Place | null {
  const from = locate(view, taskId);
  if (!from) return null;
  if (dir === "up") return from.index > 0 ? { columnId: from.columnId, index: from.index - 1 } : null;
  if (dir === "down") return from.index < from.size - 1 ? { columnId: from.columnId, index: from.index + 1 } : null;
  const order = view.columns.map((c) => c.id).filter((id) => COLUMN_ORDER.includes(id));
  const at = order.indexOf(from.columnId);
  const next = order[dir === "left" ? at - 1 : at + 1];
  return next ? { columnId: next, index: 0 } : null;
}

export function blockedText(code: string, dir: Direction): string {
  switch (dir) {
    case "left":
      return TEKS.pindah.kiri(code);
    case "right":
      return TEKS.pindah.kanan(code);
    case "up":
      return TEKS.pindah.atas(code);
    case "down":
      return TEKS.pindah.bawah(code);
  }
}
