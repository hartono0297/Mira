import { IconRefresh, IconUserOff } from "@tabler/icons-react";
import { useEffect, useRef } from "react";
import type { AppState, OrgInfo } from "../api";
import { Logo } from "../components/Logo";
import { STATUS_TEXT } from "../i18n/status";
import "./status.css";

type Props = {
  state: AppState & { organization: OrgInfo };
  onRecheck: () => void;
};

// Layar penuh saat laptop ini dikeluarkan dari organisasi (F-ROLE-05, PRD bagian 12).
export function RemovedScreen({ state, onRecheck }: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const T = STATUS_TEXT.removed;

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
          {T.heading(state.organization.name)}
        </h1>
        <p className="status-cause">{T.cause}</p>
        <p>{T.kept}</p>
        <p className="status-next">
          <span className="status-label">{STATUS_TEXT.nextLabel}</span>
          {T.next} <span className="mono">{state.identity.fingerprint}</span>
        </p>
        <div className="removed-actions">
          <button type="button" className="btn btn-ghost" onClick={onRecheck}>
            <IconRefresh size={18} aria-hidden="true" />
            {T.recheck}
          </button>
        </div>
      </main>
    </div>
  );
}
