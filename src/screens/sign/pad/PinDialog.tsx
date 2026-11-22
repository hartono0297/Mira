import { IconLock } from "@tabler/icons-react";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { toAppError, type AppError } from "../../../api";
import { Dialog, DialogClose } from "../../../components/Dialog";
import { ErrorAlert } from "../../../components/ErrorAlert";
import { FieldError } from "../../../components/FieldError";
import { formatSignedAt } from "../stamp";
import { PIN_MAX, lockMinutesFromMessage, validatePin } from "./pin";
import "./pad.css";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  description?: string;
  submitLabel?: string;
  // Tombol kirim berwarna bahaya, untuk tindakan yang tidak bisa dibatalkan.
  danger?: boolean;
  // Waktu ISO akhir kunci dari SavedSignatureInfo.lockedUntil, kalau sudah diketahui
  // saat dialog dibuka. Selama masih di masa depan, tombol kirim nonaktif.
  lockedUntil?: string | null;
  // Waktu ISO dari SavedSignatureInfo.usableAfter: tanda tangan yang dibuat setelah
  // dihapus tanpa PIN baru bisa dipakai mulai waktu ini. Sampai itu tombol kirim nonaktif.
  usableAfter?: string | null;
  // Aksi tambahan di kiri tombol Batal, mis. "Lupa PIN?". Tetap aktif saat terkunci.
  extraAction?: ReactNode;
  onSubmit: (pin: string) => Promise<void>;
};

type Problem =
  | { kind: "field"; text: string; seq: number }
  // until null: tidak ada waktu pasti (masa tunggu dari inti Rust tanpa usableAfter),
  // tombol tetap nonaktif sampai dialog dibuka lagi.
  | { kind: "locked"; text: string; until: number | null }
  | { kind: "other"; error: AppError };

// Jam:menit dengan zona (mis. "15.04 WIB"), dibulatkan ke atas supaya tombol
// tidak dijanjikan aktif sebelum kunci habis. Zona sama dengan catatan di PDF.
function clockAt(ms: number): string {
  const d = new Date(Math.ceil(ms / 60_000) * 60_000);
  try {
    return formatSignedAt(d).split(", ").pop() ?? "";
  } catch {
    return `${String(d.getHours()).padStart(2, "0")}.${String(d.getMinutes()).padStart(2, "0")}`;
  }
}

function lockProblem(until: number): Problem {
  return { kind: "locked", text: `Terlalu banyak PIN salah. Coba lagi pukul ${clockAt(until)}.`, until };
}

function futureTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t > Date.now() ? t : null;
}

function formatWhen(ms: number): string {
  try {
    return formatSignedAt(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString("id-ID");
  }
}

function initialProblem(lockedUntil: string | null | undefined, usableAfter: string | null | undefined): Problem | null {
  const usable = futureTime(usableAfter);
  if (usable !== null) {
    return {
      kind: "locked",
      text: `Tanda tangan ini baru bisa dipakai mulai ${formatWhen(usable)}, 24 jam setelah tanda tangan sebelumnya dihapus tanpa PIN.`,
      until: usable,
    };
  }
  const lock = futureTime(lockedUntil);
  return lock === null ? null : lockProblem(lock);
}

// pin_wrong yang sekaligus memicu kunci ("PIN salah. Tanda tangan dikunci
// sementara, ...") diperlakukan seperti pin_locked. "Sisa N kali lagi sebelum
// dikunci" bukan kunci.
export function isLockMessage(message: string): boolean {
  return /dikunci/i.test(message) && !/sebelum dikunci/i.test(message);
}

// Dialog memasukkan PIN untuk memakai tanda tangan tersimpan. Enter mengirim.
// Setelah onSubmit berhasil, dialog ditutup.
export function PinDialog({
  open,
  onOpenChange,
  title = "Masukkan PIN",
  description = "PIN tanda tangan Anda diperlukan setiap kali menandatangani.",
  submitLabel = "Tanda tangani",
  danger = false,
  lockedUntil,
  usableAfter,
  extraAction,
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
      setProblem(initialProblem(lockedUntil, usableAfter));
    } else {
      setPin("");
      setProblem(null);
      setBusy(false);
    }
  }, [open, lockedUntil, usableAfter]);

  // Kunci dilepas otomatis saat waktunya habis. Kalau inti Rust ternyata masih
  // mengunci, percobaan berikutnya membalas pin_locked lagi dengan waktu baru.
  const locked = problem?.kind === "locked";
  const lockedAt = problem?.kind === "locked" ? problem.until : null;
  useEffect(() => {
    if (lockedAt === null) return;
    const ms = Math.min(Math.max(0, lockedAt - Date.now()), 2 ** 31 - 1);
    const timer = window.setTimeout(() => setProblem(null), ms);
    return () => window.clearTimeout(timer);
  }, [lockedAt]);

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
      const lockedNow = error.code === "pin_locked" || (error.code === "pin_wrong" && isLockMessage(error.message));
      if (lockedNow) {
        setProblem(lockProblem(Date.now() + lockMinutesFromMessage(error.message) * 60_000));
      } else if (error.code === "signature_cooling") {
        setProblem({ kind: "locked", text: error.message, until: futureTime(usableAfter) });
      } else if (error.code === "pin_wrong" || error.code === "pin_invalid") {
        setProblem({ kind: "field", text: error.message, seq: ++seq.current });
      } else {
        setProblem({ kind: "other", error });
      }
    }
  }

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
            {problem?.kind === "locked" && (
              <p className="pin-locked">
                <IconLock size={16} aria-hidden="true" />
                <span>{problem.text}</span>
              </p>
            )}
            {problem?.kind === "field" && (
              // key berganti tiap percobaan, supaya pesan yang sama tetap dibacakan ulang.
              <FieldError key={problem.seq} text={problem.text} />
            )}
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
          {extraAction && <div className="pin-extra">{extraAction}</div>}
          <DialogClose asChild>
            <button type="button" className="btn btn-ghost" disabled={busy}>
              Batal
            </button>
          </DialogClose>
          <button
            type="submit"
            className={`btn${danger ? " btn-danger" : ""}`}
            disabled={busy || locked}
            aria-busy={busy || undefined}
          >
            {busy ? "Memeriksa PIN..." : submitLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
