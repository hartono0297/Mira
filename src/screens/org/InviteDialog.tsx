import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  api,
  INVITE_ROLE_LABELS,
  toAppError,
  type AppError,
  type CreatedInvite,
  type InviteRole,
  type InviteValidity,
  type TeamView,
} from "../../api";
import { boardApi, type ProjectSummary } from "../../api/board";
import { formatDateTime } from "../../api/format";
import { CopyButton } from "../../components/CopyButton";
import { Dialog, DialogClose } from "../../components/Dialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import type { OrgCtx } from "./context";

// Batas proyek per kode undangan Tamu, sama dengan inti Rust.
export const MAX_GUEST_PROJECTS = 50;

type ProjectsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; list: ProjectSummary[] }
  | { status: "error"; error: AppError };

const ROLE_DESC: Record<InviteRole, string> = {
  member: "Chat di departemen ini, buat dan kerjakan task di proyek yang ia ikuti",
  team_admin: "Izin Anggota, ditambah membuat proyek departemen, mengatur anggota proyeknya, dan menyetujui orang baru",
  guest: "Melihat board dan membaca komentar di proyek yang dipilih. Tidak bisa mengubah task atau berkomentar.",
};

const VALIDITY_HINT: Record<InviteValidity, string> = {
  "24h": "Bisa dipakai beberapa orang sampai 24 jam setelah kode dibuat.",
  "7d": "Bisa dipakai beberapa orang sampai 7 hari setelah kode dibuat.",
  once: "Untuk satu orang. Kode hangus setelah dipakai, atau setelah 7 hari kalau belum dipakai.",
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ctx: OrgCtx;
  teams: TeamView[]; // departemen terbuka yang boleh dipilih
  initialTeamId?: string;
};

