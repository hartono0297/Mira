// Layar Chat dalam bahasa Inggris: teks tampilan diterjemahkan, isi pesan dan nama tidak.
import { act, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatOverview } from "../../api/chat";
import { setLang } from "../../i18n/core";
import { renderInLang } from "../../test/i18n";
import { Conversation } from "./Conversation";
import { channel, ME, message, penguji, project, today, view } from "./conversationTestData";
import { ConversationList } from "./ConversationList";
import { scopeLabel as listScopeLabel, unreadText } from "./ListFormat";
import { conversationTarget, dayLabel, formatSize, formatTime, fullTime } from "./text";
import { overview, UMUM } from "./testData";

const chat = vi.hoisted(() => ({
  messages: vi.fn(),
  markRead: vi.fn(),
  setFolded: vi.fn(),
  messageReceipts: vi.fn(),
}));

vi.mock("../../api/chat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/chat")>()),
  chatApi: chat,
  subscribeChat: () => () => {},
}));

beforeEach(() => {
  chat.messages.mockResolvedValue(
    view([
      message({ id: "m1", text: "Draft kontraknya sudah saya kirim." }),
      message({ id: "m2", author: penguji, mine: true, at: today(10, 2), text: "", deleted: true }),
    ]),
  );
  chat.markRead.mockResolvedValue(null);
  chat.setFolded.mockResolvedValue(null);
});

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();

describe("Chat dalam bahasa Inggris", () => {
  it("format tanggal, jam, ukuran, dan jumlah memakai gaya Inggris", () => {
    setLang("en");
    const now = new Date(2026, 10, 23, 10, 0);
    expect(formatTime(local(2026, 11, 23, 9, 5))).toBe("09:05");
    expect(dayLabel(local(2026, 11, 23, 8), now)).toBe("Today");
    expect(dayLabel(local(2026, 11, 22, 8), now)).toBe("Yesterday");
    expect(dayLabel(local(2026, 11, 16, 9), now)).toBe("Monday, 16 November 2026");
    expect(fullTime(local(2026, 11, 16, 9, 5))).toBe("Monday, 16 November 2026 at 09:05");
    expect(formatSize(800)).toBe("800 bytes");
    expect(formatSize(1.2 * 1024 * 1024)).toBe("1.2 MB");
    expect(unreadText(3, 1)).toBe("3 unread messages, 1 mentions you");
    expect(unreadText(1, 0)).toBe("1 unread message");
    // Nama tersimpan yang sudah diawali kata Proyek tidak diberi awalan lagi.
    expect(conversationTarget(project({ name: "Alfa" }))).toBe("Project Alfa");
    expect(conversationTarget(project({ name: "Proyek Alfa" }))).toBe("Proyek Alfa");
    expect(listScopeLabel("team", "Desain")).toBe("Department Desain");
    expect(listScopeLabel("org", "Kantor")).toBe("Whole office");
  });

  it("daftar percakapan tampil dalam bahasa Inggris", () => {
    const data: ChatOverview = overview();
    renderInLang(() => (
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
      />
    ));
    const nav = screen.getByRole("navigation", { name: "Conversations" });
    expect(within(nav).getByRole("region", { name: "General" })).toBeInTheDocument();
    expect(within(nav).getByRole("region", { name: "Projects" })).toBeInTheDocument();
    expect(within(nav).getByRole("region", { name: "Direct messages" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chat notification settings" })).toBeInTheDocument();
    // Nama channel adalah data pengguna, tetap apa adanya.
    expect(screen.getByRole("button", { name: /^Channel umum/ })).toBeInTheDocument();
    expect(screen.queryByText("Pesan pribadi")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Daftar percakapan" })).toBeNull();
  });

  it("panel percakapan tampil dalam bahasa Inggris dan ikut berganti bahasa", async () => {
    renderInLang(() => <Conversation summary={channel()} me={ME} onChanged={vi.fn()} onGone={vi.fn()} />);
    expect(screen.getByText("Loading messages...")).toBeInTheDocument();
    expect(await screen.findByText("Draft kontraknya sudah saya kirim.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Today" })).toBeInTheDocument();
    expect(screen.getAllByText("09:12").length).toBeGreaterThan(0);
    expect(screen.getByText("Message deleted", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reply to message from Sari Uji at 09:12" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Message #proyek-a")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(screen.getByText("Project Gedung A")).toBeInTheDocument();
    expect(screen.queryByText("Hari ini")).toBeNull();
    expect(screen.queryByText("Kirim")).toBeNull();
    expect(screen.queryByText("09.12")).toBeNull();

    // Ganti ke bahasa Indonesia tanpa memuat ulang: pemisah hari dan tombol ikut berganti.
    act(() => setLang("id"));
    expect(screen.getByRole("heading", { name: "Hari ini" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Kirim" })).toBeInTheDocument();
    expect(screen.queryByText("Today")).toBeNull();
  });
});
