import { IconLock } from "@tabler/icons-react";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { toAppError, type AppError } from "../../api";
import { boardApi, type ProjectSummary } from "../../api/board";
import { divisionApi, type DivisionRef } from "../../api/division";
import type { PersonView } from "../../api/org";
import { Dialog, DialogClose } from "../../components/Dialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import { initials } from "../../components/initials";
import { BOARD_DETAIL } from "../../i18n/board-detail";
import BOARD_DETAIL_ID from "../../i18n/board-detail.id";
import { DIVISION_MISC } from "../../i18n/division-misc";
import { useCreateOptions, type OrgData } from "./createOptions";
import { PROJECT_CODE_RE, projectNameProblem, suggestCode } from "./format";
import { describePicked, PeoplePicker } from "./PeoplePicker";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: ProjectSummary) => void;
};

// Aturan kode dalam bahasa Indonesia, untuk tes. Tampilan memakai BOARD_DETAIL.newProject.codeRule
// supaya mengikuti bahasa aktif.
export const CODE_RULE = BOARD_DETAIL_ID.newProject.codeRule;

// Nilai select untuk proyek tanpa departemen.
const NONE = "";

function serverTitle(error: AppError): string {
  if (error.code === "forbidden") return BOARD_DETAIL.newProject.forbiddenTitle;
  return BOARD_DETAIL.newProject.failedTitle;
}

function serverHint(error: AppError): string | null {
  if (error.code === "forbidden") return BOARD_DETAIL.newProject.forbiddenHint;
  return null;
}

function memberSummary(picked: PersonView[], division: DivisionRef | null): string {
  if (division) {
    const D = DIVISION_MISC.newProject;
    if (picked.length === 0) return D.summaryNone(division.name);
    return D.summaryPicked(describePicked(picked), division.name);
  }
  if (picked.length === 0) return BOARD_DETAIL.newProject.summaryNone;
  return BOARD_DETAIL.newProject.summaryPicked(describePicked(picked));
}

// Divisi saya (dan yang saya kelola) untuk pilihan "Untuk divisi". Gagal dibaca
// sama dengan tidak ada divisi: pilihannya opsional, proyek tetap bisa dibuat.
function useMyDivisions(open: boolean): DivisionRef[] {
  const [divisions, setDivisions] = useState<DivisionRef[]>([]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    divisionApi
      .myDivisions()
      .then((list) => {
        if (alive) setDivisions(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (alive) setDivisions([]);
      });
    return () => {
      alive = false;
    };
  }, [open]);
  return divisions;
}

