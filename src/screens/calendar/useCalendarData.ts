// Data layar Kalender: task bertenggat di rentang tampilan, grup lewat tenggat
// untuk Agenda yang memuat hari ini, dan daftar proyek untuk saringan dan warna.
// Muat ulang saat rentang berubah dan saat board berubah (subscribeBoard).
// Jawaban lama yang datang belakangan dibuang (nomor permintaan), dan data
// lama tetap tampil selama rentang baru dimuat.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toAppError, type AppError } from "../../api";
import { boardApi, subscribeBoard, type ProjectSummary } from "../../api/board";
import { calendarApi, type CalTask } from "../../api/calendar";
import { addDays, rangeFor, taskKey, todayKey, type CalView, type DayKey } from "./calendarModel";

type Range = { from: DayKey; to: DayKey };

type Loaded = {
  // Semua task yang diketahui: hasil rentang lalu hasil lewat tenggat (tanpa
  // ganda). Ubah tenggat optimistis hanya mengganti `due` di sini, jadi task
  // yang dipindah ke luar rentang tetap bisa dikembalikan kalau gagal.
  known: CalTask[];
  // Rentang milik data ini (bukan rentang yang sedang diminta).
  range: Range;
  // Grup lewat tenggat ikut ditampilkan.
  late: boolean;
};

export type CalendarData = {
  tasks: CalTask[];
  overdue: CalTask[];
  // Data pertama sudah datang.
  loaded: boolean;
  loading: boolean;
  error: AppError | null;
  projects: ProjectSummary[] | null;
  reload: () => void;
  // Ubah tenggat secara optimistis. null = tenggat dihapus.
  patchDue: (key: string, due: DayKey | null) => void;
};

function withLate(view: CalView, range: Range, today: DayKey): boolean {
  return view === "agenda" && range.from <= today && today <= range.to;
}

export function useCalendarData(view: CalView, anchor: DayKey, enabled = true): CalendarData {
  const { from, to } = rangeFor(view, anchor);
  const today = todayKey();
  const late = withLate(view, { from, to }, today);

  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const seq = useRef(0);
  const projectSeq = useRef(0);
  const alive = useRef(true);

  // Permintaan terakhir dibaca lewat ref, supaya subscribeBoard cukup dipasang sekali.
  const want = useRef({ from, to, late });
  want.current = { from, to, late };

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const { from: f, to: t, late: withOverdue } = want.current;
    setLoading(true);
    try {
      const [main, before] = await Promise.all([
        calendarApi.tasks(f, t),
        withOverdue ? calendarApi.tasks(null, addDays(f, -1)) : Promise.resolve([] as CalTask[]),
      ]);
      if (!alive.current || mine !== seq.current) return;
      const seen = new Set<string>();
      const known: CalTask[] = [];
      for (const item of [...(Array.isArray(main) ? main : []), ...(Array.isArray(before) ? before : [])]) {
        const k = taskKey(item);
        if (seen.has(k)) continue;
        seen.add(k);
        known.push(item);
      }
      setData({ known, range: { from: f, to: t }, late: withOverdue });
      setError(null);
    } catch (err) {
      if (!alive.current || mine !== seq.current) return;
      setError(toAppError(err));
    } finally {
      if (alive.current && mine === seq.current) setLoading(false);
    }
  }, []);

  const loadProjects = useCallback(async () => {
    const mine = ++projectSeq.current;
    try {
      const list = await boardApi.listProjects();
      if (!alive.current || mine !== projectSeq.current) return;
      setProjects(Array.isArray(list) ? list : []);
    } catch {
      // Tanpa daftar proyek saringan hanya punya Task saya dan Semua proyek, dan
      // warna proyek memakai warna pertama. Kalender tetap bisa dipakai.
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, from, to, late, load]);

  useEffect(() => {
    if (!enabled) return;
    void loadProjects();
    return subscribeBoard(() => {
      void load();
      void loadProjects();
    });
  }, [enabled, load, loadProjects]);

  const patchDue = useCallback((key: string, due: DayKey | null) => {
    setData((prev) =>
      prev
        ? { ...prev, known: prev.known.map((t) => (taskKey(t) === key ? { ...t, task: { ...t.task, due } } : t)) }
        : prev,
    );
  }, []);

  const reload = useCallback(() => {
    void load();
    void loadProjects();
  }, [load, loadProjects]);

  const shown = useMemo(() => {
    if (!data) return { tasks: [] as CalTask[], overdue: [] as CalTask[] };
    const { known, range } = data;
    const tasks = known.filter((t) => !!t.task.due && t.task.due >= range.from && t.task.due <= range.to);
    const overdue = data.late
      ? known.filter((t) => !!t.task.due && t.task.due < range.from && t.task.columnId !== "done")
      : [];
    return { tasks, overdue };
  }, [data]);

  return {
    tasks: shown.tasks,
    overdue: shown.overdue,
    loaded: data !== null,
    loading: enabled ? loading : true,
    error,
    projects,
    reload,
    patchDue,
  };
}
