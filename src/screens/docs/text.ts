// Teks tampilan layar Dokumen. Dipisah dari komponen supaya mudah dites.
import type { AppError } from "../../api";
import { formatDate, relativeTime } from "../../api/format";
import type { DocumentKind, DocumentSummary, DocumentVersion, PersonRef } from "../../api/documents";
import { defineText, locale, subscribeLang } from "../../i18n/core";
import en from "../../i18n/docs.en";
import id from "../../i18n/docs.id";

// Semua teks layar Dokumen, mengikuti bahasa aktif. Bacalah saat render atau
// di dalam fungsi, bukan di tingkat modul.
export const DOCS = defineText(id, en);

// Lokasi dokumen: Pustaka Umum (projectId null) atau satu proyek. Label proyek
// "<KODE> <nama>", sama dengan opsi di select Lokasi. null = Pustaka Umum.
// Label proyek adalah data (kode dan nama proyek), jadi tidak diterjemahkan.

export function projectLabel(p: { code: string; name: string }): string {
  return `${p.code} ${p.name}`;
}

// Lokasi di tengah kalimat: "Pustaka Umum" atau "proyek PA Gudang".
export function placeText(label: string | null): string {
  return DOCS.place(label);
}

export function addedText(added: { name: string }[], label: string | null): string {
  const what = added.length === 1 ? added[0].name : DOCS.addedCount(added.length);
  return DOCS.added(what, placeText(label));
}

export function emptyTitle(label: string | null): string {
  return DOCS.emptyTitle(label);
}

// Sesuai documents::scope::may_view: Pustaka Umum untuk semua anggota aktif
// bukan Tamu; file proyek hanya untuk anggota proyek itu (termasuk Tamu yang
// diundang ke proyek itu, yang juga anggota proyek di board).
export function visibilityHint(label: string | null): string {
  return DOCS.visibility(label);
}

// Proyek yang diingat tidak ada lagi di daftar proyek saya (dikeluarkan, atau
// proyeknya hilang dari laptop ini). `next` = lokasi yang sekarang tampil
// (label proyek, atau null untuk Pustaka Umum); undefined = tidak ada lokasi
// lain (Tamu tanpa proyek).
export function goneNote(label: string, next?: string | null): string {
  const gone = DOCS.gone(label);
  return next === undefined ? gone : `${gone} ${DOCS.showing(placeText(next))}`;
}

// Penulis versi di awal baris ("Anda", "You").
export function person(p: PersonRef): string {
  return p.isMe ? DOCS.you : p.displayName;
}

// Penulis versi di tengah kalimat (bahasa Inggris: "you" huruf kecil).
export function personInline(p: PersonRef): string {
  return p.isMe ? DOCS.youInline : p.displayName;
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
  const time = d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
  if (sameDay(d, now)) return time;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return DOCS.yesterdayAt(time);
  return DOCS.dateAt(formatDate(iso), time);
}

// "versi 4 dan 5", "versi 3, 4, dan 5": nomor naik.
export function versionList(versions: DocumentVersion[]): string {
  const nums = versions.map((v) => v.number).sort((a, b) => a - b);
  if (nums.length === 0) return DOCS.versionOne("");
  if (nums.length === 1) return DOCS.versionOne(nums[0]);
  if (nums.length === 2) return DOCS.versionTwo(nums[0], nums[1]);
  return DOCS.versionMany(nums.slice(0, -1).join(", "), nums[nums.length - 1]);
}

// Isi versi yang belum ada di laptop ini:
// - copying: sedang disalin dari laptop rekan;
// - waiting: sampai 20 MB, disalin otomatis begitu rekan yang menyimpannya tersambung;
// - manual: lebih dari 20 MB, diunduh lewat tombol.
export type FetchState = "copying" | "waiting" | "manual";

export function fetchState(v: DocumentVersion): FetchState | null {
  if (v.available) return null;
  if (v.downloading) return "copying";
  if (v.autoDownload) return "waiting";
  return "manual";
}

// Penjelasan untuk riwayat versi dan kartu bentrok.
export function fetchText(state: FetchState): string {
  return DOCS.fetch[state];
}

export function downloadLabel(v: DocumentVersion): string {
  return DOCS.downloadLabel(formatSize(v.size));
}

