import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KopiBoard, KopiOverview } from "../../api/kopi";
import { resetKopiStore } from "../../components/useKopi";
import { setLang } from "../../i18n/core";
import { router } from "../../test/fixtures";
import { renderInLang } from "../../test/i18n";
import { ME, overview as orgOverview, PK_B } from "../../test/orgFixtures";
import type { OrgPage } from "./context";
import { KopiBoardPanel } from "./KopiBoardPanel";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

function kopiOverview(extra: Partial<KopiOverview> = {}): KopiOverview {
  return {
    enabled: true,
    boardEnabled: true,
    isSuperadmin: true,
    canGive: true,
    me: ME,
    givenToday: 0,
    dailyLimit: 3,
    reasonMax: 120,
    givenTargets: [],
    badges: [],
    tiers: [
      { tier: "anak_baru", minScore: 0 },
      { tier: "andalan", minScore: 15 },
      { tier: "senior", minScore: 60 },
      { tier: "legenda", minScore: 180 },
    ],
    peerWeight: 3,
    workWeight: 1,
    ...extra,
  };
}

function board(month: string): KopiBoard {
  return {
    month,
    enabled: true,
    rows: [{ person: { publicKey: PK_B, name: "Budi" }, peer: 2, work: 1, score: 7, tier: "andalan" }],
  };
}

function page(): OrgPage {
  return {
    overview: orgOverview(),
    act: vi.fn(async () => true),
    pending: null,
    notify: vi.fn(),
    version: 0,
    refresh: vi.fn(),
    isMe: (pk) => pk === ME,
  };
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  resetKopiStore();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 24, 10, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
  setLang("id");
});

describe("Kopi dalam bahasa Inggris", () => {
  it("menulis papan, penjelasan, tingkatan, sakelar, dan konfirmasi dalam bahasa Inggris", async () => {
    invoke.mockImplementation(
      router({ kopi_overview: kopiOverview(), kopi_board: (a?: Record<string, unknown>) => board(String(a?.month)) }),
    );
    const user = userEvent.setup();
    renderInLang(() => <KopiBoardPanel page={page()} />, "en");

    const list = await screen.findByRole("list", { name: "Ranking for November 2026" });
    expect(screen.getByRole("heading", { name: "Coffee", level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Most helpful this month" })).toBeInTheDocument();
    expect(within(list).getByText("Regular")).toBeInTheDocument();
    expect(within(list).getByText("From colleagues")).toBeInTheDocument();
    expect(within(list).getByText("From work")).toBeInTheDocument();
    expect(within(list).getByText("Score")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous month" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next month" })).toBeDisabled();
    expect(screen.getByRole("heading", { name: "How to earn coffee" })).toBeInTheDocument();
    expect(screen.getByText(/One coffee from a colleague is worth 3 score points\./)).toBeInTheDocument();
    expect(screen.getByText(/One coffee from work is worth 1 point\./)).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Levels" });
    expect(within(table).getByText("Newcomer")).toBeInTheDocument();
    expect(within(table).getByText("Legend")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Coffee settings" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Monthly board" })).toBeChecked();

    await user.click(screen.getByRole("checkbox", { name: "Coffee" }));
    const dialog = await screen.findByRole("dialog", { name: "Turn Coffee off?" });
    expect(within(dialog).getByRole("button", { name: "Turn Coffee off" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    expect(await screen.findByRole("heading", { name: "Most helpful in October 2026" })).toBeInTheDocument();

    expect(
      screen.queryByText(/Paling banyak|Cara mendapat|Dari rekan|Dari kerja|Skor|Tingkatan|Papan bulanan|Nyala|Mati/),
    ).not.toBeInTheDocument();
  });

  it("menulis keterangan fitur dan papan mati dalam bahasa Inggris", async () => {
    invoke.mockImplementation(
      router({
        kopi_overview: kopiOverview({ isSuperadmin: false, boardEnabled: false }),
        kopi_board: (a?: Record<string, unknown>) => ({ ...board(String(a?.month)), enabled: false, rows: [] }),
      }),
    );
    const { unmount } = renderInLang(() => <KopiBoardPanel page={page()} />, "en");
    expect(await screen.findByText("Monthly board is turned off")).toBeInTheDocument();
    expect(screen.getByText(/A superadmin turned the monthly board off\./)).toBeInTheDocument();
    unmount();

    invoke.mockImplementation(
      router({
        kopi_overview: kopiOverview({ isSuperadmin: false, enabled: false }),
        kopi_board: (a?: Record<string, unknown>) => ({ ...board(String(a?.month)), enabled: false, rows: [] }),
      }),
    );
    renderInLang(() => <KopiBoardPanel page={page()} />, "en");
    expect(await screen.findByText("Coffee is turned off")).toBeInTheDocument();
    expect(screen.getByText(/A superadmin turned Coffee off for the whole office\./)).toBeInTheDocument();
  });

  it("menulis papan kosong bulan ini dalam bahasa Inggris", async () => {
    invoke.mockImplementation(
      router({
        kopi_overview: kopiOverview({ isSuperadmin: false }),
        kopi_board: (a?: Record<string, unknown>) => ({ ...board(String(a?.month)), rows: [] }),
      }),
    );
    renderInLang(() => <KopiBoardPanel page={page()} />, "en");
    expect(await screen.findByText(/No coffee yet this month\./)).toBeInTheDocument();
  });
});
