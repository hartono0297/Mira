import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api, toAppError, type AppError, type Directory } from "../../api";
import { boardApi, type ProjectSummary } from "../../api/board";
import { Dialog, DialogClose } from "../../components/Dialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import { PROJECT_CODE_RE, projectNameProblem, suggestCode, teamLabel } from "./format";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: ProjectSummary) => void;
};

export const CODE_RULE = "Kode harus 2 sampai 6 karakter, huruf A sampai Z atau angka, dan diawali huruf. Contoh: PA atau WEB2.";
export const NO_TEAM_HINT = "Tambahkan diri Anda ke tim dulu di halaman Organisasi untuk membuat proyek tim.";

// Nilai select untuk proyek tanpa tim.
const ORG = "";

export type TeamChoices = {
  teams: { id: string; name: string }[];
  // Proyek tanpa tim boleh dibuat oleh superadmin dan admin tim.
  allowOrg: boolean;
  // Superadmin yang belum masuk tim mana pun.
  saWithoutTeam: boolean;
};

// Tim yang boleh dipilih: tim tempat saya admin tim, atau tim yang saya ikuti
// kalau saya superadmin. Inti Rust tetap memeriksa izinnya.
export function teamChoices(dir: Directory): TeamChoices {
  const me = dir.me.publicKey;
  const sa = dir.me.isSuperadmin;
  const myRole = (members: Directory["teams"][number]["members"]) => members.find((m) => m.publicKey === me)?.role;
  const teams = dir.teams
    .filter((t) => {
      const role = myRole(t.members);
      return role === "admin" || (sa && role !== undefined);
    })
    .map((t) => ({ id: t.id, name: t.name }));
  const adminSomewhere = dir.teams.some((t) => myRole(t.members) === "admin");
  const inAnyTeam = dir.teams.some((t) => myRole(t.members) !== undefined);
  return { teams, allowOrg: sa || adminSomewhere, saWithoutTeam: sa && !inAnyTeam };
}

type TeamState = { status: "loading" } | { status: "ready"; choices: TeamChoices } | { status: "error"; error: AppError };

function serverTitle(error: AppError): string {
  if (error.code === "forbidden") return "Anda tidak punya izin membuat proyek";
  return "Proyek belum dibuat";
}

function serverHint(error: AppError): string | null {
  if (error.code === "forbidden") return "Proyek dibuat oleh superadmin atau admin tim. Minta salah satu dari mereka membuatkannya.";
  return null;
}

// Proyek baru: nama, kode, dan tim. Kode diusulkan dari nama sampai orangnya
// mengubah kode sendiri. Tim menentukan siapa yang melihat dan menerima
// sinkron board-nya.
export function NewProjectDialog({ open, onOpenChange, onCreated }: Props) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [codeTouched, setCodeTouched] = useState(false);
  const [teamPick, setTeamPick] = useState<string | null>(null);
  const [teamState, setTeamState] = useState<TeamState>({ status: "loading" });
  const [teamAttempt, setTeamAttempt] = useState(0);
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
  const teamId = useId();
  const teamHintId = useId();

  useEffect(() => {
    if (!open) return;
    let live = true;
    setTeamState({ status: "loading" });
    api
      .getDirectory()
      .then((dir) => {
        if (live) setTeamState({ status: "ready", choices: teamChoices(dir) });
      })
      .catch((err) => {
        if (live) setTeamState({ status: "error", error: toAppError(err) });
      });
    return () => {
      live = false;
    };
  }, [open, teamAttempt]);

  const choices = teamState.status === "ready" ? teamState.choices : null;
  const options = choices ? [...choices.teams.map((t) => t.id), ...(choices.allowOrg ? [ORG] : [])] : [];
  // Pilihan bawaan: tim pertama yang boleh dipilih. Pilihan yang tidak berlaku lagi kembali ke bawaan.
  const teamValue = teamPick !== null && options.includes(teamPick) ? teamPick : (options[0] ?? ORG);
  const pickedTeam = choices?.teams.find((t) => t.id === teamValue) ?? null;
  const cannotCreate = !!choices && options.length === 0;

  function reset() {
    setName("");
    setCode("");
    setCodeTouched(false);
    setTeamPick(null);
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
    if (busy || cannotCreate || teamState.status === "loading") return;
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
    setBusy(true);
    try {
      const project = await boardApi.createProject(cleanName, cleanCode, choices && teamValue !== ORG ? teamValue : null);
      reset();
      onCreated(project);
    } catch (err) {
      const error = toAppError(err);
      // Kode yang sudah dipakai proyek lain juga datang sebagai invalid_input.
      if (error.code === "invalid_input" && /kode/i.test(error.message)) {
        setCodeError(error.message);
        codeRef.current?.focus();
      } else if (error.code === "invalid_input" && /nama/i.test(error.message)) {
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

  function teamField() {
    if (teamState.status === "loading") {
      return (
        <p className="hint" role="status">
          Memuat daftar tim...
        </p>
      );
    }
    if (teamState.status === "error") {
      return (
        <p className="hint">
          Daftar tim belum terbaca ({teamState.error.message}). Kalau Anda lanjut, proyek dibuat tanpa tim.{" "}
          <button type="button" className="link-btn" onClick={() => setTeamAttempt((n) => n + 1)}>
            Coba baca lagi
          </button>
        </p>
      );
    }
    if (cannotCreate) {
      return (
        <p className="hint">
          Hanya superadmin atau admin tim yang bisa membuat proyek. Minta salah satu dari mereka membuatkannya.
        </p>
      );
    }
    return (
      <>
        <select
          id={teamId}
          value={teamValue}
          onChange={(e) => setTeamPick(e.target.value)}
          aria-describedby={teamHintId}
          disabled={busy}
        >
          {teamState.choices.teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
          {teamState.choices.allowOrg && <option value={ORG}>Tanpa tim (seluruh organisasi)</option>}
        </select>
        <div id={teamHintId}>
          <p className="hint">
            {pickedTeam
              ? `Proyek tim hanya terlihat dan tersinkron ke anggota ${teamLabel(pickedTeam.name)} dan Tamu yang diundang ke proyek ini.`
              : "Proyek tanpa tim terlihat dan tersinkron ke semua anggota organisasi, kecuali Tamu."}
          </p>
          {teamState.choices.saWithoutTeam && <p className="hint">{NO_TEAM_HINT}</p>}
        </div>
      </>
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
      <form className="np-form" onSubmit={submit} noValidate>
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
            2 sampai 6 huruf atau angka, diawali huruf. Task di proyek ini diberi nomor seperti {example}. Kode tidak bisa
            diganti setelah proyek dibuat.
          </p>
          <div id={codeErrId} aria-live="polite">
            {codeError && <FieldError text={codeError} />}
          </div>
        </div>
        <div className="field">
          {teamState.status === "ready" && !cannotCreate ? (
            <label htmlFor={teamId}>Tim</label>
          ) : (
            <span className="np-label">Tim</span>
          )}
          {teamField()}
        </div>
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
          <button
            type="submit"
            className="btn"
            disabled={busy || cannotCreate || teamState.status === "loading"}
            aria-busy={busy || undefined}
          >
            {busy ? "Membuat proyek..." : "Buat proyek"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
