import { IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand } from "@tabler/icons-react";
import { SHELL_TEXT as T } from "../../i18n/shell";
import { isMac } from "../../platform";
import { SIDEBAR_ID, sidebarKeys } from "./useSidebar";

export { SIDEBAR_ID };

// Tombol di bawah logo yang meringkas atau melebarkan sidebar. Pintasannya
// (Ctrl+B, Cmd+B di macOS) tampil di tooltip dan diumumkan lewat aria-keyshortcuts.
//
// Keadaan disampaikan lewat nama yang berganti ("Ringkas menu" / "Lebarkan
// menu"), tanpa aria-expanded. Dua-duanya membuat pembaca layar menyebut
// "Lebarkan menu, diciutkan", dan "diciutkan" juga keliru: sidebar ringkas
// tetap ada dan tetap bisa dipakai, hanya lebih sempit. Nama yang berganti
// sama dengan tooltip yang dilihat pengguna, jadi yang dipertahankan nama itu.
export function SidebarToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const label = collapsed ? T.sidebar.expand : T.sidebar.collapse;
  const Icon = collapsed ? IconLayoutSidebarLeftExpand : IconLayoutSidebarLeftCollapse;
  return (
    <button
      type="button"
      className="side-toggle"
      aria-label={label}
      aria-controls={SIDEBAR_ID}
      aria-keyshortcuts={isMac() ? "Meta+B" : "Control+B"}
      data-tip={T.sidebar.withKeys(label, sidebarKeys())}
      onClick={onToggle}
    >
      <Icon size={20} aria-hidden="true" />
    </button>
  );
}
