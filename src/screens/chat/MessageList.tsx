import { useMemo } from "react";
import type { ConversationEvent, ConversationSummary, MessageView } from "../../api/chat";
import { MessageItem } from "./MessageItem";
import { officeEmoteMap, useStickerCatalog } from "./stickerCatalog";
import { dayKey, dayLabel, formatTime, fullTime, GROUP_GAP_MS, type ListItem } from "./text";

export type TimelineItem = ListItem | { kind: "event"; event: ConversationEvent };

function time(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

// Pesan dan kejadian grup diurutkan menurut waktu, dengan pemisah hari. Kejadian pada
// waktu yang sama dengan pesan tampil lebih dulu (grup dibuat sebelum pesan pertama).
// Kejadian memutus penggabungan pesan berurutan dari orang yang sama.
export function buildTimeline(
  messages: MessageView[],
  events: ConversationEvent[],
  now: Date = new Date(),
): TimelineItem[] {
  const evs = [...events].sort((a, b) => time(a.at) - time(b.at) || a.id.localeCompare(b.id));
  const out: TimelineItem[] = [];
  let day: string | null = null;
  let prevMessage: MessageView | null = null;
  let i = 0;
  let j = 0;
  while (i < messages.length || j < evs.length) {
    const takeEvent = j < evs.length && (i >= messages.length || time(evs[j].at) <= time(messages[i].at));
    const at = takeEvent ? evs[j].at : messages[i].at;
    const key = dayKey(at);
    const newDay = key !== day;
    if (newDay) {
      out.push({ kind: "day", key, label: dayLabel(at, now) });
      day = key;
    }
    if (takeEvent) {
      out.push({ kind: "event", event: evs[j++] });
      prevMessage = null;
      continue;
    }
    const m = messages[i++];
    const gap = prevMessage ? time(m.at) - time(prevMessage.at) : Infinity;
    const grouped =
      !newDay && prevMessage !== null && prevMessage.author.publicKey === m.author.publicKey && gap >= 0 && gap < GROUP_GAP_MS;
    out.push({ kind: "message", message: m, grouped });
    prevMessage = m;
  }
  return out;
}

// Gabungkan kejadian dari halaman lama dan terbaru tanpa dobel (id sama: versi terbaru).
export function mergeEvents(older: ConversationEvent[], latest: ConversationEvent[]): ConversationEvent[] {
  const ids = new Set(latest.map((e) => e.id));
  return [...older.filter((e) => !ids.has(e.id)), ...latest];
}

const NO_RECENT: string[] = [];

type Props = {
  items: TimelineItem[];
  me: string;
  kind: ConversationSummary["kind"];
  flashId: string | null;
  loadedIds: Set<string>;
  canReply: boolean;
  canReact: boolean;
  onReact: (message: MessageView, emoji: string, on: boolean) => void;
  onSaveSticker: (message: MessageView) => void;
  onReply: (message: MessageView) => void;
  onDelete: (message: MessageView) => void;
  onJump: (messageId: string) => void;
  onReload: () => void;
  onAnnounce: (text: string, error?: boolean) => void;
};

// Daftar pesan dengan pemisah hari dan baris kejadian grup. Pengguliran diatur Conversation.
export function MessageList({
  items,
  me,
  kind,
  flashId,
  loadedIds,
  canReply,
  canReact,
  onReact,
  onSaveSticker,
  onReply,
  onDelete,
  onJump,
  onReload,
  onAnnounce,
}: Props) {
  // Satu katalog untuk semua pesan: emote sebaris, chip emote, dan isi pemilih emoji.
  const { catalog } = useStickerCatalog();
  const emotes = useMemo(() => officeEmoteMap(catalog), [catalog]);
  const recent = catalog?.recentEmoji ?? NO_RECENT;
  return (
    <ol className="conv-list">
      {items.map((item) => {
        if (item.kind === "day") {
          return (
            <li key={`day-${item.key}`} className="conv-day">
              <h3 className="conv-day-label">{item.label}</h3>
            </li>
          );
        }
        if (item.kind === "event") {
          const { event } = item;
          return (
            <li key={`ev-${event.id}`} className="conv-event">
              <p>
                {event.text}
                <span aria-hidden="true"> · </span>
                <time className="conv-event-time" dateTime={event.at} title={fullTime(event.at)}>
                  {formatTime(event.at)}
                </time>
              </p>
            </li>
          );
        }
        return (
          <MessageItem
            key={item.message.id}
            message={item.message}
            grouped={item.grouped}
            me={me}
            kind={kind}
            flash={flashId === item.message.id}
            canReply={canReply}
            canReact={canReact}
            emotes={emotes}
            recent={recent}
            onReact={onReact}
            onSaveSticker={onSaveSticker}
            replyLoaded={!!item.message.replyTo && loadedIds.has(item.message.replyTo.id)}
            onReply={onReply}
            onDelete={onDelete}
            onJump={onJump}
            onReload={onReload}
            onAnnounce={onAnnounce}
          />
        );
      })}
    </ol>
  );
}
