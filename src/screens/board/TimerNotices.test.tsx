// Pemberitahuan jeda otomatis timer (docs/plans/timer-jeda.md): diambil saat
// dipasang dan setiap event board, yang terbaru di atas, bisa ditutup, galat diam,
// dan hanya kalimat yang baru masuk yang dibacakan.
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimerNotice } from "../../api/board";
import { setLang } from "../../i18n/core";
import { renderInLang } from "../../test/i18n";
import { pushTimerNotices, resetTimerNotices, useTimerNoticeAnnouncement } from "./timerNoticeStore";
import { TimerNotices } from "./TimerNotices";

const board = vi.hoisted(() => ({ takeTimerNotices: vi.fn() }));
const listeners = vi.hoisted(() => new Set<() => void>());

vi.mock("../../api/board", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/board")>()),
  boardApi: board,
  subscribeBoard: (handler: () => void) => {
    listeners.add(handler);
    return () => listeners.delete(handler);
  },
}));

const P1 = "1".repeat(32);

function notice(extra: Partial<TimerNotice> = {}): TimerNotice {
  return {
    reason: "done",
    projectId: P1,
    taskId: "0".repeat(31) + "2",
    code: "PA-2",
    title: "Laporan bulanan",
    at: new Date(2026, 10, 24, 9, 30).toISOString(),
    startedCode: null,
    ...extra,
  };
}

// Seperti inti Rust: ambil sekali lalu antrean kosong.
function queue(...batches: TimerNotice[][]) {
  board.takeTimerNotices.mockReset();
  for (const b of batches) board.takeTimerNotices.mockResolvedValueOnce(b);
  board.takeTimerNotices.mockResolvedValue([]);
}

async function boardEvent() {
  await act(async () => {
    listeners.forEach((fn) => fn());
  });
}

function list(name = "Timer dijeda otomatis") {
  return screen.getByRole("list", { name });
}

function texts() {
  const el = screen.queryByRole("list", { name: "Timer dijeda otomatis" });
  return el ? within(el).getAllByRole("listitem").map((li) => li.querySelector("p")?.textContent) : [];
}

function closeButtons() {
  return screen.queryAllByRole("button", { name: "Tutup pemberitahuan" });
}

const DONE_PA2 = "Timer Anda di PA-2 (Laporan bulanan) dijeda karena task itu dipindah ke Selesai.";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 24, 18, 0, 0));
  listeners.clear();
  resetTimerNotices();
  queue();
});

afterEach(() => {
  vi.useRealTimers();
  setLang("id");
});

