import { IconAlertTriangle, IconRefresh } from "@tabler/icons-react";
import { useEffect, useRef } from "react";
import type { AppError } from "../api";
import { Logo } from "../components/Logo";
import { isMac } from "../platform";
import "./status.css";

export function LoadingScreen() {
  return (
    <div className="status-screen" role="status" aria-live="polite">
      <div className="status-brand">
        <Logo size={40} />
        <span>Mira</span>
      </div>
      <p className="status-text">Membuka data Mira di laptop ini...</p>
    </div>
  );
}

function nextStep(error: AppError): string {
  switch (error.code) {
    case "no_tauri":
      return isMac()
        ? "Tutup halaman ini, lalu buka Mira dari folder Aplikasi atau Launchpad."
        : "Tutup halaman ini, lalu buka Mira lewat ikon aplikasinya di menu Start atau di desktop.";
    case "keystore":
      return isMac()
        ? "Mira menyimpan kunci laptop di Keychain macOS. Coba lagi. Kalau macOS menanyakan izin Keychain untuk Mira, pilih Izinkan. Kalau tetap gagal, mulai ulang laptop lalu buka Mira lagi."
        : "Mira menyimpan kunci laptop di Windows Credential Manager. Coba lagi. Kalau tetap gagal, mulai ulang laptop lalu buka Mira lagi.";
    case "key_mismatch":
      return "Jangan hapus folder data Mira. Hubungi admin organisasi Anda dan sebutkan kode error di bawah.";
    case "database":
      return "Tutup jendela Mira lain yang mungkin masih terbuka, lalu coba lagi.";
    default:
      return "Coba lagi. Kalau masih gagal, tutup Mira lalu buka kembali.";
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
          Mira belum bisa dibuka
        </h1>
        <p className="status-cause">{error.message}</p>
        <p className="status-next">
          <span className="status-label">Langkah berikutnya: </span>
          {nextStep(error)}
        </p>
        <p className="status-code">Kode error: {error.code}</p>
        <div>
          <button type="button" className="btn" onClick={onRetry}>
            <IconRefresh size={18} aria-hidden="true" />
            Coba lagi
          </button>
        </div>
      </div>
    </div>
  );
}
