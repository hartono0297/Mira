// Data layar Kalender: task bertenggat di rentang tampilan, grup lewat tenggat
// untuk Agenda yang memuat hari ini, dan daftar proyek untuk saringan dan warna.
// Muat ulang saat rentang atau hari ini berubah dan saat board berubah
// (subscribeBoard). Jawaban lama yang datang belakangan dibuang (nomor
// permintaan), dan data lama tetap tampil selama rentang baru dimuat.
//
// Pindah tenggat tampil optimistis lewat lapisan `pending` di atas data inti:
// - patchDue memasang tenggat baru dan memberi nomor langkah;
// - settleDue(ok) menandai langkah itu tersimpan (lapisan dilepas setelah muat
//   ulang berikutnya membawa tenggat dari inti) atau gagal (lapisan dilepas,
//   tenggat kembali ke nilai inti).
// Hanya langkah terakhir per task yang boleh melepas lapisannya, jadi Alt+Panah
// beruntun yang langkah awalnya gagal tidak membatalkan langkah yang berhasil.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toAppError, type AppError } from "../../api";
import { boardApi, subscribeBoard, type ProjectSummary } from "../../api/board";
import { calendarApi, type CalTask } from "../../api/calendar";
import { addDays, rangeFor, taskKey, todayKey, type CalView, type DayKey } from "./calendarModel";

type Range = { from: DayKey; to: DayKey };

type Loaded = {
  // Hasil rentang lalu hasil lewat tenggat, tanpa ganda.
  known: CalTask[];
  // Rentang milik data ini (bukan rentang yang sedang diminta).
  range: Range;
  // Grup lewat tenggat ikut ditampilkan.
  late: boolean;
};

type Pending = {
  task: CalTask;
  seq: number;
  // Lapisan dilepas oleh muat ulang bernomor ini atau sesudahnya.
  releaseAt: number | null;
};

export type Settled = {
  // Langkah ini yang terakhir untuk task itu.
  latest: boolean;
  // Tenggat yang tampil sekarang (nilai inti kalau langkah gagal dilepas).
  due: DayKey | null;
};

export type CalendarData = {
  tasks: CalTask[];
  overdue: CalTask[];
  // Data pertama sudah datang.
  loaded: boolean;
  // Data yang tampil milik rentang yang sedang diminta dan tidak sedang dimuat.
  current: boolean;
  loading: boolean;
  error: AppError | null;
  projects: ProjectSummary[] | null;
  reload: () => void;
  // Pasang tenggat baru secara optimistis. null = tenggat dihapus.
  patchDue: (t: CalTask, due: DayKey | null) => number;
  settleDue: (key: string, seq: number, ok: boolean) => Settled;
};

function withLate(view: CalView, range: Range, today: DayKey): boolean {
  return view === "agenda" && range.from <= today && today <= range.to;
}

export function useCalendarData(
  view: CalView,
  anchor: DayKey,
  enabled = true,
  today: DayKey = todayKey(),
): CalendarData {
  const { from, to } = rangeFor(view, anchor);
  const late = withLate(view, { from, to }, today);

  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [pendingVersion, setPendingVersion] = useState(0);
  const pending = useRef(new Map<string, Pending>());
  const moveSeq = useRef(0);
  const seq = useRef(0);
  const projectSeq = useRef(0);
  const alive = useRef(true);

  // Permintaan terakhir dibaca lewat ref, supaya subscribeBoard cukup dipasang sekali.
  const want = useRef({ from, to, late });
  want.current = { from, to, late };

  const bump = useCallback(() => setPendingVersion((n) => n + 1), []);

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
      for (const [k, p] of pending.current) if (p.releaseAt !== null && mine >= p.releaseAt) pending.current.delete(k);
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
  }, [enabled, from, to, late, today, load]);

  useEffect(() => {
    if (!enabled) return;
    void loadProjects();
    return subscribeBoard(() => {
      void load();
      void loadProjects();
    });
  }, [enabled, load, loadProjects]);

  const patchDue = useCallback(
    (t: CalTask, due: DayKey | null) => {
      const key = taskKey(t);
      const n = ++moveSeq.current;
      const base = pending.current.get(key)?.task ?? t;
      pending.current.set(key, { task: { ...base, task: { ...base.task, due } }, seq: n, releaseAt: null });
      bump();
      return n;
    },
    [bump],
  );

  const reload = useCallback(() => {
    void load();
    void loadProjects();
  }, [load, loadProjects]);

  const known = data?.known;
  const settleDue = useCallback(
    (key: string, n: number, ok: boolean): Settled => {
      const p = pending.current.get(key);
      const serverDue = known?.find((t) => taskKey(t) === key)?.task.due ?? null;
      if (!p || p.seq !== n) return { latest: false, due: p ? p.task.task.due : serverDue };
      if (ok) {
        // Dilepas oleh muat ulang yang dimulai sesudah inti menyimpan.
        p.releaseAt = seq.current + 1;
        void load();
        return { latest: true, due: p.task.task.due };
      }
      pending.current.delete(key);
      bump();
      void load();
      return { latest: true, due: serverDue };
    },
    [known, load, bump],
  );

  const shown = useMemo(() => {
    void pendingVersion;
    if (!data) return { tasks: [] as CalTask[], overdue: [] as CalTask[] };
    const { range } = data;
    const merged: CalTask[] = [];
    const seen = new Set<string>();
    for (const t of data.known) {
      const k = taskKey(t);
      seen.add(k);
      merged.push(pending.current.get(k)?.task ?? t);
    }
    for (const [k, p] of pending.current) if (!seen.has(k)) merged.push(p.task);
    const tasks = merged.filter((t) => !!t.task.due && t.task.due >= range.from && t.task.due <= range.to);
    const overdue = data.late
      ? merged.filter((t) => !!t.task.due && t.task.due < range.from && t.task.columnId !== "done")
      : [];
    return { tasks, overdue };
  }, [data, pendingVersion]);

  return {
    tasks: shown.tasks,
    overdue: shown.overdue,
    loaded: data !== null,
    current: enabled && !loading && data !== null && data.range.from === from && data.range.to === to,
    loading: enabled ? loading : true,
    error,
    projects,
    reload,
    patchDue,
    settleDue,
  };
}
