import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { router } from "../../test/fixtures";
import { useNavCounts } from "./useNavCounts";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

// Tiruan listen: menyimpan semua handler per event supaya tes bisa memancarkan event dari "Rust".
const handlers = vi.hoisted(() => new Map<string, Set<(e: { payload?: unknown }) => void>>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, handler: (e: { payload?: unknown }) => void) => {
    const set = handlers.get(event) ?? new Set();
    set.add(handler);
    handlers.set(event, set);
    return () => set.delete(handler);
  },
}));

function emit(event: string, payload?: unknown) {
  for (const h of handlers.get(event) ?? []) h({ payload });
}

const chat = (unread: number) => ({
  conversations: [
    { archived: false, muted: false, unread },
    { archived: false, muted: true, unread: 9 },
  ],
});
const sign = (waiting: number) => ({
  requests: Array.from({ length: waiting }, () => ({ status: "in_progress", myState: "your_turn" })),
});
const myTasks = (dues: string[]) =>
  dues.map((due, i) => ({
    projectId: "p1",
    projectCode: "PRJ",
    projectName: "Proyek Uji",
    task: { id: `t${i}`, code: `PRJ-${i}`, title: "Task", columnId: "todo", assignee: null, due, priority: "none", labels: [], commentCount: 0, merged: false },
  }));
const org = (pending: number, decide: string[] = ["t1"]) => ({ pendingJoinCount: pending, decideJoinTeamIds: decide });

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  handlers.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useNavCounts", () => {
  it("mulai dari nol lalu menggabungkan keempat sumber", async () => {
    invoke.mockImplementation(
      router({
        chat_overview: chat(3),
        board_my_tasks: myTasks(["2000-01-01"]),
        sign_overview: sign(2),
        org_overview: org(4),
      }),
    );
    const { result } = renderHook(() => useNavCounts());
    expect(result.current).toEqual({ chat: 0, board: 0, sign: 0, org: 0 });
    await waitFor(() => expect(result.current).toEqual({ chat: 3, board: 1, sign: 2, org: 4 }));
  });

  it("sumber yang gagal tetap nol tanpa mengganggu yang lain", async () => {
    invoke.mockImplementation(
      router({
        chat_overview: () => {
          throw { code: "internal", message: "Gagal membaca chat." };
        },
        board_my_tasks: () => Promise.reject(new Error("rusak")),
        sign_overview: sign(1),
        org_overview: org(2, []),
      }),
    );
    const { result } = renderHook(() => useNavCounts());
    await waitFor(() => expect(result.current.sign).toBe(1));
    expect(result.current).toEqual({ chat: 0, board: 0, sign: 1, org: 0 });
  });

  it("memuat ulang saat event fitur dan saat jendela kembali aktif", async () => {
    let unread = 1;
    let waiting = 0;
    invoke.mockImplementation(
      router({
        chat_overview: () => chat(unread),
        board_my_tasks: [],
        sign_overview: () => sign(waiting),
        org_overview: org(0),
      }),
    );
    const { result } = renderHook(() => useNavCounts());
    await waitFor(() => expect(result.current.chat).toBe(1));
    await waitFor(() => expect(handlers.get("mira://feature")?.size).toBeGreaterThan(0));

    unread = 5;
    waiting = 2;
    act(() => emit("mira://feature", { topic: "sign" }));
    await waitFor(() => expect(result.current.sign).toBe(2));
    // Topik sign tidak memuat ulang chat.
    expect(result.current.chat).toBe(1);

    act(() => emit("mira://feature", { topic: "chat" }));
    await waitFor(() => expect(result.current.chat).toBe(5));

    unread = 0;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(result.current.chat).toBe(0));
  });

  it("angka Board ikut berganti hari tanpa perubahan data", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 23, 23, 59));
    invoke.mockImplementation(
      router({ chat_overview: chat(0), board_my_tasks: myTasks(["2026-11-24"]), sign_overview: sign(0), org_overview: org(0) }),
    );
    const { result } = renderHook(() => useNavCounts());
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("board_my_tasks", undefined));
    await act(async () => {});
    expect(result.current.board).toBe(0);

    vi.setSystemTime(new Date(2026, 10, 24, 0, 1));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(result.current.board).toBe(1));
  });

  it("berhenti mendengarkan saat dilepas", async () => {
    invoke.mockImplementation(router({ chat_overview: chat(0), board_my_tasks: [], sign_overview: sign(0), org_overview: org(0) }));
    const { unmount } = renderHook(() => useNavCounts());
    await waitFor(() => expect(handlers.get("mira://feature")?.size).toBeGreaterThan(0));
    unmount();
    await waitFor(() => expect(handlers.get("mira://feature")?.size ?? 0).toBe(0));
    const calls = invoke.mock.calls.length;
    window.dispatchEvent(new Event("focus"));
    expect(invoke.mock.calls.length).toBe(calls);
  });
});
