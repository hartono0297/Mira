import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KopiBadge, KopiOverview, KopiTarget } from "../../api/kopi";
import { setLang } from "../../i18n/core";
import { ChatActionsContext, type ChatActions } from "./ChatActions";
import { Conversation } from "./Conversation";
import { channel, file, ME, message, PK_B, penguji, sari, today, view } from "./conversationTestData";
import { kopiMessageState, messageSnippet, SNIPPET_MAX } from "./kopiMenu";

const chat = vi.hoisted(() => ({
  messages: vi.fn(),
  send: vi.fn(),
  deleteMessage: vi.fn(),
  markRead: vi.fn(),
  setMuted: vi.fn(),
  messageReceipts: vi.fn(),
  fileOpen: vi.fn(),
  fileSave: vi.fn(),
  fileDownload: vi.fn(),
  pickFiles: vi.fn(),
}));

vi.mock("../../api/chat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/chat")>()),
  chatApi: chat,
  subscribeChat: () => () => {},
}));

const kopi = vi.hoisted(() => ({
  overview: null as KopiOverview | null,
  badges: [] as KopiBadge[],
  reload: vi.fn(async () => {}),
}));

vi.mock("../../components/useKopi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../components/useKopi")>()),
  useKopi: () => ({
    overview: kopi.overview,
    error: null,
    badgeOf: (pk: string) => kopi.badges.find((b) => b.publicKey === pk) ?? null,
    reload: kopi.reload,
  }),
}));

// Dialog Kopi punya tes sendiri; di sini cukup props yang diterimanya.
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

function actions(): ChatActions {
  return { me: ME, canMessage: (pk) => pk !== ME, openDm: vi.fn(async () => {}), showProfile: vi.fn() };
}

function renderConv() {
  render(
    <ChatActionsContext.Provider value={actions()}>
      <Conversation summary={channel()} me={ME} onChanged={() => {}} onGone={() => {}} />
    </ChatActionsContext.Provider>,
  );
}

const itemNames = () => screen.getAllByRole("menuitem").map((m) => m.textContent);

beforeEach(() => {
  setLang("id");
  kopi.overview = overview();
  kopi.badges = [];
  kopi.reload.mockClear();
  chat.messages.mockResolvedValue(
    view([
      message({ id: "m1", text: "Draft kontraknya sudah saya kirim." }),
      message({ id: "m2", author: penguji, mine: true, at: today(10, 2), text: "Siap, saya cek siang ini." }),
    ]),
  );
  chat.markRead.mockResolvedValue(null);
});

describe("kopiMessageState", () => {
  const rekan = message({ id: "m9", author: sari });

  it("tidak tampil saat ringkasan belum ada, fitur mati, atau saya Tamu", () => {
    expect(kopiMessageState(null, rekan)).toEqual({ show: false });
    expect(kopiMessageState(overview({ enabled: false }), rekan)).toEqual({ show: false });
    expect(kopiMessageState(overview({ canGive: false }), rekan)).toEqual({ show: false });
  });

  it("tidak tampil di pesan sendiri atau pesan terhapus", () => {
    expect(kopiMessageState(overview(), message({ mine: true, author: penguji }))).toEqual({ show: false });
    expect(kopiMessageState(overview(), message({ author: penguji }))).toEqual({ show: false });
    expect(kopiMessageState(overview(), message({ deleted: true, text: "" }))).toEqual({ show: false });
  });

  it("aktif untuk pesan rekan", () => {
    expect(kopiMessageState(overview(), rekan)).toEqual({ show: true, disabled: null });
  });

  it("nonaktif dengan alasan: sudah diberi, lalu jatah habis", () => {
    expect(kopiMessageState(overview({ givenTargets: ["message:m9"] }), rekan)).toEqual({
      show: true,
      disabled: "Sudah diberi kopi",
    });
    expect(kopiMessageState(overview({ givenToday: 3 }), rekan)).toEqual({
      show: true,
      disabled: "Jatah kopi hari ini habis",
    });
    // Target lain tidak memengaruhi pesan ini.
    expect(kopiMessageState(overview({ givenTargets: ["message:m1", `profile:${PK_B}:2026-11-24`] }), rekan)).toEqual({
      show: true,
      disabled: null,
    });
  });

  it("teks bahasa Inggris", () => {
    setLang("en");
    expect(kopiMessageState(overview({ givenToday: 3 }), rekan)).toEqual({ show: true, disabled: "No coffee left today" });
  });
});

