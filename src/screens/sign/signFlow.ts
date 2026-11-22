// Alur menandatangani setelah PIN dimasukkan: buka tanda tangan tersimpan,
// stempel ke PDF, tambah halaman catatan kalau ini penanda tangan terakhir,
// lalu kirim ke inti Rust. Dipisah dari layar supaya bisa dites tanpa React.

import { isAppError, type AppError } from "../../api";
import type { RequestDetail, SignerView, Unlocked } from "../../api/signing";
import { clampCss, cssRectToPdf, displaySize, pdfRectToCss } from "../../components/pdf/coords";
import type { CssRect, PageGeometry } from "../../components/pdf/types";
import { appendAuditPage, stampSignature, type AuditSigner, type PdfRect } from "./stamp";

// ---------------------------------------------------------------------------
// Penempatan kotak tanda tangan
//
// Semua hitungan dikerjakan di "ruang tampak" skala 1: px CSS halaman pada zoom
// 100%, yang sama dengan poin PDF tetapi sudah mengikuti rotasi halaman. Rasio
// kotak di ruang tampak selalu rasio gambar tanda tangan, karena stempel
// menggambar gambar tegak seperti yang dilihat pembaca.

export const BOX_WIDTH_PT = 160;
export const BOX_MIN_WIDTH_PT = 60;
export const PAGE_MARGIN_PT = 36;
export const SIZE_STEP_PT = 20;

export type QuickSpot = "left" | "center" | "right";

function visual(rect: PdfRect, page: PageGeometry): CssRect {
  return pdfRectToCss(rect, page, 1);
}

function fromVisual(css: CssRect, page: PageGeometry): PdfRect {
  return cssRectToPdf(clampCss(css, displaySize(page, 1)), page, 1);
}

function widthLimit(page: PageGeometry, aspect: number): number {
  const size = displaySize(page, 1);
  return Math.max(BOX_MIN_WIDTH_PT, Math.min(size.width - 2 * PAGE_MARGIN_PT, (size.height - 2 * PAGE_MARGIN_PT) * aspect));
}

function fitWidth(width: number, page: PageGeometry, aspect: number): number {
  return Math.min(Math.max(width, BOX_MIN_WIDTH_PT), widthLimit(page, aspect));
}

// Kotak di bawah halaman: kiri, tengah, atau kanan, dengan jarak tepi 36 pt.
export function quickPlacement(page: PageGeometry, aspect: number, spot: QuickSpot, widthPt = BOX_WIDTH_PT): PdfRect {
  const size = displaySize(page, 1);
  const width = fitWidth(widthPt, page, aspect);
  const height = width / aspect;
  const left =
    spot === "left" ? PAGE_MARGIN_PT : spot === "center" ? (size.width - width) / 2 : size.width - PAGE_MARGIN_PT - width;
  return fromVisual({ left, top: size.height - PAGE_MARGIN_PT - height, width, height }, page);
}

// Perbesar atau perkecil dengan titik tengah tetap, lalu jepit ke halaman.
export function resizePlacement(rect: PdfRect, page: PageGeometry, aspect: number, deltaPt: number): PdfRect {
  const v = visual(rect, page);
  const width = fitWidth(v.width + deltaPt, page, aspect);
  const height = width / aspect;
  const cx = v.left + v.width / 2;
  const cy = v.top + v.height / 2;
  return fromVisual({ left: cx - width / 2, top: cy - height / 2, width, height }, page);
}

// Pindah ke halaman lain dengan posisi relatif yang sama.
export function movePlacement(rect: PdfRect, from: PageGeometry, to: PageGeometry, aspect: number): PdfRect {
  const v = visual(rect, from);
  const a = displaySize(from, 1);
  const b = displaySize(to, 1);
  const width = fitWidth(v.width, to, aspect);
  const height = width / aspect;
  const cx = ((v.left + v.width / 2) / a.width) * b.width;
  const cy = ((v.top + v.height / 2) / a.height) * b.height;
  return fromVisual({ left: cx - width / 2, top: cy - height / 2, width, height }, to);
}

export function placementWidthPt(rect: PdfRect, page: PageGeometry): number {
  return visual(rect, page).width;
}

// Jarak tepi kiri dan bawah kotak ke tepi halaman seperti terlihat, dibulatkan ke poin.
export function placementOffsetsPt(rect: PdfRect, page: PageGeometry): { left: number; bottom: number; width: number } {
  const v = visual(rect, page);
  const size = displaySize(page, 1);
  return { left: Math.round(v.left), bottom: Math.round(size.height - v.top - v.height), width: Math.round(v.width) };
}

