// Kontrak tanda tangan PDF dengan inti Rust (docs/plans/tahap-5-lokal.md bagian 5).
//
// Byte PDF dikirim dan diterima lewat IPC mentah Tauri 2 (badan permintaan
// berupa Uint8Array, data lain lewat header), bukan JSON, supaya file
// beberapa MB tidak berubah jadi ratusan ribu angka.

import { invoke } from "@tauri-apps/api/core";
import { NO_TAURI_ERROR, isTauri, toAppError } from "./index";

export type SignMode = "sequential" | "parallel";
export type SignerKind = "member" | "guest";
export type RequestStatus = "in_progress" | "completed" | "cancelled";
export type MyState = "your_turn" | "waiting_others" | "signed" | "not_involved";
export type Integrity = "intact" | "changed" | "missing";

export type SavedSignatureInfo = {
  width: number;
  height: number;
  createdAt: string;
  failedAttempts: number;
  lockedUntil: string | null;
  attemptsLeft: number;
};

export type RequestSummary = {
  id: string;
  title: string;
  mode: SignMode;
  status: RequestStatus;
  myState: MyState;
  signedCount: number;
  signerCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  integrity: Integrity;
  exportWarnings: number;
};

export type SignOverview = {
  saved: SavedSignatureInfo | null;
  requests: RequestSummary[];
  canRequest: boolean;
  me: { publicKey: string; displayName: string; kind: SignerKind };
};

export type Candidate = { publicKey: string; displayName: string; kind: SignerKind; isMe: boolean };

export type SignerView = {
  position: number;
  publicKey: string;
  displayName: string;
  kind: SignerKind;
  status: "waiting" | "signed";
  signedAt: string | null;
  hashAfter: string | null;
  isMe: boolean;
  canSignNow: boolean;
};

export type EventKind =
  | "created"
  | "signed"
  | "completed"
  | "cancelled"
  | "exported"
  | "signature_saved"
  | "signature_deleted";

export type EventView = {
  kind: EventKind;
  actorKey: string;
  actorName: string;
  at: string;
  hashBefore: string | null;
  hashAfter: string | null;
  detail: string;
  valid: boolean;
};

export type ExportView = { path: string; exportedAt: string; state: Integrity };

export type RequestDetail = RequestSummary & {
  requestedBy: { publicKey: string; displayName: string };
  originalHash: string;
  currentHash: string;
  signers: SignerView[];
  events: EventView[];
  exports: ExportView[];
  isLastPending: boolean;
  docTag: string;
  // null kalau belum selesai; true kalau catatan "completed" sah dan hash cocok.
  sealValid: boolean | null;
};

export type Unlocked = { token: string; png: Uint8Array; signedAt: string; width: number; height: number };

export type ImportedPdf = { fileHash: string; size: number; fileName: string };

export type VerifyResult = {
  state: "match_final" | "match_version" | "changed" | "unknown";
  fileHash: string;
  requestId: string | null;
  title: string | null;
  completedAt: string | null;
  signers: { displayName: string; signedAt: string | null }[];
};

// Base64 tanpa membuat string raksasa sekaligus (gambar tanda tangan ≤ 1 MB).
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function call<T>(
  command: string,
  args?: Record<string, unknown> | Uint8Array,
  headers?: Record<string, string>,
): Promise<T> {
  if (!isTauri()) throw NO_TAURI_ERROR;
  try {
    return await invoke<T>(command, args, headers ? { headers } : undefined);
  } catch (err) {
    throw toAppError(err);
  }
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  throw toAppError("Isi file dari inti Mira tidak berbentuk byte.");
}

export const signingApi = {
  overview: () => call<SignOverview>("sign_overview"),
  saveSignature: (png: Uint8Array, pin: string) =>
    call<SavedSignatureInfo>("sign_save_signature", { pin, pngBase64: bytesToBase64(png) }),
  deleteSignature: () => call<null>("sign_delete_signature"),
  unlock: async (pin: string): Promise<Unlocked> => {
    const r = await call<{ token: string; pngBase64: string; signedAt: string; width: number; height: number }>(
      "sign_unlock",
      { pin },
    );
    return { token: r.token, png: base64ToBytes(r.pngBase64), signedAt: r.signedAt, width: r.width, height: r.height };
  },
  listCandidates: () => call<Candidate[]>("sign_list_candidates"),
  importPdf: (bytes: Uint8Array, fileName: string) =>
    call<ImportedPdf>("sign_import_pdf", bytes, { "x-mira-file-name": encodeURIComponent(fileName) }),
  createRequest: (input: { title: string; fileHash: string; mode: SignMode; signers: string[] }) =>
    call<RequestDetail>("sign_create_request", input),
  getRequest: (id: string) => call<RequestDetail>("sign_get_request", { id }),
  readFile: async (id: string, hash: string) => toBytes(await call<unknown>("sign_read_file", { id, hash })),
  complete: (requestId: string, token: string, baseHash: string, signedPdf: Uint8Array) =>
    call<RequestDetail>("sign_complete", signedPdf, {
      "x-mira-request": requestId,
      "x-mira-token": token,
      "x-mira-base-hash": baseHash,
    }),
  cancel: (id: string) => call<RequestDetail>("sign_cancel", { id }),
  exportFile: (id: string) => call<{ path: string }>("sign_export", { id }),
  verifyFile: (bytes: Uint8Array) => call<VerifyResult>("sign_verify_file", bytes),
};
