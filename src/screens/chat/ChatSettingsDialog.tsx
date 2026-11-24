import { useEffect, useId, useState, type FormEvent } from "react";
import { toAppError, type AppError } from "../../api";
import { divisionApi, type ConversationSettings } from "../../api/division";
import { Dialog, DialogClose } from "../../components/Dialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { CHAT_DIVISION } from "../../i18n/chat-division";
import { InlineError } from "./NewGroupDialog";
import "./division.css";

// Batas inti Rust (chat_settings_set): paling banyak 500 karakter.
export const PINNED_MAX = 500;

// Catatan seperti yang diterima inti: baris baru boleh, karakter kendali lain dibuang (tab jadi
// spasi), tanpa spasi di awal dan akhir.
export function normalizePinned(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "")
    .trim();
}

export function pinnedLength(value: string): number {
  return [...normalizePinned(value)].length;
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: ConversationSettings;
  onSaved: () => void;
};

export function ChatSettingsDialog({ open, onOpenChange, settings, onSaved }: Props) {
  const T = CHAT_DIVISION.dialog;
  const [note, setNote] = useState(settings.pinned);
  const [announce, setAnnounce] = useState(settings.announce);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const ids = useId();
  const division = settings.divisionId !== null;

  // Setiap kali dibuka: mulai dari nilai tersimpan terbaru.
  useEffect(() => {
    if (!open) return;
    setNote(settings.pinned);
    setAnnounce(settings.announce);
    setTried(false);
    setError(null);
  }, [open, settings.pinned, settings.announce]);

  const used = pinnedLength(note);
  const tooLong = used > PINNED_MAX;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setTried(true);
    if (tooLong) return;
    const pinned = normalizePinned(note);
    // Tidak ada yang berubah: inti akan menolaknya sebagai perubahan kosong, jadi cukup ditutup.
    if (pinned === settings.pinned && announce === settings.announce) {
      onOpenChange(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await divisionApi.setChatSettings(settings.teamId, settings.divisionId, pinned, announce);
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(toAppError(err));
    } finally {
      setBusy(false);
    }
  }

  const noteError = tried && tooLong ? T.tooLong(PINNED_MAX) : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        onOpenChange(next);
      }}
      title={T.title}
      description={division ? T.descDivision : T.descTeam}
    >
      <form className="pin-form" onSubmit={(e) => void submit(e)} noValidate>
        <div className="field">
          <label htmlFor={`${ids}-note`}>{T.note}</label>
          <textarea
            id={`${ids}-note`}
            className="pin-form-note"
            rows={5}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-invalid={!!noteError}
            aria-describedby={[`${ids}-hint`, `${ids}-count`, noteError ? `${ids}-error` : ""].filter(Boolean).join(" ")}
            disabled={busy}
          />
          <div className="pin-form-meta">
            <p id={`${ids}-hint`} className="hint">
              {T.noteHint}
            </p>
            <p id={`${ids}-count`} className={tooLong ? "hint pin-form-over" : "hint"}>
              {T.count(used, PINNED_MAX)}
            </p>
          </div>
          {noteError && <InlineError id={`${ids}-error`} text={noteError} />}
        </div>

        <div className="pin-form-check">
          <input
            id={`${ids}-announce`}
            type="checkbox"
            checked={announce}
            onChange={(e) => setAnnounce(e.target.checked)}
            aria-describedby={`${ids}-announce-hint`}
            disabled={busy}
          />
          <div>
            <label htmlFor={`${ids}-announce`}>{T.announce}</label>
            <p id={`${ids}-announce-hint`} className="hint">
              {division ? T.announceDivision : T.announceTeam}
            </p>
          </div>
        </div>

        <div aria-live="polite">
          {error && (
            <ErrorAlert title={T.failed}>
              <p>{error.message}</p>
            </ErrorAlert>
          )}
        </div>

        <div className="dlg-actions">
          <DialogClose asChild>
            <button type="button" className="btn btn-ghost" disabled={busy}>
              {T.cancel}
            </button>
          </DialogClose>
          <button type="submit" className="btn" aria-busy={busy || undefined} disabled={busy}>
            {busy ? T.saving : T.save}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
