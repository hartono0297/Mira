// Tes regresi untuk temuan review menu klik kanan v0.4.
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Dialog } from "../Dialog";
import { menuItems, SEPARATOR, type MenuEntry } from "./items";
import { TextFieldMenu } from "./TextFieldMenu";
import { MenuButton, useContextMenu } from "./useContextMenu";

function Row({ items, children }: { items: MenuEntry[]; children?: React.ReactNode }) {
  const menu = useContextMenu({ label: "Aksi untuk baris", items });
  return (
    <li {...menu.triggerProps}>
      <button type="button">Baris</button>
      <span data-testid="teks">Alamat 192.168.1.20</span>
      <MenuButton menu={menu} label="Aksi lain untuk baris" />
      {children}
      {menu.element}
    </li>
  );
}

function rightClick(el: Element) {
  const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  act(() => {
    el.dispatchEvent(ev);
  });
  return ev;
}

describe("menu di dalam dialog modal", () => {
  function DialogWithField() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <Dialog open={open} onOpenChange={setOpen} title="Ganti nama proyek">
          <input aria-label="Nama proyek" defaultValue="Gedung A" />
        </Dialog>
        <TextFieldMenu />
      </>
    );
  }

  it("menu teks dirender di dalam dialog, Esc hanya menutup menu", async () => {
    const user = userEvent.setup();
    render(<DialogWithField />);
    const input = screen.getByRole("textbox", { name: "Nama proyek" });
    input.focus();
    rightClick(input);
    const menu = screen.getByRole("menu", { name: "Menu teks" });
    expect(screen.getByRole("dialog").contains(menu)).toBe(true);
    expect(screen.getByRole("menuitem", { name: "Potong" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Salin" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(input).toHaveFocus();
  });

  it("Pilih semua bisa diklik di dalam dialog", async () => {
    const user = userEvent.setup();
    render(<DialogWithField />);
    const input = screen.getByRole("textbox", { name: "Nama proyek" }) as HTMLInputElement;
    input.focus();
    rightClick(input);
    await user.click(screen.getByRole("menuitem", { name: "Pilih semua" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, "Gedung A".length]);
  });
});

describe("event dari portal tidak membuka menu baris", () => {
  it("Shift+F10 di dialog konfirmasi milik menu tidak membuka menu baris", async () => {
    const user = userEvent.setup();
    const items = menuItems({
      id: "cancel",
      label: "Batalkan permintaan",
      danger: true,
      confirm: { title: "Batalkan permintaan ini?", body: "Yakin?", confirmLabel: "Batalkan permintaan", busyLabel: "Membatalkan..." },
      onSelect: vi.fn(),
    });
    render(
      <ul>
        <Row items={items} />
      </ul>,
    );
    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: "Baris" }) });
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Batal" })).toHaveFocus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    rightClick(screen.getByText("Yakin?"));
    expect(screen.queryByRole("menu", { name: "Aksi untuk baris" })).not.toBeInTheDocument();
  });
});

