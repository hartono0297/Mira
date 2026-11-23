// Tes keyboard dan fokus untuk menu klik kanan board dengan sub-menu.
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Dialog } from "../../components/Dialog";
import { MenuButton, SEPARATOR, type ContextMenuHandle, type MenuEntry } from "../../components/ContextMenu";
import { boardMenuItems, submenu, useBoardMenu, type BoardMenuEntry } from "./useBoardMenu";

const MENU = "Aksi untuk TES-1";
const SUB = "Pindahkan TES-1 ke";

function makeItems() {
  const fn = { open: vi.fn(), todo: vi.fn(), doing: vi.fn(), done: vi.fn(), copy: vi.fn() };
  const items = boardMenuItems(
    { id: "open", label: "Buka task", onSelect: fn.open },
    submenu({
      id: "move",
      label: "Pindahkan ke",
      menuLabel: SUB,
      items: [
        { id: "todo", label: "To do", disabled: "Task sudah di kolom ini", onSelect: fn.todo },
        { id: "doing", label: "Dikerjakan", onSelect: fn.doing },
        { id: "done", label: "Selesai", onSelect: fn.done },
      ],
    }),
    SEPARATOR,
    { id: "copy", label: "Salin kode TES-1", shortcut: "Ctrl+C", onSelect: fn.copy },
  );
  return { items, fn };
}

let handle: ContextMenuHandle | null = null;

function Row({ items }: { items: BoardMenuEntry[] }) {
  const menu = useBoardMenu({ label: MENU, items });
  handle = menu;
  return (
    <li {...menu.triggerProps}>
      <button type="button">Kartu TES-1</button>
      <MenuButton menu={menu} label="Aksi lain untuk TES-1" />
      <span data-testid="state">{menu.isOpen ? "terbuka" : "tertutup"}</span>
      {menu.element}
    </li>
  );
}

function setup(items: BoardMenuEntry[] = makeItems().items) {
  const user = userEvent.setup();
  render(
    <>
      <ul>
        <Row items={items} />
      </ul>
      <button type="button">Di luar</button>
    </>,
  );
  return { user, card: screen.getByRole("button", { name: "Kartu TES-1" }) };
}

// contextmenu tanpa pointerdown, seperti tombol Menu atau klik kanan yang
// tidak didahului pointerdown di jsdom.
function rightClick(el: Element, x = 100, y = 120) {
  act(() => {
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y }));
  });
}

async function openSubByKeyboard(user: ReturnType<typeof userEvent.setup>, card: HTMLElement) {
  await user.pointer({ keys: "[MouseRight]", target: card });
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("menuitem", { name: "Pindahkan ke" })).toHaveFocus();
  await user.keyboard("{Enter}");
  return screen.getByRole("menu", { name: SUB });
}

const menus = () => screen.queryAllByRole("menu");

describe("menu utama", () => {
  it("klik kanan membuka menu; item sub-menu bertanda ›, punya aria-haspopup, tanpa aria-keyshortcuts", async () => {
    const { user, card } = setup();
    await user.pointer({ keys: "[MouseRight]", target: card });
    expect(screen.getByRole("menu", { name: MENU })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Buka task" })).toHaveFocus();
    const item = screen.getByRole("menuitem", { name: "Pindahkan ke" });
    expect(item).toHaveAccessibleName("Pindahkan ke");
    expect(item).toHaveAttribute("aria-haspopup", "menu");
    expect(item).not.toHaveAttribute("aria-keyshortcuts");
    expect(item).toHaveTextContent("›");
    // Item biasa tetap punya pintasan dan tidak punya aria-haspopup.
    const copy = screen.getByRole("menuitem", { name: "Salin kode TES-1" });
    expect(copy).toHaveAttribute("aria-keyshortcuts", "Control+C");
    expect(copy).not.toHaveAttribute("aria-haspopup");
  });

  it("panah kanan di item biasa dan panah kiri di menu utama tidak melakukan apa-apa", async () => {
    const { items, fn } = makeItems();
    const { user, card } = setup(items);
    await user.pointer({ keys: "[MouseRight]", target: card });
    const first = screen.getByRole("menuitem", { name: "Buka task" });
    await user.keyboard("{ArrowRight}");
    expect(menus()).toHaveLength(1);
    expect(first).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(menus()).toHaveLength(1);
    expect(screen.getByRole("menu", { name: MENU })).toBeInTheDocument();
    expect(first).toHaveFocus();
    expect(fn.open).not.toHaveBeenCalled();
  });

  it("panah kanan di item sub-menu yang nonaktif tidak membukanya", async () => {
    const { user, card } = setup(
      boardMenuItems(
        { id: "open", label: "Buka task", onSelect: vi.fn() },
        submenu({ id: "move", label: "Pindahkan ke", menuLabel: SUB, disabled: "Tidak boleh memindah", items: [{ id: "a", label: "A", onSelect: vi.fn() }] }),
      ),
    );
    await user.pointer({ keys: "[MouseRight]", target: card });
    await user.keyboard("{ArrowDown}");
    const item = screen.getByRole("menuitem", { name: "Pindahkan ke" });
    expect(item).toHaveAccessibleDescription("Tidak boleh memindah");
    await user.keyboard("{ArrowRight}");
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("menu", { name: SUB })).not.toBeInTheDocument();
    expect(item).toHaveFocus();
  });
});

