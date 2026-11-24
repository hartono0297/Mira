// Komponen fitur Kopi: ikon di samping nama, dialog Beri kopi, bagian Kopi di profil.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KopiBadge, KopiOverview, KopiProfile } from "../api/kopi";
import { renderInLang } from "../test/i18n";
import { KopiGiveDialog } from "./KopiGiveDialog";
import { KopiMark } from "./KopiMark";
import { KopiProfileSection } from "./KopiProfileSection";
import { kopiToday } from "./kopiText";
import { KOPI_EVENT_DELAY_MS, reloadKopi, resetKopiStore, useKopi } from "./useKopi";

const api = vi.hoisted(() => ({
  overview: vi.fn(),
  profile: vi.fn(),
  give: vi.fn(),
  hide: vi.fn(),
  setSettings: vi.fn(),
  board: vi.fn(),
}));

// Event fitur dipicu langsung dari tes.
const feature = vi.hoisted(() => ({ handlers: new Map<string, Set<() => void>>() }));

function fire(topic: string) {
  for (const h of feature.handlers.get(topic) ?? []) h();
}

vi.mock("../api", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../api")>();
  return {
    ...orig,
    subscribeFeature: (topic: string, handler: () => void) => {
      const set = feature.handlers.get(topic) ?? new Set<() => void>();
      set.add(handler);
      feature.handlers.set(topic, set);
      return () => set.delete(handler);
    },
  };
});

vi.mock("../api/kopi", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../api/kopi")>();
  return { ...orig, kopiApi: api };
});

const ME = "a".repeat(64);
const PK_B = "b".repeat(64);
const PK_C = "c".repeat(64);

function overview(over: Partial<KopiOverview> = {}): KopiOverview {
  return {
    enabled: true,
    boardEnabled: true,
    isSuperadmin: false,
    canGive: true,
    me: ME,
    givenToday: 1,
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
    ...over,
  };
}

function badge(publicKey: string, peer: number, work: number, tier: KopiBadge["tier"]): KopiBadge {
  return { publicKey, peer, work, score: peer * 3 + work, tier };
}

function profile(over: Partial<KopiProfile> = {}): KopiProfile {
  return {
    person: { publicKey: PK_B, name: "Budi" },
    peer: 4,
    work: 7,
    score: 19,
    tier: "andalan",
    next: { tier: "senior", minScore: 60 },
    history: [
      {
        kind: "peer",
        id: "1".repeat(64),
        from: { publicKey: PK_C, name: "Citra" },
        target: { kind: "message", id: "m1" },
        reason: "Terima kasih sudah cek gambar lantai 2",
        at: "2026-11-24T09:00:00+07:00",
        hidden: false,
      },
      {
        kind: "work",
        id: "p1:t1",
        projectId: "p1",
        taskId: "t1",
        title: "Revisi denah",
        projectName: "Gedung A",
        why: "assigned",
        at: "2026-11-23T10:00:00Z",
      },
      {
        kind: "work",
        id: "p2:t2",
        projectId: "p2",
        taskId: "t2",
        title: null,
        projectName: null,
        why: "on_time",
        at: "2026-11-22T10:00:00Z",
      },
    ],
    ...over,
  };
}

// Tunggu ringkasan Kopi termuat dan dirender.
async function loaded() {
  await waitFor(() => expect(api.overview).toHaveBeenCalled());
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  resetKopiStore();
  feature.handlers.clear();
  api.overview.mockReset();
  api.overview.mockResolvedValue(overview());
  api.profile.mockResolvedValue(profile());
  api.give.mockResolvedValue(undefined);
  api.hide.mockResolvedValue(undefined);
});

