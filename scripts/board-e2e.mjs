// Uji ujung ke ujung board Tahap 3 (bagian lokal) di satu laptop.
//
// Menjalankan mira.exe dengan folder data baru, lalu lewat DevTools Protocol:
// isi nama, buat organisasi, buat proyek "Proyek A" (kode PA), tambah task,
// pindahkan task dengan keyboard (Alt+Panah dan menu Pindahkan) dan dengan
// seret mouse dari To do ke Dikerjakan ke Selesai, isi detail task lewat dialog
// v0.4 (deskripsi, penanggung jawab dan prioritas lewat menu, tenggat dan label
// lewat pilihan kecil, komentar), tambah dan centang subtask, mulai lalu hentikan
// timer, tambah subtask kedua lewat IPC lalu cek progres "1/2" di kartu, hapus
// task terpisah lewat menu Lainnya, lihat Task saya, ambil screenshot terang dan
// gelap, restart, dan pastikan semuanya tetap tersimpan.
//
// Pakai:  node scripts/board-e2e.mjs <path mira.exe> <folder screenshot> [folder induk data]
// Dengan MIRA_E2E_OS_MOUSE=1, setelah restart satu kartu juga diseret dengan
// kursor Windows sungguhan (kursor pengguna ikut bergerak; jangan pakai mouse).
// Folder data dibuat di bawah folder induk (bawaan: folder temp) dan dihapus di akhir.

import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { mainNav, newOffice } from "./e2e-onboarding.mjs";

const exe = resolve(process.argv[2] ?? "src-tauri/target/debug/mira.exe");
const shots = resolve(process.argv[3] ?? "docs/progress/screenshots");
const parent = resolve(process.argv[4] ?? tmpdir());
mkdirSync(shots, { recursive: true });
mkdirSync(parent, { recursive: true });
const dataDir = mkdtempSync(join(parent, "mira-board-"));
// Geser semua port (debug WebView2 dan QUIC) supaya bisa jalan berdampingan dengan uji lain di PC yang sama.
const PORT_OFFSET = Number(process.env.E2E_PORT_OFFSET ?? 0) || 0;
const PORT = 9341 + PORT_OFFSET;

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

