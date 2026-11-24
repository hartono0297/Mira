import { useRef } from "react";
import { CAL_VIEW } from "../../i18n/calendar-view";
import { CalChip, useFocusKey } from "./CalChip";
import { dayLong, dayNumber, taskKey, weekDays, weekdayShort, weekTitle } from "./calendarModel";
import type { ViewProps } from "./viewTypes";
import "./calendar-views.css";

// Tampilan Minggu: 7 kolom Senin sampai Minggu, semua task tampil, setiap kolom
// bergulir sendiri. Sempit: kolom menumpuk jadi daftar per hari (calendar-views.css).
export function WeekView({ anchor, today, byDay, colors, draggingKey, dropDay, focusKey, ...handlers }: ViewProps) {
  const root = useRef<HTMLDivElement>(null);
  useFocusKey(root, focusKey, byDay);
  const days = weekDays(anchor);
  const heads = weekdayShort();

  return (
    <div ref={root} className="cv cv-week" role="group" aria-label={weekTitle(anchor)}>
      {days.map((day, i) => {
        const tasks = byDay.get(day) ?? [];
        const isToday = day === today;
        const cls = ["cv-wcol", isToday ? "cv-today" : "", dropDay === day ? "cv-drop" : ""].filter(Boolean).join(" ");
        return (
          <section key={day} className={cls} data-cal-day={day} aria-current={isToday ? "date" : undefined}>
            <h3 className="cv-whead">
              <span className="cv-wday" aria-hidden="true">
                {heads[i]}
              </span>
              <span className="cv-wnum" aria-hidden="true">
                {dayNumber(day)}
              </span>
              <span className="sr-only">{dayLong(day)}</span>
            </h3>
            {tasks.length > 0 ? (
              <ul className="cv-wlist">
                {tasks.map((t) => (
                  <li key={taskKey(t)}>
                    <CalChip item={t} colorIndex={colors.get(t.projectId) ?? 0} today={today} dragging={draggingKey === taskKey(t)} {...handlers} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="cv-none">{CAL_VIEW.minggu.kosong}</p>
            )}
          </section>
        );
      })}
    </div>
  );
}
