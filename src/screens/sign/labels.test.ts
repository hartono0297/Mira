import { describe, expect, it } from "vitest";
import {
  checkPdfFile,
  coolingText,
  eventLabel,
  exportNoticeText,
  exportStateLabel,
  exportWarningLabel,
  fileNeed,
  fileNeedText,
  fingerprint,
  formatSize,
  formatWhen,
  happenedDuringRequest,
  headerStatusLabel,
  integrityLabel,
  isActionable,
  isSignatureChange,
  kindLabel,
  modeLabel,
  myStateLabel,
  rejectReasonText,
  requestStateLabel,
  signErrorMessage,
  shortHash,
  statusLabel,
} from "./labels";

describe("label tanda tangan", () => {
  it("keadaan saya dan status", () => {
    expect(myStateLabel("your_turn")).toBe("Giliran Anda");
    expect(myStateLabel("waiting_others")).toBe("Menunggu orang lain");
    expect(myStateLabel("signed")).toBe("Sudah Anda tanda tangani");
    expect(statusLabel("in_progress")).toBe("Berjalan");
    expect(statusLabel("completed")).toBe("Selesai, terkunci");
    expect(statusLabel("cancelled")).toBe("Dibatalkan");
  });

  it("label baris: status akhir menang atas keadaan saya", () => {
    const ok = "intact" as const;
    expect(requestStateLabel({ status: "completed", myState: "signed", integrity: ok })).toBe("Selesai, terkunci");
    expect(requestStateLabel({ status: "cancelled", myState: "your_turn", integrity: ok })).toBe("Dibatalkan");
    expect(requestStateLabel({ status: "in_progress", myState: "your_turn", integrity: ok })).toBe("Giliran Anda");
    expect(requestStateLabel({ status: "in_progress", myState: "not_involved", integrity: ok })).toBe("Menunggu penanda tangan");
  });

  it("giliran saya atas file yang berubah atau hilang: tidak bisa ditandatangani dan tidak dihitung", () => {
    expect(requestStateLabel({ status: "in_progress", myState: "your_turn", integrity: "changed" })).toBe(
      "Tidak bisa ditandatangani",
    );
    expect(requestStateLabel({ status: "in_progress", myState: "your_turn", integrity: "missing" })).toBe(
      "Tidak bisa ditandatangani",
    );
    expect(isActionable({ status: "in_progress", myState: "your_turn", integrity: "intact" })).toBe(true);
    expect(isActionable({ status: "in_progress", myState: "your_turn", integrity: "changed" })).toBe(false);
    expect(isActionable({ status: "in_progress", myState: "waiting_others", integrity: "intact" })).toBe(false);
    expect(isActionable({ status: "completed", myState: "your_turn", integrity: "intact" })).toBe(false);
  });

  it("chip kepala layar dokumen", () => {
    expect(headerStatusLabel({ status: "in_progress", signedCount: 0, signerCount: 2, sealValid: null })).toBe(
      "Berjalan, 0 dari 2 sudah tanda tangan",
    );
    expect(headerStatusLabel({ status: "completed", signedCount: 2, signerCount: 2, sealValid: true })).toBe("Selesai, terkunci");
    expect(headerStatusLabel({ status: "completed", signedCount: 2, signerCount: 2, sealValid: false })).toBe(
      "Selesai, kunci tidak sah",
    );
    expect(headerStatusLabel({ status: "cancelled", signedCount: 1, signerCount: 2, sealValid: null })).toBe("Dibatalkan");
  });

  it("mode, jenis, catatan audit, integritas", () => {
    expect(modeLabel("sequential")).toBe("Berurutan");
    expect(modeLabel("parallel")).toBe("Bebas");
    expect(kindLabel("guest")).toBe("Tamu");
    expect(kindLabel("member")).toBe("Anggota");
    expect(eventLabel("created")).toBe("Permintaan dibuat");
    expect(eventLabel("signed")).toBe("Menandatangani");
    expect(eventLabel("signature_saved")).toBe("Membuat tanda tangan baru");
    expect(eventLabel("signature_deleted")).toBe("Menghapus tanda tangan");
    expect(eventLabel("jenis_baru")).toBe("Catatan lain (jenis_baru)");
    expect(isSignatureChange("signature_saved")).toBe(true);
    expect(isSignatureChange("signed")).toBe(false);
    expect(integrityLabel("changed")).toBe("Isi file tidak cocok dengan catatan Mira");
    expect(exportStateLabel("intact")).toBe("Utuh");
    expect(exportStateLabel("changed")).toBe("Berubah");
    expect(integrityLabel("missing")).toBe("File hilang dari penyimpanan Mira");
    expect(exportWarningLabel(1)).toBe("Salinan PDF yang disimpan di luar Mira berubah");
    expect(exportWarningLabel(2)).toBe("2 salinan PDF yang disimpan di luar Mira berubah");
    expect(exportNoticeText(1)).toBe("Satu salinan yang disimpan di luar Mira berubah. Rinciannya ada di bagian Salinan PDF.");
    expect(exportNoticeText(3)).toBe("3 salinan yang disimpan di luar Mira berubah. Rinciannya ada di bagian Salinan PDF.");
  });

  it("catatan tanda tangan dibuat ulang: di dalam atau di luar masa permintaan", () => {
    const created = "2026-11-20T02:00:00Z";
    const done = [{ kind: "completed", at: "2026-11-22T02:00:00Z" }];
    expect(happenedDuringRequest({ at: "2026-11-21T02:00:00Z" }, done, created)).toBe(true);
    expect(happenedDuringRequest({ at: "2026-11-19T02:00:00Z" }, done, created)).toBe(false);
    expect(happenedDuringRequest({ at: "2026-11-23T02:00:00Z" }, done, created)).toBe(false);
    expect(happenedDuringRequest({ at: "2026-11-23T02:00:00Z" }, [], created)).toBe(true);
    expect(happenedDuringRequest({ at: "rusak" }, done, created)).toBe(true);
  });

  it("masa tunggu tanda tangan baru", () => {
    const now = Date.parse("2026-11-22T00:00:00Z");
    expect(coolingText(null, now)).toBeNull();
    expect(coolingText("2026-11-21T00:00:00Z", now)).toBeNull();
    expect(coolingText("2026-11-23T00:00:00Z", now)).toMatch(
      /^Tanda tangan baru Anda bisa dipakai mulai .*23 November 2026.*, karena tanda tangan sebelumnya dihapus tanpa PIN\.$/,
    );
  });

  it("sidik jari sama dengan identity::fingerprint di Rust", () => {
    expect(fingerprint(`a1b2c3d4e5f60718${"0".repeat(48)}`)).toBe("A1B2 C3D4 E5F6 0718");
    expect(shortHash("0123456789abcdef0123")).toBe("0123456789abcdef");
    expect(shortHash("ab".repeat(32))).toHaveLength(16);
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

describe("label sinkron dari rekan", () => {
  const MB = 1024 * 1024;
  const base = { status: "in_progress" as const, fileAvailable: true, pending: false, fileSize: MB };

  it("file belum ada: disalin otomatis sampai 20 MB, lebih besar diunduh", () => {
    expect(fileNeed(base)).toBeNull();
    expect(fileNeed({ ...base, fileAvailable: false })).toEqual({ state: "copying", newer: false });
    expect(fileNeed({ ...base, fileAvailable: false, fileSize: 20 * MB })).toEqual({ state: "copying", newer: false });
    expect(fileNeed({ ...base, fileAvailable: false, fileSize: 20 * MB + 1 })).toEqual({ state: "manual", newer: false });
    expect(fileNeed({ ...base, pending: true })).toEqual({ state: "copying", newer: true });
    expect(fileNeedText({ state: "manual", newer: false }, 25 * MB)).toBe(
      "File 25 MB belum diunduh. File di atas 20 MB tidak disalin otomatis.",
    );
  });

  it("giliran saya tanpa file: Menunggu file, bukan Giliran Anda", () => {
    const r = { status: "in_progress" as const, myState: "your_turn" as const, integrity: "missing" as const, fileAvailable: false };
    expect(isActionable(r)).toBe(false);
    expect(requestStateLabel(r)).toBe("Menunggu file");
  });

  it("kode error baru dijelaskan dengan kata biasa, kode lain apa adanya", () => {
    expect(signErrorMessage({ code: "version_changes_content", message: "x" })).toMatch(/mengubah isi dokumen selain stempel/);
    expect(signErrorMessage({ code: "version_not_prefix", message: "x" })).toMatch(/isi versi sebelumnya tidak utuh/);
    expect(signErrorMessage({ code: "not_available", message: "x" })).toMatch(/^Belum ada laptop rekan yang tersambung/);
    expect(signErrorMessage({ code: "pin_wrong", message: "PIN salah." })).toBe("PIN salah.");
  });

  it("alasan penolakan: kode, potongan kalimat, atau kalimat utuh", () => {
    expect(rejectReasonText("version_changes_content")).toBe(
      "Versi ditolak karena mengubah isi dokumen selain stempel tanda tangan.",
    );
    expect(rejectReasonText("ditandatangani bersamaan")).toBe("Versi ditolak karena ditandatangani bersamaan.");
    expect(rejectReasonText("Versi lama tidak cocok.")).toBe("Versi lama tidak cocok.");
    expect(rejectReasonText("  ")).toBe("Versi ditolak Mira.");
  });

  it("tidak ada em dash di teks baru", () => {
    const text = [
      fileNeedText({ state: "copying", newer: false }, 1),
      fileNeedText({ state: "copying", newer: true }, 1),
      fileNeedText({ state: "manual", newer: true }, 1),
      signErrorMessage({ code: "version_not_prefix", message: "" }),
      signErrorMessage({ code: "version_changes_content", message: "" }),
      signErrorMessage({ code: "not_available", message: "" }),
      rejectReasonText("concurrent"),
    ].join(" ");
    expect(text).not.toContain(String.fromCharCode(0x2014));
  });
});