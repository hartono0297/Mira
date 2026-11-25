// Menu klik kanan proyek di daftar kiri Board (v0.4): Buka board, Anggota
// proyek, Ubah nama proyek (pengelola). Rancangan: docs/plans/v04-ctx-board.md.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardView, ColumnId, ProjectSummary } from "../../api/board";
import type { OrgOverview, PersonView, ProjectMembersView } from "../../api/org";
import { BOARD_SELECTION_KEY, BoardScreen } from "./BoardScreen";

const board = vi.hoisted(() => ({
  listProjects: vi.fn(),
  createProject: vi.fn(),
  getBoard: vi.fn(),
  createTask: vi.fn(),
  moveTask: vi.fn(),
  updateProject: vi.fn(),
  myTasks: vi.fn(),
  outsideProjects: vi.fn(),
}));

// Event mira://board tiruan: boardEvent() membuat daftar proyek dimuat ulang.
const listeners = vi.hoisted(() => new Set<() => void>());

vi.mock("../../api/board", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/board")>()),
  boardApi: board,
  subscribeBoard: (handler: () => void) => {
    listeners.add(handler);
    return () => listeners.delete(handler);
  },
}));

async function boardEvent() {
  await act(async () => {
    listeners.forEach((h) => h());
    await new Promise((r) => setTimeout(r, 0));
  });
}

const org = vi.hoisted(() => ({
  overview: vi.fn(),
  people: vi.fn(),
  departments: vi.fn(),
  projectMembers: vi.fn(),
  addProjectMember: vi.fn(),
  removeProjectMember: vi.fn(),
}));

vi.mock("../../api/org", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/org")>()),
  orgApi: org,
  subscribeOrg: () => () => {},
}));

vi.mock("./NewProjectDialog", () => ({ NewProjectDialog: () => null }));
vi.mock("./TaskDetail", () => ({ TaskDetail: () => null }));
vi.mock("./MyTasks", () => ({ MyTasks: () => <h2>Task saya tiruan</h2> }));

const P1 = "1".repeat(32);
const P2 = "2".repeat(32);
const ME = "a".repeat(64);
const DEPT = "9".repeat(32);

function project(id: string, code: string, name: string, extra: Partial<ProjectSummary> = {}): ProjectSummary {
  return { id, code, name, teamId: null, teamName: null, openCount: 2, taskCount: 3, canManage: true, ...extra };
}

let projects: ProjectSummary[];

function boardOf(p: ProjectSummary): BoardView {
  const cols: [ColumnId, string][] = [
    ["todo", "To do"],
    ["doing", "Dikerjakan"],
    ["done", "Selesai"],
  ];
  return {
    project: p,
    columns: cols.map(([id, name]) => ({ id, name, tasks: [] })),
    assignees: [{ publicKey: ME, name: "Rekan Uji" }],
    me: ME,
    canCreate: true,
  };
}

function overview(): OrgOverview {
  return {
    publicKey: ME,
    isSuperadmin: false,
    isGuest: false,
    departmentId: DEPT,
    decideJoinTeamIds: [],
    pendingJoinCount: 0,
    manageOrg: false,
    listUsers: false,
  };
}

function me(): PersonView {
  return {
    publicKey: ME,
    displayName: "Rekan Uji",
    fingerprint: "AAAA 0000",
    role: "member",
    isSuperadmin: false,
    isGuest: false,
    departmentId: DEPT,
    departmentName: "Keuangan",
    departmentRole: null,
    labels: [],
  };
}

function membersOf(projectId: string): ProjectMembersView {
  return {
    projectId,
    registered: true,
    teamId: null,
    creator: ME,
    members: [
      { publicKey: ME, displayName: "Rekan Uji", departmentName: "Keuangan", role: "manager", isCreator: true, byInvite: false },
      // Anggota yang hanya ada di KB, supaya panel yang terbuka bisa dikenali.
      ...(projectId === P2
        ? [{ publicKey: "b".repeat(64), displayName: "Budi Kantor", departmentName: "Keuangan", role: "member" as const, isCreator: false, byInvite: false }]
        : []),
    ],
    canManage: true,
    canLeave: false,
    canJoinSelf: false,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  listeners.clear();
  projects = [project(P1, "PA", "Proyek Alfa"), project(P2, "KB", "Kantor Baru", { canManage: false })];
  board.listProjects.mockReset().mockImplementation(async () => projects);
  board.getBoard.mockReset().mockImplementation(async (id: string) => boardOf(projects.find((p) => p.id === id)!));
  board.myTasks.mockReset().mockResolvedValue([]);
  board.outsideProjects.mockReset().mockResolvedValue([]);
  org.overview.mockReset().mockResolvedValue(overview());
  org.people.mockReset().mockResolvedValue([me()]);
  org.departments.mockReset().mockResolvedValue([]);
  org.projectMembers.mockReset().mockImplementation(async (id: string) => membersOf(id));
});

