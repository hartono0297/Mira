import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api";
import { boardApi, subscribeBoard } from "../../api/board";
import { calendarApi, type CalTask } from "../../api/calendar";
import { renderInLang } from "../../test/i18n";
import { CalendarScreen } from "./CalendarScreen";
import { ME, PROJECTS, T_DONE, T_LATE, T_LATE_DONE, T_LOCKED, T_MINE } from "./calendarTestKit";

vi.mock("../../api/calendar", () => ({ calendarApi: { tasks: vi.fn() } }));
vi.mock("../../api/board", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../api/board")>();
  return { ...real, boardApi: { listProjects: vi.fn(), updateTask: vi.fn() }, subscribeBoard: vi.fn() };
});
vi.mock("../../api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../api")>();
  return { ...real, api: { ...real.api, getSetting: vi.fn(), setSetting: vi.fn() } };
});
vi.mock("../board/TaskDetail", () => ({
  TaskDetail: (p: { projectId: string; taskId: string; onClose: () => void; onChanged: () => void }) => (
    <div role="dialog" aria-label="Detail task">
      <p>
        Detail {p.projectId}/{p.taskId}
      </p>
      <button type="button" onClick={p.onChanged}>
        Ubah
      </button>
      <button type="button" onClick={p.onClose}>
        Tutup detail
      </button>
    </div>
  ),
}));
vi.mock("./MonthView", async () => ({ MonthView: (await import("./calendarTestKit")).FakeMonthView }));
vi.mock("./WeekView", async () => ({ WeekView: (await import("./calendarTestKit")).FakeWeekView }));
vi.mock("./AgendaView", async () => ({ AgendaView: (await import("./calendarTestKit")).FakeAgendaView }));

const tasksMock = vi.mocked(calendarApi.tasks);
const updateMock = vi.mocked(boardApi.updateTask);
const projectsMock = vi.mocked(boardApi.listProjects);
const subscribeMock = vi.mocked(subscribeBoard);
const getSetting = vi.mocked(api.getSetting);
const setSetting = vi.mocked(api.setSetting);

let boardHandlers: (() => void)[] = [];
let data: CalTask[] = [];
let overdueData: CalTask[] = [];

function inRange(list: CalTask[], from: string | null, to: string | null) {
  return list.filter((t) => t.task.due && (!from || t.task.due >= from) && (!to || t.task.due <= to));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 24, 10, 0, 0));
  data = [T_MINE, T_LOCKED, T_DONE];
  overdueData = [T_LATE, T_LATE_DONE];
  boardHandlers = [];
  tasksMock.mockReset();
  tasksMock.mockImplementation(async (from, to) =>
    from === null ? inRange(overdueData, from, to) : inRange(data, from, to),
  );
  updateMock.mockReset();
  // Inti menyimpan tenggat baru, jadi muat ulang sesudahnya membaca tenggat itu.
  updateMock.mockImplementation(async (projectId, taskId, patch) => {
    if ("due" in patch) {
      data = data.map((t) =>
        t.projectId === projectId && t.task.id === taskId ? { ...t, task: { ...t.task, due: patch.due ?? null } } : t,
      );
    }
    return {} as never;
  });
  projectsMock.mockReset();
  projectsMock.mockResolvedValue(PROJECTS);
  subscribeMock.mockReset();
  subscribeMock.mockImplementation((h) => {
    boardHandlers.push(h);
    return () => {
      boardHandlers = boardHandlers.filter((x) => x !== h);
    };
  });
  getSetting.mockReset();
  getSetting.mockResolvedValue(null);
  setSetting.mockReset();
  setSetting.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

async function renderScreen() {
  const utils = render(<CalendarScreen me={ME} />);
  await screen.findByText(/TES-3/);
  return utils;
}

function chip(code: string): HTMLElement {
  const el = screen.queryAllByRole("button").find((b) => b.hasAttribute("data-cal-task") && b.textContent?.startsWith(`${code} `));
  if (!el) throw new Error(`chip ${code} tidak ada`);
  return el;
}

function dayOf(code: string): string | null {
  return chip(code).closest("[data-cal-day]")?.getAttribute("data-cal-day") ?? null;
}

