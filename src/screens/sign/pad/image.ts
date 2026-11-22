// Pengolahan gambar tanda tangan: buang latar putih, pangkas ke batas tinta,
// perkecil, dan ubah ke PNG. Fungsi murni di atas, yang butuh canvas di bawah.

import type { AppError } from "../../../api";

export type SignatureImage = { png: Uint8Array; width: number; height: number };
export type Bounds = { x: number; y: number; width: number; height: number };

// Batas hasil akhir. Inti Rust menolak PNG di atas 1 MB atau 2000 x 2000 piksel.
export const MAX_OUTPUT_WIDTH = 1200;
export const MAX_OUTPUT_HEIGHT = 600;
export const MAX_PNG_BYTES = 1024 * 1024;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
// Foto ponsel bisa 4000 piksel lebih; diperkecil dulu supaya memori tidak habis.
const MAX_WORK_SIDE = 2000;

const ACCEPTED_TYPES = ["image/png", "image/jpeg"];
const ACCEPTED_EXT = /\.(png|jpe?g)$/i;

function imageError(message: string): AppError {
  return { code: "image_invalid", message };
}

// Kotak terkecil yang memuat semua piksel dengan alpha di atas ambang.
// Data RGBA seperti ImageData.data. Null kalau tidak ada tinta sama sekali.
export function findInkBounds(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  alphaThreshold = 16,
): Bounds | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] > alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

// Lebar pita peralihan di bawah ambang: piksel di pita ini dibuat tembus
// sebagian supaya tepi tinta hasil foto tidak bergerigi.
const SOFT_BAND = 48;

// Piksel yang hampir putih (kecerahan >= threshold) dibuat transparan, piksel
// sedikit di bawahnya dibuat tembus sebagian. Mengubah data di tempat.
export function whitenToTransparent(data: Uint8ClampedArray, threshold: number): void {
  const soft = Math.max(1, Math.min(SOFT_BAND, threshold));
  for (let i = 0; i < data.length; i += 4) {
    const l = luma(data[i], data[i + 1], data[i + 2]);
    if (l >= threshold) {
      data[i + 3] = 0;
    } else if (l > threshold - soft) {
      data[i + 3] = Math.round(data[i + 3] * ((threshold - l) / soft));
    }
  }
}

// Ambang putih untuk foto atau hasil pindai: kertas memenuhi sebagian besar
// gambar, jadi median kecerahan piksel tidak transparan mewakili warna kertas.
// Kertas di bawah lampu kantor sering abu-abu muda, bukan putih bersih.
export function estimateWhiteThreshold(data: Uint8ClampedArray): number {
  const hist = new Uint32Array(256);
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    hist[Math.round(luma(data[i], data[i + 1], data[i + 2]))]++;
    count++;
  }
  if (count === 0) return 230;
  let seen = 0;
  let median = 255;
  for (let v = 0; v < 256; v++) {
    seen += hist[v];
    if (seen * 2 >= count) {
      median = v;
      break;
    }
  }
  // Latar gelap: bukan foto di kertas putih. Pakai ambang tinggi supaya isi gambar tidak hilang.
  if (median < 140) return 230;
  return Math.max(130, Math.min(230, median - 30));
}

// Ukuran terbesar yang muat di maxW x maxH dengan rasio tetap. Tidak pernah memperbesar.
export function fitWithin(w: number, h: number, maxW: number, maxH: number): { width: number; height: number } {
  if (w <= 0 || h <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, maxW / w, maxH / h);
  return {
    width: Math.max(1, Math.min(maxW, Math.round(w * scale))),
    height: Math.max(1, Math.min(maxH, Math.round(h * scale))),
  };
}

// Kotak tinta ditambah margin, dijepit ke batas gambar.
export function padBounds(b: Bounds, margin: number, width: number, height: number): Bounds {
  const x = Math.max(0, b.x - margin);
  const y = Math.max(0, b.y - margin);
  const right = Math.min(width, b.x + b.width + margin);
  const bottom = Math.min(height, b.y + b.height + margin);
  return { x, y, width: right - x, height: bottom - y };
}

