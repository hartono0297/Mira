// Seret chip task ke tanggal lain untuk memindah tenggatnya, lewat pointer
// event seperti useCardDrag di board. Drag-and-drop HTML5 tidak dipakai:
// di Windows penangan seret berkas Tauri menelan dragover dan drop.
//
// Sel tujuan dicari dengan document.elementFromPoint lalu closest
// [data-cal-day]. Bayangan chip tidak menangkap pointer (pointer-events: none),
// jadi titik di bawahnya tetap mengenai sel kalender.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { CalTask } from "../../api/calendar";
import { canMoveDue, taskKey, type DayKey } from "./calendarModel";

// Jarak gerak sebelum tekanan dianggap seret. Di bawahnya tetap klik biasa.
const THRESHOLD = 5;
// Lebar tepi area gulir yang memicu gulir otomatis, dan kecepatan maksimalnya per frame.
const EDGE = 48;
const MAX_SPEED = 16;
// Kelas di <html> selama seret: kursor genggam, teks tidak terpilih, menu klik kanan tidak dibuka.
export const DRAG_CLASS = "cal-dragging";

type Session = {
  task: CalTask;
  key: string;
  pointerId: number;
  chip: HTMLElement;
  startX: number;
  startY: number;
  x: number;
  y: number;
  offsetX: number;
  offsetY: number;
  started: boolean;
  ghost: HTMLElement | null;
  drop: DayKey | null;
  frame: number;
  detach: () => void;
};

// Atribut yang tidak boleh ikut ke bayangan: id ganda dan penanda yang dicari kode lain.
const STRIP = ["id", "aria-describedby", "aria-controls", "aria-labelledby", "data-cal-task", "data-cal-day"];

export function calDragActive(): boolean {
  return document.documentElement.classList.contains(DRAG_CLASS);
}

function makeGhost(chip: HTMLElement, rect: DOMRect): HTMLElement {
  const ghost = chip.cloneNode(true) as HTMLElement;
  for (const el of [ghost, ...Array.from(ghost.querySelectorAll<HTMLElement>("*"))])
    for (const name of STRIP) el.removeAttribute(name);
  ghost.classList.add("cal-ghost");
  ghost.setAttribute("aria-hidden", "true");
  ghost.setAttribute("inert", "");
  ghost.tabIndex = -1;
  ghost.style.width = `${rect.width}px`;
  ghost.style.pointerEvents = "none";
  document.body.appendChild(ghost);
  return ghost;
}

function scrollable(node: HTMLElement): boolean {
  const style = getComputedStyle(node);
  const y = (style.overflowY === "auto" || style.overflowY === "scroll") && node.scrollHeight > node.clientHeight;
  const x = (style.overflowX === "auto" || style.overflowX === "scroll") && node.scrollWidth > node.clientWidth;
  return y || x;
}

