import { LanguagePicker } from "../../components/LanguagePicker";
import { SETTINGS_TEXT as T } from "../../i18n/settings";

// Pengaturan > Bahasa. Ganti bahasa langsung berlaku dan disimpan per laptop.
export function LanguageSection() {
  return (
    <section className="set-section" aria-labelledby="language-title">
      <h2 id="language-title" className="set-title">
        {T.parts.language}
      </h2>
      <LanguagePicker variant="full" />
    </section>
  );
}
