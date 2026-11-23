// Stempel tanda tangan dan halaman catatan, dikerjakan pdf-lib di frontend.
//
// Koordinat `PdfRect` adalah userspace PDF absolut (sudah termasuk offset
// MediaBox/CropBox, sumbu y ke atas): persegi sejajar sumbu yang menutupi
// kotak tanda tangan seperti terlihat di layar. Pada halaman ber-/Rotate,
// gambar dan teks digambar berputar searah supaya tampak tegak bagi pembaca.
//
// Stempel dan halaman catatan disimpan sebagai incremental update: byte versi
// sebelumnya tidak berubah, objek baru dan yang berubah ditulis di belakang
// tanpa object stream. Kode dokumen ditulis sebagai string literal ASCII di
// kamus Info, supaya inti Rust bisa menemukan `mira-doc:` cukup dengan
// memindai byte file.

import {
  PDFDict,
  PDFDocument,
  PDFFont,
  PDFHexString,
  PDFImage,
  PDFName,
  PDFObject,
  PDFPage,
  PDFRawStream,
  PDFRef,
  PDFString,
  PageSizes,
  StandardFonts,
  decodePDFRawStream,
  degrees,
  popGraphicsState,
  pushGraphicsState,
  rgb,
} from "pdf-lib";
import type { AppError } from "../../api";

export type PdfRect = {
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type StampOptions = {
  placement: PdfRect;
  png: Uint8Array;
  signerName: string;
  signedAt: string;
  docTag: string;
  timeZone?: string;
};

export type AuditSigner = {
  name: string;
  kind: "member" | "guest";
  signedAt: string;
  fingerprint: string;
};

export type AuditInfo = {
  title: string;
  docTag: string;
  originalHash: string;
  mode: "sequential" | "parallel";
  signers: AuditSigner[];
  generatedAt: string;
  timeZone?: string;
};

const PRODUCER = "Mira";
/** Kunci tambahan di kamus Info; selalu literal ASCII walau Keywords ditulis UTF-16. */
const INFO_DOC_TAG_KEY = "MiraDocTag";
const DOC_TAG_PATTERN = /mira-doc:[0-9A-Za-z_-]+/g;

// Abu-abu gelap netral, terbaca di atas kertas putih tanpa sekeras hitam pekat.
const INK = rgb(0.2, 0.2, 0.2);
const INK_SOFT = rgb(0.4, 0.4, 0.4);
const RULE = rgb(0.75, 0.75, 0.75);

// ---------------------------------------------------------------------------
// Waktu

const MONTHS_ID = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];

const ZONE_NAMES: Record<number, string> = { 420: "WIB", 480: "WITA", 540: "WIT" };

function zoneLabel(offsetMinutes: number): string {
  const named = ZONE_NAMES[offsetMinutes];
  if (named) return named;
  if (offsetMinutes === 0) return "UTC";
  const sign = offsetMinutes > 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return minutes === 0
    ? `UTC${sign}${hours}`
    : `UTC${sign}${hours}.${String(minutes).padStart(2, "0")}`;
}

/**
 * Contoh: `22 November 2026, 15.04 WIB`. Zona WIB/WITA/WIT dipilih dari selisih
 * terhadap UTC (+7/+8/+9); selisih lain ditulis `UTC+x`, selisih nol `UTC`.
 * `timeZone` (IANA) untuk tes; bawaan zona lokal laptop.
 */
export function formatSignedAt(at: string | Date, timeZone?: string): string {
  const date = at instanceof Date ? at : new Date(at);
  const ms = date.getTime();
  if (Number.isNaN(ms)) throw new Error("Waktu tanda tangan tidak valid.");

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour") % 24;
  const minute = get("minute");
  const second = get("second");

  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetMinutes = Math.round((wallAsUtc - Math.floor(ms / 1000) * 1000) / 60000);

  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return `${day} ${MONTHS_ID[month - 1]} ${year}, ${hh}.${mm} ${zoneLabel(offsetMinutes)}`;
}

// ---------------------------------------------------------------------------
// Teks aman untuk font standar (WinAnsi)

// Titik kode di luar Latin-1 yang tetap ada di WinAnsiEncoding (0x80 sampai 0x9F).
const WIN_ANSI_EXTRA = new Set([
  0x152, 0x153, 0x160, 0x161, 0x178, 0x17d, 0x17e, 0x192, 0x2c6, 0x2dc, 0x2013, 0x2014,
  0x2018, 0x2019, 0x201a, 0x201c, 0x201d, 0x201e, 0x2020, 0x2021, 0x2022, 0x2026, 0x2030,
  0x2039, 0x203a, 0x20ac, 0x2122,
]);

