import { IconAlertTriangle, IconInfoCircle } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { formatDate } from "../../api/format";
import { orgApi, type OtherOfficesView } from "../../api/org";
import { AD_TEXT } from "../../i18n/org-ad";

const T = AD_TEXT.otherOffices;
const MAX_NAMES = 5;

function count(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function text(s: unknown): string | null {
  return typeof s === "string" && s.trim() !== "" ? s.trim() : null;
}

function olderOffice(v: unknown): OtherOfficesView["olderSameDomain"] {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const name = text(o.name);
  const createdAt = text(o.createdAt);
  const fingerprint = text(o.fingerprint);
  return name && createdAt && fingerprint ? { name, createdAt, fingerprint } : null;
}

function valid(v: unknown): OtherOfficesView | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Partial<OtherOfficesView>;
  return {
    laptops: count(o.laptops),
    offices: count(o.offices),
    sameDomainLaptops: count(o.sameDomainLaptops),
    names: Array.isArray(o.names) ? o.names.map(text).filter((n): n is string => n !== null) : [],
    olderSameDomain: olderOffice(o.olderSameDomain),
  };
}

// Petunjuk di halaman Organisasi: ada laptop di jaringan yang tergabung di kantor
// Mira lain (docs/plans/onboarding-ad.md bagian 6 butir 3). Anggota biasa (termasuk
// Tamu) hanya melihat jumlah laptop. Superadmin juga melihat nama kantor dan
// apakah domain AD-nya sama, dan superadmin kantor yang lebih baru untuk domain
// yang sama mendapat peringatan kantor utama (bagian 6.1 butir 3). Dimuat sekali saat halaman dibuka; galat diabaikan,
// karena ini hanya pelengkap. Tidak ada tombol: Mira tidak menyatukan kantor.
export function OtherOfficesNotice({ superadmin }: { superadmin: boolean }) {
  const [view, setView] = useState<OtherOfficesView | null>(null);

  useEffect(() => {
    let alive = true;
    orgApi
      .otherOffices()
      .then((v) => {
        if (alive) setView(valid(v));
      })
      .catch(() => {
        // Diam: halaman tetap bisa dipakai tanpa petunjuk ini.
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!view) return null;

  const older = superadmin ? view.olderSameDomain : null;
  if (older) {
    // .notice (perlu tindakan, bukan error): superadmin yang memutuskan.
    return (
      <div className="org-pad org-narrow">
        <div className="notice org-older" data-testid="org-older-office">
          <IconAlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>{T.older.title}</strong>
            <p>{T.older.office(older.name, formatDate(older.createdAt))}</p>
            <p>
              {T.older.fingerprint} <span className="mono org-fp">{older.fingerprint}</span>
            </p>
            <p>{T.older.body}</p>
          </div>
        </div>
      </div>
    );
  }

  if (view.laptops === 0) return null;

  const shown = superadmin ? view.names.slice(0, MAX_NAMES).join(", ") : "";
  const rest = view.names.length - MAX_NAMES;
  const same = superadmin ? Math.min(view.sameDomainLaptops, view.laptops) : 0;

  // Domain AD sama: pemberitahuan yang perlu tindakan (aksen). Selain itu kotak
  // netral, karena kantor lain di jaringan yang sama bisa wajar.
  return (
    <div className="org-pad org-narrow">
      <div
        className={same > 0 ? "notice" : "org-other"}
        data-testid="org-other-offices"
        data-same-domain={same > 0 ? "true" : undefined}
      >
        {same > 0 ? (
          <IconAlertTriangle size={18} aria-hidden="true" />
        ) : (
          <IconInfoCircle size={18} aria-hidden="true" />
        )}
        <div>
          <strong>{T.title(view.laptops)}</strong>
          {shown && <p>{T.names(rest > 0 ? `${shown}${T.more(rest)}` : shown)}</p>}
          {same > 0 && <p>{T.sameDomain(same)}</p>}
          <p>{T.hint}</p>
        </div>
      </div>
    </div>
  );
}
