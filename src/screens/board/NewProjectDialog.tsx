import { IconLock } from "@tabler/icons-react";
import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import { toAppError, type AppError } from "../../api";
import { boardApi, type ProjectSummary } from "../../api/board";
import type { PersonView } from "../../api/org";
import { Dialog, DialogClose } from "../../components/Dialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import { initials } from "../../components/initials";
import { useCreateOptions, type OrgData } from "./createOptions";
import { PROJECT_CODE_RE, projectNameProblem, suggestCode } from "./format";
import { describePicked, PeoplePicker } from "./PeoplePicker";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: ProjectSummary) => void;
};

export const CODE_RULE =
  "Kode harus 2 sampai 6 karakter, huruf A sampai Z atau angka, dan diawali huruf. Contoh: PA atau WEB2.";

// Nilai select untuk proyek tanpa departemen.
const NONE = "";

const TAMU_LATER = "Tamu diundang setelah proyek dibuat, dari panel Anggota proyek.";

function serverTitle(error: AppError): string {
  if (error.code === "forbidden") return "Anda tidak punya izin membuat proyek";
  return "Proyek belum dibuat";
}

function serverHint(error: AppError): string | null {
  if (error.code === "forbidden") {
    return "Proyek dibuat oleh superadmin atau admin departemen. Minta admin departemen Anda membuatkannya.";
  }
  return null;
}

function memberSummary(picked: PersonView[]): string {
  if (picked.length === 0) {
    return "Belum ada yang dipilih: proyek ini hanya berisi Anda sebagai pengelola. Anggota dan Tamu bisa ditambah nanti dari panel Anggota proyek.";
  }
  return `${describePicked(picked)}, ditambah Anda sebagai pengelola. ${TAMU_LATER}`;
}

// Penjelasan untuk orang yang tidak berhak membuat proyek, dengan nama admin departemennya kalau ada.
function CannotCreate({ data }: { data: OrgData }) {
  const { overview, departments } = data;
  const admins = (departments.find((d) => d.id === overview.departmentId)?.admins ?? [])
    .filter((a) => a.publicKey !== overview.publicKey)
    .map((a) => a.displayName);
  return (
    <div className="notice">
      <IconLock size={18} aria-hidden="true" />
      <div>
        <p>
          <strong>Hanya superadmin atau admin departemen yang bisa membuat proyek.</strong>
        </p>
        {overview.isGuest ? (
          <p>Tamu hanya melihat proyek tempat ia diundang. Minta pengelola proyek menambahkan Anda.</p>
        ) : admins.length > 0 ? (
          <p>Minta admin departemen Anda ({admins.join(", ")}) membuatkannya dan menambahkan Anda sebagai anggota.</p>
        ) : (
          <p>Minta admin departemen Anda atau superadmin membuatkannya dan menambahkan Anda sebagai anggota.</p>
        )}
      </div>
    </div>
  );
}