async function renderBoard() {
  render(<BoardScreen />);
  await screen.findByRole("heading", { level: 2, name: /Proyek Alfa/ });
}

function nav() {
  return screen.getByRole("navigation", { name: "Task saya dan proyek" });
}

function link(name: RegExp) {
  return within(nav()).getByRole("button", { name });
}

async function rightClick(user: ReturnType<typeof userEvent.setup>, name: RegExp, label: string) {
  await user.pointer({ keys: "[MouseRight]", target: link(name) });
  return screen.getByRole("menu", { name: label });
}

function itemIds(menu: HTMLElement) {
  return within(menu)
    .getAllByRole("menuitem")
    .map((el) => el.dataset.menuItem);
}

function item(menu: HTMLElement, id: string): HTMLElement {
  const el = menu.querySelector<HTMLElement>(`[data-menu-item="${id}"]`);
  if (!el) throw new Error(`item ${id} tidak ada`);
  return el;
}

describe("Menu klik kanan proyek", () => {
  it("pengelola mendapat Buka board, Anggota proyek, dan Ubah nama proyek; anggota biasa tanpa Ubah nama", async () => {
    const user = userEvent.setup();
    await renderBoard();

    const alfa = await rightClick(user, /Proyek Alfa/, "Aksi untuk proyek PA Proyek Alfa");
    expect(itemIds(alfa)).toEqual(["open", "members", "rename"]);
    expect(within(alfa).getByRole("menuitem", { name: "Buka board" })).toBeInTheDocument();
    expect(within(alfa).getByRole("menuitem", { name: "Anggota proyek" })).toBeInTheDocument();
    expect(within(alfa).getByRole("menuitem", { name: "Ubah nama proyek" })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    const kb = await rightClick(user, /Kantor Baru/, "Aksi untuk proyek KB Kantor Baru");
    expect(itemIds(kb)).toEqual(["open", "members"]);
  });

  it("klik kiri tetap memilih proyek", async () => {
    const user = userEvent.setup();
    await renderBoard();
    await user.click(link(/Kantor Baru/));
    expect(await screen.findByRole("heading", { level: 2, name: /Kantor Baru/ })).toBeInTheDocument();
    expect(link(/Kantor Baru/)).toHaveAttribute("aria-current", "page");
  });

  it("Buka board untuk proyek yang sedang terbuka nonaktif dengan alasannya", async () => {
    const user = userEvent.setup();
    await renderBoard();
    const alfa = await rightClick(user, /Proyek Alfa/, "Aksi untuk proyek PA Proyek Alfa");
    expect(item(alfa, "open")).toHaveAttribute("aria-disabled", "true");
    expect(item(alfa, "open")).toHaveAccessibleDescription("Board ini sedang terbuka");
    // Item lain tetap bisa dipakai.
    expect(item(alfa, "members")).not.toHaveAttribute("aria-disabled");
    await user.keyboard("{Escape}");

    const kb = await rightClick(user, /Kantor Baru/, "Aksi untuk proyek KB Kantor Baru");
    expect(item(kb, "open")).not.toHaveAttribute("aria-disabled");
  });

  it("Buka board memilih proyek itu", async () => {
    const user = userEvent.setup();
    await renderBoard();
    const menu = await rightClick(user, /Kantor Baru/, "Aksi untuk proyek KB Kantor Baru");
    await user.click(item(menu, "open"));
    expect(await screen.findByRole("heading", { level: 2, name: /Kantor Baru/ })).toBeInTheDocument();
    expect(link(/Kantor Baru/)).toHaveAttribute("aria-current", "page");
    expect(link(/Proyek Alfa/)).not.toHaveAttribute("aria-current");
    expect(window.localStorage.getItem(BOARD_SELECTION_KEY)).toBe(P2);
  });

  it("Anggota proyek di proyek yang belum terpilih membuka board-nya lalu panel Anggota proyek itu", async () => {
    const user = userEvent.setup();
    await renderBoard();
    const menu = await rightClick(user, /Kantor Baru/, "Aksi untuk proyek KB Kantor Baru");
    await user.click(item(menu, "members"));
    const panel = await screen.findByRole("dialog", { name: "Anggota proyek" });
    expect(await within(panel).findByText("Budi Kantor")).toBeInTheDocument();
    expect(org.projectMembers).toHaveBeenCalledWith(P2);
    // Halaman di belakang dialog tersembunyi dari pembaca layar selama dialog terbuka.
    expect(screen.getByRole("heading", { level: 2, name: /Kantor Baru/, hidden: true })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(link(/Kantor Baru/)).toHaveAttribute("aria-current", "page");
  });

  it("Anggota proyek di proyek yang sedang terbuka membuka panelnya", async () => {
    const user = userEvent.setup();
    await renderBoard();
    const menu = await rightClick(user, /Proyek Alfa/, "Aksi untuk proyek PA Proyek Alfa");
    await user.click(item(menu, "members"));
    expect(await screen.findByRole("dialog", { name: "Anggota proyek" })).toBeInTheDocument();
    expect(org.projectMembers).toHaveBeenCalledWith(P1);
  });

  it("panel tidak terbuka lagi sendiri setelah pindah proyek lalu kembali", async () => {
    const user = userEvent.setup();
    await renderBoard();
    const menu = await rightClick(user, /Proyek Alfa/, "Aksi untuk proyek PA Proyek Alfa");
    await user.click(item(menu, "members"));
    await screen.findByRole("dialog", { name: "Anggota proyek" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(link(/Kantor Baru/));
    await screen.findByRole("heading", { level: 2, name: /Kantor Baru/ });
    await user.click(link(/Proyek Alfa/));
    await screen.findByRole("heading", { level: 2, name: /Proyek Alfa/ });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("panel tidak terbuka lagi sendiri saat proyek hilang dari daftar lalu muncul lagi", async () => {
    const user = userEvent.setup();
    await renderBoard();
    const menu = await rightClick(user, /Proyek Alfa/, "Aksi untuk proyek PA Proyek Alfa");
    await user.click(item(menu, "members"));
    await screen.findByRole("dialog", { name: "Anggota proyek" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // Saya dikeluarkan dari PA: board-nya diganti penjelasan.
    const all = projects;
    projects = [all[1]];
    await boardEvent();
    expect(await screen.findByRole("heading", { name: "Proyek PA Proyek Alfa tidak tersedia lagi" })).toBeInTheDocument();

    // Saya ditambahkan lagi: board PA tampil lagi tanpa panel Anggota.
    const loads = board.getBoard.mock.calls.length;
    projects = all;
    await boardEvent();
    expect(await screen.findByRole("heading", { level: 2, name: /Proyek Alfa/ })).toBeInTheDocument();
    await waitFor(() => expect(board.getBoard.mock.calls.length).toBeGreaterThan(loads));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Ubah nama proyek membuka dialognya, juga dari proyek lain", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(BOARD_SELECTION_KEY, P2);
    render(<BoardScreen />);
    await screen.findByRole("heading", { level: 2, name: /Kantor Baru/ });
    const menu = await rightClick(user, /Proyek Alfa/, "Aksi untuk proyek PA Proyek Alfa");
    await user.click(item(menu, "rename"));
    const dlg = await screen.findByRole("dialog", { name: "Ubah nama proyek" });
    expect(within(dlg).getByDisplayValue("Proyek Alfa")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: /Proyek Alfa/, hidden: true })).toBeInTheDocument();
  });

  it("Shift+F10 di tombol proyek membuka menu dengan fokus di item pertama; Esc mengembalikan fokus", async () => {
    const user = userEvent.setup();
    await renderBoard();
    const kb = link(/Kantor Baru/);
    kb.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    const menu = screen.getByRole("menu", { name: "Aksi untuk proyek KB Kantor Baru" });
    expect(item(menu, "open")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(kb).toHaveFocus();
    // Proyek terpilih tidak berubah hanya karena menu dibuka.
    expect(kb).not.toHaveAttribute("aria-current");
  });
});
