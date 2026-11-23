// Fixture PDF "dunia nyata" untuk tes bukti stempel di inti Rust
// (src-tauri/src/signing/increment.rs, folder src-tauri/tests/fixtures/sign/real).
// Stempel dikerjakan oleh src/screens/sign/stamp.ts yang sama dengan aplikasi.
//
// Jalankan dari akar repo (Node 22.6 ke atas):
//   npm run fixtures:sign-real              stempel ulang semua dokumen asli
//   npm run fixtures:sign-real -- --originals  buat ulang juga dokumen asli buatan skrip
//
// Dokumen asli (folder real/, masukan tes):
//   chrome-photo.pdf    dicetak Chrome headless (--print-to-pdf) dari HTML berisi logo SVG,
//                       foto JPEG (DCTDecode), tabel, dan tautan; PDF bertag. Tidak dibuat
//                       skrip ini, karena butuh Chrome.
//   photo.jpg           foto kecil untuk scan.pdf.
//   scan.pdf            hasil pindai: tiap halaman satu gambar JPEG penuh, object stream.
//   word-hybrid.pdf     meniru "Simpan sebagai PDF" Word: PDF 1.7, xref klasik + /XRefStm
//                       (hybrid), object stream, struktur bertag, font TrueType, tautan URI.
//   linearized.pdf      linearized: xref halaman pertama di depan, startxref terakhir
//                       menunjuk ke sana.
//   prev-xrefstm.pdf    sudah punya incremental update ber-xref stream (simpan ulang Acrobat).
//   prev-classic.pdf    sudah punya incremental update klasik (metadata diedit di penampil PDF).
//   acroform.pdf        formulir AcroForm terisi (teks dan kotak centang).
//   tree.pdf            /Contents larik, /Resources diwariskan dari /Pages, anotasi tautan.
//   page-aa.pdf         halaman dengan aksi tambahan /AA (sudah ada sebelum ditandatangani).
//   inline-annots.pdf   anotasi tautan URI langsung (bukan referensi) di /Annots.
//   blank-last.pdf      halaman terakhir kosong tanpa /Contents.
//
// Hasil (nama sumber daya pdf-lib acak, jadi byte berbeda tiap kali dijalankan):
//   <asli>.signed.pdf   asli + stempel halaman 1 + stempel halaman terakhir + halaman catatan,
//                       semuanya incremental update; <asli>.signed.txt berisi panjang byte
//                       tiap versi (asli, stempel 1, stempel 2, catatan).
//   tamper-<jenis>.<asli>.pdf  stempel di atas <asli>.pdf ditambah perubahan isi yang harus
//                       ditolak: content-stream, remove-page, replace-image, remap-image,
//                       form-value, mediabox, annot-uri, page-aa.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFString,
  StandardFonts,
  decodePDFRawStream,
  popGraphicsState,
  pushGraphicsState,
} from "pdf-lib";
import { appendAuditPage, stampSignature } from "../src/screens/sign/stamp.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "src-tauri", "tests", "fixtures", "sign", "real");
const TAG = "mira-doc:0123456789abcdef0123456789abcdef";
const FIXED_DATE = new Date("2026-11-20T02:30:00Z");

const enc = (s) => Buffer.from(s, "latin1");
const pad10 = (n) => String(n).padStart(10, "0");

// ---------------------------------------------------------------------------
// PNG tanda tangan (sama dengan make-sign-fixtures.mjs)

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
function signaturePng() {
  const w = 64;
  const h = 32;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 4);
    for (let x = 0; x < w; x++) {
      const on = Math.abs(y - (h - 1 - (x * (h - 1)) / 63)) < 1.5 || Math.abs(y - 16 - 6 * Math.sin(x / 6)) < 1;
      row.set(on ? [0, 0, 0, 255] : [0, 0, 0, 0], 1 + x * 4);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", ihdr),
      pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Dokumen asli buatan skrip

const flate = (dict, data) => {
  const body = deflateSync(Buffer.from(data, "latin1"));
  return Buffer.concat([enc(`<<${dict}/Filter/FlateDecode/Length ${body.length}>>stream\r\n`), body, enc("\r\nendstream")]);
};

async function libDoc(pages, draw) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  doc.setProducer("fixture");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    doc.addPage([595.28, 841.89]).drawText(`Halaman ${i + 1}. Total Rp 1.000.000`, { x: 72, y: 760, size: 14, font });
  }
  await draw?.(doc, font);
  return doc;
}

