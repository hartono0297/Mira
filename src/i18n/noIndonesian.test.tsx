// Sampel layar utama dalam bahasa Inggris: tidak boleh ada teks tampilan
// berbahasa Indonesia yang tersisa (isi, aria-label, title, placeholder, alt).
//
// Seluruh aplikasi dirender dari App dengan inti Rust tiruan. Data pengguna
// (nama orang, proyek, file, isi pesan) sengaja berbahasa Inggris, supaya yang
// tertangkap hanya teks tampilan. Yang dicari adalah kata fungsi dan kata
// antarmuka bahasa Indonesia yang tidak mungkin muncul dalam kalimat Inggris.
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { AppState, Directory, InviteView, NetworkStatus } from "../api";
import type { BoardView, MyTask, OutsideProject, ProjectSummary, TaskCard, TaskDetail } from "../api/board";
import type { ChatOverview, ConversationSummary, ConversationView, MessageView, Person } from "../api/chat";
import type { DocumentSummary, DocumentVersion, PersonRef } from "../api/documents";
import type { DepartmentView, JoinRequestView, LabelView, OrgOverview, PersonView, UserView } from "../api/org";
import type { RequestSummary, SignOverview } from "../api/signing";
import { renderInLang } from "../test/i18n";
import { ThemeProvider } from "../theme/ThemeProvider";
import { setLang } from "./core";

const { invoke, FakeChannel } = vi.hoisted(() => {
  class FakeChannel<T> {
    onmessage: (message: T) => void = () => {};
  }
  return { invoke: vi.fn(), FakeChannel };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: FakeChannel }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
// Penampil PDF memuat pdf.js yang tidak jalan di jsdom; yang diperiksa di sini daftar Tanda tangan.
vi.mock("../screens/sign/SignDocumentView", () => ({ SignDocumentView: () => null }));
vi.mock("../screens/sign/pad/SignatureSetupDialog", () => ({ SignatureSetupDialog: () => null }));

// ---------------------------------------------------------------------------
// Pemindai teks Indonesia

// Kata fungsi dan kata antarmuka yang tidak mungkin muncul dalam teks Inggris.
// "Dikerjakan" dan "Selesai" adalah nama kolom bawaan dari inti Rust yang harus
// diterjemahkan tampilan.
const WORDS = [
  "yang", "dan", "untuk", "dengan", "belum", "sudah", "tidak", "Anda", "ini", "itu", "dari", "pada",
  "akan", "bisa", "harus", "oleh", "atau", "kalau", "lagi", "baru", "semua", "Simpan", "Batal", "Hapus",
  "Tutup", "Buka", "Kirim", "Tambah", "Pilih", "Cari", "Pesan", "Tugas", "Pengaturan", "Organisasi",
  "Dokumen", "Hari ini", "Kemarin", "menit", "jam", "hari", "di", "ke", "tanpa", "saat", "sedang",
  "masih", "Proyek", "Anggota", "Tamu", "Tenggat", "Dikerjakan", "Selesai", "Ubah", "Keluar", "Lihat",
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
const PATTERN = new RegExp(`(?<![\\p{L}\\p{N}])(?:${WORDS.map(escape).join("|")})(?![\\p{L}\\p{N}])`, "giu");

// Teks yang memang boleh tampil apa adanya: nama bahasa ditulis dalam bahasanya sendiri.
const ALLOWED = ["Bahasa Indonesia"];

const ATTRS = ["aria-label", "title", "placeholder", "alt", "aria-description", "aria-roledescription", "aria-valuetext"];

// Elemen yang teks lengkapnya ikut diperiksa, supaya frasa yang terpecah di
// beberapa node teks ("Hari" + " ini") tetap tertangkap.
const BLOCKS = "p, h1, h2, h3, h4, h5, h6, button, label, li, td, th, option, legend, dt, dd, a, summary, caption";

function describeEl(el: Element | null): string {
  if (!el) return "?";
  const tag = el.tagName.toLowerCase();
  const cls = typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/)[0]}` : "";
  const role = el.getAttribute("role");
  return `${tag}${cls}${role ? `[role=${role}]` : ""}`;
}

type Finding = { screen: string; word: string; where: string; text: string };

type Item = { where: string; text: string };

// Semua teks yang dibaca orang atau pembaca layar: node teks, teks lengkap
// elemen blok, dan atribut aksesibilitas.
function collect(root: Element = document.body): Item[] {
  const items: Item[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim();
    if (!text) continue;
    const parent = node.parentElement;
    if (parent?.closest("script, style")) continue;
    items.push({ where: describeEl(parent), text });
  }
  for (const el of root.querySelectorAll(BLOCKS)) {
    const text = el.textContent?.replace(/\s+/g, " ").trim();
    if (text) items.push({ where: describeEl(el), text });
  }
  for (const el of [root, ...root.querySelectorAll("*")]) {
    for (const attr of ATTRS) {
      const value = el.getAttribute(attr);
      if (value?.trim()) items.push({ where: `${describeEl(el)}@${attr}`, text: value.trim() });
    }
    if (el instanceof HTMLInputElement && (el.type === "submit" || el.type === "button") && el.value) {
      items.push({ where: `${describeEl(el)}@value`, text: el.value });
    }
  }
  return items;
}

function scan(label: string, root: Element = document.body, items: Item[] = collect(root)): Finding[] {
  const seen = new Set<string>();
  const found: Finding[] = [];
  for (const { where, text } of items) {
    let clean = text;
    for (const ok of ALLOWED) clean = clean.split(ok).join(" ");
    for (const match of clean.matchAll(PATTERN)) {
      const key = `${match[0].toLowerCase()}|${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ screen: label, word: match[0], where, text: text.length > 160 ? `${text.slice(0, 157)}...` : text });
    }
  }
  return found;
}

