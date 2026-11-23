import { CHAT_SECTIONS, type ChatOverview, type ChatSection, type ConversationSummary, type ScopeKind } from "../../api/chat";

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

const SCOPE_PREFIX: Record<ScopeKind, string> = { org: "", team: "Departemen", project: "Proyek", group: "Grup" };

// "Departemen Desain", "Proyek Alfa". Nama yang sudah diawali kata itu tidak diberi awalan lagi.
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

// Bagian sebuah percakapan. Nilai yang tidak dikenal (inti lebih baru atau lebih lama) ditebak
// dari jenis dan cakupannya, supaya tidak ada percakapan yang hilang dari daftar.
export function sectionOf(c: ConversationSummary): ChatSection {
  if (CHAT_SECTIONS.includes(c.section)) return c.section;
  if (c.kind === "dm") return "pribadi";
  if (c.kind === "group") return "grup";
  if (c.scope?.kind === "team") return "departemen";
  if (c.scope?.kind === "project") return "proyek";
  return "umum";
}

export const SECTION_TITLES: Record<ChatSection, string> = {
  umum: "Umum",
  departemen: "Departemen",
  proyek: "Proyek",
  grup: "Grup",
  pribadi: "Pesan pribadi",
};

// Percakapan per bagian, urutan bagian tetap (CHAT_SECTIONS). Di dalam bagian urutan dari inti
// dipertahankan: yang diarsipkan atau bukan anggota lagi sudah ada di akhir.
export function groupConversations(list: ConversationSummary[]): Record<ChatSection, ConversationSummary[]> {
  const groups = Object.fromEntries(CHAT_SECTIONS.map((s) => [s, [] as ConversationSummary[]])) as Record<
    ChatSection,
    ConversationSummary[]
  >;
  for (const c of list) groups[sectionOf(c)].push(c);
  return groups;
}

// Jumlah belum dibaca satu bagian, untuk judul bagian yang dilipat.
export function sectionUnread(rows: ConversationSummary[]): { unread: number; mentions: number; loud: boolean } {
  let unread = 0;
  let mentions = 0;
  let loud = false;
  for (const c of rows) {
    const n = Math.max(c.unread, c.mentionUnread);
    unread += n;
    mentions += c.mentionUnread;
    if (n > 0 && !c.muted) loud = true;
  }
  return { unread, mentions, loud };
}

// Bagian yang dilipat, diingat per laptop. Penyimpanan browser bisa tidak tersedia (mode
// privat, data situs diblokir): lipatan lalu hanya diingat selama layar terbuka.
export const CHAT_FOLDED_KEY = "mira.chat.folded";

export function readFolded(): ChatSection[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(CHAT_FOLDED_KEY) ?? "[]");
    return Array.isArray(parsed) ? CHAT_SECTIONS.filter((s) => parsed.includes(s)) : [];
  } catch {
    return [];
  }
}

export function writeFolded(folded: ChatSection[]) {
  try {
    window.localStorage.setItem(CHAT_FOLDED_KEY, JSON.stringify(folded));
  } catch {
    // Lihat readFolded.
  }
}

const active = (c: ConversationSummary) => !c.archived && !c.former;

// Percakapan yang dibuka pertama: #umum, lalu yang pertama (urut bagian) yang masih aktif,
// lalu yang pertama belum diarsipkan, lalu yang pertama.
export function defaultConversation(list: ConversationSummary[]): ConversationSummary | null {
  const groups = groupConversations(list);
  const ordered = CHAT_SECTIONS.flatMap((s) => groups[s]);
  return (
    ordered.find((c) => c.isUmum && active(c)) ??
    ordered.find(active) ??
    ordered.find((c) => !c.archived) ??
    ordered[0] ??
    null
  );
}

// Hasil aksi (channel baru, chat pribadi dibuka) dimasukkan ke ringkasan sebelum muat ulang
// selesai, supaya pilihannya langsung tampil.
export function withConversation(overview: ChatOverview, summary: ConversationSummary): ChatOverview {
  return {
    ...overview,
    conversations: [summary, ...overview.conversations.filter((c) => c.id !== summary.id)],
  };
}
