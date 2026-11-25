// Uji ujung ke ujung chat dan board antar beberapa "laptop" Mira di satu PC,
// lewat transport jaringan sungguhan (QUIC di 127.0.0.1, penemuan mDNS).
//
// Menjalankan tiga instance mira.exe hasil build release, masing-masing dengan
// folder data (MIRA_DATA_DIR), port QUIC (MIRA_PORT), dan port debug WebView2
// sendiri, lalu mengendalikannya lewat Chrome DevTools Protocol. Organisasi
// disiapkan lewat command Tauri (seperti e2e-multi.mjs); aksi chat dan board
// dijalankan lewat layar, dan hasilnya ditunggu di layar laptop penerima.
//
//   A  Ayu    superadmin, anggota Tim Desain
//   B  Budi   Anggota Tim Desain
//   C  Citra  Anggota Tim Keuangan (tim lain)
//
// Lampiran: dialog "Lampirkan file" milik Windows diisi lewat UI Automation
// (PowerShell, hanya jendela dialog milik proses A yang dijalankan skrip ini).
//
// Pemeriksaan 8 sampai 12 menguji chat v0.3 (docs/plans/v03-c.md): channel Umum hanya
// dari superadmin, grup, channel proyek untuk anggota proyek saja, channel departemen
// setelah orang dipindah lewat command org, dan keluar dari grup. Yang tidak boleh
// sampai ke C (atau ke B setelah keluar) diperiksa bersama setelah dua putaran sinkron
// cadangan.
//
// Pemeriksaan 13 menguji chat v0.4 (docs/plans/v04-chat.md): chat proyek tampil sebagai
// grup berisi anggota proyek dan ikut berubah saat anggota proyek berubah, grup yang hanya
// berisi pembuatnya, dan lipatan sidebar yang benar-benar menyembunyikan isinya (CSS) dan
// bertahan setelah halaman dimuat ulang.
//
// Pakai:  node scripts/e2e-fitur-multi.mjs <path mira.exe> <folder screenshot> [folder screenshot v0.3] [folder screenshot v0.4]
// Build dulu: npx tauri build --no-bundle (atau --debug --no-bundle untuk build debug)

import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { mainNav } from "./e2e-onboarding.mjs";
import { deleteOwnKeys } from "./e2e-keys.mjs";

const exe = resolve(process.argv[2] ?? "src-tauri/target/release/mira.exe");
const shots = resolve(process.argv[3] ?? "docs/progress/screenshots/fitur-multi");
mkdirSync(shots, { recursive: true });
const shotsV03 = resolve(process.argv[4] ?? "docs/progress/screenshots/v03-c");
mkdirSync(shotsV03, { recursive: true });
const shotsV04 = resolve(process.argv[5] ?? "docs/progress/screenshots/v04-chat");
mkdirSync(shotsV04, { recursive: true });
const ONLY_V03 = process.env.MIRA_E2E_ONLY_V03 === "1";
const root = mkdtempSync(join(tmpdir(), "mira-fitur-multi-"));

// Geser semua port (debug WebView2 dan QUIC) supaya bisa jalan berdampingan dengan uji lain di PC yang sama.
const PORT_OFFSET = Number(process.env.E2E_PORT_OFFSET ?? 0) || 0;
const NODES = {
  A: { name: "Ayu Uji", port: 47861 + PORT_OFFSET, cdp: 9361 + PORT_OFFSET, dir: join(root, "laptop-a") },
  B: { name: "Budi Uji", port: 47862 + PORT_OFFSET, cdp: 9362 + PORT_OFFSET, dir: join(root, "laptop-b") },
  C: { name: "Citra Uji", port: 47863 + PORT_OFFSET, cdp: 9363 + PORT_OFFSET, dir: join(root, "laptop-c") },
};
const addr = (id) => `127.0.0.1:${NODES[id].port}`;
// Sinkron berjalan saat ada perubahan, ditambah cadangan berkala 60 detik;
// layar chat polling 10 detik, board 15 detik. Batas tunggu dibuat longgar.
const SYNC_MS = 150000;

const TEXT = {
  umum: "Selamat pagi semua, ini pesan uji di #umum.",
  team: "Rapat Tim Desain jam 2 siang, khusus anggota tim.",
  dm: "Budi, tolong cek draf brosur ya.",
  titip: "Pesan ini dikirim saat laptop Budi mati.",
  attach: "Ini lampiran catatan rapat.",
};
const PROJECT = "Proyek Brosur Pameran";
const PROJECT_CODE = "BP";
const TASK = "Desain sampul brosur";
const FILE_NAME = "catatan-rapat-uji.txt";
const FILE_BODY = "Catatan rapat uji Mira.\nBaris kedua.\n";

function miraCredentials() {
  try {
    const out = execFileSync("cmdkey", ["/list"], { encoding: "utf8" });
    return new Set(out.match(/device-key-[0-9a-f]{64}\.id\.mira\.desktop/g) ?? []);
  } catch {
    return new Set();
  }
}
const credentialsBefore = miraCredentials();
// Kunci laptop uji milik skrip ini (nama entri memuat kunci publik, identity::keystore_account).
// Skrip uji lain yang berjalan bersamaan bisa menghapus semua kunci "baru" di akhir larinya;
// kalau kunci kita ikut hilang, instance yang dinyalakan lagi berhenti dengan key_mismatch.
// Karena itu di akhir skrip ini hanya menghapus kuncinya sendiri.
const ownKeys = new Set();
const keyTarget = (publicKey) => `device-key-${publicKey}.id.mira.desktop`;
function checkOwnKeys(when) {
  const now = miraCredentials();
  const gone = [...ownKeys].filter((k) => !now.has(k));
  if (gone.length) note(`${when}: ${gone.length} dari ${ownKeys.size} kunci uji sudah dihapus dari Credential Manager oleh proses lain`);
}

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

