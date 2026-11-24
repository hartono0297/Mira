// Tampilan Kalender: chip, Bulan, Minggu, Agenda, dan daftar satu hari.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskCard } from "../../api/board";
import type { CalTask } from "../../api/calendar";
import { setLang } from "../../i18n/core";
import { AgendaView } from "./AgendaView";
import { groupByDay } from "./calendarModel";
import { CalChip } from "./CalChip";
import { MonthView } from "./MonthView";
import type { ViewProps } from "./viewTypes";
import { WeekView } from "./WeekView";

const TES = { projectId: "p1", projectCode: "TES", projectName: "Tes" };
const KEU = { projectId: "p2", projectCode: "KEU", projectName: "Keuangan" };

let seq = 0;
function cal(over: Partial<TaskCard>, project = TES): CalTask {
  seq += 1;
  const task: TaskCard = {
    id: `t${seq}`,
    code: `${project.projectCode}-${seq}`,
    title: `Task ${seq}`,
    columnId: "todo",
    assignee: null,
    due: "2026-11-24",
    priority: "none",
    labels: [],
    commentCount: 0,
    merged: false,
    subtaskDone: 0,
    subtaskTotal: 0,
    trackedSecs: 0,
    timersRunningSince: [],
    canEdit: true,
    ...over,
  };
  return { ...project, task };
}

function handlers() {
  return {
    onOpen: vi.fn(),
    onPointerDown: vi.fn(),
    onContextMenu: vi.fn(),
    onKeyDown: vi.fn(),
  };
}

function props(tasks: CalTask[], over: Partial<ViewProps> = {}): ViewProps {
  return {
    ...handlers(),
    anchor: "2026-11-24",
    today: "2026-11-24",
    byDay: groupByDay(tasks),
    colors: new Map([
      ["p1", 0],
      ["p2", 3],
    ]),
    draggingKey: null,
    dropDay: null,
    focusKey: null,
    ...over,
  };
}

afterEach(() => {
  setLang("id");
});

describe("CalChip", () => {
  it("nama aksesibel memuat kode, judul, proyek, dan lewat tenggat", () => {
    const t = cal({ code: "TES-3", title: "Laporan bulanan", due: "2026-11-20" });
    render(<CalChip item={t} colorIndex={0} today="2026-11-24" dragging={false} {...handlers()} />);
    expect(screen.getByRole("button", { name: "TES-3, Laporan bulanan, proyek Tes, lewat tenggat" })).toBeInTheDocument();
  });

  it("task selesai disebut selesai dan tidak lewat tenggat", () => {
    const t = cal({ code: "TES-4", title: "Arsip", due: "2026-11-20", columnId: "done" });
    render(<CalChip item={t} colorIndex={0} today="2026-11-24" dragging={false} {...handlers()} />);
    const chip = screen.getByRole("button", { name: "TES-4, Arsip, proyek Tes, selesai" });
    expect(chip).toHaveClass("cc-done");
  });

  it("menulis kode proyek kalau kode task tidak diawali kode proyek", () => {
    const t = cal({ code: "LAMA-7", title: "Pindahan" });
    render(<CalChip item={t} colorIndex={2} today="2026-11-24" dragging={false} {...handlers()} />);
    const chip = screen.getByRole("button", { name: "TES, LAMA-7, Pindahan, proyek Tes" });
    expect(chip).toHaveClass("cc-p2");
  });

  it("klik memanggil onOpen, dan penangan lain diteruskan dengan task-nya", () => {
    const h = handlers();
    const t = cal({ title: "Klik saya" });
    render(<CalChip item={t} colorIndex={0} today="2026-11-24" dragging={false} {...h} />);
    const chip = screen.getByRole("button", { name: /Klik saya/ });
    expect(chip).toHaveAttribute("data-cal-task", "p1/" + t.task.id);
    fireEvent.click(chip);
    expect(h.onOpen).toHaveBeenCalledWith(t);
    fireEvent.pointerDown(chip);
    expect(h.onPointerDown).toHaveBeenCalledWith(expect.anything(), t);
    fireEvent.contextMenu(chip);
    expect(h.onContextMenu).toHaveBeenCalledWith(expect.anything(), t);
    fireEvent.keyDown(chip, { key: "ArrowRight", altKey: true });
    expect(h.onKeyDown).toHaveBeenCalledWith(expect.anything(), t);
  });

  it("chip yang sedang diseret bergaya seret, chip tanpa hak tetap bisa difokus", () => {
    const t = cal({ canEdit: false });
    render(<CalChip item={t} colorIndex={0} today="2026-11-24" dragging {...handlers()} />);
    const chip = screen.getByRole("button");
    expect(chip).toHaveClass("cc-dragging");
    expect(chip).not.toHaveAttribute("data-movable");
    expect(chip).not.toBeDisabled();
    chip.focus();
    expect(chip).toHaveFocus();
  });

  it("baris agenda menampilkan penanggung jawab dan prioritas", () => {
    const t = cal({ code: "KEU-2", title: "Pajak", priority: "high", assignee: { publicKey: "k1", name: "Budi" } }, KEU);
    render(<CalChip item={t} colorIndex={3} today="2026-11-24" dragging={false} variant="row" {...handlers()} />);
    const chip = screen.getByRole("button", { name: "KEU-2, Pajak, proyek Keuangan, untuk Budi, prioritas Tinggi" });
    expect(within(chip).getByText("Budi")).toBeInTheDocument();
    expect(within(chip).getByText("Tinggi")).toBeInTheDocument();
  });

  it("bahasa Inggris", () => {
    setLang("en");
    const t = cal({ code: "TES-3", title: "Monthly report", due: "2026-11-20" });
    render(<CalChip item={t} colorIndex={0} today="2026-11-24" dragging={false} {...handlers()} />);
    expect(screen.getByRole("button", { name: "TES-3, Monthly report, project Tes, overdue" })).toBeInTheDocument();
  });
});

