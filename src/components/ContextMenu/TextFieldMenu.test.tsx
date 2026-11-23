import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TEXT_MENU, TextFieldMenu } from "./TextFieldMenu";
import { useContextMenu } from "./useContextMenu";

function OwnMenu() {
  const menu = useContextMenu({ label: "Menu baris", items: [{ id: "open", label: "Buka", onSelect: () => {} }] });
  return (
    <div {...menu.triggerProps}>
      <button type="button">Baris</button>
      {menu.element}
    </div>
  );
}

function setup() {
  const user = userEvent.setup();
  render(
    <>
      <p data-testid="text">Teks biasa di layar</p>
      <input aria-label="Nama" defaultValue="Ayu Lestari" />
      <input aria-label="PIN" type="password" defaultValue="246810" />
      <input aria-label="Kode" readOnly defaultValue="ABCD" />
      <textarea aria-label="Kosong" />
      <OwnMenu />
      <TextFieldMenu />
    </>,
  );
  return user;
}

function rightClick(el: Element) {
  const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  act(() => {
    el.dispatchEvent(ev);
  });
  return ev;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TextFieldMenu", () => {
  it("menu bawaan WebView dimatikan di luar kolom teks", () => {
    setup();
    const ev = rightClick(screen.getByTestId("text"));
    expect(ev.defaultPrevented).toBe(true);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("kolom teks mendapat menu Potong, Salin, Tempel, Pilih semua", () => {
    setup();
    const input = screen.getByRole("textbox", { name: "Nama" });
    input.focus();
    (input as HTMLInputElement).setSelectionRange(0, 3);
    const ev = rightClick(input);
    expect(ev.defaultPrevented).toBe(true);
    const menu = screen.getByRole("menu", { name: TEXT_MENU.label });
    const labels = Array.from(menu.querySelectorAll("[role=menuitem] .cmenu-label")).map((e) => e.textContent);
    expect(labels).toEqual(["Potong", "Salin", "Tempel", "Pilih semua"]);
    expect(screen.getByRole("menuitem", { name: /Potong/ })).not.toHaveAttribute("aria-disabled");
  });

  it("tanpa seleksi, Potong dan Salin nonaktif dengan alasan", () => {
    setup();
    const input = screen.getByRole("textbox", { name: "Nama" }) as HTMLInputElement;
    input.focus();
    input.setSelectionRange(2, 2);
    rightClick(input);
    expect(screen.getByRole("menuitem", { name: /Salin/ })).toHaveAccessibleDescription(TEXT_MENU.noSelection);
    expect(screen.getByRole("menuitem", { name: /Potong/ })).toHaveAttribute("aria-disabled", "true");
  });

  it("kolom hanya baca: Potong dan Tempel nonaktif", () => {
    setup();
    rightClick(screen.getByRole("textbox", { name: "Kode" }));
    expect(screen.getByRole("menuitem", { name: /Tempel/ })).toHaveAccessibleDescription(TEXT_MENU.readOnly);
  });

  it("kolom PIN tidak bisa disalin", () => {
    setup();
    const pin = screen.getByLabelText("PIN") as HTMLInputElement;
    pin.focus();
    pin.select();
    rightClick(pin);
    expect(screen.getByRole("menuitem", { name: /Salin/ })).toHaveAccessibleDescription(TEXT_MENU.secret);
  });

  it("Pilih semua memilih seluruh isi dan fokus kembali ke kolom", async () => {
    const user = setup();
    const input = screen.getByRole("textbox", { name: "Nama" }) as HTMLInputElement;
    input.focus();
    rightClick(input);
    await user.click(screen.getByRole("menuitem", { name: /Pilih semua/ }));
    expect(input).toHaveFocus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, "Ayu Lestari".length]);
  });

  it("Salin menjalankan perintah copy dengan seleksi yang dipulihkan", async () => {
    const user = setup();
    const exec = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { value: exec, configurable: true });
    const input = screen.getByRole("textbox", { name: "Nama" }) as HTMLInputElement;
    input.focus();
    input.setSelectionRange(0, 3);
    rightClick(input);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(exec).toHaveBeenCalledWith("copy", false, undefined);
    expect(input).toHaveFocus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 3]);
  });

  it("Tempel membaca papan klip lalu menyisipkan teks", async () => {
    const user = setup();
    const exec = vi.fn(() => false);
    Object.defineProperty(document, "execCommand", { value: exec, configurable: true });
    Object.defineProperty(navigator, "clipboard", { value: { readText: () => Promise.resolve("X"), writeText: vi.fn() }, configurable: true });
    const input = screen.getByRole("textbox", { name: "Nama" }) as HTMLInputElement;
    input.focus();
    input.setSelectionRange(0, 3);
    rightClick(input);
    await user.click(screen.getByRole("menuitem", { name: /Tempel/ }));
    await vi.waitFor(() => expect(input.value).toBe("X Lestari"));
    expect(exec).toHaveBeenCalledWith("insertText", false, "X");
  });

  it("kolom kosong: Pilih semua nonaktif", () => {
    setup();
    rightClick(screen.getByRole("textbox", { name: "Kosong" }));
    expect(screen.getByRole("menuitem", { name: /Pilih semua/ })).toHaveAccessibleDescription(TEXT_MENU.empty);
  });

  it("teks terpilih di luar kolom mendapat menu Salin", () => {
    setup();
    const p = screen.getByTestId("text");
    const range = document.createRange();
    range.selectNodeContents(p);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    rightClick(p);
    expect(screen.getAllByRole("menuitem").map((e) => e.textContent)).toEqual(["SalinCtrl+C"]);
    window.getSelection()?.removeAllRanges();
  });

  it("menu milik layar tidak ditimpa menu teks", () => {
    setup();
    rightClick(screen.getByRole("button", { name: "Baris" }));
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.getByRole("menu", { name: "Menu baris" })).toBeInTheDocument();
  });

  it("Esc menutup dan fokus kembali ke kolom", async () => {
    const user = setup();
    const input = screen.getByRole("textbox", { name: "Nama" });
    input.focus();
    rightClick(input);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(input).toHaveFocus();
  });
});
