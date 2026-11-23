import { IconAlertTriangle, IconArrowLeft } from "@tabler/icons-react";
import { useId, useRef, useState, type FormEvent } from "react";
import { api, toAppError, type AppError, type IdentityInfo, type OrgInfo } from "../../api";
import { orgApi } from "../../api/org";
import { validateDepartmentName, validateDisplayName, validateOrgName } from "../../api/validation";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import { StepHeading } from "./StepHeading";

type Props = {
  identity: IdentityInfo;
  onIdentity: (identity: IdentityInfo) => void;
  onOrganization: (org: OrgInfo) => void;
  onBack: () => void;
  onReload: () => void;
};

type Field = "org" | "name" | "dept";
type Errors = Record<Field, string | null>;
const NO_ERRORS: Errors = { org: null, name: null, dept: null };

// Organisasi sudah dibuat, tapi departemen pertama belum selesai disiapkan.
type HalfDone = { org: OrgInfo; dept: string; error: AppError };

// (e) Siapkan Mira untuk kantor baru. Urutan: nama, organisasi, departemen,
// lalu pindahkan diri sendiri ke departemen itu.
export function NewOfficeStep({ identity, onIdentity, onOrganization, onBack, onReload }: Props) {
  const [orgName, setOrgName] = useState("");
  const [name, setName] = useState(identity.displayName ?? "");
  const [dept, setDept] = useState("");
  const [errors, setErrors] = useState<Errors>(NO_ERRORS);
  const [serverError, setServerError] = useState<AppError | null>(null);
  const [saving, setSaving] = useState(false);
  const [partial, setPartial] = useState<HalfDone | null>(null);
  const refs = {
    org: useRef<HTMLInputElement>(null),
    name: useRef<HTMLInputElement>(null),
    dept: useRef<HTMLInputElement>(null),
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
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    const found: Errors = {
      org: validateOrgName(orgName),
      name: validateDisplayName(name),
      dept: validateDepartmentName(dept),
    };
    const first = (["org", "name", "dept"] as Field[]).find((f) => found[f]);
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

  if (partial) {
    return (
      <div className="onb-form">
        <StepHeading>{`Organisasi ${partial.org.name} sudah dibuat`}</StepHeading>
        <div className="onb-note">
          <strong>Departemen {partial.dept} belum selesai disiapkan</strong>
          <p>{partial.error.message}</p>
          <p>Buat departemen dan masukkan diri Anda ke sana dari menu Organisasi setelah Mira terbuka.</p>
        </div>
        <div className="onb-actions">
          <button type="button" className="btn" onClick={() => onOrganization(partial.org)}>
            Buka Mira
          </button>
        </div>
      </div>
    );
  }

  // org_exists dan name_required berarti data di laptop sudah berbeda dari layar ini.
  const needsReload = serverError?.code === "org_exists" || serverError?.code === "name_required";

  return (
    <form className="onb-form" onSubmit={submit} noValidate aria-busy={saving || undefined}>
      <StepHeading>Siapkan Mira untuk kantor baru</StepHeading>
      <div className="notice">
        <IconAlertTriangle size={18} aria-hidden="true" />
        <div>
          <strong>Hanya untuk orang pertama di kantor</strong>
          <p>
            Kalau rekan Anda sudah memakai Mira, kembali dan minta alamat laptopnya atau kode undangan. Membuat kantor
            kedua memisahkan Anda dari rekan.
          </p>
          <p>
            Kantor yang tidak ditemukan belum tentu belum ada. Kalau Anda memakai VPN atau Wi-Fi yang terpisah, kantor
            Anda bisa tidak terlihat dari laptop ini.
          </p>
        </div>
      </div>

      <div className="field">
        <label htmlFor={ids.org}>Nama organisasi</label>
        <input
          ref={refs.org}
          id={ids.org}
          name="orgName"
          autoComplete="organization"
          placeholder="contoh: nama kantor Anda"
          value={orgName}
          onChange={(e) => setOrgName(e.target.value)}
          aria-invalid={errors.org ? true : undefined}
          aria-describedby={`${ids.orgHint} ${ids.orgErr}`}
          disabled={saving}
        />
        <p id={ids.orgHint} className="hint">
          2 sampai 80 karakter, biasanya nama kantor atau perusahaan.
        </p>
        <div id={ids.orgErr} aria-live="polite">
          {errors.org && <FieldError text={errors.org} />}
        </div>
      </div>

      <div className="field">
        <label htmlFor={ids.name}>Nama Anda</label>
        <input
          ref={refs.name}
          id={ids.name}
          name="displayName"
          autoComplete="name"
          placeholder="Nama yang dikenal rekan kantor"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={`${ids.nameHint} ${ids.nameErr}`}
          disabled={saving}
        />
        <p id={ids.nameHint} className="hint">
          Nama tampilan yang dilihat rekan kerja, 1 sampai 50 karakter.
        </p>
        <div id={ids.nameErr} aria-live="polite">
          {errors.name && <FieldError text={errors.name} />}
        </div>
      </div>

      <div className="field">
        <label htmlFor={ids.dept}>Departemen Anda</label>
        <input
          ref={refs.dept}
          id={ids.dept}
          name="department"
          autoComplete="off"
          placeholder="contoh: Manajemen"
          value={dept}
          onChange={(e) => setDept(e.target.value)}
          aria-invalid={errors.dept ? true : undefined}
          aria-describedby={`${ids.deptHint} ${ids.deptErr}`}
          disabled={saving}
        />
        <p id={ids.deptHint} className="hint">
          Departemen lain dibuat nanti di menu Organisasi.
        </p>
        <div id={ids.deptErr} aria-live="polite">
          {errors.dept && <FieldError text={errors.dept} />}
        </div>
      </div>

      <p className="hint">Anda menjadi superadmin. Angkat satu superadmin lagi sebagai cadangan.</p>

      <div aria-live="polite">
        {serverError && (
          <ErrorAlert title="Organisasi belum dibuat">
            <p>{serverError.message}</p>
            {needsReload && (
              <button type="button" className="btn btn-ghost onb-inline-btn" onClick={onReload}>
                Muat ulang data laptop ini
              </button>
            )}
          </ErrorAlert>
        )}
      </div>

      <div className="onb-actions">
        <button type="button" className="btn btn-ghost" onClick={onBack} disabled={saving}>
          <IconArrowLeft size={18} aria-hidden="true" />
          Kembali
        </button>
        <button type="submit" className="btn" disabled={saving} aria-busy={saving || undefined}>
          {saving ? "Menyiapkan kantor..." : "Buat organisasi"}
        </button>
      </div>
    </form>
  );
}
