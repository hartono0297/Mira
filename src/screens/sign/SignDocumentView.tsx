import {
  IconAlertTriangle,
  IconArrowLeft,
  IconCheck,
  IconCircleCheck,
  IconFolderOpen,
  IconLock,
  IconMinus,
  IconPlus,
  IconSignature,
} from "@tabler/icons-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { toAppError, type AppError } from "../../api";
import { signingApi, type ExportView, type RequestDetail, type SignerView, type SignOverview } from "../../api/signing";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { cssRectToPdf, pdfRectToCss } from "../../components/pdf/coords";
import { PdfViewer, type PdfZoom } from "../../components/pdf/PdfViewer";
import { PlacementBox } from "../../components/pdf/PlacementBox";
import type { PageGeometry, PageRenderInfo, PdfRect } from "../../components/pdf/types";
import { PinDialog } from "./pad/PinDialog";
import { SignatureSetupDialog } from "./pad/SignatureSetupDialog";
import { AuditTrail, HashText } from "./AuditTrail";
import {
  coolingText,
  exportNoticeText,
  exportStateLabel,
  formatWhen,
  headerStatusLabel,
  integrityLabel,
  kindLabel,
} from "./labels";
import {
  BOX_MIN_WIDTH_PT,
  SIZE_STEP_PT,
  describeSpot,
  movePlacement,
  placementOffsetsPt,
  placementWidthPt,
  quickPlacement,
  resizePlacement,
  runSignFlow,
  type QuickSpot,
} from "./signFlow";
import "./document.css";

type Props = { requestId: string; onBack: () => void; onChanged?: () => void };

type Loaded = { detail: RequestDetail; overview: SignOverview };

type FileState =
  | { status: "idle" }
  | { status: "missing" }
  | { status: "loading"; hash: string }
  | { status: "ready"; hash: string; data: Uint8Array }
  | { status: "error"; hash: string; error: AppError };

type Done = "mine" | "all";

const EXPORT_NOTE: Partial<Record<ExportView["state"], string>> = {
  changed: "Isi salinan ini berbeda dari versi yang ditandatangani. Jangan pakai sebagai dokumen sah.",
  missing: "File ini sudah dipindah, diganti nama, atau dihapus.",
};

const QUICK_SPOTS: { spot: QuickSpot; label: string }[] = [
  { spot: "left", label: "Kiri bawah" },
  { spot: "center", label: "Tengah bawah" },
  { spot: "right", label: "Kanan bawah" },
];

// Error yang berarti data di layar sudah usang; layar dimuat ulang di belakang.
const STALE_CODES = new Set(["version_conflict", "not_your_turn", "request_closed", "already_signed", "not_found"]);

function signerStatus(
  s: SignerView,
  detail: RequestDetail,
  fileTrusted: boolean,
): { text: string; tone: "done" | "now" | "wait" } {
  if (s.status === "signed") return { text: s.signedAt ? `Sudah, ${formatWhen(s.signedAt)}` : "Sudah", tone: "done" };
  if (detail.status === "cancelled") return { text: "Belum, permintaan dibatalkan", tone: "wait" };
  if (s.isMe && s.canSignNow) {
    return fileTrusted ? { text: "Giliran Anda", tone: "now" } : { text: "Tidak bisa ditandatangani", tone: "wait" };
  }
  return { text: "Menunggu", tone: "wait" };
}

// Banner bahaya. Langkah lanjutnya beda untuk pengirim: ia sendiri yang
// memegang file asli, jadi tidak disuruh meminta salinan dari pengirim.
function integrityProblem(detail: RequestDetail, isRequester: boolean): { title: string; body: ReactNode } | null {
  if (detail.integrity === "changed") {
    return {
      title: integrityLabel("changed"),
      body: (
        <>
          <p>
            File yang disimpan Mira tidak lagi cocok dengan sidik file yang tercatat. Isinya mungkin diubah di luar Mira, jadi isi
            dan tanda tangannya tidak bisa dipercaya.
          </p>
          <p>
            {isRequester
              ? "Jangan kirim atau cetak file ini. Kalau dokumen ini masih perlu ditandatangani, buat permintaan baru dengan file asli yang Anda simpan."
              : "Jangan kirim atau cetak file ini. Minta salinan dari pengirim, lalu periksa salinan itu dengan Periksa file PDF di layar Tanda tangan."}
          </p>
        </>
      ),
    };
  }
  if (detail.integrity === "missing") {
    return {
      title: "File dokumen tidak ditemukan",
      body: (
        <>
          <p>File versi terkini hilang dari folder data Mira, mungkin terhapus atau dipindah. Riwayat tanda tangan tetap ada.</p>
          <p>Kalau Anda pernah menyimpan salinannya, periksa salinan itu dengan Periksa file PDF di layar Tanda tangan.</p>
        </>
      ),
    };
  }
  if (detail.sealValid === false) {
    return {
      title: "Catatan penguncian tidak sah",
      body: (
        <>
          <p>
            Catatan bahwa dokumen ini selesai dan dikunci tidak cocok dengan kunci laptop pencatatnya atau dengan sidik file.
            Data Mira mungkin diubah di luar aplikasi.
          </p>
          <p>
            {isRequester
              ? "Anggap dokumen ini belum terkunci. Kalau perlu, buat permintaan baru dengan file asli yang Anda simpan."
              : "Anggap dokumen ini belum terkunci dan minta salinan dari pengirim."}
          </p>
        </>
      ),
    };
  }
  return null;
}

