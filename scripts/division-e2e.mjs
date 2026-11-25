// Uji ujung ke ujung Departemen saya dan Divisi (docs/plans/dept-divisi.md) di satu PC Windows.
//
// Enam instance mira.exe (build debug), masing-masing dengan folder data
// (MIRA_DATA_DIR), port QUIC (MIRA_PORT), dan port debug WebView2 sendiri,
// dikendalikan lewat Chrome DevTools Protocol. Langkah utama lewat klik di
// layar; hasilnya dicek di data lewat command Tauri. Kalau klik gagal, langkah
// itu dijalankan lewat command supaya skenario tetap berlanjut, dan
// pemeriksaan "lewat layar" dicatat GAGAL.
//
//   A  Ayu    membuat kantor, departemen IT dan Finance, superadmin
//   B  Budi   IT, dijadikan admin departemen IT
//   C  Citra  IT, kepala divisi Mobile
//   D  Dodi   IT, anggota Mobile, lalu dipindah ke Finance
//   E  Eka    Finance
//   F  Fajar  laptop lama: MIRA_TEST_APP_VERSION=0.4.0, bergabung ke IT
//
// Bergabung lewat permintaan bergabung yang disetujui A (alamat 127.0.0.1,
// tanpa menunggu mDNS); kalau gagal, lewat kode undangan. Setelah setiap orang
// bergabung, semua laptop saling diberi alamat manual supaya sinkron tidak
// bergantung pada mDNS (PC ini dipakai bersama uji lain).
//
// Pakai:  node scripts/division-e2e.mjs [path mira.exe debug] [folder screenshot] [folder induk data uji]
// Env:    E2E_PORT_OFFSET   geser semua port (lead: 1500). Port dasar QUIC 47961-47966, CDP 9461-9466.
//         E2E_SHOTS=1       simpan screenshot dd01-... ke docs/progress/screenshots/dept-divisi/
//         E2E_DATA_ROOT     folder induk data uji (bukan drive C). Bawaan: TMP kalau bukan di C,
//                           selain itu D:\mira-tmp\dept-divisi. Folder uji: e2e-<run> di dalamnya.
//         E2E_KEEP=1        folder data uji tidak dihapus di akhir (untuk memeriksa kegagalan).
//         MIRA_EXE          path mira.exe kalau argumen pertama tidak diberikan.
//         DIVISION_E2E_MDNS=0   matikan mDNS di semua instance (hanya alamat manual).
//         DIVISION_E2E_MESH=0   jangan pasang alamat manual antar laptop.
//         DIVISION_E2E_JOIN=invite  bergabung lewat kode undangan saja.
//         DIVISION_E2E_OLD_VERSION  versi laptop lama F (bawaan 0.4.0).
// Butuh:  playwright-core (alat uji saja, tidak dibundel ke aplikasi).

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exe = resolve(process.argv[2] ?? process.env.MIRA_EXE ?? join(repo, "src-tauri", "target", "debug", "mira.exe"));
const SHOTS_ON = process.env.E2E_SHOTS === "1";
const shots = resolve(process.argv[3] ?? join(repo, "docs", "progress", "screenshots", "dept-divisi"));
const KEEP = process.env.E2E_KEEP === "1";
const OFF = Number(process.env.E2E_PORT_OFFSET ?? 0) || 0;
const MDNS = process.env.DIVISION_E2E_MDNS !== "0";
const MESH = process.env.DIVISION_E2E_MESH !== "0";
const JOIN_MODE = process.env.DIVISION_E2E_JOIN === "invite" ? "invite" : "request";
const OLD_VERSION = process.env.DIVISION_E2E_OLD_VERSION ?? "0.4.0";
const appVersion = (() => {
  try {
    return readFileSync(join(repo, "src-tauri", "Cargo.toml"), "utf8").match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? "?";
  } catch {
    return "?";
  }
})();

