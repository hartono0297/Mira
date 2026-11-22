// Membuat fixture PDF untuk tes bukti stempel di inti Rust
// (src-tauri/src/signing/increment.rs, folder src-tauri/tests/fixtures/sign).
// Stempel dikerjakan oleh src/screens/sign/stamp.ts yang sama dengan aplikasi.
//
// Jalankan dari akar repo (Node 22.6 ke atas):
//   npm run fixtures:sign
//
// Hasil (nama sumber daya pdf-lib acak, jadi byte berbeda tiap kali dijalankan):
//   original-classic.pdf, original-objstm.pdf     dokumen asli (xref klasik / object stream)
//   original-indirect.pdf                         Resources warisan tak langsung, Font dan
//                                                 Contents tak langsung, tanpa baris baru di akhir
//   <asli>-stamped1.pdf                           penanda tangan pertama
//   <asli>-stamped2.pdf                           penanda tangan kedua (halaman lain)
//   <asli>-audit.pdf                              + halaman catatan
//   large-stamp.pdf                               kotak tanda tangan selebar halaman (sah)
//   tampered-text.pdf                             stempel + angka di teks halaman 1 diganti
//   tampered-cover.pdf                            stempel + persegi putih menutup halaman 1
//   tampered-mediabox.pdf                         stempel + MediaBox halaman 2 diubah
// large-stamp dan semua tampered-* dibangun di atas original-objstm.pdf.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import {
  PDFDocument,
  PDFName,
  PDFArray,
  PDFRawStream,
  StandardFonts,
  decodePDFRawStream,
  rgb,
} from "pdf-lib";
import { appendAuditPage, stampSignature } from "../src/screens/sign/stamp.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src-tauri", "tests", "fixtures", "sign");
mkdirSync(outDir, { recursive: true });

const TAG = "mira-doc:0123456789abcdef0123456789abcdef";
const FIXED_DATE = new Date("2026-11-22T08:00:00Z");

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** PNG 64x32 RGBA: dua garis coretan hitam di atas latar transparan. */
function signaturePng() {
  const w = 64;
  const h = 32;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 4); // filter 0
    for (let x = 0; x < w; x++) {
      const onStroke = Math.abs(y - (h - 1 - (x * (h - 1)) / (w - 1))) < 1.5 || Math.abs(y - 16 - 6 * Math.sin(x / 6)) < 1;
      if (onStroke) row[1 + x * 4 + 3] = 255;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", ihdr),
      pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

async function baseDoc() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  doc.setProducer("fixture");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const [i, text] of ["Kontrak kerja sama. Total: Rp 1.000.000", "Lampiran harga"].entries()) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(text, { x: 72, y: 760, size: 14, font });
    page.drawText(`Halaman ${i + 1}`, { x: 72, y: 60, size: 9, font });
  }
  doc.setKeywords(["kontrak"]);
  return doc;
}

/** Resources di simpul Pages (tak langsung), Font dan Contents tak langsung. */
async function indirectDoc() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText("Dokumen dengan sumber daya warisan", { x: 72, y: 700, size: 14, font });
  await doc.flush();
  const ctx = doc.context;
  const res = page.node.Resources();
  res.set(PDFName.of("Font"), ctx.register(res.lookup(PDFName.of("Font"))));
  page.node.delete(PDFName.of("Resources"));
  page.node.delete(PDFName.of("Annots"));
  doc.catalog.Pages().set(PDFName.of("Resources"), ctx.register(res));
  const contents = page.node.get(PDFName.of("Contents"));
  const list = contents instanceof PDFArray ? contents : ctx.obj([contents]);
  page.node.set(PDFName.of("Contents"), ctx.register(list));
  return doc;
}

const save = (doc, useObjectStreams) => doc.save({ useObjectStreams, updateFieldAppearances: false });

const stampOpts = (pageIndex, signerName, signedAt) => ({
  placement: { pageIndex, x: 340, y: 120, width: 160, height: 80 },
  png: signaturePng(),
  signerName,
  signedAt,
  docTag: TAG,
  timeZone: "Asia/Jakarta",
});