// Tombol yang bisa sedang difokus tidak dibuat disabled (fokus akan jatuh ke
// body); cukup aria-disabled, dan handler-nya menolak dijalankan.
function guarded(off: boolean, fn: () => void) {
  return () => {
    if (!off) fn();
  };
}

type PendingFocus = "box" | "place" | "done" | null;

export function SignDocumentView({ requestId, onBack, onChanged }: Props) {
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [file, setFile] = useState<FileState>({ status: "idle" });
  const [pages, setPages] = useState<PageGeometry[]>([]);
  // Halaman dan zoom dikendalikan di sini supaya tidak kembali ke awal saat
  // penampil dimuat ulang dengan versi baru setelah menandatangani.
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState<PdfZoom>("fit");

  const [placement, setPlacement] = useState<PdfRect | null>(null);
  const [stampMark, setStampMark] = useState<PdfRect | null>(null);
  const [live, setLive] = useState("");
  const [setupOpen, setSetupOpen] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [, setTick] = useState(0);

  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<string | null>(null);
  const [exportError, setExportError] = useState<AppError | null>(null);
  const [revealError, setRevealError] = useState<AppError | null>(null);

  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<AppError | null>(null);

  const mounted = useRef(true);
  const loadSeq = useRef(0);
  const fileSeq = useRef(0);
  const fileHash = useRef<string | null>(null);
  const viaKeyboard = useRef(false);
  const liveTimer = useRef<number | undefined>(undefined);
  const viewerRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<PendingFocus>(null);
  const scrollToStamp = useRef(false);
  const titleFocused = useRef(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const placeBtnRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const exportHintId = useId();
  const placeHintId = useId();
  const signHintId = useId();

  useEffect(() => {
    mounted.current = true;
    // Layar baru: pembaca layar mulai dari judul, juga selama masih memuat.
    titleRef.current?.focus();
    return () => {
      mounted.current = false;
      window.clearTimeout(liveTimer.current);
    };
  }, []);

  // Data pertama tiba: judul dokumen menggantikan judul sementara, fokus ke sana.
  useEffect(() => {
    if (!data || titleFocused.current) return;
    titleFocused.current = true;
    titleRef.current?.focus();
  }, [data]);

  // Byte PDF hanya diganti saat hash versi berubah, supaya PdfViewer tidak memuat ulang.
  const loadFile = useCallback(async (detail: RequestDetail, force = false) => {
    if (detail.integrity === "missing") {
      // Naikkan nomor urut supaya balasan baca file yang masih berjalan diabaikan.
      ++fileSeq.current;
      fileHash.current = null;
      setFile({ status: "missing" });
      return;
    }
    if (!force && fileHash.current === detail.currentHash) return;
    const seq = ++fileSeq.current;
    const hash = detail.currentHash;
    fileHash.current = hash;
    setFile({ status: "loading", hash });
    try {
      const bytes = await signingApi.readFile(detail.id, hash);
      if (!mounted.current || seq !== fileSeq.current) return;
      setFile({ status: "ready", hash, data: bytes });
    } catch (err) {
      if (!mounted.current || seq !== fileSeq.current) return;
      fileHash.current = null;
      setFile({ status: "error", hash, error: toAppError(err) });
    }
  }, []);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setLoadError(null);
    try {
      const [detail, overview] = await Promise.all([signingApi.getRequest(requestId), signingApi.overview()]);
      if (!mounted.current || seq !== loadSeq.current) return;
      setData({ detail, overview });
      setLoading(false);
      void loadFile(detail);
    } catch (err) {
      if (!mounted.current || seq !== loadSeq.current) return;
      setLoadError(toAppError(err));
      setLoading(false);
    }
  }, [requestId, loadFile]);

  useEffect(() => {
    void load();
  }, [load]);

  const detail = data?.detail ?? null;
  const overview = data?.overview ?? null;
  const saved = overview?.saved ?? null;
  const me = overview?.me ?? null;
  const aspect = saved && saved.width > 0 && saved.height > 0 ? saved.width / saved.height : 2;
  const mySigner = detail?.signers.find((s) => s.isMe) ?? null;
  // File yang berubah atau hilang tidak boleh ditandatangani: tanda tangan baru akan menutupi masalahnya.
  const fileTrusted = !!detail && detail.integrity === "intact";
  const canSign = !!(detail && detail.status === "in_progress" && mySigner?.canSignNow && fileTrusted);
  const placing = canSign && !!saved && placement !== null;
  const fileReady = file.status === "ready" && !!detail && file.hash === detail.currentHash;
  const cooling = coolingText(saved?.usableAfter);

  // Batal menempatkan kalau giliran hilang (mis. dimuat ulang setelah bentrok).
  useEffect(() => {
    if (!canSign && placement) setPlacement(null);
  }, [canSign, placement]);

  // Dialog PIN tidak boleh tertinggal terbuka tanpa kotak yang ditempatkan.
  useEffect(() => {
    if (pinOpen && !placement) setPinOpen(false);
  }, [pinOpen, placement]);

  // Masa tunggu tanda tangan baru: render ulang saat waktunya lewat.
  const usableAfter = saved?.usableAfter ?? null;
  useEffect(() => {
    const until = usableAfter ? Date.parse(usableAfter) : Number.NaN;
    if (!Number.isFinite(until) || until <= Date.now()) return;
    const timer = window.setTimeout(() => setTick((n) => n + 1), Math.min(until - Date.now() + 500, 2 ** 31 - 1));
    return () => window.clearTimeout(timer);
  }, [usableAfter]);

  // Fokus yang tertunda sampai elemen tujuannya ada di layar: kotak tanda
  // tangan, tombol tempatkan, atau kotak konfirmasi sukses.
  useEffect(() => {
    const want = pendingFocus.current;
    if (want === "box") {
      const box = viewerRef.current?.querySelector<HTMLElement>(".pdf-place");
      if (box) {
        pendingFocus.current = null;
        box.focus();
      }
    } else if (want === "place") {
      if (placeBtnRef.current) {
        pendingFocus.current = null;
        placeBtnRef.current.focus();
      }
    } else if (want === "done" && !pinOpen && doneRef.current) {
      pendingFocus.current = null;
      const el = doneRef.current;
      // Setelah dialog PIN selesai menutup dan melepas kunci fokusnya.
      window.setTimeout(() => {
        if (el.isConnected) el.focus();
      }, 0);
    }
  });

  // Setelah menandatangani, area halaman digulir ke stempel begitu versi baru tampil.
  useEffect(() => {
    if (!scrollToStamp.current) return;
    const area = viewerRef.current?.querySelector<HTMLElement>(".pdf-scroll");
    const mark = viewerRef.current?.querySelector<HTMLElement>(".sdoc-stamp-mark");
    if (!area || !mark) return;
    scrollToStamp.current = false;
    const a = area.getBoundingClientRect();
    const m = mark.getBoundingClientRect();
    area.scrollTop += m.top - a.top - Math.max(0, (area.clientHeight - m.height) / 2);
    area.scrollLeft += m.left - a.left - Math.max(0, (area.clientWidth - m.width) / 2);
  });

  function announce(text: string, delay = 400) {
    window.clearTimeout(liveTimer.current);
    liveTimer.current = window.setTimeout(() => {
      if (mounted.current) setLive(text);
    }, delay);
  }

  function describe(rect: PdfRect): string {
    const geo = pages[rect.pageIndex];
    if (!geo) return `Kotak tanda tangan di halaman ${rect.pageIndex + 1}.`;
    // Jarak dalam poin ikut dibacakan supaya setiap geseran terdengar berbeda.
    const v = placementOffsetsPt(rect, geo);
    return `Halaman ${rect.pageIndex + 1}, ${describeSpot(rect, geo)}. Kiri ${v.left} pt, bawah ${v.bottom} pt, lebar ${v.width} pt.`;
  }

  function updatePlacement(next: PdfRect, say = true) {
    setPlacement(next);
    if (say) announce(describe(next));
  }

  function startPlacing() {
    const geo = pages[page - 1];
    if (!geo) return;
    setDone(null);
    setStampMark(null);
    pendingFocus.current = "box";
    updatePlacement(quickPlacement(geo, aspect, "right"));
  }

  function cancelPlacing() {
    setPlacement(null);
    pendingFocus.current = "place";
  }

  function quick(spot: QuickSpot) {
    const geo = pages[page - 1];
    if (!geo || !placement) return;
    const fromGeo = pages[placement.pageIndex];
    const width = fromGeo ? placementWidthPt(placement, fromGeo) : undefined;
    updatePlacement(quickPlacement(geo, aspect, spot, width), true);
  }

  function resize(delta: number) {
    if (!placement) return;
    const geo = pages[placement.pageIndex];
    if (!geo) return;
    const next = resizePlacement(placement, geo, aspect, delta);
    const before = placementWidthPt(placement, geo);
    const after = placementWidthPt(next, geo);
    if (Math.abs(after - before) < 0.01) {
      announce(delta > 0 ? "Kotak sudah ukuran terbesar di halaman ini." : "Kotak sudah ukuran terkecil.", 0);
      return;
    }
    updatePlacement(next);
  }

  // Dua tombol ini hilang setelah dipakai; fokus pindah ke kotak tanda tangan.
  function moveHere() {
    if (!placement) return;
    const from = pages[placement.pageIndex];
    const to = pages[page - 1];
    if (!from || !to) return;
    pendingFocus.current = "box";
    updatePlacement(movePlacement(placement, from, to, aspect));
  }

  function showBoxPage() {
    if (!placement) return;
    pendingFocus.current = "box";
    setPage(placement.pageIndex + 1);
  }

  // Ringkasan dimuat ulang tanpa mengganggu layar, supaya lockedUntil dan
  // usableAfter segar. Kalau gagal, data lama tetap dipakai.
  async function refreshOverview() {
    try {
      const fresh = await signingApi.overview();
      if (mounted.current) setData((d) => (d ? { ...d, overview: fresh } : d));
    } catch {
      // Diabaikan: error PIN sudah tampil di dialog, ringkasan dicoba lagi saat layar dimuat ulang.
    }
  }

  async function submitPin(pin: string) {
    if (!detail || !me) {
      throw { code: "not_ready", message: "Data dokumen belum selesai dimuat. Tutup dialog lalu coba lagi." } satisfies AppError;
    }
    if (!placement) {
      throw {
        code: "not_ready",
        message: "Kotak tanda tangan belum ditempatkan. Tutup dialog, tempatkan kotaknya, lalu coba lagi.",
      } satisfies AppError;
    }
    if (file.status !== "ready") {
      throw { code: "not_ready", message: "File dokumen belum selesai dibuka. Tunggu sebentar lalu coba lagi." } satisfies AppError;
    }
    if (file.hash !== detail.currentHash) {
      void load();
      throw {
        code: "version_conflict",
        message: "Dokumen baru saja berganti versi dan sedang dibuka ulang. Tunggu sebentar lalu coba lagi.",
      } satisfies AppError;
    }
    try {
      const result = await runSignFlow({ pin, detail, bytes: file.data, placement, me, api: signingApi });
      if (!mounted.current) return;
      const stamped = placement;
      setPlacement(null);
      setStampMark(stamped);
      scrollToStamp.current = true;
      setDone(result.status === "completed" ? "all" : "mine");
      pendingFocus.current = "done";
      setData((d) => (d ? { ...d, detail: result } : d));
      setPage(stamped.pageIndex + 1);
      void loadFile(result);
      // Hitungan PIN salah direset di inti Rust; muat ulang ringkasan dan detail.
      void load();
      onChanged?.();
    } catch (err) {
      const error = toAppError(err);
      if (STALE_CODES.has(error.code)) void load();
      else if (error.code === "pin_wrong" || error.code === "pin_locked" || error.code === "signature_cooling") {
        void refreshOverview();
      }
      throw error;
    }
  }

  async function saveSignature(input: { png: Uint8Array; pin: string }) {
    await signingApi.saveSignature(input.png, input.pin);
    const fresh = await signingApi.overview();
    if (!mounted.current) return;
    setData((d) => (d ? { ...d, overview: fresh } : d));
    onChanged?.();
  }

  async function exportCopy() {
    if (!detail) return;
    setExporting(true);
    setExportError(null);
    setRevealError(null);
    try {
      const { path } = await signingApi.exportFile(detail.id);
      if (!mounted.current) return;
      setExported(path);
      void load();
      onChanged?.();
    } catch (err) {
      if (mounted.current) setExportError(toAppError(err));
    } finally {
      if (mounted.current) setExporting(false);
    }
  }

  async function reveal(path: string) {
    setRevealError(null);
    try {
      await revealItemInDir(path);
    } catch (err) {
      const detail = toAppError(err);
      setRevealError({
        code: detail.code,
        message: "File Explorer tidak bisa dibuka dari Mira. Buka folder itu sendiri lewat lokasi di atas.",
      });
    }
  }

  async function confirmCancel() {
    if (!detail) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const result = await signingApi.cancel(detail.id);
      if (!mounted.current) return;
      setData((d) => (d ? { ...d, detail: result } : d));
      setCancelOpen(false);
      setPlacement(null);
      // Tombol pembuka dialog hilang setelah batal; fokus dipindah ke judul.
      window.setTimeout(() => titleRef.current?.focus(), 0);
      onChanged?.();
    } catch (err) {
      if (mounted.current) setCancelError(toAppError(err));
    } finally {
      if (mounted.current) setCancelling(false);
    }
  }

  // ---- Keadaan memuat dan error -----------------------------------------

  if (!data) {
    return (
      <main className="sdoc" aria-labelledby={titleId}>
        <header className="page-head sdoc-head">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
            <IconArrowLeft size={16} aria-hidden="true" />
            Kembali
          </button>
          <h1 id={titleId} ref={titleRef} tabIndex={-1} className="page-title sdoc-title">
            Dokumen tanda tangan
          </h1>
        </header>
        {loading || !loadError ? (
          <p className="sdoc-pad hint" role="status">
            Memuat dokumen...
          </p>
        ) : (
          <div className="sdoc-pad sdoc-narrow" role="alert">
            <ErrorAlert title="Dokumen belum bisa dibuka">
              <p>{loadError.message}</p>
              <div className="sdoc-row">
                <button type="button" className="btn btn-sm" onClick={() => void load()}>
                  Coba lagi
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
                  Kembali ke daftar
                </button>
              </div>
            </ErrorAlert>
          </div>
        )}
      </main>
    );
  }

  const d = data.detail;
  const isRequester = !!me && d.requestedBy.publicKey === me.publicKey;
  const problem = integrityProblem(d, isRequester);
  const locked = d.status === "completed" && d.sealValid === true;
  const sortedSigners = [...d.signers].sort((a, b) => a.position - b.position);
  const othersPending = d.status === "in_progress" && d.signers.some((s) => !s.isMe && s.status === "waiting");
  const firstWaiting = sortedSigners.find((s) => s.status === "waiting");
  const boxGeo = placement ? pages[placement.pageIndex] : undefined;
  const boxOnOtherPage = !!placement && placement.pageIndex !== page - 1;
  const sizeFixed = (delta: number) =>
    !!(placement && boxGeo) &&
    Math.abs(placementWidthPt(resizePlacement(placement, boxGeo, aspect, delta), boxGeo) - placementWidthPt(placement, boxGeo)) <
      0.01;
  const minWidthReached = sizeFixed(-SIZE_STEP_PT);
  const maxWidthReached = sizeFixed(SIZE_STEP_PT);
  const changedCopies = d.exports.filter((x) => x.state === "changed").length;
  const exportBlocked = d.integrity !== "intact" || d.sealValid === false;
  const exportOff = exporting || exportBlocked;
  const placeOff = !fileReady || pages.length === 0 || !!cooling;
  const signOff = !fileReady || !!cooling;

  const renderOverlay = (info: PageRenderInfo) => {
    if (placing && placement && me && info.index === placement.pageIndex) {
      const unit = info.scale * (info.userUnit ?? 1);
      return (
        <div
          className="sdoc-overlay"
          onKeyDownCapture={() => {
            viaKeyboard.current = true;
          }}
          onPointerDownCapture={() => {
            viaKeyboard.current = false;
          }}
        >
          <PlacementBox
            rect={pdfRectToCss(placement, info, info.scale)}
            bounds={{ width: info.cssWidth, height: info.cssHeight }}
            onChange={(css) => updatePlacement(cssRectToPdf(css, info, info.scale), viaKeyboard.current)}
            label={`Kotak tanda tangan ${me.displayName}`}
            description="Menandai tempat tanda tangan Anda di halaman. Gambar aslinya baru dipakai setelah PIN dimasukkan."
            aspectRatio={aspect}
            minWidth={BOX_MIN_WIDTH_PT * unit}
            step={5 * unit}
          >
            <span className="sdoc-ph">
              <span className="sdoc-ph-tag">
                <span className="sdoc-ph-name">{me.displayName}</span>
                <span className="sdoc-ph-sub">Tanda tangan Anda</span>
              </span>
            </span>
          </PlacementBox>
        </div>
      );
    }
    if (!placing && stampMark && info.index === stampMark.pageIndex) {
      // Penanda tak terlihat di posisi stempel, hanya untuk menggulir ke sana.
      const r = pdfRectToCss(stampMark, info, info.scale);
      return (
        <div
          className="sdoc-stamp-mark"
          aria-hidden="true"
          style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
        />
      );
    }
    return null;
  };

  // ---- Bagian panel ---------------------------------------------------------

  let myPart: ReactNode = null;
  if (canSign && !saved) {
    myPart = (
      <div className="notice">
        <IconSignature size={18} aria-hidden="true" />
        <div>
          <strong>Anda belum punya tanda tangan tersimpan</strong>
          <p>Buat sekali dengan mouse, pena, atau gambar hasil pindai. Setelah itu cukup masukkan PIN setiap kali menandatangani.</p>
          <button type="button" className="btn btn-sm sdoc-notice-btn" onClick={() => setSetupOpen(true)}>
            Buat tanda tangan
          </button>
        </div>
      </div>
    );
  } else if (canSign && saved && !placing) {
    myPart = (
      <div className="sdoc-act">
        <p>Tempatkan kotak tanda tangan di halaman, lalu masukkan PIN untuk memakai tanda tangan tersimpan.</p>
        <button
          ref={placeBtnRef}
          type="button"
          className="btn sdoc-wide"
          onClick={guarded(placeOff, startPlacing)}
          aria-disabled={placeOff || undefined}
          aria-describedby={placeOff ? placeHintId : undefined}
        >
          <IconSignature size={18} aria-hidden="true" />
          Tempatkan tanda tangan
        </button>
        {cooling ? (
          <p id={placeHintId} className="sdoc-cooling">
            {cooling}
          </p>
        ) : (
          placeOff && (
            <p id={placeHintId} className="hint">
              Tombol aktif setelah file selesai dibuka.
            </p>
          )
        )}
      </div>
    );
  } else if (placing && placement) {
    myPart = (
      <div className="sdoc-act">
        <p className="sdoc-where">
          Kotak ada di halaman {placement.pageIndex + 1}
          {boxGeo ? `, ${describeSpot(placement, boxGeo)}` : ""}.
        </p>
        {boxOnOtherPage && (
          <div className="sdoc-row">
            <button type="button" className="btn btn-ghost btn-sm" onClick={moveHere}>
              Pindahkan ke halaman ini
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={showBoxPage}>
              Lihat halaman {placement.pageIndex + 1}
            </button>
          </div>
        )}
        <div className="sdoc-ctl" role="group" aria-label="Posisi cepat di halaman yang tampil">
          <span className="sdoc-ctl-label" aria-hidden="true">
            Posisi
          </span>
          <div className="sdoc-seg">
            {QUICK_SPOTS.map((q) => (
              <button key={q.spot} type="button" className="btn btn-ghost btn-sm" onClick={() => quick(q.spot)}>
                {q.label}
              </button>
            ))}
          </div>
        </div>
        <div className="sdoc-ctl" role="group" aria-label="Ukuran kotak">
          <span className="sdoc-ctl-label" aria-hidden="true">
            Ukuran
          </span>
          <div className="sdoc-seg">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => resize(-SIZE_STEP_PT)}
              aria-disabled={minWidthReached || undefined}
            >
              <IconMinus size={15} aria-hidden="true" />
              Kecilkan kotak
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => resize(SIZE_STEP_PT)}
              aria-disabled={maxWidthReached || undefined}
            >
              <IconPlus size={15} aria-hidden="true" />
              Besarkan kotak
            </button>
          </div>
        </div>
        <p className="hint">
          Geser kotak dengan mouse atau tombol panah (tahan Shift untuk lebih jauh). Ubah ukuran dengan menarik sudut kanan bawah,
          tombol Kecilkan atau Besarkan, atau Alt dan panah.
        </p>
        <button
          type="button"
          className="btn sdoc-wide"
          onClick={guarded(signOff, () => setPinOpen(true))}
          aria-disabled={signOff || undefined}
          aria-describedby={signOff ? signHintId : undefined}
        >
          <IconLock size={18} aria-hidden="true" />
          Selesai dan tanda tangani
        </button>
        {cooling ? (
          <p id={signHintId} className="sdoc-cooling">
            {cooling}
          </p>
        ) : (
          signOff && (
            <p id={signHintId} className="hint">
              Tombol aktif setelah file selesai dibuka.
            </p>
          )
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={cancelPlacing}>
          Batal menempatkan
        </button>
        <p className="sdoc-small">
          Setiap tanda tangan mencatat sidik file versi barunya. Dokumen dikunci setelah semua penanda tangan selesai.
        </p>
      </div>
    );
  } else if (d.status === "in_progress" && mySigner?.canSignNow && !fileTrusted) {
    myPart = (
      <p className="sdoc-text">
        Dokumen ini tidak bisa ditandatangani karena filenya berubah atau hilang.{" "}
        {isRequester
          ? "Buat permintaan baru dengan file asli yang Anda simpan."
          : "Minta pengirim membuat permintaan baru dengan file aslinya."}
      </p>
    );
  } else if (d.status === "in_progress" && mySigner && mySigner.status === "waiting") {
    myPart = (
      <p className="sdoc-text">
        Belum giliran Anda.
        {firstWaiting && !firstWaiting.isMe ? ` Menunggu ${firstWaiting.displayName} menandatangani lebih dulu.` : ""}
      </p>
    );
  } else if (mySigner && mySigner.status === "signed") {
    myPart = (
      <p className="sdoc-text">
        Anda sudah menandatangani{mySigner.signedAt ? ` pada ${formatWhen(mySigner.signedAt)}` : ""}.
      </p>
    );
  } else if (!mySigner) {
    myPart = (
      <p className="sdoc-text">
        {me?.kind === "guest"
          ? "Anda tidak ada di daftar penanda tangan. Tamu hanya bisa menandatangani dokumen yang mencantumkan namanya."
          : "Anda tidak ada di daftar penanda tangan dokumen ini."}
      </p>
    );
  } else if (d.status === "cancelled") {
    myPart = <p className="sdoc-text">Permintaan ini sudah dibatalkan, jadi tidak bisa ditandatangani lagi.</p>;
  }

  let viewer: ReactNode;
  if (file.status === "ready") {
    viewer = (
      <PdfViewer
        data={file.data}
        label={d.title}
        page={page}
        onPageChange={setPage}
        zoom={zoom}
        onZoomChange={setZoom}
        onLoaded={(info) => setPages(info.pages)}
        renderOverlay={renderOverlay}
      />
    );
  } else if (file.status === "missing") {
    viewer = (
      <div className="sdoc-viewer-msg">
        <p>Isi dokumen tidak bisa ditampilkan karena filenya tidak ditemukan.</p>
      </div>
    );
  } else if (file.status === "error") {
    viewer = (
      <div className="sdoc-viewer-msg" role="alert">
        <ErrorAlert title="File dokumen belum bisa dibaca">
          <p>{file.error.message}</p>
          <button type="button" className="btn btn-sm sdoc-notice-btn" onClick={() => void loadFile(d, true)}>
            Coba lagi
          </button>
        </ErrorAlert>
      </div>
    );
  } else {
    viewer = (
      <div className="sdoc-viewer-msg">
        <p role="status">Membuka file dokumen...</p>
      </div>
    );
  }

  return (
    <main className="sdoc" aria-labelledby={titleId}>
      <header className="page-head sdoc-head">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
          <IconArrowLeft size={16} aria-hidden="true" />
          Kembali
        </button>
        <h1 id={titleId} ref={titleRef} tabIndex={-1} className="page-title sdoc-title">
          {d.title}
        </h1>
        <span className={`chip sdoc-head-chip${d.status === "in_progress" ? " chip-on" : ""}`}>{headerStatusLabel(d)}</span>
        <span className="page-sub">Diminta oleh {isRequester ? "Anda" : d.requestedBy.displayName}</span>
      </header>

      {problem && (
        <div className="sdoc-banner" role="alert">
          <ErrorAlert title={problem.title}>{problem.body}</ErrorAlert>
        </div>
      )}

      {changedCopies > 0 && (
        <div className="sdoc-banner">
          <div className="notice">
            <IconAlertTriangle size={18} aria-hidden="true" />
            <p>{exportNoticeText(changedCopies)}</p>
          </div>
        </div>
      )}

      <div className="sdoc-live" role="status">
        {done && (
          <div className="sdoc-ok" ref={doneRef} tabIndex={-1}>
            <IconCircleCheck size={18} aria-hidden="true" />
            <div>
              {done === "all" ? (
                <strong>Semua sudah menandatangani. Dokumen dikunci dan halaman catatan ditambahkan.</strong>
              ) : (
                <>
                  <strong>Tanda tangan tersimpan</strong>
                  <p>Versi baru dokumen dengan tanda tangan Anda sudah disimpan di laptop ini.</p>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="sdoc-body">
        <div className="sdoc-viewer" ref={viewerRef}>
          {viewer}
        </div>

        <aside className="sdoc-panel" aria-label="Penanda tangan dan tindakan">
          <section className="sdoc-sec" aria-labelledby={`${titleId}-order`}>
            <h2 id={`${titleId}-order`} className="sdoc-h">
              Urutan penanda tangan
            </h2>
            <p className="sdoc-small">
              {d.mode === "sequential"
                ? "Berurutan: setiap orang menunggu giliran orang sebelumnya."
                : "Bebas: siapa saja di daftar boleh menandatangani lebih dulu."}
            </p>
            <ol className="sdoc-signers">
              {sortedSigners.map((s, i) => {
                const st = signerStatus(s, d, fileTrusted);
                return (
                  <li key={s.publicKey} className="sdoc-signer" data-tone={st.tone}>
                    <span className="sdoc-num" aria-hidden="true">
                      {st.tone === "done" ? <IconCheck size={14} /> : i + 1}
                    </span>
                    <div className="sdoc-signer-text">
                      <p className="sdoc-signer-name">
                        {s.displayName}
                        {s.isMe && <span className="sdoc-you"> (Anda)</span>}
                        <span className="sdoc-kind">{kindLabel(s.kind)}</span>
                      </p>
                      <p className="sdoc-signer-state">{st.text}</p>
                    </div>
                  </li>
                );
              })}
            </ol>
            {othersPending && (
              <p className="sdoc-small">
                Mira belum bisa mengirim dokumen lewat jaringan. Rekan di daftar ini baru menerima dokumen setelah pengiriman lewat
                jaringan tersedia.
              </p>
            )}
          </section>

          {myPart && (
            <section className="sdoc-sec" aria-labelledby={`${titleId}-me`}>
              <h2 id={`${titleId}-me`} className="sdoc-h">
                Tanda tangan Anda
              </h2>
              {myPart}
            </section>
          )}

          <section className="sdoc-sec" aria-labelledby={`${titleId}-seal`}>
            <h2 id={`${titleId}-seal`} className="sdoc-h">
              Keaslian file
            </h2>
            {locked ? (
              <div className="sdoc-lock">
                <p className="sdoc-lock-head">
                  <IconLock size={16} aria-hidden="true" />
                  Terkunci
                </p>
                <p>
                  Isi file dikunci. Perubahan sekecil apa pun terdeteksi di file Mira dan di salinan yang disimpan lewat Simpan
                  salinan PDF. Salinan lain bisa dicek dengan Periksa file PDF.
                </p>
              </div>
            ) : d.status === "in_progress" ? (
              <p className="sdoc-small">
                Belum terkunci. Setiap tanda tangan menyimpan versi baru dan mencatat sidik filenya. Dokumen dikunci setelah semua
                penanda tangan selesai.
              </p>
            ) : d.status === "cancelled" ? (
              <p className="sdoc-small">Permintaan dibatalkan, jadi dokumen tidak dikunci.</p>
            ) : null}
            <dl className="sdoc-dl">
              <dt>{locked ? "Sidik file akhir" : "Sidik file terkini"}</dt>
              <dd>
                <HashText hash={d.currentHash} />
              </dd>
              <dt>Sidik file asli</dt>
              <dd>
                <HashText hash={d.originalHash} />
              </dd>
            </dl>
          </section>

          <section className="sdoc-sec" aria-labelledby={`${titleId}-copy`}>
            <h2 id={`${titleId}-copy`} className="sdoc-h">
              Salinan PDF
            </h2>
            <p className="sdoc-small">
              Salinan disimpan tanpa menimpa file lain, biasanya ke folder Unduhan. Lokasinya tampil setelah tersimpan, dan Mira
              tetap memeriksa isinya.
            </p>
            <button
              type="button"
              className={`btn ${d.status === "completed" ? "" : "btn-ghost "}btn-sm sdoc-fit`}
              onClick={guarded(exportOff, () => void exportCopy())}
              aria-disabled={exportOff || undefined}
              aria-busy={exporting || undefined}
              aria-describedby={exportBlocked ? exportHintId : undefined}
            >
              {exporting ? "Menyimpan salinan..." : "Simpan salinan PDF"}
            </button>
            {exportBlocked && (
              <p id={exportHintId} className="sdoc-small">
                {d.integrity === "missing"
                  ? "Salinan tidak bisa disimpan karena file dokumen ini tidak ditemukan."
                  : "Salinan tidak bisa disimpan karena isi file ini tidak cocok dengan catatan Mira."}
              </p>
            )}
            <div aria-live="polite">
              {exportError && (
                <ErrorAlert title="Salinan belum tersimpan">
                  <p>{exportError.message}</p>
                </ErrorAlert>
              )}
              {exported && (
                <div className="sdoc-saved">
                  <p className="ok-line">
                    <IconCircleCheck size={16} aria-hidden="true" />
                    Salinan tersimpan di
                  </p>
                  <p className="mono sdoc-path">{exported}</p>
                  <button type="button" className="btn btn-ghost btn-sm sdoc-fit" onClick={() => void reveal(exported)}>
                    <IconFolderOpen size={16} aria-hidden="true" />
                    Tampilkan di folder
                  </button>
                </div>
              )}
              {revealError && (
                <ErrorAlert title="Folder belum bisa dibuka">
                  <p>{revealError.message}</p>
                </ErrorAlert>
              )}
            </div>
            {d.exports.length > 0 && <ExportList exports={d.exports} />}
          </section>

          {isRequester && d.status === "in_progress" && (
            <section className="sdoc-sec">
              <button
                type="button"
                className="btn btn-ghost btn-sm sdoc-fit sdoc-cancel"
                onClick={() => {
                  setCancelError(null);
                  setCancelOpen(true);
                }}
              >
                Batalkan permintaan
              </button>
            </section>
          )}

          <AuditTrail events={d.events} requestCreatedAt={d.createdAt} />
        </aside>
      </div>

      <p className="sr-only" aria-live="polite">
        {live}
      </p>

      {saved && (
        <PinDialog
          open={pinOpen}
          onOpenChange={setPinOpen}
          title="Masukkan PIN"
          description={
            d.isLastPending
              ? "Anda penanda tangan terakhir. Setelah PIN benar, tanda tangan ditempel, halaman catatan ditambahkan, dan dokumen dikunci."
              : `Setelah PIN benar, tanda tangan Anda ditempel di halaman ${(placement?.pageIndex ?? 0) + 1} dan versi baru disimpan.`
          }
          submitLabel="Tanda tangani"
          lockedUntil={saved.lockedUntil}
          onSubmit={submitPin}
        />
      )}
      <SignatureSetupDialog open={setupOpen} onOpenChange={setSetupOpen} onSave={saveSignature} />
      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="Batalkan permintaan ini?"
        confirmLabel="Batalkan permintaan"
        busyLabel="Membatalkan..."
        busy={cancelling}
        onConfirm={() => void confirmCancel()}
        error={
          cancelError && (
            <ErrorAlert title="Permintaan belum dibatalkan">
              <p>{cancelError.message}</p>
            </ErrorAlert>
          )
        }
      >
        <p>
          Penanda tangan yang belum menandatangani tidak bisa menandatangani lagi. Tanda tangan yang sudah ada tetap tercatat di
          jejak audit. Pembatalan tidak bisa diurungkan.
        </p>
      </ConfirmDialog>
    </main>
  );
}

function ExportList({ exports }: { exports: ExportView[] }) {
  return (
    <div className="sdoc-exports">
      <h3 className="sdoc-h3">Salinan yang pernah disimpan</h3>
      <ul>
        {exports.map((x) => {
          const note = EXPORT_NOTE[x.state];
          return (
            <li key={`${x.path}-${x.exportedAt}`} className="sdoc-export" data-state={x.state}>
              <p className="mono sdoc-path">{x.path}</p>
              <p className="sdoc-export-meta">
                <span className={`chip${x.state === "changed" ? " sdoc-chip-bad" : x.state === "intact" ? " sdoc-chip-ok" : ""}`}>
                  {x.state === "intact" && <IconCheck size={13} aria-hidden="true" />}
                  {exportStateLabel(x.state)}
                </span>
                <span>{formatWhen(x.exportedAt)}</span>
              </p>
              {note && <p className="sdoc-export-note">{note}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
