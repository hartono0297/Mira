import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardView, ColumnId, ProjectSummary, TaskCard, TaskDetail as TaskDetailData } from "../../api/board";
import { BOARD_SELECTION_KEY, BoardScreen, MY_TASKS } from "./BoardScreen";
import { applyMove } from "./boardMoves";
import { CODE_RULE } from "./NewProjectDialog";

const board = vi.hoisted(() => ({
  listProjects: vi.fn(),
  createProject: vi.fn(),
  getBoard: vi.fn(),
  createTask: vi.fn(),
  moveTask: vi.fn(),
}));

vi.mock("../../api/board", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/board")>()),
  boardApi: board,
  subscribeBoard: () => () => {},
}));

// Detail task dan Task saya dibuat terpisah dan punya tes sendiri.
vi.mock("./TaskDetail", () => ({
  TaskDetail: ({ projectId, taskId, onClose }: { projectId: string; taskId: string; onClose: () => void }) => (
    <div role="dialog" aria-label="Detail task tiruan">
      <p>
        detail {projectId} {taskId}
      </p>
      <button type="button" onClick={onClose}>
        Tutup detail
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
  return { id, code, name, teamId: null, openCount: 2, taskCount: 3, canManage: true, ...extra };
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
  };
}

beforeEach(() => {
  window.localStorage.clear();
  current = view();
  board.listProjects.mockReset().mockResolvedValue(PROJECTS);
  board.getBoard.mockReset().mockImplementation(async () => current);
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
    expect(within(todo).getByText("Tinggi")).toBeInTheDocument();
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
    current = view({ project: PROJECTS[1], columns: view().columns.map((c) => ({ ...c, tasks: [] })) });
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
    expect(board.createProject).toHaveBeenCalledWith("Laporan Keuangan Utama", "LKU", null);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(window.localStorage.getItem(BOARD_SELECTION_KEY)).toBe(created.id);
    expect(screen.getByRole("button", { name: /Laporan Keuangan/ })).toHaveAttribute("aria-current", "page");
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

  it("drag-and-drop memanggil moveTask dengan posisi tujuan", async () => {
    await renderBoard();
    const art = document.querySelector<HTMLElement>(`[data-card="${taskId(2)}"]`)!;
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (k: string, v: string) => data.set(k, v),
      getData: (k: string) => data.get(k) ?? "",
      effectAllowed: "",
      dropEffect: "",
    };
    fireEvent.dragStart(art, { dataTransfer });
    const done = column("Selesai");
    fireEvent.dragOver(done, { dataTransfer, clientY: 0 });
    fireEvent.drop(done, { dataTransfer });
    await waitFor(() => expect(board.moveTask).toHaveBeenCalledWith(P1, taskId(2), "done", 1));
    expect(await screen.findByRole("heading", { name: colName("Selesai", 2) })).toBeInTheDocument();
  });
});
