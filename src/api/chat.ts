// Kontrak chat dengan inti Rust (docs/plans/tahap-2.md, bagian 10).
// Sumber kebenaran bentuk data: Rust `chat/view.rs` mengikuti file ini.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri, NO_TAURI_ERROR, toAppError } from ".";

export type Person = { publicKey: string; name: string };

export type ScopeKind = "org" | "team" | "project";

// Cakupan channel. `id` null untuk org (#umum dan channel seluruh kantor).
export type ChannelScope = { kind: ScopeKind; id: string | null; name: string };

export type ConversationSummary = {
  id: string; // "ch:<32 hex>" atau "dm:<kunci>:<kunci>"
  kind: "channel" | "dm";
  name: string; // nama channel tanpa "#", atau nama rekan untuk chat pribadi
  scope: ChannelScope | null; // null untuk chat pribadi
  peer: Person | null; // rekan di chat pribadi
  isUmum: boolean;
  archived: boolean;
  muted: boolean;
  unread: number;
  mentionUnread: number; // pesan belum dibaca yang menyebut saya
  lastAt: string | null; // RFC 3339
  lastPreview: string | null; // "Nama: teks" maksimal 80 karakter, atau "Pesan dihapus"
  canPost: boolean;
  canArchive: boolean;
  canDelete: boolean;
};

export type NotifyMode = "all" | "mentions" | "off";

export type ChatOverview = {
  me: string;
  canCreateChannel: boolean; // bukan Tamu, dan punya minimal satu cakupan yang boleh
  canCreateOrgChannel: boolean; // hanya superadmin yang boleh membuat channel "Seluruh kantor"
  canDirectMessage: boolean; // bukan Tamu
  conversations: ConversationSummary[]; // channel aktif, chat pribadi, lalu yang diarsipkan; urut terbaru
  people: Person[]; // rekan yang bisa diajak chat pribadi (anggota aktif bukan Tamu, tanpa saya)
  teams: { id: string; name: string }[]; // tim saya, untuk channel baru
  projects: { id: string; name: string; teamId: string | null }[]; // proyek yang saya ikuti
  notify: NotifyMode;
};

export type FileState = "local" | "fetching" | "remote" | "missing";

export type FileView = {
  hash: string;
  name: string;
  size: number;
  mime: string;
  // local: ada di laptop ini. fetching: sedang diunduh. remote: belum diunduh (file besar,
  // klik untuk mengunduh). missing: belum ada laptop rekan yang online dengan salinannya.
  state: FileState;
  autoDownload: boolean; // file kecil yang disalin otomatis
};

export type DeliveryState = "pending" | "deposited" | "delivered" | "read";

export type MessageStatus = {
  state: DeliveryState; // gabungan: yang paling rendah di antara penerima
  read: number;
  delivered: number; // termasuk yang sudah membaca
  deposited: number;
  total: number; // jumlah penerima
};

export type ReplyPreview = { id: string; author: Person | null; preview: string; deleted: boolean };

export type MessageView = {
  id: string;
  conv: string;
  author: Person;
  at: string;
  text: string; // kosong kalau dihapus
  mentions: Person[];
  replyTo: ReplyPreview | null;
  files: FileView[];
  deleted: boolean;
  mine: boolean;
  status: MessageStatus | null; // hanya untuk pesan saya
  canDelete: boolean;
};

export type ConversationView = {
  conversation: ConversationSummary;
  members: Person[]; // untuk saran mention
  messages: MessageView[]; // urut lama ke baru
  hasMore: boolean;
};

export type ReceiptView = { person: Person; state: DeliveryState };

// File yang dipilih lewat dialog Windows milik Mira (chat_pick_files). Hanya path dari
// dialog ini yang diterima chat_send.
export type PickedFile = { path: string; name: string; size: number };

export type NewChannelScope = { kind: ScopeKind; id: string | null };

// Event yang dikirim Rust saat data chat berubah (lokal atau dari rekan).
export const FEATURE_EVENT = "mira://feature";
export const CHAT_TOPIC = "chat";

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw NO_TAURI_ERROR;
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw toAppError(err);
  }
}

export const chatApi = {
  overview: () => call<ChatOverview>("chat_overview"),
  messages: (conv: string, before: string | null = null, limit = 100) =>
    call<ConversationView>("chat_messages", { conv, before, limit }),
  // files: path dari pickFiles().
  send: (conv: string, text: string, replyTo: string | null, mentions: string[], files: string[]) =>
    call<MessageView>("chat_send", { conv, text, replyTo, mentions, files }),
  deleteMessage: (conv: string, messageId: string) => call<null>("chat_delete_message", { conv, messageId }),
  markRead: (conv: string) => call<null>("chat_mark_read", { conv }),
  createChannel: (name: string, scope: NewChannelScope) =>
    call<ConversationSummary>("chat_create_channel", { name, scope }),
  setArchived: (conv: string, archived: boolean) => call<null>("chat_set_archived", { conv, archived }),
  deleteChannel: (conv: string) => call<null>("chat_delete_channel", { conv }),
  openDm: (publicKey: string) => call<ConversationSummary>("chat_open_dm", { publicKey }),
  messageReceipts: (messageId: string) => call<ReceiptView[]>("chat_message_receipts", { messageId }),
  fileOpen: (hash: string, name: string) => call<null>("chat_file_open", { hash, name }),
  // Membuka dialog "Simpan sebagai" di sisi Rust. false kalau dibatalkan.
  fileSave: (hash: string) => call<boolean>("chat_file_save", { hash }),
  // Membuka dialog pilih file di sisi Rust. Daftar kosong kalau dibatalkan.
  pickFiles: () => call<PickedFile[]>("chat_pick_files"),
  fileDownload: (hash: string) => call<FileView>("chat_file_download", { hash }),
  setNotify: (mode: NotifyMode) => call<null>("chat_set_notify", { mode }),
  setMuted: (conv: string, muted: boolean) => call<null>("chat_set_muted", { conv, muted }),
};

// Berlangganan perubahan chat: event `mira://feature` dengan topik "chat".
export function subscribeChat(handler: () => void): () => void {
  if (!isTauri()) return () => {};
  let stopped = false;
  let unlisten: (() => unknown) | null = null;
  const stop = (fn: () => unknown) => void Promise.resolve().then(fn).catch(() => {});
  try {
    listen<{ topic?: string }>(FEATURE_EVENT, (event) => {
      if (!stopped && event.payload?.topic === CHAT_TOPIC) handler();
    })
      .then((fn) => {
        if (stopped) stop(fn);
        else unlisten = fn;
      })
      .catch(() => {});
  } catch {
    // Tanpa event tetap jalan: layar memakai polling cadangan.
  }
  return () => {
    stopped = true;
    if (unlisten) stop(unlisten);
  };
}

export const DELIVERY_LABELS: Record<DeliveryState, string> = {
  pending: "Menunggu",
  deposited: "Dititipkan",
  delivered: "Diterima laptopnya",
  read: "Dibaca",
};
