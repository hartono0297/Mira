import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardView, TaskDetail as Task } from "../../api/board";
import { activitySentence } from "./taskActivity";
import { TaskDetail } from "./TaskDetail";

const board = vi.hoisted(() => ({
  getTask: vi.fn(),
  getBoard: vi.fn(),
  updateTask: vi.fn(),
  moveTask: vi.fn(),
  addComment: vi.fn(),
  deleteTask: vi.fn(),
  myTasks: vi.fn(),
}));

vi.mock("../../api/board", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/board")>()),
  boardApi: board,
  subscribeBoard: () => () => {},
}));

const ME = "a".repeat(64);
const PK_B = "b".repeat(64);
const P = "1".repeat(32);
const T = "2".repeat(32);
const penguji = { publicKey: ME, name: "Penguji" };
const sari = { publicKey: PK_B, name: "Sari Uji" };

function task(extra: Partial<Task> = {}): Task {
  return {
    id: T,
    code: "PA-12",
    title: "Review kontrak proyek A",
    columnId: "todo",
    assignee: sari,
    due: "2026-11-28",
    priority: "medium",
    labels: ["kontrak", "legal"],
    commentCount: 1,
    merged: false,
    projectId: P,
    description: "Cek pasal pembayaran.\nLalu lampiran.",
    createdBy: penguji,
    createdAt: "2026-11-20T02:00:00Z",
    updatedAt: "2026-11-21T02:00:00Z",
    comments: [{ id: "c1", author: sari, at: "2026-11-21T03:00:00Z", body: "Sudah saya baca.\nBesok saya kirim." }],
    activity: [
      { at: "2026-11-20T02:00:00Z", actor: penguji, kind: "created", detail: "" },
      { at: "2026-11-21T02:00:00Z", actor: sari, kind: "moved", detail: "doing" },
    ],
    canEdit: true,
    canDelete: true,
    ...extra,
  };
}

function view(): BoardView {
  return {
    project: { id: P, code: "PA", name: "Proyek Uji", teamId: null, openCount: 1, taskCount: 1, canManage: true },
    columns: [
      { id: "todo", name: "To do", tasks: [] },
      { id: "doing", name: "Dikerjakan", tasks: [] },
      { id: "done", name: "Selesai", tasks: [] },
    ],
    assignees: [penguji, sari],
    me: ME,
    canCreate: true,
  };
}

function renderDetail() {
  const onClose = vi.fn();
  const onChanged = vi.fn();
  render(<TaskDetail projectId={P} taskId={T} onClose={onClose} onChanged={onChanged} />);
  return { onClose, onChanged };
}

// Pilih dengan mouse: tekan select, lalu pilih opsi. Langsung disimpan.
function mousePick(select: HTMLElement, value: string) {
  fireEvent.pointerDown(select);
  fireEvent.mouseDown(select);
  fireEvent.change(select, { target: { value } });
}

async function openDialog() {
  const dialog = await screen.findByRole("dialog", { name: /PA-12/ });
  await within(dialog).findByLabelText("Judul task");
  return dialog;
}

beforeEach(() => {
  board.getTask.mockResolvedValue(task());
  board.getBoard.mockResolvedValue(view());
  board.updateTask.mockImplementation(async (_p: string, _t: string, patch: Partial<Task>) => task(patch));
  board.moveTask.mockResolvedValue(view());
  board.addComment.mockResolvedValue(task());
  board.deleteTask.mockResolvedValue(null);
});

describe("Detail task: memuat", () => {
  it("menampilkan judul, rincian, komentar, dan aktivitas", async () => {
    renderDetail();
    expect(screen.getByText("Memuat task...")).toBeInTheDocument();
    const dialog = await openDialog();
    expect(dialog).toHaveAccessibleName(/Proyek Uji/);
    expect(screen.getByLabelText("Judul task")).toHaveValue("Review kontrak proyek A");
    expect(screen.getByLabelText("Deskripsi")).toHaveValue("Cek pasal pembayaran.\nLalu lampiran.");
    expect(screen.getByLabelText("Status")).toHaveValue("todo");
    expect(screen.getByLabelText("Penanggung jawab")).toHaveValue(PK_B);
    expect(screen.getByRole("option", { name: "Penguji (Anda)" })).toBeInTheDocument();
    expect(screen.getByLabelText("Tenggat")).toHaveValue("2026-11-28");
    expect(screen.getByLabelText("Prioritas")).toHaveValue("medium");
    expect(screen.getByRole("button", { name: "Hapus label kontrak" })).toBeInTheDocument();
    expect(screen.getByText(/Sudah saya baca/)).toBeInTheDocument();
    expect(screen.getByText(/Sari Uji memindahkan task ke Dikerjakan/)).toBeInTheDocument();
    expect(screen.getByText(/Anda membuat task ini/)).toBeInTheDocument();
    expect(board.getTask).toHaveBeenCalledWith(P, T);
  });

  it("error membaca task bisa dicoba lagi", async () => {
    const user = userEvent.setup();
    board.getTask.mockRejectedValueOnce({ code: "database", message: "Database terkunci." });
    renderDetail();
    expect(await screen.findByText("Task belum terbaca")).toBeInTheDocument();
    expect(screen.getByText("Database terkunci.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Coba lagi" }));
    expect(await screen.findByLabelText("Judul task")).toBeInTheDocument();
  });

  it("menandai task yang sudah digabung", async () => {
    board.getTask.mockResolvedValue(task({ merged: true }));
    renderDetail();
    expect(await screen.findByText("Sudah digabung.")).toBeInTheDocument();
  });
});

