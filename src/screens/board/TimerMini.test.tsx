import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDetail, TimeEntry } from "../../api/board";
import { setLang } from "../../i18n/core";
import { renderInLang } from "../../test/i18n";
import { TimerMini } from "./TimerMini";

const board = vi.hoisted(() => ({
  startTimer: vi.fn(),
  stopTimer: vi.fn(),
  logTime: vi.fn(),
  deleteTimeEntry: vi.fn(),
}));

// Pemberitahuan jeda otomatis (timerNoticeStore). Tes mengisi notice.text lalu render ulang.
const notice = vi.hoisted(() => ({ text: "" }));
vi.mock("./timerNoticeStore", () => ({ useTimerNoticeAnnouncement: () => notice.text }));

vi.mock("../../api/board", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/board")>()),
  boardApi: board,
}));

const ME = "a".repeat(64);
const P = "1".repeat(32);
const T = "2".repeat(32);
const NOW = new Date("2026-11-23T03:05:00Z");
const anda = { publicKey: ME, name: "Penguji Satu" };
const sari = { publicKey: "b".repeat(64), name: "Sari Uji" };

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

// Segmen timer saya yang sudah berhenti.
function segment(id: string, start: string, end: string, extra: Partial<TimeEntry> = {}): TimeEntry {
  return entry({ id, start, end, secs: (Date.parse(end) - Date.parse(start)) / 1000, ...extra });
}

// Dua segmen: 01:00 sampai 01:30 dan 02:00 sampai 02:50 = 1 jam 20 menit.
const SEG_A = segment("e-a", "2026-11-23T01:00:00Z", "2026-11-23T01:30:00Z");
const SEG_B = segment("e-b", "2026-11-23T02:00:00Z", "2026-11-23T02:50:00Z");

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

// Timer saya berjalan sejak `start`, dengan segmen lama `earlier`.
function runningTask(start = "2026-11-23T02:23:00Z", earlier: TimeEntry[] = []): TaskDetail {
  const closed = earlier.reduce((sum, e) => sum + e.secs, 0);
  return task({
    timeEntries: [entry({ start }), ...earlier],
    timeTotals: [{ person: anda, secs: closed, runningSince: start }],
    trackedSecs: closed,
    timersRunningSince: [start],
    myRunningEntry: "e-run",
  });
}

function pausedTask(entries: TimeEntry[] = [SEG_B, SEG_A]): TaskDetail {
  const secs = entries.reduce((sum, e) => sum + e.secs, 0);
  return task({
    timeEntries: entries,
    timeTotals: [{ person: anda, secs, runningSince: null }],
    trackedSecs: secs,
  });
}

function setup(t: TaskDetail, canEdit = true) {
  const onChange = vi.fn();
  const onError = vi.fn();
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const view = render(<TimerMini task={t} me={ME} canEdit={canEdit} onChange={onChange} onError={onError} />);
  return { onChange, onError, user, ...view };
}

// Seperti TaskDetail: hasil onChange dipakai sebagai task berikutnya.
function Host({ initial, onChange }: { initial: TaskDetail; onChange: (t: TaskDetail) => void }) {
  const [t, setT] = useState(initial);
  return (
    <TimerMini
      task={t}
      me={ME}
      canEdit
      onChange={(next) => {
        onChange(next);
        setT(next);
      }}
      onError={() => {}}
    />
  );
}

function setupHost(initial: TaskDetail) {
  const onChange = vi.fn();
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(<Host initial={initial} onChange={onChange} />);
  return { onChange, user };
}