describe("MonthView", () => {
  it("November 2026: 6 baris, Senin dulu, sel punya data-cal-day", () => {
    const { container } = render(<MonthView {...props([])} />);
    const table = screen.getByRole("table");
    const heads = within(table).getAllByRole("columnheader");
    expect(heads.map((h) => h.textContent)).toEqual(["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"]);
    expect(within(table).getAllByRole("row")).toHaveLength(7); // kepala + 6 minggu
    const cells = container.querySelectorAll("td[data-cal-day]");
    expect(cells).toHaveLength(42);
    expect(cells[0]).toHaveAttribute("data-cal-day", "2026-10-26");
    expect(cells[41]).toHaveAttribute("data-cal-day", "2026-12-06");
    expect(cells[0]).toHaveClass("cv-out");
    expect(container.querySelector('td[data-cal-day="2026-11-01"]')).not.toHaveClass("cv-out");
  });

  it("Februari 2027 cukup 4 baris", () => {
    render(<MonthView {...props([], { anchor: "2027-02-10", today: "2026-11-24" })} />);
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(5);
  });

  it("hari ini ditandai aria-current=date, hanya satu sel", () => {
    const { container } = render(<MonthView {...props([])} />);
    const current = container.querySelectorAll('[aria-current="date"]');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAttribute("data-cal-day", "2026-11-24");
  });

  it("maks 3 chip per sel, sisanya +N lagi yang membuka daftar semua task hari itu", async () => {
    const user = userEvent.setup();
    const tasks = [1, 2, 3, 4, 5].map((n) => cal({ title: `Hari ${n}`, due: "2026-11-12" }));
    const { container } = render(<MonthView {...props(tasks)} />);
    const cell = container.querySelector('td[data-cal-day="2026-11-12"]') as HTMLElement;
    expect(cell.querySelectorAll(".cv-chips [data-cal-task]")).toHaveLength(3);
    const more = within(cell).getByRole("button", { name: "+2 lagi, Kamis, 12 November 2026" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await user.click(more);
    const dlg = screen.getByRole("dialog", { name: "Kamis, 12 November 2026" });
    expect(within(dlg).getAllByRole("button", { name: /^TES-\d+, Hari/ })).toHaveLength(5);
    expect(more).toHaveAttribute("aria-expanded", "true");
    // Fokus pindah ke dalam daftar.
    expect(dlg.contains(document.activeElement)).toBe(true);
  });

  it("Esc menutup daftar dan mengembalikan fokus ke tombol", async () => {
    const user = userEvent.setup();
    const tasks = [1, 2, 3, 4].map((n) => cal({ title: `Esc ${n}`, due: "2026-11-12" }));
    render(<MonthView {...props(tasks)} />);
    const more = screen.getByRole("button", { name: /^\+1 lagi/ });
    await user.click(more);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(more).toHaveFocus();
  });

  it("tombol Tutup dan klik di luar juga menutup daftar", async () => {
    const user = userEvent.setup();
    const tasks = [1, 2, 3, 4].map((n) => cal({ title: `Luar ${n}`, due: "2026-11-12" }));
    render(<MonthView {...props(tasks)} />);
    const more = screen.getByRole("button", { name: /^\+1 lagi/ });
    await user.click(more);
    await user.click(screen.getByRole("button", { name: "Tutup daftar" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(more).toHaveFocus();

    await user.click(more);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(more).toHaveFocus());
  });

  it("chip di dalam daftar memanggil penangan yang sama", async () => {
    const user = userEvent.setup();
    const tasks = [1, 2, 3, 4].map((n) => cal({ title: `Dalam ${n}`, due: "2026-11-12" }));
    const p = props(tasks);
    render(<MonthView {...p} />);
    await user.click(screen.getByRole("button", { name: /^\+1 lagi/ }));
    const dlg = screen.getByRole("dialog");
    const last = within(dlg).getByRole("button", { name: /Dalam 4/ });
    await user.click(last);
    expect(p.onOpen).toHaveBeenCalledWith(tasks[3]);
  });

  it("tampilan sempit: tombol jumlah per hari membuka daftar yang sama", async () => {
    const user = userEvent.setup();
    const tasks = [cal({ title: "A", due: "2026-11-25" }), cal({ title: "B", due: "2026-11-25" })];
    render(<MonthView {...props(tasks)} />);
    const count = screen.getByRole("button", { name: "2 task, Rabu, 25 November 2026" });
    await user.click(count);
    expect(within(screen.getByRole("dialog", { name: "Rabu, 25 November 2026" })).getAllByRole("button", { name: /^TES-/ })).toHaveLength(2);
  });

  it("tombol jumlah menyebut task lewat tenggat", () => {
    const tasks = [cal({ title: "Lama", due: "2026-11-05" })];
    render(<MonthView {...props(tasks)} />);
    expect(screen.getByRole("button", { name: "1 task, Kamis, 5 November 2026, ada yang lewat tenggat" })).toBeInTheDocument();
  });

  it("sel tujuan seret disorot", () => {
    const { container } = render(<MonthView {...props([], { dropDay: "2026-11-18" })} />);
    expect(container.querySelector('td[data-cal-day="2026-11-18"]')).toHaveClass("cv-drop");
  });

  it("focusKey memfokus chip, atau tombol +N kalau chip tersembunyi", () => {
    const tasks = [1, 2, 3, 4].map((n) => cal({ title: `Fokus ${n}`, due: "2026-11-12" }));
    const p = props(tasks);
    const { rerender } = render(<MonthView {...p} />);
    const shown = groupByDay(tasks).get("2026-11-12")!;
    rerender(<MonthView {...p} focusKey={`p1/${shown[1].task.id}`} />);
    expect(screen.getByRole("button", { name: new RegExp(shown[1].task.title) })).toHaveFocus();
    rerender(<MonthView {...p} focusKey={`p1/${shown[3].task.id}`} />);
    expect(screen.getByRole("button", { name: /^\+1 lagi/ })).toHaveFocus();
  });

  it("bahasa Inggris: Senin dulu dan +N more", () => {
    setLang("en");
    const tasks = [1, 2, 3, 4].map((n) => cal({ title: `En ${n}`, due: "2026-11-12" }));
    render(<MonthView {...props(tasks)} />);
    const heads = within(screen.getByRole("table")).getAllByRole("columnheader");
    expect(heads[0]).toHaveTextContent("Mon");
    expect(screen.getByRole("button", { name: "+1 more, Thursday, 12 November 2026" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "4 tasks, Thursday, 12 November 2026, some overdue" })).toBeInTheDocument();
  });
});

describe("WeekView", () => {
  it("7 kolom Senin sampai Minggu dengan data-cal-day, hari ini ditandai", () => {
    const { container } = render(<WeekView {...props([cal({ title: "Minggu ini", due: "2026-11-26" })])} />);
    const cols = container.querySelectorAll("[data-cal-day]");
    expect(cols).toHaveLength(7);
    expect(cols[0]).toHaveAttribute("data-cal-day", "2026-11-23");
    expect(cols[6]).toHaveAttribute("data-cal-day", "2026-11-29");
    expect(cols[1]).toHaveAttribute("aria-current", "date");
    expect(within(cols[3] as HTMLElement).getByRole("button", { name: /Minggu ini/ })).toBeInTheDocument();
    expect(within(cols[0] as HTMLElement).getByText("Tidak ada tenggat")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 3 })[0]).toHaveAccessibleName("Senin, 23 November 2026");
    expect(screen.getByRole("heading", { name: "Selasa, 24 November 2026" })).toBeInTheDocument();
  });

  it("semua chip tampil, tanpa batas 3", () => {
    const tasks = [1, 2, 3, 4, 5].map((n) => cal({ title: `W ${n}`, due: "2026-11-25" }));
    render(<WeekView {...props(tasks)} />);
    expect(screen.getAllByRole("button", { name: /W \d/ })).toHaveLength(5);
  });

  it("sel tujuan seret disorot", () => {
    const { container } = render(<WeekView {...props([], { dropDay: "2026-11-27" })} />);
    expect(container.querySelector('[data-cal-day="2026-11-27"]')).toHaveClass("cv-drop");
  });
});

describe("AgendaView", () => {
  function agenda(tasks: CalTask[], overdue: CalTask[] = [], over: Partial<ViewProps> = {}) {
    return render(<AgendaView {...props(tasks, over)} overdue={overdue} />);
  }

  it("grup Lewat tenggat di atas, lalu satu bagian per hari yang ada task-nya", () => {
    const late = cal({ title: "Telat", due: "2026-10-30" });
    const tasks = [cal({ title: "Besok", due: "2026-11-25" }), cal({ title: "Sekarang", due: "2026-11-24" })];
    const { container } = agenda(tasks, [late]);
    const heads = screen.getAllByRole("heading", { level: 3 });
    expect(heads).toHaveLength(3);
    expect(heads[0]).toHaveAccessibleName("Lewat tenggat");
    expect(heads[1]).toHaveAccessibleName("Hari ini, Selasa, 24 November 2026");
    expect(heads[2]).toHaveAccessibleName("Rabu, 25 November 2026");
    const days = container.querySelectorAll("section[data-cal-day]");
    expect([...days].map((d) => d.getAttribute("data-cal-day"))).toEqual(["2026-11-24", "2026-11-25"]);
    const overdueSection = screen.getByRole("region", { name: "Lewat tenggat" });
    expect(overdueSection).not.toHaveAttribute("data-cal-day");
    expect(within(overdueSection).getByRole("button", { name: /Telat, proyek Tes, .*lewat tenggat/ })).toBeInTheDocument();
  });

  it("tanpa task lewat tenggat, grupnya tidak ada", () => {
    agenda([cal({ title: "Saja", due: "2026-11-26" })]);
    expect(screen.queryByRole("heading", { name: "Lewat tenggat" })).not.toBeInTheDocument();
  });

  it("kosong: kalimat bulan dan saran saringan", () => {
    agenda([]);
    expect(screen.getByText("Tidak ada task bertenggat di November 2026.")).toBeInTheDocument();
    expect(screen.getByText(/ubah saringan di atas/)).toBeInTheDocument();
  });

  it("baris agenda memuat penanggung jawab", () => {
    agenda([cal({ title: "Orang", assignee: { publicKey: "k", name: "Sari" } })]);
    expect(screen.getByRole("button", { name: /Orang, proyek Tes, untuk Sari/ })).toBeInTheDocument();
  });

  it("bahasa Inggris", () => {
    setLang("en");
    const late = cal({ title: "Late one", due: "2026-10-30" });
    agenda([cal({ title: "Now", due: "2026-11-24" })], [late]);
    const heads = screen.getAllByRole("heading", { level: 3 });
    expect(heads).toHaveLength(2);
    expect(heads[0]).toHaveAccessibleName("Overdue");
    expect(heads[1]).toHaveAccessibleName("Today, Tuesday, 24 November 2026");
  });

  it("bahasa Inggris, kosong", () => {
    setLang("en");
    agenda([]);
    expect(screen.getByText("No tasks are due in November 2026.")).toBeInTheDocument();
  });

  it("focusKey memfokus chip setelah render", async () => {
    const t = cal({ title: "Fokuskan", due: "2026-11-26" });
    const p = props([t]);
    const { rerender } = render(<AgendaView {...p} overdue={[]} />);
    await act(async () => {
      rerender(<AgendaView {...p} overdue={[]} focusKey={`p1/${t.task.id}`} />);
    });
    expect(screen.getByRole("button", { name: /Fokuskan/ })).toHaveFocus();
  });
});
