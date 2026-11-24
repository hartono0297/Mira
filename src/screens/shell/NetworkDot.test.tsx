import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NetState } from "../../api";
import { network, router } from "../../test/fixtures";
import { renderInLang } from "../../test/i18n";
import { NetworkProvider } from "./NetworkContext";
import { NetworkPanel } from "./NetworkPanel";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

function renderDot(onOpenOrg = vi.fn()) {
  render(
    <NetworkProvider onRemoved={vi.fn()}>
      <NetworkPanel onOpenOrg={onOpenOrg} compact />
    </NetworkProvider>,
  );
  return { onOpenOrg };
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
});

describe("status jaringan di sidebar ringkas", () => {
  it.each<[NetState, string, string]>([
    ["lan", "Tersambung lewat LAN kantor", "side-dot-ok"],
    ["vpn", "Tersambung lewat VPN", "side-dot-ok"],
    ["offline", "Tidak tersambung ke jaringan kantor", "side-dot-bad"],
    ["starting", "Mencari laptop rekan...", "side-dot-plain"],
  ])("state %s: satu ikon dengan nama status", async (state, text, tone) => {
    invoke.mockImplementation(router({ get_network_status: network({ state }) }));
    renderDot();
    const label = `${text.replace(/\.+$/, "")}. Buka Organisasi`;
    const dot = await screen.findByRole("button", { name: label });
    expect(dot).toHaveClass(tone);
    expect(dot).toHaveAttribute("data-tip", label);
    expect(within(screen.getByRole("status")).getByText(text)).toBeInTheDocument();
    // Daftar rekan tidak tampil di mode ringkas.
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("abu saat masih memeriksa", () => {
    invoke.mockImplementation(() => new Promise(() => {}));
    renderDot();
    expect(screen.getByRole("button", { name: "Memeriksa jaringan. Buka Organisasi" })).toHaveClass("side-dot-plain");
  });

  it("merah kalau status tidak terbaca", async () => {
    invoke.mockImplementation(async () => {
      throw { code: "network", message: "Jaringan belum siap." };
    });
    renderDot();
    const dot = await screen.findByRole("button", { name: "Status jaringan belum terbaca. Buka Organisasi" });
    expect(dot).toHaveClass("side-dot-bad");
  });

  it("klik membuka Organisasi", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(router({ get_network_status: network({ state: "lan" }) }));
    const { onOpenOrg } = renderDot();
    await user.click(await screen.findByRole("button", { name: /Tersambung lewat LAN kantor/ }));
    expect(onOpenOrg).toHaveBeenCalled();
  });

  it("berbahasa Inggris", async () => {
    invoke.mockImplementation(router({ get_network_status: network({ state: "lan" }) }));
    renderInLang(() => (
      <NetworkProvider onRemoved={vi.fn()}>
        <NetworkPanel onOpenOrg={vi.fn()} compact />
      </NetworkProvider>
    ));
    expect(await screen.findByRole("button", { name: /\. Open Organization$/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Office network" })).toBeInTheDocument();
  });
});
