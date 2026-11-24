import { IconMinus, IconPlus } from "@tabler/icons-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { toAppError, type AppError } from "../../api";
import { profileSetPhoto, type PhotoEntry, type PickedPhoto } from "../../api/profile";
import { PROFILE_CROP_TEXT as T } from "../../i18n/profile-crop";
import { Dialog } from "../Dialog";
import { ErrorAlert } from "../ErrorAlert";
import {
  cropSize,
  imageLayout,
  initialView,
  maxZoom,
  panBy,
  toCrop,
  zoomTo,
  type CropView,
  type ImageSize,
} from "./photoCrop";
import "./photoCrop.css";

type Props = {
  picked: PickedPhoto;
  onCancel: () => void;
  onSaved: (entry: PhotoEntry) => void;
};

// Langkah geser keyboard dalam pecahan sisi bingkai.
const KEY_STEP = 0.05;
const KEY_STEP_BIG = 0.25;
// Tombol +/- dan tombol keyboard +/- mengalikan zoom dengan faktor ini.
const ZOOM_STEP = 1.25;
// Ukuran bingkai kalau tata letak belum terukur (sama dengan CSS).
const FALLBACK_FRAME = 280;
// Jeda sebelum posisi atau perbesaran diumumkan, supaya menahan tombol panah
// tidak membacakan setiap langkah.
const ANNOUNCE_DELAY = 400;

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

