// Seret kartu dengan mouse lewat pointer event, bukan drag-and-drop HTML5.
//
// Di Windows, Tauri memasang penangan seret-lepas berkas miliknya sendiri di
// WebView2 (dragDropEnabled, bawaan aktif). Penangan itu menggantikan milik
// WebView2, jadi dragover dan drop HTML5 tidak pernah sampai ke halaman dan
// kartu tidak bisa dijatuhkan di kolom lain. Pointer event tidak lewat jalur
// itu, jadi seret jalan sama di WebView2 dan WKWebView tanpa mematikan
// penangan berkas.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { ColumnId } from "../../api/board";
import type { Place } from "./boardMoves";

// Jarak gerak sebelum tekanan dianggap seret. Di bawahnya tetap klik biasa.
const THRESHOLD = 5;
// Lebar tepi area board yang memicu gulir otomatis, dan kecepatan maksimalnya per frame.
const EDGE = 48;
const MAX_SPEED = 16;

type Session = {
  taskId: string;
  pointerId: number;
  card: HTMLElement;
  startX: number;
  startY: number;
  x: number;
  y: number;
  offsetX: number;
  offsetY: number;
  started: boolean;
  ghost: HTMLElement | null;
  drop: Place | null;
  frame: number;
  detach: () => void;
};

// Atribut yang tidak boleh ikut ke bayangan kartu: id ganda dan penanda yang dicari kode lain.
const STRIP = ["id", "aria-describedby", "aria-controls", "data-card", "data-open-task", "data-rescue"];

function makeGhost(card: HTMLElement, rect: DOMRect): HTMLElement {
  const ghost = card.cloneNode(true) as HTMLElement;
  for (const el of [ghost, ...Array.from(ghost.querySelectorAll<HTMLElement>("*"))])
    for (const name of STRIP) el.removeAttribute(name);
  ghost.classList.remove("tc-dragging");
  ghost.classList.add("tc-ghost");
  ghost.setAttribute("aria-hidden", "true");
  ghost.setAttribute("inert", "");
  ghost.style.width = `${rect.width}px`;
  document.body.appendChild(ghost);
  return ghost;
}

