// Label tanda tangan PDF untuk layar daftar dan layar dokumen. Teksnya ada di
// kamus src/i18n/sign.*.ts dan dibaca saat fungsi dipanggil, jadi mengikuti
// bahasa tampilan aktif.

import type { AppError } from "../../api";
import {
  AUTO_COPY_MAX_BYTES,
  type EventKind,
  type Integrity,
  type MyState,
  type RejectedVersion,
  type RequestStatus,
  type RequestSummary,
  type SignErrorCode,
  type SignMode,
  type SignerKind,
} from "../../api/signing";
import { getLang, locale } from "../../i18n/core";
import { SIGN_TEXT as T } from "../../i18n/sign";
import { formatSignedAt, signedAtParts } from "./stamp";

export function myStateLabel(state: MyState): string {
  return T.myState[state];
}

export function statusLabel(status: RequestStatus): string {
  return T.status[status];
}

type StateInput = Pick<RequestSummary, "status" | "myState" | "integrity"> &
  Partial<Pick<RequestSummary, "fileAvailable" | "pending">>;

// Giliran saya DAN file ada dan utuh DAN tidak ada tanda tangan rekan yang
// belum sampai. File yang berubah, hilang, atau belum tersalin tidak bisa
// ditandatangani, dan menandatangani sebelum tanda tangan terbaru rekan sampai
// membuat salah satu versi ditolak. Keduanya tidak dihitung "menunggu tanda
// tangan Anda".
export function isActionable(r: StateInput): boolean {
  return (
    r.status === "in_progress" &&
    r.myState === "your_turn" &&
    r.integrity === "intact" &&
    r.fileAvailable !== false &&
    r.pending !== true
  );
}

// Satu label untuk baris daftar: status akhir menang atas keadaan saya, dan
// giliran saya atas file yang bermasalah bukan lagi "Giliran Anda".
export function requestStateLabel(r: StateInput): string {
  if (r.status !== "in_progress") return statusLabel(r.status);
  if (r.myState === "your_turn" && r.fileAvailable === false) return T.requestState.waitingFile;
  if (r.myState === "your_turn" && r.pending === true) return T.requestState.waitingPeer;
  if (r.myState === "your_turn" && r.integrity !== "intact") return T.requestState.cannotSign;
  if (r.myState === "not_involved") return T.requestState.waitingSigners;
  return myStateLabel(r.myState);
}

// Chip di kepala layar dokumen, mis. "Berjalan, 0 dari 2 sudah tanda tangan".
export function headerStatusLabel(
  r: Pick<RequestSummary, "status" | "signedCount" | "signerCount"> & { sealValid: boolean | null },
): string {
  if (r.status === "in_progress") return T.headerProgress(statusLabel(r.status), r.signedCount, r.signerCount);
  if (r.status === "completed" && r.sealValid !== true) return T.sealInvalid;
  return statusLabel(r.status);
}

export function modeLabel(mode: SignMode): string {
  return mode === "sequential" ? T.mode.sequential : T.mode.parallel;
}

export function modeHint(mode: SignMode): string {
  return mode === "sequential" ? T.modeHint.sequential : T.modeHint.parallel;
}

export function kindLabel(kind: SignerKind): string {
  return kind === "guest" ? T.kind.guest : T.kind.member;
}

// Label tampilan saja; jenis catatan (kind) dan isinya tetap seperti tercatat.
export function eventLabel(kind: string): string {
  const labels: Record<EventKind, string> = T.events;
  return Object.prototype.hasOwnProperty.call(labels, kind) ? labels[kind as EventKind] : T.eventOther(kind);
}

// Tanda tangan tersimpan yang dibuat ulang atau dihapus saat permintaan
// berjalan perlu diperhatikan: bisa jadi orang lain memakai laptop pemiliknya.
export function isSignatureChange(kind: string): boolean {
  return kind === "signature_saved" || kind === "signature_deleted";
}

// Berjalan = dari waktu dibuat sampai catatan selesai atau batal (kalau ada).
// Waktu yang tidak terbaca dianggap di dalam, supaya peringatan tidak hilang.
export function happenedDuringRequest(
  e: { at: string },
  events: { kind: string; at: string }[],
  createdAt: string,
): boolean {
  const at = Date.parse(e.at);
  if (!Number.isFinite(at)) return true;
  const start = Date.parse(createdAt);
  if (Number.isFinite(start) && at < start) return false;
  const ends = events
    .filter((x) => x.kind === "completed" || x.kind === "cancelled")
    .map((x) => Date.parse(x.at))
    .filter(Number.isFinite);
  return ends.length === 0 || at <= Math.min(...ends);
}

