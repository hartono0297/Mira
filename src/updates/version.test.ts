import { describe, expect, it } from "vitest";
import { compareVersions, shouldShowWhatsNew } from "./version";

describe("compareVersions", () => {
  it("membandingkan angka, bukan teks", () => {
    expect(compareVersions("0.2.0", "0.3.0")).toBe(-1);
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("v0.3.0", "0.3.0")).toBe(0);
  });

  it("prarilis lebih lama dari rilis biasa", () => {
    expect(compareVersions("0.3.0-beta.1", "0.3.0")).toBe(-1);
    expect(compareVersions("0.3.0-beta.2", "0.3.0-beta.10")).toBe(-1);
    expect(compareVersions("0.3.0-alpha", "0.3.0-beta")).toBe(-1);
    expect(compareVersions("0.3.0-1", "0.3.0-alpha")).toBe(-1);
    expect(compareVersions("0.3.0+build.5", "0.3.0")).toBe(0);
  });

  it("isi yang bukan versi menghasilkan null", () => {
    expect(compareVersions("", "0.3.0")).toBeNull();
    expect(compareVersions("0.3", "0.3.0")).toBeNull();
    expect(compareVersions("baru", "0.3.0")).toBeNull();
  });
});

describe("shouldShowWhatsNew", () => {
  it("tampil saat naik versi atau belum ada catatan sudah dilihat", () => {
    expect(shouldShowWhatsNew("0.2.0", "0.3.0", true)).toBe(true);
    expect(shouldShowWhatsNew(null, "0.3.0", true)).toBe(true);
    expect(shouldShowWhatsNew("  ", "0.3.0", true)).toBe(true);
  });

  it("tidak tampil untuk versi yang sama, turun versi, atau tanpa catatan", () => {
    expect(shouldShowWhatsNew("0.3.0", "0.3.0", true)).toBe(false);
    expect(shouldShowWhatsNew("0.4.0", "0.3.0", true)).toBe(false);
    expect(shouldShowWhatsNew("0.2.0", "0.3.0", false)).toBe(false);
  });
});
