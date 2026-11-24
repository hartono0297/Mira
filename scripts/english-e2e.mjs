// Uji ujung ke ujung pilihan bahasa Inggris (v0.4) di Windows.
//
// Satu instance mira.exe dengan folder data sementara (MIRA_DATA_DIR), tanpa
// mDNS, dikendalikan lewat Chrome DevTools Protocol. Alur:
//   a. Layar nama onboarding dalam bahasa Indonesia. Pilih "English" di pemilih
//      ringkas: judul langkah dan tombol berganti tanpa restart. Kembali ke
//      "Bahasa Indonesia", lalu buat kantor baru dengan langkah Indonesia dari
//      e2e-onboarding.mjs.
//   b. Pengaturan > Bahasa > English: menu utama dan judul Pengaturan berbahasa
//      Inggris tanpa restart.
//   c. Chat, Board (proyek dan task dibuat lewat UI), detail task, Dokumen,
//      Tanda tangan, setiap tab Organisasi, dan setiap bagian Pengaturan:
//      screenshot, lalu teks layar plus atribut aria-label, title, placeholder,
//      dan alt diperiksa tidak memuat kata Indonesia yang umum.
//   d. Restart: tetap bahasa Inggris. Frame pertama diperiksa dengan pengamat DOM
//      yang dipasang lalu halaman dimuat ulang.
//   e. Kembali ke Bahasa Indonesia: menu "Pengaturan" muncul lagi.
//
// Data yang diketik sendiri (nama kantor, orang, departemen, proyek, task)
// berbahasa Inggris atau netral, jadi tidak ikut terhitung sebagai teks Indonesia.
// Teks di dalam elemen lang="id" (nama "Bahasa Indonesia" di pemilih) dikecualikan.
//
// Pakai:  node scripts/english-e2e.mjs <path mira.exe> [folder screenshot]
// Port:   CDP 9397 dan MIRA_PORT 47897, digeser E2E_PORT_OFFSET.
// Butuh:  playwright-core (alat uji saja, tidak dibundel ke aplikasi).

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { mainNav, menuName, newOffice, waitNameStep } from "./e2e-onboarding.mjs";

const exe = resolve(process.argv[2] ?? "src-tauri/target/debug/mira.exe");
const shots = resolve(process.argv[3] ?? "docs/progress/screenshots/v04-english");
mkdirSync(shots, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "mira-english-e2e-"));
const PORT_OFFSET = Number(process.env.E2E_PORT_OFFSET ?? 0) || 0;
const CDP_PORT = 9397 + PORT_OFFSET;
const MIRA_PORT = 47897 + PORT_OFFSET;

// Data uji: berbahasa Inggris atau netral.
const PERSON = "Rina Hart";
const ORG = "Northwind Studio";
const DEPT = "Design";
const PROJECT = "Website Launch";
const TASK = "Draft the launch brochure";

// Teks Inggris yang dicari skrip. Sumbernya kamus src/i18n/*.en.ts; perbarui
// di sini kalau kamusnya berubah.
const EN = {
  mainMenu: "Main menu", // shell.en.ts mainMenu
  nav: { chat: "Chat", board: "Board", docs: "Documents", sign: "Signatures", org: "Organization", settings: "Settings" },
  settingsTitle: "Settings", // settings.en.ts title
  languagePart: "Language", // settings.en.ts parts.language
  stepName: "Step 1 of 3", // onboarding.en.ts step.name
  nameSubmit: "Continue", // onboarding.en.ts name.submit
  createFirstProject: "Create the first project", // board-screen.en.ts buatPertama
  projectName: "Project name", // board-detail.en.ts nameLabel
  createProject: "Create project", // board-detail.en.ts create
  newTask: "New task", // board-screen.en.ts taskBaru
  addTask: "Add task", // board-screen.en.ts buka
  newTaskTitle: /^New task title/, // board-screen.en.ts label(column)
  closeTask: "Close task details", // board-dialog.en.ts tutup
  createSignature: "Create signature", // sign-list.en.ts create
};
const ID = { mainMenu: "Menu utama", settings: "Pengaturan", stepName: "Langkah 1 dari 3", nameSubmit: "Lanjut" };
const ANY_MAIN_MENU = new RegExp(`^(${ID.mainMenu}|${EN.mainMenu})$`);

