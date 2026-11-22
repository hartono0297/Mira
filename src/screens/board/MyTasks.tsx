import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { toAppError, type AppError } from "../../api";
import { boardApi, subscribeBoard, type MyTask } from "../../api/board";
import { ErrorAlert } from "../../components/ErrorAlert";
import { COLUMN_NAMES, daysUntil, dueLabel } from "./format";
import { GROUP_TITLES, groupMyTasks, type GroupId } from "./myTasksGroups";
import { ReminderSettings } from "./ReminderSettings";
import { PriorityChip } from "./TaskDetail";
import "./task.css";

export const MY_TASKS_POLL_MS = 15000;

type Props = { onOpenTask: (projectId: string, taskId: string) => void };

function useMyTasks() {
  const [data, setData] = useState<MyTask[] | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = await boardApi.myTasks();
      if (!alive.current || mine !== seq.current) return;
      setData(Array.isArray(next) ? next : []);
      setError(null);
    } catch (err) {
      if (!alive.current || mine !== seq.current) return;
      setError(toAppError(err));
    } finally {
      if (alive.current && mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void reload();
    const stop = subscribeBoard(() => void reload());
    const timer = window.setInterval(() => void reload(), MY_TASKS_POLL_MS);
    return () => {
      alive.current = false;
      stop();
      window.clearInterval(timer);
    };
  }, [reload]);

  return { data, error, loading, reload, setLoading };
}

// Halaman Task saya: task milik saya dari semua proyek, dikelompokkan menurut tenggat.
export function MyTasks({ onOpenTask }: Props) {
  const live = useMyTasks();
  const [showDone, setShowDone] = useState(false);
  const ids = useId();
  const now = new Date();
  const groups = live.data ? groupMyTasks(live.data, now) : [];
  const open = groups.filter((g) => g.id !== "done");
  const done = groups.find((g) => g.id === "done");

  function row(item: MyTask, group: GroupId) {
    const t = item.task;
    const late = t.due !== null && group !== "done" && (daysUntil(t.due, now) ?? 0) < 0;
    return (
      <li key={`${item.projectId}-${t.id}`}>
        <button type="button" className="mt-row" onClick={() => onOpenTask(item.projectId, t.id)}>
          <span className="mt-code">{t.code}</span>
          <span className="mt-main">
            <span className="mt-title">{t.title}</span>
            <span className="mt-meta">
              <span>{item.projectName}</span>
              <span>{COLUMN_NAMES[t.columnId] ?? t.columnId}</span>
            </span>
          </span>
          <span className="mt-side">
            {t.due && <span className={`mt-due${late ? " td-late" : ""}`}>{dueLabel(t.due, now)}</span>}
            {t.priority !== "none" && <PriorityChip priority={t.priority} />}
          </span>
        </button>
      </li>
    );
  }

  function list() {
    if (live.loading && !live.data) {
      return (
        <p className="hint" role="status">
          Memuat task Anda...
        </p>
      );
    }
    if (!live.data) {
      return (
        <div role="alert">
          <ErrorAlert title="Task Anda belum terbaca">
            <p>{live.error?.message ?? "Inti Mira tidak mengirim daftar task."}</p>
            <p>Coba baca lagi. Kalau tetap gagal, tutup Mira lalu buka lagi.</p>
            <button
              type="button"
              className="btn btn-ghost btn-sm rem-retry"
              onClick={() => {
                live.setLoading(true);
                void live.reload();
              }}
            >
              Coba lagi
            </button>
          </ErrorAlert>
        </div>
      );
    }
    if (live.data.length === 0) {
      return (
        <div className="mt-empty">
          <p>
            <strong>Belum ada task untuk Anda.</strong>
          </p>
          <p>Task yang ditugaskan ke Anda di board proyek akan muncul di sini.</p>
        </div>
      );
    }
    return (
      <>
        {live.error && (
          <p className="hint">Data terbaru belum terbaca ({live.error.message}). Yang tampil adalah data terakhir.</p>
        )}
        {open.length === 0 && <p className="mt-allclear">Semua task Anda sudah selesai.</p>}
        {open.map((g) => (
          <section key={g.id} className="mt-group" aria-labelledby={`${ids}-${g.id}`}>
            <h3 id={`${ids}-${g.id}`} className={`mt-group-title${g.id === "late" ? " td-late" : ""}`}>
              {GROUP_TITLES[g.id]} <span className="td-count">{g.items.length}</span>
            </h3>
            <ul className="mt-list">{g.items.map((item) => row(item, g.id))}</ul>
          </section>
        ))}
        {done && (
          <section className="mt-group" aria-labelledby={`${ids}-done`}>
            <h3 id={`${ids}-done`} className="mt-group-title">
              <button
                type="button"
                className="mt-disclosure"
                aria-expanded={showDone}
                aria-controls={`${ids}-done-list`}
                onClick={() => setShowDone((v) => !v)}
              >
                {showDone ? (
                  <IconChevronDown size={18} aria-hidden="true" />
                ) : (
                  <IconChevronRight size={18} aria-hidden="true" />
                )}
                {GROUP_TITLES.done} <span className="td-count">{done.items.length}</span>
              </button>
            </h3>
            <ul id={`${ids}-done-list`} className="mt-list" hidden={!showDone}>
              {showDone && done.items.map((item) => row(item, "done"))}
            </ul>
          </section>
        )}
      </>
    );
  }

  return (
    <section className="mt" aria-labelledby={`${ids}-page`}>
      <header className="page-head mt-head">
        <h2 id={`${ids}-page`} className="page-title">
          Task saya
        </h2>
        <span className="page-sub">Task yang ditugaskan ke Anda, dikumpulkan dari semua proyek.</span>
      </header>
      <div className="mt-layout">
        <div className="mt-body">{list()}</div>
        <aside className="mt-aside">
          <ReminderSettings />
        </aside>
      </div>
    </section>
  );
}
