// Uji ujung ke ujung fitur Kopi (reputasi positif, docs/plans/kopi.md) antar dua
// "laptop" Mira di satu PC, lewat transport jaringan sungguhan (QUIC di 127.0.0.1, mDNS).
//
// Pola sama dengan board-v04-multi-e2e.mjs: dua instance mira.exe, masing-masing dengan
// folder data (MIRA_DATA_DIR), port QUIC (MIRA_PORT), dan port debug WebView2 sendiri,
// dikendalikan lewat Chrome DevTools Protocol. Persiapan (kantor, proyek, task) lewat
// command Tauri (IPC); pemberian Kopi dari pesan, profil, detail task, dan sakelar di
// Organisasi lewat tampilan sungguhan.
//
//   A  Ayu   superadmin, membuat kantor, departemen, proyek, dan task
//   B  Budi  bergabung dengan kode undangan A, anggota proyek
//
// Langkah:
//   1. Persiapan: kantor, B bergabung, proyek berisi A dan B.
//   2. B mengirim pesan di #umum. A: klik kanan pesan, "Beri kopi", alasan, Kirim kopi.
//      B: kopi_profile = 1 Kopi rekan dari Ayu dengan alasan itu. Item menu jadi nonaktif.
//   3. A membuat task untuk B, B memindahkan ke Selesai: Kopi kerja 1 (assigned) di A dan B.
//      Screenshot detail task di A dengan tombol "Terima kasih ke Budi Uji", profil B.
//   4. Task dibuka lagi (Dikerjakan): Kopi kerja kembali 0 di A dan B.
//   5. Batas harian: A memberi sampai 3 hari ini, pemberian ke-4 ditolak.
//   6. A mematikan fitur lewat Organisasi > Kopi (kotak centang + konfirmasi). B: fitur mati,
//      item "Beri kopi" hilang, kopi_give ditolak. Lalu dinyalakan lagi.
//   7. Versi Inggris profil dan panel.
//
// Pakai:  node scripts/kopi-e2e.mjs <path mira.exe> <folder screenshot> [folder induk data]
// Folder data dibuat di bawah folder induk (bawaan: env TMP) dan dihapus di akhir.
// E2E_PORT_OFFSET menggeser semua port supaya bisa jalan berdampingan dengan uji lain.

import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { mainNav, menuName } from "./e2e-onboarding.mjs";

const exe = resolve(process.argv[2] ?? "src-tauri/target/debug/mira.exe");
const shots = resolve(process.argv[3] ?? "docs/progress/screenshots/kopi");
const parent = resolve(process.argv[4] ?? process.env.TMP ?? process.env.TEMP ?? tmpdir());
mkdirSync(shots, { recursive: true });
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, "mira-kopi-"));

const PORT_OFFSET = Number(process.env.E2E_PORT_OFFSET ?? 0) || 0;
const NODES = {
  A: { name: "Ayu Uji", port: 47921 + PORT_OFFSET, cdp: 9421 + PORT_OFFSET, dir: join(root, "laptop-a") },
  B: { name: "Budi Uji", port: 47922 + PORT_OFFSET, cdp: 9422 + PORT_OFFSET, dir: join(root, "laptop-b") },
};
const addr = (id) => `127.0.0.1:${NODES[id].port}`;
// Sinkron berjalan saat ada perubahan, ditambah cadangan berkala 60 detik; board polling 15 detik.
const SYNC_MS = 150000;
// useKopi memuat ulang saat ada event fitur, ditambah polling 60 detik.
const UI_MS = 90000;

const ORG = "Kantor Uji Kopi";
const DEPT = "Desain";
const PROJECT = "Proyek Brosur Kopi";
const PROJECT_CODE = "BK";
const TASK = "Susun brosur pameran 2027";
const TEXT = {
  b1: "Gambar kerja lantai dua sudah saya cek, ada dua catatan kecil.",
  b2: "Daftar vendor kursi sudah saya kirim ke grup.",
  b3: "Notulen rapat Senin sudah ada di Dokumen.",
  b4: "Foto lokasi pameran sudah saya unggah.",
  a1: "Terima kasih semua, besok kita lanjut rapat jam sembilan.",
};
const REASON = "Terima kasih sudah mengecek gambar kerja lantai dua.";

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function miraCredentials() {
  try {
    const out = execFileSync("cmdkey", ["/list"], { encoding: "utf8" });
    return new Set(out.match(/device-key-[0-9a-f]{64}\.id\.mira\.desktop/g) ?? []);
  } catch {
    return new Set();
  }
}
const credentialsBefore = miraCredentials();
// Kunci laptop uji milik skrip ini. Di akhir hanya kunci ini yang dihapus, supaya kunci
// uji lain yang berjalan bersamaan tidak ikut hilang (lihat e2e-fitur-multi.mjs).
const ownKeys = new Set();
const keyTarget = (publicKey) => `device-key-${publicKey}.id.mira.desktop`;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "LULUS" : "GAGAL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const note = (msg) => console.log(`CATATAN  ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const secs = (since) => `${Math.round((Date.now() - since) / 1000)} dtk`;

const running = {};
// Semua proses mira.exe yang dijalankan skrip ini, juga yang gagal di tengah launch,
// supaya di akhir semuanya dihentikan sebelum folder data dihapus.
const spawned = new Set();
function killTree(pid) {
  try {
    // Hanya pohon proses yang dijalankan skrip ini.
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* sudah berhenti */
  }
}

