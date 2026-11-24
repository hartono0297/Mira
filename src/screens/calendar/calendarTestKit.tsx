// Bahan tes layar Kalender: data contoh dan tampilan tiruan. Tampilan asli
// (MonthView, WeekView, AgendaView) diuji sendiri; di tes layar cukup tiruan
// yang menggambar sel data-cal-day dan chip data-cal-task lalu meneruskan
// penangan chip, supaya tes layar tidak bergantung pada tata letak tampilan.
import { useEffect, useRef } from "react";
import type { ColumnId, ProjectSummary, TaskCard } from "../../api/board";
import type { CalTask } from "../../api/calendar";
import { monthGrid, rangeFor, taskKey, weekDays, type DayKey } from "./calendarModel";
import type { AgendaProps, ViewProps } from "./viewTypes";

export const ME = "kunci-saya";
export const OTHER = "kunci-lain";

export function card(over: Partial<TaskCard> = {}): TaskCard {
  return {
    id: "t1",
    code: "TES-1",
    title: "Task",
    columnId: "todo" as ColumnId,
    assignee: null,
    due: null,
    priority: "none",
    labels: [],
    commentCount: 0,
    merged: false,
    subtaskDone: 0,
    subtaskTotal: 0,
    trackedSecs: 0,
    timersRunningSince: [],
    canEdit: true,
    canDelete: true,
    myTimerRunning: false,
    ...over,
  };
}

export function calTask(projectId: string, over: Partial<TaskCard>): CalTask {
  return {
    projectId,
    projectCode: projectId === "p1" ? "TES" : "OPS",
    projectName: projectId === "p1" ? "Tes" : "Operasional",
    task: card(over),
  };
}

export function project(id: string, code: string, name: string): ProjectSummary {
  return { id, code, name, teamId: null, teamName: null, openCount: 1, taskCount: 1, canManage: false };
}

export const PROJECTS = [project("p1", "TES", "Tes"), project("p2", "OPS", "Operasional")];

// TES-3: milik saya, boleh diubah, tenggat hari ini (Selasa 24 November 2026).
export const T_MINE = calTask("p1", {
  id: "t3",
  code: "TES-3",
  title: "Laporan bulanan",
  due: "2026-11-24",
  assignee: { publicKey: ME, name: "Saya" },
});
// TES-4: milik orang lain, tanpa hak ubah.
export const T_LOCKED = calTask("p1", {
  id: "t4",
  code: "TES-4",
  title: "Rapat vendor",
  due: "2026-11-26",
  canEdit: false,
  assignee: { publicKey: OTHER, name: "Rina" },
});
// OPS-1: milik saya, sudah selesai.
export const T_DONE = calTask("p2", {
  id: "o1",
  code: "OPS-1",
  title: "Cek server",
  due: "2026-11-25",
  columnId: "done",
  assignee: { publicKey: ME, name: "Saya" },
});
// OPS-2: belum selesai, tenggat sebelum November (grup lewat tenggat di Agenda).
export const T_LATE = calTask("p2", {
  id: "o2",
  code: "OPS-2",
  title: "Perpanjang domain",
  due: "2026-10-20",
  assignee: { publicKey: ME, name: "Saya" },
});
export const T_LATE_DONE = calTask("p2", {
  id: "o3",
  code: "OPS-3",
  title: "Arsip lama",
  due: "2026-10-21",
  columnId: "done",
});

function days(view: "month" | "week" | "agenda", anchor: DayKey): DayKey[] {
  if (view === "week") return weekDays(anchor);
  if (view === "month") return monthGrid(anchor).flat();
  const { from, to } = rangeFor("agenda", anchor);
  return monthGrid(anchor)
    .flat()
    .filter((d) => d >= from && d <= to);
}

function Chip({ t, props }: { t: CalTask; props: ViewProps }) {
  return (
    <button
      type="button"
      data-cal-task={taskKey(t)}
      data-dragging={props.draggingKey === taskKey(t) || undefined}
      onClick={() => props.onOpen(t)}
      onPointerDown={(e) => props.onPointerDown(e, t)}
      onContextMenu={(e) => props.onContextMenu(e, t)}
      onKeyDown={(e) => props.onKeyDown(e, t)}
    >
      {t.task.code} {t.task.title}
    </button>
  );
}

function FakeView({ kind, props, overdue }: { kind: "month" | "week" | "agenda"; props: ViewProps; overdue?: CalTask[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!props.focusKey) return;
    ref.current?.querySelector<HTMLElement>(`[data-cal-task="${props.focusKey}"]`)?.focus();
  }, [props.focusKey, props.byDay]);
  return (
    <div ref={ref} data-testid={`view-${kind}`} data-anchor={props.anchor} data-drop-day={props.dropDay ?? ""}>
      {overdue && (
        <section data-testid="overdue">
          {overdue.map((t) => (
            <Chip key={taskKey(t)} t={t} props={props} />
          ))}
        </section>
      )}
      {days(kind, props.anchor).map((day) => (
        <div key={day} data-cal-day={day} data-testid={`day-${day}`}>
          {(props.byDay.get(day) ?? []).map((t) => (
            <Chip key={taskKey(t)} t={t} props={props} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function FakeMonthView(props: ViewProps) {
  return <FakeView kind="month" props={props} />;
}

export function FakeWeekView(props: ViewProps) {
  return <FakeView kind="week" props={props} />;
}

export function FakeAgendaView(props: AgendaProps) {
  return <FakeView kind="agenda" props={props} overdue={props.overdue} />;
}
