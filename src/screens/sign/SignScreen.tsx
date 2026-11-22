import {
  IconAlertTriangle,
  IconChevronRight,
  IconFileSearch,
  IconFileTypePdf,
  IconFileUpload,
  IconLock,
  IconSignature,
} from "@tabler/icons-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent } from "react";
import { toAppError, type AppError } from "../../api";
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
import { SignatureSetupDialog } from "./pad/SignatureSetupDialog";
import { SignDocumentView } from "./SignDocumentView";
import { NewRequestDialog } from "./NewRequestDialog";
import { VerifyDialog } from "./VerifyDialog";
import {
  checkPdfFile,
  exportWarningLabel,
  formatWhen,
  integrityLabel,
  modeLabel,
  readFileBytes,
  requestStateLabel,
} from "./labels";
import "./sign.css";

type Feedback = { kind: "ok"; text: string } | { kind: "error"; title: string; error: AppError } | null;

function validOverview(data: SignOverview | null): SignOverview | null {
  return data && typeof data === "object" && Array.isArray(data.requests) && data.me ? data : null;
}

// Giliran Anda paling atas, lalu yang masih berjalan, lalu selesai, lalu dibatalkan.
function rank(r: RequestSummary): number {
  if (r.status === "in_progress") return r.myState === "your_turn" ? 0 : 1;
  return r.status === "completed" ? 2 : 3;
}

export function sortRequests(list: RequestSummary[]): RequestSummary[] {
  return [...list].sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt));
}

function hasWarning(r: RequestSummary): boolean {
  return r.integrity !== "intact" || r.exportWarnings > 0;
}

function lockedUntil(saved: SavedSignatureInfo | null, now: number): number | null {
  if (!saved?.lockedUntil) return null;
  const t = new Date(saved.lockedUntil).getTime();
  return Number.isFinite(t) && t > now ? t : null;
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
    return () => {
      alive.current = false;
      window.removeEventListener("focus", onFocus);
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

function RequestRow({ r, onOpen }: { r: RequestSummary; onOpen: (id: string) => void }) {
  const mine = r.status === "in_progress" && r.myState === "your_turn";
  const warn = hasWarning(r);
  const when = r.completedAt ?? r.updatedAt;
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
          <span className="sign-row-meta">
            {r.signedCount} dari {r.signerCount} sudah tanda tangan
            <span aria-hidden="true"> · </span>
            <span className="sr-only">, </span>
            {modeLabel(r.mode)}
            <span aria-hidden="true"> · </span>
            <span className="sr-only">, </span>
            {r.completedAt ? "selesai" : "terakhir berubah"} {formatWhen(when)}
          </span>
          {warn && (
            <span className="sign-row-warnings">
              {r.integrity !== "intact" && (
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
    </li>
  );
}

export function SignScreen() {
  const { data, error, loading, reload } = useOverview();
  const overview = data;
  const [openId, setOpenId] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<AppError | null>(null);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<ImportedPdf | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pickRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  // Baris yang difokus lagi saat kembali dari layar dokumen.
  const returnTo = useRef<string | null>(null);
  const savedNow = useRef(false);

  // Kunci PIN berakhir sendiri; muat ulang tepat saat itu supaya statusnya hilang.
  const lockAt = lockedUntil(overview?.saved ?? null, Date.now());
  useEffect(() => {
    if (lockAt === null) return;
    const ms = Math.min(lockAt - Date.now() + 500, 2 ** 31 - 1);
    const timer = window.setTimeout(() => void reload(), Math.max(ms, 0));
    return () => window.clearTimeout(timer);
  }, [lockAt, reload]);

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

  async function deleteSignature() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await signingApi.deleteSignature();
      setDeleteOpen(false);
      setFeedback({ kind: "ok", text: "Tanda tangan tersimpan sudah dihapus. Anda bisa membuat yang baru kapan saja." });
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
      const result = await signingApi.importPdf(await readFileBytes(file), file.name);
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

  const requests = overview ? sortRequests(overview.requests) : [];
  const yourTurn = requests.filter((r) => r.status === "in_progress" && r.myState === "your_turn").length;
  const warned = requests.filter(hasWarning).length;

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

          <MySignature
            saved={overview.saved}
            onCreate={() => {
              setFeedback(null);
              setSetupOpen(true);
            }}
            onDelete={() => {
              setDeleteError(null);
              setDeleteOpen(true);
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
                      className="btn"
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
                Tamu tidak bisa meminta tanda tangan. Anda tetap bisa menandatangani dokumen yang dikirim kepada Anda.
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
                {overview.canRequest ? (
                  <p>
                    Belum ada dokumen. Pilih PDF untuk ditandatangani sendiri atau bersama rekan. Permintaan ke rekan
                    tersimpan di laptop ini sampai pengiriman lewat jaringan tersedia.
                  </p>
                ) : (
                  <p>
                    Belum ada dokumen untuk Anda tanda tangani. Permintaan dari rekan belum bisa sampai ke laptop ini
                    karena pengiriman lewat jaringan belum tersedia.
                  </p>
                )}
              </div>
            ) : (
              <ul className="sign-list">
                {requests.map((r) => (
                  <RequestRow key={r.id} r={r} onOpen={openDoc} />
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

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Hapus tanda tangan tersimpan?"
        confirmLabel="Hapus tanda tangan"
        busyLabel="Menghapus..."
        busy={deleting}
        onConfirm={() => void deleteSignature()}
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
          Setelah itu Anda bisa membuat tanda tangan baru dengan PIN baru. Ini juga jalan keluarnya kalau Anda lupa PIN.
        </p>
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
