// Uji ujung ke ujung menu klik kanan (v0.4, satu laptop).
//
// Menjalankan mira.exe dengan folder data sementara, lalu mengendalikan
// WebView2 lewat DevTools Protocol dengan klik kanan sungguhan
// (playwright `button: "right"`) dan Shift+F10. Yang diperiksa:
// - menu bawaan WebView (Back, Reload, Inspect) tidak muncul di luar kolom teks;
// - kolom teks: menu Potong, Salin, Tempel, Pilih semua, dan papan klip sungguhan;
// - Dokumen, Tanda tangan, dan Organisasi > Pengguna: menu baris, aksi dari
//   menu, tombol "...", Esc, dan fokus yang kembali ke baris;
// - screenshot terang dan gelap.
//
// Pakai:  node scripts/contextmenu-e2e.mjs <path mira.exe> <folder screenshot> <folder kerja>
// Build dulu: npx tauri build --debug --no-bundle

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { mainNav, newOffice } from "./e2e-onboarding.mjs";
import { deleteOwnKeys, miraCredentials } from "./e2e-keys.mjs";

const exe = resolve(process.argv[2] ?? "src-tauri/target/debug/mira.exe");
const shots = resolve(process.argv[3] ?? "docs/progress/screenshots/v04-contextmenu");
const work = resolve(process.argv[4] ?? join(tmpdir(), "mira-contextmenu-e2e"));
const dataDir = join(work, "data");
const exportDir = join(work, "ekspor");
const pdfPath = join(work, "perjanjian-uji.pdf");
const filesDir = resolve("test-files/docs");
const DOCX = "laporan-bulanan.docx";
const PORT = Number(process.env.CDP_PORT ?? 9487);
const PIN = "246810";
mkdirSync(shots, { recursive: true });
rmSync(work, { recursive: true, force: true });
mkdirSync(exportDir, { recursive: true });

const credentialsBefore = miraCredentials();

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "LULUS" : "GAGAL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function makePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([595.28, 841.89]);
  p.drawText("PERJANJIAN UJI MENU KLIK KANAN", { x: 60, y: 770, size: 16, font });
  writeFileSync(pdfPath, await doc.save());
}

async function launch() {
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      MIRA_DATA_DIR: dataDir,
      MIRA_DISABLE_MDNS: "1",
      MIRA_UPDATER_ENDPOINT: "http://127.0.0.1:9/latest.json",
      MIRA_EXPORT_DIR: exportDir,
      MIRA_TEST_NO_LAUNCH: "1",
      MIRA_PORT: process.env.MIRA_PORT ?? "47931",
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

const shot = (page, name) => page.screenshot({ path: join(shots, name) });
const invoke = (page, cmd, args) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);

// Catat apakah setiap event contextmenu dibatalkan (menu bawaan tidak muncul).
async function watchNativeMenu(page) {
  await page.evaluate(() => {
    window.__cm = [];
    window.addEventListener("contextmenu", (e) => setTimeout(() => window.__cm.push(e.defaultPrevented)), true);
  });
}
const lastNative = (page) => page.evaluate(() => window.__cm.at(-1));

const menuItemNames = (menu) => menu.getByRole("menuitem").evaluateAll((els) => els.map((e) => e.querySelector(".cmenu-label")?.textContent ?? ""));
const focusedText = (page) => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? "");

async function setTheme(page, label) {
  await mainNav(page, "Pengaturan").click();
  await page.getByLabel(label).check();
  await page.waitForTimeout(300);
}

async function createSignature(page) {
  await page.getByRole("button", { name: "Buat tanda tangan" }).first().click();
  const pad = page.locator("canvas").first();
  await pad.waitFor();
  const box = await pad.boundingBox();
  const y0 = box.y + box.height * 0.6;
  await page.mouse.move(box.x + box.width * 0.15, y0);
  await page.mouse.down();
  for (let i = 0; i <= 30; i++) {
    const t = i / 30;
    await page.mouse.move(box.x + box.width * (0.15 + 0.7 * t), y0 - Math.sin(t * Math.PI * 3) * box.height * 0.25, { steps: 2 });
  }
  await page.mouse.up();
  await page.getByRole("button", { name: "Lanjut ke PIN" }).click();
  await page.getByLabel("PIN baru").fill(PIN);
  await page.getByLabel("Ulangi PIN").fill(PIN);
  await page.getByRole("button", { name: "Simpan tanda tangan" }).click();
  await page.getByText(/Tersimpan sejak/).waitFor({ timeout: 20000 });
}

