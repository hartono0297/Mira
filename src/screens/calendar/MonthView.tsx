import { IconAlertTriangle } from "@tabler/icons-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CAL_VIEW } from "../../i18n/calendar-view";
import { CalChip, useFocusKey } from "./CalChip";
import { dayLong, dayNumber, isOverdue, monthGrid, monthTitle, sameMonth, taskKey, weekdayShort, type DayKey } from "./calendarModel";
import { DayMore } from "./DayMore";
import type { ViewProps } from "./viewTypes";
import "./calendar-views.css";

// Chip per sel sebelum "+N lagi" kalau tinggi baris belum terukur (tes, frame pertama).
export const MONTH_CHIP_LIMIT = 3;

// Ukuran di calendar-views.css: padding sel 4+4 dan garis 1, kepala sel (angka
// dan "+N lagi") 24 dengan jarak 3 di bawahnya, chip 28 dengan jarak 3.
const CELL_PAD = 9;
const CELL_HEAD = 27;
const CHIP = 28;
const CHIP_GAP = 3;
const MAX_CHIPS = 6;

// Berapa chip muat di satu baris setinggi `rowHeight` px. Minimal 1; tanpa
// ukuran yang sah, bawaan 3.
export function chipLimit(rowHeight: number): number {
  if (!(rowHeight > 0)) return MONTH_CHIP_LIMIT;
  const n = Math.floor((rowHeight - CELL_PAD - CELL_HEAD + CHIP_GAP) / (CHIP + CHIP_GAP));
  return Math.max(1, Math.min(MAX_CHIPS, n));
}

// Nama hari panjang untuk kepala kolom ("Senin"), dari dayLong supaya ikut bahasa
// dan format yang sama dengan model.
function weekdayLong(day: DayKey): string {
  return dayLong(day).split(", ")[0];
}

// Tampilan Bulan: tabel 7 kolom, Senin dulu, mengisi tinggi induknya. Jumlah chip
// per sel mengikuti tinggi baris; sisanya "+N lagi" di samping angka hari.
// Sempit (lihat calendar-views.css): chip diganti satu tombol jumlah per hari.
// Keduanya membuka DayMore, daftar semua task hari itu.
export function MonthView({ anchor, today, byDay, colors, draggingKey, dropDay, focusKey, ...handlers }: ViewProps) {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<DayKey | null>(null);
  const [limit, setLimit] = useState(MONTH_CHIP_LIMIT);
  const txt = CAL_VIEW.bulan;
  const rows = monthGrid(anchor);
  const heads = weekdayShort();
  const title = monthTitle(anchor);
  const rowCount = rows.length;
  const empty = !rows.some((week) => week.some((day) => (byDay.get(day)?.length ?? 0) > 0));

  // Tinggi baris = tinggi yang tersedia dibagi jumlah minggu. Tanpa ResizeObserver
  // (jsdom) batas tetap 3.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const head = el.querySelector("thead")?.getBoundingClientRect().height ?? 0;
      const note = el.querySelector(".cv-empty-line")?.getBoundingClientRect().height ?? 0;
      setLimit(chipLimit((el.clientHeight - head - note) / rowCount));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rowCount, empty]);

  const cellOf = useCallback((day: DayKey) => root.current?.querySelector<HTMLElement>(`td[data-cal-day="${day}"]`) ?? null, []);

  const fallback = useCallback(
    (day: DayKey) => {
      const cell = cellOf(day);
      return cell ? [...cell.querySelectorAll<HTMLElement>("[data-cal-more]")] : [];
    },
    [cellOf],
  );
  useFocusKey(root, focusKey, byDay, fallback);

  // Pembuka yang terlihat untuk hari yang daftarnya terbuka: "+N lagi" atau
  // tombol jumlah, kalau keduanya tidak ada chip pertama di sel itu. Tanpa tata
  // letak (jsdom) semua elemen dianggap terlihat.
  const openerFor = useCallback(
    (day: DayKey): HTMLElement | null => {
      const cell = cellOf(day);
      if (!cell) return null;
      const layout = cell.getClientRects().length > 0;
      const candidates = [...cell.querySelectorAll<HTMLElement>("[data-cal-more]"), ...cell.querySelectorAll<HTMLElement>("[data-cal-task]")];
      return candidates.find((c) => !layout || c.getClientRects().length > 0) ?? null;
    },
    [cellOf],
  );

  const isOpener = useCallback(
    (node: Node) => {
      if (!open) return false;
      const btn = node instanceof Element ? node.closest("[data-cal-more]") : null;
      return !!btn && !!cellOf(open)?.contains(btn);
    },
    [open, cellOf],
  );

  const openCount = open ? (byDay.get(open)?.length ?? 0) : 0;
  useEffect(() => {
    if (open && openCount === 0) setOpen(null);
  }, [open, openCount]);

  function close(returnFocus: boolean) {
    const day = open;
    setOpen(null);
    if (returnFocus && day) openerFor(day)?.focus();
  }

  return (
    <div ref={root} className="cv cv-month" role="group" aria-label={title} tabIndex={-1}>
      <table className="cv-table">
        <caption className="sr-only">{title}</caption>
        <thead>
          <tr>
            {heads.map((h, i) => (
              <th key={h} scope="col" className="cv-th">
                <span aria-hidden="true">{h}</span>
                <span className="sr-only">{weekdayLong(rows[0][i])}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((week) => (
            <tr key={week[0]}>
              {week.map((day) => {
                const tasks = byDay.get(day) ?? [];
                const shown = tasks.slice(0, limit);
                const hidden = tasks.length - shown.length;
                const isToday = day === today;
                const anyLate = tasks.some((t) => isOverdue(t, today));
                const expanded = open === day;
                const cls = ["cv-day", sameMonth(day, anchor) ? "" : "cv-out", isToday ? "cv-today" : "", dropDay === day ? "cv-drop" : ""]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <td key={day} className={cls} data-cal-day={day} aria-current={isToday ? "date" : undefined}>
                    <div className="cv-dhead">
                      <span className="cv-num">
                        <span aria-hidden="true">{dayNumber(day)}</span>
                        <span className="sr-only">{dayLong(day)}</span>
                      </span>
                      {hidden > 0 && (
                        <button
                          type="button"
                          className="cv-more-btn"
                          data-cal-more
                          aria-haspopup="dialog"
                          aria-expanded={expanded}
                          aria-label={txt.lagiSr(hidden) + txt.hariSr(dayLong(day))}
                          onClick={() => setOpen(expanded ? null : day)}
                        >
                          {txt.lagi(hidden)}
                        </button>
                      )}
                    </div>
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
                    {tasks.length > 0 && (
                      <button
                        type="button"
                        className={`cv-count${anyLate ? " cv-count-late" : ""}`}
                        data-cal-more
                        aria-haspopup="dialog"
                        aria-expanded={expanded}
                        aria-label={tasks.length + txt.jumlahSr(tasks.length) + txt.hariSr(dayLong(day)) + (anyLate ? txt.adaLewatSr : "")}
                        onClick={() => setOpen(expanded ? null : day)}
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
      {empty && (
        <p className="cv-empty-line">
          <strong>{CAL_VIEW.agenda.kosongJudul(title)}</strong> {CAL_VIEW.agenda.kosongSaran}
        </p>
      )}
      {open && openCount > 0 && (
        <DayMore
          key={open}
          day={open}
          tasks={byDay.get(open) ?? []}
          today={today}
          colors={colors}
          draggingKey={draggingKey}
          getOpener={() => openerFor(open)}
          isOpener={isOpener}
          onClose={close}
          {...handlers}
        />
      )}
    </div>
  );
}
