import { IconArrowBackUp, IconEraser } from "@tabler/icons-react";
import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from "react";
import { trimToPng, type SignatureImage } from "./image";
import "./pad.css";

// Warna tinta tetap, juga di mode gelap: gambar ini dibubuhkan ke PDF berlatar
// putih, jadi bukan warna tampilan dan tidak memakai token tema. Di layar,
// kotak gambar selalu berlatar terang seperti kertas (lihat pad.css).
export const INK_COLOR = "#231D1A";

// Goresan disimpan dalam ruang logis 600 x 240 (rasio kotak 5:2), terlepas dari
// ukuran kotak di layar. Kotak boleh berubah ukuran tanpa merusak gambar.
const LOGICAL_W = 600;
const LOGICAL_H = 240;
const BASE_WIDTH = 3.2;
// Ekspor digambar 2x ruang logis (1200 x 480), lalu dipangkas.
const EXPORT_SCALE = 2;
const EXPORT_MARGIN = 16;

type Point = { x: number; y: number; w: number; t: number };
type Stroke = Point[];

export type SignaturePadHandle = {
  // PNG berlatar transparan, dipangkas ke batas goresan. Null kalau kosong.
  getPng: () => Promise<SignatureImage | null>;
  clear: () => void;
  isEmpty: () => boolean;
};

type Props = {
  ref?: Ref<SignaturePadHandle>;
  onChange?: (hasInk: boolean) => void;
  // Untuk aria-describedby, misalnya pesan error di form pemanggil.
  describedBy?: string;
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// Lebar target: tekanan pena kalau ada, kalau tidak dari kecepatan gerak
// (cepat = tipis), supaya goresan mouse tidak terlihat seperti garis spidol rata.
function targetWidth(e: PointerEvent, prev: Point | undefined, x: number, y: number, t: number): number {
  if (e.pointerType === "pen" && e.pressure > 0) {
    return BASE_WIDTH * (0.45 + 1.1 * e.pressure);
  }
  if (!prev) return BASE_WIDTH;
  const dt = Math.max(1, t - prev.t);
  const speed = Math.hypot(x - prev.x, y - prev.y) / dt;
  return BASE_WIDTH * clamp(1.15 - speed * 0.12, 0.65, 1.15);
}

function drawStroke(ctx: CanvasRenderingContext2D, pts: Stroke): void {
  if (pts.length === 0) return;
  if (pts.length === 1) {
    const p = pts[0];
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.w / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  // Kurva kuadrat lewat titik tengah antar titik: garis halus tanpa sudut patah.
  // Tiap ruas digambar sendiri supaya lebarnya bisa berubah sepanjang goresan.
  let sx = pts[0].x;
  let sy = pts[0].y;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    ctx.lineWidth = pts[i].w;
    ctx.stroke();
    sx = mx;
    sy = my;
  }
  const last = pts[pts.length - 1];
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(last.x, last.y);
  ctx.lineWidth = last.w;
  ctx.stroke();
}

function paint(ctx: CanvasRenderingContext2D, strokes: Stroke[], scale: number, width: number, height: number): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.strokeStyle = INK_COLOR;
  ctx.fillStyle = INK_COLOR;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of strokes) drawStroke(ctx, s);
}

