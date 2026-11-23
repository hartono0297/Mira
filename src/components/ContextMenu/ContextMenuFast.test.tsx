// Klik kanan cepat (otomasi atau pengguna yang cepat) setelah menu lain ditutup.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { MenuButton, useContextMenu } from "./useContextMenu";
function Row() {
  const menu = useContextMenu({ label: "M", items: [{ id: "a", label: "Buka", onSelect: () => {} }, { id: "b", label: "Salin", onSelect: () => {} }] });
  return (<li {...menu.triggerProps}><button type="button">Baris</button><span>nama</span><MenuButton menu={menu} label="dots" />{menu.element}</li>);
}
it("tombol ..., Esc, lalu klik kanan langsung membuka menu lagi", async () => {
  const user = userEvent.setup();
  render(<ul><Row /></ul>);
  await user.click(screen.getByRole("button", { name: "dots" }));
  expect(screen.getByRole("menu")).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).toBeNull();
  await user.pointer({ keys: "[MouseRight]", target: screen.getByText("nama") });
  expect(screen.getByRole("menu")).toBeInTheDocument();
});
it("klik kanan sungguhan segera setelah Shift+F10 tetap membuka menu", async () => {
  const user = userEvent.setup();
  render(<ul><Row /></ul>);
  screen.getByRole("button", { name: "Baris" }).focus();
  await user.keyboard("{Shift>}{F10}{/Shift}");
  await user.keyboard("{Escape}");
  await user.pointer({ keys: "[MouseRight]", target: screen.getByText("nama") });
  expect(screen.getByRole("menu")).toBeInTheDocument();
});
