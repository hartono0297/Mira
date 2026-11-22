// Label Indonesia untuk tanda tangan PDF. Dipakai layar daftar dan layar dokumen.

import type { Integrity, MyState, RequestStatus, RequestSummary, SignMode, SignerKind } from "../../api/signing";
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
      return "Sedang berjalan";
    case "completed":
      return "Selesai, terkunci";
    case "cancelled":
      return "Dibatalkan";
  }
}

// Satu label untuk baris daftar: status akhir menang atas keadaan saya.
export function requestStateLabel(r: Pick<RequestSummary, "status" | "myState">): string {
  if (r.status !== "in_progress") return statusLabel(r.status);
  if (r.myState === "not_involved") return "Menunggu penanda tangan";
  return myStateLabel(r.myState);
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

const EVENT_LABELS: Record<string, string> = {
  created: "Permintaan dibuat",
  signed: "Ditandatangani",
  completed: "Selesai dan dikunci",
  cancelled: "Permintaan dibatalkan",
  exported: "Salinan PDF disimpan ke luar Mira",
  signature_saved: "Tanda tangan tersimpan dibuat",
  signature_deleted: "Tanda tangan tersimpan dihapus",
};

export function eventLabel(kind: string): string {
  return EVENT_LABELS[kind] ?? kind;
}

export function integrityLabel(integrity: Integrity): string {
  switch (integrity) {
    case "intact":
      return "Isi file utuh";
    case "changed":
      return "Isi file berubah sejak ditandatangani";
    case "missing":
      return "File hilang dari penyimpanan Mira";
  }
}

export function exportWarningLabel(count: number): string {
  return count > 1
    ? `${count} salinan PDF yang disimpan di luar Mira berubah`
    : "Salinan PDF yang disimpan di luar Mira berubah";
}

export function shortHash(hash: string, length = 16): string {
  return hash.slice(0, length);
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
