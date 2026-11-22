import { IconArrowLeft, IconChevronRight, IconPlus, IconTicket, IconTrash } from "@tabler/icons-react";
import { useId, useRef, useState, type FormEvent } from "react";
import { api, TEAM_ROLE_LABELS, toAppError, type AppError, type TeamView } from "../../api";
import { formatDate } from "../../api/format";
import { validateTeamName } from "../../api/validation";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Dialog, DialogClose } from "../../components/Dialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import type { OrgCtx } from "./context";
import { InviteDialog } from "./InviteDialog";
import { RedeemForm } from "./RedeemForm";

export function TeamsPanel({ ctx }: { ctx: OrgCtx }) {
  const [openTeamId, setOpenTeamId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const { dir } = ctx;
  const team = openTeamId ? dir.teams.find((t) => t.id === openTeamId) : undefined;

  if (team) return <TeamDetail ctx={ctx} team={team} onBack={() => setOpenTeamId(null)} />;

  return (
    <section className="set-section" aria-labelledby="teams-title">
      <div className="org-head">
        <h2 id="teams-title" className="set-title">
          Tim
        </h2>
        {dir.can.createTeam && (
          <button type="button" className="btn btn-sm" onClick={() => setCreating(true)}>
            <IconPlus size={16} aria-hidden="true" />
            Buat tim
          </button>
        )}
      </div>

      {openTeamId && !team && (
        <p className="hint" role="status">
          Tim yang tadi dibuka sudah dihapus.
        </p>
      )}

      {dir.teams.length === 0 ? (
        <div className="org-empty">
          <p>
            {dir.can.createTeam
              ? "Belum ada tim. Buat tim pertama, lalu undang rekan ke tim itu dengan kode undangan."
              : "Belum ada tim. Superadmin organisasi yang membuat tim."}
          </p>
        </div>
      ) : (
        <ul className="team-list">
          {dir.teams.map((t) => {
            const mine = t.members.find((m) => ctx.isMe(m.publicKey));
            const channels = dir.channels.filter((c) => c.teamId === t.id);
            return (
              <li key={t.id}>
                <button type="button" className="team-row" onClick={() => setOpenTeamId(t.id)}>
                  <span className="team-row-main">
                    <span className="team-name">{t.name}</span>
                    <span className="team-meta">
                      {t.members.length} anggota
                      {channels.length > 0 && `, channel ${channels.map((c) => `#${c.name}`).join(", ")}`}
                    </span>
                  </span>
                  {mine && <span className="chip chip-on">Anda: {TEAM_ROLE_LABELS[mine.role]}</span>}
                  <IconChevronRight size={18} aria-hidden="true" className="team-chevron" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <RedeemForm ctx={ctx} />

      <CreateTeamDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={async (t) => {
          setCreating(false);
          ctx.notify(`${t.name} dibuat. Tambahkan anggota atau buat kode undangan untuk tim ini.`);
          await ctx.reload();
          setOpenTeamId(t.id);
        }}
      />
    </section>
  );
}

function CreateTeamDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (team: TeamView) => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [server, setServer] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const hintId = useId();
  const errId = useId();

  function reset() {
    setName("");
    setFieldError(null);
    setServer(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const problem = validateTeamName(name);
    if (problem) {
      setFieldError(problem);
      inputRef.current?.focus();
      return;
    }
    setFieldError(null);
    setServer(null);
    setBusy(true);
    try {
      const team = await api.createTeam(name.trim());
      reset();
      void onCreated(team);
    } catch (err) {
      const error = toAppError(err);
      if (error.code === "invalid_name") {
        setFieldError(error.message);
        inputRef.current?.focus();
      } else {
        setServer(error);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) reset();
        onOpenChange(next);
      }}
      title="Buat tim"
      description="Tim mendapat channel chat sendiri. Anggota organisasi bisa ditambahkan ke tim setelah tim dibuat."
    >
      <form className="dlg-form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor={inputId}>Nama tim</label>
          <input
            ref={inputRef}
            id={inputId}
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={`${hintId} ${errId}`}
            disabled={busy}
          />
          <p id={hintId} className="hint">
            2 sampai 60 karakter, misalnya Tim Desain atau Keuangan.
          </p>
          <div id={errId} aria-live="polite">
            {fieldError && <FieldError text={fieldError} />}
          </div>
        </div>
        <div aria-live="polite">
          {server && (
            <ErrorAlert title={server.code === "forbidden" ? "Anda tidak punya izin membuat tim" : "Tim belum dibuat"}>
              <p>{server.message}</p>
            </ErrorAlert>
          )}
        </div>
        <div className="dlg-actions">
          <DialogClose asChild>
            <button type="button" className="btn btn-ghost" disabled={busy}>
              Batal
            </button>
          </DialogClose>
          <button type="submit" className="btn" disabled={busy} aria-busy={busy || undefined}>
            {busy ? "Membuat tim..." : "Buat tim"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function TeamDetail({ ctx, team, onBack }: { ctx: OrgCtx; team: TeamView; onBack: () => void }) {
  const { dir, act, pending } = ctx;
  const isSA = dir.me.isSuperadmin;
  const canManage = ctx.canManageTeam(team.id);
  const channels = dir.channels.filter((c) => c.teamId === team.id);
  const [inviting, setInviting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [candidate, setCandidate] = useState("");
  const selectId = useId();
  const busy = pending !== null;

  const inTeam = new Set(team.members.map((m) => m.publicKey));
  const candidates = dir.members.filter(
    (m) => m.status === "active" && m.orgRole !== "guest" && !inTeam.has(m.publicKey),
  );
  const members = [...team.members].sort((a, b) => {
    if (a.role !== b.role) return a.role === "admin" ? -1 : 1;
    return ctx.name(a.publicKey).localeCompare(ctx.name(b.publicKey), "id");
  });
  const me = team.members.find((m) => ctx.isMe(m.publicKey));

  async function addMember(e: FormEvent) {
    e.preventDefault();
    if (!candidate) return;
    const who = ctx.name(candidate);
    const ok = await act(
      `add:${candidate}`,
      () => api.addTeamMember(team.id, candidate),
      `${who} ditambahkan ke ${team.name}.`,
      "Anggota belum ditambahkan",
    );
    if (ok) setCandidate("");
  }

  return (
    <section className="set-section" aria-labelledby="team-title">
      <div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
          <IconArrowLeft size={16} aria-hidden="true" />
          Semua tim
        </button>
      </div>
      <div className="org-head">
        <div>
          <h2 id="team-title" className="set-title">
            {team.name}
          </h2>
          <p className="hint">
            Dibuat {formatDate(team.createdAt)}
            {channels.length > 0 && `. Channel: ${channels.map((c) => `#${c.name}`).join(", ")}`}
          </p>
        </div>
        <div className="org-head-actions">
          {canManage && (
            <button type="button" className="btn btn-sm" onClick={() => setInviting(true)}>
              <IconTicket size={16} aria-hidden="true" />
              Undang ke tim
            </button>
          )}
          {isSA && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDeleting(true)} disabled={busy}>
              <IconTrash size={16} aria-hidden="true" />
              Hapus tim
            </button>
          )}
        </div>
      </div>

      <h3 className="set-sub">Anggota tim ({team.members.length})</h3>
      {members.length === 0 ? (
        <div className="org-empty">
          <p>
            Tim ini belum punya anggota.
            {canManage && " Tambahkan anggota organisasi di bawah, atau buat kode undangan untuk orang baru."}
          </p>
        </div>
      ) : (
        <ul className="row-list">
          {members.map((m) => {
            const person = ctx.member(m.publicKey);
            const self = ctx.isMe(m.publicKey);
            const label = ctx.name(m.publicKey);
            const canRemove = canManage && !self && (isSA || m.role !== "admin");
            const canAdmin = isSA && person?.orgRole !== "guest";
            return (
              <li key={m.publicKey} className="row">
                <div className="row-main">
                  <span className="row-name">
                    {label}
                    {self && <span className="row-you"> (Anda)</span>}
                  </span>
                  {person && <span className="row-sub mono">{person.fingerprint}</span>}
                </div>
                <span className={m.role === "admin" ? "chip chip-on" : "chip"}>{TEAM_ROLE_LABELS[m.role]}</span>
                <div className="row-actions">
                  {canAdmin && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={busy}
                      aria-busy={pending === `admin:${m.publicKey}` || undefined}
                      onClick={() =>
                        void act(
                          `admin:${m.publicKey}`,
                          () => api.setTeamAdmin(team.id, m.publicKey, m.role !== "admin"),
                          m.role === "admin"
                            ? `${label} sekarang anggota biasa di ${team.name}.`
                            : `${label} sekarang admin ${team.name}.`,
                          "Peran belum diubah",
                        )
                      }
                    >
                      {m.role === "admin" ? "Lepas admin tim" : "Jadikan admin tim"}
                    </button>
                  )}
                  {canRemove && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={busy}
                      aria-busy={pending === `remove:${m.publicKey}` || undefined}
                      onClick={() =>
                        void act(
                          `remove:${m.publicKey}`,
                          () => api.removeTeamMember(team.id, m.publicKey),
                          `${label} dikeluarkan dari ${team.name}. Ia tetap anggota organisasi.`,
                          "Anggota belum dikeluarkan dari tim",
                        )
                      }
                      aria-label={`Keluarkan ${label} dari tim`}
                    >
                      Keluarkan dari tim
                    </button>
                  )}
                  {self && (
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setLeaving(true)}>
                      Keluar dari tim
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {canManage && (
        <form className="add-member" onSubmit={addMember}>
          <div className="field">
            <label htmlFor={selectId}>Tambah anggota organisasi ke tim</label>
            {candidates.length === 0 ? (
              <p className="hint">
                Semua anggota organisasi sudah ada di tim ini. Untuk orang baru, buat kode undangan.
              </p>
            ) : (
              <div className="manual-row">
                <select id={selectId} value={candidate} onChange={(e) => setCandidate(e.target.value)} disabled={busy}>
                  <option value="">Pilih anggota</option>
                  {candidates.map((c) => (
                    <option key={c.publicKey} value={c.publicKey}>
                      {c.displayName} ({c.fingerprint})
                    </option>
                  ))}
                </select>
                <button type="submit" className="btn" disabled={busy || !candidate} aria-busy={pending?.startsWith("add:") || undefined}>
                  {pending?.startsWith("add:") ? "Menambahkan..." : "Tambahkan"}
                </button>
              </div>
            )}
          </div>
        </form>
      )}

      <InviteDialog
        open={inviting}
        onOpenChange={setInviting}
        ctx={ctx}
        teams={[team]}
        initialTeamId={team.id}
      />

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Hapus ${team.name}?`}
        confirmLabel="Hapus tim"
        busyLabel="Menghapus..."
        busy={pending === "delete-team"}
        onConfirm={async () => {
          const ok = await act("delete-team", () => api.deleteTeam(team.id), `${team.name} dihapus.`, "Tim belum dihapus");
          setDeleting(false);
          if (ok) onBack();
        }}
      >
        <p>
          Tim dan channel-nya hilang dari daftar di semua laptop anggota. Orang di tim ini tetap anggota organisasi, dan
          kode undangan untuk tim ini tidak bisa dipakai lagi.
        </p>
        <p>Tim yang sudah dihapus tidak bisa dikembalikan.</p>
      </ConfirmDialog>

      {me && (
        <ConfirmDialog
          open={leaving}
          onOpenChange={setLeaving}
          title={`Keluar dari ${team.name}?`}
          confirmLabel="Keluar dari tim"
          busyLabel="Keluar..."
          busy={pending === "leave-team"}
          onConfirm={async () => {
            const ok = await act(
              "leave-team",
              () => api.removeTeamMember(team.id, me.publicKey),
              `Anda keluar dari ${team.name}.`,
              "Belum bisa keluar dari tim",
            );
            setLeaving(false);
            if (ok && !isSA) onBack();
          }}
        >
          <p>
            Anda tidak lagi menerima isi tim ini. Untuk masuk lagi, minta admin tim menambahkan Anda atau membuat kode
            undangan.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}
