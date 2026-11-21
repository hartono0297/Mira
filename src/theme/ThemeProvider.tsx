import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, isTauri, toAppError, type AppError } from "../api";
import {
  MODE_SETTING_KEY,
  THEME_SETTING_KEY,
  applyTheme,
  parseMode,
  readCachedMode,
  resolveTheme,
  systemPrefersDark,
  watchSystemTheme,
  writeCachedMode,
  type ThemeMode,
} from "./mode";
import { DEFAULT_THEME, parseThemeName, themeCss, themes, type ResolvedTheme, type ThemeName } from "./tokens";

const STYLE_ID = "mira-theme";

export function installThemeCss(name: ThemeName, doc: Document = document): void {
  let el = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = doc.createElement("style");
    el.id = STYLE_ID;
    doc.head.appendChild(el);
  }
  el.textContent = themeCss(themes[name]);
}

// Dipanggil di awal main.tsx sebelum React render, supaya warna sudah benar
// di frame pertama (skrip inline di index.html dilarang CSP).
export function bootTheme(): void {
  installThemeCss(DEFAULT_THEME);
  applyTheme(resolveTheme(readCachedMode(), systemPrefersDark()));
}

type ThemeContextValue = {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  themeName: ThemeName;
  // Menyimpan ke inti Rust. Kalau gagal, pilihan dikembalikan dan error dilempar.
  setMode: (mode: ThemeMode) => Promise<void>;
  loadError: AppError | null;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => readCachedMode());
  const [systemDark, setSystemDark] = useState(() => systemPrefersDark());
  const [themeName, setThemeName] = useState<ThemeName>(DEFAULT_THEME);
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const userChanged = useRef(false);
  const requestId = useRef(0);

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    Promise.all([api.getSetting(MODE_SETTING_KEY), api.getSetting(THEME_SETTING_KEY)])
      .then(([storedMode, storedTheme]) => {
        if (!active) return;
        setThemeName(parseThemeName(storedTheme));
        if (userChanged.current) return;
        const parsed = parseMode(storedMode);
        setModeState(parsed);
        writeCachedMode(parsed);
      })
      .catch((err) => {
        if (active) setLoadError(toAppError(err));
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => watchSystemTheme(setSystemDark), []);

  const resolved = resolveTheme(mode, systemDark);

  useEffect(() => {
    installThemeCss(themeName);
  }, [themeName]);

  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  const setMode = useCallback(
    async (next: ThemeMode) => {
      userChanged.current = true;
      const previous = mode;
      const id = ++requestId.current;
      setModeState(next);
      try {
        await api.setSetting(MODE_SETTING_KEY, next);
        writeCachedMode(next);
        setLoadError(null);
      } catch (err) {
        if (id === requestId.current) setModeState(previous);
        throw toAppError(err);
      }
    },
    [mode],
  );

  const value = useMemo(
    () => ({ mode, resolved, themeName, setMode, loadError }),
    [mode, resolved, themeName, setMode, loadError],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme harus dipakai di dalam ThemeProvider");
  return ctx;
}
