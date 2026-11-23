// Uji ujung ke ujung sinkron dokumen dan tanda tangan antara dua "laptop"
// Mira di satu PC.
//
// Dua instance mira.exe berjalan dengan folder data (MIRA_DATA_DIR), port QUIC
// (MIRA_PORT), dan port debug WebView2 sendiri, lalu dikendalikan lewat Chrome
// DevTools Protocol. Keanggotaan organisasi memakai jaringan Tahap 1 yang asli
// (seperti e2e-multi.mjs). Record fitur ("docs", "sign") dan file belum lewat
// transport asli: keduanya dijalankan dengan MIRA_TEST_BRIDGE_DIR, dan skrip
// ini menjalankan pompa di latar (src-tauri/src/feature_bridge.rs):
//
//   - record: untuk setiap topik dan pasangan (X, Y), debug_feature_offer di X
//     lalu debug_feature_ingest di Y;
//   - file: setiap wants/<pkY>/<hash> dilayani laptop lain lewat debug_blob_serve;
//   - offline: pompa dijeda dan file peers/<pk> dihapus; saat tersambung lagi
//     file dibuat ulang dan debug_peer_connected dipanggil.
//
//   A  Ayu Uji   membuat organisasi
//   B  Budi Uji  bergabung sebagai Anggota
//
// Pakai:  node scripts/sync-e2e.mjs <path mira.exe> <folder screenshot>
// Butuh:  playwright-core, pdf-lib. MIRA_E2E_KEEP=1 menyimpan folder sementara.

import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const exe = resolve(process.argv[2] ?? "src-tauri/target/debug/mira.exe");
const shots = resolve(process.argv[3] ?? "docs/progress/screenshots/sinkron");
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(shots, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "mira-sinkron-"));
const bridge = join(root, "jembatan");
mkdirSync(bridge, { recursive: true });

const XLSX = "RAB-proyek-a.xlsx";
const XLSX_SRC = join(repo, "test-files", "docs", XLSX);
const BIG = "gambar-kerja-proyek.zip";
const BIG_SIZE = 21 * 1024 * 1024; // di atas batas salin otomatis 20 MB
const PDF_TITLE = "kontrak-sinkron";
const pdfPath = join(root, `${PDF_TITLE}.pdf`);
const PIN = "246810";

const NODES = {
  A: { name: "Ayu Uji", port: 47861, cdp: 9361, dir: join(root, "laptop-a") },
  B: { name: "Budi Uji", port: 47862, cdp: 9362, dir: join(root, "laptop-b") },
};
const addr = (id) => `127.0.0.1:${NODES[id].port}`;
const other = (id) => (id === "A" ? "B" : "A");
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (v) => (typeof v === "string" ? v : JSON.stringify(v))?.slice(0, 300);

// ---------------------------------------------------------------------------
// Instance

const running = {};

