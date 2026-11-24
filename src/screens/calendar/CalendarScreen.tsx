// Layar Kalender (docs/plans/sidebar-kalender.md, bagian 2.5): kepala dengan
// judul periode dan navigasi, pilihan tampilan, saringan, lalu tampilan
// Bulan, Minggu, atau Agenda. Tenggat dipindah dengan seret, Alt+Panah, atau
// menu klik kanan; semuanya lewat boardApi.updateTask, tampil optimistis, dan
// dikembalikan kalau inti menolak.
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { api, toAppError } from "../../api";
import { boardApi } from "../../api/board";
import type { CalTask } from "../../api/calendar";
import { useContextMenu } from "../../components/ContextMenu";
import { ErrorAlert } from "../../components/ErrorAlert";
import { CAL_TEXT } from "../../i18n/calendar";
import { useLang } from "../../i18n/core";
import { TaskDetail } from "../board/TaskDetail";
import { AgendaView } from "./AgendaView";
import {
  addDays,
  addMonths,
  applyFilter,
  canMoveDue,
  dayLong,
  groupByDay,
  monthTitle,
  projectColors,
  taskKey,
  todayKey,
  weekTitle,
  type CalFilter,
  type CalView,
  type DayKey,
} from "./calendarModel";
import { dueMenuEntries } from "./DueMenu";
import { MonthView } from "./MonthView";
import { useCalendarData } from "./useCalendarData";
import { calDragActive, useDueDrag } from "./useDueDrag";
import type { ViewProps } from "./viewTypes";
import { WeekView } from "./WeekView";
import "./calendar.css";

export const VIEW_SETTING_KEY = "calendar.view";
export const FILTER_SETTING_KEY = "calendar.filter";

const VIEWS: CalView[] = ["month", "week", "agenda"];
// Bawaan Semua proyek: orang yang baru membuka Kalender langsung melihat
// semua tenggat yang boleh ia lihat, lalu menyempit sendiri kalau perlu.
const DEFAULT_FILTER: CalFilter = { scope: "all", showDone: false };

function parseView(value: string | null): CalView {
  return value === "week" || value === "agenda" || value === "month" ? value : "month";
}

function parseFilter(value: string | null): CalFilter {
  if (!value) return DEFAULT_FILTER;
  try {
    const raw = JSON.parse(value) as { scope?: unknown; showDone?: unknown };
    const s = raw?.scope;
    const scope: CalFilter["scope"] =
      s === "mine" || s === "all"
        ? s
        : s && typeof s === "object" && typeof (s as { project?: unknown }).project === "string"
          ? { project: (s as { project: string }).project }
          : "all";
    return { scope, showDone: raw?.showDone === true };
  } catch {
    return DEFAULT_FILTER;
  }
}

function scopeValue(scope: CalFilter["scope"]): string {
  return typeof scope === "string" ? scope : `p:${scope.project}`;
}

function scopeFrom(value: string): CalFilter["scope"] {
  if (value === "mine" || value === "all") return value;
  return { project: value.slice(2) };
}

async function readSetting(key: string): Promise<string | null> {
  try {
    return await api.getSetting(key);
  } catch {
    return null;
  }
}

function saveSetting(key: string, value: string) {
  try {
    void api.setSetting(key, value).catch(() => {});
  } catch {
    // Pilihan tetap berlaku sampai layar ditutup; gagal simpan tidak mengganggu.
  }
}

type OpenTask = { projectId: string; taskId: string; key: string };
type Failure = { title: string; message: string };

const ARROWS: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

