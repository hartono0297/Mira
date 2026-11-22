import { IconChevronDown, IconChevronRight, IconRefresh, IconUserOff } from "@tabler/icons-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api, toAppError, type AppError, type AppState, type OrgInfo } from "../api";
import { checkInviteCode } from "../api/inviteCode";
import { inviteErrorText } from "../api/messages";
import { ErrorAlert } from "../components/ErrorAlert";
import { FieldError } from "../components/FieldError";
import { Logo } from "../components/Logo";
import { formatWhileTyping } from "./onboarding/JoinStep";
import "./status.css";

type Props = {
  state: AppState & { organization: OrgInfo };
  onRecheck: () => void;
  onJoined: (org: OrgInfo) => void;
};

// Layar penuh saat laptop ini dikeluarkan dari organisasi (F-ROLE-05, PRD bagian 12).
export function RemovedScreen({ state, onRecheck, onJoined }: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [showCode, setShowCode] = useState(false);
  const panelId = useId();

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <div className="status-screen">
      <div className="status-brand">
        <Logo size={32} />
        <span>Mira</span>
      </div>
      <main className="status-card" aria-labelledby="removed-title">
        <div className="status-icon status-icon-plain">
          <IconUserOff size={24} aria-hidden="true" />
        </div>
        <h1 id="removed-title" ref={headingRef} tabIndex={-1}>
          Laptop ini sudah dikeluarkan dari organisasi {state.organization.name}
        </h1>
        <p className="status-cause">
          Pesan dan perubahan baru dari organisasi ini tidak lagi dikirim ke laptop ini, dan laptop rekan tidak menerima
          sambungan dari laptop ini.
        </p>
        <p>Data yang sudah ada di laptop ini tetap tersimpan di sini. Mira tidak menghapusnya.</p>
        <p className="status-next">
          <span className="status-label">Langkah berikutnya: </span>
          Kalau ini keliru, minta admin organisasi membuat kode undangan baru untuk Anda. Sebutkan sidik jari laptop ini
          supaya admin yakin orangnya benar: <span className="mono">{state.identity.fingerprint}</span>
        </p>
        <div className="removed-actions">
          <button type="button" className="btn btn-ghost" onClick={onRecheck}>
            <IconRefresh size={18} aria-hidden="true" />
            Periksa lagi
          </button>
          <button
            type="button"
            className="removed-toggle"
            aria-expanded={showCode}
            aria-controls={panelId}
            onClick={() => setShowCode((v) => !v)}
          >
            {showCode ? <IconChevronDown size={16} aria-hidden="true" /> : <IconChevronRight size={16} aria-hidden="true" />}
            Sudah punya kode undangan baru?
          </button>
        </div>
        <div id={panelId} hidden={!showCode}>
          {showCode && <RejoinForm onJoined={onJoined} />}
        </div>
      </main>
    </div>
  );
}

function RejoinForm({ onJoined }: { onJoined: (org: OrgInfo) => void }) {
  const [code, setCode] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [server, setServer] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const errId = useId();
  const ref = useRef<HTMLInputElement>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const check = checkInviteCode(code);
    if (!check.ok) {
      setFieldError(check.error);
      setServer(null);
      ref.current?.focus();
      return;
    }
    setFieldError(null);
    setServer(null);
    setBusy(true);
    try {
      const org = await api.joinWithCode(check.code, null);
      onJoined(org);
    } catch (err) {
      setServer(toAppError(err));
      setBusy(false);
    }
  }

  const text = server ? inviteErrorText(server) : null;

  return (
    <form className="removed-form" onSubmit={submit} noValidate aria-busy={busy || undefined}>
      <div className="field">
        <label htmlFor={inputId}>Kode undangan baru</label>
        <input
          ref={ref}
          id={inputId}
          className="onb-code"
          autoComplete="off"
          spellCheck={false}
          value={code}
          onChange={(e) => setCode(formatWhileTyping(e))}
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={errId}
          disabled={busy}
        />
        <div id={errId} aria-live="polite">
          {fieldError && <FieldError text={fieldError} />}
        </div>
      </div>
      <div aria-live="polite">
        {busy && <p className="hint">Mencari laptop rekan dan memeriksa kode. Ini bisa makan waktu sampai 20 detik.</p>}
        {text && (
          <ErrorAlert title={text.title}>
            <p>{text.body}</p>
            {text.steps && (
              <ol className="removed-steps">
                {/* Langkah terakhir menyebut isian alamat, yang tidak ada di form ini. */}
                {text.steps.slice(0, 3).map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            )}
          </ErrorAlert>
        )}
      </div>
      <div>
        <button type="submit" className="btn" disabled={busy} aria-busy={busy || undefined}>
          {busy ? "Mencari..." : "Gabung lagi dengan kode ini"}
        </button>
      </div>
    </form>
  );
}
