// Uji ujung ke ujung tanda tangan PDF (Tahap 5 bagian lokal) di satu laptop.
//
// Menjalankan mira.exe dengan folder data dan folder ekspor sendiri
// (MIRA_DATA_DIR, MIRA_EXPORT_DIR), lalu mengendalikan WebView2 lewat
// DevTools Protocol. Alur: buat organisasi, buat tanda tangan dengan mouse dan
// PIN, buka PDF uji, tempatkan tanda tangan dengan keyboard, PIN salah lalu
// benar, simpan salinan, periksa salinan (asli), ubah satu karakter di salinan
// dan di penyimpanan Mira, lalu pastikan peringatan muncul. Screenshot terang
// dan gelap.
//
// Pakai:  node scripts/sign-e2e.mjs <path mira.exe> <folder screenshot> <folder kerja>
// Folder kerja menampung data uji dan dihapus di akhir. PDF uji dibuat sendiri.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const exe = resolve(process.argv[2] ?? "src-tauri/target/debug/mira.exe");
const shots = resolve(process.argv[3] ?? "docs/progress/screenshots");
const work = resolve(process.argv[4] ?? "scratch-sign-e2e");
const dataDir = join(work, "data");
const exportDir = join(work, "ekspor");
const pdfPath = join(work, "kontrak-uji.pdf");
const PORT = 9341;
const PIN = "246810";
mkdirSync(shots, { recursive: true });
rmSync(work, { recursive: true, force: true });
mkdirSync(exportDir, { recursive: true });

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

async function makePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= 3; i++) {
    const p = doc.addPage([595.28, 841.89]);
    p.drawText(i === 1 ? "PERJANJIAN KERJA SAMA (DATA UJI)" : `Lampiran ${i - 1} (data uji)`, {
      x: 60, y: 770, size: 18, font: bold, color: rgb(0.1, 0.1, 0.1),
    });
    for (let l = 0; l < 20; l++) {
      p.drawText(`Pasal ${l + 1}. Teks contoh untuk uji tanda tangan Mira, halaman ${i}.`, {
        x: 60, y: 730 - l * 24, size: 11, font,
      });
    }
    if (i === 3) {
      p.drawText("Pihak Pertama", { x: 80, y: 190, size: 11, font });
      p.drawText("Pihak Kedua", { x: 380, y: 190, size: 11, font });
    }
  }
  writeFileSync(pdfPath, await doc.save());
}

async function launch() {
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      MIRA_DATA_DIR: dataDir,
      MIRA_EXPORT_DIR: exportDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
    stdio: "ignore",
  });
  let browser;
  for (let i = 0; i < 80 && !browser; i++) {
    await new Promise((r) => setTimeout(r, 500));
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
    if (!page) await new Promise((r) => setTimeout(r, 250));
  }
  await page.waitForLoadState("domcontentloaded");
  await page.setViewportSize({ width: 1280, height: 860 }).catch(() => {});
  return { child, browser, page };
}

async function stop({ child, browser }) {
  await browser.close().catch(() => {});
  try {
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* sudah berhenti */
  }
  await new Promise((r) => setTimeout(r, 1500));
}

function filesIn(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesIn(p) : [p];
  });
}

// Ganti satu karakter di metadata: Producer "Mira" (UTF-16 hex) jadi "Nira".
// PDF tetap terbaca, tapi hash berubah.
function flipOneChar(path) {
  const buf = readFileSync(path);
  const marker = Buffer.from("<FEFF004D006900720061>");
  const at = buf.indexOf(marker);
  if (at < 0) throw new Error(`Tidak menemukan teks untuk diubah di ${path}`);
  buf[at + 9] = "E".charCodeAt(0);
  writeFileSync(path, buf);
}

async function refocus(page) {
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(800);
}

const shot = (page, name) => page.screenshot({ path: join(shots, name) });

