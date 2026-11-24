import {
  IconAlertTriangle,
  IconCircleCheck,
  IconInfoCircle,
  IconPlugConnectedX,
  IconRefresh,
  IconUserOff,
  IconUserQuestion,
} from "@tabler/icons-react";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { orgApi, type AdCheck, type AdCheckStatus, type JoinAdView, type JoinRequestView } from "../../api/org";
import { AD_TEXT } from "../../i18n/org-ad";

const T = AD_TEXT.card;

const STATUSES: readonly AdCheckStatus[] = [
  "match",
  "mismatch",
  "disabled",
  "not_found",
  "unreachable",
  "other_domain",
  "not_domain_machine",
];

// Galat command atau jawaban yang tidak dikenali dibaca sama dengan "AD tidak bisa dihubungi".
function unreachable(): AdCheck {
  return {
    status: "unreachable",
    mismatches: [],
    directoryName: null,
    directoryDepartment: null,
    departmentInMira: true,
    checkedAt: new Date().toISOString(),
  };
}

function statusText(status: AdCheckStatus, domain: string): string {
  switch (status) {
    case "match":
      return T.status.match;
    case "mismatch":
      return T.status.mismatch;
    case "disabled":
      return T.status.disabled;
    case "not_found":
      return T.status.notFound;
    case "other_domain":
      return T.status.otherDomain(domain);
    case "not_domain_machine":
      return T.status.notDomainMachine;
    default:
      return T.status.unreachable;
  }
}

// Ikon pendukung; teks status tetap pembeda utamanya.
function statusIcon(status: AdCheckStatus): ReactNode {
  const props = { size: 18, "aria-hidden": true } as const;
  switch (status) {
    case "match":
      return <IconCircleCheck {...props} />;
    case "mismatch":
      return <IconAlertTriangle {...props} />;
    case "disabled":
      return <IconUserOff {...props} />;
    case "not_found":
      return <IconUserQuestion {...props} />;
    case "unreachable":
      return <IconPlugConnectedX {...props} />;
    default:
      return <IconInfoCircle {...props} />;
  }
}

// match: hijau; ketidakcocokan dan akun bermasalah: merah; laptop ini tidak bisa memeriksa: netral.
function tone(status: AdCheckStatus): "ok" | "bad" | "neutral" {
  if (status === "match") return "ok";
  if (status === "mismatch" || status === "disabled" || status === "not_found") return "bad";
  return "neutral";
}

function adDepartment(ad: JoinAdView): string {
  const dept = ad.department?.trim();
  if (!dept) return T.notSent;
  return ad.departmentInMira ? dept : T.departmentMissing(dept);
}

// Peringatan di kartu: kantor memakai pengaturan AD dan Mira peminta terlalu lama,
// jadi Setujui akan ditolak inti Rust. Tombol tetap aktif; galatnya tampil seperti biasa.
export function OutdatedNotice({ name }: { name: string }) {
  return (
    <div className="notice req-outdated" data-testid="join-requester-outdated">
      <IconAlertTriangle size={18} aria-hidden="true" />
      <div>
        <strong>{T.outdatedTitle}</strong>
        <p>{T.outdatedBody(name)}</p>
      </div>
    </div>
  );
}

// Blok "Active Directory" di kartu permintaan: data AD yang dilaporkan peminta,
// lalu hasil cek ulang dari laptop ini. Cek dipanggil sekali saat kartu tampil
// (bukan polling); "Periksa lagi" memaksa cek baru.
export function JoinAdBlock({ request }: { request: JoinRequestView & { ad: JoinAdView } }) {
  const ad = request.ad;
  const headingId = useId();
  const [check, setCheck] = useState<AdCheck | null>(null);
  const [checking, setChecking] = useState(true);
  const mounted = useRef(true);
  const seq = useRef(0);
  // Permintaan yang sudah diperiksa, supaya effect yang dijalankan ulang
  // (StrictMode, muat ulang daftar) tidak memanggil cek lagi.
  const started = useRef<string | null>(null);

  const run = useCallback(
    async (refresh: boolean) => {
      const mine = ++seq.current;
      setChecking(true);
      let result: AdCheck;
      try {
        const answer = await orgApi.joinAdCheck(request.id, refresh);
        result = answer && STATUSES.includes(answer.status) ? answer : unreachable();
      } catch {
        result = unreachable();
      }
      if (!mounted.current || mine !== seq.current) return;
      setCheck(result);
      setChecking(false);
    },
    [request.id],
  );

  useEffect(() => {
    mounted.current = true;
    if (started.current !== request.id) {
      started.current = request.id;
      void run(false);
    }
    return () => {
      mounted.current = false;
    };
  }, [request.id, run]);

  const status = check?.status ?? null;
  const ous = ad.ous.filter((o) => o.trim() !== "");

  return (
    <section className="req-ad" aria-labelledby={headingId} data-testid="join-ad">
      <div className="req-ad-head">
        <h4 id={headingId} className="req-ad-title">
          {T.title}
        </h4>
        <p className="hint">{T.reported}</p>
      </div>

      <dl className="req-facts">
        <div>
          <dt>{T.account}</dt>
          <dd className="mono">{`${ad.domain}\\${ad.user}`}</dd>
        </div>
        <div>
          <dt>{T.name}</dt>
          <dd>{ad.name?.trim() || T.notSent}</dd>
        </div>
        <div>
          <dt>{T.department}</dt>
          <dd>{adDepartment(ad)}</dd>
        </div>
        <div>
          <dt>{T.ous}</dt>
          <dd>
            {ous.length > 0 ? (
              <ol className="req-ad-ous">
                {ous.map((ou, i) => (
                  <li key={`${i}-${ou}`}>{ou}</li>
                ))}
              </ol>
            ) : (
              T.notSent
            )}
          </dd>
        </div>
      </dl>

      <div className="req-ad-check">
        <div className="req-ad-status-row">
          {/* Hanya kalimat status yang dibacakan, sekali saat berubah. */}
          <div
            className={`req-ad-status req-ad-${status && !checking ? tone(status) : "neutral"}`}
            aria-live="polite"
            aria-atomic="true"
            data-testid="join-ad-status"
            data-status={checking || !status ? "checking" : status}
          >
            {checking || !status ? (
              <span>{T.checking}</span>
            ) : (
              <>
                {statusIcon(status)}
                <span>{statusText(status, ad.domain)}</span>
              </>
            )}
          </div>
          {/* aria-disabled, bukan disabled: fokus keyboard tetap di tombol selama cek berjalan. */}
          <button
            type="button"
            className="btn btn-ghost btn-sm req-ad-recheck"
            aria-disabled={checking || undefined}
            aria-label={T.recheckAria(request.displayName)}
            onClick={() => {
              if (!checking) void run(true);
            }}
          >
            <IconRefresh size={16} aria-hidden="true" />
            {T.recheck}
          </button>
        </div>

        {check && !checking && check.mismatches.length > 0 && (
          <ul className="req-ad-diff">
            {check.mismatches.map((m, i) => (
              <li key={`${m.field}-${i}`}>
                {m.field === "name"
                  ? T.mismatchName(m.directory, m.requested)
                  : T.mismatchDepartment(m.directory, m.requested)}
              </li>
            ))}
          </ul>
        )}

        {check && !checking && !check.departmentInMira && check.directoryDepartment && (
          <p className="req-ad-note">{T.checkDepartmentMissing(check.directoryDepartment)}</p>
        )}

        <p className="hint">{T.limit}</p>
      </div>
    </section>
  );
}
