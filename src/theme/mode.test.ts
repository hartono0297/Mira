import { describe, expect, it, vi } from "vitest";
import {
  MODE_CACHE_KEY,
  applyTheme,
  parseMode,
  readCachedMode,
  resolveTheme,
  watchSystemTheme,
  writeCachedMode,
} from "./mode";

describe("parseMode", () => {
  it("menerima tiga nilai yang dikenal", () => {
    expect(parseMode("light")).toBe("light");
    expect(parseMode("dark")).toBe("dark");
    expect(parseMode("system")).toBe("system");
  });

  it("mengembalikan system untuk nilai kosong atau tak dikenal", () => {
    expect(parseMode(null)).toBe("system");
    expect(parseMode(undefined)).toBe("system");
    expect(parseMode("")).toBe("system");
    expect(parseMode("Dark")).toBe("system");
    expect(parseMode("biru")).toBe("system");
    expect(parseMode(42)).toBe("system");
  });
});

describe("resolveTheme", () => {
  it("mode terang dan gelap tidak peduli pengaturan Windows", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("mode system mengikuti Windows", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

function fakeMediaQuery(initial: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const mql = {
    matches: initial,
    addEventListener: vi.fn((_: string, fn: (e: { matches: boolean }) => void) => {
      listeners.add(fn);
    }),
    removeEventListener: vi.fn((_: string, fn: (e: { matches: boolean }) => void) => {
      listeners.delete(fn);
    }),
  };
  return {
    mql,
    change(matches: boolean) {
      mql.matches = matches;
      listeners.forEach((fn) => fn({ matches }));
    },
    count: () => listeners.size,
  };
}

describe("watchSystemTheme", () => {
  it("memanggil callback saat Windows berganti terang atau gelap", () => {
    const fake = fakeMediaQuery(false);
    const onChange = vi.fn();
    watchSystemTheme(onChange, () => fake.mql);
    fake.change(true);
    fake.change(false);
    expect(onChange).toHaveBeenNthCalledWith(1, true);
    expect(onChange).toHaveBeenNthCalledWith(2, false);
  });

  it("berhenti memantau setelah fungsi pembersih dipanggil", () => {
    const fake = fakeMediaQuery(false);
    const onChange = vi.fn();
    const stop = watchSystemTheme(onChange, () => fake.mql);
    stop();
    fake.change(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(fake.count()).toBe(0);
  });

  it("tidak gagal kalau matchMedia tidak tersedia", () => {
    const stop = watchSystemTheme(vi.fn(), () => null);
    expect(() => stop()).not.toThrow();
  });
});

describe("salinan mode di localStorage", () => {
  it("menyimpan dan membaca mode", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    writeCachedMode("dark", storage);
    expect(store.get(MODE_CACHE_KEY)).toBe("dark");
    expect(readCachedMode(storage)).toBe("dark");
  });

  it("nilai rusak dibaca sebagai system", () => {
    const storage = { getItem: () => "ungu", setItem: () => {} };
    expect(readCachedMode(storage)).toBe("system");
  });

  it("tidak melempar error kalau storage diblokir", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readCachedMode(storage)).toBe("system");
    expect(() => writeCachedMode("light", storage)).not.toThrow();
  });
});

describe("applyTheme", () => {
  it("memasang data-theme dan color-scheme di elemen akar", () => {
    const root = document.createElement("html");
    applyTheme("dark", root);
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
    applyTheme("light", root);
    expect(root.getAttribute("data-theme")).toBe("light");
    expect(root.style.colorScheme).toBe("light");
  });
});
