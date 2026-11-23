import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSummary } from "../../api/chat";
import { Conversation } from "./Conversation";
import { ME, message, orgPeople, PJ, project, projectChatView, view } from "./conversationTestData";

const chat = vi.hoisted(() => ({
  messages: vi.fn(),
  markRead: vi.fn(),
  setMuted: vi.fn(),
  setArchived: vi.fn(),
  deleteChannel: vi.fn(),
  setLocked: vi.fn(),
  group: vi.fn(),
  projectChat: vi.fn(),
  send: vi.fn(),
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
}));

function renderConv(summary: ConversationSummary = project()) {
  const onChanged = vi.fn();
  const onGone = vi.fn();
  const utils = render(<Conversation summary={summary} me={ME} onChanged={onChanged} onGone={onGone} />);
  const rerender = (next: ConversationSummary) =>
    utils.rerender(<Conversation summary={next} me={ME} onChanged={onChanged} onGone={onGone} />);
  return { onChanged, onGone, rerender };
}

async function openMembers(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Proyek · 3 anggota" }));
  return screen.findByRole("dialog", { name: "Anggota proyek (3)" });
}

const BASE_NOTE = "Anggota chat ini selalu sama dengan anggota proyek.";

beforeEach(() => {
  vi.clearAllMocks();
  chat.messages.mockResolvedValue(view([message({ conv: PJ })], { conversation: project() }));
  chat.markRead.mockResolvedValue(null);
  chat.setMuted.mockResolvedValue(null);
  chat.projectChat.mockResolvedValue(projectChatView());
  chat.pickFiles.mockResolvedValue([]);
  org.people.mockResolvedValue(orgPeople);
});

