// Label Indonesia untuk tanda tangan PDF. Dipakai layar daftar dan layar dokumen.

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
import { formatSignedAt } from "./stamp";

export function myStateLabel(state: MyState): string {
  switch (state) {
    case "your_turn":
      return "Giliran Anda";
    case "waiting_others":
      return "Menunggu orang lain";
    case "signed":
      return "Sudah Anda tanda tangani";
    case "not_involved":
      return "Anda bukan penanda tangan";
  }
}

export function statusLabel(status: RequestStatus): string {
  switch (status) {
    case "in_progress":
      return "Berjalan";
    case "completed":
      return "Selesai, terkunci";
    case "cancelled":
      return "Dibatalkan";
  }
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
  if (r.myState === "your_turn" && r.fileAvailable === false) return "Menunggu file";
  if (r.myState === "your_turn" && r.pending === true) return "Menunggu tanda tangan rekan";
  if (r.myState === "your_turn" && r.integrity !== "intact") return "Tidak bisa ditandatangani";
  if (r.myState === "not_involved") return "Menunggu penanda tangan";
  return myStateLabel(r.myState);
}

// Chip di kepala layar dokumen, mis. "Berjalan, 0 dari 2 sudah tanda tangan".
export function headerStatusLabel(
  r: Pick<RequestSummary, "status" | "signedCount" | "signerCount"> & { sealValid: boolean | null },
): string {
  if (r.status === "in_progress") return `${statusLabel(r.status)}, ${r.signedCount} dari ${r.signerCount} sudah tanda tangan`;
  if (r.status === "completed" && r.sealValid !== true) return "Selesai, kunci tidak sah";
  return statusLabel(r.status);
}

export function modeLabel(mode: SignMode): string {
  return mode === "sequential" ? "Berurutan" : "Bebas";
}

export function modeHint(mode: SignMode): string {
  return mode === "sequential"
    ? "Satu per satu sesuai urutan. Orang berikutnya baru bisa menandatangani setelah giliran sebelumnya selesai."
    : "Siapa saja boleh lebih dulu. Dokumen selesai setelah semua menandatangani.";
}

export function kindLabel(kind: SignerKind): string {
  return kind === "guest" ? "Tamu" : "Anggota";
}

const EVENT_LABELS: Record<EventKind, string> = {
  created: "Permintaan dibuat",
  signed: "Menandatangani",
  completed: "Semua selesai, dokumen dikunci",
  cancelled: "Permintaan dibatalkan",
  exported: "Salinan PDF disimpan ke luar Mira",
  signature_saved: "Membuat tanda tangan baru",
  signature_deleted: "Menghapus tanda tangan",
};

export function eventLabel(kind: string): string {
  return EVENT_LABELS[kind as EventKind] ?? `Catatan lain (${kind})`;
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
  switch (integrity) {
    case "intact":
      return "Isi file utuh";
    case "changed":
      return "Isi file tidak cocok dengan catatan Mira";
    case "missing":
      return "File hilang dari penyimpanan Mira";
  }
}

export function exportStateLabel(state: Integrity): string {
  switch (state) {
    case "intact":
      return "Utuh";
    case "changed":
      return "Berubah";
    case "missing":
      return "Tidak ditemukan";
  }
}

export function exportWarningLabel(count: number): string {
  return count > 1
    ? `${count} salinan PDF yang disimpan di luar Mira berubah`
    : "Salinan PDF yang disimpan di luar Mira berubah";
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
  if (need.downloading) {
    return need.newer ? "Tanda tangan terbaru dari rekan sedang disalin ke laptop ini" : "File sedang disalin dari laptop rekan";
  }
  if (need.state === "auto") {
    return need.newer
      ? "Tanda tangan terbaru dari rekan disalin otomatis saat laptop rekan yang menyimpannya tersambung."
      : "File disalin otomatis saat laptop rekan yang menyimpannya tersambung.";
  }
  const why =
    need.size === null
      ? "Ukurannya belum diketahui, jadi tidak disalin otomatis."
      : "File di atas 20 MB tidak disalin otomatis.";
  if (need.newer) return `Versi bertanda tangan terbaru belum diunduh. ${why}`;
  return need.size === null ? `File ini belum diunduh. ${why}` : `File ${formatSize(need.size)} belum diunduh. ${why}`;
}

// Teks tombol unduh: ukuran hanya kalau diketahui.
export function downloadLabel(need: FileNeed): string {
  return need.size ? `Unduh file (${formatSize(need.size)})` : "Unduh file";
}