describe("Detail task: mengubah satu field", () => {
  it("penanggung jawab mengirim hanya field itu", async () => {
    const { onChanged } = renderDetail();
    await openDialog();
    mousePick(screen.getByLabelText("Penanggung jawab"), ME);
    await waitFor(() => expect(board.updateTask).toHaveBeenCalledWith(P, T, { assignee: ME }));
    expect(await screen.findByText("Penanggung jawab tersimpan.")).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("Belum ada mengosongkan penanggung jawab", async () => {
    renderDetail();
    await openDialog();
    mousePick(screen.getByLabelText("Penanggung jawab"), "");
    await waitFor(() => expect(board.updateTask).toHaveBeenCalledWith(P, T, { assignee: null }));
  });

  it("tenggat disimpan saat kolom ditinggalkan, dan bisa dihapus", async () => {
    const user = userEvent.setup();
    renderDetail();
    await openDialog();
    const due = screen.getByLabelText("Tenggat");
    fireEvent.change(due, { target: { value: "2026-12-01" } });
    expect(board.updateTask).not.toHaveBeenCalled();
    fireEvent.blur(due);
    await waitFor(() => expect(board.updateTask).toHaveBeenCalledWith(P, T, { due: "2026-12-01" }));
    await user.click(await screen.findByRole("button", { name: "Hapus tenggat" }));
    await waitFor(() => expect(board.updateTask).toHaveBeenLastCalledWith(P, T, { due: null }));
  });

  it("prioritas mengirim hanya field itu", async () => {
    renderDetail();
    await openDialog();
    mousePick(screen.getByLabelText("Prioritas"), "high");
    await waitFor(() => expect(board.updateTask).toHaveBeenCalledWith(P, T, { priority: "high" }));
    expect(board.updateTask).toHaveBeenCalledTimes(1);
  });

  it("status memindahkan task ke paling atas kolom tujuan", async () => {
    renderDetail();
    await openDialog();
    mousePick(screen.getByLabelText("Status"), "doing");
    await waitFor(() => expect(board.moveTask).toHaveBeenCalledWith(P, T, "doing", 0));
    expect(board.updateTask).not.toHaveBeenCalled();
  });

  it("judul disimpan dengan Enter, Escape mengembalikan tanpa menutup dialog", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDetail();
    await openDialog();
    const title = screen.getByLabelText("Judul task");
    await user.clear(title);
    await user.type(title, "Judul baru{Enter}");
    await waitFor(() => expect(board.updateTask).toHaveBeenCalledWith(P, T, { title: "Judul baru" }));

    board.updateTask.mockClear();
    await user.type(title, " lagi");
    await user.keyboard("{Escape}");
    expect(title).toHaveValue("Judul baru");
    expect(onClose).not.toHaveBeenCalled();
    expect(board.updateTask).not.toHaveBeenCalled();
  });

  it("label ditambah dengan Enter dan dihapus dengan tombolnya", async () => {
    const user = userEvent.setup();
    renderDetail();
    await openDialog();
    await user.type(screen.getByLabelText("Label baru"), "urgent{Enter}");
    await waitFor(() =>
      expect(board.updateTask).toHaveBeenCalledWith(P, T, { labels: ["kontrak", "legal", "urgent"] }),
    );
    board.updateTask.mockClear();
    await user.click(screen.getByRole("button", { name: "Hapus label legal" }));
    await waitFor(() => expect(board.updateTask).toHaveBeenCalledWith(P, T, { labels: ["kontrak", "urgent"] }));
  });

  it("label ganda ditolak tanpa memanggil inti", async () => {
    const user = userEvent.setup();
    renderDetail();
    await openDialog();
    await user.type(screen.getByLabelText("Label baru"), "Kontrak{Enter}");
    expect(await screen.findByText('Label "Kontrak" sudah ada.')).toBeInTheDocument();
    expect(board.updateTask).not.toHaveBeenCalled();
  });

  it("gagal menyimpan menampilkan error di field itu", async () => {
    board.updateTask.mockRejectedValueOnce({ code: "database", message: "Disk penuh." });
    const { onChanged } = renderDetail();
    await openDialog();
    mousePick(screen.getByLabelText("Prioritas"), "low");
    expect(await screen.findByText("Prioritas belum tersimpan")).toBeInTheDocument();
    expect(screen.getByText("Disk penuh.")).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe("Detail task: komentar", () => {
  it("Kirim mati selama kosong, lalu mengirim dan mengosongkan kolom", async () => {
    const user = userEvent.setup();
    const { onChanged } = renderDetail();
    await openDialog();
    const send = screen.getByRole("button", { name: "Kirim" });
    expect(send).toBeDisabled();
    const box = screen.getByLabelText("Tulis komentar");
    await user.type(box, "Halo tim");
    expect(send).toBeEnabled();
    await user.click(send);
    await waitFor(() => expect(board.addComment).toHaveBeenCalledWith(P, T, "Halo tim"));
    await waitFor(() => expect(box).toHaveValue(""));
    expect(onChanged).toHaveBeenCalled();
  });

  it("Ctrl+Enter mengirim komentar", async () => {
    const user = userEvent.setup();
    renderDetail();
    await openDialog();
    await user.type(screen.getByLabelText("Tulis komentar"), "Baris satu");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(board.addComment).toHaveBeenCalledWith(P, T, "Baris satu"));
  });

  it("gagal mengirim menyimpan teks komentar", async () => {
    const user = userEvent.setup();
    board.addComment.mockRejectedValueOnce({ code: "invalid_input", message: "Komentar terlalu panjang." });
    renderDetail();
    await openDialog();
    const box = screen.getByLabelText("Tulis komentar");
    await user.type(box, "Halo");
    await user.click(screen.getByRole("button", { name: "Kirim" }));
    expect(await screen.findByText("Komentar belum terkirim")).toBeInTheDocument();
    expect(box).toHaveValue("Halo");
  });
});

describe("Detail task: hapus", () => {
  it("hapus lewat konfirmasi, lalu memberi tahu board dan menutup", async () => {
    const user = userEvent.setup();
    const { onClose, onChanged } = renderDetail();
    await openDialog();
    await user.click(screen.getByRole("button", { name: "Hapus task" }));
    const confirm = await screen.findByRole("dialog", { name: "Hapus task PA-12?" });
    expect(board.deleteTask).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole("button", { name: "Hapus PA-12" }));
    await waitFor(() => expect(board.deleteTask).toHaveBeenCalledWith(P, T));
    expect(onChanged).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("Batal di konfirmasi tidak menghapus", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDetail();
    await openDialog();
    await user.click(screen.getByRole("button", { name: "Hapus task" }));
    const confirm = await screen.findByRole("dialog", { name: "Hapus task PA-12?" });
    await user.click(within(confirm).getByRole("button", { name: "Batal" }));
    expect(board.deleteTask).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("tombol hapus tidak ada kalau tidak berhak", async () => {
    board.getTask.mockResolvedValue(task({ canDelete: false }));
    renderDetail();
    await openDialog();
    expect(screen.queryByRole("button", { name: "Hapus task" })).not.toBeInTheDocument();
  });
});

describe("Detail task: hanya-baca", () => {
  it("menampilkan nilai sebagai teks dan menjelaskan alasannya", async () => {
    board.getTask.mockResolvedValue(task({ canEdit: false, canDelete: false }));
    renderDetail();
    expect(await screen.findByText(/Anda hanya bisa melihat task ini/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Judul task")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Kirim" })).not.toBeInTheDocument();
    expect(screen.getByText("Review kontrak proyek A")).toBeInTheDocument();
    const side = screen.getByRole("complementary", { name: "Rincian task" });
    expect(within(side).getByText("Sari Uji")).toBeInTheDocument();
    expect(within(side).getByText("Sedang")).toBeInTheDocument();
  });
});

describe("Detail task: menutup", () => {
  it("tombol Tutup memanggil onClose", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDetail();
    await openDialog();
    await user.click(screen.getByRole("button", { name: "Tutup detail task" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("deskripsi yang belum disimpan ikut disimpan saat menutup", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDetail();
    await openDialog();
    await user.type(screen.getByLabelText("Deskripsi"), " Tambahan.");
    await user.click(screen.getByRole("button", { name: "Tutup detail task" }));
    await waitFor(() =>
      expect(board.updateTask).toHaveBeenCalledWith(P, T, {
        description: "Cek pasal pembayaran.\nLalu lampiran. Tambahan.",
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe("Kalimat aktivitas", () => {
  it("membentuk kalimat dari jenis dan detail", () => {
    const at = "2026-11-21T02:00:00Z";
    expect(activitySentence({ at, actor: sari, kind: "priority", detail: "high" }, ME)).toBe(
      "Sari Uji mengubah prioritas menjadi Tinggi",
    );
    expect(activitySentence({ at, actor: sari, kind: "assignee", detail: ME }, ME, [penguji])).toBe(
      "Sari Uji menugaskan task ke Anda",
    );
    expect(activitySentence({ at, actor: penguji, kind: "due", detail: "" }, ME)).toBe("Anda menghapus tenggat");
    expect(
      activitySentence({ at, actor: sari, kind: "due", detail: "2026-11-28" }, ME, [], new Date(2026, 10, 22)),
    ).toBe("Sari Uji mengubah tenggat menjadi 28 Nov");
  });
});

describe("Detail task: select lewat keyboard", () => {
  it("panah tidak menyimpan, Enter menyimpan sekali dengan pilihan terakhir", async () => {
    renderDetail();
    await openDialog();
    const prio = screen.getByLabelText("Prioritas");
    prio.focus();
    fireEvent.keyDown(prio, { key: "ArrowDown" });
    fireEvent.change(prio, { target: { value: "high" } });
    fireEvent.keyDown(prio, { key: "ArrowUp" });
    fireEvent.change(prio, { target: { value: "low" } });
    expect(board.updateTask).not.toHaveBeenCalled();
    fireEvent.keyDown(prio, { key: "Enter" });
    await waitFor(() => expect(board.updateTask).toHaveBeenCalledWith(P, T, { priority: "low" }));
    fireEvent.blur(prio);
    await screen.findByText("Prioritas tersimpan.");
    expect(board.updateTask).toHaveBeenCalledTimes(1);
  });

  it("panah lalu pindah kolom menyimpan sekali", async () => {
    renderDetail();
    await openDialog();
    const status = screen.getByLabelText("Status");
    fireEvent.keyDown(status, { key: "ArrowDown" });
    fireEvent.change(status, { target: { value: "doing" } });
    fireEvent.keyDown(status, { key: "ArrowDown" });
    fireEvent.change(status, { target: { value: "done" } });
    expect(board.moveTask).not.toHaveBeenCalled();
    fireEvent.blur(status);
    await waitFor(() => expect(board.moveTask).toHaveBeenCalledWith(P, T, "done", 0));
    expect(board.moveTask).toHaveBeenCalledTimes(1);
  });

  it("error simpan diumumkan lewat wilayah aria-live", async () => {
    board.updateTask.mockRejectedValueOnce({ code: "database", message: "Disk penuh." });
    renderDetail();
    await openDialog();
    mousePick(screen.getByLabelText("Prioritas"), "low");
    const title = await screen.findByText("Prioritas belum tersimpan");
    expect(title.closest("[aria-live]")).not.toBeNull();
  });
});

describe("Detail task: fokus setelah tutup", () => {
  function Harness({ onDeleted }: { onDeleted?: (id: string, code: string) => void }) {
    const [open, setOpen] = useState(false);
    const [column, setColumn] = useState<"todo" | "doing">("todo");
    return (
      <>
        {column === "todo" && (
          <button type="button" data-open-task={T} onClick={() => setOpen(true)}>
            Kartu di To do
          </button>
        )}
        {column === "doing" && (
          <button type="button" data-open-task={T}>
            Kartu di Dikerjakan
          </button>
        )}
        {open && (
          <TaskDetail
            projectId={P}
            taskId={T}
            onClose={() => setOpen(false)}
            onChanged={() => setColumn("doing")}
            onDeleted={onDeleted}
          />
        )}
      </>
    );
  }

  it("kembali ke kartu yang sama walau kartunya sudah dirender di kolom lain", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Kartu di To do" }));
    await openDialog();
    mousePick(screen.getByLabelText("Status"), "doing");
    await screen.findByText("Status tersimpan: Dikerjakan.");
    await user.click(screen.getByRole("button", { name: "Tutup detail task" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Kartu di Dikerjakan" })).toHaveFocus());
  });

  it("setelah hapus memanggil onDeleted dengan id dan kode", async () => {
    const user = userEvent.setup();
    const onDeleted = vi.fn();
    render(<Harness onDeleted={onDeleted} />);
    await user.click(screen.getByRole("button", { name: "Kartu di To do" }));
    await openDialog();
    await user.click(screen.getByRole("button", { name: "Hapus task" }));
    const confirm = await screen.findByRole("dialog", { name: "Hapus task PA-12?" });
    await user.click(within(confirm).getByRole("button", { name: "Hapus PA-12" }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(T, "PA-12"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
