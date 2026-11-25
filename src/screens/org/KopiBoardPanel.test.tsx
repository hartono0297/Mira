import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, OrgInfo } from "../../api";
import type { KopiBoard, KopiBoardRow, KopiOverview } from "../../api/kopi";
import { resetKopiStore } from "../../components/useKopi";
import { appState, directory, router, rustError } from "../../test/fixtures";
import { memberOverview, ME, overview as orgOverview, PK_B, PK_C } from "../../test/orgFixtures";
import type { OrgPage } from "./context";
import { KopiBoardPanel } from "./KopiBoardPanel";
import { OrgScreen } from "./OrgScreen";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

function kopiOverview(extra: Partial<KopiOverview> = {}): KopiOverview {
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

function row(publicKey: string, name: string, peer: number, work: number, tier: KopiBoardRow["tier"] = "andalan"): KopiBoardRow {
  return { person: { publicKey, name }, peer, work, score: peer * 3 + work, tier };
}

function board(month: string, rows: KopiBoardRow[], enabled = true): KopiBoard {
  return { month, enabled, rows };
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

const ROWS = [row(PK_B, "Budi", 4, 2, "andalan"), row(ME, "Andi", 1, 5, "anak_baru"), row(PK_C, "Sari", 20, 2, "senior")];

function answer(extra: Record<string, unknown> = {}) {
  invoke.mockImplementation(
    router({
      kopi_overview: kopiOverview(),
      kopi_board: (args?: Record<string, unknown>) => board(String(args?.month), ROWS),
      ...(extra as Record<string, never>),
    }),
  );
}

function calls(cmd: string) {
  return invoke.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args as Record<string, unknown>);
}

function renderPanel(p: OrgPage = page()) {
  const user = userEvent.setup();
  render(<KopiBoardPanel page={p} />);
  return { user, page: p };
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
});