// Spasi selebar apa pun (tab, NBSP, spasi tipis, spasi ideografis) menjadi spasi biasa.
const ODD_SPACE = /[\t\n\v\f\r\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g;
// Karakter tak terlihat dibuang: lebar nol, soft hyphen, BOM.
const INVISIBLE = /[\u00ad\u180e\u200b-\u200d\u2060\ufeff]/g;

function isWinAnsi(cp: number): boolean {
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WIN_ANSI_EXTRA.has(cp);
}

/**
 * Menyiapkan teks untuk Helvetica/Courier standar: komposisi NFC, spasi aneh
 * dinormalkan dan dirapatkan, karakter tak terlihat dibuang, dan setiap
 * karakter yang tidak ada di WinAnsi diganti `?`.
 */
export function toWinAnsiSafe(text: string): string {
  const cleaned = text
    .normalize("NFC")
    .replace(INVISIBLE, "")
    .replace(ODD_SPACE, " ")
    .replace(/ {2,}/g, " ")
    .trim();
  let out = "";
  for (const ch of cleaned) {
    const cp = ch.codePointAt(0) ?? 0;
    out += isWinAnsi(cp) ? ch : "?";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Muat, metadata, simpan

function looksLikePdf(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 1024);
  for (let i = 0; i + 4 < head.length; i++) {
    if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46) {
      return true; // "%PDF"
    }
  }
  return false;
}

const ENCRYPTED_MESSAGE =
  "PDF ini dilindungi kata sandi pemilik, jadi Mira tidak bisa menambahkan tanda tangan. Simpan ulang tanpa perlindungan di aplikasi asalnya, lalu coba lagi.";
const NOT_PDF_MESSAGE = "File ini bukan PDF atau rusak, jadi tidak bisa ditandatangani.";
const BROKEN_MESSAGE =
  "PDF ini rusak atau formatnya tidak didukung, jadi Mira tidak bisa menambahkan tanda tangan. Simpan ulang dari aplikasi asalnya, lalu coba lagi.";

function mentionsEncrypt(bytes: Uint8Array): boolean {
  // Kamus /Encrypt ada di trailer, dekat akhir file.
  const tail = bytes.subarray(Math.max(0, bytes.length - 4096));
  return new TextDecoder("latin1").decode(tail).includes("/Encrypt");
}

async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  if (!looksLikePdf(bytes)) throw new Error(NOT_PDF_MESSAGE);
  let doc: PDFDocument;
  try {
    // ignoreEncryption hanya agar enkripsi bisa dideteksi sendiri lalu ditolak di bawah.
    doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
    doc.getPageCount(); // memastikan katalog dan pohon halaman terbaca
  } catch {
    if (mentionsEncrypt(bytes)) throw new Error(ENCRYPTED_MESSAGE);
    throw new Error(BROKEN_MESSAGE);
  }
  if (doc.isEncrypted) throw new Error(ENCRYPTED_MESSAGE);
  return doc;
}

/**
 * Pemeriksaan sebelum permintaan dibuat: PDF harus bisa dimuat pdf-lib dan
 * tidak terenkripsi, karena stempel nanti dikerjakan pdf-lib. Tanpa ini,
 * kegagalan baru ketahuan setelah PIN dimasukkan. Melempar AppError
 * `pdf_invalid` berpesan Indonesia.
 */
export async function checkSignablePdf(bytes: Uint8Array): Promise<void> {
  try {
    await loadPdf(bytes);
    // Stempel ditulis sebagai incremental update, jadi ujung file harus terbaca.
    if (!readXrefTail(bytes)) throw new Error(BROKEN_MESSAGE);
  } catch (err) {
    const message = err instanceof Error ? err.message : BROKEN_MESSAGE;
    throw { code: "pdf_invalid", message } satisfies AppError;
  }
}

function assertDocTag(docTag: string): void {
  if (!/^[\x21-\x7e]+$/.test(docTag) || /[()\\]/.test(docTag)) {
    throw new Error("Kode dokumen tidak valid.");
  }
}

function infoDict(doc: PDFDocument): PDFDict {
  const existing = doc.context.lookup(doc.context.trailerInfo.Info);
  if (existing instanceof PDFDict) return existing;
  const created = doc.context.obj({});
  doc.context.trailerInfo.Info = doc.context.register(created);
  return created;
}

function escapeLiteral(text: string): string {
  return text.replace(/[\\()]/g, (c) => `\\${c}`);
}

function textObject(text: string): PDFString | PDFHexString {
  // Literal ASCII supaya kata kunci terbaca langsung di byte file; UTF-16 kalau perlu.
  return /^[\x20-\x7e]*$/.test(text)
    ? PDFString.of(escapeLiteral(text))
    : PDFHexString.fromText(text);
}

function validDate(at: string): Date {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/**
 * Kata kunci lama dipertahankan, kode `mira-doc:` lain dibuang supaya hanya
 * ada satu kode dokumen, lalu `docTag` ditambahkan.
 */
function applyMetadata(doc: PDFDocument, docTag: string, modifiedAt: Date): void {
  const old = (doc.getKeywords() ?? "").replace(DOC_TAG_PATTERN, " ");
  const keywords = `${old.replace(/\s+/g, " ").trim()} ${docTag}`.trim();
  const info = infoDict(doc);
  info.set(PDFName.of("Keywords"), textObject(keywords));
  info.set(PDFName.of(INFO_DOC_TAG_KEY), PDFString.of(docTag));
  doc.setProducer(PRODUCER);
  doc.setModificationDate(modifiedAt);
}

// ---------------------------------------------------------------------------
// Incremental update
//
// Versi bertanda tangan = byte versi lama apa adanya + objek baru dan objek
// yang berubah + tabel xref klasik + trailer dengan /Prev ke startxref lama.
// Inti Rust (`signing::increment::check_increment`) memeriksa bahwa tambahan
// itu hanya stempel. Tidak pernah memakai object stream di bagian tambahan.

const latin1 = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes);
const ascii = (text: string) => new TextEncoder().encode(text);

