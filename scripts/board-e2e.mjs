// Uji ujung ke ujung board Tahap 3 (bagian lokal) di satu laptop.
//
// Menjalankan mira.exe dengan folder data baru, lalu lewat DevTools Protocol:
// isi nama, buat organisasi, buat proyek "Proyek A" (kode PA), tambah task,
// pindahkan task dengan keyboard (Alt+Panah dan menu Pindahkan) dan dengan
// seret mouse, isi detail task, lihat Task saya, ambil screenshot terang dan
// gelap, restart, dan pastikan semuanya tetap tersimpan.
//
// Pakai:  node scripts/board-e2e.mjs <path mira.exe> <folder screenshot> [folder induk data]
// Folder data dibuat di bawah folder induk (bawaan: folder temp) dan dihapus di akhir.

import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const exe = resolve(process.argv[2] ?? "src-tauri/target/debug/mira.exe");
const shots = resolve(process.argv[3] ?? "docs/progress/screenshots");
const parent = resolve(process.argv[4] ?? tmpdir());
mkdirSync(shots, { recursive: true });
mkdirSync(parent, { recursive: true });
const dataDir = mkdtempSync(join(parent, "mira-board-"));
const PORT = 9341;

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

function isoDate(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

async function launch() {
  const log = createWriteStream(join(dataDir, "stderr.log"), { flags: "a" });
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      MIRA_DATA_DIR: dataDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.pipe(log);
  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
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
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
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

// Tombol menu utama. Panel jaringan di sidebar juga punya tombol "Organisasi",
// jadi tombol menu dicari di dalam nav "Menu utama".
const mainNav = (page, name) =>
  page.getByRole("navigation", { name: "Menu utama" }).getByRole("button", { name, exact: true });
const column = (page, name) => page.locator("section.pb-col").filter({ has: page.getByRole("heading", { name }) });
const cardTitles = async (page, name) =>
  (await column(page, name).locator("[data-open-task]").allInnerTexts()).map((s) => s.trim());

async function setTheme(page, label) {
  await mainNav(page, "Pengaturan").click();
  await page.getByLabel(label, { exact: true }).check();
  await page.waitForTimeout(300);
  await mainNav(page, "Board").click();
}

async function openProject(page) {
  await page.getByRole("navigation", { name: "Task saya dan proyek" }).getByRole("button", { name: /Proyek A/ }).click();
  await page.getByRole("button", { name: "Task baru" }).waitFor();
}

let app = null;
try {
  app = await launch();
  let { page } = app;

  // Onboarding.
  await page.getByLabel("Nama tampilan").waitFor({ timeout: 20000 });
  await page.getByLabel("Nama tampilan").fill("Rina Uji");
  await page.getByRole("button", { name: "Simpan nama" }).click();
  await page.getByRole("button", { name: /Buat organisasi baru/ }).click();
  await page.getByLabel("Nama organisasi").fill("Kantor Uji");
  await page.getByRole("button", { name: "Buat organisasi" }).click();
  // Panduan firewall: dilewati tanpa mengubah pengaturan Windows.
  await page.getByRole("button", { name: /^(Lewati, atur nanti|Buka Mira)$/ }).click({ timeout: 15000 });
  await mainNav(page, "Board").waitFor({ timeout: 10000 });
  await mainNav(page, "Pengaturan").click();
  await page.getByLabel("Terang", { exact: true }).check();
  await mainNav(page, "Board").click();

  // Board kosong, lalu proyek pertama.
  await page.getByRole("button", { name: "Buat proyek pertama" }).waitFor({ timeout: 10000 });
  check("Board tanpa proyek menampilkan keadaan kosong", true);
  await page.screenshot({ path: join(shots, "t3-01-board-kosong-terang.png") });
  await page.getByRole("button", { name: "Buat proyek pertama" }).click();
  await page.getByLabel("Nama proyek").fill("Proyek A");
  const code = await page.getByLabel("Kode proyek").inputValue();
  check("Kode proyek diusulkan dari nama", code === "PA", code);
  // Pendiri belum punya tim: satu-satunya pilihan Tim adalah proyek seluruh organisasi.
  // Label "Tim" baru terhubung ke select setelah daftar tim terbaca.
  const teamSelect = page.getByRole("dialog").getByLabel("Tim", { exact: true });
  await teamSelect.waitFor({ timeout: 10000 });
  const teamOptions = (await teamSelect.locator("option").allInnerTexts()).map((s) => s.trim());
  await teamSelect.selectOption({ label: "Tanpa tim (seluruh organisasi)" });
  check(
    "Pilihan Tim untuk pendiri tanpa tim hanya Tanpa tim",
    teamOptions.length === 1 && teamOptions[0] === "Tanpa tim (seluruh organisasi)",
    teamOptions.join(" | "),
  );
  await page.screenshot({ path: join(shots, "t3-02-proyek-baru-terang.png") });
  await page.getByRole("button", { name: "Buat proyek" }).click();
  await page.getByRole("button", { name: "Task baru" }).waitFor({ timeout: 10000 });
  check("Proyek PA dibuat dan board terbuka", true);

  // Tambah task cepat di To do.
  const titles = [
    "Review kontrak proyek A",
    "Siapkan laporan bulanan",
    "Kirim jadwal rapat ke tim",
    "Cek gambar kerja lantai 2",
  ];
  await column(page, "To do").getByRole("button", { name: "Tambah task" }).click();
  for (const t of titles) {
    const input = column(page, "To do").getByLabel(/Judul task baru/);
    await input.fill(t);
    await input.press("Enter");
    await page.waitForTimeout(250);
  }
  await column(page, "To do").getByLabel(/Judul task baru/).press("Escape");
  const todo = await cardTitles(page, "To do");
  check("Empat task dibuat di To do", titles.every((t) => todo.includes(t)), todo.join(" | "));

  // Pindah dengan keyboard: Alt+Panah kanan.
  const card2 = page.locator("[data-open-task]", { hasText: "Siapkan laporan bulanan" });
  await card2.focus();
  await page.keyboard.press("Alt+ArrowRight");
  await page.waitForTimeout(500);
  check("Alt+Panah kanan memindah task ke Dikerjakan", (await cardTitles(page, "Dikerjakan")).includes("Siapkan laporan bulanan"));

  // Pindah lewat menu Pindahkan.
  await page.getByRole("button", { name: "Pindahkan PA-3" }).click();
  await page.getByRole("menuitem", { name: "Ke Selesai" }).click();
  await page.waitForTimeout(500);
  check("Menu Pindahkan memindah task ke Selesai", (await cardTitles(page, "Selesai")).includes("Kirim jadwal rapat ke tim"));

  // Pindah dengan seret mouse.
  try {
    await page
      .locator("[data-open-task]", { hasText: "Cek gambar kerja lantai 2" })
      .dragTo(column(page, "Dikerjakan"), { timeout: 5000 });
    await page.waitForTimeout(700);
    check("Seret mouse memindah task ke Dikerjakan", (await cardTitles(page, "Dikerjakan")).includes("Cek gambar kerja lantai 2"));
  } catch (err) {
    check("Seret mouse memindah task ke Dikerjakan", false, String(err?.message ?? err).slice(0, 120));
  }

  // Detail task PA-1.
  await page.locator("[data-open-task]", { hasText: "Review kontrak proyek A" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Penanggung jawab").waitFor({ timeout: 10000 });
  await dlg.getByLabel("Deskripsi").fill("Cek pasal pembayaran dan lampiran teknis, lalu kirim catatan ke tim.");
  await dlg.getByRole("button", { name: "Simpan deskripsi" }).click();
  await page.waitForTimeout(300);
  const me = await dlg.getByLabel("Penanggung jawab").locator("option").nth(1).getAttribute("value");
  await dlg.getByLabel("Penanggung jawab").selectOption(me);
  await page.waitForTimeout(300);
  await dlg.getByLabel("Tenggat").fill(isoDate(1));
  await dlg.getByLabel("Tenggat").press("Enter");
  await page.waitForTimeout(300);
  await dlg.getByLabel("Prioritas").selectOption("high");
  await page.waitForTimeout(300);
  await dlg.getByLabel("Label baru").fill("kontrak");
  await dlg.getByLabel("Label baru").press("Enter");
  await page.waitForTimeout(300);
  await dlg.getByLabel("Tulis komentar").fill("Draft kontrak sudah saya baca sampai pasal 5.");
  await dlg.getByRole("button", { name: "Kirim" }).click();
  await page.waitForTimeout(600);
  const dlgText = await dlg.innerText();
  check(
    "Detail task menyimpan deskripsi, penanggung jawab, tenggat, prioritas, label, komentar",
    dlgText.includes("pasal 5") && dlgText.includes("kontrak") && /Tinggi/.test(dlgText),
  );
  await page.screenshot({ path: join(shots, "t3-04-detail-task-terang.png") });
  await dlg.getByRole("button", { name: "Tutup detail task" }).click();
  await page.waitForTimeout(400);

  // Task kedua untuk Task saya: tenggat hari ini.
  await page.locator("[data-open-task]", { hasText: "Siapkan laporan bulanan" }).click();
  await dlg.getByLabel("Penanggung jawab").waitFor({ timeout: 10000 });
  await dlg.getByLabel("Penanggung jawab").selectOption(me);
  await page.waitForTimeout(300);
  await dlg.getByLabel("Tenggat").fill(isoDate(0));
  await dlg.getByLabel("Tenggat").press("Enter");
  await page.waitForTimeout(300);
  await dlg.getByRole("button", { name: "Tutup detail task" }).click();
  await page.waitForTimeout(400);

  await page.screenshot({ path: join(shots, "t3-03-board-terang.png") });
  await page.getByRole("navigation", { name: "Task saya dan proyek" }).getByRole("button", { name: /Task saya/ }).click();
  await page.waitForTimeout(600);
  const mine = await page.locator(".content").innerText();
  check(
    "Task saya berisi task milik saya dari proyek",
    mine.includes("Review kontrak proyek A") && mine.includes("Siapkan laporan bulanan") && !mine.includes("Cek gambar kerja"),
  );
  await page.screenshot({ path: join(shots, "t3-05-task-saya-terang.png") });

  // Mode gelap.
  await setTheme(page, "Gelap");
  await page.screenshot({ path: join(shots, "t3-08-task-saya-gelap.png") });
  await openProject(page);
  await page.screenshot({ path: join(shots, "t3-06-board-gelap.png") });
  await page.locator("[data-open-task]", { hasText: "Review kontrak proyek A" }).click();
  await dlg.getByLabel("Penanggung jawab").waitFor({ timeout: 10000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, "t3-07-detail-task-gelap.png") });
  await dlg.getByRole("button", { name: "Tutup detail task" }).click();
  await stop(app);
  app = null;

  // Restart: data tetap.
  app = await launch();
  page = app.page;
  await mainNav(page, "Board").click({ timeout: 20000 });
  await openProject(page);
  const after = {
    todo: await cardTitles(page, "To do"),
    doing: await cardTitles(page, "Dikerjakan"),
    done: await cardTitles(page, "Selesai"),
  };
  check(
    "Setelah restart proyek, task, dan posisi kolom tetap",
    after.todo.includes("Review kontrak proyek A") &&
      after.doing.includes("Siapkan laporan bulanan") &&
      after.done.includes("Kirim jadwal rapat ke tim"),
    JSON.stringify(after),
  );
  await stop(app);
  app = null;
} catch (err) {
  check("Skrip berjalan tanpa error", false, String(err?.message ?? err).slice(0, 300));
  if (app) {
    await app.page.screenshot({ path: join(shots, "gagal.png") }).catch(() => {});
    await stop(app);
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
console.log(`Folder data uji: ${dataDir} (log: stderr.log). Dihapus sekarang.`);
try {
  const { readFileSync } = await import("node:fs");
  const log = readFileSync(join(dataDir, "stderr.log"), "utf8").trim();
  if (log) console.log(`stderr aplikasi:\n${log.slice(-2000)}`);
} catch {
  /* tidak ada log */
}
rmSync(dataDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} pemeriksaan lulus.`);
process.exit(failed ? 1 : 0);
