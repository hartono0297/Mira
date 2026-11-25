// Layar Board dalam bahasa Inggris: teks antarmuka ikut bahasa aktif, data
// tersimpan (nama proyek, judul task, nama kolom dari inti Rust) tidak diubah.
import { act, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Activity, BoardView, ProjectSummary, TaskCard } from "../../api/board";
import type { OrgOverview } from "../../api/org";
import { setLang } from "../../i18n/core";
import { renderInLang } from "../../test/i18n";
import { BoardScreen } from "./BoardScreen";
import { columnLabel, dueLabel, formatDateTime, formatDue, teamLabel } from "./format";
import { activitySentence } from "./taskActivity";
import { formatDuration, formatDurationLong, parseMinutes } from "./timeFormat";

const board = vi.hoisted(() => ({
  listProjects: vi.fn(),
  getBoard: vi.fn(),
  myTasks: vi.fn(),
  outsideProjects: vi.fn(),
}));

vi.mock("../../api/board", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/board")>()),
  boardApi: board,
  subscribeBoard: () => () => {},
}));

const org = vi.hoisted(() => ({
  overview: vi.fn(),
  people: vi.fn(),
  departments: vi.fn(),
  projectMembers: vi.fn(),
}));

vi.mock("../../api/org", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/org")>()),
  orgApi: org,
  subscribeOrg: () => () => {},
}));

vi.mock("./NewProjectDialog", () => ({ NewProjectDialog: () => null }));
vi.mock("./TaskDetail", () => ({ TaskDetail: () => null }));
vi.mock("./MyTasks", () => ({ MyTasks: () => null }));

const P1 = "1".repeat(32);
const ME = "a".repeat(64);

const PROJECT: ProjectSummary = {
  id: P1,
  code: "PA",
  name: "Proyek Alfa",
  teamId: null,
  teamName: "Keuangan",
  openCount: 2,
  taskCount: 3,
  canManage: true,
};