function isoDate(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

// Format isian "Tanggal lain" di pilihan Tenggat: hh/bb/tttt.
function dmyDate(offsetDays) {
  const [y, m, d] = isoDate(offsetDays).split("-");
  return `${d}/${m}/${y}`;
}

// emulateViewport: false membiarkan ukuran jendela asli, supaya koordinat halaman
// sama dengan piksel jendela (perlu untuk seret kursor Windows).
async function launch({ emulateViewport = true } = {}) {
  const log = createWriteStream(join(dataDir, "stderr.log"), { flags: "a" });
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      MIRA_DATA_DIR: dataDir,
      MIRA_DISABLE_MDNS: "1",
      MIRA_UPDATER_ENDPOINT: "http://127.0.0.1:9/latest.json",
      ...(PORT_OFFSET ? { MIRA_PORT: String(47800 + PORT_OFFSET) } : {}),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.pipe(log);
  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
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
  if (emulateViewport) await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
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

const column = (page, name) => page.locator("section.pb-col").filter({ has: page.getByRole("heading", { name }) });
const cardTitles = async (page, name) =>
  (await column(page, name).locator("[data-open-task]").allInnerTexts()).map((s) => s.trim());

async function setTheme(page, label) {
  await mainNav(page, "Pengaturan").click();
  await page.getByLabel(label, { exact: true }).check();
  await page.waitForTimeout(300);
  await mainNav(page, "Board").click();
}

async function openProject(page) {
  await page.getByRole("navigation", { name: "Task saya dan proyek" }).getByRole("button", { name: /Proyek A/ }).click();
  await page.getByRole("button", { name: "Task baru" }).waitFor();
}

// Dialog detail task v0.4. Pilihan Tenggat, Label, dan Hentikan timer juga
// role=dialog di dalamnya, jadi dialog task dikenali dari tombol Tutup-nya.
const taskDialog = (page) =>
  page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Tutup detail task" }) });

async function openTaskDialog(page, title) {
  await page.locator("[data-open-task]", { hasText: title }).click();
  const dlg = taskDialog(page);
  await dlg.getByRole("textbox", { name: "Judul task", exact: true }).waitFor({ timeout: 10000 });
  return dlg;
}

async function closeTaskDialog(page) {
  const dlg = taskDialog(page);
  await dlg.getByRole("button", { name: "Tutup detail task" }).click();
  await dlg.waitFor({ state: "detached", timeout: 5000 });
  await page.waitForTimeout(300);
}

// Baris properti di group "Rincian task": nama tombol = label lalu nilai, misalnya
// "Prioritas Tinggi". Dibatasi ke group supaya tidak tertukar dengan tombol
// "Penanggung jawab subtask ..." di daftar subtask.
const prop = (dlg, label) =>
  dlg.getByRole("group", { name: "Rincian task" }).getByRole("button", { name: new RegExp(`^${label}(\\s|$)`) });

// Status, Prioritas, dan Penanggung jawab membuka menu berisi menuitemradio.
async function pickMenu(page, dlg, label, option) {
  await prop(dlg, label).click();
  const menu = dlg.getByRole("menu", { name: label, exact: true });
  await menu.getByRole("menuitemradio", { name: option }).click();
  await menu.waitFor({ state: "detached", timeout: 5000 });
  await page.waitForTimeout(300);
}

// Tenggat: isian "Tanggal lain" (hh/bb/tttt) lalu Pakai, atau pilihan cepat (regex nama tombol).
async function pickDue(page, dlg, { typed, quick }) {
  await prop(dlg, "Tenggat").click();
  const pop = dlg.getByRole("dialog", { name: "Tenggat", exact: true });
  if (typed) {
    await pop.getByRole("textbox", { name: "Tanggal lain" }).fill(typed);
    await pop.getByRole("button", { name: "Pakai", exact: true }).click();
  } else {
    await pop.getByRole("button", { name: quick }).click();
  }
  await pop.waitFor({ state: "detached", timeout: 5000 });
  await page.waitForTimeout(300);
}

// Label: tulis di "Label baru", Tambah, tunggu centangnya, lalu tutup lewat tombol Label lagi.
async function addLabel(page, dlg, label) {
  await prop(dlg, "Label").click();
  const pop = dlg.getByRole("dialog", { name: "Label", exact: true });
  await pop.getByRole("textbox", { name: "Label baru" }).fill(label);
  await pop.getByRole("button", { name: "Tambah", exact: true }).click();
  await prop(dlg, `Label ${label}`).waitFor({ timeout: 5000 }).catch(() => {});
  await prop(dlg, "Label").click();
  await pop.waitFor({ state: "detached", timeout: 5000 });
  await page.waitForTimeout(300);
}

// Kartu di board (bukan bayangan seret, yang tidak punya data-card).
const cardOf = (page, title) =>
  page.locator("section.pb-col [data-card]").filter({ has: page.locator("[data-open-task]", { hasText: title }) });

// Titik jatuh dalam koordinat halaman: di atas kartu lain, atau tepat di bawah kartu terakhir kolom.
async function dropPoint(page, colName, beforeTitle) {
  if (beforeTitle) {
    const b = await cardOf(page, beforeTitle).boundingBox();
    return { x: b.x + b.width / 2, y: b.y + 6 };
  }
  const col = await column(page, colName).boundingBox();
  const list = await column(page, colName).locator(".pb-list").boundingBox();
  return { x: col.x + col.width / 2, y: list.y + list.height + 4 };
}

async function grabPoint(page, title) {
  const card = cardOf(page, title);
  await card.scrollIntoViewIfNeeded();
  const b = await card.boundingBox();
  return { x: b.x + 30, y: b.y + b.height / 2 };
}

// Seret lewat page.mouse (Input.dispatchMouseEvent di CDP): tekan, gerak bertahap, lepas.
// shot: screenshot saat kartu masih di tengah seret. cancel: Escape sebelum lepas.
async function mouseDrag(page, title, colName, beforeTitle, { shot, cancel } = {}) {
  const from = await grabPoint(page, title);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 12, from.y + 6, { steps: 4 });
  const to = await dropPoint(page, colName, beforeTitle);
  await page.mouse.move(to.x, to.y, { steps: 20 });
  await page.waitForTimeout(150);
  if (shot) await page.screenshot({ path: join(shots, shot) });
  if (cancel) await page.keyboard.press("Escape");
  const highlighted = await column(page, colName).evaluate(
    (el) => el.classList.contains("pb-col-over") && !!el.querySelector(".pb-drop"),
  );
  const ghost = (await page.locator(".tc-ghost").count()) === 1;
  await page.mouse.up();
  await page.waitForTimeout(700);
  return { highlighted, ghost };
}

// Seret dengan kursor Windows lewat user32 (SetCursorPos + mouse_event), seperti tangan pengguna.
// Koordinat halaman dikali devicePixelRatio lalu ditambah titik asal area klien jendela.
const OS_DRAG_PS1 = `param([int]$ProcId, [int]$X1, [int]$Y1, [int]$X2, [int]$Y2)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class MiraMouse {
  [StructLayout(LayoutKind.Sequential)] public struct P { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out P p);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref P p);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
}
"@
[MiraMouse]::SetProcessDPIAware() | Out-Null
$h = (Get-Process -Id $ProcId).MainWindowHandle
if ($h -eq [IntPtr]::Zero) { throw "Jendela Mira tidak ditemukan" }
[MiraMouse]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 300
$o = New-Object MiraMouse+P
[MiraMouse]::ClientToScreen($h, [ref]$o) | Out-Null
$old = New-Object MiraMouse+P
[MiraMouse]::GetCursorPos([ref]$old) | Out-Null
function Go([int]$x, [int]$y) {
  [MiraMouse]::SetCursorPos($o.X + $x, $o.Y + $y) | Out-Null
  [MiraMouse]::mouse_event(0x0001, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 15
}
Go $X1 $Y1
Start-Sleep -Milliseconds 200
[MiraMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 100
for ($i = 1; $i -le 40; $i++) { Go ([int]($X1 + ($X2 - $X1) * $i / 40)) ([int]($Y1 + ($Y2 - $Y1) * $i / 40)) }
Start-Sleep -Milliseconds 300
[MiraMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 200
[MiraMouse]::SetCursorPos($old.X, $old.Y) | Out-Null
`;

async function osMouseDrag(app, page, title, colName) {
  const from = await grabPoint(page, title);
  const to = await dropPoint(page, colName);
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  const script = join(dataDir, "os-drag.ps1");
  writeFileSync(script, OS_DRAG_PS1, "utf8");
  const px = (v) => String(Math.round(v * dpr));
  execFileSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, String(app.child.pid), px(from.x), px(from.y), px(to.x), px(to.y)],
    { stdio: "pipe", timeout: 30000 },
  );
}

