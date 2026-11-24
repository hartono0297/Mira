import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getLang } from "./core";
import { LANG_CACHE_KEY, useLanguageChoice } from "./preference";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

type Pending = { value: string; resolve: () => void; reject: (e: unknown) => void };

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  window.localStorage.clear();
  invoke.mockReset();
});

describe("useLanguageChoice", () => {
  it("menyimpan berurutan dan kembali ke bahasa yang benar-benar tersimpan", async () => {
    const pending: Pending[] = [];
    invoke.mockImplementation(
      (cmd: string, args: { value: string }) =>
        new Promise<void>((resolve, reject) => {
          if (cmd === "set_setting") pending.push({ value: args.value, resolve, reject });
          else resolve();
        }),
    );
    const { result } = renderHook(() => useLanguageChoice());

    // Klik cepat: English lalu kembali ke Bahasa Indonesia.
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.choose("en");
    });
    act(() => {
      second = result.current.choose("id");
    });
    expect(getLang()).toBe("id");

    // Tulisan kedua menunggu tulisan pertama selesai.
    await waitFor(() => expect(pending).toHaveLength(1));
    expect(pending[0].value).toBe("en");
    await act(async () => {
      pending[0].resolve();
      await first;
    });
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[1].value).toBe("id");

    // Tulisan kedua gagal: inti Rust masih menyimpan "en", jadi layar ikut "en".
    await act(async () => {
      pending[1].reject({ code: "database", message: "Pengaturan tidak bisa disimpan." });
      await second;
    });
    expect(getLang()).toBe("en");
    expect(window.localStorage.getItem(LANG_CACHE_KEY)).toBe("en");
    expect(result.current.error?.kept).toBe("en");
    expect(result.current.saving).toBe(false);
  });
});
