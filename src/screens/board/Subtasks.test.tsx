import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Person, Subtask, TaskDetail } from "../../api/board";
import { Subtasks } from "./Subtasks";
import { edgeSpeed, insertIndexAt } from "./useListDrag";

const board = vi.hoisted(() => ({
  addSubtask: vi.fn(),
  updateSubtask: vi.fn(),
  moveSubtask: vi.fn(),
  deleteSubtask: vi.fn(),
}));

vi.mock("../../api/board", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/board")>()),
  boardApi: board,
}));

const ME = "a".repeat(64);
const PK_B = "b".repeat(64);
const PK_C = "c".repeat(64);
const P = "1".repeat(32);
const T = "2".repeat(32);

const penguji: Person = { publicKey: ME, name: "Penguji" };
const satu: Person = { publicKey: PK_B, name: "Anggota Satu" };
const keluar: Person = { publicKey: PK_C, name: "Anggota Lama" };
const ASSIGNEES = [penguji, satu];

function sub(id: string, title: string, extra: Partial<Subtask> = {}): Subtask {
  return { id, title, done: false, assignee: null, doneBy: null, doneAt: null, createdBy: penguji, ...extra };
}

function makeTask(subtasks: Subtask[]): TaskDetail {
  return {
    id: T,
    code: "KAN-1",
    title: "Revisi denah",
    columnId: "todo",
    assignee: null,
    due: null,
    priority: "none",
    labels: [],
    commentCount: 0,
    merged: false,
    subtaskDone: subtasks.filter((s) => s.done).length,
    subtaskTotal: subtasks.length,
    trackedSecs: 0,
    timersRunningSince: [],
    projectId: P,
    description: "",
    createdBy: penguji,
    createdAt: "2026-11-22T01:00:00Z",
    updatedAt: "2026-11-22T01:00:00Z",
    comments: [],
    activity: [],
    canEdit: true,
    canDelete: true,
    canComment: true,
    subtasks,
    timeEntries: [],
    timeTotals: [],
    myRunningEntry: null,
    statusTime: {
      closedSecs: { todo: 0, doing: 0, done: 0 },
      currentColumn: "todo",
      currentSince: "2026-11-22T01:00:00Z",
      cycleSecs: null,
      clockWarning: false,
    },
  };
}

const THREE = () => [sub("s1", "Ukur dinding"), sub("s2", "Gambar ulang tangga", { done: true }), sub("s3", "Kirim PDF")];

// Task terakhir yang dirender; tiruan boardApi menghitung hasil dari sini.
let current: TaskDetail;
let setTaskOutside: (t: TaskDetail) => void = () => {};
const onChange = vi.fn();
const onError = vi.fn();

function Harness({ initial, canEdit = true }: { initial: TaskDetail; canEdit?: boolean }) {
  const [task, setTask] = useState(initial);
  current = task;
  setTaskOutside = setTask;
  return (
    <Subtasks
      task={task}
      me={ME}
      assignees={ASSIGNEES}
      canEdit={canEdit}
      onChange={(t) => {
        onChange(t);
        setTask(t);
      }}
      onError={onError}
    />
  );
}

function withSubs(subtasks: Subtask[]): TaskDetail {
  return { ...current, subtasks, subtaskTotal: subtasks.length, subtaskDone: subtasks.filter((s) => s.done).length };
}

function setup(subtasks: Subtask[] = THREE(), canEdit = true) {
  const user = userEvent.setup();
  render(<Harness initial={makeTask(subtasks)} canEdit={canEdit} />);
  return user;
}

// Tiruan Radix Dialog + TaskDetail: Escape didengar di document saat capture dan
// menutup dialog, kecuali fokus ada di dalam [data-escape-local].
function dialogEscape() {
  const closed: string[] = [];
  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    const active = document.activeElement;
    if (active?.closest("[data-escape-local]")) return;
    closed.push(active?.getAttribute("aria-label") ?? active?.tagName ?? "");
  }
  document.addEventListener("keydown", onKey, true);
  return { closed, stop: () => document.removeEventListener("keydown", onKey, true) };
}

function live() {
  return document.querySelector<HTMLElement>("[aria-live=polite]")!.textContent!.trim();
}

function row(id: string) {
  return document.querySelector<HTMLElement>(`[data-row-id="${id}"]`)!;
}

let nextId = 10;

