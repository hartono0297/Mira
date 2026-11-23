// Data uji untuk layar Chat. Nama dan kunci jelas buatan, hanya untuk tes.
import type { ChatOverview, ConversationSummary, Person } from "../../api/chat";

export const ME = "a".repeat(64);
export const PK_B = "b".repeat(64);
export const PK_C = "c".repeat(64);
export const TEAM_1 = "1".repeat(32);
export const PROJ_1 = "2".repeat(32);
export const PROJ_2 = "7".repeat(32);

export const REKAN_B: Person = { publicKey: PK_B, name: "Rekan Bayu" };
export const REKAN_C: Person = { publicKey: PK_C, name: "Rekan Citra" };

export const UMUM_ID = `ch:${"f".repeat(32)}`;
export const TIM_ID = `ch:${"9".repeat(32)}`;
export const PROYEK_ID = `ch:${PROJ_1}`;
export const PROYEK_CHAT_ID = `ch:${PROJ_2}`;
export const LAMA_ID = `ch:${"8".repeat(32)}`;
export const DM_B_ID = `dm:${ME}:${PK_B}`;
export const GRUP_ID = `gr:${"3".repeat(32)}`;
export const PENGUMUMAN_ID = `ch:${"4".repeat(32)}`;
export const BEKAS_ID = `ch:${"5".repeat(32)}`;

export function summary(id: string, name: string, extra: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    kind: id.startsWith("dm:") ? "dm" : id.startsWith("gr:") ? "group" : "channel",
    section: id.startsWith("dm:") ? "pribadi" : id.startsWith("gr:") ? "grup" : "umum",
    name,
    scope: id.startsWith("dm:") ? null : { kind: "org", id: null, name: "Kantor Uji" },
    peer: null,
    isUmum: false,
    archived: false,
    locked: false,
    former: false,
    memberCount: 3,
    muted: false,
    unread: 0,
    mentionUnread: 0,
    lastAt: null,
    lastPreview: null,
    canPost: true,
    postBlockedReason: null,
    canArchive: true,
    canDelete: true,
    canLock: false,
    ...extra,
  };
}

export const UMUM = summary(UMUM_ID, "umum", { isUmum: true, canArchive: false, canDelete: false });
export const TIM = summary(TIM_ID, "tim-uji", {
  scope: { kind: "team", id: TEAM_1, name: "Uji" },
  section: "departemen",
  unread: 3,
  mentionUnread: 1,
});
export const PROYEK = summary(PROYEK_ID, "proyek-alfa", {
  scope: { kind: "project", id: PROJ_1, name: "Alfa" },
  section: "proyek",
  muted: true,
  unread: 2,
});
export const LAMA = summary(LAMA_ID, "acara-lama", { archived: true });
export const DM_B = summary(DM_B_ID, "Rekan Bayu", { peer: REKAN_B, unread: 1 });
export const GRUP = summary(GRUP_ID, "Persiapan pameran", {
  scope: { kind: "group", id: "3".repeat(32), name: "Persiapan pameran" },
  memberCount: 5,
  canArchive: false,
  canDelete: false,
});
// Channel Umum hanya-baca (hanya superadmin yang menulis).
export const PENGUMUMAN = summary(PENGUMUMAN_ID, "pengumuman", {
  locked: true,
  canPost: false,
  postBlockedReason: "Hanya superadmin yang bisa menulis di channel ini.",
});
// Chat bawaan proyek (v0.4): tampil seperti grup, selalu di bagian Proyek.
export const PROYEK_CHAT = summary(PROYEK_CHAT_ID, "Gudang Baru", {
  kind: "project",
  scope: { kind: "project", id: PROJ_2, name: "Gudang Baru" },
  section: "proyek",
  memberCount: 4,
  canArchive: false,
  canDelete: false,
});
// Proyek yang saya sudah bukan anggotanya lagi: tetap tampil di akhir bagiannya.
export const BEKAS = summary(BEKAS_ID, "proyek-lama", {
  scope: { kind: "project", id: "5".repeat(32), name: "Lama" },
  section: "proyek",
  former: true,
  canPost: false,
  postBlockedReason: "Anda sudah bukan anggota proyek ini.",
});

export function overview(extra: Partial<ChatOverview> = {}): ChatOverview {
  return {
    me: ME,
    isSuperadmin: true,
    isGuest: false,
    canCreateChannel: true,
    canCreateOrgChannel: true,
    canCreateGroup: true,
    canDirectMessage: true,
    // Sengaja tidak urut bagian: daftar tetap menyusunnya Umum, Departemen, Proyek, Grup,
    // Pesan pribadi. Yang diarsipkan di akhir bagiannya.
    conversations: [TIM, UMUM, PROYEK, GRUP, DM_B, LAMA],
    people: [REKAN_C, REKAN_B],
    teams: [{ id: TEAM_1, name: "Uji" }],
    myDepartment: { id: TEAM_1, name: "Uji" },
    projects: [{ id: PROJ_1, name: "Alfa", teamId: TEAM_1 }],
    otherProjects: 0,
    notify: "all",
    folded: [],
    ...extra,
  };
}

export function guestOverview(extra: Partial<ChatOverview> = {}): ChatOverview {
  return overview({
    isSuperadmin: false,
    isGuest: true,
    canCreateChannel: false,
    canCreateOrgChannel: false,
    canCreateGroup: false,
    canDirectMessage: false,
    conversations: [],
    people: [],
    teams: [],
    myDepartment: null,
    projects: [],
    ...extra,
  });
}
