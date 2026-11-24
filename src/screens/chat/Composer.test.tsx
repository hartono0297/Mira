import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSummary, MessageView, MySticker, OfficeSticker, StickerCatalog } from "../../api/chat";
import { findEmoji } from "../../components/emoji/emojiData";
import { setLang } from "../../i18n/core";
import { renderInLang } from "../../test/i18n";
import { Composer } from "./Composer";
import { budi, channel, CH, dm, DM, ME, message, PK_B, PK_C, penguji, project, sari } from "./conversationTestData";
import { resetStickerCatalog } from "./stickerCatalog";
import { clearStickerImageCache } from "./StickerImage";

const chat = vi.hoisted(() => ({
  send: vi.fn(),
  pickFiles: vi.fn(),
  stickers: vi.fn(),
  stickerImage: vi.fn(),
  emojiUsed: vi.fn(),
  sendSticker: vi.fn(),
  pickSticker: vi.fn(),
  addMySticker: vi.fn(),
  removeMySticker: vi.fn(),
}));

vi.mock("../../api/chat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/chat")>()),
  chatApi: chat,
  subscribeChat: () => () => {},
}));

const net = vi.hoisted(() => ({ value: null as unknown }));

vi.mock("../shell/NetworkContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shell/NetworkContext")>()),
  useNetworkOptional: () => net.value,
}));

function renderComposer(
  opts: { summary?: ConversationSummary; replyTo?: MessageView | null } = {},
) {
  const onSent = vi.fn();
  const onCancelReply = vi.fn();
  const inputRef = { current: null as HTMLTextAreaElement | null };
  render(
    <Composer
      summary={opts.summary ?? channel()}
      me={ME}
      members={[penguji, sari, budi]}
      replyTo={opts.replyTo ?? null}
      onCancelReply={onCancelReply}
      onSent={onSent}
      inputRef={inputRef}
    />,
  );
  return { onSent, onCancelReply, input: () => screen.getByRole("combobox", { name: /^Pesan untuk/ }) };
}

// Katalog sticker uji: dua paket kantor (satu sticker belum sampai) dan satu sticker pribadi.
const HASH = (c: string) => c.repeat(64);

function office(extra: Partial<OfficeSticker>): OfficeSticker {
  return {
    id: "1".repeat(32),
    pack: "Kantor",
    name: "kopi",
    keywords: ["ngopi"],
    hash: HASH("1"),
    mime: "image/png",
    size: 2048,
    state: "active",
    ready: true,
    nameTaken: false,
    ...extra,
  };
}

const kopi = office({});
const rapat = office({ id: "2".repeat(32), name: "rapat", keywords: ["meeting"], hash: HASH("2"), ready: false });
const hore = office({ id: "3".repeat(32), pack: "Perayaan", name: "hore", keywords: ["selamat"], hash: HASH("3") });
const kucing: MySticker = {
  id: "9".repeat(32),
  name: "kucing",
  keywords: ["lucu"],
  hash: HASH("9"),
  mime: "image/webp",
  size: 4096,
  addedAt: "2026-11-20T08:00:00Z",
};

function catalog(extra: Partial<StickerCatalog> = {}): StickerCatalog {
  return { office: [kopi, rapat, hore], mine: [kucing], canManage: false, recentEmoji: [], ...extra };
}

const COFFEE = findEmoji("☕")!.char;

beforeEach(() => {
  net.value = null;
  chat.send.mockImplementation(async () => message({ id: "baru", mine: true, author: penguji }));
  chat.pickFiles.mockResolvedValue([]);
  chat.stickers.mockResolvedValue(catalog());
  chat.stickerImage.mockResolvedValue("data:image/png;base64,AA==");
  chat.emojiUsed.mockResolvedValue(null);
  chat.sendSticker.mockImplementation(async () => message({ id: "stk", mine: true, author: penguji, text: ":kopi:" }));
  chat.pickSticker.mockResolvedValue(null);
  chat.addMySticker.mockResolvedValue(kucing);
  chat.removeMySticker.mockResolvedValue(null);
  clearStickerImageCache();
  resetStickerCatalog(catalog());
});

afterEach(() => {
  setLang("id");
});

