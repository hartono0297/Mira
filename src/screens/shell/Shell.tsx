import { IconFileText, IconLayoutKanban, IconMessage, IconSettings, type Icon } from "@tabler/icons-react";
import { useState } from "react";
import { ROLE_LABELS, type AppState, type OrgInfo } from "../../api";
import { Logo } from "../../components/Logo";
import { BoardScreen } from "../board/BoardScreen";
import { ChatScreen } from "../chat/ChatScreen";
import { DocsScreen } from "../docs/DocsScreen";
import { SettingsScreen } from "../settings/SettingsScreen";
import "./shell.css";

export type Section = "chat" | "board" | "docs" | "settings";

const NAV: { id: Section; label: string; icon: Icon }[] = [
  { id: "chat", label: "Chat", icon: IconMessage },
  { id: "board", label: "Board", icon: IconLayoutKanban },
  { id: "docs", label: "Dokumen", icon: IconFileText },
  { id: "settings", label: "Pengaturan", icon: IconSettings },
];

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((p) => [...p][0] ?? "");
  return letters.join("").toUpperCase() || "?";
}

type Props = { state: AppState & { organization: OrgInfo } };

export function Shell({ state }: Props) {
  const [section, setSection] = useState<Section>("chat");
  const name = state.identity.displayName ?? "";
  const org = state.organization;

  return (
    <div className="shell">
      <aside className="side">
        <p className="side-brand">
          <Logo size={24} />
          <span>Mira</span>
        </p>
        <nav aria-label="Menu utama">
          <ul className="side-nav">
            {NAV.map(({ id, label, icon: NavIcon }) => (
              <li key={id}>
                <button
                  type="button"
                  className="side-link"
                  aria-current={section === id ? "page" : undefined}
                  onClick={() => setSection(id)}
                >
                  <NavIcon size={18} aria-hidden="true" />
                  {label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="side-me">
          <span className="avatar" aria-hidden="true">
            {initials(name)}
          </span>
          <div className="side-me-text">
            <p className="side-me-name">{name}</p>
            <p className="side-me-org">
              {org.name}
              <span className="sr-only">, peran </span>
              <span aria-hidden="true"> · </span>
              {ROLE_LABELS[org.role]}
            </p>
          </div>
        </div>
      </aside>
      <div className="content">
        {section === "chat" && <ChatScreen />}
        {section === "board" && <BoardScreen />}
        {section === "docs" && <DocsScreen />}
        {section === "settings" && <SettingsScreen state={state} />}
      </div>
    </div>
  );
}
