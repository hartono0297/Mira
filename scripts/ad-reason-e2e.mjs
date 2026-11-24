// Uji ujung ke ujung alasan AD di onboarding, tawaran domain, dan "Cocokkan OU
// ini ke departemen..." (docs/plans/perbaikan-bergabung.md, 0.5.1) di satu PC Windows.
//
// Setiap instance mira.exe (build debug) punya folder data (MIRA_DATA_DIR),
// port QUIC (MIRA_PORT), port debug WebView2, dan file AD tiruan sendiri
// (MIRA_FAKE_AD, bentuk sama dengan ad-e2e.mjs). Mira membaca ulang file itu di
// setiap panggilan, jadi skrip menulis ulang file A untuk memberi A domain mesin.
//
//   A   Ayu     superadmin. Kantor dibuat tanpa domain AD (PC A belum di domain).
//   N1  Rina    akun macf.co.id. Di langkah 2 melihat alasan "domain kantor belum diatur".
//               (A lalu "pindah" ke domain macf.co.id dan memakai tawaran
//               "Pakai macf.co.id sebagai domain AD kantor ini?" di Organisasi.)
//   N2  Julius  akun macf.co.id tanpa atribut department, OU paling dalam
//               "IT- BussinesAnalyst_AppSupport & MIS_QA" belum dipetakan: alasan
//               "departemen belum dicocokkan". Mengirim permintaan; A mencocokkan OU
//               itu ke departemen lewat kartu; kartu menampilkan departemennya.
//   N3  Budi    akun domain lain (contoh.co.id): alasan "domain berbeda".
//
// Pakai:  node scripts/ad-reason-e2e.mjs <path mira.exe debug> <folder screenshot> [folder induk data uji]
// Port:   MIRA_PORT 47971-47974, CDP 9471-9474, keduanya digeser E2E_PORT_OFFSET.
// Butuh:  playwright-core (alat uji saja, tidak dibundel ke aplikasi).
// Jalankan sendirian, tanpa e2e lain (mDNS dan Credential Manager dipakai bersama).

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { chromium } from "playwright-core";
import { menuName, passFirewall, waitNameStep } from "./e2e-onboarding.mjs";

const exe = resolve(process.argv[2] ?? "src-tauri/target/debug/mira.exe");
const shots = resolve(process.argv[3] ?? "docs/progress/screenshots/perbaikan-bergabung");
mkdirSync(shots, { recursive: true });
const root = mkdtempSync(join(resolve(process.argv[4] ?? tmpdir()), "mira-ad-reason-e2e-"));
const PORT_OFFSET = Number(process.env.E2E_PORT_OFFSET ?? 0) || 0;

const installed = process.env.LOCALAPPDATA ? resolve(process.env.LOCALAPPDATA, "Mira") : null;
if (installed && (root + sep).toLowerCase().startsWith((installed + sep).toLowerCase())) {
  console.log(`Folder data uji ${root} ada di dalam ${installed}. Berhenti.`);
  process.exit(2);
}

// ----- Data uji ------------------------------------------------------------------
const DOMAIN = "macf.co.id";
const OTHER_DOMAIN = "contoh.co.id";
const ORG = "Kantor Uji Alasan";
const DEPT = { fin: "Keuangan", apps: "Dukungan Aplikasi" };
const PEOPLE = {
  rina: {
    domain: DOMAIN,
    user: "rina",
    displayName: "Rina Wijaya",
    department: null,
    dn: "CN=rina,OU=Finance,OU=HO,OU=Member Users,DC=macf,DC=co,DC=id",
  },
  // DN dari brief user. Tanpa atribut department.
  julius: {
    domain: DOMAIN,
    user: "julius",
    displayName: "Julius",
    department: null,
    dn: "CN=Julius,OU=IT- BussinesAnalyst_AppSupport & MIS_QA,OU=IT-Department,OU=IT & CP Department,OU=HO,OU=Member Users,DC=macf,DC=co,DC=id",
  },
  budi: {
    domain: OTHER_DOMAIN,
    user: "budi",
    displayName: "Budi Santoso",
    department: null,
    dn: "CN=budi,OU=Staff,DC=contoh,DC=co,DC=id",
  },
};
const INNER_OU = "IT- BussinesAnalyst_AppSupport & MIS_QA";
// N2 memilih departemen lain secara manual, supaya departemen hasil pemetaan OU
// di blok AD kartu bisa dibedakan dari departemen tujuan permintaan.
const N2_MANUAL_DEPT = DEPT.fin;
const MAP_TO = DEPT.apps;

