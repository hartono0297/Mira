// Onboarding dalam bahasa Inggris: pemilih bahasa di langkah pertama dan
// contoh layar lain yang dirender langsung dalam bahasa Inggris.
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "../../api";
import { setLang } from "../../i18n/core";
import { LANG_CACHE_KEY } from "../../i18n/preference";
import { appState, firewall, router } from "../../test/fixtures";
import { renderInLang } from "../../test/i18n";
import { ThemeProvider } from "../../theme/ThemeProvider";
import { device, office, outgoing, searchResult } from "./joinFixtures";
import { Onboarding } from "./Onboarding";
import { GRACE_MS } from "./SearchStep";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

function fresh(): AppState {
  const base = appState({ organization: null, membership: "none" });
  return { ...base, identity: { ...base.identity, displayName: "Penguji" } };
}

function draw(state: AppState = fresh()) {
  return () => (
    <ThemeProvider>
      <Onboarding state={state} onIdentity={vi.fn()} onOrganization={vi.fn()} onReload={vi.fn()} />
    </ThemeProvider>
  );
}

function commands(table: Parameters<typeof router>[0]) {
  invoke.mockImplementation(
    router({ get_firewall_status: firewall({ rule: "allowed" }), join_device: device, ...table }),
  );
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  setLang("id");
  try {
    window.localStorage.removeItem(LANG_CACHE_KEY);
  } catch {
    // Tidak ada localStorage: tidak ada yang perlu dibersihkan.
  }
});

describe("Onboarding: pilihan bahasa", () => {
  it("memilih English di langkah pertama mengganti judul langkah tanpa memuat ulang", async () => {
    commands({ join_outgoing: null });
    const u = userEvent.setup();
    renderInLang(draw(), "id");

    const heading = await screen.findByRole("heading", { name: "Siapa nama Anda?" });
    // Pemilih bahasa tidak mengambil fokus dari judul langkah.
    expect(heading).toHaveFocus();
    expect(screen.getByText("Langkah 1 dari 3")).toBeInTheDocument();

    const picker = screen.getByRole("group", { name: "Bahasa" });
    await u.click(within(picker).getByRole("radio", { name: "English" }));

    expect(screen.getByRole("heading", { name: "What's your name?" })).toBeInTheDocument();
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
    expect(screen.getByLabelText("Display name")).toHaveValue("Penguji");
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Language" })).toBeInTheDocument();
    expect(screen.queryByText("Siapa nama Anda?")).not.toBeInTheDocument();
    expect(screen.queryByText("Langkah 1 dari 3")).not.toBeInTheDocument();
    // Nama bahasa tetap ditulis dalam bahasanya sendiri.
    expect(screen.getByRole("radio", { name: "Bahasa Indonesia" })).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("set_setting", { key: "app.language", value: "en" });

    await u.click(screen.getByRole("radio", { name: "Bahasa Indonesia" }));
    expect(screen.getByRole("heading", { name: "Siapa nama Anda?" })).toBeInTheDocument();
  });

  it("kantor ditemukan, dalam bahasa Inggris", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    commands({ join_outgoing: null, join_search: searchResult({ offices: [office()], orgSeen: true }) });
    const u = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderInLang(draw(), "en");

    await u.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Looking for your office on the network..." })).toHaveFocus();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GRACE_MS + 500);
    });
    expect(await screen.findByRole("heading", { name: "Office found: Biro Contoh" })).toBeInTheDocument();
    expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();
    expect(screen.getByText("Organization fingerprint")).toBeInTheDocument();
    expect(screen.getByLabelText("Department")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Choose a department" })).toBeInTheDocument();
    expect(screen.getByLabelText("Note for the admin (optional)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send request" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Find it another way" })).toBeInTheDocument();
    expect(screen.queryByText(/Kantor ditemukan|Sidik organisasi|Departemen|Kirim permintaan/)).not.toBeInTheDocument();
  });

  it("menunggu persetujuan, dalam bahasa Inggris", async () => {
    commands({
      join_outgoing: outgoing({ note: "Staf desain" }),
      join_poll: { status: "pending", request: outgoing() },
    });
    renderInLang(draw(), "en");

    expect(await screen.findByRole("heading", { name: "Waiting for approval" })).toBeInTheDocument();
    expect(screen.getByText("Step 3 of 3")).toBeInTheDocument();
    expect(screen.getByText(/the Desain department admin/)).toBeInTheDocument();
    expect(screen.getByText("What the admin sees")).toBeInTheDocument();
    expect(screen.getByText("Match code")).toBeInTheDocument();
    expect(screen.getByText("If it's taking a while")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel request" })).toBeInTheDocument();
    expect(screen.queryByText(/Menunggu persetujuan|Kode cocok|Kalau lama|Batalkan permintaan/)).not.toBeInTheDocument();
  });

  it("permintaan ditolak tanpa nama penolak, dalam bahasa Inggris", async () => {
    commands({ join_outgoing: outgoing({ status: "rejected" }) });
    renderInLang(draw(), "en");

    expect(await screen.findByRole("heading", { name: "Request declined" })).toBeInTheDocument();
    expect(
      screen.getByText("The office admin declined your request to join Biro Contoh, Desain department."),
    ).toBeInTheDocument();
    expect(screen.getByText(/Ask the office admin directly for the reason/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send request again" })).toBeInTheDocument();
    expect(screen.queryByText(/ditolak|menolak/)).not.toBeInTheDocument();
  });
});
