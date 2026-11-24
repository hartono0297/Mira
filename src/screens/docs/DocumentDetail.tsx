import { IconAlertTriangle, IconClockHour4, IconDownload } from "@tabler/icons-react";
import { useEffect, useRef, type RefObject } from "react";
import { relativeTime } from "../../api/format";
import type { AppError } from "../../api";
import type { DocumentDetail as Detail, DocumentSummary, DocumentVersion } from "../../api/documents";
import { ErrorAlert } from "../../components/ErrorAlert";
import { initials } from "../../components/initials";
import { isBlocked, isBusy, keys, type DocActions } from "./actions";
import { KindIcon } from "./KindIcon";
import {
  appName,
  DOCS,
  downloadLabel,
  editable,
  fetchState,
  fetchText,
  formatSize,
  originText,
  person,
  personInline,
  versionList,
} from "./text";

// Memfokus elemen hanya saat token berubah sesudah komponen terpasang. Panel
// yang dipasang ulang (misalnya sesudah ganti lokasi) membawa token lama yang
// bukan nol; nilai itu dicatat saat mount supaya fokus tidak ikut melompat.
function useFocusOnChange(token: number, ref: RefObject<HTMLElement | null>) {
  const seen = useRef(token);
  useEffect(() => {
    if (token === seen.current) return;
    seen.current = token;
    ref.current?.focus();
    ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [token, ref]);
}

type Props = {
  summary: DocumentSummary;
  detail: Detail | null;
  loading: boolean;
  error: AppError | null;
  onRetry: () => void;
  actions: DocActions;
  // Berubah setiap kali tombol "Selesaikan bentrok" di daftar ditekan.
  focusConflict: number;
  // Berubah setiap kali "Lihat riwayat versi" di menu baris dipilih.
  focusVersions: number;
  now: Date;
};

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Avatar({ name }: { name: string }) {
  return (
    <span className="avatar doc-avatar" aria-hidden="true">
      {initials(name)}
    </span>
  );
}

function ActionButton({
  pendingKey,
  actions,
  label,
  ariaLabel,
  busyLabel,
  primary,
  onClick,
}: {
  pendingKey: string;
  actions: DocActions;
  label: string;
  ariaLabel: string;
  busyLabel: string;
  primary?: boolean;
  onClick: () => void;
}) {
  const busy = isBusy(actions, pendingKey);
  // Selama aksi lain yang mengubah data berjalan, tombol ini menunggu.
  // aria-disabled menjaga fokus keyboard tetap di tombol (disabled membuang
  // fokus di WebView2).
  const blocked = isBlocked(actions, pendingKey);
  return (
    <button
      type="button"
      className={`btn btn-sm${primary ? "" : " btn-ghost"}`}
      aria-label={busy ? busyLabel : ariaLabel}
      aria-disabled={blocked || undefined}
      aria-busy={busy || undefined}
      onClick={() => {
        if (!blocked) onClick();
      }}
    >
      {busy ? busyLabel : label}
    </button>
  );
}

function ConflictBox({
  doc,
  actions,
  titleRef,
  now,
}: {
  doc: DocumentSummary;
  actions: DocActions;
  titleRef: RefObject<HTMLHeadingElement | null>;
  now: Date;
}) {

  const heads = doc.conflictVersions;
  const app = appName(doc.kind);
  const canMerge = editable(doc.kind) && doc.can.edit;
  return (
    <div className="conflict" role="group" aria-labelledby={`conflict-title-${doc.id}`}>
      <h3 id={`conflict-title-${doc.id}`} className="conflict-title" tabIndex={-1} ref={titleRef}>
        <IconAlertTriangle size={18} aria-hidden="true" />
        {DOCS.detail.conflictTitle(heads.length)}
      </h3>
      <p>{DOCS.detail.conflictBody(capitalize(versionList(heads)), canMerge)}</p>
      <ul className="conflict-heads">
        {heads.map((v) => (
          <li key={v.id} className="head-card">
            {/* Nama pembuat di judul kartu: bentrok dengan rekan langsung terbaca siapa membuat apa. */}
            <p className="head-num">{DOCS.detail.headTitle(v.number, personInline(v.author))}</p>
            <p className="head-meta">
              {originText(v, doc.kind)} · {relativeTime(v.createdAt, now)}
            </p>
            {v.available ? (
              <HeadActions doc={doc} v={v} actions={actions} canMerge={canMerge} />
            ) : (
              <div className="head-actions">
                <FetchStatus doc={doc} v={v} actions={actions} />
                {doc.can.resolve && <p className="head-meta">{DOCS.detail.headPickLater}</p>}
              </div>
            )}
          </li>
        ))}
      </ul>
      {canMerge && doc.can.resolve && (
        <p className="conflict-note">{DOCS.detail.mergeNote(app)}</p>
      )}
      {!doc.can.resolve && (
        <p className="conflict-note">{DOCS.detail.noResolve}</p>
      )}
    </div>
  );
}

// Isi versi belum ada di laptop ini: keterangan, dan tombol unduh untuk file di atas 20 MB.
function FetchStatus({ doc, v, actions }: { doc: DocumentSummary; v: DocumentVersion; actions: DocActions }) {
  const state = fetchState(v);
  if (!state) return null;
  return (
    <>
      <p className="ver-fetch">
        {state === "manual" ? (
          <IconDownload size={14} aria-hidden="true" />
        ) : (
          <IconClockHour4 size={14} aria-hidden="true" />
        )}
        {fetchText(state)}
      </p>
      {state === "manual" && (
        <div>
          <ActionButton
            pendingKey={keys.download(doc.id, v.id)}
            actions={actions}
            label={downloadLabel(v)}
            ariaLabel={DOCS.detail.downloadAria(v.number, formatSize(v.size))}
            busyLabel={DOCS.detail.downloading}
            onClick={() => actions.download(doc, v)}
          />
        </div>
      )}
    </>
  );
}

function HeadActions({
  doc,
  v,
  actions,
  canMerge,
}: {
  doc: DocumentSummary;
  v: DocumentVersion;
  actions: DocActions;
  canMerge: boolean;
}) {
  return (
    <div className="head-actions">
      {doc.can.resolve && (
        <ActionButton
          pendingKey={keys.resolve(doc.id, v.id)}
          actions={actions}
          label={DOCS.detail.useThis}
          ariaLabel={DOCS.detail.useThisAria(v.number)}
          busyLabel={DOCS.detail.savingChoice}
          primary
          onClick={() => actions.resolve(doc, v)}
        />
      )}
      {canMerge && (
        <ActionButton
          pendingKey={keys.edit(doc.id, v.id)}
          actions={actions}
          label={DOCS.detail.mergeManual}
          ariaLabel={DOCS.detail.mergeAria(v.number)}
          busyLabel={DOCS.detail.opening}
          onClick={() => actions.edit(doc, v)}
        />
      )}
      <ActionButton
        pendingKey={keys.open(doc.id, v.id)}
        actions={actions}
        label={DOCS.detail.open}
        ariaLabel={DOCS.detail.openAria(v.number)}
        busyLabel={DOCS.detail.opening}
        onClick={() => actions.open(doc, v)}
      />
    </div>
  );
}

function VersionRow({
  doc,
  v,
  actions,
  canRestore,
  now,
}: {
  doc: DocumentSummary;
  v: DocumentVersion;
  actions: DocActions;
  canRestore: boolean;
  now: Date;
}) {
  const isCurrent = v.id === doc.current.id;
  return (
    <li className="ver">
      <Avatar name={v.author.displayName} />
      <div className="ver-main">
        <p className="ver-num">
          {DOCS.detail.version(v.number)}
          {isCurrent && <span className="chip chip-on">{DOCS.detail.current}</span>}
        </p>
        <p className="ver-origin">{originText(v, doc.kind)}</p>
        <p className="ver-meta">
          {person(v.author)} · {relativeTime(v.createdAt, now)} · {formatSize(v.size)}
        </p>
        {v.available ? (
          <div className="ver-actions">
            <ActionButton
              pendingKey={keys.open(doc.id, v.id)}
              actions={actions}
              label={DOCS.detail.open}
              ariaLabel={DOCS.detail.openAria(v.number)}
              busyLabel={DOCS.detail.opening}
              onClick={() => actions.open(doc, v)}
            />
            {doc.can.export && (
              <ActionButton
                pendingKey={keys.export(doc.id, v.id)}
                actions={actions}
                label={DOCS.exportCopy}
                ariaLabel={DOCS.detail.exportAria(v.number)}
                busyLabel={DOCS.detail.saving}
                onClick={() => actions.exportCopy(doc, v)}
              />
            )}
            {/* Kepala bentrok dipilih lewat "Pakai versi ini", bukan Pulihkan. */}
            {canRestore && !isCurrent && !v.isHead && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label={DOCS.restore.confirmOf(v.number)}
                aria-disabled={actions.pending !== null || undefined}
                onClick={() => actions.askRestore(doc, v)}
              >
                {DOCS.restore.confirm}
              </button>
            )}
          </div>
        ) : (
          <FetchStatus doc={doc} v={v} actions={actions} />
        )}
      </div>
    </li>
  );
}

