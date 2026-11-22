import { IconLock } from "@tabler/icons-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { toAppError, type AppError } from "../../../api";
import { Dialog, DialogClose } from "../../../components/Dialog";
import { ErrorAlert } from "../../../components/ErrorAlert";
import { FieldError } from "../../../components/FieldError";
import { PIN_MAX, lockMinutesFromMessage, validatePin } from "./pin";
import "./pad.css";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  description?: string;
  submitLabel?: string;
  // Waktu ISO akhir kunci dari SavedSignatureInfo.lockedUntil, kalau sudah diketahui
  // saat dialog dibuka. Selama masih di masa depan, tombol kirim nonaktif.
  lockedUntil?: string | null;
  onSubmit: (pin: string) => Promise<void>;
};

type Problem =
  | { kind: "field"; text: string; seq: number }
  // exact: waktu dari lockedUntil inti Rust; kalau tidak, perkiraan dari pesan pin_locked.
  | { kind: "locked"; text: string; until: number; exact: boolean }
  | { kind: "other"; error: AppError };

// Jam:menit, dibulatkan ke atas supaya tombol tidak dijanjikan aktif sebelum kunci habis.
function formatClock(ms: number): string {
  const d = new Date(Math.ceil(ms / 60_000) * 60_000);
  return `${String(d.getHours()).padStart(2, "0")}.${String(d.getMinutes()).padStart(2, "0")}`;
}

function lockFromProp(lockedUntil: string | null | undefined): Problem | null {
  if (!lockedUntil) return null;
  const until = Date.parse(lockedUntil);
  if (!Number.isFinite(until) || until <= Date.now()) return null;
  return {
    kind: "locked",
    text: "Terlalu banyak PIN salah, jadi tanda tangan dikunci sementara.",
    until,
    exact: true,
  };
}

// Dialog memasukkan PIN untuk memakai tanda tangan tersimpan. Enter mengirim.
// Setelah onSubmit berhasil, dialog ditutup.
export function PinDialog({
  open,
  onOpenChange,
  title = "Masukkan PIN",
  description = "PIN tanda tangan Anda diperlukan setiap kali menandatangani.",
  submitLabel = "Tanda tangani",
  lockedUntil,
  onSubmit,
}: Props) {
  const [pin, setPin] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  // Isian nonaktif selama memeriksa; fokus dikembalikan setelah render yang mengaktifkannya lagi.
  const refocus = useRef(false);
  const inputId = useId();
  const errorId = useId();

  useEffect(() => {
    if (open) {
      setProblem(lockFromProp(lockedUntil));
    } else {
      setPin("");
      setProblem(null);
      setBusy(false);
    }
  }, [open, lockedUntil]);

  // Kunci dilepas otomatis saat waktunya habis. Kalau inti Rust ternyata masih
  // mengunci, percobaan berikutnya membalas pin_locked lagi dengan waktu baru.
  const lockedAt = problem?.kind === "locked" ? problem.until : null;
  useEffect(() => {
    if (lockedAt === null) return;
    const timer = window.setTimeout(() => setProblem(null), Math.max(0, lockedAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [lockedAt]);

  const locked = lockedAt !== null;

  useEffect(() => {
    if (busy || !refocus.current) return;
    refocus.current = false;
    inputRef.current?.focus();
  }, [busy]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || locked) return;
    const invalid = validatePin(pin);
    if (invalid) {
      setProblem({ kind: "field", text: invalid, seq: ++seq.current });
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await onSubmit(pin);
      setBusy(false);
      onOpenChange(false);
    } catch (err) {
      const error = toAppError(err);
      refocus.current = true;
      setBusy(false);
      setPin("");
      if (error.code === "pin_wrong" || error.code === "pin_invalid") {
        setProblem({ kind: "field", text: error.message, seq: ++seq.current });
      } else if (error.code === "pin_locked") {
        setProblem({
          kind: "locked",
          text: error.message,
          until: Date.now() + lockMinutesFromMessage(error.message) * 60_000,
          exact: false,
        });
      } else {
        setProblem({ kind: "other", error });
      }
    }
  }

  const fieldText = problem?.kind === "field" || problem?.kind === "locked" ? problem.text : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      title={title}
      description={description}
    >
      <form className="pin-form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor={inputId}>PIN tanda tangan</label>
          <input
            ref={inputRef}
            id={inputId}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={PIN_MAX}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            aria-invalid={problem?.kind === "field" ? true : undefined}
            aria-describedby={errorId}
            disabled={busy}
          />
          <div id={errorId} role="alert">
            {fieldText &&
              (problem?.kind === "locked" ? (
                <p className="pin-locked">
                  <IconLock size={16} aria-hidden="true" />
                  <span>
                    {fieldText} Bisa dicoba lagi {problem.exact ? "" : "sekitar "}pukul {formatClock(problem.until)}.
                  </span>
                </p>
              ) : (
                // key berganti tiap percobaan, supaya pesan yang sama tetap dibacakan ulang.
                <FieldError key={problem?.kind === "field" ? problem.seq : 0} text={fieldText} />
              ))}
          </div>
        </div>

        <div aria-live="polite">
          {problem?.kind === "other" && (
            <ErrorAlert title="Belum bisa dilanjutkan">
              <p>{problem.error.message}</p>
            </ErrorAlert>
          )}
        </div>

        <div className="dlg-actions">
          <DialogClose asChild>
            <button type="button" className="btn btn-ghost" disabled={busy}>
              Batal
            </button>
          </DialogClose>
          <button type="submit" className="btn" disabled={busy || locked} aria-busy={busy || undefined}>
            {busy ? "Memeriksa PIN..." : submitLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
