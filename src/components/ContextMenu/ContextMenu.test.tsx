import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { menuItems, SEPARATOR, shortcutText, type MenuEntry } from "./items";
import { placeMenu } from "./MenuPopup";
import { MenuButton, useContextMenu } from "./useContextMenu";

function Row({ name, items }: { name: string; items: MenuEntry[] }) {
  const menu = useContextMenu({ label: `Aksi untuk ${name}`, items });
  return (
    <li {...menu.triggerProps} data-testid={`row-${name}`}>
      <button type="button">{name}</button>
      <input aria-label={`Catatan ${name}`} />
      <MenuButton menu={menu} label={`Aksi lain untuk ${name}`} />
      {menu.element}
    </li>
  );
}

function setup(items: MenuEntry[]) {
  const user = userEvent.setup();
  render(
    <ul>
      <Row name="laporan.docx" items={items} />
    </ul>,
  );
  return { user, rowButton: screen.getByRole("button", { name: "laporan.docx" }) };
}

const basic = () => {
  const open = vi.fn();
  const copy = vi.fn();
  const remove = vi.fn();
  const items = menuItems(
    { id: "open", label: "Buka", onSelect: open },
    { id: "copy", label: "Salin nama", shortcut: "Ctrl+C", onSelect: copy },
    SEPARATOR,
    { id: "remove", label: "Hapus", danger: true, onSelect: remove },
  );
  return { items, open, copy, remove };
};

describe("useContextMenu", () => {
  it("klik kanan membuka menu, item pertama terfokus, Enter menjalankan aksi, fokus kembali", async () => {
    const { items, copy } = basic();
    const { user, rowButton } = setup(items);
    await user.pointer({ keys: "[MouseRight]", target: rowButton });
    const menu = screen.getByRole("menu", { name: "Aksi untuk laporan.docx" });
    expect(menu).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Buka/ })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: /Salin nama/ })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(copy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(rowButton).toHaveFocus();
  });

  it("Shift+F10 membuka menu dari elemen terfokus dan Esc menutup", async () => {
    const { items, open } = basic();
    const { user, rowButton } = setup(items);
    rowButton.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Buka/ })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(rowButton).toHaveFocus();
    expect(open).not.toHaveBeenCalled();
  });

  it("tombol Menu (ContextMenu) membuka menu", async () => {
    const { items } = basic();
    const { user, rowButton } = setup(items);
    rowButton.focus();
    await user.keyboard("{ContextMenu}");
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("event contextmenu sesudah Shift+F10 tidak membuka menu kedua", async () => {
    const { items } = basic();
    const { user, rowButton } = setup(items);
    rowButton.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => {
      rowButton.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
    expect(screen.getAllByRole("menu")).toHaveLength(1);
  });

  it("panah berputar, Home dan End, pemisah dilewati", async () => {
    const { items } = basic();
    const { user, rowButton } = setup(items);
    await user.pointer({ keys: "[MouseRight]", target: rowButton });
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: /Hapus/ })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: /Buka/ })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: /Hapus/ })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("menuitem", { name: /Buka/ })).toHaveFocus();
    expect(screen.getByRole("separator")).toBeInTheDocument();
  });

  it("huruf awal melompat ke item yang cocok", async () => {
    const { items } = basic();
    const { user, rowButton } = setup(items);
    await user.pointer({ keys: "[MouseRight]", target: rowButton });
    await user.keyboard("h");
    expect(screen.getByRole("menuitem", { name: /Hapus/ })).toHaveFocus();
  });

  it("Tab menutup menu dan fokus kembali ke elemen asal", async () => {
    const { items } = basic();
    const { user, rowButton } = setup(items);
    rowButton.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    await user.keyboard("{Tab}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(rowButton).toHaveFocus();
  });

  it("klik di luar menutup tanpa menarik fokus", async () => {
    const { items } = basic();
    const { user, rowButton } = setup(items);
    await user.pointer({ keys: "[MouseRight]", target: rowButton });
    await user.click(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("item nonaktif terbaca alasannya dan tidak bisa dijalankan", async () => {
    const run = vi.fn();
    const items = menuItems(
      { id: "sign", label: "Tandatangani", disabled: "Belum giliran Anda", onSelect: run },
      { id: "open", label: "Buka", onSelect: vi.fn() },
    );
    const { user, rowButton } = setup(items);
    await user.pointer({ keys: "[MouseRight]", target: rowButton });
    const item = screen.getByRole("menuitem", { name: /Tandatangani/ });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveAccessibleDescription("Belum giliran Anda");
    expect(item).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.click(item);
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("pintasan tampil dan diumumkan lewat aria-keyshortcuts", async () => {
    const { items } = basic();
    const { user, rowButton } = setup(items);
    await user.pointer({ keys: "[MouseRight]", target: rowButton });
    const item = screen.getByRole("menuitem", { name: /Salin nama/ });
    expect(item).toHaveTextContent("Ctrl+C");
    expect(item).toHaveAttribute("aria-keyshortcuts", "Control+C");
  });

  it("item berbahaya dengan konfirmasi: Batal tidak menjalankan, Konfirmasi menjalankan", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const items = menuItems({
      id: "remove",
      label: "Keluarkan",
      danger: true,
      confirm: { title: "Keluarkan Ayu?", body: <p>Ayu tidak bisa lagi membuka data kantor.</p>, confirmLabel: "Keluarkan", busyLabel: "Mengeluarkan..." },
      onSelect: remove,
    });
    const { user, rowButton } = setup(items);
    await user.pointer({ keys: "[MouseRight]", target: rowButton });
    expect(screen.getByRole("menuitem", { name: /Keluarkan/ })).toHaveClass("cmenu-danger");
    await user.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog", { name: "Keluarkan Ayu?" });
    expect(screen.getByRole("button", { name: "Batal" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Batal" }));
    expect(remove).not.toHaveBeenCalled();
    expect(dialog).not.toBeInTheDocument();
    expect(rowButton).toHaveFocus();

    await user.pointer({ keys: "[MouseRight]", target: rowButton });
    await user.keyboard("{Enter}");
    const again = screen.getByRole("dialog", { name: "Keluarkan Ayu?" });
    await user.click(screen.getAllByRole("button", { name: "Keluarkan" }).at(-1)!);
    expect(remove).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(again).not.toBeInTheDocument());
  });

  it("konfirmasi yang gagal menampilkan error dan dialog tetap terbuka", async () => {
    const items = menuItems({
      id: "remove",
      label: "Keluarkan",
      danger: true,
      confirm: { title: "Keluarkan Ayu?", body: "Yakin?", confirmLabel: "Ya, keluarkan", busyLabel: "Mengeluarkan..." },
      onSelect: () => Promise.reject({ code: "storage", message: "Penyimpanan penuh." }),
    });
    const { user, rowButton } = setup(items);
    await user.pointer({ keys: "[MouseRight]", target: rowButton });
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Ya, keluarkan" }));
    expect(await screen.findByText("Penyimpanan penuh.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("klik kanan di kolom teks tidak membuka menu baris", async () => {
    const { items } = basic();
    const { user } = setup(items);
    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("textbox", { name: "Catatan laporan.docx" }) });
    expect(screen.queryByRole("menu", { name: "Aksi untuk laporan.docx" })).not.toBeInTheDocument();
  });

  it("menu tanpa item tidak terbuka dan tombol ... tidak tampil", async () => {
    const { user, rowButton } = setup([]);
    await user.pointer({ keys: "[MouseRight]", target: rowButton });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Aksi lain/ })).not.toBeInTheDocument();
  });
});

describe("MenuButton", () => {
  it("membuka menu yang sama, aria-expanded ikut, klik lagi menutup", async () => {
    const { items, open } = basic();
    const { user } = setup(items);
    const more = screen.getByRole("button", { name: "Aksi lain untuk laporan.docx" });
    expect(more).toHaveAttribute("aria-haspopup", "menu");
    expect(more).toHaveAttribute("aria-expanded", "false");
    await user.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(more).toHaveAttribute("aria-controls", screen.getByRole("menu").id);
    await user.click(more);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(more).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: /Buka/ })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(open).toHaveBeenCalledTimes(1);
    expect(more).toHaveFocus();
  });

  it("Enter di tombol ... membuka menu dan Esc mengembalikan fokus ke tombol", async () => {
    const { items } = basic();
    const { user } = setup(items);
    const more = screen.getByRole("button", { name: "Aksi lain untuk laporan.docx" });
    more.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(more).toHaveFocus();
  });
});

