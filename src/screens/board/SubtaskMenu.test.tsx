// Menu klik kanan baris subtask di dialog detail task (docs/plans/v04-ctx-board.md).
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Person, Subtask, TaskDetail } from "../../api/board";
import { TextFieldMenu } from "../../components/ContextMenu";
import { Dialog } from "../../components/Dialog";
import { Subtasks } from "./Subtasks";

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
const P = "1".repeat(32);
const T = "2".repeat(32);

const penguji: Person = { publicKey: ME, name: "Penguji" };
const satu: Person = { publicKey: PK_B, name: "Anggota Satu" };
// Saya sengaja bukan yang pertama: menu tetap menaruh saya paling atas.
const ASSIGNEES = [satu, penguji];

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

const THREE = () => [
  sub("s1", "Ukur dinding"),
  sub("s2", "Gambar ulang tangga", { done: true, assignee: satu }),
  sub("s3", "Kirim PDF"),
];

let current: TaskDetail;

function Harness({ initial, canEdit = true }: { initial: TaskDetail; canEdit?: boolean }) {
  const [task, setTask] = useState(initial);
  current = task;
  return <Subtasks task={task} me={ME} assignees={ASSIGNEES} canEdit={canEdit} onChange={setTask} onError={() => {}} />;
}

function withSubs(subtasks: Subtask[]): TaskDetail {
  return { ...current, subtasks, subtaskTotal: subtasks.length, subtaskDone: subtasks.filter((s) => s.done).length };
}

function setup(subtasks: Subtask[] = THREE(), canEdit = true) {
  const user = userEvent.setup();
  render(<Harness initial={makeTask(subtasks)} canEdit={canEdit} />);
  return user;
}

function row(id: string) {
  return document.querySelector<HTMLElement>(`[data-row-id="${id}"]`)!;
}

function part(id: string, name: "check" | "title" | "who" | "del") {
  return row(id).querySelector<HTMLElement>(`[data-part="${name}"]`)!;
}

function handle(id: string) {
  return row(id).querySelector<HTMLElement>("[data-handle]")!;
}

async function rightClick(user: ReturnType<typeof userEvent.setup>, el: Element) {
  await user.pointer({ keys: "[MouseRight]", target: el });
}

function menuOf(title: string) {
  return screen.getByRole("menu", { name: `Aksi untuk subtask ${title}` });
}

function labels(menu: HTMLElement) {
  return within(menu)
    .getAllByRole("menuitem")
    .map((el) => el.dataset.label);
}

function item(id: string) {
  return document.querySelector<HTMLElement>(`[role=menu] [data-menu-item="${id}"]`)!;
}

