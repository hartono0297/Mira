// Data uji untuk layar Chat. Nama dan kunci jelas buatan, hanya untuk tes.
import type { ChatOverview, ConversationSummary, Person } from "../../api/chat";

export const ME = "a".repeat(64);
export const PK_B = "b".repeat(64);
export const PK_C = "c".repeat(64);
export const TEAM_1 = "1".repeat(32);
export const PROJ_1 = "2".repeat(32);

export const REKAN_B: Person = { publicKey: PK_B, name: "Rekan Bayu" };
export const REKAN_C: Person = { publicKey: PK_C, name: "Rekan Citra" };

export const UMUM_ID = `ch:${"f".repeat(32)}`;
export const TIM_ID = `ch:${"9".repeat(32)}`;
export const PROYEK_ID = `ch:${PROJ_1}`;
export const LAMA_ID = `ch:${"8".repeat(32)}`;
export const DM_B_ID = `dm:${ME}:${PK_B}`;

export function summary(id: string, name: string, extra: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    kind: id.startsWith("dm:") ? "dm" : "channel",
    name,
    scope: id.startsWith("dm:") ? null : { kind: "org", id: null, name: "Kantor Uji" },
    peer: null,
    isUmum: false,
    archived: false,
    muted: false,
    unread: 0,
    mentionUnread: 0,
    lastAt: null,
    lastPreview: null,
    canPost: true,
    canArchive: true,
    canDelete: true,
    ...extra,
  };
}

export const UMUM = summary(UMUM_ID, "umum", { isUmum: true, canArchive: false, canDelete: false });
export const TIM = summary(TIM_ID, "tim-uji", {
  scope: { kind: "team", id: TEAM_1, name: "Uji" },
  unread: 3,
  mentionUnread: 1,
});
export const PROYEK = summary(PROYEK_ID, "proyek-alfa", {
  scope: { kind: "project", id: PROJ_1, name: "Alfa" },
  muted: true,
  unread: 2,
});
export const LAMA = summary(LAMA_ID, "acara-lama", { archived: true });
export const DM_B = summary(DM_B_ID, "Rekan Bayu", { peer: REKAN_B, unread: 1 });

export function overview(extra: Partial<ChatOverview> = {}): ChatOverview {
  return {
    me: ME,
    canCreateChannel: true,
    canCreateOrgChannel: true,
    canDirectMessage: true,
    // Urutan seperti dari inti: channel aktif, chat pribadi, lalu yang diarsipkan.
    conversations: [TIM, UMUM, PROYEK, DM_B, LAMA],
    people: [REKAN_C, REKAN_B],
    teams: [{ id: TEAM_1, name: "Uji" }],
    projects: [{ id: PROJ_1, name: "Alfa", teamId: TEAM_1 }],
    notify: "all",
    ...extra,
  };
}

export function guestOverview(extra: Partial<ChatOverview> = {}): ChatOverview {
  return overview({
    canCreateChannel: false,
    canCreateOrgChannel: false,
    canDirectMessage: false,
    conversations: [],
    people: [],
    teams: [],
    projects: [],
    ...extra,
  });
}
