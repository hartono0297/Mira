import { IconArrowLeft, IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import { useId, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { api, toAppError, type AppError, type OrgInfo } from "../../api";
import { checkInviteCode, cleanInviteInput, formatInviteCode } from "../../api/inviteCode";
import { inviteErrorText } from "../../api/messages";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import { firewallName } from "../../platform";
import { StepHeading } from "./StepHeading";

type Props = {
  onBack: () => void;
  onFirewall: () => void;
  onJoined: (org: OrgInfo) => void;
  onReload: () => void;
};

type Errors = { code: string | null; address: string | null; server: AppError | null };

const NO_ERRORS: Errors = { code: null, address: null, server: null };

// Kode diformat jadi XXXX-XXXX-... saat kursor di ujung isian. Kalau pengguna
// mengedit di tengah, teks dibiarkan supaya kursor tidak melompat.
export function formatWhileTyping(e: ChangeEvent<HTMLInputElement>): string {
  const raw = e.target.value;
  const atEnd = e.target.selectionStart === null || e.target.selectionStart === raw.length;
  return atEnd ? formatInviteCode(cleanInviteInput(raw)) : raw;
}

export function JoinStep({ onBack, onFirewall, onJoined, onReload }: Props) {
  const [code, setCode] = useState("");
  const [address, setAddress] = useState("");
  const [showAddress, setShowAddress] = useState(false);
  const [errors, setErrors] = useState<Errors>(NO_ERRORS);
  const [searching, setSearching] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const codeId = useId();
  const codeHint = useId();
  const codeErr = useId();
  const addrId = useId();
  const addrHint = useId();
  const addrErr = useId();
  const addrPanel = useId();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (searching) return;
    const check = checkInviteCode(code);
    if (!check.ok) {
      setErrors({ ...NO_ERRORS, code: check.error });
      codeRef.current?.focus();
      return;
    }
    setCode(check.code);
    const addr = address.trim();
    setErrors(NO_ERRORS);
    setSearching(true);
    try {
      const org = await api.joinWithCode(check.code, showAddress && addr ? addr : null);
      onJoined(org);
    } catch (err) {
      const error = toAppError(err);
      setSearching(false);
      if (error.code === "invite_invalid") {
        setErrors({ ...NO_ERRORS, code: error.message });
        codeRef.current?.focus();
      } else if (error.code === "invalid_address") {
        setShowAddress(true);
        setErrors({ ...NO_ERRORS, address: error.message });
        window.setTimeout(() => addressRef.current?.focus(), 0);
      } else {
        // Kalau tidak ada laptop rekan yang ditemukan, buka isian alamat sebagai jalan keluar.
        if (error.code === "no_peer_found") setShowAddress(true);
        setErrors({ ...NO_ERRORS, server: error });
      }
    }
  }

  const text = errors.server ? inviteErrorText(errors.server) : null;

  return (
    <form className="onb-form" onSubmit={submit} noValidate aria-busy={searching || undefined}>
      <StepHeading>Gabung dengan kode undangan</StepHeading>
      <p className="onb-lead">
        Minta kode undangan ke admin tim Anda. Kode berisi 20 huruf dan angka, misalnya ABCD-EFGH-JKMN-PQRS-TVWX.
      </p>

      <div className="field">
        <label htmlFor={codeId}>Kode undangan</label>
        <input
          ref={codeRef}
          id={codeId}
          name="inviteCode"
          className="onb-code"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          value={code}
          onChange={(e) => setCode(formatWhileTyping(e))}
          aria-invalid={errors.code ? true : undefined}
          aria-describedby={`${codeHint} ${codeErr}`}
          disabled={searching}
        />
        <p id={codeHint} className="hint">
          Huruf besar atau kecil sama saja. Spasi dan tanda strip boleh ikut ditempel.
        </p>
        <div id={codeErr} aria-live="polite">
          {errors.code && <FieldError text={errors.code} />}
        </div>
      </div>

      <div className="onb-disclosure">
        <button
          type="button"
          className="onb-disclosure-btn"
          aria-expanded={showAddress}
          aria-controls={addrPanel}
          onClick={() => setShowAddress((v) => !v)}
          disabled={searching}
        >
          {showAddress ? (
            <IconChevronDown size={16} aria-hidden="true" />
          ) : (
            <IconChevronRight size={16} aria-hidden="true" />
          )}
          Rekan tidak ditemukan otomatis?
        </button>
        <div id={addrPanel} hidden={!showAddress} className="field onb-disclosure-panel">
          <label htmlFor={addrId}>Alamat laptop rekan (boleh dikosongkan)</label>
          <input
            ref={addressRef}
            id={addrId}
            name="peerAddress"
            autoComplete="off"
            spellCheck={false}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            aria-invalid={errors.address ? true : undefined}
            aria-describedby={`${addrHint} ${addrErr}`}
            disabled={searching}
          />
          <p id={addrHint} className="hint">
            Minta rekan membuka Pengaturan, bagian Jaringan, di Mira. Isi alamat yang tertera di sana, misalnya
            192.168.1.20 atau 192.168.1.20:47800, atau tempel tautan yang diawali mira://.
          </p>
          <div id={addrErr} aria-live="polite">
            {errors.address && <FieldError text={errors.address} />}
          </div>
        </div>
      </div>

      <div aria-live="polite" role="status" className="onb-live">
        {searching && (
          <div className="onb-searching">
            <strong>Mencari laptop rekan dan memeriksa kode...</strong>
            <p>Ini bisa makan waktu sampai 20 detik. Biarkan jendela ini terbuka.</p>
          </div>
        )}
      </div>

      <div aria-live="polite">
        {text && errors.server && (
          <ErrorAlert title={text.title}>
            <p>{text.body}</p>
            {text.steps && (
              <ol className="onb-steps">
                {text.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            )}
            {errors.server.code === "no_peer_found" && (
              <button type="button" className="btn btn-ghost onb-inline-btn" onClick={onFirewall}>
                Periksa {firewallName()}
              </button>
            )}
            {(errors.server.code === "already_in_org" || errors.server.code === "name_required") && (
              <button type="button" className="btn btn-ghost onb-inline-btn" onClick={onReload}>
                Muat ulang data laptop ini
              </button>
            )}
          </ErrorAlert>
        )}
      </div>

      <div className="onb-actions">
        <button type="button" className="btn btn-ghost" onClick={onBack} disabled={searching}>
          <IconArrowLeft size={18} aria-hidden="true" />
          Kembali
        </button>
        <button type="submit" className="btn" disabled={searching} aria-busy={searching || undefined}>
          {searching ? "Mencari..." : "Gabung ke organisasi"}
        </button>
      </div>
    </form>
  );
}
