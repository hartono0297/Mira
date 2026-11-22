import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSummary, ConversationView } from "../../api/chat";
import { Conversation } from "./Conversation";
import {
  budi,
  channel,
  CH,
  dm,
  DM,
  file,
  ME,
  message,
  penguji,
  sari,
  today,
  view,
} from "./conversationTestData";

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
}));

vi.mock("../../api/chat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/chat")>()),
  chatApi: chat,
  subscribeChat: () => () => {},
}));

function renderConv(summary: ConversationSummary = channel()) {
  const onChanged = vi.fn();
  const onGone = vi.fn();
  const utils = render(<Conversation summary={summary} me={ME} onChanged={onChanged} onGone={onGone} />);
  return { ...utils, onChanged, onGone };
}

const baseMessages = () => [
  message({ id: "m1", text: "Draft kontraknya sudah saya kirim.\nTolong dicek @Penguji ya.", mentions: [penguji] }),
  message({ id: "m2", at: today(9, 14), text: "Satu lagi untuk @Budi Uji.", mentions: [budi] }),
  message({ id: "m3", author: budi, at: today(9, 30), text: "", deleted: true }),
  message({
    id: "m4",
    author: penguji,
    mine: true,
    canDelete: true,
    at: today(10, 2),
    text: "Siap, saya cek siang ini.",
    replyTo: { id: "m1", author: sari, preview: "Draft kontraknya sudah saya kirim.", deleted: false },
    status: { state: "delivered", read: 1, delivered: 2, deposited: 0, total: 2 },
  }),
];

beforeEach(() => {
  chat.messages.mockResolvedValue(view(baseMessages()));
  chat.markRead.mockResolvedValue(null);
  chat.send.mockImplementation(async () => message({ id: "new", mine: true, author: penguji }));
  chat.deleteMessage.mockResolvedValue(null);
  chat.setArchived.mockResolvedValue(null);
  chat.setMuted.mockResolvedValue(null);
  chat.deleteChannel.mockResolvedValue(null);
  chat.messageReceipts.mockResolvedValue([
    { person: sari, state: "read" },
    { person: budi, state: "delivered" },
  ]);
  chat.fileOpen.mockResolvedValue(null);
  chat.fileSave.mockResolvedValue(true);
  chat.fileDownload.mockResolvedValue(file({ state: "local" }));
  chat.pickFiles.mockResolvedValue([]);
});

describe("Percakapan: memuat dan menampilkan pesan", () => {
  it("menampilkan kepala, pemisah hari, jam, teks, dan pesan dihapus", async () => {
    renderConv();
    expect(screen.getByText("Memuat pesan...")).toBeInTheDocument();
    const mention = await screen.findByText("@Penguji");
    expect(screen.getByRole("heading", { name: "#proyek-a" })).toBeInTheDocument();
    expect(screen.getByText("Proyek Gedung A")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Hari ini" })).toBeInTheDocument();
    expect(screen.getAllByText("09.12").length).toBeGreaterThan(0);
    // Teks dengan baris baru tetap utuh.
    const text = mention.closest("p")!;
    expect(text).toHaveClass("conv-text");
    expect(text.textContent).toBe("Draft kontraknya sudah saya kirim.\nTolong dicek @Penguji ya.");
    // Pesan dihapus: teks muted, tanpa tombol aksi.
    const deleted = screen.getByText("Pesan dihapus", { selector: "p" });
    const item = deleted.closest("li")!;
    expect(within(item).queryByRole("button", { name: /Balas/ })).toBeNull();
    expect(chat.messages).toHaveBeenCalledWith(CH);
  });

  it("menyorot mention, mention saya lebih kuat", async () => {
    renderConv();
    const mine = await screen.findByText("@Penguji");
    expect(mine).toHaveClass("conv-mention", "conv-mention-me");
    const other = screen.getByText("@Budi Uji");
    expect(other).toHaveClass("conv-mention");
    expect(other).not.toHaveClass("conv-mention-me");
  });

  it("pesan berurutan dari orang yang sama dalam 5 menit digabung", async () => {
    renderConv();
    await screen.findByText("@Budi Uji");
    // m1 dan m2 (Sari, 09.12 dan 09.14): nama Sari hanya tampil sekali sebagai kepala.
    expect(screen.getAllByText("Sari Uji", { selector: ".conv-author" })).toHaveLength(1);
  });

  it("kutipan balasan melompat ke pesan asli", async () => {
    const user = userEvent.setup();
    renderConv();
    const quote = await screen.findByRole("button", { name: /Balasan untuk Sari Uji/ });
    await user.click(quote);
    const original = document.getElementById("conv-msg-m1")!;
    expect(original).toHaveFocus();
    expect(original).toHaveClass("conv-msg-flash");
  });

  it("kutipan pesan yang dihapus menampilkan Pesan dihapus", async () => {
    chat.messages.mockResolvedValue(
      view([
        message({
          id: "x",
          replyTo: { id: "tidak-dimuat", author: budi, preview: "", deleted: true },
        }),
      ]),
    );
    renderConv();
    const quote = await screen.findByText("Pesan dihapus");
    expect(quote).toHaveClass("conv-quote-text");
    expect(screen.queryByRole("button", { name: /Balasan untuk/ })).toBeNull();
  });

  it("keadaan kosong", async () => {
    chat.messages.mockResolvedValue(view([]));
    renderConv();
    expect(await screen.findByText("Belum ada pesan di #proyek-a. Tulis pesan pertama di kolom bawah.")).toBeInTheDocument();
  });

  it("keadaan error dengan tombol coba lagi", async () => {
    const user = userEvent.setup();
    chat.messages.mockRejectedValueOnce({ code: "io", message: "Basis data sedang dipakai." });
    renderConv();
    expect(await screen.findByText("Pesan belum bisa dimuat")).toBeInTheDocument();
    expect(screen.getByText("Basis data sedang dipakai.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Coba lagi" }));
    expect(await screen.findByText("@Budi Uji")).toBeInTheDocument();
  });

  it("memuat pesan sebelumnya di atas", async () => {
    const user = userEvent.setup();
    chat.messages.mockImplementation(async (_conv: string, before?: string | null) =>
      before
        ? view([message({ id: "m0", at: today(8, 0), text: "Pesan paling awal" })], { hasMore: false })
        : view(baseMessages(), { hasMore: true }),
    );
    renderConv();
    await user.click(await screen.findByRole("button", { name: "Muat pesan sebelumnya" }));
    expect(await screen.findByText("Pesan paling awal")).toBeInTheDocument();
    expect(chat.messages).toHaveBeenCalledWith(CH, "m1");
    const items = Array.from(document.querySelectorAll(".conv-msg")).map((el) => el.id);
    expect(items[0]).toBe("conv-msg-m0");
    expect(screen.queryByRole("button", { name: "Muat pesan sebelumnya" })).toBeNull();
  });
});