const audit = {
  title: "Kontrak kerja sama",
  docTag: TAG,
  originalHash: "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262",
  mode: "sequential",
  signers: [
    { name: "Rina Wulandari", kind: "member", signedAt: "2026-11-22T08:04:00Z", fingerprint: "ab12 cd34 ef56 7890" },
    { name: "Agus Prasetyo", kind: "guest", signedAt: "2026-11-22T09:30:00Z", fingerprint: "1122 3344 5566 7788" },
  ],
  generatedAt: "2026-11-22T09:31:00Z",
  timeZone: "Asia/Jakarta",
};

const written = [];
function write(name, bytes) {
  writeFileSync(join(outDir, name), bytes);
  written.push(`${name} (${bytes.length} B)`);
}

async function chain(prefix, original) {
  write(`${prefix}.pdf`, original);
  const s1 = await stampSignature(original, stampOpts(0, "Rina Wulandari", "2026-11-22T08:04:00Z"));
  write(`${prefix}-stamped1.pdf`, s1);
  const lastPage = (await PDFDocument.load(original)).getPageCount() - 1;
  const s2 = await stampSignature(s1, stampOpts(lastPage, "Agus Prasetyo", "2026-11-22T09:30:00Z"));
  write(`${prefix}-stamped2.pdf`, s2);
  write(`${prefix}-audit.pdf`, await appendAuditPage(s2, audit));
}

/**
 * Menjalankan `edit(doc)` di tengah stampSignature, setelah stamp.ts memotret
 * keadaan awal, sehingga perubahan ikut tertulis di incremental update yang
 * sama dengan stempel.
 */
async function stampWith(original, edit) {
  const embedPng = PDFDocument.prototype.embedPng;
  PDFDocument.prototype.embedPng = async function (png) {
    await edit(this);
    return embedPng.call(this, png);
  };
  try {
    return await stampSignature(original, stampOpts(0, "Rina Wulandari", "2026-11-22T08:04:00Z"));
  } finally {
    PDFDocument.prototype.embedPng = embedPng;
  }
}

const hex = (text) => Buffer.from(text, "latin1").toString("hex").toUpperCase();

await chain("original-classic", await save(await baseDoc(), false));
const objstm = await save(await baseDoc(), true);
await chain("original-objstm", objstm);
const indirect = await save(await indirectDoc(), false);
await chain("original-indirect", indirect.subarray(0, Buffer.from(indirect).toString("latin1").trimEnd().length));

// Kotak tanda tangan selebar halaman (PlacementBox mengizinkannya): luas
// gambar 50% halaman, tetapi sebagian besar transparan.
write(
  "large-stamp.pdf",
  await stampSignature(objstm, {
    ...stampOpts(0, "Rina Wulandari", "2026-11-22T08:04:00Z"),
    placement: { pageIndex: 0, x: 0, y: 200, width: 595.28, height: 420 },
  }),
);

// Mengganti "1.000.000" di stream teks halaman 1 menjadi "9.000.000".
write(
  "tampered-text.pdf",
  await stampWith(objstm, (doc) => {
    const contents = doc.getPage(0).node.Contents();
    const refs = contents instanceof PDFArray ? contents.asArray() : [doc.getPage(0).node.get(PDFName.of("Contents"))];
    let replaced = false;
    for (const ref of refs) {
      const stream = doc.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) continue;
      const text = Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
      const from = hex("1.000.000");
      if (!text.includes(from)) continue;
      const changed = text.replace(from, hex("9.000.000"));
      doc.context.assign(ref, doc.context.flateStream(Buffer.from(changed, "latin1")));
      replaced = true;
    }
    if (!replaced) throw new Error("teks 1.000.000 tidak ditemukan");
  }),
);

// Persegi putih menutup seluruh halaman 1, digambar sebagai bagian stempel.
write(
  "tampered-cover.pdf",
  await stampWith(objstm, (doc) => {
    const page = doc.getPage(0);
    page.drawRectangle({ x: 0, y: 0, width: page.getWidth(), height: page.getHeight(), color: rgb(1, 1, 1) });
  }),
);

// MediaBox halaman 2 dipersempit (memotong isi).
write(
  "tampered-mediabox.pdf",
  await stampWith(objstm, (doc) => {
    doc.getPage(1).setMediaBox(0, 0, 300, 300);
  }),
);

console.log(`Fixture di ${outDir}:\n  ${written.join("\n  ")}`);
