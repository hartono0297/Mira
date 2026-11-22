import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSummary, MessageView } from "../../api/chat";
import { Composer } from "./Composer";
import { budi, channel, CH, dm, DM, ME, message, PK_B, PK_C, penguji, sari } from "./conversationTestData";

const chat = vi.hoisted(() => ({
  send: vi.fn(),
  pickFiles: vi.fn(),
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

beforeEach(() => {
  net.value = null;
  chat.send.mockImplementation(async () => message({ id: "baru", mine: true, author: penguji }));
  chat.pickFiles.mockResolvedValue([]);
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
