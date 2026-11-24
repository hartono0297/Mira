import { IconEye, IconKeyboard, IconPencil, IconPlus, IconUsers } from "@tabler/icons-react";
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
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import { toAppError, type AppError } from "../../api";
import {
  boardApi,
  type BoardView,
  type ColumnId,
  type ProjectSummary,
  type TaskCard,
  type TaskDetail,
  type TaskPatch,
} from "../../api/board";
import { useContextMenu, type MenuEntry } from "../../components/ContextMenu";
import { ErrorAlert } from "../../components/ErrorAlert";
import { BoardCard } from "./BoardCard";
import { applyMove, blockedText, locate, neighbourPlace, samePlace, type Direction, type Place } from "./boardMoves";
import { cardDragActive, cardMenuEntries, type CardMenuActions } from "./cardMenu";
import { columnLabel, teamLabel } from "./format";
import type { MoveOption } from "./MoveMenu";
import { ProjectMembersPanel, useProjectMembers } from "./ProjectMembersPanel";
import { QuickAdd } from "./QuickAdd";
import { RenameProjectDialog } from "./RenameProjectDialog";
import { TEKS, TEKS_LAYAR, teksDialog } from "./teks";
import { TEKS_MENU } from "./teksMenu";
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
  // Saya bukan anggota proyek ini lagi: keluar sendiri lewat panel Anggota, atau
  // inti Rust menolak membuka board-nya (dikeluarkan pengelola).
  // Dipanggil dengan id proyek, supaya pemanggil bisa memberi callback yang stabil.
  onLost?: (projectId: string, reason: "left" | "forbidden") => void;
  // Permintaan dari luar (menu klik kanan proyek di daftar kiri): buka panel
  // Anggota atau dialog Ubah nama proyek. Dijalankan setiap kali n berubah,
  // juga saat board baru pertama kali tampil dengan permintaan itu.
  request?: { kind: "members" | "rename"; n: number };
  ref?: Ref<ProjectBoardHandle>;
};

// Galat aksi kartu (pindah, ubah dari menu klik kanan, salin kode) di area pb-live.
type Failure = { title: string; message: string; note?: string };
type PendingMove = { seq: number; taskId: string; to: Place };
type FocusTarget = { kind: "card"; id: string } | { kind: "add"; columnId: ColumnId } | { kind: "heading" };

const EMPTY_DRAFTS: Record<ColumnId, string> = { todo: "", doing: "", done: "" };

function isBoardView(value: unknown): value is BoardView {
  return !!value && typeof value === "object" && Array.isArray((value as BoardView).columns) && !!(value as BoardView).project;
}