describe("membuka sub-menu", () => {
  async function expectSubOpen() {
    const sub = screen.getByRole("menu", { name: SUB });
    expect(menus()).toHaveLength(1);
    const all = screen.getAllByRole("menuitem");
    expect(all[0]).toHaveAccessibleName("Kembali");
    expect(all.map((e) => e.getAttribute("data-label"))).toEqual(["Kembali", "To do", "Dikerjakan", "Selesai"]);
    // Fokus di pilihan pertama sesudah Kembali.
    expect(screen.getByRole("menuitem", { name: "To do" })).toHaveFocus();
    return sub;
  }

  it("dengan klik", async () => {
    const { user, card } = setup();
    await user.pointer({ keys: "[MouseRight]", target: card });
    await user.click(screen.getByRole("menuitem", { name: "Pindahkan ke" }));
    await expectSubOpen();
  });

  it("dengan Enter", async () => {
    const { user, card } = setup();
    await openSubByKeyboard(user, card);
    await expectSubOpen();
  });

  it("dengan Spasi", async () => {
    const { user, card } = setup();
    await user.pointer({ keys: "[MouseRight]", target: card });
    await user.keyboard("{ArrowDown}[Space]");
    await expectSubOpen();
  });

  it("dengan panah kanan", async () => {
    const { user, card } = setup();
    await user.pointer({ keys: "[MouseRight]", target: card });
    await user.keyboard("{ArrowDown}{ArrowRight}");
    await expectSubOpen();
  });

  it("Kembali tetap terjangkau dengan panah atas dan Home", async () => {
    const { user, card } = setup();
    await openSubByKeyboard(user, card);
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Kembali" })).toHaveFocus();
    await user.keyboard("{End}{Home}");
    expect(screen.getByRole("menuitem", { name: "Kembali" })).toHaveFocus();
  });

  it("sub-menu dengan satu pilihan saja: fokus di pilihan itu", async () => {
    const { user, card } = setup(
      boardMenuItems(submenu({ id: "move", label: "Pindahkan ke", menuLabel: SUB, items: [{ id: "a", label: "Selesai", onSelect: vi.fn() }] })),
    );
    await user.pointer({ keys: "[MouseRight]", target: card });
    await user.keyboard("{Enter}");
    expect(screen.getByRole("menuitem", { name: "Selesai" })).toHaveFocus();
  });
});