beforeEach(() => {
  nextId = 10;
  board.addSubtask.mockImplementation(async (_p: string, _t: string, title: string) =>
    withSubs([...current.subtasks, sub(`s${nextId++}`, title)]),
  );
  board.updateSubtask.mockImplementation(
    async (_p: string, _t: string, id: string, patch: { title?: string; done?: boolean; assignee?: string | null }) =>
      withSubs(
        current.subtasks.map((s) => {
          if (s.id !== id) return s;
          const next = { ...s };
          if (patch.title !== undefined) next.title = patch.title;
          if (patch.done !== undefined) next.done = patch.done;
          if (patch.assignee !== undefined)
            next.assignee = patch.assignee === null ? null : ASSIGNEES.find((a) => a.publicKey === patch.assignee)!;
          return next;
        }),
      ),
  );
  board.moveSubtask.mockImplementation(async (_p: string, _t: string, id: string, index: number) => {
    const list = current.subtasks.filter((s) => s.id !== id);
    list.splice(index, 0, current.subtasks.find((s) => s.id === id)!);
    return withSubs(list);
  });
  board.deleteSubtask.mockImplementation(async (_p: string, _t: string, id: string) =>
    withSubs(current.subtasks.filter((s) => s.id !== id)),
  );
});

afterEach(() => {
  onChange.mockReset();
  onError.mockReset();
});

