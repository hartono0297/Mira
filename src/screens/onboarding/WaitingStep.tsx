import { useEffect, useRef, useState } from "react";
import { toAppError, type AppError, type OrgInfo } from "../../api";
import { formatDateTime } from "../../api/format";
import { joinApi, type JoinDevice, type OutgoingJoinRequest } from "../../api/join";
import { ErrorAlert } from "../../components/ErrorAlert";
import { StepHeading } from "./StepHeading";

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

  const undelivered = request.lastError && !request.lastSentAt;

  return (
    <div className="onb-form">
      <StepHeading>Menunggu persetujuan</StepHeading>
      <p className="onb-lead">
        Permintaan Anda sudah dikirim ke superadmin dan admin departemen {request.teamName}. Layar ini berganti sendiri
        begitu disetujui.
      </p>

      <div className="onb-box">
        <dl className="onb-kv">
          <dt>Nama</dt>
          <dd>{request.displayName}</dd>
          <dt>Departemen</dt>
          <dd>{request.teamName}</dd>
          <dt>Laptop</dt>
          <dd className="mono">{device?.laptop ?? "belum terbaca"}</dd>
          <dt>Kode cocok</dt>
          <dd>
            <span className="mono onb-match">{request.code}</span>
          </dd>
          <dt>Sidik organisasi</dt>
          <dd className="mono">{request.orgFingerprint}</dd>
        </dl>
      </div>
      <p className="hint">
        Kalau admin bertanya, sebutkan kode cocok ini. Kode yang sama muncul di layarnya, jadi ia tahu yang disetujui
        memang laptop Anda.
      </p>

      <div aria-live="polite">
        {undelivered && (
          <div className="onb-note">
            <strong>Belum ada laptop rekan yang menerima permintaan ini</strong>
            <p>{request.lastError}</p>
            <p>Mira terus mencoba selama layar ini terbuka, dan mengirim ulang saat Mira dibuka lagi.</p>
          </div>
        )}
        {pollError && (
          <div className="onb-note">
            <strong>Status persetujuan belum bisa diperiksa</strong>
            <p>{pollError.message}</p>
            <p>Mira mencoba lagi tiap 5 detik.</p>
          </div>
        )}
      </div>

      <div>
        <p className="onb-label">Kalau lama</p>
        <ul className="onb-list">
          <li>Mira boleh ditutup. Permintaan tersimpan dan dikirim ulang saat Mira dibuka lagi.</li>
          <li>Laptop penyetuju harus menyala dan tersambung ke jaringan yang sama.</li>
          <li>Hubungi superadmin langsung dan sebutkan nama laptop Anda.</li>
        </ul>
      </div>

      <div aria-live="polite">
        {cancelError && (
          <ErrorAlert title="Permintaan belum dibatalkan">
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
          {cancelling ? "Membatalkan..." : "Batalkan permintaan"}
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
  const [error, setError] = useState<{ title: string; error: AppError } | null>(null);

  async function resend() {
    if (busy) return;
    setBusy("resend");
    setError(null);
    try {
      const next = await joinApi.resend();
      onResent(next);
    } catch (err) {
      setBusy(null);
      setError({ title: "Permintaan belum terkirim", error: toAppError(err) });
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
      setError({ title: "Permintaan lama belum terhapus", error: toAppError(err) });
    }
  }

  const who = request.decidedByName ?? "Admin kantor";
  const when = request.decidedAt ? ` pada ${formatDateTime(request.decidedAt)}` : "";

  return (
    <div className="onb-form">
      <StepHeading>Permintaan ditolak</StepHeading>
      <p className="onb-lead">
        {who} menolak permintaan Anda untuk bergabung ke {request.orgName}, departemen {request.teamName}
        {when}.
      </p>
      <p className="onb-lead">
        Tanyakan alasannya langsung ke {request.decidedByName ?? "superadmin"}. Kalau ternyata keliru, kirim permintaan
        lagi. Permintaan baru mendapat kode cocok baru, jadi cocokkan lagi kodenya dengan penyetuju.
      </p>

      <div aria-live="polite">
        {error && (
          <ErrorAlert title={error.title}>
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
          {busy === "search" ? "Menghapus permintaan..." : "Cari kantor lain"}
        </button>
        <button
          type="button"
          className="btn"
          onClick={resend}
          disabled={busy !== null}
          aria-busy={busy === "resend" || undefined}
        >
          {busy === "resend" ? "Mengirim..." : "Kirim permintaan lagi"}
        </button>
      </div>
    </div>
  );
}
