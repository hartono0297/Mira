// Uji ujung ke ujung pustaka dokumen (Tahap 4, satu laptop).
//
// Menjalankan mira.exe dengan folder data sementara (MIRA_DATA_DIR) dan
// MIRA_TEST_NO_LAUNCH=1 (tombol Edit menyiapkan salinan kerja tanpa membuka
// jendela Office), lalu mengendalikan WebView2 lewat DevTools Protocol.
// Alur: buat organisasi, tambah file, Edit di Excel, simpan lewat instance
// Excel sendiri (COM, tidak terlihat, pola simpan Excel yang asli), lihat
// versi 2 muncul dan tanda "Sedang diedit" hilang setelah file ditutup,
// pulihkan versi 1, ulangi dengan pola simpan Word yang ditiru dari skrip,
// mode gelap, restart dan pastikan riwayat tetap ada.
//
// Pakai:  node scripts/smoke-docs-e2e.mjs <path mira.exe> <folder screenshot> <folder file uji>
// Folder file uji berisi RAB-proyek-a.xlsx, laporan-bulanan.docx, kontrak-draft.pdf.

import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { mainNav, newOffice } from "./e2e-onboarding.mjs";
import { deleteOwnKeys, miraCredentials } from "./e2e-keys.mjs";

const exe = resolve(process.argv[2] ?? "src-tauri/target/release/mira.exe");
const shots = resolve(process.argv[3] ?? "docs/progress/screenshots");
const filesDir = resolve(process.argv[4] ?? "test-files");
const excelSave = join(dirname(fileURLToPath(import.meta.url)), "excel-save.ps1");
mkdirSync(shots, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "mira-docs-"));

// Salinan kerja di <data>/working/<id dokumen>/. Mira memendekkan nama file kalau
// path lengkapnya lebih dari 200 karakter (batas Office), jadi nama aslinya dibaca
// dari folder, bukan diandaikan sama dengan nama dokumen.
function workingFile(docId) {
  const dir = join(dataDir, "working", docId);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith("~")) : [];
  return join(dir, files.length === 1 ? files[0] : "(salinan kerja tidak ada)");
}
// Geser semua port (debug WebView2 dan QUIC) supaya bisa jalan berdampingan dengan uji lain di PC yang sama.
const PORT_OFFSET = Number(process.env.E2E_PORT_OFFSET ?? 0) || 0;
const PORT = 9341 + PORT_OFFSET;
const XLSX = "RAB-proyek-a.xlsx";
const DOCX = "laporan-bulanan.docx";
const PDF = "kontrak-draft.pdf";

const credentialsBefore = miraCredentials();

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "LULUS" : "GAGAL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// PID Excel yang dijalankan sebagai server otomatisasi (bukan Excel yang dibuka user).
function automationExcelPids() {
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='EXCEL.EXE'\" | Where-Object { $_.CommandLine -match '(?i)/automation' } | ForEach-Object { $_.ProcessId }",
      ],
      { encoding: "utf8" },
    );
    return new Set(out.split(/\s+/).filter(Boolean).map(Number));
  } catch {
    return new Set();
  }
}

async function launch() {
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      MIRA_DATA_DIR: dataDir,
      MIRA_DISABLE_MDNS: "1",
      MIRA_UPDATER_ENDPOINT: "http://127.0.0.1:9/latest.json",
      ...(PORT_OFFSET ? { MIRA_PORT: String(47800 + PORT_OFFSET) } : {}),
      MIRA_TEST_NO_LAUNCH: "1",
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
    stdio: "ignore",
  });
  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
    await sleep(500);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    } catch {
      /* belum siap */
    }
  }
  if (!browser) throw new Error("WebView2 tidak bisa dihubungi lewat CDP");
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages())[0];
    if (!page) await sleep(250);
  }
  await page.waitForLoadState("domcontentloaded");
  return { child, browser, page };
}

async function stop({ child, browser }) {
  await browser.close().catch(() => {});
  try {
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* sudah berhenti */
  }
  await sleep(1500);
}

const invoke = (page, cmd, args) =>
  page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);

async function docByName(page, name) {
  const list = await invoke(page, "list_documents", { projectId: null });
  return list.find((d) => d.name === name);
}