const line = (f: Finding) => `[${f.screen}] "${f.word}" di ${f.where}: ${f.text}`;

// anchors: teks Inggris yang harus ikut terpindai, bukti layar yang benar
// sudah tampil dalam bahasa Inggris (bukan layar memuat atau layar kosong).
function englishFindings(label: string, anchors: string[]): string[] {
  const items = collect();
  const all = items.map((i) => i.text).join(" | ");
  const missing = anchors.filter((a) => !all.includes(a));
  expect(missing, `Teks Inggris yang diharapkan tidak tampil di layar "${label}"`).toEqual([]);
  return scan(label, document.body, items).map(line);
}

function expectEnglish(label: string, anchors: string[]) {
  expect(englishFindings(label, anchors), `Teks Indonesia tersisa di layar "${label}" saat bahasa Inggris aktif`).toEqual([]);
}

// Tunggu pemuatan dan efek lanjutan selesai sebelum memindai.
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}

// ---------------------------------------------------------------------------
// Data uji berbahasa Inggris

const ME = "a".repeat(64);
const PK_B = "b".repeat(64);
const PK_C = "c".repeat(64);
const PK_D = "d".repeat(64);
const TEAM_1 = "1".repeat(32);
const TEAM_2 = "2".repeat(32);
const PROJ_1 = "6".repeat(32);
const PROJ_2 = "7".repeat(32);
const LABEL_1 = "4".repeat(32);

const alex: Person = { publicKey: ME, name: "Alex Morgan" };
const sam: Person = { publicKey: PK_B, name: "Sam Lee" };
const jordan: Person = { publicKey: PK_C, name: "Jordan Park" };

const ORG = { id: "e".repeat(32), name: "Northwind Studio", role: "superadmin" as const, createdAt: "2026-11-01T01:05:00Z" };

const READY: AppState = {
  identity: { publicKey: ME, fingerprint: "AAAA BBBB CCCC DDDD", displayName: "Alex Morgan", createdAt: "2026-11-01T01:00:00Z" },
  organization: ORG,
  membership: "active",
  dataDir: "C:\\data\\mira",
};

