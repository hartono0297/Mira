// Sidebar lebar atau ringkas (rencana sidebar-kalender bagian 1). Pilihan
// disimpan di pengaturan lokal inti Rust, sama seperti mode tema; salinan di
// localStorage hanya untuk frame pertama. Jendela di bawah 900 px selalu
// mulai ringkas, dan membukanya di sana tidak mengubah pilihan tersimpan.
//
// tauri.conf.json memberi jendela minWidth 900, jadi "sempit" hanya terjadi
// kalau WebView diperbesar (zoom), karena lebar dalam px CSS ikut mengecil.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, isTauri } from "../../api";
import { isMac } from "../../platform";

export const SIDEBAR_SETTING_KEY = "shell.sidebar";
export const SIDEBAR_CACHE_KEY = "mira.sidebar";
export const NARROW_QUERY = "(max-width: 899px)";
export const SIDEBAR_ID = "main-sidebar";

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

// Saat ini pintasan sidebar tidak boleh mengubah apa pun di belakang layar:
// - dialog modal terbuka. Dialog Radix (components/Dialog, TaskDetail) tidak
//   memberi aria-modal, jadi dikenali dari role dan data-state yang selalu ia pasang;
// - menu konteks atau menu Pindahkan terbuka (role="menu");
// - tenggat sedang diseret di Kalender (kelas cal-dragging di <html>, dipasang
//   useDueDrag); sidebar yang berubah lebar memindahkan sel di bawah kursor.
const BLOCKING_SELECTOR =
  '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"], [role="dialog"][data-state="open"], [role="menu"]';
const CAL_DRAGGING = "cal-dragging";

function shortcutBlocked(): boolean {
  return (
    document.querySelector(BLOCKING_SELECTOR) !== null || document.documentElement.classList.contains(CAL_DRAGGING)
  );
}

// Huruf yang diketik menentukan (Ctrl+X di Dvorak ada di posisi tombol B dan
// bukan pintasan ini). Posisi tombol hanya dipakai kalau tata letaknya tidak
// mengetik huruf Latin, misalnya keyboard Rusia.
export function isSidebarShortcut(e: KeyboardEvent, mac: boolean = isMac()): boolean {
  if (e.altKey || e.shiftKey) return false;
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod) return false;
  const key = e.key.toLowerCase();
  return /^[a-z]$/.test(key) ? key === "b" : e.code === "KeyB";
}

export function sidebarKeys(mac: boolean = isMac()): string {
  return mac ? "Cmd+B" : "Ctrl+B";
}

const NET_AREA = ".side-net, .side-net-dot";
const NET_FOCUS = ".side-dot, .side-retry";
const TOGGLE = ".side-toggle";

// Elemen yang difokus bisa hilang saat bentuk sidebar berganti (tombol Coba
// baca lagi di panel lebar, ikon jaringan di mode ringkas). Fokus lalu jatuh
// ke <body>; di sini ia dipindah ke padanannya, atau ke tombol ringkas/lebarkan.
function restoreFocus(before: Element | null): void {
  if (!before || before.isConnected) return;
  const active = document.activeElement;
  if (active && active !== document.body) return;
  const root = document.getElementById(SIDEBAR_ID);
  if (!root) return;
  const wasNet = before.closest(NET_AREA) !== null;
  const target = (wasNet ? root.querySelector<HTMLElement>(NET_FOCUS) : null) ?? root.querySelector<HTMLElement>(TOGGLE);
  target?.focus();
}

// resetKey: berganti saat pengguna memilih menu. Sidebar yang dibuka sementara
// di jendela sempit lalu tertutup lagi, supaya isi layar kembali lega.
export function useSidebar(resetKey?: unknown): {
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
  const focusBefore = useRef<Element | null>(null);

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

  useEffect(() => {
    setPeek(false);
  }, [resetKey]);

  const collapsed = narrow ? !peek : chosen;

  useLayoutEffect(() => {
    restoreFocus(focusBefore.current);
    focusBefore.current = null;
  }, [collapsed]);

  const state = useRef({ chosen, narrow, peek });
  state.current = { chosen, narrow, peek };

  const toggle = useCallback(() => {
    focusBefore.current = document.activeElement;
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
      if (e.defaultPrevented || e.repeat) return;
      if (e.key === "Escape") {
        // Escape menutup sidebar yang dibuka sementara, asal fokus di sidebar
        // atau tidak di mana pun (Escape di isian layar milik isian itu).
        const active = document.activeElement;
        const free = !active || active === document.body || active.closest(`#${SIDEBAR_ID}`) !== null;
        if (state.current.narrow && state.current.peek && free && !shortcutBlocked()) {
          focusBefore.current = active;
          setPeek(false);
        }
        return;
      }
      if (!isSidebarShortcut(e) || shortcutBlocked()) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  return { collapsed, chosen, narrow, toggle };
}
