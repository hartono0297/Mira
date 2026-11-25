import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSummary } from "../../api/chat";
import { ChatActionsContext, type ChatActions } from "./ChatActions";
import { insertMention } from "./Composer";
import { Conversation } from "./Conversation";
import { budi, channel, CH, file, ME, message, penguji, PK_B, sari, today, view } from "./conversationTestData";

const chat = vi.hoisted(() => ({
  messages: vi.fn(),
  send: vi.fn(),
  deleteMessage: vi.fn(),
  markRead: vi.fn(),
  setArchived: vi.fn(),
  deleteChannel: vi.fn(),
  setMuted: vi.fn(),
  messageReceipts: vi.fn(),
  fileOpen: vi.fn(),
  fileSave: vi.fn(),
  fileDownload: vi.fn(),
  pickFiles: vi.fn(),
  stickers: vi.fn(),
  react: vi.fn(),
  emojiUsed: vi.fn(),
  saveSticker: vi.fn(),
  stickerImage: vi.fn(),
}));

vi.mock("../../api/chat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/chat")>()),
  chatApi: chat,
  subscribeChat: () => () => {},
}));

function actions(): ChatActions {
  return {
    me: ME,
    canMessage: (pk) => pk !== ME,
    openDm: vi.fn(async () => {}),
    showProfile: vi.fn(),
  };
}

function renderConv(summary: ConversationSummary = channel(), chatActions: ChatActions = actions()) {
  render(
    <ChatActionsContext.Provider value={chatActions}>
      <Conversation summary={summary} me={ME} onChanged={() => {}} onGone={() => {}} />
    </ChatActionsContext.Provider>,
  );
  return chatActions;
}

const messages = () => [
  message({ id: "m1", text: "Draft kontraknya sudah saya kirim." }),
  message({ id: "m3", author: budi, at: today(9, 30), text: "", deleted: true }),
  message({
    id: "m4",
    author: penguji,
    mine: true,
    canDelete: true,
    at: today(10, 2),
    text: "Siap, saya cek siang ini.",
    status: { state: "delivered", read: 1, delivered: 2, deposited: 0, total: 2 },
  }),
];

const itemNames = () => screen.getAllByRole("menuitem").map((m) => m.textContent);

function setClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText, readText: vi.fn() }, configurable: true });
}

beforeEach(() => {
  chat.messages.mockResolvedValue(view(messages()));
  chat.markRead.mockResolvedValue(null);
  chat.send.mockImplementation(async () => message({ id: "new", mine: true, author: penguji }));
  chat.deleteMessage.mockResolvedValue(null);
  chat.messageReceipts.mockResolvedValue([
    { person: sari, state: "read" },
    { person: budi, state: "delivered" },
  ]);
  chat.fileOpen.mockResolvedValue(null);
  chat.fileSave.mockResolvedValue(true);
  chat.pickFiles.mockResolvedValue([]);
  chat.stickers.mockResolvedValue({ office: [], mine: [], canManage: false, recentEmoji: [] });
});

describe("Menu pesan: isi", () => {
  it("pesan orang lain: Balas, Beri reaksi, Salin teks, Sebut pengirim", async () => {
    renderConv();
    fireEvent.contextMenu(await screen.findByText("Draft kontraknya sudah saya kirim."));
    expect(screen.getByRole("menu", { name: "Aksi untuk pesan Sari Uji pukul 09.12" })).toBeInTheDocument();
    expect(itemNames()).toEqual(["Balas", "Beri reaksi", "Salin teks", "Sebut Sari Uji"]);
  });

  it("pesan sendiri: Balas, Beri reaksi, Salin teks, Lihat status baca, Hapus pesan", async () => {
    renderConv();
    fireEvent.contextMenu(await screen.findByText("Siap, saya cek siang ini."));
    expect(screen.getByRole("menu", { name: "Aksi untuk pesan Anda pukul 10.02" })).toBeInTheDocument();
    expect(itemNames()).toEqual(["Balas", "Beri reaksi", "Salin teks", "Lihat status baca", "Hapus pesan"]);
  });

  it("pesan dihapus: klik kanan tidak membuka menu pesan", async () => {
    renderConv();
    const deleted = await screen.findByText("Pesan dihapus", { selector: "p" });
    fireEvent.contextMenu(deleted);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(within(deleted.closest("li")!).queryByRole("button", { name: /Aksi lain/ })).toBeNull();
  });

  it("percakapan diarsipkan: tanpa Balas, Beri reaksi, dan Sebut", async () => {
    chat.messages.mockResolvedValue(view(messages(), { canReact: false }));
    renderConv(channel({ archived: true, canPost: false }));
    fireEvent.contextMenu(await screen.findByText("Draft kontraknya sudah saya kirim."));
    expect(itemNames()).toEqual(["Salin teks"]);
    expect(screen.queryByRole("button", { name: /^Balas pesan/ })).toBeNull();
  });

  it("pengirim yang sudah bukan anggota tidak bisa disebut", async () => {
    chat.messages.mockResolvedValue(view(messages(), { members: [penguji, budi] }));
    renderConv();
    fireEvent.contextMenu(await screen.findByText("Draft kontraknya sudah saya kirim."));
    expect(itemNames()).toEqual(["Balas", "Beri reaksi", "Salin teks"]);
  });
});

