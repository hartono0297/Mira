// Layar akun dinonaktifkan (0.5.1): Periksa lagi, hasil yang terlihat, cek otomatis.
import { act, render as rtlRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, MembershipCheck, OrgInfo } from "../api";
import { appState } from "../test/fixtures";
import { ThemeProvider } from "../theme/ThemeProvider";
import { AUTO_CHECK_MS, SuspendedScreen } from "./SuspendedScreen";

const invoke = vi.hoisted(() => vi.fn());
const render = (ui: ReactElement) => rtlRender(<ThemeProvider>{ui}</ThemeProvider>);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const state = appState({ membership: "suspended" }) as AppState & { organization: OrgInfo };
// Waktu lokal, supaya tampilannya 14.20 di zona waktu mana pun.
const CHECKED_AT = new Date(2026, 10, 24, 14, 20).toISOString();

function result(over: Partial<MembershipCheck> = {}): MembershipCheck {
  return { membership: "suspended", checkedAt: CHECKED_AT, peersReached: 2, ...over };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function checks() {
  return invoke.mock.calls.filter(([cmd]) => cmd === "check_membership").length;
}

beforeEach(() => {
  invoke.mockReset();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SuspendedScreen", () => {
  it("menampilkan judul, langkah berikutnya, dan sidik jari laptop ini", () => {
    render(<SuspendedScreen state={state} onRefresh={vi.fn()} />);
    const heading = screen.getByRole("heading", { name: "Akun Anda di Kantor Uji sedang dinonaktifkan" });
    expect(heading).toHaveFocus();
    expect(screen.getByText("Hubungi IT atau superadmin kantor. Mereka bisa mengaktifkan Anda lagi.")).toBeInTheDocument();
    expect(screen.getByText(/tidak ada yang dihapus/)).toBeInTheDocument();
    expect(screen.getByText("Sidik jari laptop ini")).toBeInTheDocument();
    expect(screen.getByText("AAAA AAAA AAAA AAAA")).toHaveClass("mono");
    expect(screen.getByText(/setiap 20 detik/)).toBeInTheDocument();
  });

  it("Periksa lagi: tombol sibuk selama memeriksa, lalu hasil terlihat dengan jamnya", async () => {
    const user = userEvent.setup();
    const pending = deferred<MembershipCheck>();
    invoke.mockImplementation((cmd: string) => (cmd === "check_membership" ? pending.promise : Promise.resolve(null)));
    const onRefresh = vi.fn();
    render(<SuspendedScreen state={state} onRefresh={onRefresh} />);

    await user.click(screen.getByRole("button", { name: "Periksa lagi" }));
    const busy = screen.getByRole("button", { name: "Memeriksa..." });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");

    await act(async () => pending.resolve(result()));
    const line = await screen.findByText("Dicek 14.20: masih nonaktif.");
    expect(line.closest("[aria-live]")).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByText(/Belum tersambung/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Periksa lagi" })).toBeEnabled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("memberi petunjuk jaringan kalau belum ada laptop kantor yang tersambung", async () => {
    const user = userEvent.setup();
    invoke.mockResolvedValue(result({ peersReached: 0 }));
    render(<SuspendedScreen state={state} onRefresh={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Periksa lagi" }));
    expect(await screen.findByText("Dicek 14.20: masih nonaktif.")).toBeInTheDocument();
    expect(
      screen.getByText("Belum tersambung ke laptop kantor. Pastikan laptop ini ada di jaringan kantor."),
    ).toBeInTheDocument();
  });

  it("memuat ulang aplikasi begitu akun aktif lagi", async () => {
    const user = userEvent.setup();
    invoke.mockResolvedValue(result({ membership: "active" }));
    const onRefresh = vi.fn();
    render(<SuspendedScreen state={state} onRefresh={onRefresh} />);
    await user.click(screen.getByRole("button", { name: "Periksa lagi" }));
    expect(await screen.findByText(/aktif lagi\. Membuka Mira/)).toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("memuat ulang aplikasi kalau laptop ini ternyata dikeluarkan", async () => {
    const user = userEvent.setup();
    invoke.mockResolvedValue(result({ membership: "removed" }));
    const onRefresh = vi.fn();
    render(<SuspendedScreen state={state} onRefresh={onRefresh} />);
    await user.click(screen.getByRole("button", { name: "Periksa lagi" }));
    expect(await screen.findByText(/sudah dikeluarkan dari kantor/)).toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("menampilkan error di layar kalau pemeriksaan gagal", async () => {
    const user = userEvent.setup();
    invoke.mockRejectedValue({ code: "network", message: "Jaringan Mira belum berjalan." });
    render(<SuspendedScreen state={state} onRefresh={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Periksa lagi" }));
    expect(await screen.findByText("Belum bisa memeriksa. Jaringan Mira belum berjalan.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Periksa lagi" })).toBeEnabled();
  });

  it("memeriksa sendiri tiap 20 detik, menunggu pemeriksaan yang berjalan, dan berhenti saat ditutup", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let pending = deferred<MembershipCheck>();
    invoke.mockImplementation((cmd: string) => (cmd === "check_membership" ? pending.promise : Promise.resolve(null)));
    const view = render(<SuspendedScreen state={state} onRefresh={vi.fn()} />);

    await act(() => vi.advanceTimersByTimeAsync(AUTO_CHECK_MS - 100));
    expect(checks()).toBe(0);
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(checks()).toBe(1);
    expect(screen.getByRole("button", { name: "Memeriksa..." })).toBeDisabled();

    // Selama pemeriksaan belum selesai, tidak ada pemeriksaan kedua.
    await act(() => vi.advanceTimersByTimeAsync(AUTO_CHECK_MS * 2));
    expect(checks()).toBe(1);

    await act(async () => pending.resolve(result()));
    expect(screen.getByText("Dicek 14.20: masih nonaktif.")).toBeInTheDocument();

    pending = deferred<MembershipCheck>();
    await act(() => vi.advanceTimersByTimeAsync(AUTO_CHECK_MS));
    expect(checks()).toBe(2);
    await act(async () => pending.resolve(result()));

    view.unmount();
    await act(() => vi.advanceTimersByTimeAsync(AUTO_CHECK_MS * 3));
    expect(checks()).toBe(2);
  });
});
