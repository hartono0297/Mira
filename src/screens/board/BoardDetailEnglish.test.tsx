import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardView, ProjectSummary, TaskDetail as Task } from "../../api/board";
import type { PersonView, ProjectMembersView, ProjectMemberView } from "../../api/org";
import { setLang } from "../../i18n/core";
import { renderInLang } from "../../test/i18n";
import { describePicked, PeoplePicker } from "./PeoplePicker";
import { ProjectMembersPanel, useProjectMembers } from "./ProjectMembersPanel";
import { RenameProjectDialog } from "./RenameProjectDialog";
import { TaskDetail } from "./TaskDetail";

const org = vi.hoisted(() => ({
  projectMembers: vi.fn(),
  people: vi.fn(),
  addProjectMember: vi.fn(),
  removeProjectMember: vi.fn(),
}));

const boardMock = vi.hoisted(() => ({ getTask: vi.fn(), getBoard: vi.fn() }));

vi.mock("../../api/board", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../api/board")>();
  return { ...real, boardApi: { ...real.boardApi, ...boardMock }, subscribeBoard: () => () => {} };
});

// Subtask, Waktu, dan timer punya tes bahasa sendiri.
vi.mock("./Subtasks", () => ({ Subtasks: () => null }));
vi.mock("./TimeSection", () => ({ TimeSection: () => null }));
vi.mock("./TimerMini", () => ({ TimerMini: () => null }));

vi.mock("../../api/org", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/org")>()),
  orgApi: org,
  subscribeOrg: () => () => {},
}));

const P1 = "1".repeat(32);
const ME = "a".repeat(64);
const PK_B = "b".repeat(64);
const PK_G = "d".repeat(64);
const DEPT = "9".repeat(32);

function m(publicKey: string, displayName: string, extra: Partial<ProjectMemberView> = {}): ProjectMemberView {
  return { publicKey, displayName, departmentName: "Desain", role: "member", isCreator: false, byInvite: false, ...extra };
}

const VIEW: ProjectMembersView = {
  projectId: P1,
  registered: true,
  teamId: DEPT,
  creator: ME,
  members: [
    m(ME, "Rina Uji", { role: "manager", isCreator: true }),
    m(PK_B, "Budi Uji"),
    m(PK_G, "Gita Tamu", { role: "guest", departmentName: null, byInvite: true }),
  ],
  canManage: true,
  canLeave: true,
  canJoinSelf: false,
};

function person(publicKey: string, displayName: string, extra: Partial<PersonView> = {}): PersonView {
  return {
    publicKey,
    displayName,
    fingerprint: "AAAA 0000",
    role: "member",
    isSuperadmin: false,
    isGuest: false,
    departmentId: DEPT,
    departmentName: "Desain",
    departmentRole: null,
    labels: [],
    ...extra,
  };
}

const PEOPLE = [
  person(PK_B, "Budi Uji"),
  person("c".repeat(64), "Citra Uji", { departmentId: null, departmentName: null }),
  person(PK_G, "Gita Tamu", { isGuest: true, role: "guest", departmentId: null, departmentName: null }),
];

function Panel() {
  const live = useProjectMembers(P1);
  return <ProjectMembersPanel open onOpenChange={() => {}} projectId={P1} me={ME} members={live} onLeft={() => {}} />;
}

beforeEach(() => {
  org.projectMembers.mockReset().mockResolvedValue(VIEW);
  org.people.mockReset().mockResolvedValue(PEOPLE);
});

