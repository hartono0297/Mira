// Layar laptop dikeluarkan permanen (0.5.1): reset dan mulai dari awal.
import { act, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, OrgInfo } from "../api";
import { appState } from "../test/fixtures";
import { ThemeProvider } from "../theme/ThemeProvider";
import { RemovedScreen } from "./RemovedScreen";

const invoke = vi.hoisted(() => vi.fn());
const render = (ui: ReactElement) => rtlRender(<ThemeProvider>{ui}</ThemeProvider>);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const state = appState({ membership: "removed" }) as AppState & { organization: OrgInfo };
const fresh: AppState = {
  identity: { publicKey: "f".repeat(64), fingerprint: "FFFF 0000 FFFF 0000", displayName: null, createdAt: "2026-11-24T08:00:00Z" },
  organization: null,
  membership: "none",
  dataDir: "C:\\data\\mira",
};

function resets() {
  return invoke.mock.calls.filter(([cmd]) => cmd === "reset_removed_laptop").length;
}

beforeEach(() => {
  invoke.mockReset();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

describe("RemovedScreen", () => {
  it("menjelaskan keluar permanen, tanpa Periksa lagi, dengan sidik jari untuk superadmin", () => {
    render(<RemovedScreen state={state} onReset={vi.fn()} />);
    expect(
      screen.getByRole("heading", { name: "Laptop ini sudah dikeluarkan dari organisasi Kantor Uji" }),
    ).toHaveFocus();
    expect(screen.getByText(/secara permanen/)).toBeInTheDocument();
    expect(screen.getByText(/data lama tetap tersimpan di sini/)).toBeInTheDocument();
    expect(screen.getByText("AAAA AAAA AAAA AAAA")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Periksa lagi" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset dan mulai dari awal" })).toBeInTheDocument();
  });

  it("Reset membuka dialog yang menjelaskan akibatnya; Batal tidak melakukan apa pun", async () => {
    const user = userEvent.setup();
    const onReset = vi.fn();
    render(<RemovedScreen state={state} onReset={onReset} />);
    const opener = screen.getByRole("button", { name: "Reset dan mulai dari awal" });
    await user.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Reset laptop ini?" });
    expect(within(dialog).getByText(/Data organisasi lama di laptop ini dihapus/)).toBeInTheDocument();
    expect(within(dialog).getByText(/mendapat kunci baru/)).toBeInTheDocument();
    expect(within(dialog).getByText(/kembali ke layar awal/)).toBeInTheDocument();
    expect(within(dialog).getByText("Admin akan melihatnya sebagai laptop baru.")).toBeInTheDocument();
    // Fokus awal di Batal supaya Enter tidak langsung menghapus.
    expect(within(dialog).getByRole("button", { name: "Batal" })).toHaveFocus();

    await user.click(within(dialog).getByRole("button", { name: "Batal" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(resets()).toBe(0);
    expect(onReset).not.toHaveBeenCalled();
  });

  it("Hapus data dan reset menjalankan reset lalu menyerahkan AppState baru", async () => {
    const user = userEvent.setup();
    let finish!: (s: AppState) => void;
    invoke.mockImplementation((cmd: string) =>
      cmd === "reset_removed_laptop" ? new Promise<AppState>((res) => (finish = res)) : Promise.resolve(null),
    );
    const onReset = vi.fn();
    render(<RemovedScreen state={state} onReset={onReset} />);
    await user.click(screen.getByRole("button", { name: "Reset dan mulai dari awal" }));
    await user.click(screen.getByRole("button", { name: "Hapus data dan reset" }));

    const busy = screen.getByRole("button", { name: "Mereset..." });
    expect(busy).toBeDisabled();
    expect(screen.getByRole("button", { name: "Batal" })).toBeDisabled();
    expect(resets()).toBe(1);

    await act(async () => finish(fresh));
    await waitFor(() => expect(onReset).toHaveBeenCalledWith(fresh));
  });

  it("reset gagal: pesan tampil di dialog, laptop tetap di layar ini", async () => {
    const user = userEvent.setup();
    invoke.mockRejectedValue({ code: "keystore", message: "Kunci laptop tidak bisa dihapus dari Credential Manager." });
    const onReset = vi.fn();
    render(<RemovedScreen state={state} onReset={onReset} />);
    await user.click(screen.getByRole("button", { name: "Reset dan mulai dari awal" }));
    await user.click(screen.getByRole("button", { name: "Hapus data dan reset" }));

    const dialog = screen.getByRole("dialog");
    expect(
      await within(dialog).findByText(
        "Laptop ini belum di-reset. Kunci laptop tidak bisa dihapus dari Credential Manager.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Hapus data dan reset" })).toBeEnabled();
    expect(onReset).not.toHaveBeenCalled();
  });
});