type XrefTail = {
  /** Nilai `startxref` terakhir: offset tabel xref atau xref stream terbaru. */
  startxref: number;
  /** Nomor objek pertama yang pasti belum dipakai versi lama. */
  firstFree: number;
};

/**
 * Membaca ujung file seperti pembaca PDF: `startxref` terakhir harus
 * menunjuk tepat ke `xref` atau ke `n g obj` (xref stream). Nomor objek baru
 * dimulai di atas /Size dan di atas semua `n g obj` di file, termasuk object
 * stream dan xref stream yang tidak disimpan pdf-lib di konteksnya.
 */
function readXrefTail(bytes: Uint8Array): XrefTail | null {
  const text = latin1(bytes);
  const at = text.lastIndexOf("startxref");
  if (at < 0) return null;
  const m = /^startxref\s*(\d+)/.exec(text.slice(at, at + 40));
  if (!m) return null;
  const startxref = Number(m[1]);
  if (!Number.isSafeInteger(startxref) || startxref >= bytes.length) return null;

  const head = text.slice(startxref, startxref + 64);
  let dictText: string;
  if (head.startsWith("xref")) {
    const trailerAt = text.indexOf("trailer", startxref);
    if (trailerAt < 0) return null;
    dictText = text.slice(trailerAt, text.indexOf("startxref", trailerAt) >>> 0);
  } else if (/^\d+\s+\d+\s+obj\b/.test(head)) {
    const streamAt = text.indexOf("stream", startxref);
    dictText = text.slice(startxref, streamAt < 0 ? undefined : streamAt);
  } else {
    return null;
  }
  const size = Number(/\/Size\s+(\d+)/.exec(dictText)?.[1] ?? 0);

  let maxObject = 0;
  for (const hit of text.matchAll(/(\d+)\s+\d+\s+obj\b/g)) {
    // Batas 10 juta: angka lebih besar hanya kebetulan di data biner.
    const n = Number(hit[1]);
    if (n > maxObject && n < 10_000_000) maxObject = n;
  }
  return { startxref, firstFree: Math.max(size, maxObject + 1) };
}

type Snapshot = Map<string, { bytes: Uint8Array; contents?: Uint8Array }>;

const refKey = (ref: PDFRef) => `${ref.objectNumber} ${ref.generationNumber}`;

function serialize(obj: PDFObject): Uint8Array {
  const out = new Uint8Array(obj.sizeInBytes());
  obj.copyBytesInto(out, 0);
  return out;
}

function snapshotEntry(obj: PDFObject): { bytes: Uint8Array; contents?: Uint8Array } {
  // Stream mentah dari file: isi dibandingkan lewat referensi array-nya,
  // supaya gambar besar tidak disalin.
  if (obj instanceof PDFRawStream) return { bytes: serialize(obj.dict), contents: obj.contents };
  return { bytes: serialize(obj) };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function takeSnapshot(doc: PDFDocument): Snapshot {
  const snap: Snapshot = new Map();
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    snap.set(refKey(ref), snapshotEntry(obj));
  }
  return snap;
}

function unchanged(before: Snapshot, ref: PDFRef, obj: PDFObject): boolean {
  const prev = before.get(refKey(ref));
  if (!prev) return false;
  const now = snapshotEntry(obj);
  if (!sameBytes(prev.bytes, now.bytes)) return false;
  if (prev.contents || now.contents) {
    return !!prev.contents && !!now.contents && sameBytes(prev.contents, now.contents);
  }
  return true;
}

/** Dokumen yang dimuat untuk ditambah, dengan keadaan awalnya. */
type Editable = {
  doc: PDFDocument;
  original: Uint8Array;
  tail: XrefTail;
  before: Snapshot;
};

async function openForIncrement(bytes: Uint8Array): Promise<Editable> {
  const doc = await loadPdf(bytes);
  const tail = readXrefTail(bytes);
  if (!tail) throw new Error(BROKEN_MESSAGE);
  // Nomor objek baru tidak boleh memakai ulang nomor lama mana pun.
  doc.context.largestObjectNumber = Math.max(doc.context.largestObjectNumber, tail.firstFree - 1);
  return { doc, original: bytes, tail, before: takeSnapshot(doc) };
}

