import { IconKeyboard, IconPlus } from "@tabler/icons-react";
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type DragEvent } from "react";
import { toAppError, type AppError } from "../../api";
import { boardApi, type BoardView, type ColumnId, type TaskDetail } from "../../api/board";
import { ErrorAlert } from "../../components/ErrorAlert";
import { BoardCard } from "./BoardCard";
import { applyMove, blockedText, locate, neighbourPlace, samePlace, type Direction, type Place } from "./boardMoves";
import { COLUMN_NAMES } from "./format";
import type { MoveOption } from "./MoveMenu";
import { QuickAdd } from "./QuickAdd";
import { useBoardLive } from "./useBoardLive";

type Props = {
  projectId: string;
  // Naik setiap kali detail task mengubah sesuatu; board dimuat ulang.
  refreshKey: number;
  onOpenTask: (taskId: string) => void;
  // Jumlah task terbuka di daftar proyek ikut berubah.
  onProjectsChanged: () => void;
};

type MoveFailure = { code: string; error: AppError };

function isBoardView(value: unknown): value is BoardView {
  return !!value && typeof value === "object" && Array.isArray((value as BoardView).columns) && !!(value as BoardView).project;
}

function moveErrorTitle(error: AppError, code: string): string {
  if (error.code === "forbidden") return `Anda tidak punya izin memindah ${code}`;
  if (error.code === "not_found") return `${code} sudah tidak ada di board ini`;
  return `${code} belum dipindah`;
}

