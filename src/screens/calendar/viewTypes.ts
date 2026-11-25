// Props bersama tampilan Bulan, Minggu, dan Agenda (kontrak 2.4 di
// docs/plans/sidebar-kalender.md). Layar Kalender memberi data yang sudah
// disaring dan penangan chip; tampilan hanya menggambar.
import type { KeyboardEvent, MouseEvent, PointerEvent } from "react";
import type { CalTask } from "../../api/calendar";
import type { DayKey } from "./calendarModel";

export type ChipHandlers = {
  onOpen: (t: CalTask) => void;
  onPointerDown: (e: PointerEvent<HTMLElement>, t: CalTask) => void;
  onContextMenu: (e: MouseEvent<HTMLElement>, t: CalTask) => void;
  // Alt+Panah, Shift+F10, tombol Menu.
  onKeyDown: (e: KeyboardEvent<HTMLElement>, t: CalTask) => void;
};

export type ViewProps = ChipHandlers & {
  anchor: DayKey;
  today: DayKey;
  // Sudah disaring oleh layar.
  byDay: Map<DayKey, CalTask[]>;
  // projectId -> indeks warna 0..7.
  colors: Map<string, number>;
  // taskKey yang sedang diseret.
  draggingKey: string | null;
  // Hari di bawah pointer selama seret.
  dropDay: DayKey | null;
  // Chip yang harus difokus setelah render (misalnya setelah tenggat dipindah).
  focusKey: string | null;
};

export type AgendaProps = ViewProps & {
  // Task belum selesai yang tenggatnya sebelum rentang (grup Lewat tenggat).
  overdue: CalTask[];
};
