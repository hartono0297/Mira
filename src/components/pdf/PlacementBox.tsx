import { useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { clampCss } from "./coords";
import type { CssRect, Size } from "./types";

type Props = {
  rect: CssRect;
  bounds: Size;
  onChange: (r: CssRect) => void;
  label: string;
  description?: string;
  // Lebar dibagi tinggi. Kalau diisi, ubah ukuran selalu menjaga rasio ini.
  aspectRatio?: number;
  minWidth?: number;
  // Jarak geser per tombol panah, px CSS. Shift mengalikan 4.
  step?: number;
  children?: ReactNode;
};

const KEY_HINT =
  "Tombol panah memindah kotak, Shift dan panah memindah lebih jauh. Alt dan panah, atau tombol plus dan minus, mengubah ukuran.";

type Drag = {
  pointerId: number;
  mode: "move" | "resize";
  startX: number;
  startY: number;
  start: CssRect;
};

// Ubah ukuran dari sudut kiri atas yang tetap, dijepit ke bounds dan ukuran minimum.
export function resizeRect(
  rect: CssRect,
  width: number,
  height: number,
  bounds: Size,
  opts: { aspectRatio?: number; minWidth?: number } = {},
): CssRect {
  const { aspectRatio } = opts;
  const minW = opts.minWidth ?? 24;
  const maxW = bounds.width - rect.left;
  const maxH = bounds.height - rect.top;
  if (aspectRatio && aspectRatio > 0) {
    const limit = Math.min(maxW, maxH * aspectRatio);
    const w = Math.max(Math.min(width, limit), Math.min(minW, limit));
    return { left: rect.left, top: rect.top, width: w, height: w / aspectRatio };
  }
  const minH = Math.min(minW, maxH);
  const w = Math.max(Math.min(width, maxW), Math.min(minW, maxW));
  const h = Math.max(Math.min(height, maxH), minH);
  return { left: rect.left, top: rect.top, width: w, height: h };
}

// Kotak yang bisa dipindah dan diubah ukurannya di atas halaman PDF, dengan
// mouse, pena, sentuhan, dan keyboard. Posisi selalu di dalam bounds.
export function PlacementBox({
  rect,
  bounds,
  onChange,
  label,
  description,
  aspectRatio,
  minWidth = 24,
  step = 5,
  children,
}: Props) {
  const hintId = useId();
  const descId = useId();
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState<Drag["mode"] | null>(null);
  const [edgeNote, setEdgeNote] = useState("");

  const sizeOpts = { aspectRatio, minWidth };

  function commit(next: CssRect, fromKeyboard: boolean) {
    const fitted = clampCss(next, bounds);
    if (fromKeyboard) {
      const blocked = fitted.left !== next.left || fitted.top !== next.top || fitted.width !== next.width || fitted.height !== next.height;
      setEdgeNote(blocked ? "Sudah di tepi halaman." : "");
    }
    if (fitted.left !== rect.left || fitted.top !== rect.top || fitted.width !== rect.width || fitted.height !== rect.height) {
      onChange(fitted);
    }
  }

  function grow(delta: number, axis: "both" | "x" | "y", fromKeyboard = true) {
    let w = rect.width;
    let h = rect.height;
    if (aspectRatio) {
      w = rect.width + delta;
      h = w / aspectRatio;
    } else {
      if (axis !== "y") w += delta;
      if (axis !== "x") h += delta;
    }
    const wanted = { left: rect.left, top: rect.top, width: w, height: h };
    const next = resizeRect(rect, w, h, bounds, sizeOpts);
    if (fromKeyboard) {
      const blocked = Math.abs(next.width - wanted.width) > 0.001 || Math.abs(next.height - wanted.height) > 0.001;
      setEdgeNote(blocked ? (delta > 0 ? "Sudah ukuran terbesar di posisi ini." : "Sudah ukuran terkecil.") : "");
    }
    if (next.width !== rect.width || next.height !== rect.height) onChange(next);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const amount = step * (e.shiftKey ? 4 : 1);
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const dir = arrows[e.key];
    if (dir) {
      e.preventDefault();
      if (e.altKey) {
        // Kanan dan bawah memperbesar, kiri dan atas memperkecil.
        const sign = dir[0] + dir[1];
        grow(sign * amount, dir[0] !== 0 ? "x" : "y");
      } else {
        commit({ ...rect, left: rect.left + dir[0] * amount, top: rect.top + dir[1] * amount }, true);
      }
      return;
    }
    if (e.key === "+" || e.key === "=" || e.key === "Add") {
      e.preventDefault();
      grow(amount, "both");
    } else if (e.key === "-" || e.key === "_" || e.key === "Subtract") {
      e.preventDefault();
      grow(-amount, "both");
    } else if (e.key === "Escape" && drag.current) {
      e.preventDefault();
      const start = drag.current.start;
      endDrag(e.currentTarget);
      onChange(start);
    }
  }

  function startDrag(e: PointerEvent<HTMLElement>, mode: Drag["mode"]) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const box = e.currentTarget.closest<HTMLElement>(".pdf-place");
    box?.focus({ preventScroll: true });
    box?.setPointerCapture?.(e.pointerId);
    drag.current = { pointerId: e.pointerId, mode, startX: e.clientX, startY: e.clientY, start: rect };
    setDragging(mode);
    setEdgeNote("");
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (d.mode === "move") {
      commit({ ...d.start, left: d.start.left + dx, top: d.start.top + dy }, false);
    } else {
      const next = resizeRect(d.start, d.start.width + dx, d.start.height + dy, bounds, sizeOpts);
      if (next.width !== rect.width || next.height !== rect.height) onChange(next);
    }
  }

  function endDrag(el: HTMLElement, pointerId?: number) {
    const d = drag.current;
    if (!d) return;
    if (pointerId !== undefined && d.pointerId !== pointerId) return;
    if (el.hasPointerCapture?.(d.pointerId)) el.releasePointerCapture(d.pointerId);
    drag.current = null;
    setDragging(null);
  }

  const describedBy = description ? `${descId} ${hintId}` : hintId;

  return (
    <div
      className="pdf-place"
      data-dragging={dragging ?? undefined}
      role="group"
      aria-roledescription="kotak yang bisa dipindah"
      aria-label={label}
      aria-describedby={describedBy}
      tabIndex={0}
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => startDrag(e, "move")}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endDrag(e.currentTarget, e.pointerId)}
      onPointerCancel={(e) => endDrag(e.currentTarget, e.pointerId)}
      onLostPointerCapture={(e) => endDrag(e.currentTarget, e.pointerId)}
    >
      {children}
      <span className="pdf-place-handle" aria-hidden="true" onPointerDown={(e) => startDrag(e, "resize")}>
        <span className="pdf-place-knob" />
      </span>
      {description && (
        <span id={descId} className="sr-only">
          {description}
        </span>
      )}
      <span id={hintId} className="sr-only">
        {KEY_HINT}
      </span>
      <span className="sr-only" aria-live="polite">
        {edgeNote}
      </span>
    </div>
  );
}
