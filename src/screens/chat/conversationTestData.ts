// Data uji panel percakapan. Nama dan kunci jelas buatan, hanya untuk tes.
import type { ConversationSummary, ConversationView, FileView, MessageView, Person } from "../../api/chat";

export const ME = "a".repeat(64);
export const PK_B = "b".repeat(64);
export const PK_C = "c".repeat(64);
export const CH = `ch:${"1".repeat(32)}`;
export const DM = `dm:${ME}:${PK_B}`;

export const penguji: Person = { publicKey: ME, name: "Penguji" };
export const sari: Person = { publicKey: PK_B, name: "Sari Uji" };
export const budi: Person = { publicKey: PK_C, name: "Budi Uji" };

// Waktu lokal hari ini, supaya label hari tidak bergantung zona waktu mesin uji.
export function today(hour: number, minute: number): string {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

export function channel(extra: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: CH,
    kind: "channel",
    name: "proyek-a",
    scope: { kind: "project", id: "2".repeat(32), name: "Gedung A" },
    peer: null,
    isUmum: false,
    archived: false,
    muted: false,
    unread: 0,
    mentionUnread: 0,
    lastAt: null,
    lastPreview: null,
    canPost: true,
    canArchive: true,
    canDelete: true,
    ...extra,
  };
}

export function dm(extra: Partial<ConversationSummary> = {}): ConversationSummary {
  return channel({
    id: DM,
    kind: "dm",
    name: "Sari Uji",
    scope: null,
    peer: sari,
    canArchive: false,
    canDelete: false,
    ...extra,
  });
}

export function file(extra: Partial<FileView> = {}): FileView {
  return {
    hash: "f".repeat(64),
    name: "kontrak-draft.pdf",
    size: 1258291,
    mime: "application/pdf",
    state: "local",
    autoDownload: true,
    ...extra,
  };
}

export function message(extra: Partial<MessageView> = {}): MessageView {
  return {
    id: "m1",
    conv: CH,
    author: sari,
    at: today(9, 12),
    text: "Halo semua",
    mentions: [],
    replyTo: null,
    files: [],
    deleted: false,
    mine: false,
    status: null,
    canDelete: false,
    ...extra,
  };
}

export function view(messages: MessageView[], extra: Partial<ConversationView> = {}): ConversationView {
  return {
    conversation: channel(),
    members: [penguji, sari, budi],
    messages,
    hasMore: false,
    ...extra,
  };
}
