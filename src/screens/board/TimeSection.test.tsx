import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusTime, TaskDetail, TimeEntry } from "../../api/board";
import { TEKS } from "./teks";
import { setLang } from "../../i18n/core";
import { renderInLang } from "../../test/i18n";
import { TimeSection } from "./TimeSection";

const board = vi.hoisted(() => ({
  startTimer: vi.fn(),
  stopTimer: vi.fn(),
  logTime: vi.fn(),
  deleteTimeEntry: vi.fn(),
}));

// Catat manual dimatikan di aplikasi (timeFeatures.ts). Tes form manual menyalakannya
// lewat flags.manual supaya kodenya tetap teruji.
const flags = vi.hoisted(() => ({ manual: false }));
vi.mock("./timeFeatures", () => ({
  get MANUAL_TIME_LOG() {
    return flags.manual;
  },
}));

vi.mock("../../api/board", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/board")>()),
  boardApi: board,
}));

const ME = "a".repeat(64);
const PK_B = "b".repeat(64);
const P = "1".repeat(32);
const T = "2".repeat(32);
const NOW = new Date("2026-11-23T03:05:00Z");
const anda = { publicKey: ME, name: "Penguji Satu" };
const sari = { publicKey: PK_B, name: "Sari Uji" };

const mineDone: TimeEntry = {
  id: "e-mine",
  person: anda,
  start: "2026-11-22T01:00:00Z",
  end: "2026-11-22T02:00:00Z",
  manual: true,
  note: "Rapat dengan klien",
  secs: 3600,
  mine: true,
};
const sariDone: TimeEntry = {
  id: "e-sari",
  person: sari,
  start: "2026-11-21T01:00:00Z",
  end: "2026-11-21T01:30:00Z",
  manual: false,
  note: "",
  secs: 1800,
  mine: false,
};
// Timer saya berjalan sejak 10 menit lalu.
const mineRunning: TimeEntry = {
  id: "e-run",
  person: anda,
  start: "2026-11-23T02:55:00Z",
  end: null,
  manual: false,
  note: "",
  secs: 0,
  mine: true,
};

function statusTime(extra: Partial<StatusTime> = {}): StatusTime {
  return {
    closedSecs: { todo: 3600, doing: 0, done: 0 },
    currentColumn: "doing",
    currentSince: "2026-11-23T01:05:00Z",
    cycleSecs: null,
    clockWarning: false,
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
    trackedSecs: 5400,
    timersRunningSince: [mineRunning.start],
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
    timeEntries: [mineRunning, mineDone, sariDone],
    timeTotals: [
      { person: anda, secs: 3600, runningSince: mineRunning.start },
      { person: sari, secs: 1800, runningSince: null },
    ],
    myRunningEntry: "e-run",
    statusTime: statusTime(),
    ...extra,
  };
}

function setup(t: TaskDetail, canEdit = true) {
  const onChange = vi.fn();
  const onError = vi.fn();
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const view = render(<TimeSection task={t} me={ME} canEdit={canEdit} onChange={onChange} onError={onError} />);
  return { onChange, onError, user, ...view };
}

// Seperti TaskDetail: hasil onChange dipakai sebagai task berikutnya.
function Host({ initial }: { initial: TaskDetail }) {
  const [t, setT] = useState(initial);
  return <TimeSection task={t} me={ME} canEdit onChange={setT} onError={() => {}} />;
}

function section() {
  return screen.getByRole("region", { name: "Waktu" });
}

function row(listName: string, text: string | RegExp) {
  const list = screen.getByRole("list", { name: listName });
  const item = within(list)
    .getAllByRole("listitem")
    .find((li) => (typeof text === "string" ? li.textContent?.includes(text) : text.test(li.textContent ?? "")));
  if (!item) throw new Error(`Baris ${String(text)} tidak ada di ${listName}`);
  return item;
}