const local = (p) => ({ domain: p.domain, user: p.user, dn: p.dn, displayName: p.displayName, department: p.department });
const fakeAd = (over = {}) => ({
  machineDomain: DOMAIN,
  local: null,
  localPartial: false,
  localDelayMs: 0,
  reachable: true,
  users: {},
  ...over,
});
const NO_DOMAIN = fakeAd({ machineDomain: null });
const directory = () => ({
  [PEOPLE.julius.user]: { dn: PEOPLE.julius.dn, displayName: PEOPLE.julius.displayName, department: null, disabled: false },
  [PEOPLE.rina.user]: { dn: PEOPLE.rina.dn, displayName: PEOPLE.rina.displayName, department: null, disabled: false },
});

// ----- Teks dan pencari elemen ----------------------------------------------------
// TODO(label): teks 0.5.1 sedang ditulis agen lain (F3 onboarding, F4 AD admin).
// Diambil dari draf src/i18n/onboarding.*, org-ad.*, org-requests.* saat skrip ditulis;
// sesuaikan di sini kalau kamusnya berubah. data-testid dipakai lebih dulu bila ada.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TID = {
  reason: "onb-ad-skipped", // OfficeStep: satu baris di bawah departemen, data-reason=noDomain|otherDomain|unmatched|outdated|noUser
  deptCaption: "onb-ad-dept", // departemen cocok dari AD
  officeSummary: "onb-ad-office-summary",
  offer: "org-domain-offer", // DomainOffer.tsx
  cardAd: "join-ad", // blok AD kartu permintaan
  match: "join-ad-match", // JoinAdMatchOu.tsx
};
const LBL = {
  id: {
    mainMenu: "Menu utama",
    nav: { org: "Organisasi", settings: "Pengaturan" },
    tabs: { departments: /^Departemen/, requests: /^Permintaan bergabung/ },
    nameSubmit: "Lanjut",
    resultHeading: /^(Kantor Anda ditemukan|Kantor ditemukan|Beberapa kantor ditemukan|Kantor belum ditemukan)/,
    headingMine: "Kantor Anda ditemukan",
    waitingHeading: /^Menunggu persetujuan$/,
    sendRequest: "Kirim permintaan",
    approveAria: (n) => `Setujui permintaan ${n}`,
    // Alasan di langkah 2 (urutan rencana: outdated, noDomain, otherDomain, unmatched).
    reason: {
      noDomain: /Domain kantor ini belum diatur/,
      otherDomain: (office, mine) => new RegExp(`Domain kantor \\(${esc(office)}\\) berbeda dengan domain akun Anda \\(${esc(mine)}\\)`),
      unmatched: /Departemen Anda di akun Windows \((.+)\) belum dicocokkan/,
    },
    // Tawaran domain di Organisasi.
    offerTitle: (d) => `Pakai ${d} sebagai domain AD kantor ini?`,
    offerUse: (d) => `Pakai ${d}`,
    // Kartu permintaan: cocokkan OU.
    matchOpen: (n) => `Cocokkan OU ini ke departemen (akun ${n})`, // aria-label tombol
    matchOpenText: "Cocokkan OU ini ke departemen...",
    matchDeptLabel: "Departemen di Mira",
    matchSubmit: "Cocokkan",
    matchDone: (ou, dept) => `OU ${ou} sekarang dicocokkan ke departemen ${dept}`,
  },
  en: {
    mainMenu: "Main menu",
    nav: { org: "Organization", settings: "Settings" },
    tabs: { departments: /^Departments/, requests: /^Join requests/ },
    reason: {
      noDomain: /office's domain hasn't been set up yet/,
      unmatched: /\(.+\)/,
    },
    offerTitle: (d) => `Use ${d} as this office's AD domain?`,
  },
};

