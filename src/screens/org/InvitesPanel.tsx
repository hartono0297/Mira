import { IconTicket } from "@tabler/icons-react";
import { useState } from "react";
import { api, INVITE_ROLE_LABELS, INVITE_STATUS_LABELS, VALIDITY_LABELS, type InviteView } from "../../api";
import { formatDateTime } from "../../api/format";
import { orgApi } from "../../api/org";
import type { OrgCtx } from "./context";
import { InviteDialog } from "./InviteDialog";
import { RedeemForm } from "./RedeemForm";
import { useOrgLive } from "./useOrgLive";

const ORDER: Record<InviteView["status"], number> = { active: 0, used: 1, expired: 2, revoked: 3 };

type Props = {
  ctx: OrgCtx;
  // Hanya orang tanpa departemen (termasuk Tamu) yang bisa memakai kode di sini;
  // orang yang sudah di departemen ditolak `already_in_department`.
  canRedeem: boolean;
};

export function InvitesPanel({ ctx, canRedeem }: Props) {
  const { dir, act, pending } = ctx;
  const [inviting, setInviting] = useState(false);
  // Directory.teams ikut memuat departemen yang diarsipkan, padahal kode undangan
  // hanya bisa dibuat untuk departemen terbuka. Selama daftar departemen terbuka
  // belum terbaca, jangan blokir: Rust tetap menolak departemen yang diarsipkan.
  const open = useOrgLive(() => orgApi.departments(false));
  const openIds = Array.isArray(open.data) ? new Set(open.data.filter((d) => !d.archived).map((d) => d.id)) : null;
  const manageable = dir.teams.filter((t) => ctx.canManageTeam(t.id) && (openIds === null || openIds.has(t.id)));
  const invites = [...dir.invites].sort(
    (a, b) => ORDER[a.status] - ORDER[b.status] || b.createdAt.localeCompare(a.createdAt),
  );
  const busy = pending !== null;
  // Superadmin boleh mengundang ke departemen mana pun; kalau tidak ada yang
  // terbuka, sebabnya departemen, bukan izin.
  const noOpenDepartment = dir.me.isSuperadmin && manageable.length === 0;

  function detail(inv: InviteView): string {
    const by = `Dibuat ${ctx.name(inv.createdBy)}, ${formatDateTime(inv.createdAt)}.`;
    const used = inv.usedBy.length > 0 ? ` Dipakai oleh ${inv.usedBy.map((pk) => ctx.name(pk)).join(", ")}.` : "";
    const until =
      inv.status === "active"
        ? ` Berlaku sampai ${formatDateTime(inv.expiresAt)}.`
        : inv.status === "expired"
          ? ` Berakhir ${formatDateTime(inv.expiresAt)}.`
          : "";
    return by + until + used;
  }

  return (
    <section className="set-section" aria-labelledby="invites-title">
      <div className="org-head">
        <h2 id="invites-title" className="set-title">
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
                <span className="row-name">
                  {inv.teamName}, {INVITE_ROLE_LABELS[inv.role]}
                </span>
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
                    aria-busy={pending === `revoke:${inv.id}` || undefined}
                    aria-label={`Cabut kode undangan ${inv.teamName}, ${INVITE_ROLE_LABELS[inv.role]}`}
                    onClick={() =>
                      void act(
                        `revoke:${inv.id}`,
                        () => api.revokeInvite(inv.id),
                        `Kode undangan untuk ${inv.teamName} dicabut. Kode itu tidak bisa dipakai lagi.`,
                        "Kode belum dicabut",
                      )
                    }
                  >
                    {pending === `revoke:${inv.id}` ? "Mencabut..." : "Cabut"}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {canRedeem && <RedeemForm ctx={ctx} />}

      <InviteDialog open={inviting} onOpenChange={setInviting} ctx={ctx} teams={manageable} />
    </section>
  );
}