async function waitFor(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Menunggu terlalu lama: ${label}`);
    await sleep(300);
  }
}

// Nama aksesibel tombol baris = teks tombol + nama file, misalnya "Edit di Excel RAB-proyek-a.xlsx".
const rowButton = (page, fileName, label) =>
  page.getByRole("button", { name: `${label} ${fileName}`, exact: true });

let app = null;
let page = null;
try {
  // Jalankan 1
  app = await launch();
  page = app.page;
  await newOffice(page, { name: "Rina Uji", org: "Kantor Uji", dept: "Desain" });
  await mainNav(page, "Pengaturan").click();
  await page.getByLabel("Terang").check();
  await mainNav(page, "Dokumen").click();
  await page.getByText(/masih kosong/).waitFor({ timeout: 10000 });
  check("Layar Dokumen kosong tampil", true);
  await page.screenshot({ path: join(shots, "12-dokumen-kosong-terang.png") });

  // Dialog pilih file adalah jendela Windows; uji memanggil command yang sama
  // yang dipanggil tampilan setelah file dipilih.
  const paths = [XLSX, DOCX, PDF].map((n) => join(filesDir, n));
  const added = await invoke(page, "add_documents", { paths, projectId: null });
  check("Tiga file ditambahkan", added.length === 3, added.map((d) => d.name).join(", "));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByText(XLSX).first().waitFor({ timeout: 10000 });
  const again = await invoke(page, "add_documents", { paths: [paths[0]], projectId: null });
  check("Nama sama diberi akhiran (2)", again[0]?.name === "RAB-proyek-a (2).xlsx", again[0]?.name);

  // Edit di Excel
  await page.locator("li", { hasText: XLSX }).first().click();
  await rowButton(page, XLSX, "Edit di Excel").click();
  await page.getByText(/Sedang Anda edit di Excel/).waitFor({ timeout: 10000 });
  check("Tanda Sedang diedit tampil", true);
  await page.screenshot({ path: join(shots, "13-dokumen-sedang-diedit-terang.png") });
  const xlsxDoc = await docByName(page, XLSX);
  const working = workingFile(xlsxDoc.id);
  check("Salinan kerja disiapkan", existsSync(working), working);

  if (process.env.MIRA_E2E_REAL_EXCEL === "1") {
    // Excel asli lewat COM (butuh Office berlisensi; Office tanpa lisensi
    // membuka dialog kunci produk yang menahan otomatisasi).
    const excelBefore = automationExcelPids();
    try {
      const out = execFileSync(
        "powershell",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", excelSave, "-Path", working],
        { encoding: "utf8", timeout: 120000 },
      );
      check("Excel (COM) membuka, menyimpan, dan menutup salinan kerja", out.includes("saved"));
    } catch (err) {
      check("Excel (COM) menyimpan file", false, String(err?.message ?? err).slice(0, 200));
    }
    // Excel otomatisasi yang dibuat langkah ini saja yang ditutup kalau masih ada.
    for (const pid of automationExcelPids()) {
      if (!excelBefore.has(pid)) {
        try {
          execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
        } catch {
          /* sudah berhenti */
        }
      }
    }
  } else {
    // Pola simpan Excel ditiru urutannya: kunci ~$, file sementara 8 karakter
    // tanpa ekstensi, file asli diganti nama, file sementara jadi nama asli.
    const xdir = dirname(working);
    const xlock = join(xdir, "~$" + basename(working));
    writeFileSync(xlock, "Rina Uji");
    await sleep(1000);
    writeFileSync(join(xdir, "A1B2C3D4"), Buffer.concat([readFileSync(working), Buffer.from("baris baru")]));
    renameSync(working, join(xdir, "5E6F7A8B"));
    renameSync(join(xdir, "A1B2C3D4"), working);
    unlinkSync(join(xdir, "5E6F7A8B"));
    await sleep(2500);
    unlinkSync(xlock);
  }

  const afterSave = await waitFor(
    async () => {
      const d = await docByName(page, XLSX);
      return d.versionCount >= 2 && d.editing.length === 0 ? d : null;
    },
    30000,
    "versi 2 dan sesi edit selesai",
  );
  check("Simpan di Excel membuat versi 2", afterSave.current.number === 2 && afterSave.current.origin === "edited");
  check("Tanda Sedang diedit hilang setelah Excel menutup file", afterSave.editing.length === 0);
  check("Folder salinan kerja dibersihkan", !existsSync(working));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByText(/Versi 2/).first().waitFor({ timeout: 10000 });
  await page.screenshot({ path: join(shots, "14-dokumen-versi-baru-terang.png") });

  // Pulihkan versi 1
  await page.getByRole("button", { name: "Pulihkan versi 1" }).click();
  await page.getByRole("dialog").waitFor();
  await page.screenshot({ path: join(shots, "15-dokumen-pulihkan-konfirmasi-terang.png") });
  await page.getByRole("dialog").getByRole("button", { name: /Pulihkan versi 1/ }).click();
  await page.getByText(/Dipulihkan dari versi 1/).first().waitFor({ timeout: 10000 });
  const detail = await invoke(page, "get_document", { documentId: xlsxDoc.id });
  const v1 = detail.versions.find((v) => v.number === 1);
  const v3 = detail.versions.find((v) => v.number === 3);
  check(
    "Pulihkan membuat versi 3 berisi isi versi 1",
    v3?.origin === "restored" && v3?.blobHash === v1?.blobHash && v3?.isHead,
    `v1 ${v1?.blobHash?.slice(0, 8)}, v3 ${v3?.blobHash?.slice(0, 8)}`,
  );
  check("Riwayat tetap menyimpan versi 2", detail.versions.length === 3);
  await page.screenshot({ path: join(shots, "16-dokumen-dipulihkan-terang.png") });

  // Edit di Word dengan pola simpan Word yang ditiru (file kunci, file
  // sementara, rename), karena Word lewat COM tidak bisa diotomasi di laptop uji.
  await page.locator("li", { hasText: DOCX }).first().click();
  await rowButton(page, DOCX, "Edit di Word").click();
  await page.getByText(/Sedang Anda edit di Word/).waitFor({ timeout: 10000 });
  const docxDoc = await docByName(page, DOCX);
  const wdir = join(dataDir, "working", docxDoc.id);
  const wfile = workingFile(docxDoc.id);
  const lock = join(wdir, "~$" + basename(wfile).slice(2));
  writeFileSync(lock, "Rina Uji");
  await sleep(1000);
  writeFileSync(join(wdir, "~WRL0001.tmp"), Buffer.concat([readFileSync(wfile), Buffer.from("revisi bab 3")]));
  renameSync(wfile, join(wdir, "~WRD0000.tmp"));
  renameSync(join(wdir, "~WRL0001.tmp"), wfile);
  unlinkSync(join(wdir, "~WRD0000.tmp"));
  const wordV2 = await waitFor(
    async () => {
      const d = await docByName(page, DOCX);
      return d.versionCount >= 2 ? d : null;
    },
    20000,
    "versi 2 docx",
  );
  check("Pola simpan Word membuat tepat satu versi baru", wordV2.versionCount === 2 && wordV2.editing.length === 1);
  // Error ditangkap di dalam halaman supaya kodenya tidak hilang di page.evaluate.
  const finishWhileOpen = await page.evaluate(
    (id) =>
      window.__TAURI_INTERNALS__.invoke("finish_edit", { documentId: id }).then(
        () => "ok",
        (e) => e?.code ?? String(e),
      ),
    docxDoc.id,
  );
  check("Selesai mengedit ditolak selama file masih terbuka", finishWhileOpen === "document_editing", finishWhileOpen);
  unlinkSync(lock);
  const wordDone = await waitFor(
    async () => {
      const d = await docByName(page, DOCX);
      return d.editing.length === 0 ? d : null;
    },
    20000,
    "sesi Word selesai",
  );
  check("Sesi Word selesai setelah kunci ~$ hilang", wordDone.versionCount === 2);

  // Mode gelap
  await mainNav(page, "Pengaturan").click();
  await page.getByLabel("Gelap").check();
  await page.waitForTimeout(300);
  await mainNav(page, "Dokumen").click();
  await page.locator("li", { hasText: XLSX }).first().click();
  await page.getByText(/Dipulihkan dari versi 1/).first().waitFor({ timeout: 10000 });
  await page.screenshot({ path: join(shots, "17-dokumen-riwayat-gelap.png") });
  await rowButton(page, XLSX, "Edit di Excel").click();
  await page.getByText(/Sedang Anda edit di Excel/).waitFor({ timeout: 10000 });
  await page.screenshot({ path: join(shots, "18-dokumen-sedang-diedit-gelap.png") });
  await stop(app);

  // Jalankan 2: riwayat tetap ada setelah restart, dan sesi edit yang masih
  // terbuka saat Mira ditutup dipulihkan (tanpa kunci: file dianggap sudah
  // ditutup, simpanan terakhir menjadi versi baru).
  const xlsxWorking = workingFile(xlsxDoc.id);
  writeFileSync(xlsxWorking, Buffer.concat([readFileSync(xlsxWorking), Buffer.from("simpan saat Mira tertutup")]));
  app = await launch();
  page = app.page;
  await mainNav(page, "Pengaturan").waitFor({ timeout: 20000 });
  const recovered = await waitFor(
    async () => {
      const d = await docByName(page, XLSX);
      return d.versionCount >= 4 && d.editing.length === 0 ? d : null;
    },
    20000,
    "pemulihan sesi saat start",
  );
  check("Simpanan saat Mira tertutup menjadi versi 4 setelah start", recovered.current.number === 4);
  await mainNav(page, "Dokumen").click();
  await page.locator("li", { hasText: XLSX }).first().click();
  await page.getByText(/Versi 4/).first().waitFor({ timeout: 10000 });
  check("Riwayat versi tetap ada setelah restart", true);
  await stop(app);
  app = null;
} catch (err) {
  check("Skrip berjalan tanpa error", false, String(err?.message ?? err));
  if (page) {
    const shot = join(tmpdir(), "mira-docs-e2e-gagal.png");
    await page.screenshot({ path: shot }).catch(() => {});
    const text = await page.locator("body").innerText().catch(() => "");
    console.log(`Screenshot saat gagal: ${shot}
Isi layar: ${text.slice(0, 600)}`);
  }
  if (app) await stop(app);
}

// Hanya kunci laptop uji skrip ini (dari mira.db di folder datanya) yang dihapus.
await deleteOwnKeys({ before: credentialsBefore, dirs: [dataDir] });
try {
  rmSync(dataDir, { recursive: true, force: true });
} catch (err) {
  console.log(`Folder data uji tidak bisa dihapus: ${dataDir} (${err.code})`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} pemeriksaan lulus.`);
process.exit(failed ? 1 : 0);
