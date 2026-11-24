import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDetail, TimeEntry } from "../../api/board";
import { TimerMini } from "./TimerMini";

const board = vi.hoisted(() => ({
  startTimer: vi.fn(),
  stopTimer: vi.fn(),
  logTime: vi.fn(),
  deleteTimeEntry: vi.fn(),
}));

vi.mock("../../api/board", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/board")>()),
  boardApi: board,
}));

const ME = "a".repeat(64);
const P = "1".repeat(32);
const T = "2".repeat(32);
const NOW = new Date("2026-11-23T03:05:00Z");
const anda = { publicKey: ME, name: "Penguji Satu" };

function entry(extra: Partial<TimeEntry> = {}): TimeEntry {
  return {
    id: "e-run",
    person: anda,
    start: "2026-11-23T02:23:00Z",
    end: null,
    manual: false,
    note: "",
    secs: 0,
    mine: true,
    ...extra,
  };
}

function task(extra: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: T,
    code: "PA-12",
    title: "Gambar denah",
    columnId: "doing",
    assignee: null,
    due: null,
    priority: "none",
    labels: [],
    commentCount: 0,
    merged: false,
    subtaskDone: 0,
    subtaskTotal: 0,
    trackedSecs: 0,
    timersRunningSince: [],
    projectId: P,
    description: "",
    createdBy: anda,
    createdAt: "2026-11-20T02:00:00Z",
    updatedAt: "2026-11-23T02:00:00Z",
    comments: [],
    activity: [],
    canEdit: true,
    canDelete: true,
    canComment: true,
    subtasks: [],
    timeEntries: [],
    timeTotals: [],
    myRunningEntry: null,
    statusTime: {
      closedSecs: { todo: 0, doing: 0, done: 0 },
      currentColumn: "doing",
      currentSince: "2026-11-23T01:00:00Z",
      cycleSecs: null,
      clockWarning: false,
    },
    ...extra,
  };
}

function runningTask(start = "2026-11-23T02:23:00Z"): TaskDetail {
  return task({
    timeEntries: [entry({ start })],
    timeTotals: [{ person: anda, secs: 0, runningSince: start }],
    timersRunningSince: [start],
    myRunningEntry: "e-run",
  });
}

