// Tombol "Terima kasih ke <nama>" di detail task yang sudah selesai. Membuka
// dialog Kopi dengan target task ini. Tidak tampil kalau fitur Kopi mati, saya
// Tamu, task belum di Selesai, tanpa penanggung jawab, atau penanggung jawabnya saya.
import { IconCoffee } from "@tabler/icons-react";
import { useId, useState } from "react";
import type { TaskCard } from "../../api/board";
import { kopiTargetKey, type KopiOverview, type KopiTarget } from "../../api/kopi";
import { KopiGiveDialog } from "../../components/KopiGiveDialog";
import { useKopi } from "../../components/useKopi";
import { KOPI_TEXT } from "../../i18n/kopi";
import { KOPI_ENTRY } from "../../i18n/kopi-entry";
import "../../components/kopi.css";
import "./task-kopi.css";

type TaskLike = Pick<TaskCard, "id" | "title" | "columnId" | "assignee">;

export type TaskKopiState = { show: false } | { show: true; disabled: string | null };

export function taskKopiState(overview: KopiOverview | null, projectId: string, task: TaskLike, me: string): TaskKopiState {
  if (!overview || !overview.enabled || !overview.canGive) return { show: false };
  const who = task.assignee;
  if (task.columnId !== "done" || !who || who.publicKey === me || who.publicKey === overview.me) return { show: false };
  const key = kopiTargetKey(who.publicKey, taskTarget(projectId, task));
  if (overview.givenTargets.includes(key)) return { show: true, disabled: KOPI_ENTRY.givenTask(who.name) };
  if (overview.givenToday >= overview.dailyLimit) return { show: true, disabled: KOPI_ENTRY.limitLong(overview.dailyLimit) };
  return { show: true, disabled: null };
}

function taskTarget(projectId: string, task: TaskLike): KopiTarget {
  return { kind: "task", project: projectId, task: task.id };
}

export function TaskKopiThanks({ projectId, task, me }: { projectId: string; task: TaskLike; me: string }) {
  const kopi = useKopi();
  const [open, setOpen] = useState(false);
  // Pengumuman setelah dialog tertutup; live region tetap ada di DOM.
  const [sent, setSent] = useState("");
  const reasonId = useId();
  const state = taskKopiState(kopi.overview, projectId, task, me);
  const who = task.assignee;
  if (!state.show || !who) return null;
  const disabled = state.disabled !== null;

  return (
    <div className="tk-thanks">
      {/* aria-disabled, bukan disabled: tombol tetap bisa difokus supaya alasannya terbaca. */}
      <button
        type="button"
        className="btn btn-ghost btn-sm kopi-btn kopi-tap"
        aria-disabled={disabled || undefined}
        aria-describedby={disabled ? reasonId : undefined}
        onClick={() => {
          if (!disabled) setOpen(true);
        }}
      >
        <IconCoffee size={16} aria-hidden="true" />
        {KOPI_ENTRY.thank(who.name)}
      </button>
      {disabled && (
        <p id={reasonId} className="hint">
          {state.disabled}
        </p>
      )}
      <p className="sr-only" role="status">
        {sent}
      </p>
      {open && (
        <KopiGiveDialog
          open
          onClose={() => setOpen(false)}
          to={who}
          target={taskTarget(projectId, task)}
          context={task.title}
          onGiven={(name) => setSent(KOPI_TEXT.give.sent(name))}
        />
      )}
    </div>
  );
}