// Dialog "Atur foto profil": pilih bagian persegi foto dengan geser dan zoom,
// lalu simpan. Kotak potong dihitung dalam piksel gambar sumber (photoCrop.ts).
export function PhotoCropDialog({ picked, onCancel, onSaved }: Props) {
  const img: ImageSize = { width: picked.width, height: picked.height };
  const [view, setView] = useState<CropView>(() => initialView(img));
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  // Bingkai sebagai state juga: isi dialog Radix bisa terpasang setelah efek
  // pertama berjalan, jadi pendengar roda dipasang saat elemennya ada.
  const [frameEl, setFrameEl] = useState<HTMLDivElement | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; start: CropView; frame: number } | null>(null);
  const hintId = useId();
  const [announcement, setAnnouncement] = useState("");
  const announceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Nilai terbaru untuk pendengar roda mouse yang dipasang sekali.
  const latest = useRef({ img, view });
  latest.current = { img, view };

  const top = maxZoom(img);
  const percent = Math.round(view.zoom * 100);
  const maxPercent = Math.round(top * 100);
  const atMin = view.zoom <= 1;
  const atMax = view.zoom >= top;
  const layout = imageLayout(img, view);

  const zoomBy = (factor: number) => setView((v) => zoomTo(img, v, v.zoom * factor));

  // Pengumuman untuk pembaca layar setelah geser atau zoom dengan keyboard dan
  // tombol +/-. Dibaca dari nilai terbaru saat jeda habis.
  function announce(kind: "zoom" | "position") {
    if (announceTimer.current) clearTimeout(announceTimer.current);
    announceTimer.current = setTimeout(() => {
      announceTimer.current = null;
      const { img: i, view: v } = latest.current;
      if (kind === "zoom") {
        setAnnouncement(T.announceZoom(Math.round(v.zoom * 100)));
        return;
      }
      // Letak kotak potong di dalam ruang geraknya: 0% di tepi kiri/atas foto.
      const size = cropSize(i, v.zoom);
      const share = (center: number, length: number) =>
        length - size > 0.5 ? Math.round(((center - size / 2) / (length - size)) * 100) : 50;
      setAnnouncement(T.announcePosition(share(v.cx, i.width), share(v.cy, i.height)));
    }, ANNOUNCE_DELAY);
  }

  useEffect(
    () => () => {
      if (announceTimer.current) clearTimeout(announceTimer.current);
    },
    [],
  );

  // Roda mouse memperbesar. Pendengar asli (bukan onWheel React) karena React
  // memasangnya pasif, jadi dialog akan ikut bergulir.
  useEffect(() => {
    const frame = frameEl;
    if (!frame) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { img: i } = latest.current;
      setView((v) => zoomTo(i, v, v.zoom * Math.exp(-e.deltaY * 0.002)));
    };
    frame.addEventListener("wheel", onWheel, { passive: false });
    return () => frame.removeEventListener("wheel", onWheel);
  }, [frameEl]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const dir = ARROWS[e.key];
    if (dir) {
      e.preventDefault();
      const step = e.shiftKey ? KEY_STEP_BIG : KEY_STEP;
      setView((v) => panBy(img, v, dir[0] * step, dir[1] * step));
      announce("position");
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      zoomBy(ZOOM_STEP);
      announce("zoom");
    } else if (e.key === "-") {
      e.preventDefault();
      zoomBy(1 / ZOOM_STEP);
      announce("zoom");
    }
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const width = frameRef.current?.getBoundingClientRect().width || FALLBACK_FRAME;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, start: view, frame: width };
    frameRef.current?.setPointerCapture?.(e.pointerId);
    setDragging(true);
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    setView(panBy(img, d.start, (e.clientX - d.x) / d.frame, (e.clientY - d.y) / d.frame));
  }

  function endDrag(e: PointerEvent<HTMLDivElement>) {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const entry = await profileSetPhoto(picked.token, toCrop(img, view));
      onSaved(entry);
    } catch (err) {
      setError(toAppError(err));
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !saving) onCancel();
      }}
      title={T.title}
      description={T.description}
    >
      <div className="pcd">
        <div
          ref={(node) => {
            frameRef.current = node;
            setFrameEl(node);
          }}
          className={`pcd-frame${dragging ? " is-dragging" : ""}`}
          role="group"
          aria-label={T.area}
          aria-describedby={hintId}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <img
            className="pcd-img"
            src={`data:image/jpeg;base64,${picked.preview}`}
            alt=""
            draggable={false}
            style={{
              left: `${layout.left}%`,
              top: `${layout.top}%`,
              width: `${layout.width}%`,
              height: `${layout.height}%`,
            }}
          />
          <span className="pcd-mask" aria-hidden="true" />
        </div>
        <p id={hintId} className="pcd-hint">
          {T.areaHint}
        </p>
        <p className="sr-only" aria-live="polite">
          {announcement}
        </p>

        <div className="pcd-zoom">
          <button
            type="button"
            className="btn btn-ghost pcd-zoom-btn"
            aria-label={T.zoomOut}
            aria-disabled={atMin || undefined}
            onClick={() => {
              if (atMin) return;
              zoomBy(1 / ZOOM_STEP);
              announce("zoom");
            }}
          >
            <IconMinus size={18} aria-hidden="true" />
          </button>
          <label className="pcd-slider">
            <span className="pcd-slider-label">{T.zoom}</span>
            <input
              type="range"
              min={100}
              max={maxPercent}
              step={5}
              value={percent}
              disabled={maxPercent <= 100}
              aria-valuetext={T.zoomValue(percent)}
              onChange={(e) => {
                const value = Number(e.target.value);
                setView((v) => zoomTo(img, v, value / 100));
              }}
            />
          </label>
          <button
            type="button"
            className="btn btn-ghost pcd-zoom-btn"
            aria-label={T.zoomIn}
            aria-disabled={atMax || undefined}
            onClick={() => {
              if (atMax) return;
              zoomBy(ZOOM_STEP);
              announce("zoom");
            }}
          >
            <IconPlus size={18} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div aria-live="polite">
        {error && <ErrorAlert title={T.errorTitle}>{error.message}</ErrorAlert>}
      </div>

      <div className="dlg-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={saving}>
          {T.cancel}
        </button>
        <button type="button" className="btn" onClick={() => void save()} disabled={saving} aria-busy={saving || undefined}>
          {saving ? T.saving : T.save}
        </button>
      </div>
    </Dialog>
  );
}
