// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  StandardFonts,
  concatTransformationMatrix,
  decodePDFRawStream,
  degrees,
} from "pdf-lib";
import {
  appendAuditPage,
  captionFontSize,
  checkSignablePdf,
  formatSignedAt,
  normalizeAngle,
  stampSignature,
  toWinAnsiSafe,
  type AuditInfo,
  type PdfRect,
} from "./stamp";

// PNG 2x1 piksel RGBA: kiri merah, kanan transparan. Rasio 2:1.
const PNG_2X1 = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DwnwEIGGAMAEHvBP2qjq7jAAAAAElFTkSuQmCC",
  ),
  (c) => c.charCodeAt(0),
);

const DOC_TAG = "mira-doc:0123456789abcdef0123456789abcdef";
const SIGNED_AT = "2026-11-22T08:04:00Z"; // 15.04 WIB

type Mat = [number, number, number, number, number, number];
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** m1 lalu m2 (konvensi PDF: titik baris x m1 x m2). */
function mul(m1: Mat, m2: Mat): Mat {
  const [a, b, c, d, e, f] = m1;
  const [A, B, C, D, E, F] = m2;
  return [a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F];
}

function apply(m: Mat, x: number, y: number) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

type Draw = { name: string; ctm: Mat };
type TextDraw = { origin: { x: number; y: number }; matrix: Mat };

function pageContentBytes(doc: PDFDocument, pageIndex: number): string {
  const page = doc.getPage(pageIndex);
  const contents = page.node.get(PDFName.of("Contents"));
  const refs: PDFRef[] = [];
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) refs.push(contents.get(i) as PDFRef);
  } else if (contents instanceof PDFRef) {
    refs.push(contents);
  }
  return refs
    .map((ref) => {
      const stream = doc.context.lookup(ref) as PDFStream;
      const bytes =
        stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents();
      return new TextDecoder("latin1").decode(bytes);
    })
    .join("\n");
}