const NODE_IDS = ["A", "N1", "N2", "N3"];
const NODES = Object.fromEntries(
  NODE_IDS.map((id, i) => [
    id,
    {
      port: 47971 + i + PORT_OFFSET,
      cdp: 9471 + i + PORT_OFFSET,
      dir: join(root, `laptop-${id.toLowerCase()}`),
      adFile: join(root, `ad-${id.toLowerCase()}.json`),
    },
  ]),
);

// ----- Kredensial: hanya kunci laptop uji ini yang dihapus di akhir ---------------
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

// ----- Hasil ----------------------------------------------------------------------
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "LULUS" : "GAGAL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const note = (text) => console.log(`Catatan: ${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(desc, fn, timeoutMs = 45000, everyMs = 1000) {
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
  throw new Error(`Menunggu terlalu lama: ${desc} (terakhir: ${JSON.stringify(last)?.slice(0, 200)})`);
}
const soft = (p, fallback = null) => p.catch(() => fallback);
const has = (text, needle) => (typeof needle === "string" ? text.includes(needle) : needle.test(text));
const oneLine = (t) => (t ?? "").replace(/\s+/g, " ").trim().slice(0, 220);

// ----- Instance -------------------------------------------------------------------
const running = {};
const lang = {};

function writeAd(id, data) {
  writeFileSync(NODES[id].adFile, JSON.stringify(data, null, 2), "utf8");
}

async function rememberKey(id) {
  try {
    const st = await running[id].page.evaluate(() => window.__TAURI_INTERNALS__.invoke("get_app_state"));
    if (st?.identity?.publicKey) ourKeys.add(st.identity.publicKey.toLowerCase());
  } catch {
    /* dicoba lagi nanti */
  }
}

async function launch(id, { env = {} } = {}) {
  const node = NODES[id];
  mkdirSync(node.dir, { recursive: true });
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      MIRA_DATA_DIR: node.dir,
      MIRA_PORT: String(node.port),
      MIRA_FAKE_AD: node.adFile,
      MIRA_UPDATER_ENDPOINT: "http://127.0.0.1:9/latest.json",
      ...env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${node.cdp}`,
    },
    stdio: "ignore",
  });
  const exited = new Promise((r) => child.once("exit", r));
  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
    await sleep(500);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${node.cdp}`);
    } catch {
      /* belum siap */
    }
  }
  if (!browser) {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* sudah berhenti */
    }
    throw new Error(`WebView2 ${id} tidak bisa dihubungi lewat CDP (port ${node.cdp})`);
  }
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages())[0];
    if (!page) await sleep(250);
  }
  await page.waitForLoadState("domcontentloaded");
  await page.setViewportSize({ width: 1280, height: 900 }).catch(() => {});
  await page.waitForFunction(() => "__TAURI_INTERNALS__" in window, null, { timeout: 20000 });
  running[id] = { child, browser, page, exited };
  lang[id] = "id";
  await rememberKey(id);
  return running[id];
}

