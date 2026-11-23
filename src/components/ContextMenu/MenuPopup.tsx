import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { isMac } from "../../platform";
import { disabledReason, isDisabled, isSeparator, shortcutText, type MenuAction, type MenuEntry } from "./items";
import "./context-menu.css";

// Tempat menu muncul: titik kursor (klik kanan) atau di bawah sebuah elemen
// (tombol "...", Shift+F10, tombol Menu).
export type MenuAnchor = { kind: "point"; x: number; y: number } | { kind: "element"; rect: DOMRect; align: "start" | "end" };

type Props = {
  id: string;
  label: string;
  items: MenuEntry[];
  anchor: MenuAnchor;
  // Elemen yang boleh diklik tanpa menutup menu dari sini (tombol "..." yang
  // membuka menu ini mengurus buka-tutupnya sendiri).
  owner: HTMLElement | null;
  // restoreFocus false saat pengguna mengklik di luar: fokus ikut ke tempat
  // yang diklik, jangan ditarik kembali.
  onClose: (restoreFocus: boolean) => void;
  onSelect: (item: MenuAction) => void;
};

const EDGE = 8;

// Hitung posisi supaya menu tidak keluar dari layar: balik ke kiri atau ke
// atas kalau tidak muat, lalu jepit ke tepi jendela.
export function placeMenu(anchor: MenuAnchor, size: { width: number; height: number }, view: { width: number; height: number }) {
  let x: number;
  let y: number;
  if (anchor.kind === "point") {
    x = anchor.x;
    y = anchor.y;
    if (x + size.width > view.width - EDGE) x = anchor.x - size.width;
    if (y + size.height > view.height - EDGE) y = anchor.y - size.height;
  } else {
    const r = anchor.rect;
    x = anchor.align === "end" ? r.right - size.width : r.left;
    y = r.bottom + 4;
    if (y + size.height > view.height - EDGE) y = r.top - size.height - 4;
  }
  x = Math.max(EDGE, Math.min(x, view.width - size.width - EDGE));
  y = Math.max(EDGE, Math.min(y, view.height - size.height - EDGE));
  return { x, y };
}

export function MenuPopup({ id, label, items, anchor, owner, onClose, onSelect }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const mac = isMac();

  // Posisi dihitung sebelum menu tergambar, jadi tidak ada kedipan di pojok.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const { x, y } = placeMenu(anchor, { width: box.width, height: box.height }, { width: window.innerWidth, height: window.innerHeight });
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.visibility = "visible";
    // Item pertama langsung difokus, sehingga panah, Enter, dan Esc bekerja tanpa klik.
    el.querySelector<HTMLElement>("[role=menuitem]")?.focus({ preventScroll: true });
  }, [anchor]);

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || owner?.contains(t)) return;
      onClose(false);
    };
    const onScroll = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose(false);
    };
    const onBlur = () => onClose(false);
    document.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onBlur);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onBlur);
      window.removeEventListener("blur", onBlur);
    };
  }, [onClose, owner]);

  const itemEls = () => Array.from(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);

  function move(delta: 1 | -1 | "first" | "last") {
    const els = itemEls();
    if (els.length === 0) return;
    const current = els.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (delta === "first") next = 0;
    else if (delta === "last") next = els.length - 1;
    else if (current < 0) next = delta === 1 ? 0 : els.length - 1;
    else next = (current + delta + els.length) % els.length;
    els[next].focus();
  }

  // Ketik huruf awal untuk melompat ke item yang cocok.
  function typeahead(key: string) {
    const now = Date.now();
    const t = typed.current;
    t.text = now - t.at > 700 ? key : t.text + key;
    t.at = now;
    const els = itemEls();
    // Huruf pertama mencari mulai dari item sesudah yang terfokus, supaya
    // menekan huruf yang sama berulang kali berpindah antar item.
    const from = Math.max(0, els.indexOf(document.activeElement as HTMLElement)) + (t.text.length === 1 ? 1 : 0);
    const order = [...els.slice(from), ...els.slice(0, from)];
    const hit = order.find((el) => (el.dataset.label ?? "").toLocaleLowerCase("id").startsWith(t.text.toLocaleLowerCase("id")));
    hit?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // Menu dirender lewat portal, tetapi event React tetap naik ke baris
    // pemiliknya. Hentikan di sini supaya Shift+F10 atau Enter di menu tidak
    // membuka menu lagi atau menjalankan aksi baris.
    e.stopPropagation();
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(1);
        return;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        return;
      case "Home":
        e.preventDefault();
        move("first");
        return;
      case "End":
        e.preventDefault();
        move("last");
        return;
      case "Escape":
        e.preventDefault();
        onClose(true);
        return;
      case "Tab":
        e.preventDefault();
        onClose(true);
        return;
      case "Enter":
      case " ": {
        e.preventDefault();
        const idx = Number((document.activeElement as HTMLElement | null)?.dataset.index ?? -1);
        const item = items[idx];
        if (item && !isSeparator(item) && !isDisabled(item)) onSelect(item);
        return;
      }
      default:
        if (e.key === "F10" && e.shiftKey) {
          e.preventDefault();
          onClose(true);
          return;
        }
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== " ") {
          typeahead(e.key);
        }
    }
  }

  const hasIcons = items.some((e) => !isSeparator(e) && e.icon);

  return createPortal(
    <div
      ref={ref}
      id={id}
      role="menu"
      aria-label={label}
      aria-orientation="vertical"
      className="cmenu"
      style={{ visibility: "hidden" }}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {items.map((entry, i) => {
        if (isSeparator(entry)) return <div key={`sep-${i}`} role="separator" className="cmenu-sep" />;
        const off = isDisabled(entry);
        const reason = disabledReason(entry);
        const reasonId = reason ? `${id}-r${i}` : undefined;
        const shortcut = entry.shortcut ? shortcutText(entry.shortcut, mac) : null;
        return (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            tabIndex={-1}
            data-index={i}
            data-label={entry.label}
            data-menu-item={entry.id}
            className={`cmenu-item${entry.danger ? " cmenu-danger" : ""}${hasIcons ? " cmenu-has-icon" : ""}`}
            aria-disabled={off || undefined}
            aria-describedby={reasonId}
            aria-keyshortcuts={entry.shortcut ? entry.shortcut.replace(/Ctrl/g, mac ? "Meta" : "Control") : undefined}
            onPointerMove={(e) => {
              if (document.activeElement !== e.currentTarget) e.currentTarget.focus({ preventScroll: true });
            }}
            onClick={() => {
              if (!off) onSelect(entry);
            }}
          >
            {hasIcons && (
              <span className="cmenu-icon" aria-hidden="true">
                {entry.icon}
              </span>
            )}
            <span className="cmenu-text">
              <span className="cmenu-label">{entry.label}</span>
              {reason && (
                <span id={reasonId} className="cmenu-reason">
                  {reason}
                </span>
              )}
            </span>
            {shortcut && (
              <span className="cmenu-shortcut" aria-hidden="true">
                {shortcut}
              </span>
            )}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
