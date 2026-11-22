import { describe, expect, it } from "vitest";
import { clockTime, errorHint, originText, statusLines, versionList } from "./text";
import { meRef, rekanC, summary, version } from "./testData";

describe("teks layar Dokumen", () => {
  it("menyebut nomor versi bentrok dengan urutan naik", () => {
    expect(versionList([version("x", 5), version("x", 4)])).toBe("versi 4 dan 5");
    expect(versionList([version("x", 5), version("x", 3), version("x", 4)])).toBe("versi 3, 4, dan 5");
  });

  it("jam sejak: hari ini, kemarin, lalu tanggal", () => {
    const now = new Date(2026, 10, 22, 14, 0);
    expect(clockTime(new Date(2026, 10, 22, 10, 15).toISOString(), now)).toBe("10.15");
    expect(clockTime(new Date(2026, 10, 21, 9, 5).toISOString(), now)).toBe("kemarin 09.05");
    expect(clockTime(new Date(2026, 10, 18, 9, 5).toISOString(), now)).toBe("18 November 2026 09.05");
  });

  it("asal versi", () => {
    expect(originText(version("x", 1), "word")).toBe("Ditambahkan");
    expect(originText(version("x", 2), "excel")).toBe("Disimpan dari Excel");
    expect(originText(version("x", 3, { origin: "restored", restoredFromNumber: 1 }), "word")).toBe(
      "Dipulihkan dari versi 1",
    );
    expect(originText(version("x", 4, { origin: "resolved" }), "word")).toBe("Bentrok diselesaikan");
  });

  it("bentrok dan tanda edit bisa tampil bersamaan, sesi lokal dulu", () => {
    const v4 = version("x", 4, { isHead: true });
    const v5 = version("x", 5, { isHead: true });
    const now = new Date();
    const lines = statusLines(
      summary("x", "x.docx", {
        conflict: true,
        conflictVersions: [v5, v4],
        editing: [
          { editor: meRef, since: now.toISOString(), local: true, lastSavedAt: null },
          { editor: rekanC, since: now.toISOString(), local: false, lastSavedAt: null },
        ],
      }),
      now,
    );
    expect(lines.map((l) => l.kind)).toEqual(["conflict", "mine", "rekan"]);
    expect(lines[0].text).toBe("Bentrok: versi 4 dan 5 tersimpan berdampingan");
  });

  it("tidak ada em dash di teks yang dibuat", () => {
    const now = new Date();
    const text = [
      ...statusLines(summary("x", "x.docx"), now).map((l) => l.text),
      errorHint({ code: "document_editing", message: "" }, "finish"),
      errorHint({ code: "open_failed", message: "" }, "open"),
    ].join(" ");
    expect(text).not.toContain(String.fromCharCode(0x2014));
  });
});
