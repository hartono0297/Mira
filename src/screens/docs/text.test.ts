import { describe, expect, it } from "vitest";
import {
  clockTime,
  errorHint,
  errorMessage,
  fetchState,
  fetchText,
  addedText,
  emptyTitle,
  goneNote,
  NOT_AVAILABLE_TEXT,
  originText,
  placeText,
  projectLabel,
  statusLines,
  versionList,
  visibilityHint,
} from "./text";
import { meRef, rekanC, summary, version } from "./testData";

describe("teks lokasi dokumen", () => {
  it("menyebut lokasi: Pustaka Umum atau proyek dengan kode dan nama", () => {
    expect(projectLabel({ code: "PA", name: "Gudang" })).toBe("PA Gudang");
    expect(placeText(null)).toBe("Pustaka Umum");
    expect(placeText("PA Gudang")).toBe("proyek PA Gudang");
    expect(addedText([{ name: "a.docx" }], null)).toBe("a.docx ditambahkan ke Pustaka Umum.");
    expect(addedText([{ name: "a.docx" }, { name: "b.xlsx" }], "PA Gudang")).toBe(
      "2 file ditambahkan ke proyek PA Gudang.",
    );
    expect(emptyTitle(null)).toBe("Pustaka Umum masih kosong");
    expect(emptyTitle("PA Gudang")).toBe("Belum ada file di proyek PA Gudang");
  });

  it("menjelaskan siapa yang melihat file, sesuai aturan inti", () => {
    expect(visibilityHint(null)).toBe("File di Pustaka Umum terlihat oleh semua anggota organisasi, kecuali Tamu.");
    expect(visibilityHint("PA Gudang")).toBe("File di proyek PA Gudang hanya terlihat oleh anggota proyek itu.");
  });

  it("catatan proyek yang tidak tersedia lagi", () => {
    expect(goneNote("PA Gudang")).toBe("Proyek PA Gudang tidak tersedia lagi untuk Anda. Menampilkan Pustaka Umum.");
  });
});

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

  it("isi versi yang belum ada: disalin, menunggu rekan, atau diunduh manual", () => {
    expect(fetchState(version("x", 1))).toBeNull();
    expect(fetchState(version("x", 1, { available: false, downloading: true, autoDownload: true }))).toBe("copying");
    expect(fetchState(version("x", 1, { available: false, autoDownload: true }))).toBe("waiting");
    expect(fetchState(version("x", 1, { available: false }))).toBe("manual");

    const now = new Date();
    const line = (extra: Parameters<typeof version>[2]) =>
      statusLines(summary("x", "x.docx", { current: version("x", 3, { isHead: true, author: rekanC, ...extra }) }), now);
    expect(line({ available: false, autoDownload: true }).map((l) => l.text)).toContain(
      "Versi 3 menunggu laptop rekan tersambung",
    );
    expect(line({ available: false, size: 21 * 1024 * 1024 })[1]).toEqual({
      kind: "fetch",
      text: "Versi 3 belum diunduh (21 MB)",
    });
    // Baris biasa tetap menyebut siapa yang mengubah.
    expect(line({ available: false, downloading: true })[0].text).toMatch(/^Versi 3 · Diubah Rekan C/);
    expect(errorMessage({ code: "not_available", message: "x" })).toBe(NOT_AVAILABLE_TEXT);
    expect(errorMessage({ code: "storage", message: "Disk penuh." })).toBe("Disk penuh.");
  });

  it("tidak ada em dash di teks yang dibuat", () => {
    const now = new Date();
    const text = [
      ...statusLines(summary("x", "x.docx"), now).map((l) => l.text),
      errorHint({ code: "document_editing", message: "" }, "finish"),
      errorHint({ code: "open_failed", message: "" }, "open"),
      errorHint({ code: "not_available", message: "" }, "download"),
      fetchText("copying"),
      fetchText("waiting"),
      fetchText("manual"),
      NOT_AVAILABLE_TEXT,
    ].join(" ");
    expect(text).not.toContain(String.fromCharCode(0x2014));
  });
});
