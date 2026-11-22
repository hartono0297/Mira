import { useId, useRef, useState, type FormEvent } from "react";
import { toAppError, type AppError } from "../../api";
import { boardApi, type ProjectSummary } from "../../api/board";
import { Dialog, DialogClose } from "../../components/Dialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import { PROJECT_CODE_RE, suggestCode } from "./format";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: ProjectSummary) => void;
};

export const CODE_RULE = "Kode harus 2 sampai 6 karakter, huruf A sampai Z atau angka, dan diawali huruf. Contoh: PA atau WEB2.";

function serverTitle(error: AppError): string {
  if (error.code === "forbidden") return "Anda tidak punya izin membuat proyek";
  return "Proyek belum dibuat";
}

function serverHint(error: AppError): string | null {
  if (error.code === "forbidden") return "Proyek dibuat oleh superadmin atau admin tim. Minta salah satu dari mereka membuatkannya.";
  return null;
}

// Proyek baru: nama dan kode. Kode diusulkan dari nama sampai orangnya mengubah
// kode sendiri. Tim belum dipilih di sini (proyek organisasi, teamId null).
export function NewProjectDialog({ open, onOpenChange, onCreated }: Props) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [codeTouched, setCodeTouched] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [server, setServer] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const nameErrId = useId();
  const codeId = useId();
  const codeHintId = useId();
  const codeErrId = useId();

  function reset() {
    setName("");
    setCode("");
    setCodeTouched(false);
    setNameError(null);
    setCodeError(null);
    setServer(null);
  }

  function changeName(value: string) {
    setName(value);
    if (!codeTouched) setCode(suggestCode(value));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const cleanName = name.trim();
    const cleanCode = code.trim().toUpperCase();
    setServer(null);
    const nameProblem = cleanName ? null : "Tulis nama proyek dulu.";
    const codeProblem = PROJECT_CODE_RE.test(cleanCode) ? null : CODE_RULE;
    setNameError(nameProblem);
    setCodeError(codeProblem);
    if (nameProblem) {
      nameRef.current?.focus();
      return;
    }
    if (codeProblem) {
      codeRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const project = await boardApi.createProject(cleanName, cleanCode, null);
      reset();
      onCreated(project);
    } catch (err) {
      const error = toAppError(err);
      // Kode yang sudah dipakai proyek lain juga datang sebagai invalid_input.
      if (error.code === "invalid_input" && /kode/i.test(error.message)) {
        setCodeError(error.message);
        codeRef.current?.focus();
      } else if (error.code === "invalid_input" && /nama/i.test(error.message)) {
        setNameError(error.message);
        nameRef.current?.focus();
      } else {
        setServer(error);
      }
    } finally {
      setBusy(false);
    }
  }

  const example = PROJECT_CODE_RE.test(code) ? `${code}-1` : "PA-1";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) reset();
        onOpenChange(next);
      }}
      title="Proyek baru"
      description="Setiap proyek punya board sendiri. Kode proyek menjadi awalan nomor task."
    >
      <form className="np-form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor={nameId}>Nama proyek</label>
          <input
            ref={nameRef}
            id={nameId}
            autoComplete="off"
            value={name}
            onChange={(e) => changeName(e.target.value)}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameErrId}
            disabled={busy}
          />
          <div id={nameErrId} aria-live="polite">
            {nameError && <FieldError text={nameError} />}
          </div>
        </div>
        <div className="field">
          <label htmlFor={codeId}>Kode proyek</label>
          <input
            ref={codeRef}
            id={codeId}
            className="np-code"
            autoComplete="off"
            spellCheck={false}
            maxLength={6}
            value={code}
            onChange={(e) => {
              setCodeTouched(true);
              setCode(e.target.value.toUpperCase().replace(/\s/g, ""));
            }}
            aria-invalid={codeError ? true : undefined}
            aria-describedby={`${codeHintId} ${codeErrId}`}
            disabled={busy}
          />
          <p id={codeHintId} className="hint">
            2 sampai 6 huruf atau angka, diawali huruf. Task di proyek ini diberi nomor seperti {example}. Kode tidak bisa
            diganti setelah proyek dibuat.
          </p>
          <div id={codeErrId} aria-live="polite">
            {codeError && <FieldError text={codeError} />}
          </div>
        </div>
        <div aria-live="polite">
          {server && (
            <ErrorAlert title={serverTitle(server)}>
              <p>{server.message}</p>
              {serverHint(server) && <p>{serverHint(server)}</p>}
            </ErrorAlert>
          )}
        </div>
        <div className="dlg-actions">
          <DialogClose asChild>
            <button type="button" className="btn btn-ghost" disabled={busy}>
              Batal
            </button>
          </DialogClose>
          <button type="submit" className="btn" disabled={busy} aria-busy={busy || undefined}>
            {busy ? "Membuat proyek..." : "Buat proyek"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
