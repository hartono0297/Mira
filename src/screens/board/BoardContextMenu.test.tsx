// Menu klik kanan kartu task dan kolom di board (v0.4). Rancangan isi menu:
// docs/plans/v04-ctx-board.md. Tes keyboard dasar menu ada di
// src/components/ContextMenu; di sini isi menu, aksinya, dan interaksinya
// dengan seret kartu.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardView, ColumnId, ProjectSummary, TaskCard } from "../../api/board";
import type { ProjectMembersView } from "../../api/org";
import { applyMove } from "./boardMoves";
import { ProjectBoard } from "./ProjectBoard";

const board = vi.hoisted(() => ({
  getBoard: vi.fn(),
  createTask: vi.fn(),
  moveTask: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  startTimer: vi.fn(),
  stopTimer: vi.fn(),
  updateProject: vi.fn(),
}));

vi.mock("../../api/board", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/board")>()),
  boardApi: board,
  subscribeBoard: () => () => {},
}));

const org = vi.hoisted(() => ({
  projectMembers: vi.fn(),
  addProjectMember: vi.fn(),
  removeProjectMember: vi.fn(),
}));

vi.mock("../../api/org", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/org")>()),
  orgApi: org,
  subscribeOrg: () => () => {},
}));

const P1 = "1".repeat(32);
const ME = "a".repeat(64);
const PK_B = "b".repeat(64);

const PROJECT: ProjectSummary = {
  id: P1,
  code: "PA",
  name: "Proyek Alfa",
  teamId: null,
  teamName: null,
  openCount: 3,
  taskCount: 4,
  canManage: true,
};

function taskId(n: number) {
  return String(n).padStart(32, "0");
}

function card(n: number, columnId: ColumnId, extra: Partial<TaskCard> = {}): TaskCard {
  return {
    id: taskId(n),
    code: `PA-${n}`,
    title: `Task nomor ${n}`,
    columnId,
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
    canDelete: false,
    myTimerRunning: false,
    ...extra,
  };
}

function view(extra: Partial<BoardView> = {}): BoardView {
  return {
    project: PROJECT,
    columns: [
      {
        id: "todo",
        name: "To do",
        tasks: [
          card(1, "todo", { assignee: { publicKey: ME, name: "Rekan Uji" }, priority: "high", due: "2026-11-24" }),
          card(2, "todo"),
        ],
      },
      { id: "doing", name: "Dikerjakan", tasks: [card(3, "doing")] },
      { id: "done", name: "Selesai", tasks: [card(4, "done")] },
    ],
    // Urutan data: Budi dulu. Menu menaruh saya paling atas.
    assignees: [
      { publicKey: PK_B, name: "Budi Uji" },
      { publicKey: ME, name: "Rekan Uji" },
    ],
    me: ME,
    canCreate: true,
    ...extra,
  };
}

function membersView(): ProjectMembersView {
  return {
    projectId: P1,
    registered: true,
    teamId: null,
    creator: ME,
    members: [
      { publicKey: ME, displayName: "Rekan Uji", departmentName: "Keuangan", role: "manager", isCreator: true, byInvite: false },
    ],
    canManage: true,
    canLeave: true,
    canJoinSelf: false,
  };
}

let current: BoardView;
const onOpenTask = vi.fn();
const onProjectsChanged = vi.fn();

function withCard(n: number, extra: Partial<TaskCard>): BoardView {
  return {
    ...current,
    columns: current.columns.map((c) => ({ ...c, tasks: c.tasks.map((t) => (t.id === taskId(n) ? { ...t, ...extra } : t)) })),
  };
}

beforeEach(() => {
  // Hanya Date yang dipalsukan: 24 Nov 2026 pukul 10.00 waktu lokal.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 24, 10, 0, 0));
  current = view();
  onOpenTask.mockReset();
  onProjectsChanged.mockReset();
  board.getBoard.mockReset().mockImplementation(async () => current);
  board.moveTask.mockReset().mockImplementation(async (_p: string, id: string, columnId: ColumnId, index: number) => {
    current = applyMove(current, id, { columnId, index });
    return current;
  });
  board.updateTask.mockReset().mockResolvedValue(null);
  board.deleteTask.mockReset().mockImplementation(async (_p: string, id: string) => {
    current = { ...current, columns: current.columns.map((c) => ({ ...c, tasks: c.tasks.filter((t) => t.id !== id) })) };
    return null;
  });
  board.startTimer.mockReset().mockResolvedValue(null);
  board.stopTimer.mockReset().mockResolvedValue(null);
  board.createTask.mockReset();
  org.projectMembers.mockReset().mockResolvedValue(membersView());
});

