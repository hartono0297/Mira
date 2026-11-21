import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODE_CACHE_KEY } from "../../theme/mode";
import { ThemeProvider } from "../../theme/ThemeProvider";
import { AppearanceSection } from "./AppearanceSection";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

function renderSection() {
  return render(
    <ThemeProvider>
      <AppearanceSection />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  invoke.mockReset();
});

describe("Pilihan mode tampilan", () => {
  it("memakai mode tersimpan dari inti Rust", async () => {
    invoke.mockImplementation(async (cmd: string, args: { key: string }) =>
      cmd === "get_setting" && args.key === "theme.mode" ? "dark" : null,
    );
    renderSection();

    await waitFor(() => expect(screen.getByRole("radio", { name: "Gelap" })).toBeChecked());
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("menyimpan pilihan lewat set_setting dan menerapkannya", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(async (cmd: string, args: { key: string }) =>
      cmd === "get_setting" && args.key === "theme.mode" ? "light" : null,
    );
    renderSection();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Terang" })).toBeChecked());

    await user.click(screen.getByRole("radio", { name: "Gelap" }));

    expect(invoke).toHaveBeenCalledWith("set_setting", { key: "theme.mode", value: "dark" });
    await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("dark"));
    expect(window.localStorage.getItem(MODE_CACHE_KEY)).toBe("dark");
  });

  it("mengembalikan pilihan dan menampilkan error kalau gagal disimpan", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(async (cmd: string, args: { key: string }) => {
      if (cmd === "set_setting") throw { code: "database", message: "Pengaturan tidak bisa disimpan." };
      return cmd === "get_setting" && args.key === "theme.mode" ? "light" : null;
    });
    renderSection();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Terang" })).toBeChecked());

    await user.click(screen.getByRole("radio", { name: "Gelap" }));

    expect(await screen.findByText(/Pengaturan tidak bisa disimpan\./)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Terang" })).toBeChecked();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("menandai Bata dipakai dan tema lain Nanti", async () => {
    invoke.mockResolvedValue(null);
    renderSection();
    expect(screen.getByText("Dipakai")).toBeInTheDocument();
    expect(screen.getAllByText("Nanti")).toHaveLength(2);
    await waitFor(() => expect(invoke).toHaveBeenCalled());
  });
});