describe("item yang berubah selagi menu terbuka", () => {
  function Changing() {
    const [items, setItems] = useState<MenuEntry[]>([
      { id: "edit", label: "Edit di Word", onSelect: () => {} },
      { id: "copy", label: "Salin nama", onSelect: () => {} },
    ]);
    return (
      <ul>
        <Row items={items} />
        <button type="button" onClick={() => setItems([{ id: "copy", label: "Salin nama", onSelect: () => {} }])}>
          ubah-edit
        </button>
        <button type="button" onClick={() => setItems([])}>
          kosongkan
        </button>
      </ul>
    );
  }

  it("item terfokus hilang: fokus pindah ke item yang tersisa, keyboard tetap jalan", async () => {
    const user = userEvent.setup();
    render(<Changing />);
    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: "Baris" }) });
    expect(screen.getByRole("menuitem", { name: "Edit di Word" })).toHaveFocus();
    act(() => screen.getByText("ubah-edit").click());
    expect(screen.getByRole("menuitem", { name: "Salin nama" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("semua item hilang: menu tertutup", async () => {
    const user = userEvent.setup();
    render(<Changing />);
    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: "Baris" }) });
    act(() => screen.getByText("kosongkan").click());
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

describe("teks yang dipilih di baris", () => {
  it("klik kanan di atas teks terpilih menambah Salin di atas menu baris", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText, readText: vi.fn() }, configurable: true });
    render(
      <ul>
        <Row items={menuItems({ id: "move", label: "Ubah departemen", onSelect: vi.fn() }, SEPARATOR, { id: "role", label: "Ubah peran", onSelect: vi.fn() })} />
      </ul>,
    );
    const span = screen.getByTestId("teks");
    const range = document.createRange();
    range.selectNodeContents(span);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    rightClick(span);
    const labels = screen.getAllByRole("menuitem").map((e) => e.getAttribute("data-menu-item"));
    expect(labels).toEqual(["copy-selection", "move", "role"]);
    await user.keyboard("{Enter}");
    expect(writeText).toHaveBeenCalledWith("Alamat 192.168.1.20");
    window.getSelection()?.removeAllRanges();
  });

  it("baris tanpa item: klik kanan teks terpilih memakai menu Salin global", () => {
    render(
      <>
        <ul>
          <Row items={[]} />
        </ul>
        <TextFieldMenu />
      </>,
    );
    const span = screen.getByTestId("teks");
    const range = document.createRange();
    range.selectNodeContents(span);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    rightClick(span);
    expect(screen.getByRole("menu", { name: "Menu teks" })).toBeInTheDocument();
    window.getSelection()?.removeAllRanges();
  });
});

describe("aksesibilitas item", () => {
  it("nama item hanya labelnya, alasan nonaktif hanya deskripsi", async () => {
    const user = userEvent.setup();
    render(
      <ul>
        <Row items={menuItems({ id: "export", label: "Simpan salinan", disabled: "Unduh dulu isinya dari rekan", onSelect: vi.fn() })} />
      </ul>,
    );
    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: "Baris" }) });
    const item = screen.getByRole("menuitem", { name: "Simpan salinan" });
    expect(item).toHaveAccessibleName("Simpan salinan");
    expect(item).toHaveAccessibleDescription("Unduh dulu isinya dari rekan");
  });

  it("klik item nonaktif tidak melepas fokus dari menu", async () => {
    const user = userEvent.setup();
    render(
      <ul>
        <Row items={menuItems({ id: "a", label: "Buka", onSelect: vi.fn() }, { id: "b", label: "Simpan salinan", disabled: "Belum ada", onSelect: vi.fn() })} />
      </ul>,
    );
    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: "Baris" }) });
    await user.click(screen.getByRole("menuitem", { name: "Simpan salinan" }));
    expect(screen.getByRole("menu").contains(document.activeElement)).toBe(true);
  });

  it("panah atas di tombol ... membuka menu dengan item terakhir terfokus", async () => {
    const user = userEvent.setup();
    render(
      <ul>
        <Row items={menuItems({ id: "a", label: "Buka", onSelect: vi.fn() }, { id: "b", label: "Hapus", danger: true, onSelect: vi.fn() })} />
      </ul>,
    );
    screen.getByRole("button", { name: "Aksi lain untuk baris" }).focus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Hapus" })).toHaveFocus();
  });

  it("Shift+F10 di dalam menu tidak menutup atau membuka menu kedua", async () => {
    const user = userEvent.setup();
    render(
      <ul>
        <Row items={menuItems({ id: "a", label: "Buka", onSelect: vi.fn() })} />
      </ul>,
    );
    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: "Baris" }) });
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.getByRole("menuitem", { name: "Buka" })).toHaveFocus();
  });

  it("jendela kehilangan fokus: menu tutup dan fokus kembali ke baris", async () => {
    const user = userEvent.setup();
    render(
      <ul>
        <Row items={menuItems({ id: "a", label: "Buka", onSelect: vi.fn() })} />
      </ul>,
    );
    const row = screen.getByRole("button", { name: "Baris" });
    row.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(row).toHaveFocus();
  });
});
