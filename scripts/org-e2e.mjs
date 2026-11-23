// Uji ujung ke ujung halaman Organisasi v0.3 (bagian B) di Windows.
//
// Dua instance mira.exe hasil build release, masing-masing dengan folder data
// (MIRA_DATA_DIR), port QUIC (MIRA_PORT), dan port debug WebView2 sendiri,
// dikendalikan lewat Chrome DevTools Protocol. Langkah superadmin dijalankan
// lewat klik di layar; hasilnya dicek di data lewat command org_*.
//
//   A  Ayu    membuat organisasi, superadmin
//   B  Budi   bergabung dengan kode Anggota ke departemen Drafting Gambar
//
// Pakai:  node scripts/org-e2e.mjs <path mira.exe> <folder screenshot>
// Butuh:  playwright-core (alat uji saja, tidak dibundel ke aplikasi).

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const exe = resolve(process.argv[2] ?? "src-tauri/target/release/mira.exe");
const shots = resolve(process.argv[3] ?? "docs/progress/screenshots/v03-b");
mkdirSync(shots, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "mira-org-"));
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appVersion = readFileSync(join(repo, "src-tauri", "Cargo.toml"), "utf8").match(/^version\s*=\s*"([^"]+)"/m)?.[1];

const NODES = {
  A: { name: "Ayu Uji", port: 47871, cdp: 9371, dir: join(root, "laptop-a") },
  B: { name: "Budi Uji", port: 47872, cdp: 9372, dir: join(root, "laptop-b") },
};
const addr = (id) => `127.0.0.1:${NODES[id].port}`;

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

const running = {};

