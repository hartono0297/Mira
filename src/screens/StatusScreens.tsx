import { IconAlertTriangle, IconRefresh } from "@tabler/icons-react";
import { useEffect, useRef } from "react";
import type { AppError } from "../api";
import { Logo } from "../components/Logo";
import { STATUS_TEXT as T } from "../i18n/status";
import { isMac } from "../platform";
import "./status.css";

export function LoadingScreen() {
  return (
    <div className="status-screen" role="status" aria-live="polite">
      <div className="status-brand">
        <Logo size={40} />
        <span>Mira</span>
      </div>
      <p className="status-text">{T.loading}</p>
    </div>
  );
}

function nextStep(error: AppError): string {
  const next = T.error.next;
  switch (error.code) {
    case "no_tauri":
      return isMac() ? next.noTauriMac : next.noTauriWindows;
    case "keystore":
      return isMac() ? next.keystoreMac : next.keystoreWindows;
    case "key_mismatch":
      return next.keyMismatch;
    case "database":
      return next.database;
    default:
      return next.other;
  }
}

type ErrorProps = { error: AppError; onRetry: () => void };

export function ErrorScreen({ error, onRetry }: ErrorProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, [error]);

  return (
    <div className="status-screen">
      <div className="status-card" role="alert">
        <div className="status-icon">
          <IconAlertTriangle size={24} aria-hidden="true" />
        </div>
        <h1 ref={headingRef} tabIndex={-1}>
          {T.error.heading}
        </h1>
        <p className="status-cause">{error.message}</p>
        <p className="status-next">
          <span className="status-label">{T.nextLabel}</span>
          {nextStep(error)}
        </p>
        <p className="status-code">{T.error.code(error.code)}</p>
        <div>
          <button type="button" className="btn" onClick={onRetry}>
            <IconRefresh size={18} aria-hidden="true" />
            {T.error.retry}
          </button>
        </div>
      </div>
    </div>
  );
}

// Sidik jari laptop ini untuk dibacakan ke IT atau superadmin. Hanya dibaca,
// jadi teks biasa tanpa bingkai.
export function Fingerprint({ value, hint }: { value: string; hint?: string }) {
  return (
    <div className="status-fp">
      <span className="status-fp-label">{T.fingerprintLabel}</span>
      <span className="mono status-fp-value">{value}</span>
      {hint && <span className="status-fp-hint">{hint}</span>}
    </div>
  );
}
