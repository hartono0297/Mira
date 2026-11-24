import { IconRefresh, IconShieldCheck, IconShieldExclamation, IconShieldQuestion } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, toAppError, type AppError, type FirewallStatus, type NetworkCategory } from "../api";
import { FIREWALL_TEXT as T } from "../i18n/components";
import { firewallName, isMac } from "../platform";
import { CopyButton } from "./CopyButton";
import { ErrorAlert } from "./ErrorAlert";
import "./firewall.css";

// Read at render time, so the label follows the active language.
function categoryLabel(category: NetworkCategory): string {
  return (T.categories as Record<string, string | undefined>)[category] ?? category;
}

type Load = { kind: "loading" } | { kind: "error"; error: AppError } | { kind: "ready"; status: FirewallStatus };
type Request = { kind: "idle" } | { kind: "busy" } | { kind: "started" } | { kind: "not_started" } | { kind: "error"; error: AppError };

type Props = {
  // Tombol lanjut di bawah panduan. Menerima status terakhir (null kalau belum terbaca).
  footer?: (status: FirewallStatus | null) => ReactNode;
};

// Panduan firewall (F-ID-03). Dipakai di onboarding dan di Pengaturan > Jaringan.
// Windows: status aturan dan tombol izin (UAC). macOS: status dan langkah manual,
// Mira tidak mengubah firewall macOS sendiri.
export function FirewallGuide({ footer }: Props) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [request, setRequest] = useState<Request>({ kind: "idle" });
  const [checking, setChecking] = useState(false);
  const alive = useRef(true);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const status = await api.getFirewallStatus();
      if (!alive.current) return;
      if (!status || typeof status !== "object") throw { code: "unknown", message: T.noStatus };
      setLoad({ kind: "ready", status });
    } catch (err) {
      if (alive.current) setLoad({ kind: "error", error: toAppError(err) });
    } finally {
      if (alive.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void check();
    return () => {
      alive.current = false;
    };
  }, [check]);

  async function allow() {
    setRequest({ kind: "busy" });
    try {
      const result = await api.requestFirewallRule();
      if (alive.current) setRequest({ kind: result?.started ? "started" : "not_started" });
    } catch (err) {
      if (alive.current) setRequest({ kind: "error", error: toAppError(err) });
    }
  }

  const status = load.kind === "ready" ? load.status : null;
  // The core says which firewall it read; before that, the webview decides.
  const mac = status ? status.platform === "macos" : isMac();
  const name = firewallName(mac);
  const needsAction = status !== null && status.supported && status.rule !== "allowed";

  return (
    <div className="fw">
      <div aria-live="polite" className="fw-live">
        {load.kind === "loading" && <p className="hint">{T.checking(name)}</p>}
        {load.kind === "error" && (
          <ErrorAlert title={T.loadErrorTitle(name)}>
            <p>{load.error.message}</p>
            <p>{T.loadErrorBody}</p>
          </ErrorAlert>
        )}
        {status && (mac ? <MacRuleLine status={status} /> : <RuleLine status={status} />)}
      </div>

      {status && status.supported && !mac && <Profiles status={status} />}

      {needsAction && mac && <MacSteps status={status} />}

      {needsAction && !mac && (
        <div className="fw-allow">
          <div className="fw-allow-row">
            <button
              type="button"
              className="btn"
              onClick={allow}
              disabled={request.kind === "busy"}
              aria-busy={request.kind === "busy" || undefined}
            >
              {request.kind === "busy" ? T.allowBusy : T.allow}
            </button>
          </div>
          <p className="hint">{T.allowHint}</p>
          <div aria-live="polite">
            {request.kind === "started" && (
              <p className="ok-line">
                <IconShieldCheck size={16} aria-hidden="true" />
                {T.started}
              </p>
            )}
            {request.kind === "not_started" && (
              <ErrorAlert title={T.notStartedTitle}>
                <p>{T.notStartedBody}</p>
              </ErrorAlert>
            )}
            {request.kind === "error" && (
              <ErrorAlert title={T.requestErrorTitle}>
                <p>{request.error.message}</p>
              </ErrorAlert>
            )}
          </div>

          {status.adminCommand && (
            <div className="fw-admin">
              <p className="fw-label">{T.noAdmin}</p>
              <p className="hint fw-admin-text">{T.noAdminBody}</p>
              <div className="copy-block">
                <pre>{status.adminCommand}</pre>
                <CopyButton text={status.adminCommand} label={T.copyCommand} />
              </div>
            </div>
          )}
        </div>
      )}

      {load.kind !== "loading" && (
        <div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={check} disabled={checking} aria-busy={checking || undefined}>
            <IconRefresh size={16} aria-hidden="true" />
            {checking ? T.recheckBusy : T.recheck}
          </button>
        </div>
      )}

      {footer?.(status)}
    </div>
  );
}

