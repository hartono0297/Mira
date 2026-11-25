import { describe, expect, it } from "vitest";
import {
  clampView,
  cropSize,
  imageLayout,
  initialView,
  maxZoom,
  panBy,
  toCrop,
  zoomTo,
  type ImageSize,
} from "./photoCrop";

const landscape: ImageSize = { width: 2000, height: 1000 };
const portrait: ImageSize = { width: 900, height: 1600 };

function inBounds(img: ImageSize, crop: { x: number; y: number; size: number }) {
  expect(Number.isInteger(crop.x)).toBe(true);
  expect(Number.isInteger(crop.y)).toBe(true);
  expect(Number.isInteger(crop.size)).toBe(true);
  expect(crop.x).toBeGreaterThanOrEqual(0);
  expect(crop.y).toBeGreaterThanOrEqual(0);
  expect(crop.size).toBeGreaterThanOrEqual(1);
  expect(crop.x + crop.size).toBeLessThanOrEqual(img.width);
  expect(crop.y + crop.size).toBeLessThanOrEqual(img.height);
}

describe("zoom minimum", () => {
  it("gambar menutup seluruh bingkai pada zoom 1 (landscape dan portrait)", () => {
    for (const img of [landscape, portrait, { width: 500, height: 500 }]) {
      const layout = imageLayout(img, initialView(img));
      expect(layout.left).toBeLessThanOrEqual(0);
      expect(layout.top).toBeLessThanOrEqual(0);
      expect(layout.left + layout.width).toBeGreaterThanOrEqual(100);
      expect(layout.top + layout.height).toBeGreaterThanOrEqual(100);
    }
  });

  it("zoom di bawah 1 dijepit ke 1, sisi potong tidak melebihi sisi terpendek", () => {
    const view = zoomTo(landscape, initialView(landscape), 0.3);
    expect(view.zoom).toBe(1);
    expect(cropSize(landscape, view.zoom)).toBe(1000);
  });

  it("zoom maksimum 4x, atau sampai sisi potong 64 piksel sumber", () => {
    expect(maxZoom(landscape)).toBe(4);
    expect(maxZoom({ width: 200, height: 300 })).toBeCloseTo(200 / 64);
    expect(maxZoom({ width: 40, height: 40 })).toBe(1);
    expect(zoomTo(landscape, initialView(landscape), 10).zoom).toBe(4);
  });
});

describe("konversi ke piksel sumber", () => {
  it("landscape: awal di tengah, sisi = tinggi", () => {
    expect(toCrop(landscape, initialView(landscape))).toEqual({ x: 500, y: 0, size: 1000 });
  });

  it("portrait: awal di tengah, sisi = lebar", () => {
    expect(toCrop(portrait, initialView(portrait))).toEqual({ x: 0, y: 350, size: 900 });
  });

  it("zoom 2 memotong separuh sisi di sekitar titik tengah", () => {
    const view = zoomTo(landscape, initialView(landscape), 2);
    expect(toCrop(landscape, view)).toEqual({ x: 750, y: 250, size: 500 });
  });

  it("geser ke kanan memindahkan foto ke kanan, kotak potong ke kiri", () => {
    const view = panBy(landscape, initialView(landscape), 0.1, 0);
    expect(toCrop(landscape, view)).toEqual({ x: 400, y: 0, size: 1000 });
  });
});

describe("jepit di tepi", () => {
  it("geser jauh berhenti di tepi gambar", () => {
    const right = panBy(landscape, initialView(landscape), -50, -50);
    expect(toCrop(landscape, right)).toEqual({ x: 1000, y: 0, size: 1000 });
    const left = panBy(landscape, initialView(landscape), 50, 50);
    expect(toCrop(landscape, left)).toEqual({ x: 0, y: 0, size: 1000 });
  });

  it("perkecil setelah menggeser ke tepi tetap menjaga kotak di dalam gambar", () => {
    let view = zoomTo(portrait, initialView(portrait), 3);
    view = panBy(portrait, view, -50, -50);
    view = zoomTo(portrait, view, 1);
    expect(toCrop(portrait, view)).toEqual({ x: 0, y: 700, size: 900 });
  });

  it("clampView memperbaiki titik tengah di luar gambar", () => {
    const view = clampView(landscape, { cx: -500, cy: 99999, zoom: 1 });
    expect(view).toEqual({ cx: 500, cy: 500, zoom: 1 });
  });
});

describe("hasil selalu bilangan bulat di dalam gambar", () => {
  it("untuk berbagai ukuran, zoom, dan posisi", () => {
    const sizes: ImageSize[] = [landscape, portrait, { width: 17, height: 16 }, { width: 333, height: 777 }, { width: 8000, height: 5 + 16 }];
    let seed = 7;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (const img of sizes) {
      for (let i = 0; i < 200; i++) {
        let view = zoomTo(img, initialView(img), 1 + rand() * 5);
        view = panBy(img, view, (rand() - 0.5) * 3, (rand() - 0.5) * 3);
        inBounds(img, toCrop(img, view));
      }
    }
  });
});