// Proyek baru: nama, kode, departemen, dan anggota. Kode diusulkan dari nama
// sampai orangnya mengubah kode sendiri. Yang melihat proyek hanya anggota yang
// dipilih di sini (ditambah pembuat); departemen menentukan siapa yang ikut
// mengelola dan undangan Tamu mana yang berlaku.
export function NewProjectDialog({ open, onOpenChange, onCreated }: Props) {
  const org = useCreateOptions(open);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [codeTouched, setCodeTouched] = useState(false);
  const [deptPick, setDeptPick] = useState<string | null>(null);
  const [members, setMembers] = useState<string[]>([]);
  const [nameError, setNameError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [server, setServer] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const nameErrId = useId();
  const codeId = useId();
  const codeHintId = useId();
  const codeErrId = useId();
  const deptId = useId();
  const deptHintId = useId();

  const options = org.status === "ready" ? org.options : null;
  const data = org.status === "ready" ? org.data : null;

  // Pemilih orang: anggota aktif bukan Tamu, selain saya (D7). Tamu ditambah dari panel Anggota proyek.
  const candidates = useMemo(
    () => (data ? data.people.filter((p) => !p.isGuest && p.publicKey !== data.overview.publicKey) : []),
    [data],
  );
  const myName = data?.people.find((p) => p.publicKey === data.overview.publicKey)?.displayName ?? "Anda";

  const values = options ? [...options.departments.map((d) => d.id), ...(options.allowNoDepartment ? [NONE] : [])] : [];
  // Pilihan yang tidak berlaku lagi (departemen diarsipkan, hak berubah) kembali ke bawaan.
  const deptValue =
    deptPick !== null && values.includes(deptPick) ? deptPick : (options?.defaultDepartment ?? values[0] ?? NONE);
  const pickedDept = options?.departments.find((d) => d.id === deptValue) ?? null;
  const canSubmit = !!options?.canCreate && !busy;

  function reset() {
    setName("");
    setCode("");
    setCodeTouched(false);
    setDeptPick(null);
    setMembers([]);
    setNameError(null);
    setCodeError(null);
    setServer(null);
  }

  function changeName(value: string) {
    setName(value);
    if (!codeTouched) setCode(suggestCode(value));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    // Tanpa data organisasi, departemen dan anggota belum bisa ditentukan: proyek tidak dibuat dulu.
    if (!canSubmit) return;
    const cleanName = name.trim();
    const cleanCode = code.trim().toUpperCase();
    setServer(null);
    const nameProblem = projectNameProblem(cleanName);
    const codeProblem = PROJECT_CODE_RE.test(cleanCode) ? null : CODE_RULE;
    setNameError(nameProblem);
    setCodeError(codeProblem);
    if (nameProblem) {
      nameRef.current?.focus();
      return;
    }
    if (codeProblem) {
      codeRef.current?.focus();
      return;
    }
    // Orang yang keluar dari daftar selama dialog terbuka tidak ikut dikirim.
    const offered = new Set(candidates.map((p) => p.publicKey));
    const chosen = members.filter((k) => offered.has(k));
    setBusy(true);
    try {
      const project = await boardApi.createProject(cleanName, cleanCode, deptValue !== NONE ? deptValue : null, chosen);
      reset();
      onCreated(project);
    } catch (err) {
      const error = toAppError(err);
      // Kode yang sudah dipakai proyek lain juga datang sebagai invalid_input.
      if (error.code === "invalid_input" && /kode/i.test(error.message)) {
        setCodeError(error.message);
        codeRef.current?.focus();
      } else if (error.code === "invalid_input" && /nama proyek/i.test(error.message)) {
        setNameError(error.message);
        nameRef.current?.focus();
      } else {
        setServer(error);
      }
    } finally {
      setBusy(false);
    }
  }

  const example = PROJECT_CODE_RE.test(code) ? `${code}-1` : "PA-1";

  function deptField() {
    if (org.status === "loading") {
      return (
        <div className="field">
          <span className="np-label">Departemen dan anggota</span>
          <p className="hint" role="status">
            Memuat daftar departemen dan orang...
          </p>
        </div>
      );
    }
    if (org.status === "error") {
      return (
        <div className="field">
          <span className="np-label">Departemen dan anggota</span>
          <p className="hint">
            Daftar departemen dan orang belum terbaca ({org.error.message}). Proyek bisa dibuat setelah daftarnya
            terbaca, supaya departemen dan anggotanya tepat.{" "}
            <button type="button" className="link-btn" onClick={org.reload}>
              Coba baca lagi
            </button>
          </p>
        </div>
      );
    }
    return (
      <div className="field">
        <label htmlFor={deptId}>Departemen</label>
        <select
          id={deptId}
          value={deptValue}
          onChange={(e) => setDeptPick(e.target.value)}
          aria-describedby={deptHintId}
          disabled={busy}
        >
          {org.options.departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
          {org.options.allowNoDepartment && <option value={NONE}>Tanpa departemen</option>}
        </select>
        <p id={deptHintId} className="hint">
          {pickedDept
            ? `Admin departemen ${pickedDept.name} ikut mengelola proyek ini bersama Anda, dan Tamu yang diundang lewat departemen ini bisa diberi akses. Proyek hanya terlihat oleh anggota yang Anda pilih.`
            : "Proyek tanpa departemen dikelola oleh Anda dan superadmin yang menjadi anggota. Proyek hanya terlihat oleh anggota yang Anda pilih."}
        </p>
      </div>
    );
  }

  function memberField() {
    if (org.status !== "ready") return null;
    return (
      <div className="np-members">
        <PeoplePicker
          people={candidates}
          selected={members}
          onChange={setMembers}
          disabled={busy}
          fixedNote={
            <>
              <span className="pp-av" aria-hidden="true">
                {initials(myName)}
              </span>
              <span className="pp-who">
                <span className="pp-name">{myName}</span>
                <span className="pp-dept">Anda, pengelola</span>
              </span>
            </>
          }
          emptyText="Belum ada orang lain yang bisa dipilih. Proyek tetap bisa dibuat, dan anggota ditambah nanti dari panel Anggota proyek."
          summary={memberSummary}
        />
      </div>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) reset();
        onOpenChange(next);
      }}
      title="Proyek baru"
      description="Setiap proyek punya board sendiri. Kode proyek menjadi awalan nomor task."
    >
      {data && options && !options.canCreate ? (
        <>
          <CannotCreate data={data} />
          <div className="dlg-actions">
            <DialogClose asChild>
              <button type="button" className="btn btn-ghost">
                Tutup
              </button>
            </DialogClose>
          </div>
        </>
      ) : (
        <form className="np-form np-people" onSubmit={submit} noValidate>
          <div className="np-details">
            <div className="field">
              <label htmlFor={nameId}>Nama proyek</label>
              <input
                ref={nameRef}
                id={nameId}
                autoComplete="off"
                value={name}
                onChange={(e) => changeName(e.target.value)}
                aria-invalid={nameError ? true : undefined}
                aria-describedby={nameErrId}
                disabled={busy}
              />
              <div id={nameErrId} aria-live="polite">
                {nameError && <FieldError text={nameError} />}
              </div>
            </div>
            <div className="field">
              <label htmlFor={codeId}>Kode proyek</label>
              <input
                ref={codeRef}
                id={codeId}
                className="np-code"
                autoComplete="off"
                spellCheck={false}
                maxLength={6}
                value={code}
                onChange={(e) => {
                  setCodeTouched(true);
                  setCode(e.target.value.toUpperCase().replace(/\s/g, ""));
                }}
                aria-invalid={codeError ? true : undefined}
                aria-describedby={`${codeHintId} ${codeErrId}`}
                disabled={busy}
              />
              <p id={codeHintId} className="hint">
                2 sampai 6 huruf atau angka, diawali huruf. Task di proyek ini diberi nomor seperti {example}. Kode
                tidak bisa diganti setelah proyek dibuat.
              </p>
              <div id={codeErrId} aria-live="polite">
                {codeError && <FieldError text={codeError} />}
              </div>
            </div>
            {deptField()}
          </div>
          {memberField()}
          <div aria-live="polite">
            {server && (
              <ErrorAlert title={serverTitle(server)}>
                <p>{server.message}</p>
                {serverHint(server) && <p>{serverHint(server)}</p>}
              </ErrorAlert>
            )}
          </div>
          <div className="dlg-actions">
            <DialogClose asChild>
              <button type="button" className="btn btn-ghost" disabled={busy}>
                Batal
              </button>
            </DialogClose>
            <button type="submit" className="btn" disabled={!canSubmit} aria-busy={busy || undefined}>
              {busy ? "Membuat proyek..." : "Buat proyek"}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
