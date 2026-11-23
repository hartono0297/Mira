import { IconTicket } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import {
  api,
  INVITE_ROLE_LABELS,
  INVITE_STATUS_LABELS,
  toAppError,
  VALIDITY_LABELS,
  type AppError,
  type InviteView,
} from "../../api";
import { formatDateTime } from "../../api/format";
import { orgApi } from "../../api/org";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import type { OrgCtx } from "./context";
import { InviteDialog } from "./InviteDialog";
import { RedeemForm } from "./RedeemForm";
import { useOrgLive } from "./useOrgLive";

const ORDER: Record<InviteView["status"], number> = { active: 0, used: 1, expired: 2, revoked: 3 };

type Props = {
  ctx: OrgCtx;
  // Hanya orang tanpa departemen yang bukan Tamu yang bisa memakai kode di sini;
  // orang yang sudah di departemen ditolak `already_in_department`.
  canRedeem: boolean;
};

export function InvitesPanel({ ctx, canRedeem }: Props) {
  const { dir, pending } = ctx;
  const [inviting, setInviting] = useState(false);
  // Mencabut tidak bisa dibatalkan, jadi lewat konfirmasi. Error tampil di dialog.
  const [revoking, setRevoking] = useState<InviteView | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<AppError | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  // Id kode yang baru dicabut: begitu tombol Cabut-nya hilang dari daftar, fokus
  // pindah ke judul tab supaya tidak jatuh ke body.
  const focusAfterRevoke = useRef<string | null>(null);

  useEffect(() => {
    const id = focusAfterRevoke.current;
    if (!id || revoking) return;
    if (!dir.invites.some((i) => i.id === id && i.status === "active")) {
      focusAfterRevoke.current = null;
      titleRef.current?.focus();
    }
  }, [dir.invites, revoking]);
  // Directory.teams ikut memuat departemen yang diarsipkan, padahal kode undangan
  // hanya bisa dibuat untuk departemen terbuka. Selama daftar departemen terbuka
  // belum terbaca, jangan blokir: Rust tetap menolak departemen yang diarsipkan.
  const open = useOrgLive(() => orgApi.departments(false));
  const openIds = Array.isArray(open.data) ? new Set(open.data.filter((d) => !d.archived).map((d) => d.id)) : null;
  const manageable = dir.teams.filter((t) => ctx.canManageTeam(t.id) && (openIds === null || openIds.has(t.id)));
  const invites = [...dir.invites].sort(
    (a, b) => ORDER[a.status] - ORDER[b.status] || b.createdAt.localeCompare(a.createdAt),
  );
  const busy = pending !== null || revokeBusy;
  // Superadmin boleh mengundang ke departemen mana pun; kalau tidak ada yang
  // terbuka, sebabnya departemen, bukan izin.
  const noOpenDepartment = dir.me.isSuperadmin && manageable.length === 0;
  // Bukan superadmin dan tidak mengelola departemen mana pun (juga yang diarsipkan):
  // tab ini hanya untuk memakai kode, jadi teks pengelola dan daftar kode disembunyikan.
  const redeemOnly = canRedeem && !dir.me.isSuperadmin && dir.can.manageTeamIds.length === 0;

  function detail(inv: InviteView): string {
    const by = `Dibuat oleh ${ctx.name(inv.createdBy)}, ${formatDateTime(inv.createdAt)}.`;
    const used = inv.usedBy.length > 0 ? ` Dipakai oleh ${inv.usedBy.map((pk) => ctx.name(pk)).join(", ")}.` : "";
    const until =
      inv.status === "active"
        ? ` Berlaku sampai ${formatDateTime(inv.expiresAt)}.`
        : inv.status === "expired"
          ? ` Berakhir ${formatDateTime(inv.expiresAt)}.`
          : "";
    return by + until + used;
  }

  function label(inv: InviteView): string {
    return `${inv.teamName}, ${INVITE_ROLE_LABELS[inv.role]}`;
  }

  async function revoke() {
    if (!revoking || revokeBusy) return;
    setRevokeBusy(true);
    setRevokeError(null);
    try {
      await api.revokeInvite(revoking.id);
      const name = revoking.teamName;
      focusAfterRevoke.current = revoking.id;
      setRevoking(null);
      ctx.notify(`Kode undangan untuk ${name} dicabut. Kode itu tidak bisa dipakai lagi.`);
      await ctx.reload();
    } catch (err) {
      setRevokeError(toAppError(err));
    } finally {
      setRevokeBusy(false);
    }
  }

  if (redeemOnly) {
    return (
      <section className="set-section" aria-labelledby="invites-title">
        <div>
          <h2 id="invites-title" className="set-title">
            Pakai kode undangan
          </h2>
          <p className="hint">Anda belum masuk departemen mana pun. Admin yang mengundang Anda memberikan kodenya.</p>
        </div>
        <RedeemForm ctx={ctx} labelledBy="invites-title" />
      </section>
    );
  }

  return (
    <section className="set-section" aria-labelledby="invites-title">
      <div className="org-head">
        <h2 id="invites-title" className="set-title" ref={titleRef} tabIndex={-1}>
          Kode undangan
        </h2>
        {manageable.length > 0 && (
          <button type="button" className="btn" onClick={() => setInviting(true)}>
            <IconTicket size={16} aria-hidden="true" />
            Buat kode undangan
          </button>
        )}
      </div>
      <p className="hint">
        Isi kode hanya ditampilkan sekali, saat kode dibuat. Di sini terlihat status dan masa berlakunya.
      </p>
      {noOpenDepartment && invites.length > 0 && (
        <p className="hint">
          Kode baru belum bisa dibuat karena belum ada departemen yang tidak diarsipkan. Buat atau pulihkan departemen di
          tab Departemen.
        </p>
      )}

      {invites.length === 0 ? (
        <div className="org-empty">
          <p>
            {manageable.length > 0
              ? "Belum ada kode undangan. Buat kode untuk mengundang orang baru ke departemen."
              : noOpenDepartment
                ? "Belum ada kode undangan. Kode hanya bisa dibuat untuk departemen yang tidak diarsipkan, dan saat ini belum ada. Buat atau pulihkan departemen di tab Departemen."
                : "Belum ada kode undangan yang bisa Anda kelola. Kode undangan dibuat oleh admin departemen dan superadmin."}
          </p>
        </div>
      ) : (
        <ul className="row-list">
          {invites.map((inv) => (
            <li key={inv.id} className="row">
              <div className="row-main">
                <span className="row-name">{label(inv)}</span>
                <span className="row-sub">
                  {VALIDITY_LABELS[inv.validity]}. {detail(inv)}
                </span>
              </div>
              <span className={inv.status === "active" ? "chip chip-on" : "chip"}>{INVITE_STATUS_LABELS[inv.status]}</span>
              {inv.status === "active" && (
                <div className="row-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    aria-label={`Cabut kode undangan ${label(inv)}`}
                    onClick={() => {
                      setRevokeError(null);
                      setRevoking(inv);
                    }}
                  >
                    Cabut
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {canRedeem && <RedeemForm ctx={ctx} />}

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(next) => {
          if (!next) setRevoking(null);
        }}
        title={revoking ? `Cabut kode undangan ${label(revoking)}?` : "Cabut kode undangan?"}
        confirmLabel="Cabut kode"
        busyLabel="Mencabut..."
        busy={revokeBusy}
        onConfirm={() => void revoke()}
        error={
          revokeError && (
            <ErrorAlert title="Kode belum dicabut">
              <p>{revokeError.message}</p>
            </ErrorAlert>
          )
        }
      >
        <p>
          Orang yang belum memakai kode ini tidak bisa bergabung dengannya lagi. Orang yang sudah bergabung lewat kode
          ini tetap di organisasi. Pencabutan tidak bisa dibatalkan. Kalau masih perlu, buat kode baru.
        </p>
      </ConfirmDialog>

      <InviteDialog open={inviting} onOpenChange={setInviting} ctx={ctx} teams={manageable} />
    </section>
  );
}
