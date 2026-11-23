import { IconEye, IconKeyboard, IconPencil, IconPlus } from "@tabler/icons-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { toAppError, type AppError } from "../../api";
import { boardApi, type BoardView, type ColumnId, type ProjectSummary, type TaskDetail } from "../../api/board";
import { ErrorAlert } from "../../components/ErrorAlert";
import { BoardCard } from "./BoardCard";
import { applyMove, blockedText, locate, neighbourPlace, samePlace, type Direction, type Place } from "./boardMoves";
import { COLUMN_NAMES, teamLabel } from "./format";
import type { MoveOption } from "./MoveMenu";
import { QuickAdd } from "./QuickAdd";
import { RenameProjectDialog } from "./RenameProjectDialog";
import { useBoardLive } from "./useBoardLive";
import { useCardDrag } from "./useCardDrag";
import { useFocusRescue } from "./useFocusRescue";

export type ProjectBoardHandle = {
  // Dipanggil setelah task dihapus dari detail task: umumkan dan siapkan fokus.
  taskDeleted: (taskId: string, code: string) => void;
};

type Props = {
  projectId: string;
  // Naik setiap kali detail task mengubah sesuatu; board dimuat ulang.
  refreshKey: number;
  // Detail task sedang terbuka di atas board. Fokus yang tertunda dipasang setelah tertutup.
  taskOpen: boolean;
  // Fokus ke judul board setelah board pertama kali tampil (misalnya proyek baru).
  focusHeading?: boolean;
  onHeadingFocused?: () => void;
  onOpenTask: (taskId: string) => void;
  // Jumlah task terbuka di daftar proyek ikut berubah.
  onProjectsChanged: () => void;
  ref?: Ref<ProjectBoardHandle>;
};

type MoveFailure = { code: string; error: AppError };
type PendingMove = { seq: number; taskId: string; to: Place };
type FocusTarget = { kind: "card"; id: string } | { kind: "add"; columnId: ColumnId } | { kind: "heading" };

const EMPTY_DRAFTS: Record<ColumnId, string> = { todo: "", doing: "", done: "" };

function isBoardView(value: unknown): value is BoardView {
  return !!value && typeof value === "object" && Array.isArray((value as BoardView).columns) && !!(value as BoardView).project;
}

function moveErrorTitle(error: AppError, code: string): string {
  if (error.code === "forbidden") return `Anda tidak punya izin memindah ${code}`;
  if (error.code === "not_found") return `${code} sudah tidak ada di board ini`;
  return `${code} belum dipindah`;
}

function withoutTask(view: BoardView, taskId: string): BoardView {
  return { ...view, columns: view.columns.map((c) => ({ ...c, tasks: c.tasks.filter((t) => t.id !== taskId) })) };
}

