import { IconCalendarDue, IconClock, IconGitMerge, IconMessage, IconSquareCheck } from "@tabler/icons-react";
import { useId, type DragEvent, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import type { TaskCard } from "../../api/board";
import { initials } from "../../components/initials";
import { isMac } from "../../platform";
import type { Direction } from "./boardMoves";
import { cardDragActive } from "./cardMenu";
import { daysUntil, dueLabel, formatDue, PRIORITY_LABELS } from "./format";
import { MoveMenu, type MoveOption } from "./MoveMenu";
import { TEKS } from "./teks";
import { TEKS_MENU } from "./teksMenu";
import { cardTrackedSecs, formatDuration, formatDurationLong } from "./timeFormat";
import { useBoardMenu, type BoardMenuEntry } from "./useBoardMenu";
import { useNow } from "./useNow";

type Props = {
  task: TaskCard;
  done: boolean;
  canMove: boolean;
  dragging: boolean;
  moveOptions: MoveOption[];
  // Isi menu klik kanan (cardMenuEntries di cardMenu.tsx).
  menu: BoardMenuEntry[];
  onOpen: () => void;
  onKeyMove: (dir: Direction) => void;
  // Mulai seret dengan mouse; lihat useCardDrag.
  onPointerDown: (e: PointerEvent<HTMLElement>) => void;
};

const ARROWS: Record<string, Direction> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

// Event dari portal (menu klik kanan, dialog konfirmasi hapus) ikut naik
// lewat pohon React ke kartu, padahal elemennya tidak ada di dalam kartu.
function fromCard(e: { target: EventTarget | null; currentTarget: HTMLElement }): boolean {
  return e.target instanceof Node && e.currentTarget.contains(e.target);
}

// Event dari menu yang ada di dalam kartu (dropdown Pindahkan). Menu kartu
// tidak dibuka di atasnya, supaya tidak ada dua menu sekaligus.
function fromMenuInCard(e: { target: EventTarget | null; currentTarget: HTMLElement }): boolean {
  return fromCard(e) && !!(e.target as Element).closest("[role=menu]");
}

function isMenuKey(e: KeyboardEvent<HTMLElement>): boolean {
  return e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey);
}