async function scanPdf() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setCreationDate(FIXED_DATE);
  doc.setProducer("Scanner fixture");
  const jpg = await doc.embedJpg(new Uint8Array(readFileSync(join(dir, "photo.jpg"))));
  for (let i = 0; i < 2; i++) {
    doc.addPage([595.28, 841.89]).drawImage(jpg, { x: 0, y: 0, width: 595.28, height: 841.89 });
  }
  return doc.save({ useObjectStreams: true });
}

async function acroformPdf() {
  const doc = await libDoc(2);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.getPage(0);
  const form = doc.getForm();
  const name = form.createTextField("nama");
  name.setText("Budi Santoso");
  name.addToPage(page, { x: 72, y: 700, width: 200, height: 20 });
  const amount = form.createTextField("jumlah");
  amount.setText("Rp 5.000.000");
  amount.addToPage(page, { x: 72, y: 660, width: 200, height: 20 });
  const agree = form.createCheckBox("setuju");
  agree.addToPage(page, { x: 72, y: 620, width: 14, height: 14 });
  agree.check();
  form.updateFieldAppearances(font);
  return doc.save({ useObjectStreams: false });
}

async function treePdf() {
  const doc = await libDoc(2);
  const ctx = doc.context;
  const page = doc.getPage(0);
  page.pushOperators(pushGraphicsState(), popGraphicsState());
  await doc.flush();
  const res = page.node.Resources();
  const fontDict = res.lookup(PDFName.of("Font"));
  fontDict.set(PDFName.of("F1"), fontDict.entries()[0][1]);
  // Nama font tiap halaman digabung ke kamus bersama, lalu Resources halaman dibuang.
  for (const p of doc.getPages()) {
    for (const [key, ref] of p.node.Resources().lookup(PDFName.of("Font")).entries()) fontDict.set(key, ref);
    p.node.delete(PDFName.of("Resources"));
  }
  doc.catalog.Pages().set(PDFName.of("Resources"), res);
  const second = ctx.register(ctx.flateStream("BT /F1 12 Tf 72 650 Td (Isi stream kedua) Tj ET"));
  const contents = page.node.lookup(PDFName.of("Contents"));
  const list = contents instanceof PDFArray ? contents : ctx.obj([page.node.get(PDFName.of("Contents"))]);
  list.push(second);
  page.node.set(PDFName.of("Contents"), ctx.register(list));
  const link = ctx.register(
    ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [72, 640, 200, 660], Border: [0, 0, 0], A: { S: "GoTo", D: [page.ref, "Fit"] } }),
  );
  page.node.set(PDFName.of("Annots"), ctx.obj([link]));
  return doc.save({ useObjectStreams: false });
}

async function pageAaPdf() {
  const doc = await libDoc(2);
  const page = doc.getPage(0);
  page.node.set(PDFName.of("AA"), doc.context.obj({ O: { S: "GoTo", D: [page.ref, "Fit"] } }));
  return doc.save({ useObjectStreams: false });
}

async function inlineAnnotsPdf() {
  const doc = await libDoc(2);
  doc.getPage(0).node.set(
    PDFName.of("Annots"),
    doc.context.obj([
      { Type: "Annot", Subtype: "Link", Rect: [72, 740, 300, 760], Border: [0, 0, 0], A: { S: "URI", URI: PDFString.of("https://example.com/") } },
    ]),
  );
  return doc.save({ useObjectStreams: false });
}

async function blankLastPdf() {
  const doc = await libDoc(1);
  doc.addPage([595.28, 841.89]).node.delete(PDFName.of("Contents"));
  return doc.save({ useObjectStreams: false });
}

