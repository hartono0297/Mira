import { useEffect, useRef, useState } from "react";
import { toAppError, type AppError, type OrgInfo } from "../../api";
import { formatDateTime } from "../../api/format";
import { joinApi, type JoinDevice, type OutgoingJoinRequest } from "../../api/join";
import { ErrorAlert } from "../../components/ErrorAlert";
import { ouPath } from "./adProfile";
import { StepHeading } from "./StepHeading";
import { ONB, WAITING } from "./texts";

export const POLL_MS = 5_000;

type WaitingProps = {
  request: OutgoingJoinRequest;
  device: JoinDevice | null;
  onApproved: (org: OrgInfo) => void;
  onRejected: (request: OutgoingJoinRequest) => void;
  // Permintaan sudah tidak ada (dibatalkan) atau dibatalkan dari layar ini.
  onGone: () => void;
};

// (c) Menunggu persetujuan. joinApi.poll() tiap 5 detik selama layar terbuka,
// tidak pernah tumpang tindih.
export function WaitingStep({ request: initial, device, onApproved, onRejected, onGone }: WaitingProps) {
  const [request, setRequest] = useState(initial);
  const [pollError, setPollError] = useState<AppError | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<AppError | null>(null);
  const handlers = useRef({ onApproved, onRejected, onGone });
  handlers.current = { onApproved, onRejected, onGone };
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;
    let timer: number | undefined;
    let alive = true;

    async function tick() {
      try {
        const result = await joinApi.poll();
        if (!alive || stopped.current) return;
        setPollError(null);
        if (result && typeof result === "object") {
          if (result.status === "approved") {
            alive = false;
            handlers.current.onApproved(result.org);
            return;
          }
          if (result.status === "rejected") {
            alive = false;
            handlers.current.onRejected(result.request);
            return;
          }
          if (result.status === "none") {
            alive = false;
            handlers.current.onGone();
            return;
          }
          if (result.status === "pending" && result.request) setRequest(result.request);
        }
      } catch (err) {
        if (!alive || stopped.current) return;
        setPollError(toAppError(err));
      }
      if (alive) timer = window.setTimeout(() => void tick(), POLL_MS);
    }

    timer = window.setTimeout(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, []);

  async function cancel() {
    if (cancelling) return;
    setCancelling(true);
    setCancelError(null);
    stopped.current = true;
    try {
      await joinApi.cancel();
      handlers.current.onGone();
    } catch (err) {
      stopped.current = false;
      setCancelling(false);
      setCancelError(toAppError(err));
    }
  }

  // mark_join_sent menulis lastSentAt di setiap percobaan dan mengosongkan
  // lastError kalau ada laptop rekan yang menerima.
  const undelivered = Boolean(request.lastError);
  // Akun login ikut permintaan hanya bersama keterangan (bentuk v0.4). Permintaan
  // tanpa keterangan bisa berbentuk v0.3, jadi akunnya tidak diklaim terlihat admin.
  // Permintaan dengan data AD menampilkan akun Windows; baris akun login tidak diulang.
  const accountSent = Boolean(request.note) && Boolean(device?.account) && !request.ad;
  const adLocation = request.ad ? ouPath(request.ad.dn) : null;

  return (
    <div className="onb-form">
      <StepHeading>{WAITING.heading}</StepHeading>
      <p className="onb-lead">{WAITING.lead(request.teamName)}</p>

      <div className="onb-box">
        <p className="onb-label">{WAITING.adminSees}</p>
        <dl className="onb-kv">
          <dt>{WAITING.name}</dt>
          <dd>{request.displayName}</dd>
          <dt>{WAITING.team}</dt>
          <dd>{request.teamName}</dd>
          {request.note && (
            <>
              <dt>{WAITING.note}</dt>
              <dd>{request.note}</dd>
            </>
          )}
          <dt>{WAITING.laptop}</dt>
          <dd className="mono">{device?.laptop ?? WAITING.laptopUnknown}</dd>
          {accountSent && (
            <>
              <dt>{WAITING.account}</dt>
              <dd className="mono">{device?.account}</dd>
            </>
          )}
          {request.ad && (
            <>
              <dt>{WAITING.adAccount}</dt>
              <dd className="mono" data-testid="onb-ad-waiting-account">{`${request.ad.user}@${request.ad.domain}`}</dd>
              {adLocation && (
                <>
                  <dt>{WAITING.adLocation}</dt>
                  <dd>{adLocation}</dd>
                </>
              )}
            </>
          )}
          <dt>{WAITING.code}</dt>
          <dd>
            <span className="mono onb-match">{request.code}</span>
          </dd>
          <dt>{WAITING.fingerprint}</dt>
          <dd className="mono">{request.orgFingerprint}</dd>
        </dl>
      </div>
      {device?.account && !accountSent && !request.ad && (
        <dl className="onb-kv">
          <dt>{WAITING.accountFact}</dt>
          <dd className="mono">{device.account}</dd>
        </dl>
      )}
      <p className="hint">{WAITING.codeHint}</p>

      <div aria-live="polite">
        {undelivered && (
          <div className="onb-note">
            <strong>{WAITING.undeliveredTitle}</strong>
            <p>{request.lastError}</p>
            <p>{WAITING.undeliveredHint}</p>
          </div>
        )}
        {pollError && (
          <div className="onb-note">
            <strong>{WAITING.pollTitle}</strong>
            <p>{pollError.message}</p>
            <p>{WAITING.pollHint}</p>
          </div>
        )}
      </div>

      <div>
        <p className="onb-label">{WAITING.slowTitle}</p>
        <ul className="onb-list">
          {WAITING.slow.map((tip) => (
            <li key={tip}>{tip}</li>
          ))}
        </ul>
      </div>

      <div aria-live="polite">
        {cancelError && (
          <ErrorAlert title={WAITING.cancelFailed}>
            <p>{cancelError.message}</p>
          </ErrorAlert>
        )}
      </div>

      <div className="onb-actions">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={cancel}
          disabled={cancelling}
          aria-busy={cancelling || undefined}
        >
          {cancelling ? WAITING.cancelling : WAITING.cancel}
        </button>
      </div>
    </div>
  );
}