describe("Menu pesan: keyboard dan tombol", () => {
  it("Shift+F10 dari Balas, panah bawah, Esc menutup dan fokus kembali", async () => {
    const user = userEvent.setup();
    renderConv();
    const replyBtn = await screen.findByRole("button", { name: "Balas pesan Sari Uji pukul 09.12" });
    replyBtn.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.getByRole("menuitem", { name: "Balas" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Beri reaksi" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(replyBtn).toHaveFocus();
  });

  it("Enter pada Balas memunculkan chip Membalas", async () => {
    const user = userEvent.setup();
    renderConv();
    const replyBtn = await screen.findByRole("button", { name: "Balas pesan Sari Uji pukul 09.12" });
    replyBtn.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    await user.keyboard("{Enter}");
    expect(screen.getByText("Membalas Sari Uji")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Pesan untuk #proyek-a" })).toHaveFocus();
  });

  it("tombol ... membuka item yang sama dan bilah aksi tetap tampil", async () => {
    const user = userEvent.setup();
    renderConv();
    const more = await screen.findByRole("button", { name: "Aksi lain untuk pesan Anda pukul 10.02" });
    await user.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(more.closest("li")).toHaveClass("conv-msg-menu-open");
    expect(itemNames()).toEqual(["Balas", "Beri reaksi", "Salin teks", "Lihat status baca", "Hapus pesan"]);
  });

  it("Hapus pesan membuka dialog konfirmasi lalu menghapus", async () => {
    const user = userEvent.setup();
    renderConv();
    fireEvent.contextMenu(await screen.findByText("Siap, saya cek siang ini."));
    await user.click(screen.getByRole("menuitem", { name: "Hapus pesan" }));
    const dialog = await screen.findByRole("dialog", { name: "Hapus pesan ini?" });
    await user.click(within(dialog).getByRole("button", { name: "Hapus pesan" }));
    expect(chat.deleteMessage).toHaveBeenCalledWith(CH, "m4");
  });
});

describe("Menu pesan: aksi", () => {
  it("Salin teks menyalin dan mengumumkan hasilnya", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    setClipboard(writeText);
    renderConv();
    fireEvent.contextMenu(await screen.findByText("Draft kontraknya sudah saya kirim."));
    await user.click(screen.getByRole("menuitem", { name: "Salin teks" }));
    expect(writeText).toHaveBeenCalledWith("Draft kontraknya sudah saya kirim.");
    expect(await screen.findByText("Teks pesan disalin.")).toBeInTheDocument();
  });

  it("Salin teks gagal: pesan tampil di layar dan bisa ditutup", async () => {
    const user = userEvent.setup();
    setClipboard(vi.fn(async () => Promise.reject(new Error("ditolak"))));
    renderConv();
    fireEvent.contextMenu(await screen.findByText("Draft kontraknya sudah saya kirim."));
    await user.click(screen.getByRole("menuitem", { name: "Salin teks" }));
    expect(await screen.findByText("Teks belum bisa disalin. Pilih teksnya lalu tekan Ctrl+C.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Tutup" }));
    expect(screen.queryByText(/Teks belum bisa disalin/)).toBeNull();
  });

  it("Sebut pengirim menyisipkan @Nama di kolom pesan lalu mengirim mention", async () => {
    const user = userEvent.setup();
    renderConv();
    const input = await screen.findByRole("combobox", { name: "Pesan untuk #proyek-a" });
    await user.type(input, "Tolong cek");
    fireEvent.contextMenu(screen.getByText("Draft kontraknya sudah saya kirim."));
    await user.click(screen.getByRole("menuitem", { name: "Sebut Sari Uji" }));
    expect(input).toHaveValue("Tolong cek @Sari Uji ");
    expect(input).toHaveFocus();
    await user.type(input, "ya{Enter}");
    expect(chat.send).toHaveBeenCalledWith(CH, "Tolong cek @Sari Uji ya", null, [PK_B], []);
  });

  it("Lihat status baca membuka rincian per orang dengan fokus di dalamnya", async () => {
    const user = userEvent.setup();
    renderConv();
    fireEvent.contextMenu(await screen.findByText("Siap, saya cek siang ini."));
    await user.click(screen.getByRole("menuitem", { name: "Lihat status baca" }));
    const pop = await screen.findByRole("dialog", { name: "Status pesan per orang" });
    expect(chat.messageReceipts).toHaveBeenCalledWith("m4");
    expect(await within(pop).findByText("Sari Uji")).toBeInTheDocument();
    expect(within(pop).getByText("Budi Uji")).toBeInTheDocument();
    expect(pop).toHaveFocus();
  });

  it("klik kanan di lampiran membuka menu lampiran, bukan menu pesan", async () => {
    chat.messages.mockResolvedValue(view([message({ id: "f1", text: "", files: [file()] })]));
    renderConv();
    fireEvent.contextMenu(await screen.findByText("kontrak-draft.pdf"));
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.getByRole("menu", { name: "Aksi untuk kontrak-draft.pdf" })).toBeInTheDocument();
  });
});