export function DocumentDetail({
  summary,
  detail,
  loading,
  error,
  onRetry,
  actions,
  focusConflict,
  focusVersions,
  now,
}: Props) {
  // Fokus diatur di sini, bukan di ConflictBox: kotak bentrok baru terpasang
  // saat file bentrok dipilih, bersamaan dengan token yang naik.
  const conflictRef = useRef<HTMLHeadingElement>(null);
  const historyRef = useRef<HTMLHeadingElement>(null);
  useFocusOnChange(focusConflict, conflictRef);
  useFocusOnChange(focusVersions, historyRef);
  // Ringkasan dari daftar dipakai sampai detail file ini selesai dimuat.
  const doc: DocumentSummary = detail && detail.id === summary.id ? detail : summary;
  const versions = detail && detail.id === summary.id ? detail.versions : null;
  const editingHere = doc.editing.some((e) => e.local);
  const canRestore = doc.can.restore && !editingHere;
  const titleId = `detail-title-${doc.id}`;

  return (
    <section className="docs-detail" aria-labelledby={titleId}>
      <header className="detail-head">
        <KindIcon kind={doc.kind} size={28} />
        <div className="detail-head-text">
          <h2 id={titleId} className="detail-title">
            {doc.name}
          </h2>
          <p className="detail-sub">
            {DOCS.detail.sub(doc.versionCount, formatSize(doc.current.size))}
          </p>
        </div>
      </header>

      {doc.conflict && doc.conflictVersions.length > 1 && (
        <ConflictBox doc={doc} actions={actions} titleRef={conflictRef} now={now} />
      )}

      <h3 className="detail-label" tabIndex={-1} ref={historyRef}>
        {DOCS.detail.history}
      </h3>
      {editingHere && doc.can.restore && (
        <p className="hint">{DOCS.detail.restoreAfterFinish}</p>
      )}
      {versions === null && loading && (
        <p className="hint" role="status">
          {DOCS.detail.loadingHistory}
        </p>
      )}
      {versions === null && !loading && error && (
        <div role="alert">
          <ErrorAlert title={DOCS.detail.historyErrorTitle}>
            <p>{error.message}</p>
            <button type="button" className="btn btn-ghost btn-sm docs-retry" onClick={onRetry}>
              {DOCS.screen.retryRead}
            </button>
          </ErrorAlert>
        </div>
      )}
      {versions !== null && error && (
        <p className="hint">{DOCS.detail.staleHistory(error.message)}</p>
      )}
      {versions !== null && (
        <ol className="ver-list" aria-label={DOCS.detail.historyLabel(doc.name)}>
          {versions.map((v) => (
            <VersionRow key={v.id} doc={doc} v={v} actions={actions} canRestore={canRestore} now={now} />
          ))}
        </ol>
      )}
    </section>
  );
}