type RejectedProps = {
  request: OutgoingJoinRequest;
  onResent: (request: OutgoingJoinRequest) => void;
  onSearch: () => void;
};

// Permintaan ditolak: siapa dan kapan, lalu kirim lagi atau cari kantor lain.
export function RejectedStep({ request, onResent, onSearch }: RejectedProps) {
  const [busy, setBusy] = useState<"resend" | "search" | null>(null);
  // Judul error disimpan sebagai jenisnya, supaya ikut bahasa aktif.
  const [error, setError] = useState<{ kind: "send" | "delete"; error: AppError } | null>(null);
  const T = ONB.rejected;

  async function resend() {
    if (busy) return;
    setBusy("resend");
    setError(null);
    try {
      const next = await joinApi.resend();
      onResent(next);
    } catch (err) {
      setBusy(null);
      setError({ kind: "send", error: toAppError(err) });
    }
  }

  async function searchOther() {
    if (busy) return;
    setBusy("search");
    setError(null);
    try {
      await joinApi.cancel();
      onSearch();
    } catch (err) {
      setBusy(null);
      setError({ kind: "delete", error: toAppError(err) });
    }
  }

  const who = request.decidedByName ?? T.someone;
  const when = request.decidedAt ? formatDateTime(request.decidedAt) : null;

  return (
    <div className="onb-form">
      <StepHeading>{T.heading}</StepHeading>
      <p className="onb-lead">{T.lead(who, request.orgName, request.teamName, when)}</p>
      <p className="onb-lead">{T.askWhy(request.decidedByName ?? T.askWhyFallback)}</p>

      <div aria-live="polite">
        {error && (
          <ErrorAlert title={error.kind === "send" ? T.sendFailed : T.deleteFailed}>
            <p>{error.error.message}</p>
          </ErrorAlert>
        )}
      </div>

      <div className="onb-actions">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={searchOther}
          disabled={busy !== null}
          aria-busy={busy === "search" || undefined}
        >
          {busy === "search" ? T.deleting : T.searchOther}
        </button>
        <button
          type="button"
          className="btn"
          onClick={resend}
          disabled={busy !== null}
          aria-busy={busy === "resend" || undefined}
        >
          {busy === "resend" ? T.sending : T.resend}
        </button>
      </div>
    </div>
  );
}
