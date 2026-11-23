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

  it("pemisah sesudah Buka task dan sebelum kelompok timer dan salin", async () => {
    current = withCard(2, { canDelete: true });
    await renderBoard();
    const menu = openCardMenu(2);
    const rows = Array.from(menu.querySelectorAll("[role=menuitem], [role=separator]")).map((el) =>
      el.getAttribute("role") === "separator" ? "|" : el.getAttribute("data-menu-item"),
    );
    expect(rows).toEqual(["open", "|", "move", "assign", "priority", "due", "|", "timer-start", "copy", "|", "delete"]);
  });

  it("tamu: pemisah yang berdampingan dirapikan jadi satu", async () => {
    current = view({ canCreate: false });
    await renderBoard();
    const menu = openCardMenu(1);
    const rows = Array.from(menu.querySelectorAll("[role=menuitem], [role=separator]")).map((el) =>
      el.getAttribute("role") === "separator" ? "|" : el.getAttribute("data-menu-item"),
    );
    expect(rows).toEqual(["open", "|", "copy"]);
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

  it("Tugaskan ke: penanggung jawab lama yang bukan anggota lagi tampil nonaktif di bawah anggota", async () => {
    const PK_C = "c".repeat(64);
    current = withCard(2, { assignee: { publicKey: PK_C, name: "Citra Lama" } });
    await renderBoard();
    const sub = await openSub(2, "Tugaskan ke", "Tugaskan PA-2 ke");
    expect(within(sub).getAllByRole("menuitem").map((el) => el.getAttribute("data-menu-item"))).toEqual([
      "__back",
      `assign-${ME}`,
      `assign-${PK_B}`,
      `assign-${PK_C}`,
      "assign-none",
    ]);
    const former = item(sub, "Citra Lama (bukan anggota proyek lagi)");
    expect(former).toHaveAttribute("aria-disabled", "true");
    expect(former).toHaveAccessibleDescription("Penanggung jawab sekarang");
    fireEvent.click(former);
    expect(board.updateTask).not.toHaveBeenCalled();
    // Mengosongkan tetap bisa.
    expect(item(sub, "Tanpa penanggung jawab")).not.toHaveAttribute("aria-disabled");
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
    // Kartu tanpa tenggat: Hapus tenggat tetap tampil, nonaktif dengan alasan.
    expect(within(sub).getAllByRole("menuitem").map((el) => el.getAttribute("data-menu-item"))).toEqual([
      "__back",
      "due-today",
      "due-tomorrow",
      "due-clear",
      "due-other",
    ]);
    expect(item(sub, "Hapus tenggat")).toHaveAttribute("aria-disabled", "true");
    expect(item(sub, "Hapus tenggat")).toHaveAccessibleDescription("Belum ada tenggat");
    fireEvent.click(item(sub, "Hapus tenggat"));
    expect(board.updateTask).not.toHaveBeenCalled();
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
    fireEvent.click(item(openCardMenu(3), "Mulai timer saya"));
    await waitFor(() => expect(board.startTimer).toHaveBeenCalledWith(P1, taskId(3)));
    // Inti Rust menghentikan timer saya di PA-2; pengumumannya menyebut itu.
    expect(await screen.findByText("Timer Anda di PA-3 berjalan. Timer di PA-2 dihentikan.")).toBeInTheDocument();

    fireEvent.click(item(openCardMenu(2), "Hentikan timer saya"));
    await waitFor(() => expect(board.stopTimer).toHaveBeenCalledWith(P1, taskId(2), null));
    expect(await screen.findByText("Timer Anda di PA-2 berhenti.")).toBeInTheDocument();
  });

  it("Mulai timer saya tanpa timer lain yang berjalan: pengumuman tanpa catatan", async () => {
    // Timer rekan (bukan milik saya) di PA-2 tidak disebut.
    current = withCard(2, { timersRunningSince: ["2026-11-24T02:00:00Z"] });
    await renderBoard();
    fireEvent.click(item(openCardMenu(1), "Mulai timer saya"));
    await waitFor(() => expect(board.startTimer).toHaveBeenCalledWith(P1, taskId(1)));
    expect(await screen.findByText("Timer Anda di PA-1 berjalan.")).toBeInTheDocument();
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
    // Arahannya bisa diikuti: memilih teks di kartu memulai seret, dan Ctrl+C beda di macOS.
    const hint = screen.getByText(/Papan klip tidak bisa dipakai saat ini/);
    expect(hint).toHaveTextContent("buka task-nya untuk melihat kodenya");
    expect(hint).not.toHaveTextContent("Ctrl");
  });

  it("Hapus task minta konfirmasi, memanggil deleteTask, lalu fokus ke kartu berikutnya", async () => {
    current = withCard(1, { canDelete: true, subtaskTotal: 2, commentCount: 1, trackedSecs: 600 });
    await renderBoard();
    fireEvent.click(item(openCardMenu(1), "Hapus task"));
    const dialog = await screen.findByRole("dialog", { name: "Hapus task PA-1?" });
    // Catatan waktu masuk daftar "beserta" tanpa angka; kalimat tidak bisa dibatalkan tetap paling akhir.
    expect(within(dialog).getByText(/^"Task nomor 1" beserta/)).toHaveTextContent(
      /^"Task nomor 1" beserta 2 subtask, 1 komentar, dan catatan waktunya terhapus dari board semua anggota proyek dan dari Task saya\. Mira belum punya cara mengembalikannya\.$/,
    );
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

  describe("hapus selagi pindahan kartu yang sama masih berjalan", () => {
    function deferMove() {
      let settle!: { resolve: (v: BoardView) => void; reject: (e: unknown) => void };
      board.moveTask.mockImplementationOnce(
        () =>
          new Promise<BoardView>((resolve, reject) => {
            settle = { resolve, reject };
          }),
      );
      return () => settle;
    }

    async function moveThenDelete() {
      current = withCard(1, { canDelete: true });
      const stale = current;
      const pending = deferMove();
      await renderBoard();
      const sub = await openSub(1, "Pindahkan ke", "Pindahkan PA-1 ke");
      fireEvent.click(item(sub, "Dikerjakan"));
      await waitFor(() => expect(board.moveTask).toHaveBeenCalledWith(P1, taskId(1), "doing", 0));
      // Kartu sudah tampil di Dikerjakan (optimis).
      expect(within(column("Dikerjakan")).getByRole("button", { name: "Task nomor 1" })).toBeInTheDocument();
      fireEvent.click(item(openCardMenu(1), "Hapus task"));
      const dialog = await screen.findByRole("dialog", { name: "Hapus task PA-1?" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Hapus PA-1" }));
      await waitFor(() => expect(board.deleteTask).toHaveBeenCalledWith(P1, taskId(1)));
      expect(await screen.findByText("PA-1 dihapus.")).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByRole("button", { name: "Task nomor 1" })).not.toBeInTheDocument());
      return { settle: pending(), stale };
    }

    it("galat pindah sesudahnya diabaikan: tanpa pesan dikembalikan, kartu tetap hilang", async () => {
      const { settle } = await moveThenDelete();
      await act(async () => {
        settle.reject({ code: "not_found", message: "Task tidak ditemukan." });
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(screen.queryByText("PA-1 sudah tidak ada di board ini")).not.toBeInTheDocument();
      expect(screen.queryByText("Kartu dikembalikan ke tempat semula.")).not.toBeInTheDocument();
      expect(screen.queryByText("PA-1 belum dipindah.")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Task nomor 1" })).not.toBeInTheDocument();
      expect(screen.getByText("PA-1 dihapus.")).toBeInTheDocument();
    });

    it("jawaban berhasil yang datang terlambat tidak memunculkan kartunya lagi", async () => {
      const { settle, stale } = await moveThenDelete();
      await act(async () => {
        settle.resolve(applyMove(stale, taskId(1), { columnId: "doing", index: 0 }));
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(screen.queryByRole("button", { name: "Task nomor 1" })).not.toBeInTheDocument();
      expect(screen.queryByText(/PA-1 dipindah ke/)).not.toBeInTheDocument();
      expect(screen.getByText("PA-1 dihapus.")).toBeInTheDocument();
    });
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

  it("macOS: Ctrl + tombol utama (klik kanan di macOS) tidak memulai seret", async () => {
    const ua = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15");
    try {
      await renderBoard();
      fireEvent.pointerDown(title(1), { ...MOUSE, button: 0, buttons: 1, ctrlKey: true, pointerId: 1, clientX: 20, clientY: 20 });
      fireEvent.pointerMove(window, { ...MOUSE, button: -1, buttons: 1, ctrlKey: true, pointerId: 1, clientX: 200, clientY: 200 });
      expect(document.documentElement).not.toHaveClass("card-dragging");
      fireEvent.pointerUp(window, { ...MOUSE, button: 0, buttons: 0, pointerId: 1, clientX: 200, clientY: 200 });
    } finally {
      ua.mockRestore();
    }
  });

  it("Windows: Ctrl + seret tetap memulai seret seperti sebelumnya", async () => {
    const ua = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/120.0");
    try {
      await renderBoard();
      fireEvent.pointerDown(title(1), { ...MOUSE, button: 0, buttons: 1, ctrlKey: true, pointerId: 1, clientX: 20, clientY: 20 });
      fireEvent.pointerMove(window, { ...MOUSE, button: -1, buttons: 1, ctrlKey: true, pointerId: 1, clientX: 60, clientY: 60 });
      expect(document.documentElement).toHaveClass("card-dragging");
      fireEvent.pointerCancel(window, { ...MOUSE, pointerId: 1 });
    } finally {
      ua.mockRestore();
    }
  });

  it("klik kanan selagi tombol kiri ditahan (belum seret) membuka menu dan membatalkan seret", async () => {
    await renderBoard();
    fireEvent.pointerDown(title(2), { ...MOUSE, button: 0, buttons: 1, pointerId: 1, clientX: 20, clientY: 20 });
    // Belum lewat ambang 5 px.
    fireEvent.pointerMove(window, { ...MOUSE, button: -1, buttons: 1, pointerId: 1, clientX: 22, clientY: 21 });
    expect(document.documentElement).not.toHaveClass("card-dragging");
    const menu = openCardMenu(2);
    fireEvent.pointerMove(window, { ...MOUSE, button: -1, buttons: 1, pointerId: 1, clientX: 200, clientY: 200 });
    expect(document.documentElement).not.toHaveClass("card-dragging");
    expect(cardEl(2)).not.toHaveClass("tc-dragging");
    expect(menu).toBeInTheDocument();
    fireEvent.pointerUp(window, { ...MOUSE, button: 0, buttons: 0, pointerId: 1, clientX: 200, clientY: 200 });
    expect(board.moveTask).not.toHaveBeenCalled();
  });

  it("Shift+F10 selagi tombol kiri ditahan juga membatalkan seret yang tertunda", async () => {
    await renderBoard();
    fireEvent.pointerDown(title(2), { ...MOUSE, button: 0, buttons: 1, pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.keyDown(title(2), { key: "F10", shiftKey: true });
    expect(screen.getByRole("menu", { name: "Aksi untuk PA-2" })).toBeInTheDocument();
    fireEvent.pointerMove(window, { ...MOUSE, button: -1, buttons: 1, pointerId: 1, clientX: 200, clientY: 200 });
    expect(document.documentElement).not.toHaveClass("card-dragging");
    fireEvent.pointerUp(window, { ...MOUSE, button: 0, buttons: 0, pointerId: 1, clientX: 200, clientY: 200 });
    expect(board.moveTask).not.toHaveBeenCalled();
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

describe("Menu kartu dan dropdown Pindahkan: tidak ada dua menu sekaligus", () => {
  async function openMoveMenu(n: number) {
    fireEvent.click(screen.getByRole("button", { name: `Pindahkan PA-${n}` }));
    const mv = screen.getByRole("menu", { name: `Pindahkan PA-${n}` });
    expect(within(mv).getAllByRole("menuitem")[0]).toHaveFocus();
    return mv;
  }

  it("Shift+F10 dan tombol Menu di dropdown Pindahkan tidak membuka menu kartu atau kolom", async () => {
    await renderBoard();
    const mv = await openMoveMenu(1);
    const first = within(mv).getAllByRole("menuitem")[0];
    fireEvent.keyDown(first, { key: "F10", shiftKey: true });
    fireEvent.keyDown(first, { key: "ContextMenu" });
    expect(screen.getAllByRole("menu")).toEqual([mv]);
    expect(first).toHaveFocus();
  });

  it("klik kanan di dropdown Pindahkan tidak membuka menu kartu, kolom, atau menu bawaan", async () => {
    await renderBoard();
    const mv = await openMoveMenu(1);
    const first = within(mv).getAllByRole("menuitem")[0];
    const ev = fireEvent.contextMenu(first, { button: 2, clientX: 0, clientY: 0 });
    expect(ev).toBe(false);
    expect(screen.getAllByRole("menu")).toEqual([mv]);
  });

  it("menu kartu yang terbuka dari bagian lain kartu menutup dropdown Pindahkan", async () => {
    await renderBoard();
    await openMoveMenu(1);
    const menu = openCardMenu(1);
    expect(screen.queryByRole("menu", { name: "Pindahkan PA-1" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("menu")).toEqual([menu]);
    // Esc mengembalikan fokus ke kartu, bukan ke item dropdown yang sudah hilang.
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(cardEl(1)).toContainElement(document.activeElement as HTMLElement);
  });

  it("fokus pindah ke luar dropdown Pindahkan menutupnya", async () => {
    await renderBoard();
    await openMoveMenu(1);
    act(() => title(2).focus());
    expect(screen.queryByRole("menu", { name: "Pindahkan PA-1" })).not.toBeInTheDocument();
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
