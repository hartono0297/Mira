// @vitest-environment node
import { PDFDocument, PDFName, PDFNumber, degrees } from "pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";
import { clampCss, cssRectToPdf, displaySize, normalizeRotation, pdfRectToCss } from "./coords";
import type { PageGeometry, PageRotation, PdfRect } from "./types";

const ROTATIONS: PageRotation[] = [0, 90, 180, 270];

function geom(rotation: PageRotation, view: [number, number, number, number] = [10, 20, 622, 812]): PageGeometry {
  return { index: 2, view, width: view[2] - view[0], height: view[3] - view[1], rotation };
}

const RECT: PdfRect = { pageIndex: 2, x: 110, y: 220, width: 150, height: 50 };

describe("pdfRectToCss: nilai pasti, view [10, 20, 622, 812], skala 2", () => {
  // W = 612, H = 792. Persegi x 110..260, y 220..270.
  it("rotasi 0", () => {
    expect(pdfRectToCss(RECT, geom(0), 2)).toEqual({ left: 200, top: 1084, width: 300, height: 100 });
  });
  it("rotasi 90", () => {
    expect(pdfRectToCss(RECT, geom(90), 2)).toEqual({ left: 400, top: 200, width: 100, height: 300 });
  });
  it("rotasi 180", () => {
    expect(pdfRectToCss(RECT, geom(180), 2)).toEqual({ left: 724, top: 400, width: 300, height: 100 });
  });
  it("rotasi 270", () => {
    expect(pdfRectToCss(RECT, geom(270), 2)).toEqual({ left: 1084, top: 724, width: 100, height: 300 });
  });
});

describe("cssRectToPdf", () => {
  it.each(ROTATIONS)("round-trip rotasi %i", (rotation) => {
    const page = geom(rotation);
    for (const scale of [0.5, 1, 1.37, 3]) {
      const back = cssRectToPdf(pdfRectToCss(RECT, page, scale), page, scale);
      expect(back.pageIndex).toBe(2);
      expect(back.x).toBeCloseTo(RECT.x, 9);
      expect(back.y).toBeCloseTo(RECT.y, 9);
      expect(back.width).toBeCloseTo(RECT.width, 9);
      expect(back.height).toBeCloseTo(RECT.height, 9);
    }
  });

  it("kiri atas layar pada rotasi 0 adalah (x0, y1) dikurangi tinggi kotak", () => {
    const r = cssRectToPdf({ left: 0, top: 0, width: 100, height: 40 }, geom(0), 1);
    expect(r).toEqual({ pageIndex: 2, x: 10, y: 772, width: 100, height: 40 });
  });

  it("userUnit ikut dihitung seperti pdf.js", () => {
    const page = { ...geom(0, [0, 0, 100, 100]), userUnit: 2 };
    expect(pdfRectToCss({ pageIndex: 2, x: 10, y: 10, width: 20, height: 20 }, page, 1)).toEqual({
      left: 20,
      top: 140,
      width: 40,
      height: 40,
    });
  });
});

describe("displaySize", () => {
  it("menukar lebar dan tinggi untuk rotasi 90 dan 270", () => {
    expect(displaySize(geom(0), 1)).toEqual({ width: 612, height: 792 });
    expect(displaySize(geom(90), 1)).toEqual({ width: 792, height: 612 });
    expect(displaySize(geom(270), 0.5)).toEqual({ width: 396, height: 306 });
  });
});

describe("normalizeRotation", () => {
  it("sama dengan pdf.js: bukan kelipatan 90 jadi 0, sisanya dinormalkan", () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(270)).toBe(270);
    expect(normalizeRotation(360)).toBe(0);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(45)).toBe(0);
    expect(normalizeRotation(135)).toBe(0);
    expect(normalizeRotation(Number.NaN)).toBe(0);
  });
});

