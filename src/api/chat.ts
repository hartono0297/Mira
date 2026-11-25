// Kontrak chat dengan inti Rust (docs/plans/tahap-2.md, bagian 10).
// Sumber kebenaran bentuk data: Rust `chat/view.rs` mengikuti file ini.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { API_TEXT } from "../i18n/api";
import { localizeError } from "../i18n/errors";
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
  // "project" (v0.4): chat bawaan sebuah proyek. Tampil seperti grup, anggotanya selalu anggota
  // proyek, dan selalu di bagian Proyek. Channel buatan v0.2 untuk proyek tetap "channel".
  // "division" (v0.6): chat bawaan sebuah divisi, di bagian Departemen di bawah channel departemennya.
  kind: "channel" | "group" | "project" | "division" | "dm";
  section: ChatSection;
  // Chat divisi (v0.6): id divisi dan id departemennya. Tidak ada atau null untuk percakapan lain.
  divisionId?: string | null;
  teamId?: string | null;
  name: string; // nama channel tanpa "#", nama grup, nama proyek, atau nama rekan untuk chat pribadi
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
  // Bagian sidebar yang dilipat, disimpan di database laptop ini (v0.4). Urut CHAT_SECTIONS.
  folded: ChatSection[];
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

export type ProjectChatMember = {
  person: Person;
  me: boolean;
  manager: boolean; // pengelola proyek di board (yang bisa mengubah anggota proyek)
};

// Anggota chat proyek: sama dengan anggota proyek di board, dihitung ulang setiap dibuka.
export type ProjectChatView = {
  conv: string;
  projectId: string;
  name: string; // nama proyek
  members: ProjectChatMember[]; // urut nama
  canManage: boolean; // saya pengelola proyek: bisa mengubah anggota lewat Board
  former: boolean; // saya bukan anggota proyek lagi
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
  // v0.5.1: chip reaksi, urut reaksi pertama. Kosong kalau pesan dihapus.
  reactions: ReactionView[];
  // v0.5.1: pesan sticker (teks ":nama:" dan satu gambar "<nama>.sticker.<png|webp|gif>").
  // Laptop lama menampilkan teks ":nama:" dan gambarnya sebagai lampiran biasa.
  sticker: MessageSticker | null;
};

// Satu chip reaksi di bawah pesan. emoji: emoji Unicode, atau ":nama:" untuk emote kantor.
export type ReactionView = { emoji: string; count: number; mine: boolean; people: Person[] };

export type MessageSticker = {
  hash: string;
  name: string; // nama pendek tanpa titik dua
  mime: string;
  size: number;
  ready: boolean; // gambar sudah ada di laptop ini dan lolos pemeriksaan
  saved: boolean; // sudah ada di koleksi sticker saya
};

export type OfficeStickerState = "active" | "hidden" | "deleted";

export type OfficeSticker = {
  id: string; // 32 hex
  pack: string;
  name: string; // [a-z0-9_], 2 sampai 32 karakter, tanpa titik dua
  keywords: string[];
  hash: string;
  mime: string;
  size: number;
  state: "active" | "hidden"; // yang dihapus tidak dikirim
  ready: boolean; // gambar sudah ada di laptop ini
  nameTaken: boolean; // sticker aktif lain yang lebih lama memakai nama ini (hanya superadmin)
};

export type MySticker = {
  id: string;
  name: string;
  keywords: string[];
  hash: string;
  mime: string;
  size: number;
  addedAt: string;
};

export type StickerCatalog = {
  office: OfficeSticker[]; // urut paket lalu nama; superadmin juga menerima yang disembunyikan
  mine: MySticker[]; // terbaru dulu
  canManage: boolean; // superadmin
  recentEmoji: string[]; // emoji yang baru dipakai di laptop ini, terbaru dulu, paling banyak 24
};

// Gambar yang dipilih lewat dialog sticker milik Mira, sudah diperiksa inti Rust.
export type PickedSticker = {
  path: string;
  name: string; // saran nama dari nama file, boleh kosong
  size: number;
  mime: string;
  width: number;
  height: number;
  frames: number;
};

export type StickerSource = { kind: "office"; id: string } | { kind: "mine"; id: string };