export function InviteDialog({ open, onOpenChange, ctx, teams, initialTeamId }: Props) {
  const isSA = ctx.dir.me.isSuperadmin;
  const [pickedTeamId, setTeamId] = useState(initialTeamId ?? teams[0]?.id ?? "");
  // Daftar departemen bisa menyempit saat dialog terbuka (departemen diarsipkan):
  // pilihan yang hilang jatuh ke departemen pertama yang masih ada.
  const teamId = teams.some((t) => t.id === pickedTeamId) ? pickedTeamId : (teams[0]?.id ?? "");
  const [role, setRole] = useState<InviteRole>("member");
  const [validity, setValidity] = useState<InviteValidity>("24h");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const [projects, setProjects] = useState<ProjectsState>({ status: "idle" });
  const [projectsAttempt, setProjectsAttempt] = useState(0);
  const [picked, setPicked] = useState<string[]>([]);
  const [pickError, setPickError] = useState<string | null>(null);
  const [sentIds, setSentIds] = useState<string[]>([]);
  const pickRef = useRef<HTMLUListElement>(null);
  const teamSelect = useId();
  const validitySelect = useId();
  const validityHint = useId();
  const guestHint = useId();
  const pickErrId = useId();
  const isGuest = role === "guest";

  // Setiap kali dialog dibuka, mulai dari form kosong. Kode lama tidak pernah tampil lagi.
  useEffect(() => {
    if (open) {
      setTeamId(initialTeamId ?? teams[0]?.id ?? "");
      setRole("member");
      setValidity("24h");
      setError(null);
      setCreated(null);
      setPicked([]);
      setPickError(null);
      setSentIds([]);
    }
  }, [open]);

  // Daftar proyek dibaca saat Tamu dipilih: hanya proyek yang terlihat di laptop ini.
  useEffect(() => {
    if (!open || !isGuest) return;
    let live = true;
    setProjects({ status: "loading" });
    boardApi
      .listProjects()
      .then((list) => {
        if (live) setProjects({ status: "ready", list: Array.isArray(list) ? list : [] });
      })
      .catch((err) => {
        if (live) setProjects({ status: "error", error: toAppError(err) });
      });
    return () => {
      live = false;
    };
  }, [open, isGuest, projectsAttempt]);

  const team = teams.find((t) => t.id === teamId);
  const teamProjects = projects.status === "ready" ? projects.list.filter((p) => p.teamId === teamId) : [];
  // Centang dari departemen lain tidak ikut terkirim kalau departemennya diganti.
  const pickedHere = picked.filter((id) => teamProjects.some((p) => p.id === id));
  const atMax = pickedHere.length >= MAX_GUEST_PROJECTS;
  const guestBlocked = isGuest && (projects.status !== "ready" || teamProjects.length === 0);
  const single = teams.length === 1 && initialTeamId !== undefined;
  const title = created
    ? "Kode undangan siap"
    : single && team
      ? `Undang ke ${team.name}`
      : "Undang ke departemen";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !teamId || guestBlocked) return;
    if (isGuest && pickedHere.length === 0) {
      setPickError("Centang minimal satu proyek yang boleh dilihat Tamu.");
      pickRef.current?.querySelector<HTMLInputElement>("input")?.focus();
      return;
    }
    const projectIds = isGuest ? pickedHere : [];
    setBusy(true);
    setError(null);
    try {
      const result = await api.createInvite(teamId, role, validity, projectIds);
      setSentIds(projectIds);
      setCreated(result);
      void ctx.reload();
    } catch (err) {
      setError(toAppError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      title={title}
    >
      {created ? (
        <div className="invite-done">
          <p className="dlg-desc">
            Kirim kode ini ke orang yang Anda undang lewat jalur yang Anda percaya, misalnya langsung atau lewat pesan
            pribadi. Ia memasukkannya saat membuka Mira pertama kali.
          </p>
          <p className="invite-code mono">
            {created.code}
          </p>
          <CopyButton text={created.code} label="Salin kode" className="btn" autoFocus />
          <dl className="invite-facts">
            <div>
              <dt>Peran</dt>
              <dd>
                {INVITE_ROLE_LABELS[created.invite.role]} di {created.invite.teamName}
              </dd>
            </div>
            {created.invite.role === "guest" && (
              <div>
                <dt>Proyek</dt>
                <dd>
                  <ul className="guest-facts">
                    {(created.invite.projectIds.length > 0 ? created.invite.projectIds : sentIds).map((id) => {
                      const p = projects.status === "ready" ? projects.list.find((x) => x.id === id) : undefined;
                      return <li key={id}>{p ? `${p.code} ${p.name}` : "Proyek yang tidak terlihat di laptop ini"}</li>;
                    })}
                  </ul>
                </dd>
              </div>
            )}
            <div>
              <dt>Berlaku sampai</dt>
              <dd>
                {formatDateTime(created.invite.expiresAt)}
                {created.invite.validity === "once" && ", untuk satu orang"}
              </dd>
            </div>
          </dl>
          <p className="notice-plain">
            Kode ini hanya ditampilkan sekali. Setelah dialog ditutup, Mira tidak bisa menampilkannya lagi. Kalau kode
            hilang, cabut kode ini lalu buat yang baru.
          </p>
          <div className="dlg-actions">
            <DialogClose asChild>
              <button type="button" className="btn btn-ghost">
                Selesai
              </button>
            </DialogClose>
          </div>
        </div>
      ) : (
        <form className="dlg-form" onSubmit={submit} noValidate>
          {!single && (
            <div className="field">
              <label htmlFor={teamSelect}>Departemen</label>
              {teams.length === 0 ? (
                <p className="hint">
                  Anda belum mengelola departemen mana pun. Kode undangan selalu untuk satu departemen.
                </p>
              ) : (
                <select id={teamSelect} value={teamId} onChange={(e) => setTeamId(e.target.value)} disabled={busy}>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          <fieldset className="role-set">
            <legend className="set-label">Peran</legend>
            <RoleOption value="member" role={role} onPick={setRole} disabled={busy} />
            {isSA && <RoleOption value="team_admin" role={role} onPick={setRole} disabled={busy} />}
            <RoleOption value="guest" role={role} onPick={setRole} disabled={busy} />
          </fieldset>

          {isGuest && (
            <fieldset className="role-set" aria-describedby={`${guestHint} ${pickErrId}`}>
              <legend className="set-label">Proyek yang boleh dilihat</legend>
              <p id={guestHint} className="hint">
                Tamu hanya bisa melihat board dan komentar proyek yang dicentang, tidak bisa mengubah task. Paling banyak{" "}
                {MAX_GUEST_PROJECTS} proyek.
              </p>
              {projects.status === "loading" && (
                <p className="hint" role="status">
                  Memuat proyek departemen...
                </p>
              )}
              {projects.status === "error" && (
                <ErrorAlert title="Daftar proyek belum terbaca">
                  <p>{projects.error.message}</p>
                  <button type="button" className="link-btn" onClick={() => setProjectsAttempt((n) => n + 1)}>
                    Coba baca lagi
                  </button>
                </ErrorAlert>
              )}
              {projects.status === "ready" && teamProjects.length === 0 && (
                <p className="notice-plain">
                  {team ? `Departemen ${team.name}` : "Departemen ini"} belum punya proyek yang terlihat di laptop ini.
                  Proyek hanya terlihat kalau Anda anggotanya. Buat proyek untuk departemen ini di menu Board, atau minta
                  pengelola proyek menambahkan Anda, lalu undang Tamu ke proyek itu.
                </p>
              )}
              {teamProjects.length > 0 && (
                <ul className="guest-pick" ref={pickRef}>
                  {teamProjects.map((p, i) => {
                    const checked = pickedHere.includes(p.id);
                    return (
                      <li key={p.id}>
                        <label className="guest-row">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={busy || (!checked && atMax)}
                            aria-invalid={i === 0 && pickError ? true : undefined}
                            aria-describedby={i === 0 && pickError ? pickErrId : undefined}
                            onChange={(e) => {
                              setPickError(null);
                              setPicked(e.target.checked ? [...pickedHere, p.id] : pickedHere.filter((id) => id !== p.id));
                            }}
                          />
                          <span className="guest-code">{p.code}</span>
                          <span className="guest-name">{p.name}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
              {atMax && <p className="hint">Sudah {MAX_GUEST_PROJECTS} proyek, batas satu kode undangan.</p>}
              <div id={pickErrId} aria-live="polite">
                {pickError && <FieldError text={pickError} />}
              </div>
            </fieldset>
          )}

          <div className="field">
            <label htmlFor={validitySelect}>Kode berlaku selama</label>
            <select
              id={validitySelect}
              value={validity}
              onChange={(e) => setValidity(e.target.value as InviteValidity)}
              aria-describedby={validityHint}
              disabled={busy}
            >
              <option value="24h">24 jam</option>
              <option value="7d">7 hari</option>
              <option value="once">Sekali pakai</option>
            </select>
            <p id={validityHint} className="hint">
              {VALIDITY_HINT[validity]}
            </p>
          </div>

          <div aria-live="polite">
            {error && (
              <ErrorAlert
                title={error.code === "forbidden" ? "Anda tidak punya izin mengundang ke departemen ini" : "Kode belum dibuat"}
              >
                <p>{error.message}</p>
              </ErrorAlert>
            )}
          </div>

          <div className="dlg-actions">
            <DialogClose asChild>
              <button type="button" className="btn btn-ghost" disabled={busy}>
                Batal
              </button>
            </DialogClose>
            <button type="submit" className="btn" disabled={busy || !teamId || guestBlocked} aria-busy={busy || undefined}>
              {busy ? "Membuat kode..." : "Buat kode undangan"}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function RoleOption({
  value,
  role,
  onPick,
  disabled,
}: {
  value: InviteRole;
  role: InviteRole;
  onPick: (role: InviteRole) => void;
  disabled: boolean;
}) {
  const descId = useId();
  return (
    <label className={`role-opt${disabled ? " role-opt-off" : ""}`}>
      <input
        type="radio"
        name="invite-role"
        value={value}
        checked={role === value}
        onChange={() => onPick(value)}
        disabled={disabled}
        aria-describedby={descId}
      />
      <span>
        <span className="role-title">{INVITE_ROLE_LABELS[value]}</span>
        <span id={descId} className="role-desc">
          {ROLE_DESC[value]}
        </span>
      </span>
    </label>
  );
}
