// Pembungkus command dokumen di src/api/documents.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NO_TAURI_ERROR } from "../../api";
import {
  addDocuments,
  exportVersion,
  pickExportDestination,
  pickFilesToAdd,
  resolveConflict,
  startEdit,
  subscribeDocuments,
} from "../../api/documents";

const invoke = vi.hoisted(() => vi.fn());
const dialog = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }));
const listen = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  dialog.open.mockReset();
  dialog.save.mockReset();
  listen.mockReset();
});

describe("api dokumen", () => {
  it("mengirim argumen camelCase sesuai kontrak", async () => {
    invoke.mockResolvedValue(null);
    await addDocuments(["C:\\a.docx"], null);
    await startEdit("d1", "v2");
    await resolveConflict("d1", "v5");
    await exportVersion("d1", null, "D:\\salinan.docx");
    expect(invoke.mock.calls).toEqual([
      ["add_documents", { paths: ["C:\\a.docx"], projectId: null }],
      ["start_edit", { documentId: "d1", fromVersionId: "v2" }],
      ["resolve_conflict", { documentId: "d1", keepVersionId: "v5" }],
      ["export_version", { documentId: "d1", versionId: null, destination: "D:\\salinan.docx" }],
    ]);
  });

  it("error dari Rust diteruskan sebagai AppError", async () => {
    invoke.mockRejectedValue({ code: "document_editing", message: "Dokumen sedang diedit." });
    await expect(startEdit("d1", null)).rejects.toEqual({ code: "document_editing", message: "Dokumen sedang diedit." });
  });

  it("dialog pilih file: banyak file, batal = null", async () => {
    dialog.open.mockResolvedValueOnce(["C:\\a.docx", "C:\\b.xlsx"]).mockResolvedValueOnce(null);
    expect(await pickFilesToAdd()).toEqual(["C:\\a.docx", "C:\\b.xlsx"]);
    expect(dialog.open).toHaveBeenCalledWith({ multiple: true, directory: false });
    expect(await pickFilesToAdd()).toBeNull();
  });

  it("dialog simpan memakai nama file sebagai bawaan", async () => {
    dialog.save.mockResolvedValue("D:\\x.docx");
    expect(await pickExportDestination("x.docx")).toBe("D:\\x.docx");
    expect(dialog.save).toHaveBeenCalledWith({ defaultPath: "x.docx" });
  });

  it("di luar aplikasi desktop tidak memanggil Tauri", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    await expect(addDocuments([], null)).rejects.toEqual(NO_TAURI_ERROR);
    await expect(pickFilesToAdd()).rejects.toEqual(NO_TAURI_ERROR);
    expect(subscribeDocuments(() => {})).toBeTypeOf("function");
    expect(invoke).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it("berlangganan event mira://documents dan berhenti dengan aman", async () => {
    const unlisten = vi.fn();
    listen.mockResolvedValue(unlisten);
    const handler = vi.fn();
    const stop = subscribeDocuments(handler);
    expect(listen).toHaveBeenCalledWith("mira://documents", expect.any(Function));
    (listen.mock.calls[0][1] as () => void)();
    expect(handler).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    stop();
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalled());
  });
});