describe("Komposer", () => {
  it("label dan placeholder sesuai percakapan", () => {
    const { input } = renderComposer();
    expect(input()).toHaveAttribute("placeholder", "Tulis pesan ke #proyek-a");
    expect(screen.getByLabelText("Pesan untuk #proyek-a")).toBe(input());
  });

  it("placeholder chat pribadi memakai nama rekan", () => {
    const { input } = renderComposer({ summary: dm() });
    expect(input()).toHaveAttribute("placeholder", "Tulis pesan ke Sari Uji");
  });

  it("Enter mengirim dengan mention, lalu kolom dikosongkan", async () => {
    const user = userEvent.setup();
    const { input, onSent } = renderComposer();
    await user.type(input(), "Halo @Sa");
    const list = screen.getByRole("listbox", { name: "Sebut rekan" });
    expect(list).toBeInTheDocument();
    expect(input()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("option", { name: "Sari Uji" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    expect(input()).toHaveValue("Halo @Sari Uji ");
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.type(input(), "dan @Budi Uji cek ya{Enter}");
    expect(chat.send).toHaveBeenCalledWith(CH, "Halo @Sari Uji dan @Budi Uji cek ya", null, [PK_B, PK_C], []);
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    expect(input()).toHaveValue("");
  });

  it("saran mention: panah memilih, Tab mengambil, Escape menutup", async () => {
    const user = userEvent.setup();
    const { input } = renderComposer();
    await user.type(input(), "@");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Sari Uji", "Budi Uji"]);
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: "Budi Uji" })).toHaveAttribute("aria-selected", "true");
    expect(input().getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: "Budi Uji" }).id);
    await user.keyboard("{Tab}");
    expect(input()).toHaveValue("@Budi Uji ");
    await user.type(input(), "@");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(chat.send).not.toHaveBeenCalled();
  });

  it("Shift+Enter membuat baris baru tanpa mengirim", async () => {
    const user = userEvent.setup();
    const { input } = renderComposer();
    await user.type(input(), "Baris satu{Shift>}{Enter}{/Shift}Baris dua");
    expect(input()).toHaveValue("Baris satu\nBaris dua");
    expect(chat.send).not.toHaveBeenCalled();
  });

  it("pesan kosong tidak dikirim", async () => {
    const user = userEvent.setup();
    const { input } = renderComposer();
    await user.type(input(), "   {Enter}");
    await user.click(screen.getByRole("button", { name: "Kirim" }));
    expect(chat.send).not.toHaveBeenCalled();
  });

  it("lampirkan file, hapus satu, lalu kirim", async () => {
    const user = userEvent.setup();
    chat.pickFiles.mockResolvedValue([
      { path: "C:\\Uji\\kontrak.pdf", name: "kontrak.pdf", size: 1258291 },
      { path: "C:\\Uji\\foto.jpg", name: "foto.jpg", size: 2048 },
    ]);
    renderComposer();
    await user.click(screen.getByRole("button", { name: "Lampirkan file" }));
    expect(await screen.findByText("kontrak.pdf")).toBeInTheDocument();
    expect(screen.getByText("1,2 MB")).toBeInTheDocument();
    expect(screen.getByText("foto.jpg")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hapus lampiran foto.jpg" }));
    expect(screen.queryByText("foto.jpg")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Kirim" }));
    expect(chat.send).toHaveBeenCalledWith(CH, "", null, [], ["C:\\Uji\\kontrak.pdf"]);
    await waitFor(() => expect(screen.queryByText("kontrak.pdf")).toBeNull());
  });

  it("memilih file yang dibatalkan tidak menambah apa-apa", async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.click(screen.getByRole("button", { name: "Lampirkan file" }));
    await waitFor(() => expect(chat.pickFiles).toHaveBeenCalled());
    expect(screen.queryByRole("list", { name: "File yang akan dikirim" })).toBeNull();
  });

  it("chip balasan: kirim dengan replyTo, dan bisa dibatalkan", async () => {
    const user = userEvent.setup();
    const original = message({ id: "m1", text: "Rapatnya jadi jam berapa?" });
    const { input, onCancelReply } = renderComposer({ replyTo: original });
    expect(screen.getByText("Membalas Sari Uji")).toBeInTheDocument();
    expect(screen.getByText("Rapatnya jadi jam berapa?")).toBeInTheDocument();
    await user.type(input(), "Jam 2 siang{Enter}");
    expect(chat.send).toHaveBeenCalledWith(CH, "Jam 2 siang", "m1", [], []);
    await user.click(screen.getByRole("button", { name: "Batal membalas" }));
    expect(onCancelReply).toHaveBeenCalledTimes(1);
  });

  it("gagal mengirim: error tampil, teks dan lampiran tetap", async () => {
    const user = userEvent.setup();
    chat.send.mockRejectedValue({ code: "io", message: "Penyimpanan penuh." });
    chat.pickFiles.mockResolvedValue([{ path: "C:\\Uji\\kontrak.pdf", name: "kontrak.pdf", size: 10 }]);
    const { input, onSent } = renderComposer();
    await user.click(screen.getByRole("button", { name: "Lampirkan file" }));
    await screen.findByText("kontrak.pdf");
    await user.type(input(), "Tolong cek{Enter}");
    expect(await screen.findByText("Pesan belum terkirim")).toBeInTheDocument();
    expect(screen.getByText(/Penyimpanan penuh\./)).toBeInTheDocument();
    expect(input()).toHaveValue("Tolong cek");
    expect(screen.getByText("kontrak.pdf")).toBeInTheDocument();
    expect(onSent).not.toHaveBeenCalled();
  });

  it("tombol Kirim sibuk selama mengirim", async () => {
    const user = userEvent.setup();
    let finish: (m: MessageView) => void = () => {};
    chat.send.mockImplementation(() => new Promise<MessageView>((resolve) => (finish = resolve)));
    const { input } = renderComposer();
    await user.type(input(), "Sebentar{Enter}");
    const btn = screen.getByRole("button", { name: "Mengirim..." });
    expect(btn).toHaveAttribute("aria-busy", "true");
    expect(input()).toHaveValue("Sebentar");
    finish(message({ id: "x", mine: true }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Kirim" })).toBeInTheDocument());
  });

  it("nonaktif dengan alasan saat channel diarsipkan", () => {
    renderComposer({ summary: channel({ archived: true, canPost: false }) });
    expect(screen.getByText("Channel ini diarsipkan. Kembalikan dari arsip untuk mengirim pesan.")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Kirim" })).toBeNull();
  });

  it("alasan dari inti Rust (postBlockedReason) menggantikan kolom pesan", () => {
    renderComposer({
      summary: channel({ canPost: false, postBlockedReason: "Hanya superadmin yang bisa menulis di channel ini." }),
    });
    expect(screen.getByText("Hanya superadmin yang bisa menulis di channel ini.")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("tanpa alasan dari inti Rust memakai kalimat umum", () => {
    renderComposer({ summary: channel({ canPost: false }) });
    expect(screen.getByText("Anda tidak bisa mengirim pesan di percakapan ini.")).toBeInTheDocument();
  });

  it("bukan anggota lagi: catatan proyek, tanpa kolom pesan", () => {
    renderComposer({ summary: channel({ former: true, canPost: false, postBlockedReason: "x" }) });
    expect(
      screen.getByText(
        "Anda sudah bukan anggota proyek ini. Pesan baru tidak dikirim lagi ke laptop Anda; pesan lama tetap tersimpan di sini.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("x")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("chat proyek: label dan placeholder memakai kata Proyek, tanpa #", () => {
    const { input } = renderComposer({ summary: project() });
    expect(input()).toHaveAttribute("placeholder", "Tulis pesan ke Proyek Gedung Alfa");
    expect(screen.getByLabelText("Pesan untuk Proyek Gedung Alfa")).toBe(input());
  });

  it("chat proyek bukan anggota lagi: catatan proyek walau bagiannya lain", () => {
    renderComposer({ summary: project({ former: true, canPost: false, section: "umum" }) });
    expect(
      screen.getByText(
        "Anda sudah bukan anggota proyek ini. Pesan baru tidak dikirim lagi ke laptop Anda; pesan lama tetap tersimpan di sini.",
      ),
    ).toBeInTheDocument();
  });

  it("chat proyek lama yang diarsipkan: tanpa ajakan Kembalikan dari arsip", () => {
    renderComposer({ summary: project({ archived: true, canPost: false }) });
    expect(screen.getByText("Chat proyek ini diarsipkan, jadi pesan baru tidak bisa dikirim.")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("banner offline untuk rekan chat pribadi yang offline", () => {
    net.value = {
      data: {
        state: "running",
        listenPort: 1,
        localAddresses: [],
        shareLink: "",
        qrSvg: "",
        mdns: { ok: true, error: null },
        manualAddresses: [],
        peers: [
          {
            publicKey: PK_B,
            displayName: "Sari Uji",
            fingerprint: "",
            orgRole: "member",
            online: false,
            route: null,
            address: null,
            lastSeenAt: null,
          },
        ],
      },
      error: null,
      loading: false,
      reload: async () => {},
    };
    renderComposer({ summary: dm({ id: DM }) });
    expect(
      screen.getByText("Sari Uji sedang offline. Pesan dititipkan dan terkirim saat laptopnya tersambung."),
    ).toBeInTheDocument();
  });

  it("tanpa banner offline kalau rekan online atau di channel", () => {
    renderComposer({ summary: dm() });
    expect(screen.queryByText(/sedang offline/)).toBeNull();
  });
});

describe("Komposer: emoji, saran :nama, dan sticker", () => {
  it("tombol Emoji dan Sticker disembunyikan kalau tidak bisa menulis", () => {
    renderComposer({ summary: channel({ canPost: false }) });
    expect(screen.queryByRole("button", { name: "Sisipkan emoji" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Kirim sticker" })).toBeNull();
  });

  it("pemilih emoji menyisipkan di posisi kursor, tetap terbuka, Esc mengembalikan fokus", async () => {
    const user = userEvent.setup();
    const { input } = renderComposer();
    await user.type(input(), "Halo dunia");
    (input() as HTMLTextAreaElement).setSelectionRange(4, 4);
    const button = screen.getByRole("button", { name: "Sisipkan emoji" });
    await user.click(button);
    const picker = screen.getByRole("dialog", { name: "Pilih emoji" });
    expect(button).toHaveAttribute("aria-expanded", "true");
    await user.type(within(picker).getByRole("textbox", { name: "Cari emoji" }), "kopi");
    await user.click(within(picker).getByRole("button", { name: "kopi" }));
    expect(input()).toHaveValue(`Halo${COFFEE} dunia`);
    expect(chat.emojiUsed).toHaveBeenCalledWith(COFFEE);
    // Emote kantor: ":nama:" dengan spasi pemisah, tanpa dicatat sebagai emoji.
    await user.click(within(picker).getByRole("button", { name: ":kopi:" }));
    expect(input()).toHaveValue(`Halo${COFFEE} :kopi: dunia`);
    expect(chat.emojiUsed).toHaveBeenCalledTimes(1);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Pilih emoji" })).toBeNull();
    await waitFor(() => expect(input()).toHaveFocus());
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("pemilih emoji dibuka dengan keyboard dan ditutup lagi lewat tombolnya", async () => {
    const user = userEvent.setup();
    renderComposer();
    const button = screen.getByRole("button", { name: "Sisipkan emoji" });
    button.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("textbox", { name: "Cari emoji" })).toHaveFocus();
    await user.click(button);
    expect(screen.queryByRole("dialog", { name: "Pilih emoji" })).toBeNull();
  });

  it("saran :kop menampilkan emote kantor :kopi: lalu emoji kopi", async () => {
    const user = userEvent.setup();
    const { input } = renderComposer();
    await user.type(input(), "Mau :kop");
    const list = screen.getByRole("listbox", { name: "Saran emoji" });
    const options = within(list).getAllByRole("option");
    expect(options[0]).toHaveAccessibleName(":kopi:, emote kantor");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options.some((o) => o.textContent?.includes(COFFEE))).toBe(true);
    expect(input()).toHaveAttribute("aria-activedescendant", options[0].id);
    await user.keyboard("{Enter}");
    expect(input()).toHaveValue("Mau :kopi: ");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(chat.send).not.toHaveBeenCalled();

    await user.type(input(), ":kop");
    const coffee = within(screen.getByRole("listbox", { name: "Saran emoji" }))
      .getAllByRole("option")
      .findIndex((o) => o.textContent?.includes(COFFEE));
    await user.keyboard("{ArrowDown}".repeat(coffee));
    await user.keyboard("{Tab}");
    expect(input()).toHaveValue(`Mau :kopi: ${COFFEE}`);
    expect(chat.emojiUsed).toHaveBeenCalledWith(COFFEE);
  });

  it("saran emoji: Esc menutup tanpa mengubah teks; satu huruf belum memunculkan saran", async () => {
    const user = userEvent.setup();
    const { input } = renderComposer();
    await user.type(input(), "jam 10:30 :k");
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.type(input(), "o");
    expect(screen.getByRole("listbox", { name: "Saran emoji" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input()).toHaveValue("jam 10:30 :ko");
  });

  it("saran mention tetap didahulukan", async () => {
    const user = userEvent.setup();
    const { input } = renderComposer();
    await user.type(input(), "@Sa");
    expect(screen.getByRole("listbox", { name: "Sebut rekan" })).toBeInTheDocument();
    expect(screen.queryByRole("listbox", { name: "Saran emoji" })).toBeNull();
  });

  it("pemilih sticker: keyboard membuka, Esc menutup dan fokus kembali ke tombol Sticker", async () => {
    const user = userEvent.setup();
    renderComposer();
    const button = screen.getByRole("button", { name: "Kirim sticker" });
    button.focus();
    await user.keyboard("{Enter}");
    const picker = screen.getByRole("dialog", { name: "Pilih sticker" });
    expect(within(picker).getByRole("searchbox", { name: "Cari sticker" })).toHaveFocus();
    expect(within(picker).getByRole("tab", { name: "Kantor" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Pilih sticker" })).toBeNull();
    await waitFor(() => expect(button).toHaveFocus());
  });

  it("kirim sticker kantor dengan klik: source office dan replyTo, lalu pemilih tertutup", async () => {
    const user = userEvent.setup();
    const original = message({ id: "m1", text: "Ngopi dulu?" });
    const { input, onSent } = renderComposer({ replyTo: original });
    await user.click(screen.getByRole("button", { name: "Kirim sticker" }));
    const picker = screen.getByRole("dialog", { name: "Pilih sticker" });
    expect(within(picker).getByRole("heading", { name: "Kantor" })).toBeInTheDocument();
    expect(within(picker).getByRole("heading", { name: "Perayaan" })).toBeInTheDocument();
    await user.click(within(picker).getByRole("button", { name: ":kopi:" }));
    expect(chat.sendSticker).toHaveBeenCalledWith(CH, { kind: "office", id: kopi.id }, "m1");
    await waitFor(() => expect(onSent).toHaveBeenCalledWith(expect.objectContaining({ id: "stk" })));
    expect(screen.queryByRole("dialog", { name: "Pilih sticker" })).toBeNull();
    await waitFor(() => expect(input()).toHaveFocus());
  });

  it("kisi sticker: panah dan Enter mengirim; sticker yang belum sampai tidak bisa dikirim", async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.click(screen.getByRole("button", { name: "Kirim sticker" }));
    const picker = screen.getByRole("dialog", { name: "Pilih sticker" });
    const pending = within(picker).getByRole("button", { name: ":rapat:" });
    expect(pending).toHaveAttribute("aria-disabled", "true");
    expect(pending).toHaveAccessibleDescription(
      "Sticker bergaris putus-putus belum sampai di laptop ini dan belum bisa dikirim.",
    );
    await user.click(pending);
    expect(chat.sendSticker).not.toHaveBeenCalled();

    // Panah bawah dari kolom cari masuk ke sticker yang terakhir dipilih.
    within(picker).getByRole("searchbox", { name: "Cari sticker" }).focus();
    await user.keyboard("{ArrowDown}");
    expect(pending).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(within(picker).getByRole("button", { name: ":kopi:" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(pending).toHaveFocus();
    // Paket berikutnya mulai di baris baru: panah bawah pindah ke :hore:.
    await user.keyboard("{ArrowDown}");
    expect(within(picker).getByRole("button", { name: ":hore:" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(chat.sendSticker).toHaveBeenCalledWith(CH, { kind: "office", id: hore.id }, null);
  });

  it("cari sticker lewat nama atau kata kunci", async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.click(screen.getByRole("button", { name: "Kirim sticker" }));
    const picker = screen.getByRole("dialog", { name: "Pilih sticker" });
    const search = within(picker).getByRole("searchbox", { name: "Cari sticker" });
    await user.type(search, "selamat");
    expect(within(picker).getByRole("button", { name: ":hore:" })).toBeInTheDocument();
    expect(within(picker).queryByRole("button", { name: ":kopi:" })).toBeNull();
    await user.clear(search);
    await user.type(search, "zzz");
    expect(within(picker).getByText("Tidak ada sticker dengan nama atau kata kunci zzz.")).toBeInTheDocument();
  });

  it("gagal mengirim sticker: error tampil di pemilih", async () => {
    const user = userEvent.setup();
    chat.sendSticker.mockRejectedValue({ code: "io", message: "Penyimpanan penuh." });
    const { onSent } = renderComposer();
    await user.click(screen.getByRole("button", { name: "Kirim sticker" }));
    await user.click(screen.getByRole("button", { name: ":kopi:" }));
    expect(await screen.findByText("Sticker belum terkirim")).toBeInTheDocument();
    expect(screen.getByText("Penyimpanan penuh.")).toBeInTheDocument();
    expect(onSent).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Pilih sticker" })).toBeInTheDocument();
  });

  it("kirim sticker pribadi dari tab Punya saya", async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.click(screen.getByRole("button", { name: "Kirim sticker" }));
    screen.getByRole("tab", { name: "Kantor" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Punya saya" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Punya saya" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: ":kucing:" }));
    expect(chat.sendSticker).toHaveBeenCalledWith(CH, { kind: "mine", id: kucing.id }, null);
  });

  it("unggah sticker pribadi: pilih gambar, validasi nama, lalu simpan", async () => {
    const user = userEvent.setup();
    const added: MySticker = { ...kucing, id: "8".repeat(32), name: "kopi_susu", hash: HASH("8") };
    chat.pickSticker.mockResolvedValue({
      path: "C:\\Uji\\Kopi Susu.png",
      name: "Kopi Susu.png",
      size: 2048,
      mime: "image/png",
      width: 128,
      height: 96,
      frames: 1,
    });
    chat.stickers.mockResolvedValue(catalog({ mine: [added, kucing] }));
    renderComposer();
    await user.click(screen.getByRole("button", { name: "Kirim sticker" }));
    await user.click(screen.getByRole("tab", { name: "Punya saya" }));
    await user.click(screen.getByRole("button", { name: "Unggah sticker" }));
    const form = await screen.findByRole("form", { name: "Sticker baru" });
    expect(within(form).getByText("2 KB, 128 x 96 piksel")).toBeInTheDocument();
    const name = within(form).getByRole("textbox", { name: "Nama" });
    expect(name).toHaveValue("kopi_susu");
    expect(name).toHaveFocus();

    await user.clear(name);
    await user.type(name, "Kopi Susu!");
    await user.click(within(form).getByRole("button", { name: "Simpan sticker" }));
    expect(
      within(form).getByText("Nama hanya boleh huruf kecil a sampai z, angka, dan garis bawah, 2 sampai 32 karakter."),
    ).toBeInTheDocument();
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(chat.addMySticker).not.toHaveBeenCalled();

    await user.clear(name);
    await user.type(name, "kopi_susu");
    const keywords = within(form).getByRole("textbox", { name: "Kata kunci (boleh kosong)" });
    await user.type(keywords, "a b c d e f g h i");
    await user.click(within(form).getByRole("button", { name: "Simpan sticker" }));
    expect(within(form).getByText("Paling banyak 8 kata kunci.")).toBeInTheDocument();
    expect(chat.addMySticker).not.toHaveBeenCalled();

    await user.clear(keywords);
    await user.type(keywords, "Kopi, susu pagi kopi");
    await user.click(within(form).getByRole("button", { name: "Simpan sticker" }));
    expect(chat.addMySticker).toHaveBeenCalledWith("C:\\Uji\\Kopi Susu.png", "kopi_susu", ["kopi", "susu", "pagi"]);
    await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
    expect(chat.stickers).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: ":kopi_susu:" })).toHaveFocus());
  });

  it("memilih gambar yang dibatalkan tidak membuka form", async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.click(screen.getByRole("button", { name: "Kirim sticker" }));
    await user.click(screen.getByRole("tab", { name: "Punya saya" }));
    await user.click(screen.getByRole("button", { name: "Unggah sticker" }));
    await waitFor(() => expect(chat.pickSticker).toHaveBeenCalled());
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("hapus sticker pribadi lewat konfirmasi", async () => {
    const user = userEvent.setup();
    chat.stickers.mockResolvedValue(catalog({ mine: [] }));
    renderComposer();
    await user.click(screen.getByRole("button", { name: "Kirim sticker" }));
    await user.click(screen.getByRole("tab", { name: "Punya saya" }));
    await user.click(screen.getByRole("button", { name: "Hapus :kucing: dari sticker saya" }));
    const confirm = screen.getByRole("dialog", { name: "Hapus sticker pribadi?" });
    // Klik di dialog konfirmasi tidak menutup pemilih sticker.
    await user.click(within(confirm).getByRole("button", { name: "Hapus sticker" }));
    expect(chat.removeMySticker).toHaveBeenCalledWith(kucing.id);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Hapus sticker pribadi?" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "Pilih sticker" })).toBeInTheDocument();
    expect(screen.getByText(/Belum ada sticker pribadi\./)).toBeInTheDocument();
  });

  it("tombol Delete di sticker pribadi meminta konfirmasi; Batal tidak menghapus", async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.click(screen.getByRole("button", { name: "Kirim sticker" }));
    await user.click(screen.getByRole("tab", { name: "Punya saya" }));
    screen.getByRole("button", { name: ":kucing:" }).focus();
    await user.keyboard("{Delete}");
    const confirm = screen.getByRole("dialog", { name: "Hapus sticker pribadi?" });
    await user.click(within(confirm).getByRole("button", { name: "Batal" }));
    expect(chat.removeMySticker).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Pilih sticker" })).toBeInTheDocument();
  });

  it("keadaan kosong menjelaskan cara menambah sticker", async () => {
    const user = userEvent.setup();
    resetStickerCatalog(catalog({ office: [], mine: [] }));
    renderComposer();
    await user.click(screen.getByRole("button", { name: "Kirim sticker" }));
    expect(
      screen.getByText("Belum ada sticker kantor. Superadmin bisa menambahkannya di Organisasi, tab Sticker."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Punya saya" }));
    expect(
      screen.getByText(
        "Belum ada sticker pribadi. Simpan sticker dari pesan lewat menu pesan, atau unggah gambar PNG, WebP, atau GIF.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unggah sticker" })).toBeInTheDocument();
  });

  it("katalog gagal dimuat: error dan Coba lagi", async () => {
    const user = userEvent.setup();
    resetStickerCatalog(null);
    chat.stickers.mockRejectedValueOnce({ code: "io", message: "Database terkunci." });
    renderComposer();
    await user.click(screen.getByRole("button", { name: "Kirim sticker" }));
    expect(await screen.findByText("Sticker belum bisa dimuat")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Coba lagi" }));
    expect(await screen.findByRole("button", { name: ":kopi:" })).toBeInTheDocument();
  });

  it("teks bahasa Inggris", async () => {
    const user = userEvent.setup();
    resetStickerCatalog(catalog({ office: [], mine: [] }));
    const inputRef = { current: null as HTMLTextAreaElement | null };
    renderInLang(() => (
      <Composer
        summary={channel()}
        me={ME}
        members={[penguji, sari, budi]}
        replyTo={null}
        onCancelReply={vi.fn()}
        onSent={vi.fn()}
        inputRef={inputRef}
      />
    ));
    expect(screen.getByRole("button", { name: "Insert emoji" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send a sticker" }));
    const picker = screen.getByRole("dialog", { name: "Choose a sticker" });
    expect(within(picker).getByRole("tab", { name: "Office" })).toBeInTheDocument();
    expect(within(picker).getByRole("searchbox", { name: "Search stickers" })).toBeInTheDocument();
    expect(
      within(picker).getByText(
        "There are no office stickers yet. A superadmin can add them in Organization, on the Stickers tab.",
      ),
    ).toBeInTheDocument();
    await user.click(within(picker).getByRole("tab", { name: "Mine" }));
    expect(within(picker).getByRole("button", { name: "Upload a sticker" })).toBeInTheDocument();
  });
});
