import { useId, useRef, useState, type FormEvent } from "react";
import { toAppError } from "../api";
import { kopiApi, kopiTargetKey, type KopiPerson, type KopiTarget } from "../api/kopi";
import { KOPI_TEXT as T } from "../i18n/kopi";
import { Dialog, DialogClose } from "./Dialog";
import { ErrorAlert } from "./ErrorAlert";
import { FieldError } from "./FieldError";
import { kopiReasonLength } from "./kopiText";
import { useKopi } from "./useKopi";
import "./kopi.css";

// Bawaan kalau ringkasan belum termuat; Rust tetap memeriksa ulang.
const REASON_MAX = 120;
const DAILY_LIMIT = 3;

type Props = {
  open: boolean;
  onClose: () => void;
  to: KopiPerson;
  target: KopiTarget;
  // Potongan pesan atau judul task yang diberi kopi, ditampilkan sebagai pengingat.
  context?: string;
  // Dipanggil setelah kopi terkirim, dengan nama penerima, supaya pemanggil
  // bisa mengumumkannya lewat live region yang tetap ada setelah dialog tertutup.
  // Ringkasan Kopi sudah dimuat ulang oleh dialog ini.
  onGiven?: (name: string) => void;
};

// Dialog Beri kopi: alasan wajib, sisa jatah hari ini, dan catatan bahwa
// alasan terlihat oleh semua orang. Escape dan Batal menutup kecuali saat mengirim.
// Pemanggil sebaiknya memasang dialog hanya saat terbuka; isian juga dikosongkan
// saat ditutup, jadi alasan lama tidak pernah tampil lagi.
export function KopiGiveDialog({ open, onClose, to, target, context, onGiven }: Props) {
  const { overview, reload } = useKopi();
  const [reason, setReason] = useState("");
  const [check, setCheck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const ids = useId();

  function close() {
    setReason("");
    setCheck(false);
    setError(null);
    onClose();
  }

  const max = overview?.reasonMax ?? REASON_MAX;
  const limit = overview?.dailyLimit ?? DAILY_LIMIT;
  const left = overview ? Math.max(0, limit - overview.givenToday) : null;
  const length = kopiReasonLength(reason);
  const reasonError = length === 0 ? T.give.reasonEmpty : length > max ? T.give.reasonTooLong(max, length) : null;
  const showReasonError = reasonError !== null && (check || length > max);

  let blocked: string | null = null;
  if (overview && !overview.canGive) blocked = T.give.cannotGive;
  else if (overview?.givenTargets.includes(kopiTargetKey(to.publicKey, target))) blocked = T.give.already;
  else if (left === 0) blocked = T.give.noneLeft(limit);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || blocked) return;
    setCheck(true);
    if (reasonError) {
      field.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await kopiApi.give({ to: to.publicKey, target, reason: reason.trim() });
      void reload();
      onGiven?.(to.name);
      close();
    } catch (err) {
      setError(toAppError(err).message);
      // Isian tetap bisa difokus selama mengirim (readOnly, bukan disabled).
      field.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  const contextLabel = target.kind === "message" ? T.give.forMessage : target.kind === "task" ? T.give.forTask : null;
  const counterId = `${ids}-counter`;
  const hintId = `${ids}-hint`;
  const errorId = `${ids}-error`;
  const quotaId = `${ids}-quota`;
  // Tombol kirim tidak memakai disabled: saat sibuk ia sedang difokus, dan saat
  // terhalang alasannya harus tetap terbaca. Klik diabaikan di submit().
  const sendOff = busy || blocked !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) close();
      }}
      title={T.give.title(to.name)}
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        field.current?.focus();
      }}
    >
      <form className="kopi-give" onSubmit={submit} noValidate>
        {context && contextLabel && (
          <figure className="kopi-give-context">
            <figcaption>{contextLabel}</figcaption>
            <blockquote>{context}</blockquote>
          </figure>
        )}
        <div className="field">
          <label htmlFor={`${ids}-reason`}>{T.give.reasonLabel}</label>
          <textarea
            id={`${ids}-reason`}
            ref={field}
            className="kopi-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-invalid={showReasonError || undefined}
            aria-describedby={`${hintId} ${counterId}${showReasonError ? ` ${errorId}` : ""}`}
            readOnly={busy}
          />
          <div className="kopi-give-meta">
            <p id={hintId} className="hint">
              {T.give.reasonHint} {T.give.publicNote}
            </p>
            <p id={counterId} className={`hint kopi-counter${length > max ? " kopi-counter-over" : ""}`}>
              {T.give.counter(length, max)}
            </p>
          </div>
          {showReasonError && reasonError && (
            <div id={errorId}>
              <FieldError text={reasonError} />
            </div>
          )}
        </div>
        {(blocked || left !== null) && (
          <p id={quotaId} className={`kopi-give-quota${blocked ? " kopi-give-blocked" : ""}`}>
            {blocked ?? (left !== null ? T.give.left(left, limit) : null)}
          </p>
        )}
        <div aria-live="polite">
          {error && (
            <ErrorAlert title={T.give.failTitle}>
              <p>{error}</p>
            </ErrorAlert>
          )}
        </div>
        <div className="dlg-actions">
          <DialogClose asChild>
            <button type="button" className="btn btn-ghost" disabled={busy}>
              {T.give.cancel}
            </button>
          </DialogClose>
          <button
            type="submit"
            className="btn kopi-btn"
            aria-disabled={sendOff || undefined}
            aria-describedby={blocked ? quotaId : undefined}
            aria-busy={busy || undefined}
          >
            {busy ? T.give.sending : T.give.send}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
