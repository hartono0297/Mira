import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatOverview, ConversationSummary } from "../../api/chat";
import type { ConversationSettings } from "../../api/division";
import { setLang } from "../../i18n/core";
import { renderInLang } from "../../test/i18n";
import { AnnounceGate } from "./AnnounceGate";
import { Conversation } from "./Conversation";
import { ConversationList } from "./ConversationList";
import { ME, view } from "./conversationTestData";
import { PinnedNote } from "./PinnedNote";
import { overview, summary, TEAM_1, TIM, UMUM } from "./testData";

const chat = vi.hoisted(() => ({
  messages: vi.fn(),
  markRead: vi.fn(),
  setMuted: vi.fn(),
  setFolded: vi.fn(),
  send: vi.fn(),
  pickFiles: vi.fn(),
}));
const division = vi.hoisted(() => ({ conversationSettings: vi.fn(), setChatSettings: vi.fn() }));

vi.mock("../../api/chat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/chat")>()),
  chatApi: chat,
  subscribeChat: () => () => {},
}));

vi.mock("../../api/division", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/division")>()),
  divisionApi: division,
}));

const DIV_ID = "c".repeat(32);

const MOBILE = summary(`ch:${DIV_ID}`, "Mobile", {
  kind: "division",
  section: "departemen",
  scope: { kind: "team", id: TEAM_1, name: "Uji" },
  divisionId: DIV_ID,
  teamId: TEAM_1,
  canArchive: false,
  canDelete: false,
});

function settings(extra: Partial<ConversationSettings> = {}): ConversationSettings {
  return {
    pinned: "Rapat harian pukul 09.00.\nLaporan masuk sebelum Jumat.",
    announce: false,
    canWrite: true,
    canEdit: false,
    teamId: TEAM_1,
    divisionId: DIV_ID,
    ...extra,
  };
}

function renderConv(s: ConversationSummary = MOBILE) {
  return render(<Conversation summary={s} me={ME} onChanged={vi.fn()} onGone={vi.fn()} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  setLang("id");
  chat.messages.mockResolvedValue(view([]));
  chat.markRead.mockResolvedValue(null);
  chat.setFolded.mockResolvedValue(null);
  division.conversationSettings.mockResolvedValue(settings());
  division.setChatSettings.mockResolvedValue(null);
});

describe("sidebar: chat divisi", () => {
  function renderList(data: ChatOverview) {
    render(
      <ConversationList
        overview={data}
        currentId={UMUM.id}
        revealId={null}
        onRevealed={vi.fn()}
        staleError={null}
        onSelect={vi.fn()}
        onRequest={vi.fn()}
        onChanged={vi.fn()}
        onRemoved={vi.fn()}
        onRetry={vi.fn()}
        onNewChannel={vi.fn()}
        onNewGroup={vi.fn()}
        onNewDirect={vi.fn()}
        onNotify={vi.fn()}
      />,
    );
    return within(screen.getByRole("region", { name: "Departemen" }));
  }

  it("tampil tepat di bawah channel departemennya, menjorok, dengan nama Chat divisi", () => {
    const dept = renderList(overview({ conversations: [MOBILE, UMUM, TIM] }));
    const rows = dept.getAllByRole("button").filter((b) => b.classList.contains("chat-row"));
    expect(rows.map((r) => r.getAttribute("aria-label")?.split(",")[0])).toEqual(["Channel tim-uji", "Chat divisi Mobile"]);
    const row = dept.getByRole("button", { name: "Chat divisi Mobile" });
    expect(row).toHaveClass("chat-row-division");
    expect(row.querySelector(".chat-kind")).not.toBeNull();
    expect(row.querySelector(".chat-hash")).toBeNull();
  });
});

