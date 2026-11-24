import { IconAlertTriangle, IconRefresh, IconUserPause } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, toAppError, type AppError, type AppState, type MembershipCheck, type OrgInfo } from "../api";
import { Logo } from "../components/Logo";
import { locale } from "../i18n/core";
import { STATUS_TEXT } from "../i18n/status";
import { Fingerprint } from "./StatusScreens";
import "./status.css";

// Jeda cek otomatis. Hitungan dimulai lagi setelah setiap pemeriksaan selesai,
// jadi dua pemeriksaan tidak pernah berjalan bersamaan.
export const AUTO_CHECK_MS = 20_000;

type Props = {
  state: AppState & { organization: OrgInfo };
  // Memuat ulang AppState tanpa layar memuat. App lalu memilih layar sesuai keanggotaan.
  onRefresh: () => Promise<void> | void;
};

type Outcome = { kind: "result"; result: MembershipCheck } | { kind: "error"; error: AppError };

// Jam dan menit dalam bahasa aktif: 14.20 (id-ID) atau 14:20 (en-GB).
function clock(iso: string): string {
  const parsed = new Date(iso);
  const d = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
}

// Layar penuh saat akun orang ini di kantor sedang dinonaktifkan (0.5.1).
// Laptop tetap tersambung untuk sinkron keanggotaan; begitu akun aktif lagi,
// App kembali ke kerangka utama tanpa restart.
export function SuspendedScreen({ state, onRefresh }: Props) {
  const T = STATUS_TEXT.suspended;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const alive = useRef(true);
  const running = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  const check = useCallback(async function run(): Promise<void> {
    if (running.current) return;
    running.current = true;
    clearTimeout(timer.current);
    setBusy(true);
    try {
      const result = await api.checkMembership();
      if (!alive.current) return;
      setOutcome({ kind: "result", result });
      if (result.membership !== "suspended") void refreshRef.current();
    } catch (err) {
      if (alive.current) setOutcome({ kind: "error", error: toAppError(err) });
    } finally {
      running.current = false;
      if (alive.current) {
        setBusy(false);
        timer.current = setTimeout(() => void run(), AUTO_CHECK_MS);
      }
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    headingRef.current?.focus();
    timer.current = setTimeout(() => void check(), AUTO_CHECK_MS);
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
    };
  }, [check]);

  return (
    <div className="status-screen">
      <div className="status-brand">
        <Logo size={32} />
        <span>Mira</span>
      </div>
      <main className="status-card" aria-labelledby="suspended-title" data-testid="status-suspended">
        <div className="status-icon status-icon-plain">
          <IconUserPause size={24} aria-hidden="true" />
        </div>
        <h1 id="suspended-title" ref={headingRef} tabIndex={-1}>
          {T.heading(state.organization.name)}
        </h1>
        <p className="status-cause">{T.contact}</p>
        <p>{T.kept}</p>
        <Fingerprint value={state.identity.fingerprint} hint={T.fingerprintHint} />
        <div className="status-check">
          <button
            type="button"
            className="btn status-check-btn"
            onClick={() => void check()}
            disabled={busy}
            aria-busy={busy || undefined}
          >
            <IconRefresh size={18} aria-hidden="true" />
            {busy ? T.checking : T.check}
          </button>
          <div className="status-result" aria-live="polite" aria-atomic="true" data-testid="status-recheck-result">
            {outcome?.kind === "result" && <CheckResult result={outcome.result} />}
            {outcome?.kind === "error" && (
              <div className="alert">
                <IconAlertTriangle size={18} aria-hidden="true" />
                <p>{T.failed(outcome.error.message)}</p>
              </div>
            )}
          </div>
          <p className="status-auto">{T.auto}</p>
        </div>
      </main>
    </div>
  );
}

function CheckResult({ result }: { result: MembershipCheck }) {
  const T = STATUS_TEXT.suspended;
  const time = clock(result.checkedAt);
  const line =
    result.membership === "suspended"
      ? T.stillSuspended(time)
      : result.membership === "removed"
        ? T.removed(time)
        : T.active(time);
  return (
    <>
      <p className="status-result-line">{line}</p>
      {result.membership === "suspended" && result.peersReached === 0 && (
        <p className="status-result-hint">{T.notConnected}</p>
      )}
    </>
  );
}