describe("Percakapan: tandai dibaca", () => {
  it("dipanggil sekali saat ada pesan belum dibaca", async () => {
    const user = userEvent.setup();
    chat.messages.mockResolvedValue(view([...baseMessages(), message({ id: "f", files: [file({ state: "remote" })] })]));
    const { onChanged } = renderConv(channel({ unread: 2 }));
    await waitFor(() => expect(chat.markRead).toHaveBeenCalledTimes(1));
    expect(chat.markRead).toHaveBeenCalledWith(CH);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    // Muat ulang dengan data yang sama tidak memanggil lagi.
    await user.click(screen.getByRole("button", { name: /Unduh kontrak-draft\.pdf/ }));
    await waitFor(() => expect(chat.messages).toHaveBeenCalledTimes(2));
    expect(chat.markRead).toHaveBeenCalledTimes(1);
  });

  it("tidak dipanggil tanpa pesan belum dibaca, dipanggil saat pesan baru dari orang lain datang", async () => {
    const user = userEvent.setup();
    chat.messages.mockResolvedValue(view([...baseMessages(), message({ id: "f", files: [file({ state: "remote" })] })]));
    renderConv(channel({ unread: 0 }));
    await screen.findByText("@Budi Uji");
    expect(chat.markRead).not.toHaveBeenCalled();
    chat.messages.mockResolvedValue(
      view([
        ...baseMessages(),
        message({ id: "f", files: [file({ state: "local" })] }),
        message({ id: "baru", author: budi, at: today(11, 0), text: "Pesan baru" }),
      ]),
    );
    await user.click(screen.getByRole("button", { name: /Unduh kontrak-draft\.pdf/ }));
    expect(await screen.findByText("Pesan baru")).toBeInTheDocument();
    await waitFor(() => expect(chat.markRead).toHaveBeenCalledTimes(1));
  });
});