describe("Detail board dalam bahasa Inggris", () => {
  it("panel Anggota proyek memakai teks Inggris", async () => {
    renderInLang(() => <Panel />);
    const dlg = await screen.findByRole("dialog", { name: "Project members" });
    expect(
      await within(dlg).findByText("Only these 3 people can see this project's board, chat, and documents."),
    ).toBeInTheDocument();
    expect(within(dlg).getByRole("region", { name: "Managers" })).toBeInTheDocument();
    expect(within(dlg).getByText("Rina Uji (you)")).toBeInTheDocument();
    expect(within(dlg).getByText("Desain, project creator")).toBeInTheDocument();
    expect(within(dlg).getByText("Guest by invite")).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Remove Budi Uji from the project" })).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Leave project" })).toBeInTheDocument();
    expect(within(dlg).queryByText(/Anggota|Pengelola|Keluarkan|Tutup/)).toBeNull();
  });

  it("konfirmasi keluarkan dan dialog Tambah anggota memakai teks Inggris", async () => {
    const user = userEvent.setup();
    renderInLang(() => <Panel />);
    const dlg = await screen.findByRole("dialog", { name: "Project members" });
    await user.click(await within(dlg).findByRole("button", { name: "Remove Gita Tamu from the project" }));
    const confirm = await screen.findByRole("dialog", { name: "Remove Gita Tamu from the project?" });
    expect(
      within(confirm).getByText(
        "Gita Tamu stops receiving new data from this project, and the project disappears from their board. Their guest access to this project through an invite is revoked too.",
      ),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(within(dlg).getByRole("button", { name: "Add members" }));
    const add = await screen.findByRole("dialog", { name: "Add project members" });
    // Semua orang di VIEW sudah anggota kecuali Citra.
    expect(await within(add).findByText("Citra Uji")).toBeInTheDocument();
    expect(within(add).getByRole("button", { name: "No department yet" })).toBeInTheDocument();
    expect(within(add).getByText("Nobody selected yet.")).toBeInTheDocument();
    expect(within(add).getByRole("button", { name: "Add" })).toBeInTheDocument();
    expect(within(add).queryByText(/Tambahkan|Belum ada|Batal/)).toBeNull();
  });

  it("pemilih orang dan ringkasannya mengikuti bahasa saat diganti", async () => {
    const user = userEvent.setup();
    renderInLang(() => <PeoplePicker people={PEOPLE} selected={[]} onChange={() => {}} />);
    const group = screen.getByRole("group", { name: "Filter by department" });
    expect(within(group).getByRole("button", { name: "All" })).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "Guest" })).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "Search names or departments" }), "zzz");
    expect(screen.getByText('No names match "zzz".')).toBeInTheDocument();

    act(() => setLang("id"));
    await waitFor(() => expect(screen.getByRole("group", { name: "Saring menurut departemen" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Semua" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tamu" })).toBeInTheDocument();
  });

  it("ringkasan orang terpilih memakai jamak bahasa Inggris", () => {
    setLang("en");
    expect(describePicked([PEOPLE[0]])).toBe("1 person from 1 department");
    expect(describePicked(PEOPLE)).toBe("1 person from 1 department, 1 person without a department, and 1 guest");
  });

  it("detail task: deskripsi kosong, Dibuat oleh, dan catatan hanya-baca memakai teks Inggris", async () => {
    const me = { publicKey: ME, name: "Rina Uji" };
    const t: Task = {
      id: "2".repeat(32),
      code: "PA-12",
      title: "Review the contract",
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
      projectId: P1,
      description: "",
      createdBy: me,
      createdAt: "2026-11-20T02:00:00Z",
      updatedAt: "2026-11-20T02:00:00Z",
      comments: [],
      activity: [],
      canEdit: true,
      canDelete: true,
      canComment: true,
      subtasks: [],
      timeEntries: [],
      timeTotals: [],
      myRunningEntry: null,
      statusTime: {
        closedSecs: { todo: 0, doing: 0, done: 0 },
        currentColumn: "todo",
        currentSince: "2026-11-20T02:00:00Z",
        cycleSecs: null,
        clockWarning: false,
      },
    };
    const board: BoardView = {
      project: { id: P1, code: "PA", name: "Pameran", teamId: DEPT, teamName: "Desain", openCount: 1, taskCount: 1, canManage: true },
      columns: [
        { id: "todo", name: "To do", tasks: [] },
        { id: "doing", name: "Dikerjakan", tasks: [] },
        { id: "done", name: "Selesai", tasks: [] },
      ],
      assignees: [me],
      me: ME,
      canCreate: true,
    };
    boardMock.getTask.mockResolvedValue(t);
    boardMock.getBoard.mockResolvedValue(board);
    const view = renderInLang(() => <TaskDetail projectId={P1} taskId={t.id} onClose={() => {}} onChanged={() => {}} />);
    const desc = await screen.findByLabelText("Description");
    expect(desc).toHaveAttribute("placeholder", "Write a description: the goal, the steps, or links the team should know about");
    expect(screen.getByText(/^Created by You,/).closest("p")).toHaveClass("td-ro");
    view.unmount();

    boardMock.getTask.mockResolvedValue({ ...t, canEdit: false, canDelete: false, canComment: false });
    renderInLang(() => <TaskDetail projectId={P1} taskId={t.id} onClose={() => {}} onChanged={() => {}} />);
    expect(await screen.findByText(/You can only view this task/)).toBeInTheDocument();
    expect(screen.getByRole("dialog").querySelector(".td-box")).toBeNull();
  });

  it("dialog ubah nama proyek memakai teks Inggris", () => {
    const project: ProjectSummary = {
      id: P1,
      code: "PA",
      name: "Pameran",
      teamId: DEPT,
      teamName: "Desain",
      openCount: 0,
      taskCount: 0,
      canManage: true,
    };
    renderInLang(() => <RenameProjectDialog open onOpenChange={() => {}} project={project} onRenamed={() => {}} />);
    const dlg = screen.getByRole("dialog", { name: "Rename project" });
    expect(within(dlg).getByLabelText("Project name")).toHaveValue("Pameran");
    expect(within(dlg).getByText("2 to 80 characters. The code PA and task numbers like PA-1 stay the same.")).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Save name" })).toBeInTheDocument();
    expect(within(dlg).queryByText(/Simpan|Batal|karakter/)).toBeNull();
  });
});
