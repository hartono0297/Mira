import { useState } from "react";
import { api, ROLE_LABELS, type MemberView } from "../../api";
import { relativeTime } from "../../api/format";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { initials } from "../../components/initials";
import { useNetworkOptional, validStatus } from "../shell/NetworkContext";
import type { OrgCtx } from "./context";

export function MembersPanel({ ctx }: { ctx: OrgCtx }) {
  const { dir, act, pending } = ctx;
  const [removing, setRemoving] = useState<MemberView | null>(null);
  const network = validStatus(useNetworkOptional()?.data ?? null);
  const busy = pending !== null;
  const teamName = new Map(dir.teams.map((t) => [t.id, t.name]));
  const active = dir.members.filter((m) => m.status === "active");
  const removed = dir.members.filter((m) => m.status === "removed");

  function presence(m: MemberView): string | null {
    if (ctx.isMe(m.publicKey) || !network) return null;
    const peer = network.peers.find((p) => p.publicKey === m.publicKey);
    if (!peer) return null;
    if (peer.online) return "Online";
    return peer.lastSeenAt ? `Terakhir terlihat ${relativeTime(peer.lastSeenAt)}` : "Belum pernah terlihat";
  }

  function row(m: MemberView) {
    const self = ctx.isMe(m.publicKey);
    const teams = m.teams.map((t) => `${teamName.get(t.teamId) ?? "Tim lain"}${t.role === "admin" ? " (admin)" : ""}`);
    const seen = m.status === "active" ? presence(m) : null;
    const canPromote = dir.can.manageSuperadmins && m.status === "active" && !m.isSuperadmin && m.orgRole !== "guest";
    // Superadmin terakhir tidak bisa dilepas (Rust menolak dengan last_superadmin).
    const canDemote = dir.can.manageSuperadmins && m.status === "active" && m.isSuperadmin && dir.superadminCount > 1;
    const canRemove = dir.can.removeMembers && m.status === "active" && !self;
    return (
      <li key={m.publicKey} className={`row member${m.status === "removed" ? " member-off" : ""}`}>
        <span className="avatar member-avatar" aria-hidden="true">
          {initials(m.displayName)}
        </span>
        <div className="row-main">
          <span className="row-name">
            {m.displayName}
            {self && <span className="row-you"> (Anda)</span>}
          </span>
          <span className="row-sub mono">{m.fingerprint}</span>
          <span className="row-sub">
            {ROLE_LABELS[m.orgRole]}
            {m.status === "active" && (teams.length > 0 ? `. Tim: ${teams.join(", ")}` : ". Belum di tim mana pun")}
            {seen && `. ${seen}`}
          </span>
        </div>
        {m.status === "removed" && <span className="chip">Dikeluarkan</span>}
        {m.isSuperadmin && m.status === "active" && <span className="chip chip-on">Superadmin</span>}
        {(canPromote || canDemote || canRemove) && (
          <div className="row-actions">
            {canPromote && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                aria-busy={pending === `sa:${m.publicKey}` || undefined}
                aria-label={`Jadikan ${m.displayName} superadmin`}
                onClick={() =>
                  void act(
                    `sa:${m.publicKey}`,
                    () => api.addSuperadmin(m.publicKey),
                    `${m.displayName} sekarang superadmin.`,
                    "Superadmin belum ditambahkan",
                  )
                }
              >
                Jadikan superadmin
              </button>
            )}
            {canDemote && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                aria-busy={pending === `sa:${m.publicKey}` || undefined}
                aria-label={self ? "Lepas peran superadmin Anda" : `Lepas superadmin ${m.displayName}`}
                onClick={() =>
                  void act(
                    `sa:${m.publicKey}`,
                    () => api.removeSuperadmin(m.publicKey),
                    self ? "Anda bukan superadmin lagi." : `${m.displayName} bukan superadmin lagi.`,
                    "Superadmin belum dilepas",
                  )
                }
              >
                Lepas superadmin
              </button>
            )}
            {canRemove && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                aria-label={`Keluarkan ${m.displayName} dari organisasi`}
                onClick={() => setRemoving(m)}
              >
                Keluarkan dari organisasi
              </button>
            )}
          </div>
        )}
      </li>
    );
  }

  return (
    <section className="set-section" aria-labelledby="members-title">
      <h2 id="members-title" className="set-title">
        Anggota organisasi ({active.length})
      </h2>
      <p className="hint">
        Sidik jari adalah penanda kunci laptop tiap orang. Cocokkan dengan yang tertera di Pengaturan, bagian Laptop
        ini, di laptop orangnya kalau ragu.
      </p>
      {active.length === 0 ? (
        <div className="org-empty">
          <p>Belum ada anggota aktif.</p>
        </div>
      ) : (
        <ul className="row-list">{active.map(row)}</ul>
      )}
      {removed.length > 0 && (
        <>
          <h3 className="set-sub">Sudah dikeluarkan ({removed.length})</h3>
          <ul className="row-list">{removed.map(row)}</ul>
        </>
      )}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={removing ? `Keluarkan ${removing.displayName} dari organisasi?` : "Keluarkan dari organisasi?"}
        confirmLabel={removing ? `Keluarkan ${removing.displayName}` : "Keluarkan"}
        busyLabel="Mengeluarkan..."
        busy={pending === "remove-member"}
        onConfirm={async () => {
          if (!removing) return;
          const who = removing;
          await act(
            "remove-member",
            () => api.removeMember(who.publicKey),
            `${who.displayName} sudah dikeluarkan dari organisasi.`,
            "Anggota belum dikeluarkan",
          );
          setRemoving(null);
        }}
      >
        {removing && (
          <>
            <p>
              {removing.displayName} keluar dari semua tim dan kehilangan semua perannya. Laptopnya tidak menerima
              pesan dan perubahan baru lagi, dan laptop rekan menolak sambungan dari laptop itu.
            </p>
            <p>
              Data yang sudah ada di laptop {removing.displayName} tetap ada di sana. Mira tidak bisa menghapusnya dari
              jauh.
            </p>
            <p>
              Laptop itu tidak bisa bergabung lagi ke organisasi ini, juga dengan kode undangan baru. Langkah ini tidak
              bisa dibatalkan.
            </p>
          </>
        )}
      </ConfirmDialog>
    </section>
  );
}