export function ProjectBoard({ projectId, refreshKey, onOpenTask, onProjectsChanged }: Props) {
  const load = useCallback(() => boardApi.getBoard(projectId), [projectId]);
  const live = useBoardLive(load, projectId);
  const data = isBoardView(live.data) ? live.data : null;
  const [optimistic, setOptimistic] = useState<BoardView | null>(null);
  const view = optimistic ?? data;
  const viewRef = useRef(view);
  viewRef.current = view;

  const [adding, setAdding] = useState<ColumnId | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  const [announce, setAnnounce] = useState({ text: "", n: 0 });
  const [failure, setFailure] = useState<MoveFailure | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const dragRef = useRef<string | null>(null);
  const [drop, setDrop] = useState<Place | null>(null);
  const pending = useRef(0);
  const focusAfter = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const keysId = useId();
  const titleId = useId();
  const { reload, setData } = live;

  // Proyek lain dipilih: tampilan optimis dan pesan dari proyek lama dibuang.
  useEffect(() => {
    setOptimistic(null);
    setFailure(null);
    setAdding(null);
    pending.current = 0;
  }, [projectId]);

  const firstKey = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey !== firstKey.current) void reload();
  }, [refreshKey, reload]);

  useLayoutEffect(() => {
    const id = focusAfter.current;
    if (!id) return;
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-open-task="${id}"]`);
    if (el) {
      focusAfter.current = null;
      el.focus();
    }
  });

  function say(text: string) {
    setAnnounce((a) => ({ text, n: a.n + 1 }));
  }

  async function move(taskId: string, to: Place, keepFocus: boolean) {
    const current = viewRef.current;
    if (!current || samePlace(current, taskId, to)) return;
    const next = applyMove(current, taskId, to);
    const placed = locate(next, taskId);
    if (!placed) return;
    const code = placed.task.code;
    const colName = next.columns.find((c) => c.id === to.columnId)?.name ?? COLUMN_NAMES[to.columnId];
    setOptimistic(next);
    setFailure(null);
    if (keepFocus) focusAfter.current = taskId;
    pending.current++;
    try {
      const result = await boardApi.moveTask(projectId, taskId, to.columnId, placed.index);
      pending.current = Math.max(0, pending.current - 1);
      say(`${code} dipindah ke ${colName}, posisi ${placed.index + 1} dari ${placed.size}.`);
      if (pending.current === 0) {
        // Data akhir bisa memasang ulang kartu; fokus dikembalikan kalau belum pindah ke tempat lain.
        const active = document.activeElement;
        if (keepFocus && (!active || active === document.body || active.closest(`[data-card="${taskId}"]`)))
          focusAfter.current = taskId;
        if (isBoardView(result)) setData(result);
        setOptimistic(null);
        void reload();
        onProjectsChanged();
      }
    } catch (err) {
      pending.current = Math.max(0, pending.current - 1);
      if (keepFocus) focusAfter.current = taskId;
      setOptimistic(null);
      setFailure({ code, error: toAppError(err) });
      say(`${code} belum dipindah.`);
      void reload();
    }
  }

  function keyMove(taskId: string, dir: Direction) {
    const current = viewRef.current;
    if (!current) return;
    const target = neighbourPlace(current, taskId, dir);
    if (!target) {
      const at = locate(current, taskId);
      if (at) say(blockedText(at.task.code, dir));
      return;
    }
    void move(taskId, target, true);
  }

  function moveOptions(taskId: string): MoveOption[] {
    const current = viewRef.current;
    const at = current ? locate(current, taskId) : null;
    if (!current || !at) return [];
    const opts: MoveOption[] = current.columns
      .filter((c) => c.id !== at.columnId)
      .map((c) => ({
        key: `col-${c.id}`,
        label: `Ke ${c.name}`,
        run: () => void move(taskId, { columnId: c.id, index: 0 }, true),
      }));
    if (at.index > 0)
      opts.push({ key: "up", label: "Naik satu posisi", run: () => void move(taskId, { columnId: at.columnId, index: at.index - 1 }, true) });
    if (at.index < at.size - 1)
      opts.push({ key: "down", label: "Turun satu posisi", run: () => void move(taskId, { columnId: at.columnId, index: at.index + 1 }, true) });
    return opts;
  }

  // Drag-and-drop HTML5. Posisi tujuan dihitung dari titik tengah kartu lain di kolom itu.
  function onDragStart(e: DragEvent<HTMLElement>, taskId: string) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", taskId);
    dragRef.current = taskId;
    // Ditunda supaya gambar seret diambil dari kartu yang belum diredupkan.
    window.setTimeout(() => {
      if (dragRef.current === taskId) setDragId(taskId);
    }, 0);
  }

  function endDrag() {
    dragRef.current = null;
    setDragId(null);
    setDrop(null);
  }

  function onDragOver(e: DragEvent<HTMLElement>, columnId: ColumnId) {
    const id = dragRef.current;
    if (!id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const cards = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-card]")).filter((el) => el.dataset.card !== id);
    let index = cards.length;
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) {
        index = i;
        break;
      }
    }
    if (!drop || drop.columnId !== columnId || drop.index !== index) setDrop({ columnId, index });
  }

  function onDrop(e: DragEvent<HTMLElement>, columnId: ColumnId) {
    e.preventDefault();
    const id = dragRef.current ?? e.dataTransfer.getData("text/plain");
    const to = drop && drop.columnId === columnId ? drop : { columnId, index: 0 };
    endDrag();
    if (id) void move(id, to, false);
  }

  function onDragLeave(e: DragEvent<HTMLElement>, columnId: ColumnId) {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDrop((d) => (d && d.columnId === columnId ? null : d));
  }

  async function created(task: TaskDetail) {
    say(`${task.code} dibuat di ${COLUMN_NAMES[task.columnId] ?? task.columnId}.`);
    await reload();
    onProjectsChanged();
  }

  if (!view) {
    if (live.loading)
      return (
        <p className="bd-pad hint" role="status">
          Memuat board...
        </p>
      );
    const notFound = live.error?.code === "not_found";
    return (
      <div className="bd-pad bd-narrow" role="alert">
        <ErrorAlert title={notFound ? "Proyek ini tidak ditemukan" : "Board belum terbaca"}>
          <p>{live.error?.message ?? "Inti Mira tidak mengirim data board."}</p>
          <p>{notFound ? "Pilih proyek lain dari daftar di kiri." : "Tunggu sebentar lalu coba lagi. Data tersimpan di laptop ini, tidak ada yang hilang."}</p>
          <button type="button" className="btn btn-ghost btn-sm bd-retry" onClick={() => void reload()}>
            Coba lagi
          </button>
        </ErrorAlert>
      </div>
    );
  }

  const { project } = view;

  return (
    <div className="pb" ref={rootRef}>
      <header className="pb-head">
        <h2 id={titleId} className="pb-title">
          <span className="pb-code">{project.code}</span>{" "}
          {project.name}
        </h2>
        <span className="page-sub">
          {project.taskCount} task, {project.openCount} belum selesai
        </span>
        <div className="pb-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-expanded={showKeys}
            aria-controls={keysId}
            onClick={() => setShowKeys((v) => !v)}
          >
            <IconKeyboard size={16} aria-hidden="true" />
            Pintasan keyboard
          </button>
          {view.canCreate && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                if (adding === "todo") rootRef.current?.querySelector<HTMLInputElement>('[data-qa="todo"]')?.focus();
                else setAdding("todo");
              }}
            >
              <IconPlus size={16} aria-hidden="true" />
              Task baru
            </button>
          )}
        </div>
      </header>

      <div id={keysId} className="pb-keys" hidden={!showKeys}>
        <p>
          Pilih kartu dengan Tab, lalu Enter untuk membuka detailnya. Alt + panah kiri atau kanan memindah kartu ke kolom
          sebelah, Alt + panah atas atau bawah mengubah urutannya. Tombol panah empat arah di kartu membuka pilihan yang sama.
        </p>
      </div>

      <div className="sr-only" role="status" aria-live="polite">
        <span key={announce.n}>{announce.text}</span>
      </div>

      <div aria-live="polite" className="pb-live">
        {live.error && (
          <p className="hint">Data terbaru belum terbaca ({live.error.message}). Yang tampil adalah data terakhir.</p>
        )}
        {failure && (
          <ErrorAlert title={moveErrorTitle(failure.error, failure.code)}>
            <p>{failure.error.message}</p>
            <p>Kartu dikembalikan ke tempat semula.</p>
          </ErrorAlert>
        )}
      </div>

      <div className="pb-scroll">
        <div className="pb-cols" aria-labelledby={titleId} role="group">
          {view.columns.map((col) => {
            const done = col.id === "done";
            const others = col.tasks.filter((t) => t.id !== dragId);
            const dropHere = drop && drop.columnId === col.id ? drop.index : null;
            let k = 0;
            return (
              <section
                key={col.id}
                className={`pb-col${dropHere !== null ? " pb-col-over" : ""}`}
                aria-labelledby={`${titleId}-${col.id}`}
                onDragOver={(e) => onDragOver(e, col.id)}
                onDrop={(e) => onDrop(e, col.id)}
                onDragLeave={(e) => onDragLeave(e, col.id)}
              >
                <h3 id={`${titleId}-${col.id}`} className="pb-colh">
                  {col.name}
                  <span className="pb-count">
                    <span className="sr-only">, </span>
                    {col.tasks.length}
                    <span className="sr-only"> task</span>
                  </span>
                </h3>
                <ul className="pb-list">
                  {col.tasks.map((task) => {
                    const isDragged = task.id === dragId;
                    const marker = !isDragged && dropHere === k;
                    if (!isDragged) k++;
                    return (
                      <Fragment key={task.id}>
                        {marker && <li className="pb-drop" aria-hidden="true" />}
                        <li>
                          <BoardCard
                            task={task}
                            done={done}
                            canMove={view.canCreate}
                            dragging={isDragged}
                            moveOptions={moveOptions(task.id)}
                            onOpen={() => onOpenTask(task.id)}
                            onKeyMove={(dir) => keyMove(task.id, dir)}
                            onDragStart={(e) => onDragStart(e, task.id)}
                            onDragEnd={endDrag}
                          />
                        </li>
                      </Fragment>
                    );
                  })}
                  {dropHere !== null && dropHere >= others.length && <li className="pb-drop" aria-hidden="true" />}
                </ul>
                {col.tasks.length === 0 && dropHere === null && <p className="pb-empty">Belum ada task di kolom ini.</p>}
                {view.canCreate && (
                  <QuickAdd
                    projectId={projectId}
                    columnId={col.id}
                    columnName={col.name}
                    open={adding === col.id}
                    onOpenChange={(open) => setAdding(open ? col.id : null)}
                    onCreated={(t) => void created(t)}
                  />
                )}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