// Area gulir terdekat di bawah pointer, atau di atas akar kalender.
function scrollerAt(start: Element | null, root: HTMLElement | null): HTMLElement | null {
  for (let node = start instanceof HTMLElement ? start : null; node; node = node.parentElement) {
    if (scrollable(node)) return node;
  }
  for (let node = root?.parentElement ?? null; node; node = node.parentElement) {
    if (scrollable(node)) return node;
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

function pointAt(x: number, y: number): Element | null {
  return typeof document.elementFromPoint === "function" ? document.elementFromPoint(x, y) : null;
}

// Hari di bawah titik (x, y), hanya sel di dalam akar kalender.
export function dayAt(root: HTMLElement | null, x: number, y: number): DayKey | null {
  const cell = pointAt(x, y)?.closest<HTMLElement>("[data-cal-day]") ?? null;
  if (!cell || !root || !root.contains(cell)) return null;
  return cell.getAttribute("data-cal-day");
}

const nextFrame = (fn: () => void): number =>
  typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : window.setTimeout(fn, 16);
const stopFrame = (id: number) => {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
  window.clearTimeout(id);
};

// `resolve` memberi task terbaru menurut kuncinya saat dilepas: tenggatnya bisa
// sudah berubah (sinkron rekan, Alt+Panah) sejak tombol ditekan.
export function useDueDrag(
  rootRef: RefObject<HTMLElement | null>,
  onDrop: (t: CalTask, day: DayKey) => void,
  resolve?: (key: string) => CalTask | undefined,
) {
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dropDay, setDropDay] = useState<DayKey | null>(null);
  const session = useRef<Session | null>(null);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;

  function finish(commit: boolean) {
    const s = session.current;
    if (!s) return;
    session.current = null;
    s.detach();
    stopFrame(s.frame);
    s.ghost?.remove();
    document.documentElement.classList.remove(DRAG_CLASS);
    try {
      if (s.chip.hasPointerCapture?.(s.pointerId)) s.chip.releasePointerCapture(s.pointerId);
    } catch {
      /* pointer sudah dilepas */
    }
    if (s.started) {
      setDraggingKey(null);
      setDropDay(null);
      // Klik yang menyusul pointerup tidak boleh membuka detail task.
      const swallow = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
      };
      window.addEventListener("click", swallow, true);
      window.setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    }
    if (!commit || !s.started || !s.drop) return;
    const now = resolveRef.current?.(s.key) ?? s.task;
    // Lepas di hari yang sama tidak mengubah apa pun.
    if (s.drop !== now.task.due) onDropRef.current(now, s.drop);
  }

  // Satu-satunya tempat posisi bayangan dan hari tujuan dihitung ulang.
  function update(s: Session) {
    if (s.ghost) s.ghost.style.transform = `translate(${s.x - s.offsetX}px, ${s.y - s.offsetY}px)`;
    const next = dayAt(rootRef.current, s.x, s.y);
    if (next === s.drop) return;
    s.drop = next;
    setDropDay(next);
  }

  function autoScroll() {
    const s = session.current;
    if (!s) return;
    const scroller = scrollerAt(pointAt(s.x, s.y), rootRef.current);
    let moved = false;
    if (scroller) {
      const r = scroller.getBoundingClientRect();
      const dy = scroller.scrollHeight > scroller.clientHeight ? edgeSpeed(s.y, r.top, r.bottom) : 0;
      const dx = scroller.scrollWidth > scroller.clientWidth ? edgeSpeed(s.x, r.left, r.right) : 0;
      if (dy) {
        const before = scroller.scrollTop;
        scroller.scrollTop += dy;
        moved ||= scroller.scrollTop !== before;
      }
      if (dx) {
        const before = scroller.scrollLeft;
        scroller.scrollLeft += dx;
        moved ||= scroller.scrollLeft !== before;
      }
    }
    if (moved) update(s);
    s.frame = nextFrame(autoScroll);
  }

  function begin(s: Session) {
    s.started = true;
    const rect = s.chip.getBoundingClientRect();
    s.offsetX = s.startX - rect.left;
    s.offsetY = s.startY - rect.top;
    s.ghost = makeGhost(s.chip, rect);
    try {
      s.chip.setPointerCapture?.(s.pointerId);
    } catch {
      /* pointer sudah dilepas */
    }
    window.getSelection?.()?.removeAllRanges();
    document.documentElement.classList.add(DRAG_CLASS);
    setDraggingKey(s.key);
    s.frame = nextFrame(autoScroll);
  }

  function onPointerDown(e: ReactPointerEvent<HTMLElement>, t: CalTask) {
    // Tombol utama mouse atau pena saja; sentuhan tetap untuk menggulir.
    if (e.button !== 0 || e.pointerType === "touch" || session.current) return;
    // Chip yang tidak boleh diubah tidak diseret; klik biasa tetap membukanya.
    if (!canMoveDue(t)) return;
    const chip = e.currentTarget;
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
    // Menu klik kanan yang dibuka selagi tombol kiri masih ditahan membatalkan
    // tekanan yang belum jadi seret.
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
      task: t,
      key: taskKey(t),
      pointerId,
      chip,
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

  return { draggingKey, dropDay, onPointerDown };
}