function moveErrorTitle(error: AppError, code: string): string {
  const T = TEKS_LAYAR.board;
  if (error.code === "forbidden") return T.tidakBerizinPindah(code);
  if (error.code === "not_found") return T.sudahTidakAda(code);
  return T.belumDipindah(code);
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
  onLost,
  request,
  ref,
}: Props) {
  const load = useCallback(() => boardApi.getBoard(projectId), [projectId]);
  const live = useBoardLive(load, projectId);
  const data = isBoardView(live.data) ? live.data : null;
  const dataRef = useRef(data);
  dataRef.current = data;
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
  const [showMembers, setShowMembers] = useState(false);
  const members = useProjectMembers(projectId);
  const [announce, setAnnounce] = useState({ text: "", n: 0 });
  const [failure, setFailure] = useState<Failure | null>(null);
  const moveSeq = useRef(0);
  // Task yang dihapus dari board ini (menu kartu atau detail task).
  const deletedIds = useRef(new Set<string>());
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

  // Dikeluarkan dari proyek saat board terbuka: inti Rust menolak dengan forbidden.
  const forbidden = live.error?.code === "forbidden";
  useEffect(() => {
    if (forbidden) onLost?.(projectId, "forbidden");
  }, [forbidden, onLost, projectId]);

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

  const handledRequest = useRef<number | null>(null);
  const canManage = !!view?.project.canManage;
  useEffect(() => {
    if (!request || !hasView || handledRequest.current === request.n) return;
    handledRequest.current = request.n;
    if (request.kind === "members") setShowMembers(true);
    else if (canManage) setRenaming(true);
  }, [request, hasView, canManage]);

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

  // Tujuan fokus setelah kartu dihapus: kartu berikutnya atau sebelumnya di
  // kolom yang sama, lalu tombol Tambah task kolom itu, lalu judul board.
  function focusAfterRemoval(taskId: string): FocusTarget {
    const current = viewRef.current;
    const at = current ? locate(current, taskId) : null;
    if (!current || !at) return { kind: "heading" };
    const col = current.columns.find((c) => c.id === at.columnId);
    const next = col?.tasks[at.index + 1] ?? col?.tasks[at.index - 1];
    if (next) return { kind: "card", id: next.id };
    return current.canCreate ? { kind: "add", columnId: at.columnId } : { kind: "heading" };
  }

  // Fokus dipasang lewat afterDialog, setelah dialog (detail task atau konfirmasi hapus) tertutup.
  function removed(taskId: string, code: string) {
    afterDialog.current = focusAfterRemoval(taskId);
    // Pindahan kartu ini yang masih berjalan tidak diterapkan lagi, dan
    // jawabannya (berhasil atau gagal) diabaikan di move().
    deletedIds.current.add(taskId);
    setPendingMoves((list) => list.filter((m) => m.taskId !== taskId));
    const latest = dataRef.current;
    if (latest) setData(withoutTask(latest, taskId));
    say(TEKS_MENU.kartu.dihapus(code));
    void reload();
    onProjectsChanged();
  }

  useImperativeHandle(ref, () => ({
    taskDeleted: removed,
  }));

  async function move(taskId: string, to: Place, keepFocus: boolean) {
    const current = viewRef.current;
    if (!current || samePlace(current, taskId, to)) return;
    const next = applyMove(current, taskId, to);
    const placed = locate(next, taskId);
    if (!placed) return;
    const code = placed.task.code;
    const colName = columnLabel(to.columnId, next.columns.find((c) => c.id === to.columnId)?.name);
    const seq = ++moveSeq.current;
    const target: Place = { columnId: to.columnId, index: placed.index };
    setPendingMoves((list) => [...list, { seq, taskId, to: target }]);
    setFailure(null);
    if (keepFocus) focusAfter.current = taskId;
    const settle = () => setPendingMoves((list) => list.filter((m) => m.seq !== seq));
    // Kartu dihapus selagi pindahan ini menunggu jawaban: hasilnya (yang masih
    // memuat kartu itu) dan galatnya tidak dipakai.
    const gone = () => deletedIds.current.has(taskId);
    try {
      const result = await boardApi.moveTask(projectId, taskId, target.columnId, target.index);
      if (!mounted.current) return;
      if (gone()) {
        settle();
        return;
      }
      say(TEKS_LAYAR.board.dipindah(code, colName, placed.index + 1, placed.size));
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
      settle();
      if (gone()) return;
      if (keepFocus) focusAfter.current = taskId;
      const error = toAppError(err);
      setFailure({ title: moveErrorTitle(error, code), message: error.message, note: TEKS_LAYAR.board.dikembalikan });
      say(TEKS_LAYAR.board.belumDipindahSr(code));
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
        label: TEKS_LAYAR.board.keKolom(columnLabel(c.id, c.name)),
        run: () => void move(taskId, { columnId: c.id, index: 0 }, true),
      }));
    if (at.index > 0)
      opts.push({ key: "up", label: TEKS_MENU.kartu.naik, run: () => void move(taskId, { columnId: at.columnId, index: at.index - 1 }, true) });
    if (at.index < at.size - 1)
      opts.push({ key: "down", label: TEKS_MENU.kartu.turun, run: () => void move(taskId, { columnId: at.columnId, index: at.index + 1 }, true) });
    return opts;
  }

  // Aksi menu klik kanan kartu yang mengubah task (tugaskan, prioritas,
  // tenggat, timer). Galat tampil di area pb-live, seperti galat pindah.
  async function changeTask(code: string, run: () => Promise<unknown>, done: string) {
    setFailure(null);
    try {
      await run();
      if (!mounted.current) return;
      say(done);
      void reload();
      onProjectsChanged();
    } catch (err) {
      if (!mounted.current) return;
      setFailure({ title: TEKS_MENU.kartu.gagal(code), message: toAppError(err).message });
      void reload();
    }
  }

  async function copyCode(code: string) {
    setFailure(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard");
      await navigator.clipboard.writeText(code);
      if (mounted.current) say(TEKS_MENU.kartu.disalin(code));
    } catch {
      if (mounted.current) setFailure({ title: TEKS_MENU.kartu.gagalSalin(code), message: TEKS_MENU.kartu.gagalSalinIsi });
    }
  }

  function cardActions(task: TaskCard): CardMenuActions {
    const { id, code } = task;
    return {
      open: () => onOpenTask(id),
      move: (to) => void move(id, to, true),
      edit: (patch: TaskPatch, done: string) => void changeTask(code, () => boardApi.updateTask(projectId, id, patch), done),
      timer: (start) => {
        // Inti Rust menghentikan timer saya di task lain proyek ini saat timer
        // baru mulai; pengumumannya menyebut task itu.
        const stopped = start
          ? (viewRef.current?.columns.flatMap((c) => c.tasks) ?? []).filter((t) => t.id !== id && t.myTimerRunning).map((t) => t.code)
          : [];
        const done = !start
          ? TEKS_MENU.kartu.timerBerhenti(code)
          : stopped.length > 0
            ? TEKS_MENU.kartu.timerMulaiGanti(code, stopped)
            : TEKS_MENU.kartu.timerMulai(code);
        void changeTask(code, () => (start ? boardApi.startTimer(projectId, id) : boardApi.stopTimer(projectId, id, null)), done);
      },
      copy: () => void copyCode(code),
      // Galat dilempar ke dialog konfirmasi menu, yang menampilkannya.
      remove: async () => {
        await boardApi.deleteTask(projectId, id);
        if (mounted.current) removed(id, code);
      },
    };
  }

  function openQuickAdd(columnId: ColumnId) {
    if (adding === columnId) rootRef.current?.querySelector<HTMLInputElement>(`[data-qa="${columnId}"]`)?.focus();
    else setAdding(columnId);
  }

  function renamed(updated: ProjectSummary) {
    setRenaming(false);
    if (data) setData({ ...data, project: { ...data.project, ...updated } });
    say(TEKS_LAYAR.board.namaDiubah(updated.name));
    void reload();
    onProjectsChanged();
  }

  async function created(task: TaskDetail) {
    say(TEKS_LAYAR.board.dibuat(task.code, columnLabel(task.columnId)));
    await reload();
    onProjectsChanged();
  }

  if (forbidden && onLost) return null;

  if (!view) {
    if (live.loading)
      return (
        <p className="bd-pad hint" role="status">
          {TEKS_LAYAR.layar.memuatBoard}
        </p>
      );
    const notFound = live.error?.code === "not_found";
    return (
      <div className="bd-pad bd-narrow" role="alert">
        <ErrorAlert title={notFound ? TEKS_LAYAR.board.tidakDitemukan : TEKS_LAYAR.board.belumTerbaca}>
          <p>{live.error?.message ?? TEKS_LAYAR.board.intiTanpaBoard}</p>
          <p>{notFound ? TEKS_LAYAR.board.pilihLain : TEKS_LAYAR.board.tungguBoard}</p>
          <button type="button" className="btn btn-ghost btn-sm bd-retry" onClick={() => void reload()}>
            {TEKS_LAYAR.layar.cobaLagi}
          </button>
        </ErrorAlert>
      </div>
    );
  }

  const { project } = view;
  const readOnly = !view.canCreate;
  const memberCount = members.view?.registered ? members.view.members.length : null;
  const T = TEKS_LAYAR.board;

  return (
    <div className="pb" ref={rootRef} {...rescue}>
      <header className="pb-head">
        <h2 id={titleId} className="pb-title" ref={headingRef} tabIndex={-1}>
          <span className="pb-code">{project.code}</span>{" "}
          {project.name}
        </h2>
        <span className="chip pb-team">
          <span className="sr-only">{T.departemenSr}</span>
          {project.teamName ? teamLabel(project.teamName) : TEKS.proyek.tanpaDepartemen}
        </span>
        <span className="page-sub">{T.jumlahTask(project.taskCount, project.openCount)}</span>
        <div className="pb-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-haspopup="dialog"
            aria-label={memberCount === null ? T.anggota : T.anggotaLabel(memberCount)}
            onClick={() => setShowMembers(true)}
          >
            <IconUsers size={16} aria-hidden="true" />
            {T.anggota}
            {memberCount !== null && <span className="pb-members-n">{memberCount}</span>}
          </button>
          {project.canManage && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRenaming(true)}>
              <IconPencil size={16} aria-hidden="true" />
              {T.ubahNama}
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
            {T.pintasan}
          </button>
          {view.canCreate && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => openQuickAdd("todo")}
            >
              <IconPlus size={16} aria-hidden="true" />
              {T.taskBaru}
            </button>
          )}
        </div>
      </header>

      {readOnly && (
        <p className="pb-readonly">
          <IconEye size={16} aria-hidden="true" />
          {T.hanyaLihat}
        </p>
      )}

      <div id={keysId} className="pb-keys" hidden={!showKeys}>
        <p>
          {readOnly ? T.pintasanLihat : T.pintasanUbah}
        </p>
      </div>

      <div className="sr-only" role="status" aria-live="polite">
        <span key={announce.n}>{announce.text}</span>
      </div>

      <div aria-live="polite" className="pb-live">
        {live.error && (
          <p className="hint">{teksDialog.dataLama(live.error.message)}</p>
        )}
        {failure && (
          <ErrorAlert title={failure.title}>
            <p>{failure.message}</p>
            {failure.note && <p>{failure.note}</p>}
          </ErrorAlert>
        )}
      </div>

      <div className="pb-scroll" data-drop-area>
        <div className="pb-cols" aria-labelledby={titleId} role="group">
          {view.columns.map((col) => {
            const done = col.id === "done";
            const others = col.tasks.filter((t) => t.id !== dragId);
            const dropHere = drop && drop.columnId === col.id ? drop.index : null;
            const colName = columnLabel(col.id, col.name);
            let k = 0;
            return (
              <ColumnSection
                key={col.id}
                menuLabel={TEKS_MENU.kolom.menu(colName)}
                menuItems={
                  view.canCreate
                    ? [
                        {
                          id: "new-task",
                          label: TEKS_MENU.kolom.taskBaru(colName),
                          icon: <IconPlus size={16} />,
                          onSelect: () => openQuickAdd(col.id),
                        },
                      ]
                    : []
                }
                data-rescue-group={col.id}
                data-drop-col={col.id}
                className={`pb-col${dropHere !== null ? " pb-col-over" : ""}`}
                aria-labelledby={`${titleId}-${col.id}`}
              >
                {/* Fokus kembali ke judul kolom setelah menu kolom dari klik kanan ditutup. */}
                <h3 id={`${titleId}-${col.id}`} className="pb-colh" tabIndex={-1} data-menu-focus>
                  {colName}
                  <span className="pb-count">
                    <span className="sr-only">, </span>
                    {col.tasks.length}
                    <span className="sr-only">{T.jumlahKolomSr(col.tasks.length)}</span>
                  </span>
                </h3>
                <ul className="pb-list">
                  {col.tasks.map((task, index) => {
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
                            menu={cardMenuEntries({
                              view,
                              task,
                              columnId: col.id,
                              index,
                              size: col.tasks.length,
                              actions: cardActions(task),
                            })}
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
                {col.tasks.length === 0 && dropHere === null && <p className="pb-empty">{T.kolomKosong}</p>}
                {view.canCreate && (
                  <QuickAdd
                    projectId={projectId}
                    columnId={col.id}
                    columnName={colName}
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
              </ColumnSection>
            );
          })}
        </div>
      </div>

      <ProjectMembersPanel
        open={showMembers}
        onOpenChange={setShowMembers}
        projectId={projectId}
        me={view.me}
        members={members}
        onLeft={() => onLost?.(projectId, "left")}
      />

      {project.canManage && (
        <RenameProjectDialog open={renaming} onOpenChange={setRenaming} project={project} onRenamed={renamed} />
      )}
    </div>
  );
}

type ColumnSectionProps = ComponentProps<"section"> & {
  menuLabel: string;
  menuItems: MenuEntry[];
  children: ReactNode;
};

// Kolom board dengan menu klik kanan (Task baru di kolom ini). Tanpa item
// (tanpa hak membuat task) tidak ada menu. Klik kanan di kartu sudah ditangani
// menu kartu (event-nya defaultPrevented), jadi menu kolom tidak ikut muncul.
function ColumnSection({ menuLabel, menuItems, children, ...rest }: ColumnSectionProps) {
  const menu = useContextMenu({ label: menuLabel, items: menuItems });
  return (
    <section
      {...rest}
      onContextMenu={(e: MouseEvent<HTMLElement>) => {
        if (cardDragActive()) {
          e.preventDefault();
          return;
        }
        menu.triggerProps.onContextMenu(e);
      }}
      onKeyDown={(e) => {
        if (!cardDragActive()) menu.triggerProps.onKeyDown(e);
      }}
    >
      {children}
      {menu.element}
    </section>
  );
}
