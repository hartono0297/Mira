import {
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
import {
  signingApi,
  type ExportView,
  type Integrity,
  type RequestDetail,
  type SignerView,
  type SignOverview,
} from "../../api/signing";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { cssRectToPdf, pdfRectToCss } from "../../components/pdf/coords";
import { PdfViewer } from "../../components/pdf/PdfViewer";
import { PlacementBox } from "../../components/pdf/PlacementBox";
import type { PageGeometry, PageRenderInfo, PdfRect } from "../../components/pdf/types";
import { PinDialog } from "./pad/PinDialog";
import { SignatureSetupDialog } from "./pad/SignatureSetupDialog";
import { AuditTrail, safeSignedAt } from "./AuditTrail";
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

const STATUS_LABEL: Record<RequestDetail["status"], string> = {
  in_progress: "Berjalan",
  completed: "Selesai",
  cancelled: "Dibatalkan",
};

const EXPORT_STATE: Record<Integrity, { label: string; note?: string }> = {
  intact: { label: "Utuh" },
  changed: { label: "Berubah", note: "Isi salinan ini berbeda dari versi yang ditandatangani. Jangan pakai sebagai dokumen sah." },
  missing: { label: "Tidak ditemukan", note: "File ini sudah dipindah, diganti nama, atau dihapus." },
};

const QUICK_SPOTS: { spot: QuickSpot; label: string }[] = [
  { spot: "left", label: "Kiri bawah" },
  { spot: "center", label: "Tengah bawah" },
  { spot: "right", label: "Kanan bawah" },
];

// Error yang berarti data di layar sudah usang; layar dimuat ulang di belakang.
const STALE_CODES = new Set(["version_conflict", "not_your_turn", "request_closed", "already_signed", "not_found"]);

function shortHash(hash: string, n = 16) {
  return (
    <span className="mono" title={hash}>
      {hash.slice(0, n)}
    </span>
  );
}

function signerStatus(s: SignerView, detail: RequestDetail): { text: string; tone: "done" | "now" | "wait" } {
  if (s.status === "signed") return { text: s.signedAt ? `Sudah, ${safeSignedAt(s.signedAt)}` : "Sudah", tone: "done" };
  if (detail.status === "cancelled") return { text: "Belum, permintaan dibatalkan", tone: "wait" };
  if (s.isMe && s.canSignNow) return { text: "Giliran Anda", tone: "now" };
  return { text: "Menunggu", tone: "wait" };
}

function integrityProblem(detail: RequestDetail): { title: string; body: ReactNode } | null {
  if (detail.integrity === "changed") {
    return {
      title: "Isi file ini berubah setelah ditandatangani",
      body: (
        <>
          <p>
            File yang disimpan Mira tidak lagi cocok dengan hash yang tercatat, jadi tanda tangan di dalamnya tidak bisa
            dipercaya.
          </p>
          <p>
            Jangan kirim atau cetak file ini. Minta salinan dari pengirim, lalu periksa salinan itu dengan Periksa file di
            layar Tanda tangan.
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
          <p>Kalau Anda pernah menyimpan salinannya, periksa salinan itu dengan Periksa file di layar Tanda tangan.</p>
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
            Catatan bahwa dokumen ini selesai dan dikunci tidak cocok dengan kunci laptop pencatatnya atau dengan hash file.
            Data Mira mungkin diubah di luar aplikasi.
          </p>
          <p>Anggap dokumen ini belum terkunci dan minta salinan dari pengirim.</p>
        </>
      ),
    };
  }
  return null;
}

export function SignDocumentView({ requestId, onBack, onChanged }: Props) {
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [file, setFile] = useState<FileState>({ status: "idle" });
  const [pages, setPages] = useState<PageGeometry[]>([]);
  const [page, setPage] = useState(1);

  const [placement, setPlacement] = useState<PdfRect | null>(null);
  const [live, setLive] = useState("");
  const [setupOpen, setSetupOpen] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [done, setDone] = useState<Done | null>(null);

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
  const focusBox = useRef(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(liveTimer.current);
    };
  }, []);

  // Byte PDF hanya diganti saat hash versi berubah, supaya PdfViewer tidak memuat ulang.
  const loadFile = useCallback(async (detail: RequestDetail, force = false) => {
    if (detail.integrity === "missing") {
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

  // Batal menempatkan kalau giliran hilang (mis. dimuat ulang setelah bentrok).
  useEffect(() => {
    if (!canSign && placement) setPlacement(null);
  }, [canSign, placement]);

  // Setelah "Tempatkan tanda tangan", fokus pindah ke kotak supaya bisa langsung digeser dengan panah.
  useEffect(() => {
    if (!focusBox.current || !placement) return;
    const box = viewerRef.current?.querySelector<HTMLElement>(".pdf-place");
    if (box) {
      focusBox.current = false;
      box.focus();
    }
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
    focusBox.current = true;
    updatePlacement(quickPlacement(geo, aspect, "right"));
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

  function moveHere() {
    if (!placement) return;
    const from = pages[placement.pageIndex];
    const to = pages[page - 1];
    if (!from || !to) return;
    updatePlacement(movePlacement(placement, from, to, aspect));
  }

  async function submitPin(pin: string) {
    if (!detail || !me || !placement || file.status !== "ready") return;
    try {
      const result = await runSignFlow({ pin, detail, bytes: file.data, placement, me, api: signingApi });
      if (!mounted.current) return;
      const stampedPage = placement.pageIndex + 1;
      setPlacement(null);
      setDone(result.status === "completed" ? "all" : "mine");
      setData((d) => (d ? { ...d, detail: result } : d));
      setPage(stampedPage);
      void loadFile(result);
      // Hitungan PIN salah direset di inti Rust; muat ulang ringkasan dan detail.
      void load();
      onChanged?.();
    } catch (err) {
      const error = toAppError(err);
      if (STALE_CODES.has(error.code)) void load();
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
          <h1 id={titleId} className="page-title">
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
  const problem = integrityProblem(d);
  const locked = d.status === "completed" && d.sealValid === true;
  const sortedSigners = [...d.signers].sort((a, b) => a.position - b.position);
  const othersPending = d.status === "in_progress" && d.signers.some((s) => !s.isMe && s.status === "waiting");
  const firstWaiting = sortedSigners.find((s) => s.status === "waiting");
  const boxGeo = placement ? pages[placement.pageIndex] : undefined;
  const boxOnOtherPage = !!placement && placement.pageIndex !== page - 1;
  const minWidthReached = !!(placement && boxGeo && placementWidthPt(placement, boxGeo) <= BOX_MIN_WIDTH_PT + 0.01);

  const renderOverlay = (info: PageRenderInfo) => {
    if (!placing || !placement || info.index !== placement.pageIndex || !me) return null;
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
          type="button"
          className="btn sdoc-wide"
          onClick={startPlacing}
          disabled={!fileReady || pages.length === 0}
        >
          <IconSignature size={18} aria-hidden="true" />
          Tempatkan tanda tangan
        </button>
        {!fileReady && <p className="hint">Tombol aktif setelah file selesai dibuka.</p>}
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
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPage(placement.pageIndex + 1)}>
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
              disabled={minWidthReached}
            >
              <IconMinus size={15} aria-hidden="true" />
              Kecilkan kotak
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => resize(SIZE_STEP_PT)}>
              <IconPlus size={15} aria-hidden="true" />
              Besarkan kotak
            </button>
          </div>
        </div>
        <p className="hint">
          Geser kotak dengan mouse atau tombol panah. Tarik sudut kanan bawah, atau tekan plus dan minus, untuk mengubah ukuran.
        </p>
        <button type="button" className="btn sdoc-wide" onClick={() => setPinOpen(true)} disabled={!fileReady}>
          <IconLock size={18} aria-hidden="true" />
          Selesai dan tanda tangani
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPlacement(null)}>
          Batal menempatkan
        </button>
        <p className="sdoc-small">
          Setelah ditandatangani, isi file dikunci. Kalau ada yang mengubahnya, Mira memberi peringatan.
        </p>
      </div>
    );
  } else if (d.status === "in_progress" && mySigner?.canSignNow && !fileTrusted) {
    myPart = (
      <p className="sdoc-text">
        Giliran Anda, tetapi menandatangani dinonaktifkan karena file dokumen bermasalah. Selesaikan dulu langkah di
        peringatan di atas.
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
        Anda sudah menandatangani{mySigner.signedAt ? ` pada ${safeSignedAt(mySigner.signedAt)}` : ""}.
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
        <span className={`chip${d.status === "in_progress" ? " chip-on" : ""}`}>
          {STATUS_LABEL[d.status]}
          {d.status === "in_progress" ? `, ${d.signedCount} dari ${d.signerCount} sudah` : ""}
        </span>
        <span className="page-sub">Diminta oleh {isRequester ? "Anda" : d.requestedBy.displayName}</span>
      </header>

      {problem && (
        <div className="sdoc-banner" role="alert">
          <ErrorAlert title={problem.title}>{problem.body}</ErrorAlert>
        </div>
      )}

      <div className="sdoc-live" role="status">
        {done && (
          <div className="sdoc-ok">
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
                const st = signerStatus(s, d);
                return (
                  <li key={s.publicKey} className="sdoc-signer" data-tone={st.tone}>
                    <span className="sdoc-num" aria-hidden="true">
                      {st.tone === "done" ? <IconCheck size={14} /> : i + 1}
                    </span>
                    <div className="sdoc-signer-text">
                      <p className="sdoc-signer-name">
                        {s.displayName}
                        {s.isMe && <span className="sdoc-you"> (Anda)</span>}
                        <span className="sdoc-kind">{s.kind === "guest" ? "Tamu" : "Anggota"}</span>
                      </p>
                      <p className="sdoc-signer-state">{st.text}</p>
                    </div>
                  </li>
                );
              })}
            </ol>
            {othersPending && (
              <p className="sdoc-small">
                Mira belum bisa mengirim dokumen lewat jaringan. Penanda tangan berikutnya baru menerima dokumen ini setelah
                pengiriman lewat jaringan tersedia.
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
                <p>Isi file dikunci. Perubahan sekecil apa pun akan terdeteksi, di Mira maupun di salinan yang Anda simpan.</p>
              </div>
            ) : d.status === "in_progress" ? (
              <p className="sdoc-small">
                Belum terkunci. Setiap tanda tangan menyimpan versi baru dan mencatat hash-nya. Dokumen dikunci setelah semua
                penanda tangan selesai.
              </p>
            ) : d.status === "cancelled" ? (
              <p className="sdoc-small">Permintaan dibatalkan, jadi dokumen tidak dikunci.</p>
            ) : null}
            <dl className="sdoc-dl">
              <dt>{locked ? "Hash akhir" : "Versi terkini"}</dt>
              <dd>{shortHash(d.currentHash)}</dd>
              <dt>File asli</dt>
              <dd>{shortHash(d.originalHash)}</dd>
            </dl>
          </section>

          <section className="sdoc-sec" aria-labelledby={`${titleId}-copy`}>
            <h2 id={`${titleId}-copy`} className="sdoc-h">
              Salinan PDF
            </h2>
            <p className="sdoc-small">Salinan disimpan ke folder Unduhan tanpa menimpa file lain. Mira tetap memeriksa isinya.</p>
            <button
              type="button"
              className={`btn ${d.status === "completed" ? "" : "btn-ghost "}btn-sm sdoc-fit`}
              onClick={() => void exportCopy()}
              disabled={exporting || file.status === "missing"}
              aria-busy={exporting || undefined}
            >
              {exporting ? "Menyimpan salinan..." : "Simpan salinan PDF"}
            </button>
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

          <AuditTrail events={d.events} />
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
          const st = EXPORT_STATE[x.state];
          return (
            <li key={`${x.path}-${x.exportedAt}`} className="sdoc-export" data-state={x.state}>
              <p className="mono sdoc-path">{x.path}</p>
              <p className="sdoc-export-meta">
                <span className={`chip${x.state === "intact" ? " chip-on" : x.state === "changed" ? " sdoc-chip-bad" : ""}`}>
                  {st.label}
                </span>
                <span>{safeSignedAt(x.exportedAt)}</span>
              </p>
              {st.note && <p className="sdoc-export-note">{st.note}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
