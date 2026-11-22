import { IconAlertTriangle } from "@tabler/icons-react";
import { useEffect, useRef } from "react";
import { relativeTime } from "../../api/format";
import type { AppError } from "../../api";
import type { DocumentDetail as Detail, DocumentSummary, DocumentVersion } from "../../api/documents";
import { ErrorAlert } from "../../components/ErrorAlert";
import { initials } from "../../components/initials";
import { keys, type DocActions } from "./actions";
import { KindIcon } from "./KindIcon";
import { appName, editable, formatSize, originText, person, versionList } from "./text";

type Props = {
  summary: DocumentSummary;
  detail: Detail | null;
  loading: boolean;
  error: AppError | null;
  onRetry: () => void;
  actions: DocActions;
  // Berubah setiap kali tombol "Selesaikan bentrok" di daftar ditekan.
  focusConflict: number;
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
  const busy = actions.pending === pendingKey;
  return (
    <button
      type="button"
      className={`btn btn-sm${primary ? "" : " btn-ghost"}`}
      aria-label={busy ? busyLabel : ariaLabel}
      disabled={busy}
      aria-busy={busy || undefined}
      onClick={onClick}
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
            <p className="head-num">Versi {v.number}</p>
            <p className="head-meta">{originText(v, doc.kind)}</p>
            <p className="head-meta">
              {person(v.author)} · {relativeTime(v.createdAt, now)}
            </p>
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
              {v.available && (
                <ActionButton
                  pendingKey={keys.open(doc.id, v.id)}
                  actions={actions}
                  label="Buka"
                  ariaLabel={`Buka versi ${v.number}`}
                  busyLabel="Membuka..."
                  onClick={() => actions.open(doc, v)}
                />
              )}
            </div>
          </li>
        ))}
      </ul>
      {canMerge && doc.can.resolve && (
        <p className="conflict-note">
          Gabung manual membuka versi itu di {app}. Salin bagian yang perlu dari versi lain, lalu simpan. Simpanan
          pertama menyelesaikan bentrok.
        </p>
      )}
      {!doc.can.resolve && (
        <p className="conflict-note">Anda tidak punya izin memilih versi. Minta anggota tim yang mengelola file ini.</p>
      )}
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
                onClick={() => actions.askRestore(doc, v)}
              >
                Pulihkan
              </button>
            )}
          </div>
        ) : (
          <p className="ver-meta">Isi versi ini belum ada di laptop ini.</p>
        )}
      </div>
    </li>
  );
}

export function DocumentDetail({ summary, detail, loading, error, onRetry, actions, focusConflict, now }: Props) {
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

      <h3 className="detail-label">Riwayat versi</h3>
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
