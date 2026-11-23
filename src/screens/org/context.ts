import type { Directory, MemberView } from "../../api";
import type { OrgOverview } from "../../api/org";

// Menjalankan satu aksi di halaman Organisasi: menandai tombolnya sedang
// bekerja, menampilkan hasil di wilayah aria-live, lalu memuat ulang data.
// Hasil true kalau berhasil.
export type Act = (key: string, run: () => Promise<unknown>, ok: string, failTitle: string) => Promise<boolean>;

// Yang dibagi ke setiap tab v0.3 (Pengguna, Departemen, Permintaan, Label, Anggota).
export type OrgPage = {
  overview: OrgOverview;
  act: Act;
  // Kunci aksi yang sedang berjalan (misalnya "move:<kunci>"), null kalau tidak ada.
  pending: string | null;
  notify: (text: string) => void;
  // Naik setelah setiap aksi berhasil; berikan ke useOrgLive({ version }).
  version: number;
  // Minta semua tab memuat ulang (misalnya setelah dialog yang memanggil API sendiri).
  refresh: () => void;
  isMe: (publicKey: string) => boolean;
};

// Konteks lama berbasis direktori, masih dipakai tab Undangan.
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
