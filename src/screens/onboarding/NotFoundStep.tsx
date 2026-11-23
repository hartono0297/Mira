import { IconChevronRight, IconDeviceLaptop, IconKey, IconRefresh } from "@tabler/icons-react";
import { useId, useRef, useState, type FormEvent } from "react";
import { toAppError, type AppError } from "../../api";
import { joinApi, type FoundOffice } from "../../api/join";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import type { SearchEnd } from "./SearchStep";
import { StepHeading } from "./StepHeading";
import { ADMIN_IT } from "./texts";

type Props = {
  end: SearchEnd;
  // Di sesi ini pernah terlihat kantor atau pengumuman kantor. Tombol
  // kantor baru di bagian "Untuk admin IT" diganti penjelasan.
  officeSeen: boolean;
  onOffices: (offices: FoundOffice[]) => void;
  onInvite: () => void;
  onSearchAgain: () => void;
  onNewOffice: () => void;
};

const NO_OFFICE_AT_ADDRESS =
  "Tidak ada kantor yang menjawab dari alamat itu. Periksa alamatnya, dan pastikan Mira di laptop rekan sedang terbuka.";

// (d) Kantor belum ditemukan: alamat laptop rekan, kode undangan, atau cari lagi.
export function NotFoundStep({ end, officeSeen, onOffices, onInvite, onSearchAgain, onNewOffice }: Props) {
  const [address, setAddress] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<AppError | null>(null);
  const [connecting, setConnecting] = useState(false);
  // Bagian "Untuk admin IT" tertutup sampai dibuka. Isinya baru dipasang saat
  // terbuka, jadi tombol kantor baru tidak ada di pohon aksesibilitas.
  const [adminOpen, setAdminOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const hintId = useId();
  const errId = useId();

  async function connect(e: FormEvent) {
    e.preventDefault();
    if (connecting) return;
    const value = address.trim();
    if (!value) {
      setFieldError("Isi alamat laptop rekan dulu, misalnya 192.168.1.20.");
      setServerError(null);
      inputRef.current?.focus();
      return;
    }
    setFieldError(null);
    setServerError(null);
    setConnecting(true);
    try {
      const offices = await joinApi.connectAddress(value);
      if (Array.isArray(offices) && offices.length > 0) {
        onOffices(offices);
        return;
      }
      setConnecting(false);
      setFieldError(NO_OFFICE_AT_ADDRESS);
      inputRef.current?.focus();
    } catch (err) {
      const error = toAppError(err);
      setConnecting(false);
      if (error.code === "invalid_address") {
        setFieldError(error.message);
        inputRef.current?.focus();
      } else {
        setServerError(error);
      }
    }
  }

  const searched = end.kind === "timeout" || end.kind === "mdns";

  return (
    <div className="onb-form">
      <StepHeading>{searched ? "Kantor belum ditemukan" : "Cari kantor dengan cara lain"}</StepHeading>
      {searched ? (
        <p className="onb-lead">
          Tidak ada kantor Mira yang terlihat di jaringan ini. Ini biasa terjadi kalau Anda tersambung lewat VPN,
          atau memakai Wi-Fi tamu yang terpisah dari jaringan kantor.
        </p>
      ) : (
        <p className="onb-lead">
          Kalau kantor Anda tidak muncul di pencarian, sambungkan langsung ke laptop rekan atau pakai kode undangan.
        </p>
      )}

      {end.kind === "mdns" && (
        <div className="onb-note">
          <strong>Pencarian otomatis tidak berjalan di laptop ini</strong>
          {end.error && <p>{end.error}</p>}
          <p>Pakai alamat laptop rekan atau kode undangan di bawah.</p>
        </div>
      )}
      {end.kind === "timeout" && !end.ok && end.error && (
        <div className="onb-note">
          <strong>Pencarian tidak selesai</strong>
          <p>{end.error.message}</p>
        </div>
      )}

      <form className="onb-way" onSubmit={connect} noValidate aria-busy={connecting || undefined}>
        <IconDeviceLaptop size={22} aria-hidden="true" />
        <div className="onb-way-body">
          <label htmlFor={inputId} className="onb-way-title">
            Masukkan alamat laptop rekan
          </label>
          <p id={hintId} className="hint">
            Minta alamat IP dari rekan yang sudah memakai Mira. Alamatnya ada di Mira milik rekan, menu Pengaturan,
            bagian Jaringan.
          </p>
          <div className="onb-way-row">
            <input
              ref={inputRef}
              id={inputId}
              name="peerAddress"
              autoComplete="off"
              spellCheck={false}
              placeholder="contoh: 192.168.1.20"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={`${hintId} ${errId}`}
              disabled={connecting}
            />
            <button type="submit" className="btn btn-sm" disabled={connecting} aria-busy={connecting || undefined}>
              {connecting ? "Menghubungkan..." : "Hubungkan"}
            </button>
          </div>
          <div id={errId} aria-live="polite">
            {fieldError && <FieldError text={fieldError} />}
            {serverError && (
              <ErrorAlert title="Laptop rekan belum tersambung">
                <p>{serverError.message}</p>
              </ErrorAlert>
            )}
          </div>
        </div>
      </form>

      <button type="button" className="onb-choice" onClick={onInvite} disabled={connecting}>
        <IconKey size={22} aria-hidden="true" />
        <span>
          <span className="onb-choice-title">Pakai kode undangan</span>
          <span className="onb-choice-desc">Kode dari admin kantor atau admin departemen.</span>
        </span>
      </button>

      <div className="onb-actions">
        <button type="button" className="btn btn-ghost" onClick={onSearchAgain} disabled={connecting}>
          <IconRefresh size={18} aria-hidden="true" />
          Cari lagi
        </button>
      </div>

      <details className="onb-fold" open={adminOpen}>
        <summary
          onClick={(e) => {
            e.preventDefault();
            setAdminOpen((v) => !v);
          }}
        >
          <IconChevronRight size={16} className="onb-fold-chev" aria-hidden="true" />
          {ADMIN_IT.summary}
        </summary>
        {adminOpen && (
          <div className="onb-fold-body">
            {officeSeen ? (
              <p className="hint">{ADMIN_IT.officeSeen}</p>
            ) : (
              <>
                <p className="hint">{ADMIN_IT.explain}</p>
                <div>
                  <button type="button" className="btn btn-ghost" onClick={onNewOffice} disabled={connecting}>
                    {ADMIN_IT.button}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </details>
    </div>
  );
}
