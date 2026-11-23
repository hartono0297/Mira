import { describe, expect, it } from "vitest";
import {
  checkPdfFile,
  coolingText,
  downloadLabel,
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
  rejectedText,
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
  const need = (over: Partial<Parameters<typeof fileNeed>[0]>) => fileNeed({ ...base, ...over });

  it("file belum ada: disalin otomatis sampai 20 MB, lebih besar diunduh", () => {
    expect(fileNeed(base)).toBeNull();
    expect(need({ fileAvailable: false })).toEqual({ state: "auto", newer: false, size: MB, downloading: false });
    expect(need({ fileAvailable: false, fileSize: 20 * MB })?.state).toBe("auto");
    expect(need({ fileAvailable: false, fileSize: 20 * MB + 1 })?.state).toBe("manual");
    // Ukuran unduhan dari inti menang atas ukuran file terkini.
    expect(need({ fileAvailable: false, fileSize: MB, downloadSize: 21 * MB })).toEqual({
      state: "manual",
      newer: false,
      size: 21 * MB,
      downloading: false,
    });
  });

  it("ukuran 0 atau null berarti tidak diketahui: unduh manual tanpa ukuran", () => {
    const unknown = need({ fileAvailable: false, fileSize: 0 });
    expect(unknown).toEqual({ state: "manual", newer: false, size: null, downloading: false });
    expect(need({ fileAvailable: false, fileSize: MB, downloadSize: null })?.size).toBeNull();
    expect(fileNeedText(unknown!)).toBe("File ini belum diunduh. Ukurannya belum diketahui, jadi tidak disalin otomatis.");
    expect(downloadLabel(unknown!)).toBe("Unduh file");
    expect(downloadLabel({ state: "manual", newer: false, size: 25 * MB, downloading: false })).toBe("Unduh file (25 MB)");
  });

  it("sedang disalin hanya kalau laptop ini memang sedang menyalin", () => {
    const waiting = need({ fileAvailable: false })!;
    expect(fileNeedText(waiting)).toBe("File disalin otomatis saat laptop rekan yang menyimpannya tersambung.");
    expect(fileNeedText(need({ fileAvailable: false, downloading: true })!)).toBe("File sedang disalin dari laptop rekan");
    expect(fileNeedText({ state: "manual", newer: false, size: 25 * MB, downloading: false })).toBe(
      "File 25 MB belum diunduh. File di atas 20 MB tidak disalin otomatis.",
    );
  });

  it("tanda tangan terbaru rekan belum sampai: ukurannya dari downloadSize", () => {
    expect(need({ pending: true })).toEqual({ state: "auto", newer: true, size: 0, downloading: false });
    expect(need({ pending: true, downloadSize: 2 * MB, downloading: true })).toEqual({
      state: "auto",
      newer: true,
      size: 2 * MB,
      downloading: true,
    });
    expect(need({ pending: true, downloadSize: 30 * MB })?.state).toBe("manual");
    expect(fileNeedText(need({ pending: true })!)).toBe(
      "Tanda tangan terbaru dari rekan disalin otomatis saat laptop rekan yang menyimpannya tersambung.",
    );
    expect(fileNeedText(need({ pending: true, downloading: true })!)).toBe(
      "Tanda tangan terbaru dari rekan sedang disalin ke laptop ini",
    );
  });

  it("giliran saya tanpa file: Menunggu file, bukan Giliran Anda", () => {
    const r = { status: "in_progress" as const, myState: "your_turn" as const, integrity: "missing" as const, fileAvailable: false };
    expect(isActionable(r)).toBe(false);
    expect(requestStateLabel(r)).toBe("Menunggu file");
  });

  it("giliran saya selagi tanda tangan rekan belum sampai: belum bisa ditandatangani", () => {
    const r = { status: "in_progress" as const, myState: "your_turn" as const, integrity: "intact" as const, pending: true };
    expect(isActionable(r)).toBe(false);
    expect(requestStateLabel(r)).toBe("Menunggu tanda tangan rekan");
    expect(isActionable({ ...r, pending: false })).toBe(true);
  });

  it("kode error baru dijelaskan dengan kata biasa, kode lain apa adanya", () => {
    expect(signErrorMessage({ code: "version_changes_content", message: "x" })).toMatch(/mengubah isi dokumen selain stempel/);
    expect(signErrorMessage({ code: "version_not_prefix", message: "x" })).toMatch(/isi versi sebelumnya tidak utuh/);
    expect(signErrorMessage({ code: "not_available", message: "x" })).toMatch(/^Belum ada laptop rekan yang tersambung/);
    expect(signErrorMessage({ code: "pin_wrong", message: "PIN salah." })).toBe("PIN salah.");
  });

  it("versi ditolak: kalimat dari kode, menyebut orangnya, tanpa teks inti", () => {
    const v = (code: string, otherName: string | null = null) => rejectedText({ signerName: "Budi", code, otherName });
    expect(v("version_changes_content")).toBe(
      "Versi dari Budi ditolak karena mengubah isi dokumen, bukan hanya menambah tanda tangan.",
    );
    expect(v("skipped_concurrent", "Citra")).toBe(
      "Versi dari Budi tidak dipakai karena Citra menandatangani versi yang sama lebih dulu. Budi perlu menandatangani versi terbaru.",
    );
    expect(v("already_signed")).toBe("Versi dari Budi tidak dipakai karena Budi sudah menandatangani versi lain dokumen ini.");
    expect(v("not_your_turn")).toBe("Versi dari Budi ditolak karena dibuat sebelum giliran Budi.");
    expect(v("on_rejected")).toMatch(/^Versi dari Budi ditolak karena ditandatangani di atas versi lain/);
    for (const code of ["version_not_prefix", "pdf_invalid", "tag_missing", "outdated_version", "not_allowed", "request_closed", "invalid_record"]) {
      expect(v(code)).toMatch(/^Versi dari Budi (ditolak|tidak dipakai) karena /);
      expect(v(code)).not.toMatch(/startxref|katalog|Anda/);
    }
    // Kode yang tidak dikenal (atau dari inti lama): kalimat netral.
    expect(v("other")).toBe("Versi dari Budi tidak dipakai Mira.");
    expect(v("toString")).toBe("Versi dari Budi tidak dipakai Mira.");
    expect(rejectedText({ signerName: " ", code: "", otherName: null })).toBe("Versi dari rekan tidak dipakai Mira.");
  });

  it("tidak ada em dash di teks baru", () => {
    const MBn = 1024 * 1024;
    const text = [
      fileNeedText({ state: "auto", newer: false, size: 1, downloading: false }),
      fileNeedText({ state: "auto", newer: true, size: 0, downloading: true }),
      fileNeedText({ state: "manual", newer: true, size: null, downloading: false }),
      fileNeedText({ state: "manual", newer: false, size: 30 * MBn, downloading: false }),
      signErrorMessage({ code: "version_not_prefix", message: "" }),
      signErrorMessage({ code: "version_changes_content", message: "" }),
      signErrorMessage({ code: "not_available", message: "" }),
      ...["version_not_prefix", "version_changes_content", "pdf_invalid", "tag_missing", "skipped_concurrent", "on_rejected", "outdated_version", "not_allowed", "not_your_turn", "already_signed", "request_closed", "invalid_record", "x"].map(
        (code) => rejectedText({ signerName: "Budi", code, otherName: null }),
      ),
    ].join(" ");
    expect(text).not.toContain(String.fromCharCode(0x2014));
  });
});
