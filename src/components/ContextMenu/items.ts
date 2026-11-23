import type { ReactNode } from "react";

// Satu baris di menu klik kanan atau menu tombol "...".
export type MenuAction = {
  id: string;
  label: string;
  // Boleh mengembalikan Promise. Untuk item dengan `confirm`, dialog
  // konfirmasi menunggu Promise itu selesai dan menampilkan error-nya.
  onSelect: () => void | Promise<unknown>;
  icon?: ReactNode;
  // Pintasan yang tampil di kanan item, misalnya "Ctrl+C". Hanya tampilan:
  // pintasannya sendiri dipasang oleh layar pemilik aksi.
  shortcut?: string;
  // Teks merah. Pakai untuk aksi yang menghapus, mengeluarkan, atau membatalkan.
  danger?: boolean;
  // true atau alasan. Item tetap bisa difokus supaya alasannya terbaca,
  // tetapi tidak bisa dijalankan.
  disabled?: boolean | string;
  // Minta konfirmasi dulu lewat ConfirmDialog. Layar yang sudah punya dialog
  // konfirmasi sendiri cukup memanggilnya dari onSelect.
  confirm?: MenuConfirm;
};

export type MenuConfirm = {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  busyLabel: string;
};

export type MenuSeparator = { separator: true };

export type MenuEntry = MenuAction | MenuSeparator;

export function isSeparator(entry: MenuEntry): entry is MenuSeparator {
  return "separator" in entry;
}

export function isDisabled(item: MenuAction): boolean {
  return item.disabled === true || (typeof item.disabled === "string" && item.disabled.length > 0);
}

export function disabledReason(item: MenuAction): string | null {
  return typeof item.disabled === "string" && item.disabled.length > 0 ? item.disabled : null;
}

export const SEPARATOR: MenuSeparator = { separator: true };

// Susun daftar item dari bagian bersyarat: nilai false, null, dan undefined
// dibuang, lalu pemisah di awal, di akhir, atau yang berurutan dirapikan.
//   menuItems(open, canEdit && edit, SEPARATOR, isOwner && remove)
export function menuItems(...entries: (MenuEntry | false | null | undefined)[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const e of entries) {
    if (!e) continue;
    if (isSeparator(e) && (out.length === 0 || isSeparator(out[out.length - 1]))) continue;
    out.push(e);
  }
  while (out.length > 0 && isSeparator(out[out.length - 1])) out.pop();
  return out;
}

// Tampilan pintasan: "Ctrl+C" di Windows, "⌘C" di macOS.
export function shortcutText(keys: string, mac: boolean): string {
  if (!mac) return keys;
  return keys
    .replace(/Ctrl\+/g, "⌘")
    .replace(/Shift\+/g, "⇧")
    .replace(/Alt\+/g, "⌥");
}
