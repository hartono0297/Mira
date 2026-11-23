import { IconPlus } from "@tabler/icons-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { toAppError, type AppError } from "../../api";
import {
  addDocuments,
  downloadVersion,
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
import { readLocation, resolveLocation, writeLocation, type DocsLocation } from "./location";
import {
  addedText,
  appName,
  CLIPBOARD_MISSING,
  COPY_FAILED_TITLE,
  copiedText,
  emptyTitle,
  errorHint,
  errorMessage,
  errorTitle,
  goneNote,
  GUEST_EMPTY_TEXT,
  GUEST_NO_PROJECT_TEXT,
  GUEST_NO_PROJECT_TITLE,
  LIBRARY_LABEL,
  placeText,
  projectLabel,
  visibilityHint,
  type ActionKind,
} from "./text";
import { useIsGuest } from "./useIsGuest";
import { useProjects } from "./useProjects";
import { useReload } from "./useReload";
import "./docs.css";

type Feedback =
  | { kind: "ok"; text: string }
  | { kind: "error"; title: string; error: AppError; hint: string | null }
  | null;

type RestoreTarget = { doc: DocumentSummary; version: DocumentVersion };

function validList(data: DocumentSummary[] | null): DocumentSummary[] | null {
  return Array.isArray(data) ? data : null;
}

export function DocsScreen() {
  const ids = useId();
  const projects = useProjects();
  // Selama ringkasan organisasi belum terbaca, layar bersikap seperti untuk anggota.
  const isGuest = useIsGuest() === true;
  // Lokasi yang dipilih (null = Pustaka Umum, atau untuk Tamu: proyek pertama), diingat per laptop.
  const [chosen, setChosen] = useState<DocsLocation>(readLocation);
  const resolved = resolveLocation(chosen, projects.list, projects.error !== null, isGuest);
  // Daftar yang dimuat: null = Pustaka Umum, string = proyek, undefined = tidak ada.
  const location = resolved.kind === "library" ? null : resolved.kind === "project" ? resolved.id : undefined;
  const locationLabel = resolved.kind === "project" ? resolved.label : null;
  const waiting = resolved.kind === "pending";

  const loadList = useCallback(() => listDocuments(location ?? null), [location]);
  const list = useReload(location === undefined ? null : loadList, location === undefined ? "none" : `list:${location ?? ""}`);
  const docs = validList(list.data);
  const listLoading = waiting || (location !== undefined && list.loading);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = docs?.find((d) => d.id === selectedId) ?? null;
  const detail = useReload(selectedId ? () => getDocument(selectedId) : null, selectedId ?? "");

  const [pending, setPending] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [focusConflict, setFocusConflict] = useState(0);
  const [focusVersions, setFocusVersions] = useState(0);
  const [restore, setRestore] = useState<RestoreTarget | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<AppError | null>(null);

  // true setelah daftar proyek gagal dibaca dan layar kembali ke lokasi bawaan:
  // begitu daftar terbaca lagi, proyek yang diingat dibuka lagi, kecuali
  // pengguna sudah memilih lokasi lain.
  const restoreSaved = useRef(false);

  // Proyek yang diingat sudah tidak ada di daftar proyek saya (dikeluarkan,
  // atau proyeknya hilang): kembali ke lokasi bawaan dan beri tahu. Daftar
  // proyek yang gagal dibaca juga kembali ke lokasi bawaan, tetapi pilihan
  // tersimpan dibiarkan supaya bisa dibuka lagi.
  useEffect(() => {
    if (!chosen) {
      if (restoreSaved.current && projects.list) {
        restoreSaved.current = false;
        const saved = readLocation();
        if (saved) setChosen(saved);
      }
      return;
    }
    if (projects.list) {
      const found = projects.list.find((p) => p.id === chosen.projectId);
      if (found) {
        const label = projectLabel(found);
        if (label !== chosen.label) {
          const next = { projectId: found.id, label };
          setChosen(next);
          writeLocation(next);
        }
        return;
      }
      setChosen(null);
      writeLocation(null);
      setSelectedId(null);
      // Tamu pindah ke proyek pertama (kalau ada), anggota ke Pustaka Umum.
      const first = projects.list[0];
      const next = isGuest ? (first ? projectLabel(first) : undefined) : null;
      setFeedback({ kind: "ok", text: goneNote(chosen.label, next) });
    } else if (projects.error) {
      restoreSaved.current = true;
      setChosen(null);
    }
  }, [chosen, projects.list, projects.error, isGuest]);

  const chooseLocation = useCallback(
    (value: string) => {
      restoreSaved.current = false;
      setFeedback(null);
      setSelectedId(null);
      if (value === "") {
        setChosen(null);
        writeLocation(null);
        return;
      }
      const found = projects.list?.find((p) => p.id === value);
      if (!found) return;
      const next = { projectId: found.id, label: projectLabel(found) };
      setChosen(next);
      writeLocation(next);
    },
    [projects.list],
  );

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

  // Satu aksi yang mengubah data pada satu waktu. Ref dipakai (bukan hanya
  // state) supaya klik kedua sebelum render berikutnya tetap ditolak.
  const busyRef = useRef(false);
  // Unduhan dari rekan dicatat sendiri: bisa lama (file besar), jadi tidak
  // menahan aksi lain. Satu unduhan per versi.
  const downloadsRef = useRef<Set<string>>(new Set());
  const [downloads, setDownloads] = useState<ReadonlySet<string>>(() => new Set());

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
        // not_available: keadaan unduhan mungkin sudah berubah (rekan baru saja putus).
        if (
          error.code === "not_found" ||
          error.code === "forbidden" ||
          error.code === "document_editing" ||
          error.code === "not_available"
        ) {
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
    // Lokasi dicatat saat tombol ditekan, supaya pesan menyebut tempat file benar-benar ditambahkan.
    // Lokasi yang belum pasti: tombolnya aria-disabled dan klik diabaikan.
    if (location === undefined || isGuest) return;
    const target = location;
    const label = locationLabel;
    void run(
      keys.add,
      "add",
      null,
      async () => {
        const paths = await pickFilesToAdd();
        if (!paths || paths.length === 0) return null;
        return addDocuments(paths, target);
      },
      (added) => {
        if (!added || added.length === 0) return null;
        setSelectedId(added[0].id);
        // Tombol Tambah file di keadaan kosong hilang begitu daftar muncul.
        focusDoc(added[0].id);
        return addedText(added, label);
      },
    );
  }, [run, focusDoc, location, locationLabel, isGuest]);

  const download = useCallback(
    async (doc: DocumentSummary, version: DocumentVersion) => {
      const key = keys.download(doc.id, version.id);
      if (downloadsRef.current.has(key)) return;
      downloadsRef.current.add(key);
      setDownloads(new Set(downloadsRef.current));
      setFeedback(null);
      try {
        const result = await downloadVersion(doc.id, version.id);
        await reloadAll();
        // Versi yang sedang disalin otomatis tidak diunduh dua kali; inti
        // mengembalikan ringkasan dengan versi itu masih `downloading`.
        const same = [result?.current, ...(result?.conflictVersions ?? [])].find((v) => v?.id === version.id);
        const text = same?.downloading
          ? `Versi ${version.number} sedang disalin. Daftar diperbarui begitu selesai.`
          : `Isi versi ${version.number} dari ${doc.name} sudah ada di laptop ini.`;
        setFeedback({ kind: "ok", text });
      } catch (err) {
        const error = toAppError(err);
        setFeedback({ kind: "error", title: errorTitle(error, "download"), error, hint: errorHint(error, "download") });
        // Keadaan unduhan mungkin sudah berubah (rekan baru saja putus).
        void reloadAll();
      } finally {
        downloadsRef.current.delete(key);
        setDownloads(new Set(downloadsRef.current));
        focusDoc(doc.id);
      }
    },
    [reloadAll, focusDoc],
  );

  const actions: DocActions = useMemo(
    () => ({
      pending,
      downloads,
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
      download: (doc, version) => {
        void download(doc, version);
      },
      showVersions: (doc) => {
        setSelectedId(doc.id);
        setFocusVersions((n) => n + 1);
      },
      copyName: (doc) => {
        const write = navigator.clipboard
          ? navigator.clipboard.writeText(doc.name)
          : Promise.reject(new Error(CLIPBOARD_MISSING));
        write.then(
          () => setFeedback({ kind: "ok", text: copiedText(doc.name) }),
          (err: unknown) => setFeedback({ kind: "error", title: COPY_FAILED_TITLE, error: toAppError(err), hint: null }),
        );
      },
    }),
    [pending, downloads, run, download],
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
  // Penjelasan di bawah select. Selama proyek yang diingat belum pasti, label
  // tersimpannya yang dipakai. Tamu tidak pernah melihat keterangan Pustaka Umum.
  const hint =
    resolved.kind === "library"
      ? visibilityHint(null)
      : resolved.kind === "project"
        ? visibilityHint(resolved.label)
        : waiting && chosen
          ? visibilityHint(chosen.label)
          : null;
  const pendingOption = waiting && chosen;
  const hasOptions = !isGuest || pendingOption || (projects.list?.length ?? 0) > 0;
  const selectValue = resolved.kind === "project" ? resolved.id : pendingOption ? chosen.projectId : "";
  const addBusy = pending === keys.add;
  const now = new Date();

  // aria-disabled, bukan disabled: tombol yang dinonaktifkan kehilangan fokus
  // keyboard di WebView2. Klik selama sibuk, atau selama lokasi belum pasti,
  // ditolak oleh addFiles dan run().
  const addButton = (
    <button
      type="button"
      className="btn"
      onClick={addFiles}
      aria-disabled={pending !== null || waiting || undefined}
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
        {/* Tamu tidak bisa menambah file (documents::access). */}
        {!isGuest && !empty && <div className="docs-head-action">{addButton}</div>}
      </header>

      <div className="docs-loc">
        {hasOptions && (
          <div className="field">
            <label htmlFor={`${ids}-loc`}>Lokasi</label>
            <select
              id={`${ids}-loc`}
              value={selectValue}
              onChange={(e) => chooseLocation(e.target.value)}
              aria-describedby={hint ? `${ids}-loc-hint` : undefined}
            >
              {!isGuest && <option value="">{LIBRARY_LABEL}</option>}
              {pendingOption && <option value={chosen.projectId}>{chosen.label}</option>}
              {(projects.list ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {projectLabel(p)}
                </option>
              ))}
            </select>
          </div>
        )}
        {hint && (
          <p id={`${ids}-loc-hint`} className="hint">
            {hint}
          </p>
        )}
        <div aria-live="polite">
          {projects.list === null && !projects.error && (
            <p className="hint" role="status">
              Memuat daftar proyek...
            </p>
          )}
          {projects.error && (
            <p className="hint">
              Daftar proyek belum terbaca ({projects.error.message}).
              {!isGuest && ` ${LIBRARY_LABEL} tetap bisa dipakai.`}{" "}
              <button type="button" className="link-btn" onClick={() => void projects.reload()}>
                Baca daftar proyek lagi
              </button>
            </p>
          )}
        </div>
      </div>

      <div aria-live="polite" className="docs-live">
        {feedback?.kind === "ok" && <p className="docs-ok">{feedback.text}</p>}
        {feedback?.kind === "error" && (
          <ErrorAlert title={feedback.title}>
            <p>{errorMessage(feedback.error)}</p>
            {feedback.hint && <p>{feedback.hint}</p>}
          </ErrorAlert>
        )}
        {docs && list.error && (
          <p className="hint">
            Daftar terbaru belum bisa dibaca ({list.error.message}). Yang tampil adalah data terakhir.
          </p>
        )}
      </div>

      {listLoading && !docs && (
        <p className="docs-pad hint" role="status">
          Memuat daftar dokumen...
        </p>
      )}

      {location !== undefined && !listLoading && !docs && (
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
              {emptyTitle(locationLabel)}
            </h2>
            {isGuest ? (
              <p>{GUEST_EMPTY_TEXT}</p>
            ) : (
              <>
                <p>
                  Tambahkan file Word, Excel, PDF, atau jenis lain. Setiap kali file Word atau Excel disimpan, Mira
                  mencatat versi baru, jadi versi lama tetap bisa dibuka dan dipulihkan.
                </p>
                <div>{addButton}</div>
              </>
            )}
          </section>
        </div>
      )}

      {resolved.kind === "none" && (
        <div className="docs-pad">
          <section className="docs-empty" aria-labelledby="docs-guest-title">
            <h2 id="docs-guest-title" className="docs-empty-title">
              {GUEST_NO_PROJECT_TITLE}
            </h2>
            <p>{GUEST_NO_PROJECT_TEXT}</p>
          </section>
        </div>
      )}

      {docs && docs.length > 0 && (
        <div className="docs-layout">
          <ul className="doc-list" aria-label={`File di ${placeText(locationLabel)}`}>
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
              focusVersions={focusVersions}
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
