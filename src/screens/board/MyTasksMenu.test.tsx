// Menu klik kanan baris Task saya (v0.4): Buka task, Pindahkan ke (sub-menu
// tiga kolom), Salin kode. Rancangan: docs/plans/v04-ctx-board.md.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MyTask, TaskCard } from "../../api/board";
import { MyTasks } from "./MyTasks";

const board = vi.hoisted(() => ({ myTasks: vi.fn(), moveTask: vi.fn() }));
const settings = vi.hoisted(() => ({ getSetting: vi.fn(), setSetting: vi.fn() }));

vi.mock("../../api/board", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/board")>()),
  boardApi: board,
  subscribeBoard: () => () => {},
}));

vi.mock("../../api", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../api")>();
  return { ...orig, api: { ...orig.api, ...settings } };
});

const P1 = "1".repeat(32);
const P2 = "3".repeat(32);
const NOW = new Date(2026, 10, 22, 10, 0, 0);

function id(n: number) {
  return String(n).padStart(32, "0");
}

function item(n: number, due: string | null, extra: Partial<TaskCard> = {}, project = P1): MyTask {
  return {
    projectId: project,
    projectCode: project === P1 ? "PA" : "KB",
    projectName: project === P1 ? "Proyek Uji" : "Kantor Baru",
    task: {
      id: id(n),
      code: `${project === P1 ? "PA" : "KB"}-${n}`,
      title: `Task nomor ${n}`,
      columnId: "todo",
      assignee: null,
      due,
      priority: "none",
      labels: [],
      commentCount: 0,
      merged: false,
      subtaskDone: 0,
      subtaskTotal: 0,
      trackedSecs: 0,
      timersRunningSince: [],
      ...extra,
    },
  };
}

