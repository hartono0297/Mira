// Uji ujung ke ujung sidebar ringkas dan menu Kalender (docs/plans/sidebar-kalender.md)
// di satu PC Windows.
//
// Instance mira.exe (build debug) dikendalikan lewat Chrome DevTools Protocol
// (playwright-core, connectOverCDP ke WebView2). Semua langkah lewat tampilan
// sungguhan; IPC (window.__TAURI_INTERNALS__.invoke) hanya untuk membaca hasil
// di inti Rust, kecuali undangan Tamu dan bergabungnya laptop Tamu (lihat fase 8).
//
//   A  Rina Uji   superadmin, kantor baru lewat onboarding, dua proyek, task bertenggat
//   B  Tamu Uji   laptop kedua, bergabung sebagai Tamu ke satu proyek saja (fase 8)
//
// Fase:
//   1. Kantor baru (A). Sidebar lebar bawaan. Tombol "Ringkas menu": lebar aside
//      sekitar 64 px, tombol menu tetap bernama, tooltip saat hover dan fokus
//      keyboard, ikon jaringan bernama. Ctrl+B melebarkan, Ctrl+B meringkas lagi.
//      Restart: tetap ringkas (pengaturan shell.sidebar di inti Rust). Lalu dilebarkan.
//   2. Dua proyek (PA milik departemen Desain, PB tanpa departemen) dan task
//      bertenggat lewat board: QuickAdd, lalu tenggat lewat dialog task (Tenggat >
//      Tanggal lain), penanggung jawab lewat menu, satu task dipindah ke Selesai.
//      Tenggat: kemarin (lewat), hari ini (milik saya), besok (dua task), tiga
//      hari lagi (selesai), dan lima hari lagi (delapan task). Jumlah chip per
//      sel bulan mengikuti tinggi baris (1 sampai 6, MonthView.chipLimit), jadi
//      delapan task selalu memunculkan "+N lagi".
//   3. Kalender: chip di sel data-cal-day yang benar, penanda lewat tenggat, "+N
//      lagi" membuka DayMore berisi kedelapan task, Esc menutup dan fokus kembali.
//      Minggu dan Agenda (grup "Lewat tenggat"). Sebelumnya, Berikutnya, Hari ini.
//   4. Saringan: Task saya, satu proyek, Tampilkan yang selesai.
//   5. Klik chip membuka detail task; tutup mengembalikan fokus ke chip.
//   6. Seret chip dengan mouse (page.mouse tekan, gerak bertahap, lepas) ke hari
//      lain; setelah muat ulang chip di hari baru dan detail task menampilkan
//      tenggat baru. Alt+Panah kanan memajukan tenggat sehari. Klik kanan > Besok.
//   7. Bahasa Inggris lewat Pengaturan > Bahasa: judul bulan dan nama hari Inggris,
//      screenshot, lalu kembali ke Bahasa Indonesia. Tema terang dan gelap.
//   8. Tamu (B): bergabung dengan kode undangan Tamu untuk proyek PA saja. Kalender
//      B hanya berisi task PA; chip B tidak bisa diseret, Alt+Panah mengumumkan
//      "tidak berhak" tanpa memanggil board_update_task, menu klik kanan nonaktif.
//
// Screenshot: NN-deskripsi-terang.png / NN-deskripsi-gelap.png di folder screenshot
// (bawaan docs/progress/screenshots/sidebar-kalender).
//
// Pakai:  node scripts/sidebar-kalender-e2e.mjs <path mira.exe> [folder screenshot]
// Port:   A: CDP 9471, MIRA_PORT 47971. B: CDP 9472, MIRA_PORT 47972. Semua
//         digeser E2E_PORT_OFFSET (misalnya 1900: CDP 11371/11372, QUIC 49871/49872).
// Data:   folder mira-sidebar-kalender-* di bawah %TEMP%, dihapus di akhir. Hanya
//         kredensial laptop uji milik skrip ini (ourKeys) yang dihapus dari Windows
//         Credential Manager, dan hanya proses yang dijalankan skrip ini yang ditutup.
//
// mDNS: A dan B berjalan dengan MIRA_DISABLE_MDNS=1. A perlu itu supaya layar
// "Kantor belum ditemukan" tidak terganggu Mira lain di PC ini, dan supaya kantor
// uji tidak diumumkan ke uji lain yang sedang berjalan. Di fase 8 kedua laptop
// saling kenal lewat alamat manual (join_with_code dengan alamat A, lalu
// add_manual_address di A), jadi tidak bergantung pada mDNS.
//
// Fase 8 bisa diulang:
//   SK_E2E_GUEST=0              lewati fase 8.
//   SK_E2E_GUEST_TRIES=N        jumlah percobaan fase 8 (bawaan 2). Setiap percobaan
//                               memakai laptop B baru dan undangan baru; hanya hasil
//                               percobaan terakhir yang dihitung.
//   SK_E2E_GUEST_MDNS=1         fase 8 dengan mDNS menyala (A dijalankan ulang tanpa
//                               MIRA_DISABLE_MDNS). Bisa terganggu uji lain di PC ini.
//   SK_E2E_KEEP_DATA=1          folder data dan kunci laptop A tidak dihapus di akhir,
//                               supaya fase 8 bisa diulang sendiri:
//   SK_E2E_GUEST_ONLY=<folder>  pakai folder data yang disimpan tadi, lewati fase 1-7,
//                               jalankan fase 8 saja. Di akhir folder dan kunci dihapus
//                               (kecuali SK_E2E_KEEP_DATA=1 lagi).
//
// Butuh:  playwright-core (alat uji saja, tidak dibundel ke aplikasi).

import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { mainNav, newOffice } from "./e2e-onboarding.mjs";

const exe = resolve(process.argv[2] ?? "src-tauri/target/debug/mira.exe");
const shots = resolve(process.argv[3] ?? "docs/progress/screenshots/sidebar-kalender");
mkdirSync(shots, { recursive: true });

const GUEST_ONLY = process.env.SK_E2E_GUEST_ONLY ? resolve(process.env.SK_E2E_GUEST_ONLY) : null;
const KEEP_DATA = process.env.SK_E2E_KEEP_DATA === "1";
const RUN_GUEST = process.env.SK_E2E_GUEST !== "0";
const GUEST_TRIES = Math.max(1, Number(process.env.SK_E2E_GUEST_TRIES ?? 2) || 2);
const GUEST_MDNS = process.env.SK_E2E_GUEST_MDNS === "1";

const tempParent = resolve(process.env.TEMP ?? tmpdir());
mkdirSync(tempParent, { recursive: true });
const root = GUEST_ONLY ?? mkdtempSync(join(tempParent, "mira-sidebar-kalender-"));
if (GUEST_ONLY && !existsSync(join(root, "laptop-a"))) {
  console.log(`SK_E2E_GUEST_ONLY: folder ${join(root, "laptop-a")} tidak ada.`);
  process.exit(1);
}

const PORT_OFFSET = Number(process.env.E2E_PORT_OFFSET ?? 0) || 0;
const NODES = {
  A: { id: "A", name: "Rina Uji", port: 47971 + PORT_OFFSET, cdp: 9471 + PORT_OFFSET, dir: join(root, "laptop-a") },
  B: { id: "B", name: "Tamu Uji", port: 47972 + PORT_OFFSET, cdp: 9472 + PORT_OFFSET, dir: join(root, "laptop-b") },
};
const addr = (node) => `127.0.0.1:${node.port}`;

// ----- Data uji -------------------------------------------------------------------
const ORG = "Kantor Uji Kalender";
const DEPT = "Desain";
const PA = { name: "Proyek Alfa", code: "PA", dept: DEPT };
const PB = { name: "Proyek Beta", code: "PB", dept: "Tanpa departemen" };

// Teks Indonesia dan Inggris yang dicari skrip. Sumber: src/i18n/shell.*.ts,
// calendar.*.ts, calendar-view.*.ts, settings.*.ts, board-*.id.ts.
const TX = {
  calendar: "Kalender",
  collapse: "Ringkas menu",
  expand: "Lebarkan menu",
  navIds: ["Chat", "Board", "Kalender", "Dokumen", "Tanda tangan", "Organisasi", "Pengaturan"],
  prevMonth: "Bulan sebelumnya",
  nextMonth: "Bulan berikutnya",
  prevWeek: "Minggu sebelumnya",
  nextWeek: "Minggu berikutnya",
  today: "Hari ini",
  viewGroup: "Tampilan",
  views: { month: "Bulan", week: "Minggu", agenda: "Agenda" },
  scopeLabel: "Lihat",
  showDone: "Tampilkan yang selesai",
  overdueGroup: "Lewat tenggat",
  overdueSr: ", lewat tenggat",
  doneSr: ", selesai",
  more: (n) => `+${n} lagi`,
  menuLabel: (code) => `Pindahkan tenggat ${code} ke`,
  moved: (code) => `Tenggat ${code} dipindah ke`,
  noRight: "Anda tidak berhak mengubah tenggat task ini.",
  weekWord: "sampai",
};
const EN = {
  mainMenu: "Main menu",
  calendar: "Calendar",
  settings: "Settings",
  languagePart: "Language",
  overdueGroup: "Overdue",
  overdueSr: ", overdue",
  weekWord: "to",
};
const MONTHS_ID = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS_ID = ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"];
const WEEKDAYS_EN = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// Bulan singkat di detail task (TEKS.tanggal.bulan di board.id.ts).
const MONTHS_SHORT_ID = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

