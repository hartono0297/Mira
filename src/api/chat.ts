// Kontrak chat dengan inti Rust (docs/plans/tahap-2.md, bagian 10).
// Sumber kebenaran bentuk data: Rust `chat/view.rs` mengikuti file ini.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri, NO_TAURI_ERROR, toAppError } from ".";

export type Person = { publicKey: string; name: string };

// "group" untuk grup (v0.3). "team" adalah departemen (nama lama di kode).
export type ScopeKind = "org" | "team" | "project" | "group";

// Cakupan channel. `id` null untuk org (#umum dan channel seluruh kantor).
export type ChannelScope = { kind: ScopeKind; id: string | null; name: string };

// Lima bagian daftar chat, urutan tetap seperti di sini.
export type ChatSection = "umum" | "departemen" | "proyek" | "grup" | "pribadi";
export const CHAT_SECTIONS: ChatSection[] = ["umum", "departemen", "proyek", "grup", "pribadi"];

export type ConversationSummary = {
  id: string; // "ch:<32 hex>", "gr:<32 hex>", atau "dm:<kunci>:<kunci>"
  kind: "channel" | "group" | "dm";
  section: ChatSection;
  name: string; // nama channel tanpa "#", nama grup, atau nama rekan untuk chat pribadi
  scope: ChannelScope | null; // null untuk chat pribadi
  peer: Person | null; // rekan di chat pribadi
  isUmum: boolean;
  archived: boolean;
  // Channel Umum yang hanya bisa ditulis superadmin (ikon gembok).
  locked: boolean;
  // Saya sudah bukan anggota (dikeluarkan dari proyek atau grup, pindah departemen).
  // Pesan lama tetap bisa dibaca di laptop ini, pesan baru tidak sampai lagi.
  former: boolean;
  memberCount: number; // jumlah anggota sekarang (untuk "Grup · 5 anggota")
  muted: boolean;
  unread: number;
  mentionUnread: number; // pesan belum dibaca yang menyebut saya
  lastAt: string | null; // RFC 3339
  lastPreview: string | null; // "Nama: teks" maksimal 80 karakter, atau "Pesan dihapus"
  canPost: boolean;
  // Kalimat untuk kolom pesan kalau canPost false, misalnya "Hanya superadmin yang bisa menulis
  // di channel ini." null kalau bisa menulis.
  postBlockedReason: string | null;
  canArchive: boolean;
  canDelete: boolean;
  canLock: boolean; // superadmin, channel Umum selain #umum
};

export type NotifyMode = "all" | "mentions" | "off";

export type ChatOverview = {
  me: string;
  isSuperadmin: boolean;
  isGuest: boolean;
  canCreateChannel: boolean; // bukan Tamu, dan punya minimal satu cakupan yang boleh
  canCreateOrgChannel: boolean; // hanya superadmin yang boleh membuat channel Umum
  canCreateGroup: boolean; // bukan Tamu
  canDirectMessage: boolean; // bukan Tamu
  // Urut: bagian (CHAT_SECTIONS), lalu yang diarsipkan atau bukan anggota lagi di akhir
  // bagiannya, lalu terbaru.
  conversations: ConversationSummary[];
  people: Person[]; // rekan yang bisa diajak chat pribadi atau grup (anggota aktif bukan Tamu, tanpa saya)
  teams: { id: string; name: string }[]; // departemen saya (paling banyak satu)
  myDepartment: { id: string; name: string } | null;
  projects: { id: string; name: string; teamId: string | null }[]; // proyek yang saya ikuti
  otherProjects: number; // proyek terdaftar yang bukan milik saya (untuk catatan di bagian Proyek)
  notify: NotifyMode;
};

export type GroupMemberView = {
  person: Person;
  owner: boolean; // pemilik grup sekarang
  me: boolean;
  addedBy: Person | null; // null untuk pembuat grup
  canRemove: boolean; // saya pemilik dan ini bukan saya
};

export type GroupView = {
  conv: string;
  name: string;
  owner: Person | null;
  createdBy: Person;
  createdAt: string;
  members: GroupMemberView[]; // urut lama masuk
  candidates: Person[]; // anggota aktif bukan Tamu yang belum di grup (untuk "Tambah orang")
  canAdd: boolean;
  canRename: boolean;
  canLeave: boolean;
  former: boolean; // saya bukan anggota lagi
};

// Kejadian di grup ("Rina membuat grup ini dan menambahkan Dimas dan Sari."), diselipkan
// di antara pesan menurut waktu.
export type ConversationEvent = { id: string; at: string; text: string };

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
  // Kejadian grup dalam rentang waktu pesan yang dimuat (semua kejadian kalau !hasMore). Kosong
  // untuk channel dan chat pribadi.
  events: ConversationEvent[];
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
  // Membuka file lampiran pesan itu; nama file diambil inti Rust dari pesannya.
  fileOpen: (messageId: string, hash: string) => call<null>("chat_file_open", { messageId, hash }),
  // Membuka dialog "Simpan sebagai" di sisi Rust. false kalau dibatalkan.
  fileSave: (hash: string) => call<boolean>("chat_file_save", { hash }),
  // Membuka dialog pilih file di sisi Rust. Daftar kosong kalau dibatalkan.
  pickFiles: () => call<PickedFile[]>("chat_pick_files"),
  fileDownload: (hash: string) => call<FileView>("chat_file_download", { hash }),
  setNotify: (mode: NotifyMode) => call<null>("chat_set_notify", { mode }),
  setMuted: (conv: string, muted: boolean) => call<null>("chat_set_muted", { conv, muted }),
  // Superadmin: channel Umum hanya-baca untuk selain superadmin.
  setLocked: (conv: string, locked: boolean) => call<null>("chat_set_locked", { conv, locked }),
  // Grup (bukan Tamu). members: kunci publik, tanpa saya.
  createGroup: (name: string, members: string[]) =>
    call<ConversationSummary>("chat_create_group", { name, members }),
  group: (conv: string) => call<GroupView>("chat_group", { conv }),
  groupAdd: (conv: string, members: string[]) => call<null>("chat_group_add", { conv, members }),
  // Pemilik grup mengeluarkan orang lain. Untuk keluar sendiri pakai groupLeave.
  groupRemove: (conv: string, member: string) => call<null>("chat_group_remove", { conv, member }),
  groupLeave: (conv: string) => call<null>("chat_group_leave", { conv }),
  groupRename: (conv: string, name: string) => call<null>("chat_group_rename", { conv, name }),
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