let app;
try {
  await makePdf();
  app = await launch();
  const { page } = app;

  // Organisasi baru di laptop uji.
  await page.getByLabel("Nama tampilan").waitFor({ timeout: 30000 });
  await page.getByLabel("Nama tampilan").fill("Rina Uji");
  await page.getByRole("button", { name: "Simpan nama" }).click();
  await page.getByRole("button", { name: /Buat organisasi baru/ }).click();
  await page.getByLabel("Nama organisasi").fill("Kantor Uji");
  await page.getByRole("button", { name: "Buat organisasi" }).click();
  const skip = page.getByRole("button", { name: /Lewati/ });
  await skip.waitFor({ timeout: 15000 }).then(() => skip.click()).catch(() => {});
  await page.getByRole("button", { name: "Tanda tangan", exact: true }).click();
  await page.getByRole("button", { name: "Buat tanda tangan" }).first().waitFor({ timeout: 15000 });
  check("Layar Tanda tangan terbuka", true);
  await shot(page, "t5-01-tanda-tangan-kosong-terang.png");

  // Buat tanda tangan dengan mouse.
  await page.getByRole("button", { name: "Buat tanda tangan" }).first().click();
  const pad = page.getByRole("img", { name: /Kotak menggambar tanda tangan/ }).or(page.locator("canvas").first());
  await pad.first().waitFor();
  const box = await pad.first().boundingBox();
  const y0 = box.y + box.height * 0.6;
  await page.mouse.move(box.x + box.width * 0.15, y0);
  await page.mouse.down();
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    await page.mouse.move(box.x + box.width * (0.15 + 0.7 * t), y0 - Math.sin(t * Math.PI * 3) * box.height * 0.25, { steps: 2 });
  }
  await page.mouse.up();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.75);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.72, { steps: 12 });
  await page.mouse.up();
  await shot(page, "t5-02-gambar-tanda-tangan.png");
  await page.getByRole("button", { name: "Lanjut ke PIN" }).click();
  await page.getByLabel("PIN baru").fill(PIN);
  await page.getByLabel("Ulangi PIN").fill(PIN);
  await page.getByRole("button", { name: "Simpan tanda tangan" }).click();
  await page.getByText(/Tersimpan sejak/).waitFor({ timeout: 20000 });
  check("Tanda tangan tersimpan dengan PIN", true);

  // Buka PDF dan buat permintaan untuk diri sendiri.
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: "Pilih PDF untuk ditandatangani" }).click(),
  ]);
  await chooser.setFiles(pdfPath);
  await page.getByRole("button", { name: "Buat permintaan" }).waitFor({ timeout: 15000 });
  await shot(page, "t5-03-permintaan-baru.png");
  await page.getByRole("button", { name: "Buat permintaan" }).click();
  await page.getByRole("button", { name: "Tempatkan tanda tangan" }).waitFor({ timeout: 20000 });
  await page.locator("canvas").first().waitFor({ timeout: 20000 });
  check("PDF terbuka di penampil", true);

  // Ke halaman 3, tempatkan dengan keyboard.
  for (let i = 0; i < 2; i++) await page.getByRole("button", { name: /Berikutnya/ }).click();
  await page.getByRole("button", { name: "Tempatkan tanda tangan" }).click();
  const placed = page.getByRole("group", { name: /Kotak tanda tangan/ });
  await placed.waitFor();
  await placed.focus();
  const before = await placed.boundingBox();
  for (let i = 0; i < 6; i++) await page.keyboard.press("Shift+ArrowUp");
  for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("+");
  const after = await placed.boundingBox();
  const moved = after.y < before.y - 20 && after.x < before.x - 20 && after.width > before.width;
  check(
    "Kotak tanda tangan bisa digeser dan dibesarkan dengan keyboard",
    moved,
    `x ${Math.round(before.x)} ke ${Math.round(after.x)}, y ${Math.round(before.y)} ke ${Math.round(after.y)}, lebar ${Math.round(before.width)} ke ${Math.round(after.width)}`,
  );
  await shot(page, "t5-04-tempatkan-terang.png");

  // PIN salah lalu benar.
  await page.getByRole("button", { name: "Selesai dan tanda tangani" }).click();
  const pinField = page.getByRole("dialog").getByLabel(/PIN/).first();
  await pinField.fill("111111");
  await page.keyboard.press("Enter");
  await page.getByText(/PIN salah/).waitFor({ timeout: 20000 });
  check("PIN salah ditolak dengan sisa percobaan", true);
  await shot(page, "t5-05-pin-salah.png");
  await pinField.fill(PIN);
  await page.keyboard.press("Enter");
  await page.getByText("Semua sudah menandatangani. Dokumen dikunci dan halaman catatan ditambahkan.").waitFor({ timeout: 30000 });
  check("PDF ditandatangani, dikunci, halaman catatan ditambahkan", true);
  await page.waitForTimeout(1500);
  await shot(page, "t5-06-selesai-terkunci-terang.png");
  // Hasil stempel di halaman 3 (gulir ke bawah) dan halaman catatan.
  const sheet = page.locator("canvas").first();
  const sb = await sheet.boundingBox();
  await page.mouse.move(sb.x + sb.width / 2, sb.y + 200);
  await page.mouse.wheel(0, 2000);
  await page.waitForTimeout(600);
  await shot(page, "t5-06b-stempel-halaman-3.png");
  await page.getByRole("button", { name: /Berikutnya/ }).click();
  await page.waitForTimeout(1200);
  await page.mouse.wheel(0, -2000);
  await page.waitForTimeout(400);
  await shot(page, "t5-06c-halaman-catatan.png");

  // Simpan salinan.
  await page.getByRole("button", { name: "Simpan salinan PDF" }).click();
  await page.locator(".sdoc-path").first().waitFor({ timeout: 15000 });
  const exported = filesIn(exportDir).filter((f) => f.endsWith(".pdf"));
  check("Salinan PDF tersimpan di folder ekspor", exported.length === 1, exported[0] ?? "tidak ada");
  const exportedBytes = readFileSync(exported[0]);
  const signedDoc = await PDFDocument.load(exportedBytes);
  check("Salinan punya 4 halaman (3 + halaman catatan)", signedDoc.getPageCount() === 4, String(signedDoc.getPageCount()));

  // Kembali ke daftar, periksa salinan asli.
  await page.getByRole("button", { name: "Kembali", exact: true }).first().click();
  const verify = async (path, expected, name) => {
    await page.getByRole("button", { name: "Periksa file PDF" }).click();
    const [fc] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByRole("dialog").getByRole("button", { name: /Pilih file PDF|Periksa file lain/ }).click(),
    ]);
    await fc.setFiles(path);
    await page.getByText(expected).waitFor({ timeout: 15000 });
    await shot(page, name);
    await page.keyboard.press("Escape");
  };
  await verify(exported[0], /File ini asli/, "t5-07-periksa-asli.png");
  check("Periksa file: salinan asli dikenali", true);

  // Ubah satu karakter di salinan.
  flipOneChar(exported[0]);
  await refocus(page);
  await page.getByText(/salinan PDF yang disimpan di luar Mira berubah/i).first().waitFor({ timeout: 15000 });
  check("Salinan yang diubah memunculkan peringatan di daftar", true);
  await verify(exported[0], /File ini berubah setelah ditandatangani/, "t5-08-periksa-berubah.png");
  check("Periksa file: salinan yang diubah ditandai berubah", true);

  // Ubah satu karakter di penyimpanan Mira.
  const stored = filesIn(join(dataDir, "ttd-berkas")).find((f) => readFileSync(f).equals(exportedBytes));
  check("File final ada di penyimpanan Mira", Boolean(stored), stored ?? "");
  flipOneChar(stored);
  await refocus(page);
  await page.getByText("Isi file berubah sejak ditandatangani").first().waitFor({ timeout: 15000 });
  check("File di penyimpanan yang diubah memunculkan peringatan", true);
  await shot(page, "t5-09-peringatan-terang.png");

  // Mode gelap.
  await page.getByRole("button", { name: "Pengaturan" }).click();
  await page.getByLabel("Gelap").check();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Tanda tangan", exact: true }).click();
  await page.getByText("Isi file berubah sejak ditandatangani").first().waitFor({ timeout: 15000 });
  await shot(page, "t5-10-daftar-gelap.png");
  await page.getByText("kontrak-uji", { exact: false }).first().click();
  await page.locator("canvas").first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);
  await shot(page, "t5-11-dokumen-gelap.png");
  check("Mode gelap diterapkan di layar tanda tangan", (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark");
} catch (err) {
  check("Skrip berjalan tanpa error", false, String(err?.message ?? err).split("\n")[0]);
  if (app) await app.page.screenshot({ path: join(work, "gagal.png") }).catch(() => {});
} finally {
  if (app) await stop(app);
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
if (!results.some((r) => !r.ok)) rmSync(work, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} pemeriksaan lulus.`);
process.exit(failed ? 1 : 0);