export function CalendarScreen({ me }: { me: string }) {
  useLang();
  const T = CAL_TEXT;
  const ids = useId();
  const rootRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const [ready, setReady] = useState(false);
  const [view, setView] = useState<CalView>("month");
  const [filter, setFilter] = useState<CalFilter>(DEFAULT_FILTER);
  const [anchor, setAnchor] = useState<DayKey>(() => todayKey());
  const [openTask, setOpenTask] = useState<OpenTask | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [menuTask, setMenuTask] = useState<CalTask | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  // Pengumuman pembaca layar; `n` naik supaya kalimat yang sama tetap dibacakan.
  const [say, setSay] = useState({ text: "", n: 0 });

  const today = todayKey();
  const data = useCalendarData(view, anchor, ready);
  const { reload, patchDue } = data;

  const announce = useCallback((text: string) => setSay((prev) => ({ text, n: prev.n + 1 })), []);

  // Pilihan tampilan dan saringan tersimpan dibaca dulu, supaya rentang yang
  // salah tidak sempat dimuat. Gagal baca berarti bawaan.
  useEffect(() => {
    let alive = true;
    void Promise.all([readSetting(VIEW_SETTING_KEY), readSetting(FILTER_SETTING_KEY)]).then(([v, f]) => {
      if (!alive) return;
      setView(parseView(v));
      setFilter(parseFilter(f));
      setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Proyek tersimpan yang sudah tidak terlihat (dikeluarkan, dihapus) kembali ke Semua proyek.
  const scope = filter.scope;
  useEffect(() => {
    if (typeof scope === "string" || !data.projects) return;
    if (!data.projects.some((p) => p.id === scope.project)) setFilter((f) => ({ ...f, scope: "all" }));
  }, [scope, data.projects]);

  // Fokus chip sudah dipasang tampilan pada render ini; kunci dilepas supaya
  // pemindahan berikutnya pada chip yang sama memfokusnya lagi.
  useEffect(() => {
    if (focusKey) setFocusKey(null);
  }, [focusKey]);

  const sorted = useMemo(
    () => [...(data.projects ?? [])].sort((a, b) => a.code.localeCompare(b.code)),
    [data.projects],
  );
  const colors = useMemo(() => projectColors(data.projects ?? []), [data.projects]);
  const byDay = useMemo(() => groupByDay(applyFilter(data.tasks, filter, me)), [data.tasks, filter, me]);
  const overdue = useMemo(() => applyFilter(data.overdue, filter, me), [data.overdue, filter, me]);

  const title = view === "week" ? weekTitle(anchor) : monthTitle(anchor);

  function changeView(next: CalView) {
    if (next === view) return;
    setView(next);
    saveSetting(VIEW_SETTING_KEY, next);
  }

  function changeFilter(next: CalFilter) {
    setFilter(next);
    saveSetting(FILTER_SETTING_KEY, JSON.stringify(next));
  }

  function go(next: DayKey) {
    setAnchor(next);
    announce(T.periode(view === "week" ? weekTitle(next) : monthTitle(next)));
  }

  function step(dir: -1 | 1) {
    go(view === "week" ? addDays(anchor, 7 * dir) : addMonths(anchor, dir));
  }

  const openChip = useCallback((t: CalTask) => {
    setOpenTask({ projectId: t.projectId, taskId: t.task.id, key: taskKey(t) });
  }, []);

  const setDue = useCallback(
    async (t: CalTask, due: DayKey | null) => {
      const code = t.task.code;
      if (!canMoveDue(t)) {
        announce(T.tanpaHakTenggat);
        return;
      }
      if (due === t.task.due) return;
      const key = taskKey(t);
      const before = t.task.due;
      patchDue(key, due);
      if (due) setFocusKey(key);
      try {
        await boardApi.updateTask(t.projectId, t.task.id, { due });
        setFailure(null);
        announce(due ? T.dipindah(code, dayLong(due)) : T.dihapus(code));
      } catch (err) {
        patchDue(key, before);
        setFocusKey(key);
        setFailure({ title: T.gagalUbah(code), message: toAppError(err).message });
      }
      reload();
    },
    [T, announce, patchDue, reload],
  );

  const drag = useDueDrag(rootRef, (t, day) => void setDue(t, day));

  const menu = useContextMenu({
    label: menuTask ? T.menu.label(menuTask.task.code) : T.judul,
    // Menu dibuka pada render yang sama dengan setMenuTask; daftar sementara
    // hanya menjaga menu tetap dianggap berisi sebelum itu.
    items: menuTask
      ? dueMenuEntries(menuTask, today, { setDue: (t, due) => void setDue(t, due), open: openChip })
      : [{ id: "open", label: T.menu.buka, onSelect: () => {} }],
  });

  function onContextMenu(e: MouseEvent<HTMLElement>, t: CalTask) {
    // Selama seret menu tidak dibuka, sama dengan board.
    if (calDragActive()) {
      e.preventDefault();
      return;
    }
    setMenuTask(t);
    menu.triggerProps.onContextMenu(e);
  }

  function onKeyDown(e: KeyboardEvent<HTMLElement>, t: CalTask) {
    const shift = ARROWS[e.key];
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && shift !== undefined) {
      // Alt+Panah kiri di WebView berarti Kembali; di chip artinya pindah tenggat.
      e.preventDefault();
      e.stopPropagation();
      if (!t.task.due) return;
      void setDue(t, addDays(t.task.due, shift));
      return;
    }
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      setMenuTask(t);
      menu.triggerProps.onKeyDown(e);
    }
  }

  // Setelah detail ditutup fokus kembali ke chip task itu. Kalau chip sudah
  // hilang (task dihapus, tenggat dikosongkan di detail), fokus ke judul
  // periode, tidak jatuh ke body. Dicek sesudah dialog selesai mengembalikan
  // fokusnya sendiri.
  const closedKey = useRef<string | null>(null);
  const [closedAt, setClosedAt] = useState(0);

  function closeTask() {
    const key = openTask?.key ?? null;
    closedKey.current = key;
    setOpenTask(null);
    setFocusKey(key);
    setClosedAt((n) => n + 1);
    reload();
  }

  useEffect(() => {
    if (closedAt === 0) return;
    const timer = window.setTimeout(() => {
      const root = rootRef.current;
      const active = document.activeElement;
      if (!root || (active && active !== document.body && root.contains(active))) return;
      const chip = Array.from(root.querySelectorAll<HTMLElement>("[data-cal-task]")).find(
        (el) => el.getAttribute("data-cal-task") === closedKey.current,
      );
      (chip ?? headingRef.current)?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [closedAt]);

  const viewProps: ViewProps = {
    anchor,
    today,
    byDay,
    colors,
    draggingKey: drag.draggingKey,
    dropDay: drag.dropDay,
    focusKey,
    onOpen: openChip,
    onPointerDown: drag.onPointerDown,
    onContextMenu,
    onKeyDown,
  };

  // Agenda tanpa data pertama tidak digambar, supaya kalimat "tidak ada task"
  // tidak muncul sebelum data datang atau saat data belum terbaca.
  const showView = view !== "agenda" || data.loaded;
  const busy = !ready || (data.loading && !data.error);

  return (
    <section className="cal" aria-labelledby={`${ids}-title`} ref={rootRef}>
      <header className="cal-head">
        <div className="cal-period">
          <div className="cal-nav">
            <button
              type="button"
              className="btn btn-ghost cal-icon-btn"
              aria-label={T.sebelumnya[view]}
              title={T.sebelumnya[view]}
              onClick={() => step(-1)}
            >
              <IconChevronLeft size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="btn btn-ghost cal-icon-btn"
              aria-label={T.berikutnya[view]}
              title={T.berikutnya[view]}
              onClick={() => step(1)}
            >
              <IconChevronRight size={18} aria-hidden="true" />
            </button>
            <button type="button" className="btn btn-ghost cal-today" onClick={() => go(todayKey())}>
              {T.hariIni}
            </button>
          </div>
          <h1 id={`${ids}-title`} className="cal-title" ref={headingRef} tabIndex={-1}>
            {title}
          </h1>
        </div>
        <div className="cal-tools">
          <div className="cal-switch" role="group" aria-label={T.tampilan}>
            {VIEWS.map((v) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => changeView(v)}>
                {T.namaTampilan[v]}
              </button>
            ))}
          </div>
          <div className="cal-scope">
            <label htmlFor={`${ids}-scope`}>{T.lihat}</label>
            <select
              id={`${ids}-scope`}
              value={scopeValue(filter.scope)}
              onChange={(e) => changeFilter({ ...filter, scope: scopeFrom(e.target.value) })}
            >
              <option value="mine">{T.taskSaya}</option>
              <option value="all">{T.semuaProyek}</option>
              {sorted.map((p) => (
                <option key={p.id} value={`p:${p.id}`}>
                  {T.opsiProyek(p.code, p.name)}
                </option>
              ))}
            </select>
          </div>
          <label className="cal-done">
            <input
              type="checkbox"
              checked={filter.showDone}
              onChange={(e) => changeFilter({ ...filter, showDone: e.target.checked })}
            />
            {T.tampilkanSelesai}
          </label>
        </div>
      </header>

      <div className="cal-statusbar">
        <p className="cal-loading" role="status">
          {busy ? T.memuat : ""}
        </p>
        <p className="cal-hint">{T.petunjuk}</p>
      </div>
      <div className="sr-only" role="status" aria-live="polite" data-testid="cal-say">
        <span key={say.n}>{say.text}</span>
      </div>

      <div className="cal-alerts" aria-live="polite">
        {failure && (
          <ErrorAlert title={failure.title}>
            <p>{failure.message}</p>
          </ErrorAlert>
        )}
      </div>
      {data.error && !data.loading && (
        <div className="cal-alerts" role="alert">
          <ErrorAlert title={T.belumTerbaca}>
            <p>{data.error.message || T.intiTanpaData}</p>
            {data.loaded && <p>{T.dataLama}</p>}
            <button type="button" className="btn btn-ghost btn-sm cal-retry" onClick={reload}>
              {T.cobaLagi}
            </button>
          </ErrorAlert>
        </div>
      )}

      <div className="cal-body" aria-busy={busy}>
        {showView && view === "month" && <MonthView {...viewProps} />}
        {showView && view === "week" && <WeekView {...viewProps} />}
        {showView && view === "agenda" && <AgendaView {...viewProps} overdue={overdue} />}
      </div>

      {menu.element}

      {openTask && (
        <TaskDetail
          projectId={openTask.projectId}
          taskId={openTask.taskId}
          onClose={closeTask}
          onChanged={reload}
        />
      )}
    </section>
  );
}
