import { IconAlertTriangle, IconArrowLeft } from "@tabler/icons-react";
import { useId, useRef, useState, type FormEvent } from "react";
import { api, toAppError, type AppError, type IdentityInfo, type OrgInfo } from "../../api";
import { orgApi } from "../../api/org";
import { validateDepartmentName, validateDisplayName, validateOrgName } from "../../api/validation";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import { StepHeading } from "./StepHeading";
import { NEW_OFFICE } from "./texts";

type Props = {
  identity: IdentityInfo;
  onIdentity: (identity: IdentityInfo) => void;
  onOrganization: (org: OrgInfo) => void;
  onBack: () => void;
  onReload: () => void;
};

type Field = "org" | "name" | "dept" | "confirm";
type Errors = Record<Field, string | null>;
const NO_ERRORS: Errors = { org: null, name: null, dept: null, confirm: null };

// Organisasi sudah dibuat, tapi departemen pertama belum selesai disiapkan.
type HalfDone = { org: OrgInfo; dept: string; error: AppError };

// (e) Siapkan Mira untuk kantor baru. Nama organisasi diketik dua kali supaya
// salah ketik tidak menjadi nama kantor. Urutan simpan: nama, organisasi,
// departemen, lalu pindahkan diri sendiri ke departemen itu.
export function NewOfficeStep({ identity, onIdentity, onOrganization, onBack, onReload }: Props) {
  const [orgName, setOrgName] = useState("");
  const [name, setName] = useState(identity.displayName ?? "");
  const [dept, setDept] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Errors>(NO_ERRORS);
  const [serverError, setServerError] = useState<AppError | null>(null);
  const [saving, setSaving] = useState(false);
  const [partial, setPartial] = useState<HalfDone | null>(null);
  const refs = {
    org: useRef<HTMLInputElement>(null),
    name: useRef<HTMLInputElement>(null),
    dept: useRef<HTMLInputElement>(null),
    confirm: useRef<HTMLInputElement>(null),
  };
  const ids = {
    org: useId(),
    orgHint: useId(),
    orgErr: useId(),
    name: useId(),
    nameHint: useId(),
    nameErr: useId(),
    dept: useId(),
    deptHint: useId(),
    deptErr: useId(),
    confirm: useId(),
    confirmHint: useId(),
    confirmErr: useId(),
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    const found: Errors = {
      org: validateOrgName(orgName),
      name: validateDisplayName(name),
      dept: validateDepartmentName(dept),
      confirm: confirm.trim() === orgName.trim() ? null : NEW_OFFICE.confirmMismatch,
    };
    const first = (["org", "name", "dept", "confirm"] as Field[]).find((f) => found[f]);
    if (first) {
      setErrors(found);
      setServerError(null);
      refs[first].current?.focus();
      return;
    }
    setErrors(NO_ERRORS);
    setServerError(null);
    setSaving(true);

    let org: OrgInfo;
    try {
      const trimmed = name.trim();
      if (trimmed !== identity.displayName) {
        const saved = await api.saveDisplayName(trimmed);
        onIdentity(saved);
      }
      org = await api.createOrganization(orgName.trim());
    } catch (err) {
      setSaving(false);
      setServerError(toAppError(err));
      return;
    }

    const deptName = dept.trim();
    try {
      const created = await orgApi.createDepartment(deptName);
      await orgApi.moveMember(identity.publicKey, created.id);
    } catch (err) {
      // Organisasi sudah ada. Departemen bisa disiapkan nanti di menu Organisasi.
      setSaving(false);
      setPartial({ org, dept: deptName, error: toAppError(err) });
      return;
    }
    onOrganization(org);
  }

  const T = NEW_OFFICE;

  if (partial) {
    return (
      <div className="onb-form">
        <StepHeading>{T.created(partial.org.name)}</StepHeading>
        <div className="onb-note">
          <strong>{T.deptPendingTitle(partial.dept)}</strong>
          <p>{partial.error.message}</p>
          <p>{T.deptPendingHint}</p>
        </div>
        <div className="onb-actions">
          <button type="button" className="btn" onClick={() => onOrganization(partial.org)}>
            {T.open}
          </button>
        </div>
      </div>
    );
  }

  // org_exists dan name_required berarti data di laptop sudah berbeda dari layar ini.
  const needsReload = serverError?.code === "org_exists" || serverError?.code === "name_required";

  return (
    <form className="onb-form" onSubmit={submit} noValidate aria-busy={saving || undefined}>
      <StepHeading>{T.heading}</StepHeading>
      <div className="notice">
        <IconAlertTriangle size={18} aria-hidden="true" />
        <div>
          <strong>{T.firstOnlyTitle}</strong>
          <p>{T.firstOnlyColleagues}</p>
          <p>{T.firstOnlyHidden}</p>
        </div>
      </div>

      <div className="field">
        <label htmlFor={ids.org}>{T.orgLabel}</label>
        <input
          ref={refs.org}
          id={ids.org}
          name="orgName"
          autoComplete="organization"
          placeholder={T.orgPlaceholder}
          value={orgName}
          onChange={(e) => setOrgName(e.target.value)}
          aria-invalid={errors.org ? true : undefined}
          aria-describedby={`${ids.orgHint} ${ids.orgErr}`}
          disabled={saving}
        />
        <p id={ids.orgHint} className="hint">
          {T.orgHint}
        </p>
        <div id={ids.orgErr} aria-live="polite">
          {errors.org && <FieldError text={errors.org} />}
        </div>
      </div>

      <div className="field">
        <label htmlFor={ids.name}>{T.nameLabel}</label>
        <input
          ref={refs.name}
          id={ids.name}
          name="displayName"
          autoComplete="name"
          placeholder={T.namePlaceholder}
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={`${ids.nameHint} ${ids.nameErr}`}
          disabled={saving}
        />
        <p id={ids.nameHint} className="hint">
          {T.nameHint}
        </p>
        <div id={ids.nameErr} aria-live="polite">
          {errors.name && <FieldError text={errors.name} />}
        </div>
      </div>

      <div className="field">
        <label htmlFor={ids.dept}>{T.deptLabel}</label>
        <input
          ref={refs.dept}
          id={ids.dept}
          name="department"
          autoComplete="off"
          placeholder={T.deptPlaceholder}
          value={dept}
          onChange={(e) => setDept(e.target.value)}
          aria-invalid={errors.dept ? true : undefined}
          aria-describedby={`${ids.deptHint} ${ids.deptErr}`}
          disabled={saving}
        />
        <p id={ids.deptHint} className="hint">
          {T.deptHint}
        </p>
        <div id={ids.deptErr} aria-live="polite">
          {errors.dept && <FieldError text={errors.dept} />}
        </div>
      </div>

      <div className="field">
        <label htmlFor={ids.confirm}>{T.confirmLabel}</label>
        <input
          ref={refs.confirm}
          id={ids.confirm}
          name="orgNameConfirm"
          autoComplete="off"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          aria-invalid={errors.confirm ? true : undefined}
          aria-describedby={`${ids.confirmHint} ${ids.confirmErr}`}
          disabled={saving}
        />
        <p id={ids.confirmHint} className="hint">
          {T.confirmHint}
        </p>
        <div id={ids.confirmErr} aria-live="polite">
          {errors.confirm && <FieldError text={errors.confirm} />}
        </div>
      </div>

      <p className="hint">{T.superadmin}</p>

      <div aria-live="polite">
        {serverError && (
          <ErrorAlert title={T.failed}>
            <p>{serverError.message}</p>
            {needsReload && (
              <button type="button" className="btn btn-ghost onb-inline-btn" onClick={onReload}>
                {T.reload}
              </button>
            )}
          </ErrorAlert>
        )}
      </div>

      <div className="onb-actions">
        <button type="button" className="btn btn-ghost" onClick={onBack} disabled={saving}>
          <IconArrowLeft size={18} aria-hidden="true" />
          {T.back}
        </button>
        <button type="submit" className="btn" disabled={saving} aria-busy={saving || undefined}>
          {saving ? T.saving : T.submit}
        </button>
      </div>
    </form>
  );
}
