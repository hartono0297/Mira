import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { AppState } from "./api";
import { ThemeProvider } from "./theme/ThemeProvider";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const ready: AppState = {
  identity: {
    publicKey: "b".repeat(64),
    fingerprint: "A1B2 C3D4 E5F6 0718",
    displayName: "Rina",
    createdAt: "2026-11-22T01:00:00Z",
  },
  organization: { id: "c".repeat(32), name: "Kantor Contoh", role: "superadmin", createdAt: "2026-11-22T01:05:00Z" },
  membership: "active",
  dataDir: "C:\\data\\mira",
};

function renderApp() {
  return render(
    <ThemeProvider>
      <App />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  invoke.mockReset();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

describe("App", () => {
  it("menampilkan layar error jujur kalau dibuka di luar aplikasi desktop", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    renderApp();
    expect(await screen.findByRole("heading", { name: "Mira belum bisa dibuka" })).toBeInTheDocument();
    expect(screen.getByText(/browser biasa/)).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("menampilkan error dari inti Rust lalu bisa coba lagi", async () => {
    const user = userEvent.setup();
    let fail = true;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_app_state") {
        if (fail) throw { code: "database", message: "Database tidak bisa dibuka." };
        return ready;
      }
      return null;
    });
    renderApp();
    expect(await screen.findByText("Database tidak bisa dibuka.")).toBeInTheDocument();

    fail = false;
    await user.click(screen.getByRole("button", { name: "Coba lagi" }));
    expect(await screen.findByRole("navigation", { name: "Menu utama" })).toBeInTheDocument();
  });

  it("kerangka utama berpindah menu tanpa router", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(async (cmd: string) => (cmd === "get_app_state" ? ready : null));
    renderApp();

    // Tahap 2: layar Chat sungguhan menggantikan keadaan kosong Tahap 0.
    expect(await screen.findByRole("heading", { name: "Chat", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("Kantor Contoh", { exact: false })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Pengaturan" }));
    expect(screen.getByRole("button", { name: "Pengaturan" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("radio", { name: "Ikuti Windows" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Laptop ini" }));
    expect(screen.getByText("A1B2 C3D4 E5F6 0718")).toBeInTheDocument();
    expect(screen.getByText("C:\\data\\mira")).toBeInTheDocument();
  });

  it("menu Organisasi ada di kerangka utama", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(async (cmd: string) => (cmd === "get_app_state" ? ready : null));
    renderApp();
    await user.click(await screen.findByRole("button", { name: "Organisasi" }));
    expect(screen.getByRole("heading", { name: "Organisasi", level: 1 })).toBeInTheDocument();
  });

  it("laptop yang dikeluarkan melihat layar penuh dengan langkah berikutnya", async () => {
    const state: AppState = { ...ready, membership: "removed" };
    invoke.mockImplementation(async (cmd: string) => (cmd === "get_app_state" ? state : null));
    renderApp();

    expect(
      await screen.findByRole("heading", { name: "Laptop ini sudah dikeluarkan dari Kantor Contoh" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/tetap tersimpan di sini/)).toBeInTheDocument();
    expect(screen.getByText(/Untuk bergabung lagi, reset laptop ini dulu/)).toBeInTheDocument();
    expect(screen.getByText("A1B2 C3D4 E5F6 0718")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Menu utama" })).not.toBeInTheDocument();
    // 0.6.0: keluar permanen tidak bisa dicek ulang; jalan keluarnya reset.
    expect(screen.queryByRole("button", { name: "Periksa lagi" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset dan mulai dari awal" })).toBeInTheDocument();
  });

  it("status jaringan removed memuat ulang data lalu menampilkan layar dikeluarkan", async () => {
    let state: AppState = ready;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_app_state") return state;
      if (cmd === "get_network_status") {
        state = { ...ready, membership: "removed" };
        return {
          state: "removed",
          listenPort: null,
          localAddresses: [],
          shareLink: "",
          qrSvg: "",
          mdns: { ok: true, error: null },
          peers: [],
          manualAddresses: [],
        };
      }
      return null;
    });
    renderApp();
    expect(await screen.findByRole("heading", { name: /sudah dikeluarkan dari Kantor/ })).toBeInTheDocument();
  });
});
