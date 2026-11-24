import { fireEvent, render, screen, within } from "@testing-library/react";
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
vi.mock("../calendar/CalendarScreen", () => ({ CalendarScreen: ({ me }: { me: string }) => <p>Layar kalender {me}</p> }));
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
  window.localStorage.clear();
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

describe("menu Kalender", () => {
  it("ada tepat setelah Board dan membuka layar kalender", async () => {
    const user = userEvent.setup();
    renderShell();
    const nav = screen.getByRole("navigation", { name: "Menu utama" });
    const names = within(nav)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(names.slice(0, 3)).toEqual(["Chat", "Board", "Kalender"]);
    await user.click(within(nav).getByRole("button", { name: "Kalender" }));
    expect(within(nav).getByRole("button", { name: "Kalender" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText(`Layar kalender ${appState().identity.publicKey}`)).toBeInTheDocument();
  });

  it("berbahasa Inggris", () => {
    const state = appState() as AppState & { organization: OrgInfo };
    renderInLang(() => <Shell state={state} onRefresh={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Calendar" })).toBeInTheDocument();
  });
});

describe("sidebar ringkas", () => {
  function collapsedShell() {
    window.localStorage.setItem("mira.sidebar", "collapsed");
    renderShell();
  }

  it("tombol di bawah logo meringkas dan melebarkan", async () => {
    const user = userEvent.setup();
    renderShell();
    const aside = document.getElementById("main-sidebar");
    expect(aside?.tagName).toBe("ASIDE");
    const toggle = screen.getByRole("button", { name: "Ringkas menu" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls", "main-sidebar");
    expect(toggle).toHaveAttribute("aria-keyshortcuts", "Control+B");
    expect(document.querySelector(".shell")).not.toHaveClass("side-collapsed");

    await user.click(toggle);
    expect(document.querySelector(".shell")).toHaveClass("side-collapsed");
    expect(toggle).toHaveAccessibleName("Lebarkan menu");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(window.localStorage.getItem("mira.sidebar")).toBe("collapsed");
  });

  it("Ctrl+B meringkas dari mana pun", () => {
    renderShell();
    fireEvent.keyDown(document.body, { key: "b", code: "KeyB", ctrlKey: true });
    expect(document.querySelector(".shell")).toHaveClass("side-collapsed");
  });

  it("nama aksesibel menu dan arti angka tetap utuh", () => {
    counts.value = { chat: 3, board: 0, sign: 0, org: 250 };
    collapsedShell();
    expect(document.querySelector(".shell")).toHaveClass("side-collapsed");
    const nav = screen.getByRole("navigation", { name: "Menu utama" });
    expect(within(nav).getByRole("button", { name: "Chat, 3 belum dibaca" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Kalender" })).toBeInTheDocument();
    const org = within(nav).getByRole("button", { name: "Organisasi, lebih dari 99 permintaan bergabung menunggu" });
    expect(within(org).getByText("99+")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lebarkan menu" })).toBeInTheDocument();
  });

  it("tooltip muncul saat fokus keyboard dan hilang dengan Escape", async () => {
    const user = userEvent.setup();
    counts.value = { chat: 3, board: 0, sign: 0, org: 0 };
    collapsedShell();
    await user.tab();
    const toggle = screen.getByRole("button", { name: "Lebarkan menu" });
    expect(toggle).toHaveFocus();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Lebarkan menu (Ctrl+B)");
    await user.tab();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Chat, 3 belum dibaca");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("tooltip muncul saat kursor di atas ikon, tidak saat sidebar lebar", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.hover(screen.getByRole("button", { name: "Board" }));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.hover(screen.getByRole("button", { name: "Ringkas menu" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Ringkas menu (Ctrl+B)");
  });

  it("klik tidak memunculkan tooltip karena fokus", async () => {
    const user = userEvent.setup();
    collapsedShell();
    const board = screen.getByRole("button", { name: "Board" });
    await user.click(board);
    await user.unhover(board);
    expect(board).toHaveFocus();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("profil: hanya avatar, nama dan kantor tetap terbaca dan jadi tooltip", async () => {
    const user = userEvent.setup();
    collapsedShell();
    const state = appState() as AppState & { organization: OrgInfo };
    const me = document.querySelector(".side-me") as HTMLElement;
    expect(within(me).getByText(state.identity.displayName ?? "")).toBeInTheDocument();
    expect(me).toHaveTextContent(state.organization.name);
    await user.hover(me);
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent(state.identity.displayName ?? "");
    expect(tip).toHaveTextContent(state.organization.name);
    expect(tip.textContent).not.toContain(", peran ");
  });
});