const HINT_ID = "Kalau timer Anda berjalan di task lain, timer itu dijeda.";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  Object.values(board).forEach((f) => f.mockReset());
  notice.text = "";
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TimerMini", () => {
  describe("belum pernah", () => {
    it("Mulai timer memanggil inti, mengumumkan singkat, dan tombol yang sama jadi Jeda dengan fokus tetap", async () => {
      const next = runningTask("2026-11-23T03:05:00Z");
      board.startTimer.mockResolvedValue(next);
      const { user, onChange } = setupHost(task());
      const button = screen.getByRole("button", { name: "Mulai timer" });

      await user.click(button);

      expect(board.startTimer).toHaveBeenCalledWith(P, T);
      expect(onChange).toHaveBeenCalledWith(next);
      expect(await screen.findByText("Timer berjalan.")).toHaveAttribute("role", "status");
      // Elemen yang sama, label berganti; tanpa deskripsi Mulai saat berjalan.
      expect(button).toHaveAccessibleName("Jeda");
      expect(button).toHaveFocus();
      expect(button).not.toHaveAttribute("aria-describedby");
      expect(button).not.toHaveAttribute("title");
    });

    it("tombol Mulai menjelaskan timer lain lewat deskripsi, bukan pengumuman", () => {
      setup(task());
      const start = screen.getByRole("button", { name: "Mulai timer" });
      expect(start).toHaveAccessibleDescription(HINT_ID);
      expect(start).toHaveAttribute("title", HINT_ID);
      for (const region of screen.getAllByRole("status")) expect(region).toHaveTextContent("");
      // Belum pernah: bukan grup timer, tanpa jam, tanpa Dijeda, tanpa total.
      expect(screen.queryByRole("group")).not.toBeInTheDocument();
      expect(screen.queryByText("Dijeda")).not.toBeInTheDocument();
      expect(screen.queryByText("Total Anda")).not.toBeInTheDocument();
    });

    it("hanya catatan manual saya: Mulai timer dengan Total Anda di sampingnya, bukan Dijeda", () => {
      setup(pausedTask([segment("e-m", "2026-11-22T01:00:00Z", "2026-11-22T03:30:00Z", { manual: true })]));
      expect(screen.getByRole("button", { name: "Mulai timer" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Lanjutkan" })).not.toBeInTheDocument();
      expect(screen.queryByText("Dijeda")).not.toBeInTheDocument();
      const group = screen.getByRole("group", { name: "Timer Anda" });
      const shown = within(group).getByText("Total Anda");
      expect(shown).toHaveAttribute("aria-hidden", "true");
      expect(shown).toHaveTextContent("Total Anda2j 30m");
      expect(within(group).getByText("Total Anda 2 jam 30 menit.")).toHaveClass("sr-only");
    });
  });

  describe("berjalan", () => {
    it("jam berjalan tidak dibacakan tiap detik, hanya teks tetap untuk pembaca layar", () => {
      setup(runningTask());
      const group = screen.getByRole("group", { name: "Timer Anda" });
      expect(group).toHaveAttribute("data-running", "true");
      // 02:23 sampai 03:05 = 42 menit.
      const clock = within(group).getByText("00:42:00");
      expect(clock).toHaveAttribute("aria-hidden", "true");
      expect(within(group).getByText(/Timer Anda berjalan sejak/)).toHaveClass("sr-only");

      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(within(group).getByText("00:42:10")).toBeInTheDocument();
      for (const region of within(group).getAllByRole("status")) expect(region).toHaveTextContent("");
    });

    it("jam menunjukkan total saya di task ini, bukan hanya segmen yang berjalan", () => {
      // 1 jam 20 menit sebelumnya ditambah 5 menit berjalan (03:00 sampai 03:05).
      setup(runningTask("2026-11-23T03:00:00Z", [SEG_B, SEG_A]));
      expect(screen.getByText("01:25:00")).toBeInTheDocument();
      // Pembaca layar juga mendapat waktu sebelumnya, sama dengan jam yang menunjukkan total.
      expect(screen.getByText(/Timer Anda berjalan sejak .*\. Sebelumnya tercatat 1 jam 20 menit\.$/)).toHaveClass(
        "sr-only",
      );
    });

    it("tanpa waktu sebelumnya, teks pembaca layar tidak menyebut Sebelumnya tercatat", () => {
      setup(runningTask());
      expect(screen.getByText(/Timer Anda berjalan sejak/)).not.toHaveTextContent("Sebelumnya");
    });

    it("Jeda langsung memanggil stopTimer dengan catatan null, tanpa kotak catatan", async () => {
      const paused = pausedTask([segment("e-run", "2026-11-23T02:23:00Z", "2026-11-23T03:05:00Z")]);
      board.stopTimer.mockResolvedValue(paused);
      const { user, onChange } = setupHost(runningTask());

      const pause = screen.getByRole("button", { name: "Jeda" });
      expect(pause).not.toHaveAttribute("aria-haspopup");
      expect(pause).not.toHaveAttribute("aria-expanded");
      expect(pause).not.toHaveAttribute("aria-describedby");
      await user.click(pause);

      expect(board.stopTimer).toHaveBeenCalledWith(P, T, null);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(onChange).toHaveBeenCalledWith(paused);
      expect(await screen.findByText("Timer dijeda. Total Anda di task ini 42 menit.")).toBeInTheDocument();
      expect(pause).toHaveAccessibleName("Lanjutkan");
      expect(pause).toHaveFocus();
      expect(pause).toHaveAccessibleDescription(HINT_ID);
    });

    it("pengumuman jeda menyebut total semua segmen saya", async () => {
      const last = segment("e-run", "2026-11-23T03:00:00Z", "2026-11-23T03:05:00Z");
      board.stopTimer.mockResolvedValue(pausedTask([last, SEG_B, SEG_A]));
      const { user } = setup(runningTask("2026-11-23T03:00:00Z", [SEG_B, SEG_A]));

      await user.click(screen.getByRole("button", { name: "Jeda" }));

      expect(await screen.findByText("Timer dijeda. Total Anda di task ini 1 jam 25 menit.")).toBeInTheDocument();
    });

    it("segmen berjalan lebih dari 12 jam ditandai Lupa dijeda?", () => {
      setup(runningTask("2026-11-22T14:00:00Z"));
      expect(screen.getByText("Lupa dijeda?")).toBeInTheDocument();
    });

    it("total panjang dengan segmen berjalan yang pendek tidak ditandai lupa", () => {
      const long = segment("e-old", "2026-11-22T00:00:00Z", "2026-11-22T13:00:00Z");
      setup(runningTask("2026-11-23T03:00:00Z", [long]));
      expect(screen.getByText("13:05:00")).toBeInTheDocument();
      expect(screen.queryByText("Lupa dijeda?")).not.toBeInTheDocument();
    });
  });

  describe("dijeda", () => {
    it("menampilkan Dijeda dengan total saya dan tombol Lanjutkan", () => {
      setup(pausedTask());
      const group = screen.getByRole("group", { name: "Timer Anda" });
      expect(group).toHaveAttribute("data-paused", "true");
      expect(group).not.toHaveAttribute("data-running");
      const shown = within(group).getByText("Dijeda");
      expect(shown).toHaveAttribute("aria-hidden", "true");
      expect(shown).toHaveTextContent("Dijeda1j 20m");
      expect(within(group).getByText("Dijeda, total Anda di task ini 1 jam 20 menit.")).toHaveClass("sr-only");
      // Tanpa jam berjalan dan tanpa Jeda.
      expect(within(group).queryByText(/^\d\d:\d\d:\d\d$/)).not.toBeInTheDocument();
      expect(within(group).queryByRole("button", { name: "Jeda" })).not.toBeInTheDocument();

      const resume = within(group).getByRole("button", { name: "Lanjutkan" });
      expect(resume).toHaveAccessibleDescription(HINT_ID);
    });

    it("task di Selesai: Total Anda menggantikan Dijeda, Lanjutkan tetap ada", () => {
      const t = pausedTask();
      setup({ ...t, columnId: "done", statusTime: { ...t.statusTime, currentColumn: "done" } });
      const group = screen.getByRole("group", { name: "Timer Anda" });
      expect(within(group).queryByText("Dijeda")).not.toBeInTheDocument();
      expect(within(group).getByText("Total Anda")).toHaveTextContent("Total Anda1j 20m");
      expect(within(group).getByText("Total Anda 1 jam 20 menit.")).toHaveClass("sr-only");
      expect(group.querySelector(".td-pause")).toBeNull();
      expect(within(group).getByRole("button", { name: "Lanjutkan" })).toBeInTheDocument();
    });

    it("catatan manual ikut dihitung dalam total", () => {
      const manual = segment("e-m", "2026-11-22T01:00:00Z", "2026-11-22T02:00:00Z", { manual: true });
      setup(pausedTask([SEG_B, SEG_A, manual]));
      expect(screen.getByText("Dijeda, total Anda di task ini 2 jam 20 menit.")).toBeInTheDocument();
    });

    it("catatan orang lain tidak ikut dihitung", () => {
      const other = segment("e-s", "2026-11-23T00:00:00Z", "2026-11-23T01:00:00Z", { person: sari, mine: false });
      setup(pausedTask([SEG_B, other, SEG_A]));
      expect(screen.getByText("Dijeda, total Anda di task ini 1 jam 20 menit.")).toBeInTheDocument();
    });

    it("Lanjutkan memanggil startTimer, mengumumkan Timer berjalan lagi, dan fokus tetap di tombol", async () => {
      const next = runningTask("2026-11-23T03:05:00Z", [SEG_B, SEG_A]);
      board.startTimer.mockResolvedValue(next);
      const { user, onChange } = setupHost(pausedTask());
      const button = screen.getByRole("button", { name: "Lanjutkan" });

      await user.click(button);

      expect(board.startTimer).toHaveBeenCalledWith(P, T);
      expect(board.stopTimer).not.toHaveBeenCalled();
      expect(onChange).toHaveBeenCalledWith(next);
      expect(await screen.findByText("Timer berjalan lagi.")).toBeInTheDocument();
      expect(button).toHaveAccessibleName("Jeda");
      expect(button).toHaveFocus();
      // Jam melanjutkan dari total sebelumnya.
      expect(screen.getByText("01:20:00")).toBeInTheDocument();
    });
  });

  it("keadaan berubah dari luar (jeda otomatis): fokus tetap di tombol yang sama", async () => {
    const { user, rerender } = setup(runningTask());
    const button = screen.getByRole("button", { name: "Jeda" });
    await user.tab();
    expect(button).toHaveFocus();

    rerender(<TimerMini task={pausedTask()} me={ME} canEdit onChange={vi.fn()} onError={vi.fn()} />);

    expect(button).toBeInTheDocument();
    expect(button).toHaveAccessibleName("Lanjutkan");
    expect(button).toHaveFocus();
  });

  it("pemberitahuan jeda otomatis dibacakan lewat wilayah status kedua yang selalu ada", () => {
    const { rerender } = setup(task());
    const regions = screen.getAllByRole("status");
    expect(regions).toHaveLength(2);
    expect(regions[1]).toHaveAttribute("aria-live", "polite");
    expect(regions[1]).toHaveTextContent("");

    notice.text = "Timer Anda di PA-3 (Revisi) dijeda karena Anda memulai timer di PA-12.";
    rerender(<TimerMini task={runningTask()} me={ME} canEdit onChange={vi.fn()} onError={vi.fn()} />);

    const after = screen.getAllByRole("status");
    expect(after[1]).toBe(regions[1]);
    expect(after[1]).toHaveTextContent("dijeda karena Anda memulai timer di PA-12");
    expect(after[0]).toHaveTextContent("");
  });

  it("tamu: tanpa tombol apa pun, tapi keadaan berjalan dan dijeda tetap terlihat", () => {
    const first = setup(task(), false);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    first.unmount();

    const second = setup(runningTask(), false);
    expect(screen.getByText("00:42:00")).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    second.unmount();

    setup(pausedTask(), false);
    expect(screen.getByText("Dijeda")).toBeInTheDocument();
    expect(screen.getByText("Dijeda, total Anda di task ini 1 jam 20 menit.")).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("kolom berbingkai (desain A): Mulai, Jeda, Lanjutkan satu bobot tombol; jam dan total teks biasa", () => {
    const a = setup(task());
    expect(screen.getByRole("button", { name: "Mulai timer" })).toHaveClass("btn", "btn-ghost", "btn-sm");
    a.unmount();

    const b = setup(runningTask());
    expect(screen.getByRole("button", { name: "Jeda" })).toHaveClass("btn", "btn-ghost", "btn-sm");
    const clock = screen.getByText("00:42:00");
    expect(clock.tagName).toBe("SPAN");
    expect(clock).not.toHaveClass("td-box");
    b.unmount();

    setup(pausedTask());
    expect(screen.getByRole("button", { name: "Lanjutkan" })).toHaveClass("btn", "btn-ghost", "btn-sm");
    expect(document.querySelectorAll(".td-box, input")).toHaveLength(0);
  });

  describe("sibuk dan galat", () => {
    it("selama Jeda diproses tombolnya aria-busy dan klik kedua diabaikan", async () => {
      let finish: (t: TaskDetail) => void = () => {};
      board.stopTimer.mockReturnValue(new Promise<TaskDetail>((r) => (finish = r)));
      const { user } = setup(runningTask());
      const pause = screen.getByRole("button", { name: "Jeda" });

      await user.click(pause);
      expect(pause).toHaveAttribute("aria-busy", "true");
      expect(pause).toHaveAttribute("aria-disabled", "true");
      await user.click(pause);
      expect(board.stopTimer).toHaveBeenCalledTimes(1);

      await act(async () => finish(pausedTask()));
      expect(pause).not.toHaveAttribute("aria-busy");
    });

    it("error saat memulai diteruskan ke onError", async () => {
      board.startTimer.mockRejectedValue({ code: "forbidden", message: "Anda tidak bisa mengubah task ini." });
      const { user, onError, onChange } = setup(task());

      await user.click(screen.getByRole("button", { name: "Mulai timer" }));

      expect(onError).toHaveBeenCalledWith("Anda tidak bisa mengubah task ini.");
      expect(onChange).not.toHaveBeenCalled();
    });

    it("error saat menjeda diteruskan ke onError dan Jeda tetap ada", async () => {
      board.stopTimer.mockRejectedValue({ code: "io", message: "Gagal menyimpan." });
      const { user, onError, onChange } = setup(runningTask());

      await user.click(screen.getByRole("button", { name: "Jeda" }));

      expect(onError).toHaveBeenCalledWith("Gagal menyimpan.");
      expect(onChange).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Jeda" })).toBeInTheDocument();
    });
  });

  describe("bahasa Inggris", () => {
    afterEach(() => {
      setLang("id");
    });

    function draw(t: TaskDetail) {
      return () => <TimerMini task={t} me={ME} canEdit onChange={vi.fn()} onError={vi.fn()} />;
    }

    it("Start timer, Pause, Paused, dan Resume", () => {
      const a = renderInLang(draw(task()));
      expect(screen.getByRole("button", { name: "Start timer" })).toHaveAccessibleDescription(
        "If your timer is running on another task, it will be paused.",
      );
      a.unmount();

      const b = renderInLang(draw(runningTask()));
      expect(screen.getByRole("group", { name: "Your timer" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
      b.unmount();

      renderInLang(draw(pausedTask()));
      expect(screen.getByText("Paused")).toHaveTextContent("Paused1h 20m");
      expect(screen.getByText("Paused, your total on this task is 1 hour 20 minutes.")).toHaveClass("sr-only");
      expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    });

    it("Your total dan Logged earlier", () => {
      const a = renderInLang(draw(pausedTask([segment("e-m", "2026-11-22T01:00:00Z", "2026-11-22T02:30:00Z", { manual: true })])));
      expect(screen.getByText("Your total")).toHaveTextContent("Your total1h 30m");
      expect(screen.getByRole("button", { name: "Start timer" })).toBeInTheDocument();
      a.unmount();

      renderInLang(draw(runningTask("2026-11-23T03:00:00Z", [SEG_B, SEG_A])));
      expect(screen.getByText(/Logged earlier: 1 hour 20 minutes\.$/)).toHaveClass("sr-only");
    });

    it("pengumuman Pause dan Resume dalam bahasa Inggris", async () => {
      board.stopTimer.mockResolvedValue(pausedTask([segment("e-run", "2026-11-23T02:23:00Z", "2026-11-23T03:05:00Z")]));
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const a = renderInLang(draw(runningTask()));
      await user.click(screen.getByRole("button", { name: "Pause" }));
      expect(await screen.findByText("Timer paused. Your total on this task is 42 minutes.")).toBeInTheDocument();
      a.unmount();

      board.startTimer.mockResolvedValue(runningTask("2026-11-23T03:05:00Z", [SEG_B, SEG_A]));
      renderInLang(draw(pausedTask()));
      await user.click(screen.getByRole("button", { name: "Resume" }));
      expect(await screen.findByText("Timer running again.")).toBeInTheDocument();
    });
  });
});
