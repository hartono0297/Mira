// Satu domain, satu kantor (docs/plans/onboarding-ad.md bagian 6): kantor
// versi lama yang terlihat, dan peringatan sebelum membuat kantor kedua.
import { IconAlertTriangle } from "@tabler/icons-react";
import { useId, useRef, useState, type FormEvent } from "react";
import type { FoundOffice, LegacyOffice } from "../../api/join";
import { FieldError } from "../../components/FieldError";
import { sameDomain } from "./adProfile";
import { ADMIN_IT, LEGACY } from "./texts";

// Kantor yang pernah terlihat di sesi ini.
export type SeenOffices = { offices: FoundOffice[]; legacy: LegacyOffice[]; orgSeen: boolean };

export const NO_SEEN: SeenOffices = { offices: [], legacy: [], orgSeen: false };

export function mergeSeen(
  seen: SeenOffices,
  next: { offices?: FoundOffice[]; legacy?: LegacyOffice[]; orgSeen?: boolean },
): SeenOffices {
  const offices = new Map(seen.offices.map((o) => [o.key, o]));
  for (const o of next.offices ?? []) offices.set(o.key, o);
  const legacy = new Map(seen.legacy.map((l) => [l.orgId, l]));
  for (const l of next.legacy ?? []) if (l && typeof l.orgId === "string") legacy.set(l.orgId, l);
  return { offices: [...offices.values()], legacy: [...legacy.values()], orgSeen: seen.orgSeen || next.orgSeen === true };
}

export function anySeen(seen: SeenOffices): boolean {
  return seen.orgSeen || seen.offices.length > 0 || seen.legacy.length > 0;
}

// Kantor versi lama yang belum menjawab sebagai kantor biasa.
export function legacyOnly(seen: SeenOffices): LegacyOffice[] {
  const known = new Set(seen.offices.map((o) => o.orgId));
  return seen.legacy.filter((l) => !known.has(l.orgId));
}

function legacyName(l: LegacyOffice): string {
  return l.name?.trim() || LEGACY.unnamed;
}

function officeNames(offices: FoundOffice[], legacy: LegacyOffice[] = []): string {
  const names = [...offices.map((o) => o.name), ...legacy.map(legacyName)];
  return [...new Set(names)].join(", ");
}

// Kantor dengan Mira 0.1 atau 0.2: terlihat, tapi belum bisa menerima permintaan.
export function LegacyOffices({ legacy }: { legacy: LegacyOffice[] }) {
  if (legacy.length === 0) return null;
  return (
    <div className="onb-note" data-testid="onb-legacy-offices">
      <strong>{LEGACY.title}</strong>
      <ul className="onb-list">
        {legacy.map((l) => (
          <li key={l.orgId}>{LEGACY.item(legacyName(l), l.peerCount)}</li>
        ))}
      </ul>
      <p>{LEGACY.body}</p>
      <ol className="onb-steps">
        <li>{LEGACY.update}</li>
        <li>{LEGACY.invite}</li>
      </ol>
    </div>
  );
}

type GuardProps = {
  seen: SeenOffices;
  // Domain AD laptop ini (profil akun atau domain PC), null kalau tidak ada.
  laptopDomain: string | null;
  onJoin: (offices: FoundOffice[]) => void;
  onConfirmed: () => void;
  disabled?: boolean;
};

function normalizePhrase(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

// Sebelum kantor baru, kalau kantor Mira lain sudah terlihat. Domain AD laptop
// sama dengan domain kantor yang terlihat: tanpa pilihan kantor baru sama sekali.
export function SecondOfficeGuard({ seen, laptopDomain, onJoin, onConfirmed, disabled = false }: GuardProps) {
  const T = ADMIN_IT;
  const [phrase, setPhrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const ids = { input: useId(), err: useId() };
  const matching = laptopDomain ? seen.offices.filter((o) => sameDomain(o.adDomain, laptopDomain)) : [];

  if (laptopDomain && matching.length > 0) {
    return (
      <div className="onb-guard" data-testid="onb-same-domain">
        <p>{T.sameDomain(laptopDomain, officeNames(matching))}</p>
        <div>
          <button type="button" className="btn" onClick={() => onJoin(matching)} disabled={disabled}>
            {T.joinSeen}
          </button>
        </div>
      </div>
    );
  }

  function confirm(e: FormEvent) {
    e.preventDefault();
    if (normalizePhrase(phrase) !== normalizePhrase(T.confirmPhrase)) {
      setError(T.confirmMismatch(T.confirmPhrase));
      inputRef.current?.focus();
      return;
    }
    setError(null);
    onConfirmed();
  }

  const names = officeNames(seen.offices, legacyOnly(seen));

  return (
    <div className="onb-guard" data-testid="onb-second-office">
      <div className="notice">
        <IconAlertTriangle size={18} aria-hidden="true" />
        <div>
          <strong>{T.seenTitle}</strong>
          <p>{names ? T.seenNamed(names) : T.seenUnnamed}</p>
        </div>
      </div>
      {seen.offices.length > 0 && (
        <div>
          <button type="button" className="btn" onClick={() => onJoin(seen.offices)} disabled={disabled}>
            {T.joinSeen}
          </button>
        </div>
      )}
      <form className="onb-guard-form" onSubmit={confirm} noValidate>
        <div className="field">
          <label htmlFor={ids.input}>{T.confirmLabel(T.confirmPhrase)}</label>
          <input
            ref={inputRef}
            id={ids.input}
            name="newOfficeConfirm"
            autoComplete="off"
            spellCheck={false}
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={ids.err}
            disabled={disabled}
          />
          <div id={ids.err} aria-live="polite">
            {error && <FieldError text={error} />}
          </div>
        </div>
        <div>
          <button type="submit" className="btn btn-ghost" disabled={disabled}>
            {T.confirmButton}
          </button>
        </div>
      </form>
    </div>
  );
}
