import { IconPlus } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toAppError, type AppError } from "../../api";
import {
  addDocuments,
  exportVersion,
  finishEdit,
  getDocument,
  listDocuments,
  openReadOnly,
  pickExportDestination,
  pickFilesToAdd,
  resolveConflict,
  restoreVersion,
  startEdit,
  type DocumentSummary,
  type DocumentVersion,
} from "../../api/documents";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { keys, type DocActions } from "./actions";
import { DocumentDetail } from "./DocumentDetail";
import { DocumentRow } from "./DocumentRow";
import { appName, errorHint, errorTitle, LIBRARY_LABEL, type ActionKind } from "./text";
import { useReload } from "./useReload";
import "./docs.css";

// Pustaka umum organisasi. Proyek dari Tahap 3 belum ada.
const PROJECT_ID: string | null = null;

type Feedback =
  | { kind: "ok"; text: string }
  | { kind: "error"; title: string; error: AppError; hint: string | null }
  | null;

type RestoreTarget = { doc: DocumentSummary; version: DocumentVersion };

function validList(data: DocumentSummary[] | null): DocumentSummary[] | null {
  return Array.isArray(data) ? data : null;
}

export function DocsScreen() {
  const loadList = useCallback(() => listDocuments(PROJECT_ID), []);
  const list = useReload(loadList, "list");
  const docs = validList(list.data);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = docs?.find((d) => d.id === selectedId) ?? null;
  const detail = useReload(selectedId ? () => getDocument(selectedId) : null, selectedId ?? "");

  const [pending, setPending] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [focusConflict, setFocusConflict] = useState(0);
  const [restore, setRestore] = useState<RestoreTarget | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<AppError | null>(null);

  // File terpilih hilang dari daftar (atau belum ada pilihan): pilih file pertama.
  useEffect(() => {
    if (!docs) return;
    if (!selectedId || !docs.some((d) => d.id === selectedId)) setSelectedId(docs[0]?.id ?? null);
  }, [docs, selectedId]);

  const reloadList = list.reload;
  const reloadDetail = detail.reload;
  const reloadAll = useCallback(async () => {
    await Promise.all([reloadList(), reloadDetail()]);
  }, [reloadList, reloadDetail]);

  // Satu aksi pada satu waktu. Ref dipakai (bukan hanya state) supaya klik
  // kedua sebelum render berikutnya tetap ditolak.
  const busyRef = useRef(false);

  // Tombol yang baru ditekan bisa hilang setelah aksi (Selesai mengedit, Pakai
  // versi ini). Kalau fokus jatuh ke body, fokus dipindah ke baris file itu.
  const [refocus, setRefocus] = useState<{ id: string; n: number } | null>(null);
  const focusDoc = useCallback((id: string) => setRefocus((r) => ({ id, n: (r?.n ?? 0) + 1 })), []);
  useEffect(() => {
    if (!refocus) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const picks = document.querySelectorAll<HTMLElement>("[data-doc-pick]");
    Array.from(picks)
      .find((el) => el.dataset.docPick === refocus.id)
      ?.focus();
  }, [refocus]);

  // Menjalankan satu aksi: tombolnya sibuk, tombol lain menunggu, hasilnya
  // ditampilkan di atas daftar.
  const run = useCallback(
    async <T,>(
      key: string,
      action: ActionKind,
      docId: string | null,
      task: () => Promise<T>,
      ok: (result: T) => string | null,
    ) => {
      if (busyRef.current) return false;
      busyRef.current = true;
      setPending(key);
      setFeedback(null);
      try {
        const result = await task();
        // null = tidak ada yang berubah (dialog dibatalkan, file dibuka hanya baca).
        if (result !== null) await reloadAll();
        const text = ok(result);
        if (text) setFeedback({ kind: "ok", text });
        return true;
      } catch (err) {
        const error = toAppError(err);
        setFeedback({ kind: "error", title: errorTitle(error, action), error, hint: errorHint(error, action) });
        if (error.code === "not_found" || error.code === "forbidden" || error.code === "document_editing") {
          void reloadAll();
        }
        return false;
      } finally {
        busyRef.current = false;
        setPending(null);
        if (docId) focusDoc(docId);
      }
    },
    [reloadAll, focusDoc],
  );

  const addFiles = useCallback(() => {
    void run(
      keys.add,
      "add",
      null,
      async () => {
        const paths = await pickFilesToAdd();
        if (!paths || paths.length === 0) return null;
        return addDocuments(paths, PROJECT_ID);
      },
      (added) => {
        if (!added || added.length === 0) return null;
        setSelectedId(added[0].id);
        // Tombol Tambah file di keadaan kosong hilang begitu daftar muncul.
        focusDoc(added[0].id);
        return added.length === 1
          ? `${added[0].name} ditambahkan ke pustaka ${LIBRARY_LABEL}.`
          : `${added.length} file ditambahkan ke pustaka ${LIBRARY_LABEL}.`;
      },
    );
  }, [run, focusDoc]);

  const actions: DocActions = useMemo(
    () => ({
      pending,
      edit: (doc, from) => {
        const app = appName(doc.kind) ?? "aplikasi bawaan";
        void run(
          keys.edit(doc.id, from?.id ?? null),
          "edit",
          doc.id,
          () => startEdit(doc.id, from?.id ?? null),
          () =>
            from
              ? `Versi ${from.number} dibuka di ${app}. Gabungkan isinya, lalu simpan untuk menyelesaikan bentrok.`
              : `${doc.name} dibuka di ${app}. Setiap kali Anda menyimpan, Mira mencatat versi baru.`,
        );
      },
      finish: (doc) => {
        void run(
          keys.finish(doc.id),
          "finish",
          doc.id,
          () => finishEdit(doc.id),
          () => `Selesai mengedit ${doc.name}. Rekan sekarang bisa mengeditnya.`,
        );
      },
      open: (doc, version) => {
        const number = version?.number ?? doc.current.number;
        void run(
          keys.open(doc.id, version?.id ?? null),
          "open",
          doc.id,
          () => openReadOnly(doc.id, version?.id ?? null),
          () => `${doc.name} versi ${number} dibuka hanya baca.`,
        );
      },
      exportCopy: (doc, version) => {
        void run(
          keys.export(doc.id, version.id),
          "export",
          doc.id,
          async () => {
            const destination = await pickExportDestination(doc.name);
            if (!destination) return null;
            await exportVersion(doc.id, version.id, destination);
            return destination;
          },
          (destination) => (destination ? `Salinan versi ${version.number} disimpan di ${destination}.` : null),
        );
      },
      askRestore: (doc, version) => {
        if (busyRef.current) return;
        setRestoreError(null);
        setRestore({ doc, version });
      },
      resolve: (doc, keep) => {
        void run(
          keys.resolve(doc.id, keep.id),
          "resolve",
          doc.id,
          () => resolveConflict(doc.id, keep.id),
          (result) => `Bentrok selesai. Versi ${result.current.number} berisi isi versi ${keep.number}.`,
        );
      },
      showConflict: (doc) => {
        if (busyRef.current) return;
        setSelectedId(doc.id);
        setFocusConflict((n) => n + 1);
      },
    }),
    [pending, run],
  );

  const confirmRestore = useCallback(async () => {
    if (!restore || busyRef.current) return;
    busyRef.current = true;
    setRestoreBusy(true);
    setRestoreError(null);
    try {
      const result = await restoreVersion(restore.doc.id, restore.version.id);
      setRestore(null);
      setFeedback({
        kind: "ok",
        text: `Versi ${restore.version.number} dipulihkan menjadi versi ${result.current.number}.`,
      });
      void reloadAll();
    } catch (err) {
      const error = toAppError(err);
      setRestoreError(error);
      if (error.code === "not_found" || error.code === "document_editing") void reloadAll();
    } finally {
      busyRef.current = false;
      setRestoreBusy(false);
    }
  }, [restore, reloadAll]);

  const empty = docs !== null && docs.length === 0;
  const addBusy = pending === keys.add;
  const now = new Date();

  // aria-disabled, bukan disabled: tombol yang dinonaktifkan kehilangan fokus
  // keyboard di WebView2. Klik selama sibuk ditolak oleh run().
  const addButton = (
    <button
      type="button"
      className="btn"
      onClick={addFiles}
      aria-disabled={pending !== null || undefined}
      aria-busy={addBusy || undefined}
    >
      <IconPlus size={18} aria-hidden="true" />
      {addBusy ? "Menambahkan..." : "Tambah file"}
    </button>
  );

  return (
    <main className="docs" aria-labelledby="page-title">
      <header className="page-head docs-head">
        <h1 id="page-title" className="page-title">
          Dokumen
        </h1>
        <span className="page-sub">Pustaka {LIBRARY_LABEL}</span>
        {!empty && <div className="docs-head-action">{addButton}</div>}
      </header>

      <div aria-live="polite" className="docs-live">
        {feedback?.kind === "ok" && <p className="docs-ok">{feedback.text}</p>}
        {feedback?.kind === "error" && (
          <ErrorAlert title={feedback.title}>
            <p>{feedback.error.message}</p>
            {feedback.hint && <p>{feedback.hint}</p>}
          </ErrorAlert>
        )}
        {docs && list.error && (
          <p className="hint">
            Daftar terbaru belum bisa dibaca ({list.error.message}). Yang tampil adalah data terakhir.
          </p>
        )}
      </div>

      {list.loading && !docs && (
        <p className="docs-pad hint" role="status">
          Memuat daftar dokumen...
        </p>
      )}

      {!list.loading && !docs && (
        <div className="docs-pad docs-narrow" role="alert">
          <ErrorAlert title="Daftar dokumen belum terbaca">
            <p>{list.error?.message ?? "Inti Mira tidak mengirim daftar dokumen."}</p>
            <button type="button" className="btn btn-ghost btn-sm docs-retry" onClick={() => void list.reload()}>
              Coba baca lagi
            </button>
          </ErrorAlert>
        </div>
      )}

      {empty && (
        <div className="docs-pad">
          <section className="docs-empty" aria-labelledby="docs-empty-title">
            <h2 id="docs-empty-title" className="docs-empty-title">
              Pustaka {LIBRARY_LABEL} masih kosong
            </h2>
            <p>
              Tambahkan file Word, Excel, PDF, atau jenis lain. Setiap kali file Word atau Excel disimpan, Mira mencatat
              versi baru, jadi versi lama tetap bisa dibuka dan dipulihkan.
            </p>
            <div>{addButton}</div>
          </section>
        </div>
      )}

      {docs && docs.length > 0 && (
        <div className="docs-layout">
          <ul className="doc-list" aria-label={`File di pustaka ${LIBRARY_LABEL}`}>
            {docs.map((doc) => (
              <DocumentRow
                key={doc.id}
                doc={doc}
                selected={doc.id === selectedId}
                onSelect={() => setSelectedId(doc.id)}
                actions={actions}
                now={now}
              />
            ))}
          </ul>
          {selected && (
            <DocumentDetail
              summary={selected}
              detail={detail.data}
              loading={detail.loading}
              error={detail.error}
              onRetry={() => void detail.reload()}
              actions={actions}
              focusConflict={focusConflict}
              now={now}
            />
          )}
        </div>
      )}

      <ConfirmDialog
        open={restore !== null}
        onOpenChange={(open) => {
          if (!open) setRestore(null);
        }}
        title={restore ? `Pulihkan versi ${restore.version.number}?` : "Pulihkan versi"}
        confirmLabel={restore ? `Pulihkan versi ${restore.version.number}` : "Pulihkan"}
        busyLabel="Memulihkan..."
        busy={restoreBusy}
        danger={false}
        onConfirm={() => void confirmRestore()}
        error={
          restoreError && (
            <ErrorAlert title={errorTitle(restoreError, "restore")}>
              <p>{restoreError.message}</p>
              {errorHint(restoreError, "restore") && <p>{errorHint(restoreError, "restore")}</p>}
            </ErrorAlert>
          )
        }
      >
        {restore && (
          <>
            <p>
              Mira membuat versi baru berisi isi versi {restore.version.number} dari {restore.doc.name}. Semua versi
              lain tetap ada di riwayat.
            </p>
            {restore.doc.conflict && <p>Bentrok di file ini juga selesai, karena versi baru menggantikan semua versi yang berdampingan.</p>}
          </>
        )}
      </ConfirmDialog>
    </main>
  );
}
