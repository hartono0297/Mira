// Uji ujung ke ujung foto profil antar dua "laptop" Mira di satu PC, lewat transport
// jaringan sungguhan (QUIC di 127.0.0.1, mDNS). Kontrak: docs/plans/foto-profil.md.
//
// Pola sama dengan board-v04-multi-e2e.mjs: dua instance mira.exe, masing-masing dengan
// folder data (MIRA_DATA_DIR), port QUIC (MIRA_PORT), dan port debug WebView2 sendiri,
// dikendalikan lewat Chrome DevTools Protocol. Persiapan (kantor, bergabung, proyek,
// task, pesan) lewat command Tauri; foto dipasang lewat tampilan sungguhan.
//
//   A  Ayu   superadmin, membuat kantor, memasang dan menghapus foto
//   B  Budi  bergabung dengan kode undangan, melihat foto A di chat, board, organisasi
//
// Dialog file Windows tidak bisa diotomasi: A dijalankan dengan MIRA_E2E_PICK_PHOTO
// (kait build debug, kontrak 2.6) yang menunjuk ke gambar buatan skrip ini. Gambar
// sumber berupa PNG 800x600 dengan chunk tEXt dan eXIf berisi "Exif" dan penanda
// GPS palsu; foto hasil di laptop B tidak boleh memuat keduanya.
//
// Alur:
//   0. Persiapan: kantor, B bergabung, proyek berisi B, task untuk A, pesan A di #umum.
//   1. Sebelum foto: avatar A di B berupa inisial (data-avatar-key ada, tanpa img).
//   2. A: Pengaturan > Profil > Ganti foto > Atur foto profil (panah, Perbesar, Simpan).
//   3. B: foto A tampil di chat, board, dan Organisasi.
//   4. Privasi: foto A di B tanpa EXIF dan penanda GPS, JPEG 256x256 < 100 KB.
//   5. Screenshot Pengaturan > Profil dan pemotong: terang/gelap, Indonesia/Inggris.
//   6. A menghapus foto lewat menu profil Shell; B kembali ke inisial.
//   7. Offline: B mati, A memasang foto baru lewat menu Shell, B menyala dan menyusul.
//
// Pakai:  node scripts/profile-e2e.mjs [path mira.exe] [folder screenshot] [folder induk data]
// Bawaan: src-tauri/target/debug/mira.exe, docs/progress/screenshots/foto-profil, folder temp.
// E2E_PORT_OFFSET menggeser port QUIC dan CDP. E2E_PHOTO_WAIT_MS: batas tunggu foto (60000).

import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { chromium } from "playwright-core";

const exe = resolve(process.argv[2] ?? "src-tauri/target/debug/mira.exe");
const shots = resolve(process.argv[3] ?? "docs/progress/screenshots/foto-profil");
const parent = resolve(process.argv[4] ?? tmpdir());
mkdirSync(shots, { recursive: true });
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, "mira-profile-"));

const PORT_OFFSET = Number(process.env.E2E_PORT_OFFSET ?? 0) || 0;
const PICK_FILE = join(root, "foto-pilihan.png");
const NODES = {
  A: {
    name: "Ayu Uji",
    port: 47961 + PORT_OFFSET,
    cdp: 9461 + PORT_OFFSET,
    dir: join(root, "laptop-a"),
    env: { MIRA_E2E_PICK_PHOTO: PICK_FILE },
  },
  B: { name: "Budi Uji", port: 47962 + PORT_OFFSET, cdp: 9462 + PORT_OFFSET, dir: join(root, "laptop-b") },
};
const addr = (id) => `127.0.0.1:${NODES[id].port}`;
// Persiapan organisasi dan proyek: sinkron saat ada perubahan, cadangan berkala 60 detik.
const SYNC_MS = 150000;
// Foto sampai ke laptop lain (kontrak: notify_changed langsung, fetcher 60 detik).
const PHOTO_MS = Number(process.env.E2E_PHOTO_WAIT_MS ?? 60000) || 60000;
// Menyusul setelah laptop menyala lagi: koneksi ulang ditambah unduhan.
const CATCHUP_MS = PHOTO_MS * 2;

