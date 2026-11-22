import {
  IconAlertTriangle,
  IconChevronRight,
  IconClockHour4,
  IconDownload,
  IconFileSearch,
  IconFileTypePdf,
  IconFileUpload,
  IconLock,
  IconSignature,
} from "@tabler/icons-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent } from "react";
import { subscribeFeature, toAppError, type AppError } from "../../api";
import {
  signingApi,
  type ImportedPdf,
  type RequestDetail,
  type RequestSummary,
  type SavedSignatureInfo,
  type SignOverview,
} from "../../api/signing";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { PinDialog } from "./pad/PinDialog";
import { SignatureSetupDialog } from "./pad/SignatureSetupDialog";
import { SignDocumentView } from "./SignDocumentView";
import { NewRequestDialog } from "./NewRequestDialog";
import { VerifyDialog } from "./VerifyDialog";
import {
  checkPdfFile,
  exportWarningLabel,
  fileNeed,
  fileNeedText,
  formatSize,
  formatWhen,
  integrityLabel,
  isActionable,
  modeLabel,
  readFileBytes,
  requestStateLabel,
  signErrorMessage,
} from "./labels";
import { checkSignablePdf } from "./stamp";
import "./sign.css";

type Feedback = { kind: "ok"; text: string } | { kind: "error"; title: string; error: AppError } | null;

function validOverview(data: SignOverview | null): SignOverview | null {
  return data && typeof data === "object" && Array.isArray(data.requests) && data.me ? data : null;
}

// Yang bisa Anda tanda tangani sekarang (giliran Anda dan file utuh) paling atas,
// lalu yang masih berjalan, lalu selesai, lalu dibatalkan.
function rank(r: RequestSummary): number {
  if (r.status === "in_progress") return isActionable(r) ? 0 : 1;
  return r.status === "completed" ? 2 : 3;
}

export function sortRequests(list: RequestSummary[]): RequestSummary[] {
  return [...list].sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt));
}

// Permintaan dari rekan yang masih menunggu tanda tangan saya. Yang bisa
// ditandatangani sekarang paling atas, lalu giliran saya yang menunggu file,
// lalu yang masih menunggu penanda tangan sebelum saya.
function waitRank(r: RequestSummary): number {
  if (r.myState === "your_turn") return isActionable(r) ? 0 : 1;
  return 2;
}

export function waitingRequests(list: RequestSummary[]): RequestSummary[] {
  return list
    .filter(
      (r) =>
        r.fromPeer === true &&
        r.status === "in_progress" &&
        (r.myState === "your_turn" || r.myState === "waiting_others"),
    )
    .sort((a, b) => waitRank(a) - waitRank(b) || b.updatedAt.localeCompare(a.updatedAt));
}

// File dari rekan yang belum tersalin juga tercatat "missing" di inti Rust,
// tetapi itu keadaan biasa, bukan file yang hilang.
function integrityWarn(r: RequestSummary): boolean {
  if (r.integrity === "missing" && r.fileAvailable === false) return false;
  return r.integrity !== "intact";
}

function hasWarning(r: RequestSummary): boolean {
  return integrityWarn(r) || r.exportWarnings > 0;
}

function futureTime(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && t > now ? t : null;
}

function lockedUntil(saved: SavedSignatureInfo | null, now: number): number | null {
  return futureTime(saved?.lockedUntil, now);
}

function usableAfter(saved: SavedSignatureInfo | null, now: number): number | null {
  return futureTime(saved?.usableAfter, now);
}

function useOverview() {
  const [data, setData] = useState<SignOverview | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const alive = useRef(true);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = validOverview(await signingApi.overview());
      if (!alive.current || mine !== seq.current) return;
      if (!next) throw toAppError("Inti Mira mengirim data tanda tangan yang tidak lengkap.");
      setData(next);
      setError(null);
    } catch (err) {
      if (!alive.current || mine !== seq.current) return;
      setError(toAppError(err));
    } finally {
      if (alive.current && mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void reload();
    // File bisa diubah aplikasi lain saat Mira di belakang; periksa lagi saat jendela kembali aktif.
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    // Permintaan, tanda tangan, dan pembatalan dari laptop rekan.
    const stopFeature = subscribeFeature("sign", () => void reload());
    return () => {
      alive.current = false;
      window.removeEventListener("focus", onFocus);
      stopFeature();
    };
  }, [reload]);

  return { data, error, loading, reload };
}

