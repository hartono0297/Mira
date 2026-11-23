import { IconArrowDown, IconArrowUp, IconInfoCircle } from "@tabler/icons-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { toAppError, type AppError } from "../../api";
import { boardApi, type ProjectSummary } from "../../api/board";
import { signingApi, type Candidate, type ImportedPdf, type RequestDetail, type SignMode } from "../../api/signing";
import { Dialog, DialogClose } from "../../components/Dialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import { formatSize, kindLabel, modeHint, modeLabel } from "./labels";

export const TITLE_MAX = 200;
// Sama dengan MAX_SIGNERS di inti Rust (signing/request.rs).
export const SIGNERS_MAX = 20;
const SIGNERS_MAX_MESSAGE = `Paling banyak ${SIGNERS_MAX} penanda tangan per permintaan. Hapus centang satu nama dulu untuk memilih yang lain.`;

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
  if (!withProject) {
    return `Mira melepas ${who} dari penanda tangan karena Tamu hanya bisa menandatangani dokumen di proyek yang boleh ia buka.`;
  }
  const subject = names.length > 1 ? "mereka" : "ia";
  return `Mira melepas ${who} dari penanda tangan karena ${subject} tidak bisa membuka proyek ini.`;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  if (names.length === 2) return `${names[0]} dan ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, dan ${names[names.length - 1]}`;
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
        setDropped(gone.map((k) => before.get(k)?.displayName ?? "Satu penanda tangan"));
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
      setSignersError(SIGNERS_MAX_MESSAGE);
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
    const tErr = clean.length === 0 ? "Isi judul dokumen." : clean.length > TITLE_MAX ? `Judul paling panjang ${TITLE_MAX} karakter.` : null;
    const sErr =
      chosen.length === 0
        ? "Pilih minimal satu penanda tangan."
        : chosen.length > SIGNERS_MAX
          ? SIGNERS_MAX_MESSAGE
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
      title="Minta tanda tangan"
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
          <label htmlFor={ids.title}>Judul dokumen</label>
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
            Tampil di daftar dan di halaman catatan PDF. Paling panjang {TITLE_MAX} karakter.
          </p>
          {/* Wadah alert selalu ada, supaya pesan yang muncul belakangan tetap dibacakan. */}
          <div id={ids.titleError} role="alert">
            {titleError && <FieldError text={titleError} />}
          </div>
        </div>

        <div className="field">
          <label htmlFor={ids.project}>Proyek</label>
          <select
            id={ids.project}
            value={projectId}
            onChange={(e) => chooseProject(e.target.value)}
            aria-describedby={ids.projectHint}
            disabled={saving}
          >
            <option value="">Tanpa proyek</option>
            {(projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} · {p.name}
              </option>
            ))}
          </select>
          <p id={ids.projectHint} className="hint">
            Tamu hanya bisa dipilih untuk proyek yang boleh ia buka. Tanpa proyek, pilihannya anggota saja.
          </p>
          {projects === null && !projectsError && (
            <p className="hint" role="status">
              Memuat daftar proyek...
            </p>
          )}
          {projectsError && (
            <p className="hint sign-project-error">
              Daftar proyek belum terbaca ({projectsError.message}). Permintaan tetap bisa dibuat tanpa proyek.{" "}
              <button type="button" className="link-btn" onClick={() => void loadProjects()}>
                Baca daftar proyek lagi
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
          <legend className="sign-legend">Penanda tangan</legend>
          <p id={ids.signersHint} className="hint">
            Paling banyak {SIGNERS_MAX} orang. Dipilih {chosen.length}.
          </p>
          {!candidates && !loadError && (
            <p className="hint" role="status">
              Memuat daftar anggota...
            </p>
          )}
          {loadError && (
            <div role="alert">
              <ErrorAlert title="Daftar anggota belum terbaca">
                <p>{loadError.message}</p>
                <button type="button" className="btn btn-ghost btn-sm sign-inline-btn" onClick={() => void loadCandidates(project)}>
                  Coba lagi
                </button>
              </ErrorAlert>
            </div>
          )}
          {candidates && candidates.length === 0 && (
            <p className="sign-empty-small">
              {project ? "Belum ada anggota yang boleh membuka proyek ini." : "Belum ada anggota di direktori laptop ini."}
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
                      <span className="sign-pick-name">{c.isMe ? `${c.displayName} (Anda)` : c.displayName}</span>
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
          <legend className="sign-legend">Cara menandatangani</legend>
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
              Urutan
            </h3>
            <ol className="sign-order" aria-labelledby={ids.order}>
              {chosen.map((c, i) => (
                <li key={c.publicKey} className="sign-order-row">
                  <span className="sign-num" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span className="sign-order-name">
                    {c.isMe ? `${c.displayName} (Anda)` : c.displayName}
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
                      aria-label={`Naikkan ${c.displayName}`}
                    >
                      <IconArrowUp size={16} aria-hidden="true" />
                      Naikkan
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      ref={(el) => {
                        moveRefs.current.set(`${c.publicKey}:down`, el);
                      }}
                      onClick={() => move(c.publicKey, "down")}
                      disabled={saving || i === chosen.length - 1}
                      aria-label={`Turunkan ${c.displayName}`}
                    >
                      <IconArrowDown size={16} aria-hidden="true" />
                      Turunkan
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
            <p>
              Dikirim ke penanda tangan saat laptop mereka tersambung. Sampai saat itu, permintaan tersimpan di laptop
              ini.
            </p>
          </div>
        )}

        <div aria-live="polite">
          {saveError && (
            <ErrorAlert title="Permintaan belum dibuat">
              <p>{saveError.message}</p>
            </ErrorAlert>
          )}
        </div>

        <div className="dlg-actions">
          <DialogClose asChild>
            <button type="button" className="btn btn-ghost" disabled={saving}>
              Batal
            </button>
          </DialogClose>
          <button type="submit" className="btn" disabled={saving || !imported || !candidates} aria-busy={saving || undefined}>
            {saving ? "Membuat permintaan..." : "Buat permintaan"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
