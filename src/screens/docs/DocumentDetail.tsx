import { IconAlertTriangle, IconClockHour4, IconDownload } from "@tabler/icons-react";
import { useEffect, useRef } from "react";
import { relativeTime } from "../../api/format";
import type { AppError } from "../../api";
import type { DocumentDetail as Detail, DocumentSummary, DocumentVersion } from "../../api/documents";
import { ErrorAlert } from "../../components/ErrorAlert";
import { initials } from "../../components/initials";
import { isBlocked, isBusy, keys, type DocActions } from "./actions";
import { KindIcon } from "./KindIcon";
import {
  appName,
  downloadLabel,
  editable,
  fetchState,
  fetchText,
  formatSize,
  originText,
  person,
  versionList,
} from "./text";

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
  focusToken,
  now,
}: {
  doc: DocumentSummary;
  actions: DocActions;
  focusToken: number;
  now: Date;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusToken === 0) return;
    titleRef.current?.focus();
    titleRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [focusToken]);

  const heads = doc.conflictVersions;
  const app = appName(doc.kind);
  const canMerge = editable(doc.kind) && doc.can.edit;
  const count = heads.length === 2 ? "Dua" : String(heads.length);
  return (
    <div className="conflict" role="group" aria-labelledby={`conflict-title-${doc.id}`}>
      <h3 id={`conflict-title-${doc.id}`} className="conflict-title" tabIndex={-1} ref={titleRef}>
        <IconAlertTriangle size={18} aria-hidden="true" />
        {count} versi tersimpan berdampingan
      </h3>
      <p>
        {capitalize(versionList(heads))} dibuat terpisah, misalnya saat salah satu laptop tidak tersambung, jadi
        Mira menyimpan semuanya. Pilih versi yang dipakai{canMerge ? ", atau gabungkan isinya sendiri" : ""}.
      </p>
      <ul className="conflict-heads">
        {heads.map((v) => (
          <li key={v.id} className="head-card">
            {/* Nama pembuat di judul kartu: bentrok dengan rekan langsung terbaca siapa membuat apa. */}
            <p className="head-num">
              Versi {v.number} dari {person(v.author)}
            </p>
            <p className="head-meta">
              {originText(v, doc.kind)} · {relativeTime(v.createdAt, now)}
            </p>
            {v.available ? (
              <HeadActions doc={doc} v={v} actions={actions} canMerge={canMerge} />
            ) : (
              <div className="head-actions">
                <FetchStatus doc={doc} v={v} actions={actions} />
                {doc.can.resolve && <p className="head-meta">Versi ini bisa dipilih setelah isinya ada di laptop ini.</p>}
              </div>
            )}
          </li>
        ))}
      </ul>
      {canMerge && doc.can.resolve && (
        <p className="conflict-note">
          Gabung manual membuka versi itu di {app}. Salin bagian yang perlu dari versi lain, lalu simpan. Begitu
          Anda menyimpan, bentrok selesai.
        </p>
      )}
      {!doc.can.resolve && (
        <p className="conflict-note">Anda tidak punya izin memilih versi. Minta rekan yang bisa mengedit file ini untuk memilihnya.</p>
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
            ariaLabel={`Unduh versi ${v.number} dari rekan, ${formatSize(v.size)}`}
            busyLabel="Mengunduh..."
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
          label="Pakai versi ini"
          ariaLabel={`Pakai versi ini (versi ${v.number})`}
          busyLabel="Menyimpan pilihan..."
          primary
          onClick={() => actions.resolve(doc, v)}
        />
      )}
      {canMerge && (
        <ActionButton
          pendingKey={keys.edit(doc.id, v.id)}
          actions={actions}
          label="Gabung manual"
          ariaLabel={`Gabung manual dari versi ${v.number}`}
          busyLabel="Membuka..."
          onClick={() => actions.edit(doc, v)}
        />
      )}
      <ActionButton
        pendingKey={keys.open(doc.id, v.id)}
        actions={actions}
        label="Buka"
        ariaLabel={`Buka versi ${v.number}`}
        busyLabel="Membuka..."
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
          Versi {v.number}
          {isCurrent && <span className="chip chip-on">Sekarang</span>}
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
              label="Buka"
              ariaLabel={`Buka versi ${v.number}`}
              busyLabel="Membuka..."
              onClick={() => actions.open(doc, v)}
            />
            {doc.can.export && (
              <ActionButton
                pendingKey={keys.export(doc.id, v.id)}
                actions={actions}
                label="Simpan salinan"
                ariaLabel={`Simpan salinan versi ${v.number}`}
                busyLabel="Menyimpan..."
                onClick={() => actions.exportCopy(doc, v)}
              />
            )}
            {/* Kepala bentrok dipilih lewat "Pakai versi ini", bukan Pulihkan. */}
            {canRestore && !isCurrent && !v.isHead && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label={`Pulihkan versi ${v.number}`}
                aria-disabled={actions.pending !== null || undefined}
                onClick={() => actions.askRestore(doc, v)}
              >
                Pulihkan
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
  const historyRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusVersions === 0) return;
    historyRef.current?.focus();
    historyRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [focusVersions]);
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
            {doc.versionCount} versi · {formatSize(doc.current.size)}
          </p>
        </div>
      </header>

      {doc.conflict && doc.conflictVersions.length > 1 && (
        <ConflictBox doc={doc} actions={actions} focusToken={focusConflict} now={now} />
      )}

      <h3 className="detail-label" tabIndex={-1} ref={historyRef}>
        Riwayat versi
      </h3>
      {editingHere && doc.can.restore && (
        <p className="hint">Versi lama bisa dipulihkan setelah Anda menekan Selesai mengedit.</p>
      )}
      {versions === null && loading && (
        <p className="hint" role="status">
          Memuat riwayat versi...
        </p>
      )}
      {versions === null && !loading && error && (
        <div role="alert">
          <ErrorAlert title="Riwayat versi belum terbaca">
            <p>{error.message}</p>
            <button type="button" className="btn btn-ghost btn-sm docs-retry" onClick={onRetry}>
              Coba baca lagi
            </button>
          </ErrorAlert>
        </div>
      )}
      {versions !== null && error && (
        <p className="hint">Riwayat terbaru belum bisa dibaca ({error.message}). Yang tampil adalah data terakhir.</p>
      )}
      {versions !== null && (
        <ol className="ver-list" aria-label={`Riwayat versi ${doc.name}`}>
          {versions.map((v) => (
            <VersionRow key={v.id} doc={doc} v={v} actions={actions} canRestore={canRestore} now={now} />
          ))}
        </ol>
      )}
    </section>
  );
}
