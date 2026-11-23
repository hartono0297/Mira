import { IconAlertTriangle } from "@tabler/icons-react";
import { useId, useRef, useState, type FormEvent } from "react";
import { toAppError, type AppError } from "../../api";
import { JOIN_NOTE_MAX_CHARS, joinApi, type FoundOffice, type OutgoingJoinRequest } from "../../api/join";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import { StepHeading } from "./StepHeading";
import { NOTE_COUNT_FROM, OFFICE_STEP } from "./texts";

type Props = {
  offices: FoundOffice[];
  // Nama tampilan dari langkah 1, sudah tersimpan.
  displayName: string;
  onEditName: () => void;
  onSent: (request: OutgoingJoinRequest) => void;
  onOther: () => void;
};

type Errors = { office: string | null; team: string | null; server: AppError | null };
const NO_ERRORS: Errors = { office: null, team: null, server: null };

// (b) Kantor ditemukan, dalam satu formulir: nama (ringkasan), kantor,
// departemen, keterangan untuk admin, lalu kirim permintaan.
export function OfficeStep({ offices, displayName, onEditName, onSent, onOther }: Props) {
  const single = offices.length === 1;
  const [officeKey, setOfficeKey] = useState<string | null>(single ? offices[0].key : null);
  const [teamId, setTeamId] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Errors>(NO_ERRORS);
  const [sending, setSending] = useState(false);
  // Kantor yang bentrok (id sama, sidik beda) baru bisa dikirimi setelah orangnya
  // mencocokkan sidik dengan superadmin lewat telepon atau datang ke mejanya.
  const [confirmedKey, setConfirmedKey] = useState<string | null>(null);
  const teamRef = useRef<HTMLSelectElement>(null);
  const firstRadioRef = useRef<HTMLInputElement>(null);
  const ids = {
    officeErr: useId(),
    team: useId(),
    teamHint: useId(),
    teamErr: useId(),
    note: useId(),
    noteHint: useId(),
    noteCount: useId(),
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
  const noteLength = Array.from(note).length;

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
    setErrors(NO_ERRORS);
    setSending(true);
    const trimmedNote = acceptsNote ? note.trim() : "";
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
        <p className="hint onb-sub">Organisasi ini dipakai di jaringan yang sama dengan laptop Anda.</p>
      ) : (
        <p className="onb-lead">
          Ada {offices.length} organisasi Mira di jaringan ini. Pilih kantor Anda. Kalau ragu, tanyakan sidik
          organisasinya ke superadmin.
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
          onClick={onEditName}
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
              Salah satunya bisa jadi tiruan. Telepon superadmin dan cocokkan sidik organisasi di layar ini dengan
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
            Setiap orang masuk ke satu departemen. Minta superadmin membuat departemen dulu di menu Organisasi, lalu cari
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
            Daftar ini dibuat superadmin. Pilihan departemen tidak bisa Anda ubah sendiri nanti.
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
            id={ids.note}
            name="note"
            autoComplete="off"
            maxLength={JOIN_NOTE_MAX_CHARS}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-describedby={`${ids.noteHint} ${ids.noteCount}`}
            disabled={sending}
          />
          <p id={ids.noteHint} className="hint">
            {OFFICE_STEP.noteHint}
          </p>
          <p id={ids.noteCount} className="hint onb-count">
            {noteLength >= NOTE_COUNT_FROM ? OFFICE_STEP.noteCount(noteLength) : null}
          </p>
        </div>
      )}

      {office?.conflict && (
        <div className="onb-blocked" id={ids.blocked}>
          <p>
            Ada kantor lain dengan identitas yang sama. Telepon superadmin dan minta ia membacakan sidik organisasi di
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
              Sidik dari superadmin sama dengan <span className="mono">{office.fingerprint}</span>
            </span>
          </label>
        </div>
      )}

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
          aria-describedby={blocked ? (office?.conflict ? ids.blocked : ids.empty) : undefined}
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
