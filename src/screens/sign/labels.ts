// Label Indonesia untuk tanda tangan PDF. Dipakai layar daftar dan layar dokumen.

import type {
  EventKind,
  Integrity,
  MyState,
  RequestStatus,
  RequestSummary,
  SignMode,
  SignerKind,
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

// Giliran saya DAN file utuh. File yang berubah atau hilang tidak bisa
// ditandatangani, jadi tidak dihitung sebagai "menunggu tanda tangan Anda".
export function isActionable(r: Pick<RequestSummary, "status" | "myState" | "integrity">): boolean {
  return r.status === "in_progress" && r.myState === "your_turn" && r.integrity === "intact";
}

// Satu label untuk baris daftar: status akhir menang atas keadaan saya, dan
// giliran saya atas file yang bermasalah bukan lagi "Giliran Anda".
export function requestStateLabel(r: Pick<RequestSummary, "status" | "myState" | "integrity">): string {
  if (r.status !== "in_progress") return statusLabel(r.status);
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
