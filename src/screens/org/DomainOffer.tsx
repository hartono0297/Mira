import { IconInfoCircle } from "@tabler/icons-react";
import { useEffect, useId, useRef, useState } from "react";
import { toAppError, type AppError } from "../../api";
import { orgApi, type AdSettingsView } from "../../api/org";
import { ErrorAlert } from "../../components/ErrorAlert";
import { AD_TEXT } from "../../i18n/org-ad";
import { normalizeAdDomain } from "../onboarding/adProfile";
import { useOrgLive } from "./useOrgLive";

const T = AD_TEXT.domainOffer;
const S = AD_TEXT.settings;

// "Sembunyikan" diingat per organisasi di laptop ini. localStorage bisa tidak tersedia
// (mode privat, penyimpanan diblokir): tawaran tetap jalan, hanya tidak diingat.
export function offerKey(orgId: string): string {
  return `mira.adDomainOffer.hidden.${orgId}`;
}

function readHidden(orgId: string): boolean {
  try {
    return window.localStorage.getItem(offerKey(orgId)) === "1";
  } catch {
    return false;
  }
}

function writeHidden(orgId: string, hidden: boolean) {
  try {
    if (hidden) window.localStorage.setItem(offerKey(orgId), "1");
    else window.localStorage.removeItem(offerKey(orgId));
  } catch {
    // Tidak diingat; tawaran muncul lagi saat halaman dibuka berikutnya.
  }
}

function valid(v: unknown): AdSettingsView | null {
  if (!v || typeof v !== "object") return null;
  const o = v as AdSettingsView;
  return {
    ...o,
    ouMap: Array.isArray(o.ouMap) ? o.ouMap : [],
    outdated: Array.isArray(o.outdated) ? o.outdated : [],
  };
}

// Domain laptop ini yang bisa ditawarkan: kantor belum punya domain AD, laptop
// ini superadmin (canEdit) dan tergabung di domain yang sah. null: tidak ada tawaran.
export function offeredDomain(view: AdSettingsView | null): string | null {
  if (!view || !view.canEdit || view.domain?.trim()) return null;
  const machine = view.machineDomain?.trim();
  return machine ? normalizeAdDomain(machine) : null;
}

type Props = {
  orgId: string;
  version: number;
  // Naik saat kartu permintaan meminta domain diatur: tawaran tampil lagi walau
  // tadi disembunyikan, dan judulnya mendapat fokus.
  reveal: number;
  onAvailable: (available: boolean) => void;
  onSaved: (domain: string) => void;
  onHidden: () => void;
};

// Tawaran tenang di atas halaman Organisasi (superadmin, docs/plans/perbaikan-bergabung.md):
// kantor belum punya domain AD dan laptop ini tergabung di domain. Satu klik menyimpan
// domain itu dengan pemetaan OU yang sudah ada. Kalau gerbang versi tertutup,
// tombolnya tidak ada dan laptop yang belum diperbarui disebutkan.
export function DomainOffer({ orgId, version, reveal, onAvailable, onSaved, onHidden }: Props) {
  const live = useOrgLive(() => orgApi.adSettings(), { version });
  const data = valid(live.data);
  const domain = offeredDomain(data);
  const [hidden, setHidden] = useState(() => readHidden(orgId));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const focusTitle = useRef(false);
  const titleId = useId();

  const available = domain !== null && !saved;
  useEffect(() => {
    onAvailable(available);
  }, [available, onAvailable]);

  useEffect(() => {
    if (reveal === 0) return;
    writeHidden(orgId, false);
    setHidden(false);
    focusTitle.current = true;
  }, [reveal, orgId]);

  // Domain kantor sudah terisi setelah simpan: kalau suatu saat dikosongkan lagi,
  // tawaran boleh muncul lagi.
  useEffect(() => {
    if (data?.domain?.trim()) setSaved(false);
  }, [data?.domain]);

  useEffect(() => {
    if (focusTitle.current && titleRef.current) {
      focusTitle.current = false;
      titleRef.current.focus();
    }
  });

  if (!data || !domain || hidden || saved) return null;

  async function use(d: string, view: AdSettingsView) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await orgApi.setAdSettings(d, view.ouMap);
      setSaved(true);
      onSaved(d);
      void live.reload();
    } catch (err) {
      setError(toAppError(err));
    } finally {
      setSaving(false);
    }
  }

  function later() {
    writeHidden(orgId, true);
    setHidden(true);
    onHidden();
  }

  return (
    <div className="org-pad org-narrow">
      <section className="org-other org-offer" aria-labelledby={titleId} data-testid="org-domain-offer">
        <IconInfoCircle size={18} aria-hidden="true" />
        <div>
          <h2 id={titleId} className="org-offer-title" tabIndex={-1} ref={titleRef}>
            {T.title(domain)}
          </h2>
          <p>{T.body(domain)}</p>
          {!data.allowed && (
            <>
              <p>{T.blocked(domain)}</p>
              <ul className="org-offer-outdated" data-testid="org-domain-offer-blocked">
                {data.outdated.map((o, i) => (
                  <li key={`${i}-${o.name}`}>
                    {o.appVersion ? S.outdatedVersion(o.name, o.appVersion) : S.outdatedUnknown(o.name)}
                  </li>
                ))}
              </ul>
            </>
          )}
          {error && (
            <div className="org-offer-error">
              <ErrorAlert title={T.saveFail}>
                <p>{error.message}</p>
              </ErrorAlert>
            </div>
          )}
          <div className="org-offer-actions">
            {data.allowed && (
              <button
                type="button"
                className="btn"
                aria-busy={saving || undefined}
                disabled={saving}
                onClick={() => void use(domain, data)}
              >
                {saving ? T.saving : T.use(domain)}
              </button>
            )}
            <button type="button" className="btn btn-ghost" disabled={saving} onClick={later}>
              {T.later}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
