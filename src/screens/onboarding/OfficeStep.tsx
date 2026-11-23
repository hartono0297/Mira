import { IconAlertTriangle } from "@tabler/icons-react";
import { useId, useRef, useState, type FormEvent } from "react";
import { api, toAppError, type AppError, type IdentityInfo } from "../../api";
import { joinApi, type FoundOffice, type OutgoingJoinRequest } from "../../api/join";
import { validateDisplayName } from "../../api/validation";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import { StepHeading } from "./StepHeading";

type Props = {
  offices: FoundOffice[];
  identity: IdentityInfo;
  onIdentity: (identity: IdentityInfo) => void;
  onSent: (request: OutgoingJoinRequest) => void;
  onOther: () => void;
};

type Errors = { office: string | null; name: string | null; team: string | null; server: AppError | null };
const NO_ERRORS: Errors = { office: null, name: null, team: null, server: null };

// (b) Kantor ditemukan: nama tampilan dan departemen, lalu kirim permintaan.
// Beberapa kantor: pilih kantornya dulu, masing-masing dengan sidik organisasi.
export function OfficeStep({ offices, identity, onIdentity, onSent, onOther }: Props) {
  const single = offices.length === 1;
  const [officeKey, setOfficeKey] = useState<string | null>(single ? offices[0].key : null);
  const [name, setName] = useState(identity.displayName ?? "");
  const [teamId, setTeamId] = useState("");
  const [errors, setErrors] = useState<Errors>(NO_ERRORS);
  const [sending, setSending] = useState(false);
  // Kantor yang bentrok (id sama, sidik beda) baru bisa dikirimi setelah orangnya
  // mencocokkan sidik dengan superadmin lewat telepon atau datang ke mejanya.
  const [confirmedKey, setConfirmedKey] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const teamRef = useRef<HTMLSelectElement>(null);
  const firstRadioRef = useRef<HTMLInputElement>(null);
  const ids = {
    officeErr: useId(),
    name: useId(),
    nameHint: useId(),
    nameErr: useId(),
    team: useId(),
    teamHint: useId(),
    teamErr: useId(),
    blocked: useId(),
    confirm: useId(),
    empty: useId(),
  };

  const office = offices.find((o) => o.key === officeKey) ?? null;
  const departments = office && Array.isArray(office.departments) ? office.departments : [];
  const twins = offices.some((o) => o.sameName || o.conflict);
  const confirmed = office !== null && confirmedKey === office.key;
  const blocked = office !== null && ((office.conflict && !confirmed) || departments.length === 0);

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
    const nameProblem = validateDisplayName(name);
    const teamProblem = teamId ? null : "Pilih departemen Anda dulu.";
    if (nameProblem || teamProblem) {
      setErrors({ ...NO_ERRORS, name: nameProblem, team: teamProblem });
      if (nameProblem) nameRef.current?.focus();
      else teamRef.current?.focus();
      return;
    }
    setErrors(NO_ERRORS);
    setSending(true);
    const trimmed = name.trim();
    try {
      if (trimmed !== identity.displayName) {
        const saved = await api.saveDisplayName(trimmed);
        onIdentity(saved);
      }
    } catch (err) {
      const error = toAppError(err);
      setSending(false);
      if (error.code === "invalid_name") {
        setErrors({ ...NO_ERRORS, name: error.message });
        nameRef.current?.focus();
      } else {
        setErrors({ ...NO_ERRORS, server: error });
      }
      return;
    }
    try {
      const request = await joinApi.sendRequest(office.key, teamId, office.conflict ? office.fingerprint : null);
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

      <div className="field">
        <label htmlFor={ids.name}>Nama tampilan</label>
        <input
          ref={nameRef}
          id={ids.name}
          name="displayName"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={`${ids.nameHint} ${ids.nameErr}`}
          disabled={sending}
        />
        <p id={ids.nameHint} className="hint">
          Nama yang dilihat rekan kerja, 1 sampai 50 karakter.
        </p>
        <div id={ids.nameErr} aria-live="polite">
          {errors.name && <FieldError text={errors.name} />}
        </div>
      </div>

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
          {sending ? "Mengirim permintaan..." : "Minta bergabung"}
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
