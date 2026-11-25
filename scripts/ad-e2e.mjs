// Uji ujung ke ujung onboarding dengan Active Directory (docs/plans/onboarding-ad.md)
// di satu PC Windows.
//
// Setiap instance mira.exe (build debug) punya folder data (MIRA_DATA_DIR),
// port QUIC (MIRA_PORT), port debug WebView2, dan file AD tiruan sendiri
// (MIRA_FAKE_AD, bagian 3.1 rencana). Mira membaca ulang file itu di setiap
// panggilan, jadi skrip menulis ulang file untuk mengganti keadaan AD di tengah
// uji (misalnya reachable: false).
//
//   A    Ayu Admin  superadmin, PC domain macf.co.id. Kantor baru lewat "Untuk
//                   admin IT" (isian domain AD terisi otomatis), departemen dan
//                   pemetaan OU lewat tab Departemen.
//   K    Kiki       kantor kedua tanpa domain AD, supaya N1 melihat dua kantor
//                   dan halaman Organisasi A memperingatkan kantor lain.
//   N1   Rina       akun domain lengkap. Satu-satunya kantor domain itu dipakai
//                   langsung ("Kantor: ... (macf.co.id)", tombol Ubah kantor),
//                   departemen dari atribut (Keuangan). Disetujui.
//   N2   Hartono    atribut department kosong, departemen dari pemetaan OU. Disetujui.
//   N3   Gita       department "Gudang" belum ada di Mira, nama diubah sendiri
//                   (kartu: tidak cocok). Disetujui.
//   N4   Dodi       akun dinonaktifkan di AD A, lalu AD tidak terjangkau. Ditolak.
//   N5   Nia        PC tanpa domain: alur manual. Disetujui.
//   N6   Eko        data AD sebagian (localPartial). Dikirim lalu ditolak lewat command.
//   N7   Fajar      pembacaan AD lambat (localDelayMs 8000): layar tidak beku.
//   N8   Sari       domain sama dengan kantor A: tanpa pilihan kantor baru.
//   N9   Tono       tanpa domain, kantor A terlihat: peringatan dan konfirmasi
//                   sebelum layar kantor baru.
//   K2   Kurnia     kantor kedua untuk domain macf.co.id, dibuat setelah A: K2
//                   mendapat peringatan kantor lebih lama di Organisasi.
//   N11  Wulan      domain sama, melihat A dan K2: A "kantor utama" dan terpilih.
//   L    Lukas      kantor Mira versi lama (TXT org tanpa j), A sudah dihentikan.
//   N10  Lina       melihat kantor lama, bukan "Kantor belum ditemukan".
//
// A disiapkan dengan MIRA_DISABLE_MDNS=1 (supaya layar "Kantor belum ditemukan"
// tidak terganggu Mira lain di PC ini), lalu dijalankan ulang dengan mDNS.
// Batas 3 permintaan menunggu per IP: setiap permintaan diputuskan sebelum
// yang berikutnya.
//
// Pakai:  node scripts/ad-e2e.mjs <path mira.exe debug> <folder screenshot> [folder induk data uji]
// Port:   MIRA_PORT 47941-47955, CDP 9441-9455, keduanya digeser E2E_PORT_OFFSET.
// Butuh:  playwright-core (alat uji saja, tidak dibundel ke aplikasi).

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { fillNewOffice, menuName, openAdminIT, passFirewall, reachNotFound, waitNameStep } from "./e2e-onboarding.mjs";

const exe = resolve(process.argv[2] ?? "src-tauri/target/debug/mira.exe");
const shots = resolve(process.argv[3] ?? "docs/progress/screenshots/onboarding-ad");
mkdirSync(shots, { recursive: true });
const root = mkdtempSync(join(resolve(process.argv[4] ?? tmpdir()), "mira-ad-e2e-"));
const PORT_OFFSET = Number(process.env.E2E_PORT_OFFSET ?? 0) || 0;

// ----- Data uji ------------------------------------------------------------------
const DOMAIN = "macf.co.id";
const ORG = "Kantor Uji AD";
const ORG_K = "Kantor Uji Lain";
const ORG_L = "Kantor Lama Uji";
const ORG_K2 = "Kantor Uji AD Kedua";
const DEPT = { mgmt: "Manajemen", fin: "Keuangan", itdev: "IT Development", design: "Desain", warehouse: "Gudang" };
// OU dalam DN Hartono yang dipetakan ke "IT Development". OU paling dalam
// (IT-Development) sengaja tidak sama persis dengan nama departemen Mira.
const OU_MAP = { ou: "IT-Department", team: DEPT.itdev };

const dn = (user, ous) => `CN=${user},${ous.map((o) => `OU=${o}`).join(",")},DC=macf,DC=co,DC=id`;
const PEOPLE = {
  rina: { user: "rina", displayName: "Rina Wijaya", department: DEPT.fin, dn: dn("rina", ["Finance", "HO", "Member Users"]) },
  // Contoh DN dari brief user.
  hartono: {
    user: "hartono",
    displayName: "Hartono",
    department: null,
    dn: "CN=hartono,OU=IT-Development,OU=IT-Department,OU=IT & CP Department,OU=HO,OU=Member Users,DC=macf,DC=co,DC=id",
  },
  gita: { user: "gita", displayName: "Gita Lestari", department: DEPT.warehouse, dn: dn("gita", ["Warehouse", "Member Users"]) },
  dodi: { user: "dodi", displayName: "Dodi Pratama", department: DEPT.design, dn: dn("dodi", ["Design", "HO", "Member Users"]) },
  eko: { user: "eko", displayName: "Eko Saputra", department: DEPT.fin, dn: dn("eko", ["Finance", "HO", "Member Users"]) },
  fajar: { user: "fajar", displayName: "Fajar Nugroho", department: DEPT.fin, dn: dn("fajar", ["Finance", "HO", "Member Users"]) },
  wulan: { user: "wulan", displayName: "Wulan Sari", department: DEPT.fin, dn: dn("wulan", ["Finance", "HO", "Member Users"]) },
  sari: { user: "sari", displayName: "Sari Dewi", department: DEPT.fin, dn: dn("sari", ["Finance", "HO", "Member Users"]) },
};
const N3_TYPED_NAME = "Gita L.";
const N5_NAME = "Nia Rahma";
const N9_NAME = "Tono Uji";
const N10_NAME = "Lina Uji";

// Isi AD tiruan (bagian 3.1). `users` hanya dibaca di laptop penyetuju (A).
const local = (p) => ({ domain: DOMAIN, user: p.user, dn: p.dn, displayName: p.displayName, department: p.department });
const directory = () =>
  Object.fromEntries(
    ["rina", "hartono", "gita", "dodi", "eko"].map((k) => {
      const p = PEOPLE[k];
      return [p.user, { dn: p.dn, displayName: p.displayName, department: p.department, disabled: k === "dodi" }];
    }),
  );
const fakeAd = (over = {}) => ({
  machineDomain: DOMAIN,
  local: null,
  localPartial: false,
  localDelayMs: 0,
  reachable: true,
  users: {},
  ...over,
});
const NO_DOMAIN = { machineDomain: null, local: null };

