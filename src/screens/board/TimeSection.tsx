import {
  IconCircle,
  IconCircleCheck,
  IconClockExclamation,
  IconClockPlus,
  IconProgress,
  IconTrash,
} from "@tabler/icons-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { toAppError } from "../../api";
import { boardApi, type ColumnId, type Person, type TimeEntry } from "../../api/board";
import { FieldError } from "../../components/FieldError";
import { Avatar } from "../../components/Avatar";
import { COLUMN_NAMES, COLUMN_ORDER, formatDateTime } from "./format";
import { cycleDone, deleteEntryLabel, historySummary, SAY, startedAt, TW } from "./teksWaktu";
import { ForgotTag, useAnnounce, useLocalEscape, type TimeProps } from "./TimerMini";
import { formatDuration, formatDurationLong, liveStatusSecs, parseMinutes, runningSecs } from "./timeFormat";
import { useNow } from "./useNow";
import "./field.css";
import "./time.css";

const COLUMN_ICONS: Record<ColumnId, typeof IconCircle> = {
  todo: IconCircle,
  doing: IconProgress,
  done: IconCircleCheck,
};

// Durasi ringkas untuk mata, kalimat lengkap untuk pembaca layar.
function Dur({ secs }: { secs: number }) {
  return (
    <>
      <span aria-hidden="true">{formatDuration(secs)}</span>
      <span className="sr-only">{formatDurationLong(secs)}</span>
    </>
  );
}

function PersonAvatar({ person }: { person: Person }) {
  return <Avatar className="td-av" name={person.name} publicKey={person.publicKey} />;
}

