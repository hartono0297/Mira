// App memilih layar status sesuai keanggotaan (0.5.1): nonaktif, dikeluarkan,
// aktif lagi tanpa restart, dan reset kembali ke onboarding.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { AppState, MembershipCheck } from "../api";
import { ThemeProvider } from "../theme/ThemeProvider";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const ready: AppState = {
  identity: {
    publicKey: "b".repeat(64),
    fingerprint: "A1B2 C3D4 E5F6 0718",
    displayName: "Rina",
    createdAt: "2026-11-22T01:00:00Z",
  },
  organization: { id: "c".repeat(32), name: "Kantor Contoh", role: "member", createdAt: "2026-11-22T01:05:00Z" },
  membership: "active",
  dataDir: "C:\\data\\mira",
};

function network(state: string) {
  return {
    state,
    listenPort: null,
    localAddresses: [],
    shareLink: "",
    qrSvg: "",
    mdns: { ok: true, error: null },
    peers: [],
    manualAddresses: [],
  };
}

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

describe("App dan layar status keanggotaan", () => {
  it("akun nonaktif melihat layar nonaktif, lalu kembali ke kerangka utama begitu aktif lagi", async () => {
    const user = userEvent.setup();
    let state: AppState = { ...ready, membership: "suspended" };
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_app_state") return state;
      if (cmd === "check_membership") {
        state = ready;
        return { membership: "active", checkedAt: new Date().toISOString(), peersReached: 1 } satisfies MembershipCheck;
      }
      return null;
    });
    renderApp();

    expect(
      await screen.findByRole("heading", { name: "Akun Anda di Kantor Contoh sedang dinonaktifkan" }),
    ).toBeInTheDocument();
    expect(screen.getByText("A1B2 C3D4 E5F6 0718")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Menu utama" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Periksa lagi" }));
    expect(await screen.findByRole("navigation", { name: "Menu utama" })).toBeInTheDocument();
    // Tanpa layar memuat: get_app_state dipanggil sekali saat buka, sekali saat aktif lagi.
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "get_app_state")).toHaveLength(2);
  });

  it("status jaringan suspended memuat ulang data lalu menampilkan layar nonaktif", async () => {
    let state: AppState = ready;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_app_state") return state;
      if (cmd === "get_network_status") {
        state = { ...ready, membership: "suspended" };
        return network("suspended");
      }
      return null;
    });
    renderApp();
    expect(await screen.findByRole("heading", { name: /sedang dinonaktifkan/ })).toBeInTheDocument();
  });

  it("laptop dikeluarkan melihat layar dikeluarkan, lalu reset membawanya ke onboarding", async () => {
    const user = userEvent.setup();
    const fresh: AppState = {
      identity: { publicKey: "f".repeat(64), fingerprint: "FFFF 0000 FFFF 0000", displayName: null, createdAt: "2026-11-24T08:00:00Z" },
      organization: null,
      membership: "none",
      dataDir: "C:\\data\\mira",
    };
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_app_state") return { ...ready, membership: "removed" };
      if (cmd === "reset_removed_laptop") return fresh;
      return null;
    });
    renderApp();

    expect(
      await screen.findByRole("heading", { name: "Laptop ini sudah dikeluarkan dari organisasi Kantor Contoh" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Periksa lagi" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reset dan mulai dari awal" }));
    await user.click(screen.getByRole("button", { name: "Hapus data dan reset" }));

    expect(await screen.findByRole("heading", { name: "Siapa nama Anda?" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /sudah dikeluarkan/ })).not.toBeInTheDocument();
    // Reset tidak memuat ulang lewat get_app_state: AppState hasil reset langsung dipakai.
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "get_app_state")).toHaveLength(1);
  });
});
