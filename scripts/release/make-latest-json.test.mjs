import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildLatestJson, run, toRfc3339, ReleaseInputError } from './make-latest-json.mjs';

const script = fileURLToPath(new URL('./make-latest-json.mjs', import.meta.url));

const input = () => ({
  version: '0.3.0',
  notes: '\n# Yang baru\n\n- Pembaruan dari dalam aplikasi\n\n',
  pubDate: new Date('2026-11-23T08:15:30.123Z'),
  windows: { asset: 'Mira_0.3.0_x64-setup.exe', signature: 'c2lnLXdpbg==\n' },
  macos: { asset: 'Mira_0.3.0_universal.app.tar.gz', signature: 'c2lnLW1hYw==' },
});

test('latest.json berbentuk sesuai format statis Tauri', () => {
  const base = 'https://github.com/hartono0297/Mira/releases/download/v0.3.0/';
  const mac = { signature: 'c2lnLW1hYw==', url: `${base}Mira_0.3.0_universal.app.tar.gz` };
  assert.deepEqual(buildLatestJson(input()), {
    version: '0.3.0',
    notes: '# Yang baru\n\n- Pembaruan dari dalam aplikasi',
    pub_date: '2026-11-23T08:15:30Z',
    platforms: {
      'windows-x86_64': { signature: 'c2lnLXdpbg==', url: `${base}Mira_0.3.0_x64-setup.exe` },
      'darwin-aarch64': mac,
      'darwin-x86_64': mac,
    },
  });
});

test('awalan v dibuang, URL dasar bisa diganti', () => {
  const j = buildLatestJson({ ...input(), version: 'v0.3.0', baseUrl: 'https://contoh.test/rilis' });
  assert.equal(j.version, '0.3.0');
  assert.equal(j.platforms['windows-x86_64'].url, 'https://contoh.test/rilis/Mira_0.3.0_x64-setup.exe');
});

test('input tidak valid ditolak', () => {
  assert.throws(() => buildLatestJson({ ...input(), version: '0.3' }), ReleaseInputError);
  assert.throws(() => buildLatestJson({ ...input(), notes: '  \n' }), /Catatan rilis kosong/);
  assert.throws(() => buildLatestJson({ ...input(), windows: { asset: 'a.exe', signature: '' } }), /Signature Windows kosong/);
  assert.throws(() => buildLatestJson({ ...input(), macos: { asset: '../x', signature: 'x' } }), /Nama aset/);
  assert.throws(() => buildLatestJson({ ...input(), baseUrl: 'http://contoh.test/' }), /https/);
  assert.throws(() => toRfc3339('bukan tanggal'), /Tanggal tidak valid/);
});

function withFiles(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mira-latest-'));
  const p = (n) => join(dir, n);
  writeFileSync(p('0.3.0.md'), '# Yang baru di Mira 0.3.0\n\nCek pembaruan.\n');
  writeFileSync(p('win.sig'), 'c2lnLXdpbg==');
  writeFileSync(p('mac.sig'), 'c2lnLW1hYw==\n');
  const args = (over = {}) => {
    const a = {
      version: '0.3.0', notes: p('0.3.0.md'),
      'windows-asset': 'Mira_0.3.0_x64-setup.exe', 'windows-sig': p('win.sig'),
      'macos-asset': 'Mira_0.3.0_universal.app.tar.gz', 'macos-sig': p('mac.sig'),
      out: p('latest.json'), 'pub-date': '2026-11-23T08:00:00Z', ...over,
    };
    return Object.entries(a).filter(([, v]) => v !== undefined).flatMap(([k, v]) => [`--${k}`, v]);
  };
  try {
    fn({ p, args });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('run menulis berkas dari .sig dan catatan', () => {
  withFiles(({ p, args }) => {
    run(args());
    const j = JSON.parse(readFileSync(p('latest.json'), 'utf8'));
    assert.equal(j.notes, '# Yang baru di Mira 0.3.0\n\nCek pembaruan.');
    assert.equal(j.pub_date, '2026-11-23T08:00:00Z');
    assert.equal(j.platforms['darwin-x86_64'].signature, 'c2lnLW1hYw==');
  });
});

test('pub_date bawaan adalah waktu sekarang dalam RFC 3339 UTC', () => {
  withFiles(({ args }) => {
    const j = run(args({ 'pub-date': undefined }));
    assert.match(j.pub_date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.ok(Math.abs(Date.parse(j.pub_date) - Date.now()) < 60_000);
  });
});

test('berkas .sig atau catatan yang hilang atau kosong membuat gagal', () => {
  withFiles(({ p, args }) => {
    assert.throws(() => run(args({ 'windows-sig': p('tidak-ada.sig') })), /Signature Windows tidak bisa dibaca/);
    writeFileSync(p('kosong.sig'), '\n');
    assert.throws(() => run(args({ 'macos-sig': p('kosong.sig') })), /Signature macOS kosong/);
    assert.throws(() => run(args({ notes: p('0.9.9.md') })), /catatan rilis tidak bisa dibaca/);
    writeFileSync(p('kosong.md'), '   ');
    assert.throws(() => run(args({ notes: p('kosong.md') })), /catatan rilis kosong/);
    assert.throws(() => run(args({ 'macos-asset': undefined })), /--macos-asset/);
  });
});

test('CLI keluar dengan kode 1 dan pesan GAGAL', () => {
  withFiles(({ p, args }) => {
    const ok = spawnSync(process.execPath, [script, ...args()], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    const bad = spawnSync(process.execPath, [script, ...args({ notes: p('tidak-ada.md') })], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /^GAGAL: Berkas catatan rilis tidak bisa dibaca/);
  });
});
