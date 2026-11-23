#!/usr/bin/env node
// Memeriksa berkas .sig updater Tauri terhadap public key Tauri dan berkasnya.
//
// Format (minisign, dibungkus base64 oleh Tauri):
//   pubkey  = base64("untrusted comment: ...\n" + base64(alg[2] | keyId[8] | pk[32]) + "\n")
//   .sig    = base64("untrusted comment: ...\n" + base64(alg[2] | keyId[8] | sig[64]) + "\n"
//                    + "trusted comment: <teks>\n" + base64(globalSig[64]) + "\n")
// alg "ED": sig = Ed25519(BLAKE2b-512(berkas)), yang dibuat Tauri.
// alg "Ed": sig = Ed25519(berkas), format minisign lama.
// globalSig = Ed25519(sig[64] | <teks komentar tepercaya>).
//
// Pemakaian:
//   node scripts/release/verify-updater-sig.mjs --pubkey <base64 | @berkas> --sig <berkas.sig> --file <artefak>
//        [--expect-version <versi>]
// --expect-version mewajibkan komentar tepercaya berisi "version:<versi>" (diisi otomatis oleh tauri build).

import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Awalan DER SubjectPublicKeyInfo untuk kunci Ed25519 mentah 32 byte.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const TRUSTED_PREFIX = 'trusted comment: ';

export class SigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SigError';
  }
}

/** Isi teks minisign dari string Tauri (base64) atau teks minisign mentah. */
function unwrapMinisignText(input, what) {
  const s = String(input).trim();
  if (s.startsWith('untrusted comment:')) return s;
  const text = Buffer.from(s, 'base64').toString('utf8');
  if (!text.startsWith('untrusted comment:')) {
    throw new SigError(`${what} bukan format minisign/Tauri (tidak diawali "untrusted comment:" setelah decode base64).`);
  }
  return text;
}

function decodeStrictBase64(line, expectedLen, what) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(line)) throw new SigError(`${what}: base64 tidak valid.`);
  const buf = Buffer.from(line, 'base64');
  if (buf.length !== expectedLen) {
    throw new SigError(`${what}: panjang ${buf.length} byte, seharusnya ${expectedLen}.`);
  }
  return buf;
}

/** @returns {{ keyId: Buffer, publicKey: Buffer }} */
export function parsePublicKey(pubkey) {
  const lines = unwrapMinisignText(pubkey, 'Public key').split(/\r?\n/);
  if (lines.length < 2) throw new SigError('Public key: kurang dari dua baris.');
  const raw = decodeStrictBase64(lines[1].trim(), 42, 'Public key');
  const alg = raw.subarray(0, 2).toString('latin1');
  if (alg !== 'Ed') throw new SigError(`Public key: algoritma "${alg}" tidak dikenal (harus "Ed").`);
  return { keyId: raw.subarray(2, 10), publicKey: raw.subarray(10, 42) };
}

/** @returns {{ algorithm: 'ED' | 'Ed', keyId: Buffer, signature: Buffer, trustedComment: string, globalSignature: Buffer }} */
export function parseSignature(sig) {
  const lines = unwrapMinisignText(sig, 'Signature').split(/\r?\n/);
  if (lines.length < 4) throw new SigError('Signature: kurang dari empat baris.');
  const raw = decodeStrictBase64(lines[1].trim(), 74, 'Signature');
  const algorithm = raw.subarray(0, 2).toString('latin1');
  if (algorithm !== 'ED' && algorithm !== 'Ed') {
    throw new SigError(`Signature: algoritma "${algorithm}" tidak dikenal (harus "ED" atau "Ed").`);
  }
  if (!lines[2].startsWith(TRUSTED_PREFIX)) {
    throw new SigError('Signature: baris ketiga harus diawali "trusted comment: ".');
  }
  return {
    algorithm,
    keyId: raw.subarray(2, 10),
    signature: raw.subarray(10, 74),
    trustedComment: lines[2].slice(TRUSTED_PREFIX.length),
    globalSignature: decodeStrictBase64(lines[3].trim(), 64, 'Tanda tangan global'),
  };
}

function ed25519Key(raw32) {
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw32]), format: 'der', type: 'spki' });
}

const hexId = (buf) => Buffer.from(buf).reverse().toString('hex').toUpperCase();

/**
 * Memeriksa tanda tangan. Melempar SigError kalau tidak cocok.
 * @param {{ pubkey: string, sig: string, data: Buffer | Uint8Array, expectVersion?: string }} args
 * @returns {{ algorithm: string, keyId: string, trustedComment: string }}
 */
export function verifyUpdaterSignature({ pubkey, sig, data, expectVersion }) {
  const pk = parsePublicKey(pubkey);
  const s = parseSignature(sig);
  if (!pk.keyId.equals(s.keyId)) {
    throw new SigError(`ID kunci tidak cocok: signature dari ${hexId(s.keyId)}, public key ${hexId(pk.keyId)}.`);
  }
  const key = ed25519Key(pk.publicKey);
  const message = s.algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : Buffer.from(data);
  if (!verify(null, message, key, s.signature)) {
    throw new SigError('Tanda tangan berkas tidak cocok (berkas berubah atau kunci lain).');
  }
  const globalMessage = Buffer.concat([s.signature, Buffer.from(s.trustedComment, 'utf8')]);
  if (!verify(null, globalMessage, key, s.globalSignature)) {
    throw new SigError('Tanda tangan komentar tepercaya tidak cocok.');
  }
  if (expectVersion !== undefined) {
    const pairs = s.trustedComment.split('\t').map((f) => {
      const i = f.indexOf(':');
      return i < 0 ? [f, ''] : [f.slice(0, i), f.slice(i + 1)];
    });
    // Updater membaca kunci pertama, skrip ini kunci terakhir: kunci ganda ditolak supaya tidak ambigu.
    if (pairs.filter(([k]) => k === 'version').length > 1) {
      throw new SigError('Komentar tepercaya memuat lebih dari satu kolom version.');
    }
    const fields = Object.fromEntries(pairs);
    if (fields.version !== expectVersion) {
      throw new SigError(
        `Versi di komentar tepercaya ${fields.version === undefined ? 'tidak ada' : `"${fields.version}"`}, seharusnya "${expectVersion}".`,
      );
    }
  }
  return { algorithm: s.algorithm, keyId: hexId(pk.keyId), trustedComment: s.trustedComment };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new SigError(`Argumen tidak dikenal: ${a}`);
    const v = argv[++i];
    if (v === undefined) throw new SigError(`${a} butuh nilai.`);
    out[a.slice(2)] = v;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const k of ['pubkey', 'sig', 'file']) {
    if (!args[k]) throw new SigError(`--${k} wajib diisi.`);
  }
  const pubkey = args.pubkey.startsWith('@') ? readFileSync(args.pubkey.slice(1), 'utf8') : args.pubkey;
  if (!pubkey.trim()) throw new SigError('Public key kosong.');
  const sig = readFileSync(args.sig, 'utf8');
  if (!sig.trim()) throw new SigError(`Berkas signature kosong: ${args.sig}`);
  const data = readFileSync(args.file);
  const r = verifyUpdaterSignature({ pubkey, sig, data, expectVersion: args['expect-version'] });
  console.log(`OK ${basename(args.file)}: kunci ${r.keyId}, alg ${r.algorithm}, "${r.trustedComment}"`);
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  try {
    main();
  } catch (e) {
    console.error(`GAGAL: ${e.message}`);
    process.exit(1);
  }
}
