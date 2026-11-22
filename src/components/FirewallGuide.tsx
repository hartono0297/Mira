import { IconRefresh, IconShieldCheck, IconShieldExclamation, IconShieldQuestion } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, toAppError, type AppError, type FirewallStatus, type NetworkCategory } from "../api";
import { CopyButton } from "./CopyButton";
import { ErrorAlert } from "./ErrorAlert";
import "./firewall.css";

const CATEGORY_LABELS: Record<NetworkCategory, string> = {
  public: "Publik",
  private: "Pribadi",
  domain: "Domain kantor",
};

type Load = { kind: "loading" } | { kind: "error"; error: AppError } | { kind: "ready"; status: FirewallStatus };
type Request = { kind: "idle" } | { kind: "busy" } | { kind: "started" } | { kind: "not_started" } | { kind: "error"; error: AppError };

type Props = {
  // Tombol lanjut di bawah panduan. Menerima status terakhir (null kalau belum terbaca).
  footer?: (status: FirewallStatus | null) => ReactNode;
};

// Panduan Windows Firewall (F-ID-03). Dipakai di onboarding dan di Pengaturan > Jaringan.
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
      if (!status || typeof status !== "object") throw { code: "unknown", message: "Inti Mira tidak mengirim status firewall." };
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

  return (
    <div className="fw">
      <div aria-live="polite" className="fw-live">
        {load.kind === "loading" && <p className="hint">Memeriksa Windows Firewall...</p>}
        {load.kind === "error" && (
          <ErrorAlert title="Status Windows Firewall belum terbaca">
            <p>{load.error.message}</p>
            <p>Anda tetap bisa melanjutkan. Kalau rekan nanti tidak bisa tersambung, periksa lagi dari Pengaturan, bagian Jaringan.</p>
          </ErrorAlert>
        )}
        {status && <RuleLine status={status} />}
      </div>

      {status && status.supported && <Profiles status={status} />}

      {status && status.supported && status.rule !== "allowed" && (
        <div className="fw-allow">
          <div className="fw-allow-row">
            <button
              type="button"
              className="btn"
              onClick={allow}
              disabled={request.kind === "busy"}
              aria-busy={request.kind === "busy" || undefined}
            >
              {request.kind === "busy" ? "Membuka jendela izin..." : "Izinkan lewat Windows Firewall"}
            </button>
          </div>
          <p className="hint">
            Windows akan menampilkan jendela izin administrator. Kalau akun Anda bukan administrator, jendela itu meminta
            nama dan kata sandi admin.
          </p>
          <div aria-live="polite">
            {request.kind === "started" && (
              <p className="ok-line">
                <IconShieldCheck size={16} aria-hidden="true" />
                Jendela izin Windows sudah dibuka. Setelah Anda memilih Ya di jendela itu, tekan Periksa lagi.
              </p>
            )}
            {request.kind === "not_started" && (
              <ErrorAlert title="Jendela izin Windows tidak terbuka">
                <p>Mungkin jendelanya ditutup atau dibatalkan. Coba lagi, atau kirim perintah di bawah ke tim IT.</p>
              </ErrorAlert>
            )}
            {request.kind === "error" && (
              <ErrorAlert title="Izin belum bisa diminta">
                <p>{request.error.message}</p>
              </ErrorAlert>
            )}
          </div>

          {status.adminCommand && (
            <div className="fw-admin">
              <p className="fw-label">Tidak punya hak administrator?</p>
              <p className="hint fw-admin-text">
                Kirim perintah ini ke tim IT kantor. Perintah ini menambah satu aturan Windows Firewall yang mengizinkan
                Mira menerima sambungan dari laptop rekan.
              </p>
              <div className="copy-block">
                <pre>{status.adminCommand}</pre>
                <CopyButton text={status.adminCommand} label="Salin perintah" />
              </div>
            </div>
          )}
        </div>
      )}

      {load.kind !== "loading" && (
        <div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={check} disabled={checking} aria-busy={checking || undefined}>
            <IconRefresh size={16} aria-hidden="true" />
            {checking ? "Memeriksa..." : "Periksa lagi"}
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
        <span>
          Pemeriksaan firewall hanya ada di Windows. Kalau rekan tidak bisa tersambung, izinkan Mira menerima sambungan
          UDP di firewall sistem ini.
        </span>
      </p>
    );
  }
  switch (status.rule) {
    case "allowed":
      return (
        <p className="fw-rule fw-rule-ok">
          <IconShieldCheck size={20} aria-hidden="true" />
          <span>Windows Firewall sudah mengizinkan Mira. Laptop rekan bisa menyambung ke laptop ini.</span>
        </p>
      );
    case "blocked":
      return (
        <p className="fw-rule fw-rule-bad">
          <IconShieldExclamation size={20} aria-hidden="true" />
          <span>
            Windows Firewall memblokir Mira. Laptop rekan tidak bisa menyambung ke laptop ini sampai aturan itu diganti.
          </span>
        </p>
      );
    case "missing":
      return (
        <p className="fw-rule fw-rule-bad">
          <IconShieldExclamation size={20} aria-hidden="true" />
          <span>
            Belum ada aturan Windows Firewall untuk Mira. Tanpa aturan ini, laptop rekan mungkin tidak bisa menemukan
            dan menyambung ke laptop ini.
          </span>
        </p>
      );
    default:
      return (
        <p className="fw-rule">
          <IconShieldQuestion size={20} aria-hidden="true" />
          <span>
            Mira belum bisa membaca aturan Windows Firewall.
            {status.detail ? ` Keterangan dari Windows: ${status.detail}` : ""} Anda tetap bisa meminta izin di bawah.
          </span>
        </p>
      );
  }
}

function Profiles({ status }: { status: FirewallStatus }) {
  const hasPublic = status.profiles.some((p) => p.category === "public");
  return (
    <div className="fw-profiles">
      <p className="fw-label">Jaringan yang sedang dipakai laptop ini</p>
      {status.profiles.length === 0 ? (
        <p className="hint">Windows tidak melaporkan jaringan yang tersambung. Periksa kabel LAN atau Wi-Fi.</p>
      ) : (
        <ul className="fw-list">
          {status.profiles.map((p) => (
            <li key={`${p.interfaceAlias}-${p.name}`}>
              <span className="fw-net">{p.name || p.interfaceAlias}</span>
              {p.name && p.interfaceAlias && <span className="hint">{p.interfaceAlias}</span>}
              <span className={`chip${p.category === "public" ? "" : " chip-on"}`}>{CATEGORY_LABELS[p.category] ?? p.category}</span>
            </li>
          ))}
        </ul>
      )}
      {hasPublic && (
        <p className="hint">
          Windows paling ketat di jaringan Publik. Jaringan VPN sering tercatat sebagai Publik, jadi aturan Mira juga
          dipasang untuk jaringan Publik.
        </p>
      )}
    </div>
  );
}
