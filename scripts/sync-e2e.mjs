// Uji ujung ke ujung sinkron dokumen dan tanda tangan antar tiga "laptop"
// Mira di satu PC, lewat transport jaringan sungguhan (QUIC di 127.0.0.1,
// penemuan mDNS). Tidak ada jembatan uji dan tidak ada command debug.
//
// Tiga instance mira.exe hasil build release berjalan dengan folder data
// (MIRA_DATA_DIR), port QUIC (MIRA_PORT), dan port debug WebView2 sendiri,
// lalu dikendalikan lewat Chrome DevTools Protocol. Organisasi disiapkan lewat
// command Tauri (seperti e2e-fitur-multi.mjs). Sinkron berjalan saat ada
// perubahan, ditambah cadangan berkala 60 detik, jadi batas tunggu longgar.
//
//   A  Ayu Uji    superadmin, anggota Tim Proyek
//   B  Budi Uji   Anggota Tim Proyek
//   C  Citra Uji  Anggota Tim Lain; dikeluarkan dari organisasi di akhir uji
//
// "Offline" = instance rekan dimatikan: bentrok dibuat dengan mematikan B dan
// C, A mengedit, A dimatikan, B dinyalakan dan mengedit sendirian, lalu A
// dinyalakan lagi.
//
// Pakai:  node scripts/sync-e2e.mjs <path mira.exe> <folder screenshot>
// Build dulu: npx tauri build --no-bundle
// Butuh:  playwright-core, pdf-lib. MIRA_E2E_KEEP=1 menyimpan folder sementara.

import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { PDFDocument, PDFName, StandardFonts, rgb } from "pdf-lib";

const exe = resolve(process.argv[2] ?? "src-tauri/target/release/mira.exe");
const shots = resolve(process.argv[3] ?? "docs/progress/screenshots/sinkron");
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(shots, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "mira-sinkron-"));

const XLSX = "RAB-proyek-a.xlsx";
const XLSX_SRC = join(repo, "test-files", "docs", XLSX);
const BIG = "gambar-kerja-proyek.zip";
const BIG_SIZE = 21 * 1024 * 1024; // di atas batas salin otomatis 20 MB
const AFTER_REMOVAL = "notulen-setelah-citra-keluar.txt";
const PDF_TITLE = "kontrak-sinkron";
const pdfPath = join(root, `${PDF_TITLE}.pdf`);
const PIN = "246810";

// Port sendiri (bukan 4786x/936x milik e2e-fitur-multi.mjs), supaya tidak
// bentrok dengan uji lain yang mungkin berjalan di PC yang sama.
const NODES = {
  A: { name: "Ayu Uji", port: 47871, cdp: 9371, dir: join(root, "laptop-a") },
  B: { name: "Budi Uji", port: 47872, cdp: 9372, dir: join(root, "laptop-b") },
  C: { name: "Citra Uji", port: 47873, cdp: 9373, dir: join(root, "laptop-c") },
};
const addr = (id) => `127.0.0.1:${NODES[id].port}`;
// Satu putaran sinkron cadangan (60 dtk) ditambah sedikit jeda.
const FULL_ROUND_MS = 70000;
const SYNC_MS = 150000;
const pk = {};

function miraCredentials() {
  try {
    const out = execFileSync("cmdkey", ["/list"], { encoding: "utf8" });
    return new Set(out.match(/device-key-[0-9a-f]{64}\.id\.mira\.desktop/g) ?? []);
  } catch {
    return new Set();
  }
}
const credentialsBefore = miraCredentials();

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "LULUS" : "GAGAL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const note = (msg) => console.log(`CATATAN  ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (v) => (typeof v === "string" ? v : JSON.stringify(v))?.slice(0, 300);
const secs = (since) => `${Math.round((Date.now() - since) / 1000)} dtk`;

// ---------------------------------------------------------------------------
// Instance

const running = {};

async function launch(id) {
  const node = NODES[id];
  mkdirSync(node.dir, { recursive: true });
  const log = createWriteStream(join(root, `${id}-stderr.log`), { flags: "a" });
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      MIRA_DATA_DIR: node.dir,
      MIRA_PORT: String(node.port),
      MIRA_TEST_NO_LAUNCH: "1",
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${node.cdp}`,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.pipe(log);
  let browser;
  for (let i = 0; i < 80 && !browser; i++) {
    await sleep(500);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${node.cdp}`);
    } catch {
      /* belum siap */
    }
  }
  if (!browser) throw new Error(`WebView2 ${id} tidak bisa dihubungi lewat CDP`);
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages())[0];
    if (!page) await sleep(250);
  }
  if (!page) throw new Error(`Jendela ${id} tidak ditemukan lewat CDP`);
  const consoleLines = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") consoleLines.push(`[${m.type()}] ${m.text()}`);
  });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => "__TAURI_INTERNALS__" in window, null, { timeout: 20000 });
  await page.setViewportSize({ width: 1280, height: 860 }).catch(() => {});
  running[id] = { child, browser, page, consoleLines };
  return running[id];
}