async function saveIncrement({ doc, original, tail, before }: Editable): Promise<Uint8Array> {
  await doc.flush();
  const chunks: Uint8Array[] = [original];
  let length = original.length;
  const push = (chunk: Uint8Array) => {
    chunks.push(chunk);
    length += chunk.length;
  };
  const last = original[original.length - 1];
  if (last !== 0x0a && last !== 0x0d) push(ascii("\n"));

  const offsets: { num: number; gen: number; offset: number }[] = [];
  let maxNum = tail.firstFree - 1;
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (ref.objectNumber === 0 || unchanged(before, ref, obj)) continue;
    offsets.push({ num: ref.objectNumber, gen: ref.generationNumber, offset: length });
    maxNum = Math.max(maxNum, ref.objectNumber);
    push(ascii(`${ref.objectNumber} ${ref.generationNumber} obj\n`));
    push(serialize(obj));
    push(ascii("\nendobj\n"));
  }

  const xrefAt = length;
  let xref = "xref\n";
  offsets.sort((a, b) => a.num - b.num);
  for (let i = 0; i < offsets.length; ) {
    let j = i + 1;
    while (j < offsets.length && offsets[j].num === offsets[j - 1].num + 1) j++;
    xref += `${offsets[i].num} ${j - i}\n`;
    for (const e of offsets.slice(i, j)) {
      xref += `${String(e.offset).padStart(10, "0")} ${String(e.gen).padStart(5, "0")} n\r\n`;
    }
    i = j;
  }
  push(ascii(`${xref}trailer\n`));

  const { Root, Info, ID } = doc.context.trailerInfo;
  const trailer = doc.context.obj({
    Size: Math.max(maxNum + 1, doc.context.largestObjectNumber + 1),
    Root,
    Info,
    ID,
    Prev: tail.startxref,
  });
  push(serialize(trailer));
  push(ascii(`\nstartxref\n${xrefAt}\n%%EOF\n`));

  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Geometri: bingkai "visual" di dalam persegi userspace

type Vec = { x: number; y: number };

/**
 * Bingkai visual sebuah persegi pada halaman berotasi: titik (u, v) dengan u ke
 * kanan dan v ke atas menurut pembaca dipetakan ke userspace.
 */
type Frame = {
  angle: 0 | 90 | 180 | 270;
  origin: Vec;
  ex: Vec;
  ey: Vec;
  width: number;
  height: number;
};

/** Sama dengan pdf.js: /Rotate yang bukan kelipatan 90 dianggap 0. */
export function normalizeAngle(angle: number): 0 | 90 | 180 | 270 {
  if (!Number.isFinite(angle) || angle % 90 !== 0) return 0;
  return (((angle % 360) + 360) % 360) as 0 | 90 | 180 | 270;
}

function frameFor(rect: PdfRect, angle: 0 | 90 | 180 | 270): Frame {
  const x0 = rect.x;
  const y0 = rect.y;
  const x1 = rect.x + rect.width;
  const y1 = rect.y + rect.height;
  // /Rotate memutar tampilan searah jarum jam, jadi isi diputar berlawanan arah
  // jarum jam dengan sudut yang sama agar tegak.
  switch (angle) {
    case 0:
      return { angle, origin: { x: x0, y: y0 }, ex: { x: 1, y: 0 }, ey: { x: 0, y: 1 }, width: rect.width, height: rect.height };
    case 90:
      return { angle, origin: { x: x1, y: y0 }, ex: { x: 0, y: 1 }, ey: { x: -1, y: 0 }, width: rect.height, height: rect.width };
    case 180:
      return { angle, origin: { x: x1, y: y1 }, ex: { x: -1, y: 0 }, ey: { x: 0, y: -1 }, width: rect.width, height: rect.height };
    case 270:
      return { angle, origin: { x: x0, y: y1 }, ex: { x: 0, y: -1 }, ey: { x: 1, y: 0 }, width: rect.height, height: rect.width };
  }
}

function toUser(f: Frame, u: number, v: number): Vec {
  return { x: f.origin.x + u * f.ex.x + v * f.ey.x, y: f.origin.y + u * f.ex.y + v * f.ey.y };
}

function toVisual(f: Frame, p: Vec): { u: number; v: number } {
  const dx = p.x - f.origin.x;
  const dy = p.y - f.origin.y;
  return { u: dx * f.ex.x + dy * f.ex.y, v: dx * f.ey.x + dy * f.ey.y };
}

/** Batas halaman yang terlihat (CropBox) dalam koordinat visual bingkai. */
function visibleBounds(page: PDFPage, f: Frame) {
  const box = page.getCropBox();
  const corners = [
    toVisual(f, { x: box.x, y: box.y }),
    toVisual(f, { x: box.x + box.width, y: box.y }),
    toVisual(f, { x: box.x, y: box.y + box.height }),
    toVisual(f, { x: box.x + box.width, y: box.y + box.height }),
  ];
  return {
    uMin: Math.min(...corners.map((c) => c.u)),
    uMax: Math.max(...corners.map((c) => c.u)),
    vMin: Math.min(...corners.map((c) => c.v)),
    vMax: Math.max(...corners.map((c) => c.v)),
  };
}

/**
 * Membungkus isi halaman lama dengan q ... Q, supaya matriks transformasi yang
 * tidak dipulihkan oleh isi lama tidak menggeser stempel.
 */
function isolateExistingContent(doc: PDFDocument, page: PDFPage): void {
  page.node.normalize();
  const start = doc.context.register(doc.context.contentStream([pushGraphicsState()]));
  const end = doc.context.register(doc.context.contentStream([popGraphicsState()]));
  page.node.wrapContentStreams(start, end);
}