describe("placeMenu", () => {
  const view = { width: 800, height: 600 };
  const size = { width: 200, height: 150 };

  it("muncul di titik kursor kalau muat", () => {
    expect(placeMenu({ kind: "point", x: 100, y: 100 }, size, view)).toEqual({ x: 100, y: 100 });
  });

  it("dibalik ke kiri dan ke atas di pojok kanan bawah", () => {
    expect(placeMenu({ kind: "point", x: 790, y: 590 }, size, view)).toEqual({ x: 590, y: 440 });
  });

  it("dijepit ke tepi kalau tetap tidak muat", () => {
    expect(placeMenu({ kind: "point", x: 150, y: 10 }, { width: 200, height: 700 }, view)).toEqual({ x: 150, y: 8 });
  });

  it("di bawah tombol, rata kanan, dan naik ke atas kalau di bawah tidak muat", () => {
    const rect = { left: 700, right: 740, top: 560, bottom: 590, width: 40, height: 30 } as DOMRect;
    expect(placeMenu({ kind: "element", rect, align: "end" }, size, view)).toEqual({ x: 540, y: 406 });
  });
});

describe("menuItems", () => {
  it("membuang item bersyarat dan merapikan pemisah", () => {
    const a = { id: "a", label: "A", onSelect: () => {} };
    const b = { id: "b", label: "B", onSelect: () => {} };
    const out = menuItems(SEPARATOR, false && a, a, null, SEPARATOR, SEPARATOR, b, SEPARATOR, undefined);
    expect(out.map((e) => ("separator" in e ? "|" : e.id))).toEqual(["a", "|", "b"]);
  });

  it("pintasan memakai simbol macOS di Mac", () => {
    expect(shortcutText("Ctrl+Shift+C", true)).toBe("⌘⇧C");
    expect(shortcutText("Ctrl+C", false)).toBe("Ctrl+C");
  });
});

describe("posisi klik kanan", () => {
  it("menu memakai koordinat kursor", async () => {
    const { items } = basic();
    const { rowButton } = setup(items);
    const row = screen.getByTestId("row-laporan.docx");
    row.getBoundingClientRect = () => ({ left: 0, top: 0, right: 500, bottom: 40, width: 500, height: 40, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    fireEvent.contextMenu(rowButton, { clientX: 120, clientY: 20 });
    const menu = screen.getByRole("menu");
    expect(menu.style.left).toBe("120px");
    expect(menu.style.top).toBe("20px");
  });
});
