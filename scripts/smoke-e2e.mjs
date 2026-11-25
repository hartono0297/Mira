// Uji asap ujung ke ujung untuk build Mira di Windows.
//
// Menjalankan mira.exe dengan folder data sementara (MIRA_DATA_DIR), lalu
// mengendalikan WebView2 lewat Chrome DevTools Protocol (port debug lokal).
// Alur: firewall, kantor belum ditemukan, lihat "Pakai kode undangan", buat
// kantor baru (organisasi, nama, departemen), restart,
// pastikan langsung masuk kerangka utama, ganti mode tema, restart lagi dan
// pastikan pilihan tema tersimpan.
//
// Pakai:  node scripts/smoke-e2e.mjs <path mira.exe> <folder screenshot>
// Butuh:  playwright-core (hanya untuk alat uji, tidak dibundel ke aplikasi).

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { fillNewOffice, mainNav, openAdminIT, reachNotFound, waitNameStep } from "./e2e-onboarding.mjs";
import { deleteOwnKeys, miraCredentials } from "./e2e-keys.mjs";

const exe = resolve(process.argv[2] ?? "src-tauri/target/release/mira.exe");
const shots = resolve(process.argv[3] ?? "docs/progress/screenshots");
mkdirSync(shots, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "mira-smoke-"));
const PORT = 9339;

// Kunci laptop tersimpan di Windows Credential Manager. Catat entri Mira yang
// sudah ada supaya hanya entri buatan uji ini yang dihapus di akhir.
const credentialsBefore = miraCredentials();

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "LULUS" : "GAGAL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function launch() {
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      MIRA_DATA_DIR: dataDir,
      MIRA_DISABLE_MDNS: "1",
      MIRA_UPDATER_ENDPOINT: "http://127.0.0.1:9/latest.json",
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
    stdio: "ignore",
  });
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
  return { child, browser, page };
}

async function stop({ child, browser }) {
  await browser.close().catch(() => {});
  // Hanya proses yang dijalankan skrip ini (beserta anaknya) yang ditutup.
  try {
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* sudah berhenti */
  }
  await new Promise((r) => setTimeout(r, 1500));
}