async function launch(id) {
  const node = NODES[id];
  mkdirSync(node.dir, { recursive: true });
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      MIRA_DATA_DIR: node.dir,
      MIRA_PORT: String(node.port),
      MIRA_TEST_BRIDGE_DIR: bridge,
      MIRA_TEST_NO_LAUNCH: "1",
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${node.cdp}`,
    },
    stdio: "ignore",
  });
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
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => "__TAURI_INTERNALS__" in window, null, { timeout: 20000 });
  await page.setViewportSize({ width: 1280, height: 860 }).catch(() => {});
  running[id] = { child, browser, page };
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

async function waitFor(desc, fn, timeoutMs = 45000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = String(e?.message ?? e);
    }
    await sleep(500);
  }
  const pumpNote = pump.lastError ? `; galat pompa terakhir: ${pump.lastError}` : "";
  throw new Error(`Menunggu terlalu lama: ${desc} (terakhir: ${fmt(last)}${pumpNote})`);
}

// ---------------------------------------------------------------------------
// Pompa jembatan fitur

const TOPICS = ["docs", "sign"];
const PAIRS = [
  ["A", "B"],
  ["B", "A"],
];
const pump = {
  on: false,
  paused: false,
  busy: false,
  loop: null,
  lastError: null,
  stats: { accepted: 0, rejected: 0, dropped: 0, served: 0 },
};

async function pumpOnce() {
  for (const topic of TOPICS) {
    for (const [x, y] of PAIRS) {
      const offer = await call(x, "debug_feature_offer", { topic, peer: pk[y] });
      if (!offer.ok) {
        pump.lastError = `${x} debug_feature_offer ${topic}: ${fmt(offer.error)}`;
        continue;
      }
      if (!offer.value.length) continue;
      const got = await call(y, "debug_feature_ingest", { topic, from: pk[x], records: offer.value });
      if (!got.ok) {
        pump.lastError = `${y} debug_feature_ingest ${topic}: ${fmt(got.error)}`;
        continue;
      }
      const { accepted, rejected, dropped } = got.value;
      pump.stats.accepted += accepted;
      pump.stats.rejected += rejected;
      pump.stats.dropped += dropped;
      if (rejected || dropped) {
        console.log(`  pompa: ${y} menolak ${rejected} dan membuang ${dropped} record ${topic} dari ${x}`);
      }
    }
  }
  // File yang ditunggu Y dilayani X (yang memeriksa izinnya sendiri).
  for (const [x, y] of PAIRS) {
    let wants = [];
    try {
      wants = readdirSync(join(bridge, "wants", pk[y])).filter((h) => /^[0-9a-f]{64}$/.test(h));
    } catch {
      /* folder belum ada */
    }
    for (const hash of wants) {
      if (existsSync(join(bridge, "blobs", hash))) continue;
      const r = await call(x, "debug_blob_serve", { peer: pk[y], hash });
      if (!r.ok) pump.lastError = `${x} debug_blob_serve: ${fmt(r.error)}`;
      else if (r.value) pump.stats.served += 1;
    }
  }
}

function startPump() {
  pump.on = true;
  pump.loop = (async () => {
    while (pump.on) {
      if (!pump.paused && running.A && running.B) {
        pump.busy = true;
        try {
          await pumpOnce();
        } catch (e) {
          pump.lastError = String(e?.message ?? e);
        } finally {
          pump.busy = false;
        }
      }
      await sleep(700);
    }
  })();
}

async function stopPump() {
  pump.on = false;
  await pump.loop?.catch(() => {});
}

// Offline: pompa berhenti dan kedua laptop tidak saling melihat.
async function goOffline() {
  pump.paused = true;
  await waitFor("putaran pompa yang berjalan selesai", async () => !pump.busy, 30000);
  for (const id of ["A", "B"]) rmSync(join(bridge, "peers", pk[id]), { force: true });
}

async function goOnline() {
  for (const id of ["A", "B"]) writeFileSync(join(bridge, "peers", pk[id]), "");
  for (const id of ["A", "B"]) await must(id, "debug_peer_connected", { peer: pk[other(id)] });
  pump.paused = false;
}

// ---------------------------------------------------------------------------
// Bantuan tampilan

const page = (id) => running[id].page;
const shot = (id, name) => page(id).screenshot({ path: join(shots, name) });

async function refocus(id) {
  await page(id).evaluate(() => window.dispatchEvent(new Event("focus")));
  await sleep(800);
}

async function nav(id, label) {
  await page(id).getByRole("button", { name: label, exact: true }).first().click();
  await sleep(600);
}

async function setTheme(id, label) {
  await nav(id, "Pengaturan");
  await page(id).getByLabel(label).check();
  await sleep(400);
}

async function reload(id) {
  await page(id).reload();
  await page(id).waitForFunction(() => "__TAURI_INTERNALS__" in window, null, { timeout: 20000 });
  await sleep(1500);
  // Langkah firewall Tahap 1 (kalau tampil) dilewati.
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

async function editOffline(id, docId, extra) {
  await must(id, "start_edit", { documentId: docId, fromVersionId: null });
  const working = join(NODES[id].dir, "working", docId, XLSX);
  await waitFor(`salinan kerja ${id} disiapkan`, async () => existsSync(working), 15000);
  await simulateExcelSave(working, extra, NODES[id].name);
  return waitFor(
    `${id} menyimpan versi 2 dan sesi edit selesai`,
    async () => {
      const d = await docByName(id, XLSX);
      return d && d.versionCount >= 2 && d.editing.length === 0 ? d : null;
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

const ok1 = await scenario("Organisasi", async () => {
  if (!existsSync(exe)) throw new Error(`mira.exe tidak ditemukan: ${exe}`);
  if (!existsSync(XLSX_SRC)) throw new Error(`File uji tidak ditemukan: ${XLSX_SRC}`);
  for (const id of ["A", "B"]) await launch(id);
  for (const id of ["A", "B"]) await must(id, "save_display_name", { name: NODES[id].name });
  for (const id of ["A", "B"]) pk[id] = (await must(id, "get_app_state")).identity.publicKey;
  check(
    "Kedua laptop mendaftar di folder jembatan uji",
    ["A", "B"].every((id) => existsSync(join(bridge, "peers", pk[id]))),
    readdirSync(join(bridge, "peers")).length + " file peers",
  );

  await must("A", "create_organization", { name: "Kantor Uji Sinkron" });
  const team = await must("A", "create_team", { name: "Tim Proyek" });
  const invite = await must("A", "create_invite", { teamId: team.id, role: "member", validity: "24h", projectIds: [] });
  const joined = await waitFor("B bergabung lewat alamat A", async () => {
    const r = await call("B", "join_with_code", { code: invite.code, address: addr("A") });
    return r.ok || r.error?.code !== "no_peer_found" ? r : null;
  });
  check("B (Budi Uji) bergabung sebagai Anggota", joined.ok && joined.value.role === "member", fmt(joined.ok ? joined.value.role : joined.error));

  const seen = await waitFor("A dan B saling tercatat aktif di direktori", async () => {
    const [da, db] = [await must("A", "get_directory"), await must("B", "get_directory")];
    const has = (d, key) => d.members.some((m) => m.publicKey === key && m.status !== "removed");
    return has(da, pk.B) && has(db, pk.A);
  }).catch((e) => String(e.message));
  check("A dan B saling melihat di direktori organisasi", seen === true, seen === true ? "" : seen);

  for (const id of ["A", "B"]) {
    const want = NODES[other(id)].name;
    const online = await waitFor(`${id} melihat ${want} online`, async () => {
      const st = await must(id, "get_network_status");
      return st.peers.some((p) => p.online && p.displayName === want);
    }).catch((e) => String(e.message));
    check(`${id} melihat ${want} online di jaringan kantor`, online === true, online === true ? "" : online);
  }

  for (const id of ["A", "B"]) {
    await reload(id);
    await setTheme(id, "Terang");
  }
  startPump();
});

if (ok1) {
  // Dokumen: salin otomatis, lalu bentrok dari dua laptop yang offline.
  await scenario("Dokumen dan bentrok", async () => {
    const [added] = await must("A", "add_documents", { paths: [XLSX_SRC], projectId: null });
    docId = added.id;
    const atB = await waitFor(
      "B menerima dokumen dan isinya tersalin otomatis",
      async () => {
        const d = await docByName("B", XLSX);
        return d?.current.available ? d : null;
      },
      60000,
    ).catch((e) => String(e.message));
    const okB = typeof atB === "object";
    check("B melihat RAB-proyek-a.xlsx dari A", okB && atB.id === docId && atB.current.received, okB ? "" : atB);
    check(
      "Isi versi 1 tersalin otomatis ke B (available true)",
      okB && atB.current.available,
      okB ? `ukuran ${atB.current.size} B, dari ${atB.createdBy.displayName}` : "",
    );
    await nav("B", "Dokumen");
    await refocus("B");
    await page("B").getByText(XLSX).first().waitFor({ timeout: 10000 });
    await shot("B", "sinkron-01-dokumen-diterima-b.png");

    // Keduanya mengedit saat tidak tersambung.
    await goOffline();
    try {
      const editA = await editOffline("A", docId, "revisi harga semen (Ayu)");
      const editB = await editOffline("B", docId, "revisi volume besi (Budi)");
      check(
        "A dan B masing-masing menyimpan versi baru saat offline",
        editA.current.origin === "edited" && editB.current.origin === "edited" && editA.current.blobHash !== editB.current.blobHash,
        `A ${editA.current.blobHash.slice(0, 8)}, B ${editB.current.blobHash.slice(0, 8)}`,
      );
    } finally {
      // Tersambung lagi juga saat gagal, supaya skenario berikutnya tetap jalan.
      await goOnline();
    }

    for (const id of ["A", "B"]) {
      const rekan = NODES[other(id)].name;
      const c = await waitFor(
        `${id} melihat bentrok dengan versi ${rekan}`,
        async () => conflictFrom(await docByName(id, XLSX), rekan),
        60000,
      ).catch((e) => String(e.message));
      const okC = typeof c === "object";
      check(
        `${id} menandai bentrok: dua kepala, versi rekan dari ${rekan}`,
        okC,
        okC ? `versi ${c.mine.number} milik sendiri, versi ${c.theirs.number} dari ${rekan}` : c,
      );
    }
    const bothHere = await waitFor(
      "isi kedua versi bentrok ada di kedua laptop",
      async () => {
        for (const id of ["A", "B"]) {
          const d = await docByName(id, XLSX);
          if (!d?.conflictVersions.every((v) => v.available)) return false;
        }
        return true;
      },
      60000,
    ).catch((e) => String(e.message));
    check("Isi versi rekan yang bentrok tersalin otomatis di kedua laptop", bothHere === true, bothHere === true ? "" : bothHere);

    for (const [id, file] of [
      ["A", "sinkron-02-bentrok-dari-rekan-a.png"],
      ["B", "sinkron-03-bentrok-dari-rekan-b.png"],
    ]) {
      await showConflict(id);
      const rekan = NODES[other(id)].name;
      const shown = await page(id)
        .getByText(new RegExp(`Versi \\d+ dari ${escapeRe(rekan)}`))
        .first()
        .isVisible()
        .catch(() => false);
      check(`Layar Dokumen ${id} menampilkan bentrok dengan nama ${rekan}`, shown);
      await shot(id, file);
    }
  });

  // Dokumen besar: tidak disalin otomatis, diunduh lewat tombol di B.
  await scenario("Dokumen besar", async () => {
    const bigPath = join(root, BIG);
    writeFileSync(bigPath, randomBytes(BIG_SIZE));
    const [big] = await must("A", "add_documents", { paths: [bigPath], projectId: null });
    const atB = await waitFor("B menerima dokumen besar", async () => docByName("B", BIG), 60000);
    await sleep(4000); // beri waktu kalau ternyata ikut disalin otomatis
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
    const done = await waitFor(
      "isi file besar ada di B setelah diunduh",
      async () => {
        const d = await docByName("B", BIG);
        if (d?.current.available) return d;
        const err = await p.getByText("File belum bisa diunduh").first().isVisible().catch(() => false);
        if (err) throw new Error(`layar B: ${(await p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 300)}`);
        return null;
      },
      120000,
    ).catch((e) => String(e.message));
    check(
      "Unduh dari rekan menyalin file 21 MB ke B",
      typeof done === "object" && done.current.size === BIG_SIZE,
      typeof done === "object" ? `${done.current.size} B` : done,
    );
    await refocus("B");
    await button.waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
    await shot("B", "sinkron-05-file-besar-sesudah-unduh-b.png");
  });

  // Tanda tangan berurutan: B lalu A.
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

    const atB = await waitFor(
      "B menerima permintaan dan filenya",
      async () => {
        const r = (await must("B", "sign_overview")).requests.find((x) => x.id === req.id);
        return r?.fileAvailable && r.myState === "your_turn" ? r : null;
      },
      60000,
    ).catch((e) => String(e.message));
    const okB = typeof atB === "object";
    check(
      "B menerima permintaan dari A, giliran B, file tersalin",
      okB && atB.fromPeer && atB.requestedByName === NODES.A.name,
      okB ? `fromPeer ${atB.fromPeer}, requestedByName ${atB.requestedByName}` : atB,
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

    const aTurn = await waitFor(
      "A menerima versi bertanda tangan B dan gilirannya tiba",
      async () => {
        const d = await getRequest("A", req.id);
        const me = d.signers.find((s) => s.isMe);
        return me?.canSignNow && d.fileAvailable && !d.pending ? d : null;
      },
      60000,
    ).catch((e) => String(e.message));
    const okA = typeof aTurn === "object";
    check(
      "A menerima versi bertanda tangan B, lalu giliran A",
      okA && aTurn.signedCount === 1 && aTurn.currentHash === bSigned.currentHash && aTurn.rejected.length === 0,
      okA ? `hash ${aTurn.currentHash.slice(0, 8)}, ditolak ${aTurn.rejected.length}` : aTurn,
    );

    await openSignList("A");
    await createSignature("A");
    await signThroughUi("A", req.id, "Semua sudah menandatangani. Dokumen dikunci dan halaman catatan ditambahkan.");
    await shot("A", "sinkron-08-tanda-tangan-selesai-a.png");

    const finalA = await getRequest("A", req.id);
    check(
      "A: permintaan selesai, kunci sah",
      finalA.status === "completed" && finalA.sealValid === true && finalA.signedCount === 2,
      `status ${finalA.status}, sealValid ${finalA.sealValid}`,
    );
    const finalB = await waitFor(
      "B menerima versi final dan kuncinya sah",
      async () => {
        const d = await getRequest("B", req.id);
        return d.status === "completed" && d.sealValid === true && d.fileAvailable ? d : null;
      },
      60000,
    ).catch((e) => String(e.message));
    const okF = typeof finalB === "object";
    check(
      "B: permintaan selesai, kunci sah, versi final sama dengan A",
      okF && finalB.currentHash === finalA.currentHash,
      okF ? `hash ${finalB.currentHash.slice(0, 8)}` : finalB,
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
  });

  // Satu screenshot mode gelap: bentrok di laptop A.
  await scenario("Mode gelap", async () => {
    await setTheme("A", "Gelap");
    await showConflict("A");
    const theme = await page("A").evaluate(() => document.documentElement.dataset.theme);
    check("Mode gelap diterapkan di layar Dokumen A", theme === "dark", String(theme));
    await shot("A", "sinkron-10-bentrok-gelap-a.png");
  });

  check(
    "Tidak ada record sinkron yang ditolak atau dibuang penerima",
    pump.stats.rejected === 0 && pump.stats.dropped === 0,
    `diterima ${pump.stats.accepted}, ditolak ${pump.stats.rejected}, dibuang ${pump.stats.dropped}, file dilayani ${pump.stats.served}`,
  );
}

// ---------------------------------------------------------------------------
// Bersih-bersih: hanya proses, kunci uji, dan folder dari run ini.

await stopPump();
for (const id of Object.keys(running)) await stop(id);
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
