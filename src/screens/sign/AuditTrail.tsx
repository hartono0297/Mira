import { IconAlertTriangle, IconChevronRight, IconCircleCheck } from "@tabler/icons-react";
import type { EventView } from "../../api/signing";
import { eventLabel, formatWhen, happenedDuringRequest, isSignatureChange, shortHash } from "./labels";

// Sidik file: 16 karakter awal, hash lengkap di title.
export function HashText({ hash }: { hash: string }) {
  return (
    <span className="mono" title={hash}>
      {shortHash(hash)}
    </span>
  );
}

type Props = { events: EventView[]; requestCreatedAt: string };

// Jejak audit permintaan: siapa melakukan apa, kapan, dan sidik file sebelum
// dan sesudahnya. Setiap catatan ditandatangani kunci laptop pelakunya.
export function AuditTrail({ events, requestCreatedAt }: Props) {
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
  const warned = (e: EventView) => isSignatureChange(e.kind) && happenedDuringRequest(e, events, requestCreatedAt);
  const warnings = sorted.filter(warned).length;

  return (
    <details className="audit" open={invalid > 0 || warnings > 0 || undefined}>
      <summary className="audit-summary">
        <IconChevronRight size={16} className="audit-chevron" aria-hidden="true" />
        <span>Jejak audit</span>
        <span className="audit-count">
          {sorted.length} catatan
          {invalid > 0 && <span className="audit-count-bad">, {invalid} tidak cocok</span>}
          {warnings > 0 && <span className="audit-count-warn">, {warnings} perlu diperhatikan</span>}
        </span>
      </summary>
      {sorted.length === 0 ? (
        <p className="audit-empty">Belum ada catatan untuk permintaan ini.</p>
      ) : (
        <ol className="audit-list">
          {sorted.map((e, i) => (
            <li key={`${e.at}-${e.kind}-${i}`} className="audit-item" data-valid={e.valid} data-warn={warned(e) || undefined}>
              <p className="audit-what">
                <strong>{eventLabel(e.kind)}</strong>
                <span className="audit-who">{e.actorName || "Tanpa nama"}</span>
              </p>
              <p className="audit-when">{formatWhen(e.at)}</p>
              {e.detail && <p className="audit-detail">{e.detail}</p>}
              {warned(e) && (
                <p className="audit-warn">
                  <IconAlertTriangle size={15} aria-hidden="true" />
                  Terjadi saat permintaan ini berjalan. Pastikan pemilik tanda tangan memang melakukannya sendiri.
                </p>
              )}
              {(e.hashBefore || e.hashAfter) && (
                <p className="audit-hashes">
                  {e.hashBefore && (
                    <span className="audit-hash">
                      Sidik file sebelum <HashText hash={e.hashBefore} />
                    </span>
                  )}
                  {e.hashAfter && (
                    <span className="audit-hash">
                      {e.hashBefore ? "Sidik file sesudah" : "Sidik file"} <HashText hash={e.hashAfter} />
                    </span>
                  )}
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
