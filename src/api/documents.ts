// Pustaka dokumen (docs/plans/tahap-4-lokal.md bagian 4): tipe kontrak dan
// pembungkus command Tauri untuk layar Dokumen.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { isTauri, NO_TAURI_ERROR, toAppError } from "./index";

export type DocumentKind = "word" | "excel" | "pdf" | "other";
export type VersionOrigin = "added" | "edited" | "restored" | "resolved";
export type PersonRef = { publicKey: string; displayName: string; isMe: boolean };

export type DocumentVersion = {
  id: string;
  number: number; // seq lokal
  size: number;
  blobHash: string;
  author: PersonRef;
  createdAt: string;
  origin: VersionOrigin;
  restoredFromNumber: number | null;
  parentIds: string[];
  isHead: boolean;
  received: boolean; // datang dari rekan
  available: boolean; // isinya ada di laptop ini
};

export type EditingInfo = { editor: PersonRef; since: string; local: boolean; lastSavedAt: string | null };

export type DocumentSummary = {
  id: string;
  name: string;
  kind: DocumentKind;
  projectId: string | null;
  teamId: string | null;
  createdAt: string;
  createdBy: PersonRef;
  current: DocumentVersion; // kepala dengan nomor tertinggi
  versionCount: number;
  conflict: boolean; // lebih dari satu kepala
  conflictVersions: DocumentVersion[]; // kepala-kepala saat bentrok (nomor turun), kosong kalau tidak
  editing: EditingInfo[]; // sesi lokal dulu, lalu tanda rekan yang masih segar
  can: { edit: boolean; restore: boolean; resolve: boolean; export: boolean };
};

export type DocumentDetail = DocumentSummary & { versions: DocumentVersion[] }; // nomor turun

// Kode error baru dari inti Rust untuk dokumen (selain kode umum di types.ts).
export type DocumentErrorCode = "storage" | "invalid_input" | "document_editing" | "open_failed";

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw NO_TAURI_ERROR;
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw toAppError(err);
  }
}

export const listDocuments = (projectId: string | null) => call<DocumentSummary[]>("list_documents", { projectId });

export const getDocument = (documentId: string) => call<DocumentDetail>("get_document", { documentId });

export const addDocuments = (paths: string[], projectId: string | null) =>
  call<DocumentSummary[]>("add_documents", { paths, projectId });

export const startEdit = (documentId: string, fromVersionId: string | null) =>
  call<DocumentSummary>("start_edit", { documentId, fromVersionId });

export const finishEdit = (documentId: string) => call<DocumentSummary>("finish_edit", { documentId });

// versionId null = versi sekarang.
export const openReadOnly = (documentId: string, versionId: string | null) =>
  call<null>("open_read_only", { documentId, versionId });

export const restoreVersion = (documentId: string, versionId: string) =>
  call<DocumentSummary>("restore_version", { documentId, versionId });

export const resolveConflict = (documentId: string, keepVersionId: string) =>
  call<DocumentSummary>("resolve_conflict", { documentId, keepVersionId });

export const exportVersion = (documentId: string, versionId: string | null, destination: string) =>
  call<null>("export_version", { documentId, versionId, destination });

// Dialog Windows untuk memilih file. Hasil null = user membatalkan.
export async function pickFilesToAdd(): Promise<string[] | null> {
  if (!isTauri()) throw NO_TAURI_ERROR;
  try {
    const picked = await open({ multiple: true, directory: false });
    if (picked === null) return null;
    return Array.isArray(picked) ? picked : [picked];
  } catch (err) {
    throw toAppError(err);
  }
}

export async function pickExportDestination(name: string): Promise<string | null> {
  if (!isTauri()) throw NO_TAURI_ERROR;
  try {
    return await save({ defaultPath: name });
  } catch (err) {
    throw toAppError(err);
  }
}

// Event "mira://documents" berisi { documentId }; tampilan cukup memuat ulang.
// Polanya sama dengan subscribe di api/index.ts: di luar aplikasi desktop tidak
// melakukan apa pun, dan gagal berhenti berlangganan tidak ditampilkan.
export function subscribeDocuments(handler: () => void): () => void {
  if (!isTauri()) return () => {};
  let stopped = false;
  let unlisten: (() => unknown) | null = null;
  const stop = (fn: () => unknown) => void Promise.resolve().then(fn).catch(() => {});
  try {
    listen("mira://documents", () => {
      if (!stopped) handler();
    })
      .then((fn) => {
        if (stopped) stop(fn);
        else unlisten = fn;
      })
      .catch(() => {});
  } catch {
    // listen tidak tersedia: muat ulang saat jendela fokus tetap berjalan.
  }
  return () => {
    stopped = true;
    if (unlisten) stop(unlisten);
  };
}
