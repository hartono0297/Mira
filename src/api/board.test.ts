import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boardApi, BOARD_EVENT, DIRECTORY_EVENT, FEATURE_EVENT, subscribeBoard } from "./board";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, handler: (e: { payload: unknown }) => void) => {
    tauri.handlers.set(event, handler);
    return tauri.unlisten;
  },
}));

function emit(event: string, payload: unknown) {
  tauri.handlers.get(event)?.({ payload });
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  tauri.invoke.mockReset();
  tauri.handlers.clear();
  tauri.unlisten.mockReset();
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("subscribeBoard", () => {
  it("memuat ulang untuk perubahan lokal, sinkron topik board, dan anggota proyek, tidak untuk topik lain", async () => {
    const handler = vi.fn();
    const stop = subscribeBoard(handler);
    await vi.waitFor(() => expect(tauri.handlers.size).toBe(3));

    emit(BOARD_EVENT, null);
    expect(handler).toHaveBeenCalledTimes(1);

    emit(FEATURE_EVENT, { topic: "board" });
    expect(handler).toHaveBeenCalledTimes(2);

    emit(FEATURE_EVENT, { topic: "chat" });
    emit(FEATURE_EVENT, { topic: "documents" });
    emit(FEATURE_EVENT, null);
    emit(FEATURE_EVENT, "board");
    expect(handler).toHaveBeenCalledTimes(2);

    emit(DIRECTORY_EVENT, null);
    expect(handler).toHaveBeenCalledTimes(3);

    stop();
    emit(BOARD_EVENT, null);
    emit(FEATURE_EVENT, { topic: "board" });
    emit(DIRECTORY_EVENT, null);
    expect(handler).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => expect(tauri.unlisten).toHaveBeenCalledTimes(3));
  });

  it("di luar aplikasi desktop tidak berlangganan", () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    const stop = subscribeBoard(vi.fn());
    expect(tauri.handlers.size).toBe(0);
    stop();
  });
});

describe("boardApi.createProject", () => {
  it("mengirim anggota awal, bawaan daftar kosong", async () => {
    tauri.invoke.mockResolvedValue({});
    await boardApi.createProject("Gudang", "GD", "t", ["b"]);
    expect(tauri.invoke).toHaveBeenCalledWith("board_create_project", {
      name: "Gudang",
      code: "GD",
      teamId: "t",
      members: ["b"],
    });
    await boardApi.createProject("Gudang", "GD");
    expect(tauri.invoke).toHaveBeenLastCalledWith("board_create_project", {
      name: "Gudang",
      code: "GD",
      teamId: null,
      members: [],
    });
  });
});

describe("boardApi.updateProject", () => {
  it("memanggil board_update_project dengan id dan nama", async () => {
    const summary = { id: "p", code: "PA", name: "Nama baru", teamId: null, teamName: null, openCount: 0, taskCount: 0, canManage: true };
    tauri.invoke.mockResolvedValue(summary);
    await expect(boardApi.updateProject("p", "Nama baru")).resolves.toEqual(summary);
    expect(tauri.invoke).toHaveBeenCalledWith("board_update_project", { projectId: "p", name: "Nama baru" });
  });
});
