import { IconCalendarOff, IconCheck } from "@tabler/icons-react";
import { useId, type RefObject } from "react";
import { FieldError } from "../../components/FieldError";
import { quickDues } from "./dueText";
import { moveFocus } from "./TaskPopover";
import { TEKS_DIALOG } from "./teksDialog";

type Props = {
  value: string | null;
  draft: string;
  problem: string | null;
  inputRef: RefObject<HTMLInputElement | null>;
  onDraft: (text: string) => void;
  onPick: (iso: string | null) => void;
  onSubmitDraft: () => void;
  now?: Date;
};

// Isi pilihan Tenggat: pilihan cepat dengan nama hari, Tanpa tenggat, dan
// isian hari/bulan/tahun. Ketikan disimpan di pemanggil supaya tidak hilang
// saat data dimuat ulang.
export function DuePicker({ value, draft, problem, inputRef, onDraft, onPick, onSubmitDraft, now }: Props) {
  const id = useId();
  const options = quickDues(now);
  return (
    <div role="dialog" aria-label={TEKS_DIALOG.tenggat}>
      <div className="td-menu-list" onKeyDown={(e) => moveFocus(e, "button")}>
        {options.map((o) => {
          const on = o.iso === value;
          return (
            <button key={o.key} type="button" className="td-mi" aria-pressed={on} onClick={() => onPick(o.iso)}>
              <span className="td-mi-text">{o.label}</span>
              <span className="td-mi-sub">{o.short}</span>
              {on && <IconCheck size={17} className="td-mi-check" aria-hidden="true" />}
            </button>
          );
        })}
        {value && (
          <button type="button" className="td-mi" onClick={() => onPick(null)}>
            <IconCalendarOff size={17} aria-hidden="true" />
            <span className="td-mi-text">{TEKS_DIALOG.tanpaTenggat}</span>
          </button>
        )}
      </div>
      <form
        className="td-pop-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          onSubmitDraft();
        }}
      >
        <label htmlFor={`${id}-in`}>{TEKS_DIALOG.tanggalLain}</label>
        <div className="td-pop-row">
          <input
            ref={inputRef}
            id={`${id}-in`}
            className="td-input"
            inputMode="numeric"
            autoComplete="off"
            placeholder={TEKS_DIALOG.tanggalPlaceholder}
            value={draft}
            aria-invalid={problem ? true : undefined}
            aria-describedby={`${id}-hint ${id}-err`}
            onChange={(e) => onDraft(e.target.value)}
          />
          <button type="submit" className="btn btn-ghost btn-sm">
            {TEKS_DIALOG.pakai}
          </button>
        </div>
        <p className="hint" id={`${id}-hint`}>
          {TEKS_DIALOG.tanggalPetunjuk}
        </p>
        <div className="td-live" id={`${id}-err`} aria-live="polite">
          {problem && <FieldError text={problem} />}
        </div>
      </form>
    </div>
  );
}
