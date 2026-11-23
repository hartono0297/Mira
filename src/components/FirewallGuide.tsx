import { IconRefresh, IconShieldCheck, IconShieldExclamation, IconShieldQuestion } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, toAppError, type AppError, type FirewallStatus, type NetworkCategory } from "../api";
import { firewallName, isMac } from "../platform";
import { CopyButton } from "./CopyButton";
import { ErrorAlert } from "./ErrorAlert";
import "./firewall.css";

const CATEGORY_LABELS: Record<NetworkCategory, string> = {
  public: "Publik",
  private: "Pribadi",
  domain: "Domain kantor",
};

// Where the macOS firewall settings live, in the words of the Indonesian macOS UI.
const MAC_SETTINGS = "Pengaturan Sistem > Jaringan > Firewall";

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
  // The core says which firewall it read; before that, the webview decides.
  const mac = status ? status.platform === "macos" : isMac();
  const name = firewallName(mac);
  const needsAction = status !== null && status.supported && status.rule !== "allowed";

  return (
    <div className="fw">
      <div aria-live="polite" className="fw-live">
        {load.kind === "loading" && <p className="hint">Memeriksa {name}...</p>}
        {load.kind === "error" && (
          <ErrorAlert title={`Status ${name} belum terbaca`}>
            <p>{load.error.message}</p>
            <p>Anda tetap bisa melanjutkan. Kalau rekan nanti tidak bisa tersambung, periksa lagi dari Pengaturan, bagian Jaringan.</p>
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
          Pemeriksaan firewall hanya ada di Windows dan macOS. Kalau rekan tidak bisa tersambung, izinkan Mira menerima
          sambungan UDP di firewall sistem ini.
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
            Firewall macOS tidak menghalangi Mira. Laptop rekan bisa menyambung ke laptop ini.{detail}
          </span>
        </p>
      );
    case "blocked":
      return (
        <p className="fw-rule fw-rule-bad">
          <IconShieldExclamation size={20} aria-hidden="true" />
          <span>Firewall macOS memblokir Mira, jadi laptop rekan tidak bisa menyambung ke laptop ini.{detail}</span>
        </p>
      );
    case "missing":
      return (
        <p className="fw-rule fw-rule-bad">
          <IconShieldExclamation size={20} aria-hidden="true" />
          <span>
            Firewall macOS menyala dan Mira belum ada di daftarnya. Saat Mira mulai menerima sambungan, macOS akan
            bertanya apakah Mira boleh menerima sambungan masuk. Pilih Izinkan.
          </span>
        </p>
      );
    default:
      return (
        <p className="fw-rule">
          <IconShieldQuestion size={20} aria-hidden="true" />
          <span>Mira belum bisa membaca status Firewall macOS.{detail} Langkah di bawah tetap bisa Anda ikuti.</span>
        </p>
      );
  }
}

// macOS has no permission request Mira can start, so the guide lists the
// manual steps and the Terminal command for IT.
function MacSteps({ status }: { status: FirewallStatus }) {
  return (
    <div className="fw-allow">
      <p className="fw-label">Kalau pertanyaan macOS terlewat atau Anda memilih Tolak</p>
      <ol className="fw-steps">
        <li>Buka {MAC_SETTINGS}, lalu klik Pilihan.</li>
        <li>Cari Mira di daftar. Kalau belum ada, klik tombol tambah (+), lalu pilih aplikasi Mira.</li>
        <li>Atur Mira ke Izinkan sambungan masuk, lalu klik OK.</li>
        <li>Kembali ke Mira, lalu tekan Periksa lagi.</li>
      </ol>
      <p className="hint">Mengubah pengaturan firewall meminta kata sandi admin Mac ini.</p>

      {status.adminCommand && (
        <div className="fw-admin">
          <p className="fw-label">Tidak punya hak admin di Mac ini?</p>
          <p className="hint fw-admin-text">
            Kirim perintah ini ke tim IT kantor. Perintah ini dijalankan di Terminal dan mengizinkan Mira menerima
            sambungan dari laptop rekan lewat Firewall macOS.
          </p>
          <div className="copy-block">
            <pre>{status.adminCommand}</pre>
            <CopyButton text={status.adminCommand} label="Salin perintah" />
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