describe("clampCss", () => {
  const bounds = { width: 300, height: 200 };
  it("menggeser masuk kotak yang keluar di kanan bawah", () => {
    expect(clampCss({ left: 280, top: 190, width: 50, height: 30 }, bounds)).toEqual({
      left: 250,
      top: 170,
      width: 50,
      height: 30,
    });
  });
  it("menggeser masuk kotak yang keluar di kiri atas", () => {
    expect(clampCss({ left: -20, top: -5, width: 50, height: 30 }, bounds)).toEqual({
      left: 0,
      top: 0,
      width: 50,
      height: 30,
    });
  });
  it("memperkecil kotak yang lebih besar dari bounds", () => {
    expect(clampCss({ left: 10, top: 10, width: 500, height: 400 }, bounds)).toEqual({
      left: 0,
      top: 0,
      width: 300,
      height: 200,
    });
  });
});

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

// Pembanding dengan pdf.js sungguhan: PDF buatan pdf-lib dengan CropBox
// bergeser, dirender lewat build legacy (untuk Node). Impor pertama pdf.js
// bisa makan waktu lebih dari 5 detik (batas bawaan per tes), jadi dimuat
// sekali di beforeAll dengan batas waktu sendiri.
describe("konsisten dengan PageViewport pdf.js", () => {
  let pdfjs: PdfJs;
  beforeAll(async () => {
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  }, 30_000);

  it("/Rotate 45 dianggap 0 oleh pdf.js, sama dengan normalizeRotation", async () => {
    const doc = await PDFDocument.create();
    const p = doc.addPage([600, 800]);
    p.node.set(PDFName.of("Rotate"), PDFNumber.of(45));
    const task = pdfjs.getDocument({ data: await doc.save(), verbosity: 0 });
    try {
      const page = await (await task.promise).getPage(1);
      expect(page.rotate).toBe(normalizeRotation(45));
    } finally {
      await task.destroy();
    }
  });

  it.each(ROTATIONS)("rotasi %i", async (rotation) => {
    const doc = await PDFDocument.create();
    const p = doc.addPage([700, 900]);
    p.setCropBox(10, 20, 612, 792);
    p.setRotation(degrees(rotation));
    const bytes = await doc.save();

    const task = pdfjs.getDocument({ data: bytes, verbosity: 0 });
    const pdf = await task.promise;
    try {
      const page = await pdf.getPage(1);
      const scale = 1.5;
      const vp = page.getViewport({ scale });
      const g: PageGeometry = {
        index: 0,
        view: page.view as [number, number, number, number],
        width: page.view[2] - page.view[0],
        height: page.view[3] - page.view[1],
        rotation: page.rotate as PageRotation,
        userUnit: page.userUnit,
      };
      expect(g.view).toEqual([10, 20, 622, 812]);
      expect(g.rotation).toBe(rotation);

      const size = displaySize(g, scale);
      expect(size.width).toBeCloseTo(vp.width, 6);
      expect(size.height).toBeCloseTo(vp.height, 6);

      const rect: PdfRect = { pageIndex: 0, x: 110, y: 220, width: 150, height: 50 };
      const css = pdfRectToCss(rect, g, scale);
      const [ax, ay] = vp.convertToViewportPoint(rect.x, rect.y);
      const [bx, by] = vp.convertToViewportPoint(rect.x + rect.width, rect.y + rect.height);
      expect(css.left).toBeCloseTo(Math.min(ax, bx), 6);
      expect(css.top).toBeCloseTo(Math.min(ay, by), 6);
      expect(css.width).toBeCloseTo(Math.abs(bx - ax), 6);
      expect(css.height).toBeCloseTo(Math.abs(by - ay), 6);

      // Kiri atas kotak di layar, dikonversi balik oleh pdf.js, harus jadi
      // salah satu sudut persegi PDF.
      const [px, py] = vp.convertToPdfPoint(css.left, css.top);
      const back = cssRectToPdf(css, g, scale);
      expect([back.x, back.x + back.width]).toContainEqual(expect.closeTo(px, 6));
      expect([back.y, back.y + back.height]).toContainEqual(expect.closeTo(py, 6));
    } finally {
      await task.destroy();
    }
  });
});
