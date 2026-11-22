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
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const exe = resolve(process.argv[2] ?? "src-tauri/target/release/mira.exe");
const shots = resolve(process.argv[3] ?? "docs/progress/screenshots");
const filesDir = resolve(process.argv[4] ?? "test-files");
const excelSave = join(dirname(fileURLToPath(import.meta.url)), "excel-save.ps1");
mkdirSync(shots, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "mira-docs-"));
const PORT = 9341;
const XLSX = "RAB-proyek-a.xlsx";
const DOCX = "laporan-bulanan.docx";
const PDF = "kontrak-draft.pdf";

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
  results.push({ name, ok, detail });
  console.log(`${ok ? "LULUS" : "GAGAL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      MIRA_DATA_DIR: dataDir,
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

try {
  // Jalankan 1
  let app = await launch();
  let { page } = app;
  await page.getByLabel("Nama tampilan").waitFor({ timeout: 20000 });
  await page.getByLabel("Nama tampilan").fill("Rina Uji");
  await page.getByRole("button", { name: "Simpan nama" }).click();
  await page.getByRole("button", { name: /Buat organisasi baru/ }).click();
  await page.getByLabel("Nama organisasi").fill("Kantor Uji");
  await page.getByRole("button", { name: "Buat organisasi" }).click();
  await page.getByRole("button", { name: "Pengaturan" }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Pengaturan" }).click();
  await page.getByLabel("Terang").check();
  await page.getByRole("button", { name: "Dokumen", exact: true }).click();
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
  const working = join(dataDir, "working", xlsxDoc.id, XLSX);
  check("Salinan kerja disiapkan", existsSync(working), working);

  let excelOk = false;
  try {
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", excelSave, "-Path", working, "-HoldSeconds", "3"],
      { encoding: "utf8", timeout: 120000 },
    );
    excelOk = out.includes("saved");
  } catch (err) {
    check("Excel (COM) menyimpan file", false, String(err?.message ?? err).slice(0, 200));
  }
  if (excelOk) check("Excel (COM) membuka, menyimpan, dan menutup salinan kerja", true);

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
  const wfile = join(wdir, DOCX);
  const lock = join(wdir, "~$poran-bulanan.docx");
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
  const finishWhileOpen = await invoke(page, "finish_edit", { documentId: docxDoc.id }).then(
    () => "ok",
    (e) => e.code,
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
  await page.getByRole("button", { name: "Pengaturan" }).click();
  await page.getByLabel("Gelap").check();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Dokumen", exact: true }).click();
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
  const xlsxWorking = join(dataDir, "working", xlsxDoc.id, XLSX);
  writeFileSync(xlsxWorking, Buffer.concat([readFileSync(xlsxWorking), Buffer.from("simpan saat Mira tertutup")]));
  app = await launch();
  page = app.page;
  await page.getByRole("button", { name: "Pengaturan" }).waitFor({ timeout: 20000 });
  const recovered = await waitFor(
    async () => {
      const d = await docByName(page, XLSX);
      return d.versionCount >= 4 && d.editing.length === 0 ? d : null;
    },
    20000,
    "pemulihan sesi saat start",
  );
  check("Simpanan saat Mira tertutup menjadi versi 4 setelah start", recovered.current.number === 4);
  await page.getByRole("button", { name: "Dokumen", exact: true }).click();
  await page.locator("li", { hasText: XLSX }).first().click();
  await page.getByText(/Versi 4/).first().waitFor({ timeout: 10000 });
  check("Riwayat versi tetap ada setelah restart", true);
  await stop(app);
} catch (err) {
  check("Skrip berjalan tanpa error", false, String(err?.message ?? err));
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
rmSync(dataDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} pemeriksaan lulus.`);
process.exit(failed ? 1 : 0);
