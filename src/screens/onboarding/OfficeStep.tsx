import { IconAlertTriangle } from "@tabler/icons-react";
import { useId, useRef, useState, type FormEvent } from "react";
import { toAppError, type AppError } from "../../api";
import { JOIN_NOTE_MAX_CHARS, joinApi, type FoundOffice, type OutgoingJoinRequest } from "../../api/join";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import { StepHeading } from "./StepHeading";
import { NOTE_COUNT_FROM, OFFICE_STEP } from "./texts";

// Isian formulir yang disimpan Onboarding saat orangnya kembali ke langkah nama,
// supaya pilihan kantor, departemen, keterangan, dan centang sidik tidak hilang.
export type OfficeDraft = {
  officeKey: string | null;
  teamId: string;
  note: string;
  confirmedKey: string | null;
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
  draft?: OfficeDraft | null;
  onEditName: (draft: OfficeDraft) => void;
  onSent: (request: OutgoingJoinRequest) => void;
  onOther: () => void;
};

type Errors = { office: string | null; team: string | null; note: string | null; server: AppError | null };
const NO_ERRORS: Errors = { office: null, team: null, note: null, server: null };

// (b) Kantor ditemukan, dalam satu formulir: nama (ringkasan), kantor,
// departemen, keterangan untuk admin, lalu kirim permintaan.
export function OfficeStep({ offices, displayName, draft, onEditName, onSent, onOther }: Props) {
  const single = offices.length === 1;
  const [officeKey, setOfficeKey] = useState<string | null>(
    draft && offices.some((o) => o.key === draft.officeKey) ? draft.officeKey : single ? offices[0].key : null,
  );
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

  function pickOffice(key: string) {
    setOfficeKey(key);
    setTeamId("");
    setConfirmedKey(null);
    setErrors(NO_ERRORS);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (sending) return;
    if (!office) {
      setErrors({ ...NO_ERRORS, office: "Pilih kantor Anda dulu." });
      firstRadioRef.current?.focus();
      return;
    }
    if (blocked) return;
    if (!teamId) {
      setErrors({ ...NO_ERRORS, team: "Pilih departemen Anda dulu." });
      teamRef.current?.focus();
      return;
    }
    const trimmedNote = acceptsNote ? note.trim() : "";
    if (noteHasForbiddenChars(trimmedNote)) {
      setErrors({ ...NO_ERRORS, note: OFFICE_STEP.noteForbidden });
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
      );
      onSent(request);
    } catch (err) {
      setSending(false);
      setErrors({ ...NO_ERRORS, server: toAppError(err) });
    }
  }

  const heading = single ? `Kantor ditemukan: ${offices[0].name}` : "Beberapa kantor ditemukan";

  return (
    <form className="onb-form" onSubmit={submit} noValidate aria-busy={sending || undefined}>
      <StepHeading>{heading}</StepHeading>
      {single ? (
        <p className="hint onb-sub">Kantor ini memakai Mira di jaringan yang sama dengan laptop Anda.</p>
      ) : (
        <p className="onb-lead">
          Ada {offices.length} kantor yang memakai Mira di jaringan ini. Pilih kantor Anda. Kalau ragu, tanyakan sidik
          organisasinya ke admin kantor.
        </p>
      )}

      <p className="onb-summary">
        <span className="onb-summary-text">
          {OFFICE_STEP.nameSummary} <strong>{displayName}</strong>
        </span>
        <button
          type="button"
          className="link-btn onb-summary-btn"
          aria-label={OFFICE_STEP.editNameLabel}
          onClick={() => onEditName({ officeKey, teamId, note, confirmedKey })}
          disabled={sending}
        >
          {OFFICE_STEP.editName}
        </button>
      </p>

      {twins && (
        <div className="notice">
          <IconAlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>Ada dua kantor dengan nama atau identitas yang sama</strong>
            <p>
              Salah satunya bisa jadi tiruan. Telepon admin kantor dan cocokkan sidik organisasi di layar ini dengan
              sidik di menu Organisasi miliknya sebelum meminta bergabung.
            </p>
          </div>
        </div>
      )}

      {single ? (
        <p className="onb-fp">
          Sidik organisasi <span className="mono onb-fp-code">{offices[0].fingerprint}</span>
        </p>
      ) : (
        <fieldset className="onb-offices" aria-describedby={ids.officeErr}>
          <legend>Kantor</legend>
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
                  Sidik organisasi <span className="mono">{o.fingerprint}</span>
                </span>
                {o.conflict && (
                  <span className="onb-office-warn">Identitasnya bentrok dengan kantor lain. Cocokkan sidiknya dulu.</span>
                )}
                {!o.conflict && o.sameName && <span className="onb-office-warn">Namanya sama dengan kantor lain.</span>}
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
          <strong>Kantor ini belum punya departemen</strong>
          <p>
            Setiap orang masuk ke satu departemen. Minta admin kantor membuat departemen dulu di menu Organisasi, lalu cari
            lagi.
          </p>
        </div>
      ) : (
        <div className="field">
          <label htmlFor={ids.team}>Departemen</label>
          <select
            ref={teamRef}
            id={ids.team}
            name="team"
            required
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
            aria-invalid={errors.team ? true : undefined}
            aria-describedby={`${ids.teamHint} ${ids.teamErr}`}
            disabled={sending || !office}
          >
            <option value="">{office ? "Pilih departemen" : "Pilih kantor dulu"}</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <p id={ids.teamHint} className="hint">
            Daftar ini dibuat admin kantor. Pilihan departemen tidak bisa Anda ubah sendiri nanti.
          </p>
          <div id={ids.teamErr} aria-live="polite">
            {errors.team && <FieldError text={errors.team} />}
          </div>
        </div>
      )}

      {acceptsNote && (
        <div className="field">
          <label htmlFor={ids.note}>{OFFICE_STEP.noteLabel}</label>
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
              {OFFICE_STEP.noteHint}
            </p>
            {/* Selalu ada di halaman supaya pembaca layar mengumumkan hitungannya. */}
            <p id={ids.noteCount} className="hint" aria-live="polite">
              {noteLength >= NOTE_COUNT_FROM ? OFFICE_STEP.noteCount(noteLength) : null}
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
            Ada kantor lain dengan identitas yang sama. Telepon admin kantor dan minta ia membacakan sidik organisasi di
            menu Organisasi miliknya. Kirim permintaan hanya kalau sidiknya sama dengan{" "}
            <span className="mono">{office.fingerprint}</span>.
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
              Sidik dari admin kantor sama dengan <span className="mono">{office.fingerprint}</span>
            </span>
          </label>
        </div>
      )}

      <p id={ids.shared} className="hint">
        {acceptsNote ? OFFICE_STEP.sharedWithNote : OFFICE_STEP.shared}
      </p>

      <div aria-live="polite">
        {errors.server && (
          <ErrorAlert title="Permintaan belum terkirim">
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
          {sending ? OFFICE_STEP.sending : OFFICE_STEP.submit}
        </button>
      </div>
      <p className="hint onb-other">
        Bukan kantor Anda?{" "}
        <button type="button" className="link-btn" onClick={onOther} disabled={sending}>
          Cari dengan cara lain
        </button>
      </p>
    </form>
  );
}
