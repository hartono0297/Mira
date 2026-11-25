import {
  IconArchive,
  IconArchiveOff,
  IconBell,
  IconBellOff,
  IconChecks,
  IconDoorExit,
  IconLock,
  IconLockOpen,
  IconMessage,
  IconPencil,
  IconTrash,
  IconUserPlus,
} from "@tabler/icons-react";
import { toAppError, type AppError } from "../../api";
import { chatApi, type ConversationSummary } from "../../api/chat";
import { menuItems, SEPARATOR, useContextMenu, type ContextMenuHandle, type MenuEntry } from "../../components/ContextMenu";
import { CHAT } from "../../i18n/chat";
import { isDivisionChat } from "./divisionOrder";
import { MENU } from "./menuText";
import { conversationTitle } from "./text";

// Aksi langsung (tanpa konfirmasi). Kalau gagal, errornya ditampilkan pemanggil:
// di bawah kepala percakapan, atau di atas daftar percakapan.
export type DirectAction = "markRead" | "mute" | "archive" | "lock";

// Objek kamus hidup: ACTION_ERRORS[action] selalu dalam bahasa aktif.
export const ACTION_ERRORS: Readonly<Record<DirectAction, string>> = CHAT.actionErrors;

export type ActionError = { action: DirectAction; title: string; error: AppError };

export type ConversationMenuHandlers = {
  // Hanya di sidebar. Kepala percakapan tidak menawarkan Buka dan Tandai sudah dibaca.
  open?: () => void;
  markRead?: () => Promise<void>;
  toggleMute: () => Promise<void>;
  rename: () => void;
  addPeople: () => void;
  // Item dengan konfirmasi: error dari Promise tampil di dialog konfirmasinya.
  leave: () => Promise<void>;
  toggleLock: () => Promise<void>;
  toggleArchive: () => Promise<void>;
  deleteChannel: () => Promise<void>;
};

// Isi menu satu percakapan, dipakai menu baris di sidebar dan menu "..." di kepala percakapan.
// Hak diambil dari ringkasan: grup (selain yang sudah bukan anggota) boleh ganti nama, tambah
// orang, dan keluar; channel mengikuti canLock, canArchive, canDelete. Chat proyek tidak bisa
// diarsipkan atau dihapus, kecuali arsip lama dari v0.3 yang masih bisa dikembalikan.
// Pesan pribadi hanya punya Bisukan karena belum ada perintah untuk menghapusnya dari daftar.
export function conversationMenuItems(s: ConversationSummary, h: ConversationMenuHandlers): MenuEntry[] {
  const title = conversationTitle(s);
  // Chat divisi seperti chat proyek: tanpa ganti nama, tambah orang, keluar, arsip, atau hapus.
  const group = s.kind === "group" && !s.former && !isDivisionChat(s);
  const channel = s.kind === "channel" && !isDivisionChat(s);
  const unread = s.unread > 0 || s.mentionUnread > 0;
  const archive = (channel && s.canArchive) || (s.kind === "project" && s.archived && s.canArchive);
  const open = h.open;
  const markRead = h.markRead;

  return menuItems(
    open && { id: "open", label: MENU.open, icon: <IconMessage size={16} />, onSelect: open },
    markRead && unread && { id: "mark-read", label: MENU.markRead, icon: <IconChecks size={16} />, onSelect: markRead },
    SEPARATOR,
    s.muted
      ? { id: "mute", label: MENU.unmute, icon: <IconBell size={16} />, onSelect: h.toggleMute }
      : { id: "mute", label: MENU.mute, icon: <IconBellOff size={16} />, onSelect: h.toggleMute },
    SEPARATOR,
    group && { id: "rename", label: MENU.renameGroup, icon: <IconPencil size={16} />, onSelect: h.rename },
    group && { id: "add", label: MENU.addPeople, icon: <IconUserPlus size={16} />, onSelect: h.addPeople },
    channel &&
      s.canLock &&
      (s.locked
        ? { id: "lock", label: MENU.unlock, icon: <IconLockOpen size={16} />, onSelect: h.toggleLock }
        : { id: "lock", label: MENU.lock, icon: <IconLock size={16} />, onSelect: h.toggleLock }),
    // Tanpa konfirmasi: arsip bisa dikembalikan kapan saja dari menu yang sama.
    archive &&
      (s.archived
        ? { id: "archive", label: MENU.unarchive, icon: <IconArchiveOff size={16} />, onSelect: h.toggleArchive }
        : { id: "archive", label: MENU.archive, icon: <IconArchive size={16} />, onSelect: h.toggleArchive }),
    SEPARATOR,
    group && {
      id: "leave",
      label: MENU.leaveGroup,
      icon: <IconDoorExit size={16} />,
      danger: true,
      confirm: {
        title: MENU.leaveTitle(title),
        body: (
          <>
            <p>{MENU.leaveBody}</p>
            <p>{MENU.leaveOwnerMaybe}</p>
          </>
        ),
        confirmLabel: MENU.leaveConfirm,
        busyLabel: MENU.leaveBusy,
      },
      onSelect: h.leave,
    },
    channel &&
      s.canDelete &&
      !s.isUmum && {
        id: "delete",
        label: MENU.deleteChannel,
        icon: <IconTrash size={16} />,
        danger: true,
        confirm: {
          title: MENU.deleteChannelTitle(title),
          body: <p>{MENU.deleteChannelBody(title)}</p>,
          confirmLabel: MENU.deleteChannelConfirm,
          busyLabel: MENU.deleteChannelBusy,
        },
        onSelect: h.deleteChannel,
      },
  );
}

type Options = {
  summary: ConversationSummary;
  // Sidebar: pilih percakapan ini. Tanpa ini (kepala percakapan) tidak ada Buka dan Tandai sudah dibaca.
  onOpen?: () => void;
  // Muat ulang daftar setelah aksi berhasil.
  onChanged: () => void;
  // Percakapan ini sudah tidak bisa dibuka (channel dihapus, keluar dari grup).
  onGone: () => void;
  onRename: () => void;
  onAdd: () => void;
  // null saat aksi baru dimulai, supaya error lama hilang.
  onError: (error: ActionError | null) => void;
};

// Menu klik kanan dan tombol "..." untuk satu percakapan, lengkap dengan pemanggilan perintahnya.
export function useConversationMenu({ summary: s, onOpen, onChanged, onGone, onRename, onAdd, onError }: Options): ContextMenuHandle {
  const title = conversationTitle(s);

  const run = (action: DirectAction, work: () => Promise<unknown>) => async () => {
    onError(null);
    try {
      await work();
      onChanged();
    } catch (err) {
      onError({ action, title, error: toAppError(err) });
    }
  };

  return useContextMenu({
    label: MENU.convMenu(title),
    items: conversationMenuItems(s, {
      open: onOpen,
      markRead: onOpen ? run("markRead", () => chatApi.markRead(s.id)) : undefined,
      toggleMute: run("mute", () => chatApi.setMuted(s.id, !s.muted)),
      rename: onRename,
      addPeople: onAdd,
      leave: async () => {
        await chatApi.groupLeave(s.id);
        onChanged();
        onGone();
      },
      toggleLock: run("lock", () => chatApi.setLocked(s.id, !s.locked)),
      toggleArchive: run("archive", () => chatApi.setArchived(s.id, !s.archived)),
      deleteChannel: async () => {
        await chatApi.deleteChannel(s.id);
        onChanged();
        onGone();
      },
    }),
  });
}