// BoardScreen memasang komponen ini dengan key = id proyek, jadi ganti proyek
// selalu mulai dari keadaan bersih: pindahan proyek lama tidak ikut terbawa.
export function ProjectBoard({
  projectId,
  refreshKey,
  taskOpen,
  focusHeading,
  onHeadingFocused,
  onOpenTask,
  onProjectsChanged,
  ref,
}: Props) {
  const load = useCallback(() => boardApi.getBoard(projectId), [projectId]);
  const live = useBoardLive(load, projectId);
  const data = isBoardView(live.data) ? live.data : null;
  // Pindahan yang belum dijawab inti Rust, diterapkan berurutan di atas data
  // terakhir. Kalau satu gagal, hanya pindahan itu yang dibuang.
  const [pendingMoves, setPendingMoves] = useState<PendingMove[]>([]);
  const view = useMemo(
    () => (data ? pendingMoves.reduce((v, m) => applyMove(v, m.taskId, m.to), data) : null),
    [data, pendingMoves],
  );
  const viewRef = useRef(view);
  viewRef.current = view;

  const [adding, setAdding] = useState<ColumnId | null>(null);
  const [drafts, setDrafts] = useState<Record<ColumnId, string>>(EMPTY_DRAFTS);
  const [showKeys, setShowKeys] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [announce, setAnnounce] = useState({ text: "", n: 0 });
  const [failure, setFailure] = useState<MoveFailure | null>(null);
  const moveSeq = useRef(0);
  const mounted = useRef(true);
  const focusAfter = useRef<string | null>(null);
  const afterDialog = useRef<FocusTarget | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const keysId = useId();
  const titleId = useId();
  const { reload, setData } = live;
  const { dragId, drop, onPointerDown } = useCardDrag(rootRef, (taskId, to) => void move(taskId, to, false));
  // Rekan bisa memindah atau menghapus kartu yang sedang difokus; fokus pindah ke kartu terdekat.
  const rescue = useFocusRescue(rootRef, {
    spare: "[data-qa-open], [data-qa]",
    fallback: headingRef,
    paused: taskOpen,
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

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

  const hasView = !!view;
  useEffect(() => {
    if (!focusHeading || !hasView) return;
    // Ditunda satu giliran: dialog yang baru tertutup mengembalikan fokus ke tombol pembukanya dulu.
    const timer = window.setTimeout(() => {
      headingRef.current?.focus();
      onHeadingFocused?.();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focusHeading, hasView, onHeadingFocused]);

  function focusTarget(t: FocusTarget) {
    const root = rootRef.current;
    let el: HTMLElement | null = null;
    if (t.kind === "card") el = root?.querySelector<HTMLElement>(`[data-open-task="${t.id}"]`) ?? null;
    if (t.kind === "add")
      el =
        root?.querySelector<HTMLElement>(`[data-qa="${t.columnId}"]`) ??
        root?.querySelector<HTMLElement>(`[data-qa-open="${t.columnId}"]`) ??
        null;
    (el ?? headingRef.current)?.focus();
  }

  // Fokus setelah hapus dipasang sesudah dialog detail tertutup; selama dialog
  // terbuka, fokus terkunci di dalamnya.
  useEffect(() => {
    if (taskOpen || !afterDialog.current) return;
    const t = afterDialog.current;
    afterDialog.current = null;
    focusTarget(t);
  });

  function say(text: string) {
    setAnnounce((a) => ({ text, n: a.n + 1 }));
  }

  useImperativeHandle(ref, () => ({
    taskDeleted(taskId: string, code: string) {
      const current = viewRef.current;
      const at = current ? locate(current, taskId) : null;
      if (current && at) {
        const col = current.columns.find((c) => c.id === at.columnId);
        const next = col?.tasks[at.index + 1] ?? col?.tasks[at.index - 1];
        afterDialog.current = next
          ? { kind: "card", id: next.id }
          : current.canCreate
            ? { kind: "add", columnId: at.columnId }
            : { kind: "heading" };
      } else {
        afterDialog.current = { kind: "heading" };
      }
      if (data) setData(withoutTask(data, taskId));
      say(`${code} dihapus.`);
      void reload();
      onProjectsChanged();
    },
  }));

  async function move(taskId: string, to: Place, keepFocus: boolean) {
    const current = viewRef.current;
    if (!current || samePlace(current, taskId, to)) return;
    const next = applyMove(current, taskId, to);
    const placed = locate(next, taskId);
    if (!placed) return;
    const code = placed.task.code;
    const colName = next.columns.find((c) => c.id === to.columnId)?.name ?? COLUMN_NAMES[to.columnId];
    const seq = ++moveSeq.current;
    const target: Place = { columnId: to.columnId, index: placed.index };
    setPendingMoves((list) => [...list, { seq, taskId, to: target }]);
    setFailure(null);
    if (keepFocus) focusAfter.current = taskId;
    const settle = () => setPendingMoves((list) => list.filter((m) => m.seq !== seq));
    try {
      const result = await boardApi.moveTask(projectId, taskId, target.columnId, target.index);
      if (!mounted.current) return;
      say(`${code} dipindah ke ${colName}, posisi ${placed.index + 1} dari ${placed.size}.`);
      // Data akhir bisa memasang ulang kartu; fokus dikembalikan kalau belum pindah ke tempat lain.
      const active = document.activeElement;
      if (keepFocus && (!active || active === document.body || active.closest(`[data-card="${taskId}"]`)))
        focusAfter.current = taskId;
      // Hasil inti Rust sudah memuat pindahan ini; pindahan lain yang masih
      // berjalan tetap diterapkan di atasnya sampai dijawab.
      if (isBoardView(result) && result.project.id === projectId) setData(result);
      settle();
      void reload();
      onProjectsChanged();
    } catch (err) {
      if (!mounted.current) return;
      if (keepFocus) focusAfter.current = taskId;
      settle();
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

  function renamed(updated: ProjectSummary) {
    setRenaming(false);
    if (data) setData({ ...data, project: { ...data.project, ...updated } });
    say(`Nama proyek diubah menjadi ${updated.name}.`);
    void reload();
    onProjectsChanged();
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
  const readOnly = !view.canCreate;

  return (
    <div className="pb" ref={rootRef} {...rescue}>
      <header className="pb-head">
        <h2 id={titleId} className="pb-title" ref={headingRef} tabIndex={-1}>
          <span className="pb-code">{project.code}</span>{" "}
          {project.name}
        </h2>
        <span className="chip pb-team">
          <span className="sr-only">Terlihat oleh </span>
          {project.teamName ? teamLabel(project.teamName) : "Seluruh organisasi"}
        </span>
        <span className="page-sub">
          {project.taskCount} task, {project.openCount} belum selesai
        </span>
        <div className="pb-actions">
          {project.canManage && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRenaming(true)}>
              <IconPencil size={16} aria-hidden="true" />
              Ubah nama proyek
            </button>
          )}
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
              className="btn btn-ghost btn-sm"
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

      {readOnly && (
        <p className="pb-readonly">
          <IconEye size={16} aria-hidden="true" />
          Board ini hanya bisa dilihat. Anda bisa membuka task dan membaca komentarnya, tapi tidak bisa menambah, memindah,
          atau mengubah apa pun.
        </p>
      )}

      <div id={keysId} className="pb-keys" hidden={!showKeys}>
        <p>
          {readOnly
            ? "Pilih kartu dengan Tab, lalu Enter untuk membuka detailnya."
            : "Pilih kartu dengan Tab, lalu Enter untuk membuka detailnya. Alt + panah kiri atau kanan memindah kartu ke kolom sebelah, Alt + panah atas atau bawah mengubah urutannya. Tombol panah empat arah di kartu membuka pilihan yang sama."}
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

      <div className="pb-scroll" data-drop-area>
        <div className="pb-cols" aria-labelledby={titleId} role="group">
          {view.columns.map((col) => {
            const done = col.id === "done";
            const others = col.tasks.filter((t) => t.id !== dragId);
            const dropHere = drop && drop.columnId === col.id ? drop.index : null;
            let k = 0;
            return (
              <section
                key={col.id}
                data-rescue-group={col.id}
                data-drop-col={col.id}
                className={`pb-col${dropHere !== null ? " pb-col-over" : ""}`}
                aria-labelledby={`${titleId}-${col.id}`}
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
                        <li data-rescue={task.id}>
                          <BoardCard
                            task={task}
                            done={done}
                            canMove={view.canCreate}
                            dragging={isDragged}
                            moveOptions={moveOptions(task.id)}
                            onOpen={() => onOpenTask(task.id)}
                            onKeyMove={(dir) => keyMove(task.id, dir)}
                            onPointerDown={(e) => onPointerDown(e, task.id)}
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
                    draft={drafts[col.id]}
                    onDraftChange={(text) => setDrafts((d) => ({ ...d, [col.id]: text }))}
                    onOpenChange={(open) => setAdding(open ? col.id : null)}
                    onCreated={(t) => {
                      setDrafts((d) => ({ ...d, [col.id]: "" }));
                      void created(t);
                    }}
                  />
                )}
              </section>
            );
          })}
        </div>
      </div>

      {project.canManage && (
        <RenameProjectDialog open={renaming} onOpenChange={setRenaming} project={project} onRenamed={renamed} />
      )}
    </div>
  );
}
