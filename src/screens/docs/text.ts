// Teks tampilan layar Dokumen. Dipisah dari komponen supaya mudah dites.
import type { AppError } from "../../api";
import { formatDate, relativeTime } from "../../api/format";
import type { DocumentKind, DocumentSummary, DocumentVersion, PersonRef } from "../../api/documents";

// Lokasi dokumen: Pustaka Umum (projectId null) atau satu proyek. Label proyek
// "<KODE> <nama>", sama dengan opsi di select Lokasi. null = Pustaka Umum.
export const LIBRARY_LABEL = "Pustaka Umum";

export function projectLabel(p: { code: string; name: string }): string {
  return `${p.code} ${p.name}`;
}

// Lokasi di tengah kalimat: "Pustaka Umum" atau "proyek PA Gudang".
export function placeText(label: string | null): string {
  return label === null ? LIBRARY_LABEL : `proyek ${label}`;
}

export function addedText(added: { name: string }[], label: string | null): string {
  const what = added.length === 1 ? added[0].name : `${added.length} file`;
  return `${what} ditambahkan ke ${placeText(label)}.`;
}

export function emptyTitle(label: string | null): string {
  return label === null ? `${LIBRARY_LABEL} masih kosong` : `Belum ada file di proyek ${label}`;
}

// Sesuai documents::scope::may_view: Pustaka Umum untuk semua anggota aktif
// bukan Tamu; file proyek hanya untuk anggota proyek itu (termasuk Tamu yang
// diundang ke proyek itu, yang juga anggota proyek di board).
export function visibilityHint(label: string | null): string {
  return label === null
    ? `File di ${LIBRARY_LABEL} terlihat oleh semua anggota organisasi, kecuali Tamu.`
    : `File di proyek ${label} hanya terlihat oleh anggota proyek itu.`;
}

// Proyek yang diingat tidak ada lagi di daftar proyek saya (dikeluarkan, atau
// proyeknya hilang dari laptop ini). `next` = lokasi yang sekarang tampil
// (label proyek, atau null untuk Pustaka Umum); undefined = tidak ada lokasi
// lain (Tamu tanpa proyek).
export function goneNote(label: string, next?: string | null): string {
  const gone = `Proyek ${label} tidak tersedia lagi untuk Anda.`;
  return next === undefined ? gone : `${gone} Menampilkan ${placeText(next)}.`;
}

// Tamu tidak melihat Pustaka Umum dan tidak bisa menambah file (documents::access).
export const GUEST_NO_PROJECT_TITLE = "Belum ada proyek yang bisa Anda buka";
export const GUEST_NO_PROJECT_TEXT =
  "Sebagai Tamu, Anda hanya melihat file di proyek tempat Anda diundang. Minta pengelola proyek menambahkan Anda.";
export const GUEST_EMPTY_TEXT =
  "File yang ditambahkan anggota proyek muncul di sini. Tamu bisa membuka file, tetapi tidak menambahkannya.";

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
  switch (state) {
    case "copying":
      return "Isinya sedang disalin dari laptop rekan.";
    case "waiting":
      return "Isinya disalin otomatis begitu laptop rekan yang menyimpannya tersambung.";
    case "manual":
      return "File di atas 20 MB tidak disalin otomatis. Unduh kalau Anda perlu membukanya.";
  }
}

export function downloadLabel(v: DocumentVersion): string {
  return `Unduh dari rekan (${formatSize(v.size)})`;
}

// Menu klik kanan dan tombol "..." di baris file.
export const menuLabel = (name: string) => `Aksi untuk ${name}`;
export const menuButtonLabel = (name: string) => `Aksi lain untuk ${name}`;
export const OPEN_READONLY_LABEL = "Buka hanya baca";
export const HISTORY_LABEL = "Lihat riwayat versi";
export const EXPORT_LABEL = "Simpan salinan";
export const COPY_NAME_LABEL = "Salin nama";
export const WAIT_REASON = "Menunggu aksi lain selesai";
export const COPY_FAILED_TITLE = "Nama file belum bisa disalin";
export const copiedText = (name: string) => `Nama ${name} disalin.`;

// Simpan salinan butuh isi versi sekarang di laptop ini.
export function exportBlockedReason(state: FetchState): string {
  switch (state) {
    case "copying":
      return "Isinya masih disalin dari laptop rekan";
    case "waiting":
      return "Isinya menunggu laptop rekan tersambung";
    case "manual":
      return "Unduh dulu isinya dari rekan";
  }
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
  // Kepala bentrok punya keterangan sendiri di kotak bentrok.
  const fetch = doc.conflict ? null : fetchState(doc.current);
  if (fetch) {
    const n = doc.current.number;
    const text =
      fetch === "copying"
        ? `Versi ${n} sedang disalin dari laptop rekan`
        : fetch === "waiting"
          ? `Versi ${n} menunggu laptop rekan tersambung`
          : `Versi ${n} belum diunduh (${formatSize(doc.current.size)})`;
    lines.push({ kind: "fetch", text });
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
export type ActionKind = "add" | "edit" | "finish" | "open" | "restore" | "resolve" | "export" | "download";

// Pesan Indonesia dari inti Rust dipakai apa adanya, kecuali kode yang perlu
// kalimat lebih jelas untuk orang awam.
export const NOT_AVAILABLE_TEXT = "Belum ada laptop rekan yang tersambung dan menyimpan file ini.";

export function errorMessage(error: AppError): string {
  return error.code === "not_available" ? NOT_AVAILABLE_TEXT : error.message;
}

export function errorTitle(error: AppError, action: ActionKind): string {
  if (error.code === "forbidden") return "Anda tidak punya izin untuk ini";
  if (error.code === "not_found") return "File atau versi ini sudah tidak ada";
  switch (action) {
    case "download":
      return "File belum bisa diunduh";
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
  if (error.code === "not_available") {
    return "Coba lagi saat laptop rekan yang menyimpan versi ini menyala dan tersambung ke Mira.";
  }
  if (error.code === "not_found") return "Daftar file sudah dimuat ulang. Periksa lagi sebelum mencoba.";
  if (error.code === "open_failed") return "Pastikan Microsoft Office atau aplikasi untuk jenis file ini terpasang di laptop ini.";
  return null;
}
