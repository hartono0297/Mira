import { act, render, screen, waitFor } from "@testing-library/react";
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

// set_setting ditahan sampai tes memutuskan berhasil atau gagal, supaya urutan bisa diatur.
function deferredSaves(storedMode: string) {
  const calls: string[] = [];
  const pending: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  const waiters: (() => void)[] = [];
  invoke.mockImplementation((cmd: string, args: { key: string; value?: string }) => {
    if (cmd === "set_setting") {
      calls.push(args.value ?? "");
      return new Promise<null>((resolve, reject) => {
        pending.push({ resolve: () => resolve(null), reject });
        waiters.splice(0).forEach((w) => w());
      });
    }
    return Promise.resolve(cmd === "get_setting" && args.key === "theme.mode" ? storedMode : null);
  });
  async function waitForCall(index: number) {
    while (pending.length <= index) await new Promise<void>((r) => waiters.push(r));
  }
  return {
    calls,
    async settle(index: number, ok: boolean) {
      await waitForCall(index);
      if (ok) pending[index].resolve();
      else pending[index].reject({ code: "database", message: `Gagal menyimpan ${calls[index]}.` });
    },
  };
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
    await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("dark"));
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
    await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("light"));
  });

  it("dua pilihan cepat yang gagal kembali ke mode yang benar-benar tersimpan", async () => {
    const user = userEvent.setup();
    const saves = deferredSaves("light");
    renderSection();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Terang" })).toBeChecked());

    await user.click(screen.getByRole("radio", { name: "Gelap" }));
    await user.click(screen.getByRole("radio", { name: "Ikuti Windows" }));
    expect(screen.getByText("Menyimpan pilihan mode...")).toBeInTheDocument();

    await act(async () => saves.settle(0, false));
    // Panggilan kedua masih berjalan: status menyimpan tetap tampil, pilihan tidak dikembalikan.
    expect(screen.getByText("Menyimpan pilihan mode...")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Ikuti Windows" })).toBeChecked();
    expect(screen.queryByText(/Mode belum tersimpan/)).not.toBeInTheDocument();

    await act(async () => saves.settle(1, false));
    expect(await screen.findByText(/dikembalikan ke Terang/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Terang" })).toBeChecked();
    expect(screen.queryByText("Menyimpan pilihan mode...")).not.toBeInTheDocument();
    expect(screen.getAllByText(/Mode belum tersimpan/)).toHaveLength(1);
    expect(saves.calls).toEqual(["dark", "system"]);
  });

  it("kalau pilihan pertama tersimpan dan kedua gagal, kembali ke pilihan pertama", async () => {
    const user = userEvent.setup();
    const saves = deferredSaves("light");
    renderSection();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Terang" })).toBeChecked());

    await user.click(screen.getByRole("radio", { name: "Gelap" }));
    await user.click(screen.getByRole("radio", { name: "Ikuti Windows" }));
    await act(async () => saves.settle(0, true));
    await act(async () => saves.settle(1, false));

    expect(await screen.findByText(/dikembalikan ke Gelap/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Gelap" })).toBeChecked();
    await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("dark"));
  });

  it("menandai Bata dipakai dan tema lain Nanti", async () => {
    invoke.mockResolvedValue(null);
    renderSection();
    expect(screen.getByText("Dipakai")).toBeInTheDocument();
    expect(screen.getAllByText("Nanti")).toHaveLength(2);
    await waitFor(() => expect(invoke).toHaveBeenCalled());
  });
});
