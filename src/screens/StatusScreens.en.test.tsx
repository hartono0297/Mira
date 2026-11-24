// Layar nonaktif dan dikeluarkan dalam bahasa Inggris: tidak ada kata tampilan
// bahasa Indonesia yang tersisa, termasuk hasil Periksa lagi, error, dan dialog
// reset. Daftar kata sama dengan src/i18n/noIndonesian.test.tsx.
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MembershipCheck } from "../api";
import { setLang } from "../i18n/core";
import { appState } from "../test/fixtures";
import { renderInLang } from "../test/i18n";
import { ThemeProvider } from "../theme/ThemeProvider";
import { RemovedScreen } from "./RemovedScreen";
import { SuspendedScreen } from "./SuspendedScreen";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const WORDS = [
  "yang", "dan", "untuk", "dengan", "belum", "sudah", "tidak", "Anda", "ini", "itu", "dari", "pada",
  "akan", "bisa", "harus", "oleh", "atau", "kalau", "lagi", "baru", "semua", "Simpan", "Batal", "Hapus",
  "Tutup", "Buka", "Kirim", "Tambah", "Pilih", "Cari", "Pesan", "Tugas", "Pengaturan", "Organisasi",
  "Dokumen", "Hari ini", "Kemarin", "menit", "jam", "hari", "di", "ke", "tanpa", "saat", "sedang",
  "masih", "Proyek", "Anggota", "Tamu", "Tenggat", "Dikerjakan", "Selesai", "Ubah", "Keluar", "Lihat",
  // Kata khusus layar ini.
  "Periksa", "dinonaktifkan", "nonaktif", "dikeluarkan", "sidik", "jari", "Hubungi", "kantor",
];
const PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${WORDS.map((w) => w.replace(/ /g, "\\s+")).join("|")})(?![\\p{L}\\p{N}])`,
  "iu",
);
const ATTRS = ["aria-label", "title", "placeholder", "alt"];

// Nama kantor di data uji berbahasa Indonesia ("Kantor Uji"), jadi diganti dulu.
const state = { ...appState(), organization: { ...appState().organization!, name: "Test Office" } };

function indonesianLeft(): string[] {
  const found: string[] = [];
  const els = [document.body, ...document.body.querySelectorAll("*")];
  for (const el of els) {
    for (const node of el.childNodes) {
      const text = node.nodeType === Node.TEXT_NODE ? node.textContent?.trim() : "";
      if (text && PATTERN.test(text)) found.push(text);
    }
    for (const attr of ATTRS) {
      const v = el.getAttribute(attr);
      if (v && PATTERN.test(v)) found.push(`${attr}=${v}`);
    }
  }
  return found;
}

beforeEach(() => {
  invoke.mockReset();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  setLang("id");
});

describe("layar keanggotaan dalam bahasa Inggris", () => {
  it("nonaktif: layar, hasil Periksa lagi, dan petunjuk jaringan", async () => {
    const user = userEvent.setup();
    const check: MembershipCheck = {
      membership: "suspended",
      checkedAt: new Date(2026, 10, 24, 14, 20).toISOString(),
      peersReached: 0,
    };
    invoke.mockResolvedValue(check);
    renderInLang(() => (
      <ThemeProvider>
        <SuspendedScreen state={{ ...state, membership: "suspended" }} onRefresh={vi.fn()} />
      </ThemeProvider>
    ));
    expect(screen.getByRole("heading", { name: "Your account at Test Office is deactivated" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByText("Checked at 14:20: still deactivated.")).toBeInTheDocument();
    expect(screen.getByText(/No office laptop reached yet/)).toBeInTheDocument();
    expect(indonesianLeft()).toEqual([]);
  });

  it("nonaktif: error pemeriksaan", async () => {
    const user = userEvent.setup();
    invoke.mockRejectedValue({ code: "network", message: "Mira's network isn't running yet." });
    renderInLang(() => (
      <ThemeProvider>
        <SuspendedScreen state={{ ...state, membership: "suspended" }} onRefresh={vi.fn()} />
      </ThemeProvider>
    ));
    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByText(/^Couldn't check\./)).toBeInTheDocument();
    expect(indonesianLeft()).toEqual([]);
  });

  it("dikeluarkan: layar dan dialog reset, termasuk reset yang gagal", async () => {
    const user = userEvent.setup();
    let fail!: (err: unknown) => void;
    invoke.mockImplementation(() => new Promise((_, rej) => (fail = rej)));
    renderInLang(() => (
      <ThemeProvider>
        <RemovedScreen state={{ ...state, membership: "removed" }} onReset={vi.fn()} />
      </ThemeProvider>
    ));
    expect(indonesianLeft()).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Reset and start over" }));
    expect(screen.getByRole("dialog", { name: "Reset this laptop?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(indonesianLeft()).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Delete data and reset" }));
    expect(screen.getByRole("button", { name: "Resetting..." })).toBeDisabled();
    expect(indonesianLeft()).toEqual([]);

    await act(async () => fail({ code: "unknown", message: "Disk is full." }));
    expect(await screen.findByText(/^This laptop wasn't reset\./)).toBeInTheDocument();
    expect(indonesianLeft()).toEqual([]);
  });
});
