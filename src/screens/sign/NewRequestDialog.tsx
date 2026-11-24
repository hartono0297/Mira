import { IconArrowDown, IconArrowUp, IconInfoCircle } from "@tabler/icons-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { toAppError, type AppError } from "../../api";
import { boardApi, type ProjectSummary } from "../../api/board";
import { signingApi, type Candidate, type ImportedPdf, type RequestDetail, type SignMode } from "../../api/signing";
import { Dialog, DialogClose } from "../../components/Dialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import { formatSize, kindLabel, modeHint, modeLabel } from "./labels";
import { SIGN_DIALOGS } from "../../i18n/sign-dialogs";

export const TITLE_MAX = 200;
// Sama dengan MAX_SIGNERS di inti Rust (signing/request.rs).
export const SIGNERS_MAX = 20;
// Dibaca saat dipakai, supaya mengikuti bahasa aktif.
const T = () => SIGN_DIALOGS.newRequest;

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  imported: ImportedPdf | null;
  onCreated: (detail: RequestDetail) => void;
};

export function titleFromFileName(name: string): string {
  return name.replace(/\.pdf$/i, "").trim().slice(0, TITLE_MAX);
}

function byName(a: Candidate, b: Candidate): number {
  if (a.isMe !== b.isMe) return a.isMe ? -1 : 1;
  return a.displayName.localeCompare(b.displayName, "id");
}

type Move = { key: string; dir: "up" | "down" };

// Koma tersembunyi supaya pembaca layar membaca "Nama, Tamu", bukan "NamaTamu".
function GuestChip() {
  return (
    <>
      <span className="sr-only">, {kindLabel("guest")}</span>
      <span className="chip" aria-hidden="true">
        {kindLabel("guest")}
      </span>
    </>
  );
}

// "Rekan A", "Rekan A dan Rekan B", "Rekan A, Rekan B, dan Rekan C".
// Penanda tangan yang dilepas setelah proyek diganti. Tanpa proyek, yang
// dilepas hanya Tamu (Tamu hanya menandatangani di proyek yang boleh ia buka).
function droppedText(names: string[], withProject: boolean): string {
  const who = joinNames(names);
  if (!withProject) return T().droppedGuest(who);
  return T().droppedProject(who, names.length > 1);
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  const and = T().and;
  if (names.length === 2) return `${names[0]} ${and} ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, ${and} ${names[names.length - 1]}`;
}

