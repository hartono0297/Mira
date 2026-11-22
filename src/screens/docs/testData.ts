// Data uji layar Dokumen. Nama orang dan file jelas buatan, hanya untuk tes.
import type { DocumentDetail, DocumentSummary, DocumentVersion, PersonRef } from "../../api/documents";
import { ME, PK_C } from "../../test/fixtures";

export const meRef: PersonRef = { publicKey: ME, displayName: "Penguji", isMe: true };
export const rekanC: PersonRef = { publicKey: PK_C, displayName: "Rekan C", isMe: false };

export function version(docId: string, number: number, extra: Partial<DocumentVersion> = {}): DocumentVersion {
  return {
    id: `${docId}-v${number}`,
    number,
    size: 24_576,
    blobHash: String(number).repeat(64).slice(0, 64),
    author: meRef,
    createdAt: "2026-11-21T03:15:00Z",
    origin: number === 1 ? "added" : "edited",
    restoredFromNumber: null,
    parentIds: number === 1 ? [] : [`${docId}-v${number - 1}`],
    isHead: false,
    received: false,
    available: true,
    downloading: false,
    autoDownload: false,
    ...extra,
  };
}

export function summary(id: string, name: string, extra: Partial<DocumentSummary> = {}): DocumentSummary {
  const kind = name.endsWith(".xlsx") ? "excel" : name.endsWith(".pdf") ? "pdf" : name.endsWith(".docx") ? "word" : "other";
  return {
    id,
    name,
    kind,
    projectId: null,
    teamId: null,
    createdAt: "2026-11-20T02:00:00Z",
    createdBy: meRef,
    current: version(id, 1, { isHead: true }),
    versionCount: 1,
    conflict: false,
    conflictVersions: [],
    editing: [],
    can: { edit: true, restore: true, resolve: true, export: true },
    ...extra,
  };
}

// Detail dengan riwayat linear 1..n (nomor turun); versi n adalah kepala.
export function detailOf(doc: DocumentSummary, versions?: DocumentVersion[]): DocumentDetail {
  const list =
    versions ??
    Array.from({ length: doc.versionCount }, (_, i) => doc.versionCount - i).map((n) =>
      n === doc.current.number ? doc.current : version(doc.id, n),
    );
  return { ...doc, versions: list };
}
