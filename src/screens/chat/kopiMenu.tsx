// Item "Beri kopi" di menu klik kanan pesan rekan, beserta dialognya.
// MessageItem cukup memasang item dan elemen dari useKopiMessage.
import { IconCoffee } from "@tabler/icons-react";
import { useState, type ReactNode } from "react";
import type { MessageView } from "../../api/chat";
import { kopiTargetKey, type KopiOverview, type KopiTarget } from "../../api/kopi";
import type { MenuAction } from "../../components/ContextMenu";
import { KopiGiveDialog } from "../../components/KopiGiveDialog";
import { useKopi } from "../../components/useKopi";
import { KOPI_ENTRY } from "../../i18n/kopi-entry";

// Panjang cuplikan pesan yang tampil di dialog, supaya pemberi ingat pesan mana.
export const SNIPPET_MAX = 80;

export type KopiMessageState = { show: false } | { show: true; disabled: string | null };

// Tidak tampil: fitur mati atau belum termuat, Tamu, pesan sendiri, pesan terhapus.
// Nonaktif dengan alasan: pesan ini sudah saya beri kopi, atau jatah hari ini habis.
export function kopiMessageState(overview: KopiOverview | null, message: MessageView): KopiMessageState {
  if (!overview || !overview.enabled || !overview.canGive) return { show: false };
  if (message.mine || message.deleted || message.author.publicKey === overview.me) return { show: false };
  const key = kopiTargetKey(message.author.publicKey, messageTarget(message));
  if (overview.givenTargets.includes(key)) return { show: true, disabled: KOPI_ENTRY.givenMessage };
  if (overview.givenToday >= overview.dailyLimit) return { show: true, disabled: KOPI_ENTRY.limitShort };
  return { show: true, disabled: null };
}

export function messageTarget(message: MessageView): KopiTarget {
  return { kind: "message", id: message.id };
}

// Teks pesan dipendekkan ke satu baris. Pesan tanpa teks memakai nama lampiran.
export function messageSnippet(message: MessageView): string {
  const text = message.text.trim() ? message.text : message.files.map((f) => f.name).join(", ");
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > SNIPPET_MAX ? `${line.slice(0, SNIPPET_MAX - 3).trimEnd()}...` : line;
}

// Item menu dan dialognya. `item` null kalau tidak tampil.
export function useKopiMessage(message: MessageView): { item: MenuAction | null; element: ReactNode } {
  const kopi = useKopi();
  const [open, setOpen] = useState(false);
  const state = kopiMessageState(kopi.overview, message);
  const item: MenuAction | null = state.show
    ? {
        id: "kopi",
        label: KOPI_ENTRY.give,
        icon: <IconCoffee size={16} />,
        disabled: state.disabled ?? undefined,
        onSelect: () => setOpen(true),
      }
    : null;
  // Dialog hanya dipasang saat dibuka, supaya daftar pesan yang panjang tidak memuat satu dialog per pesan.
  const element = open ? (
    <KopiGiveDialog
      open
      onClose={() => setOpen(false)}
      to={message.author}
      target={messageTarget(message)}
      context={messageSnippet(message)}
      onGiven={() => void kopi.reload()}
    />
  ) : null;
  return { item, element };
}
