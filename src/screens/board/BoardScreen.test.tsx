import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardView, ColumnId, ProjectSummary, TaskCard, TaskDetail as TaskDetailData } from "../../api/board";
import { BOARD_SELECTION_KEY, BoardScreen, MY_TASKS } from "./BoardScreen";
import { directory, member, TEAM_1 } from "../../test/fixtures";
import { applyMove } from "./boardMoves";
import { NAME_RULE } from "./format";
import { CODE_RULE, NewProjectDialog, NO_TEAM_HINT } from "./NewProjectDialog";

const board = vi.hoisted(() => ({
  listProjects: vi.fn(),
  createProject: vi.fn(),
  getBoard: vi.fn(),
  createTask: vi.fn(),
  moveTask: vi.fn(),
  updateProject: vi.fn(),
}));

// Event board (lokal atau dari laptop lain) dipicu sendiri oleh tes lewat boardEvent().
const listeners = vi.hoisted(() => new Set<() => void>());

vi.mock("../../api/board", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/board")>()),
  boardApi: board,
  subscribeBoard: (handler: () => void) => {
    listeners.add(handler);
    return () => listeners.delete(handler);
  },
}));

const org = vi.hoisted(() => ({ getDirectory: vi.fn() }));

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return { ...actual, api: { ...actual.api, getDirectory: org.getDirectory } };
});

async function boardEvent() {
  await act(async () => {
    listeners.forEach((h) => h());
  });
}

// Detail task dan Task saya dibuat terpisah dan punya tes sendiri.
const fake = vi.hoisted(() => ({ removeTask: (_taskId: string) => {} }));

vi.mock("./TaskDetail", () => ({
  TaskDetail: ({
    projectId,
    taskId,
    onClose,
    onDeleted,
  }: {
    projectId: string;
    taskId: string;
    onClose: () => void;
    onDeleted?: (taskId: string, code: string) => void;
  }) => (
    <div role="dialog" aria-label="Detail task tiruan">
      <p>
        detail {projectId} {taskId}
      </p>
      <button type="button" onClick={onClose}>
        Tutup detail
      </button>
      <button
        type="button"
        onClick={() => {
          fake.removeTask(taskId);
          onDeleted?.(taskId, `PA-${Number(taskId)}`);
          onClose();
        }}
      >
        Hapus tiruan
      </button>
    </div>
  ),
}));

vi.mock("./MyTasks", () => ({
  MyTasks: () => <h2>Task saya tiruan</h2>,
}));

const P1 = "1".repeat(32);
const P2 = "2".repeat(32);
const ME = "a".repeat(64);

function project(id: string, code: string, name: string, extra: Partial<ProjectSummary> = {}): ProjectSummary {
  return { id, code, name, teamId: null, teamName: null, openCount: 2, taskCount: 3, canManage: true, ...extra };
}

const PROJECTS = [project(P1, "PA", "Proyek Alfa"), project(P2, "KB", "Kantor Baru", { openCount: 0, taskCount: 0 })];

function isoDaysFromToday(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

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
    ...extra,
  };
}

function view(extra: Partial<BoardView> = {}): BoardView {
  return {
    project: PROJECTS[0],
    columns: [
      {
        id: "todo",
        name: "To do",
        tasks: [
          card(1, "todo", {
            assignee: { publicKey: ME, name: "Rekan Uji" },
            due: isoDaysFromToday(-2),
            priority: "high",
            labels: ["kontrak"],
            commentCount: 3,
          }),
          card(2, "todo"),
        ],
      },
      { id: "doing", name: "Dikerjakan", tasks: [card(3, "doing", { merged: true })] },
      { id: "done", name: "Selesai", tasks: [card(4, "done", { due: isoDaysFromToday(-5) })] },
    ],
    assignees: [{ publicKey: ME, name: "Rekan Uji" }],
    me: ME,
    canCreate: true,
    ...extra,
  };
}

// Board di "inti Rust" tiruan: moveTask mengubahnya, getBoard membacanya.
let current: BoardView;

function detail(card: TaskCard): TaskDetailData {
  return {
    ...card,
    projectId: P1,
    description: "",
    createdBy: { publicKey: ME, name: "Rekan Uji" },
    createdAt: "2026-11-22T03:00:00Z",
    updatedAt: "2026-11-22T03:00:00Z",
    comments: [],
    activity: [],
    canEdit: true,
    canDelete: true,
    canComment: true,
  };
}

function emptyBoard(): BoardView {
  return view({ project: PROJECTS[1], columns: view().columns.map((c) => ({ ...c, tasks: [] })) });
}

beforeEach(() => {
  window.localStorage.clear();
  listeners.clear();
  org.getDirectory.mockReset().mockResolvedValue(directory());
  board.updateProject.mockReset();
  current = view();
  fake.removeTask = (id) => {
    current = { ...current, columns: current.columns.map((c) => ({ ...c, tasks: c.tasks.filter((t) => t.id !== id) })) };
  };
  board.listProjects.mockReset().mockResolvedValue(PROJECTS);
  board.getBoard.mockReset().mockImplementation(async (id: string) => (id === P2 ? emptyBoard() : current));
  board.createProject.mockReset();
  board.createTask.mockReset();
  board.moveTask.mockReset().mockImplementation(async (_p: string, id: string, columnId: ColumnId, index: number) => {
    current = applyMove(current, id, { columnId, index });
    return current;
  });
});

afterEach(() => {
  window.localStorage.clear();
});

async function renderBoard() {
  render(<BoardScreen />);
  await screen.findByRole("heading", { name: /Proyek Alfa/ });
}

// jsdom membuang spasi di tepi teks anak saat menghitung nama, browser tidak.
function colName(name: string, n: number) {
  return new RegExp(`^${name},\\s*${n}\\s*task$`);
}

function column(name: string) {
  return screen.getByRole("region", { name: new RegExp(`^${name},`) });
}

