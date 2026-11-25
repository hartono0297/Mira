// Teks tampilan panel percakapan. Fungsi murni supaya mudah dites.
import {
  DELIVERY_LABELS,
  type ConversationSummary,
  type DeliveryState,
  type MessageStatus,
  type MessageView,
  type Person,
} from "../../api/chat";
import { CHAT_TEXT as T } from "../../i18n/chat";
import idText from "../../i18n/chat-text.id";

// Pesan berurutan dari orang yang sama dalam jarak ini digabung di bawah satu nama.
export const GROUP_GAP_MS = 5 * 60 * 1000;

function parse(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

const pad = (n: number) => String(n).padStart(2, "0");

// Jam lokal seperti "09.12" (bahasa Inggris "09:12").
export function formatTime(iso: string): string {
  const d = parse(iso);
  if (!d) return "";
  return T.time(pad(d.getHours()), pad(d.getMinutes()));
}

// "Senin, 23 November 2026" (bahasa Inggris "Monday, 23 November 2026").
function longDate(d: Date): string {
  return T.date(T.days[d.getDay()], d.getDate(), T.months[d.getMonth()], d.getFullYear());
}

// Kunci hari lokal "2026-11-23", untuk pemisah hari.
export function dayKey(iso: string): string {
  const d = parse(iso);
  if (!d) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// "Hari ini", "Kemarin", atau "Senin, 23 November 2026".
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = parse(iso);
  if (!d) return "";
  const today = dayKey(now.toISOString());
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  const key = dayKey(iso);
  if (key === today) return T.today;
  if (key === dayKey(y.toISOString())) return T.yesterday;
  return longDate(d);
}

// Tanggal dan jam lengkap untuk title dan pembaca layar.
export function fullTime(iso: string): string {
  const d = parse(iso);
  if (!d) return iso;
  return T.dateTime(longDate(d), formatTime(iso));
}

function decimal(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return String(rounded).replace(".", T.decimalSeparator);
}

// Ukuran file: "800 byte", "12 KB", "1,2 MB", "3,4 GB" (bahasa Inggris "1.2 MB").
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return T.bytes(bytes);
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${decimal(mb)} MB`;
  return `${decimal(mb / 1024)} GB`;
}

export type FileKind = "pdf" | "image" | "word" | "excel" | "slides" | "archive" | "other";

export function fileKind(mime: string, name: string): FileKind {
  const m = mime.toLowerCase();
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (m === "application/pdf" || ext === "pdf") return "pdf";
  if (m.startsWith("image/")) return "image";
  if (m.includes("wordprocessing") || m === "application/msword" || ext === "doc" || ext === "docx") return "word";
  if (m.includes("spreadsheet") || m === "application/vnd.ms-excel" || ext === "xls" || ext === "xlsx" || ext === "csv")
    return "excel";
  if (m.includes("presentation") || ext === "ppt" || ext === "pptx") return "slides";
  if (m.includes("zip") || m.includes("compressed") || ext === "zip" || ext === "rar" || ext === "7z") return "archive";
  return "other";
}

// Nama file dari path Windows atau POSIX.
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

// Judul percakapan: "#nama" untuk channel, nama rekan untuk chat pribadi, nama grup atau
// nama proyek apa adanya.
export function conversationTitle(summary: ConversationSummary): string {
  if (summary.kind === "channel") return `#${summary.name}`;
  if (summary.kind === "dm") return summary.peer?.name ?? summary.name;
  return summary.name;
}

// Nama yang sudah diawali kata awalan (bahasa aktif atau bahasa Indonesia, karena nama
// tersimpan biasanya ditulis dalam bahasa Indonesia), misalnya "Proyek Alfa".
export function hasPrefix(name: string, kind: keyof typeof idText.prefix): boolean {
  const words = [...new Set([T.prefix[kind], idText.prefix[kind]])].map((w) => w.toLowerCase());
  const lower = name.toLowerCase();
  return words.some((w) => lower.startsWith(w) && /^\s/.test(lower.slice(w.length)));
}

// Sasaran pesan di kolom tulis dan keadaan kosong: "Proyek Alfa" untuk chat proyek (tanpa
// mengulang kata Proyek kalau namanya sudah diawali kata itu), selain itu sama dengan judul.
export function conversationTarget(summary: ConversationSummary): string {
  if (summary.kind !== "project") return conversationTitle(summary);
  return hasPrefix(summary.name, "project") ? summary.name : T.scope.projectNamed(summary.name);
}