export function integrityLabel(integrity: Integrity): string {
  return T.integrity[integrity];
}

export function exportStateLabel(state: Integrity): string {
  return T.exportState[state];
}

export function exportWarningLabel(count: number): string {
  return count > 1 ? T.exportWarningMany(count) : T.exportWarningOne;
}

// File dari laptop rekan yang belum ada di laptop ini, untuk daftar dan layar dokumen:
// - auto: sampai 20 MB, disalin otomatis saat laptop rekan yang menyimpannya tersambung;
// - manual: lebih dari 20 MB atau ukurannya tidak diketahui, diunduh lewat tombol "Unduh file".
// `newer`: file versi terkini ada, tetapi tanda tangan terbaru dari rekan belum sampai.
// `size`: byte yang diunduh, null kalau tidak diketahui.
// `downloading`: laptop ini sedang menyalinnya sekarang.
export type FileNeed = { state: "auto" | "manual"; newer: boolean; size: number | null; downloading: boolean };

type NeedInput = Pick<RequestSummary, "fileAvailable" | "pending" | "fileSize" | "status"> &
  Partial<Pick<RequestSummary, "downloadSize" | "downloading">>;

function neededBytes(r: NeedInput, newer: boolean): number | null {
  if (r.downloadSize === null) return null;
  if (typeof r.downloadSize === "number" && (r.downloadSize > 0 || newer)) return r.downloadSize;
  if (newer) return 0;
  // fileSize 0 berarti ukurannya tidak diketahui, bukan file kecil.
  return r.fileSize > 0 ? r.fileSize : null;
}

export function fileNeed(r: NeedInput): FileNeed | null {
  const missing = r.fileAvailable === false;
  const newer = !missing && r.pending === true;
  if (!missing && !newer) return null;
  // Permintaan yang sudah selesai atau dibatalkan tetap bisa diunduh untuk dibaca.
  const size = neededBytes(r, newer);
  const state = size === null || size > AUTO_COPY_MAX_BYTES ? "manual" : "auto";
  return { state, newer, size, downloading: r.downloading === true };
}

export function fileNeedText(need: FileNeed): string {
  const t = T.fileNeed;
  if (need.downloading) return need.newer ? t.downloadingNewer : t.downloading;
  if (need.state === "auto") return need.newer ? t.autoNewer : t.auto;
  const why = need.size === null ? t.whyUnknown : t.whyLarge;
  if (need.newer) return t.newer(why);
  return need.size === null ? t.unknownSize(why) : t.sized(formatSize(need.size), why);
}

// Teks tombol unduh: ukuran hanya kalau diketahui.
export function downloadLabel(need: FileNeed): string {
  return need.size ? T.downloadSized(formatSize(need.size)) : T.download;
}

// Konfirmasi pembatalan, sama di layar dokumen dan di menu baris daftar.
// Objek kamus hidup: setiap properti dibaca dalam bahasa aktif.
export const CANCEL_CONFIRM = T.cancelConfirm;

// Menu baris di daftar tanda tangan (klik kanan atau tombol "...").
export const ROW_MENU = T.rowMenu;

// Item menu baris: hidden kalau aksinya tidak pernah berlaku untuk permintaan
// ini, atau alasan singkat kalau hanya sementara tidak bisa (null: bisa).
export type RowItem = { hidden: true } | { hidden: false; off: string | null };

// Tandatangani hanya untuk penanda tangan yang belum menandatangani dan
// permintaan yang masih berjalan.
export function rowSignItem(r: StateInput): RowItem {
  if (r.status !== "in_progress") return { hidden: true };
  if (r.myState === "waiting_others") return { hidden: false, off: ROW_MENU.notYourTurn };
  if (r.myState !== "your_turn") return { hidden: true };
  if (r.fileAvailable === false) return { hidden: false, off: ROW_MENU.fileAbsent };
  if (r.integrity !== "intact") return { hidden: false, off: ROW_MENU.fileChanged };
  if (r.pending === true) return { hidden: false, off: ROW_MENU.waitingPeer };
  return { hidden: false, off: null };
}