// ---------------------------------------------------------------------------
// Stempel
//
// Inti Rust (`signing::increment`) menolak stempel yang bisa menutup isi
// dokumen: gambar harus berlatar transparan (rata-rata alpha paling besar
// 0,5, tanpa piksel terang yang legap), keterangan paling banyak 120 huruf
// Helvetica atau Courier sampai 12 pt, dan gambar beserta keterangannya muat
// dalam satu persegi seluas paling besar 15% MediaBox (atau 20.000 pt
// persegi). Batas di sini sedikit lebih ketat supaya stempel sah selalu lolos.

const CAPTION_MIN_SIZE = 6;
const CAPTION_MAX_SIZE = 10;
const PAGE_MARGIN = 2;
/** Nama dan waktu bersama paling banyak sekian huruf (inti: 120 per halaman). */
const CAPTION_MAX_GLYPHS = 100;
/** Persegi gambar dan keterangan paling luas sekian dari MediaBox (inti: 15%). */
const STAMP_MAX_AREA_FRACTION = 0.12;
/** Luas yang selalu boleh untuk halaman kecil, pt persegi (inti: 20.000). */
const STAMP_MIN_AREA = 16_000;
// Perkiraan tinta huruf di sekitar lebarnya (em), sama dengan inti.
const GLYPH_PAD_X = 0.2;
const GLYPH_BOTTOM = -0.3;
const GLYPH_TOP = 1.0;
/** Batas rata-rata alpha gambar tanda tangan, sama dengan inti. */
export const SIGNATURE_MAX_MEAN_ALPHA = 0.5;
// Piksel penutup: alpha >= 128 dan kecerahan >= 216 (dari 255), sama dengan inti.
const COVER_MIN_ALPHA = 128;
const COVER_MIN_LUMA = 216;

const IMAGE_NOT_TRANSPARENT_MESSAGE =
  "Gambar tanda tangan ini tidak berlatar transparan, jadi bisa menutup tulisan di dokumen. Gambar ulang tanda tangan, atau impor foto tanda tangan di atas kertas putih.";
const IMAGE_DENSE_MESSAGE =
  "Lebih dari separuh gambar tanda tangan ini tertutup tinta, jadi bisa menutup tulisan di dokumen. Gambar ulang dengan goresan yang lebih tipis, atau impor foto tanda tangan di atas kertas putih.";
const IMAGE_COVER_MESSAGE =
  "Gambar tanda tangan ini punya bagian putih yang tidak transparan, jadi bisa menutup tulisan di dokumen. Gambar ulang tanda tangan, atau impor foto tanda tangan di atas kertas putih.";

/** Ukuran huruf keterangan: seperenam belas lebar kotak, dibatasi 6 sampai 10 pt. */
export function captionFontSize(boxWidth: number): number {
  return Math.min(CAPTION_MAX_SIZE, Math.max(CAPTION_MIN_SIZE, boxWidth / 16));
}

/**
 * Pesan kalau gambar tanda tangan akan ditolak inti Rust, atau null.
 * `rgb` 3 byte per piksel, `alpha` 1 byte per piksel (SMask; null kalau tidak ada).
 */
export function signatureImageProblem(rgb: Uint8Array, alpha: Uint8Array | null, pixels: number): string | null {
  if (!alpha || pixels <= 0 || alpha.length < pixels || rgb.length < pixels * 3) {
    return IMAGE_NOT_TRANSPARENT_MESSAGE;
  }
  let sum = 0;
  let cover = 0;
  for (let i = 0; i < pixels; i++) {
    const a = alpha[i];
    sum += a;
    if (a >= COVER_MIN_ALPHA) {
      const luma = Math.floor((299 * rgb[3 * i] + 587 * rgb[3 * i + 1] + 114 * rgb[3 * i + 2]) / 1000);
      if (luma >= COVER_MIN_LUMA) cover++;
    }
  }
  if (sum / (pixels * 255) > SIGNATURE_MAX_MEAN_ALPHA + 1e-6) return IMAGE_DENSE_MESSAGE;
  if (cover > 0) return IMAGE_COVER_MESSAGE;
  return null;
}

/** Memeriksa gambar seperti yang ditulis pdf-lib ke PDF (RGB dan SMask). */
async function checkSignatureImage(doc: PDFDocument, image: PDFImage): Promise<void> {
  await image.embed();
  const xobject = doc.context.lookup(image.ref);
  if (!(xobject instanceof PDFRawStream)) throw new Error(IMAGE_NOT_TRANSPARENT_MESSAGE);
  const maskRef = xobject.dict.get(PDFName.of("SMask"));
  const mask = maskRef ? doc.context.lookup(maskRef) : undefined;
  const rgb = decodePDFRawStream(xobject).decode();
  const alpha = mask instanceof PDFRawStream ? decodePDFRawStream(mask).decode() : null;
  const problem = signatureImageProblem(rgb, alpha, image.width * image.height);
  if (problem) throw new Error(problem);
}

function fitText(font: PDFFont, text: string, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  const chars = Array.from(text);
  while (chars.length > 1 && font.widthOfTextAtSize(`${chars.join("")}...`, size) > maxWidth) {
    chars.pop();
  }
  return `${chars.join("").trimEnd()}...`;
}