describe("posisi sub-menu", () => {
  // jsdom tidak menghitung tata letak. Menu (role=menu) diberi ukuran tetap
  // dan posisi dari style-nya; elemen lain memakai kotak besar yang memuat
  // titik klik.
  function mockRects(size: { menu: { width: number; height: number }; sub: { width: number; height: number } }) {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const el = this as HTMLElement;
      if (el.getAttribute("role") === "menu") {
        const s = el.getAttribute("aria-label") === SUB ? size.sub : size.menu;
        const left = parseFloat(el.style.left) || 0;
        const top = parseFloat(el.style.top) || 0;
        return { x: left, y: top, left, top, width: s.width, height: s.height, right: left + s.width, bottom: top + s.height, toJSON() {} } as DOMRect;
      }
      return { x: 0, y: 0, left: 0, top: 0, width: 1000, height: 700, right: 1000, bottom: 700, toJSON() {} } as DOMRect;
    });
  }

  it("sub-menu muncul di pojok kiri atas menu utama", async () => {
    mockRects({ menu: { width: 200, height: 150 }, sub: { width: 200, height: 150 } });
    const user = userEvent.setup();
    render(
      <ul>
        <Row items={makeItems().items} />
      </ul>,
    );
    rightClick(screen.getByRole("button", { name: "Kartu TES-1" }), 100, 120);
    const root = screen.getByRole("menu", { name: MENU });
    expect([root.style.left, root.style.top]).toEqual(["100px", "120px"]);
    await user.keyboard("{ArrowDown}{ArrowRight}");
    const sub = screen.getByRole("menu", { name: SUB });
    expect([sub.style.left, sub.style.top]).toEqual(["100px", "120px"]);
  });

  it("sub-menu yang lebih besar di dekat tepi tetap berimpit dengan menu utama, tidak melompat ke sisi lain", async () => {
    // Jendela jsdom 1024 x 768.
    mockRects({ menu: { width: 200, height: 150 }, sub: { width: 400, height: 300 } });
    const user = userEvent.setup();
    render(
      <ul>
        <Row items={makeItems().items} />
      </ul>,
    );
    rightClick(screen.getByRole("button", { name: "Kartu TES-1" }), 900, 600);
    const root = screen.getByRole("menu", { name: MENU });
    // Menu utama dibalik ke kiri kursor: 900 - 200.
    expect([root.style.left, root.style.top]).toEqual(["700px", "600px"]);
    await user.keyboard("{ArrowDown}{ArrowRight}");
    const sub = screen.getByRole("menu", { name: SUB });
    // Dijepit ke tepi: 1024 - 400 - 8 dan 768 - 300 - 8.
    expect([sub.style.left, sub.style.top]).toEqual(["616px", "460px"]);
  });

  it("Kembali memunculkan menu utama di posisi semula", async () => {
    mockRects({ menu: { width: 200, height: 150 }, sub: { width: 240, height: 180 } });
    const user = userEvent.setup();
    render(
      <ul>
        <Row items={makeItems().items} />
      </ul>,
    );
    rightClick(screen.getByRole("button", { name: "Kartu TES-1" }), 100, 120);
    await user.keyboard("{ArrowDown}{ArrowRight}");
    await user.keyboard("{ArrowLeft}");
    const root = screen.getByRole("menu", { name: MENU });
    expect([root.style.left, root.style.top]).toEqual(["100px", "120px"]);
  });
});

describe("kembali dan menutup", () => {
  it("panah kiri kembali ke menu utama dengan fokus di item sub-menu tadi", async () => {
    const { user, card } = setup();
    await openSubByKeyboard(user, card);
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("menu", { name: MENU })).toBeInTheDocument();
    expect(menus()).toHaveLength(1);
    expect(screen.getByRole("menuitem", { name: "Pindahkan ke" })).toHaveFocus();
    // Menu utama tetap jalan: Esc menutup dan fokus kembali ke kartu.
    await user.keyboard("{Escape}");
    expect(menus()).toHaveLength(0);
    expect(card).toHaveFocus();
  });

  it("item Kembali (Enter dan klik) kembali ke menu utama", async () => {
    const { user, card } = setup();
    await openSubByKeyboard(user, card);
    await user.keyboard("{ArrowUp}{Enter}");
    expect(screen.getByRole("menu", { name: MENU })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Pindahkan ke" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("menuitem", { name: "Kembali" }));
    expect(screen.getByRole("menu", { name: MENU })).toBeInTheDocument();
    expect(screen.getByRole("menu", { name: MENU }).contains(document.activeElement)).toBe(true);
  });

  it("menu utama dari Kembali tertutup saat elemen asalnya diklik", async () => {
    const { user, card } = setup();
    await openSubByKeyboard(user, card);
    await user.keyboard("{ArrowLeft}");
    await user.click(card);
    expect(menus()).toHaveLength(0);
  });

  it("Esc di sub-menu menutup semuanya dan fokus kembali ke elemen yang diklik kanan", async () => {
    const { user, card } = setup();
    await openSubByKeyboard(user, card);
    await user.keyboard("{Escape}");
    expect(menus()).toHaveLength(0);
    expect(card).toHaveFocus();
    expect(screen.getByTestId("state")).toHaveTextContent("tertutup");
  });

  it("Esc di sub-menu yang dibuka dengan Shift+F10 mengembalikan fokus ke elemen terfokus", async () => {
    const { user, card } = setup();
    card.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.getByRole("menu", { name: MENU })).toBeInTheDocument();
    await user.keyboard("{ArrowDown}{ArrowRight}");
    expect(screen.getByRole("menu", { name: SUB })).toBeInTheDocument();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("menuitem", { name: "Pindahkan ke" })).toHaveFocus();
    await user.keyboard("{ArrowRight}{Escape}");
    expect(menus()).toHaveLength(0);
    expect(card).toHaveFocus();
  });

  it("Tab di sub-menu menutup dan fokus kembali ke elemen asal", async () => {
    const { user, card } = setup();
    await openSubByKeyboard(user, card);
    await user.keyboard("{Tab}");
    expect(menus()).toHaveLength(0);
    expect(card).toHaveFocus();
  });

  it("klik di luar sub-menu menutup tanpa menarik fokus kembali", async () => {
    const { user, card } = setup();
    await openSubByKeyboard(user, card);
    const outside = screen.getByRole("button", { name: "Di luar" });
    await user.click(outside);
    expect(menus()).toHaveLength(0);
    expect(outside).toHaveFocus();
    expect(card).not.toHaveFocus();
  });

  it("isOpen benar selama sub-menu terbuka; close() menutup sub-menu dan mengembalikan fokus", async () => {
    const { user, card } = setup();
    await openSubByKeyboard(user, card);
    expect(screen.getByTestId("state")).toHaveTextContent("terbuka");
    expect(handle?.isOpen).toBe(true);
    expect(handle?.menuId).toBe(screen.getByRole("menu", { name: SUB }).id);
    act(() => handle?.close());
    expect(menus()).toHaveLength(0);
    expect(screen.getByTestId("state")).toHaveTextContent("tertutup");
    expect(card).toHaveFocus();
  });
});

