import { IconChevronRight, IconDeviceLaptop, IconKey, IconRefresh } from "@tabler/icons-react";
import { useId, useRef, useState, type FormEvent } from "react";
import { toAppError, type AppError } from "../../api";
import { joinApi, type FoundOffice } from "../../api/join";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import { anySeen, LegacyOffices, legacyOnly, SecondOfficeGuard, type SeenOffices } from "./OfficeGuard";
import type { SearchEnd } from "./SearchStep";
import { StepHeading } from "./StepHeading";
import { ADMIN_IT, ONB } from "./texts";

type Props = {
  end: SearchEnd;
  // Kantor yang pernah terlihat di sesi ini. Kalau ada, kantor baru di bagian
  // "Untuk admin IT" baru terbuka setelah peringatan dan konfirmasi.
  seen: SeenOffices;
  // Domain AD laptop ini. Sama dengan domain kantor yang terlihat: tanpa kantor baru.
  laptopDomain: string | null;
  onOffices: (offices: FoundOffice[]) => void;
  onInvite: () => void;
  onSearchAgain: () => void;
  onNewOffice: () => void;
};

// (d) Kantor belum ditemukan: alamat laptop rekan, kode undangan, atau cari lagi.
export function NotFoundStep({ end, seen, laptopDomain, onOffices, onInvite, onSearchAgain, onNewOffice }: Props) {
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
  const T = ONB.notFound;

  async function connect(e: FormEvent) {
    e.preventDefault();
    if (connecting) return;
    const value = address.trim();
    if (!value) {
      setFieldError(T.addressEmpty);
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
      setFieldError(T.noOfficeAtAddress);
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
  const officeSeen = anySeen(seen);
  const legacy = legacyOnly(seen);
  // Kantor versi lama terlihat: jangan menulis "belum ditemukan".
  const legacyFound = searched && legacy.length > 0;

  return (
    <div className="onb-form">
      <StepHeading>{legacyFound ? T.headingLegacy : searched ? T.headingSearched : T.headingOther}</StepHeading>
      {/* Kantor versi lama: judul dan catatan di bawahnya sudah menjelaskan. */}
      {!legacyFound && <p className="onb-lead">{searched ? T.leadSearched : T.leadOther}</p>}

      <LegacyOffices legacy={legacy} />

      {end.kind === "mdns" && (
        <div className="onb-note">
          <strong>{T.mdnsTitle}</strong>
          {end.error && <p>{end.error}</p>}
          <p>{T.mdnsHint}</p>
        </div>
      )}
      {end.kind === "timeout" && !end.ok && end.error && (
        <div className="onb-note">
          <strong>{T.incompleteTitle}</strong>
          <p>{end.error.message}</p>
        </div>
      )}

      <form className="onb-way" onSubmit={connect} noValidate aria-busy={connecting || undefined}>
        <IconDeviceLaptop size={22} aria-hidden="true" />
        <div className="onb-way-body">
          <label htmlFor={inputId} className="onb-way-title">
            {T.addressLabel}
          </label>
          <p id={hintId} className="hint">
            {T.addressHint}
          </p>
          <div className="onb-way-row">
            <input
              ref={inputRef}
              id={inputId}
              name="peerAddress"
              autoComplete="off"
              spellCheck={false}
              placeholder={T.addressPlaceholder}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={`${hintId} ${errId}`}
              disabled={connecting}
            />
            <button type="submit" className="btn btn-sm" disabled={connecting} aria-busy={connecting || undefined}>
              {connecting ? T.connecting : T.connect}
            </button>
          </div>
          <div id={errId} aria-live="polite">
            {fieldError && <FieldError text={fieldError} />}
            {serverError && (
              <ErrorAlert title={T.connectFailed}>
                <p>{serverError.message}</p>
              </ErrorAlert>
            )}
          </div>
        </div>
      </form>

      <button type="button" className="onb-choice" onClick={onInvite} disabled={connecting}>
        <IconKey size={22} aria-hidden="true" />
        <span>
          <span className="onb-choice-title">{T.inviteTitle}</span>
          <span className="onb-choice-desc">{T.inviteDesc}</span>
        </span>
      </button>

      <div className="onb-actions">
        <button type="button" className="btn btn-ghost" onClick={onSearchAgain} disabled={connecting}>
          <IconRefresh size={18} aria-hidden="true" />
          {T.searchAgain}
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
              <SecondOfficeGuard
                seen={seen}
                laptopDomain={laptopDomain}
                onJoin={onOffices}
                onConfirmed={onNewOffice}
                disabled={connecting}
              />
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
