// Sidebar lebar atau ringkas (rencana sidebar-kalender bagian 1). Pilihan
// disimpan di pengaturan lokal inti Rust, sama seperti mode tema; salinan di
// localStorage hanya untuk frame pertama. Jendela di bawah 900 px selalu
// mulai ringkas, dan membukanya di sana tidak mengubah pilihan tersimpan.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, isTauri } from "../../api";
import { isMac } from "../../platform";

export const SIDEBAR_SETTING_KEY = "shell.sidebar";
export const SIDEBAR_CACHE_KEY = "mira.sidebar";
export const NARROW_QUERY = "(max-width: 899px)";

type SidebarValue = "collapsed" | "expanded";

function toValue(collapsed: boolean): SidebarValue {
  return collapsed ? "collapsed" : "expanded";
}

export function parseSidebar(value: unknown): boolean {
  return value === "collapsed";
}

function readCache(): boolean {
  try {
    return parseSidebar(window.localStorage.getItem(SIDEBAR_CACHE_KEY));
  } catch {
    return false;
  }
}

function writeCache(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_CACHE_KEY, toValue(collapsed));
  } catch {
    // Storage diblokir: frame pertama berikutnya memakai bawaan (lebar).
  }
}

function narrowQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(NARROW_QUERY);
}

// Dialog modal terbuka: pintasan sidebar tidak boleh mengubah apa pun di
// belakangnya. Dialog Radix (components/Dialog, TaskDetail) tidak memberi
// aria-modal, jadi dikenali dari role dan data-state yang selalu ia pasang.
const MODAL_SELECTOR = '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"], [role="dialog"][data-state="open"]';

function modalOpen(): boolean {
  return document.querySelector(MODAL_SELECTOR) !== null;
}

export function isSidebarShortcut(e: KeyboardEvent, mac: boolean = isMac()): boolean {
  if (e.altKey || e.shiftKey) return false;
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return mod && (e.code === "KeyB" || e.key.toLowerCase() === "b");
}

export function sidebarKeys(mac: boolean = isMac()): string {
  return mac ? "Cmd+B" : "Ctrl+B";
}

export function useSidebar(): {
  collapsed: boolean;
  chosen: boolean;
  narrow: boolean;
  toggle: () => void;
} {
  const [chosen, setChosen] = useState(readCache);
  const [narrow, setNarrow] = useState(() => narrowQuery()?.matches ?? false);
  // Dibuka sementara di jendela sempit. Hilang begitu lebar jendela berubah.
  const [peek, setPeek] = useState(false);
  const userChanged = useRef(false);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    api
      .getSetting(SIDEBAR_SETTING_KEY)
      .then((stored) => {
        if (!active || userChanged.current) return;
        const value = parseSidebar(stored);
        setChosen(value);
        writeCache(value);
      })
      .catch(() => {
        // Tetap memakai salinan lokal.
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const mql = narrowQuery();
    if (!mql) return;
    const onChange = (e: { matches: boolean }) => {
      setNarrow(e.matches);
      setPeek(false);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const state = useRef({ chosen, narrow });
  state.current = { chosen, narrow };

  const toggle = useCallback(() => {
    if (state.current.narrow) {
      setPeek((p) => !p);
      return;
    }
    userChanged.current = true;
    const next = !state.current.chosen;
    state.current.chosen = next;
    setChosen(next);
    writeCache(next);
    if (!isTauri()) return;
    // Berurutan supaya klik cepat tersimpan sesuai urutan. Gagal simpan
    // diabaikan: tampilan tetap berubah, hanya tidak diingat di start berikutnya.
    saveQueue.current = saveQueue.current
      .then(() => api.setSetting(SIDEBAR_SETTING_KEY, toValue(next)))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || !isSidebarShortcut(e) || modalOpen()) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  return { collapsed: narrow ? !peek : chosen, chosen, narrow, toggle };
}
