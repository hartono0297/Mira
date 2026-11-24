// Layar daftar Tanda tangan dalam bahasa Inggris, termasuk ganti bahasa di tengah jalan.
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestSummary, SignOverview } from "../../api/signing";
import { setLang } from "../../i18n/core";
import { renderInLang } from "../../test/i18n";
import { SignScreen } from "./SignScreen";

const api = vi.hoisted(() => ({
  overview: vi.fn(),
  saveSignature: vi.fn(),
  deleteSignature: vi.fn(),
  importPdf: vi.fn(),
  listCandidates: vi.fn(),
  createRequest: vi.fn(),
  verifyFile: vi.fn(),
  downloadFile: vi.fn(),
  exportFile: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("../../api/signing", async (orig) => ({
  ...(await orig<typeof import("../../api/signing")>()),
  signingApi: api,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("./SignDocumentView", () => ({ SignDocumentView: () => null }));
vi.mock("./pad/SignatureSetupDialog", () => ({ SignatureSetupDialog: () => null }));

const ME_KEY = "a".repeat(64);

function summary(extra: Partial<RequestSummary> = {}): RequestSummary {
  return {
    id: "1".repeat(32),
    title: "Dokumen Uji",
    mode: "sequential",
    status: "in_progress",
    myState: "waiting_others",
    signedCount: 1,
    signerCount: 2,
    createdAt: "2026-11-22T01:00:00Z",
    updatedAt: "2026-11-22T02:00:00Z",
    completedAt: null,
    integrity: "intact",
    exportWarnings: 0,
    fromPeer: true,
    requestedByName: "Penguji Lain",
    fileAvailable: true,
    fileSize: 2048,
    pending: false,
    downloadSize: 0,
    downloading: false,
    ...extra,
  };
}

function overview(extra: Partial<SignOverview> = {}): SignOverview {
  return {
    saved: null,
    requests: [],
    canRequest: true,
    me: { publicKey: ME_KEY, displayName: "Penguji", kind: "member" },
    ...extra,
  };
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
});

afterEach(() => {
  setLang("id");
});

describe("SignScreen dalam bahasa Inggris", () => {
  it("menampilkan teks Inggris dan tidak menyisakan teks Indonesia kunci", async () => {
    api.overview.mockResolvedValue(overview({ requests: [summary()] }));
    renderInLang(() => <SignScreen />);
    expect(screen.getByText("Loading your signature and documents...")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 1, name: "Signatures" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Waiting for your signature" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "My signature" })).toBeInTheDocument();
    expect(screen.getByText("No saved signature yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create signature" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose a PDF to sign" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check a PDF file" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More actions for Dokumen Uji" })).toBeInTheDocument();
    const row = screen.getByRole("button", { name: /^Dokumen Uji/ });
    expect(within(row).getByText("Requested by Penguji Lain")).toBeInTheDocument();
    expect(within(row).getByText(/1 of 2 signed/)).toBeInTheDocument();
    expect(screen.getByText("Other documents you send or have signed show up here.")).toBeInTheDocument();

    for (const text of [/Tanda tangan saya/, /Menunggu tanda tangan Anda/, /Diminta oleh/, /sudah tanda tangan/, /Buat tanda tangan/]) {
      expect(screen.queryByText(text)).not.toBeInTheDocument();
    }
  });

  it("ganti bahasa ke Indonesia langsung berlaku", async () => {
    api.overview.mockResolvedValue(overview({ canRequest: false }));
    renderInLang(() => <SignScreen />);
    expect(await screen.findByText(/As a Guest, you can't request signatures/)).toBeInTheDocument();
    act(() => setLang("id"));
    expect(screen.getByText(/Sebagai Tamu, Anda tidak bisa meminta tanda tangan/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Tanda tangan" })).toBeInTheDocument();
  });

  it("dialog hapus tanpa PIN dalam bahasa Inggris", async () => {
    api.overview.mockResolvedValue(
      overview({
        saved: {
          width: 300,
          height: 120,
          createdAt: "2026-11-20T03:00:00Z",
          failedAttempts: 0,
          lockedUntil: null,
          attemptsLeft: 5,
          usableAfter: null,
        },
      }),
    );
    const user = userEvent.setup();
    renderInLang(() => <SignScreen />);
    await user.click(await screen.findByRole("button", { name: "Delete signature" }));
    await user.click(await screen.findByRole("button", { name: "Forgot PIN?" }));
    expect(await screen.findByText("This deletion is recorded in the audit trail.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete without PIN" })).toBeInTheDocument();
  });
});