async function launch(id) {
  const node = NODES[id];
  mkdirSync(node.dir, { recursive: true });
  const log = createWriteStream(join(root, `${id}-stderr.log`), { flags: "a" });
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      MIRA_DATA_DIR: node.dir,
      MIRA_PORT: String(node.port),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${node.cdp}`,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.pipe(log);
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
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages())[0];
    if (!page) await sleep(250);
  }
  const consoleLines = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") consoleLines.push(`[${m.type()}] ${m.text()}`);
  });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => "__TAURI_INTERNALS__" in window, null, { timeout: 20000 });
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  running[id] = { child, browser, page, consoleLines };
  return running[id];
}

async function stop(id) {
  const app = running[id];
  if (!app) return;
  delete running[id];
  await app.browser.close().catch(() => {});
  try {
    execFileSync("taskkill", ["/PID", String(app.child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* sudah berhenti */
  }
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
const settle = (desc, fn, timeoutMs) => waitFor(desc, fn, timeoutMs).catch((e) => String(e.message));
const page = (id) => running[id].page;
const shot = (id, name) => page(id).screenshot({ path: join(shots, name) }).catch(() => {});
const shotV03 = (id, name) => page(id).screenshot({ path: join(shotsV03, name) }).catch(() => {});
const shotV04 = (id, name) => page(id).screenshot({ path: join(shotsV04, name) }).catch(() => {});
const onlineNames = async (id) =>
  (await must(id, "get_network_status")).peers.filter((p) => p.online).map((p) => p.displayName).sort();

// ---- Selektor layar (sama dengan chat-e2e.mjs dan board-e2e.mjs) ----
const sel = {
  list: (p) => p.getByRole("navigation", { name: /Daftar percakapan/i }),
  // Nama baris: "Channel umum" atau "Channel umum, hanya-baca, 2 pesan belum dibaca". Diakhiri
  // koma atau akhir teks supaya tombol "Channel umum baru" tidak ikut cocok.
  channelRow: (p, name) => sel.list(p).getByRole("button", { name: new RegExp(`^Channel ${name}(,|$)`) }),
  // v0.2: "Chat pribadi dengan X"; v0.3: "Pesan pribadi dengan X".
  dmRow: (p, name) => sel.list(p).getByRole("button", { name: new RegExp(`^(Chat|Pesan) pribadi dengan ${name}(,|$)`) }),
  groupRow: (p, name) => sel.list(p).getByRole("button", { name: new RegExp(`^Grup ${name}(,|$)`) }),
  // v0.4: chat bawaan proyek tampil seperti grup, tanpa "#".
  projectRow: (p, name) => sel.list(p).getByRole("button", { name: new RegExp(`^Chat proyek ${name}(,|$)`) }),
  // Juga baris di bagian terlipat (tersembunyi).
  projectRowAny: (p, name) =>
    sel.list(p).getByRole("button", { name: new RegExp(`^Chat proyek ${name}(,|$)`), includeHidden: true }),
  section: (p, title) => sel.list(p).getByRole("region", { name: title, exact: true }),
  conv: (p, title) => p.getByRole("region", { name: title, exact: true }),
  log: (p) => p.getByRole("region", { name: /^Pesan di/ }),
  composer: (p) => p.getByRole("combobox", { name: /^Pesan untuk/ }),
  message: (p, text) => sel.log(p).getByRole("listitem").filter({ hasText: text }).first(),
  deleteBtn: (msg) => msg.getByRole("button", { name: /^Hapus pesan/ }),
  statusBtn: (msg) => msg.getByRole("button", { name: /^Status:/ }),
  dialog: (p, name) => p.getByRole("dialog", { name }),
};
const projectNav = (p) => p.getByRole("navigation", { name: "Task saya dan proyek" });
const column = (p, name) => p.locator("section.pb-col").filter({ has: p.getByRole("heading", { name }) });
const card = (p, title) => p.locator("[data-open-task]", { hasText: title });

async function goChat(id) {
  await mainNav(page(id), "Chat").click();
  await sel.list(page(id)).waitFor({ timeout: 15000 });
}
async function openChannel(id, name) {
  await sel.channelRow(page(id), name).click({ timeout: SYNC_MS });
  await sel.conv(page(id), `#${name}`).waitFor({ timeout: 15000 });
}
async function openProjectChat(id, name) {
  await sel.projectRow(page(id), name).click({ timeout: SYNC_MS });
  await sel.conv(page(id), name).waitFor({ timeout: 15000 });
}
// Keadaan lipat bagian menurut tampilan sungguhan: tombol, lalu CSS isi bagian.
async function foldState(id, title) {
  const section = sel.section(page(id), title);
  const expanded = await section.locator("button.chat-fold").getAttribute("aria-expanded");
  const display = await section.locator(".chat-sec-body").evaluate((el) => getComputedStyle(el).display);
  return { expanded, display };
}
async function send(id, text) {
  const input = sel.composer(page(id));
  await input.click();
  await input.fill(text);
  await input.press("Enter");
  await sel.message(page(id), text).waitFor({ timeout: 15000 });
}
// Tombol aksi pesan baru terlihat saat hover atau fokus: pakai keyboard.
async function pressAction(button) {
  await button.focus();
  await button.press("Enter");
}
async function statusText(id, text) {
  const btn = sel.statusBtn(sel.message(page(id), text));
  if (!(await btn.count())) return "";
  return (await btn.getAttribute("aria-label")) ?? "";
}
async function setLight(id) {
  await mainNav(page(id), "Pengaturan").click();
  await page(id).getByLabel("Terang", { exact: true }).check();
  await sleep(200);
}

// Mengisi dialog Windows "Lampirkan file" milik proses `pid` lewat UI Automation.
// Kontrol dialog Windows terbaca sebagai Pane tanpa pola UIA, jadi isian nama
// file diisi dengan WM_SETTEXT dan tombol Open (id 1) ditekan dengan BM_CLICK.
const PICK_PS1 = String.raw`
param([int]$ProcId, [string]$Path, [string]$Title)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -Namespace MiraUji -Name Win -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode)]
public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, string lParam);
[DllImport("user32.dll")]
public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
'@
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
function Find-Raw($el, $id, $cls, $depth) {
  if ($depth -gt 6) { return $null }
  $c = $walker.GetFirstChild($el)
  while ($c) {
    if ($c.Current.AutomationId -eq $id -and $c.Current.ClassName -eq $cls) { return $c }
    $hit = Find-Raw $c $id $cls ($depth + 1)
    if ($hit) { return $hit }
    $c = $walker.GetNextSibling($c)
  }
  return $null
}
$deadline = (Get-Date).AddSeconds(30)
$dlg = $null
while (-not $dlg -and (Get-Date) -lt $deadline) {
  $wins = $AE::RootElement.FindAll($TS::Children, (New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $ProcId)))
  foreach ($w in $wins) { if ($w.Current.Name -eq $Title -and $w.Current.ClassName -eq '#32770') { $dlg = $w; break } }
  if (-not $dlg) { Start-Sleep -Milliseconds 300 }
}
if (-not $dlg) { Write-Output 'NO_DIALOG'; exit 2 }
$edit = $null
for ($i = 0; $i -lt 50 -and -not $edit; $i++) {
  $edit = Find-Raw $dlg '1148' 'Edit' 0
  if (-not $edit) { Start-Sleep -Milliseconds 200 }
}
if (-not $edit) { Write-Output 'NO_EDIT'; exit 3 }
$open = Find-Raw $dlg '1' 'Button' 0
if (-not $open) { Write-Output 'NO_OPEN'; exit 4 }
[void][MiraUji.Win]::SendMessage([IntPtr]$edit.Current.NativeWindowHandle, 0x000C, [IntPtr]::Zero, $Path)
Start-Sleep -Milliseconds 300
[void][MiraUji.Win]::PostMessage([IntPtr]$open.Current.NativeWindowHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
Write-Output 'OK'
`;
function fillFileDialog(pid, path, title) {
  const ps1 = join(root, "isi-dialog.ps1");
  writeFileSync(ps1, PICK_PS1);
  return new Promise((done) => {
    const ps = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-ProcId", String(pid), "-Path", path, "-Title", title], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    ps.stdout.on("data", (d) => (out += d));
    ps.stderr.on("data", (d) => (out += d));
    ps.on("close", (code) => done({ code, out: out.trim() }));
  });
}

// Mencari file di folder data yang isinya sama persis (untuk lampiran yang sudah diunduh).
function findFileWithBody(dir, body) {
  const want = Buffer.from(body);
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        try {
          if (statSync(p).size === want.length && readFileSync(p).equals(want)) return p;
        } catch {
          /* terkunci */
        }
      }
    }
  }
  return null;
}