async function launch(id) {
  const node = NODES[id];
  mkdirSync(node.dir, { recursive: true });
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      MIRA_DATA_DIR: node.dir,
      MIRA_PORT: String(node.port),
      MIRA_DISABLE_MDNS: "1",
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${node.cdp}`,
    },
    stdio: "ignore",
  });
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
    throw new Error(`WebView2 ${id} tidak bisa dihubungi lewat CDP`);
  }
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages())[0];
    if (!page) await sleep(250);
  }
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => "__TAURI_INTERNALS__" in window, null, { timeout: 20000 });
  running[id] = { child, browser, page };
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
async function waitFor(desc, fn, timeoutMs = 45000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = String(e?.message ?? e);
    }
    await sleep(1000);
  }
  throw new Error(`Menunggu terlalu lama: ${desc} (terakhir: ${JSON.stringify(last)?.slice(0, 200)})`);
}
// Seperti waitFor, tetapi hasil gagal menjadi pesan (untuk dicetak sebagai GAGAL).
const settle = (desc, fn, timeoutMs) => waitFor(desc, fn, timeoutMs).catch((e) => ({ failed: String(e.message) }));

async function reload(id) {
  await running[id].page.reload();
  await running[id].page.waitForFunction(() => "__TAURI_INTERNALS__" in window, null, { timeout: 20000 });
}

const pg = (id) => running[id].page;

async function openOrg(id) {
  const p = pg(id);
  await p.getByRole("button", { name: /^Organisasi/ }).first().click();
  await p.getByRole("heading", { name: "Organisasi", level: 1 }).waitFor({ timeout: 15000 });
}
async function openTab(id, label) {
  const p = pg(id);
  await p.locator("nav.org-tabs-wrap").getByRole("button", { name: label, exact: true }).click();
  await sleep(600);
}
const dialog = (id) => pg(id).getByRole("dialog");
async function closeDialog(id) {
  await pg(id).keyboard.press("Escape");
  await dialog(id).waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
}
const userRow = (id, name) => pg(id).locator("table.ut tbody tr").filter({ hasText: name });

async function setTheme(id, mode) {
  await must(id, "set_setting", { key: "theme.mode", value: mode });
  await reload(id);
  await pg(id).waitForFunction((m) => document.documentElement.getAttribute("data-theme") === m, mode, { timeout: 10000 });
  await sleep(800);
}
async function shot(id, file) {
  await sleep(500);
  await pg(id).screenshot({ path: join(shots, file) });
}

const deptByName = (list, name) => list.find((d) => d.name === name);
const person = (list, pk) => list.find((p) => p.publicKey === pk);

try {
  for (const id of Object.keys(NODES)) await launch(id);
  for (const id of Object.keys(NODES)) await must(id, "save_display_name", { name: NODES[id].name });
  const pk = {};
  for (const id of Object.keys(NODES)) pk[id] = (await must(id, "get_app_state")).identity.publicKey;
  await must("A", "create_organization", { name: "Kantor Uji" });
  await reload("A");

  // 1. Departemen lewat klik.
  const pa = pg("A");
  await openOrg("A");
  await openTab("A", "Departemen");
  for (const name of ["Desain", "Drafting"]) {
    await pa.getByRole("button", { name: "Departemen baru", exact: true }).click();
    const dlg = dialog("A");
    await dlg.getByLabel("Nama departemen").fill(name);
    await dlg.getByRole("button", { name: "Buat departemen" }).click();
    await dlg.waitFor({ state: "detached", timeout: 10000 });
    await pa.locator("table.dept-table").getByText(name, { exact: true }).waitFor({ timeout: 10000 });
  }
  let depts = await must("A", "org_departments", { includeArchived: false });
  check(
    "Departemen Desain dan Drafting dibuat lewat dialog Departemen baru",
    Boolean(deptByName(depts, "Desain") && deptByName(depts, "Drafting")),
    JSON.stringify(depts.map((d) => d.name)),
  );
  const draftingId = deptByName(depts, "Drafting")?.id;
  const desainId = deptByName(depts, "Desain")?.id;

  await pa.getByRole("button", { name: "Ganti nama Drafting", exact: true }).click();
  const renameInput = pa.getByLabel("Nama baru untuk departemen Drafting");
  await renameInput.fill("Drafting Gambar");
  await pa.getByRole("button", { name: "Simpan nama" }).click();
  await pa.locator("table.dept-table").getByText("Drafting Gambar", { exact: true }).waitFor({ timeout: 10000 });
  depts = await must("A", "org_departments", { includeArchived: false });
  const renamed = depts.find((d) => d.id === draftingId);
  check("Drafting diganti nama menjadi Drafting Gambar lewat Ganti nama", renamed?.name === "Drafting Gambar", renamed?.name);
  check("Nama channel ikut berganti menjadi drafting-gambar", renamed?.channelName === "drafting-gambar", renamed?.channelName);
  const dirA = await must("A", "get_directory");
  const ch = dirA.channels.find((c) => c.id === renamed?.channelId);
  check("Channel di direktori A juga bernama drafting-gambar", ch?.name === "drafting-gambar", ch?.name);
  const deptText = await settle("tabel menampilkan channel baru", async () => {
    // innerText sel tabel bisa memakai spasi tak putus atau baris baru; rapikan dulu.
    const t = (await pa.locator("table.dept-table").innerText()).replace(/\s+/g, " ");
    return t.includes("# drafting-gambar") ? t : null;
  }, 10000);
  check(
    "Tabel Departemen menampilkan # drafting-gambar",
    typeof deptText === "string",
    typeof deptText === "string" ? "" : (await pa.locator("table.dept-table").innerText()).replace(/\s+/g, " "),
  );

  // Masukkan diri sendiri ke Desain.
  await openTab("A", "Pengguna");
  await pa.getByRole("button", { name: "Aksi untuk Ayu Uji", exact: true }).click();
  await pa.getByRole("button", { name: "Ubah departemen", exact: true }).click();
  let dlg = dialog("A");
  await dlg.getByLabel("Pindah ke").selectOption({ label: "Desain" });
  await dlg.getByRole("button", { name: "Pindahkan", exact: true }).click();
  await dlg.waitFor({ state: "detached", timeout: 10000 });
  const meMoved = await settle("A di Desain", async () => person(await must("A", "org_people"), pk.A)?.departmentId === desainId);
  check("Superadmin memasukkan dirinya ke Desain lewat Ubah departemen", meMoved === true, meMoved?.failed ?? "");

  // 2. B bergabung ke Drafting Gambar.
  const invite = await must("A", "create_invite", { teamId: draftingId, role: "member", validity: "24h", projectIds: [] });
  const joinB = await call("B", "join_with_code", { code: invite.code, address: addr("A") });
  check("B bergabung dengan kode Anggota ke Drafting Gambar", joinB.ok && joinB.value.role === "member", JSON.stringify(joinB.ok ? joinB.value.role : joinB.error));
  await stop("B");
  await launch("B");
  const bSynced = await settle("B melihat dirinya di Drafting Gambar", async () => {
    const me = person(await must("B", "org_people"), pk.B);
    return me?.departmentId === draftingId;
  });
  check("B (setelah dibuka lagi) tersinkron, departemennya Drafting Gambar", bSynced === true, bSynced?.failed ?? "");

  // 3. Laptop, IP, sistem, versi, status Budi di daftar Pengguna A.
  const laptop = process.env.COMPUTERNAME ?? "";
  const budiUser = await settle(
    "A melihat laporan laptop Budi dan status online",
    async () => {
      const u = person(await must("A", "org_users"), pk.B);
      return u?.device && u.online && u.lastIp ? u : null;
    },
    60000,
  );
  const bu = budiUser.failed ? null : budiUser;
  check("org_users: nama laptop Budi = COMPUTERNAME", bu?.device?.laptop === laptop, `${bu?.device?.laptop} / ${laptop}`);
  check("org_users: sistem Budi Windows ...", /^Windows /.test(bu?.device?.os ?? ""), bu?.device?.os);
  check("org_users: versi Mira Budi sesuai Cargo.toml", bu?.device?.appVersion === appVersion, `${bu?.device?.appVersion} / ${appVersion}`);
  check("org_users: IP terakhir Budi terlihat", /^127\.0\.0\.1$|^\d+\.\d+\.\d+\.\d+$|:/.test(bu?.lastIp ?? ""), bu?.lastIp ?? budiUser.failed);
  check("org_users: Budi online", bu?.online === true);
  await reload("A");
  await openOrg("A");
  await openTab("A", "Pengguna");
  const rowB = userRow("A", "Budi Uji");
  await rowB.waitFor({ timeout: 15000 });
  const rowText = await settle("baris Budi lengkap", async () => {
    const t = await rowB.innerText();
    return t.includes("Online") && t.includes(laptop) ? t : null;
  }, 20000);
  const rt = typeof rowText === "string" ? rowText : "";
  check("Baris Budi di layar: nama laptop", laptop !== "" && rt.includes(laptop), rt.replace(/\s+/g, " "));
  check("Baris Budi di layar: IP terakhir", Boolean(bu?.lastIp) && rt.includes(bu.lastIp));
  check("Baris Budi di layar: sistem Windows", /Windows \S+/.test(rt));
  check(`Baris Budi di layar: Mira ${appVersion}`, rt.includes(`Mira ${appVersion}`));
  check("Baris Budi di layar: status Online", rt.includes("Online"));
  check("Baris Budi di layar: departemen Drafting Gambar", rt.includes("Drafting Gambar"));

  // 4. Pindahkan Budi ke Desain lewat menu aksi.
  await pa.getByRole("button", { name: "Aksi untuk Budi Uji", exact: true }).click();
  await pa.getByRole("button", { name: "Ubah departemen", exact: true }).click();
  dlg = dialog("A");
  await dlg.getByLabel("Pindah ke").selectOption({ label: "Desain" });
  await dlg.getByRole("button", { name: "Pindahkan", exact: true }).click();
  await dlg.waitFor({ state: "detached", timeout: 10000 });
  const movedA = person(await must("A", "org_people"), pk.B);
  check("org_people A: Budi di Desain", movedA?.departmentName === "Desain", movedA?.departmentName);
  const movedB = await settle("B melihat Budi di Desain", async () => person(await must("B", "org_people"), pk.B)?.departmentName === "Desain");
  check("org_people B (setelah sinkron): Budi di Desain", movedB === true, movedB?.failed ?? "");
  await rowB.filter({ hasText: "Desain" }).waitFor({ timeout: 10000 }).catch(() => {});
  check("Baris Budi di layar A sekarang menyebut Desain", (await rowB.innerText()).includes("Desain"));

  // 5. Label Drafter dipasang ke Budi.
  await openTab("A", "Label");
  await pa.getByRole("button", { name: "Label baru", exact: true }).click();
  dlg = dialog("A");
  await dlg.getByLabel("Nama label").fill("Drafter");
  await dlg.getByRole("button", { name: "Buat label", exact: true }).click();
  await dlg.getByRole("heading", { name: "Atur orang untuk label Drafter" }).waitFor({ timeout: 10000 });
  check("Dialog Label baru berganti ke pemilih orang", true);
  await dlg.getByRole("checkbox", { name: /Budi Uji/ }).check();
  await dlg.getByRole("button", { name: "Simpan", exact: true }).click();
  await dlg.waitFor({ state: "detached", timeout: 15000 });
  const labelsA = await must("A", "org_labels");
  const drafter = labelsA.find((l) => l.name === "Drafter");
  check("org_labels A: Drafter terpasang ke Budi", Boolean(drafter?.memberKeys.includes(pk.B)), JSON.stringify(drafter?.memberKeys?.length));
  const labelB = await settle("B melihat label Drafter di Budi", async () =>
    person(await must("B", "org_people"), pk.B)?.labels.some((l) => l.name === "Drafter"),
  );
  check("org_people B (setelah sinkron): Budi berlabel Drafter", labelB === true, labelB?.failed ?? "");
  const lblText = await pa.locator("ul[aria-label='Label aktif']").innerText();
  check("Tab Label: Drafter dipakai 1 orang", lblText.includes("Drafter") && lblText.includes("1 orang"), lblText.replace(/\s+/g, " "));
  await openTab("A", "Pengguna");
  await rowB.waitFor({ timeout: 10000 });
  const nameCell = await rowB.locator(".ut-name").innerText();
  check("Tab Pengguna A: label Drafter tampil di samping nama Budi", nameCell.includes("Drafter"), nameCell.replace(/\s+/g, " "));

  // 6. Permintaan bergabung: hanya keadaan kosong (lihat catatan di akhir).
  await openTab("A", "Permintaan bergabung");
  const empty = await pa
    .getByText("Tidak ada permintaan yang menunggu.")
    .waitFor({ timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check("Tab Permintaan bergabung menampilkan keadaan kosong", empty);
  const navCounts = await pa.locator(".nav-count").count();
  const navName = await pa.locator("nav").getByRole("button", { name: /^Organisasi/ }).first().innerText();
  check("Tidak ada angka di menu Organisasi dan tab Permintaan bergabung", navCounts === 0 && navName.trim() === "Organisasi", `nav-count=${navCounts}, "${navName.trim()}"`);
  const ov = await must("A", "org_overview");
  check("org_overview A: pendingJoinCount 0", ov.pendingJoinCount === 0, String(ov.pendingJoinCount));

  // B bukan superadmin: tab Anggota saja, tanpa halaman admin (v0.4).
  await reload("B");
  await openOrg("B");
  // Tab baru muncul setelah org_overview terbaca; daftar Anggota setelah org_people.
  await pg("B").locator("nav.org-tabs-wrap").getByRole("button", { name: "Anggota", exact: true }).waitFor({ timeout: 15000 });
  await pg("B").getByText("Drafter", { exact: true }).first().waitFor({ timeout: 15000 }).catch(() => {});
  const bTabs = await pg("B").locator("nav.org-tabs-wrap button").allInnerTexts();
  check(
    "B (Anggota) melihat tab Anggota, tidak melihat Pengguna, Departemen, Label, dan Permintaan bergabung",
    bTabs.includes("Anggota") && !bTabs.some((t) => /^(Pengguna|Departemen|Label|Permintaan bergabung)/.test(t)),
    JSON.stringify(bTabs),
  );
  const bPeople = await pg("B").locator("main").innerText();
  check("Tab Anggota B menampilkan Ayu Uji dan Budi Uji dengan label Drafter", bPeople.includes("Ayu Uji") && bPeople.includes("Budi Uji") && bPeople.includes("Drafter"));

  // 7. Screenshot terang dan gelap.
  for (const [mode, suffix] of [
    ["light", "terang"],
    ["dark", "gelap"],
  ]) {
    await setTheme("A", mode);
    await openOrg("A");
    await openTab("A", "Pengguna");
    await userRow("A", "Budi Uji").waitFor({ timeout: 15000 });
    await settle("Budi online di layar", async () => (await userRow("A", "Budi Uji").innerText()).includes("Online"), 15000);
    await shot("A", `pengguna-${suffix}.png`);

    await pa.getByRole("button", { name: "Aksi untuk Budi Uji", exact: true }).click();
    await shot("A", `menu-aksi-${suffix}.png`);
    await pa.getByRole("button", { name: "Ubah departemen", exact: true }).click();
    await dialog("A").getByLabel("Pindah ke").selectOption({ label: "Drafting Gambar" });
    await shot("A", `ubah-departemen-${suffix}.png`);
    await closeDialog("A");

    await openTab("A", "Departemen");
    await pa.locator("table.dept-table").waitFor({ timeout: 10000 });
    await shot("A", `departemen-${suffix}.png`);

    await openTab("A", "Label");
    await pa.getByRole("button", { name: /^Atur orang\s*, label Drafter$/ }).waitFor({ timeout: 10000 });
    await shot("A", `label-${suffix}.png`);
    await pa.getByRole("button", { name: /^Atur orang\s*, label Drafter$/ }).click();
    await dialog("A").getByRole("checkbox").first().waitFor({ timeout: 10000 });
    await shot("A", `atur-orang-${suffix}.png`);
    await closeDialog("A");

    await openTab("A", "Permintaan bergabung");
    await pa.getByText("Tidak ada permintaan yang menunggu.").waitFor({ timeout: 10000 });
    await shot("A", `permintaan-kosong-${suffix}.png`);

    await setTheme("B", mode);
    await openOrg("B");
    await pg("B").getByRole("heading", { name: "Anggota organisasi" }).waitFor({ timeout: 10000 });
    await sleep(800);
    await shot("B", `anggota-b-${suffix}.png`);
  }
  check("Screenshot terang dan gelap tersimpan", true, shots);
} catch (err) {
  const where = String(err?.stack ?? "").split("\n").find((l) => l.includes("org-e2e.mjs")) ?? "";
  check("Skrip berjalan tanpa error", false, `${String(err?.message ?? err).split("\n")[0]} ${where.trim()}`);
}

console.log(
  "\nDilewati: persetujuan Permintaan bergabung tidak diuji ujung ke ujung. Jaringan bergabung (agen lain) belum ada di branch ini dan tidak ada command untuk membuat permintaan; hanya keadaan kosong yang dicek.",
);

for (const id of Object.keys(running)) await stop(id);
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
