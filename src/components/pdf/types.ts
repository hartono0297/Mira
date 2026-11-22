// Tipe bersama penampil PDF. Koordinat PDF selalu userspace absolut (sumbu y ke
// atas, termasuk offset view x0/y0), koordinat layar selalu px CSS relatif
// terhadap kiri atas halaman yang tampil.

export type PageRotation = 0 | 90 | 180 | 270;

export type PageGeometry = {
  // Indeks halaman, mulai 0.
  index: number;
  // Kotak view halaman dalam userspace: x0, y0, x1, y1 (CropBox pdf.js).
  view: [number, number, number, number];
  // Ukuran view tanpa rotasi, dalam poin userspace (x1 - x0, y1 - y0).
  width: number;
  height: number;
  rotation: PageRotation;
  // /UserUnit halaman (PDF 1.6). Hampir selalu 1; pdf.js mengalikan skala dengannya.
  userUnit?: number;
};

export type PageRenderInfo = PageGeometry & {
  // Skala zoom seperti `page.getViewport({ scale })`. Teruskan nilai ini ke
  // pdfRectToCss dan cssRectToPdf.
  scale: number;
  // Ukuran halaman yang tampil (sudah dirotasi), dalam px CSS.
  cssWidth: number;
  cssHeight: number;
};

// Persegi sejajar sumbu dalam userspace PDF absolut. (x, y) adalah sudut kiri
// bawah dalam sistem koordinat PDF. Untuk halaman berotasi, persegi ini menutupi
// kotak seperti terlihat di layar.
export type PdfRect = {
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

// Persegi dalam px CSS relatif terhadap kiri atas halaman yang tampil.
export type CssRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type Size = { width: number; height: number };