/** Meniru keluaran Word: xref klasik + /XRefStm, objek struktur di object stream. */
function wordHybridPdf() {
  const objs = new Map();
  const inStm = new Map();
  const page1 =
    "/P <</MCID 0>> BDC BT /F1 11.04 Tf 1 0 0 1 72.024 769.5 Tm [(P)4(erjanjian K)-3(erja Sama)] TJ ET EMC\r\n" +
    "/Artifact BMC q 0 0 0 RG 72 700 m 523 700 l S Q EMC\r\n" +
    "/P <</MCID 1>> BDC BT /F1 11.04 Tf 1 0 0 1 72.024 680 Tm (Nilai kontrak Rp 125.000.000) Tj ET EMC\r\n";
  const page2 = "/P <</MCID 0>> BDC BT /F1 11.04 Tf 1 0 0 1 72.024 769.5 Tm (Halaman tanda tangan) Tj ET EMC\r\n";
  const res = "/Resources<</Font<</F1 5 0 R>>/ExtGState<</GS7 7 0 R/GS8 8 0 R>>/ProcSet[/PDF/Text/ImageB/ImageC/ImageI] >>";
  const group = "/Group<</Type/Group/S/Transparency/CS/DeviceRGB>>/Tabs/S";
  objs.set(1, enc("<</Type/Catalog/Pages 2 0 R/Lang(id-ID)/StructTreeRoot 20 0 R/MarkInfo<</Marked true>>/Metadata 30 0 R/ViewerPreferences 31 0 R>>"));
  objs.set(2, enc("<</Type/Pages/Count 2/Kids[ 3 0 R 9 0 R] >>"));
  objs.set(3, enc(`<</Type/Page/Parent 2 0 R${res}/Annots[ 12 0 R] /MediaBox[ 0 0 595.32 841.92] /Contents 4 0 R${group}/StructParents 0>>`));
  objs.set(4, flate("", page1));
  objs.set(5, enc("<</Type/Font/Subtype/TrueType/Name/F1/BaseFont/BCDEEE+Calibri/Encoding/WinAnsiEncoding/FontDescriptor 6 0 R/FirstChar 32/LastChar 122/Widths 25 0 R>>"));
  objs.set(6, enc("<</Type/FontDescriptor/FontName/BCDEEE+Calibri/Flags 32/ItalicAngle 0/Ascent 750/Descent -250/CapHeight 750/AvgWidth 521/MaxWidth 1743/FontWeight 400/XHeight 250/StemV 52/FontBBox[ -503 -250 1240 750] >>"));
  objs.set(7, enc("<</Type/ExtGState/BM/Normal/ca 1>>"));
  objs.set(8, enc("<</Type/ExtGState/BM/Normal/CA 1>>"));
  objs.set(9, enc(`<</Type/Page/Parent 2 0 R${res}/MediaBox[ 0 0 595.32 841.92] /Contents 10 0 R${group}/StructParents 2>>`));
  objs.set(10, flate("", page2));
  objs.set(11, enc("<</Author(Penulis)/Creator(Microsoft Word)/CreationDate(D:20261120093000+07'00')/ModDate(D:20261120093000+07'00')/Producer(Microsoft Word)>>"));
  objs.set(12, enc("<</Subtype/Link/Rect[ 72 660 200 676] /BS<</W 0>>/F 4/A<</Type/Action/S/URI/URI(https://example.com/) >>/StructParent 1>>"));
  objs.set(25, enc(`[ ${Array.from({ length: 91 }, (_, i) => 226 + (i % 7) * 30).join(" ")}] `));
  objs.set(30, enc("<</Type/Metadata/Subtype/XML/Length 84>>stream\r\n<?xpacket begin=''?><x:xmpmeta xmlns:x='adobe:ns:meta/'></x:xmpmeta><?xpacket end='w'?>\r\nendstream"));
  objs.set(31, enc("<</DisplayDocTitle true>>"));
  inStm.set(20, "<</Type/StructTreeRoot/RoleMap 21 0 R/ParentTree 22 0 R/K[ 23 0 R] /ParentTreeNextKey 3>>");
  inStm.set(21, "<</Footnote/Note/Endnote/Note/Textbox/Sect/Header/Sect/Footer/Sect/InlineShape/Sect/Annotation/Sect/Artifact/Sect>>");
  inStm.set(22, "<</Nums[ 0[ 24 0 R 24 0 R] 1 26 0 R 2[ 27 0 R] ] >>");
  inStm.set(23, "<</P 20 0 R/S/Part/Type/StructElem/K[ 24 0 R 26 0 R 27 0 R] >>");
  inStm.set(24, "<</P 23 0 R/S/P/Type/StructElem/K[ 0 1] /Pg 3 0 R>>");
  inStm.set(26, "<</P 23 0 R/S/Link/Type/StructElem/K[ <</Type/OBJR/Pg 3 0 R/Obj 12 0 R>>] /Pg 3 0 R>>");
  inStm.set(27, "<</P 23 0 R/S/P/Type/StructElem/K[ 0] /Pg 9 0 R>>");

  const parts = [enc("%PDF-1.7\r\n%\xb5\xb5\xb5\xb5\r\n")];
  let len = parts[0].length;
  const push = (b) => {
    parts.push(b);
    len += b.length;
  };
  const offsets = new Map();
  for (const [n, b] of [...objs].sort((a, b) => a[0] - b[0])) {
    offsets.set(n, len);
    push(Buffer.concat([enc(`${n} 0 obj\r\n`), b, enc("\r\nendobj\r\n")]));
  }
  const stmNum = 32;
  const nums = [...inStm.keys()];
  let header = "";
  let body = "";
  for (const n of nums) {
    header += `${n} ${body.length} `;
    body += `${inStm.get(n)}\r\n`;
  }
  offsets.set(stmNum, len);
  push(Buffer.concat([enc(`${stmNum} 0 obj\r\n`), flate(`/Type/ObjStm/N ${nums.length}/First ${header.length}`, header + body), enc("\r\nendobj\r\n")]));
  const size = 34;
  const xrefStmAt = len;
  const rows = [];
  for (let n = 0; n < size; n++) {
    const r = Buffer.alloc(7);
    if (inStm.has(n)) {
      r[0] = 2;
      r.writeUInt32BE(stmNum, 1);
      r.writeUInt16BE(nums.indexOf(n), 5);
    } else if (offsets.has(n)) {
      r[0] = 1;
      r.writeUInt32BE(offsets.get(n), 1);
    } else if (n === 33) {
      r[0] = 1;
      r.writeUInt32BE(xrefStmAt, 1);
    } else {
      r.writeUInt16BE(n === 0 ? 65535 : 0, 5);
    }
    rows.push(r);
  }
  const id = "<9AF1B2C3D4E5F60718293A4B5C6D7E8F><9AF1B2C3D4E5F60718293A4B5C6D7E8F>";
  const xs = deflateSync(Buffer.concat(rows));
  push(
    Buffer.concat([
      enc(`33 0 obj\r\n<</Type/XRef/Size ${size}/W[ 1 4 2] /Root 1 0 R/Info 11 0 R/ID[${id}]/Filter/FlateDecode/Length ${xs.length}>>stream\r\n`),
      xs,
      enc("\r\nendstream\r\nendobj\r\n"),
    ]),
  );
  // Seperti Word: objek di object stream ditandai bebas di tabel klasik.
  const xrefAt = len;
  let x = `xref\r\n0 ${size}\r\n`;
  for (let n = 0; n < size; n++) {
    if (offsets.has(n)) x += `${pad10(offsets.get(n))} 00000 n\r\n`;
    else if (n === 33) x += `${pad10(xrefStmAt)} 00000 n\r\n`;
    else x += `${pad10(0)} ${n === 0 ? "65535" : "00000"} f\r\n`;
  }
  x += `trailer\r\n<</Size ${size}/Root 1 0 R/Info 11 0 R/ID[${id}] /XRefStm ${xrefStmAt}>>\r\nstartxref\r\n${xrefAt}\r\n%%EOF`;
  push(enc(x));
  return Buffer.concat(parts);
}