/** Nama dipotong supaya nama dan waktu bersama paling banyak CAPTION_MAX_GLYPHS huruf. */
function capCaptionName(name: string, when: string): string {
  const room = CAPTION_MAX_GLYPHS - when.length - 2;
  const chars = Array.from(name);
  if (chars.length <= room) return name;
  return `${chars.slice(0, Math.max(1, room - 3)).join("").trimEnd()}...`;
}

/** Lebar tanpa kerning, seperti teks yang benar-benar digambar `Tj`. */
function drawnWidth(font: PDFFont, text: string, size: number): number {
  let w = 0;
  for (const ch of text) w += font.widthOfTextAtSize(ch, size);
  return w;
}

function assertPlacement(doc: PDFDocument, p: PdfRect): PDFPage {
  const count = doc.getPageCount();
  if (!Number.isInteger(p.pageIndex) || p.pageIndex < 0 || p.pageIndex >= count) {
    throw new Error(`Halaman ${p.pageIndex + 1} tidak ada di PDF ini (jumlah halaman ${count}).`);
  }
  const nums = [p.x, p.y, p.width, p.height];
  if (nums.some((n) => !Number.isFinite(n)) || p.width <= 0 || p.height <= 0) {
    throw new Error("Posisi tanda tangan tidak valid.");
  }
  return doc.getPage(p.pageIndex);
}

type CaptionLine = { text: string; u: number; v: number; width: number };

/** Letak gambar dan keterangan di bingkai visual kotak. */
type StampLayout = {
  frame: Frame;
  image: { u: number; v: number; width: number; height: number };
  size: number;
  lines: CaptionLine[];
};

