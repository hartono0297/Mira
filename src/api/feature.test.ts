// Event sinkron fitur dan perintah baru untuk dokumen dan tanda tangan.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FEATURE_EVENT, subscribeFeature } from ".";
import { downloadVersion } from "./documents";
import { signingApi } from "./signing";

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  listen.mockReset();
});

describe("subscribeFeature", () => {
  it("hanya memanggil handler untuk topiknya sendiri", async () => {
    const unlisten = vi.fn();
    listen.mockResolvedValue(unlisten);
    const handler = vi.fn();
    const stop = subscribeFeature("docs", handler);
    expect(listen).toHaveBeenCalledWith(FEATURE_EVENT, expect.any(Function));
    const emit = listen.mock.calls[0][1] as (e: { payload: unknown }) => void;

    emit({ payload: { topic: "sign" } });
    emit({ payload: { topic: "board" } });
    emit({ payload: null });
    emit({ payload: "docs" });
    expect(handler).not.toHaveBeenCalled();

    emit({ payload: { topic: "docs" } });
    expect(handler).toHaveBeenCalledTimes(1);

    await Promise.resolve();
    stop();
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalled());
    // Setelah berhenti, event yang masih datang tidak diteruskan.
    emit({ payload: { topic: "docs" } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("di luar aplikasi desktop tidak berlangganan", () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    expect(subscribeFeature("sign", () => {})).toBeTypeOf("function");
    expect(listen).not.toHaveBeenCalled();
  });
});

describe("perintah sinkron", () => {
  it("download_version, sign_download_file, dan calon per proyek memakai argumen kontrak", async () => {
    invoke.mockResolvedValue([]);
    await downloadVersion("d1", "v4");
    await signingApi.downloadFile("r1");
    await signingApi.listCandidates();
    await signingApi.listCandidates({ projectId: "p1", teamId: "t1" });
    await signingApi.createRequest({
      title: "Uji",
      fileHash: "f".repeat(64),
      mode: "sequential",
      signers: ["a"],
      projectId: "p1",
      teamId: null,
    });
    expect(invoke.mock.calls).toEqual([
      ["download_version", { documentId: "d1", versionId: "v4" }],
      ["sign_download_file", { requestId: "r1" }, undefined],
      ["sign_list_candidates", { projectId: null, teamId: null }, undefined],
      ["sign_list_candidates", { projectId: "p1", teamId: "t1" }, undefined],
      [
        "sign_create_request",
        { title: "Uji", fileHash: "f".repeat(64), mode: "sequential", signers: ["a"], projectId: "p1", teamId: null },
        undefined,
      ],
    ]);
  });

  it("not_available diteruskan sebagai AppError", async () => {
    invoke.mockRejectedValue({ code: "not_available", message: "Tidak ada rekan." });
    await expect(downloadVersion("d1", "v4")).rejects.toEqual({ code: "not_available", message: "Tidak ada rekan." });
  });
});