function scrollParentY(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const oy = getComputedStyle(node).overflowY;
    if ((oy === "auto" || oy === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

// Kecepatan gulir dari posisi pointer terhadap tepi: makin dekat tepi, makin cepat.
function edgeSpeed(pos: number, start: number, end: number): number {
  if (end - start < EDGE * 3) return 0;
  if (pos < start + EDGE) return -Math.ceil(((start + EDGE - Math.max(pos, start)) / EDGE) * MAX_SPEED);
  if (pos > end - EDGE) return Math.ceil(((Math.min(pos, end) - (end - EDGE)) / EDGE) * MAX_SPEED);
  return 0;
}

// Tempat jatuh untuk titik (x, y). Area board ditandai data-drop-area, kolom
// data-drop-col. Kolom dipilih dari posisi mendatar saja, jadi celah antar
// kolom dan ruang kosong di bawah kolom pendek tetap dihitung.
export function placeAt(root: HTMLElement, taskId: string, x: number, y: number): Place | null {
  const area = root.querySelector<HTMLElement>("[data-drop-area]");
  const a = area?.getBoundingClientRect();
  if (!a || x < a.left || x > a.right || y < a.top || y > a.bottom) return null;
  let best: { col: HTMLElement; dist: number } | null = null;
  for (const col of Array.from(root.querySelectorAll<HTMLElement>("[data-drop-col]"))) {
    const r = col.getBoundingClientRect();
    const dist = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    if (!best || dist < best.dist) best = { col, dist };
  }
  if (!best) return null;
  const cards = Array.from(best.col.querySelectorAll<HTMLElement>("[data-card]")).filter((el) => el.dataset.card !== taskId);
  let index = cards.length;
  for (let i = 0; i < cards.length; i++) {
    const r = cards[i].getBoundingClientRect();
    if (y < r.top + r.height / 2) {
      index = i;
      break;
    }
  }
  return { columnId: best.col.dataset.dropCol as ColumnId, index };
}

export function useCardDrag(rootRef: RefObject<HTMLElement | null>, onDrop: (taskId: string, to: Place) => void) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<Place | null>(null);
  const session = useRef<Session | null>(null);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  function finish(commit: boolean) {
    const s = session.current;
    if (!s) return;
    session.current = null;
    s.detach();
    cancelAnimationFrame(s.frame);
    s.ghost?.remove();
    document.documentElement.classList.remove("card-dragging");
    if (s.card.hasPointerCapture?.(s.pointerId)) s.card.releasePointerCapture(s.pointerId);
    if (s.started) {
      setDragId(null);
      setDrop(null);
      // Klik yang menyusul pointerup tidak boleh membuka detail task.
      const swallow = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
      };
      window.addEventListener("click", swallow, true);
      window.setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    }
    if (commit && s.started && s.drop) onDropRef.current(s.taskId, s.drop);
  }

  // Satu-satunya tempat posisi bayangan dan tempat jatuh dihitung ulang.
  function update(s: Session) {
    if (s.ghost) s.ghost.style.transform = `translate(${s.x - s.offsetX}px, ${s.y - s.offsetY}px)`;
    const root = rootRef.current;
    const next = root ? placeAt(root, s.taskId, s.x, s.y) : null;
    const prev = s.drop;
    if (prev?.columnId === next?.columnId && prev?.index === next?.index) return;
    s.drop = next;
    setDrop(next);
  }

  function autoScroll() {
    const s = session.current;
    if (!s) return;
    const area = rootRef.current?.querySelector<HTMLElement>("[data-drop-area]") ?? null;
    let moved = false;
    if (area) {
      const r = area.getBoundingClientRect();
      const dx = edgeSpeed(s.x, r.left, r.right);
      if (dx && area.scrollWidth > area.clientWidth) {
        const before = area.scrollLeft;
        area.scrollLeft += dx;
        moved ||= area.scrollLeft !== before;
      }
      const scroller = scrollParentY(area);
      if (scroller) {
        const v = scroller.getBoundingClientRect();
        const dy = edgeSpeed(s.y, v.top, v.bottom);
        if (dy) {
          const before = scroller.scrollTop;
          scroller.scrollTop += dy;
          moved ||= scroller.scrollTop !== before;
        }
      }
    }
    if (moved) update(s);
    s.frame = requestAnimationFrame(autoScroll);
  }

  function begin(s: Session) {
    s.started = true;
    const rect = s.card.getBoundingClientRect();
    s.offsetX = s.startX - rect.left;
    s.offsetY = s.startY - rect.top;
    s.ghost = makeGhost(s.card, rect);
    try {
      s.card.setPointerCapture?.(s.pointerId);
    } catch {
      /* pointer sudah dilepas */
    }
    window.getSelection()?.removeAllRanges();
    document.documentElement.classList.add("card-dragging");
    setDragId(s.taskId);
    s.frame = requestAnimationFrame(autoScroll);
  }

  function onPointerDown(e: ReactPointerEvent<HTMLElement>, taskId: string) {
    // Tombol utama mouse atau pena saja; sentuhan tetap untuk menggulir board.
    if (e.button !== 0 || e.pointerType === "touch" || session.current) return;
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
    const card = e.currentTarget;
    const pointerId = e.pointerId;

    const move = (ev: PointerEvent) => {
      const s = session.current;
      if (!s || ev.pointerId !== s.pointerId) return;
      s.x = ev.clientX;
      s.y = ev.clientY;
      if (!s.started) {
        if (Math.hypot(s.x - s.startX, s.y - s.startY) < THRESHOLD) return;
        begin(s);
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
    // Menu klik kanan (klik kanan, Shift+F10, tombol Menu) yang terbuka selagi
    // tombol kiri masih ditahan membatalkan tekanan yang belum jadi seret, supaya
    // gerakan mouse sesudahnya tidak memulai seret di bawah menu. Seret yang
    // sudah berjalan tidak terpengaruh; menu memang tidak dibuka selama seret.
    const dropPending = () => {
      if (session.current && !session.current.started) finish(false);
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key === "ContextMenu" || (ev.key === "F10" && ev.shiftKey)) {
        dropPending();
        return;
      }
      if (ev.key !== "Escape" || !session.current?.started) return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    };
    const blur = () => finish(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
    window.addEventListener("contextmenu", dropPending, true);
    window.addEventListener("blur", blur);

    session.current = {
      taskId,
      pointerId,
      card,
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      offsetX: 0,
      offsetY: 0,
      started: false,
      ghost: null,
      drop: null,
      frame: 0,
      detach: () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("keydown", key, true);
        window.removeEventListener("contextmenu", dropPending, true);
        window.removeEventListener("blur", blur);
      },
    };
  }

  useEffect(() => () => finish(false), []);

  return { dragId, drop, onPointerDown };
}
