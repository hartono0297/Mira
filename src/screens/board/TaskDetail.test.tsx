import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardView, TaskDetail as Task } from "../../api/board";
import { todayIso } from "./format";
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

// Subtask, bagian Waktu, dan timer di kepala punya tes sendiri. Di sini hanya
// kontraknya yang diuji: props yang diterima, onChange, dan onError.
type ChildProps = {
  task: Task;
  me: string;
  canEdit: boolean;
  onChange: (next: Task) => void;
  onError: (message: string) => void;
};
// extras: stub Subtask juga memasang isian dengan data-escape-local (menangani
// Escape sendiri) dan isian dengan data-unsaved="true" (ketikan belum terkirim).
const child = vi.hoisted(() => ({ next: null as Task | null, error: "Disk penuh.", extras: false }));

function stub(name: string) {
  return function Stub({ task, me, canEdit, onChange, onError }: ChildProps) {
    return (
      <div role="region" aria-label={`${name} tiruan`} data-can-edit={String(canEdit)} data-me={me}>
        <p>
          {name}: {task.title}
        </p>
        <button type="button" onClick={() => child.next && onChange(child.next)}>
          {name} berubah
        </button>
        <button type="button" onClick={() => onError(child.error)}>
          {name} gagal
        </button>
        {child.extras && name === "Subtask" && (
          <>
            <div data-escape-local>
              <input aria-label="Judul subtask diubah" />
            </div>
            <input aria-label="Subtask baru" data-unsaved="true" defaultValue="Cek lampiran" />
          </>
        )}
      </div>
    );
  };
}

vi.mock("./Subtasks", () => ({ Subtasks: stub("Subtask") }));
vi.mock("./TimeSection", () => ({ TimeSection: stub("Waktu") }));
vi.mock("./TimerMini", () => ({ TimerMini: stub("Timer") }));

async function boardEvent() {
  await act(async () => {
    listeners.forEach((h) => h());
  });
}

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
    subtaskDone: 0,
    subtaskTotal: 0,
    trackedSecs: 0,
    timersRunningSince: [],
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
    ...extra,
  };
}

