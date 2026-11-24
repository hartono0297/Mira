import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskCard } from "../../api/board";
import type { KopiOverview, KopiTarget } from "../../api/kopi";
import { setLang } from "../../i18n/core";
import { TaskKopiThanks, taskKopiState } from "./TaskKopiThanks";

const kopi = vi.hoisted(() => ({ overview: null as KopiOverview | null, reload: vi.fn(async () => {}) }));

vi.mock("../../components/useKopi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../components/useKopi")>()),
  useKopi: () => ({ overview: kopi.overview, error: null, badgeOf: () => null, reload: kopi.reload }),
}));

vi.mock("../../components/KopiGiveDialog", () => ({
  KopiGiveDialog: (p: {
    to: { name: string };
    target: KopiTarget;
    context?: string;
    onClose: () => void;
    onGiven?: (name: string) => void;
  }) => (
    <div role="dialog" aria-label="Dialog kopi tiruan">
      <p>untuk {p.to.name}</p>
      <p>target {JSON.stringify(p.target)}</p>
      <p>konteks {p.context}</p>
      <button type="button" onClick={() => p.onGiven?.(p.to.name)}>
        Tiruan terkirim
      </button>
      <button type="button" onClick={p.onClose}>
        Tiruan tutup
      </button>
    </div>
  ),
}));

const ME = "a".repeat(64);
const PK_B = "b".repeat(64);
const PROJECT = "p".repeat(32);

type TaskLike = Pick<TaskCard, "id" | "title" | "columnId" | "assignee">;

function task(extra: Partial<TaskLike> = {}): TaskLike {
  return { id: "t1", title: "Kirim kontrak", columnId: "done", assignee: { publicKey: PK_B, name: "Sari" }, ...extra };
}

function overview(extra: Partial<KopiOverview> = {}): KopiOverview {
  return {
    enabled: true,
    boardEnabled: true,
    isSuperadmin: false,
    canGive: true,
    me: ME,
    givenToday: 0,
    dailyLimit: 3,
    reasonMax: 120,
    givenTargets: [],
    badges: [],
    tiers: [],
    peerWeight: 3,
    workWeight: 1,
    ...extra,
  };
}

beforeEach(() => {
  setLang("id");
  kopi.overview = overview();
  kopi.reload.mockClear();
});

describe("taskKopiState", () => {
  it("tampil hanya untuk task Selesai dengan penanggung jawab orang lain", () => {
    expect(taskKopiState(overview(), PROJECT, task(), ME)).toEqual({ show: true, disabled: null });
    expect(taskKopiState(overview(), PROJECT, task({ columnId: "doing" }), ME)).toEqual({ show: false });
    expect(taskKopiState(overview(), PROJECT, task({ columnId: "todo" }), ME)).toEqual({ show: false });
    expect(taskKopiState(overview(), PROJECT, task({ assignee: null }), ME)).toEqual({ show: false });
    expect(taskKopiState(overview(), PROJECT, task({ assignee: { publicKey: ME, name: "Saya" } }), ME)).toEqual({
      show: false,
    });
    // Board belum termuat (me kosong): kunci dari ringkasan Kopi tetap dipakai.
    expect(taskKopiState(overview(), PROJECT, task({ assignee: { publicKey: ME, name: "Saya" } }), "")).toEqual({
      show: false,
    });
  });

  it("tidak tampil saat fitur mati, ringkasan belum ada, atau saya Tamu", () => {
    expect(taskKopiState(null, PROJECT, task(), ME)).toEqual({ show: false });
    expect(taskKopiState(overview({ enabled: false }), PROJECT, task(), ME)).toEqual({ show: false });
    expect(taskKopiState(overview({ canGive: false }), PROJECT, task(), ME)).toEqual({ show: false });
  });

  it("nonaktif dengan alasan: sudah diberi, lalu jatah habis", () => {
    expect(taskKopiState(overview({ givenTargets: [`task:${PROJECT}:t1`] }), PROJECT, task(), ME)).toEqual({
      show: true,
      disabled: "Anda sudah memberi Sari kopi untuk task ini.",
    });
    expect(taskKopiState(overview({ givenToday: 3 }), PROJECT, task(), ME)).toEqual({
      show: true,
      disabled: "Jatah kopi hari ini habis (3 per hari). Besok bisa memberi lagi.",
    });
    expect(taskKopiState(overview({ givenTargets: [`task:${PROJECT}:t2`] }), PROJECT, task(), ME)).toEqual({
      show: true,
      disabled: null,
    });
  });
});

describe("TaskKopiThanks", () => {
  it("tombol membuka dialog dengan target task dan judulnya", async () => {
    const user = userEvent.setup();
    render(<TaskKopiThanks projectId={PROJECT} task={task()} me={ME} />);
    await user.click(screen.getByRole("button", { name: "Terima kasih ke Sari" }));
    const dlg = screen.getByRole("dialog", { name: "Dialog kopi tiruan" });
    expect(dlg).toHaveTextContent("untuk Sari");
    expect(dlg).toHaveTextContent(`target {"kind":"task","project":"${PROJECT}","task":"t1"}`);
    expect(dlg).toHaveTextContent("konteks Kirim kontrak");
    await user.click(screen.getByRole("button", { name: "Tiruan terkirim" }));
    // Dialog sudah memuat ulang ringkasan; tombol tidak memuat ulang lagi.
    expect(kopi.reload).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Tiruan tutup" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    // Live region milik komponen ini tetap ada setelah dialog tertutup.
    expect(screen.getByRole("status")).toHaveTextContent("Kopi terkirim untuk Sari.");
  });

  it("tidak tampil untuk task yang belum selesai", () => {
    const { container } = render(<TaskKopiThanks projectId={PROJECT} task={task({ columnId: "doing" })} me={ME} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("tidak tampil kalau penanggung jawabnya saya", () => {
    const { container } = render(
      <TaskKopiThanks projectId={PROJECT} task={task({ assignee: { publicKey: ME, name: "Saya" } })} me={ME} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("sudah diberi: tombol tetap bisa difokus, alasannya terbaca, dialog tidak terbuka", async () => {
    const user = userEvent.setup();
    kopi.overview = overview({ givenTargets: [`task:${PROJECT}:t1`] });
    render(<TaskKopiThanks projectId={PROJECT} task={task()} me={ME} />);
    const btn = screen.getByRole("button", { name: "Terima kasih ke Sari" });
    expect(btn).toHaveAttribute("aria-disabled", "true");
    expect(btn).toHaveAccessibleDescription("Anda sudah memberi Sari kopi untuk task ini.");
    expect(screen.getByText("Anda sudah memberi Sari kopi untuk task ini.")).toBeVisible();
    await user.tab();
    expect(btn).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.click(btn);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("teks bahasa Inggris", () => {
    setLang("en");
    kopi.overview = overview({ givenToday: 3 });
    render(<TaskKopiThanks projectId={PROJECT} task={task()} me={ME} />);
    const btn = screen.getByRole("button", { name: "Thank Sari" });
    expect(btn).toHaveClass("kopi-btn", "kopi-tap");
    expect(btn).toHaveAccessibleDescription("You've given all of today's coffee (3 a day). You can give more tomorrow.");
  });
});
