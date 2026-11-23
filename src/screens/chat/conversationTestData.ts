// Data uji panel percakapan. Nama dan kunci jelas buatan, hanya untuk tes.
import type {
  ConversationEvent,
  ConversationSummary,
  ConversationView,
  FileView,
  GroupMemberView,
  GroupView,
  MessageView,
  Person,
  ProjectChatMember,
  ProjectChatView,
} from "../../api/chat";
import type { PersonView } from "../../api/org";

export const ME = "a".repeat(64);
export const PK_B = "b".repeat(64);
export const PK_C = "c".repeat(64);
export const CH = `ch:${"1".repeat(32)}`;
export const DM = `dm:${ME}:${PK_B}`;
export const GR = `gr:${"3".repeat(32)}`;
export const PK_D = "d".repeat(64);
export const PK_E = "e".repeat(64);
export const PJ = `ch:${"4".repeat(32)}`;

export const penguji: Person = { publicKey: ME, name: "Penguji" };
export const sari: Person = { publicKey: PK_B, name: "Sari Uji" };
export const budi: Person = { publicKey: PK_C, name: "Budi Uji" };
export const dimas: Person = { publicKey: PK_D, name: "Dimas Uji" };
export const wulan: Person = { publicKey: PK_E, name: "Wulan Uji" };

// Waktu lokal hari ini, supaya label hari tidak bergantung zona waktu mesin uji.
export function today(hour: number, minute: number): string {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

export function channel(extra: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: CH,
    kind: "channel",
    section: "proyek",
    name: "proyek-a",
    scope: { kind: "project", id: "2".repeat(32), name: "Gedung A" },
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

export function dm(extra: Partial<ConversationSummary> = {}): ConversationSummary {
  return channel({
    id: DM,
    kind: "dm",
    name: "Sari Uji",
    scope: null,
    peer: sari,
    canArchive: false,
    canDelete: false,
    ...extra,
  });
}

export function file(extra: Partial<FileView> = {}): FileView {
  return {
    hash: "f".repeat(64),
    name: "kontrak-draft.pdf",
    size: 1258291,
    mime: "application/pdf",
    state: "local",
    autoDownload: true,
    ...extra,
  };
}

export function message(extra: Partial<MessageView> = {}): MessageView {
  return {
    id: "m1",
    conv: CH,
    author: sari,
    at: today(9, 12),
    text: "Halo semua",
    mentions: [],
    replyTo: null,
    files: [],
    deleted: false,
    mine: false,
    status: null,
    canDelete: false,
    ...extra,
  };
}

export function view(messages: MessageView[], extra: Partial<ConversationView> = {}): ConversationView {
  return {
    conversation: channel(),
    members: [penguji, sari, budi],
    messages,
    hasMore: false,
    events: [],
    ...extra,
  };
}

// Grup v0.3

export function group(extra: Partial<ConversationSummary> = {}): ConversationSummary {
  return channel({
    id: GR,
    kind: "group",
    section: "grup",
    name: "Persiapan pameran",
    scope: null,
    memberCount: 3,
    canArchive: false,
    canDelete: false,
    ...extra,
  });
}

export function member(person: Person, extra: Partial<GroupMemberView> = {}): GroupMemberView {
  return { person, owner: false, me: false, addedBy: penguji, canRemove: false, ...extra };
}

// Saya (Penguji) pemilik grup berisi Sari dan Budi; Dimas dan Wulan bisa ditambahkan.
export function groupView(extra: Partial<GroupView> = {}): GroupView {
  return {
    conv: GR,
    name: "Persiapan pameran",
    owner: penguji,
    createdBy: penguji,
    createdAt: today(9, 0),
    members: [
      member(penguji, { owner: true, me: true, addedBy: null }),
      member(sari, { canRemove: true }),
      member(budi, { canRemove: true }),
    ],
    candidates: [dimas, wulan],
    canAdd: true,
    canRename: true,
    canLeave: true,
    former: false,
    ...extra,
  };
}

// Sudut pandang anggota biasa: Sari pemilik, saya anggota.
export function groupViewAsMember(extra: Partial<GroupView> = {}): GroupView {
  return groupView({
    owner: sari,
    createdBy: sari,
    members: [
      member(sari, { owner: true, addedBy: null }),
      member(penguji, { me: true, addedBy: sari }),
      member(budi, { addedBy: sari }),
    ],
    canRename: true,
    ...extra,
  });
}

// Chat proyek v0.4: tampil seperti grup, anggotanya anggota proyek di board.

export function project(extra: Partial<ConversationSummary> = {}): ConversationSummary {
  return channel({
    id: PJ,
    kind: "project",
    section: "proyek",
    name: "Gedung Alfa",
    scope: { kind: "project", id: "5".repeat(32), name: "Gedung Alfa" },
    memberCount: 3,
    canArchive: false,
    canDelete: false,
    ...extra,
  });
}

export function projectMember(person: Person, extra: Partial<ProjectChatMember> = {}): ProjectChatMember {
  return { person, me: false, manager: false, ...extra };
}

// Sari pengelola proyek; saya dan Budi anggota biasa.
export function projectChatView(extra: Partial<ProjectChatView> = {}): ProjectChatView {
  return {
    conv: PJ,
    projectId: "5".repeat(32),
    name: "Gedung Alfa",
    members: [
      projectMember(budi),
      projectMember(penguji, { me: true }),
      projectMember(sari, { manager: true }),
    ],
    canManage: false,
    former: false,
    ...extra,
  };
}

export function event(extra: Partial<ConversationEvent> = {}): ConversationEvent {
  return {
    id: "e1",
    at: today(9, 0),
    text: "Penguji membuat grup ini dan menambahkan Sari Uji dan Budi Uji.",
    ...extra,
  };
}

// Data orgApi.people() untuk departemen di pemilih dan daftar anggota.
export function personView(person: Person, departmentName: string | null): PersonView {
  return {
    publicKey: person.publicKey,
    displayName: person.name,
    fingerprint: "0000 0000",
    role: "member",
    isSuperadmin: false,
    isGuest: false,
    departmentId: departmentName ? departmentName.toLowerCase() : null,
    departmentName,
    departmentRole: departmentName ? "member" : null,
    labels: [],
  };
}

export const orgPeople: PersonView[] = [
  personView(penguji, "Desain"),
  personView(sari, "Drafting"),
  personView(budi, "Drafting"),
  personView(dimas, "Desain"),
  personView(wulan, "Keuangan"),
];
