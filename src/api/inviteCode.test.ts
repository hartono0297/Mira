import { describe, expect, it } from "vitest";
import { checkInviteCode, cleanInviteInput, formatInviteCode } from "./inviteCode";
import { relativeTime } from "./format";

describe("kode undangan", () => {
  it("menerima huruf kecil, spasi, dan tanda strip", () => {
    expect(checkInviteCode("abcd efgh-jkmn pqrs-tvwx")).toEqual({ ok: true, code: "ABCD-EFGH-JKMN-PQRS-TVWX" });
  });

  it("membaca I dan L sebagai 1, O sebagai 0", () => {
    expect(cleanInviteInput("iIlLoO")).toBe("111100");
    expect(checkInviteCode("OOOO-IIII-LLLL-0000-1111")).toEqual({ ok: true, code: "0000-1111-1111-0000-1111" });
  });

  it("menolak huruf U karena tidak ada di alfabet Crockford", () => {
    const result = checkInviteCode("ABCD-EFGH-JKMN-PQRS-TVWU");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('"U"');
  });

  it("menolak simbol lain", () => {
    expect(checkInviteCode("ABCD-EFGH-JKMN-PQRS-TVW#").ok).toBe(false);
  });

  it("menyebut jumlah karakter kalau terlalu pendek atau panjang", () => {
    const short = checkInviteCode("ABCD-EFGH");
    expect(!short.ok && short.error).toContain("Yang terisi 8");
    const long = checkInviteCode("ABCD-EFGH-JKMN-PQRS-TVWX-Y");
    expect(!long.ok && long.error).toContain("Yang terisi 21");
  });

  it("kosong minta diisi", () => {
    expect(checkInviteCode("  - ")).toEqual({ ok: false, error: "Isi kode undangan dulu." });
  });

  it("memformat per empat karakter", () => {
    expect(formatInviteCode("ABCDEFGHJK")).toBe("ABCD-EFGH-JK");
    expect(formatInviteCode("")).toBe("");
  });
});

describe("waktu relatif", () => {
  const now = new Date("2026-11-22T12:00:00Z");
  it("menulis waktu dalam bahasa Indonesia", () => {
    expect(relativeTime("2026-11-22T11:59:30Z", now)).toBe("baru saja");
    expect(relativeTime("2026-11-22T11:55:00Z", now)).toBe("5 menit lalu");
    expect(relativeTime("2026-11-22T09:00:00Z", now)).toBe("3 jam lalu");
    expect(relativeTime("2026-11-21T10:00:00Z", now)).toBe("kemarin");
    expect(relativeTime("2026-11-18T12:00:00Z", now)).toBe("4 hari lalu");
    expect(relativeTime("bukan-tanggal", now)).toBe("bukan-tanggal");
  });
});
