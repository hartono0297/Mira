import { useId, useRef, useState, type FormEvent } from "react";
import { api, toAppError, type AppError } from "../../api";
import { checkInviteCode } from "../../api/inviteCode";
import { inviteErrorText, type ErrorText } from "../../api/messages";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import { formatWhileTyping } from "../onboarding/JoinStep";
import type { OrgCtx } from "./context";

// Pesan Rust lama masih bisa menyebut "tim"; di tampilan istilahnya departemen.
function deTim(message: string): string {
  return message.replace(/\btim\b/g, "departemen").replace(/\bTim\b/g, "Departemen");
}

function redeemErrorText(error: AppError): ErrorText {
  if (error.code === "forbidden") {
    return {
      title: "Kode ini tidak bisa Anda pakai",
      body: "Kode undangan hanya untuk orang yang belum punya departemen. Kalau Anda perlu pindah departemen, minta superadmin memindahkan Anda.",
    };
  }
  return inviteErrorText({ ...error, message: deTim(error.message) });
}

// Orang yang belum punya departemen memakai kode undangan untuk masuk ke
// departemen di kode itu. Orang yang sudah di departemen ditolak inti Rust
// (`already_in_department`) dan Tamu juga ditolak, jadi InvitesPanel hanya
// menampilkan formulir ini untuk orang tanpa departemen yang bukan Tamu.
export function RedeemForm({ ctx }: { ctx: OrgCtx }) {
  const [code, setCode] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [server, setServer] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const inputId = useId();
  const hintId = useId();
  const errId = useId();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const check = checkInviteCode(code);
    setServer(null);
    if (!check.ok) {
      setFieldError(check.error);
      ref.current?.focus();
      return;
    }
    setFieldError(null);
    setBusy(true);
    try {
      await api.redeemInvite(check.code);
      setCode("");
      ctx.notify("Kode diterima. Anda sekarang anggota departemen yang tertulis di kode itu.");
      await ctx.reload();
    } catch (err) {
      const error = toAppError(err);
      if (error.code === "invite_invalid") {
        setFieldError(deTim(error.message));
        ref.current?.focus();
      } else {
        setServer(error);
      }
    } finally {
      setBusy(false);
    }
  }

  const text = server ? redeemErrorText(server) : null;

  return (
    <form className="redeem" onSubmit={submit} noValidate aria-labelledby={titleId}>
      <h3 id={titleId} className="set-sub">
        Belum punya departemen? Pakai kode undangan
      </h3>
      <div className="field">
        <label htmlFor={inputId}>Kode undangan</label>
        <div className="manual-row">
          <input
            ref={ref}
            id={inputId}
            className="onb-code"
            autoComplete="off"
            spellCheck={false}
            value={code}
            onChange={(e) => setCode(formatWhileTyping(e))}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={`${hintId} ${errId}`}
            disabled={busy}
          />
          <button type="submit" className="btn" disabled={busy} aria-busy={busy || undefined}>
            {busy ? "Memeriksa kode..." : "Pakai kode"}
          </button>
        </div>
        <p id={hintId} className="hint">
          Kode memasukkan Anda ke departemen yang tertulis di kode itu. Minta kode ke admin departemen atau superadmin.
        </p>
        <div id={errId} aria-live="polite">
          {fieldError && <FieldError text={fieldError} />}
        </div>
      </div>
      <div aria-live="polite">
        {text && (
          <ErrorAlert title={text.title}>
            <p>{text.body}</p>
            {text.steps && (
              <ol className="onb-steps">
                {text.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            )}
          </ErrorAlert>
        )}
      </div>
    </form>
  );
}
