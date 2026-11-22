import type { AppState, OrgInfo } from "../../api";
import { AppearanceSection } from "./AppearanceSection";
import { DeviceSection } from "./DeviceSection";
import { NetworkSection } from "./NetworkSection";
import "./settings.css";

export type SettingsPart = "appearance" | "network" | "device";

const PARTS: { id: SettingsPart; label: string }[] = [
  { id: "appearance", label: "Tampilan" },
  { id: "network", label: "Jaringan" },
  { id: "device", label: "Laptop ini" },
];

type Props = {
  state: AppState & { organization: OrgInfo };
  part: SettingsPart;
  onPart: (part: SettingsPart) => void;
};

export function SettingsScreen({ state, part, onPart }: Props) {
  const current = PARTS.find((p) => p.id === part) ?? PARTS[0];

  return (
    <main className="settings" aria-labelledby="page-title">
      <header className="page-head">
        <h1 id="page-title" className="page-title">
          Pengaturan
        </h1>
        <span className="page-sub">{current.label}</span>
      </header>
      <div className="settings-layout">
        <nav aria-label="Bagian pengaturan">
          <ul className="settings-nav">
            {PARTS.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="settings-link"
                  aria-current={part === p.id ? "true" : undefined}
                  onClick={() => onPart(p.id)}
                >
                  {p.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="settings-body">
          {current.id === "appearance" && <AppearanceSection />}
          {current.id === "network" && <NetworkSection />}
          {current.id === "device" && <DeviceSection state={state} />}
        </div>
      </div>
    </main>
  );
}
