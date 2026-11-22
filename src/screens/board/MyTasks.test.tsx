import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REMINDER_DAY_BEFORE, REMINDER_DUE_DAY, type MyTask, type TaskCard } from "../../api/board";
import { MyTasks } from "./MyTasks";
import { groupMyTasks } from "./myTasksGroups";

const board = vi.hoisted(() => ({ myTasks: vi.fn() }));
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

function item(n: number, due: string | null, extra: Partial<TaskCard> = {}, project = P1): MyTask {
  return {
    projectId: project,
    projectCode: project === P1 ? "PA" : "KB",
    projectName: project === P1 ? "Proyek Uji" : "Kantor Baru",
    task: {
      id: String(n).padStart(32, "0"),
      code: `${project === P1 ? "PA" : "KB"}-${n}`,
      title: `Task nomor ${n}`,
      columnId: "todo",
      assignee: null,
      due,
      priority: "none",
      labels: [],
      commentCount: 0,
      merged: false,
      ...extra,
    },
  };
}

const sample: MyTask[] = [
  item(1, "2026-12-15"),
  item(2, null),
  item(3, "2026-11-23", { priority: "high" }),
  item(4, "2026-11-20", { columnId: "doing" }),
  item(5, "2026-11-22", {}, P2),
  item(6, "2026-11-27"),
  item(7, "2026-11-10", { columnId: "done" }),
  item(8, "2026-11-29"),
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  board.myTasks.mockResolvedValue(sample);
  settings.getSetting.mockResolvedValue(null);
  settings.setSetting.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Pengelompokan Task saya", () => {
  it("mengelompokkan menurut tenggat, task selesai terpisah", () => {
    const groups = groupMyTasks(sample, NOW);
    expect(groups.map((g) => [g.id, g.items.map((i) => i.task.code)])).toEqual([
      ["late", ["PA-4"]],
      ["today", ["KB-5"]],
      ["tomorrow", ["PA-3"]],
      ["week", ["PA-6", "PA-8"]],
      ["later", ["PA-1"]],
      ["none", ["PA-2"]],
      ["done", ["PA-7"]],
    ]);
  });
});

describe("Halaman Task saya", () => {
  it("menampilkan kelompok berurutan dengan rincian per baris", async () => {
    render(<MyTasks onOpenTask={vi.fn()} />);
    expect(screen.getByText("Memuat task Anda...")).toBeInTheDocument();
    await screen.findByText("Task nomor 4");
    const titles = screen
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent?.replace(/\d+$/, "").trim());
    expect(titles).toEqual([
      "Terlambat",
      "Hari ini",
      "Besok",
      "7 hari ke depan",
      "Nanti",
      "Tanpa tenggat",
      "Selesai",
      "Pengingat tenggat",
    ]);
    const late = screen.getByRole("button", { name: /PA-4/ });
    expect(late).toHaveTextContent("Proyek Uji");
    expect(late).toHaveTextContent("Dikerjakan");
    expect(late).toHaveTextContent("Terlambat 2 hari");
    expect(screen.getByRole("button", { name: /PA-3/ })).toHaveTextContent("Tinggi");
    expect(screen.getByRole("button", { name: /KB-5/ })).toHaveTextContent("Kantor Baru");
  });

  it("Selesai tertutup sampai dibuka", async () => {
    const user = userEvent.setup();
    render(<MyTasks onOpenTask={vi.fn()} />);
    const toggle = await screen.findByRole("button", { name: /Selesai/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Task nomor 7")).not.toBeInTheDocument();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Task nomor 7")).toBeInTheDocument();
  });

  it("baris membuka task di proyeknya", async () => {
    const user = userEvent.setup();
    const onOpenTask = vi.fn();
    render(<MyTasks onOpenTask={onOpenTask} />);
    await user.click(await screen.findByRole("button", { name: /KB-5/ }));
    expect(onOpenTask).toHaveBeenCalledWith(P2, "5".padStart(32, "0"));
  });

  it("keadaan kosong menjelaskan dari mana task datang", async () => {
    board.myTasks.mockResolvedValue([]);
    render(<MyTasks onOpenTask={vi.fn()} />);
    expect(
      await screen.findByText("Task yang ditugaskan ke Anda di board proyek akan muncul di sini."),
    ).toBeInTheDocument();
  });

  it("error membaca bisa dicoba lagi", async () => {
    const user = userEvent.setup();
    board.myTasks.mockRejectedValueOnce({ code: "database", message: "Database terkunci." });
    render(<MyTasks onOpenTask={vi.fn()} />);
    expect(await screen.findByText("Task Anda belum terbaca")).toBeInTheDocument();
    const alert = screen.getByRole("alert");
    await user.click(within(alert).getByRole("button", { name: "Coba lagi" }));
    expect(await screen.findByText("Task nomor 4")).toBeInTheDocument();
  });
});

