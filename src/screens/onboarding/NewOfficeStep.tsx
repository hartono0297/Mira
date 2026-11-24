import { IconAlertTriangle, IconArrowLeft } from "@tabler/icons-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api, toAppError, type AppError, type IdentityInfo, type OrgInfo } from "../../api";
import { orgApi } from "../../api/org";
import { validateDepartmentName, validateDisplayName, validateOrgName } from "../../api/validation";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import { normalizeAdDomain } from "./adProfile";
import { StepHeading } from "./StepHeading";
import { NEW_OFFICE } from "./texts";

type Props = {
  identity: IdentityInfo;
  // Domain akun Windows laptop ini (profil AD), dipakai sebelum domain PC.
  adDomain?: string | null;
  onIdentity: (identity: IdentityInfo) => void;
  onOrganization: (org: OrgInfo) => void;
  onBack: () => void;
  onReload: () => void;
};

type Field = "org" | "name" | "dept" | "confirm" | "domain";
type Errors = Record<Field, string | null>;
const NO_ERRORS: Errors = { org: null, name: null, dept: null, confirm: null, domain: null };
const FIELDS: Field[] = ["org", "name", "dept", "confirm", "domain"];

// Organisasi sudah dibuat, tapi departemen pertama belum selesai disiapkan.
type HalfDone = { org: OrgInfo; dept: string; error: AppError };

// (e) Siapkan Mira untuk kantor baru. Nama organisasi diketik dua kali supaya
// salah ketik tidak menjadi nama kantor. Urutan simpan: nama, organisasi,
// departemen, lalu pindahkan diri sendiri ke departemen itu.
export function NewOfficeStep({ identity, adDomain = null, onIdentity, onOrganization, onBack, onReload }: Props) {
  const [orgName, setOrgName] = useState("");
  const orgTouched = useRef(false);
  // Nama organisasi bawaan dari domain kantor; keterangannya hilang begitu diubah.
  const [orgFromDomain, setOrgFromDomain] = useState<string | null>(null);
  const [name, setName] = useState(identity.displayName ?? "");
  const [dept, setDept] = useState("");
  const [confirm, setConfirm] = useState("");
  // Domain AD kantor (opsional). Terisi domain PC ini kalau PC-nya bergabung ke domain.
  const [domain, setDomain] = useState("");
  const domainTouched = useRef(false);
  const [errors, setErrors] = useState<Errors>(NO_ERRORS);
  const [serverError, setServerError] = useState<AppError | null>(null);
  const [saving, setSaving] = useState(false);
  const [partial, setPartial] = useState<HalfDone | null>(null);
  const refs = {
    org: useRef<HTMLInputElement>(null),
    name: useRef<HTMLInputElement>(null),
    dept: useRef<HTMLInputElement>(null),
    confirm: useRef<HTMLInputElement>(null),
    domain: useRef<HTMLInputElement>(null),
  };
  const ids = {
    org: useId(),
    orgHint: useId(),
    orgErr: useId(),
    orgSource: useId(),
    name: useId(),
    nameHint: useId(),
    nameErr: useId(),
    dept: useId(),
    deptHint: useId(),
    deptErr: useId(),
    confirm: useId(),
    confirmHint: useId(),
    confirmErr: useId(),
    domain: useId(),
    domainHint: useId(),
    domainErr: useId(),
  };

  // Domain kantor laptop ini: dari akun Windows, atau domain PC. Mengisi nama
  // organisasi dan domain AD yang masih kosong dan belum disentuh.
  function fillFromDomain(found: string | null | undefined) {
    const normalized = typeof found === "string" ? normalizeAdDomain(found) : null;
    if (!normalized) return;
    if (!domainTouched.current) setDomain((current) => (current.trim() === "" ? normalized : current));
    if (!orgTouched.current && orgNameNow.current.trim() === "") {
      orgNameNow.current = normalized;
      setOrgName(normalized);
      setOrgFromDomain(normalized);
    }
  }
  const orgNameNow = useRef(orgName);
  orgNameNow.current = orgName;
  const applyDomain = useRef(fillFromDomain);
  applyDomain.current = fillFromDomain;

  useEffect(() => {
    if (adDomain) applyDomain.current(adDomain);
  }, [adDomain]);

  useEffect(() => {
    let alive = true;
    api
      .machineAdDomain()
      .then((found) => {
        if (alive) applyDomain.current(found);
      })
      .catch(() => {
        // Domain PC tidak terbaca: isian tetap kosong dan boleh diisi sendiri.
      });
    return () => {
      alive = false;
    };
  }, []);

  const showOrgSource = orgFromDomain !== null && orgName === orgFromDomain;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    const found: Errors = {
      org: validateOrgName(orgName),
      name: validateDisplayName(name),
      dept: validateDepartmentName(dept),
      confirm: confirm.trim() === orgName.trim() ? null : NEW_OFFICE.confirmMismatch,
      domain: domain.trim() === "" || normalizeAdDomain(domain) ? null : NEW_OFFICE.adInvalid,
    };
    const first = FIELDS.find((f) => found[f]);
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
      org = await api.createOrganization(orgName.trim(), normalizeAdDomain(domain));
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
          onChange={(e) => {
            orgTouched.current = true;
            setOrgName(e.target.value);
          }}
          aria-invalid={errors.org ? true : undefined}
          aria-describedby={`${showOrgSource ? `${ids.orgSource} ` : ""}${ids.orgHint} ${ids.orgErr}`}
          disabled={saving}
        />
        <div aria-live="polite">
          {showOrgSource && (
            <p id={ids.orgSource} className="hint" data-testid="onb-new-office-domain-source">
              {T.orgFromDomain}
            </p>
          )}
        </div>
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

      <div className="field">
        <label htmlFor={ids.domain}>{T.adLabel}</label>
        <input
          ref={refs.domain}
          id={ids.domain}
          name="adDomain"
          autoComplete="off"
          spellCheck={false}
          placeholder={T.adPlaceholder}
          value={domain}
          onChange={(e) => {
            domainTouched.current = true;
            setDomain(e.target.value);
          }}
          aria-invalid={errors.domain ? true : undefined}
          aria-describedby={`${ids.domainHint} ${ids.domainErr}`}
          disabled={saving}
        />
        <p id={ids.domainHint} className="hint">
          {T.adHint}
        </p>
        <div id={ids.domainErr} aria-live="polite">
          {errors.domain && <FieldError text={errors.domain} />}
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