async function stop(id) {
  const app = running[id];
  if (!app) return;
  delete running[id];
  await app.browser.close().catch(() => {});
  try {
    execFileSync("taskkill", ["/PID", String(app.child.pid), "/T"], { stdio: "ignore" });
  } catch {
    /* mungkin sudah berhenti */
  }
  const done = await Promise.race([app.exited.then(() => true), sleep(8000).then(() => false)]);
  if (!done) {
    try {
      execFileSync("taskkill", ["/PID", String(app.child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* sudah berhenti */
    }
  }
  await sleep(1500);
}

async function call(id, cmd, args = {}) {
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
  if (!r.ok) throw new Error(`${id} ${cmd}: ${JSON.stringify(r.error)}`);
  return r.value;
}

// ----- Bantuan layar --------------------------------------------------------------
const pg = (id) => running[id].page;
const bodyText = (id) => pg(id).locator("body").innerText();
const heading = (id) => pg(id).locator("h1.onb-title").first();
const byTid = (id, tid) => pg(id).getByTestId(tid);
const tidText = (id, tid) => soft(byTid(id, tid).first().innerText({ timeout: 3000 }), "");
const shellVisible = (id) =>
  pg(id).locator(`nav[aria-label="${LBL.id.mainMenu}"], nav[aria-label="${LBL.en.mainMenu}"]`).first().isVisible();

async function snap(id, no, slug) {
  const file = `pb${no}-${slug}.png`;
  await sleep(500);
  await pg(id).screenshot({ path: join(shots, file) }).catch((e) => note(`screenshot ${file} gagal: ${e.message}`));
  return file;
}

async function waitText(id, needle, timeoutMs = 15000, loc = null) {
  const scope = loc ?? pg(id).locator("body");
  return soft(waitFor(`${id} teks ${needle}`, async () => has(await scope.innerText(), needle), timeoutMs, 300).then(() => true), false);
}

async function waitHeading(id, re, timeoutMs = 30000) {
  return waitFor(`${id} menampilkan judul ${re}`, async () => {
    const h = heading(id);
    if (!(await h.isVisible())) return null;
    const t = (await h.innerText()).trim();
    return re.test(t) ? t : null;
  }, timeoutMs, 300);
}

async function waitShell(id, timeoutMs = 40000) {
  return soft(waitFor(`${id} masuk shell`, () => shellVisible(id), timeoutMs, 500), false);
}

async function setTheme(id, mode) {
  const page = pg(id);
  await page.emulateMedia({ colorScheme: mode }).catch(() => {});
  const ok = await soft(
    page.waitForFunction((m) => document.documentElement.getAttribute("data-theme") === m, mode, { timeout: 4000 }).then(() => true),
    false,
  );
  if (!ok) {
    note(`${id} tidak mengikuti prefers-color-scheme, data-theme=${mode} dipasang langsung`);
    await page.evaluate((m) => document.documentElement.setAttribute("data-theme", m), mode);
  }
  await sleep(300);
}

// Pemilih bahasa ringkas di onboarding (tanpa restart, langkah tetap sama).
async function setOnbLang(id, to) {
  if (lang[id] === to) return;
  await pg(id).locator(".lang-picker-compact").getByRole("radio", { name: to === "en" ? "English" : "Bahasa Indonesia", exact: true }).check();
  await pg(id).waitForFunction((l) => document.documentElement.lang === l, to, { timeout: 5000 }).catch(() => {});
  lang[id] = to;
  await sleep(400);
}

const mainNavBtn = (id, key) =>
  pg(id).getByRole("navigation", { name: LBL[lang[id]].mainMenu }).getByRole("button", { name: menuName(LBL[lang[id]].nav[key]) });

async function openOrgTab(id, tab) {
  await mainNavBtn(id, "org").click({ timeout: 10000 });
  if (!tab) {
    await sleep(800);
    return;
  }
  const btn = pg(id).locator("nav.org-tabs-wrap").getByRole("button", { name: LBL[lang[id]].tabs[tab] });
  await btn.waitFor({ timeout: 15000 });
  await btn.click();
  await sleep(800);
}

// Pengaturan > Bahasa (tanpa restart), lalu kembali ke Organisasi.
async function setAdminLang(id, to, tab = null) {
  if (lang[id] === to) return;
  await mainNavBtn(id, "settings").click({ timeout: 10000 });
  await pg(id).locator("ul.settings-nav").getByRole("button", { name: to === "en" ? "Bahasa" : "Language", exact: true }).click();
  await pg(id).locator(".lang-picker-full").getByRole("radio", { name: to === "en" ? "English" : "Bahasa Indonesia", exact: true }).check();
  lang[id] = to;
  await mainNavBtn(id, "settings").waitFor({ timeout: 8000 });
  await openOrgTab(id, tab);
}

// Langkah nama (isian dari AD), lalu cari kantor. Kalau Mira lain di PC ini ikut
// terlihat, kantor uji dipilih. Hasil: judul hasil pencarian.
async function toOffice(id, expectName) {
  const page = pg(id);
  await waitNameStep(page);
  const input = page.locator('input[name="displayName"]');
  const prefilled = await soft(waitFor("nama dari AD", async () => (await input.inputValue()) === expectName, 10000, 200).then(() => true), false);
  if (!prefilled) await input.fill(expectName);
  await page.getByRole("button", { name: LBL.id.nameSubmit, exact: true }).click();
  await passFirewall(page);
  const h = await soft(waitHeading(id, LBL.id.resultHeading, 40000), "");
  if (/^Beberapa/.test(h)) {
    note(`${id} melihat beberapa kantor (mungkin ada Mira lain di PC ini), ${ORG} dipilih`);
    await page.getByRole("radio", { name: new RegExp("^" + esc(ORG)) }).check();
  }
  return { heading: h, prefilled };
}

// Baris alasan di langkah 2. Hasil { text, reason } (kosong kalau tidak tampil).
async function reasonLine(id, timeoutMs = 15000) {
  const loc = byTid(id, TID.reason).first();
  const shown = await soft(loc.waitFor({ timeout: timeoutMs }).then(() => true), false);
  if (!shown) return { text: "", reason: null, count: 0 };
  return {
    text: (await loc.innerText()).trim(),
    reason: await loc.getAttribute("data-reason"),
    count: await byTid(id, TID.reason).count(),
  };
}

const teamSelect = (id) => pg(id).locator('select[name="team"]');

async function requestOnA(name, timeoutMs = 40000) {
  return waitFor(`A melihat permintaan ${name}`, async () => {
    const list = await must("A", "org_join_requests");
    return list.find((r) => r.displayName === name) ?? null;
  }, timeoutMs);
}
const card = (name) => pg("A").locator("li.req").filter({ has: pg("A").getByRole("heading", { name, exact: true }) });

async function scenario(title, ids, fn, { fatal = false } = {}) {
  console.log(`\n--- ${title} ---`);
  try {
    await fn();
  } catch (err) {
    check(`${title}: berjalan tanpa error`, false, String(err?.message ?? err).slice(0, 300));
    for (const id of Object.keys(running)) {
      await pg(id).screenshot({ path: join(shots, `error-ad-reason-${id.toLowerCase()}.png`) }).catch(() => {});
    }
    if (fatal) throw err;
  } finally {
    for (const id of ids) await stop(id);
  }
}

// ----- Skenario -------------------------------------------------------------------
const deptId = {};

async function main() {
  console.log(`Data uji: ${root}\nScreenshot: ${shots}\nPort QUIC ${NODES.A.port}-${NODES.N3.port}, CDP ${NODES.A.cdp}-${NODES.N3.cdp}`);

  // 1. Kantor A tanpa domain AD (PC A belum tergabung di domain).
  await scenario("1. A membuat kantor tanpa domain AD", [], async () => {
    writeAd("A", NO_DOMAIN);
    await launch("A");
    await must("A", "save_display_name", { name: "Ayu Admin" });
    await must("A", "create_organization", { name: ORG, adDomain: null });
    for (const name of [DEPT.fin, DEPT.apps]) deptId[name] = (await must("A", "org_create_department", { name })).id;
    const pkA = (await must("A", "get_app_state")).identity.publicKey;
    await must("A", "org_move_member", { publicKey: pkA, teamId: deptId[DEPT.fin] });
    await pg("A").reload();
    await pg("A").waitForFunction(() => "__TAURI_INTERNALS__" in window, null, { timeout: 20000 });
    check("1.1 A membuka kerangka utama", await waitShell("A"));
    const ad = await must("A", "org_ad_settings");
    check("1.2 Kantor tanpa domain AD", ad.domain === null && (ad.ouMap ?? []).length === 0, JSON.stringify(ad.domain));
    await setTheme("A", "light");
    await sleep(3000); // A mulai mengiklankan kantor lewat mDNS.
  }, { fatal: true });

  // 2. N1: akun macf.co.id, kantor tanpa domain.
  await scenario("2. N1 alasan: domain kantor belum diatur", ["N1"], async () => {
    writeAd("N1", fakeAd({ local: local(PEOPLE.rina) }));
    await launch("N1");
    await setTheme("N1", "light");
    const { heading: h, prefilled } = await toOffice("N1", PEOPLE.rina.displayName);
    check("2.1 N1: nama terisi dari AD", prefilled);
    check(`2.2 N1: kantor ditemukan (bukan "${LBL.id.headingMine}", karena kantor belum punya domain)`,
      h !== "" && h !== LBL.id.headingMine && h !== "Kantor belum ditemukan", h);
    const r = await reasonLine("N1");
    check("2.3 N1: satu baris alasan \"Domain kantor ini belum diatur\"",
      r.count === 1 && has(r.text, LBL.id.reason.noDomain), `${r.reason}: ${r.text}`);
    check("2.4 N1: data-reason noDomain", r.reason === "noDomain", String(r.reason));
    check("2.5 N1: departemen tidak terpilih otomatis",
      (await teamSelect("N1").evaluate((s) => s.value)) === "" && (await byTid("N1", TID.deptCaption).count()) === 0);
    await byTid("N1", TID.reason).first().scrollIntoViewIfNeeded().catch(() => {});
    await snap("N1", 21, "n1-alasan-tanpa-domain-id-terang");
    await setOnbLang("N1", "en");
    await setTheme("N1", "dark");
    const re = await reasonLine("N1", 5000);
    check("2.6 N1: alasan ikut bahasa Inggris", has(re.text, LBL.en.reason.noDomain), re.text);
    await snap("N1", 22, "n1-alasan-tanpa-domain-en-gelap");
  });

  // 3. A sekarang di PC domain macf.co.id: tawaran domain di Organisasi.
  await scenario("3. A memakai tawaran domain AD", [], async () => {
    writeAd("A", fakeAd({ users: directory() }));
    check("3.1 machine_ad_domain A sekarang macf.co.id", (await must("A", "machine_ad_domain")) === DOMAIN);
    // Tawaran dimuat saat halaman Organisasi dibuka: buka ulang lewat Pengaturan sampai muncul.
    const offer = byTid("A", TID.offer);
    const shown = await soft(waitFor("tawaran domain tampil", async () => {
      await mainNavBtn("A", "settings").click({ timeout: 10000 });
      await openOrgTab("A", null);
      return soft(offer.waitFor({ timeout: 6000 }).then(() => true), false);
    }, 45000, 500), false);
    const text = await tidText("A", TID.offer);
    check(`3.2 Organisasi A: tawaran "${LBL.id.offerTitle(DOMAIN)}"`, shown && has(text, LBL.id.offerTitle(DOMAIN)), oneLine(text));
    await offer.scrollIntoViewIfNeeded().catch(() => {});
    await snap("A", 23, "a-tawaran-domain-id-terang");
    await setAdminLang("A", "en");
    await setTheme("A", "dark");
    const enShown = await soft(offer.waitFor({ timeout: 10000 }).then(() => true), false);
    check("3.3 Tawaran domain berbahasa Inggris", enShown && has(await tidText("A", TID.offer), LBL.en.offerTitle(DOMAIN)), oneLine(await tidText("A", TID.offer)));
    await snap("A", 24, "a-tawaran-domain-en-gelap");
    await setAdminLang("A", "id");
    await setTheme("A", "light");
    await offer.waitFor({ timeout: 10000 }).catch(() => {});
    let viaUi = false;
    try {
      await offer.getByRole("button", { name: LBL.id.offerUse(DOMAIN), exact: true }).click({ timeout: 10000 });
      viaUi = true;
    } catch (e) {
      note(`klik tawaran domain gagal: ${e.message}`);
      await must("A", "org_set_ad_settings", { domain: DOMAIN, ouMap: [] });
    }
    check("3.4 A menekan \"Pakai macf.co.id\" (satu klik)", viaUi);
    const saved = await soft(waitFor("domain tersimpan", async () => (await must("A", "org_ad_settings")).domain === DOMAIN, 15000, 500), false);
    check("3.5 Domain AD kantor tersimpan macf.co.id", saved);
    const gone = await soft(offer.waitFor({ state: "detached", timeout: 10000 }).then(() => true), false);
    check("3.6 Tawaran hilang setelah dipakai", gone || !(has(await bodyText("A"), LBL.id.offerTitle(DOMAIN))));
    await sleep(3000); // pengumuman mDNS ad=macf.co.id dan jawaban join_info baru.
  });

  // 4. N2 Julius: departemen AD belum dicocokkan, A mencocokkan OU lewat kartu.
  await scenario("4. N2 departemen belum dicocokkan, A mencocokkan OU", ["N2"], async () => {
    writeAd("N2", fakeAd({ local: local(PEOPLE.julius) }));
    await launch("N2");
    await setTheme("N2", "light");
    const { heading: h, prefilled } = await toOffice("N2", PEOPLE.julius.displayName);
    check("4.1 N2: nama \"Julius\" terisi dari AD", prefilled);
    check(`4.2 N2: kantor domain sama dipakai langsung ("${LBL.id.headingMine}")`, h === LBL.id.headingMine, h);
    const r = await reasonLine("N2");
    const m = r.text.match(LBL.id.reason.unmatched);
    check("4.3 N2: alasan \"Departemen Anda di akun Windows (...) belum dicocokkan\"",
      r.count === 1 && Boolean(m) && r.reason === "unmatched", `${r.reason}: ${r.text}`);
    check(`4.4 N2: alasan menyebut OU paling dalam "${INNER_OU}"`, m?.[1]?.includes(INNER_OU) ?? false, m?.[1] ?? "");
    check("4.5 N2: departemen tidak terpilih otomatis", (await teamSelect("N2").evaluate((s) => s.value)) === "");
    await byTid("N2", TID.reason).first().scrollIntoViewIfNeeded().catch(() => {});
    await snap("N2", 25, "n2-alasan-departemen-id-terang");
    await setOnbLang("N2", "en");
    await setTheme("N2", "dark");
    const re = await reasonLine("N2", 5000);
    check("4.6 N2: alasan ikut bahasa Inggris dan tetap menyebut OU", re.text !== r.text && re.text.includes(INNER_OU), re.text);
    await snap("N2", 26, "n2-alasan-departemen-en-gelap");
    await setOnbLang("N2", "id");
    await setTheme("N2", "light");

    await teamSelect("N2").selectOption({ label: N2_MANUAL_DEPT });
    await pg("N2").getByRole("button", { name: LBL.id.sendRequest }).click();
    await waitHeading("N2", LBL.id.waitingHeading, 30000);
    const code = (await pg("N2").locator(".onb-match").innerText()).trim();
    const req = await requestOnA(PEOPLE.julius.displayName);
    check("4.7 A menerima permintaan N2 dengan klaim AD, tanpa usulan departemen",
      req.code === code && req.ad?.user === PEOPLE.julius.user && req.ad?.suggestedTeamId === null && (req.ad?.ous ?? [])[0] === INNER_OU,
      JSON.stringify({ ous: req.ad?.ous?.slice(0, 2), suggested: req.ad?.suggestedTeamId }));

    await openOrgTab("A", "requests");
    const c = card(PEOPLE.julius.displayName);
    await c.waitFor({ timeout: 30000 });
    const adBefore = await soft(c.getByTestId(TID.cardAd).innerText({ timeout: 10000 }), "");
    const openBtn = c.getByRole("button", { name: LBL.id.matchOpen(PEOPLE.julius.displayName) });
    check("4.8 Kartu A: tombol \"Cocokkan OU ini ke departemen...\"",
      (await openBtn.count()) === 1 && has(await openBtn.innerText(), LBL.id.matchOpenText), oneLine(adBefore));
    check(`4.9 Blok AD kartu belum menyebut ${MAP_TO} sebelum dicocokkan`, !adBefore.includes(MAP_TO));
    await c.scrollIntoViewIfNeeded().catch(() => {});
    await snap("A", 27, "a-kartu-cocokkan-ou-id-terang");

    let viaUi = false;
    try {
      await openBtn.click({ timeout: 10000 });
      const form = c.getByTestId(TID.match);
      const ouRadio = form.getByRole("radio", { name: new RegExp("^" + esc(INNER_OU)) });
      if ((await ouRadio.count()) > 0) await ouRadio.first().check();
      else note("pilihan OU tidak berbentuk radio; memakai pilihan bawaan");
      await form.getByLabel(LBL.id.matchDeptLabel, { exact: true }).selectOption({ label: MAP_TO });
      await form.getByRole("button", { name: LBL.id.matchSubmit, exact: true }).click();
      viaUi = true;
    } catch (e) {
      note(`cocokkan OU lewat kartu gagal: ${e.message}`);
      await pg("A").screenshot({ path: join(shots, "error-ad-reason-cocokkan-ou.png") }).catch(() => {});
      const cur = await must("A", "org_ad_settings");
      await must("A", "org_set_ad_settings", { domain: DOMAIN, ouMap: [...(cur.ouMap ?? []), { ou: INNER_OU, team: deptId[MAP_TO] }] });
    }
    check(`4.10 A mencocokkan OU "${INNER_OU}" ke ${MAP_TO} lewat kartu`, viaUi);
    const mapped = await soft(waitFor("pemetaan OU tersimpan", async () =>
      (await must("A", "org_ad_settings")).ouMap?.some((x) => x.ou === INNER_OU && x.team === deptId[MAP_TO]), 15000, 500), false);
    check("4.11 Pengaturan AD: baris pemetaan OU paling dalam ke departemen", mapped);
    const reqAfter = await soft(waitFor("usulan departemen di permintaan", async () => {
      const x = (await must("A", "org_join_requests")).find((q) => q.id === req.id);
      return x?.ad?.suggestedTeamId === deptId[MAP_TO] ? x : null;
    }, 15000, 500), null);
    check(`4.12 Permintaan N2 kini punya usulan departemen ${MAP_TO}`, Boolean(reqAfter), JSON.stringify(reqAfter?.ad?.suggestedTeamId ?? null));
    check(`4.13 Kartu A dimuat ulang dan blok AD menyebut ${MAP_TO}`, await waitText("A", MAP_TO, 15000, c.getByTestId(TID.cardAd)),
      oneLine(await soft(c.getByTestId(TID.cardAd).innerText(), "")));
    check("4.14 Kartu A mengumumkan hasil pencocokan", await waitText("A", LBL.id.matchDone(INNER_OU, MAP_TO), 8000, c));
    check(`4.15 Permintaan tetap ke ${N2_MANUAL_DEPT} yang dipilih peminta`, reqAfter?.teamId === deptId[N2_MANUAL_DEPT]);
    await c.scrollIntoViewIfNeeded().catch(() => {});
    await setAdminLang("A", "en", "requests");
    await setTheme("A", "dark");
    await card(PEOPLE.julius.displayName).waitFor({ timeout: 15000 }).catch(() => {});
    await card(PEOPLE.julius.displayName).scrollIntoViewIfNeeded().catch(() => {});
    await snap("A", 28, "a-kartu-ou-dicocokkan-en-gelap");
    await setAdminLang("A", "id", "requests");
    await setTheme("A", "light");

    // Selesaikan permintaan supaya tidak menghitung ke batas 3 permintaan per IP.
    try {
      await card(PEOPLE.julius.displayName).getByRole("button", { name: LBL.id.approveAria(PEOPLE.julius.displayName) }).click({ timeout: 10000 });
    } catch (e) {
      note(`Setujui N2 lewat kartu gagal: ${e.message}`);
      await call("A", "org_approve_join", { requestId: req.id });
    }
    check("4.16 N2 disetujui dan masuk Mira", await waitShell("N2"));
  });

  // 5. N3: akun domain lain.
  await scenario("5. N3 alasan: domain berbeda", ["N3"], async () => {
    writeAd("N3", fakeAd({ machineDomain: OTHER_DOMAIN, local: local(PEOPLE.budi) }));
    await launch("N3");
    await setTheme("N3", "light");
    const { heading: h } = await toOffice("N3", PEOPLE.budi.displayName);
    check("5.1 N3: kantor A ditemukan, tidak dipakai langsung", h !== "" && h !== LBL.id.headingMine && h !== "Kantor belum ditemukan", h);
    const r = await reasonLine("N3");
    check(`5.2 N3: alasan "Domain kantor (${DOMAIN}) berbeda dengan domain akun Anda (${OTHER_DOMAIN})"`,
      r.count === 1 && has(r.text, LBL.id.reason.otherDomain(DOMAIN, OTHER_DOMAIN)) && r.reason === "otherDomain", `${r.reason}: ${r.text}`);
    await byTid("N3", TID.reason).first().scrollIntoViewIfNeeded().catch(() => {});
    await snap("N3", 29, "n3-alasan-domain-beda-id-terang");
  });
}

// ----- Jalankan dan bersihkan -------------------------------------------------------
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const id of Object.keys(running)) await stop(id);
  for (const target of miraCredentials()) {
    if (credentialsBefore.has(target)) continue;
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
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
process.once("SIGINT", () => {
  console.log("\nDihentikan: membersihkan instance uji...");
  void cleanup().finally(() => process.exit(130));
});

try {
  await main();
} catch (err) {
  console.log(`Skrip berhenti: ${err?.message ?? err}`);
}
await cleanup();

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} dari ${results.length} pemeriksaan lulus.`);
if (failed) {
  console.log("Yang gagal:");
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
}
process.exit(failed || results.length === 0 ? 1 : 0);
