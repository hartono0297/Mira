import {
  IconBuildingCommunity,
  IconCalendar,
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
import { SidebarCount } from "../../components/SidebarCount";
import { BoardScreen } from "../board/BoardScreen";
import { CalendarScreen } from "../calendar/CalendarScreen";
import { ChatScreen } from "../chat/ChatScreen";
import { DocsScreen } from "../docs/DocsScreen";
import { OrgScreen } from "../org/OrgScreen";
import { SettingsScreen, type SettingsPart } from "../settings/SettingsScreen";
import { SignScreen } from "../sign/SignScreen";
import { SHELL_TEXT as T } from "../../i18n/shell";
import { UpdateDot } from "../../updates/UpdateDot";
import { NetworkPanel } from "./NetworkPanel";
import { NetworkProvider } from "./NetworkContext";
import { NavTooltip } from "./NavTooltip";
import { SIDEBAR_ID, SidebarToggle } from "./SidebarToggle";
import { useSidebar } from "./useSidebar";
import { useNavCounts, type NavCounts } from "./useNavCounts";
import "./shell.css";

export type Section = "chat" | "board" | "calendar" | "docs" | "sign" | "org" | "settings";

// Label dibaca dari T.nav saat render, supaya ikut bahasa aktif.
const NAV: { id: Section; icon: Icon }[] = [
  { id: "chat", icon: IconMessage },
  { id: "board", icon: IconLayoutKanban },
  { id: "calendar", icon: IconCalendar },
  { id: "docs", icon: IconFileText },
  { id: "sign", icon: IconSignature },
  { id: "org", icon: IconBuildingCommunity },
  { id: "settings", icon: IconSettings },
];

const COUNTED: readonly Section[] = ["chat", "board", "sign", "org"];

function isCounted(id: Section): id is keyof NavCounts {
  return COUNTED.includes(id);
}

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
  const counts = useNavCounts();
  const sidebar = useSidebar();

  // Perubahan direktori bisa mengubah peran laptop ini atau mengeluarkannya.
  useEffect(() => subscribe("mira://directory", onRefresh), [onRefresh]);

  return (
    <NetworkProvider onRemoved={onRefresh}>
      <div className={sidebar.collapsed ? "shell side-collapsed" : "shell"}>
        <aside id={SIDEBAR_ID} className="side">
          <p className="side-brand">
            <Logo size={24} />
            <span>Mira</span>
          </p>
          <SidebarToggle collapsed={sidebar.collapsed} onToggle={sidebar.toggle} />
          <nav aria-label={T.mainMenu}>
            <ul className="side-nav">
              {NAV.map(({ id, icon: NavIcon }) => (
                <li key={id}>
                  <button
                    type="button"
                    className="side-link"
                    data-tip-compact=""
                    aria-current={section === id ? "page" : undefined}
                    onClick={() => setSection(id)}
                  >
                    <NavIcon size={18} aria-hidden="true" />
                    <span className="side-label">{T.nav[id]}</span>
                    {isCounted(id) && <SidebarCount count={counts[id]} meaning={T.countMeaning[id](counts[id])} />}
                    {id === "settings" && <UpdateDot />}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <NetworkPanel onOpenOrg={() => setSection("org")} compact={sidebar.collapsed} />
          <div className="side-me">
            <span className="avatar" aria-hidden="true">
              {initials(name)}
            </span>
            <div className="side-me-text">
              <p className="side-me-name">{name}</p>
              <p className="side-me-org">
                {org.name}
                <span className="sr-only">{T.roleLabel}</span>
                <span aria-hidden="true"> · </span>
                {ROLE_LABELS[org.role]}
              </p>
            </div>
          </div>
        </aside>
        <NavTooltip rootId={SIDEBAR_ID} compact={sidebar.collapsed} />
        <div className="content">
          {section === "chat" && <ChatScreen />}
          {section === "board" && <BoardScreen />}
          {section === "calendar" && <CalendarScreen me={state.identity.publicKey} />}
          {section === "docs" && <DocsScreen />}
          {section === "sign" && <SignScreen />}
          {section === "org" && <OrgScreen state={state} onRefresh={onRefresh} />}
          {section === "settings" && <SettingsScreen state={state} part={settingsPart} onPart={setSettingsPart} />}
        </div>
      </div>
    </NetworkProvider>
  );
}