try {
  // ---------- Persiapan organisasi ----------
  for (const id of Object.keys(NODES)) await launch(id);
  for (const id of Object.keys(NODES)) await must(id, "save_display_name", { name: NODES[id].name });
  const pk = {};
  for (const id of Object.keys(NODES)) pk[id] = (await must(id, "get_app_state")).identity.publicKey;
  for (const id of Object.keys(NODES)) ownKeys.add(keyTarget(pk[id]));

  await must("A", "create_organization", { name: "Kantor Uji" });
  const desain = await must("A", "create_team", { name: "Tim Desain" });
  const keuangan = await must("A", "create_team", { name: "Tim Keuangan" });
  await must("A", "add_team_member", { teamId: desain.id, publicKey: pk.A });
  const invB = await must("A", "create_invite", { teamId: desain.id, role: "member", validity: "24h", projectIds: [] });
  const invC = await must("A", "create_invite", { teamId: keuangan.id, role: "member", validity: "24h", projectIds: [] });
  const joinB = await call("B", "join_with_code", { code: invB.code, address: addr("A") });
  const joinC = await call("C", "join_with_code", { code: invC.code, address: addr("A") });
  if (!joinB.ok || !joinC.ok) throw new Error(`Gabung gagal: B=${JSON.stringify(joinB)} C=${JSON.stringify(joinC)}`);

  await waitFor("A melihat B di Tim Desain dan C di Tim Keuangan", async () => {
    const d = await must("A", "get_directory");
    const inTeam = (t, k) => d.teams.find((x) => x.id === t)?.members.some((m) => m.publicKey === k);
    return inTeam(desain.id, pk.B) && inTeam(keuangan.id, pk.C);
  });
  for (const id of ["A", "B", "C"]) {
    const others = ["A", "B", "C"].filter((x) => x !== id).map((x) => NODES[x].name).sort();
    await waitFor(`${id} melihat dua rekan online`, async () => JSON.stringify(await onlineNames(id)) === JSON.stringify(others));
  }
  // Channel tim Desain dari log keanggotaan.
  const teamConv = await waitFor("channel Tim Desain ada di chat A dan B", async () => {
    const a = (await must("A", "chat_overview")).conversations.find((c) => c.scope?.kind === "team" && c.scope?.id === desain.id);
    const b = (await must("B", "chat_overview")).conversations.find((c) => c.scope?.kind === "team" && c.scope?.id === desain.id);
    return a && b ? a : null;
  });
  const umumConv = (await must("A", "chat_overview")).conversations.find((c) => c.isUmum);
  check(
    "Persiapan: A, B, C satu organisasi, saling online, channel tim tersedia",
    Boolean(teamConv && umumConv),
    `#${umumConv?.name}, #${teamConv?.name}, ${secs(t0)}`,
  );

  for (const id of ["A", "B", "C"]) {
    await page(id).reload();
    await page(id).waitForFunction(() => "__TAURI_INTERNALS__" in window, null, { timeout: 20000 });
    await mainNav(page(id), "Chat").waitFor({ timeout: 20000 });
    await setLight(id);
    await goChat(id);
  }

  // MIRA_E2E_ONLY_V03=1 melewati pemeriksaan 1 sampai 7 (untuk mengulang bagian v0.3 saja).
  checks1to7: {
    if (ONLY_V03) break checks1to7;
    // ---------- 1. Pesan di #umum ----------
    {
      const since = Date.now();
      await openChannel("A", umumConv.name);
      await send("A", TEXT.umum);
      await openChannel("B", umumConv.name);
      await openChannel("C", umumConv.name);
      const onB = await settle("B melihat pesan #umum", async () => (await sel.message(page("B"), TEXT.umum).count()) > 0);
      const onC = await settle("C melihat pesan #umum", async () => (await sel.message(page("C"), TEXT.umum).count()) > 0);
      check("1. Pesan A di #umum tampil di layar B", onB === true, onB === true ? secs(since) : onB);
      check("1. Pesan A di #umum tampil di layar C", onC === true, onC === true ? secs(since) : onC);
      await shot("B", "fm-01-umum-b.png");
      await shot("C", "fm-01-umum-c.png");
    }

    // ---------- 2. Pesan di channel tim ----------
    {
      const since = Date.now();
      await openChannel("A", teamConv.name);
      await send("A", TEXT.team);
      await openChannel("B", teamConv.name);
      const onB = await settle("B melihat pesan channel tim", async () => (await sel.message(page("B"), TEXT.team).count()) > 0);
      check(`2. Pesan A di #${teamConv.name} tampil di layar B`, onB === true, onB === true ? secs(since) : onB);
      await shot("B", "fm-02-channel-tim-b.png");
      // C diberi waktu satu putaran sinkron cadangan penuh sebelum diperiksa.
      await sleep(Math.max(0, 65000 - (Date.now() - since)));
      const cOverview = await must("C", "chat_overview");
      const cHasConv = cOverview.conversations.some((c) => c.id === teamConv.id);
      const cMsgs = await call("C", "chat_messages", { conv: teamConv.id, before: null, limit: 100 });
      const cHasText = cMsgs.ok && cMsgs.value.messages.some((m) => m.text === TEXT.team);
      const cRow = await sel.channelRow(page("C"), teamConv.name).count();
      const cBody = await page("C").locator("body").innerText();
      check(
        `2. C (Tim Keuangan) tidak pernah menerima #${teamConv.name} maupun pesannya`,
        !cHasConv && !cHasText && cRow === 0 && !cBody.includes(TEXT.team),
        `percakapan=${cHasConv}, pesan=${cHasText}, baris=${cRow}, chat_messages=${cMsgs.ok ? "ok" : cMsgs.error?.code}`,
      );
      await shot("C", "fm-02-channel-tim-c-tidak-ada.png");
    }

    // ---------- 3. Chat pribadi A ke B, status ----------
    let dmConvId = null;
    {
      const since = Date.now();
      const pa = page("A");
      await pa.getByRole("button", { name: /^(Chat pribadi baru|Pesan baru)$/ }).click();
      const dlg = sel.dialog(pa, /^(Chat pribadi baru|Pesan baru)$/);
      await dlg.waitFor({ timeout: 10000 });
      await dlg.getByRole("button", { name: new RegExp(NODES.B.name) }).click();
      await sel.conv(pa, NODES.B.name).waitFor({ timeout: 15000 });
      await send("A", TEXT.dm);
      dmConvId = (await must("A", "chat_overview")).conversations.find((c) => c.kind === "dm" && c.peer?.publicKey === pk.B)?.id;
      // B belum membuka chat pribadinya: daftar B menampilkan barisnya.
      await goChat("B");
      const rowOnB = await settle("baris chat pribadi dari A muncul di B", async () => (await sel.dmRow(page("B"), NODES.A.name).count()) > 0);
      check("3. Chat pribadi A muncul di daftar chat B", rowOnB === true, rowOnB === true ? secs(since) : rowOnB);
      const delivered = await settle("A melihat Diterima laptopnya", async () => {
        const s = await statusText("A", TEXT.dm);
        return /Diterima laptopnya|Dibaca/.test(s) ? s : null;
      });
      check(
        "3. Status di A sampai Diterima laptopnya sebelum B membuka",
        typeof delivered === "string" && /Diterima laptopnya/.test(delivered),
        delivered,
      );
      await shot("A", "fm-03-dm-diterima-a.png");
      await sel.dmRow(page("B"), NODES.A.name).click();
      const onB = await settle("B melihat isi chat pribadi", async () => (await sel.message(page("B"), TEXT.dm).count()) > 0);
      check("3. Isi chat pribadi tampil di B setelah dibuka", onB === true, onB === true ? "" : onB);
      await shot("B", "fm-03-dm-b.png");
      const readAt = Date.now();
      const read = await settle("A melihat Dibaca", async () => {
        const s = await statusText("A", TEXT.dm);
        return /Dibaca/.test(s) ? s : null;
      });
      check("3. Status di A menjadi Dibaca setelah B membuka", typeof read === "string" && /Dibaca/.test(read), `${read} (${secs(readAt)})`);
      await shot("A", "fm-03-dm-dibaca-a.png");
    }

    // ---------- 4. Titipan ----------
    {
      await stop("B");
      const offAt = Date.now();
      const bOff = await settle("A melihat B offline", async () => !(await onlineNames("A")).includes(NODES.B.name), 120000);
      note(`B dimatikan; A melihat B offline ${bOff === true ? `setelah ${secs(offAt)}` : "tidak terjadi"}`);
      const cOnline = (await onlineNames("A")).includes(NODES.C.name);
      await send("A", TEXT.titip);
      const seen = new Set();
      const titipAt = Date.now();
      const status = await settle("A menampilkan Dititipkan", async () => {
        const s = await statusText("A", TEXT.titip);
        if (s) seen.add(s.replace(/^Status: /, "").replace(/\. Lihat rincian per orang$/, ""));
        return /Dititipkan/.test(s) ? s : null;
      }, 45000);
      const observed = [...seen].join(" -> ") || "(tidak ada baris status)";
      const want = cOnline ? /Dititipkan/ : /Menunggu/;
      check(
        `4. B mati: status di A ${cOnline ? "Dititipkan (C online untuk memegang titipan)" : "Menunggu (C tidak online)"}`,
        [...seen].some((s) => want.test(s)),
        `teramati: ${observed}; C online di A=${cOnline}${/Dititipkan/.test(status) ? `; Dititipkan setelah ${secs(titipAt)}` : ""}`,
      );
      const titipMsg = (await must("A", "chat_messages", { conv: dmConvId, before: null, limit: 100 })).messages.find((m) => m.text === TEXT.titip);
      note(`status inti A untuk pesan titipan: ${JSON.stringify(titipMsg?.status)}`);
      await shot("A", "fm-04-titipan-a.png");

      // A dimatikan sebelum B menyala, jadi pesan hanya bisa sampai lewat titipan di C.
      await stop("A");
      const onAt = Date.now();
      checkOwnKeys("sebelum B menyala lagi");
      await launch("B");
      await mainNav(page("B"), "Chat").waitFor({ timeout: 20000 });
      await goChat("B");
      const bBack = await settle("B tersambung ke C", async () => (await onlineNames("B")).includes(NODES.C.name), 120000);
      note(`A dimatikan, B menyala lagi; B tersambung ke C: ${bBack === true ? secs(onAt) : bBack}`);
      await sel.dmRow(page("B"), NODES.A.name).click({ timeout: SYNC_MS });
      const got = await settle("B menerima pesan titipan", async () => (await sel.message(page("B"), TEXT.titip).count()) > 0);
      check(
        "4. B yang dinyalakan lagi menerima pesan lewat titipan di C (A sedang mati)",
        got === true,
        got === true ? secs(onAt) : got,
      );
      await shot("B", "fm-04-titipan-diterima-b.png");

      const aAt = Date.now();
      checkOwnKeys("sebelum A menyala lagi");
      await launch("A");
      await mainNav(page("A"), "Chat").waitFor({ timeout: 20000 });
      await goChat("A");
      await sel.dmRow(page("A"), NODES.B.name).click({ timeout: 30000 });
      const after = await settle("status A setelah menyala lagi", async () => {
        const s = await statusText("A", TEXT.titip);
        return /Diterima laptopnya|Dibaca/.test(s) ? s : null;
      });
      check(
        "4. A yang menyala lagi melihat pesan titipan sudah sampai (Diterima laptopnya atau Dibaca)",
        typeof after === "string" && /Diterima laptopnya|Dibaca/.test(after),
        typeof after === "string" && after.startsWith("Status") ? `${after} (${secs(aAt)})` : after,
      );
      await shot("A", "fm-04-titipan-sampai-a.png");
    }

    // ---------- 5. Hapus pesan ----------
    {
      const since = Date.now();
      await openChannel("A", umumConv.name);
      await pressAction(sel.deleteBtn(sel.message(page("A"), TEXT.umum)));
      const delDlg = sel.dialog(page("A"), /Hapus pesan ini/);
      await delDlg.waitFor({ timeout: 10000 });
      await delDlg.getByRole("button", { name: /^Hapus pesan$/ }).click();
      await delDlg.waitFor({ state: "hidden", timeout: 10000 });
      await openChannel("B", umumConv.name);
      const gone = await settle("B menampilkan Pesan dihapus", async () => {
        const marker = await sel.log(page("B")).getByText("Pesan dihapus", { exact: true }).count();
        const old = await sel.log(page("B")).getByText(TEXT.umum).count();
        return marker > 0 && old === 0;
      });
      check("5. Pesan yang dihapus A tampil sebagai Pesan dihapus di B", gone === true, gone === true ? secs(since) : gone);
      await shot("B", "fm-05-pesan-dihapus-b.png");
    }

    // ---------- 6. Board ----------
    {
      const pa = page("A");
      await mainNav(pa, "Board").click();
      await pa.getByRole("button", { name: /^(Buat proyek pertama|Proyek baru)$/ }).first().click({ timeout: 15000 });
      const dlg = pa.getByRole("dialog");
      await dlg.getByLabel("Nama proyek").fill(PROJECT);
      await dlg.getByLabel("Kode proyek").fill(PROJECT_CODE);
      await dlg.getByLabel("Departemen", { exact: true }).selectOption({ label: "Tim Desain" });
      // v0.3: proyek hanya terlihat anggotanya, jadi B dicentang di pemilih orang dialog Proyek baru.
      await dlg.getByLabel("Cari nama").fill(NODES.B.name);
      await dlg.getByRole("checkbox", { name: NODES.B.name, exact: true }).check({ timeout: 15000 });
      await dlg.getByLabel("Cari nama").fill("");
      await dlg.getByRole("button", { name: "Buat proyek", exact: true }).click();
      await pa.getByRole("button", { name: "Task baru" }).waitFor({ timeout: 15000 });
      const todo = column(pa, "To do");
      await todo.getByRole("button", { name: "Tambah task" }).click();
      const input = todo.getByLabel(/Judul task baru/);
      await input.fill(TASK);
      await input.press("Enter");
      await sleep(400);
      await todo.getByLabel(/Judul task baru/).press("Escape").catch(() => {});
      await card(pa, TASK).click();
      // Dialog detail task v0.4: Penanggung jawab adalah tombol di group "Rincian task"
      // yang membuka menu menuitemradio (bukan select lagi).
      const tdlg = pa.getByRole("dialog").filter({ has: pa.getByRole("button", { name: "Tutup detail task" }) });
      const who = tdlg.getByRole("group", { name: "Rincian task" }).getByRole("button", { name: /^Penanggung jawab(\s|$)/ });
      await who.waitFor({ timeout: 10000 });
      // Daftar penanggung jawab dimuat ulang board (polling 15 detik) setelah B jadi
      // anggota, jadi menu dibuka ulang sampai B ada.
      const whoDeadline = Date.now() + 45000;
      let whoPicked = false;
      while (!whoPicked && Date.now() < whoDeadline) {
        if (!(await tdlg.isVisible())) await card(pa, TASK).click();
        await who.click();
        const menu = tdlg.getByRole("menu", { name: "Penanggung jawab", exact: true });
        await menu.waitFor({ timeout: 5000 });
        const item = menu.getByRole("menuitemradio", { name: new RegExp("^" + NODES.B.name) });
        if (await item.count()) {
          await item.first().click();
          await menu.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
          whoPicked = true;
        } else {
          await pa.keyboard.press("Escape");
          await sleep(2000);
        }
      }
      if (!whoPicked) throw new Error(`${NODES.B.name} tidak muncul di menu Penanggung jawab`);
      await sleep(500);
      await tdlg.getByRole("button", { name: "Tutup detail task" }).click();
      const project = (await must("A", "board_list_projects")).find((p) => p.code === PROJECT_CODE);
      const board = await must("A", "board_get_board", { projectId: project.id });
      const taskA = board.columns.flatMap((c) => c.tasks).find((t) => t.title === TASK);
      const pm = await must("A", "org_project_members", { projectId: project.id });
      const pmKeys = pm.members.map((m) => m.publicKey);
      check(
        "6. A membuat proyek Tim Desain dengan anggota B lewat dialog, dan task untuk B",
        project?.teamId === desain.id && taskA?.assignee?.publicKey === pk.B && pmKeys.includes(pk.B) && !pmKeys.includes(pk.C),
        `${project?.code} tim=${project?.teamName}, anggota=${pmKeys.length}, ${taskA?.code} -> ${taskA?.assignee?.name}`,
      );
      await shot("A", "fm-06-board-a.png");

      const since = Date.now();
      const pb = page("B");
      await mainNav(pb, "Board").click();
      const listed = await settle("proyek muncul di board B", async () =>
        (await projectNav(pb).getByRole("button", { name: new RegExp(PROJECT) }).count()) > 0,
      );
      let onBoard = listed;
      if (listed === true) {
        await projectNav(pb).getByRole("button", { name: new RegExp(PROJECT) }).click();
        onBoard = await settle("task tampil di board B dengan penanggung jawab B", async () => {
          if (!(await card(pb, TASK).count())) return false;
          return (await card(pb, TASK).innerText()).length > 0;
        });
      }
      check("6. Proyek dan task tampil di board B", onBoard === true, onBoard === true ? secs(since) : onBoard);
      await shot("B", "fm-06-board-b.png");
      await projectNav(pb).getByRole("button", { name: /Task saya/ }).click();
      const mine = await settle("task tampil di Task saya B", async () => (await pb.locator(".content").innerText()).includes(TASK), 60000);
      check("6. Task tampil di Task saya milik B", mine === true, mine === true ? "" : mine);
      await shot("B", "fm-06-task-saya-b.png");

      await projectNav(pb).getByRole("button", { name: new RegExp(PROJECT) }).click();
      await card(pb, TASK).waitFor({ timeout: 15000 });
      await pb.getByRole("button", { name: `Pindahkan ${taskA.code}` }).click();
      await pb.getByRole("menuitem", { name: "Ke Dikerjakan" }).click();
      await column(pb, "Dikerjakan").locator("[data-open-task]", { hasText: TASK }).waitFor({ timeout: 15000 });
      const movedAt = Date.now();
      const onA = await settle("A melihat task di Dikerjakan", async () =>
        (await column(pa, "Dikerjakan").locator("[data-open-task]", { hasText: TASK }).count()) > 0,
      );
      check("6. B memindah task ke Dikerjakan, A melihat pindahnya", onA === true, onA === true ? secs(movedAt) : onA);
      await shot("A", "fm-06-pindah-terlihat-a.png");

      const pc = page("C");
      await mainNav(pc, "Board").click();
      await sleep(3000);
      const cProjects = await must("C", "board_list_projects");
      const cNav = (await projectNav(pc).count()) ? await projectNav(pc).innerText() : "";
      const cBoard = await call("C", "board_get_board", { projectId: project.id });
      check(
        "6. C (tim lain) tidak melihat proyek Tim Desain",
        !cProjects.some((p) => p.id === project.id) && !cNav.includes(PROJECT) && !cBoard.ok,
        `daftar=${cProjects.map((p) => p.code).join(",") || "kosong"}, board_get_board=${cBoard.ok ? "terbuka" : cBoard.error?.code}`,
      );
      await shot("C", "fm-06-board-c.png");
    }

    // ---------- 7. Lampiran ----------
    {
      const filesDir = mkdtempSync(join(tmpdir(), "mira-lampiran-"));
      const filePath = join(filesDir, FILE_NAME);
      writeFileSync(filePath, FILE_BODY);
      try {
        await goChat("A");
        await openChannel("A", umumConv.name);
        const pa = page("A");
        await pa.getByRole("button", { name: "Lampirkan file" }).click();
        const filled = await fillFileDialog(running.A.child.pid, filePath, "Lampirkan file");
        const attached = await pa
          .getByRole("list", { name: "File yang akan dikirim" })
          .getByText(FILE_NAME)
          .waitFor({ timeout: 15000 })
          .then(() => true)
          .catch(() => false);
        check("7. File dipilih lewat dialog Lampirkan file di A", attached, `UI Automation: ${filled.code} ${filled.out}`);
        if (attached) {
          await send("A", TEXT.attach);
          await shot("A", "fm-07-lampiran-a.png");
          const since = Date.now();
          await goChat("B");
          await openChannel("B", umumConv.name);
          const openBtn = () => sel.message(page("B"), TEXT.attach).getByRole("button", { name: `Buka ${FILE_NAME}` });
          const ready = await settle("lampiran siap dibuka di B", async () => (await openBtn().count()) > 0);
          const onDisk = findFileWithBody(NODES.B.dir, FILE_BODY);
          check(
            "7. Lampiran A sampai di B, tombol Buka tersedia dan isi file sama",
            ready === true && Boolean(onDisk),
            ready === true ? `${secs(since)}, salinan di ${onDisk ? onDisk.replace(root, "<data>") : "tidak ditemukan"}` : ready,
          );
          note("Tombol Buka tidak diklik: membukanya menjalankan aplikasi bawaan Windows (Notepad) di luar uji.");
          await shot("B", "fm-07-lampiran-b.png");
        }
      } finally {
        rmSync(filesDir, { recursive: true, force: true });
      }
    }
  }

  // ================= v0.3: lima bagian, channel Umum, grup, proyek, departemen =================
  const V3 = {
    umumName: "pengumuman-kantor",
    rogueName: "channel-liar",
    group: "Peluncuran Brosur",
    groupMsg: "Halo Ayu, ini pesan pertama di grup peluncuran.",
    afterLeave: "Pesan ini dikirim setelah Budi keluar dari grup.",
    projectName: "Proyek Lintas Kantor",
    projectCode: "LK",
    projectMsg: "Catatan proyek lintas kantor, khusus anggota proyek.",
    deptX: "Pemasaran",
    deptY: "Gudang",
    deptMsg: "Rapat Departemen Pemasaran besok pagi.",
  };
  const SECTIONS = ["Umum", "Departemen", "Proyek", "Grup", "Pesan pribadi"];
  const ov = (id) => must(id, "chat_overview");
  const findConv = async (id, pred) => (await ov(id)).conversations.find(pred) ?? null;
  const msgTexts = async (id, conv) => {
    const r = await call(id, "chat_messages", { conv, before: null, limit: 100 });
    return r.ok ? { ok: true, texts: r.value.messages.map((m) => m.text) } : { ok: false, code: r.error?.code, texts: [] };
  };
  const describeMsgs = (m) => (m.ok ? `${m.texts.length} pesan` : `ditolak (${m.code})`);
  const sectionNames = async (id) =>
    sel.list(page(id)).getByRole("region").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  // Pemeriksaan "tidak pernah sampai" dijalankan bersama setelah jeda sinkron di akhir.
  const negatives = [];
  let lastSendAt = Date.now();

  for (const id of ["A", "B", "C"]) {
    await setLight(id);
    await goChat(id);
  }

  // ---------- 8. Channel Umum hanya dibuat superadmin ----------
  {
    const since = Date.now();
    const created = await call("A", "chat_create_channel", { name: V3.umumName, scope: { kind: "org", id: null } });
    const aOv = await ov("A");
    check(
      "8. Superadmin A membuat channel Umum",
      created.ok && created.value.section === "umum" && aOv.isSuperadmin && aOv.canCreateOrgChannel,
      created.ok ? `#${created.value.name}, bagian=${created.value.section}` : JSON.stringify(created.error),
    );
    const conv = created.ok ? created.value.id : null;
    const onBC = await settle("channel Umum baru ada di B dan C", async () => {
      const b = await findConv("B", (c) => c.id === conv);
      const c = await findConv("C", (c) => c.id === conv);
      return b && c ? `B=${b.section}, C=${c.section}` : null;
    });
    check(
      "8. Channel Umum baru tampil di B dan C pada bagian Umum",
      onBC === "B=umum, C=umum",
      onBC === "B=umum, C=umum" ? `${onBC}, ${secs(since)}` : onBC,
    );
    const bOv = await ov("B");
    const rogue = await call("B", "chat_create_channel", { name: V3.rogueName, scope: { kind: "org", id: null } });
    check(
      "8. B (bukan superadmin) ditolak saat membuat channel Umum",
      !rogue.ok && rogue.error?.code === "forbidden" && !bOv.isSuperadmin && !bOv.canCreateOrgChannel,
      rogue.ok ? `malah berhasil: #${rogue.value.name}` : `${rogue.error?.code}: ${rogue.error?.message}`,
    );
    const umumNote = await sel.list(page("B")).getByText("Channel umum dibuat oleh superadmin.").count();
    const umumBtnB = await sel.list(page("B")).getByRole("button", { name: "Channel umum baru" }).count();
    const umumBtnA = await sel.list(page("A")).getByRole("button", { name: "Channel umum baru" }).count();
    check(
      "8. Tombol Channel umum baru hanya di A; B melihat catatan superadmin",
      umumBtnA === 1 && umumBtnB === 0 && umumNote === 1,
      `tombol A=${umumBtnA}, tombol B=${umumBtnB}, catatan B=${umumNote}`,
    );
    negatives.push(async () => {
      const where = [];
      for (const id of ["A", "B", "C"]) {
        if ((await ov(id)).conversations.some((c) => c.name === V3.rogueName)) where.push(id);
      }
      check(
        "8. Channel yang ditolak tidak muncul di A, B, maupun C",
        where.length === 0,
        where.length ? `muncul di ${where.join(", ")}` : "tidak ada di mana pun",
      );
    });
  }

  // ---------- 9. Grup dari B dengan A ----------
  let groupConv = null;
  {
    const pb = page("B");
    await goChat("B");
    await sel.list(pb).getByRole("button", { name: "Grup baru", exact: true }).click();
    const dlg = sel.dialog(pb, "Grup baru");
    await dlg.waitFor({ timeout: 10000 });
    await dlg.getByLabel("Nama grup").fill(V3.group);
    await dlg.getByRole("checkbox", { name: new RegExp(NODES.A.name) }).check();
    await sleep(300);
    await shotV03("B", "v03c-03-dialog-grup-baru-b.png");
    await dlg.getByRole("button", { name: /^Buat grup$/ }).click();
    await dlg.waitFor({ state: "hidden", timeout: 15000 });
    const g = await waitFor("grup ada di overview B", () => findConv("B", (c) => c.kind === "group" && c.name === V3.group), 15000);
    groupConv = g.id;
    check(
      "9. B membuat grup dengan A lewat dialog Grup baru",
      g.section === "grup" && g.memberCount === 2 && /^gr:[0-9a-f]{32}$/.test(g.id),
      `${g.id.slice(0, 11)}..., bagian=${g.section}, anggota=${g.memberCount}`,
    );

    const since = Date.now();
    const onA = await settle("A melihat grup di bagian grup", async () => {
      const c = await findConv("A", (c) => c.id === groupConv);
      return c?.section === "grup" ? c : null;
    });
    check(
      "9. Grup tampil di A pada bagian Grup",
      typeof onA === "object" && onA !== null,
      typeof onA === "object" ? `${secs(since)}, kind=${onA.kind}, anggota=${onA.memberCount}` : onA,
    );

    await sel.groupRow(pb, V3.group).click({ timeout: 15000 });
    await sel.conv(pb, V3.group).waitFor({ timeout: 15000 });
    await send("B", V3.groupMsg);
    lastSendAt = Date.now();
    const sentAt = Date.now();
    await goChat("A");
    await sel.groupRow(page("A"), V3.group).click({ timeout: SYNC_MS });
    await sel.conv(page("A"), V3.group).waitFor({ timeout: 15000 });
    const got = await settle("A menerima pesan grup", async () => (await sel.message(page("A"), V3.groupMsg).count()) > 0);
    check("9. Pesan B di grup tampil di layar A", got === true, got === true ? secs(sentAt) : got);

    const membersBtn = page("A").getByRole("button", { name: /^Grup · \d+ anggota/ });
    await membersBtn.click();
    const pop = page("A").getByRole("dialog", { name: /^Anggota grup/ });
    const listed = await pop
      .waitFor({ timeout: 10000 })
      .then(async () => {
        await pop.getByText(NODES.B.name).first().waitFor({ timeout: 10000 });
        return pop.innerText();
      })
      .catch((e) => `gagal: ${String(e.message).slice(0, 120)}`);
    check(
      "9. Daftar anggota grup di A memuat Ayu dan Budi, Budi sebagai pemilik",
      listed.includes(NODES.A.name) && listed.includes(NODES.B.name) && /Pemilik grup/.test(listed),
      listed.replace(/\s+/g, " ").slice(0, 160),
    );
    await shotV03("A", "v03c-04-kepala-grup-anggota-a.png");
    await page("A").keyboard.press("Escape");

    negatives.push(async () => {
      const cOv = await ov("C");
      // C punya grup satu orangnya sendiri (13b), jadi yang dicari grup ini atau grup lain bernama sama.
      const has = cOv.conversations.some((c) => c.id === groupConv || (c.kind === "group" && c.name === V3.group));
      const m = await msgTexts("C", groupConv);
      const row = await sel.groupRow(page("C"), V3.group).count();
      const body = await page("C").locator("body").innerText();
      check(
        "9. Grup dan pesannya tidak pernah sampai ke C",
        !has && m.texts.length === 0 && row === 0 && !body.includes(V3.groupMsg),
        `percakapan=${has}, chat_messages=${describeMsgs(m)}, baris=${row}`,
      );
    });
  }

  // ---------- 10. Channel proyek hanya untuk anggota proyek ----------
  {
    // Proyek tanpa departemen: di v0.2 semua anggota bukan Tamu (termasuk C) melihatnya.
    const proj = await must("A", "board_create_project", { name: V3.projectName, code: V3.projectCode, teamId: null });
    await must("A", "org_add_project_member", { projectId: proj.id, publicKey: pk.B });
    const isProj = (c) => c.scope?.kind === "project" && c.scope?.id === proj.id;
    const aConv = await waitFor("channel proyek ada di A", () => findConv("A", isProj), 30000);
    const since = Date.now();
    const bConv = await settle("channel proyek ada di B", () => findConv("B", isProj));
    check(
      "10. Chat proyek tampil di A dan B (anggota proyek) pada bagian Proyek",
      aConv.section === "proyek" && typeof bConv === "object" && bConv?.section === "proyek",
      typeof bConv === "object" ? `${aConv.name} (${aConv.kind}), B setelah ${secs(since)}` : bConv,
    );
    await goChat("A");
    await openProjectChat("A", aConv.name);
    await send("A", V3.projectMsg);
    lastSendAt = Date.now();
    const sentAt = Date.now();
    await goChat("B");
    await openProjectChat("B", aConv.name);
    const got = await settle("B menerima pesan proyek", async () => (await sel.message(page("B"), V3.projectMsg).count()) > 0);
    check(`10. Pesan A di chat ${aConv.name} tampil di layar B`, got === true, got === true ? secs(sentAt) : got);
    await shotV03("B", "v03c-05-channel-proyek-b.png");

    negatives.push(async () => {
      const cConv = await findConv("C", isProj);
      const m = await msgTexts("C", aConv.id);
      const cProjects = await must("C", "board_list_projects");
      const row = await sel.projectRow(page("C"), aConv.name).count();
      check(
        `10. C (bukan anggota proyek) tidak menerima chat ${aConv.name}, pesannya, maupun proyeknya`,
        !cConv && m.texts.length === 0 && row === 0 && !cProjects.some((p) => p.id === proj.id),
        `percakapan=${Boolean(cConv)}, chat_messages=${describeMsgs(m)}, baris=${row}, proyek=${cProjects.map((p) => p.code).join(",") || "kosong"}`,
      );
    });
  }

  // ---------- 11. Channel departemen lewat command org ----------
  {
    const x = await must("A", "org_create_department", { name: V3.deptX });
    const y = await must("A", "org_create_department", { name: V3.deptY });
    await must("A", "org_move_member", { publicKey: pk.A, teamId: x.id });
    await must("A", "org_move_member", { publicKey: pk.B, teamId: x.id });
    await must("A", "org_move_member", { publicKey: pk.C, teamId: y.id });
    const since = Date.now();
    const moved = await settle("B dan C melihat departemen barunya", async () => {
      const dep = (list, k) => list.find((p) => p.publicKey === k)?.departmentId;
      const onB = await must("B", "org_people");
      const onC = await must("C", "org_people");
      return dep(onB, pk.A) === x.id && dep(onB, pk.B) === x.id && dep(onC, pk.C) === y.id;
    });
    check(
      `11. Departemen ${V3.deptX} (A, B) dan ${V3.deptY} (C) dibuat dan diisi lewat command org`,
      moved === true && Boolean(x.channelId && y.channelId),
      moved === true ? `#${x.channelName}, #${y.channelName}, ${secs(since)}` : moved,
    );
    // Id channel di log organisasi tanpa awalan; percakapan chat memakai "ch:<id>".
    const deptConv = (dep) => (c) => c.scope?.kind === "team" && c.scope?.id === dep.id;
    const xConv = `ch:${x.channelId}`;
    const bConv = await settle("channel departemen X ada di B", () => findConv("B", deptConv(x)));
    check(
      `11. #${x.channelName} tampil di B pada bagian Departemen`,
      typeof bConv === "object" && bConv?.section === "departemen" && bConv?.id === xConv,
      typeof bConv === "object" ? `bagian=${bConv?.section}, id cocok=${bConv?.id === xConv}` : bConv,
    );
    await goChat("A");
    await openChannel("A", x.channelName);
    await send("A", V3.deptMsg);
    lastSendAt = Date.now();
    const sentAt = Date.now();
    await goChat("B");
    await openChannel("B", x.channelName);
    const got = await settle("B menerima pesan departemen", async () => (await sel.message(page("B"), V3.deptMsg).count()) > 0);
    check(`11. Pesan A di #${x.channelName} tampil di layar B`, got === true, got === true ? secs(sentAt) : got);

    negatives.push(async () => {
      const cOv = await ov("C");
      const cHas = cOv.conversations.find(deptConv(x));
      const cOwn = cOv.conversations.find(deptConv(y));
      const m = await msgTexts("C", xConv);
      const row = await sel.channelRow(page("C"), x.channelName).count();
      check(
        `11. C (Departemen ${V3.deptY}) tidak menerima #${x.channelName} maupun pesannya`,
        !cHas && !m.texts.includes(V3.deptMsg) && row === 0,
        `percakapan=${Boolean(cHas)}, chat_messages=${describeMsgs(m)}, baris=${row}; #${y.channelName} di C: ${cOwn ? cOwn.section : "tidak ada"}`,
      );
    });
  }

  // ---------- 12. B keluar dari grup ----------
  {
    await must("B", "chat_group_leave", { conv: groupConv });
    const since = Date.now();
    const left = await settle("A melihat B keluar dari grup", async () => {
      const g = await must("A", "chat_group", { conv: groupConv });
      return g.members.some((m) => m.person.publicKey === pk.B) ? null : g;
    });
    check(
      "12. B keluar dari grup dan A melihat anggotanya tinggal A",
      typeof left === "object" && left.members.length === 1 && left.members[0].person.publicKey === pk.A,
      typeof left === "object" ? `${secs(since)}, pemilik sekarang ${left.owner?.name}` : left,
    );
    await goChat("A");
    await sel.groupRow(page("A"), V3.group).click({ timeout: 15000 });
    await sel.conv(page("A"), V3.group).waitFor({ timeout: 15000 });
    await send("A", V3.afterLeave);
    lastSendAt = Date.now();

    negatives.push(async () => {
      const g = await findConv("B", (c) => c.id === groupConv);
      const m = await msgTexts("B", groupConv);
      check(
        "12. Pesan A setelah B keluar tidak sampai ke B",
        !m.texts.includes(V3.afterLeave),
        `chat_messages B=${describeMsgs(m)}`,
      );
      check(
        "12. Grup tetap di daftar B sebagai former: true, pesan lama tetap terbaca",
        g?.former === true && g?.section === "grup" && m.texts.includes(V3.groupMsg),
        g ? `former=${g.former}, bagian=${g.section}, canPost=${g.canPost}, pesan lama=${m.texts.includes(V3.groupMsg)}` : "grup hilang dari B",
      );
      await goChat("B");
      await sel.groupRow(page("B"), V3.group).click({ timeout: 15000 });
      await sel.conv(page("B"), V3.group).waitFor({ timeout: 15000 });
      await sleep(500);
      await shotV03("B", "v03c-06-grup-bukan-anggota-b.png");
    });
  }

  // ---------- 13a. v0.4: chat proyek sebagai grup ----------
  {
    const V4 = { name: "Gudang Baru", code: "GB", msg: "Daftar barang gudang baru, khusus anggota proyek." };
    const proj = await must("A", "board_create_project", { name: V4.name, code: V4.code, teamId: null });
    await must("A", "org_add_project_member", { projectId: proj.id, publicKey: pk.B });
    const isP = (c) => c.scope?.kind === "project" && c.scope?.id === proj.id;
    const aP = await waitFor("chat proyek ada di A", () => findConv("A", isP), 30000);
    const since = Date.now();
    const bP = await settle("chat proyek ada di B dengan 2 anggota", async () => {
      const c = await findConv("B", isP);
      return c?.memberCount === 2 ? c : null;
    });
    const asGroup = (c) => c?.kind === "project" && c?.section === "proyek" && c?.name === V4.name && c?.memberCount === 2;
    check(
      "13a. Proyek baru langsung punya chat berjenis proyek (seperti grup) di A dan B: bagian Proyek, nama proyek, 2 anggota",
      asGroup(aP) && typeof bP === "object" && asGroup(bP) && !aP.canArchive && !aP.canDelete,
      typeof bP === "object" ? `A: ${aP.kind}/${aP.section}/${aP.name}/${aP.memberCount}; B setelah ${secs(since)}` : bP,
    );
    const umumLeak = [];
    for (const id of ["A", "B", "C"]) {
      for (const c of (await ov(id)).conversations) {
        if ((c.kind === "project" || c.scope?.kind === "project") && c.section !== "proyek") umumLeak.push(`${id}:${c.name}=${c.section}`);
      }
    }
    check("13a. Tidak ada chat proyek di luar bagian Proyek di A, B, maupun C", umumLeak.length === 0, umumLeak.join(", ") || "semua di Proyek");

    await goChat("A");
    await openProjectChat("A", V4.name);
    await send("A", V4.msg);
    lastSendAt = Date.now();
    const membersBtn = page("A").getByRole("button", { name: /^Proyek · \d+ anggota/ });
    await membersBtn.click();
    const pop = page("A").getByRole("dialog", { name: /^Anggota/ });
    const listed = await pop
      .waitFor({ timeout: 10000 })
      .then(async () => {
        await pop.getByText(NODES.B.name).first().waitFor({ timeout: 10000 });
        return pop.innerText();
      })
      .catch((e) => `gagal: ${String(e.message).slice(0, 120)}`);
    const btnText = await membersBtn.innerText().catch(() => "");
    check(
      "13a. Kepala chat proyek di A: Proyek · 2 anggota, daftar memuat Ayu dan Budi dan menyebut Board",
      btnText.includes("2 anggota") && listed.includes(NODES.A.name) && listed.includes(NODES.B.name) && /Board/.test(listed),
      `${btnText}; ${listed.replace(/\s+/g, " ").slice(0, 200)}`,
    );
    await shotV04("A", "v04-02-kepala-chat-proyek-a.png");
    await page("A").keyboard.press("Escape");
    const arch = await call("A", "chat_set_archived", { conv: aP.id, archived: true });
    const del = await call("A", "chat_delete_channel", { conv: aP.id });
    check(
      "13a. Chat proyek tidak bisa diarsipkan atau dihapus, bahkan oleh pengelola proyek",
      !arch.ok && !del.ok,
      `arsip: ${arch.ok ? "berhasil" : arch.error?.code}, hapus: ${del.ok ? "berhasil" : del.error?.code}`,
    );

    // C masuk proyek: chat proyek muncul di C dengan riwayatnya, jumlah anggota di A ikut naik.
    await must("A", "org_add_project_member", { projectId: proj.id, publicKey: pk.C });
    const addAt = Date.now();
    const cP = await settle("C melihat chat proyek dengan 3 anggota", async () => {
      const c = await findConv("C", isP);
      return c?.memberCount === 3 ? c : null;
    });
    const cMsgs = await settle("C menerima riwayat chat proyek", async () => (await msgTexts("C", aP.id)).texts.includes(V4.msg));
    check(
      "13a. C ditambahkan ke proyek: chat proyek muncul di C (jenis proyek, 3 anggota) dengan pesan lama",
      typeof cP === "object" && cP?.kind === "project" && cP?.section === "proyek" && cMsgs === true,
      typeof cP === "object" ? `${secs(addAt)}, riwayat=${cMsgs}` : cP,
    );
    const aThree = await settle("kepala A menjadi 3 anggota", async () =>
      (await page("A").getByRole("button", { name: /^Proyek · 3 anggota/ }).count()) > 0,
    );
    check("13a. Kepala chat proyek di A ikut menjadi Proyek · 3 anggota", aThree === true, aThree === true ? "" : aThree);
    await goChat("C");
    await openProjectChat("C", V4.name);
    await shotV04("C", "v04-04-chat-proyek-c-setelah-ditambah.png");

    // B dikeluarkan dari proyek: B tidak lagi anggota chat proyek, pesannya tetap terbaca.
    await must("A", "org_remove_project_member", { projectId: proj.id, publicKey: pk.B });
    const rmAt = Date.now();
    const bGone = await settle("B menjadi bukan anggota chat proyek", async () => {
      const a = await findConv("A", isP);
      const b = await findConv("B", isP);
      return a?.memberCount === 2 && b?.former === true ? b : null;
    });
    const bOld = await msgTexts("B", aP.id);
    check(
      "13a. B dikeluarkan dari proyek: A melihat 2 anggota, B melihat chat proyek sebagai bukan anggota lagi dengan pesan lama",
      typeof bGone === "object" && bGone?.canPost === false && bOld.texts.includes(V4.msg),
      typeof bGone === "object" ? `${secs(rmAt)}, pesan lama=${bOld.texts.includes(V4.msg)}` : bGone,
    );
  }

  // ---------- 13b. v0.4: grup yang hanya berisi pembuatnya ----------
  {
    const pc = page("C");
    await goChat("C");
    await sel.list(pc).getByRole("button", { name: "Grup baru", exact: true }).click();
    const dlg = sel.dialog(pc, "Grup baru");
    await dlg.waitFor({ timeout: 10000 });
    await dlg.getByLabel("Nama grup").fill("Catatan Citra");
    await dlg.getByRole("button", { name: /^Buat grup$/ }).click();
    await dlg.waitFor({ state: "hidden", timeout: 15000 });
    const solo = await waitFor("grup satu orang ada di C", () => findConv("C", (c) => c.kind === "group" && c.name === "Catatan Citra"), 15000);
    await sel.conv(pc, "Catatan Citra").waitFor({ timeout: 15000 });
    await send("C", "Catatan untuk diri sendiri.");
    lastSendAt = Date.now();
    check(
      "13b. C membuat grup tanpa memilih orang lewat dialog Grup baru: 1 anggota, bisa menulis",
      solo.memberCount === 1 && solo.section === "grup" && solo.canPost,
      `anggota=${solo.memberCount}, bagian=${solo.section}`,
    );
    negatives.push(async () => {
      const where = [];
      for (const id of ["A", "B"]) {
        if ((await ov(id)).conversations.some((c) => c.id === solo.id)) where.push(id);
        if ((await msgTexts(id, solo.id)).texts.length) where.push(`${id} (pesan)`);
      }
      check("13b. Grup satu orang milik C tidak sampai ke A maupun B", where.length === 0, where.join(", ") || "hanya di C");
    });
  }

  // ---------- 13c. v0.4: lipat sidebar ----------
  {
    const pb = page("B");
    await goChat("B");
    const rowsBefore = await sel.projectRow(pb, V3.projectName).count();
    await sel.section(pb, "Proyek").locator("button.chat-fold").click();
    const folded = await foldState("B", "Proyek");
    const rowsAfter = await sel.projectRowAny(pb, V3.projectName).count();
    const rowVisible = await sel.projectRowAny(pb, V3.projectName).isVisible();
    const grup = await foldState("B", "Grup");
    check(
      "13c. B melipat bagian Proyek: panah tertutup, isi tersembunyi menurut CSS, bagian lain tetap terbuka",
      rowsBefore === 1 &&
        rowsAfter === 1 &&
        folded.expanded === "false" &&
        folded.display === "none" &&
        !rowVisible &&
        grup.expanded === "true" &&
        grup.display !== "none",
      `baris sebelum=${rowsBefore}; Proyek: ${folded.expanded}/${folded.display}, baris terlihat=${rowVisible}; Grup: ${grup.expanded}/${grup.display}`,
    );
    await shotV04("B", "v04-03-sidebar-proyek-terlipat-b.png");
    await pb.reload();
    await pb.waitForFunction(() => "__TAURI_INTERNALS__" in window, null, { timeout: 20000 });
    await goChat("B");
    const again = await foldState("B", "Proyek");
    check(
      "13c. Lipatan bagian Proyek di B bertahan setelah halaman dimuat ulang",
      again.expanded === "false" && again.display === "none",
      `${again.expanded}/${again.display}`,
    );
    await sel.section(pb, "Proyek").locator("button.chat-fold").click();
    const open = await foldState("B", "Proyek");
    check("13c. Bagian Proyek di B dibuka lagi", open.expanded === "true" && open.display !== "none", `${open.expanded}/${open.display}`);
  }

  // ---------- Yang tidak boleh sampai, setelah dua putaran sinkron cadangan ----------
  {
    const wait = Math.max(0, 130000 - (Date.now() - lastSendAt));
    note(`menunggu ${Math.round(wait / 1000)} dtk (dua putaran sinkron cadangan 60 dtk) sebelum memeriksa yang tidak boleh sampai`);
    await sleep(wait);
    for (const id of ["A", "B", "C"]) await goChat(id);
    for (const fn of negatives) await fn();

    for (const id of ["A", "B", "C"]) await goChat(id);
    const names = {};
    for (const id of ["A", "B", "C"]) names[id] = await sectionNames(id);
    check(
      "Sidebar A, B, dan C menampilkan lima bagian berurutan",
      ["A", "B", "C"].every((id) => JSON.stringify(names[id]) === JSON.stringify(SECTIONS)),
      `A: ${names.A.join(" / ")}`,
    );
    await shotV03("A", "v03c-01-sidebar-superadmin-a.png");
    await shotV03("B", "v03c-02-sidebar-anggota-b.png");
    await shotV03("C", "v03c-07-sidebar-c-tanpa-grup.png");
  }
} catch (err) {
  check("Skrip berjalan tanpa error", false, String(err?.message ?? err).slice(0, 400));
  for (const id of Object.keys(running)) await shot(id, `fm-gagal-${id.toLowerCase()}.png`);
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
// Hanya kunci laptop uji skrip ini: yang dicatat (ownKeys) dan yang ada di mira.db folder data
// uji (kalau kunci publik belum terbaca karena gagal sangat awal). Kunci baru lain dibiarkan.
await deleteOwnKeys({ before: credentialsBefore, dirs: Object.values(NODES).map((n) => n.dir), keys: [...ownKeys] });
rmSync(root, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} pemeriksaan lulus.`);
process.exit(failed ? 1 : 0);
