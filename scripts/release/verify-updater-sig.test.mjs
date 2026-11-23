import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyUpdaterSignature, parsePublicKey, SigError } from './verify-updater-sig.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const fixture = (name) => join(here, 'fixtures', name);
const b64 = (s) => Buffer.from(s).toString('base64');

// Fixture asli dari `tauri signer sign --app-version 0.3.0` dengan kunci sekali pakai (kunci privatnya sudah dihapus).
const tauriPub = readFileSync(fixture('tauri.pub'), 'utf8');
const tauriSig = readFileSync(fixture('artefak.txt.sig'), 'utf8');
const tauriData = readFileSync(fixture('artefak.txt'));

/** Pasangan kunci minisign buatan tes, dibungkus base64 seperti Tauri. */
function makeKey(keyId = randomBytes(8)) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  const line = Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64');
  return { privateKey, keyId, pubkey: b64(`untrusted comment: minisign public key: tes\n${line}\n`) };
}

function makeSig(key, data, { alg = 'ED', trusted = 'timestamp:1\tfile:x\tversion:0.3.0', keyId = key.keyId } = {}) {
  const msg = alg === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  const sig = sign(null, msg, key.privateKey);
  const global = sign(null, Buffer.concat([sig, Buffer.from(trusted)]), key.privateKey);
  const line = Buffer.concat([Buffer.from(alg), keyId, sig]).toString('base64');
  return b64(
    `untrusted comment: signature from tauri secret key\n${line}\ntrusted comment: ${trusted}\n${global.toString('base64')}\n`,
  );
}

const data = Buffer.from('installer palsu untuk tes');

test('tanda tangan asli dari tauri signer cocok', () => {
  const r = verifyUpdaterSignature({ pubkey: tauriPub, sig: tauriSig, data: tauriData, expectVersion: '0.3.0' });
  assert.equal(r.algorithm, 'ED');
  assert.equal(r.keyId, 'ECB48840B6051447');
  assert.match(r.trustedComment, /version:0\.3\.0/);
});

test('berkas Tauri yang diubah satu byte ditolak', () => {
  const tampered = Buffer.from(tauriData);
  tampered[0] ^= 1;
  assert.throws(() => verifyUpdaterSignature({ pubkey: tauriPub, sig: tauriSig, data: tampered }), /tidak cocok/);
});

test('versi tepercaya yang berbeda ditolak', () => {
  assert.throws(
    () => verifyUpdaterSignature({ pubkey: tauriPub, sig: tauriSig, data: tauriData, expectVersion: '0.4.0' }),
    /seharusnya "0\.4\.0"/,
  );
});

test('signature ED (prehash) dan Ed (lama) buatan tes cocok', () => {
  const key = makeKey();
  for (const alg of ['ED', 'Ed']) {
    const r = verifyUpdaterSignature({ pubkey: key.pubkey, sig: makeSig(key, data, { alg }), data });
    assert.equal(r.algorithm, alg);
  }
});

test('berkas yang diubah gagal', () => {
  const key = makeKey();
  const sig = makeSig(key, data);
  assert.throws(
    () => verifyUpdaterSignature({ pubkey: key.pubkey, sig, data: Buffer.from('installer palsu untuk tex') }),
    (e) => e instanceof SigError && /berkas tidak cocok/.test(e.message),
  );
});

test('kunci lain dengan ID kunci sama gagal di Ed25519', () => {
  const signer = makeKey();
  const other = makeKey(signer.keyId);
  assert.throws(
    () => verifyUpdaterSignature({ pubkey: other.pubkey, sig: makeSig(signer, data), data }),
    /berkas tidak cocok/,
  );
});

test('ID kunci berbeda ditolak sebelum memeriksa tanda tangan', () => {
  const signer = makeKey();
  const other = makeKey();
  assert.throws(() => verifyUpdaterSignature({ pubkey: other.pubkey, sig: makeSig(signer, data), data }), /ID kunci tidak cocok/);
  assert.throws(() => verifyUpdaterSignature({ pubkey: tauriPub, sig: makeSig(signer, data), data }), /ID kunci tidak cocok/);
});

test('komentar tepercaya yang diubah gagal di tanda tangan global', () => {
  const key = makeKey();
  const text = Buffer.from(makeSig(key, data), 'base64').toString().replace('version:0.3.0', 'version:9.9.9');
  assert.throws(() => verifyUpdaterSignature({ pubkey: key.pubkey, sig: b64(text), data }), /komentar tepercaya/);
});

test('input rusak memberi pesan jelas', () => {
  const key = makeKey();
  assert.throws(() => parsePublicKey('BELUM-DIISI'), SigError);
  assert.throws(() => verifyUpdaterSignature({ pubkey: key.pubkey, sig: b64('halo'), data }), /bukan format minisign/);
  const bad = Buffer.from(makeSig(key, data), 'base64').toString().replace(/\n([A-Za-z0-9+/=]+)\ntrusted/, '\nRVo=\ntrusted');
  assert.throws(() => verifyUpdaterSignature({ pubkey: key.pubkey, sig: b64(bad), data }), /panjang/);
  // Teks minisign mentah (tanpa bungkus base64 Tauri) juga diterima.
  const rawPub = Buffer.from(key.pubkey, 'base64').toString();
  const rawSig = Buffer.from(makeSig(key, data), 'base64').toString();
  assert.equal(verifyUpdaterSignature({ pubkey: rawPub, sig: rawSig, data }).algorithm, 'ED');
});

test('CLI: kode keluar 0 untuk cocok, 1 untuk tidak cocok', () => {
  const script = join(here, 'verify-updater-sig.mjs');
  const ok = spawnSync(process.execPath, [script, '--pubkey', `@${fixture('tauri.pub')}`, '--sig', fixture('artefak.txt.sig'), '--file', fixture('artefak.txt'), '--expect-version', '0.3.0'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^OK artefak\.txt/);

  const dir = mkdtempSync(join(tmpdir(), 'mira-sig-'));
  try {
    const f = join(dir, 'artefak.txt');
    writeFileSync(f, 'isi lain');
    const bad = spawnSync(process.execPath, [script, '--pubkey', tauriPub, '--sig', fixture('artefak.txt.sig'), '--file', f], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /GAGAL: Tanda tangan berkas tidak cocok/);

    const missing = spawnSync(process.execPath, [script, '--pubkey', tauriPub, '--file', f], { encoding: 'utf8' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /--sig wajib/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('komentar tepercaya dengan dua kolom version ditolak', () => {
  const key = makeKey();
  const sig = makeSig(key, data, { trusted: 'timestamp:1\tversion:0.2.0\tversion:0.3.0' });
  assert.throws(
    () => verifyUpdaterSignature({ pubkey: key.pubkey, sig, data, expectVersion: '0.3.0' }),
    /lebih dari satu kolom version/,
  );
});