describe("KopiMark", () => {
  it("tampil dengan tingkatan dan jumlah di nama aksesibel", async () => {
    api.overview.mockResolvedValue(overview({ badges: [badge(PK_B, 2, 3, "anak_baru"), badge(PK_C, 5, 4, "andalan")] }));
    render(
      <>
        <KopiMark publicKey={PK_B} />
        <KopiMark publicKey={PK_C} />
      </>,
    );
    expect(await screen.findByRole("img", { name: "Andalan, 9 kopi" })).toHaveAttribute("data-tier", "andalan");
    expect(screen.getByRole("img", { name: "Anak baru, 5 kopi" })).toBeInTheDocument();
  });

  it("minTier: chat hanya menampilkan Andalan ke atas", async () => {
    api.overview.mockResolvedValue(
      overview({ badges: [badge(PK_B, 2, 3, "anak_baru"), badge(PK_C, 5, 4, "andalan"), badge(ME, 70, 0, "legenda")] }),
    );
    render(
      <>
        <KopiMark publicKey={PK_B} minTier="andalan" />
        <KopiMark publicKey={PK_C} minTier="andalan" />
        <KopiMark publicKey={ME} minTier="andalan" />
      </>,
    );
    expect(await screen.findByRole("img", { name: "Andalan, 9 kopi" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Legenda, 70 kopi" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /Anak baru/ })).not.toBeInTheDocument();
  });

  it("tidak tampil untuk orang dengan skor 0 atau tanpa badge", async () => {
    api.overview.mockResolvedValue(overview({ badges: [badge(PK_B, 0, 0, "anak_baru")] }));
    const { container } = render(
      <>
        <KopiMark publicKey={PK_B} />
        <KopiMark publicKey={PK_C} />
      </>,
    );
    await loaded();
    expect(container).toBeEmptyDOMElement();
  });

  it("tidak tampil kalau fitur Kopi mati", async () => {
    api.overview.mockResolvedValue(overview({ enabled: false, badges: [badge(PK_B, 5, 4, "andalan")] }));
    const { container } = render(<KopiMark publicKey={PK_B} />);
    await loaded();
    expect(container).toBeEmptyDOMElement();
  });

  it("tidak tampil kalau ringkasan gagal dimuat (di luar aplikasi desktop)", async () => {
    api.overview.mockRejectedValue(new Error("no tauri"));
    const { container } = render(<KopiMark publicKey={PK_B} />);
    await loaded();
    expect(container).toBeEmptyDOMElement();
  });

  it("memakai teks Inggris", async () => {
    api.overview.mockResolvedValue(overview({ badges: [badge(PK_B, 0, 1, "anak_baru"), badge(PK_C, 60, 0, "legenda")] }));
    renderInLang(() => (
      <>
        <KopiMark publicKey={PK_B} />
        <KopiMark publicKey={PK_C} />
      </>
    ));
    expect(await screen.findByRole("img", { name: "Newcomer, 1 coffee" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Legend, 60 coffees" })).toBeInTheDocument();
  });
});

describe("useKopi", () => {
  function Probe({ onRender }: { onRender: () => void }) {
    const { overview: o } = useKopi();
    onRender();
    return <span>{o?.givenToday}</span>;
  }

  it("ringkasan yang sama tidak membuat snapshot baru (tidak render ulang)", async () => {
    const onRender = vi.fn();
    render(<Probe onRender={onRender} />);
    await loaded();
    const before = onRender.mock.calls.length;
    await act(async () => {
      await reloadKopi();
    });
    expect(api.overview).toHaveBeenCalledTimes(2);
    expect(onRender).toHaveBeenCalledTimes(before);

    api.overview.mockResolvedValue(overview({ givenToday: 2 }));
    await act(async () => {
      await reloadKopi();
    });
    expect(onRender.mock.calls.length).toBeGreaterThan(before);
  });

  it("hanya satu kopi_overview berjalan; permintaan selama itu jadi satu ulangan", async () => {
    const pending: ((o: KopiOverview) => void)[] = [];
    api.overview.mockImplementation(() => new Promise<KopiOverview>((r) => pending.push(r)));
    const a = reloadKopi();
    const b = reloadKopi();
    const c = reloadKopi();
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(api.overview).toHaveBeenCalledTimes(1);

    pending[0](overview());
    await new Promise((r) => setTimeout(r, 0));
    // Satu ulangan untuk b dan c, bukan dua.
    expect(api.overview).toHaveBeenCalledTimes(2);
    pending[1](overview({ givenToday: 2 }));
    await a;
    expect(api.overview).toHaveBeenCalledTimes(2);
  });

  it("event fitur dalam jendela 2 detik digabung jadi satu muat ulang", async () => {
    vi.useFakeTimers();
    render(<KopiMark publicKey={PK_B} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api.overview).toHaveBeenCalledTimes(1);

    fire("kopi");
    fire("board");
    fire("kopi");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(KOPI_EVENT_DELAY_MS - 1);
    });
    expect(api.overview).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(api.overview).toHaveBeenCalledTimes(2);
  });
});

describe("KopiGiveDialog", () => {
  const TO = { publicKey: PK_B, name: "Budi" };
  const TARGET = { kind: "message", id: "m1" } as const;

  function open() {
    const onClose = vi.fn();
    const onGiven = vi.fn();
    render(<KopiGiveDialog open onClose={onClose} onGiven={onGiven} to={TO} target={TARGET} context="Gambar sudah saya cek" />);
    return { onClose, onGiven };
  }

  it("fokus awal di isian alasan, menampilkan sisa jatah dan catatan alasan terlihat", async () => {
    open();
    const field = await screen.findByLabelText("Alasan");
    expect(field).toHaveFocus();
    expect(screen.getByRole("dialog", { name: "Beri kopi untuk Budi" })).toBeInTheDocument();
    expect(screen.getByText("Gambar sudah saya cek")).toBeInTheDocument();
    expect(field).toHaveAccessibleDescription(/Alasan terlihat oleh semua orang di kantor\./);
    expect(await screen.findByText("Sisa jatah hari ini: 2 dari 3 kopi.")).toBeInTheDocument();
  });

  it("menolak alasan kosong tanpa memanggil API", async () => {
    const user = userEvent.setup();
    open();
    await loaded();
    await user.click(screen.getByRole("button", { name: "Kirim kopi" }));
    expect(screen.getByText("Tulis alasannya dulu.")).toBeInTheDocument();
    expect(screen.getByLabelText("Alasan")).toHaveAttribute("aria-invalid", "true");
    expect(api.give).not.toHaveBeenCalled();
  });

  it("menolak alasan lebih dari batas", async () => {
    const user = userEvent.setup();
    open();
    await loaded();
    await user.click(screen.getByLabelText("Alasan"));
    await user.paste("x".repeat(121));
    expect(screen.getByText("Alasan paling banyak 120 karakter (sekarang 121).")).toBeInTheDocument();
    expect(screen.getByText("121 dari 120 karakter")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Kirim kopi" }));
    expect(api.give).not.toHaveBeenCalled();
  });

  it("mengirim input yang benar lalu menutup", async () => {
    const user = userEvent.setup();
    const { onClose, onGiven } = open();
    await loaded();
    await user.click(screen.getByLabelText("Alasan"));
    await user.paste("  Terima kasih sudah cek gambar  ");
    await user.click(screen.getByRole("button", { name: "Kirim kopi" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.give).toHaveBeenCalledWith({ to: PK_B, target: TARGET, reason: "Terima kasih sudah cek gambar" });
    // Nama penerima untuk pengumuman "Kopi terkirim untuk Budi."
    expect(onGiven).toHaveBeenCalledWith("Budi");
    // Ringkasan dimuat ulang sekali oleh dialog (muatan pertama + satu).
    await waitFor(() => expect(api.overview).toHaveBeenCalledTimes(2));
  });

  it("menampilkan error dari API dan tetap terbuka", async () => {
    const user = userEvent.setup();
    api.give.mockRejectedValue({ code: "forbidden", message: "Jatah kopi hari ini sudah habis." });
    const { onClose } = open();
    await loaded();
    await user.click(screen.getByLabelText("Alasan"));
    await user.paste("Terima kasih");
    await user.click(screen.getByRole("button", { name: "Kirim kopi" }));
    expect(await screen.findByText("Kopi belum terkirim")).toBeInTheDocument();
    expect(screen.getByText("Jatah kopi hari ini sudah habis.")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Kirim kopi" })).not.toHaveAttribute("aria-disabled");
    // Fokus kembali ke isian alasan supaya bisa langsung diperbaiki atau dikirim ulang.
    expect(screen.getByLabelText("Alasan")).toHaveFocus();
  });

  it("tombol kirim sibuk saat mengirim", async () => {
    const user = userEvent.setup();
    let finish: () => void = () => {};
    api.give.mockReturnValue(new Promise<void>((r) => (finish = r)));
    open();
    await loaded();
    await user.click(screen.getByLabelText("Alasan"));
    await user.paste("Terima kasih");
    await user.click(screen.getByRole("button", { name: "Kirim kopi" }));
    const busy = screen.getByRole("button", { name: "Mengirim kopi..." });
    // aria-disabled, bukan disabled: tombol yang baru diklik tetap memegang fokus.
    expect(busy).not.toBeDisabled();
    expect(busy).toHaveFocus();
    expect(busy).toHaveAttribute("aria-disabled", "true");
    expect(busy).toHaveAttribute("aria-busy", "true");
    await user.click(busy);
    expect(api.give).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });

  it("Escape menutup dialog", async () => {
    const user = userEvent.setup();
    const { onClose } = open();
    await screen.findByLabelText("Alasan");
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("menonaktifkan kirim kalau jatah hari ini habis", async () => {
    api.overview.mockResolvedValue(overview({ givenToday: 3 }));
    open();
    expect(await screen.findByText("Jatah 3 kopi hari ini sudah terpakai. Besok bisa memberi lagi.")).toBeInTheDocument();
    const send = screen.getByRole("button", { name: "Kirim kopi" });
    expect(send).toHaveAttribute("aria-disabled", "true");
    expect(send).toHaveAccessibleDescription("Jatah 3 kopi hari ini sudah terpakai. Besok bisa memberi lagi.");
  });

  it("memberi tahu kalau pesan ini sudah diberi kopi", async () => {
    api.overview.mockResolvedValue(overview({ givenTargets: ["message:m1"] }));
    open();
    expect(await screen.findByText("Anda sudah memberi kopi untuk ini.")).toBeInTheDocument();
    const send = screen.getByRole("button", { name: "Kirim kopi" });
    expect(send).toHaveAttribute("aria-disabled", "true");
    expect(send).toHaveAccessibleDescription("Anda sudah memberi kopi untuk ini.");
    const user = userEvent.setup();
    await user.click(send);
    expect(api.give).not.toHaveBeenCalled();
  });
});

describe("KopiProfileSection", () => {
  const BUDI = { publicKey: PK_B, name: "Budi" };

  it("menampilkan jumlah dari rekan dan dari kerja terpisah, tingkatan, dan progres", async () => {
    render(<KopiProfileSection person={BUDI} />);
    const section = await screen.findByRole("region", { name: "Kopi" });
    await within(section).findByText("Andalan");
    const peer = within(section).getByText("Dari rekan").closest("div")!;
    expect(within(peer).getByText("4")).toBeInTheDocument();
    const work = within(section).getByText("Dari kerja").closest("div")!;
    expect(within(work).getByText("7")).toBeInTheDocument();
    const bar = within(section).getByRole("progressbar", { name: "Menuju Senior" });
    expect(bar).toHaveAttribute("aria-valuenow", "19");
    expect(bar).toHaveAttribute("aria-valuemin", "15");
    expect(bar).toHaveAttribute("aria-valuemax", "60");
    expect(bar).toHaveAttribute("aria-valuetext", "Skor 19. Kurang 41 lagi untuk jadi Senior.");
  });

  it("menampilkan riwayat rekan dan kerja, termasuk task di proyek lain", async () => {
    render(<KopiProfileSection person={BUDI} />);
    expect(await screen.findByText("Terima kasih sudah cek gambar lantai 2")).toBeInTheDocument();
    expect(screen.getByText("Citra")).toBeInTheDocument();
    expect(screen.getByText("Citra").parentElement).toHaveTextContent("Citra, lewat pesan chat");
    expect(screen.getByText("Revisi denah")).toBeInTheDocument();
    expect(screen.getByText("Task dari rekan selesai")).toBeInTheDocument();
    expect(screen.getByText("Task di proyek lain")).toBeInTheDocument();
    expect(screen.getByText("Selesai tepat waktu")).toBeInTheDocument();
  });

  it("tombol Beri kopi mengirim dengan target profil hari ini, lalu mengumumkannya", async () => {
    const user = userEvent.setup();
    render(<KopiProfileSection person={BUDI} />);
    await user.click(await screen.findByRole("button", { name: "Beri kopi" }));
    expect(await screen.findByLabelText("Alasan")).toHaveFocus();
    await user.paste("Selalu sigap membantu");
    await user.click(screen.getByRole("button", { name: "Kirim kopi" }));
    await waitFor(() =>
      expect(api.give).toHaveBeenCalledWith({
        to: PK_B,
        target: { kind: "profile", day: kopiToday() },
        reason: "Selalu sigap membantu",
      }),
    );
    // Live region di luar dialog, tetap ada setelah dialog tertutup.
    expect(await screen.findByText("Kopi terkirim untuk Budi.")).toHaveAttribute("role", "status");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Profil dimuat ulang; ringkasan hanya sekali (oleh dialog), bukan dua kali.
    await waitFor(() => expect(api.profile).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(api.overview).toHaveBeenCalledTimes(2);
  });

  it("hari target profil ditetapkan saat tombol diklik, bukan saat render", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 24, 23, 59, 0));
    const user = userEvent.setup();
    render(<KopiProfileSection person={BUDI} />);
    const btn = await screen.findByRole("button", { name: "Beri kopi" });
    // Lewat tengah malam sebelum tombol diklik.
    vi.setSystemTime(new Date(2026, 10, 25, 0, 1, 0));
    await user.click(btn);
    await user.click(await screen.findByLabelText("Alasan"));
    await user.paste("Terima kasih");
    await user.click(screen.getByRole("button", { name: "Kirim kopi" }));
    await waitFor(() =>
      expect(api.give).toHaveBeenCalledWith({
        to: PK_B,
        target: { kind: "profile", day: "2026-11-25" },
        reason: "Terima kasih",
      }),
    );
  });

  it("dialog dibuka lagi dengan isian kosong", async () => {
    const user = userEvent.setup();
    render(<KopiProfileSection person={BUDI} />);
    await user.click(await screen.findByRole("button", { name: "Beri kopi" }));
    await user.paste("Alasan lama");
    await user.click(screen.getByRole("button", { name: "Batal" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Beri kopi" }));
    expect(await screen.findByLabelText("Alasan")).toHaveValue("");
  });

  it("tombol Beri kopi tidak tampil untuk diri sendiri", async () => {
    api.profile.mockResolvedValue(profile({ person: { publicKey: ME, name: "Andi" } }));
    render(<KopiProfileSection person={{ publicKey: ME, name: "Andi" }} />);
    await screen.findByText("Andalan");
    expect(screen.queryByRole("button", { name: "Beri kopi" })).not.toBeInTheDocument();
  });

  it("tombol Beri kopi tidak tampil untuk tamu", async () => {
    api.overview.mockResolvedValue(overview({ canGive: false }));
    render(<KopiProfileSection person={BUDI} />);
    await screen.findByText("Andalan");
    expect(screen.queryByRole("button", { name: "Beri kopi" })).not.toBeInTheDocument();
  });

  it("tombol Beri kopi nonaktif dengan keterangan kalau sudah memberi hari ini", async () => {
    const user = userEvent.setup();
    api.overview.mockResolvedValue(overview({ givenTargets: [`profile:${PK_B}:${kopiToday()}`] }));
    render(<KopiProfileSection person={BUDI} />);
    const btn = await screen.findByRole("button", { name: "Beri kopi" });
    expect(btn).toHaveAttribute("aria-disabled", "true");
    expect(btn).toHaveAccessibleDescription("Anda sudah memberi kopi lewat profil ini hari ini.");
    await user.click(btn);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("tombol Sembunyikan tidak tampil untuk bukan superadmin", async () => {
    render(<KopiProfileSection person={BUDI} />);
    await screen.findByText("Citra");
    expect(screen.queryByRole("button", { name: /Sembunyikan/ })).not.toBeInTheDocument();
  });

  it("superadmin bisa menyembunyikan dan melihat tanda entri tersembunyi", async () => {
    const user = userEvent.setup();
    api.overview.mockResolvedValue(overview({ isSuperadmin: true }));
    const base = profile();
    api.profile.mockResolvedValue({
      ...base,
      history: [
        {
          kind: "peer",
          id: "2".repeat(64),
          from: { publicKey: ME, name: "Andi" },
          target: { kind: "task", project: "p1", task: "t1" },
          reason: "Tidak pantas",
          at: "2026-11-24T08:00:00+07:00",
          hidden: true,
        },
        ...base.history,
      ],
    });
    render(<KopiProfileSection person={BUDI} />);
    // Nama aksesibel memuat waktu, supaya dua kopi dari orang yang sama bisa dibedakan.
    await user.click(await screen.findByRole("button", { name: /^Sembunyikan kopi dari Citra, .+/ }));
    expect(api.hide).toHaveBeenCalledWith("1".repeat(64), true);
    expect(screen.getByText("Disembunyikan")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Tampilkan lagi kopi dari Andi, .+/ }));
    expect(api.hide).toHaveBeenCalledWith("2".repeat(64), false);
  });

  it("tidak tampil kalau fitur mati, kecuali satu baris untuk superadmin", async () => {
    api.overview.mockResolvedValue(overview({ enabled: false }));
    const { container, unmount } = render(<KopiProfileSection person={BUDI} />);
    await loaded();
    expect(container).toBeEmptyDOMElement();
    expect(api.profile).not.toHaveBeenCalled();
    unmount();

    resetKopiStore();
    api.overview.mockResolvedValue(overview({ enabled: false, isSuperadmin: true }));
    render(<KopiProfileSection person={BUDI} />);
    expect(await screen.findByText(/Fitur Kopi sedang dimatikan/)).toBeInTheDocument();
  });

  it("menampilkan error dan bisa mencoba lagi", async () => {
    const user = userEvent.setup();
    api.profile.mockRejectedValueOnce({ code: "not_found", message: "Orang ini tidak dikenal." });
    render(<KopiProfileSection person={BUDI} />);
    expect(await screen.findByText("Kopi orang ini belum terbaca")).toBeInTheDocument();
    expect(screen.getByText("Orang ini tidak dikenal.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Coba lagi" }));
    expect(await screen.findByText("Andalan")).toBeInTheDocument();
  });

  it("riwayat kosong punya keterangan", async () => {
    api.profile.mockResolvedValue(profile({ peer: 0, work: 0, score: 0, tier: "anak_baru", history: [] }));
    render(<KopiProfileSection person={BUDI} />);
    expect(await screen.findByText(/Belum ada kopi\./)).toBeInTheDocument();
  });

  it("memakai teks Inggris", async () => {
    renderInLang(() => <KopiProfileSection person={BUDI} />);
    expect(await screen.findByText("Regular")).toBeInTheDocument();
    expect(screen.getByText("Level")).toBeInTheDocument();
    expect(screen.getByText("Citra").parentElement).toHaveTextContent("Citra, via a chat message");
    expect(screen.getByText("From colleagues")).toBeInTheDocument();
    expect(screen.getByText("From work")).toBeInTheDocument();
    expect(screen.getByText("Task in another project")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Give coffee" })).toBeInTheDocument();
  });
});