describe("TimerNotices: isi", () => {
  it("menampilkan keempat alasan jeda dalam bahasa Indonesia", async () => {
    queue([
      notice({ reason: "switched", code: "PA-1", title: "Desain logo", startedCode: "PB-4" }),
      notice({ reason: "done" }),
      notice({ reason: "deleted", code: "PA-3", title: "Draf lama" }),
      notice({ reason: "idle", code: "PA-5", title: "Rapat", at: new Date(2026, 10, 24, 17, 32).toISOString() }),
    ]);
    render(<TimerNotices />);
    await screen.findByRole("list", { name: "Timer dijeda otomatis" });
    // Yang terbaru (paling akhir di antrean) di atas.
    expect(texts()).toEqual([
      "Timer Anda di PA-5 (Rapat) dijeda pada 17.32, saat Mira terakhir aktif. Waktu setelah itu tidak dihitung.",
      "Timer Anda di PA-3 (Draf lama) dijeda karena task itu dihapus.",
      DONE_PA2,
      "Timer Anda di PA-1 (Desain logo) dijeda karena Anda memulai timer di PB-4.",
    ]);
    expect(board.takeTimerNotices).toHaveBeenCalledTimes(1);
  });

  it("idle di hari lain menyebut tanggal dan jam", async () => {
    queue([notice({ reason: "idle", at: new Date(2026, 10, 23, 21, 5).toISOString() })]);
    render(<TimerNotices />);
    await screen.findByRole("list", { name: "Timer dijeda otomatis" });
    expect(texts()).toEqual([
      "Timer Anda di PA-2 (Laporan bulanan) dijeda pada 23 Nov, 21.05, saat Mira terakhir aktif. Waktu setelah itu tidak dihitung.",
    ]);
  });

  it("bahasa Inggris", async () => {
    queue([
      notice({ reason: "switched", code: "PA-1", title: "Logo", startedCode: "PB-4" }),
      notice({ reason: "done" }),
      notice({ reason: "deleted", code: "PA-3", title: "Old draft" }),
      notice({ reason: "idle", code: "PA-5", title: "Meeting", at: new Date(2026, 10, 24, 17, 32).toISOString() }),
    ]);
    renderInLang(() => <TimerNotices />, "en");
    const el = await screen.findByRole("list", { name: "Timer paused automatically" });
    expect(within(el).getAllByRole("listitem").map((li) => li.querySelector("p")?.textContent)).toEqual([
      "Your timer on PA-5 (Meeting) was paused at 17:32, when Mira was last active. Time after that isn't counted.",
      "Your timer on PA-3 (Old draft) is paused because the task was deleted.",
      "Your timer on PA-2 (Laporan bulanan) is paused because the task moved to Done.",
      "Your timer on PA-1 (Logo) is paused because you started a timer on PB-4.",
    ]);
    expect(within(el).getAllByRole("button", { name: "Dismiss notice" })).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Dismiss all" })).toBeInTheDocument();
  });

  it("event board mengambil lagi dan menumpuk yang baru di atas, paling banyak lima", async () => {
    queue(
      [notice({ code: "PA-1" }), notice({ code: "PA-2" })],
      [notice({ code: "PA-3" }), notice({ code: "PA-4" })],
      [notice({ code: "PA-5" }), notice({ code: "PA-6" })],
    );
    render(<TimerNotices />);
    await screen.findByRole("list", { name: "Timer dijeda otomatis" });
    await boardEvent();
    await boardEvent();
    expect(board.takeTimerNotices).toHaveBeenCalledTimes(3);
    expect(texts().map((t) => t?.slice(14, 18))).toEqual(["PA-6", "PA-5", "PA-4", "PA-3", "PA-2"]);
    // Event tanpa pemberitahuan baru tidak mengubah apa pun.
    await boardEvent();
    expect(texts()).toHaveLength(5);
  });

  it("galat dari takeTimerNotices diabaikan diam-diam", async () => {
    board.takeTimerNotices.mockReset().mockRejectedValueOnce({ code: "internal", message: "gagal" });
    board.takeTimerNotices.mockResolvedValueOnce([notice()]);
    render(<TimerNotices />);
    await act(async () => {});
    expect(texts()).toHaveLength(0);
    expect(screen.queryByText("gagal")).not.toBeInTheDocument();
    // Event berikutnya tetap mengambil.
    await boardEvent();
    expect(texts()).toEqual([DONE_PA2]);
  });

  it("isi yang tidak sah dari inti dilewati", async () => {
    queue([
      notice({ reason: "nanti" as TimerNotice["reason"], code: "PA-8" }),
      notice({ reason: "switched", code: "PA-9", startedCode: null }),
      notice({ code: "PA-2" }),
    ]);
    render(<TimerNotices />);
    await screen.findByRole("list", { name: "Timer dijeda otomatis" });
    expect(texts()).toEqual([DONE_PA2]);
  });
});

describe("TimerNotices: pembaca layar", () => {
  it("wilayah status hanya berisi kalimat yang baru masuk, bukan seluruh daftar", async () => {
    queue([notice({ code: "PA-1", title: "Satu" })], [notice({ code: "PA-3", title: "Tiga" })]);
    render(<TimerNotices />);
    const status = screen.getByRole("status");
    expect(await within(status).findByText(/PA-1 \(Satu\)/)).toBeInTheDocument();
    await boardEvent();
    expect(await within(status).findByText("Timer Anda di PA-3 (Tiga) dijeda karena task itu dipindah ke Selesai.")).toBeInTheDocument();
    expect(status).not.toHaveTextContent("PA-1");
    expect(within(status).queryByRole("button")).not.toBeInTheDocument();
    // Daftar yang terlihat bukan wilayah live.
    expect(list().closest("[role=status], [aria-live]")).toBeNull();
  });
});

