import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boardApi, subscribeBoard } from "../../api/board";
import { calendarApi, type CalTask } from "../../api/calendar";
import { PROJECTS, T_DONE, T_LATE, T_LATE_DONE, T_LOCKED, T_MINE } from "./calendarTestKit";
import { useCalendarData } from "./useCalendarData";

vi.mock("../../api/calendar", () => ({ calendarApi: { tasks: vi.fn() } }));
vi.mock("../../api/board", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../api/board")>();
  return { ...real, boardApi: { listProjects: vi.fn(), updateTask: vi.fn() }, subscribeBoard: vi.fn() };
});

const tasksMock = vi.mocked(calendarApi.tasks);
const projectsMock = vi.mocked(boardApi.listProjects);
let handlers: (() => void)[] = [];

type Pending = { from: string | null; to: string | null; resolve: (v: CalTask[]) => void; reject: (e: unknown) => void };
let pending: Pending[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 24, 10, 0, 0));
  pending = [];
  handlers = [];
  tasksMock.mockReset();
  tasksMock.mockImplementation(
    (from, to) => new Promise<CalTask[]>((resolve, reject) => pending.push({ from, to, resolve, reject })),
  );
  projectsMock.mockReset();
  projectsMock.mockResolvedValue(PROJECTS);
  vi.mocked(subscribeBoard).mockImplementation((h) => {
    handlers.push(h);
    return () => {
      handlers = handlers.filter((x) => x !== h);
    };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useCalendarData", () => {
  it("jawaban lama yang datang belakangan diabaikan", async () => {
    const { result, rerender } = renderHook(({ anchor }) => useCalendarData("week", anchor), {
      initialProps: { anchor: "2026-11-24" },
    });
    expect(pending.map((p) => [p.from, p.to])).toEqual([["2026-11-23", "2026-11-29"]]);
    rerender({ anchor: "2026-12-01" });
    expect(pending[1]).toMatchObject({ from: "2026-11-30", to: "2026-12-06" });
    await act(async () => pending[1].resolve([]));
    await act(async () => pending[0].resolve([T_MINE]));
    expect(result.current.tasks).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it("data lama tetap ada selama rentang baru dimuat", async () => {
    const { result, rerender } = renderHook(({ anchor }) => useCalendarData("week", anchor), {
      initialProps: { anchor: "2026-11-24" },
    });
    await act(async () => pending[0].resolve([T_MINE]));
    rerender({ anchor: "2026-12-01" });
    expect(result.current.loading).toBe(true);
    expect(result.current.tasks).toEqual([T_MINE]);
  });

  it("Agenda yang memuat hari ini juga mengambil task belum selesai sebelum rentang", async () => {
    const { result } = renderHook(() => useCalendarData("agenda", "2026-11-10"));
    expect(pending.map((p) => [p.from, p.to])).toEqual([
      ["2026-11-01", "2026-11-30"],
      [null, "2026-10-31"],
    ]);
    await act(async () => {
      pending[0].resolve([T_MINE, T_DONE]);
      pending[1].resolve([T_LATE, T_LATE_DONE]);
    });
    expect(result.current.tasks).toEqual([T_MINE, T_DONE]);
    expect(result.current.overdue).toEqual([T_LATE]);
  });

  it("muat ulang saat board berubah dan memuat daftar proyek", async () => {
    const { result } = renderHook(() => useCalendarData("month", "2026-11-24"));
    await act(async () => pending[0].resolve([T_MINE]));
    await waitFor(() => expect(result.current.projects).toEqual(PROJECTS));
    await act(async () => handlers.forEach((h) => h()));
    expect(pending).toHaveLength(2);
    expect(projectsMock).toHaveBeenCalledTimes(2);
  });

  it("patchDue memindah task secara optimistis, termasuk dari grup lewat tenggat", async () => {
    const { result } = renderHook(() => useCalendarData("agenda", "2026-11-24"));
    await act(async () => {
      pending[0].resolve([T_MINE, T_LOCKED]);
      pending[1].resolve([T_LATE]);
    });
    act(() => result.current.patchDue("p2/o2", "2026-11-28"));
    expect(result.current.overdue).toEqual([]);
    expect(result.current.tasks.find((t) => t.task.id === "o2")?.task.due).toBe("2026-11-28");
    act(() => result.current.patchDue("p1/t3", null));
    expect(result.current.tasks.some((t) => t.task.id === "t3")).toBe(false);
  });

  it("error disimpan, data lama tetap", async () => {
    const { result } = renderHook(() => useCalendarData("week", "2026-11-24"));
    await act(async () => pending[0].resolve([T_MINE]));
    act(() => result.current.reload());
    await act(async () => pending[1].reject({ code: "io", message: "Disk penuh." }));
    expect(result.current.error?.message).toBe("Disk penuh.");
    expect(result.current.tasks).toEqual([T_MINE]);
  });

  it("enabled false tidak memuat apa pun", () => {
    renderHook(() => useCalendarData("month", "2026-11-24", false));
    expect(tasksMock).not.toHaveBeenCalled();
  });
});