function at(daysAgo: number, hour: number, minute = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function isoDay(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

// Chat

function conv(id: string, name: string, extra: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    kind: "channel",
    section: "umum",
    name,
    scope: { kind: "org", id: null, name: ORG.name },
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
    canLock: true,
    ...extra,
  };
}

const GENERAL = conv(`ch:${"f".repeat(32)}`, "general", {
  isUmum: true,
  canArchive: false,
  canDelete: false,
  canLock: false,
  lastAt: at(0, 9, 12),
  lastPreview: "Sam Lee: The contract draft is ready for review.",
});
const DESIGN = conv(`ch:${"9".repeat(32)}`, "design", {
  section: "departemen",
  scope: { kind: "team", id: TEAM_1, name: "Design" },
  unread: 3,
  mentionUnread: 1,
  lastAt: at(1, 16, 40),
  lastPreview: "Jordan Park: Updated the moodboard.",
});
const HARBOR_CHAT = conv(`ch:${PROJ_1}`, "Harbor Tower", {
  kind: "project",
  section: "proyek",
  scope: { kind: "project", id: PROJ_1, name: "Harbor Tower" },
  memberCount: 4,
  muted: true,
  unread: 2,
  canArchive: false,
  canDelete: false,
  canLock: false,
});
const GROUP = conv(`gr:${"3".repeat(32)}`, "Expo prep", {
  kind: "group",
  section: "grup",
  scope: { kind: "group", id: "3".repeat(32), name: "Expo prep" },
  memberCount: 5,
  canArchive: false,
  canDelete: false,
  canLock: false,
});
const DM_SAM = conv(`dm:${ME}:${PK_B}`, "Sam Lee", {
  kind: "dm",
  section: "pribadi",
  scope: null,
  peer: sam,
  unread: 1,
  canArchive: false,
  canDelete: false,
  canLock: false,
});
const OLD = conv(`ch:${"8".repeat(32)}`, "old-event", { archived: true, canLock: false });

const CHAT_OVERVIEW: ChatOverview = {
  me: ME,
  isSuperadmin: true,
  isGuest: false,
  canCreateChannel: true,
  canCreateOrgChannel: true,
  canCreateGroup: true,
  canDirectMessage: true,
  conversations: [GENERAL, DESIGN, HARBOR_CHAT, GROUP, DM_SAM, OLD],
  people: [sam, jordan],
  teams: [{ id: TEAM_1, name: "Design" }],
  myDepartment: { id: TEAM_1, name: "Design" },
  projects: [{ id: PROJ_1, name: "Harbor Tower", teamId: TEAM_1 }],
  otherProjects: 2,
  notify: "all",
  folded: [],
};

function msg(id: string, extra: Partial<MessageView> = {}): MessageView {
  return {
    id,
    conv: GENERAL.id,
    author: sam,
    at: at(0, 9, 12),
    text: "Morning everyone",
    mentions: [],
    replyTo: null,
    files: [],
    deleted: false,
    mine: false,
    status: null,
    canDelete: false,
    reactions: [],
    sticker: null,
    ...extra,
  };
}

const MESSAGES: ConversationView = {
  conversation: GENERAL,
  members: [alex, sam, jordan],
  hasMore: true,
  events: [],
  canReact: true,
  messages: [
    msg("m1", { at: at(1, 15, 5), author: jordan, text: "Site visit moved to Thursday." }),
    msg("m2", {
      at: at(1, 15, 20),
      author: alex,
      mine: true,
      canDelete: true,
      text: "Thanks, noted.",
      status: { state: "read", read: 2, delivered: 2, deposited: 0, total: 2 },
    }),
    msg("m3", {
      text: "The contract draft is ready for review.",
      files: [
        { hash: "f".repeat(64), name: "contract-draft.pdf", size: 1_258_291, mime: "application/pdf", state: "local", autoDownload: true },
        { hash: "e".repeat(64), name: "site-photos.zip", size: 48_000_000, mime: "application/zip", state: "remote", autoDownload: false },
      ],
    }),
    msg("m4", {
      at: at(0, 9, 30),
      author: alex,
      mine: true,
      canDelete: true,
      text: "@Sam Lee great, reading it now.",
      mentions: [sam],
      replyTo: { id: "m3", author: sam, preview: "The contract draft is ready for review.", deleted: false },
      status: { state: "delivered", read: 0, delivered: 2, deposited: 0, total: 2 },
    }),
    msg("m5", { at: at(0, 9, 40), author: jordan, text: "", deleted: true }),
    msg("m6", {
      at: at(0, 9, 45),
      author: alex,
      mine: true,
      canDelete: true,
      text: "Sending the revised plan.",
      status: { state: "pending", read: 0, delivered: 0, deposited: 0, total: 2 },
    }),
  ],
};

// Orang dan organisasi

function personView(p: Person, extra: Partial<PersonView> = {}): PersonView {
  return {
    publicKey: p.publicKey,
    displayName: p.name,
    fingerprint: `${p.publicKey.slice(0, 4).toUpperCase()} 0000 0000 0000`,
    role: "member",
    isSuperadmin: false,
    isGuest: false,
    departmentId: TEAM_1,
    departmentName: "Design",
    departmentRole: "member",
    labels: [],
    ...extra,
  };
}

const PEOPLE: PersonView[] = [
  personView(alex, { role: "superadmin", isSuperadmin: true, departmentRole: "admin" }),
  personView(sam, { labels: [{ id: LABEL_1, name: "Architect" }] as never }),
  personView(jordan, { departmentId: TEAM_2, departmentName: "Finance" }),
];

function userView(p: PersonView, extra: Partial<UserView> = {}): UserView {
  return {
    ...p,
    status: "active",
    joinedAt: "2026-11-04T02:00:00Z",
    removedAt: null,
    device: { laptop: "LAPTOP-NW-01", os: "Windows 11 24H2", appVersion: "0.4.0", reportedAt: minutesAgo(30) },
    lastIp: "192.168.1.23",
    online: true,
    lastSeenAt: null,
    isMe: p.publicKey === ME,
    guestProjectCount: 0,
    ...extra,
  };
}

const USERS: UserView[] = [
  userView(PEOPLE[0]),
  userView(PEOPLE[1], { online: false, lastSeenAt: minutesAgo(5) }),
  userView(PEOPLE[2], { online: false, lastSeenAt: minutesAgo(60 * 26), device: null, lastIp: null }),
  userView(personView({ publicKey: PK_D, name: "Casey Kim" }, {
    role: "guest",
    isGuest: true,
    departmentId: null,
    departmentName: null,
    departmentRole: null,
  }), { guestProjectCount: 2 }),
];

const ORG_OVERVIEW: OrgOverview = {
  publicKey: ME,
  isSuperadmin: true,
  isGuest: false,
  departmentId: TEAM_1,
  decideJoinTeamIds: [TEAM_1, TEAM_2],
  pendingJoinCount: 1,
  manageOrg: true,
};

function department(id: string, name: string, extra: Partial<DepartmentView> = {}): DepartmentView {
  return {
    id,
    name,
    createdAt: "2026-11-02T03:00:00Z",
    archived: false,
    archivedAt: null,
    memberCount: 2,
    admins: [],
    channelId: `c${id.slice(1)}`,
    channelName: name.toLowerCase(),
    ...extra,
  };
}

const DEPARTMENTS: DepartmentView[] = [
  department(TEAM_1, "Design", { admins: [{ publicKey: ME, displayName: "Alex Morgan" }] as never }),
  department(TEAM_2, "Finance", { memberCount: 1 }),
  department("5".repeat(32), "Archive Team", { archived: true, archivedAt: "2026-11-10T03:00:00Z", memberCount: 0 }),
];

const LABELS: LabelView[] = [
  { id: LABEL_1, name: "Architect", archived: false, createdAt: "2026-11-03T03:00:00Z", memberKeys: [PK_B] },
  { id: "6".repeat(32), name: "Surveyor", archived: true, createdAt: "2026-11-03T03:00:00Z", memberKeys: [] },
];

const JOIN_REQUESTS: JoinRequestView[] = [
  {
    id: "req-1",
    publicKey: "9".repeat(64),
    displayName: "Riley Chen",
    teamId: TEAM_1,
    teamName: "Design",
    laptop: "LAPTOP-RILEY",
    os: "Windows 11 24H2",
    appVersion: "0.4.0",
    requestedAt: minutesAgo(12),
    receivedAt: minutesAgo(12),
    code: "4F2A 91C0",
    ip: "192.168.1.40",
    seenByName: "Alex Morgan",
    note: "New drafter, starting Monday.",
    account: "riley",
    ad: null,
    requesterOutdated: false,
  },
];

function invite(id: string, extra: Partial<InviteView> = {}): InviteView {
  return {
    id,
    teamId: TEAM_1,
    teamName: "Design",
    role: "member",
    projectIds: [],
    validity: "7d",
    expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    createdBy: ME,
    createdAt: minutesAgo(90),
    status: "active",
    usedBy: [],
    ...extra,
  };
}

const DIRECTORY: Directory = {
  org: ORG,
  me: { publicKey: ME, isSuperadmin: true },
  // Satu superadmin: pemberitahuan "hanya satu superadmin" ikut tampil.
  superadminCount: 1,
  can: { createTeam: true, manageSuperadmins: true, removeMembers: true, manageTeamIds: [TEAM_1, TEAM_2] },
  members: USERS.map((u) => ({
    publicKey: u.publicKey,
    fingerprint: u.fingerprint,
    displayName: u.displayName,
    orgRole: u.role === "superadmin" ? "superadmin" : u.isGuest ? "guest" : "member",
    isSuperadmin: u.isSuperadmin,
    status: "active",
    joinedAt: u.joinedAt,
    teams: u.departmentId ? [{ teamId: u.departmentId, role: u.departmentRole === "admin" ? "admin" : "member" }] : [],
  })) as Directory["members"],
  teams: [
    { id: TEAM_1, name: "Design", createdAt: "2026-11-02T03:00:00Z", members: [{ publicKey: ME, role: "admin" }, { publicKey: PK_B, role: "member" }] },
    { id: TEAM_2, name: "Finance", createdAt: "2026-11-02T03:00:00Z", members: [{ publicKey: PK_C, role: "member" }] },
  ] as Directory["teams"],
  invites: [
    invite("i1"),
    invite("i2", { role: "guest", validity: "once", projectIds: [PROJ_1] }),
    invite("i3", { status: "used", usedBy: [PK_C], validity: "24h" }),
    invite("i4", { status: "expired", expiresAt: minutesAgo(60 * 30) }),
  ],
  channels: [
    { id: "f".repeat(32), name: "general", teamId: null },
    { id: "9".repeat(32), name: "design", teamId: TEAM_1 },
  ],
};

// Board

const PROJECT: ProjectSummary = {
  id: PROJ_1,
  code: "HT",
  name: "Harbor Tower",
  teamId: TEAM_1,
  teamName: "Design",
  openCount: 2,
  taskCount: 3,
  canManage: true,
};

const PROJECT_2: ProjectSummary = { ...PROJECT, id: PROJ_2, code: "RV", name: "River Villa", openCount: 0, taskCount: 0, teamId: null, teamName: null };

function card(n: number, extra: Partial<TaskCard> = {}): TaskCard {
  return {
    id: String(n).padStart(32, "0"),
    code: `HT-${n}`,
    title: `Task title ${n}`,
    columnId: "todo",
    assignee: null,
    due: null,
    priority: "none",
    labels: [],
    commentCount: 0,
    merged: false,
    subtaskDone: 0,
    subtaskTotal: 0,
    trackedSecs: 0,
    timersRunningSince: [],
    canEdit: true,
    canDelete: true,
    myTimerRunning: false,
    ...extra,
  };
}

const CARD_1 = card(1, {
  title: "Revise floor plan",
  assignee: sam,
  due: isoDay(-2),
  priority: "high",
  labels: ["legal"],
  commentCount: 2,
  subtaskDone: 1,
  subtaskTotal: 3,
  trackedSecs: 3 * 3600 + 20 * 60,
});
const CARD_2 = card(2, {
  title: "Order site survey",
  columnId: "doing",
  assignee: alex,
  due: isoDay(0),
  priority: "medium",
  merged: true,
  timersRunningSince: [minutesAgo(25)],
  myTimerRunning: true,
});
const CARD_3 = card(3, { title: "Kickoff meeting notes", columnId: "done", due: isoDay(1), priority: "low" });

const BOARD: BoardView = {
  project: PROJECT,
  columns: [
    { id: "todo", name: "To do", tasks: [CARD_1] },
    { id: "doing", name: "Dikerjakan", tasks: [CARD_2] },
    { id: "done", name: "Selesai", tasks: [CARD_3] },
  ],
  assignees: [alex, sam],
  me: ME,
  canCreate: true,
};

const EMPTY_BOARD: BoardView = {
  ...BOARD,
  project: PROJECT_2,
  columns: [
    { id: "todo", name: "To do", tasks: [] },
    { id: "doing", name: "Dikerjakan", tasks: [] },
    { id: "done", name: "Selesai", tasks: [] },
  ],
};

const MY_TASKS: MyTask[] = [
  { projectId: PROJ_1, projectCode: "HT", projectName: "Harbor Tower", task: { ...CARD_2, assignee: alex } },
  { projectId: PROJ_1, projectCode: "HT", projectName: "Harbor Tower", task: { ...CARD_1, assignee: alex } },
  { projectId: PROJ_1, projectCode: "HT", projectName: "Harbor Tower", task: card(4, { title: "Send invoices", due: isoDay(5), assignee: alex }) },
  { projectId: PROJ_1, projectCode: "HT", projectName: "Harbor Tower", task: card(5, { title: "Book venue", due: null, assignee: alex }) },
];

const OUTSIDE: OutsideProject[] = [
  {
    id: "8".repeat(32),
    code: "LB",
    name: "Lakeside Bridge",
    teamId: TEAM_2,
    teamName: "Finance",
    creatorName: "Jordan Park",
    memberCount: 3,
    createdAt: "2026-11-05T03:00:00Z",
  },
];

const TASK: TaskDetail = {
  ...CARD_1,
  projectId: PROJ_1,
  description: "Check the stair core dimensions.\nThen update the section drawings.",
  createdBy: alex,
  createdAt: at(5, 9),
  updatedAt: at(0, 8),
  comments: [
    { id: "c1", author: sam, at: at(1, 10), body: "Started on the ground floor." },
    { id: "c2", author: alex, at: minutesAgo(3), body: "Looks good so far." },
  ],
  activity: [
    { at: at(5, 9), actor: alex, kind: "created", detail: "" },
    { at: at(4, 9), actor: sam, kind: "moved", detail: "doing" },
    { at: at(3, 9), actor: alex, kind: "assignee", detail: "Sam Lee" },
    { at: at(3, 10), actor: alex, kind: "due", detail: isoDay(-2) },
    { at: at(3, 11), actor: alex, kind: "priority", detail: "high" },
    { at: at(2, 9), actor: alex, kind: "labels", detail: "legal" },
    { at: at(2, 10), actor: sam, kind: "commented", detail: "" },
    { at: at(2, 11), actor: sam, kind: "subtask_added", detail: "Measure stairs" },
    { at: at(1, 9), actor: sam, kind: "subtask_done", detail: "Measure stairs" },
    { at: at(1, 11), actor: alex, kind: "time_logged", detail: "3600" },
    { at: at(0, 8), actor: alex, kind: "title", detail: "Revise floor plan" },
  ],
  canEdit: true,
  canDelete: true,
  canComment: true,
  subtasks: [
    { id: "s1", title: "Measure stairs", done: true, assignee: sam, doneBy: sam, doneAt: at(1, 9), createdBy: sam },
    { id: "s2", title: "Redraw level 2", done: false, assignee: alex, doneBy: null, doneAt: null, createdBy: alex },
    { id: "s3", title: "Send to client", done: false, assignee: null, doneBy: null, doneAt: null, createdBy: alex },
  ],
  timeEntries: [
    { id: "t1", person: alex, start: at(1, 10), end: at(1, 11), manual: true, note: "Drafting", secs: 3600, mine: true },
    { id: "t2", person: sam, start: at(2, 13), end: at(2, 15, 20), manual: false, note: "", secs: 8400, mine: false },
  ],
  timeTotals: [
    { person: alex, secs: 3600, runningSince: null },
    { person: sam, secs: 8400, runningSince: null },
  ],
  myRunningEntry: null,
  statusTime: {
    closedSecs: { todo: 86_400, doing: 2 * 86_400, done: 0 },
    currentColumn: "todo",
    currentSince: at(2, 9),
    cycleSecs: null,
    clockWarning: true,
  },
};

// Dokumen

const meRef: PersonRef = { publicKey: ME, displayName: "Alex Morgan", isMe: true };
const samRef: PersonRef = { publicKey: PK_B, displayName: "Sam Lee", isMe: false };

function version(docId: string, number: number, extra: Partial<DocumentVersion> = {}): DocumentVersion {
  return {
    id: `${docId}-v${number}`,
    number,
    size: 24_576,
    blobHash: String(number).repeat(64).slice(0, 64),
    author: meRef,
    createdAt: at(number, 10),
    origin: number === 1 ? "added" : "edited",
    restoredFromNumber: null,
    parentIds: number === 1 ? [] : [`${docId}-v${number - 1}`],
    isHead: false,
    received: false,
    available: true,
    downloading: false,
    autoDownload: false,
    ...extra,
  };
}

function doc(id: string, name: string, extra: Partial<DocumentSummary> = {}): DocumentSummary {
  const kind = name.endsWith(".xlsx") ? "excel" : name.endsWith(".pdf") ? "pdf" : name.endsWith(".docx") ? "word" : "other";
  return {
    id,
    name,
    kind,
    projectId: null,
    teamId: null,
    createdAt: at(6, 9),
    createdBy: meRef,
    current: version(id, 1, { isHead: true }),
    versionCount: 1,
    conflict: false,
    conflictVersions: [],
    editing: [],
    can: { edit: true, restore: true, resolve: true, export: true },
    ...extra,
  } as DocumentSummary;
}

const V5 = version("d1", 5, { isHead: true, parentIds: ["d1-v3"] });
const V4 = version("d1", 4, { isHead: true, author: samRef, received: true });
const DOCS: DocumentSummary[] = [
  doc("d1", "contract.docx", { current: V5, versionCount: 5, conflict: true, conflictVersions: [V5, V4] }),
  doc("d2", "budget.xlsx", {
    current: version("d2", 3, { isHead: true, author: samRef, received: true }),
    versionCount: 3,
    editing: [{ editor: samRef, since: minutesAgo(20), local: false, lastSavedAt: minutesAgo(4) }],
  }),
  doc("d3", "site-photos.pdf", {
    current: version("d3", 2, { isHead: true, available: false, author: samRef, received: true, size: 30_000_000 }),
    versionCount: 2,
  }),
  doc("d4", "minutes.docx", { editing: [{ editor: meRef, since: minutesAgo(10), local: true, lastSavedAt: null }] }),
];

function docDetail(id: string) {
  const d = DOCS.find((x) => x.id === id) ?? DOCS[0];
  const versions = Array.from({ length: d.versionCount }, (_, i) => d.versionCount - i).map((n) =>
    n === d.current.number ? d.current : n === 4 && d.id === "d1" ? V4 : version(d.id, n, { restoredFromNumber: n === 3 ? 1 : null, origin: n === 3 ? "restored" : n === 1 ? "added" : "edited" } as Partial<DocumentVersion>),
  );
  return { ...d, versions };
}

// Tanda tangan

function request(id: string, title: string, extra: Partial<RequestSummary> = {}): RequestSummary {
  return {
    id: id.repeat(32).slice(0, 32),
    title,
    mode: "sequential",
    status: "in_progress",
    myState: "waiting_others",
    signedCount: 1,
    signerCount: 2,
    createdAt: at(3, 9),
    updatedAt: at(1, 9),
    completedAt: null,
    integrity: "intact",
    exportWarnings: 0,
    fromPeer: true,
    requestedByName: "Sam Lee",
    fileAvailable: true,
    fileSize: 2048,
    pending: false,
    downloadSize: 0,
    downloading: false,
    ...extra,
  };
}

const SIGN: SignOverview = {
  saved: {
    width: 300,
    height: 120,
    createdAt: at(10, 9),
    failedAttempts: 1,
    lockedUntil: null,
    attemptsLeft: 4,
    usableAfter: null,
  },
  requests: [
    request("1", "Lease agreement", { myState: "your_turn", mode: "parallel" }),
    request("2", "Supplier contract", { fromPeer: false, requestedByName: "Alex Morgan" }),
    request("3", "Handover letter", {
      status: "completed",
      myState: "signed",
      signedCount: 2,
      completedAt: at(2, 14),
      exportWarnings: 1,
    }),
    request("4", "Old quote", { status: "cancelled", myState: "not_involved" }),
    request("5", "Site report", { fileAvailable: false, downloadSize: 5_000_000, pending: true }),
    request("6", "Tampered memo", { integrity: "changed" }),
  ],
  canRequest: true,
  me: { publicKey: ME, displayName: "Alex Morgan", kind: "member" },
};

// Jaringan

const NETWORK: NetworkStatus = {
  state: "lan",
  listenPort: 47800,
  localAddresses: ["192.168.1.10:47800"],
  shareLink: `mira://peer?pk=${ME}&addr=192.168.1.10:47800`,
  qrSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#fff"/></svg>',
  mdns: { ok: true, error: null },
  peers: [
    { publicKey: PK_B, displayName: "Sam Lee", fingerprint: "BBBB 0000 0000 0000", orgRole: "member", online: true, route: "lan", address: "192.168.1.20:47800", lastSeenAt: null },
    { publicKey: PK_C, displayName: "Jordan Park", fingerprint: "CCCC 0000 0000 0000", orgRole: "member", online: false, route: "vpn", address: null, lastSeenAt: minutesAgo(130) },
  ],
  manualAddresses: [{ address: "10.8.0.5:47800", addedAt: at(2, 9) }],
} as unknown as NetworkStatus;

const FIREWALL = {
  platform: "windows",
  supported: true,
  rule: "missing",
  profiles: [{ name: "Office Network", category: "private", interfaceAlias: "Wi-Fi" }],
  programPath: "C:\\Program Files\\Mira\\mira.exe",
  adminCommand: 'New-NetFirewallRule -DisplayName "Mira" -Direction Inbound -Protocol UDP -Action Allow',
  detail: null,
};

// ---------------------------------------------------------------------------
// Inti Rust tiruan

type Handler = (args: Record<string, unknown> | undefined) => unknown;
type Answer = Handler | object | string | number | boolean | null;

function backend(overrides: Record<string, Answer> = {}) {
  const settings: Record<string, string> = {
    "update.last_check": new Date().toISOString(),
    "whats_new.seen": "0.4.0",
  };
  const table: Record<string, Answer> = {
    get_app_state: READY,
    get_setting: (a) => settings[String(a?.key)] ?? null,
    set_setting: (a) => {
      settings[String(a?.key)] = String(a?.value);
      return null;
    },
    update_info: { currentVersion: "0.4.0", configured: true },
    get_network_status: NETWORK,
    get_firewall_status: FIREWALL,
    get_rejected_changes: [],
    get_directory: DIRECTORY,
    chat_overview: CHAT_OVERVIEW,
    chat_messages: MESSAGES,
    chat_mark_read: null,
    chat_message_receipts: [],
    board_list_projects: [PROJECT, PROJECT_2],
    board_get_board: (a) => (a?.projectId === PROJ_2 ? EMPTY_BOARD : BOARD),
    board_my_tasks: MY_TASKS,
    board_outside_projects: OUTSIDE,
    board_get_task: TASK,
    list_documents: DOCS,
    get_document: (a) => docDetail(String(a?.documentId)),
    sign_overview: SIGN,
    org_overview: ORG_OVERVIEW,
    org_fingerprint: "7KQ2-M9XD",
    org_people: PEOPLE,
    org_users: USERS,
    org_departments: DEPARTMENTS,
    org_labels: LABELS,
    org_join_requests: JOIN_REQUESTS,
    org_project_members: {
      projectId: PROJ_1,
      registered: true,
      teamId: TEAM_1,
      creator: ME,
      members: [],
      canManage: true,
      canLeave: true,
      canJoinSelf: false,
    },
    join_device: { laptop: "LAPTOP-NW-01", os: "Windows 11", appVersion: "0.4.0", account: "alex", addresses: ["192.168.1.10"] },
    join_outgoing: null,
    ...overrides,
  };
  invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (!(cmd in table)) return null;
    const entry = table[cmd];
    return typeof entry === "function" ? (entry as Handler)(args) : entry;
  });
}