const ORG = "Kantor Uji Foto Profil";
const DEPT = "Desain";
const PROJECT = "Proyek Brosur Pameran";
const PROJECT_CODE = "BP";
const TASK = "Susun tata letak brosur pameran";
const MESSAGE = "Halo semua, ini pesan Ayu untuk uji foto profil.";
const GPS_MARKER = "GPSLATITUDE-SECRET";
const MAX_PHOTO = 100 * 1024;

// ---- Selektor (label dari kontrak 3.5; teks Inggris tebakan, cek saat dijalankan) ----
const either = (id, en) => new RegExp(`^(${id}|${en})$`);
const menuName = (name) => new RegExp(`^(${name})\\s*(,|$)`);
const sel = {
  mainMenu: (p) => p.getByRole("navigation", { name: either("Menu utama", "Main menu") }),
  nav: (p, key) => sel.mainMenu(p).getByRole("button", { name: menuName(sel.navNames[key]) }),
  navNames: { chat: "Chat", board: "Board", org: "Organisasi|Organization", settings: "Pengaturan|Settings" },

  // Pengaturan
  settingsNav: (p) => p.locator("ul.settings-nav"),
  profilePart: (p) => sel.settingsNav(p).getByRole("button", { name: either("Profil", "Profile") }),
  profileHeading: (p) => p.locator(".settings-body").getByRole("heading", { name: either("Profil", "Profile") }).first(),
  changePhoto: (p) => p.locator(".settings-body").getByRole("button", { name: either("Ganti foto", "Change photo") }),
  removePhoto: (p) => p.locator(".settings-body").getByRole("button", { name: either("Hapus foto", "Remove photo") }),

  // Dialog pemotong. Dikenali dari slider di dalamnya supaya tidak bergantung pada judul Inggris.
  cropDialog: (p) => p.getByRole("dialog").filter({ has: p.getByRole("slider") }),
  cropTitle: "Atur foto profil",
  cropPan: (d) => d.getByRole("group", { name: either("Posisi foto", "Photo position") }),
  cropZoom: (d) => d.getByRole("slider", { name: either("Perbesar", "Zoom") }),
  cropSave: (d) => d.getByRole("button", { name: either("Simpan foto", "Save photo") }),
  cropCancel: (d) => d.getByRole("button", { name: either("Batal", "Cancel") }),

  // Konfirmasi hapus foto (dialog atau alertdialog dengan tombol "Hapus foto").
  confirmRemove: (p) =>
    p
      .locator('[role="dialog"], [role="alertdialog"]')
      .filter({ has: p.getByRole("button", { name: "Hapus foto", exact: true }) }),
  confirmRemoveBtn: (d) => d.getByRole("button", { name: "Hapus foto", exact: true }),

  // Shell
  sideMe: (p) => p.locator(".side-me").first(),
  profileMenu: (p) => p.getByRole("button", { name: "Menu profil Anda", exact: true }),
  menuItem: (p, name) => p.getByRole("menuitem", { name, exact: true }),

  // Avatar
  avatar: (scope, key) => scope.locator(`[data-avatar-key="${key}"]`),
  avatarImg: (scope, key) => scope.locator(`[data-avatar-key="${key}"] img.avatar-img`),

  // Chat (sama dengan e2e-fitur-multi.mjs)
  chatList: (p) => p.getByRole("navigation", { name: /Daftar percakapan/i }),
  channelRow: (p, name) => sel.chatList(p).getByRole("button", { name: new RegExp(`^Channel ${name}(,|$)`) }),
  conv: (p, title) => p.getByRole("region", { name: title, exact: true }),
  chatLog: (p) => p.getByRole("region", { name: /^Pesan di/ }),

  // Board
  projectNav: (p) => p.getByRole("navigation", { name: "Task saya dan proyek" }),
  card: (p, taskId) => p.locator(`[data-card="${taskId}"]`).first(),

  // Organisasi: anggota biasa melihat tab "Anggota", superadmin "Pengguna".
  orgHeading: (p) => p.getByRole("heading", { name: "Organisasi", level: 1 }),
  orgTab: (p) => p.locator("nav.org-tabs-wrap").getByRole("button", { name: /^(Anggota|Pengguna)$/ }).first(),
  orgMain: (p) => p.locator("main").filter({ has: sel.orgHeading(p) }),
};

