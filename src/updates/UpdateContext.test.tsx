import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { AppState } from "../api";
import { appState } from "../test/fixtures";
import { rejectWith, updateBackend, type UpdateBackendOptions } from "../test/updateBackend";
import { ThemeProvider } from "../theme/ThemeProvider";
import { AUTO_CHECK_INTERVAL_MS, UpdateProvider, useUpdates } from "./UpdateContext";
import { UpdateDot } from "./UpdateDot";

const { invoke, FakeChannel } = vi.hoisted(() => {
  class FakeChannel<T> {
    onmessage: (message: T) => void = () => {};
  }
  return { invoke: vi.fn(), FakeChannel };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: FakeChannel }));

const NOW = Date.parse("2026-11-23T08:00:00Z");
const AVAILABLE = { available: true, currentVersion: "0.3.0", version: "0.3.1", notes: null, date: null };

function Probe() {
  const { state, currentVersion } = useUpdates();
  return (
    <p data-testid="probe">
      {currentVersion ?? "-"} {state.status}
    </p>
  );
}

function renderProvider(opts: UpdateBackendOptions) {
  const settings = updateBackend(invoke, { ...opts, settings: { "whats_new.seen": "0.3.0", ...(opts.settings ?? {}) } });
  render(
    <UpdateProvider now={() => NOW}>
      <Probe />
      <UpdateDot />
    </UpdateProvider>,
  );
  return settings;
}

const probe = () => screen.getByTestId("probe");
const checked = () => invoke.mock.calls.filter(([cmd]) => cmd === "update_check").length;

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
});