// ----- Teks dan pencari elemen ----------------------------------------------------
// Sumber: src/i18n/onboarding.{id,en}.ts, org-ad.{id,en}.ts, org-requests.{id,en}.ts,
// org.{id,en}.ts, org-departments.id.ts. Perbarui di sini kalau kamusnya berubah.
// Elemen AD dicari lewat data-testid (tidak bergantung bahasa) bila ada.
const TID = {
  nameSource: "onb-ad-name-source", // NameStep
  officeMatch: "onb-ad-office-match", // OfficeStep, penanda domain kantor (daftar pilihan)
  officeSummary: "onb-ad-office-summary", // OfficeStep, "Kantor: <nama> (<domain>)"
  officePrimary: "onb-ad-office-primary", // beberapa kantor domain sama: yang paling awal
  officeLater: "onb-ad-office-later",
  deptCaption: "onb-ad-dept", // OfficeStep, asal usulan departemen
  box: "onb-ad-box", // OfficeStep, "Yang dikirim ke admin"
  partial: "onb-ad-partial",
  skipped: "onb-ad-skipped",
  adSettings: "ad-settings", // AdSettings.tsx
  cardAd: "join-ad", // JoinRequestsPanelAd.tsx
  cardStatus: "join-ad-status", // atribut data-status = AdCheckStatus
  outdated: "join-requester-outdated",
  otherOffices: "org-other-offices", // OtherOfficesNotice.tsx, data-same-domain="true"
  olderOffice: "org-older-office", // hanya superadmin kantor yang lebih baru
  cardLive: "join-ad-live", // wilayah aria-live, kosong sampai "Periksa lagi"
  legacy: "onb-legacy-offices",
  sameDomainGuard: "onb-same-domain",
  secondOffice: "onb-second-office",
};
const TXT = {
  id: {
    mainMenu: "Menu utama",
    nav: { org: "Organisasi", settings: "Pengaturan" },
    settingsLanguage: "Bahasa",
    // "Departemen" saja: tab "Departemen saya" (divisi, v0.6) juga diawali kata ini.
    tabs: { departments: /^Departemen$/, requests: /^Permintaan bergabung/ },
    nameSubmit: "Lanjut",
    nameSource: (d) => `Diisi dari akun Windows Anda (${d})`,
    officeMatch: (d) => `Domain kantor Anda: ${d}`,
    officeSummary: (name, d) => `Kantor: ${name} (${d})`,
    changeOffice: "Ubah kantor", // aria-label tombol Ubah
    primary: (d) => `Kantor utama untuk ${d}`,
    headingMine: "Kantor Anda ditemukan", // kantor dipakai langsung karena domainnya sama
    deptFromAccount: (d) => `Dari akun Windows Anda: ${d}`,
    deptMissing: (d) => `Departemen Anda di akun Windows (${d}) belum ada di Mira`,
    boxTitle: "Yang dilihat admin",
    partial: "Sebagian data akun Windows tidak terbaca",
    newOfficeAdLabel: "Domain Active Directory (opsional)",
    // AdSettings: label baris = nama kolom + " baris n" (sr-only).
    adDomainLabel: "Domain AD",
    adAddRow: "Tambah baris",
    adOuRow: (n) => new RegExp(`^Nama OU\\s*baris ${n}$`),
    adTeamRow: (n) => new RegExp(`^Departemen\\s*baris ${n}$`),
    adSave: "Simpan pengaturan AD",
    newDept: "Departemen baru",
    deptNameLabel: "Nama departemen",
    deptCreate: "Buat departemen",
    cardTitle: "Active Directory",
    status: {
      match: "Akun ada dan aktif di AD, nama dan departemen sama",
      mismatch: "Berbeda dengan AD",
      disabled: "Akun AD dinonaktifkan",
      unreachable: "AD tidak bisa dihubungi dari laptop ini",
    },
    cardDeptMissing: (d) => `${d} (belum ada di Mira)`,
    mismatchName: (dir, req) => `Nama di AD: ${dir}, di permintaan: ${req}`,
    recheckAria: (n) => `Periksa lagi akun AD ${n}`,
    // TODO(teks): agen lain menambah status "exists", ketidakcocokan klaim
    // (claim_name, claim_department, location) dan peringatan usedBy di kartu.
    // Tambahkan teksnya di sini dan pemeriksaannya di skenario 2-5 setelah final.
    approveAria: (n) => `Setujui permintaan ${n}`,
    rejectAria: (n) => `Tolak permintaan ${n}`,
    rejectConfirm: (n) => `Tolak ${n}`,
    // Bagian 6: kantor lain, kantor kedua, kantor versi lama.
    otherOffices: /Ada \d+ laptop di jaringan ini yang tergabung di kantor Mira lain/,
    otherSameDomain: "memakai domain AD yang sama dengan kantor ini",
    olderTitle: "Domain AD ini sudah dipakai kantor lain yang dibuat lebih dulu",
    otherWay: "Cari dengan cara lain",
    newOfficeButton: "Siapkan Mira untuk kantor baru",
    seenTitle: "Sudah ada kantor Mira di jaringan ini",
    sameDomain: (d) => `Laptop ini memakai domain ${d}, sama dengan kantor`,
    confirmPhrase: "kantor baru",
    confirmLabel: /^Tetap perlu kantor baru\?/,
    confirmButton: "Tetap siapkan kantor baru",
    legacyHeading: "Kantor ditemukan, tapi belum bisa menerima permintaan",
    legacyTitle: "Kantor dengan Mira versi lama",
    legacyUpdate: "memperbarui Mira",
    // Laptop MIRA_TEST_LEGACY_ADVERT hanya mengumumkan v, pk, org (tanpa on): tanpa nama.
    legacyUnnamed: /Kantor tanpa nama \(\d+ laptop\)/,
    inviteButton: /Pakai kode undangan/,
  },
  en: {
    mainMenu: "Main menu",
    nav: { org: "Organization", settings: "Settings" },
    settingsLanguage: "Language",
    tabs: { departments: /^Departments/, requests: /^Join requests/ },
    officeMatch: (d) => `Your office domain: ${d}`,
    officeSummary: (name, d) => `${name} (${d})`,
    boxTitle: "What the admin sees",
    status: {
      match: "Account exists and is active in AD, name and department match",
      mismatch: "Differs from AD",
      disabled: "AD account is disabled",
      unreachable: "Can't reach AD from this laptop",
    },
    cardDeptMissing: (d) => `${d} (not in Mira yet)`,
  },
};
// Teks AD yang tidak boleh tampil di alur manual (PC tanpa domain).
// Akun AD tampil sebagai user@domain; lokasi OU dari luar ke dalam dengan " › ".
const adAccount = (p) => `${p.user}@${DOMAIN}`;
const ouPath = (p) => [...p.dn.matchAll(/OU=([^,]+)/g)].map((m) => m[1]).reverse().join(" › ");
const AD_WORDS = /Active Directory|\bAD\b|Akun Windows|Domain kantor Anda/;
// Build debug: laptop ini hanya mengumumkan v, pk, org (tanpa on dan j) dan
// menolak join_info, seperti Mira 0.1/0.2.
const LEGACY_ENV = { MIRA_TEST_LEGACY_ADVERT: "1" };

