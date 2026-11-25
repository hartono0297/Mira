import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appState } from "../../test/fixtures";
import { renderInLang } from "../../test/i18n";
import { setLang } from "../../i18n/core";
import { ROLE_LABELS, type AppState, type OrgInfo } from "../../api";
import { clampTop, HOVER_DELAY } from "./NavTooltip";
import { Shell } from "./Shell";

// Layar dan panel jaringan diganti tiruan: tes ini hanya memeriksa menu sidebar.
vi.mock("../chat/ChatScreen", () => ({ ChatScreen: () => <p>Layar chat</p> }));
vi.mock("../board/BoardScreen", () => ({ BoardScreen: () => <p>Layar board</p> }));
vi.mock("../calendar/CalendarScreen", () => ({ CalendarScreen: ({ me }: { me: string }) => <p>Layar kalender {me}</p> }));
vi.mock("../docs/DocsScreen", () => ({ DocsScreen: () => <p>Layar dokumen</p> }));
vi.mock("../sign/SignScreen", () => ({ SignScreen: () => <p>Layar tanda tangan</p> }));
vi.mock("../org/OrgScreen", () => ({ OrgScreen: () => <p>Layar organisasi</p> }));
vi.mock("../settings/SettingsScreen", () => ({
  SettingsScreen: ({ part }: { part: string }) => <p>Layar pengaturan: {part}</p>,
}));
vi.mock("../../components/Logo", () => ({ Logo: () => null }));
vi.mock("./NetworkPanel",() => ({ NetworkPanel: () => null }));
vi.mock("./NetworkContext", () => ({ NetworkProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));

const profile = vi.hoisted(() => ({
  photoHash: { value: null as string | null },
  start: vi.fn(),
  clear: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("../../components/profilePhotos", () => ({
  usePhotoHash: () => profile.photoHash.value,
  // Data foto tidak pernah termuat di tes ini: menu hanya boleh bergantung pada hash.
  usePhotoUrl: () => null,
  refreshProfilePhotos: profile.refresh,
}));
vi.mock("../../components/profile/useChangePhoto", () => ({
  useChangePhoto: () => ({ start: profile.start, busy: false, error: null, element: null }),
}));
vi.mock("../../api/profile", () => ({ profileClearPhoto: profile.clear }));

const counts = vi.hoisted(() => ({ value: { chat: 0, board: 0, sign: 0, org: 0 } }));
vi.mock("./useNavCounts", () => ({ useNavCounts: () => counts.value }));

function renderShell() {
  const state = appState() as AppState & { organization: OrgInfo };
  render(<Shell state={state} onRefresh={vi.fn()} />);
}

beforeEach(() => {
  counts.value = { chat: 0, board: 0, sign: 0, org: 0 };
  profile.photoHash.value = null;
  profile.start.mockReset();
  profile.clear.mockReset().mockResolvedValue(undefined);
  profile.refresh.mockReset().mockResolvedValue(undefined);
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

describe("menu profil di sidebar", () => {
  it("tombol bernama Menu profil Anda dengan nama dan peran sebagai keterangan", () => {
    renderShell();
    const button = screen.getByRole("button", { name: "Menu profil Anda" });
    expect(button).toHaveAttribute("aria-haspopup", "menu");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveAccessibleDescription(/^Penguji,\s*Kantor Uji, peran\s*Superadmin$/);
  });

  it("dibuka dengan keyboard: Enter membuka menu dan fokus di item pertama", async () => {
    const user = userEvent.setup();
    renderShell();
    const button = screen.getByRole("button", { name: "Menu profil Anda" });
    button.focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu", { name: "Menu profil Anda" });
    expect(button).toHaveAttribute("aria-expanded", "true");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Ganti foto", "Buka profil"]);
    await waitFor(() => expect(items[0]).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it("panah bawah juga membuka menu", async () => {
    const user = userEvent.setup();
    renderShell();
    screen.getByRole("button", { name: "Menu profil Anda" }).focus();
    await user.keyboard("{ArrowDown}");
    expect(await screen.findByRole("menu", { name: "Menu profil Anda" })).toBeInTheDocument();
  });

  it("Buka profil membuka Pengaturan > Profil", async () => {
    const user = userEvent.setup();
    renderShell();
    screen.getByRole("button", { name: "Menu profil Anda" }).focus();
    await user.keyboard("{Enter}");
    const item = await screen.findByRole("menuitem", { name: "Buka profil" });
    await user.click(item);
    expect(screen.getByText("Layar pengaturan: profile")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pengaturan" })).toHaveAttribute("aria-current", "page");
  });

  it("Ganti foto memulai pemilihan foto", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getByRole("button", { name: "Menu profil Anda" }));
    await user.click(await screen.findByRole("menuitem", { name: "Ganti foto" }));
    expect(profile.start).toHaveBeenCalledTimes(1);
  });

  it("dengan foto: Hapus foto minta konfirmasi lalu menghapus", async () => {
    const user = userEvent.setup();
    profile.photoHash.value = "f".repeat(64);
    renderShell();
    await user.click(screen.getByRole("button", { name: "Menu profil Anda" }));
    await user.click(await screen.findByRole("menuitem", { name: "Hapus foto" }));
    const dialog = await screen.findByRole("dialog", { name: "Hapus foto profil?" });
    expect(profile.clear).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Hapus foto" }));
    await waitFor(() => expect(profile.clear).toHaveBeenCalledTimes(1));
    expect(profile.refresh).toHaveBeenCalled();
  });

  it("Hapus foto ikut peta pemilik walau data foto belum atau gagal dimuat", async () => {
    const user = userEvent.setup();
    profile.photoHash.value = "e".repeat(64);
    renderShell();
    await user.click(screen.getByRole("button", { name: "Menu profil Anda" }));
    const menu = await screen.findByRole("menu", { name: "Menu profil Anda" });
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Ganti foto",
      "Hapus foto",
      "Buka profil",
    ]);
  });

  it("bahasa Inggris: nama tombol dan item menu", async () => {
    const user = userEvent.setup();
    const state = appState() as AppState & { organization: OrgInfo };
    renderInLang(() => <Shell state={state} onRefresh={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Your profile menu" }));
    expect(await screen.findByRole("menuitem", { name: "Change photo" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Open profile" })).toBeInTheDocument();
    setLang("id");
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
    expect(toggle).not.toHaveAttribute("aria-expanded");
    expect(toggle).toHaveAttribute("aria-controls", "main-sidebar");
    expect(toggle).toHaveAttribute("aria-keyshortcuts", "Control+B");
    expect(document.querySelector(".shell")).not.toHaveClass("side-collapsed");

    await user.click(toggle);
    expect(document.querySelector(".shell")).toHaveClass("side-collapsed");
    expect(toggle).toHaveAccessibleName("Lebarkan menu");
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
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Ringkas menu (Ctrl+B)");
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
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent(state.identity.displayName ?? "");
    expect(tip).toHaveTextContent(state.organization.name);
    expect(tip.textContent).not.toContain(", peran ");
  });

  it("profil: tombol menu tetap bernama dan bisa dibuka dengan keyboard", async () => {
    const user = userEvent.setup();
    collapsedShell();
    const state = appState() as AppState & { organization: OrgInfo };
    const button = screen.getByRole("button", { name: "Menu profil Anda" });
    expect(button).toHaveAccessibleDescription(/^Penguji,\s*Kantor Uji, peran\s*Superadmin$/);
    button.focus();
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      `${state.identity.displayName}\n${state.organization.name} · ${ROLE_LABELS[state.organization.role]}`,
    );
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu", { name: "Menu profil Anda" });
    expect(button).toHaveAttribute("aria-expanded", "true");
    const items = within(menu).getAllByRole("menuitem");
    await waitFor(() => expect(items[0]).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });
});

describe("tooltip sidebar ringkas", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("kursor: muncul setelah jeda, lalu langsung berganti antar ikon", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("mira.sidebar", "collapsed");
    renderShell();
    const started = Date.now();
    await user.hover(screen.getByRole("button", { name: "Board" }));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Board");
    expect(Date.now() - started).toBeGreaterThanOrEqual(HOVER_DELAY - 20);
    await user.hover(screen.getByRole("button", { name: "Kalender" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Kalender");
  });

  it("tetap di dalam jendela di dekat tepi bawah", () => {
    expect(clampTop(580, 60, 600)).toBe(532);
    expect(clampTop(10, 60, 600)).toBe(8);
    expect(clampTop(300, 60, 600)).toBe(270);
  });

  it("posisi diukur setelah tampil", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("mira.sidebar", "collapsed");
    const height = vi.spyOn(window, "innerHeight", "get").mockReturnValue(600);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const tip = this.classList.contains("nav-tip");
      const h = tip ? 60 : 40;
      const top = tip ? 0 : 560;
      return { x: 10, y: top, top, left: 10, right: 54, bottom: top + h, width: 44, height: h, toJSON: () => ({}) };
    });
    renderShell();
    await user.tab();
    const tip = screen.getByRole("tooltip");
    expect(tip.style.top).toBe("532px");
    expect(tip.style.left).toBe("62px");
    expect(height).toHaveBeenCalled();
  });
});

describe("jendela sempit", () => {
  afterEach(() => {
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it("sidebar yang dibuka sementara tertutup lagi setelah memilih menu, tanpa disimpan", async () => {
    const user = userEvent.setup();
    window.matchMedia = vi.fn(
      () =>
        ({
          matches: true,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
    renderShell();
    const shell = document.querySelector(".shell");
    expect(shell).toHaveClass("side-collapsed");
    await user.click(screen.getByRole("button", { name: "Lebarkan menu" }));
    expect(shell).not.toHaveClass("side-collapsed");
    await user.click(screen.getByRole("button", { name: "Board" }));
    expect(shell).toHaveClass("side-collapsed");
    expect(screen.getByText("Layar board")).toBeInTheDocument();
    expect(window.localStorage.getItem("mira.sidebar")).toBeNull();
  });
});
