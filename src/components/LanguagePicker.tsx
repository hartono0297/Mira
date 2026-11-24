import { LANG_NAMES, LANGS, type Lang } from "../i18n/core";
import { LANGUAGE_TEXT as T } from "../i18n/language";
import { useLanguageChoice } from "../i18n/preference";
import { ErrorAlert } from "./ErrorAlert";
import "./language-picker.css";

type Props = {
  // "full" untuk Pengaturan (kartu pilihan, catatan, status simpan),
  // "compact" untuk langkah pertama onboarding (dua pilihan sebaris).
  variant?: "full" | "compact";
};

// Pilihan bahasa tampilan. Ganti langsung berlaku tanpa memulai ulang Mira,
// lalu disimpan per laptop. Nama bahasa selalu dalam bahasanya sendiri.
export function LanguagePicker({ variant = "full" }: Props) {
  const { lang, choose, saving, error } = useLanguageChoice();

  const options = LANGS.map((l: Lang) => (
    <label key={l} className="lang-option" lang={l}>
      <input
        type="radio"
        name={`mira-language-${variant}`}
        value={l}
        checked={lang === l}
        onChange={() => void choose(l)}
      />
      <span>{LANG_NAMES[l]}</span>
    </label>
  ));

  return (
    <div className={`lang-picker lang-picker-${variant}`}>
      <fieldset className="lang-fieldset">
        {/* Di Pengaturan judul bagian sudah "Bahasa", jadi legend hanya untuk pembaca layar. */}
        <legend className={variant === "full" ? "sr-only" : "lang-legend"}>{T.legend}</legend>
        <div className="lang-options">{options}</div>
      </fieldset>
      {variant === "full" && (
        <>
          <p className="hint">{T.hint}</p>
          <p className="hint">{T.userText}</p>
        </>
      )}
      <div aria-live="polite" className="set-live">
        {saving && <p className="hint">{T.saving}</p>}
        {error && (
          <ErrorAlert title={T.errorTitle}>
            <p>{T.errorBody(error.error.message, LANG_NAMES[error.kept])}</p>
          </ErrorAlert>
        )}
      </div>
    </div>
  );
}