export function scopeLabel(summary: ConversationSummary): string {
  if (summary.kind === "project") return T.scope.project;
  if (summary.kind === "dm" || !summary.scope) return T.scope.direct;
  if (summary.scope.kind === "org") return T.scope.org;
  if (summary.scope.kind === "team") return T.scope.team(summary.scope.name);
  if (summary.scope.kind === "group") return T.scope.group;
  return T.scope.projectNamed(summary.scope.name);
}

// Mention

const WORD_CHAR = /[\p{L}\p{N}_]/u;

// Posisi "@Nama" di teks, tanpa membedakan huruf besar kecil. Sesudah nama
// tidak boleh ada huruf atau angka, supaya "@Sari" tidak cocok di "@Sarina".
function findAll(text: string, name: string): number[] {
  const needle = `@${name}`.toLowerCase();
  const hay = text.toLowerCase();
  const found: number[] = [];
  if (!name.trim()) return found;
  let at = hay.indexOf(needle);
  while (at !== -1) {
    const after = text[at + needle.length];
    if (after === undefined || !WORD_CHAR.test(after)) found.push(at);
    at = hay.indexOf(needle, at + 1);
  }
  return found;
}

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "mention"; text: string; person: Person; isMe: boolean };

// Pecah teks jadi potongan biasa dan "@Nama" untuk orang yang disebut.
// Nama yang lebih panjang menang ("@Sari Uji" sebelum "@Sari").
export function segmentMentions(text: string, mentions: Person[], me: string): Segment[] {
  const people = [...mentions].sort((a, b) => b.name.length - a.name.length);
  const taken: { start: number; end: number; person: Person }[] = [];
  for (const person of people) {
    for (const start of findAll(text, person.name)) {
      const end = start + person.name.length + 1;
      if (taken.some((t) => start < t.end && end > t.start)) continue;
      taken.push({ start, end, person });
    }
  }
  taken.sort((a, b) => a.start - b.start);
  const out: Segment[] = [];
  let pos = 0;
  for (const t of taken) {
    if (t.start > pos) out.push({ kind: "text", text: text.slice(pos, t.start) });
    out.push({ kind: "mention", text: text.slice(t.start, t.end), person: t.person, isMe: t.person.publicKey === me });
    pos = t.end;
  }
  if (pos < text.length) out.push({ kind: "text", text: text.slice(pos) });
  return out;
}

// Emote kantor (v0.5.1)

// Nama emote dari teks yang persis ":nama:", selain itu null. Aturan nama sama dengan inti Rust.
export function emoteName(text: string): string | null {
  const m = /^:([a-z0-9_]{2,32}):$/.exec(text);
  return m ? m[1] : null;
}

export type EmotePart = { kind: "emote"; text: string; name: string };
export type TextPart = { kind: "text"; text: string } | EmotePart;

// Pecah teks jadi potongan biasa dan ":nama:" untuk emote yang dikenal (known). Titik dua tidak
// boleh menempel ke huruf atau angka di luar, jadi jam "10:30:45" dan alamat seperti
// "http://host:80" tetap teks. Nama yang tidak dikenal juga tetap teks.
export function splitEmotes(text: string, known: (name: string) => boolean): TextPart[] {
  const out: TextPart[] = [];
  const re = /:([a-z0-9_]{2,32}):/g;
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const before = text[start - 1];
    const after = text[end];
    if ((before !== undefined && WORD_CHAR.test(before)) || (after !== undefined && WORD_CHAR.test(after)) || !known(m[1])) {
      re.lastIndex = start + 1;
      continue;
    }
    if (start > pos) out.push({ kind: "text", text: text.slice(pos, start) });
    out.push({ kind: "emote", text: m[0], name: m[1] });
    pos = end;
  }
  if (pos < text.length) out.push({ kind: "text", text: text.slice(pos) });
  return out;
}

export type MessagePart = Segment | EmotePart;

// Isi pesan: mention dulu, lalu emote di potongan teks biasa. "@Nama" tidak pernah dipecah.
export function segmentMessage(
  text: string,
  mentions: Person[],
  me: string,
  known: (name: string) => boolean,
): MessagePart[] {
  return segmentMentions(text, mentions, me).flatMap((s): MessagePart[] =>
    s.kind === "text" ? splitEmotes(s.text, known) : [s],
  );
}

type GraphemeSegmenter = { segment: (s: string) => Iterable<{ segment: string }> };
type SegmenterCtor = new (locale?: string, options?: { granularity: "grapheme" }) => GraphemeSegmenter;

function graphemes(s: string): string[] {
  const Segmenter = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
  if (!Segmenter) return Array.from(s);
  return Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(s), (g) => g.segment);
}

const PICTOGRAPHIC = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