describe("Subtask: tampilan", () => {
  it("menampilkan judul bagian dan progres 1/3 dengan progressbar", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Subtask" })).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Subtask selesai" });
    expect(bar).toHaveAttribute("aria-valuenow", "1");
    expect(bar).toHaveAttribute("aria-valuemax", "3");
    expect(bar).toHaveAttribute("aria-valuetext", "1 dari 3 selesai");
    expect(screen.getByText("1/3")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Gambar ulang tangga" })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "Judul subtask 1 dari 3" })).toHaveValue("Ukur dinding");
  });

  it("keadaan kosong: kalimat singkat dan tombol tambah, tanpa progressbar", () => {
    setup([]);
    expect(screen.getByText(/Belum ada subtask\. Pecah task ini/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tambah subtask" })).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
});

describe("Subtask: tambah", () => {
  it("Enter menambah, kolom tetap terbuka dan kosong untuk subtask berikutnya", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Tambah subtask" }));
    const input = screen.getByRole("textbox", { name: "Judul subtask baru" });
    expect(input).toHaveFocus();
    await user.type(input, "  Beli cat  {Enter}");
    await waitFor(() => expect(board.addSubtask).toHaveBeenCalledWith(P, T, "Beli cat", null));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Judul subtask baru" })).toHaveValue(""));
    expect(screen.getByRole("textbox", { name: "Judul subtask baru" })).toHaveFocus();
    expect(live()).toBe("Subtask Beli cat ditambahkan.");
    expect(screen.getByRole("textbox", { name: "Judul subtask 4 dari 4" })).toHaveValue("Beli cat");

    await user.type(screen.getByRole("textbox", { name: "Judul subtask baru" }), "Pasang lampu{Enter}");
    await waitFor(() => expect(board.addSubtask).toHaveBeenLastCalledWith(P, T, "Pasang lampu", null));
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("menolak judul kosong dan lebih dari 200 karakter dengan pesan jelas", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Tambah subtask" }));
    const input = screen.getByRole("textbox", { name: "Judul subtask baru" });
    await user.type(input, "   {Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent("Tulis judul subtask dulu.");
    expect(input).toHaveAttribute("aria-invalid", "true");

    await user.clear(input);
    fireEvent.change(input, { target: { value: "x".repeat(201) } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert")).toHaveTextContent("paling banyak 200 karakter. Sekarang 201 karakter.");
    expect(board.addSubtask).not.toHaveBeenCalled();
  });

  it("menolak subtask ke-101", async () => {
    const many = Array.from({ length: 100 }, (_, i) => sub(`m${i}`, `Langkah ${i + 1}`));
    const user = setup(many);
    await user.click(screen.getByRole("button", { name: "Tambah subtask" }));
    await user.type(screen.getByRole("textbox", { name: "Judul subtask baru" }), "Satu lagi{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent("sudah punya 100 subtask");
    expect(board.addSubtask).not.toHaveBeenCalled();
  });

  it("Escape menutup isian dan fokus kembali ke tombol tambah", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Tambah subtask" }));
    await user.type(screen.getByRole("textbox", { name: "Judul subtask baru" }), "Draf{Escape}");
    expect(screen.queryByRole("textbox", { name: "Judul subtask baru" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tambah subtask" })).toHaveFocus();
  });

  it("Escape di isian baru tidak sampai ke dialog; isian berisi ditandai belum tersimpan", async () => {
    const dialog = dialogEscape();
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Tambah subtask" }));
    const input = screen.getByRole("textbox", { name: "Judul subtask baru" });
    expect(input).not.toHaveAttribute("data-unsaved");
    await user.type(input, "   ");
    expect(input).not.toHaveAttribute("data-unsaved");
    await user.type(input, "Draf");
    expect(input).toHaveAttribute("data-unsaved", "true");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "Judul subtask baru" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tambah subtask" })).toHaveFocus();
    expect(dialog.closed).toEqual([]);
    // Isian sudah tertutup: Escape berikutnya kembali menutup dialog.
    await user.keyboard("{Escape}");
    expect(dialog.closed).toEqual(["BUTTON"]);
    dialog.stop();
  });
});

describe("Subtask: centang dan judul", () => {
  it("centang mengirim done dan mengumumkan progres", async () => {
    const user = setup();
    await user.click(screen.getByRole("checkbox", { name: "Ukur dinding" }));
    await waitFor(() => expect(board.updateSubtask).toHaveBeenCalledWith(P, T, "s1", { done: true }));
    await waitFor(() => expect(live()).toBe("Selesai. 2 dari 3 subtask selesai."));
    expect(screen.getByRole("checkbox", { name: "Ukur dinding" })).toBeChecked();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2");
  });

  it("tidak mengirim dua perubahan bersamaan untuk subtask yang sama", async () => {
    let release: (t: TaskDetail) => void = () => {};
    board.updateSubtask.mockImplementationOnce(() => new Promise<TaskDetail>((r) => (release = r)));
    const user = setup();
    const box = screen.getByRole("checkbox", { name: "Ukur dinding" });
    await user.click(box);
    expect(box).toBeChecked();
    expect(box).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Hapus subtask Ukur dinding" })).toHaveAttribute("aria-disabled", "true");
    await user.click(box);
    await user.click(screen.getByRole("button", { name: "Hapus subtask Ukur dinding" }));
    expect(board.updateSubtask).toHaveBeenCalledTimes(1);
    expect(board.deleteSubtask).not.toHaveBeenCalled();
    await act(async () => release(withSubs(current.subtasks.map((s) => (s.id === "s1" ? { ...s, done: true } : s)))));
    expect(box).not.toHaveAttribute("aria-disabled");
  });

  it("ubah judul: Enter menyimpan, fokus tetap; tanpa perubahan tidak dikirim", async () => {
    const user = setup();
    const input = screen.getByRole("textbox", { name: "Judul subtask 1 dari 3" });
    await user.click(input);
    await user.tab();
    expect(board.updateSubtask).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, "Ukur dinding timur{Enter}");
    await waitFor(() => expect(board.updateSubtask).toHaveBeenCalledWith(P, T, "s1", { title: "Ukur dinding timur" }));
    expect(input).toHaveFocus();
    await waitFor(() => expect(live()).toBe("Judul subtask tersimpan."));
    await user.tab();
    expect(board.updateSubtask).toHaveBeenCalledTimes(1);
  });

  it("blur menyimpan judul yang diubah", async () => {
    const user = setup();
    const input = screen.getByRole("textbox", { name: "Judul subtask 3 dari 3" });
    await user.type(input, " revisi");
    await user.click(document.body);
    await waitFor(() => expect(board.updateSubtask).toHaveBeenCalledWith(P, T, "s3", { title: "Kirim PDF revisi" }));
  });

  it("Escape memulihkan judul tanpa menyimpan", async () => {
    const user = setup();
    const input = screen.getByRole("textbox", { name: "Judul subtask 1 dari 3" });
    await user.type(input, " salah ketik");
    expect(input).toHaveValue("Ukur dinding salah ketik");
    await user.keyboard("{Escape}");
    expect(input).toHaveValue("Ukur dinding");
    expect(live()).toBe("Perubahan judul dibatalkan.");
    await user.tab();
    expect(board.updateSubtask).not.toHaveBeenCalled();
  });

  it("judul dikosongkan tidak disimpan, judul lama dipakai lagi dengan pesan terlihat", async () => {
    const user = setup();
    const input = screen.getByRole("textbox", { name: "Judul subtask 1 dari 3" });
    await user.clear(input);
    await user.keyboard("{Enter}");
    expect(input).toHaveValue("Ukur dinding");
    expect(live()).toBe("Judul subtask tidak boleh kosong. Judul lama dipakai lagi.");
    expect(board.updateSubtask).not.toHaveBeenCalled();
    const msg = row("s1").querySelector(".td-sub-rowmsg");
    expect(msg).toHaveTextContent("Judul subtask tidak boleh kosong. Judul lama dipakai lagi.");
    expect(input).toHaveAccessibleDescription(/Judul subtask tidak boleh kosong/);
    await user.type(input, " lagi");
    expect(row("s1").querySelector(".td-sub-rowmsg")).toBeNull();
  });

  it("judul dengan ketikan: Escape memulihkan judul tanpa menutup dialog", async () => {
    const dialog = dialogEscape();
    const user = setup();
    const input = screen.getByRole("textbox", { name: "Judul subtask 1 dari 3" });
    await user.click(input);
    expect(input).not.toHaveAttribute("data-escape-local");
    expect(input).not.toHaveAttribute("data-unsaved");
    await user.type(input, " barat");
    expect(input).toHaveAttribute("data-escape-local");
    expect(input).toHaveAttribute("data-unsaved", "true");
    await user.keyboard("{Escape}");
    expect(input).toHaveValue("Ukur dinding");
    expect(input).toHaveFocus();
    expect(input).not.toHaveAttribute("data-escape-local");
    expect(input).not.toHaveAttribute("data-unsaved");
    expect(dialog.closed).toEqual([]);
    // Tanpa ketikan, Escape menutup dialog seperti biasa.
    await user.keyboard("{Escape}");
    expect(dialog.closed).toEqual(["Judul subtask 1 dari 3"]);
    dialog.stop();
  });

  it("data dari rekan tidak menimpa judul yang sedang diketik", async () => {
    const user = setup();
    const input = screen.getByRole("textbox", { name: "Judul subtask 1 dari 3" });
    await user.type(input, " barat");
    act(() =>
      setTaskOutside(
        withSubs(
          current.subtasks.map((s) =>
            s.id === "s1" ? { ...s, title: "Judul dari rekan" } : s.id === "s3" ? { ...s, title: "Kirim PDF final" } : s,
          ),
        ),
      ),
    );
    expect(input).toHaveValue("Ukur dinding barat");
    expect(screen.getByRole("textbox", { name: "Judul subtask 3 dari 3" })).toHaveValue("Kirim PDF final");
    await user.keyboard("{Escape}");
    expect(input).toHaveValue("Judul dari rekan");
  });

  it("error diteruskan ke onError dan ketikan tetap ada", async () => {
    board.updateSubtask.mockRejectedValueOnce({ code: "storage", message: "Penyimpanan di laptop ini menolak perubahan." });
    const user = setup();
    const input = screen.getByRole("textbox", { name: "Judul subtask 1 dari 3" });
    await user.type(input, " ulang{Enter}");
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Penyimpanan di laptop ini menolak perubahan."));
    expect(input).toHaveValue("Ukur dinding ulang");
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("Subtask: hapus", () => {
  it("hapus tanpa konfirmasi, umumkan, dan fokus pindah ke baris berikutnya", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Hapus subtask Ukur dinding" }));
    await waitFor(() => expect(board.deleteSubtask).toHaveBeenCalledWith(P, T, "s1"));
    await waitFor(() => expect(live()).toBe("Subtask Ukur dinding dihapus."));
    expect(screen.queryByRole("checkbox", { name: "Ukur dinding" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Judul subtask 1 dari 2" })).toHaveFocus();
  });

  it("tombol hapus memakai tombol ikon bersama .td-del", () => {
    setup();
    expect(screen.getByRole("button", { name: "Hapus subtask Ukur dinding" })).toHaveClass("td-del");
  });

  it("hapus subtask terakhir: fokus ke tombol tambah", async () => {
    const user = setup([sub("s1", "Satu-satunya")]);
    await user.click(screen.getByRole("button", { name: "Hapus subtask Satu-satunya" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Tambah subtask" })).toHaveFocus());
    expect(screen.getByText(/Belum ada subtask/)).toBeInTheDocument();
  });
});

describe("Subtask: urutkan dengan keyboard", () => {
  it("Alt+Panah bawah memanggil moveSubtask dengan index sesudah pindah, fokus tetap di baris itu", async () => {
    const user = setup();
    const input = screen.getByRole("textbox", { name: "Judul subtask 1 dari 3" });
    await user.click(input);
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await waitFor(() => expect(board.moveSubtask).toHaveBeenCalledWith(P, T, "s1", 1));
    const moved = screen.getByRole("textbox", { name: "Judul subtask 2 dari 3" });
    expect(moved).toHaveValue("Ukur dinding");
    expect(moved).toHaveFocus();
    expect(live()).toBe("Ukur dinding dipindah ke posisi 2 dari 3.");

    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await waitFor(() => expect(board.moveSubtask).toHaveBeenLastCalledWith(P, T, "s1", 2));
    expect(screen.getByRole("textbox", { name: "Judul subtask 3 dari 3" })).toHaveFocus();
  });

  it("Alt+Panah atas dari kotak centang memindah dan fokus tetap di kotak itu", async () => {
    const user = setup();
    screen.getByRole("checkbox", { name: "Kirim PDF" }).focus();
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    await waitFor(() => expect(board.moveSubtask).toHaveBeenCalledWith(P, T, "s3", 1));
    expect(screen.getByRole("checkbox", { name: "Kirim PDF" })).toHaveFocus();
  });

  it("Alt+Panah atas di baris teratas tidak mengirim apa pun", async () => {
    const user = setup();
    await user.click(screen.getByRole("textbox", { name: "Judul subtask 1 dari 3" }));
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(board.moveSubtask).not.toHaveBeenCalled();
    expect(live()).toBe("Subtask ini sudah paling atas.");
  });

  it("gagal pindah: urutan kembali dan error diteruskan", async () => {
    board.moveSubtask.mockRejectedValueOnce({ code: "x", message: "Gagal memindah." });
    const user = setup();
    await user.click(screen.getByRole("textbox", { name: "Judul subtask 1 dari 3" }));
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Gagal memindah."));
    expect(screen.getByRole("textbox", { name: "Judul subtask 1 dari 3" })).toHaveValue("Ukur dinding");
  });
});

// Tata letak tiruan untuk seret: jsdom tidak menghitung posisi. Baris setinggi
// 38 px tiap 40 px menurut urutannya di DOM, digeser sejauh wadah gulir
// [data-testid=scroller] (tinggi 200 px) sudah bergulir.
function mockRows() {
  return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const rect = (top: number, height = 38) =>
      ({ left: 0, top, width: 600, height, right: 600, bottom: top + height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    if (this.dataset.testid === "scroller") return rect(0, 200);
    const rowEl = this.closest<HTMLElement>("[data-row-id]");
    if (!rowEl) return rect(0);
    const scroller = this.closest<HTMLElement>("[data-testid=scroller]");
    const i = Array.from(document.querySelectorAll("[data-row-id]")).indexOf(rowEl);
    return rect(i * 40 - (scroller?.scrollTop ?? 0));
  });
}

// Wadah gulir tiruan setinggi 200 px dengan isi 600 px; scrollTop dibatasi seperti peramban.
function setupScroller(subtasks: Subtask[] = THREE()) {
  render(
    <div data-testid="scroller" style={{ overflowY: "auto" }}>
      <Harness initial={makeTask(subtasks)} />
    </div>,
  );
  const scroller = screen.getByTestId("scroller");
  let top = 0;
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 600 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 200 });
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(400, v));
    },
  });
  return scroller;
}

const MOUSE = { pointerType: "mouse", button: 0, buttons: 1, isPrimary: true };

function handle(id: string) {
  return row(id).querySelector<HTMLElement>("[data-handle]")!;
}

describe("Subtask: seret pegangan", () => {
  let layout: ReturnType<typeof mockRows>;
  beforeEach(() => {
    layout = mockRows();
  });
  afterEach(() => {
    layout.mockRestore();
  });

  it("seret baris pertama ke bawah baris terakhir memanggil moveSubtask(index 2)", async () => {
    setup();
    fireEvent.pointerDown(handle("s1"), { ...MOUSE, pointerId: 1, clientX: 10, clientY: 15 });
    fireEvent.pointerMove(window, { ...MOUSE, pointerId: 1, clientX: 10, clientY: 18 });
    expect(row("s1")).not.toHaveClass("is-dragging");
    fireEvent.pointerMove(window, { ...MOUSE, pointerId: 1, clientX: 10, clientY: 60 });
    fireEvent.pointerMove(window, { ...MOUSE, pointerId: 1, clientX: 10, clientY: 110 });
    expect(row("s1")).toHaveClass("is-dragging");
    expect(row("s3")).toHaveClass("drop-after");
    fireEvent.pointerUp(window, { ...MOUSE, pointerId: 1, buttons: 0, clientX: 10, clientY: 110 });
    await waitFor(() => expect(board.moveSubtask).toHaveBeenCalledWith(P, T, "s1", 2));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Judul subtask 3 dari 3" })).toHaveValue("Ukur dinding"));
    expect(row("s1")).not.toHaveClass("is-dragging");
  });

  it("garis sisip sebelum baris tujuan saat menyeret ke atas", async () => {
    setup();
    fireEvent.pointerDown(handle("s3"), { ...MOUSE, pointerId: 2, clientX: 10, clientY: 95 });
    fireEvent.pointerMove(window, { ...MOUSE, pointerId: 2, clientX: 10, clientY: 10 });
    expect(row("s1")).toHaveClass("drop-before");
    fireEvent.pointerUp(window, { ...MOUSE, pointerId: 2, buttons: 0, clientX: 10, clientY: 10 });
    await waitFor(() => expect(board.moveSubtask).toHaveBeenCalledWith(P, T, "s3", 0));
  });

  it("Escape membatalkan seret tanpa mengirim", () => {
    setup();
    fireEvent.pointerDown(handle("s1"), { ...MOUSE, pointerId: 3, clientX: 10, clientY: 15 });
    fireEvent.pointerMove(window, { ...MOUSE, pointerId: 3, clientX: 10, clientY: 110 });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(row("s1")).not.toHaveClass("is-dragging");
    fireEvent.pointerUp(window, { ...MOUSE, pointerId: 3, buttons: 0, clientX: 10, clientY: 110 });
    expect(board.moveSubtask).not.toHaveBeenCalled();
    expect(live()).toBe("Seret dibatalkan.");
  });

  it("pointer di dekat tepi bawah wadah gulir menggulir otomatis dan posisi sisip ikut berubah", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    try {
      const scroller = setupScroller();
      fireEvent.pointerDown(handle("s1"), { ...MOUSE, pointerId: 4, clientX: 10, clientY: 15 });
      fireEvent.pointerMove(window, { ...MOUSE, pointerId: 4, clientX: 10, clientY: 50 });
      expect(row("s1")).toHaveClass("is-dragging");
      expect(document.querySelector(".drop-before, .drop-after")).toBeNull();
      fireEvent.pointerMove(window, { ...MOUSE, pointerId: 4, clientX: 10, clientY: 195 });
      const before = scroller.scrollTop;
      act(() => frames.shift()!(0));
      expect(scroller.scrollTop).toBeGreaterThan(before);
      // Pointer kembali ke tengah lalu isi digulir (misalnya roda mouse): garis sisip dihitung ulang.
      fireEvent.pointerMove(window, { ...MOUSE, pointerId: 4, clientX: 10, clientY: 50 });
      scroller.scrollTop = 0;
      fireEvent.scroll(scroller);
      expect(document.querySelector(".drop-before, .drop-after")).toBeNull();
      scroller.scrollTop = 40;
      fireEvent.scroll(scroller);
      expect(row("s3")).toHaveClass("drop-before");
      fireEvent.pointerUp(window, { ...MOUSE, pointerId: 4, buttons: 0, clientX: 10, clientY: 50 });
      await waitFor(() => expect(board.moveSubtask).toHaveBeenCalledWith(P, T, "s1", 1));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("edgeSpeed: cepat di tepi, nol di tengah dan di wadah yang terlalu pendek", () => {
    expect(edgeSpeed(100, 0, 200)).toBe(0);
    expect(edgeSpeed(199, 0, 200)).toBeGreaterThan(0);
    expect(edgeSpeed(1, 0, 200)).toBeLessThan(0);
    expect(edgeSpeed(200, 0, 200)).toBe(16);
    expect(edgeSpeed(5, 0, 100)).toBe(0);
  });

  it("insertIndexAt memilih posisi dari titik tengah baris", () => {
    const rows = [
      { top: 0, height: 40 },
      { top: 40, height: 40 },
    ];
    expect(insertIndexAt(rows, 5)).toBe(0);
    expect(insertIndexAt(rows, 25)).toBe(1);
    expect(insertIndexAt(rows, 70)).toBe(2);
  });
});

describe("Subtask: penanggung jawab", () => {
  it("menetapkan anggota dari menu, lalu mengosongkan", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Tetapkan penanggung jawab subtask Ukur dinding" }));
    const menu = screen.getByRole("menu", { name: "Penanggung jawab subtask Ukur dinding" });
    expect(within(menu).getByRole("menuitemradio", { name: "Tanpa penanggung jawab" })).toHaveAttribute("aria-checked", "true");
    expect(within(menu).getByRole("menuitemradio", { name: "Penguji (Anda)" })).toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitemradio", { name: "Anggota Satu" }));
    await waitFor(() => expect(board.updateSubtask).toHaveBeenCalledWith(P, T, "s1", { assignee: PK_B }));
    const btn = await screen.findByRole("button", { name: "Ganti penanggung jawab subtask Ukur dinding (sekarang Anggota Satu)" });
    expect(btn).toHaveFocus();

    await user.click(btn);
    await user.click(screen.getByRole("menuitemradio", { name: "Tanpa penanggung jawab" }));
    await waitFor(() => expect(board.updateSubtask).toHaveBeenLastCalledWith(P, T, "s1", { assignee: null }));
  });

  it("menu bisa dipakai dengan keyboard dan Escape menutup menu saja", async () => {
    const dialog = dialogEscape();
    const user = setup();
    const btn = screen.getByRole("button", { name: "Tetapkan penanggung jawab subtask Kirim PDF" });
    btn.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitemradio", { name: "Tanpa penanggung jawab" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitemradio", { name: "Penguji (Anda)" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(btn).toHaveFocus();
    expect(dialog.closed).toEqual([]);
    dialog.stop();
    await user.keyboard("{ArrowDown}{End}{Enter}");
    await waitFor(() => expect(board.updateSubtask).toHaveBeenCalledWith(P, T, "s3", { assignee: PK_B }));
  });

  it("klik di luar menutup menu, Tab keluar dari menu juga menutupnya", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Tetapkan penanggung jawab subtask Ukur dinding" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.click(screen.getByRole("heading", { name: "Subtask" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Tetapkan penanggung jawab subtask Ukur dinding" }));
    await user.tab();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("penanggung jawab yang bukan anggota lagi tetap tampil dengan keterangan", async () => {
    const user = setup([sub("s1", "Ukur dinding", { assignee: keluar })]);
    const btn = screen.getByRole("button", {
      name: "Ganti penanggung jawab subtask Ukur dinding (sekarang Anggota Lama (bukan anggota proyek lagi))",
    });
    await user.click(btn);
    expect(screen.getByRole("menuitemradio", { name: "Anggota Lama (bukan anggota proyek lagi)" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});

describe("Subtask: Tamu hanya baca", () => {
  it("tanpa pegangan, hapus, tambah, dan kolom judul; centang nonaktif; tanpa sorot dan catatan ganda", () => {
    setup([sub("s1", "Ukur dinding", { assignee: satu }), sub("s2", "Kirim PDF", { done: true })], false);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(document.querySelector("[data-handle]")).toBeNull();
    const box = screen.getByRole("checkbox", { name: "Ukur dinding" });
    expect(box).toBeDisabled();
    // Catatan hanya-baca sudah ditampilkan dialog sekali untuk seluruh task.
    expect(screen.queryByText(/hanya bisa melihat/)).not.toBeInTheDocument();
    expect(row("s1")).not.toHaveClass("is-editable");
    expect(screen.getByText("Ukur dinding")).toBeInTheDocument();
    expect(screen.getByText("Penanggung jawab: Anggota Satu")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");
  });

  it("keadaan kosong untuk Tamu tanpa tombol tambah", () => {
    setup([], false);
    expect(screen.getByText("Belum ada subtask.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Tambah subtask" })).not.toBeInTheDocument();
  });
});
