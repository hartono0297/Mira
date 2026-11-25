// Isi menu klik kanan chip kalender: "Pindahkan tenggat ke". Dibuka dengan
// klik kanan, Shift+F10, atau tombol Menu lewat useContextMenu bersama.
// Tanpa hak ubah, semua pilihan tenggat tampil nonaktif dengan alasannya,
// jadi orang tahu kenapa tidak bisa; Buka task selalu jalan.
import { IconCalendarX, IconFileText } from "@tabler/icons-react";
import type { CalTask } from "../../api/calendar";
import { menuItems, SEPARATOR, type MenuEntry } from "../../components/ContextMenu";
import { CAL_TEXT } from "../../i18n/calendar";
import { addDays, canMoveDue, startOfWeek, type DayKey } from "./calendarModel";

export type DueMenuActions = {
  setDue: (t: CalTask, due: DayKey | null) => void;
  open: (t: CalTask) => void;
};

// Pilihan yang menghasilkan tanggal, dihitung dari hari ini dan tenggat sekarang.
export function dueTargets(t: CalTask, today: DayKey): { id: string; label: string; day: DayKey | null }[] {
  const M = CAL_TEXT.menu;
  const due = t.task.due;
  return [
    { id: "due-today", label: M.hariIni, day: today },
    { id: "due-tomorrow", label: M.besok, day: addDays(today, 1) },
    // Senin sesudah minggu ini, juga kalau hari ini Senin.
    { id: "due-next-monday", label: M.seninDepan, day: addDays(startOfWeek(today), 7) },
    { id: "due-earlier", label: M.lebihAwal, day: due ? addDays(due, -1) : null },
    { id: "due-later", label: M.lebihLambat, day: due ? addDays(due, 1) : null },
  ];
}

export function dueMenuEntries(t: CalTask, today: DayKey, actions: DueMenuActions): MenuEntry[] {
  const M = CAL_TEXT.menu;
  const allowed = canMoveDue(t);
  const noRight = !allowed && M.tanpaHak;
  const moves: MenuEntry[] = dueTargets(t, today)
    // Satu hari lebih awal atau lambat butuh tenggat; chip kalender selalu punya.
    .filter((x) => x.day !== null)
    .map((x) => ({
      id: x.id,
      label: x.label,
      disabled: noRight || (x.day === t.task.due && M.sudahDiTanggal),
      onSelect: () => actions.setDue(t, x.day),
    }));
  return menuItems(
    ...moves,
    SEPARATOR,
    {
      id: "due-clear",
      label: M.hapus,
      icon: <IconCalendarX size={16} />,
      disabled: noRight,
      onSelect: () => actions.setDue(t, null),
    },
    SEPARATOR,
    { id: "open", label: M.buka, icon: <IconFileText size={16} />, onSelect: () => actions.open(t) },
  );
}
