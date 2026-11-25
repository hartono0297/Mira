import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, OrgInfo } from "../../api";
import { getLang, setLang } from "../../i18n/core";
import { appState } from "../../test/fixtures";
import { LangRoot } from "../../test/i18n";
import { ThemeProvider } from "../../theme/ThemeProvider";
import { SettingsScreen, type SettingsPart } from "./SettingsScreen";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

function Harness() {
  const [part, setPart] = useState<SettingsPart>("appearance");
  const state = appState() as AppState & { organization: OrgInfo };
  return <SettingsScreen state={state} part={part} onPart={setPart} />;
}

function renderSettings() {
  return render(
    <ThemeProvider>
      <LangRoot render={() => <Harness />} />
    </ThemeProvider>,
  );
}

function sectionNav() {
  return within(screen.getByRole("navigation", { name: /Bagian pengaturan|Settings sections/ }));
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  window.localStorage.clear();
  invoke.mockReset();
});

describe("Pengaturan > Bahasa", () => {
  it("bagian Bahasa ada tepat setelah Tampilan, di bawah Profil", () => {
    invoke.mockResolvedValue(null);
    renderSettings();
    const labels = sectionNav()
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(labels).toEqual(["Profil", "Tampilan", "Bahasa", "Jaringan", "Laptop ini", "Tentang dan pembaruan"]);
  });

  it("memilih English langsung mengganti teks dan menyimpan pilihan", async () => {
    const user = userEvent.setup();
    invoke.mockResolvedValue(null);
    renderSettings();

    await user.click(sectionNav().getByRole("button", { name: "Bahasa" }));
    expect(screen.getByRole("heading", { level: 2, name: "Bahasa" })).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "English" }));

    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Language" })).toBeInTheDocument();
    const labels = sectionNav()
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(labels).toEqual(["Profile", "Appearance", "Language", "Network", "This laptop", "About and updates"]);
    expect(screen.queryByText("Pengaturan")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "English" })).toBeChecked();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_setting", { key: "app.language", value: "en" }));
  });

  it("kembali ke bahasa Indonesia dengan pesan error kalau pilihan gagal disimpan", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "set_setting") throw { code: "database", message: "Pengaturan tidak bisa disimpan." };
      return null;
    });
    renderSettings();

    await user.click(sectionNav().getByRole("button", { name: "Bahasa" }));
    await user.click(screen.getByRole("radio", { name: "English" }));

    expect(await screen.findByText("Bahasa belum tersimpan")).toBeInTheDocument();
    expect(screen.getByText(/dikembalikan ke Bahasa Indonesia/)).toBeInTheDocument();
    expect(getLang()).toBe("id");
    expect(screen.getByRole("heading", { level: 1, name: "Pengaturan" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Bahasa Indonesia" })).toBeChecked();
  });

  it("bagian Tampilan dalam bahasa Inggris", async () => {
    invoke.mockResolvedValue(null);
    setLang("en");
    renderSettings();
    expect(screen.getByRole("heading", { level: 2, name: "Appearance" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Light" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Dark" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Match Windows" })).toBeInTheDocument();
    expect(screen.getByText("Color theme")).toBeInTheDocument();
    expect(screen.getByText("Brick")).toBeInTheDocument();
    expect(screen.getByText("In use")).toBeInTheDocument();
    expect(screen.getAllByText("Later")).toHaveLength(2);
    expect(screen.queryByText("Terang")).not.toBeInTheDocument();
    expect(screen.queryByText(/Tema warna|Dipakai|hangat dan lapang/)).not.toBeInTheDocument();
    await waitFor(() => expect(invoke).toHaveBeenCalled());
  });
});
