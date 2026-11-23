// Task yang menunggu saya: ditugaskan ke saya, belum Selesai, dan tenggatnya
// hari ini atau sudah lewat. Dihitung di laptop ini dari board_my_tasks, yang
// sudah hanya memuat proyek yang boleh saya lihat.
import type { MyTask } from "../../api/board";

export type DueSummary = { total: number; byProject: Record<string, number> };

export function isDueNow(task: MyTask["task"], today: string): boolean {
  return task.columnId !== "done" && !!task.due && task.due <= today;
}

// today: YYYY-MM-DD lokal (todayIso di format.ts).
export function dueSummary(tasks: MyTask[], today: string): DueSummary {
  const byProject: Record<string, number> = {};
  let total = 0;
  for (const t of tasks) {
    if (!isDueNow(t.task, today)) continue;
    total++;
    byProject[t.projectId] = (byProject[t.projectId] ?? 0) + 1;
  }
  return { total, byProject };
}
