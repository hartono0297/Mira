import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "../../api";
import { ThemeProvider } from "../../theme/ThemeProvider";
import { Onboarding } from "./Onboarding";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

function baseState(overrides: Partial<AppState["identity"]> = {}): AppState {
  return {
    identity: {
      publicKey: "a".repeat(64),
      fingerprint: "A1B2 C3D4 E5F6 0718",
      displayName: null,
      createdAt: "2026-11-22T01:00:00Z",
      ...overrides,
    },
    organization: null,
    dataDir: "C:\\Users\\Contoh\\AppData\\Local\\id.mira.desktop",
  };
}

function setup(state: AppState) {
  const onIdentity = vi.fn();
  const onOrganization = vi.fn();
  render(
    <ThemeProvider>
      <Onboarding state={state} onIdentity={onIdentity} onOrganization={onOrganization} onReload={vi.fn()} />
    </ThemeProvider>,
  );
  return { onIdentity, onOrganization };
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => (cmd === "get_setting" ? null : undefined));
});

describe("Onboarding langkah nama", () => {
  it("menolak nama kosong tanpa memanggil inti Rust", async () => {
    const user = userEvent.setup();
    setup(baseState());

    await user.type(screen.getByLabelText("Nama tampilan"), "   ");
    await user.click(screen.getByRole("button", { name: "Simpan nama" }));

    expect(await screen.findByText("Isi nama tampilan dulu.")).toBeInTheDocument();
    expect(screen.getByLabelText("Nama tampilan")).toHaveAttribute("aria-invalid", "true");
    expect(invoke).not.toHaveBeenCalledWith("save_display_name", expect.anything());
  });

  it("menyimpan nama yang dipangkas", async () => {
    const user = userEvent.setup();
    const saved = { ...baseState().identity, displayName: "Rina" };
    invoke.mockImplementation(async (cmd: string) => (cmd === "save_display_name" ? saved : null));
    const { onIdentity } = setup(baseState());

    await user.type(screen.getByLabelText("Nama tampilan"), "  Rina  ");
    await user.click(screen.getByRole("button", { name: "Simpan nama" }));

    expect(invoke).toHaveBeenCalledWith("save_display_name", { name: "Rina" });
    expect(onIdentity).toHaveBeenCalledWith(saved);
  });

  it("menampilkan pesan error dari inti Rust", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "save_display_name") throw { code: "database", message: "Data tidak bisa disimpan." };
      return null;
    });
    setup(baseState());

    await user.type(screen.getByLabelText("Nama tampilan"), "Rina");
    await user.click(screen.getByRole("button", { name: "Simpan nama" }));

    expect(await screen.findByText("Data tidak bisa disimpan.")).toBeInTheDocument();
  });
});

describe("Onboarding langkah organisasi", () => {
  it("langsung ke langkah 2 kalau nama sudah tersimpan", () => {
    setup(baseState({ displayName: "Rina" }));
    expect(screen.getByRole("button", { name: /Buat organisasi baru/ })).toBeInTheDocument();
    expect(screen.queryByLabelText("Nama tampilan")).not.toBeInTheDocument();
  });

  it("gabung dengan kode menjelaskan fitur belum tersedia dan bisa kembali", async () => {
    const user = userEvent.setup();
    setup(baseState({ displayName: "Rina" }));

    await user.click(screen.getByRole("button", { name: /Gabung dengan kode/ }));
    expect(screen.getByText(/Tahap 1/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Kembali ke pilihan" }));
    expect(screen.getByRole("button", { name: /Buat organisasi baru/ })).toBeInTheDocument();
  });

  it("menolak nama organisasi satu huruf", async () => {
    const user = userEvent.setup();
    setup(baseState({ displayName: "Rina" }));

    await user.click(screen.getByRole("button", { name: /Buat organisasi baru/ }));
    await user.type(screen.getByLabelText("Nama organisasi"), "A");
    await user.click(screen.getByRole("button", { name: "Buat organisasi" }));

    expect(await screen.findByText("Nama organisasi minimal 2 karakter.")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("create_organization", expect.anything());
  });
});
