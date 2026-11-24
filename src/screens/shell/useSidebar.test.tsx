import { act, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { router } from "../../test/fixtures";
import {
  isSidebarShortcut,
  NARROW_QUERY,
  SIDEBAR_CACHE_KEY,
  SIDEBAR_ID,
  SIDEBAR_SETTING_KEY,
  useSidebar,
} from "./useSidebar";

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

describe("pintasan Ctrl+B", () => {
  const ev = (init: Partial<KeyboardEvent>) => new KeyboardEvent("keydown", { ctrlKey: true, ...init });

  it("dicocokkan dari huruf yang diketik, bukan posisi tombol", () => {
    expect(isSidebarShortcut(ev({ key: "b", code: "KeyB" }), false)).toBe(true);
    expect(isSidebarShortcut(ev({ key: "B", code: "KeyB" }), false)).toBe(true);
    // Dvorak: tombol fisik KeyB mengetik x, dan b ada di KeyN.
    expect(isSidebarShortcut(ev({ key: "x", code: "KeyB" }), false)).toBe(false);
    expect(isSidebarShortcut(ev({ key: "b", code: "KeyN" }), false)).toBe(true);
    // Huruf bukan Latin (Rusia): posisi tombol dipakai.
    expect(isSidebarShortcut(ev({ key: "и", code: "KeyB" }), false)).toBe(true);
    expect(isSidebarShortcut(ev({ key: "и", code: "KeyN" }), false)).toBe(false);
  });

  it("macOS memakai Cmd, bukan Ctrl", () => {
    expect(isSidebarShortcut(ev({ key: "b", code: "KeyB" }), true)).toBe(false);
    expect(isSidebarShortcut(new KeyboardEvent("keydown", { key: "b", metaKey: true }), true)).toBe(true);
  });

  it("diabaikan saat menu konteks terbuka", () => {
    const { result } = renderHook(() => useSidebar());
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.appendChild(menu);
    try {
      act(() => pressCtrlB());
      expect(result.current.collapsed).toBe(false);
    } finally {
      menu.remove();
    }
  });

  it("diabaikan saat tenggat sedang diseret di Kalender", () => {
    const { result } = renderHook(() => useSidebar());
    document.documentElement.classList.add("cal-dragging");
    try {
      act(() => pressCtrlB());
      expect(result.current.collapsed).toBe(false);
    } finally {
      document.documentElement.classList.remove("cal-dragging");
    }
  });
});

describe("sidebar yang dibuka sementara di jendela sempit", () => {
  it("tertutup lagi saat menu dipilih", () => {
    media.matches = true;
    const { result, rerender } = renderHook(({ section }) => useSidebar(section), { initialProps: { section: "chat" } });
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(false);
    rerender({ section: "board" });
    expect(result.current.collapsed).toBe(true);
  });

  it("Escape menutupnya, kecuali fokus ada di isian di luar sidebar", () => {
    media.matches = true;
    const { result } = renderHook(() => useSidebar());
    act(() => result.current.toggle());

    const input = document.createElement("input");
    document.body.appendChild(input);
    try {
      input.focus();
      act(() => {
        fireEvent.keyDown(input, { key: "Escape" });
      });
      expect(result.current.collapsed).toBe(false);
      input.blur();
    } finally {
      input.remove();
    }

    act(() => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    expect(result.current.collapsed).toBe(true);
  });

  it("Escape tidak mengubah sidebar lebar biasa", () => {
    const { result } = renderHook(() => useSidebar());
    act(() => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    expect(result.current.collapsed).toBe(false);
  });
});

describe("fokus saat sidebar berganti bentuk", () => {
  // Kerangka kecil yang meniru sidebar: tombol coba lagi hanya di panel lebar,
  // ikon jaringan hanya di mode ringkas.
  function Frame({ retry = true }: { retry?: boolean }) {
    const { collapsed, toggle } = useSidebar();
    return (
      <aside id={SIDEBAR_ID}>
        <button type="button" className="side-toggle" onClick={toggle}>
          balik
        </button>
        <button type="button" className="side-link">
          menu
        </button>
        {collapsed ? (
          <section className="side-net-dot">
            <button type="button" className="side-dot">
              ikon
            </button>
          </section>
        ) : (
          <section className="side-net">
            {retry && (
              <button type="button" className="side-retry">
                coba lagi
              </button>
            )}
          </section>
        )}
      </aside>
    );
  }

  it("tombol coba lagi yang hilang memindahkan fokus ke ikon jaringan, lalu kembali", () => {
    const { getByText } = render(<Frame />);
    getByText("coba lagi").focus();
    act(() => pressCtrlB(getByText("coba lagi")));
    expect(getByText("ikon")).toHaveFocus();
    act(() => pressCtrlB(getByText("ikon")));
    expect(getByText("coba lagi")).toHaveFocus();
  });

  it("tanpa padanan, fokus pindah ke tombol ringkas/lebarkan", () => {
    const { getByText } = render(<Frame retry={false} />);
    act(() => pressCtrlB());
    getByText("ikon").focus();
    act(() => pressCtrlB(getByText("ikon")));
    expect(getByText("balik")).toHaveFocus();
  });

  it("fokus yang tidak hilang tidak dipindahkan", () => {
    const { getByText } = render(<Frame />);
    getByText("menu").focus();
    act(() => pressCtrlB(getByText("menu")));
    expect(getByText("menu")).toHaveFocus();
  });

  it("tanpa fokus sebelumnya, fokus tidak dipindahkan", () => {
    const { getByText } = render(<Frame />);
    act(() => pressCtrlB());
    expect(getByText("balik")).not.toHaveFocus();
    expect(document.activeElement).toBe(document.body);
  });
});