// ----- Tanggal (waktu lokal, YYYY-MM-DD) ------------------------------------------
function toIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fromIso(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addDaysIso(iso, n) {
  const d = fromIso(iso);
  d.setDate(d.getDate() + n);
  return toIso(d);
}
const isoDate = (offset) => addDaysIso(toIso(new Date()), offset);
// Format isian "Tanggal lain" di pilihan Tenggat: hh/bb/tttt.
const dmy = (iso) => {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};
const mondayOf = (iso) => addDaysIso(iso, -((fromIso(iso).getDay() + 6) % 7));
const monthIndex = (iso) => fromIso(iso).getFullYear() * 12 + fromIso(iso).getMonth();
function monthTitleOf(iso, months) {
  const d = fromIso(iso);
  return `${months[d.getMonth()]} ${d.getFullYear()}`;
}
function monthTitleShift(iso, n, months) {
  const d = fromIso(iso);
  const s = new Date(d.getFullYear(), d.getMonth() + n, 1);
  return `${months[s.getMonth()]} ${s.getFullYear()}`;
}

const TODAY = isoDate(0);
const D = {
  yesterday: isoDate(-1),
  today: TODAY,
  tomorrow: isoDate(1),
  doneDay: isoDate(3),
  busy: isoDate(5),
};

// Task per proyek. mine: penanggung jawab saya. done: dipindah ke Selesai.
const TASKS = {
  PA: [
    { title: "Rapat mingguan klien", due: D.today, mine: true },
    { title: "Kirim revisi gambar", due: D.tomorrow },
    { title: "Bayar tagihan vendor", due: D.yesterday },
    { title: "Arsipkan dokumen lama", due: D.doneDay, done: true },
    { title: "Cek RAB lantai 1", due: D.busy },
    { title: "Cek RAB lantai 2", due: D.busy },
    { title: "Cek RAB lantai 3", due: D.busy },
    { title: "Cek RAB lantai 4", due: D.busy },
    { title: "Cek RAB lantai 5", due: D.busy },
  ],
  PB: [
    { title: "Pesan material B", due: D.tomorrow },
    { title: "Survei lokasi B", due: D.busy },
    { title: "Foto progres B", due: D.busy },
  ],
};
const T_MINE = "Rapat mingguan klien";
const T_OVERDUE = "Bayar tagihan vendor";
const T_DONE = "Arsipkan dokumen lama";
const T_DRAG = "Kirim revisi gambar";
const T_KEYS = "Pesan material B";

// ----- Hasil ------------------------------------------------------------------------
const results = [];
// Fase 8 menulis ke daftar percobaan dulu; hanya percobaan terakhir yang masuk hasil.
let sink = results;
let prefix = "";
function check(name, ok, detail = "") {
  sink.push({ name, ok, detail });
  console.log(`${prefix}${ok ? "LULUS" : "GAGAL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const note = (msg) => console.log(`CATATAN  ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (err) => String(err?.message ?? err).slice(0, 300);

async function poll(fn, timeout = 10000, every = 250) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch {
      /* dicoba lagi */
    }
    await sleep(every);
  }
  return last ?? null;
}

// ----- Kredensial: hanya kunci laptop uji milik skrip ini ---------------------------
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
const keyOwner = {};

async function rememberKey(app) {
  try {
    const st = await app.page.evaluate(() => window.__TAURI_INTERNALS__.invoke("get_app_state"));
    const key = st?.identity?.publicKey?.toLowerCase();
    if (key) {
      ourKeys.add(key);
      keyOwner[key] = app.node.id;
    }
  } catch {
    /* dicoba lagi setelah kantor dibuat */
  }
}

// ----- Proses ----------------------------------------------------------------------
const running = new Set();

async function launch(node, { mdns = false } = {}) {
  mkdirSync(node.dir, { recursive: true });
  const log = createWriteStream(join(root, `${node.id}-stderr.log`), { flags: "a" });
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      MIRA_DATA_DIR: node.dir,
      MIRA_PORT: String(node.port),
      ...(mdns ? {} : { MIRA_DISABLE_MDNS: "1" }),
      // Cek pembaruan diarahkan ke alamat mati: tidak ada panggilan internet atau dialog pembaruan.
      MIRA_UPDATER_ENDPOINT: "http://127.0.0.1:9/latest.json",
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${node.cdp}`,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.pipe(log);
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
    killTree(child);
    throw new Error(`WebView2 ${node.id} tidak bisa dihubungi lewat CDP (port ${node.cdp})`);
  }
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages())[0];
    if (!page) await sleep(250);
  }
  const app = { node, child, browser, page, exited, ipc: [] };
  watchIpc(app);
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => "__TAURI_INTERNALS__" in window, null, { timeout: 20000 });
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  running.add(app);
  await rememberKey(app);
  return app;
}

function killTree(child) {
  try {
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* sudah berhenti */
  }
}

// Tutup wajar dulu (WM_CLOSE), baru dipaksa. Hanya pohon proses yang dijalankan skrip ini.
async function stop(app) {
  if (!app || !running.has(app)) return;
  running.delete(app);
  await app.browser.close().catch(() => {});
  try {
    execFileSync("taskkill", ["/PID", String(app.child.pid), "/T"], { stdio: "ignore" });
  } catch {
    /* mungkin sudah berhenti */
  }
  const done = await Promise.race([app.exited.then(() => true), sleep(10000).then(() => false)]);
  if (!done) killTree(app.child);
  await sleep(1500);
}

// Di Windows, Tauri 2 mengirim IPC lewat fetch ke http://ipc.localhost/<command>,
// jadi tiap panggilan terlihat sebagai request di CDP (lihat board-sync-e2e.mjs).
function watchIpc(app) {
  app.page.on("request", (req) => {
    try {
      const u = new URL(req.url());
      if (u.hostname === "ipc.localhost" || u.protocol === "ipc:") {
        app.ipc.push({ cmd: decodeURIComponent(u.pathname.replace(/^\//, "")), at: Date.now() });
      }
    } catch {
      /* bukan URL biasa */
    }
  });
}
const ipcSince = (app, t0, cmd) => app.ipc.filter((e) => e.at >= t0 && e.cmd === cmd);

async function call(page, cmd, args = {}) {
  return page.evaluate(
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
async function must(page, cmd, args) {
  const r = await call(page, cmd, args);
  if (!r.ok) throw new Error(`${cmd}: ${JSON.stringify(r.error)}`);
  return r.value;
}

const shot = (page, file) => page.screenshot({ path: join(shots, file) }).catch((e) => note(`screenshot ${file} gagal: ${errText(e)}`));

// ----- Kerangka dan pengaturan -------------------------------------------------------
const ANY_MAIN = /^(Menu utama|Main menu)$/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Tombol menu utama dalam bahasa apa pun: nama diawali salah satu label.
const navAny = (page, ...names) =>
  page.getByRole("navigation", { name: ANY_MAIN }).getByRole("button", { name: new RegExp(`^(${names.map(escapeRe).join("|")})\\s*(,|$)`) });
const aside = (page) => page.locator("#main-sidebar");
const sidebarToggle = (page) => aside(page).locator("button.side-toggle");
const tooltip = (page) => page.locator('[role="tooltip"].nav-tip');

async function asideWidth(page) {
  await sleep(450); // animasi 160 ms
  const b = await aside(page).boundingBox();
  return b ? Math.round(b.width) : -1;
}
const isCollapsed = (page) => page.locator(".shell").evaluate((el) => el.classList.contains("side-collapsed"));

async function waitShell(page, timeout = 30000) {
  await page.getByRole("navigation", { name: ANY_MAIN }).waitFor({ timeout });
}

async function openSettingsPart(page, partId, partEn) {
  await navAny(page, "Pengaturan", EN.settings).click();
  await page.locator("ul.settings-nav").getByRole("button", { name: new RegExp(`^(${partId}|${partEn})$`) }).click();
  await sleep(300);
}

// Tema lewat Pengaturan > Tampilan, lalu kembali ke Kalender.
async function setTheme(page, mode) {
  await openSettingsPart(page, "Tampilan", "Appearance");
  await page.getByLabel(mode === "dark" ? /^(Gelap|Dark)$/ : /^(Terang|Light)$/).check();
  await sleep(400);
}

async function setLanguage(page, english) {
  await openSettingsPart(page, "Bahasa", EN.languagePart);
  await page
    .locator(".lang-picker-full")
    .getByRole("radio", { name: english ? "English" : "Bahasa Indonesia", exact: true })
    .check();
  await navAny(page, english ? EN.settings : "Pengaturan").waitFor({ timeout: 5000 }).catch(() => {});
  await sleep(400);
}

// ----- Board -------------------------------------------------------------------------
const projectNav = (page) => page.getByRole("navigation", { name: "Task saya dan proyek" });
const column = (page, name) => page.locator("section.pb-col").filter({ has: page.getByRole("heading", { name }) });
const taskDialog = (page) =>
  page.getByRole("dialog").filter({ has: page.getByRole("button", { name: /^(Tutup detail task|Close task details)$/ }) });
const prop = (dlg, label) =>
  dlg.getByRole("group", { name: "Rincian task" }).getByRole("button", { name: new RegExp(`^${label}(\\s|$)`) });

async function openProject(page, name) {
  await projectNav(page).getByRole("button", { name: new RegExp(name) }).click();
  await page.getByRole("button", { name: "Task baru" }).waitFor({ timeout: 10000 });
}

async function createProject(page, p, first) {
  await mainNav(page, "Board").click();
  if (first) {
    await page.getByRole("button", { name: "Buat proyek pertama" }).click({ timeout: 15000 });
  } else {
    await projectNav(page).getByRole("button", { name: "Proyek baru" }).click({ timeout: 15000 });
  }
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Nama proyek").fill(p.name);
  await dlg.getByLabel("Kode proyek").fill(p.code);
  // Label "Departemen" baru terhubung setelah data organisasi terbaca; selectOption menunggu opsinya.
  await dlg.getByLabel("Departemen", { exact: true }).selectOption({ label: p.dept });
  await dlg.getByRole("button", { name: "Buat proyek", exact: true }).click();
  await dlg.waitFor({ state: "detached", timeout: 10000 }).catch(() => {});
  await page.getByRole("button", { name: "Task baru" }).waitFor({ timeout: 10000 });
}

async function quickAdd(page, titles) {
  await column(page, "To do").getByRole("button", { name: "Tambah task" }).click();
  for (const t of titles) {
    const input = column(page, "To do").getByLabel(/Judul task baru/);
    await input.fill(t);
    await input.press("Enter");
    await sleep(300);
  }
  await column(page, "To do").getByLabel(/Judul task baru/).press("Escape");
}

async function openTaskDialog(page, title) {
  await page.locator("section.pb-col [data-open-task]", { hasText: title }).click();
  const dlg = taskDialog(page);
  await dlg.getByRole("textbox", { name: "Judul task", exact: true }).waitFor({ timeout: 10000 });
  return dlg;
}

async function closeTaskDialog(page) {
  const dlg = taskDialog(page);
  await dlg.getByRole("button", { name: /^(Tutup detail task|Close task details)$/ }).click();
  await dlg.waitFor({ state: "detached", timeout: 5000 });
  await sleep(300);
}

// Tenggat lewat isian "Tanggal lain" (hh/bb/tttt) lalu Pakai.
async function pickDueTyped(page, dlg, iso) {
  await prop(dlg, "Tenggat").click();
  const pop = dlg.getByRole("dialog", { name: "Tenggat", exact: true });
  await pop.getByRole("textbox", { name: "Tanggal lain" }).fill(dmy(iso));
  await pop.getByRole("button", { name: "Pakai", exact: true }).click();
  await pop.waitFor({ state: "detached", timeout: 5000 });
  await sleep(300);
}

async function assignToMe(page, dlg, name) {
  await prop(dlg, "Penanggung jawab").click();
  const menu = dlg.getByRole("menu", { name: "Penanggung jawab", exact: true });
  await menu.getByRole("menuitemradio", { name: new RegExp(`^${escapeRe(name)}`) }).click();
  await menu.waitFor({ state: "detached", timeout: 5000 });
  await sleep(300);
}

// ----- Kalender ------------------------------------------------------------------------
const cal = (page) => page.locator("section.cal");
const calTitle = async (page) => (await page.locator("h1.cal-title").innerText()).trim();
const prevBtn = (page) => page.locator(".cal-nav .cal-icon-btn").first();
const nextBtn = (page) => page.locator(".cal-nav .cal-icon-btn").nth(1);
const todayBtn = (page) => page.locator(".cal-nav .cal-today");
const viewBtn = (page, label) => page.locator(".cal-switch").getByRole("button", { name: label, exact: true });
const scopeSelect = (page) => page.locator(".cal-scope select");
const doneBox = (page) => page.locator(".cal-done input[type=checkbox]");
const monthCell = (page, day) => page.locator(`.cv-month td[data-cal-day="${day}"]`);
const chipIn = (scope, key) => scope.locator(`[data-cal-task="${key}"]`);
const say = (page) => page.locator('[data-testid="cal-say"]');

async function settled(page) {
  await page
    .waitForFunction(() => document.querySelector(".cal-body")?.getAttribute("aria-busy") === "false", null, { timeout: 15000 })
    .catch(() => {});
  await sleep(350);
}

async function openCalendar(page) {
  await navAny(page, TX.calendar, EN.calendar).click();
  await cal(page).waitFor({ timeout: 15000 });
  await settled(page);
}

async function setView(page, view) {
  const label = {
    month: /^(Bulan|Month)$/,
    week: /^(Minggu|Week)$/,
    agenda: /^(Agenda)$/,
  }[view];
  await page.locator(".cal-switch").getByRole("button", { name: label }).click();
  await settled(page);
}

// Bulan yang memuat `iso`: Hari ini, lalu Berikutnya/Sebelumnya sebanyak selisih bulan.
async function showMonthOf(page, iso) {
  await todayBtn(page).click();
  await settled(page);
  const diff = monthIndex(iso) - monthIndex(TODAY);
  for (let i = 0; i < Math.abs(diff); i++) {
    await (diff > 0 ? nextBtn(page) : prevBtn(page)).click();
    await settled(page);
  }
}

// Kunci chip di sel tabel bulan (bukan di DayMore, bukan bayangan seret).
const monthKeys = (page) =>
  page.locator(".cv-month td[data-cal-day] [data-cal-task]").evaluateAll((els) => els.map((e) => e.getAttribute("data-cal-task")));

// Hari (data-cal-day) tempat chip `key` berada di tabel bulan, atau null. Chip
// yang tidak muat di sel (di balik "+N lagi") dicari dengan membuka DayMore
// setiap sel yang punya tombol itu, lalu Esc.
async function chipDay(page, key) {
  const direct = await page.evaluate((k) => {
    const chip = [...document.querySelectorAll(".cv-month td[data-cal-day] [data-cal-task]")].find((e) => e.getAttribute("data-cal-task") === k);
    return chip?.closest("[data-cal-day]")?.getAttribute("data-cal-day") ?? null;
  }, key);
  if (direct) return direct;
  const days = await page.locator(".cv-month td[data-cal-day]:has(.cv-more-btn)").evaluateAll((els) => els.map((e) => e.getAttribute("data-cal-day")));
  for (const day of days) {
    await monthCell(page, day).locator(".cv-more-btn").click();
    const panel = page.locator(".cv-more[role=dialog]");
    await panel.waitFor({ timeout: 3000 }).catch(() => {});
    const found = (await chipIn(panel, key).count()) > 0;
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "detached", timeout: 3000 }).catch(() => {});
    if (found) return day;
  }
  return null;
}

// Gabungan kunci chip dari bulan-bulan yang memuat `days`. Dibaca dari Agenda,
// yang menampilkan semua task tanpa batas chip per sel; lalu kembali ke Bulan.
async function keysAcross(page, days) {
  const months = [...new Set(days.map((d) => monthIndex(d)))].sort((a, b) => a - b);
  const all = new Set();
  await setView(page, "agenda");
  for (const m of months) {
    const sample = days.find((d) => monthIndex(d) === m);
    await showMonthOf(page, sample);
    const keys = await page.locator(".cv-agenda [data-cal-task]").evaluateAll((els) => els.map((e) => e.getAttribute("data-cal-task")));
    for (const k of keys) all.add(k);
  }
  await setView(page, "month");
  await showMonthOf(page, TODAY);
  return all;
}

const focusedKey = (page) => page.evaluate(() => document.activeElement?.getAttribute("data-cal-task") ?? null);
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

// ===================================================================================
const ctx = {
  me: null,
  pk: {}, // kode -> proyek
  task: {}, // judul -> { projectId, id, code, key }
};

async function loadIds(page) {
  ctx.me = (await must(page, "get_app_state")).identity.publicKey;
  const projects = await must(page, "board_list_projects");
  for (const p of [PA, PB]) {
    const found = projects.find((x) => x.code === p.code);
    if (!found) throw new Error(`Proyek ${p.code} tidak ada di laptop A`);
    ctx.pk[p.code] = found;
    const board = await must(page, "board_get_board", { projectId: found.id });
    for (const t of board.columns.flatMap((c) => c.tasks)) {
      ctx.task[t.title] = { projectId: found.id, id: t.id, code: t.code, key: `${found.id}/${t.id}` };
    }
  }
}
const keyOf = (title) => ctx.task[title].key;
const getTask = (page, title) => must(page, "board_get_task", { projectId: ctx.task[title].projectId, taskId: ctx.task[title].id });

// Satu bagian uji: error dicatat GAGAL, bagian berikutnya tetap jalan.
async function part(page, name, fn) {
  try {
    await fn();
  } catch (err) {
    check(`${name}: berjalan tanpa error`, false, errText(err));
    await shot(page, `gagal-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40)}.png`);
    for (let i = 0; i < 3; i++) await page.keyboard.press("Escape").catch(() => {});
    if ((await taskDialog(page).count().catch(() => 0)) > 0) await closeTaskDialog(page).catch(() => {});
  }
}

let A = null;

async function phasesOneToSeven() {
  // ---------- 1. Kantor baru dan sidebar ----------
  A = await launch(NODES.A);
  let page = A.page;
  await newOffice(page, { name: NODES.A.name, org: ORG, dept: DEPT });
  await waitShell(page);
  await rememberKey(A);
  await setTheme(page, "light");
  check("1. Kantor baru dibuat lewat onboarding", true);

  await part(page, "1. Sidebar ringkas", async () => {
    const navNames = await page
      .getByRole("navigation", { name: ANY_MAIN })
      .getByRole("button")
      .evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim()));
    const iBoard = navNames.findIndex((n) => n.startsWith("Board"));
    const iCal = navNames.findIndex((n) => n.startsWith(TX.calendar));
    check("1. Menu Kalender ada di sidebar tepat setelah Board", iBoard >= 0 && iCal === iBoard + 1, navNames.join(" | "));

    const wide = await asideWidth(page);
    const toggle = sidebarToggle(page);
    // Keadaan disampaikan lewat nama tombol yang berganti, tanpa aria-expanded (SidebarToggle.tsx).
    const wideState = {
      collapsed: await isCollapsed(page),
      label: await toggle.getAttribute("aria-label"),
      controls: await toggle.getAttribute("aria-controls"),
      keys: await toggle.getAttribute("aria-keyshortcuts"),
    };
    check(
      "1. Sidebar lebar bawaan: tombol 'Ringkas menu', aria-controls main-sidebar, aria-keyshortcuts Control+B",
      !wideState.collapsed && wide > 150 && wideState.label === TX.collapse && wideState.controls === "main-sidebar" && wideState.keys === "Control+B",
      `lebar=${wide}px, ${JSON.stringify(wideState)}`,
    );
    await shot(page, "01-sidebar-lebar-terang.png");

    await toggle.click();
    const narrow = await asideWidth(page);
    const missing = [];
    for (const n of TX.navIds) {
      const b = navAny(page, n);
      if ((await b.count()) !== 1 || !(await b.isVisible())) missing.push(n);
    }
    const labelHidden = await page.locator(".side-label").first().evaluate((el) => el.getBoundingClientRect().width <= 1);
    check(
      "1. Tombol meringkas: aside sekitar 64 px, label teks tersembunyi, ketujuh tombol menu tetap bernama",
      (await isCollapsed(page)) && Math.abs(narrow - 64) <= 6 && labelHidden && missing.length === 0,
      `lebar=${narrow}px, tanpa nama: ${missing.join(", ") || "-"}`,
    );
    check("1. Nama tombol berganti jadi 'Lebarkan menu'", (await toggle.getAttribute("aria-label")) === TX.expand);
    const stored = await poll(async () => {
      const r = await call(page, "get_setting", { key: "shell.sidebar" });
      return r.ok && r.value === "collapsed" ? r.value : null;
    }, 5000);
    check("1. Pilihan ringkas tersimpan di pengaturan inti shell.sidebar", stored === "collapsed", String(stored));

    // Tooltip saat hover di ikon Kalender.
    await navAny(page, TX.calendar).hover();
    const hoverTip = await poll(async () => ((await tooltip(page).isVisible()) ? (await tooltip(page).innerText()).trim() : null), 3000);
    check("1. Hover ikon Kalender saat ringkas memunculkan tooltip 'Kalender'", hoverTip === TX.calendar, String(hoverTip));
    await shot(page, "03-sidebar-ringkas-tooltip-terang.png");

    // Tooltip saat fokus keyboard: kursor keluar dari sidebar, fokus tombol, lalu Tab.
    await page.mouse.move(900, 500);
    await sleep(200);
    await toggle.focus();
    const toggleTip = await poll(async () => ((await tooltip(page).isVisible()) ? (await tooltip(page).innerText()).trim() : null), 3000);
    await page.keyboard.press("Tab");
    const tabTip = await poll(async () => ((await tooltip(page).isVisible()) ? (await tooltip(page).innerText()).trim() : null), 3000);
    check(
      "1. Fokus keyboard memunculkan tooltip: tombol ringkas dengan pintasan, lalu Tab ke menu Chat",
      toggleTip === `${TX.expand} (Ctrl+B)` && /^Chat\b/.test(tabTip ?? ""),
      `${toggleTip} / ${tabTip}`,
    );
    await page.keyboard.press("Escape");
    const stillChat = await page.evaluate(() => /^Chat\b/.test((document.activeElement?.textContent ?? "").trim()));
    check("1. Esc menutup tooltip tanpa memindah fokus", !(await tooltip(page).isVisible().catch(() => false)) && stillChat);

    const dot = page.locator(".side-net-dot button");
    const dotLabel = (await dot.getAttribute("aria-label").catch(() => "")) ?? "";
    // "Buka Organisasi", atau "Coba baca lagi" kalau status jaringan belum terbaca (NetworkDot.tsx).
    check(
      "1. Panel jaringan ringkas jadi satu ikon bernama status + 'Buka Organisasi'",
      (await dot.count()) === 1 && /\. (Buka Organisasi|Coba baca lagi)$/.test(dotLabel),
      dotLabel,
    );
    await shot(page, "02-sidebar-ringkas-terang.png");

    // Ctrl+B dua kali, dengan fokus di tombol menu Chat (pintasan dipasang di window).
    await page.keyboard.press("Control+B");
    const afterB1 = { collapsed: await isCollapsed(page), width: await asideWidth(page) };
    await page.keyboard.press("Control+B");
    const afterB2 = { collapsed: await isCollapsed(page), width: await asideWidth(page) };
    check(
      "1. Ctrl+B melebarkan, Ctrl+B lagi meringkas",
      !afterB1.collapsed && afterB1.width > 150 && afterB2.collapsed && Math.abs(afterB2.width - 64) <= 6,
      `${JSON.stringify(afterB1)} -> ${JSON.stringify(afterB2)}`,
    );
  });

  // Restart: tetap ringkas.
  await stop(A);
  A = await launch(NODES.A);
  page = A.page;
  await waitShell(page);
  await sleep(1200); // pengaturan inti dibaca setelah frame pertama
  await part(page, "1. Restart", async () => {
    const width = await asideWidth(page);
    const stored = await call(page, "get_setting", { key: "shell.sidebar" });
    check(
      "1. Setelah restart sidebar tetap ringkas (pengaturan inti shell.sidebar)",
      (await isCollapsed(page)) && Math.abs(width - 64) <= 6 && stored.value === "collapsed",
      `lebar=${width}px, setting=${stored.value}`,
    );
    await shot(page, "04-sidebar-ringkas-setelah-restart-terang.png");
    await sidebarToggle(page).click();
    check("1. Tombol 'Lebarkan menu' melebarkan lagi", !(await isCollapsed(page)) && (await asideWidth(page)) > 150);
  });

  // ---------- 2. Proyek dan task bertenggat lewat board ----------
  await createProject(page, PA, true);
  await quickAdd(page, TASKS.PA.map((t) => t.title));
  await createProject(page, PB, false);
  await quickAdd(page, TASKS.PB.map((t) => t.title));
  await loadIds(page);
  const created = Object.keys(ctx.task).length;
  const wantCount = TASKS.PA.length + TASKS.PB.length;
  check(`2. Dua proyek (PA milik Desain, PB tanpa departemen) dan ${wantCount} task dibuat lewat board`, created === wantCount, `${created} task`);

  for (const [code, p] of [["PA", PA], ["PB", PB]]) {
    await openProject(page, p.name);
    for (const t of TASKS[code]) {
      try {
        const dlg = await openTaskDialog(page, t.title);
        await pickDueTyped(page, dlg, t.due);
        if (t.mine) await assignToMe(page, dlg, NODES.A.name);
        await closeTaskDialog(page);
      } catch (err) {
        note(`tenggat ${t.title} lewat dialog gagal (${errText(err)}); dipasang lewat IPC`);
        if ((await taskDialog(page).count()) > 0) await closeTaskDialog(page).catch(() => page.keyboard.press("Escape"));
        const info = ctx.task[t.title];
        await must(page, "board_update_task", {
          projectId: info.projectId,
          taskId: info.id,
          patch: { due: t.due, ...(t.mine ? { assignee: ctx.me } : {}) },
        });
      }
      if (t.done) {
        await page.getByRole("button", { name: `Pindahkan ${ctx.task[t.title].code}` }).click();
        await page.getByRole("menuitem", { name: "Ke Selesai" }).click();
        await sleep(500);
      }
    }
  }
  {
    const wrong = [];
    for (const [code, list] of Object.entries(TASKS)) {
      for (const t of list) {
        const d = await getTask(page, t.title);
        const ok = d.due === t.due && (!t.mine || d.assignee?.publicKey === ctx.me) && (!t.done || d.columnId === "done");
        if (!ok) wrong.push(`${code} ${t.title}: due=${d.due} col=${d.columnId} pj=${d.assignee?.name ?? "-"}`);
      }
    }
    check("2. Tenggat, penanggung jawab, dan kolom Selesai tersimpan di inti", wrong.length === 0, wrong.join(" | "));
  }
  await openProject(page, PA.name);
  await shot(page, "05-board-tenggat-terang.png");

  // ---------- 3. Kalender: Bulan, DayMore, Minggu, Agenda, navigasi ----------
  await openCalendar(page);
  await part(page, "3. Bulan", async () => {
    await setView(page, "month");
    await todayBtn(page).click();
    await settled(page);
    const title = await calTitle(page);
    const todayCell = await page.locator('.cv-month td[aria-current="date"]').getAttribute("data-cal-day");
    const heads = (await page.locator(".cv-month th.cv-th").allInnerTexts()).map((s) => s.trim());
    check(
      "3. Bulan: judul bulan ini, sel hari ini aria-current=date, nama hari Sen..Min",
      title === monthTitleOf(TODAY, MONTHS_ID) && todayCell === TODAY && heads.join(",") === WEEKDAYS_ID.join(","),
      `${title}; hari ini=${todayCell}; ${heads.join(",")}`,
    );
    // Chip berada di sel yang benar (bulan yang memuat tenggatnya).
    const misplaced = [];
    for (const [title2, day] of [[T_MINE, D.today], [T_DRAG, D.tomorrow], [T_KEYS, D.tomorrow], [T_OVERDUE, D.yesterday]]) {
      await showMonthOf(page, day);
      const at = await chipDay(page, keyOf(title2));
      if (at !== day) misplaced.push(`${title2}: ${at} bukan ${day}`);
    }
    check("3. Chip task tampil di sel data-cal-day sesuai tenggat", misplaced.length === 0, misplaced.join(" | "));

    await showMonthOf(page, D.yesterday);
    const late = chipIn(monthCell(page, D.yesterday), keyOf(T_OVERDUE));
    const lateInfo = {
      cls: await late.evaluate((el) => el.classList.contains("cc-late")),
      icon: (await late.locator(".cc-icon").count()) === 1,
      label: (await late.getAttribute("aria-label")) ?? "",
    };
    const todayChip = chipIn(monthCell(page, D.today), keyOf(T_MINE));
    await showMonthOf(page, D.today);
    const todayLabel = (await todayChip.getAttribute("aria-label").catch(() => "")) ?? "";
    check(
      "3. Chip lewat tenggat bertanda: kelas cc-late, ikon, nama aksesibel '..., lewat tenggat'; chip hari ini tanpa tanda",
      lateInfo.cls && lateInfo.icon && lateInfo.label.endsWith(TX.overdueSr) && lateInfo.label.includes(ctx.task[T_OVERDUE].code) && !todayLabel.includes(TX.overdueSr),
      `${lateInfo.label} / ${todayLabel}`,
    );
    const doneHidden = !(await keysAcross(page, [D.doneDay])).has(keyOf(T_DONE));
    check("3. Task Selesai tidak tampil selama 'Tampilkan yang selesai' mati", doneHidden);
    await showMonthOf(page, D.today);
    await shot(page, "06-kalender-bulan-terang.png");
  });

  await part(page, "3. DayMore", async () => {
    await showMonthOf(page, D.busy);
    const cell = monthCell(page, D.busy);
    const total = [...TASKS.PA, ...TASKS.PB].filter((t) => t.due === D.busy).length;
    const shown = await cell.locator("[data-cal-task]").count();
    const more = cell.locator(".cv-more-btn");
    const moreText = (await more.innerText()).trim();
    const moreName = (await more.getAttribute("aria-label")) ?? "";
    check(
      `3. Hari ramai (${total} task): chip sebanyak yang muat (1 sampai 6), lalu '+N lagi' untuk sisanya`,
      shown >= 1 && shown <= 6 && moreText === TX.more(total - shown) && moreName.startsWith(`${total - shown} task lagi`),
      `${shown} chip, "${moreText}", nama "${moreName}"`,
    );
    await more.click();
    const panel = page.locator(".cv-more[role=dialog]");
    await panel.waitFor({ timeout: 5000 });
    const listed = new Set(await panel.locator("[data-cal-task]").evaluateAll((els) => els.map((e) => e.getAttribute("data-cal-task"))));
    const want = new Set([...TASKS.PA, ...TASKS.PB].filter((t) => t.due === D.busy).map((t) => keyOf(t.title)));
    const firstFocused = await page.evaluate(() => !!document.activeElement?.closest(".cv-more") && document.activeElement?.hasAttribute("data-cal-task"));
    check(
      "3. '+N lagi' membuka DayMore berisi semua task hari itu, fokus di chip pertama",
      sameSet(listed, want) && firstFocused && (await more.getAttribute("aria-expanded")) === "true",
      `${listed.size} dari ${want.size} task`,
    );
    await shot(page, "07-kalender-daymore-terang.png");
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "detached", timeout: 3000 }).catch(() => {});
    const back = await page.evaluate(() => document.activeElement?.classList.contains("cv-more-btn") ?? false);
    check("3. Esc menutup DayMore dan fokus kembali ke tombol '+N lagi'", (await panel.count()) === 0 && back);
    await showMonthOf(page, D.today);
  });

  await part(page, "3. Navigasi bulan", async () => {
    const names = {
      prev: await prevBtn(page).getAttribute("aria-label"),
      next: await nextBtn(page).getAttribute("aria-label"),
      today: (await todayBtn(page).innerText()).trim(),
    };
    await nextBtn(page).click();
    await settled(page);
    const t1 = await calTitle(page);
    await prevBtn(page).click();
    await settled(page);
    await prevBtn(page).click();
    await settled(page);
    const t2 = await calTitle(page);
    await todayBtn(page).click();
    await settled(page);
    const t3 = await calTitle(page);
    check(
      "3. Bulan berikutnya, Bulan sebelumnya, dan Hari ini mengganti judul",
      names.prev === TX.prevMonth &&
        names.next === TX.nextMonth &&
        names.today === TX.today &&
        t1 === monthTitleShift(TODAY, 1, MONTHS_ID) &&
        t2 === monthTitleShift(TODAY, -1, MONTHS_ID) &&
        t3 === monthTitleOf(TODAY, MONTHS_ID),
      `${t1} / ${t2} / ${t3}; ${JSON.stringify(names)}`,
    );
  });

  await part(page, "3. Minggu", async () => {
    await setView(page, "week");
    const pressed = await viewBtn(page, TX.views.week).getAttribute("aria-pressed");
    const cols = await page.locator(".cv-week section[data-cal-day]").evaluateAll((els) => els.map((e) => e.getAttribute("data-cal-day")));
    const title = await calTitle(page);
    const todayCol = page.locator('.cv-week section[aria-current="date"]');
    const hasMine = (await chipIn(todayCol, keyOf(T_MINE)).count()) === 1;
    check(
      "3. Minggu: tujuh kolom Senin..Minggu memuat hari ini, judul '.. sampai ..', chip hari ini di kolomnya",
      pressed === "true" && cols.length === 7 && cols[0] === mondayOf(TODAY) && cols.includes(TODAY) && title.includes(` ${TX.weekWord} `) && hasMine,
      `${title}; ${cols[0]}..${cols[6]}`,
    );
    const prevName = await prevBtn(page).getAttribute("aria-label");
    await nextBtn(page).click();
    await settled(page);
    const nextCols = await page.locator(".cv-week section[data-cal-day]").evaluateAll((els) => els.map((e) => e.getAttribute("data-cal-day")));
    const t2 = await calTitle(page);
    await todayBtn(page).click();
    await settled(page);
    check(
      "3. Minggu berikutnya menggeser tujuh hari dan mengganti judul; Hari ini kembali",
      prevName === TX.prevWeek && nextCols[0] === addDaysIso(mondayOf(TODAY), 7) && t2 !== title && (await calTitle(page)) === title,
      `${t2}`,
    );
    await shot(page, "08-kalender-minggu-terang.png");
  });

  await part(page, "3. Agenda", async () => {
    await setView(page, "agenda");
    const late = page.locator("section.cv-alate");
    await late.waitFor({ timeout: 5000 });
    const heading = (await late.locator("h3").innerText()).trim();
    const hasOverdue = (await chipIn(late, keyOf(T_OVERDUE)).count()) === 1;
    const todaySection = page.locator(`section.cv-aday[data-cal-day="${TODAY}"]`);
    const todayRow = (await chipIn(todaySection, keyOf(T_MINE)).getAttribute("aria-label").catch(() => "")) ?? "";
    check(
      "3. Agenda: grup 'Lewat tenggat' berisi task kemarin, baris hari ini menyebut penanggung jawab",
      heading === TX.overdueGroup && hasOverdue && todayRow.includes(`untuk ${NODES.A.name}`),
      `${heading}; ${todayRow}`,
    );
    await shot(page, "09-kalender-agenda-terang.png");
    await setView(page, "month");
  });

  // ---------- 4. Saringan ----------
  await part(page, "4. Saringan", async () => {
    const scope = scopeSelect(page);
    const labelOk = (await page.getByLabel(TX.scopeLabel, { exact: true }).count()) === 1;
    const opts = (await scope.locator("option").allInnerTexts()).map((s) => s.trim());
    check(
      "4. Saringan 'Lihat': Task saya, Semua proyek, lalu setiap proyek; bawaan Semua proyek",
      labelOk && opts[0] === "Task saya" && opts[1] === "Semua proyek" && opts.includes(`PA · ${PA.name}`) && opts.includes(`PB · ${PB.name}`) && (await scope.inputValue()) === "all",
      opts.join(" | "),
    );
    const span = [D.yesterday, D.today, D.tomorrow, D.doneDay, D.busy];

    await scope.selectOption("mine");
    await settled(page);
    const mine = await keysAcross(page, span);
    check("4. Task saya: hanya task yang ditugaskan ke saya", sameSet(mine, new Set([keyOf(T_MINE)])), `${mine.size} chip`);
    await shot(page, "10-kalender-saringan-task-saya-terang.png");

    await scope.selectOption(`p:${ctx.pk.PB.id}`);
    await settled(page);
    const pb = await keysAcross(page, span);
    const wantPb = new Set(TASKS.PB.map((t) => keyOf(t.title)));
    check("4. Satu proyek (PB): hanya task PB", sameSet(pb, wantPb), `${pb.size} chip`);

    await scope.selectOption("all");
    await settled(page);
    const box = doneBox(page);
    const boxLabelOk = (await page.getByLabel(TX.showDone, { exact: true }).count()) === 1;
    await box.check();
    await settled(page);
    await showMonthOf(page, D.doneDay);
    const doneChip = chipIn(monthCell(page, D.doneDay), keyOf(T_DONE));
    const doneLabel = (await doneChip.getAttribute("aria-label").catch(() => "")) ?? "";
    const doneCls = await doneChip.evaluate((el) => el.classList.contains("cc-done")).catch(() => false);
    await shot(page, "11-kalender-tampilkan-selesai-terang.png");
    await box.uncheck();
    await settled(page);
    const goneAgain = (await chipIn(monthCell(page, D.doneDay), keyOf(T_DONE)).count()) === 0;
    const savedFilter = await call(page, "get_setting", { key: "calendar.filter" });
    check(
      "4. 'Tampilkan yang selesai' memunculkan task Selesai (dicoret, '..., selesai'), dimatikan menyembunyikannya lagi",
      boxLabelOk && doneCls && doneLabel.endsWith(TX.doneSr) && goneAgain,
      `${doneLabel}; filter tersimpan=${savedFilter.value}`,
    );
    await showMonthOf(page, TODAY);
  });

  // ---------- 5. Klik chip membuka detail task ----------
  await part(page, "5. Detail task", async () => {
    await showMonthOf(page, D.tomorrow);
    const chip = chipIn(monthCell(page, D.tomorrow), keyOf(T_DRAG));
    await chip.click();
    const dlg = taskDialog(page);
    await dlg.waitFor({ timeout: 10000 });
    const value = await dlg.getByRole("textbox", { name: "Judul task", exact: true }).inputValue();
    await sleep(300);
    await shot(page, "12-kalender-detail-task-terang.png");
    await closeTaskDialog(page);
    const back = await poll(async () => (await focusedKey(page)) === keyOf(T_DRAG), 3000);
    check("5. Klik chip membuka detail task dengan judulnya; tutup mengembalikan fokus ke chip", value === T_DRAG && back === true, `judul="${value}"`);
  });

  // ---------- 6. Pindah tenggat: seret, Alt+Panah, menu ----------
  let dragTarget = null;
  await part(page, "6. Seret", async () => {
    await showMonthOf(page, D.tomorrow);
    const busyDays = new Set([D.yesterday, D.today, D.tomorrow, addDaysIso(D.tomorrow, 1), D.doneDay, D.busy]);
    const row = mondayOf(D.tomorrow);
    const candidates = [2, 3, -2, 4, 5, -3, -1, 6, -4, -5, 1].map((n) => addDaysIso(D.tomorrow, n));
    dragTarget = candidates.find((d) => mondayOf(d) === row && !busyDays.has(d)) ?? addDaysIso(D.tomorrow, 7);
    if ((await monthCell(page, dragTarget).count()) === 0) throw new Error(`sel ${dragTarget} tidak ada di bulan yang tampil`);

    const chip = chipIn(monthCell(page, D.tomorrow), keyOf(T_DRAG));
    await chip.scrollIntoViewIfNeeded();
    const movable = await chip.getAttribute("data-movable");
    const from = await chip.boundingBox();
    const target = await monthCell(page, dragTarget).boundingBox();
    const start = { x: from.x + Math.min(24, from.width / 2), y: from.y + from.height / 2 };
    const end = { x: target.x + target.width / 2, y: target.y + target.height - 12 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 10, start.y + 4, { steps: 4 });
    await page.mouse.move(end.x, end.y, { steps: 24 });
    await sleep(200);
    const mid = {
      ghost: await page.locator(".cal-ghost").count(),
      drop: await monthCell(page, dragTarget).evaluate((el) => el.classList.contains("cv-drop")),
      dragging: await page.evaluate(() => document.documentElement.classList.contains("cal-dragging")),
    };
    await shot(page, "13-kalender-seret-target-terang.png");
    await page.mouse.up();
    await sleep(800);
    check(
      "6. Seret mouse: chip boleh diseret, bayangan ikut pointer, sel tujuan disorot",
      movable === "true" && mid.ghost === 1 && mid.drop && mid.dragging,
      JSON.stringify({ movable, ...mid }),
    );
    const core = await poll(async () => ((await getTask(page, T_DRAG)).due === dragTarget ? dragTarget : null), 8000);
    const noDialog = (await taskDialog(page).count()) === 0;
    const sayText = (await say(page).innerText().catch(() => "")).trim();
    check(
      `6. Lepas di ${dragTarget}: tenggat di inti berubah, detail task tidak terbuka, perubahan diumumkan`,
      core === dragTarget && noDialog && sayText.startsWith(TX.moved(ctx.task[T_DRAG].code)),
      `inti=${core}, umumkan="${sayText}"`,
    );

    // Muat ulang halaman, lalu buka Kalender lagi.
    await page.reload();
    await page.waitForFunction(() => "__TAURI_INTERNALS__" in window, null, { timeout: 20000 });
    await waitShell(page);
    await openCalendar(page);
    await showMonthOf(page, dragTarget);
    const at = await chipDay(page, keyOf(T_DRAG));
    await chipIn(monthCell(page, dragTarget), keyOf(T_DRAG)).click();
    const dlg = taskDialog(page);
    await dlg.waitFor({ timeout: 10000 });
    const dueText = (await prop(dlg, "Tenggat").innerText().catch(() => "")).replace(/\s+/g, " ");
    const t = fromIso(dragTarget);
    const want = `${t.getDate()} ${MONTHS_SHORT_ID[t.getMonth()]}`;
    await closeTaskDialog(page);
    check(
      "6. Setelah muat ulang chip ada di hari baru dan detail task menampilkan tenggat baru",
      at === dragTarget && dueText.includes(want),
      `chip di ${at}; Tenggat: "${dueText}"`,
    );
  });

  await part(page, "6. Alt+Panah", async () => {
    await showMonthOf(page, D.tomorrow);
    const want = addDaysIso(D.tomorrow, 1);
    await chipIn(monthCell(page, D.tomorrow), keyOf(T_KEYS)).focus();
    await page.keyboard.press("Alt+ArrowRight");
    const core = await poll(async () => ((await getTask(page, T_KEYS)).due === want ? want : null), 8000);
    await sleep(400);
    const sayText = (await say(page).innerText().catch(() => "")).trim();
    await showMonthOf(page, want);
    const at = await chipDay(page, keyOf(T_KEYS));
    check(
      "6. Alt+Panah kanan memajukan tenggat sehari, chip pindah, perubahan diumumkan",
      core === want && at === want && sayText.startsWith(TX.moved(ctx.task[T_KEYS].code)),
      `inti=${core}, chip di ${at}, "${sayText}"`,
    );
  });

  await part(page, "6. Menu klik kanan", async () => {
    await showMonthOf(page, D.today);
    const chip = chipIn(monthCell(page, D.today), keyOf(T_MINE));
    const b = await chip.boundingBox();
    await page.mouse.click(b.x + Math.min(30, b.width / 2), b.y + b.height / 2, { button: "right" });
    const code = ctx.task[T_MINE].code;
    const menu = page.getByRole("menu", { name: TX.menuLabel(code), exact: true });
    await menu.waitFor({ timeout: 5000 });
    const items = await menu.getByRole("menuitem").evaluateAll((els) => els.map((e) => `${e.getAttribute("data-menu-item")}${e.getAttribute("aria-disabled") === "true" ? "(off)" : ""}`));
    await shot(page, "14-kalender-menu-tenggat-terang.png");
    check(
      `6. Klik kanan chip membuka menu '${TX.menuLabel(code)}': Hari ini nonaktif (sudah di tanggal itu), Besok, Senin depan, Hapus tenggat, Buka task`,
      items.includes("due-today(off)") && items.includes("due-tomorrow") && items.includes("due-next-monday") && items.includes("due-clear") && items.includes("open"),
      items.join(" | "),
    );
    await menu.locator('[data-menu-item="due-tomorrow"]').click();
    const core = await poll(async () => ((await getTask(page, T_MINE)).due === D.tomorrow ? D.tomorrow : null), 8000);
    await showMonthOf(page, D.tomorrow);
    const at = await chipDay(page, keyOf(T_MINE));
    check("6. Menu > Besok memindah tenggat ke besok", core === D.tomorrow && at === D.tomorrow, `inti=${core}, chip di ${at}`);
    await showMonthOf(page, D.today);
  });

  // ---------- 9. Tema gelap (Indonesia) ----------
  await part(page, "9. Gelap", async () => {
    await setTheme(page, "dark");
    await openCalendar(page);
    await setView(page, "month");
    await showMonthOf(page, D.today);
    await shot(page, "15-kalender-bulan-gelap.png");
    await setView(page, "week");
    await shot(page, "16-kalender-minggu-gelap.png");
    await setView(page, "agenda");
    await shot(page, "17-kalender-agenda-gelap.png");
    await setView(page, "month");
    await showMonthOf(page, D.busy);
    await monthCell(page, D.busy).locator(".cv-more-btn").click();
    await page.locator(".cv-more[role=dialog]").waitFor({ timeout: 5000 });
    await shot(page, "18-kalender-daymore-gelap.png");
    await page.keyboard.press("Escape");
    await showMonthOf(page, D.yesterday);
    const late = chipIn(monthCell(page, D.yesterday), keyOf(T_OVERDUE));
    await late.focus();
    await page.keyboard.press("Shift+F10");
    const menu = page.getByRole("menu", { name: TX.menuLabel(ctx.task[T_OVERDUE].code), exact: true });
    await menu.waitFor({ timeout: 5000 });
    const firstFocus = await page.evaluate(() => document.activeElement?.getAttribute("role"));
    await shot(page, "19-kalender-menu-tenggat-gelap.png");
    await page.keyboard.press("Escape");
    await sleep(200);
    check("9. Shift+F10 pada chip membuka menu tenggat dengan item terfokus; Esc menutup", firstFocus === "menuitem" && (await menu.count()) === 0);
    await showMonthOf(page, D.today);
    await sidebarToggle(page).click();
    await sleep(400);
    await shot(page, "20-sidebar-ringkas-kalender-gelap.png");
    await sidebarToggle(page).click();
    await sleep(400);
    check("9. Tema gelap: screenshot bulan, minggu, agenda, DayMore, menu, sidebar ringkas", true);
  });

  // ---------- 7. Bahasa Inggris ----------
  await part(page, "7. English", async () => {
    await setTheme(page, "light");
    await setLanguage(page, true);
    await openCalendar(page);
    await setView(page, "month");
    await showMonthOf(page, D.today);
    const title = await calTitle(page);
    const heads = (await page.locator(".cv-month th.cv-th").allInnerTexts()).map((s) => s.trim());
    const navOk = (await navAny(page, EN.calendar).count()) === 1;
    const lateLabel = await (async () => {
      await showMonthOf(page, D.yesterday);
      const l = (await chipIn(monthCell(page, D.yesterday), keyOf(T_OVERDUE)).getAttribute("aria-label").catch(() => "")) ?? "";
      await showMonthOf(page, D.today);
      return l;
    })();
    check(
      "7. English: menu 'Calendar', judul bulan dan nama hari Inggris, chip '..., overdue'",
      navOk && title === monthTitleOf(TODAY, MONTHS_EN) && heads.join(",") === WEEKDAYS_EN.join(",") && lateLabel.endsWith(EN.overdueSr),
      `${title}; ${heads.join(",")}; ${lateLabel}`,
    );
    await shot(page, "21-kalender-bulan-inggris-terang.png");
    await setView(page, "week");
    const wt = await calTitle(page);
    check("7. English: judul minggu '.. to ..'", wt.includes(` ${EN.weekWord} `), wt);
    await shot(page, "22-kalender-minggu-inggris-terang.png");
    await setView(page, "agenda");
    const lateHead = (await page.locator("section.cv-alate h3").innerText().catch(() => "")).trim();
    check("7. English: grup Agenda 'Overdue'", lateHead === EN.overdueGroup, lateHead);
    await shot(page, "23-kalender-agenda-inggris-terang.png");
    await setView(page, "month");
    await setTheme(page, "dark");
    await openCalendar(page);
    await shot(page, "24-kalender-bulan-inggris-gelap.png");
    await sidebarToggle(page).click();
    const enToggle = await sidebarToggle(page).getAttribute("aria-label");
    await shot(page, "25-sidebar-ringkas-inggris-gelap.png");
    await sidebarToggle(page).click();
    check("7. English: tombol sidebar 'Expand menu' saat ringkas", enToggle === "Expand menu", String(enToggle));

    await setTheme(page, "light");
    await setLanguage(page, false);
    await openCalendar(page);
    const back = await calTitle(page);
    check(
      "7. Kembali ke Bahasa Indonesia: menu Kalender dan judul bulan Indonesia",
      (await navAny(page, TX.calendar).count()) === 1 && back === monthTitleOf(TODAY, MONTHS_ID),
      back,
    );
  });
}

// ---------- 8. Tamu ----------
async function guestAttempt(n) {
  const page = A.page;
  const nodeB = { ...NODES.B, dir: join(root, `laptop-b-${n}`) };
  let B = null;
  try {
    const dept = (await must(page, "org_departments", { includeArchived: false })).find((d) => d.name === DEPT);
    if (!dept) throw new Error("departemen Desain tidak ada");
    const invite = await must(page, "create_invite", { teamId: dept.id, role: "guest", validity: "24h", projectIds: [ctx.pk.PA.id] });
    check(
      "8. Undangan Tamu ke departemen Desain hanya untuk proyek PA",
      invite.invite.role === "guest" && invite.invite.projectIds.length === 1 && invite.invite.projectIds[0] === ctx.pk.PA.id,
    );

    B = await launch(nodeB, { mdns: GUEST_MDNS });
    await must(B.page, "save_display_name", { name: nodeB.name });
    const joined = await call(B.page, "join_with_code", { code: invite.code, address: addr(NODES.A) });
    if (!joined.ok) throw new Error(`B gagal bergabung: ${JSON.stringify(joined.error)}`);
    await rememberKey(B);
    // A juga mengenal alamat B, karena mDNS mati.
    const added = await call(page, "add_manual_address", { address: addr(nodeB) });
    if (!added.ok) note(`add_manual_address di A: ${JSON.stringify(added.error)}`);
    const bState = await must(B.page, "get_app_state");
    check("8. B bergabung sebagai Tamu", bState.organization?.role === "guest", `${bState.organization?.name} / ${bState.organization?.role}`);

    // Tunggu data PA sampai di B: daftar task kalender B sama dengan task PA (belum selesai) di A.
    const range = { from: isoDate(-40), to: isoDate(60) };
    const aPa = (await must(page, "board_calendar", range)).filter((t) => t.projectId === ctx.pk.PA.id).map((t) => t.task.id).sort();
    const since = Date.now();
    const bCal = await poll(async () => {
      const r = await call(B.page, "board_calendar", range);
      if (!r.ok) return null;
      const ids = r.value.filter((t) => t.projectId === ctx.pk.PA.id).map((t) => t.task.id).sort();
      return ids.join() === aPa.join() ? r.value : null;
    }, 150000, 2000);
    if (!bCal) throw new Error(`task PA belum sampai di B setelah ${Math.round((Date.now() - since) / 1000)} dtk`);
    const projectsB = await must(B.page, "board_list_projects");
    check(
      "8. Inti B: hanya proyek PA terlihat, board_calendar hanya task PA dan canEdit false",
      projectsB.length === 1 && projectsB[0].id === ctx.pk.PA.id && bCal.every((t) => t.projectId === ctx.pk.PA.id && t.task.canEdit === false),
      `${projectsB.map((p) => p.code).join(",")}; ${bCal.length} task dalam ${Math.round((Date.now() - since) / 1000)} dtk`,
    );

    const pb = B.page;
    await pb.reload();
    await pb.waitForFunction(() => "__TAURI_INTERNALS__" in window, null, { timeout: 20000 });
    await waitShell(pb);
    await setTheme(pb, "light");
    await openCalendar(pb);
    await setView(pb, "month");
    await showMonthOf(pb, D.busy);
    const busyKeys = await monthKeys(pb);
    await showMonthOf(pb, TODAY);
    const keys = new Set([...(await monthKeys(pb)), ...busyKeys]);
    const foreign = [...keys].filter((k) => !k.startsWith(`${ctx.pk.PA.id}/`));
    const scopeOpts = (await scopeSelect(pb).locator("option").allInnerTexts()).map((s) => s.trim());
    check(
      "8. Kalender B: hanya chip proyek PA, saringan hanya menawarkan PA",
      keys.size > 0 && foreign.length === 0 && !scopeOpts.some((o) => o.startsWith("PB ")),
      `${keys.size} chip, asing=${foreign.length}; ${scopeOpts.join(" | ")}`,
    );
    await shot(pb, "26-tamu-kalender-bulan-terang.png");

    // Chip B tidak bisa diseret dan tidak bisa dipindah dengan Alt+Panah.
    const anyChip = pb.locator(".cv-month td[data-cal-day] [data-cal-task]").first();
    const key = await anyChip.getAttribute("data-cal-task");
    const taskId = key.split("/")[1];
    const before = (await must(B.page, "board_get_task", { projectId: ctx.pk.PA.id, taskId })).due;
    const movable = await pb.locator(".cv-month [data-cal-task][data-movable]").count();
    const t0 = Date.now();
    const box = await anyChip.boundingBox();
    const s = { x: box.x + 20, y: box.y + box.height / 2 };
    await pb.mouse.move(s.x, s.y);
    await pb.mouse.down();
    await pb.mouse.move(s.x + 10, s.y + 4, { steps: 4 });
    await pb.mouse.move(s.x + 160, s.y + 90, { steps: 16 });
    const ghost = await pb.locator(".cal-ghost").count();
    await pb.mouse.up();
    await sleep(500);
    if ((await taskDialog(pb).count()) > 0) await closeTaskDialog(pb).catch(() => pb.keyboard.press("Escape"));
    await anyChip.focus();
    await pb.keyboard.press("Alt+ArrowRight");
    await sleep(800);
    const sayText = (await say(pb).innerText().catch(() => "")).trim();
    const after = (await must(B.page, "board_get_task", { projectId: ctx.pk.PA.id, taskId })).due;
    const updates = ipcSince(B, t0, "board_update_task").length;
    check(
      "8. Chip Tamu tidak bisa diseret (tanpa data-movable, tanpa bayangan); Alt+Panah mengumumkan tidak berhak",
      movable === 0 && ghost === 0 && sayText === TX.noRight && after === before,
      `movable=${movable}, bayangan=${ghost}, "${sayText}", tenggat ${before} -> ${after}`,
    );
    const ipcVisible = B.ipc.length > 0;
    if (ipcVisible) check("8. Tamu: tidak ada panggilan board_update_task dari seret atau Alt+Panah", updates === 0, `${updates} panggilan`);
    else note("request IPC tidak terlihat lewat CDP; pemeriksaan board_update_task dilewati");

    // Menu klik kanan: pilihan tenggat nonaktif dengan alasan, Buka task jalan.
    const b2 = await anyChip.boundingBox();
    await pb.mouse.click(b2.x + 20, b2.y + b2.height / 2, { button: "right" });
    const menu = pb.getByRole("menu").filter({ has: pb.locator('[data-menu-item="open"]') });
    await menu.waitFor({ timeout: 5000 });
    const items = await menu.getByRole("menuitem").evaluateAll((els) =>
      els.map((e) => ({ id: e.getAttribute("data-menu-item"), off: e.getAttribute("aria-disabled") === "true", text: (e.textContent ?? "").trim() })),
    );
    await shot(pb, "27-tamu-menu-tanpa-hak-terang.png");
    const moves = items.filter((i) => i.id?.startsWith("due-"));
    check(
      "8. Menu tenggat Tamu: semua pilihan tenggat nonaktif dengan alasan, 'Buka task' aktif",
      moves.length >= 4 && moves.every((i) => i.off && i.text.includes("tidak berhak")) && items.some((i) => i.id === "open" && !i.off),
      items.map((i) => `${i.id}${i.off ? "(off)" : ""}`).join(" | "),
    );
    await menu.locator('[data-menu-item="open"]').click();
    const dlg = taskDialog(pb);
    const opened = await dlg.waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
    if (opened) await closeTaskDialog(pb).catch(() => pb.keyboard.press("Escape"));
    check("8. Tamu: 'Buka task' membuka detail task", opened);

    await setTheme(pb, "dark");
    await openCalendar(pb);
    await setView(pb, "agenda");
    await shot(pb, "28-tamu-kalender-agenda-gelap.png");
    await setView(pb, "month");
  } catch (err) {
    check("8. Fase Tamu berjalan tanpa error", false, errText(err));
    if (B) await shot(B.page, `gagal-tamu-${n}.png`);
  } finally {
    if (B) await stop(B);
  }
}

async function phaseGuest() {
  if (GUEST_MDNS) {
    note("SK_E2E_GUEST_MDNS=1: A dijalankan ulang dengan mDNS menyala");
    await stop(A);
    A = await launch(NODES.A, { mdns: true });
    await waitShell(A.page);
  }
  for (let n = 1; n <= GUEST_TRIES; n++) {
    const attempt = [];
    sink = attempt;
    prefix = GUEST_TRIES > 1 ? `[tamu ${n}/${GUEST_TRIES}] ` : "";
    try {
      await guestAttempt(n);
    } finally {
      sink = results;
      prefix = "";
    }
    const failed = attempt.filter((r) => !r.ok).length;
    if (failed === 0 || n === GUEST_TRIES) {
      results.push(...attempt);
      return;
    }
    note(`fase Tamu percobaan ${n} gagal (${failed} pemeriksaan); diulang dengan laptop B baru`);
  }
}

// ===================================================================================
try {
  if (GUEST_ONLY) {
    A = await launch(NODES.A);
    await waitShell(A.page);
    await loadIds(A.page);
    note(`SK_E2E_GUEST_ONLY: fase 1-7 dilewati, data A dari ${root}`);
  } else {
    await phasesOneToSeven();
  }
  if (RUN_GUEST) await phaseGuest();
  else note("SK_E2E_GUEST=0: fase Tamu dilewati");
} catch (err) {
  check("Skrip berjalan tanpa error", false, errText(err));
  for (const app of running) await shot(app.page, `gagal-${app.node.id.toLowerCase()}.png`);
}

for (const app of [...running]) await stop(app);

if (KEEP_DATA) {
  console.log(`SK_E2E_KEEP_DATA=1: folder data ${root} dan kunci laptop uji dibiarkan.`);
  console.log(`Ulangi fase Tamu: SK_E2E_GUEST_ONLY="${root}" node scripts/sidebar-kalender-e2e.mjs <mira.exe> [folder screenshot]`);
} else {
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
  // Mode SK_E2E_GUEST_ONLY: kunci A dibuat sebelum skrip ini mulai, jadi tidak ada di selisih.
  if (GUEST_ONLY) {
    for (const [key, owner] of Object.entries(keyOwner)) {
      if (owner !== "A") continue;
      const target = `device-key-${key}.id.mira.desktop`;
      try {
        execFileSync("cmdkey", [`/delete:${target}`], { stdio: "ignore" });
      } catch {
        /* sudah tidak ada */
      }
    }
  }
  for (const id of ["A", "B"]) {
    try {
      const log = readFileSync(join(root, `${id}-stderr.log`), "utf8").trim();
      if (log) console.log(`stderr ${id}:\n${log.slice(-1500)}`);
    } catch {
      /* tidak ada log */
    }
  }
  console.log(`Folder data uji: ${root}. Dihapus sekarang.`);
  rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} pemeriksaan lulus.`);
process.exit(failed ? 1 : 0);
