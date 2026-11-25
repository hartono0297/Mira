// Layar Kalender dengan tampilan asli (tanpa tampilan tiruan): chip dan sel
// dari MonthView, WeekView, dan AgendaView cocok dengan penangan layar.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api";
import { boardApi, subscribeBoard } from "../../api/board";
import { calendarApi, type CalTask } from "../../api/calendar";
import { CalendarScreen } from "./CalendarScreen";
import { ME, PROJECTS, T_LATE, T_LOCKED, T_MINE } from "./calendarTestKit";

vi.mock("../../api/calendar", () => ({ calendarApi: { tasks: vi.fn() } }));
vi.mock("../../api/board", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../api/board")>();
  return { ...real, boardApi: { listProjects: vi.fn(), updateTask: vi.fn() }, subscribeBoard: vi.fn(() => () => {}) };
});
vi.mock("../../api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../api")>();
  return { ...real, api: { ...real.api, getSetting: vi.fn(), setSetting: vi.fn() } };
});
vi.mock("../board/TaskDetail", () => ({
  TaskDetail: (p: { taskId: string; onClose: () => void }) => (
    <div role="dialog" aria-label="Detail task">
      <button type="button" onClick={p.onClose}>
        Tutup detail {p.taskId}
      </button>
    </div>
  ),
}));

let data: CalTask[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 24, 10, 0, 0));
  data = [T_MINE, T_LOCKED];
  vi.mocked(calendarApi.tasks).mockReset();
  vi.mocked(calendarApi.tasks).mockImplementation(async (from, to) =>
    (from === null ? [T_LATE] : data).filter((t) => t.task.due && (!from || t.task.due >= from) && (!to || t.task.due <= to)),
  );
  vi.mocked(boardApi.updateTask).mockReset();
  vi.mocked(boardApi.updateTask).mockImplementation(async (projectId, taskId, patch) => {
    data = data.map((t) =>
      t.projectId === projectId && t.task.id === taskId ? { ...t, task: { ...t.task, due: patch.due ?? null } } : t,
    );
    return {} as never;
  });
  vi.mocked(boardApi.listProjects).mockResolvedValue(PROJECTS);
  vi.mocked(subscribeBoard).mockImplementation(() => () => {});
  vi.mocked(api.getSetting).mockResolvedValue(null);
  vi.mocked(api.setSetting).mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

function chipEl(key: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-cal-task="${key}"]`);
  if (!el) throw new Error(`chip ${key} tidak ada`);
  return el;
}

describe("CalendarScreen dengan tampilan asli", () => {
  it("Alt+Panah kanan memindah chip ke sel hari berikutnya dan fokus ikut", async () => {
    render(<CalendarScreen me={ME} />);
    await waitFor(() => chipEl("p1/t3"));
    expect(chipEl("p1/t3").closest("[data-cal-day]")).toHaveAttribute("data-cal-day", "2026-11-24");
    chipEl("p1/t3").focus();
    fireEvent.keyDown(chipEl("p1/t3"), { key: "ArrowRight", altKey: true });
    await waitFor(() => expect(chipEl("p1/t3").closest("[data-cal-day]")).toHaveAttribute("data-cal-day", "2026-11-25"));
    expect(boardApi.updateTask).toHaveBeenCalledWith("p1", "t3", { due: "2026-11-25" });
    await waitFor(() => expect(chipEl("p1/t3")).toHaveFocus());
  });

  it("klik chip membuka detail, Minggu dan Agenda tergambar", async () => {
    const user = userEvent.setup();
    render(<CalendarScreen me={ME} />);
    await waitFor(() => chipEl("p1/t4"));
    await user.click(chipEl("p1/t4"));
    expect(screen.getByRole("dialog", { name: "Detail task" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Tutup detail t4" }));
    await user.click(screen.getByRole("button", { name: "Minggu" }));
    await waitFor(() => chipEl("p1/t3"));
    await user.click(screen.getByRole("button", { name: "Agenda" }));
    await waitFor(() => chipEl("p2/o2"));
  });
});
