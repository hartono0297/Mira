import { describe, expect, it } from "vitest";
import { errorKind, hasUpdate, initialUpdateState, isBusy, updateReducer, type UpdateState } from "./updateState";

const available: UpdateState = { status: "available", version: "0.3.1", notes: "- Perbaikan", date: null };
const downloading: UpdateState = { status: "downloading", version: "0.3.1", percent: null };
const ready: UpdateState = { status: "ready", version: "0.3.1" };
const installing: UpdateState = { status: "installing", version: "0.3.1" };
const err = (code: string) => ({ code, message: `pesan ${code}` });

describe("updateReducer", () => {
  it("idle -> checking -> upToDate", () => {
    const checking = updateReducer(initialUpdateState, { type: "checkStart" });
    expect(checking).toEqual({ status: "checking" });
    expect(updateReducer(checking, { type: "checkDone", result: { available: false, currentVersion: "0.3.0" } })).toEqual({
      status: "upToDate",
    });
  });

  it("checking -> available membawa versi, catatan, dan tanggal", () => {
    const next = updateReducer(
      { status: "checking" },
      { type: "checkDone", result: { available: true, currentVersion: "0.3.0", version: "0.3.1", notes: "x", date: "2026-12-01" } },
    );
    expect(next).toEqual({ status: "available", version: "0.3.1", notes: "x", date: "2026-12-01" });
  });

  it("hasil cek diabaikan kalau tidak sedang mengecek", () => {
    expect(updateReducer(ready, { type: "checkDone", result: { available: false, currentVersion: "0.3.0" } })).toBe(ready);
  });

  it("cek baru bisa dari upToDate, available, dan error, tapi tidak memotong unduhan atau pemasangan", () => {
    expect(updateReducer({ status: "upToDate" }, { type: "checkStart" })).toEqual({ status: "checking" });
    expect(updateReducer(available, { type: "checkStart" })).toEqual({ status: "checking" });
    expect(updateReducer(downloading, { type: "checkStart" })).toBe(downloading);
    expect(updateReducer(installing, { type: "checkStart" })).toBe(installing);
  });

  it("gagal diam kembali ke idle hanya dari checking", () => {
    expect(updateReducer({ status: "checking" }, { type: "silentFail" })).toEqual({ status: "idle" });
    expect(updateReducer(available, { type: "silentFail" })).toBe(available);
  });

  it("available -> downloading -> progres -> ready", () => {
    const d = updateReducer(available, { type: "downloadStart", version: "0.3.1" });
    expect(d).toEqual(downloading);
    const p = updateReducer(d, { type: "progress", downloaded: 42, total: 100 });
    expect(p).toEqual({ ...downloading, percent: 42 });
    expect(updateReducer(p, { type: "progress", downloaded: 42.5, total: 100 })).toBe(p);
    expect(updateReducer(p, { type: "progress", downloaded: 500, total: 100 })).toEqual({ ...downloading, percent: 100 });
    expect(updateReducer(p, { type: "downloadDone", version: "0.3.1" })).toEqual(ready);
  });

  it("ukuran total tidak diketahui membuat persen null", () => {
    expect(updateReducer(downloading, { type: "progress", downloaded: 10, total: null })).toBe(downloading);
    expect(updateReducer(downloading, { type: "progress", downloaded: 10, total: 0 })).toBe(downloading);
  });

  it("unduhan tidak bisa mulai dari upToDate, dan progres di luar unduhan diabaikan", () => {
    expect(updateReducer({ status: "upToDate" }, { type: "downloadStart", version: "1.0.0" })).toEqual({ status: "upToDate" });
    expect(updateReducer(ready, { type: "progress", downloaded: 1, total: 2 })).toBe(ready);
    expect(updateReducer(available, { type: "downloadDone", version: "0.3.1" })).toBe(available);
  });

  it("ready -> installing", () => {
    expect(updateReducer(ready, { type: "installStart" })).toEqual(installing);
    expect(updateReducer(available, { type: "installStart" })).toBe(available);
  });

  it("galat cek: offline, belum disiapkan, gagal", () => {
    const checking: UpdateState = { status: "checking" };
    expect(updateReducer(checking, { type: "failed", error: err("update_offline"), during: "check" })).toEqual({
      status: "error",
      kind: "offline",
      message: "pesan update_offline",
      retry: "check",
      version: null,
    });
    expect(updateReducer(checking, { type: "failed", error: err("update_not_configured"), during: "check" })).toMatchObject({
      kind: "notConfigured",
    });
    expect(updateReducer(checking, { type: "failed", error: err("update_failed"), during: "check" })).toMatchObject({
      kind: "failed",
    });
  });

  it("galat unduhan menyimpan versi supaya bisa diunduh lagi", () => {
    const e = updateReducer(downloading, { type: "failed", error: err("update_bad_signature"), during: "download" });
    expect(e).toEqual({ status: "error", kind: "failed", message: "pesan update_bad_signature", retry: "download", version: "0.3.1" });
    expect(updateReducer(e, { type: "downloadStart", version: "0.3.1" })).toEqual(downloading);
  });

  it("galat pasang bisa diulang, kecuali unduhan tertunda sudah hilang", () => {
    const e = updateReducer(installing, { type: "failed", error: err("update_failed"), during: "install" });
    expect(e).toMatchObject({ retry: "install", version: "0.3.1" });
    expect(updateReducer(e, { type: "installStart" })).toEqual(installing);
    const lost = updateReducer(installing, { type: "failed", error: err("update_no_pending"), during: "install" });
    expect(lost).toMatchObject({ retry: "check", kind: "failed" });
    expect(updateReducer(lost, { type: "installStart" })).toBe(lost);
    expect(updateReducer(lost, { type: "checkStart" })).toEqual({ status: "checking" });
  });

  it("hasUpdate dan isBusy", () => {
    expect([available, downloading, ready].every(hasUpdate)).toBe(true);
    expect([initialUpdateState, { status: "upToDate" } as UpdateState, installing].some(hasUpdate)).toBe(false);
    expect([{ status: "checking" } as UpdateState, downloading, installing].every(isBusy)).toBe(true);
    expect(isBusy(available)).toBe(false);
  });

  it("errorKind memetakan kode Rust", () => {
    expect(errorKind(err("update_offline"))).toBe("offline");
    expect(errorKind(err("update_not_configured"))).toBe("notConfigured");
    expect(errorKind(err("update_bad_signature"))).toBe("failed");
    expect(errorKind(err("unknown"))).toBe("failed");
  });
});