function MySignature({
  saved,
  onCreate,
  onDelete,
}: {
  saved: SavedSignatureInfo | null;
  onCreate: () => void;
  onDelete: () => void;
}) {
  const now = Date.now();
  const lock = lockedUntil(saved, now);
  const cooling = usableAfter(saved, now);

  return (
    <section className="sign-section" aria-labelledby="sign-mine-title">
      <h2 id="sign-mine-title" className="sign-h2">
        Tanda tangan saya
      </h2>
      <div className="sign-mine">
        <span className="sign-mine-icon" aria-hidden="true">
          <IconSignature size={22} />
        </span>
        {saved ? (
          <div className="sign-mine-text">
            <p className="sign-mine-main">Tersimpan sejak {formatWhen(saved.createdAt)}, dipakai dengan PIN</p>
            {cooling !== null && (
              <p className="sign-mine-wait">
                <IconClockHour4 size={16} aria-hidden="true" />
                Bisa dipakai mulai {formatWhen(saved.usableAfter ?? "")}, 24 jam setelah tanda tangan sebelumnya dihapus
                tanpa PIN.
              </p>
            )}
            {lock !== null ? (
              <p className="sign-mine-lock">
                <IconLock size={16} aria-hidden="true" />
                Terkunci sementara sampai {formatWhen(saved.lockedUntil ?? "")} karena PIN salah beberapa kali.
              </p>
            ) : (
              saved.failedAttempts > 0 && (
                <p className="sign-mine-sub">
                  PIN salah {saved.failedAttempts} kali sejak terakhir benar. Sisa {saved.attemptsLeft} percobaan
                  sebelum terkunci sementara.
                </p>
              )
            )}
          </div>
        ) : (
          <div className="sign-mine-text">
            <p className="sign-mine-main">Belum ada tanda tangan tersimpan</p>
            <p className="sign-mine-sub">
              Gambar dengan mouse atau pena, atau pakai foto tanda tangan. Gambar disimpan terkunci dan hanya bisa
              dipakai dengan PIN Anda.
            </p>
          </div>
        )}
        <div className="sign-mine-action">
          {saved ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onDelete}>
              Hapus tanda tangan
            </button>
          ) : (
            <button type="button" className="btn" onClick={onCreate}>
              Buat tanda tangan
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

type DownloadCtl = { busyId: string | null; start: (r: RequestSummary) => void };

function RequestRow({
  r,
  onOpen,
  download,
}: {
  r: RequestSummary;
  onOpen: (id: string) => void;
  download: DownloadCtl;
}) {
  const mine = isActionable(r);
  const warn = hasWarning(r);
  const when = r.completedAt ?? r.updatedAt;
  const need = fileNeed(r);
  const busy = download.busyId === r.id;
  // Satu unduhan pada satu waktu. aria-disabled, bukan disabled, supaya fokus
  // keyboard tidak lepas dari tombol yang sedang menunggu.
  const blocked = download.busyId !== null;
  const size = formatSize(r.fileSize);
  return (
    <li>
      <button
        type="button"
        className={`sign-row${warn ? " sign-row-warn" : ""}`}
        data-request={r.id}
        onClick={() => onOpen(r.id)}
      >
        <IconFileTypePdf size={22} className="sign-row-icon" aria-hidden="true" />
        <span className="sign-row-main">
          <span className="sign-row-title">{r.title}</span>
          {r.fromPeer && (
            <span className="sign-row-from">
              <span className="sr-only">, </span>
              Diminta oleh {r.requestedByName}
            </span>
          )}
          <span className="sign-row-meta">
            <span className="sr-only">, </span>
            {r.signedCount} dari {r.signerCount} sudah tanda tangan
            <span aria-hidden="true"> · </span>
            <span className="sr-only">, </span>
            {modeLabel(r.mode)}
            <span aria-hidden="true"> · </span>
            <span className="sr-only">, </span>
            {r.completedAt ? "selesai" : "terakhir berubah"} {formatWhen(when)}
          </span>
          {need && (
            <span className="sign-row-file">
              <span className="sr-only">, </span>
              {need.state === "manual" ? (
                <IconDownload size={16} aria-hidden="true" />
              ) : (
                <IconClockHour4 size={16} aria-hidden="true" />
              )}
              {fileNeedText(need, r.fileSize)}
            </span>
          )}
          {warn && (
            <span className="sign-row-warnings">
              {integrityWarn(r) && (
                <span className="sign-warn-line">
                  <IconAlertTriangle size={16} aria-hidden="true" />
                  {integrityLabel(r.integrity)}
                </span>
              )}
              {r.exportWarnings > 0 && (
                <span className="sign-warn-line">
                  <IconAlertTriangle size={16} aria-hidden="true" />
                  {exportWarningLabel(r.exportWarnings)}
                </span>
              )}
            </span>
          )}
        </span>
        <span className={`chip${mine ? " chip-on" : ""}`}>{requestStateLabel(r)}</span>
        <IconChevronRight size={18} className="sign-row-chevron" aria-hidden="true" />
      </button>
      {need?.state === "manual" && (
        <div className="sign-row-extra">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label={busy ? `Mengunduh file ${r.title}` : `Unduh file ${r.title}, ${size}`}
            aria-busy={busy || undefined}
            aria-disabled={blocked || undefined}
            onClick={() => {
              if (!blocked) download.start(r);
            }}
          >
            <IconDownload size={16} aria-hidden="true" />
            {busy ? "Mengunduh..." : `Unduh file (${size})`}
          </button>
        </div>
      )}
    </li>
  );
}

export function SignScreen() {
  const { data, error, loading, reload } = useOverview();
  const overview = data;
  const [openId, setOpenId] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  // Hapus dengan PIN (tanda tangan baru langsung bisa dipakai) atau tanpa PIN
  // karena lupa (tanda tangan baru baru bisa dipakai 24 jam kemudian).
  const [pinDeleteOpen, setPinDeleteOpen] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<AppError | null>(null);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<ImportedPdf | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const downloadRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const pickRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  // Baris yang difokus lagi saat kembali dari layar dokumen.
  const returnTo = useRef<string | null>(null);
  const savedNow = useRef(false);
  // "Lupa PIN?" menutup dialog PIN lalu membuka konfirmasi; fokus jangan dipindah di antaranya.
  const forgotNext = useRef(false);

  // Kunci PIN dan masa tunggu berakhir sendiri; muat ulang tepat saat itu supaya statusnya hilang.
  const nowMs = Date.now();
  const ends = [lockedUntil(overview?.saved ?? null, nowMs), usableAfter(overview?.saved ?? null, nowMs)].filter(
    (t): t is number => t !== null,
  );
  const nextEnd = ends.length ? Math.min(...ends) : null;
  useEffect(() => {
    if (nextEnd === null) return;
    const ms = Math.min(nextEnd - Date.now() + 500, 2 ** 31 - 1);
    const timer = window.setTimeout(() => void reload(), Math.max(ms, 0));
    return () => window.clearTimeout(timer);
  }, [nextEnd, reload]);

  useLayoutEffect(() => {
    if (openId !== null || !returnTo.current) return;
    const id = returnTo.current;
    returnTo.current = null;
    const row = document.querySelector<HTMLButtonElement>(`[data-request="${CSS.escape(id)}"]`);
    (row ?? titleRef.current)?.focus();
  }, [openId]);

  // Tombol di "Tanda tangan saya" berganti setelah simpan atau hapus. Fokus
  // dipindah ke tombol penggantinya setelah dialog tertutup, supaya tidak lepas ke body.
  const focusMineAction = useCallback(() => {
    window.setTimeout(() => {
      const target = document.querySelector<HTMLButtonElement>(".sign-mine-action button") ?? titleRef.current;
      target?.focus();
    }, 0);
  }, []);

  const openDoc = useCallback((id: string) => {
    setFeedback(null);
    setOpenId(id);
  }, []);

  if (openId) {
    return (
      <SignDocumentView
        requestId={openId}
        onBack={() => {
          returnTo.current = openId;
          setOpenId(null);
          void reload();
        }}
        onChanged={() => void reload()}
      />
    );
  }

  async function saveSignature(png: Uint8Array, pin: string) {
    await signingApi.saveSignature(png, pin);
    savedNow.current = true;
    setFeedback({ kind: "ok", text: "Tanda tangan tersimpan. Mira akan meminta PIN setiap kali Anda memakainya." });
    await reload();
  }

  // Jalur PIN: error (PIN salah, terkunci) ditangani PinDialog, yang menutup dirinya setelah berhasil.
  async function deleteWithPin(pin: string) {
    await signingApi.deleteSignature(pin);
    setFeedback({
      kind: "ok",
      text: "Tanda tangan tersimpan sudah dihapus. Tanda tangan baru bisa langsung dibuat dan dipakai.",
    });
    await reload();
  }

  async function deleteWithoutPin() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await signingApi.deleteSignature();
      setForgotOpen(false);
      setFeedback({
        kind: "ok",
        text: "Tanda tangan tersimpan sudah dihapus. Tanda tangan baru bisa dibuat sekarang dan dipakai 24 jam setelah penghapusan ini.",
      });
      await reload();
      focusMineAction();
    } catch (err) {
      setDeleteError(toAppError(err));
    } finally {
      setDeleting(false);
    }
  }

  async function onPdf(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setFeedback(null);
    const bad = checkPdfFile(file);
    if (bad) {
      setFeedback({ kind: "error", title: "PDF belum bisa dibuka", error: { code: "pdf_invalid", message: bad } });
      pickRef.current?.focus();
      return;
    }
    setImporting(true);
    try {
      const bytes = await readFileBytes(file);
      // Stempel nanti dikerjakan pdf-lib; PDF yang tidak bisa dibukanya ditolak
      // sekarang, bukan setelah permintaan dibuat dan PIN dimasukkan.
      await checkSignablePdf(bytes);
      const result = await signingApi.importPdf(bytes, file.name);
      setImported(result);
      setNewOpen(true);
    } catch (err) {
      setFeedback({ kind: "error", title: "PDF belum bisa dibuka", error: toAppError(err) });
      window.setTimeout(() => pickRef.current?.focus(), 0);
    } finally {
      setImporting(false);
    }
  }

  function onCreated(detail: RequestDetail) {
    setNewOpen(false);
    setImported(null);
    void reload();
    openDoc(detail.id);
  }

  // File di atas 20 MB dari rekan diunduh lewat tombol di baris. Setelah
  // berhasil, tombolnya hilang; fokus dipindah ke baris dokumen itu.
  async function downloadFile(r: RequestSummary) {
    if (downloadRef.current) return;
    downloadRef.current = true;
    setDownloadingId(r.id);
    setFeedback(null);
    try {
      await signingApi.downloadFile(r.id);
      setFeedback({ kind: "ok", text: `File ${r.title} sudah ada di laptop ini.` });
      await reload();
      window.setTimeout(() => {
        const active = document.activeElement;
        if (active && active !== document.body && active.isConnected) return;
        document.querySelector<HTMLButtonElement>(`[data-request="${CSS.escape(r.id)}"]`)?.focus();
      }, 0);
    } catch (err) {
      const error = toAppError(err);
      setFeedback({ kind: "error", title: "File belum bisa diunduh", error: { ...error, message: signErrorMessage(error) } });
      void reload();
    } finally {
      downloadRef.current = false;
      setDownloadingId(null);
    }
  }

  const download: DownloadCtl = { busyId: downloadingId, start: (r) => void downloadFile(r) };
  const all = overview?.requests ?? [];
  const waiting = waitingRequests(all);
  const waitingIds = new Set(waiting.map((r) => r.id));
  const requests = sortRequests(all.filter((r) => !waitingIds.has(r.id)));
  const yourTurn = all.filter(isActionable).length;
  const warned = all.filter(hasWarning).length;

  return (
    <main className="sign" aria-labelledby="page-title">
      <header className="page-head">
        <h1 id="page-title" ref={titleRef} tabIndex={-1} className="page-title">
          Tanda tangan
        </h1>
        <span className="page-sub">
          {yourTurn > 0 ? `${yourTurn} dokumen menunggu tanda tangan Anda` : "PDF yang ditandatangani di laptop ini"}
        </span>
      </header>

      {loading && !overview && (
        <p className="sign-body hint" role="status">
          Memuat tanda tangan dan daftar dokumen...
        </p>
      )}

      {!loading && !overview && (
        <div className="sign-body" role="alert">
          <ErrorAlert title="Daftar tanda tangan belum terbaca">
            <p>{error?.message ?? "Inti Mira tidak mengirim data tanda tangan."}</p>
            <button type="button" className="btn btn-ghost btn-sm sign-inline-btn" onClick={() => void reload()}>
              Coba lagi
            </button>
          </ErrorAlert>
        </div>
      )}

      {overview && (
        <div className="sign-body">
          <div aria-live="polite" className="sign-live">
            {error && (
              <p className="hint">Data terbaru belum bisa dibaca ({error.message}). Yang tampil adalah data terakhir.</p>
            )}
            {feedback?.kind === "ok" && <p className="sign-ok">{feedback.text}</p>}
            {feedback?.kind === "error" && (
              <ErrorAlert title={feedback.title}>
                <p>{feedback.error.message}</p>
              </ErrorAlert>
            )}
          </div>

          {waiting.length > 0 && (
            <section className="sign-section" aria-labelledby="sign-wait-title">
              <div className="sign-head-text">
                <h2 id="sign-wait-title" className="sign-h2">
                  Menunggu tanda tangan
                </h2>
                <p className="hint">Permintaan dari rekan yang mencantumkan nama Anda. Giliran Anda tampil paling atas.</p>
              </div>
              <ul className="sign-list">
                {waiting.map((r) => (
                  <RequestRow key={r.id} r={r} onOpen={openDoc} download={download} />
                ))}
              </ul>
            </section>
          )}

          <MySignature
            saved={overview.saved}
            onCreate={() => {
              setFeedback(null);
              setSetupOpen(true);
            }}
            onDelete={() => {
              setFeedback(null);
              setPinDeleteOpen(true);
            }}
          />

          <section className="sign-section" aria-labelledby="sign-docs-title">
            <div className="sign-head">
              <h2 id="sign-docs-title" className="sign-h2">
                Dokumen
              </h2>
              <div className="sign-head-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setVerifyOpen(true)}>
                  <IconFileSearch size={18} aria-hidden="true" />
                  Periksa file PDF
                </button>
                {overview.canRequest && (
                  <>
                    <input
                      ref={fileRef}
                      type="file"
                      accept="application/pdf,.pdf"
                      className="sr-only"
                      tabIndex={-1}
                      aria-hidden="true"
                      onChange={onPdf}
                    />
                    <button
                      ref={pickRef}
                      type="button"
                      // Tanpa tanda tangan tersimpan, "Buat tanda tangan" yang jadi tombol utama.
                      className={overview.saved ? "btn" : "btn btn-ghost"}
                      onClick={() => fileRef.current?.click()}
                      disabled={importing}
                      aria-busy={importing || undefined}
                    >
                      <IconFileUpload size={18} aria-hidden="true" />
                      {importing ? "Membaca PDF..." : "Pilih PDF untuk ditandatangani"}
                    </button>
                  </>
                )}
              </div>
            </div>

            {!overview.canRequest && (
              <p className="sign-guest">
                Tamu tidak bisa meminta tanda tangan, tetapi bisa menandatangani dokumen yang dikirim rekan untuk proyek
                yang boleh Anda buka.
              </p>
            )}

            {warned > 0 && (
              <div className="alert">
                <IconAlertTriangle size={18} aria-hidden="true" />
                <div>
                  <strong>{warned === 1 ? "Satu dokumen" : `${warned} dokumen`} perlu diperiksa</strong>
                  <p>Ada file yang berubah atau hilang setelah ditandatangani. Rinciannya ada di baris bertanda peringatan.</p>
                </div>
              </div>
            )}

            {requests.length === 0 ? (
              <div className="sign-empty">
                {waiting.length > 0 ? (
                  <p>Dokumen lain yang Anda kirim atau sudah Anda tanda tangani muncul di sini.</p>
                ) : overview.canRequest ? (
                  <p>
                    Belum ada dokumen. Pilih PDF untuk ditandatangani sendiri atau bersama rekan. Permintaan dikirim ke
                    penanda tangan saat laptop mereka tersambung.
                  </p>
                ) : (
                  <p>
                    Belum ada dokumen untuk Anda tanda tangani. Permintaan dari rekan muncul di sini begitu laptop
                    pengirimnya tersambung.
                  </p>
                )}
              </div>
            ) : (
              <ul className="sign-list">
                {requests.map((r) => (
                  <RequestRow key={r.id} r={r} onOpen={openDoc} download={download} />
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      <SignatureSetupDialog
        open={setupOpen}
        onOpenChange={(next) => {
          setSetupOpen(next);
          if (!next && savedNow.current) {
            savedNow.current = false;
            focusMineAction();
          }
        }}
        onSave={({ png, pin }) => saveSignature(png, pin)}
      />

      <PinDialog
        open={pinDeleteOpen}
        onOpenChange={(next) => {
          setPinDeleteOpen(next);
          if (!next && !forgotNext.current) focusMineAction();
          forgotNext.current = false;
        }}
        title="Hapus tanda tangan tersimpan?"
        description="Masukkan PIN tanda tangan Anda. Gambar tanda tangan dan PIN-nya dihapus dari laptop ini, dokumen yang sudah Anda tanda tangani tidak berubah. Tanda tangan baru bisa langsung dibuat dan dipakai."
        submitLabel="Hapus tanda tangan"
        danger
        lockedUntil={overview?.saved?.lockedUntil ?? null}
        onSubmit={deleteWithPin}
        extraAction={
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              forgotNext.current = true;
              setPinDeleteOpen(false);
              setDeleteError(null);
              setForgotOpen(true);
            }}
          >
            Lupa PIN?
          </button>
        }
      />

      <ConfirmDialog
        open={forgotOpen}
        onOpenChange={(next) => {
          setForgotOpen(next);
          if (!next) focusMineAction();
        }}
        title="Hapus tanda tangan tanpa PIN?"
        confirmLabel="Hapus tanpa PIN"
        busyLabel="Menghapus..."
        busy={deleting}
        onConfirm={() => void deleteWithoutPin()}
        error={
          deleteError && (
            <ErrorAlert title="Tanda tangan belum terhapus">
              <p>{deleteError.message}</p>
            </ErrorAlert>
          )
        }
      >
        <p>
          Gambar tanda tangan dan PIN-nya dihapus dari laptop ini. Dokumen yang sudah Anda tanda tangani tidak berubah.
        </p>
        <p className="sign-confirm-p">
          Tanda tangan baru yang Anda buat setelah ini baru bisa dipakai 24 jam setelah penghapusan. Masa tunggu ini
          mencegah orang lain yang memakai laptop Anda saat tidak terkunci menghapus tanda tangan Anda, lalu
          menandatangani dengan PIN buatannya sendiri.
        </p>
        <p className="sign-confirm-p">Penghapusan ini tercatat di jejak audit.</p>
      </ConfirmDialog>

      <NewRequestDialog
        open={newOpen}
        onOpenChange={(next) => {
          setNewOpen(next);
          if (next) return;
          setImported(null);
          // Tombol pemilih nonaktif saat membaca PDF, jadi dialog tidak tahu pembukanya.
          window.setTimeout(() => pickRef.current?.focus(), 0);
        }}
        imported={imported}
        onCreated={onCreated}
      />

      <VerifyDialog
        open={verifyOpen}
        onOpenChange={setVerifyOpen}
        onOpenRequest={(id) => {
          setVerifyOpen(false);
          openDoc(id);
        }}
      />
    </main>
  );
}