afterEach(() => {
  vi.useRealTimers();
  document.documentElement.classList.remove("card-dragging");
});

async function renderBoard(props: Partial<Parameters<typeof ProjectBoard>[0]> = {}) {
  const utils = render(
    <ProjectBoard
      projectId={P1}
      refreshKey={0}
      taskOpen={false}
      onOpenTask={onOpenTask}
      onProjectsChanged={onProjectsChanged}
      {...props}
    />,
  );
  await screen.findByRole("button", { name: "Task nomor 1" });
  return utils;
}

function cardEl(n: number) {
  return document.querySelector<HTMLElement>(`[data-card="${taskId(n)}"]`)!;
}

function title(n: number) {
  return screen.getByRole("button", { name: `Task nomor ${n}` });
}

function column(name: string) {
  return screen.getByRole("heading", { level: 3, name: new RegExp(`^${name}`) }).closest("section")!;
}

function openCardMenu(n: number) {
  fireEvent.contextMenu(cardEl(n).querySelector(".tc-meta")!, { button: 2, clientX: 0, clientY: 0 });
  return screen.getByRole("menu", { name: `Aksi untuk PA-${n}` });
}

function item(menu: HTMLElement, name: string) {
  return within(menu).getByRole("menuitem", { name });
}

async function openSub(n: number, name: string, subName: string) {
  const menu = openCardMenu(n);
  fireEvent.click(item(menu, name));
  return await screen.findByRole("menu", { name: subName });
}