/** Linearized: xref halaman pertama di depan (/Prev ke xref utama), startxref terakhir ke sana. */
function linearizedPdf() {
  const bodies = new Map([
    [2, enc("<</Type/Catalog/Pages 3 0 R>>")],
    [4, enc("<</Type/Page/Parent 3 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 6 0 R>>>>/Contents 5 0 R>>")],
    [5, flate("", "BT /F1 12 Tf 72 760 Td (Halaman 1, Rp 10.000.000) Tj ET")],
    [6, enc("<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>")],
    [3, enc("<</Type/Pages/Kids[4 0 R 7 0 R]/Count 2>>")],
    [7, enc("<</Type/Page/Parent 3 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 6 0 R>>>>/Contents 8 0 R>>")],
    [8, flate("", "BT /F1 12 Tf 72 760 Td (Halaman 2) Tj ET")],
    [9, enc("<</Producer(Scanner Firmware 2.1)/CreationDate(D:20261120)>>")],
  ]);
  const trailer = (main) => `trailer\n<</Size 10/Root 2 0 R/Info 9 0 R/ID[<00112233445566778899AABBCCDDEEFF><00112233445566778899AABBCCDDEEFF>]/Prev ${pad10(main)}>>\nstartxref\n0\n%%EOF\n`;
  const build = (fileLen, mainXref, firstEnd) => {
    const head = enc("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");
    const lin = enc(`1 0 obj\n<</Linearized 1/L ${pad10(fileLen)}/O 4/E ${pad10(firstEnd)}/N 2/T ${pad10(mainXref)}/H[${pad10(0)} ${pad10(0)}]>>\nendobj\n`);
    const fpXref = head.length + lin.length;
    const fpLen = enc(`xref\n1 6\n${"0000000000 00000 n\r\n".repeat(6)}${trailer(mainXref)}`).length;
    const offs = new Map([[1, head.length]]);
    let at = fpXref + fpLen;
    let end = 0;
    const chunks = [];
    for (const n of [2, 4, 5, 6, 3, 7, 8, 9]) {
      offs.set(n, at);
      const b = Buffer.concat([enc(`${n} 0 obj\n`), bodies.get(n), enc("\nendobj\n")]);
      chunks.push(b);
      at += b.length;
      if (n === 6) end = at;
    }
    let fp = "xref\n1 6\n";
    for (let n = 1; n <= 6; n++) fp += `${pad10(offs.get(n))} 00000 n\r\n`;
    fp += trailer(mainXref);
    let m = "xref\n0 1\n0000000000 65535 f\r\n7 3\n";
    for (let n = 7; n <= 9; n++) m += `${pad10(offs.get(n))} 00000 n\r\n`;
    m += `trailer\n<</Size 10>>\nstartxref\n${fpXref}\n%%EOF\n`;
    const bytes = Buffer.concat([head, lin, enc(fp), ...chunks, enc(m)]);
    return { bytes, main: at, end };
  };
  let r = build(0, 0, 0);
  for (let i = 0; i < 3; i++) r = build(r.bytes.length, r.main, r.end);
  return r.bytes;
}

