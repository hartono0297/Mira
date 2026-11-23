import { IconCalendarDue, IconClock, IconGitMerge, IconMessage, IconSquareCheck } from "@tabler/icons-react";
import { useId, type KeyboardEvent, type PointerEvent } from "react";
import type { TaskCard } from "../../api/board";
import { initials } from "../../components/initials";
import type { Direction } from "./boardMoves";
import { daysUntil, dueLabel, formatDue, PRIORITY_LABELS } from "./format";
import { MoveMenu, type MoveOption } from "./MoveMenu";
import { TEKS } from "./teks";
import { cardTrackedSecs, formatDuration, formatDurationLong } from "./timeFormat";
import { useNow } from "./useNow";

type Props = {
  task: TaskCard;
  done: boolean;
  canMove: boolean;
  dragging: boolean;
  moveOptions: MoveOption[];
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

export function BoardCard({ task, done, canMove, dragging, moveOptions, onOpen, onKeyMove, onPointerDown }: Props) {
  const metaId = useId();
  const days = task.due ? daysUntil(task.due) : null;
  const late = !done && days !== null && days < 0;
  const timerRunning = task.timersRunningSince.length > 0;
  // Hanya kartu dengan timer berjalan yang punya interval; tampilannya per menit.
  const now = useNow(30_000, timerRunning);
  const tracked = cardTrackedSecs(task, now);
  const allSubtasksDone = task.subtaskTotal > 0 && task.subtaskDone >= task.subtaskTotal;

  function onKey(e: KeyboardEvent<HTMLElement>) {
    if (!canMove || !e.altKey) return;
    const dir = ARROWS[e.key];
    if (!dir) return;
    if ((e.target as HTMLElement).closest("[role=menu]")) return;
    e.preventDefault();
    onKeyMove(dir);
  }

  return (
    <article
      className={`tc${dragging ? " tc-dragging" : ""}`}
      data-card={task.id}
      data-movable={canMove || undefined}
      onPointerDown={canMove ? onPointerDown : undefined}
      // Seret HTML5 bawaan (misalnya teks yang terpilih) akan merebut pointer dari seret kartu.
      onDragStart={(e) => e.preventDefault()}
      onKeyDown={onKey}
    >
      <div className="tc-top">
        <button type="button" className={`tc-open${done ? " tc-open-done" : ""}`} data-open-task={task.id} onClick={onOpen} aria-describedby={metaId}>
          {task.title}
        </button>
        {canMove && <MoveMenu code={task.code} options={moveOptions} />}
      </div>
      <div id={metaId} className="tc-meta">
        <span className="tc-code">{task.code}</span>
        {task.assignee ? (
          <span className="avatar tc-av" title={task.assignee.name}>
            <span aria-hidden="true">{initials(task.assignee.name)}</span>
            <span className="sr-only">, untuk {task.assignee.name}</span>
          </span>
        ) : (
          <span className="sr-only">, belum ada penanggung jawab</span>
        )}
        {task.due && (
          <span className={`tc-due${late ? " tc-late" : ""}`}>
            <IconCalendarDue size={14} aria-hidden="true" />
            <span className="sr-only">, tenggat </span>
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
            <span className="sr-only">, prioritas </span>
            {PRIORITY_LABELS[task.priority]}
          </span>
        )}
        {task.commentCount > 0 && (
          <span className="tc-comments">
            <IconMessage size={14} aria-hidden="true" />
            <span className="sr-only">, </span>
            {task.commentCount}
            <span className="sr-only"> komentar</span>
          </span>
        )}
      </div>
      {task.labels.length > 0 && (
        <ul className="tc-labels" aria-label="Label">
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
          Diubah saat offline, sudah digabung
        </p>
      )}
    </article>
  );
}