function isoDaysFromToday(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function card(n: number, extra: Partial<TaskCard> = {}): TaskCard {
  return {
    id: String(n).padStart(32, "0"),
    code: `PA-${n}`,
    title: `Revisi denah ${n}`,
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
    ...extra,
  };
}

function view(): BoardView {
  return {
    project: PROJECT,
    columns: [
      {
        id: "todo",
        name: "To do",
        tasks: [card(1, { due: isoDaysFromToday(-2), priority: "high", commentCount: 3, subtaskDone: 1, subtaskTotal: 2 })],
      },
      { id: "doing", name: "Dikerjakan", tasks: [card(2, { columnId: "doing", merged: true })] },
      { id: "done", name: "Selesai", tasks: [] },
    ],
    assignees: [{ publicKey: ME, name: "Rekan Uji" }],
    me: ME,
    canCreate: true,
  };
}

const OVERVIEW: OrgOverview = {
  publicKey: ME,
  isSuperadmin: true,
  isGuest: false,
  departmentId: null,
  decideJoinTeamIds: [],
  pendingJoinCount: 0,
  manageOrg: true,
  listUsers: true,
};

beforeEach(() => {
  window.localStorage.clear();
  board.listProjects.mockReset().mockResolvedValue([PROJECT]);
  board.getBoard.mockReset().mockResolvedValue(view());
  board.myTasks.mockReset().mockResolvedValue([]);
  board.outsideProjects.mockReset().mockResolvedValue([]);
  org.overview.mockReset().mockResolvedValue(OVERVIEW);
  org.people.mockReset().mockResolvedValue([
    {
      publicKey: ME,
      displayName: "Rekan Uji",
      fingerprint: "AAAA 0000",
      role: "superadmin",
      isSuperadmin: true,
      isGuest: false,
      departmentId: null,
      departmentName: null,
      departmentRole: null,
      labels: [],
    },
  ]);
  org.departments.mockReset().mockResolvedValue([]);
  org.projectMembers.mockReset().mockResolvedValue({
    projectId: P1,
    registered: true,
    teamId: null,
    creator: ME,
    members: [],
    canManage: true,
    canLeave: false,
    canJoinSelf: false,
  });
});

afterEach(() => {
  setLang("id");
});

describe("Board dalam bahasa Inggris", () => {
  it("navigasi, kepala board, kolom, dan kartu memakai teks Inggris", async () => {
    renderInLang(() => <BoardScreen />, "en");

    const nav = await screen.findByRole("navigation", { name: "My tasks and projects" });
    expect(within(nav).getByRole("button", { name: /My tasks/ })).toBeInTheDocument();
    expect(within(nav).getByRole("heading", { name: "Projects" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "New project" })).toBeInTheDocument();

    expect(await screen.findByRole("heading", { name: "PA Proyek Alfa" })).toBeInTheDocument();
    expect(screen.getByText("3 tasks, 2 not done")).toBeInTheDocument();
    expect(screen.getByText("Keuangan department")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New task" })).toBeInTheDocument();

    // Nama kolom bawaan dari inti Rust tampil dalam bahasa aktif.
    expect(screen.getByRole("heading", { name: /^In progress/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Done/ })).toBeInTheDocument();
    expect(screen.getByText("No tasks in this column yet.")).toBeInTheDocument();

    // Kartu: data pengguna tetap, meta dalam bahasa Inggris.
    expect(screen.getByRole("button", { name: "Revisi denah 1" })).toBeInTheDocument();
    expect(screen.getByText("2 days overdue")).toBeInTheDocument();
    expect(screen.getByText("High")).toBeInTheDocument();
    expect(screen.getByText("Changed while offline, merged")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Move PA-1" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /Add task/ }).length).toBe(3);

    for (const id of ["Task saya", "Proyek baru", "Dikerjakan", "Pintasan keyboard", "Terlambat 2 hari", "Tinggi", "Tambah task"]) {
      expect(screen.queryByText(id)).not.toBeInTheDocument();
    }
  });

  it("berganti kembali ke bahasa Indonesia tanpa memuat ulang", async () => {
    renderInLang(() => <BoardScreen />, "en");
    expect(await screen.findByRole("button", { name: "Keyboard shortcuts" })).toBeInTheDocument();

    act(() => setLang("id"));

    expect(screen.getByRole("button", { name: "Pintasan keyboard" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Dikerjakan/ })).toBeInTheDocument();
    expect(screen.getByText("Terlambat 2 hari")).toBeInTheDocument();
    expect(screen.queryByText("Keyboard shortcuts")).not.toBeInTheDocument();
  });
});

describe("format board dalam bahasa Inggris", () => {
  beforeEach(() => setLang("en"));

  it("durasi, tanggal, dan jam", () => {
    expect(formatDuration(3 * 3600 + 20 * 60)).toBe("3h 20m");
    expect(formatDuration(2 * 86400 + 5 * 3600)).toBe("2d 5h");
    expect(formatDurationLong(3600 + 60)).toBe("1 hour 1 minute");
    expect(formatDurationLong(30)).toBe("less than 1 minute");
    expect(formatDue("2026-08-27", new Date(2026, 0, 1))).toBe("27 Aug");
    expect(formatDateTime("2026-05-03T09:12:00", new Date(2026, 0, 1))).toBe("3 May, 09:12");
    expect(dueLabel(isoDaysFromToday(1))).toBe("Tomorrow");
    expect(dueLabel(isoDaysFromToday(-1))).toBe("1 day overdue");
  });

  it("isian durasi menerima singkatan Inggris dan Indonesia", () => {
    expect(parseMinutes("1h 30m")).toEqual({ minutes: 90, reason: null });
    expect(parseMinutes("2 hours")).toEqual({ minutes: 120, reason: null });
    expect(parseMinutes("45 min")).toEqual({ minutes: 45, reason: null });
    expect(parseMinutes("1j 30m")).toEqual({ minutes: 90, reason: null });
    expect(parseMinutes("abc").reason).toMatch(/wasn't recognized/);
  });

  it("nama kolom, departemen, dan riwayat aktivitas", () => {
    expect(columnLabel("doing", "Dikerjakan")).toBe("In progress");
    expect(columnLabel("doing", "Kolom khusus")).toBe("Kolom khusus");
    expect(teamLabel("Finance department")).toBe("Finance department");
    const moved: Activity = { kind: "moved", detail: "Dikerjakan", at: "2026-11-22T03:00:00Z", actor: { publicKey: ME, name: "Rekan Uji" } };
    expect(activitySentence(moved, ME)).toBe("You moved the task to In progress");
  });
});
