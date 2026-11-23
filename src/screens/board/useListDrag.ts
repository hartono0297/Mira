// Urutkan ulang baris daftar dengan seret pegangan lewat pointer event.
// Drag-and-drop HTML5 tidak sampai ke halaman di Tauri Windows (lihat
// useCardDrag.ts), jadi pola yang sama dipakai di sini: tekan pegangan, geser
// 5 px untuk mulai, lepas untuk menjatuhkan, Escape membatalkan. Pointer di
// dekat tepi wadah gulir (isi dialog) menggulir otomatis.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { isMac } from "../../platform";

const THRESHOLD = 5;
// Lebar tepi wadah gulir yang memicu gulir otomatis, dan kecepatan maksimalnya per frame.
// Sama dengan useCardDrag.ts.
const EDGE = 48;
const MAX_SPEED = 16;

// Posisi akhir untuk titik y, dihitung dari baris lain (tanpa baris yang
// diseret) urut dari atas: baris pertama yang titik tengahnya di bawah y.
export function insertIndexAt(rows: { top: number; height: number }[], y: number): number {
  for (let i = 0; i < rows.length; i++) if (y < rows[i].top + rows[i].height / 2) return i;
  return rows.length;
}

// Wadah terdekat yang benar-benar bisa digulir tegak (salinan dari useCardDrag.ts).
export function scrollParentY(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const oy = getComputedStyle(node).overflowY;
    if ((oy === "auto" || oy === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

// Kecepatan gulir dari posisi pointer terhadap tepi: makin dekat tepi, makin cepat
// (salinan dari useCardDrag.ts).
export function edgeSpeed(pos: number, start: number, end: number): number {
  if (end - start < EDGE * 3) return 0;
  if (pos < start + EDGE) return -Math.ceil(((start + EDGE - Math.max(pos, start)) / EDGE) * MAX_SPEED);
  if (pos > end - EDGE) return Math.ceil(((Math.min(pos, end) - (end - EDGE)) / EDGE) * MAX_SPEED);
  return 0;
}

type Session = {
  id: string;
  pointerId: number;
  handle: HTMLElement;
  startY: number;
  startX: number;
  y: number;
  started: boolean;
  index: number | null;
  scroller: HTMLElement | null;
  frame: number;
  detach: () => void;
};

// Baris ditandai data-row-id di dalam listRef.
export function useListDrag(
  listRef: RefObject<HTMLElement | null>,
  onDrop: (id: string, index: number) => void,
  onCancel?: () => void,
) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const session = useRef<Session | null>(null);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  function others(id: string): HTMLElement[] {
    const list = listRef.current;
    if (!list) return [];
    return Array.from(list.querySelectorAll<HTMLElement>("[data-row-id]")).filter((el) => el.dataset.rowId !== id);
  }

  // Satu-satunya tempat posisi sisip dihitung ulang: saat pointer bergerak dan saat isi bergulir.
  function update(s: Session) {
    const rows = others(s.id).map((el) => el.getBoundingClientRect());
    const next = insertIndexAt(rows, s.y);
    if (next !== s.index) {
      s.index = next;
      setDropIndex(next);
    }
  }

  function autoScroll() {
    const s = session.current;
    if (!s) return;
    const scroller = s.scroller;
    if (scroller) {
      const v = scroller.getBoundingClientRect();
      const dy = edgeSpeed(s.y, v.top, v.bottom);
      if (dy) {
        const before = scroller.scrollTop;
        scroller.scrollTop += dy;
        if (scroller.scrollTop !== before) update(s);
      }
    }
    s.frame = requestAnimationFrame(autoScroll);
  }

  function finish(commit: boolean, announceCancel = false) {
    const s = session.current;
    if (!s) return;
    session.current = null;
    s.detach();
    if (s.frame) cancelAnimationFrame(s.frame);
    if (s.handle.hasPointerCapture?.(s.pointerId)) s.handle.releasePointerCapture(s.pointerId);
    document.documentElement.classList.remove("row-dragging");
    setDragId(null);
    setDropIndex(null);
    if (!s.started) return;
    if (commit && s.index !== null) onDropRef.current(s.id, s.index);
    else if (announceCancel) onCancelRef.current?.();
  }

  function onHandlePointerDown(e: ReactPointerEvent<HTMLElement>, id: string) {
    // Ctrl + klik di macOS adalah klik kanan: membuka menu, bukan mulai seret.
    if (e.button !== 0 || (e.ctrlKey && isMac()) || session.current) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const pointerId = e.pointerId;

    const move = (ev: PointerEvent) => {
      const s = session.current;
      if (!s || ev.pointerId !== s.pointerId) return;
      s.y = ev.clientY;
      if (!s.started) {
        if (Math.hypot(ev.clientX - s.startX, ev.clientY - s.startY) < THRESHOLD) return;
        s.started = true;
        try {
          s.handle.setPointerCapture?.(s.pointerId);
        } catch {
          /* pointer sudah dilepas */
        }
        window.getSelection()?.removeAllRanges();
        document.documentElement.classList.add("row-dragging");
        setDragId(s.id);
        s.scroller = scrollParentY(listRef.current);
        s.frame = requestAnimationFrame(autoScroll);
      }
      ev.preventDefault();
      update(s);
    };
    const up = (ev: PointerEvent) => {
      if (session.current && ev.pointerId === session.current.pointerId) finish(true);
    };
    const cancel = (ev: PointerEvent) => {
      if (session.current && ev.pointerId === session.current.pointerId) finish(false);
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !session.current?.started) return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(false, true);
    };
    // Gulir oleh roda mouse atau oleh gulir otomatis menggeser baris di bawah pointer.
    const scroll = () => {
      const s = session.current;
      if (s?.started) update(s);
    };
    const blur = () => finish(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("blur", blur);

    session.current = {
      id,
      pointerId,
      handle,
      startX: e.clientX,
      startY: e.clientY,
      y: e.clientY,
      started: false,
      index: null,
      scroller: null,
      frame: 0,
      detach: () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("keydown", key, true);
        window.removeEventListener("scroll", scroll, true);
        window.removeEventListener("blur", blur);
      },
    };
  }

  useEffect(() => () => finish(false), []);

  // Untuk menu klik kanan baris: selama seret berjalan menu tidak dibuka, dan
  // seret yang masih tertunda (tombol ditahan, belum lewat ambang) dibatalkan.
  function isDragging(): boolean {
    return !!session.current?.started;
  }

  function cancelPending() {
    if (session.current && !session.current.started) finish(false);
  }

  return { dragId, dropIndex, onHandlePointerDown, isDragging, cancelPending };
}
