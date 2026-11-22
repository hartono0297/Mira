import { useEffect, useId, useState, type FormEvent } from "react";
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
import { formatDateTime } from "../../api/format";
import { CopyButton } from "../../components/CopyButton";
import { Dialog, DialogClose } from "../../components/Dialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import type { OrgCtx } from "./context";

const ROLE_DESC: Record<InviteRole, string> = {
  member: "Chat, buat dan kerjakan task di semua proyek tim",
  team_admin: "Semua izin di tim ini, termasuk mengatur anggota",
  guest: "Lihat dan komentar di proyek yang dipilih",
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
  teams: TeamView[]; // tim yang boleh dipilih
  initialTeamId?: string;
};

export function InviteDialog({ open, onOpenChange, ctx, teams, initialTeamId }: Props) {
  const isSA = ctx.dir.me.isSuperadmin;
  const [teamId, setTeamId] = useState(initialTeamId ?? teams[0]?.id ?? "");
  const [role, setRole] = useState<InviteRole>("member");
  const [validity, setValidity] = useState<InviteValidity>("24h");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const teamSelect = useId();
  const validitySelect = useId();
  const validityHint = useId();

  // Setiap kali dialog dibuka, mulai dari form kosong. Kode lama tidak pernah tampil lagi.
  useEffect(() => {
    if (open) {
      setTeamId(initialTeamId ?? teams[0]?.id ?? "");
      setRole("member");
      setValidity("24h");
      setError(null);
      setCreated(null);
    }
  }, [open]);

  const team = teams.find((t) => t.id === teamId);
  const single = teams.length === 1 && initialTeamId !== undefined;
  const title = created
    ? "Kode undangan siap"
    : single && team
      ? `Undang ke ${team.name}`
      : "Undang ke tim";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !teamId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.createInvite(teamId, role, validity, []);
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
              <label htmlFor={teamSelect}>Tim</label>
              {teams.length === 0 ? (
                <p className="hint">Anda belum mengelola tim mana pun. Kode undangan selalu untuk satu tim.</p>
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
            <RoleOption
              value="guest"
              role={role}
              onPick={setRole}
              disabled
              note="Belum bisa dipilih. Tamu diundang ke proyek tertentu, dan proyek baru hadir di Tahap 3."
            />
          </fieldset>

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
                title={error.code === "forbidden" ? "Anda tidak punya izin mengundang ke tim ini" : "Kode belum dibuat"}
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
            <button type="submit" className="btn" disabled={busy || !teamId} aria-busy={busy || undefined}>
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
  note,
}: {
  value: InviteRole;
  role: InviteRole;
  onPick: (role: InviteRole) => void;
  disabled: boolean;
  note?: string;
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
          {note && <span className="role-note">{note}</span>}
        </span>
      </span>
    </label>
  );
}