describe("TimerNotices: tutup", () => {
  it("tombol tutup menghapus pemberitahuan dan memindah fokus ke yang berikutnya", async () => {
    queue([notice({ code: "PA-1" }), notice({ code: "PA-2" })]);
    render(<TimerNotices />);
    await screen.findByRole("list", { name: "Timer dijeda otomatis" });
    const [first, second] = closeButtons();
    first.focus();
    fireEvent.click(first);
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain("PA-1");
    expect(second).toHaveFocus();
  });

  it("tutup satu-satunya pemberitahuan: fokus kembali ke elemen sebelumnya", async () => {
    queue([notice()]);
    render(
      <div>
        <button type="button">Sebelum</button>
        <TimerNotices />
        <h2 tabIndex={-1}>PA Proyek Alfa</h2>
      </div>,
    );
    await screen.findByRole("list", { name: "Timer dijeda otomatis" });
    screen.getByRole("button", { name: "Sebelum" }).focus();
    closeButtons()[0].focus();
    fireEvent.click(closeButtons()[0]);
    expect(screen.queryByRole("list", { name: "Timer dijeda otomatis" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sebelum" })).toHaveFocus();
    // Wilayah status tetap ada untuk pemberitahuan berikutnya.
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("tutup satu-satunya pemberitahuan tanpa elemen sebelumnya: fokus ke judul board", async () => {
    queue([notice()]);
    render(
      <div>
        <TimerNotices />
        <h2 tabIndex={-1}>PA Proyek Alfa</h2>
      </div>,
    );
    await screen.findByRole("list", { name: "Timer dijeda otomatis" });
    closeButtons()[0].focus();
    fireEvent.click(closeButtons()[0]);
    expect(screen.getByRole("heading", { name: "PA Proyek Alfa" })).toHaveFocus();
    expect(document.body).not.toHaveFocus();
  });

  it("Tutup semua tampil mulai dua pemberitahuan dan menghapus semuanya", async () => {
    queue([notice({ code: "PA-1" })], [notice({ code: "PA-3" })]);
    render(
      <div>
        <TimerNotices />
        <h2 tabIndex={-1}>PA Proyek Alfa</h2>
      </div>,
    );
    await screen.findByRole("list", { name: "Timer dijeda otomatis" });
    expect(screen.queryByRole("button", { name: "Tutup semua" })).not.toBeInTheDocument();
    await boardEvent();
    expect(texts()).toHaveLength(2);
    const all = screen.getByRole("button", { name: "Tutup semua" });
    all.focus();
    fireEvent.click(all);
    expect(texts()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Tutup semua" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "PA Proyek Alfa" })).toHaveFocus();
  });
});

function Announcer() {
  return <p data-testid="say">{useTimerNoticeAnnouncement()}</p>;
}

describe("useTimerNoticeAnnouncement", () => {
  it("pemberitahuan yang sudah ada saat dipasang tidak dibacakan lagi", async () => {
    act(() => pushTimerNotices([notice({ code: "PA-1" })]));
    render(<Announcer />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(screen.getByTestId("say").textContent).toBe("");
  });

  it("pemberitahuan baru dibacakan; kalimat yang sama dikosongkan dulu lalu diisi lagi", async () => {
    render(<Announcer />);
    act(() => pushTimerNotices([notice()]));
    const say = screen.getByTestId("say");
    expect(say.textContent).toBe("");
    await vi.waitFor(() => expect(say).toHaveTextContent(DONE_PA2));

    act(() => pushTimerNotices([notice()]));
    expect(say.textContent).toBe("");
    await vi.waitFor(() => expect(say).toHaveTextContent(DONE_PA2));
  });

  it("beberapa pemberitahuan sekaligus: semuanya dibacakan, terbaru dulu", async () => {
    render(<Announcer />);
    act(() => pushTimerNotices([notice({ code: "PA-1", title: "Satu" }), notice({ code: "PA-3", title: "Tiga" })]));
    await vi.waitFor(() =>
      expect(screen.getByTestId("say")).toHaveTextContent(
        "Timer Anda di PA-3 (Tiga) dijeda karena task itu dipindah ke Selesai. Timer Anda di PA-1 (Satu) dijeda karena task itu dipindah ke Selesai.",
      ),
    );
  });

  it("isi tidak sah tidak dibacakan", async () => {
    render(<Announcer />);
    act(() => pushTimerNotices([{ reason: "nanti" }, null, "x"]));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(screen.getByTestId("say").textContent).toBe("");
  });
});
