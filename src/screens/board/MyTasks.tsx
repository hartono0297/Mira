import { IconArrowsMove, IconChevronDown, IconChevronRight, IconCopy, IconFileText } from "@tabler/icons-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { toAppError, type AppError } from "../../api";
import { boardApi, subscribeBoard, type ColumnId, type MyTask } from "../../api/board";
import { ErrorAlert } from "../../components/ErrorAlert";
import { COLUMN_NAMES, COLUMN_ORDER, daysUntil, dueLabel } from "./format";
import { GROUP_TITLES, groupMyTasks, type GroupId } from "./myTasksGroups";
import { ReminderSettings } from "./ReminderSettings";
import { PriorityChip } from "./TaskDetail";
import { TEKS_MENU } from "./teksMenu";
import { boardMenuItems, submenu, useBoardMenu } from "./useBoardMenu";
import { useFocusRescue } from "./useFocusRescue";
import "./task.css";

export const MY_TASKS_POLL_MS = 15000;

type Props = {
  onOpenTask: (projectId: string, taskId: string) => void;
  // Detail task terbuka di atas halaman ini; fokus sedang dikunci di dialog.
  taskOpen?: boolean;
};

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

type RowProps = {
  item: MyTask;
  group: GroupId;
  now: Date;
  onOpen: (item: MyTask) => void;
  onMove: (item: MyTask, columnId: ColumnId) => void;
  onCopy: (code: string) => void;
};

// Satu baris Task saya, dengan menu klik kanan (juga Shift+F10). Klik kiri membuka task.
function MyTaskRow({ item, group, now, onOpen, onMove, onCopy }: RowProps) {
  const t = item.task;
  const late = t.due !== null && group !== "done" && (daysUntil(t.due, now) ?? 0) < 0;
  const txt = TEKS_MENU.taskSaya;
  const menu = useBoardMenu({
    label: txt.menu(t.code),
    items: boardMenuItems(
      { id: "open", label: txt.buka, icon: <IconFileText size={16} />, onSelect: () => onOpen(item) },
      // Tanpa hak tulis (tamu, atau sudah dikeluarkan dari proyek) pemindahan pasti ditolak inti.
      // undefined berarti data lama: tetap tampil.
      t.canEdit !== false &&
        submenu({
          id: "move",
          label: txt.pindahkan,
          menuLabel: txt.pindahkanMenu(t.code),
          icon: <IconArrowsMove size={16} />,
          items: COLUMN_ORDER.map((col) => ({
            id: col,
            label: COLUMN_NAMES[col],
            disabled: col === t.columnId && TEKS_MENU.kartu.sudahDiKolom,
            onSelect: () => onMove(item, col),
          })),
        }),
      { id: "copy", label: txt.salinKode(t.code), icon: <IconCopy size={16} />, onSelect: () => onCopy(t.code) },
    ),
  });
  return (
    <li data-rescue={`${item.projectId}-${t.id}`} {...menu.triggerProps}>
      <button type="button" className="mt-row" onClick={() => onOpen(item)}>
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
      {menu.element}
    </li>
  );
}

type Failure = { title: string; message: string };

// Halaman Task saya: task milik saya dari semua proyek, dikelompokkan menurut tenggat.
export function MyTasks({ onOpenTask, taskOpen = false }: Props) {
  const live = useMyTasks();
  const [showDone, setShowDone] = useState(false);
  const ids = useId();
  const rootRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Baris yang difokus bisa hilang saat muat ulang (task dihapus atau dialihkan rekan).
  const rescue = useFocusRescue(rootRef, { fallback: headingRef, paused: taskOpen });
  const now = new Date();
  const groups = live.data ? groupMyTasks(live.data, now) : [];
  const open = groups.filter((g) => g.id !== "done");
  const done = groups.find((g) => g.id === "done");

  // Pengumuman pembaca layar; `n` naik supaya kalimat yang sama tetap dibacakan.
  const [say, setSay] = useState({ text: "", n: 0 });
  const [failure, setFailure] = useState<Failure | null>(null);
  const { reload } = live;

  const announce = useCallback((text: string) => setSay((prev) => ({ text, n: prev.n + 1 })), []);

  const openItem = useCallback((item: MyTask) => onOpenTask(item.projectId, item.task.id), [onOpenTask]);

  const move = useCallback(
    async (item: MyTask, columnId: ColumnId) => {
      const code = item.task.code;
      try {
        await boardApi.moveTask(item.projectId, item.task.id, columnId, 0);
        setFailure(null);
        announce(TEKS_MENU.taskSaya.dipindah(code, COLUMN_NAMES[columnId]));
      } catch (err) {
        setFailure({ title: TEKS_MENU.taskSaya.gagalPindah(code), message: toAppError(err).message });
      }
      void reload();
    },
    [announce, reload],
  );

  const copy = useCallback(
    async (code: string) => {
      try {
        await navigator.clipboard.writeText(code);
        setFailure(null);
        announce(TEKS_MENU.kartu.disalin(code));
      } catch {
        setFailure({ title: TEKS_MENU.kartu.gagalSalin(code), message: TEKS_MENU.taskSaya.gagalSalinIsi });
      }
    },
    [announce],
  );

  function row(item: MyTask, group: GroupId) {
    return (
      <MyTaskRow
        key={`${item.projectId}-${item.task.id}`}
        item={item}
        group={group}
        now={now}
        onOpen={openItem}
        onMove={(i, col) => void move(i, col)}
        onCopy={(code) => void copy(code)}
      />
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
          <section key={g.id} className="mt-group" aria-labelledby={`${ids}-${g.id}`} data-rescue-group={g.id}>
            <h3 id={`${ids}-${g.id}`} className={`mt-group-title${g.id === "late" ? " td-late" : ""}`}>
              {GROUP_TITLES[g.id]} <span className="td-count">{g.items.length}</span>
            </h3>
            <ul className="mt-list">{g.items.map((item) => row(item, g.id))}</ul>
          </section>
        ))}
        {done && (
          <section className="mt-group" aria-labelledby={`${ids}-done`} data-rescue-group="done">
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
    <section className="mt" aria-labelledby={`${ids}-page`} ref={rootRef} {...rescue}>
      <header className="page-head mt-head">
        <h2 id={`${ids}-page`} className="page-title" ref={headingRef} tabIndex={-1}>
          Task saya
        </h2>
        <span className="page-sub">Task yang ditugaskan ke Anda, dikumpulkan dari semua proyek.</span>
      </header>
      <div className="sr-only mt-say" role="status" aria-live="polite">
        <span key={say.n}>{say.text}</span>
      </div>
      <div className="mt-layout">
        <div className="mt-body">
          <div aria-live="polite">
            {failure && (
              <ErrorAlert title={failure.title}>
                <p>{failure.message}</p>
              </ErrorAlert>
            )}
          </div>
          {list()}
        </div>
        <aside className="mt-aside">
          <ReminderSettings />
        </aside>
      </div>
    </section>
  );
}
