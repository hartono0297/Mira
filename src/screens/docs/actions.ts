import type { DocumentSummary, DocumentVersion } from "../../api/documents";

// Aksi layar Dokumen, dijalankan oleh DocsScreen. Setiap aksi punya kunci
// supaya hanya tombol yang sedang berjalan yang menampilkan keadaan sibuk.
// `pending`: satu aksi yang mengubah data (edit, pulihkan, simpan salinan...);
// selama berjalan, aksi lain menunggu. `downloads`: unduhan yang sedang
// berjalan; unduhan tidak menahan aksi lain, hanya tombol unduhnya sendiri.
export type DocActions = {
  pending: string | null;
  downloads: ReadonlySet<string>;
  edit: (doc: DocumentSummary, from: DocumentVersion | null) => void;
  finish: (doc: DocumentSummary) => void;
  open: (doc: DocumentSummary, version: DocumentVersion | null) => void;
  exportCopy: (doc: DocumentSummary, version: DocumentVersion) => void;
  askRestore: (doc: DocumentSummary, version: DocumentVersion) => void;
  resolve: (doc: DocumentSummary, keep: DocumentVersion) => void;
  showConflict: (doc: DocumentSummary) => void;
  download: (doc: DocumentSummary, version: DocumentVersion) => void;
};

// Tombol `key` sedang berjalan.
export function isBusy(actions: Pick<DocActions, "pending" | "downloads">, key: string): boolean {
  return actions.pending === key || actions.downloads.has(key);
}

// Tombol `key` menunggu: aksinya sendiri berjalan, atau (untuk aksi yang
// bukan unduhan) aksi lain yang mengubah data sedang berjalan.
export function isBlocked(actions: Pick<DocActions, "pending" | "downloads">, key: string): boolean {
  if (isBusy(actions, key)) return true;
  return actions.pending !== null && !key.startsWith("download:");
}

export const keys = {
  edit: (docId: string, fromId: string | null) => `edit:${docId}:${fromId ?? ""}`,
  finish: (docId: string) => `finish:${docId}`,
  open: (docId: string, versionId: string | null) => `open:${docId}:${versionId ?? ""}`,
  export: (docId: string, versionId: string) => `export:${docId}:${versionId}`,
  resolve: (docId: string, versionId: string) => `resolve:${docId}:${versionId}`,
  download: (docId: string, versionId: string) => `download:${docId}:${versionId}`,
  add: "add",
};