describe("Menu klik kanan kartu: isi menurut hak", () => {
  it("anggota yang boleh mengubah: semua aksi kecuali Hapus task", async () => {
    await renderBoard();
    const menu = openCardMenu(2);
    expect(within(menu).getAllByRole("menuitem").map((el) => el.getAttribute("data-menu-item"))).toEqual([
      "open",
      "move",
      "assign",
      "priority",
      "due",
      "timer-start",
      "copy",
    ]);
    expect(item(menu, "Buka task")).toBeInTheDocument();
    expect(item(menu, "Pindahkan ke")).toHaveAttribute("aria-haspopup", "menu");
    expect(item(menu, "Salin kode PA-2")).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Hapus task" })).not.toBeInTheDocument();
  });

  it("pembuat task (canDelete) mendapat Hapus task di paling bawah", async () => {
    current = withCard(2, { canDelete: true });
    await renderBoard();
    const menu = openCardMenu(2);
    const ids = within(menu).getAllByRole("menuitem").map((el) => el.getAttribute("data-menu-item"));
    expect(ids[ids.length - 1]).toBe("delete");
    expect(item(menu, "Hapus task")).toBeInTheDocument();
  });

  it("tamu (tanpa hak ubah): hanya Buka task dan Salin kode, dan kolom tanpa menu", async () => {
    current = view({ canCreate: false });
    await renderBoard();
    const menu = openCardMenu(1);
    expect(within(menu).getAllByRole("menuitem").map((el) => el.getAttribute("data-menu-item"))).toEqual(["open", "copy"]);
    fireEvent.keyDown(menu, { key: "Escape" });
    const ev = fireEvent.contextMenu(column("To do"), { button: 2 });
    expect(ev).toBe(true);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

describe("Menu klik kanan kartu: keyboard", () => {
  it("Shift+F10 di judul kartu membuka menu dengan fokus di item pertama; Esc mengembalikan fokus ke judul", async () => {
    await renderBoard();
    title(1).focus();
    fireEvent.keyDown(title(1), { key: "F10", shiftKey: true });
    const menu = screen.getByRole("menu", { name: "Aksi untuk PA-1" });
    expect(item(menu, "Buka task")).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(title(1)).toHaveFocus();
  });

  it("panah bawah ke Pindahkan ke, panah kanan membuka sub-menu, panah kiri kembali, Enter memindah", async () => {
    await renderBoard();
    title(1).focus();
    fireEvent.keyDown(title(1), { key: "F10", shiftKey: true });
    let menu = screen.getByRole("menu", { name: "Aksi untuk PA-1" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(item(menu, "Pindahkan ke")).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(item(menu, "Buka task")).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });

    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    let sub = await screen.findByRole("menu", { name: "Pindahkan PA-1 ke" });
    expect(item(sub, "To do")).toHaveAttribute("aria-disabled", "true");
    expect(item(sub, "To do")).toHaveAccessibleDescription("Task sudah di kolom ini");
    expect(item(sub, "Naik satu posisi")).toHaveAccessibleDescription("Sudah paling atas");
    expect(item(sub, "Turun satu posisi")).not.toHaveAttribute("aria-disabled");

    // Panah kiri kembali ke menu utama.
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    menu = await screen.findByRole("menu", { name: "Aksi untuk PA-1" });
    expect(screen.queryByRole("menu", { name: "Pindahkan PA-1 ke" })).not.toBeInTheDocument();
    await waitFor(() => expect(menu).toContainElement(document.activeElement as HTMLElement));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(item(menu, "Pindahkan ke")).toHaveFocus();

    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    sub = await screen.findByRole("menu", { name: "Pindahkan PA-1 ke" });
    item(sub, "Dikerjakan").focus();
    fireEvent.keyDown(item(sub, "Dikerjakan"), { key: "Enter" });
    await waitFor(() => expect(board.moveTask).toHaveBeenCalledWith(P1, taskId(1), "doing", 0));
    expect(await screen.findByText("PA-1 dipindah ke Dikerjakan, posisi 1 dari 2.")).toBeInTheDocument();
    await waitFor(() => expect(title(1)).toHaveFocus());
  });

  it("Turun satu posisi memindah kartu di kolom yang sama", async () => {
    await renderBoard();
    const sub = await openSub(1, "Pindahkan ke", "Pindahkan PA-1 ke");
    fireEvent.click(item(sub, "Turun satu posisi"));
    await waitFor(() => expect(board.moveTask).toHaveBeenCalledWith(P1, taskId(1), "todo", 1));
  });

  it("Alt + panah di kartu tetap memindah, dan Enter di judul tetap membuka task", async () => {
    await renderBoard();
    fireEvent.keyDown(title(2), { key: "ArrowRight", altKey: true });
    await waitFor(() => expect(board.moveTask).toHaveBeenCalledWith(P1, taskId(2), "doing", 0));
    fireEvent.click(title(1));
    expect(onOpenTask).toHaveBeenCalledWith(taskId(1));
    expect(screen.getByRole("button", { name: "Pindahkan PA-1" })).toBeInTheDocument();
  });
});

describe("Menu klik kanan kartu: aksi", () => {
  it("Buka task membuka detail", async () => {
    await renderBoard();
    fireEvent.click(item(openCardMenu(2), "Buka task"));
    expect(onOpenTask).toHaveBeenCalledWith(taskId(2));
  });

  it("Tugaskan ke: saya paling atas dengan (Anda), penanggung jawab sekarang nonaktif, memilih orang lain memanggil updateTask", async () => {
    await renderBoard();
    const sub = await openSub(1, "Tugaskan ke", "Tugaskan PA-1 ke");
    const ids = within(sub).getAllByRole("menuitem").map((el) => el.getAttribute("data-menu-item"));
    expect(ids).toEqual(["__back", `assign-${ME}`, `assign-${PK_B}`, "assign-none"]);
    expect(item(sub, "Rekan Uji (Anda)")).toHaveAccessibleDescription("Penanggung jawab sekarang");
    fireEvent.click(item(sub, "Budi Uji"));
    await waitFor(() => expect(board.updateTask).toHaveBeenCalledWith(P1, taskId(1), { assignee: PK_B }));
    expect(await screen.findByText("PA-1 ditugaskan ke Budi Uji.")).toBeInTheDocument();
    expect(onProjectsChanged).toHaveBeenCalled();
  });

  it("Tanpa penanggung jawab: mengosongkan, dan nonaktif kalau memang belum ada", async () => {
    await renderBoard();
    let sub = await openSub(2, "Tugaskan ke", "Tugaskan PA-2 ke");
    expect(item(sub, "Tanpa penanggung jawab")).toHaveAccessibleDescription("Belum ada penanggung jawab");
    fireEvent.keyDown(sub, { key: "Escape" });
    sub = await openSub(1, "Tugaskan ke", "Tugaskan PA-1 ke");
    fireEvent.click(item(sub, "Tanpa penanggung jawab"));
    await waitFor(() => expect(board.updateTask).toHaveBeenCalledWith(P1, taskId(1), { assignee: null }));
    expect(await screen.findByText("PA-1 tanpa penanggung jawab.")).toBeInTheDocument();
  });

  it("Ubah prioritas: urutan Tinggi, Sedang, Rendah, Tanpa prioritas; yang sekarang nonaktif", async () => {
    await renderBoard();
    const sub = await openSub(1, "Ubah prioritas", "Prioritas PA-1");
    expect(within(sub).getAllByRole("menuitem").map((el) => el.getAttribute("data-menu-item"))).toEqual([
      "__back",
      "priority-high",
      "priority-medium",
      "priority-low",
      "priority-none",
    ]);
    expect(item(sub, "Tinggi")).toHaveAccessibleDescription("Prioritas sekarang");
    fireEvent.click(item(sub, "Rendah"));
    await waitFor(() => expect(board.updateTask).toHaveBeenCalledWith(P1, taskId(1), { priority: "low" }));
    expect(await screen.findByText("Prioritas PA-1: Rendah.")).toBeInTheDocument();
  });

  it("Atur tenggat: Hari ini dan Besok memakai tanggal lokal", async () => {
    await renderBoard();
    let sub = await openSub(2, "Atur tenggat", "Tenggat PA-2");
    // Kartu tanpa tenggat: tidak ada Hapus tenggat.
    expect(within(sub).getAllByRole("menuitem").map((el) => el.getAttribute("data-menu-item"))).toEqual([
      "__back",
      "due-today",
      "due-tomorrow",
      "due-other",
    ]);
    fireEvent.click(item(sub, "Hari ini"));
    await waitFor(() => expect(board.updateTask).toHaveBeenCalledWith(P1, taskId(2), { due: "2026-11-24" }));
    expect(await screen.findByText("Tenggat PA-2: Hari ini, 24 Nov.")).toBeInTheDocument();

    sub = await openSub(2, "Atur tenggat", "Tenggat PA-2");
    fireEvent.click(item(sub, "Besok"));
    await waitFor(() => expect(board.updateTask).toHaveBeenCalledWith(P1, taskId(2), { due: "2026-11-25" }));
  });

  it("Atur tenggat: tenggat sekarang nonaktif, Hapus tenggat, dan Tanggal lain membuka detail", async () => {
    await renderBoard();
    let sub = await openSub(1, "Atur tenggat", "Tenggat PA-1");
    expect(item(sub, "Hari ini")).toHaveAccessibleDescription("Tenggat sekarang");
    fireEvent.click(item(sub, "Hapus tenggat"));
    await waitFor(() => expect(board.updateTask).toHaveBeenCalledWith(P1, taskId(1), { due: null }));
    expect(await screen.findByText("Tenggat PA-1 dihapus.")).toBeInTheDocument();

    sub = await openSub(1, "Atur tenggat", "Tenggat PA-1");
    fireEvent.click(item(sub, "Tanggal lain di detail task"));
    expect(onOpenTask).toHaveBeenCalledWith(taskId(1));
  });

  it("Mulai timer saya dan Hentikan timer saya menurut myTimerRunning", async () => {
    current = withCard(2, { myTimerRunning: true, timersRunningSince: ["2026-11-24T02:00:00Z"] });
    await renderBoard();
    fireEvent.click(item(openCardMenu(1), "Mulai timer saya"));
    await waitFor(() => expect(board.startTimer).toHaveBeenCalledWith(P1, taskId(1)));
    expect(await screen.findByText("Timer Anda di PA-1 berjalan.")).toBeInTheDocument();

    fireEvent.click(item(openCardMenu(2), "Hentikan timer saya"));
    await waitFor(() => expect(board.stopTimer).toHaveBeenCalledWith(P1, taskId(2), null));
    expect(await screen.findByText("Timer Anda di PA-2 berhenti.")).toBeInTheDocument();
  });

  it("galat ubah tampil di area pemberitahuan board dengan pesan inti", async () => {
    board.updateTask.mockRejectedValueOnce({ code: "forbidden", message: "Tamu tidak bisa mengubah task." });
    await renderBoard();
    const sub = await openSub(1, "Ubah prioritas", "Prioritas PA-1");
    fireEvent.click(item(sub, "Sedang"));
    expect(await screen.findByText("PA-1 belum diubah")).toBeInTheDocument();
    expect(screen.getByText("Tamu tidak bisa mengubah task.")).toBeInTheDocument();
  });

  it("Salin kode menulis ke papan klip dan mengumumkannya; kalau gagal, galat tampil", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText, readText: vi.fn() }, configurable: true });
    await renderBoard();
    fireEvent.click(item(openCardMenu(1), "Salin kode PA-1"));
    expect(writeText).toHaveBeenCalledWith("PA-1");
    expect(await screen.findByText("Kode PA-1 disalin.")).toBeInTheDocument();

    writeText.mockRejectedValueOnce(new Error("ditolak"));
    fireEvent.click(item(openCardMenu(2), "Salin kode PA-2"));
    expect(await screen.findByText("Kode PA-2 belum tersalin")).toBeInTheDocument();
  });

  it("Hapus task minta konfirmasi, memanggil deleteTask, lalu fokus ke kartu berikutnya", async () => {
    current = withCard(1, { canDelete: true, subtaskTotal: 2, commentCount: 1, trackedSecs: 600 });
    await renderBoard();
    fireEvent.click(item(openCardMenu(1), "Hapus task"));
    const dialog = await screen.findByRole("dialog", { name: "Hapus task PA-1?" });
    expect(dialog).toHaveTextContent('"Task nomor 1" beserta 2 subtask dan 1 komentar terhapus');
    expect(dialog).toHaveTextContent("Waktu yang sudah tercatat di task ini juga ikut terhapus.");
    expect(board.deleteTask).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Hapus PA-1" }));
    await waitFor(() => expect(board.deleteTask).toHaveBeenCalledWith(P1, taskId(1)));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Task nomor 1" })).not.toBeInTheDocument());
    expect(await screen.findByText("PA-1 dihapus.")).toBeInTheDocument();
    await waitFor(() => expect(title(2)).toHaveFocus());
    // Fokus bertahan setelah dialog selesai menutup.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(title(2)).toHaveFocus();
    expect(onProjectsChanged).toHaveBeenCalled();
  });

  it("Hapus kartu terakhir di kolom: fokus ke Tambah task kolom itu", async () => {
    current = withCard(3, { canDelete: true });
    await renderBoard();
    fireEvent.click(item(openCardMenu(3), "Hapus task"));
    const dialog = await screen.findByRole("dialog", { name: "Hapus task PA-3?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Hapus PA-3" }));
    const add = document.querySelector<HTMLElement>('[data-qa-open="doing"]')!;
    await waitFor(() => expect(add).toHaveFocus());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(add).toHaveFocus();
  });

  it("galat hapus tampil di dialog konfirmasi dan kartu tetap ada", async () => {
    current = withCard(1, { canDelete: true });
    board.deleteTask.mockRejectedValueOnce({ code: "forbidden", message: "Hanya pembuat task yang bisa menghapus." });
    await renderBoard();
    fireEvent.click(item(openCardMenu(1), "Hapus task"));
    const dialog = await screen.findByRole("dialog", { name: "Hapus task PA-1?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Hapus PA-1" }));
    expect(await within(dialog).findByText("Hanya pembuat task yang bisa menghapus.")).toBeInTheDocument();
    expect(cardEl(1)).toBeInTheDocument();
  });
});

