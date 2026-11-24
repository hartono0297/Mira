// Tooltip sidebar: satu elemen untuk seluruh sidebar, muncul di kanan elemen
// yang disorot kursor atau difokus keyboard. Isinya hanya membantu mata; nama
// aksesibel tombol sudah lengkap, jadi tooltip tidak dihubungkan lewat
// aria-describedby (tidak dibacakan dua kali).
//
// Elemen yang diberi tooltip:
// - data-tip="teks": selalu (tombol ringkas/lebarkan, ikon jaringan).
// - data-tip-compact: hanya saat sidebar ringkas. Kosong berarti teksnya
//   diambil dari isi tombol tanpa bagian aria-hidden, jadi sama dengan nama
//   aksesibelnya ("Chat, 3 belum dibaca").
// - .side-me saat ringkas: nama, lalu kantor dan peran, dibaca dari teks yang
//   tampil di sidebar lebar.
//
// position: fixed di document.body, jadi tidak terpotong overflow sidebar.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

const ME_SELECTOR = ".side-me";
const GAP = 8;

type Tip = { text: string; x: number; y: number };

function textWithout(el: Element, skip: string): string {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll(skip).forEach((n) => n.remove());
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}

function meText(el: Element): string {
  const box = el.querySelector(".side-me-text");
  if (!box) return "";
  return [...box.children]
    .map((line) => textWithout(line, ".sr-only"))
    .filter(Boolean)
    .join("\n");
}

function findTarget(from: EventTarget | null, root: Element, compact: boolean): HTMLElement | null {
  if (!(from instanceof Element)) return null;
  const selector = compact ? `[data-tip], [data-tip-compact], ${ME_SELECTOR}` : "[data-tip]";
  const el = from.closest<HTMLElement>(selector);
  return el && root.contains(el) ? el : null;
}

export function tipText(el: HTMLElement): string {
  if (el.dataset.tip) return el.dataset.tip;
  if (el.dataset.tipCompact) return el.dataset.tipCompact;
  if (el.matches(ME_SELECTOR)) return meText(el);
  return textWithout(el, '[aria-hidden="true"]');
}

export function NavTooltip({ rootId, compact }: { rootId: string; compact: boolean }) {
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    const root = document.getElementById(rootId);
    if (!root) return;
    let hovered: HTMLElement | null = null;
    let focused: HTMLElement | null = null;
    // Fokus karena klik tidak memunculkan tooltip; hanya fokus dari keyboard.
    let pointerFocus = false;

    const update = () => {
      const el = hovered ?? focused;
      const text = el ? tipText(el) : "";
      if (!el || !text) {
        setTip(null);
        return;
      }
      const r = el.getBoundingClientRect();
      setTip({ text, x: r.right + GAP, y: r.top + r.height / 2 });
    };
    const onOver = (e: PointerEvent) => {
      hovered = findTarget(e.target, root, compact);
      update();
    };
    const onLeave = () => {
      hovered = null;
      update();
    };
    const onDown = () => {
      pointerFocus = true;
    };
    const onFocusIn = (e: FocusEvent) => {
      focused = pointerFocus ? null : findTarget(e.target, root, compact);
      pointerFocus = false;
      update();
    };
    const onFocusOut = () => {
      focused = null;
      update();
    };
    // Escape menutup tooltip tanpa memindahkan fokus (WCAG 1.4.13).
    const onKey = (e: KeyboardEvent) => {
      pointerFocus = false;
      if (e.key === "Escape" && (hovered || focused)) {
        hovered = null;
        focused = null;
        setTip(null);
      }
    };

    root.addEventListener("pointerover", onOver);
    root.addEventListener("pointerleave", onLeave);
    root.addEventListener("pointerdown", onDown, true);
    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("focusout", onFocusOut);
    document.addEventListener("keydown", onKey, true);
    return () => {
      root.removeEventListener("pointerover", onOver);
      root.removeEventListener("pointerleave", onLeave);
      root.removeEventListener("pointerdown", onDown, true);
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("keydown", onKey, true);
      setTip(null);
    };
  }, [rootId, compact]);

  if (!tip) return null;
  return createPortal(
    <div role="tooltip" className="nav-tip" style={{ left: tip.x, top: tip.y }}>
      {tip.text}
    </div>,
    document.body,
  );
}
