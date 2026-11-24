// Pembantu tes bahasa. Di aplikasi, akar (main.tsx) render ulang seluruh pohon
// saat bahasa berganti; LangRoot meniru akar itu di tes.
import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { setLang, useLang, type Lang } from "../i18n/core";

export function LangRoot({ render: draw }: { render: () => ReactElement }) {
  useLang();
  return draw();
}

// Render dengan bahasa tertentu; ganti bahasa di tengah tes tetap berlaku.
export function renderInLang(draw: () => ReactElement, lang: Lang = "en"): RenderResult {
  setLang(lang);
  return render(<LangRoot render={draw} />);
}