describe("Kopi: papan bulanan", () => {
  it("menampilkan peringkat terurut dari skor terbesar, dengan tingkatan dan rincian", async () => {
    answer();
    renderPanel();
    const list = await screen.findByRole("list", { name: "Peringkat November 2026" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((li) => within(li).getByTestId("kb-name").textContent)).toEqual(["Sari", "Budi", "Andi (Anda)"]);
    const first = items[0];
    expect(within(first).getByText("1")).toBeInTheDocument();
    expect(within(first).getByText("Senior")).toBeInTheDocument();
    expect(within(first).getByText("Dari rekan").nextSibling).toHaveTextContent("20");
    expect(within(first).getByText("Dari kerja").nextSibling).toHaveTextContent("2");
    expect(within(first).getByText("Skor").nextSibling).toHaveTextContent("62");
    expect(screen.getByRole("heading", { name: "Paling banyak membantu bulan ini" })).toBeInTheDocument();
    expect(calls("kopi_board")[0]).toMatchObject({ month: "2026-11" });
  });

  it("ringkasan datang dari cache useKopi: satu kopi_overview walau bulan berganti", async () => {
    answer();
    const { user } = renderPanel();
    await screen.findByRole("list", { name: "Peringkat November 2026" });
    await user.click(screen.getByRole("button", { name: "Bulan sebelumnya" }));
    await screen.findByRole("list", { name: "Peringkat Oktober 2026" });
    expect(calls("kopi_overview")).toHaveLength(1);
    expect(calls("kopi_board").map((a) => a.month)).toEqual(["2026-11", "2026-10"]);
  });

  it("paling banyak 10 orang", async () => {
    const many = Array.from({ length: 12 }, (_, i) => row(String(i).repeat(64).slice(0, 64), `Orang ${i}`, 12 - i, 0));
    answer({ kopi_board: (args?: Record<string, unknown>) => board(String(args?.month), many) });
    renderPanel();
    const list = await screen.findByRole("list", { name: "Peringkat November 2026" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(10);
  });

  it("pindah ke bulan sebelumnya lalu kembali; tidak bisa melewati bulan ini", async () => {
    answer();
    const { user } = renderPanel();
    await screen.findByRole("list", { name: "Peringkat November 2026" });
    const next = screen.getByRole("button", { name: "Bulan berikutnya" });
    expect(next).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Bulan sebelumnya" }));
    expect(await screen.findByRole("list", { name: "Peringkat Oktober 2026" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Paling banyak membantu pada Oktober 2026" })).toBeInTheDocument();
    expect(calls("kopi_board").map((a) => a.month)).toContain("2026-10");
    expect(next).toBeEnabled();

    await user.click(next);
    expect(await screen.findByRole("list", { name: "Peringkat November 2026" })).toBeInTheDocument();
    expect(next).toBeDisabled();
  });

  it("bulan berganti tahun: Januari ke Desember tahun lalu", async () => {
    vi.setSystemTime(new Date(2027, 0, 5, 9, 0, 0));
    answer();
    const { user } = renderPanel();
    await screen.findByRole("list", { name: "Peringkat Januari 2027" });
    await user.click(screen.getByRole("button", { name: "Bulan sebelumnya" }));
    expect(await screen.findByRole("list", { name: "Peringkat Desember 2026" })).toBeInTheDocument();
    expect(calls("kopi_board").map((a) => a.month)).toContain("2026-12");
  });

  it("kosong bulan ini: menyebut cara memberi kopi", async () => {
    answer({ kopi_board: (args?: Record<string, unknown>) => board(String(args?.month), []) });
    renderPanel();
    expect(
      await screen.findByText(
        "Belum ada kopi bulan ini. Beri kopi ke rekan yang membantu lewat menu klik kanan pesannya, atau selesaikan task paling lambat di hari tenggat.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: /Peringkat/ })).not.toBeInTheDocument();
  });

  it("kosong bulan lalu: menyebut bulannya", async () => {
    answer({ kopi_board: (args?: Record<string, unknown>) => board(String(args?.month), []) });
    const { user } = renderPanel();
    await screen.findByText(/Belum ada kopi bulan ini\./);
    await user.click(screen.getByRole("button", { name: "Bulan sebelumnya" }));
    expect(await screen.findByText("Tidak ada kopi pada Oktober 2026.")).toBeInTheDocument();
  });

  it("menampilkan teks memuat selama data belum datang", async () => {
    answer({ kopi_overview: () => new Promise(() => {}) });
    renderPanel();
    expect(screen.getByText("Memuat kopi...")).toBeInTheDocument();
  });

  it("error papan: pesan dari Rust, lalu Coba lagi memuat ulang", async () => {
    let fail = true;
    answer({
      kopi_board: (args?: Record<string, unknown>) => {
        if (fail) throw { code: "database", message: "Database terkunci." };
        return board(String(args?.month), ROWS);
      },
    });
    const { user } = renderPanel();
    expect(await screen.findByText("Papan November 2026 belum terbaca")).toBeInTheDocument();
    expect(screen.getByText("Database terkunci.")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Coba lagi" }));
    expect(await screen.findByRole("list", { name: "Peringkat November 2026" })).toBeInTheDocument();
    expect(screen.queryByText("Papan November 2026 belum terbaca")).not.toBeInTheDocument();
  });

  it("error ringkasan: pesan dari Rust, lalu Coba lagi memuat ulang", async () => {
    let fail = true;
    answer({
      kopi_overview: () => {
        if (fail) throw { code: "database", message: "Database terkunci." };
        return kopiOverview();
      },
    });
    const { user } = renderPanel();
    expect(await screen.findByText("Data kopi belum terbaca")).toBeInTheDocument();
    expect(screen.getByText("Database terkunci.")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Coba lagi" }));
    expect(await screen.findByRole("list", { name: "Peringkat November 2026" })).toBeInTheDocument();
    expect(screen.queryByText("Data kopi belum terbaca")).not.toBeInTheDocument();
  });

  it("data yang tidak terbaca dari inti tampil sebagai error", async () => {
    answer({ kopi_overview: null });
    renderPanel();
    expect(await screen.findByText("Inti Mira mengirim data kopi yang tidak terbaca.")).toBeInTheDocument();
  });

  it("menjelaskan cara mendapat kopi dan tabel tingkatan dari inti", async () => {
    answer();
    renderPanel();
    expect(await screen.findByRole("heading", { name: "Cara mendapat kopi" })).toBeInTheDocument();
    expect(screen.getByText(/Satu kopi dari rekan bernilai 3 poin skor\./)).toBeInTheDocument();
    expect(screen.getByText(/Satu kopi dari kerja bernilai 1 poin\./)).toBeInTheDocument();
    expect(screen.getByText(/memberi paling banyak 3 kopi per hari/)).toBeInTheDocument();
    expect(screen.queryByText(/Tidak ada Kopi negatif/)).not.toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Tingkatan" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent)).toEqual(["Anak baru0", "Andalan15", "Senior60", "Legenda180"]);
  });
});

describe("Kopi: keterangan saat dimatikan", () => {
  it("papan mati untuk anggota: keterangan superadmin, tanpa daftar dan tanpa sakelar", async () => {
    answer({
      kopi_overview: kopiOverview({ boardEnabled: false }),
      kopi_board: (args?: Record<string, unknown>) => board(String(args?.month), [], false),
    });
    renderPanel();
    expect(await screen.findByText("Papan bulanan dimatikan")).toBeInTheDocument();
    expect(screen.getByText(/Superadmin mematikan papan bulanan\./)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: /Peringkat/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Bulan sebelumnya" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Cara mendapat kopi" })).toBeInTheDocument();
  });

  it("fitur mati untuk anggota: panel menjelaskan fitur dimatikan", async () => {
    answer({
      kopi_overview: kopiOverview({ enabled: false, canGive: false }),
      kopi_board: (args?: Record<string, unknown>) => board(String(args?.month), [], false),
    });
    renderPanel();
    expect(await screen.findByText("Fitur Kopi sedang dimatikan")).toBeInTheDocument();
    expect(screen.getByText(/Superadmin mematikan Kopi untuk seluruh kantor\./)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: /Peringkat/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Cara mendapat kopi" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
});

describe("Kopi: sakelar superadmin", () => {
  it("hanya superadmin yang melihat sakelar", async () => {
    answer();
    renderPanel();
    await screen.findByRole("list", { name: "Peringkat November 2026" });
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Pengaturan Kopi" })).not.toBeInTheDocument();
  });

  it("mematikan papan memanggil setSettings(true, false) tanpa konfirmasi", async () => {
    let settings = { enabled: true, board: true };
    answer({
      kopi_overview: () => kopiOverview({ isSuperadmin: true, enabled: settings.enabled, boardEnabled: settings.board }),
      kopi_set_settings: (args?: Record<string, unknown>) => {
        settings = { enabled: Boolean(args?.enabled), board: Boolean(args?.board) };
        return null;
      },
    });
    const { user, page: p } = renderPanel();
    const sw = await screen.findByRole("checkbox", { name: /Papan bulanan/ });
    expect(sw).toBeChecked();
    await user.click(sw);
    expect(calls("kopi_set_settings")).toEqual([{ enabled: true, board: false }]);
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Papan bulanan/ })).not.toBeChecked());
    expect(p.notify).toHaveBeenCalledWith("Papan bulanan dimatikan.");
    expect(screen.getByText("Papan bulanan dimatikan")).toBeInTheDocument();
  });

  it("mematikan fitur meminta konfirmasi dulu, lalu setSettings(false, papan sekarang)", async () => {
    let settings = { enabled: true, board: false };
    answer({
      kopi_overview: () => kopiOverview({ isSuperadmin: true, enabled: settings.enabled, boardEnabled: settings.board }),
      kopi_set_settings: (args?: Record<string, unknown>) => {
        settings = { enabled: Boolean(args?.enabled), board: Boolean(args?.board) };
        return null;
      },
    });
    const { user, page: p } = renderPanel();
    const sw = await screen.findByRole("checkbox", { name: /Fitur Kopi/ });
    await user.click(sw);
    const dialog = await screen.findByRole("dialog", { name: "Matikan fitur Kopi?" });
    expect(calls("kopi_set_settings")).toEqual([]);

    await user.click(within(dialog).getByRole("button", { name: "Batal" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls("kopi_set_settings")).toEqual([]);
    expect(screen.getByRole("checkbox", { name: /Fitur Kopi/ })).toBeChecked();

    await user.click(screen.getByRole("checkbox", { name: /Fitur Kopi/ }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Matikan Kopi" }));
    expect(calls("kopi_set_settings")).toEqual([{ enabled: false, board: false }]);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(p.notify).toHaveBeenCalledWith("Fitur Kopi dimatikan untuk seluruh kantor.");
    expect(await screen.findByText("Fitur Kopi sedang dimatikan")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Fitur Kopi/ })).not.toBeChecked();
  });

  it("menyalakan fitur langsung menyimpan tanpa konfirmasi", async () => {
    answer({
      kopi_overview: kopiOverview({ isSuperadmin: true, enabled: false, boardEnabled: true }),
      kopi_board: (args?: Record<string, unknown>) => board(String(args?.month), [], false),
      kopi_set_settings: null,
    });
    const { user } = renderPanel();
    await user.click(await screen.findByRole("checkbox", { name: /Fitur Kopi/ }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls("kopi_set_settings")).toEqual([{ enabled: true, board: true }]);
  });

  it("sibuk saat menyimpan: kotak centang aria-disabled, fokus tetap, klik diabaikan", async () => {
    answer({
      kopi_overview: kopiOverview({ isSuperadmin: true }),
      kopi_set_settings: () => new Promise(() => {}),
    });
    const { user } = renderPanel();
    const box = await screen.findByRole("checkbox", { name: /Papan bulanan/ });
    await user.click(box);
    expect(await screen.findByText("Menyimpan...")).toBeInTheDocument();
    expect(box).not.toBeDisabled();
    expect(box).toHaveFocus();
    expect(box).toHaveAttribute("aria-disabled", "true");
    expect(box).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Fitur Kopi/ })).toHaveAttribute("aria-disabled", "true");
    await user.click(box);
    await user.click(screen.getByRole("checkbox", { name: /Fitur Kopi/ }));
    expect(calls("kopi_set_settings")).toHaveLength(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("error saat menyimpan tampil di dekat sakelar", async () => {
    answer({
      kopi_overview: kopiOverview({ isSuperadmin: true }),
      kopi_set_settings: rustError("forbidden", "Hanya superadmin yang bisa mengubah pengaturan Kopi."),
    });
    const { user } = renderPanel();
    await user.click(await screen.findByRole("checkbox", { name: /Papan bulanan/ }));
    expect(await screen.findByText("Pengaturan Kopi belum tersimpan")).toBeInTheDocument();
    expect(screen.getByText("Hanya superadmin yang bisa mengubah pengaturan Kopi.")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Papan bulanan/ })).not.toHaveAttribute("aria-disabled");
  });

  it("error saat mematikan fitur tampil di dialog konfirmasi", async () => {
    answer({
      kopi_overview: kopiOverview({ isSuperadmin: true }),
      kopi_set_settings: rustError("database", "Database terkunci."),
    });
    const { user } = renderPanel();
    await user.click(await screen.findByRole("checkbox", { name: /Fitur Kopi/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Matikan Kopi" }));
    expect(await within(dialog).findByText("Database terkunci.")).toBeInTheDocument();
  });
});

describe("Kopi: tab di Organisasi", () => {
  it("anggota biasa membuka tab Kopi dan melihat papannya", async () => {
    invoke.mockImplementation(
      router({
        org_overview: memberOverview(),
        get_directory: directory(),
        org_fingerprint: "ABCD-EFGH",
        org_people: [],
        kopi_overview: kopiOverview(),
        kopi_board: (args?: Record<string, unknown>) => board(String(args?.month), ROWS),
      }),
    );
    const user = userEvent.setup();
    render(<OrgScreen state={appState() as AppState & { organization: OrgInfo }} onRefresh={vi.fn()} />);
    const tab = await screen.findByRole("button", { name: "Kopi" });
    await user.click(tab);
    expect(tab).toHaveAttribute("aria-current", "true");
    expect(await screen.findByRole("heading", { name: "Kopi", level: 2 })).toBeInTheDocument();
    expect(await screen.findByRole("list", { name: "Peringkat November 2026" })).toBeInTheDocument();
  });
});