// Alasan Simpan salinan PDF tidak bisa dijalankan, null kalau bisa. Sama
// dengan aturan tombol di layar dokumen.
export function rowExportOff(r: Pick<RequestSummary, "integrity"> & Partial<Pick<RequestSummary, "fileAvailable">>): string | null {
  if (r.fileAvailable === false) return ROW_MENU.fileAbsent;
  if (r.integrity === "missing") return ROW_MENU.fileMissing;
  if (r.integrity !== "intact") return ROW_MENU.fileChanged;
  return null;
}

// Pesan yang mudah dipahami untuk kode error tanda tangan yang baru. Kode lain
// memakai pesan dari inti Rust apa adanya (call() di src/api memetakannya ke
// bahasa Inggris saat bahasa Inggris aktif).
export function signErrorMessage(error: AppError): string {
  switch (error.code as SignErrorCode | string) {
    case "version_not_prefix":
      return T.signError.version_not_prefix;
    case "version_changes_content":
      return T.signError.version_changes_content;
    case "not_available":
      return T.signError.not_available;
    default:
      return error.message;
  }
}

type RejectText = (name: string, other: string | null) => string;

// Kalimat untuk satu versi yang ditolak, dipilih dari kodenya. Teks dari inti
// Rust (reason) tidak pernah ditampilkan: isinya istilah teknis dan bisa
// menyebut orang yang salah.
export function rejectedText(x: Pick<RejectedVersion, "signerName" | "code"> & { otherName?: string | null }): string {
  const name = x.signerName.trim() || T.colleague;
  const texts: Record<string, RejectText> = T.reject;
  const text = Object.prototype.hasOwnProperty.call(texts, x.code) ? texts[x.code] : undefined;
  return text ? text(name, x.otherName?.trim() || null) : T.rejectFallback(name);
}

// Pemberitahuan di atas layar dokumen.
export function exportNoticeText(count: number): string {
  return T.exportNotice(count);
}

// Masa tunggu setelah tanda tangan dihapus tanpa PIN. null kalau sudah lewat.
export function coolingText(usableAfter: string | null | undefined, now = Date.now()): string | null {
  if (!usableAfter) return null;
  const until = Date.parse(usableAfter);
  if (!Number.isFinite(until) || until <= now) return null;
  return T.cooling(formatWhen(usableAfter));
}

// Sidik file (hash BLAKE3) di layar: selalu 16 karakter awal. Hash lengkap
// ditaruh di atribut title oleh pemanggil.
export function shortHash(hash: string): string {
  return hash.slice(0, 16);
}

// Sama dengan identity::fingerprint di Rust: 16 hex pertama, huruf besar, per 4.
export function fingerprint(publicKey: string): string {
  const head = publicKey.slice(0, 16).toUpperCase();
  return (head.match(/.{1,4}/g) ?? []).join(" ");
}

// Waktu untuk layar. Bahasa Indonesia: format sama dengan catatan di PDF
// (22 November 2026, 15.04 WIB). Bahasa Inggris: nama bulan Inggris dan jam
// bertitik dua (22 November 2026, 15:04 WIB); zona tetap WIB/WITA/WIT. Teks
// di PDF sendiri selalu Indonesia. Nilai rusak ditampilkan apa adanya.
export function formatWhen(at: string): string {
  try {
    if (getLang() !== "en") return formatSignedAt(at);
    const p = signedAtParts(at);
    const month = new Intl.DateTimeFormat(locale(), { month: "long", timeZone: "UTC" }).format(
      new Date(Date.UTC(2000, p.month - 1, 1)),
    );
    return `${p.day} ${month} ${p.year}, ${p.hh}:${p.mm} ${p.zone}`;
  } catch {
    return at;
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return T.size.bytes(bytes);
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString(locale(), { maximumFractionDigits: 1 })} MB`;
}

export const MAX_PDF_BYTES = 50 * 1024 * 1024;

// Pemeriksaan ringan sebelum membaca file; isi PDF tetap diperiksa inti Mira.
export function checkPdfFile(file: File): string | null {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!isPdf) return T.checkPdf.notPdf;
  if (file.size === 0) return T.checkPdf.empty;
  if (file.size > MAX_PDF_BYTES) return T.checkPdf.tooLarge;
  return null;
}

export async function readFileBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}