describe("Board: daftar proyek dan kolom", () => {
  it("menampilkan proyek, tiga kolom, dan isi kartu", async () => {
    await renderBoard();
    const nav = screen.getByRole("navigation", { name: "Task saya dan proyek" });
    const alfa = within(nav).getByRole("button", { name: /^PA\s*Proyek Alfa,\s*2\s*task belum selesai$/ });
    expect(alfa).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("button", { name: "Task saya" })).not.toHaveAttribute("aria-current");

    expect(screen.getByRole("heading", { name: colName("To do", 2) })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: colName("Dikerjakan", 1) })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: colName("Selesai", 1) })).toBeInTheDocument();

    const todo = column("To do");
    expect(within(todo).getByRole("button", { name: "Task nomor 1" })).toBeInTheDocument();
    expect(within(todo).getByText("PA-1")).toBeInTheDocument();
    expect(within(todo).getByText("RU")).toBeInTheDocument();
    expect(within(todo).getByText("Terlambat 2 hari")).toBeInTheDocument();
    expect(within(todo).getByText("Tinggi").closest(".chip")).toHaveClass("tc-pri-high");
    expect(within(todo).getByText("kontrak")).toBeInTheDocument();
    expect(within(column("Dikerjakan")).getByText("Diubah saat offline, sudah digabung")).toBeInTheDocument();
    // Task yang sudah selesai tidak ditandai terlambat.
    expect(within(column("Selesai")).queryByText(/Terlambat/)).not.toBeInTheDocument();
  });

  it("mengingat proyek yang dipilih dan membuka Task saya", async () => {
    const user = userEvent.setup();
    await renderBoard();
    await user.click(screen.getByRole("button", { name: /Kantor Baru/ }));
    expect(window.localStorage.getItem(BOARD_SELECTION_KEY)).toBe(P2);
    await waitFor(() => expect(board.getBoard).toHaveBeenCalledWith(P2));

    await user.click(screen.getByRole("button", { name: "Task saya" }));
    expect(await screen.findByRole("heading", { name: "Task saya tiruan" })).toBeInTheDocument();
    expect(window.localStorage.getItem(BOARD_SELECTION_KEY)).toBe(MY_TASKS);
  });

  it("membuka pilihan yang tersimpan", async () => {
    window.localStorage.setItem(BOARD_SELECTION_KEY, P2);
    render(<BoardScreen />);
    expect(await screen.findByRole("heading", { name: /Kantor Baru/ })).toBeInTheDocument();
    expect(board.getBoard).toHaveBeenCalledWith(P2);
  });

  it("klik kartu membuka detail task", async () => {
    const user = userEvent.setup();
    await renderBoard();
    await user.click(screen.getByRole("button", { name: "Task nomor 2" }));
    const dlg = screen.getByRole("dialog", { name: "Detail task tiruan" });
    expect(dlg).toHaveTextContent(`detail ${P1} ${taskId(2)}`);
    await user.click(within(dlg).getByRole("button", { name: "Tutup detail" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("Board: hapus task dari detail", () => {
  it("mengumumkan dan memindah fokus ke kartu sebelah di kolom yang sama", async () => {
    const user = userEvent.setup();
    await renderBoard();
    await user.click(screen.getByRole("button", { name: "Task nomor 1" }));
    await user.click(screen.getByRole("button", { name: "Hapus tiruan" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.querySelector(".pb [role=status]")).toHaveTextContent("PA-1 dihapus.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Task nomor 2" })).toHaveFocus());
    expect(screen.queryByRole("button", { name: "Task nomor 1" })).not.toBeInTheDocument();
  });

  it("kartu terakhir di kolom: fokus ke Tambah task kolom itu", async () => {
    const user = userEvent.setup();
    await renderBoard();
    await user.click(screen.getByRole("button", { name: "Task nomor 3" }));
    await user.click(screen.getByRole("button", { name: "Hapus tiruan" }));
    await waitFor(() => expect(within(column("Dikerjakan")).getByRole("button", { name: "Tambah task" })).toHaveFocus());
    expect(document.querySelector(".pb [role=status]")).toHaveTextContent("PA-3 dihapus.");
  });
});

describe("Board: keadaan kosong dan error", () => {
  it("belum ada proyek: mengajak membuat proyek pertama", async () => {
    const user = userEvent.setup();
    board.listProjects.mockResolvedValue([]);
    render(<BoardScreen />);
    expect(await screen.findByRole("heading", { name: "Belum ada proyek" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Buat proyek pertama" }));
    expect(screen.getByRole("dialog", { name: "Proyek baru" })).toBeInTheDocument();
  });

  it("daftar proyek gagal dibaca: penjelasan dan Coba lagi", async () => {
    const user = userEvent.setup();
    board.listProjects.mockRejectedValueOnce({ code: "database", message: "Database terkunci." });
    render(<BoardScreen />);
    expect(await screen.findByText("Daftar proyek belum terbaca")).toBeInTheDocument();
    expect(screen.getByText("Database terkunci.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Coba lagi" }));
    expect(await screen.findByRole("heading", { name: /Proyek Alfa/ })).toBeInTheDocument();
  });

  it("board gagal dibaca: Coba lagi memuat ulang board", async () => {
    const user = userEvent.setup();
    board.getBoard.mockRejectedValueOnce({ code: "database", message: "Database terkunci." });
    render(<BoardScreen />);
    expect(await screen.findByText("Board belum terbaca")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Coba lagi" }));
    expect(await screen.findByRole("heading", { name: /Proyek Alfa/ })).toBeInTheDocument();
  });
});

describe("Board: proyek baru", () => {
  it("mengusulkan kode dari nama, menolak kode yang salah, lalu membuat proyek", async () => {
    const user = userEvent.setup();
    const created = project("3".repeat(32), "LKU", "Laporan Keuangan", { openCount: 0, taskCount: 0 });
    board.createProject.mockResolvedValue(created);
    board.getBoard.mockImplementation(async (id: string) => (id === created.id ? view({ project: created }) : current));
    await renderBoard();
    await user.click(screen.getByRole("button", { name: "Proyek baru" }));
    const dlg = screen.getByRole("dialog", { name: "Proyek baru" });
    await user.type(within(dlg).getByLabelText("Nama proyek"), "Laporan Keuangan");
    const code = within(dlg).getByLabelText("Kode proyek");
    expect(code).toHaveValue("LK");

    await user.clear(code);
    await user.type(code, "1a");
    expect(code).toHaveValue("1A");
    await user.click(within(dlg).getByRole("button", { name: "Buat proyek" }));
    expect(within(dlg).getByText(CODE_RULE)).toBeInTheDocument();
    expect(code).toHaveAttribute("aria-invalid", "true");
    expect(code).toHaveFocus();
    expect(board.createProject).not.toHaveBeenCalled();

    // Nama diubah lagi: kode yang sudah diketik sendiri tidak ditimpa usulan.
    await user.type(within(dlg).getByLabelText("Nama proyek"), " Utama");
    expect(code).toHaveValue("1A");

    await user.clear(code);
    await user.type(code, "lku");
    board.listProjects.mockResolvedValue([...PROJECTS, created]);
    await user.click(within(dlg).getByRole("button", { name: "Buat proyek" }));
    // Bawaan: tim pertama yang boleh dipilih.
    expect(board.createProject).toHaveBeenCalledWith("Laporan Keuangan Utama", "LKU", TEAM_1);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(window.localStorage.getItem(BOARD_SELECTION_KEY)).toBe(created.id);
    expect(screen.getByRole("button", { name: /Laporan Keuangan/ })).toHaveAttribute("aria-current", "page");
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: /Laporan Keuangan/ })).toHaveFocus());
  });

  it("tanpa izin: pesan jelas dari inti Rust", async () => {
    const user = userEvent.setup();
    board.createProject.mockRejectedValue({ code: "forbidden", message: "Hanya superadmin atau admin tim yang bisa membuat proyek." });
    await renderBoard();
    await user.click(screen.getByRole("button", { name: "Proyek baru" }));
    const dlg = screen.getByRole("dialog", { name: "Proyek baru" });
    await user.type(within(dlg).getByLabelText("Nama proyek"), "Riset Pasar");
    await user.click(within(dlg).getByRole("button", { name: "Buat proyek" }));
    expect(await within(dlg).findByText("Anda tidak punya izin membuat proyek")).toBeInTheDocument();
    expect(within(dlg).getByText(/Minta salah satu dari mereka/)).toBeInTheDocument();
  });

  it("kode sudah dipakai: error ditampilkan di kolom kode", async () => {
    const user = userEvent.setup();
    board.createProject.mockRejectedValue({ code: "invalid_input", message: "Kode PA sudah dipakai proyek lain." });
    await renderBoard();
    await user.click(screen.getByRole("button", { name: "Proyek baru" }));
    const dlg = screen.getByRole("dialog", { name: "Proyek baru" });
    await user.type(within(dlg).getByLabelText("Nama proyek"), "Proyek Anyar");
    await user.click(within(dlg).getByRole("button", { name: "Buat proyek" }));
    expect(await within(dlg).findByText("Kode PA sudah dipakai proyek lain.")).toBeInTheDocument();
    expect(within(dlg).getByLabelText("Kode proyek")).toHaveAttribute("aria-invalid", "true");
  });
});

describe("Board: tambah task cepat", () => {
  it("Enter menyimpan, judul kosong ditolak, Escape menutup", async () => {
    const user = userEvent.setup();
    board.createTask.mockResolvedValue(detail(card(5, "doing", { title: "Cek invoice" })));
    await renderBoard();
    const doing = column("Dikerjakan");
    await user.click(within(doing).getByRole("button", { name: "Tambah task" }));
    const input = within(doing).getByLabelText("Judul task baru di Dikerjakan");
    expect(input).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(within(doing).getByText("Tulis judul task dulu.")).toBeInTheDocument();
    expect(board.createTask).not.toHaveBeenCalled();

    await user.type(input, "Cek invoice{Enter}");
    expect(board.createTask).toHaveBeenCalledWith(P1, { title: "Cek invoice", columnId: "doing" });
    await waitFor(() => expect(input).toHaveValue(""));
    expect(document.querySelector(".pb [role=status]")).toHaveTextContent("PA-5 dibuat di Dikerjakan.");

    await user.keyboard("{Escape}");
    expect(within(doing).queryByLabelText("Judul task baru di Dikerjakan")).not.toBeInTheDocument();
    expect(within(doing).getByRole("button", { name: "Tambah task" })).toHaveFocus();
  });

  it("teks yang belum disimpan tetap ada saat isian ditutup atau kolom lain dibuka", async () => {
    const user = userEvent.setup();
    await renderBoard();
    const todo = column("To do");
    await user.click(within(todo).getByRole("button", { name: "Tambah task" }));
    await user.type(within(todo).getByLabelText("Judul task baru di To do"), "Draf satu");
    await user.click(within(todo).getByRole("button", { name: "Tutup" }));
    await user.click(within(todo).getByRole("button", { name: "Tambah task" }));
    expect(within(todo).getByLabelText("Judul task baru di To do")).toHaveValue("Draf satu");

    await user.click(within(column("Selesai")).getByRole("button", { name: "Tambah task" }));
    expect(within(todo).queryByLabelText("Judul task baru di To do")).not.toBeInTheDocument();
    await user.click(within(todo).getByRole("button", { name: "Tambah task" }));
    expect(within(todo).getByLabelText("Judul task baru di To do")).toHaveValue("Draf satu");
    expect(board.createTask).not.toHaveBeenCalled();
  });

  it("tombol Task baru membuka isian di kolom To do", async () => {
    const user = userEvent.setup();
    await renderBoard();
    await user.click(screen.getByRole("button", { name: "Task baru" }));
    expect(within(column("To do")).getByLabelText("Judul task baru di To do")).toHaveFocus();
  });

  it("tanpa izin membuat task: tombol tambah dan pindah tidak ada", async () => {
    current = view({ canCreate: false });
    await renderBoard();
    expect(screen.queryByRole("button", { name: "Task baru" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Tambah task" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Pindahkan/ })).not.toBeInTheDocument();
  });
});

describe("Board: pindah task", () => {
  function liveText() {
    return document.querySelector(".pb [role=status]")?.textContent ?? "";
  }

  it("menu Pindahkan memindah ke kolom lain, mengumumkan, dan fokus tetap di kartu", async () => {
    const user = userEvent.setup();
    await renderBoard();
    await user.click(screen.getByRole("button", { name: "Pindahkan PA-1" }));
    const menu = screen.getByRole("menu", { name: "Pindahkan PA-1" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Ke Dikerjakan", "Ke Selesai", "Turun satu posisi"]);
    expect(items[0]).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(board.moveTask).toHaveBeenCalledWith(P1, taskId(1), "doing", 0);
    await waitFor(() => expect(liveText()).toBe("PA-1 dipindah ke Dikerjakan, posisi 1 dari 2."));
    expect(within(column("Dikerjakan")).getByRole("button", { name: "Task nomor 1" })).toHaveFocus();
    expect(screen.getByRole("heading", { name: colName("Dikerjakan", 2) })).toBeInTheDocument();
  });

  it("menu bisa ditutup dengan Escape, fokus kembali ke tombol", async () => {
    const user = userEvent.setup();
    await renderBoard();
    const btn = screen.getByRole("button", { name: "Pindahkan PA-2" });
    await user.click(btn);
    await user.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "Naik satu posisi" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Ke Dikerjakan" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(btn).toHaveFocus();
    expect(board.moveTask).not.toHaveBeenCalled();
  });

  it("Alt + panah mengubah urutan dan kolom", async () => {
    const user = userEvent.setup();
    await renderBoard();
    screen.getByRole("button", { name: "Task nomor 1" }).focus();

    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(board.moveTask).toHaveBeenLastCalledWith(P1, taskId(1), "todo", 1);
    await waitFor(() => expect(liveText()).toBe("PA-1 dipindah ke To do, posisi 2 dari 2."));
    expect(screen.getByRole("button", { name: "Task nomor 1" })).toHaveFocus();

    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(board.moveTask).toHaveBeenLastCalledWith(P1, taskId(1), "doing", 0);
    await waitFor(() => expect(liveText()).toBe("PA-1 dipindah ke Dikerjakan, posisi 1 dari 2."));
    expect(within(column("Dikerjakan")).getByRole("button", { name: "Task nomor 1" })).toHaveFocus();
  });

  it("Alt + panah kiri di kolom pertama tidak memindah, hanya memberi tahu", async () => {
    const user = userEvent.setup();
    await renderBoard();
    screen.getByRole("button", { name: "Task nomor 2" }).focus();
    await user.keyboard("{Alt>}{ArrowLeft}{/Alt}");
    expect(board.moveTask).not.toHaveBeenCalled();
    expect(liveText()).toBe("PA-2 sudah di kolom pertama.");
  });

  it("gagal pindah: kartu kembali ke tempatnya dan error ditampilkan", async () => {
    const user = userEvent.setup();
    board.moveTask.mockRejectedValueOnce({ code: "forbidden", message: "Tamu tidak bisa memindah task." });
    await renderBoard();
    screen.getByRole("button", { name: "Task nomor 1" }).focus();
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(await screen.findByText("Anda tidak punya izin memindah PA-1")).toBeInTheDocument();
    expect(screen.getByText("Tamu tidak bisa memindah task.")).toBeInTheDocument();
    expect(within(column("To do")).getByRole("button", { name: "Task nomor 1" })).toBeInTheDocument();
    expect(liveText()).toBe("PA-1 belum dipindah.");
  });

  it("satu pindahan gagal: hanya pindahan itu yang dibatalkan", async () => {
    const user = userEvent.setup();
    let failFirst: (reason: unknown) => void = () => {};
    let passSecond: () => void = () => {};
    board.moveTask
      .mockImplementationOnce(() => new Promise((_, reject) => (failFirst = reject)))
      .mockImplementationOnce(
        (_p: string, id: string, columnId: ColumnId, index: number) =>
          new Promise((resolve) => {
            passSecond = () => {
              current = applyMove(current, id, { columnId, index });
              resolve(current);
            };
          }),
      );
    await renderBoard();
    screen.getByRole("button", { name: "Task nomor 1" }).focus();
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    screen.getByRole("button", { name: "Task nomor 4" }).focus();
    await user.keyboard("{Alt>}{ArrowLeft}{/Alt}");
    expect(board.moveTask).toHaveBeenCalledTimes(2);
    // Dua pindahan tampil sebelum dijawab.
    expect(within(column("Dikerjakan")).getByRole("button", { name: "Task nomor 1" })).toBeInTheDocument();
    expect(within(column("Dikerjakan")).getByRole("button", { name: "Task nomor 4" })).toBeInTheDocument();

    passSecond();
    await waitFor(() => expect(liveText()).toBe("PA-4 dipindah ke Dikerjakan, posisi 1 dari 3."));
    // Pindahan pertama masih menunggu, jadi tetap tampil.
    expect(within(column("Dikerjakan")).getByRole("button", { name: "Task nomor 1" })).toBeInTheDocument();

    failFirst({ code: "database", message: "Database terkunci." });
    expect(await screen.findByText("PA-1 belum dipindah")).toBeInTheDocument();
    await waitFor(() => expect(within(column("To do")).getByRole("button", { name: "Task nomor 1" })).toBeInTheDocument());
    expect(within(column("Dikerjakan")).getByRole("button", { name: "Task nomor 4" })).toBeInTheDocument();
  });

  it("ganti proyek saat pindahan masih berjalan: board proyek baru tidak tertimpa", async () => {
    const user = userEvent.setup();
    let finish: () => void = () => {};
    board.moveTask.mockImplementationOnce(
      (_p: string, id: string, columnId: ColumnId, index: number) =>
        new Promise((resolve) => {
          finish = () => {
            current = applyMove(current, id, { columnId, index });
            resolve(current);
          };
        }),
    );
    await renderBoard();
    screen.getByRole("button", { name: "Task nomor 1" }).focus();
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    await user.click(screen.getByRole("button", { name: /Kantor Baru/ }));
    expect(await screen.findByRole("heading", { level: 2, name: /Kantor Baru/ })).toBeInTheDocument();
    finish();
    await waitFor(() => expect(board.getBoard).toHaveBeenLastCalledWith(P2));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByRole("heading", { level: 2, name: /Kantor Baru/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Task nomor 1" })).not.toBeInTheDocument();
  });

});

// Tata letak tiruan untuk seret: jsdom tidak menghitung posisi. Area board
// 900 x 600, tiga kolom selebar 300, kartu setinggi 50 mulai y = 40 tiap 60.
function mockLayout() {
  const COLS: ColumnId[] = ["todo", "doing", "done"];
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
  return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute("data-drop-area")) return rect(0, 0, 900, 600);
    const col = this.closest<HTMLElement>("[data-drop-col]");
    if (!col) return rect(0, 0, 0, 0);
    const left = COLS.indexOf(col.dataset.dropCol as ColumnId) * 300;
    if (this === col) return rect(left, 0, 280, 400);
    const card = this.closest<HTMLElement>("[data-card]");
    if (!card) return rect(0, 0, 0, 0);
    const i = Array.from(col.querySelectorAll("[data-card]")).indexOf(card);
    return rect(left + 10, 40 + i * 60, 260, 50);
  });
}

function cardEl(n: number) {
  return document.querySelector<HTMLElement>(`[data-card="${taskId(n)}"]`)!;
}

const MOUSE = { pointerType: "mouse", button: 0, buttons: 1, isPrimary: true };

// Seret dengan mouse: tekan di kartu, gerak bertahap, lepas.
function dragCard(n: number, to: { x: number; y: number }, opts: { release?: boolean } = {}) {
  const from = cardEl(n).getBoundingClientRect();
  const sx = from.left + 20;
  const sy = from.top + 20;
  const target = cardEl(n).querySelector<HTMLElement>("[data-open-task]")!;
  fireEvent.pointerDown(target, { ...MOUSE, pointerId: 1, clientX: sx, clientY: sy });
  for (let i = 1; i <= 5; i++)
    fireEvent.pointerMove(window, { ...MOUSE, pointerId: 1, clientX: sx + ((to.x - sx) * i) / 5, clientY: sy + ((to.y - sy) * i) / 5 });
  if (opts.release !== false) {
    fireEvent.pointerUp(window, { ...MOUSE, pointerId: 1, buttons: 0, clientX: to.x, clientY: to.y });
    fireEvent.click(target);
  }
}

describe("Board: seret kartu dengan mouse", () => {
  let layout: ReturnType<typeof mockLayout>;
  beforeEach(() => {
    layout = mockLayout();
  });
  afterEach(() => {
    layout.mockRestore();
  });

  it("seret ke kolom lain memanggil moveTask dengan posisi tujuan, tanpa membuka detail", async () => {
    await renderBoard();
    // Di bawah PA-4 (y 40 sampai 90) di Selesai: posisi kedua.
    dragCard(2, { x: 750, y: 200 });
    await waitFor(() => expect(board.moveTask).toHaveBeenCalledWith(P1, taskId(2), "done", 1));
    expect(await screen.findByRole("heading", { name: colName("Selesai", 2) })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Detail task tiruan" })).not.toBeInTheDocument();
    expect(await screen.findByText("PA-2 dipindah ke Selesai, posisi 2 dari 2.")).toBeInTheDocument();
  });

  it("selama seret: bayangan kartu, kolom tujuan disorot, dan garis sisip di posisi jatuh", async () => {
    await renderBoard();
    dragCard(2, { x: 450, y: 20 }, { release: false });
    const doing = column("Dikerjakan");
    expect(doing).toHaveClass("pb-col-over");
    // Garis sisip di atas PA-3: posisi pertama.
    expect(doing.querySelector(".pb-list")!.firstElementChild).toHaveClass("pb-drop");
    expect(cardEl(2)).toHaveClass("tc-dragging");
    expect(document.documentElement).toHaveClass("card-dragging");
    const ghost = document.body.querySelector<HTMLElement>(".tc-ghost")!;
    expect(ghost).toHaveAttribute("aria-hidden", "true");
    expect(ghost.querySelector("[data-open-task], [id]")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Task nomor 2" })).toHaveLength(1);

    fireEvent.pointerUp(window, { ...MOUSE, pointerId: 1, buttons: 0, clientX: 450, clientY: 20 });
    await waitFor(() => expect(board.moveTask).toHaveBeenCalledWith(P1, taskId(2), "doing", 0));
    expect(document.querySelector(".tc-ghost")).toBeNull();
    expect(document.querySelector(".pb-col-over")).toBeNull();
    expect(document.documentElement).not.toHaveClass("card-dragging");
  });

  it("seret di dalam kolom mengubah urutan", async () => {
    await renderBoard();
    // PA-1 diseret ke bawah PA-2 di To do.
    dragCard(1, { x: 150, y: 300 });
    await waitFor(() => expect(board.moveTask).toHaveBeenCalledWith(P1, taskId(1), "todo", 1));
    await waitFor(() =>
      expect(
        within(column("To do"))
          .getAllByRole("button", { name: /^Task nomor/ })
          .map((b) => b.textContent),
      ).toEqual(["Task nomor 2", "Task nomor 1"]),
    );
  });

  it("Escape membatalkan seret, dan gerak kecil tetap klik biasa", async () => {
    await renderBoard();
    dragCard(2, { x: 750, y: 200 }, { release: false });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector(".tc-ghost")).toBeNull();
    expect(document.querySelector(".pb-col-over")).toBeNull();
    fireEvent.pointerUp(window, { ...MOUSE, pointerId: 1, buttons: 0, clientX: 750, clientY: 200 });
    expect(board.moveTask).not.toHaveBeenCalled();

    // Geser 2 piksel lalu lepas: bukan seret, kartu terbuka.
    await new Promise((r) => setTimeout(r, 0));
    const btn = screen.getByRole("button", { name: "Task nomor 2" });
    fireEvent.pointerDown(btn, { ...MOUSE, pointerId: 2, clientX: 30, clientY: 120 });
    fireEvent.pointerMove(window, { ...MOUSE, pointerId: 2, clientX: 32, clientY: 120 });
    fireEvent.pointerUp(window, { ...MOUSE, pointerId: 2, buttons: 0, clientX: 32, clientY: 120 });
    fireEvent.click(btn);
    expect(screen.getByRole("dialog", { name: "Detail task tiruan" })).toBeInTheDocument();
    expect(board.moveTask).not.toHaveBeenCalled();
  });

  it("lepas di luar board tidak memindah apa pun", async () => {
    await renderBoard();
    dragCard(2, { x: 450, y: 800 });
    await new Promise((r) => setTimeout(r, 0));
    expect(board.moveTask).not.toHaveBeenCalled();
    expect(document.querySelector(".tc-ghost")).toBeNull();
  });

  it("menekan tombol Pindahkan tidak memulai seret", async () => {
    await renderBoard();
    const menu = screen.getByRole("button", { name: "Pindahkan PA-2" });
    fireEvent.pointerDown(menu, { ...MOUSE, pointerId: 3, clientX: 250, clientY: 120 });
    fireEvent.pointerMove(window, { ...MOUSE, pointerId: 3, clientX: 750, clientY: 200 });
    expect(document.querySelector(".tc-ghost")).toBeNull();
    fireEvent.pointerUp(window, { ...MOUSE, pointerId: 3, buttons: 0, clientX: 750, clientY: 200 });
    expect(board.moveTask).not.toHaveBeenCalled();
  });
});

describe("Board: muat ulang saat board berubah", () => {
  it("event board memuat ulang tanpa menimpa isian Tambah task yang sedang diketik", async () => {
    const user = userEvent.setup();
    await renderBoard();
    const todo = column("To do");
    await user.click(within(todo).getByRole("button", { name: "Tambah task" }));
    const input = within(todo).getByLabelText("Judul task baru di To do");
    await user.type(input, "Draf dari saya");

    current = {
      ...current,
      columns: current.columns.map((c) =>
        c.id === "doing" ? { ...c, tasks: [...c.tasks, card(9, "doing", { title: "Task dari rekan" })] } : c,
      ),
    };
    const calls = board.getBoard.mock.calls.length;
    await boardEvent();

    expect(await screen.findByRole("button", { name: "Task dari rekan" })).toBeInTheDocument();
    expect(board.getBoard.mock.calls.length).toBeGreaterThan(calls);
    expect(within(column("To do")).getByLabelText("Judul task baru di To do")).toHaveValue("Draf dari saya");
    expect(within(column("To do")).getByLabelText("Judul task baru di To do")).toHaveFocus();
    expect(board.createTask).not.toHaveBeenCalled();
  });

  it("kartu yang difokus dihapus rekan: fokus pindah ke kartu sebelahnya", async () => {
    await renderBoard();
    act(() => screen.getByRole("button", { name: "Task nomor 1" }).focus());
    fake.removeTask(taskId(1));
    await boardEvent();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Task nomor 1" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Task nomor 2" })).toHaveFocus();
  });

  it("kartu yang difokus dipindah rekan: fokus ikut ke tempat barunya", async () => {
    await renderBoard();
    act(() => screen.getByRole("button", { name: "Task nomor 2" }).focus());
    current = applyMove(current, taskId(2), { columnId: "done", index: 0 });
    await boardEvent();
    await waitFor(() => expect(within(column("Selesai")).getByRole("button", { name: "Task nomor 2" })).toHaveFocus());
  });

  it("proyek yang dibuka hilang dari daftar: keadaan kosong menjelaskan penyebabnya", async () => {
    const user = userEvent.setup();
    const teamProject = project(P1, "PA", "Proyek Alfa", { teamId: TEAM_1, teamName: "Keuangan" });
    board.listProjects.mockResolvedValue([teamProject, PROJECTS[1]]);
    current = view({ project: teamProject });
    await renderBoard();

    board.listProjects.mockResolvedValue([PROJECTS[1]]);
    await boardEvent();

    expect(await screen.findByRole("heading", { name: "Proyek PA Proyek Alfa tidak tersedia lagi" })).toBeInTheDocument();
    expect(screen.getByText(/milik Tim Keuangan/)).toBeInTheDocument();
    // Diumumkan ke pembaca layar, dan fokus yang tertinggal di board pindah ke penjelasannya.
    expect(screen.getAllByRole("status").map((s) => s.textContent)).toContain("Proyek PA Proyek Alfa tidak tersedia lagi.");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Proyek PA Proyek Alfa tidak tersedia lagi" })).toHaveFocus(),
    );
    expect(screen.getByText(/dikeluarkan dari tim itu/)).toBeInTheDocument();
    // Board proyek lain tidak dibuka diam-diam.
    expect(screen.queryByRole("heading", { level: 2, name: /^KB/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Buka KB Kantor Baru" }));
    expect(await screen.findByRole("heading", { level: 2, name: /Kantor Baru/ })).toBeInTheDocument();
  });

  it("menampilkan siapa yang melihat board: tim atau seluruh organisasi", async () => {
    await renderBoard();
    expect(screen.getByText("Seluruh organisasi")).toBeInTheDocument();
  });
});

describe("Board: Tamu hanya melihat", () => {
  it("tanpa tambah, pindah, seret, atau Alt+panah, dengan satu keterangan", async () => {
    const user = userEvent.setup();
    current = view({ canCreate: false, project: { ...PROJECTS[0], canManage: false } });
    await renderBoard();
    expect(screen.getByText(/Board ini hanya bisa dilihat/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Task baru" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Tambah task" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Pindahkan/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ubah nama proyek" })).not.toBeInTheDocument();
    const art = document.querySelector<HTMLElement>(`[data-card="${taskId(1)}"]`)!;
    expect(art).not.toHaveAttribute("data-movable");
    const pointer = { pointerId: 1, pointerType: "mouse", button: 0, buttons: 1 };
    fireEvent.pointerDown(art, { ...pointer, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { ...pointer, clientX: 400, clientY: 200 });
    fireEvent.pointerUp(window, { ...pointer, clientX: 400, clientY: 200 });
    expect(document.querySelector(".tc-ghost")).toBeNull();

    screen.getByRole("button", { name: "Task nomor 1" }).focus();
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(board.moveTask).not.toHaveBeenCalled();

    // Kartu tetap bisa dibuka untuk dibaca.
    await user.click(screen.getByRole("button", { name: "Task nomor 1" }));
    expect(screen.getByRole("dialog", { name: "Detail task tiruan" })).toBeInTheDocument();
  });
});

describe("Board: ubah nama proyek", () => {
  it("memeriksa panjang nama, lalu menyimpan dan memperbarui judul board", async () => {
    const user = userEvent.setup();
    board.updateProject.mockImplementation(async (_id: string, name: string) => {
      const renamed = { ...PROJECTS[0], name };
      current = { ...current, project: renamed };
      board.listProjects.mockResolvedValue([renamed, PROJECTS[1]]);
      return renamed;
    });
    await renderBoard();
    await user.click(screen.getByRole("button", { name: "Ubah nama proyek" }));
    const dlg = screen.getByRole("dialog", { name: "Ubah nama proyek" });
    const input = within(dlg).getByLabelText("Nama proyek");
    expect(input).toHaveValue("Proyek Alfa");

    await user.clear(input);
    await user.type(input, "A");
    await user.click(within(dlg).getByRole("button", { name: "Simpan nama" }));
    expect(within(dlg).getByText(NAME_RULE)).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(board.updateProject).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, "Proyek Alfa Baru");
    await user.click(within(dlg).getByRole("button", { name: "Simpan nama" }));
    expect(board.updateProject).toHaveBeenCalledWith(P1, "Proyek Alfa Baru");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByRole("heading", { level: 2, name: /Proyek Alfa Baru/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Ubah nama proyek" })).toHaveFocus());
  });

  it("error dari inti Rust ditampilkan di dialog", async () => {
    const user = userEvent.setup();
    board.updateProject.mockRejectedValue({ code: "forbidden", message: "Hanya admin tim yang bisa mengubah nama." });
    await renderBoard();
    await user.click(screen.getByRole("button", { name: "Ubah nama proyek" }));
    const dlg = screen.getByRole("dialog", { name: "Ubah nama proyek" });
    await user.type(within(dlg).getByLabelText("Nama proyek"), " 2");
    await user.click(within(dlg).getByRole("button", { name: "Simpan nama" }));
    expect(await within(dlg).findByText("Anda tidak punya izin mengubah nama proyek ini")).toBeInTheDocument();
    expect(within(dlg).getByText("Hanya admin tim yang bisa mengubah nama.")).toBeInTheDocument();
  });

  it("tanpa izin mengelola proyek: tombol tidak ada", async () => {
    current = view({ project: { ...PROJECTS[0], canManage: false } });
    await renderBoard();
    expect(screen.queryByRole("button", { name: "Ubah nama proyek" })).not.toBeInTheDocument();
  });
});

describe("Board: proyek baru dan tim", () => {
  async function openNewProject(user: ReturnType<typeof userEvent.setup>) {
    await renderBoard();
    await user.click(screen.getByRole("button", { name: "Proyek baru" }));
    return screen.getByRole("dialog", { name: "Proyek baru" });
  }

  it("superadmin di satu tim: tim itu jadi bawaan, tanpa tim tetap bisa dipilih", async () => {
    const user = userEvent.setup();
    const created = project("3".repeat(32), "RO", "Rencana Organisasi");
    board.createProject.mockResolvedValue(created);
    const dlg = await openNewProject(user);
    const team = await within(dlg).findByRole("combobox", { name: "Tim" });
    expect(team).toHaveValue(TEAM_1);
    expect(within(team).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Tim Uji",
      "Tanpa tim (seluruh organisasi)",
    ]);
    expect(within(dlg).getByText(/hanya terlihat dan tersinkron ke anggota Tim Uji dan Tamu yang diundang/)).toBeInTheDocument();

    await user.selectOptions(team, "");
    expect(within(dlg).getByText(/semua anggota organisasi, kecuali Tamu/)).toBeInTheDocument();
    await user.type(within(dlg).getByLabelText("Nama proyek"), "Rencana Organisasi");
    await user.click(within(dlg).getByRole("button", { name: "Buat proyek" }));
    expect(board.createProject).toHaveBeenCalledWith("Rencana Organisasi", "RO", null);
  });

  it("superadmin yang belum masuk tim: hanya tanpa tim, dengan petunjuk", async () => {
    const user = userEvent.setup();
    org.getDirectory.mockResolvedValue(
      directory({ teams: [{ id: TEAM_1, name: "Tim Uji", createdAt: "2026-11-22T03:00:00Z", members: [] }] }),
    );
    const dlg = await openNewProject(user);
    const team = await within(dlg).findByRole("combobox", { name: "Tim" });
    expect(within(team).getAllByRole("option").map((o) => o.textContent)).toEqual(["Tanpa tim (seluruh organisasi)"]);
    expect(within(dlg).getByText(NO_TEAM_HINT)).toBeInTheDocument();
  });

  it("admin tim bukan superadmin: tim yang dia kelola saja", async () => {
    const user = userEvent.setup();
    const TEAM_2 = "2".repeat(32);
    org.getDirectory.mockResolvedValue(
      directory({
        me: { publicKey: "a".repeat(64), isSuperadmin: false },
        teams: [
          { id: TEAM_1, name: "Tim Uji", createdAt: "2026-11-22T03:00:00Z", members: [{ publicKey: "a".repeat(64), role: "admin" }] },
          { id: TEAM_2, name: "Gudang", createdAt: "2026-11-22T03:00:00Z", members: [{ publicKey: "a".repeat(64), role: "member" }] },
        ],
      }),
    );
    const dlg = await openNewProject(user);
    const team = await within(dlg).findByRole("combobox", { name: "Tim" });
    expect(within(team).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Tim Uji",
      "Tanpa tim (seluruh organisasi)",
    ]);
  });

  const memberOnly = () =>
    directory({
      me: { publicKey: "a".repeat(64), isSuperadmin: false },
      members: [member("a".repeat(64), "Penguji", { teams: [{ teamId: TEAM_1, role: "member" }] })],
      teams: [
        { id: TEAM_1, name: "Tim Uji", createdAt: "2026-11-22T03:00:00Z", members: [{ publicKey: "a".repeat(64), role: "member" }] },
      ],
    });

  it("anggota biasa: tombol Proyek baru tidak ada, keadaan kosong menjelaskan siapa yang membuat proyek", async () => {
    org.getDirectory.mockResolvedValue(memberOnly());
    board.listProjects.mockResolvedValue([]);
    render(<BoardScreen />);
    expect(await screen.findByRole("heading", { name: "Belum ada proyek yang bisa Anda lihat" })).toBeInTheDocument();
    expect(screen.getByText(/Proyek dibuat oleh superadmin atau admin tim/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Proyek baru" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Buat proyek pertama" })).not.toBeInTheDocument();
  });

  it("dialog dibuka saat ternyata tidak berhak: dijelaskan dan tombol buat mati", async () => {
    org.getDirectory.mockResolvedValue(memberOnly());
    render(<NewProjectDialog open onOpenChange={() => {}} onCreated={() => {}} />);
    const dlg = screen.getByRole("dialog", { name: "Proyek baru" });
    expect(await within(dlg).findByText(/Hanya superadmin atau admin tim yang bisa membuat proyek/)).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Buat proyek" })).toBeDisabled();
  });

  it("daftar tim gagal dibaca: Buat proyek mati sampai daftar tim terbaca", async () => {
    const user = userEvent.setup();
    org.getDirectory.mockRejectedValue({ code: "database", message: "Database terkunci." });
    board.createProject.mockResolvedValue(project("3".repeat(32), "RIS", "Riset"));
    const dlg = await openNewProject(user);
    expect(await within(dlg).findByText(/Daftar tim belum terbaca \(Database terkunci\.\)/)).toBeInTheDocument();
    await user.type(within(dlg).getByLabelText("Nama proyek"), "Riset");
    expect(within(dlg).getByRole("button", { name: "Buat proyek" })).toBeDisabled();

    org.getDirectory.mockResolvedValue(directory());
    await user.click(within(dlg).getByRole("button", { name: "Coba baca lagi" }));
    expect(await within(dlg).findByRole("combobox", { name: "Tim" })).toHaveValue(TEAM_1);
    await user.click(within(dlg).getByRole("button", { name: "Buat proyek" }));
    expect(board.createProject).toHaveBeenCalledWith("Riset", "RIS", TEAM_1);
  });
});

describe("Board: nama proyek diubah rekan saat dialog terbuka", () => {
  it("Simpan tanpa mengetik tidak mengirim nama lama, dan perubahan rekan diberitahukan", async () => {
    const user = userEvent.setup();
    await renderBoard();
    await user.click(screen.getByRole("button", { name: "Ubah nama proyek" }));
    const dlg = screen.getByRole("dialog", { name: "Ubah nama proyek" });
    const input = within(dlg).getByLabelText("Nama proyek");
    expect(input).toHaveFocus();

    const renamed = { ...PROJECTS[0], name: "Proyek Alfa Rekan" };
    current = { ...current, project: renamed };
    board.listProjects.mockResolvedValue([renamed, PROJECTS[1]]);
    await boardEvent();

    expect(await within(dlg).findByText(/Nama ini baru diubah di laptop lain menjadi "Proyek Alfa Rekan"/)).toBeInTheDocument();
    // Isian yang difokus tidak berubah di bawah kursor.
    expect(input).toHaveValue("Proyek Alfa");
    await user.click(within(dlg).getByRole("button", { name: "Simpan nama" }));
    expect(board.updateProject).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { level: 2, name: /Proyek Alfa Rekan/ })).toBeInTheDocument();
  });

  it("sudah mengetik: diberi tahu bahwa Simpan mengganti nama dari rekan", async () => {
    const user = userEvent.setup();
    board.updateProject.mockImplementation(async (_id: string, name: string) => ({ ...PROJECTS[0], name }));
    await renderBoard();
    await user.click(screen.getByRole("button", { name: "Ubah nama proyek" }));
    const dlg = screen.getByRole("dialog", { name: "Ubah nama proyek" });
    await user.type(within(dlg).getByLabelText("Nama proyek"), " Saya");

    const renamed = { ...PROJECTS[0], name: "Proyek Alfa Rekan" };
    current = { ...current, project: renamed };
    await boardEvent();

    expect(await within(dlg).findByText(/Simpan nama mengganti nama itu dengan ketikan Anda/)).toBeInTheDocument();
    expect(within(dlg).getByLabelText("Nama proyek")).toHaveValue("Proyek Alfa Saya");
    await user.click(within(dlg).getByRole("button", { name: "Simpan nama" }));
    expect(board.updateProject).toHaveBeenCalledWith(P1, "Proyek Alfa Saya");
  });
});

describe("Board: proyek tim", () => {
  it("chip menunjukkan tim pemilik proyek", async () => {
    const teamProject = project(P1, "PA", "Proyek Alfa", { teamId: TEAM_1, teamName: "Keuangan" });
    board.listProjects.mockResolvedValue([teamProject, PROJECTS[1]]);
    current = view({ project: teamProject });
    await renderBoard();
    expect(screen.getByText("Tim Keuangan")).toBeInTheDocument();
    expect(screen.queryByText("Seluruh organisasi")).not.toBeInTheDocument();
  });
});
