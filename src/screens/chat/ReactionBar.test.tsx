// Reaksi, reaksi cepat, menu Beri reaksi dan Simpan sticker, pesan sticker, emote sebaris,
// dan semua label penulis di daftar pesan (v0.5.1).
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSummary, MessageView, OfficeSticker, ReactionView, StickerCatalog } from "../../api/chat";
import type { LabelRef } from "../../api/org";
import { setLang } from "../../i18n/core";
import { renderInLang } from "../../test/i18n";
import { ChatActionsContext, type ChatActions } from "./ChatActions";
import { Conversation } from "./Conversation";
import {
  budi,
  CH,
  channel,
  dimas,
  file,
  ME,
  message,
  penguji,
  personView,
  sari,
  today,
  view,
  wulan,
} from "./conversationTestData";
import { PeopleLabelsProvider } from "./PeopleLabels";
import { reactorSummary } from "./ReactionBar";
import { resetStickerCatalog } from "./stickerCatalog";
import { clearStickerImageCache } from "./StickerImage";

const chat = vi.hoisted(() => ({
  messages: vi.fn(),
  markRead: vi.fn(),
  send: vi.fn(),
  deleteMessage: vi.fn(),
  messageReceipts: vi.fn(),
  stickers: vi.fn(),
  stickerImage: vi.fn(),
  react: vi.fn(),
  emojiUsed: vi.fn(),
  saveSticker: vi.fn(),
  pickFiles: vi.fn(),
}));

const org = vi.hoisted(() => ({ people: vi.fn() }));

vi.mock("../../api/chat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/chat")>()),
  chatApi: chat,
  subscribeChat: () => () => {},
}));

vi.mock("../../api/org", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/org")>()),
  orgApi: org,
  subscribeOrg: () => () => {},
}));

const KOPI: OfficeSticker = {
  id: "9".repeat(32),
  pack: "Kantor",
  name: "kopi",
  keywords: [],
  hash: "k".repeat(64),
  mime: "image/png",
  size: 2048,
  state: "active",
  ready: true,
  nameTaken: false,
};

function catalog(extra: Partial<StickerCatalog> = {}): StickerCatalog {
  return { office: [KOPI], mine: [], canManage: false, recentEmoji: ["🙏"], ...extra };
}

function rx(emoji: string, people: typeof sari[], extra: Partial<ReactionView> = {}): ReactionView {
  return { emoji, count: people.length, mine: people.some((p) => p.publicKey === ME), people, ...extra };
}

// Pesan Sari (orang lain) dengan dua reaksi, dan pesan saya tanpa reaksi.
function messages(): MessageView[] {
  return [
    message({
      id: "m1",
      text: "Draft kontraknya sudah saya kirim.",
      reactions: [rx("👍", [budi, dimas, penguji]), rx("😂", [budi])],
    }),
    message({ id: "m4", author: penguji, mine: true, canDelete: true, at: today(10, 2), text: "Siap, saya cek." }),
  ];
}

function actions(): ChatActions {
  return { me: ME, canMessage: (pk) => pk !== ME, openDm: vi.fn(async () => {}), showProfile: vi.fn() };
}

function tree(summary: ConversationSummary = channel()) {
  return (
    <PeopleLabelsProvider>
      <ChatActionsContext.Provider value={actions()}>
        <Conversation summary={summary} me={ME} onChanged={() => {}} onGone={() => {}} />
      </ChatActionsContext.Provider>
    </PeopleLabelsProvider>
  );
}

const renderConv = (summary?: ConversationSummary) => render(tree(summary));

// StickerImage menampilkan pengganti selagi gambar dimuat, lalu menggantinya dengan <img>.
function loadedImage(name: string): Promise<HTMLElement> {
  return vi.waitFor(() => {
    const el = screen.getByRole("img", { name });
    expect(el.tagName).toBe("IMG");
    return el;
  });
}

const itemNames = () => screen.getAllByRole("menuitem").map((m) => m.textContent);
const messageItem = (text: string) => screen.getByText(text).closest("li") as HTMLElement;

