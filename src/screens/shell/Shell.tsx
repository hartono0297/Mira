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
import { useEffect, useId, useState } from "react";
import { ROLE_LABELS, subscribe, type AppError, type AppState, type OrgInfo } from "../../api";
import { profileClearPhoto } from "../../api/profile";
import { Avatar } from "../../components/Avatar";
import { menuItems, SEPARATOR, useContextMenu } from "../../components/ContextMenu";
import { ErrorAlert } from "../../components/ErrorAlert";
import { Logo } from "../../components/Logo";
import { refreshProfilePhotos, usePhotoHash } from "../../components/profilePhotos";
import { useChangePhoto } from "../../components/profile/useChangePhoto";
import { SidebarCount } from "../../components/SidebarCount";
import { BoardScreen } from "../board/BoardScreen";
import { CalendarScreen } from "../calendar/CalendarScreen";
import { ChatScreen } from "../chat/ChatScreen";
import { DocsScreen } from "../docs/DocsScreen";
import { OrgScreen } from "../org/OrgScreen";
import { SettingsScreen, type SettingsPart } from "../settings/SettingsScreen";
import { SignScreen } from "../sign/SignScreen";
import { PROFILE_TEXT } from "../../i18n/profile";
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
  // Pengaturan tetap terbuka di Tampilan. Profil dibuka lewat menu profil atau
  // menu Pengaturan; skrip e2e lama memilih tema langsung setelah membuka Pengaturan.
  const [settingsPart, setSettingsPart] = useState<SettingsPart>("appearance");
  const counts = useNavCounts();
  const sidebar = useSidebar(section);

  function openProfile() {
    setSettingsPart("profile");
    setSection("settings");
  }

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
          <ProfileMenu state={state} onOpenProfile={openProfile} />
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

// Blok "saya" di bawah sidebar: tombol yang membuka menu foto profil.
function ProfileMenu({ state, onOpenProfile }: { state: AppState & { organization: OrgInfo }; onOpenProfile: () => void }) {
  const P = PROFILE_TEXT.menu;
  const me = state.identity.publicKey;
  const name = state.identity.displayName ?? "";
  const org = state.organization;
  // Dari peta pemilik, bukan data foto: foto yang gagal dimuat tetap bisa dihapus.
  const hasPhoto = usePhotoHash(me) !== null;
  const textId = useId();
  const change = useChangePhoto();
  // Error pilih foto bisa ditutup; error berikutnya tampil lagi.
  const [dismissed, setDismissed] = useState<AppError | null>(null);

  const menu = useContextMenu({
    label: P.label,
    items: menuItems(
      { id: "change-photo", label: P.change, onSelect: () => change.start() },
      hasPhoto && {
        id: "remove-photo",
        label: P.remove,
        danger: true,
        onSelect: async () => {
          await profileClearPhoto();
          await refreshProfilePhotos();
        },
        confirm: {
          title: PROFILE_TEXT.confirmRemove.title,
          body: PROFILE_TEXT.confirmRemove.body,
          confirmLabel: P.remove,
          busyLabel: PROFILE_TEXT.confirmRemove.busy,
        },
      },
      SEPARATOR,
      { id: "open-profile", label: P.open, onSelect: onOpenProfile },
    ),
  });

  const error = change.error && change.error !== dismissed ? change.error : null;

  return (
    <div className="side-me-area">
      <div className="side-me-live" aria-live="polite">
        {error && (
          <ErrorAlert title={PROFILE_TEXT.section.changeFailed}>
            <p>{error.message}</p>
            <button type="button" className="link-btn side-me-dismiss" onClick={() => setDismissed(error)}>
              {P.dismiss}
            </button>
          </ErrorAlert>
        )}
      </div>
      <button
        type="button"
        className="side-me"
        aria-label={P.label}
        aria-describedby={textId}
        aria-haspopup="menu"
        aria-expanded={menu.isOpen}
        aria-controls={menu.isOpen ? menu.menuId : undefined}
        aria-busy={change.busy || undefined}
        onClick={(e) => {
          if (menu.isOpen) menu.close();
          else menu.openAt(e.currentTarget, "start");
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!menu.isOpen) menu.openAt(e.currentTarget, "start", e.key === "ArrowUp");
          }
        }}
      >
        <Avatar name={name} publicKey={me} className="avatar" />
        <span className="side-me-text" id={textId}>
          <span className="side-me-name">{name}</span>
          <span className="sr-only">, </span>
          <span className="side-me-org">
            {org.name}
            <span className="sr-only">{T.roleLabel}</span>
            <span aria-hidden="true"> · </span>
            {ROLE_LABELS[org.role]}
          </span>
        </span>
      </button>
      {menu.element}
      {change.element}
    </div>
  );
}
