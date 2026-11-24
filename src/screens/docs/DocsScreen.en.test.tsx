// Layar Dokumen dalam bahasa Inggris: teks utama ikut bahasa aktif, data
// pengguna (nama file, nama rekan) tetap apa adanya.
import { act, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../../i18n/core";
import { renderInLang } from "../../test/i18n";
import { DocsScreen } from "./DocsScreen";
import { clockTime, statusLines } from "./text";
import { detailOf, meRef, rekanC, summary, version } from "./testData";

const docsApi = vi.hoisted(() => ({
  listDocuments: vi.fn(),
  getDocument: vi.fn(),
  addDocuments: vi.fn(),
  startEdit: vi.fn(),
  finishEdit: vi.fn(),
  openReadOnly: vi.fn(),
  restoreVersion: vi.fn(),
  resolveConflict: vi.fn(),
  exportVersion: vi.fn(),
  pickFilesToAdd: vi.fn(),
  pickExportDestination: vi.fn(),
  downloadVersion: vi.fn(),
  subscribeDocuments: vi.fn((_handler: () => void): (() => void) => () => {}),
}));
vi.mock("../../api/documents", () => docsApi);

vi.mock("../../api/board", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/board")>()),
  boardApi: { listProjects: vi.fn().mockResolvedValue([]) },
  subscribeBoard: () => () => {},
}));

vi.mock("../../api/org", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/org")>()),
  orgApi: {
    overview: vi
      .fn()
      .mockResolvedValue({ publicKey: "me", isSuperadmin: false, isGuest: false, departmentId: null, decideJoinTeamIds: [] }),
  },
  subscribeOrg: () => () => {},
}));

const v4 = version("d4", 4, { isHead: true, author: rekanC, received: true });
const v5 = version("d4", 5, { isHead: true, parentIds: ["d4-v3"] });
const kontrak = summary("d4", "kontrak.docx", {
  current: v5,
  versionCount: 5,
  conflict: true,
  conflictVersions: [v5, v4],
});
const laporan = summary("d1", "laporan-bulanan.docx", {
  current: version("d1", 3, { isHead: true }),
  versionCount: 3,
});

beforeEach(() => {
  window.localStorage.clear();
  docsApi.listDocuments.mockResolvedValue([kontrak, laporan]);
  docsApi.getDocument.mockImplementation(async (id: string) =>
    detailOf(id === kontrak.id ? kontrak : laporan),
  );
});

afterEach(() => {
  act(() => setLang("id"));
});

describe("layar Dokumen dalam bahasa Inggris", () => {
  it("judul, lokasi, baris file, dan kotak bentrok memakai bahasa Inggris", async () => {
    renderInLang(() => <DocsScreen />);

    expect(await screen.findByRole("heading", { level: 1, name: "Documents" })).toBeInTheDocument();
    expect(screen.getByLabelText("Location")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Shared library" })).toBeInTheDocument();
    expect(
      screen.getByText("Files in the shared library are visible to everyone in the organization except guests."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add files" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Files in the shared library" })).toBeInTheDocument();
    expect(await screen.findByText("Conflict: versions 4 and 5 saved side by side")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resolve conflict kontrak.docx" })).toBeInTheDocument();

    // Panel detail: file bentrok terpilih lebih dulu.
    expect(await screen.findByText("Two versions saved side by side")).toBeInTheDocument();
    expect(screen.getByText("Version 4 by Rekan C")).toBeInTheDocument();
    expect(screen.getByText("Version 5 by you")).toBeInTheDocument();
    expect(screen.getByText("Version history")).toBeInTheDocument();

    // Data pengguna tidak diterjemahkan; teks Indonesia kunci tidak muncul.
    expect(screen.getAllByText("kontrak.docx").length).toBeGreaterThan(0);
    for (const text of [/Dokumen/, /Pustaka Umum/, /Lokasi/, /Tambah file/, /Bentrok/, /Riwayat versi/, /Anda/]) {
      expect(screen.queryByText(text)).toBeNull();
    }
  });

  it("ganti bahasa di tengah jalan langsung mengganti teks", async () => {
    renderInLang(() => <DocsScreen />, "id");
    expect(await screen.findByRole("heading", { level: 1, name: "Dokumen" })).toBeInTheDocument();
    act(() => setLang("en"));
    expect(screen.getByRole("heading", { level: 1, name: "Documents" })).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Files in the shared library" });
    expect(within(list).queryByText(/Bentrok/)).toBeNull();
  });

  it("jam dan baris status memakai format Inggris", () => {
    setLang("en");
    const now = new Date(2026, 10, 22, 14, 0);
    expect(clockTime(new Date(2026, 10, 22, 9, 12).toISOString(), now)).toBe("09:12");
    expect(clockTime(new Date(2026, 10, 21, 9, 5).toISOString(), now)).toBe("yesterday 09:05");
    const lines = statusLines(
      summary("x", "x.docx", {
        editing: [
          { editor: meRef, since: new Date(2026, 10, 22, 10, 15).toISOString(), local: true, lastSavedAt: null },
          { editor: rekanC, since: new Date(2026, 10, 22, 10, 15).toISOString(), local: false, lastSavedAt: null },
        ],
      }),
      now,
    );
    expect(lines.map((l) => l.text)).toEqual([
      "You've been editing in Word since 10:15",
      "Rekan C has been editing since 10:15",
    ]);
  });
});