// Penjelasan untuk orang yang tidak berhak membuat proyek, dengan nama admin departemennya kalau ada.
function CannotCreate({ data }: { data: OrgData }) {
  const { overview, departments } = data;
  const admins = (departments.find((d) => d.id === overview.departmentId)?.admins ?? [])
    .filter((a) => a.publicKey !== overview.publicKey)
    .map((a) => a.displayName);
  const T = BOARD_DETAIL.newProject;
  return (
    <div className="notice">
      <IconLock size={18} aria-hidden="true" />
      <div>
        <p>
          <strong>{T.cannotTitle}</strong>
        </p>
        {overview.isGuest ? (
          <p>{T.cannotGuest}</p>
        ) : admins.length > 0 ? (
          <p>{T.cannotAskAdmins(admins.join(", "))}</p>
        ) : (
          <p>{T.cannotAsk}</p>
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
  const myDivisions = useMyDivisions(open);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [codeTouched, setCodeTouched] = useState(false);
  const [deptPick, setDeptPick] = useState<string | null>(null);
  const [divisionPick, setDivisionPick] = useState<string>(NONE);
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
  const divisionId = useId();
  const divisionHintId = useId();

  const options = org.status === "ready" ? org.options : null;
  const data = org.status === "ready" ? org.data : null;

  // Pemilih orang: anggota aktif bukan Tamu, selain saya (D7). Tamu ditambah dari panel Anggota proyek.
  const candidates = useMemo(
    () => (data ? data.people.filter((p) => !p.isGuest && p.publicKey !== data.overview.publicKey) : []),
    [data],
  );
  const T = BOARD_DETAIL.newProject;
  const myName = data?.people.find((p) => p.publicKey === data.overview.publicKey)?.displayName ?? T.you;

  const values = options ? [...options.departments.map((d) => d.id), ...(options.allowNoDepartment ? [NONE] : [])] : [];
  // Divisi yang ditawarkan: tidak diarsipkan dan di departemen yang boleh dipilih di sini.
  // Kepala divisi yang bukan admin departemen hanya mendapat divisi yang ia kepalai.
  const divisions = useMemo(
    () =>
      options
        ? myDivisions
            .filter((d) => !d.archived && options.departments.some((x) => x.id === d.teamId))
            .filter((d) => !options.divisionOnly || options.divisionOnly.includes(d.id))
            .sort((a, b) => a.teamName.localeCompare(b.teamName, "id") || a.name.localeCompare(b.name, "id"))
        : [],
    [myDivisions, options],
  );
  const divisionOnly = !!options?.divisionOnly;
  const pickedDivision =
    divisions.find((d) => d.id === divisionPick) ?? (divisionOnly ? (divisions[0] ?? null) : null);
  // Pilihan yang tidak berlaku lagi (departemen diarsipkan, hak berubah) kembali ke bawaan.
  // Proyek divisi selalu di departemen divisi itu.
  const deptValue = pickedDivision
    ? pickedDivision.teamId
    : deptPick !== null && values.includes(deptPick)
      ? deptPick
      : (options?.defaultDepartment ?? values[0] ?? NONE);
  const pickedDept = options?.departments.find((d) => d.id === deptValue) ?? null;
  const canSubmit = !!options?.canCreate && !busy && (!divisionOnly || !!pickedDivision);

  function reset() {
    setName("");
    setCode("");
    setCodeTouched(false);
    setDeptPick(null);
    setDivisionPick(NONE);
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
    const codeProblem = PROJECT_CODE_RE.test(cleanCode) ? null : T.codeRule;
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
      const team = deptValue !== NONE ? deptValue : null;
      const project = pickedDivision
        ? await boardApi.createProject(cleanName, cleanCode, team, chosen, pickedDivision.id)
        : await boardApi.createProject(cleanName, cleanCode, team, chosen);
      reset();
      onCreated(project);
    } catch (err) {
      const error = toAppError(err);
      // Kode yang sudah dipakai proyek lain juga datang sebagai invalid_input.
      // Pesan inti bisa bahasa Indonesia atau Inggris, tergantung bahasa aktif.
      if (error.code === "invalid_input" && /kode|\bcode\b/i.test(error.message)) {
        setCodeError(error.message);
        codeRef.current?.focus();
      } else if (error.code === "invalid_input" && /nama proyek|project name/i.test(error.message)) {
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
          <span className="np-label">{T.deptAndMembers}</span>
          <p className="hint" role="status">
            {T.loadingOrg}
          </p>
        </div>
      );
    }
    if (org.status === "error") {
      return (
        <div className="field">
          <span className="np-label">{T.deptAndMembers}</span>
          <p className="hint">
            {T.orgError(org.error.message)}{" "}
            <button type="button" className="link-btn" onClick={org.reload}>
              {T.retryRead}
            </button>
          </p>
        </div>
      );
    }
    return (
      <div className="field">
        <label htmlFor={deptId}>{T.dept}</label>
        <select
          id={deptId}
          value={deptValue}
          onChange={(e) => {
            setDeptPick(e.target.value);
            // Departemen lain: proyek bukan lagi milik divisi yang dipilih.
            if (pickedDivision && pickedDivision.teamId !== e.target.value) setDivisionPick(NONE);
          }}
          aria-describedby={deptHintId}
          disabled={busy}
        >
          {org.options.departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
          {org.options.allowNoDepartment && <option value={NONE}>{T.noDept}</option>}
        </select>
        <p id={deptHintId} className="hint">
          {pickedDept ? T.deptHint(pickedDept.name) : T.noDeptHint}
        </p>
      </div>
    );
  }

  // "Untuk divisi": hanya tampil kalau ada divisi yang bisa dipilih.
  function divisionField() {
    if (org.status !== "ready" || divisions.length === 0) return null;
    const D = DIVISION_MISC.newProject;
    return (
      <div className="field">
        <label htmlFor={divisionId}>{D.label}</label>
        <select
          id={divisionId}
          value={pickedDivision?.id ?? NONE}
          onChange={(e) => {
            const next = divisions.find((d) => d.id === e.target.value) ?? null;
            setDivisionPick(next ? next.id : NONE);
            if (next) setDeptPick(next.teamId);
          }}
          aria-describedby={divisionHintId}
          disabled={busy}
        >
          {!divisionOnly && <option value={NONE}>{D.none}</option>}
          {divisions.map((d) => (
            <option key={d.id} value={d.id}>
              {D.option(d.name, d.teamName)}
            </option>
          ))}
        </select>
        <p id={divisionHintId} className="hint">
          {pickedDivision ? D.picked(pickedDivision.name) : D.hint}
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
                <span className="pp-dept">{T.youManager}</span>
              </span>
            </>
          }
          emptyText={T.emptyPeople}
          summary={(picked) => memberSummary(picked, pickedDivision)}
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
      title={T.title}
      description={T.description}
    >
      {data && options && !options.canCreate ? (
        <>
          <CannotCreate data={data} />
          <div className="dlg-actions">
            <DialogClose asChild>
              <button type="button" className="btn btn-ghost">
                {T.close}
              </button>
            </DialogClose>
          </div>
        </>
      ) : (
        <form className="np-form np-people" onSubmit={submit} noValidate>
          <div className="np-details">
            <div className="field">
              <label htmlFor={nameId}>{T.nameLabel}</label>
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
              <label htmlFor={codeId}>{T.codeLabel}</label>
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
                {T.codeHint(example)}
              </p>
              <div id={codeErrId} aria-live="polite">
                {codeError && <FieldError text={codeError} />}
              </div>
            </div>
            {deptField()}
            {divisionField()}
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
                {T.cancel}
              </button>
            </DialogClose>
            <button type="submit" className="btn" disabled={!canSubmit} aria-busy={busy || undefined}>
              {busy ? T.creating : T.create}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