function layoutStamp(
  page: PDFPage,
  rect: PdfRect,
  angle: 0 | 90 | 180 | 270,
  image: { width: number; height: number },
  font: PDFFont,
  name: string,
  when: string,
): StampLayout {
  const frame = frameFor(rect, angle);

  // Gambar mengisi kotak dengan rasio tetap, di tengah.
  const scale = Math.min(frame.width / image.width, frame.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;

  // Keterangan: nama dan waktu, di bawah kotak (atau di atas kalau tidak muat).
  // Paling lebar selebar kotak, atau selebar baris waktu kalau kotaknya lebih
  // sempit, supaya tetap menempel pada gambar.
  const bounds = visibleBounds(page, frame);
  const size = captionFontSize(frame.width);
  const lineHeight = size * 1.2;
  const gap = size * 0.4;
  const ascent = font.heightAtSize(size, { descender: false });
  const descent = font.heightAtSize(size) - ascent;
  const pageWidth = Math.max(size * 4, bounds.uMax - bounds.uMin - 2 * PAGE_MARGIN);
  const maxWidth = Math.min(pageWidth, Math.max(frame.width, font.widthOfTextAtSize(when, size)));

  const oneLine = name ? `${name}, ${when}` : when;
  const texts =
    font.widthOfTextAtSize(oneLine, size) <= frame.width || !name
      ? [oneLine]
      : [name, when];
  const fitted = texts.map((l) => fitText(font, l, size, maxWidth));
  const blockHeight = ascent + descent + (fitted.length - 1) * lineHeight;

  let firstBaseline: number;
  const belowBottom = -gap - blockHeight;
  const aboveTop = frame.height + gap + blockHeight;
  if (belowBottom >= bounds.vMin + PAGE_MARGIN) {
    firstBaseline = -gap - ascent;
  } else if (aboveTop <= bounds.vMax - PAGE_MARGIN) {
    firstBaseline = frame.height + gap + descent + (fitted.length - 1) * lineHeight;
  } else {
    // Halaman terlalu sempit di kedua sisi: tempel ke tepi bawah yang terlihat.
    firstBaseline = bounds.vMin + PAGE_MARGIN + descent + (fitted.length - 1) * lineHeight;
  }

  const lines = fitted.map((text, i) => {
    const w = font.widthOfTextAtSize(text, size);
    let u = (frame.width - w) / 2;
    u = Math.min(u, bounds.uMax - PAGE_MARGIN - w);
    u = Math.max(u, bounds.uMin + PAGE_MARGIN);
    return { text, u, v: firstBaseline - i * lineHeight, width: drawnWidth(font, text, size) };
  });
  return {
    frame,
    image: { u: (frame.width - width) / 2, v: (frame.height - height) / 2, width, height },
    size,
    lines,
  };
}

/** Luas persegi yang memuat gambar dan kotak tinta keterangan, seperti dihitung inti. */
function stampArea({ image, size, lines }: StampLayout): number {
  let u0 = image.u;
  let v0 = image.v;
  let u1 = image.u + image.width;
  let v1 = image.v + image.height;
  for (const l of lines) {
    u0 = Math.min(u0, l.u - GLYPH_PAD_X * size);
    u1 = Math.max(u1, l.u + l.width + GLYPH_PAD_X * size);
    v0 = Math.min(v0, l.v + GLYPH_BOTTOM * size);
    v1 = Math.max(v1, l.v + GLYPH_TOP * size);
  }
  return (u1 - u0) * (v1 - v0);
}

/** Persegi diperkecil dengan titik tengah tetap. */
function shrinkRect(r: PdfRect, factor: number): PdfRect {
  const width = r.width * factor;
  const height = r.height * factor;
  return { ...r, x: r.x + (r.width - width) / 2, y: r.y + (r.height - height) / 2, width, height };
}

export async function stampSignature(pdf: Uint8Array, opts: StampOptions): Promise<Uint8Array> {
  assertDocTag(opts.docTag);
  const editable = await openForIncrement(pdf);
  const { doc } = editable;
  const page = assertPlacement(doc, opts.placement);
  // normalize() pdf-lib menambah /Annots kosong; dikembalikan supaya hanya
  // /Contents dan /Resources halaman yang berubah.
  const annots = page.node.get(PDFName.Annots);

  let image: PDFImage;
  try {
    image = await doc.embedPng(opts.png);
  } catch {
    throw new Error("Gambar tanda tangan tidak bisa dibaca.");
  }
  await checkSignatureImage(doc, image);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const when = toWinAnsiSafe(formatSignedAt(opts.signedAt, opts.timeZone));
  const name = capCaptionName(toWinAnsiSafe(opts.signerName), when);
  const angle = normalizeAngle(page.getRotation().angle);

  // Kotak yang sangat besar diperkecil (titik tengah tetap) sampai gambar dan
  // keterangan muat dalam batas luas stempel.
  const media = page.getMediaBox();
  const budget = Math.max(STAMP_MAX_AREA_FRACTION * Math.abs(media.width * media.height), STAMP_MIN_AREA);
  let rect = opts.placement;
  let layout = layoutStamp(page, rect, angle, image, font, name, when);
  for (let i = 0; i < 8 && stampArea(layout) > budget; i++) {
    rect = shrinkRect(rect, Math.sqrt(budget / stampArea(layout)) * 0.98);
    layout = layoutStamp(page, rect, angle, image, font, name, when);
  }

  const { frame, size } = layout;
  const rotate = degrees(frame.angle);
  isolateExistingContent(doc, page);

  const imgOrigin = toUser(frame, layout.image.u, layout.image.v);
  page.drawImage(image, {
    x: imgOrigin.x,
    y: imgOrigin.y,
    width: layout.image.width,
    height: layout.image.height,
    rotate,
  });
  for (const line of layout.lines) {
    const p = toUser(frame, line.u, line.v);
    page.drawText(line.text, { x: p.x, y: p.y, size, font, color: INK, rotate });
  }

  if (annots === undefined) page.node.delete(PDFName.Annots);
  else page.node.set(PDFName.Annots, annots);

  applyMetadata(doc, opts.docTag, validDate(opts.signedAt));
  return saveIncrement(editable);
}

// ---------------------------------------------------------------------------
// Halaman catatan

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const fits = (s: string) => font.widthOfTextAtSize(s, size) <= maxWidth;
  const lines: string[] = [];
  let current = "";
  const pushWord = (word: string) => {
    // Kata yang lebih lebar dari kolom dipotong per karakter.
    let piece = "";
    for (const ch of word) {
      if (piece && !fits(piece + ch)) {
        lines.push(piece);
        piece = ch;
      } else {
        piece += ch;
      }
    }
    current = piece;
  };
  for (const word of text.split(" ").filter(Boolean)) {
    if (!current) {
      pushWord(word);
    } else if (fits(`${current} ${word}`)) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      pushWord(word);
    }
  }
  if (current || lines.length === 0) lines.push(current);
  return lines;
}

const A4 = PageSizes.A4;
const MARGIN = 56;

type Fonts = { regular: PDFFont; bold: PDFFont; mono: PDFFont };

type Column = { header: string; width: number };

const COLUMNS: Column[] = [
  { header: "No", width: 24 },
  { header: "Nama", width: 108 },
  { header: "Peran", width: 52 },
  { header: "Waktu", width: 138 },
  { header: "Sidik jari kunci", width: 0 },
];