function renderApp() {
  return renderInLang(
    () => (
      <ThemeProvider>
        <App />
      </ThemeProvider>
    ),
    "en",
  );
}

// Menu sidebar dibuka menurut urutannya (Chat, Board, Dokumen, Tanda tangan,
// Organisasi, Pengaturan), tidak menurut namanya, supaya label yang belum
// diterjemahkan tetap dilaporkan lewat pemindai, bukan gagal mencari tombol.
const NAV = { chat: 0, board: 1, docs: 2, sign: 3, org: 4, settings: 5 } as const;

async function openSection(user: ReturnType<typeof userEvent.setup>, id: keyof typeof NAV) {
  const nav = await waitFor(() => {
    const el = document.querySelector("aside nav");
    if (!el) throw new Error("menu sidebar belum tampil");
    return el as HTMLElement;
  });
  await user.click(within(nav).getAllByRole("button")[NAV[id]]);
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  try {
    window.localStorage.clear();
  } catch {
    // Tanpa localStorage: tidak ada pilihan tersimpan yang perlu dibersihkan.
  }
});

afterEach(() => {
  setLang("id");
});

// ---------------------------------------------------------------------------

describe("tidak ada teks Indonesia tersisa saat bahasa Inggris aktif", () => {
  it("pemindai menangkap teks Indonesia (kontrol)", () => {
    const box = document.createElement("div");
    box.innerHTML =
      '<p>Simpan perubahan</p><button aria-label="Tutup panel">x</button><input placeholder="Cari pesan">' +
      "<p>Saved today</p><p>Bahasa Indonesia</p><p>2 jam lalu</p><p>Hari<span> ini</span></p>";
    const words = scan("kontrol", box).map((f) => f.word.toLowerCase().replace(/\s+/g, " "));
    expect(new Set(words)).toEqual(new Set(["cari", "hari", "ini", "hari ini", "jam", "pesan", "simpan", "tutup"]));
  });

  it("pemindai menangkap layar yang sama dalam bahasa Indonesia (kontrol)", async () => {
    backend();
    renderInLang(
      () => (
        <ThemeProvider>
          <App />
        </ThemeProvider>
      ),
      "id",
    );
    expect(await screen.findByText("Site visit moved to Thursday.")).toBeInTheDocument();
    await settle();
    const words = new Set(scan("kontrol id").map((f) => f.word.toLowerCase()));
    expect([...words]).toEqual(expect.arrayContaining(["pengaturan", "kirim", "hari ini", "kemarin"]));
  });

  it("kerangka dan Chat: daftar percakapan dan percakapan terbuka", async () => {
    backend();
    renderApp();
    expect((await screen.findAllByText("The contract draft is ready for review.")).length).toBeGreaterThan(0);
    expect(await screen.findByText("Site visit moved to Thursday.")).toBeInTheDocument();
    await settle();
    expectEnglish("Shell + Chat", ["Main menu", "Settings", "Send", "Today", "Yesterday", "Direct messages"]);
  });

  it("Board: board proyek dengan task", async () => {
    backend();
    const user = userEvent.setup();
    renderApp();
    await openSection(user, "board");
    expect(await screen.findByText("Revise floor plan")).toBeInTheDocument();
    expect(await screen.findByText("Lakeside Bridge", { exact: false })).toBeInTheDocument();
    await settle();
    expectEnglish("Board: proyek", ["My tasks", "New project", "Keyboard shortcuts", "In progress", "Done"]);
  });

  it("Board: proyek tanpa task", async () => {
    backend();
    const user = userEvent.setup();
    renderApp();
    await openSection(user, "board");
    await user.click(await screen.findByRole("button", { name: /River Villa/ }));
    await waitFor(() => expect(document.querySelectorAll(".tc-open")).toHaveLength(0));
    await settle();
    expectEnglish("Board: proyek kosong", ["No tasks in this column yet."]);
  });

  it("Board: Task saya", async () => {
    backend();
    const user = userEvent.setup();
    renderApp();
    await openSection(user, "board");
    const boardNav = await waitFor(() => {
      const el = document.querySelector("nav.bd-nav");
      if (!el) throw new Error("navigasi board belum tampil");
      return el as HTMLElement;
    });
    await user.click(boardNav.querySelector("button.bd-link") as HTMLElement);
    expect(await screen.findByText("Send invoices")).toBeInTheDocument();
    expect(screen.getByText("Book venue")).toBeInTheDocument();
    await settle();
    expectEnglish("Board: Task saya", ["My tasks", "Overdue"]);
  });

  it("detail task", async () => {
    backend();
    const user = userEvent.setup();
    renderApp();
    await openSection(user, "board");
    expect(await screen.findByText("Revise floor plan")).toBeInTheDocument();
    await user.click(document.querySelector(`[data-open-task="${CARD_1.id}"]`) as HTMLElement);
    expect(await screen.findByText("Started on the ground floor.")).toBeInTheDocument();
    await settle();
    expectEnglish("Detail task", ["Description", "Subtasks", "Comments"]);

    // Tab kedua: riwayat aktivitas, kalimatnya dibentuk tampilan dari jenis perubahan.
    const tabs = screen.getAllByRole("tab");
    await user.click(tabs[tabs.length - 1]);
    expect(await screen.findByText(/Revise floor plan/, { selector: "[role=tabpanel] *" })).toBeInTheDocument();
    await settle();
    expectEnglish("Detail task > aktivitas", ["Activity"]);
  });

  it("Dokumen", async () => {
    backend();
    const user = userEvent.setup();
    renderApp();
    await openSection(user, "docs");
    expect((await screen.findAllByText("budget.xlsx")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("contract.docx")).length).toBeGreaterThan(0);
    await settle();
    expectEnglish("Dokumen", ["Documents", "Add files", "Version history"]);
  });

  it("Tanda tangan", async () => {
    backend();
    const user = userEvent.setup();
    renderApp();
    await openSection(user, "sign");
    expect((await screen.findAllByText("Lease agreement")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Handover letter").length).toBeGreaterThan(0);
    await settle();
    expectEnglish("Tanda tangan", ["Signatures", "My signature"]);
  });

  it("Organisasi sebagai superadmin: setiap tab", async () => {
    backend();
    const user = userEvent.setup();
    renderApp();
    await openSection(user, "org");
    const tabs = await waitFor(() => {
      const list = document.querySelectorAll<HTMLElement>("button.org-tab");
      if (list.length < 5) throw new Error(`tab Organisasi belum lengkap (${list.length})`);
      return list;
    });
    // Urutan tab superadmin: Pengguna, Departemen, Permintaan bergabung, Label, Sticker, Undangan.
    const waits = ["Casey Kim", "Archive Team", "Riley Chen", "Surveyor", null, null];
    const names = ["Pengguna", "Departemen", "Permintaan bergabung", "Label", "Sticker", "Undangan"];
    const anchors = ["Laptop and last IP", "Archived", "Approve", "New label", "Office stickers", "Create invite code"];
    const all: string[] = [];
    for (let i = 0; i < tabs.length; i += 1) {
      await user.click(document.querySelectorAll<HTMLElement>("button.org-tab")[i]);
      const wait = waits[i];
      if (wait) expect((await screen.findAllByText(wait, { exact: false })).length).toBeGreaterThan(0);
      await settle();
      all.push(...englishFindings(`Organisasi > ${names[i] ?? i}`, ["Organization", anchors[i]]));
    }
    expect(all, "Teks Indonesia tersisa di tab Organisasi saat bahasa Inggris aktif").toEqual([]);
  });

  it("Pengaturan: setiap bagian", async () => {
    backend();
    const user = userEvent.setup();
    renderApp();
    await openSection(user, "settings");
    const parts = ["Tampilan", "Bahasa", "Jaringan", "Laptop ini", "Tentang dan pembaruan"];
    const waits: (string | null)[] = [null, "English", "10.8.0.5:47800", "AAAA BBBB CCCC DDDD", "Mira 0.4.0"];
    const anchors = ["Appearance", "Language", "Network", "Data folder", "Check for updates"];
    const all: string[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      const links = await waitFor(() => {
        const list = document.querySelectorAll<HTMLElement>("button.settings-link");
        if (list.length !== parts.length) throw new Error("menu Pengaturan belum tampil");
        return list;
      });
      await user.click(links[i]);
      const wait = waits[i];
      if (wait) expect((await screen.findAllByText(wait, { exact: false })).length).toBeGreaterThan(0);
      await settle();
      all.push(...englishFindings(`Pengaturan > ${parts[i]}`, ["Settings", anchors[i]]));
    }
    expect(all, "Teks Indonesia tersisa di Pengaturan saat bahasa Inggris aktif").toEqual([]);
  });

  it("Onboarding langkah 1", async () => {
    backend({
      get_app_state: { ...READY, identity: { ...READY.identity, displayName: null }, organization: null, membership: "none" },
      get_firewall_status: { ...FIREWALL, rule: "allowed" },
    });
    renderApp();
    expect(await screen.findByRole("radio", { name: "English" })).toBeInTheDocument();
    await settle();
    expectEnglish("Onboarding langkah 1", ["What's your name?", "Step 1 of 3"]);
  });

  it("layar gagal dibuka (error dari inti Rust)", async () => {
    backend({
      get_app_state: () => {
        throw { code: "database", message: "Database tidak bisa dibuka karena sedang dipakai jendela lain." };
      },
    });
    renderApp();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await settle();
    expectEnglish("Layar error", ["Error code: database", "Try again"]);
  });

  it("layar gagal dibuka (di luar aplikasi desktop)", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    renderApp();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await settle();
    expectEnglish("Layar error tanpa Tauri", ["Error code: no_tauri", "Try again"]);
  });

  it("layar dikeluarkan dari organisasi", async () => {
    backend({ get_app_state: { ...READY, membership: "removed" } });
    renderApp();
    expect(await screen.findByText("AAAA BBBB CCCC DDDD")).toBeInTheDocument();
    await settle();
    expectEnglish("Layar dikeluarkan", ["Check again"]);
  });
});
