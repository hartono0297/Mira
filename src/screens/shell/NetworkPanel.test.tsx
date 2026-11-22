import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NetState } from "../../api";
import { network, peer, PK_B, PK_C, PK_D, router } from "../../test/fixtures";
import { NetworkPanel } from "./NetworkPanel";
import { NetworkProvider } from "./NetworkContext";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

// Tiruan listen: menyimpan handler supaya tes bisa memancarkan event dari "Rust".
const handlers = vi.hoisted(() => new Map<string, () => void>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, handler: () => void) => {
    handlers.set(event, handler);
    return () => handlers.delete(event);
  },
}));

function renderPanel(onOpenOrg = vi.fn(), onRemoved = vi.fn()) {
  render(
    <NetworkProvider onRemoved={onRemoved}>
      <NetworkPanel onOpenOrg={onOpenOrg} />
    </NetworkProvider>,
  );
  return { onOpenOrg, onRemoved };
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  handlers.clear();
});

describe("sidebar status jaringan", () => {
  it.each<[NetState, string]>([
    ["starting", "Mencari laptop rekan..."],
    ["alone", "Belum ada rekan di organisasi"],
    ["lan", "Tersambung lewat LAN kantor"],
    ["vpn", "Tersambung lewat VPN"],
    ["offline", "Tidak tersambung ke jaringan kantor"],
  ])("state %s menampilkan teks yang benar", async (state, text) => {
    invoke.mockImplementation(router({ get_network_status: network({ state }) }));
    renderPanel();
    expect(await screen.findByText(text)).toBeInTheDocument();
    if (state === "offline") {
      expect(screen.getByText("Kalau sedang di luar kantor, nyalakan VPN kantor.")).toBeInTheDocument();
    }
  });

  it("status ada di wilayah aria-live", async () => {
    invoke.mockImplementation(router({ get_network_status: network({ state: "lan" }) }));
    renderPanel();
    const status = await screen.findByRole("status");
    expect(within(status).getByText("Tersambung lewat LAN kantor")).toBeInTheDocument();
  });

  it("removed memberi tahu kerangka utama", async () => {
    invoke.mockImplementation(router({ get_network_status: network({ state: "removed" }) }));
    const { onRemoved } = renderPanel();
    expect(await screen.findByText("Laptop ini sudah dikeluarkan dari organisasi")).toBeInTheDocument();
    expect(onRemoved).toHaveBeenCalled();
  });

  it("error membaca status bisa dicoba lagi", async () => {
    const user = userEvent.setup();
    let fail = true;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd !== "get_network_status") return null;
      if (fail) throw { code: "network", message: "Jaringan belum siap." };
      return network({ state: "lan" });
    });
    renderPanel();
    expect(await screen.findByText("Status jaringan belum terbaca")).toBeInTheDocument();
    expect(screen.getByText("Jaringan belum siap.")).toBeInTheDocument();

    fail = false;
    await user.click(screen.getByRole("button", { name: "Coba baca lagi" }));
    expect(await screen.findByText("Tersambung lewat LAN kantor")).toBeInTheDocument();
  });
});

describe("daftar Di jaringan", () => {
  it("online dulu, lalu offline dengan waktu terakhir terlihat", async () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    invoke.mockImplementation(
      router({
        get_network_status: network({
          state: "vpn",
          peers: [
            peer(PK_B, "Zaki", { online: false, route: null, lastSeenAt: tenMinutesAgo }),
            peer(PK_C, "Budi", { online: true, route: "vpn" }),
            peer(PK_D, "Ani", { online: false, route: null, lastSeenAt: null }),
          ],
        }),
      }),
    );
    renderPanel();

    const list = await screen.findByRole("list", { name: "Di jaringan" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((li) => li.querySelector(".peer-name")?.firstChild?.textContent)).toEqual(["Budi", "Ani", "Zaki"]);
    expect(within(items[0]).getByText("lewat VPN")).toBeInTheDocument();
    expect(within(items[0]).getByText(", online")).toBeInTheDocument();
    expect(within(items[1]).getByText("Belum pernah terlihat")).toBeInTheDocument();
    expect(within(items[2]).getByText("Terakhir terlihat 10 menit lalu")).toBeInTheDocument();
  });

  it("kosong: mengarahkan ke menu Organisasi", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(router({ get_network_status: network({ state: "alone", peers: [] }) }));
    const { onOpenOrg } = renderPanel();
    expect(await screen.findByText(/Belum ada rekan di organisasi. Undang lewat menu/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Organisasi" }));
    expect(onOpenOrg).toHaveBeenCalled();
  });

  it("memuat ulang saat event mira://network datang", async () => {
    let online = false;
    invoke.mockImplementation(
      router({
        get_network_status: () =>
          network({ state: online ? "lan" : "offline", peers: [peer(PK_B, "Budi", { online, route: online ? "lan" : null })] }),
      }),
    );
    renderPanel();
    expect(await screen.findByText("Tidak tersambung ke jaringan kantor")).toBeInTheDocument();
    await vi.waitFor(() => expect(handlers.has("mira://network")).toBe(true));

    online = true;
    await act(async () => handlers.get("mira://network")?.());
    expect(await screen.findByText("Tersambung lewat LAN kantor")).toBeInTheDocument();
    expect(screen.getByText(", online")).toBeInTheDocument();
  });

  it("polling tiap 5 detik sebagai cadangan kalau event terlewat", async () => {
    vi.useFakeTimers();
    try {
      invoke.mockImplementation(router({ get_network_status: network({ state: "lan" }) }));
      renderPanel();
      await act(async () => {});
      const before = invoke.mock.calls.filter(([c]) => c === "get_network_status").length;
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      const after = invoke.mock.calls.filter(([c]) => c === "get_network_status").length;
      expect(after).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});