async function stop(id) {
  const app = running[id];
  if (!app) return;
  delete running[id];
  await app.browser.close().catch(() => {});
  try {
    execFileSync("taskkill", ["/PID", String(app.child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* sudah berhenti */
  }
  await sleep(1500);
}

// Memanggil command Tauri. Hasil: { ok, value } atau { ok: false, error }.
async function call(id, cmd, args = {}) {
  if (!running[id]) return { ok: false, error: `instance ${id} tidak berjalan` };
  return running[id].page.evaluate(
    async ([c, a]) => {
      try {
        return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(c, a) };
      } catch (error) {
        return { ok: false, error };
      }
    },
    [cmd, args],
  );
}
async function must(id, cmd, args) {
  const r = await call(id, cmd, args);
  if (!r.ok) throw new Error(`${id} ${cmd}: ${fmt(r.error)}`);
  return r.value;
}

async function waitFor(desc, fn, timeoutMs = SYNC_MS, everyMs = 1000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = String(e?.message ?? e);
    }
    await sleep(everyMs);
  }
  throw new Error(`Menunggu terlalu lama: ${desc} (terakhir: ${fmt(last)})`);
}
// Seperti waitFor, tapi kegagalan dikembalikan sebagai teks, bukan dilempar.
const settle = (desc, fn, timeoutMs) => waitFor(desc, fn, timeoutMs).catch((e) => String(e.message));

const onlineNames = async (id) =>
  (await must(id, "get_network_status")).peers.filter((p) => p.online).map((p) => p.displayName).sort();

async function waitOnline(id, ids) {
  const want = ids.map((x) => NODES[x].name);
  return settle(`${id} melihat ${want.join(", ")} online`, async () => {
    const names = await onlineNames(id);
    return want.every((n) => names.includes(n));
  });
}

// ---------------------------------------------------------------------------
// Bantuan tampilan

const page = (id) => running[id].page;
const shot = (id, name) => page(id).screenshot({ path: join(shots, name) }).catch(() => {});

async function refocus(id) {
  await page(id).evaluate(() => window.dispatchEvent(new Event("focus")));
  await sleep(800);
}

