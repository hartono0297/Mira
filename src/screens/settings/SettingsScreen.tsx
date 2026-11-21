import { useState } from "react";
import type { AppState, OrgInfo } from "../../api";
import { AppearanceSection } from "./AppearanceSection";
import { DeviceSection } from "./DeviceSection";
import "./settings.css";

type Part = "appearance" | "device";

const PARTS: { id: Part; label: string }[] = [
  { id: "appearance", label: "Tampilan" },
  { id: "device", label: "Laptop ini" },
];

export function SettingsScreen({ state }: { state: AppState & { organization: OrgInfo } }) {
  const [part, setPart] = useState<Part>("appearance");
  const current = PARTS.find((p) => p.id === part)!;

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
                  onClick={() => setPart(p.id)}
                >
                  {p.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="settings-body">
          {part === "appearance" ? <AppearanceSection /> : <DeviceSection state={state} />}
        </div>
      </div>
    </main>
  );
}