// Bagian di bawah ini butuh canvas (tidak tersedia di jsdom).

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(imageError("Gambar tanda tangan gagal diubah ke PNG. Coba lagi."));
        return;
      }
      blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
    }, "image/png");
  });
}

// Pangkas canvas sumber ke batas tinta + margin, perkecil ke 1200 x 600, lalu
// simpan sebagai PNG berlatar transparan. Null kalau canvas kosong.
export async function trimToPng(source: HTMLCanvasElement, margin: number): Promise<SignatureImage | null> {
  const ctx = source.getContext("2d", { willReadFrequently: true });
  if (!ctx || source.width === 0 || source.height === 0) return null;
  const pixels = ctx.getImageData(0, 0, source.width, source.height);
  const ink = findInkBounds(pixels.data, source.width, source.height);
  if (!ink) return null;
  const crop = padBounds(ink, margin, source.width, source.height);

  let size = fitWithin(crop.width, crop.height, MAX_OUTPUT_WIDTH, MAX_OUTPUT_HEIGHT);
  for (let attempt = 0; attempt < 6; attempt++) {
    const out = makeCanvas(size.width, size.height);
    const octx = out.getContext("2d");
    if (!octx) return null;
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = "high";
    octx.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, size.width, size.height);
    const png = await canvasToPng(out);
    if (png.byteLength <= MAX_PNG_BYTES) return { png, width: size.width, height: size.height };
    size = fitWithin(size.width, size.height, Math.round(size.width * 0.75), Math.round(size.height * 0.75));
  }
  throw imageError("Gambar terlalu rumit untuk disimpan. Pakai foto dengan latar yang lebih bersih.");
}

function isAcceptedFile(file: File): boolean {
  if (file.type) return ACCEPTED_TYPES.includes(file.type);
  return ACCEPTED_EXT.test(file.name);
}

// Memeriksa jenis dan ukuran file sebelum dibuka. Melempar AppError.
export function checkImportFile(file: File): void {
  if (!isAcceptedFile(file)) {
    throw imageError("File ini bukan gambar PNG atau JPG. Pilih foto atau hasil pindai tanda tangan.");
  }
  if (file.size > MAX_IMPORT_BYTES) {
    throw imageError("Ukuran gambar lebih dari 5 MB. Perkecil gambarnya atau pilih file lain.");
  }
}

type Drawable = { source: CanvasImageSource; width: number; height: number; close: () => void };

async function decode(file: File): Promise<Drawable> {
  if (typeof createImageBitmap === "function") {
    const bmp = await createImageBitmap(file);
    return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Memuat PNG atau JPG, membuang latar putih, memangkas, dan memperkecil.
// Error berupa AppError dengan pesan bahasa Indonesia.
export async function importSignatureImage(file: File): Promise<SignatureImage> {
  checkImportFile(file);

  let img: Drawable;
  try {
    img = await decode(file);
  } catch {
    throw imageError("Gambar tidak bisa dibuka. Mungkin file rusak. Pilih file PNG atau JPG lain.");
  }

  try {
    if (img.width === 0 || img.height === 0) throw imageError("Gambar ini kosong. Pilih file lain.");
    const work = fitWithin(img.width, img.height, MAX_WORK_SIDE, MAX_WORK_SIDE);
    const canvas = makeCanvas(work.width, work.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw imageError("Gambar tidak bisa diproses di laptop ini.");
    ctx.drawImage(img.source, 0, 0, work.width, work.height);

    const pixels = ctx.getImageData(0, 0, work.width, work.height);
    whitenToTransparent(pixels.data, estimateWhiteThreshold(pixels.data));
    ctx.putImageData(pixels, 0, 0);

    const margin = Math.round(Math.max(work.width, work.height) * 0.02) + 4;
    const result = await trimToPng(canvas, margin);
    if (!result) {
      throw imageError("Tidak ada tinta yang terlihat di gambar ini. Pilih foto tanda tangan dengan tinta yang jelas.");
    }
    return result;
  } finally {
    img.close();
  }
}