// Pesan yang isinya hanya 1 sampai 3 emoji atau emote kantor (spasi boleh) tampil lebih besar.
export function isEmojiOnly(text: string, known: (name: string) => boolean): boolean {
  let n = 0;
  for (const part of splitEmotes(text.trim(), known)) {
    if (part.kind === "emote") {
      n++;
      continue;
    }
    for (const g of graphemes(part.text)) {
      if (/^\s+$/u.test(g)) continue;
      if (!PICTOGRAPHIC.test(g)) return false;
      n++;
    }
    if (n > 3) return false;
  }
  return n >= 1 && n <= 3;
}

// Daftar nama untuk keterangan reaksi: "Rina", "Rina dan Dimas", "Rina, Dimas, dan Sari".
// join berisi teks "dan" dalam bahasa aktif (kamus reaksi).
export function joinNames(
  names: string[],
  join: { joinTwo: (a: string, b: string) => string; joinMany: (head: string, last: string) => string },
): string {
  if (names.length <= 1) return names.join("");
  if (names.length === 2) return join.joinTwo(names[0], names[1]);
  return join.joinMany(names.slice(0, -1).join(", "), names[names.length - 1]);
}

// Anggota yang "@Nama"-nya ada di teks, untuk daftar mention saat mengirim.
export function mentionsInText(text: string, members: Person[]): Person[] {
  return members.filter((m) => findAll(text, m.name).length > 0);
}

export type MentionQuery = { start: number; query: string };

// "@kata" yang sedang diketik sebelum kursor. "@" harus di awal teks atau
// sesudah spasi, dan belum ada baris baru di antaranya.
export function mentionQuery(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (query.length > 40 || /[\n\r]/.test(query) || query.startsWith(" ")) return null;
  return { start: at, query };
}

export function filterMembers(members: Person[], query: string, me: string, limit = 6): Person[] {
  const q = query.trim().toLowerCase();
  const others = members.filter((m) => m.publicKey !== me);
  const starts = others.filter((m) => m.name.toLowerCase().startsWith(q));
  const contains = others.filter((m) => !m.name.toLowerCase().startsWith(q) && m.name.toLowerCase().includes(q));
  return [...starts, ...contains].slice(0, limit);
}

// Pengelompokan

export type ListItem =
  | { kind: "day"; key: string; label: string }
  | { kind: "message"; message: MessageView; grouped: boolean };

export function groupMessages(messages: MessageView[], now: Date = new Date()): ListItem[] {
  const out: ListItem[] = [];
  let prev: MessageView | null = null;
  for (const m of messages) {
    const key = dayKey(m.at);
    const newDay = !prev || dayKey(prev.at) !== key;
    if (newDay) out.push({ kind: "day", key, label: dayLabel(m.at, now) });
    const gap = prev ? new Date(m.at).getTime() - new Date(prev.at).getTime() : Infinity;
    const grouped =
      !newDay && prev !== null && prev.author.publicKey === m.author.publicKey && gap >= 0 && gap < GROUP_GAP_MS;
    out.push({ kind: "message", message: m, grouped });
    prev = m;
  }
  return out;
}

// Gabungkan pesan lama yang dimuat lewat "Muat pesan sebelumnya" dengan
// halaman terbaru. Pesan dengan id sama memakai versi terbaru.
export function mergeMessages(older: MessageView[], latest: MessageView[]): MessageView[] {
  const ids = new Set(latest.map((m) => m.id));
  return [...older.filter((m) => !ids.has(m.id)), ...latest];
}

// Status kirim

export type StatusLine = { icon: DeliveryState; text: string };

// Chat pribadi: label status penerima. Channel: jumlah, misalnya "Dibaca 2 dari 5".
export function deliveryLine(status: MessageStatus, kind: ConversationSummary["kind"]): StatusLine | null {
  if (kind === "dm") return { icon: status.state, text: DELIVERY_LABELS[status.state] };
  if (status.total <= 0) return null;
  if (status.read > 0) return { icon: "read", text: T.readCount(status.read, status.total) };
  if (status.delivered > 0) return { icon: "delivered", text: T.deliveredCount(status.delivered, status.total) };
  if (status.deposited > 0) return { icon: "deposited", text: DELIVERY_LABELS.deposited };
  return { icon: "pending", text: DELIVERY_LABELS.pending };
}

// Nama penulis di daftar pesan: "Anda" untuk pesan sendiri.
export function authorName(message: MessageView): string {
  return message.mine ? T.you : message.author.name;
}

// Cuplikan pesan untuk kutipan balasan di komposer.
export function messagePreview(message: MessageView, max = 80): string {
  if (message.deleted) return T.deleted;
  const text = message.text.replace(/\s+/g, " ").trim();
  if (!text) return message.files.length ? message.files.map((f) => f.name).join(", ") : "";
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}
