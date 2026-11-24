import {
  IconAlertTriangle,
  IconCheck,
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
import { JoinAdMatchOu } from "./JoinAdMatchOu";

const T = AD_TEXT.card;

const STATUSES: readonly AdCheckStatus[] = [
  "match",
  "exists",
  "mismatch",
  "disabled",
  "not_found",
  "unreachable",
  "other_domain",
  "not_domain_machine",
];

// Status yang datang dari entri direktori, jadi nama, departemen, dan lokasi
// direktori bisa ditampilkan. Status lain berarti akunnya tidak terbaca dari laptop ini.
const FROM_DIRECTORY: readonly AdCheckStatus[] = ["match", "exists", "mismatch", "disabled"];

type ClaimField = "claim_name" | "claim_department" | "location";
const CLAIM_FIELDS: readonly ClaimField[] = ["claim_name", "claim_department", "location"];

type Tone = "ok" | "bad" | "warn" | "neutral";

// Galat command atau jawaban yang tidak dikenali dibaca sama dengan "AD tidak bisa dihubungi".
function unreachable(): AdCheck {
  return {
    status: "unreachable",
    mismatches: [],
    directoryName: null,
    directoryOus: [],
    directoryDepartment: null,
    departmentInMira: true,
    checkedAt: new Date().toISOString(),
  };
}

function normalize(answer: AdCheck | null | undefined): AdCheck {
  if (!answer || !STATUSES.includes(answer.status)) return unreachable();
  return {
    ...answer,
    mismatches: Array.isArray(answer.mismatches) ? answer.mismatches : [],
    directoryOus: Array.isArray(answer.directoryOus) ? answer.directoryOus : [],
  };
}

function claimMismatches(check: AdCheck): ClaimField[] {
  return CLAIM_FIELDS.filter((f) => check.mismatches.some((m) => m.field === f));
}

// OU disimpan dari yang paling dalam; dibaca orang dari luar ke dalam, seperti di layar peminta.
function ouLocation(ous: string[]): string {
  return ous
    .map((o) => o.trim())
    .filter((o) => o !== "")
    .reverse()
    .join(" › ");
}

function claimFieldName(f: ClaimField): string {
  if (f === "claim_name") return T.claimFields.name;
  if (f === "claim_department") return T.claimFields.department;
  return T.claimFields.location;
}

function statusText(check: AdCheck, domain: string): string {
  switch (check.status) {
    case "match":
      return T.status.match;
    case "exists":
      return T.status.exists;
    case "mismatch": {
      const claims = claimMismatches(check);
      return claims.length > 0 ? T.status.claimMismatch(claims.map(claimFieldName).join(", ")) : T.status.mismatch;
    }
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

// match: hijau. Akun dinonaktifkan atau tidak ada: merah. Laptop peminta
// melaporkan data AD yang tidak sama dengan direktori: peringatan (--state),
// karena itu tanda klaim palsu. Perbedaan nama tampilan atau departemen pilihan
// peminta netral (peminta boleh mengubahnya), begitu juga akun yang ada tanpa
// pembanding dan laptop ini yang tidak bisa memeriksa.
function toneOf(check: AdCheck): Tone {
  if (check.status === "match") return "ok";
  if (check.status === "disabled" || check.status === "not_found") return "bad";
  if (check.status === "mismatch" && claimMismatches(check).length > 0) return "warn";
  return "neutral";
}

// data-status untuk tes ujung ke ujung: ketidakcocokan klaim dibedakan dari
// perbedaan nama atau departemen biasa.
function dataStatus(check: AdCheck): string {
  return check.status === "mismatch" && claimMismatches(check).length > 0 ? "claim_mismatch" : check.status;
}

// Ikon pendukung; teks status tetap pembeda utamanya.
function statusIcon(check: AdCheck): ReactNode {
  const props = { size: 18, "aria-hidden": true } as const;
  switch (toneOf(check) === "warn" ? "warn" : check.status) {
    case "match":
      return <IconCircleCheck {...props} />;
    case "warn":
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

function withDeptNote(dept: string, inMira: boolean): string {
  return inMira ? dept : T.departmentMissing(dept);
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

// Satu fakta AD: nilai utama, dan nilai laporan peminta sebagai pembanding kalau berbeda.
function Fact({ label, value, claim }: { label: string; value: string; claim?: string | null }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {value}
        {claim != null && (
          <span className="req-ad-claim" data-testid="join-ad-claim">
            {T.claimValue(claim)}
          </span>
        )}
      </dd>
    </div>
  );
}

// Untuk superadmin: "Cocokkan OU ini ke departemen..." saat departemen AD peminta
// belum ada di Mira. onMatched dipanggil setelah pemetaan tersimpan (muat ulang daftar).
export type MatchOuProps = { onSetupDomain?: () => void; onMatched: () => void };

// Blok "Active Directory" di kartu permintaan. Sebelum cek selesai atau kalau cek
// gagal, yang tampil adalah laporan laptop peminta, dengan label yang mengatakannya.
// Setelah cek berhasil, yang ditonjolkan adalah nilai dari direktori; laporan
// peminta hanya tampil sebagai pembanding kalau berbeda. Cek dipanggil sekali
// saat kartu tampil (bukan polling); "Periksa lagi" memaksa cek baru.
export function JoinAdBlock({
  request,
  match,
}: {
  request: JoinRequestView & { ad: JoinAdView };
  match?: MatchOuProps;
}) {
  const ad = request.ad;
  const headingId = useId();
  const [check, setCheck] = useState<AdCheck | null>(null);
  const [checking, setChecking] = useState(true);
  // Hasil yang dibacakan pembaca layar. Cek pertama saat kartu muncul tidak
  // dibacakan (N kartu akan jadi 2N pengumuman); hanya hasil "Periksa lagi".
  const [announced, setAnnounced] = useState<AdCheck | null>(null);
  const mounted = useRef(true);
  const seq = useRef(0);
  // Permintaan yang sudah diperiksa, supaya effect yang dijalankan ulang
  // (StrictMode, muat ulang daftar) tidak memanggil cek lagi.
  const started = useRef<string | null>(null);
  // Hasil "Cocokkan OU" terakhir, tampil di kartu dan menerima fokus.
  const [matched, setMatched] = useState<string | null>(null);
  const matchedRef = useRef<HTMLParagraphElement>(null);

  const run = useCallback(
    async (refresh: boolean) => {
      const mine = ++seq.current;
      setChecking(true);
      if (refresh) setAnnounced(null);
      let result: AdCheck;
      try {
        result = normalize(await orgApi.joinAdCheck(request.id, refresh));
      } catch {
        result = unreachable();
      }
      if (!mounted.current || mine !== seq.current) return;
      setCheck(result);
      setChecking(false);
      if (refresh) setAnnounced(result);
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

  const done = !checking && check !== null ? check : null;
  const verified = done !== null && FROM_DIRECTORY.includes(done.status) ? done : null;
  const claims = verified ? claimMismatches(verified) : [];
  const nameDiffers = !!done && done.mismatches.some((m) => m.field === "name");
  const requestDiffs = done ? done.mismatches.filter((m) => m.field === "name" || m.field === "department") : [];

  // Departemen AD belum ada di Mira: OU dari direktori kalau cek berhasil, kalau
  // tidak dari laporan peminta (pemetaan hanya mengarahkan usulan departemen).
  const inMira = verified ? verified.departmentInMira : ad.departmentInMira;
  const matchOus = (verified ? verified.directoryOus : ad.ous).map((o) => o.trim()).filter((o) => o !== "");
  const showMatch = !!match && !inMira && matchOus.length > 0 && matched === null;

  useEffect(() => {
    if (matched !== null) matchedRef.current?.focus();
  }, [matched]);

  const claimName = ad.name?.trim() || T.notSent;
  const claimDept = ad.department?.trim() || null;
  const claimLocation = ouLocation(ad.ous) || T.notSent;

  return (
    <section className="req-ad" aria-labelledby={headingId} data-testid="join-ad">
      <div className="req-ad-head">
        <h4 id={headingId} className="req-ad-title">
          {T.title}
        </h4>
        <p className="req-ad-source" data-testid="join-ad-source" data-source={verified ? "directory" : "claim"}>
          {verified ? T.verified : T.reported}
        </p>
      </div>

      {ad.usedBy && (
        <div className="alert req-ad-used" data-testid="join-ad-used-by">
          <IconAlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>{T.usedByTitle(ad.usedBy)}</strong>
            <p>{T.usedByBody}</p>
          </div>
        </div>
      )}

      <dl className="req-facts" data-testid="join-ad-facts" data-source={verified ? "directory" : "claim"}>
        <div>
          <dt>{T.account}</dt>
          <dd className="mono">{`${ad.user}@${ad.domain}`}</dd>
        </div>
        {verified ? (
          <>
            <Fact
              label={T.name}
              value={verified.directoryName?.trim() || T.emptyInDirectory}
              claim={claims.includes("claim_name") ? claimName : null}
            />
            <Fact
              label={T.department}
              value={
                verified.directoryDepartment?.trim()
                  ? withDeptNote(verified.directoryDepartment.trim(), verified.departmentInMira)
                  : T.emptyInDirectory
              }
              claim={claims.includes("claim_department") ? (claimDept ?? T.notSent) : null}
            />
            <Fact
              label={T.ous}
              value={ouLocation(verified.directoryOus) || T.emptyInDirectory}
              claim={claims.includes("location") ? claimLocation : null}
            />
          </>
        ) : (
          <>
            <Fact label={T.name} value={claimName} />
            <Fact label={T.department} value={claimDept ? withDeptNote(claimDept, ad.departmentInMira) : T.notSent} />
            <Fact label={T.ous} value={claimLocation} />
          </>
        )}
      </dl>

      <div className="req-ad-check">
        <div className="req-ad-status-row">
          <div
            className={`req-ad-status req-ad-${done ? toneOf(done) : "neutral"}`}
            data-testid="join-ad-status"
            data-status={done ? dataStatus(done) : "checking"}
          >
            {done ? (
              <>
                {statusIcon(done)}
                <span>{statusText(done, ad.domain)}</span>
              </>
            ) : (
              <span>{T.checking}</span>
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

        <p className="req-ad-limit">{T.limit}</p>

        {requestDiffs.length > 0 && (
          <ul className="req-ad-diff">
            {requestDiffs.map((m, i) => (
              <li key={`${m.field}-${i}`}>
                {m.field === "name"
                  ? T.mismatchName(m.directory, m.requested)
                  : T.mismatchDepartment(m.directory, m.requested)}
              </li>
            ))}
          </ul>
        )}

        {nameDiffers && <p className="req-ad-note">{T.nameNote}</p>}

        {showMatch && match && (
          <JoinAdMatchOu
            request={request}
            ous={matchOus}
            onSetupDomain={match.onSetupDomain}
            onMatched={(text) => {
              setMatched(text);
              match.onMatched();
              void run(true);
            }}
          />
        )}

        {matched !== null && (
          <p className="ok-line req-ad-matched" tabIndex={-1} ref={matchedRef} data-testid="join-ad-matched">
            <IconCheck size={16} aria-hidden="true" />
            <span>{matched}</span>
          </p>
        )}

        {/* Wilayah pengumuman terpisah dari teks yang terlihat: kosong sampai "Periksa lagi". */}
        <span className="sr-only" aria-live="polite" aria-atomic="true" data-testid="join-ad-live">
          {announced ? statusText(announced, ad.domain) : ""}
        </span>
      </div>
    </section>
  );
}