// Bagian Waktu di detail task: total, per orang, per status, catat manual, riwayat.
export function TimeSection({ task, me, canEdit, onChange, onError }: TimeProps) {
  const id = useId();
  const now = useNow(30_000);
  const [say, announce] = useAnnounce();
  const [logOpen, setLogOpen] = useState(false);
  const [dur, setDur] = useState("");
  const [note, setNote] = useState("");
  const [durError, setDurError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const alive = useRef(true);
  const sectionRef = useRef<HTMLElement>(null);
  const logBtnRef = useRef<HTMLButtonElement>(null);
  const durRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const focusAfterDelete = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Setelah hapus, fokus ke ringkasan riwayat; kalau riwayat sudah kosong, ke tombol catat.
  useEffect(() => {
    if (!focusAfterDelete.current) return;
    focusAfterDelete.current = false;
    (summaryRef.current ?? logBtnRef.current)?.focus();
  });

  const showLog = logOpen && canEdit;
  useEffect(() => {
    if (showLog) durRef.current?.focus();
  }, [showLog]);

  // Catatan yang sedang dikonfirmasi bisa hilang (dihapus dari laptop lain).
  const confirmEntry = confirming ? task.timeEntries.find((e) => e.id === confirming && e.mine) : undefined;
  const showConfirm = !!confirmEntry && canEdit;
  useEffect(() => {
    if (showConfirm) confirmRef.current?.querySelector<HTMLButtonElement>("[data-cancel]")?.focus();
  }, [showConfirm]);

  function closeLog() {
    setLogOpen(false);
    setDur("");
    setNote("");
    setDurError(null);
    logBtnRef.current?.focus();
  }

  function focusDelete(entryId: string) {
    sectionRef.current?.querySelector<HTMLButtonElement>(`[data-del="${CSS.escape(entryId)}"]`)?.focus();
  }

  function cancelConfirm() {
    const entryId = confirming;
    setConfirming(null);
    if (entryId) setTimeout(() => focusDelete(entryId), 0);
  }

  useLocalEscape(formRef, showLog, closeLog);
  useLocalEscape(confirmRef, showConfirm, cancelConfirm);

  async function onLog(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    const parsed = parseMinutes(dur);
    if (parsed.minutes === null) {
      setDurError(parsed.reason);
      durRef.current?.focus();
      return;
    }
    const clean = note.trim();
    setSaving(true);
    try {
      const next = await boardApi.logTime(task.projectId, task.id, parsed.minutes, clean ? clean : null);
      if (!alive.current) return;
      onChange(next);
      closeLog();
      announce(SAY.logged(formatDurationLong(parsed.minutes * 60)));
    } catch (err) {
      if (alive.current) onError(toAppError(err).message);
    } finally {
      if (alive.current) setSaving(false);
    }
  }

  async function onDelete(entry: TimeEntry) {
    if (deleting) return;
    setDeleting(true);
    try {
      const next = await boardApi.deleteTimeEntry(task.projectId, task.id, entry.id);
      if (!alive.current) return;
      setConfirming(null);
      focusAfterDelete.current = true;
      onChange(next);
      announce(SAY.deleted);
    } catch (err) {
      if (alive.current) onError(toAppError(err).message);
    } finally {
      if (alive.current) setDeleting(false);
    }
  }

  const people = task.timeTotals
    .map((t) => ({ ...t, total: t.secs + (t.runningSince ? runningSecs(t.runningSince, now) : 0) }))
    .filter((t) => t.total > 0 || t.runningSince)
    .sort((a, b) => b.total - a.total || a.person.name.localeCompare(b.person.name));
  const total = people.reduce((sum, t) => sum + t.total, 0);
  const st = task.statusTime;
  const statusSecs = liveStatusSecs(st, now);
  const who = (p: Person) => (p.publicKey === me ? TW.you : p.name);

  function entryRow(e: TimeEntry) {
    const running = e.end === null;
    const when = formatDateTime(running ? e.start : e.end!, now);
    const what = running ? TW.running : formatDurationLong(e.secs);
    const isConfirm = showConfirm && confirmEntry?.id === e.id;
    return (
      <li className="td-erow" key={e.id}>
        <PersonAvatar person={e.person} />
        <div className="td-emain">
          <p>
            {running ? (
              <span className="td-run-tag td-erun">
                <span className="td-run" aria-hidden="true" />
                {TW.running}
              </span>
            ) : (
              <b>
                <Dur secs={e.secs} />
              </b>
            )}{" "}
            <span className="td-emeta">
              {who(e.person)} · {running ? startedAt(when) : when}
              {e.manual ? ` · ${TW.manual}` : ""}
            </span>
            {running && (
              <>
                {" "}
                <ForgotTag since={e.start} />
              </>
            )}
          </p>
          {e.note && <p className="td-enote">{e.note}</p>}
          {isConfirm && (
            <div
              className="td-confirm"
              role="group"
              aria-labelledby={`${id}-cf`}
              ref={confirmRef}
              data-escape-local
            >
              <span id={`${id}-cf`} className="td-confirm-q">
                {TW.confirmDelete}
              </span>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => void onDelete(e)}
                aria-disabled={deleting || undefined}
                aria-busy={deleting || undefined}
              >
                {TW.delete}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" data-cancel onClick={cancelConfirm}>
                {TW.cancel}
              </button>
            </div>
          )}
        </div>
        {e.mine && canEdit && !isConfirm && (
          <button
            type="button"
            className="td-del"
            data-del={e.id}
            aria-label={deleteEntryLabel(what, when)}
            onClick={() => setConfirming(e.id)}
          >
            <IconTrash size={16} aria-hidden="true" />
          </button>
        )}
      </li>
    );
  }

  return (
    <section className="td-sec td-waktu" aria-labelledby={`${id}-h`} ref={sectionRef}>
      <span className="sr-only" role="status" aria-live="polite">
        {say}
      </span>
      <div className="td-sec-head">
        <h3 className="td-sh" id={`${id}-h`}>
          {TW.heading}
        </h3>
        <span className="td-meta">
          {TW.total}{" "}
          <b>
            <Dur secs={total} />
          </b>
        </span>
        {canEdit && (
          <button
            type="button"
            className="btn btn-ghost btn-sm td-link-btn td-log-open"
            ref={logBtnRef}
            aria-expanded={showLog}
            aria-controls={showLog ? `${id}-log` : undefined}
            onClick={() => (showLog ? closeLog() : setLogOpen(true))}
          >
            <IconClockPlus size={17} aria-hidden="true" />
            {TW.logOpen}
          </button>
        )}
      </div>

      {showLog && (
        <form
          className="td-log-form"
          id={`${id}-log`}
          aria-label={TW.logOpen}
          onSubmit={onLog}
          noValidate
          ref={formRef}
          data-escape-local
          data-unsaved={dur.trim() || note.trim() ? "true" : undefined}
        >
          <div className="td-log-row">
            <div className="td-field td-log-dur">
              <label className="td-label" htmlFor={`${id}-dur`}>
                {TW.logDuration}
              </label>
              <input
                id={`${id}-dur`}
                ref={durRef}
                type="text"
                className="td-input td-box td-box-text"
                inputMode="text"
                autoComplete="off"
                value={dur}
                onChange={(e) => {
                  setDur(e.target.value);
                  setDurError(null);
                }}
                aria-invalid={durError ? true : undefined}
                aria-describedby={durError ? `${id}-dur-err ${id}-dur-hint` : `${id}-dur-hint`}
              />
            </div>
            <div className="td-field td-log-note">
              <label className="td-label" htmlFor={`${id}-note`}>
                {TW.logNote}
              </label>
              <input
                id={`${id}-note`}
                type="text"
                className="td-input td-box td-box-text"
                maxLength={200}
                autoComplete="off"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={TW.notePlaceholder}
              />
            </div>
          </div>
          <p className="hint" id={`${id}-dur-hint`}>
            {TW.logDurationHint}
          </p>
          {durError && (
            <div id={`${id}-dur-err`} role="alert">
              <FieldError text={durError} />
            </div>
          )}
          <div className="td-row-end">
            <button type="button" className="btn btn-ghost btn-sm" onClick={closeLog}>
              {TW.cancel}
            </button>
            <button type="submit" className="btn btn-sm" aria-disabled={saving || undefined} aria-busy={saving || undefined}>
              {TW.logSave}
            </button>
          </div>
        </form>
      )}

      <div className="td-time-grid">
        <div>
          <p className="td-mini-h" id={`${id}-pp`}>
            {TW.perPerson}
          </p>
          <ul className="td-kv" aria-labelledby={`${id}-pp`}>
            {people.length === 0 && <li className="td-kv-empty">{TW.nobody}</li>}
            {people.map((t) => (
              <li key={t.person.publicKey}>
                <PersonAvatar person={t.person} />
                <span className="td-kv-name">{who(t.person)}</span>
                {t.runningSince && (
                  <span className="td-run-tag">
                    <span className="td-run" aria-hidden="true" />
                    {TW.running}
                  </span>
                )}
                <span className="v">
                  <Dur secs={t.total} />
                </span>
              </li>
            ))}
            <li className="td-kv-total">
              <span>{TW.totalTask}</span>
              <span className="v">
                <Dur secs={total} />
              </span>
            </li>
          </ul>
        </div>
        <div>
          <p className="td-mini-h" id={`${id}-ps`}>
            {TW.perStatus}
          </p>
          <ul className="td-kv" aria-labelledby={`${id}-ps`}>
            {COLUMN_ORDER.map((c) => {
              const Icon = COLUMN_ICONS[c];
              const current = st.currentColumn === c;
              const secs = statusSecs[c];
              return (
                <li key={c} data-column={c}>
                  <Icon size={17} aria-hidden="true" />
                  <span>{COLUMN_NAMES[c]}</span>
                  {current && <span className="td-tag">{TW.now}</span>}
                  {secs > 0 || current ? (
                    <span className="v">
                      <Dur secs={secs} />
                    </span>
                  ) : (
                    <span className="v muted">{TW.never}</span>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="td-cycle">
            {st.cycleSecs !== null ? (
              <>
                <span aria-hidden="true">{cycleDone(formatDuration(st.cycleSecs))}</span>
                <span className="sr-only">{cycleDone(formatDurationLong(st.cycleSecs))}</span>
              </>
            ) : (
              TW.notDone
            )}
          </p>
        </div>
      </div>

      {st.clockWarning && (
        <p className="td-note">
          <IconClockExclamation size={17} aria-hidden="true" />
          <span>{TW.clockNote}</span>
        </p>
      )}

      {task.timeEntries.length > 0 && (
        <details className="td-entries">
          <summary ref={summaryRef} id={`${id}-hist`}>
            {historySummary(task.timeEntries.length)}
          </summary>
          <ul className="td-elist" aria-labelledby={`${id}-hist`}>{task.timeEntries.map(entryRow)}</ul>
        </details>
      )}
    </section>
  );
}
