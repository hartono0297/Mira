import type { ChatOverview, ConversationSummary, ScopeKind } from "../../api/chat";

export const MAX_CHANNEL_NAME = 40;

// Sama dengan `normalize_channel_name` di src-tauri/src/chat/model.rs: huruf kecil,
// spasi, garis bawah, dan tanda hubung jadi satu "-", "#" di depan dibuang, karakter
// lain dihapus, maksimal 40 karakter. String kosong kalau tidak ada yang tersisa.
export function normalizeChannelName(input: string): string {
  let out = "";
  for (const raw of input.trim().replace(/^#+/, "")) {
    const c = /^[A-Z]$/.test(raw) ? raw.toLowerCase() : raw;
    if (/^[a-z0-9]$/.test(c)) out += c;
    else if ((c === " " || c === "-" || c === "_") && out !== "" && !out.endsWith("-")) out += "-";
  }
  return out
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_CHANNEL_NAME)
    .replace(/-+$/, "");
}

const SCOPE_PREFIX: Record<ScopeKind, string> = { org: "", team: "Tim", project: "Proyek" };

// "Tim Desain", "Proyek Alfa". Nama yang sudah diawali kata itu tidak diberi awalan lagi.
export function scopeLabel(kind: ScopeKind, name: string): string {
  if (kind === "org") return "Seluruh kantor";
  const prefix = SCOPE_PREFIX[kind];
  return name.toLowerCase().startsWith(`${prefix.toLowerCase()} `) ? name : `${prefix} ${name}`;
}

// Kalimat untuk pembaca layar: "3 pesan belum dibaca, 1 menyebut Anda".
export function unreadText(unread: number, mentions: number): string {
  if (unread <= 0 && mentions <= 0) return "";
  const parts = [`${Math.max(unread, mentions)} pesan belum dibaca`];
  if (mentions > 0) parts.push(`${mentions} menyebut Anda`);
  return parts.join(", ");
}

export function badgeCount(n: number): string {
  return n > 99 ? "99+" : String(n);
}

// Percakapan yang dibuka pertama: #umum, lalu yang pertama belum diarsipkan, lalu yang pertama.
export function defaultConversation(list: ConversationSummary[]): ConversationSummary | null {
  return list.find((c) => c.isUmum && !c.archived) ?? list.find((c) => !c.archived) ?? list[0] ?? null;
}

export type ListGroups = {
  channels: ConversationSummary[];
  directs: ConversationSummary[];
  archived: ConversationSummary[];
};

export function groupConversations(overview: ChatOverview): ListGroups {
  const groups: ListGroups = { channels: [], directs: [], archived: [] };
  for (const c of overview.conversations) {
    if (c.archived) groups.archived.push(c);
    else if (c.kind === "channel") groups.channels.push(c);
    else groups.directs.push(c);
  }
  return groups;
}

// Hasil aksi (channel baru, chat pribadi dibuka) dimasukkan ke ringkasan sebelum muat ulang
// selesai, supaya pilihannya langsung tampil.
export function withConversation(overview: ChatOverview, summary: ConversationSummary): ChatOverview {
  return {
    ...overview,
    conversations: [summary, ...overview.conversations.filter((c) => c.id !== summary.id)],
  };
}
