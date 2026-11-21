import type { ResolvedTheme } from "./tokens";

export type ThemeMode = "light" | "dark" | "system";

export const MODE_SETTING_KEY = "theme.mode";
export const THEME_SETTING_KEY = "theme.name";
// Salinan di localStorage hanya untuk mencegah kedip saat aplikasi dibuka.
// Sumber kebenaran tetap pengaturan di inti Rust (per laptop, per folder data).
export const MODE_CACHE_KEY = "mira.theme.mode";

const MODES: readonly ThemeMode[] = ["light", "dark", "system"];

export function parseMode(value: unknown): ThemeMode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value)
    ? (value as ThemeMode)
    : "system";
}

export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === "system") return systemPrefersDark ? "dark" : "light";
  return mode;
}

type MediaQueryLike = {
  matches: boolean;
  addEventListener(type: "change", fn: (e: { matches: boolean }) => void): void;
  removeEventListener(type: "change", fn: (e: { matches: boolean }) => void): void;
};

const DARK_QUERY = "(prefers-color-scheme: dark)";

function defaultMediaQuery(): MediaQueryLike | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(DARK_QUERY);
}

export function systemPrefersDark(getMql: () => MediaQueryLike | null = defaultMediaQuery): boolean {
  return getMql()?.matches ?? false;
}

// Memantau pergantian terang/gelap di Windows. Mengembalikan fungsi pembersih.
export function watchSystemTheme(
  onChange: (prefersDark: boolean) => void,
  getMql: () => MediaQueryLike | null = defaultMediaQuery,
): () => void {
  const mql = getMql();
  if (!mql) return () => {};
  const listener = (e: { matches: boolean }) => onChange(e.matches);
  mql.addEventListener("change", listener);
  return () => mql.removeEventListener("change", listener);
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readCachedMode(storage: StorageLike | null = defaultStorage()): ThemeMode {
  try {
    return parseMode(storage?.getItem(MODE_CACHE_KEY));
  } catch {
    return "system";
  }
}

export function writeCachedMode(mode: ThemeMode, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(MODE_CACHE_KEY, mode);
  } catch {
    // Storage diblokir: tidak masalah, hanya kedip sesaat di start berikutnya.
  }
}

export function applyTheme(resolved: ResolvedTheme, root: HTMLElement = document.documentElement): void {
  root.setAttribute("data-theme", resolved);
  root.style.colorScheme = resolved;
}
