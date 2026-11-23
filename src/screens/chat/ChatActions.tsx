import { IconAt, IconMessage, IconUser, IconUserMinus } from "@tabler/icons-react";
import { createContext, useContext } from "react";
import type { Person } from "../../api/chat";
import { menuItems, SEPARATOR, useContextMenu, type ContextMenuHandle } from "../../components/ContextMenu";
import { MENU } from "./menuText";

// Aksi tingkat layar Chat, disediakan ChatScreen. Dipakai menu orang di mana pun di layar chat.
export type ChatActions = {
  me: string;
  // Orang ini bisa diajak chat pribadi (ada di overview.people dan saya bukan Tamu).
  canMessage: (publicKey: string) => boolean;
  // Buka (atau buat) chat pribadi lalu pindah ke sana. Error ditampilkan ChatScreen.
  openDm: (person: Person) => Promise<void>;
  showProfile: (person: Person) => void;
};

// Aksi tingkat percakapan, disediakan panel percakapan yang sedang terbuka.
export type ConversationActions = {
  conv: string;
  // null kalau saya tidak bisa menulis di percakapan ini.
  mention: ((person: Person) => void) | null;
  // Orang ini anggota percakapan sekarang (untuk Sebut).
  isMember: (publicKey: string) => boolean;
  // Saya pemilik grup dan orang ini bisa dikeluarkan. Selalu false di luar grup.
  canRemove: (publicKey: string) => boolean;
  removeFromGroup: (person: Person) => Promise<void>;
};

// Permintaan dari menu sidebar untuk percakapan yang baru dibuka: kepala percakapan membuka
// dialognya (Ganti nama, Tambah orang) begitu data grup siap, lalu memanggil onRequestDone.
// `n` membedakan permintaan yang sama berturut-turut.
export type ConvRequest = { conv: string; action: "rename" | "add"; n: number };

export const ChatActionsContext = createContext<ChatActions | null>(null);
export const ConversationActionsContext = createContext<ConversationActions | null>(null);

export function useChatActions(): ChatActions | null {
  return useContext(ChatActionsContext);
}

export function useConversationActions(): ConversationActions | null {
  return useContext(ConversationActionsContext);
}

type PersonMenuOptions = {
  // Layar yang sudah punya dialog konfirmasi sendiri (daftar anggota grup) membukanya dari sini.
  // Tanpa ini, menu memakai dialog konfirmasinya sendiri lalu memanggil removeFromGroup.
  onRemove?: () => void;
};

// Menu untuk nama atau avatar orang: Kirim pesan pribadi, Sebut, Lihat profil, Keluarkan dari grup.
// Setiap item hanya muncul kalau aksinya memang boleh untuk saya.
export function usePersonMenu(person: Person, options: PersonMenuOptions = {}): ContextMenuHandle {
  const chat = useChatActions();
  const conv = useConversationActions();
  const me = chat?.me === person.publicKey;
  const name = person.name;

  return useContextMenu({
    label: MENU.personMenu(name),
    items: menuItems(
      !me &&
        chat?.canMessage(person.publicKey) && {
          id: "dm",
          label: MENU.sendDm,
          icon: <IconMessage size={16} />,
          onSelect: () => chat.openDm(person),
        },
      !me &&
        conv?.mention &&
        conv.isMember(person.publicKey) && {
          id: "mention",
          label: MENU.mention,
          icon: <IconAt size={16} />,
          onSelect: () => conv.mention?.(person),
        },
      chat && {
        id: "profile",
        label: MENU.profile,
        icon: <IconUser size={16} />,
        onSelect: () => chat.showProfile(person),
      },
      SEPARATOR,
      !me &&
        conv?.canRemove(person.publicKey) &&
        (options.onRemove
          ? {
              id: "remove",
              label: MENU.removeFromGroup,
              icon: <IconUserMinus size={16} />,
              danger: true,
              onSelect: options.onRemove,
            }
          : {
              id: "remove",
              label: MENU.removeFromGroup,
              icon: <IconUserMinus size={16} />,
              danger: true,
              confirm: {
                title: MENU.removeTitle(name),
                body: <p>{MENU.removeBody(name)}</p>,
                confirmLabel: MENU.removeConfirm,
                busyLabel: MENU.removeBusy,
              },
              onSelect: () => conv.removeFromGroup(person),
            }),
    ),
  });
}