// ----- Folder data: tidak pernah di drive C -----------------------------------------
function pickDataBase() {
  const candidates = [process.argv[4], process.env.E2E_DATA_ROOT, process.env.TMP, "D:\\mira-tmp\\dept-divisi"];
  for (const c of candidates) {
    if (!c) continue;
    const r = resolve(c);
    if (/^c:/i.test(r)) {
      console.log(`Catatan: ${r} ada di drive C, tidak dipakai untuk data uji.`);
      continue;
    }
    return r;
  }
  return null;
}
const dataBase = pickDataBase();
if (!dataBase) {
  console.log("Tidak ada folder data di luar drive C. Isi E2E_DATA_ROOT, misalnya D:\\mira-tmp\\dept-divisi.");
  process.exit(2);
}
const runId = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${process.pid}`;
const root = join(dataBase, `e2e-${runId}`);

// ----- Data uji ----------------------------------------------------------------------
const ORG = "Kantor Uji Divisi";
const DEPT_IT = "IT";
const DEPT_FIN = "Finance";
const DIV = "Mobile";
const NOTE_IT = "Rapat IT setiap Senin 09.00. Laporan mingguan masuk sebelum Jumat.";
const NOTE_MOBILE = "Rilis Android minggu depan. Uji di perangkat sendiri dulu.";
const PROJECT = { name: "Aplikasi Mobile", code: "MOBA" };

const IDS = ["A", "B", "C", "D", "E", "F"];
const NAMES = { A: "Ayu Uji", B: "Budi Uji", C: "Citra Uji", D: "Dodi Uji", E: "Eka Uji", F: "Fajar Uji" };
const NODES = Object.fromEntries(
  IDS.map((id, i) => [id, { name: NAMES[id], port: 47961 + i + OFF, cdp: 9461 + i + OFF, dir: join(root, `laptop-${id.toLowerCase()}`) }]),
);
const addr = (id) => `127.0.0.1:${NODES[id].port}`;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ----- Teks layar ----------------------------------------------------------------------
// Sumber: src/i18n/org-division.{id,en}.ts, chat-division.*, chat.*, chat-text.*,
// division-misc.*, board-detail.*, board-screen.*, org-users.id.ts, shell.*, org.*.
const TXT = {
  id: {
    mainMenu: "Menu utama",
    nav: { chat: "Chat", board: "Board", org: "Organisasi" },
    orgTitle: "Organisasi",
    tabUsers: "Pengguna",
    tabMyDept: "Departemen saya",
    chatList: "Daftar percakapan",
    sectionDept: "Departemen",
    channelRow: (n) => new RegExp(`^Channel ${esc(n)}(,|$)`),
    divisionRow: (n) => new RegExp(`^Chat divisi ${esc(n)}(,|$)`),
    composer: (title) => `Pesan untuk ${title}`,
    pinnedAside: "Catatan disematkan",
    gateTeam: "Hanya admin departemen dan superadmin yang bisa menulis di channel ini",
    newProjectBtn: /^(Proyek baru|Buat proyek pertama)$/,
    newProjectTitle: "Proyek baru",
    projectName: "Nama proyek",
    projectCode: "Kode proyek",
    forDivision: "Untuk divisi",
    createProject: "Buat proyek",
    divisionOption: (d, t) => `${d}, ${t}`,
    md: {
      membersTitle: "Anggota departemen",
      newDivision: "Nama divisi baru",
      createDivision: "Buat divisi",
      addLabel: (d) => `Tambah orang ke divisi ${d}`,
      add: "Tambahkan",
      makeHead: (n, d) => `Jadikan kepala, ${n}, divisi ${d}`,
      renameAria: (d) => `Ganti nama divisi ${d}`,
      archiveAria: (d) => `Arsipkan divisi ${d}`,
      archiveConfirm: (d) => `Arsipkan ${d}`,
      makeAdmin: (n) => `Jadikan admin, ${n}`,
      removeAdmin: (n) => `Lepas admin, ${n}`,
      confirmRemoveAdmin: "Lepas admin",
      removeAdminFail: "Admin departemen belum dilepas",
      pinned: "Catatan disematkan",
      announce: "Mode pengumuman",
      saveChat: "Simpan pengaturan chat",
      divisionChatFold: "Chat divisi",
      historyMade: (by, t) => `${by} menjadikan ${t} admin departemen`,
      historyRemoved: (by, t) => `${by} melepas ${t} dari admin departemen`,
      gateTitle: "Perubahan divisi menunggu semua laptop memakai Mira",
      gateBlocker: (n, v) => `${n}, Mira ${v}`,
    },
    users: { actions: (n) => `Aksi untuk ${n}`, move: "Ubah departemen", moveTo: "Pindah ke", moveBtn: "Pindahkan" },
  },
  en: {
    mainMenu: "Main menu",
    nav: { chat: "Chat", board: "Board", org: "Organization" },
    orgTitle: "Organization",
    tabMyDept: "My department",
    chatList: "Conversations",
    sectionDept: "Department",
    channelRow: (n) => new RegExp(`^Channel ${esc(n)}(,|$)`),
    divisionRow: (n) => new RegExp(`^${esc(n)} division chat(,|$)`),
    newProjectBtn: /^(New project|Create the first project)$/,
    newProjectTitle: "New project",
    projectName: "Project name",
    forDivision: "Division",
    divisionOption: (d, t) => `${d}, ${t}`,
    md: { membersTitle: "Department members" },
  },
};

// ----- Kredensial: hanya kunci laptop uji ini yang dihapus di akhir -------------------
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

// ----- Hasil ---------------------------------------------------------------------------
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "LULUS" : "GAGAL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const soft = (p, fallback = null) => p.catch(() => fallback);
const short = (v, n = 220) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return (s ?? "").replace(/\s+/g, " ").slice(0, n);
};

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
  throw new Error(`Menunggu terlalu lama: ${desc} (terakhir: ${short(last, 200)})`);
}

// ----- Instance ------------------------------------------------------------------------
const running = {};
const lang = {};

async function cdpBusy(port) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

async function rememberKey(id) {
  try {
    const st = await running[id].page.evaluate(() => window.__TAURI_INTERNALS__.invoke("get_app_state"));
    if (st?.identity?.publicKey) ourKeys.add(st.identity.publicKey.toLowerCase());
  } catch {
    /* dicoba lagi saat kredensial dibersihkan */
  }
}

async function launch(id, { env = {} } = {}) {
  const node = NODES[id];
  // Port debug yang sudah menjawab berarti instance lain (mungkin milik sesi lain): jangan disentuh.
  if (await cdpBusy(node.cdp)) {
    throw new Error(`Port CDP ${node.cdp} sudah dipakai proses lain. Jalankan dengan E2E_PORT_OFFSET lain.`);
  }
  mkdirSync(node.dir, { recursive: true });
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      MIRA_DATA_DIR: node.dir,
      MIRA_PORT: String(node.port),
      MIRA_UPDATER_ENDPOINT: "http://127.0.0.1:9/latest.json",
      ...(MDNS ? {} : { MIRA_DISABLE_MDNS: "1" }),
      ...env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${node.cdp}`,
    },
    stdio: "ignore",
  });
  const exited = new Promise((r) => child.once("exit", r));
  let browser;
  for (let i = 0; i < 80 && !browser; i++) {
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
  await page.waitForFunction(() => "__TAURI_INTERNALS__" in window, null, { timeout: 30000 });
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

const pg = (id) => running[id].page;
const L = (id) => TXT[lang[id] ?? "id"];

async function reload(id) {
  await pg(id).reload();
  await pg(id).waitForFunction(() => "__TAURI_INTERNALS__" in window, null, { timeout: 30000 });
  await shellReady(id);
}
async function shellReady(id) {
  await pg(id)
    .getByRole("navigation", { name: L(id).mainMenu })
    .waitFor({ timeout: 30000 })
    .catch(() => {});
}

// ----- Petunjuk saat sinkron lambat ------------------------------------------------------
async function netHint(ids) {
  for (const id of ids) {
    if (!running[id]) continue;
    const r = await call(id, "get_network_status");
    const online = r.ok ? r.value.peers.filter((p) => p.online).map((p) => p.displayName) : [];
    console.log(`  Petunjuk: ${id} melihat rekan online: ${JSON.stringify(online)}${r.ok ? ` (status ${r.value.state})` : ""}`);
  }
  console.log(
    "  Penemuan mDNS bisa lambat kalau uji lain berjalan di PC ini." +
      (MESH ? " Alamat manual antar laptop sudah dipasang." : " Coba tanpa DIVISION_E2E_MESH=0."),
  );
}
// Menunggu data tersinkron. Gagal: hasil { failed } dan petunjuk jaringan dicetak.
async function sync(desc, ids, fn, timeoutMs = 90000) {
  try {
    return await waitFor(desc, fn, timeoutMs, 1000);
  } catch (e) {
    await netHint(ids);
    return { failed: String(e.message) };
  }
}
const okv = (v) => v !== null && v !== undefined && v !== false && !(typeof v === "object" && "failed" in v);
const why = (v) => (v && typeof v === "object" && "failed" in v ? v.failed : "");

// ----- Screenshot ------------------------------------------------------------------------
let shotNo = 0;
async function snap(id, slug, locator = null) {
  if (!SHOTS_ON) return null;
  shotNo += 1;
  const file = `dd${String(shotNo).padStart(2, "0")}-${slug}.png`;
  await sleep(500);
  try {
    if (locator) await locator.screenshot({ path: join(shots, file) });
    else await pg(id).screenshot({ path: join(shots, file) });
    return file;
  } catch (e) {
    console.log(`Catatan: screenshot ${file} gagal: ${e.message.split("\n")[0]}`);
    return null;
  }
}
async function errorShots(tag) {
  if (!SHOTS_ON) return;
  for (const id of Object.keys(running)) {
    await pg(id).screenshot({ path: join(shots, `error-${tag}-${id.toLowerCase()}.png`) }).catch(() => {});
  }
}

// Tema dan bahasa sekaligus, satu muat ulang. Halaman kembali ke layar awal.
async function setLook(id, theme, to) {
  await must(id, "set_setting", { key: "theme.mode", value: theme });
  await must(id, "set_setting", { key: "app.language", value: to });
  await pg(id).evaluate((l) => {
    try {
      localStorage.setItem("mira.lang", l);
    } catch {
      /* storage diblokir: pengaturan app.language tetap dibaca */
    }
  }, to);
  lang[id] = to;
  await reload(id);
  await soft(
    pg(id).waitForFunction(
      ([t, l]) => document.documentElement.getAttribute("data-theme") === t && document.documentElement.lang === l,
      [theme, to],
      { timeout: 10000 },
    ),
  );
  await sleep(600);
}

// ----- Bantuan layar -------------------------------------------------------------------
const menuName = (name) => new RegExp("^" + esc(name) + "\\s*(,|$)");
const mainNav = (id, key) =>
  pg(id).getByRole("navigation", { name: L(id).mainMenu }).getByRole("button", { name: menuName(L(id).nav[key]) });

async function openOrgTab(id, tabLabel) {
  const p = pg(id);
  const tab = () => p.locator("nav.org-tabs-wrap").getByRole("button", { name: tabLabel, exact: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    await mainNav(id, "org").click({ timeout: 10000 });
    await p.getByRole("heading", { name: L(id).orgTitle, level: 1 }).waitFor({ timeout: 15000 });
    if (await soft(tab().waitFor({ timeout: 10000 }).then(() => true), false)) {
      await tab().click();
      await sleep(800);
      return;
    }
    // Tab Departemen saya muncul setelah data peran terbaca: buka ulang lewat Chat.
    await mainNav(id, "chat").click().catch(() => {});
    await sleep(1500);
  }
  throw new Error(`${id}: tab ${tabLabel} tidak tampil`);
}
async function openMyDept(id) {
  await openOrgTab(id, L(id).tabMyDept);
  await pg(id).locator("section[aria-labelledby='md-members-title']").waitFor({ timeout: 15000 });
}
const divisionCard = (id, name) => pg(id).getByRole("article", { name, exact: true });
const mdMembers = (id) => pg(id).locator("section[aria-labelledby='md-members-title']");
const mdChannel = (id) => pg(id).locator("section[aria-labelledby='md-channel-title']");
const mdHistory = (id) => pg(id).locator("section[aria-labelledby='md-history-title']");
const orgLive = (id) => pg(id).locator("div.org-live");

async function openChat(id) {
  await mainNav(id, "chat").click({ timeout: 10000 });
  await pg(id).getByRole("navigation", { name: L(id).chatList }).waitFor({ timeout: 15000 });
}
const chatList = (id) => pg(id).getByRole("navigation", { name: L(id).chatList });
const chatRow = (id, re) => chatList(id).getByRole("button", { name: re });
// Nama aksesibel tombol di bagian Departemen, urut tampilan.
async function deptSectionRows(id) {
  const sec = chatList(id).getByRole("region", { name: L(id).sectionDept, exact: true });
  return sec.locator("button.chat-row").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
}
async function openConversation(id, re, timeoutMs = 60000) {
  await openChat(id);
  const row = chatRow(id, re).first();
  await waitFor(`${id} melihat baris ${re}`, () => row.isVisible(), timeoutMs, 1000);
  await row.click();
  await sleep(800);
}
async function sendViaComposer(id, title, text) {
  const box = pg(id).getByRole("combobox", { name: TXT.id.composer(title), exact: true });
  await box.waitFor({ timeout: 10000 });
  await box.fill(text);
  await box.press("Enter");
}

async function openBoard(id) {
  await mainNav(id, "board").click({ timeout: 10000 });
  await pg(id).locator("main.bd").waitFor({ timeout: 15000 });
}
// Membuka dialog Proyek baru. Hasil: locator dialog, atau null kalau tombolnya tidak ada.
async function openNewProject(id) {
  await openBoard(id);
  const btn = pg(id).getByRole("button", { name: L(id).newProjectBtn }).first();
  const shown = await soft(btn.waitFor({ timeout: 15000 }).then(() => true), false);
  if (!shown) return null;
  await btn.click();
  const dlg = pg(id).getByRole("dialog", { name: L(id).newProjectTitle });
  await dlg.waitFor({ timeout: 10000 });
  await dlg.getByLabel(L(id).projectName, { exact: true }).waitFor({ timeout: 10000 });
  return dlg;
}
async function closeDialog(id) {
  await pg(id).keyboard.press("Escape");
  await soft(pg(id).getByRole("dialog").waitFor({ state: "detached", timeout: 5000 }));
}

// Langkah lewat layar; kalau gagal, lewat command supaya skenario berlanjut. Hasil: true kalau lewat layar.
async function viaUi(desc, uiFn, cmdFn = null) {
  try {
    await uiFn();
    return true;
  } catch (e) {
    console.log(`Catatan: ${desc} lewat layar gagal: ${String(e?.message ?? e).split("\n")[0]}`);
    if (cmdFn) await cmdFn();
    return false;
  }
}

// ----- Data --------------------------------------------------------------------------
const pk = {};
const ids = {};
const deptOv = (id, teamId = null) => must(id, "dept_overview", { teamId });
const divisionIn = (ov, name) => ov?.divisions?.find((d) => d.name === name) ?? null;
const memberIn = (ov, key) => ov?.members?.find((m) => m.publicKey === key) ?? null;
async function convOf(id, conv) {
  const o = await must(id, "chat_overview");
  return o.conversations.find((c) => c.id === conv) ?? null;
}
async function hasMessage(id, conv, text) {
  const r = await call(id, "chat_messages", { conv, before: null, limit: 100 });
  return r.ok && r.value.messages.some((m) => m.text === text && !m.deleted);
}
const send = (id, conv, text) => call(id, "chat_send", { conv, text, replyTo: null, mentions: [], files: [] });

// Semua laptop yang menyala saling diberi alamat manual (gagal diabaikan: alamat mungkin sudah ada).
async function mesh() {
  if (!MESH) return;
  const live = Object.keys(running);
  for (const a of live) {
    for (const b of live) {
      if (a === b) continue;
      await call(a, "add_manual_address", { address: addr(b) });
    }
  }
}

// Bergabung ke departemen `teamId`: permintaan bergabung lewat alamat A yang disetujui A,
// atau kode undangan. Hasil: "request" atau "invite".
async function joinOffice(id, teamId) {
  await must(id, "save_display_name", { name: NODES[id].name });
  if (JOIN_MODE === "request") {
    try {
      const offices = await waitFor(
        `${id} menemukan kantor lewat alamat A`,
        async () => {
          const list = await must(id, "join_connect_address", { address: addr("A") });
          return list.find((o) => o.name === ORG) ?? null;
        },
        30000,
        2000,
      );
      await must(id, "join_send_request", {
        officeKey: offices.key,
        teamId,
        confirmFingerprint: null,
        note: `Uji divisi ${id}`,
        useAd: false,
      });
      const req = await waitFor(`A melihat permintaan ${NODES[id].name}`, async () => {
        const list = await must("A", "org_join_requests");
        return list.find((r) => r.displayName === NODES[id].name) ?? null;
      }, 40000);
      await must("A", "org_approve_join", { requestId: req.id });
      await waitFor(`${id} disetujui`, async () => {
        const p = await call(id, "join_poll");
        if (p.ok && p.value.status === "rejected") throw new Error("permintaan ditolak");
        return (await must(id, "get_app_state")).organization ? true : null;
      }, 60000, 2000);
      await reload(id);
      return "request";
    } catch (e) {
      console.log(`Catatan: permintaan bergabung ${id} gagal (${String(e.message).split("\n")[0]}), pakai kode undangan.`);
      await call(id, "join_cancel");
      // Permintaan yang tertinggal ditolak supaya batas per IP tidak menghalangi laptop berikutnya.
      const left = await call("A", "org_join_requests");
      if (left.ok) for (const r of left.value) await call("A", "org_reject_join", { requestId: r.id });
    }
  }
  const invite = await must("A", "create_invite", { teamId, role: "member", validity: "24h", projectIds: [] });
  const r = await call(id, "join_with_code", { code: invite.code, address: addr("A") });
  if (!r.ok) throw new Error(`${id} join_with_code: ${JSON.stringify(r.error)}`);
  await reload(id);
  return "invite";
}

// Departemen orang ini di laptop `viewer` sudah `teamId`.
async function inTeam(viewer, key, teamId) {
  const people = await must(viewer, "org_people");
  return people.find((p) => p.publicKey === key)?.departmentId === teamId;
}

// ----- Langkah -----------------------------------------------------------------------
async function scenario(title, fn, { fatal = false } = {}) {
  console.log(`\n--- ${title} ---`);
  try {
    await fn();
  } catch (err) {
    check(`${title}: berjalan tanpa error`, false, String(err?.message ?? err).split("\n")[0].slice(0, 300));
    await errorShots(title.split(".")[0]);
    if (fatal) throw err;
  }
}

async function step1() {
  for (const id of ["A", "B", "C", "D", "E"]) await launch(id);
  for (const id of ["A", "B", "C", "D", "E"]) pk[id] = (await must(id, "get_app_state")).identity.publicKey;
  await must("A", "save_display_name", { name: NODES.A.name });
  await must("A", "create_organization", { name: ORG, adDomain: null });
  ids.IT = (await must("A", "org_create_department", { name: DEPT_IT })).id;
  ids.FIN = (await must("A", "org_create_department", { name: DEPT_FIN })).id;
  await reload("A");
  const depts = await must("A", "org_departments", { includeArchived: false });
  const it = depts.find((d) => d.id === ids.IT);
  ids.itChannelName = it?.channelName ?? "it";
  check("1.1 A membuat kantor dan departemen IT dan Finance", Boolean(ids.IT && ids.FIN), JSON.stringify(depts.map((d) => d.name)));

  for (const [id, team] of [["B", ids.IT], ["C", ids.IT], ["D", ids.IT], ["E", ids.FIN]]) {
    const how = await joinOffice(id, team);
    await mesh();
    const ok = await sync(`A melihat ${id} di departemennya`, ["A", id], () => inTeam("A", pk[id], team), 60000);
    check(`1.2 ${NODES[id].name} bergabung ke ${team === ids.IT ? DEPT_IT : DEPT_FIN} (${how === "request" ? "permintaan bergabung disetujui A" : "kode undangan"})`, ok === true, why(ok));
  }

  await must("A", "org_set_department_admin", { teamId: ids.IT, publicKey: pk.B, admin: true });
  const bAdmin = await sync("B melihat dirinya admin IT", ["B"], async () => {
    const ov = await deptOv("B");
    return ov && ov.teamId === ids.IT && ov.me.isAdmin && ov.canManageDept ? ov : null;
  });
  check("1.3 A menjadikan B admin departemen IT; dept_overview B: canManageDept", okv(bAdmin), why(bAdmin));

  for (const id of ["B", "C", "D", "E"]) {
    const seen = await sync(`${id} melihat semua orang`, [id], async () => {
      const people = await must(id, "org_people");
      return ["A", "B", "C", "D", "E"].every((x) => people.some((p) => p.publicKey === pk[x]));
    });
    check(`1.4 ${id} sudah tersinkron (lima orang di org_people)`, seen === true, why(seen));
  }
}

async function step2() {
  // Gerbang versi terbuka setelah semua laptop melaporkan versinya.
  const gate = await sync("gerbang versi terbuka di B", ["B"], async () => ((await deptOv("B"))?.gate.open ? true : null));
  check("2.1 Gerbang versi terbuka (semua laptop melaporkan versi)", gate === true, why(gate) || `Cargo.toml ${appVersion}`);

  await openMyDept("B");
  const membersText = await mdMembers("B").innerText();
  check(
    "2.2 B membuka Organisasi > Departemen saya: Budi, Citra, Dodi tampil, Eka (Finance) tidak",
    ["B", "C", "D"].every((x) => membersText.includes(NAMES[x])) && !membersText.includes(NAMES.E),
    short(membersText),
  );
  check("2.3 Tab B tidak menampilkan pemberitahuan gerbang versi", (await pg("B").locator("#md-gate").count()) === 0);

  const ui = await viaUi(
    "B membuat divisi Mobile",
    async () => {
      const p = pg("B");
      await p.getByLabel(TXT.id.md.newDivision, { exact: true }).fill(DIV);
      await p.getByRole("button", { name: TXT.id.md.createDivision, exact: true }).click();
      await divisionCard("B", DIV).waitFor({ timeout: 15000 });
    },
    () => must("B", "division_create", { teamId: ids.IT, name: DIV }),
  );
  check("2.4 B membuat divisi Mobile lewat kolom Nama divisi baru", ui);
  const created = await sync("Mobile ada di dept_overview B", ["B"], async () => divisionIn(await deptOv("B"), DIV));
  ids.mobile = created?.id;
  ids.mobileConv = created?.conv ?? (created?.id ? `ch:${created.id}` : null);
  check("2.5 dept_overview B: divisi Mobile ada, conv ch:<id>", okv(created) && ids.mobileConv === `ch:${ids.mobile}`, why(created) || ids.mobileConv);

  const headUi = await viaUi(
    "B menambah C lalu menjadikannya kepala",
    async () => {
      const card = divisionCard("B", DIV);
      await card.getByLabel(TXT.id.md.addLabel(DIV), { exact: true }).selectOption({ label: NAMES.C });
      await card.getByRole("button", { name: TXT.id.md.add, exact: true }).click();
      const headBtn = card.getByRole("button", { name: TXT.id.md.makeHead(NAMES.C, DIV), exact: true });
      await headBtn.waitFor({ timeout: 15000 });
      await headBtn.click();
    },
    () => must("B", "division_set_head", { divisionId: ids.mobile, publicKey: pk.C, head: true }),
  );
  check("2.6 B menambah Citra ke Mobile dan menunjuknya kepala lewat kartu divisi", headUi);
  const cHead = await sync("C kepala Mobile", ["B", "C"], async () => {
    const d = divisionIn(await deptOv("B"), DIV);
    return d?.members.some((m) => m.publicKey === pk.C && m.role === "head") ? true : null;
  });
  check("2.7 dept_overview B: Citra kepala divisi Mobile", cHead === true, why(cHead));
}

async function step3() {
  const cOv = await sync("C melihat Mobile sebagai kepala", ["C"], async () => {
    const ov = await deptOv("C");
    const d = divisionIn(ov, DIV);
    return d && d.canEditMembers && !d.canManage && ov.me.headOf.includes(ids.mobile) ? ov : null;
  });
  check("3.1 dept_overview C: Mobile canEditMembers, bukan canManage", okv(cOv), why(cOv));

  await reload("C");
  await openMyDept("C");
  const card = divisionCard("C", DIV);
  await card.waitFor({ timeout: 15000 });
  check("3.2 C (kepala divisi) melihat tab Departemen saya dengan kartu Mobile", await card.isVisible());

  const addSelect = card.getByLabel(TXT.id.md.addLabel(DIV), { exact: true });
  const options = await soft(addSelect.locator("option").allInnerTexts(), []);
  check("3.3 Pilihan Tambah orang di C memuat Dodi, tidak memuat Eka (Finance)", options.includes(NAMES.D) && !options.includes(NAMES.E), JSON.stringify(options));

  const ui = await viaUi(
    "C menambah D ke Mobile",
    async () => {
      await addSelect.selectOption({ label: NAMES.D });
      await card.getByRole("button", { name: TXT.id.md.add, exact: true }).click();
      await card.locator(".md-person").filter({ hasText: NAMES.D }).waitFor({ timeout: 15000 });
    },
    () => must("C", "division_add_member", { divisionId: ids.mobile, publicKey: pk.D }),
  );
  check("3.4 C menambah Dodi ke Mobile lewat kartu divisi", ui);
  const dIn = await sync("D anggota Mobile di B", ["B", "C"], async () => {
    const d = divisionIn(await deptOv("B"), DIV);
    return d?.members.some((m) => m.publicKey === pk.D && m.role === "member") ? true : null;
  });
  check("3.5 dept_overview B: Dodi anggota Mobile", dIn === true, why(dIn));

  const addE = await call("C", "division_add_member", { divisionId: ids.mobile, publicKey: pk.E });
  check("3.6 C tidak bisa menambah Eka (Finance): division_add_member ditolak", !addE.ok, short(addE.ok ? "diterima" : addE.error));

  const renameBtns = await card.getByRole("button", { name: TXT.id.md.renameAria(DIV), exact: true }).count();
  const archiveBtns = await card.getByRole("button", { name: TXT.id.md.archiveAria(DIV), exact: true }).count();
  check("3.7 Kartu Mobile di C tanpa tombol Ganti nama dan Arsipkan", renameBtns === 0 && archiveBtns === 0, `ganti nama ${renameBtns}, arsip ${archiveBtns}`);
  const ren = await call("C", "division_rename", { divisionId: ids.mobile, name: "Mobile Baru" });
  check("3.8 C tidak bisa mengganti nama lewat command division_rename", !ren.ok, short(ren.ok ? "diterima" : ren.error));
}

async function step4() {
  const dConv = await sync("D punya chat Mobile", ["D"], () => convOf("D", ids.mobileConv), 90000);
  check("4.1 chat_overview D: chat divisi Mobile (bagian Departemen)", okv(dConv) && dConv.section === "departemen", why(dConv) || `${dConv?.kind}/${dConv?.section}`);

  await reload("D");
  await openChat("D");
  const row = chatRow("D", TXT.id.divisionRow(DIV)).first();
  const shown = await soft(waitFor("baris Mobile di sidebar D", () => row.isVisible(), 30000).then(() => true), false);
  check("4.2 Sidebar D menampilkan baris \"Chat divisi Mobile\"", shown);
  const rows = await soft(deptSectionRows("D"), []);
  const iCh = rows.findIndex((l) => TXT.id.channelRow(ids.itChannelName).test(l));
  const iDiv = rows.findIndex((l) => TXT.id.divisionRow(DIV).test(l));
  check("4.3 Baris Mobile tepat di bawah channel IT", iCh >= 0 && iDiv === iCh + 1, JSON.stringify(rows));

  const text = `Halo tim Mobile dari Dodi ${Date.now() % 100000}`;
  const ui = await viaUi(
    "D mengirim pesan di chat Mobile",
    async () => {
      await row.click();
      await sendViaComposer("D", DIV, text);
      await waitFor("pesan D tersimpan", () => hasMessage("D", ids.mobileConv, text), 10000);
    },
    async () => {
      const r = await send("D", ids.mobileConv, text);
      if (!r.ok) throw new Error(`chat_send D: ${JSON.stringify(r.error)}`);
    },
  );
  check("4.4 D mengirim pesan di chat Mobile lewat kolom pesan", ui);
  const cGot = await sync("C menerima pesan D", ["C", "D"], () => hasMessage("C", ids.mobileConv, text), 90000);
  check("4.5 C (kepala Mobile) menerima pesan D", cGot === true, why(cGot));

  await sleep(5000);
  const eConv = await convOf("E", ids.mobileConv);
  const eMsg = await hasMessage("E", ids.mobileConv, text);
  check("4.6 E (Finance) tidak melihat chat Mobile maupun pesannya", eConv === null && !eMsg, eConv ? `${eConv.name}` : "");
  await openChat("E").catch(() => {});
  const eRow = await chatRow("E", TXT.id.divisionRow(DIV)).count().catch(() => -1);
  check("4.7 Sidebar E tanpa baris Chat divisi Mobile", eRow === 0, String(eRow));
}

async function step5() {
  const itConv = (await deptOv("B")).channel.conv;
  ids.itConv = itConv;
  const itTitle = `#${ids.itChannelName}`;

  await reload("B");
  await openMyDept("B");
  const ui = await viaUi(
    "B menyimpan catatan dan mode pengumuman channel IT",
    async () => {
      const sec = mdChannel("B");
      await sec.getByLabel(TXT.id.md.pinned, { exact: true }).fill(NOTE_IT);
      await sec.getByRole("checkbox", { name: TXT.id.md.announce }).check();
      await sec.getByRole("button", { name: TXT.id.md.saveChat, exact: true }).click();
      await waitFor("pengaturan IT tersimpan", async () => {
        const s = (await deptOv("B")).channel.settings;
        return s.pinned === NOTE_IT && s.announce;
      }, 15000);
    },
    () => must("B", "chat_settings_set", { teamId: ids.IT, divisionId: null, pinned: NOTE_IT, announce: true }),
  );
  check("5.1 B menyimpan catatan disematkan dan mode pengumuman di Channel departemen", ui);

  const dSet = await sync("D membaca pengaturan IT", ["D"], async () => {
    const s = await must("D", "conversation_settings", { conv: itConv });
    return s && s.pinned === NOTE_IT && s.announce && !s.canWrite ? s : null;
  });
  check("5.2 conversation_settings D (#it): catatan, announce, canWrite false", okv(dSet), why(dSet));

  await reload("D");
  await openConversation("D", TXT.id.channelRow(ids.itChannelName));
  const aside = pg("D").getByRole("complementary", { name: TXT.id.pinnedAside });
  const noteShown = await soft(waitFor("catatan tampil di D", async () => (await aside.innerText()).includes(NOTE_IT), 20000).then(() => true), false);
  check("5.3 D melihat banner catatan disematkan di atas #it", noteShown);
  const gateText = await soft(pg("D").locator(".conv-blocked").innerText({ timeout: 10000 }), "");
  const dComposer = await pg("D").getByRole("combobox", { name: TXT.id.composer(itTitle), exact: true }).count();
  check("5.4 D melihat kalimat mode pengumuman, bukan kolom pesan", gateText.includes(TXT.id.gateTeam) && dComposer === 0, `${short(gateText, 120)} / kolom ${dComposer}`);

  const dText = `Dodi mencoba menulis di #it ${Date.now() % 100000}`;
  const dSend = await send("D", itConv, dText);
  let dRefused = !dSend.ok;
  if (dSend.ok) {
    await sleep(10000);
    dRefused = !(await hasMessage("B", itConv, dText));
  }
  check("5.5 Pesan D di #it ditolak (atau tidak sampai ke B)", dRefused, dSend.ok ? "chat_send D diterima di laptopnya sendiri" : short(dSend.error));

  const bText = `Pengumuman dari Budi ${Date.now() % 100000}`;
  const bUi = await viaUi(
    "B menulis di #it",
    async () => {
      await openConversation("B", TXT.id.channelRow(ids.itChannelName));
      await sendViaComposer("B", itTitle, bText);
      await waitFor("pesan B tersimpan", () => hasMessage("B", itConv, bText), 10000);
    },
    async () => {
      const r = await send("B", itConv, bText);
      if (!r.ok) throw new Error(`chat_send B: ${JSON.stringify(r.error)}`);
    },
  );
  check("5.6 B (admin) masih bisa menulis di #it lewat kolom pesan", bUi);
  const dGot = await sync("D menerima pengumuman B", ["B", "D"], () => hasMessage("D", itConv, bText));
  check("5.7 D menerima pengumuman B", dGot === true, why(dGot));

  // Kepala divisi mengatur chat divisinya (untuk screenshot chat divisi dengan catatan).
  await reload("C");
  await openMyDept("C");
  const cUi = await viaUi(
    "C menyematkan catatan di chat Mobile",
    async () => {
      const card = divisionCard("C", DIV);
      await card.locator("details.md-div-chat > summary").click();
      await card.getByLabel(TXT.id.md.pinned, { exact: true }).fill(NOTE_MOBILE);
      await card.getByRole("button", { name: TXT.id.md.saveChat, exact: true }).click();
      await waitFor("catatan Mobile tersimpan", async () => divisionIn(await deptOv("C"), DIV)?.settings.pinned === NOTE_MOBILE, 15000);
    },
    () => must("C", "chat_settings_set", { teamId: ids.IT, divisionId: ids.mobile, pinned: NOTE_MOBILE, announce: false }),
  );
  check("5.8 C (kepala) menyematkan catatan di chat Mobile lewat kartu divisi", cUi);
  const dMob = await sync("D membaca catatan Mobile", ["D"], async () => {
    const s = await must("D", "conversation_settings", { conv: ids.mobileConv });
    return s?.pinned === NOTE_MOBILE && s.canWrite ? s : null;
  });
  check("5.9 conversation_settings D (Mobile): catatan C, D tetap bisa menulis", okv(dMob), why(dMob));
}

async function step6() {
  let dlgUsed = false;
  const ui = await viaUi(
    "C membuat proyek divisi dari dialog Proyek baru",
    async () => {
      await reload("C");
      const dlg = await openNewProject("C");
      if (!dlg) throw new Error("tombol Proyek baru tidak tampil untuk kepala divisi");
      dlgUsed = true;
      await dlg.getByLabel(TXT.id.forDivision, { exact: true }).selectOption({ label: TXT.id.divisionOption(DIV, DEPT_IT) });
      await dlg.getByLabel(TXT.id.projectName, { exact: true }).fill(PROJECT.name);
      await dlg.getByLabel(TXT.id.projectCode, { exact: true }).fill(PROJECT.code);
      await dlg.getByRole("button", { name: TXT.id.createProject, exact: true }).click();
      await dlg.waitFor({ state: "detached", timeout: 15000 });
    },
    async () => {
      if (dlgUsed) await closeDialog("C");
      const r = await call("C", "board_create_project", { name: PROJECT.name, code: PROJECT.code, teamId: ids.IT, members: [], divisionId: ids.mobile });
      if (!r.ok) console.log(`Catatan: board_create_project C juga ditolak: ${JSON.stringify(r.error)}`);
    },
  );
  check("6.1 C membuat proyek untuk divisi Mobile lewat dialog Proyek baru (pilihan Untuk divisi)", ui);
  const cProj = await sync("proyek divisi ada di C", ["C"], async () => {
    const list = await must("C", "board_list_projects");
    return list.find((p) => p.name === PROJECT.name) ?? null;
  }, 30000);
  ids.project = cProj?.id;
  check("6.2 board_list_projects C: proyek bertanda divisi Mobile", okv(cProj) && cProj.divisionId === ids.mobile, why(cProj) || `${cProj?.divisionId} / ${cProj?.divisionName}`);
  const dProj = await sync("D melihat proyek", ["C", "D"], async () => {
    const list = await must("D", "board_list_projects");
    return list.find((p) => p.name === PROJECT.name) ?? null;
  });
  check("6.3 D (anggota Mobile) melihat proyek itu sebagai anggota", okv(dProj), why(dProj));
  const bProj = await sync("proyek di dept_overview B", ["B"], async () => (await deptOv("B")).projects.find((p) => p.name === PROJECT.name) ?? null);
  check(
    "6.4 dept_overview B: proyek bernama divisi Mobile, anggota memuat Citra dan Dodi",
    okv(bProj) && bProj.divisionName === DIV && [pk.C, pk.D].every((k) => bProj.members.some((m) => m.publicKey === k)),
    why(bProj) || short(bProj),
  );
}

// Screenshot tab, kartu divisi, chat divisi dengan catatan, gerbang pengumuman, dialog Proyek baru;
// terang dan gelap, Indonesia dan Inggris. Hanya kalau E2E_SHOTS=1.
async function shotPhase() {
  if (!SHOTS_ON) return;
  const variants = [
    ["light", "id", "terang-id"],
    ["dark", "id", "gelap-id"],
    ["light", "en", "terang-en"],
    ["dark", "en", "gelap-en"],
  ];
  // Dialog Proyek baru dibuka di laptop kepala divisi; kalau tombolnya tidak ada di sana, di B (admin).
  const projectHost = "C";
  for (const [theme, to, suffix] of variants) {
    const files = [];
    for (const id of ["B", "C", "D"]) await setLook(id, theme, to);
    try {
      await openMyDept("B");
      await divisionCard("B", DIV).waitFor({ timeout: 15000 });
      files.push(await snap("B", `departemen-saya-${suffix}`));
      files.push(await snap("B", `kartu-divisi-${suffix}`, divisionCard("B", DIV)));

      await openConversation("D", L("D").divisionRow(DIV), 30000);
      await pg("D").locator("aside.pin-note").waitFor({ timeout: 15000 });
      files.push(await snap("D", `chat-divisi-catatan-${suffix}`));
      await openConversation("D", L("D").channelRow(ids.itChannelName), 30000);
      await pg("D").locator(".conv-blocked").waitFor({ timeout: 15000 });
      files.push(await snap("D", `gerbang-pengumuman-${suffix}`));

      let host = projectHost;
      let dlg = await openNewProject(host);
      if (!dlg && host !== "B") {
        host = "B";
        dlg = await openNewProject("B");
      }
      if (dlg) {
        await dlg.getByLabel(L(host).forDivision, { exact: true }).selectOption({ label: L(host).divisionOption(DIV, DEPT_IT) });
        await dlg.getByLabel(L(host).projectName, { exact: true }).fill(to === "en" ? "Android release" : "Rilis Android");
        files.push(await snap(host, `proyek-baru-divisi-${suffix}`));
        await closeDialog(host);
      }
    } catch (e) {
      console.log(`Catatan: screenshot ${suffix} terhenti: ${e.message.split("\n")[0]}`);
    }
    const saved = files.filter(Boolean);
    check(`S Screenshot ${suffix}: 5 berkas (tab, kartu, chat divisi, gerbang pengumuman, Proyek baru)`, saved.length === 5, saved.join(", "));
  }
  for (const id of ["B", "C", "D"]) await setLook(id, "light", "id");
}

async function step7() {
  await reload("B");
  await openMyDept("B");
  const promote = await viaUi(
    "B mengangkat D menjadi admin",
    async () => {
      await mdMembers("B").getByRole("button", { name: TXT.id.md.makeAdmin(NAMES.D), exact: true }).click();
      await waitFor("D admin", async () => memberIn(await deptOv("B"), pk.D)?.isAdmin, 15000);
    },
    () => must("B", "dept_set_admin", { teamId: ids.IT, publicKey: pk.D, admin: true }),
  );
  check("7.1 B menjadikan Dodi admin departemen lewat tombol Jadikan admin", promote);
  const dAdmin = await sync("D admin di dept_overview B", ["B"], async () => memberIn(await deptOv("B"), pk.D)?.isAdmin === true);
  check("7.2 dept_overview B: Dodi admin departemen", dAdmin === true, why(dAdmin));

  const demote = await viaUi(
    "B melepas D dari admin",
    async () => {
      const btn = mdMembers("B").getByRole("button", { name: TXT.id.md.removeAdmin(NAMES.D), exact: true });
      await btn.waitFor({ timeout: 15000 });
      await btn.click();
      await pg("B").getByRole("button", { name: TXT.id.md.confirmRemoveAdmin, exact: true }).click();
      await waitFor("D bukan admin", async () => memberIn(await deptOv("B"), pk.D)?.isAdmin === false, 15000);
    },
    () => must("B", "dept_set_admin", { teamId: ids.IT, publicKey: pk.D, admin: false }),
  );
  check("7.3 B melepas Dodi dari admin lewat Lepas admin dan konfirmasi", demote);

  const hist = await sync("riwayat admin memuat dua kejadian", ["B"], async () => {
    const h = (await deptOv("B")).adminHistory;
    const made = h.find((e) => e.admin && e.targetName === NAMES.D && e.byName === NAMES.B && e.status === "applied");
    const removed = h.find((e) => !e.admin && e.targetName === NAMES.D && e.byName === NAMES.B && e.status === "applied");
    return made && removed ? h : null;
  }, 30000);
  check("7.4 dept_overview B: riwayat admin memuat angkat dan lepas Dodi oleh Budi", okv(hist), why(hist));
  // Riwayat admin dilipat (details tertutup): buka dulu supaya isinya ikut innerText.
  await soft(mdHistory("B").locator("details").evaluate((d) => { d.open = true; }));
  const histText = await soft(mdHistory("B").innerText({ timeout: 10000 }), "");
  check(
    "7.5 Bagian Riwayat admin di layar B menampilkan kedua kejadian",
    histText.includes(TXT.id.md.historyMade(NAMES.B, NAMES.D)) && histText.includes(TXT.id.md.historyRemoved(NAMES.B, NAMES.D)),
    short(histText),
  );

  // B admin satu-satunya: melepas diri sendiri ditolak dan error tampil.
  let selfShown = false;
  try {
    const btn = mdMembers("B").getByRole("button", { name: TXT.id.md.removeAdmin(NAMES.B), exact: true });
    await btn.click({ timeout: 10000 });
    await pg("B").getByRole("button", { name: TXT.id.md.confirmRemoveAdmin, exact: true }).click();
    selfShown = await soft(
      waitFor("error tampil", async () => (await orgLive("B").innerText()).includes(TXT.id.md.removeAdminFail), 15000, 300).then(() => true),
      false,
    );
  } catch (e) {
    console.log(`Catatan: B melepas diri lewat layar gagal: ${e.message.split("\n")[0]}`);
  }
  const liveText = await soft(orgLive("B").innerText(), "");
  check("7.6 B (admin terakhir) melepas diri sendiri: error \"Admin departemen belum dilepas\" tampil", selfShown, short(liveText));
  const selfCmd = await call("B", "dept_set_admin", { teamId: ids.IT, publicKey: pk.B, admin: false });
  check("7.7 dept_set_admin B atas dirinya ditolak (last_team_admin)", !selfCmd.ok && /last_team_admin|minimal satu admin/i.test(JSON.stringify(selfCmd.error)), short(selfCmd.ok ? "diterima" : selfCmd.error));
  const stillAdmin = memberIn(await deptOv("A", ids.IT), pk.B)?.isAdmin;
  check("7.8 B tetap admin IT setelah percobaan itu", stillAdmin === true);

  const aCmd = await call("A", "dept_set_admin", { teamId: ids.IT, publicKey: pk.B, admin: false });
  const bGone = aCmd.ok
    ? await sync("B bukan admin di A", ["A"], async () => memberIn(await deptOv("A", ids.IT), pk.B)?.isAdmin === false, 30000)
    : { failed: short(aCmd.error) };
  check("7.9 A (superadmin) boleh melepas admin terakhir IT", bGone === true, why(bGone));
  await must("A", "org_set_department_admin", { teamId: ids.IT, publicKey: pk.B, admin: true });
  const bBack = await sync("B admin lagi", ["A", "B"], async () => (await deptOv("B"))?.canManageDept === true);
  check("7.10 A mengangkat B lagi, B kembali mengelola IT", bBack === true, why(bBack));
}

async function step8() {
  await reload("A");
  const ui = await viaUi(
    "A memindahkan D ke Finance",
    async () => {
      await openOrgTab("A", TXT.id.tabUsers);
      const p = pg("A");
      await p.getByRole("button", { name: TXT.id.users.actions(NAMES.D), exact: true }).click({ timeout: 15000 });
      await p.getByRole("menuitem", { name: TXT.id.users.move, exact: true }).click();
      const dlg = p.getByRole("dialog");
      await dlg.getByLabel(TXT.id.users.moveTo).selectOption({ label: DEPT_FIN });
      await dlg.getByRole("button", { name: TXT.id.users.moveBtn, exact: true }).click();
      await dlg.waitFor({ state: "detached", timeout: 15000 });
    },
    () => must("A", "org_move_member", { publicKey: pk.D, teamId: ids.FIN }),
  );
  check("8.1 A memindahkan Dodi ke Finance lewat Pengguna > Ubah departemen", ui);
  const moved = await sync("D di Finance", ["A", "D"], () => inTeam("D", pk.D, ids.FIN));
  check("8.2 org_people D: Dodi sekarang di Finance", moved === true, why(moved));
  const out = await sync("D keluar dari Mobile di B", ["B"], async () => {
    const ov = await deptOv("B");
    const d = divisionIn(ov, DIV);
    return d && !d.members.some((m) => m.publicKey === pk.D) && !memberIn(ov, pk.D) ? true : null;
  });
  check("8.3 dept_overview B: Dodi hilang dari Mobile dan dari anggota IT", out === true, why(out));
  const lost = await sync("D kehilangan chat Mobile", ["D"], async () => {
    const c = await convOf("D", ids.mobileConv);
    return c === null || c.former ? (c ? "former" : "hilang") : null;
  });
  check("8.4 chat_overview D: chat Mobile hilang atau bukan anggota lagi", okv(lost), why(lost) || String(lost));
  const later = `Pesan setelah Dodi pindah ${Date.now() % 100000}`;
  await send("C", ids.mobileConv, later);
  await sleep(10000);
  check("8.5 Pesan baru di Mobile tidak sampai ke D", !(await hasMessage("D", ids.mobileConv, later)));
}

async function step9() {
  await launch("F", { env: { MIRA_TEST_APP_VERSION: OLD_VERSION } });
  pk.F = (await must("F", "get_app_state")).identity.publicKey;
  const how = await joinOffice("F", ids.IT);
  await mesh();
  const fIn = await sync("F di IT", ["A", "F"], () => inTeam("A", pk.F, ids.IT), 60000);
  check(`9.1 Fajar (Mira ${OLD_VERSION}) bergabung ke IT (${how === "request" ? "permintaan bergabung" : "kode undangan"})`, fIn === true, why(fIn));
  const fVer = await sync("A melihat versi F", ["A"], async () => {
    const u = (await must("A", "org_users")).find((x) => x.publicKey === pk.F);
    return u?.device?.appVersion ?? null;
  }, 60000);
  check(`9.2 org_users A: versi Mira Fajar ${OLD_VERSION} (MIRA_TEST_APP_VERSION berlaku)`, fVer === OLD_VERSION, String(why(fVer) || fVer));

  const closed = await sync("gerbang tertutup di B", ["B"], async () => {
    const g = (await deptOv("B")).gate;
    return !g.open && g.blockers.some((b) => b.publicKey === pk.F) ? g : null;
  });
  check("9.3 dept_overview B: gerbang tertutup, Fajar tercatat sebagai penghambat", okv(closed), why(closed) || short(closed?.blockers));

  await reload("B");
  await openMyDept("B");
  const notice = pg("B").locator("#md-gate");
  const noticeText = await soft(notice.innerText({ timeout: 15000 }), "");
  check(
    `9.4 Tab B menampilkan pemberitahuan gerbang dan "${TXT.id.md.gateBlocker(NAMES.F, OLD_VERSION)}"`,
    noticeText.includes(TXT.id.md.gateTitle) && noticeText.includes(TXT.id.md.gateBlocker(NAMES.F, OLD_VERSION)),
    short(noticeText),
  );
  const input = pg("B").getByLabel(TXT.id.md.newDivision, { exact: true });
  const createBtn = pg("B").getByRole("button", { name: TXT.id.md.createDivision, exact: true });
  const disabled = (await soft(input.isDisabled(), false)) && (await soft(createBtn.isDisabled(), false));
  check("9.5 Kolom dan tombol Buat divisi nonaktif selama gerbang tertutup", disabled);
  await snap("B", "gerbang-versi-tertutup-terang-id");
  const refused = await call("B", "division_create", { teamId: ids.IT, name: "Web" });
  check("9.6 division_create B ditolak selama gerbang tertutup", !refused.ok, short(refused.ok ? "diterima" : refused.error));

  const umum = (await must("F", "chat_overview")).conversations.find((c) => c.isUmum);
  const fText = `Halo dari laptop lama Fajar ${Date.now() % 100000}`;
  const fSend = umum ? await send("F", umum.id, fText) : { ok: false, error: "#umum tidak ada di F" };
  check("9.7 F (laptop lama) mengirim pesan di #umum", fSend.ok, fSend.ok ? "" : short(fSend.error));
  const aGot = umum ? await sync("A menerima pesan F", ["A", "F"], () => hasMessage("A", umum.id, fText)) : { failed: "tanpa #umum" };
  check("9.8 A menerima pesan F di #umum", aGot === true, why(aGot));
  const fBoard = await call("F", "board_list_projects");
  let boardUi = false;
  if (fBoard.ok) boardUi = await soft(openBoard("F").then(() => true), false);
  check("9.9 Board F tetap bisa dibuka (board_list_projects dan layar Board)", fBoard.ok && boardUi, fBoard.ok ? "" : short(fBoard.error));

  // F memperbarui Mira: dijalankan ulang tanpa versi tiruan, gerbang terbuka lagi untuk langkah 10.
  await stop("F");
  await launch("F");
  await mesh();
  let reopened = await sync("gerbang terbuka lagi", ["B", "F"], async () => ((await deptOv("B")).gate.open ? true : null), 90000);
  check("9.10 Setelah Fajar memakai Mira terbaru, gerbang terbuka lagi", reopened === true, why(reopened));
  if (reopened !== true) {
    console.log("Catatan: Fajar dikeluarkan supaya langkah 10 bisa berjalan.");
    await call("A", "remove_member", { publicKey: pk.F });
    reopened = await sync("gerbang terbuka setelah F dikeluarkan", ["B"], async () => ((await deptOv("B")).gate.open ? true : null), 60000);
  }
}

async function step10() {
  await reload("B");
  await openMyDept("B");
  const ui = await viaUi(
    "B mengarsipkan Mobile",
    async () => {
      const card = divisionCard("B", DIV);
      await card.getByRole("button", { name: TXT.id.md.archiveAria(DIV), exact: true }).click({ timeout: 15000 });
      await pg("B").getByRole("button", { name: TXT.id.md.archiveConfirm(DIV), exact: true }).click();
      await waitFor("Mobile diarsipkan", async () => divisionIn(await deptOv("B"), DIV)?.archived === true, 15000);
    },
    () => must("B", "division_archive", { divisionId: ids.mobile, archived: true }),
  );
  check("10.1 B mengarsipkan Mobile lewat Arsipkan dan konfirmasi", ui);
  const cConv = await sync("chat Mobile hanya baca di C", ["C"], async () => {
    const c = await convOf("C", ids.mobileConv);
    return c && c.archived && !c.canPost ? c : null;
  });
  check("10.2 chat_overview C: chat Mobile diarsipkan, canPost false", okv(cConv), why(cConv));
  const cText = `Citra menulis setelah arsip ${Date.now() % 100000}`;
  const cSend = await send("C", ids.mobileConv, cText);
  check("10.3 chat_send C di chat Mobile yang diarsipkan ditolak", !cSend.ok, cSend.ok ? "diterima" : short(cSend.error));

  await reload("C");
  let noComposer = false;
  try {
    await openConversation("C", TXT.id.divisionRow(DIV), 30000);
    await sleep(1000);
    noComposer = (await pg("C").getByRole("combobox", { name: TXT.id.composer(DIV), exact: true }).count()) === 0;
  } catch (e) {
    console.log(`Catatan: chat Mobile di C tidak bisa dibuka: ${e.message.split("\n")[0]}`);
  }
  check("10.4 Layar C: chat Mobile tanpa kolom pesan (hanya baca)", noComposer);
  await snap("C", "chat-divisi-diarsipkan-terang-id");
}

// ----- Jalankan dan bersihkan -----------------------------------------------------------
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
  if (KEEP) console.log(`Data uji disimpan (E2E_KEEP=1): ${root}`);
  else rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
process.once("SIGINT", () => {
  console.log("\nDihentikan: membersihkan instance uji...");
  void cleanup().finally(() => process.exit(130));
});

async function main() {
  if (!existsSync(exe)) throw new Error(`mira.exe tidak ada: ${exe}`);
  mkdirSync(root, { recursive: true });
  if (SHOTS_ON) mkdirSync(shots, { recursive: true });
  console.log(
    `mira.exe: ${exe}\nData uji: ${root}\nScreenshot: ${SHOTS_ON ? shots : "mati (E2E_SHOTS=1 untuk menyimpan)"}\n` +
      `Port QUIC ${NODES.A.port}-${NODES.F.port}, CDP ${NODES.A.cdp}-${NODES.F.cdp} (E2E_PORT_OFFSET ${OFF})\n` +
      `mDNS ${MDNS ? "nyala" : "mati"}, alamat manual ${MESH ? "nyala" : "mati"}, bergabung lewat ${JOIN_MODE}, versi Cargo.toml ${appVersion}`,
  );
  await scenario("1. Kantor, departemen IT dan Finance, orang bergabung, B admin IT", step1, { fatal: true });
  await scenario("2. B membuat divisi Mobile dan menunjuk C kepala", step2, { fatal: true });
  await scenario("3. C (kepala) mengatur anggota Mobile", step3);
  await scenario("4. Chat divisi Mobile", step4);
  await scenario("5. Catatan disematkan dan mode pengumuman", step5);
  await scenario("6. Proyek divisi dari dialog Proyek baru", step6);
  await scenario("S. Screenshot", shotPhase);
  await scenario("7. Angkat dan lepas admin departemen, riwayat", step7);
  await scenario("8. D pindah ke Finance", step8);
  await scenario("9. Laptop lama F dan gerbang versi", step9);
  await scenario("10. Mobile diarsipkan", step10);
}

try {
  await main();
} catch (err) {
  console.log(`Skrip berhenti: ${String(err?.message ?? err).split("\n")[0]}`);
}
await cleanup();

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} lulus.`);
if (failed) {
  console.log("Yang gagal:");
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
}
process.exit(failed || results.length === 0 ? 1 : 0);