// Kotak menggambar tanda tangan dengan mouse, pena, atau sentuh.
export function SignaturePad({ ref, onChange, describedBy }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Stroke[]>([]);
  const active = useRef<{ id: number; stroke: Stroke } | null>(null);
  const frame = useRef(0);
  const [count, setCount] = useState(0);
  const hintId = useId();

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || canvas.width === 0) return;
    paint(ctx, strokes.current, canvas.width / LOGICAL_W, canvas.width, canvas.height);
  }, []);

  const scheduleRedraw = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      redraw();
    });
  }, [redraw]);

  // Ukuran piksel canvas mengikuti ukuran di layar x devicePixelRatio, supaya tajam di layar HiDPI.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const fit = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(rect.width * dpr);
      const h = Math.round((rect.width * dpr * LOGICAL_H) / LOGICAL_W);
      if (w > 0 && (canvas.width !== w || canvas.height !== h)) {
        canvas.width = w;
        canvas.height = h;
      }
      redraw();
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(fit);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [redraw]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const commit = useCallback(
    (next: number) => {
      setCount(next);
      onChange?.(next > 0);
    },
    [onChange],
  );

  const clear = useCallback(() => {
    strokes.current = [];
    active.current = null;
    redraw();
    commit(0);
  }, [commit, redraw]);

  const undo = useCallback(() => {
    strokes.current = strokes.current.slice(0, -1);
    active.current = null;
    redraw();
    commit(strokes.current.length);
  }, [commit, redraw]);

  useImperativeHandle(
    ref,
    () => ({
      clear,
      isEmpty: () => strokes.current.length === 0,
      getPng: async () => {
        if (strokes.current.length === 0) return null;
        const w = LOGICAL_W * EXPORT_SCALE;
        const h = LOGICAL_H * EXPORT_SCALE;
        const out = document.createElement("canvas");
        out.width = w;
        out.height = h;
        const ctx = out.getContext("2d", { willReadFrequently: true });
        if (!ctx) return null;
        paint(ctx, strokes.current, EXPORT_SCALE, w, h);
        return trimToPng(out, EXPORT_MARGIN);
      },
    }),
    [clear],
  );

  function toLogical(e: PointerEvent): { x: number; y: number } {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * LOGICAL_W,
      y: ((e.clientY - rect.top) / rect.height) * LOGICAL_H,
    };
  }

  function addPoint(e: PointerEvent, stroke: Stroke): void {
    const { x, y } = toLogical(e);
    const t = e.timeStamp;
    const prev = stroke[stroke.length - 1];
    // Titik yang terlalu rapat diabaikan: mengurangi getar tangan.
    if (prev && Math.hypot(x - prev.x, y - prev.y) < 1.2) return;
    const target = targetWidth(e, prev, x, y, t);
    const w = prev ? prev.w + (target - prev.w) * 0.35 : target;
    stroke.push({ x, y, w, t });
  }

  function onPointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (active.current) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    try {
      // Goresan tetap diterima walau pointer keluar dari kotak.
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Pointer sudah tidak aktif (mis. pena diangkat sangat cepat): goresan tetap dicatat.
    }
    const stroke: Stroke = [];
    addPoint(e.nativeEvent, stroke);
    active.current = { id: e.pointerId, stroke };
    strokes.current = [...strokes.current, stroke];
    scheduleRedraw();
  }

  function onPointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    const cur = active.current;
    if (!cur || cur.id !== e.pointerId) return;
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [];
    for (const ev of events.length > 0 ? events : [e.nativeEvent]) addPoint(ev, cur.stroke);
    scheduleRedraw();
  }

  function endStroke(e: ReactPointerEvent<HTMLCanvasElement>) {
    const cur = active.current;
    if (!cur || cur.id !== e.pointerId) return;
    active.current = null;
    scheduleRedraw();
    commit(strokes.current.length);
  }

  const label = count === 0 ? "Kotak menggambar tanda tangan, masih kosong" : `Kotak menggambar tanda tangan, berisi ${count} goresan`;

  return (
    <div className="sig-pad">
      <div className="sig-paper">
        <canvas
          ref={canvasRef}
          className="sig-canvas"
          role="img"
          aria-label={label}
          aria-describedby={[hintId, describedBy].filter(Boolean).join(" ")}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
          onLostPointerCapture={endStroke}
        />
        <span className="sig-baseline" aria-hidden="true" />
      </div>
      <div className="sig-pad-bar">
        <p id={hintId} className="hint">
          Tanda tangani di atas garis dengan mouse, pena, atau jari. Pena yang ditekan lebih kuat membuat garis lebih tebal.
        </p>
        <div className="sig-pad-tools">
          <button type="button" className="btn btn-ghost btn-sm" onClick={undo} disabled={count === 0}>
            <IconArrowBackUp size={16} aria-hidden="true" />
            Batalkan goresan
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={clear} disabled={count === 0}>
            <IconEraser size={16} aria-hidden="true" />
            Kosongkan
          </button>
        </div>
      </div>
    </div>
  );
}