// "Kantor Anda ditemukan": satu kantor dengan domain AD sama, dipakai langsung (bagian 6.1).
const RESULT_RE = /^(Kantor Anda ditemukan|Kantor ditemukan|Beberapa kantor ditemukan|Kantor belum ditemukan)/;
const NODE_IDS = ["A", "K", "N1", "N2", "N3", "N4", "N5", "N6", "N7", "N8", "N9", "K2", "N11", "L", "N10"];
const NODES = Object.fromEntries(
  NODE_IDS.map((id, i) => [
    id,
    {
      port: 47941 + i + PORT_OFFSET,
      cdp: 9441 + i + PORT_OFFSET,
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

// ----- Instance -------------------------------------------------------------------
const running = {};
const lang = {}; // bahasa tampilan tiap instance yang sedang dipakai skrip

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

// Menutup dengan wajar dulu, baru dipaksa. Hanya proses yang dijalankan skrip ini.
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
const shellVisible = (id) =>
  pg(id).locator(`nav[aria-label="${TXT.id.mainMenu}"], nav[aria-label="${TXT.en.mainMenu}"]`).first().isVisible();
const has = (text, needle) => (typeof needle === "string" ? text.includes(needle) : needle.test(text));

let shotNo = 0;
async function snap(id, slug) {
  shotNo += 1;
  const file = `ad${String(shotNo).padStart(2, "0")}-${slug}.png`;
  await sleep(400);
  await pg(id).screenshot({ path: join(shots, file) }).catch((e) => console.log(`Catatan: screenshot ${file} gagal: ${e.message}`));
  return file;
}

async function waitHeading(id, re, timeoutMs = 30000) {
  return waitFor(`${id} menampilkan judul ${re}`, async () => {
    const h = heading(id);
    if (!(await h.isVisible())) return null;
    const t = (await h.innerText()).trim();
    return re.test(t) ? t : null;
  }, timeoutMs, 300);
}

// Teks muncul di dalam `loc` (atau body) dalam batas waktu. Hasil: true/false.
async function waitText(id, needle, timeoutMs = 15000, loc = null) {
  const scope = loc ?? pg(id).locator("body");
  return soft(waitFor(`${id} teks ${needle}`, async () => has(await scope.innerText(), needle), timeoutMs, 300).then(() => true), false);
}

async function waitValue(loc, expected, timeoutMs) {
  return soft(waitFor(`isian bernilai ${expected}`, async () => (await loc.inputValue()) === expected, timeoutMs, 200).then(() => true), false);
}

const teamSelect = (id) => pg(id).locator('select[name="team"]');
const selectedTeam = (id) => teamSelect(id).evaluate((s) => (s.value ? (s.selectedOptions[0]?.textContent ?? "").trim() : ""));
const byTid = (id, tid) => pg(id).getByTestId(tid);
const tidText = (id, tid) => soft(byTid(id, tid).first().innerText({ timeout: 3000 }), "");
const tidCount = (id, tid) => byTid(id, tid).count();

// Tema lewat prefers-color-scheme (mode bawaan "system" mengikutinya tanpa muat
// ulang, jadi layar onboarding tidak hilang). Cadangan: atribut data-theme langsung.
async function setTheme(id, mode) {
  const page = pg(id);
  await page.emulateMedia({ colorScheme: mode }).catch(() => {});
  const ok = await soft(
    page.waitForFunction((m) => document.documentElement.getAttribute("data-theme") === m, mode, { timeout: 4000 }).then(() => true),
    false,
  );
  if (!ok) {
    console.log(`Catatan: ${id} tidak mengikuti prefers-color-scheme, data-theme=${mode} dipasang langsung`);
    await page.evaluate((m) => document.documentElement.setAttribute("data-theme", m), mode);
  }
  await sleep(300);
}

// Pemilih bahasa ringkas di onboarding (tanpa restart, layar tetap di langkah yang sama).
async function setOnbLang(id, to) {
  if (lang[id] === to) return;
  await pg(id).locator(".lang-picker-compact").getByRole("radio", { name: to === "en" ? "English" : "Bahasa Indonesia", exact: true }).check();
  await pg(id).waitForFunction((l) => document.documentElement.lang === l, to, { timeout: 5000 }).catch(() => {});
  lang[id] = to;
  await sleep(400);
}

const mainNavBtn = (id, key) =>
  pg(id).getByRole("navigation", { name: TXT[lang[id]].mainMenu }).getByRole("button", { name: menuName(TXT[lang[id]].nav[key]) });

async function openOrgTab(id, tab) {
  await mainNavBtn(id, "org").click({ timeout: 10000 });
  const btn = pg(id).locator("nav.org-tabs-wrap").getByRole("button", { name: TXT[lang[id]].tabs[tab] });
  await btn.waitFor({ timeout: 15000 });
  await btn.click();
  await sleep(800);
}

// Pengaturan > Bahasa (tanpa restart), lalu kembali ke tab Permintaan bergabung.
async function setAdminLang(id, to) {
  if (lang[id] === to) return;
  await mainNavBtn(id, "settings").click({ timeout: 10000 });
  await pg(id).locator("ul.settings-nav").getByRole("button", { name: TXT[lang[id]].settingsLanguage, exact: true }).click();
  await pg(id).locator(".lang-picker-full").getByRole("radio", { name: to === "en" ? "English" : "Bahasa Indonesia", exact: true }).check();
  lang[id] = to;
  await mainNavBtn(id, "settings").waitFor({ timeout: 8000 });
  await openOrgTab(id, "requests");
}

// Kartu permintaan di laptop A, dicari dari judul nama peminta.
const card = (name) =>
  pg("A").locator("li.req").filter({ has: pg("A").getByRole("heading", { name, exact: true }) });
async function waitCardStatus(name, status, timeoutMs = 20000) {
  return soft(
    card(name).locator(`[data-testid="${TID.cardStatus}"][data-status="${status}"]`).waitFor({ timeout: timeoutMs }).then(() => true),
    false,
  );
}

async function requestOnA(name, timeoutMs = 40000) {
  return waitFor(`A melihat permintaan ${name}`, async () => {
    const list = await must("A", "org_join_requests");
    return list.find((r) => r.displayName === name) ?? null;
  }, timeoutMs);
}

// Langkah nama. expect: nama yang harus terisi dari AD (null: harus tetap kosong).
// type: nama yang diketik (null: biarkan isian dari AD). Hasil: { prefilled, value, source }.
async function nameStep(id, { expect = null, type = null, waitMs = 10000 } = {}) {
  const page = pg(id);
  await waitNameStep(page);
  const input = page.locator('input[name="displayName"]');
  let prefilled;
  if (expect) {
    prefilled = await waitValue(input, expect, waitMs);
  } else {
    await sleep(waitMs);
    prefilled = (await input.inputValue()) !== "";
  }
  const value = await input.inputValue();
  const source = await tidText(id, TID.nameSource);
  if (type !== null) await input.fill(type);
  return { prefilled, value, source, input };
}

async function toOffices(id) {
  await pg(id).getByRole("button", { name: TXT.id.nameSubmit, exact: true }).click();
  await passFirewall(pg(id));
  return soft(waitHeading(id, RESULT_RE, 40000), "");
}

async function sendRequest(id) {
  await pg(id).getByRole("button", { name: "Kirim permintaan" }).click();
  await waitHeading(id, /^Menunggu persetujuan$/, 30000);
  return (await pg(id).locator(".onb-match").innerText()).trim();
}

async function approveByCard(name) {
  try {
    await card(name).getByRole("button", { name: TXT.id.approveAria(name) }).click({ timeout: 10000 });
    return true;
  } catch (e) {
    console.log(`Catatan: Setujui lewat kartu ${name} gagal: ${e.message}`);
    const req = await requestOnA(name, 5000).catch(() => null);
    if (req) await call("A", "org_approve_join", { requestId: req.id });
    return false;
  }
}

async function waitShell(id) {
  return soft(waitFor(`${id} masuk shell`, () => shellVisible(id), 40000, 500), false);
}

// Screenshot kartu A dalam empat kombinasi bahasa dan tema. Hasil: status
// bahasa Inggris tampil (true/false). Setelahnya kembali ke Indonesia, terang.
async function adminCardShots(name, statusKey, slug) {
  let enOk = true;
  for (const [lg, th] of [["id", "light"], ["id", "dark"], ["en", "dark"], ["en", "light"]]) {
    await setAdminLang("A", lg);
    await setTheme("A", th);
    const c = card(name);
    await c.waitFor({ timeout: 15000 });
    if (lg === "en") enOk = enOk && (await waitText("A", TXT.en.status[statusKey], 15000, c.getByTestId(TID.cardStatus)));
    await c.scrollIntoViewIfNeeded().catch(() => {});
    await snap("A", `kartu-${slug}-${lg}-${th === "light" ? "terang" : "gelap"}`);
  }
  await setAdminLang("A", "id");
  await setTheme("A", "light");
  return enOk;
}

// Permintaan yang tertinggal di A (skenario gagal di tengah) ditolak, supaya
// batas 3 permintaan per IP tidak menghalangi skenario berikutnya.
async function rejectLeftovers() {
  if (!running.A) return;
  const r = await call("A", "org_join_requests");
  if (!r.ok) return;
  for (const req of r.value) {
    console.log(`Catatan: permintaan ${req.displayName} yang tertinggal ditolak lewat command`);
    await call("A", "org_reject_join", { requestId: req.id });
  }
}

async function scenario(title, ids, fn, { fatal = false } = {}) {
  console.log(`\n--- ${title} ---`);
  try {
    await fn();
  } catch (err) {
    check(`${title}: berjalan tanpa error`, false, String(err?.message ?? err).slice(0, 300));
    for (const id of Object.keys(running)) {
      if (running[id]) await pg(id).screenshot({ path: join(shots, `error-${id.toLowerCase()}-${shotNo}.png`) }).catch(() => {});
    }
    if (fatal) throw err;
  } finally {
    for (const id of ids) await stop(id);
    await soft(rejectLeftovers());
  }
}

// ----- Skenario -------------------------------------------------------------------
const deptId = {};
const P = PEOPLE;

async function main() {
  console.log(`Data uji: ${root}\nScreenshot: ${shots}\nPort QUIC ${NODES.A.port}-${NODES.N10.port}, CDP ${NODES.A.cdp}-${NODES.N10.cdp} (E2E_PORT_OFFSET ${PORT_OFFSET})`);

  // 1. Kantor baru dengan domain AD, departemen, pemetaan OU.
  await scenario("1. A membuat kantor dengan domain AD", [], async () => {
    writeAd("A", fakeAd({ users: directory() }));
    await launch("A", { env: { MIRA_DISABLE_MDNS: "1" } });
    const pa = pg("A");
    await setTheme("A", "light");
    // Langkah newOffice() dari e2e-onboarding.mjs, dipecah supaya isian bawaan
    // (nama organisasi dan domain dari machine_ad_domain) bisa dibaca sebelum diisi.
    await reachNotFound(pa, "Ayu Admin");
    await openAdminIT(pa);
    await pa.getByRole("button", { name: TXT.id.newOfficeButton, exact: true }).click();
    await pa.getByRole("heading", { name: TXT.id.newOfficeButton }).waitFor({ timeout: 10000 });
    const domainInput = pa.locator('input[name="adDomain"]');
    const orgInput = pa.locator('input[name="orgName"]');
    const domainValue = await soft(waitFor("isian domain AD terisi", async () => (await domainInput.inputValue()) || null, 8000, 200), "");
    const orgDefault = await soft(waitFor("nama organisasi bawaan", async () => (await orgInput.inputValue()) || null, 5000, 200), "");
    check("1.1 Layar kantor baru punya isian \"Domain Active Directory (opsional)\"",
      (await soft(pa.getByLabel(TXT.id.newOfficeAdLabel, { exact: true }).count(), 0)) === 1);
    check(`1.2 Isian domain AD terisi otomatis "${DOMAIN}" dari machine_ad_domain`, domainValue === DOMAIN, domainValue);
    check(`1.2b Nama organisasi bawaan = domain AD "${DOMAIN}" (bisa diubah)`, orgDefault === DOMAIN, orgDefault);
    await snap("A", "kantor-baru-bawaan-domain");
    await fillNewOffice(pa, { name: "Ayu Admin", org: ORG, dept: DEPT.mgmt });
    check("1.2c Domain AD tetap terisi setelah nama organisasi diganti", (await domainInput.inputValue()) === DOMAIN);
    await snap("A", "kantor-baru-domain-ad");
    await pa.getByRole("button", { name: "Buat organisasi" }).click();
    await pa.getByRole("navigation", { name: TXT.id.mainMenu }).waitFor({ timeout: 20000 });
    await rememberKey("A");
    check("1.3 machine_ad_domain di A", (await must("A", "machine_ad_domain")) === DOMAIN);
    const st = await must("A", "get_app_state");
    check("1.4 Kantor dibuat lewat layar Untuk admin IT", st.organization?.name === ORG, st.organization?.name);
    const ad0 = await must("A", "org_ad_settings");
    check("1.5 Domain AD kantor tersimpan saat kantor dibuat", ad0.domain === DOMAIN && ad0.canEdit === true, JSON.stringify(ad0.domain));

    // Departemen lewat dialog "Departemen baru".
    await openOrgTab("A", "departments");
    for (const name of [DEPT.fin, DEPT.itdev, DEPT.design]) {
      await pa.getByRole("button", { name: TXT.id.newDept, exact: true }).click();
      const dlg = pa.getByRole("dialog");
      await dlg.getByLabel(TXT.id.deptNameLabel).fill(name);
      await dlg.getByRole("button", { name: TXT.id.deptCreate }).click();
      await dlg.waitFor({ state: "detached", timeout: 10000 });
      await pa.locator("table.dept-table").getByText(name, { exact: true }).waitFor({ timeout: 10000 });
    }
    for (const d of await must("A", "org_departments", { includeArchived: false })) deptId[d.name] = d.id;
    check("1.6 Departemen Keuangan, IT Development, Desain dibuat lewat Organisasi > Departemen",
      Boolean(deptId[DEPT.fin] && deptId[DEPT.itdev] && deptId[DEPT.design]), Object.keys(deptId).join(", "));

    // Bagian Active Directory di tab Departemen.
    let mappedByUi = false;
    try {
      const sec = byTid("A", TID.adSettings);
      await sec.waitFor({ timeout: 15000 });
      await sec.scrollIntoViewIfNeeded();
      const dom = await soft(sec.getByLabel(TXT.id.adDomainLabel, { exact: true }).inputValue({ timeout: 5000 }), "");
      check("1.7 Bagian Active Directory menampilkan domain kantor", dom === DOMAIN, dom);
      await sec.getByRole("button", { name: TXT.id.adAddRow, exact: true }).click();
      // Lewat nama aksesibel (getByRole): label sel memuat nama kolom aria-hidden
      // yang ikut terbaca getByLabel, tapi tidak ikut nama aksesibel.
      await sec.getByRole("textbox", { name: TXT.id.adOuRow(1) }).fill(OU_MAP.ou);
      await sec.getByRole("combobox", { name: TXT.id.adTeamRow(1) }).selectOption({ label: OU_MAP.team });
      await snap("A", "pengaturan-ad-pemetaan-ou");
      await sec.getByRole("button", { name: TXT.id.adSave }).click();
      mappedByUi = await soft(waitFor("pemetaan OU tersimpan", async () => {
        const s = await must("A", "org_ad_settings");
        return s.ouMap?.some((m) => m.ou === OU_MAP.ou && m.team === deptId[OU_MAP.team]);
      }, 15000, 500), false);
    } catch (e) {
      console.log(`Catatan: pemetaan OU lewat layar gagal: ${e.message}`);
      await snap("A", "pengaturan-ad-gagal");
    }
    check(`1.8 Pemetaan OU ${OU_MAP.ou} ke ${OU_MAP.team} disimpan lewat bagian Active Directory`, mappedByUi);
    if (!mappedByUi) await must("A", "org_set_ad_settings", { domain: DOMAIN, ouMap: [{ ou: OU_MAP.ou, team: deptId[OU_MAP.team] }] });

    // Jalankan ulang dengan mDNS supaya laptop baru menemukan kantor A.
    await stop("A");
    await launch("A");
    check("1.9 A terbuka lagi di kerangka utama dengan mDNS", await waitShell("A"));
  }, { fatal: true });

  // 2. N1: akun domain lengkap. K (tanpa domain) ikut di jaringan.
  await scenario("2. N1 akun domain cocok, dua kantor di jaringan", ["N1", "K"], async () => {
    writeAd("K", fakeAd(NO_DOMAIN));
    await launch("K");
    await must("K", "save_display_name", { name: "Kiki Uji" });
    await must("K", "create_organization", { name: ORG_K, adDomain: null });
    const dk = await must("K", "org_create_department", { name: DEPT.warehouse });
    await must("K", "org_move_member", { publicKey: (await must("K", "get_app_state")).identity.publicKey, teamId: dk.id });
    await rememberKey("K");
    check("2.0 K membuat kantor kedua tanpa domain AD", (await must("K", "get_app_state")).organization?.name === ORG_K);
    await sleep(3000); // K mulai mengiklankan j=1 lewat mDNS.

    // Bagian 6 butir 3: peringatan kantor lain di halaman Organisasi A.
    await openOrgTab("A", "requests");
    let warned = await waitText("A", TXT.id.otherOffices, 45000);
    if (!warned) {
      await openOrgTab("A", "departments");
      warned = await waitText("A", TXT.id.otherOffices, 20000);
    }
    const other = await call("A", "org_other_offices");
    check("2.0b Organisasi A: \"Ada N laptop di jaringan ini yang tergabung di kantor Mira lain\"", warned,
      other.ok ? JSON.stringify(other.value).slice(0, 160) : `org_other_offices: ${JSON.stringify(other.error)}`);
    await snap("A", "organisasi-kantor-lain");

    writeAd("N1", fakeAd({ local: local(P.rina) }));
    await launch("N1");
    const n = await nameStep("N1", { expect: P.rina.displayName });
    check("2.1 N1: nama terisi otomatis \"Rina Wijaya\" dari AD", n.prefilled, n.value);
    check("2.2 N1: di bawah nama tertulis sumbernya (akun Windows, domain)", has(n.source, TXT.id.nameSource(DOMAIN)), n.source);
    await snap("N1", "onboarding-nama-dari-ad");
    // Bagian 6.1 butir 1: A satu-satunya kantor domain macf.co.id (K tanpa domain),
    // jadi dipakai langsung tanpa langkah memilih kantor.
    const h = await toOffices("N1");
    const radios = pg("N1").locator('input[type="radio"][name="office"]');
    const summary = await tidText("N1", TID.officeSummary);
    check(`2.3 N1 (A dan K terlihat): kantor A dipakai langsung, judul "${TXT.id.headingMine}"`, h === TXT.id.headingMine, h);
    const fpShown = (await soft(pg("N1").locator(".onb-fp-code").first().innerText({ timeout: 3000 }), "")).trim();
    check("2.3b N1: sidik organisasi A tetap tampil", fpShown !== "" && fpShown === (await must("A", "org_fingerprint")), fpShown);
    check("2.4 N1: tanpa langkah pilih kantor, ringkasan \"Kantor: Kantor Uji AD (macf.co.id)\"",
      (await radios.count()) === 0 && has(summary, TXT.id.officeSummary(ORG, DOMAIN)), summary);
    const changeBtn = pg("N1").getByRole("button", { name: TXT.id.changeOffice, exact: true });
    check("2.5 N1: ringkasan kantor punya tombol Ubah", await changeBtn.isVisible());
    const autoDept = await soft(waitFor("departemen terpilih", async () => (await selectedTeam("N1")) || null, 10000, 300), "");
    check("2.6 N1: departemen Keuangan terpilih otomatis", autoDept === DEPT.fin, autoDept);
    check("2.7 N1: asal usulan departemen tertulis (Dari akun Windows Anda: Keuangan)", has(await tidText("N1", TID.deptCaption), TXT.id.deptFromAccount(DEPT.fin)));
    const box = await tidText("N1", TID.box);
    check("2.8 N1: kotak \"Yang dikirim ke admin\" memuat akun AD dan lokasi OU",
      has(box, TXT.id.boxTitle) && box.includes(adAccount(P.rina)) && box.includes(ouPath(P.rina)) && box.includes(P.rina.displayName), box.replace(/\n/g, " | ").slice(0, 200));

    // Screenshot langkah kantor: Indonesia/Inggris, terang/gelap.
    let enOk = true;
    for (const [lg, th] of [["id", "light"], ["id", "dark"], ["en", "dark"], ["en", "light"]]) {
      await setOnbLang("N1", lg);
      await setTheme("N1", th);
      if (lg === "en") {
        const t = await bodyText("N1");
        enOk = enOk && has(t, TXT.en.officeSummary(ORG, DOMAIN)) && has(t, TXT.en.boxTitle);
      }
      await byTid("N1", TID.box).scrollIntoViewIfNeeded().catch(() => {});
      await snap("N1", `onboarding-kantor-ad-${lg}-${th === "light" ? "terang" : "gelap"}`);
    }
    check("2.9 N1: teks AD di langkah kantor ikut bahasa Inggris", enOk);
    await setOnbLang("N1", "id");
    await setTheme("N1", "light");
    check("2.10 N1: pilihan departemen tetap setelah ganti bahasa", (await selectedTeam("N1")) === DEPT.fin);

    // Ubah kantor: daftar pilihan, kantor domain sama paling atas dengan penandanya.
    await changeBtn.click();
    await radios.first().waitFor({ timeout: 5000 }).catch(() => {});
    const first = await soft(radios.first().evaluate((el) => ({ checked: el.checked, text: el.closest("label")?.innerText ?? "" })), {});
    check("2.10b Ubah kantor: A paling atas dengan \"Domain kantor Anda: macf.co.id\", K juga ada",
      (await radios.count()) >= 2 && has(first.text ?? "", ORG) && has(first.text ?? "", TXT.id.officeMatch(DOMAIN)) &&
        (await tidCount("N1", TID.officeMatch)) === 1, JSON.stringify(first).slice(0, 160));
    await snap("N1", "onboarding-ubah-kantor");
    if (!first.checked) await radios.first().check();
    const again = await soft(waitFor("departemen terpilih lagi", async () => (await selectedTeam("N1")) === DEPT.fin || null, 10000, 300), false);
    check("2.10c Setelah A dipilih lagi, Keuangan tetap terpilih", again === true, await selectedTeam("N1"));

    const code = await sendRequest("N1");
    const req = await requestOnA(P.rina.displayName);
    check("2.11 A menerima permintaan N1 dengan kode yang sama", req.code === code, `${req.code} / ${code}`);
    check("2.12 Permintaan N1 membawa klaim AD (domain, akun, nama, departemen, OU)",
      req.ad?.domain === DOMAIN && req.ad?.user === P.rina.user && req.ad?.name === P.rina.displayName &&
        req.ad?.department === DEPT.fin && (req.ad?.ous ?? [])[0] === "Finance", JSON.stringify(req.ad).slice(0, 200));
    check("2.13 Permintaan N1 ke Keuangan, usulan AD sama", req.teamId === deptId[DEPT.fin] && req.ad?.suggestedTeamId === deptId[DEPT.fin]);
    check("2.14 Mira N1 tidak dianggap terlalu lama", req.requesterOutdated === false);
    const chk = await must("A", "org_join_ad_check", { requestId: req.id, refresh: false });
    check("2.15 org_join_ad_check di A: match", chk.status === "match" && chk.mismatches.length === 0, JSON.stringify(chk).slice(0, 160));

    await openOrgTab("A", "requests");
    const c = card(P.rina.displayName);
    await c.waitFor({ timeout: 30000 });
    const adBlock = await soft(c.getByTestId(TID.cardAd).innerText({ timeout: 10000 }), "");
    check("2.16 Kartu A menampilkan blok Active Directory dengan akun dan departemen",
      has(adBlock, TXT.id.cardTitle) && adBlock.includes(adAccount(P.rina)) && adBlock.includes(ouPath(P.rina)) && adBlock.includes(DEPT.fin), adBlock.replace(/\n/g, " | ").slice(0, 200));
    const matched = await waitCardStatus(P.rina.displayName, "match");
    check("2.17 Kartu A: status \"Akun ada dan aktif di AD, nama dan departemen sama\"", matched && has(await tidText("A", TID.cardStatus), TXT.id.status.match));
    check("2.18 Kartu A: status cocok berbahasa Inggris", await adminCardShots(P.rina.displayName, "match", "cocok"));
    check("2.19 A menyetujui N1 lewat kartu", await approveByCard(P.rina.displayName));
    check("2.20 N1 masuk Mira setelah disetujui", (await waitShell("N1")) && (await must("N1", "get_app_state")).organization?.name === ORG);
  });
  await sleep(3000); // iklan mDNS K berhenti.

  // 3. N2: departemen lewat pemetaan OU.
  await scenario("3. N2 departemen dari pemetaan OU", ["N2"], async () => {
    writeAd("N2", fakeAd({ local: local(P.hartono) }));
    await launch("N2");
    const n = await nameStep("N2", { expect: P.hartono.displayName });
    check("3.1 N2: nama terisi otomatis \"Hartono\"", n.prefilled, n.value);
    const h = await toOffices("N2");
    check(`3.2 N2: satu kantor domain sama, judul "${TXT.id.headingMine}"`, h === TXT.id.headingMine, h);
    check("3.3 N2: ringkasan \"Kantor: Kantor Uji AD (macf.co.id)\" tampil",
      has(await tidText("N2", TID.officeSummary), TXT.id.officeSummary(ORG, DOMAIN)));
    const autoDept = await soft(waitFor("departemen terpilih", async () => (await selectedTeam("N2")) || null, 10000, 300), "");
    check("3.4 N2: IT Development terpilih lewat pemetaan OU (atribut department kosong)", autoDept === DEPT.itdev, autoDept);
    const cap = await tidText("N2", TID.deptCaption);
    // Keterangan menyebut label AD (OU paling dalam), bukan nama departemen Mira.
    const innerOu = "IT-Development";
    check(`3.5 N2: asal usulan departemen tertulis (Dari akun Windows Anda: ${innerOu})`, has(cap, TXT.id.deptFromAccount(innerOu)), cap);
    const code = await sendRequest("N2");
    const req = await requestOnA(P.hartono.displayName);
    check("3.6 A menerima permintaan N2 ke IT Development dengan kode yang sama",
      req.code === code && req.teamId === deptId[DEPT.itdev] && req.ad?.suggestedTeamId === deptId[DEPT.itdev]);
    check("3.7 Klaim AD N2: OU paling dalam dulu, tanpa atribut department",
      (req.ad?.ous ?? []).slice(0, 2).join(",") === "IT-Development,IT-Department" && !req.ad?.department, JSON.stringify(req.ad?.ous));
    await openOrgTab("A", "requests");
    const c = card(P.hartono.displayName);
    await c.waitFor({ timeout: 30000 });
    const loc = await soft(c.getByTestId(TID.cardAd).innerText(), "");
    check("3.8 Kartu A: lokasi OU dari luar ke dalam", has(loc, ouPath(P.hartono)), ouPath(P.hartono));
    check("3.9 Kartu A: akun ada dan aktif, nama dan departemen sama", await waitCardStatus(P.hartono.displayName, "match"));
    check("3.10 A menyetujui N2 lewat kartu", await approveByCard(P.hartono.displayName));
    check("3.11 N2 masuk Mira", await waitShell("N2"));
  });

  // 4. N3: departemen AD belum ada di Mira, nama diubah sendiri.
  await scenario("4. N3 departemen AD belum ada di Mira", ["N3"], async () => {
    writeAd("N3", fakeAd({ local: local(P.gita) }));
    await launch("N3");
    const n = await nameStep("N3", { expect: P.gita.displayName, type: N3_TYPED_NAME });
    check("4.1 N3: nama terisi otomatis, lalu diubah sendiri", n.prefilled, `${n.value} -> ${N3_TYPED_NAME}`);
    await toOffices("N3");
    await sleep(3000); // beri waktu usulan departemen
    check("4.2 N3: departemen tidak terpilih otomatis", (await selectedTeam("N3")) === "");
    const cap = await tidText("N3", TID.deptCaption);
    check("4.3 N3: tertulis \"Departemen Anda di akun Windows (Gudang) belum ada di Mira\"", has(cap, TXT.id.deptMissing(DEPT.warehouse)), cap);
    await snap("N3", "onboarding-departemen-belum-ada");
    await teamSelect("N3").selectOption({ label: DEPT.design });
    const code = await sendRequest("N3");
    check("4.4 N3 memilih Desain secara manual lalu mengirim", Boolean(code));
    const req = await requestOnA(N3_TYPED_NAME);
    const chk = await must("A", "org_join_ad_check", { requestId: req.id, refresh: false });
    check("4.5 org_join_ad_check: mismatch nama, Gudang belum ada di Mira",
      chk.status === "mismatch" && chk.departmentInMira === false && chk.directoryDepartment === DEPT.warehouse &&
        chk.mismatches.some((m) => m.field === "name") && !chk.mismatches.some((m) => m.field === "department"), JSON.stringify(chk).slice(0, 200));
    await openOrgTab("A", "requests");
    const c = card(N3_TYPED_NAME);
    await c.waitFor({ timeout: 30000 });
    const adText = await soft(c.getByTestId(TID.cardAd).innerText(), "");
    check("4.6 Kartu A: \"Departemen di AD: Gudang (belum ada di Mira)\"",
      /Departemen di AD\s*Gudang \(belum ada di Mira\)/.test(adText), adText.replace(/\n/g, " | ").slice(0, 200));
    check("4.7 Kartu A: \"Berbeda dengan AD\" dengan nama di AD dan di permintaan",
      (await waitCardStatus(N3_TYPED_NAME, "mismatch")) && (await waitText("A", TXT.id.mismatchName(P.gita.displayName, N3_TYPED_NAME), 5000, c)));
    check("4.8 Kartu A: status berbahasa Inggris \"Differs from AD\"", await adminCardShots(N3_TYPED_NAME, "mismatch", "tidak-cocok"));
    check("4.9 A tetap bisa menyetujui N3 (persetujuan manual)", await approveByCard(N3_TYPED_NAME));
    check("4.10 N3 masuk Mira", await waitShell("N3"));
  });

  // 5. N4: akun dinonaktifkan, lalu AD tidak terjangkau. Ditolak.
  await scenario("5. N4 akun AD dinonaktifkan", ["N4"], async () => {
    writeAd("N4", fakeAd({ local: local(P.dodi) }));
    await launch("N4");
    await nameStep("N4", { expect: P.dodi.displayName });
    await toOffices("N4");
    const autoDept = await soft(waitFor("departemen terpilih", async () => (await selectedTeam("N4")) || null, 10000, 300), "");
    check("5.1 N4: Desain terpilih otomatis", autoDept === DEPT.design, autoDept);
    await sendRequest("N4");
    const req = await requestOnA(P.dodi.displayName);
    await openOrgTab("A", "requests");
    const c = card(P.dodi.displayName);
    await c.waitFor({ timeout: 30000 });
    check("5.2 Kartu A: \"Akun AD dinonaktifkan\"",
      (await waitCardStatus(P.dodi.displayName, "disabled")) && has(await soft(c.getByTestId(TID.cardStatus).innerText(), ""), TXT.id.status.disabled));
    check("5.3 Kartu A: status berbahasa Inggris \"AD account is disabled\"", await adminCardShots(P.dodi.displayName, "disabled", "dinonaktifkan"));

    writeAd("A", fakeAd({ users: directory(), reachable: false }));
    await c.getByRole("button", { name: TXT.id.recheckAria(P.dodi.displayName) }).click();
    check("5.4 Periksa lagi setelah AD putus: \"AD tidak bisa dihubungi dari laptop ini\"",
      (await waitCardStatus(P.dodi.displayName, "unreachable")) && has(await soft(c.getByTestId(TID.cardStatus).innerText(), ""), TXT.id.status.unreachable));
    check("5.4b Hasil Periksa lagi diumumkan di wilayah aria-live",
      await waitText("A", TXT.id.status.unreachable, 5000, c.getByTestId(TID.cardLive)));
    await snap("A", "kartu-ad-tidak-terjangkau-id-terang");
    const chk = await must("A", "org_join_ad_check", { requestId: req.id, refresh: true });
    check("5.5 org_join_ad_check refresh: unreachable", chk.status === "unreachable", chk.status);
    writeAd("A", fakeAd({ users: directory() }));

    await c.getByRole("button", { name: TXT.id.rejectAria(P.dodi.displayName) }).click({ timeout: 10000 });
    await pg("A").getByRole("dialog").getByRole("button", { name: TXT.id.rejectConfirm(P.dodi.displayName), exact: true }).click();
    check("5.6 A menolak N4 lewat kartu, layar N4 \"Permintaan ditolak\"", Boolean(await soft(waitHeading("N4", /^Permintaan ditolak$/, 40000))));
  });

  // 6. N5: PC tanpa domain, alur manual.
  await scenario("6. N5 tanpa domain (alur manual)", ["N5"], async () => {
    writeAd("N5", fakeAd(NO_DOMAIN));
    await launch("N5");
    const n = await nameStep("N5", { expect: null, type: N5_NAME, waitMs: 5000 });
    check("6.1 N5: nama tidak terisi, tanpa sumber AD", !n.prefilled && (await tidCount("N5", TID.nameSource)) === 0, n.value);
    const h = await toOffices("N5");
    check(`6.2 N5: kantor ${ORG} ditemukan`, h === `Kantor ditemukan: ${ORG}`, h);
    await sleep(2000);
    const counts = await Promise.all([TID.officeMatch, TID.officeSummary, TID.deptCaption, TID.box, TID.partial, TID.skipped].map((t) => tidCount("N5", t)));
    // Nama kantor uji ("Kantor Uji AD") memuat kata AD, jadi dibuang sebelum dicek.
    const body = [ORG_K2, ORG].reduce((t, o) => t.replaceAll(o, ""), await bodyText("N5"));
    check("6.3 N5: tidak ada teks AD di langkah kantor", counts.every((x) => x === 0) && !AD_WORDS.test(body), `${counts} ${body.match(AD_WORDS)?.[0] ?? ""}`);
    check("6.4 N5: departemen tidak terpilih otomatis", (await selectedTeam("N5")) === "");
    await snap("N5", "onboarding-tanpa-domain");
    await teamSelect("N5").selectOption({ label: DEPT.fin });
    await sendRequest("N5");
    const req = await requestOnA(N5_NAME);
    check("6.5 Permintaan N5 tanpa klaim AD", req.ad === null);
    await openOrgTab("A", "requests");
    const c = card(N5_NAME);
    await c.waitFor({ timeout: 30000 });
    const cardText = await c.innerText();
    check("6.6 Kartu A tanpa blok AD", (await c.getByTestId(TID.cardAd).count()) === 0 && !/Active Directory|\bAD\b/.test(cardText));
    await snap("A", "kartu-tanpa-ad");
    check("6.7 A menyetujui N5 lewat kartu", await approveByCard(N5_NAME));
    check("6.8 N5 masuk Mira", await waitShell("N5"));
  });

  // 7a. N6: data AD sebagian.
  await scenario("7a. N6 data AD sebagian", ["N6"], async () => {
    writeAd("N6", fakeAd({ local: local(P.eko), localPartial: true }));
    await launch("N6");
    const n = await nameStep("N6", { expect: null, type: P.eko.displayName, waitMs: 5000 });
    check("7.1 N6: nama tidak terisi (displayName tidak terbaca)", !n.prefilled, n.value);
    await toOffices("N6");
    await sleep(2000);
    const box = await tidText("N6", TID.box);
    check("7.2 N6: kotak AD tetap memuat akun yang sempat terbaca", box.includes(adAccount(P.eko)), box.replace(/\n/g, " | ").slice(0, 160));
    check("7.3 N6: pesan \"Sebagian data akun Windows tidak terbaca\"", has(await tidText("N6", TID.partial), TXT.id.partial));
    check("7.4 N6: departemen tidak terpilih otomatis", (await selectedTeam("N6")) === "");
    await snap("N6", "onboarding-ad-sebagian");
    await teamSelect("N6").selectOption({ label: DEPT.fin });
    await sendRequest("N6");
    const req = await requestOnA(P.eko.displayName);
    check("7.5 Klaim AD N6: akun tanpa DN", req.ad?.user === P.eko.user && req.ad?.dn === null, JSON.stringify(req.ad).slice(0, 160));
    await must("A", "org_reject_join", { requestId: req.id });
  });

  // 7b. N7: pembacaan AD lebih lama dari batas 4 detik.
  await scenario("7b. N7 pembacaan AD lambat", ["N7"], async () => {
    writeAd("N7", fakeAd({ local: local(P.fajar), localDelayMs: 8000 }));
    await launch("N7");
    const page = pg("N7");
    await waitNameStep(page);
    const input = page.locator('input[name="displayName"]');
    const t0 = Date.now();
    const ping = await page.evaluate(() => 1).then(() => Date.now() - t0);
    check("7.6 N7: layar nama tampil dan responsif saat AD masih dibaca", (await input.isEnabled()) && ping < 1000, `${ping} ms`);
    await sleep(10000); // melewati batas 4 detik dan jeda tiruan 8 detik
    check("7.7 N7: nama tidak terisi setelah waktu habis", (await input.inputValue()) === "" && (await tidCount("N7", TID.nameSource)) === 0);
    await input.fill(P.fajar.displayName);
    const h = await toOffices("N7");
    check("7.8 N7: alur manual tetap jalan sampai pilihan kantor", RESULT_RE.test(h) && h !== "Kantor belum ditemukan", h);
    await teamSelect("N7").selectOption({ label: DEPT.fin });
    check("7.9 N7: departemen bisa dipilih manual, Kirim permintaan aktif",
      (await selectedTeam("N7")) === DEPT.fin && (await page.getByRole("button", { name: "Kirim permintaan" }).isEnabled()));
  });

  // 8a. Bagian 6 butir 2: domain sama dengan kantor A, tanpa pilihan kantor baru.
  await scenario("8a. N8 domain sama: tanpa kantor baru", ["N8"], async () => {
    writeAd("N8", fakeAd({ local: local(P.sari) }));
    await launch("N8");
    await nameStep("N8", { expect: P.sari.displayName });
    await toOffices("N8");
    await pg("N8").getByRole("button", { name: TXT.id.otherWay }).click();
    await openAdminIT(pg("N8"));
    await sleep(800);
    const body = await bodyText("N8");
    const btn = await pg("N8").getByRole("button", { name: TXT.id.newOfficeButton, exact: true }).count();
    const confirm = await pg("N8").getByRole("button", { name: TXT.id.confirmButton }).count();
    check("8.1 N8 (domain macf.co.id): Untuk admin IT tanpa pilihan kantor baru", btn === 0 && confirm === 0, `tombol ${btn}/${confirm}`);
    check("8.2 N8: diarahkan ke kantor A (satu domain, satu kantor)",
      (await tidCount("N8", TID.sameDomainGuard)) === 1 && has(body, TXT.id.sameDomain(DOMAIN)) && body.includes(ORG));
    await snap("N8", "untuk-admin-it-domain-sama");
  });

  // 8b. Bagian 6 butir 2: tanpa domain, kantor A terlihat: peringatan dan konfirmasi.
  await scenario("8b. N9 tanpa domain: peringatan kantor kedua", ["N9"], async () => {
    writeAd("N9", fakeAd(NO_DOMAIN));
    await launch("N9");
    await nameStep("N9", { expect: null, type: N9_NAME, waitMs: 2000 });
    await toOffices("N9");
    await pg("N9").getByRole("button", { name: TXT.id.otherWay }).click();
    await openAdminIT(pg("N9"));
    await sleep(800);
    const body = await bodyText("N9");
    check("8.3 N9: peringatan \"Sudah ada kantor Mira di jaringan ini\" menyebut kantor A",
      (await tidCount("N9", TID.secondOffice)) === 1 && has(body, TXT.id.seenTitle) && body.includes(ORG));
    const confirmInput = pg("N9").getByLabel(TXT.id.confirmLabel);
    check("8.4 N9: konfirmasi ketik ulang tampil, layar kantor baru belum terbuka",
      (await confirmInput.isVisible()) && !(await pg("N9").getByRole("heading", { name: TXT.id.newOfficeButton }).isVisible()));
    await snap("N9", "untuk-admin-it-peringatan-kantor-kedua");
    await confirmInput.fill(TXT.id.confirmPhrase);
    await pg("N9").getByRole("button", { name: TXT.id.confirmButton }).click();
    const opened = await soft(pg("N9").getByRole("heading", { name: TXT.id.newOfficeButton }).waitFor({ timeout: 10000 }).then(() => true), false);
    check("8.5 N9: setelah mengetik \"kantor baru\", layar kantor baru terbuka (tidak dibuat)", opened);
  });

  // 8c. Bagian 6.1 butir 3: dua kantor untuk domain yang sama. K2 dibuat setelah A.
  await scenario("8c. Dua kantor domain sama: kantor utama", ["N11", "K2"], async () => {
    // create_organization menolak kantor baru kalau laptop itu sudah mengenal kantor
    // terverifikasi dengan domain AD sama (domain mesin atau yang diketik). Jadi K2
    // dibuat tanpa mDNS (tidak pernah melihat A), seperti dua admin IT yang menyiapkan
    // kantor bersamaan, lalu dijalankan ulang dengan mDNS.
    writeAd("K2", fakeAd({}));
    await launch("K2", { env: { MIRA_DISABLE_MDNS: "1" } });
    await must("K2", "save_display_name", { name: "Kurnia Uji" });
    await must("K2", "create_organization", { name: ORG_K2, adDomain: DOMAIN });
    await must("K2", "org_create_department", { name: DEPT.fin });
    await rememberKey("K2");
    check("8.6 K2 membuat kantor kedua dengan domain AD macf.co.id", (await must("K2", "org_ad_settings")).domain === DOMAIN);
    await stop("K2");
    await launch("K2");
    check("8.6b K2 terbuka lagi di kerangka utama dengan mDNS", await waitShell("K2"));
    await sleep(3000); // K2 mulai mengiklankan j dan ad lewat mDNS.

    writeAd("N11", fakeAd({ local: local(P.wulan) }));
    await launch("N11");
    await nameStep("N11", { expect: P.wulan.displayName });
    const h = await toOffices("N11");
    check("8.7 N11 melihat dua kantor domain macf.co.id", h === "Beberapa kantor ditemukan", h);
    const primary = await soft(pg("N11").locator("label.onb-office").filter({ has: byTid("N11", TID.officePrimary) })
      .evaluate((el) => ({ text: el.innerText, checked: el.querySelector('input[type="radio"]')?.checked ?? false })), {});
    check("8.8 N11: A (dibuat lebih dulu) ditandai \"Kantor utama untuk macf.co.id\" dan terpilih",
      has(primary.text ?? "", ORG) && !has(primary.text ?? "", ORG_K2) && has(primary.text ?? "", TXT.id.primary(DOMAIN)) && primary.checked === true,
      JSON.stringify(primary).slice(0, 160));
    const later = await soft(pg("N11").locator("label.onb-office").filter({ has: byTid("N11", TID.officeLater) }).innerText(), "");
    check("8.9 N11: K2 ditandai dibuat setelah kantor utama", has(later, ORG_K2), later.replace(/\n/g, " | ").slice(0, 120));
    await snap("N11", "onboarding-kantor-utama");

    // Superadmin K2 (kantor yang lebih baru) mendapat peringatan di Organisasi.
    await mainNavBtn("K2", "org").click({ timeout: 10000 });
    let older = await soft(byTid("K2", TID.olderOffice).waitFor({ timeout: 60000 }).then(() => true), false);
    if (!older) {
      await mainNavBtn("K2", "settings").click().catch(() => {});
      await mainNavBtn("K2", "org").click().catch(() => {});
      older = await soft(byTid("K2", TID.olderOffice).waitFor({ timeout: 20000 }).then(() => true), false);
    }
    const olderText = await tidText("K2", TID.olderOffice);
    check("8.10 Organisasi K2: peringatan kantor domain sama yang lebih lama, menyebut kantor A",
      older && has(olderText, TXT.id.olderTitle) && olderText.includes(ORG), olderText.replace(/\n/g, " | ").slice(0, 200));
    await snap("K2", "organisasi-kantor-lebih-lama");

    // A (kantor utama) tidak mendapat peringatan itu, tapi melihat kantor lain dengan domain sama.
    // Pemberitahuan dimuat sekali saat halaman Organisasi dibuka, dan A sudah di
    // halaman itu sejak sebelum K2 ada: buka ulang lewat Pengaturan sampai muncul.
    const sameDomainBox = byTid("A", TID.otherOffices).and(pg("A").locator('[data-same-domain="true"]'));
    const sameDomain = await soft(waitFor("A melihat kantor lain dengan domain sama", async () => {
      await mainNavBtn("A", "settings").click({ timeout: 10000 });
      await openOrgTab("A", "requests");
      return soft(sameDomainBox.waitFor({ timeout: 8000 }).then(() => true), false);
    }, 90000, 500), false);
    check("8.11 Organisasi A: pemberitahuan kantor lain dengan domain AD sama, tanpa peringatan kantor lebih lama",
      sameDomain && has(await tidText("A", TID.otherOffices), TXT.id.otherSameDomain) && (await tidCount("A", TID.olderOffice)) === 0);
    await snap("A", "organisasi-kantor-ganda-domain-sama");
  });

  // 9. Bagian 6 butir 1: kantor versi lama. A dihentikan supaya hanya L yang terlihat.
  await scenario("9. N10 melihat kantor Mira versi lama", ["L", "N10"], async () => {
    await stop("A");
    await sleep(3000);
    writeAd("L", fakeAd(NO_DOMAIN));
    await launch("L", { env: LEGACY_ENV });
    await must("L", "save_display_name", { name: "Lukas Uji" });
    await must("L", "create_organization", { name: ORG_L, adDomain: null });
    await must("L", "org_create_department", { name: DEPT.fin });
    await rememberKey("L");
    await sleep(3000);
    writeAd("N10", fakeAd(NO_DOMAIN));
    await launch("N10");
    await nameStep("N10", { expect: null, type: N10_NAME, waitMs: 2000 });
    const h = await toOffices("N10");
    const body = await bodyText("N10");
    check("9.1 N10: bukan \"Kantor belum ditemukan\" saat hanya kantor lama terlihat", h !== "" && h !== "Kantor belum ditemukan", h);
    check("9.2 N10: judul kantor lama yang belum bisa menerima permintaan", h === TXT.id.legacyHeading, h);
    check("9.3 N10: langkah pembaruan Mira dan kode undangan tampil",
      has(body, TXT.id.legacyTitle) && has(body, TXT.id.legacyUpdate) &&
        (await pg("N10").getByRole("button", { name: TXT.id.inviteButton }).count()) > 0);
    check("9.4 N10: kantor lama tanpa nama tampil sebagai \"Kantor tanpa nama (N laptop)\"",
      has(await tidText("N10", TID.legacy), TXT.id.legacyUnnamed));
    await snap("N10", "onboarding-kantor-versi-lama");
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
