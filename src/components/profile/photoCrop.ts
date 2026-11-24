// Hitungan murni untuk pemotong foto profil (docs/plans/foto-profil.md 3.4).
//
// Semua posisi dalam piksel gambar SUMBER (PickedPhoto.width/height), bukan
// piksel pratinjau: Rust memotong dari file asli. Pratinjau hanya ditampilkan
// dengan ukuran relatif terhadap bingkai (persen), jadi resolusinya tidak
// memengaruhi hasil.
//
// zoom 1 berarti sisi potong = sisi terpendek gambar: gambar menutup bingkai
// penuh, tanpa celah. Zoom lebih besar memperkecil kotak potong.
import type { Crop } from "../../api/profile";

export type ImageSize = { width: number; height: number };

// cx, cy: titik tengah kotak potong dalam piksel sumber.
export type CropView = { cx: number; cy: number; zoom: number };

export const MAX_ZOOM = 4;
// Sisi potong paling kecil dalam piksel sumber. Lebih kecil dari ini foto
// 256x256 hanya berisi piksel yang diperbesar.
export const MIN_CROP_SIDE = 64;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function minSide(img: ImageSize): number {
  return Math.min(img.width, img.height);
}

export function maxZoom(img: ImageSize): number {
  return clamp(minSide(img) / MIN_CROP_SIDE, 1, MAX_ZOOM);
}

// Sisi kotak potong (pecahan) untuk zoom tertentu.
export function cropSize(img: ImageSize, zoom: number): number {
  return minSide(img) / clamp(zoom, 1, maxZoom(img));
}

// Jepit zoom ke batasnya, lalu titik tengah supaya kotak potong tetap di dalam gambar.
export function clampView(img: ImageSize, view: CropView): CropView {
  const zoom = clamp(view.zoom, 1, maxZoom(img));
  const half = cropSize(img, zoom) / 2;
  return {
    cx: clamp(view.cx, half, img.width - half),
    cy: clamp(view.cy, half, img.height - half),
    zoom,
  };
}

export function initialView(img: ImageSize): CropView {
  return { cx: img.width / 2, cy: img.height / 2, zoom: 1 };
}

// Geser FOTO sejauh pecahan sisi bingkai (fx 0.1 = sepersepuluh bingkai ke
// kanan). Foto bergerak ke kanan berarti kotak potong bergerak ke kiri, sama
// dengan menyeret foto dengan mouse.
export function panBy(img: ImageSize, view: CropView, fx: number, fy: number): CropView {
  const size = cropSize(img, view.zoom);
  return clampView(img, { ...view, cx: view.cx - fx * size, cy: view.cy - fy * size });
}

// Zoom dengan titik tengah tetap.
export function zoomTo(img: ImageSize, view: CropView, zoom: number): CropView {
  return clampView(img, { ...view, zoom });
}

// Kotak untuk profileSetPhoto: bilangan bulat, selalu di dalam gambar.
export function toCrop(img: ImageSize, view: CropView): Crop {
  const v = clampView(img, view);
  const size = clamp(Math.round(cropSize(img, v.zoom)), 1, minSide(img));
  return {
    x: clamp(Math.round(v.cx - size / 2), 0, img.width - size),
    y: clamp(Math.round(v.cy - size / 2), 0, img.height - size),
    size,
  };
}

// Posisi dan ukuran pratinjau dalam persen sisi bingkai persegi.
export function imageLayout(img: ImageSize, view: CropView): { left: number; top: number; width: number; height: number } {
  const v = clampView(img, view);
  const size = cropSize(img, v.zoom);
  return {
    left: (-(v.cx - size / 2) / size) * 100,
    top: (-(v.cy - size / 2) / size) * 100,
    width: (img.width / size) * 100,
    height: (img.height / size) * 100,
  };
}
