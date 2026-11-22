import { describe, expect, it } from "vitest";
import {
  MAX_IMPORT_BYTES,
  estimateWhiteThreshold,
  findInkBounds,
  fitWithin,
  importSignatureImage,
  padBounds,
  whitenToTransparent,
} from "./image";

// Gambar RGBA w x h, semua piksel bernilai px.
function solid(w: number, h: number, px: [number, number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set(px, i);
  return data;
}

function setPx(data: Uint8ClampedArray, w: number, x: number, y: number, px: [number, number, number, number]) {
  data.set(px, (y * w + x) * 4);
}

describe("findInkBounds", () => {
  it("null untuk gambar transparan", () => {
    expect(findInkBounds(solid(4, 3, [0, 0, 0, 0]), 4, 3)).toBeNull();
  });

  it("kotak terkecil yang memuat semua piksel bertinta", () => {
    const d = solid(10, 8, [0, 0, 0, 0]);
    setPx(d, 10, 2, 3, [0, 0, 0, 255]);
    setPx(d, 10, 7, 5, [0, 0, 0, 200]);
    expect(findInkBounds(d, 10, 8)).toEqual({ x: 2, y: 3, width: 6, height: 3 });
  });

  it("mengabaikan piksel di bawah ambang alpha", () => {
    const d = solid(5, 5, [0, 0, 0, 0]);
    setPx(d, 5, 0, 0, [0, 0, 0, 10]);
    setPx(d, 5, 3, 3, [0, 0, 0, 255]);
    expect(findInkBounds(d, 5, 5)).toEqual({ x: 3, y: 3, width: 1, height: 1 });
    expect(findInkBounds(d, 5, 5, 5)).toEqual({ x: 0, y: 0, width: 4, height: 4 });
  });

  it("satu piksel di pojok kanan bawah", () => {
    const d = solid(3, 3, [0, 0, 0, 0]);
    setPx(d, 3, 2, 2, [0, 0, 0, 255]);
    expect(findInkBounds(d, 3, 3)).toEqual({ x: 2, y: 2, width: 1, height: 1 });
  });
});

describe("whitenToTransparent", () => {
  it("putih jadi transparan, tinta gelap tetap utuh", () => {
    const d = new Uint8ClampedArray([255, 255, 255, 255, 20, 20, 60, 255, 240, 238, 230, 255]);
    whitenToTransparent(d, 220);
    expect(d[3]).toBe(0);
    expect(Array.from(d.slice(4, 8))).toEqual([20, 20, 60, 255]);
    expect(d[11]).toBe(0);
  });

  it("piksel sedikit di bawah ambang jadi tembus sebagian", () => {
    const d = new Uint8ClampedArray([200, 200, 200, 255]);
    whitenToTransparent(d, 220);
    expect(d[3]).toBeGreaterThan(0);
    expect(d[3]).toBeLessThan(255);
  });

  it("tidak menaikkan alpha piksel yang sudah transparan", () => {
    const d = new Uint8ClampedArray([10, 10, 10, 0]);
    whitenToTransparent(d, 220);
    expect(d[3]).toBe(0);
  });
});

describe("estimateWhiteThreshold", () => {
  it("di bawah warna kertas abu-abu muda", () => {
    const d = solid(10, 10, [205, 205, 205, 255]);
    setPx(d, 10, 1, 1, [20, 20, 20, 255]);
    const t = estimateWhiteThreshold(d);
    expect(t).toBeLessThan(205);
    expect(t).toBeGreaterThan(120);
  });

  it("latar gelap memakai ambang tinggi supaya isi gambar tidak hilang", () => {
    expect(estimateWhiteThreshold(solid(4, 4, [30, 30, 30, 255]))).toBe(230);
  });

  it("gambar transparan seluruhnya memakai ambang bawaan", () => {
    expect(estimateWhiteThreshold(solid(4, 4, [255, 255, 255, 0]))).toBe(230);
  });
});

describe("fitWithin", () => {
  it("tidak memperbesar gambar kecil", () => {
    expect(fitWithin(300, 100, 1200, 600)).toEqual({ width: 300, height: 100 });
  });

  it("memperkecil dengan rasio tetap menurut sisi yang paling melewati batas", () => {
    expect(fitWithin(2400, 600, 1200, 600)).toEqual({ width: 1200, height: 300 });
    expect(fitWithin(800, 1200, 1200, 600)).toEqual({ width: 400, height: 600 });
    expect(fitWithin(4000, 3000, 2000, 2000)).toEqual({ width: 2000, height: 1500 });
  });

  it("ukuran tidak sah menjadi nol", () => {
    expect(fitWithin(0, 50, 100, 100)).toEqual({ width: 0, height: 0 });
  });

  it("garis yang sangat tipis tetap minimal 1 piksel", () => {
    expect(fitWithin(5000, 1, 1200, 600)).toEqual({ width: 1200, height: 1 });
  });
});

describe("padBounds", () => {
  it("menambah margin dan dijepit ke batas gambar", () => {
    expect(padBounds({ x: 2, y: 5, width: 10, height: 4 }, 4, 14, 20)).toEqual({ x: 0, y: 1, width: 14, height: 12 });
  });
});

describe("importSignatureImage", () => {
  it("menolak file selain PNG atau JPG", async () => {
    const file = new File(["%PDF-1.7"], "kontrak.pdf", { type: "application/pdf" });
    await expect(importSignatureImage(file)).rejects.toMatchObject({
      code: "image_invalid",
      message: expect.stringContaining("bukan gambar PNG atau JPG"),
    });
  });

  it("menolak gambar lebih dari 5 MB", async () => {
    const file = new File([new Uint8Array(MAX_IMPORT_BYTES + 1)], "foto.jpg", { type: "image/jpeg" });
    await expect(importSignatureImage(file)).rejects.toMatchObject({
      code: "image_invalid",
      message: expect.stringContaining("lebih dari 5 MB"),
    });
  });

  it("mengenali gambar dari ekstensi kalau jenis file kosong", async () => {
    const file = new File([new Uint8Array(MAX_IMPORT_BYTES + 1)], "TTD.PNG", { type: "" });
    // Lolos pemeriksaan jenis, lalu ditolak karena ukurannya.
    await expect(importSignatureImage(file)).rejects.toMatchObject({ message: expect.stringContaining("5 MB") });
  });
});
