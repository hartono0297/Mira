// Tipe kontrak dengan inti Rust (docs/plans/tahap-0.md dan docs/plans/tahap-1.md bagian 4).

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

export type Membership = "none" | "active" | "removed";

export type AppState = {
  identity: IdentityInfo;
  organization: OrgInfo | null;
  membership: Membership;
  dataDir: string;
};

// Direktori organisasi

export type TeamRole = "admin" | "member";

export type MemberView = {
  publicKey: string;
  fingerprint: string;
  displayName: string;
  orgRole: Role;
  isSuperadmin: boolean;
  status: "active" | "removed";
  joinedAt: string;
  teams: { teamId: string; role: TeamRole }[];
};

export type TeamView = {
  id: string;
  name: string;
  createdAt: string;
  members: { publicKey: string; role: TeamRole }[];
};

export type InviteRole = "team_admin" | "member" | "guest";
export type InviteValidity = "24h" | "7d" | "once";
export type InviteStatus = "active" | "used" | "expired" | "revoked";

export type InviteView = {
  id: string;
  teamId: string;
  teamName: string;
  role: InviteRole;
  projectIds: string[];
  validity: InviteValidity;
  expiresAt: string;
  createdBy: string;
  createdAt: string;
  status: InviteStatus;
  usedBy: string[];
};

export type ChannelView = { id: string; name: string; teamId: string | null };

export type Directory = {
  org: OrgInfo;
  me: { publicKey: string; isSuperadmin: boolean };
  superadminCount: number;
  can: { createTeam: boolean; manageSuperadmins: boolean; removeMembers: boolean; manageTeamIds: string[] };
  members: MemberView[];
  teams: TeamView[];
  invites: InviteView[];
  channels: ChannelView[];
};

export type CreatedInvite = { code: string; invite: InviteView };

// Jaringan

export type NetState = "starting" | "no_org" | "alone" | "lan" | "vpn" | "offline" | "removed";
export type Route = "lan" | "vpn" | "local";

export type PeerView = {
  publicKey: string;
  displayName: string;
  fingerprint: string;
  orgRole: Role;
  online: boolean;
  route: Route | null;
  address: string | null;
  lastSeenAt: string | null;
};

export type ManualAddress = {
  address: string;
  addedAt: string;
  lastTriedAt: string | null;
  lastError: string | null;
  publicKey: string | null;
};

export type NetworkStatus = {
  state: NetState;
  listenPort: number | null;
  localAddresses: string[];
  shareLink: string;
  qrSvg: string;
  mdns: { ok: boolean; error: string | null };
  peers: PeerView[];
  manualAddresses: ManualAddress[];
};

export type FirewallRule = "allowed" | "blocked" | "missing" | "unknown";
export type NetworkCategory = "public" | "private" | "domain";

export type FirewallStatus = {
  supported: boolean;
  rule: FirewallRule;
  profiles: { name: string; category: NetworkCategory; interfaceAlias: string }[];
  programPath: string;
  adminCommand: string;
  detail: string | null;
};

export type RejectedChange = { at: string; peer: string | null; address: string | null; code: string; detail: string };

// Error

export type AppErrorCode =
  | "invalid_name"
  | "name_required"
  | "org_exists"
  | "keystore"
  | "key_mismatch"
  | "database"
  | "internal"
  | "invalid_setting"
  | "forbidden"
  | "not_found"
  | "invite_invalid"
  | "invite_not_found"
  | "invite_expired"
  | "invite_used"
  | "invite_revoked"
  | "no_peer_found"
  | "peer_unreachable"
  | "already_in_org"
  | "removed"
  | "last_superadmin"
  | "invalid_address"
  | "network"
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

export const TEAM_ROLE_LABELS: Record<TeamRole, string> = {
  admin: "Admin tim",
  member: "Anggota",
};

export const INVITE_ROLE_LABELS: Record<InviteRole, string> = {
  team_admin: "Admin tim",
  member: "Anggota",
  guest: "Tamu",
};

export const VALIDITY_LABELS: Record<InviteValidity, string> = {
  "24h": "24 jam",
  "7d": "7 hari",
  once: "Sekali pakai",
};

export const INVITE_STATUS_LABELS: Record<InviteStatus, string> = {
  active: "Aktif",
  used: "Terpakai",
  expired: "Kedaluwarsa",
  revoked: "Dicabut",
};
