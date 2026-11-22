import type { CssRect, PageGeometry, PdfRect, Size } from "./types";

// Konversi antara userspace PDF dan px CSS halaman yang tampil. Rumusnya sama
// dengan matriks PageViewport pdf.js (scale dikali userUnit, offset 0):
//   rotasi 0:   u = (x - x0)s, v = (y1 - y)s
//   rotasi 90:  u = (y - y0)s, v = (x - x0)s
//   rotasi 180: u = (x1 - x)s, v = (y - y0)s
//   rotasi 270: u = (y1 - y)s, v = (x1 - x)s
// Jadi hasilnya cocok dengan viewport.convertToViewportPoint dan convertToPdfPoint.

function unitScale(page: PageGeometry, scale: number): number {
  return scale * (page.userUnit ?? 1);
}

// Ukuran halaman yang tampil (sudah dirotasi) dalam px CSS.
export function displaySize(page: PageGeometry, scale: number): Size {
  const s = unitScale(page, scale);
  const turned = page.rotation === 90 || page.rotation === 270;
  return {
    width: (turned ? page.height : page.width) * s,
    height: (turned ? page.width : page.height) * s,
  };
}

export function pdfRectToCss(rect: PdfRect, page: PageGeometry, scale: number): CssRect {
  const s = unitScale(page, scale);
  const [x0, y0, x1, y1] = page.view;
  const { x, y, width: w, height: h } = rect;
  switch (page.rotation) {
    case 0:
      return { left: (x - x0) * s, top: (y1 - (y + h)) * s, width: w * s, height: h * s };
    case 90:
      return { left: (y - y0) * s, top: (x - x0) * s, width: h * s, height: w * s };
    case 180:
      return { left: (x1 - (x + w)) * s, top: (y - y0) * s, width: w * s, height: h * s };
    case 270:
      return { left: (y1 - (y + h)) * s, top: (x1 - (x + w)) * s, width: h * s, height: w * s };
  }
}

export function cssRectToPdf(css: CssRect, page: PageGeometry, scale: number): PdfRect {
  const s = unitScale(page, scale);
  const [x0, y0, x1, y1] = page.view;
  const left = css.left / s;
  const top = css.top / s;
  const cw = css.width / s;
  const ch = css.height / s;
  const pageIndex = page.index;
  switch (page.rotation) {
    case 0:
      return { pageIndex, x: x0 + left, y: y1 - top - ch, width: cw, height: ch };
    case 90:
      return { pageIndex, x: x0 + top, y: y0 + left, width: ch, height: cw };
    case 180:
      return { pageIndex, x: x1 - left - cw, y: y0 + top, width: cw, height: ch };
    case 270:
      return { pageIndex, x: x1 - top - ch, y: y1 - left - cw, width: ch, height: cw };
  }
}

// Jepit persegi supaya seluruhnya ada di dalam bounds: ukuran tidak melebihi
// bounds, lalu posisi digeser masuk.
export function clampCss(rect: CssRect, bounds: Size): CssRect {
  const width = Math.max(0, Math.min(rect.width, bounds.width));
  const height = Math.max(0, Math.min(rect.height, bounds.height));
  const left = Math.min(Math.max(rect.left, 0), bounds.width - width);
  const top = Math.min(Math.max(rect.top, 0), bounds.height - height);
  return { left, top, width, height };
}
