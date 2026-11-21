// Tipe kontrak dengan inti Rust (docs/plans/tahap-0.md, "Kontrak tampilan dan inti Rust").

export type Role = "superadmin" | "team_admin" | "member" | "guest";

export type IdentityInfo = {
  publicKey: string;
  fingerprint: string;
  displayName: string | null;
  createdAt: string;
};

export type OrgInfo = {
  id: string;
  name: string;
  role: Role;
  createdAt: string;
};

export type AppState = {
  identity: IdentityInfo;
  organization: OrgInfo | null;
  dataDir: string;
};

export type AppErrorCode =
  | "invalid_name"
  | "name_required"
  | "org_exists"
  | "keystore"
  | "key_mismatch"
  | "database"
  | "internal"
  | "invalid_setting"
  // Kode khusus tampilan, tidak dikirim oleh Rust:
  | "no_tauri"
  | "unknown";

export type AppError = { code: AppErrorCode | (string & {}); message: string };

export const ROLE_LABELS: Record<Role, string> = {
  superadmin: "Superadmin",
  team_admin: "Admin tim",
  member: "Anggota",
  guest: "Tamu",
};