describe("PinnedNote", () => {
  it("menampilkan catatan dengan baris baru apa adanya, tanpa tombol Ubah untuk anggota", async () => {
    renderConv();
    const banner = await screen.findByRole("complementary", { name: "Catatan disematkan" });
    const text = banner.querySelector(".pin-note-text");
    expect(text?.textContent).toBe("Rapat harian pukul 09.00.\nLaporan masuk sebelum Jumat.");
    expect(within(banner).queryByRole("button", { name: /Ubah/ })).toBeNull();
    expect(division.conversationSettings).toHaveBeenCalledWith(MOBILE.id);
    // Banner dan pengganti kolom pesan berbagi satu permintaan.
    expect(division.conversationSettings).toHaveBeenCalledTimes(1);
  });

  it("teks berbentuk HTML tampil sebagai teks", async () => {
    division.conversationSettings.mockResolvedValue(settings({ pinned: "<b>tebal</b><img src=x>" }));
    renderConv();
    const banner = await screen.findByRole("complementary", { name: "Catatan disematkan" });
    expect(banner.querySelector("b, img")).toBeNull();
    expect(banner).toHaveTextContent("<b>tebal</b><img src=x>");
  });

  it("catatan panjang diringkas dan bisa dibuka", async () => {
    const user = userEvent.setup();
    division.conversationSettings.mockResolvedValue(settings({ pinned: "Baris\n".repeat(5).trim() }));
    renderConv();
    const banner = await screen.findByRole("complementary", { name: "Catatan disematkan" });
    const toggle = within(banner).getByRole("button", { name: "Tampilkan semua" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(banner.querySelector(".pin-note-clamp")).not.toBeNull();
    await user.click(toggle);
    expect(within(banner).getByRole("button", { name: "Ringkas" })).toHaveAttribute("aria-expanded", "true");
    expect(banner.querySelector(".pin-note-clamp")).toBeNull();
  });

  it("tanpa catatan dan tanpa hak ubah, banner tidak tampil", async () => {
    division.conversationSettings.mockResolvedValue(settings({ pinned: "" }));
    renderConv();
    await waitFor(() => expect(division.conversationSettings).toHaveBeenCalled());
    await screen.findByRole("combobox");
    expect(screen.queryByRole("complementary", { name: "Catatan disematkan" })).toBeNull();
  });

  it("percakapan lain tidak memuat pengaturan", async () => {
    renderConv(summary(`gr:${"3".repeat(32)}`, "Grup uji"));
    await screen.findByRole("combobox");
    expect(division.conversationSettings).not.toHaveBeenCalled();
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("gagal memuat tidak mengganggu percakapan", async () => {
    division.conversationSettings.mockRejectedValue({ code: "x", message: "gagal" });
    renderConv();
    expect(await screen.findByRole("combobox")).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("pengelola mengubah catatan dan mode pengumuman", async () => {
    const user = userEvent.setup();
    division.conversationSettings.mockResolvedValue(settings({ canEdit: true }));
    render(<PinnedNote summary={MOBILE} />);
    await user.click(await screen.findByRole("button", { name: "Ubah catatan disematkan" }));
    const dialog = await screen.findByRole("dialog", { name: "Catatan dan mode pengumuman" });
    const note = within(dialog).getByRole("textbox", { name: "Catatan disematkan" });
    expect(note).toHaveValue("Rapat harian pukul 09.00.\nLaporan masuk sebelum Jumat.");
    expect(within(dialog).getByText(/kepala divisi, admin departemen, dan superadmin/)).toBeInTheDocument();

    await user.clear(note);
    await user.type(note, "  Libur tanggal 25.  ");
    await user.click(within(dialog).getByRole("checkbox", { name: "Mode pengumuman" }));
    division.conversationSettings.mockResolvedValue(settings({ canEdit: true, pinned: "Libur tanggal 25.", announce: true }));
    await user.click(within(dialog).getByRole("button", { name: "Simpan" }));

    expect(division.setChatSettings).toHaveBeenCalledWith(TEAM_1, DIV_ID, "Libur tanggal 25.", true);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const banner = await screen.findByRole("complementary", { name: "Catatan disematkan" });
    await waitFor(() => expect(banner).toHaveTextContent("Libur tanggal 25."));
    expect(within(banner).getByText("Mode pengumuman aktif")).toBeInTheDocument();
  });

  it("catatan lebih dari 500 karakter ditolak sebelum dikirim", async () => {
    const user = userEvent.setup();
    division.conversationSettings.mockResolvedValue(settings({ canEdit: true, pinned: "" }));
    render(<PinnedNote summary={MOBILE} />);
    await user.click(await screen.findByRole("button", { name: "Sematkan catatan" }));
    const dialog = await screen.findByRole("dialog");
    const note = within(dialog).getByRole("textbox", { name: "Catatan disematkan" });
    await user.click(note);
    await user.paste("a".repeat(501));
    expect(within(dialog).getByText("501 dari 500 karakter")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Simpan" }));
    expect(division.setChatSettings).not.toHaveBeenCalled();
    expect(note).toHaveAttribute("aria-invalid", "true");
    expect(within(dialog).getByText("Catatan paling panjang 500 karakter.")).toBeInTheDocument();
  });

  it("gagal simpan menampilkan pesan di dialog", async () => {
    const user = userEvent.setup();
    division.conversationSettings.mockResolvedValue(settings({ canEdit: true }));
    division.setChatSettings.mockRejectedValue({ code: "rejected", message: "Laptop rekan belum diperbarui." });
    render(<PinnedNote summary={MOBILE} />);
    await user.click(await screen.findByRole("button", { name: "Ubah catatan disematkan" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("checkbox", { name: "Mode pengumuman" }));
    await user.click(within(dialog).getByRole("button", { name: "Simpan" }));
    expect(await within(dialog).findByText("Pengaturan chat belum tersimpan")).toBeInTheDocument();
    expect(within(dialog).getByText("Laptop rekan belum diperbarui.")).toBeInTheDocument();
  });

  it("tanpa perubahan, Simpan hanya menutup dialog", async () => {
    const user = userEvent.setup();
    division.conversationSettings.mockResolvedValue(settings({ canEdit: true }));
    render(<PinnedNote summary={MOBILE} />);
    await user.click(await screen.findByRole("button", { name: "Ubah catatan disematkan" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Simpan" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(division.setChatSettings).not.toHaveBeenCalled();
  });
});

describe("AnnounceGate", () => {
  it("mode pengumuman tanpa hak menulis mengganti kolom pesan", async () => {
    division.conversationSettings.mockResolvedValue(settings({ announce: true, canWrite: false }));
    renderConv();
    expect(
      await screen.findByText(/Hanya kepala divisi, admin departemen, dan superadmin yang bisa menulis di chat ini/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("channel departemen menyebut admin departemen dan superadmin", async () => {
    division.conversationSettings.mockResolvedValue(settings({ announce: true, canWrite: false, divisionId: null }));
    render(
      <AnnounceGate summary={TIM}>
        <textarea aria-label="Kolom pesan" />
      </AnnounceGate>,
    );
    expect(await screen.findByText(/Hanya admin departemen dan superadmin yang bisa menulis di channel ini/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Kolom pesan" })).toBeNull();
  });

  it("pengelola tetap mendapat kolom pesan", async () => {
    division.conversationSettings.mockResolvedValue(settings({ announce: true, canWrite: true, canEdit: true }));
    renderConv();
    expect(await screen.findByRole("combobox")).toBeInTheDocument();
    expect(await screen.findByText("Mode pengumuman aktif")).toBeInTheDocument();
  });
});

describe("bahasa Inggris", () => {
  it("baris, banner, dialog, dan pengganti kolom pesan dalam bahasa Inggris", async () => {
    const user = userEvent.setup();
    division.conversationSettings.mockResolvedValue(settings({ canEdit: true, announce: true, canWrite: false }));
    renderInLang(
      () => (
        <>
          <PinnedNote summary={MOBILE} />
          <AnnounceGate summary={MOBILE}>
            <textarea aria-label="Message" />
          </AnnounceGate>
        </>
      ),
      "en",
    );
    const banner = await screen.findByRole("complementary", { name: "Pinned note" });
    expect(
      await screen.findByText(/Only division heads, department admins, and superadmins can post in this chat/),
    ).toBeInTheDocument();
    await user.click(within(banner).getByRole("button", { name: "Edit pinned note" }));
    const dialog = await screen.findByRole("dialog", { name: "Note and announcement mode" });
    expect(within(dialog).getByRole("checkbox", { name: "Announcement mode" })).toBeChecked();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(within(dialog).getByText(/of 500 characters/)).toBeInTheDocument();
  });
});
