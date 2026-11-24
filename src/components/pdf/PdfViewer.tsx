import { IconChevronLeft, IconChevronRight, IconMinus, IconPlus } from "@tabler/icons-react";
import type { PDFPageProxy, RenderTask } from "pdfjs-dist";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ErrorAlert } from "../ErrorAlert";
import { displaySize, normalizeRotation } from "./coords";
import { PDF_TEXT as T } from "../../i18n/components";
import { describePdfError, isRenderCancelled, loadPdf, type LoadedPdf } from "./pdfjs";
import type { PageGeometry, PageRenderInfo } from "./types";
import "./pdf.css";

export type PdfZoom = number | "fit";

type Props = {
  // Byte PDF. Simpan referensinya stabil (useMemo/state): array baru berarti dokumen dimuat ulang.
  data: Uint8Array;
  // Nama wilayah halaman untuk pembaca layar, mis. "Kontrak sewa.pdf".
  label: string;
  // Nomor halaman mulai 1. Kalau diisi, komponen dikendalikan pemanggil.
  page?: number;
  onPageChange?: (page: number) => void;
  // Skala (1 = 100%) atau "fit" untuk sesuai lebar. Bawaan "fit".
  zoom?: PdfZoom;
  onZoomChange?: (z: PdfZoom) => void;
  // Lapisan di atas halaman yang tampil, seukuran halaman (px CSS).
  renderOverlay?: (info: PageRenderInfo) => ReactNode;
  onLoaded?: (info: { pageCount: number; pages: PageGeometry[] }) => void;
  // Tombol tambahan di ujung kanan toolbar.
  toolbarExtra?: ReactNode;
};

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
// Jarak kertas ke tepi area baca, harus sama dengan padding .pdf-scroll di pdf.css.
const GUTTER = 24;
// Batas piksel canvas supaya zoom besar di layar HiDPI tidak menghabiskan memori.
const MAX_CANVAS_PIXELS = 16_777_216;

type Doc =
  | { status: "loading" }
  // Galat mentah; teksnya disusun saat render supaya ikut bahasa aktif.
  | { status: "error"; error: unknown }
  | { status: "empty" }
  | { status: "ready"; pdf: LoadedPdf; pages: PageGeometry[]; proxies: PDFPageProxy[] };

function clamp(n: number, lo: number, hi: number) {
  return Math.min(Math.max(n, lo), hi);
}

function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => (typeof window === "undefined" ? 1 : window.devicePixelRatio || 1));
  useEffect(() => {
    const mq = window.matchMedia?.(`(resolution: ${dpr}dppx)`);
    if (!mq) return;
    const update = () => setDpr(window.devicePixelRatio || 1);
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [dpr]);
  return dpr;
}

