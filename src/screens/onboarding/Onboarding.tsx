import { IconArrowLeft, IconBuildingCommunity, IconTicket } from "@tabler/icons-react";
import { useId, useRef, useState, type FormEvent } from "react";
import { api, toAppError, type AppError, type AppState, type IdentityInfo, type OrgInfo } from "../../api";
import { validateDisplayName, validateOrgName } from "../../api/validation";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import { FirewallGuide } from "../../components/FirewallGuide";
import { Logo } from "../../components/Logo";
import { JoinStep } from "./JoinStep";
import { StepHeading } from "./StepHeading";
import "./onboarding.css";

type Props = {
  state: AppState;
  onIdentity: (identity: IdentityInfo) => void;
  onOrganization: (org: OrgInfo) => void;
  onReload: () => void;
};

// Membuat: nama, organisasi, firewall. Bergabung: nama, firewall, kode.
type OrgView =
  | { kind: "choice" }
  | { kind: "create" }
  | { kind: "create-firewall"; org: OrgInfo }
  | { kind: "join-firewall" }
  | { kind: "join" };

function stepNumber(hasName: boolean, view: OrgView): number {
  if (!hasName) return 1;
  return view.kind === "create-firewall" || view.kind === "join" ? 3 : 2;
}

export function Onboarding({ state, onIdentity, onOrganization, onReload }: Props) {
  const hasName = state.identity.displayName !== null;
  const [view, setView] = useState<OrgView>({ kind: "choice" });

  return (
    <div className="onb">
      <div className="onb-col">
        <div className="onb-brand">
          <Logo size={32} />
          <span>Mira</span>
        </div>
        <main className="onb-card">
          <p className="onb-step">Langkah {stepNumber(hasName, view)} dari 3</p>
          {!hasName && <NameStep fingerprint={state.identity.fingerprint} onSaved={onIdentity} />}
          {hasName && view.kind === "choice" && (
            <OrgChoice
              name={state.identity.displayName ?? ""}
              onPick={(next) => setView(next === "create" ? { kind: "create" } : { kind: "join-firewall" })}
            />
          )}
          {hasName && view.kind === "create" && (
            <CreateOrg
              onBack={() => setView({ kind: "choice" })}
              onCreated={(org) => setView({ kind: "create-firewall", org })}
              onReload={onReload}
            />
          )}
          {hasName && view.kind === "create-firewall" && (
            <FirewallStep
              lead={`Organisasi ${view.org.name} sudah dibuat. Supaya laptop rekan bisa menemukan dan menyambung ke laptop ini, Windows Firewall perlu mengizinkan Mira.`}
              continueLabel="Buka Mira"
              onContinue={() => onOrganization(view.org)}
            />
          )}
          {hasName && view.kind === "join-firewall" && (
            <FirewallStep
              lead="Kode undangan diperiksa oleh laptop rekan lewat jaringan kantor. Sebelum memasukkan kode, pastikan Windows Firewall mengizinkan Mira."
              continueLabel="Lanjut ke kode undangan"
              onBack={() => setView({ kind: "choice" })}
              onContinue={() => setView({ kind: "join" })}
            />
          )}
          {hasName && view.kind === "join" && (
            <JoinStep
              onBack={() => setView({ kind: "choice" })}
              onFirewall={() => setView({ kind: "join-firewall" })}
              onJoined={onOrganization}
              onReload={onReload}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function FirewallStep({
  lead,
  continueLabel,
  onContinue,
  onBack,
}: {
  lead: string;
  continueLabel: string;
  onContinue: () => void;
  onBack?: () => void;
}) {
  return (
    <div className="onb-form">
      <StepHeading>Izinkan Mira di jaringan kantor</StepHeading>
      <p className="onb-lead">{lead}</p>
      <FirewallGuide
        footer={(status) => {
          const ready = status !== null && (status.rule === "allowed" || !status.supported);
          return (
            <div className="onb-actions">
              {onBack && (
                <button type="button" className="btn btn-ghost" onClick={onBack}>
                  <IconArrowLeft size={18} aria-hidden="true" />
                  Kembali
                </button>
              )}
              <button type="button" className={ready ? "btn" : "btn btn-ghost"} onClick={onContinue}>
                {ready ? continueLabel : "Lewati, atur nanti"}
              </button>
            </div>
          );
        }}
      />
    </div>
  );
}

type FieldState = { fieldError: string | null; serverError: AppError | null; saving: boolean };

function useFormState() {
  return useState<FieldState>({ fieldError: null, serverError: null, saving: false });
}

function NameStep({ fingerprint, onSaved }: { fingerprint: string; onSaved: (identity: IdentityInfo) => void }) {
  const [name, setName] = useState("");
  const [form, setForm] = useFormState();
  const inputId = useId();
  const errorId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (form.saving) return;
    const problem = validateDisplayName(name);
    if (problem) {
      setForm({ fieldError: problem, serverError: null, saving: false });
      inputRef.current?.focus();
      return;
    }
    setForm({ fieldError: null, serverError: null, saving: true });
    try {
      const identity = await api.saveDisplayName(name.trim());
      onSaved(identity);
    } catch (err) {
      const error = toAppError(err);
      if (error.code === "invalid_name") {
        setForm({ fieldError: error.message, serverError: null, saving: false });
        inputRef.current?.focus();
      } else {
        setForm({ fieldError: null, serverError: error, saving: false });
      }
    }
  }

  return (
    <form className="onb-form" onSubmit={submit} noValidate>
      <StepHeading>Siapa nama Anda?</StepHeading>
      <p className="onb-lead">
        Mira tidak memakai akun atau kata sandi. Laptop ini sudah dibuatkan kunci unik yang menandai semua pesan dan
        tanda tangan dari Anda. Nama tampilan adalah nama yang dilihat rekan kerja.
      </p>
      <p className="onb-key">
        Sidik jari kunci laptop ini: <span className="mono">{fingerprint}</span>
      </p>

      <div className="field">
        <label htmlFor={inputId}>Nama tampilan</label>
        <input
          ref={inputRef}
          id={inputId}
          name="displayName"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={form.fieldError ? true : undefined}
          aria-describedby={`${hintId} ${errorId}`}
          disabled={form.saving}
        />
        <p id={hintId} className="hint">
          1 sampai 50 karakter, misalnya nama depan atau nama panggilan di kantor.
        </p>
        <div id={errorId} aria-live="polite">
          {form.fieldError && <FieldError text={form.fieldError} />}
        </div>
      </div>

      <div aria-live="polite">
        {form.serverError && (
          <ErrorAlert title="Nama belum tersimpan">
            <p>{form.serverError.message}</p>
          </ErrorAlert>
        )}
      </div>

      <div className="onb-actions">
        <button type="submit" className="btn" disabled={form.saving}>
          {form.saving ? "Menyimpan..." : "Simpan nama"}
        </button>
      </div>
    </form>
  );
}

function OrgChoice({ name, onPick }: { name: string; onPick: (view: "create" | "join") => void }) {
  return (
    <div className="onb-form">
      <StepHeading>Hubungkan ke organisasi</StepHeading>
      <p className="onb-lead">
        Halo, {name}. Organisasi adalah wadah bersama untuk semua tim di kantor Anda. Pilih salah satu.
      </p>
      <div className="onb-choices">
        <button type="button" className="onb-choice" onClick={() => onPick("create")}>
          <IconBuildingCommunity size={24} aria-hidden="true" />
          <span>
            <span className="onb-choice-title">Buat organisasi baru</span>
            <span className="onb-choice-desc">
              Untuk orang pertama di kantor yang memakai Mira. Anda otomatis menjadi superadmin.
            </span>
          </span>
        </button>
        <button type="button" className="onb-choice" onClick={() => onPick("join")}>
          <IconTicket size={24} aria-hidden="true" />
          <span>
            <span className="onb-choice-title">Gabung dengan kode</span>
            <span className="onb-choice-desc">Pakai kode undangan dari admin organisasi kantor Anda.</span>
          </span>
        </button>
      </div>
    </div>
  );
}

function CreateOrg({
  onBack,
  onCreated,
  onReload,
}: {
  onBack: () => void;
  onCreated: (org: OrgInfo) => void;
  onReload: () => void;
}) {
  const [name, setName] = useState("");
  const [form, setForm] = useFormState();
  const inputId = useId();
  const errorId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (form.saving) return;
    const problem = validateOrgName(name);
    if (problem) {
      setForm({ fieldError: problem, serverError: null, saving: false });
      inputRef.current?.focus();
      return;
    }
    setForm({ fieldError: null, serverError: null, saving: true });
    try {
      const org = await api.createOrganization(name.trim());
      onCreated(org);
    } catch (err) {
      const error = toAppError(err);
      if (error.code === "invalid_name") {
        setForm({ fieldError: error.message, serverError: null, saving: false });
        inputRef.current?.focus();
      } else {
        setForm({ fieldError: null, serverError: error, saving: false });
      }
    }
  }

  // org_exists dan name_required berarti data di laptop sudah berbeda dari layar ini.
  const needsReload = form.serverError?.code === "org_exists" || form.serverError?.code === "name_required";

  return (
    <form className="onb-form" onSubmit={submit} noValidate>
      <StepHeading>Buat organisasi baru</StepHeading>
      <p className="onb-lead">
        Anda akan menjadi superadmin organisasi ini: orang yang mengundang anggota, membentuk tim, dan menunjuk admin
        tim. Peran superadmin tercatat dengan kunci laptop ini.
      </p>

      <div className="field">
        <label htmlFor={inputId}>Nama organisasi</label>
        <input
          ref={inputRef}
          id={inputId}
          name="orgName"
          autoComplete="organization"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={form.fieldError ? true : undefined}
          aria-describedby={`${hintId} ${errorId}`}
          disabled={form.saving}
        />
        <p id={hintId} className="hint">
          2 sampai 80 karakter, biasanya nama kantor atau perusahaan.
        </p>
        <div id={errorId} aria-live="polite">
          {form.fieldError && <FieldError text={form.fieldError} />}
        </div>
      </div>

      <div aria-live="polite">
        {form.serverError && (
          <ErrorAlert title="Organisasi belum dibuat">
            <p>{form.serverError.message}</p>
            {needsReload && (
              <button type="button" className="btn btn-ghost onb-inline-btn" onClick={onReload}>
                Muat ulang data laptop ini
              </button>
            )}
          </ErrorAlert>
        )}
      </div>

      <div className="onb-actions">
        <button type="button" className="btn btn-ghost" onClick={onBack} disabled={form.saving}>
          <IconArrowLeft size={18} aria-hidden="true" />
          Kembali
        </button>
        <button type="submit" className="btn" disabled={form.saving}>
          {form.saving ? "Membuat organisasi..." : "Buat organisasi"}
        </button>
      </div>
    </form>
  );
}
