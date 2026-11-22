import { IconRefresh, IconUserOff } from "@tabler/icons-react";
import { useEffect, useRef } from "react";
import type { AppState, OrgInfo } from "../api";
import { Logo } from "../components/Logo";
import "./status.css";

type Props = {
  state: AppState & { organization: OrgInfo };
  onRecheck: () => void;
};

// Layar penuh saat laptop ini dikeluarkan dari organisasi (F-ROLE-05, PRD bagian 12).
export function RemovedScreen({ state, onRecheck }: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);

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
          Laptop ini sudah dikeluarkan dari organisasi {state.organization.name}
        </h1>
        <p className="status-cause">
          Pesan dan perubahan baru dari organisasi ini tidak lagi dikirim ke laptop ini, dan laptop rekan tidak menerima
          sambungan dari laptop ini.
        </p>
        <p>Data yang sudah ada di laptop ini tetap tersimpan di sini. Mira tidak menghapusnya.</p>
        <p className="status-next">
          <span className="status-label">Langkah berikutnya: </span>
          Kalau ini keliru, hubungi superadmin organisasi. Laptop yang sudah dikeluarkan belum bisa bergabung lagi
          dengan kode undangan di versi ini. Sebutkan sidik jari laptop ini supaya superadmin yakin orangnya benar:{" "}
          <span className="mono">{state.identity.fingerprint}</span>
        </p>
        <div className="removed-actions">
          <button type="button" className="btn btn-ghost" onClick={onRecheck}>
            <IconRefresh size={18} aria-hidden="true" />
            Periksa lagi
          </button>
        </div>
      </main>
    </div>
  );
}