// Kata fungsi dan label umum bahasa Indonesia yang tidak boleh tampil saat
// bahasa Inggris aktif.
const ID_WORDS = [
  "yang", "dan", "untuk", "dengan", "belum", "sudah", "tidak", "Anda", "ini", "dari", "pada", "akan", "bisa",
  "Simpan", "Batal", "Hapus", "Tutup", "Pengaturan", "Organisasi", "Dokumen", "Hari ini",
];
const ID_WORD_RE = new RegExp(`(?<![\\p{L}\\p{N}])(${ID_WORDS.join("|")})(?![\\p{L}\\p{N}])`, "giu");

// Kunci laptop tersimpan di Windows Credential Manager. Yang dihapus di akhir
// hanya kunci laptop uji ini (ourKeys), bukan kredensial baru milik uji lain.
function miraCredentials() {
  try {
    const out = execFileSync("cmdkey", ["/list"], { encoding: "utf8" });
    return new Set(out.match(/device-key-[0-9a-f]{64}\.id\.mira\.desktop/g) ?? []);
  } catch {
    return new Set();
  }
}
const credentialsBefore = miraCredentials();
const ourKeys = new Set();

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "LULUS" : "GAGAL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rememberKey(page) {
  try {
    const st = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("get_app_state"));
    if (st?.identity?.publicKey) ourKeys.add(st.identity.publicKey.toLowerCase());
  } catch {
    /* dicoba lagi setelah kantor dibuat */
  }
}

async function launch() {
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      MIRA_DATA_DIR: dataDir,
      MIRA_DISABLE_MDNS: "1",
      MIRA_PORT: String(MIRA_PORT),
      MIRA_UPDATER_ENDPOINT: "http://127.0.0.1:9/latest.json",
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
    stdio: "ignore",
  });
  const exited = new Promise((r) => child.once("exit", r));
  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
    await sleep(500);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
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
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  await page.waitForFunction(() => "__TAURI_INTERNALS__" in window, null, { timeout: 20000 });
  await rememberKey(page);
  return { child, browser, page, exited };
}

// Menutup jendela dengan wajar dulu (WM_CLOSE) supaya WebView2 sempat menulis
// localStorage, baru dipaksa kalau tidak berhenti. Hanya proses yang dijalankan
// skrip ini (beserta anaknya) yang ditutup.
async function stop({ child, browser, exited }) {
  await browser.close().catch(() => {});
  try {
    execFileSync("taskkill", ["/PID", String(child.pid), "/T"], { stdio: "ignore" });
  } catch {
    /* mungkin sudah berhenti */
  }
  const done = await Promise.race([exited.then(() => true), sleep(10000).then(() => false)]);
  if (!done) {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* sudah berhenti */
    }
  }
  await sleep(1500);
}

const shot = (page, file) => page.screenshot({ path: join(shots, file) });
const navEn = (page, key) =>
  page.getByRole("navigation", { name: EN.mainMenu }).getByRole("button", { name: menuName(EN.nav[key]) });
const getSetting = (page, key) => page.evaluate((k) => window.__TAURI_INTERNALS__.invoke("get_setting", { key: k }), key);
const htmlLang = (page) => page.evaluate(() => document.documentElement.lang);

// Teks layar dan atribut yang dibacakan atau tampil, tanpa isi elemen lang="id".
async function screenText(page) {
  return page.evaluate(() => {
    const skip = (el) => Boolean(el.closest('[lang="id"]:not(html)'));
    let text = document.body.innerText;
    for (const el of document.body.querySelectorAll('[lang="id"]')) {
      const inner = el.innerText ?? "";
      if (inner) text = text.replace(inner, " ");
    }
    const attrs = [];
    for (const el of document.body.querySelectorAll("[aria-label], [title], [placeholder], [alt]")) {
      if (skip(el)) continue;
      for (const a of ["aria-label", "title", "placeholder", "alt"]) {
        const v = el.getAttribute(a);
        if (v) attrs.push(`[${a}] ${v}`);
      }
    }
    return `${text}\n${attrs.join("\n")}`;
  });
}