async function openHistory(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText(/^Riwayat catatan waktu/));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  Object.values(board).forEach((f) => f.mockReset());
  flags.manual = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TimeSection", () => {
  it("total task menjumlah catatan berhenti dan timer berjalan, lalu bertambah sendiri", () => {
    setup(task());
    // 3600 + 1800 + 600 berjalan = 1j 40m.
    const head = within(section()).getByRole("heading", { name: "Waktu" }).parentElement!;
    expect(head).toHaveTextContent("Total 1j 40m");
    expect(within(head).getByText("1 jam 40 menit")).toHaveClass("sr-only");

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(head).toHaveTextContent("Total 1j 41m");
    expect(row("Per orang", "Total task")).toHaveTextContent("1j 41m");
  });

  it("per orang: Anda untuk saya, tanda berjalan, urut dari yang terlama", () => {
    setup(task());
    const items = within(screen.getByRole("list", { name: "Per orang" })).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Anda");
    expect(items[0]).toHaveTextContent("berjalan");
    expect(items[0]).toHaveTextContent("1j 10m");
    expect(items[1]).toHaveTextContent("Sari Uji");
    expect(items[1]).not.toHaveTextContent("berjalan");
    expect(items[1]).toHaveTextContent("30m");
  });

  it("per orang: tag dijeda untuk orang yang punya segmen timer dan tidak sedang berjalan", () => {
    setup(task());
    const items = within(screen.getByRole("list", { name: "Per orang" })).getAllByRole("listitem");
    // Saya berjalan: tag berjalan dengan titik, bukan dijeda.
    expect(items[0]).not.toHaveTextContent("dijeda");
    expect(within(items[0]).getByText("berjalan").querySelector(".td-run")).not.toBeNull();
    // Sari punya segmen timer yang sudah berhenti: tag dijeda tanpa titik berjalan.
    const tag = within(items[1]).getByText("dijeda");
    expect(tag).toHaveClass("td-paused-tag");
    expect(tag.querySelector(".td-pause")).toHaveAttribute("aria-hidden", "true");
    expect(tag.querySelector(".td-run")).toBeNull();
  });

  it("per orang: total orang yang dijeda menjumlah semua segmennya", () => {
    const sari2: TimeEntry = {
      ...sariDone,
      id: "e-sari-2",
      start: "2026-11-22T05:00:00Z",
      end: "2026-11-22T05:45:00Z",
      secs: 2700,
    };
    setup(
      task({
        timeEntries: [mineRunning, mineDone, sari2, sariDone],
        timeTotals: [
          { person: anda, secs: 3600, runningSince: mineRunning.start },
          { person: sari, secs: 4500, runningSince: null },
        ],
      }),
    );
    const sariRow = row("Per orang", "Sari Uji");
    expect(sariRow).toHaveTextContent("dijeda");
    expect(sariRow).toHaveTextContent("1j 15m");
    expect(row("Per orang", "Total task")).toHaveTextContent("2j 25m");
  });

  it("per orang: task di Selesai tidak menampilkan tag dijeda", () => {
    setup(
      task({
        columnId: "done",
        timeEntries: [mineDone, sariDone],
        timeTotals: [
          { person: anda, secs: 3600, runningSince: null },
          { person: sari, secs: 1800, runningSince: null },
        ],
        myRunningEntry: null,
        timersRunningSince: [],
        statusTime: statusTime({ currentColumn: "done", currentSince: "2026-11-23T03:00:00Z" }),
      }),
    );
    const list = screen.getByRole("list", { name: "Per orang" });
    expect(within(list).queryByText("dijeda")).not.toBeInTheDocument();
    expect(row("Per orang", "Sari Uji")).toHaveTextContent("30m");
    expect(row("Per orang", "Total task")).toHaveTextContent("1j 30m");
  });

  it("per orang: orang yang hanya punya catatan manual tidak dapat tag", () => {
    setup(
      task({
        timeEntries: [mineDone, { ...sariDone, manual: true }],
        timeTotals: [
          { person: anda, secs: 3600, runningSince: null },
          { person: sari, secs: 1800, runningSince: null },
        ],
        myRunningEntry: null,
        timersRunningSince: [],
      }),
    );
    const list = screen.getByRole("list", { name: "Per orang" });
    expect(within(list).queryByText("dijeda")).not.toBeInTheDocument();
    expect(within(list).queryByText("berjalan")).not.toBeInTheDocument();
    expect(row("Per orang", "Anda")).toHaveTextContent("1j");
    expect(row("Per orang", "Total task")).toHaveTextContent("1j 30m");
  });

  it("per status: durasi live di kolom sekarang, tag sekarang, belum pernah, dan Belum selesai", () => {
    setup(task());
    expect(row("Per status", "To do")).toHaveTextContent("1j");
    const doing = row("Per status", "Dikerjakan");
    expect(doing).toHaveTextContent("sekarang");
    // 01:05 sampai 03:05.
    expect(doing).toHaveTextContent("2j");
    expect(row("Per status", "Selesai")).toHaveTextContent("belum pernah");
    expect(within(section()).getByText("Belum selesai")).toBeInTheDocument();
  });

  it("cycle time tampil setelah task masuk Selesai", () => {
    setup(
      task({
        columnId: "done",
        statusTime: statusTime({
          closedSecs: { todo: 3600, doing: 7200, done: 0 },
          currentColumn: "done",
          currentSince: "2026-11-23T03:00:00Z",
          cycleSecs: 3 * 86400 + 4 * 3600,
        }),
      }),
    );
    expect(within(section()).getByText("Selesai dalam 3hr 4j sejak dibuat")).toBeInTheDocument();
    expect(within(section()).getByText("Selesai dalam 3 hari 4 jam sejak dibuat")).toHaveClass("sr-only");
    expect(row("Per status", "Selesai")).toHaveTextContent("sekarang");
  });

  it("catatan jam laptop hanya tampil saat clockWarning", () => {
    const { unmount } = setup(task());
    expect(screen.queryByText(/Jam di beberapa laptop/)).not.toBeInTheDocument();
    unmount();

    setup(task({ statusTime: statusTime({ clockWarning: true }) }));
    expect(screen.getByText(/Jam di beberapa laptop tampaknya tidak sama/)).toBeInTheDocument();
  });

  it("riwayat: terbaru dulu, berjalan, manual, catatan", async () => {
    const { user } = setup(task());
    await openHistory(user);
    const list = screen.getByRole("list", { name: /^Riwayat catatan waktu/ });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("berjalan");
    expect(rows[0]).toHaveTextContent(/Anda · mulai/);
    expect(rows[1]).toHaveTextContent("1j");
    expect(rows[1]).toHaveTextContent("manual");
    expect(rows[1]).toHaveTextContent("Rapat dengan klien");
    expect(rows[2]).toHaveTextContent("Sari Uji");
  });

  it("hapus catatan sendiri lewat konfirmasi; catatan orang lain tanpa tombol hapus", async () => {
    board.deleteTimeEntry.mockResolvedValue(task({ timeEntries: [mineRunning, sariDone] }));
    const { user, onChange } = setup(task());
    await openHistory(user);
    const list = screen.getByRole("list", { name: /^Riwayat catatan waktu/ });
    const rows = within(list).getAllByRole("listitem");

    expect(within(rows[2]).queryByRole("button")).not.toBeInTheDocument();

    const del = within(rows[1]).getByRole("button", { name: /^Hapus catatan 1 jam, / });
    expect(del).toHaveClass("td-del");
    await user.click(del);
    expect(board.deleteTimeEntry).not.toHaveBeenCalled();
    const confirm = within(rows[1]).getByRole("group", { name: "Hapus catatan ini?" });
    expect(within(confirm).getByRole("button", { name: "Batal" })).toHaveFocus();

    await user.click(within(confirm).getByRole("button", { name: "Hapus" }));
    expect(board.deleteTimeEntry).toHaveBeenCalledWith(P, T, "e-mine");
    expect(onChange).toHaveBeenCalled();
    expect(await screen.findByText("Catatan waktu dihapus.")).toBeInTheDocument();
  });

  it("Batal atau Escape di konfirmasi tidak menghapus dan fokus kembali ke tombol hapus", async () => {
    const { user } = setup(task());
    await openHistory(user);
    const del = screen.getByRole("button", { name: /^Hapus catatan 1 jam, / });

    await user.click(del);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Hapus catatan ini?" })).not.toBeInTheDocument();
    const again = screen.getByRole("button", { name: /^Hapus catatan 1 jam, / });
    await act(async () => {
      vi.advanceTimersByTime(10);
    });
    expect(again).toHaveFocus();

    await user.click(again);
    await user.click(screen.getByRole("button", { name: "Batal" }));
    expect(board.deleteTimeEntry).not.toHaveBeenCalled();
  });

  it("setelah hapus dengan data baru, fokus pindah ke ringkasan riwayat", async () => {
    board.deleteTimeEntry.mockResolvedValue(task({ timeEntries: [mineRunning, sariDone] }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Host initial={task()} />);
    await openHistory(user);
    await user.click(screen.getByRole("button", { name: /^Hapus catatan 1 jam, / }));
    await user.click(screen.getByRole("button", { name: "Hapus" }));

    expect(await screen.findByText("Riwayat catatan waktu (2)")).toHaveFocus();
  });

  it("timer berjalan lebih dari 12 jam ditandai Lupa dijeda?", async () => {
    const old = { ...mineRunning, start: "2026-11-22T13:00:00Z" };
    const { user } = setup(task({ timeEntries: [old], timeTotals: [{ person: anda, secs: 0, runningSince: old.start }] }));
    await openHistory(user);
    expect(screen.getByText("Lupa dijeda?")).toBeInTheDocument();
  });

  it("Tamu hanya membaca: tanpa catat manual dan tanpa hapus", async () => {
    const { user } = setup(task({ canEdit: false }), false);
    expect(screen.queryByRole("button", { name: "Catat waktu manual" })).not.toBeInTheDocument();
    expect(row("Per orang", "Total task")).toHaveTextContent("1j 40m");
    await openHistory(user);
    expect(screen.queryByRole("button", { name: /^Hapus catatan/ })).not.toBeInTheDocument();
  });

  it("belum ada catatan: teks kosong per orang dan tanpa riwayat", () => {
    setup(task({ timeEntries: [], timeTotals: [], myRunningEntry: null, timersRunningSince: [], trackedSecs: 0 }));
    expect(screen.getByText("Belum ada waktu tercatat.")).toBeInTheDocument();
    expect(screen.queryByText(/^Riwayat catatan waktu/)).not.toBeInTheDocument();
    expect(row("Per orang", "Total task")).toHaveTextContent("0m");
  });

  describe("kolom berbingkai (desain A)", () => {

    it("ringkasan waktu adalah hasil hitung: teks biasa tanpa bingkai", async () => {
      const { user } = setup(task());
      await openHistory(user);
      expect(section().querySelectorAll(".td-box")).toHaveLength(0);
      const total = row("Per orang", "Total task").querySelector(".v")!;
      expect(total).toHaveTextContent("1j 40m");
      expect(total.tagName).toBe("SPAN");
      expect(row("Per status", "Dikerjakan").querySelector(".v")).not.toHaveClass("td-box");
      // Hapus catatan sendiri tetap tombol ikon.
      expect(screen.getByRole("button", { name: /^Hapus catatan 1 jam, / })).toHaveClass("td-del");
    });

    it("tanpa hak ubah: tidak ada bingkai dan tidak ada tombol aksi", async () => {
      const { user } = setup(task({ canEdit: false }), false);
      await openHistory(user);
      expect(section().querySelectorAll(".td-box, input, textarea")).toHaveLength(0);
      expect(within(section()).queryAllByRole("button")).toHaveLength(0);
    });
  });

  describe("catat waktu manual dimatikan (MANUAL_TIME_LOG false)", () => {
    it("tombol dan form Catat waktu manual tidak dirender", () => {
      setup(task());
      expect(screen.queryByRole("button", { name: "Catat waktu manual" })).not.toBeInTheDocument();
      expect(screen.queryByRole("form", { name: "Catat waktu manual" })).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Durasi")).not.toBeInTheDocument();
    });

    it("catatan manual lama tetap tampil, dihitung, dan bisa dihapus pemiliknya", async () => {
      board.deleteTimeEntry.mockResolvedValue(task({ timeEntries: [mineRunning, sariDone] }));
      const { user } = setup(task());
      // Manual 1 jam ikut di total saya: 1 jam ditambah 10 menit berjalan.
      expect(row("Per orang", "Anda")).toHaveTextContent("1j 10m");
      await openHistory(user);
      const rows = within(screen.getByRole("list", { name: /^Riwayat catatan waktu/ })).getAllByRole("listitem");
      expect(rows[1]).toHaveTextContent("manual");
      await user.click(within(rows[1]).getByRole("button", { name: /^Hapus catatan 1 jam, / }));
      await user.click(screen.getByRole("button", { name: "Hapus" }));
      expect(board.deleteTimeEntry).toHaveBeenCalledWith(P, T, "e-mine");
    });

    it("setelah catatan terakhir dihapus, fokus pindah ke judul bagian", async () => {
      const only = task({
        timeEntries: [mineDone],
        timeTotals: [{ person: anda, secs: 3600, runningSince: null }],
        myRunningEntry: null,
        timersRunningSince: [],
      });
      board.deleteTimeEntry.mockResolvedValue(
        task({ timeEntries: [], timeTotals: [], myRunningEntry: null, timersRunningSince: [] }),
      );
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<Host initial={only} />);
      await openHistory(user);
      await user.click(screen.getByRole("button", { name: /^Hapus catatan 1 jam, / }));
      await user.click(screen.getByRole("button", { name: "Hapus" }));

      expect(await screen.findByRole("heading", { name: "Waktu" })).toHaveFocus();
    });
  });

  describe("catat waktu manual dinyalakan (MANUAL_TIME_LOG true)", () => {
    beforeEach(() => {
      flags.manual = true;
    });

    it("catat waktu manual: durasi bebas, catatan opsional, Enter menyimpan", async () => {
      const next = task();
      board.logTime.mockResolvedValue(next);
      const { user, onChange } = setup(task());

      const open = screen.getByRole("button", { name: "Catat waktu manual" });
      await user.click(open);
      expect(open).toHaveAttribute("aria-expanded", "true");
      const form = screen.getByRole("form", { name: "Catat waktu manual" });
      const dur = within(form).getByLabelText("Durasi");
      expect(dur).toHaveFocus();
      await user.type(dur, "1j 30m");
      await user.type(within(form).getByLabelText("Catatan (opsional)"), " Rapat klien {Enter}");

      expect(board.logTime).toHaveBeenCalledWith(P, T, 90, "Rapat klien");
      expect(onChange).toHaveBeenCalledWith(next);
      expect(screen.queryByRole("form", { name: "Catat waktu manual" })).not.toBeInTheDocument();
      expect(open).toHaveFocus();
      expect(await screen.findByText("Catatan 1 jam 30 menit disimpan.")).toBeInTheDocument();
    });

    it("catatan kosong dikirim sebagai null", async () => {
      board.logTime.mockResolvedValue(task());
      const { user } = setup(task());
      await user.click(screen.getByRole("button", { name: "Catat waktu manual" }));
      await user.type(screen.getByLabelText("Durasi"), "45m{Enter}");
      expect(board.logTime).toHaveBeenCalledWith(P, T, 45, null);
    });

    it("durasi tidak valid menampilkan pesan dan tidak memanggil inti", async () => {
      const { user } = setup(task());
      await user.click(screen.getByRole("button", { name: "Catat waktu manual" }));
      const dur = screen.getByLabelText("Durasi");

      await user.type(dur, "{Enter}");
      expect(screen.getByRole("alert")).toHaveTextContent(TEKS.waktu.isian.kosong);

      await user.type(dur, "sebentar{Enter}");
      expect(screen.getByRole("alert")).toHaveTextContent(TEKS.waktu.isian.tidakDikenali);
      expect(dur).toHaveAttribute("aria-invalid", "true");
      expect(dur).toHaveAccessibleDescription(new RegExp(TEKS.waktu.isian.tidakDikenali.slice(0, 20)));

      await user.clear(dur);
      await user.type(dur, "25j{Enter}");
      expect(screen.getByRole("alert")).toHaveTextContent(TEKS.waktu.isian.terlaluLama);

      expect(board.logTime).not.toHaveBeenCalled();
    });

    it("Escape menutup form catat tanpa menyimpan", async () => {
      const { user } = setup(task());
      const open = screen.getByRole("button", { name: "Catat waktu manual" });
      await user.click(open);
      await user.type(screen.getByLabelText("Durasi"), "30m");
      await user.keyboard("{Escape}");

      expect(screen.queryByRole("form", { name: "Catat waktu manual" })).not.toBeInTheDocument();
      expect(open).toHaveFocus();
      expect(board.logTime).not.toHaveBeenCalled();
    });

    it("form catat ditandai data-unsaved selama durasi atau catatan berisi", async () => {
      const { user } = setup(task());
      await user.click(screen.getByRole("button", { name: "Catat waktu manual" }));
      const form = screen.getByRole("form", { name: "Catat waktu manual" });
      expect(form).toHaveAttribute("data-escape-local");
      expect(form).not.toHaveAttribute("data-unsaved");

      const dur = within(form).getByLabelText("Durasi");
      await user.type(dur, "30m");
      expect(form).toHaveAttribute("data-unsaved", "true");
      await user.clear(dur);
      expect(form).not.toHaveAttribute("data-unsaved");

      await user.type(within(form).getByLabelText("Catatan (opsional)"), "Rapat");
      expect(form).toHaveAttribute("data-unsaved", "true");
    });

    it("error dari inti diteruskan ke onError dan form tetap terbuka", async () => {
      board.logTime.mockRejectedValue({ code: "limit", message: "Catatan waktu task ini sudah penuh." });
      const { user, onError, onChange } = setup(task());
      await user.click(screen.getByRole("button", { name: "Catat waktu manual" }));
      await user.type(screen.getByLabelText("Durasi"), "30{Enter}");

      expect(onError).toHaveBeenCalledWith("Catatan waktu task ini sudah penuh.");
      expect(onChange).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Durasi")).toHaveValue("30");
    });

    it("Catat waktu manual berbentuk tombol, kelas lama tetap ada", () => {
      setup(task());
      const open = screen.getByRole("button", { name: "Catat waktu manual" });
      expect(open).toHaveClass("btn", "btn-ghost", "btn-sm", "td-link-btn", "td-log-open");
      expect(open).not.toHaveClass("td-box");
    });

    it("form catat: durasi dan catatan berbingkai, Simpan dan Batal tetap tombol", async () => {
      const { user } = setup(task());
      await user.click(screen.getByRole("button", { name: "Catat waktu manual" }));
      const form = screen.getByRole("form", { name: "Catat waktu manual" });
      for (const name of ["Durasi", "Catatan (opsional)"]) {
        expect(within(form).getByLabelText(name)).toHaveClass("td-input", "td-box", "td-box-text");
      }
      for (const name of ["Simpan catatan", "Batal"]) {
        const b = within(form).getByRole("button", { name });
        expect(b).toHaveClass("btn");
        expect(b).not.toHaveClass("td-box");
      }
    });
  });

  describe("bahasa Inggris", () => {
    afterEach(() => {
      setLang("id");
    });

    it("Per person memakai tag running dan paused, tanpa Log time manually", () => {
      renderInLang(() => <TimeSection task={task()} me={ME} canEdit onChange={() => {}} onError={() => {}} />);
      const items = within(screen.getByRole("list", { name: "Per person" })).getAllByRole("listitem");
      expect(items[0]).toHaveTextContent("You");
      expect(items[0]).toHaveTextContent("running");
      expect(within(items[1]).getByText("paused")).toHaveClass("td-paused-tag");
      expect(screen.queryByRole("button", { name: "Log time manually" })).not.toBeInTheDocument();
    });
  });

  it("error saat hapus diteruskan ke onError", async () => {
    board.deleteTimeEntry.mockRejectedValue({ code: "forbidden", message: "Hanya pemilik catatan yang bisa menghapusnya." });
    const { user, onError } = setup(task());
    await openHistory(user);
    await user.click(screen.getByRole("button", { name: /^Hapus catatan 1 jam, / }));
    await user.click(screen.getByRole("button", { name: "Hapus" }));
    expect(onError).toHaveBeenCalledWith("Hanya pemilik catatan yang bisa menghapusnya.");
  });
});