export function BoardCard({ task, done, canMove, dragging, moveOptions, menu: menuEntries, onOpen, onKeyMove, onPointerDown }: Props) {
  const metaId = useId();
  const menu = useBoardMenu({ label: TEKS_MENU.kartu.menu(task.code), items: menuEntries });
  const days = task.due ? daysUntil(task.due) : null;
  const late = !done && days !== null && days < 0;
  const timerRunning = task.timersRunningSince.length > 0;
  // Hanya kartu dengan timer berjalan yang punya interval; tampilannya per menit.
  const now = useNow(30_000, timerRunning);
  const tracked = cardTrackedSecs(task, now);
  const allSubtasksDone = task.subtaskTotal > 0 && task.subtaskDone >= task.subtaskTotal;

  function onKey(e: KeyboardEvent<HTMLElement>) {
    if (fromMenuInCard(e)) {
      // Tombol menu di dalam dropdown Pindahkan juga tidak membuka menu kolom.
      if (isMenuKey(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    // Shift+F10 dan tombol Menu membuka menu klik kanan.
    if (!cardDragActive()) menu.triggerProps.onKeyDown(e);
    if (!canMove || !e.altKey || !fromCard(e)) return;
    const dir = ARROWS[e.key];
    if (!dir) return;
    e.preventDefault();
    onKeyMove(dir);
  }

  return (
    <article
      className={`tc${dragging ? " tc-dragging" : ""}`}
      data-card={task.id}
      data-movable={canMove || undefined}
      onPointerDown={
        canMove
          ? (e: PointerEvent<HTMLElement>) => {
              // Ctrl+klik di macOS adalah klik kanan (tombol utama + Ctrl); menu yang
              // terbuka karenanya tidak boleh berubah jadi seret saat mouse bergeser.
              // Di Windows Ctrl+seret tetap seret biasa.
              if (fromCard(e) && !(e.ctrlKey && isMac())) onPointerDown(e);
            }
          : undefined
      }
      // Seret HTML5 bawaan (misalnya teks yang terpilih) akan merebut pointer dari seret kartu.
      onDragStart={(e: DragEvent<HTMLElement>) => {
        if (fromCard(e)) e.preventDefault();
      }}
      onContextMenu={(e: MouseEvent<HTMLElement>) => {
        // Selama seret, dan di dalam dropdown Pindahkan: tanpa menu kartu, tanpa
        // menu bawaan WebView, dan menu kolom ikut diam (defaultPrevented).
        if (cardDragActive() || fromMenuInCard(e)) {
          e.preventDefault();
          return;
        }
        menu.triggerProps.onContextMenu(e);
      }}
      onKeyDown={onKey}
    >
      <div className="tc-top">
        <button type="button" className={`tc-open${done ? " tc-open-done" : ""}`} data-open-task={task.id} data-menu-focus onClick={onOpen} aria-describedby={metaId}>
          {task.title}
        </button>
        {canMove && <MoveMenu code={task.code} options={moveOptions} />}
      </div>
      <div id={metaId} className="tc-meta">
        <span className="tc-code">{task.code}</span>
        {task.assignee ? (
          <span className="avatar tc-av" title={task.assignee.name}>
            <span aria-hidden="true">{initials(task.assignee.name)}</span>
            <span className="sr-only">{TEKS.kartu.untukSr(task.assignee.name)}</span>
          </span>
        ) : (
          <span className="sr-only">{TEKS.kartu.tanpaPenanggungJawabSr}</span>
        )}
        {task.due && (
          <span className={`tc-due${late ? " tc-late" : ""}`}>
            <IconCalendarDue size={14} aria-hidden="true" />
            <span className="sr-only">{TEKS.kartu.tenggatSr}</span>
            {done ? formatDue(task.due) : dueLabel(task.due)}
          </span>
        )}
        {task.subtaskTotal > 0 && (
          <span className={`tc-sub${allSubtasksDone ? " tc-sub-done" : ""}`}>
            <IconSquareCheck size={14} aria-hidden="true" />
            <span aria-hidden="true">
              {task.subtaskDone}/{task.subtaskTotal}
            </span>
            <span className="sr-only">{TEKS.kartu.subtaskSr(task.subtaskDone, task.subtaskTotal)}</span>
          </span>
        )}
        {(tracked > 0 || timerRunning) && (
          <span className="tc-time">
            <IconClock size={14} aria-hidden="true" />
            <span aria-hidden="true">{formatDuration(tracked)}</span>
            <span className="sr-only">{TEKS.kartu.waktuSr(formatDurationLong(tracked))}</span>
            {timerRunning && (
              <>
                <span className="tc-running" aria-hidden="true" />
                <span className="sr-only">{TEKS.kartu.timerBerjalanSr}</span>
              </>
            )}
          </span>
        )}
        {task.priority !== "none" && (
          <span className={`chip tc-pri${task.priority === "high" ? " tc-pri-high" : ""}`}>
            <span className="sr-only">{TEKS.kartu.prioritasSr}</span>
            {PRIORITY_LABELS[task.priority]}
          </span>
        )}
        {task.commentCount > 0 && (
          <span className="tc-comments">
            <IconMessage size={14} aria-hidden="true" />
            <span className="sr-only">, </span>
            {task.commentCount}
            <span className="sr-only">{TEKS.kartu.komentarSr(task.commentCount)}</span>
          </span>
        )}
      </div>
      {task.labels.length > 0 && (
        <ul className="tc-labels" aria-label={TEKS.kartu.label}>
          {task.labels.map((l) => (
            <li key={l} className="tc-label">
              {l}
            </li>
          ))}
        </ul>
      )}
      {task.merged && (
        <p className="tc-merged">
          <IconGitMerge size={14} aria-hidden="true" />
          {TEKS.kartu.digabung}
        </p>
      )}
      {menu.element}
    </article>
  );
}
