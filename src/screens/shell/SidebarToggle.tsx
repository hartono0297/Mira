import { IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand } from "@tabler/icons-react";
import { SHELL_TEXT as T } from "../../i18n/shell";
import { isMac } from "../../platform";
import { sidebarKeys } from "./useSidebar";

export const SIDEBAR_ID = "main-sidebar";

// Tombol di bawah logo yang meringkas atau melebarkan sidebar. Pintasannya
// (Ctrl+B, Cmd+B di macOS) tampil di tooltip dan diumumkan lewat aria-keyshortcuts.
export function SidebarToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const label = collapsed ? T.sidebar.expand : T.sidebar.collapse;
  const Icon = collapsed ? IconLayoutSidebarLeftExpand : IconLayoutSidebarLeftCollapse;
  return (
    <button
      type="button"
      className="side-toggle"
      aria-label={label}
      aria-expanded={!collapsed}
      aria-controls={SIDEBAR_ID}
      aria-keyshortcuts={isMac() ? "Meta+B" : "Control+B"}
      data-tip={T.sidebar.withKeys(label, sidebarKeys())}
      onClick={onToggle}
    >
      <Icon size={20} aria-hidden="true" />
    </button>
  );
}