// Daftar di "inti Rust" tiruan: moveTask mengubah kolomnya, myTasks membacanya.
let tasks: MyTask[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  tasks = [item(4, "2026-11-20", { columnId: "doing" }), item(5, "2026-11-22", {}, P2), item(6, "2026-11-27")];
  board.myTasks.mockReset().mockImplementation(async () => tasks);
  board.moveTask.mockReset().mockImplementation(async (projectId: string, taskId: string, columnId: TaskCard["columnId"]) => {
    tasks = tasks.map((t) =>
      t.projectId === projectId && t.task.id === taskId ? { ...t, task: { ...t.task, columnId } } : t,
    );
    return null;
  });
  settings.getSetting.mockResolvedValue(null);
  settings.setSetting.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

function row(code: string) {
  return screen.getByRole("button", { name: new RegExp(`^${code}(?!\\d)`) });
}

async function rightClick(user: ReturnType<typeof userEvent.setup>, code: string) {
  await user.pointer({ keys: "[MouseRight]", target: row(code) });
  return screen.getByRole("menu", { name: `Aksi untuk ${code}` });
}

function menuItem(menu: HTMLElement, itemId: string): HTMLElement {
  const el = menu.querySelector<HTMLElement>(`[data-menu-item="${itemId}"]`);
  if (!el) throw new Error(`item ${itemId} tidak ada`);
  return el;
}

// Live region pembaca layar di halaman Task saya.
function status(): HTMLElement {
  const el = document.querySelector<HTMLElement>(".mt-say");
  if (!el) throw new Error("live region tidak ada");
  expect(el).toHaveAttribute("role", "status");
  return el;
}

describe("Menu klik kanan Task saya", () => {
  it("klik kanan menampilkan Buka task, Pindahkan ke, dan Salin kode", async () => {
    const user = userEvent.setup();
    render(<MyTasks onOpenTask={vi.fn()} />);
    await screen.findByText("Task nomor 4");
    const menu = await rightClick(user, "PA-4");
    expect(within(menu).getAllByRole("menuitem").map((el) => el.dataset.menuItem)).toEqual(["open", "move", "copy"]);
    expect(menuItem(menu, "open")).toHaveAccessibleName("Buka task");
    expect(menuItem(menu, "move")).toHaveAccessibleName("Pindahkan ke");
    expect(menuItem(menu, "move")).toHaveAttribute("aria-haspopup", "menu");
    expect(menuItem(menu, "copy")).toHaveAccessibleName("Salin kode PA-4");
  });

  it("klik kiri dan Buka task membuka task di proyeknya", async () => {
    const user = userEvent.setup();
    const onOpenTask = vi.fn();
    render(<MyTasks onOpenTask={onOpenTask} />);
    await screen.findByText("Task nomor 5");
    await user.click(row("KB-5"));
    expect(onOpenTask).toHaveBeenLastCalledWith(P2, id(5));
    onOpenTask.mockClear();

    const menu = await rightClick(user, "PA-6");
    await user.click(menuItem(menu, "open"));
    expect(onOpenTask).toHaveBeenCalledWith(P1, id(6));
  });

  it("sub-menu Pindahkan ke: panah kanan membuka, panah kiri kembali, Enter memilih", async () => {
    const user = userEvent.setup();
    render(<MyTasks onOpenTask={vi.fn()} />);
    await screen.findByText("Task nomor 4");
    const r = row("PA-4");
    r.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    let menu = screen.getByRole("menu", { name: "Aksi untuk PA-4" });
    expect(menuItem(menu, "open")).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowRight}");

    let sub = screen.getByRole("menu", { name: "Pindahkan PA-4 ke" });
    expect(menuItem(sub, "todo")).toHaveFocus();
    expect(within(sub).getAllByRole("menuitem").map((el) => el.dataset.menuItem)).toEqual([
      "__back",
      "todo",
      "doing",
      "done",
    ]);
    expect(menuItem(sub, "__back")).toHaveAccessibleName("Kembali");
    expect(menuItem(sub, "todo")).toHaveAccessibleName("To do");
    expect(menuItem(sub, "doing")).toHaveAccessibleName("Dikerjakan");
    expect(menuItem(sub, "done")).toHaveAccessibleName("Selesai");
    // PA-4 ada di Dikerjakan: pilihan itu nonaktif dengan alasannya.
    expect(menuItem(sub, "doing")).toHaveAttribute("aria-disabled", "true");
    expect(menuItem(sub, "doing")).toHaveAccessibleDescription("Task sudah di kolom ini");

    await user.keyboard("{ArrowLeft}");
    menu = screen.getByRole("menu", { name: "Aksi untuk PA-4" });
    expect(screen.queryByRole("menu", { name: "Pindahkan PA-4 ke" })).not.toBeInTheDocument();
    // Kembali ke item Pindahkan ke, jadi panah kanan langsung membukanya lagi.
    expect(menuItem(menu, "move")).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    sub = screen.getByRole("menu", { name: "Pindahkan PA-4 ke" });
    // Fokus awal di pilihan pertama sesudah Kembali (To do); Enter memilihnya.
    expect(menuItem(sub, "todo")).toHaveFocus();
    await user.keyboard("{Enter}");
    // Fokus kembali ke baris asal.
    expect(row("PA-4")).toHaveFocus();

    await waitFor(() => expect(board.moveTask).toHaveBeenCalledWith(P1, id(4), "todo", 0));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await waitFor(() => expect(status()).toHaveTextContent("PA-4 dipindah ke To do."));
    await waitFor(() => expect(row("PA-4")).toHaveTextContent("To do"));
  });

  it("pindah ke Selesai memindah baris ke grup Selesai yang tertutup; fokus tidak hilang", async () => {
    const user = userEvent.setup();
    render(<MyTasks onOpenTask={vi.fn()} />);
    await screen.findByText("Task nomor 6");
    const menu = await rightClick(user, "PA-6");
    await user.click(menuItem(menu, "move"));
    const sub = screen.getByRole("menu", { name: "Pindahkan PA-6 ke" });
    await user.click(menuItem(sub, "done"));

    await waitFor(() => expect(board.moveTask).toHaveBeenCalledWith(P1, id(6), "done", 0));
    await waitFor(() => expect(status()).toHaveTextContent("PA-6 dipindah ke Selesai."));
    await waitFor(() => expect(screen.queryByText("Task nomor 6")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /^Selesai/ })).toHaveAttribute("aria-expanded", "false");
    // Grup "7 hari ke depan" kosong setelah PA-6 pindah: fokus ke judul halaman, bukan body.
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole("heading", { level: 2, name: "Task saya" })).toHaveFocus();
  });

  it("pindah ke Selesai dari grup yang masih berisi: fokus ke baris sebelahnya", async () => {
    const user = userEvent.setup();
    tasks = [...tasks, item(8, "2026-11-29")];
    render(<MyTasks onOpenTask={vi.fn()} />);
    await screen.findByText("Task nomor 8");
    const menu = await rightClick(user, "PA-6");
    await user.click(menuItem(menu, "move"));
    await user.click(menuItem(screen.getByRole("menu", { name: "Pindahkan PA-6 ke" }), "done"));
    await waitFor(() => expect(screen.queryByText("Task nomor 6")).not.toBeInTheDocument());
    expect(row("PA-8")).toHaveFocus();
  });

  it("gagal pindah menampilkan galat dengan judul dan pesan inti, lalu memuat ulang", async () => {
    const user = userEvent.setup();
    board.moveTask.mockRejectedValueOnce({ code: "forbidden", message: "Tamu tidak bisa memindah task." });
    render(<MyTasks onOpenTask={vi.fn()} />);
    await screen.findByText("Task nomor 6");
    const calls = board.myTasks.mock.calls.length;
    const menu = await rightClick(user, "PA-6");
    await user.click(menuItem(menu, "move"));
    await user.click(menuItem(screen.getByRole("menu", { name: "Pindahkan PA-6 ke" }), "doing"));

    expect(await screen.findByText("PA-6 belum dipindah")).toBeInTheDocument();
    expect(screen.getByText("Tamu tidak bisa memindah task.")).toBeInTheDocument();
    await waitFor(() => expect(board.myTasks.mock.calls.length).toBeGreaterThan(calls));
    expect(row("PA-6")).toHaveTextContent("To do");
  });

  it("Salin kode menulis kode ke papan klip dan mengumumkannya; gagal menyalin tampil sebagai galat", async () => {
    const user = userEvent.setup();
    render(<MyTasks onOpenTask={vi.fn()} />);
    await screen.findByText("Task nomor 5");
    let menu = await rightClick(user, "KB-5");
    await user.click(menuItem(menu, "copy"));
    await waitFor(() => expect(status()).toHaveTextContent("Kode KB-5 disalin."));
    expect(await navigator.clipboard.readText()).toBe("KB-5");

    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("ditolak"));
    menu = await rightClick(user, "KB-5");
    await act(async () => {
      await user.click(menuItem(menu, "copy"));
    });
    expect(await screen.findByText("Kode KB-5 belum tersalin")).toBeInTheDocument();
    expect(screen.getByText(/Papan klip tidak bisa dipakai saat ini/)).toBeInTheDocument();
  });
});