async function launch(id) {
  const node = NODES[id];
  mkdirSync(node.dir, { recursive: true });
  const log = createWriteStream(join(root, `${id}-stderr.log`), { flags: "a" });
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      MIRA_DATA_DIR: node.dir,
      MIRA_PORT: String(node.port),
      // Cek pembaruan diarahkan ke alamat mati: tidak ada panggilan internet atau dialog pembaruan.
      MIRA_UPDATER_ENDPOINT: "http://127.0.0.1:9/latest.json",
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${node.cdp}`,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.pipe(log);
  spawned.add(child);
  child.on("exit", () => spawned.delete(child));
  // Build debug butuh sekitar 20 detik sebelum WebView2 meninggalkan about:blank. Sambung CDP
  // setelah halaman aplikasi ada, supaya Playwright tidak memegang target about:blank yang lama.
  let appUrl = null;
  for (let i = 0; i < 120 && !appUrl; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${node.cdp}/json/list`)).json();
      appUrl = list.find((t) => t.type === "page" && /^(https?:\/\/tauri\.localhost|tauri:)/.test(t.url))?.url ?? null;
    } catch {
      /* belum siap */
    }
  }
  if (!appUrl) note(`${id}: halaman aplikasi belum terlihat di /json/list setelah 60 detik`);
  // Halaman aplikasi: yang punya __TAURI_INTERNALS__. Kadang Playwright hanya melihat target
  // about:blank yang lama; kalau begitu sambungan CDP ditutup dan dibuka lagi (paling banyak 5 kali).
  let browser;
  let page;
  const seen = new Set();
  for (let attempt = 0; attempt < 5 && !page; attempt++) {
    browser = null;
    for (let i = 0; i < 80 && !browser; i++) {
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${node.cdp}`);
      } catch {
        await sleep(500);
      }
    }
    if (!browser) break;
    for (let i = 0; i < 30 && !page; i++) {
      for (const p of browser.contexts().flatMap((c) => c.pages())) {
        seen.add(p.url());
        const ok = await Promise.race([
          p.evaluate(() => "__TAURI_INTERNALS__" in window).catch(() => false),
          sleep(3000).then(() => false),
        ]);
        if (ok) {
          page = p;
          break;
        }
      }
      if (!page) await sleep(500);
    }
    if (!page) {
      await browser.close().catch(() => {});
      await sleep(1000);
    }
  }
  if (!page) {
    let targets = "";
    try {
      const list = await (await fetch(`http://127.0.0.1:${node.cdp}/json/list`)).json();
      targets = list.map((t) => `${t.type}:${t.url}`).join(", ");
    } catch {
      targets = "tidak terbaca";
    }
    if (browser) await browser.close().catch(() => {});
    killTree(child.pid);
    throw new Error(`Halaman Mira ${id} tidak siap (CDP ${node.cdp}, halaman Playwright: ${[...seen].join(", ") || "tidak ada"}; /json/list: ${targets})`);
  }
  const consoleLines = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") consoleLines.push(`[${m.type()}] ${m.text()}`);
  });
  await page.waitForLoadState("domcontentloaded");
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  running[id] = { child, browser, page, consoleLines };
  return running[id];
}

async function stop(id) {
  const app = running[id];
  if (!app) return;
  delete running[id];
  await app.browser.close().catch(() => {});
  killTree(app.child.pid);
  await sleep(1500);
}

