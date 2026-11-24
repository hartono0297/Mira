import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationSummary } from "../../api/chat";
import { divisionApi, type ConversationSettings } from "../../api/division";
import { subscribeOrg } from "../../api/org";
import { isDivisionChat } from "./divisionOrder";

// Catatan disematkan dan mode pengumuman hanya ada di channel departemen dan chat divisi.
// Channel departemen lain mendapat null dari inti.
export function hasChatSettings(c: ConversationSummary): boolean {
  return isDivisionChat(c) || (c.kind === "channel" && c.scope?.kind === "team");
}

// Banner dan pengganti kolom pesan dipasang bersamaan: satu permintaan per percakapan.
const inflight = new Map<string, Promise<ConversationSettings | null>>();
const listeners = new Set<(conv: string) => void>();

function fetchSettings(conv: string): Promise<ConversationSettings | null> {
  const running = inflight.get(conv);
  if (running) return running;
  const next: Promise<ConversationSettings | null> = divisionApi
    .conversationSettings(conv)
    .then((s) => s ?? null)
    .finally(() => {
      if (inflight.get(conv) === next) inflight.delete(conv);
    });
  inflight.set(conv, next);
  return next;
}

// Pengaturan baru saja disimpan dari laptop ini: semua pemakai percakapan itu memuat ulang.
export function settingsChanged(conv: string): void {
  inflight.delete(conv);
  for (const fn of [...listeners]) fn(conv);
}

export type SettingsState = {
  settings: ConversationSettings | null;
  reload: () => void;
};

// Pengaturan chat satu percakapan, dimuat ulang saat data organisasi berubah (mira://directory).
// Gagal memuat tidak ditampilkan: nilai terakhir yang berhasil tetap dipakai, dan tanpa nilai
// percakapan tampil seperti biasa (kolom pesan tetap ada, inti tetap menolak pesan yang tidak boleh).
export function useConversationSettings(summary: ConversationSummary): SettingsState {
  const conv = hasChatSettings(summary) ? summary.id : null;
  const [settings, setSettings] = useState<ConversationSettings | null>(null);
  const current = useRef(conv);
  current.current = conv;

  const reload = useCallback(() => {
    if (!conv) return;
    fetchSettings(conv).then(
      (s) => {
        if (current.current === conv) setSettings(s);
      },
      () => {},
    );
  }, [conv]);

  useEffect(() => {
    setSettings(null);
    if (!conv) return;
    reload();
    const onChanged = (changed: string) => {
      if (changed === conv) reload();
    };
    listeners.add(onChanged);
    const stop = subscribeOrg(reload);
    return () => {
      listeners.delete(onChanged);
      stop();
    };
  }, [conv, reload]);

  return { settings, reload };
}