function windowTitle(pid) {
  try {
    return execFileSync(
      "powershell",
      ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).MainWindowTitle`],
      { encoding: "utf8" },
    ).trim();
  } catch {
    return "";
  }
}

const theme = (page) => page.evaluate(() => document.documentElement.dataset.theme);

try {
  // Jalankan 1: pertama kali buka (onboarding v0.3).
  let app = await launch();
  let { page } = app;
  await waitNameStep(page);
  check("Layar pertama: langkah nama", (await page.locator("body").innerText()).includes("Langkah 1 dari 3"));
  const title = windowTitle(app.child.pid);
  check("Judul jendela memuat nama folder data", title.startsWith("Mira ("), title);
  await page.screenshot({ path: join(shots, "01-nama.png") });

  await reachNotFound(page);
  check("Tanpa kantor di jaringan: layar Kantor belum ditemukan", true);
  await page.screenshot({ path: join(shots, "02-kantor-belum-ditemukan.png") });

  await page.getByRole("button", { name: /Pakai kode undangan/ }).click();
  await page.getByRole("heading", { name: "Gabung dengan kode undangan" }).waitFor();
  await page.screenshot({ path: join(shots, "03-gabung-dengan-kode.png") });
  check("Pakai kode undangan menampilkan isian kode undangan", true);
  await page.getByRole("button", { name: /Kembali/ }).first().click();

  await page.getByRole("heading", { name: /Kantor belum ditemukan|Cari kantor dengan cara lain/ }).waitFor({ timeout: 20000 });
  const hiddenNewOffice = !(await page.getByRole("button", { name: "Siapkan Mira untuk kantor baru", exact: true }).isVisible());
  check("Tombol kantor baru tersembunyi sebelum bagian Untuk admin IT dibuka", hiddenNewOffice);
  await openAdminIT(page);
  await page.getByRole("button", { name: "Siapkan Mira untuk kantor baru", exact: true }).click();
  await page.getByRole("heading", { name: "Siapkan Mira untuk kantor baru" }).waitFor();
  await page.getByRole("button", { name: "Buat organisasi" }).click();
  const invalid = await page.getByLabel("Nama organisasi", { exact: true }).getAttribute("aria-invalid");
  const describedText = await page.evaluate(() => {
    const el = document.querySelector('input[name="orgName"]');
    const ids = (el?.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
    return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
  });
  check("Isian kosong ditolak dengan pesan", invalid === "true" && describedText.length > 0, describedText.slice(0, 80));
  await fillNewOffice(page, { name: "Rina Uji", org: "Kantor Uji", dept: "Desain" });
  await page.screenshot({ path: join(shots, "04-buat-organisasi.png") });
  await page.getByRole("button", { name: "Buat organisasi" }).click();
  await mainNav(page, "Pengaturan").waitFor({ timeout: 20000 });
  const body1 = await page.locator("body").innerText();
  check(
    "Organisasi dibuat, masuk kerangka utama sebagai Superadmin",
    body1.includes("Kantor Uji") && body1.includes("Superadmin"),
  );
  await page.screenshot({ path: join(shots, "05-kerangka-utama.png") });
  await stop(app);

  // Jalankan 2: setelah restart langsung masuk kerangka utama.
  app = await launch();
  page = app.page;
  await mainNav(page, "Pengaturan").waitFor({ timeout: 20000 });
  const body2 = await page.locator("body").innerText();
  check(
    "Setelah restart langsung ke kerangka utama, nama dan organisasi tetap",
    body2.includes("Rina Uji") && body2.includes("Kantor Uji") && !body2.includes("Simpan nama"),
  );
  for (const [menu, file] of [
    ["Board", "06-board-kosong.png"],
    ["Dokumen", "07-dokumen-kosong.png"],
  ]) {
    await mainNav(page, menu).click();
    await page.screenshot({ path: join(shots, file) });
  }
  await mainNav(page, "Pengaturan").click();
  await page.getByLabel("Gelap").check();
  await page.waitForTimeout(300);
  check("Mode Gelap diterapkan", (await theme(page)) === "dark");
  await page.screenshot({ path: join(shots, "08-pengaturan-gelap.png") });
  await page.getByLabel("Terang").check();
  await page.waitForTimeout(300);
  check("Mode Terang diterapkan", (await theme(page)) === "light");
  await page.screenshot({ path: join(shots, "09-pengaturan-terang.png") });

  await page.getByLabel("Ikuti Windows").check();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(300);
  const followDark = await theme(page);
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForTimeout(300);
  const followLight = await theme(page);
  check(
    "Ikuti Windows mengikuti pengaturan sistem (gelap lalu terang)",
    followDark === "dark" && followLight === "light",
    `${followDark}, ${followLight}`,
  );
  await page.getByRole("button", { name: "Laptop ini" }).click();
  await page.screenshot({ path: join(shots, "10-laptop-ini.png") });
  await page.getByRole("button", { name: "Tampilan" }).click();
  await page.getByLabel("Gelap").check();
  await page.waitForTimeout(300);
  await stop(app);

  // Jalankan 3: pilihan Gelap tersimpan setelah restart.
  app = await launch();
  page = app.page;
  await mainNav(page, "Pengaturan").waitFor({ timeout: 20000 });
  check("Mode Gelap tetap setelah restart", (await theme(page)) === "dark");
  await page.screenshot({ path: join(shots, "11-chat-gelap-setelah-restart.png") });
  await stop(app);
} catch (err) {
  check("Skrip berjalan tanpa error", false, String(err?.message ?? err));
}

// Hanya kunci laptop uji skrip ini (dari mira.db di folder datanya) yang dihapus.
await deleteOwnKeys({ before: credentialsBefore, dirs: [dataDir] });
rmSync(dataDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} pemeriksaan lulus.`);
process.exit(failed ? 1 : 0);