describe("Percakapan: status kirim", () => {
  it("channel menampilkan jumlah dan rincian per orang", async () => {
    const user = userEvent.setup();
    renderConv();
    const btn = await screen.findByRole("button", { name: /Dibaca 1 dari 2/ });
    await user.click(btn);
    const pop = await screen.findByRole("dialog", { name: "Status pesan per orang" });
    expect(await within(pop).findByText("Sari Uji")).toBeInTheDocument();
    expect(within(pop).getByText("Dibaca")).toBeInTheDocument();
    expect(within(pop).getByText("Diterima laptopnya")).toBeInTheDocument();
    expect(chat.messageReceipts).toHaveBeenCalledWith("m4");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Status pesan per orang" })).toBeNull();
    expect(btn).toHaveFocus();
  });

  it("chat pribadi menampilkan label status", async () => {
    const dmView: ConversationView = view(
      [
        message({
          id: "d1",
          conv: DM,
          author: penguji,
          mine: true,
          text: "Jangan lupa bawa draftnya.",
          status: { state: "deposited", read: 0, delivered: 0, deposited: 1, total: 1 },
        }),
      ],
      { conversation: dm(), members: [penguji, sari] },
    );
    chat.messages.mockResolvedValue(dmView);
    renderConv(dm());
    expect(await screen.findByRole("button", { name: /Status: Dititipkan/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sari Uji" })).toBeInTheDocument();
    expect(screen.getByText("Chat pribadi")).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Arsipkan channel" })).toBeNull();
  });
});

describe("Percakapan: kartu file", () => {
  function withFiles() {
    chat.messages.mockResolvedValue(
      view([
        message({
          id: "f1",
          text: "",
          files: [
            file({ hash: "1".repeat(64), name: "kontrak.pdf", state: "local" }),
            file({ hash: "2".repeat(64), name: "foto-lokasi.jpg", mime: "image/jpeg", size: 52 * 1024 * 1024, state: "remote" }),
            file({ hash: "3".repeat(64), name: "laporan.xlsx", state: "fetching" }),
            file({ hash: "4".repeat(64), name: "denah.dwg", state: "missing" }),
          ],
        }),
      ]),
    );
  }

  it("menampilkan setiap keadaan file", async () => {
    withFiles();
    renderConv();
    expect(await screen.findByText("kontrak.pdf")).toBeInTheDocument();
    expect(screen.getAllByText("1,2 MB").length).toBeGreaterThan(0);
    expect(screen.getByText("52 MB")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Buka kontrak.pdf" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Simpan kontrak.pdf sebagai" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unduh foto-lokasi.jpg" })).toBeInTheDocument();
    expect(screen.getByText("Mengunduh...")).toBeInTheDocument();
    expect(
      screen.getByText("Belum tersedia. File diunduh otomatis saat laptop rekan yang menyimpannya online."),
    ).toBeInTheDocument();
  });

  it("Buka, Simpan, dan Unduh memanggil inti Rust", async () => {
    const user = userEvent.setup();
    withFiles();
    renderConv();
    await user.click(await screen.findByRole("button", { name: "Buka kontrak.pdf" }));
    expect(chat.fileOpen).toHaveBeenCalledWith("1".repeat(64), "kontrak.pdf");
    await user.click(screen.getByRole("button", { name: "Simpan kontrak.pdf sebagai" }));
    expect(chat.fileSave).toHaveBeenCalledWith("1".repeat(64));
    expect(await screen.findByText("kontrak.pdf tersimpan.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Unduh foto-lokasi.jpg" }));
    expect(chat.fileDownload).toHaveBeenCalledWith("2".repeat(64));
    await waitFor(() => expect(chat.messages).toHaveBeenCalledTimes(2));
  });

  it("Simpan yang dibatalkan tidak menampilkan apa-apa", async () => {
    const user = userEvent.setup();
    chat.fileSave.mockResolvedValue(false);
    withFiles();
    renderConv();
    await user.click(await screen.findByRole("button", { name: "Simpan kontrak.pdf sebagai" }));
    await waitFor(() => expect(chat.fileSave).toHaveBeenCalled());
    expect(screen.queryByText("kontrak.pdf tersimpan.")).toBeNull();
  });

  it("file yang dilarang dibuka menampilkan alasannya dan tetap bisa disimpan", async () => {
    const user = userEvent.setup();
    chat.fileOpen.mockRejectedValue({ code: "forbidden", message: "File program tidak dibuka langsung. Simpan dulu lalu periksa." });
    withFiles();
    renderConv();
    await user.click(await screen.findByRole("button", { name: "Buka kontrak.pdf" }));
    expect(await screen.findByText("File belum bisa dibuka.")).toBeInTheDocument();
    expect(screen.getByText(/File program tidak dibuka langsung/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Simpan kontrak.pdf sebagai" })).toBeInTheDocument();
  });
});

describe("Percakapan: aksi pesan", () => {
  it("Hapus pesan lewat konfirmasi", async () => {
    const user = userEvent.setup();
    const { onChanged } = renderConv();
    await user.click(await screen.findByRole("button", { name: "Hapus pesan Anda pukul 10.02" }));
    const dialog = await screen.findByRole("dialog", { name: "Hapus pesan ini?" });
    expect(within(dialog).getByText(/tidak bisa dikembalikan/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Hapus pesan" }));
    expect(chat.deleteMessage).toHaveBeenCalledWith(CH, "m4");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onChanged).toHaveBeenCalled();
  });

  it("Hapus hanya untuk pesan yang boleh dihapus", async () => {
    renderConv();
    await screen.findByText("@Budi Uji");
    expect(screen.queryByRole("button", { name: /Hapus pesan Sari Uji/ })).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Balas pesan/ }).length).toBe(3);
  });

  it("Balas mengisi komposer lalu mengirim dengan replyTo", async () => {
    const user = userEvent.setup();
    const { onChanged } = renderConv();
    await user.click(await screen.findByRole("button", { name: "Balas pesan Sari Uji pukul 09.12" }));
    expect(screen.getByText("Membalas Sari Uji")).toBeInTheDocument();
    const input = screen.getByRole("combobox", { name: "Pesan untuk #proyek-a" });
    expect(input).toHaveFocus();
    await user.type(input, "Oke{Enter}");
    expect(chat.send).toHaveBeenCalledWith(CH, "Oke", "m1", [], []);
    await waitFor(() => expect(screen.queryByText("Membalas Sari Uji")).toBeNull());
    expect(onChanged).toHaveBeenCalled();
  });
});

describe("Percakapan: menu kepala", () => {
  it("bisukan dan arsipkan memanggil API", async () => {
    const user = userEvent.setup();
    const { onChanged } = renderConv();
    await screen.findByText("@Budi Uji");
    const menuBtn = screen.getByRole("button", { name: "Menu #proyek-a" });
    await user.click(menuBtn);
    await user.click(screen.getByRole("menuitem", { name: "Bisukan notifikasi" }));
    expect(chat.setMuted).toHaveBeenCalledWith(CH, true);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));

    // Keyboard: Enter membuka, panah memilih, Enter menjalankan.
    menuBtn.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("menuitem", { name: "Bisukan notifikasi" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Arsipkan channel" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(chat.setArchived).toHaveBeenCalledWith(CH, true);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
  });

  it("Escape menutup menu dan fokus kembali ke tombol", async () => {
    const user = userEvent.setup();
    renderConv();
    const menuBtn = await screen.findByRole("button", { name: "Menu #proyek-a" });
    await user.click(menuBtn);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(menuBtn).toHaveFocus();
  });

  it("channel diarsipkan: label, kembalikan, dan komposer nonaktif", async () => {
    const user = userEvent.setup();
    renderConv(channel({ archived: true, canPost: false, muted: true }));
    await screen.findByText("@Budi Uji");
    expect(screen.getByText("Diarsipkan")).toBeInTheDocument();
    expect(screen.getByText("Dibisukan")).toBeInTheDocument();
    expect(screen.getByText("Channel ini diarsipkan. Kembalikan dari arsip untuk mengirim pesan.")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Menu #proyek-a" }));
    await user.click(screen.getByRole("menuitem", { name: "Nyalakan notifikasi" }));
    expect(chat.setMuted).toHaveBeenCalledWith(CH, false);
    await user.click(screen.getByRole("button", { name: "Menu #proyek-a" }));
    await user.click(screen.getByRole("menuitem", { name: "Kembalikan dari arsip" }));
    expect(chat.setArchived).toHaveBeenCalledWith(CH, false);
  });

  it("Hapus channel lewat konfirmasi lalu onGone", async () => {
    const user = userEvent.setup();
    const { onGone } = renderConv();
    await screen.findByText("@Budi Uji");
    await user.click(screen.getByRole("button", { name: "Menu #proyek-a" }));
    await user.click(screen.getByRole("menuitem", { name: "Hapus channel" }));
    const dialog = await screen.findByRole("dialog", { name: "Hapus channel #proyek-a?" });
    expect(within(dialog).getByText(/dihapus untuk semua anggota/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Batal" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "Hapus channel" }));
    expect(chat.deleteChannel).toHaveBeenCalledWith(CH);
    await waitFor(() => expect(onGone).toHaveBeenCalledTimes(1));
  });

  it("tanpa hak: hanya menu notifikasi", async () => {
    const user = userEvent.setup();
    renderConv(channel({ canArchive: false, canDelete: false }));
    await user.click(await screen.findByRole("button", { name: "Menu #proyek-a" }));
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Bisukan notifikasi"]);
  });

  it("error API tampil di bawah kepala", async () => {
    const user = userEvent.setup();
    chat.setArchived.mockRejectedValue({ code: "forbidden", message: "Hanya admin yang bisa mengarsipkan." });
    const { onChanged } = renderConv();
    await user.click(await screen.findByRole("button", { name: "Menu #proyek-a" }));
    await user.click(screen.getByRole("menuitem", { name: "Arsipkan channel" }));
    expect(await screen.findByText("Arsip belum bisa diubah")).toBeInTheDocument();
    expect(screen.getByText("Hanya admin yang bisa mengarsipkan.")).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });
});
