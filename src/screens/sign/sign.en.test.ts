// @vitest-environment node
// Label bersama tanda tangan dalam bahasa Inggris, dan teks PDF yang tetap
// Indonesia apa pun bahasa tampilannya.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PageGeometry } from "../../components/pdf/types";
import { setLang } from "../../i18n/core";
import {
  CANCEL_CONFIRM,
  ROW_MENU,
  checkPdfFile,
  formatSize,
  formatWhen,
  headerStatusLabel,
  rejectedText,
  requestStateLabel,
} from "./labels";
import { describeSpot, quickPlacement } from "./signFlow";
import { checkSignablePdf, formatSignedAt } from "./stamp";

const A4: PageGeometry = { index: 0, view: [0, 0, 595, 842], width: 595, height: 842, rotation: 0 };

describe("label tanda tangan dalam bahasa Inggris", () => {
  beforeEach(() => setLang("en"));
  afterEach(() => setLang("id"));

  it("status, menu baris, dan konfirmasi batal", () => {
    expect(requestStateLabel({ status: "in_progress", myState: "your_turn", integrity: "intact" })).toBe("Your turn");
    expect(headerStatusLabel({ status: "in_progress", signedCount: 1, signerCount: 2, sealValid: null })).toBe(
      "In progress, 1 of 2 signed",
    );
    expect(ROW_MENU.sign).toBe("Sign");
    expect(CANCEL_CONFIRM.title).toBe("Cancel this request?");
    expect(rejectedText({ signerName: "Rina", code: "not_your_turn" })).toBe(
      "Rina's version was rejected because it was made before Rina's turn.",
    );
    expect(checkPdfFile(new File([""], "a.pdf", { type: "application/pdf" }))).toBe("This file is empty.");
    expect(formatSize(1)).toBe("1 byte");
    expect(formatSize(1536 * 1024)).toBe("1.5 MB");
  });

  it("ikut berganti saat bahasa dikembalikan ke Indonesia", () => {
    expect(ROW_MENU.open).toBe("Open");
    setLang("id");
    expect(ROW_MENU.open).toBe("Buka");
  });

  it("waktu layar memakai bulan Inggris dan jam bertitik dua", () => {
    expect(formatWhen("2026-12-22T08:04:00Z")).toMatch(/^22 December 2026, \d{2}:04 \S+$/);
    expect(formatWhen("bukan-waktu")).toBe("bukan-waktu");
  });

  it("posisi kotak dan pesan error PDF", async () => {
    expect(describeSpot(quickPlacement(A4, 2, "right"), A4)).toBe("bottom right");
    expect(describeSpot(quickPlacement(A4, 2, "center"), A4)).toBe("bottom center");
    await expect(checkSignablePdf(new TextEncoder().encode("bukan pdf"))).rejects.toEqual({
      code: "pdf_invalid",
      message: "This file isn't a PDF or is damaged, so it can't be signed.",
    });
  });

  it("teks yang ditulis ke PDF tetap Indonesia", () => {
    expect(formatSignedAt("2026-12-22T08:04:00Z", "Asia/Jakarta")).toBe("22 Desember 2026, 15.04 WIB");
  });
});
