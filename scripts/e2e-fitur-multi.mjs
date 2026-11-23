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
// Pakai:  node scripts/e2e-fitur-multi.mjs <path mira.exe> <folder screenshot>
// Build dulu: npx tauri build --no-bundle

import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const exe = resolve(process.argv[2] ?? "src-tauri/target/release/mira.exe");
const shots = resolve(process.argv[3] ?? "docs/progress/screenshots/fitur-multi");
mkdirSync(shots, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "mira-fitur-multi-"));

const NODES = {
  A: { name: "Ayu Uji", port: 47861, cdp: 9361, dir: join(root, "laptop-a") },
  B: { name: "Budi Uji", port: 47862, cdp: 9362, dir: join(root, "laptop-b") },
  C: { name: "Citra Uji", port: 47863, cdp: 9363, dir: join(root, "laptop-c") },
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
const onlineNames = async (id) =>
  (await must(id, "get_network_status")).peers.filter((p) => p.online).map((p) => p.displayName).sort();

// ---- Selektor layar (sama dengan chat-e2e.mjs dan board-e2e.mjs) ----
// Nama tombol menu bisa membawa angka ("Chat, 3 belum dibaca"), jadi dicocokkan sebagai awalan.
const menuName = (name) => new RegExp("^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(,|$)");
const mainNav = (p, name) =>
  p.getByRole("navigation", { name: "Menu utama" }).getByRole("button", { name: menuName(name) });
const sel = {
  list: (p) => p.getByRole("navigation", { name: /Daftar percakapan/i }),
  channelRow: (p, name) => sel.list(p).getByRole("button", { name: new RegExp(`^Channel ${name}\\b`) }),
  dmRow: (p, name) => sel.list(p).getByRole("button", { name: new RegExp(`^Chat pribadi dengan ${name}\\b`) }),
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
    await pa.getByRole("button", { name: "Chat pribadi baru" }).click();
    const dlg = sel.dialog(pa, /Chat pribadi baru/);
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
    // v0.3: proyek hanya terlihat anggotanya, jadi B dicentang di pemilih orang.
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
    const tdlg = pa.getByRole("dialog");
    const who = tdlg.getByLabel("Penanggung jawab");
    await who.waitFor({ timeout: 10000 });
    const budiValue = await who.locator("option", { hasText: NODES.B.name }).getAttribute("value");
    await who.selectOption(budiValue);
    await sleep(500);
    await tdlg.getByRole("button", { name: "Tutup detail task" }).click();
    const project = (await must("A", "board_list_projects")).find((p) => p.code === PROJECT_CODE);
    const board = await must("A", "board_get_board", { projectId: project.id });
    const taskA = board.columns.flatMap((c) => c.tasks).find((t) => t.title === TASK);
    const pm = await must("A", "org_project_members", { projectId: project.id });
    const pmKeys = pm.members.map((m) => m.publicKey);
    check(
      "6. A membuat proyek Tim Desain dengan anggota B, dan task untuk B",
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
      "6. C (departemen lain, bukan anggota proyek) tidak melihat proyek Tim Desain",
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
for (const target of miraCredentials()) {
  if (!credentialsBefore.has(target)) {
    try {
      execFileSync("cmdkey", [`/delete:${target}`], { stdio: "ignore" });
    } catch {
      console.log(`Kunci uji tidak bisa dihapus: ${target}`);
    }
  }
}
rmSync(root, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} pemeriksaan lulus.`);
process.exit(failed ? 1 : 0);
