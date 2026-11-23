import { IconPlayerPlay, IconPlayerStop } from "@tabler/icons-react";
import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from "react";
import { toAppError } from "../../api";
import { boardApi, type TaskDetail } from "../../api/board";
import { formatDateTime } from "./format";
import { runningSinceSr, SAY, stopTitleSr, TW } from "./teksWaktu";
import { formatClock, formatDurationLong, runningSecs } from "./timeFormat";
import { useNow } from "./useNow";
import "./time.css";

export type TimeProps = {
  task: TaskDetail;
  me: string;
  canEdit: boolean;
  onChange: (next: TaskDetail) => void;
  onError: (message: string) => void;
};

// Lebih dari 12 jam berjalan: kemungkinan besar lupa dihentikan.
export const FORGOT_SECS = 12 * 3600;

// Escape di dalam kotak kecil (catatan timer, form catat manual, konfirmasi hapus)
// hanya menutup kotak itu. Radix Dialog mendengar Escape di document saat capture,
// jadi pendengar ini dipasang di window (lebih dulu) dan menghentikan event-nya.
// Kotaknya juga diberi atribut data-escape-local, yang dihormati dialog detail task.
export function useLocalEscape(ref: RefObject<HTMLElement | null>, active: boolean, onEscape: () => void) {
  const cb = useRef(onEscape);
  useEffect(() => {
    cb.current = onEscape;
  });
  useEffect(() => {
    if (!active) return;
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const zone = ref.current;
      if (!zone || !(e.target instanceof Node) || !zone.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      cb.current();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, ref]);
}

// Kalimat untuk pembaca layar: dikosongkan dulu, lalu diisi sesaat kemudian, supaya
// kalimat yang sama tetap dibacakan ulang.
export function useAnnounce(): [string, (text: string) => void] {
  const [say, setSay] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  function announce(text: string) {
    setSay("");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setSay(text), 30);
  }
  return [say, announce];
}

// Jam berjalan. Dipisah supaya hanya bagian ini yang dirender ulang tiap detik.
// Tidak dibacakan: pembaca layar mendapat teks "berjalan sejak" yang tetap.
function Clock({ since, className }: { since: string; className: string }) {
  const now = useNow(1000);
  return (
    <span className={className} aria-hidden="true">
      {formatClock(runningSecs(since, now))}
    </span>
  );
}

export function ForgotTag({ since }: { since: string }) {
  const now = useNow(60_000);
  if (runningSecs(since, now) <= FORGOT_SECS) return null;
  return <span className="td-forgot">{TW.forgot}</span>;
}