function lastStartxref(bytes) {
  const text = bytes.toString("latin1");
  return Number(/startxref\s*(\d+)/.exec(text.slice(text.lastIndexOf("startxref")))[1]);
}
/** Referensi `/Key n g R` terakhir di file (trailer terbaru), sebagai "n g R". */
function refOf(bytes, key) {
  const hits = [...bytes.toString("latin1").matchAll(new RegExp(`/${key}\\s*(\\d+)\\s+(\\d+)\\s+R`, "g"))];
  const last = hits.at(-1);
  if (!last) throw new Error(`/${key} tidak ditemukan`);
  return `${last[1]} ${last[2]} R`;
}
function maxObject(bytes) {
  let max = 0;
  for (const m of bytes.toString("latin1").matchAll(/(\d+)\s+\d+\s+obj\b/g)) max = Math.max(max, Number(m[1]));
  return max;
}

/** Incremental update ber-xref stream yang mengganti kamus Info (simpan ulang Acrobat). */
function withXrefStreamUpdate(orig, infoBody) {
  const info = refOf(orig, "Info").split(" ")[0];
  const at = orig.length + 1;
  const obj = enc(`${info} 0 obj\n${infoBody}\nendobj\n`);
  const xn = maxObject(orig) + 1;
  const xAt = at + obj.length;
  const rows = [];
  for (const [n, o] of [[Number(info), at], [xn, xAt]].sort((a, b) => a[0] - b[0])) {
    const r = Buffer.alloc(6);
    r[0] = 1;
    r.writeUInt32BE(o, 1);
    rows.push({ n, r });
  }
  const data = deflateSync(Buffer.concat(rows.map((x) => x.r)));
  const index = rows.map((x) => `${x.n} 1`).join(" ");
  return Buffer.concat([
    orig,
    enc("\n"),
    obj,
    enc(`${xn} 0 obj\n<</Type/XRef/Size ${xn + 1}/W[1 4 1]/Index[${index}]/Root ${refOf(orig, "Root")}/Info ${info} 0 R/Prev ${lastStartxref(orig)}/Filter/FlateDecode/Length ${data.length}>>stream\n`),
    data,
    enc(`\nendstream\nendobj\nstartxref\n${xAt}\n%%EOF\n`),
  ]);
}