describe("Cek otomatis", () => {
  it("tidak berjalan kalau dimatikan", async () => {
    renderProvider({ settings: { "update.auto_check": "off" }, commands: { update_check: () => AVAILABLE } });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_setting", { key: "whats_new.seen" }));
    await act(async () => {});
    expect(checked()).toBe(0);
    expect(probe()).toHaveTextContent("0.3.0 idle");
  });

  it("tidak berjalan kalau cek terakhir belum 20 jam", async () => {
    const recent = new Date(NOW - AUTO_CHECK_INTERVAL_MS + 60_000).toISOString();
    renderProvider({ settings: { "update.last_check": recent }, commands: { update_check: () => AVAILABLE } });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_setting", { key: "update.last_check" }));
    await act(async () => {});
    expect(checked()).toBe(0);
  });

  it("berjalan kalau cek terakhir sudah lama, lalu mencatat waktunya dan menampilkan titik", async () => {
    const old = new Date(NOW - AUTO_CHECK_INTERVAL_MS - 1).toISOString();
    const settings = renderProvider({ settings: { "update.last_check": old }, commands: { update_check: () => AVAILABLE } });
    await waitFor(() => expect(probe()).toHaveTextContent("available"));
    expect(checked()).toBe(1);
    await waitFor(() => expect(settings["update.last_check"]).toBe(new Date(NOW).toISOString()));
    expect(document.querySelector(".update-dot")).not.toBeNull();
    expect(screen.getByText(", ada pembaruan")).toHaveClass("sr-only");
  });

  it("berjalan saat belum pernah mengecek, dan tidak menampilkan titik kalau sudah terbaru", async () => {
    renderProvider({ commands: { update_check: () => ({ available: false, currentVersion: "0.3.0" }) } });
    await waitFor(() => expect(probe()).toHaveTextContent("upToDate"));
    expect(document.querySelector(".update-dot")).toBeNull();
  });

  it("diam saat gagal: tetap idle, tanpa titik, dan waktu cek tidak dicatat", async () => {
    const settings = renderProvider({
      commands: { update_check: rejectWith("update_offline", "Tidak bisa menghubungi GitHub.") },
    });
    await waitFor(() => expect(checked()).toBe(1));
    await act(async () => {});
    expect(probe()).toHaveTextContent("0.3.0 idle");
    expect(document.querySelector(".update-dot")).toBeNull();
    expect(settings["update.last_check"]).toBeUndefined();
  });

  it("tidak berjalan kalau pembaruan belum disiapkan di versi ini", async () => {
    renderProvider({ configured: false, commands: { update_check: () => AVAILABLE } });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_setting", { key: "update.auto_check" }));
    await act(async () => {});
    expect(checked()).toBe(0);
  });

  it("di luar aplikasi desktop tidak melakukan apa pun", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    render(
      <UpdateProvider>
        <Probe />
        <UpdateDot />
      </UpdateProvider>,
    );
    await act(async () => {});
    expect(invoke).not.toHaveBeenCalled();
    expect(probe()).toHaveTextContent("- idle");
  });

  it("UpdateDot tanpa provider tidak menampilkan apa pun", () => {
    const { container } = render(<UpdateDot />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Titik di menu Pengaturan", () => {
  function renderApp(opts: UpdateBackendOptions, state: AppState = appState()) {
    const settings = updateBackend(invoke, {
      ...opts,
      settings: { "whats_new.seen": "0.3.0", ...(opts.settings ?? {}) },
      commands: { get_app_state: () => state, ...(opts.commands ?? {}) },
    });
    render(
      <ThemeProvider>
        <App />
      </ThemeProvider>,
    );
    return settings;
  }

  it("muncul di tombol Pengaturan hanya saat ada versi baru", async () => {
    renderApp({ commands: { update_check: () => AVAILABLE } });
    const settingsButton = await screen.findByRole("button", { name: "Pengaturan, ada pembaruan" });
    expect(settingsButton.querySelector(".update-dot")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Chat" }).querySelector(".update-dot")).toBeNull();
  });

  it("tidak muncul saat sudah terbaru", async () => {
    renderApp({ commands: { update_check: () => ({ available: false, currentVersion: "0.3.0" }) } });
    await waitFor(() => expect(checked()).toBe(1));
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Pengaturan" })).toBeInTheDocument();
    expect(document.querySelector(".update-dot")).toBeNull();
  });
});

describe("Yang baru", () => {
  function renderApp(settings: Record<string, string>, state: AppState = appState(), version = "0.3.0") {
    const store = updateBackend(invoke, {
      version,
      settings: { "update.auto_check": "off", ...settings },
      commands: { get_app_state: () => state },
    });
    render(
      <ThemeProvider>
        <App />
      </ThemeProvider>,
    );
    return store;
  }

  it("tampil sekali setelah naik dari v0.2.x, dan Tutup mencatat versinya", async () => {
    const user = userEvent.setup();
    const store = renderApp({});
    const dialog = await screen.findByRole("dialog", { name: "Yang baru di Mira 0.3.0" });
    expect(within(dialog).getByRole("heading", { level: 3, name: "Perbaikan" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Tutup" })).toHaveFocus();

    await user.click(within(dialog).getByRole("button", { name: "Tutup" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(store["whats_new.seen"]).toBe("0.3.0"));
  });

  it("Escape juga menutup dan mencatat", async () => {
    const user = userEvent.setup();
    const store = renderApp({ "whats_new.seen": "0.2.0" });
    await screen.findByRole("dialog", { name: "Yang baru di Mira 0.3.0" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(store["whats_new.seen"]).toBe("0.3.0"));
  });

  it("tidak tampil lagi setelah dilihat", async () => {
    renderApp({ "whats_new.seen": "0.3.0" });
    await screen.findByRole("navigation", { name: "Menu utama" });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_setting", { key: "whats_new.seen" }));
    await act(async () => {});
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("tidak tampil saat turun versi", async () => {
    const store = renderApp({ "whats_new.seen": "0.4.0" });
    await screen.findByRole("navigation", { name: "Menu utama" });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_setting", { key: "whats_new.seen" }));
    await act(async () => {});
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(store["whats_new.seen"]).toBe("0.4.0");
  });

  it("tidak tampil untuk versi tanpa catatan", async () => {
    renderApp({}, appState(), "0.3.5");
    await screen.findByRole("navigation", { name: "Menu utama" });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_setting", { key: "whats_new.seen" }));
    await act(async () => {});
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("instal baru: onboarding mencatat versi ini tanpa dialog", async () => {
    const store = renderApp({}, appState({ organization: null }));
    await waitFor(() => expect(store["whats_new.seen"]).toBe("0.3.0"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("onboarding tidak menimpa catatan yang sudah ada", async () => {
    const store = renderApp({ "whats_new.seen": "0.2.0" }, appState({ organization: null }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_setting", { key: "whats_new.seen" }));
    await act(async () => {});
    expect(store["whats_new.seen"]).toBe("0.2.0");
  });

  it("bisa dibuka lagi dari Pengaturan", async () => {
    const user = userEvent.setup();
    renderApp({ "whats_new.seen": "0.3.0" });
    await user.click(await screen.findByRole("button", { name: "Pengaturan" }));
    await user.click(screen.getByRole("button", { name: "Tentang dan pembaruan" }));
    await user.click(await screen.findByRole("button", { name: "Lihat yang baru" }));
    expect(await screen.findByRole("dialog", { name: "Yang baru di Mira 0.3.0" })).toBeInTheDocument();
  });
});