describe("Menu klik kanan kolom", () => {
  it("Task baru di kolom membuka isian task cepat kolom itu", async () => {
    await renderBoard();
    fireEvent.contextMenu(column("Dikerjakan").querySelector("h3")!, { button: 2 });
    const menu = screen.getByRole("menu", { name: "Aksi untuk kolom Dikerjakan" });
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(1);
    fireEvent.click(item(menu, "Task baru di Dikerjakan"));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Judul task baru di Dikerjakan" })).toHaveFocus());

    // Sudah terbuka: fokus ke isiannya lagi.
    title(3).focus();
    fireEvent.contextMenu(column("Dikerjakan").querySelector("h3")!, { button: 2 });
    fireEvent.click(item(screen.getByRole("menu", { name: "Aksi untuk kolom Dikerjakan" }), "Task baru di Dikerjakan"));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Judul task baru di Dikerjakan" })).toHaveFocus());
  });

  it("Esc di menu kolom dari klik kanan mengembalikan fokus ke judul kolom", async () => {
    await renderBoard();
    const h3 = column("Selesai").querySelector("h3")!;
    fireEvent.contextMenu(column("Selesai"), { button: 2 });
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(h3).toHaveFocus();
  });

  it("klik kanan di kartu hanya membuka menu kartu, bukan menu kolom", async () => {
    await renderBoard();
    openCardMenu(1);
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.queryByRole("menu", { name: "Aksi untuk kolom To do" })).not.toBeInTheDocument();
  });

  it("Shift+F10 di judul kartu tidak membuka menu kolom", async () => {
    await renderBoard();
    fireEvent.keyDown(title(1), { key: "F10", shiftKey: true });
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.getByRole("menu", { name: "Aksi untuk PA-1" })).toBeInTheDocument();
  });
});