export async function appendAuditPage(pdf: Uint8Array, info: AuditInfo): Promise<Uint8Array> {
  assertDocTag(info.docTag);
  const editable = await openForIncrement(pdf);
  const { doc } = editable;
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    mono: await doc.embedFont(StandardFonts.Courier),
  };

  const contentWidth = A4[0] - 2 * MARGIN;
  const columns = COLUMNS.map((c) => ({ ...c }));
  columns[columns.length - 1].width =
    contentWidth - columns.slice(0, -1).reduce((sum, c) => sum + c.width, 0);

  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;
  const newPage = () => {
    page = doc.addPage(A4);
    pages.push(page);
    y = A4[1] - MARGIN;
  };
  const bottomLimit = MARGIN + 24; // ruang untuk kaki halaman
  const ensure = (height: number) => {
    if (y - height < bottomLimit) {
      newPage();
      return true;
    }
    return false;
  };

  const drawLines = (lines: string[], x: number, font: PDFFont, size: number, color = INK) => {
    const lh = size * 1.35;
    lines.forEach((line, i) => {
      page.drawText(line, { x, y: y - size - i * lh, size, font, color });
    });
    return lines.length * lh;
  };

  newPage();

  // Judul
  page.drawText("Halaman catatan tanda tangan", {
    x: MARGIN,
    y: y - 18,
    size: 18,
    font: fonts.bold,
    color: INK,
  });
  y -= 18 + 22;

  // Ringkasan dokumen: label di kiri, isi di kanan.
  const labelWidth = 132;
  const valueX = MARGIN + labelWidth;
  const valueWidth = contentWidth - labelWidth;
  const field = (label: string, value: string, mono = false) => {
    const font = mono ? fonts.mono : fonts.regular;
    const size = mono ? 9 : 10;
    const lines = wrapText(toWinAnsiSafe(value), font, size, valueWidth);
    const height = lines.length * size * 1.35;
    ensure(height + 6);
    drawLines([label], MARGIN, fonts.bold, 10);
    // Sejajarkan garis dasar isi monospace dengan label.
    const saved = y;
    y -= mono ? 0.8 : 0;
    drawLines(lines, valueX, font, size);
    y = saved - Math.max(height, 10 * 1.35) - 6;
  };

  field("Dokumen", info.title || "Tanpa judul");
  field("Kode dokumen", info.docTag, true);
  field("Hash file asli (BLAKE3)", info.originalHash, true);
  field("Urutan", info.mode === "sequential" ? "Berurutan" : "Bebas");
  field("Catatan dibuat", formatSignedAt(info.generatedAt, info.timeZone));

  y -= 10;

  // Tabel penanda tangan
  const tableHeaderHeight = 10 * 1.35 + 8;
  const drawTableHeader = () => {
    let x = MARGIN;
    for (const col of columns) {
      page.drawText(col.header, { x, y: y - 10, size: 9, font: fonts.bold, color: INK });
      x += col.width;
    }
    y -= tableHeaderHeight - 4;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: MARGIN + contentWidth, y },
      thickness: 0.8,
      color: INK_SOFT,
    });
    y -= 4;
  };

  ensure(14 + tableHeaderHeight + 30);
  drawLines(["Penanda tangan"], MARGIN, fonts.bold, 12);
  y -= 12 * 1.35 + 4;
  drawTableHeader();

  const cellPad = 6;
  const rowSize = 9;
  const rowLh = rowSize * 1.35;
  if (info.signers.length === 0) {
    drawLines(["Belum ada penanda tangan."], MARGIN, fonts.regular, rowSize, INK_SOFT);
    y -= rowLh + cellPad;
  }
  info.signers.forEach((s, i) => {
    const cells: { lines: string[]; font: PDFFont; size: number }[] = [
      { text: String(i + 1), font: fonts.regular },
      { text: s.name || "Tanpa nama", font: fonts.regular },
      { text: s.kind === "guest" ? "Tamu" : "Anggota", font: fonts.regular },
      { text: formatSignedAt(s.signedAt, info.timeZone), font: fonts.regular },
      { text: s.fingerprint, font: fonts.mono },
    ].map((c, ci) => {
      const size = c.font === fonts.mono ? 8 : rowSize;
      return {
        lines: wrapText(toWinAnsiSafe(c.text), c.font, size, columns[ci].width - cellPad),
        font: c.font,
        size,
      };
    });
    const rowHeight = Math.max(...cells.map((c) => c.lines.length)) * rowLh + cellPad;
    if (ensure(rowHeight + 2)) drawTableHeader();
    let x = MARGIN;
    cells.forEach((c, ci) => {
      const saved = y;
      y -= 3;
      c.lines.forEach((line, li) => {
        page.drawText(line, { x, y: y - c.size - li * rowLh, size: c.size, font: c.font, color: INK });
      });
      y = saved;
      x += columns[ci].width;
    });
    y -= rowHeight;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: MARGIN + contentWidth, y },
      thickness: 0.5,
      color: RULE,
    });
  });

  // Catatan penutup
  const note =
    "Tanda tangan di dokumen ini berupa gambar, bukan tanda tangan digital bersertifikat. " +
    "Keaslian file diperiksa di aplikasi Mira: setiap penanda tangan menandatangani hash BLAKE3 " +
    "file dengan kunci laptopnya, lalu Mira mencocokkan hash itu dengan file yang dibuka. " +
    "Kalau file diubah setelah ditandatangani, hash tidak lagi cocok.";
  const noteLines = wrapText(note, fonts.regular, 9, contentWidth);
  y -= 18;
  ensure(noteLines.length * 9 * 1.35);
  drawLines(noteLines, MARGIN, fonts.regular, 9, INK_SOFT);

  // Kaki halaman kalau catatan lebih dari satu halaman: nomor dan kode dokumen.
  if (pages.length > 1) {
    const tag = toWinAnsiSafe(info.docTag);
    pages.forEach((p, i) => {
      const text = `Halaman catatan ${i + 1} dari ${pages.length}  |  ${tag}`;
      p.drawText(text, { x: MARGIN, y: MARGIN - 8, size: 8, font: fonts.regular, color: INK_SOFT });
    });
  }

  applyMetadata(doc, info.docTag, validDate(info.generatedAt));
  return saveIncrement(editable);
}
