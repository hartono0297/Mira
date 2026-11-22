import type { DocumentSummary, DocumentVersion } from "../../api/documents";

// Aksi layar Dokumen, dijalankan oleh DocsScreen. Setiap aksi punya kunci
// supaya hanya tombol yang sedang berjalan yang menampilkan keadaan sibuk.
export type DocActions = {
  pending: string | null;
  edit: (doc: DocumentSummary, from: DocumentVersion | null) => void;
  finish: (doc: DocumentSummary) => void;
  open: (doc: DocumentSummary, version: DocumentVersion | null) => void;
  exportCopy: (doc: DocumentSummary, version: DocumentVersion) => void;
  askRestore: (doc: DocumentSummary, version: DocumentVersion) => void;
  resolve: (doc: DocumentSummary, keep: DocumentVersion) => void;
  showConflict: (doc: DocumentSummary) => void;
};

export const keys = {
  edit: (docId: string, fromId: string | null) => `edit:${docId}:${fromId ?? ""}`,
  finish: (docId: string) => `finish:${docId}`,
  open: (docId: string, versionId: string | null) => `open:${docId}:${versionId ?? ""}`,
  export: (docId: string, versionId: string) => `export:${docId}:${versionId}`,
  resolve: (docId: string, versionId: string) => `resolve:${docId}:${versionId}`,
  add: "add",
};
