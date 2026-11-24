import { useId, useRef } from "react";
import type { CalTask } from "../../api/calendar";
import { CAL_VIEW } from "../../i18n/calendar-view";
import { CalChip, useFocusKey } from "./CalChip";
import { dayLong, monthTitle, taskKey } from "./calendarModel";
import type { AgendaProps, ChipHandlers } from "./viewTypes";
import "./calendar-views.css";

type ListProps = ChipHandlers & {
  tasks: CalTask[];
  today: string;
  colors: Map<string, number>;
  draggingKey: string | null;
};

function Rows({ tasks, today, colors, draggingKey, ...handlers }: ListProps) {
  return (
    <ul className="cv-alist">
      {tasks.map((t) => (
        <li key={taskKey(t)}>
          <CalChip item={t} variant="row" colorIndex={colors.get(t.projectId) ?? 0} today={today} dragging={draggingKey === taskKey(t)} {...handlers} />
        </li>
      ))}
    </ul>
  );
}

// Tampilan Agenda: grup "Lewat tenggat" (kalau ada), lalu satu bagian per hari
// yang punya task, urut tanggal. Baris lebar penuh dengan penanggung jawab dan
// prioritas. Bagian hari punya data-cal-day supaya chip bisa diseret ke sana.
export function AgendaView({ anchor, today, byDay, colors, draggingKey, dropDay, focusKey, overdue, ...handlers }: AgendaProps) {
  const root = useRef<HTMLDivElement>(null);
  const lateId = useId();
  const txt = CAL_VIEW.agenda;
  // Task lewat tenggat juga harus bisa difokus setelah dipindah.
  const all = overdue.length > 0 ? new Map([...byDay, ["", overdue] as [string, CalTask[]]]) : byDay;
  useFocusKey(root, focusKey, all);
  const days = [...byDay.keys()].filter((d) => (byDay.get(d)?.length ?? 0) > 0).sort();
  const list = { today, colors, draggingKey, ...handlers };

  if (days.length === 0 && overdue.length === 0) {
    return (
      <div ref={root} className="cv cv-agenda">
        <div className="cv-empty">
          <p className="cv-empty-title">{txt.kosongJudul(monthTitle(anchor))}</p>
          <p>{txt.kosongSaran}</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={root} className="cv cv-agenda">
      {overdue.length > 0 && (
        <section className="cv-aday cv-alate" aria-labelledby={lateId}>
          <h3 id={lateId} className="cv-ahead cv-ahead-late">
            {txt.lewat}
          </h3>
          <Rows tasks={overdue} {...list} />
        </section>
      )}
      {days.map((day) => {
        const isToday = day === today;
        const cls = ["cv-aday", isToday ? "cv-today" : "", dropDay === day ? "cv-drop" : ""].filter(Boolean).join(" ");
        return (
          <section key={day} className={cls} data-cal-day={day} aria-current={isToday ? "date" : undefined}>
            <h3 className="cv-ahead" aria-label={isToday ? `${txt.hariIni}, ${dayLong(day)}` : undefined}>
              {isToday && <span className="cv-tag">{txt.hariIni}</span>}
              <span>{dayLong(day)}</span>
            </h3>
            <Rows tasks={byDay.get(day) ?? []} {...list} />
          </section>
        );
      })}
    </div>
  );
}
