import { useId, useRef, useState, type FormEvent } from "react";
import { toAppError, type AppError } from "../../api";
import { boardApi, type ProjectSummary } from "../../api/board";
import { Dialog, DialogClose } from "../../components/Dialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import { projectNameProblem } from "./format";
import { useHeld } from "./useHeld";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: ProjectSummary;
  onRenamed: (project: ProjectSummary) => void;
};

// Ubah nama proyek (hanya untuk yang boleh mengelola proyek). Kode proyek tetap.
// Nama dari server bisa berubah selama dialog terbuka (rekan juga mengubahnya);
// isian mengikutinya selama belum diketik dan tidak sedang difokus.
export function RenameProjectDialog({ open, onOpenChange, project, onRenamed }: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [server, setServer] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);
  const held = useHeld(project.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const hintId = useId();
  const errId = useId();
  const value = draft ?? held.value;

  function reset() {
    setDraft(null);
    setProblem(null);
    setServer(null);
    held.release();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const clean = value.trim();
    setServer(null);
    const bad = projectNameProblem(clean);
    setProblem(bad);
    if (bad) {
      inputRef.current?.focus();
      return;
    }
    if (clean === project.name) {
      reset();
      onOpenChange(false);
      return;
    }
    setBusy(true);
    try {
      const updated = await boardApi.updateProject(project.id, clean);
      reset();
      onRenamed(updated);
    } catch (err) {
      const error = toAppError(err);
      if (error.code === "invalid_input") {
        setProblem(error.message);
        inputRef.current?.focus();
      } else {
        setServer(error);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) reset();
        onOpenChange(next);
      }}
      title="Ubah nama proyek"
    >
      <form className="np-form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor={inputId}>Nama proyek</label>
          <input
            ref={inputRef}
            id={inputId}
            autoComplete="off"
            value={value}
            onFocus={held.hold}
            onBlur={held.release}
            onChange={(e) => {
              setDraft(e.target.value);
              setProblem(null);
            }}
            aria-invalid={problem ? true : undefined}
            aria-describedby={`${hintId} ${errId}`}
            readOnly={busy}
          />
          <p id={hintId} className="hint">
            2 sampai 80 karakter. Kode {project.code} dan nomor task seperti {project.code}-1 tidak berubah.
          </p>
          <div id={errId} aria-live="polite">
            {problem && <FieldError text={problem} />}
          </div>
        </div>
        <div aria-live="polite">
          {server && (
            <ErrorAlert
              title={server.code === "forbidden" ? "Anda tidak punya izin mengubah nama proyek ini" : "Nama proyek belum diubah"}
            >
              <p>{server.message}</p>
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
            {busy ? "Menyimpan..." : "Simpan nama"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