// ---- Gambar uji: PNG RGB dengan chunk metadata ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
// TIFF big-endian minimal: satu entri ImageDescription (ASCII) berisi penanda GPS.
function exifTiff(text) {
  const str = Buffer.from(`${text}\0`, "latin1");
  const head = Buffer.alloc(26);
  head.write("MM", 0, "latin1");
  head.writeUInt16BE(42, 2);
  head.writeUInt32BE(8, 4);
  head.writeUInt16BE(1, 8);
  head.writeUInt16BE(0x010e, 10);
  head.writeUInt16BE(2, 12);
  head.writeUInt32BE(str.length, 14);
  head.writeUInt32BE(26, 18);
  head.writeUInt32BE(0, 22);
  return Buffer.concat([head, str]);
}
function makePng(width, height, pixel, label) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }
  const text = Buffer.from(`Comment\0Exif ${GPS_MARKER} -6.2088 106.8456 ${label}`, "latin1");
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("tEXt", text),
    chunk("eXIf", exifTiff(`Exif ${GPS_MARKER} ${label}`)),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
// Foto 1: gradasi bata dengan lingkaran biru di tengah dan garis putih vertikal.
const photo1 = () =>
  makePng(800, 600, (x, y) => {
    const dx = x - 400;
    const dy = y - 300;
    if (dx * dx + dy * dy < 170 * 170) return [40, 90, 200];
    if (Math.abs(x - 600) < 14) return [250, 250, 250];
    return [180 + Math.round((x / 800) * 60), 80 + Math.round((y / 600) * 60), 60];
  }, "foto-1");
// Foto 2: hijau dengan kotak jingga, supaya hash berbeda dan mudah dibedakan di layar.
const photo2 = () =>
  makePng(800, 600, (x, y) => {
    if (x > 280 && x < 520 && y > 180 && y < 420) return [240, 140, 30];
    return [40, 140 + Math.round((x / 800) * 80), 90];
  }, "foto-2");