describe("Menu orang di nama pengirim", () => {
  it("klik nama membuka menu orang, Kirim pesan pribadi memanggil openDm", async () => {
    const user = userEvent.setup();
    const chatActions = renderConv();
    const name = await screen.findByRole("button", { name: "Sari Uji" });
    expect(name).toHaveAttribute("aria-haspopup", "menu");
    await user.click(name);
    expect(screen.getByRole("menu", { name: "Aksi untuk Sari Uji" })).toBeInTheDocument();
    expect(itemNames()).toEqual(["Kirim pesan pribadi", "Sebut", "Lihat profil"]);
    await user.click(screen.getByRole("menuitem", { name: "Kirim pesan pribadi" }));
    expect(chatActions.openDm).toHaveBeenCalledWith(sari);
  });

  it("klik kanan dan Shift+F10 di nama membuka menu orang saja", async () => {
    const user = userEvent.setup();
    renderConv();
    const name = await screen.findByRole("button", { name: "Sari Uji" });
    fireEvent.contextMenu(name);
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.getByRole("menu", { name: "Aksi untuk Sari Uji" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    name.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.getByRole("menu", { name: "Aksi untuk Sari Uji" })).toBeInTheDocument();
  });

  it("klik kanan di avatar membuka menu orang; Lihat profil memanggil showProfile", async () => {
    const user = userEvent.setup();
    const chatActions = renderConv();
    const name = await screen.findByRole("button", { name: "Sari Uji" });
    const avatar = name.closest("li")!.querySelector(".conv-avatar")!;
    fireEvent.contextMenu(avatar);
    expect(screen.getByRole("menu", { name: "Aksi untuk Sari Uji" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Lihat profil" }));
    expect(chatActions.showProfile).toHaveBeenCalledWith(sari);
    expect(name).toHaveFocus();
  });

  it("tanpa izin chat pribadi: Kirim pesan pribadi tidak ada", async () => {
    const user = userEvent.setup();
    renderConv(channel(), { ...actions(), canMessage: () => false });
    await user.click(await screen.findByRole("button", { name: "Sari Uji" }));
    expect(itemNames()).toEqual(["Sebut", "Lihat profil"]);
  });

  it("nama sendiri bukan tombol", async () => {
    renderConv();
    await screen.findByText("Siap, saya cek siang ini.");
    expect(screen.queryByRole("button", { name: "Anda" })).toBeNull();
  });
});

describe("insertMention", () => {
  it("menambah spasi pemisah dan menaruh kursor setelah sisipan", () => {
    expect(insertMention("", 0, "Sari Uji")).toEqual({ text: "@Sari Uji ", caret: 10 });
    expect(insertMention("Halo", 4, "Sari Uji")).toEqual({ text: "Halo @Sari Uji ", caret: 15 });
    expect(insertMention("Halo ", 5, "Sari Uji")).toEqual({ text: "Halo @Sari Uji ", caret: 15 });
    expect(insertMention("Halo tolong", 5, "Sari Uji")).toEqual({ text: "Halo @Sari Uji tolong", caret: 15 });
  });
});
