import { useState } from "react";
import { divisionApi, type DeptMember } from "../../api/division";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { DIVISION_TEXT } from "../../i18n/org-division";
import type { DeptCtx } from "./myDepartmentShared";

type Role = "superadmin" | "admin" | "head" | "member";

// Peran tertinggi yang dipegang orang ini di departemen.
export function roleOf(m: DeptMember): Role {
  if (m.isSuperadmin) return "superadmin";
  if (m.isAdmin) return "admin";
  if (m.divisions.some((d) => d.role === "head")) return "head";
  return "member";
}

function divisionText(m: DeptMember): string {
  const T = DIVISION_TEXT.members;
  if (m.divisions.length === 0) return T.noDivision;
  return T.divisions(m.divisions.map((d) => (d.role === "head" ? T.headOf(d.name) : d.name)).join(", "));
}

export function MyDepartmentMembers({ dept }: { dept: DeptCtx }) {
  const T = DIVISION_TEXT.members;
  const { ov, page, busy } = dept;
  const [demoting, setDemoting] = useState<DeptMember | null>(null);
  // Mengangkat admin oleh admin departemen ikut gerbang versi; superadmin memakai op lama.
  // Selama gerbang tertutup tombolnya tetap tampil, nonaktif, dengan penjelasan di atas daftar.
  const showActs = ov.canManageDept && !ov.archived;
  const gated = showActs && !ov.gate.open && !ov.me.isSuperadmin;
  const gateId = "md-members-gate";
  const members = [...ov.members].sort((a, b) => a.displayName.localeCompare(b.displayName));

  function setAdmin(m: DeptMember, admin: boolean) {
    void page.act(
      `md:admin:${m.publicKey}`,
      () => divisionApi.setDeptAdmin(ov.teamId, m.publicKey, admin),
      admin ? T.madeAdmin(m.displayName) : T.removedAdmin(m.displayName),
      admin ? T.makeAdminFail : T.removeAdminFail,
    );
  }

  return (
    <section className="set-section md-block" aria-labelledby="md-members-title">
      <div className="org-head">
        <h2 id="md-members-title" className="set-title">
          {T.title}
        </h2>
        <span className="hint md-count-line">{T.count(members.length)}</span>
      </div>
      {gated && dept.gateHint && (
        <p id={gateId} className="hint">
          {dept.gateHint}
        </p>
      )}
      {members.length === 0 ? (
        <div className="org-empty">
          <p>{T.empty}</p>
        </div>
      ) : (
        <ul className="row-list">
          {members.map((m) => {
            const role = roleOf(m);
            const online = m.isMe || m.online;
            const pending = page.pending === `md:admin:${m.publicKey}`;
            return (
              <li key={m.publicKey} className="row">
                <div className="row-main">
                  <span className="row-name">
                    {m.displayName}
                    {m.isMe && <span className="row-you"> {T.you}</span>}
                  </span>
                  <span className="row-sub">{divisionText(m)}</span>
                  {m.labels.length > 0 && (
                    <span className="row-sub">{T.labels(m.labels.map((l) => l.name).join(", "))}</span>
                  )}
                </div>
                <span className={role === "superadmin" || role === "admin" ? "chip chip-on" : "chip"}>
                  <span className="sr-only">{T.roleSr} </span>
                  {T.role[role]}
                </span>
                <span className="md-status">
                  <span className={online ? "md-dot" : "md-dot md-dot-off"} aria-hidden="true" />
                  {m.isMe ? T.thisLaptop : online ? T.online : T.offline}
                </span>
                {showActs && (
                  <div className="row-actions">
                    {/* Satu tombol yang berganti label, supaya fokus tetap di tempat setelah peran berubah. */}
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={busy || gated}
                      aria-busy={pending || undefined}
                      aria-label={m.isAdmin ? T.removeAdminAria(m.displayName) : T.makeAdminAria(m.displayName)}
                      aria-describedby={gated && dept.gateHint ? gateId : undefined}
                      onClick={() => (m.isAdmin ? setDemoting(m) : setAdmin(m, true))}
                    >
                      {m.isAdmin ? T.removeAdmin : T.makeAdmin}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={demoting !== null}
        onOpenChange={(open) => {
          if (!open) setDemoting(null);
        }}
        title={demoting?.isMe ? T.confirmTitleSelf : T.confirmTitle(demoting?.displayName ?? "")}
        confirmLabel={T.confirm}
        busyLabel={T.confirming}
        busy={false}
        onConfirm={() => {
          const target = demoting;
          setDemoting(null);
          if (target) setAdmin(target, false);
        }}
      >
        <p>{demoting?.isMe ? T.confirmBodySelf : T.confirmBody}</p>
      </ConfirmDialog>
    </section>
  );
}