describe("baris tanpa elemen yang bisa difokus", () => {
  function PlainRow({ items }: { items: BoardMenuEntry[] }) {
    const menu = useBoardMenu({ label: MENU, items });
    return (
      <li {...menu.triggerProps}>
        <span>Teks tanpa tombol</span>
        {menu.element}
      </li>
    );
  }

  it("sub-menu terbuka, Kembali membuka menu utama lagi, Esc menutup", async () => {
    const user = userEvent.setup();
    render(
      <ul>
        <PlainRow items={makeItems().items} />
      </ul>,
    );
    rightClick(screen.getByText("Teks tanpa tombol"));
    await user.keyboard("{ArrowDown}{ArrowRight}");
    expect(screen.getByRole("menu", { name: SUB })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "To do" })).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("menu", { name: MENU })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Pindahkan ke" })).toHaveFocus();
    await user.keyboard("{ArrowRight}{Escape}");
    expect(menus()).toHaveLength(0);
  });
});

describe("memilih di sub-menu", () => {
  it("Enter menjalankan onSelect sekali, menutup menu, fokus kembali sebelum onSelect berjalan", async () => {
    const { items, fn } = makeItems();
    let focusedAtSelect: Element | null = null;
    fn.doing.mockImplementation(() => {
      focusedAtSelect = document.activeElement;
    });
    const { user, card } = setup(items);
    await openSubByKeyboard(user, card);
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Dikerjakan" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(fn.doing).toHaveBeenCalledTimes(1);
    expect(focusedAtSelect).toBe(card);
    expect(menus()).toHaveLength(0);
    expect(card).toHaveFocus();
    expect(fn.done).not.toHaveBeenCalled();
    expect(fn.open).not.toHaveBeenCalled();
  });

  it("klik menjalankan onSelect sekali", async () => {
    const { items, fn } = makeItems();
    const { user, card } = setup(items);
    await openSubByKeyboard(user, card);
    await user.click(screen.getByRole("menuitem", { name: "Selesai" }));
    expect(fn.done).toHaveBeenCalledTimes(1);
    expect(menus()).toHaveLength(0);
    expect(card).toHaveFocus();
  });

  it("item nonaktif tidak berjalan dan alasannya jadi deskripsi", async () => {
    const { items, fn } = makeItems();
    const { user, card } = setup(items);
    await openSubByKeyboard(user, card);
    const todo = screen.getByRole("menuitem", { name: "To do" });
    expect(todo).toHaveAccessibleName("To do");
    expect(todo).toHaveAccessibleDescription("Task sudah di kolom ini");
    expect(todo).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Enter}");
    await user.keyboard("[Space]");
    await user.click(todo);
    expect(fn.todo).not.toHaveBeenCalled();
    expect(screen.getByRole("menu", { name: SUB })).toBeInTheDocument();
    expect(screen.getByRole("menu", { name: SUB }).contains(document.activeElement)).toBe(true);
  });
});