export function NewRequestDialog({ open, onOpenChange, imported, onCreated }: Props) {
  const [title, setTitle] = useState("");
  const [titleError, setTitleError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [projectsError, setProjectsError] = useState<AppError | null>(null);
  // "" = tanpa proyek.
  const [projectId, setProjectId] = useState("");
  const [dropped, setDropped] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [signersError, setSignersError] = useState<string | null>(null);
  const [mode, setMode] = useState<SignMode>("sequential");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<AppError | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const moveRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const pendingFocus = useRef<Move | null>(null);
  const loadSeq = useRef(0);
  const projectSeq = useRef(0);
  const candidatesRef = useRef<Candidate[]>([]);
  const orderRef = useRef<string[]>([]);
  orderRef.current = order;

  const ids = {
    title: useId(),
    titleHint: useId(),
    titleError: useId(),
    project: useId(),
    projectHint: useId(),
    signers: useId(),
    signersHint: useId(),
    signersError: useId(),
    mode: useId(),
    order: useId(),
  };

  // Calon penanda tangan bergantung pada proyek: Tamu hanya muncul untuk
  // proyek yang boleh ia buka. Pilihan yang tidak ada lagi di daftar baru
  // dilepas, dan namanya disebut supaya pengirim tahu.
  const loadCandidates = useCallback(async (project: ProjectSummary | null) => {
    const mine = ++loadSeq.current;
    setLoadError(null);
    setCandidates(null);
    try {
      const list = await signingApi.listCandidates(project ? { projectId: project.id, teamId: project.teamId } : {});
      if (mine !== loadSeq.current) return;
      const sorted = [...list].sort(byName);
      const before = new Map(candidatesRef.current.map((c) => [c.publicKey, c]));
      const keys = new Set(sorted.map((c) => c.publicKey));
      candidatesRef.current = sorted;
      setCandidates(sorted);
      const prev = orderRef.current;
      if (!prev.length) {
        // Diri sendiri tercentang bawaan, kecuali pengguna sudah memilih sendiri.
        setOrder(sorted.filter((c) => c.isMe).map((c) => c.publicKey));
      } else {
        const gone = prev.filter((k) => !keys.has(k));
        setDropped(gone.map((k) => before.get(k)?.displayName ?? T().oneSigner));
        setOrder(prev.filter((k) => keys.has(k)));
      }
    } catch (err) {
      if (mine !== loadSeq.current) return;
      setLoadError(toAppError(err));
    }
  }, []);

  const loadProjects = useCallback(async () => {
    const mine = ++projectSeq.current;
    setProjectsError(null);
    setProjects(null);
    try {
      const list = await boardApi.listProjects();
      if (mine !== projectSeq.current) return;
      setProjects([...list].sort((a, b) => a.code.localeCompare(b.code, "id")));
    } catch (err) {
      if (mine !== projectSeq.current) return;
      setProjectsError(toAppError(err));
    }
  }, []);

  // Isi dibuat ulang setiap kali dialog dibuka untuk PDF baru.
  useEffect(() => {
    if (!open) {
      loadSeq.current++;
      projectSeq.current++;
      return;
    }
    setTitle(imported ? titleFromFileName(imported.fileName) : "");
    setTitleError(null);
    setOrder([]);
    setSignersError(null);
    setMode("sequential");
    setSaving(false);
    setSaveError(null);
    setProjectId("");
    setDropped([]);
    candidatesRef.current = [];
    void loadProjects();
    void loadCandidates(null);
  }, [open, imported, loadCandidates, loadProjects]);

  const project = projects?.find((p) => p.id === projectId) ?? null;

  function chooseProject(id: string) {
    setProjectId(id);
    setDropped([]);
    setSignersError(null);
    void loadCandidates(projects?.find((p) => p.id === id) ?? null);
  }

  // Setelah baris dipindah, fokus tetap di tombol yang sama. Kalau tombol itu
  // nonaktif karena baris sudah di ujung, fokus pindah ke tombol arah sebaliknya.
  useLayoutEffect(() => {
    const move = pendingFocus.current;
    if (!move) return;
    pendingFocus.current = null;
    const same = moveRefs.current.get(`${move.key}:${move.dir}`);
    const other = moveRefs.current.get(`${move.key}:${move.dir === "up" ? "down" : "up"}`);
    (same && !same.disabled ? same : other)?.focus();
  }, [order]);

  const byKey = new Map((candidates ?? []).map((c) => [c.publicKey, c]));
  const chosen = order.map((k) => byKey.get(k)).filter((c): c is Candidate => Boolean(c));
  const hasOthers = chosen.some((c) => !c.isMe);

  function toggle(key: string, checked: boolean) {
    if (checked && !order.includes(key) && order.length >= SIGNERS_MAX) {
      // Centang ditolak; pesan dibacakan lewat wadah role="alert" di bawah daftar.
      setSignersError(T().signersMax(SIGNERS_MAX));
      return;
    }
    setSignersError(null);
    setOrder((prev) => (checked ? (prev.includes(key) ? prev : [...prev, key]) : prev.filter((k) => k !== key)));
  }

  function move(key: string, dir: "up" | "down") {
    setOrder((prev) => {
      const i = prev.indexOf(key);
      const j = dir === "up" ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
    pendingFocus.current = { key, dir };
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving || !imported) return;
    const clean = title.trim();
    const tErr = clean.length === 0 ? T().titleEmpty : clean.length > TITLE_MAX ? T().titleTooLong(TITLE_MAX) : null;
    const sErr =
      chosen.length === 0
        ? T().signersEmpty
        : chosen.length > SIGNERS_MAX
          ? T().signersMax(SIGNERS_MAX)
          : null;
    setTitleError(tErr);
    setSignersError(sErr);
    setSaveError(null);
    if (tErr) {
      titleRef.current?.focus();
      return;
    }
    if (sErr) {
      document.getElementById(ids.signers)?.querySelector<HTMLInputElement>("input")?.focus();
      return;
    }
    setSaving(true);
    try {
      const detail = await signingApi.createRequest({
        title: clean,
        fileHash: imported.fileHash,
        mode,
        signers: chosen.map((c) => c.publicKey),
        // Cakupan hanya dikirim kalau proyek dipilih; tanpa proyek = Pustaka Umum.
        ...(project ? { projectId: project.id, teamId: project.teamId } : {}),
      });
      setSaving(false);
      onCreated(detail);
    } catch (err) {
      setSaving(false);
      setSaveError(toAppError(err));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next);
      }}
      title={T().title}
      description={
        imported ? (
          <>
            <span className="sign-file-name">{imported.fileName}</span>, {formatSize(imported.size)}
          </>
        ) : undefined
      }
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        titleRef.current?.focus();
      }}
    >
      <form className="sign-form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor={ids.title}>{T().titleLabel}</label>
          <input
            ref={titleRef}
            id={ids.title}
            value={title}
            maxLength={TITLE_MAX}
            onChange={(e) => {
              setTitle(e.target.value);
              setTitleError(null);
            }}
            aria-invalid={titleError ? true : undefined}
            aria-describedby={titleError ? `${ids.titleHint} ${ids.titleError}` : ids.titleHint}
            disabled={saving}
          />
          <p id={ids.titleHint} className="hint">
            {T().titleHint(TITLE_MAX)}
          </p>
          {/* Wadah alert selalu ada, supaya pesan yang muncul belakangan tetap dibacakan. */}
          <div id={ids.titleError} role="alert">
            {titleError && <FieldError text={titleError} />}
          </div>
        </div>

        <div className="field">
          <label htmlFor={ids.project}>{T().projectLabel}</label>
          <select
            id={ids.project}
            value={projectId}
            onChange={(e) => chooseProject(e.target.value)}
            aria-describedby={ids.projectHint}
            disabled={saving}
          >
            <option value="">{T().noProject}</option>
            {(projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} · {p.name}
              </option>
            ))}
          </select>
          <p id={ids.projectHint} className="hint">
            {T().projectHint}
          </p>
          {projects === null && !projectsError && (
            <p className="hint" role="status">
              {T().projectsLoading}
            </p>
          )}
          {projectsError && (
            <p className="hint sign-project-error">
              {T().projectsError(projectsError.message)}{" "}
              <button type="button" className="link-btn" onClick={() => void loadProjects()}>
                {T().projectsRetry}
              </button>
            </p>
          )}
        </div>

        <fieldset
          id={ids.signers}
          className="sign-set"
          aria-describedby={signersError ? `${ids.signersHint} ${ids.signersError}` : ids.signersHint}
          disabled={saving}
        >
          <legend className="sign-legend">{T().signersLegend}</legend>
          <p id={ids.signersHint} className="hint">
            {T().signersHint(SIGNERS_MAX, chosen.length)}
          </p>
          {!candidates && !loadError && (
            <p className="hint" role="status">
              {T().membersLoading}
            </p>
          )}
          {loadError && (
            <div role="alert">
              <ErrorAlert title={T().membersError}>
                <p>{loadError.message}</p>
                <button type="button" className="btn btn-ghost btn-sm sign-inline-btn" onClick={() => void loadCandidates(project)}>
                  {T().retry}
                </button>
              </ErrorAlert>
            </div>
          )}
          {candidates && candidates.length === 0 && (
            <p className="sign-empty-small">
              {project ? T().noMembersProject : T().noMembers}
            </p>
          )}
          {candidates && candidates.length > 0 && (
            <ul className="sign-pick">
              {candidates.map((c) => {
                const checked = order.includes(c.publicKey);
                return (
                  <li key={c.publicKey}>
                    <label className="sign-pick-row">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => toggle(c.publicKey, e.target.checked)}
                      />
                      <span className="sign-pick-name">{c.isMe ? T().me(c.displayName) : c.displayName}</span>
                      {c.kind === "guest" && <GuestChip />}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          <div id={ids.signersError} role="alert">
            {signersError && <FieldError text={signersError} />}
          </div>
          <div aria-live="polite">
            {dropped.length > 0 && (
              <p className="hint sign-dropped">{droppedText(dropped, projectId !== "")}</p>
            )}
          </div>
        </fieldset>

        <fieldset className="sign-set" disabled={saving}>
          <legend className="sign-legend">{T().modeLegend}</legend>
          <div className="sign-opts">
            {(["sequential", "parallel"] as const).map((m) => (
              <label key={m} className="sign-opt">
                <input
                  type="radio"
                  name={ids.mode}
                  value={m}
                  checked={mode === m}
                  onChange={() => setMode(m)}
                  aria-labelledby={`${ids.mode}-${m}`}
                  aria-describedby={`${ids.mode}-${m}-desc`}
                />
                <span>
                  <span id={`${ids.mode}-${m}`} className="sign-opt-title">
                    {modeLabel(m)}
                  </span>
                  <span id={`${ids.mode}-${m}-desc`} className="sign-opt-desc">
                    {modeHint(m)}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {mode === "sequential" && chosen.length > 1 && (
          <div className="sign-set">
            <h3 id={ids.order} className="sign-legend">
              {T().order}
            </h3>
            <ol className="sign-order" aria-labelledby={ids.order}>
              {chosen.map((c, i) => (
                <li key={c.publicKey} className="sign-order-row">
                  <span className="sign-num" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span className="sign-order-name">
                    {c.isMe ? T().me(c.displayName) : c.displayName}
                    {c.kind === "guest" && <GuestChip />}
                  </span>
                  <span className="sign-order-btns">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      ref={(el) => {
                        moveRefs.current.set(`${c.publicKey}:up`, el);
                      }}
                      onClick={() => move(c.publicKey, "up")}
                      disabled={saving || i === 0}
                      aria-label={T().moveUpAria(c.displayName)}
                    >
                      <IconArrowUp size={16} aria-hidden="true" />
                      {T().moveUp}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      ref={(el) => {
                        moveRefs.current.set(`${c.publicKey}:down`, el);
                      }}
                      onClick={() => move(c.publicKey, "down")}
                      disabled={saving || i === chosen.length - 1}
                      aria-label={T().moveDownAria(c.displayName)}
                    >
                      <IconArrowDown size={16} aria-hidden="true" />
                      {T().moveDown}
                    </button>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {hasOthers && (
          <div className="sign-note">
            <IconInfoCircle size={18} aria-hidden="true" />
            <p>{T().sendNote}</p>
          </div>
        )}

        <div aria-live="polite">
          {saveError && (
            <ErrorAlert title={T().saveError}>
              <p>{saveError.message}</p>
            </ErrorAlert>
          )}
        </div>

        <div className="dlg-actions">
          <DialogClose asChild>
            <button type="button" className="btn btn-ghost" disabled={saving}>
              {T().cancel}
            </button>
          </DialogClose>
          <button type="submit" className="btn" disabled={saving || !imported || !candidates} aria-busy={saving || undefined}>
            {saving ? T().creating : T().create}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