describe("Chat proyek: kepala", () => {
  it("nama proyek tanpa #, ikon grup, tombol Proyek · N anggota, tanpa Tambah orang", async () => {
    renderConv();
    expect(screen.getByRole("heading", { name: "Gedung Alfa" })).toBeInTheDocument();
    expect(screen.queryByText("#Gedung Alfa")).toBeNull();
    expect(document.querySelector(".conv-head-icon")).not.toBeNull();
    const btn = screen.getByRole("button", { name: "Proyek · 3 anggota" });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Proyek Gedung Alfa", { selector: ".conv-scope span" })).toBeNull();
    expect(await screen.findByRole("combobox", { name: "Pesan untuk Proyek Gedung Alfa" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Tambah orang" })).toBeNull();
    // Data anggota baru diambil saat daftar dibuka; tidak ada data grup yang diambil.
    expect(chat.projectChat).not.toHaveBeenCalled();
    expect(chat.group).not.toHaveBeenCalled();
  });

  it("menu hanya berisi Bisukan: tanpa arsip, hapus, ganti nama, atau hanya-baca", async () => {
    const user = userEvent.setup();
    renderConv(project({ canArchive: true, canDelete: true, canLock: true }));
    await user.click(screen.getByRole("button", { name: "Menu Gedung Alfa" }));
    const menu = screen.getByRole("menu", { name: "Aksi untuk Gedung Alfa" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Bisukan"]);
  });

  it("arsip lama dari v0.3 bisa dikembalikan, tapi tidak bisa diarsipkan lagi", async () => {
    const user = userEvent.setup();
    chat.setArchived.mockResolvedValue(null);
    const { onChanged } = renderConv(project({ archived: true, canArchive: true }));
    await user.click(screen.getByRole("button", { name: "Menu Gedung Alfa" }));
    const menu = screen.getByRole("menu", { name: "Aksi untuk Gedung Alfa" });
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Bisukan",
      "Kembalikan dari arsip",
    ]);
    await user.click(within(menu).getByRole("menuitem", { name: "Kembalikan dari arsip" }));
    expect(chat.setArchived).toHaveBeenCalledWith(PJ, false);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("keadaan kosong menyebut proyeknya", async () => {
    chat.messages.mockResolvedValue(view([], { conversation: project() }));
    renderConv();
    expect(
      await screen.findByText("Belum ada pesan di Proyek Gedung Alfa. Tulis pesan pertama di kolom bawah."),
    ).toBeInTheDocument();
  });
});

describe("Chat proyek: daftar anggota", () => {
  it("anggota biasa: pengelola ditandai, Anda ditandai, catatan Board, tanpa tombol", async () => {
    const user = userEvent.setup();
    renderConv();
    const panel = await openMembers(user);
    expect(screen.getByRole("button", { name: "Proyek · 3 anggota" })).toHaveAttribute("aria-expanded", "true");
    expect(chat.projectChat).toHaveBeenCalledWith(PJ);
    const rows = await within(panel).findAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent("Penguji (Anda)");
    expect(within(rows[2]).getByText("Pengelola proyek")).toBeInTheDocument();
    expect(within(rows[0]).queryByText("Pengelola proyek")).toBeNull();
    await waitFor(() => expect(rows[2]).toHaveTextContent("Drafting"));
    // Hanya tombol menu orang; tidak ada tombol untuk mengubah anggota.
    for (const b of within(panel).queryAllByRole("button")) expect(b).toHaveAccessibleName(/^Aksi untuk /);
    expect(panel).toHaveTextContent(`${BASE_NOTE} Pengelola proyek yang mengatur anggotanya di Board.`);
  });

  it("pengelola proyek: catatan mengarah ke Anggota proyek di Board", async () => {
    const user = userEvent.setup();
    chat.projectChat.mockResolvedValue(projectChatView({ canManage: true }));
    renderConv();
    const panel = await openMembers(user);
    await within(panel).findAllByRole("listitem");
    expect(panel).toHaveTextContent(
      `${BASE_NOTE} Untuk menambah atau mengeluarkan orang, buka Anggota proyek di Board.`,
    );
  });

  it("bukan anggota proyek lagi: catatan menyebutnya", async () => {
    const user = userEvent.setup();
    chat.projectChat.mockResolvedValue(projectChatView({ former: true, canManage: false }));
    renderConv(project({ former: true, canPost: false }));
    const panel = await openMembers(user);
    await within(panel).findAllByRole("listitem");
    expect(panel).toHaveTextContent("Anda sudah bukan anggota proyek ini, jadi pesan baru tidak sampai lagi ke laptop Anda.");
    expect(panel).not.toHaveTextContent("Pengelola proyek yang mengatur");
  });

  it("Escape menutup daftar dan fokus kembali ke tombol", async () => {
    const user = userEvent.setup();
    renderConv();
    await openMembers(user);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Anggota proyek (3)" })).toBeNull();
    expect(screen.getByRole("button", { name: "Proyek · 3 anggota" })).toHaveFocus();
  });

  it("klik di luar menutup daftar", async () => {
    const user = userEvent.setup();
    renderConv();
    await openMembers(user);
    await user.click(screen.getByRole("heading", { name: "Gedung Alfa" }));
    expect(screen.queryByRole("dialog", { name: "Anggota proyek (3)" })).toBeNull();
  });

  it("memuat, lalu error dengan Coba lagi", async () => {
    const user = userEvent.setup();
    let fail: (e: unknown) => void = () => {};
    chat.projectChat.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
    renderConv();
    const panel = await openMembers(user);
    expect(within(panel).getByRole("status")).toHaveTextContent("Memuat anggota...");
    fail({ code: "io", message: "Basis data sedang dipakai." });
    expect(await within(panel).findByText("Daftar anggota belum bisa dimuat")).toBeInTheDocument();
    expect(within(panel).getByText("Basis data sedang dipakai.")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Coba lagi" }));
    expect(await within(panel).findAllByRole("listitem")).toHaveLength(3);
  });

  it("jumlah anggota berubah saat daftar terbuka: dimuat ulang", async () => {
    const user = userEvent.setup();
    const { rerender } = renderConv();
    const panel = await openMembers(user);
    await within(panel).findAllByRole("listitem");
    expect(chat.projectChat).toHaveBeenCalledTimes(1);
    rerender(project({ memberCount: 4 }));
    await waitFor(() => expect(chat.projectChat).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Proyek · 4 anggota" })).toBeInTheDocument();
  });

  it("dibuka lagi: dimuat ulang", async () => {
    const user = userEvent.setup();
    renderConv();
    await openMembers(user);
    await user.keyboard("{Escape}");
    await openMembers(user);
    await waitFor(() => expect(chat.projectChat).toHaveBeenCalledTimes(2));
  });
});
