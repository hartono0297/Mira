#!/usr/bin/env node
// Membuat latest.json statis untuk updater Tauri (dibaca Mira lewat
// https://github.com/hartono0297/Mira/releases/latest/download/latest.json).
//
// Pemakaian:
//   node scripts/release/make-latest-json.mjs \
//     --version 0.3.0 \
//     --notes src/whats-new/0.3.0.md \
//     --base-url https://github.com/hartono0297/Mira/releases/download/v0.3.0/ \
//     --windows-asset Mira_0.3.0_x64-setup.exe --windows-sig out/Mira_0.3.0_x64-setup.exe.sig \
//     --macos-asset Mira_0.3.0_universal.app.tar.gz --macos-sig out/Mira_0.3.0_universal.app.tar.gz.sig \
//     --out out/latest.json [--pub-date 2026-11-23T00:00:00Z]
//
// --base-url boleh dikosongkan: bawaan https://github.com/hartono0297/Mira/releases/download/v<versi>/.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const DEFAULT_REPO = 'https://github.com/hartono0297/Mira';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export class ReleaseInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReleaseInputError';
  }
}

export function normalizeVersion(version) {
  const v = String(version ?? '').trim().replace(/^v/, '');
  if (!SEMVER.test(v)) throw new ReleaseInputError(`Versi tidak valid: "${version}".`);
  return v;
}

export function defaultBaseUrl(version) {
  return `${DEFAULT_REPO}/releases/download/v${normalizeVersion(version)}/`;
}

/** RFC 3339 UTC tanpa milidetik, misalnya 2026-11-23T08:00:00Z. */
export function toRfc3339(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new ReleaseInputError(`Tanggal tidak valid: "${date}".`);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function assetUrl(baseUrl, asset) {
  if (!asset || /[\/\\]/.test(asset)) throw new ReleaseInputError(`Nama aset tidak valid: "${asset}".`);
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return base + encodeURIComponent(asset);
}

function requireText(value, what) {
  const t = typeof value === 'string' ? value.trim() : '';
  if (!t) throw new ReleaseInputError(`${what} kosong.`);
  return t;
}

/**
 * Fungsi murni: menyusun objek latest.json.
 * @param {{ version: string, notes: string, pubDate: Date | string, baseUrl?: string,
 *   windows: { asset: string, signature: string }, macos: { asset: string, signature: string } }} input
 */
export function buildLatestJson({ version, notes, pubDate, baseUrl, windows, macos }) {
  const v = normalizeVersion(version);
  const base = baseUrl || defaultBaseUrl(v);
  if (!/^https:\/\//.test(base)) throw new ReleaseInputError(`URL dasar harus https: "${base}".`);
  const win = {
    signature: requireText(windows?.signature, 'Signature Windows'),
    url: assetUrl(base, windows?.asset),
  };
  const mac = {
    signature: requireText(macos?.signature, 'Signature macOS'),
    url: assetUrl(base, macos?.asset),
  };
  return {
    version: v,
    notes: requireText(notes, 'Catatan rilis'),
    pub_date: toRfc3339(pubDate),
    platforms: {
      'windows-x86_64': win,
      // Bundel universal: kedua arsitektur Mac memakai berkas yang sama.
      'darwin-aarch64': { ...mac },
      'darwin-x86_64': { ...mac },
    },
  };
}

function readRequired(path, what) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ReleaseInputError(`${what} tidak bisa dibaca: ${path} (${e.code ?? e.message}).`);
  }
  if (!text.trim()) throw new ReleaseInputError(`${what} kosong: ${path}.`);
  return text;
}

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new ReleaseInputError(`Argumen tidak dikenal: ${a}`);
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) throw new ReleaseInputError(`${a} butuh nilai.`);
    out[a.slice(2)] = v;
  }
  return out;
}

const REQUIRED = ['version', 'notes', 'windows-asset', 'windows-sig', 'macos-asset', 'macos-sig', 'out'];

/** Membaca berkas dari argumen CLI lalu menulis latest.json. Mengembalikan objeknya. */
export function run(argv) {
  const args = parseArgs(argv);
  const missing = REQUIRED.filter((k) => !args[k]);
  if (missing.length) throw new ReleaseInputError(`Argumen wajib belum diisi: ${missing.map((k) => `--${k}`).join(', ')}.`);
  const json = buildLatestJson({
    version: args.version,
    notes: readRequired(args.notes, 'Berkas catatan rilis'),
    pubDate: args['pub-date'] ?? new Date(),
    baseUrl: args['base-url'],
    windows: { asset: args['windows-asset'], signature: readRequired(args['windows-sig'], 'Signature Windows') },
    macos: { asset: args['macos-asset'], signature: readRequired(args['macos-sig'], 'Signature macOS') },
  });
  writeFileSync(args.out, `${JSON.stringify(json, null, 2)}\n`);
  return json;
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  try {
    const json = run(process.argv.slice(2));
    console.log(`latest.json untuk ${json.version}: ${Object.keys(json.platforms).join(', ')}`);
  } catch (e) {
    console.error(`GAGAL: ${e.message}`);
    process.exit(1);
  }
}
