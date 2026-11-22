// Uji ujung ke ujung fondasi sinkron board di satu laptop.
//
// Menjalankan mira.exe dengan folder data baru, lalu lewat DevTools Protocol:
// isi nama, buat organisasi, buat tim "Desain" dan masukkan superadmin ke tim
// itu, buat proyek tim "Proyek Klien" (kode PK), tambah dua task, ubah judul
// task di inti Rust sementara deskripsinya sedang diketik (draf dan fokus harus
// tetap), pancarkan event mira://feature topik "board" dan "chat", ubah nama
// proyek, buat kode undangan Tamu untuk proyek itu, ambil screenshot terang dan
// gelap, restart, dan pastikan proyek, tim, dan nama baru tetap tersimpan.
//
// Pakai:  node scripts/board-sync-e2e.mjs <path mira.exe> <folder screenshot> [folder induk data]
// Folder data dibuat di bawah folder induk (bawaan: folder temp) dan dihapus di akhir.

import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const exe = resolve(process.argv[2] ?? "src-tauri/target/debug/mira.exe");
const shots = resolve(process.argv[3] ?? "docs/progress/screenshots");
const parent = resolve(process.argv[4] ?? tmpdir());
mkdirSync(shots, { recursive: true });
mkdirSync(parent, { recursive: true });
const dataDir = mkdtempSync(join(parent, "mira-board-sync-"));
const PORT = 9351;

const PROJECT = "Proyek Klien";
// Nama baru tetap mengandung nama lama, jadi pencarian /Proyek Klien/ tetap cocok setelah diubah.
const PROJECT_RENAMED = "Proyek Klien Utama";
const TEAM = "Desain";
const TEAM_CHIP = "Tim Desain"; // teamLabel("Desain") di src/screens/board/format.ts
const TASKS = ["Siapkan moodboard klien", "Kirim penawaran harga"];
const TITLE_FROM_CORE = "Siapkan moodboard klien versi 2";
const DRAFT = "Catatan belum disimpan: palet bata dan krem, contoh dari klien lama.";

