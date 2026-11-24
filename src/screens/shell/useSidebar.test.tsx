import { act, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { router } from "../../test/fixtures";
import { NARROW_QUERY, SIDEBAR_CACHE_KEY, SIDEBAR_SETTING_KEY, useSidebar } from "./useSidebar";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

// matchMedia tiruan: tes bisa mengubah lebar jendela dan memancarkan "change".
type Listener = (e: { matches: boolean }) => void;
const media = { matches: false, listeners: new Set<Listener>() };

function setNarrow(matches: boolean) {
  media.matches = matches;
  for (const fn of [...media.listeners]) fn({ matches });
}

function savedValues() {
  return invoke.mock.calls
    .filter(([cmd, args]) => cmd === "set_setting" && args?.key === SIDEBAR_SETTING_KEY)
    .map(([, args]) => args.value);
}

function pressCtrlB(target: Window | Element = window) {
  fireEvent.keyDown(target, { key: "b", code: "KeyB", ctrlKey: true });
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  invoke.mockImplementation(router({}));
  window.localStorage.clear();
  media.matches = false;
  media.listeners.clear();
  window.matchMedia = vi.fn((query: string) => {
    expect(query).toBe(NARROW_QUERY);
    return {
      get matches() {
        return media.matches;
      },
      addEventListener: (_: string, fn: Listener) => media.listeners.add(fn),
      removeEventListener: (_: string, fn: Listener) => media.listeners.delete(fn),
    } as unknown as MediaQueryList;
  });
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("useSidebar", () => {
  it("bawaan lebar kalau belum ada pilihan", async () => {
    const { result } = renderHook(() => useSidebar());
    expect(result.current.collapsed).toBe(false);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_setting", { key: SIDEBAR_SETTING_KEY }));
    expect(result.current.collapsed).toBe(false);
  });

  it("membaca pilihan tersimpan di inti Rust", async () => {
    invoke.mockImplementation(router({ get_setting: (a) => (a?.key === SIDEBAR_SETTING_KEY ? "collapsed" : null) }));
    const { result } = renderHook(() => useSidebar());
    await waitFor(() => expect(result.current.collapsed).toBe(true));
    expect(result.current.chosen).toBe(true);
    expect(window.localStorage.getItem(SIDEBAR_CACHE_KEY)).toBe("collapsed");
  });

  it("frame pertama memakai salinan localStorage", () => {
    window.localStorage.setItem(SIDEBAR_CACHE_KEY, "collapsed");
    invoke.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useSidebar());
    expect(result.current.collapsed).toBe(true);
  });

  it("menyimpan saat dibalik", async () => {
    const { result } = renderHook(() => useSidebar());
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(true);
    await waitFor(() => expect(savedValues()).toEqual(["collapsed"]));
    expect(window.localStorage.getItem(SIDEBAR_CACHE_KEY)).toBe("collapsed");
    act(() => result.current.toggle());
    await waitFor(() => expect(savedValues()).toEqual(["collapsed", "expanded"]));
  });

  it("gagal menyimpan tetap membalik tampilan tanpa pesan", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "set_setting") throw { code: "database", message: "gagal" };
      return null;
    });
    const { result } = renderHook(() => useSidebar());
    act(() => result.current.toggle());
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_setting", expect.anything()));
    expect(result.current.collapsed).toBe(true);
  });

  it("pilihan pengguna tidak ditimpa hasil baca yang datang belakangan", async () => {
    let answer: (v: string) => void = () => {};
    invoke.mockImplementation((cmd: string) =>
      cmd === "get_setting" ? new Promise<string>((r) => (answer = r)) : Promise.resolve(null),
    );
    const { result } = renderHook(() => useSidebar());
    act(() => result.current.toggle());
    await act(async () => answer("expanded"));
    expect(result.current.collapsed).toBe(true);
  });

  it("Ctrl+B membalik sidebar", async () => {
    const { result } = renderHook(() => useSidebar());
    act(() => pressCtrlB());
    expect(result.current.collapsed).toBe(true);
    act(() => pressCtrlB(document.body));
    expect(result.current.collapsed).toBe(false);
  });

  it("B tanpa Ctrl, Ctrl+Shift+B, dan event yang sudah ditangani diabaikan", () => {
    const { result } = renderHook(() => useSidebar());
    act(() => {
      fireEvent.keyDown(window, { key: "b", code: "KeyB" });
      fireEvent.keyDown(window, { key: "B", code: "KeyB", ctrlKey: true, shiftKey: true });
    });
    expect(result.current.collapsed).toBe(false);

    function Stopper() {
      return <input aria-label="isian" onKeyDown={(e) => e.preventDefault()} />;
    }
    const { getByLabelText } = render(<Stopper />);
    act(() => pressCtrlB(getByLabelText("isian")));
    expect(result.current.collapsed).toBe(false);
  });

  it("Ctrl+B diabaikan saat dialog modal terbuka", () => {
    const { result } = renderHook(() => useSidebar());
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);
    try {
      act(() => pressCtrlB(dialog));
      expect(result.current.collapsed).toBe(false);
    } finally {
      dialog.remove();
    }
  });

  it("Ctrl+B diabaikan saat dialog Radix terbuka", () => {
    const { result } = renderHook(() => useSidebar());
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-state", "open");
    document.body.appendChild(dialog);
    try {
      act(() => pressCtrlB());
      expect(result.current.collapsed).toBe(false);
    } finally {
      dialog.remove();
    }
  });

  it("jendela sempit meringkas otomatis tanpa menyimpan", async () => {
    const { result } = renderHook(() => useSidebar());
    act(() => setNarrow(true));
    expect(result.current.narrow).toBe(true);
    expect(result.current.collapsed).toBe(true);
    expect(result.current.chosen).toBe(false);

    // Dibuka sementara di jendela sempit: tidak disimpan.
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(false);
    act(() => pressCtrlB());
    expect(result.current.collapsed).toBe(true);
    await Promise.resolve();
    expect(savedValues()).toEqual([]);

    // Lebar lagi: pilihan tersimpan (lebar) berlaku.
    act(() => setNarrow(false));
    expect(result.current.collapsed).toBe(false);
  });

  it("jendela sudah sempit saat dibuka", () => {
    media.matches = true;
    const { result } = renderHook(() => useSidebar());
    expect(result.current.collapsed).toBe(true);
  });

  it("tanpa matchMedia tetap jalan", () => {
    (window as { matchMedia?: unknown }).matchMedia = undefined;
    const { result } = renderHook(() => useSidebar());
    expect(result.current.narrow).toBe(false);
  });

  it("di luar Tauri tidak memanggil inti Rust", () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    const { result } = renderHook(() => useSidebar());
    act(() => result.current.toggle());
    expect(invoke).not.toHaveBeenCalled();
    expect(result.current.collapsed).toBe(true);
  });
});
