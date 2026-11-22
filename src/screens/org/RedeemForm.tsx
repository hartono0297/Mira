import { useId, useRef, useState, type FormEvent } from "react";
import { api, toAppError, type AppError } from "../../api";
import { checkInviteCode } from "../../api/inviteCode";
import { inviteErrorText } from "../../api/messages";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import { formatWhileTyping } from "../onboarding/JoinStep";
import type { OrgCtx } from "./context";

// Anggota yang sudah ada memakai kode undangan untuk masuk ke tim lain.
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
      ctx.notify("Kode diterima. Tim baru muncul di daftar tim Anda.");
      await ctx.reload();
    } catch (err) {
      const error = toAppError(err);
      if (error.code === "invite_invalid") {
        setFieldError(error.message);
        ref.current?.focus();
      } else {
        setServer(error);
      }
    } finally {
      setBusy(false);
    }
  }

  const text = server ? inviteErrorText(server) : null;

  return (
    <form className="redeem" onSubmit={submit} noValidate aria-labelledby={titleId}>
      <h3 id={titleId} className="set-sub">
        Punya kode undangan untuk tim lain?
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
          Anda tetap anggota tim yang sekarang. Kode ini menambahkan Anda ke tim lain.
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
