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
// Setelah tampil, tingginya diukur dan posisinya dijaga 8 px di dalam jendela
// (tooltip profil di dasar sidebar bisa dua baris).
//
// Kursor: muncul setelah 300 ms supaya tidak berkedip saat kursor hanya
// lewat. Kalau tooltip baru saja tampil, pindah ke ikon lain langsung
// berganti. Fokus keyboard: langsung.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const ME_SELECTOR = ".side-me";
const GAP = 8;
const EDGE = 8;
export const HOVER_DELAY = 300;
// Jeda antar-ikon (celah 2 px di antara tombol) yang tetap dianggap "masih tampil".
const WARM_MS = 300;

type Tip = { text: string; x: number; y: number };

function textWithout(el: Element, skip: string): string {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll(skip).forEach((n) => n.remove());
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}

function meText(el: Element): string {
  const box = el.querySelector(".side-me-text");
  if (!box) return "";
  // Pemisah sr-only (", ") di antara baris hanya untuk pembaca layar.
  return [...box.children]
    .filter((line) => !line.matches(".sr-only"))
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

export function clampTop(center: number, height: number, viewport: number): number {
  return Math.max(EDGE, Math.min(center - height / 2, viewport - height - EDGE));
}

export function NavTooltip({ rootId, compact }: { rootId: string; compact: boolean }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = document.getElementById(rootId);
    if (!root) return;
    let hovered: HTMLElement | null = null;
    let focused: HTMLElement | null = null;
    // Fokus karena klik tidak memunculkan tooltip; hanya fokus dari keyboard.
    let pointerFocus = false;
    let visible = false;
    let warmUntil = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const show = (el: HTMLElement) => {
      const text = tipText(el);
      if (!text) {
        hide();
        return;
      }
      const r = el.getBoundingClientRect();
      visible = true;
      setTip({ text, x: r.right + GAP, y: r.top + r.height / 2 });
    };
    const hide = () => {
      if (visible) warmUntil = Date.now() + WARM_MS;
      visible = false;
      setTip(null);
    };
    const update = (instant: boolean) => {
      clearTimeout(timer);
      timer = undefined;
      const el = hovered ?? focused;
      if (!el) {
        hide();
        return;
      }
      if (instant || visible || Date.now() < warmUntil) {
        show(el);
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        const now = hovered ?? focused;
        if (now) show(now);
      }, HOVER_DELAY);
    };
    const onOver = (e: PointerEvent) => {
      const next = findTarget(e.target, root, compact);
      if (next === hovered) return;
      hovered = next;
      update(false);
    };
    const onLeave = () => {
      hovered = null;
      update(true);
    };
    const onDown = () => {
      pointerFocus = true;
    };
    const onFocusIn = (e: FocusEvent) => {
      focused = pointerFocus ? null : findTarget(e.target, root, compact);
      pointerFocus = false;
      update(true);
    };
    const onFocusOut = () => {
      focused = null;
      update(true);
    };
    // Escape menutup tooltip tanpa memindahkan fokus (WCAG 1.4.13).
    const onKey = (e: KeyboardEvent) => {
      pointerFocus = false;
      if (e.key === "Escape" && (hovered || focused)) {
        hovered = null;
        focused = null;
        clearTimeout(timer);
        hide();
      }
    };

    root.addEventListener("pointerover", onOver);
    root.addEventListener("pointerleave", onLeave);
    root.addEventListener("pointerdown", onDown, true);
    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("focusout", onFocusOut);
    document.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(timer);
      root.removeEventListener("pointerover", onOver);
      root.removeEventListener("pointerleave", onLeave);
      root.removeEventListener("pointerdown", onDown, true);
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("keydown", onKey, true);
      setTip(null);
    };
  }, [rootId, compact]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!tip || !el) return;
    el.style.top = `${clampTop(tip.y, el.getBoundingClientRect().height, window.innerHeight)}px`;
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div ref={box} role="tooltip" className="nav-tip" style={{ left: tip.x, top: tip.y }}>
      {tip.text}
    </div>,
    document.body,
  );
}
