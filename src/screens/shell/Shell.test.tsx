import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appState } from "../../test/fixtures";
import { renderInLang } from "../../test/i18n";
import type { AppState, OrgInfo } from "../../api";
import { Shell } from "./Shell";

// Layar dan panel jaringan diganti tiruan: tes ini hanya memeriksa menu sidebar.
vi.mock("../chat/ChatScreen", () => ({ ChatScreen: () => <p>Layar chat</p> }));
vi.mock("../board/BoardScreen", () => ({ BoardScreen: () => <p>Layar board</p> }));
vi.mock("../docs/DocsScreen", () => ({ DocsScreen: () => <p>Layar dokumen</p> }));
vi.mock("../sign/SignScreen", () => ({ SignScreen: () => <p>Layar tanda tangan</p> }));
vi.mock("../org/OrgScreen", () => ({ OrgScreen: () => <p>Layar organisasi</p> }));
vi.mock("../settings/SettingsScreen", () => ({ SettingsScreen: () => <p>Layar pengaturan</p> }));
vi.mock("../../components/Logo", () => ({ Logo: () => null }));
vi.mock("./NetworkPanel",() => ({ NetworkPanel: () => null }));
vi.mock("./NetworkContext", () => ({ NetworkProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));

const counts = vi.hoisted(() => ({ value: { chat: 0, board: 0, sign: 0, org: 0 } }));
vi.mock("./useNavCounts", () => ({ useNavCounts: () => counts.value }));

function renderShell() {
  const state = appState() as AppState & { organization: OrgInfo };
  render(<Shell state={state} onRefresh={vi.fn()} />);
}

beforeEach(() => {
  counts.value = { chat: 0, board: 0, sign: 0, org: 0 };
});

describe("menu sidebar dalam bahasa Inggris", () => {
  it("label dan arti angka berbahasa Inggris", () => {
    counts.value = { chat: 3, board: 1, sign: 0, org: 2 };
    const state = appState() as AppState & { organization: OrgInfo };
    renderInLang(() => <Shell state={state} onRefresh={vi.fn()} />);
    const nav = screen.getByRole("navigation", { name: "Main menu" });
    expect(within(nav).getByRole("button", { name: "Chat, 3 unread" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Board, 1 task due today or overdue" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Documents" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Signatures" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Organization, 2 join requests waiting" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByText(/Dokumen|Tanda tangan|Organisasi|Pengaturan/)).not.toBeInTheDocument();
  });
});

describe("angka di menu sidebar", () => {
  it("menyebut arti angka di nama tombol", () => {
    counts.value = { chat: 3, board: 2, sign: 1, org: 4 };
    renderShell();
    const nav = screen.getByRole("navigation", { name: "Menu utama" });
    expect(within(nav).getByRole("button", { name: "Chat, 3 belum dibaca" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Board, 2 task tenggat hari ini atau lewat" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Tanda tangan, 1 menunggu tanda tangan Anda" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Organisasi, 4 permintaan bergabung menunggu" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Dokumen" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Pengaturan" })).toBeInTheDocument();
  });

  it("tanpa angka saat nol", () => {
    renderShell();
    expect(screen.getByRole("button", { name: "Chat" })).toBeInTheDocument();
    expect(document.querySelector(".side-count")).toBeNull();
  });

  it("di atas 99 tampil 99+", () => {
    counts.value = { chat: 250, board: 0, sign: 0, org: 0 };
    renderShell();
    const chat = screen.getByRole("button", { name: "Chat, lebih dari 99 belum dibaca" });
    expect(within(chat).getByText("99+")).toBeInTheDocument();
  });

  it("angka tetap ada di menu yang sedang aktif", async () => {
    const user = userEvent.setup();
    counts.value = { chat: 0, board: 2, sign: 0, org: 0 };
    renderShell();
    const board = screen.getByRole("button", { name: "Board, 2 task tenggat hari ini atau lewat" });
    await user.click(board);
    expect(board).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("Layar board")).toBeInTheDocument();
    expect(within(board).getByText("2")).toBeInTheDocument();
  });
});
