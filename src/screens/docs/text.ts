// Teks tampilan layar Dokumen. Dipisah dari komponen supaya mudah dites.
import type { AppError } from "../../api";
import { formatDate, relativeTime } from "../../api/format";
import type { DocumentKind, DocumentSummary, DocumentVersion, PersonRef } from "../../api/documents";

export const LIBRARY_LABEL = "Umum";

export function person(p: PersonRef): string {
  return p.isMe ? "Anda" : p.displayName;
}

export function editable(kind: DocumentKind): boolean {
  return kind === "word" || kind === "excel";
}

// Nama aplikasi Office untuk jenis yang bisa diedit.
export function appName(kind: DocumentKind): string | null {
  if (kind === "word") return "Word";
  if (kind === "excel") return "Excel";
  return null;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Jam untuk "sejak ...": "10.15" kalau hari ini, "kemarin 10.15", lalu tanggal dan jam.
export function clockTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
  if (sameDay(d, now)) return time;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return `kemarin ${time}`;
  return `${formatDate(iso)} ${time}`;
}

// "versi 4 dan 5", "versi 3, 4, dan 5": nomor naik.
export function versionList(versions: DocumentVersion[]): string {
  const nums = versions.map((v) => v.number).sort((a, b) => a - b);
  if (nums.length <= 1) return `versi ${nums.join("")}`;
  if (nums.length === 2) return `versi ${nums[0]} dan ${nums[1]}`;
  return `versi ${nums.slice(0, -1).join(", ")}, dan ${nums[nums.length - 1]}`;
}

export type StatusKind = "normal" | "mine" | "rekan" | "conflict";
export type StatusLine = { kind: StatusKind; text: string };

// Baris status di daftar file. Bentrok dan tanda edit bisa muncul bersamaan
// (misalnya saat Anda menggabung manual), jadi hasilnya bisa lebih dari satu baris.
export function statusLines(doc: DocumentSummary, now: Date = new Date()): StatusLine[] {
  const lines: StatusLine[] = [];
  if (doc.conflict && doc.conflictVersions.length > 1) {
    lines.push({
      kind: "conflict",
      text: `Bentrok: ${versionList(doc.conflictVersions)} tersimpan berdampingan`,
    });
  }
  for (const e of doc.editing) {
    const since = clockTime(e.since, now);
    if (e.local) {
      const app = appName(doc.kind);
      lines.push({ kind: "mine", text: `Sedang Anda edit${app ? ` di ${app}` : ""} sejak ${since}` });
    } else {
      lines.push({ kind: "rekan", text: `Sedang diedit ${e.editor.displayName} sejak ${since}` });
    }
  }
  if (lines.length === 0) {
    const v = doc.current;
    const verb = v.origin === "added" ? "Ditambahkan" : "Diubah";
    lines.push({
      kind: "normal",
      text: `Versi ${v.number} · ${verb} ${person(v.author)} ${relativeTime(v.createdAt, now)}`,
    });
  }
  return lines;
}

export function originText(v: DocumentVersion, kind: DocumentKind): string {
  switch (v.origin) {
    case "added":
      return "Ditambahkan";
    case "edited": {
      const app = appName(kind);
      return app ? `Disimpan dari ${app}` : "Disimpan";
    }
    case "restored":
      return v.restoredFromNumber !== null ? `Dipulihkan dari versi ${v.restoredFromNumber}` : "Dipulihkan dari versi lama";
    case "resolved":
      return "Bentrok diselesaikan";
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb.toLocaleString("id-ID", { maximumFractionDigits: 1 })} MB`;
}

// Saran tambahan untuk error dari inti Rust, sesuai aksi yang gagal.
export type ActionKind = "add" | "edit" | "finish" | "open" | "restore" | "resolve" | "export";

export function errorTitle(error: AppError, action: ActionKind): string {
  if (error.code === "forbidden") return "Anda tidak punya izin untuk ini";
  if (error.code === "not_found") return "File atau versi ini sudah tidak ada";
  switch (action) {
    case "add":
      return "File belum bisa ditambahkan";
    case "edit":
      return "File belum bisa dibuka untuk diedit";
    case "finish":
      return "Edit belum bisa diselesaikan";
    case "open":
      return "File belum bisa dibuka";
    case "restore":
      return "Versi belum bisa dipulihkan";
    case "resolve":
      return "Bentrok belum bisa diselesaikan";
    case "export":
      return "Salinan belum bisa disimpan";
  }
}

export function errorHint(error: AppError, action: ActionKind): string | null {
  if (error.code === "document_editing") {
    if (action === "finish") return "Tutup file di Word atau Excel dulu, lalu tekan Selesai mengedit lagi.";
    if (action === "restore" || action === "resolve") return "File ini sedang diedit. Selesaikan edit dulu, lalu coba lagi.";
    return "File ini sedang diedit. Tunggu sampai editnya selesai.";
  }
  if (error.code === "not_found") return "Daftar file sudah dimuat ulang. Periksa lagi sebelum mencoba.";
  if (error.code === "open_failed") return "Pastikan Microsoft Office atau aplikasi untuk jenis file ini terpasang di laptop ini.";
  return null;
}
