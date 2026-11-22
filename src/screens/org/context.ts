import type { Directory, MemberView } from "../../api";

// Menjalankan satu aksi di halaman Organisasi: menandai tombolnya sedang
// bekerja, menampilkan hasil di wilayah aria-live, lalu memuat ulang direktori.
export type Act = (key: string, run: () => Promise<unknown>, ok: string, failTitle: string) => Promise<boolean>;

export type OrgCtx = {
  dir: Directory;
  act: Act;
  pending: string | null;
  member: (publicKey: string) => MemberView | undefined;
  name: (publicKey: string) => string;
  isMe: (publicKey: string) => boolean;
  canManageTeam: (teamId: string) => boolean;
  reload: () => Promise<void>;
  notify: (text: string) => void;
};

export function makeCtx(
  dir: Directory,
  act: Act,
  pending: string | null,
  reload: () => Promise<void>,
  notify: (text: string) => void,
): OrgCtx {
  const byKey = new Map(dir.members.map((m) => [m.publicKey, m]));
  return {
    dir,
    act,
    pending,
    member: (pk) => byKey.get(pk),
    name: (pk) => byKey.get(pk)?.displayName ?? `Laptop ${pk.slice(0, 8)}`,
    isMe: (pk) => pk === dir.me.publicKey,
    canManageTeam: (teamId) => dir.me.isSuperadmin || dir.can.manageTeamIds.includes(teamId),
    reload,
    notify,
  };
}
