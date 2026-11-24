// Uji ujung ke ujung nonaktifkan, aktifkan lagi, keluarkan permanen, dan reset
// laptop (docs/plans/perbaikan-bergabung.md, 0.5.1) di satu PC Windows.
//
// Setiap instance mira.exe (build debug) punya folder data (MIRA_DATA_DIR),
// port QUIC (MIRA_PORT), port debug WebView2, dan file AD tiruan sendiri
// (MIRA_FAKE_AD, tanpa domain, supaya PC domain tidak mengubah alur).
//
//   A  Ayu   membuat kantor dan departemen, superadmin.
//   B  Budi  minta bergabung lewat layar onboarding, disetujui A. Lalu:
//            1. A menonaktifkan B (Organisasi > Pengguna). Layar B berganti ke
//               layar nonaktif tanpa restart; "Periksa lagi" menampilkan hasil.
//            2. Selama nonaktif A mengirim pesan di #umum dan membuat kartu
//               board di proyek B. B tidak menerimanya.
//            3. A mengaktifkan B lagi. B kembali ke Mira tanpa restart, lalu
//               menerima pesan dan kartu itu.
//            4. A mengeluarkan B permanen. B melihat layar dikeluarkan, memilih
//               "Reset dan mulai dari awal", kembali ke onboarding dengan kunci
//               baru, minta bergabung lagi, dan disetujui A.
//
// Pakai:  node scripts/suspend-e2e.mjs <path mira.exe debug> <folder screenshot> [folder induk data uji]
// Port:   MIRA_PORT 47961-47962, CDP 9461-9462, keduanya digeser E2E_PORT_OFFSET.
// Butuh:  playwright-core (alat uji saja, tidak dibundel ke aplikasi).
// Jalankan sendirian, tanpa e2e lain (mDNS dan Credential Manager dipakai bersama).

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { chromium } from "playwright-core";
import { menuName, passFirewall, passName, waitNameStep } from "./e2e-onboarding.mjs";

const exe = resolve(process.argv[2] ?? "src-tauri/target/debug/mira.exe");
const shots = resolve(process.argv[3] ?? "docs/progress/screenshots/perbaikan-bergabung");
mkdirSync(shots, { recursive: true });
const root = mkdtempSync(join(resolve(process.argv[4] ?? tmpdir()), "mira-suspend-e2e-"));
const PORT_OFFSET = Number(process.env.E2E_PORT_OFFSET ?? 0) || 0;

// Jangan pernah menyentuh Mira yang terpasang (%LOCALAPPDATA%\Mira).
const installed = process.env.LOCALAPPDATA ? resolve(process.env.LOCALAPPDATA, "Mira") : null;
if (installed && (root + sep).toLowerCase().startsWith((installed + sep).toLowerCase())) {
  console.log(`Folder data uji ${root} ada di dalam ${installed}. Berhenti.`);
  process.exit(2);
}

// ----- Data uji ------------------------------------------------------------------
const ORG = "Kantor Uji Nonaktif";
const DEPT = "Keuangan";
const PROJECT = { name: "Proyek Uji Nonaktif", code: "PN" };
const NAME = { A: "Ayu Uji", B: "Budi Uji" };
// Penanda unik supaya bisa dicari di data B (command dan isi berkas database).
const RUN = Date.now().toString(36);
const MSG_BEFORE = `Pesan uji sebelum nonaktif ${RUN}`;
const MSG_SUSPENDED = `Pesan uji selama nonaktif ${RUN}`;
const TASK_SUSPENDED = `Kartu uji selama nonaktif ${RUN}`;