function status(): HTMLElement {
  return screen.getByTestId("cal-say");
}

describe("CalendarScreen: rentang dan navigasi", () => {
  it("memuat rentang grid bulan ini dan menampilkan judul bulan", async () => {
    await renderScreen();
    expect(screen.getByRole("heading", { level: 1, name: "November 2026" })).toBeInTheDocument();
    expect(tasksMock).toHaveBeenCalledWith("2026-10-26", "2026-12-06");
    expect(tasksMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("view-month")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bulan" })).toHaveAttribute("aria-pressed", "true");
  });

  it("tampilan Minggu memuat Senin sampai Minggu dan menyimpan pilihan", async () => {
    const user = userEvent.setup();
    await renderScreen();
    await user.click(screen.getByRole("button", { name: "Minggu" }));
    expect(screen.getByRole("heading", { level: 1, name: "23 sampai 29 November 2026" })).toBeInTheDocument();
    expect(tasksMock).toHaveBeenLastCalledWith("2026-11-23", "2026-11-29");
    expect(screen.getByRole("button", { name: "Minggu sebelumnya" })).toBeInTheDocument();
    expect(setSetting).toHaveBeenCalledWith("calendar.view", "week");
    expect(screen.getByTestId("view-week")).toBeInTheDocument();
  });

  it("Agenda memuat bulan dan grup lewat tenggat sebelum rentang, hanya yang belum selesai", async () => {
    const user = userEvent.setup();
    await renderScreen();
    await user.click(screen.getByRole("button", { name: "Agenda" }));
    await waitFor(() => expect(tasksMock).toHaveBeenCalledWith(null, "2026-10-31"));
    expect(tasksMock).toHaveBeenCalledWith("2026-11-01", "2026-11-30");
    const overdue = await screen.findByTestId("overdue");
    await waitFor(() => expect(within(overdue).getByText(/OPS-2/)).toBeInTheDocument());
    expect(within(overdue).queryByText(/OPS-3/)).not.toBeInTheDocument();
  });

  it("Agenda bulan lain tidak meminta grup lewat tenggat", async () => {
    const user = userEvent.setup();
    await renderScreen();
    await user.click(screen.getByRole("button", { name: "Agenda" }));
    await user.click(screen.getByRole("button", { name: "Bulan berikutnya" }));
    await waitFor(() => expect(tasksMock).toHaveBeenLastCalledWith("2026-12-01", "2026-12-31"));
    expect(tasksMock).not.toHaveBeenCalledWith(null, "2026-11-30");
  });

  it("sebelumnya, berikutnya, dan Hari ini mengganti rentang dan judul", async () => {
    const user = userEvent.setup();
    await renderScreen();
    await user.click(screen.getByRole("button", { name: "Bulan berikutnya" }));
    expect(screen.getByRole("heading", { level: 1, name: "Desember 2026" })).toBeInTheDocument();
    expect(tasksMock).toHaveBeenLastCalledWith("2026-11-30", "2027-01-03");
    expect(status()).toHaveTextContent("Menampilkan Desember 2026.");
    await user.click(screen.getByRole("button", { name: "Bulan sebelumnya" }));
    await user.click(screen.getByRole("button", { name: "Bulan sebelumnya" }));
    expect(screen.getByRole("heading", { level: 1, name: "Oktober 2026" })).toBeInTheDocument();
    expect(tasksMock).toHaveBeenLastCalledWith("2026-09-28", "2026-11-01");
    await user.click(screen.getByRole("button", { name: "Hari ini" }));
    expect(screen.getByRole("heading", { level: 1, name: "November 2026" })).toBeInTheDocument();
  });

  it("muat ulang saat board berubah", async () => {
    await renderScreen();
    const before = tasksMock.mock.calls.length;
    data = [T_MINE, T_LOCKED, T_DONE, { ...T_MINE, task: { ...T_MINE.task, id: "t9", code: "TES-9", title: "Baru" } }];
    await act(async () => boardHandlers.forEach((h) => h()));
    expect(tasksMock.mock.calls.length).toBeGreaterThan(before);
    expect(await screen.findByText(/TES-9/)).toBeInTheDocument();
  });

  it("dalam bahasa Inggris memakai teks Inggris", async () => {
    renderInLang(() => <CalendarScreen me={ME} />, "en");
    await screen.findByText(/TES-3/);
    expect(screen.getByRole("heading", { level: 1, name: "November 2026" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next month" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Show completed" })).toBeInTheDocument();
  });
});

describe("CalendarScreen: saringan", () => {
  it("bawaan Semua proyek tanpa yang selesai; Task saya, yang selesai, dan satu proyek", async () => {
    const user = userEvent.setup();
    await renderScreen();
    const select = screen.getByRole("combobox", { name: "Lihat" });
    expect(select).toHaveValue("all");
    expect(chip("TES-4")).toBeInTheDocument();
    expect(screen.queryByText(/OPS-1/)).not.toBeInTheDocument();
    expect(within(select).getByRole("option", { name: "TES · Tes" })).toBeInTheDocument();

    await user.selectOptions(select, "mine");
    expect(screen.queryByText(/TES-4/)).not.toBeInTheDocument();
    expect(chip("TES-3")).toBeInTheDocument();
    expect(setSetting).toHaveBeenLastCalledWith("calendar.filter", JSON.stringify({ scope: "mine", showDone: false }));

    await user.click(screen.getByRole("checkbox", { name: "Tampilkan yang selesai" }));
    expect(chip("OPS-1")).toBeInTheDocument();
    expect(setSetting).toHaveBeenLastCalledWith("calendar.filter", JSON.stringify({ scope: "mine", showDone: true }));

    await user.selectOptions(select, "OPS · Operasional");
    expect(screen.queryByText(/TES-3/)).not.toBeInTheDocument();
    expect(chip("OPS-1")).toBeInTheDocument();
    expect(setSetting).toHaveBeenLastCalledWith(
      "calendar.filter",
      JSON.stringify({ scope: { project: "p2" }, showDone: true }),
    );
  });

  it("memulihkan tampilan dan saringan yang tersimpan sebelum memuat", async () => {
    getSetting.mockImplementation(async (key) =>
      key === "calendar.view" ? "week" : key === "calendar.filter" ? JSON.stringify({ scope: "mine", showDone: true }) : null,
    );
    render(<CalendarScreen me={ME} />);
    await screen.findByText(/TES-3/);
    expect(tasksMock.mock.calls[0]).toEqual(["2026-11-23", "2026-11-29"]);
    expect(screen.getByRole("button", { name: "Minggu" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("combobox", { name: "Lihat" })).toHaveValue("mine");
    expect(screen.getByRole("checkbox", { name: "Tampilkan yang selesai" })).toBeChecked();
    expect(screen.queryByText(/TES-4/)).not.toBeInTheDocument();
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("proyek tersimpan yang sudah tidak ada kembali ke Semua proyek", async () => {
    getSetting.mockImplementation(async (key) =>
      key === "calendar.filter" ? JSON.stringify({ scope: { project: "hilang" }, showDone: false }) : null,
    );
    render(<CalendarScreen me={ME} />);
    await screen.findByText(/TES-4/);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Lihat" })).toHaveValue("all"));
  });

  it("pengaturan rusak atau gagal dibaca memakai bawaan", async () => {
    getSetting.mockImplementation(async (key) => {
      if (key === "calendar.view") throw new Error("rusak");
      return "{bukan json";
    });
    render(<CalendarScreen me={ME} />);
    await screen.findByText(/TES-3/);
    expect(tasksMock.mock.calls[0]).toEqual(["2026-10-26", "2026-12-06"]);
    expect(screen.getByRole("combobox", { name: "Lihat" })).toHaveValue("all");
  });
});

describe("CalendarScreen: buka task", () => {
  it("klik chip membuka detail; tutup mengembalikan fokus ke chip dan memuat ulang", async () => {
    const user = userEvent.setup();
    await renderScreen();
    await user.click(chip("TES-3"));
    expect(screen.getByRole("dialog", { name: "Detail task" })).toHaveTextContent("Detail p1/t3");
    const before = tasksMock.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Tutup detail" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(chip("TES-3")).toHaveFocus());
    expect(tasksMock.mock.calls.length).toBeGreaterThan(before);
  });

  it("perubahan di detail memuat ulang kalender", async () => {
    const user = userEvent.setup();
    await renderScreen();
    await user.click(chip("TES-3"));
    const before = tasksMock.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Ubah" }));
    await waitFor(() => expect(tasksMock.mock.calls.length).toBeGreaterThan(before));
  });
});

describe("CalendarScreen: pindah tenggat dengan keyboard", () => {
  it("Alt+Panah kanan memindah satu hari, mengumumkan, dan fokus tetap di chip", async () => {
    await renderScreen();
    chip("TES-3").focus();
    fireEvent.keyDown(chip("TES-3"), { key: "ArrowRight", altKey: true });
    expect(updateMock).toHaveBeenCalledWith("p1", "t3", { due: "2026-11-25" });
    expect(dayOf("TES-3")).toBe("2026-11-25");
    await waitFor(() => expect(status()).toHaveTextContent("Tenggat TES-3 dipindah ke Rabu, 25 November 2026."));
    expect(chip("TES-3")).toHaveFocus();
  });

  it("Alt+Panah bawah memindah satu minggu, Alt+Panah atas mundur satu minggu", async () => {
    await renderScreen();
    fireEvent.keyDown(chip("TES-3"), { key: "ArrowDown", altKey: true });
    expect(updateMock).toHaveBeenLastCalledWith("p1", "t3", { due: "2026-12-01" });
    await waitFor(() => expect(dayOf("TES-3")).toBe("2026-12-01"));
    fireEvent.keyDown(chip("TES-3"), { key: "ArrowUp", altKey: true });
    expect(updateMock).toHaveBeenLastCalledWith("p1", "t3", { due: "2026-11-24" });
  });

  it("tanpa hak: diumumkan dan tidak memanggil inti", async () => {
    await renderScreen();
    fireEvent.keyDown(chip("TES-4"), { key: "ArrowLeft", altKey: true });
    expect(updateMock).not.toHaveBeenCalled();
    await waitFor(() => expect(status()).toHaveTextContent("Anda tidak berhak mengubah tenggat task ini."));
  });

  it("panah tanpa Alt tidak memindah", async () => {
    await renderScreen();
    fireEvent.keyDown(chip("TES-3"), { key: "ArrowRight" });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("gagal menyimpan mengembalikan tenggat dan menampilkan error", async () => {
    updateMock.mockRejectedValueOnce({ code: "forbidden", message: "Ditolak inti." });
    await renderScreen();
    fireEvent.keyDown(chip("TES-3"), { key: "ArrowRight", altKey: true });
    expect(await screen.findByText("Tenggat TES-3 belum berubah")).toBeInTheDocument();
    expect(screen.getByText("Ditolak inti.")).toBeInTheDocument();
    await waitFor(() => expect(dayOf("TES-3")).toBe("2026-11-24"));
  });
});

describe("CalendarScreen: menu klik kanan", () => {
  // Dicari di dalam menu saja: pencarian peran di seluruh grid lambat di jsdom.
  function item(name: string): HTMLElement {
    const menu = document.querySelector<HTMLElement>("[role=menu]");
    if (!menu) throw new Error("menu tidak terbuka");
    return within(menu).getByRole("menuitem", { name });
  }

  it("berisi pilihan tenggat dan Buka task; tanggal yang sama nonaktif dengan alasan", async () => {
    const user = userEvent.setup();
    await renderScreen();
    fireEvent.contextMenu(chip("TES-3"), { button: 2, clientX: 5, clientY: 5 });
    const menu = screen.getByRole("menu", { name: "Pindahkan tenggat TES-3 ke" });
    const names = within(menu)
      .getAllByRole("menuitem")
      .map((el) => el.getAttribute("aria-labelledby") && document.getElementById(el.getAttribute("aria-labelledby")!)?.textContent);
    expect(names).toEqual([
      "Hari ini",
      "Besok",
      "Senin depan",
      "Satu hari lebih awal",
      "Satu hari lebih lambat",
      "Hapus tenggat",
      "Buka task",
    ]);
    expect(within(menu).getAllByRole("separator")).toHaveLength(2);
    expect(item("Hari ini")).toHaveAttribute("aria-disabled", "true");
    expect(item("Hari ini")).toHaveAccessibleDescription("Tenggat sudah di tanggal ini");
    await user.click(item("Senin depan"));
    expect(updateMock).toHaveBeenCalledWith("p1", "t3", { due: "2026-11-30" });
  });

  it("Besok dan Hapus tenggat memanggil inti", async () => {
    const user = userEvent.setup();
    await renderScreen();
    fireEvent.contextMenu(chip("TES-3"), { button: 2, clientX: 5, clientY: 5 });
    await user.click(item("Besok"));
    expect(updateMock).toHaveBeenLastCalledWith("p1", "t3", { due: "2026-11-25" });
    await waitFor(() => expect(dayOf("TES-3")).toBe("2026-11-25"));
    fireEvent.contextMenu(chip("TES-3"), { button: 2, clientX: 5, clientY: 5 });
    await user.click(item("Hapus tenggat"));
    expect(updateMock).toHaveBeenLastCalledWith("p1", "t3", { due: null });
    await waitFor(() => expect(document.querySelector('[data-cal-task="p1/t3"]')).toBeNull());
    await waitFor(() => expect(status()).toHaveTextContent("Tenggat TES-3 dihapus."));
  });

  it("tanpa hak: pilihan tenggat nonaktif dengan alasan, Buka task tetap jalan", async () => {
    const user = userEvent.setup();
    await renderScreen();
    chip("TES-4").focus();
    fireEvent.keyDown(chip("TES-4"), { key: "F10", shiftKey: true });
    screen.getByRole("menu", { name: "Pindahkan tenggat TES-4 ke" });
    for (const name of ["Hari ini", "Besok", "Senin depan", "Satu hari lebih awal", "Satu hari lebih lambat", "Hapus tenggat"]) {
      expect(item(name)).toHaveAttribute("aria-disabled", "true");
      expect(item(name)).toHaveAccessibleDescription("Anda tidak berhak mengubah task ini");
    }
    await user.click(item("Buka task"));
    expect(screen.getByRole("dialog", { name: "Detail task" })).toHaveTextContent("Detail p1/t4");
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("tombol Menu membuka menu yang sama", async () => {
    await renderScreen();
    chip("TES-3").focus();
    fireEvent.keyDown(chip("TES-3"), { key: "ContextMenu" });
    expect(screen.getByRole("menu", { name: "Pindahkan tenggat TES-3 ke" })).toBeInTheDocument();
  });
});

describe("CalendarScreen: seret chip", () => {
  const MOUSE = { pointerType: "mouse", isPrimary: true };
  let target: string | null = null;
  const original = document.elementFromPoint;

  beforeEach(() => {
    target = null;
    document.elementFromPoint = vi.fn(() =>
      target ? document.querySelector<HTMLElement>(`[data-cal-day="${target}"]`) : null,
    ) as typeof document.elementFromPoint;
  });

  afterEach(() => {
    document.elementFromPoint = original;
  });

  it("lepas di hari lain memindah tenggat sekali dan klik sesudahnya ditelan", async () => {
    await renderScreen();
    fireEvent.pointerDown(chip("TES-3"), { ...MOUSE, button: 0, buttons: 1, pointerId: 1, clientX: 10, clientY: 10 });
    target = "2026-11-27";
    fireEvent.pointerMove(window, { ...MOUSE, buttons: 1, pointerId: 1, clientX: 80, clientY: 60 });
    await waitFor(() => expect(screen.getByTestId("view-month")).toHaveAttribute("data-drop-day", "2026-11-27"));
    expect(chip("TES-3")).toHaveAttribute("data-dragging", "true");
    fireEvent.pointerUp(window, { ...MOUSE, button: 0, pointerId: 1, clientX: 80, clientY: 60 });
    fireEvent.click(chip("TES-3"));
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith("p1", "t3", { due: "2026-11-27" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(status()).toHaveTextContent("Tenggat TES-3 dipindah ke Jumat, 27 November 2026."));
    expect(document.querySelector(".cal-ghost")).toBeNull();
  });

  it("Esc membatalkan seret", async () => {
    await renderScreen();
    fireEvent.pointerDown(chip("TES-3"), { ...MOUSE, button: 0, buttons: 1, pointerId: 1, clientX: 10, clientY: 10 });
    target = "2026-11-27";
    fireEvent.pointerMove(window, { ...MOUSE, buttons: 1, pointerId: 1, clientX: 80, clientY: 60 });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(window, { ...MOUSE, button: 0, pointerId: 1, clientX: 80, clientY: 60 });
    expect(updateMock).not.toHaveBeenCalled();
    expect(dayOf("TES-3")).toBe("2026-11-24");
  });

  it("lepas di hari yang sama tidak mengubah apa pun", async () => {
    await renderScreen();
    fireEvent.pointerDown(chip("TES-3"), { ...MOUSE, button: 0, buttons: 1, pointerId: 1, clientX: 10, clientY: 10 });
    target = "2026-11-24";
    fireEvent.pointerMove(window, { ...MOUSE, buttons: 1, pointerId: 1, clientX: 40, clientY: 40 });
    fireEvent.pointerUp(window, { ...MOUSE, button: 0, pointerId: 1, clientX: 40, clientY: 40 });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("chip tanpa hak tidak bisa diseret, klik biasa tetap membuka", async () => {
    await renderScreen();
    const el = chip("TES-4");
    fireEvent.pointerDown(el, { ...MOUSE, button: 0, buttons: 1, pointerId: 1, clientX: 10, clientY: 10 });
    target = "2026-11-27";
    fireEvent.pointerMove(window, { ...MOUSE, buttons: 1, pointerId: 1, clientX: 80, clientY: 60 });
    fireEvent.pointerUp(window, { ...MOUSE, button: 0, pointerId: 1, clientX: 80, clientY: 60 });
    expect(updateMock).not.toHaveBeenCalled();
    expect(chip("TES-4")).not.toHaveAttribute("data-dragging");
    fireEvent.click(el);
    expect(screen.getByRole("dialog", { name: "Detail task" })).toHaveTextContent("Detail p1/t4");
  });

  it("gerak di bawah ambang tetap klik biasa", async () => {
    await renderScreen();
    const el = chip("TES-3");
    fireEvent.pointerDown(el, { ...MOUSE, button: 0, buttons: 1, pointerId: 1, clientX: 10, clientY: 10 });
    target = "2026-11-27";
    fireEvent.pointerMove(window, { ...MOUSE, buttons: 1, pointerId: 1, clientX: 12, clientY: 11 });
    fireEvent.pointerUp(window, { ...MOUSE, button: 0, pointerId: 1, clientX: 12, clientY: 11 });
    fireEvent.click(el);
    expect(updateMock).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Detail task" })).toBeInTheDocument();
  });
});

describe("CalendarScreen: memuat dan error", () => {
  it("error tanpa data menampilkan ErrorAlert dengan Coba lagi", async () => {
    const user = userEvent.setup();
    tasksMock.mockRejectedValueOnce({ code: "io", message: "Disk penuh." });
    render(<CalendarScreen me={ME} />);
    expect(await screen.findByText("Task kalender belum terbaca")).toBeInTheDocument();
    expect(screen.getByText("Disk penuh.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Coba lagi" }));
    expect(await screen.findByText(/TES-3/)).toBeInTheDocument();
    expect(screen.queryByText("Task kalender belum terbaca")).not.toBeInTheDocument();
  });

  it("selama memuat ada status dan grid tetap tampil", async () => {
    let release: (v: CalTask[]) => void = () => {};
    tasksMock.mockImplementationOnce(() => new Promise((r) => (release = r)));
    render(<CalendarScreen me={ME} />);
    expect(await screen.findByText("Memuat task...")).toBeInTheDocument();
    expect(screen.getByTestId("view-month")).toBeInTheDocument();
    await waitFor(() => expect(tasksMock).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Memuat task...")).toBeInTheDocument();
    await act(async () => release([T_MINE]));
    await waitFor(() => expect(screen.queryByText("Memuat task...")).not.toBeInTheDocument());
  });
});