// Lebar dan tinggi JPEG dari penanda SOF pertama.
function jpegSize(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

// ---- Kredensial: hanya kunci laptop uji milik skrip ini yang dihapus di akhir ----
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
const note = (msg) => console.log(`CATATAN  ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const secs = (since) => `${Math.round((Date.now() - since) / 1000)} dtk`;

const running = {};

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
      ...(node.env ?? {}),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${node.cdp}`,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.pipe(log);
  // Dicatat sejak awal supaya proses tetap dihentikan kalau langkah berikut gagal.
  running[id] = { child, browser: null, page: null, consoleLines: [] };
  let browser;
  for (let i = 0; i < 80 && !browser; i++) {
    await sleep(500);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${node.cdp}`);
    } catch {
      /* belum siap */
    }
  }
  if (!browser) throw new Error(`WebView2 ${id} tidak bisa dihubungi lewat CDP`);
  running[id].browser = browser;
  let pg;
  for (let i = 0; i < 40 && !pg; i++) {
    pg = browser.contexts().flatMap((c) => c.pages())[0];
    if (!pg) await sleep(250);
  }
  if (!pg) throw new Error(`WebView2 ${id} tidak punya halaman`);
  running[id].page = pg;
  const consoleLines = running[id].consoleLines;
  pg.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") consoleLines.push(`[${m.type()}] ${m.text()}`);
  });
  await pg.waitForLoadState("domcontentloaded");
  // WebView2 baru bisa lambat memuat halaman pertama saat disk sibuk: batas 60 detik.
  await pg.waitForFunction(() => "__TAURI_INTERNALS__" in window, null, { timeout: 60000 }).catch((e) => {
    throw new Error(`${id}: __TAURI_INTERNALS__ tidak muncul di ${pg.url()}: ${String(e?.message ?? e).slice(0, 120)}`);
  });
  await pg.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  try {
    const st = await pg.evaluate(() => window.__TAURI_INTERNALS__.invoke("get_app_state"));
    if (st?.identity?.publicKey) ourKeys.add(st.identity.publicKey.toLowerCase());
  } catch {
    /* dicatat lagi setelah nama disimpan */
  }
  return running[id];
}

async function stop(id) {
  const app = running[id];
  if (!app) return;
  delete running[id];
  await app.browser?.close().catch(() => {});
  try {
    // Hanya pohon proses yang dijalankan skrip ini.
    execFileSync("taskkill", ["/PID", String(app.child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* sudah berhenti */
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
const settle = (desc, fn, timeoutMs) => waitFor(desc, fn, timeoutMs).catch((e) => String(e.message));

const page = (id) => running[id].page;
const shot = async (id, name) => {
  await running[id]?.page?.screenshot({ path: join(shots, name) }).catch(() => {});
};
async function section(name, fn) {
  try {
    await fn();
  } catch (err) {
    check(`${name}: berjalan tanpa error`, false, String(err?.message ?? err).slice(0, 400));
    for (const id of Object.keys(running)) {
      await shot(id, `fp-gagal-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${id.toLowerCase()}.png`);
    }
  }
}

const onlineNames = async (id) =>
  (await must(id, "get_network_status")).peers.filter((p) => p.online).map((p) => p.displayName).sort();
async function waitOnline(desc) {
  for (const id of ["A", "B"]) {
    const other = NODES[id === "A" ? "B" : "A"].name;
    await waitFor(`${desc}: ${id} melihat ${other} online`, async () => (await onlineNames(id)).includes(other));
  }
}

// ---- Tampilan ----
async function waitShell(id) {
  await sel.nav(page(id), "board").waitFor({ timeout: 30000 });
}
async function reload(id) {
  await page(id).reload();
  await page(id).waitForFunction(() => "__TAURI_INTERNALS__" in window, null, { timeout: 20000 });
  await waitShell(id);
}
// Tema dan bahasa lewat pengaturan inti Rust, salinan localStorage disamakan, lalu muat ulang.
async function setLook(id, { mode, lang }) {
  if (mode) await must(id, "set_setting", { key: "theme.mode", value: mode });
  if (lang) await must(id, "set_setting", { key: "app.language", value: lang });
  await page(id).evaluate(
    ([m, l]) => {
      try {
        if (m) localStorage.setItem("mira.theme.mode", m);
        if (l) localStorage.setItem("mira.lang", l);
      } catch {
        /* storage diblokir */
      }
    },
    [mode, lang],
  );
  await reload(id);
  await sleep(500);
}
async function openProfileSettings(id) {
  const p = page(id);
  await sel.nav(p, "settings").click();
  await sel.profilePart(p).click({ timeout: 15000 });
  await sel.changePhoto(p).waitFor({ timeout: 15000 });
}
async function goChannelUmum(id) {
  const p = page(id);
  await sel.nav(p, "chat").click();
  await sel.chatList(p).waitFor({ timeout: 15000 });
  await sel.channelRow(p, "umum").click({ timeout: 30000 });
  await sel.conv(p, "#umum").waitFor({ timeout: 15000 });
}
async function goProject(id, taskId) {
  const p = page(id);
  await sel.nav(p, "board").click();
  await sel.projectNav(p).getByRole("button", { name: new RegExp(PROJECT) }).click({ timeout: SYNC_MS });
  await sel.card(p, taskId).waitFor({ timeout: 30000 });
}
async function goOrg(id) {
  const p = page(id);
  await sel.nav(p, "org").click();
  await sel.orgHeading(p).waitFor({ timeout: 15000 });
  if (await sel.orgTab(p).isVisible().catch(() => false)) await sel.orgTab(p).click();
  await sleep(600);
}

// Foto termuat di dalam `scope`: img.avatar-img dalam avatar berkunci `key`, sudah terdekode.
async function photoShown(scope, key) {
  const imgs = sel.avatarImg(scope, key);
  if ((await imgs.count()) === 0) return false;
  return imgs.first().evaluate((img) => img.complete && img.naturalWidth > 0);
}
// Inisial: avatar berkunci `key` ada, tanpa img.
async function initialsShown(scope, key) {
  return (await sel.avatar(scope, key).count()) > 0 && (await sel.avatarImg(scope, key).count()) === 0;
}
const waitPhoto = (desc, scope, key, timeoutMs = PHOTO_MS) => settle(desc, () => photoShown(scope, key), timeoutMs);
const waitInitials = (desc, scope, key, timeoutMs = PHOTO_MS) => settle(desc, () => initialsShown(scope, key), timeoutMs);
const okText = (r, since) => (r === true ? secs(since) : r);

// Dialog pemotong sudah terbuka: panah di Posisi foto, slider Perbesar, lalu Simpan foto.
async function cropAndSave(id, { shotName } = {}) {
  const p = page(id);
  const dlg = sel.cropDialog(p);
  await dlg.waitFor({ timeout: 20000 });
  const pan = sel.cropPan(dlg);
  const before = await pan.evaluate((el) => el.outerHTML);
  await pan.focus();
  await p.keyboard.press("ArrowLeft");
  await p.keyboard.press("Shift+ArrowLeft");
  await sleep(200);
  const afterPan = await pan.evaluate((el) => el.outerHTML);
  check(`${id}: panah di "Posisi foto" menggeser potongan`, afterPan !== before);

  const zoom = sel.cropZoom(dlg);
  const z0 = Number(await zoom.inputValue());
  await zoom.focus();
  for (let i = 0; i < 6; i++) await p.keyboard.press("ArrowRight");
  let z1 = Number(await zoom.inputValue());
  if (!(z1 > z0)) {
    // Cadangan: isi nilai di tengah rentang (Playwright memicu input dan change).
    const { min, max } = await zoom.evaluate((el) => ({ min: Number(el.min || 0), max: Number(el.max || 100) }));
    await zoom.fill(String((min + max) / 2));
    z1 = Number(await zoom.inputValue());
  }
  check(`${id}: slider "Perbesar" bergeser`, z1 > z0, `${z0} ke ${z1}`);
  await pan.focus();
  await p.keyboard.press("ArrowDown");
  await sleep(300);
  if (shotName) await shot(id, shotName);

  await sel.cropSave(dlg).click();
  const closed = await dlg
    .waitFor({ state: "hidden", timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  const alert = closed ? "" : await p.getByRole("alert").first().innerText().catch(() => "");
  check(`${id}: "Simpan foto" menutup dialog pemotong`, closed, alert.slice(0, 200));
  return closed;
}

// ---- Data ----
const pk = {};
let projectId = null;
let taskId = null;
let hash1 = null;

try {
  writeFileSync(PICK_FILE, photo1());
  const src = readFileSync(PICK_FILE);
  check(
    "Fixture: PNG 800x600 dengan Exif dan penanda GPS di chunk metadata",
    src.includes(Buffer.from("Exif")) && src.includes(Buffer.from(GPS_MARKER)),
    `${src.length} byte`,
  );

  // ---------- 0. Persiapan ----------
  for (const id of Object.keys(NODES)) await launch(id);
  for (const id of Object.keys(NODES)) await must(id, "save_display_name", { name: NODES[id].name });
  for (const id of Object.keys(NODES)) {
    pk[id] = (await must(id, "get_app_state")).identity.publicKey.toLowerCase();
    ourKeys.add(pk[id]);
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
  check("Persiapan: B bergabung dan keduanya online", (await must("B", "get_app_state")).organization?.name === ORG);

  const project = await must("A", "board_create_project", { name: PROJECT, code: PROJECT_CODE, teamId: dept.id, members: [pk.B] });
  projectId = project.id;
  const task = await must("A", "board_create_task", { projectId, input: { title: TASK, columnId: "todo", assignee: pk.A } });
  taskId = task.id;
  const umum = (await must("A", "chat_overview")).conversations.find((c) => c.isUmum);
  if (!umum) throw new Error("Channel #umum tidak ada di A");
  await must("A", "chat_send", { conv: umum.id, text: MESSAGE, replyTo: null, mentions: [], files: [] });
  const synced = await settle("proyek, task, dan pesan A sampai di B", async () => {
    const r = await call("B", "board_get_task", { projectId, taskId });
    const ov = await must("B", "chat_overview");
    const umumB = ov.conversations.find((c) => c.isUmum);
    if (!r.ok || !umumB) return false;
    const msgs = await must("B", "chat_messages", { conv: umumB.id, before: null, limit: 100 });
    return r.value.assignee?.publicKey === pk.A && msgs.messages.some((m) => m.text === MESSAGE);
  });
  check("Persiapan: task untuk A dan pesan A di #umum terlihat di B", synced === true, synced === true ? "" : synced);

  for (const id of Object.keys(NODES)) {
    await reload(id);
    await setLook(id, { mode: "light", lang: "id" });
  }

  // ---------- 1. Sebelum foto ----------
  await section("1. Sebelum foto", async () => {
    await goChannelUmum("B");
    const r = await waitInitials("avatar A di chat B berupa inisial", sel.chatLog(page("B")), pk.A, 30000);
    check("1. B: avatar A di #umum punya data-avatar-key dan tampil sebagai inisial", r === true, r === true ? "" : r);
    const mine = await must("A", "profile_my_photo");
    check("1. A: profile_my_photo kosong sebelum memasang foto", mine.hash === null && mine.removedByAdmin === false, JSON.stringify(mine));
    await openProfileSettings("A");
    check("1. A: Pengaturan > Profil menampilkan judul Profil", await sel.profileHeading(page("A")).isVisible().catch(() => false));
    check("1. A: tombol Hapus foto belum ada tanpa foto", (await sel.removePhoto(page("A")).count()) === 0);
    await shot("A", "fp-01-a-profil-tanpa-foto-terang-id.png");
  });

  // ---------- 2. A memasang foto lewat Pengaturan ----------
  await section("2. A memasang foto", async () => {
    const p = page("A");
    await openProfileSettings("A");
    await sel.changePhoto(p).click();
    const dlg = sel.cropDialog(p);
    await dlg.waitFor({ timeout: 20000 });
    check(
      `2. A: dialog "${sel.cropTitle}" terbuka dari "Ganti foto"`,
      (await p.getByRole("dialog", { name: sel.cropTitle }).count()) === 1,
    );
    const saved = await cropAndSave("A", { shotName: "fp-02-a-pemotong-terang-id.png" });
    if (!saved) throw new Error("Foto A tidak tersimpan");
    const mine = await waitFor("profile_my_photo A terisi", async () => {
      const m = await must("A", "profile_my_photo");
      return m.hash ? m : null;
    }, 15000);
    hash1 = mine.hash;
    check("2. A: profile_my_photo berisi hash 64 hex", /^[0-9a-f]{64}$/.test(hash1 ?? ""), hash1 ?? "");
    const side = await waitPhoto("foto A di sidebar A", sel.sideMe(p), pk.A, 15000);
    const sideAny = side === true || (await sel.sideMe(p).locator("img.avatar-img").count()) > 0;
    check("2. A: avatar sidebar berisi img.avatar-img", sideAny, side === true ? "" : side);
    check("2. A: tombol Hapus foto muncul di Pengaturan > Profil", await sel.removePhoto(p).isVisible().catch(() => false));
    await shot("A", "fp-03-a-profil-foto-terang-id.png");
  });

  // ---------- 3. B melihat foto A ----------
  await section("3. Foto A di B", async () => {
    const since = Date.now();
    const listed = await settle("profile_photos B memuat foto A", async () => {
      const list = await must("B", "profile_photos");
      return list.some((e) => e.owner.toLowerCase() === pk.A && e.hash === hash1);
    }, PHOTO_MS);
    check("3. B: profile_photos memuat foto A dengan hash yang sama", listed === true, okText(listed, since));

    const p = page("B");
    await goChannelUmum("B");
    const chat = await waitPhoto("foto A di chat B", sel.chatLog(p), pk.A);
    check("3. B: foto A tampil di pesan A di #umum", chat === true, okText(chat, since));
    await shot("B", "fp-04-b-chat-foto-a-terang-id.png");

    await goProject("B", taskId);
    const board = await waitPhoto("foto A di kartu task B", sel.card(p, taskId), pk.A);
    check("3. B: foto A tampil di kartu task board", board === true, okText(board, since));
    await shot("B", "fp-05-b-board-foto-a-terang-id.png");

    await goOrg("B");
    const org = await waitPhoto("foto A di Organisasi B", sel.orgMain(p), pk.A);
    check("3. B: foto A tampil di Organisasi", org === true, okText(org, since));
    await shot("B", "fp-06-b-organisasi-foto-a-terang-id.png");
  });

  // ---------- 4. Privasi ----------
  await section("4. Privasi foto", async () => {
    const b64 = await must("B", "profile_photo_data", { hash: hash1 });
    const buf = Buffer.from(b64, "base64");
    const size = jpegSize(buf);
    check("4. Foto A di B: JPEG (FF D8 FF)", buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff);
    check("4. Foto A di B: tanpa segmen Exif", !buf.includes(Buffer.from("Exif")));
    check(`4. Foto A di B: tanpa penanda ${GPS_MARKER}`, !buf.includes(Buffer.from(GPS_MARKER)));
    check("4. Foto A di B: di bawah 100 KB", buf.length < MAX_PHOTO, `${buf.length} byte`);
    check("4. Foto A di B: 256x256 piksel", size?.width === 256 && size?.height === 256, JSON.stringify(size));
    const other = await call("B", "profile_photo_data", { hash: "0".repeat(64) });
    check("4. profile_photo_data menolak hash yang bukan foto efektif", !other.ok, other.ok ? "malah berhasil" : other.error?.message ?? "");
  });

  // ---------- 5. Screenshot terang/gelap, Indonesia/Inggris ----------
  await section("5. Screenshot profil dan pemotong", async () => {
    const p = page("A");
    for (const [mode, modeName] of [
      ["light", "terang"],
      ["dark", "gelap"],
    ]) {
      for (const lang of ["id", "en"]) {
        await setLook("A", { mode, lang });
        const htmlLang = await p.evaluate(() => document.documentElement.lang);
        await openProfileSettings("A");
        // Tunggu foto sendiri dan daftar Foto anggota selesai dibaca, supaya screenshot
        // tidak menangkap teks "Membaca foto profil...".
        const loaded = await settle(
          `Pengaturan > Profil A selesai dimuat (${modeName}, ${lang})`,
          async () =>
            (await sel.removePhoto(p).isVisible()) &&
            (await p.locator(".settings-body").getByText(/^(Membaca|Reading) /).count()) === 0,
          20000,
        );
        check(`5. Profil selesai dimuat dengan tombol Hapus foto (${modeName}, ${lang})`, loaded === true, loaded === true ? "" : loaded);
        await sleep(300);
        await shot("A", `fp-10-a-profil-${modeName}-${lang}.png`);
        await sel.changePhoto(p).click();
        const dlg = sel.cropDialog(p);
        const opened = await dlg
          .waitFor({ timeout: 20000 })
          .then(() => true)
          .catch(() => false);
        await sleep(500);
        await shot("A", `fp-11-a-pemotong-${modeName}-${lang}.png`);
        check(`5. Pemotong terbuka (${modeName}, ${lang}, html lang=${htmlLang})`, opened && htmlLang === lang);
        if (opened) {
          await sel.cropCancel(dlg).click();
          await dlg.waitFor({ state: "hidden", timeout: 10000 }).catch(() => {});
        }
      }
    }
    await setLook("A", { mode: "light", lang: "id" });
    const mine = await must("A", "profile_my_photo");
    check("5. Batal di pemotong tidak mengubah foto A", mine.hash === hash1, mine.hash ?? "kosong");
    await setLook("B", { mode: "dark" });
    await goChannelUmum("B");
    await waitPhoto("foto A di chat B (gelap)", sel.chatLog(page("B")), pk.A, 15000);
    await shot("B", "fp-07-b-chat-foto-a-gelap-id.png");
    await setLook("B", { mode: "light" });
  });

  // ---------- 6. A menghapus foto lewat menu profil Shell ----------
  await section("6. Hapus foto", async () => {
    const p = page("A");
    await sel.nav(p, "chat").click();
    await sel.profileMenu(p).click();
    await sel.menuItem(p, "Hapus foto").click({ timeout: 10000 });
    const dlg = sel.confirmRemove(p);
    await dlg.waitFor({ timeout: 10000 });
    await shot("A", "fp-12-a-konfirmasi-hapus-terang-id.png");
    await sel.confirmRemoveBtn(dlg).click();
    await dlg.waitFor({ state: "hidden", timeout: 15000 }).catch(() => {});
    const mine = await settle("profile_my_photo A kosong", async () => (await must("A", "profile_my_photo")).hash === null, 15000);
    check("6. A: profile_my_photo kosong setelah Hapus foto", mine === true, mine === true ? "" : mine);
    const side = await settle("sidebar A tanpa img", async () => (await sel.sideMe(p).locator("img.avatar-img").count()) === 0, 15000);
    check("6. A: avatar sidebar kembali ke inisial", side === true, side === true ? "" : side);

    const since = Date.now();
    const gone = await settle("foto A hilang dari profile_photos B", async () => {
      const list = await must("B", "profile_photos");
      return !list.some((e) => e.owner.toLowerCase() === pk.A);
    }, PHOTO_MS);
    check("6. B: profile_photos tidak lagi memuat foto A", gone === true, okText(gone, since));
    await goChannelUmum("B");
    const init = await waitInitials("avatar A di chat B kembali ke inisial", sel.chatLog(page("B")), pk.A);
    check("6. B: avatar A di #umum kembali ke inisial (tanpa img)", init === true, okText(init, since));
    await shot("B", "fp-08-b-chat-tanpa-foto-terang-id.png");
  });

  // ---------- 7. Offline: B menyusul foto baru ----------
  await section("7. Offline menyusul", async () => {
    await stop("B");
    // Kait MIRA_E2E_PICK_PHOTO menunjuk path yang sama: isi filenya diganti foto kedua.
    writeFileSync(PICK_FILE, photo2());
    const p = page("A");
    await sel.nav(p, "chat").click();
    await sel.profileMenu(p).click();
    await sel.menuItem(p, "Ganti foto").click({ timeout: 10000 });
    const saved = await cropAndSave("A", { shotName: "fp-13-a-pemotong-dari-menu-terang-id.png" });
    if (!saved) throw new Error("Foto kedua A tidak tersimpan");
    const mine = await waitFor("profile_my_photo A berisi foto baru", async () => {
      const m = await must("A", "profile_my_photo");
      return m.hash && m.hash !== hash1 ? m : null;
    }, 15000);
    const hash2 = mine.hash;
    check("7. A (B mati): foto baru dipasang lewat menu profil Shell, hash berbeda", Boolean(hash2) && hash2 !== hash1, hash2);

    const since = Date.now();
    await launch("B");
    await waitShell("B");
    await waitOnline("Setelah B menyala lagi").catch((e) => note(String(e.message)));
    const listed = await settle("B menyusul foto baru A", async () => {
      const list = await must("B", "profile_photos");
      return list.some((e) => e.owner.toLowerCase() === pk.A && e.hash === hash2);
    }, CATCHUP_MS);
    check("7. B menyala lagi: profile_photos memuat foto baru A", listed === true, okText(listed, since));

    await goChannelUmum("B");
    const pb = page("B");
    const chat = await waitPhoto("foto baru A di chat B", sel.chatLog(pb), pk.A, CATCHUP_MS);
    check("7. B: foto baru A tampil di #umum", chat === true, okText(chat, since));
    if (chat === true) {
      const srcUrl = await sel.avatarImg(sel.chatLog(pb), pk.A).first().getAttribute("src");
      const data = await must("B", "profile_photo_data", { hash: hash2 });
      check("7. B: gambar di layar adalah foto baru (data URL sama dengan profile_photo_data)", srcUrl === `data:image/jpeg;base64,${data}`);
    }
    await shot("B", "fp-09-b-chat-foto-baru-terang-id.png");
  });
} catch (err) {
  check("Skrip berjalan tanpa error", false, String(err?.message ?? err).slice(0, 400));
  for (const id of Object.keys(running)) await shot(id, `fp-gagal-${id.toLowerCase()}.png`);
}

// ---- Penutup ----
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
try {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 1000 });
} catch (e) {
  console.log(`Folder data uji belum bisa dihapus: ${root} (${e.code ?? e})`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\nRingkasan: ${results.length - failed.length}/${results.length} pemeriksaan lulus.`);
for (const r of failed) console.log(`  GAGAL  ${r.name}`);
process.exit(failed.length ? 1 : 0);