// Pesan yang mudah dipahami untuk kode error tanda tangan yang baru. Kode lain
// memakai pesan Indonesia dari inti Rust apa adanya.
export function signErrorMessage(error: AppError): string {
  switch (error.code as SignErrorCode | string) {
    case "version_not_prefix":
      return "Mira menolak hasil tanda tangan ini karena isi versi sebelumnya tidak utuh di dalamnya. Tanda tangan hanya boleh ditambahkan di belakang isi lama. Coba lagi. Kalau tetap ditolak, minta pengirim membuat permintaan baru.";
    case "version_changes_content":
      return "Mira menolak hasil tanda tangan ini karena mengubah isi dokumen selain stempel tanda tangan. Coba lagi. Kalau tetap ditolak, minta pengirim membuat permintaan baru.";
    case "not_available":
      return "Belum ada laptop rekan yang tersambung dan menyimpan file ini. Coba lagi saat laptop rekan yang menyimpannya menyala dan tersambung ke Mira.";
    default:
      return error.message;
  }
}

type RejectText = (name: string, other: string | null) => string;

const REJECT_TEXT: Record<string, RejectText> = {
  version_changes_content: (n) => `Versi dari ${n} ditolak karena mengubah isi dokumen, bukan hanya menambah tanda tangan.`,
  version_not_prefix: (n) =>
    `Versi dari ${n} ditolak karena isi dokumen sebelumnya tidak utuh di dalamnya. Tanda tangan hanya boleh ditambahkan di belakang isi lama.`,
  pdf_invalid: (n) => `Versi dari ${n} ditolak karena filenya bukan PDF yang bisa dibaca Mira.`,
  tag_missing: (n) => `Versi dari ${n} ditolak karena file itu bukan untuk dokumen ini.`,
  skipped_concurrent: (n, other) =>
    `Versi dari ${n} tidak dipakai karena ${other ?? "penanda tangan lain"} menandatangani versi yang sama lebih dulu. ${n} perlu menandatangani versi terbaru.`,
  on_rejected: (n) => `Versi dari ${n} ditolak karena ditandatangani di atas versi lain yang sudah ditolak.`,
  outdated_version: (n) => `Versi dari ${n} tidak dipakai karena ditandatangani di atas versi lama dokumen.`,
  not_allowed: (n) => `Versi dari ${n} ditolak karena ${n} bukan penanda tangan dokumen ini.`,
  not_your_turn: (n) => `Versi dari ${n} ditolak karena dibuat sebelum giliran ${n}.`,
  already_signed: (n) => `Versi dari ${n} tidak dipakai karena ${n} sudah menandatangani versi lain dokumen ini.`,
  request_closed: (n) => `Versi dari ${n} tidak dipakai karena dokumen sudah selesai ditandatangani.`,
  invalid_record: (n) => `Versi dari ${n} ditolak karena catatan tanda tangannya tidak lengkap.`,
};

// Kalimat untuk satu versi yang ditolak, dipilih dari kodenya. Teks dari inti
// Rust (reason) tidak pernah ditampilkan: isinya istilah teknis dan bisa
// menyebut orang yang salah.
export function rejectedText(x: Pick<RejectedVersion, "signerName" | "code"> & { otherName?: string | null }): string {
  const name = x.signerName.trim() || "rekan";
  const text = Object.prototype.hasOwnProperty.call(REJECT_TEXT, x.code) ? REJECT_TEXT[x.code] : undefined;
  return text ? text(name, x.otherName?.trim() || null) : `Versi dari ${name} tidak dipakai Mira.`;
}

// Pemberitahuan di atas layar dokumen.
export function exportNoticeText(count: number): string {
  const head = count > 1 ? `${count} salinan` : "Satu salinan";
  return `${head} yang disimpan di luar Mira berubah. Rinciannya ada di bagian Salinan PDF.`;
}

// Masa tunggu setelah tanda tangan dihapus tanpa PIN. null kalau sudah lewat.
export function coolingText(usableAfter: string | null | undefined, now = Date.now()): string | null {
  if (!usableAfter) return null;
  const until = Date.parse(usableAfter);
  if (!Number.isFinite(until) || until <= now) return null;
  return `Tanda tangan baru Anda bisa dipakai mulai ${formatWhen(usableAfter)}, karena tanda tangan sebelumnya dihapus tanpa PIN.`;
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

// Waktu untuk layar, format sama dengan catatan di PDF. Nilai rusak ditampilkan apa adanya.
export function formatWhen(at: string): string {
  try {
    return formatSignedAt(at);
  } catch {
    return at;
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} byte`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString("id-ID", { maximumFractionDigits: 1 })} MB`;
}

export const MAX_PDF_BYTES = 50 * 1024 * 1024;

// Pemeriksaan ringan sebelum membaca file; isi PDF tetap diperiksa inti Mira.
export function checkPdfFile(file: File): string | null {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!isPdf) return "File ini bukan PDF. Pilih file berakhiran .pdf.";
  if (file.size === 0) return "File ini kosong.";
  if (file.size > MAX_PDF_BYTES) return "File lebih dari 50 MB. Mira menerima PDF sampai 50 MB.";
  return null;
}

export async function readFileBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}
