import { IconClipboard, IconCopy, IconCut, IconSelectAll } from "@tabler/icons-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { menuItems, SEPARATOR, type MenuAction, type MenuEntry } from "./items";
import { MenuPopup, type MenuAnchor } from "./MenuPopup";
import { isTextField } from "./useContextMenu";

function dialogOf(el: Element | null): HTMLElement | null {
  return el?.closest<HTMLElement>("[role=dialog]") ?? null;
}

// setRangeText tidak memicu event input, padahal state React mengikuti event itu.
function setText(el: HTMLInputElement | HTMLTextAreaElement, text: string, start: number, end: number) {
  el.setRangeText(text, start, end, "end");
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

// Teks menu kolom teks, terkumpul di satu tempat.
export const TEXT_MENU = {
  label: "Menu teks",
  cut: "Potong",
  copy: "Salin",
  paste: "Tempel",
  selectAll: "Pilih semua",
  noSelection: "Belum ada teks yang dipilih",
  readOnly: "Kolom ini hanya bisa dibaca",
  secret: "Isi kolom rahasia tidak bisa disalin",
  empty: "Kolom ini masih kosong",
} as const;

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

type Saved =
  | { kind: "input"; el: HTMLInputElement | HTMLTextAreaElement; start: number; end: number }
  | { kind: "editable"; el: HTMLElement; range: Range | null };

type OpenState = { anchor: MenuAnchor; items: MenuEntry[]; container: HTMLElement | null };

function isInput(el: Field): el is HTMLInputElement | HTMLTextAreaElement {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

function selectedText(saved: Saved): string {
  if (saved.kind === "input") {
    // Input bertipe number tidak punya selectionStart.
    return saved.el.value.slice(saved.start, saved.end);
  }
  return saved.range?.toString() ?? "";
}

function save(el: Field): Saved {
  if (isInput(el)) {
    let start = 0;
    let end = 0;
    try {
      start = el.selectionStart ?? 0;
      end = el.selectionEnd ?? 0;
    } catch {
      // Input number atau email: tidak ada seleksi yang bisa dibaca.
    }
    return { kind: "input", el, start, end };
  }
  const sel = window.getSelection();
  const range = sel && sel.rangeCount > 0 && el.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
  return { kind: "editable", el, range };
}

// Kembalikan fokus dan seleksi ke kolom sebelum perintah dijalankan, karena
// fokus sempat pindah ke menu.
function restore(saved: Saved) {
  saved.el.focus({ preventScroll: true });
  if (saved.kind === "input") {
    try {
      saved.el.setSelectionRange(saved.start, saved.end);
    } catch {
      // Tipe input tanpa seleksi.
    }
  } else if (saved.range) {
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(saved.range);
  }
}

function exec(command: string, value?: string): boolean {
  try {
    return typeof document.execCommand === "function" && document.execCommand(command, false, value);
  } catch {
    return false;
  }
}

// Teks yang akan disalin sudah dicatat saat menu dibuka, jadi tidak
// bergantung pada seleksi yang mungkin hilang. execCommand hanya cadangan.
async function copyText(text: string) {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Jatuh ke execCommand di bawah.
  }
  exec("copy");
}

async function pasteInto(saved: Saved) {
  let text: string | null = null;
  try {
    text = (await navigator.clipboard?.readText()) ?? null;
  } catch {
    text = null;
  }
  restore(saved);
  if (text === null) {
    exec("paste");
    return;
  }
  // insertText menjaga riwayat Ctrl+Z dan memicu event input, jadi state React ikut berubah.
  if (exec("insertText", text)) return;
  if (saved.kind === "input") setText(saved.el, text, saved.start, saved.end);
}

function selectAll(saved: Saved) {
  saved.el.focus({ preventScroll: true });
  if (saved.kind === "input") {
    saved.el.select();
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(saved.el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

export function textFieldItems(el: Field): MenuEntry[] {
  const saved = save(el);
  const hasSelection = selectedText(saved).length > 0;
  const readOnly = isInput(el) ? el.readOnly || el.disabled : !el.isContentEditable;
  const secret = el instanceof HTMLInputElement && el.type === "password";
  const value = isInput(el) ? el.value : (el.textContent ?? "");
  const copyBlock = secret ? TEXT_MENU.secret : hasSelection ? false : TEXT_MENU.noSelection;

  const cut: MenuAction = {
    id: "cut",
    label: TEXT_MENU.cut,
    icon: <IconCut size={16} />,
    shortcut: "Ctrl+X",
    disabled: readOnly ? TEXT_MENU.readOnly : copyBlock,
    onSelect: () => {
      const text = selectedText(saved);
      restore(saved);
      if (exec("cut")) return;
      void navigator.clipboard?.writeText(text).then(() => {
        if (saved.kind === "input") setText(saved.el, "", saved.start, saved.end);
      });
    },
  };
  const copy: MenuAction = {
    id: "copy",
    label: TEXT_MENU.copy,
    icon: <IconCopy size={16} />,
    shortcut: "Ctrl+C",
    disabled: copyBlock,
    onSelect: () => {
      const text = selectedText(saved);
      restore(saved);
      void copyText(text);
    },
  };
  const paste: MenuAction = {
    id: "paste",
    label: TEXT_MENU.paste,
    icon: <IconClipboard size={16} />,
    shortcut: "Ctrl+V",
    disabled: readOnly ? TEXT_MENU.readOnly : false,
    onSelect: () => void pasteInto(saved),
  };
  const all: MenuAction = {
    id: "select-all",
    label: TEXT_MENU.selectAll,
    icon: <IconSelectAll size={16} />,
    shortcut: "Ctrl+A",
    disabled: value.length === 0 ? TEXT_MENU.empty : false,
    onSelect: () => selectAll(saved),
  };
  return menuItems(cut, copy, paste, SEPARATOR, all);
}

// Teks yang dipilih di luar kolom isian (misalnya isi pesan) tetap bisa disalin.
function selectionItems(text: string): MenuEntry[] {
  return [
    {
      id: "copy",
      label: TEXT_MENU.copy,
      icon: <IconCopy size={16} />,
      shortcut: "Ctrl+C",
      onSelect: () => void copyText(text),
    },
  ];
}

function anchorFor(e: MouseEvent, el: Element): MenuAnchor {
  const rect = el.getBoundingClientRect();
  const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
  if (inside && (e.clientX !== 0 || e.clientY !== 0)) return { kind: "point", x: e.clientX, y: e.clientY };
  return { kind: "element", rect, align: "start" };
}

// Dipasang sekali di akar aplikasi. Mematikan menu bawaan WebView (Back,
// Reload, Inspect) di seluruh aplikasi. Di kolom teks muncul menu Potong,
// Salin, Tempel, dan Pilih semua; di teks yang dipilih muncul Salin.
// Menu milik layar (useContextMenu) memanggil preventDefault lebih dulu,
// jadi tidak ditimpa di sini.
export function TextFieldMenu() {
  const id = useId();
  const [open, setOpen] = useState<OpenState | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      e.preventDefault();
      const target = e.target;
      if (isTextField(target) && !(target instanceof HTMLInputElement && target.disabled)) {
        returnTo.current = target;
        setOpen({ anchor: anchorFor(e, target), items: textFieldItems(target), container: dialogOf(target) });
        return;
      }
      const text = window.getSelection()?.toString() ?? "";
      if (text.trim().length > 0 && target instanceof Element) {
        returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setOpen({ anchor: anchorFor(e, target), items: selectionItems(text), container: dialogOf(target) });
      }
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  const close = useCallback((restoreFocus: boolean) => {
    if (restoreFocus && returnTo.current?.isConnected) returnTo.current.focus({ preventScroll: true });
    setOpen(null);
  }, []);

  // Kolom asalnya hilang (misalnya dialog ditutup dari tempat lain): menu ikut tutup.
  useEffect(() => {
    if (!open) return;
    const watch = new MutationObserver(() => {
      if (returnTo.current && !returnTo.current.isConnected) setOpen(null);
    });
    watch.observe(document.body, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, [open]);

  if (!open) return null;
  return (
    <MenuPopup
      id={id}
      label={TEXT_MENU.label}
      items={open.items}
      anchor={open.anchor}
      owner={null}
      container={open.container}
      onClose={close}
      onSelect={(item) => {
        // Aksi teks mengatur fokus dan seleksinya sendiri.
        setOpen(null);
        void item.onSelect();
      }}
    />
  );
}