// Pemeriksaan satu layar: tidak ada kata Indonesia dari daftar.
async function checkEnglish(page, label) {
  const text = await screenText(page);
  const hits = [];
  for (const line of text.split("\n")) {
    const found = [...line.matchAll(ID_WORD_RE)].map((m) => m[1]);
    if (found.length) hits.push(`${found.join("/")}: "${line.trim().slice(0, 90)}"`);
  }
  check(`${label}: tanpa kata Indonesia`, hits.length === 0, hits.slice(0, 6).join(" | "));
  return hits;
}

async function visit(page, key, file, label) {
  await navEn(page, key).click();
  await page.locator("#page-title").first().waitFor({ timeout: 15000 }).catch(() => {});
  await sleep(800);
  await shot(page, file);
  await checkEnglish(page, label);
}

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30) || "bagian";

let app;
try {
  // ----- a. Onboarding: pemilih bahasa ringkas ------------------------------------
  app = await launch();
  let { page } = app;
  await waitNameStep(page);
  const stepId = (await page.locator(".onb-step").first().innerText()).trim();
  check("Layar pertama: langkah nama dalam bahasa Indonesia", stepId === ID.stepName && (await htmlLang(page)) !== "en", stepId);
  await shot(page, "01-onboarding-indonesia.png");

  const compact = page.locator(".lang-picker-compact");
  await compact.getByRole("radio", { name: "English", exact: true }).check();
  await page.getByRole("button", { name: EN.nameSubmit, exact: true }).waitFor({ timeout: 5000 }).catch(() => {});
  const stepEn = (await page.locator(".onb-step").first().innerText()).trim();
  const submitEn = await page.getByRole("button", { name: EN.nameSubmit, exact: true }).isVisible();
  const headingEn = (await page.locator("h1").first().innerText().catch(() => "")).trim();
  check(
    "Pilih English di onboarding: judul langkah dan tombol berbahasa Inggris tanpa restart",
    stepEn === EN.stepName && submitEn && (await htmlLang(page)) === "en",
    `${stepEn} / ${headingEn}`,
  );
  await shot(page, "02-onboarding-english.png");
  await checkEnglish(page, "Onboarding langkah nama (English)");
  check("Pilihan onboarding tersimpan di pengaturan lokal", (await getSetting(page, "app.language")) === "en");

  await compact.getByRole("radio", { name: "Bahasa Indonesia", exact: true }).check();
  await page.getByRole("button", { name: ID.nameSubmit, exact: true }).waitFor({ timeout: 5000 });
  const stepBack = (await page.locator(".onb-step").first().innerText()).trim();
  check("Kembali ke Bahasa Indonesia di onboarding", stepBack === ID.stepName && (await htmlLang(page)) === "id", stepBack);

  await newOffice(page, { name: PERSON, org: ORG, dept: DEPT });
  await mainNav(page, ID.settings).waitFor({ timeout: 20000 });
  check("Kantor baru dibuat lewat langkah Indonesia", true);
  await rememberKey(page);

  // ----- b. Pengaturan > Bahasa > English ------------------------------------------
  await mainNav(page, ID.settings).click();
  await page.locator("ul.settings-nav").getByRole("button", { name: "Bahasa", exact: true }).click();
  await page.locator(".lang-picker-full").getByRole("radio", { name: "English", exact: true }).check();
  await navEn(page, "settings").waitFor({ timeout: 5000 }).catch(() => {});
  const navNames = await page
    .getByRole("navigation", { name: ANY_MAIN_MENU })
    .getByRole("button")
    .evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim()));
  const titleEn = (await page.locator("#page-title").first().innerText()).trim();
  const missing = Object.values(EN.nav).filter((n) => !navNames.some((t) => t.startsWith(n)));
  check(
    "Pengaturan > Bahasa > English: menu utama dan judul berbahasa Inggris tanpa restart",
    missing.length === 0 && titleEn === EN.settingsTitle && (await page.getByRole("navigation", { name: EN.mainMenu }).count()) === 1,
    `menu: ${navNames.join(", ")}; judul: ${titleEn}`,
  );
  check("Pilihan English tersimpan di pengaturan lokal", (await getSetting(page, "app.language")) === "en");
  await shot(page, "03-pengaturan-bahasa-english.png");
  await checkEnglish(page, "Settings > Language");

  // ----- c. Layar utama dalam bahasa Inggris -----------------------------------------
  await visit(page, "chat", "04-chat.png", "Chat");

  await navEn(page, "board").click();
  const firstProject = page.getByRole("button", { name: EN.createFirstProject });
  await firstProject.waitFor({ timeout: 15000 });
  await sleep(500);
  await shot(page, "05-board-kosong.png");
  await checkEnglish(page, "Board (empty)");
  try {
    await firstProject.click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel(EN.projectName).fill(PROJECT);
    await sleep(800);
    await shot(page, "06-proyek-baru.png");
    await checkEnglish(page, "New project dialog");
    await dlg.getByRole("button", { name: EN.createProject, exact: true }).click();
    await page.getByRole("button", { name: EN.newTask }).waitFor({ timeout: 10000 });
    const col = page.locator("section.pb-col").first();
    await col.getByRole("button", { name: EN.addTask }).click();
    const input = col.getByLabel(EN.newTaskTitle);
    await input.fill(TASK);
    await input.press("Enter");
    await sleep(400);
    await input.press("Escape").catch(() => {});
    await page.locator("[data-open-task]", { hasText: TASK }).waitFor({ timeout: 10000 });
    check("Proyek dan task dibuat lewat UI berbahasa Inggris", true);
    await sleep(500);
    await shot(page, "07-board-proyek.png");
    await checkEnglish(page, "Project board");

    await page.locator("[data-open-task]", { hasText: TASK }).click();
    const taskDlg = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: EN.closeTask }) });
    await taskDlg.waitFor({ timeout: 10000 });
    await sleep(800);
    await shot(page, "08-detail-task.png");
    await checkEnglish(page, "Task details");
    await taskDlg.getByRole("button", { name: EN.closeTask }).click();
    await taskDlg.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  } catch (err) {
    check("Proyek, task, dan detail task lewat UI berbahasa Inggris", false, String(err?.message ?? err));
    await shot(page, "error-board.png").catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
  }

  await visit(page, "docs", "09-dokumen.png", "Documents");
  await visit(page, "sign", "10-tanda-tangan.png", "Signatures");
  try {
    await page.getByRole("button", { name: EN.createSignature }).first().click({ timeout: 5000 });
    const padDlg = page.getByRole("dialog").first();
    await padDlg.waitFor({ timeout: 5000 });
    await sleep(600);
    await shot(page, "11-buat-tanda-tangan.png");
    await checkEnglish(page, "Create signature");
    await page.keyboard.press("Escape");
    await padDlg.waitFor({ state: "detached", timeout: 3000 }).catch(() => {});
  } catch (err) {
    check("Dialog Create signature terbuka", false, String(err?.message ?? err));
    await page.keyboard.press("Escape").catch(() => {});
  }

  await visit(page, "org", "12-organisasi.png", "Organization");
  const orgTabs = page.locator("nav.org-tabs-wrap button");
  const orgCount = await orgTabs.count();
  check("Organisasi punya beberapa tab", orgCount >= 2, `${orgCount} tab`);
  for (let i = 0; i < orgCount; i++) {
    const name = (await orgTabs.nth(i).innerText()).trim().split("\n")[0];
    await orgTabs.nth(i).click();
    await sleep(800);
    await shot(page, `13-organisasi-${i + 1}-${slug(name)}.png`);
    await checkEnglish(page, `Organization > ${name}`);
  }

  await navEn(page, "settings").click();
  const parts = page.locator("ul.settings-nav button");
  const partCount = await parts.count();
  check("Pengaturan punya lima bagian", partCount === 5, `${partCount} bagian`);
  for (let i = 0; i < partCount; i++) {
    const name = (await parts.nth(i).innerText()).trim();
    await parts.nth(i).click();
    await sleep(1000);
    await shot(page, `14-pengaturan-${i + 1}-${slug(name)}.png`);
    await checkEnglish(page, `Settings > ${name}`);
  }
  await stop(app);
  app = null;

  // ----- d. Restart: tetap bahasa Inggris sejak menu utama pertama tampil -----------
  app = await launch();
  page = app.page;
  const mainAfterRestart = page.getByRole("navigation", { name: ANY_MAIN_MENU });
  await mainAfterRestart.waitFor({ timeout: 20000 });
  const navAtStart = await mainAfterRestart.getAttribute("aria-label");
  check("Setelah restart Mira terbuka dengan menu utama berbahasa Inggris", navAtStart === EN.mainMenu, String(navAtStart));
  // Skrip awal dipasang lalu halaman dimuat ulang, supaya nama menu utama dicatat
  // saat pertama kali masuk DOM (sebelum frame itu digambar). Muat ulang memakai
  // jalur awal yang sama dengan membuka Mira: bahasa dari salinan localStorage,
  // lalu dari pengaturan app.language.
  await page.addInitScript(() => {
    const isMain = (n) => /^(Menu utama|Main menu)$/.test(n.getAttribute("aria-label") ?? "");
    const obs = new MutationObserver(() => {
      const nav = [...document.querySelectorAll("nav[aria-label]")].find(isMain);
      if (!nav) return;
      obs.disconnect();
      let cache = null;
      try {
        cache = localStorage.getItem("mira.lang");
      } catch {
        /* storage diblokir */
      }
      window.__miraFirstNav = { nav: nav.getAttribute("aria-label"), lang: document.documentElement.lang, cache };
    });
    obs.observe(document, { childList: true, subtree: true });
  });
  const cacheAfterRestart = await page.evaluate(() => {
    try {
      return localStorage.getItem("mira.lang");
    } catch {
      return null;
    }
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__miraFirstNav, null, { timeout: 25000 }).catch(() => {});
  const first = await page.evaluate(() => window.__miraFirstNav ?? null);
  check(
    "Frame pertama setelah muat ulang: menu utama sudah berbahasa Inggris",
    first?.nav === EN.mainMenu && first?.lang === "en",
    JSON.stringify(first),
  );
  check(
    "Salinan pilihan bahasa untuk frame pertama tersimpan setelah restart (localStorage)",
    cacheAfterRestart === "en",
    String(cacheAfterRestart),
  );
  await navEn(page, "settings").waitFor({ timeout: 20000 });
  check("Setelah restart pengaturan app.language tetap en", (await getSetting(page, "app.language")) === "en");
  await sleep(800);
  await shot(page, "15-setelah-restart.png");
  await checkEnglish(page, "After restart");

  // ----- e. Kembali ke Bahasa Indonesia --------------------------------------------
  await navEn(page, "settings").click();
  await page.locator("ul.settings-nav").getByRole("button", { name: EN.languagePart, exact: true }).click();
  await page.locator(".lang-picker-full").getByRole("radio", { name: "Bahasa Indonesia", exact: true }).check();
  await mainNav(page, ID.settings).waitFor({ timeout: 5000 }).catch(() => {});
  const backNav = await mainNav(page, ID.settings).isVisible().catch(() => false);
  const backTitle = (await page.locator("#page-title").first().innerText()).trim();
  check(
    'Kembali ke Bahasa Indonesia: menu "Pengaturan" muncul lagi tanpa restart',
    backNav && backTitle === ID.settings && (await htmlLang(page)) === "id",
    backTitle,
  );
  check("Pilihan Indonesia tersimpan di pengaturan lokal", (await getSetting(page, "app.language")) === "id");
  await shot(page, "16-kembali-indonesia.png");
  await stop(app);
  app = null;
} catch (err) {
  check("Skrip berjalan tanpa error", false, String(err?.message ?? err));
  if (app) await shot(app.page, "error.png").catch(() => {});
}

if (app) await stop(app);
for (const target of miraCredentials()) {
  if (!credentialsBefore.has(target)) {
    const key = target.slice("device-key-".length, "device-key-".length + 64);
    if (!ourKeys.has(key)) {
      console.log(`Kredensial baru bukan milik uji ini, dibiarkan: ${target}`);
      continue;
    }
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