/** Incremental update klasik yang mengganti kamus Info (penampil PDF yang menyimpan metadata). */
function withClassicUpdate(orig, infoBody) {
  const info = refOf(orig, "Info").split(" ")[0];
  const at = orig.length + 1;
  const obj = enc(`${info} 0 obj\n${infoBody}\nendobj\n`);
  const xAt = at + obj.length;
  const x = `xref\n${info} 1\n${pad10(at)} 00000 n\r\ntrailer\n<</Size ${maxObject(orig) + 1}/Root ${refOf(orig, "Root")}/Info ${info} 0 R/Prev ${lastStartxref(orig)}>>\nstartxref\n${xAt}\n%%EOF\n`;
  return Buffer.concat([orig, enc("\n"), obj, enc(x)]);
}

async function writeOriginals() {
  const files = {
    "scan.pdf": await scanPdf(),
    "word-hybrid.pdf": wordHybridPdf(),
    "linearized.pdf": linearizedPdf(),
    "prev-xrefstm.pdf": withXrefStreamUpdate(
      Buffer.from(await (await libDoc(1)).save({ useObjectStreams: true })),
      "<</Title(Diedit di Acrobat)/Producer(Adobe Acrobat)>>",
    ),
    "prev-classic.pdf": withClassicUpdate(
      Buffer.from(await (await libDoc(2)).save({ useObjectStreams: false })),
      "<</Title(Diedit)/Producer(Penampil PDF)>>",
    ),
    "acroform.pdf": await acroformPdf(),
    "tree.pdf": await treePdf(),
    "page-aa.pdf": await pageAaPdf(),
    "inline-annots.pdf": await inlineAnnotsPdf(),
    "blank-last.pdf": await blankLastPdf(),
  };
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
}

// ---------------------------------------------------------------------------
// Stempel dan perubahan isi

const stampOpts = (pageIndex, signerName, signedAt) => ({
  placement: { pageIndex, x: 340, y: 110, width: 160, height: 80 },
  png: signaturePng(),
  signerName,
  signedAt,
  docTag: TAG,
  timeZone: "Asia/Jakarta",
});

const audit = {
  title: "Dokumen uji",
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

async function chain(name, original) {
  const pages = (await PDFDocument.load(original, { updateMetadata: false })).getPageCount();
  const s1 = await stampSignature(original, stampOpts(0, "Rina Wulandari", "2026-11-22T08:04:00Z"));
  const s2 = await stampSignature(s1, stampOpts(pages - 1, "Agus Prasetyo", "2026-11-22T09:30:00Z"));
  const done = await appendAuditPage(s2, audit);
  for (const [prev, next] of [[original, s1], [s1, s2], [s2, done]]) {
    if (!Buffer.from(next).subarray(0, prev.length).equals(Buffer.from(prev))) throw new Error(`${name}: bukan awalan`);
  }
  writeFileSync(join(dir, `${name}.signed.pdf`), done);
  writeFileSync(join(dir, `${name}.signed.txt`), `${[original, s1, s2, done].map((b) => b.length).join(" ")}\n`);
}

/** Stempel halaman 1 dengan `edit(doc)` dijalankan di tengahnya (lihat make-sign-fixtures.mjs). */
async function stampWith(original, edit) {
  const embedPng = PDFDocument.prototype.embedPng;
  PDFDocument.prototype.embedPng = async function (png) {
    await edit(this, (doc, other) => embedPng.call(doc, other));
    return embedPng.call(this, png);
  };
  try {
    return await stampSignature(original, stampOpts(0, "Rina Wulandari", "2026-11-22T08:04:00Z"));
  } finally {
    PDFDocument.prototype.embedPng = embedPng;
  }
}

function contentRefs(page) {
  const contents = page.node.get(PDFName.of("Contents"));
  const resolved = page.node.lookup(PDFName.of("Contents"));
  return resolved instanceof PDFArray ? resolved.asArray() : [contents];
}

function pageImage(doc, page) {
  const xobjects = page.node.Resources().lookup(PDFName.of("XObject"));
  for (const [key, ref] of xobjects.entries()) {
    const obj = doc.context.lookup(ref);
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of("Subtype")) === PDFName.of("Image")) return { key, ref, obj };
  }
  throw new Error("gambar tidak ditemukan");
}