describe("Pengingat tenggat", () => {
  it("bawaan menyala, dan centang menyimpan off atau on", async () => {
    const user = userEvent.setup();
    settings.getSetting.mockImplementation(async (key: string) => (key === REMINDER_DUE_DAY ? "off" : null));
    render(<MyTasks onOpenTask={vi.fn()} />);
    const dayBefore = await screen.findByRole("checkbox", { name: "Sehari sebelum tenggat" });
    const dueDay = screen.getByRole("checkbox", { name: "Di hari tenggat" });
    expect(dayBefore).toBeChecked();
    expect(dueDay).not.toBeChecked();

    await user.click(dayBefore);
    await waitFor(() => expect(settings.setSetting).toHaveBeenCalledWith(REMINDER_DAY_BEFORE, "off"));
    expect(dayBefore).not.toBeChecked();

    await user.click(dueDay);
    await waitFor(() => expect(settings.setSetting).toHaveBeenCalledWith(REMINDER_DUE_DAY, "on"));
    expect(dueDay).toBeChecked();
  });

  it("gagal menyimpan mengembalikan centang dan menampilkan error", async () => {
    const user = userEvent.setup();
    settings.setSetting.mockRejectedValueOnce({ code: "database", message: "Disk penuh." });
    render(<MyTasks onOpenTask={vi.fn()} />);
    const dayBefore = await screen.findByRole("checkbox", { name: "Sehari sebelum tenggat" });
    await user.click(dayBefore);
    expect(await screen.findByText('Pengingat "Sehari sebelum tenggat" belum tersimpan')).toBeInTheDocument();
    expect(dayBefore).toBeChecked();
  });
});

describe("Pengingat tenggat: klik beruntun", () => {
  it("jawaban lama diabaikan, gagal terakhir kembali ke nilai tersimpan terakhir", async () => {
    const user = userEvent.setup();
    let failFirst: (reason: unknown) => void = () => {};
    settings.setSetting
      .mockImplementationOnce(() => new Promise((_, reject) => (failFirst = reject)))
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce({ code: "database", message: "Disk penuh." });
    render(<MyTasks onOpenTask={vi.fn()} />);
    const box = await screen.findByRole("checkbox", { name: "Sehari sebelum tenggat" });

    await user.click(box); // off, belum dijawab
    await user.click(box); // on, tersimpan
    await waitFor(() => expect(settings.setSetting).toHaveBeenLastCalledWith(REMINDER_DAY_BEFORE, "on"));
    failFirst({ code: "database", message: "Terlambat." });
    await screen.findByText('Pengingat "Sehari sebelum tenggat" dinyalakan.');
    expect(box).toBeChecked();
    expect(screen.queryByText("Terlambat.")).not.toBeInTheDocument();

    await user.click(box); // off, gagal: kembali ke on yang tersimpan
    expect(await screen.findByText("Disk penuh.")).toBeInTheDocument();
    expect(box).toBeChecked();
  });
});