describe("membuka lagi selagi sub-menu terbuka", () => {
  it("klik kanan lagi membuka menu utama, bukan dua menu", async () => {
    const { user, card } = setup();
    await openSubByKeyboard(user, card);
    await user.pointer({ keys: "[MouseRight]", target: card });
    expect(menus()).toHaveLength(1);
    expect(screen.getByRole("menu", { name: MENU })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Buka task" })).toHaveFocus();
  });

  it("contextmenu tanpa pointerdown (tombol Menu) juga hanya membuka menu utama", async () => {
    const { user, card } = setup();
    await openSubByKeyboard(user, card);
    rightClick(card);
    expect(menus()).toHaveLength(1);
    expect(screen.getByRole("menu", { name: MENU })).toBeInTheDocument();
  });
});

describe("sub-menu yang hilang selagi terbuka", () => {
  function Changing() {
    const { items } = makeItems();
    const [list, setList] = useState<BoardMenuEntry[]>(items);
    return (
      <ul>
        <Row items={list} />
        <button type="button" onClick={() => setList(items.filter((e) => !("submenu" in e)))}>
          buang-sub
        </button>
      </ul>
    );
  }

  it("menutup dengan rapi: tanpa menu yatim, isOpen salah, fokus kembali ke elemen asal", async () => {
    const user = userEvent.setup();
    render(<Changing />);
    const card = screen.getByRole("button", { name: "Kartu TES-1" });
    await openSubByKeyboard(user, card);
    act(() => screen.getByText("buang-sub").click());
    expect(menus()).toHaveLength(0);
    expect(screen.getByTestId("state")).toHaveTextContent("tertutup");
    expect(card).toHaveFocus();
    // Menu utama masih bisa dibuka lagi tanpa item sub-menu.
    await user.pointer({ keys: "[MouseRight]", target: card });
    expect(screen.queryByRole("menuitem", { name: "Pindahkan ke" })).not.toBeInTheDocument();
  });
});

describe("di dalam dialog modal", () => {
  function InDialog({ items }: { items: BoardMenuEntry[] }) {
    const [open, setOpen] = useState(true);
    return (
      <Dialog open={open} onOpenChange={setOpen} title="Detail task">
        <ul>
          <Row items={items} />
        </ul>
      </Dialog>
    );
  }

  it("sub-menu dirender di dalam dialog; Esc pertama hanya menutup menu", async () => {
    const user = userEvent.setup();
    render(<InDialog items={makeItems().items} />);
    const card = screen.getByRole("button", { name: "Kartu TES-1" });
    const sub = await openSubByKeyboard(user, card);
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(sub)).toBe(true);
    await user.keyboard("{Escape}");
    expect(menus()).toHaveLength(0);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(card).toHaveFocus();
    // Esc kedua menutup dialog.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("pilihan sub-menu bisa diklik di dalam dialog", async () => {
    const { items, fn } = makeItems();
    const user = userEvent.setup();
    render(<InDialog items={items} />);
    await openSubByKeyboard(user, screen.getByRole("button", { name: "Kartu TES-1" }));
    await user.click(screen.getByRole("menuitem", { name: "Dikerjakan" }));
    expect(fn.doing).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("MenuButton dengan handle ini", () => {
  it("membuka menu utama; aria-controls mengikuti sub-menu; klik lagi menutup semuanya", async () => {
    const { user } = setup();
    const more = screen.getByRole("button", { name: "Aksi lain untuk TES-1" });
    await user.click(more);
    const root = screen.getByRole("menu", { name: MENU });
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(more).toHaveAttribute("aria-controls", root.id);
    await user.keyboard("{ArrowDown}{Enter}");
    const sub = screen.getByRole("menu", { name: SUB });
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(more).toHaveAttribute("aria-controls", sub.id);
    await user.click(more);
    expect(menus()).toHaveLength(0);
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(more).toHaveFocus();
  });

  it("panah kiri kembali ke menu utama milik tombol; Esc mengembalikan fokus ke tombol", async () => {
    const { user } = setup();
    const more = screen.getByRole("button", { name: "Aksi lain untuk TES-1" });
    more.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menu", { name: MENU })).toBeInTheDocument();
    await user.keyboard("{ArrowDown}{ArrowRight}{ArrowLeft}");
    expect(screen.getByRole("menuitem", { name: "Pindahkan ke" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(menus()).toHaveLength(0);
    expect(more).toHaveFocus();
  });
});

describe("aksi sub-menu", () => {
  const CONFIRM = { title: "Hapus dari kolom?", body: "Tidak bisa dibatalkan.", confirmLabel: "Hapus", busyLabel: "Menghapus" };

  function itemsWith(entry: MenuEntry) {
    return boardMenuItems(
      { id: "open", label: "Buka task", onSelect: vi.fn() },
      submenu({ id: "move", label: "Pindahkan ke", menuLabel: SUB, items: [entry] }),
    );
  }

  it("aksi yang gagal (Promise ditolak) dilaporkan ke console.error, tidak hilang diam-diam", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const onSelect = vi.fn(() => Promise.reject(new Error("rusak")));
    const { user, card } = setup(itemsWith({ id: "doing", label: "Dikerjakan", onSelect }));
    await openSubByKeyboard(user, card);
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(err).toHaveBeenCalledWith('Aksi menu "Dikerjakan" gagal', expect.any(Error)));
    expect(menus()).toHaveLength(0);
    err.mockRestore();
  });

  it("aksi yang melempar galat langsung juga dilaporkan, menu tetap tertutup", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const onSelect = vi.fn(() => {
      throw new Error("rusak");
    });
    const { user, card } = setup(itemsWith({ id: "doing", label: "Dikerjakan", onSelect }));
    await openSubByKeyboard(user, card);
    await user.keyboard("{Enter}");
    expect(err).toHaveBeenCalledWith('Aksi menu "Dikerjakan" gagal', expect.any(Error));
    expect(menus()).toHaveLength(0);
    expect(card).toHaveFocus();
    err.mockRestore();
  });

  it("item ber-confirm meminta konfirmasi dulu; Batal tidak menjalankan aksi", async () => {
    const onSelect = vi.fn();
    const { user, card } = setup(itemsWith({ id: "drop", label: "Hapus dari kolom", danger: true, confirm: CONFIRM, onSelect }));
    await openSubByKeyboard(user, card);
    await user.keyboard("{Enter}");
    expect(onSelect).not.toHaveBeenCalled();
    expect(menus()).toHaveLength(0);
    const dialog = screen.getByRole("dialog", { name: "Hapus dari kolom?" });
    expect(dialog).toHaveTextContent("Tidak bisa dibatalkan.");
    await user.click(screen.getByRole("button", { name: "Batal" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("item ber-confirm: tombol konfirmasi menjalankan aksi; galatnya tampil di dialog", async () => {
    const onSelect = vi.fn().mockRejectedValueOnce({ code: "x", message: "Kolom terkunci." }).mockResolvedValueOnce(undefined);
    const { user, card } = setup(itemsWith({ id: "drop", label: "Hapus dari kolom", danger: true, confirm: CONFIRM, onSelect }));
    await openSubByKeyboard(user, card);
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Hapus" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Kolom terkunci.")).toBeInTheDocument();
    expect(screen.getByText("Hapus dari kolom gagal")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Hapus dari kolom?" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Hapus" }));
    expect(onSelect).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("boardMenuItems", () => {
  const a: MenuEntry = { id: "a", label: "A", onSelect: () => {} };
  const b: MenuEntry = { id: "b", label: "B", onSelect: () => {} };
  const full = submenu({ id: "s", label: "S", menuLabel: "S untuk A", items: [a] });
  const empty = submenu({ id: "e", label: "E", menuLabel: "E untuk A", items: [] });
  const onlySep = submenu({ id: "o", label: "O", menuLabel: "O untuk A", items: [SEPARATOR, SEPARATOR] });

  it("membuang false, null, dan undefined", () => {
    expect(boardMenuItems(false, a, null, undefined, b)).toEqual([a, b]);
  });

  it("membuang sub-menu kosong atau yang hanya berisi pemisah", () => {
    expect(boardMenuItems(a, empty, onlySep, full)).toEqual([a, full]);
  });

  it("merapikan pemisah di awal, di akhir, dan yang berurutan", () => {
    expect(boardMenuItems(SEPARATOR, a, SEPARATOR, SEPARATOR, full, SEPARATOR)).toEqual([a, SEPARATOR, full]);
  });

  it("pemisah di sekitar sub-menu yang dibuang tetap rapi", () => {
    expect(boardMenuItems(a, SEPARATOR, empty, SEPARATOR, b)).toEqual([a, SEPARATOR, b]);
    expect(boardMenuItems(a, SEPARATOR, empty, false)).toEqual([a]);
    expect(boardMenuItems(SEPARATOR, empty)).toEqual([]);
  });

  it("sub-menu bertanda submenu: true", () => {
    expect(full.submenu).toBe(true);
  });
});