let app;
try {
  await makePdf();
  app = await launch();
  const { page } = app;
  await newOffice(page, { name: "Rina Uji", org: "Kantor Uji", dept: "Desain" });
  await setTheme(page, "Terang");
  await watchNativeMenu(page);

  // 1. Menu bawaan WebView mati di luar kolom teks, termasuk sidebar.
  await mainNav(page, "Dokumen").click();
  await page.getByRole("heading", { level: 1 }).first().click({ button: "right" });
  await page.waitForTimeout(200);
  check("Klik kanan di judul: menu bawaan dibatalkan, tidak ada menu", (await lastNative(page)) === true && (await page.getByRole("menu").count()) === 0);
  await mainNav(page, "Chat").click({ button: "right" });
  await page.waitForTimeout(200);
  check("Klik kanan di sidebar: menu bawaan dibatalkan, tidak ada menu", (await lastNative(page)) === true && (await page.getByRole("menu").count()) === 0);

  // 2. Dokumen.
  const paths = ["RAB-proyek-a.xlsx", DOCX, "kontrak-draft.pdf"].map((n) => join(filesDir, n));
  await invoke(page, "add_documents", { paths, projectId: null });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const docRow = page.locator("li.doc-row", { hasText: DOCX }).first();
  await docRow.waitFor({ timeout: 15000 });
  await docRow.locator(".doc-name").click({ button: "right" });
  const docMenu = page.getByRole("menu", { name: new RegExp(DOCX.replace(/\./g, "\\.")) });
  await docMenu.waitFor({ timeout: 5000 });
  const docItems = await menuItemNames(docMenu);
  check("Dokumen: klik kanan membuka menu baris", docItems.length >= 3 && docItems.length <= 7, docItems.join(" | "));
  check("Dokumen: menu tidak punya Hapus (perintahnya tidak ada)", !docItems.some((t) => /^Hapus/.test(t)));
  await shot(page, "01-dokumen-menu-terang.png");
  await docMenu.getByRole("menuitem", { name: /Salin nama/ }).click();
  await page.waitForTimeout(300);
  const copiedName = await page.evaluate(() => navigator.clipboard.readText().catch((e) => `gagal: ${e}`));
  check("Dokumen: Salin nama mengisi papan klip", copiedName === DOCX, copiedName);
  check("Dokumen: menu tertutup setelah aksi", (await page.getByRole("menu").count()) === 0);

  // Keyboard: Shift+F10 dari tombol baris, Esc, fokus kembali.
  await docRow.locator(".doc-pick").focus();
  await page.keyboard.press("Shift+F10");
  await docMenu.waitFor({ timeout: 5000 });
  const firstFocused = await page.evaluate(() => document.activeElement?.getAttribute("role"));
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  const back = await page.evaluate(() => document.activeElement?.classList.contains("doc-pick") ?? false);
  check("Dokumen: Shift+F10 membuka menu dengan item terfokus, Esc mengembalikan fokus ke baris", firstFocused === "menuitem" && back);
  check("Dokumen: Shift+F10 tidak memunculkan menu bawaan", (await page.getByRole("menu").count()) === 0);

  // Tombol "..." membuka menu yang sama.
  await docRow.getByRole("button", { name: /^Aksi lain untuk/ }).click();
  const viaButton = await menuItemNames(page.getByRole("menu"));
  check("Dokumen: tombol ... berisi item yang sama", JSON.stringify(viaButton) === JSON.stringify(docItems), viaButton.join(" | "));
  await page.keyboard.press("Escape");

  // Lihat riwayat versi dari menu.
  await docRow.locator(".doc-name").click({ button: "right" });
  await docMenu.waitFor({ timeout: 5000 });
  const history = docMenu.getByRole("menuitem", { name: /riwayat/i });
  if (await history.count()) {
    await history.click();
    await page.getByText(/Versi 1/).first().waitFor({ timeout: 10000 });
    check("Dokumen: Lihat riwayat versi membuka daftar versi", true);
  } else {
    check("Dokumen: item Lihat riwayat versi ada", false, docItems.join(" | "));
  }

  // 3. Kolom teks: menu bahasa Indonesia dan papan klip sungguhan.
  await mainNav(page, "Organisasi").click();
  await page.getByRole("heading", { name: "Organisasi", level: 1 }).waitFor({ timeout: 15000 });
  await page.locator("nav.org-tabs-wrap").getByRole("button", { name: /^Pengguna/ }).first().click();
  const search = page.getByRole("searchbox").or(page.locator("input[type=search]")).first();
  await search.waitFor({ timeout: 10000 });
  await search.fill("");
  await search.click({ button: "right" });
  const textMenu = page.getByRole("menu", { name: "Menu teks" });
  await textMenu.waitFor({ timeout: 5000 });
  const textItems = await menuItemNames(textMenu);
  check("Kolom teks: Potong, Salin, Tempel, Pilih semua", JSON.stringify(textItems) === JSON.stringify(["Potong", "Salin", "Tempel", "Pilih semua"]), textItems.join(" | "));
  await textMenu.getByRole("menuitem", { name: /Tempel/ }).click();
  await page.waitForTimeout(300);
  check("Kolom teks: Tempel memasukkan isi papan klip", (await search.inputValue()) === DOCX, await search.inputValue());
  await search.click({ button: "right" });
  await textMenu.getByRole("menuitem", { name: /Pilih semua/ }).click();
  await search.click({ button: "right" });
  await textMenu.waitFor();
  await shot(page, "02-menu-teks-terang.png");
  await textMenu.getByRole("menuitem", { name: /Potong/ }).click();
  await page.waitForTimeout(300);
  const afterCut = await search.inputValue();
  const cutClip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
  check("Kolom teks: Potong mengosongkan kolom dan mengisi papan klip", afterCut === "" && cutClip === DOCX, `kolom "${afterCut}", papan klip "${cutClip}"`);

  // 4. Organisasi > Pengguna: baris sendiri.
  const userRow = page.locator("li, tr", { hasText: "Rina Uji" }).filter({ has: page.getByRole("button", { name: /^Aksi untuk Rina Uji/ }) }).first();
  await userRow.waitFor({ timeout: 10000 });
  await userRow.getByText("Rina Uji", { exact: false }).first().click({ button: "right" });
  const userMenu = page.getByRole("menu").first();
  await userMenu.waitFor({ timeout: 5000 });
  const userItems = await menuItemNames(userMenu);
  check("Pengguna: klik kanan membuka menu baris", userItems.length >= 1 && userItems.length <= 7, userItems.join(" | "));
  await shot(page, "03-pengguna-menu-terang.png");
  await page.keyboard.press("Escape");
  await userRow.getByRole("button", { name: /^Aksi untuk Rina Uji/ }).click();
  const viaDots = await menuItemNames(page.getByRole("menu").first());
  check("Pengguna: tombol titik tiga berisi item yang sama", JSON.stringify(viaDots) === JSON.stringify(userItems), viaDots.join(" | "));
  await page.keyboard.press("Escape");
  check("Pengguna: Esc mengembalikan fokus ke tombol titik tiga", /^Aksi untuk Rina Uji/.test(await focusedText(page)), await focusedText(page));

  // 4b. Menu teks di dalam dialog modal: bisa diklik, Esc hanya menutup menu.
  await page.locator("nav.org-tabs-wrap").getByRole("button", { name: /^Departemen/ }).first().click();
  await page.getByRole("button", { name: "Departemen baru", exact: true }).click();
  const deptDialog = page.getByRole("dialog");
  await deptDialog.waitFor({ timeout: 5000 });
  const deptName = deptDialog.getByRole("textbox").first();
  await deptName.fill("Keuangan");
  await deptName.click({ button: "right" });
  const dialogMenu = deptDialog.getByRole("menu", { name: "Menu teks" });
  await dialogMenu.waitFor({ timeout: 5000 });
  check("Dialog: menu teks dirender di dalam dialog", true);
  await shot(page, "03b-menu-teks-di-dialog-terang.png");
  await dialogMenu.getByRole("menuitem", { name: "Pilih semua" }).click();
  const selected = await deptName.evaluate((el) => [el.selectionStart, el.selectionEnd]);
  check("Dialog: Pilih semua bisa diklik dan dialog tetap terbuka", (await deptDialog.count()) === 1 && selected[0] === 0 && selected[1] === "Keuangan".length, JSON.stringify(selected));
  await deptName.click({ button: "right" });
  await dialogMenu.waitFor();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check("Dialog: Esc menutup menu saja, dialog tetap terbuka", (await page.getByRole("menu").count()) === 0 && (await deptDialog.count()) === 1);
  await page.keyboard.press("Escape");
  await deptDialog.waitFor({ state: "detached", timeout: 5000 });

  // 5. Tanda tangan: buat permintaan untuk diri sendiri, lalu menu baris.
  await mainNav(page, "Tanda tangan").click();
  await page.getByRole("button", { name: "Buat tanda tangan" }).first().waitFor({ timeout: 15000 });
  await createSignature(page);
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: "Pilih PDF untuk ditandatangani" }).click(),
  ]);
  await chooser.setFiles(pdfPath);
  await page.getByRole("button", { name: "Buat permintaan" }).waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Buat permintaan" }).click();
  await page.getByRole("button", { name: "Tempatkan tanda tangan" }).waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "Kembali", exact: true }).first().click();
  const signRow = page.locator("li", { has: page.locator("[data-request]") }).first();
  await signRow.waitFor({ timeout: 15000 });
  await signRow.locator(".sign-row-title").click({ button: "right" });
  const signMenu = page.getByRole("menu").first();
  await signMenu.waitFor({ timeout: 5000 });
  const signItems = await menuItemNames(signMenu);
  check("Tanda tangan: klik kanan membuka menu baris", signItems.length >= 3 && signItems.length <= 7, signItems.join(" | "));
  check("Tanda tangan: Tandatangani tersedia saat giliran Anda", signItems.some((t) => /^Tandatangani/.test(t)));
  check("Tanda tangan: Batalkan tersedia untuk pengirim", signItems.some((t) => /^Batalkan/.test(t)));
  await shot(page, "04-tanda-tangan-menu-terang.png");
  const verifyItem = signMenu.getByRole("menuitem", { name: /keaslian/i });
  if (await verifyItem.count()) {
    await verifyItem.click();
    await page.getByRole("dialog").waitFor({ timeout: 5000 });
    check("Tanda tangan: Periksa keaslian membuka dialog", true);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    const onRow = await page.evaluate(() => Boolean(document.activeElement?.closest("li")?.querySelector("[data-request]")));
    check("Tanda tangan: fokus kembali ke baris setelah dialog ditutup", onRow);
  } else {
    check("Tanda tangan: item Periksa keaslian ada", false, signItems.join(" | "));
  }
  // Batalkan: konfirmasi muncul, Batal tidak membatalkan.
  await signRow.locator(".sign-row-title").click({ button: "right" });
  await signMenu.getByRole("menuitem", { name: /^Batalkan/ }).click();
  const confirm = page.getByRole("dialog");
  await confirm.waitFor({ timeout: 5000 });
  await shot(page, "05-tanda-tangan-konfirmasi-batal-terang.png");
  await confirm.getByRole("button", { name: "Batal", exact: true }).click();
  await page.waitForTimeout(300);
  check("Tanda tangan: Batalkan meminta konfirmasi dan Batal tidak mengubah apa pun", (await page.getByRole("dialog").count()) === 0 && (await signRow.count()) === 1);

  // 6. Mode gelap.
  await setTheme(page, "Gelap");
  check("Mode gelap aktif", (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark");
  await mainNav(page, "Tanda tangan").click();
  await signRow.waitFor({ timeout: 15000 });
  await signRow.locator(".sign-row-title").click({ button: "right" });
  await signMenu.waitFor();
  await shot(page, "06-tanda-tangan-menu-gelap.png");
  await page.keyboard.press("Escape");
  await mainNav(page, "Dokumen").click();
  await docRow.waitFor({ timeout: 15000 });
  await docRow.locator(".doc-name").click({ button: "right" });
  await docMenu.waitFor();
  await page.keyboard.press("ArrowDown");
  await shot(page, "07-dokumen-menu-gelap.png");
  await page.keyboard.press("Escape");
  await mainNav(page, "Organisasi").click();
  await page.locator("nav.org-tabs-wrap").getByRole("button", { name: /^Pengguna/ }).first().click();
  await userRow.waitFor({ timeout: 10000 });
  await userRow.getByText("Rina Uji", { exact: false }).first().click({ button: "right" });
  await page.getByRole("menu").first().waitFor();
  await shot(page, "08-pengguna-menu-gelap.png");
  await page.keyboard.press("Escape");
  await search.fill("Rina");
  await search.press("Control+A");
  await search.click({ button: "right" });
  await textMenu.waitFor();
  await shot(page, "09-menu-teks-gelap.png");
  await page.keyboard.press("Escape");
  check("Kolom teks: Esc mengembalikan fokus ke kolom", await search.evaluate((el) => el === document.activeElement));
} catch (err) {
  check("Skrip berjalan tanpa error", false, String(err?.message ?? err).split("\n")[0]);
  if (app) await app.page.screenshot({ path: join(work, "gagal.png") }).catch(() => {});
} finally {
  if (app) await stop(app);
}

// Hanya kunci laptop uji skrip ini (dari mira.db di folder datanya) yang dihapus.
await deleteOwnKeys({ before: credentialsBefore, dirs: [dataDir] });
if (!results.some((r) => !r.ok)) rmSync(work, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} pemeriksaan lulus.`);
process.exit(failed ? 1 : 0);