beforeEach(() => {
  vi.clearAllMocks();
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

describe("Menu subtask: membuka", () => {
  it("klik kanan di kotak centang membuka menu dengan item lengkap, item pertama terfokus", async () => {
    const user = setup();
    await rightClick(user, part("s1", "check"));
    const menu = menuOf("Ukur dinding");
    expect(labels(menu)).toEqual(["Tandai selesai", "Ganti nama", "Tugaskan ke", "Pindah naik", "Pindah turun", "Hapus subtask"]);
    expect(item("toggle")).toHaveFocus();
    expect(item("assign")).toHaveAttribute("aria-haspopup", "menu");
    expect(item("delete")).toHaveClass("cmenu-danger");
    expect(item("up")).toHaveAttribute("aria-disabled", "true");
    expect(item("up")).toHaveAccessibleDescription("Sudah paling atas");
    expect(item("down")).not.toHaveAttribute("aria-disabled");
  });

  it("subtask selesai menawarkan Tandai belum selesai", async () => {
    const user = setup();
    await rightClick(user, part("s2", "check"));
    expect(labels(menuOf("Gambar ulang tangga"))[0]).toBe("Tandai belum selesai");
  });

  it("klik kanan di pegangan, avatar, tombol hapus, dan ruang kosong baris juga membuka menu subtask", async () => {
    const user = setup();
    for (const el of [handle("s3"), part("s3", "who"), part("s3", "del"), row("s3")]) {
      await rightClick(user, el);
      expect(menuOf("Kirim PDF")).toBeInTheDocument();
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    }
  });

  it("klik kanan di kolom judul memberi menu teks, bukan menu subtask", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Harness initial={makeTask(THREE())} />
        <TextFieldMenu />
      </>,
    );
    const title = part("s1", "title");
    title.focus();
    await rightClick(user, title);
    expect(screen.getByRole("menu", { name: "Menu teks" })).toBeInTheDocument();
    expect(screen.queryByRole("menu", { name: /Aksi untuk subtask/ })).not.toBeInTheDocument();
  });

  it("baris hanya baca tidak punya menu", async () => {
    const user = setup(THREE(), false);
    const ev = fireEvent.contextMenu(part("s1", "check"));
    expect(ev).toBe(true);
    await rightClick(user, row("s1"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("Shift+F10 dari kotak centang membuka menu; dari kolom judul tidak", async () => {
    const user = setup();
    part("s1", "title").focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    part("s1", "check").focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(menuOf("Ukur dinding")).toBeInTheDocument();
    expect(item("toggle")).toHaveFocus();
  });

  it("Shift+F10 dari tombol hapus membuka menu, Esc menutup dan fokus kembali ke tombol", async () => {
    const user = setup();
    const del = part("s2", "del");
    del.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(menuOf("Gambar ulang tangga")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(del).toHaveFocus();
  });

  it("klik kanan di pegangan mengembalikan fokus ke kotak centang baris itu setelah Esc", async () => {
    const user = setup();
    await rightClick(user, handle("s2"));
    await user.keyboard("{Escape}");
    expect(part("s2", "check")).toHaveFocus();
  });
});

describe("Menu subtask: aksi", () => {
  it("panah dan Enter: Tandai selesai mengirim done", async () => {
    const user = setup();
    await rightClick(user, part("s1", "check"));
    await user.keyboard("{ArrowDown}");
    expect(item("rename")).toHaveFocus();
    await user.keyboard("{ArrowUp}{Enter}");
    await waitFor(() => expect(board.updateSubtask).toHaveBeenCalledWith(P, T, "s1", { done: true }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(part("s1", "check")).toHaveFocus();
    await waitFor(() => expect(part("s1", "check")).toBeChecked());
  });

  it("Tandai belum selesai mengirim done false", async () => {
    const user = setup();
    await rightClick(user, part("s2", "check"));
    await user.click(item("toggle"));
    await waitFor(() => expect(board.updateSubtask).toHaveBeenCalledWith(P, T, "s2", { done: false }));
  });

  it("Ganti nama memfokuskan kolom judul dan memilih seluruh teksnya", async () => {
    const user = setup();
    await rightClick(user, part("s3", "del"));
    await user.click(item("rename"));
    const title = part("s3", "title") as HTMLInputElement;
    expect(title).toHaveFocus();
    expect(title.selectionStart).toBe(0);
    expect(title.selectionEnd).toBe("Kirim PDF".length);
    expect(board.updateSubtask).not.toHaveBeenCalled();
  });

  it("Tugaskan ke lewat sub-menu: saya paling atas, panah kanan membuka, Enter menetapkan", async () => {
    const user = setup();
    await rightClick(user, part("s1", "check"));
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(item("assign")).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    const subMenu = screen.getByRole("menu", { name: "Tugaskan subtask Ukur dinding ke" });
    expect(labels(subMenu)).toEqual(["Kembali", "Penguji (Anda)", "Anggota Satu", "Tanpa penanggung jawab"]);
    // Fokus awal di pilihan pertama sesudah Kembali.
    expect(item(`who-${ME}`)).toHaveFocus();
    expect(item("who-none")).toHaveAttribute("aria-disabled", "true");
    expect(item("who-none")).toHaveAccessibleDescription("Belum ada penanggung jawab");
    await user.keyboard("{ArrowDown}");
    expect(item(`who-${PK_B}`)).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(board.updateSubtask).toHaveBeenCalledWith(P, T, "s1", { assignee: PK_B }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(part("s1", "check")).toHaveFocus();
  });

  it("sub-menu Tugaskan ke: penanggung jawab sekarang nonaktif, Tanpa penanggung jawab melepas", async () => {
    const user = setup();
    await rightClick(user, part("s2", "check"));
    await user.click(item("assign"));
    expect(item(`who-${PK_B}`)).toHaveAttribute("aria-disabled", "true");
    expect(item(`who-${PK_B}`)).toHaveAccessibleDescription("Penanggung jawab sekarang");
    await user.click(item(`who-${PK_B}`));
    expect(board.updateSubtask).not.toHaveBeenCalled();
    await user.click(item("who-none"));
    await waitFor(() => expect(board.updateSubtask).toHaveBeenCalledWith(P, T, "s2", { assignee: null }));
  });

  it("panah kiri di sub-menu kembali ke menu utama, fokus di Tugaskan ke", async () => {
    const user = setup();
    await rightClick(user, part("s1", "check"));
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowRight}");
    expect(screen.getByRole("menu", { name: "Tugaskan subtask Ukur dinding ke" })).toBeInTheDocument();
    await user.keyboard("{ArrowLeft}");
    expect(menuOf("Ukur dinding")).toBeInTheDocument();
    expect(item("assign")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(part("s1", "check")).toHaveFocus();
  });

  it("Pindah naik dan turun memanggil moveSubtask dengan indeks tujuan; fokus tetap di baris", async () => {
    const user = setup();
    await rightClick(user, part("s2", "check"));
    await user.click(item("up"));
    await waitFor(() => expect(board.moveSubtask).toHaveBeenCalledWith(P, T, "s2", 0));
    await waitFor(() => expect(row("s2").previousElementSibling).toBeNull());
    expect(part("s2", "check")).toHaveFocus();

    await rightClick(user, part("s2", "del"));
    expect(item("up")).toHaveAttribute("aria-disabled", "true");
    await user.click(item("down"));
    await waitFor(() => expect(board.moveSubtask).toHaveBeenLastCalledWith(P, T, "s2", 1));
    await waitFor(() => expect(part("s2", "del")).toHaveFocus());
  });

  it("baris terakhir: Pindah turun nonaktif dengan alasan dan tidak memindah", async () => {
    const user = setup();
    await rightClick(user, part("s3", "check"));
    expect(item("down")).toHaveAttribute("aria-disabled", "true");
    expect(item("down")).toHaveAccessibleDescription("Sudah paling bawah");
    await user.click(item("down"));
    expect(board.moveSubtask).not.toHaveBeenCalled();
    expect(menuOf("Kirim PDF")).toBeInTheDocument();
  });

  it("Hapus subtask langsung menghapus tanpa dialog konfirmasi", async () => {
    const user = setup();
    await rightClick(user, part("s1", "check"));
    await user.keyboard("{End}");
    expect(item("delete")).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(board.deleteSubtask).toHaveBeenCalledWith(P, T, "s1"));
    await waitFor(() => expect(row("s1")).toBeNull());
  });

  it("selama baris menunggu, item ubah nonaktif dengan alasan", async () => {
    let release: (t: TaskDetail) => void = () => {};
    board.updateSubtask.mockImplementationOnce(() => new Promise<TaskDetail>((r) => (release = r)));
    const user = setup();
    await user.click(part("s1", "check"));
    await rightClick(user, part("s1", "check"));
    for (const id of ["toggle", "rename", "assign", "down", "delete"]) {
      expect(item(id)).toHaveAttribute("aria-disabled", "true");
      expect(item(id)).toHaveAccessibleDescription("Tunggu perubahan sebelumnya tersimpan");
    }
    await user.click(item("delete"));
    await user.click(item("assign"));
    expect(screen.queryByRole("menu", { name: /Tugaskan subtask/ })).not.toBeInTheDocument();
    expect(board.deleteSubtask).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    await act(async () => release(withSubs(current.subtasks.map((s) => (s.id === "s1" ? { ...s, done: true } : s)))));

    await rightClick(user, part("s1", "check"));
    expect(item("delete")).not.toHaveAttribute("aria-disabled");
  });

  it("baris lain tetap bisa diubah selagi satu baris menunggu", async () => {
    board.updateSubtask.mockImplementationOnce(() => new Promise<TaskDetail>(() => {}));
    const user = setup();
    await user.click(part("s1", "check"));
    await rightClick(user, part("s3", "check"));
    expect(item("toggle")).not.toHaveAttribute("aria-disabled");
  });
});

describe("Menu subtask: di dalam dialog modal", () => {
  function InDialog({ onClose }: { onClose: () => void }) {
    const [open, setOpen] = useState(true);
    return (
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) onClose();
        }}
        title="Revisi denah"
      >
        <Harness initial={makeTask(THREE())} />
      </Dialog>
    );
  }

  it("menu dan sub-menu dirender di dalam dialog; Esc hanya menutup menu, Esc berikutnya menutup dialog", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<InDialog onClose={onClose} />);
    const dialog = screen.getByRole("dialog");
    const check = within(dialog).getByRole("checkbox", { name: "Ukur dinding" });

    await rightClick(user, check);
    expect(dialog.contains(menuOf("Ukur dinding"))).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(check).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();

    await rightClick(user, check);
    await user.click(item("assign"));
    const subMenu = screen.getByRole("menu", { name: "Tugaskan subtask Ukur dinding ke" });
    expect(dialog.contains(subMenu)).toBe(true);
    expect(item(`who-${ME}`)).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(check).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("memilih orang di sub-menu dalam dialog menetapkan penanggung jawab", async () => {
    const user = userEvent.setup();
    render(<InDialog onClose={() => {}} />);
    await rightClick(user, screen.getByRole("checkbox", { name: "Kirim PDF" }));
    await user.click(item("assign"));
    await user.click(item(`who-${ME}`));
    await waitFor(() => expect(board.updateSubtask).toHaveBeenCalledWith(P, T, "s3", { assignee: ME }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
