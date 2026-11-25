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
  rangeFor,
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
// Teks Memuat baru dibacakan kalau muat ulang lebih lama dari ini; muat ulang
// cepat (misalnya setiap sinkron rekan) cukup ditandai aria-busy.
const SLOW_MS = 500;

// Milidetik sampai lewat tengah malam berikutnya (waktu lokal).
function msToMidnight(now = new Date()): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
  return Math.max(1000, next.getTime() - now.getTime());
}

function chipsFor(key: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-cal-task]")).filter(
    (el) => el.getAttribute("data-cal-task") === key,
  );
}

// Pengganti fokus untuk chip yang akan hilang (tenggat dihapus): chip
// berikutnya di hari atau daftar yang sama, kalau tidak ada chip sebelumnya,
// lalu hari itu sendiri sebagai cadangan.
function neighbourOf(key: string): { key: string | null; day: DayKey | null } {
  const active = document.activeElement;
  const el =
    active instanceof HTMLElement && active.getAttribute("data-cal-task") === key ? active : (chipsFor(key)[0] ?? null);
  if (!el) return { key: null, day: null };
  const cell = el.closest<HTMLElement>("[data-cal-day]");
  const box = cell ?? el.closest<HTMLElement>("ul, ol, [role=dialog]") ?? el.parentElement;
  const others = box
    ? Array.from(box.querySelectorAll<HTMLElement>("[data-cal-task]")).filter((c) => c.getAttribute("data-cal-task") !== key)
    : [];
  const next =
    others.find((c) => el.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING) ?? others[others.length - 1] ?? null;
  return { key: next?.getAttribute("data-cal-task") ?? null, day: cell?.getAttribute("data-cal-day") ?? null };
}

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
  const [today, setToday] = useState<DayKey>(() => todayKey());
  const [openTask, setOpenTask] = useState<OpenTask | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  // Fokus cadangan setelah render: tombol "+N lagi" di sel hari, atau judul periode.
  const [fallback, setFallback] = useState<{ day: DayKey | null; n: number } | null>(null);
  const [menuTask, setMenuTask] = useState<CalTask | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [slow, setSlow] = useState(false);
  // Pengumuman pembaca layar; `n` naik supaya kalimat yang sama tetap dibacakan.
  const [say, setSay] = useState({ text: "", n: 0 });

  const data = useCalendarData(view, anchor, ready, today);
  const { reload, patchDue } = data;
  const settleRef = useRef(data.settleDue);
  settleRef.current = data.settleDue;
  // Tampilan dan tanggal acuan terbaru, dibaca setelah inti menjawab.
  const viewRef = useRef(view);
  viewRef.current = view;
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;

  const announce = useCallback((text: string) => setSay((prev) => ({ text, n: prev.n + 1 })), []);
  const focusFallback = useCallback((day: DayKey | null) => setFallback((f) => ({ day, n: (f?.n ?? 0) + 1 })), []);

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

  // Lewat tengah malam: tanda hari ini, lewat tenggat, dan pilihan menu ikut berganti.
  useEffect(() => {
    const timer = window.setTimeout(() => setToday(todayKey()), msToMidnight());
    return () => window.clearTimeout(timer);
  }, [today]);

  useEffect(() => {
    if (!data.loading) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), SLOW_MS);
    return () => window.clearTimeout(timer);
  }, [data.loading]);

  // Proyek tersimpan yang sudah tidak terlihat (dikeluarkan, dihapus) kembali ke Semua proyek.
  const scope = filter.scope;
  useEffect(() => {
    if (typeof scope === "string" || !data.projects) return;
    if (!data.projects.some((p) => p.id === scope.project)) setFilter((f) => ({ ...f, scope: "all" }));
  }, [scope, data.projects]);

  const sorted = useMemo(
    () => [...(data.projects ?? [])].sort((a, b) => a.code.localeCompare(b.code)),
    [data.projects],
  );
  const colors = useMemo(() => projectColors(data.projects ?? []), [data.projects]);
  const byDay = useMemo(() => groupByDay(applyFilter(data.tasks, filter, me)), [data.tasks, filter, me]);
  const overdue = useMemo(() => applyFilter(data.overdue, filter, me), [data.overdue, filter, me]);
  const visible = useMemo(() => {
    const list = [...overdue];
    for (const day of byDay.values()) list.push(...day);
    return list;
  }, [byDay, overdue]);
  const anyMovable = visible.some(canMoveDue);

  // Task terbaru menurut kuncinya (dengan tenggat optimistis), untuk seret dan
  // menu yang dibuka sebelum data berubah.
  const byKey = useMemo(() => {
    const map = new Map<string, CalTask>();
    for (const t of [...data.tasks, ...data.overdue]) map.set(taskKey(t), t);
    return map;
  }, [data.tasks, data.overdue]);
  const currentRef = useRef(byKey);
  currentRef.current = byKey;

  // Chip yang harus difokus. Tampilan memfokusnya pada render saat chip itu
  // terlihat; kuncinya lalu dilepas supaya pemindahan berikutnya memfokusnya
  // lagi. Selama rentang baru dimuat (tenggat dipindah ke luar periode) kunci
  // ditahan; kalau data rentang itu sudah datang dan chip tetap tidak ada,
  // fokus pindah ke judul periode.
  const current = data.current;
  useEffect(() => {
    if (!focusKey) return;
    if (visible.some((t) => taskKey(t) === focusKey)) {
      setFocusKey(null);
      return;
    }
    if (current) {
      setFocusKey(null);
      focusFallback(null);
    }
  }, [focusKey, visible, current, focusFallback]);

  useEffect(() => {
    if (!fallback) return;
    const root = rootRef.current;
    const active = document.activeElement;
    if (!root || (active && active !== document.body && active.isConnected)) return;
    const cell = fallback.day
      ? Array.from(root.querySelectorAll<HTMLElement>("[data-cal-day]")).find(
          (el) => el.getAttribute("data-cal-day") === fallback.day,
        )
      : undefined;
    const more = cell?.querySelector<HTMLElement>("button:not([data-cal-task])") ?? null;
    (more ?? headingRef.current)?.focus();
  }, [fallback]);

  const title = view === "week" ? weekTitle(anchor) : monthTitle(anchor);

  function changeView(next: CalView) {
    if (next === view) return;
    setView(next);
    setFailure(null);
    saveSetting(VIEW_SETTING_KEY, next);
  }

  function changeFilter(next: CalFilter) {
    setFilter(next);
    saveSetting(FILTER_SETTING_KEY, JSON.stringify(next));
  }

  function go(next: DayKey) {
    setAnchor(next);
    setFailure(null);
    announce(T.periode(view === "week" ? weekTitle(next) : monthTitle(next)));
  }

  function step(dir: -1 | 1) {
    go(view === "week" ? addDays(anchor, 7 * dir) : addMonths(anchor, dir));
  }

  // Tenggat baru di luar periode yang tampil: periode ikut pindah ke tanggal
  // itu, supaya chip (dan fokusnya) tetap terlihat.
  const reveal = useCallback((day: DayKey) => {
    const { from, to } = rangeFor(viewRef.current, anchorRef.current);
    if (day >= from && day <= to) return;
    anchorRef.current = day;
    setAnchor(day);
  }, []);

  // Pembuka detail (chip di grid atau di daftar "+N lagi"), untuk fokus kembali ke sana.
  const openerRef = useRef<HTMLElement | null>(null);

  const openChip = useCallback((t: CalTask) => {
    const key = taskKey(t);
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement && active.getAttribute("data-cal-task") === key ? active : null;
    setOpenTask({ projectId: t.projectId, taskId: t.task.id, key });
  }, []);

  const setDue = useCallback(
    async (given: CalTask, due: DayKey | null) => {
      const key = taskKey(given);
      const t = currentRef.current.get(key) ?? given;
      const code = t.task.code;
      if (!canMoveDue(t)) {
        announce(T.tanpaHakTenggat);
        return;
      }
      if (due === t.task.due) return;
      const removal = due ? null : neighbourOf(key);
      const n = patchDue(t, due);
      if (due) {
        reveal(due);
        setFocusKey(key);
      } else if (removal?.key) {
        setFocusKey(removal.key);
      } else {
        focusFallback(removal?.day ?? null);
      }
      try {
        await boardApi.updateTask(t.projectId, t.task.id, { due });
        // Langkah lain pada task yang sama sudah menyusul: yang terakhir yang melapor.
        if (!settleRef.current(key, n, true).latest) return;
        setFailure(null);
        announce(due ? T.dipindah(code, dayLong(due)) : T.dihapus(code));
      } catch (err) {
        const settled = settleRef.current(key, n, false);
        if (!settled.latest) return;
        if (settled.due) {
          reveal(settled.due);
          setFocusKey(key);
        }
        setFailure({ title: T.gagalUbah(code), message: toAppError(err).message });
      }
    },
    [T, announce, patchDue, reveal, focusFallback],
  );

  const drag = useDueDrag(rootRef, (t, day) => void setDue(t, day), (key) => currentRef.current.get(key));

  const menuFor = menuTask ? (byKey.get(taskKey(menuTask)) ?? menuTask) : null;
  const menu = useContextMenu({
    label: menuFor ? T.menu.label(menuFor.task.code) : T.judul,
    // Menu dibuka pada render yang sama dengan setMenuTask; daftar sementara
    // hanya menjaga menu tetap dianggap berisi sebelum itu.
    items: menuFor
      ? dueMenuEntries(menuFor, today, { setDue: (t, due) => void setDue(t, due), open: openChip })
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
      const now = currentRef.current.get(taskKey(t)) ?? t;
      if (!now.task.due) return;
      void setDue(now, addDays(now.task.due, shift));
      return;
    }
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      setMenuTask(t);
      menu.triggerProps.onKeyDown(e);
    }
  }

  // Setelah detail ditutup fokus kembali ke pembukanya (chip di grid atau di
  // daftar "+N lagi"). Kalau pembuka sudah hilang, ke chip task itu; kalau chip
  // juga hilang (task dihapus, tenggat dikosongkan di detail), ke judul
  // periode. Dicek sesudah dialog selesai mengembalikan fokusnya sendiri.
  const closedKey = useRef<string | null>(null);
  const [closedAt, setClosedAt] = useState(0);

  function closeTask() {
    const key = openTask?.key ?? null;
    closedKey.current = key;
    setOpenTask(null);
    if (!openerRef.current?.isConnected) setFocusKey(key);
    setClosedAt((n) => n + 1);
    reload();
  }

  useEffect(() => {
    if (closedAt === 0) return;
    const timer = window.setTimeout(() => {
      const opener = openerRef.current;
      openerRef.current = null;
      if (opener?.isConnected) {
        if (document.activeElement !== opener) opener.focus();
        return;
      }
      const root = rootRef.current;
      const active = document.activeElement;
      if (!root || (active && active !== document.body && root.contains(active))) return;
      const chip = closedKey.current ? chipsFor(closedKey.current).find((el) => root.contains(el)) : undefined;
      (chip ?? headingRef.current)?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [closedAt]);

  function dismissFailure() {
    setFailure(null);
    headingRef.current?.focus();
  }

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
  const sayLoading = busy && (!data.loaded || slow);

  return (
    <section className="cal" aria-label={T.wilayah(title)} ref={rootRef}>
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
          {sayLoading ? T.memuat : ""}
        </p>
        {anyMovable && <p className="cal-hint">{T.petunjuk}</p>}
      </div>
      <div className="sr-only" role="status" aria-live="polite" data-testid="cal-say">
        <span key={say.n}>{say.text}</span>
      </div>

      <div className="cal-alerts" aria-live="polite">
        {failure && (
          <ErrorAlert title={failure.title}>
            <p>{failure.message}</p>
            <button type="button" className="btn btn-ghost btn-sm cal-retry" onClick={dismissFailure}>
              {T.tutupPesan}
            </button>
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
        <TaskDetail projectId={openTask.projectId} taskId={openTask.taskId} onClose={closeTask} onChanged={reload} />
      )}
    </section>
  );
}
