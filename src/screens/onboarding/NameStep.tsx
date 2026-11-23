import { useId, useRef, useState, type FormEvent } from "react";
import { api, toAppError, type AppError, type IdentityInfo } from "../../api";
import { validateDisplayName } from "../../api/validation";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import { StepHeading } from "./StepHeading";
import { NAME_STEP } from "./texts";

type Props = {
  identity: IdentityInfo;
  // Nama yang tersimpan, dipakai Onboarding untuk langkah berikutnya.
  onDone: (identity: IdentityInfo) => void;
};

// Langkah 1: nama tampilan. Disimpan di sini, sebelum mencari kantor, supaya
// formulir kantor tinggal memilih kantor dan departemen.
export function NameStep({ identity, onDone }: Props) {
  const [name, setName] = useState(identity.displayName ?? "");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<AppError | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Nama sudah diteruskan: tekan Lanjut lagi selagi langkah berikutnya bersiap tidak berbuat apa-apa.
  const done = useRef(false);
  const ids = { input: useId(), hint: useId(), err: useId() };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving || done.current) return;
    const problem = validateDisplayName(name);
    if (problem) {
      setFieldError(problem);
      setServerError(null);
      inputRef.current?.focus();
      return;
    }
    setFieldError(null);
    setServerError(null);
    const trimmed = name.trim();
    if (trimmed === identity.displayName) {
      done.current = true;
      onDone(identity);
      return;
    }
    setSaving(true);
    try {
      const saved = await api.saveDisplayName(trimmed);
      done.current = true;
      onDone(saved && typeof saved === "object" ? saved : { ...identity, displayName: trimmed });
    } catch (err) {
      const error = toAppError(err);
      setSaving(false);
      if (error.code === "invalid_name") {
        setFieldError(error.message);
        inputRef.current?.focus();
      } else {
        setServerError(error);
      }
    }
  }

  return (
    <form className="onb-form" onSubmit={submit} noValidate aria-busy={saving || undefined}>
      <StepHeading>{NAME_STEP.heading}</StepHeading>
      <p className="onb-lead">{NAME_STEP.lead}</p>

      <div className="field">
        <label htmlFor={ids.input}>{NAME_STEP.label}</label>
        <input
          ref={inputRef}
          id={ids.input}
          name="displayName"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={`${ids.hint} ${ids.err}`}
          disabled={saving}
        />
        <p id={ids.hint} className="hint">
          {NAME_STEP.hint}
        </p>
        <div id={ids.err} aria-live="polite">
          {fieldError && <FieldError text={fieldError} />}
        </div>
      </div>

      <div aria-live="polite">
        {serverError && (
          <ErrorAlert title={NAME_STEP.saveFailed}>
            <p>{serverError.message}</p>
          </ErrorAlert>
        )}
      </div>

      <div className="onb-actions">
        <button type="submit" className="btn" disabled={saving} aria-busy={saving || undefined}>
          {saving ? NAME_STEP.saving : NAME_STEP.submit}
        </button>
      </div>
    </form>
  );
}
