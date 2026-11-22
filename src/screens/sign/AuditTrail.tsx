import { IconAlertTriangle, IconChevronRight, IconCircleCheck } from "@tabler/icons-react";
import type { EventKind, EventView } from "../../api/signing";
import { formatSignedAt } from "./stamp";

const EVENT_LABELS: Record<EventKind, string> = {
  created: "Permintaan dibuat",
  signed: "Menandatangani",
  completed: "Semua selesai, dokumen dikunci",
  cancelled: "Permintaan dibatalkan",
  exported: "Salinan disimpan",
  signature_saved: "Tanda tangan tersimpan dibuat",
  signature_deleted: "Tanda tangan tersimpan dihapus",
};

export function eventLabel(kind: string): string {
  return EVENT_LABELS[kind as EventKind] ?? `Catatan lain (${kind})`;
}

// Waktu dari inti Rust seharusnya selalu sah; kalau tidak, tampilkan apa adanya.
export function safeSignedAt(at: string): string {
  try {
    return formatSignedAt(at);
  } catch {
    return at;
  }
}

function ShortHash({ label, hash }: { label: string; hash: string }) {
  return (
    <span className="audit-hash">
      {label}{" "}
      <span className="mono" title={hash}>
        {hash.slice(0, 12)}
      </span>
    </span>
  );
}

type Props = { events: EventView[] };

// Jejak audit permintaan: siapa melakukan apa, kapan, dan hash file sebelum
// dan sesudahnya. Setiap catatan ditandatangani kunci laptop pelakunya.
export function AuditTrail({ events }: Props) {
  const sorted = events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const ta = Date.parse(a.e.at);
      const tb = Date.parse(b.e.at);
      if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
      return a.i - b.i;
    })
    .map(({ e }) => e);
  const invalid = sorted.filter((e) => !e.valid).length;

  return (
    <details className="audit" open={invalid > 0 || undefined}>
      <summary className="audit-summary">
        <IconChevronRight size={16} className="audit-chevron" aria-hidden="true" />
        <span>Jejak audit</span>
        <span className="audit-count">
          {sorted.length} catatan
          {invalid > 0 && <span className="audit-count-bad">, {invalid} tidak cocok</span>}
        </span>
      </summary>
      {sorted.length === 0 ? (
        <p className="audit-empty">Belum ada catatan untuk permintaan ini.</p>
      ) : (
        <ol className="audit-list">
          {sorted.map((e, i) => (
            <li key={`${e.at}-${e.kind}-${i}`} className="audit-item" data-valid={e.valid}>
              <p className="audit-what">
                <strong>{eventLabel(e.kind)}</strong>
                <span className="audit-who">{e.actorName || "Tanpa nama"}</span>
              </p>
              <p className="audit-when">{safeSignedAt(e.at)}</p>
              {e.detail && <p className="audit-detail">{e.detail}</p>}
              {(e.hashBefore || e.hashAfter) && (
                <p className="audit-hashes">
                  {e.hashBefore && <ShortHash label="Sebelum" hash={e.hashBefore} />}
                  {e.hashAfter && <ShortHash label="Sesudah" hash={e.hashAfter} />}
                </p>
              )}
              {e.valid ? (
                <p className="audit-valid">
                  <IconCircleCheck size={15} aria-hidden="true" />
                  Catatan sah
                </p>
              ) : (
                <p className="audit-invalid">
                  <IconAlertTriangle size={15} aria-hidden="true" />
                  Tanda tangan catatan tidak cocok. Catatan ini mungkin diubah di luar Mira.
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
