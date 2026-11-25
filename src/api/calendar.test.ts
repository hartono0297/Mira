import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calendarApi } from "./calendar";
import { NO_TAURI_ERROR } from ".";
import { setLang } from "../i18n/core";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  tauri.invoke.mockReset();
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("calendarApi.tasks", () => {
  it("memanggil board_calendar dengan rentang dan mengembalikan hasilnya", async () => {
    const rows = [{ projectId: "p1", projectCode: "TES", projectName: "Tes", task: { id: "t1" } }];
    tauri.invoke.mockResolvedValue(rows);
    await expect(calendarApi.tasks("2026-11-01", "2026-11-30")).resolves.toBe(rows);
    expect(tauri.invoke).toHaveBeenCalledWith("board_calendar", { from: "2026-11-01", to: "2026-11-30" });
  });

  it("meneruskan null untuk rentang tanpa batas", async () => {
    tauri.invoke.mockResolvedValue([]);
    await calendarApi.tasks(null, "2026-11-23");
    expect(tauri.invoke).toHaveBeenCalledWith("board_calendar", { from: null, to: "2026-11-23" });
  });

  it("di luar Tauri menolak dengan NO_TAURI_ERROR tanpa memanggil invoke", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    await expect(calendarApi.tasks("2026-11-01", "2026-11-30")).rejects.toBe(NO_TAURI_ERROR);
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("membentuk error inti Rust jadi AppError", async () => {
    tauri.invoke.mockRejectedValue({ code: "invalid_input", message: "Rentang tanggal tidak sah." });
    await expect(calendarApi.tasks("2026-12-01", "2026-11-01")).rejects.toMatchObject({
      code: "invalid_input",
      message: "Rentang tanggal tidak sah.",
    });
  });

  it("error berupa teks jadi AppError kode unknown", async () => {
    tauri.invoke.mockRejectedValue("boom");
    await expect(calendarApi.tasks(null, null)).rejects.toMatchObject({ code: "unknown" });
  });

  it("pesan error diterjemahkan saat bahasa Inggris aktif", async () => {
    setLang("en");
    tauri.invoke.mockRejectedValue({ code: "invalid_input", message: "Rentang tanggal tidak sah." });
    const err = await calendarApi.tasks("2026-12-01", "2026-11-01").catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "invalid_input" });
    expect((err as { message: string }).message).not.toBe("Rentang tanggal tidak sah.");
  });
});
