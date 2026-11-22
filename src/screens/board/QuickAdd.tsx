import { IconPlus } from "@tabler/icons-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { toAppError, type AppError } from "../../api";
import { boardApi, type ColumnId, type TaskDetail } from "../../api/board";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";

type Props = {
  projectId: string;
  columnId: ColumnId;
  columnName: string;
  open: boolean;
  // Teks yang belum disimpan, disimpan pemanggil per kolom supaya tidak hilang saat ditutup.
  draft: string;
  onDraftChange: (text: string) => void;
  onOpenChange: (open: boolean) => void;
  onCreated: (task: TaskDetail) => void;
};

// Tambah task cepat di bawah kolom: judul saja. Enter menyimpan dan form tetap
// terbuka untuk task berikutnya, Escape menutup tanpa membuang teks.
export function QuickAdd({ projectId, columnId, columnName, open, draft, onDraftChange, onOpenChange, onCreated }: Props) {
  const title = draft;
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [server, setServer] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const inputId = useId();
  const hintId = useId();
  const errId = useId();

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      addRef.current?.focus();
    }
  }, [open]);

  function close() {
    returnFocus.current = true;
    setFieldError(null);
    setServer(null);
    onOpenChange(false);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const clean = title.trim();
    setServer(null);
    if (!clean) {
      setFieldError("Tulis judul task dulu.");
      inputRef.current?.focus();
      return;
    }
    setFieldError(null);
    setBusy(true);
    try {
      const task = await boardApi.createTask(projectId, { title: clean, columnId });
      onCreated(task);
    } catch (err) {
      const error = toAppError(err);
      if (error.code === "invalid_input") setFieldError(error.message);
      else setServer(error);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  if (!open) {
    return (
      <button ref={addRef} type="button" className="qa-open" data-qa-open={columnId} onClick={() => onOpenChange(true)}>
        <IconPlus size={16} aria-hidden="true" />
        Tambah task
      </button>
    );
  }

  return (
    <form className="qa" onSubmit={submit} noValidate>
      <label htmlFor={inputId} className="sr-only">
        Judul task baru di {columnName}
      </label>
      <input
        ref={inputRef}
        id={inputId}
        className="qa-input"
        data-qa={columnId}
        autoComplete="off"
        placeholder="Judul task"
        value={title}
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
        aria-invalid={fieldError ? true : undefined}
        aria-describedby={`${hintId} ${errId}`}
        readOnly={busy}
      />
      <p id={hintId} className="qa-hint">
        Enter menyimpan. Escape menutup, teksnya tetap ada saat dibuka lagi.
      </p>
      <div id={errId} aria-live="polite">
        {fieldError && <FieldError text={fieldError} />}
      </div>
      <div aria-live="polite">
        {server && (
          <ErrorAlert
            title={server.code === "forbidden" ? "Anda tidak punya izin membuat task di proyek ini" : "Task belum dibuat"}
          >
            <p>{server.message}</p>
          </ErrorAlert>
        )}
      </div>
      <div className="qa-actions">
        <button type="button" className="btn btn-ghost btn-sm qa-cancel" onClick={close} disabled={busy}>
          Tutup
        </button>
        <button type="submit" className="btn btn-sm" disabled={busy} aria-busy={busy || undefined}>
          {busy ? "Menyimpan..." : "Simpan"}
        </button>
      </div>
    </form>
  );
}