function setup(t: TaskDetail, canEdit = true) {
  const onChange = vi.fn();
  const onError = vi.fn();
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const view = render(<TimerMini task={t} me={ME} canEdit={canEdit} onChange={onChange} onError={onError} />);
  return { onChange, onError, user, ...view };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  Object.values(board).forEach((f) => f.mockReset());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TimerMini", () => {
  it("Mulai timer memanggil inti, meneruskan hasil, dan mengumumkan singkat", async () => {
    const next = runningTask("2026-11-23T03:05:00Z");
    board.startTimer.mockResolvedValue(next);
    const { user, onChange, rerender } = setup(task());

    await user.click(screen.getByRole("button", { name: "Mulai timer" }));

    expect(board.startTimer).toHaveBeenCalledWith(P, T);
    expect(onChange).toHaveBeenCalledWith(next);
    rerender(<TimerMini task={next} me={ME} canEdit onChange={onChange} onError={vi.fn()} />);
    // Pengumuman cukup "Timer berjalan.", tanpa kalimat soal timer lain.
    expect(await screen.findByText("Timer berjalan.")).toHaveAttribute("role", "status");
    expect(screen.getByRole("button", { name: "Hentikan timer" })).toBeInTheDocument();
  });

  it("tombol Mulai menjelaskan timer lain di proyek yang sama lewat deskripsi, bukan pengumuman", () => {
    setup(task());
    const start = screen.getByRole("button", { name: "Mulai timer" });
    expect(start).toHaveAccessibleDescription(
      "Timer Anda yang masih berjalan di task lain dalam proyek ini akan dihentikan.",
    );
    expect(start).toHaveAttribute("title", expect.stringMatching(/task lain dalam proyek ini/));
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("jam berjalan tidak dibacakan tiap detik, hanya teks tetap untuk pembaca layar", async () => {
    setup(runningTask());
    const group = screen.getByRole("group", { name: "Timer Anda" });
    // 02:23 sampai 03:05 = 42 menit.
    const clock = within(group).getByText("00:42:00");
    expect(clock).toHaveAttribute("aria-hidden", "true");
    expect(within(group).getByText(/Timer Anda berjalan sejak/)).toHaveClass("sr-only");

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(within(group).getByText("00:42:10")).toBeInTheDocument();
    // Wilayah live tetap kosong selama jam berjalan.
    expect(within(group).getByRole("status")).toHaveTextContent("");
  });

  it("Hentikan timer membuka kotak catatan; Enter menyimpan catatan dan menghentikan timer", async () => {
    const stopped = task({
      timeEntries: [entry({ end: "2026-11-23T03:05:00Z", secs: 42 * 60, note: "Denah lantai 2" })],
      timeTotals: [{ person: anda, secs: 42 * 60, runningSince: null }],
    });
    board.stopTimer.mockResolvedValue(stopped);
    const { user, onChange } = setup(runningTask());

    const stop = screen.getByRole("button", { name: "Hentikan timer" });
    expect(stop).toHaveAttribute("aria-expanded", "false");
    await user.click(stop);
    const box = screen.getByRole("dialog", { name: "Hentikan timer" });
    expect(stop).toHaveAttribute("aria-expanded", "true");
    const note = within(box).getByLabelText("Catatan sesi ini (opsional)");
    expect(note).toHaveFocus();

    await user.type(note, "  Denah lantai 2  {Enter}");

    expect(board.stopTimer).toHaveBeenCalledWith(P, T, "Denah lantai 2");
    expect(onChange).toHaveBeenCalledWith(stopped);
    expect(await screen.findByText("Timer berhenti. 42 menit dicatat.")).toBeInTheDocument();
  });

  it("Hentikan tanpa catatan mengirim null walau kolom catatan terisi", async () => {
    board.stopTimer.mockResolvedValue(task());
    const { user } = setup(runningTask());

    await user.click(screen.getByRole("button", { name: "Hentikan timer" }));
    expect(screen.getByRole("button", { name: "Simpan dan hentikan" })).toHaveAttribute("type", "submit");
    await user.type(screen.getByLabelText("Catatan sesi ini (opsional)"), "tidak dipakai");
    await user.click(screen.getByRole("button", { name: "Hentikan tanpa catatan" }));

    expect(board.stopTimer).toHaveBeenCalledWith(P, T, null);
  });

  it("kotak catatan ditandai data-unsaved hanya selama catatannya berisi", async () => {
    const { user } = setup(runningTask());
    await user.click(screen.getByRole("button", { name: "Hentikan timer" }));
    const box = screen.getByRole("dialog", { name: "Hentikan timer" });
    expect(box).toHaveAttribute("data-escape-local");
    expect(box).not.toHaveAttribute("data-unsaved");

    const note = within(box).getByLabelText("Catatan sesi ini (opsional)");
    await user.type(note, "   ");
    expect(box).not.toHaveAttribute("data-unsaved");
    await user.type(note, "Denah");
    expect(box).toHaveAttribute("data-unsaved", "true");
    await user.clear(note);
    expect(box).not.toHaveAttribute("data-unsaved");
  });

  it("Escape menutup kotak catatan tanpa menghentikan timer dan mengembalikan fokus ke Hentikan timer", async () => {
    const { user } = setup(runningTask());
    const stop = screen.getByRole("button", { name: "Hentikan timer" });

    await user.click(stop);
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "Hentikan timer" })).not.toBeInTheDocument();
    expect(board.stopTimer).not.toHaveBeenCalled();
    expect(stop).toHaveFocus();
  });

  it("Escape di kotak catatan tidak sampai ke pendengar Escape di document (dialog detail task)", async () => {
    const outer = vi.fn();
    document.addEventListener("keydown", outer, true);
    try {
      const { user } = setup(runningTask());
      await user.click(screen.getByRole("button", { name: "Hentikan timer" }));
      await user.keyboard("{Escape}");
      expect(outer).not.toHaveBeenCalledWith(expect.objectContaining({ key: "Escape" }));
    } finally {
      document.removeEventListener("keydown", outer, true);
    }
  });

  it("timer lebih dari 12 jam ditandai Lupa dihentikan?", () => {
    setup(runningTask("2026-11-22T14:00:00Z"));
    expect(screen.getByText("Lupa dihentikan?")).toBeInTheDocument();
  });

  it("Tamu hanya melihat: tanpa Mulai timer dan tanpa Hentikan timer", () => {
    const { unmount } = setup(task(), false);
    expect(screen.queryByRole("button", { name: "Mulai timer" })).not.toBeInTheDocument();
    unmount();

    setup(runningTask(), false);
    expect(screen.getByText("00:42:00")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Hentikan timer" })).not.toBeInTheDocument();
  });

  describe("kolom berbingkai (desain A)", () => {
    it("Mulai dan Hentikan tetap tombol; jam berjalan teks biasa tanpa bingkai", () => {
      const { unmount } = setup(task());
      expect(screen.getByRole("button", { name: "Mulai timer" })).toHaveClass("btn");
      unmount();

      setup(runningTask());
      expect(screen.getByRole("button", { name: "Hentikan timer" })).toHaveClass("btn");
      const clock = screen.getByText("00:42:00");
      expect(clock.tagName).toBe("SPAN");
      expect(clock).not.toHaveClass("td-box");
      expect(document.querySelectorAll(".td-box")).toHaveLength(0);
    });

    it("catatan saat menghentikan timer berbingkai, tombolnya tetap tombol", async () => {
      const { user } = setup(runningTask());
      await user.click(screen.getByRole("button", { name: "Hentikan timer" }));
      const box = screen.getByRole("dialog", { name: "Hentikan timer" });
      expect(within(box).getByLabelText("Catatan sesi ini (opsional)")).toHaveClass("td-input", "td-box", "td-box-text");
      for (const name of ["Simpan dan hentikan", "Hentikan tanpa catatan"]) {
        const b = within(box).getByRole("button", { name });
        expect(b).toHaveClass("btn");
        expect(b).not.toHaveClass("td-box");
      }
    });

    it("tanpa hak ubah: jam tetap tampil, tanpa bingkai dan tanpa tombol", () => {
      setup(runningTask(), false);
      expect(screen.getByText("00:42:00")).toBeInTheDocument();
      expect(document.querySelectorAll(".td-box, input")).toHaveLength(0);
      expect(screen.queryAllByRole("button")).toHaveLength(0);
    });
  });

  it("error dari inti diteruskan ke onError", async () => {
    board.startTimer.mockRejectedValue({ code: "forbidden", message: "Anda tidak bisa mengubah task ini." });
    const { user, onError, onChange } = setup(task());

    await user.click(screen.getByRole("button", { name: "Mulai timer" }));

    expect(onError).toHaveBeenCalledWith("Anda tidak bisa mengubah task ini.");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("error saat menghentikan membiarkan kotak catatan tetap terbuka", async () => {
    board.stopTimer.mockRejectedValue({ code: "io", message: "Gagal menyimpan." });
    const { user, onError } = setup(runningTask());

    await user.click(screen.getByRole("button", { name: "Hentikan timer" }));
    await user.type(screen.getByLabelText("Catatan sesi ini (opsional)"), "catatan{Enter}");

    expect(onError).toHaveBeenCalledWith("Gagal menyimpan.");
    expect(screen.getByLabelText("Catatan sesi ini (opsional)")).toHaveValue("catatan");
  });
});
