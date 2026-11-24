import { describe, expect, it } from "vitest";
import { setLang } from "../../../i18n/core";
import { localizeError } from "../../../i18n/errors";
import { lockMinutesFromMessage } from "./pin";

// Pesan kunci PIN dari Rust dipetakan ke bahasa Inggris oleh localizeError;
// jumlah menitnya harus tetap terbaca untuk hitung mundur di PinDialog.
describe("menit kunci PIN dalam bahasa Inggris", () => {
  it("angka menit tetap terbaca setelah pesan dipetakan", () => {
    setLang("en");
    const err = localizeError({
      code: "pin_locked",
      message: "Terlalu banyak PIN salah. Coba lagi dalam sekitar 7 menit.",
    });
    expect(err.code).toBe("pin_locked");
    expect(err.message).not.toMatch(/menit/);
    expect(lockMinutesFromMessage(err.message)).toBe(7);
    expect(lockMinutesFromMessage("Try again in about 1 minute.")).toBe(1);
  });
});