// Menu klik kanan dan tombol "..." di baris file.
// Label tetapnya ada di DOCS (openReadOnly, history, exportCopy, copyName, waitReason).
export const menuLabel = (name: string) => DOCS.menuLabel(name);
export const menuButtonLabel = (name: string) => DOCS.menuButtonLabel(name);
export const copiedText = (name: string) => DOCS.copied(name);

// Simpan salinan butuh isi versi sekarang di laptop ini.
export function exportBlockedReason(state: FetchState): string {
  return DOCS.exportBlocked[state];
}

export type StatusKind = "normal" | "mine" | "rekan" | "conflict" | "fetch";
export type StatusLine = { kind: StatusKind; text: string };

// Baris status di daftar file. Bentrok dan tanda edit bisa muncul bersamaan
// (misalnya saat Anda menggabung manual), jadi hasilnya bisa lebih dari satu baris.
export function statusLines(doc: DocumentSummary, now: Date = new Date()): StatusLine[] {
  const lines: StatusLine[] = [];
  if (doc.conflict && doc.conflictVersions.length > 1) {
    lines.push({
      kind: "conflict",
      text: DOCS.status.conflict(versionList(doc.conflictVersions)),
    });
  }
  for (const e of doc.editing) {
    const since = clockTime(e.since, now);
    if (e.local) {
      lines.push({ kind: "mine", text: DOCS.status.mine(appName(doc.kind), since) });
    } else {
      lines.push({ kind: "rekan", text: DOCS.status.rekan(e.editor.displayName, since) });
    }
  }
  if (lines.length === 0) {
    const v = doc.current;
    const line = v.origin === "added" ? DOCS.status.added : DOCS.status.edited;
    lines.push({
      kind: "normal",
      text: line(v.number, personInline(v.author), relativeTime(v.createdAt, now)),
    });
  }
  // Kepala bentrok punya keterangan sendiri di kotak bentrok.
  const fetch = doc.conflict ? null : fetchState(doc.current);
  if (fetch) {
    const n = doc.current.number;
    const text =
      fetch === "copying"
        ? DOCS.status.copying(n)
        : fetch === "waiting"
          ? DOCS.status.waiting(n)
          : DOCS.status.manual(n, formatSize(doc.current.size));
    lines.push({ kind: "fetch", text });
  }
  return lines;
}

export function originText(v: DocumentVersion, kind: DocumentKind): string {
  switch (v.origin) {
    case "added":
      return DOCS.origin.added;
    case "edited": {
      const app = appName(kind);
      return app ? DOCS.origin.savedFrom(app) : DOCS.origin.saved;
    }
    case "restored":
      return v.restoredFromNumber !== null ? DOCS.origin.restoredFrom(v.restoredFromNumber) : DOCS.origin.restoredOld;
    case "resolved":
      return DOCS.origin.resolved;
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb.toLocaleString(locale(), { maximumFractionDigits: 1 })} MB`;
}

// Saran tambahan untuk error dari inti Rust, sesuai aksi yang gagal.
export type ActionKind = "add" | "edit" | "finish" | "open" | "restore" | "resolve" | "export" | "download";

// Pesan dari inti Rust dipakai apa adanya (call() sudah menerjemahkannya saat
// bahasa Inggris aktif), kecuali kode yang perlu kalimat lebih jelas untuk orang awam.
// Ekspor hidup (let) supaya ikut berganti bersama bahasa; dibaca langsung oleh tes.
export let NOT_AVAILABLE_TEXT = DOCS.notAvailable;
subscribeLang(() => {
  NOT_AVAILABLE_TEXT = DOCS.notAvailable;
});

export function errorMessage(error: AppError): string {
  return error.code === "not_available" ? DOCS.notAvailable : error.message;
}

export function errorTitle(error: AppError, action: ActionKind): string {
  if (error.code === "forbidden") return DOCS.errorTitle.forbidden;
  if (error.code === "not_found") return DOCS.errorTitle.notFound;
  return DOCS.errorTitle[action];
}

export function errorHint(error: AppError, action: ActionKind): string | null {
  if (error.code === "document_editing") {
    if (action === "finish") return DOCS.errorHint.finishEditing;
    if (action === "restore" || action === "resolve") return DOCS.errorHint.editingRetry;
    return DOCS.errorHint.editingWait;
  }
  if (error.code === "not_available") return DOCS.errorHint.notAvailable;
  if (error.code === "not_found") return DOCS.errorHint.notFound;
  if (error.code === "open_failed") return DOCS.errorHint.openFailed;
  return null;
}
