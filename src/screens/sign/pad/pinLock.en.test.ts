// isLockMessage mencocokkan teks pesan, termasuk pesan Inggris dari peta error
// Rust. Tes ini menjaga supaya perubahan kalimat Inggris tidak diam-diam
// mematahkan deteksi "PIN salah sekaligus dikunci".
import { describe, expect, it } from "vitest";
import { setLang } from "../../../i18n/core";
import { localizeError } from "../../../i18n/errors";
import { isLockMessage } from "./PinDialog";

function english(code: string, message: string): string {
  setLang("en");
  return localizeError({ code, message }).message;
}

describe("isLockMessage dalam bahasa Inggris", () => {
  it("PIN salah yang memicu kunci dikenali sebagai kunci", () => {
    const text = english("pin_wrong", "PIN salah. Tanda tangan dikunci sementara, coba lagi dalam sekitar 1 menit.");
    expect(isLockMessage(text)).toBe(true);
  });

  it("sisa percobaan sebelum dikunci bukan kunci", () => {
    expect(isLockMessage(english("pin_wrong", "PIN salah. Sisa 2 kali lagi sebelum dikunci sementara."))).toBe(false);
    expect(isLockMessage(english("pin_wrong", "PIN salah. Sisa 1 kali lagi sebelum dikunci sementara."))).toBe(false);
  });
});