function RuleLine({ status }: { status: FirewallStatus }) {
  if (!status.supported) {
    return (
      <p className="fw-rule">
        <IconShieldQuestion size={20} aria-hidden="true" />
        <span>{T.win.unsupported}</span>
      </p>
    );
  }
  switch (status.rule) {
    case "allowed":
      return (
        <p className="fw-rule fw-rule-ok">
          <IconShieldCheck size={20} aria-hidden="true" />
          <span>{T.win.allowed}</span>
        </p>
      );
    case "blocked":
      return (
        <p className="fw-rule fw-rule-bad">
          <IconShieldExclamation size={20} aria-hidden="true" />
          <span>{T.win.blocked}</span>
        </p>
      );
    case "missing":
      return (
        <p className="fw-rule fw-rule-bad">
          <IconShieldExclamation size={20} aria-hidden="true" />
          <span>{T.win.missing}</span>
        </p>
      );
    default:
      return (
        <p className="fw-rule">
          <IconShieldQuestion size={20} aria-hidden="true" />
          <span>
            {T.win.unknown}
            {status.detail ? T.win.detail(status.detail) : ""}
            {T.win.unknownTail}
          </span>
        </p>
      );
  }
}

// macOS: the status sentence, plus the core's detail when it explains the cause
// (firewall off, "block all incoming connections", Mira set to block).
function MacRuleLine({ status }: { status: FirewallStatus }) {
  const detail = status.detail ? ` ${status.detail}` : "";
  switch (status.rule) {
    case "allowed":
      return (
        <p className="fw-rule fw-rule-ok">
          <IconShieldCheck size={20} aria-hidden="true" />
          <span>
            {T.mac.allowed}
            {detail}
          </span>
        </p>
      );
    case "blocked":
      return (
        <p className="fw-rule fw-rule-bad">
          <IconShieldExclamation size={20} aria-hidden="true" />
          <span>
            {T.mac.blocked}
            {detail}
          </span>
        </p>
      );
    case "missing":
      return (
        <p className="fw-rule fw-rule-bad">
          <IconShieldExclamation size={20} aria-hidden="true" />
          <span>{T.mac.missing}</span>
        </p>
      );
    default:
      return (
        <p className="fw-rule">
          <IconShieldQuestion size={20} aria-hidden="true" />
          <span>
            {T.mac.unknown}
            {detail}
            {T.mac.unknownTail}
          </span>
        </p>
      );
  }
}

// macOS has no permission request Mira can start, so the guide lists the
// manual steps and the Terminal command for IT.
function MacSteps({ status }: { status: FirewallStatus }) {
  return (
    <div className="fw-allow">
      <p className="fw-label">{T.mac.stepsTitle}</p>
      <ol className="fw-steps">
        {T.mac.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p className="hint">{T.mac.adminHint}</p>

      {status.adminCommand && (
        <div className="fw-admin">
          <p className="fw-label">{T.mac.noAdmin}</p>
          <p className="hint fw-admin-text">{T.mac.noAdminBody}</p>
          <div className="copy-block">
            <pre>{status.adminCommand}</pre>
            <CopyButton text={status.adminCommand} label={T.copyCommand} />
          </div>
        </div>
      )}
    </div>
  );
}

function Profiles({ status }: { status: FirewallStatus }) {
  const hasPublic = status.profiles.some((p) => p.category === "public");
  return (
    <div className="fw-profiles">
      <p className="fw-label">{T.profiles.title}</p>
      {status.profiles.length === 0 ? (
        <p className="hint">{T.profiles.none}</p>
      ) : (
        <ul className="fw-list">
          {status.profiles.map((p) => (
            <li key={`${p.interfaceAlias}-${p.name}`}>
              <span className="fw-net">{p.name || p.interfaceAlias}</span>
              {p.name && p.interfaceAlias && <span className="hint">{p.interfaceAlias}</span>}
              <span className={`chip${p.category === "public" ? "" : " chip-on"}`}>{categoryLabel(p.category)}</span>
            </li>
          ))}
        </ul>
      )}
      {hasPublic && <p className="hint">{T.profiles.publicNote}</p>}
    </div>
  );
}
