import { useId, type RefObject } from "react";
import { FieldError } from "../../components/FieldError";
import { MAX_LABEL_LEN, MAX_LABELS, TEKS_DIALOG, teksDialog } from "./teksDialog";

type Props = {
  // Label task ini, lalu label lain yang sudah dipakai di proyek.
  current: string[];
  known: string[];
  draft: string;
  problem: string | null;
  busy: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onToggle: (label: string, on: boolean) => void;
  onDraft: (text: string) => void;
  onAdd: () => void;
};

// Isi pilihan Label: centang label yang sudah ada di proyek, atau tulis label baru.
export function LabelPicker({ current, known, draft, problem, busy, inputRef, onToggle, onDraft, onAdd }: Props) {
  const id = useId();
  const full = current.length >= MAX_LABELS;
  const all = [...current, ...known.filter((k) => !current.some((c) => c.toLowerCase() === k.toLowerCase()))];
  return (
    <div role="dialog" aria-label={TEKS_DIALOG.label}>
      {all.length > 0 ? (
        <fieldset className="td-pop-checks">
          <legend className="sr-only">{TEKS_DIALOG.labelTask}</legend>
          {all.map((l) => {
            const on = current.includes(l);
            return (
              <label key={l} className="td-mi td-mi-checkrow">
                <input
                  type="checkbox"
                  className="td-check"
                  checked={on}
                  disabled={!on && full}
                  onChange={(e) => {
                    if (!busy) onToggle(l, e.target.checked);
                  }}
                />
                <span className="td-mi-text">{l}</span>
              </label>
            );
          })}
        </fieldset>
      ) : (
        <p className="hint td-pop-empty">{TEKS_DIALOG.belumAdaLabelProyek}</p>
      )}
      <form
        className="td-pop-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!full) onAdd();
        }}
      >
        {/* Saat sudah penuh isian tetap ada (tidak hilang dari bawah fokus), tapi tidak bisa
            diisi: aria-disabled dan readOnly, bukan disabled, supaya fokus tidak lepas ke body
            saat label kesepuluh baru saja ditambah dari isian ini. Alasannya di petunjuk. */}
        <label htmlFor={`${id}-in`}>{TEKS_DIALOG.labelBaru}</label>
        <div className="td-pop-row">
          <input
            ref={inputRef}
            id={`${id}-in`}
            className="td-input"
            autoComplete="off"
            maxLength={MAX_LABEL_LEN}
            placeholder={full ? undefined : TEKS_DIALOG.labelBaruPlaceholder}
            value={draft}
            readOnly={full}
            aria-disabled={full || undefined}
            aria-invalid={problem ? true : undefined}
            aria-describedby={`${id}-hint ${id}-err`}
            data-autofocus={all.length === 0 && !full ? true : undefined}
            onChange={(e) => onDraft(e.target.value)}
          />
          <button type="submit" className="btn btn-ghost btn-sm" disabled={full || !draft.trim() || busy}>
            {TEKS_DIALOG.tambah}
          </button>
        </div>
        <p className="hint" id={`${id}-hint`}>
          {full ? teksDialog.sudahBanyakLabel() : teksDialog.petunjukLabel()}
        </p>
        <div className="td-live" id={`${id}-err`} aria-live="polite">
          {problem && <FieldError text={problem} />}
        </div>
      </form>
    </div>
  );
}