// ----- Teks dan pencari elemen ----------------------------------------------------
// TODO(label): layar 0.5.1 sedang ditulis agen lain (F1 layar status, F2 Pengguna).
// Sesuaikan di sini setelah kamus src/i18n/status.*, org-users.* final. Semua
// pencarian di bawah membaca konstanta ini saja.
const LBL = {
  id: {
    mainMenu: "Menu utama",
    nav: { org: "Organisasi", chat: "Chat" },
    tabUsers: /^Pengguna/,
    // F1 SuspendedScreen. TODO(label)
    suspendedHeading: /sedang dinonaktifkan/,
    suspendedContact: /Hubungi IT atau superadmin kantor/,
    recheck: "Periksa lagi",
    recheckResult: /Dicek \d{1,2}[.:]\d{2}: masih nonaktif/, // draf F1: "Dicek 14.20: masih nonaktif."
    // F1 RemovedScreen dan dialog reset. TODO(label)
    removedHeading: /sudah dikeluarkan/,
    resetButton: "Reset dan mulai dari awal",
    resetConfirm: /^(Hapus data dan reset|Reset|Hapus|Ya)/, // tombol konfirmasi di dalam dialog
    // F2 Organisasi > Pengguna. TODO(label)
    actionsFor: (name) => `Aksi untuk ${name}`,
    statusFilter: "Status", // <label> saringan status
    // Nilai <option> saringan status (draf F2: current, online, offline, suspended, removed).
    // Bawaan "current" (Aktif dan nonaktif) sudah memuat orang nonaktif.
    statusFilterValues: ["current", "suspended", "removed"], // dicoba berurutan kalau baris tidak terlihat
    rowSuspended: /Nonaktif/,
    rowRemoved: /Dikeluarkan/,
    // Menu aksi: item khusus dicoba dulu, lalu item gabungan "Nonaktifkan atau
    // keluarkan" yang membuka dialog dengan pilihan Nonaktifkan / Keluarkan permanen.
    menu: {
      suspend: [/^Nonaktifkan/, /^Keluarkan/],
      reinstate: [/^Aktifkan lagi/],
      remove: [/^Keluarkan permanen/, /^Nonaktifkan atau keluarkan/, /^Keluarkan/],
    },
    choice: { suspend: /^Nonaktifkan/, reinstate: null, remove: /^Keluarkan permanen/ },
    // Draf F2: "Nonaktifkan <nama>", "Aktifkan <nama>", "Keluarkan <nama> permanen".
    confirm: { suspend: /^Nonaktifkan/, reinstate: /^Aktifkan/, remove: /^Keluarkan/ },
    typeToConfirm: /^Ketik/, // isian ketik ulang nama, kalau dialog memintanya
    cancel: "Batal",
    // Kartu Permintaan bergabung (F4). TODO(label)
    approveAria: (n) => `Setujui permintaan ${n}`,
    previouslyRemoved: /pernah dipakai .+ yang dikeluarkan pada/, // draf F4 org-requests previous.laptopRemoved
    // Onboarding (sudah ada sejak v0.4).
    resultHeading: /^(Kantor Anda ditemukan|Kantor ditemukan|Beberapa kantor ditemukan|Kantor belum ditemukan)/,
    waitingHeading: /^Menunggu persetujuan$/,
    sendRequest: "Kirim permintaan",
  },
  en: {
    mainMenu: "Main menu",
    nav: { org: "Organization", chat: "Chat" },
    tabUsers: /^Users/,
    // TODO(label): teks Inggris layar nonaktif dan dikeluarkan.
    suspendedHeading: /is deactivated/,
    removedHeading: /has been removed/,
    resetButton: /^Reset and start over/,
  },
};
const TID = {
  // TODO(label): data-testid opsional; kalau ada, dipakai lebih dulu dari teks.
  suspended: "status-suspended",
  removed: "status-removed",
  recheckResult: "status-recheck-result",
};

const NODE_IDS = ["A", "B"];
const NODES = Object.fromEntries(
  NODE_IDS.map((id, i) => [
    id,
    {
      port: 47961 + i + PORT_OFFSET,
      cdp: 9461 + i + PORT_OFFSET,
      dir: join(root, `laptop-${id.toLowerCase()}`),
      adFile: join(root, `ad-${id.toLowerCase()}.json`),
    },
  ]),
);
const NO_DOMAIN = { machineDomain: null, local: null, localPartial: false, localDelayMs: 0, reachable: true, users: {} };

// ----- Kredensial: hanya kunci laptop uji ini yang dihapus di akhir ---------------
const credTarget = (pk) => `device-key-${pk.toLowerCase()}.id.mira.desktop`;
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

// ----- Instance -------------------------------------------------------------------
const running = {};
const lang = {};

async function rememberKey(id) {
  try {
    const st = await running[id].page.evaluate(() => window.__TAURI_INTERNALS__.invoke("get_app_state"));
    if (st?.identity?.publicKey) ourKeys.add(st.identity.publicKey.toLowerCase());
    return st;
  } catch {
    return null;
  }
}