// Batas yang sama dengan inti Rust (chat/sticker_file.rs, chat/stickers.rs).
export const STICKER_MAX_BYTES = 512 * 1024;
export const STICKER_NAME_PATTERN = /^[a-z0-9_]{2,32}$/;
export const STICKER_MAX_KEYWORDS = 8;
export const STICKER_PACK_MAX_CHARS = 30;

export type ConversationView = {
  conversation: ConversationSummary;
  members: Person[]; // untuk saran mention
  messages: MessageView[]; // urut lama ke baru
  hasMore: boolean;
  // Kejadian grup dalam rentang waktu pesan yang dimuat (semua kejadian kalau !hasMore). Kosong
  // untuk channel dan chat pribadi.
  events: ConversationEvent[];
  // v0.5.1: saya boleh memberi atau menghapus reaksi di sini (juga di channel hanya-baca).
  canReact: boolean;
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
    throw localizeError(toAppError(err));
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
  // Bagian sidebar yang dilipat di laptop ini. Nilai yang tidak dikenal dibuang inti Rust.
  setFolded: (sections: ChatSection[]) => call<null>("chat_set_folded", { sections }),
  // Superadmin: channel Umum hanya-baca untuk selain superadmin.
  setLocked: (conv: string, locked: boolean) => call<null>("chat_set_locked", { conv, locked }),
  // Grup (bukan Tamu). members: kunci publik, tanpa saya. Boleh kosong (v0.4): grup berisi
  // pembuatnya saja, anggota ditambah belakangan.
  createGroup: (name: string, members: string[]) =>
    call<ConversationSummary>("chat_create_group", { name, members }),
  group: (conv: string) => call<GroupView>("chat_group", { conv }),
  groupAdd: (conv: string, members: string[]) => call<null>("chat_group_add", { conv, members }),
  // Pemilik grup mengeluarkan orang lain. Untuk keluar sendiri pakai groupLeave.
  groupRemove: (conv: string, member: string) => call<null>("chat_group_remove", { conv, member }),
  groupLeave: (conv: string) => call<null>("chat_group_leave", { conv }),
  groupRename: (conv: string, name: string) => call<null>("chat_group_rename", { conv, name }),
  // Chat proyek (kind "project"): anggota proyek sekarang. Anggota diubah lewat Board.
  projectChat: (conv: string) => call<ProjectChatView>("chat_project", { conv }),
  // v0.5.1: reaksi. on true menambah, false menghapus reaksi saya dengan emoji itu.
  react: (conv: string, messageId: string, emoji: string, on: boolean) =>
    call<null>("chat_react", { conv, messageId, emoji, on }),
  // Mencatat emoji yang baru dipakai (daftar "Sering dipakai" per laptop).
  emojiUsed: (emoji: string) => call<null>("chat_emoji_used", { emoji }),
  stickers: () => call<StickerCatalog>("chat_stickers"),
  // Gambar sticker yang sudah diperiksa, sebagai URL data:. Gagal kalau belum ada atau tidak lolos.
  stickerImage: (hash: string) => call<string>("chat_sticker_image", { hash }),
  // Dialog pilih gambar milik Mira. null kalau dibatalkan.
  pickSticker: () => call<PickedSticker | null>("chat_sticker_pick"),
  addMySticker: (path: string, name: string, keywords: string[]) =>
    call<MySticker>("chat_my_sticker_add", { path, name, keywords }),
  saveSticker: (messageId: string) => call<MySticker>("chat_my_sticker_save", { messageId }),
  removeMySticker: (id: string) => call<null>("chat_my_sticker_remove", { id }),
  // Superadmin.
  addOfficeSticker: (path: string, pack: string, name: string, keywords: string[]) =>
    call<OfficeSticker>("chat_office_sticker_add", { path, pack, name, keywords }),
  updateOfficeSticker: (
    id: string,
    pack: string,
    name: string,
    keywords: string[],
    state: OfficeStickerState,
  ) => call<null>("chat_office_sticker_update", { id, pack, name, keywords, state }),
  sendSticker: (conv: string, source: StickerSource, replyTo: string | null) =>
    call<MessageView>("chat_send_sticker", { conv, source, replyTo }),
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

export const DELIVERY_LABELS: Record<DeliveryState, string> = API_TEXT.delivery;