// Timer saya di kepala dialog: tombol Mulai timer, atau jam berjalan dengan tombol Hentikan timer.
export function TimerMini({ task, canEdit, onChange, onError }: TimeProps) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [say, announce] = useAnnounce();
  const focusAfter = useRef<"start" | "stop" | null>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const noteRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const running = task.myRunningEntry ? (task.timeEntries.find((e) => e.id === task.myRunningEntry) ?? null) : null;
  const isOpen = open && !!running && canEdit;

  // Setelah Mulai atau Hentikan tombolnya berganti, jadi fokus dipindah ke penggantinya.
  useEffect(() => {
    if (focusAfter.current === "start") startRef.current?.focus();
    if (focusAfter.current === "stop") stopRef.current?.focus();
    focusAfter.current = null;
  });

  useEffect(() => {
    if (isOpen) noteRef.current?.focus();
  }, [isOpen]);

  // Klik di luar kotak catatan menutupnya tanpa menghentikan timer.
  useEffect(() => {
    if (!isOpen) return;
    function onDown(e: PointerEvent) {
      const t = e.target as Node;
      if (boxRef.current?.contains(t) || stopRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [isOpen]);

  useLocalEscape(boxRef, isOpen, () => {
    setOpen(false);
    stopRef.current?.focus();
  });

  async function start() {
    if (busy) return;
    setBusy(true);
    try {
      const next = await boardApi.startTimer(task.projectId, task.id);
      if (!alive.current) return;
      focusAfter.current = "stop";
      onChange(next);
      announce(SAY.started);
    } catch (err) {
      if (alive.current) onError(toAppError(err).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function stop(withNote: boolean) {
    if (busy || !running) return;
    const clean = withNote ? note.trim() : "";
    setBusy(true);
    try {
      const next = await boardApi.stopTimer(task.projectId, task.id, clean ? clean : null);
      if (!alive.current) return;
      const done = next.timeEntries.find((e) => e.id === running.id);
      setOpen(false);
      setNote("");
      focusAfter.current = "start";
      onChange(next);
      announce(done && done.secs > 0 ? SAY.stopped(formatDurationLong(done.secs)) : SAY.stoppedPlain);
    } catch (err) {
      if (alive.current) onError(toAppError(err).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void stop(true);
  }

  const since = running ? formatDateTime(running.start) : "";

  // Wilayah aria-live selalu di posisi pertama supaya tidak dipasang ulang saat
  // tombol Mulai berganti jadi jam berjalan.
  return (
    <div
      className="td-mini"
      role={running ? "group" : undefined}
      aria-label={running ? TW.timerGroup : undefined}
      data-running={running ? "true" : undefined}
    >
      <span className="sr-only" role="status" aria-live="polite">
        {say}
      </span>
      {!running && canEdit && (
        <>
          <button
            type="button"
            ref={startRef}
            className="btn btn-ghost btn-sm"
            onClick={start}
            title={TW.startHint}
            aria-describedby={`${id}-start-hint`}
            aria-disabled={busy || undefined}
            aria-busy={busy || undefined}
          >
            <IconPlayerPlay size={16} aria-hidden="true" />
            {TW.start}
          </button>
          {/* Deskripsi tombol: dibaca sekali saat tombol difokus, terlihat sebagai title saat disorot. */}
          <span id={`${id}-start-hint`} hidden>
            {TW.startHint}
          </span>
        </>
      )}
      {running && (
        <>
          <span className="td-run" aria-hidden="true" />
          <span className="sr-only">{runningSinceSr(since)}</span>
          <ForgotTag since={running.start} />
          <Clock since={running.start} className="td-mini-clock" />
        </>
      )}
      {running && canEdit && (
        <div className="td-mini-anchor">
          <button
            type="button"
            ref={stopRef}
            className="btn btn-sm"
            onClick={() => {
              if (!busy) setOpen((o) => !o);
            }}
            aria-disabled={busy || undefined}
            aria-busy={busy || undefined}
            aria-haspopup="dialog"
            aria-expanded={isOpen}
            aria-controls={isOpen ? `${id}-stop` : undefined}
          >
            <IconPlayerStop size={16} aria-hidden="true" />
            {TW.stop}
          </button>
          {isOpen && (
            <div
              className="td-stop-pop"
              id={`${id}-stop`}
              role="dialog"
              aria-label={TW.stopDialog}
              ref={boxRef}
              data-escape-local
              data-unsaved={note.trim() ? "true" : undefined}
            >
              <form className="td-stop-form" onSubmit={onSubmit} noValidate>
                <p className="td-stop-title">
                  <span aria-hidden="true">
                    {TW.stopAt} <Clock since={running.start} className="td-stop-clock" />
                  </span>
                  <span className="sr-only">{stopTitleSr(since)}</span>
                </p>
                <label className="td-label" htmlFor={`${id}-note`}>
                  {TW.stopNoteLabel}
                </label>
                <input
                  id={`${id}-note`}
                  ref={noteRef}
                  type="text"
                  className="td-input"
                  maxLength={200}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={TW.notePlaceholder}
                  aria-describedby={`${id}-hint`}
                  autoComplete="off"
                />
                <p className="hint" id={`${id}-hint`}>
                  {TW.stopHint}
                </p>
                <div className="td-row-end">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => void stop(false)}
                    aria-disabled={busy || undefined}
                  >
                    {TW.stopWithoutNote}
                  </button>
                  <button type="submit" className="btn btn-sm" aria-disabled={busy || undefined} aria-busy={busy || undefined}>
                    {TW.stopWithNote}
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