async function launch(id, { env = {} } = {}) {
  const node = NODES[id];
  mkdirSync(node.dir, { recursive: true });
  writeFileSync(node.adFile, JSON.stringify(NO_DOMAIN, null, 2), "utf8");
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
  pg(id).locator(`nav[aria-label="${LBL.id.mainMenu}"], nav[aria-label="${LBL.en.mainMenu}"]`).first().isVisible();
const dialog = (id) => pg(id).getByRole("dialog");

async function snap(id, no, slug) {
  const file = `pb${String(no).padStart(2, "0")}-${slug}.png`;
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

// Tema lewat prefers-color-scheme (mode bawaan "system" mengikutinya tanpa muat ulang).
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

// Bahasa lewat pengaturan lokal (app.language) dan muat ulang WebView. Dipakai
// untuk layar status yang tidak punya pemilih bahasa, dan untuk A. Bukan restart
// aplikasi: proses Mira dan jaringannya tetap berjalan.
async function setLangReload(id, to) {
  if (lang[id] === to) return;
  await call(id, "set_setting", { key: "app.language", value: to });
  await pg(id).evaluate((l) => {
    try {
      localStorage.setItem("mira.lang", l);
    } catch {
      /* hanya frame pertama */
    }
  }, to);
  await pg(id).reload();
  await pg(id).waitForFunction(() => "__TAURI_INTERNALS__" in window, null, { timeout: 20000 });
  await pg(id).waitForFunction((l) => document.documentElement.lang === l, to, { timeout: 8000 }).catch(() => {});
  lang[id] = to;
  await sleep(800);
}

const mainNavBtn = (id, key) =>
  pg(id).getByRole("navigation", { name: LBL[lang[id]].mainMenu }).getByRole("button", { name: menuName(LBL[lang[id]].nav[key]) });

async function openUsers(id) {
  await mainNavBtn(id, "org").click({ timeout: 15000 });
  const tab = pg(id).locator("nav.org-tabs-wrap").getByRole("button", { name: LBL[lang[id]].tabUsers });
  await tab.waitFor({ timeout: 15000 });
  await tab.click();
  await pg(id).locator("table.ut").waitFor({ timeout: 15000 }).catch(() => {});
  await sleep(800);
}

const userRow = (id, name) => pg(id).locator("table.ut tbody tr").filter({ hasText: name });

// Baris orang di tab Pengguna. Saringan status bawaan ("Semua yang aktif") bisa
// menyembunyikan orang nonaktif; kalau baris tidak terlihat, saringan diganti.
async function findRow(id, name, mustHave = null) {
  const row = userRow(id, name);
  const visible = async () => (await row.count()) > 0 && (!mustHave || has(await row.first().innerText(), mustHave));
  if (await soft(waitFor("baris terlihat", visible, 8000, 500), false)) return row.first();
  const select = pg(id).locator("section.users").getByLabel(LBL.id.statusFilter, { exact: true });
  for (const value of LBL.id.statusFilterValues) {
    const ok = await soft(select.selectOption(value, { timeout: 3000 }).then(() => true), false);
    if (ok && (await soft(waitFor("baris terlihat", visible, 5000, 500), false))) return row.first();
  }
  return null;
}

// Aksi di menu titik tiga baris `name`: suspend | reinstate | remove. Hasil true kalau
// lewat layar; kalau gagal, screenshot dan false (pemanggil memakai command cadangan).
async function userAction(id, name, kind, shotNo = null, shotSlug = null) {
  const page = pg(id);
  try {
    const row = await findRow(id, name);
    if (!row) throw new Error(`baris ${name} tidak terlihat di tab Pengguna`);
    await page.getByRole("button", { name: LBL.id.actionsFor(name), exact: true }).click({ timeout: 10000 });
    let clicked = false;
    for (const re of LBL.id.menu[kind]) {
      const item = page.getByRole("menuitem", { name: re });
      if ((await item.count()) > 0 && (await item.first().isEnabled())) {
        await item.first().click();
        clicked = true;
        break;
      }
    }
    if (!clicked) throw new Error(`item menu ${kind} tidak ada`);
    const dlg = dialog(id);
    const opened = await soft(dlg.waitFor({ timeout: 5000 }).then(() => true), false);
    if (opened) {
      const choice = LBL.id.choice[kind];
      if (choice) {
        const radio = dlg.getByRole("radio", { name: choice });
        if ((await radio.count()) > 0) await radio.first().check();
      }
      const typed = dlg.getByRole("textbox", { name: LBL.id.typeToConfirm });
      if ((await typed.count()) > 0) await typed.first().fill(name);
      if (shotNo) await snap(id, shotNo, shotSlug);
      const confirm = dlg.getByRole("button", { name: LBL.id.confirm[kind] });
      const btn = (await confirm.count()) > 0 ? confirm.last() : dlg.locator("button.btn-danger, button.btn-primary").last();
      await btn.click({ timeout: 10000 });
      await dlg.waitFor({ state: "detached", timeout: 15000 });
    } else if (shotNo) {
      await snap(id, shotNo, shotSlug);
    }
    return true;
  } catch (e) {
    note(`aksi ${kind} untuk ${name} lewat layar gagal: ${e.message}`);
    await page.keyboard.press("Escape").catch(() => {});
    await page.screenshot({ path: join(shots, `error-suspend-aksi-${kind}.png`) }).catch(() => {});
    return false;
  }
}

// ----- Data B: command dan isi berkas database (hanya dibaca) ------------------------
// Isi berkas SQLite dibaca mentah untuk mencari penanda unik. Tidak memakai pustaka
// SQLite dan tidak menulis apa pun. Berkas -shm dilewati (dikunci SQLite).
function dbFiles(dir) {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.db(-wal)?$/i.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}
function dataContains(id, needle) {
  const buf = Buffer.from(needle, "utf8");
  for (const f of dbFiles(NODES[id].dir)) {
    try {
      if (statSync(f).size > 512 * 1024 * 1024) continue;
      if (readFileSync(f).indexOf(buf) >= 0) return true;
    } catch {
      /* berkas sedang dipakai: lewati */
    }
  }
  return false;
}

async function messagesOf(id, conv) {
  const r = await call(id, "chat_messages", { conv, before: null, limit: 200 });
  return r.ok ? { ok: true, texts: r.value.messages.map((m) => m.text) } : { ok: false, error: r.error?.code ?? JSON.stringify(r.error) };
}
async function tasksOf(id, projectId) {
  const r = await call(id, "board_get_board", { projectId });
  return r.ok
    ? { ok: true, titles: r.value.columns.flatMap((c) => c.tasks.map((t) => t.title)) }
    : { ok: false, error: r.error?.code ?? JSON.stringify(r.error) };
}
const onlineNames = async (id) =>
  (await must(id, "get_network_status")).peers.filter((p) => p.online).map((p) => p.displayName);
const userOnA = async (pk) => (await must("A", "org_users")).find((u) => u.publicKey === pk) ?? null;

// ----- Onboarding B -------------------------------------------------------------------
async function requestToJoin(id) {
  const page = pg(id);
  await passName(page, NAME[id]);
  await passFirewall(page);
  const h = await waitHeading(id, LBL.id.resultHeading, 40000);
  if (/^Beberapa/.test(h)) {
    note(`${id} melihat beberapa kantor (mungkin ada Mira lain di PC ini), ${ORG} dipilih`);
    await page.getByRole("radio", { name: new RegExp("^" + ORG) }).check();
  }
  await page.locator('select[name="team"]').selectOption({ label: DEPT });
  await page.getByRole("button", { name: LBL.id.sendRequest }).click();
  await waitHeading(id, LBL.id.waitingHeading, 30000);
  return { heading: h, code: (await page.locator(".onb-match").innerText()).trim() };
}

async function requestOnA(name, timeoutMs = 40000) {
  return waitFor(`A melihat permintaan ${name}`, async () => {
    const list = await must("A", "org_join_requests");
    return list.find((r) => r.displayName === name) ?? null;
  }, timeoutMs);
}

const reqCard = (name) =>
  pg("A").locator("li.req").filter({ has: pg("A").getByRole("heading", { name, exact: true }) });

async function approveByCard(name) {
  try {
    await mainNavBtn("A", "org").click({ timeout: 10000 });
    await pg("A").locator("nav.org-tabs-wrap").getByRole("button", { name: /^Permintaan bergabung/ }).click({ timeout: 15000 });
    await reqCard(name).waitFor({ timeout: 30000 });
    await reqCard(name).getByRole("button", { name: LBL.id.approveAria(name) }).click({ timeout: 10000 });
    return true;
  } catch (e) {
    note(`Setujui lewat kartu ${name} gagal: ${e.message}`);
    const req = await requestOnA(name, 5000).catch(() => null);
    if (req) await call("A", "org_approve_join", { requestId: req.id });
    return false;
  }
}

// ----- Skenario ---------------------------------------------------------------------
const pk = {};
let deptId = null;
let projectId = null;
let umumId = null;

async function main() {
  console.log(`Data uji: ${root}\nScreenshot: ${shots}\nPort QUIC ${NODES.A.port}-${NODES.B.port}, CDP ${NODES.A.cdp}-${NODES.B.cdp}`);

  // ----- 0. Kantor A, B bergabung lewat permintaan -------------------------------------
  console.log("\n--- 0. Persiapan ---");
  await launch("A");
  await must("A", "save_display_name", { name: NAME.A });
  await must("A", "create_organization", { name: ORG, adDomain: null });
  deptId = (await must("A", "org_create_department", { name: DEPT })).id;
  pk.A = (await must("A", "get_app_state")).identity.publicKey;
  await must("A", "org_move_member", { publicKey: pk.A, teamId: deptId });
  await pg("A").reload();
  await pg("A").waitForFunction(() => "__TAURI_INTERNALS__" in window, null, { timeout: 20000 });
  check("0.1 A membuat kantor dan departemen", await waitShell("A"));
  await setTheme("A", "light");
  await sleep(3000); // A mulai mengiklankan kantor lewat mDNS.

  await launch("B");
  pk.B = (await must("B", "get_app_state")).identity.publicKey;
  const fpB1 = (await must("B", "get_app_state")).identity.fingerprint;
  await setTheme("B", "light");
  const j1 = await requestToJoin("B");
  const r1 = await requestOnA(NAME.B);
  check("0.2 A menerima permintaan B dengan kode yang sama", r1.code === j1.code, `${r1.code} / ${j1.code}`);
  check("0.3 Permintaan pertama B tanpa petunjuk pernah dikeluarkan", r1.previouslyRemoved === null, JSON.stringify(r1.previouslyRemoved));
  check("0.4 A menyetujui B lewat kartu", await approveByCard(NAME.B));
  check("0.5 B masuk Mira", (await waitShell("B")) && (await must("B", "get_app_state")).membership === "active");

  // Proyek dengan B sebagai anggota, dan #umum.
  projectId = (await must("A", "board_create_project", { name: PROJECT.name, code: PROJECT.code, teamId: deptId, members: [pk.B] })).id;
  umumId = (await must("A", "chat_overview")).conversations.find((c) => c.isUmum)?.id;
  const ready = await soft(waitFor("B tersambung dan melihat proyek", async () => {
    const online = (await onlineNames("A")).includes(NAME.B);
    const proj = (await must("B", "board_list_projects")).some((p) => p.id === projectId);
    return online && proj;
  }, 60000), false);
  check("0.6 A dan B tersambung, proyek B terlihat", ready);
  await must("A", "chat_send", { conv: umumId, text: MSG_BEFORE, replyTo: null, mentions: [], files: [] });
  const before = await soft(waitFor("B menerima pesan kontrol", async () => (await messagesOf("B", umumId)).texts?.includes(MSG_BEFORE), 60000), false);
  check("0.7 Kontrol: pesan A di #umum sampai ke B sebelum nonaktif", before);
  const gate = await call("A", "org_suspend_gate");
  check("0.8 Gerbang versi menonaktifkan terbuka", gate.ok && gate.value.allowed === true, JSON.stringify(gate.ok ? gate.value : gate.error));

  // ----- 1. A menonaktifkan B --------------------------------------------------------
  console.log("\n--- 1. Nonaktifkan ---");
  await openUsers("A");
  await findRow("A", NAME.B);
  await snap("A", 1, "pengguna-b-aktif-id-terang");
  const viaUi = await userAction("A", NAME.B, "suspend", 2, "dialog-nonaktifkan-id-terang");
  check("1.1 A menonaktifkan B lewat Organisasi > Pengguna", viaUi);
  if (!viaUi) await call("A", "org_suspend_member", { publicKey: pk.B });
  const uA = await soft(waitFor("A mencatat B nonaktif", async () => (await userOnA(pk.B))?.status === "suspended", 15000, 500), false);
  check("1.2 org_users A: status B suspended", uA);

  // B tanpa restart dan tanpa muat ulang.
  const shown = await soft(waitFor("layar nonaktif B", async () => {
    const t = await bodyText("B");
    return has(t, LBL.id.suspendedHeading) || (await pg("B").getByTestId(TID.suspended).count()) > 0;
  }, 60000, 500), false);
  check("1.3 B menampilkan layar \"sedang dinonaktifkan\" tanpa restart", shown);
  const stB = await must("B", "get_app_state");
  check("1.4 get_app_state B: membership suspended", stB.membership === "suspended", stB.membership);
  const bodyB = await bodyText("B");
  check("1.5 Layar nonaktif menampilkan sidik jari laptop B", bodyB.includes(fpB1), fpB1);
  check("1.6 Layar nonaktif menyebut siapa yang bisa mengaktifkan lagi", has(bodyB, LBL.id.suspendedContact));
  check("1.7 Layar nonaktif tanpa menu utama", !(await shellVisible("B")));
  await snap("B", 3, "nonaktif-id-terang");
  const net = await soft(waitFor("status jaringan B suspended", async () => (await must("B", "get_network_status")).state === "suspended", 20000), false);
  check("1.8 get_network_status B: suspended", net);
  const offline = await soft(waitFor("B tidak online di A", async () => !(await onlineNames("A")).includes(NAME.B), 30000), false);
  check("1.9 B tidak terdaftar sebagai rekan online di A selama nonaktif", offline);

  // Periksa lagi.
  await pg("B").getByRole("button", { name: LBL.id.recheck }).click({ timeout: 10000 });
  const resultShown = await waitText("B", LBL.id.recheckResult, 15000);
  check("1.10 \"Periksa lagi\" menampilkan hasil \"Dicek HH.MM: masih nonaktif\"", resultShown,
    (await bodyText("B")).split("\n").find((l) => /Dicek/.test(l)) ?? "");
  await snap("B", 4, "nonaktif-periksa-lagi-id-terang");
  const cm = await call("B", "check_membership");
  check("1.11 check_membership B: suspended, ada laptop kantor yang dihubungi",
    cm.ok && cm.value.membership === "suspended" && cm.value.peersReached >= 1, JSON.stringify(cm.ok ? cm.value : cm.error));

  // ----- 2. Data baru selama nonaktif tidak sampai ------------------------------------
  console.log("\n--- 2. Selama nonaktif ---");
  await must("A", "chat_send", { conv: umumId, text: MSG_SUSPENDED, replyTo: null, mentions: [], files: [] });
  await must("A", "board_create_task", { projectId, input: { title: TASK_SUSPENDED, columnId: "todo" } });
  // Picu sinkron op lagi dari B, lalu beri waktu satu putaran sinkron cadangan.
  await pg("B").getByRole("button", { name: LBL.id.recheck }).click({ timeout: 10000 }).catch(() => {});
  let leaked = { msg: false, task: false, raw: false };
  const watchStart = Date.now();
  while (Date.now() - watchStart < 70000) {
    const m = await messagesOf("B", umumId);
    const t = await tasksOf("B", projectId);
    leaked.msg ||= Boolean(m.texts?.includes(MSG_SUSPENDED));
    leaked.task ||= Boolean(t.titles?.includes(TASK_SUSPENDED));
    leaked.raw ||= dataContains("B", MSG_SUSPENDED) || dataContains("B", TASK_SUSPENDED);
    if (leaked.msg || leaked.task) break;
    await sleep(5000);
  }
  const mNow = await messagesOf("B", umumId);
  const tNow = await tasksOf("B", projectId);
  check("2.1 B tidak menerima pesan #umum selama nonaktif (chat_messages)", !leaked.msg, mNow.ok ? `${mNow.texts.length} pesan` : `chat_messages: ${mNow.error}`);
  check("2.2 B tidak menerima kartu board selama nonaktif (board_get_board)", !leaked.task, tNow.ok ? `${tNow.titles.length} kartu` : `board_get_board: ${tNow.error}`);
  check("2.3 Layar B tetap layar nonaktif dan tidak memuat pesan baru",
    !(await bodyText("B")).includes(MSG_SUSPENDED) && has(await bodyText("B"), LBL.id.suspendedHeading));
  const rawWhileSuspended = leaked.raw;

  // Screenshot layar nonaktif: gelap, Inggris, lalu kembali ke Indonesia terang.
  await setTheme("B", "dark");
  await snap("B", 5, "nonaktif-id-gelap");
  await setLangReload("B", "en");
  check("2.4 Layar nonaktif berbahasa Inggris setelah bahasa diganti",
    (await waitText("B", LBL.en.suspendedHeading, 10000)) || (await pg("B").getByTestId(TID.suspended).count()) > 0);
  await snap("B", 6, "nonaktif-en-gelap");
  await setTheme("B", "light");
  await snap("B", 7, "nonaktif-en-terang");
  await setLangReload("B", "id");
  await waitText("B", LBL.id.suspendedHeading, 10000);

  // Tampilan A: status Nonaktif di Pengguna (Indonesia terang, Inggris gelap).
  await openUsers("A");
  const rowS = await findRow("A", NAME.B, LBL.id.rowSuspended);
  check("2.5 Tab Pengguna A: baris B berstatus Nonaktif", Boolean(rowS), rowS ? (await rowS.innerText()).replace(/\s+/g, " ").slice(0, 160) : "");
  await snap("A", 8, "pengguna-b-nonaktif-id-terang");
  await setLangReload("A", "en");
  await setTheme("A", "dark");
  await openUsers("A");
  await findRow("A", NAME.B);
  await snap("A", 9, "pengguna-b-nonaktif-en-gelap");
  await setLangReload("A", "id");
  await setTheme("A", "light");

  // ----- 3. Aktifkan lagi ----------------------------------------------------------
  console.log("\n--- 3. Aktifkan lagi ---");
  await openUsers("A");
  const reUi = await userAction("A", NAME.B, "reinstate");
  check("3.1 A mengaktifkan B lagi lewat Organisasi > Pengguna", reUi);
  if (!reUi) await call("A", "org_reinstate_member", { publicKey: pk.B });
  check("3.2 org_users A: status B active lagi",
    await soft(waitFor("A mencatat B aktif", async () => (await userOnA(pk.B))?.status === "active", 15000, 500), false));
  const t0 = Date.now();
  // Tanpa muat ulang: cek otomatis tiap 20 detik dan event mira://directory.
  const back = await waitShell("B", 60000);
  check("3.3 B kembali ke Mira tanpa restart", back, `${((Date.now() - t0) / 1000).toFixed(1)} dtk`);
  check("3.4 get_app_state B: membership active", (await must("B", "get_app_state")).membership === "active");
  const dept = await soft(waitFor("B kembali ke departemennya", async () =>
    (await must("B", "org_people")).find((p) => p.publicKey === pk.B)?.departmentId === deptId, 30000), false);
  check("3.5 Cuplikan dikembalikan: B kembali di departemen Keuangan", dept);
  const gotMsg = await soft(waitFor("B menerima pesan selama nonaktif", async () => (await messagesOf("B", umumId)).texts?.includes(MSG_SUSPENDED), 90000), false);
  check("3.6 Setelah aktif lagi B menerima pesan #umum yang dikirim selama nonaktif", gotMsg, `${((Date.now() - t0) / 1000).toFixed(1)} dtk`);
  const gotTask = await soft(waitFor("B menerima kartu", async () => (await tasksOf("B", projectId)).titles?.includes(TASK_SUSPENDED), 90000), false);
  check("3.7 Setelah aktif lagi B menerima kartu board (keanggotaan proyek kembali)", gotTask);
  const rawAfter = dataContains("B", MSG_SUSPENDED);
  if (rawAfter) {
    check("3.8 Isi database B tidak memuat pesan itu selama nonaktif (baru ada setelah aktif lagi)", !rawWhileSuspended);
  } else {
    note("penanda pesan tidak ditemukan mentah di berkas database B setelah aktif lagi; pemeriksaan isi berkas dilewati (format penyimpanan tidak bisa dibaca mentah)");
  }
  const reOnline = await soft(waitFor("B online lagi di A", async () => (await onlineNames("A")).includes(NAME.B), 60000), false);
  check("3.9 B tersambung lagi sebagai rekan di A", reOnline);
  try {
    await mainNavBtn("B", "chat").click({ timeout: 10000 });
    await pg("B").getByText(MSG_SUSPENDED).first().waitFor({ timeout: 20000 }).catch(() => {});
    const umumName = (await must("B", "chat_overview")).conversations.find((c) => c.id === umumId)?.name ?? "umum";
    await pg("B").getByRole("navigation", { name: /Daftar percakapan/i })
      .getByRole("button", { name: new RegExp(`^Channel ${umumName}(,|$)`) }).click({ timeout: 10000 });
    check("3.10 Layar chat B menampilkan pesan yang dikirim selama nonaktif", await waitText("B", MSG_SUSPENDED, 20000));
  } catch (e) {
    check("3.10 Layar chat B menampilkan pesan yang dikirim selama nonaktif", false, e.message);
  }
  await snap("B", 10, "aktif-lagi-chat-id-terang");

  // ----- 4. Keluarkan permanen --------------------------------------------------------
  console.log("\n--- 4. Keluarkan permanen ---");
  await openUsers("A");
  const rmUi = await userAction("A", NAME.B, "remove", 11, "dialog-keluarkan-permanen-id-terang");
  check("4.1 A mengeluarkan B permanen lewat Organisasi > Pengguna", rmUi);
  if (!rmUi) await call("A", "org_remove_member", { publicKey: pk.B });
  check("4.2 org_users A: status B removed",
    await soft(waitFor("A mencatat B dikeluarkan", async () => (await userOnA(pk.B))?.status === "removed", 15000, 500), false));
  const resetBtn = pg("B").getByRole("button", { name: LBL.id.resetButton });
  const removedShown = await soft(resetBtn.waitFor({ timeout: 60000 }).then(() => true), false);
  check("4.3 B menampilkan layar dikeluarkan dengan \"Reset dan mulai dari awal\" tanpa restart", removedShown);
  check("4.4 get_app_state B: membership removed", (await must("B", "get_app_state")).membership === "removed");
  check("4.5 Layar dikeluarkan menyebut dikeluarkan", has(await bodyText("B"), LBL.id.removedHeading));
  await snap("B", 12, "dikeluarkan-id-terang");
  await setTheme("B", "dark");
  await snap("B", 13, "dikeluarkan-id-gelap");
  await setLangReload("B", "en");
  check("4.6 Layar dikeluarkan berbahasa Inggris", await soft(pg("B").getByRole("button", { name: LBL.en.resetButton }).waitFor({ timeout: 10000 }).then(() => true), false));
  await snap("B", 14, "dikeluarkan-en-gelap");
  await setTheme("B", "light");
  await snap("B", 15, "dikeluarkan-en-terang");
  await setLangReload("B", "id");

  // ----- 5. Reset dan bergabung lagi ---------------------------------------------------
  console.log("\n--- 5. Reset ---");
  // Preferensi tampilan disimpan eksplisit supaya bisa dicek tetap ada setelah reset.
  await call("B", "set_setting", { key: "theme.mode", value: "system" });
  await call("B", "set_setting", { key: "app.language", value: "id" });
  const oldPk = pk.B;
  await pg("B").getByRole("button", { name: LBL.id.resetButton }).click({ timeout: 15000 });
  const rdlg = dialog("B");
  const confirmShown = await soft(rdlg.waitFor({ timeout: 10000 }).then(() => true), false);
  check("5.1 Reset meminta konfirmasi lewat dialog", confirmShown);
  await snap("B", 16, "dialog-reset-id-terang");
  if (confirmShown) await rdlg.getByRole("button", { name: LBL.id.resetConfirm }).last().click({ timeout: 10000 });
  else await call("B", "reset_removed_laptop");
  const onb = await soft(waitNameStep(pg("B"), 40000).then(() => true), false);
  check("5.2 B kembali ke onboarding tanpa restart", onb);
  const stR = await rememberKey("B");
  check("5.3 B punya kunci dan sidik jari baru, tanpa organisasi",
    stR && stR.identity.publicKey !== oldPk && stR.identity.fingerprint !== fpB1 && stR.organization === null && stR.membership === "none",
    stR ? `${fpB1} -> ${stR.identity.fingerprint}` : "get_app_state gagal");
  pk.B = stR?.identity.publicKey ?? pk.B;
  check("5.4 Kunci lama B terhapus dari Credential Manager", !miraCredentials().has(credTarget(oldPk)));
  if (rawAfter) check("5.5 Data organisasi lama di folder B terhapus (pesan tidak ada lagi)", !dataContains("B", MSG_SUSPENDED));
  const langPref = await call("B", "get_setting", { key: "app.language" });
  const themePref = await call("B", "get_setting", { key: "theme.mode" });
  check("5.6 Preferensi tampilan (bahasa, tema) tetap setelah reset",
    langPref.ok && langPref.value === "id" && themePref.ok && themePref.value === "system", `${JSON.stringify(langPref.value)} / ${JSON.stringify(themePref.value)}`);
  await snap("B", 17, "onboarding-setelah-reset-id-terang");

  const j2 = await requestToJoin("B");
  const r2 = await requestOnA(NAME.B);
  check("5.7 A menerima permintaan baru B dengan kode yang sama", r2.code === j2.code && r2.publicKey === pk.B, `${r2.code} / ${j2.code}`);
  const hint = r2.previouslyRemoved;
  check("5.8 Permintaan baru membawa petunjuk: laptop sama dengan anggota yang dikeluarkan",
    hint?.status === "removed" && hint?.match === "laptop" && hint?.name === NAME.B, JSON.stringify(hint));
  await mainNavBtn("A", "org").click({ timeout: 10000 });
  await pg("A").locator("nav.org-tabs-wrap").getByRole("button", { name: /^Permintaan bergabung/ }).click({ timeout: 15000 });
  const c = reqCard(NAME.B);
  await c.waitFor({ timeout: 30000 }).catch(() => {});
  check("5.9 Kartu A menampilkan petunjuk pernah dikeluarkan", await waitText("A", LBL.id.previouslyRemoved, 10000, c));
  await c.scrollIntoViewIfNeeded().catch(() => {});
  await snap("A", 18, "kartu-pernah-dikeluarkan-id-terang");
  check("5.10 A menyetujui B lagi lewat kartu", await approveByCard(NAME.B));
  check("5.11 B aktif lagi di kantor dengan kunci baru",
    (await waitShell("B", 60000)) && (await must("B", "get_app_state")).membership === "active");
  const users = await must("A", "org_users");
  check("5.12 org_users A: kunci baru B aktif, kunci lama tetap removed",
    users.find((u) => u.publicKey === pk.B)?.status === "active" && users.find((u) => u.publicKey === oldPk)?.status === "removed");
  await sleep(1500);
  await snap("B", 19, "bergabung-lagi-id-terang");
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
  check("Skrip berjalan tanpa error", false, String(err?.message ?? err).slice(0, 300));
  for (const id of Object.keys(running)) {
    await pg(id).screenshot({ path: join(shots, `error-suspend-${id.toLowerCase()}.png`) }).catch(() => {});
  }
}
await cleanup();

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} dari ${results.length} pemeriksaan lulus.`);
if (failed) {
  console.log("Yang gagal:");
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
}
process.exit(failed || results.length === 0 ? 1 : 0);