// "kanan bawah", "tengah atas", "tengah" ... menurut titik tengah kotak.
export function describeSpot(rect: PdfRect, page: PageGeometry): string {
  const v = visual(rect, page);
  const size = displaySize(page, 1);
  const fx = (v.left + v.width / 2) / size.width;
  const fy = (v.top + v.height / 2) / size.height;
  const h = fx < 1 / 3 ? "kiri" : fx > 2 / 3 ? "kanan" : "tengah";
  const vert = fy < 1 / 3 ? "atas" : fy > 2 / 3 ? "bawah" : "tengah";
  if (h === "tengah" && vert === "tengah") return "tengah";
  if (h === "tengah") return `tengah ${vert}`;
  if (vert === "tengah") return `${h} tengah`;
  return `${h} ${vert}`;
}

export type SignFlowApi = {
  unlock: (pin: string) => Promise<Unlocked>;
  complete: (requestId: string, token: string, baseHash: string, signedPdf: Uint8Array) => Promise<RequestDetail>;
};

export type SignFlowInput = {
  pin: string;
  detail: RequestDetail;
  bytes: Uint8Array;
  placement: PdfRect;
  me: { displayName: string };
  api: SignFlowApi;
  // Zona waktu IANA untuk teks waktu di stempel; bawaan zona laptop. Untuk tes.
  timeZone?: string;
};

// Sama dengan identity::fingerprint di inti Rust: 16 hex pertama, huruf besar, per 4.
export function fingerprintOf(publicKey: string): string {
  const head = publicKey.slice(0, 16).toUpperCase();
  return head.match(/.{1,4}/g)?.join(" ") ?? "";
}

function flowError(code: string, prefix: string, err: unknown): AppError {
  if (isAppError(err)) return err;
  const detail = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return { code, message: detail ? `${prefix} ${detail}` : prefix };
}

function auditSigners(signers: SignerView[], mySignedAt: string): AuditSigner[] {
  return [...signers]
    .sort((a, b) => a.position - b.position)
    .map((s) => {
      const signedAt = s.isMe ? mySignedAt : s.signedAt;
      if (!signedAt) {
        throw {
          code: "audit_incomplete",
          message: `${s.displayName} belum tercatat menandatangani, jadi halaman catatan belum bisa dibuat. Muat ulang dokumen lalu coba lagi.`,
        } satisfies AppError;
      }
      return { name: s.displayName, kind: s.kind, signedAt, fingerprint: fingerprintOf(s.publicKey) };
    });
}

// Error dari unlock (PIN salah, terkunci) diteruskan apa adanya supaya PinDialog
// bisa menampilkannya di isian. Error setelah itu selalu berbentuk AppError.
export async function runSignFlow({ pin, detail, bytes, placement, me, api, timeZone }: SignFlowInput): Promise<RequestDetail> {
  const unlocked = await api.unlock(pin);

  let stamped: Uint8Array;
  try {
    stamped = await stampSignature(bytes, {
      placement,
      png: unlocked.png,
      signerName: me.displayName,
      signedAt: unlocked.signedAt,
      docTag: detail.docTag,
      timeZone,
    });
  } catch (err) {
    throw flowError("stamp_failed", "Tanda tangan belum bisa ditempel ke PDF.", err);
  } finally {
    // Gambar tanda tangan hanya perlu ada selama stempel. Kosongkan isinya
    // supaya tidak tertinggal di memori setelah dipakai.
    unlocked.png.fill(0);
    unlocked.png = new Uint8Array(0);
  }

  let finalBytes = stamped;
  if (detail.isLastPending) {
    const signers = auditSigners(detail.signers, unlocked.signedAt);
    try {
      finalBytes = await appendAuditPage(stamped, {
        title: detail.title,
        docTag: detail.docTag,
        originalHash: detail.originalHash,
        mode: detail.mode,
        signers,
        generatedAt: unlocked.signedAt,
        timeZone,
      });
    } catch (err) {
      throw flowError("audit_failed", "Halaman catatan belum bisa ditambahkan.", err);
    }
  }

  try {
    return await api.complete(detail.id, unlocked.token, detail.currentHash, finalBytes);
  } catch (err) {
    throw flowError("save_failed", "PDF bertanda tangan belum tersimpan.", err);
  }
}
