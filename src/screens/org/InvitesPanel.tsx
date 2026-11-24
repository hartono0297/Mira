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
import { INVITE_TEXT } from "../../i18n/org-invites";
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
  const T = INVITE_TEXT.panel;
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
    const by = T.createdBy(ctx.name(inv.createdBy), formatDateTime(inv.createdAt));
    const used = inv.usedBy.length > 0 ? T.usedBy(inv.usedBy.map((pk) => ctx.name(pk)).join(", ")) : "";
    const until =
      inv.status === "active"
        ? T.validUntil(formatDateTime(inv.expiresAt))
        : inv.status === "expired"
          ? T.endedAt(formatDateTime(inv.expiresAt))
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
      ctx.notify(INVITE_TEXT.panel.revoked(name));
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
            {T.redeemTitle}
          </h2>
          <p className="hint">{T.redeemHint}</p>
        </div>
        <RedeemForm ctx={ctx} labelledBy="invites-title" />
      </section>
    );
  }

  return (
    <section className="set-section" aria-labelledby="invites-title">
      <div className="org-head">
        <h2 id="invites-title" className="set-title" ref={titleRef} tabIndex={-1}>
          {T.title}
        </h2>
        {manageable.length > 0 && (
          <button type="button" className="btn" onClick={() => setInviting(true)}>
            <IconTicket size={16} aria-hidden="true" />
            {T.create}
          </button>
        )}
      </div>
      <p className="hint">{T.hint}</p>
      {noOpenDepartment && invites.length > 0 && (
        <p className="hint">{T.noOpenDepartment}</p>
      )}

      {invites.length === 0 ? (
        <div className="org-empty">
          <p>
            {manageable.length > 0 ? T.emptyManage : noOpenDepartment ? T.emptyNoOpen : T.emptyNone}
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
                    aria-label={T.revokeAria(label(inv))}
                    onClick={() => {
                      setRevokeError(null);
                      setRevoking(inv);
                    }}
                  >
                    {T.revoke}
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
        title={revoking ? T.revokeTitle(label(revoking)) : T.revokeTitleFallback}
        confirmLabel={T.revokeConfirm}
        busyLabel={T.revoking}
        busy={revokeBusy}
        onConfirm={() => void revoke()}
        error={
          revokeError && (
            <ErrorAlert title={T.revokeFailed}>
              <p>{revokeError.message}</p>
            </ErrorAlert>
          )
        }
      >
        <p>{T.revokeBody}</p>
      </ConfirmDialog>

      <InviteDialog open={inviting} onOpenChange={setInviting} ctx={ctx} teams={manageable} />
    </section>
  );
}
