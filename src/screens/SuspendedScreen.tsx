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

function resultLine(result: MembershipCheck): string {
  const T = STATUS_TEXT.suspended;
  const time = clock(result.checkedAt);
  if (result.membership === "suspended") return T.stillSuspended(time);
  if (result.membership === "removed") return T.removed(time);
  return T.active(time);
}

function showsNotConnected(result: MembershipCheck): boolean {
  return result.membership === "suspended" && result.peersReached === 0;
}

// Layar penuh saat akun orang ini di kantor sedang dinonaktifkan (0.6.0).
// Laptop tetap tersambung untuk sinkron keanggotaan; begitu akun aktif lagi,
// App kembali ke kerangka utama tanpa restart.
export function SuspendedScreen({ state, onRefresh }: Props) {
  const T = STATUS_TEXT.suspended;
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Hanya pemeriksaan dari tombol yang mengganti label tombol. Cek otomatis
  // berjalan diam-diam supaya tombol yang sedang difokus tidak berubah.
  const [manualBusy, setManualBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // Isi wilayah pengumuman pembaca layar, terpisah dari baris hasil yang terlihat.
  const [announcement, setAnnouncement] = useState("");

  const alive = useRef(true);
  const running = useRef(false);
  const manual = useRef(false);
  const lastWasError = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  const check = useCallback(async function run(byUser: boolean): Promise<void> {
    if (byUser && !manual.current) {
      // Klik saat cek otomatis berjalan menjadikan pemeriksaan itu milik pengguna.
      manual.current = true;
      setManualBusy(true);
      setAnnouncement("");
    }
    if (running.current) return;
    running.current = true;
    clearTimeout(timer.current);
    const text = STATUS_TEXT.suspended;
    try {
      const result = await api.checkMembership();
      if (!alive.current) return;
      const changed = result.membership !== "suspended";
      setOutcome({ kind: "result", result });
      if (manual.current || changed) {
        const hint = showsNotConnected(result) ? ` ${text.notConnected}` : "";
        setAnnouncement(resultLine(result) + hint);
      }
      lastWasError.current = false;
      if (changed) void refreshRef.current();
    } catch (err) {
      if (!alive.current) return;
      const error = toAppError(err);
      setOutcome({ kind: "error", error });
      // Error yang sama dari cek otomatis berikutnya tidak dibacakan berulang.
      if (manual.current || !lastWasError.current) setAnnouncement(text.failed(error.message));
      lastWasError.current = true;
    } finally {
      running.current = false;
      manual.current = false;
      if (alive.current) {
        setManualBusy(false);
        timer.current = setTimeout(() => void run(false), AUTO_CHECK_MS);
      }
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    headingRef.current?.focus();
    timer.current = setTimeout(() => void check(false), AUTO_CHECK_MS);
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
          {/* aria-disabled, bukan disabled: tombol yang difokus tetap memegang fokus. */}
          <button
            type="button"
            className="btn status-check-btn"
            onClick={() => {
              if (!manualBusy) void check(true);
            }}
            aria-disabled={manualBusy || undefined}
            aria-busy={manualBusy || undefined}
          >
            <IconRefresh size={18} aria-hidden="true" />
            {manualBusy ? T.checking : T.check}
          </button>
          <div className="status-result" data-testid="status-recheck-result">
            {outcome?.kind === "result" && <CheckResult result={outcome.result} />}
            {outcome?.kind === "error" && (
              <div className="alert">
                <IconAlertTriangle size={18} aria-hidden="true" />
                <p>{T.failed(outcome.error.message)}</p>
              </div>
            )}
          </div>
          <p className="status-auto">{T.auto}</p>
          {/* Dibacakan hanya setelah Periksa lagi, saat keanggotaan berubah, atau
              pada error pertama. Hasil cek otomatis yang sama tidak dibacakan. */}
          <span className="sr-only" aria-live="polite" aria-atomic="true" data-testid="status-recheck-live">
            {announcement}
          </span>
        </div>
      </main>
    </div>
  );
}

function CheckResult({ result }: { result: MembershipCheck }) {
  const T = STATUS_TEXT.suspended;
  return (
    <>
      <p className="status-result-line">{resultLine(result)}</p>
      {showsNotConnected(result) && <p className="status-result-hint">{T.notConnected}</p>}
    </>
  );
}
