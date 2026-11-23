import {
  IconBuildingCommunity,
  IconFileText,
  IconLayoutKanban,
  IconMessage,
  IconSettings,
  IconSignature,
  type Icon,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { ROLE_LABELS, subscribe, type AppState, type OrgInfo } from "../../api";
import { initials } from "../../components/initials";
import { Logo } from "../../components/Logo";
import { BoardScreen } from "../board/BoardScreen";
import { ChatScreen } from "../chat/ChatScreen";
import { DocsScreen } from "../docs/DocsScreen";
import { OrgScreen } from "../org/OrgScreen";
import { OrgNavCount } from "../org/usePendingJoinCount";
import { SettingsScreen, type SettingsPart } from "../settings/SettingsScreen";
import { SignScreen } from "../sign/SignScreen";
import { UpdateDot } from "../../updates/UpdateDot";
import { NetworkPanel } from "./NetworkPanel";
import { NetworkProvider } from "./NetworkContext";
import "./shell.css";

export type Section = "chat" | "board" | "docs" | "sign" | "org" | "settings";

const NAV: { id: Section; label: string; icon: Icon }[] = [
  { id: "chat", label: "Chat", icon: IconMessage },
  { id: "board", label: "Board", icon: IconLayoutKanban },
  { id: "docs", label: "Dokumen", icon: IconFileText },
  { id: "sign", label: "Tanda tangan", icon: IconSignature },
  { id: "org", label: "Organisasi", icon: IconBuildingCommunity },
  { id: "settings", label: "Pengaturan", icon: IconSettings },
];

type Props = {
  state: AppState & { organization: OrgInfo };
  // Memuat ulang AppState tanpa layar memuat (peran berubah, laptop dikeluarkan).
  onRefresh: () => void;
};

export function Shell({ state, onRefresh }: Props) {
  const [section, setSection] = useState<Section>("chat");
  const [settingsPart, setSettingsPart] = useState<SettingsPart>("appearance");
  const name = state.identity.displayName ?? "";
  const org = state.organization;

  // Perubahan direktori bisa mengubah peran laptop ini atau mengeluarkannya.
  useEffect(() => subscribe("mira://directory", onRefresh), [onRefresh]);

  return (
    <NetworkProvider onRemoved={onRefresh}>
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
                    {id === "settings" && <UpdateDot />}
                    {id === "org" && <OrgNavCount />}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <NetworkPanel onOpenOrg={() => setSection("org")} />
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
          {section === "sign" && <SignScreen />}
          {section === "org" && <OrgScreen state={state} onRefresh={onRefresh} />}
          {section === "settings" && <SettingsScreen state={state} part={settingsPart} onPart={setSettingsPart} />}
        </div>
      </div>
    </NetworkProvider>
  );
}