describe("Menu klik kanan dan seret kartu", () => {
  const MOUSE = { pointerType: "mouse", isPrimary: true };

  it("tekan tombol kanan (button 2) tidak memulai seret", async () => {
    await renderBoard();
    fireEvent.pointerDown(title(1), { ...MOUSE, button: 2, buttons: 2, pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(window, { ...MOUSE, button: -1, buttons: 2, pointerId: 1, clientX: 200, clientY: 200 });
    expect(cardEl(1)).not.toHaveClass("tc-dragging");
    expect(document.documentElement).not.toHaveClass("card-dragging");
    fireEvent.pointerUp(window, { ...MOUSE, button: 2, buttons: 0, pointerId: 1, clientX: 200, clientY: 200 });
    openCardMenu(1);
    expect(board.moveTask).not.toHaveBeenCalled();
  });

  it("Ctrl + tombol utama (klik kanan di macOS) tidak memulai seret", async () => {
    await renderBoard();
    fireEvent.pointerDown(title(1), { ...MOUSE, button: 0, buttons: 1, ctrlKey: true, pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(window, { ...MOUSE, button: -1, buttons: 1, ctrlKey: true, pointerId: 1, clientX: 200, clientY: 200 });
    expect(document.documentElement).not.toHaveClass("card-dragging");
    fireEvent.pointerUp(window, { ...MOUSE, button: 0, buttons: 0, pointerId: 1, clientX: 200, clientY: 200 });
  });

  it("menu tidak terbuka selama kartu diseret", async () => {
    await renderBoard();
    fireEvent.pointerDown(title(2), { ...MOUSE, button: 0, buttons: 1, pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(window, { ...MOUSE, button: -1, buttons: 1, pointerId: 1, clientX: 60, clientY: 60 });
    expect(document.documentElement).toHaveClass("card-dragging");
    const ev = fireEvent.contextMenu(cardEl(2), { button: 2 });
    expect(ev).toBe(false);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.contextMenu(column("To do"), { button: 2 });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.pointerCancel(window, { ...MOUSE, pointerId: 1 });
    expect(document.documentElement).not.toHaveClass("card-dragging");
  });

  it("menekan item menu tidak memulai seret kartu di belakangnya", async () => {
    await renderBoard();
    const menu = openCardMenu(1);
    const target = item(menu, "Salin kode PA-1");
    fireEvent.pointerDown(target, { ...MOUSE, button: 0, buttons: 1, pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(window, { ...MOUSE, button: -1, buttons: 1, pointerId: 1, clientX: 80, clientY: 80 });
    expect(document.documentElement).not.toHaveClass("card-dragging");
    fireEvent.pointerUp(window, { ...MOUSE, button: 0, buttons: 0, pointerId: 1, clientX: 80, clientY: 80 });
  });
});

describe("Permintaan dari daftar proyek (prop request)", () => {
  it("membuka panel Anggota dan dialog Ubah nama proyek setiap kali n berubah", async () => {
    const { rerender } = await renderBoard();
    const props = { projectId: P1, refreshKey: 0, taskOpen: false, onOpenTask, onProjectsChanged };
    rerender(<ProjectBoard {...props} request={{ kind: "members", n: 1 }} />);
    expect(await screen.findByRole("dialog", { name: "Anggota proyek" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Anggota proyek" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Anggota proyek" })).not.toBeInTheDocument());

    rerender(<ProjectBoard {...props} request={{ kind: "rename", n: 2 }} />);
    expect(await screen.findByRole("dialog", { name: "Ubah nama proyek" })).toBeInTheDocument();
  });

  it("Ubah nama proyek tidak dibuka tanpa hak kelola", async () => {
    current = view({ project: { ...PROJECT, canManage: false } });
    await renderBoard({ request: { kind: "rename", n: 1 } });
    expect(screen.queryByRole("dialog", { name: "Ubah nama proyek" })).not.toBeInTheDocument();
  });
});