// Memanggil command Tauri di instance `id`. Hasil: { ok, value } atau { ok: false, error }.
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
async function waitFor(desc, fn, timeoutMs = SYNC_MS, everyMs = 1000) {
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
// Seperti waitFor, tapi kegagalan dikembalikan sebagai teks, bukan dilempar.
const settle = (desc, fn, timeoutMs, everyMs) => waitFor(desc, fn, timeoutMs, everyMs).catch((e) => String(e.message));
// Satu bagian uji. Error di dalamnya dicatat GAGAL, bagian berikutnya tetap jalan.
async function section(name, fn) {
  try {
    await fn();
  } catch (err) {
    check(`${name}: berjalan tanpa error`, false, String(err?.message ?? err).slice(0, 400));
    for (const id of Object.keys(running)) {
      await shot(id, `kopi-gagal-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${id.toLowerCase()}.png`);
    }
  }
}

const page = (id) => running[id].page;
const shot = (id, name) => page(id).screenshot({ path: join(shots, name) }).catch(() => {});
const onlineNames = async (id) =>
  (await must(id, "get_network_status")).peers.filter((p) => p.online).map((p) => p.displayName).sort();
async function waitOnline(desc) {
  for (const id of ["A", "B"]) {
    const other = NODES[id === "A" ? "B" : "A"].name;
    await waitFor(`${desc}: ${id} melihat ${other} online`, async () => (await onlineNames(id)).includes(other));
  }
}
const errText = (r) => (r.ok ? "malah berhasil" : `${r.error?.code ?? ""}: ${r.error?.message ?? JSON.stringify(r.error)}`.slice(0, 200));

// ---- Data ----
const pk = {};
const umum = {}; // id #umum per laptop
const msg = {}; // id pesan per kunci TEXT
let projectId = null;
let taskId = null;

// Offset zona waktu laptop dalam menit timur UTC, sama dengan localOffsetMinutes di src/api/kopi.ts.
const offsetMinutes = () => -new Date().getTimezoneOffset();
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const overview = (id) => must(id, "kopi_overview", { offsetMinutes: offsetMinutes() });
const profile = (id, who) => must(id, "kopi_profile", { publicKey: pk[who] });
const give = (id, to, target, reason) =>
  call(id, "kopi_give", { input: { to: pk[to], target, reason }, offsetMinutes: offsetMinutes() });
const workEntries = (p) => p.history.filter((e) => e.kind === "work");
const peerEntries = (p) => p.history.filter((e) => e.kind === "peer");
const describeProfile = (p) =>
  p ? `rekan=${p.peer}, kerja=${p.work}, skor=${p.score}, tingkatan=${p.tier}, riwayat=${p.history.length}` : "tidak terbaca";

async function messagesIn(id) {
  const r = await call(id, "chat_messages", { conv: umum[id], before: null, limit: 100 });
  return r.ok ? r.value.messages : [];
}
const getTask = async (id) => {
  const r = await call(id, "board_get_task", { projectId, taskId });
  return r.ok ? r.value : null;
};
const columnOf = (t) => t?.columnId ?? t?.statusTime?.currentColumn ?? null;

// ---- Layar ----
const chatList = (p) => p.getByRole("navigation", { name: /Daftar percakapan/i });
const umumRow = (p) => chatList(p).getByRole("button", { name: /^Channel umum(,|$)/ });
const composer = (p) => p.getByRole("combobox", { name: /^Pesan untuk/ });
const msgLi = (p, id) => p.locator(`li[id="conv-msg-${id}"]`);
const msgMenu = (p) => p.getByRole("menu", { name: /^Aksi untuk pesan / });
const kopiItem = (menu) => menu.locator('[data-menu-item="kopi"]');
const giveDialog = (p, name) => p.getByRole("dialog", { name: `Beri kopi untuk ${name}` });
// Dialog profil yang sudah memuat bagian Kopi (KopiProfileSection), bahasa apa pun.
const profileDialog = (p) => p.getByRole("dialog").filter({ has: p.locator("section.kopi-prof") });
const projectNav = (p) => p.getByRole("navigation", { name: "Task saya dan proyek" });
const taskDialog = (p) =>
  p.getByRole("dialog").filter({ has: p.getByRole("button", { name: "Tutup detail task" }) });
const orgTab = (p) => p.locator(".org-tabs-wrap").getByRole("button", { name: /^(Kopi|Coffee)(\s|,|$)/ });
// Kotak centang biasa berlabel "Fitur Kopi" (EN "Coffee"); tercentang baru berubah setelah tersimpan.
const featureSwitch = (p) => p.getByRole("checkbox", { name: "Fitur Kopi", exact: true });
const navEn = (p, name) =>
  p.getByRole("navigation", { name: "Main menu" }).getByRole("button", { name: menuName(name) });

async function waitShell(id) {
  await mainNav(page(id), "Board").waitFor({ timeout: 30000 });
}
async function closeOverlays(id) {
  for (let i = 0; i < 3; i++) {
    if (!(await page(id).getByRole("dialog").count()) && !(await page(id).getByRole("menu").count())) return;
    await page(id).keyboard.press("Escape");
    await sleep(250);
  }
}
async function setTheme(id, label) {
  const p = page(id);
  await closeOverlays(id);
  await mainNav(p, "Pengaturan").click();
  // Bagian terakhir yang dibuka bisa Bahasa: pilih Tampilan dulu kalau navigasinya ada.
  const part = p.locator("ul.settings-nav").getByRole("button", { name: "Tampilan", exact: true });
  if (await part.count()) await part.click();
  await p.getByLabel(label, { exact: true }).check();
  await sleep(300);
}
async function setLanguage(id, lang) {
  const p = page(id);
  await closeOverlays(id);
  if (lang === "en") {
    await mainNav(p, "Pengaturan").click();
    await p.locator("ul.settings-nav").getByRole("button", { name: "Bahasa", exact: true }).click();
    await p.locator(".lang-picker-full").getByRole("radio", { name: "English", exact: true }).check();
    await navEn(p, "Settings").waitFor({ timeout: 5000 });
  } else {
    await navEn(p, "Settings").click();
    await p.locator("ul.settings-nav").getByRole("button", { name: "Language", exact: true }).click();
    await p.locator(".lang-picker-full").getByRole("radio", { name: "Bahasa Indonesia", exact: true }).check();
    await mainNav(p, "Pengaturan").waitFor({ timeout: 5000 });
  }
}
async function openUmum(id) {
  const p = page(id);
  await closeOverlays(id);
  await mainNav(p, "Chat").click();
  await umumRow(p).click({ timeout: 30000 });
  await p.getByRole("region", { name: "#umum", exact: true }).waitFor({ timeout: 10000 });
}
// Klik kanan sungguhan di pesan, lalu tunggu menunya terlihat.
async function openMsgMenu(id, msgId) {
  const p = page(id);
  await closeOverlays(id);
  const li = msgLi(p, msgId);
  await li.waitFor({ timeout: 30000 });
  await li.scrollIntoViewIfNeeded();
  await li.click({ button: "right" });
  const menu = msgMenu(p);
  await menu.waitFor({ state: "visible", timeout: 5000 });
  return menu;
}
// Keadaan item "Beri kopi" di menu pesan: { shown, disabled, text }.
async function kopiItemState(id, msgId) {
  const menu = await openMsgMenu(id, msgId);
  const item = kopiItem(menu);
  const shown = (await item.count()) > 0;
  const state = shown
    ? {
        shown,
        disabled: (await item.getAttribute("aria-disabled")) === "true",
        text: (await item.innerText()).replace(/\s+/g, " ").trim(),
      }
    : { shown, disabled: false, text: "" };
  await page(id).keyboard.press("Escape");
  await sleep(200);
  return state;
}
// Profil penulis pesan lewat nama penulis > Lihat profil (atau View profile).
async function openProfile(id, msgId, whoName) {
  const p = page(id);
  await closeOverlays(id);
  const li = msgLi(p, msgId);
  await li.waitFor({ timeout: 30000 });
  await li.scrollIntoViewIfNeeded();
  await li.locator("button.conv-author-btn").first().click();
  const menu = p.getByRole("menu", { name: new RegExp(`^(Aksi untuk|Actions for) ${esc(whoName)}$`) });
  await menu.waitFor({ state: "visible", timeout: 5000 });
  await menu.locator('[data-menu-item="profile"]').click();
  const dlg = profileDialog(p);
  await dlg.waitFor({ timeout: 20000 });
  await dlg.locator(".kopi-counts").waitFor({ timeout: 20000 });
  return dlg;
}
const profileCounts = async (dlg) => {
  const dd = dlg.locator(".kopi-counts dd");
  return { peer: (await dd.nth(0).innerText()).trim(), work: (await dd.nth(1).innerText()).trim() };
};
async function goProject(id) {
  const p = page(id);
  await closeOverlays(id);
  await mainNav(p, "Board").click();
  await projectNav(p).getByRole("button", { name: new RegExp(esc(PROJECT)) }).click({ timeout: SYNC_MS });
  await p.locator(`[data-open-task="${taskId}"]`).waitFor({ timeout: 30000 });
}
async function openKopiPanel(id, english = false) {
  const p = page(id);
  await closeOverlays(id);
  if (english) await navEn(p, "Organization").click();
  else await mainNav(p, "Organisasi").click();
  await orgTab(p).click({ timeout: 15000 });
  await p.locator("#kopi-title").waitFor({ timeout: 15000 });
  await sleep(800);
}

try {
  // ---------- 1. Persiapan: kantor, B bergabung, proyek berisi A dan B ----------
  for (const id of Object.keys(NODES)) await launch(id);
  for (const id of Object.keys(NODES)) await must(id, "save_display_name", { name: NODES[id].name });
  for (const id of Object.keys(NODES)) {
    pk[id] = (await must(id, "get_app_state")).identity.publicKey;
    ownKeys.add(keyTarget(pk[id]));
  }

  await must("A", "create_organization", { name: ORG });
  const dept = await must("A", "org_create_department", { name: DEPT });
  await must("A", "org_move_member", { publicKey: pk.A, teamId: dept.id });
  const invite = await must("A", "create_invite", { teamId: dept.id, role: "member", validity: "24h", projectIds: [] });
  const joinB = await call("B", "join_with_code", { code: invite.code, address: addr("A") });
  if (!joinB.ok) throw new Error(`B gagal bergabung: ${JSON.stringify(joinB.error)}`);
  await waitFor("A melihat B aktif", async () => {
    const d = await must("A", "get_directory");
    return d.members.some((m) => m.publicKey === pk.B && m.status === "active");
  });
  await waitOnline("Persiapan");
  const bState = await must("B", "get_app_state");
  check("1. B bergabung lewat kode undangan A dan keduanya online", bState.organization?.name === ORG, secs(t0));

  const project = await must("A", "board_create_project", { name: PROJECT, code: PROJECT_CODE, teamId: dept.id, members: [pk.B] });
  projectId = project.id;
  const pm = await must("A", "org_project_members", { projectId });
  const onB = await settle("proyek muncul di B", async () => (await must("B", "board_list_projects")).some((p) => p.id === projectId));
  check(
    "1. Proyek berisi A dan B (syarat Kopi kerja: lebih dari satu orang), terlihat di B",
    pm.members.some((m) => m.publicKey === pk.A) && pm.members.some((m) => m.publicKey === pk.B) && onB === true,
    onB === true ? `${pm.members.length} anggota` : onB,
  );

  for (const id of Object.keys(NODES)) {
    await page(id).reload();
    await page(id).waitForFunction(() => "__TAURI_INTERNALS__" in window, null, { timeout: 20000 });
    await waitShell(id);
    await setTheme(id, "Terang");
    umum[id] = (await must(id, "chat_overview")).conversations.find((c) => c.isUmum)?.id ?? null;
  }
  const ovA = await overview("A");
  const ovB = await overview("B");
  check(
    "1. kopi_overview: fitur menyala, A superadmin, A dan B bisa memberi, belum ada pemberian",
    ovA.enabled && ovA.isSuperadmin && ovA.canGive && ovB.enabled && !ovB.isSuperadmin && ovB.canGive && ovA.givenToday === 0 && ovA.dailyLimit === 3,
    JSON.stringify({ A: { enabled: ovA.enabled, sa: ovA.isSuperadmin, canGive: ovA.canGive, limit: ovA.dailyLimit }, B: { enabled: ovB.enabled, canGive: ovB.canGive } }),
  );

  // ---------- 2. Kopi dari pesan chat ----------
  await section("2. Kopi dari pesan", async () => {
    if (!umum.A || !umum.B) throw new Error(`#umum tidak ditemukan (A=${umum.A}, B=${umum.B})`);
    // B mengirim pesan pertama lewat layar, sisanya lewat IPC (dipakai di langkah 5).
    await openUmum("B");
    const input = composer(page("B"));
    await input.click();
    await input.fill(TEXT.b1);
    await input.press("Enter");
    await page("B").getByRole("region", { name: /^Pesan di/ }).getByRole("listitem").filter({ hasText: TEXT.b1 }).first().waitFor({ timeout: 10000 });
    for (const k of ["b2", "b3", "b4"]) {
      await must("B", "chat_send", { conv: umum.B, text: TEXT[k], replyTo: null, mentions: [], files: [] });
    }
    await must("A", "chat_send", { conv: umum.A, text: TEXT.a1, replyTo: null, mentions: [], files: [] });

    const since = Date.now();
    const onA = await settle("pesan B sampai di A", async () => {
      const list = await messagesIn("A");
      const found = Object.fromEntries(["b1", "b2", "b3", "b4", "a1"].map((k) => [k, list.find((m) => m.text === TEXT[k])?.id]));
      return Object.values(found).every(Boolean) ? found : null;
    });
    if (typeof onA !== "object") throw new Error(onA);
    Object.assign(msg, onA);
    check("2. Pesan B (lewat layar) dan pesan lain sampai di A", true, secs(since));
    await settle("pesan A sampai di B", async () => (await messagesIn("B")).some((m) => m.id === msg.a1));

    // A: klik kanan pesan B, Beri kopi. Ringkasan Kopi di layar dimuat saat mount dan tiap 60 detik.
    const pA = page("A");
    await openUmum("A");
    const ready = await settle(
      "item Beri kopi aktif di menu pesan B",
      async () => {
        const s = await kopiItemState("A", msg.b1);
        return s.shown && !s.disabled ? s : null;
      },
      UI_MS,
      2000,
    );
    check("2. Menu klik kanan pesan B di A punya item Beri kopi yang aktif", typeof ready === "object", typeof ready === "object" ? ready.text : ready);
    const menu = await openMsgMenu("A", msg.b1);
    await kopiItem(menu).click();
    const dlg = giveDialog(pA, NODES.B.name);
    await dlg.waitFor({ timeout: 10000 });
    await dlg.getByLabel("Alasan", { exact: true }).fill(REASON);
    await sleep(400);
    const quota = (await dlg.locator(".kopi-give-quota").innerText().catch(() => "")).trim();
    const context = (await dlg.locator(".kopi-give-context blockquote").innerText().catch(() => "")).trim();
    check(
      "2. Dialog Beri kopi: cuplikan pesan dan sisa jatah 3 dari 3",
      context.startsWith(TEXT.b1.slice(0, 30)) && /3 dari 3/.test(quota),
      `cuplikan="${context.slice(0, 50)}", jatah="${quota}"`,
    );
    await shot("A", "kopi-dialog-beri-terang.png");
    await dlg.getByRole("button", { name: "Kirim kopi", exact: true }).click();
    await dlg.waitFor({ state: "hidden", timeout: 15000 });
    // Status untuk pembaca layar setelah dialog tertutup (wilayah live panel percakapan).
    const sentText = `Kopi terkirim untuk ${NODES.B.name}.`;
    const announced = await settle("status Kopi terkirim", async () => (await pA.getByText(sentText, { exact: true }).count()) > 0, 5000, 200);
    check(`2. Status "${sentText}" diumumkan setelah memberi`, announced === true, announced === true ? "" : announced);
    const ovA2 = await overview("A");
    check(
      "2. A: givenToday 1 dan target pesan tercatat",
      ovA2.givenToday === 1 && ovA2.givenTargets.includes(`message:${msg.b1}`),
      `givenToday=${ovA2.givenToday}, targets=${ovA2.givenTargets.join(",")}`,
    );

    // B: profil sendiri lewat IPC.
    const since2 = Date.now();
    const onB = await settle("B melihat Kopi rekan dari A", async () => {
      const p = await profile("B", "B");
      return p.peer === 1 ? p : null;
    });
    const entry = typeof onB === "object" ? peerEntries(onB)[0] : null;
    check(
      "2. B: kopi_profile B = 1 Kopi rekan dari Ayu Uji dengan alasan yang sama, target pesan",
      typeof onB === "object" &&
        entry?.from?.publicKey === pk.A &&
        entry?.from?.name === NODES.A.name &&
        entry?.reason === REASON &&
        entry?.target?.kind === "message" &&
        entry?.target?.id === msg.b1,
      typeof onB === "object" ? `${secs(since2)}: ${describeProfile(onB)}; dari=${entry?.from?.name}, alasan="${entry?.reason}"` : onB,
    );

    // Menu pada pesan yang sama sekarang nonaktif.
    const after = await settle(
      "item Beri kopi nonaktif",
      async () => {
        const s = await kopiItemState("A", msg.b1);
        return s.shown && s.disabled ? s : null;
      },
      UI_MS,
      2000,
    );
    check(
      '2. Menu pesan yang sama di A: Beri kopi nonaktif dengan keterangan "Sudah diberi kopi"',
      typeof after === "object" && after.text.includes("Sudah diberi kopi"),
      typeof after === "object" ? after.text : after,
    );

    // A: profil B lewat layar (nama penulis > Lihat profil).
    const prof = await openProfile("A", msg.b1, NODES.B.name);
    const counts = await settle("profil B di A menampilkan 1 Kopi rekan", async () => {
      const c = await profileCounts(prof);
      return c.peer === "1" ? c : null;
    }, 30000);
    const reasonShown = await prof.locator(".kopi-entry-reason", { hasText: REASON }).count();
    const head = ((await prof.locator(".kopi-entry-head").first().innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    check(
      `2. Dialog profil B di A: Dari rekan 1, riwayat "${NODES.A.name}, lewat pesan chat" dengan alasannya`,
      typeof counts === "object" && reasonShown > 0 && head.startsWith(`${NODES.A.name}, lewat pesan chat`),
      typeof counts === "object" ? `rekan=${counts.peer}, kerja=${counts.work}, kepala="${head}", alasan tampil=${reasonShown}` : counts,
    );
    await closeOverlays("A");
  });

  // ---------- 3. Kopi dari kerja ----------
  await section("3. Kopi kerja", async () => {
    const task = await must("A", "board_create_task", { projectId, input: { title: TASK, columnId: "todo" } });
    taskId = task.id;
    const assigned = await must("A", "board_update_task", { projectId, taskId, patch: { assignee: pk.B } });
    check("3. A membuat task dan menugaskannya ke B", assigned.assignee?.publicKey === pk.B, assigned.assignee?.name ?? "tanpa penanggung jawab");
    const onB = await settle("task sampai di B", async () => (await getTask("B"))?.assignee?.publicKey === pk.B);
    if (onB !== true) throw new Error(onB);
    await must("B", "board_move_task", { projectId, taskId, columnId: "done", index: 0 });
    const bTask = await getTask("B");
    check("3. B memindahkan task ke Selesai", columnOf(bTask) === "done", String(columnOf(bTask)));

    const since = Date.now();
    for (const id of ["B", "A"]) {
      const got = await settle(`Kopi kerja B = 1 di ${id}`, async () => {
        const p = await profile(id, "B");
        return p.work === 1 ? p : null;
      });
      const w = typeof got === "object" ? workEntries(got)[0] : null;
      check(
        `3. ${id}: kopi_profile B work = 1 dengan alasan assigned untuk task ini`,
        typeof got === "object" && w?.why === "assigned" && w?.taskId === taskId && w?.projectId === projectId,
        typeof got === "object" ? `${secs(since)}: ${describeProfile(got)}; why=${w?.why}, judul=${w?.title}` : got,
      );
    }

    // Detail task di A dengan tombol Terima kasih.
    await settle("task di A sudah di Selesai", async () => columnOf(await getTask("A")) === "done");
    const pA = page("A");
    await goProject("A");
    const thanks = await settle(
      "tombol Terima kasih ke Budi Uji tampil di detail task",
      async () => {
        await closeOverlays("A");
        await pA.locator(`[data-open-task="${taskId}"]`).click();
        await taskDialog(pA).waitFor({ timeout: 15000 });
        const btn = taskDialog(pA).getByRole("button", { name: new RegExp(`^Terima kasih ke ${esc(NODES.B.name)}`) });
        return (await btn.count()) > 0 && (await btn.isVisible());
      },
      UI_MS,
      3000,
    );
    check("3. Detail task di A: tombol Terima kasih ke Budi Uji tampil", thanks === true, thanks === true ? "" : thanks);
    await sleep(500);
    await shot("A", "kopi-task-terima-kasih-terang.png");
    await closeOverlays("A");

    // Profil B di A (Kopi rekan dan kerja), terang dan gelap.
    for (const [label, suffix] of [
      ["Terang", "terang"],
      ["Gelap", "gelap"],
    ]) {
      await setTheme("A", label);
      await openUmum("A");
      const dlg = await openProfile("A", msg.b1, NODES.B.name);
      const c = await settle("profil B menampilkan Kopi kerja 1", async () => {
        const v = await profileCounts(dlg);
        return v.work === "1" ? v : null;
      }, 30000);
      check(`3. Dialog profil B di A (${suffix}): Dari rekan 1, Dari kerja 1`, typeof c === "object" && c.peer === "1", typeof c === "object" ? JSON.stringify(c) : c);
      await sleep(500);
      await shot("A", `kopi-profil-${suffix}.png`);
      await closeOverlays("A");
    }
    await setTheme("A", "Terang");
  });

  // ---------- 4. Task dibuka lagi ----------
  await section("4. Task dibuka lagi", async () => {
    if (!taskId) throw new Error("task langkah 3 tidak ada");
    await must("A", "board_move_task", { projectId, taskId, columnId: "doing", index: 0 });
    check("4. A memindahkan task ke Dikerjakan", columnOf(await getTask("A")) === "doing", String(columnOf(await getTask("A"))));
    const since = Date.now();
    for (const id of ["A", "B"]) {
      const got = await settle(`Kopi kerja B = 0 di ${id}`, async () => {
        const p = await profile(id, "B");
        return p.work === 0 && workEntries(p).length === 0 ? p : null;
      });
      check(
        `4. ${id}: kopi_profile B work kembali 0, Kopi rekan tetap 1`,
        typeof got === "object" && got.peer === 1,
        typeof got === "object" ? `${secs(since)}: ${describeProfile(got)}` : got,
      );
    }
  });

  // ---------- 5. Batas harian ----------
  await section("5. Batas harian", async () => {
    const self = await give("A", "A", { kind: "profile", day: today() }, "Uji memberi diri sendiri.");
    check("5. A memberi Kopi ke diri sendiri: ditolak", !self.ok && /diri sendiri/.test(self.error?.message ?? ""), errText(self));
    const again = await give("A", "B", { kind: "message", id: msg.b1 }, "Pesan yang sama lagi.");
    check("5. A memberi Kopi lagi untuk pesan yang sama: ditolak", !again.ok && /sudah memberi/i.test(again.error?.message ?? ""), errText(again));

    // Isi sampai 3 hari ini (pemberian langkah 2 ikut dihitung), lalu satu lagi harus ditolak.
    // Semua ke B: paling banyak 3 yang berhasil, di bawah batas 4 per pasangan per bulan,
    // jadi pemberian ke-4 ditolak karena jatah harian (dicek setelah batas pasangan di Rust).
    const targets = [
      { kind: "message", id: msg.b2 },
      { kind: "profile", day: today() },
      { kind: "message", id: msg.b3 },
      { kind: "message", id: msg.b4 },
    ];
    let given = (await overview("A")).givenToday;
    const log = [];
    while (given < 3 && targets.length) {
      const t = targets.shift();
      const r = await give("A", "B", t, `Terima kasih untuk bantuan ${t.kind === "profile" ? "minggu ini" : "di chat"}.`);
      log.push(`${t.kind}:${r.ok ? "ok" : errText(r)}`);
      if (!r.ok) throw new Error(`pemberian sebelum batas ditolak: ${errText(r)}`);
      given = (await overview("A")).givenToday;
    }
    check("5. A memberi sampai 3 Kopi hari ini", given === 3, `${log.join(", ")}; givenToday=${given}`);
    const fourth = await give("A", "B", targets.shift() ?? { kind: "message", id: msg.b4 }, "Satu lagi melewati batas.");
    check(
      "5. Pemberian ke-4 hari ini ditolak (invalid_input, jatah habis)",
      !fourth.ok && fourth.error?.code === "invalid_input" && /Jatah Kopi Anda hari ini sudah habis/.test(fourth.error?.message ?? ""),
      errText(fourth),
    );
    const ov = await overview("A");
    check("5. kopi_overview A: givenToday = 3, dailyLimit = 3", ov.givenToday === 3 && ov.dailyLimit === 3, `givenToday=${ov.givenToday}`);

    const since = Date.now();
    const onB = await settle("B melihat 3 Kopi rekan", async () => {
      const p = await profile("B", "B");
      return p.peer === 3 ? p : null;
    });
    check("5. B: kopi_profile B = 3 Kopi rekan (yang ke-4 tidak ada)", typeof onB === "object", typeof onB === "object" ? `${secs(since)}: ${describeProfile(onB)}` : onB);

    // Pesan lain B di layar A: item nonaktif karena jatah habis.
    await openUmum("A");
    const limited = await settle(
      "item Beri kopi nonaktif karena jatah habis",
      async () => {
        const s = await kopiItemState("A", msg.b4);
        return s.shown && s.disabled ? s : null;
      },
      UI_MS,
      2000,
    );
    check(
      '5. Menu pesan B yang belum diberi: Beri kopi nonaktif "Jatah kopi hari ini habis"',
      typeof limited === "object" && limited.text.includes("Jatah kopi hari ini habis"),
      typeof limited === "object" ? limited.text : limited,
    );
  });

  // ---------- 6. Superadmin mematikan fitur ----------
  await section("6. Fitur dimatikan", async () => {
    const pA = page("A");
    // Kontrol positif: sebelum dimatikan, B melihat item Beri kopi di pesan A.
    await openUmum("B");
    const before = await settle(
      "B melihat item Beri kopi di pesan A",
      async () => {
        const s = await kopiItemState("B", msg.a1);
        return s.shown && !s.disabled ? s : null;
      },
      UI_MS,
      2000,
    );
    check("6. Sebelum dimatikan: menu pesan A di B punya Beri kopi yang aktif", typeof before === "object", typeof before === "object" ? before.text : before);

    // Panel Organisasi > Kopi, terang dan gelap.
    for (const [label, suffix] of [
      ["Terang", "terang"],
      ["Gelap", "gelap"],
    ]) {
      await setTheme("A", label);
      await openKopiPanel("A");
      const rows = await pA.locator("ol.kb-list > li").count();
      check(`6. Panel Organisasi > Kopi di A (${suffix}): papan bulan ini berisi baris`, rows > 0, `${rows} baris`);
      await shot("A", `kopi-panel-${suffix}.png`);
    }
    await setTheme("A", "Terang");
    await openKopiPanel("A");

    // Matikan: sakelar lalu konfirmasi.
    const sw = featureSwitch(pA);
    check("6. Kotak centang Fitur Kopi tercentang di A", await sw.isChecked());
    await sw.click();
    const confirm = pA.getByRole("button", { name: "Matikan Kopi", exact: true });
    await confirm.waitFor({ timeout: 10000 });
    await shot("A", "kopi-panel-konfirmasi-terang.png");
    await confirm.click();
    const offA = await settle("sakelar A mati", async () => !(await sw.isChecked()) && !(await overview("A")).enabled, 20000);
    check("6. A mematikan fitur lewat kotak centang dan konfirmasi: tidak tercentang, overview A enabled = false", offA === true, offA === true ? "" : offA);
    await sleep(600);
    await shot("A", "kopi-panel-mati-terang.png");

    const since = Date.now();
    const offB = await settle("B: fitur Kopi mati", async () => (await overview("B")).enabled === false);
    check("6. B: kopi_overview enabled = false setelah sinkron", offB === true, offB === true ? secs(since) : offB);
    const gone = await settle(
      "item Beri kopi hilang di B",
      async () => {
        const s = await kopiItemState("B", msg.a1);
        return !s.shown;
      },
      UI_MS,
      2000,
    );
    check("6. B: menu klik kanan pesan A tidak punya item Beri kopi", gone === true, gone === true ? "" : gone);
    const refused = await give("B", "A", { kind: "message", id: msg.a1 }, "Terima kasih infonya.");
    check(
      "6. B: kopi_give ditolak saat fitur mati (forbidden)",
      !refused.ok && refused.error?.code === "forbidden" && /dimatikan/.test(refused.error?.message ?? ""),
      errText(refused),
    );

    // Nyalakan lagi (tanpa konfirmasi).
    await openKopiPanel("A");
    await featureSwitch(pA).click();
    const onA = await settle("sakelar A menyala lagi", async () => (await featureSwitch(pA).isChecked()) && (await overview("A")).enabled, 20000);
    check("6. A menyalakan fitur lagi", onA === true, onA === true ? "" : onA);
    const since2 = Date.now();
    const onB = await settle("B: fitur Kopi menyala lagi", async () => (await overview("B")).enabled === true);
    check("6. B: kopi_overview enabled = true lagi", onB === true, onB === true ? secs(since2) : onB);
    const bGive = await give("B", "A", { kind: "message", id: msg.a1 }, "Terima kasih infonya.");
    check("6. B memberi Kopi untuk pesan A setelah fitur menyala lagi: berhasil", bGive.ok, bGive.ok ? "" : errText(bGive));
  });

  // ---------- 7. Versi Inggris ----------
  await section("7. Versi Inggris", async () => {
    const pA = page("A");
    await setLanguage("A", "en");
    await openKopiPanel("A", true);
    const title = (await pA.locator("#kopi-title").innerText()).trim();
    check("7. Panel Organization > Coffee berbahasa Inggris", /Coffee/.test(title), title);
    await shot("A", "kopi-panel-en.png");

    await closeOverlays("A");
    await navEn(pA, "Chat").click();
    if (!(await msgLi(pA, msg.b1).isVisible().catch(() => false))) {
      await pA.locator(".chat-list").getByRole("button", { name: /umum/ }).first().click({ timeout: 15000 });
    }
    const dlg = await openProfile("A", msg.b1, NODES.B.name);
    const heading = (await dlg.locator(".kopi-prof-title").innerText()).trim();
    const labels = (await dlg.locator(".kopi-counts dt").allInnerTexts()).map((t) => t.trim());
    const levelLabel = (await dlg.locator(".kopi-sum-label").innerText().catch(() => "")).trim();
    const levelName = (await dlg.locator(".kopi-sum-name").innerText().catch(() => "")).trim();
    check(
      "7. Profil B dalam bahasa Inggris: judul Coffee, From colleagues, From work, Level",
      heading === "Coffee" && labels.includes("From colleagues") && labels.includes("From work") && levelLabel === "Level",
      `judul="${heading}", label=${labels.join(" / ")}, ${levelLabel}=${levelName}`,
    );
    // B: 3 Kopi rekan x 3 = skor 9, di bawah Regular (15).
    check("7. Tingkatan B dalam bahasa Inggris: Newcomer", levelName === "Newcomer", levelName);
    await sleep(400);
    await shot("A", "kopi-profil-en.png");
    await closeOverlays("A");
    await setLanguage("A", "id");
  });
} catch (err) {
  check("Skrip berjalan tanpa error", false, String(err?.message ?? err).slice(0, 400));
  for (const id of Object.keys(running)) await shot(id, `kopi-gagal-${id.toLowerCase()}.png`);
}

const failedSoFar = results.some((r) => !r.ok);
for (const id of Object.keys(running)) {
  if (failedSoFar && running[id].consoleLines.length) {
    console.log(`Konsol ${id} (error/peringatan, terakhir):\n${running[id].consoleLines.slice(-15).join("\n")}`);
  }
  await stop(id);
}
if (failedSoFar) {
  for (const id of Object.keys(NODES)) {
    try {
      const log = readFileSync(join(root, `${id}-stderr.log`), "utf8").trim();
      if (log) console.log(`stderr ${id} (akhir):\n${log.slice(-1500)}`);
    } catch {
      /* tidak ada log */
    }
  }
}
// Kunci publik belum terbaca (gagal sangat awal): kembali ke cara lama, semua kunci baru.
const toDelete = ownKeys.size ? ownKeys : new Set([...miraCredentials()].filter((t) => !credentialsBefore.has(t)));
const present = miraCredentials();
for (const target of toDelete) {
  if (present.has(target)) {
    try {
      execFileSync("cmdkey", [`/delete:${target}`], { stdio: "ignore" });
    } catch {
      console.log(`Kunci uji tidak bisa dihapus: ${target}`);
    }
  }
}
// Proses yang gagal di tengah launch juga dihentikan.
for (const child of [...spawned]) killTree(child.pid);
// WebView2 bisa masih memegang file sebentar setelah proses dihentikan: coba ulang, jangan crash.
let removed = false;
for (let i = 0; i < 20 && !removed; i++) {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    removed = true;
  } catch (err) {
    if (i === 19) console.log(`Folder data uji belum bisa dihapus (${err.code ?? err.message}): ${root}`);
    else await sleep(1500);
  }
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} pemeriksaan lulus. (${secs(t0)})`);
process.exit(failed ? 1 : 0);
