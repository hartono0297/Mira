// Stempel tanda tangan dan halaman catatan, dikerjakan pdf-lib di frontend.
//
// Koordinat `PdfRect` adalah userspace PDF absolut (sudah termasuk offset
// MediaBox/CropBox, sumbu y ke atas): persegi sejajar sumbu yang menutupi
// kotak tanda tangan seperti terlihat di layar. Pada halaman ber-/Rotate,
// gambar dan teks digambar berputar searah supaya tampak tegak bagi pembaca.
//
// Semua dokumen disimpan dengan `useObjectStreams: false` dan kode dokumen
// ditulis sebagai string literal ASCII di kamus Info, supaya inti Rust bisa
// menemukan `mira-doc:` cukup dengan memindai byte file.

import {
  PDFDict,
  PDFDocument,
  PDFFont,
  PDFHexString,
  PDFName,
  PDFPage,
  PDFString,
  PageSizes,
  StandardFonts,
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

function savePdf(doc: PDFDocument): Promise<Uint8Array> {
  return doc.save({ useObjectStreams: false });
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

const CAPTION_MIN_SIZE = 6;
const CAPTION_MAX_SIZE = 10;
const PAGE_MARGIN = 2;

/** Ukuran huruf keterangan: seperenam belas lebar kotak, dibatasi 6 sampai 10 pt. */
export function captionFontSize(boxWidth: number): number {
  return Math.min(CAPTION_MAX_SIZE, Math.max(CAPTION_MIN_SIZE, boxWidth / 16));
}

function fitText(font: PDFFont, text: string, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  const chars = Array.from(text);
  while (chars.length > 1 && font.widthOfTextAtSize(`${chars.join("")}...`, size) > maxWidth) {
    chars.pop();
  }
  return `${chars.join("").trimEnd()}...`;
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

export async function stampSignature(pdf: Uint8Array, opts: StampOptions): Promise<Uint8Array> {
  assertDocTag(opts.docTag);
  const doc = await loadPdf(pdf);
  const page = assertPlacement(doc, opts.placement);

  let image;
  try {
    image = await doc.embedPng(opts.png);
  } catch {
    throw new Error("Gambar tanda tangan tidak bisa dibaca.");
  }
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const frame = frameFor(opts.placement, normalizeAngle(page.getRotation().angle));
  const rotate = degrees(frame.angle);
  isolateExistingContent(doc, page);

  // Gambar mengisi kotak dengan rasio tetap, di tengah.
  const scale = Math.min(frame.width / image.width, frame.height / image.height);
  const dw = image.width * scale;
  const dh = image.height * scale;
  const imgOrigin = toUser(frame, (frame.width - dw) / 2, (frame.height - dh) / 2);
  page.drawImage(image, { x: imgOrigin.x, y: imgOrigin.y, width: dw, height: dh, rotate });

  // Keterangan: nama dan waktu, di bawah kotak (atau di atas kalau tidak muat).
  const name = toWinAnsiSafe(opts.signerName);
  const when = toWinAnsiSafe(formatSignedAt(opts.signedAt, opts.timeZone));
  const bounds = visibleBounds(page, frame);
  const size = captionFontSize(frame.width);
  const lineHeight = size * 1.2;
  const gap = size * 0.4;
  const ascent = font.heightAtSize(size, { descender: false });
  const descent = font.heightAtSize(size) - ascent;
  const maxWidth = Math.max(size * 4, bounds.uMax - bounds.uMin - 2 * PAGE_MARGIN);

  const oneLine = name ? `${name}, ${when}` : when;
  const lines =
    font.widthOfTextAtSize(oneLine, size) <= frame.width || !name
      ? [oneLine]
      : [name, when];
  const fitted = lines.map((l) => fitText(font, l, size, maxWidth));
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

  fitted.forEach((line, i) => {
    const w = font.widthOfTextAtSize(line, size);
    let u = (frame.width - w) / 2;
    u = Math.min(u, bounds.uMax - PAGE_MARGIN - w);
    u = Math.max(u, bounds.uMin + PAGE_MARGIN);
    const p = toUser(frame, u, firstBaseline - i * lineHeight);
    page.drawText(line, { x: p.x, y: p.y, size, font, color: INK, rotate });
  });

  applyMetadata(doc, opts.docTag, validDate(opts.signedAt));
  return savePdf(doc);
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
  const doc = await loadPdf(pdf);
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
  return savePdf(doc);
}
