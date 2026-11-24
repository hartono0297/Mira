import { IconAlertTriangle } from "@tabler/icons-react";
import { useCallback, useRef, useState } from "react";
import { CAL_VIEW } from "../../i18n/calendar-view";
import { CalChip, useFocusKey } from "./CalChip";
import { dayLong, dayNumber, isOverdue, monthGrid, monthTitle, sameMonth, taskKey, weekdayShort, type DayKey } from "./calendarModel";
import { DayMore } from "./DayMore";
import type { ViewProps } from "./viewTypes";
import "./calendar-views.css";

// Chip yang tampil di satu sel sebelum "+N lagi".
export const MONTH_CHIP_LIMIT = 3;

type Open = { day: DayKey; opener: HTMLElement };

// Tampilan Bulan: tabel 7 kolom, Senin dulu. Lebar: maks 3 chip per sel lalu
// "+N lagi". Sempit (lihat calendar-views.css): chip diganti satu tombol jumlah
// per hari. Keduanya membuka DayMore, daftar semua task hari itu.
export function MonthView({ anchor, today, byDay, colors, draggingKey, dropDay, focusKey, ...handlers }: ViewProps) {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const txt = CAL_VIEW.bulan;
  const rows = monthGrid(anchor);
  const heads = weekdayShort();

  const fallback = useCallback((day: DayKey) => {
    const cell = root.current?.querySelector(`[data-cal-day="${day}"]`);
    return cell ? [...cell.querySelectorAll<HTMLElement>("[data-cal-more]")] : [];
  }, []);
  useFocusKey(root, focusKey, byDay, fallback);

  function toggle(day: DayKey, opener: HTMLElement) {
    setOpen((cur) => (cur && cur.day === day && cur.opener === opener ? null : { day, opener }));
  }

  function close(returnFocus: boolean) {
    const cur = open;
    setOpen(null);
    if (returnFocus && cur?.opener.isConnected) cur.opener.focus();
  }

  const openTasks = open ? (byDay.get(open.day) ?? []) : [];

  return (
    <div ref={root} className="cv cv-month">
      <table className="cv-table">
        <caption className="sr-only">{monthTitle(anchor)}</caption>
        <thead>
          <tr>
            {heads.map((h) => (
              <th key={h} scope="col" className="cv-th">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((week) => (
            <tr key={week[0]}>
              {week.map((day) => {
                const tasks = byDay.get(day) ?? [];
                const shown = tasks.slice(0, MONTH_CHIP_LIMIT);
                const hidden = tasks.length - shown.length;
                const isToday = day === today;
                const anyLate = tasks.some((t) => isOverdue(t, today));
                const expanded = open?.day === day;
                const cls = ["cv-day", sameMonth(day, anchor) ? "" : "cv-out", isToday ? "cv-today" : "", dropDay === day ? "cv-drop" : ""]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <td key={day} className={cls} data-cal-day={day} aria-current={isToday ? "date" : undefined}>
                    <h3 className="cv-num">
                      <span aria-hidden="true">{dayNumber(day)}</span>
                      <span className="sr-only">{dayLong(day)}</span>
                    </h3>
                    {shown.length > 0 && (
                      <ul className="cv-chips">
                        {shown.map((t) => (
                          <li key={taskKey(t)}>
                            <CalChip
                              item={t}
                              colorIndex={colors.get(t.projectId) ?? 0}
                              today={today}
                              dragging={draggingKey === taskKey(t)}
                              {...handlers}
                            />
                          </li>
                        ))}
                      </ul>
                    )}
                    {hidden > 0 && (
                      <button
                        type="button"
                        className="cv-more-btn"
                        data-cal-more
                        aria-haspopup="dialog"
                        aria-expanded={expanded}
                        aria-label={txt.lagi(hidden) + txt.hariSr(dayLong(day))}
                        onClick={(e) => toggle(day, e.currentTarget)}
                      >
                        {txt.lagi(hidden)}
                      </button>
                    )}
                    {tasks.length > 0 && (
                      <button
                        type="button"
                        className={`cv-count${anyLate ? " cv-count-late" : ""}`}
                        data-cal-more
                        aria-haspopup="dialog"
                        aria-expanded={expanded}
                        aria-label={tasks.length + txt.jumlahSr(tasks.length) + txt.hariSr(dayLong(day)) + (anyLate ? txt.adaLewatSr : "")}
                        onClick={(e) => toggle(day, e.currentTarget)}
                      >
                        {anyLate && <IconAlertTriangle size={12} aria-hidden="true" />}
                        {tasks.length}
                      </button>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {open && openTasks.length > 0 && (
        <DayMore
          key={open.day}
          day={open.day}
          tasks={openTasks}
          today={today}
          colors={colors}
          draggingKey={draggingKey}
          opener={open.opener}
          onClose={close}
          {...handlers}
        />
      )}
    </div>
  );
}