async function nav(id, label) {
  // Nama tombol menu bisa membawa angka ("Tanda tangan, 1 menunggu tanda tangan Anda").
  const name = new RegExp("^" + label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(,|$)");
  await page(id).getByRole("button", { name }).first().click();
  await sleep(600);
}

async function setTheme(id, label) {
  await nav(id, "Pengaturan");
  await page(id).getByLabel(label).check();
  await sleep(400);
}

// Memuat ulang layar setelah organisasi berubah lewat command.
async function reload(id) {
  await page(id).reload();
  await page(id).waitForFunction(() => "__TAURI_INTERNALS__" in window, null, { timeout: 20000 });
  await settleUi(id);
}

// Menunggu layar utama siap. Langkah firewall Tahap 1 (kalau tampil) dilewati.
async function settleUi(id) {
  await sleep(1500);
  const skip = page(id).getByRole("button", { name: /Lewati, atur nanti/ });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page(id).getByRole("button", { name: "Pengaturan", exact: true }).waitFor({ timeout: 20000 });
}

// Klik tombol sampai target muncul (tombol aria-disabled baru aktif setelah file terbuka).
async function clickUntil(desc, button, target, timeoutMs = 30000) {
  await waitFor(
    desc,
    async () => {
      if (await target.isVisible().catch(() => false)) return true;
      await button.click({ timeout: 5000 }).catch(() => {});
      await sleep(700);
      return target.isVisible().catch(() => false);
    },
    timeoutMs,
    300,
  );
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------------------------------------------------------------------
// Dokumen

async function docByName(id, name) {
  const list = await must(id, "list_documents", { projectId: null });
  return list.find((d) => d.name === name) ?? null;
}

// Pola simpan Excel yang ditiru (sama dengan smoke-docs-e2e.mjs): kunci ~$,
// file sementara 8 karakter tanpa ekstensi, file asli diganti nama, file
// sementara menjadi nama asli, lalu kunci dihapus.
async function simulateExcelSave(working, extra, who) {
  const dir = dirname(working);
  const lock = join(dir, "~$" + basename(working));
  writeFileSync(lock, who);
  await sleep(1000);
  writeFileSync(join(dir, "A1B2C3D4"), Buffer.concat([readFileSync(working), Buffer.from(extra)]));
  renameSync(working, join(dir, "5E6F7A8B"));
  renameSync(join(dir, "A1B2C3D4"), working);
  unlinkSync(join(dir, "5E6F7A8B"));
  await sleep(2500);
  unlinkSync(lock);
}

// Memulai edit (salinan kerja disiapkan, tanda "Sedang diedit" dikirim).
async function beginEdit(id, docId) {
  await must(id, "start_edit", { documentId: docId, fromVersionId: null });
  const working = join(NODES[id].dir, "working", docId, XLSX);
  await waitFor(`salinan kerja ${id} disiapkan`, async () => existsSync(working), 15000);
  return working;
}

// Menyimpan lewat pola Excel, lalu menunggu versi baru dan sesi edit selesai.
async function saveEdit(id, working, extra, before) {
  await simulateExcelSave(working, extra, NODES[id].name);
  return waitFor(
    `${id} menyimpan versi baru dan sesi edit selesai`,
    async () => {
      const d = await docByName(id, XLSX);
      return d && d.versionCount > before && d.editing.length === 0 ? d : null;
    },
    30000,
  );
}

// Bentrok dengan dua kepala: satu milik sendiri, satu dari rekan.
function conflictFrom(doc, rekanName) {
  if (!doc?.conflict || doc.conflictVersions.length !== 2) return null;
  const mine = doc.conflictVersions.find((v) => v.author.isMe);
  const theirs = doc.conflictVersions.find((v) => !v.author.isMe && v.author.displayName === rekanName);
  return mine && theirs ? { mine, theirs } : null;
}

async function showConflict(id) {
  const p = page(id);
  await nav(id, "Dokumen");
  await refocus(id);
  await p
    .getByRole("button", { name: new RegExp(`^(Selesaikan|Lihat) bentrok ${escapeRe(XLSX)}$`) })
    .click({ timeout: 15000 });
  await p.getByRole("heading", { name: /versi tersimpan berdampingan/ }).first().waitFor({ timeout: 15000 });
  await sleep(600);
}

// Mencari file di folder data yang isinya sama persis (untuk blob yang diterima).
function findFileWithBody(dir, want) {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        try {
          if (statSync(p).size === want.length && readFileSync(p).equals(want)) return p;
        } catch {
          /* terkunci */
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tanda tangan

async function makePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= 2; i++) {
    const p = doc.addPage([595.28, 841.89]);
    p.drawText(i === 1 ? "PERJANJIAN KERJA SAMA (DATA UJI SINKRON)" : "Lampiran (data uji)", {
      x: 60, y: 770, size: 16, font: bold, color: rgb(0.1, 0.1, 0.1),
    });
    for (let l = 0; l < 20; l++) {
      p.drawText(`Pasal ${l + 1}. Teks contoh untuk uji sinkron tanda tangan Mira, halaman ${i}.`, {
        x: 60, y: 730 - l * 24, size: 11, font,
      });
    }
  }
  writeFileSync(pdfPath, await doc.save());
}

async function openSignList(id) {
  // Pindah layar dulu supaya layar Tanda tangan dibuka ulang di daftar.
  await nav(id, "Dokumen");
  await nav(id, "Tanda tangan");
  await refocus(id);
}

// Menggambar tanda tangan dengan mouse dan menyimpannya dengan PIN (seperti sign-e2e.mjs).
async function createSignature(id) {
  const p = page(id);
  await p.getByRole("button", { name: "Buat tanda tangan" }).first().click();
  const pad = p.getByRole("img", { name: /Kotak menggambar tanda tangan/ }).or(p.locator("canvas").first());
  await pad.first().waitFor({ timeout: 15000 });
  const box = await pad.first().boundingBox();
  const y0 = box.y + box.height * 0.6;
  await p.mouse.move(box.x + box.width * 0.15, y0);
  await p.mouse.down();
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    await p.mouse.move(box.x + box.width * (0.15 + 0.7 * t), y0 - Math.sin(t * Math.PI * 3) * box.height * 0.25, { steps: 2 });
  }
  await p.mouse.up();
  await p.getByRole("button", { name: "Lanjut ke PIN" }).click();
  await p.getByLabel("PIN baru").fill(PIN);
  await p.getByLabel("Ulangi PIN").fill(PIN);
  await p.getByRole("button", { name: "Simpan tanda tangan" }).click();
  await p.getByText(/Tersimpan sejak/).waitFor({ timeout: 20000 });
}

// Membuka permintaan, menempatkan kotak di halaman 1, lalu PIN.
async function signThroughUi(id, requestId, doneText) {
  const p = page(id);
  await p.locator(`[data-request="${requestId}"]`).first().click({ timeout: 15000 });
  await p.locator("canvas").first().waitFor({ timeout: 30000 });
  await clickUntil(
    `${id}: kotak tanda tangan tampil`,
    p.getByRole("button", { name: "Tempatkan tanda tangan" }),
    p.getByRole("group", { name: /Kotak tanda tangan/ }).first(),
  );
  await clickUntil(
    `${id}: dialog PIN terbuka`,
    p.getByRole("button", { name: "Selesai dan tanda tangani" }),
    p.getByRole("dialog").getByLabel(/PIN/).first(),
  );
  await p.getByRole("dialog").getByLabel(/PIN/).first().fill(PIN);
  await p.keyboard.press("Enter");
  await p.getByText(doneText).first().waitFor({ timeout: 40000 });
  await sleep(1500);
}

const getRequest = (id, requestId) => must(id, "sign_get_request", { id: requestId });

// Membaca ujung file seperti stamp.ts (readXrefTail): offset xref terakhir dan
// nomor objek pertama yang belum dipakai.
function xrefTail(bytes) {
  const text = bytes.toString("latin1");
  const at = text.lastIndexOf("startxref");
  const startxref = Number(/^startxref\s*(\d+)/.exec(text.slice(at, at + 40))[1]);
  let maxObject = 0;
  for (const hit of text.matchAll(/(\d+)\s+\d+\s+obj\b/g)) {
    const n = Number(hit[1]);
    if (n > maxObject && n < 10_000_000) maxObject = n;
  }
  const size = Number(/\/Size\s+(\d+)/.exec(text.slice(text.lastIndexOf("trailer")))?.[1] ?? 0);
  return { startxref, firstFree: Math.max(size, maxObject + 1) };
}

// Versi "bertanda tangan" palsu: incremental update yang sah bentuknya (byte
// versi lama utuh di depan, xref klasik dengan /Prev), tetapi isi halaman 1
// diganti seluruhnya dengan kotak hitam. Bukan stempel: harus ditolak.
async function tamperedVersion(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const tail = xrefTail(bytes);
  doc.context.largestObjectNumber = Math.max(doc.context.largestObjectNumber, tail.firstFree - 1);
  const pageNode = doc.getPage(0);
  const stream = doc.context.stream("0 0 0 rg 60 300 475 460 re f");
  const streamRef = doc.context.register(stream);
  pageNode.node.set(PDFName.of("Contents"), streamRef);

  const serialize = (obj) => {
    const out = new Uint8Array(obj.sizeInBytes());
    obj.copyBytesInto(out, 0);
    return Buffer.from(out);
  };
  const chunks = [bytes];
  let length = bytes.length;
  const push = (b) => {
    chunks.push(b);
    length += b.length;
  };
  if (bytes[bytes.length - 1] !== 0x0a) push(Buffer.from("\n"));
  const entries = [];
  for (const [ref, obj] of [
    [pageNode.ref, pageNode.node],
    [streamRef, stream],
  ]) {
    entries.push({ num: ref.objectNumber, gen: ref.generationNumber, offset: length });
    push(Buffer.from(`${ref.objectNumber} ${ref.generationNumber} obj\n`, "latin1"));
    push(serialize(obj));
    push(Buffer.from("\nendobj\n"));
  }
  const xrefAt = length;
  let xref = "xref\n";
  for (const e of entries.sort((a, b) => a.num - b.num)) {
    xref += `${e.num} 1\n${String(e.offset).padStart(10, "0")} ${String(e.gen).padStart(5, "0")} n\r\n`;
  }
  push(Buffer.from(`${xref}trailer\n`, "latin1"));
  const { Root, Info, ID } = doc.context.trailerInfo;
  const trailer = doc.context.obj({
    Size: Math.max(tail.firstFree, streamRef.objectNumber + 1),
    Root,
    Info,
    ID,
    Prev: tail.startxref,
  });
  push(serialize(trailer));
  push(Buffer.from(`\nstartxref\n${xrefAt}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

// sign_complete dengan isi mentah dan header, seperti signingApi.complete di layar.
async function submitVersion(id, requestId, token, baseHash, bytes) {
  return page(id).evaluate(
    async ([body, headers]) => {
      try {
        return {
          ok: true,
          value: await window.__TAURI_INTERNALS__.invoke("sign_complete", new Uint8Array(body), { headers }),
        };
      } catch (error) {
        return { ok: false, error };
      }
    },
    [Array.from(bytes), { "x-mira-request": requestId, "x-mira-token": token, "x-mira-base-hash": baseHash }],
  );
}

async function readSignFile(id, requestId, hash) {
  const arr = await page(id).evaluate(
    async ([rid, h]) => Array.from(new Uint8Array(await window.__TAURI_INTERNALS__.invoke("sign_read_file", { id: rid, hash: h }))),
    [requestId, hash],
  );
  return Buffer.from(arr);
}

// ---------------------------------------------------------------------------
// Skenario

async function scenario(name, fn) {
  try {
    await fn();
    return true;
  } catch (err) {
    check(`${name}: berjalan tanpa error`, false, String(err?.message ?? err).split("\n")[0]);
    for (const id of Object.keys(running)) {
      const path = join(tmpdir(), `mira-sync-e2e-gagal-${id}.png`);
      await page(id).screenshot({ path }).catch(() => {});
      const text = await page(id).locator("body").innerText().catch(() => "");
      console.log(`  Screenshot ${id} saat gagal: ${path}\n  Isi layar ${id}: ${text.replace(/\s+/g, " ").slice(0, 400)}`);
    }
    return false;
  }
}

let docId = null;
let team = null;

const ok1 = await scenario("Organisasi", async () => {
  if (!existsSync(exe)) throw new Error(`mira.exe tidak ditemukan: ${exe}`);
  if (!existsSync(XLSX_SRC)) throw new Error(`File uji tidak ditemukan: ${XLSX_SRC}`);
  for (const id of Object.keys(NODES)) await launch(id);
  for (const id of Object.keys(NODES)) await must(id, "save_display_name", { name: NODES[id].name });
  for (const id of Object.keys(NODES)) pk[id] = (await must(id, "get_app_state")).identity.publicKey;

  await must("A", "create_organization", { name: "Kantor Uji Sinkron" });
  team = await must("A", "create_team", { name: "Tim Proyek" });
  const lain = await must("A", "create_team", { name: "Tim Lain" });
  await must("A", "add_team_member", { teamId: team.id, publicKey: pk.A });
  const invB = await must("A", "create_invite", { teamId: team.id, role: "member", validity: "24h", projectIds: [] });
  const invC = await must("A", "create_invite", { teamId: lain.id, role: "member", validity: "24h", projectIds: [] });
  const joinOne = (id, code) =>
    waitFor(`${id} bergabung lewat alamat A`, async () => {
      const r = await call(id, "join_with_code", { code, address: addr("A") });
      return r.ok || r.error?.code !== "no_peer_found" ? r : null;
    }, 60000);
  const joinB = await joinOne("B", invB.code);
  const joinC = await joinOne("C", invC.code);
  check(
    "B (Tim Proyek) dan C (Tim Lain) bergabung sebagai Anggota",
    joinB.ok && joinB.value.role === "member" && joinC.ok && joinC.value.role === "member",
    `B ${fmt(joinB.ok ? joinB.value.role : joinB.error)}, C ${fmt(joinC.ok ? joinC.value.role : joinC.error)}`,
  );

  const seen = await settle("A melihat B di Tim Proyek dan C di Tim Lain, B melihat A", async () => {
    const [da, db] = [await must("A", "get_directory"), await must("B", "get_directory")];
    const inTeam = (d, t, k) => d.teams.find((x) => x.id === t)?.members.some((m) => m.publicKey === k);
    return inTeam(da, team.id, pk.B) && inTeam(da, lain.id, pk.C) && inTeam(db, team.id, pk.A);
  });
  check("Direktori: A dan B di Tim Proyek, C di Tim Lain", seen === true, seen === true ? "" : seen);

  for (const id of Object.keys(NODES)) {
    const others = Object.keys(NODES).filter((x) => x !== id);
    const online = await waitOnline(id, others);
    check(`${id} melihat dua rekan online lewat jaringan kantor`, online === true, online === true ? "" : online);
  }

  for (const id of Object.keys(NODES)) {
    await reload(id);
    await setTheme(id, "Terang");
  }
});

if (ok1) {
  // Dokumen baru, tanda "Sedang diedit", dan versi baru dari A sampai ke B.
  const ok2 = await scenario("Dokumen", async () => {
    const since = Date.now();
    const [added] = await must("A", "add_documents", { paths: [XLSX_SRC], projectId: null });
    docId = added.id;
    const atB = await settle("B menerima dokumen dan isinya tersalin otomatis", async () => {
      const d = await docByName("B", XLSX);
      return d?.current.available ? d : null;
    });
    const okB = typeof atB === "object";
    check(
      "B melihat RAB-proyek-a.xlsx dari A",
      okB && atB.id === docId && atB.current.received && atB.createdBy.displayName === NODES.A.name,
      okB ? `${secs(since)}, dari ${atB.createdBy.displayName}` : atB,
    );
    let sameBytes = false;
    if (okB) {
      const out = join(root, "ekspor-b.xlsx");
      await must("B", "export_version", { documentId: docId, versionId: null, destination: out });
      sameBytes = existsSync(out) && readFileSync(out).equals(readFileSync(XLSX_SRC));
    }
    check(
      "Isi versi 1 tersalin otomatis ke B dan sama persis dengan file asli",
      okB && atB.current.available && sameBytes,
      okB ? `ukuran ${atB.current.size} B, ekspor sama=${sameBytes}` : "",
    );
    await nav("B", "Dokumen");
    await refocus("B");
    await page("B").getByText(XLSX).first().waitFor({ timeout: 10000 });
    await shot("B", "sinkron-01-dokumen-diterima-b.png");

    // Pustaka Umum terbuka untuk semua anggota aktif, juga tim lain: kontrol
    // positif untuk uji anggota yang dikeluarkan di akhir.
    const atC = await settle("C menerima dokumen Pustaka Umum", async () => {
      const d = await docByName("C", XLSX);
      return d?.current.available ? d : null;
    });
    check(
      "C (Tim Lain) menerima dokumen Pustaka Umum (semua anggota aktif berhak)",
      typeof atC === "object" && atC.id === docId,
      typeof atC === "object" ? "" : atC,
    );

    // Tanda "Sedang diedit".
    const editAt = Date.now();
    const working = await beginEdit("A", docId);
    const pb = page("B");
    await nav("B", "Dokumen");
    const mark = await settle("B menampilkan Sedang diedit Ayu Uji", async () => {
      await refocus("B");
      const d = await docByName("B", XLSX);
      const remote = d?.editing.find((e) => !e.local && e.editor.displayName === NODES.A.name);
      if (!remote) return null;
      return (await pb.getByText(new RegExp(`Sedang diedit ${escapeRe(NODES.A.name)}`)).first().isVisible().catch(() => false)) || null;
    });
    check(`Tanda "Sedang diedit ${NODES.A.name}" tampil di layar B`, mark === true, mark === true ? secs(editAt) : mark);
    await shot("B", "sinkron-11-sedang-diedit-b.png");

    // Versi baru.
    const v2a = await saveEdit("A", working, "revisi harga semen (Ayu)", 1);
    const verAt = Date.now();
    const v2b = await settle("B menerima versi 2 beserta isinya", async () => {
      const d = await docByName("B", XLSX);
      return d && d.versionCount === 2 && d.current.blobHash === v2a.current.blobHash && d.current.available ? d : null;
    });
    const okV = typeof v2b === "object";
    check(
      "Versi baru A tampil di B dan isinya tersalin",
      okV && v2b.current.author.displayName === NODES.A.name && !v2b.conflict,
      okV ? `${secs(verAt)}, versi ${v2b.current.number} dari ${v2b.current.author.displayName}` : v2b,
    );
    // Tanda selesai edit adalah record sendiri; bisa datang di sesi sinkron berikutnya.
    const cleared = await settle("tanda Sedang diedit hilang di B", async () => {
      const d = await docByName("B", XLSX);
      return d && d.editing.length === 0;
    });
    check(
      'Tanda "Sedang diedit" hilang di B setelah A selesai menyimpan',
      cleared === true,
      cleared === true ? secs(verAt) : cleared,
    );
    await refocus("B");
    await shot("B", "sinkron-12-versi-baru-b.png");
  });

  // Bentrok: A dan B masing-masing menyimpan versi saat tidak tersambung.
  if (ok2) {
    await scenario("Bentrok", async () => {
      // C ikut dimatikan supaya tidak meneruskan versi A ke B.
      await stop("C");
      await stop("B");
      const workA = await beginEdit("A", docId);
      const editA = await saveEdit("A", workA, "revisi volume besi (Ayu, offline)", 2);
      await stop("A");
      await launch("B");
      await settleUi("B");
      const workB = await beginEdit("B", docId);
      const editB = await saveEdit("B", workB, "revisi volume besi (Budi, offline)", 2);
      check(
        "A dan B masing-masing menyimpan versi 3 saat tidak tersambung",
        editA.current.origin === "edited" && editB.current.origin === "edited" && editA.current.blobHash !== editB.current.blobHash,
        `A ${editA.current.blobHash.slice(0, 8)}, B ${editB.current.blobHash.slice(0, 8)}`,
      );
      const backAt = Date.now();
      await launch("A");
      await settleUi("A");
      const online = await waitOnline("A", ["B"]);
      note(`A menyala lagi dan melihat B online: ${online === true ? secs(backAt) : online}`);

      for (const id of ["A", "B"]) {
        const rekan = NODES[id === "A" ? "B" : "A"].name;
        const c = await settle(`${id} melihat bentrok dengan versi ${rekan}`, async () =>
          conflictFrom(await docByName(id, XLSX), rekan),
        );
        const okC = typeof c === "object";
        check(
          `${id} menandai bentrok: dua kepala, versi rekan dari ${rekan}`,
          okC,
          okC ? `${secs(backAt)}, versi ${c.mine.number} milik sendiri, versi ${c.theirs.number} dari ${rekan}` : c,
        );
      }
      const bothHere = await settle("isi kedua versi bentrok ada di kedua laptop", async () => {
        for (const id of ["A", "B"]) {
          const d = await docByName(id, XLSX);
          if (!d?.conflictVersions.length || !d.conflictVersions.every((v) => v.available)) return false;
        }
        return true;
      });
      check("Isi versi rekan yang bentrok tersalin otomatis di kedua laptop", bothHere === true, bothHere === true ? "" : bothHere);

      for (const [id, file] of [
        ["A", "sinkron-02-bentrok-dari-rekan-a.png"],
        ["B", "sinkron-03-bentrok-dari-rekan-b.png"],
      ]) {
        await showConflict(id);
        const rekan = NODES[id === "A" ? "B" : "A"].name;
        const shown = await page(id)
          .getByText(new RegExp(`Versi \\d+ dari ${escapeRe(rekan)}`))
          .first()
          .isVisible()
          .catch(() => false);
        check(`Layar Dokumen ${id} menampilkan bentrok dengan nama ${rekan}`, shown);
        await shot(id, file);
      }
    });
  }

  // C dinyalakan lagi (kalau skenario bentrok mematikannya) untuk uji berikutnya.
  for (const id of Object.keys(NODES)) {
    if (!running[id]) {
      await launch(id);
      await settleUi(id);
    }
  }
  for (const id of Object.keys(NODES)) {
    const others = Object.keys(NODES).filter((x) => x !== id);
    const online = await waitOnline(id, others);
    if (online !== true) note(`${id} belum melihat semua rekan online: ${online}`);
  }

  // Dokumen besar: tidak disalin otomatis, diunduh lewat tombol di B.
  await scenario("Dokumen besar", async () => {
    const bigPath = join(root, BIG);
    writeFileSync(bigPath, randomBytes(BIG_SIZE));
    const [big] = await must("A", "add_documents", { paths: [bigPath], projectId: null });
    const atB = await waitFor("B menerima dokumen besar", async () => docByName("B", BIG));
    await sleep(5000); // beri waktu kalau ternyata ikut disalin otomatis
    const still = await docByName("B", BIG);
    check(
      "File 21 MB dari A tampil di B tanpa disalin otomatis",
      atB.id === big.id && !still.current.available && !still.current.autoDownload && !still.current.downloading,
      `available ${still.current.available}, autoDownload ${still.current.autoDownload}, downloading ${still.current.downloading}`,
    );

    const p = page("B");
    await nav("B", "Dokumen");
    await refocus("B");
    const button = p.getByRole("button", { name: new RegExp(`^Unduh dari rekan \\(.+\\) ${escapeRe(BIG)}$`) });
    await button.waitFor({ timeout: 15000 });
    check("Tombol Unduh dari rekan tampil di baris file besar", true, await button.innerText());
    await shot("B", "sinkron-04-file-besar-sebelum-unduh-b.png");

    await button.click();
    const since = Date.now();
    const done = await settle("isi file besar ada di B setelah diunduh", async () => {
      const d = await docByName("B", BIG);
      if (d?.current.available) return d;
      const err = await p.getByText("File belum bisa diunduh").first().isVisible().catch(() => false);
      if (err) throw new Error(`layar B: ${(await p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 300)}`);
      return null;
    });
    let sameBytes = false;
    if (typeof done === "object") {
      const out = join(root, "ekspor-besar-b.zip");
      await must("B", "export_version", { documentId: big.id, versionId: null, destination: out });
      sameBytes = readFileSync(out).equals(readFileSync(bigPath));
    }
    check(
      "Unduh dari rekan menyalin file 21 MB ke B, isinya sama persis",
      typeof done === "object" && done.current.size === BIG_SIZE && sameBytes,
      typeof done === "object" ? `${done.current.size} B dalam ${secs(since)}, ekspor sama=${sameBytes}` : done,
    );
    await refocus("B");
    await button.waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
    await shot("B", "sinkron-05-file-besar-sesudah-unduh-b.png");
  });

  // Tanda tangan berurutan: B lalu A. C tidak terlibat.
  await scenario("Tanda tangan", async () => {
    await makePdf();
    const pa = page("A");
    await openSignList("A");
    const [chooser] = await Promise.all([
      pa.waitForEvent("filechooser"),
      pa.getByRole("button", { name: "Pilih PDF untuk ditandatangani" }).click(),
    ]);
    await chooser.setFiles(pdfPath);
    const dlg = pa.getByRole("dialog");
    await dlg.getByRole("checkbox", { name: NODES.B.name, exact: true }).check({ timeout: 20000 });
    await dlg.getByRole("button", { name: `Naikkan ${NODES.B.name}`, exact: true }).click();
    await dlg.getByRole("button", { name: "Buat permintaan" }).click();
    await dlg.waitFor({ state: "detached", timeout: 20000 });

    const overviewA = await must("A", "sign_overview");
    const req = overviewA.requests.find((r) => r.title === PDF_TITLE);
    if (!req) throw new Error(`Permintaan ${PDF_TITLE} tidak ada di A`);
    const created = await getRequest("A", req.id);
    const order = [...created.signers].sort((a, b) => a.position - b.position).map((s) => s.displayName);
    check(
      "A membuat permintaan berurutan dengan penanda tangan B lalu A",
      created.mode === "sequential" && order.join(",") === `${NODES.B.name},${NODES.A.name}`,
      order.join(" lalu "),
    );
    const sentAt = Date.now();

    const atB = await settle("B menerima permintaan dan filenya", async () => {
      const r = (await must("B", "sign_overview")).requests.find((x) => x.id === req.id);
      return r?.fileAvailable && r.myState === "your_turn" ? r : null;
    });
    const okB = typeof atB === "object";
    check(
      "B menerima permintaan dari A, giliran B, file tersalin",
      okB && atB.fromPeer && atB.requestedByName === NODES.A.name,
      okB ? `${secs(sentAt)}, fromPeer ${atB.fromPeer}, requestedByName ${atB.requestedByName}` : atB,
    );

    const pb = page("B");
    await openSignList("B");
    const waiting = pb.locator("section", { has: pb.getByRole("heading", { name: "Menunggu tanda tangan" }) });
    await waiting.waitFor({ timeout: 15000 });
    const byLine = await waiting.getByText(`Diminta oleh ${NODES.A.name}`).first().isVisible().catch(() => false);
    check(`B melihat "Menunggu tanda tangan" dengan "Diminta oleh ${NODES.A.name}"`, byLine);
    await shot("B", "sinkron-06-menunggu-tanda-tangan-b.png");

    await createSignature("B");
    await signThroughUi("B", req.id, "Versi baru dokumen dengan tanda tangan Anda sudah disimpan di laptop ini.");
    const bSigned = await getRequest("B", req.id);
    check("B menandatangani lewat layar dengan PIN", bSigned.signedCount === 1 && bSigned.status === "in_progress", `${bSigned.signedCount}/${bSigned.signerCount}`);
    await shot("B", "sinkron-07-tanda-tangan-b-tersimpan.png");

    const signedAt = Date.now();
    const aTurn = await settle("A menerima versi bertanda tangan B dan gilirannya tiba", async () => {
      const d = await getRequest("A", req.id);
      const me = d.signers.find((s) => s.isMe);
      return me?.canSignNow && d.fileAvailable && !d.pending ? d : null;
    });
    const okA = typeof aTurn === "object";
    check(
      "A menerima versi bertanda tangan B, lalu giliran A",
      okA && aTurn.signedCount === 1 && aTurn.currentHash === bSigned.currentHash && aTurn.rejected.length === 0,
      okA ? `${secs(signedAt)}, hash ${aTurn.currentHash.slice(0, 8)}, ditolak ${aTurn.rejected.length}` : aTurn,
    );

    await openSignList("A");
    await createSignature("A");

    // Versi palsu: isi halaman diganti, bukan hanya stempel. Inti Rust harus
    // menolaknya sebelum disimpan atau dikirim ke rekan.
    if (okA) {
      const base = await readSignFile("A", req.id, aTurn.currentHash);
      const bad = await tamperedVersion(base);
      const { token } = await must("A", "sign_unlock", { pin: PIN });
      const r = await submitVersion("A", req.id, token, aTurn.currentHash, bad);
      check(
        "Versi yang mengubah isi selain stempel ditolak (version_changes_content)",
        !r.ok && r.error?.code === "version_changes_content",
        r.ok ? "diterima" : `${r.error?.code}: ${fmt(r.error?.message)}`,
      );
      const afterA = await getRequest("A", req.id);
      check(
        "Versi palsu tidak tersimpan di A (hash dan jumlah tanda tangan tetap)",
        afterA.currentHash === aTurn.currentHash && afterA.signedCount === 1,
        `hash ${afterA.currentHash.slice(0, 8)}, ${afterA.signedCount}/${afterA.signerCount}`,
      );
    }

    await signThroughUi("A", req.id, "Semua sudah menandatangani. Dokumen dikunci dan halaman catatan ditambahkan.");
    await shot("A", "sinkron-08-tanda-tangan-selesai-a.png");

    const finalA = await getRequest("A", req.id);
    check(
      "A: permintaan selesai, kunci sah",
      finalA.status === "completed" && finalA.sealValid === true && finalA.signedCount === 2,
      `status ${finalA.status}, sealValid ${finalA.sealValid}`,
    );
    const doneAt = Date.now();
    const finalB = await settle("B menerima versi final dan kuncinya sah", async () => {
      const d = await getRequest("B", req.id);
      return d.status === "completed" && d.sealValid === true && d.fileAvailable ? d : null;
    });
    const okF = typeof finalB === "object";
    check(
      "B: permintaan selesai, kunci sah, versi final sama dengan A, tanpa versi ditolak",
      okF && finalB.currentHash === finalA.currentHash && finalB.rejected.length === 0,
      okF ? `${secs(doneAt)}, hash ${finalB.currentHash.slice(0, 8)}, ditolak ${finalB.rejected.length}` : finalB,
    );
    check(
      "Jejak audit sah di kedua laptop",
      finalA.events.every((e) => e.valid) && okF && finalB.events.every((e) => e.valid),
      `A ${finalA.events.length} catatan, B ${okF ? finalB.events.length : "?"} catatan`,
    );

    await openSignList("B");
    await pb.locator(`[data-request="${req.id}"]`).first().click({ timeout: 15000 });
    await pb.locator("canvas").first().waitFor({ timeout: 30000 });
    await sleep(1500);
    await shot("B", "sinkron-09-tanda-tangan-selesai-b.png");

    // C bukan pengirim dan bukan penanda tangan: tidak menerima apa pun,
    // setelah paling sedikit satu putaran sinkron cadangan penuh.
    await sleep(Math.max(0, FULL_ROUND_MS - (Date.now() - sentAt)));
    const cOverview = await must("C", "sign_overview");
    const cHas = cOverview.requests.some((r) => r.id === req.id || r.title === PDF_TITLE);
    const cGet = await call("C", "sign_get_request", { id: req.id });
    check(
      "C (Tim Lain, tidak terlibat) tidak menerima permintaan tanda tangan",
      !cHas && !cGet.ok,
      `di daftar=${cHas}, sign_get_request=${cGet.ok ? "terbuka" : cGet.error?.code}, ${secs(sentAt)} sejak dibuat`,
    );
  });

  // Anggota yang dikeluarkan: tidak menerima dokumen baru.
  await scenario("Anggota dikeluarkan", async () => {
    await must("A", "remove_member", { publicKey: pk.C });
    const removed = await settle("B mencatat C dikeluarkan", async () => {
      const d = await must("B", "get_directory");
      return d.members.find((m) => m.publicKey === pk.C)?.status === "removed";
    });
    check("A mengeluarkan C, B ikut mencatatnya", removed === true, removed === true ? "" : removed);

    const txt = join(root, AFTER_REMOVAL);
    writeFileSync(txt, "Notulen rapat setelah Citra keluar (data uji).\n");
    const [doc] = await must("A", "add_documents", { paths: [txt], projectId: null });
    const addedAt = Date.now();
    const atB = await settle("B menerima dokumen baru", async () => {
      const d = await docByName("B", AFTER_REMOVAL);
      return d?.current.available ? d : null;
    });
    check("B menerima dokumen baru dari A", typeof atB === "object" && atB.id === doc.id, typeof atB === "object" ? secs(addedAt) : atB);

    await sleep(Math.max(0, FULL_ROUND_MS - (Date.now() - addedAt)));
    const list = await call("C", "list_documents", { projectId: null });
    const cHas = list.ok && list.value.some((d) => d.id === doc.id || d.name === AFTER_REMOVAL);
    const cState = await call("C", "get_app_state");
    // Layar dan daftar C bisa kosong hanya karena C sudah dikeluarkan, jadi isi
    // folder data C juga diperiksa: file kecil (di bawah 20 MB) yang diterima
    // selalu tersalin ke sana. Kontrol: file XLSX yang diterima C sebelumnya ada.
    const oldOnDisk = findFileWithBody(NODES.C.dir, readFileSync(XLSX_SRC));
    const newOnDisk = findFileWithBody(NODES.C.dir, readFileSync(txt));
    check(
      "C yang dikeluarkan tidak menerima dokumen baru (daftar dan folder data)",
      !cHas && Boolean(oldOnDisk) && !newOnDisk,
      `list_documents=${list.ok ? `${list.value.length} dokumen` : list.error?.code}, keanggotaan C=${cState.ok ? cState.value.membership : "?"}, ` +
        `XLSX lama di disk C=${Boolean(oldOnDisk)}, file baru di disk C=${Boolean(newOnDisk)}, ${secs(addedAt)} sejak ditambah`,
    );
    await refocus("C");
    await shot("C", "sinkron-13-dikeluarkan-c.png");
  });

  // Satu screenshot mode gelap: bentrok di laptop A.
  await scenario("Mode gelap", async () => {
    await setTheme("A", "Gelap");
    await showConflict("A");
    const theme = await page("A").evaluate(() => document.documentElement.dataset.theme);
    check("Mode gelap diterapkan di layar Dokumen A", theme === "dark", String(theme));
    await shot("A", "sinkron-10-bentrok-gelap-a.png");
  });

  // Penolakan record sinkron dicatat inti di log yang sama dengan perubahan
  // keanggotaan (kode docs_* dan sign_*).
  for (const id of ["A", "B"]) {
    const r = await call(id, "get_rejected_changes");
    const rows = r.ok ? r.value.filter((x) => /^(docs|sign)_/.test(x.code)) : [];
    check(
      `${id}: tidak ada record dokumen atau tanda tangan yang ditolak`,
      r.ok && rows.length === 0,
      r.ok ? rows.map((x) => `${x.code}: ${x.detail}`).join("; ").slice(0, 300) : fmt(r.error),
    );
  }
}

// ---------------------------------------------------------------------------
// Bersih-bersih: hanya proses, kunci uji, dan folder dari run ini.

const failedSoFar = results.some((r) => !r.ok);
for (const id of Object.keys(running)) {
  if (failedSoFar && running[id].consoleLines.length) {
    console.log(`Konsol ${id} (error/peringatan, terakhir):\n${running[id].consoleLines.slice(-15).join("\n")}`);
  }
  await stop(id);
}
if (failedSoFar) {
  for (const id of Object.keys(NODES)) {
    try {
      const log = readFileSync(join(root, `${id}-stderr.log`), "utf8").trim();
      if (log) console.log(`stderr ${id} (akhir):\n${log.slice(-1500)}`);
    } catch {
      /* tidak ada log */
    }
  }
}
for (const target of miraCredentials()) {
  if (!credentialsBefore.has(target)) {
    try {
      execFileSync("cmdkey", [`/delete:${target}`], { stdio: "ignore" });
    } catch {
      console.log(`Kunci uji tidak bisa dihapus: ${target}`);
    }
  }
}
if (process.env.MIRA_E2E_KEEP === "1") {
  console.log(`Folder uji disimpan: ${root}`);
} else {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch (err) {
    console.log(`Folder uji tidak bisa dihapus: ${root} (${err.code})`);
  }
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} pemeriksaan lulus.`);
process.exit(failed ? 1 : 0);