/** Pengurai operator konten sederhana: cukup untuk keluaran pdf-lib. */
function interpret(content: string) {
  const tokens = content.match(/<[0-9A-Fa-f\s]*>|\/[^\s/[\]<>()]+|[-+]?(?:\d+\.?\d*|\.\d+)|[A-Za-z'"*]+|\[|\]/g) ?? [];
  const stack: Mat[] = [];
  let ctm: Mat = IDENTITY;
  let operands: string[] = [];
  const draws: Draw[] = [];
  const texts: TextDraw[] = [];
  let tm: Mat = IDENTITY;
  for (const t of tokens) {
    if (/^[A-Za-z'"*]+$/.test(t)) {
      const nums = operands.map(Number);
      switch (t) {
        case "q":
          stack.push(ctm);
          break;
        case "Q":
          ctm = stack.pop() ?? IDENTITY;
          break;
        case "cm":
          ctm = mul(nums.slice(-6) as Mat, ctm);
          break;
        case "Do":
          draws.push({ name: operands[operands.length - 1], ctm });
          break;
        case "BT":
          tm = IDENTITY;
          break;
        case "Tm":
          tm = nums.slice(-6) as Mat;
          break;
        case "Tj": {
          const full = mul(tm, ctm);
          texts.push({ origin: apply(full, 0, 0), matrix: full });
          break;
        }
      }
      operands = [];
    } else {
      operands.push(t);
    }
  }
  return { draws, texts, balanced: stack.length === 0 };
}

function imageXObjectNames(doc: PDFDocument, pageIndex: number): string[] {
  const resources = doc.getPage(pageIndex).node.Resources();
  const xobjects = resources?.lookupMaybe(PDFName.of("XObject"), PDFDict);
  if (!xobjects) return [];
  return xobjects
    .keys()
    .filter((k) => {
      const obj = xobjects.lookup(k);
      return obj instanceof PDFStream && obj.dict.get(PDFName.of("Subtype")) === PDFName.of("Image");
    })
    .map((k) => k.asString());
}

function unitSquareBounds(m: Mat) {
  const pts = [apply(m, 0, 0), apply(m, 1, 0), apply(m, 0, 1), apply(m, 1, 1)];
  return {
    x0: Math.min(...pts.map((p) => p.x)),
    x1: Math.max(...pts.map((p) => p.x)),
    y0: Math.min(...pts.map((p) => p.y)),
    y1: Math.max(...pts.map((p) => p.y)),
  };
}

const EPS = 1e-3;

function expectInside(b: ReturnType<typeof unitSquareBounds>, r: PdfRect) {
  expect(b.x0).toBeGreaterThanOrEqual(r.x - EPS);
  expect(b.x1).toBeLessThanOrEqual(r.x + r.width + EPS);
  expect(b.y0).toBeGreaterThanOrEqual(r.y - EPS);
  expect(b.y1).toBeLessThanOrEqual(r.y + r.height + EPS);
}

/** Gambar stempel di halaman: XObject gambar yang dipanggil `Do`. */
function stampDraws(doc: PDFDocument, pageIndex: number) {
  const names = new Set(imageXObjectNames(doc, pageIndex));
  const parsed = interpret(pageContentBytes(doc, pageIndex));
  return { ...parsed, images: parsed.draws.filter((d) => names.has(d.name)) };
}

async function makePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  // 0: A4 biasa
  const a4 = doc.addPage([595.28, 841.89]);
  a4.drawText("Kontrak kerja sama", { x: 72, y: 760, size: 14, font });
  // 1: A4 dengan /Rotate 90 (lanskap di layar)
  const rot = doc.addPage([595.28, 841.89]);
  rot.setRotation(degrees(90));
  rot.drawText("Halaman lanskap", { x: 72, y: 760, size: 14, font });
  // 2: MediaBox ber-offset
  const off = doc.addPage([612, 792]);
  off.setMediaBox(50, 50, 612, 792); // [50 50 662 842]
  off.drawText("Halaman offset", { x: 100, y: 780, size: 14, font });
  // 3: isi lama meninggalkan matriks transformasi tanpa q/Q
  const leak = doc.addPage([595.28, 841.89]);
  leak.pushOperators(concatTransformationMatrix(2, 0, 0, 2, 30, 40));
  leak.drawText("Isi dengan cm bocor", { x: 20, y: 300, size: 10, font });
  // 4: /Rotate 270
  const rot270 = doc.addPage([595.28, 841.89]);
  rot270.setRotation(degrees(270));
  // 5: /Rotate 180
  const rot180 = doc.addPage([595.28, 841.89]);
  rot180.setRotation(degrees(180));
  doc.setKeywords(["kontrak", "2026"]);
  return doc.save();
}

function rawIncludes(bytes: Uint8Array, needle: string): boolean {
  return new TextDecoder("latin1").decode(bytes).includes(needle);
}

const baseOpts = {
  png: PNG_2X1,
  signerName: "Rina Wulandari",
  signedAt: SIGNED_AT,
  docTag: DOC_TAG,
  timeZone: "Asia/Jakarta",
};

describe("formatSignedAt", () => {
  it("menulis WIB, WITA, WIT, dan UTC", () => {
    expect(formatSignedAt(SIGNED_AT, "Asia/Jakarta")).toBe("22 November 2026, 15.04 WIB");
    expect(formatSignedAt(SIGNED_AT, "Asia/Makassar")).toBe("22 November 2026, 16.04 WITA");
    expect(formatSignedAt(SIGNED_AT, "Asia/Jayapura")).toBe("22 November 2026, 17.04 WIT");
    expect(formatSignedAt(SIGNED_AT, "UTC")).toBe("22 November 2026, 08.04 UTC");
  });

  it("menulis selisih lain sebagai UTC+x atau UTC-x, termasuk menit", () => {
    // Nama zona dipilih dari selisih, bukan nama IANA: Windows memetakan WIB ke Asia/Bangkok.
    expect(formatSignedAt(SIGNED_AT, "Asia/Bangkok")).toBe("22 November 2026, 15.04 WIB");
    expect(formatSignedAt(SIGNED_AT, "Europe/Berlin")).toBe("22 November 2026, 09.04 UTC+1");
    expect(formatSignedAt(SIGNED_AT, "America/New_York")).toBe("22 November 2026, 03.04 UTC-5");
    expect(formatSignedAt(SIGNED_AT, "Asia/Kolkata")).toBe("22 November 2026, 13.34 UTC+5.30");
  });

  it("menerima Date, tengah malam 00, dan tanggal satu digit", () => {
    expect(formatSignedAt(new Date("2026-01-04T17:00:00Z"), "Asia/Jakarta")).toBe(
      "5 Januari 2026, 00.00 WIB",
    );
  });

  it("menolak waktu yang tidak valid", () => {
    expect(() => formatSignedAt("bukan tanggal")).toThrow("Waktu tanda tangan tidak valid.");
  });
});

describe("toWinAnsiSafe", () => {
  it("membiarkan huruf Latin dan Latin-1", () => {
    expect(toWinAnsiSafe("Siti Nur'aini")).toBe("Siti Nur'aini");
    expect(toWinAnsiSafe("José Müller")).toBe("José Müller");
    expect(toWinAnsiSafe("Œuvre €5 “kutip”")).toBe("Œuvre €5 “kutip”");
  });

  it("mengganti karakter di luar WinAnsi dengan ?", () => {
    expect(toWinAnsiSafe("Nguyễn")).toBe("Nguy?n");
    expect(toWinAnsiSafe("王小明")).toBe("???");
    expect(toWinAnsiSafe("Budi 👍")).toBe("Budi ?"); // satu emoji = satu tanda tanya
  });

  it("menormalkan spasi aneh dan membuang karakter tak terlihat", () => {
    expect(toWinAnsiSafe("  Ani  Lestari\t ")).toBe("Ani Lestari");
    expect(toWinAnsiSafe("A B　C\nD")).toBe("A B C D");
    expect(toWinAnsiSafe("Ra​ka﻿")).toBe("Raka");
    expect(toWinAnsiSafe("José")).toBe("José"); // NFC
  });

  it("setiap karakter yang lolos bisa ditulis Helvetica standar", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    let all = "";
    for (let cp = 0x20; cp < 0x3000; cp++) all += String.fromCodePoint(cp);
    const safe = toWinAnsiSafe(all);
    expect(() => font.encodeText(safe)).not.toThrow();
    const supported = new Set(font.getCharacterSet());
    for (const ch of safe) expect(supported.has(ch.codePointAt(0)!)).toBe(true);
  });
});

describe("captionFontSize", () => {
  it("proporsional dengan lebar kotak, 6 sampai 10 pt", () => {
    expect(captionFontSize(40)).toBe(6);
    expect(captionFontSize(128)).toBe(8);
    expect(captionFontSize(400)).toBe(10);
  });
});

describe("stampSignature", () => {
  it("menstempel halaman A4 biasa: gambar di dalam persegi, metadata, byte mentah", async () => {
    const pdf = await makePdf();
    const placement: PdfRect = { pageIndex: 0, x: 350, y: 120, width: 160, height: 60 };
    const out = await stampSignature(pdf, { ...baseOpts, placement });

    const doc = await PDFDocument.load(out, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(6);
    expect(doc.getKeywords()).toContain(DOC_TAG);
    expect(doc.getKeywords()).toContain("kontrak");
    expect(doc.getKeywords()).toContain("2026");
    expect(doc.getProducer()).toBe("Mira");
    expect(rawIncludes(out, DOC_TAG)).toBe(true);
    expect(rawIncludes(out, `/Keywords (kontrak 2026 ${DOC_TAG})`)).toBe(true);
    // Bagian tambahan tanpa object stream, supaya terbaca dengan memindai byte.
    expect(rawIncludes(out.subarray(pdf.length), "/ObjStm")).toBe(false);

    const { images, texts, balanced } = stampDraws(doc, 0);
    expect(balanced).toBe(true);
    expect(images).toHaveLength(1);
    const b = unitSquareBounds(images[0].ctm);
    expectInside(b, placement);
    // PNG 2:1 di kotak 160x60: tinggi penuh 60, lebar 120, di tengah.
    expect(b.y1 - b.y0).toBeCloseTo(60, 3);
    expect(b.x1 - b.x0).toBeCloseTo(120, 3);
    expect(b.x0).toBeCloseTo(370, 3);
    // Tegak: sumbu x gambar mengarah ke +x.
    expect(images[0].ctm[0]).toBeGreaterThan(0);
    expect(Math.abs(images[0].ctm[1])).toBeLessThan(EPS);

    // Keterangan di bawah kotak (dua baris, karena satu baris lebih lebar dari kotak).
    const captions = texts.filter((t) => t.origin.y < placement.y);
    expect(captions).toHaveLength(2);
    expect(captions[0].origin.y).toBeGreaterThan(captions[1].origin.y);
    expect(captions[0].matrix[0]).toBeGreaterThan(0);
    // Halaman lain tidak tersentuh.
    expect(stampDraws(doc, 1).images).toHaveLength(0);
  });

  it("menaruh keterangan di atas kalau di bawah kotak tidak cukup ruang", async () => {
    const pdf = await makePdf();
    const placement: PdfRect = { pageIndex: 0, x: 200, y: 4, width: 160, height: 50 };
    const doc = await PDFDocument.load(await stampSignature(pdf, { ...baseOpts, placement }), { updateMetadata: false });
    const { texts } = stampDraws(doc, 0);
    const captions = texts.filter((t) => t.origin.y > placement.y + placement.height);
    // Teks lama "Kontrak kerja sama" juga di atas; keterangan berada dekat kotak.
    const near = captions.filter((t) => t.origin.y < placement.y + placement.height + 40);
    expect(near).toHaveLength(2);
    expect(texts.filter((t) => t.origin.y < placement.y)).toHaveLength(0);
  });

  it("halaman /Rotate 90: gambar diputar 90 derajat dan tetap di dalam persegi", async () => {
    const pdf = await makePdf();
    // Di layar kotak 150 lebar x 50 tinggi; di userspace jadi 50 x 150.
    const placement: PdfRect = { pageIndex: 1, x: 300, y: 400, width: 50, height: 150 };
    const doc = await PDFDocument.load(await stampSignature(pdf, { ...baseOpts, placement }), { updateMetadata: false });
    const { images, texts } = stampDraws(doc, 1);
    expect(images).toHaveLength(1);
    const m = images[0].ctm;
    const b = unitSquareBounds(m);
    expectInside(b, placement);
    // Lebar visual 150 dengan rasio 2:1 -> 100 x 50; di userspace tinggi 100, lebar 50.
    expect(b.y1 - b.y0).toBeCloseTo(100, 3);
    expect(b.x1 - b.x0).toBeCloseTo(50, 3);
    // Sumbu x gambar ke +y userspace, sumbu y gambar ke -x (rotasi 90 berlawanan jarum jam).
    expect(Math.abs(m[0])).toBeLessThan(EPS);
    expect(m[1]).toBeGreaterThan(0);
    expect(m[2]).toBeLessThan(0);
    // "Di bawah" bagi pembaca = x lebih besar di userspace.
    const captions = texts.filter((t) => t.origin.x > placement.x + placement.width);
    expect(captions).toHaveLength(2);
    for (const t of captions) {
      expect(t.origin.y).toBeGreaterThanOrEqual(placement.y - 60);
      expect(t.matrix[1]).toBeGreaterThan(0); // teks juga diputar
    }
  });

  it("halaman /Rotate 180 dan 270: gambar di dalam persegi dengan arah yang benar", async () => {
    const pdf = await makePdf();
    const p270: PdfRect = { pageIndex: 4, x: 100, y: 300, width: 60, height: 180 };
    const p180: PdfRect = { pageIndex: 5, x: 100, y: 300, width: 180, height: 60 };
    let out = await stampSignature(pdf, { ...baseOpts, placement: p270 });
    out = await stampSignature(out, { ...baseOpts, placement: p180 });
    const doc = await PDFDocument.load(out, { updateMetadata: false });

    const i270 = stampDraws(doc, 4).images;
    expect(i270).toHaveLength(1);
    expectInside(unitSquareBounds(i270[0].ctm), p270);
    expect(i270[0].ctm[1]).toBeLessThan(0); // sumbu x gambar ke -y
    const t270 = stampDraws(doc, 4).texts;
    expect(t270.every((t) => t.origin.x < p270.x)).toBe(true); // bawah visual = x lebih kecil

    const i180 = stampDraws(doc, 5).images;
    expect(i180).toHaveLength(1);
    expectInside(unitSquareBounds(i180[0].ctm), p180);
    expect(i180[0].ctm[0]).toBeLessThan(0); // terbalik di userspace, tegak di layar
    const t180 = stampDraws(doc, 5).texts;
    expect(t180.every((t) => t.origin.y > p180.y + p180.height)).toBe(true);
  });

  it("MediaBox ber-offset: koordinat absolut dipakai apa adanya", async () => {
    const pdf = await makePdf();
    const placement: PdfRect = { pageIndex: 2, x: 400, y: 100, width: 200, height: 80 };
    const doc = await PDFDocument.load(await stampSignature(pdf, { ...baseOpts, placement }), { updateMetadata: false });
    const { images, texts } = stampDraws(doc, 2);
    expect(images).toHaveLength(1);
    expectInside(unitSquareBounds(images[0].ctm), placement);
    const captions = texts.filter((t) => t.origin.y < placement.y);
    expect(captions.length).toBeGreaterThanOrEqual(1);
    for (const t of captions) expect(t.origin.y).toBeGreaterThan(50);
  });

  it("isi lama yang membocorkan matriks cm tidak menggeser stempel", async () => {
    const pdf = await makePdf();
    const placement: PdfRect = { pageIndex: 3, x: 300, y: 200, width: 120, height: 60 };
    const doc = await PDFDocument.load(await stampSignature(pdf, { ...baseOpts, placement }), { updateMetadata: false });
    // Tanpa pembungkus q/Q, cm 2x dari isi lama akan membuat gambar dua kali lebih besar.
    const { images } = stampDraws(doc, 3);
    expect(images).toHaveLength(1);
    expectInside(unitSquareBounds(images[0].ctm), placement);
  });

  it("dua penanda tangan berturut-turut tetap valid", async () => {
    const pdf = await makePdf();
    const first: PdfRect = { pageIndex: 0, x: 60, y: 120, width: 160, height: 60 };
    const second: PdfRect = { pageIndex: 0, x: 350, y: 120, width: 160, height: 60 };
    const once = await stampSignature(pdf, { ...baseOpts, placement: first });
    const twice = await stampSignature(once, {
      ...baseOpts,
      placement: second,
      signerName: "Agus Prasetyo",
      signedAt: "2026-11-22T09:30:00Z",
    });
    const doc = await PDFDocument.load(twice, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(6);
    const kw = doc.getKeywords() ?? "";
    expect(kw.split(" ").filter((k) => k === DOC_TAG)).toHaveLength(1);
    const { images } = stampDraws(doc, 0);
    expect(images).toHaveLength(2);
    const boxes = images.map((i) => unitSquareBounds(i.ctm)).sort((a, b) => a.x0 - b.x0);
    expectInside(boxes[0], first);
    expectInside(boxes[1], second);
  });

  it("mengganti kode mira-doc lama dan menulis nama non-Latin sebagai ?", async () => {
    const src = await PDFDocument.load(await makePdf());
    src.setKeywords(["arsip", "mira-doc:ffffffffffffffffffffffffffffffff"]);
    const out = await stampSignature(await src.save(), {
      ...baseOpts,
      signerName: "王小明",
      placement: { pageIndex: 0, x: 100, y: 300, width: 160, height: 60 },
    });
    const doc = await PDFDocument.load(out, { updateMetadata: false });
    expect(doc.getKeywords()).toBe(`arsip ${DOC_TAG}`);
  });

  it("menolak file bukan PDF dengan pesan berbahasa Indonesia", async () => {
    const junk = new TextEncoder().encode("ini cuma teks biasa, bukan PDF");
    await expect(
      stampSignature(junk, { ...baseOpts, placement: { pageIndex: 0, x: 0, y: 0, width: 10, height: 10 } }),
    ).rejects.toThrow("File ini bukan PDF atau rusak");
    const broken = new TextEncoder().encode("%PDF-1.7\nsampah tanpa objek");
    await expect(
      stampSignature(broken, { ...baseOpts, placement: { pageIndex: 0, x: 0, y: 0, width: 10, height: 10 } }),
    ).rejects.toThrow(/PDF ini rusak|tidak ada di PDF ini/);
  });

  it("menolak PDF terenkripsi", async () => {
    const doc = await PDFDocument.load(await makePdf());
    // Tandai terenkripsi lewat /Encrypt di trailer (cukup untuk deteksi pdf-lib).
    doc.context.trailerInfo.Encrypt = doc.context.obj({ Filter: "Standard", V: 1, R: 2 });
    const bytes = await doc.save({ useObjectStreams: false });
    await expect(
      stampSignature(bytes, { ...baseOpts, placement: { pageIndex: 0, x: 0, y: 0, width: 10, height: 10 } }),
    ).rejects.toThrow("PDF ini dilindungi kata sandi pemilik, jadi Mira tidak bisa menambahkan tanda tangan.");
  });

  it("/Rotate yang bukan kelipatan 90 dianggap 0, sama dengan pdf.js", async () => {
    const src = await PDFDocument.load(await makePdf());
    // pdf-lib menolak setRotation(45), jadi nilai ditulis langsung ke kamus halaman.
    src.getPage(0).node.set(PDFName.of("Rotate"), PDFNumber.of(45));
    const placement: PdfRect = { pageIndex: 0, x: 350, y: 120, width: 160, height: 60 };
    const doc = await PDFDocument.load(await stampSignature(await src.save(), { ...baseOpts, placement }), {
      updateMetadata: false,
    });
    const { images } = stampDraws(doc, 0);
    expect(images).toHaveLength(1);
    const b = unitSquareBounds(images[0].ctm);
    expectInside(b, placement);
    expect(b.x0).toBeCloseTo(370, 3);
    expect(images[0].ctm[0]).toBeGreaterThan(0);
    expect(Math.abs(images[0].ctm[1])).toBeLessThan(EPS);
  });

  it("menolak halaman di luar jangkauan dan ukuran nol", async () => {
    const pdf = await makePdf();
    await expect(
      stampSignature(pdf, { ...baseOpts, placement: { pageIndex: 9, x: 0, y: 0, width: 10, height: 10 } }),
    ).rejects.toThrow("Halaman 10 tidak ada di PDF ini");
    await expect(
      stampSignature(pdf, { ...baseOpts, placement: { pageIndex: 0, x: 0, y: 0, width: 0, height: 10 } }),
    ).rejects.toThrow("Posisi tanda tangan tidak valid.");
  });
});

describe("normalizeAngle", () => {
  it("mengikuti pdf.js: kelipatan 90 dinormalkan, selain itu 0", () => {
    expect(normalizeAngle(0)).toBe(0);
    expect(normalizeAngle(90)).toBe(90);
    expect(normalizeAngle(450)).toBe(90);
    expect(normalizeAngle(-90)).toBe(270);
    expect(normalizeAngle(-180)).toBe(180);
    expect(normalizeAngle(45)).toBe(0);
    expect(normalizeAngle(100)).toBe(0);
    expect(normalizeAngle(Number.NaN)).toBe(0);
  });
});

describe("checkSignablePdf", () => {
  it("menerima PDF biasa", async () => {
    await expect(checkSignablePdf(await makePdf())).resolves.toBeUndefined();
  });

  it("menolak PDF berkata sandi pemilik dengan AppError pdf_invalid", async () => {
    const doc = await PDFDocument.load(await makePdf());
    doc.context.trailerInfo.Encrypt = doc.context.obj({ Filter: "Standard", V: 1, R: 2 });
    const bytes = await doc.save({ useObjectStreams: false });
    await expect(checkSignablePdf(bytes)).rejects.toEqual({
      code: "pdf_invalid",
      message:
        "PDF ini dilindungi kata sandi pemilik, jadi Mira tidak bisa menambahkan tanda tangan. Simpan ulang tanpa perlindungan di aplikasi asalnya, lalu coba lagi.",
    });
  });

  it("menolak PDF rusak dan file bukan PDF", async () => {
    const broken = new TextEncoder().encode("%PDF-1.7 sampah tanpa objek");
    await expect(checkSignablePdf(broken)).rejects.toMatchObject({
      code: "pdf_invalid",
      message: expect.stringMatching(/^PDF ini rusak atau formatnya tidak didukung/),
    });
    await expect(checkSignablePdf(new TextEncoder().encode("bukan PDF"))).rejects.toMatchObject({
      code: "pdf_invalid",
      message: expect.stringMatching(/^File ini bukan PDF/),
    });
  });
});

describe("appendAuditPage", () => {
  const signer = (i: number) => ({
    name: i % 2 ? "Dewi Anggraini Kusumawardhani Putri" : `Penanda tangan ${i}`,
    kind: (i % 3 === 0 ? "guest" : "member") as "guest" | "member",
    signedAt: "2026-11-22T08:04:00Z",
    fingerprint: "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12",
  });
  const info = {
    title: "Perjanjian kerja sama distribusi wilayah Jawa Timur tahun anggaran 2027 dengan lampiran harga",
    docTag: DOC_TAG,
    originalHash: "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262",
    mode: "sequential" as const,
    signers: [signer(1), signer(2), signer(3)],
    generatedAt: "2026-11-22T09:00:00Z",
    timeZone: "Asia/Jakarta",
  };

  it("menambah satu halaman A4 dengan metadata dan kode dokumen di byte mentah", async () => {
    const stamped = await stampSignature(await makePdf(), {
      ...baseOpts,
      placement: { pageIndex: 0, x: 350, y: 120, width: 160, height: 60 },
    });
    const out = await appendAuditPage(stamped, info);
    const doc = await PDFDocument.load(out, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(7);
    const last = doc.getPage(6);
    expect(last.getWidth()).toBeCloseTo(595.28, 1);
    expect(last.getHeight()).toBeCloseTo(841.89, 1);
    expect(doc.getKeywords()).toContain(DOC_TAG);
    expect(doc.getProducer()).toBe("Mira");
    expect(rawIncludes(out.subarray(stamped.length), DOC_TAG)).toBe(true);
    expect(rawIncludes(out.subarray(stamped.length), "/ObjStm")).toBe(false);

    // Semua teks berada di dalam halaman.
    const { texts } = interpret(pageContentBytes(doc, 6));
    expect(texts.length).toBeGreaterThan(10);
    for (const t of texts) {
      expect(t.origin.x).toBeGreaterThanOrEqual(0);
      expect(t.origin.x).toBeLessThan(595.28);
      expect(t.origin.y).toBeGreaterThan(0);
      expect(t.origin.y).toBeLessThan(841.89);
    }
  });

  it("daftar panjang dibagi ke beberapa halaman", async () => {
    const many = { ...info, mode: "parallel" as const, signers: Array.from({ length: 40 }, (_, i) => signer(i + 1)) };
    const doc = await PDFDocument.load(await appendAuditPage(await makePdf(), many));
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(8);
    for (let p = 6; p < doc.getPageCount(); p++) {
      const { texts } = interpret(pageContentBytes(doc, p));
      for (const t of texts) {
        expect(t.origin.y).toBeGreaterThan(30);
        expect(t.origin.y).toBeLessThan(841.89);
      }
    }
  });

  it("tanpa penanda tangan tetap menghasilkan halaman", async () => {
    const doc = await PDFDocument.load(await appendAuditPage(await makePdf(), { ...info, signers: [] }));
    expect(doc.getPageCount()).toBe(7);
  });

  it("menolak file bukan PDF", async () => {
    await expect(appendAuditPage(new Uint8Array([1, 2, 3]), info)).rejects.toThrow(
      "File ini bukan PDF atau rusak",
    );
  });
});

// ---------------------------------------------------------------------------
// Incremental update: versi baru = byte versi lama + tambahan

const latin1 = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes);

function isPrefix(prefix: Uint8Array, whole: Uint8Array): boolean {
  if (prefix.length >= whole.length) return false;
  for (let i = 0; i < prefix.length; i++) if (prefix[i] !== whole[i]) return false;
  return true;
}

function lastStartxref(bytes: Uint8Array): number {
  const text = latin1(bytes);
  return Number(/^startxref\s*(\d+)/.exec(text.slice(text.lastIndexOf("startxref")))?.[1]);
}

type XrefEntry = { num: number; gen: number; offset: number };

/** Entri tabel xref bagian tambahan terakhir. */
function lastXrefEntries(bytes: Uint8Array): XrefEntry[] {
  const text = latin1(bytes);
  const at = lastStartxref(bytes);
  expect(text.slice(at, at + 5)).toBe("xref\n");
  const lines = text
    .slice(at + 5, text.indexOf("trailer", at))
    .split(/\r?\n/)
    .filter((l) => l.trim());
  const entries: XrefEntry[] = [];
  for (let i = 0; i < lines.length; ) {
    const [start, count] = lines[i].trim().split(/\s+/).map(Number);
    for (let k = 0; k < count; k++) {
      const [off, gen, kind] = lines[i + 1 + k].trim().split(/\s+/);
      expect(kind).toBe("n");
      entries.push({ num: start + k, gen: Number(gen), offset: Number(off) });
    }
    i += 1 + count;
  }
  return entries;
}

/** Bukti dasar satu langkah: awalan, /Prev, xref klasik yang menunjuk objeknya. */
function expectIncrement(prev: Uint8Array, next: Uint8Array): XrefEntry[] {
  expect(isPrefix(prev, next)).toBe(true);
  const tail = latin1(next.subarray(prev.length));
  expect(tail).toContain(`/Prev ${lastStartxref(prev)}`);
  expect(tail).not.toContain("/ObjStm");
  expect(tail).not.toContain("/XRefStm");
  expect(tail.trimEnd().endsWith("%%EOF")).toBe(true);
  const text = latin1(next);
  const entries = lastXrefEntries(next);
  expect(entries.length).toBeGreaterThan(0);
  for (const e of entries) {
    expect(e.offset).toBeGreaterThanOrEqual(prev.length);
    expect(text.slice(e.offset, e.offset + 24)).toMatch(new RegExp(`^${e.num} ${e.gen} obj\\b`));
  }
  return entries;
}

async function originals(): Promise<{ name: string; bytes: Uint8Array }[]> {
  const src = await PDFDocument.load(await makePdf());
  const classic = await src.save({ useObjectStreams: false });
  const objstm = await src.save({ useObjectStreams: true });
  const trimmed = classic.subarray(0, latin1(classic).trimEnd().length);
  const junk = new Uint8Array([...classic, ...new TextEncoder().encode("\r\n\0sampah setelah EOF")]);
  return [
    { name: "xref klasik", bytes: classic },
    { name: "object stream", bytes: objstm },
    { name: "tanpa baris baru di akhir", bytes: trimmed },
    { name: "sampah setelah %%EOF", bytes: junk },
  ];
}

const FIRST: PdfRect = { pageIndex: 0, x: 350, y: 120, width: 160, height: 60 };
const SECOND: PdfRect = { pageIndex: 2, x: 120, y: 200, width: 160, height: 60 };

const AUDIT: AuditInfo = {
  title: "Kontrak kerja sama",
  docTag: DOC_TAG,
  originalHash: "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262",
  mode: "sequential",
  signers: [
    { name: "Rina Wulandari", kind: "member", signedAt: SIGNED_AT, fingerprint: "ab12 cd34 ef56 7890" },
    { name: "Agus Prasetyo", kind: "guest", signedAt: SIGNED_AT, fingerprint: "1122 3344 5566 7788" },
  ],
  generatedAt: "2026-11-22T09:00:00Z",
  timeZone: "Asia/Jakarta",
};

describe("incremental update", () => {
  it("berantai: setiap versi awalan persis versi berikutnya", async () => {
    for (const { name, bytes: v0 } of await originals()) {
      const v1 = await stampSignature(v0, { ...baseOpts, placement: FIRST });
      const v2 = await stampSignature(v1, { ...baseOpts, signerName: "Agus Prasetyo", placement: SECOND });
      const v3 = await appendAuditPage(v2, AUDIT);
      expectIncrement(v0, v1);
      expectIncrement(v1, v2);
      expectIncrement(v2, v3);

      // pdf-lib memuat ulang dan melihat stempel serta halaman catatan.
      const doc1 = await PDFDocument.load(v1, { updateMetadata: false });
      expect(doc1.getPageCount(), name).toBe(6);
      expect(stampDraws(doc1, 0).images, name).toHaveLength(1);
      const doc3 = await PDFDocument.load(v3, { updateMetadata: false });
      expect(doc3.getPageCount(), name).toBe(7);
      expect(stampDraws(doc3, 0).images, name).toHaveLength(1);
      expect(stampDraws(doc3, 2).images, name).toHaveLength(1);
      expect(stampDraws(doc3, 0).balanced, name).toBe(true);
      expect(doc3.getKeywords(), name).toContain(DOC_TAG);
    }
  });

  it("hanya halaman yang distempel dan kamus Info yang ditulis ulang", async () => {
    const [classic, objstm] = await originals();
    for (const { name, bytes: v0 } of [classic, objstm]) {
      const src = await PDFDocument.load(v0, { updateMetadata: false });
      const page0 = src.getPage(0).ref.objectNumber;
      const info = (src.context.trailerInfo.Info as PDFRef).objectNumber;
      const old = new Set(src.context.enumerateIndirectObjects().map(([r]) => r.objectNumber));
      const v1 = await stampSignature(v0, { ...baseOpts, placement: FIRST });
      const rewritten = expectIncrement(v0, v1)
        .map((e) => e.num)
        .filter((n) => old.has(n))
        .sort((a, b) => a - b);
      expect(rewritten, name).toEqual([page0, info].sort((a, b) => a - b));
    }
  });

  it("nomor objek baru tidak memakai ulang nomor object stream atau xref stream lama", async () => {
    const [, { bytes: v0 }] = await originals();
    const text = latin1(v0);
    const containers = [...text.matchAll(/(\d+) 0 obj\s*<<[^]*?\/Type\s*\/(ObjStm|XRef)/g)].map((m) =>
      Number(m[1]),
    );
    expect(containers.length).toBeGreaterThan(0);
    const size = Math.max(...[...text.matchAll(/\/Size (\d+)/g)].map((m) => Number(m[1])));
    const src = await PDFDocument.load(v0, { updateMetadata: false });
    const old = new Set(src.context.enumerateIndirectObjects().map(([r]) => r.objectNumber));
    const v1 = await stampSignature(v0, { ...baseOpts, placement: FIRST });
    for (const e of expectIncrement(v0, v1)) {
      expect(containers).not.toContain(e.num);
      if (!old.has(e.num)) expect(e.num).toBeGreaterThanOrEqual(size);
    }
  });

  it("kode dokumen terbaca sebagai literal di byte tambahan", async () => {
    const [{ bytes: v0 }] = await originals();
    const v1 = await stampSignature(v0, { ...baseOpts, placement: FIRST });
    const tail = latin1(v1.subarray(v0.length));
    expect(tail).toContain(`/MiraDocTag (${DOC_TAG})`);
    expect(tail).toContain(`/Keywords (kontrak 2026 ${DOC_TAG})`);
  });

  it("halaman tanpa /Annots tidak mendapat /Annots kosong", async () => {
    const src = await PDFDocument.load(await makePdf());
    src.getPage(0).node.delete(PDFName.of("Annots"));
    const v0 = await src.save();
    const v1 = await stampSignature(v0, { ...baseOpts, placement: FIRST });
    const doc = await PDFDocument.load(v1, { updateMetadata: false });
    expect(doc.getPage(0).node.get(PDFName.of("Annots"))).toBeUndefined();
    expect(stampDraws(doc, 0).images).toHaveLength(1);
  });

  it("checkSignablePdf menolak PDF yang startxref-nya tidak menunjuk tabel xref", async () => {
    const [{ bytes: v0 }] = await originals();
    const text = latin1(v0);
    // makePdf hanya berisi ASCII, jadi latin1 lalu UTF-8 tidak mengubah byte.
    const broken = new TextEncoder().encode(`${text.slice(0, text.lastIndexOf("startxref"))}startxref\n12\n%%EOF\n`);
    await expect(checkSignablePdf(broken)).rejects.toMatchObject({ code: "pdf_invalid" });
    await expect(checkSignablePdf(v0)).resolves.toBeUndefined();
  });

  describe("dibaca pdf.js", () => {
    let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
    beforeAll(async () => {
      pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    }, 120_000);

    it("halaman bertanda tangan dan halaman catatan dirender", async () => {
      const [, { bytes: v0 }] = await originals();
      const v1 = await stampSignature(v0, { ...baseOpts, placement: FIRST });
      const v2 = await appendAuditPage(v1, AUDIT);
      const task = pdfjs.getDocument({ data: v2.slice(), verbosity: 0 });
      try {
        const pdf = await task.promise;
        expect(pdf.numPages).toBe(7);
        const first = await pdf.getPage(1);
        const ops = (await first.getOperatorList()).fnArray;
        expect(ops).toContain(pdfjs.OPS.paintImageXObject);
        expect(ops).toContain(pdfjs.OPS.showText);
        const last = await pdf.getPage(7);
        const lastOps = (await last.getOperatorList()).fnArray;
        expect(lastOps.filter((op) => op === pdfjs.OPS.showText).length).toBeGreaterThan(10);
        const text = await last.getTextContent();
        expect(text.items.map((i) => ("str" in i ? i.str : "")).join(" ")).toContain("Halaman catatan");
      } finally {
        await task.destroy();
      }
    }, 120_000);
  });
});