export function PdfViewer({ data, label, page, onPageChange, zoom, onZoomChange, renderOverlay, onLoaded, toolbarExtra }: Props) {
  const [doc, setDoc] = useState<Doc>({ status: "loading" });
  const [ownPage, setOwnPage] = useState(1);
  const [ownZoom, setOwnZoom] = useState<PdfZoom>("fit");
  const [areaWidth, setAreaWidth] = useState(0);
  const [pageState, setPageState] = useState<{ key: string; status: "drawing" | "ready" | "error"; message?: string }>({
    key: "",
    status: "drawing",
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;
  const pageInputId = useId();
  const dpr = useDevicePixelRatio();

  // Muat dokumen.
  useEffect(() => {
    const ctrl = new AbortController();
    let loaded: LoadedPdf | null = null;
    setDoc({ status: "loading" });
    (async () => {
      try {
        loaded = await loadPdf(data, { signal: ctrl.signal });
        const count = loaded.doc.numPages;
        if (count === 0) {
          setDoc({ status: "empty" });
          onLoadedRef.current?.({ pageCount: 0, pages: [] });
          return;
        }
        const proxies = await Promise.all(Array.from({ length: count }, (_, i) => loaded!.doc.getPage(i + 1)));
        if (ctrl.signal.aborted) return;
        const pages = proxies.map<PageGeometry>((p, index) => {
          const [x0, y0, x1, y1] = p.view;
          return {
            index,
            view: [x0, y0, x1, y1],
            width: x1 - x0,
            height: y1 - y0,
            rotation: normalizeRotation(p.rotate),
            userUnit: p.userUnit,
          };
        });
        setDoc({ status: "ready", pdf: loaded, pages, proxies });
        onLoadedRef.current?.({ pageCount: count, pages });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setDoc({ status: "error", error: err });
      }
    })();
    return () => {
      ctrl.abort();
      void loaded?.destroy();
    };
  }, [data]);

  // Lebar area baca untuk "Sesuai lebar".
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setAreaWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setAreaWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ready = doc.status === "ready" ? doc : null;
  const pageCount = ready ? ready.pages.length : 0;
  const pageNumber = clamp(page ?? ownPage, 1, Math.max(1, pageCount));
  const pageIndex = pageNumber - 1;
  const geometry = ready?.pages[pageIndex] ?? null;
  const currentZoom = zoom ?? ownZoom;

  let scale = 1;
  if (geometry) {
    if (currentZoom === "fit") {
      const natural = displaySize(geometry, 1).width;
      const avail = Math.max(areaWidth - GUTTER * 2, 120);
      scale = clamp(avail / natural, MIN_SCALE, MAX_SCALE);
    } else {
      scale = clamp(currentZoom, MIN_SCALE, MAX_SCALE);
    }
  }
  const css = geometry ? displaySize(geometry, scale) : { width: 0, height: 0 };
  const renderKey = `${pageIndex}`;

  function goTo(n: number) {
    if (!pageCount) return;
    const next = clamp(Math.round(n), 1, pageCount);
    if (next === pageNumber) return;
    if (page === undefined) setOwnPage(next);
    onPageChange?.(next);
  }

  function setZoom(z: PdfZoom) {
    if (zoom === undefined) setOwnZoom(z);
    onZoomChange?.(z);
  }

  const atFirst = pageNumber <= 1;
  const atLast = pageNumber >= pageCount;
  const atMinZoom = scale <= MIN_SCALE + 0.001;
  const atMaxZoom = scale >= MAX_SCALE - 0.001;

  function zoomBy(dir: 1 | -1) {
    if (dir > 0 ? atMaxZoom : atMinZoom) return;
    const eps = 0.001;
    const next = dir > 0 ? ZOOM_STEPS.find((s) => s > scale + eps) : [...ZOOM_STEPS].reverse().find((s) => s < scale - eps);
    if (next !== undefined) setZoom(next);
  }

  // Halaman baru: kosongkan canvas lama dan kembali ke atas.
  useLayoutEffect(() => {
    hostRef.current?.replaceChildren();
    scrollRef.current?.scrollTo?.({ top: 0 });
  }, [pageIndex, ready]);

  // Render halaman ke canvas baru, lalu tukar setelah selesai supaya tidak
  // berkedip saat zoom. Render lama dibatalkan kalau halaman atau zoom berubah.
  useEffect(() => {
    if (!ready || !geometry) return;
    const proxy = ready.proxies[pageIndex];
    const viewport = proxy.getViewport({ scale });
    const areaPx = viewport.width * viewport.height;
    const outputScale = Math.max(0.5, Math.min(dpr, Math.sqrt(MAX_CANVAS_PIXELS / Math.max(areaPx, 1))));
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.setAttribute("aria-hidden", "true");
    let task: RenderTask | null = null;
    let cancelled = false;
    setPageState((s) => (s.key === renderKey && s.status === "ready" ? s : { key: renderKey, status: "drawing" }));
    try {
      task = proxy.render({
        canvas,
        viewport,
        transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
      });
    } catch (err) {
      setPageState({ key: renderKey, status: "error", message: err instanceof Error ? err.message : String(err) });
      return;
    }
    task.promise.then(
      () => {
        if (cancelled) return;
        hostRef.current?.replaceChildren(canvas);
        setPageState({ key: renderKey, status: "ready" });
      },
      (err: unknown) => {
        if (cancelled || isRenderCancelled(err)) return;
        setPageState({ key: renderKey, status: "error", message: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [ready, geometry, pageIndex, scale, dpr, renderKey]);

  function onAreaKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const t = e.target as HTMLElement;
    if (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return;
    if (e.key === "PageDown") {
      e.preventDefault();
      goTo(pageNumber + 1);
    } else if (e.key === "PageUp") {
      e.preventDefault();
      goTo(pageNumber - 1);
    }
  }

  const info: PageRenderInfo | null = geometry ? { ...geometry, scale, cssWidth: css.width, cssHeight: css.height } : null;
  const shownState = pageState.key === renderKey ? pageState : { key: renderKey, status: "drawing" as const };
  const docError = doc.status === "error" ? describePdfError(doc.error) : null;

  return (
    <div className="pdf-viewer">
      <div className="pdf-toolbar" role="toolbar" aria-label={T.toolbar(label)}>
        <div className="pdf-toolbar-row">
          <div className="pdf-tool-group">
            <button
              type="button"
              className="btn btn-ghost btn-sm pdf-nav-btn"
              onClick={() => {
                if (!atFirst) goTo(pageNumber - 1);
              }}
              disabled={!ready}
              aria-disabled={ready && atFirst ? true : undefined}
              aria-label={T.prev}
              title={T.prevTitle}
            >
              <IconChevronLeft size={16} aria-hidden="true" />
              <span className="pdf-btn-text">{T.prev}</span>
            </button>
            <PageField
              id={pageInputId}
              page={pageNumber}
              count={pageCount}
              disabled={!ready}
              onCommit={goTo}
            />
            <button
              type="button"
              className="btn btn-ghost btn-sm pdf-nav-btn"
              onClick={() => {
                if (!atLast) goTo(pageNumber + 1);
              }}
              disabled={!ready}
              aria-disabled={ready && atLast ? true : undefined}
              aria-label={T.next}
              title={T.nextTitle}
            >
              <span className="pdf-btn-text">{T.next}</span>
              <IconChevronRight size={16} aria-hidden="true" />
            </button>
          </div>
          <div className="pdf-tool-group">
            <button
              type="button"
              className="btn btn-ghost btn-sm pdf-icon-btn"
              onClick={() => zoomBy(-1)}
              disabled={!ready}
              aria-disabled={ready && atMinZoom ? true : undefined}
              aria-label={T.zoomOut}
              title={T.zoomOut}
            >
              <IconMinus size={16} aria-hidden="true" />
            </button>
            {ready ? (
              <span className="pdf-zoom-value" aria-label={T.zoomValue(Math.round(scale * 100))}>
                {Math.round(scale * 100)}%
              </span>
            ) : (
              <span className="pdf-zoom-value" aria-hidden="true">
                -
              </span>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-sm pdf-icon-btn"
              onClick={() => zoomBy(1)}
              disabled={!ready}
              aria-disabled={ready && atMaxZoom ? true : undefined}
              aria-label={T.zoomIn}
              title={T.zoomIn}
            >
              <IconPlus size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-pressed={currentZoom === "fit"}
              onClick={() => setZoom("fit")}
              disabled={!ready}
            >
              {T.fitWidth}
            </button>
            {toolbarExtra}
          </div>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="pdf-scroll"
        role="region"
        aria-label={label}
        tabIndex={0}
        onKeyDown={onAreaKeyDown}
      >
        {doc.status === "loading" && <p className="pdf-status">{T.loading}</p>}
        {docError && (
          <div className="pdf-status-box" role="alert">
            <ErrorAlert title={docError.title}>
              <p>{docError.detail}</p>
            </ErrorAlert>
          </div>
        )}
        {doc.status === "empty" && (
          <p className="pdf-status">{T.empty}</p>
        )}
        {info && (
          <div
            className="pdf-page"
            style={{ width: css.width, height: css.height }}
            aria-label={T.pageOf(pageNumber, pageCount)}
            role="group"
            data-page-state={shownState.status}
          >
            <div ref={hostRef} className="pdf-canvas-host" />
            {shownState.status === "drawing" && (
              <p className="pdf-page-note" aria-hidden="true">
                {T.drawing(pageNumber)}
              </p>
            )}
            {shownState.status === "error" && (
              <div className="pdf-page-error" role="alert">
                <ErrorAlert title={T.pageErrorTitle(pageNumber)}>
                  <p>{T.pageErrorBody(shownState.message ?? "")}</p>
                </ErrorAlert>
              </div>
            )}
            <div className="pdf-overlay">{renderOverlay?.(info)}</div>
          </div>
        )}
      </div>
      <p className="sr-only" aria-live="polite">
        {ready ? T.pageOf(pageNumber, pageCount) : ""}
      </p>
    </div>
  );
}

type PageFieldProps = {
  id: string;
  page: number;
  count: number;
  disabled: boolean;
  onCommit: (n: number) => void;
};

// Isian nomor halaman. Nilai disimpan saat Enter atau saat fokus pindah;
// angka di luar jangkauan dijepit, teks bukan angka dikembalikan.
function PageField({ id, page, count, disabled, onCommit }: PageFieldProps) {
  const [text, setText] = useState(String(page));
  useEffect(() => setText(String(page)), [page]);

  function commit() {
    const n = Number.parseInt(text, 10);
    if (Number.isFinite(n)) onCommit(n);
    setText(String(page));
  }

  return (
    <span className="pdf-page-field">
      <label htmlFor={id} className="pdf-page-label">
        {T.pageField}
      </label>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={disabled ? "" : text}
        disabled={disabled}
        size={Math.max(2, String(count).length)}
        onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, ""))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            setText(String(page));
          }
        }}
      />
      <span>{T.pageFieldOf(count ? String(count) : "-")}</span>
    </span>
  );
}