function view(): BoardView {
  return {
    project: {
      id: P,
      code: "PA",
      name: "Proyek Uji",
      teamId: null,
      teamName: null,
      openCount: 1,
      taskCount: 1,
      canManage: true,
    },
    columns: [
      { id: "todo", name: "To do", tasks: [{ ...task(), labels: ["kontrak", "legal"] }] },
      { id: "doing", name: "Dikerjakan", tasks: [{ ...task({ id: "x", code: "PA-13" }), labels: ["lapangan"] }] },
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

// Tombol nilai properti. Nama aksesibelnya = label lalu nilai, misalnya "Status To do".
function prop(label: string) {
  return screen.getByRole("button", { name: new RegExp(`^${label} `) });
}

function queryProp(label: string) {
  return screen.queryByRole("button", { name: new RegExp(`^${label} `) });
}

async function pickFrom(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(prop(label));
  const menu = await screen.findByRole("menu", { name: label });
  await user.click(within(menu).getByRole("menuitemradio", { name: option }));
}

async function openDialog() {
  const dialog = await screen.findByRole("dialog", { name: /PA-12/ });
  await within(dialog).findByLabelText("Judul task");
  return dialog;
}

beforeEach(() => {
  listeners.clear();
  child.next = null;
  child.extras = false;
  board.getTask.mockResolvedValue(task());
  board.getBoard.mockResolvedValue(view());
  board.updateTask.mockImplementation(async (_p: string, _t: string, patch: Partial<Task>) => task(patch));
  board.moveTask.mockResolvedValue(view());
  board.addComment.mockResolvedValue(task());
  board.deleteTask.mockResolvedValue(null);
});

describe("Detail task: memuat", () => {
  it("menampilkan judul, properti, komentar, dan aktivitas", async () => {
    const user = userEvent.setup();
    renderDetail();
    expect(screen.getByText("Memuat task...")).toBeInTheDocument();
    const dialog = await openDialog();
    expect(dialog).toHaveAccessibleName(/Proyek Uji/);
    expect(screen.getByLabelText("Judul task")).toHaveValue("Review kontrak proyek A");
    expect(screen.getByLabelText("Deskripsi")).toHaveValue("Cek pasal pembayaran.\nLalu lampiran.");
    expect(prop("Status")).toHaveAccessibleName("Status To do");
    expect(prop("Penanggung jawab")).toHaveAccessibleName("Penanggung jawab Sari Uji");
    // Tenggat memakai nama hari Indonesia, bukan kolom tanggal format Amerika.
    expect(prop("Tenggat")).toHaveAccessibleName(/^Tenggat Sabtu, 28 Nov/);
    expect(prop("Prioritas")).toHaveAccessibleName("Prioritas Sedang");
    expect(prop("Label")).toHaveAccessibleName("Label kontrak, legal");
    expect(screen.getByText(/Sudah saya baca/)).toBeInTheDocument();
    // Aktivitas ada di tab kedua.
    await user.click(screen.getByRole("tab", { name: "Aktivitas 2" }));
    expect(screen.getByText(/Sari Uji memindahkan task ke Dikerjakan/)).toBeInTheDocument();
    expect(screen.getByText(/Anda membuat task ini/)).toBeInTheDocument();
    expect(board.getTask).toHaveBeenCalledWith(P, T);
  });

  it("menu penanggung jawab menandai Anda", async () => {
    const user = userEvent.setup();
    renderDetail();
    await openDialog();
    await user.click(prop("Penanggung jawab"));
    const menu = screen.getByRole("menu", { name: "Penanggung jawab" });
    expect(within(menu).getByRole("menuitemradio", { name: "Penguji (Anda)" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitemradio", { name: "Sari Uji" })).toHaveAttribute("aria-checked", "true");
    expect(within(menu).getByRole("menuitemradio", { name: "Sari Uji" })).toHaveFocus();
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

describe("Detail task: mengubah satu properti", () => {
  it("penanggung jawab mengirim hanya field itu, lalu fokus kembali ke barisnya", async () => {
    const user = userEvent.setup();
    const { onChanged } = renderDetail();
    await openDialog();
    await pickFrom(user, "Penanggung jawab", "Penguji (Anda)");
    await waitFor(() => expect(board.updateTask).toHaveBeenCalledWith(P, T, { assignee: ME }));
    expect(await screen.findByText("Penanggung jawab tersimpan.")).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(prop("Penanggung jawab")).toHaveFocus();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("Tanpa penanggung jawab mengosongkan", async () => {
    const user = userEvent.setup();
    renderDetail();
    await openDialog();
    await pickFrom(user, "Penanggung jawab", "Tanpa penanggung jawab");
    await waitFor(() => expect(board.updateTask).toHaveBeenCalledWith(P, T, { assignee: null }));
  });

  it("memilih nilai yang sama tidak menyimpan", async () => {
    const user = userEvent.setup();
    renderDetail();
    await openDialog();
    await pickFrom(user, "Prioritas", "Sedang");
    expect(board.updateTask).not.toHaveBeenCalled();
  });

  it("prioritas mengirim hanya field itu", async () => {
    const user = userEvent.setup();
    renderDetail();
    await openDialog();
    await pickFrom(user, "Prioritas", "Tinggi");
    await waitFor(() => expect(board.updateTask).toHaveBeenCalledWith(P, T, { priority: "high" }));
    expect(board.updateTask).toHaveBeenCalledTimes(1);
  });

  it("status memindahkan task ke paling atas kolom tujuan", async () => {
    const user = userEvent.setup();
    renderDetail();
    await openDialog();
    await pickFrom(user, "Status", "Dikerjakan");
    await waitFor(() => expect(board.moveTask).toHaveBeenCalledWith(P, T, "doing", 0));
    expect(board.updateTask).not.toHaveBeenCalled();
  });

  it("gagal menyimpan menampilkan error di bawah properti", async () => {
    const user = userEvent.setup();
    board.updateTask.mockRejectedValueOnce({ code: "database", message: "Disk penuh." });
    const { onChanged } = renderDetail();
    await openDialog();
    await pickFrom(user, "Prioritas", "Rendah");
    expect(await screen.findByText("Prioritas belum tersimpan")).toBeInTheDocument();
    expect(screen.getByText("Disk penuh.")).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
    // Baris kembali ke nilai tersimpan.
    expect(prop("Prioritas")).toHaveAccessibleName("Prioritas Sedang");
  });

  it("error simpan diumumkan lewat wilayah aria-live", async () => {
    const user = userEvent.setup();
    board.updateTask.mockRejectedValueOnce({ code: "database", message: "Disk penuh." });
    renderDetail();
    await openDialog();
    await pickFrom(user, "Prioritas", "Rendah");
    const title = await screen.findByText("Prioritas belum tersimpan");
    expect(title.closest("[aria-live]")).not.toBeNull();
  });
});

describe("Detail task: tenggat", () => {
  it("isian hari/bulan/tahun disimpan dengan Enter, dan Tanpa tenggat menghapus", async () => {
    const user = userEvent.setup();
    renderDetail();
    await openDialog();
    await user.click(prop("Tenggat"));
    const picker = screen.getByRole("dialog", { name: "Tenggat" });
    await user.type(within(picker).getByLabelText("Tanggal lain"), "1/12/2026");
    expect(board.updateTask).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(board.updateTask).toHaveBeenCalledWith(P, T, { due: "2026-12-01" }));
    expect(screen.queryByRole("dialog", { name: "Tenggat" })).not.toBeInTheDocument();
    expect(prop("Tenggat")).toHaveFocus();
    expect(prop("Tenggat")).toHaveAccessibleName(/^Tenggat Selasa, 1 Des/);

    await user.click(prop("Tenggat"));
    await user.click(screen.getByRole("button", { name: "Tanpa tenggat" }));
    await waitFor(() => expect(board.updateTask).toHaveBeenLastCalledWith(P, T, { due: null }));
  });

  it("pilihan cepat Besok memakai tanggal besok", async () => {
    const user = userEvent.setup();
    renderDetail();
    await openDialog();
    await user.click(prop("Tenggat"));
    await user.click(screen.getByRole("button", { name: /^Besok/ }));
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    await waitFor(() => expect(board.updateTask).toHaveBeenCalledWith(P, T, { due: todayIso(tomorrow) }));
  });

  it("tanggal yang salah ditolak tanpa memanggil inti", async () => {
    const user = userEvent.setup();
    renderDetail();
    await openDialog();
    await user.click(prop("Tenggat"));
    await user.type(screen.getByLabelText("Tanggal lain"), "31/02/2027{Enter}");
    expect(await screen.findByText(/tidak ada di kalender/)).toBeInTheDocument();
    expect(screen.getByLabelText("Tanggal lain")).toHaveAttribute("aria-invalid", "true");
    expect(board.updateTask).not.toHaveBeenCalled();
  });
});

describe("Detail task: judul", () => {
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
    expect(title).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
    expect(board.updateTask).not.toHaveBeenCalled();
  });

  it("judul kosong tidak disimpan", async () => {
    const user = userEvent.setup();
    renderDetail();
    await openDialog();
    const title = screen.getByLabelText("Judul task");
    await user.clear(title);
    await user.keyboard("{Enter}");
    expect(await screen.findByText(/Judul tidak boleh kosong/)).toBeInTheDocument();
    expect(board.updateTask).not.toHaveBeenCalled();
  });
});

describe("Detail task: label", () => {
  it("label baru ditambah dengan Enter, label dilepas dengan kotak centangnya", async () => {
    const user = userEvent.setup();
    renderDetail();
    await openDialog();
    await user.click(prop("Label"));
    const picker = screen.getByRole("dialog", { name: "Label" });
    await user.type(within(picker).getByLabelText("Label baru"), "urgent{Enter}");
    await waitFor(() =>
      expect(board.updateTask).toHaveBeenCalledWith(P, T, { labels: ["kontrak", "legal", "urgent"] }),
    );
    board.updateTask.mockClear();
    await user.click(within(picker).getByRole("checkbox", { name: "legal" }));
    await waitFor(() => expect(board.updateTask).toHaveBeenCalledWith(P, T, { labels: ["kontrak", "urgent"] }));
  });

  it("label lain di proyek bisa dicentang", async () => {
    const user = userEvent.setup();
    renderDetail();
    await openDialog();
    await user.click(prop("Label"));
    const box = screen.getByRole("checkbox", { name: "lapangan" });
    expect(box).not.toBeChecked();
    await user.click(box);
    await waitFor(() =>
      expect(board.updateTask).toHaveBeenCalledWith(P, T, { labels: ["kontrak", "legal", "lapangan"] }),
    );
  });

  it("label ganda ditolak tanpa memanggil inti", async () => {
    const user = userEvent.setup();
    renderDetail();
    await openDialog();
    await user.click(prop("Label"));
    await user.type(screen.getByLabelText("Label baru"), "Kontrak{Enter}");
    expect(await screen.findByText('Label "Kontrak" sudah ada.')).toBeInTheDocument();
    expect(board.updateTask).not.toHaveBeenCalled();
  });
});

describe("Detail task: keyboard dan Escape", () => {
  it("panah bawah membuka menu, panah tidak menyimpan, Enter menyimpan sekali", async () => {
    const user = userEvent.setup();
    renderDetail();
    await openDialog();
    prop("Prioritas").focus();
    await user.keyboard("{ArrowDown}");
    const menu = screen.getByRole("menu", { name: "Prioritas" });
    expect(within(menu).getByRole("menuitemradio", { name: "Sedang" })).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowUp}{ArrowUp}");
    expect(within(menu).getByRole("menuitemradio", { name: "Rendah" })).toHaveFocus();
    expect(board.updateTask).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(board.updateTask).toHaveBeenCalledWith(P, T, { priority: "low" }));
    await screen.findByText("Prioritas tersimpan.");
    expect(board.updateTask).toHaveBeenCalledTimes(1);
  });

  it("Escape menutup menu dulu tanpa menyimpan, Escape berikutnya menutup dialog", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDetail();
    await openDialog();
    prop("Status").focus();
    await user.keyboard("{ArrowDown}{ArrowDown}{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(prop("Status")).toHaveFocus();
    expect(board.moveTask).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("Escape di isian: kosongkan isian, lalu tutup pilihan, lalu tutup dialog", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDetail();
    await openDialog();
    await user.click(prop("Label"));
    const input = screen.getByLabelText("Label baru");
    await user.type(input, "draf");
    await user.keyboard("{Escape}");
    expect(input).toHaveValue("");
    expect(screen.getByRole("dialog", { name: "Label" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Label" })).not.toBeInTheDocument();
    expect(prop("Label")).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("Tab di menu menutupnya tanpa menyimpan", async () => {
    const user = userEvent.setup();
    renderDetail();
    await openDialog();
    await user.click(prop("Status"));
    await user.keyboard("{ArrowDown}{Tab}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(board.moveTask).not.toHaveBeenCalled();
  });

  it("klik di luar menutup pilihan", async () => {
    const user = userEvent.setup();
    renderDetail();
    await openDialog();
    await user.click(prop("Prioritas"));
    expect(screen.getByRole("menu", { name: "Prioritas" })).toBeInTheDocument();
    await user.click(screen.getByLabelText("Deskripsi"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(prop("Prioritas")).toHaveAttribute("aria-expanded", "false");
  });
});

describe("Detail task: tab Komentar dan Aktivitas", () => {
  it("panah kiri dan kanan pindah tab, hanya tab aktif yang masuk urutan Tab", async () => {
    const user = userEvent.setup();
    renderDetail();
    await openDialog();
    const komentar = screen.getByRole("tab", { name: "Komentar 1" });
    const aktivitas = screen.getByRole("tab", { name: "Aktivitas 2" });
    expect(komentar).toHaveAttribute("aria-selected", "true");
    expect(komentar).toHaveAttribute("tabindex", "0");
    expect(aktivitas).toHaveAttribute("tabindex", "-1");
    komentar.focus();
    await user.keyboard("{ArrowRight}");
    expect(aktivitas).toHaveFocus();
    expect(aktivitas).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent(/Anda membuat task ini/);
    await user.keyboard("{ArrowLeft}");
    expect(komentar).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveTextContent(/Sudah saya baca/);
  });

  it("draf komentar tetap ada setelah pindah tab", async () => {
    const user = userEvent.setup();
    renderDetail();
    await openDialog();
    await user.type(screen.getByLabelText("Tulis komentar"), "Draf saya");
    await user.click(screen.getByRole("tab", { name: /^Aktivitas/ }));
    await user.click(screen.getByRole("tab", { name: /^Komentar/ }));
    expect(screen.getByLabelText("Tulis komentar")).toHaveValue("Draf saya");
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

describe("Detail task: hapus lewat menu Lainnya", () => {
  async function openDelete(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "Lainnya" }));
    await user.click(screen.getByRole("menuitem", { name: "Hapus task" }));
    return screen.findByRole("dialog", { name: "Hapus task PA-12?" });
  }

  it("hapus lewat konfirmasi, lalu memberi tahu board dan menutup", async () => {
    const user = userEvent.setup();
    const { onClose, onChanged } = renderDetail();
    await openDialog();
    const confirm = await openDelete(user);
    expect(board.deleteTask).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole("button", { name: "Hapus PA-12" }));
    await waitFor(() => expect(board.deleteTask).toHaveBeenCalledWith(P, T));
    expect(onChanged).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("konfirmasi menyebut berapa subtask, komentar, dan catatan waktu yang ikut hilang", async () => {
    const user = userEvent.setup();
    const sub = { id: "s", title: "x", done: false, assignee: null, doneBy: null, doneAt: null, createdBy: sari };
    const entry = { id: "e", person: sari, start: "", end: "", manual: true, note: "", secs: 60, mine: false };
    board.getTask.mockResolvedValue(
      task({
        subtasks: [sub, { ...sub, id: "s2" }],
        timeEntries: [entry, { ...entry, id: "e2" }, { ...entry, id: "e3" }],
      }),
    );
    renderDetail();
    await openDialog();
    const confirm = await openDelete(user);
    expect(confirm).toHaveTextContent(
      '"Review kontrak proyek A" beserta 2 subtask, 1 komentar, dan 3 catatan waktu terhapus dari board semua anggota proyek',
    );
  });

  it("Batal tidak menghapus dan fokus kembali ke Lainnya", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDetail();
    await openDialog();
    const confirm = await openDelete(user);
    expect(within(confirm).getByRole("button", { name: "Batal" })).toHaveFocus();
    await user.click(within(confirm).getByRole("button", { name: "Batal" }));
    expect(board.deleteTask).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Lainnya" })).toHaveFocus());
  });

  it("tombol Lainnya tidak ada kalau tidak berhak menghapus", async () => {
    board.getTask.mockResolvedValue(task({ canDelete: false }));
    renderDetail();
    await openDialog();
    expect(screen.queryByRole("button", { name: "Lainnya" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Hapus task" })).not.toBeInTheDocument();
  });
});

describe("Detail task: subtask, waktu, dan timer", () => {
  it("komponen menerima task, me, dan izin ubah", async () => {
    renderDetail();
    await openDialog();
    for (const name of ["Subtask tiruan", "Waktu tiruan", "Timer tiruan"]) {
      const region = await screen.findByRole("region", { name });
      await waitFor(() => expect(region).toHaveAttribute("data-me", ME));
      expect(region).toHaveAttribute("data-can-edit", "true");
    }
  });

  it("onChange memperbarui data tanpa menimpa draf, dan memberi tahu board", async () => {
    const user = userEvent.setup();
    const { onChanged } = renderDetail();
    await openDialog();
    await user.type(screen.getByLabelText("Deskripsi"), " Draf.");
    child.next = task({ priority: "high", description: "Dari inti", title: "Judul dari inti" });
    await user.click(screen.getByRole("button", { name: "Subtask berubah" }));
    expect(prop("Prioritas")).toHaveAccessibleName("Prioritas Tinggi");
    expect(screen.getByText("Subtask: Judul dari inti")).toBeInTheDocument();
    expect(screen.getByLabelText("Deskripsi")).toHaveValue("Cek pasal pembayaran.\nLalu lampiran. Draf.");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("onError tampil sebagai pesan di bagiannya, dan hilang setelah berhasil", async () => {
    const user = userEvent.setup();
    renderDetail();
    await openDialog();
    await user.click(screen.getByRole("button", { name: "Subtask gagal" }));
    const alert = await screen.findByText("Subtask belum tersimpan");
    expect(alert.closest("[aria-live]")).not.toBeNull();
    expect(screen.getByText("Disk penuh.")).toBeInTheDocument();
    child.next = task();
    await user.click(screen.getByRole("button", { name: "Subtask berubah" }));
    expect(screen.queryByText("Subtask belum tersimpan")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Timer gagal" }));
    expect(await screen.findByText("Timer belum diubah")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Waktu gagal" }));
    expect(await screen.findByText("Waktu belum tersimpan")).toBeInTheDocument();
  });

  it("hanya-baca: komponen menerima canEdit false", async () => {
    board.getTask.mockResolvedValue(task({ canEdit: false, canDelete: false, canComment: false }));
    renderDetail();
    const region = await screen.findByRole("region", { name: "Subtask tiruan" });
    expect(region).toHaveAttribute("data-can-edit", "false");
    expect(screen.getByRole("region", { name: "Waktu tiruan" })).toHaveAttribute("data-can-edit", "false");
  });
});

describe("Detail task: hanya-baca", () => {
  it("menampilkan nilai sebagai teks dan menjelaskan alasannya", async () => {
    board.getTask.mockResolvedValue(task({ canEdit: false, canDelete: false, canComment: false }));
    renderDetail();
    expect(await screen.findByText(/Anda hanya bisa melihat task ini/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Judul task")).not.toBeInTheDocument();
    expect(queryProp("Status")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Kirim" })).not.toBeInTheDocument();
    expect(screen.getByText("Review kontrak proyek A")).toBeInTheDocument();
    const props = screen.getByRole("group", { name: "Rincian task" });
    expect(within(props).getByText("Sari Uji")).toBeInTheDocument();
    expect(within(props).getByText("Sedang")).toBeInTheDocument();
    expect(within(props).getByText("To do")).toBeInTheDocument();
  });
});

describe("Detail task: kolom berbingkai", () => {
  function icon(el: HTMLElement) {
    return el.querySelector(".td-box-ic")?.getAttribute("data-icon");
  }

  it("nilai yang bisa diubah berbingkai dengan ikon sesuai jenisnya", async () => {
    renderDetail();
    await openDialog();
    for (const label of ["Status", "Prioritas", "Penanggung jawab"]) {
      expect(prop(label)).toHaveClass("td-pv", "td-box");
      expect(icon(prop(label))).toBe("chevron");
    }
    expect(prop("Tenggat")).toHaveClass("td-box");
    expect(icon(prop("Tenggat"))).toBe("calendar");
    expect(prop("Label")).toHaveClass("td-box");
    expect(icon(prop("Label"))).toBe("plus");
    // Chip label tetap di dalam bingkai.
    expect(within(prop("Label")).getByText("kontrak")).toHaveClass("td-lbl");
    expect(prop("Label").querySelector(".td-box-ic")).toHaveAttribute("aria-hidden", "true");
  });

  it("deskripsi kosong berbingkai dan mengajak menulis", async () => {
    board.getTask.mockResolvedValue(task({ description: "" }));
    renderDetail();
    await openDialog();
    const desc = screen.getByLabelText("Deskripsi");
    expect(desc).toHaveClass("td-desc", "td-box", "td-box-text");
    expect(desc).toHaveAttribute("placeholder", "Tulis deskripsi: tujuan, langkah, atau tautan yang perlu diketahui tim");
  });

  it("Dibuat oleh hanya dibaca: ikon gembok, tanpa bingkai", async () => {
    renderDetail();
    await openDialog();
    const made = screen.getByText(/Dibuat oleh Anda/).closest("p");
    expect(made).toHaveClass("td-ro");
    expect(made).not.toHaveClass("td-box");
    expect(made?.querySelector('svg[data-icon="lock"]')).toHaveAttribute("aria-hidden", "true");
  });

  it("Tamu: tidak ada bingkai atau ikon aksi sama sekali", async () => {
    board.getTask.mockResolvedValue(task({ canEdit: false, canDelete: false, canComment: false }));
    renderDetail();
    const note = await screen.findByText(/Anda hanya bisa melihat task ini/);
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector(".td-box")).toBeNull();
    expect(dialog.querySelector(".td-box-ic")).toBeNull();
    expect(note.closest(".td-readonly-note")?.querySelector('svg[data-icon="lock"]')).not.toBeNull();
    expect(screen.getByText(/Dibuat oleh Anda/).closest("p")).toHaveClass("td-ro");
  });

  it("boleh berkomentar saja: hanya kolom komentar yang berbingkai, nilai tetap teks", async () => {
    board.getTask.mockResolvedValue(task({ canEdit: false, canDelete: false, canComment: true }));
    renderDetail();
    await screen.findByText(/bisa membaca dan mengomentari task ini/);
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector(".td-box")).toBeNull();
    expect(screen.getByLabelText("Tulis komentar")).toHaveClass("td-textarea");
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

  it("deskripsi disimpan dengan tombolnya atau Ctrl+Enter", async () => {
    const user = userEvent.setup();
    renderDetail();
    await openDialog();
    await user.type(screen.getByLabelText("Deskripsi"), " A.");
    await user.click(screen.getByRole("button", { name: "Simpan deskripsi" }));
    await waitFor(() =>
      expect(board.updateTask).toHaveBeenCalledWith(P, T, { description: "Cek pasal pembayaran.\nLalu lampiran. A." }),
    );
  });

  it("komentar yang belum dikirim menahan dialog dengan pemberitahuan", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDetail();
    await openDialog();
    await user.type(screen.getByLabelText("Tulis komentar"), "Belum dikirim");
    await user.click(screen.getByRole("button", { name: "Tutup detail task" }));
    expect(await screen.findByText("Komentar Anda belum dikirim.")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Tutup tanpa menyimpan" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("Lanjut mengedit memindah fokus ke komentar, juga dari tab Aktivitas", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDetail();
    await openDialog();
    await user.type(screen.getByLabelText("Tulis komentar"), "Belum dikirim");
    await user.click(screen.getByRole("tab", { name: /Aktivitas/ }));
    await user.keyboard("{Escape}");
    expect(await screen.findByText("Komentar Anda belum dikirim.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Lanjut mengedit" }));
    expect(screen.queryByText("Komentar Anda belum dikirim.")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Tulis komentar")).toHaveFocus();
    expect(screen.getByLabelText("Tulis komentar")).toHaveValue("Belum dikirim");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ketikan bertanda data-unsaved menahan dialog dengan konfirmasi yang sama", async () => {
    child.extras = true;
    const user = userEvent.setup();
    const { onClose } = renderDetail();
    await openDialog();
    await user.keyboard("{Escape}");
    expect(await screen.findByText("Ada ketikan Anda yang belum disimpan.")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Lanjut mengedit" }));
    expect(screen.getByLabelText("Subtask baru")).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Tutup detail task" }));
    await user.click(await screen.findByRole("button", { name: "Tutup tanpa menyimpan" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("Escape dengan fokus di dalam data-escape-local tidak menutup dialog", async () => {
    child.extras = true;
    const user = userEvent.setup();
    const { onClose } = renderDetail();
    const dialog = await openDialog();
    const local = screen.getByLabelText("Judul subtask diubah");
    await user.click(local);
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog).toBeInTheDocument();
    expect(screen.queryByText("Ada ketikan Anda yang belum disimpan.")).not.toBeInTheDocument();
    expect(local).toHaveFocus();
  });
});

describe("Detail task: deskripsi", () => {
  it("Escape memulihkan deskripsi tanpa menutup, Escape berikutnya menutup", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDetail();
    await openDialog();
    const desc = screen.getByLabelText("Deskripsi");
    await user.type(desc, " Coretan.");
    expect(screen.getByRole("button", { name: "Simpan deskripsi" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(desc).toHaveValue("Cek pasal pembayaran.\nLalu lampiran.");
    expect(desc).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Simpan deskripsi" })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(board.updateTask).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(board.updateTask).not.toHaveBeenCalled();
  });

  it("setelah Simpan deskripsi fokus ada di deskripsi, bukan hilang bersama tombolnya", async () => {
    const user = userEvent.setup();
    renderDetail();
    await openDialog();
    const desc = screen.getByLabelText("Deskripsi");
    await user.type(desc, " A.");
    await user.click(screen.getByRole("button", { name: "Simpan deskripsi" }));
    await screen.findByText("Deskripsi tersimpan.");
    expect(screen.queryByRole("button", { name: "Simpan deskripsi" })).not.toBeInTheDocument();
    expect(desc).toHaveFocus();
    expect(desc).toHaveValue("Cek pasal pembayaran.\nLalu lampiran. A.");
  });

  it("Batalkan perubahan memulihkan dan memindah fokus ke deskripsi", async () => {
    const user = userEvent.setup();
    renderDetail();
    await openDialog();
    const desc = screen.getByLabelText("Deskripsi");
    await user.type(desc, " B.");
    await user.click(screen.getByRole("button", { name: "Batalkan perubahan" }));
    expect(desc).toHaveValue("Cek pasal pembayaran.\nLalu lampiran.");
    expect(desc).toHaveFocus();
  });
});

describe("Detail task: ketikan selama menyimpan", () => {
  function deferred() {
    let resolve!: (t: Task) => void;
    const promise = new Promise<Task>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it("judul: ketikan yang masuk saat simpan berjalan tidak terhapus", async () => {
    const user = userEvent.setup();
    const save = deferred();
    board.updateTask.mockReturnValueOnce(save.promise);
    renderDetail();
    await openDialog();
    const title = screen.getByLabelText("Judul task");
    await user.clear(title);
    await user.type(title, "Judul baru{Enter}");
    await waitFor(() => expect(board.updateTask).toHaveBeenCalledWith(P, T, { title: "Judul baru" }));
    await user.type(title, " lagi");
    await act(async () => save.resolve(task({ title: "Judul baru" })));
    expect(await screen.findByText("Judul tersimpan.")).toBeInTheDocument();
    expect(title).toHaveValue("Judul baru lagi");
  });

  it("deskripsi: ketikan yang masuk saat simpan berjalan tidak terhapus", async () => {
    const user = userEvent.setup();
    const save = deferred();
    board.updateTask.mockReturnValueOnce(save.promise);
    renderDetail();
    await openDialog();
    const desc = screen.getByLabelText("Deskripsi");
    await user.type(desc, " A.{Control>}{Enter}{/Control}");
    await waitFor(() =>
      expect(board.updateTask).toHaveBeenCalledWith(P, T, { description: "Cek pasal pembayaran.\nLalu lampiran. A." }),
    );
    await user.type(desc, " B.");
    await act(async () => save.resolve(task({ description: "Cek pasal pembayaran.\nLalu lampiran. A." })));
    expect(await screen.findByText("Deskripsi tersimpan.")).toBeInTheDocument();
    expect(desc).toHaveValue("Cek pasal pembayaran.\nLalu lampiran. A. B.");
    // Sisa ketikan tetap draf yang bisa disimpan.
    expect(screen.getByRole("button", { name: "Simpan deskripsi" })).toBeInTheDocument();
  });

  it("kepala hanya mengumumkan hasil, bukan Menyimpan", async () => {
    const user = userEvent.setup();
    const save = deferred();
    board.updateTask.mockReturnValueOnce(save.promise);
    renderDetail();
    await openDialog();
    await pickFrom(user, "Prioritas", "Tinggi");
    await waitFor(() => expect(board.updateTask).toHaveBeenCalled());
    const head = screen.getByRole("button", { name: "Tutup detail task" }).parentElement!;
    expect(within(head).queryByText("Menyimpan...")).not.toBeInTheDocument();
    await act(async () => save.resolve(task({ priority: "high" })));
    expect(await within(head).findByText("Prioritas tersimpan.")).toBeInTheDocument();
  });
});

describe("Detail task: label penuh", () => {
  it("isian label baru tetap ada tapi tidak bisa diisi saat sudah 10 label", async () => {
    const ten = Array.from({ length: 10 }, (_, i) => `l${i + 1}`);
    board.getTask.mockResolvedValue(task({ labels: ten }));
    const user = userEvent.setup();
    renderDetail();
    await openDialog();
    await user.click(prop("Label"));
    const input = screen.getByLabelText("Label baru");
    expect(input).toHaveAttribute("aria-disabled", "true");
    expect(input).toHaveAttribute("readonly");
    expect(input).toHaveAccessibleDescription(/Sudah 10 label, batas per task/);
  });
});

describe("Detail task: landmark tab", () => {
  it("nama Komentar dan aktivitas hanya di tablist", async () => {
    renderDetail();
    await openDialog();
    expect(screen.getByRole("tablist", { name: "Komentar dan aktivitas" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Komentar dan aktivitas" })).not.toBeInTheDocument();
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
    await pickFrom(user, "Status", "Dikerjakan");
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
    await user.click(screen.getByRole("button", { name: "Lainnya" }));
    await user.click(screen.getByRole("menuitem", { name: "Hapus task" }));
    const confirm = await screen.findByRole("dialog", { name: "Hapus task PA-12?" });
    await user.click(within(confirm).getByRole("button", { name: "Hapus PA-12" }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(T, "PA-12"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("Detail task: Tamu dan izin komentar", () => {
  it("Tamu: tidak ada isian, menu Lainnya, pilihan properti, atau form komentar", async () => {
    board.getTask.mockResolvedValue(task({ canEdit: false, canDelete: false, canComment: false }));
    renderDetail();
    expect(await screen.findByText(/Anda hanya bisa melihat task ini/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    for (const label of ["Status", "Prioritas", "Penanggung jawab", "Tenggat", "Label"]) {
      expect(queryProp(label)).not.toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Lainnya" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Tulis komentar")).not.toBeInTheDocument();
    // Komentar yang sudah ada tetap bisa dibaca.
    expect(screen.getByText(/Sudah saya baca/)).toBeInTheDocument();
  });

  it("boleh berkomentar tapi tidak mengubah: hanya form komentar", async () => {
    board.getTask.mockResolvedValue(task({ canEdit: false, canDelete: false, canComment: true }));
    renderDetail();
    expect(await screen.findByText(/bisa membaca dan mengomentari task ini/)).toBeInTheDocument();
    expect(screen.getByLabelText("Tulis komentar")).toBeInTheDocument();
    expect(screen.queryByLabelText("Judul task")).not.toBeInTheDocument();
  });

  it("boleh mengubah tapi tidak berkomentar: form komentar tidak ada", async () => {
    board.getTask.mockResolvedValue(task({ canComment: false }));
    renderDetail();
    await openDialog();
    expect(screen.queryByLabelText("Tulis komentar")).not.toBeInTheDocument();
  });
});

describe("Detail task: penanggung jawab yang bukan anggota proyek lagi", () => {
  it("tetap tampil sebagai pilihan terpilih dengan keterangan", async () => {
    const user = userEvent.setup();
    const lama = { publicKey: "c".repeat(64), name: "Budi Uji" };
    board.getTask.mockResolvedValue(task({ assignee: lama }));
    renderDetail();
    await openDialog();
    expect(prop("Penanggung jawab")).toHaveAccessibleName("Penanggung jawab Budi Uji (bukan anggota proyek lagi)");
    await user.click(prop("Penanggung jawab"));
    const menu = screen.getByRole("menu", { name: "Penanggung jawab" });
    expect(within(menu).getByRole("menuitemradio", { name: "Budi Uji (bukan anggota proyek lagi)" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // Anggota proyek yang lain tidak diberi keterangan.
    expect(within(menu).getByRole("menuitemradio", { name: "Sari Uji" })).toBeInTheDocument();
  });

  it("di tampilan baca-saja juga diberi keterangan", async () => {
    const lama = { publicKey: "c".repeat(64), name: "Budi Uji" };
    board.getTask.mockResolvedValue(task({ assignee: lama, canEdit: false, canDelete: false, canComment: false }));
    renderDetail();
    await screen.findByText(/Anda hanya bisa melihat task ini/);
    const props = await screen.findByRole("group", { name: "Rincian task" });
    await waitFor(() => expect(within(props).getByText("Budi Uji (bukan anggota proyek lagi)")).toBeInTheDocument());
  });
});

describe("Detail task: muat ulang saat board berubah", () => {
  it("isian yang sudah diketik tidak tertimpa, field lain ikut data baru", async () => {
    const user = userEvent.setup();
    renderDetail();
    await openDialog();
    // Deskripsi, label, tenggat, dan komentar baru tersimpan lewat tombol atau Enter.
    // Judul tersimpan saat ditinggalkan, jadi diketik terakhir dan tetap difokus.
    await user.click(prop("Label"));
    await user.type(screen.getByLabelText("Label baru"), "draf-label");
    await user.type(screen.getByLabelText("Deskripsi"), " Catatan saya.");
    await user.type(screen.getByLabelText("Tulis komentar"), "Komentar belum dikirim");
    await user.clear(screen.getByLabelText("Judul task"));
    await user.type(screen.getByLabelText("Judul task"), "Judul saya");

    board.getTask.mockResolvedValue(
      task({ title: "Judul dari rekan", description: "Deskripsi dari rekan", priority: "high", due: "2026-12-05" }),
    );
    await boardEvent();

    await waitFor(() => expect(prop("Prioritas")).toHaveAccessibleName("Prioritas Tinggi"));
    expect(prop("Tenggat")).toHaveAccessibleName(/^Tenggat Sabtu, 5 Des/);
    expect(screen.getByLabelText("Judul task")).toHaveValue("Judul saya");
    expect(screen.getByLabelText("Deskripsi")).toHaveValue("Cek pasal pembayaran.\nLalu lampiran. Catatan saya.");
    expect(screen.getByLabelText("Tulis komentar")).toHaveValue("Komentar belum dikirim");
    // Pengguna diberi tahu bahwa rekan juga mengubah field yang sedang diketik.
    expect(screen.getByText(/Judul ini baru diubah di laptop lain menjadi "Judul dari rekan"/)).toBeInTheDocument();
    expect(screen.getByText(/Deskripsi ini baru diubah di laptop lain/)).toBeInTheDocument();
    expect(board.updateTask).not.toHaveBeenCalled();
    // Draf label masih ada saat pilihan Label dibuka lagi.
    await user.click(prop("Label"));
    expect(screen.getByLabelText("Label baru")).toHaveValue("draf-label");
  });

  it("field yang difokus tanpa diketik ditahan, lalu ikut data baru setelah ditinggalkan", async () => {
    renderDetail();
    await openDialog();
    const title = screen.getByLabelText("Judul task");
    act(() => title.focus());
    board.getTask.mockResolvedValue(task({ title: "Judul dari rekan" }));
    await boardEvent();
    await waitFor(() => expect(board.getTask).toHaveBeenCalledTimes(2));
    expect(title).toHaveValue("Review kontrak proyek A");
    act(() => title.blur());
    expect(title).toHaveValue("Judul dari rekan");
    expect(board.updateTask).not.toHaveBeenCalled();
  });

  it("setelah disimpan, isian kembali ikut data dari server", async () => {
    const user = userEvent.setup();
    renderDetail();
    await openDialog();
    const title = screen.getByLabelText("Judul task");
    await user.clear(title);
    await user.type(title, "Judul baru{Enter}");
    await waitFor(() => expect(board.updateTask).toHaveBeenCalledWith(P, T, { title: "Judul baru" }));
    expect(title).toHaveValue("Judul baru");
    act(() => title.blur());
    board.getTask.mockResolvedValue(task({ title: "Judul dari rekan" }));
    await boardEvent();
    await waitFor(() => expect(title).toHaveValue("Judul dari rekan"));
  });
});

describe("Detail task: dihapus di laptop lain", () => {
  it("menampilkan keterangan, isian yang belum tersimpan tetap bisa disalin, dan tidak menutup sendiri", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDetail();
    await openDialog();
    await user.type(screen.getByLabelText("Deskripsi"), " Draf penting.");
    await user.type(screen.getByLabelText("Tulis komentar"), "Komentar draf");

    board.getTask.mockRejectedValue({ code: "not_found", message: "Task tidak ditemukan." });
    await boardEvent();

    expect(await screen.findByText("Task ini dihapus di laptop lain.")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    const desc = screen.getByRole("textbox", { name: "Deskripsi" });
    expect(desc).toHaveValue("Cek pasal pembayaran.\nLalu lampiran. Draf penting.");
    expect(desc).toHaveAttribute("readonly");
    expect(screen.getByRole("textbox", { name: "Komentar" })).toHaveValue("Komentar draf");
    // Isi terakhir tetap terbaca, tapi tidak ada lagi aksi yang menyimpan.
    expect(screen.getByText("Review kontrak proyek A")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Lainnya" })).not.toBeInTheDocument();
    expect(queryProp("Status")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Kirim" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Timer tiruan" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Subtask tiruan" })).toHaveAttribute("data-can-edit", "false");
    await waitFor(() => expect(screen.getByRole("button", { name: "Tutup" })).toHaveFocus());

    await user.click(screen.getByRole("button", { name: "Tutup" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(board.updateTask).not.toHaveBeenCalled();
  });

  it("tanpa isian tertunda: keterangan dan tombol Tutup saja", async () => {
    renderDetail();
    await openDialog();
    board.getTask.mockRejectedValue({ code: "not_found", message: "Task tidak ditemukan." });
    await boardEvent();
    expect(await screen.findByText("Task ini dihapus di laptop lain.")).toBeInTheDocument();
    expect(screen.queryByText("Isian Anda yang belum tersimpan")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tutup" })).toBeInTheDocument();
  });

  it("pilihan yang sedang terbuka ikut tertutup saat task hilang", async () => {
    const user = userEvent.setup();
    renderDetail();
    await openDialog();
    await user.click(prop("Status"));
    board.getTask.mockRejectedValue({ code: "not_found", message: "Task tidak ditemukan." });
    await boardEvent();
    expect(await screen.findByText("Task ini dihapus di laptop lain.")).toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("izin mengubah dicabut saat ada draf: draf tetap bisa disalin, fokus ke Tutup", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDetail();
    await openDialog();
    await user.type(screen.getByLabelText("Deskripsi"), " Draf saya.");

    board.getTask.mockResolvedValue(task({ canEdit: false, canDelete: false, canComment: false }));
    await boardEvent();

    expect(await screen.findByText("Izin mengubah task ini baru dicabut.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Deskripsi" })).toHaveValue(
      "Cek pasal pembayaran.\nLalu lampiran. Draf saya.",
    );
    expect(screen.getByRole("textbox", { name: "Deskripsi" })).toHaveAttribute("readonly");
    expect(screen.queryByText(/Lihat pesan di bawah/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Tutup" })).toHaveFocus());
    // Menutup tidak mencoba menyimpan draf yang sudah tidak boleh disimpan.
    await user.click(screen.getByRole("button", { name: "Tutup" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(board.updateTask).not.toHaveBeenCalled();
  });

  it("izin mengubah dicabut tanpa draf: langsung tampilan baca-saja biasa", async () => {
    renderDetail();
    await openDialog();
    board.getTask.mockResolvedValue(task({ canEdit: false, canDelete: false, canComment: false }));
    await boardEvent();
    expect(await screen.findByText(/Anda hanya bisa melihat task ini/)).toBeInTheDocument();
    expect(screen.queryByText("Izin mengubah task ini baru dicabut.")).not.toBeInTheDocument();
  });

  it("proyeknya tidak bisa dibuka lagi: penyebab dijelaskan", async () => {
    renderDetail();
    await openDialog();
    board.getBoard.mockRejectedValue({
      code: "forbidden",
      message: "Anda bukan anggota proyek ini. Minta pengelola proyek menambahkan Anda.",
    });
    board.getTask.mockRejectedValue({
      code: "forbidden",
      message: "Anda bukan anggota proyek ini. Minta pengelola proyek menambahkan Anda.",
    });
    await boardEvent();
    expect(await screen.findByText("Proyek task ini tidak bisa dibuka lagi.")).toBeInTheDocument();
    expect(screen.getByText(/tidak punya akses lagi ke proyek ini/)).toBeInTheDocument();
  });
});