let app = null;
try {
  app = await launch();
  let { page } = app;

  // Onboarding.
  await newOffice(page, { name: "Rina Uji", org: "Kantor Uji", dept: "Desain" });
  await mainNav(page, "Board").waitFor({ timeout: 10000 });
  await mainNav(page, "Pengaturan").click();
  await page.getByLabel("Terang", { exact: true }).check();
  await mainNav(page, "Board").click();

  // Board kosong, lalu proyek pertama.
  await page.getByRole("button", { name: "Buat proyek pertama" }).waitFor({ timeout: 10000 });
  check("Board tanpa proyek menampilkan keadaan kosong", true);
  await page.screenshot({ path: join(shots, "t3-01-board-kosong-terang.png") });
  await page.getByRole("button", { name: "Buat proyek pertama" }).click();
  await page.getByLabel("Nama proyek").fill("Proyek A");
  const code = await page.getByLabel("Kode proyek").inputValue();
  check("Kode proyek diusulkan dari nama", code === "PA", code);
  // Kantor baru (v0.3) selalu punya departemen pendiri: superadmin bisa memilih
  // Desain atau tanpa departemen. Label baru terhubung ke select setelah data organisasi terbaca.
  const teamSelect = page.getByRole("dialog").getByLabel("Departemen", { exact: true });
  await teamSelect.waitFor({ timeout: 10000 });
  const teamOptions = (await teamSelect.locator("option").allInnerTexts()).map((s) => s.trim());
  check(
    "Pilihan Departemen untuk superadmin: Desain dan Tanpa departemen",
    teamOptions.length === 2 && teamOptions.includes("Desain") && teamOptions.includes("Tanpa departemen"),
    teamOptions.join(" | "),
  );
  await teamSelect.selectOption({ label: "Tanpa departemen" });
  await page.screenshot({ path: join(shots, "t3-02-proyek-baru-terang.png") });
  await page.getByRole("dialog").getByRole("button", { name: "Buat proyek", exact: true }).click();
  await page.getByRole("button", { name: "Task baru" }).waitFor({ timeout: 10000 });
  check("Proyek PA dibuat dan board terbuka", true);

  // Tambah task cepat di To do.
  const titles = [
    "Review kontrak proyek A",
    "Siapkan laporan bulanan",
    "Kirim jadwal rapat ke tim",
    "Cek gambar kerja lantai 2",
  ];
  await column(page, "To do").getByRole("button", { name: "Tambah task" }).click();
  for (const t of titles) {
    const input = column(page, "To do").getByLabel(/Judul task baru/);
    await input.fill(t);
    await input.press("Enter");
    await page.waitForTimeout(250);
  }
  await column(page, "To do").getByLabel(/Judul task baru/).press("Escape");
  const todo = await cardTitles(page, "To do");
  check("Empat task dibuat di To do", titles.every((t) => todo.includes(t)), todo.join(" | "));

  // Pindah dengan keyboard: Alt+Panah kanan.
  const card2 = page.locator("[data-open-task]", { hasText: "Siapkan laporan bulanan" });
  await card2.focus();
  await page.keyboard.press("Alt+ArrowRight");
  await page.waitForTimeout(500);
  check("Alt+Panah kanan memindah task ke Dikerjakan", (await cardTitles(page, "Dikerjakan")).includes("Siapkan laporan bulanan"));

  // Pindah lewat menu Pindahkan.
  await page.getByRole("button", { name: "Pindahkan PA-3" }).click();
  await page.getByRole("menuitem", { name: "Ke Selesai" }).click();
  await page.waitForTimeout(500);
  check("Menu Pindahkan memindah task ke Selesai", (await cardTitles(page, "Selesai")).includes("Kirim jadwal rapat ke tim"));

  // Pindah dengan seret mouse: tekan, gerak bertahap, lepas. Bukan menu dan
  // bukan locator.dragTo (yang memalsukan seret HTML5 lewat CDP dan dulu lulus
  // padahal seret sungguhan di Windows gagal).
  const dragged = "Cek gambar kerja lantai 2";
  try {
    const toDoing = await mouseDrag(page, dragged, "Dikerjakan", null, { shot: "t3-10-seret-berjalan-terang.png" });
    check(
      "Seret mouse: kolom tujuan disorot dan bayangan kartu ikut pointer",
      toDoing.highlighted && toDoing.ghost,
      JSON.stringify(toDoing),
    );
    check("Seret mouse memindah task dari To do ke Dikerjakan", (await cardTitles(page, "Dikerjakan")).includes(dragged));
    await mouseDrag(page, dragged, "Selesai");
    check("Seret mouse memindah task dari Dikerjakan ke Selesai", (await cardTitles(page, "Selesai")).includes(dragged));
    // Urutan di dalam kolom: taruh di atas "Kirim jadwal rapat ke tim".
    await mouseDrag(page, dragged, "Selesai", "Kirim jadwal rapat ke tim");
    const done = await cardTitles(page, "Selesai");
    check(
      "Seret mouse di dalam kolom mengubah urutan",
      done.indexOf(dragged) === 0 && done.indexOf("Kirim jadwal rapat ke tim") === 1,
      done.join(" | "),
    );
    check("Lepas seret tidak membuka detail task", (await page.getByRole("dialog").count()) === 0);
    await page.screenshot({ path: join(shots, "t3-09-seret-selesai-terang.png") });
  } catch (err) {
    check("Seret mouse memindah task antar kolom", false, String(err?.message ?? err).slice(0, 200));
  }

  // Detail task PA-1 lewat dialog v0.4: deskripsi, penanggung jawab dan prioritas
  // lewat menu, tenggat lewat isian hh/bb/tttt, label lewat pilihan Label, komentar.
  const proj = (await must(page, "board_list_projects")).find((p) => p.code === "PA");
  const taskIdOf = async (title) =>
    (await must(page, "board_get_board", { projectId: proj.id })).columns.flatMap((c) => c.tasks).find((t) => t.title === title).id;
  const me = (await must(page, "get_app_state")).identity.publicKey;
  const reviewId = await taskIdOf("Review kontrak proyek A");
  const DESC = "Cek pasal pembayaran dan lampiran teknis, lalu kirim catatan ke tim.";
  let dlg = await openTaskDialog(page, "Review kontrak proyek A");
  await dlg.getByRole("textbox", { name: "Deskripsi", exact: true }).fill(DESC);
  await dlg.getByRole("button", { name: "Simpan deskripsi" }).click();
  await page.waitForTimeout(300);
  await pickMenu(page, dlg, "Penanggung jawab", /^Rina Uji/);
  await pickDue(page, dlg, { typed: dmyDate(1) });
  await pickMenu(page, dlg, "Prioritas", "Tinggi");
  await addLabel(page, dlg, "kontrak");
  await dlg.getByRole("textbox", { name: "Tulis komentar" }).fill("Draft kontrak sudah saya baca sampai pasal 5.");
  await dlg.getByRole("button", { name: "Kirim", exact: true }).click();
  await page.waitForTimeout(600);
  const dlgText = await dlg.innerText();
  const savedReview = await must(page, "board_get_task", { projectId: proj.id, taskId: reviewId });
  const propNames = {
    assignee: await prop(dlg, "Penanggung jawab").innerText().catch(() => ""),
    priority: (await prop(dlg, "Prioritas Tinggi").count()) === 1,
    label: (await prop(dlg, "Label kontrak").count()) === 1,
    commentsTab: (await dlg.getByRole("tab", { name: /^Komentar 1$/ }).count()) === 1,
  };
  check(
    "Detail task menyimpan deskripsi, penanggung jawab, tenggat, prioritas, label, komentar",
    dlgText.includes("pasal 5") &&
      savedReview.description === DESC &&
      savedReview.assignee?.publicKey === me &&
      savedReview.due === isoDate(1) &&
      savedReview.priority === "high" &&
      savedReview.labels.includes("kontrak") &&
      savedReview.comments.length === 1,
    JSON.stringify({
      due: savedReview.due,
      priority: savedReview.priority,
      labels: savedReview.labels,
      comments: savedReview.comments.length,
    }),
  );
  check(
    "v0.4: baris properti dan tab menampilkan nilai baru (Rina Uji, Tinggi, kontrak, Komentar 1)",
    propNames.assignee.includes("Rina Uji") && propNames.priority && propNames.label && propNames.commentsTab,
    JSON.stringify(propNames),
  );
  await page.screenshot({ path: join(shots, "t3-04-detail-task-terang.png") });

  // v0.4 lewat dialog: satu subtask ditambah lalu dicentang, timer dimulai lalu
  // dihentikan tanpa catatan. Subtask kedua lewat IPC, lalu kartu menampilkan "1/2".
  try {
    const base = { projectId: proj.id, taskId: reviewId };
    await dlg.getByRole("button", { name: "Tambah subtask" }).click();
    const newSub = dlg.getByRole("textbox", { name: "Judul subtask baru" });
    await newSub.fill("Cek pasal pembayaran");
    await newSub.press("Enter");
    const subCheck = dlg.getByRole("checkbox", { name: "Cek pasal pembayaran", exact: true });
    await subCheck.waitFor({ timeout: 5000 });
    await subCheck.click();
    let subChecked = false;
    for (let i = 0; i < 20 && !subChecked; i++) {
      subChecked = await subCheck.isChecked();
      if (!subChecked) await page.waitForTimeout(250);
    }
    const progress = await dlg.getByRole("progressbar", { name: "Subtask selesai" }).getAttribute("aria-valuetext").catch(() => "");
    check("v0.4: subtask ditambah lewat Tambah subtask + Enter lalu dicentang", subChecked, progress ?? "");

    await dlg.getByRole("button", { name: "Mulai timer" }).click();
    const stopBtn = dlg.getByRole("button", { name: "Hentikan timer", exact: true });
    await stopBtn.waitFor({ timeout: 5000 });
    const started = await must(page, "board_get_task", base);
    await page.waitForTimeout(1200);
    await stopBtn.click();
    const stopDlg = dlg.getByRole("dialog", { name: "Hentikan timer" });
    await stopDlg.getByRole("button", { name: "Hentikan tanpa catatan" }).click();
    await dlg.getByRole("button", { name: "Mulai timer" }).waitFor({ timeout: 5000 });
    check(
      "v0.4: tombol Mulai timer menjalankan timer, Hentikan tanpa catatan menghentikannya",
      Boolean(started.myRunningEntry) && (await stopDlg.count()) === 0,
    );
    await page.screenshot({ path: join(shots, "v04-dialog-terang.png") });
    await closeTaskDialog(page);

    await must(page, "board_add_subtask", { ...base, title: "Cek lampiran teknis", assignee: null });
    const d = await must(page, "board_get_task", base);
    check(
      "v0.4: dua subtask (satu selesai) dan satu catatan timer yang sudah berhenti tersimpan",
      d.subtaskTotal === 2 &&
        d.subtaskDone === 1 &&
        d.subtasks.some((s) => s.title === "Cek pasal pembayaran" && s.done) &&
        d.myRunningEntry === null &&
        d.timeEntries.length === 1 &&
        d.timeEntries[0].end !== null,
      `${d.subtaskDone}/${d.subtaskTotal}, catatan=${d.timeEntries.length}, ${d.trackedSecs} dtk`,
    );
    // Buka lagi board: pindah ke Task saya lalu kembali ke proyek, supaya board dimuat ulang.
    await page.getByRole("navigation", { name: "Task saya dan proyek" }).getByRole("button", { name: /Task saya/ }).click();
    await page.waitForTimeout(400);
    await openProject(page);
    const cardEl = page.locator(`section.pb-col [data-card="${reviewId}"]`);
    let cardText = "";
    for (let i = 0; i < 30; i++) {
      cardText = await cardEl.innerText().catch(() => "");
      if (/(^|[^\d])1\s*\/\s*2([^\d]|$)/.test(cardText)) break;
      await page.waitForTimeout(500);
    }
    check(
      "v0.4: kartu task menampilkan progres subtask 1/2",
      /(^|[^\d])1\s*\/\s*2([^\d]|$)/.test(cardText),
      cardText.replace(/\s+/g, " ").slice(0, 160),
    );
    await page.screenshot({ path: join(shots, "t3-12-kartu-subtask-terang.png") });
  } catch (err) {
    check("v0.4: subtask dan timer lewat dialog, progres di kartu", false, String(err?.message ?? err).slice(0, 300));
    if ((await taskDialog(page).count()) > 0) await closeTaskDialog(page).catch(() => {});
  }

  // Task kedua untuk Task saya: penanggung jawab lewat menu, tenggat hari ini lewat pilihan cepat.
  dlg = await openTaskDialog(page, "Siapkan laporan bulanan");
  await pickMenu(page, dlg, "Penanggung jawab", /^Rina Uji/);
  await pickDue(page, dlg, { quick: /^Hari ini/ });
  await closeTaskDialog(page);

  // Hapus task lewat menu Lainnya, pada task terpisah supaya alur lain tetap sama.
  const DELETE_TITLE = "Task uji hapus";
  try {
    await column(page, "To do").getByRole("button", { name: "Tambah task" }).click();
    const quickAdd = column(page, "To do").getByLabel(/Judul task baru/);
    await quickAdd.fill(DELETE_TITLE);
    await quickAdd.press("Enter");
    await page.waitForTimeout(300);
    await column(page, "To do").getByLabel(/Judul task baru/).press("Escape");
    const delId = await taskIdOf(DELETE_TITLE);
    const delCode = (await must(page, "board_get_task", { projectId: proj.id, taskId: delId })).code;
    dlg = await openTaskDialog(page, DELETE_TITLE);
    const confirm = page.getByRole("dialog", { name: `Hapus task ${delCode}?` });
    // Batal dulu: task tetap ada dan dialog detail tetap terbuka.
    await dlg.getByRole("button", { name: "Lainnya", exact: true }).click();
    await dlg.getByRole("menuitem", { name: "Hapus task" }).click();
    await confirm.waitFor({ timeout: 5000 });
    await confirm.getByRole("button", { name: "Batal", exact: true }).click();
    await confirm.waitFor({ state: "detached", timeout: 5000 });
    const keptAfterCancel = (await call(page, "board_get_task", { projectId: proj.id, taskId: delId })).ok;
    const dialogAfterCancel = (await taskDialog(page).count()) === 1;
    await dlg.getByRole("button", { name: "Lainnya", exact: true }).click();
    await dlg.getByRole("menuitem", { name: "Hapus task" }).click();
    await confirm.waitFor({ timeout: 5000 });
    await confirm.getByRole("button", { name: `Hapus ${delCode}`, exact: true }).click();
    await confirm.waitFor({ state: "detached", timeout: 10000 });
    await taskDialog(page).waitFor({ state: "detached", timeout: 10000 });
    await page.waitForTimeout(500);
    const left = (await must(page, "board_get_board", { projectId: proj.id })).columns.flatMap((c) => c.tasks);
    check(
      "v0.4: Lainnya > Hapus task: Batal mempertahankan task, Hapus menghapusnya dari board",
      keptAfterCancel &&
        dialogAfterCancel &&
        !left.some((t) => t.id === delId) &&
        (await page.locator("[data-open-task]", { hasText: DELETE_TITLE }).count()) === 0,
      `${delCode}, batal: task=${keptAfterCancel} dialog=${dialogAfterCancel}`,
    );
  } catch (err) {
    check("v0.4: Lainnya > Hapus task", false, String(err?.message ?? err).slice(0, 300));
    if ((await page.getByRole("dialog", { name: /^Hapus task/ }).count()) > 0) await page.keyboard.press("Escape");
    if ((await taskDialog(page).count()) > 0) await closeTaskDialog(page).catch(() => {});
  }

  await page.screenshot({ path: join(shots, "t3-03-board-terang.png") });
  await page.getByRole("navigation", { name: "Task saya dan proyek" }).getByRole("button", { name: /Task saya/ }).click();
  await page.waitForTimeout(600);
  const mine = await page.locator(".content").innerText();
  check(
    "Task saya berisi task milik saya dari proyek",
    mine.includes("Review kontrak proyek A") && mine.includes("Siapkan laporan bulanan") && !mine.includes("Cek gambar kerja"),
  );
  await page.screenshot({ path: join(shots, "t3-05-task-saya-terang.png") });

  // Mode gelap.
  await setTheme(page, "Gelap");
  await page.screenshot({ path: join(shots, "t3-08-task-saya-gelap.png") });
  await openProject(page);
  await page.screenshot({ path: join(shots, "t3-06-board-gelap.png") });
  // Seret di mode gelap, lalu Escape sebelum lepas: tidak ada yang pindah.
  const darkDrag = await mouseDrag(page, "Review kontrak proyek A", "Dikerjakan", null, {
    shot: "t3-11-seret-berjalan-gelap.png",
    cancel: true,
  });
  check(
    "Escape saat seret membatalkan, task tetap di To do",
    darkDrag.ghost === false &&
      (await cardTitles(page, "To do")).includes("Review kontrak proyek A") &&
      !(await cardTitles(page, "Dikerjakan")).includes("Review kontrak proyek A"),
    JSON.stringify(darkDrag),
  );
  dlg = await openTaskDialog(page, "Review kontrak proyek A");
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, "t3-07-detail-task-gelap.png") });
  await page.screenshot({ path: join(shots, "v04-dialog-gelap.png") });
  await closeTaskDialog(page);
  await stop(app);
  app = null;

  // Restart: data tetap.
  app = await launch({ emulateViewport: process.env.MIRA_E2E_OS_MOUSE !== "1" });
  page = app.page;
  await mainNav(page, "Board").click({ timeout: 20000 });
  await openProject(page);
  const after = {
    todo: await cardTitles(page, "To do"),
    doing: await cardTitles(page, "Dikerjakan"),
    done: await cardTitles(page, "Selesai"),
  };
  check(
    "Setelah restart proyek, task, dan posisi kolom tetap",
    after.todo.includes("Review kontrak proyek A") &&
      after.doing.includes("Siapkan laporan bulanan") &&
      after.done.includes("Kirim jadwal rapat ke tim"),
    JSON.stringify(after),
  );
  check(
    "Setelah restart task yang diseret tetap di Selesai, di urutan pertama",
    after.done[0] === "Cek gambar kerja lantai 2" && !after.doing.includes("Cek gambar kerja lantai 2"),
    after.done.join(" | "),
  );

  // Opsional: seret dengan kursor Windows sungguhan (SendInput), bukan lewat CDP.
  // Kursor pengguna ikut bergerak, jadi hanya jalan dengan MIRA_E2E_OS_MOUSE=1.
  if (process.env.MIRA_E2E_OS_MOUSE === "1") {
    try {
      await osMouseDrag(app, page, "Review kontrak proyek A", "Dikerjakan");
      await page.waitForTimeout(800);
      check(
        "Seret kursor Windows sungguhan memindah task ke Dikerjakan",
        (await cardTitles(page, "Dikerjakan")).includes("Review kontrak proyek A"),
        JSON.stringify({ todo: await cardTitles(page, "To do"), doing: await cardTitles(page, "Dikerjakan") }),
      );
    } catch (err) {
      check("Seret kursor Windows sungguhan memindah task ke Dikerjakan", false, String(err?.message ?? err).slice(0, 200));
    }
  }
  await stop(app);
  app = null;
} catch (err) {
  check("Skrip berjalan tanpa error", false, String(err?.message ?? err).slice(0, 300));
  if (app) {
    await app.page.screenshot({ path: join(shots, "gagal.png") }).catch(() => {});
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
  const { readFileSync } = await import("node:fs");
  const log = readFileSync(join(dataDir, "stderr.log"), "utf8").trim();
  if (log) console.log(`stderr aplikasi:\n${log.slice(-2000)}`);
} catch {
  /* tidak ada log */
}
rmSync(dataDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} pemeriksaan lulus.`);
process.exit(failed ? 1 : 0);
