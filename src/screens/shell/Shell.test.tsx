import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appState } from "../../test/fixtures";
import { renderInLang } from "../../test/i18n";
import { setLang } from "../../i18n/core";
import type { AppState, OrgInfo } from "../../api";
import { Shell } from "./Shell";

// Layar dan panel jaringan diganti tiruan: tes ini hanya memeriksa menu sidebar.
vi.mock("../chat/ChatScreen", () => ({ ChatScreen: () => <p>Layar chat</p> }));
vi.mock("../board/BoardScreen", () => ({ BoardScreen: () => <p>Layar board</p> }));
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