function miraCredentials() {
  try {
    const out = execFileSync("cmdkey", ["/list"], { encoding: "utf8" });
    return new Set(out.match(/device-key-[0-9a-f]{64}\.id\.mira\.desktop/g) ?? []);
  } catch {
    return new Set();
  }
}
const credentialsBefore = miraCredentials();

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "LULUS" : "GAGAL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Command Tauri yang dipanggil halaman. Di Windows, Tauri 2 mengirim IPC lewat
// fetch ke http://ipc.localhost/<command>, jadi tiap panggilan terlihat sebagai
// request jaringan di CDP. Dipakai untuk memastikan event memicu (atau tidak
// memicu) muat ulang board. window.__TAURI_INTERNALS__.invoke tidak bisa
// dibungkus karena didefinisikan tanpa writable (tauri/scripts/core.js).
const ipcLog = [];
function watchIpc(page) {
  page.on("request", (req) => {
    try {
      const u = new URL(req.url());
      if (u.hostname === "ipc.localhost" || u.protocol === "ipc:") {
        ipcLog.push({ cmd: decodeURIComponent(u.pathname.replace(/^\//, "")), at: Date.now() });
      }
    } catch {
      /* bukan URL biasa */
    }
  });
}
const ipcSince = (t0, names) => ipcLog.filter((e) => e.at >= t0 && names.includes(e.cmd));
const BOARD_RELOADS = ["board_get_board", "board_get_task", "board_list_projects"];

async function launch() {
  const log = createWriteStream(join(dataDir, "stderr.log"), { flags: "a" });
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      MIRA_DATA_DIR: dataDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.pipe(log);
  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
    await sleep(500);
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
    if (!page) await sleep(250);
  }
  watchIpc(page);
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => "__TAURI_INTERNALS__" in window, null, { timeout: 20000 });
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  return { child, browser, page };
}

async function stop({ child, browser }) {
  await browser.close().catch(() => {});
  try {
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* sudah berhenti */
  }
  await sleep(1500);
}

// Memanggil command Tauri dari halaman. Hasil: { ok, value } atau { ok: false, error }.
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

// Memancarkan event dari JS tanpa import modul: sama dengan emit() di
// @tauri-apps/api/event. Izin core:event:allow-emit sudah ada lewat
// "core:default" di src-tauri/capabilities/default.json (core:event:default
// berisi allow-listen, allow-unlisten, allow-emit, allow-emit-to). Event dari
// webview diteruskan inti ke semua listener, termasuk listener di webview ini.
const emitFeature = (page, topic) =>
  call(page, "plugin:event|emit", { event: "mira://feature", payload: { topic } });

// Tombol menu utama. Panel jaringan di sidebar juga punya tombol "Organisasi"
// (tautan undangan saat belum ada rekan), jadi pencarian dibatasi ke nav ini.
const mainNav = (page, name) =>
  page.getByRole("navigation", { name: "Menu utama" }).getByRole("button", { name, exact: true });
const projectNav = (page) => page.getByRole("navigation", { name: "Task saya dan proyek" });
const card = (page, title) => page.locator("[data-open-task]", { hasText: title });

async function goBoard(page) {
  await mainNav(page, "Board").click();
}
async function goOrg(page) {
  await mainNav(page, "Organisasi").click();
  await page.getByRole("navigation", { name: "Bagian organisasi" }).waitFor({ timeout: 10000 });
}
async function setTheme(page, label) {
  await mainNav(page, "Pengaturan").click();
  await page.getByLabel(label, { exact: true }).check();
  await page.waitForTimeout(300);
  await goBoard(page);
}
async function openProject(page, name = PROJECT) {
  await projectNav(page).getByRole("button", { name: new RegExp(name) }).click();
  await page.getByRole("button", { name: "Task baru" }).waitFor({ timeout: 10000 });
}
async function openTask(page, title) {
  await card(page, title).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Penanggung jawab").waitFor({ timeout: 10000 });
  return dlg;
}

let app = null;
try {
  app = await launch();
  let { page } = app;

  // 1. Onboarding.
  await page.getByLabel("Nama tampilan").waitFor({ timeout: 20000 });
  await page.getByLabel("Nama tampilan").fill("Rina Uji");
  await page.getByRole("button", { name: "Simpan nama" }).click();
  await page.getByRole("button", { name: /Buat organisasi baru/ }).click();
  await page.getByLabel("Nama organisasi").fill("Kantor Uji");
  await page.getByRole("button", { name: "Buat organisasi" }).click();
  // Panduan firewall: dilewati tanpa mengubah pengaturan Windows.
  await page.getByRole("button", { name: /^(Lewati, atur nanti|Buka Mira)$/ }).click({ timeout: 15000 });
  await mainNav(page, "Board").waitFor({ timeout: 10000 });
  await mainNav(page, "Pengaturan").click();
  await page.getByLabel("Terang", { exact: true }).check();
  check("Onboarding selesai: nama, organisasi, firewall dilewati", true);

  // Pemeriksaan awal: request IPC terlihat lewat CDP (dipakai pemeriksaan event di langkah 4).
  const probeAt = Date.now();
  await must(page, "board_list_projects");
  await sleep(300);
  const ipcVisible = ipcSince(probeAt, ["board_list_projects"]).length > 0;
  if (!ipcVisible) {
    console.log("Catatan: request IPC tidak terlihat lewat CDP; pemeriksaan muat ulang karena event hanya lewat tampilan.");
  }

  // 2. Organisasi: tim Desain, superadmin menambahkan dirinya sendiri.
  await goOrg(page);
  await page.getByRole("button", { name: "Buat tim" }).first().click();
  let dlg = page.getByRole("dialog");
  await dlg.getByLabel("Nama tim").fill(TEAM);
  await dlg.getByRole("button", { name: "Buat tim" }).click();
  // Setelah dibuat, detail tim langsung terbuka (TeamsPanel.onCreated).
  await page.getByRole("heading", { name: TEAM, exact: true }).waitFor({ timeout: 10000 });
  const addSelect = page.getByLabel("Tambah anggota organisasi ke tim");
  const myOption = await addSelect.locator("option", { hasText: "Rina Uji" }).getAttribute("value");
  await addSelect.selectOption(myOption);
  await page.getByRole("button", { name: "Tambahkan", exact: true }).click();
  await page.getByText("Anggota tim (1)").waitFor({ timeout: 10000 });
  const teamText = await page.locator(".org-body").innerText();
  check("Tim Desain dibuat dan superadmin masuk sebagai anggotanya", teamText.includes("(Anda)"), teamText.slice(0, 200));
  await page.screenshot({ path: join(shots, "sb-01-tim-desain-terang.png") });

  // 3. Proyek tim.
  await goBoard(page);
  await page.getByRole("button", { name: "Buat proyek pertama" }).click({ timeout: 10000 });
  dlg = page.getByRole("dialog");
  await dlg.getByLabel("Nama proyek").fill(PROJECT);
  await dlg.getByLabel("Kode proyek").fill("PK");
  // Label "Tim" baru muncul setelah daftar tim terbaca; selectOption menunggu opsinya ada.
  await dlg.getByLabel("Tim", { exact: true }).selectOption({ label: TEAM });
  const hint = await dlg.innerText();
  check("Dialog proyek baru menjelaskan proyek tim", hint.includes(`anggota ${TEAM_CHIP}`), hint.slice(-300));
  await page.screenshot({ path: join(shots, "sb-02-proyek-baru-tim-terang.png") });
  await dlg.getByRole("button", { name: "Buat proyek" }).click();
  await page.getByRole("button", { name: "Task baru" }).waitFor({ timeout: 10000 });
  const chip = await page.locator(".pb-head .pb-team").innerText();
  check("Header board menampilkan nama tim", chip.includes(TEAM_CHIP), chip);
  const listed = await must(page, "board_list_projects");
  const project = listed.find((p) => p.code === "PK");
  check("Proyek PK tercatat milik tim Desain", project?.teamName === TEAM, JSON.stringify(project ?? listed));

  // 4. Dua task, lalu judul diubah di inti sementara deskripsi sedang diketik.
  const todo = page.locator("section.pb-col").filter({ has: page.getByRole("heading", { name: "To do" }) });
  await todo.getByRole("button", { name: "Tambah task" }).click();
  for (const t of TASKS) {
    const input = todo.getByLabel(/Judul task baru/);
    await input.fill(t);
    await input.press("Enter");
    await page.waitForTimeout(250);
  }
  await todo.getByLabel(/Judul task baru/).press("Escape");
  check("Dua task dibuat", (await card(page, TASKS[0]).count()) === 1 && (await card(page, TASKS[1]).count()) === 1);

  dlg = await openTask(page, TASKS[0]);
  const desc = dlg.getByLabel("Deskripsi");
  const titleInput = dlg.getByLabel("Judul task");
  await desc.click();
  await desc.pressSequentially(DRAFT, { delay: 5 });
  const descFocused = () => desc.evaluate((el) => el === document.activeElement);
  check("Deskripsi diketik dan isian deskripsi difokus", (await desc.inputValue()) === DRAFT && (await descFocused()));

  // page.evaluate tidak memindah fokus. board_update_task sendiri juga
  // memancarkan mira://board dari inti; mira://feature dipancarkan sesudahnya
  // seperti saat perubahan datang dari laptop lain.
  const board = await must(page, "board_get_board", { projectId: project.id });
  const target = board.columns.flatMap((c) => c.tasks).find((t) => t.title === TASKS[0]);
  await must(page, "board_update_task", { projectId: project.id, taskId: target.id, patch: { title: TITLE_FROM_CORE } });
  await sleep(500);
  const featureAt = Date.now();
  const emitted = await emitFeature(page, "board");
  check("Event mira://feature topik board terpancar dari JS", emitted.ok, emitted.ok ? "" : JSON.stringify(emitted.error));
  await page.waitForFunction(
    ([title]) => [...document.querySelectorAll("[role=dialog] input")].some((i) => i.value === title),
    [TITLE_FROM_CORE],
    { timeout: 10000 },
  ).catch(() => {});
  await sleep(500);
  check("Judul baru dari inti tampil di detail task", (await titleInput.inputValue()) === TITLE_FROM_CORE, await titleInput.inputValue());
  check("Judul baru dari inti tampil di kartu board", (await card(page, TITLE_FROM_CORE).count()) === 1);
  check("Ketikan deskripsi yang belum disimpan tetap ada", (await desc.inputValue()) === DRAFT, await desc.inputValue());
  check("Fokus tetap di isian deskripsi setelah muat ulang", await descFocused());
  if (ipcVisible) {
    const reloads = ipcSince(featureAt, ["board_get_board", "board_get_task"]).filter((e) => e.at - featureAt < 1500);
    check("mira://feature topik board memicu muat ulang board dan detail task", reloads.length > 0, reloads.map((e) => e.cmd).join(", "));
  }
  await page.screenshot({ path: join(shots, "sb-03-draf-tetap-setelah-sinkron-terang.png") });

  // Topik lain tidak boleh memuat ulang board atau mengganggu ketikan.
  await sleep(1000);
  const chatAt = Date.now();
  const emittedChat = await emitFeature(page, "chat");
  await sleep(1500);
  check("Event mira://feature topik chat terpancar dari JS", emittedChat.ok, emittedChat.ok ? "" : JSON.stringify(emittedChat.error));
  if (ipcVisible) {
    // Jendela 400 ms: muat ulang karena event terjadi dalam puluhan milidetik,
    // polling 15 detik kecil kemungkinan jatuh di jendela ini.
    const chatReloads = ipcSince(chatAt, BOARD_RELOADS).filter((e) => e.at - chatAt < 400);
    check("mira://feature topik chat tidak memuat ulang board", chatReloads.length === 0, chatReloads.map((e) => e.cmd).join(", "));
  }
  const alerts = await dlg.getByRole("alert").count();
  check(
    "Setelah topik chat: judul, ketikan, dan fokus tidak berubah, tanpa pesan galat",
    (await titleInput.inputValue()) === TITLE_FROM_CORE && (await desc.inputValue()) === DRAFT && (await descFocused()) && alerts === 0,
    `alert=${alerts}`,
  );

  await dlg.getByRole("button", { name: "Simpan deskripsi" }).click();
  await page.waitForTimeout(500);
  const savedTask = await must(page, "board_get_task", { projectId: project.id, taskId: target.id });
  check("Deskripsi tersimpan setelah Simpan deskripsi", savedTask.description === DRAFT && savedTask.title === TITLE_FROM_CORE);
  await page.screenshot({ path: join(shots, "sb-04-detail-task-terang.png") });
  await dlg.getByRole("button", { name: "Tutup detail task" }).click();
  await page.waitForTimeout(400);

  // 5. Ubah nama proyek.
  await page.getByRole("button", { name: "Ubah nama proyek" }).click();
  dlg = page.getByRole("dialog");
  await dlg.getByLabel("Nama proyek").fill(PROJECT_RENAMED);
  await page.screenshot({ path: join(shots, "sb-05-ubah-nama-proyek-terang.png") });
  await dlg.getByRole("button", { name: "Simpan nama" }).click();
  await dlg.waitFor({ state: "detached", timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(600);
  const navText = await projectNav(page).innerText();
  const headText = await page.locator(".pb-head .pb-title").innerText();
  check("Nama baru tampil di daftar proyek", navText.includes(PROJECT_RENAMED), navText.replace(/\s+/g, " ").slice(0, 200));
  check("Nama baru tampil di header board", headText.includes(PROJECT_RENAMED), headText);

  // 6. Kode undangan Tamu untuk proyek ini.
  await goOrg(page);
  await page.getByRole("navigation", { name: "Bagian organisasi" }).getByRole("button", { name: "Tim", exact: true }).click();
  await page.locator("button.team-row", { hasText: TEAM }).click();
  await page.getByRole("button", { name: "Undang ke tim" }).click();
  dlg = page.getByRole("dialog");
  await dlg.locator('input[name="invite-role"][value="guest"]').check();
  const projectBox = dlg.getByRole("checkbox", { name: new RegExp(PROJECT_RENAMED) });
  await projectBox.check({ timeout: 10000 });
  await page.screenshot({ path: join(shots, "sb-06-undangan-tamu-pilih-proyek-terang.png") });
  await dlg.getByRole("button", { name: "Buat kode undangan" }).click();
  await dlg.getByText("Kode undangan siap").waitFor({ timeout: 10000 });
  const inviteText = await dlg.innerText();
  check(
    "Hasil undangan Tamu menyebut nama proyek",
    inviteText.includes(`PK ${PROJECT_RENAMED}`) && inviteText.includes(`Tamu di ${TEAM}`),
    inviteText.replace(/\s+/g, " ").slice(0, 300),
  );
  await page.screenshot({ path: join(shots, "sb-07-undangan-tamu-kode-terang.png") });
  await dlg.getByRole("button", { name: "Selesai" }).click();
  await page.waitForTimeout(300);

  // 7. Board dan detail task, terang lalu gelap.
  await goBoard(page);
  await openProject(page, PROJECT_RENAMED);
  await page.screenshot({ path: join(shots, "sb-08-board-terang.png") });
  dlg = await openTask(page, TITLE_FROM_CORE);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, "sb-09-detail-task-terang.png") });
  await dlg.getByRole("button", { name: "Tutup detail task" }).click();
  await page.waitForTimeout(300);
  await setTheme(page, "Gelap");
  await openProject(page, PROJECT_RENAMED);
  await page.screenshot({ path: join(shots, "sb-10-board-gelap.png") });
  dlg = await openTask(page, TITLE_FROM_CORE);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, "sb-11-detail-task-gelap.png") });
  await dlg.getByRole("button", { name: "Tutup detail task" }).click();
  await page.waitForTimeout(300);
  await goOrg(page);
  await page.locator("button.team-row", { hasText: TEAM }).click();
  await page.getByRole("button", { name: "Undang ke tim" }).click();
  dlg = page.getByRole("dialog");
  await dlg.locator('input[name="invite-role"][value="guest"]').check();
  await dlg.getByRole("checkbox", { name: new RegExp(PROJECT_RENAMED) }).waitFor({ timeout: 10000 });
  await page.screenshot({ path: join(shots, "sb-12-undangan-tamu-gelap.png") });
  await dlg.getByRole("button", { name: "Batal" }).click();
  await stop(app);
  app = null;

  // 8. Restart dengan folder data yang sama.
  app = await launch();
  page = app.page;
  await mainNav(page, "Board").click({ timeout: 20000 });
  await projectNav(page).getByRole("button", { name: new RegExp(PROJECT_RENAMED) }).waitFor({ timeout: 10000 });
  await openProject(page, PROJECT_RENAMED);
  const chipAfter = await page.locator(".pb-head .pb-team").innerText();
  const headAfter = await page.locator(".pb-head .pb-title").innerText();
  check(
    "Setelah restart proyek tetap dengan nama baru dan tim Desain",
    headAfter.includes(PROJECT_RENAMED) && chipAfter.includes(TEAM_CHIP),
    `${headAfter} | ${chipAfter}`,
  );
  check(
    "Setelah restart kedua task tetap, judul dari inti tetap",
    (await card(page, TITLE_FROM_CORE).count()) === 1 && (await card(page, TASKS[1]).count()) === 1,
  );
  await page.screenshot({ path: join(shots, "sb-13-setelah-restart-gelap.png") });
  await goOrg(page);
  const teamRow = page.locator("button.team-row", { hasText: TEAM });
  const teamRowText = (await teamRow.count()) ? await teamRow.first().innerText() : "";
  check("Setelah restart tim Desain tetap dan saya anggotanya", /Anda:/.test(teamRowText), teamRowText.replace(/\s+/g, " "));
  await stop(app);
  app = null;
} catch (err) {
  check("Skrip berjalan tanpa error", false, String(err?.message ?? err).slice(0, 300));
  if (app) {
    await app.page.screenshot({ path: join(shots, "sb-gagal.png") }).catch(() => {});
    await stop(app);
  }
}

for (const target of miraCredentials()) {
  if (!credentialsBefore.has(target)) {
    try {
      execFileSync("cmdkey", [`/delete:${target}`], { stdio: "ignore" });
    } catch {
      console.log(`Kunci uji tidak bisa dihapus: ${target}`);
    }
  }
}
console.log(`Folder data uji: ${dataDir} (log: stderr.log). Dihapus sekarang.`);
try {
  const log = readFileSync(join(dataDir, "stderr.log"), "utf8").trim();
  if (log) console.log(`stderr aplikasi:\n${log.slice(-2000)}`);
} catch {
  /* tidak ada log */
}
rmSync(dataDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} pemeriksaan lulus.`);
process.exit(failed ? 1 : 0);
