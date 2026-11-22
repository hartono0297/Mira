// Pengelompokan halaman Task saya menurut tenggat.
import type { MyTask } from "../../api/board";
import { daysUntil } from "./format";

export type GroupId = "late" | "today" | "tomorrow" | "week" | "later" | "none" | "done";

export const GROUP_TITLES: Record<GroupId, string> = {
  late: "Terlambat",
  today: "Hari ini",
  tomorrow: "Besok",
  week: "7 hari ke depan",
  later: "Nanti",
  none: "Tanpa tenggat",
  done: "Selesai",
};

export const GROUP_ORDER: GroupId[] = ["late", "today", "tomorrow", "week", "later", "none", "done"];

export function groupOf(item: MyTask, now: Date): GroupId {
  if (item.task.columnId === "done") return "done";
  if (!item.task.due) return "none";
  const n = daysUntil(item.task.due, now);
  if (n === null) return "none";
  if (n < 0) return "late";
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n <= 7) return "week";
  return "later";
}

function compare(a: MyTask, b: MyTask): number {
  const da = a.task.due ?? "9999-99-99";
  const db = b.task.due ?? "9999-99-99";
  if (da !== db) return da < db ? -1 : 1;
  return a.task.code.localeCompare(b.task.code, "id", { numeric: true });
}

// Kelompok yang berisi saja, dalam urutan GROUP_ORDER. Di dalam kelompok: tenggat terdekat dulu.
export function groupMyTasks(items: MyTask[], now: Date = new Date()): { id: GroupId; items: MyTask[] }[] {
  const map = new Map<GroupId, MyTask[]>();
  for (const item of items) {
    const g = groupOf(item, now);
    const list = map.get(g) ?? [];
    list.push(item);
    map.set(g, list);
  }
  return GROUP_ORDER.filter((id) => map.has(id)).map((id) => ({ id, items: [...(map.get(id) ?? [])].sort(compare) }));
}
