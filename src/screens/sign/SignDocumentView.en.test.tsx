import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestDetail, SignOverview } from "../../api/signing";
import type { PageGeometry } from "../../components/pdf/types";
import { setLang } from "../../i18n/core";
import { renderInLang } from "../../test/i18n";

const PAGES: PageGeometry[] = [{ index: 0, view: [0, 0, 595, 842], width: 595, height: 842, rotation: 0 }];

const api = vi.hoisted(() => ({
  overview: vi.fn(),
  getRequest: vi.fn(),
  readFile: vi.fn(),
  saveSignature: vi.fn(),
  cancel: vi.fn(),
  exportFile: vi.fn(),
  downloadFile: vi.fn(),
}));

vi.mock("../../api/signing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/signing")>()),
  signingApi: api,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));

vi.mock("../../components/pdf/PdfViewer", async () => {
  const { useEffect } = await import("react");
  return {
    PdfViewer: (props: {
      onLoaded?: (i: { pageCount: number; pages: PageGeometry[] }) => void;
      renderOverlay?: (info: unknown) => unknown;
    }) => {
      useEffect(() => {
        props.onLoaded?.({ pageCount: PAGES.length, pages: PAGES });
      }, []);
      const info = { ...PAGES[0], scale: 1, cssWidth: 595, cssHeight: 842 };
      return <div data-testid="viewer">{props.renderOverlay?.(info) as never}</div>;
    },
  };
});

import { SignDocumentView } from "./SignDocumentView";

const ME = "a1b2c3d4e5f60718" + "0".repeat(48);
const OTHER = "ffee0011223344aa" + "1".repeat(48);

const DETAIL: RequestDetail = {
  id: "req-uji",
  title: "Kontrak uji",
  mode: "sequential",
  status: "in_progress",
  myState: "your_turn",
  signedCount: 0,
  signerCount: 2,
  createdAt: "2026-11-20T02:00:00Z",
  updatedAt: "2026-11-21T02:00:00Z",
  completedAt: null,
  integrity: "intact",
  exportWarnings: 0,
  fromPeer: true,
  requestedByName: "Pengirim Uji",
  fileAvailable: true,
  fileSize: 1024,
  pending: false,
  downloadSize: 0,
  downloading: false,
  scope: { teamId: null, projectId: null },
  rejected: [],
  requestedBy: { publicKey: OTHER, displayName: "Pengirim Uji" },
  originalHash: "ab".repeat(32),
  currentHash: "cd".repeat(32),
  signers: [
    {
      position: 1,
      publicKey: ME,
      displayName: "Penanda Uji",
      kind: "member",
      status: "waiting",
      signedAt: null,
      hashAfter: null,
      isMe: true,
      canSignNow: true,
    },
    {
      position: 2,
      publicKey: OTHER,
      displayName: "Rekan Uji",
      kind: "guest",
      status: "waiting",
      signedAt: null,
      hashAfter: null,
      isMe: false,
      canSignNow: false,
    },
  ],
  events: [],
  exports: [],
  isLastPending: false,
  docTag: "mira-doc:uji",
  sealValid: null,
};

const OVERVIEW: SignOverview = {
  saved: { width: 400, height: 200, createdAt: "2026-11-01T00:00:00Z", failedAttempts: 0, lockedUntil: null, attemptsLeft: 5, usableAfter: null },
  requests: [],
  canRequest: true,
  me: { publicKey: ME, displayName: "Penanda Uji", kind: "member" },
};

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.getRequest.mockResolvedValue(DETAIL);
  api.overview.mockResolvedValue(OVERVIEW);
  api.readFile.mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
});

afterEach(() => {
  setLang("id");
});

describe("SignDocumentView in English", () => {
  it("shows the document panel and placing controls in English", async () => {
    const user = userEvent.setup();
    renderInLang(() => <SignDocumentView requestId="req-uji" onBack={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Signing order" })).toBeInTheDocument();
    expect(screen.getByText("Requested by Pengirim Uji")).toBeInTheDocument();
    expect(screen.getByText("In order: each person waits for the previous person's turn.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "File authenticity" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save a PDF copy" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "Place signature" }));
    expect(screen.getByRole("button", { name: "Bottom right" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finish and sign" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Box size" })).toBeInTheDocument();

    // Hanya teks dari kamus layar ini; arah posisi (describeSpot) berasal dari signFlow.
    for (const id of ["Urutan penanda tangan", "Keaslian file", "Simpan salinan PDF", "Kembali", "Diminta oleh", "Kotak ada di halaman"]) {
      expect(screen.queryByText(id, { exact: false })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Kanan bawah" })).not.toBeInTheDocument();
  });
});
