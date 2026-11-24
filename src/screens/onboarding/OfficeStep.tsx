import { IconAlertTriangle } from "@tabler/icons-react";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { toAppError, type AppError } from "../../api";
import {
  JOIN_NOTE_MAX_CHARS,
  joinApi,
  type AdDeptSuggestion,
  type FoundOffice,
  type LegacyOffice,
  type LocalAd,
  type OutgoingJoinRequest,
} from "../../api/join";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import {
  adLine,
  adUse,
  asSuggestion,
  outdatedCount,
  ouPath,
  sameDomain,
  type AdLine,
  type SuggestState,
} from "./adProfile";
import { LegacyOffices } from "./OfficeGuard";
import { StepHeading } from "./StepHeading";
import { NOTE_COUNT_FROM, OFFICE_STEP } from "./texts";

// Isian formulir yang disimpan Onboarding saat orangnya kembali ke langkah nama,
// supaya pilihan kantor, departemen, keterangan, dan centang sidik tidak hilang.
export type OfficeDraft = {
  officeKey: string | null;
  teamId: string;
  note: string;
  confirmedKey: string | null;
  // Daftar kantor sedang dibuka lewat Ubah (kantor dari domain AD).
  picking?: boolean;
};

// Karakter yang ditolak inti Rust (identity::has_forbidden_chars): kontrol,
// bidi, dan karakter tak terlihat. Ditambah karakter yang tampil kosong
// (pengisi Hangul, Braille kosong, penggabung grafem), pemilih varian, dan tag.
const FORBIDDEN_CHARS =
  /[\p{Cc}\u00AD\u034F\u061C\u115F\u1160\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\u2800\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/u;
// Lebih dari dua tanda gabung berturut-turut bisa menumpuk dan menutupi baris lain.
const COMBINING_RUN = /[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]{3,}/u;

export function noteHasForbiddenChars(note: string): boolean {
  return FORBIDDEN_CHARS.test(note) || COMBINING_RUN.test(note);
}

type Props = {
  offices: FoundOffice[];
  // Nama tampilan dari langkah 1, sudah tersimpan.
  displayName: string;
  // Akun domain Windows laptop ini (onboarding-ad), null kalau tidak ada.
  ad?: LocalAd | null;
  // Kantor versi lama di jaringan yang sama: terlihat, tapi tidak bisa dipilih.
  legacy?: LegacyOffice[];
  draft?: OfficeDraft | null;
  onEditName: (draft: OfficeDraft) => void;
  onSent: (request: OutgoingJoinRequest) => void;
  onOther: () => void;
};

type Errors = { office: string | null; team: string | null; note: string | null; server: AppError | null };
const NO_ERRORS: Errors = { office: null, team: null, note: null, server: null };

// (b) Kantor ditemukan, dalam satu formulir: nama (ringkasan), kantor,
// departemen, keterangan untuk admin, lalu kirim permintaan.
export function OfficeStep({
  offices: found,
  displayName,
  ad = null,
  legacy = [],
  draft,
  onEditName,
  onSent,
  onOther,
}: Props) {
  const T = OFFICE_STEP;
  // Kantor dengan domain AD yang sama dengan laptop ini tampil paling atas,
  // yang dibuat paling awal (kantor utama untuk domain itu) paling depan.
  const offices = useMemo(() => {
    if (!ad) return found;
    const mine = found
      .filter((o) => sameDomain(o.adDomain, ad.domain))
      .sort((a, b) => createdMs(a) - createdMs(b));
    return mine.length ? [...mine, ...found.filter((o) => !mine.includes(o))] : found;
  }, [found, ad]);
  const isMine = (o: FoundOffice) => ad !== null && sameDomain(o.adDomain, ad.domain);
  const mineCount = offices.filter(isMine).length;
  // Kantor dengan domain sama: yang paling awal terpilih bawaan.
  const mineKey = mineCount > 0 ? offices[0].key : null;
  const single = offices.length === 1;
  // Tepat satu kantor dengan domain sama: langsung dipakai tanpa daftar kantor.
  // Ubah membuka daftarnya.
  const [picking, setPicking] = useState(draft?.picking === true);
  const [officeKey, setOfficeKey] = useState<string | null>(
    draft && offices.some((o) => o.key === draft.officeKey)
      ? draft.officeKey
      : single
        ? offices[0].key
        : mineKey,
  );
  // Orangnya sudah memilih kantor atau departemen sendiri: pilihan dari AD tidak menimpanya.
  const officePicked = useRef(Boolean(draft?.officeKey));
  const teamPicked = useRef(Boolean(draft?.teamId));
  const [teamId, setTeamId] = useState(draft?.teamId ?? "");
  const [note, setNote] = useState(draft?.note ?? "");
  const [errors, setErrors] = useState<Errors>(NO_ERRORS);
  const [sending, setSending] = useState(false);
  // Kantor yang bentrok (id sama, sidik beda) baru bisa dikirimi setelah orangnya
  // mencocokkan sidik dengan admin kantor lewat telepon atau datang ke mejanya.
  const [confirmedKey, setConfirmedKey] = useState<string | null>(draft?.confirmedKey ?? null);
  const teamRef = useRef<HTMLSelectElement>(null);
  const noteRef = useRef<HTMLInputElement>(null);
  const firstRadioRef = useRef<HTMLInputElement>(null);
  const ids = {
    officeErr: useId(),
    team: useId(),
    teamHint: useId(),
    teamErr: useId(),
    note: useId(),
    noteHint: useId(),
    noteCount: useId(),
    noteErr: useId(),
    shared: useId(),
    blocked: useId(),
    confirm: useId(),
    empty: useId(),
    adDept: useId(),
  };

  const office = offices.find((o) => o.key === officeKey) ?? null;
  const departments = office && Array.isArray(office.departments) ? office.departments : [];
  const twins = offices.some((o) => o.sameName || o.conflict);
  const confirmed = office !== null && confirmedKey === office.key;
  const blocked = office !== null && ((office.conflict && !confirmed) || departments.length === 0);
  // Kantor dengan laptop anggota v0.3 menolak permintaan yang membawa keterangan.
  const acceptsNote = office?.acceptsNote === true;
  // Panjang UTF-16, sama dengan cara maxLength menghitung, supaya hitungan dan
  // batas isian selalu cocok. Satu emoji terhitung dua.
  const noteLength = note.length;

  // Data AD ikut permintaan hanya kalau domain kantor sama dan kantor menerimanya.
  const adState = adUse(ad, office);
  const adApplies = adState.kind === "use";
  // Jawaban join_ad_suggest per kantor; value null berarti inti Rust tidak punya usulan.
  const [suggestion, setSuggestion] = useState<{ key: string; value: AdDeptSuggestion | null } | null>(null);
  const suggestState: SuggestState =
    adApplies && office && suggestion?.key === office.key ? { kind: "done", value: suggestion.value } : { kind: "pending" };

  // Profil AD bisa tiba setelah formulir tampil.
  useEffect(() => {
    if (officePicked.current || !mineKey) return;
    setOfficeKey((current) => current ?? mineKey);
  }, [mineKey]);

  // Departemen usulan dari AD. Dipilih otomatis kalau orangnya belum memilih.
  // Tidak pernah membuat departemen: usulan di luar daftar kantor diabaikan.
  useEffect(() => {
    if (!adApplies || !office) return;
    let alive = true;
    const key = office.key;
    const known = Array.isArray(office.departments) ? office.departments : [];
    joinApi
      .adSuggest(key)
      .then((raw) => {
        const value = asSuggestion(raw);
        if (!alive) return;
        setSuggestion({ key, value });
        const suggested = value?.teamId;
        if (value?.inMira && suggested && !teamPicked.current && known.some((d) => d.id === suggested)) {
          setTeamId((current) => (current === "" ? suggested : current));
        }
      })
      .catch(() => {
        // Tanpa jawaban, orangnya memilih departemen sendiri seperti biasa,
        // tanpa baris alasan (belum tentu departemennya tidak cocok).
      });
    return () => {
      alive = false;
    };
  }, [adApplies, office]);

  function openPicker() {
    setPicking(true);
    window.setTimeout(() => firstRadioRef.current?.focus(), 0);
  }

  function pickOffice(key: string) {
    officePicked.current = true;
    teamPicked.current = false;
    setOfficeKey(key);
    setTeamId("");
    setConfirmedKey(null);
    setErrors(NO_ERRORS);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (sending) return;
    if (!office) {
      setErrors({ ...NO_ERRORS, office: T.pickOffice });
      firstRadioRef.current?.focus();
      return;
    }
    if (blocked) return;
    if (!teamId) {
      setErrors({ ...NO_ERRORS, team: T.pickTeam });
      teamRef.current?.focus();
      return;
    }
    const trimmedNote = acceptsNote ? note.trim() : "";
    if (noteHasForbiddenChars(trimmedNote)) {
      setErrors({ ...NO_ERRORS, note: T.noteForbidden });
      noteRef.current?.focus();
      return;
    }
    setErrors(NO_ERRORS);
    setSending(true);
    try {
      const request = await joinApi.sendRequest(
        office.key,
        teamId,
        office.conflict ? office.fingerprint : null,
        trimmedNote ? trimmedNote : null,
        adApplies,
      );
      onSent(request);
    } catch (err) {
      setSending(false);
      setErrors({ ...NO_ERRORS, server: toAppError(err) });
    }
  }

  // Kantor dari domain AD dipakai langsung, tampil sebagai ringkasan.
  const autoOffice =
    ad !== null && mineCount === 1 && office !== null && isMine(office) && (single || !picking) ? office : null;
  const one = single || autoOffice !== null;
  const heading = autoOffice ? T.headingMine : one ? T.headingOne(offices[0].name) : T.headingMany;
  const draftNow = (): OfficeDraft => ({ officeKey, teamId, note, confirmedKey, picking });
  // Satu baris AD di bawah pilihan departemen: dari mana departemennya, atau
  // kenapa data akun Windows tidak dipakai.
  const line = office ? adLine(ad, office, suggestState, departments) : null;
  const lineText = line && office && ad ? adLineText(line, office, ad) : null;
  // Baris diisi setelah tampil, di wilayah aria-live yang sudah ada, supaya
  // pembaca layar mengumumkannya sekali (juga kalau alasannya sudah ada saat
  // langkah ini muncul), dan tidak lagi selama teksnya sama. Fokus tidak berpindah.
  const [liveText, setLiveText] = useState<string | null>(null);
  useEffect(() => setLiveText(lineText), [lineText]);
  const deptCaption = line && lineText !== null && lineText === liveText ? { line, text: lineText } : null;
  const location = adApplies && ad ? ouPath(ad.dn) : null;

  return (
    <form className="onb-form" onSubmit={submit} noValidate aria-busy={sending || undefined}>
      <StepHeading>{heading}</StepHeading>
      {one ? (
        <p className="hint onb-sub">{T.subOne}</p>
      ) : (
        <p className="onb-lead">{T.leadMany(offices.length)}</p>
      )}

      <p className="onb-summary">
        <span className="onb-summary-text">
          {T.nameSummary} <strong>{displayName}</strong>
        </span>
        <button
          type="button"
          className="link-btn onb-summary-btn"
          aria-label={T.editNameLabel}
          onClick={() => onEditName(draftNow())}
          disabled={sending}
        >
          {T.editName}
        </button>
      </p>
      {autoOffice && ad && (
        <p className="onb-summary" data-testid="onb-ad-office-summary">
          <span className="onb-summary-text">
            {T.ad.officeSummary} <strong>{T.ad.officeWithDomain(autoOffice.name, ad.domain)}</strong>
          </span>
          {!single && (
            <button
              type="button"
              className="link-btn onb-summary-btn"
              aria-label={T.ad.changeOfficeLabel}
              onClick={openPicker}
              disabled={sending}
            >
              {T.ad.changeOffice}
            </button>
          )}
        </p>
      )}

      {twins && (
        <div className="notice">
          <IconAlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>{T.twinsTitle}</strong>
            <p>{T.twinsBody}</p>
          </div>
        </div>
      )}

      {one ? (
        <p className="onb-fp">
          {T.fingerprint} <span className="mono onb-fp-code">{(autoOffice ?? offices[0]).fingerprint}</span>
        </p>
      ) : (
        <fieldset className="onb-offices" aria-describedby={ids.officeErr}>
          <legend>{T.offices}</legend>
          {offices.map((o, i) => (
            <label key={o.key} className="onb-office">
              <input
                ref={i === 0 ? firstRadioRef : undefined}
                type="radio"
                name="office"
                value={o.key}
                checked={officeKey === o.key}
                onChange={() => pickOffice(o.key)}
                disabled={sending}
              />
              <span className="onb-office-body">
                <span className="onb-office-name">{o.name}</span>
                <span className="onb-office-fp">
                  {T.fingerprint} <span className="mono">{o.fingerprint}</span>
                </span>
                {ad && isMine(o) && mineCount === 1 && (
                  <span className="onb-office-ad" data-testid="onb-ad-office-match">
                    {T.ad.officeMatch(ad.domain)}
                  </span>
                )}
                {ad && isMine(o) && mineCount > 1 && o.key === mineKey && (
                  <span className="onb-office-ad" data-testid="onb-ad-office-primary">
                    {T.ad.primary(ad.domain)}
                  </span>
                )}
                {ad && isMine(o) && mineCount > 1 && o.key !== mineKey && (
                  <span className="onb-office-warn" data-testid="onb-ad-office-later">
                    {T.ad.laterSameDomain}
                  </span>
                )}
                {o.conflict && (
                  <span className="onb-office-warn">{T.conflict}</span>
                )}
                {!o.conflict && o.sameName && <span className="onb-office-warn">{T.sameName}</span>}
              </span>
            </label>
          ))}
          <div id={ids.officeErr} aria-live="polite">
            {errors.office && <FieldError text={errors.office} />}
          </div>
        </fieldset>
      )}

      {office && departments.length === 0 ? (
        <div className="onb-note" id={ids.empty}>
          <strong>{T.noDeptTitle}</strong>
          <p>{T.noDeptBody}</p>
        </div>
      ) : (
        <div className="field">
          <label htmlFor={ids.team}>{T.team}</label>
          <select
            ref={teamRef}
            id={ids.team}
            name="team"
            required
            value={teamId}
            onChange={(e) => {
              teamPicked.current = true;
              setTeamId(e.target.value);
            }}
            aria-invalid={errors.team ? true : undefined}
            aria-describedby={`${deptCaption ? `${ids.adDept} ` : ""}${ids.teamHint} ${ids.teamErr}`}
            disabled={sending || !office}
          >
            <option value="">{office ? T.teamPlaceholder : T.teamPickOfficeFirst}</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <div aria-live="polite">
            {deptCaption && (
              <p
                id={ids.adDept}
                className="hint"
                data-testid={deptCaption.line.kind === "matched" ? "onb-ad-dept" : "onb-ad-skipped"}
                data-reason={deptCaption.line.kind === "skip" ? deptCaption.line.reason : deptCaption.line.kind}
              >
                {deptCaption.text}
              </p>
            )}
          </div>
          <p id={ids.teamHint} className="hint">
            {T.teamHint}
          </p>
          <div id={ids.teamErr} aria-live="polite">
            {errors.team && <FieldError text={errors.team} />}
          </div>
        </div>
      )}

      {acceptsNote && (
        <div className="field">
          <label htmlFor={ids.note}>{T.noteLabel}</label>
          <input
            ref={noteRef}
            id={ids.note}
            name="note"
            autoComplete="off"
            maxLength={JOIN_NOTE_MAX_CHARS}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-invalid={errors.note ? true : undefined}
            aria-describedby={`${ids.noteHint} ${ids.noteCount} ${ids.noteErr}`}
            disabled={sending}
          />
          <div>
            <p id={ids.noteHint} className="hint">
              {T.noteHint}
            </p>
            {/* Selalu ada di halaman supaya pembaca layar mengumumkan hitungannya. */}
            <p id={ids.noteCount} className="hint" aria-live="polite">
              {noteLength >= NOTE_COUNT_FROM ? T.noteCount(noteLength) : null}
            </p>
          </div>
          <div id={ids.noteErr} aria-live="polite">
            {errors.note && <FieldError text={errors.note} />}
          </div>
        </div>
      )}

      {office?.conflict && (
        <div className="onb-blocked" id={ids.blocked}>
          <p>
            {T.conflictBody} <span className="mono">{office.fingerprint}</span>.
          </p>
          <label className="onb-confirm" htmlFor={ids.confirm}>
            <input
              id={ids.confirm}
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmedKey(e.target.checked ? office.key : null)}
              disabled={sending}
            />
            <span>
              {T.conflictConfirm} <span className="mono">{office.fingerprint}</span>
            </span>
          </label>
        </div>
      )}

      {adApplies && ad && (
        <div className="onb-box" data-testid="onb-ad-box">
          <p className="onb-label">{T.ad.boxTitle}</p>
          <dl className="onb-kv">
            <dt>{T.ad.name}</dt>
            <dd>{displayName}</dd>
            <dt>{T.ad.team}</dt>
            <dd>{departments.find((d) => d.id === teamId)?.name ?? T.ad.teamNone}</dd>
            <dt>{T.ad.account}</dt>
            <dd className="mono">{`${ad.user}@${ad.domain}`}</dd>
            {location && (
              <>
                <dt>{T.ad.location}</dt>
                <dd>{location}</dd>
              </>
            )}
            {acceptsNote && note.trim() && (
              <>
                <dt>{T.ad.note}</dt>
                <dd>{note.trim()}</dd>
              </>
            )}
          </dl>
          {!ad.complete && (
            <p className="onb-box-foot" data-testid="onb-ad-partial">
              {T.ad.partial}
            </p>
          )}
          <p className="onb-box-foot" data-testid="onb-ad-stored">
            {T.ad.stored}
          </p>
        </div>
      )}

      <p id={ids.shared} className="hint">
        {acceptsNote ? T.sharedWithNote : T.shared}
      </p>

      <div aria-live="polite">
        {errors.server && (
          <ErrorAlert title={T.sendFailed}>
            <p>{errors.server.message}</p>
          </ErrorAlert>
        )}
      </div>

      <div className="onb-actions">
        <button
          type="submit"
          className="btn"
          disabled={sending || blocked}
          aria-busy={sending || undefined}
          aria-describedby={blocked ? `${office?.conflict ? ids.blocked : ids.empty} ${ids.shared}` : ids.shared}
        >
          {sending ? T.sending : T.submit}
        </button>
      </div>
      <LegacyOffices legacy={legacy} />
      <p className="hint onb-other">
        {T.notYours}{" "}
        <button type="button" className="link-btn" onClick={onOther} disabled={sending}>
          {T.otherWay}
        </button>
      </p>
    </form>
  );
}

// Waktu dibuat kantor untuk mengurutkan; tanpa tanggal yang terbaca: paling akhir.
function createdMs(o: FoundOffice): number {
  const t = typeof o.createdAt === "string" ? Date.parse(o.createdAt) : NaN;
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

// Teks baris AD di bawah pilihan departemen.
function adLineText(line: AdLine, office: FoundOffice, ad: LocalAd): string {
  const T = OFFICE_STEP.ad;
  switch (line.kind) {
    case "matched":
      return T.deptFromAccount(line.dept);
    case "unmatched":
      return T.deptUnmatched(line.dept);
    case "noDept":
      return T.deptNone;
    case "skip":
      switch (line.reason) {
        case "outdated": {
          const n = outdatedCount(office);
          return n === null ? T.skip.outdated : T.skip.outdatedCount(n);
        }
        case "noDomain":
          return T.skip.noDomain;
        case "otherDomain":
          return T.skip.otherDomain(office.adDomain ?? "", ad.domain);
        case "noUser":
          return T.skip.noUser;
      }
  }
}