describe("messageSnippet", () => {
  it("satu baris, dipendekkan dengan titik tiga", () => {
    expect(messageSnippet(message({ text: "Halo\n\nsemua  di sini" }))).toBe("Halo semua di sini");
    const long = messageSnippet(message({ text: "kata ".repeat(40) }));
    expect(long.length).toBeLessThanOrEqual(SNIPPET_MAX);
    expect(long.endsWith("...")).toBe(true);
  });

  it("pesan tanpa teks memakai nama lampiran", () => {
    expect(messageSnippet(message({ text: "", files: [file({ name: "kontrak.pdf" })] }))).toBe("kontrak.pdf");
  });
});

describe("Menu pesan: Beri kopi", () => {
  it("tampil di pesan rekan setelah Sebut, tidak di pesan sendiri", async () => {
    renderConv();
    fireEvent.contextMenu(await screen.findByText("Draft kontraknya sudah saya kirim."));
    expect(itemNames()).toEqual(["Balas", "Beri reaksi", "Salin teks", "Sebut Sari Uji", "Beri kopi"]);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });

    fireEvent.contextMenu(screen.getByText("Siap, saya cek siang ini."));
    expect(itemNames()).not.toContain("Beri kopi");
  });

  it("tidak tampil saat ringkasan Kopi tidak ada (di luar aplikasi desktop)", async () => {
    kopi.overview = null;
    renderConv();
    fireEvent.contextMenu(await screen.findByText("Draft kontraknya sudah saya kirim."));
    expect(itemNames()).toEqual(["Balas", "Beri reaksi", "Salin teks", "Sebut Sari Uji"]);
  });

  it("nonaktif dengan alasan yang dibacakan kalau pesan sudah diberi kopi", async () => {
    const user = userEvent.setup();
    kopi.overview = overview({ givenTargets: ["message:m1"] });
    renderConv();
    fireEvent.contextMenu(await screen.findByText("Draft kontraknya sudah saya kirim."));
    const item = screen.getByRole("menuitem", { name: "Beri kopi" });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveAccessibleDescription("Sudah diberi kopi");
    await user.click(item);
    expect(screen.queryByRole("dialog", { name: "Dialog kopi tiruan" })).toBeNull();
  });

  it("memilihnya membuka dialog untuk penulis pesan dengan target pesan dan cuplikan", async () => {
    const user = userEvent.setup();
    renderConv();
    fireEvent.contextMenu(await screen.findByText("Draft kontraknya sudah saya kirim."));
    await user.click(screen.getByRole("menuitem", { name: "Beri kopi" }));
    const dlg = screen.getByRole("dialog", { name: "Dialog kopi tiruan" });
    expect(dlg).toHaveTextContent("untuk Sari Uji");
    expect(dlg).toHaveTextContent('target {"kind":"message","id":"m1"}');
    expect(dlg).toHaveTextContent("konteks Draft kontraknya sudah saya kirim.");

    await user.click(screen.getByRole("button", { name: "Tiruan terkirim" }));
    // Dialog sudah memuat ulang ringkasan; menu tidak memuat ulang lagi.
    expect(kopi.reload).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Tiruan tutup" }));
    expect(screen.queryByRole("dialog", { name: "Dialog kopi tiruan" })).toBeNull();
    // Diumumkan lewat live region percakapan, yang tetap ada setelah dialog tertutup.
    expect(screen.getByText("Kopi terkirim untuk Sari Uji.")).toBeInTheDocument();
  });
});

describe("Ikon kopi di samping nama pengirim", () => {
  function tierBadge(tier: KopiBadge["tier"]): KopiBadge {
    return { publicKey: PK_B, peer: 5, work: 4, score: 19, tier };
  }

  it("tidak tampil untuk Anak baru di chat", async () => {
    kopi.badges = [tierBadge("anak_baru")];
    renderConv();
    await screen.findByText("Draft kontraknya sudah saya kirim.");
    expect(screen.queryByRole("img", { name: /kopi/ })).toBeNull();
  });

  it("tampil mulai Andalan", async () => {
    kopi.badges = [tierBadge("andalan")];
    renderConv();
    expect(await screen.findByRole("img", { name: "Andalan, 9 kopi" })).toBeInTheDocument();
  });
});