beforeEach(() => {
  setLang("id");
  resetStickerCatalog(null);
  clearStickerImageCache();
  chat.messages.mockReset().mockResolvedValue(view(messages()));
  chat.markRead.mockResolvedValue(null);
  chat.stickers.mockReset().mockResolvedValue(catalog());
  chat.stickerImage.mockResolvedValue("data:image/png;base64,AAAA");
  chat.react.mockReset().mockResolvedValue(null);
  chat.emojiUsed.mockReset().mockResolvedValue(null);
  chat.saveSticker.mockReset().mockResolvedValue({});
  chat.pickFiles.mockResolvedValue([]);
  org.people.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  setLang("id");
});

describe("Chip reaksi", () => {
  it("chip di pesan orang lain: emoji, jumlah, aria-pressed, dan siapa saja", async () => {
    renderConv();
    const bar = await screen.findByRole("list", { name: "Reaksi untuk pesan Sari Uji pukul 09.12" });
    const thumbs = within(bar).getByRole("button", { name: "jempol 3. Budi Uji, Dimas Uji, Anda." });
    expect(thumbs).toHaveTextContent("👍3");
    expect(thumbs).toHaveAttribute("aria-pressed", "true");
    const laugh = within(bar).getByRole("button", { name: /^tertawa sampai menangis 1\. Budi Uji\.$/ });
    expect(laugh).toHaveAttribute("aria-pressed", "false");
  });

  it("klik chip saya menghapus reaksi, klik chip lain menambah dan mencatat emoji", async () => {
    const user = userEvent.setup();
    renderConv();
    const thumbs = await screen.findByRole("button", { name: /^jempol 3/ });
    await user.click(thumbs);
    expect(chat.react).toHaveBeenCalledWith(CH, "m1", "👍", false);
    expect(chat.emojiUsed).not.toHaveBeenCalled();
    expect(await screen.findByText("Reaksi jempol dihapus.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^tertawa sampai menangis 1/ }));
    expect(chat.react).toHaveBeenCalledWith(CH, "m1", "😂", true);
    await vi.waitFor(() => expect(chat.emojiUsed).toHaveBeenCalledWith("😂"));
    // Percakapan dimuat ulang setelah setiap reaksi.
    expect(chat.messages.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("fokus atau arahkan ke chip: keterangan siapa saja, Esc menyembunyikan", async () => {
    const people = [budi, dimas, wulan, sari];
    chat.messages.mockResolvedValue(view([message({ id: "m1", text: "Halo", reactions: [rx("👍", people)] })]));
    renderConv();
    const chip = await screen.findByRole("button", { name: "jempol 4. Budi Uji, Dimas Uji, Wulan Uji, Sari Uji." });
    act(() => chip.focus());
    expect(await screen.findByText("Budi Uji, Dimas Uji, dan 2 lainnya memberi 👍")).toBeInTheDocument();
    fireEvent.keyDown(chip, { key: "Escape" });
    expect(screen.queryByText(/memberi 👍/)).toBeNull();
    expect(chip).toHaveFocus();
    fireEvent.mouseEnter(chip);
    expect(screen.getByText("Budi Uji, Dimas Uji, dan 2 lainnya memberi 👍")).toBeInTheDocument();
    fireEvent.mouseLeave(chip);
    expect(screen.queryByText(/memberi 👍/)).toBeNull();
  });

  it("ringkasan nama: satu, dua, tiga orang, lalu lainnya", () => {
    expect(reactorSummary(rx("👍", [budi]), ME)).toBe("Budi Uji");
    expect(reactorSummary(rx("👍", [budi, penguji]), ME)).toBe("Budi Uji dan Anda");
    expect(reactorSummary(rx("👍", [budi, dimas, sari]), ME)).toBe("Budi Uji, Dimas Uji, dan Sari Uji");
    expect(reactorSummary(rx("👍", [budi], { count: 5 }), ME)).toBe("Budi Uji dan 4 lainnya");
  });

  it("canReact false: chip tetap bisa difokus tetapi tidak menyimpan reaksi, tanpa + dan reaksi cepat", async () => {
    const user = userEvent.setup();
    chat.messages.mockResolvedValue(view(messages(), { canReact: false }));
    renderConv(channel({ archived: true, canPost: false }));
    const thumbs = await screen.findByRole("button", { name: /^jempol 3/ });
    expect(thumbs).toHaveAttribute("aria-disabled", "true");
    expect(thumbs).not.toBeDisabled();
    await user.click(thumbs);
    expect(chat.react).not.toHaveBeenCalled();
    act(() => thumbs.focus());
    expect(thumbs).toHaveFocus();
    expect(screen.getByText("Reaksi tidak bisa diubah di percakapan ini.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Beri reaksi ke pesan/ })).toBeNull();
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("tombol + membuka pemilih emoji; memilih menambah reaksi lalu fokus kembali ke +", async () => {
    const user = userEvent.setup();
    renderConv();
    const add = await screen.findByRole("button", { name: "Beri reaksi ke pesan Sari Uji pukul 09.12" });
    await user.click(add);
    expect(add).toHaveAttribute("aria-expanded", "true");
    const picker = screen.getByRole("dialog", { name: "Pilih reaksi untuk pesan Sari Uji pukul 09.12" });
    expect(within(picker).getByRole("textbox", { name: "Cari emoji" })).toHaveFocus();
    await user.keyboard("terima kasih");
    await user.click(within(picker).getByRole("button", { name: "terima kasih" }));
    expect(chat.react).toHaveBeenCalledWith(CH, "m1", "🙏", true);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(add).toHaveFocus();
  });
});

describe("Klik ganda, fokus setelah chip hilang, dan klik di luar pemilih", () => {
  it("klik kedua selagi menyimpan diabaikan dan chip ditandai sibuk", async () => {
    const user = userEvent.setup();
    let finish: () => void = () => {};
    chat.react.mockImplementation(() => new Promise((resolve) => (finish = () => resolve(null))));
    renderConv();
    const laugh = await screen.findByRole("button", { name: /^tertawa sampai menangis 1/ });
    await user.click(laugh);
    await user.click(laugh);
    expect(chat.react).toHaveBeenCalledTimes(1);
    expect(laugh).toHaveAttribute("aria-busy", "true");
    await act(async () => finish());
    await vi.waitFor(() => expect(laugh).not.toHaveAttribute("aria-busy"));
    expect(screen.getAllByText("Reaksi tertawa sampai menangis ditambahkan.")).toHaveLength(1);
  });

  it("melepas reaksi terakhir saya: fokus pindah ke chip berikutnya, bukan ke body", async () => {
    const user = userEvent.setup();
    chat.messages.mockResolvedValue(
      view([message({ id: "m1", text: "Halo", reactions: [rx("👍", [penguji]), rx("😂", [budi])] })]),
    );
    chat.react.mockImplementation(async () => {
      chat.messages.mockResolvedValue(view([message({ id: "m1", text: "Halo", reactions: [rx("😂", [budi])] })]));
      return null;
    });
    renderConv();
    await user.click(await screen.findByRole("button", { name: /^jempol 1/ }));
    expect(chat.react).toHaveBeenCalledWith(CH, "m1", "👍", false);
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: /^jempol/ })).toBeNull());
    expect(screen.getByRole("button", { name: /^tertawa sampai menangis 1/ })).toHaveFocus();
  });

  it("chip terakhir hilang bersama bar: fokus ke Beri reaksi lain", async () => {
    const user = userEvent.setup();
    chat.messages.mockResolvedValue(view([message({ id: "m1", text: "Halo", reactions: [rx("👍", [penguji])] })]));
    chat.react.mockImplementation(async () => {
      chat.messages.mockResolvedValue(view([message({ id: "m1", text: "Halo" })]));
      return null;
    });
    renderConv();
    await user.click(await screen.findByRole("button", { name: /^jempol 1/ }));
    await vi.waitFor(() => expect(screen.queryByRole("list", { name: /^Reaksi untuk pesan/ })).toBeNull());
    expect(screen.getByRole("button", { name: "Beri reaksi lain ke pesan Sari Uji pukul 09.12" })).toHaveFocus();
  });

  it("klik di luar pemilih menutupnya tanpa menarik fokus kembali", async () => {
    const user = userEvent.setup();
    renderConv();
    const add = await screen.findByRole("button", { name: "Beri reaksi ke pesan Sari Uji pukul 09.12" });
    await user.click(add);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByText("Siap, saya cek."));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(add).not.toHaveFocus();
  });
});

describe("Reaksi cepat di bilah aksi", () => {
  it("pesan orang lain: satu tab stop, panah berpindah, Enter memberi reaksi", async () => {
    const user = userEvent.setup();
    renderConv();
    await screen.findByText("Draft kontraknya sudah saya kirim.");
    const bar = within(messageItem("Draft kontraknya sudah saya kirim.")).getByRole("toolbar", {
      name: "Reaksi cepat untuk pesan Sari Uji pukul 09.12",
    });
    const buttons = within(bar).getAllByRole("button");
    expect(buttons.map((b) => b.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);
    expect(buttons[0]).toHaveAttribute("aria-pressed", "true");
    act(() => buttons[0].focus());
    await user.keyboard("{ArrowRight}");
    expect(buttons[1]).toHaveFocus();
    expect(buttons[1]).toHaveAccessibleName(/^Beri reaksi /);
    await user.keyboard("{Enter}");
    expect(chat.react).toHaveBeenCalledWith(CH, "m1", "❤️", true);
  });

  it("pesan saya sendiri juga bisa diberi reaksi", async () => {
    const user = userEvent.setup();
    renderConv();
    await screen.findByText("Siap, saya cek.");
    const bar = within(messageItem("Siap, saya cek.")).getByRole("toolbar", {
      name: "Reaksi cepat untuk pesan Anda pukul 10.02",
    });
    await user.click(within(bar).getByRole("button", { name: "Beri reaksi jempol" }));
    expect(chat.react).toHaveBeenCalledWith(CH, "m4", "👍", true);
  });

  it("Beri reaksi lain lewat keyboard: End, Enter membuka pemilih, Esc menutup dan fokus kembali", async () => {
    const user = userEvent.setup();
    renderConv();
    await screen.findByText("Draft kontraknya sudah saya kirim.");
    const bar = within(messageItem("Draft kontraknya sudah saya kirim.")).getByRole("toolbar");
    act(() => within(bar).getAllByRole("button")[0].focus());
    await user.keyboard("{End}");
    const more = within(bar).getByRole("button", { name: "Beri reaksi lain ke pesan Sari Uji pukul 09.12" });
    expect(more).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(more.closest("li")).toHaveClass("conv-msg-menu-open");
    const picker = screen.getByRole("dialog", { name: "Pilih reaksi untuk pesan Sari Uji pukul 09.12" });
    // Emote kantor ikut di pemilih.
    expect(within(picker).getByRole("tab", { name: "Emote kantor" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(more).toHaveFocus();
    expect(chat.react).not.toHaveBeenCalled();
  });

  it("pesan dihapus tidak punya reaksi cepat", async () => {
    chat.messages.mockResolvedValue(view([message({ id: "m3", author: budi, text: "", deleted: true })]));
    renderConv();
    await screen.findByText("Pesan dihapus", { selector: "p" });
    expect(screen.queryByRole("toolbar")).toBeNull();
  });
});

describe("Menu pesan: Beri reaksi dan Simpan sticker", () => {
  const stickerMessage = (extra: Partial<MessageView["sticker"] & object> = {}, fileExtra = {}) =>
    message({
      id: "s1",
      text: ":kopi:",
      files: [file({ hash: KOPI.hash, name: "kopi.sticker.png", mime: "image/png", size: 2048, ...fileExtra })],
      sticker: { hash: KOPI.hash, name: "kopi", mime: "image/png", size: 2048, ready: true, saved: false, ...extra },
    });

  it("Beri reaksi membuka pemilih; Esc mengembalikan fokus ke pembuka menu", async () => {
    const user = userEvent.setup();
    renderConv();
    const reply = await screen.findByRole("button", { name: "Balas pesan Sari Uji pukul 09.12" });
    act(() => reply.focus());
    await user.keyboard("{Shift>}{F10}{/Shift}");
    await user.click(screen.getByRole("menuitem", { name: "Beri reaksi" }));
    expect(screen.getByRole("dialog", { name: "Pilih reaksi untuk pesan Sari Uji pukul 09.12" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(reply).toHaveFocus();
  });

  it("tanpa canReact tidak ada Beri reaksi", async () => {
    chat.messages.mockResolvedValue(view(messages(), { canReact: false }));
    renderConv();
    fireEvent.contextMenu(await screen.findByText("Draft kontraknya sudah saya kirim."));
    expect(itemNames()).not.toContain("Beri reaksi");
  });

  it("Simpan sticker untuk sticker yang siap dan belum disimpan, lalu diumumkan", async () => {
    const user = userEvent.setup();
    chat.messages.mockResolvedValue(view([stickerMessage()]));
    renderConv();
    fireEvent.contextMenu(await loadedImage(":kopi:"));
    expect(itemNames()).toEqual(["Balas", "Beri reaksi", "Sebut Sari Uji", "Simpan sticker"]);
    const before = chat.stickers.mock.calls.length;
    await user.click(screen.getByRole("menuitem", { name: "Simpan sticker" }));
    expect(chat.saveSticker).toHaveBeenCalledWith("s1");
    expect(await screen.findByText("Sticker disimpan ke koleksi Anda.")).toBeInTheDocument();
    expect(chat.stickers.mock.calls.length).toBeGreaterThan(before);
  });

  it("Simpan sticker tidak muncul kalau sudah disimpan atau gambarnya belum ada", async () => {
    chat.messages.mockResolvedValue(
      view([
        stickerMessage({ saved: true }),
        { ...stickerMessage({ ready: false }, { state: "fetching" }), id: "s2", at: today(9, 40) },
      ]),
    );
    renderConv();
    await vi.waitFor(() => expect(document.querySelector("img.sticker-img")).not.toBeNull());
    const items = screen.getAllByRole("img", { name: ":kopi:" });
    fireEvent.contextMenu(items[0]);
    expect(itemNames()).not.toContain("Simpan sticker");
    await userEvent.setup().keyboard("{Escape}");
    fireEvent.contextMenu(items[1]);
    expect(itemNames()).not.toContain("Simpan sticker");
  });

  it("Simpan sticker gagal: pesan tampil di layar", async () => {
    const user = userEvent.setup();
    chat.saveSticker.mockRejectedValue({ code: "x", message: "Koleksi penuh." });
    chat.messages.mockResolvedValue(view([stickerMessage()]));
    renderConv();
    fireEvent.contextMenu(await loadedImage(":kopi:"));
    await user.click(screen.getByRole("menuitem", { name: "Simpan sticker" }));
    expect(await screen.findByText("Sticker belum tersimpan. Koleksi penuh.")).toBeInTheDocument();
  });

  it("hapus pesan sticker: label tetap Hapus pesan, konfirmasi menyebut sticker", async () => {
    const user = userEvent.setup();
    chat.messages.mockResolvedValue(view([{ ...stickerMessage(), canDelete: true }]));
    renderConv();
    fireEvent.contextMenu(await loadedImage(":kopi:"));
    await user.click(screen.getByRole("menuitem", { name: "Hapus pesan" }));
    const dialog = await screen.findByRole("dialog", { name: "Hapus pesan ini?" });
    expect(dialog).toHaveTextContent("Sticker ini dihapus untuk semua orang di #proyek-a");
  });
});

describe("Pesan sticker", () => {
  it("gambar besar tanpa kartu file dan tanpa teks :nama:", async () => {
    chat.messages.mockResolvedValue(
      view([
        message({
          id: "s1",
          text: ":kopi:",
          files: [file({ hash: KOPI.hash, name: "kopi.sticker.png", mime: "image/png" })],
          sticker: { hash: KOPI.hash, name: "kopi", mime: "image/png", size: 2048, ready: true, saved: false },
        }),
      ]),
    );
    renderConv();
    const img = await loadedImage(":kopi:");
    expect(img).toHaveClass("sticker-img-large");
    expect(screen.queryByText("kopi.sticker.png")).toBeNull();
    expect(screen.queryByRole("list", { name: "Lampiran" })).toBeNull();
    expect(img.closest("li")).toHaveTextContent("Sari Uji");
  });

  it("belum siap: placeholder :nama: dan keterangan sedang diambil atau menunggu rekan", async () => {
    const sticker = { hash: KOPI.hash, name: "kopi", mime: "image/png", size: 2048, ready: false, saved: false };
    chat.messages.mockResolvedValue(
      view([
        message({ id: "s1", text: ":kopi:", files: [file({ hash: KOPI.hash, state: "fetching" })], sticker }),
        message({ id: "s2", at: today(9, 40), text: ":kopi:", files: [file({ hash: KOPI.hash, state: "missing" })], sticker }),
      ]),
    );
    renderConv();
    const waits = await screen.findAllByRole("img", { name: ":kopi:" });
    expect(waits[0]).toHaveTextContent(":kopi:");
    expect(screen.getByText("Gambar sticker sedang diambil dari laptop rekan.")).toBeInTheDocument();
    expect(screen.getByText("Gambar sticker muncul setelah laptop rekan yang menyimpannya online.")).toBeInTheDocument();
    expect(chat.stickerImage).not.toHaveBeenCalled();
  });
});

describe("Emote sebaris", () => {
  it(":kopi: jadi gambar kecil, nama yang tidak dikenal tetap teks", async () => {
    chat.messages.mockResolvedValue(view([message({ id: "m1", text: "Pagi :kopi: dan :teh: jam 10:30:45" })]));
    renderConv();
    const img = await loadedImage(":kopi:");
    expect(img).toHaveClass("sticker-img-inline");
    const p = img.closest("p")!;
    expect(p).toHaveTextContent("Pagi dan :teh: jam 10:30:45");
    expect(p).not.toHaveClass("conv-text-jumbo");
  });

  it("pesan berisi 1 sampai 3 emoji atau emote tampil lebih besar", async () => {
    chat.messages.mockResolvedValue(
      view([
        message({ id: "m1", text: "👍 :kopi:" }),
        message({ id: "m2", at: today(9, 13), text: "👍👍👍👍" }),
      ]),
    );
    renderConv();
    const img = await loadedImage(":kopi:");
    expect(img.closest("p")).toHaveClass("conv-text-jumbo");
    expect(screen.getByText("👍👍👍👍").closest("p")).not.toHaveClass("conv-text-jumbo");
  });
});

describe("Semua label penulis", () => {
  const MANY: LabelRef[] = ["Arsitek", "Drafter", "Surveyor", "Pengawas lapangan", "Estimator biaya"].map((name, i) => ({
    id: String(i).repeat(32),
    name,
  }));

  it("pesan orang lain dan pesan saya menampilkan semua label (lebih dari tiga)", async () => {
    org.people.mockResolvedValue([
      { ...personView(sari, "Desain"), labels: MANY },
      { ...personView(penguji, "Desain"), labels: MANY.slice(1) },
    ]);
    renderConv();
    await screen.findAllByText("Estimator biaya");
    const other = messageItem("Draft kontraknya sudah saya kirim.");
    const mine = messageItem("Siap, saya cek.");
    const labelsOf = (li: HTMLElement) =>
      [...li.querySelectorAll(".conv-msg-head .lab:not(.lab-more)")].map((el) => el.firstChild?.textContent);
    expect(labelsOf(other)).toEqual(MANY.map((l) => l.name));
    expect(labelsOf(mine)).toEqual(MANY.slice(1).map((l) => l.name));
    expect(other.querySelector(".lab-more")).toBeNull();
    expect(mine.querySelector(".conv-msg-head")).toHaveTextContent(/^Anda/);
  });
});

describe("Bahasa Inggris", () => {
  it("chip, reaksi cepat, menu, dan keterangan sticker", async () => {
    chat.messages.mockResolvedValue(
      view([
        ...messages(),
        message({
          id: "s1",
          at: today(10, 30),
          text: ":kopi:",
          files: [file({ hash: KOPI.hash, state: "missing" })],
          sticker: { hash: KOPI.hash, name: "kopi", mime: "image/png", size: 2048, ready: false, saved: false },
        }),
      ]),
    );
    renderInLang(() => tree());
    expect(
      await screen.findByRole("button", { name: "thumbs up 3. Budi Uji, Dimas Uji, You." }),
    ).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Reactions to message from Sari Uji at 09:12" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "React with thumbs up" }).length).toBeGreaterThan(0);
    expect(
      screen.getByText("The sticker image appears once a colleague's laptop that has it comes online."),
    ).toBeInTheDocument();
    fireEvent.contextMenu(screen.getByText("Draft kontraknya sudah saya kirim."));
    expect(itemNames()).toContain("React");
    act(() => screen.getByRole("button", { name: /^thumbs up 3/ }).focus());
    expect(screen.getByText("Budi Uji, Dimas Uji, and You reacted with 👍")).toBeInTheDocument();
  });
});
