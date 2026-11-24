import type { AppState, OrgInfo } from "../../api";
import { SETTINGS_TEXT as T } from "../../i18n/settings";
import { AboutSection } from "./AboutSection";
import { AppearanceSection } from "./AppearanceSection";
import { DeviceSection } from "./DeviceSection";
import { LanguageSection } from "./LanguageSection";
import { NetworkSection } from "./NetworkSection";
import "./settings.css";

export type SettingsPart = "appearance" | "language" | "network" | "device" | "about";

// Urutan menu. Labelnya dibaca dari T.parts saat render, supaya ikut bahasa aktif.
const PARTS: readonly SettingsPart[] = ["appearance", "language", "network", "device", "about"];

type Props = {
  state: AppState & { organization: OrgInfo };
  part: SettingsPart;
  onPart: (part: SettingsPart) => void;
};

export function SettingsScreen({ state, part, onPart }: Props) {
  const current = PARTS.includes(part) ? part : PARTS[0];

  return (
    <main className="settings" aria-labelledby="page-title">
      <header className="page-head">
        <h1 id="page-title" className="page-title">
          {T.title}
        </h1>
        <span className="page-sub">{T.parts[current]}</span>
      </header>
      <div className="settings-layout">
        <nav aria-label={T.partsNav}>
          <ul className="settings-nav">
            {PARTS.map((id) => (
              <li key={id}>
                <button
                  type="button"
                  className="settings-link"
                  aria-current={part === id ? "true" : undefined}
                  onClick={() => onPart(id)}
                >
                  {T.parts[id]}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="settings-body">
          {current === "appearance" && <AppearanceSection />}
          {current === "language" && <LanguageSection />}
          {current === "network" && <NetworkSection />}
          {current === "device" && <DeviceSection state={state} />}
          {current === "about" && <AboutSection />}
        </div>
      </div>
    </main>
  );
}
