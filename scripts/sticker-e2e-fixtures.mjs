// Gambar uji untuk scripts/sticker-e2e.mjs: PNG dan GIF animasi kecil yang byte-nya
// disusun sendiri (tanpa pustaka gambar), supaya uji tidak bergantung pada file di repo.
//
// - pngSticker(size, color, accent): PNG RGBA 8 bit, lingkaran berwarna dengan garis
//   tengah, latar transparan.
// - gifSticker(size, colors, frames): GIF89a animasi berulang (blok NETSCAPE2.0),
//   satu kotak berpindah posisi tiap frame, data gambar dikodekan LZW sungguhan.
//
// Dipakai langsung untuk memeriksa hasilnya:
//   node scripts/sticker-e2e-fixtures.mjs <folder keluaran>
// menulis kopi.png, siap.gif, dan halo.gif ke folder itu.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

// ---------- PNG ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// color dan accent: [r, g, b].
export function pngSticker(size = 128, color = [140, 90, 50], accent = [250, 240, 225]) {
  const rows = [];
  const mid = (size - 1) / 2;
  const r = size * 0.45;
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4); // byte pertama: filter 0 (None)
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - mid, y - mid);
      let px = [0, 0, 0, 0];
      if (d <= r) {
        const stripe = Math.abs(y - mid) < size * 0.06 && Math.abs(x - mid) < r * 0.7;
        px = stripe ? [...accent, 255] : [...color, 255];
      }
      row.set(px, 1 + x * 4);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // kedalaman bit
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // kompresi
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // tanpa interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- GIF ----------

// Pengodean LZW GIF (ukuran kode berubah, kode clear saat tabel penuh).
function lzwEncode(minCodeSize, indices) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let dict = new Map();
  const out = [];
  let acc = 0;
  let bits = 0;
  const emit = (code) => {
    acc |= code << bits;
    bits += codeSize;
    while (bits >= 8) {
      out.push(acc & 0xff);
      acc >>>= 8;
      bits -= 8;
    }
  };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 4096 + k;
    const hit = dict.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    emit(prefix);
    if (next === 4096) {
      emit(clear);
      dict = new Map();
      codeSize = minCodeSize + 1;
      next = eoi + 1;
    } else {
      if (next >= 1 << codeSize) codeSize++;
      dict.set(key, next++);
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (bits > 0) out.push(acc & 0xff);
  return Buffer.from(out);
}

function subBlocks(data) {
  const parts = [];
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.subarray(i, i + 255);
    parts.push(Buffer.from([chunk.length]), chunk);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

const u16 = (n) => Buffer.from([n & 0xff, (n >> 8) & 0xff]);

// colors: empat warna [r, g, b]; indeks 0 transparan (latar), 1 badan, 2 kotak, 3 garis.
export function gifSticker(
  size = 96,
  colors = [
    [255, 255, 255],
    [60, 130, 90],
    [250, 210, 80],
    [30, 60, 40],
  ],
  frames = 3,
) {
  const parts = [
    Buffer.from("GIF89a", "ascii"),
    u16(size),
    u16(size),
    // Tabel warna global ada, resolusi warna 8 bit, 4 entri (2^(1+1)).
    Buffer.from([0xf1, 0, 0]),
    Buffer.from(colors.flat()),
    // Ulang terus.
    Buffer.from([0x21, 0xff, 0x0b]),
    Buffer.from("NETSCAPE2.0", "ascii"),
    Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]),
  ];
  const mid = (size - 1) / 2;
  const box = Math.max(4, Math.round(size / 5));
  for (let f = 0; f < frames; f++) {
    const idx = new Uint8Array(size * size);
    const bx = Math.round(size * 0.2 + f * ((size * 0.6 - box) / Math.max(1, frames - 1)));
    const by = Math.round(mid - box / 2);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let c = 0;
        if (Math.hypot(x - mid, y - mid) <= size * 0.45) c = 1;
        if (x >= bx && x < bx + box && y >= by && y < by + box) c = 2;
        if (c === 1 && Math.abs(y - (size * 0.75)) < 2) c = 3;
        idx[y * size + x] = c;
      }
    }
    parts.push(
      // Graphic Control Extension: disposal 2 (kembalikan ke latar), transparan indeks 0, jeda 0,4 dtk.
      Buffer.from([0x21, 0xf9, 0x04, 0x09]),
      u16(40),
      Buffer.from([0x00, 0x00]),
      // Image Descriptor: seluruh kanvas, tanpa tabel warna lokal.
      Buffer.from([0x2c]),
      u16(0),
      u16(0),
      u16(size),
      u16(size),
      Buffer.from([0x00]),
      Buffer.from([0x02]), // ukuran kode LZW minimum
      subBlocks(lzwEncode(2, idx)),
    );
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

// Gambar yang dipakai skrip e2e. Warna berbeda supaya mudah dibedakan di screenshot.
export const FIXTURES = {
  kopi: { mime: "image/png", bytes: () => pngSticker(128, [120, 72, 40], [245, 230, 210]) },
  siap: {
    mime: "image/gif",
    bytes: () =>
      gifSticker(96, [
        [255, 255, 255],
        [46, 125, 80],
        [250, 205, 70],
        [20, 60, 35],
      ]),
  },
  halo: {
    mime: "image/gif",
    bytes: () =>
      gifSticker(
        96,
        [
          [255, 255, 255],
          [50, 100, 190],
          [255, 255, 255],
          [20, 40, 90],
        ],
        4,
      ),
  },
};

// Dijalankan langsung: tulis semua gambar uji ke folder keluaran.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = resolve(process.argv[2] ?? "sticker-fixtures");
  mkdirSync(out, { recursive: true });
  for (const [name, f] of Object.entries(FIXTURES)) {
    const ext = f.mime === "image/png" ? "png" : "gif";
    const file = join(out, `${name}.${ext}`);
    const bytes = f.bytes();
    writeFileSync(file, bytes);
    console.log(`${file}  ${bytes.length} byte`);
  }
}
