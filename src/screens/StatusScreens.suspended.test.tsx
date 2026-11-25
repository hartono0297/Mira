// Layar akun dinonaktifkan (0.6.0): Periksa lagi, hasil yang terlihat, pengumuman
// pembaca layar, dan cek otomatis yang tidak mengganggu fokus.
import { act, render as rtlRender, screen, within } from "@testing-library/react";
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

// Baris hasil yang terlihat. Teks yang sama juga ada di wilayah pengumuman sr-only.
const shown = () => within(screen.getByTestId("status-recheck-result"));

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
    expect(
      screen.getByText("Hubungi IT, admin departemen Anda, atau superadmin kantor. Mereka bisa mengaktifkan akun Anda lagi."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Data di laptop ini tidak dihapus. Begitu akun Anda aktif lagi, Mira terbuka sendiri dengan data yang sama."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Kalau IT menanyakannya, bacakan ini supaya mereka tahu laptop mana yang dimaksud."),
    ).toBeInTheDocument();
    expect(screen.getByText("Sidik jari laptop ini")).toBeInTheDocument();
    expect(screen.getByText("AAAA AAAA AAAA AAAA")).toHaveClass("mono");
    expect(screen.getByText(/setiap 20 detik/)).toBeInTheDocument();
  });

  it("Periksa lagi: tombol sibuk tanpa disabled, lalu hasil terlihat dan dibacakan", async () => {
    const user = userEvent.setup();
    const pending = deferred<MembershipCheck>();
    invoke.mockImplementation((cmd: string) => (cmd === "check_membership" ? pending.promise : Promise.resolve(null)));
    const onRefresh = vi.fn();
    render(<SuspendedScreen state={state} onRefresh={onRefresh} />);

    await user.click(screen.getByRole("button", { name: "Periksa lagi" }));
    const busy = screen.getByRole("button", { name: "Memeriksa..." });
    // aria-disabled, bukan disabled, supaya fokus tetap di tombol.
    expect(busy).toBeEnabled();
    expect(busy).toHaveFocus();
    expect(busy).toHaveAttribute("aria-disabled", "true");
    expect(busy).toHaveAttribute("aria-busy", "true");
    // Klik saat sibuk diabaikan.
    await user.click(busy);
    expect(checks()).toBe(1);

    await act(async () => pending.resolve(result()));
    const line = await shown().findByText("Diperiksa pukul 14.20: masih nonaktif.");
    // Baris hasil yang terlihat ada di luar wilayah pengumuman.
    expect(line.closest("[aria-live]")).toBeNull();
    const live = screen.getByTestId("status-recheck-live");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent("Diperiksa pukul 14.20: masih nonaktif.");
    expect(screen.queryByText(/Belum tersambung/)).not.toBeInTheDocument();
    const again = screen.getByRole("button", { name: "Periksa lagi" });
    expect(again).not.toHaveAttribute("aria-disabled");
    expect(again).toHaveFocus();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("memberi petunjuk jaringan kalau belum ada laptop kantor yang tersambung", async () => {
    const user = userEvent.setup();
    invoke.mockResolvedValue(result({ peersReached: 0 }));
    render(<SuspendedScreen state={state} onRefresh={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Periksa lagi" }));
    expect(await screen.findByText("Diperiksa pukul 14.20: masih nonaktif.")).toBeInTheDocument();
    expect(
      screen.getByText("Belum tersambung ke laptop kantor. Pastikan laptop ini ada di jaringan kantor."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("status-recheck-live")).toHaveTextContent(
      "Diperiksa pukul 14.20: masih nonaktif. Belum tersambung ke laptop kantor.",
    );
  });

  it("memuat ulang aplikasi begitu akun aktif lagi", async () => {
    const user = userEvent.setup();
    invoke.mockResolvedValue(result({ membership: "active" }));
    const onRefresh = vi.fn();
    render(<SuspendedScreen state={state} onRefresh={onRefresh} />);
    await user.click(screen.getByRole("button", { name: "Periksa lagi" }));
    expect(await shown().findByText(/aktif lagi\. Membuka Mira/)).toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("memuat ulang aplikasi kalau laptop ini ternyata dikeluarkan", async () => {
    const user = userEvent.setup();
    invoke.mockResolvedValue(result({ membership: "removed" }));
    const onRefresh = vi.fn();
    render(<SuspendedScreen state={state} onRefresh={onRefresh} />);
    await user.click(screen.getByRole("button", { name: "Periksa lagi" }));
    expect(await shown().findByText(/sudah dikeluarkan dari kantor/)).toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("menampilkan error di layar kalau pemeriksaan gagal", async () => {
    const user = userEvent.setup();
    invoke.mockRejectedValue({ code: "network", message: "Jaringan Mira belum berjalan." });
    render(<SuspendedScreen state={state} onRefresh={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Periksa lagi" }));
    expect(await shown().findByText("Belum bisa memeriksa. Jaringan Mira belum berjalan.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Periksa lagi" })).not.toHaveAttribute("aria-disabled");
    expect(screen.getByTestId("status-recheck-live")).toHaveTextContent("Belum bisa memeriksa. Jaringan Mira belum berjalan.");
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
    // Cek otomatis tidak mengganti label tombol.
    expect(screen.getByRole("button", { name: "Periksa lagi" })).not.toHaveAttribute("aria-disabled");

    // Selama pemeriksaan belum selesai, tidak ada pemeriksaan kedua.
    await act(() => vi.advanceTimersByTimeAsync(AUTO_CHECK_MS * 2));
    expect(checks()).toBe(1);

    await act(async () => pending.resolve(result()));
    expect(screen.getByText("Diperiksa pukul 14.20: masih nonaktif.")).toBeInTheDocument();
    // Hasil cek otomatis yang sama tidak dibacakan.
    expect(screen.getByTestId("status-recheck-live")).toHaveTextContent("");

    pending = deferred<MembershipCheck>();
    await act(() => vi.advanceTimersByTimeAsync(AUTO_CHECK_MS));
    expect(checks()).toBe(2);
    await act(async () => pending.resolve(result()));

    view.unmount();
    await act(() => vi.advanceTimersByTimeAsync(AUTO_CHECK_MS * 3));
    expect(checks()).toBe(2);
  });

  it("cek otomatis tidak memindahkan fokus dari tombol Periksa lagi", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = deferred<MembershipCheck>();
    invoke.mockImplementation((cmd: string) => (cmd === "check_membership" ? pending.promise : Promise.resolve(null)));
    render(<SuspendedScreen state={state} onRefresh={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Periksa lagi" });
    act(() => button.focus());
    expect(button).toHaveFocus();

    await act(() => vi.advanceTimersByTimeAsync(AUTO_CHECK_MS));
    expect(checks()).toBe(1);
    expect(button).toHaveFocus();
    expect(button).toHaveTextContent("Periksa lagi");
    expect(button).not.toHaveAttribute("aria-disabled");

    await act(async () => pending.resolve(result()));
    expect(screen.getByText("Diperiksa pukul 14.20: masih nonaktif.")).toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it("membacakan error cek otomatis sekali, tidak pada error yang sama berikutnya", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    invoke.mockRejectedValue({ code: "network", message: "Jaringan Mira belum berjalan." });
    render(<SuspendedScreen state={state} onRefresh={vi.fn()} />);
    const live = screen.getByTestId("status-recheck-live");

    await act(() => vi.advanceTimersByTimeAsync(AUTO_CHECK_MS));
    expect(checks()).toBe(1);
    expect(live).toHaveTextContent("Belum bisa memeriksa. Jaringan Mira belum berjalan.");

    // Error yang sama berikutnya tidak mengubah isi wilayah pengumuman.
    const node = live.firstChild;
    await act(() => vi.advanceTimersByTimeAsync(AUTO_CHECK_MS));
    expect(checks()).toBe(2);
    expect(live.firstChild).toBe(node);
    expect(live).toHaveTextContent("Belum bisa memeriksa. Jaringan Mira belum berjalan.");
  });

  it("membacakan perubahan keanggotaan dari cek otomatis", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    invoke.mockResolvedValue(result({ membership: "active" }));
    const onRefresh = vi.fn();
    render(<SuspendedScreen state={state} onRefresh={onRefresh} />);
    await act(() => vi.advanceTimersByTimeAsync(AUTO_CHECK_MS));
    expect(screen.getByTestId("status-recheck-live")).toHaveTextContent(/aktif lagi\. Membuka Mira/);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
