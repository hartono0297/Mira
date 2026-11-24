import { IconAlertTriangle, IconChevronRight, IconCircleCheck } from "@tabler/icons-react";
import type { EventView } from "../../api/signing";
import { eventLabel, formatWhen, happenedDuringRequest, isSignatureChange, shortHash } from "./labels";
import { SIGN_DIALOGS } from "../../i18n/sign-dialogs";

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
  const T = SIGN_DIALOGS.audit;

  return (
    <details className="audit" open={invalid > 0 || warnings > 0 || undefined}>
      <summary className="audit-summary">
        <IconChevronRight size={16} className="audit-chevron" aria-hidden="true" />
        <span>{T.title}</span>
        <span className="audit-count">
          {T.count(sorted.length)}
          {invalid > 0 && <span className="audit-count-bad">{T.invalid(invalid)}</span>}
          {warnings > 0 && <span className="audit-count-warn">{T.warnings(warnings)}</span>}
        </span>
      </summary>
      {sorted.length === 0 ? (
        <p className="audit-empty">{T.empty}</p>
      ) : (
        <ol className="audit-list">
          {sorted.map((e, i) => (
            <li key={`${e.at}-${e.kind}-${i}`} className="audit-item" data-valid={e.valid} data-warn={warned(e) || undefined}>
              <p className="audit-what">
                <strong>{eventLabel(e.kind)}</strong>
                <span className="audit-who">{e.actorName || T.noName}</span>
              </p>
              <p className="audit-when">{formatWhen(e.at)}</p>
              {e.detail && <p className="audit-detail">{e.detail}</p>}
              {warned(e) && (
                <p className="audit-warn">
                  <IconAlertTriangle size={15} aria-hidden="true" />
                  {T.duringRequest}
                </p>
              )}
              {(e.hashBefore || e.hashAfter) && (
                <p className="audit-hashes">
                  {e.hashBefore && (
                    <span className="audit-hash">
                      {T.hashBefore} <HashText hash={e.hashBefore} />
                    </span>
                  )}
                  {e.hashAfter && (
                    <span className="audit-hash">
                      {e.hashBefore ? T.hashAfter : T.hash} <HashText hash={e.hashAfter} />
                    </span>
                  )}
                </p>
              )}
              {e.valid ? (
                <p className="audit-valid">
                  <IconCircleCheck size={15} aria-hidden="true" />
                  {T.valid}
                </p>
              ) : (
                <p className="audit-invalid">
                  <IconAlertTriangle size={15} aria-hidden="true" />
                  {T.invalidRecord}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
