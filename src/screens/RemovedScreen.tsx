import { IconAlertTriangle, IconRestore, IconUserOff } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { api, toAppError, type AppError, type AppState, type OrgInfo } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Logo } from "../components/Logo";
import { STATUS_TEXT } from "../i18n/status";
import { Fingerprint } from "./StatusScreens";
import "./status.css";

type Props = {
  state: AppState & { organization: OrgInfo };
  // AppState baru setelah reset (tanpa organisasi), App lalu menampilkan onboarding.
  onReset: (state: AppState) => void;
};

// Layar penuh saat laptop ini dikeluarkan permanen dari organisasi (F-ROLE-05,
// PRD bagian 12). Satu-satunya jalan keluar: reset laptop lalu minta bergabung
// lagi sebagai laptop baru (0.5.1).
export function RemovedScreen({ state, onReset }: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const T = STATUS_TEXT.removed;
  const D = T.dialog;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const reset = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.resetRemovedLaptop();
      onReset(next);
    } catch (err) {
      setError(toAppError(err));
      setBusy(false);
    }
  };

  return (
    <div className="status-screen">
      <div className="status-brand">
        <Logo size={32} />
        <span>Mira</span>
      </div>
      <main className="status-card" aria-labelledby="removed-title" data-testid="status-removed">
        <div className="status-icon status-icon-plain">
          <IconUserOff size={24} aria-hidden="true" />
        </div>
        <h1 id="removed-title" ref={headingRef} tabIndex={-1}>
          {T.heading(state.organization.name)}
        </h1>
        <p className="status-cause">{T.cause}</p>
        <p>{T.kept}</p>
        <p>{T.rejoin}</p>
        <div className="removed-actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              setError(null);
              setOpen(true);
            }}
          >
            <IconRestore size={18} aria-hidden="true" />
            {T.reset}
          </button>
        </div>
        <div className="status-contact">
          <p>{T.contact}</p>
          <Fingerprint value={state.identity.fingerprint} />
        </div>
      </main>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={D.title}
        confirmLabel={D.confirm}
        busyLabel={D.busy}
        busy={busy}
        onConfirm={() => void reset()}
        error={
          error && (
            <div className="alert">
              <IconAlertTriangle size={18} aria-hidden="true" />
              <p>{D.failed(error.message)}</p>
            </div>
          )
        }
      >
        <ul className="removed-steps">
          <li>{D.data}</li>
          <li>{D.key}</li>
          <li>{D.start}</li>
          <li>{D.admin}</li>
        </ul>
      </ConfirmDialog>
    </div>
  );
}
