import { IconPlayerPause, IconPlayerPlay } from "@tabler/icons-react";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { toAppError } from "../../api";
import { boardApi, type TaskDetail } from "../../api/board";
import { formatDateTime } from "./format";
import { earlierSr, pausedSr, runningSinceSr, SAY, TW } from "./teksWaktu";
import { formatClock, formatDuration, formatDurationLong, myTimer, runningSecs } from "./timeFormat";
import { useTimerNoticeAnnouncement } from "./timerNoticeStore";
import { useNow } from "./useNow";
import "./field.css";
import "./time.css";

export type TimeProps = {
  task: TaskDetail;
  me: string;
  canEdit: boolean;
  onChange: (next: TaskDetail) => void;
  onError: (message: string) => void;
};

// Lebih dari 12 jam berjalan: kemungkinan besar lupa dijeda.
export const FORGOT_SECS = 12 * 3600;

// Escape di dalam kotak kecil (form catat manual, konfirmasi hapus, isian subtask)
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

// Jam berjalan: total saya di task ini (semua segmen ditambah yang berjalan).
// Dipisah supaya hanya bagian ini yang dirender ulang tiap detik. Tidak dibacakan:
// pembaca layar mendapat teks "berjalan sejak" yang tetap.
function MyClock({ task, me }: { task: TaskDetail; me: string }) {
  const now = useNow(1000);
  return (
    <span className="td-mini-clock" aria-hidden="true">
      {formatClock(myTimer(task, me, now).totalSecs)}
    </span>
  );
}

// Penanda lupa dijeda menghitung segmen yang berjalan saja, bukan total.
export function ForgotTag({ since }: { since: string }) {
  const now = useNow(60_000);
  if (runningSecs(since, now) <= FORGOT_SECS) return null;
  return <span className="td-forgot">{TW.forgot}</span>;
}

// Total saya tanpa jam berjalan: "Dijeda 1j 20m" saat dijeda, atau "Total Anda 1j 20m"
// saat task di Selesai atau saat ada catatan lama tapi belum pernah memakai timer.
function MySum({ secs, paused }: { secs: number; paused: boolean }) {
  const long = formatDurationLong(secs);
  return (
    <>
      <span className="td-mini-sum" aria-hidden="true">
        {paused && <span className="td-pause" />}
        {paused ? TW.paused : TW.yourTotal}
        <b>{formatDuration(secs)}</b>
      </span>
      <span className="sr-only">{paused ? pausedSr(long) : `${TW.yourTotal} ${long}.`}</span>
    </>
  );
}

// Timer saya di kepala dialog. Satu tombol yang tetap sama: labelnya berganti antara
// Mulai timer, Jeda, dan Lanjutkan, jadi fokus keyboard tidak hilang saat keadaannya
// berubah, juga kalau berubah dari luar (dijeda otomatis atau oleh laptop lain).
// Jeda menutup segmen yang berjalan, Lanjutkan membuka segmen baru.
export function TimerMini({ task, me, canEdit, onChange, onError }: TimeProps) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [say, announce] = useAnnounce();
  const notice = useTimerNoticeAnnouncement();
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Keadaan dan total saat ini; jam berjalan menghitung sendiri tiap detik (MyClock).
  const mine = myTimer(task, me, Date.now());
  const { state, running, closedSecs } = mine;
  // Task di Selesai: timer sudah dijeda otomatis, jadi cukup tampilkan totalnya.
  const done = task.statusTime.currentColumn === "done";
  const showSum = !running && (state === "paused" || closedSecs > 0);
  const hasContent = !!running || showSum;

  async function play() {
    if (busy) return;
    const resuming = state === "paused";
    setBusy(true);
    try {
      const next = await boardApi.startTimer(task.projectId, task.id);
      if (!alive.current) return;
      onChange(next);
      announce(resuming ? SAY.resumed : SAY.started);
    } catch (err) {
      if (alive.current) onError(toAppError(err).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function pause() {
    if (busy) return;
    setBusy(true);
    try {
      const next = await boardApi.stopTimer(task.projectId, task.id, null);
      if (!alive.current) return;
      onChange(next);
      announce(SAY.paused(formatDurationLong(myTimer(next, me, Date.now()).totalSecs)));
    } catch (err) {
      if (alive.current) onError(toAppError(err).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const label = running ? TW.pause : state === "paused" ? TW.resume : TW.start;
  const Icon = running ? IconPlayerPause : IconPlayerPlay;

  // Dua wilayah aria-live selalu di posisi pertama, sejak awal, supaya tidak dipasang
  // ulang saat jam muncul atau hilang: hasil aksi saya, lalu jeda otomatis dari luar.
  return (
    <div
      className="td-mini"
      role={hasContent ? "group" : undefined}
      aria-label={hasContent ? TW.timerGroup : undefined}
      data-running={running ? "true" : undefined}
      data-paused={state === "paused" ? "true" : undefined}
    >
      <span className="sr-only" role="status" aria-live="polite">
        {say}
      </span>
      <span className="sr-only" role="status" aria-live="polite">
        {notice}
      </span>
      {running && (
        <>
          <span className="td-run" aria-hidden="true" />
          <span className="sr-only">
            {runningSinceSr(formatDateTime(running.start))}
            {closedSecs > 0 ? ` ${earlierSr(formatDurationLong(closedSecs))}` : ""}
          </span>
          <ForgotTag since={running.start} />
          <MyClock task={task} me={me} />
        </>
      )}
      {showSum && <MySum secs={mine.totalSecs} paused={state === "paused" && !done} />}
      {canEdit && (
        <>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={running ? pause : play}
            title={running ? undefined : TW.startHint}
            aria-describedby={running ? undefined : `${id}-hint`}
            aria-disabled={busy || undefined}
            aria-busy={busy || undefined}
          >
            <Icon size={16} aria-hidden="true" />
            {label}
          </button>
          {/* Deskripsi Mulai dan Lanjutkan: dibaca sekali saat tombol difokus, terlihat sebagai title saat disorot. */}
          <span id={`${id}-hint`} hidden>
            {TW.startHint}
          </span>
        </>
      )}
    </div>
  );
}
