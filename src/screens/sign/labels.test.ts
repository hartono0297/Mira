import { describe, expect, it } from "vitest";
import {
  checkPdfFile,
  eventLabel,
  exportWarningLabel,
  fingerprint,
  formatSize,
  formatWhen,
  integrityLabel,
  kindLabel,
  modeLabel,
  myStateLabel,
  requestStateLabel,
  shortHash,
  statusLabel,
} from "./labels";

describe("label tanda tangan", () => {
  it("keadaan saya dan status", () => {
    expect(myStateLabel("your_turn")).toBe("Giliran Anda");
    expect(myStateLabel("waiting_others")).toBe("Menunggu orang lain");
    expect(myStateLabel("signed")).toBe("Sudah Anda tanda tangani");
    expect(statusLabel("completed")).toBe("Selesai, terkunci");
    expect(statusLabel("cancelled")).toBe("Dibatalkan");
  });

  it("label baris: status akhir menang atas keadaan saya", () => {
    expect(requestStateLabel({ status: "completed", myState: "signed" })).toBe("Selesai, terkunci");
    expect(requestStateLabel({ status: "cancelled", myState: "your_turn" })).toBe("Dibatalkan");
    expect(requestStateLabel({ status: "in_progress", myState: "your_turn" })).toBe("Giliran Anda");
    expect(requestStateLabel({ status: "in_progress", myState: "not_involved" })).toBe("Menunggu penanda tangan");
  });

  it("mode, jenis, catatan audit, integritas", () => {
    expect(modeLabel("sequential")).toBe("Berurutan");
    expect(modeLabel("parallel")).toBe("Bebas");
    expect(kindLabel("guest")).toBe("Tamu");
    expect(kindLabel("member")).toBe("Anggota");
    expect(eventLabel("created")).toBe("Permintaan dibuat");
    expect(eventLabel("signature_deleted")).toBe("Tanda tangan tersimpan dihapus");
    expect(eventLabel("jenis_baru")).toBe("jenis_baru");
    expect(integrityLabel("changed")).toBe("Isi file berubah sejak ditandatangani");
    expect(integrityLabel("missing")).toBe("File hilang dari penyimpanan Mira");
    expect(exportWarningLabel(1)).toBe("Salinan PDF yang disimpan di luar Mira berubah");
    expect(exportWarningLabel(2)).toBe("2 salinan PDF yang disimpan di luar Mira berubah");
  });

  it("sidik jari sama dengan identity::fingerprint di Rust", () => {
    expect(fingerprint(`a1b2c3d4e5f60718${"0".repeat(48)}`)).toBe("A1B2 C3D4 E5F6 0718");
    expect(shortHash("0123456789abcdef0123")).toBe("0123456789abcdef");
  });

  it("waktu, ukuran, dan pemeriksaan file", () => {
    expect(formatWhen("bukan-waktu")).toBe("bukan-waktu");
    expect(formatWhen("2026-11-22T08:04:00Z")).toMatch(/22 November 2026/);
    expect(formatSize(500)).toBe("500 byte");
    expect(formatSize(2048)).toBe("2 KB");
    expect(formatSize(1.5 * 1024 * 1024)).toBe("1,5 MB");
    expect(checkPdfFile(new File(["%PDF"], "a.pdf", { type: "application/pdf" }))).toBeNull();
    expect(checkPdfFile(new File(["x"], "catatan.txt", { type: "text/plain" }))).toMatch(/bukan PDF/);
    expect(checkPdfFile(new File([], "kosong.pdf"))).toMatch(/kosong/);
  });
});