async function tamper(kind, base, edit) {
  const original = readFileSync(join(dir, `${base}.pdf`));
  writeFileSync(join(dir, `tamper-${kind}.${base}.pdf`), await stampWith(original, edit));
}

async function writeTampered() {
  // Satu operator ditambahkan di stream isi lama halaman 1.
  await tamper("content-stream", "tree", (doc) => {
    const ref = contentRefs(doc.getPage(0))[0];
    const stream = doc.context.lookup(ref);
    const text = Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
    doc.context.assign(ref, doc.context.flateStream(`${text}\n1 1 1 rg 72 700 200 40 re f\n`));
  });
  // Halaman terakhir dibuang.
  await tamper("remove-page", "word-hybrid", (doc) => doc.removePage(doc.getPageCount() - 1));
  // Isi gambar JPEG lama diganti.
  await tamper("replace-image", "scan", (doc) => {
    const { ref, obj } = pageImage(doc, doc.getPage(0));
    const bytes = new Uint8Array(obj.contents);
    bytes[bytes.length - 10] ^= 0xff;
    doc.context.assign(ref, PDFRawStream.of(obj.dict, bytes));
  });
  // Nama gambar lama dialihkan ke gambar baru.
  await tamper("remap-image", "scan", async (doc) => {
    const { key } = pageImage(doc, doc.getPage(0));
    const other = await doc.embedJpg(new Uint8Array(readFileSync(join(dir, "photo.jpg"))));
    await other.embed();
    doc.getPage(0).node.Resources().lookup(PDFName.of("XObject")).set(key, other.ref);
  });
  // Nilai isian formulir diganti.
  await tamper("form-value", "acroform", (doc) => {
    doc.getForm().getTextField("jumlah").setText("Rp 9.000.000");
  });
  // MediaBox halaman 1 dipersempit.
  await tamper("mediabox", "word-hybrid", (doc) => doc.getPage(0).setMediaBox(0, 0, 300, 300));
  // Alamat tautan URI yang sudah ada diganti.
  await tamper("annot-uri", "inline-annots", (doc) => {
    const annots = doc.getPage(0).node.lookup(PDFName.of("Annots"));
    annots.lookup(0).lookup(PDFName.of("A")).set(PDFName.of("URI"), PDFString.of("https://contoh.invalid/"));
  });
  // Aksi /AA halaman yang sudah ada diganti dengan JavaScript.
  await tamper("page-aa", "page-aa", (doc) => {
    doc.getPage(0).node.set(PDFName.of("AA"), doc.context.obj({ O: { S: "JavaScript", JS: PDFString.of("app.alert(1)") } }));
  });
}

if (process.argv.includes("--originals")) await writeOriginals();
const originals = readdirSync(dir).filter((f) => f.endsWith(".pdf") && !f.includes(".signed") && !f.startsWith("tamper-"));
for (const file of originals) await chain(file.replace(/\.pdf$/, ""), readFileSync(join(dir, file)));
await writeTampered();
console.log(`Fixture di ${dir}:\n  ${readdirSync(dir).join("\n  ")}`);
