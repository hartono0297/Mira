import { IconAlertTriangle, IconFileSearch, IconInfoCircle, IconShieldCheck } from "@tabler/icons-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { toAppError, type AppError } from "../../api";
import { signingApi, type VerifyResult } from "../../api/signing";
import { Dialog, DialogClose } from "../../components/Dialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { checkPdfFile, formatWhen, readFileBytes, shortHash } from "./labels";
import { SIGN_DIALOGS } from "../../i18n/sign-dialogs";

// Dibaca saat dipakai, supaya mengikuti bahasa aktif.
const T = () => SIGN_DIALOGS.verify;

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Membuka dokumen asal dari hasil pemeriksaan. Tanpa ini tombolnya tidak tampil.
  onOpenRequest?: (requestId: string) => void;
};

type Checked = { fileName: string; result: VerifyResult };

function Signers({ signers }: { signers: VerifyResult["signers"] }) {
  if (signers.length === 0) return null;
  return (
    <ul className="sign-verify-signers">
      {signers.map((s, i) => (
        <li key={`${i}-${s.displayName}`}>
          <span className="sign-verify-name">{s.displayName}</span>
          <span className="sign-verify-when">{s.signedAt ? formatWhen(s.signedAt) : T().notSigned}</span>
        </li>
      ))}
    </ul>
  );
}

function Result({ checked }: { checked: Checked }) {
  const { result, fileName } = checked;
  const hash = (
    <p className="sign-verify-hash">
      {fileName}, {T().fileHash} <span className="mono">{shortHash(result.fileHash)}</span>
    </p>
  );

  if (result.state === "match_final") {
    return (
      <div className="sign-verify sign-verify-ok">
        <IconShieldCheck size={22} aria-hidden="true" />
        <div>
          <strong>{T().finalTitle}</strong>
          {result.title && <p className="sign-verify-title">{result.title}</p>}
          {result.completedAt && <p>{T().completed(formatWhen(result.completedAt))}</p>}
          <Signers signers={result.signers} />
          {hash}
        </div>
      </div>
    );
  }
  if (result.state === "match_version") {
    // Inti Rust hanya mengirim penanda tangan yang sudah menandatangani sampai versi ini.
    return (
      <div className="sign-verify sign-verify-mid">
        <IconInfoCircle size={22} aria-hidden="true" />
        <div>
          <strong>{T().versionTitle}</strong>
          {result.title && <p className="sign-verify-title">{result.title}</p>}
          <p>
            {result.completedAt
              ? T().versionCompleted(formatWhen(result.completedAt))
              : T().versionOpen}
          </p>
          {result.signers.length > 0 ? (
            <>
              <p className="sign-verify-sub">{T().versionSigners}</p>
              <Signers signers={result.signers} />
            </>
          ) : (
            <p>{T().versionNoSigners}</p>
          )}
          {hash}
        </div>
      </div>
    );
  }
  if (result.state === "changed") {
    return (
      <div className="sign-verify sign-verify-bad">
        <IconAlertTriangle size={22} aria-hidden="true" />
        <div>
          <strong>{T().changedTitle}</strong>
          {result.title && <p>{T().changedOriginal(result.title)}</p>}
          <p>{T().changedBody}</p>
          {hash}
        </div>
      </div>
    );
  }
  return (
    <div className="sign-verify sign-verify-unknown">
      <IconFileSearch size={22} aria-hidden="true" />
      <div>
        <strong>{T().unknownTitle}</strong>
        <p>{T().unknownBody}</p>
        {hash}
      </div>
    </div>
  );
}

export function VerifyDialog({ open, onOpenChange, onOpenRequest }: Props) {
  const [checked, setChecked] = useState<Checked | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pickRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) return;
    setChecked(null);
    setBusy(false);
    setError(null);
  }, [open]);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    setChecked(null);
    const bad = checkPdfFile(file);
    if (bad) {
      setError({ code: "pdf_invalid", message: bad });
      return;
    }
    setBusy(true);
    try {
      const result = await signingApi.verifyFile(await readFileBytes(file));
      setChecked({ fileName: file.name, result });
    } catch (err) {
      setError(toAppError(err));
    } finally {
      setBusy(false);
      // Tombol nonaktif selama memeriksa; fokus dikembalikan supaya tidak lepas ke body.
      requestAnimationFrame(() => pickRef.current?.focus());
    }
  }

  const requestId = checked && checked.result.state !== "unknown" ? checked.result.requestId : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      title={T().title}
      description={T().description}
    >
      <div className="sign-form">
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,.pdf"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={onFile}
        />
        <div>
          <button
            ref={pickRef}
            type="button"
            className={checked ? "btn btn-ghost" : "btn"}
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            aria-busy={busy || undefined}
          >
            <IconFileSearch size={18} aria-hidden="true" />
            {busy ? T().checking : checked ? T().checkAnother : T().pick}
          </button>
        </div>

        <div aria-live="polite" className="sign-live">
          {error && (
            <ErrorAlert title={T().errorTitle}>
              <p>{error.message}</p>
            </ErrorAlert>
          )}
          {checked && <Result checked={checked} />}
        </div>

        <div className="dlg-actions">
          {requestId && onOpenRequest && (
            <button type="button" className="btn btn-ghost" onClick={() => onOpenRequest(requestId)}>
              {T().openDoc}
            </button>
          )}
          <DialogClose asChild>
            <button type="button" className={checked ? "btn" : "btn btn-ghost"} disabled={busy}>
              {T().close}
            </button>
          </DialogClose>
        </div>
      </div>
    </Dialog>
  );
}
